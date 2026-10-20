-- GĐ2 Task 9: đảo chứng từ giữ thông tin tiêu đề, số dư đầu kỳ theo tài khoản ngân hàng, kiểm kê quỹ.
-- Thân reverse_voucher lấy từ định nghĩa hiện hành (pg_get_functiondef) sau 0025; chỉ thêm các cột tiêu đề ở bước 1.

-- 1) reverse_voucher: chứng từ đảo chép thêm họ tên, địa chỉ, chứng từ gốc kèm theo, ba tài khoản ngân hàng, hạn thanh toán và mục đích của chứng từ gốc
-- (trước đây chỉ chép đối tượng, loại tiền, tỷ giá, nguồn), để bản đảo in và tra cứu cùng thông tin với bản gốc.
CREATE OR REPLACE FUNCTION reverse_voucher(p_id uuid, p_date date, p_description text)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; v_new uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'posted' THEN RAISE EXCEPTION 'STATE_INVALID: chỉ đảo được chứng từ đang ghi sổ (hiện tại: %)', v.state USING ERRCODE = 'P0001'; END IF;
  IF p_date < v.posting_date THEN RAISE EXCEPTION 'REVERSE_DATE_BEFORE_ORIGINAL: ngày đảo % trước ngày chứng từ gốc %', p_date, v.posting_date USING ERRCODE = 'P0001'; END IF;
  INSERT INTO voucher(id, tenant_id, voucher_type, posting_date, document_date, description, party_id, currency_code, fx_rate, source_doc_type, source_doc_id, reversal_of_id, is_closing, created_by,
                      person_name, person_address, attachments_count, bank_account_id, counter_bank_account_id, party_bank_account_id, due_date, purpose)
  VALUES (v_new, v.tenant_id, v.voucher_type, p_date, p_date, coalesce(p_description, 'Đảo chứng từ ' || v.voucher_no || ' ngày ' || to_char(v.posting_date, 'DD/MM/YYYY')),
          v.party_id, v.currency_code, v.fx_rate, v.source_doc_type, v.source_doc_id, p_id, v.is_closing, app_user_id(),
          v.person_name, v.person_address, v.attachments_count, v.bank_account_id, v.counter_bank_account_id, v.party_bank_account_id, v.due_date, v.purpose);
  INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, currency_code, fx_rate, amount_currency, debit, credit,
                           party_id, item_id, warehouse_id, department_id, project_id, cost_item_id, contract_id, employee_id, asset_id, extra_dims, description, due_date, bank_account_id)
  SELECT tenant_id, v_new, line_no, account_id, p_date, currency_code, fx_rate, -amount_currency, credit, debit,
         party_id, item_id, warehouse_id, department_id, project_id, cost_item_id, contract_id, employee_id, asset_id, extra_dims, description, due_date, bank_account_id
  FROM voucher_line WHERE voucher_id = p_id ORDER BY line_no;
  PERFORM post_voucher(v_new);
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'reversed', reversed_by_id = v_new WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_audit_voucher(v.tenant_id, 'reverse', p_id, jsonb_build_object('reversed_by', v_new, 'date', p_date));
  RETURN v_new;
END $function$;

-- 2) Số dư đầu kỳ theo tài khoản ngân hàng: một tài khoản sổ cái 1121 có thể có nhiều tài khoản ngân hàng, mỗi tài khoản một số dư đầu kỳ.
-- Khóa duy nhất thêm bank_account_id (NULL tính là 0: identity bắt đầu từ 1) để các dòng khác tài khoản ngân hàng không trùng nhau.
ALTER TABLE opening_balance ADD COLUMN bank_account_id bigint,
  ADD FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_account(tenant_id, id);
DROP INDEX opening_balance_key;
CREATE UNIQUE INDEX opening_balance_key ON opening_balance (tenant_id, fiscal_year, account_id, coalesce(party_id, '00000000-0000-0000-0000-000000000000'::uuid), currency_code, coalesce(bank_account_id, 0));
