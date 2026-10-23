-- GĐ5 Task 10: ký số XML (XML-DSig/XAdES): hồ sơ ký của người dùng và phiên ký.
-- Hồ sơ/phiên là của riêng từng người dùng: API lọc theo user_id (RLS chỉ giữ ranh giới công ty).
CREATE TABLE signing_profile (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  kind text NOT NULL CHECK (kind IN ('local_agent', 'smartca', 'fake')),
  label text NOT NULL,
  cert_der bytea NOT NULL,
  cert_subject text NOT NULL,
  cert_serial text NOT NULL,
  cert_not_after timestamptz NOT NULL,
  credentials bytea,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, user_id, cert_serial));
CREATE UNIQUE INDEX signing_profile_default ON signing_profile (tenant_id, user_id) WHERE is_default;

CREATE TABLE signing_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  profile_id bigint NOT NULL,
  doc_kind text NOT NULL CHECK (doc_kind IN ('vat_return', 'cit_return', 'error_notice')),
  doc_ref text NOT NULL,
  xml_unsigned text NOT NULL,
  signing_time text NOT NULL,
  signed_info_c14n text NOT NULL,
  digest_b64 text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'failed', 'expired')),
  provider_ref text,
  error_message text,
  signed_xml text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((status = 'signed') = (signed_xml IS NOT NULL)),
  FOREIGN KEY (tenant_id, profile_id) REFERENCES signing_profile (tenant_id, id));
CREATE INDEX signing_session_doc ON signing_session (tenant_id, user_id, doc_kind, doc_ref);

SELECT rls_enable(t) FROM unnest(ARRAY['signing_profile', 'signing_session']::regclass[]) AS t;
-- Chỉ hồ sơ ghi audit_event (cột credentials thay bằng "***", cert_der là dữ liệu công khai nhưng dài: không cần lưu); phiên mang cả XML tờ khai nên không ghi audit.
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON signing_profile FOR EACH ROW EXECUTE FUNCTION fn_audit_row('credentials', 'cert_der');
