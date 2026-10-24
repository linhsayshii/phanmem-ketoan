-- GĐ6 Task 5: cấu trúc bảng lương và bảng lương theo kỳ (tính toán có phiên bản; hạch toán LU ở Task 6).
-- Tiền lương là dữ liệu nhạy cảm (view_salary chặn ở API). Không có giá trị pháp lý nào ở đây.

-- Cấu trúc: danh sách cột là jsonb (PayrollColumn[] của @kt/domain), API kiểm bằng validateStructure trước khi lưu.
-- Bất biến khi đã có bảng lương không phải nháp dùng (API trả 409 STRUCTURE_IN_USE, người dùng nhân bản để sửa).
CREATE TABLE payroll_structure (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL,
  proration text NOT NULL DEFAULT 'calendar' CHECK (proration IN ('calendar', 'standard_26', 'standard_22', 'fixed')),
  columns jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
  is_default boolean NOT NULL DEFAULT false,
  parent_id bigint,
  note text,
  created_by uuid DEFAULT app_user_id(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES payroll_structure (tenant_id, id) ON DELETE SET NULL (parent_id));
CREATE UNIQUE INDEX payroll_structure_one_default ON payroll_structure (tenant_id) WHERE is_default;

CREATE TABLE payroll_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  year int NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  kind text NOT NULL DEFAULT 'regular' CHECK (kind IN ('regular', 'bonus', 'retro')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'calculated', 'posted', 'cancelled')),
  name text NOT NULL,
  department_id bigint,
  structure_id bigint NOT NULL,
  input_hash text, calculated_at timestamptz,
  warnings jsonb NOT NULL DEFAULT '[]',
  voucher_id uuid, -- chứng từ LU (Task 6)
  note text,
  created_by uuid DEFAULT app_user_id(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id),
  FOREIGN KEY (tenant_id, structure_id) REFERENCES payroll_structure (tenant_id, id),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id) ON DELETE SET NULL (voucher_id));
CREATE INDEX payroll_run_period ON payroll_run (tenant_id, year, month);

-- Dòng bảng lương: tổng các cột chính để truy vấn nhanh; year/month/kind/run_status chép từ bảng lương (trigger) để ràng buộc
-- "một nhân viên chỉ ở một bảng lương chính (regular) chưa hủy mỗi tháng" bằng chỉ mục duy nhất một phần (D12).
CREATE TABLE payroll_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  run_id bigint NOT NULL,
  employee_id bigint NOT NULL,
  year int NOT NULL, month int NOT NULL, kind text NOT NULL, run_status text NOT NULL,
  gross numeric(20,0) NOT NULL DEFAULT 0, si_emp numeric(20,0) NOT NULL DEFAULT 0, si_er numeric(20,0) NOT NULL DEFAULT 0,
  pit numeric(20,0) NOT NULL DEFAULT 0, net numeric(20,0) NOT NULL DEFAULT 0,
  warnings jsonb NOT NULL DEFAULT '[]',
  input_hash text, -- chữ ký đầu vào lúc tính dòng này; khác chữ ký hiện tại là "Cần tính lại"
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, run_id, employee_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_run (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id));
CREATE UNIQUE INDEX payroll_line_one_regular ON payroll_line (tenant_id, year, month, employee_id) WHERE kind = 'regular' AND run_status <> 'cancelled';
CREATE INDEX payroll_line_employee ON payroll_line (tenant_id, employee_id, year, month);

-- Giá trị từng cột; manual = ô nhập tay (cột input) do người dùng sửa, tính lại không ghi đè. Không audit theo dòng (API ghi audit_event khi sửa tay).
CREATE TABLE payroll_line_value (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  line_id bigint NOT NULL,
  column_code text NOT NULL,
  value text NOT NULL,
  manual boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, line_id, column_code),
  FOREIGN KEY (tenant_id, line_id) REFERENCES payroll_line (tenant_id, id) ON DELETE CASCADE);

-- Chép thuộc tính bảng lương xuống dòng khi thêm dòng và khi bảng lương đổi trạng thái/kỳ/loại.
CREATE FUNCTION fn_payroll_line_fill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT r.year, r.month, r.kind, r.status INTO NEW.year, NEW.month, NEW.kind, NEW.run_status FROM payroll_run r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.run_id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payroll_line_fill BEFORE INSERT ON payroll_line FOR EACH ROW EXECUTE FUNCTION fn_payroll_line_fill();

CREATE FUNCTION fn_payroll_run_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE payroll_line SET year = NEW.year, month = NEW.month, kind = NEW.kind, run_status = NEW.status WHERE tenant_id = NEW.tenant_id AND run_id = NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payroll_run_sync AFTER UPDATE OF status, year, month, kind ON payroll_run FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.year <> NEW.year OR OLD.month <> NEW.month OR OLD.kind <> NEW.kind) EXECUTE FUNCTION fn_payroll_run_sync();

SELECT rls_enable(t) FROM unnest(ARRAY['payroll_structure', 'payroll_run', 'payroll_line', 'payroll_line_value']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['payroll_structure', 'payroll_run']::regclass[]) AS t;
