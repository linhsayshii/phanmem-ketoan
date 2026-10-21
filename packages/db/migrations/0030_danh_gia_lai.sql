-- GĐ2 Task 13: đánh giá lại số dư ngoại tệ cuối kỳ (chứng từ DG, source_doc_type = 'fx_revaluation').
-- Thân fn_open_items_create lấy từ định nghĩa hiện hành (pg_get_functiondef) sau 0029, chỉ thêm cột parent_id: dòng DG trên tài khoản công nợ là khoản con
-- (điều chỉnh đánh giá lại) của khoản gốc ghi ở voucher_line.extra_dims->>'reval_of'. Bản đảo của DG chép source_doc_type và extra_dims nên khoản của nó cũng là khoản con
-- của cùng khoản gốc (đối trừ kiểu 'reversal' với khoản con của DG). Khóa ngoại (tenant_id, parent_id) bảo đảm khoản gốc có thật trong cùng công ty.
CREATE OR REPLACE FUNCTION fn_open_items_create(p_voucher uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; n int;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  IF v.state IS NULL OR v.state NOT IN ('posted', 'reversed') THEN RETURN 0; END IF; -- công nợ: chỉ chứng từ đã ghi sổ (hoặc đã bị đảo) mới có khoản
  INSERT INTO open_item(tenant_id, voucher_id, voucher_line_id, line_posting_date, line_no, account_id, party_id, currency_code, doc_date, doc_no, due_date, amount, amount_currency, parent_id)
  SELECT l.tenant_id, l.voucher_id, l.id, l.posting_date, l.line_no, l.account_id, l.party_id, l.currency_code, d.doc_date, d.doc_no,
         coalesce(l.due_date, v.due_date, d.doc_date + p.payment_term_days), l.debit - l.credit, l.amount_currency,
         CASE WHEN v.source_doc_type = 'fx_revaluation' THEN (l.extra_dims->>'reval_of')::bigint END -- đánh giá lại: khoản con của khoản gốc
  FROM voucher_line l JOIN account a ON a.id = l.account_id AND a.reconcile JOIN party p ON p.id = l.party_id
  CROSS JOIN LATERAL (SELECT
      CASE WHEN v.voucher_type = 'DK' THEN coalesce((l.extra_dims->>'opening_doc_date')::date, v.posting_date) ELSE v.document_date END AS doc_date,
      CASE WHEN v.voucher_type = 'DK' THEN nullif(l.extra_dims->>'opening_doc_no', '') ELSE v.voucher_no END AS doc_no) d
  WHERE l.voucher_id = p_voucher AND l.posting_date = v.posting_date;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;
