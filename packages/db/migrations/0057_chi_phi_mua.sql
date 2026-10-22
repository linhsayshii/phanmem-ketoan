-- GĐ3 Task 12: chi phí mua hàng (CPM) phân bổ vào giá nhập kho; nhập khẩu (thuế NK, TTĐB, GTGT hàng nhập) nằm ở API, không đổi lược đồ.
-- landed_cost_alloc: số chi phí phân bổ cho từng dòng nhập (dòng PNK hoặc dòng MH nhập kho cùng hóa đơn). Khi ghi sổ CPM, mỗi dòng thành một lớp 'adjustment' gắn phát sinh nhập,
-- voucher_id = CPM (CPM đã ghi Nợ TK kho / Có TK thanh toán nên GV không ghi lại). Bỏ ghi sổ, đảo: lớp đối như MH, TLM. Phiếu nhập đang được CPM nháp/đã ghi sổ phân bổ thì không bỏ ghi sổ, không đảo được.
-- Thân hàm lấy bằng pg_get_functiondef trên DB đã migrate đến 0056.
-- Dòng hàng nhập khẩu của MH: số thuế nhập tay theo tờ khai hải quan (VND, không có biểu thuế trong hệ thống). Thuế NK, TTĐB vào giá nhập kho; GTGT hàng nhập Nợ 1331 / Có 33312 theo mã thuế GTGT import_vat_code.
ALTER TABLE voucher_item_line ADD COLUMN import_mode boolean NOT NULL DEFAULT false, ADD COLUMN import_tax numeric(20,0), ADD COLUMN excise_tax numeric(20,0), ADD COLUMN import_vat numeric(20,0), ADD COLUMN import_vat_code text,
  ADD CONSTRAINT voucher_item_line_import_check CHECK (import_mode OR (import_tax IS NULL AND excise_tax IS NULL AND import_vat IS NULL AND import_vat_code IS NULL));

CREATE TABLE landed_cost_alloc (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  voucher_id uuid NOT NULL,
  receipt_line_id bigint NOT NULL,
  amount numeric(20,0) NOT NULL CHECK (amount >= 0),
  basis text NOT NULL CHECK (basis IN ('value', 'quantity')),
  UNIQUE (tenant_id, voucher_id, receipt_line_id),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, receipt_line_id) REFERENCES voucher_item_line (tenant_id, id));
CREATE INDEX landed_cost_alloc_receipt ON landed_cost_alloc (tenant_id, receipt_line_id);
SELECT rls_enable('landed_cost_alloc');
SELECT audit_enable('landed_cost_alloc');
CREATE TRIGGER trg_landed_cost_alloc_guard BEFORE INSERT OR UPDATE OR DELETE ON landed_cost_alloc FOR EACH ROW EXECUTE FUNCTION fn_voucher_child_guard();

CREATE OR REPLACE FUNCTION public.seed_voucher_types(p_tenant uuid)
 RETURNS void
 LANGUAGE sql
AS $function$
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
    (p_tenant, 'TLM', 'Trả lại, giảm giá hàng mua', 'arap', 'TLM', true),
    (p_tenant, 'CPM', 'Chi phí mua hàng', 'arap', 'CPM', true)
  ON CONFLICT DO NOTHING;
$function$;

ALTER TABLE voucher_type DISABLE TRIGGER trg_audit;
SELECT seed_voucher_types(id) FROM tenant;
ALTER TABLE voucher_type ENABLE TRIGGER trg_audit;

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
END $function$;

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
             WHERE m.tenant_id = app_tenant() AND m.voucher_id = p_voucher AND c.kind = 'adjustment' AND cv.voucher_type NOT IN ('MH', 'TLM', 'CPM')) THEN
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
END $function$;
