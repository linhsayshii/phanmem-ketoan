-- GĐ2 Task 26: khử trùng chứng từ. voucher_dup_rule là cấu hình cặp loại chứng từ hay bị nhập trùng (mỗi cặp một quy tắc, tùy chỉnh được qua danh mục);
-- voucher_dup_ignore ghi cặp người dùng đã xác nhận "không trùng" (voucher_a < voucher_b để một cặp chỉ có một dòng). Xử lý trùng dùng hành động chứng từ sẵn có, không thêm logic ghi sổ.
CREATE TABLE voucher_dup_rule (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  type_a text NOT NULL,
  type_b text NOT NULL,
  days_window int NOT NULL DEFAULT 3 CHECK (days_window BETWEEN 0 AND 31),
  match_party boolean NOT NULL DEFAULT true,
  match_counter_account boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, type_a, type_b),
  FOREIGN KEY (tenant_id, type_a) REFERENCES voucher_type(tenant_id, code),
  FOREIGN KEY (tenant_id, type_b) REFERENCES voucher_type(tenant_id, code));
SELECT rls_enable('voucher_dup_rule');
SELECT audit_enable('voucher_dup_rule');

CREATE TABLE voucher_dup_ignore (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  voucher_a uuid NOT NULL,
  voucher_b uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, voucher_a, voucher_b),
  CHECK (voucher_a < voucher_b),
  FOREIGN KEY (tenant_id, voucher_a) REFERENCES voucher(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, voucher_b) REFERENCES voucher(tenant_id, id) ON DELETE CASCADE);
SELECT rls_enable('voucher_dup_ignore');
SELECT audit_enable('voucher_dup_ignore');
-- Khóa chính chỉ phủ voucher_a đứng đầu; tra cặp theo voucher_b (xóa nháp kéo theo CASCADE) cần chỉ mục riêng.
CREATE INDEX voucher_dup_ignore_b ON voucher_dup_ignore (tenant_id, voucher_b);

-- Sáu cặp mặc định. Chỉ gieo cặp mà cả hai loại chứng từ có trong công ty (công ty cũ có thể chưa có đủ loại).
CREATE OR REPLACE FUNCTION seed_dup_rules(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO voucher_dup_rule(tenant_id, type_a, type_b)
  SELECT p_tenant, d.a, d.b FROM (VALUES ('PC','BN'), ('PT','BC'), ('HDM','PC'), ('HDM','BN'), ('PKT','PC'), ('PKT','PT')) d(a, b)
  WHERE EXISTS (SELECT 1 FROM voucher_type t WHERE t.tenant_id = p_tenant AND t.code = d.a) AND EXISTS (SELECT 1 FROM voucher_type t WHERE t.tenant_id = p_tenant AND t.code = d.b)
  ON CONFLICT (tenant_id, type_a, type_b) DO NOTHING
$$;
REVOKE EXECUTE ON FUNCTION seed_dup_rules(uuid) FROM PUBLIC, app_user;

-- Định nghĩa lại seed_tenant_defaults từ thân hiện hành (0035), chỉ thêm dòng PERFORM seed_dup_rules.
CREATE OR REPLACE FUNCTION public.seed_tenant_defaults(p_tenant uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO currency(tenant_id, code, name, symbol, minor_unit) VALUES (p_tenant, 'VND', 'Đồng Việt Nam', '₫', 0), (p_tenant, 'USD', 'Đô la Mỹ', '$', 2);
  INSERT INTO payment_method(tenant_id, code, name) VALUES (p_tenant, 'TM', 'Tiền mặt'), (p_tenant, 'CK', 'Chuyển khoản'), (p_tenant, 'TM/CK', 'Tiền mặt hoặc chuyển khoản');
  INSERT INTO tax_code(tenant_id, code, name, kind, rate, is_exempt, in_declaration, method) VALUES
    (p_tenant, 'V0', 'Thuế GTGT 0%', 'vat', 0, false, true, 'deduct'), (p_tenant, 'V5', 'Thuế GTGT 5%', 'vat', 5, false, true, 'deduct'),
    (p_tenant, 'V8', 'Thuế GTGT 8% (giảm theo NQ 204/2025)', 'vat', 8, false, true, 'deduct'), (p_tenant, 'V10', 'Thuế GTGT 10%', 'vat', 10, false, true, 'deduct'),
    (p_tenant, 'KCT', 'Không chịu thuế GTGT', 'vat', NULL, true, true, 'none'), (p_tenant, 'KKK', 'Không kê khai, tính nộp thuế GTGT', 'vat', NULL, true, false, 'none'),
    (p_tenant, 'NK', 'Thuế nhập khẩu', 'import', NULL, false, false, 'deduct'), (p_tenant, 'TTDB', 'Thuế tiêu thụ đặc biệt', 'excise', NULL, false, false, 'deduct');
  INSERT INTO invoice_group(tenant_id, scope, code, name, rate) VALUES
    (p_tenant, 'purchase', '01', 'HHDV dùng riêng cho SXKD chịu thuế GTGT đủ điều kiện khấu trừ', NULL),
    (p_tenant, 'purchase', '02', 'HHDV dùng riêng cho SXKD không chịu thuế GTGT', NULL),
    (p_tenant, 'purchase', '03', 'HHDV dùng chung cho SXKD chịu thuế và không chịu thuế', NULL),
    (p_tenant, 'purchase', '04', 'HHDV dùng cho dự án đầu tư', NULL),
    (p_tenant, 'purchase', '05', 'HHDV không đủ điều kiện khấu trừ / không tổng hợp lên tờ khai', NULL),
    (p_tenant, 'sale', '00', 'Bán ra chịu thuế suất 0%', 0), (p_tenant, 'sale', '05', 'Bán ra chịu thuế suất 5%', 5),
    (p_tenant, 'sale', '08', 'Bán ra chịu thuế suất 8%', 8), (p_tenant, 'sale', '10', 'Bán ra chịu thuế suất 10%', 10),
    (p_tenant, 'sale', 'KCT', 'Bán ra không chịu thuế', NULL),
    (p_tenant, 'sale', 'KKK', 'Không kê khai, tính nộp thuế GTGT', NULL),
    (p_tenant, 'sale', 'KTGT', 'Không tính vào giá tính thuế GTGT', NULL),
    (p_tenant, 'sale', 'NPV', 'Không thuộc phạm vi điều chỉnh của pháp luật thuế GTGT', NULL);
  INSERT INTO uom(tenant_id, code, name) VALUES (p_tenant, 'CAI', 'Cái'), (p_tenant, 'CHIEC', 'Chiếc'), (p_tenant, 'BO', 'Bộ'), (p_tenant, 'GIO', 'Giờ'), (p_tenant, 'THANG', 'Tháng');
  PERFORM seed_voucher_types(p_tenant);
  PERFORM seed_data_check_rules(p_tenant);
  PERFORM seed_tax_defaults(p_tenant); -- động cơ thuế: TNCN_KT và phân bổ mặc định
  PERFORM seed_dup_rules(p_tenant); -- cặp loại chứng từ khử trùng mặc định
END $function$;

-- Công ty đã có: gieo bù (tắt nhật ký vì migration không có người dùng, như 0031).
ALTER TABLE voucher_dup_rule DISABLE TRIGGER trg_audit;
SELECT seed_dup_rules(id) FROM tenant;
ALTER TABLE voucher_dup_rule ENABLE TRIGGER trg_audit;
