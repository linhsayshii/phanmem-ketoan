-- GĐ4 Task 14: kiểm kê TSCĐ, công cụ dụng cụ (mẫu 05 - TSCĐ). Chênh lệch không tự sinh chứng từ: người dùng ghi giảm/ghi tăng bằng nghiệp vụ tài sản.
-- book_* là ảnh chụp số sổ sách tại ngày kiểm kê (điền bằng fill từ fn_asset_values_at); số kiểm kê chỉ nhập số lượng.
CREATE TABLE asset_count (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('fixed','tool')),
  count_date date NOT NULL,
  department_id bigint,
  members jsonb NOT NULL DEFAULT '[]',
  note text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','done')),
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id));
CREATE INDEX asset_count_list ON asset_count (tenant_id, count_date DESC);

CREATE TABLE asset_count_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  count_id bigint NOT NULL,
  asset_id bigint NOT NULL,
  book_quantity numeric(20,4) NOT NULL,
  actual_quantity numeric(20,4) CHECK (actual_quantity IS NULL OR actual_quantity >= 0),
  book_cost numeric(20,0) NOT NULL,
  book_nbv numeric(20,0) NOT NULL,
  condition text,
  note text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, count_id, asset_id),
  FOREIGN KEY (tenant_id, count_id) REFERENCES asset_count (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, asset_id) REFERENCES asset (tenant_id, id));

SELECT rls_enable(t) FROM unnest(ARRAY['asset_count','asset_count_line']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['asset_count','asset_count_line']::regclass[]) AS t;
