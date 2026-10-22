-- GĐ3 Task 11: mua hàng hóa (MH) qua kho, hàng về trước hóa đơn, hóa đơn về trước hàng; trả lại, giảm giá hàng mua (TLM).
-- voucher.receipt_state: cách nhận hàng của hóa đơn MH. Dòng hàng: receipt_voucher_id (phiếu nhập liên kết), link_line_id (dòng liên kết:
-- MH hàng về trước → dòng phiếu nhập; phiếu nhập theo hóa đơn → dòng MH; TLM → dòng MH/phiếu nhập gốc). Thân hàm lấy bằng pg_get_functiondef trên DB đã migrate đến 0053.
ALTER TABLE voucher ADD COLUMN receipt_state text CHECK (receipt_state IN ('with_invoice', 'goods_first', 'invoice_first'));
ALTER TABLE voucher_item_line ADD COLUMN receipt_voucher_id uuid, ADD COLUMN link_line_id bigint,
  ADD FOREIGN KEY (tenant_id, receipt_voucher_id) REFERENCES voucher (tenant_id, id) ON DELETE SET NULL (receipt_voucher_id),
  ADD FOREIGN KEY (tenant_id, link_line_id) REFERENCES voucher_item_line (tenant_id, id) ON DELETE SET NULL (link_line_id);
CREATE INDEX voucher_item_line_link ON voucher_item_line (tenant_id, link_line_id) WHERE link_line_id IS NOT NULL;

