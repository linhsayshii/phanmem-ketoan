-- GĐ2 Task 10: nhật ký chạy tỷ giá ngoại tệ cuối kỳ (tính lại tỷ giá xuất quỹ; đánh giá lại ngoại tệ dùng chung ở Task 13).
-- Mỗi lần chạy một dòng: voucher_ids là chứng từ sinh ra (XQ/DG), reversed_voucher_ids là chứng từ của lần chạy trước bị đảo khi chạy lại cùng kỳ.
-- Chứng từ sinh ra mang source_doc_id = md5('<công ty>:fx_run:<id>')::uuid (source_doc_id là uuid còn id là số), cùng cách kiểm kê quỹ làm.
CREATE TABLE fx_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('outflow', 'revaluation')),
  fiscal_year int NOT NULL,
  period_no int NOT NULL,
  run_date date NOT NULL,
  voucher_ids uuid[] NOT NULL DEFAULT '{}',
  reversed_voucher_ids uuid[] NOT NULL DEFAULT '{}',
  params jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, fiscal_year, period_no) REFERENCES fiscal_period(tenant_id, fiscal_year, period_no));
CREATE INDEX fx_run_period ON fx_run (tenant_id, kind, fiscal_year, period_no, id);
SELECT rls_enable('fx_run'), audit_enable('fx_run');
