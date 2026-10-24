-- GĐ5 Task 12: nhớ ánh xạ dòng hàng của hóa đơn đầu vào (theo MST người bán và tên hàng) sang vật tư, tài khoản, mã thuế khi lập chứng từ mua.
-- name_key = fn_invoice_key(tên hàng): hoa/thường và khoảng trắng không phân biệt.
CREATE TABLE inbound_item_map (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  seller_tax_code text NOT NULL,
  name_key text NOT NULL,
  item_id bigint,
  account_id bigint,
  tax_code_id bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, seller_tax_code, name_key),
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, account_id) REFERENCES account (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_code (tenant_id, id) ON DELETE CASCADE);
SELECT rls_enable('inbound_item_map');
SELECT audit_enable('inbound_item_map');
