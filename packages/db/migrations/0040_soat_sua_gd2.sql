-- 0040: sửa sau soát GĐ2. Định nghĩa lại settle_open_items từ thân cuối cùng (0029), logic giữ nguyên, chỉ đổi hai thông báo lỗi:
-- (I3) đối trừ ở ngày trước ngày đánh giá lại của khoản con thì báo rõ SETTLEMENT_BEFORE_REVALUATION thay vì SETTLEMENT_DATE_BEFORE_POSTING của trigger;
-- (M3) thiếu tài khoản lãi/lỗ tỷ giá là lỗi cấu hình danh mục: FX_ACCOUNT_MISSING (409), không phải LOOKUP_NOT_FOUND (404).
CREATE OR REPLACE FUNCTION settle_open_items(p_debit bigint, p_credit bigint, p_amount_currency numeric, p_amount numeric, p_date date, p_kind text, p_group uuid)
RETURNS bigint[] LANGUAGE plpgsql AS $$
DECLARE
  d open_item; c open_item; rd record; rc record; ch record; p fiscal_period; v_rules jsonb; v_acc bigint;
  v_date date; v_user uuid; v_group uuid := coalesce(p_group, gen_random_uuid());
  v_q numeric; v_s numeric; a_d numeric; a_c numeric; x_d numeric; x_c numeric; v_e numeric; v_m numeric;
  sum_r_d numeric := 0; sum_r_c numeric := 0; sum_s_d numeric := 0; sum_s_c numeric := 0;
  pos_id bigint[] := '{}'; pos_amt numeric[] := '{}'; neg_id bigint[] := '{}'; neg_amt numeric[] := '{}';
  chp_id bigint[] := '{}'; chp_amt numeric[] := '{}'; chn_id bigint[] := '{}'; chn_amt numeric[] := '{}';
  v_reval date; v_cl uuid; v_cl_item bigint; v_id bigint; v_ids bigint[] := '{}'; i int := 1; j int := 1;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('manual', 'auto', 'plan') THEN RAISE EXCEPTION 'SETTLEMENT_KIND_INVALID: kiểu đối trừ % không lập được', p_kind USING ERRCODE = 'P0001'; END IF;
  -- Khóa hai khoản theo thứ tự id trước khi đọc dư: hai lần đối trừ đồng thời trên cùng một khoản chạy nối tiếp, lần sau thấy dư đã giảm (không bế tắc khi chéo nhau).
  PERFORM 1 FROM open_item WHERE id IN (p_debit, p_credit) ORDER BY id FOR UPDATE;
  SELECT * INTO d FROM open_item WHERE id = p_debit;
  IF NOT FOUND THEN RAISE EXCEPTION 'OPEN_ITEM_NOT_FOUND: không có khoản công nợ %', p_debit USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO c FROM open_item WHERE id = p_credit;
  IF NOT FOUND THEN RAISE EXCEPTION 'OPEN_ITEM_NOT_FOUND: không có khoản công nợ %', p_credit USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM open_item WHERE tenant_id = d.tenant_id AND parent_id IN (p_debit, p_credit) ORDER BY id FOR UPDATE;
  IF d.tenant_id <> c.tenant_id OR (d.account_id, d.party_id, d.currency_code) IS DISTINCT FROM (c.account_id, c.party_id, c.currency_code) THEN
    RAISE EXCEPTION 'SETTLEMENT_MISMATCH: hai khoản đối trừ phải cùng tài khoản, đối tượng và loại tiền' USING ERRCODE = 'P0001'; END IF;
  IF NOT (d.amount > 0 OR (d.amount = 0 AND d.amount_currency > 0)) OR NOT (c.amount < 0 OR (c.amount = 0 AND c.amount_currency < 0)) THEN
    RAISE EXCEPTION 'SETTLEMENT_MISMATCH: khoản bên Nợ phải là phát sinh Nợ, khoản bên Có phải là phát sinh Có' USING ERRCODE = 'P0001'; END IF;
  IF d.parent_id IS NOT NULL OR c.parent_id IS NOT NULL THEN
    RAISE EXCEPTION 'SETTLEMENT_MISMATCH: khoản điều chỉnh đánh giá lại được đối trừ cùng khoản gốc, không đối trừ riêng' USING ERRCODE = 'P0001'; END IF;
  v_date := greatest(p_date, d.doc_date, c.doc_date, d.line_posting_date, c.line_posting_date);
  SELECT max(line_posting_date) INTO v_reval FROM open_item WHERE tenant_id = d.tenant_id AND parent_id IN (p_debit, p_credit);
  IF v_reval > v_date THEN
    RAISE EXCEPTION 'SETTLEMENT_BEFORE_REVALUATION: Khoản đã được đánh giá lại ngày %; chỉ đối trừ từ ngày đó trở đi (bỏ chọn khoản này trên chứng từ, ghi sổ rồi đối trừ ở màn hình Đối trừ chứng từ)', to_char(v_reval, 'DD/MM/YYYY') USING ERRCODE = 'P0001'; END IF;
  p := fn_period_of(d.tenant_id, v_date, false);
  PERFORM fn_assert_period_writable(p, 'arap');
  v_user := coalesce(app_user_id(), (SELECT created_by FROM voucher WHERE id = d.voucher_id));
  SELECT * INTO rd FROM fn_open_item_residual(p_debit);
  SELECT * INTO rc FROM fn_open_item_residual(p_credit);

  IF d.currency_code = 'VND' THEN
    IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'SETTLEMENT_AMOUNT_REQUIRED: đối trừ khoản VND phải có số tiền lớn hơn 0' USING ERRCODE = 'P0001'; END IF;
    IF p_amount > rd.vnd OR p_amount > -rc.vnd THEN
      RAISE EXCEPTION 'SETTLEMENT_EXCEEDS_RESIDUAL: số đối trừ % vượt số còn lại của khoản (Nợ %, Có %)', p_amount, rd.vnd, -rc.vnd USING ERRCODE = 'P0001'; END IF;
    INSERT INTO settlement(tenant_id, debit_item_id, credit_item_id, amount, amount_currency, settle_date, kind, group_id, created_by)
      VALUES (d.tenant_id, p_debit, p_credit, p_amount, p_amount, v_date, p_kind, v_group, v_user) RETURNING id INTO v_id;
    RETURN ARRAY[v_id];
  END IF;

  v_q := p_amount_currency;
  IF v_q IS NULL OR v_q <= 0 THEN RAISE EXCEPTION 'SETTLEMENT_AMOUNT_REQUIRED: đối trừ khoản ngoại tệ phải có số nguyên tệ lớn hơn 0' USING ERRCODE = 'P0001'; END IF;
  IF v_q > rd.cur OR v_q > -rc.cur THEN
    RAISE EXCEPTION 'SETTLEMENT_EXCEEDS_RESIDUAL: số nguyên tệ đối trừ % vượt số còn lại của khoản (Nợ %, Có %)', v_q, rd.cur, -rc.cur USING ERRCODE = 'P0001'; END IF;
  -- Khoản con: phần đối trừ s cùng dấu với dư của khoản con, theo tỷ lệ q / dư nguyên tệ của khoản gốc (lấy hết nguyên tệ thì lấy hết dư khoản con).
  FOR ch IN SELECT o.id, o.parent_id, r.vnd FROM open_item o CROSS JOIN LATERAL fn_open_item_residual(o.id) r
            WHERE o.tenant_id = d.tenant_id AND o.parent_id IN (p_debit, p_credit) AND r.vnd <> 0 ORDER BY o.parent_id = p_credit, o.id LOOP
    v_s := sign(ch.vnd) * fn_proportional_vnd(abs(ch.vnd), CASE WHEN ch.parent_id = p_debit THEN rd.cur ELSE -rc.cur END, v_q);
    IF ch.parent_id = p_debit THEN sum_r_d := sum_r_d + ch.vnd; sum_s_d := sum_s_d + v_s; ELSE sum_r_c := sum_r_c + ch.vnd; sum_s_c := sum_s_c + v_s; END IF;
    IF v_s > 0 THEN chp_id := chp_id || ch.id; chp_amt := chp_amt || v_s; ELSIF v_s < 0 THEN chn_id := chn_id || ch.id; chn_amt := chn_amt || -v_s; END IF;
  END LOOP;
  a_d := fn_proportional_vnd(rd.vnd + sum_r_d, rd.cur, v_q);
  a_c := fn_proportional_vnd(-(rc.vnd + sum_r_c), -rc.cur, v_q);
  -- Phần của khoản gốc = phần của cả nhóm trừ phần của khoản con, giữ trong [0, dư VND của khoản gốc] (lệch làm tròn dồn vào CL).
  x_d := least(greatest(a_d - sum_s_d, 0), greatest(rd.vnd, 0));
  x_c := least(greatest(a_c + sum_s_c, 0), greatest(-rc.vnd, 0));
  -- Chênh lệch: bên Có (thu/trả) lấy ra nhiều VND hơn bên Nợ thì lãi (khoản CL bên Nợ), ít hơn thì lỗ (khoản CL bên Có); bằng a_c − a_d khi không phải giữ trong khoảng.
  v_e := x_c - x_d - sum_s_d - sum_s_c;
  IF v_e <> 0 THEN
    SELECT rules INTO v_rules FROM fx_rule WHERE regime = p.regime;
    IF NOT FOUND THEN RAISE EXCEPTION 'FX_RULES_MISSING: Chưa khai báo tài khoản lãi, lỗ chênh lệch tỷ giá cho chế độ kế toán %', p.regime USING ERRCODE = 'P0001'; END IF;
    SELECT id INTO v_acc FROM account WHERE tenant_id = d.tenant_id AND regime = p.regime AND code = v_rules->>(CASE WHEN v_e > 0 THEN 'gainAccount' ELSE 'lossAccount' END);
    IF NOT FOUND THEN RAISE EXCEPTION 'FX_ACCOUNT_MISSING: Chưa có tài khoản % (lãi/lỗ chênh lệch tỷ giá) trong hệ thống tài khoản', v_rules->>(CASE WHEN v_e > 0 THEN 'gainAccount' ELSE 'lossAccount' END) USING ERRCODE = 'P0001'; END IF;
    v_cl := gen_random_uuid();
    INSERT INTO voucher(id, tenant_id, voucher_type, posting_date, document_date, description, party_id, currency_code, source_doc_type, source_doc_id, created_by)
      VALUES (v_cl, d.tenant_id, 'CL', v_date, v_date, 'Chênh lệch tỷ giá đối trừ ' || concat_ws(' – ', d.doc_no, c.doc_no), d.party_id, 'VND', 'settlement_fx', v_group, v_user);
    -- Dòng trên tài khoản công nợ mang loại tiền của khoản, nguyên tệ 0, không tỷ giá; dòng lãi/lỗ bằng VND.
    INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, currency_code, amount_currency, debit, credit, party_id, description)
    SELECT d.tenant_id, v_cl, x.no, x.acc, v_date, x.cur, 0, x.dr, x.cr, x.party, 'Chênh lệch tỷ giá đối trừ'
    FROM (VALUES (1, CASE WHEN v_e > 0 THEN d.account_id ELSE v_acc END, CASE WHEN v_e > 0 THEN d.currency_code ELSE 'VND' END, abs(v_e), 0::numeric, CASE WHEN v_e > 0 THEN d.party_id END),
                 (2, CASE WHEN v_e > 0 THEN v_acc ELSE d.account_id END, CASE WHEN v_e > 0 THEN 'VND' ELSE d.currency_code END, 0::numeric, abs(v_e), CASE WHEN v_e < 0 THEN d.party_id END))
         AS x(no, acc, cur, dr, cr, party);
    PERFORM post_voucher(v_cl);
    SELECT id INTO v_cl_item FROM open_item WHERE voucher_id = v_cl;
  END IF;

  -- Dòng 1: khoản gốc với khoản gốc, mang toàn bộ nguyên tệ q.
  v_m := least(x_d, x_c);
  INSERT INTO settlement(tenant_id, debit_item_id, credit_item_id, amount, amount_currency, settle_date, kind, fx_voucher_id, group_id, created_by)
    VALUES (d.tenant_id, p_debit, p_credit, v_m, v_q, v_date, p_kind, v_cl, v_group, v_user) RETURNING id INTO v_id;
  v_ids := v_ids || v_id;
  -- Phần VND còn lại (khoản gốc, khoản con, khoản CL) ghép bên Nợ với bên Có theo thứ tự, nguyên tệ 0; tổng hai bên bằng nhau nhờ cách tính v_e.
  IF x_d > v_m THEN pos_id := pos_id || p_debit; pos_amt := pos_amt || (x_d - v_m); END IF;
  IF x_c > v_m THEN neg_id := neg_id || p_credit; neg_amt := neg_amt || (x_c - v_m); END IF;
  pos_id := pos_id || chp_id; pos_amt := pos_amt || chp_amt; neg_id := neg_id || chn_id; neg_amt := neg_amt || chn_amt;
  IF v_e > 0 THEN pos_id := pos_id || v_cl_item; pos_amt := pos_amt || v_e; ELSIF v_e < 0 THEN neg_id := neg_id || v_cl_item; neg_amt := neg_amt || -v_e; END IF;
  WHILE i <= cardinality(pos_id) AND j <= cardinality(neg_id) LOOP
    v_m := least(pos_amt[i], neg_amt[j]);
    INSERT INTO settlement(tenant_id, debit_item_id, credit_item_id, amount, amount_currency, settle_date, kind, fx_voucher_id, group_id, created_by)
      VALUES (d.tenant_id, pos_id[i], neg_id[j], v_m, 0, v_date, CASE WHEN v_cl_item IN (pos_id[i], neg_id[j]) THEN 'fx' ELSE p_kind END, v_cl, v_group, v_user) RETURNING id INTO v_id;
    v_ids := v_ids || v_id;
    pos_amt[i] := pos_amt[i] - v_m; neg_amt[j] := neg_amt[j] - v_m;
    IF pos_amt[i] = 0 THEN i := i + 1; END IF;
    IF neg_amt[j] = 0 THEN j := j + 1; END IF;
  END LOOP;
  IF i <= cardinality(pos_id) OR j <= cardinality(neg_id) THEN
    RAISE EXCEPTION 'SETTLEMENT_UNBALANCED: phần đối trừ hai bên không bằng nhau' USING ERRCODE = 'P0001'; END IF;
  RETURN v_ids;
END $$;
