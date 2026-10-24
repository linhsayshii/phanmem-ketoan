-- GĐ5 sửa cuối đợt.
-- Hóa đơn đầu vào: chứng từ nháp bị xóa (khóa ngoại SET NULL) hoặc bị hủy thì gỡ liên kết và đưa hóa đơn về "mới" để lập lại được.
CREATE FUNCTION fn_inbound_unlinked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.voucher_id IS NULL AND NEW.status = 'voucher_created' THEN NEW.status := 'new'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_inbound_unlinked BEFORE UPDATE OF voucher_id ON inbound_invoice FOR EACH ROW EXECUTE FUNCTION fn_inbound_unlinked();

CREATE FUNCTION fn_inbound_voucher_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE inbound_invoice SET voucher_id = NULL WHERE tenant_id = NEW.tenant_id AND voucher_id = NEW.id AND status = 'voucher_created';
  RETURN NULL;
END $$;
CREATE TRIGGER trg_inbound_voucher_state AFTER UPDATE OF state ON voucher FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state = 'cancelled') EXECUTE FUNCTION fn_inbound_voucher_state();

-- Giao dịch ngân hàng: mất liên kết chứng từ thì xóa cả matched_by (trước đây chỉ xóa khi đang matched; bản dựng từ 0088).
CREATE OR REPLACE FUNCTION fn_bank_txn_unlinked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.voucher_id IS NULL THEN
    NEW.matched_by := NULL;
    IF NEW.status = 'matched' THEN NEW.status := 'new'; NEW.matched_at := NULL; END IF;
  END IF;
  RETURN NEW;
END $$;
