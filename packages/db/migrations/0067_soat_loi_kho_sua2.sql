-- Soát lỗi KHO_LECH_SO_CAI biết TK kho mặc định 156 như khi lập chứng từ (kho và hàng đều không khai TK thì ghi 156): khóa theo mã TK, tập TK kho gồm 156.
-- Định nghĩa lại seed_data_check_rules từ thân hiện hành (qua 0064, 0065, 0066) và cập nhật quy tắc hệ thống đã gieo (tắt trg_audit như 0065).
DO $mig$
DECLARE d text; o text; n text; oo text[]; nn text[]; i int;
BEGIN
  oo := ARRAY[
    $o$lay AS (SELECT coalesce(w.inventory_account_id, i.inventory_account_id) AS account_id, mv.warehouse_id, sum(mv.val) AS val
          FROM mv JOIN item i ON i.id = mv.item_id JOIN warehouse w ON w.id = mv.warehouse_id GROUP BY 1, 2),$o$,
    $o$kho AS (SELECT inventory_account_id AS id FROM warehouse WHERE inventory_account_id IS NOT NULL UNION SELECT inventory_account_id FROM item WHERE inventory_account_id IS NOT NULL),
      led AS (SELECT l.account_id, l.warehouse_id, sum(l.debit - l.credit) AS val FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
          WHERE v.state IN ('posted','reversed') AND l.posting_date <= $2 AND l.warehouse_id IS NOT NULL AND l.account_id IN (SELECT id FROM kho) GROUP BY 1, 2)
      SELECT NULL::uuid, a.code || ' / ' || w.code, 'Lớp giá ' || coalesce(lay.val, 0) || ' / sổ cái ' || coalesce(led.val, 0)
      FROM lay FULL JOIN led ON led.account_id = lay.account_id AND led.warehouse_id = lay.warehouse_id
      JOIN account a ON a.id = coalesce(lay.account_id, led.account_id) JOIN warehouse w ON w.id = coalesce(lay.warehouse_id, led.warehouse_id)$o$];
  nn := ARRAY[
    $n$lay AS (SELECT coalesce(wa.code, ia.code, '156') AS code, mv.warehouse_id, sum(mv.val) AS val
          FROM mv JOIN item i ON i.id = mv.item_id JOIN warehouse w ON w.id = mv.warehouse_id LEFT JOIN account wa ON wa.id = w.inventory_account_id LEFT JOIN account ia ON ia.id = i.inventory_account_id GROUP BY 1, 2),$n$,
    $n$kho AS (SELECT a.code FROM warehouse w JOIN account a ON a.id = w.inventory_account_id UNION SELECT a.code FROM item i JOIN account a ON a.id = i.inventory_account_id UNION SELECT '156'),
      led AS (SELECT a.code, l.warehouse_id, sum(l.debit - l.credit) AS val FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
          WHERE v.state IN ('posted','reversed') AND l.posting_date <= $2 AND l.warehouse_id IS NOT NULL AND a.code IN (SELECT code FROM kho) GROUP BY 1, 2)
      SELECT NULL::uuid, coalesce(lay.code, led.code) || ' / ' || w.code, 'Lớp giá ' || coalesce(lay.val, 0) || ' / sổ cái ' || coalesce(led.val, 0)
      FROM lay FULL JOIN led ON led.code = lay.code AND led.warehouse_id = lay.warehouse_id
      JOIN warehouse w ON w.id = coalesce(lay.warehouse_id, led.warehouse_id)$n$];
  d := pg_get_functiondef('seed_data_check_rules(uuid)'::regprocedure);
  FOR i IN 1..array_length(oo, 1) LOOP
    IF (length(d) - length(replace(d, oo[i], ''))) / length(oo[i]) <> 1 THEN RAISE EXCEPTION 'seed_data_check_rules: không thấy đúng một chỗ % của KHO_LECH_SO_CAI', i; END IF;
    d := replace(d, oo[i], nn[i]);
  END LOOP;
  EXECUTE d;
  ALTER TABLE data_check_rule DISABLE TRIGGER trg_audit;
  FOR i IN 1..array_length(oo, 1) LOOP
    UPDATE data_check_rule SET sql = replace(sql, oo[i], nn[i]) WHERE code = 'KHO_LECH_SO_CAI' AND is_system;
  END LOOP;
  ALTER TABLE data_check_rule ENABLE TRIGGER trg_audit;
END $mig$;
