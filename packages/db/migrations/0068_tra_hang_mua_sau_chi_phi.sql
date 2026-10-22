-- Trả lại hàng mua sau chi phí mua (CPM): TLM ghi theo giá hóa đơn mua (331/156/1331); phần chi phí mua đã phân bổ cho số lượng trả rời kho cùng phiếu (Nợ 632 / Có TK kho).
-- voucher_item_line.landed_cost_out: số tiền đó của dòng trả; stock_cost_layer.landed: lớp đối âm của nó, loại khỏi giá trị theo giá mua (như lớp của CPM).
ALTER TABLE voucher_item_line ADD COLUMN landed_cost_out numeric(20,0) NOT NULL DEFAULT 0 CHECK (landed_cost_out >= 0);
ALTER TABLE stock_cost_layer ADD COLUMN landed boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.fn_stock_adjust_links(p_voucher uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v voucher; l record; r record; v_orig text; v_diff numeric; v_ref text;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  IF v.reversal_of_id IS NOT NULL THEN
    SELECT voucher_type INTO v_orig FROM voucher WHERE id = v.reversal_of_id;
    SELECT coalesce(bv.voucher_no, bv.voucher_type) INTO v_ref FROM voucher_item_line a JOIN voucher_item_line b ON b.tenant_id = a.tenant_id AND b.link_line_id = a.id
      JOIN voucher bv ON bv.id = b.voucher_id WHERE a.voucher_id = v.reversal_of_id AND bv.state IN ('draft', 'posted') AND bv.id <> p_voucher LIMIT 1;
    IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'LINE_REFERENCED: chứng từ đã được chứng từ % tham chiếu, hãy đảo chứng từ đó trước', v_ref USING ERRCODE = 'P0001'; END IF;
    SELECT coalesce(cv.voucher_no, 'nháp ' || cv.voucher_type) INTO v_ref FROM landed_cost_alloc la JOIN voucher_item_line il ON il.tenant_id = la.tenant_id AND il.id = la.receipt_line_id
      JOIN voucher cv ON cv.id = la.voucher_id WHERE il.voucher_id = v.reversal_of_id AND cv.state IN ('draft', 'posted') LIMIT 1;
    IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'LANDED_COST_REFERENCED: phiếu nhập đã được phân bổ chi phí mua ở chứng từ %, hãy đảo chứng từ đó trước', v_ref USING ERRCODE = 'P0001'; END IF;
    IF v_orig IN ('MH', 'TLM', 'CPM') THEN
      FOR r IN SELECT c.move_id, c.item_id, c.warehouse_id, c.lot_no, c.landed, sum(c.value) AS net, min(c.posting_date) AS d FROM stock_cost_layer c
               WHERE c.tenant_id = v.tenant_id AND c.kind = 'adjustment' AND c.voucher_id = v.reversal_of_id GROUP BY c.move_id, c.item_id, c.warehouse_id, c.lot_no, c.landed HAVING sum(c.value) <> 0 LOOP
        INSERT INTO stock_cost_layer(tenant_id, move_id, item_id, warehouse_id, lot_no, kind, posting_date, qty, unit_cost, value, remaining_qty, remaining_value, voucher_id, landed)
        VALUES (v.tenant_id, r.move_id, r.item_id, r.warehouse_id, r.lot_no, 'adjustment', r.d, 0, 0, -r.net, 0, 0, p_voucher, r.landed);
        PERFORM fn_stock_mark_stale_at(r.item_id, r.warehouse_id, r.d);
      END LOOP;
    END IF;
    RETURN;
  END IF;
  IF v.voucher_type = 'PNK' AND EXISTS (SELECT 1 FROM voucher_item_line il JOIN voucher_item_line ml ON ml.tenant_id = il.tenant_id AND ml.id = il.link_line_id JOIN voucher mv ON mv.id = ml.voucher_id
       WHERE il.voucher_id = p_voucher AND mv.state <> 'posted') THEN
    RAISE EXCEPTION 'INVOICE_NOT_POSTED: hóa đơn mua của phiếu nhập chưa ghi sổ' USING ERRCODE = 'P0001'; END IF;
  -- liên kết không được mất: dòng hàng MH hàng về trước phải gắn dòng phiếu nhập; 
  IF v.voucher_type = 'MH' AND v.receipt_state = 'goods_first' AND EXISTS (SELECT 1 FROM voucher_item_line il JOIN item i ON i.tenant_id = il.tenant_id AND i.id = il.item_id AND i.kind <> 'service'
       WHERE il.voucher_id = p_voucher AND il.link_line_id IS NULL) THEN
    RAISE EXCEPTION 'RECEIPT_LINK_LOST: hóa đơn hàng về trước mất liên kết với phiếu nhập kho (phiếu nhập đã bị đảo hoặc xóa), hãy lập lại hóa đơn' USING ERRCODE = 'P0001'; END IF;
  -- Chi phí mua hàng (CPM): phân bổ (landed_cost_alloc) thành lớp điều chỉnh của phát sinh nhập của dòng nhập, voucher_id = CPM (CPM đã ghi Nợ TK kho, GV không ghi lại).
  IF v.voucher_type = 'CPM' THEN
    IF NOT EXISTS (SELECT 1 FROM landed_cost_alloc WHERE voucher_id = p_voucher) THEN RAISE EXCEPTION 'LANDED_COST_EMPTY: chứng từ chi phí mua hàng chưa phân bổ cho phiếu nhập nào' USING ERRCODE = 'P0001'; END IF;
    IF (SELECT coalesce(sum(amount), 0) FROM landed_cost_alloc WHERE voucher_id = p_voucher)
       <> (SELECT coalesce(sum(debit - credit), 0) FROM voucher_line WHERE voucher_id = p_voucher AND posting_date = v.posting_date AND item_id IS NOT NULL) THEN
      RAISE EXCEPTION 'LANDED_COST_MISMATCH: tổng phân bổ khác số ghi Nợ tài khoản kho của chứng từ chi phí mua hàng' USING ERRCODE = 'P0001'; END IF;
    FOR l IN SELECT la.receipt_line_id, la.amount FROM landed_cost_alloc la WHERE la.voucher_id = p_voucher AND la.amount <> 0 ORDER BY la.id LOOP
      SELECT m.id, m.item_id, m.warehouse_id, m.lot_no, m.posting_date, mv.state, coalesce(mv.voucher_no, mv.voucher_type) AS vno INTO r FROM stock_move m JOIN voucher mv ON mv.id = m.voucher_id
        WHERE m.tenant_id = v.tenant_id AND m.item_line_id = l.receipt_line_id AND m.direction = 'in' AND m.reversal_of IS NULL AND m.transfer_id IS NULL;
      IF NOT FOUND OR r.state <> 'posted' THEN RAISE EXCEPTION 'RECEIPT_NOT_POSTED: phiếu nhập được phân bổ chi phí mua chưa ghi sổ' USING ERRCODE = 'P0001'; END IF;
      IF r.posting_date > v.posting_date THEN RAISE EXCEPTION 'LANDED_COST_DATE_INVALID: chi phí mua hàng ghi ngày % trước ngày nhập kho % của phiếu %', to_char(v.posting_date, 'DD/MM/YYYY'), to_char(r.posting_date, 'DD/MM/YYYY'), r.vno USING ERRCODE = 'P0001'; END IF;
      INSERT INTO stock_cost_layer(tenant_id, move_id, item_id, warehouse_id, lot_no, kind, posting_date, qty, unit_cost, value, remaining_qty, remaining_value, voucher_id)
      VALUES (v.tenant_id, r.id, r.item_id, r.warehouse_id, r.lot_no, 'adjustment', r.posting_date, 0, 0, l.amount, 0, 0, p_voucher);
      PERFORM fn_stock_mark_stale_at(r.item_id, r.warehouse_id, r.posting_date);
    END LOOP;
    RETURN;
  END IF;
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
  -- TLM trả hàng sau chi phí mua: phần chi phí mua đã phân bổ cho số lượng trả (landed_cost_out) rời kho cùng phiếu trả (Nợ 632 / Có TK kho); lớp đối âm đánh dấu landed.
  IF v.voucher_type = 'TLM' THEN
    FOR l IN SELECT il.link_line_id, il.landed_cost_out FROM voucher_item_line il WHERE il.voucher_id = p_voucher AND il.warehouse_id IS NOT NULL AND il.link_line_id IS NOT NULL AND il.landed_cost_out <> 0 ORDER BY il.line_no LOOP
      SELECT m.id, m.item_id, m.warehouse_id, m.lot_no, m.posting_date INTO r FROM stock_move m
        WHERE m.tenant_id = v.tenant_id AND m.item_line_id = l.link_line_id AND m.direction = 'in' AND m.reversal_of IS NULL AND m.transfer_id IS NULL;
      IF NOT FOUND THEN RAISE EXCEPTION 'RECEIPT_NOT_POSTED: dòng trả hàng tham chiếu phiếu nhập chưa ghi sổ' USING ERRCODE = 'P0001'; END IF;
      INSERT INTO stock_cost_layer(tenant_id, move_id, item_id, warehouse_id, lot_no, kind, posting_date, qty, unit_cost, value, remaining_qty, remaining_value, voucher_id, landed)
      VALUES (v.tenant_id, r.id, r.item_id, r.warehouse_id, r.lot_no, 'adjustment', r.posting_date, 0, 0, -l.landed_cost_out, 0, 0, p_voucher, true);
      PERFORM fn_stock_mark_stale_at(r.item_id, r.warehouse_id, r.posting_date);
    END LOOP;
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_stock_adjust_unlink(p_voucher uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; v_ref text; v_type text;
BEGIN
  SELECT voucher_type INTO v_type FROM voucher WHERE id = p_voucher;
  SELECT coalesce(bv.voucher_no, bv.voucher_type) INTO v_ref FROM voucher_item_line a JOIN voucher_item_line b ON b.tenant_id = a.tenant_id AND b.link_line_id = a.id
    JOIN voucher bv ON bv.id = b.voucher_id WHERE a.voucher_id = p_voucher AND bv.state IN ('draft', 'posted') AND bv.id <> p_voucher LIMIT 1;
  IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'LINE_REFERENCED: chứng từ đã được chứng từ % tham chiếu, hãy bỏ ghi sổ chứng từ đó trước', v_ref USING ERRCODE = 'P0001'; END IF;
  -- phiếu nhập (PNK, MH) đã được chứng từ chi phí mua hàng (nháp hoặc đã ghi sổ) phân bổ: bỏ ghi sổ chứng từ chi phí trước
  SELECT coalesce(cv.voucher_no, 'nháp ' || cv.voucher_type) INTO v_ref FROM landed_cost_alloc la JOIN voucher_item_line il ON il.tenant_id = la.tenant_id AND il.id = la.receipt_line_id
    JOIN voucher cv ON cv.id = la.voucher_id WHERE il.voucher_id = p_voucher AND cv.state IN ('draft', 'posted') LIMIT 1;
  IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'LANDED_COST_REFERENCED: phiếu nhập đã được phân bổ chi phí mua ở chứng từ %, hãy bỏ ghi sổ hoặc đảo chứng từ đó trước', v_ref USING ERRCODE = 'P0001'; END IF;
  IF v_type NOT IN ('MH', 'TLM', 'CPM') THEN RETURN; END IF;
  FOR r IN SELECT c.tenant_id, c.move_id, c.item_id, c.warehouse_id, c.lot_no, c.landed, sum(c.value) AS net, min(c.posting_date) AS d FROM stock_cost_layer c
           WHERE c.tenant_id = app_tenant() AND c.kind = 'adjustment' AND c.voucher_id = p_voucher GROUP BY c.tenant_id, c.move_id, c.item_id, c.warehouse_id, c.lot_no, c.landed HAVING sum(c.value) <> 0 LOOP
    -- đã có lần tính giá vốn hoàn tất bao phủ ngày nhập: giá vốn đã dùng lớp điều chỉnh này, phải đảo chứng từ thay vì bỏ ghi sổ
    IF EXISTS (SELECT 1 FROM costing_run cr WHERE cr.tenant_id = r.tenant_id AND cr.status = 'done' AND cr.period_to >= r.d
        AND ((cr.summary -> 'pairs') ? (r.item_id || ':' || r.warehouse_id) OR ((cr.warehouse_id IS NULL OR cr.warehouse_id = r.warehouse_id) AND (cr.item_id IS NULL OR cr.item_id = r.item_id)))) THEN
      RAISE EXCEPTION 'STOCK_COST_ADJUSTED: chứng từ đã điều chỉnh giá nhập đã tính giá vốn, hãy đảo chứng từ thay vì bỏ ghi sổ' USING ERRCODE = 'P0001'; END IF;
    INSERT INTO stock_cost_layer(tenant_id, move_id, item_id, warehouse_id, lot_no, kind, posting_date, qty, unit_cost, value, remaining_qty, remaining_value, voucher_id, landed)
    VALUES (r.tenant_id, r.move_id, r.item_id, r.warehouse_id, r.lot_no, 'adjustment', r.d, 0, 0, -r.net, 0, 0, p_voucher, r.landed);
    PERFORM fn_stock_mark_stale_at(r.item_id, r.warehouse_id, r.d);
  END LOOP;
END $function$;
