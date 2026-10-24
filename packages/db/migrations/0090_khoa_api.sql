-- Khóa API cho phần mềm bên ngoài (bán hàng, hóa đơn đầu vào). Chỉ lưu tiền tố và SHA-256 của toàn chuỗi khóa.
CREATE TABLE api_key (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  prefix text NOT NULL CHECK (prefix ~ '^[0-9a-f]{8,16}$'),
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['items.read', 'stock.read', 'sales.write', 'inbound_invoice.write']),
  default_warehouse_id bigint,
  post_sales boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (prefix),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_user (tenant_id, user_id),
  FOREIGN KEY (tenant_id, default_warehouse_id) REFERENCES warehouse (tenant_id, id) ON DELETE SET NULL (default_warehouse_id));
CREATE INDEX api_key_tenant_idx ON api_key (tenant_id, created_at DESC);

SELECT rls_enable('api_key');
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE OF name, scopes, default_warehouse_id, post_sales, expires_at, revoked_at ON api_key FOR EACH ROW EXECUTE FUNCTION fn_audit_row('key_hash');

-- Hóa đơn đầu vào nhận qua API ngoài: khóa ngoại cho cột api_key_id (0085).
ALTER TABLE inbound_invoice ADD FOREIGN KEY (tenant_id, api_key_id) REFERENCES api_key (tenant_id, id) ON DELETE SET NULL (api_key_id);

-- Tra khóa khi chưa biết công ty: theo tiền tố, chỉ trả cột cần để xác thực.
CREATE FUNCTION fn_api_key_lookup(p_prefix text) RETURNS TABLE (id uuid, tenant_id uuid, user_id uuid, key_hash text, scopes text[], revoked_at timestamptz, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.id, k.tenant_id, k.user_id, k.key_hash, k.scopes, k.revoked_at, k.expires_at FROM api_key k WHERE k.prefix = p_prefix $$;
REVOKE ALL ON FUNCTION fn_api_key_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_api_key_lookup(text) TO app_user;

-- Dấu vân tay nội dung đơn bán qua API ngoài (phát hiện gửi lại externalId với thân khác). Không hiện cho người dùng; route chứng từ chung không ghi cột này.
ALTER TABLE voucher ADD COLUMN ext_fingerprint text CHECK (ext_fingerprint ~ '^[0-9a-f]{16,64}$');
