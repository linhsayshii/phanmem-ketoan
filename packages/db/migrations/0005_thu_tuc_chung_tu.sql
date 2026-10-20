-- 0005_thu_tuc_chung_tu.sql: thủ tục ghi sổ, bỏ ghi sổ, đảo, hủy chứng từ. Chạy với quyền người gọi (app_user, có RLS), không SECURITY DEFINER.
CREATE OR REPLACE FUNCTION fn_format_voucher_no(p_prefix text, p_suffix text, p_pad int, p_seq bigint, p_year int) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(replace(p_prefix, '{YYYY}', p_year::text), '{YY}', right(p_year::text, 2)) || lpad(p_seq::text, p_pad, '0')
      || replace(replace(p_suffix, '{YYYY}', p_year::text), '{YY}', right(p_year::text, 2));
$$;

CREATE OR REPLACE FUNCTION fn_audit_voucher(p_tenant uuid, p_action text, p_id uuid, p_after jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, after, ip)
  VALUES (p_tenant, app_user_id(), p_action, 'voucher', p_id::text, p_after, nullif(current_setting('app.client_ip', true), ''));
$$;

CREATE OR REPLACE FUNCTION post_voucher(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher; vt voucher_type; p fiscal_period; v_seq bigint; v_no text; v_n int;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'draft' THEN RAISE EXCEPTION 'STATE_INVALID: chứng từ đang ở trạng thái %, không ghi sổ được', v.state USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_n FROM voucher_line WHERE voucher_id = p_id;
  IF v_n = 0 THEN RAISE EXCEPTION 'VOUCHER_EMPTY: chứng từ không có dòng' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO vt FROM voucher_type WHERE tenant_id = v.tenant_id AND code = v.voucher_type;
  p := fn_period_of(v.tenant_id, v.posting_date, v.voucher_type = 'DK');
  PERFORM fn_assert_period_writable(p, vt.module);
  IF v.voucher_no IS NULL THEN
    INSERT INTO voucher_counter(tenant_id, voucher_type, fiscal_year, last_no) VALUES (v.tenant_id, v.voucher_type, p.fiscal_year, 1)
      ON CONFLICT (tenant_id, voucher_type, fiscal_year) DO UPDATE SET last_no = voucher_counter.last_no + 1 RETURNING last_no INTO v_seq;
    v_no := fn_format_voucher_no(vt.prefix, vt.suffix, vt.pad_length, v_seq, p.fiscal_year);
  END IF;
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'posted', voucher_no = coalesce(voucher_no, v_no), seq_no = coalesce(seq_no, v_seq), posted_by = app_user_id(), posted_at = now() WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_build_pairs(p_id);
  PERFORM mark_balance_stale(v.tenant_id, p.fiscal_year, p.period_no);
  PERFORM fn_audit_voucher(v.tenant_id, 'post', p_id, jsonb_build_object('voucher_no', coalesce(v.voucher_no, v_no), 'posting_date', v.posting_date));
END $$;

CREATE OR REPLACE FUNCTION unpost_voucher(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher; p fiscal_period;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'posted' THEN RAISE EXCEPTION 'STATE_INVALID: chỉ bỏ ghi sổ được chứng từ đang ghi sổ (hiện tại: %)', v.state USING ERRCODE = 'P0001'; END IF;
  IF v.reversal_of_id IS NOT NULL THEN RAISE EXCEPTION 'STATE_INVALID: chứng từ đảo không bỏ ghi sổ được; hãy đảo lại chứng từ này' USING ERRCODE = 'P0001'; END IF;
  IF v.row_hash IS NOT NULL THEN RAISE EXCEPTION 'VOUCHER_HASHED: chứng từ đã nằm trong chuỗi khóa cứng' USING ERRCODE = 'P0001'; END IF;
  p := fn_period_of(v.tenant_id, v.posting_date, v.voucher_type = 'DK');
  IF p.status <> 'open' THEN RAISE EXCEPTION 'UNPOST_PERIOD_NOT_OPEN: kỳ %/% đã khóa, hãy lập chứng từ đảo', p.period_no, p.fiscal_year USING ERRCODE = 'P0001'; END IF;
  INSERT INTO voucher_line_history(tenant_id, voucher_id, version, header, lines, archived_by)
    SELECT v.tenant_id, p_id, v.version, to_jsonb(v), coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.line_no), '[]'), app_user_id() FROM voucher_line l WHERE l.voucher_id = p_id;
  PERFORM set_config('app.state_change', 'on', true); PERFORM set_config('app.unposting', 'on', true);
  UPDATE voucher SET state = 'draft', posted_by = NULL, posted_at = NULL WHERE id = p_id;
  DELETE FROM voucher_pair WHERE voucher_id = p_id;
  PERFORM set_config('app.state_change', 'off', true); PERFORM set_config('app.unposting', 'off', true);
  PERFORM mark_balance_stale(v.tenant_id, p.fiscal_year, p.period_no);
  PERFORM fn_audit_voucher(v.tenant_id, 'unpost', p_id, jsonb_build_object('voucher_no', v.voucher_no));
