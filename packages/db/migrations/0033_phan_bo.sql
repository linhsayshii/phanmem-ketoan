-- GĐ2 Task 20: lịch phân bổ (doanh thu nhận trước TK 3387 → doanh thu; GĐ4 thêm 'prepaid_expense') và các dòng phân bổ theo kỳ.
-- Chạy phân bổ kỳ nào sinh chứng từ PB (source_doc_type = 'amortization', source_doc_id = md5('<công ty>:amortization:<id lịch>')::uuid) và ghi voucher_id vào dòng.
-- Dòng lịch đã có chứng từ thì lịch không sửa số, tài khoản, số kỳ và không xóa được (kiểm ở API).
CREATE TABLE amortization_schedule (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('deferred_revenue')),
  source_voucher_id uuid,
  from_account_id bigint NOT NULL,
  to_account_id bigint NOT NULL,
  total numeric(20,0) NOT NULL CHECK (total > 0),
  periods int NOT NULL CHECK (periods BETWEEN 1 AND 120),
  start_year int NOT NULL,
  start_period int NOT NULL CHECK (start_period BETWEEN 1 AND 15),
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_account_id <> to_account_id),
  CHECK (total >= periods), -- mỗi kỳ ít nhất 1 đồng
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, source_voucher_id) REFERENCES voucher(tenant_id, id) ON DELETE SET NULL (source_voucher_id),
  FOREIGN KEY (tenant_id, from_account_id) REFERENCES account(tenant_id, id),
  FOREIGN KEY (tenant_id, to_account_id) REFERENCES account(tenant_id, id));
SELECT rls_enable('amortization_schedule');
SELECT audit_enable('amortization_schedule');

CREATE TABLE amortization_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  schedule_id bigint NOT NULL,
  seq int NOT NULL CHECK (seq > 0),
  fiscal_year int NOT NULL,
  period_no int NOT NULL,
  amount numeric(20,0) NOT NULL CHECK (amount > 0),
  voucher_id uuid,
  UNIQUE (tenant_id, schedule_id, seq),
  FOREIGN KEY (tenant_id, schedule_id) REFERENCES amortization_schedule(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher(tenant_id, id));
CREATE INDEX amortization_line_period ON amortization_line (tenant_id, fiscal_year, period_no);
CREATE INDEX amortization_line_voucher ON amortization_line (tenant_id, voucher_id);
SELECT rls_enable('amortization_line');
SELECT audit_enable('amortization_line');
