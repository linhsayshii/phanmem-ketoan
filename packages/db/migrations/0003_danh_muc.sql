CREATE TABLE party_group (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE party (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL,
  is_customer boolean NOT NULL DEFAULT false, is_vendor boolean NOT NULL DEFAULT false, is_employee boolean NOT NULL DEFAULT false,
  group_id uuid REFERENCES party_group(id),
  tax_code text, id_number text, id_issue_date date, id_issue_place text,
  address text, invoice_address text, contact_name text, phone text, email text,
  payment_term_days int, credit_limit numeric(20,0),
  default_account_code text, note text, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, code));
CREATE INDEX ON party (tenant_id, tax_code);
CREATE TABLE party_bank_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  bank_name text NOT NULL, account_no text NOT NULL, account_name text, branch text, UNIQUE (tenant_id, party_id, account_no));
CREATE TABLE department (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, parent_id bigint REFERENCES department(id), is_branch boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE employee (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, department_id bigint REFERENCES department(id), party_id uuid REFERENCES party(id),
  tax_code text, id_number text, position text, phone text, email text, is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE currency (
  tenant_id uuid NOT NULL REFERENCES tenant(id), code char(3) NOT NULL, name text NOT NULL, symbol text, minor_unit int NOT NULL DEFAULT 2,
  is_active boolean NOT NULL DEFAULT true, PRIMARY KEY (tenant_id, code));
CREATE TABLE exchange_rate (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  currency_code char(3) NOT NULL, rate_date date NOT NULL,
  rate_type text NOT NULL CHECK (rate_type IN ('transfer_avg','buy','sell')), rate numeric(20,10) NOT NULL CHECK (rate > 0),
  UNIQUE (tenant_id, currency_code, rate_date, rate_type),
  FOREIGN KEY (tenant_id, currency_code) REFERENCES currency(tenant_id, code));
CREATE TABLE bank (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, short_name text, is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE bank_account (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  bank_id bigint NOT NULL REFERENCES bank(id), account_no text NOT NULL, account_name text, branch text,
  currency_code char(3) NOT NULL DEFAULT 'VND', gl_account_code text NOT NULL, is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, account_no));
CREATE TABLE payment_method (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE tax_code (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, kind text NOT NULL CHECK (kind IN ('vat','import','excise')),
  rate numeric(5,2), is_exempt boolean NOT NULL DEFAULT false, in_declaration boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE invoice_group (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  scope text NOT NULL CHECK (scope IN ('purchase','sale')), code text NOT NULL, name text NOT NULL, rate numeric(5,2),
  is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, scope, code));
CREATE TABLE cost_item (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, parent_id bigint REFERENCES cost_item(id), default_account_code text,
  is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE project (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, parent_id bigint REFERENCES project(id), party_id uuid REFERENCES party(id),
  date_from date, date_to date, budget numeric(20,0), is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE uom (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));

SELECT rls_enable(t), audit_enable(t) FROM unnest(ARRAY['party_group','party','party_bank_account','department','employee','currency','exchange_rate',
  'bank','bank_account','payment_method','tax_code','invoice_group','cost_item','project','uom']::regclass[]) AS t;

-- Dữ liệu mặc định cho công ty mới
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
END $$;

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
      AND p.code NOT LIKE '%.unpost' AND p.code NOT IN ('voucher.edit_posted','voucher.backdate_locked','voucher.renumber','export.authority','backup.run','setting.update','company.update');
  INSERT INTO role_permission(tenant_id, role_id, permission_code)
    SELECT v_tenant, r.id, p.code FROM role r CROSS JOIN permission p
    WHERE r.tenant_id = v_tenant AND r.code = 'xem' AND (p.code LIKE '%.view' OR p.code LIKE '%.print');
  INSERT INTO tenant_user(tenant_id, user_id, role_id, sensitive_flags)
    VALUES (v_tenant, p_owner_user, v_admin_role, '["view_cost","view_receivable","view_payable","view_salary"]');
  PERFORM seed_tenant_defaults(v_tenant);
  RETURN v_tenant;
END $$;
