-- GĐ3 Task 9: tồn kho đầu kỳ theo (năm, hàng, kho, lô). quantity theo ĐVT cơ sở của hàng; value là giá trị VND của dòng.
-- Chứng từ DK sinh dòng sổ cái 15x mang hàng/kho và dòng hàng chiều nhập để fn_stock_moves_create tạo phát sinh và lớp giá.
CREATE TABLE opening_stock (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  fiscal_year int NOT NULL,
  item_id bigint NOT NULL, warehouse_id bigint NOT NULL,
  lot_no text NOT NULL DEFAULT '', expiry_date date,
  quantity numeric(20,4) NOT NULL CHECK (quantity > 0),
  value numeric(20,0) NOT NULL DEFAULT 0 CHECK (value >= 0),
  UNIQUE (tenant_id, fiscal_year, item_id, warehouse_id, lot_no),
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id));
SELECT rls_enable('opening_stock'), audit_enable('opening_stock');
