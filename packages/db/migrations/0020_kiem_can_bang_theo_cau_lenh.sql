-- Kiểm cân bằng một lần mỗi chứng từ mỗi giao dịch (thay trigger cấp dòng gọi lại hàm kiểm O(n) cho từng dòng → O(n²)).
-- Trigger cấp câu lệnh trên voucher_line (bảng gốc phân vùng) gom voucher_id vào hàng đợi; một constraint trigger hoãn
-- chạy lúc COMMIT trên mỗi dòng hàng đợi (ON CONFLICT DO NOTHING nên mỗi chứng từ một dòng) rồi xóa dòng đó.
-- Không có khóa ngoại tới voucher: chứng từ nháp đã bị xóa trong cùng giao dịch vẫn được kiểm (fn_check_voucher_balance trả về im lặng khi không còn chứng từ).
CREATE TABLE voucher_balance_pending (
  tenant_id uuid NOT NULL,
  voucher_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, voucher_id));
SELECT rls_enable('voucher_balance_pending');
GRANT SELECT, INSERT, DELETE ON voucher_balance_pending TO app_user;

CREATE OR REPLACE FUNCTION fn_enqueue_balance_nt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO voucher_balance_pending(tenant_id, voucher_id) SELECT DISTINCT tenant_id, voucher_id FROM nt ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION fn_enqueue_balance_ot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO voucher_balance_pending(tenant_id, voucher_id) SELECT DISTINCT tenant_id, voucher_id FROM ot ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
-- UPDATE: dòng cũ và mới (đổi voucher_id, hoặc chuyển partition khi đổi ngày ghi sổ) đều vào hàng đợi.
CREATE OR REPLACE FUNCTION fn_enqueue_balance_upd() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO voucher_balance_pending(tenant_id, voucher_id)
    SELECT tenant_id, voucher_id FROM nt UNION SELECT tenant_id, voucher_id FROM ot ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION fn_trg_balance_pending() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fn_check_voucher_balance(NEW.voucher_id);
  DELETE FROM voucher_balance_pending WHERE tenant_id = NEW.tenant_id AND voucher_id = NEW.voucher_id;
  RETURN NULL;
END $$;

DROP TRIGGER trg_voucher_balanced ON voucher_line;
CREATE TRIGGER trg_line_balance_ins AFTER INSERT ON voucher_line REFERENCING NEW TABLE AS nt FOR EACH STATEMENT EXECUTE FUNCTION fn_enqueue_balance_nt();
CREATE TRIGGER trg_line_balance_upd AFTER UPDATE ON voucher_line REFERENCING OLD TABLE AS ot NEW TABLE AS nt FOR EACH STATEMENT EXECUTE FUNCTION fn_enqueue_balance_upd();
CREATE TRIGGER trg_line_balance_del AFTER DELETE ON voucher_line REFERENCING OLD TABLE AS ot FOR EACH STATEMENT EXECUTE FUNCTION fn_enqueue_balance_ot();
CREATE CONSTRAINT TRIGGER trg_voucher_balance_pending AFTER INSERT ON voucher_balance_pending DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_trg_balance_pending();
