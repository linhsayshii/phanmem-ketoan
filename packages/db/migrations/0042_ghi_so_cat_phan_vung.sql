-- 0042_ghi_so_cat_phan_vung.sql: ghi sổ nhanh hơn. Dòng chứng từ luôn mang posting_date của chứng từ (fn_line_before gán, fn_voucher_date_sync dời khi đổi ngày),
-- nhưng fn_build_pairs, fn_check_voucher_balance và post_voucher tra voucher_line chỉ theo voucher_id nên quét chỉ mục của mọi phân vùng tháng (13 phân vùng cho một năm tài chính).
-- Thêm điều kiện posting_date = v.posting_date để cắt phân vùng còn một. Thân hàm giữ nguyên bản cuối (fn_build_pairs: 0012, fn_check_voucher_balance: 0009, post_voucher: 0029).

CREATE OR REPLACE FUNCTION fn_build_pairs(p_voucher uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher; nd int; nc int; total numeric;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  DELETE FROM voucher_pair WHERE voucher_id = p_voucher;
  SELECT count(*) FILTER (WHERE debit > 0), count(*) FILTER (WHERE credit > 0), coalesce(sum(debit),0) INTO nd, nc, total FROM voucher_line WHERE voucher_id = p_voucher AND posting_date = v.posting_date;
  IF total = 0 THEN RETURN; END IF;
  IF nd = 1 OR nc = 1 THEN
    INSERT INTO voucher_pair(tenant_id, voucher_id, posting_date, debit_account_id, credit_account_id, debit_party_id, credit_party_id, amount, is_closing, debit_line_id, credit_line_id)
    SELECT v.tenant_id, p_voucher, v.posting_date, d.account_id, c.account_id, d.party_id, c.party_id, CASE WHEN nd = 1 THEN c.credit ELSE d.debit END, v.is_closing, d.id, c.id
    FROM voucher_line d JOIN voucher_line c ON c.voucher_id = d.voucher_id WHERE d.voucher_id = p_voucher AND d.posting_date = v.posting_date AND c.posting_date = v.posting_date AND d.debit > 0 AND c.credit > 0;
  ELSE
    -- n–n: ghép tham lam theo thứ tự line_no (góc tây bắc). Dòng Nợ và dòng Có là các đoạn nối tiếp trên trục [0, total);
    -- mỗi cặp là phần giao của một đoạn Nợ với một đoạn Có, nên tổng các cặp của từng dòng đúng bằng số Nợ/Có của dòng đó.
    INSERT INTO voucher_pair(tenant_id, voucher_id, posting_date, debit_account_id, credit_account_id, debit_party_id, credit_party_id, amount, is_closing, debit_line_id, credit_line_id)
    -- MATERIALIZED: sau khi cắt phân vùng, bộ lập kế hoạch đoán mỗi CTE một dòng và chọn vòng lặp lồng tính lại hàm cửa sổ cho từng dòng (chứng từ 5.000 dòng: 3,7 giây thành 17,8 giây).
    WITH d AS MATERIALIZED (SELECT id, account_id, party_id, debit AS amt, sum(debit) OVER (ORDER BY line_no) AS hi FROM voucher_line WHERE voucher_id = p_voucher AND posting_date = v.posting_date AND debit > 0),
         c AS MATERIALIZED (SELECT id, account_id, party_id, credit AS amt, sum(credit) OVER (ORDER BY line_no) AS hi FROM voucher_line WHERE voucher_id = p_voucher AND posting_date = v.posting_date AND credit > 0)
    SELECT v.tenant_id, p_voucher, v.posting_date, d.account_id, c.account_id, d.party_id, c.party_id,
           least(d.hi, c.hi) - greatest(d.hi - d.amt, c.hi - c.amt), v.is_closing, d.id, c.id
    FROM d JOIN c ON least(d.hi, c.hi) > greatest(d.hi - d.amt, c.hi - c.amt)
    ORDER BY d.hi, c.hi;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION fn_check_voucher_balance(p_voucher uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher; v_d numeric; v_c numeric; v_n int; v_ncur int; v_cur char(3); v_fx numeric;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  IF NOT FOUND THEN RETURN; END IF;  -- chứng từ đã bị xóa trong cùng transaction
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0), count(*), count(DISTINCT currency_code), min(currency_code), coalesce(sum(amount_currency),0)
    INTO v_d, v_c, v_n, v_ncur, v_cur, v_fx FROM voucher_line WHERE voucher_id = p_voucher AND posting_date = v.posting_date;
  IF v_n = 0 AND v.state IN ('posted','reversed') THEN RAISE EXCEPTION 'VOUCHER_EMPTY: chứng từ % không có dòng', coalesce(v.voucher_no, v.id::text) USING ERRCODE = 'P0001'; END IF;
  IF v_d <> v_c THEN RAISE EXCEPTION 'VOUCHER_UNBALANCED: tổng Nợ % khác tổng Có %', v_d, v_c USING ERRCODE = 'P0001'; END IF;
  IF v_ncur = 1 AND v_cur <> 'VND' AND v_fx <> 0 THEN
    RAISE EXCEPTION 'VOUCHER_UNBALANCED_CURRENCY: nguyên tệ % lệch %', v_cur, v_fx USING ERRCODE = 'P0001'; END IF;
END $$;

CREATE OR REPLACE FUNCTION post_voucher(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; vt voucher_type; p fiscal_period; v_seq bigint; v_no text; v_n int; v_plan settlement_plan[]; pl settlement_plan; v_item open_item;
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
    INSERT INTO voucher_counter(tenant_id, voucher_type, fiscal_year, last_no) VALUES (v.tenant_id, v.voucher_type, p.fiscal_year, 1)
      ON CONFLICT (tenant_id, voucher_type, fiscal_year) DO UPDATE SET last_no = voucher_counter.last_no + 1 RETURNING last_no INTO v_seq;
    v_no := fn_format_voucher_no(vt.prefix, vt.suffix, vt.pad_length, v_seq, p.fiscal_year);
  END IF;
  -- đối trừ: kế hoạch dùng một lần, đọc và xóa khi chứng từ còn nháp (fn_voucher_child_guard chặn sửa sau khi ghi sổ)
  SELECT coalesce(array_agg(s ORDER BY s.id), '{}') INTO v_plan FROM settlement_plan s WHERE s.voucher_id = p_id;
  IF cardinality(v_plan) > 0 THEN DELETE FROM settlement_plan WHERE voucher_id = p_id; END IF;
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'posted', voucher_no = coalesce(voucher_no, v_no), seq_no = coalesce(seq_no, v_seq), posted_by = app_user_id(), posted_at = now() WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_build_pairs(p_id);
  PERFORM fn_open_items_create(p_id); -- công nợ: khoản theo chứng từ cho dòng tài khoản công nợ
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
