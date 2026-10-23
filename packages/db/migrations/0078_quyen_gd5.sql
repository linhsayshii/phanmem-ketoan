-- GĐ5 Task 1: quyền hóa đơn điện tử, hóa đơn đầu vào, ngân hàng, khóa API, thuế TNDN, ký số.
INSERT INTO permission(code, name, group_name) VALUES
  ('einvoice.view', 'Xem hóa đơn điện tử', 'Hóa đơn điện tử'),
  ('einvoice.create', 'Thêm hóa đơn điện tử', 'Hóa đơn điện tử'),
  ('einvoice.update', 'Sửa hóa đơn điện tử', 'Hóa đơn điện tử'),
  ('einvoice.delete', 'Xóa hóa đơn điện tử', 'Hóa đơn điện tử'),
  ('einvoice.issue', 'Phát hành hóa đơn điện tử', 'Hóa đơn điện tử'),
  ('einvoice.config', 'Cấu hình nhà cung cấp, ký hiệu hóa đơn điện tử', 'Hóa đơn điện tử'),
  ('inbound_invoice.view', 'Xem hóa đơn đầu vào', 'Hóa đơn điện tử'),
  ('inbound_invoice.create', 'Thêm hóa đơn đầu vào', 'Hóa đơn điện tử'),
  ('inbound_invoice.update', 'Sửa hóa đơn đầu vào', 'Hóa đơn điện tử'),
  ('inbound_invoice.delete', 'Xóa hóa đơn đầu vào', 'Hóa đơn điện tử'),
  ('bank_feed.view', 'Xem kết nối và giao dịch ngân hàng', 'Ngân hàng'),
  ('bank_feed.create', 'Thêm kết nối và giao dịch ngân hàng', 'Ngân hàng'),
  ('bank_feed.update', 'Sửa kết nối và giao dịch ngân hàng', 'Ngân hàng'),
  ('bank_feed.delete', 'Xóa kết nối và giao dịch ngân hàng', 'Ngân hàng'),
  ('bank_feed.match', 'Đối chiếu kết nối và giao dịch ngân hàng', 'Ngân hàng'),
  ('api_key.manage', 'Quản lý khóa API', 'Hệ thống'),
  ('cit.view', 'Xem thuế TNDN', 'Thuế'),
  ('cit.create', 'Thêm thuế TNDN', 'Thuế'),
  ('cit.update', 'Sửa thuế TNDN', 'Thuế'),
  ('cit.delete', 'Xóa thuế TNDN', 'Thuế'),
  ('signing.use', 'Ký số', 'Hệ thống')
ON CONFLICT (code) DO NOTHING;

-- create_tenant từ thân hiện hành (0069); ketoan_vien thêm trừ einvoice.config, api_key.manage, bank_feed.create|update|delete.
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
        'einvoice.config','api_key.manage','bank_feed.create','bank_feed.update','bank_feed.delete');
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
INSERT INTO role_permission(tenant_id, role_id, permission_code)
  SELECT r.tenant_id, r.id, np.code
  FROM role r CROSS JOIN (SELECT code FROM permission WHERE code IN ('einvoice.view','einvoice.create','einvoice.update','einvoice.delete','einvoice.issue','einvoice.config','inbound_invoice.view','inbound_invoice.create','inbound_invoice.update','inbound_invoice.delete','bank_feed.view','bank_feed.create','bank_feed.update','bank_feed.delete','bank_feed.match','api_key.manage','cit.view','cit.create','cit.update','cit.delete','signing.use')) AS np
  WHERE r.code IN ('admin', 'ketoan_truong')
     OR (r.code = 'ketoan_vien' AND np.code NOT IN ('einvoice.config', 'api_key.manage', 'bank_feed.create', 'bank_feed.update', 'bank_feed.delete'))
     OR (r.code = 'xem' AND np.code LIKE '%.view')
  ON CONFLICT DO NOTHING;
ALTER TABLE role_permission ENABLE TRIGGER trg_audit;
