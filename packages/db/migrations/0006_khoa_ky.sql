-- 0006_khoa_ky.sql: khóa kỳ ba mức, khóa theo phần hành, chuỗi hash khi khóa cứng và hàm kiểm tra hash. Chạy với quyền người gọi (app_user, có RLS), không SECURITY DEFINER.
ALTER TABLE fiscal_period ADD COLUMN IF NOT EXISTS hash_tail bytea, ADD COLUMN IF NOT EXISTS locked_by uuid, ADD COLUMN IF NOT EXISTS locked_at timestamptz;

-- Chuỗi chuẩn hóa của một chứng từ để băm. Mọi giá trị phải cố định theo dữ liệu, không theo phiên: ngày (date) và số (numeric) trong jsonb luôn ở dạng ISO/thập phân,
-- còn timestamptz sẽ bị jsonb in theo TimeZone của phiên nên posted_at được in cố định theo UTC.
-- ĐỊNH DẠNG NÀY ĐÓNG BĂNG khi có kỳ đầu tiên bị khóa cứng: thêm/bớt/đổi tên khóa làm hash đã lưu không còn khớp (phải bỏ khóa cứng rồi khóa lại).
CREATE OR REPLACE FUNCTION fn_voucher_canonical(p_id uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT (jsonb_build_object(
    'id', v.id, 'type', v.voucher_type, 'no', v.voucher_no, 'seq', v.seq_no, 'posting_date', v.posting_date, 'document_date', v.document_date,
    'state', v.state, 'description', v.description, 'party_id', v.party_id, 'currency', v.currency_code, 'fx_rate', v.fx_rate,
    'reversal_of', v.reversal_of_id, 'is_closing', v.is_closing, 'posted_at', to_char(v.posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'reversed_by_id', v.reversed_by_id, 'created_by', v.created_by, 'posted_by', v.posted_by, 'source_doc_type', v.source_doc_type, 'source_doc_id', v.source_doc_id,
    'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('n', l.line_no, 'acc', a.code, 'd', l.debit, 'c', l.credit, 'ac', l.amount_currency, 'cur', l.currency_code, 'fx_rate', l.fx_rate,
        'party', l.party_id, 'dept', l.department_id, 'proj', l.project_id, 'ci', l.cost_item_id, 'emp', l.employee_id, 'desc', l.description, 'due', l.due_date,
        'item_id', l.item_id, 'warehouse_id', l.warehouse_id, 'contract_id', l.contract_id, 'asset_id', l.asset_id, 'extra_dims', l.extra_dims) ORDER BY l.line_no)
      -- posting_date của dòng luôn bằng của chứng từ (fn_line_before): chỉ quét partition của tháng chứng từ.
      FROM voucher_line l JOIN account a ON a.id = l.account_id WHERE l.voucher_id = v.id AND l.posting_date = v.posting_date), '[]'::jsonb)))::text
  FROM voucher v WHERE v.id = p_id;
$$;

-- Định nghĩa lại fn_voucher_before (0004) với một thay đổi duy nhất: đọc lại hàng kỳ bằng FOR SHARE ngay sau fn_period_of.
-- lock_period giữ FOR UPDATE trên hàng kỳ; nhờ đó một lần ghi sổ/sửa chứng từ đang chạy song song hoặc làm lock_period đợi tới khi commit (hash tính cả chứng từ đó),
-- hoặc đợi lock_period commit rồi thấy kỳ đã khóa cứng. Không có khóa này, chứng từ có thể commit sau khi hash đã tính xong.
CREATE OR REPLACE FUNCTION fn_voucher_before() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p fiscal_period; vt voucher_type; v_in_proc boolean := current_setting('app.state_change', true) IS NOT DISTINCT FROM 'on';
        v_renum boolean := current_setting('app.renumbering', true) IS NOT DISTINCT FROM 'on'; v_lock boolean := current_setting('app.locking', true) IS NOT DISTINCT FROM 'on';
