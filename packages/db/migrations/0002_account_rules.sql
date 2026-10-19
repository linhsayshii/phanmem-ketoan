CREATE OR REPLACE FUNCTION fn_account_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p account%ROWTYPE;
BEGIN
  -- Đổi số hiệu cả cây: từng dòng UPDATE thấy cha chưa đổi, nên bỏ kiểm tra tiền tố khi app.bulk_rename = on (toàn cây đổi cùng tiền tố).
  IF current_setting('app.bulk_rename', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO p FROM account WHERE id = NEW.parent_id;
    IF p.tenant_id <> NEW.tenant_id OR p.regime <> NEW.regime THEN
      RAISE EXCEPTION 'ACCOUNT_PARENT_MISMATCH: tài khoản cha khác công ty hoặc chế độ' USING ERRCODE = 'P0001';
    END IF;
    IF left(NEW.code, length(p.code)) <> p.code OR length(NEW.code) <= length(p.code) THEN
      RAISE EXCEPTION 'ACCOUNT_CODE_PREFIX: mã % phải bắt đầu bằng mã cha %', NEW.code, p.code USING ERRCODE = 'P0001';
    END IF;
    IF NOT p.is_group THEN UPDATE account SET is_group = true WHERE id = p.id; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_account_check BEFORE INSERT OR UPDATE OF code, parent_id ON account FOR EACH ROW EXECUTE FUNCTION fn_account_check();

-- Khi xóa con cuối cùng, cha trở lại tài khoản chi tiết.
CREATE OR REPLACE FUNCTION fn_account_after_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM account WHERE parent_id = OLD.parent_id) THEN
    UPDATE account SET is_group = false WHERE id = OLD.parent_id;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_account_after_delete AFTER DELETE ON account FOR EACH ROW EXECUTE FUNCTION fn_account_after_delete();
