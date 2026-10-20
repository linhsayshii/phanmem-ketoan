-- 0009_so_du_dau_ky.sql: bảng nhập số dư đầu kỳ (kỳ 0) và nới bất biến nguyên tệ cho chứng từ hỗn hợp VND/ngoại tệ.

-- Mỗi dòng: một tài khoản chi tiết (và một đối tượng với tài khoản công nợ) theo loại tiền. Khóa ngoại tổng hợp (tenant_id, ...) vì kiểm tra khóa ngoại bỏ qua RLS.
CREATE TABLE opening_balance (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  fiscal_year int NOT NULL,
  account_id bigint NOT NULL,
  party_id uuid,
  currency_code char(3) NOT NULL DEFAULT 'VND',
  debit numeric(20,0) NOT NULL DEFAULT 0 CHECK (debit >= 0), credit numeric(20,0) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  debit_currency numeric(20,4) NOT NULL DEFAULT 0 CHECK (debit_currency >= 0), credit_currency numeric(20,4) NOT NULL DEFAULT 0 CHECK (credit_currency >= 0),
  CONSTRAINT ob_one_side CHECK (debit = 0 OR credit = 0),
  FOREIGN KEY (tenant_id, account_id) REFERENCES account(tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES party(tenant_id, id),
  FOREIGN KEY (tenant_id, currency_code) REFERENCES currency(tenant_id, code));
CREATE UNIQUE INDEX opening_balance_key ON opening_balance (tenant_id, fiscal_year, account_id, coalesce(party_id, '00000000-0000-0000-0000-000000000000'::uuid), currency_code);
SELECT rls_enable('opening_balance'), audit_enable('opening_balance');

-- Cân bằng chứng từ: bản 0004 + nới bất biến nguyên tệ. SUM(amount_currency) = 0 chỉ bắt buộc khi mọi dòng cùng một ngoại tệ;
-- chứng từ hỗn hợp (dòng VND kèm dòng ngoại tệ, hoặc hai ngoại tệ) cân theo VND (Nợ = Có), vì số dư đầu kỳ có tài khoản ngoại tệ (vd. 1122) không thể cân theo từng loại tiền.
CREATE OR REPLACE FUNCTION fn_check_voucher_balance(p_voucher uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher; v_d numeric; v_c numeric; v_n int; v_ncur int; v_cur char(3); v_fx numeric;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  IF NOT FOUND THEN RETURN; END IF;  -- chứng từ đã bị xóa trong cùng transaction
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0), count(*), count(DISTINCT currency_code), min(currency_code), coalesce(sum(amount_currency),0)
    INTO v_d, v_c, v_n, v_ncur, v_cur, v_fx FROM voucher_line WHERE voucher_id = p_voucher;
  IF v_n = 0 AND v.state IN ('posted','reversed') THEN RAISE EXCEPTION 'VOUCHER_EMPTY: chứng từ % không có dòng', coalesce(v.voucher_no, v.id::text) USING ERRCODE = 'P0001'; END IF;
  IF v_d <> v_c THEN RAISE EXCEPTION 'VOUCHER_UNBALANCED: tổng Nợ % khác tổng Có %', v_d, v_c USING ERRCODE = 'P0001'; END IF;
  IF v_ncur = 1 AND v_cur <> 'VND' AND v_fx <> 0 THEN
    RAISE EXCEPTION 'VOUCHER_UNBALANCED_CURRENCY: nguyên tệ % lệch %', v_cur, v_fx USING ERRCODE = 'P0001'; END IF;
END $$;
