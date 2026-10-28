-- 0281_uy_quyen_duyet.sql: GĐ7 gói 3 — ủy quyền duyệt khi vắng mặt. Người duyệt (ủy quyền) giao quyền duyệt các bước của mình cho một người khác trong khoảng ngày;
-- người được ủy quyền duyệt "thay" và nhật ký bước ghi cả hai người. Không thay quy trình, không cấp thêm quyền: người được ủy quyền vẫn cần approval_request.approve
-- và cờ nhạy cảm của chính mình (kiểm khi duyệt). Duyệt hàng loạt không cần lược đồ.

CREATE TABLE approval_delegation (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  delegator_id uuid NOT NULL,
  delegate_id uuid NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  reason text CHECK (length(reason) <= 500),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  CHECK (delegator_id <> delegate_id),
  CHECK (date_to >= date_from AND date_to - date_from <= 365),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, delegator_id) REFERENCES tenant_user (tenant_id, user_id),
  FOREIGN KEY (tenant_id, delegate_id) REFERENCES tenant_user (tenant_id, user_id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_user (tenant_id, user_id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES tenant_user (tenant_id, user_id));
CREATE INDEX approval_delegation_delegate_idx ON approval_delegation (tenant_id, delegate_id, date_from, date_to) WHERE revoked_at IS NULL;
CREATE INDEX approval_delegation_delegator_idx ON approval_delegation (tenant_id, delegator_id, date_from DESC);
SELECT rls_enable('approval_delegation'), audit_enable('approval_delegation');

-- Nhật ký bước: người duyệt thực tế (actor_id) và người được duyệt thay (on_behalf_of), nếu có.
ALTER TABLE approval_step_log ADD COLUMN on_behalf_of uuid;
ALTER TABLE approval_step_log ADD FOREIGN KEY (tenant_id, on_behalf_of) REFERENCES tenant_user (tenant_id, user_id);
