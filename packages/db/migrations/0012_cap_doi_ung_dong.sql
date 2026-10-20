-- 0012_cap_doi_ung_dong.sql: mỗi cặp đối ứng ghi mã dòng Nợ và dòng Có gốc để sổ chi tiết gắn đúng chiều phân tích (khoản mục, vụ việc, bộ phận) của dòng.
-- Trước đây sổ phải tìm dòng theo (tài khoản, đối tượng): hai dòng cùng tài khoản và đối tượng (vd. 6421 chia hai khoản mục) bị gắn nhầm vào dòng đầu tiên.
-- Không có khóa ngoại: voucher_line là bảng phân vùng, khóa chính (id, posting_date). Dòng đã ghi sổ không đổi; bỏ ghi sổ xóa cặp, ghi sổ dựng lại cặp cùng mã dòng.
ALTER TABLE voucher_pair ADD COLUMN debit_line_id bigint, ADD COLUMN credit_line_id bigint;

-- Định nghĩa lại fn_build_pairs (0004) với một thay đổi duy nhất: điền debit_line_id và credit_line_id. Cách ghép giữ nguyên.
CREATE OR REPLACE FUNCTION fn_build_pairs(p_voucher uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher; nd int; nc int; total numeric;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  DELETE FROM voucher_pair WHERE voucher_id = p_voucher;
  SELECT count(*) FILTER (WHERE debit > 0), count(*) FILTER (WHERE credit > 0), coalesce(sum(debit),0) INTO nd, nc, total FROM voucher_line WHERE voucher_id = p_voucher;
  IF total = 0 THEN RETURN; END IF;
  IF nd = 1 OR nc = 1 THEN
    INSERT INTO voucher_pair(tenant_id, voucher_id, posting_date, debit_account_id, credit_account_id, debit_party_id, credit_party_id, amount, is_closing, debit_line_id, credit_line_id)
    SELECT v.tenant_id, p_voucher, v.posting_date, d.account_id, c.account_id, d.party_id, c.party_id, CASE WHEN nd = 1 THEN c.credit ELSE d.debit END, v.is_closing, d.id, c.id
    FROM voucher_line d JOIN voucher_line c ON c.voucher_id = d.voucher_id WHERE d.voucher_id = p_voucher AND d.debit > 0 AND c.credit > 0;
  ELSE
    -- n–n: ghép tham lam theo thứ tự line_no (góc tây bắc). Dòng Nợ và dòng Có là các đoạn nối tiếp trên trục [0, total);
    -- mỗi cặp là phần giao của một đoạn Nợ với một đoạn Có, nên tổng các cặp của từng dòng đúng bằng số Nợ/Có của dòng đó.
    INSERT INTO voucher_pair(tenant_id, voucher_id, posting_date, debit_account_id, credit_account_id, debit_party_id, credit_party_id, amount, is_closing, debit_line_id, credit_line_id)
    WITH d AS (SELECT id, account_id, party_id, debit AS amt, sum(debit) OVER (ORDER BY line_no) AS hi FROM voucher_line WHERE voucher_id = p_voucher AND debit > 0),
         c AS (SELECT id, account_id, party_id, credit AS amt, sum(credit) OVER (ORDER BY line_no) AS hi FROM voucher_line WHERE voucher_id = p_voucher AND credit > 0)
    SELECT v.tenant_id, p_voucher, v.posting_date, d.account_id, c.account_id, d.party_id, c.party_id,
           least(d.hi, c.hi) - greatest(d.hi - d.amt, c.hi - c.amt), v.is_closing, d.id, c.id
    FROM d JOIN c ON least(d.hi, c.hi) > greatest(d.hi - d.amt, c.hi - c.amt)
    ORDER BY d.hi, c.hi;
  END IF;
END $$;

-- Dựng lại cặp của mọi chứng từ đã ghi sổ hoặc đã đảo để cặp cũ cũng có mã dòng (kết quả ghép không đổi).
SELECT fn_build_pairs(id) FROM voucher WHERE state IN ('posted', 'reversed');