END $$;

CREATE OR REPLACE FUNCTION reverse_voucher(p_id uuid, p_date date, p_description text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v voucher; v_new uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'posted' THEN RAISE EXCEPTION 'STATE_INVALID: chỉ đảo được chứng từ đang ghi sổ (hiện tại: %)', v.state USING ERRCODE = 'P0001'; END IF;
  IF p_date < v.posting_date THEN RAISE EXCEPTION 'REVERSE_DATE_BEFORE_ORIGINAL: ngày đảo % trước ngày chứng từ gốc %', p_date, v.posting_date USING ERRCODE = 'P0001'; END IF;
  INSERT INTO voucher(id, tenant_id, voucher_type, posting_date, document_date, description, party_id, currency_code, fx_rate, source_doc_type, source_doc_id, reversal_of_id, is_closing, created_by)
  VALUES (v_new, v.tenant_id, v.voucher_type, p_date, p_date, coalesce(p_description, 'Đảo chứng từ ' || v.voucher_no || ' ngày ' || to_char(v.posting_date, 'DD/MM/YYYY')),
          v.party_id, v.currency_code, v.fx_rate, v.source_doc_type, v.source_doc_id, p_id, v.is_closing, app_user_id());
  INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, currency_code, fx_rate, amount_currency, debit, credit,
                           party_id, item_id, warehouse_id, department_id, project_id, cost_item_id, contract_id, employee_id, asset_id, extra_dims, description, due_date)
  SELECT tenant_id, v_new, line_no, account_id, p_date, currency_code, fx_rate, -amount_currency, credit, debit,
         party_id, item_id, warehouse_id, department_id, project_id, cost_item_id, contract_id, employee_id, asset_id, extra_dims, description, due_date
  FROM voucher_line WHERE voucher_id = p_id ORDER BY line_no;
  PERFORM post_voucher(v_new);
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'reversed', reversed_by_id = v_new WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_audit_voucher(v.tenant_id, 'reverse', p_id, jsonb_build_object('reversed_by', v_new, 'date', p_date));
  RETURN v_new;
END $$;

CREATE OR REPLACE FUNCTION discard_voucher(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'draft' THEN RAISE EXCEPTION 'STATE_INVALID: chỉ hủy được chứng từ nháp (hiện tại: %)', v.state USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'cancelled' WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_audit_voucher(v.tenant_id, 'discard', p_id, jsonb_build_object('voucher_no', v.voucher_no));
END $$;

-- Sửa diễn giải chứng từ đã ghi sổ (cho phép tại chỗ theo mục 7.1) phải để lại dấu vết; dòng chứng từ đã có trigger audit riêng (fn_line_immutable).
CREATE OR REPLACE FUNCTION fn_voucher_description_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, after, ip)
    VALUES (NEW.tenant_id, app_user_id(), 'update', 'voucher', NEW.id::text, jsonb_build_object('description', OLD.description), jsonb_build_object('description', NEW.description),
            nullif(current_setting('app.client_ip', true), ''));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_voucher_description_audit ON voucher;
CREATE TRIGGER trg_voucher_description_audit AFTER UPDATE OF description ON voucher FOR EACH ROW
  WHEN (OLD.state <> 'draft' AND NEW.description IS DISTINCT FROM OLD.description) EXECUTE FUNCTION fn_voucher_description_audit();
