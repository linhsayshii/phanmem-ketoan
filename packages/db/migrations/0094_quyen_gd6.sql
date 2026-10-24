-- GĐ6 Task 1: quyền lương, chấm công, giá thành, theo dõi hợp đồng; bảng tham số lương theo công ty.
INSERT INTO permission(code, name, group_name) VALUES
  ('payroll.view', 'Xem bảng lương', 'Lương'),
  ('payroll.create', 'Thêm bảng lương', 'Lương'),
  ('payroll.update', 'Sửa bảng lương', 'Lương'),
  ('payroll.delete', 'Xóa bảng lương', 'Lương'),
  ('payroll.post', 'Hạch toán bảng lương', 'Lương'),
  ('payroll.param', 'Nhập tham số lương, thuế, bảo hiểm cho bảng lương', 'Lương'),
  ('payroll.pay', 'Chi lương, nộp bảo hiểm, nộp thuế cho bảng lương', 'Lương'),
  ('payroll.export', 'Xuất tệp chi lương, báo cáo lương cho bảng lương', 'Lương'),
  ('attendance.view', 'Xem bảng chấm công', 'Lương'),
  ('attendance.create', 'Thêm bảng chấm công', 'Lương'),
  ('attendance.update', 'Sửa bảng chấm công', 'Lương'),
  ('attendance.delete', 'Xóa bảng chấm công', 'Lương'),
  ('costing_obj.view', 'Xem đối tượng tập hợp chi phí, định mức', 'Giá thành'),
  ('costing_obj.create', 'Thêm đối tượng tập hợp chi phí, định mức', 'Giá thành'),
  ('costing_obj.update', 'Sửa đối tượng tập hợp chi phí, định mức', 'Giá thành'),
  ('costing_obj.delete', 'Xóa đối tượng tập hợp chi phí, định mức', 'Giá thành'),
  ('cost_run.view', 'Xem kỳ tính giá thành', 'Giá thành'),
  ('cost_run.run', 'Chạy tính giá thành', 'Giá thành'),
  ('contract_track.view', 'Xem theo dõi hợp đồng, lãi lỗ vụ việc', 'Hợp đồng'),
  ('contract_track.run', 'Chạy phân bổ chi phí theo vụ việc, chuyển số dư vụ việc', 'Hợp đồng')
ON CONFLICT (code) DO NOTHING;

-- create_tenant từ thân hiện hành (0078); ketoan_vien thêm trừ payroll.post, payroll.param, payroll.export.
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
        'payroll.post','payroll.param','payroll.export');
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
  FROM role r CROSS JOIN (SELECT code FROM permission WHERE code IN ('payroll.view','payroll.create','payroll.update','payroll.delete','payroll.post','payroll.param','payroll.pay','payroll.export','attendance.view','attendance.create','attendance.update','attendance.delete','costing_obj.view','costing_obj.create','costing_obj.update','costing_obj.delete','cost_run.view','cost_run.run','contract_track.view','contract_track.run')) AS np
  WHERE r.code IN ('admin', 'ketoan_truong')
     OR (r.code = 'ketoan_vien' AND np.code NOT IN ('payroll.post', 'payroll.param', 'payroll.export'))
     OR (r.code = 'xem' AND np.code LIKE '%.view')
  ON CONFLICT DO NOTHING;
ALTER TABLE role_permission ENABLE TRIGGER trg_audit;

-- Tham số lương/thuế/bảo hiểm do công ty nhập kèm nguồn văn bản; không có giá trị pháp lý mặc định. Khoảng hiệu lực cùng mã không chồng nhau (API kiểm).
CREATE TABLE payroll_param (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL CHECK (code ~ '^[a-z0-9_]+$'),
  valid_from date NOT NULL,
  valid_to date,
  value jsonb NOT NULL,
  source text NOT NULL CHECK (length(btrim(source)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code, valid_from),
  CHECK (valid_to IS NULL OR valid_to >= valid_from));
SELECT rls_enable('payroll_param');
SELECT audit_enable('payroll_param');
