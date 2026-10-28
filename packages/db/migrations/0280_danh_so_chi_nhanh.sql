-- 0280_danh_so_chi_nhanh.sql: GĐ7 gói 3 — đánh số chứng từ theo chi nhánh (tùy chọn từng công ty, mặc định tắt = hành vi cũ).
-- Thân post_voucher lấy từ 0046 (bản cuối, GĐ6 không định nghĩa lại), renumber_vouchers từ 0029; chỉ đổi đoạn cấp số.
-- Bật: mỗi chi nhánh có bộ đếm riêng (voucher_counter.branch_key = id chi nhánh, 0 = trụ sở chính) và mã chi nhánh (department.code; trụ sở chính dùng hq_code)
-- đứng trong số: thay {BR} trong tiền tố/hậu tố loại chứng từ, không có {BR} thì thêm "<mã>-" ở đầu. Tắt: branch_key luôn 0, không mã (như trước).
-- UNIQUE (tenant_id, voucher_type, fiscal_year, voucher_no) giữ nguyên: mã chi nhánh khác nhau nên số không trùng; trùng mã là lỗi UNIQUE chứ không ghi trùng.

CREATE TABLE voucher_numbering_setting (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  per_branch boolean NOT NULL DEFAULT false,
  hq_code text NOT NULL DEFAULT 'TSC' CHECK (hq_code ~ '^[A-Za-z0-9._/]{0,20}$'),
  updated_at timestamptz NOT NULL DEFAULT now());
SELECT rls_enable('voucher_numbering_setting'), audit_enable('voucher_numbering_setting');

ALTER TABLE voucher_counter ADD COLUMN branch_key bigint NOT NULL DEFAULT 0;
ALTER TABLE voucher_counter DROP CONSTRAINT voucher_counter_pkey;
ALTER TABLE voucher_counter ADD PRIMARY KEY (tenant_id, voucher_type, fiscal_year, branch_key);

-- Phạm vi đánh số của một chứng từ: khóa bộ đếm và mã chi nhánh (NULL khi tắt).
CREATE FUNCTION fn_voucher_number_scope(p_tenant uuid, p_branch bigint, OUT branch_key bigint, OUT branch_code text) LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN coalesce(s.per_branch, false) THEN coalesce(p_branch, 0) ELSE 0 END,
         CASE WHEN NOT coalesce(s.per_branch, false) THEN NULL
              WHEN p_branch IS NULL THEN s.hq_code
              ELSE (SELECT d.code FROM department d WHERE d.tenant_id = p_tenant AND d.id = p_branch) END
  FROM (SELECT 1) one LEFT JOIN voucher_numbering_setting s ON s.tenant_id = p_tenant
$$;

