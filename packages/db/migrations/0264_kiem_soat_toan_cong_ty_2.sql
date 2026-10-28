-- 0264_kiem_soat_toan_cong_ty_2.sql: GĐ7 gói 1 (sửa) — các kiểm soát kho/công nợ còn lại tính trên toàn công ty dù phiên bị giới hạn chi nhánh (tiếp theo 0261).
-- Người dùng chi nhánh A bỏ ghi sổ phiếu nhập mà chi nhánh B đã xuất, hoặc khoản công nợ đã đánh giá lại / đang được chọn đối trừ ở chứng từ của chi nhánh khác, bị RLS che nên kiểm soát bị lách.
-- Mỗi truy vấn kiểm soát được bọc fn_branch_scope_suspend/restore (khôi phục trước khi RAISE); thân hàm lấy từ định nghĩa hiện hành: fn_stock_moves_remove (0057), unpost_voucher (0099),
-- fn_stock_adjust_links (0068), fn_stock_adjust_unlink (kiểm tham chiếu dòng và chi phí mua giữ nguyên nhưng bọc phạm vi).

CREATE OR REPLACE FUNCTION public.fn_stock_moves_remove(p_voucher uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE v_prev text; v_adj boolean; k record; v_keys bigint[][]; n int; v_neg text; r record; v_out text; v_rm jsonb;
BEGIN
  PERFORM fn_stock_adjust_unlink(p_voucher); -- mua hàng: triệt tiêu lớp điều chỉnh của MH, TLM; chặn khi dòng đang được chứng từ khác tham chiếu
  SELECT array_agg(ARRAY[x.item_id, x.warehouse_id] ORDER BY hashtextextended(app_tenant()::text || ':' || x.item_id || ':' || x.warehouse_id, 0)) INTO v_keys
    FROM (SELECT DISTINCT item_id, warehouse_id FROM stock_move WHERE voucher_id = p_voucher) x;
  IF v_keys IS NULL THEN RETURN 0; END IF;
  PERFORM fn_stock_lock_keys(app_tenant(), v_keys);
  SELECT coalesce(jsonb_agg(jsonb_build_object('i', item_id, 'w', warehouse_id, 'd', d)), '[]') INTO v_rm
    FROM (SELECT item_id, warehouse_id, min(posting_date) d FROM stock_move WHERE voucher_id = p_voucher AND direction = 'in' GROUP BY item_id, warehouse_id) x;
  -- đã tính giá vốn: phiếu xuất cùng hàng–kho từ ngày nhập trở đi có giá gán hiện hành thì không bỏ ghi sổ phiếu nhập, mọi cấu hình tồn âm
  v_prev := fn_branch_scope_suspend(); SELECT coalesce(ov.voucher_no, ov.voucher_type) || ' ngày ' || to_char(ov.posting_date, 'DD/MM/YYYY') INTO v_out
    FROM stock_move im JOIN stock_move om ON om.tenant_id = im.tenant_id AND om.item_id = im.item_id AND om.warehouse_id = im.warehouse_id
      AND om.direction = 'out' AND om.posting_date >= im.posting_date AND om.voucher_id <> p_voucher
    JOIN stock_cost_assignment a ON a.tenant_id = om.tenant_id AND a.move_id = om.id AND a.is_current
    JOIN voucher ov ON ov.id = om.voucher_id
    WHERE im.tenant_id = app_tenant() AND im.voucher_id = p_voucher AND im.direction = 'in' ORDER BY om.posting_date, om.id LIMIT 1; PERFORM fn_branch_scope_restore(v_prev);
  IF v_out IS NOT NULL THEN RAISE EXCEPTION 'STOCK_CONSUMED: phiếu nhập đã được xuất ở chứng từ % (đã tính giá vốn)', v_out USING ERRCODE = 'P0001'; END IF;
  v_prev := fn_branch_scope_suspend(); v_adj := EXISTS (SELECT 1 FROM stock_cost_layer c JOIN stock_move m ON m.tenant_id = c.tenant_id AND m.id = c.move_id JOIN voucher cv ON cv.tenant_id = c.tenant_id AND cv.id = c.voucher_id
             WHERE m.tenant_id = app_tenant() AND m.voucher_id = p_voucher AND c.kind = 'adjustment' AND cv.voucher_type NOT IN ('MH', 'TLM', 'CPM')); PERFORM fn_branch_scope_restore(v_prev);
  IF v_adj THEN
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
        v_prev := fn_branch_scope_suspend(); SELECT coalesce(ov.voucher_no, ov.voucher_type) || ' ngày ' || to_char(ov.posting_date, 'DD/MM/YYYY') INTO v_out
          FROM stock_move sm JOIN voucher ov ON ov.id = sm.voucher_id
          WHERE sm.tenant_id = app_tenant() AND sm.item_id = k.item_id AND sm.warehouse_id = k.warehouse_id AND sm.direction = 'out' AND sm.posting_date >= k.d
          ORDER BY (sm.posting_date = r.d) DESC, sm.posting_date, sm.id LIMIT 1; PERFORM fn_branch_scope_restore(v_prev);
        IF v_neg = 'forbid' THEN
          RAISE EXCEPTION 'STOCK_CONSUMED: phiếu nhập đã được xuất ở chứng từ %', v_out USING ERRCODE = 'P0001'; END IF;
        RAISE WARNING 'STOCK_CONSUMED: phiếu nhập đã được xuất ở chứng từ %', v_out;
      END IF;
    END LOOP;
  END IF;
  RETURN n;
END $function$;

CREATE OR REPLACE FUNCTION public.unpost_voucher(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v_prev text; v voucher; p fiscal_period; v_by text; v_dg text;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.source_doc_type = 'closing_step' THEN RAISE EXCEPTION 'VOUCHER_SYSTEM_GENERATED: Chứng từ do hệ thống sinh (kết chuyển/phân bổ); dùng Chạy lại (đảo cũ) ở màn hình Kết chuyển' USING ERRCODE = 'P0001'; END IF;
  IF v.source_doc_type IN ('settlement_fx', 'fx_revaluation', 'fx_outflow', 'vat_offset', 'amortization', 'costing_run', 'asset_run', 'asset_event', 'loan_interest', 'payroll_run', 'cost_run', 'project_alloc') THEN
    RAISE EXCEPTION 'VOUCHER_SYSTEM_GENERATED: Chứng từ do hệ thống sinh (chênh lệch tỷ giá, đánh giá lại, tỷ giá xuất quỹ, khấu trừ thuế GTGT, phân bổ, giá vốn, khấu hao, tài sản, lãi vay, hạch toán lương, giá thành, phân bổ vụ việc); thao tác ở chức năng đã sinh ra chứng từ' USING ERRCODE = 'P0001'; END IF;
  IF v.source_doc_type = 'opening_balance' AND current_setting('app.opening_repost', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'VOUCHER_SYSTEM_GENERATED: Chứng từ số dư đầu kỳ chỉ sửa ở màn hình Số dư đầu kỳ' USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'posted' THEN RAISE EXCEPTION 'STATE_INVALID: chỉ bỏ ghi sổ được chứng từ đang ghi sổ (hiện tại: %)', v.state USING ERRCODE = 'P0001'; END IF;
  IF v.reversal_of_id IS NOT NULL THEN RAISE EXCEPTION 'STATE_INVALID: chứng từ đảo không bỏ ghi sổ được; hãy đảo lại chứng từ này' USING ERRCODE = 'P0001'; END IF;
  IF v.row_hash IS NOT NULL THEN RAISE EXCEPTION 'VOUCHER_HASHED: chứng từ đã nằm trong chuỗi khóa cứng' USING ERRCODE = 'P0001'; END IF;
  p := fn_period_of(v.tenant_id, v.posting_date, v.voucher_type = 'DK');
  IF p.status = 'hard_locked' THEN RAISE EXCEPTION 'UNPOST_PERIOD_NOT_OPEN: kỳ đã khóa cứng; lập bút toán điều chỉnh ở kỳ đang mở' USING ERRCODE = 'P0001'; END IF;
  IF p.status <> 'open' THEN RAISE EXCEPTION 'UNPOST_PERIOD_NOT_OPEN: kỳ %/% đã khóa, hãy lập chứng từ đảo', p.period_no, p.fiscal_year USING ERRCODE = 'P0001'; END IF;
  -- công nợ: khoản của chứng từ đã đối trừ thì phải hủy đối trừ trước (khóa ngoại của settlement cũng chặn xóa khoản khi có đối trừ chen vào đồng thời)
  IF EXISTS (SELECT 1 FROM open_item o JOIN settlement s ON s.tenant_id = o.tenant_id AND (s.debit_item_id = o.id OR s.credit_item_id = o.id) WHERE o.voucher_id = p_id) THEN
    RAISE EXCEPTION 'OPEN_ITEM_SETTLED: chứng từ đã đối trừ công nợ, hãy hủy đối trừ trước' USING ERRCODE = 'P0001'; END IF;
  -- đánh giá lại (sau kiểm đối trừ: đảo cũng cần hủy đối trừ trước): khoản đã có khoản con (điều chỉnh đánh giá lại, kể cả của DG đã đảo) không xóa được;
  -- đảo chứng từ thì đóng cả nhóm (fn_open_items_settle_reversal)
  v_prev := fn_branch_scope_suspend(); SELECT coalesce(dv.voucher_no, dv.voucher_type) || ' ngày ' || to_char(dv.posting_date, 'DD/MM/YYYY') INTO v_dg
    FROM open_item o JOIN open_item c ON c.tenant_id = o.tenant_id AND c.parent_id = o.id JOIN voucher dv ON dv.id = c.voucher_id
    WHERE o.voucher_id = p_id ORDER BY dv.reversal_of_id IS NOT NULL, dv.posting_date, dv.voucher_no LIMIT 1; PERFORM fn_branch_scope_restore(v_prev);
  IF v_dg IS NOT NULL THEN
    RAISE EXCEPTION 'OPEN_ITEM_REVALUED: Khoản công nợ đã đánh giá lại tỷ giá ở chứng từ %: không bỏ ghi sổ được, hãy dùng Đảo chứng từ', v_dg USING ERRCODE = 'P0001'; END IF;
  -- đối trừ: khoản đang được chứng từ nháp chọn để đối trừ khi ghi sổ
  v_prev := fn_branch_scope_suspend(); SELECT coalesce(d.voucher_no, d.voucher_type || ' ngày ' || to_char(d.posting_date, 'DD/MM/YYYY')) INTO v_by
    FROM open_item o JOIN settlement_plan sp ON sp.tenant_id = o.tenant_id AND sp.open_item_id = o.id JOIN voucher d ON d.id = sp.voucher_id
    WHERE o.voucher_id = p_id ORDER BY d.posting_date, d.id LIMIT 1; PERFORM fn_branch_scope_restore(v_prev);
  IF v_by IS NOT NULL THEN
    RAISE EXCEPTION 'OPEN_ITEM_PLANNED: khoản công nợ của chứng từ đang được chọn đối trừ ở chứng từ nháp %, hãy bỏ chọn ở chứng từ đó trước', v_by USING ERRCODE = 'P0001'; END IF;
  INSERT INTO voucher_line_history(tenant_id, voucher_id, version, header, lines, archived_by)
    SELECT v.tenant_id, p_id, v.version, to_jsonb(v), coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.line_no), '[]'), app_user_id() FROM voucher_line l WHERE l.voucher_id = p_id;
  PERFORM set_config('app.state_change', 'on', true); PERFORM set_config('app.unposting', 'on', true);
  UPDATE voucher SET state = 'draft', posted_by = NULL, posted_at = NULL WHERE id = p_id;
  DELETE FROM voucher_pair WHERE voucher_id = p_id;
  DELETE FROM open_item WHERE voucher_id = p_id; -- công nợ
  PERFORM fn_stock_moves_remove(p_id); -- kho: xóa phát sinh, từ chối nếu đã bị xuất
  PERFORM set_config('app.state_change', 'off', true); PERFORM set_config('app.unposting', 'off', true);
  PERFORM mark_balance_stale(v.tenant_id, p.fiscal_year, p.period_no);
  PERFORM fn_audit_voucher(v.tenant_id, 'unpost', p_id, jsonb_build_object('voucher_no', v.voucher_no));
END $function$;

CREATE OR REPLACE FUNCTION public.fn_stock_adjust_links(p_voucher uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_prev text; v voucher; l record; r record; v_orig text; v_diff numeric; v_ref text;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  IF v.reversal_of_id IS NOT NULL THEN
    SELECT voucher_type INTO v_orig FROM voucher WHERE id = v.reversal_of_id;
    v_prev := fn_branch_scope_suspend(); SELECT coalesce(bv.voucher_no, bv.voucher_type) INTO v_ref FROM voucher_item_line a JOIN voucher_item_line b ON b.tenant_id = a.tenant_id AND b.link_line_id = a.id
      JOIN voucher bv ON bv.id = b.voucher_id WHERE a.voucher_id = v.reversal_of_id AND bv.state IN ('draft', 'posted') AND bv.id <> p_voucher LIMIT 1; PERFORM fn_branch_scope_restore(v_prev);
    IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'LINE_REFERENCED: chứng từ đã được chứng từ % tham chiếu, hãy đảo chứng từ đó trước', v_ref USING ERRCODE = 'P0001'; END IF;
    v_prev := fn_branch_scope_suspend(); SELECT coalesce(cv.voucher_no, 'nháp ' || cv.voucher_type) INTO v_ref FROM landed_cost_alloc la JOIN voucher_item_line il ON il.tenant_id = la.tenant_id AND il.id = la.receipt_line_id
      JOIN voucher cv ON cv.id = la.voucher_id WHERE il.voucher_id = v.reversal_of_id AND cv.state IN ('draft', 'posted') LIMIT 1; PERFORM fn_branch_scope_restore(v_prev);
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
DECLARE v_prev text; r record; v_ref text; v_type text;
BEGIN
  SELECT voucher_type INTO v_type FROM voucher WHERE id = p_voucher;
  v_prev := fn_branch_scope_suspend(); SELECT coalesce(bv.voucher_no, bv.voucher_type) INTO v_ref FROM voucher_item_line a JOIN voucher_item_line b ON b.tenant_id = a.tenant_id AND b.link_line_id = a.id
    JOIN voucher bv ON bv.id = b.voucher_id WHERE a.voucher_id = p_voucher AND bv.state IN ('draft', 'posted') AND bv.id <> p_voucher LIMIT 1; PERFORM fn_branch_scope_restore(v_prev);
  IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'LINE_REFERENCED: chứng từ đã được chứng từ % tham chiếu, hãy bỏ ghi sổ chứng từ đó trước', v_ref USING ERRCODE = 'P0001'; END IF;
  -- phiếu nhập (PNK, MH) đã được chứng từ chi phí mua hàng (nháp hoặc đã ghi sổ) phân bổ: bỏ ghi sổ chứng từ chi phí trước
  v_prev := fn_branch_scope_suspend(); SELECT coalesce(cv.voucher_no, 'nháp ' || cv.voucher_type) INTO v_ref FROM landed_cost_alloc la JOIN voucher_item_line il ON il.tenant_id = la.tenant_id AND il.id = la.receipt_line_id
    JOIN voucher cv ON cv.id = la.voucher_id WHERE il.voucher_id = p_voucher AND cv.state IN ('draft', 'posted') LIMIT 1; PERFORM fn_branch_scope_restore(v_prev);
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