BEGIN
  SELECT * INTO vt FROM voucher_type WHERE tenant_id = NEW.tenant_id AND code = NEW.voucher_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_TYPE_NOT_FOUND: loại chứng từ %', NEW.voucher_type USING ERRCODE = 'P0001'; END IF;
  p := fn_period_of(NEW.tenant_id, NEW.posting_date, NEW.voucher_type = 'DK');
  SELECT * INTO p FROM fiscal_period WHERE fiscal_period.id = p.id FOR SHARE;
  NEW.fiscal_year := p.fiscal_year; NEW.period_no := p.period_no;
  IF TG_OP = 'INSERT' THEN
    PERFORM fn_assert_period_writable(p, vt.module);
    NEW.state := 'draft'; NEW.version := 1;
    RETURN NEW;
  END IF;
  NEW.version := OLD.version + 1;
  IF NEW.state <> OLD.state AND NOT v_in_proc THEN RAISE EXCEPTION 'STATE_CHANGE_VIA_PROC: đổi trạng thái chỉ qua post/unpost/reverse/discard' USING ERRCODE = 'P0001'; END IF;
  IF NEW.posting_date <> OLD.posting_date OR (OLD.state = 'draft' AND NEW.state = 'posted') OR (OLD.state = 'posted' AND NEW.state = 'draft') THEN
    PERFORM fn_assert_period_writable(p, vt.module);
    IF NEW.posting_date <> OLD.posting_date THEN PERFORM fn_assert_period_writable(fn_period_of(OLD.tenant_id, OLD.posting_date, OLD.voucher_type = 'DK'), vt.module); END IF;
  ELSIF p.status = 'hard_locked' AND NOT v_lock THEN
    RAISE EXCEPTION 'PERIOD_HARD_LOCKED: kỳ %/% đã khóa cứng', p.period_no, p.fiscal_year USING ERRCODE = 'P0001';
  END IF;
  IF OLD.state IN ('posted','reversed','cancelled') AND NOT v_in_proc AND NOT v_renum AND NOT v_lock THEN
    IF (to_jsonb(NEW) - 'description' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'description' - 'version') THEN
      RAISE EXCEPTION 'VOUCHER_IMMUTABLE: chứng từ đã ghi sổ chỉ sửa được diễn giải; dùng Bỏ ghi sổ hoặc Đảo' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Định nghĩa lại fn_line_immutable (0004) với một thay đổi duy nhất: dòng của chứng từ đã ghi sổ đọc hàng kỳ bằng FOR SHARE (thay cho JOIN thường) trước khi kiểm tra khóa cứng,
-- để sửa diễn giải/chiều phân tích của dòng cũng đua đúng với lock_period như fn_voucher_before.
CREATE OR REPLACE FUNCTION fn_line_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v voucher; v_status text;
BEGIN
  IF current_setting('app.unposting', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT * INTO v FROM voucher WHERE id = OLD.voucher_id;
  IF v.state IN ('posted','reversed','cancelled') THEN
    SELECT p.status INTO v_status FROM fiscal_period p WHERE p.tenant_id = v.tenant_id AND p.fiscal_year = v.fiscal_year AND p.period_no = v.period_no FOR SHARE;
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'LINE_IMMUTABLE: không xóa dòng của chứng từ đã ghi sổ' USING ERRCODE = 'P0001'; END IF;
    IF v_status = 'hard_locked' THEN RAISE EXCEPTION 'PERIOD_HARD_LOCKED: kỳ đã khóa cứng' USING ERRCODE = 'P0001'; END IF;
    -- 'balance' là cột sinh (debit - credit): trong trigger BEFORE, NEW.balance còn NULL nên bỏ ra khi so sánh (debit/credit đã được so sánh) và tính lại khi ghi nhật ký.
    IF (to_jsonb(NEW) - 'balance' - 'description' - 'due_date' - 'department_id' - 'project_id' - 'cost_item_id' - 'employee_id' - 'extra_dims')
       IS DISTINCT FROM (to_jsonb(OLD) - 'balance' - 'description' - 'due_date' - 'department_id' - 'project_id' - 'cost_item_id' - 'employee_id' - 'extra_dims') THEN
      RAISE EXCEPTION 'LINE_IMMUTABLE: dòng đã ghi sổ chỉ sửa được diễn giải và chiều phân tích; dùng Bỏ ghi sổ hoặc Đảo' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, after, ip)
      VALUES (OLD.tenant_id, app_user_id(), 'update', 'voucher_line', OLD.id::text, to_jsonb(OLD), to_jsonb(NEW) || jsonb_build_object('balance', NEW.debit - NEW.credit), nullif(current_setting('app.client_ip', true), ''));
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION fn_period_audit(p_tenant uuid, p_action text, p_year int, p_period int, p_extra jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, after, ip)
  VALUES (p_tenant, app_user_id(), p_action, 'fiscal_period', p_year || '/' || p_period, p_extra, nullif(current_setting('app.client_ip', true), ''));
$$;

