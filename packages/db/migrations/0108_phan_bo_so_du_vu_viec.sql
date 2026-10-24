-- GĐ6 Task 13c: phân bổ chi phí bán hàng/quản lý chung vào vụ việc (PB), kết chuyển giá vốn vụ việc/hợp đồng 154 → 632 (GT),
-- số dư đầu kỳ theo vụ việc. Quyền contract_track.view/run đã có từ 0094; source_doc_type 'project_alloc' đã nằm trong danh sách chặn
-- bỏ ghi sổ/hủy của unpost_voucher/discard_voucher (0099, D8) nên không định nghĩa lại hàm nào.

-- Một lần chạy mỗi công ty × loại × kỳ tháng; chạy lại thay kết quả (đảo chứng từ cũ, sinh chứng từ mới), như cost_run (0104).
-- kind 'alloc': PB Nợ TK bán hàng/quản lý có vụ việc / Có cùng TK không chiều; kind 'cogs': GT Nợ 632 / Có 154 theo vụ việc/hợp đồng hoàn thành.
CREATE TABLE project_alloc_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('alloc', 'cogs')),
  year int NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  -- calculated: không có gì để ghi (không có chi phí chung/số dư 154); posted: có chứng từ đang hiệu lực; unlinked: chứng từ bị đảo/xóa ngoài luồng → cần chạy lại.
  status text NOT NULL CHECK (status IN ('calculated', 'posted', 'unlinked')),
  regime text NOT NULL,
  params jsonb NOT NULL,
  input_hash text NOT NULL,
  result jsonb NOT NULL DEFAULT '[]', -- bảng phân bổ/kết chuyển để xem lại (sổ cái vẫn là nguồn số liệu)
  voucher_id uuid,
  warnings jsonb NOT NULL DEFAULT '[]',
  run_by uuid DEFAULT app_user_id(), run_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'posted') = (voucher_id IS NOT NULL)),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, kind, year, month),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id) ON DELETE SET NULL (voucher_id));
SELECT rls_enable('project_alloc_run'); SELECT audit_enable('project_alloc_run');

-- Gỡ liên kết (Review Focus 6): chứng từ bị đảo, bỏ ghi sổ, hủy qua mọi đường (bỏ ghi sổ/hủy đã bị chặn ở unpost_voucher/discard_voucher, giữ cho chắc)
-- thì voucher_id = NULL; bị xóa thì khóa ngoại SET NULL. Mất chứng từ thì lần chạy "posted" thành "unlinked".
CREATE FUNCTION fn_project_alloc_run_unlinked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.voucher_id IS NULL AND NEW.status = 'posted' THEN NEW.status := 'unlinked'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_project_alloc_run_unlinked BEFORE UPDATE OF voucher_id ON project_alloc_run FOR EACH ROW EXECUTE FUNCTION fn_project_alloc_run_unlinked();

CREATE FUNCTION fn_project_alloc_voucher_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE project_alloc_run SET voucher_id = NULL WHERE tenant_id = NEW.tenant_id AND voucher_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_project_alloc_voucher_state AFTER UPDATE OF state ON voucher FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('draft', 'cancelled', 'reversed') AND NEW.source_doc_type = 'project_alloc') EXECUTE FUNCTION fn_project_alloc_voucher_state();

-- Số dư đầu kỳ theo vụ việc (D9): dở dang 154, công nợ 131/331... của từng vụ việc. Hợp đồng bán/mua dùng cột contract_id có sẵn (0073, trước chỉ khế ước vay).
ALTER TABLE opening_balance ADD COLUMN project_id bigint;
ALTER TABLE opening_balance ADD FOREIGN KEY (tenant_id, project_id) REFERENCES project (tenant_id, id);
DROP INDEX opening_balance_key;
CREATE UNIQUE INDEX opening_balance_key ON opening_balance (tenant_id, fiscal_year, account_id, coalesce(party_id, '00000000-0000-0000-0000-000000000000'::uuid), currency_code,
  coalesce(bank_account_id, 0), coalesce(doc_no, ''), coalesce(contract_id, 0), coalesce(project_id, 0));
