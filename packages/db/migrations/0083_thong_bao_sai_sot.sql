-- GĐ5 Task 8: Thông báo hóa đơn điện tử đã lập sai, Mẫu số 04/SS-HĐĐT Phụ lục III TT 91/2026/TT-BTC.
-- Cột dòng theo mẫu: (2) Mã CQT cấp, (3) Ký hiệu mẫu hóa đơn, (4) Ký hiệu hóa đơn, (5) Số hóa đơn điện tử, (6) Ngày lập hóa đơn, (7) Loại hóa đơn điện tử, (8) Thông báo/Giải trình, (9) Lý do/Thông báo của CQT.
CREATE TABLE einvoice_error_notice (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  notice_kind text NOT NULL CHECK (notice_kind IN ('self', 'tax_notice')),
  tax_notice_no text,
  tax_notice_date date,
  notice_date date NOT NULL,
  place text NOT NULL DEFAULT '',
  provider_id bigint,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent')),
  provider_ref text,
  sent_at timestamptz,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (notice_kind = 'self' OR (tax_notice_no IS NOT NULL AND tax_notice_date IS NOT NULL)),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES einvoice_provider (tenant_id, id));

CREATE TABLE einvoice_error_notice_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  notice_id bigint NOT NULL,
  line_no int NOT NULL CHECK (line_no > 0),
  einvoice_id bigint,
  cqt_code text,
  form_no text NOT NULL,
  serial text NOT NULL,
  invoice_no text NOT NULL,
  issue_date date NOT NULL,
  invoice_type text NOT NULL,
  action text NOT NULL CHECK (action IN ('notice', 'explain')),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, notice_id, line_no),
  FOREIGN KEY (tenant_id, notice_id) REFERENCES einvoice_error_notice (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, einvoice_id) REFERENCES einvoice (tenant_id, id));
CREATE UNIQUE INDEX einvoice_error_notice_line_inv ON einvoice_error_notice_line (tenant_id, notice_id, einvoice_id) WHERE einvoice_id IS NOT NULL;

SELECT rls_enable(t) FROM unnest(ARRAY['einvoice_error_notice', 'einvoice_error_notice_line']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['einvoice_error_notice', 'einvoice_error_notice_line']::regclass[]) AS t;
