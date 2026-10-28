-- GĐ7 nhóm 6b: sổ kế toán hộ kinh doanh (TT 152/2025) và doanh nghiệp siêu nhỏ (TT 58/2026). Hai thông tư không có hệ thống tài khoản:
-- ghi sổ đơn theo phương pháp nộp thuế, không qua voucher/sổ cái bút toán kép. Mọi tỷ lệ thuế do người dùng khai báo, không đặt sẵn.
INSERT INTO permission(code, name, group_name) VALUES
  ('sohkd.view', 'Xem sổ hộ kinh doanh, doanh nghiệp siêu nhỏ', 'Sổ HKD, siêu nhỏ'),
  ('sohkd.create', 'Ghi sổ hộ kinh doanh, doanh nghiệp siêu nhỏ', 'Sổ HKD, siêu nhỏ'),
  ('sohkd.update', 'Sửa bút ghi sổ hộ kinh doanh, doanh nghiệp siêu nhỏ', 'Sổ HKD, siêu nhỏ'),
  ('sohkd.delete', 'Xóa bút ghi sổ hộ kinh doanh, doanh nghiệp siêu nhỏ', 'Sổ HKD, siêu nhỏ'),
  ('sohkd.config', 'Cấu hình nhóm ngành nghề, tỷ lệ thuế, phương pháp nộp thuế', 'Sổ HKD, siêu nhỏ')
ON CONFLICT (code) DO NOTHING;

-- Nhóm hàng hóa, dịch vụ, ngành nghề có cùng tỷ lệ % tính thuế (TT152 Điều 5, TT58 Điều 5 đến 7). Tỷ lệ là số phần trăm, ví dụ 1.5 = 1,5%.
CREATE TABLE book_group (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,20}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  vat_rate numeric(7,4) CHECK (vat_rate BETWEEN 0 AND 100),
  income_rate numeric(7,4) CHECK (income_rate BETWEEN 0 AND 100),
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code));

-- Phương pháp nộp thuế của năm tài chính (quyết định bộ sổ nào dùng) và thuế suất áp lên thu nhập tính thuế (TNCN của hộ, TNDN của doanh nghiệp).
CREATE TABLE book_year_setting (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  fiscal_year int NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  tax_method text NOT NULL CHECK (tax_method IN ('exempt', 'percent', 'income', 'percent_both', 'vat_percent_cit_profit', 'vat_deduct_cit_percent', 'vat_deduct_cit_profit')),
  income_tax_rate numeric(7,4) CHECK (income_tax_rate BETWEEN 0 AND 100),
  PRIMARY KEY (tenant_id, fiscal_year));

-- Bút ghi sổ đơn. kind: revenue (doanh thu theo nhóm), other_income (thu nhập khác), expense (chi phí a đến e, đ viết dd), tax_paid (thuế đã nộp),
-- vat_input/vat_output/vat_refund (S3b-DNSN), cash_in/cash_out (thu chi tiền không kèm doanh thu, chi phí), opening (số dư đầu).
CREATE TABLE book_entry (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entry_date date NOT NULL,
  doc_no text CHECK (doc_no IS NULL OR length(doc_no) <= 50),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  kind text NOT NULL CHECK (kind IN ('revenue', 'other_income', 'expense', 'tax_paid', 'vat_input', 'vat_output', 'vat_refund', 'cash_in', 'cash_out', 'opening')),
  amount numeric(20,0) NOT NULL CHECK (amount >= 0),
  group_id bigint,
  expense_cat text CHECK (expense_cat IN ('a', 'b', 'c', 'd', 'dd', 'e')),
  tax_type text CHECK (tax_type IN ('vat', 'income')),
  opening_ref text CHECK (opening_ref IN ('cash', 'vat_payable', 'vat_credit', 'income_tax')),
  -- 'TM' = tiền mặt; tên khác = tiền gửi không kỳ hạn tại ngân hàng đó. Có giá trị thì bút ghi xuất hiện trên sổ chi tiết tiền.
  money_account text CHECK (money_account IS NULL OR length(btrim(money_account)) BETWEEN 1 AND 100),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, group_id) REFERENCES book_group (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_user (tenant_id, user_id),
  CHECK ((kind = 'revenue') = (group_id IS NOT NULL)),
  CHECK ((kind = 'expense') = (expense_cat IS NOT NULL)),
  CHECK ((kind = 'tax_paid') = (tax_type IS NOT NULL)),
  CHECK ((kind = 'opening') = (opening_ref IS NOT NULL)),
  CHECK (kind NOT IN ('cash_in', 'cash_out') OR money_account IS NOT NULL),
  CHECK (kind <> 'opening' OR opening_ref <> 'cash' OR money_account IS NOT NULL),
  CHECK (kind = 'opening' OR amount > 0));
