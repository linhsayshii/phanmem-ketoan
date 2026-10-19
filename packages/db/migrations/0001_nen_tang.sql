-- 0001_nen_tang.sql: biến phiên, RLS, audit, bảng nền. Chạy bằng owner (postgres).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

GRANT USAGE ON SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app_user;

CREATE OR REPLACE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.current_tenant', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.current_user', true), '')::uuid $$;

-- Bật RLS chuẩn cho một bảng có cột tenant_id.
CREATE OR REPLACE FUNCTION rls_enable(t regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
END $$;

-- ===== Bảng toàn cục (không tenant) =====
CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  full_name text NOT NULL,
  password_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE permission (code text PRIMARY KEY, name text NOT NULL, group_name text NOT NULL);
REVOKE INSERT, UPDATE, DELETE ON permission FROM app_user;

CREATE TABLE legal_param (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL, value jsonb NOT NULL,
  valid_from date NOT NULL, valid_to date,
  source text NOT NULL,
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX ON legal_param (code, valid_from);
REVOKE INSERT, UPDATE, DELETE ON legal_param FROM app_user;

CREATE TABLE coa_template (
  regime text NOT NULL CHECK (regime IN ('TT99','TT133','TT200','TT58')),
  code text NOT NULL, name text NOT NULL, name_en text,
  parent_code text, is_group boolean NOT NULL DEFAULT false,
  root_type text NOT NULL CHECK (root_type IN ('asset','liability','equity','income','expense','off_balance')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit','credit','both')),
  track_currency boolean NOT NULL DEFAULT false,
  subledger_kind text CHECK (subledger_kind IN ('receivable','payable','inventory','fixed_asset','bank','cash')),
  source text NOT NULL,
  PRIMARY KEY (regime, code)
);
REVOKE INSERT, UPDATE, DELETE ON coa_template FROM app_user;

CREATE TABLE user_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id),
  tenant_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ip text
);
CREATE INDEX ON user_session (user_id);
CREATE TABLE login_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  username text NOT NULL, user_id uuid, success boolean NOT NULL, ip text
);
REVOKE UPDATE, DELETE ON login_event FROM app_user;

-- ===== Bảng theo tenant =====
CREATE TABLE tenant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  tax_code text, address text, legal_rep text, chief_accountant text, phone text, email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, is_system boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE TABLE role_permission (
  tenant_id uuid NOT NULL, role_id uuid NOT NULL,
  permission_code text NOT NULL REFERENCES permission(code),
  PRIMARY KEY (tenant_id, role_id, permission_code),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE tenant_user (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  role_id uuid NOT NULL,
  sensitive_flags jsonb NOT NULL DEFAULT '[]',
  is_active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id)
);
CREATE TABLE audit_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  ts timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  action text NOT NULL,        -- 'insert'|'update'|'delete'|'post'|'unpost'|'reverse'|'discard'|'lock'|'unlock'|'login'...
  entity text NOT NULL, entity_id text NOT NULL,
  before jsonb, after jsonb, ip text
);
CREATE INDEX ON audit_event (tenant_id, ts DESC);
CREATE INDEX ON audit_event (tenant_id, entity, entity_id);
REVOKE UPDATE, DELETE ON audit_event FROM app_user;

CREATE TABLE fiscal_period (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  fiscal_year int NOT NULL, period_no int NOT NULL CHECK (period_no BETWEEN 0 AND 15),  -- 0 = kỳ mở sổ
  date_from date NOT NULL, date_to date NOT NULL CHECK (date_to >= date_from),
  regime text NOT NULL CHECK (regime IN ('TT99','TT133','TT200','TT58')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','soft_locked','hard_locked')),
  UNIQUE (tenant_id, fiscal_year, period_no)
);
CREATE INDEX ON fiscal_period (tenant_id, date_from, date_to);

CREATE TABLE account (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  regime text NOT NULL,
  code text NOT NULL, name text NOT NULL, name_en text,
  parent_id bigint,
  is_group boolean NOT NULL DEFAULT false,
  root_type text NOT NULL CHECK (root_type IN ('asset','liability','equity','income','expense','off_balance')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit','credit','both')),
  track_currency boolean NOT NULL DEFAULT false,
  subledger_kind text CHECK (subledger_kind IN ('receivable','payable','inventory','fixed_asset','bank','cash')),
  reconcile boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, regime, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES account (tenant_id, id)
);
CREATE INDEX ON account (tenant_id, parent_id);

CREATE TABLE tenant_setting (
  tenant_id uuid NOT NULL REFERENCES tenant(id), key text NOT NULL, value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
CREATE TABLE user_pref (
  user_id uuid NOT NULL REFERENCES app_user(id), tenant_id uuid NOT NULL, key text NOT NULL, value jsonb NOT NULL,
  PRIMARY KEY (user_id, tenant_id, key)
);

-- ===== Audit trigger dùng chung =====
CREATE OR REPLACE FUNCTION fn_audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_tenant uuid; v_id text; v_before jsonb; v_after jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN v_before := to_jsonb(OLD); v_tenant := OLD.tenant_id; v_id := (to_jsonb(OLD)->>'id');
  ELSIF TG_OP = 'INSERT' THEN v_after := to_jsonb(NEW); v_tenant := NEW.tenant_id; v_id := (to_jsonb(NEW)->>'id');
  ELSE v_before := to_jsonb(OLD); v_after := to_jsonb(NEW); v_tenant := NEW.tenant_id; v_id := (to_jsonb(NEW)->>'id');
    IF v_before = v_after THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, after, ip)
  VALUES (v_tenant, app_user_id(), lower(TG_OP), TG_TABLE_NAME, coalesce(v_id, ''), v_before, v_after,
          nullif(current_setting('app.client_ip', true), ''));
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION audit_enable(t regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON %s', t);
  EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION fn_audit_row()', t);
END $$;

-- ===== RLS =====
SELECT rls_enable(t) FROM unnest(ARRAY['role','role_permission','audit_event','fiscal_period','account','tenant_setting','user_pref']::regclass[]) AS t;

ALTER TABLE tenant ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenant FOR SELECT USING (id = app_tenant() OR EXISTS (
  SELECT 1 FROM tenant_user tu WHERE tu.tenant_id = tenant.id AND tu.user_id = app_user_id()));
CREATE POLICY tenant_self_update ON tenant FOR UPDATE USING (id = app_tenant()) WITH CHECK (id = app_tenant());

ALTER TABLE tenant_user ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_user FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_user_access ON tenant_user USING (tenant_id = app_tenant() OR user_id = app_user_id())
  WITH CHECK (tenant_id = app_tenant());

ALTER TABLE user_session ENABLE ROW LEVEL SECURITY; ALTER TABLE user_session FORCE ROW LEVEL SECURITY;
CREATE POLICY session_all ON user_session USING (true) WITH CHECK (true);  -- tra cứu theo id phiên trước khi biết user

SELECT audit_enable(t) FROM unnest(ARRAY['role','role_permission','tenant_user','account','tenant_setting']::regclass[]) AS t;

-- ===== Tạo công ty: SECURITY DEFINER vì chưa có app.current_tenant lúc tạo =====
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
  RETURN v_tenant;
END $$;
REVOKE ALL ON FUNCTION create_tenant(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_tenant(text, text, text, uuid) TO app_user;
