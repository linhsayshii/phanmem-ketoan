-- GĐ2 Task 17: động cơ thuế. Bảng tax_code hiện có là bảng `tax` của đặc tả (mục 6 "Thuế"), không tạo bảng trùng: thêm phạm vi mua/bán, phương pháp tính,
-- giá đã gồm thuế, loại thuế TNCN; phân bổ thuế (tax_distribution) theo loại chứng từ, mua/bán, dòng cơ sở/dòng thuế; thuế khấu trừ tại nguồn là phân bổ âm.
-- Thân seed_tenant_defaults lấy từ định nghĩa hiện hành (pg_get_functiondef) sau 0030, chỉ thêm method của KCT/KKK và lệnh gọi seed_tax_defaults.

-- 1) Mã thuế. method: 'deduct' khấu trừ, 'direct' GTGT trực tiếp trên doanh thu (không sinh thuế trên hóa đơn), 'none' không tính thuế (không chịu thuế, không kê khai).
ALTER TABLE tax_code
  ADD COLUMN scope text NOT NULL DEFAULT 'both' CHECK (scope IN ('sale', 'purchase', 'both')),
  ADD COLUMN method text NOT NULL DEFAULT 'deduct' CHECK (method IN ('deduct', 'direct', 'none')),
  ADD COLUMN price_include boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT tax_code_tenant_id_id_key UNIQUE (tenant_id, id),
  DROP CONSTRAINT tax_code_kind_check,
  ADD CONSTRAINT tax_code_kind_check CHECK (kind IN ('vat', 'pit', 'import', 'excise'));

-- 2) Phân bổ thuế: dòng 'tax' ghi factor_percent % số thuế vào account_code (âm: khấu trừ tại nguồn); dòng 'base' chỉ gắn nhãn báo cáo cho cơ sở tính thuế.
-- account_code là mã tài khoản (hệ tài khoản theo chế độ của năm), kiểm khi lập bút toán. NULLS NOT DISTINCT: hai dòng cơ sở không tài khoản cũng là trùng.
CREATE TABLE tax_distribution (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  tax_code_id bigint NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('invoice', 'refund')),
  scope text NOT NULL CHECK (scope IN ('sale', 'purchase')),
  line_type text NOT NULL CHECK (line_type IN ('base', 'tax')),
  factor_percent numeric(7,4) NOT NULL,
  account_code text,
  report_tag text,
  CHECK (line_type = 'base' OR account_code IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (tenant_id, tax_code_id, document_type, scope, line_type, account_code),
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_code(tenant_id, id) ON DELETE CASCADE); -- danh mục con như party_bank_account
SELECT rls_enable('tax_distribution');
-- audit_enable('tax_distribution') đặt sau chèn bù (mục 4): migration không ghi nhật ký không có người dùng.

-- 3) Phân bổ mặc định: GTGT mua vào 1331 (purchase_tax), bán ra 33311 (sale_tax), giảm giá/trả lại cùng tài khoản; TNCN khấu trừ tại nguồn -100% vào 3335.
-- TNCN_KT không gieo thuế suất (người dùng nhập; Luật Thuế TNCN 109/2025 chưa có văn bản gốc). Mã GTGT trực tiếp không gieo: người dùng tự tạo mã method 'direct'.
CREATE OR REPLACE FUNCTION seed_tax_defaults(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO tax_code(tenant_id, code, name, kind, rate, scope) VALUES (p_tenant, 'TNCN_KT', 'Khấu trừ thuế TNCN tại nguồn', 'pit', NULL, 'purchase')
  ON CONFLICT (tenant_id, code) DO NOTHING;
  INSERT INTO tax_distribution(tenant_id, tax_code_id, document_type, scope, line_type, factor_percent, account_code, report_tag)
  SELECT p_tenant, c.id, d.document_type, s.scope, 'tax', 100, s.account_code, s.report_tag
  FROM tax_code c CROSS JOIN (VALUES ('invoice'), ('refund')) d(document_type)
  CROSS JOIN (VALUES ('purchase', '1331', 'purchase_tax'), ('sale', '33311', 'sale_tax')) s(scope, account_code, report_tag)
  WHERE c.tenant_id = p_tenant AND c.code IN ('V0', 'V5', 'V8', 'V10')
  UNION ALL
  SELECT p_tenant, c.id, d.document_type, 'purchase', 'tax', -100, '3335', NULL
  FROM tax_code c CROSS JOIN (VALUES ('invoice'), ('refund')) d(document_type)
  WHERE c.tenant_id = p_tenant AND c.code = 'TNCN_KT'
  ON CONFLICT DO NOTHING;
$$;
-- Như seed_voucher_types (0004): chỉ create_tenant (SECURITY DEFINER) gọi; app_user có EXECUTE từ ALTER DEFAULT PRIVILEGES của 0001 nên phải thu riêng.
REVOKE EXECUTE ON FUNCTION seed_tax_defaults(uuid) FROM PUBLIC, app_user;

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
    (p_tenant, 'sale', 'KCT', 'Bán ra không chịu thuế', NULL);
  INSERT INTO uom(tenant_id, code, name) VALUES (p_tenant, 'CAI', 'Cái'), (p_tenant, 'CHIEC', 'Chiếc'), (p_tenant, 'BO', 'Bộ'), (p_tenant, 'GIO', 'Giờ'), (p_tenant, 'THANG', 'Tháng');
  PERFORM seed_voucher_types(p_tenant);
  PERFORM seed_data_check_rules(p_tenant);
  PERFORM seed_tax_defaults(p_tenant); -- động cơ thuế: TNCN_KT và phân bổ mặc định
END $function$;

-- 4) Công ty đã có: mã không chịu thuế/không kê khai không tính thuế, thêm TNCN_KT và phân bổ mặc định. Tắt audit như 0025 (migration không có người dùng).
ALTER TABLE tax_code DISABLE TRIGGER trg_audit;
UPDATE tax_code SET method = 'none' WHERE is_exempt AND method = 'deduct';
SELECT seed_tax_defaults(id) FROM tenant;
ALTER TABLE tax_code ENABLE TRIGGER trg_audit;
SELECT audit_enable('tax_distribution');

-- 5) Tham số pháp lý: một dòng cho mỗi (mã, ngày hiệu lực); syncReferenceData upsert theo khóa này từ packages/coa-data/data/tax/legal-params.json.
DROP INDEX legal_param_code_valid_from_idx;
ALTER TABLE legal_param ADD CONSTRAINT legal_param_code_valid_from_key UNIQUE (code, valid_from);
