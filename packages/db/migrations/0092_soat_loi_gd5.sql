-- GĐ5 Task 18: chín quy tắc soát lỗi hóa đơn điện tử, hóa đơn đầu vào, giao dịch ngân hàng.
-- Định nghĩa lại seed_data_check_rules từ thân hiện hành (qua 0076): chèn các dòng mới trước ON CONFLICT.
-- "Quá N ngày/giờ" so với now() theo giờ Asia/Ho_Chi_Minh; khoảng ngày $1..$2 lọc theo ngày của đối tượng.
DO $mig$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('seed_data_check_rules(uuid)'::regprocedure);
  IF position($r$ON CONFLICT DO NOTHING$r$ IN d) = 0 THEN RAISE EXCEPTION 'seed_data_check_rules không có ON CONFLICT DO NOTHING'; END IF;
  n := $new$,
  (p_tenant, 'HDDT_CHUA_PHAT_HANH', 'Chứng từ bán chưa phát hành hóa đơn điện tử', 'warning',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'Ngày chứng từ ' || to_char(v.document_date, 'DD/MM/YYYY')
      FROM voucher v JOIN voucher_invoice i ON i.voucher_id = v.id
      WHERE v.state = 'posted' AND i.einvoice_pending AND v.posting_date BETWEEN $1 AND $2
        AND (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - v.document_date > 1
      ORDER BY v.posting_date, v.voucher_no$q$,
   'Chứng từ bán đã ghi sổ còn chờ số hóa đơn điện tử quá 1 ngày', 'Phát hành hóa đơn điện tử cho chứng từ (Hóa đơn điện tử, Phát hành)', true, '{}'),
  (p_tenant, 'HDDT_DANG_GUI', 'Hóa đơn điện tử đang gửi quá 1 giờ', 'error',
   $q$SELECT e.voucher_id, coalesce(v.voucher_no, '(nháp)'), 'Gửi từ ' || to_char(coalesce(e.last_attempt_at, e.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI')
      FROM einvoice e JOIN voucher v ON v.id = e.voucher_id
      WHERE e.status = 'sending' AND coalesce(e.last_attempt_at, e.created_at) < now() - interval '1 hour'
        AND (e.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1 AND $2
      ORDER BY e.created_at, e.id$q$,
   'Hóa đơn điện tử ở trạng thái đang gửi quá 1 giờ, chưa có kết quả từ nhà cung cấp', 'Đối soát trạng thái với nhà cung cấp hóa đơn điện tử', true, '{}'),
  (p_tenant, 'HDDT_LOI', 'Hóa đơn điện tử phát hành lỗi', 'error',
   $q$SELECT e.voucher_id, coalesce(v.voucher_no, '(nháp)'), coalesce(e.error_code, '') || ' ' || coalesce(e.error_message, '')
      FROM einvoice e JOIN voucher v ON v.id = e.voucher_id
      WHERE e.status = 'failed' AND e.discarded_at IS NULL AND (e.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1 AND $2
      ORDER BY e.created_at, e.id$q$,
   'Hóa đơn điện tử phát hành lỗi và chưa được xử lý', 'Phát hành lại hoặc bỏ lần phát hành lỗi', true, '{}'),
  (p_tenant, 'HDDT_CHO_MA_CQT', 'Hóa đơn có mã chờ mã cơ quan thuế quá 1 ngày', 'warning',
   $q$SELECT e.voucher_id, coalesce(v.voucher_no, '(nháp)'), 'Số ' || coalesce(e.invoice_no, '') || ', phát hành ' || to_char(e.issued_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI')
      FROM einvoice e JOIN voucher v ON v.id = e.voucher_id JOIN einvoice_series s ON s.tenant_id = e.tenant_id AND s.id = e.series_id
      WHERE e.status = 'issued' AND e.cqt_status = 'waiting' AND s.serial LIKE 'C%'
        AND coalesce(e.issued_at, e.created_at) < now() - interval '1 day'
        AND (coalesce(e.issued_at, e.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1 AND $2
      ORDER BY e.issued_at, e.id$q$,
   'Hóa đơn có mã của cơ quan thuế chưa nhận được mã quá 1 ngày', 'Đối soát lại trạng thái cấp mã với nhà cung cấp', true, '{}'),
  (p_tenant, 'HDDT_CAN_DAO_GOC', 'Hóa đơn cần đảo chứng từ gốc', 'error',
   $q$SELECT e.voucher_id, coalesce(v.voucher_no, '(nháp)'), 'Hóa đơn ' || coalesce(e.invoice_no, '(chưa có số)')
      FROM einvoice e JOIN voucher v ON v.id = e.voucher_id
      WHERE e.needs_reversal AND coalesce(e.issue_date, (e.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) BETWEEN $1 AND $2
      ORDER BY e.created_at, e.id$q$,
   'Hóa đơn đã hủy hoặc thay thế nhưng chứng từ gốc chưa được đảo', 'Đảo chứng từ gốc hoặc lập chứng từ điều chỉnh', true, '{}'),
  (p_tenant, 'HDDV_CHUA_LAP_CT', 'Hóa đơn đầu vào chưa lập chứng từ quá 7 ngày', 'warning',
   $q$SELECT NULL::uuid, i.invoice_no, i.seller_name || ', ngày ' || to_char(i.issue_date, 'DD/MM/YYYY')
      FROM inbound_invoice i
      WHERE i.status = 'new' AND i.issue_date BETWEEN $1 AND $2 AND (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - i.issue_date > 7
      ORDER BY i.issue_date, i.id$q$,
   'Hóa đơn đầu vào đã nhận nhưng chưa lập chứng từ quá 7 ngày', 'Lập chứng từ từ hóa đơn đầu vào hoặc bỏ qua nếu không dùng', true, '{}'),
  (p_tenant, 'HDDV_CHU_KY', 'Hóa đơn đầu vào có chữ ký người bán không hợp lệ đã lập chứng từ', 'error',
   $q$SELECT i.voucher_id, i.invoice_no, i.seller_name || ': ' || coalesce(i.seller_sig->>'reason', 'chữ ký không hợp lệ')
      FROM inbound_invoice i
      WHERE i.voucher_id IS NOT NULL AND i.seller_sig->>'valid' = 'false' AND i.issue_date BETWEEN $1 AND $2
      ORDER BY i.issue_date, i.id$q$,
   'Đã lập chứng từ từ hóa đơn mà chữ ký số của người bán không hợp lệ', 'Kiểm tra lại hóa đơn với người bán; cân nhắc hủy chứng từ', true, '{}'),
  (p_tenant, 'NH_CHUA_DOI_CHIEU', 'Giao dịch ngân hàng chưa đối chiếu quá 3 ngày', 'warning',
   $q$SELECT t.voucher_id, to_char(t.value_date, 'DD/MM/YYYY') || ' ' || b.account_no, CASE WHEN t.amount_in > 0 THEN 'Thu ' || trim_scale(t.amount_in) ELSE 'Chi ' || trim_scale(t.amount_out) END || coalesce(' - ' || t.description, '')
      FROM bank_transaction t JOIN bank_account b ON b.tenant_id = t.tenant_id AND b.id = t.bank_account_id
      WHERE t.status = 'new' AND t.value_date BETWEEN $1 AND $2 AND (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - t.value_date > 3
      ORDER BY t.value_date, t.id$q$,
   'Giao dịch ngân hàng chưa được đối chiếu với chứng từ quá 3 ngày', 'Đối chiếu hoặc bỏ qua giao dịch (Đối chiếu ngân hàng)', true, '{}'),
  -- Số tiền phía ngân hàng của chứng từ so với giao dịch: cùng phép so với fn_bank_txn_voucher_state (0088).
  (p_tenant, 'NH_LECH_SO_TIEN', 'Chứng từ gắn giao dịch ngân hàng lệch số tiền', 'error',
   $q$SELECT t.voucher_id, coalesce(v.voucher_no, '(nháp)'), 'Giao dịch ' || trim_scale(CASE WHEN t.amount_in > 0 THEN t.amount_in ELSE t.amount_out END) || ', chứng từ ' || trim_scale(s.amt)
      FROM bank_transaction t JOIN bank_account b ON b.tenant_id = t.tenant_id AND b.id = t.bank_account_id
      JOIN voucher v ON v.id = t.voucher_id AND v.state <> 'cancelled'
      CROSS JOIN LATERAL (SELECT coalesce(sum(CASE WHEN b.currency_code = 'VND' THEN CASE WHEN t.amount_in > 0 THEN l.debit ELSE l.credit END ELSE abs(l.amount_currency) END), 0) AS amt
        FROM voucher_line l WHERE l.voucher_id = v.id AND l.bank_account_id = t.bank_account_id AND CASE WHEN t.amount_in > 0 THEN l.debit > 0 ELSE l.credit > 0 END) s
      WHERE t.value_date BETWEEN $1 AND $2 AND s.amt <> CASE WHEN t.amount_in > 0 THEN t.amount_in ELSE t.amount_out END
      ORDER BY t.value_date, t.id$q$,
   'Chứng từ đã gắn giao dịch ngân hàng nhưng tổng tiền phía tài khoản ngân hàng khác số giao dịch', 'Sửa chứng từ cho khớp giao dịch hoặc gỡ liên kết rồi đối chiếu lại', true, '{}')
  $new$;
  d := replace(d, E'\n  ON CONFLICT DO NOTHING', n || E'\n  ON CONFLICT DO NOTHING');
  IF position('NH_LECH_SO_TIEN' IN d) = 0 THEN RAISE EXCEPTION 'không chèn được quy tắc GĐ5 (khuôn ON CONFLICT khác dự kiến)'; END IF;
  EXECUTE d;
END $mig$;

ALTER TABLE data_check_rule DISABLE TRIGGER trg_audit;
SELECT seed_data_check_rules(id) FROM tenant;
ALTER TABLE data_check_rule ENABLE TRIGGER trg_audit;
