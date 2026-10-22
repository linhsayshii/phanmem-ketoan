-- GĐ3 Task 16: kiểm kê kho. Phiếu nhập/xuất điều chỉnh sinh ra là chứng từ kho thật (voucher.source_doc_type = 'stocktake'); liên kết qua bảng stocktake_voucher (khóa ngoại tổng hợp) thay cho mảng uuid.
CREATE TABLE stocktake (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  seq bigint GENERATED ALWAYS AS IDENTITY, -- số hiển thị của biên bản
  doc_date date NOT NULL, warehouse_id bigint NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','adjusted','cancelled')),
  note text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), adjusted_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id));
CREATE INDEX stocktake_list ON stocktake (tenant_id, doc_date DESC);

CREATE TABLE stocktake_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  stocktake_id uuid NOT NULL, item_id bigint NOT NULL, lot_no text,
  book_qty numeric(20,4) NOT NULL, counted_qty numeric(20,4) CHECK (counted_qty IS NULL OR counted_qty >= 0),
  diff_qty numeric(20,4) GENERATED ALWAYS AS (counted_qty - book_qty) STORED, -- theo ĐVT cơ sở; NULL khi chưa đếm
  reason text CHECK (reason IS NULL OR reason IN ('unknown','income','cogs','loss')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, stocktake_id) REFERENCES stocktake (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id));
CREATE UNIQUE INDEX stocktake_line_key ON stocktake_line (tenant_id, stocktake_id, item_id, (coalesce(lot_no, '')));

CREATE TABLE stocktake_voucher (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  stocktake_id uuid NOT NULL, voucher_id uuid NOT NULL,
  UNIQUE (tenant_id, stocktake_id, voucher_id),
  FOREIGN KEY (tenant_id, stocktake_id) REFERENCES stocktake (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id));

SELECT rls_enable(t) FROM unnest(ARRAY['stocktake','stocktake_line','stocktake_voucher']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['stocktake','stocktake_line','stocktake_voucher']::regclass[]) AS t;
