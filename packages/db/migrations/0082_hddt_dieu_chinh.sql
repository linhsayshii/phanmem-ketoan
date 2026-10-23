-- GĐ5 Task 6: hóa đơn bị thay thế/hủy mà chứng từ chưa đảo xong (needs_reversal) vẫn khóa chứng từ: chỉ luồng đảo của hóa đơn (app.einvoice_reversal) được đổi trạng thái.
-- fn_voucher_einvoice_lock từ thân hiện hành (0080), đổi điều kiện bỏ ghi sổ/đảo/hủy: mọi trạng thái hóa đơn trừ lỗi và nháp.
CREATE OR REPLACE FUNCTION fn_voucher_einvoice_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_no text; v_found boolean;
BEGIN
  IF current_setting('app.einvoice_reversal', true) = 'on' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT true, coalesce(invoice_no, '(chưa có số)') INTO v_found, v_no FROM einvoice WHERE tenant_id = OLD.tenant_id AND voucher_id = OLD.id AND status <> 'failed' LIMIT 1;
  ELSIF OLD.state = 'posted' AND NEW.state <> 'posted' THEN
    SELECT true, coalesce(invoice_no, '(chưa có số)') INTO v_found, v_no FROM einvoice WHERE tenant_id = OLD.tenant_id AND voucher_id = OLD.id AND status IN ('sending', 'issued', 'replaced', 'cancelled') LIMIT 1;
  END IF;
  IF v_found THEN RAISE EXCEPTION 'EINVOICE_ISSUED: chứng từ đã phát hành hóa đơn điện tử số %; lập hóa đơn điều chỉnh/thay thế hoặc hủy hóa đơn', v_no USING ERRCODE = 'P0001'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
