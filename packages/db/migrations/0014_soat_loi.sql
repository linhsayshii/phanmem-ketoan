-- 0014_soat_loi.sql: soát lỗi dữ liệu bằng bảng quy tắc. Mỗi quy tắc là một câu SELECT trả (voucher_id uuid, ref text, detail text) với tham số $1 (từ ngày), $2 (đến ngày),
-- API chạy trong giao dịch chỉ đọc dưới RLS. Câu SQL chạy bằng app_user nên KHÔNG ĐƯỢC để người dùng công ty tự viết: quy tắc chỉ đến từ migration và seed_data_check_rules
-- (chủ sở hữu), app_user chỉ bật/tắt hoặc sửa tên, mức, thông điệp, hướng dẫn sửa.
CREATE TABLE data_check_rule (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, severity text NOT NULL CHECK (severity IN ('error','warning')),
  sql text NOT NULL, message text NOT NULL, fix_hint text, is_system boolean NOT NULL DEFAULT false, is_enabled boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code),
  -- Tên, thông điệp, hướng dẫn được sao chép vào từng dòng kết quả: chặn độ dài để người có quyền sửa không làm phình phản hồi (kèm giới hạn ở API).
  CONSTRAINT data_check_rule_text_len CHECK (length(name) <= 200 AND length(message) <= 500 AND (fix_hint IS NULL OR length(fix_hint) <= 500)));
SELECT rls_enable('data_check_rule');
-- Mặc định 0001 cấp đủ SELECT/INSERT/UPDATE/DELETE cho app_user: thu lại, chỉ cấp UPDATE trên các cột không phải SQL.
REVOKE INSERT, UPDATE, DELETE ON data_check_rule FROM app_user;
GRANT UPDATE (name, severity, message, fix_hint, is_enabled) ON data_check_rule TO app_user;

-- Chặn xóa quy tắc hệ thống khi xóa bằng quyền chủ sở hữu (app_user đã không còn quyền DELETE, API tự trả RULE_SYSTEM).
CREATE OR REPLACE FUNCTION fn_rule_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.is_system THEN RAISE EXCEPTION 'RULE_SYSTEM: không xóa được quy tắc hệ thống, chỉ tắt' USING ERRCODE = 'P0001'; END IF; RETURN OLD; END $$;
CREATE TRIGGER trg_rule_protect BEFORE DELETE ON data_check_rule FOR EACH ROW EXECUTE FUNCTION fn_rule_protect();

