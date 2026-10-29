-- TT 58/2026/TT-BTC (doanh nghiệp siêu nhỏ) Điều 9 khoản 1: sổ S4a-DNSN (công nợ), S4b-DNSN (TSCĐ), S4d-DNSN (vốn chủ sở hữu) và
-- "tài sản khác" (mã 150 của B01-DNSN, Điều 10 khoản 2.2.1). Cùng mô hình ghi sổ đơn của 0251 (không qua voucher/sổ cái bút toán kép).

-- S4a: khoản nợ phải thu (recv) hoặc phải trả (pay) theo đối tượng. kind: opening (số dư đầu), incur (phát sinh: số phải thu/phải trả),
-- settle (đã thu/đã trả). nature: tính chất khoản nợ; 'tax' chỉ ở bên phải trả (thuế TNCN, xuất nhập khẩu, TTĐB, tài nguyên, BVMT, sử dụng đất... ghi vào mã 320 của B01-DNSN).
CREATE TABLE book_debt (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entry_date date NOT NULL,
  doc_no text CHECK (doc_no IS NULL OR length(doc_no) <= 50),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  party text NOT NULL CHECK (length(btrim(party)) BETWEEN 1 AND 200),
  side text NOT NULL CHECK (side IN ('recv', 'pay')),
  kind text NOT NULL CHECK (kind IN ('opening', 'incur', 'settle')),
  nature text NOT NULL DEFAULT 'other' CHECK (nature IN ('trade', 'loan', 'advance', 'deposit', 'payroll', 'tax', 'other')),
  amount numeric(20,0) NOT NULL CHECK (amount > 0),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_user (tenant_id, user_id),
  CHECK (nature <> 'tax' OR side = 'pay'));
CREATE INDEX book_debt_party ON book_debt (tenant_id, party, entry_date, id);

-- S4b: thẻ TSCĐ một dòng một tài sản. in_use_month là ngày đầu tháng đưa vào sử dụng; dep_rate là tỷ lệ khấu hao hằng năm (%).
CREATE TABLE book_fixed_asset (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  asset_type text NOT NULL CHECK (length(btrim(asset_type)) BETWEEN 1 AND 100),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  inc_doc_no text CHECK (inc_doc_no IS NULL OR length(inc_doc_no) <= 50),
  inc_date date NOT NULL,
  in_use_month date NOT NULL CHECK (extract(day FROM in_use_month) = 1),
  cost numeric(20,0) NOT NULL CHECK (cost > 0),
  dep_rate numeric(7,4) NOT NULL CHECK (dep_rate BETWEEN 0 AND 100),
  dec_doc_no text CHECK (dec_doc_no IS NULL OR length(dec_doc_no) <= 50),
  dec_date date,
  dec_reason text CHECK (dec_reason IS NULL OR length(btrim(dec_reason)) BETWEEN 1 AND 300),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_user (tenant_id, user_id),
  CHECK ((dec_date IS NULL) = (dec_reason IS NULL)),
  CHECK (dec_date IS NULL OR dec_date >= inc_date),
  CHECK (dec_doc_no IS NULL OR dec_date IS NOT NULL));
CREATE INDEX book_fixed_asset_type ON book_fixed_asset (tenant_id, asset_type, inc_date, id);

-- S4d: vốn chủ sở hữu theo ba phần (capital = vốn góp, retained = lợi nhuận sau thuế chưa phân phối, funds = các quỹ thuộc vốn chủ sở hữu).
-- Chỉ số dư đầu của lợi nhuận chưa phân phối được âm (lỗ lũy kế); mọi dòng khác dương.
CREATE TABLE book_equity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entry_date date NOT NULL,
  doc_no text CHECK (doc_no IS NULL OR length(doc_no) <= 50),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  section text NOT NULL CHECK (section IN ('capital', 'retained', 'funds')),
  kind text NOT NULL CHECK (kind IN ('opening', 'increase', 'decrease')),
  amount numeric(20,0) NOT NULL CHECK (amount > 0 OR (kind = 'opening' AND section = 'retained' AND amount <> 0)),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_user (tenant_id, user_id));
CREATE INDEX book_equity_date ON book_equity (tenant_id, section, entry_date, id);

-- Tài sản khác (mã 150): tiền gửi có kỳ hạn, tiền gửi tiết kiệm... Tăng cộng, giảm trừ; số dư đầu cộng như tăng.
CREATE TABLE book_other_asset (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entry_date date NOT NULL,
  doc_no text CHECK (doc_no IS NULL OR length(doc_no) <= 50),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  kind text NOT NULL CHECK (kind IN ('opening', 'increase', 'decrease')),
  amount numeric(20,0) NOT NULL CHECK (amount > 0),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_user (tenant_id, user_id));
CREATE INDEX book_other_asset_date ON book_other_asset (tenant_id, entry_date, id);

SELECT rls_enable(t), audit_enable(t) FROM unnest(ARRAY['book_debt', 'book_fixed_asset', 'book_equity', 'book_other_asset']::regclass[]) AS t;
