-- A6 + A8: RLS tenant_user tách đọc/ghi, create_tenant trả biến phiên, thu hẹp vai trò ketoan_vien.
DROP POLICY tenant_user_access ON tenant_user;
-- Đọc thấy cả dòng của chính mình ở công ty khác (liệt kê công ty); ghi chỉ trong công ty đang chọn.
CREATE POLICY tenant_user_select ON tenant_user FOR SELECT USING (tenant_id = app_tenant() OR user_id = app_user_id());
CREATE POLICY tenant_user_insert ON tenant_user FOR INSERT WITH CHECK (tenant_id = app_tenant());
CREATE POLICY tenant_user_update ON tenant_user FOR UPDATE USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE POLICY tenant_user_delete ON tenant_user FOR DELETE USING (tenant_id = app_tenant());

-- Định nghĩa lại create_tenant từ thân 0014: lưu/khôi phục app.current_tenant; ketoan_vien không còn kết chuyển, sơ đồ kết chuyển, định nghĩa báo cáo, số dư đầu kỳ (chỉ .view). Quyền EXECUTE giữ nguyên.
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
        'closing.run','closing_step.create','closing_step.update','closing_step.delete','report_def.create','report_def.update','report_def.delete','opening_balance.create','opening_balance.update','opening_balance.delete');
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

-- Công ty đã có: gỡ các quyền trên khỏi ketoan_vien. Tắt audit để migration không ghi nhật ký không có người dùng (như 0014).
ALTER TABLE role_permission DISABLE TRIGGER trg_audit;
DELETE FROM role_permission rp USING role r
  WHERE r.tenant_id = rp.tenant_id AND r.id = rp.role_id AND r.code = 'ketoan_vien'
    AND rp.permission_code IN ('closing.run','closing_step.create','closing_step.update','closing_step.delete','report_def.create','report_def.update','report_def.delete','opening_balance.create','opening_balance.update','opening_balance.delete');
ALTER TABLE role_permission ENABLE TRIGGER trg_audit;

CREATE FUNCTION user_tenant_count(p_user uuid) RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS
  $$ SELECT count(*)::int FROM tenant_user WHERE user_id = p_user AND is_active $$;
GRANT EXECUTE ON FUNCTION user_tenant_count(uuid) TO app_user;
