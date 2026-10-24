-- GĐ5 Task 13: kết nối ngân hàng (SePay, Casso), hộp thư giao dịch ngân hàng, mẫu cột sao kê.
ALTER TABLE bank_account ADD UNIQUE (tenant_id, id);

-- token_hash: SHA-256 của mã ngẫu nhiên 32 byte trong URL webhook, duy nhất toàn cục (tra trước khi biết công ty).
-- secret: khóa HMAC đã mã hóa (auth_kind = 'hmac'); apikey_hash: SHA-256 của khóa API (auth_kind = 'apikey'). Không lưu rõ.
CREATE TABLE bank_feed (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  bank_account_id bigint NOT NULL,
  provider text NOT NULL CHECK (provider IN ('sepay', 'casso')),
  token_hash text NOT NULL UNIQUE,
  auth_kind text NOT NULL CHECK (auth_kind IN ('hmac', 'apikey')),
  secret bytea,
  apikey_hash text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((auth_kind = 'hmac') = (secret IS NOT NULL) AND (auth_kind = 'apikey') = (apikey_hash IS NOT NULL)),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_account (tenant_id, id));

CREATE TABLE bank_transaction (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  bank_account_id bigint NOT NULL,
  feed_id bigint,
  source text NOT NULL CHECK (source IN ('sepay', 'casso', 'import', 'manual')),
  external_id text NOT NULL,
  txn_time timestamptz,
  value_date date NOT NULL,
  amount_in numeric(20,4) NOT NULL DEFAULT 0 CHECK (amount_in >= 0),
  amount_out numeric(20,4) NOT NULL DEFAULT 0 CHECK (amount_out >= 0),
  balance_after numeric(20,4),
  description text,
  reference text,
  counter_account text,
  counter_name text,
  payment_code text,
  raw jsonb,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'matched', 'ignored')),
  voucher_id uuid,
  matched_by uuid,
  matched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, source, external_id),
  CHECK ((amount_in > 0) <> (amount_out > 0)),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_account (tenant_id, id),
  FOREIGN KEY (tenant_id, feed_id) REFERENCES bank_feed (tenant_id, id) ON DELETE SET NULL (feed_id),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id));
CREATE UNIQUE INDEX bank_transaction_voucher_key ON bank_transaction (tenant_id, voucher_id) WHERE voucher_id IS NOT NULL;
CREATE INDEX bank_transaction_list_idx ON bank_transaction (tenant_id, bank_account_id, status, value_date DESC);

-- Nhật ký mỗi lượt gọi webhook; xác thực sai chỉ giữ SHA-256 của thân, không giữ thân thô.
CREATE TABLE bank_webhook_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  feed_id bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  http_status int NOT NULL,
  error text,
  body_sha256 text,
  FOREIGN KEY (tenant_id, feed_id) REFERENCES bank_feed (tenant_id, id) ON DELETE CASCADE);
CREATE INDEX bank_webhook_log_feed_idx ON bank_webhook_log (tenant_id, feed_id, received_at DESC);

-- Cột theo chữ cái Excel (A..ZZZ). header_row: số thứ tự dòng tiêu đề (dữ liệu từ dòng kế tiếp), 0 = không có tiêu đề.
CREATE TABLE bank_statement_format (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL,
  bank_code text,
  header_row int NOT NULL DEFAULT 1 CHECK (header_row BETWEEN 0 AND 1000),
  sheet_index int NOT NULL DEFAULT 0 CHECK (sheet_index BETWEEN 0 AND 50),
  date_col text NOT NULL CHECK (date_col ~ '^[A-Z]{1,3}$'),
  date_format text NOT NULL CHECK (date_format IN ('dd/MM/yyyy', 'yyyy-MM-dd', 'dd-MM-yyyy', 'excel')),
  description_col text NOT NULL CHECK (description_col ~ '^[A-Z]{1,3}$'),
  amount_in_col text CHECK (amount_in_col ~ '^[A-Z]{1,3}$'),
  amount_out_col text CHECK (amount_out_col ~ '^[A-Z]{1,3}$'),
  signed_amount_col text CHECK (signed_amount_col ~ '^[A-Z]{1,3}$'),
  reference_col text CHECK (reference_col ~ '^[A-Z]{1,3}$'),
  balance_col text CHECK (balance_col ~ '^[A-Z]{1,3}$'),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, name),
  CHECK (signed_amount_col IS NOT NULL OR amount_in_col IS NOT NULL OR amount_out_col IS NOT NULL));

SELECT rls_enable(t) FROM unnest(ARRAY['bank_feed', 'bank_transaction', 'bank_webhook_log', 'bank_statement_format']::regclass[]) AS t;
SELECT audit_enable('bank_transaction'), audit_enable('bank_statement_format');
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON bank_feed FOR EACH ROW EXECUTE FUNCTION fn_audit_row('secret', 'apikey_hash', 'token_hash');

-- Webhook công khai chưa biết công ty: tra theo băm của mã, chỉ trả công ty và kết nối đang bật; phần còn lại đọc dưới RLS.
CREATE FUNCTION fn_bank_feed_by_token(p_hash text) RETURNS TABLE (tenant_id uuid, feed_id bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT f.tenant_id, f.id FROM bank_feed f WHERE f.token_hash = p_hash AND f.is_active $$;
REVOKE ALL ON FUNCTION fn_bank_feed_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_bank_feed_by_token(text) TO app_user;
