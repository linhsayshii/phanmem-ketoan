-- 0283_danh_lai_so_bo_dem.sql: GĐ7 gói 3 (sửa) — renumber_vouchers (thân từ 0280) tạo trước bộ đếm cho mọi branch_id còn trên chứng từ, không chỉ bộ phận đang is_branch.
CREATE OR REPLACE FUNCTION public.renumber_vouchers(p_tenant uuid, p_type text, p_year integer)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE vt voucher_type; n int; v_before jsonb;
BEGIN
  SELECT * INTO vt FROM voucher_type WHERE tenant_id = p_tenant AND code = p_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_TYPE_NOT_FOUND: %', p_type USING ERRCODE = 'P0001'; END IF;
  -- Khóa bộ đếm trước khi đọc chứng từ: post_voucher cùng loại/năm phải đợi tới khi đánh lại xong, nếu không số vừa cấp sẽ bị last_no = n ghi đè (trùng hoặc hụt số).
  -- Đủ hàng bộ đếm cho mọi phạm vi (trụ sở chính và từng chi nhánh khi bật đánh số theo chi nhánh) rồi khóa theo thứ tự khóa: post_voucher của bất kỳ chi nhánh nào cũng phải đợi.
  INSERT INTO voucher_counter(tenant_id, voucher_type, fiscal_year, branch_key, last_no)
    SELECT p_tenant, p_type, p_year, k, 0 FROM (SELECT 0::bigint AS k
      UNION SELECT d.id FROM department d WHERE d.tenant_id = p_tenant AND d.is_branch AND EXISTS (SELECT 1 FROM voucher_numbering_setting s WHERE s.tenant_id = p_tenant AND s.per_branch)
      -- cả chi nhánh đã bị bỏ cờ is_branch nhưng vẫn còn trên chứng từ: thiếu hàng bộ đếm thì last_no cuối bước không cập nhật được và post_voucher cấp trùng số
      UNION SELECT v.branch_id FROM voucher v WHERE v.tenant_id = p_tenant AND v.voucher_type = p_type AND v.fiscal_year = p_year AND v.branch_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM voucher_numbering_setting s WHERE s.tenant_id = p_tenant AND s.per_branch)) ks
    ON CONFLICT DO NOTHING;
  PERFORM 1 FROM voucher_counter WHERE tenant_id = p_tenant AND voucher_type = p_type AND fiscal_year = p_year ORDER BY branch_key FOR UPDATE;
  -- Giữ FOR SHARE các hàng kỳ của năm trước khi kiểm tra: lock_period (FOR UPDATE) đang chạy song song thì đợi tới khi commit rồi mới thấy trạng thái khóa; khóa sau đó phải đợi đánh lại số xong.
  PERFORM 1 FROM fiscal_period WHERE tenant_id = p_tenant AND fiscal_year = p_year FOR SHARE;
  IF EXISTS (SELECT 1 FROM voucher v JOIN fiscal_period p ON p.tenant_id = v.tenant_id AND p.fiscal_year = v.fiscal_year AND p.period_no = v.period_no
             WHERE v.tenant_id = p_tenant AND v.voucher_type = p_type AND v.fiscal_year = p_year AND v.voucher_no IS NOT NULL AND (p.status <> 'open' OR vt.module = ANY (p.locked_modules))) THEN
    RAISE EXCEPTION 'RENUMBER_PERIOD_LOCKED: có kỳ đã khóa hoặc đã khóa phần hành trong năm, không đánh lại số được' USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'voucher_no', voucher_no) ORDER BY posting_date, created_at, id), '[]') INTO v_before
    FROM voucher WHERE tenant_id = p_tenant AND voucher_type = p_type AND fiscal_year = p_year AND voucher_no IS NOT NULL;
  PERFORM set_config('app.renumbering', 'on', true);
  -- Số tạm trước (UNIQUE kiểm tra từng hàng), rồi gán số cuối cùng một lượt.
  UPDATE voucher SET voucher_no = '~' || id::text WHERE tenant_id = p_tenant AND voucher_type = p_type AND fiscal_year = p_year AND voucher_no IS NOT NULL;
  UPDATE voucher v SET seq_no = x.rn, voucher_no = fn_format_voucher_no_b(vt.prefix, vt.suffix, vt.pad_length, x.rn, p_year, x.code)
    FROM (SELECT v2.id, s.branch_code AS code, row_number() OVER (PARTITION BY s.branch_key ORDER BY v2.posting_date, v2.created_at, v2.id) AS rn
          FROM voucher v2 CROSS JOIN LATERAL fn_voucher_number_scope(v2.tenant_id, v2.branch_id) s
          WHERE v2.tenant_id = p_tenant AND v2.voucher_type = p_type AND v2.fiscal_year = p_year AND v2.voucher_no IS NOT NULL) x
    WHERE v.id = x.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('app.renumbering', 'off', true);
  -- công nợ: số chứng từ của khoản theo số mới (khoản của DK mang số chứng từ gốc nhập ở Số dư đầu kỳ, không theo số DK)
  UPDATE open_item o SET doc_no = v.voucher_no FROM voucher v WHERE o.voucher_id = v.id AND v.tenant_id = p_tenant AND v.voucher_type = p_type AND v.fiscal_year = p_year AND v.voucher_type <> 'DK';
  UPDATE voucher_counter c SET last_no = (SELECT count(*) FROM voucher v2 CROSS JOIN LATERAL fn_voucher_number_scope(v2.tenant_id, v2.branch_id) s
      WHERE v2.tenant_id = p_tenant AND v2.voucher_type = p_type AND v2.fiscal_year = p_year AND v2.voucher_no IS NOT NULL AND s.branch_key = c.branch_key)
    WHERE c.tenant_id = p_tenant AND c.voucher_type = p_type AND c.fiscal_year = p_year;
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, after, ip)
    VALUES (p_tenant, app_user_id(), 'renumber', 'voucher_type', p_type, v_before,
            jsonb_build_object('year', p_year, 'count', n, 'map', coalesce((SELECT jsonb_agg(jsonb_build_object('id', b.e->>'id', 'old', b.e->>'voucher_no', 'new', v.voucher_no) ORDER BY v.seq_no)
              FROM jsonb_array_elements(v_before) AS b(e) JOIN voucher v ON v.id = (b.e->>'id')::uuid), '[]')),
            nullif(current_setting('app.client_ip', true), ''));
  RETURN n;
END $function$;