CREATE OR REPLACE FUNCTION lock_period(p_tenant uuid, p_year int, p_period int, p_level text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p fiscal_period; prev bytea; h bytea; r record; n_draft int;
BEGIN
  -- Khóa/bỏ khóa cứng các kỳ của một công ty đi tuần tự: kiểm tra thứ tự kỳ (kỳ trước đã khóa cứng, không có kỳ sau khóa cứng) và chuỗi hash phụ thuộc trạng thái kỳ khác.
  PERFORM pg_advisory_xact_lock(hashtextextended('fiscal_period_chain:' || p_tenant::text, 0));
  SELECT * INTO p FROM fiscal_period WHERE tenant_id = p_tenant AND fiscal_year = p_year AND period_no = p_period FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERIOD_NOT_FOUND: kỳ %/%', p_period, p_year USING ERRCODE = 'P0001'; END IF;
  IF p_level = 'soft' THEN
    IF p.status <> 'open' THEN RAISE EXCEPTION 'PERIOD_STATE_INVALID: kỳ đang ở trạng thái %', p.status USING ERRCODE = 'P0001'; END IF;
    UPDATE fiscal_period SET status = 'soft_locked', locked_by = app_user_id(), locked_at = now() WHERE id = p.id;
    PERFORM fn_period_audit(p_tenant, 'lock', p_year, p_period, '{"level":"soft"}');
    RETURN;
  END IF;
  IF p_level <> 'hard' THEN RAISE EXCEPTION 'VALIDATION: mức khóa phải là soft hoặc hard' USING ERRCODE = 'P0001'; END IF;
  IF p.status = 'hard_locked' THEN RAISE EXCEPTION 'PERIOD_STATE_INVALID: kỳ đã khóa cứng' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM fiscal_period q WHERE q.tenant_id = p_tenant AND (q.fiscal_year, q.period_no) < (p_year, p_period) AND q.status <> 'hard_locked') THEN
    RAISE EXCEPTION 'PERIOD_PREV_NOT_HARD_LOCKED: phải khóa cứng các kỳ trước theo thứ tự' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO n_draft FROM voucher WHERE tenant_id = p_tenant AND fiscal_year = p_year AND period_no = p_period AND state = 'draft';
  IF n_draft > 0 THEN RAISE EXCEPTION 'PERIOD_HAS_DRAFTS: còn % chứng từ nháp trong kỳ', n_draft USING ERRCODE = 'P0001'; END IF;
  SELECT hash_tail INTO prev FROM fiscal_period q WHERE q.tenant_id = p_tenant AND (q.fiscal_year, q.period_no) < (p_year, p_period) AND q.hash_tail IS NOT NULL
    ORDER BY q.fiscal_year DESC, q.period_no DESC LIMIT 1;
  prev := coalesce(prev, '\x00'::bytea);
  PERFORM set_config('app.locking', 'on', true);
  FOR r IN SELECT id FROM voucher WHERE tenant_id = p_tenant AND fiscal_year = p_year AND period_no = p_period AND state IN ('posted','reversed','cancelled')
           ORDER BY posting_date, voucher_type COLLATE "C", seq_no, id LOOP
    h := digest(prev || convert_to(fn_voucher_canonical(r.id), 'UTF8'), 'sha256');
    UPDATE voucher SET prev_hash = prev, row_hash = h WHERE id = r.id;
    prev := h;
  END LOOP;
  PERFORM set_config('app.locking', 'off', true);
  UPDATE fiscal_period SET status = 'hard_locked', hash_tail = prev, locked_by = app_user_id(), locked_at = now() WHERE id = p.id;
  PERFORM fn_period_audit(p_tenant, 'lock', p_year, p_period, jsonb_build_object('level', 'hard', 'hash_tail', encode(prev, 'hex')));
END $$;

