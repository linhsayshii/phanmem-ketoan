-- GĐ3 Task 20 vòng 1: KHO_LECH_SO_CAI, KHO_TON_0_CON_GIA_TRI định giá lần xuất chưa có giá gán bằng giá tạm đã ghi sổ cùng chứng từ (như mvCte: thành tiền dòng, hoặc làm tròn(số lượng cơ sở x unit_cost)),
-- để chỉ báo lệch thật giữa sổ cái và sổ kho; chưa tính giá vốn là việc của KHO_XUAT_CHUA_GIA_VON.
DO $mig$
DECLARE d text; o text; n text;
BEGIN
  o := $o$-coalesce((SELECT a.amount FROM stock_cost_assignment a WHERE a.tenant_id = m.tenant_id AND a.move_id = m.id AND a.is_current), 0)$o$;
  n := $n$-coalesce((SELECT a.amount FROM stock_cost_assignment a WHERE a.tenant_id = m.tenant_id AND a.move_id = m.id AND a.is_current),
                   (SELECT CASE WHEN il.unit_cost IS NOT NULL THEN round(coalesce(il.base_quantity, il.quantity * il.uom_factor) * il.unit_cost) ELSE il.amount END FROM voucher_item_line il WHERE il.tenant_id = m.tenant_id AND il.id = m.item_line_id), 0)$n$;
  d := pg_get_functiondef('seed_data_check_rules(uuid)'::regprocedure);
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 2 THEN RAISE EXCEPTION 'seed_data_check_rules: không thấy đúng hai chỗ giá gán xuất'; END IF;
  EXECUTE replace(d, o, n);
  ALTER TABLE data_check_rule DISABLE TRIGGER trg_audit;
  UPDATE data_check_rule SET sql = replace(sql, o, n) WHERE code IN ('KHO_LECH_SO_CAI', 'KHO_TON_0_CON_GIA_TRI') AND is_system;
  ALTER TABLE data_check_rule ENABLE TRIGGER trg_audit;
END $mig$;
