-- GĐ5 Task 11: hóa đơn điện tử đầu vào nhận từ XML (tải lên, API, thư điện tử).
-- Giữ nguyên XML gốc (bản có giá trị pháp lý) cùng dữ liệu đã đọc; chống trùng theo băm SHA-256 và theo (MST người bán, ký hiệu, số).
-- Số tiền NUMERIC(20,4) (tối đa 16 chữ số nguyên, 4 số lẻ, theo quy ước tiền của dự án), số lượng/đơn giá NUMERIC(24,6), tỷ giá NUMERIC(20,10).
-- Số không đọc được hoặc quá cột thì để NULL và đặt blocked; quy đổi VND làm ở bước lập chứng từ.
CREATE TABLE inbound_invoice (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  source text NOT NULL CHECK (source IN ('upload', 'api', 'email')),
  received_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid REFERENCES app_user(id),
  api_key_id uuid, -- khóa ngoại thêm cùng bảng api_key (Task 16)
  xml text NOT NULL,
  xml_sha256 text NOT NULL,
  form_no text NOT NULL,
  serial text NOT NULL,
  invoice_no text NOT NULL,
  issue_date date NOT NULL,
  seller_tax_code text,
  seller_name text NOT NULL,
  seller_address text,
  buyer_tax_code text,
  buyer_name text,
  currency text NOT NULL DEFAULT 'VND',
  fx_rate numeric(20,10),
  total_before_tax numeric(20,4),
  total_tax numeric(20,4),
  total numeric(20,4),
  cqt_code text,
  seller_sig jsonb,
  cqt_sig jsonb,
  buyer_matches boolean,
  -- true khi có số tiền không đọc được (sai dạng hoặc quá cột): để NULL, chưa cho lập chứng từ cho tới khi người dùng xử lý.
  blocked boolean NOT NULL DEFAULT false,
  tax_code_check jsonb,
  warnings jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'voucher_created', 'ignored', 'duplicate')),
  duplicate_of bigint,
  voucher_id uuid,
  party_id uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, xml_sha256),
  CHECK ((status = 'duplicate') = (duplicate_of IS NOT NULL)),
  FOREIGN KEY (tenant_id, duplicate_of) REFERENCES inbound_invoice (tenant_id, id) ON DELETE SET NULL (duplicate_of),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id) ON DELETE SET NULL (voucher_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES party (tenant_id, id) ON DELETE SET NULL (party_id));
CREATE INDEX inbound_invoice_key ON inbound_invoice (tenant_id, fn_invoice_key(seller_tax_code), fn_invoice_key(serial), fn_invoice_key(invoice_no));
CREATE INDEX inbound_invoice_date ON inbound_invoice (tenant_id, issue_date DESC, id DESC);

CREATE TABLE inbound_invoice_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  invoice_id bigint NOT NULL,
  line_no int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('goods', 'promotion', 'discount', 'note')),
  code text,
  name text NOT NULL,
  uom text,
  quantity numeric(24,6),
  unit_price numeric(24,6),
  discount_amount numeric(20,4),
  amount numeric(20,4),
  tax_rate text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES inbound_invoice (tenant_id, id) ON DELETE CASCADE);

SELECT rls_enable(t) FROM unnest(ARRAY['inbound_invoice', 'inbound_invoice_line']::regclass[]) AS t;
-- Cột xml (tới 2 MB) không ghi vào audit_event; XML gốc nằm ở chính bảng và bất biến về nội dung.
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON inbound_invoice FOR EACH ROW EXECUTE FUNCTION fn_audit_row('xml');
SELECT audit_enable('inbound_invoice_line');