CREATE FUNCTION fn_format_voucher_no_b(p_prefix text, p_suffix text, p_pad int, p_seq bigint, p_year int, p_code text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_code IS NULL THEN fn_format_voucher_no(replace(p_prefix, '{BR}', ''), replace(p_suffix, '{BR}', ''), p_pad, p_seq, p_year)
    WHEN position('{BR}' IN p_prefix || p_suffix) > 0 THEN fn_format_voucher_no(replace(p_prefix, '{BR}', p_code), replace(p_suffix, '{BR}', p_code), p_pad, p_seq, p_year)
    WHEN p_code = '' THEN fn_format_voucher_no(p_prefix, p_suffix, p_pad, p_seq, p_year)
    ELSE p_code || '-' || fn_format_voucher_no(p_prefix, p_suffix, p_pad, p_seq, p_year)
  END
$$;

CREATE OR REPLACE FUNCTION public.post_voucher(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; vt voucher_type; p fiscal_period; v_seq bigint; v_no text; v_n int; v_plan settlement_plan[]; pl settlement_plan; v_item open_item; v_scope record;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'draft' THEN RAISE EXCEPTION 'STATE_INVALID: chứng từ đang ở trạng thái %, không ghi sổ được', v.state USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_n FROM voucher_line WHERE voucher_id = p_id AND posting_date = v.posting_date;
  IF v_n = 0 THEN RAISE EXCEPTION 'VOUCHER_EMPTY: chứng từ không có dòng' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO vt FROM voucher_type WHERE tenant_id = v.tenant_id AND code = v.voucher_type;
  p := fn_period_of(v.tenant_id, v.posting_date, v.voucher_type = 'DK');
  PERFORM fn_assert_period_writable(p, vt.module);
  IF v.voucher_no IS NULL THEN
    -- GĐ7 gói 3: bộ đếm theo phạm vi đánh số (mặc định 0 = cả công ty; bật đánh số theo chi nhánh thì mỗi chi nhánh một bộ đếm và mã chi nhánh trong số).
    SELECT * INTO v_scope FROM fn_voucher_number_scope(v.tenant_id, v.branch_id);
    INSERT INTO voucher_counter(tenant_id, voucher_type, fiscal_year, branch_key, last_no) VALUES (v.tenant_id, v.voucher_type, p.fiscal_year, v_scope.branch_key, 1)
      ON CONFLICT (tenant_id, voucher_type, fiscal_year, branch_key) DO UPDATE SET last_no = voucher_counter.last_no + 1 RETURNING last_no INTO v_seq;
    v_no := fn_format_voucher_no_b(vt.prefix, vt.suffix, vt.pad_length, v_seq, p.fiscal_year, v_scope.branch_code);
  END IF;
  -- đối trừ: kế hoạch dùng một lần, đọc và xóa khi chứng từ còn nháp (fn_voucher_child_guard chặn sửa sau khi ghi sổ)
  SELECT coalesce(array_agg(s ORDER BY s.id), '{}') INTO v_plan FROM settlement_plan s WHERE s.voucher_id = p_id;
  IF cardinality(v_plan) > 0 THEN DELETE FROM settlement_plan WHERE voucher_id = p_id; END IF;
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'posted', voucher_no = coalesce(voucher_no, v_no), seq_no = coalesce(seq_no, v_seq), posted_by = app_user_id(), posted_at = now() WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_build_pairs(p_id);
  PERFORM fn_open_items_create(p_id); -- công nợ: khoản theo chứng từ cho dòng tài khoản công nợ
  PERFORM fn_stock_moves_create(p_id); -- kho: phát sinh nhập/xuất, lớp giá, kiểm tồn âm
  FOREACH pl IN ARRAY v_plan LOOP -- đối trừ theo kế hoạch
    SELECT * INTO v_item FROM open_item WHERE voucher_id = p_id AND line_no = pl.line_no;
    IF NOT FOUND THEN RAISE EXCEPTION 'SETTLEMENT_PLAN_LINE_INVALID: dòng % không phải dòng công nợ có đối tượng, không đối trừ được', pl.line_no USING ERRCODE = 'P0001'; END IF;
    IF v_item.amount > 0 OR (v_item.amount = 0 AND v_item.amount_currency > 0) THEN
      PERFORM settle_open_items(v_item.id, pl.open_item_id, pl.amount_currency, pl.amount, v.posting_date, 'plan', gen_random_uuid());
    ELSE
      PERFORM settle_open_items(pl.open_item_id, v_item.id, pl.amount_currency, pl.amount, v.posting_date, 'plan', gen_random_uuid());
    END IF;
  END LOOP;
  PERFORM mark_balance_stale(v.tenant_id, p.fiscal_year, p.period_no);
  PERFORM fn_audit_voucher(v.tenant_id, 'post', p_id, jsonb_build_object('voucher_no', coalesce(v.voucher_no, v_no), 'posting_date', v.posting_date));
END $function$;

CREATE OR REPLACE FUNCTION renumber_vouchers(p_tenant uuid, p_type text, p_year integer)
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
      UNION SELECT d.id FROM department d WHERE d.tenant_id = p_tenant AND d.is_branch AND EXISTS (SELECT 1 FROM voucher_numbering_setting s WHERE s.tenant_id = p_tenant AND s.per_branch)) ks
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
