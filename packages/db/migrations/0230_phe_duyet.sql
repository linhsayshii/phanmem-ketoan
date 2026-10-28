-- GĐ7 nhóm 4: đề nghị thanh toán / tạm ứng và quy trình phê duyệt; phạm vi khóa API "mobile".
-- Đề nghị không phải chứng từ sổ cái: duyệt xong mới sinh Phiếu chi / Giấy báo Nợ nháp (source_doc_type = 'approval_request').
INSERT INTO permission(code, name, group_name) VALUES
  ('approval_request.view', 'Xem mọi đề nghị thanh toán, tạm ứng', 'Phê duyệt'),
  ('approval_request.create', 'Lập đề nghị thanh toán, tạm ứng', 'Phê duyệt'),
  ('approval_request.approve', 'Duyệt đề nghị thanh toán, tạm ứng', 'Phê duyệt')
ON CONFLICT (code) DO NOTHING;

-- create_tenant (0078) cấp theo mẫu nên công ty mới tự có: admin, ketoan_truong, ketoan_vien đủ ba quyền; xem có approval_request.view. Công ty đã có: cấp cùng cách.
ALTER TABLE role_permission DISABLE TRIGGER trg_audit;
INSERT INTO role_permission(tenant_id, role_id, permission_code)
  SELECT r.tenant_id, r.id, np.code FROM role r
  CROSS JOIN (VALUES ('approval_request.view'), ('approval_request.create'), ('approval_request.approve')) AS np(code)
  WHERE r.code IN ('admin', 'ketoan_truong', 'ketoan_vien') OR (r.code = 'xem' AND np.code = 'approval_request.view')
  ON CONFLICT DO NOTHING;
ALTER TABLE role_permission ENABLE TRIGGER trg_audit;

CREATE TABLE approval_flow (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('payment', 'advance')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  min_amount numeric(20,0) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id));
-- Hạn mức là ngưỡng dưới: đề nghị dùng quy trình đang dùng có min_amount lớn nhất không vượt số tiền; trùng ngưỡng thì không chọn được.
CREATE UNIQUE INDEX approval_flow_threshold ON approval_flow (tenant_id, kind, min_amount) WHERE is_active;

CREATE TABLE approval_flow_step (
  tenant_id uuid NOT NULL,
  flow_id bigint NOT NULL,
  step_no int NOT NULL CHECK (step_no BETWEEN 1 AND 10),
  role_id uuid,
  user_id uuid,
  PRIMARY KEY (tenant_id, flow_id, step_no),
  CHECK ((role_id IS NULL) <> (user_id IS NULL)),
  FOREIGN KEY (tenant_id, flow_id) REFERENCES approval_flow (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_user (tenant_id, user_id));

CREATE TABLE approval_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('payment', 'advance')),
  request_no text NOT NULL,
  request_date date NOT NULL,
  requester_id uuid NOT NULL,
  party_id uuid,
  payee_name text NOT NULL CHECK (length(btrim(payee_name)) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  currency_code text NOT NULL DEFAULT 'VND' CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount_currency numeric(20,4) NOT NULL CHECK (amount_currency > 0),
  fx_rate numeric(20,10) CHECK (fx_rate > 0),
  amount numeric(20,0) NOT NULL CHECK (amount > 0),
  account_code text NOT NULL CHECK (account_code ~ '^[0-9A-Za-z]{3,20}$'),
  pay_method text NOT NULL CHECK (pay_method IN ('cash', 'bank')),
  bank_account_id bigint,
  due_date date,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled')),
  flow_id bigint,
  steps jsonb NOT NULL DEFAULT '[]', -- bản chụp các bước lúc gửi duyệt: sửa quy trình sau đó không đổi đề nghị đang chạy
  current_step int NOT NULL DEFAULT 0,
  reject_reason text,
  voucher_id uuid,
  submitted_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((currency_code = 'VND') = (fx_rate IS NULL)),
  CHECK (currency_code <> 'VND' OR amount_currency = amount),
  CHECK (pay_method = 'cash' OR bank_account_id IS NOT NULL),
  CHECK (state <> 'rejected' OR length(btrim(coalesce(reject_reason, ''))) > 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, request_no),
  FOREIGN KEY (tenant_id, requester_id) REFERENCES tenant_user (tenant_id, user_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES party (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_account (tenant_id, id),
  FOREIGN KEY (tenant_id, flow_id) REFERENCES approval_flow (tenant_id, id),
  -- Kế toán xóa phiếu nháp đã sinh: đề nghị vẫn là đã duyệt, chỉ mất liên kết.
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id) ON DELETE SET NULL (voucher_id));
CREATE INDEX approval_request_state_idx ON approval_request (tenant_id, state, created_at DESC);
CREATE INDEX approval_request_requester_idx ON approval_request (tenant_id, requester_id, created_at DESC);

CREATE TABLE approval_step_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  step_no int NOT NULL,
  action text NOT NULL CHECK (action IN ('submit', 'approve', 'reject', 'cancel')),
  actor_id uuid NOT NULL,
  note text CHECK (length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, request_id) REFERENCES approval_request (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES tenant_user (tenant_id, user_id));
CREATE INDEX approval_step_log_request_idx ON approval_step_log (tenant_id, request_id, id);

CREATE TABLE approval_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  file_name text NOT NULL,
  mime text NOT NULL,
  bytes bigint NOT NULL,
  storage_key text NOT NULL,
  uploaded_by uuid NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, request_id) REFERENCES approval_request (tenant_id, id));
CREATE INDEX approval_attachment_request_idx ON approval_attachment (tenant_id, request_id);

SELECT rls_enable(t) FROM unnest(ARRAY['approval_flow', 'approval_flow_step', 'approval_request', 'approval_step_log', 'approval_attachment']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['approval_flow', 'approval_flow_step', 'approval_request', 'approval_step_log', 'approval_attachment']::regclass[]) AS t;

-- Phạm vi khóa API cho ứng dụng di động (/api/mobile/v1).
ALTER TABLE api_key DROP CONSTRAINT api_key_scopes_check;
ALTER TABLE api_key ADD CONSTRAINT api_key_scopes_check CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['items.read', 'stock.read', 'sales.write', 'inbound_invoice.write', 'mobile']);
