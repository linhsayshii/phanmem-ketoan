-- Trigger cấp câu lệnh (0020) chỉ chạy khi ghi qua bảng gốc voucher_line, không chạy khi ghi thẳng vào partition.
-- Thu hồi mọi quyền của app_user trên partition (đọc/ghi qua bảng gốc kiểm quyền trên bảng gốc nên vẫn chạy);
-- ensure_line_partitions (bản 0004) khi tạo partition mới cũng thu hồi, vì ALTER DEFAULT PRIVILEGES cấp quyền bảng cho app_user.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.oid::regclass AS t FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'voucher_line'::regclass LOOP
    EXECUTE format('REVOKE ALL ON %s FROM app_user', r.t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ensure_line_partitions(p_from date, p_to date) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d date := date_trunc('month', p_from)::date; v_name text;
BEGIN
  -- Chặn đầu vào bất thường (hàm là SECURITY DEFINER): tối đa 24 tháng, năm 1990-2199.
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR extract(year FROM p_from) NOT BETWEEN 1990 AND 2199 OR extract(year FROM p_to) NOT BETWEEN 1990 AND 2199 THEN
    RAISE EXCEPTION 'PARTITION_RANGE_INVALID: khoảng % - % không hợp lệ (cần từ <= đến, năm 1990-2199)', p_from, p_to USING ERRCODE = 'P0001'; END IF;
  IF (extract(year FROM p_to)::int - extract(year FROM p_from)::int) * 12 + extract(month FROM p_to)::int - extract(month FROM p_from)::int + 1 > 24 THEN
    RAISE EXCEPTION 'PARTITION_RANGE_INVALID: khoảng % - % dài hơn 24 tháng', p_from, p_to USING ERRCODE = 'P0001'; END IF;
  -- Khóa kiểm tra hai lần: không thiếu tháng nào thì thoát ngay, không giữ khóa đến hết giao dịch của người gọi.
  IF NOT EXISTS (SELECT 1 FROM generate_series(d, p_to, interval '1 month') g
                 WHERE to_regclass(format('voucher_line_y%sm%s', to_char(g, 'YYYY'), to_char(g, 'MM'))) IS NULL) THEN RETURN; END IF;
  -- Hai giao dịch cùng tạo một tháng sẽ đua nhau tới "already exists": tuần tự hóa bằng khóa tư vấn rồi kiểm tra lại từng tháng.
  -- Còn lại: hai phiên cùng tạo tháng mới, một phiên đã ghi party/account/currency... có thể bế tắc; PostgreSQL hủy một phiên (40P01), chấp nhận được.
  PERFORM pg_advisory_xact_lock(hashtext('ensure_line_partitions'));
  WHILE d <= p_to LOOP
    v_name := format('voucher_line_y%sm%s', to_char(d, 'YYYY'), to_char(d, 'MM'));
    IF to_regclass(v_name) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF voucher_line FOR VALUES FROM (%L) TO (%L)', v_name, d, (d + interval '1 month')::date);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_name);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', v_name);
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', v_name);
      EXECUTE format('REVOKE ALL ON %I FROM app_user', v_name);
    END IF;
    d := (d + interval '1 month')::date;
  END LOOP;
END $$;

-- Sắp xếp khi chèn hàng đợi: các giao dịch đồng thời khóa khóa chính theo cùng thứ tự, tránh bế tắc.
CREATE OR REPLACE FUNCTION fn_enqueue_balance_nt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO voucher_balance_pending(tenant_id, voucher_id) SELECT DISTINCT tenant_id, voucher_id FROM nt ORDER BY tenant_id, voucher_id ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION fn_enqueue_balance_ot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO voucher_balance_pending(tenant_id, voucher_id) SELECT DISTINCT tenant_id, voucher_id FROM ot ORDER BY tenant_id, voucher_id ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION fn_enqueue_balance_upd() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO voucher_balance_pending(tenant_id, voucher_id)
    SELECT tenant_id, voucher_id FROM (SELECT tenant_id, voucher_id FROM nt UNION SELECT tenant_id, voucher_id FROM ot) u ORDER BY tenant_id, voucher_id ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
