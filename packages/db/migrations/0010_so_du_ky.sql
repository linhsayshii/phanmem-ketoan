-- 0010_so_du_ky.sql: số dư theo kỳ (account_period_balance), tính lại từ kỳ bẩn trở đi và đọc số dư tại một ngày.
-- Chạy với quyền người gọi (app_user, có RLS), không SECURITY DEFINER: truyền công ty khác vào thì RLS làm hàm không thấy gì.

-- Một hạt: (tài khoản, đối tượng, loại tiền) mỗi kỳ. party_id là đối tượng thật của dòng chứng từ, sentinel (toàn số 0) khi dòng không có đối tượng;
-- số dư của tài khoản là tổng các dòng. Chỉ chứa dòng có số dư đầu kỳ hoặc phát sinh khác 0.
CREATE TABLE account_period_balance (
  tenant_id uuid NOT NULL, account_id bigint NOT NULL REFERENCES account(id), fiscal_year int NOT NULL, period_no int NOT NULL,
  currency_code char(3) NOT NULL, party_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  opening_debit numeric(20,0) NOT NULL DEFAULT 0, opening_credit numeric(20,0) NOT NULL DEFAULT 0,
  period_debit numeric(20,0) NOT NULL DEFAULT 0, period_credit numeric(20,0) NOT NULL DEFAULT 0,
  closing_debit numeric(20,0) NOT NULL DEFAULT 0, closing_credit numeric(20,0) NOT NULL DEFAULT 0,
  opening_debit_cur numeric(20,4) NOT NULL DEFAULT 0, opening_credit_cur numeric(20,4) NOT NULL DEFAULT 0,
  period_debit_cur numeric(20,4) NOT NULL DEFAULT 0, period_credit_cur numeric(20,4) NOT NULL DEFAULT 0,
  closing_debit_cur numeric(20,4) NOT NULL DEFAULT 0, closing_credit_cur numeric(20,4) NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, fiscal_year, period_no, currency_code, party_id));
CREATE INDEX ON account_period_balance (tenant_id, fiscal_year, period_no);
SELECT rls_enable('account_period_balance');

