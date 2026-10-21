-- GĐ2 Task 13: đánh giá lại số dư ngoại tệ cuối kỳ (chứng từ DG, source_doc_type = 'fx_revaluation').
-- Thân fn_open_items_create, unpost_voucher, fn_open_items_settle_reversal lấy từ định nghĩa hiện hành (pg_get_functiondef) sau 0029, chỉ thêm các đoạn ghi chú "đánh giá lại"
-- (mục 1, 2, 4); fn_open_items_close_reval_children (mục 3) là hàm mới.
-- Hàm vẫn chạy quyền người gọi.

-- 1) Dòng DG trên tài khoản công nợ là khoản con (điều chỉnh đánh giá lại) của khoản gốc ghi ở voucher_line.extra_dims->>'reval_of'. Bản đảo của DG chép source_doc_type và extra_dims
-- nên khoản của nó cũng là khoản con của cùng khoản gốc (đối trừ kiểu 'reversal' với khoản con của DG). Khóa ngoại (tenant_id, parent_id) bảo đảm khoản gốc có thật trong cùng công ty.
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

-- 2) Bỏ ghi sổ chứng từ có khoản đã đánh giá lại: chặn, hướng dẫn đảo chứng từ.
CREATE OR REPLACE FUNCTION public.unpost_voucher(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; p fiscal_period; v_by text; v_dg text;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.source_doc_type = 'closing_step' THEN RAISE EXCEPTION 'VOUCHER_SYSTEM_GENERATED: Chứng từ do hệ thống sinh (kết chuyển/phân bổ); dùng Chạy lại (đảo cũ) ở màn hình Kết chuyển' USING ERRCODE = 'P0001'; END IF;
  IF v.source_doc_type IN ('settlement_fx', 'fx_revaluation', 'fx_outflow', 'vat_offset', 'amortization') THEN
    RAISE EXCEPTION 'VOUCHER_SYSTEM_GENERATED: Chứng từ do hệ thống sinh (chênh lệch tỷ giá, đánh giá lại, tỷ giá xuất quỹ, khấu trừ thuế GTGT, phân bổ); thao tác ở chức năng đã sinh ra chứng từ' USING ERRCODE = 'P0001'; END IF;
  IF v.source_doc_type = 'opening_balance' AND current_setting('app.opening_repost', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'VOUCHER_SYSTEM_GENERATED: Chứng từ số dư đầu kỳ chỉ sửa ở màn hình Số dư đầu kỳ' USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'posted' THEN RAISE EXCEPTION 'STATE_INVALID: chỉ bỏ ghi sổ được chứng từ đang ghi sổ (hiện tại: %)', v.state USING ERRCODE = 'P0001'; END IF;
  IF v.reversal_of_id IS NOT NULL THEN RAISE EXCEPTION 'STATE_INVALID: chứng từ đảo không bỏ ghi sổ được; hãy đảo lại chứng từ này' USING ERRCODE = 'P0001'; END IF;
  IF v.row_hash IS NOT NULL THEN RAISE EXCEPTION 'VOUCHER_HASHED: chứng từ đã nằm trong chuỗi khóa cứng' USING ERRCODE = 'P0001'; END IF;
  p := fn_period_of(v.tenant_id, v.posting_date, v.voucher_type = 'DK');
  IF p.status = 'hard_locked' THEN RAISE EXCEPTION 'UNPOST_PERIOD_NOT_OPEN: kỳ đã khóa cứng; lập bút toán điều chỉnh ở kỳ đang mở' USING ERRCODE = 'P0001'; END IF;
  IF p.status <> 'open' THEN RAISE EXCEPTION 'UNPOST_PERIOD_NOT_OPEN: kỳ %/% đã khóa, hãy lập chứng từ đảo', p.period_no, p.fiscal_year USING ERRCODE = 'P0001'; END IF;
  -- công nợ: khoản của chứng từ đã đối trừ thì phải hủy đối trừ trước (khóa ngoại của settlement cũng chặn xóa khoản khi có đối trừ chen vào đồng thời)
  IF EXISTS (SELECT 1 FROM open_item o JOIN settlement s ON s.tenant_id = o.tenant_id AND (s.debit_item_id = o.id OR s.credit_item_id = o.id) WHERE o.voucher_id = p_id) THEN
    RAISE EXCEPTION 'OPEN_ITEM_SETTLED: chứng từ đã đối trừ công nợ, hãy hủy đối trừ trước' USING ERRCODE = 'P0001'; END IF;
  -- đánh giá lại (sau kiểm đối trừ: đảo cũng cần hủy đối trừ trước): khoản đã có khoản con (điều chỉnh đánh giá lại, kể cả của DG đã đảo) không xóa được;
  -- đảo chứng từ thì đóng cả nhóm (fn_open_items_settle_reversal)
  SELECT coalesce(dv.voucher_no, dv.voucher_type) || ' ngày ' || to_char(dv.posting_date, 'DD/MM/YYYY') INTO v_dg
    FROM open_item o JOIN open_item c ON c.tenant_id = o.tenant_id AND c.parent_id = o.id JOIN voucher dv ON dv.id = c.voucher_id
    WHERE o.voucher_id = p_id ORDER BY dv.reversal_of_id IS NOT NULL, dv.posting_date, dv.voucher_no LIMIT 1;
  IF v_dg IS NOT NULL THEN
    RAISE EXCEPTION 'OPEN_ITEM_REVALUED: Khoản công nợ đã đánh giá lại tỷ giá ở chứng từ %: không bỏ ghi sổ được, hãy dùng Đảo chứng từ', v_dg USING ERRCODE = 'P0001'; END IF;
  -- đối trừ: khoản đang được chứng từ nháp chọn để đối trừ khi ghi sổ
  SELECT coalesce(d.voucher_no, d.voucher_type || ' ngày ' || to_char(d.posting_date, 'DD/MM/YYYY')) INTO v_by
    FROM open_item o JOIN settlement_plan sp ON sp.tenant_id = o.tenant_id AND sp.open_item_id = o.id JOIN voucher d ON d.id = sp.voucher_id
    WHERE o.voucher_id = p_id ORDER BY d.posting_date, d.id LIMIT 1;
  IF v_by IS NOT NULL THEN
    RAISE EXCEPTION 'OPEN_ITEM_PLANNED: khoản công nợ của chứng từ đang được chọn đối trừ ở chứng từ nháp %, hãy bỏ chọn ở chứng từ đó trước', v_by USING ERRCODE = 'P0001'; END IF;
  INSERT INTO voucher_line_history(tenant_id, voucher_id, version, header, lines, archived_by)
    SELECT v.tenant_id, p_id, v.version, to_jsonb(v), coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.line_no), '[]'), app_user_id() FROM voucher_line l WHERE l.voucher_id = p_id;
  PERFORM set_config('app.state_change', 'on', true); PERFORM set_config('app.unposting', 'on', true);
  UPDATE voucher SET state = 'draft', posted_by = NULL, posted_at = NULL WHERE id = p_id;
  DELETE FROM voucher_pair WHERE voucher_id = p_id;
  DELETE FROM open_item WHERE voucher_id = p_id; -- công nợ
  PERFORM set_config('app.state_change', 'off', true); PERFORM set_config('app.unposting', 'off', true);
  PERFORM mark_balance_stale(v.tenant_id, p.fiscal_year, p.period_no);
  PERFORM fn_audit_voucher(v.tenant_id, 'unpost', p_id, jsonb_build_object('voucher_no', v.voucher_no));
