-- GĐ6 Task 3: hồ sơ lương của nhân viên (tách khỏi danh mục employee): thông tin trả lương/bảo hiểm/thuế, phụ cấp, lịch sử mức lương,
-- người phụ thuộc (giảm trừ tính theo tháng hiệu lực) và tỷ lệ phân bổ chi phí lương theo vụ việc. Dữ liệu nhạy cảm (view_salary) chặn ở API.
-- Bảng nào cũng có id (fn_audit_row lấy entity_id từ id) và khóa ngoại tổng hợp (tenant_id, ...) tới bảng cha.

-- 1–1 với employee. Tham gia bảo hiểm mặc định false: chưa khai thì bảng lương không tính (không tự áp dụng).
CREATE TABLE employee_payroll (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  employee_id bigint NOT NULL,
  pay_method text NOT NULL DEFAULT 'transfer' CHECK (pay_method IN ('cash', 'transfer')),
  bank_code text, bank_name text, bank_account_no text, bank_account_name text,
  tax_residency text NOT NULL DEFAULT 'resident' CHECK (tax_residency IN ('resident', 'non_resident')),
  contract_type text NOT NULL DEFAULT 'long' CHECK (contract_type IN ('long', 'short', 'none')),
  start_date date, end_date date,
  region text CHECK (region IN ('I', 'II', 'III', 'IV')),
  si_no text,
  si_participates boolean NOT NULL DEFAULT false, hi_participates boolean NOT NULL DEFAULT false,
  ui_participates boolean NOT NULL DEFAULT false, occupational_participates boolean NOT NULL DEFAULT false,
  si_salary numeric(20,0) CHECK (si_salary IS NULL OR si_salary >= 0),
  union_employer boolean NOT NULL DEFAULT false, union_member boolean NOT NULL DEFAULT false,
  pit_authorized boolean NOT NULL DEFAULT false,
  default_project_id bigint,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, employee_id),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, default_project_id) REFERENCES project (tenant_id, id) ON DELETE SET NULL (default_project_id));

-- Phụ cấp: valid_from/valid_to rỗng là áp dụng mọi kỳ; bảng lương chọn dòng có hiệu lực trong kỳ.
CREATE TABLE employee_allowance (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  employee_id bigint NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z0-9_]+$'),
  name text NOT NULL,
  amount numeric(20,0) NOT NULL CHECK (amount >= 0),
  taxable boolean NOT NULL DEFAULT true,
  si_base boolean NOT NULL DEFAULT false,
  valid_from date, valid_to date,
  UNIQUE (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, employee_id, code, valid_from),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE);

-- Lịch sử mức lương theo ngày hiệu lực. Chỉ thêm/xóa; dòng đã được bảng lương dùng không xóa được (API kiểm, Task 5 gắn truy vấn vào salaryHistoryUsed).
CREATE TABLE employee_salary_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  employee_id bigint NOT NULL,
  valid_from date NOT NULL,
  monthly_salary numeric(20,0) NOT NULL CHECK (monthly_salary >= 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, employee_id, valid_from),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE);

-- Người phụ thuộc: tính giảm trừ theo tháng 'YYYY-MM' có hiệu lực (từ tháng đến tháng, đến tháng rỗng là còn hiệu lực).
-- Không trùng khoảng của cùng một người ở cùng nhân viên: API kiểm (EXCLUDE cần btree_gist, dự án chưa dùng).
CREATE TABLE employee_dependent (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  employee_id bigint NOT NULL,
  name text NOT NULL,
  relationship text NOT NULL CHECK (relationship IN ('child', 'spouse', 'father', 'mother', 'sibling', 'other')),
  tax_code text, id_number text, birth_date date,
  from_month text NOT NULL CHECK (from_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  to_month text CHECK (to_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  note text,
  UNIQUE (tenant_id, id),
  CHECK (to_month IS NULL OR to_month >= from_month),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE);
CREATE INDEX employee_dependent_employee ON employee_dependent (tenant_id, employee_id);

-- Phân bổ chi phí lương của nhân viên cho nhiều vụ việc; tổng tỷ lệ bằng 100 do API kiểm khi lưu cả bộ.
CREATE TABLE employee_cost_split (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  employee_id bigint NOT NULL,
  project_id bigint NOT NULL,
  pct numeric(7,4) NOT NULL CHECK (pct > 0 AND pct <= 100),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, employee_id, project_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES project (tenant_id, id));

SELECT rls_enable(t) FROM unnest(ARRAY['employee_payroll','employee_allowance','employee_salary_history','employee_dependent','employee_cost_split']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['employee_payroll','employee_allowance','employee_salary_history','employee_dependent','employee_cost_split']::regclass[]) AS t;
