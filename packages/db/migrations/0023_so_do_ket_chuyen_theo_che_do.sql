-- I1 GĐ1.5: mỗi chế độ kế toán có sơ đồ kết chuyển riêng; năm mới đổi chế độ không còn ghi đè sơ đồ của năm cũ.
-- Bước cũ gán theo chế độ của năm tài chính gần nhất (đúng với hành vi trước đây: sơ đồ được nạp theo năm mới nhất); công ty chưa có năm nào: TT133.
ALTER TABLE closing_step ADD COLUMN regime text CHECK (regime IN ('TT99','TT133','TT200','TT58'));
UPDATE closing_step s SET regime = coalesce((SELECT p.regime FROM fiscal_period p WHERE p.tenant_id = s.tenant_id AND p.period_no > 0 ORDER BY p.date_to DESC LIMIT 1), 'TT133');
ALTER TABLE closing_step ALTER COLUMN regime SET NOT NULL;
ALTER TABLE closing_step DROP CONSTRAINT closing_step_tenant_id_step_order_key;
ALTER TABLE closing_step ADD CONSTRAINT closing_step_tenant_regime_order_key UNIQUE (tenant_id, regime, step_order) DEFERRABLE INITIALLY DEFERRED;

-- run_closing_step: thân 0011, thêm kiểm bước thuộc đúng chế độ của kỳ chạy (sai chế độ thì tài khoản đích/nguồn không khớp hệ tài khoản).
CREATE OR REPLACE FUNCTION run_closing_step(p_tenant uuid, p_step uuid, p_date date) RETURNS uuid[] LANGUAGE plpgsql AS $$
DECLARE s closing_step; v_regime text; a_to account; a_t account; src record; r jsonb; side int; v_id uuid; v_out uuid[] := '{}';
        v_desc text; n int; i int; n_ratio int; total numeric; alloc numeric; remain numeric;