END $function$;

-- 3) Đóng các khoản con còn dư của một khoản gốc đã đóng bằng đảo (nhóm p_group của lần đảo, ngày đảo p_date): khoản con đối trừ với nhau, phần dư thuần thành
-- chứng từ CL như CL đối trừ (dư Nợ thì Nợ TK lỗ / Có TK công nợ, dư Có thì Nợ TK công nợ / Có TK lãi; dòng công nợ mang loại tiền của khoản, nguyên tệ 0),
-- ngày greatest(ngày đảo, ngày ghi sổ của khoản con) vì không đối trừ trước ngày ghi sổ của khoản. Mọi dòng kiểu 'reversal' (dòng có khoản CL kèm fx_voucher_id):
-- là đối trừ do đảo sinh ra nên không hủy được, không chặn đảo DG chứa khoản con, không tính là "khoản con đã đối trừ" khi chạy lại đánh giá lại.
-- Gọi khi đảo chứng từ gốc và khi chạy lại đánh giá lại sinh khoản con mới (hoặc bản đảo của khoản con cũ) cho khoản gốc đã đảo. Trả chứng từ CL (NULL nếu không cần).
CREATE OR REPLACE FUNCTION fn_open_items_close_reval_children(p_root bigint, p_group uuid, p_date date) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE rt open_item; ch record; p fiscal_period; v_rules jsonb; v_acc bigint; v_r numeric := 0; v_date date := p_date; v_user uuid; v_cl uuid; v_cl_item bigint; v_m numeric;
  i int := 1; j int := 1; pos_id bigint[] := '{}'; pos_amt numeric[] := '{}'; neg_id bigint[] := '{}'; neg_amt numeric[] := '{}';
