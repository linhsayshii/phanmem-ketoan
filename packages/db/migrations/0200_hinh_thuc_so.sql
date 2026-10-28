-- GĐ7 nhóm 1: hình thức sổ (lớp trình bày, không đụng dòng sổ cái).
-- Chưa có bảng năm tài chính (năm là tập kỳ trong fiscal_period) nên hình thức sổ lưu ở bảng cấu hình riêng theo năm; không có hàng = NKC.
CREATE TABLE fiscal_year_setting (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  fiscal_year integer NOT NULL,
  book_form text NOT NULL DEFAULT 'NKC' CHECK (book_form IN ('NKC', 'CTGS', 'NKSC', 'NKCT')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, fiscal_year));

-- Chứng từ ghi sổ: nhóm chứng từ gốc đã ghi sổ, có số hiệu theo năm và ngày; số liệu vẫn lấy từ sổ cái.
CREATE TABLE ledger_voucher_set (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  fiscal_year integer NOT NULL,
  set_no integer NOT NULL CHECK (set_no > 0),
  set_date date NOT NULL,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  date_from date NOT NULL,
  date_to date NOT NULL CHECK (date_to >= date_from),
  voucher_type text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, fiscal_year, set_no),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_user (tenant_id, user_id));
CREATE TABLE ledger_voucher_set_item (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  set_id bigint NOT NULL,
  voucher_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, set_id, voucher_id),
  UNIQUE (tenant_id, voucher_id), -- một chứng từ gốc chỉ vào một Chứng từ ghi sổ
  FOREIGN KEY (tenant_id, set_id) REFERENCES ledger_voucher_set (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id));
SELECT rls_enable(t) FROM unnest(ARRAY['fiscal_year_setting', 'ledger_voucher_set', 'ledger_voucher_set_item']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['fiscal_year_setting', 'ledger_voucher_set', 'ledger_voucher_set_item']::regclass[]) AS t;

INSERT INTO permission(code, name, group_name) VALUES
  ('voucher_set.view', 'Xem Chứng từ ghi sổ', 'Báo cáo'),
  ('voucher_set.create', 'Thêm Chứng từ ghi sổ', 'Báo cáo'),
  ('voucher_set.update', 'Sửa Chứng từ ghi sổ', 'Báo cáo'),
  ('voucher_set.delete', 'Xóa Chứng từ ghi sổ', 'Báo cáo')
ON CONFLICT (code) DO NOTHING;
-- create_tenant gán theo bảng permission nên công ty mới tự có; công ty hiện có: admin, kế toán trưởng, kế toán viên đủ quyền, vai trò xem chỉ xem.
ALTER TABLE role_permission DISABLE TRIGGER trg_audit;
INSERT INTO role_permission(tenant_id, role_id, permission_code)
  SELECT r.tenant_id, r.id, np.code FROM role r CROSS JOIN (SELECT code FROM permission WHERE code LIKE 'voucher_set.%') np
  WHERE r.code IN ('admin', 'ketoan_truong', 'ketoan_vien') OR (r.code = 'xem' AND np.code LIKE '%.view')
  ON CONFLICT DO NOTHING;
ALTER TABLE role_permission ENABLE TRIGGER trg_audit;
