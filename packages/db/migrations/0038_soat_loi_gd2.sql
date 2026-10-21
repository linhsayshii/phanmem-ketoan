-- GĐ2 Task 27: tám quy tắc soát lỗi mới (công nợ lệch sổ cái, hóa đơn thiếu MST/trùng, thuế lệch, thiếu tài khoản ngân hàng, thuế 8% ngoài hiệu lực, tiền mặt vượt ngưỡng, công nợ quá hạn)
-- và cột flags: cờ nhạy cảm người chạy phải có đủ thì quy tắc mới được chạy (API bỏ qua và báo `skipped`). Cột flags chỉ do hệ thống đặt (app_user không có quyền UPDATE cột này).
ALTER TABLE data_check_rule ADD COLUMN flags text[] NOT NULL DEFAULT '{}';

-- Định nghĩa lại seed_data_check_rules từ thân hiện hành (0014): sáu quy tắc cũ giữ nguyên, thêm cột flags và tám quy tắc mới. ON CONFLICT DO NOTHING giữ quy tắc đã có (kể cả đã sửa thông điệp).
CREATE OR REPLACE FUNCTION seed_data_check_rules(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO data_check_rule(tenant_id, code, name, severity, sql, message, fix_hint, is_system, flags) VALUES
  (p_tenant, 'CT_KHONG_CAN', 'Chứng từ không cân', 'error',
   $q$SELECT v.id AS voucher_id, v.voucher_no AS ref, 'Nợ ' || sum(l.debit) || ' / Có ' || sum(l.credit) AS detail FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id WHERE v.state <> 'cancelled' AND v.posting_date BETWEEN $1 AND $2 GROUP BY v.id HAVING sum(l.debit) <> sum(l.credit)$q$,
   'Tổng Nợ khác tổng Có', 'Mở chứng từ và cân lại các dòng', true, '{}'),
  (p_tenant, 'CT_KHONG_CO_DONG', 'Chứng từ không có dòng định khoản', 'warning',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'Ngày ' || to_char(v.posting_date, 'DD/MM/YYYY') FROM voucher v WHERE v.state = 'draft' AND v.posting_date BETWEEN $1 AND $2 AND NOT EXISTS (SELECT 1 FROM voucher_line l WHERE l.voucher_id = v.id)$q$,
   'Chứng từ nháp rỗng', 'Xóa chứng từ hoặc nhập dòng', true, '{}'),
  -- Chứng từ đã hủy (cancelled) vẫn giữ dòng nhưng không còn sửa được: không báo lỗi trên đó.
  (p_tenant, 'CN_THIEU_DOI_TUONG', 'Dòng công nợ thiếu đối tượng', 'error',
   $q$SELECT v.id, v.voucher_no, 'TK ' || a.code || ' dòng ' || l.line_no FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id WHERE v.state <> 'cancelled' AND a.subledger_kind IN ('receivable','payable') AND l.party_id IS NULL AND l.posting_date BETWEEN $1 AND $2$q$,
   'Tài khoản công nợ phải có đối tượng', 'Bỏ ghi sổ và bổ sung đối tượng', true, '{}'),
  (p_tenant, 'TK_TONG_HOP_TREN_DONG', 'Tài khoản tổng hợp trên dòng định khoản', 'error',
   $q$SELECT v.id, v.voucher_no, 'TK ' || a.code FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id WHERE v.state <> 'cancelled' AND a.is_group AND l.posting_date BETWEEN $1 AND $2$q$,
   'Chỉ định khoản vào tài khoản chi tiết', 'Chuyển sang tiểu khoản', true, '{}'),
  -- Gộp theo a.id (không theo mã): một công ty có thể giữ nhiều hệ thống tài khoản cùng mã, hai tài khoản khác nhau không được bù trừ cho nhau. Số tiền báo là số dư ròng.
  (p_tenant, 'SO_DU_SAI_LOAI', 'Số dư trái loại dư của tài khoản', 'warning',
   $q$SELECT NULL::uuid, a.code || CASE WHEN p.code IS NOT NULL THEN ' / ' || p.code ELSE '' END, CASE WHEN a.normal_balance = 'debit' THEN 'Dư Có ' || -sum(b.debit - b.credit) ELSE 'Dư Nợ ' || sum(b.debit - b.credit) END FROM fn_balances_at(app_tenant(), $2) b JOIN account a ON a.id = b.account_id LEFT JOIN party p ON p.id = b.party_id WHERE a.normal_balance IN ('debit','credit') GROUP BY a.id, a.code, a.normal_balance, p.code HAVING (a.normal_balance = 'debit' AND sum(b.debit - b.credit) < 0) OR (a.normal_balance = 'credit' AND sum(b.debit - b.credit) > 0)$q$,
   'Số dư cuối kỳ trái với loại dư', 'Kiểm tra định khoản hoặc đổi loại dư tài khoản (lưỡng tính)', true, '{}'),
  (p_tenant, 'CHUA_GHI_SO_TRONG_KY_KHOA', 'Chứng từ chưa ghi sổ trong kỳ đã khóa', 'error',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'Kỳ ' || v.period_no || '/' || v.fiscal_year FROM voucher v JOIN fiscal_period fp ON fp.tenant_id = v.tenant_id AND fp.fiscal_year = v.fiscal_year AND fp.period_no = v.period_no WHERE v.state = 'draft' AND fp.status <> 'open' AND v.posting_date BETWEEN $1 AND $2$q$,
   'Kỳ đã khóa nhưng còn chứng từ nháp', 'Ghi sổ (cần quyền ghi lùi) hoặc hủy chứng từ', true, '{}'),

  -- Công nợ: Σ dư các khoản (open_item trừ đối trừ) của từng (tài khoản công nợ, đối tượng) phải bằng số dư ròng sổ cái cùng ngày $2; đối tượng rỗng (số dư không có đối tượng) hiện là "(không đối tượng)".
  (p_tenant, 'CN_LECH_SO_CAI', 'Công nợ theo khoản lệch số dư sổ cái', 'error',
   $q$WITH b AS (SELECT x.account_id, x.party_id, sum(x.debit - x.credit) AS net FROM fn_balances_at(app_tenant(), $2) x JOIN account a ON a.id = x.account_id WHERE a.reconcile GROUP BY x.account_id, x.party_id),
      o AS (SELECT f.account_id, f.party_id, sum(f.residual) AS net FROM fn_open_items_at(app_tenant(), $2) f JOIN account a ON a.id = f.account_id WHERE a.reconcile GROUP BY f.account_id, f.party_id)
      SELECT NULL::uuid, a.code || ' / ' || coalesce(p.code, '(không đối tượng)'), 'Sổ cái ' || coalesce(b.net, 0) || ' / Σ dư các khoản ' || coalesce(o.net, 0)
      FROM b FULL JOIN o ON o.account_id = b.account_id AND o.party_id = b.party_id JOIN account a ON a.id = coalesce(b.account_id, o.account_id) LEFT JOIN party p ON p.id = coalesce(b.party_id, o.party_id)
      WHERE coalesce(b.net, 0) <> coalesce(o.net, 0) ORDER BY 2$q$,
   'Tổng dư các khoản công nợ khác số dư sổ cái của đối tượng', 'Mở Danh sách khoản công nợ của đối tượng; kiểm tra đối trừ và chứng từ đã ghi sổ hoặc đã đảo', true, '{view_receivable,view_payable}'),
  -- Bảng kê lưu bản chụp hiệu lực (kể cả chỉnh ở Task 22). Hóa đơn nhập khẩu không có MST người bán nên không báo.
  (p_tenant, 'HD_THIEU_MST', 'Hóa đơn thiếu mã số thuế đối tác', 'warning',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), CASE i.direction WHEN 'purchase' THEN 'Hóa đơn mua ' ELSE 'Hóa đơn bán ' END || concat_ws(' ', i.serial, i.invoice_no) || ' thiếu mã số thuế'
      FROM voucher_invoice i JOIN voucher v ON v.id = i.voucher_id LEFT JOIN party p ON p.id = i.party_id
      WHERE v.state IN ('draft','posted') AND v.posting_date BETWEEN $1 AND $2 AND btrim(coalesce(i.party_tax_code, '')) = ''
        AND ((i.direction = 'purchase' AND NOT i.is_import) OR (i.direction = 'sale' AND btrim(coalesce(p.tax_code, '')) <> ''))$q$,
   'Hóa đơn thiếu mã số thuế của người bán (mua vào) hoặc người mua (bán ra, đối tượng đã có MST)', 'Bổ sung mã số thuế trên hóa đơn (hoặc trên danh mục đối tượng rồi nhập lại hóa đơn)', true, '{}'),
  -- Cùng khóa với kiểm trùng lúc nhập (assertNotDuplicate, Task 18): fn_invoice_key của MST, ký hiệu, số; chứng từ nháp hoặc đã ghi sổ; không MST thì so cùng đối tượng.
  -- Mỗi cặp một dòng (báo ở chứng từ có id lớn hơn, hoặc chứng từ trong khoảng ngày nếu chứng từ kia nằm ngoài); hai dòng của cùng hóa đơn nhiều mã thuế trên một chứng từ không phải trùng.
  (p_tenant, 'HD_TRUNG', 'Hóa đơn mua nhập trùng', 'error',
   $q$SELECT DISTINCT ON (a.voucher_id, b.voucher_id) a.voucher_id, coalesce(av.voucher_no, '(nháp)'), 'Hóa đơn ' || concat_ws(' ', a.serial, a.invoice_no) || ' trùng với chứng từ ' || coalesce(bv.voucher_no, '(nháp)')
      FROM voucher_invoice a JOIN voucher av ON av.id = a.voucher_id
      JOIN voucher_invoice b ON b.tenant_id = a.tenant_id AND b.direction = 'purchase' AND b.voucher_id <> a.voucher_id
        AND fn_invoice_key(b.party_tax_code) = fn_invoice_key(a.party_tax_code) AND fn_invoice_key(b.serial) = fn_invoice_key(a.serial) AND fn_invoice_key(b.invoice_no) = fn_invoice_key(a.invoice_no)
        AND (fn_invoice_key(a.party_tax_code) <> '' OR b.party_id IS NOT DISTINCT FROM a.party_id)
      JOIN voucher bv ON bv.id = b.voucher_id AND bv.state IN ('draft','posted')
      WHERE a.direction = 'purchase' AND av.state IN ('draft','posted') AND av.posting_date BETWEEN $1 AND $2 AND (a.voucher_id > b.voucher_id OR bv.posting_date NOT BETWEEN $1 AND $2)
      ORDER BY a.voucher_id, b.voucher_id$q$,
   'Cùng mã số thuế, ký hiệu và số hóa đơn đã nhập ở chứng từ khác', 'Giữ một chứng từ: hủy chứng từ nháp hoặc đảo chứng từ đã ghi sổ trùng (màn hình Khử trùng chứng từ)', true, '{}'),
  -- Phản chiếu đối chiếu thuế /api/tax/reconcile (tax/register.ts: effectiveRows + ledgerTax) theo từng (chứng từ, chiều) cho chứng từ có ngày ghi sổ trong khoảng:
  -- hóa đơn hiệu lực = hóa đơn của chứng từ gốc (đổi dấu theo bậc đảo; GGB, GGM ghi âm; chỉ mã thuế GTGT) so với phát sinh các tài khoản thuế của tax_distribution (Nợ − Có thuế mua, Có − Nợ thuế bán);
  -- bỏ chứng từ DK, chứng từ khấu trừ thuế vat_offset, và phần thuế bán của chứng từ nộp thuế GTGT (không hóa đơn, có dòng tiền 111/112, Nợ ròng thuế bán ở chứng từ gốc).
  -- Khác đối chiếu ở một điểm: chọn chứng từ theo ngày ghi sổ chứ không theo kỳ kê khai đã lưu của hóa đơn.
  (p_tenant, 'THUE_LECH', 'Thuế GTGT trên hóa đơn lệch phát sinh sổ cái', 'error',
   $q$WITH RECURSIVE eff(voucher_id, src_id, depth) AS (
        SELECT v.id, v.id, 0 FROM voucher v WHERE v.state IN ('posted','reversed') AND EXISTS (SELECT 1 FROM voucher_invoice i WHERE i.voucher_id = v.id)
        UNION ALL
        SELECT r.id, e.src_id, e.depth + 1 FROM voucher r JOIN eff e ON r.reversal_of_id = e.voucher_id WHERE r.state IN ('posted','reversed')),
      acc AS (SELECT DISTINCT d.scope, d.account_code AS code FROM tax_distribution d JOIN tax_code c ON c.id = d.tax_code_id WHERE d.line_type = 'tax' AND c.kind = 'vat' AND d.account_code IS NOT NULL),
      inv AS (SELECT e.voucher_id, i.direction, sum(i.tax_amount * CASE WHEN e.depth % 2 = 0 THEN 1 ELSE -1 END * CASE WHEN sv.voucher_type IN ('GGB','GGM') THEN -1 ELSE 1 END) AS tax
        FROM eff e JOIN voucher sv ON sv.id = e.src_id JOIN voucher_invoice i ON i.voucher_id = e.src_id LEFT JOIN tax_code t ON t.id = i.tax_code_id
        WHERE t.kind IS NULL OR t.kind = 'vat' GROUP BY e.voucher_id, i.direction),
      cand AS (SELECT l.voucher_id FROM voucher_line l JOIN account a ON a.id = l.account_id WHERE l.posting_date BETWEEN $1 AND $2 AND a.code IN (SELECT code FROM acc)
        UNION SELECT e.voucher_id FROM eff e JOIN voucher ev ON ev.id = e.voucher_id WHERE ev.posting_date BETWEEN $1 AND $2),
      led AS (SELECT l.voucher_id,
          coalesce(sum(CASE WHEN a.code IN (SELECT code FROM acc WHERE scope = 'purchase') THEN l.debit - l.credit ELSE 0 END), 0) AS purchase,
          coalesce(sum(CASE WHEN a.code IN (SELECT code FROM acc WHERE scope = 'sale') AND NOT pay.is_payment THEN l.credit - l.debit ELSE 0 END), 0) AS sale
        FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
        CROSS JOIN LATERAL (SELECT NOT EXISTS (SELECT 1 FROM voucher_invoice i WHERE i.voucher_id IN (v.id, v.reversal_of_id))
            AND EXISTS (SELECT 1 FROM voucher_line cl JOIN account ca ON ca.id = cl.account_id WHERE cl.voucher_id = v.id AND (ca.code LIKE '111%' OR ca.code LIKE '112%'))
            AND (SELECT coalesce(sum(ol.debit - ol.credit), 0) FROM voucher_line ol JOIN account oa ON oa.id = ol.account_id
                 WHERE ol.voucher_id = coalesce(v.reversal_of_id, v.id) AND oa.code IN (SELECT code FROM acc WHERE scope = 'sale')) > 0 AS is_payment) pay
        WHERE v.state IN ('posted','reversed') AND v.source_doc_type IS DISTINCT FROM 'vat_offset' AND v.voucher_type <> 'DK' AND a.code IN (SELECT code FROM acc) AND l.voucher_id IN (SELECT voucher_id FROM cand)
        GROUP BY l.voucher_id)
      SELECT v.id, coalesce(v.voucher_no, '(nháp)'), CASE d.direction WHEN 'purchase' THEN 'Mua vào' ELSE 'Bán ra' END || ': thuế trên hóa đơn ' || coalesce(inv.tax, 0) || ' / sổ cái ' || CASE d.direction WHEN 'purchase' THEN coalesce(led.purchase, 0) ELSE coalesce(led.sale, 0) END
      FROM voucher v JOIN cand c ON c.voucher_id = v.id CROSS JOIN (VALUES ('purchase'), ('sale')) d(direction)
        LEFT JOIN inv ON inv.voucher_id = v.id AND inv.direction = d.direction LEFT JOIN led ON led.voucher_id = v.id
      WHERE coalesce(inv.tax, 0) <> CASE d.direction WHEN 'purchase' THEN coalesce(led.purchase, 0) ELSE coalesce(led.sale, 0) END
      ORDER BY v.posting_date, v.id, d.direction$q$,
   'Thuế GTGT trên bảng kê hóa đơn khác phát sinh tài khoản thuế trong sổ cái', 'Mở Đối chiếu thuế GTGT; sửa hóa đơn hoặc định khoản thuế của chứng từ', true, '{}'),
  -- Tài khoản ngân hàng (subledger_kind = bank) phải có tài khoản ngân hàng cụ thể trên dòng để lập sổ tiền gửi theo từng tài khoản.
  (p_tenant, 'TK_NH_THIEU', 'Dòng tiền gửi ngân hàng thiếu tài khoản ngân hàng', 'warning',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'TK ' || a.code || ' dòng ' || l.line_no
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
      WHERE v.state IN ('draft','posted') AND a.subledger_kind = 'bank' AND l.bank_account_id IS NULL AND l.posting_date BETWEEN $1 AND $2$q$,
   'Dòng tài khoản ngân hàng chưa chọn tài khoản ngân hàng', 'Chọn tài khoản ngân hàng trên dòng định khoản', true, '{}'),
  -- Ngày hóa đơn không có tham số vat_reduced_rate hiệu lực (cùng cách tra legalParam của tờ khai).
  (p_tenant, 'THUE_8_HET_HIEU_LUC', 'Hóa đơn thuế suất 8% ngoài thời gian giảm thuế', 'warning',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'Hóa đơn ' || concat_ws(' ', i.serial, i.invoice_no) || ' ngày ' || to_char(i.invoice_date, 'DD/MM/YYYY') || ' dùng thuế suất 8%'
      FROM voucher_invoice i JOIN voucher v ON v.id = i.voucher_id JOIN tax_code t ON t.id = i.tax_code_id
      WHERE v.state IN ('draft','posted') AND v.posting_date BETWEEN $1 AND $2 AND (t.code = 'V8' OR t.rate = 8)
        AND NOT EXISTS (SELECT 1 FROM legal_param lp WHERE lp.code = 'vat_reduced_rate' AND lp.valid_from <= i.invoice_date AND (lp.valid_to IS NULL OR lp.valid_to >= i.invoice_date))$q$,
   'Thuế suất 8% chỉ áp dụng trong thời gian giảm thuế GTGT theo nghị quyết', 'Đổi sang mã thuế đúng thuế suất của ngày hóa đơn', true, '{}'),
  -- Hóa đơn mua (cộng các dòng mã thuế của cùng ký hiệu, số trên một chứng từ) có tổng thanh toán ≥ vat_noncash_threshold tại ngày hóa đơn, có thuế khấu trừ (thuế > 0, nhóm khác 02 và 05)
  -- và khoản phải trả của chứng từ đó đã đối trừ với khoản của phiếu thu/phiếu chi (PT, PC) đã ghi sổ: thanh toán tiền mặt thì thuế không đủ điều kiện khấu trừ.
  (p_tenant, 'TIEN_MAT_VUOT_NGUONG', 'Hóa đơn mua từ ngưỡng thanh toán không dùng tiền mặt nhưng trả bằng tiền mặt', 'warning',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'Hóa đơn ' || concat_ws(' ', x.serial, x.invoice_no) || ': tổng thanh toán ' || x.total || ' ≥ ' || t.th
      FROM (SELECT i.voucher_id, i.serial, i.invoice_no, min(i.invoice_date) AS invoice_date, sum(i.base_amount + i.tax_amount) AS total, sum(i.tax_amount) FILTER (WHERE coalesce(g.code, '') NOT IN ('02','05')) AS ded
            FROM voucher_invoice i LEFT JOIN invoice_group g ON g.id = i.invoice_group_id WHERE i.direction = 'purchase' GROUP BY i.voucher_id, i.serial, i.invoice_no) x
      JOIN voucher v ON v.id = x.voucher_id AND v.state = 'posted' AND v.posting_date BETWEEN $1 AND $2
      CROSS JOIN LATERAL (SELECT (lp.value #>> '{}')::numeric AS th FROM legal_param lp WHERE lp.code = 'vat_noncash_threshold' AND lp.valid_from <= x.invoice_date AND (lp.valid_to IS NULL OR lp.valid_to >= x.invoice_date) ORDER BY lp.valid_from DESC LIMIT 1) t
      WHERE x.total >= t.th AND x.ded > 0
        AND EXISTS (SELECT 1 FROM open_item o JOIN settlement s ON o.id IN (s.debit_item_id, s.credit_item_id)
                    JOIN open_item o2 ON o2.id = CASE WHEN o.id = s.debit_item_id THEN s.credit_item_id ELSE s.debit_item_id END
                    JOIN voucher pv ON pv.id = o2.voucher_id AND pv.voucher_type IN ('PT','PC') AND pv.state = 'posted'
                    WHERE o.voucher_id = x.voucher_id)$q$,
   'Hóa đơn mua từ ngưỡng thanh toán không dùng tiền mặt nhưng được thanh toán bằng phiếu thu/phiếu chi tiền mặt', 'Thanh toán qua ngân hàng (Báo nợ) hoặc loại thuế GTGT của hóa đơn khỏi khấu trừ', true, '{}'),
  -- Khoản gốc (cộng các khoản con đánh giá lại) còn dư tại $2, quá hạn trên 90 ngày; phải thu: dư Nợ, phải trả: dư Có.
  (p_tenant, 'CN_QUA_HAN', 'Khoản công nợ quá hạn trên 90 ngày', 'warning',
   $q$SELECT r.voucher_id, p.code || ' / ' || coalesce(r.doc_no, '(không số)'), 'Quá hạn ' || ($2::date - r.due_date) || ' ngày (hạn ' || to_char(r.due_date, 'DD/MM/YYYY') || '), còn ' || abs(x.residual)
      FROM (SELECT coalesce(o.parent_id, o.id) AS root_id, sum(f.residual) AS residual FROM fn_open_items_at(app_tenant(), $2) f JOIN open_item o ON o.tenant_id = app_tenant() AND o.id = f.item_id GROUP BY 1) x
      JOIN open_item r ON r.tenant_id = app_tenant() AND r.id = x.root_id JOIN party p ON p.id = r.party_id JOIN account a ON a.id = r.account_id
      WHERE r.due_date IS NOT NULL AND $2::date - r.due_date > 90 AND ((a.subledger_kind = 'receivable' AND x.residual > 0) OR (a.subledger_kind = 'payable' AND x.residual < 0))
      ORDER BY 2$q$,
   'Khoản công nợ đã quá hạn thanh toán trên 90 ngày', 'Đối chiếu, nhắc nợ hoặc đối trừ khoản công nợ', true, '{view_receivable,view_payable}')
  ON CONFLICT DO NOTHING;
$$;

-- Công ty đã có: bổ sung quy tắc mới. Tắt nhật ký kiểm toán khi gieo bù vì migration không có người dùng (như 0014 chạy trước khi bật audit); trg_audit bật lại ngay sau.
ALTER TABLE data_check_rule DISABLE TRIGGER trg_audit;
SELECT seed_data_check_rules(id) FROM tenant;
ALTER TABLE data_check_rule ENABLE TRIGGER trg_audit;
