-- GĐ4 Task 15: sáu quy tắc soát lỗi tài sản và khế ước vay (quy tắc tài sản không cờ; hai quy tắc khế ước vay in dư nợ gốc nên cần view_payable như các API khế ước).
-- Định nghĩa lại seed_data_check_rules từ thân hiện hành (qua 0064–0067): chèn các dòng mới trước ON CONFLICT như 0064.
DO $mig$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('seed_data_check_rules(uuid)'::regprocedure);
  IF position($r$ON CONFLICT DO NOTHING$r$ IN d) = 0 THEN RAISE EXCEPTION 'seed_data_check_rules không có ON CONFLICT DO NOTHING'; END IF;
  n := $new$,
  -- Tài sản: dòng TK theo dõi theo tài sản (subledger fixed_asset) của chứng từ còn hiệu lực mà không có tài sản (dữ liệu trước 0069; từ nay trigger chặn).
  (p_tenant, 'TS_THIEU_TAI_SAN', 'Dòng tài khoản tài sản thiếu tài sản', 'error',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'TK ' || a.code || ' dòng ' || l.line_no
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
      WHERE v.state IN ('posted','reversed') AND a.subledger_kind = 'fixed_asset' AND l.asset_id IS NULL AND l.posting_date BETWEEN $1 AND $2
      ORDER BY l.posting_date, v.voucher_no, l.line_no$q$,
   'Dòng định khoản trên tài khoản nguyên giá hoặc hao mòn không gắn tài sản nên thẻ tài sản và sổ tài sản không thấy', 'Gắn tài sản vào dòng (bỏ ghi sổ nếu kỳ còn mở, hoặc lập chứng từ điều chỉnh)', true, '{}'),
  -- Tài sản: hao mòn vượt nguyên giá (nguyên giá − hao mòn < 0; CCDC/CPTT: giá trị còn trên 242 âm) tại $2.
  (p_tenant, 'TS_HAO_MON_VUOT', 'Hao mòn vượt nguyên giá', 'error',
   $q$SELECT NULL::uuid, a.code, 'Nguyên giá ' || f.cost || ', hao mòn ' || f.accumulated
      FROM fn_asset_values_at(app_tenant(), $2) f JOIN asset a ON a.id = f.asset_id WHERE f.cost - f.accumulated < 0 ORDER BY a.code$q$,
   'Giá trị còn lại của tài sản âm: hao mòn lớn hơn nguyên giá', 'Xem thẻ tài sản: chạy lại khấu hao hoặc sửa nguyên giá', true, '{}'),
  -- Tài sản: đã ghi giảm (decreased, ngày giảm ≤ $2) mà sổ cái vẫn còn nguyên giá hoặc hao mòn.
  (p_tenant, 'TS_DA_GIAM_CON_GIA_TRI', 'Tài sản đã ghi giảm còn giá trị trên sổ', 'error',
   $q$SELECT NULL::uuid, a.code, 'Ghi giảm ' || to_char(a.decrease_date, 'DD/MM/YYYY') || ', còn nguyên giá ' || f.cost || ', hao mòn ' || f.accumulated
      FROM asset a JOIN fn_asset_values_at(app_tenant(), $2) f ON f.asset_id = a.id
      WHERE a.status = 'decreased' AND a.decrease_date <= $2 AND (f.cost <> 0 OR f.accumulated <> 0) ORDER BY a.code$q$,
   'Tài sản đã ghi giảm nhưng nguyên giá hoặc hao mòn trên sổ cái khác 0', 'Kiểm tra bút toán ghi giảm, thanh lý của tài sản', true, '{}'),
  -- Tài sản: lần chạy hiệu lực của kỳ có dấu vân tay sổ cái khác hiện tại hoặc kỳ trước được chạy lại sau nó (SQL tương đương assetRunStale, periodRun.ts).
  (p_tenant, 'TS_KHAU_HAO_CAN_CHAY_LAI', 'Khấu hao hoặc phân bổ cần chạy lại', 'warning',
   $q$WITH r AS (
        SELECT r.*, fp.date_to FROM period_run r JOIN fiscal_period fp ON fp.tenant_id = r.tenant_id AND fp.fiscal_year = r.fiscal_year AND fp.period_no = r.period_no
        WHERE r.status = 'active' AND r.kind IN ('depreciation','tool','prepaid') AND r.period_no BETWEEN 1 AND 12 AND fp.date_from <= $2 AND fp.date_to >= $1),
      cur AS (
        SELECT r.id AS run_id, f.asset_id || ':' || round(f.cost) || ':' || round(f.accumulated) AS fp
        FROM r CROSS JOIN LATERAL fn_asset_values_at(app_tenant(), r.date_to, ARRAY(SELECT q.id FROM period_run q WHERE q.kind = r.kind AND q.fiscal_year = r.fiscal_year AND q.period_no = r.period_no)) f
        JOIN asset a ON a.id = f.asset_id
        WHERE a.kind = CASE r.kind WHEN 'depreciation' THEN 'fixed' ELSE r.kind END AND a.is_depreciable AND a.depreciation_start_date <= r.date_to AND coalesce(a.decrease_date > r.date_to, a.status = 'active')),
      sto AS (
        SELECT r.id AS run_id, (b->>'assetId') || ':' || round((b->>'cost')::numeric) || ':' || round((b->>'accumulated')::numeric) AS fp
        FROM r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.result->'basis', '[]'::jsonb)) b)
      SELECT r.voucher_id, CASE r.kind WHEN 'depreciation' THEN 'Khấu hao' WHEN 'tool' THEN 'Phân bổ CCDC' ELSE 'Phân bổ chi phí trả trước' END || ' kỳ ' || r.period_no || '/' || r.fiscal_year,
        CASE WHEN coalesce((SELECT string_agg(c.fp, ';' ORDER BY c.fp) FROM cur c WHERE c.run_id = r.id), '') <> coalesce((SELECT string_agg(s.fp, ';' ORDER BY s.fp) FROM sto s WHERE s.run_id = r.id), '')
          THEN 'Số liệu tài sản đến cuối kỳ đã thay đổi sau lần chạy' ELSE 'Kỳ trước được chạy lại sau lần chạy kỳ này' END
      FROM r
      WHERE coalesce((SELECT string_agg(c.fp, ';' ORDER BY c.fp) FROM cur c WHERE c.run_id = r.id), '') <> coalesce((SELECT string_agg(s.fp, ';' ORDER BY s.fp) FROM sto s WHERE s.run_id = r.id), '')
        OR EXISTS (SELECT 1 FROM period_run q WHERE q.kind = r.kind AND q.status = 'active' AND (q.fiscal_year, q.period_no) < (r.fiscal_year, r.period_no) AND q.created_at > coalesce(r.checked_at, r.created_at))
      ORDER BY r.fiscal_year, r.period_no, r.kind$q$,
   'Số liệu sổ cái của tài sản đã đổi sau lần chạy, số trên chứng từ khấu hao hoặc phân bổ có thể không còn đúng', 'Chạy lại khấu hao hoặc phân bổ của kỳ (Chạy khấu hao, Phân bổ CCDC, Phân bổ chi phí trả trước)', true, '{}'),
  -- Khế ước vay: kỳ đã kết chuyển (nhật ký bước closing gần nhất ok, hoặc có chứng từ KC đã ghi sổ) còn khế ước có dư nợ gốc cuối kỳ mà kỳ chưa có lần chạy tính lãi hiệu lực.
  (p_tenant, 'KU_CHUA_TINH_LAI', 'Khế ước vay chưa tính lãi kỳ đã kết chuyển', 'warning',
   $q$SELECT NULL::uuid, c.code, 'Kỳ ' || p.period_no || '/' || p.fiscal_year || ', dư nợ gốc ' || o.bal
      FROM fiscal_period p
      JOIN contract c ON c.kind = 'loan' JOIN loan_term lt ON lt.tenant_id = c.tenant_id AND lt.contract_id = c.id
      CROSS JOIN LATERAL (SELECT coalesce(sum(l.credit - l.debit), 0) AS bal FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.state IN ('posted','reversed') JOIN account a ON a.id = l.account_id
        WHERE l.contract_id = c.id AND a.code = lt.principal_account_code AND l.posting_date <= p.date_to) o
      WHERE p.period_no BETWEEN 1 AND 12 AND p.date_from <= $2 AND p.date_to >= $1 AND o.bal > 0
        AND (coalesce((SELECT g.ok FROM period_close_log g WHERE g.fiscal_year = p.fiscal_year AND g.period_no = p.period_no AND g.step = 'closing' ORDER BY g.ran_at DESC, g.id DESC LIMIT 1), false)
          OR EXISTS (SELECT 1 FROM voucher k WHERE k.is_closing AND k.state = 'posted' AND k.reversal_of_id IS NULL AND k.fiscal_year = p.fiscal_year AND k.period_no = p.period_no))
        AND NOT EXISTS (SELECT 1 FROM period_run r WHERE r.kind = 'loan_interest' AND r.status = 'active' AND r.fiscal_year = p.fiscal_year AND r.period_no = p.period_no)
      ORDER BY p.fiscal_year, p.period_no, c.code$q$,
   'Kỳ đã kết chuyển nhưng khế ước còn dư nợ chưa được tính lãi vay', 'Chạy tính lãi vay của kỳ (cần mở lại kỳ hoặc ghi lùi), rồi kết chuyển lại', true, '{view_payable}'),
  -- Khế ước vay: kỳ trả gốc đến hạn trước $2 còn phần chưa trả. Số đã trả phân bổ vào kỳ sớm nhất trước như loanLongTermPart; số đã trả = Nợ nguyên tệ trên TK gốc của chứng từ còn hiệu lực,
  -- cộng phần lịch đã trả trước ngày bắt đầu dùng phần mềm nếu dư đầu kỳ (quyết định 446, loans/stats.ts).
  (p_tenant, 'KU_QUA_HAN', 'Khế ước vay quá hạn trả gốc', 'warning',
   $q$WITH s AS (
        SELECT c.id, c.code, coalesce(sum(l.amount_currency) FILTER (WHERE l.amount_currency > 0 AND v.state = 'posted' AND v.reversal_of_id IS NULL), 0) AS repaid,
          coalesce(-sum(l.amount_currency) FILTER (WHERE l.amount_currency < 0 AND v.state = 'posted' AND v.reversal_of_id IS NULL), 0) AS drawn,
          coalesce(bool_or(v.source_doc_type = 'opening_balance'), false) AS has_opening, coalesce(sum(l.credit - l.debit), 0) AS out_vnd
        FROM contract c JOIN loan_term lt ON lt.tenant_id = c.tenant_id AND lt.contract_id = c.id
        LEFT JOIN (voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.state IN ('posted','reversed') JOIN account a ON a.id = l.account_id)
          ON l.contract_id = c.id AND l.posting_date <= $2 AND a.code = lt.principal_account_code
        WHERE c.kind = 'loan' GROUP BY c.id, c.code),
      d AS (SELECT i.contract_id, i.due_date, sum(i.principal) AS p, sum(sum(i.principal)) OVER (PARTITION BY i.contract_id ORDER BY i.due_date) AS cum FROM loan_installment i GROUP BY i.contract_id, i.due_date),
      t AS (SELECT contract_id, sum(p) AS total FROM d GROUP BY contract_id)
      SELECT NULL::uuid, s.code, 'Kỳ trả ' || to_char(d.due_date, 'DD/MM/YYYY') || ' còn ' || trim_scale(least(d.p, greatest(0, d.cum - (s.repaid + CASE WHEN s.has_opening AND t.total - s.drawn > 0 THEN t.total - s.drawn ELSE 0 END))))
      FROM s JOIN d ON d.contract_id = s.id JOIN t ON t.contract_id = s.id
      WHERE s.out_vnd > 0 AND d.due_date < $2 AND least(d.p, greatest(0, d.cum - (s.repaid + CASE WHEN s.has_opening AND t.total - s.drawn > 0 THEN t.total - s.drawn ELSE 0 END))) > 0
      ORDER BY s.code, d.due_date$q$,
   'Kỳ trả gốc đã đến hạn mà chưa trả đủ theo lịch', 'Kiểm tra lịch trả gốc của khế ước; lập chứng từ trả nợ vay hoặc điều chỉnh lịch', true, '{view_payable}')
  $new$;
  d := replace(d, E'\n  ON CONFLICT DO NOTHING', n || E'\n  ON CONFLICT DO NOTHING');
  IF position('KU_QUA_HAN' IN d) = 0 THEN RAISE EXCEPTION 'không chèn được quy tắc GĐ4 (khuôn ON CONFLICT khác dự kiến)'; END IF;
  EXECUTE d;
END $mig$;

-- Công ty đã có: bổ sung quy tắc mới (tắt nhật ký kiểm toán như 0038: migration không có người dùng).
ALTER TABLE data_check_rule DISABLE TRIGGER trg_audit;
SELECT seed_data_check_rules(id) FROM tenant;
ALTER TABLE data_check_rule ENABLE TRIGGER trg_audit;
