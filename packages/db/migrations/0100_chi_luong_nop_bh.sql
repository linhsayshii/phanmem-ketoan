-- GĐ6 Task 6b: chứng từ chi lương (PC/BN), nộp bảo hiểm, nộp thuế TNCN lập nháp từ bảng lương đã hạch toán; liên kết bảng lương ↔ chứng từ.
-- Một bảng lương mỗi loại (pay, insurance, pit) một chứng từ còn hiệu lực (nháp hoặc đã ghi sổ). lu_voucher_id: chứng từ LU lúc lập,
-- khác payroll_run.voucher_id hiện hành (chạy lại, hủy hạch toán) thì chứng từ đã lỗi thời (tính khi đọc, không lưu cờ).
CREATE TABLE payroll_run_voucher (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  run_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pay', 'insurance', 'pit')),
  voucher_id uuid NOT NULL,
  lu_voucher_id uuid,
  created_by uuid DEFAULT app_user_id(), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, run_id, kind), UNIQUE (tenant_id, voucher_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_run (tenant_id, id) ON DELETE CASCADE,
  -- Xóa chứng từ nháp: liên kết đi theo.
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, lu_voucher_id) REFERENCES voucher (tenant_id, id) ON DELETE SET NULL (lu_voucher_id));
SELECT rls_enable('payroll_run_voucher');
SELECT audit_enable('payroll_run_voucher');

-- Gỡ liên kết khi chứng từ bị hủy, đảo hoặc bỏ ghi sổ (posted → draft) qua mọi đường (route chung, hàm SQL); xóa đi theo khóa ngoại.
-- Chứng từ đã gỡ không còn là chứng từ chi của bảng lương: lập lại được.
CREATE FUNCTION fn_payroll_pay_voucher_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM payroll_run_voucher WHERE tenant_id = NEW.tenant_id AND voucher_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_payroll_pay_voucher_state AFTER UPDATE OF state ON voucher FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('draft', 'cancelled', 'reversed')) EXECUTE FUNCTION fn_payroll_pay_voucher_state();