BEGIN
  SELECT * INTO rt FROM open_item WHERE id = p_root;
  IF NOT FOUND THEN RAISE EXCEPTION 'OPEN_ITEM_NOT_FOUND: không có khoản công nợ %', p_root USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM open_item WHERE tenant_id = rt.tenant_id AND parent_id = rt.id ORDER BY id FOR UPDATE;
  FOR ch IN SELECT c.id, c.line_posting_date, x.vnd FROM open_item c CROSS JOIN LATERAL fn_open_item_residual(c.id) x
            WHERE c.tenant_id = rt.tenant_id AND c.parent_id = rt.id AND x.vnd <> 0 ORDER BY c.id LOOP
    v_r := v_r + ch.vnd; v_date := greatest(v_date, ch.line_posting_date);
    IF ch.vnd > 0 THEN pos_id := pos_id || ch.id; pos_amt := pos_amt || ch.vnd; ELSE neg_id := neg_id || ch.id; neg_amt := neg_amt || -ch.vnd; END IF;
  END LOOP;
  IF cardinality(pos_id) + cardinality(neg_id) = 0 THEN RETURN NULL; END IF;
  v_user := coalesce(app_user_id(), (SELECT created_by FROM voucher WHERE id = rt.voucher_id));
  IF v_r <> 0 THEN
    p := fn_period_of(rt.tenant_id, v_date, false);
    SELECT rules INTO v_rules FROM fx_rule WHERE regime = p.regime;
    IF NOT FOUND THEN RAISE EXCEPTION 'FX_RULES_MISSING: Chưa khai báo tài khoản lãi, lỗ chênh lệch tỷ giá cho chế độ kế toán %', p.regime USING ERRCODE = 'P0001'; END IF;
    SELECT id INTO v_acc FROM account WHERE tenant_id = rt.tenant_id AND regime = p.regime AND code = v_rules->>(CASE WHEN v_r > 0 THEN 'lossAccount' ELSE 'gainAccount' END);
    IF NOT FOUND THEN RAISE EXCEPTION 'LOOKUP_NOT_FOUND: Không có tài khoản mã "%"', v_rules->>(CASE WHEN v_r > 0 THEN 'lossAccount' ELSE 'gainAccount' END) USING ERRCODE = 'P0001'; END IF;
    v_cl := gen_random_uuid();
    INSERT INTO voucher(id, tenant_id, voucher_type, posting_date, document_date, description, party_id, currency_code, source_doc_type, source_doc_id, created_by)
      VALUES (v_cl, rt.tenant_id, 'CL', v_date, v_date, 'Chênh lệch tỷ giá đánh giá lại khi đảo chứng từ ' || coalesce(rt.doc_no, ''), rt.party_id, 'VND', 'settlement_fx', p_group, v_user);
    INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, currency_code, amount_currency, debit, credit, party_id, description)
    SELECT rt.tenant_id, v_cl, x.no, x.acc, v_date, x.cur, 0, x.dr, x.cr, x.party, 'Chênh lệch tỷ giá đánh giá lại khi đảo chứng từ'
    FROM (VALUES (1, CASE WHEN v_r > 0 THEN v_acc ELSE rt.account_id END, CASE WHEN v_r > 0 THEN 'VND' ELSE rt.currency_code END, abs(v_r), 0::numeric, CASE WHEN v_r < 0 THEN rt.party_id END),
                 (2, CASE WHEN v_r > 0 THEN rt.account_id ELSE v_acc END, CASE WHEN v_r > 0 THEN rt.currency_code ELSE 'VND' END, 0::numeric, abs(v_r), CASE WHEN v_r > 0 THEN rt.party_id END))
         AS x(no, acc, cur, dr, cr, party);
    PERFORM post_voucher(v_cl);
    SELECT id INTO v_cl_item FROM open_item WHERE voucher_id = v_cl;
    IF v_r > 0 THEN neg_id := neg_id || v_cl_item; neg_amt := neg_amt || v_r; ELSE pos_id := pos_id || v_cl_item; pos_amt := pos_amt || -v_r; END IF;
  END IF;
  WHILE i <= cardinality(pos_id) AND j <= cardinality(neg_id) LOOP
    v_m := least(pos_amt[i], neg_amt[j]);
    INSERT INTO settlement(tenant_id, debit_item_id, credit_item_id, amount, amount_currency, settle_date, kind, fx_voucher_id, group_id, created_by)
      VALUES (rt.tenant_id, pos_id[i], neg_id[j], v_m, 0, v_date, 'reversal', v_cl, p_group, v_user);
    pos_amt[i] := pos_amt[i] - v_m; neg_amt[j] := neg_amt[j] - v_m;
    IF pos_amt[i] = 0 THEN i := i + 1; END IF;
    IF neg_amt[j] = 0 THEN j := j + 1; END IF;
  END LOOP;
  RETURN v_cl;
