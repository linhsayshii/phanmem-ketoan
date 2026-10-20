-- GĐ2: quyền mới (công nợ, quỹ, thuế, tiện ích, cuối kỳ) cấp cho vai trò hệ thống của công ty đã có và công ty tạo mới; hàng đợi kiểm cân bằng chỉ kiểm chứng từ của đúng công ty.
-- Migration chạy trước syncReferenceData ở lần đầu nên tự chèn mã quyền (cùng tên/nhóm với PERMISSIONS ở packages/domain; syncReferenceData ghi đè khi lệch).
INSERT INTO permission(code, name, group_name) VALUES
  ('settlement.view', 'Xem đối trừ công nợ', 'Công nợ'), ('settlement.create', 'Thêm đối trừ công nợ', 'Công nợ'), ('settlement.delete', 'Xóa đối trừ công nợ', 'Công nợ'),
  ('fx.run', 'Chạy tỷ giá xuất quỹ, đánh giá lại ngoại tệ', 'Công nợ'),
  ('cash_count.view', 'Xem kiểm kê quỹ', 'Quỹ'), ('cash_count.create', 'Thêm kiểm kê quỹ', 'Quỹ'), ('cash_count.update', 'Sửa kiểm kê quỹ', 'Quỹ'), ('cash_count.delete', 'Xóa kiểm kê quỹ', 'Quỹ'),
  ('tax.view', 'Xem sổ và bảng kê thuế', 'Thuế'),
  ('tax_return.view', 'Xem tờ khai thuế', 'Thuế'), ('tax_return.create', 'Thêm tờ khai thuế', 'Thuế'), ('tax_return.update', 'Sửa tờ khai thuế', 'Thuế'), ('tax_return.delete', 'Xóa tờ khai thuế', 'Thuế'), ('tax_return.finalize', 'Chốt tờ khai thuế', 'Thuế'),
  ('tax.offset', 'Khấu trừ thuế GTGT cuối kỳ', 'Thuế'),
  ('voucher.import', 'Nhập chứng từ từ Excel', 'Chứng từ'),
  ('dedupe.run', 'Khử trùng chứng từ', 'Tiện ích'),
  ('amortization.view', 'Xem lịch phân bổ', 'Cuối kỳ'), ('amortization.create', 'Thêm lịch phân bổ', 'Cuối kỳ'), ('amortization.update', 'Sửa lịch phân bổ', 'Cuối kỳ'), ('amortization.delete', 'Xóa lịch phân bổ', 'Cuối kỳ'), ('amortization.run', 'Chạy lịch phân bổ', 'Cuối kỳ')
ON CONFLICT (code) DO NOTHING;

-- Định nghĩa lại create_tenant từ thân 0018; ketoan_vien không có thêm fx.run, tax_return.finalize, tax.offset, amortization.run, dedupe.run. Quyền EXECUTE giữ nguyên.
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
        'fx.run','tax_return.finalize','tax.offset','amortization.run','dedupe.run');
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

-- Công ty đã có: chèn quyền mới theo cùng quy tắc (admin và kế toán trưởng: mọi quyền mới; kế toán viên: trừ danh sách loại trừ; xem: các quyền .view mới).
-- Tắt audit để migration không ghi nhật ký không có người dùng (như 0014, 0018). ON CONFLICT DO NOTHING: chạy lại không lỗi.
ALTER TABLE role_permission DISABLE TRIGGER trg_audit;
INSERT INTO role_permission(tenant_id, role_id, permission_code)
  SELECT r.tenant_id, r.id, np.code
  FROM role r CROSS JOIN (VALUES ('settlement.view'),('settlement.create'),('settlement.delete'),('fx.run'),('cash_count.view'),('cash_count.create'),('cash_count.update'),('cash_count.delete'),
      ('tax.view'),('tax_return.view'),('tax_return.create'),('tax_return.update'),('tax_return.delete'),('tax_return.finalize'),('tax.offset'),('voucher.import'),('dedupe.run'),
      ('amortization.view'),('amortization.create'),('amortization.update'),('amortization.delete'),('amortization.run')) AS np(code)
  WHERE r.code IN ('admin', 'ketoan_truong')
     OR (r.code = 'ketoan_vien' AND np.code NOT IN ('fx.run','tax_return.finalize','tax.offset','amortization.run','dedupe.run'))
     OR (r.code = 'xem' AND np.code LIKE '%.view')
  ON CONFLICT DO NOTHING;
ALTER TABLE role_permission ENABLE TRIGGER trg_audit;

-- Hàng đợi kiểm cân bằng (thân 0022): chỉ kiểm chứng từ có voucher.tenant_id bằng tenant_id của dòng hàng đợi; chứng từ của công ty khác bị bỏ qua và dòng hàng đợi vẫn được dọn,
-- để thông báo lỗi không lộ tổng Nợ/Có của công ty khác (hàm chạy SECURITY DEFINER nên đọc được mọi công ty).
CREATE OR REPLACE FUNCTION fn_trg_balance_pending() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM voucher WHERE id = NEW.voucher_id AND tenant_id = NEW.tenant_id) THEN
    PERFORM fn_check_voucher_balance(NEW.voucher_id);
  END IF;
  DELETE FROM voucher_balance_pending WHERE tenant_id = NEW.tenant_id AND voucher_id = NEW.voucher_id;
  RETURN NULL;
END $$;
