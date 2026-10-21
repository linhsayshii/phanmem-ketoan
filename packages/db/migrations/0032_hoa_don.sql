-- GĐ2 Task 18: hóa đơn mua/bán dịch vụ, giảm giá, trả lại. Dòng hàng/dịch vụ của hóa đơn (voucher_item_line) và bảng kê hóa đơn kê khai thuế (voucher_invoice):
-- một dòng mỗi (hóa đơn, mã thuế); hóa đơn đầu vào trả tiền ngay trên PC/BN/PKT cũng lưu ở đây (không sinh bút toán). Cả hai là nội dung kèm theo của chứng từ: chỉ ghi khi chứng từ còn nháp.

-- 1) Bảng con chỉ ghi được khi chứng từ cha còn nháp (hoặc đang bỏ ghi sổ). Định nghĩa lại từ thân cuối cùng ở 0029 (cho settlement_plan): đổi mã lỗi sang VOUCHER_CHILD_IMMUTABLE
-- theo đặc tả và cho qua khi app.unposting = 'on'. Chứng từ không còn thấy (đang bị xóa, xóa dây chuyền) thì cho qua.
CREATE OR REPLACE FUNCTION fn_voucher_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  IF current_setting('app.unposting', true) = 'on' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT state INTO v_state FROM voucher WHERE id = NEW.voucher_id;
    IF FOUND AND v_state <> 'draft' THEN RAISE EXCEPTION 'VOUCHER_CHILD_IMMUTABLE: chứng từ không còn là nháp (trạng thái %), không sửa được hóa đơn; chứng từ đã ghi sổ thì bỏ ghi sổ trước', v_state USING ERRCODE = 'P0001'; END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT state INTO v_state FROM voucher WHERE id = OLD.voucher_id;
    IF FOUND AND v_state <> 'draft' THEN RAISE EXCEPTION 'VOUCHER_CHILD_IMMUTABLE: chứng từ không còn là nháp (trạng thái %), không sửa được hóa đơn; chứng từ đã ghi sổ thì bỏ ghi sổ trước', v_state USING ERRCODE = 'P0001'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- 2) Đích tham chiếu tổng hợp (tenant_id, id) cho danh mục chưa có.
ALTER TABLE uom ADD CONSTRAINT uom_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE invoice_group ADD CONSTRAINT invoice_group_tenant_id_id_key UNIQUE (tenant_id, id);

-- 3) Dòng hàng hóa, dịch vụ của hóa đơn. item_id chờ danh mục hàng hóa (GĐ3) nên chưa có khóa ngoại.
-- amount/discount_amount là VND của tiền hàng và chiết khấu theo tỷ giá chứng từ, chỉ mang tính tham khảo: với ngoại tệ, bút toán còn chia chênh làm tròn ±1 đồng nên tổng các dòng hàng có thể lệch sổ vài đồng.
-- tax_amount là VND thuế (không kể thuế khấu trừ tại nguồn) của dòng, đã dồn chênh để tổng theo mã thuế đúng bằng dòng thuế đã ghi sổ. Báo cáo và đối chiếu kê khai lấy số ở voucher_invoice, không cộng dòng hàng.
CREATE TABLE voucher_item_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  voucher_id uuid NOT NULL,
  line_no int NOT NULL CHECK (line_no > 0),
  description text,
  item_id bigint,
  uom_id bigint,
  quantity numeric(20,4),
  unit_price numeric(20,4),
  amount_currency numeric(20,4) NOT NULL,
  amount numeric(20,0) NOT NULL,
  discount_rate numeric(7,4) NOT NULL DEFAULT 0 CHECK (discount_rate BETWEEN 0 AND 100),
  discount_amount_currency numeric(20,4) NOT NULL DEFAULT 0,
  discount_amount numeric(20,0) NOT NULL DEFAULT 0,
  tax_codes text[] NOT NULL DEFAULT '{}',
  tax_amount numeric(20,0) NOT NULL DEFAULT 0,
  account_id bigint NOT NULL,
  department_id bigint,
  project_id bigint,
  cost_item_id bigint,
  UNIQUE (tenant_id, voucher_id, line_no),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher(tenant_id, id) ON DELETE CASCADE, -- xóa nháp thì bỏ dòng hàng
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uom(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES account(tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES project(tenant_id, id),
  FOREIGN KEY (tenant_id, cost_item_id) REFERENCES cost_item(tenant_id, id));
SELECT rls_enable('voucher_item_line');
SELECT audit_enable('voucher_item_line');
CREATE TRIGGER trg_voucher_item_line_guard BEFORE INSERT OR UPDATE OR DELETE ON voucher_item_line FOR EACH ROW EXECUTE FUNCTION fn_voucher_child_guard();

-- 4) Bảng kê hóa đơn: một dòng mỗi (hóa đơn, mã thuế). base_amount/tax_amount là VND theo bút toán đã lập (cơ sở sau chiết khấu; thuế GTGT của mã đó).
-- Hóa đơn giảm giá, trả lại ghi số dương, adjusts_invoice_id trỏ về một dòng của hóa đơn gốc. declare_period: tháng 1-12 hoặc quý 1-4 theo kỳ khai của công ty (tenant_setting vat_period).
CREATE TABLE voucher_invoice (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  voucher_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('purchase', 'sale')),
  form_no text,
  serial text,
  invoice_no text NOT NULL CHECK (btrim(invoice_no) <> ''),
  invoice_date date NOT NULL,
  party_id uuid,
  party_name text,
  party_tax_code text,
  party_address text,
  invoice_group_id bigint,
  tax_code_id bigint,
  base_amount numeric(20,0) NOT NULL CHECK (base_amount >= 0),
  tax_amount numeric(20,0) NOT NULL CHECK (tax_amount >= 0),
  is_import boolean NOT NULL DEFAULT false,
  adjusts_invoice_id bigint,
  declare_year int,
  declare_period int CHECK (declare_period BETWEEN 1 AND 12),
  note text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, party_id) REFERENCES party(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_group_id) REFERENCES invoice_group(tenant_id, id),
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_code(tenant_id, id),
  FOREIGN KEY (tenant_id, adjusts_invoice_id) REFERENCES voucher_invoice(tenant_id, id));
CREATE INDEX voucher_invoice_voucher ON voucher_invoice (tenant_id, voucher_id);
CREATE INDEX voucher_invoice_adjusts ON voucher_invoice (tenant_id, adjusts_invoice_id) WHERE adjusts_invoice_id IS NOT NULL;
-- Khóa so trùng hóa đơn: hoa và thường như nhau và bỏ mọi khoảng trắng. Dịch vụ kiểm trùng dùng đúng hàm này nên khớp với chỉ mục.
CREATE FUNCTION fn_invoice_key(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT regexp_replace(upper(coalesce(t, '')), '\s', '', 'g') $$;
CREATE INDEX voucher_invoice_dup ON voucher_invoice (tenant_id, direction, fn_invoice_key(party_tax_code), fn_invoice_key(serial), fn_invoice_key(invoice_no));
SELECT rls_enable('voucher_invoice');
SELECT audit_enable('voucher_invoice');
CREATE TRIGGER trg_voucher_invoice_guard BEFORE INSERT OR UPDATE OR DELETE ON voucher_invoice FOR EACH ROW EXECUTE FUNCTION fn_voucher_child_guard();

-- 5) Khoản công nợ trỏ về hóa đơn (cột invoice_id có từ 0028, khóa ngoại chờ bảng này).
ALTER TABLE open_item ADD FOREIGN KEY (tenant_id, invoice_id) REFERENCES voucher_invoice(tenant_id, id);
