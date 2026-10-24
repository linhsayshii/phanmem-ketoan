-- GĐ5 Task 14: đối chiếu giao dịch ngân hàng với chứng từ.
-- Chứng từ bị xóa: chỉ xóa cột voucher_id của giao dịch.
ALTER TABLE bank_transaction DROP CONSTRAINT bank_transaction_tenant_id_voucher_id_fkey,
  ADD FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id) ON DELETE SET NULL (voucher_id),
  ADD CONSTRAINT bank_transaction_matched_voucher CHECK (status <> 'matched' OR voucher_id IS NOT NULL);

-- Mất liên kết chứng từ (xóa nháp, gỡ gắn) thì giao dịch về "mới"; chạy cả khi khóa ngoại SET NULL cập nhật hàng.
CREATE FUNCTION fn_bank_txn_unlinked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.voucher_id IS NULL AND NEW.status = 'matched' THEN NEW.status := 'new'; NEW.matched_by := NULL; NEW.matched_at := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_bank_txn_unlinked BEFORE UPDATE OF voucher_id ON bank_transaction FOR EACH ROW EXECUTE FUNCTION fn_bank_txn_unlinked();

-- Trạng thái "đã đối chiếu" theo chứng từ: ghi sổ → matched; bỏ ghi sổ (về nháp) → new, vẫn giữ liên kết; đảo hoặc hủy → gỡ liên kết (về new).
CREATE FUNCTION fn_bank_txn_voucher_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'posted' THEN
    UPDATE bank_transaction SET status = 'matched', matched_at = coalesce(matched_at, now()) WHERE tenant_id = NEW.tenant_id AND voucher_id = NEW.id AND status = 'new';
  ELSIF NEW.state = 'draft' THEN
    UPDATE bank_transaction SET status = 'new', matched_at = NULL WHERE tenant_id = NEW.tenant_id AND voucher_id = NEW.id AND status = 'matched';
  ELSE
    UPDATE bank_transaction SET voucher_id = NULL WHERE tenant_id = NEW.tenant_id AND voucher_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_bank_txn_voucher_state AFTER UPDATE OF state ON voucher FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION fn_bank_txn_voucher_state();
