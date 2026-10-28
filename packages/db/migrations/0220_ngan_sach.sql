-- GĐ7 nhóm 3: ngân sách (dự toán) theo năm tài chính, dòng ngân sách 12 tháng, cấu hình cảnh báo vượt ngân sách.
INSERT INTO permission(code, name, group_name) VALUES
  ('budget.view', 'Xem ngân sách', 'Ngân sách'),
  ('budget.create', 'Thêm ngân sách', 'Ngân sách'),
  ('budget.update', 'Sửa ngân sách', 'Ngân sách'),
  ('budget.delete', 'Xóa ngân sách', 'Ngân sách'),
  ('budget.approve', 'Duyệt, cấu hình cảnh báo ngân sách', 'Ngân sách')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE budget (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  fiscal_year int NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
  note text,
  approved_by uuid, approved_at timestamptz,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, fiscal_year, version),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_user (tenant_id, user_id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES tenant_user (tenant_id, user_id));
-- Mỗi năm chỉ một ngân sách đang áp dụng (đã duyệt).
CREATE UNIQUE INDEX budget_one_approved ON budget (tenant_id, fiscal_year) WHERE status = 'approved';

CREATE TABLE budget_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  budget_id bigint NOT NULL,
  line_no int NOT NULL CHECK (line_no >= 1),
  -- Mã tài khoản hoặc tiền tố nhóm tài khoản (642 gồm 6421, 6422...).
  account_prefix text NOT NULL CHECK (account_prefix ~ '^[0-9A-Za-z.]{1,20}$'),
  cost_item_id bigint, department_id bigint, project_id bigint,
  m01 numeric(20,0) NOT NULL DEFAULT 0 CHECK (m01 >= 0), m02 numeric(20,0) NOT NULL DEFAULT 0 CHECK (m02 >= 0), m03 numeric(20,0) NOT NULL DEFAULT 0 CHECK (m03 >= 0),
  m04 numeric(20,0) NOT NULL DEFAULT 0 CHECK (m04 >= 0), m05 numeric(20,0) NOT NULL DEFAULT 0 CHECK (m05 >= 0), m06 numeric(20,0) NOT NULL DEFAULT 0 CHECK (m06 >= 0),
  m07 numeric(20,0) NOT NULL DEFAULT 0 CHECK (m07 >= 0), m08 numeric(20,0) NOT NULL DEFAULT 0 CHECK (m08 >= 0), m09 numeric(20,0) NOT NULL DEFAULT 0 CHECK (m09 >= 0),
  m10 numeric(20,0) NOT NULL DEFAULT 0 CHECK (m10 >= 0), m11 numeric(20,0) NOT NULL DEFAULT 0 CHECK (m11 >= 0), m12 numeric(20,0) NOT NULL DEFAULT 0 CHECK (m12 >= 0),
  note text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, budget_id, line_no),
  FOREIGN KEY (tenant_id, budget_id) REFERENCES budget (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, cost_item_id) REFERENCES cost_item (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES project (tenant_id, id));

-- Cấu hình cảnh báo vượt ngân sách theo công ty; tắt mặc định (không có dòng = tắt).
CREATE TABLE budget_setting (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  enabled boolean NOT NULL DEFAULT false,
  warn_pct int NOT NULL DEFAULT 90 CHECK (warn_pct BETWEEN 1 AND 1000),
  block_pct int CHECK (block_pct BETWEEN 1 AND 1000),
  CHECK (block_pct IS NULL OR block_pct >= warn_pct));

SELECT rls_enable(t), audit_enable(t) FROM unnest(ARRAY['budget', 'budget_line', 'budget_setting']::regclass[]) AS t;

-- Công ty đã có: admin và kế toán trưởng nhận mọi quyền mới; kế toán viên cũng nhận (create_tenant giữ nguyên thân 0078, không chặn tiền tố budget.); chỉ xem nhận budget.view.
ALTER TABLE role_permission DISABLE TRIGGER trg_audit;
INSERT INTO role_permission(tenant_id, role_id, permission_code)
  SELECT r.tenant_id, r.id, np.code
  FROM role r CROSS JOIN (SELECT code FROM permission WHERE code LIKE 'budget.%') AS np
  WHERE r.code IN ('admin', 'ketoan_truong', 'ketoan_vien') OR (r.code = 'xem' AND np.code LIKE '%.view')
  ON CONFLICT DO NOTHING;
ALTER TABLE role_permission ENABLE TRIGGER trg_audit;
