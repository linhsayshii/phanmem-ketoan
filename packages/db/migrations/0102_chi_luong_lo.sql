-- GĐ6 Task 8: chi lương theo lô bằng tệp CSV/Excel do người dùng ánh xạ cột (chưa có mẫu thật của ngân hàng nào nên không gắn tên ngân hàng).
-- Mẫu: danh sách cột có thứ tự trong jsonb ({ field, header, value? }), API kiểm trước khi lưu. Lô: mỗi lần xuất ghi một dòng kèm nội dung tệp để tải lại (đòi view_salary).
CREATE TABLE payroll_payment_format (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL,
  file_type text NOT NULL CHECK (file_type IN ('csv', 'xlsx')),
  delimiter text NOT NULL DEFAULT ',' CHECK (delimiter IN (',', ';', E'\t', '|')),
  utf8_bom boolean NOT NULL DEFAULT true,
  has_header boolean NOT NULL DEFAULT true,
  ascii_only boolean NOT NULL DEFAULT false,
  content_template text NOT NULL DEFAULT 'Lương tháng {month}/{year} {employee_name}',
  columns jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array' AND jsonb_array_length(columns) BETWEEN 1 AND 50),
  created_by uuid DEFAULT app_user_id(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, name));

CREATE TABLE payroll_payment_batch (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  run_id bigint NOT NULL,
  format_id bigint NOT NULL,
  bank_account_id bigint,
  voucher_id uuid,
  file_name text NOT NULL,
  content_type text NOT NULL,
  file_content bytea NOT NULL,
  total numeric(20,0) NOT NULL CHECK (total >= 0),
  count int NOT NULL CHECK (count >= 0),
  warnings jsonb NOT NULL DEFAULT '[]',
  created_by uuid DEFAULT app_user_id(), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- Bảng lương và mẫu đã có lô thì không xóa được (lịch sử xuất tiền); tài khoản ngân hàng và chứng từ chỉ là tham chiếu.
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_run (tenant_id, id),
  FOREIGN KEY (tenant_id, format_id) REFERENCES payroll_payment_format (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_account (tenant_id, id) ON DELETE SET NULL (bank_account_id),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id) ON DELETE SET NULL (voucher_id));
CREATE INDEX payroll_payment_batch_run ON payroll_payment_batch (tenant_id, run_id);

SELECT rls_enable(t) FROM unnest(ARRAY['payroll_payment_format', 'payroll_payment_batch']::regclass[]) AS t;
SELECT audit_enable('payroll_payment_format');
-- Nhật ký lô che nội dung tệp (số tài khoản và lương từng người); fn_audit_row nhận danh sách cột che (0079).
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON payroll_payment_batch FOR EACH ROW EXECUTE FUNCTION fn_audit_row('file_content');
