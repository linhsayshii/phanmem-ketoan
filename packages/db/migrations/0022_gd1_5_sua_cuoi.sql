-- Sửa cuối GĐ1.5.
-- M1: xóa dòng hàng đợi kiểm cân bằng theo khóa chính, không phụ thuộc RLS (dòng không còn mắc kẹt khi app.current_tenant đổi giữa giao dịch).
-- Bản chất hàm là thân cuối ở 0020; chỉ thêm SECURITY DEFINER + search_path. app_user mất quyền DELETE trực tiếp.
CREATE OR REPLACE FUNCTION fn_trg_balance_pending() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM fn_check_voucher_balance(NEW.voucher_id);
  DELETE FROM voucher_balance_pending WHERE tenant_id = NEW.tenant_id AND voucher_id = NEW.voucher_id;
  RETURN NULL;
END $$;
REVOKE DELETE ON voucher_balance_pending FROM app_user;

-- M4: đếm mọi thành viên (kể cả đang bị khóa) để không còn đường đặt lại mật khẩu xuyên công ty khi công ty kia mở khóa lại.
CREATE OR REPLACE FUNCTION user_tenant_count(p_user uuid) RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS
  $$ SELECT count(*)::int FROM tenant_user WHERE user_id = p_user $$;