-- Trả về số kỳ đã tính (0 khi không có gì phải làm). Tính lại từ kỳ bẩn trở đi; mốc bẩn chỉ xóa khi không ai đặt lại nó trong lúc chạy (marked_at không đổi).
CREATE OR REPLACE FUNCTION recompute_balances(p_tenant uuid) RETURNS int LANGUAGE plpgsql AS $$
DECLARE st balance_stale; nw record; per record; prev record; n int := 0; v_year int; v_period int; v_nil uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  -- Khóa trước rồi mới đọc mốc: bản chạy chờ khóa đọc được mốc mới nhất, không tính lại thừa theo mốc cũ.
  PERFORM pg_advisory_xact_lock(hashtext('recompute_balances'), hashtext(p_tenant::text));
  SELECT * INTO st FROM balance_stale WHERE tenant_id = p_tenant;
  -- Kỳ chưa có snapshot (kỳ tạo sau lần tính trước, vd. năm tài chính mới) cũng phải tính, kể cả khi không có mốc bẩn: nếu không, số dư kết chuyển từ kỳ trước bị mất.
  -- shortcut: công ty mà mọi số dư cuối kỳ đều bằng 0 thì kỳ cuối không có dòng nào nên bị tính lại mỗi lần (rẻ, vì không có dòng); nâng cấp khi cần đánh dấu kỳ đã tính.
  SELECT f.fiscal_year, f.period_no INTO nw FROM fiscal_period f WHERE f.tenant_id = p_tenant
    AND NOT EXISTS (SELECT 1 FROM account_period_balance b WHERE b.tenant_id = p_tenant AND (b.fiscal_year, b.period_no) >= (f.fiscal_year, f.period_no))
  ORDER BY f.fiscal_year, f.period_no LIMIT 1;
  v_year := st.stale_year; v_period := st.stale_period;
  IF v_year IS NULL OR (nw.fiscal_year IS NOT NULL AND (nw.fiscal_year, nw.period_no) < (v_year, v_period)) THEN v_year := nw.fiscal_year; v_period := nw.period_no; END IF;
  IF v_year IS NULL THEN RETURN 0; END IF;
  DELETE FROM account_period_balance WHERE tenant_id = p_tenant AND (fiscal_year, period_no) >= (v_year, v_period);
  INSERT INTO account_period_balance(tenant_id, account_id, fiscal_year, period_no, currency_code, party_id, period_debit, period_credit, period_debit_cur, period_credit_cur)
  SELECT v.tenant_id, l.account_id, v.fiscal_year, v.period_no, l.currency_code, coalesce(l.party_id, v_nil),
         sum(l.debit), sum(l.credit), sum(greatest(l.amount_currency, 0)), sum(greatest(-l.amount_currency, 0))
  FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
  WHERE v.tenant_id = p_tenant AND v.state IN ('posted','reversed') AND (v.fiscal_year, v.period_no) >= (v_year, v_period)
  GROUP BY v.tenant_id, l.account_id, v.fiscal_year, v.period_no, l.currency_code, coalesce(l.party_id, v_nil);
  FOR per IN SELECT fiscal_year, period_no FROM fiscal_period WHERE tenant_id = p_tenant AND (fiscal_year, period_no) >= (v_year, v_period) ORDER BY fiscal_year, period_no LOOP
    SELECT fiscal_year, period_no INTO prev FROM fiscal_period WHERE tenant_id = p_tenant AND (fiscal_year, period_no) < (per.fiscal_year, per.period_no) ORDER BY fiscal_year DESC, period_no DESC LIMIT 1;
    IF prev.fiscal_year IS NOT NULL THEN
      INSERT INTO account_period_balance(tenant_id, account_id, fiscal_year, period_no, currency_code, party_id, opening_debit, opening_credit, opening_debit_cur, opening_credit_cur)
      SELECT b.tenant_id, b.account_id, per.fiscal_year, per.period_no, b.currency_code, b.party_id, b.closing_debit, b.closing_credit, b.closing_debit_cur, b.closing_credit_cur
      FROM account_period_balance b WHERE b.tenant_id = p_tenant AND b.fiscal_year = prev.fiscal_year AND b.period_no = prev.period_no
        AND (b.closing_debit <> 0 OR b.closing_credit <> 0 OR b.closing_debit_cur <> 0 OR b.closing_credit_cur <> 0)
      ON CONFLICT (tenant_id, account_id, fiscal_year, period_no, currency_code, party_id) DO UPDATE
        SET opening_debit = EXCLUDED.opening_debit, opening_credit = EXCLUDED.opening_credit, opening_debit_cur = EXCLUDED.opening_debit_cur, opening_credit_cur = EXCLUDED.opening_credit_cur;
    END IF;
    UPDATE account_period_balance SET
      closing_debit = greatest(opening_debit - opening_credit + period_debit - period_credit, 0),
      closing_credit = greatest(-(opening_debit - opening_credit + period_debit - period_credit), 0),
      closing_debit_cur = greatest(opening_debit_cur - opening_credit_cur + period_debit_cur - period_credit_cur, 0),
      closing_credit_cur = greatest(-(opening_debit_cur - opening_credit_cur + period_debit_cur - period_credit_cur), 0),
      computed_at = now()
    WHERE tenant_id = p_tenant AND fiscal_year = per.fiscal_year AND period_no = per.period_no;
    n := n + 1;
  END LOOP;
  -- Chỉ xóa đúng mốc đã đọc: mốc bị đặt lại trong lúc chạy có marked_at mới nên giữ nguyên cho lần tính sau (st rỗng thì không khớp dòng nào).
  DELETE FROM balance_stale WHERE tenant_id = p_tenant AND stale_year = st.stale_year AND stale_period = st.stale_period AND marked_at = st.marked_at;
  RETURN n;
END $$;