CREATE INDEX book_entry_date ON book_entry (tenant_id, entry_date, id);

-- Sổ chi tiết vật liệu, dụng cụ, sản phẩm, hàng hóa (S2d-HKD, S2c-DNSN): mặt hàng và các lần nhập, xuất, tồn đầu.
CREATE TABLE book_stock_item (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,30}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  unit text NOT NULL CHECK (length(btrim(unit)) BETWEEN 1 AND 20),
  warehouse text CHECK (warehouse IS NULL OR length(warehouse) <= 100),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code));
CREATE TABLE book_stock_move (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  item_id bigint NOT NULL,
  move_date date NOT NULL,
  doc_no text CHECK (doc_no IS NULL OR length(doc_no) <= 50),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  direction text NOT NULL CHECK (direction IN ('opening', 'in', 'out')),
  quantity numeric(20,4) NOT NULL CHECK (quantity > 0),
  -- Đơn giá nhập (và tồn đầu); dòng xuất không có đơn giá, tính theo công thức bình quân của thông tư.
  unit_price numeric(20,4) CHECK (unit_price >= 0),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES book_stock_item (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_user (tenant_id, user_id),
  CHECK ((direction = 'out') = (unit_price IS NULL)));
CREATE INDEX book_stock_move_item ON book_stock_move (tenant_id, item_id, move_date, id);

-- Sổ theo dõi nghĩa vụ thuế khác (S3a-HKD, S4c-DNSN). Công thức theo thông tư; `rate_pct` là phần trăm.
CREATE TABLE book_other_tax (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entry_date date NOT NULL,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  tax_kind text NOT NULL CHECK (tax_kind IN ('xnk_ttdb', 'env', 'resource', 'land', 'other')),
  quantity numeric(20,4) CHECK (quantity >= 0),
  abs_rate numeric(20,4) CHECK (abs_rate >= 0),
  unit_price numeric(20,4) CHECK (unit_price >= 0),
  rate_pct numeric(9,4) CHECK (rate_pct BETWEEN 0 AND 1000),
  other_amount numeric(20,0) CHECK (other_amount >= 0),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_user (tenant_id, user_id),
  CHECK ((tax_kind = 'other') = (other_amount IS NOT NULL)));
CREATE INDEX book_other_tax_date ON book_other_tax (tenant_id, entry_date, id);

SELECT rls_enable(t), audit_enable(t) FROM unnest(ARRAY['book_group', 'book_year_setting', 'book_entry', 'book_stock_item', 'book_stock_move', 'book_other_tax']::regclass[]) AS t;

ALTER TABLE role_permission DISABLE TRIGGER trg_audit;
INSERT INTO role_permission(tenant_id, role_id, permission_code)
  SELECT r.tenant_id, r.id, np.code
  FROM role r CROSS JOIN (SELECT code FROM permission WHERE code LIKE 'sohkd.%') AS np
  WHERE r.code IN ('admin', 'ketoan_truong', 'ketoan_vien') OR (r.code = 'xem' AND np.code LIKE '%.view')
  ON CONFLICT DO NOTHING;
ALTER TABLE role_permission ENABLE TRIGGER trg_audit;
