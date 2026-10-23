-- GĐ5 Task 2: nhà cung cấp hóa đơn điện tử, dải ký hiệu hóa đơn (TT 91/2026 Phụ lục I).
CREATE TABLE einvoice_provider (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL CHECK (code IN ('fake', 'sinvoice')),
  name text NOT NULL,
  base_url text NOT NULL DEFAULT '',
  username text NOT NULL DEFAULT '',
  secret bytea,
  seller_tax_code text NOT NULL DEFAULT '',
  options jsonb NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id));

CREATE TABLE einvoice_series (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  provider_id bigint NOT NULL,
  form_no text NOT NULL CHECK (form_no ~ '^[1-9]$'),
  serial text NOT NULL CHECK (serial ~ '^[CK][0-9]{2}[TDLMNBGHXF][A-Z]{2}$'),
  year int NOT NULL,
  kind text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'cash_register')),
  provider_template text,
  is_active boolean NOT NULL DEFAULT true,
  note text,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, form_no, serial),
  CHECK ((kind = 'cash_register') = (substr(serial, 4, 1) = 'M')),
  CHECK (year = 2000 + substr(serial, 2, 2)::int),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES einvoice_provider (tenant_id, id));

SELECT rls_enable(t) FROM unnest(ARRAY['einvoice_provider', 'einvoice_series']::regclass[]) AS t;
SELECT audit_enable('einvoice_series');

-- fn_audit_row từ thân hiện hành (0003), thêm: cột liệt kê ở đối số trigger được thay bằng "***" trong before/after.
CREATE OR REPLACE FUNCTION fn_audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_tenant uuid; v_id text; v_before jsonb; v_after jsonb; v_col text; i int;
BEGIN
  IF TG_OP = 'DELETE' THEN v_before := to_jsonb(OLD); v_tenant := OLD.tenant_id; v_id := coalesce(to_jsonb(OLD)->>'id', to_jsonb(OLD)->>'code', '');
  ELSIF TG_OP = 'INSERT' THEN v_after := to_jsonb(NEW); v_tenant := NEW.tenant_id; v_id := coalesce(to_jsonb(NEW)->>'id', to_jsonb(NEW)->>'code', '');
  ELSE v_before := to_jsonb(OLD); v_after := to_jsonb(NEW); v_tenant := NEW.tenant_id; v_id := coalesce(to_jsonb(NEW)->>'id', to_jsonb(NEW)->>'code', '');
    IF v_before = v_after THEN RETURN NEW; END IF;
  END IF;
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    v_col := TG_ARGV[i];
    IF v_before ? v_col AND v_before->v_col <> 'null'::jsonb THEN v_before := jsonb_set(v_before, ARRAY[v_col], '"***"'); END IF;
    IF v_after ? v_col AND v_after->v_col <> 'null'::jsonb THEN v_after := jsonb_set(v_after, ARRAY[v_col], '"***"'); END IF;
  END LOOP;
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, after, ip)
  VALUES (v_tenant, app_user_id(), lower(TG_OP), TG_TABLE_NAME, coalesce(v_id, ''), v_before, v_after,
          nullif(current_setting('app.client_ip', true), ''));
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON einvoice_provider FOR EACH ROW EXECUTE FUNCTION fn_audit_row('secret');
