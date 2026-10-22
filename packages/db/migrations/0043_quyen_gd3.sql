-- GĐ3: quyền mới (vật tư, kho, bảng giá, phiếu kho, tính giá vốn, báo giá/đơn hàng, kiểm kê kho) cấp cho vai trò hệ thống của công ty đã có và công ty tạo mới.
-- Migration chạy trước syncReferenceData ở lần đầu nên tự chèn mã quyền (cùng tên/nhóm với PERMISSIONS ở packages/domain; syncReferenceData ghi đè khi lệch).
INSERT INTO permission(code, name, group_name) VALUES
  ('item.view', 'Xem vật tư hàng hóa', 'Kho'), ('item.create', 'Thêm vật tư hàng hóa', 'Kho'), ('item.update', 'Sửa vật tư hàng hóa', 'Kho'), ('item.delete', 'Xóa vật tư hàng hóa', 'Kho'),
  ('warehouse.view', 'Xem kho', 'Kho'), ('warehouse.create', 'Thêm kho', 'Kho'), ('warehouse.update', 'Sửa kho', 'Kho'), ('warehouse.delete', 'Xóa kho', 'Kho'),
  ('price_list.view', 'Xem bảng giá', 'Kho'), ('price_list.create', 'Thêm bảng giá', 'Kho'), ('price_list.update', 'Sửa bảng giá', 'Kho'), ('price_list.delete', 'Xóa bảng giá', 'Kho'),
  ('stock_voucher.view', 'Xem phiếu kho', 'Kho'), ('stock_voucher.create', 'Thêm phiếu kho', 'Kho'), ('stock_voucher.update', 'Sửa phiếu kho', 'Kho'), ('stock_voucher.delete', 'Xóa phiếu kho', 'Kho'), ('stock_voucher.post', 'Ghi sổ phiếu kho', 'Kho'),
  ('costing.run', 'Chạy tính giá vốn', 'Kho'), ('costing.view', 'Xem tính giá vốn', 'Kho'),
  ('order.view', 'Xem báo giá, đơn hàng, hợp đồng', 'Bán hàng'), ('order.create', 'Thêm báo giá, đơn hàng, hợp đồng', 'Bán hàng'), ('order.update', 'Sửa báo giá, đơn hàng, hợp đồng', 'Bán hàng'), ('order.delete', 'Xóa báo giá, đơn hàng, hợp đồng', 'Bán hàng'),
  ('stocktake.view', 'Xem kiểm kê kho', 'Kho'), ('stocktake.create', 'Thêm kiểm kê kho', 'Kho'), ('stocktake.update', 'Sửa kiểm kê kho', 'Kho'), ('stocktake.delete', 'Xóa kiểm kê kho', 'Kho')
ON CONFLICT (code) DO NOTHING;

-- Định nghĩa lại create_tenant từ thân 0024; ketoan_vien không có thêm costing.run. Quyền EXECUTE giữ nguyên.
CREATE OR REPLACE FUNCTION create_tenant(p_code text, p_name text, p_tax_code text, p_owner_user uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid; v_admin_role uuid; v_prev text;
BEGIN
  v_prev := current_setting('app.current_tenant', true);
  INSERT INTO tenant(code, name, tax_code) VALUES (p_code, p_name, p_tax_code) RETURNING id INTO v_tenant;
  PERFORM set_config('app.current_tenant', v_tenant::text, true);
  INSERT INTO role(tenant_id, code, name, is_system) VALUES
    (v_tenant, 'admin', 'Quản trị', true), (v_tenant, 'ketoan_truong', 'Kế toán trưởng', true),
    (v_tenant, 'ketoan_vien', 'Kế toán viên', true), (v_tenant, 'xem', 'Chỉ xem', true);
  SELECT id INTO v_admin_role FROM role WHERE tenant_id = v_tenant AND code = 'admin';
  INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT v_tenant, v_admin_role, code FROM permission;
  INSERT INTO role_permission(tenant_id, role_id, permission_code)
    SELECT v_tenant, r.id, p.code FROM role r CROSS JOIN permission p
    WHERE r.tenant_id = v_tenant AND r.code = 'ketoan_truong' AND p.code NOT LIKE 'user.%' AND p.code NOT LIKE 'role.%';
  INSERT INTO role_permission(tenant_id, role_id, permission_code)
    SELECT v_tenant, r.id, p.code FROM role r CROSS JOIN permission p
    WHERE r.tenant_id = v_tenant AND r.code = 'ketoan_vien'
      AND p.code NOT LIKE 'user.%' AND p.code NOT LIKE 'role.%' AND p.code NOT LIKE 'period.%'
      AND p.code NOT LIKE '%.unpost' AND p.code NOT IN ('voucher.edit_posted','voucher.backdate_locked','voucher.renumber','export.authority','backup.run','setting.update','company.update','data_check.manage',
        'closing.run','closing_step.create','closing_step.update','closing_step.delete','report_def.create','report_def.update','report_def.delete','opening_balance.create','opening_balance.update','opening_balance.delete',
        'fx.run','tax_return.finalize','tax.offset','amortization.run','dedupe.run','costing.run');
  INSERT INTO role_permission(tenant_id, role_id, permission_code)
    SELECT v_tenant, r.id, p.code FROM role r CROSS JOIN permission p
    WHERE r.tenant_id = v_tenant AND r.code = 'xem' AND (p.code LIKE '%.view' OR p.code LIKE '%.print');
  INSERT INTO tenant_user(tenant_id, user_id, role_id, sensitive_flags)
    VALUES (v_tenant, p_owner_user, v_admin_role, '["view_cost","view_receivable","view_payable","view_salary"]');
  PERFORM seed_tenant_defaults(v_tenant);
  -- Trả lại biến phiên của người gọi để giao dịch gọi tiếp không bị đổi công ty ngầm.
  PERFORM set_config('app.current_tenant', coalesce(v_prev, ''), true);
  RETURN v_tenant;
END $$;

-- Công ty đã có: admin và kế toán trưởng nhận mọi quyền mới; kế toán viên trừ costing.run; xem chỉ các quyền .view. Tắt audit như 0024. stock_negative mặc định 'forbid' do SETTINGS (zod) cấp, không cần dòng tenant_setting.
ALTER TABLE role_permission DISABLE TRIGGER trg_audit;
INSERT INTO role_permission(tenant_id, role_id, permission_code)
  SELECT r.tenant_id, r.id, np.code
  FROM role r CROSS JOIN (SELECT code FROM permission WHERE code IN (
      'item.view','item.create','item.update','item.delete','warehouse.view','warehouse.create','warehouse.update','warehouse.delete',
      'price_list.view','price_list.create','price_list.update','price_list.delete','stock_voucher.view','stock_voucher.create','stock_voucher.update','stock_voucher.delete','stock_voucher.post',
      'costing.run','costing.view','order.view','order.create','order.update','order.delete','stocktake.view','stocktake.create','stocktake.update','stocktake.delete')) AS np
  WHERE r.code IN ('admin', 'ketoan_truong')
     OR (r.code = 'ketoan_vien' AND np.code <> 'costing.run')
     OR (r.code = 'xem' AND np.code LIKE '%.view')
  ON CONFLICT DO NOTHING;
ALTER TABLE role_permission ENABLE TRIGGER trg_audit;
