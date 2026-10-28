-- 0262_hoa_giai_quyen_duyet_ngan_sach.sql: GĐ7 gói 1 — hòa giải quyết định 1107.
-- 0220 cấp budget.approve cho kế toán viên và create_tenant (thân 0094, loại trừ theo danh sách) cũng cấp cho công ty mới: kế toán viên tự lập, tự duyệt ngân sách và tắt cảnh báo/chặn vượt ngân sách.
-- Duyệt ngân sách là quyền của kế toán trưởng và quản trị. create_tenant định nghĩa lại từ thân 0094, thêm budget.approve vào danh sách loại trừ của kế toán viên; công ty đã có thì thu quyền ở vai trò hệ thống.
-- Vai trò tùy chỉnh (is_system = false) không động tới: quản trị công ty đã chủ động cấp.
CREATE OR REPLACE FUNCTION public.create_tenant(p_code text, p_name text, p_tax_code text, p_owner_user uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
        'fx.run','tax_return.finalize','tax.offset','amortization.run','dedupe.run','costing.run','asset.run','loan.run',
        'einvoice.config','api_key.manage','bank_feed.create','bank_feed.update','bank_feed.delete',
        'payroll.post','payroll.param','payroll.export',
        'budget.approve');
  INSERT INTO role_permission(tenant_id, role_id, permission_code)
    SELECT v_tenant, r.id, p.code FROM role r CROSS JOIN permission p
    WHERE r.tenant_id = v_tenant AND r.code = 'xem' AND (p.code LIKE '%.view' OR p.code LIKE '%.print');
  INSERT INTO tenant_user(tenant_id, user_id, role_id, sensitive_flags)
    VALUES (v_tenant, p_owner_user, v_admin_role, '["view_cost","view_receivable","view_payable","view_salary"]');
  PERFORM seed_tenant_defaults(v_tenant);
  -- Trả lại biến phiên của người gọi để giao dịch gọi tiếp không bị đổi công ty ngầm.
  PERFORM set_config('app.current_tenant', coalesce(v_prev, ''), true);
  RETURN v_tenant;
END $function$;

ALTER TABLE role_permission DISABLE TRIGGER trg_audit;
DELETE FROM role_permission rp USING role r
  WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id AND r.code = 'ketoan_vien' AND r.is_system AND rp.permission_code = 'budget.approve';
ALTER TABLE role_permission ENABLE TRIGGER trg_audit;
