-- Rà soát GĐ6 (#970): chứng từ chi lương/nộp BH/nộp TNCN bỏ ghi sổ (posted → draft) GIỮ liên kết payroll_run_voucher, như hóa đơn từ đợt hợp đồng (0105).
-- Trước đây (0100) gỡ cả khi về nháp: nháp mồ côi không còn được thấy nên "Lập phiếu chi lương" sinh phiếu thứ hai, ghi sổ cả hai thì Nợ 334 hai lần.
-- Chỉ gỡ khi hủy (cancelled) hoặc đảo (reversed); xóa nháp vẫn gỡ theo khóa ngoại ON DELETE CASCADE. Thân fn_payroll_pay_voucher_state giữ nguyên (0100), chỉ đổi điều kiện WHEN.
DROP TRIGGER trg_payroll_pay_voucher_state ON voucher;
CREATE TRIGGER trg_payroll_pay_voucher_state AFTER UPDATE OF state ON voucher FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('cancelled', 'reversed')) EXECUTE FUNCTION fn_payroll_pay_voucher_state();

-- #974: chữ ký cấu hình hạch toán (bộ phận, vụ việc mặc định, tỷ lệ phân bổ chi phí của nhân viên, tài khoản chi phí theo bộ phận, tài khoản mặc định) lúc lập/giữ LU.
-- Khác chữ ký hiện tại thì bảng đã hạch toán "Cần chạy lại". NULL = LU lập trước bản sửa: không so (tránh mọi bảng cũ đồng loạt "Cần chạy lại"); chạy lại thì được ghi.
ALTER TABLE payroll_run ADD COLUMN cost_hash text;