CREATE OR REPLACE FUNCTION seed_voucher_types(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO voucher_type(tenant_id, code, name, module, prefix, is_system) VALUES
    (p_tenant, 'PKT', 'Phiếu kế toán', 'general', 'PKT', true),
    (p_tenant, 'DK', 'Số dư đầu kỳ', 'general', 'DK', true),
    (p_tenant, 'KC', 'Chứng từ kết chuyển', 'general', 'KC', true),
    (p_tenant, 'PB', 'Chứng từ phân bổ', 'general', 'PB', true),
    (p_tenant, 'PT', 'Phiếu thu', 'cash', 'PT', true),
    (p_tenant, 'PC', 'Phiếu chi', 'cash', 'PC', true),
    (p_tenant, 'BC', 'Giấy báo Có', 'bank', 'BC', true),
    (p_tenant, 'BN', 'Giấy báo Nợ (in Ủy nhiệm chi)', 'bank', 'BN', true),
    (p_tenant, 'CT', 'Chuyển tiền nội bộ', 'bank', 'CT', true),
    (p_tenant, 'QTU', 'Quyết toán tạm ứng', 'general', 'QTU', true),
    (p_tenant, 'BT', 'Bù trừ công nợ', 'arap', 'BT', true),
    (p_tenant, 'HDB', 'Hóa đơn bán dịch vụ', 'arap', 'HDB', true),
    (p_tenant, 'HDM', 'Hóa đơn mua dịch vụ', 'arap', 'HDM', true),
    (p_tenant, 'GGB', 'Giảm giá, trả lại dịch vụ bán', 'arap', 'GGB', true),
    (p_tenant, 'GGM', 'Giảm giá, trả lại dịch vụ mua', 'arap', 'GGM', true),
    (p_tenant, 'CL', 'Chênh lệch tỷ giá đối trừ', 'arap', 'CL', true),
    (p_tenant, 'DG', 'Đánh giá lại ngoại tệ', 'general', 'DG', true),
    (p_tenant, 'XQ', 'Điều chỉnh tỷ giá xuất quỹ', 'general', 'XQ', true),
    (p_tenant, 'KTT', 'Khấu trừ thuế GTGT', 'general', 'KTT', true),
    (p_tenant, 'PNK', 'Phiếu nhập kho', 'inventory', 'PNK', true),
    (p_tenant, 'PXK', 'Phiếu xuất kho', 'inventory', 'PXK', true),
    (p_tenant, 'CK', 'Phiếu chuyển kho', 'inventory', 'CK', true),
    (p_tenant, 'GV', 'Chứng từ giá vốn', 'inventory', 'GV', true),
    (p_tenant, 'MH', 'Mua hàng hóa', 'arap', 'MH', true),
    (p_tenant, 'TLM', 'Trả lại, giảm giá hàng mua', 'arap', 'TLM', true)
  ON CONFLICT DO NOTHING;
$$;

ALTER TABLE voucher_type DISABLE TRIGGER trg_audit;
SELECT seed_voucher_types(id) FROM tenant;
ALTER TABLE voucher_type ENABLE TRIGGER trg_audit;

-- Như fn_stock_mark_stale nhưng theo cặp hàng–kho và ngày cho trước (lớp điều chỉnh không có phát sinh kho của chứng từ).
CREATE OR REPLACE FUNCTION fn_stock_mark_stale_at(p_item bigint, p_wh bigint, p_date date) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO stock_cost_state(tenant_id, item_id, warehouse_id, stale_from)
  SELECT app_tenant(), p_item, p_wh, s.d
    FROM (SELECT min(greatest(p_date, r.period_from)) AS d FROM costing_run r
      WHERE r.tenant_id = app_tenant() AND r.status = 'done' AND r.period_to >= p_date
        AND ((r.summary -> 'pairs') ? (p_item || ':' || p_wh)
          OR ((r.warehouse_id IS NULL OR r.warehouse_id = p_wh) AND (r.item_id IS NULL OR r.item_id = p_item)))) s
    WHERE s.d IS NOT NULL
  ON CONFLICT (tenant_id, item_id, warehouse_id) DO UPDATE SET stale_from = least(stock_cost_state.stale_from, excluded.stale_from);
END $$;

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
      JOIN voucher bv ON bv.id = b.voucher_id WHERE a.voucher_id = v.reversal_of_id AND bv.state = 'posted' AND bv.id <> p_voucher LIMIT 1;
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
  IF v.voucher_type NOT IN ('MH', 'TLM') THEN RETURN; END IF;
  -- MH hàng về trước: chênh giữa giá hóa đơn và giá tạm tính của phiếu nhập (giá trị lớp nhập). TLM không trả hàng: giảm giá vốn bằng tiền hàng trên giảm giá.
  FOR l IN SELECT il.*, CASE WHEN v.voucher_type = 'TLM' THEN -round(il.amount - coalesce(il.discount_amount, 0)) ELSE round(il.amount - coalesce(il.discount_amount, 0)) END AS gross
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
    JOIN voucher bv ON bv.id = b.voucher_id WHERE a.voucher_id = p_voucher AND bv.state = 'posted' AND bv.id <> p_voucher LIMIT 1;
  IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'LINE_REFERENCED: chứng từ đã được chứng từ % tham chiếu, hãy bỏ ghi sổ chứng từ đó trước', v_ref USING ERRCODE = 'P0001'; END IF;
  IF v_type NOT IN ('MH', 'TLM') THEN RETURN; END IF;
  FOR r IN SELECT c.tenant_id, c.move_id, c.item_id, c.warehouse_id, c.lot_no, sum(c.value) AS net, min(c.posting_date) AS d FROM stock_cost_layer c
           WHERE c.tenant_id = app_tenant() AND c.kind = 'adjustment' AND c.voucher_id = p_voucher GROUP BY c.tenant_id, c.move_id, c.item_id, c.warehouse_id, c.lot_no HAVING sum(c.value) <> 0 LOOP
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
        ELSE v_val := round(l.amount - coalesce(l.discount_amount, 0)); END IF;
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


CREATE OR REPLACE FUNCTION public.fn_stock_moves_remove(p_voucher uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE k record; v_keys bigint[][]; n int; v_neg text; r record; v_out text; v_rm jsonb;
BEGIN
  PERFORM fn_stock_adjust_unlink(p_voucher); -- mua hàng: triệt tiêu lớp điều chỉnh của MH, TLM; chặn khi dòng đang được chứng từ khác tham chiếu
  SELECT array_agg(ARRAY[x.item_id, x.warehouse_id] ORDER BY hashtextextended(app_tenant()::text || ':' || x.item_id || ':' || x.warehouse_id, 0)) INTO v_keys
    FROM (SELECT DISTINCT item_id, warehouse_id FROM stock_move WHERE voucher_id = p_voucher) x;
  IF v_keys IS NULL THEN RETURN 0; END IF;
  PERFORM fn_stock_lock_keys(app_tenant(), v_keys);
  SELECT coalesce(jsonb_agg(jsonb_build_object('i', item_id, 'w', warehouse_id, 'd', d)), '[]') INTO v_rm
    FROM (SELECT item_id, warehouse_id, min(posting_date) d FROM stock_move WHERE voucher_id = p_voucher AND direction = 'in' GROUP BY item_id, warehouse_id) x;
  -- đã tính giá vốn: phiếu xuất cùng hàng–kho từ ngày nhập trở đi có giá gán hiện hành thì không bỏ ghi sổ phiếu nhập, mọi cấu hình tồn âm
  SELECT coalesce(ov.voucher_no, ov.voucher_type) || ' ngày ' || to_char(ov.posting_date, 'DD/MM/YYYY') INTO v_out
    FROM stock_move im JOIN stock_move om ON om.tenant_id = im.tenant_id AND om.item_id = im.item_id AND om.warehouse_id = im.warehouse_id
      AND om.direction = 'out' AND om.posting_date >= im.posting_date AND om.voucher_id <> p_voucher
    JOIN stock_cost_assignment a ON a.tenant_id = om.tenant_id AND a.move_id = om.id AND a.is_current
    JOIN voucher ov ON ov.id = om.voucher_id
    WHERE im.tenant_id = app_tenant() AND im.voucher_id = p_voucher AND im.direction = 'in' ORDER BY om.posting_date, om.id LIMIT 1;
  IF v_out IS NOT NULL THEN RAISE EXCEPTION 'STOCK_CONSUMED: phiếu nhập đã được xuất ở chứng từ % (đã tính giá vốn)', v_out USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM stock_cost_layer c JOIN stock_move m ON m.tenant_id = c.tenant_id AND m.id = c.move_id JOIN voucher cv ON cv.tenant_id = c.tenant_id AND cv.id = c.voucher_id
             WHERE m.tenant_id = app_tenant() AND m.voucher_id = p_voucher AND c.kind = 'adjustment' AND cv.voucher_type NOT IN ('MH', 'TLM')) THEN
    RAISE EXCEPTION 'STOCK_COST_ADJUSTED: Phiếu đã được điều chỉnh giá ở chứng từ giá vốn, hãy đảo phiếu thay vì bỏ ghi sổ' USING ERRCODE = 'P0001'; END IF;
  PERFORM fn_stock_mark_stale(p_voucher); -- trước khi xóa: cần ngày và cặp hàng–kho của phát sinh
  DELETE FROM stock_move WHERE voucher_id = p_voucher; -- lớp giá, gán giá đi theo (ON DELETE CASCADE)
  GET DIAGNOSTICS n = ROW_COUNT;
  SELECT coalesce((SELECT value #>> '{}' FROM tenant_setting WHERE tenant_id = app_tenant() AND key = 'stock_negative'), 'forbid') INTO v_neg;
  IF v_neg NOT IN ('forbid', 'warn', 'allow') THEN v_neg := 'forbid'; END IF;
  IF v_neg <> 'allow' THEN
    FOR k IN SELECT (e->>'i')::bigint AS item_id, (e->>'w')::bigint AS warehouse_id, (e->>'d')::date AS d FROM jsonb_array_elements(v_rm) e LOOP
      SELECT d, bal INTO r FROM fn_stock_first_negative(k.item_id, k.warehouse_id, k.d);
      IF r.d IS NOT NULL THEN
        SELECT coalesce(ov.voucher_no, ov.voucher_type) || ' ngày ' || to_char(ov.posting_date, 'DD/MM/YYYY') INTO v_out
          FROM stock_move sm JOIN voucher ov ON ov.id = sm.voucher_id
          WHERE sm.tenant_id = app_tenant() AND sm.item_id = k.item_id AND sm.warehouse_id = k.warehouse_id AND sm.direction = 'out' AND sm.posting_date >= k.d
          ORDER BY (sm.posting_date = r.d) DESC, sm.posting_date, sm.id LIMIT 1;
        IF v_neg = 'forbid' THEN
          RAISE EXCEPTION 'STOCK_CONSUMED: phiếu nhập đã được xuất ở chứng từ %', v_out USING ERRCODE = 'P0001'; END IF;
        RAISE WARNING 'STOCK_CONSUMED: phiếu nhập đã được xuất ở chứng từ %', v_out;
      END IF;
    END LOOP;
  END IF;
  RETURN n;
END $function$
;

-- Quy tắc soát lỗi THUE_LECH: hóa đơn giảm giá, trả lại ghi âm; thêm TLM vào danh sách viết cứng (như GGB, GGM). Hàm lấy thân hiện hành rồi thay chuỗi.
DO $mig$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('seed_data_check_rules(uuid)'::regprocedure);
  IF position($r$IN ('GGB','GGM')$r$ IN d) = 0 THEN RAISE EXCEPTION 'seed_data_check_rules không chứa danh sách GGB, GGM'; END IF;
  EXECUTE replace(d, $r$IN ('GGB','GGM')$r$, $r$IN ('GGB','GGM','TLM')$r$);
END $mig$;
ALTER TABLE data_check_rule DISABLE TRIGGER trg_audit;
UPDATE data_check_rule SET sql = replace(sql, $r$IN ('GGB','GGM')$r$, $r$IN ('GGB','GGM','TLM')$r$) WHERE code = 'THUE_LECH' AND is_system;
ALTER TABLE data_check_rule ENABLE TRIGGER trg_audit;
