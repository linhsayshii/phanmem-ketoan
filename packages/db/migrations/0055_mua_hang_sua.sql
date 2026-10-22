-- Sửa mua hàng hóa sau rà soát: giá trị VND của dòng hàng theo sổ cái (stock_value) cho lớp giá và liên kết hóa đơn ngoại tệ; liên kết tới chứng từ nháp
-- được tính là đang tham chiếu; chặn mất liên kết khi ghi sổ; chặn bỏ ghi sổ MH/TLM đã được tính giá vốn. Thân hàm lấy từ 0054.
ALTER TABLE voucher_item_line ADD COLUMN stock_value numeric(20,0); -- số VND cơ sở của dòng hàng sau chia chênh làm tròn (khớp dòng sổ cái); rỗng thì dùng thành tiền trừ chiết khấu

-- Lớp điều chỉnh (kind 'adjustment', số lượng 0) của hóa đơn mua / giảm giá hàng mua gắn vào phát sinh nhập của phiếu nhập; mang voucher_id của chứng từ đã ghi giá trị vào sổ cái (GV không ghi lại).
-- Gọi đầu fn_stock_moves_create. Chứng từ đảo của MH, TLM: triệt tiêu lớp của chứng từ gốc bằng lớp ngược dấu mang voucher_id của chứng từ đảo.
-- Dòng đang được chứng từ khác ghi sổ tham chiếu (link_line_id) thì không đảo được.
CREATE OR REPLACE FUNCTION fn_stock_adjust_links(p_voucher uuid) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v voucher; l record; r record; v_orig text; v_diff numeric; v_ref text;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  IF v.reversal_of_id IS NOT NULL THEN
    SELECT voucher_type INTO v_orig FROM voucher WHERE id = v.reversal_of_id;
    SELECT coalesce(bv.voucher_no, bv.voucher_type) INTO v_ref FROM voucher_item_line a JOIN voucher_item_line b ON b.tenant_id = a.tenant_id AND b.link_line_id = a.id
      JOIN voucher bv ON bv.id = b.voucher_id WHERE a.voucher_id = v.reversal_of_id AND bv.state IN ('draft', 'posted') AND bv.id <> p_voucher LIMIT 1;
    IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'LINE_REFERENCED: chứng từ đã được chứng từ % tham chiếu, hãy đảo chứng từ đó trước', v_ref USING ERRCODE = 'P0001'; END IF;
    IF v_orig IN ('MH', 'TLM') THEN
      FOR r IN SELECT c.move_id, c.item_id, c.warehouse_id, c.lot_no, sum(c.value) AS net, min(c.posting_date) AS d FROM stock_cost_layer c
               WHERE c.tenant_id = v.tenant_id AND c.kind = 'adjustment' AND c.voucher_id = v.reversal_of_id GROUP BY c.move_id, c.item_id, c.warehouse_id, c.lot_no HAVING sum(c.value) <> 0 LOOP
        INSERT INTO stock_cost_layer(tenant_id, move_id, item_id, warehouse_id, lot_no, kind, posting_date, qty, unit_cost, value, remaining_qty, remaining_value, voucher_id)
        VALUES (v.tenant_id, r.move_id, r.item_id, r.warehouse_id, r.lot_no, 'adjustment', r.d, 0, 0, -r.net, 0, 0, p_voucher);
        PERFORM fn_stock_mark_stale_at(r.item_id, r.warehouse_id, r.d);
      END LOOP;
    END IF;
    RETURN;
  END IF;
  IF v.voucher_type = 'PNK' AND EXISTS (SELECT 1 FROM voucher_item_line il JOIN voucher_item_line ml ON ml.tenant_id = il.tenant_id AND ml.id = il.link_line_id JOIN voucher mv ON mv.id = ml.voucher_id
       WHERE il.voucher_id = p_voucher AND mv.state <> 'posted') THEN
    RAISE EXCEPTION 'INVOICE_NOT_POSTED: hóa đơn mua của phiếu nhập chưa ghi sổ' USING ERRCODE = 'P0001'; END IF;
  -- liên kết không được mất: dòng hàng MH hàng về trước phải gắn dòng phiếu nhập; dòng PNK Có 151 phải gắn dòng hóa đơn mua
  IF v.voucher_type = 'MH' AND v.receipt_state = 'goods_first' AND EXISTS (SELECT 1 FROM voucher_item_line il JOIN item i ON i.tenant_id = il.tenant_id AND i.id = il.item_id AND i.kind <> 'service'
       WHERE il.voucher_id = p_voucher AND il.link_line_id IS NULL) THEN
    RAISE EXCEPTION 'RECEIPT_LINK_LOST: hóa đơn hàng về trước mất liên kết với phiếu nhập kho (phiếu nhập đã bị đảo hoặc xóa), hãy lập lại hóa đơn' USING ERRCODE = 'P0001'; END IF;
  IF v.voucher_type = 'PNK' AND EXISTS (SELECT 1 FROM voucher_item_line il JOIN account ca ON ca.id = il.credit_account_id WHERE il.voucher_id = p_voucher AND ca.code = '151' AND il.link_line_id IS NULL) THEN
    RAISE EXCEPTION 'INVOICE_LINK_LOST: phiếu nhập có Có 151 phải gắn với dòng hóa đơn mua hàng hóa về trước (hóa đơn đã bị đảo hoặc xóa), hãy lập lại phiếu' USING ERRCODE = 'P0001'; END IF;
  IF v.voucher_type NOT IN ('MH', 'TLM') THEN RETURN; END IF;
  -- MH hàng về trước: chênh giữa giá hóa đơn và giá tạm tính của phiếu nhập (giá trị lớp nhập). TLM không trả hàng: giảm giá vốn bằng tiền hàng trên giảm giá.
  FOR l IN SELECT il.*, CASE WHEN v.voucher_type = 'TLM' THEN -coalesce(il.stock_value, round(il.amount - coalesce(il.discount_amount, 0))) ELSE coalesce(il.stock_value, round(il.amount - coalesce(il.discount_amount, 0))) END AS gross
           FROM voucher_item_line il WHERE il.voucher_id = p_voucher AND il.warehouse_id IS NULL AND il.link_line_id IS NOT NULL AND il.item_id IS NOT NULL
             AND (v.voucher_type = 'TLM' OR v.receipt_state = 'goods_first') ORDER BY il.line_no LOOP
    SELECT m.id AS id, m.item_id, m.warehouse_id, m.lot_no, m.posting_date, mv.state AS state, (SELECT coalesce(sum(c.value), 0) FROM stock_cost_layer c WHERE c.tenant_id = m.tenant_id AND c.move_id = m.id AND c.kind = 'receipt') AS received
      INTO r FROM stock_move m JOIN voucher mv ON mv.id = m.voucher_id
      WHERE m.tenant_id = v.tenant_id AND m.item_line_id = l.link_line_id AND m.direction = 'in' AND m.reversal_of IS NULL AND m.transfer_id IS NULL;
    IF NOT FOUND OR r.state <> 'posted' THEN RAISE EXCEPTION 'RECEIPT_NOT_POSTED: dòng % tham chiếu phiếu nhập chưa ghi sổ', l.line_no USING ERRCODE = 'P0001'; END IF;
    v_diff := CASE WHEN v.voucher_type = 'TLM' THEN l.gross ELSE l.gross - r.received END;
    IF v_diff = 0 THEN CONTINUE; END IF;
    INSERT INTO stock_cost_layer(tenant_id, move_id, item_id, warehouse_id, lot_no, kind, posting_date, qty, unit_cost, value, remaining_qty, remaining_value, voucher_id)
    VALUES (v.tenant_id, r.id, r.item_id, r.warehouse_id, r.lot_no, 'adjustment', r.posting_date, 0, 0, v_diff, 0, 0, p_voucher);
    PERFORM fn_stock_mark_stale_at(r.item_id, r.warehouse_id, r.posting_date);
  END LOOP;