CREATE OR REPLACE FUNCTION seed_data_check_rules(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO data_check_rule(tenant_id, code, name, severity, sql, message, fix_hint, is_system) VALUES
  (p_tenant, 'CT_KHONG_CAN', 'Chứng từ không cân', 'error',
   $q$SELECT v.id AS voucher_id, v.voucher_no AS ref, 'Nợ ' || sum(l.debit) || ' / Có ' || sum(l.credit) AS detail FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id WHERE v.state <> 'cancelled' AND v.posting_date BETWEEN $1 AND $2 GROUP BY v.id HAVING sum(l.debit) <> sum(l.credit)$q$,
   'Tổng Nợ khác tổng Có', 'Mở chứng từ và cân lại các dòng', true),
  (p_tenant, 'CT_KHONG_CO_DONG', 'Chứng từ không có dòng định khoản', 'warning',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'Ngày ' || to_char(v.posting_date, 'DD/MM/YYYY') FROM voucher v WHERE v.state = 'draft' AND v.posting_date BETWEEN $1 AND $2 AND NOT EXISTS (SELECT 1 FROM voucher_line l WHERE l.voucher_id = v.id)$q$,
   'Chứng từ nháp rỗng', 'Xóa chứng từ hoặc nhập dòng', true),
  -- Chứng từ đã hủy (cancelled) vẫn giữ dòng nhưng không còn sửa được: không báo lỗi trên đó.
  (p_tenant, 'CN_THIEU_DOI_TUONG', 'Dòng công nợ thiếu đối tượng', 'error',
   $q$SELECT v.id, v.voucher_no, 'TK ' || a.code || ' dòng ' || l.line_no FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id WHERE v.state <> 'cancelled' AND a.subledger_kind IN ('receivable','payable') AND l.party_id IS NULL AND l.posting_date BETWEEN $1 AND $2$q$,
   'Tài khoản công nợ phải có đối tượng', 'Bỏ ghi sổ và bổ sung đối tượng', true),
  (p_tenant, 'TK_TONG_HOP_TREN_DONG', 'Tài khoản tổng hợp trên dòng định khoản', 'error',
   $q$SELECT v.id, v.voucher_no, 'TK ' || a.code FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id WHERE v.state <> 'cancelled' AND a.is_group AND l.posting_date BETWEEN $1 AND $2$q$,
   'Chỉ định khoản vào tài khoản chi tiết', 'Chuyển sang tiểu khoản', true),
  -- Gộp theo a.id (không theo mã): một công ty có thể giữ nhiều hệ thống tài khoản cùng mã, hai tài khoản khác nhau không được bù trừ cho nhau. Số tiền báo là số dư ròng.
  (p_tenant, 'SO_DU_SAI_LOAI', 'Số dư trái loại dư của tài khoản', 'warning',
   $q$SELECT NULL::uuid, a.code || CASE WHEN p.code IS NOT NULL THEN ' / ' || p.code ELSE '' END, CASE WHEN a.normal_balance = 'debit' THEN 'Dư Có ' || -sum(b.debit - b.credit) ELSE 'Dư Nợ ' || sum(b.debit - b.credit) END FROM fn_balances_at(app_tenant(), $2) b JOIN account a ON a.id = b.account_id LEFT JOIN party p ON p.id = b.party_id WHERE a.normal_balance IN ('debit','credit') GROUP BY a.id, a.code, a.normal_balance, p.code HAVING (a.normal_balance = 'debit' AND sum(b.debit - b.credit) < 0) OR (a.normal_balance = 'credit' AND sum(b.debit - b.credit) > 0)$q$,
   'Số dư cuối kỳ trái với loại dư', 'Kiểm tra định khoản hoặc đổi loại dư tài khoản (lưỡng tính)', true),
  (p_tenant, 'CHUA_GHI_SO_TRONG_KY_KHOA', 'Chứng từ chưa ghi sổ trong kỳ đã khóa', 'error',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'Kỳ ' || v.period_no || '/' || v.fiscal_year FROM voucher v JOIN fiscal_period fp ON fp.tenant_id = v.tenant_id AND fp.fiscal_year = v.fiscal_year AND fp.period_no = v.period_no WHERE v.state = 'draft' AND fp.status <> 'open' AND v.posting_date BETWEEN $1 AND $2$q$,
   'Kỳ đã khóa nhưng còn chứng từ nháp', 'Ghi sổ (cần quyền ghi lùi) hoặc hủy chứng từ', true)
  ON CONFLICT DO NOTHING;
$$;
-- Chỉ create_tenant (SECURITY DEFINER) và migration gọi; app_user có EXECUTE từ ALTER DEFAULT PRIVILEGES của 0001 nên phải thu riêng (như seed_tenant_defaults).
REVOKE EXECUTE ON FUNCTION seed_data_check_rules(uuid) FROM PUBLIC, app_user;

-- Định nghĩa lại seed_tenant_defaults: nội dung 0004 + dòng PERFORM seed_data_check_rules. CREATE OR REPLACE giữ nguyên quyền đã thu ở 0003.
CREATE OR REPLACE FUNCTION seed_tenant_defaults(p_tenant uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO currency(tenant_id, code, name, symbol, minor_unit) VALUES (p_tenant, 'VND', 'Đồng Việt Nam', '₫', 0), (p_tenant, 'USD', 'Đô la Mỹ', '$', 2);
  INSERT INTO payment_method(tenant_id, code, name) VALUES (p_tenant, 'TM', 'Tiền mặt'), (p_tenant, 'CK', 'Chuyển khoản'), (p_tenant, 'TM/CK', 'Tiền mặt hoặc chuyển khoản');
  INSERT INTO tax_code(tenant_id, code, name, kind, rate, is_exempt, in_declaration) VALUES
    (p_tenant, 'V0', 'Thuế GTGT 0%', 'vat', 0, false, true), (p_tenant, 'V5', 'Thuế GTGT 5%', 'vat', 5, false, true),
    (p_tenant, 'V8', 'Thuế GTGT 8% (giảm theo NQ 204/2025)', 'vat', 8, false, true), (p_tenant, 'V10', 'Thuế GTGT 10%', 'vat', 10, false, true),
    (p_tenant, 'KCT', 'Không chịu thuế GTGT', 'vat', NULL, true, true), (p_tenant, 'KKK', 'Không kê khai, tính nộp thuế GTGT', 'vat', NULL, true, false),
    (p_tenant, 'NK', 'Thuế nhập khẩu', 'import', NULL, false, false), (p_tenant, 'TTDB', 'Thuế tiêu thụ đặc biệt', 'excise', NULL, false, false);
  INSERT INTO invoice_group(tenant_id, scope, code, name, rate) VALUES
    (p_tenant, 'purchase', '01', 'HHDV dùng riêng cho SXKD chịu thuế GTGT đủ điều kiện khấu trừ', NULL),
    (p_tenant, 'purchase', '02', 'HHDV dùng riêng cho SXKD không chịu thuế GTGT', NULL),
    (p_tenant, 'purchase', '03', 'HHDV dùng chung cho SXKD chịu thuế và không chịu thuế', NULL),
    (p_tenant, 'purchase', '04', 'HHDV dùng cho dự án đầu tư', NULL),
    (p_tenant, 'purchase', '05', 'HHDV không đủ điều kiện khấu trừ / không tổng hợp lên tờ khai', NULL),
    (p_tenant, 'sale', '00', 'Bán ra chịu thuế suất 0%', 0), (p_tenant, 'sale', '05', 'Bán ra chịu thuế suất 5%', 5),
    (p_tenant, 'sale', '08', 'Bán ra chịu thuế suất 8%', 8), (p_tenant, 'sale', '10', 'Bán ra chịu thuế suất 10%', 10),
    (p_tenant, 'sale', 'KCT', 'Bán ra không chịu thuế', NULL);
  INSERT INTO uom(tenant_id, code, name) VALUES (p_tenant, 'CAI', 'Cái'), (p_tenant, 'CHIEC', 'Chiếc'), (p_tenant, 'BO', 'Bộ'), (p_tenant, 'GIO', 'Giờ'), (p_tenant, 'THANG', 'Tháng');
  PERFORM seed_voucher_types(p_tenant);
  PERFORM seed_data_check_rules(p_tenant);
END $$;

-- Quyền mới data_check.manage (sửa/bật tắt quy tắc soát lỗi): admin và kế toán trưởng có, kế toán viên và vai trò chỉ xem không có.
-- Dòng permission do syncReferenceData cập nhật tên/nhóm; thêm sẵn ở đây để khóa ngoại của role_permission đúng ngay sau migration.
INSERT INTO permission(code, name, group_name) VALUES ('data_check.manage', 'Quản lý quy tắc soát lỗi', 'Tiện ích') ON CONFLICT (code) DO NOTHING;
-- Định nghĩa lại create_tenant: nội dung 0003 + loại data_check.manage khỏi vai trò ketoan_vien (admin lấy mọi quyền, ketoan_truong lấy mọi quyền trừ user.* và role.*). Quyền EXECUTE giữ nguyên.
CREATE OR REPLACE FUNCTION create_tenant(p_code text, p_name text, p_tax_code text, p_owner_user uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid; v_admin_role uuid;
BEGIN
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
      AND p.code NOT LIKE '%.unpost' AND p.code NOT IN ('voucher.edit_posted','voucher.backdate_locked','voucher.renumber','export.authority','backup.run','setting.update','company.update','data_check.manage');
  INSERT INTO role_permission(tenant_id, role_id, permission_code)
    SELECT v_tenant, r.id, p.code FROM role r CROSS JOIN permission p
    WHERE r.tenant_id = v_tenant AND r.code = 'xem' AND (p.code LIKE '%.view' OR p.code LIKE '%.print');
  INSERT INTO tenant_user(tenant_id, user_id, role_id, sensitive_flags)
    VALUES (v_tenant, p_owner_user, v_admin_role, '["view_cost","view_receivable","view_payable","view_salary"]');
  PERFORM seed_tenant_defaults(v_tenant);
  RETURN v_tenant;
END $$;
-- Công ty đã tạo trước migration này: cấp cho admin và ketoan_truong. Tắt audit khi cấp bù để migration không ghi nhật ký kiểm toán không có người dùng (như 0004).
ALTER TABLE role_permission DISABLE TRIGGER trg_audit;
INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT r.tenant_id, r.id, 'data_check.manage' FROM role r WHERE r.code IN ('admin', 'ketoan_truong') ON CONFLICT DO NOTHING;
ALTER TABLE role_permission ENABLE TRIGGER trg_audit;

-- Công ty đã tạo trước migration này: bổ sung quy tắc.
SELECT seed_data_check_rules(id) FROM tenant;
-- Bật audit sau khi bổ sung, để migration không ghi nhật ký kiểm toán không có người dùng cho công ty cũ.
SELECT audit_enable('data_check_rule');