END $$;

-- 4) Đảo chứng từ có khoản gốc đã đánh giá lại: đóng cả nhóm, phần dư khoản con thành chứng từ CL ngày đảo.
CREATE OR REPLACE FUNCTION public.fn_open_items_settle_reversal(p_orig uuid, p_rev uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE r voucher; n int; g uuid := gen_random_uuid(); -- một lần đảo là một nhóm đối trừ
BEGIN
  SELECT * INTO r FROM voucher WHERE id = p_rev;
  INSERT INTO settlement(tenant_id, debit_item_id, credit_item_id, amount, amount_currency, settle_date, kind, group_id, created_by)
  SELECT o.tenant_id, CASE WHEN o.amount > 0 OR (o.amount = 0 AND o.amount_currency > 0) THEN o.id ELSE x.id END,
         CASE WHEN o.amount > 0 OR (o.amount = 0 AND o.amount_currency > 0) THEN x.id ELSE o.id END,
         abs(o.amount), abs(o.amount_currency), r.posting_date, 'reversal', g, coalesce(app_user_id(), r.created_by)
  FROM open_item o JOIN open_item x ON x.voucher_id = p_rev AND x.line_no = o.line_no
  WHERE o.voucher_id = p_orig AND r.reversal_of_id = p_orig -- công nợ: chỉ khi p_rev đúng là chứng từ đảo của p_orig
    AND NOT EXISTS (SELECT 1 FROM settlement s WHERE s.tenant_id = o.tenant_id AND (s.debit_item_id = o.id OR s.credit_item_id = o.id));
  GET DIAGNOSTICS n = ROW_COUNT;
  -- đánh giá lại: khoản gốc vừa đối trừ với khoản đảo còn khoản con dư ≠ 0 thì đóng nốt khoản con, cùng nhóm, ngày đảo
  PERFORM fn_open_items_close_reval_children(oi.id, g, r.posting_date) FROM open_item oi WHERE oi.voucher_id = p_orig
    AND EXISTS (SELECT 1 FROM settlement s WHERE s.tenant_id = oi.tenant_id AND s.group_id = g AND (s.debit_item_id = oi.id OR s.credit_item_id = oi.id)) ORDER BY oi.id;
  RETURN n;
END $function$;