END $$;

-- Bỏ ghi sổ MH, TLM: lớp điều chỉnh của chứng từ được triệt tiêu bằng lớp ngược dấu cùng voucher_id (không xóa lớp). Chứng từ có dòng đang được chứng từ khác đã ghi sổ tham chiếu thì không bỏ ghi sổ được.
CREATE OR REPLACE FUNCTION fn_stock_adjust_unlink(p_voucher uuid) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE r record; v_ref text; v_type text;
BEGIN
  SELECT voucher_type INTO v_type FROM voucher WHERE id = p_voucher;
  SELECT coalesce(bv.voucher_no, bv.voucher_type) INTO v_ref FROM voucher_item_line a JOIN voucher_item_line b ON b.tenant_id = a.tenant_id AND b.link_line_id = a.id
    JOIN voucher bv ON bv.id = b.voucher_id WHERE a.voucher_id = p_voucher AND bv.state IN ('draft', 'posted') AND bv.id <> p_voucher LIMIT 1;
  IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'LINE_REFERENCED: chứng từ đã được chứng từ % tham chiếu, hãy bỏ ghi sổ chứng từ đó trước', v_ref USING ERRCODE = 'P0001'; END IF;
  IF v_type NOT IN ('MH', 'TLM') THEN RETURN; END IF;
  FOR r IN SELECT c.tenant_id, c.move_id, c.item_id, c.warehouse_id, c.lot_no, sum(c.value) AS net, min(c.posting_date) AS d FROM stock_cost_layer c
           WHERE c.tenant_id = app_tenant() AND c.kind = 'adjustment' AND c.voucher_id = p_voucher GROUP BY c.tenant_id, c.move_id, c.item_id, c.warehouse_id, c.lot_no HAVING sum(c.value) <> 0 LOOP
    -- đã có lần tính giá vốn hoàn tất bao phủ ngày nhập: giá vốn đã dùng lớp điều chỉnh này, phải đảo chứng từ thay vì bỏ ghi sổ
    IF EXISTS (SELECT 1 FROM costing_run cr WHERE cr.tenant_id = r.tenant_id AND cr.status = 'done' AND cr.period_to >= r.d
        AND ((cr.summary -> 'pairs') ? (r.item_id || ':' || r.warehouse_id) OR ((cr.warehouse_id IS NULL OR cr.warehouse_id = r.warehouse_id) AND (cr.item_id IS NULL OR cr.item_id = r.item_id)))) THEN
      RAISE EXCEPTION 'STOCK_COST_ADJUSTED: chứng từ đã điều chỉnh giá nhập đã tính giá vốn, hãy đảo chứng từ thay vì bỏ ghi sổ' USING ERRCODE = 'P0001'; END IF;
    INSERT INTO stock_cost_layer(tenant_id, move_id, item_id, warehouse_id, lot_no, kind, posting_date, qty, unit_cost, value, remaining_qty, remaining_value, voucher_id)
    VALUES (r.tenant_id, r.move_id, r.item_id, r.warehouse_id, r.lot_no, 'adjustment', r.d, 0, 0, -r.net, 0, 0, p_voucher);
    PERFORM fn_stock_mark_stale_at(r.item_id, r.warehouse_id, r.d);
  END LOOP;
END $$;

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
      IF l.source_line_id IS NOT NULL THEN
        SELECT id INTO v_rev FROM stock_move WHERE tenant_id = v.tenant_id AND item_line_id = l.source_line_id AND warehouse_id = m.wh AND direction <> m.dir ORDER BY id LIMIT 1;
      END IF;
      INSERT INTO stock_move(tenant_id, voucher_id, item_line_id, item_id, warehouse_id, posting_date, direction, quantity, lot_no, expiry_date, transfer_id, reversal_of)
      VALUES (v.tenant_id, p_voucher, l.id, l.item_id, m.wh, v.posting_date, m.dir, v_q, l.lot_no, l.expiry_date, v_xfer, v_rev) RETURNING id INTO v_mv;
      IF m.dir = 'in' THEN -- giá nhập: tiền dòng; chuyển kho đến lấy giá tạm tính của kho đi (giá gán thay sau khi chạy giá vốn)
        IF v_xfer IS NOT NULL THEN v_val := round(v_q * v_est);
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
