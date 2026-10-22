-- Bỏ kiểm INVOICE_LINK_LOST ở ghi sổ PNK: phiếu nhập tay Có 151 (hàng đang đi đường từ số dư đầu kỳ) là hợp lệ. Phiếu lập từ sourceInvoiceIds vẫn luôn có liên kết do API dựng. Thân hàm lấy từ 0055.
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
  -- liên kết không được mất: dòng hàng MH hàng về trước phải gắn dòng phiếu nhập; 
  IF v.voucher_type = 'MH' AND v.receipt_state = 'goods_first' AND EXISTS (SELECT 1 FROM voucher_item_line il JOIN item i ON i.tenant_id = il.tenant_id AND i.id = il.item_id AND i.kind <> 'service'
       WHERE il.voucher_id = p_voucher AND il.link_line_id IS NULL) THEN
    RAISE EXCEPTION 'RECEIPT_LINK_LOST: hóa đơn hàng về trước mất liên kết với phiếu nhập kho (phiếu nhập đã bị đảo hoặc xóa), hãy lập lại hóa đơn' USING ERRCODE = 'P0001'; END IF;
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
