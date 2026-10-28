-- 0240_da_chi_nhanh.sql: GĐ7 nhóm 5 — đa chi nhánh trong một công ty.
-- Chi nhánh là bộ phận có is_branch (0003; warehouse.branch_id đã trỏ vào đây). Chi nhánh gắn ở tiêu đề chứng từ, không thêm cột vào voucher_line
-- (bảng partition, trigger bất biến, chuỗi hash): dòng suy ra chi nhánh qua voucher. NULL = trụ sở chính.

-- MST đơn vị trực thuộc (nếu có); đơn vị cấp trên là parent_id sẵn có.
ALTER TABLE department ADD COLUMN tax_code text;

-- Thêm cột không giá trị mặc định: không viết lại dòng cũ, không chạy trigger dòng (chứng từ đã ghi sổ không bị UPDATE).
ALTER TABLE voucher ADD COLUMN branch_id bigint;
ALTER TABLE voucher ADD CONSTRAINT voucher_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES department (tenant_id, id);
-- Mặc định là chi nhánh làm việc của người dùng (biến phiên do API đặt): mọi phân hệ lập chứng từ tự gắn chi nhánh mà không phải sửa từng dịch vụ.
ALTER TABLE voucher ALTER COLUMN branch_id SET DEFAULT nullif(current_setting('app.branch_default', true), '')::bigint;
CREATE INDEX ON voucher (tenant_id, branch_id, posting_date);

-- Chứng từ đảo cùng chi nhánh với chứng từ gốc; chứng từ kết chuyển (tổng hợp cả công ty) thuộc trụ sở chính. Chi nhánh phải là bộ phận is_branch của công ty.
CREATE FUNCTION fn_voucher_branch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reversal_of_id IS NOT NULL THEN SELECT branch_id INTO NEW.branch_id FROM voucher WHERE id = NEW.reversal_of_id;
    ELSIF NEW.is_closing THEN NEW.branch_id := NULL;
    END IF;
  END IF;
  IF NEW.branch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM department d WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.branch_id AND d.is_branch) THEN
    RAISE EXCEPTION 'BRANCH_NOT_FOUND: chi nhánh % không có hoặc không phải chi nhánh', NEW.branch_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_voucher_branch BEFORE INSERT OR UPDATE OF branch_id ON voucher FOR EACH ROW EXECUTE FUNCTION fn_voucher_branch();

-- Đổi chi nhánh của chứng từ (chỉ nháp: trg_voucher_before chặn sửa chứng từ đã ghi sổ) ghi nhật ký trước/sau.
CREATE FUNCTION fn_voucher_branch_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, after, ip)
  VALUES (NEW.tenant_id, app_user_id(), 'branch', 'voucher', NEW.id::text, jsonb_build_object('branch_id', OLD.branch_id), jsonb_build_object('branch_id', NEW.branch_id),
          nullif(current_setting('app.client_ip', true), ''));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_voucher_branch_audit AFTER UPDATE OF branch_id ON voucher FOR EACH ROW WHEN (OLD.branch_id IS DISTINCT FROM NEW.branch_id) EXECUTE FUNCTION fn_voucher_branch_audit();

-- Phạm vi chi nhánh của phiên: app.branch_scope = danh sách id cách nhau dấu phẩy, 0 = trụ sở chính; rỗng = toàn công ty.
-- RESTRICTIVE: cộng thêm (AND) với tenant_isolation. Biểu thức viết thẳng trong chính sách để không gọi hàm theo từng dòng.
CREATE POLICY branch_scope ON voucher AS RESTRICTIVE
  USING (coalesce(current_setting('app.branch_scope', true), '') = '' OR coalesce(branch_id, 0)::text = ANY (string_to_array(current_setting('app.branch_scope', true), ',')))
  WITH CHECK (coalesce(current_setting('app.branch_scope', true), '') = '' OR coalesce(branch_id, 0)::text = ANY (string_to_array(current_setting('app.branch_scope', true), ',')));

-- Phạm vi chi nhánh của người dùng trong công ty; không có dòng = toàn công ty. branch_id NULL = trụ sở chính.
CREATE TABLE user_branch_scope (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL,
  branch_id bigint,
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_user (tenant_id, user_id) ON DELETE CASCADE,
  -- không CASCADE: xóa chi nhánh làm mất dòng phạm vi duy nhất sẽ biến người dùng thành toàn công ty
  FOREIGN KEY (tenant_id, branch_id) REFERENCES department (tenant_id, id));
CREATE UNIQUE INDEX user_branch_scope_uq ON user_branch_scope (tenant_id, user_id, coalesce(branch_id, 0));
SELECT rls_enable('user_branch_scope'), audit_enable('user_branch_scope');

-- BCTC tổng hợp: tiền tố tài khoản nội bộ giữa các đơn vị (loại trừ khi cộng). Mặc định 136, 336 (Phải thu/Phải trả nội bộ, có trong cả ba hệ tài khoản nạp từ văn bản).
CREATE TABLE branch_consolidation_setting (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  internal_prefixes text[] NOT NULL DEFAULT '{136,336}',
  updated_at timestamptz NOT NULL DEFAULT now());
SELECT rls_enable('branch_consolidation_setting'), audit_enable('branch_consolidation_setting');
