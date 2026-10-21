-- GĐ2 Task 23: tờ khai thuế (01/GTGT) và nhóm kê khai bán ra còn thiếu của mẫu TT 89/2026.
-- Mỗi kỳ (năm, tháng/quý) có lần đầu (revision 0) và các lần bổ sung (revision n); values là số chỉ tiêu đã tính (chuỗi số nguyên VND, [21] là 'X' hoặc rỗng),
-- overrides là chỉ tiêu người dùng ghi đè (chỉ chỉ tiêu overridable của mẫu). Tờ khai đã chốt (final) không sửa, không xóa: trigger chặn (TAX_RETURN_FINAL).
CREATE TABLE tax_return (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  form_code text NOT NULL,
  template_version text NOT NULL,
  period_kind text NOT NULL CHECK (period_kind IN ('month', 'quarter')),
  year int NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  period int NOT NULL,
  revision int NOT NULL DEFAULT 0 CHECK (revision >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
  values jsonb NOT NULL,
  overrides jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_by uuid REFERENCES app_user(id),
  finalized_at timestamptz,
  CHECK (period BETWEEN 1 AND CASE period_kind WHEN 'month' THEN 12 ELSE 4 END),
  CHECK (status = 'draft' OR finalized_at IS NOT NULL),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, form_code, year, period_kind, period, revision));
SELECT rls_enable('tax_return');
SELECT audit_enable('tax_return');

CREATE OR REPLACE FUNCTION fn_tax_return_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'final' THEN
    RAISE EXCEPTION 'TAX_RETURN_FINAL: Tờ khai đã chốt, không sửa hoặc xóa được; lập tờ khai bổ sung' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_tax_return_final BEFORE UPDATE OR DELETE ON tax_return FOR EACH ROW EXECUTE FUNCTION fn_tax_return_final();

-- Nhóm bán ra cho [32a], [32b], [34a] của 01/GTGT TT89. Thân seed_tenant_defaults lấy từ định nghĩa hiện hành (0031, pg_get_functiondef), chỉ thêm ba nhóm.
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
END $function$;

-- Công ty đã có: chèn bù ba nhóm (bỏ qua nếu đã tự tạo cùng mã). Tắt nhật ký như 0031 (migration không có người dùng).
ALTER TABLE invoice_group DISABLE TRIGGER trg_audit;
INSERT INTO invoice_group(tenant_id, scope, code, name, rate)
SELECT t.id, 'sale', g.code, g.name, NULL FROM tenant t
CROSS JOIN (VALUES ('KKK', 'Không kê khai, tính nộp thuế GTGT'), ('KTGT', 'Không tính vào giá tính thuế GTGT'), ('NPV', 'Không thuộc phạm vi điều chỉnh của pháp luật thuế GTGT')) g(code, name)
ON CONFLICT (tenant_id, scope, code) DO NOTHING;
ALTER TABLE invoice_group ENABLE TRIGGER trg_audit;
