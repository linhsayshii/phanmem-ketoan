-- GĐ3 Task 13, vòng sửa 1: giá nhập lại của hàng bán bị trả lại bằng round(số lượng x giá vốn đơn vị) (khớp dòng sổ giá vốn và lần tính giá vốn),
-- thiếu dòng xuất gốc thì báo lỗi thay vì lấy doanh thu. Thân hàm lấy từ 0059 (thân hiện hành), chỉ đổi nhánh TLB.

CREATE OR REPLACE FUNCTION public.fn_stock_moves_create(p_voucher uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; l record; m record; k record; v_q numeric; v_xfer uuid; v_est numeric; v_val numeric; v_mv bigint; v_rev bigint;
        v_neg text; n int := 0; v_keys bigint[][];
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  PERFORM fn_stock_adjust_links(p_voucher); -- mua hàng: lớp điều chỉnh của hóa đơn/giảm giá gắn với phiếu nhập; đảo triệt tiêu lớp đó
  SELECT array_agg(ARRAY[x.item_id, x.wh] ORDER BY hashtextextended(v.tenant_id::text || ':' || x.item_id || ':' || x.wh, 0)) INTO v_keys FROM (
    SELECT DISTINCT il.item_id, w.wh FROM voucher_item_line il JOIN item i ON i.tenant_id = il.tenant_id AND i.id = il.item_id AND i.kind <> 'service'
      CROSS JOIN LATERAL (VALUES (il.warehouse_id), (il.dest_warehouse_id)) w(wh)
      WHERE il.voucher_id = p_voucher AND il.warehouse_id IS NOT NULL AND w.wh IS NOT NULL) x;
  IF v_keys IS NULL THEN RETURN 0; END IF;
  PERFORM fn_stock_lock_keys(v.tenant_id, v_keys);
  PERFORM set_config('app.stock_post', 'on', true); -- trigger chặn ghi stock_move ngoài đường ghi sổ
  FOR l IN SELECT il.* FROM voucher_item_line il JOIN item i ON i.tenant_id = il.tenant_id AND i.id = il.item_id AND i.kind <> 'service'
           WHERE il.voucher_id = p_voucher AND il.warehouse_id IS NOT NULL ORDER BY il.line_no LOOP
    IF l.dest_warehouse_id = l.warehouse_id THEN RAISE EXCEPTION 'STOCK_TRANSFER_SAME_WAREHOUSE: dòng % chuyển kho đến chính kho đi', l.line_no USING ERRCODE = 'P0001'; END IF;
    v_q := coalesce(l.base_quantity, l.quantity * l.uom_factor);
    IF v_q IS NULL OR v_q <= 0 THEN RAISE EXCEPTION 'STOCK_QUANTITY_INVALID: dòng % phải có số lượng lớn hơn 0', l.line_no USING ERRCODE = 'P0001'; END IF;
    IF l.dest_warehouse_id IS NULL AND l.direction IS NULL THEN RAISE EXCEPTION 'STOCK_DIRECTION_REQUIRED: dòng % chưa có chiều nhập/xuất', l.line_no USING ERRCODE = 'P0001'; END IF;
    v_xfer := CASE WHEN l.dest_warehouse_id IS NOT NULL THEN gen_random_uuid() END;
    v_est := CASE WHEN l.dest_warehouse_id IS NOT NULL THEN fn_stock_estimate_cost(l.item_id, l.warehouse_id, v.posting_date) END;
    FOR m IN SELECT * FROM (VALUES (l.warehouse_id, CASE WHEN l.dest_warehouse_id IS NOT NULL THEN 'out' ELSE l.direction END),
                                   (l.dest_warehouse_id, 'in')) t(wh, dir) WHERE wh IS NOT NULL LOOP
      v_rev := NULL;
      IF v.voucher_type = 'TLB' AND l.link_line_id IS NOT NULL THEN -- hàng bán bị trả lại: nhập đảo một phần chiều xuất của dòng bán
        SELECT id INTO v_rev FROM stock_move WHERE tenant_id = v.tenant_id AND item_line_id = l.link_line_id AND warehouse_id = m.wh AND direction = 'out' AND reversal_of IS NULL ORDER BY id LIMIT 1;
      ELSIF l.source_line_id IS NOT NULL THEN
        SELECT id INTO v_rev FROM stock_move WHERE tenant_id = v.tenant_id AND item_line_id = l.source_line_id AND warehouse_id = m.wh AND direction <> m.dir ORDER BY id LIMIT 1;
      END IF;
      INSERT INTO stock_move(tenant_id, voucher_id, item_line_id, item_id, warehouse_id, posting_date, direction, quantity, lot_no, expiry_date, transfer_id, reversal_of)
      VALUES (v.tenant_id, p_voucher, l.id, l.item_id, m.wh, v.posting_date, m.dir, v_q, l.lot_no, l.expiry_date, v_xfer, v_rev) RETURNING id INTO v_mv;
      IF m.dir = 'in' THEN -- giá nhập: tiền dòng; chuyển kho đến lấy giá tạm tính của kho đi (giá gán thay sau khi chạy giá vốn)
        IF v_xfer IS NOT NULL THEN v_val := round(v_q * v_est);
        ELSIF v.voucher_type = 'TLB' THEN -- trả lại hàng bán: số lượng trả nhân giá vốn đơn vị trên dòng (cùng công thức dòng sổ giá vốn), không thấy dòng xuất gốc thì không ghi sổ
          IF v_rev IS NULL OR l.unit_cost IS NULL THEN RAISE EXCEPTION 'SALE_RETURN_SOURCE_MISSING: hàng bán bị trả lại thiếu dòng xuất kho gốc hoặc giá vốn trên dòng' USING ERRCODE = 'P0001'; END IF;
          v_val := round(v_q * l.unit_cost);
        ELSIF l.source_line_id IS NOT NULL THEN -- đảo phiếu xuất: giá vốn đã gán, nếu không thì đơn giá trên dòng, nếu không thì giá tạm tính tại ngày gốc
          SELECT sum(a.amount) INTO v_val FROM stock_cost_assignment a JOIN stock_move sm ON sm.tenant_id = a.tenant_id AND sm.id = a.move_id
            WHERE a.tenant_id = v.tenant_id AND a.is_current AND sm.item_line_id = l.source_line_id AND sm.direction = 'out' AND sm.warehouse_id = m.wh;
          IF v_val IS NULL THEN
            v_val := CASE WHEN l.unit_cost IS NOT NULL THEN round(v_q * l.unit_cost)
              ELSE round(v_q * fn_stock_estimate_cost(l.item_id, m.wh, coalesce((SELECT posting_date FROM stock_move WHERE id = v_rev), v.posting_date))) END;
          END IF;
        ELSE v_val := coalesce(l.stock_value, round(l.amount - coalesce(l.discount_amount, 0))); END IF;
        INSERT INTO stock_cost_layer(tenant_id, move_id, item_id, warehouse_id, lot_no, kind, posting_date, qty, unit_cost, value, remaining_qty, remaining_value)
        VALUES (v.tenant_id, v_mv, l.item_id, m.wh, l.lot_no, 'receipt', v.posting_date, v_q, round(v_val / v_q, 4), v_val, v_q, v_val);
      END IF;
      n := n + 1;
    END LOOP;
  END LOOP;
  -- tồn âm: kiểm tồn cuối ngày từ ngày chứng từ trở đi (nhập trước xuất trong ngày nên số dư cuối ngày là thấp nhất)
  SELECT coalesce((SELECT value #>> '{}' FROM tenant_setting WHERE tenant_id = v.tenant_id AND key = 'stock_negative'), 'forbid') INTO v_neg;
  IF v_neg NOT IN ('forbid', 'warn', 'allow') THEN v_neg := 'forbid'; END IF;
  IF v_neg <> 'allow' THEN
    FOR k IN SELECT item_id, warehouse_id FROM stock_move WHERE voucher_id = p_voucher AND direction = 'out' GROUP BY item_id, warehouse_id LOOP
      SELECT d, bal INTO m FROM fn_stock_first_negative(k.item_id, k.warehouse_id, v.posting_date);
      IF m.d IS NOT NULL THEN
        IF v_neg = 'forbid' THEN
          RAISE EXCEPTION 'STOCK_NEGATIVE: hàng % kho % ngày % thiếu %', (SELECT code FROM item WHERE id = k.item_id), (SELECT code FROM warehouse WHERE id = k.warehouse_id),
            to_char(m.d, 'DD/MM/YYYY'), trim_scale(-m.bal) USING ERRCODE = 'P0001';
        END IF;
        RAISE WARNING 'STOCK_NEGATIVE: hàng % kho % ngày % thiếu %', (SELECT code FROM item WHERE id = k.item_id), (SELECT code FROM warehouse WHERE id = k.warehouse_id), to_char(m.d, 'DD/MM/YYYY'), trim_scale(-m.bal);
      END IF;
    END LOOP;
  END IF;
  PERFORM fn_stock_mark_stale(p_voucher);
  PERFORM set_config('app.stock_post', 'off', true);
  RETURN n;
END $function$
;
