-- 0007_danh_so.sql: số chứng từ duy nhất theo năm tài chính và thủ tục đánh lại số theo ngày. Chạy với quyền người gọi (app_user, có RLS), không SECURITY DEFINER.

-- Bộ đếm (voucher_counter) bắt đầu lại từ 1 mỗi năm tài chính nên tiền tố không có {YY} (mặc định 'PKT') cho cùng số ở hai năm: UNIQUE phải kèm fiscal_year (thông lệ đánh số theo năm).
-- IF EXISTS để chạy lại được trên cơ sở dữ liệu đã áp bản trước của file này.
ALTER TABLE voucher DROP CONSTRAINT IF EXISTS voucher_tenant_id_voucher_type_voucher_no_key;
ALTER TABLE voucher DROP CONSTRAINT IF EXISTS voucher_tenant_id_voucher_type_fiscal_year_voucher_no_key;
ALTER TABLE voucher ADD CONSTRAINT voucher_tenant_id_voucher_type_fiscal_year_voucher_no_key UNIQUE (tenant_id, voucher_type, fiscal_year, voucher_no);
-- UNIQUE mới có fiscal_year ở giữa nên không phục vụ tra số khi không biết năm (check-no bỏ trống year).
CREATE INDEX IF NOT EXISTS voucher_tenant_id_voucher_type_voucher_no_idx ON voucher (tenant_id, voucher_type, voucher_no);

-- lpad của 0005 cắt bớt khi số dài hơn độ dài đệm (lpad('1234', 3, '0') = '123'): số thứ 1000 của loại đệm 3 chữ số trùng số thứ 100. Đệm không cắt, khớp formatVoucherNo (TS).
CREATE OR REPLACE FUNCTION fn_format_voucher_no(p_prefix text, p_suffix text, p_pad int, p_seq bigint, p_year int) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(replace(p_prefix, '{YYYY}', p_year::text), '{YY}', right(p_year::text, 2)) || repeat('0', greatest(p_pad - length(p_seq::text), 0)) || p_seq::text
      || replace(replace(p_suffix, '{YYYY}', p_year::text), '{YY}', right(p_year::text, 2));
$$;

-- Đánh lại số mọi chứng từ đã có số của một loại trong một năm theo (ngày ghi sổ, ngày tạo); chỉ khi mọi kỳ có chứng từ đó còn mở và không khóa phần hành của loại đó (khóa mềm, khóa cứng đã băm số).
-- Nhật ký kiểm toán giữ đủ ánh xạ id -> số cũ -> số mới: before = số cũ trước khi đổi, after.map = từng bộ {id, old, new}.
-- Chứng từ nháp đã bỏ ghi sổ và chứng từ hủy giữ số cũ nên cũng được đánh lại: dãy số liền, không lỗ hổng.
CREATE OR REPLACE FUNCTION renumber_vouchers(p_tenant uuid, p_type text, p_year int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE vt voucher_type; n int; v_before jsonb;
BEGIN
  SELECT * INTO vt FROM voucher_type WHERE tenant_id = p_tenant AND code = p_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_TYPE_NOT_FOUND: %', p_type USING ERRCODE = 'P0001'; END IF;
  -- Khóa bộ đếm trước khi đọc chứng từ: post_voucher cùng loại/năm phải đợi tới khi đánh lại xong, nếu không số vừa cấp sẽ bị last_no = n ghi đè (trùng hoặc hụt số).
  INSERT INTO voucher_counter(tenant_id, voucher_type, fiscal_year, last_no) VALUES (p_tenant, p_type, p_year, 0) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM voucher_counter WHERE tenant_id = p_tenant AND voucher_type = p_type AND fiscal_year = p_year FOR UPDATE;
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
  UPDATE voucher v SET seq_no = x.rn, voucher_no = fn_format_voucher_no(vt.prefix, vt.suffix, vt.pad_length, x.rn, p_year)
    FROM (SELECT id, row_number() OVER (ORDER BY posting_date, created_at, id) AS rn FROM voucher
          WHERE tenant_id = p_tenant AND voucher_type = p_type AND fiscal_year = p_year AND voucher_no IS NOT NULL) x
    WHERE v.id = x.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('app.renumbering', 'off', true);
  UPDATE voucher_counter SET last_no = n WHERE tenant_id = p_tenant AND voucher_type = p_type AND fiscal_year = p_year;
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, after, ip)
    VALUES (p_tenant, app_user_id(), 'renumber', 'voucher_type', p_type, v_before,
            jsonb_build_object('year', p_year, 'count', n, 'map', coalesce((SELECT jsonb_agg(jsonb_build_object('id', b.e->>'id', 'old', b.e->>'voucher_no', 'new', v.voucher_no) ORDER BY v.seq_no)
              FROM jsonb_array_elements(v_before) AS b(e) JOIN voucher v ON v.id = (b.e->>'id')::uuid), '[]')),
            nullif(current_setting('app.client_ip', true), ''));
  RETURN n;
END $$;
