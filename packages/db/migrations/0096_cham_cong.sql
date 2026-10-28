-- GĐ6 Task 4: chấm công theo tháng. Bảng chấm công (attendance_sheet) chỉ là nhãn nhóm theo bộ phận (department_id rỗng = toàn công ty);
-- mỗi ô (nhân viên, ngày, loại) là một dòng attendance_entry. Số lượng: ngày/buổi/giờ tùy loại, quy đổi ở API/domain (workDays).
-- Dữ liệu chấm công không phải dữ liệu tiền lương nên không cần cờ view_salary (quyền attendance.* ở 0094).
CREATE TABLE attendance_sheet (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  year int NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  department_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, year, month, department_id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id));

CREATE TABLE attendance_entry (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  sheet_id bigint NOT NULL,
  employee_id bigint NOT NULL,
  work_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('work_day', 'half_day', 'hour', 'ot_weekday_hour', 'ot_rest_hour', 'ot_holiday_hour', 'paid_leave', 'sick_leave', 'unpaid_leave', 'holiday')),
  qty numeric(8,2) NOT NULL CHECK (qty > 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sheet_id, employee_id, work_date, kind),
  FOREIGN KEY (tenant_id, sheet_id) REFERENCES attendance_sheet (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id));
CREATE INDEX attendance_entry_month ON attendance_entry (tenant_id, work_date, employee_id);

SELECT rls_enable(t) FROM unnest(ARRAY['attendance_sheet', 'attendance_entry']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['attendance_sheet', 'attendance_entry']::regclass[]) AS t;
