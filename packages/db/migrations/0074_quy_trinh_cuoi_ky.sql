-- GĐ4 Task 12: nhật ký các bước quy trình cuối kỳ (mỗi lần chạy một dòng; trạng thái từng bước suy ra từ nhật ký).
CREATE TABLE period_close_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  fiscal_year int NOT NULL,
  period_no int NOT NULL,
  step text NOT NULL CHECK (step IN ('tool','prepaid','depreciation','loan_interest','amortization','costing','fx_outflow','fx_revaluation','vat_offset','closing')),
  ran_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES app_user(id),
  ok boolean NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, fiscal_year, period_no) REFERENCES fiscal_period (tenant_id, fiscal_year, period_no));
CREATE INDEX period_close_log_step ON period_close_log (tenant_id, fiscal_year, period_no, step, ran_at DESC);
SELECT rls_enable('period_close_log'::regclass);
