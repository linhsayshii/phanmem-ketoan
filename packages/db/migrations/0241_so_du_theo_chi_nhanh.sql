-- 0241_so_du_theo_chi_nhanh.sql: số dư tại ngày theo chi nhánh (sổ sách, BCTC lọc chi nhánh).
-- Số dư kỳ (account_period_balance) không mang chi nhánh, nên cộng thẳng dòng đã ghi sổ: cùng cách chọn kỳ và cùng kết quả với nhánh "slow" của fn_balances_at
-- (kỳ chứa ngày, kỳ 0 chỉ khi không có kỳ thường trước đó), thêm điều kiện chi nhánh của chứng từ. Không SECURITY DEFINER: RLS phạm vi chi nhánh vẫn áp dụng.
CREATE FUNCTION fn_balances_at_branch(p_tenant uuid, p_date date, p_branches bigint[], p_head_office boolean)
 RETURNS TABLE(account_id bigint, party_id uuid, currency_code character, debit numeric, credit numeric, debit_cur numeric, credit_cur numeric)
 LANGUAGE plpgsql STABLE AS $function$
#variable_conflict use_column
DECLARE p fiscal_period; v_nil uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  SELECT f.* INTO p FROM fiscal_period f WHERE f.tenant_id = p_tenant AND f.date_from <= p_date
    AND (f.period_no >= 1 OR NOT EXISTS (SELECT 1 FROM fiscal_period g WHERE g.tenant_id = p_tenant AND g.period_no >= 1 AND g.date_to <= f.date_from))
  ORDER BY f.fiscal_year DESC, f.period_no DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
  SELECT l.account_id, coalesce(l.party_id, v_nil), l.currency_code,
         greatest(sum(l.debit - l.credit), 0), greatest(-sum(l.debit - l.credit), 0), greatest(sum(l.amount_currency), 0), greatest(-sum(l.amount_currency), 0)
  FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
  WHERE v.tenant_id = p_tenant AND v.state IN ('posted','reversed')
    AND (v.branch_id = ANY (p_branches) OR (p_head_office AND v.branch_id IS NULL))
    AND ((v.fiscal_year, v.period_no) < (p.fiscal_year, p.period_no) OR (v.fiscal_year = p.fiscal_year AND v.period_no = p.period_no AND l.posting_date <= p_date))
  GROUP BY l.account_id, coalesce(l.party_id, v_nil), l.currency_code HAVING sum(l.debit - l.credit) <> 0 OR sum(l.amount_currency) <> 0;
END $function$;
