-- GĐ3 Task 14: hợp đồng, báo giá, đơn bán, đơn mua và liên kết đơn với chứng từ BH/MH nháp sinh ra. Không ghi sổ cái, không stock_move.

CREATE TABLE contract (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL,
  party_id uuid,
  kind text NOT NULL CHECK (kind IN ('sale','purchase')),
  signed_date date, valid_to date,
  value numeric(20,0) NOT NULL DEFAULT 0 CHECK (value >= 0),
  currency_code char(3) NOT NULL DEFAULT 'VND',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','expired','terminated')),
  note text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  CHECK (valid_to IS NULL OR signed_date IS NULL OR valid_to >= signed_date),
  FOREIGN KEY (tenant_id, party_id) REFERENCES party (tenant_id, id),
  FOREIGN KEY (tenant_id, currency_code) REFERENCES currency (tenant_id, code));

CREATE TABLE doc_order_counter (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('quote','sale_order','purchase_order')),
  fiscal_year int NOT NULL, last_no int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, kind, fiscal_year));

CREATE TABLE doc_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('quote','sale_order','purchase_order')),
  doc_no text NOT NULL, doc_date date NOT NULL,
  party_id uuid NOT NULL, contract_id bigint,
  currency_code char(3) NOT NULL DEFAULT 'VND', fx_rate numeric(20,10),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','partial','done','cancelled')),
  note text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, kind, doc_no),
  FOREIGN KEY (tenant_id, party_id) REFERENCES party (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contract (tenant_id, id),
  FOREIGN KEY (tenant_id, currency_code) REFERENCES currency (tenant_id, code));
CREATE INDEX doc_order_list ON doc_order (tenant_id, kind, doc_date DESC);

CREATE TABLE doc_order_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  order_id uuid NOT NULL, line_no int NOT NULL,
  item_id bigint NOT NULL, uom_id bigint NOT NULL, warehouse_id bigint,
  quantity numeric(20,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(20,4) NOT NULL CHECK (unit_price >= 0),
  discount_rate numeric(7,4) NOT NULL DEFAULT 0 CHECK (discount_rate >= 0 AND discount_rate <= 100),
  tax_code text,
  delivered_qty numeric(20,4) NOT NULL DEFAULT 0 CHECK (delivered_qty >= 0),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, order_id, line_no),
  FOREIGN KEY (tenant_id, order_id) REFERENCES doc_order (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uom (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id));

-- Đơn đã chuyển thành chứng từ nào, số lượng bao nhiêu; delivered_qty của dòng đơn tính lại từ đây ở dịch vụ.
CREATE TABLE doc_order_link (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  order_line_id bigint NOT NULL, voucher_id uuid NOT NULL,
  quantity numeric(20,4) NOT NULL CHECK (quantity > 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES doc_order_line (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id));
CREATE INDEX doc_order_link_voucher ON doc_order_link (tenant_id, voucher_id);

ALTER TABLE voucher_line ADD FOREIGN KEY (tenant_id, contract_id) REFERENCES contract (tenant_id, id);

SELECT rls_enable(t) FROM unnest(ARRAY['contract','doc_order_counter','doc_order','doc_order_line','doc_order_link']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['contract','doc_order','doc_order_line','doc_order_link']::regclass[]) AS t;
