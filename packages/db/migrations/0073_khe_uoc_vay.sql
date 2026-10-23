-- GĐ4 Task 9: khế ước vay = contract kind 'loan' + điều khoản, lãi suất theo hiệu lực, lịch trả gốc; số dư đầu kỳ theo khế ước.
ALTER TABLE contract DROP CONSTRAINT contract_kind_check;
ALTER TABLE contract ADD CONSTRAINT contract_kind_check CHECK (kind IN ('sale','purchase','loan'));

CREATE TABLE loan_term (
  contract_id bigint NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  principal_account_code text NOT NULL DEFAULT '3411',
  interest_expense_account_code text NOT NULL DEFAULT '635',
  interest_payable_account_code text NOT NULL DEFAULT '335',
  day_basis int NOT NULL DEFAULT 365 CHECK (day_basis IN (360, 365)),
  purpose text,
  PRIMARY KEY (tenant_id, contract_id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contract (tenant_id, id) ON DELETE CASCADE);

CREATE TABLE loan_rate (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  contract_id bigint NOT NULL,
  valid_from date NOT NULL,
  annual_rate numeric(9,6) NOT NULL CHECK (annual_rate >= 0),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, contract_id, valid_from),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contract (tenant_id, id) ON DELETE CASCADE);

CREATE TABLE loan_installment (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  contract_id bigint NOT NULL,
  due_date date NOT NULL,
  principal numeric(20,4) NOT NULL CHECK (principal > 0),
  note text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contract (tenant_id, id) ON DELETE CASCADE);
CREATE INDEX loan_installment_contract ON loan_installment (tenant_id, contract_id, due_date);

SELECT rls_enable(t) FROM unnest(ARRAY['loan_term','loan_rate','loan_installment']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['loan_term','loan_rate','loan_installment']::regclass[]) AS t;

-- Số dư đầu kỳ theo khế ước (TK 341x, 335): thêm contract_id vào khóa duy nhất (định nghĩa lại từ 0028).
ALTER TABLE opening_balance ADD COLUMN contract_id bigint;
ALTER TABLE opening_balance ADD FOREIGN KEY (tenant_id, contract_id) REFERENCES contract (tenant_id, id);
DROP INDEX opening_balance_key;
CREATE UNIQUE INDEX opening_balance_key ON opening_balance (tenant_id, fiscal_year, account_id, coalesce(party_id, '00000000-0000-0000-0000-000000000000'::uuid), currency_code, coalesce(bank_account_id, 0), coalesce(doc_no, ''), coalesce(contract_id, 0));