CREATE OR REPLACE FUNCTION unlock_period(p_tenant uuid, p_year int, p_period int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE p fiscal_period; v_new text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fiscal_period_chain:' || p_tenant::text, 0));
  SELECT * INTO p FROM fiscal_period WHERE tenant_id = p_tenant AND fiscal_year = p_year AND period_no = p_period FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERIOD_NOT_FOUND: kỳ %/%', p_period, p_year USING ERRCODE = 'P0001'; END IF;
  IF p.status = 'open' THEN RAISE EXCEPTION 'PERIOD_STATE_INVALID: kỳ đang mở' USING ERRCODE = 'P0001'; END IF;
  IF p.status = 'hard_locked' THEN
    IF current_setting('app.unlock_hard', true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'PERIOD_UNLOCK_HARD_FORBIDDEN: cần quyền bỏ khóa cứng' USING ERRCODE = 'P0001'; END IF;
    IF EXISTS (SELECT 1 FROM fiscal_period q WHERE q.tenant_id = p_tenant AND (q.fiscal_year, q.period_no) > (p_year, p_period) AND q.status = 'hard_locked') THEN
      RAISE EXCEPTION 'PERIOD_LATER_HARD_LOCKED: phải bỏ khóa cứng kỳ sau trước' USING ERRCODE = 'P0001'; END IF;
    PERFORM set_config('app.locking', 'on', true);
    UPDATE voucher SET prev_hash = NULL, row_hash = NULL WHERE tenant_id = p_tenant AND fiscal_year = p_year AND period_no = p_period;
    PERFORM set_config('app.locking', 'off', true);
    v_new := 'soft_locked';
    UPDATE fiscal_period SET status = v_new, hash_tail = NULL WHERE id = p.id;
  ELSE
    v_new := 'open';
    UPDATE fiscal_period SET status = v_new, locked_by = NULL, locked_at = NULL WHERE id = p.id;
  END IF;
  PERFORM fn_period_audit(p_tenant, 'unlock', p_year, p_period, jsonb_build_object('from', p.status, 'to', v_new));
  RETURN v_new;
END $$;

CREATE OR REPLACE FUNCTION set_period_modules(p_tenant uuid, p_year int, p_period int, p_modules text[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE fiscal_period SET locked_modules = p_modules WHERE tenant_id = p_tenant AND fiscal_year = p_year AND period_no = p_period;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERIOD_NOT_FOUND: kỳ %/%', p_period, p_year USING ERRCODE = 'P0001'; END IF;
  PERFORM fn_period_audit(p_tenant, 'lock_modules', p_year, p_period, to_jsonb(p_modules));
END $$;

-- Chỉ kiểm tra được kỳ đã khóa cứng: kỳ chưa khóa cứng không có hash, báo lệch từng chứng từ sẽ chỉ gây nhiễu.
-- Sau vòng lặp so hash cuối chuỗi với hash_tail của kỳ: chứng từ bị xóa ở cuối kỳ (hoặc cả kỳ) không còn dòng nào để báo lệch, chỉ lộ ra ở đây.
CREATE OR REPLACE FUNCTION verify_period_hash(p_tenant uuid, p_year int, p_period int)
RETURNS TABLE(voucher_id uuid, voucher_no text, stored bytea, computed bytea, ok boolean) LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
DECLARE prev bytea; r record; h bytea; v_status text; v_tail bytea;
BEGIN
  SELECT q.status, q.hash_tail INTO v_status, v_tail FROM fiscal_period q WHERE q.tenant_id = p_tenant AND q.fiscal_year = p_year AND q.period_no = p_period;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERIOD_NOT_FOUND: kỳ %/%', p_period, p_year USING ERRCODE = 'P0001'; END IF;
  IF v_status <> 'hard_locked' THEN RAISE EXCEPTION 'PERIOD_STATE_INVALID: kỳ %/% chưa khóa cứng nên chưa có hash', p_period, p_year USING ERRCODE = 'P0001'; END IF;
  SELECT hash_tail INTO prev FROM fiscal_period q WHERE q.tenant_id = p_tenant AND (q.fiscal_year, q.period_no) < (p_year, p_period) AND q.hash_tail IS NOT NULL ORDER BY q.fiscal_year DESC, q.period_no DESC LIMIT 1;
  prev := coalesce(prev, '\x00'::bytea);
  FOR r IN SELECT v.id, v.voucher_no, v.row_hash FROM voucher v WHERE v.tenant_id = p_tenant AND v.fiscal_year = p_year AND v.period_no = p_period AND v.state IN ('posted','reversed','cancelled')
           ORDER BY v.posting_date, v.voucher_type COLLATE "C", v.seq_no, v.id LOOP
    h := digest(prev || convert_to(fn_voucher_canonical(r.id), 'UTF8'), 'sha256');
    voucher_id := r.id; voucher_no := r.voucher_no; stored := r.row_hash; computed := h; ok := coalesce(r.row_hash = h, false);
    RETURN NEXT;
    prev := h;
  END LOOP;
  IF prev IS DISTINCT FROM v_tail THEN
    voucher_id := NULL; voucher_no := '(hash_tail)'; stored := v_tail; computed := prev; ok := false;
    RETURN NEXT;
  END IF;
END $$;
