-- GĐ4 Task 5: biến động tài sản (ghi tăng, ghi giảm, đánh giá lại, điều chuyển, dừng/tiếp tục khấu hao, điều chỉnh thời gian sử dụng).
-- Số tiền vẫn nằm trên sổ cái (chứng từ TS, source_doc_type 'asset_event'); data giữ giá trị trước/sau đã dùng để hủy khôi phục thẻ.
-- Khoảng dừng khấu hao đọc từ các dòng suspend/resume còn hiệu lực (cửa sổ hoạt động của động cơ lịch).
CREATE TABLE asset_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  asset_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('increase','decrease','revaluation','transfer','suspend','resume','life_change','value_adjust','quantity_change')),
  event_date date NOT NULL,
  voucher_id uuid,
  data jsonb NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','cancelled')),
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES asset (tenant_id, id),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id));
CREATE INDEX asset_event_asset ON asset_event (tenant_id, asset_id, event_date) WHERE state = 'active';

SELECT rls_enable('asset_event');
SELECT audit_enable('asset_event');