BEGIN
  -- Hai yêu cầu cùng lúc (bấm đúp) cùng thấy số dư chưa kết chuyển và sinh trùng chứng từ: tuần tự hóa theo công ty, yêu cầu sau thấy số dư đã về 0.
  PERFORM pg_advisory_xact_lock(hashtextextended('closing:' || p_tenant::text, 0));
  SELECT * INTO s FROM closing_step WHERE id = p_step AND tenant_id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLOSING_STEP_NOT_FOUND: %', p_step USING ERRCODE = 'P0001'; END IF;
  v_regime := (fn_period_of(p_tenant, p_date, false)).regime;  -- chế độ của kỳ chứa ngày chạy (PERIOD_NOT_FOUND nếu chưa mở kỳ)
  IF s.regime <> v_regime THEN RAISE EXCEPTION 'CLOSING_STEP_REGIME_MISMATCH: bước kết chuyển thuộc sơ đồ % nhưng ngày % thuộc kỳ theo chế độ %', s.regime, p_date, v_regime USING ERRCODE = 'P0001'; END IF;
  v_desc := s.name || ' đến ngày ' || to_char(p_date, 'DD/MM/YYYY');
  IF s.mode = 'transfer' THEN
    SELECT * INTO a_to FROM account WHERE tenant_id = p_tenant AND regime = v_regime AND code = s.to_account AND NOT is_group AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'CLOSING_TO_ACCOUNT_INVALID: tài khoản đích % không tồn tại hoặc là tổng hợp', s.to_account USING ERRCODE = 'P0001'; END IF;
    -- side = -1: nguồn dư Có (Nợ nguồn / Có đích); side = 1: nguồn dư Nợ (Nợ đích / Có nguồn).
    FOREACH side IN ARRAY ARRAY[-1, 1] LOOP
      v_id := NULL; n := 0;
      FOR src IN SELECT * FROM fn_closing_sources(p_tenant, v_regime, s.from_accounts, p_date, s.by_dimension IS NOT DISTINCT FROM 'project') f
                 WHERE sign(f.net) = side AND f.account_id <> a_to.id LOOP
        alloc := src.net - side * least(abs(src.net), s.keep_balance);
        CONTINUE WHEN alloc = 0;
        IF v_id IS NULL THEN v_id := fn_closing_new_voucher(p_tenant, 'KC', p_date, v_desc, p_step); END IF;
        n := n + 1;
        INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, party_id, project_id, description)
        VALUES (p_tenant, v_id, n, src.account_id, p_date, greatest(-alloc, 0), greatest(alloc, 0), src.party_id, src.project_id, s.name);
      END LOOP;
      IF v_id IS NOT NULL THEN
        -- Dòng đích bù phía ngược lại: các dòng nguồn của chứng từ này cùng một bên.
        INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, description)
        SELECT p_tenant, v_id, n + 1, a_to.id, p_date, sum(credit), sum(debit), s.name FROM voucher_line WHERE voucher_id = v_id;
        PERFORM post_voucher(v_id);
        INSERT INTO closing_run(tenant_id, step_id, posting_date, voucher_id, created_by) VALUES (p_tenant, p_step, p_date, v_id, app_user_id());
        v_out := v_out || v_id;
      END IF;
    END LOOP;
    RETURN v_out;
  END IF;
  -- allocate
  IF s.ratio_source IS NULL OR (SELECT coalesce(sum((x->>'percent')::numeric), 0) <> 100 OR coalesce(bool_or((x->>'percent')::numeric <= 0), false)
                                FROM jsonb_array_elements(s.ratio_source->'ratios') x) THEN
    RAISE EXCEPTION 'CLOSING_RATIO_INVALID: tổng tỷ lệ phải bằng 100 và mỗi tỷ lệ phải lớn hơn 0' USING ERRCODE = 'P0001'; END IF;
  SELECT sum(f.net) INTO total FROM fn_closing_sources(p_tenant, v_regime, s.from_accounts, p_date, false) f;
  IF total IS NULL OR total = 0 THEN RETURN v_out; END IF;
  v_id := fn_closing_new_voucher(p_tenant, 'PB', p_date, v_desc, p_step);
  remain := abs(total); n := 0; i := 0; n_ratio := jsonb_array_length(s.ratio_source->'ratios');
  FOR r IN SELECT x FROM jsonb_array_elements(s.ratio_source->'ratios') x LOOP
    i := i + 1;
    SELECT * INTO a_t FROM account WHERE tenant_id = p_tenant AND regime = v_regime AND code = r->>'account' AND NOT is_group;
    IF NOT FOUND THEN RAISE EXCEPTION 'CLOSING_TO_ACCOUNT_INVALID: tài khoản % không tồn tại hoặc là tổng hợp', r->>'account' USING ERRCODE = 'P0001'; END IF;
    -- least(remain, ...): nhiều dòng cùng làm tròn lên không được vượt tổng.
    alloc := CASE WHEN i = n_ratio THEN remain ELSE least(remain, round(abs(total) * (r->>'percent')::numeric / 100)) END;
    remain := remain - alloc;
    IF alloc > 0 THEN
      n := n + 1;
      INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, description)
      VALUES (p_tenant, v_id, n, a_t.id, p_date, CASE WHEN total > 0 THEN alloc ELSE 0 END, CASE WHEN total > 0 THEN 0 ELSE alloc END, s.name);
    END IF;
  END LOOP;
  FOR src IN SELECT * FROM fn_closing_sources(p_tenant, v_regime, s.from_accounts, p_date, false) LOOP
    n := n + 1;
    INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, party_id, description)
    VALUES (p_tenant, v_id, n, src.account_id, p_date, greatest(-src.net, 0), greatest(src.net, 0), src.party_id, s.name);
  END LOOP;
  PERFORM post_voucher(v_id);
  INSERT INTO closing_run(tenant_id, step_id, posting_date, voucher_id, created_by) VALUES (p_tenant, p_step, p_date, v_id, app_user_id());
  RETURN v_out || v_id;
END $$;
