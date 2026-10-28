-- 0261_kiem_soat_toan_cong_ty.sql: GĐ7 gói 1 — kiểm soát nghiệp vụ tính trên toàn công ty dù phiên bị giới hạn chi nhánh.
-- Với RLS chi nhánh ở bảng con (0260), phiên của người dùng bị giới hạn chỉ thấy phát sinh kho, dòng sổ cái của chứng từ trong phạm vi. Kiểm soát nghiệp vụ (tồn kho âm, quỹ âm, vượt ngân sách)
-- là của cả công ty: tính trên phần thấy được thì bị lách (chi nhánh khác đã dùng hết) hoặc chặn nhầm (hàng nhập ở chi nhánh khác). Không dùng SECURITY DEFINER (chủ hàm bỏ qua cả RLS công ty,
-- phải tự lọc tenant_id ở từng truy vấn): tạm đặt app.branch_scope rỗng trong lúc tính rồi trả lại, tenant_isolation vẫn nguyên. Người dùng vốn đặt được biến phiên này (xem quyết định 1318).
CREATE FUNCTION fn_branch_scope_suspend() RETURNS text LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE prev text := coalesce(current_setting('app.branch_scope', true), '');
BEGIN
  IF prev <> '' THEN PERFORM set_config('app.branch_scope', '', true); END IF;
  RETURN prev;
END $$;
CREATE FUNCTION fn_branch_scope_restore(prev text) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF coalesce(prev, '') <> '' THEN PERFORM set_config('app.branch_scope', prev, true); END IF;
END $$;

-- Tồn âm đầu tiên của cặp hàng–kho từ ngày p_from: tính trên mọi phát sinh kho của công ty (thân từ 0046, đổi sang plpgsql VOLATILE để đặt/trả biến phiên).
CREATE OR REPLACE FUNCTION fn_stock_first_negative(p_item bigint, p_wh bigint, p_from date) RETURNS TABLE(d date, bal numeric) LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE prev text := fn_branch_scope_suspend();
BEGIN
  RETURN QUERY
  SELECT c.posting_date, c.bal FROM (
    SELECT posting_date, sum(sum(CASE direction WHEN 'in' THEN quantity ELSE -quantity END)) OVER (ORDER BY posting_date) AS bal
    FROM stock_move WHERE tenant_id = app_tenant() AND item_id = p_item AND warehouse_id = p_wh GROUP BY posting_date) c
  WHERE c.posting_date >= p_from AND c.bal < 0 ORDER BY c.posting_date LIMIT 1;
  PERFORM fn_branch_scope_restore(prev);
END $$;
