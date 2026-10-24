-- GĐ6 Task 6a: hạch toán bảng lương (chứng từ LU), đăng ký sớm loại GT (giá thành), tài khoản chi phí lương theo bộ phận.

-- Loại chứng từ hệ thống LU (phần hành payroll, CHECK 0004) và GT (inventory); thân seed_voucher_types lấy bằng pg_get_functiondef (0069), thêm hai dòng.
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
    (p_tenant, 'LR', 'Phiếu lắp ráp, tháo dỡ', 'inventory', 'LR', true),
    (p_tenant, 'GV', 'Chứng từ giá vốn', 'inventory', 'GV', true),
    (p_tenant, 'MH', 'Mua hàng hóa', 'arap', 'MH', true),
    (p_tenant, 'TLM', 'Trả lại, giảm giá hàng mua', 'arap', 'TLM', true),
    (p_tenant, 'CPM', 'Chi phí mua hàng', 'arap', 'CPM', true),
    (p_tenant, 'BH', 'Bán hàng hóa kiêm phiếu xuất', 'arap', 'BH', true),
    (p_tenant, 'TLB', 'Hàng bán bị trả lại', 'arap', 'TLB', true),
    (p_tenant, 'TS', 'Chứng từ tài sản (ghi tăng, ghi giảm, đánh giá lại)', 'assets', 'TS', true),
    (p_tenant, 'KH', 'Chứng từ khấu hao TSCĐ', 'assets', 'KH', true),
    (p_tenant, 'LV', 'Chứng từ lãi vay', 'general', 'LV', true),
    (p_tenant, 'LU', 'Chứng từ hạch toán lương', 'payroll', 'LU', true),
    (p_tenant, 'GT', 'Chứng từ giá thành', 'inventory', 'GT', true)
  ON CONFLICT DO NOTHING;
$function$;

ALTER TABLE voucher_type DISABLE TRIGGER trg_audit;
SELECT seed_voucher_types(id) FROM tenant;
ALTER TABLE voucher_type ENABLE TRIGGER trg_audit;

-- D8: chứng từ sinh từ bảng lương (payroll_run), chạy giá thành (cost_run), phân bổ vụ việc (project_alloc) không bỏ ghi sổ, không hủy qua đường chung:
-- chạy lại/hủy hạch toán luôn bằng đảo. Thân từ pg_get_functiondef (bản 0069), chỉ thêm ba mã vào danh sách và thông báo.
CREATE OR REPLACE FUNCTION public.unpost_voucher(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; p fiscal_period; v_by text; v_dg text;
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
  IF v.source_doc_type IN ('settlement_fx', 'fx_revaluation', 'fx_outflow', 'vat_offset', 'amortization', 'costing_run', 'asset_run', 'asset_event', 'loan_interest', 'payroll_run', 'cost_run', 'project_alloc') THEN
    RAISE EXCEPTION 'VOUCHER_SYSTEM_GENERATED: Chứng từ do hệ thống sinh (chênh lệch tỷ giá, đánh giá lại, tỷ giá xuất quỹ, khấu trừ thuế GTGT, phân bổ, giá vốn, khấu hao, tài sản, lãi vay, hạch toán lương, giá thành, phân bổ vụ việc); thao tác ở chức năng đã sinh ra chứng từ' USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'draft' THEN RAISE EXCEPTION 'STATE_INVALID: chỉ hủy được chứng từ nháp (hiện tại: %)', v.state USING ERRCODE = 'P0001'; END IF;
  DELETE FROM settlement_plan WHERE voucher_id = p_id; -- đối trừ: chứng từ đã hủy không giữ kế hoạch đối trừ
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'cancelled' WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_audit_voucher(v.tenant_id, 'discard', p_id, jsonb_build_object('voucher_no', v.voucher_no));
END $function$;

-- Tài khoản chi phí lương theo bộ phận (Quy ước 6, D2): kind payroll = lương (gross), insurance = BH và KPCĐ phần doanh nghiệp (thiếu thì dùng dòng payroll).
-- Tài khoản ghi bằng vai trò bộ phận (role: tài khoản theo chế độ của năm ở coa-data/payroll/accounts.json khóa cost) HOẶC mã tài khoản cụ thể;
-- mã là chữ (không khóa ngoại tới account: một công ty giữ nhiều hệ tài khoản), kiểm tồn tại và là tài khoản lá lúc hạch toán.
-- Khoản mục chi phí và đối tượng tập hợp chi phí (tùy chọn) đi theo dòng chi phí của bộ phận.
CREATE TABLE department_cost_account (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  department_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('payroll', 'insurance')),
  role text CHECK (role IN ('direct', 'workshop', 'selling', 'admin')),
  account_code text CHECK (account_code ~ '^[0-9]{3,10}$'),
  cost_item_id bigint,
  cost_object_id bigint,
  CHECK (num_nonnulls(role, account_code) = 1),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, department_id, kind),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, cost_item_id) REFERENCES cost_item (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_object_id) REFERENCES cost_object (tenant_id, id));
SELECT rls_enable('department_cost_account');
SELECT audit_enable('department_cost_account');

-- Liên kết bảng lương ↔ chứng từ LU (Review Focus 6): LU bị đảo, bỏ ghi sổ, hủy (mọi đường đổi trạng thái, kể cả ngoài payroll/post.ts) thì gỡ voucher_id;
-- LU bị xóa thì khóa ngoại SET NULL. Mất chứng từ thì bảng lương "đã hạch toán" về "đã tính" (mở lại chấm công, tính lại).
CREATE FUNCTION fn_payroll_run_unlinked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.voucher_id IS NULL AND NEW.status = 'posted' THEN NEW.status := 'calculated'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payroll_run_unlinked BEFORE UPDATE OF voucher_id ON payroll_run FOR EACH ROW EXECUTE FUNCTION fn_payroll_run_unlinked();
-- Trạng thái đổi trong trigger BEFORE (và qua khóa ngoại SET NULL) không làm trigger "UPDATE OF status" chạy: chép trạng thái xuống dòng (0098) theo mọi UPDATE.
DROP TRIGGER trg_payroll_run_sync ON payroll_run;
CREATE TRIGGER trg_payroll_run_sync AFTER UPDATE ON payroll_run FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.year <> NEW.year OR OLD.month <> NEW.month OR OLD.kind <> NEW.kind) EXECUTE FUNCTION fn_payroll_run_sync();

CREATE FUNCTION fn_payroll_voucher_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE payroll_run SET voucher_id = NULL, updated_at = now() WHERE tenant_id = NEW.tenant_id AND voucher_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_payroll_voucher_state AFTER UPDATE OF state ON voucher FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('draft', 'cancelled', 'reversed') AND NEW.voucher_type = 'LU') EXECUTE FUNCTION fn_payroll_voucher_state();