-- Số dư cuối ngày p_date theo (tài khoản, đối tượng, loại tiền); debit/credit tách từ số dư ròng nên một trong hai bằng 0.
-- Đường nhanh: số dư đầu kỳ của kỳ chứa ngày (snapshot) cộng các dòng của kỳ đó đến ngày. Đường chậm (tổng mọi dòng): khi snapshot bẩn đến kỳ này hoặc kỳ này chưa có snapshot.
-- Chứng từ đã đảo ('reversed') vẫn tính: chứng từ gốc và chứng từ đảo cùng nằm trong sổ, triệt tiêu nhau từ ngày đảo.
CREATE OR REPLACE FUNCTION fn_balances_at(p_tenant uuid, p_date date)
RETURNS TABLE(account_id bigint, party_id uuid, currency_code char(3), debit numeric, credit numeric, debit_cur numeric, credit_cur numeric) LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
DECLARE p fiscal_period; st balance_stale; slow boolean; v_nil uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  SELECT f.* INTO p FROM fiscal_period f WHERE f.tenant_id = p_tenant AND f.date_from <= p_date
    AND (f.period_no >= 1 OR NOT EXISTS (SELECT 1 FROM fiscal_period g WHERE g.tenant_id = p_tenant AND g.period_no >= 1 AND g.date_to <= f.date_from))
  ORDER BY f.fiscal_year DESC, f.period_no DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO st FROM balance_stale WHERE tenant_id = p_tenant;
  slow := (FOUND AND (st.stale_year, st.stale_period) <= (p.fiscal_year, p.period_no))
       OR NOT EXISTS (SELECT 1 FROM account_period_balance b WHERE b.tenant_id = p_tenant AND (b.fiscal_year, b.period_no) >= (p.fiscal_year, p.period_no));
  IF slow THEN
    RETURN QUERY
    SELECT l.account_id, coalesce(l.party_id, v_nil), l.currency_code,
           greatest(sum(l.debit - l.credit), 0), greatest(-sum(l.debit - l.credit), 0), greatest(sum(l.amount_currency), 0), greatest(-sum(l.amount_currency), 0)
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
    WHERE v.tenant_id = p_tenant AND v.state IN ('posted','reversed')
      AND ((v.fiscal_year, v.period_no) < (p.fiscal_year, p.period_no) OR (v.fiscal_year = p.fiscal_year AND v.period_no = p.period_no AND l.posting_date <= p_date))
    GROUP BY l.account_id, coalesce(l.party_id, v_nil), l.currency_code HAVING sum(l.debit - l.credit) <> 0 OR sum(l.amount_currency) <> 0;
  ELSE
    RETURN QUERY
    WITH o AS (SELECT b.account_id, b.party_id, b.currency_code, b.opening_debit - b.opening_credit AS net, b.opening_debit_cur - b.opening_credit_cur AS net_cur
               FROM account_period_balance b WHERE b.tenant_id = p_tenant AND b.fiscal_year = p.fiscal_year AND b.period_no = p.period_no),
         m AS (SELECT l.account_id, coalesce(l.party_id, v_nil) AS party_id, l.currency_code, sum(l.debit - l.credit) AS net, sum(l.amount_currency) AS net_cur
               FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
               WHERE v.tenant_id = p_tenant AND v.state IN ('posted','reversed') AND v.fiscal_year = p.fiscal_year AND v.period_no = p.period_no AND l.posting_date <= p_date
               GROUP BY l.account_id, coalesce(l.party_id, v_nil), l.currency_code),
         u AS (SELECT * FROM o UNION ALL SELECT * FROM m)
    SELECT u.account_id, u.party_id, u.currency_code, greatest(sum(u.net), 0), greatest(-sum(u.net), 0), greatest(sum(u.net_cur), 0), greatest(-sum(u.net_cur), 0)
    FROM u GROUP BY u.account_id, u.party_id, u.currency_code HAVING sum(u.net) <> 0 OR sum(u.net_cur) <> 0;
  END IF;
END $$;
