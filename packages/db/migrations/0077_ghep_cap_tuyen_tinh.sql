-- 0077_ghep_cap_tuyen_tinh.sql: ghép cặp Nợ–Có n–n trong thời gian gần tuyến tính. Bản cũ (0042) nối d JOIN c bằng điều kiện giao đoạn (không phải so sánh bằng) nên PostgreSQL
-- so từng cặp Nợ × Có: chứng từ khấu hao 3.000 thẻ (6.000 dòng Nợ, 3.000 dòng Có) mất khoảng 8 giây ở bước ghi sổ. Bản này cắt trục [0, tổng) tại mọi điểm cuối đoạn Nợ/Có,
-- mỗi khoảng giữa hai điểm liền nhau thuộc đúng một dòng Nợ và một dòng Có, tìm bằng số đoạn đã qua (so sánh bằng). Kết quả ghép và thứ tự giữ nguyên bản 0042.
-- Thân hàm lấy từ bản cuối (0042); nhánh một–nhiều và việc cắt phân vùng theo posting_date không đổi.

CREATE OR REPLACE FUNCTION fn_build_pairs(p_voucher uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher; nd int; nc int; total numeric; v_nl text;
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
    -- n: số thứ tự đoạn (từ 0); pts: các điểm cuối khác nhau; khoảng (lo, hi] thuộc đoạn Nợ số (số điểm cuối Nợ nhỏ hơn hi) và đoạn Có số (số điểm cuối Có nhỏ hơn hi).
    -- Sau khi cắt phân vùng, bộ lập kế hoạch đoán mỗi CTE vài dòng và chọn vòng lặp lồng (bình phương số dòng) thay cho nối băm: tắt vòng lặp lồng trong câu lệnh này rồi trả lại.
    v_nl := current_setting('enable_nestloop'); PERFORM set_config('enable_nestloop', 'off', true);
    INSERT INTO voucher_pair(tenant_id, voucher_id, posting_date, debit_account_id, credit_account_id, debit_party_id, credit_party_id, amount, is_closing, debit_line_id, credit_line_id)
    WITH d AS (SELECT id, account_id, party_id, sum(debit) OVER (ORDER BY line_no) AS hi, row_number() OVER (ORDER BY line_no) - 1 AS n FROM voucher_line WHERE voucher_id = p_voucher AND posting_date = v.posting_date AND debit > 0),
         c AS (SELECT id, account_id, party_id, sum(credit) OVER (ORDER BY line_no) AS hi, row_number() OVER (ORDER BY line_no) - 1 AS n FROM voucher_line WHERE voucher_id = p_voucher AND posting_date = v.posting_date AND credit > 0),
         pts AS (SELECT hi, bool_or(is_d) AS is_d, bool_or(NOT is_d) AS is_c FROM (SELECT hi, true AS is_d FROM d UNION ALL SELECT hi, false FROM c) x GROUP BY hi),
         seg AS (SELECT hi, hi - coalesce(lag(hi) OVER (ORDER BY hi), 0) AS amt,
                        coalesce(sum(is_d::int) OVER (ORDER BY hi ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS dn,
                        coalesce(sum(is_c::int) OVER (ORDER BY hi ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cn FROM pts)
    SELECT v.tenant_id, p_voucher, v.posting_date, d.account_id, c.account_id, d.party_id, c.party_id, seg.amt, v.is_closing, d.id, c.id
    FROM seg JOIN d ON d.n = seg.dn JOIN c ON c.n = seg.cn
    WHERE seg.amt > 0
    ORDER BY seg.hi;
    PERFORM set_config('enable_nestloop', v_nl, true);
  END IF;
END $$;
