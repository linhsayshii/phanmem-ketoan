-- GĐ6 Task 13a: hợp đồng bán/mua mở rộng (ngày hiệu lực, TK và thuế mặc định khi lập hóa đơn, trạng thái hoàn thành/hủy) và đợt thanh toán.
-- Chiều hợp đồng của chứng từ là voucher_line.contract_id có sẵn (0004, khóa ngoại 0061); hóa đơn, PT/BC ghi vào đó, không thêm cột.

-- Trạng thái: thêm completed (hoàn thành), cancelled (hủy) cho hợp đồng bán/mua; giữ expired, terminated (khế ước vay dùng terminated = đã tất toán).
ALTER TABLE contract DROP CONSTRAINT contract_status_check;
ALTER TABLE contract ADD CONSTRAINT contract_status_check CHECK (status IN ('draft','active','completed','cancelled','expired','terminated'));
-- valid_from: ngày hiệu lực (signed_date là ngày ký). account_code: TK doanh thu (hợp đồng bán) hoặc TK chi phí (hợp đồng mua) mặc định cho hóa đơn lập từ đợt;
-- mã là chữ như department_cost_account (một công ty giữ nhiều hệ tài khoản), kiểm tồn tại khi lập hóa đơn. tax_code: thuế GTGT mặc định của đợt.
ALTER TABLE contract ADD COLUMN valid_from date, ADD COLUMN account_code text CHECK (account_code ~ '^[0-9]{3,10}$'), ADD COLUMN tax_code text,
  ADD CONSTRAINT contract_valid_from_check CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  ADD FOREIGN KEY (tenant_id, tax_code) REFERENCES tax_code (tenant_id, code) ON UPDATE CASCADE;

-- Đợt thanh toán: số tiền chưa thuế theo loại tiền của hợp đồng (percent chỉ để hiển thị/tính lại, amount là số lập hóa đơn).
-- voucher_id: hóa đơn (HDB/HDM) lập từ đợt; có voucher_id = đã lập hóa đơn. Một đợt một hóa đơn, một hóa đơn một đợt (UNIQUE).
-- status chỉ là planned (chưa lập) hoặc cancelled (bỏ đợt, không lập hóa đơn); "đã lập hóa đơn" suy ra từ voucher_id.
CREATE TABLE contract_milestone (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  contract_id bigint NOT NULL,
  seq int NOT NULL CHECK (seq > 0),
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  due_date date,
  percent numeric(7,4) CHECK (percent > 0 AND percent <= 100),
  amount numeric(20,4) NOT NULL CHECK (amount > 0),
  tax_code text,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','cancelled')),
  voucher_id uuid,
  invoiced_by uuid, invoiced_at timestamptz,
  note text,
  CHECK (status = 'planned' OR voucher_id IS NULL),
  -- STT kiểm cuối giao dịch: lưu cả danh sách đợt được đổi chỗ hai STT.
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, contract_id, seq) DEFERRABLE INITIALLY DEFERRED, UNIQUE (tenant_id, voucher_id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contract (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, tax_code) REFERENCES tax_code (tenant_id, code) ON UPDATE CASCADE,
  -- Xóa hóa đơn nháp: gỡ liên kết, đợt về "chưa lập hóa đơn".
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id) ON DELETE SET NULL (voucher_id));
SELECT rls_enable('contract_milestone');
SELECT audit_enable('contract_milestone');

-- Hóa đơn của đợt bị hủy hoặc đảo (mọi đường: route chung, hàm SQL) thì gỡ liên kết để lập lại được. Bỏ ghi sổ (posted → draft) GIỮ liên kết:
-- hóa đơn nháp vẫn là hóa đơn của đợt (như lúc mới lập), gỡ thì bấm lập lại sẽ sinh hóa đơn thứ hai cho cùng đợt (như inbound 0093, khác chứng từ chi lương 0100).
CREATE FUNCTION fn_contract_milestone_voucher_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE contract_milestone SET voucher_id = NULL WHERE tenant_id = NEW.tenant_id AND voucher_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_contract_milestone_voucher_state AFTER UPDATE OF state ON voucher FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('cancelled', 'reversed')) EXECUTE FUNCTION fn_contract_milestone_voucher_state();
