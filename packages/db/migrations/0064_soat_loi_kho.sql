-- GĐ3 Task 20: sáu quy tắc soát lỗi kho. Cột flags đã có (0038).
-- Định nghĩa lại seed_data_check_rules từ thân hiện hành (đã qua 0054, 0059): chép nguyên thân bằng pg_get_functiondef rồi chèn các dòng quy tắc mới trước ON CONFLICT.
-- Giá trị lớp giá "tại ngày" dựng như mvCte của báo cáo kho (reports.ts): lớp nhận tính ở ngày phát sinh nhập, lớp điều chỉnh theo ngày ghi sổ chứng từ nguồn của lớp (hợp đồng lớp adjustment), xuất trừ giá gán hiện hành (chưa tính giá vốn thì chưa trừ).
-- Tồn tại cuối ngày: nhập trước xuất trong cùng ngày (như fn_stock_first_negative), nên chỉ tồn lũy kế cuối ngày âm mới bị báo.
DO $mig$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('seed_data_check_rules(uuid)'::regprocedure);
  IF position($r$ON CONFLICT DO NOTHING$r$ IN d) = 0 THEN RAISE EXCEPTION 'seed_data_check_rules không có ON CONFLICT DO NOTHING'; END IF;
  n := $new$,
  -- Kho: lần xuất trong khoảng của cặp hàng-kho có giá vốn chưa cập nhật (ghi lùi sau lần tính giá vốn).
  (p_tenant, 'KHO_XUAT_CHUA_GIA_VON', 'Phiếu xuất kho có giá vốn chưa cập nhật', 'warning',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'Hàng ' || i.code || ' kho ' || w.code || ': giá vốn chưa cập nhật từ ngày ' || to_char(st.stale_from, 'DD/MM/YYYY')
      FROM stock_move m JOIN voucher v ON v.id = m.voucher_id AND v.state = 'posted'
      JOIN stock_cost_state st ON st.tenant_id = m.tenant_id AND st.item_id = m.item_id AND st.warehouse_id = m.warehouse_id AND st.stale_from <= m.posting_date
      JOIN item i ON i.id = m.item_id JOIN warehouse w ON w.id = m.warehouse_id
      WHERE m.direction = 'out' AND m.posting_date BETWEEN $1 AND $2
      GROUP BY v.id, v.voucher_no, i.code, w.code, st.stale_from ORDER BY v.id, i.code$q$,
   'Giá vốn của lần xuất chưa được tính lại sau khi ghi sổ lùi', 'Chạy Tính giá vốn cho kỳ có phiếu xuất', true, '{view_cost}'),
  -- Kho: Σ giá trị lớp giá (nhập, điều chỉnh, trừ giá vốn xuất) theo (TK kho, kho) tại $2 so với số dư sổ cái; dòng sổ cái thiếu kho do KHO_HANG_THIEU_KHO báo.
  (p_tenant, 'KHO_LECH_SO_CAI', 'Giá trị lớp giá kho lệch số dư sổ cái', 'error',
   $q$WITH mv AS (
        SELECT m.item_id, m.warehouse_id, CASE WHEN m.direction = 'in' THEN coalesce((SELECT sum(c.value) FROM stock_cost_layer c WHERE c.tenant_id = m.tenant_id AND c.move_id = m.id AND c.kind = 'receipt'), 0)
                 ELSE -coalesce((SELECT a.amount FROM stock_cost_assignment a WHERE a.tenant_id = m.tenant_id AND a.move_id = m.id AND a.is_current), 0) END AS val
          FROM stock_move m WHERE m.posting_date <= $2
        UNION ALL
        SELECT m.item_id, m.warehouse_id, c.value FROM stock_cost_layer c JOIN stock_move m ON m.tenant_id = c.tenant_id AND m.id = c.move_id LEFT JOIN voucher av ON av.id = c.voucher_id
          WHERE c.kind = 'adjustment' AND coalesce(av.posting_date, m.posting_date) <= $2),
      lay AS (SELECT coalesce(w.inventory_account_id, i.inventory_account_id) AS account_id, mv.warehouse_id, sum(mv.val) AS val
          FROM mv JOIN item i ON i.id = mv.item_id JOIN warehouse w ON w.id = mv.warehouse_id GROUP BY 1, 2),
      kho AS (SELECT inventory_account_id AS id FROM warehouse WHERE inventory_account_id IS NOT NULL UNION SELECT inventory_account_id FROM item WHERE inventory_account_id IS NOT NULL),
      led AS (SELECT l.account_id, l.warehouse_id, sum(l.debit - l.credit) AS val FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
          WHERE v.state IN ('posted','reversed') AND l.posting_date <= $2 AND l.warehouse_id IS NOT NULL AND l.account_id IN (SELECT id FROM kho) GROUP BY 1, 2)
      SELECT NULL::uuid, a.code || ' / ' || w.code, 'Lớp giá ' || coalesce(lay.val, 0) || ' / sổ cái ' || coalesce(led.val, 0)
      FROM lay FULL JOIN led ON led.account_id = lay.account_id AND led.warehouse_id = lay.warehouse_id
      JOIN account a ON a.id = coalesce(lay.account_id, led.account_id) JOIN warehouse w ON w.id = coalesce(lay.warehouse_id, led.warehouse_id)
      WHERE coalesce(lay.val, 0) <> coalesce(led.val, 0) ORDER BY 2$q$,
   'Tổng giá trị lớp giá của kho khác số dư tài khoản kho trên sổ cái', 'Mở Đối chiếu kế toán - thủ kho; chạy Tính giá vốn, kiểm tra chứng từ kho đã đảo hoặc ghi lùi', true, '{view_cost}'),
  -- Kho: đơn vị tính không khai báo cho hàng (ngoài ĐVT cơ sở) hoặc số lượng cơ sở không bằng số lượng × hệ số.
  (p_tenant, 'KHO_SAI_DVT', 'Dòng hàng sai đơn vị tính hoặc quy đổi', 'error',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'Dòng ' || l.line_no || ' hàng ' || i.code || CASE WHEN bad_uom THEN ': ĐVT không thuộc hàng' ELSE ': số lượng cơ sở ' || l.base_quantity || ' khác ' || l.quantity || ' × ' || l.uom_factor END
      FROM voucher_item_line l JOIN voucher v ON v.id = l.voucher_id JOIN item i ON i.id = l.item_id
      CROSS JOIN LATERAL (SELECT l.uom_id IS NOT NULL AND l.uom_id <> i.base_uom_id AND NOT EXISTS (SELECT 1 FROM item_uom u WHERE u.tenant_id = l.tenant_id AND u.item_id = l.item_id AND u.uom_id = l.uom_id) AS bad_uom) b
      WHERE v.state IN ('draft','posted') AND v.posting_date BETWEEN $1 AND $2
        AND (bad_uom OR (l.base_quantity IS NOT NULL AND l.quantity IS NOT NULL AND l.base_quantity <> round(l.quantity * l.uom_factor, 4)))
      ORDER BY v.id, l.line_no$q$,
   'Đơn vị tính không thuộc hàng hoặc số lượng cơ sở khác số lượng nhân hệ số quy đổi', 'Mở chứng từ, chọn lại đơn vị tính (khai báo ở danh mục hàng) và số lượng', true, '{}'),
  -- Kho: tồn lũy kế cuối ngày âm (nhập trước xuất trong cùng ngày); mỗi cặp hàng-kho báo ngày âm đầu tiên trong khoảng, chứng từ là phiếu xuất đầu của ngày đó.
  (p_tenant, 'KHO_TON_AM', 'Tồn kho âm', 'warning',
   $q$SELECT DISTINCT ON (c.item_id, c.warehouse_id) (SELECT m.voucher_id FROM stock_move m WHERE m.tenant_id = c.tenant_id AND m.item_id = c.item_id AND m.warehouse_id = c.warehouse_id AND m.posting_date = c.posting_date AND m.direction = 'out' ORDER BY m.id LIMIT 1),
        i.code || ' / ' || w.code, 'Tồn ' || c.bal || ' tại cuối ngày ' || to_char(c.posting_date, 'DD/MM/YYYY')
      FROM (SELECT tenant_id, item_id, warehouse_id, posting_date, sum(sum(CASE direction WHEN 'in' THEN quantity ELSE -quantity END)) OVER (PARTITION BY item_id, warehouse_id ORDER BY posting_date) AS bal
              FROM stock_move WHERE posting_date <= $2 GROUP BY tenant_id, item_id, warehouse_id, posting_date) c
      JOIN item i ON i.id = c.item_id JOIN warehouse w ON w.id = c.warehouse_id
      WHERE c.bal < 0 AND c.posting_date >= $1 ORDER BY c.item_id, c.warehouse_id, c.posting_date$q$,
   'Tồn kho cuối ngày nhỏ hơn 0', 'Bổ sung phiếu nhập trước ngày xuất hoặc sửa số lượng phiếu xuất', true, '{}'),
  -- Kho: dòng sổ cái trên tài khoản kho mà không ghi kho thì Thẻ kho và đối chiếu không thấy dòng này.
  (p_tenant, 'KHO_HANG_THIEU_KHO', 'Dòng tài khoản kho thiếu kho', 'warning',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'TK ' || a.code || ' dòng ' || l.line_no
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
      WHERE v.state IN ('draft','posted') AND l.warehouse_id IS NULL AND l.posting_date BETWEEN $1 AND $2
        AND (a.id IN (SELECT inventory_account_id FROM warehouse WHERE inventory_account_id IS NOT NULL) OR a.id IN (SELECT inventory_account_id FROM item WHERE inventory_account_id IS NOT NULL))
      ORDER BY v.id, l.line_no$q$,
   'Dòng định khoản vào tài khoản kho chưa ghi kho', 'Mở chứng từ và chọn kho cho dòng', true, '{}'),
  -- Kho: tồn 0 mà còn giá trị tại $2; hợp lệ khi mọi lần xuất cố định giá hoặc theo lô, nên chỉ cảnh báo.
  (p_tenant, 'KHO_TON_0_CON_GIA_TRI', 'Tồn kho bằng 0 nhưng còn giá trị', 'warning',
   $q$WITH mv AS (
        SELECT m.item_id, m.warehouse_id, CASE WHEN m.direction = 'in' THEN m.quantity ELSE -m.quantity END AS qty,
               CASE WHEN m.direction = 'in' THEN coalesce((SELECT sum(c.value) FROM stock_cost_layer c WHERE c.tenant_id = m.tenant_id AND c.move_id = m.id AND c.kind = 'receipt'), 0)
                 ELSE -coalesce((SELECT a.amount FROM stock_cost_assignment a WHERE a.tenant_id = m.tenant_id AND a.move_id = m.id AND a.is_current), 0) END AS val
          FROM stock_move m WHERE m.posting_date <= $2
        UNION ALL
        SELECT m.item_id, m.warehouse_id, 0, c.value FROM stock_cost_layer c JOIN stock_move m ON m.tenant_id = c.tenant_id AND m.id = c.move_id LEFT JOIN voucher av ON av.id = c.voucher_id
          WHERE c.kind = 'adjustment' AND coalesce(av.posting_date, m.posting_date) <= $2)
      SELECT NULL::uuid, i.code || ' / ' || w.code, 'Tồn 0, giá trị còn ' || sum(mv.val)
      FROM mv JOIN item i ON i.id = mv.item_id JOIN warehouse w ON w.id = mv.warehouse_id
      GROUP BY i.code, w.code HAVING sum(mv.qty) = 0 AND sum(mv.val) <> 0 ORDER BY 2$q$,
   'Tồn kho bằng 0 nhưng giá trị còn lại khác 0 (thường do xuất cố định giá hoặc theo lô)', 'Xem Thẻ kho và giá vốn của hàng; xuất cố định giá để lại phần chênh trong tồn là bình thường', true, '{view_cost}')
  $new$;
  d := replace(d, E'\n  ON CONFLICT DO NOTHING', n || E'\n  ON CONFLICT DO NOTHING');
  IF position('KHO_TON_AM' IN d) = 0 THEN RAISE EXCEPTION 'không chèn được quy tắc kho (khuôn ON CONFLICT khác dự kiến)'; END IF;
  EXECUTE d;
END $mig$;

-- Công ty đã có: bổ sung quy tắc mới (tắt nhật ký kiểm toán như 0038: migration không có người dùng).
ALTER TABLE data_check_rule DISABLE TRIGGER trg_audit;
SELECT seed_data_check_rules(id) FROM tenant;
ALTER TABLE data_check_rule ENABLE TRIGGER trg_audit;
