-- GĐ3 Task 15: phiếu lắp ráp, tháo dỡ (LR). Một LR là một nhóm giá trị: chiều xuất (linh kiện khi lắp, thành phẩm khi tháo) và chiều nhập
-- cùng chứng từ; lần tính giá vốn định giá chiều nhập bằng Σ giá gán chiều xuất + chi phí nhập tay, chia theo cost_ratio (tổng 100, dòng cuối nhận phần dư).
-- Không cần cột nhóm: nhóm chính là voucher_id của chứng từ LR gốc (chứng từ đảo có reversal_of nên không thuộc nhóm).
ALTER TABLE voucher_item_line ADD COLUMN cost_ratio numeric(9,4) CHECK (cost_ratio IS NULL OR (cost_ratio >= 0 AND cost_ratio <= 100));
-- seed_voucher_types: thân hiện hành (0059), thêm LR; công ty có sẵn được bổ sung với trg_audit tắt.
DO $mig$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('seed_voucher_types(uuid)'::regprocedure);
  IF position($r$(p_tenant, 'CK', 'Phiếu chuyển kho', 'inventory', 'CK', true),$r$ IN d) = 0 THEN RAISE EXCEPTION 'seed_voucher_types không chứa dòng CK'; END IF;
  EXECUTE replace(d, $r$(p_tenant, 'CK', 'Phiếu chuyển kho', 'inventory', 'CK', true),$r$, $r$(p_tenant, 'CK', 'Phiếu chuyển kho', 'inventory', 'CK', true),
    (p_tenant, 'LR', 'Phiếu lắp ráp, tháo dỡ', 'inventory', 'LR', true),$r$);
END $mig$;
ALTER TABLE voucher_type DISABLE TRIGGER trg_audit;
SELECT seed_voucher_types(id) FROM tenant;
ALTER TABLE voucher_type ENABLE TRIGGER trg_audit;
