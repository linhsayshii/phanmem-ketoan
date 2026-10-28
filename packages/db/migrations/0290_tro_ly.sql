-- GĐ7 nhóm 7: trợ lý AI. Mẫu bút toán định kỳ (sinh chứng từ NHÁP theo kỳ), lần chạy theo (mẫu, kỳ), nhật ký nhận diện hóa đơn.
-- Gợi ý định khoản không có bảng riêng: học trực tiếp từ chứng từ đã ghi sổ của công ty (RLS, phạm vi chi nhánh, cờ nhạy cảm áp ở API).
INSERT INTO permission(code, name, group_name) VALUES
  ('assistant.use', 'Dùng trợ lý (gợi ý định khoản, nhận diện hóa đơn)', 'Trợ lý'),
  ('recurring.view', 'Xem bút toán định kỳ', 'Trợ lý'),
  ('recurring.manage', 'Quản lý bút toán định kỳ (lập mẫu, chạy)', 'Trợ lý')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE recurring_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9_.-]{1,30}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  frequency text NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  -- Ngày trong tháng; tháng ngắn hơn thì lấy ngày cuối tháng (31 = cuối tháng).
  day_of_month int NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  start_date date NOT NULL,
  end_date date,
  -- false: bỏ các kỳ trước tháng lập mẫu; true: sinh bù từ start_date.
  catch_up boolean NOT NULL DEFAULT false,
  description text CHECK (description IS NULL OR length(description) <= 500),
  -- Mặc định chỉ sinh chứng từ NHÁP; true là cấu hình rõ của người có quyền ghi sổ: sinh xong ghi sổ luôn.
  auto_post boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (end_date IS NULL OR end_date >= start_date),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_user (tenant_id, user_id));

-- Số tiền mỗi bên là số nguyên đồng cố định hoặc công thức (biến THANG, QUY, NAM, SO_NGAY; + - * / ngoặc; ROUND, MIN, MAX); kiểm cú pháp ở API, tính bằng decimal.js.
CREATE TABLE recurring_entry_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entry_id uuid NOT NULL,
  line_no int NOT NULL CHECK (line_no >= 1),
  account_code text NOT NULL CHECK (account_code ~ '^[0-9A-Za-z.]{1,20}$'),
  debit_expr text NOT NULL DEFAULT '0' CHECK (length(debit_expr) BETWEEN 1 AND 200),
  credit_expr text NOT NULL DEFAULT '0' CHECK (length(credit_expr) BETWEEN 1 AND 200),
  party_code text CHECK (party_code IS NULL OR length(party_code) <= 30),
  department_code text CHECK (department_code IS NULL OR length(department_code) <= 30),
  project_code text CHECK (project_code IS NULL OR length(project_code) <= 30),
  cost_item_code text CHECK (cost_item_code IS NULL OR length(cost_item_code) <= 30),
  description text CHECK (description IS NULL OR length(description) <= 500),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entry_id, line_no),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES recurring_entry (tenant_id, id) ON DELETE CASCADE);

-- Mỗi (mẫu, kỳ) một dòng: chạy lại không sinh trùng. skipped/error được thử lại ở lần chạy sau (cập nhật cùng dòng); created là cuối cùng.
-- voucher_id không có khóa ngoại: người dùng xóa chứng từ nháp thì kỳ đó không tự sinh lại.
CREATE TABLE recurring_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entry_id uuid NOT NULL,
  period_key text NOT NULL CHECK (period_key ~ '^[0-9]{4}-[0-9]{2}$'),
  occurrence_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('created', 'skipped', 'error')),
  reason_code text, message text,
  voucher_id uuid,
  trigger text NOT NULL CHECK (trigger IN ('worker', 'manual')),
  run_by uuid, run_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entry_id, period_key),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES recurring_entry (tenant_id, id) ON DELETE CASCADE);

-- Nhật ký nhận diện hóa đơn: ghi cả lần bị từ chối; external = true khi nội dung tệp được gửi cho nhà cung cấp ngoài.
CREATE TABLE assistant_recognition_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid,
  provider text NOT NULL,
  external boolean NOT NULL DEFAULT false,
  file_name text, file_sha256 text, bytes int,
  status text NOT NULL CHECK (status IN ('ok', 'rejected', 'error')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id));

SELECT rls_enable(t) FROM unnest(ARRAY['recurring_entry', 'recurring_entry_line', 'recurring_run', 'assistant_recognition_log']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['recurring_entry', 'recurring_entry_line']::regclass[]) AS t;

-- Worker (app_user) chưa biết công ty nào có mẫu đang chạy: chỉ trả tenant_id, phần còn lại đọc dưới RLS của từng công ty.
CREATE FUNCTION fn_recurring_tenants() RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT e.tenant_id FROM recurring_entry e WHERE e.status = 'active' $$;
REVOKE ALL ON FUNCTION fn_recurring_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_recurring_tenants() TO app_user;

-- Công ty đã có: admin, kế toán trưởng, kế toán viên nhận mọi quyền mới (chỉ sinh chứng từ nháp); chỉ xem nhận recurring.view. create_tenant giữ nguyên thân 0078 (không chặn tiền tố assistant., recurring.).
ALTER TABLE role_permission DISABLE TRIGGER trg_audit;
INSERT INTO role_permission(tenant_id, role_id, permission_code)
  SELECT r.tenant_id, r.id, np.code
  FROM role r CROSS JOIN (SELECT code FROM permission WHERE code IN ('assistant.use', 'recurring.view', 'recurring.manage')) AS np
  WHERE r.code IN ('admin', 'ketoan_truong', 'ketoan_vien') OR (r.code = 'xem' AND np.code LIKE '%.view')
  ON CONFLICT DO NOTHING;
ALTER TABLE role_permission ENABLE TRIGGER trg_audit;
