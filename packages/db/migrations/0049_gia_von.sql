-- GĐ3 Task 8: tính giá vốn. Loại chứng từ GV (hệ thống); chặn bỏ ghi sổ/hủy chứng từ nguồn costing_run; trạng thái giá vốn chưa cập nhật theo hàng–kho;
-- bỏ ghi sổ phiếu nhập đã tính giá vốn cho phiếu xuất sau bị chặn mọi cấu hình. Thân hàm lấy bằng pg_get_functiondef trên DB đã migrate đến 0048.
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
    (p_tenant, 'GV', 'Chứng từ giá vốn', 'inventory', 'GV', true)
  ON CONFLICT DO NOTHING;
$$;
ALTER TABLE voucher_type DISABLE TRIGGER trg_audit;
SELECT seed_voucher_types(id) FROM tenant;
ALTER TABLE voucher_type ENABLE TRIGGER trg_audit;

-- Cặp hàng–kho có giá vốn chưa cập nhật từ ngày stale_from (đánh dấu khi ghi lùi: Task 10; lần chạy giá vốn xóa hoặc dời).
CREATE TABLE stock_cost_state (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  item_id bigint NOT NULL, warehouse_id bigint NOT NULL, stale_from date NOT NULL,
  PRIMARY KEY (tenant_id, item_id, warehouse_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id));
SELECT rls_enable('stock_cost_state'::regclass);
CREATE INDEX stock_cost_assignment_run ON stock_cost_assignment (tenant_id, run_id);

CREATE OR REPLACE FUNCTION public.unpost_voucher(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; p fiscal_period; v_by text; v_dg text;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.source_doc_type = 'closing_step' THEN RAISE EXCEPTION 'VOUCHER_SYSTEM_GENERATED: Chứng từ do hệ thống sinh (kết chuyển/phân bổ); dùng Chạy lại (đảo cũ) ở màn hình Kết chuyển' USING ERRCODE = 'P0001'; END IF;
  IF v.source_doc_type IN ('settlement_fx', 'fx_revaluation', 'fx_outflow', 'vat_offset', 'amortization', 'costing_run') THEN
    RAISE EXCEPTION 'VOUCHER_SYSTEM_GENERATED: Chứng từ do hệ thống sinh (chênh lệch tỷ giá, đánh giá lại, tỷ giá xuất quỹ, khấu trừ thuế GTGT, phân bổ, giá vốn); thao tác ở chức năng đã sinh ra chứng từ' USING ERRCODE = 'P0001'; END IF;
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
  SELECT coalesce(dv.voucher_no, dv.voucher_type) || ' ngày ' || to_char(dv.posting_date, 'DD/MM/YYYY') INTO v_dg
    FROM open_item o JOIN open_item c ON c.tenant_id = o.tenant_id AND c.parent_id = o.id JOIN voucher dv ON dv.id = c.voucher_id
    WHERE o.voucher_id = p_id ORDER BY dv.reversal_of_id IS NOT NULL, dv.posting_date, dv.voucher_no LIMIT 1;
  IF v_dg IS NOT NULL THEN
    RAISE EXCEPTION 'OPEN_ITEM_REVALUED: Khoản công nợ đã đánh giá lại tỷ giá ở chứng từ %: không bỏ ghi sổ được, hãy dùng Đảo chứng từ', v_dg USING ERRCODE = 'P0001'; END IF;
  -- đối trừ: khoản đang được chứng từ nháp chọn để đối trừ khi ghi sổ
  SELECT coalesce(d.voucher_no, d.voucher_type || ' ngày ' || to_char(d.posting_date, 'DD/MM/YYYY')) INTO v_by
    FROM open_item o JOIN settlement_plan sp ON sp.tenant_id = o.tenant_id AND sp.open_item_id = o.id JOIN voucher d ON d.id = sp.voucher_id
    WHERE o.voucher_id = p_id ORDER BY d.posting_date, d.id LIMIT 1;
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

CREATE OR REPLACE FUNCTION public.discard_voucher(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.source_doc_type = 'closing_step' THEN RAISE EXCEPTION 'VOUCHER_SYSTEM_GENERATED: Chứng từ do hệ thống sinh (kết chuyển/phân bổ); dùng Chạy lại (đảo cũ) ở màn hình Kết chuyển' USING ERRCODE = 'P0001'; END IF;
  IF v.source_doc_type IN ('settlement_fx', 'fx_revaluation', 'fx_outflow', 'vat_offset', 'amortization', 'costing_run') THEN
    RAISE EXCEPTION 'VOUCHER_SYSTEM_GENERATED: Chứng từ do hệ thống sinh (chênh lệch tỷ giá, đánh giá lại, tỷ giá xuất quỹ, khấu trừ thuế GTGT, phân bổ, giá vốn); thao tác ở chức năng đã sinh ra chứng từ' USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'draft' THEN RAISE EXCEPTION 'STATE_INVALID: chỉ hủy được chứng từ nháp (hiện tại: %)', v.state USING ERRCODE = 'P0001'; END IF;
  DELETE FROM settlement_plan WHERE voucher_id = p_id; -- đối trừ: chứng từ đã hủy không giữ kế hoạch đối trừ
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'cancelled' WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_audit_voucher(v.tenant_id, 'discard', p_id, jsonb_build_object('voucher_no', v.voucher_no));
END $function$;

CREATE OR REPLACE FUNCTION public.fn_stock_moves_remove(p_voucher uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE k record; v_keys bigint[][]; n int; v_neg text; r record; v_out text; v_rm jsonb;
BEGIN
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

-- Chứng từ GV mang phần chênh của gán giá (để chạy lại biết ngày của phần chênh khi chuyển sang lần chạy mới).
ALTER TABLE stock_cost_assignment ADD COLUMN voucher_id uuid, ADD FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id);
