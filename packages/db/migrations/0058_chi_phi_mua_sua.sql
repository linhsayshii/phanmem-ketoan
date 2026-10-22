-- GĐ3 Task 12, vòng sửa 1.
-- 1) landed_cost_alloc giữ phân bổ của CPM đã đảo/đã hủy làm lịch sử. Phiếu nhập được bỏ ghi sổ rồi sửa nháp (xóa, ghi lại dòng hàng) thì receipt_line_id về NULL
--    (ON DELETE SET NULL chỉ cột này); chứng từ nhập và số dòng được chụp lại (receipt_voucher_id, receipt_line_no) để xem lại phân bổ cũ.
--    CPM nháp/đã ghi sổ vẫn chặn bỏ ghi sổ, đảo phiếu nhập (LANDED_COST_REFERENCED, 0057), nên chỉ phân bổ của CPM đã đảo/đã hủy mới về NULL.
-- 2) Giá tính thuế GTGT hàng nhập khẩu theo tờ khai (import_vat_base, VND): để trống thì phần mềm tính = giá trị hàng VND + thuế NK + thuế TTĐB.

ALTER TABLE voucher_item_line ADD COLUMN import_vat_base numeric(20,0),
  DROP CONSTRAINT voucher_item_line_import_check,
  ADD CONSTRAINT voucher_item_line_import_check CHECK (import_mode OR (import_tax IS NULL AND excise_tax IS NULL AND import_vat IS NULL AND import_vat_code IS NULL AND import_vat_base IS NULL));

ALTER TABLE landed_cost_alloc ADD COLUMN receipt_voucher_id uuid, ADD COLUMN receipt_line_no int;
ALTER TABLE landed_cost_alloc DISABLE TRIGGER trg_audit;
ALTER TABLE landed_cost_alloc DISABLE TRIGGER trg_landed_cost_alloc_guard;
UPDATE landed_cost_alloc la SET receipt_voucher_id = il.voucher_id, receipt_line_no = il.line_no
  FROM voucher_item_line il WHERE il.tenant_id = la.tenant_id AND il.id = la.receipt_line_id;
ALTER TABLE landed_cost_alloc ENABLE TRIGGER trg_audit;
ALTER TABLE landed_cost_alloc ENABLE TRIGGER trg_landed_cost_alloc_guard;
-- Chứng từ nhập là chứng từ đã ghi sổ (có số) nên không xóa được: khóa ngoại không cần hành động khi xóa.
ALTER TABLE landed_cost_alloc ALTER COLUMN receipt_voucher_id SET NOT NULL, ALTER COLUMN receipt_line_no SET NOT NULL, ALTER COLUMN receipt_line_id DROP NOT NULL,
  DROP CONSTRAINT landed_cost_alloc_tenant_id_receipt_line_id_fkey,
  ADD CONSTRAINT landed_cost_alloc_tenant_id_receipt_line_id_fkey FOREIGN KEY (tenant_id, receipt_line_id) REFERENCES voucher_item_line (tenant_id, id) ON DELETE SET NULL (receipt_line_id),
  ADD CONSTRAINT landed_cost_alloc_tenant_id_receipt_voucher_id_fkey FOREIGN KEY (tenant_id, receipt_voucher_id) REFERENCES voucher (tenant_id, id);
CREATE INDEX landed_cost_alloc_receipt_voucher ON landed_cost_alloc (tenant_id, receipt_voucher_id);

-- Bảng con chỉ ghi khi CPM còn nháp (như fn_voucher_child_guard, 0029), trừ đúng thao tác SET NULL của khóa ngoại khi dòng nhập bị xóa.
CREATE OR REPLACE FUNCTION fn_landed_cost_alloc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.receipt_line_id IS NOT NULL AND NEW.receipt_line_id IS NULL
     AND (NEW.id, NEW.tenant_id, NEW.voucher_id, NEW.amount, NEW.basis, NEW.receipt_voucher_id, NEW.receipt_line_no)
         IS NOT DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.voucher_id, OLD.amount, OLD.basis, OLD.receipt_voucher_id, OLD.receipt_line_no) THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT state INTO v_state FROM voucher WHERE id = NEW.voucher_id;
    IF FOUND AND v_state <> 'draft' THEN RAISE EXCEPTION 'VOUCHER_POSTED_EDIT: chứng từ không còn là nháp (trạng thái %), không sửa được nội dung kèm theo', v_state USING ERRCODE = 'P0001'; END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT state INTO v_state FROM voucher WHERE id = OLD.voucher_id;
    IF FOUND AND v_state <> 'draft' THEN RAISE EXCEPTION 'VOUCHER_POSTED_EDIT: chứng từ không còn là nháp (trạng thái %), không sửa được nội dung kèm theo', v_state USING ERRCODE = 'P0001'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER trg_landed_cost_alloc_guard ON landed_cost_alloc;
CREATE TRIGGER trg_landed_cost_alloc_guard BEFORE INSERT OR UPDATE OR DELETE ON landed_cost_alloc FOR EACH ROW EXECUTE FUNCTION fn_landed_cost_alloc_guard();
