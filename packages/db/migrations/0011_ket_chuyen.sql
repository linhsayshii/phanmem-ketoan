-- 0011_ket_chuyen.sql: sơ đồ kết chuyển/phân bổ cuối kỳ và thủ tục chạy từng bước sinh chứng từ KC/PB, chạy lại bằng đảo chứng từ cũ.
-- Chạy với quyền người gọi (app_user, có RLS), không SECURITY DEFINER: truyền công ty khác vào thì RLS làm hàm không thấy gì.

-- UNIQUE hoãn đến cuối giao dịch: lưu lại sơ đồ có đổi chỗ thứ tự (2<->3) không vướng trùng giữa chừng.
CREATE TABLE closing_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  step_order int NOT NULL, name text NOT NULL, mode text NOT NULL CHECK (mode IN ('transfer','allocate')),
  from_accounts text[] NOT NULL, to_account text, keep_balance numeric(20,0) NOT NULL DEFAULT 0 CHECK (keep_balance >= 0),
  by_dimension text CHECK (by_dimension IN ('project')), ratio_source jsonb,
  run_at text NOT NULL DEFAULT 'period_end' CHECK (run_at IN ('period_end','next_year_start')), is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, step_order) DEFERRABLE INITIALLY DEFERRED);
-- step_id NULL khi bước bị xóa khỏi sơ đồ (sửa/nạp lại sơ đồ): nhật ký chạy là dấu vết của chứng từ KC/PB nên không được mất theo.
CREATE TABLE closing_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  step_id uuid REFERENCES closing_step(id) ON DELETE SET NULL,
  posting_date date NOT NULL, voucher_id uuid NOT NULL REFERENCES voucher(id), status text NOT NULL DEFAULT 'done' CHECK (status IN ('done','reversed')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid);
CREATE INDEX ON closing_run (tenant_id, step_id, posting_date);
SELECT rls_enable('closing_step'), audit_enable('closing_step'), rls_enable('closing_run');

-- Số dư ròng (Nợ - Có) đến hết ngày theo (tài khoản, [vụ việc], [đối tượng]) của các tài khoản thuộc chế độ p_regime có số hiệu bắt đầu bằng một tiền tố.
-- Phải lọc theo chế độ: một công ty có thể giữ nhiều hệ tài khoản (mã trùng nhau), tiền tố '511' không được quét sang hệ khác.
-- Đối tượng chỉ mang theo với tài khoản công nợ (dòng sổ cái của tài khoản đó bắt buộc có đối tượng).
-- shortcut: chỉ tính VND; tài khoản vật tư/tài sản (cần item_id/asset_id) làm trigger dòng từ chối, nâng cấp khi làm kho/tài sản (giai đoạn 2).
CREATE OR REPLACE FUNCTION fn_closing_sources(p_tenant uuid, p_regime text, p_prefixes text[], p_date date, p_by_project boolean)
RETURNS TABLE(account_id bigint, project_id bigint, party_id uuid, net numeric) LANGUAGE sql STABLE AS $$
  -- hàm SQL thuần: không có xung đột tên biến
  SELECT l.account_id, CASE WHEN p_by_project THEN l.project_id END, CASE WHEN a.subledger_kind IN ('receivable','payable') THEN l.party_id END, sum(l.debit - l.credit)
  FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
  WHERE v.tenant_id = p_tenant AND a.regime = p_regime AND v.state IN ('posted','reversed') AND l.posting_date <= p_date
    AND EXISTS (SELECT 1 FROM unnest(p_prefixes) pf WHERE starts_with(a.code, pf))
  GROUP BY l.account_id, a.code, 2, 3 HAVING sum(l.debit - l.credit) <> 0
  ORDER BY a.code, 2, 3;
$$;

CREATE OR REPLACE FUNCTION fn_closing_new_voucher(p_tenant uuid, p_type text, p_date date, p_desc text, p_step uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO voucher(tenant_id, voucher_type, posting_date, document_date, description, is_closing, source_doc_type, source_doc_id, created_by)
  VALUES (p_tenant, p_type, p_date, p_date, p_desc, p_type = 'KC', 'closing_step', p_step, app_user_id()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Chạy một bước tại ngày p_date; trả về các chứng từ đã sinh và ghi sổ (không có số dư để kết chuyển thì trả mảng rỗng).
--  transfer: mỗi tài khoản nguồn chuyển hết số dư (trừ keep_balance) sang to_account; tối đa hai chứng từ KC: một cho nguồn dư Có, một cho nguồn dư Nợ.
--  allocate: một chứng từ PB chia tổng số dư các tài khoản nguồn cho các tài khoản đích theo tỷ lệ phần trăm, phần dư làm tròn dồn vào dòng cuối.
CREATE OR REPLACE FUNCTION run_closing_step(p_tenant uuid, p_step uuid, p_date date) RETURNS uuid[] LANGUAGE plpgsql AS $$
DECLARE s closing_step; v_regime text; a_to account; a_t account; src record; r jsonb; side int; v_id uuid; v_out uuid[] := '{}';
        v_desc text; n int; i int; n_ratio int; total numeric; alloc numeric; remain numeric;
BEGIN
  -- Hai yêu cầu cùng lúc (bấm đúp) cùng thấy số dư chưa kết chuyển và sinh trùng chứng từ: tuần tự hóa theo công ty, yêu cầu sau thấy số dư đã về 0.
  PERFORM pg_advisory_xact_lock(hashtextextended('closing:' || p_tenant::text, 0));
  SELECT * INTO s FROM closing_step WHERE id = p_step AND tenant_id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLOSING_STEP_NOT_FOUND: %', p_step USING ERRCODE = 'P0001'; END IF;
  v_regime := (fn_period_of(p_tenant, p_date, false)).regime;  -- chế độ của kỳ chứa ngày chạy (PERIOD_NOT_FOUND nếu chưa mở kỳ)
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

-- Chạy lại: đảo các chứng từ đang ghi sổ của lần chạy trước (cùng bước, cùng ngày) rồi chạy bước từ đầu; không sửa đè chứng từ cũ.
CREATE OR REPLACE FUNCTION rerun_closing_step(p_tenant uuid, p_step uuid, p_date date) RETURNS uuid[] LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('closing:' || p_tenant::text, 0));
  FOR r IN SELECT cr.id, cr.voucher_id FROM closing_run cr JOIN voucher v ON v.id = cr.voucher_id
           WHERE cr.tenant_id = p_tenant AND cr.step_id = p_step AND cr.posting_date = p_date AND cr.status = 'done' AND v.state = 'posted' ORDER BY cr.id LOOP
    PERFORM reverse_voucher(r.voucher_id, p_date, 'Đảo để chạy lại kết chuyển');
    UPDATE closing_run SET status = 'reversed' WHERE id = r.id;
  END LOOP;
  RETURN run_closing_step(p_tenant, p_step, p_date);
END $$;
