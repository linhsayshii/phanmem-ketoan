-- GĐ4 Task 2: loại tài sản, thẻ tài sản (TSCĐ, CCDC, chi phí trả trước), phân bổ chi phí; khóa ngoại voucher_line.asset_id; asset_id trên dòng hàng.
-- Thẻ không có trường nguyên giá/hao mòn tự do: số tiền luôn lấy từ sổ cái (voucher_line.asset_id); chỉ opening_* là số nhập đầu kỳ (Task 8 sinh chứng từ DK).
CREATE TABLE asset_category (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fixed','tool','prepaid')),
  asset_account_code text NOT NULL, depreciation_account_code text,
  default_life_units int CHECK (default_life_units BETWEEN 1 AND 1200),
  is_active boolean NOT NULL DEFAULT true,
  CHECK ((kind = 'fixed') = (depreciation_account_code IS NOT NULL)),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code));

CREATE TABLE asset (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fixed','tool','prepaid')),
  category_id bigint,
  asset_account_code text NOT NULL, depreciation_account_code text,
  department_id bigint,
  use_date date, depreciation_start_date date,
  life_units int CHECK (life_units BETWEEN 1 AND 1200),
  is_depreciable boolean NOT NULL DEFAULT true,
  capital_source text CHECK (capital_source IN ('owner','loan','grant','other')),
  card_no text, country text, year_made int, spec text,
  quantity numeric(20,4) NOT NULL DEFAULT 1 CHECK (quantity >= 0), uom text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','decreased')),
  decrease_date date,
  opening_year int, opening_cost numeric(20,0), opening_accumulated numeric(20,0), opening_remaining_units numeric(24,12),
  note text, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'fixed') = (depreciation_account_code IS NOT NULL)),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, category_id) REFERENCES asset_category (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id));
CREATE INDEX asset_kind ON asset (tenant_id, kind, code);

CREATE TABLE asset_allocation (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  asset_id bigint NOT NULL,
  valid_from_year int NOT NULL, valid_from_period int NOT NULL CHECK (valid_from_period BETWEEN 1 AND 12),
  expense_account_code text NOT NULL,
  department_id bigint, project_id bigint, cost_item_id bigint,
  ratio numeric(9,6) NOT NULL CHECK (ratio > 0 AND ratio <= 100),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES asset (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES project (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_item_id) REFERENCES cost_item (tenant_id, id));
CREATE INDEX asset_allocation_asset ON asset_allocation (tenant_id, asset_id, valid_from_year, valid_from_period);

ALTER TABLE voucher_line ADD FOREIGN KEY (tenant_id, asset_id) REFERENCES asset (tenant_id, id);
ALTER TABLE voucher_item_line ADD COLUMN asset_id bigint;
ALTER TABLE voucher_item_line ADD FOREIGN KEY (tenant_id, asset_id) REFERENCES asset (tenant_id, id);

SELECT rls_enable(t) FROM unnest(ARRAY['asset_category','asset','asset_allocation']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['asset_category','asset','asset_allocation']::regclass[]) AS t;

-- Chứng từ đảo chép asset_id của dòng hàng (giá vốn của dòng đảo vẫn ghi đúng tài sản).
DO $mig$
DECLARE d text; o text; n text;
BEGIN
  d := pg_get_functiondef('reverse_voucher(uuid, date, text)'::regprocedure);
  o := 'debit_account_id, credit_account_id, source_line_id)'; n := 'debit_account_id, credit_account_id, source_line_id, asset_id)';
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'reverse_voucher: không thấy đúng một chỗ danh sách cột dòng hàng'; END IF;
  d := replace(d, o, n);
  o := E'credit_account_id, debit_account_id, id\n  FROM voucher_item_line'; n := E'credit_account_id, debit_account_id, id, asset_id\n  FROM voucher_item_line';
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'reverse_voucher: không thấy đúng một chỗ SELECT dòng hàng'; END IF;
  EXECUTE replace(d, o, n);
END $mig$;
