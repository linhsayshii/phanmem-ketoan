-- GĐ2 Task 11: công nợ theo chứng từ. Mỗi dòng ghi sổ trên tài khoản công nợ (account.reconcile) có đối tượng sinh một khoản open_item;
-- settlement ghi các lần đối trừ giữa khoản Nợ và khoản Có. Dư còn lại của khoản tại ngày d = số tiền khoản (có dấu: Nợ dương, Có âm) trừ phần đã đối trừ đến d.
-- Thân post_voucher, unpost_voucher, reverse_voucher lấy từ định nghĩa hiện hành (pg_get_functiondef) sau 0027, chỉ thêm các đoạn ghi chú "công nợ". Hàm vẫn chạy quyền người gọi.

-- 1) Khóa của bảng phân vùng phải gồm cột phân vùng: open_item tham chiếu dòng chứng từ qua (tenant_id, id, posting_date). Khai báo trên bảng gốc, các partition kế thừa.
ALTER TABLE voucher_line ADD CONSTRAINT voucher_line_tenant_id_id_posting_date_key UNIQUE (tenant_id, id, posting_date);

-- 2) Tài khoản công nợ: mọi tài khoản phải thu/phải trả theo dõi đối trừ theo chứng từ. Tắt audit để migration không ghi nhật ký không có người dùng (như 0024).
ALTER TABLE account DISABLE TRIGGER trg_audit;
UPDATE account SET reconcile = true WHERE subledger_kind IN ('receivable', 'payable') AND NOT reconcile;
ALTER TABLE account ENABLE TRIGGER trg_audit;
-- Tài khoản tạo mới (sinh hệ thống tài khoản cho công ty mới, thêm tài khoản con) kế thừa reconcile theo loại sổ chi tiết, ở mọi đường chèn (API, seed, SQL).
-- shortcut: chỉ khi chèn; đổi subledger_kind của tài khoản đã có không đổi reconcile (tài khoản đã có dòng ghi sổ cần sinh bù open_item), làm khi có màn hình đổi loại sổ chi tiết.
CREATE OR REPLACE FUNCTION fn_account_reconcile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.reconcile := NEW.reconcile OR coalesce(NEW.subledger_kind IN ('receivable', 'payable'), false);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_account_reconcile BEFORE INSERT ON account FOR EACH ROW EXECUTE FUNCTION fn_account_reconcile();

-- 3) Khoản công nợ. Dữ liệu sinh từ ghi sổ (ghi sổ đã có nhật ký kiểm toán) nên không audit_enable.
CREATE TABLE open_item (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  voucher_id uuid NOT NULL,
  voucher_line_id bigint NOT NULL,
  line_posting_date date NOT NULL,
  line_no int NOT NULL,
  account_id bigint NOT NULL,
  party_id uuid NOT NULL,
  currency_code char(3) NOT NULL,
  doc_date date NOT NULL,
  doc_no text,
  due_date date,
  amount numeric(20,0) NOT NULL,            -- Nợ − Có, có dấu
  amount_currency numeric(20,4) NOT NULL,   -- nguyên tệ có dấu (dòng VND bằng amount)
  parent_id bigint,                         -- dòng điều chỉnh đánh giá lại của khoản gốc (Task 13)
  invoice_id bigint,                        -- hóa đơn (Task 18 thêm khóa ngoại)
  UNIQUE (tenant_id, voucher_line_id, line_posting_date),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher(tenant_id, id),
  FOREIGN KEY (tenant_id, voucher_line_id, line_posting_date) REFERENCES voucher_line(tenant_id, id, posting_date),
  FOREIGN KEY (tenant_id, account_id) REFERENCES account(tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES party(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES open_item(tenant_id, id));
CREATE INDEX open_item_party ON open_item (tenant_id, account_id, party_id, doc_date);
CREATE INDEX open_item_voucher ON open_item (voucher_id);
CREATE INDEX open_item_parent ON open_item (tenant_id, parent_id) WHERE parent_id IS NOT NULL;
SELECT rls_enable('open_item');
-- Số tiền của khoản chỉ đổi bằng bỏ ghi sổ/đảo chứng từ; người dùng ứng dụng chỉ sửa được hạn, khoản gốc, hóa đơn.
REVOKE UPDATE ON open_item FROM app_user;
GRANT UPDATE (due_date, parent_id, invoice_id) ON open_item TO app_user;

-- 4) Đối trừ: mỗi dòng trừ `amount` (nguyên tệ `amount_currency`) khỏi một khoản Nợ và một khoản Có; các dòng cùng group_id là một lần đối trừ, hủy cùng nhau.
CREATE TABLE settlement (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  debit_item_id bigint NOT NULL,
  credit_item_id bigint NOT NULL,
  amount numeric(20,0) NOT NULL CHECK (amount >= 0),
  amount_currency numeric(20,4) NOT NULL CHECK (amount_currency >= 0),
  settle_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('manual', 'auto', 'plan', 'reversal', 'fx')),
  fx_voucher_id uuid,
  group_id uuid NOT NULL,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount > 0 OR amount_currency > 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, debit_item_id) REFERENCES open_item(tenant_id, id),
  FOREIGN KEY (tenant_id, credit_item_id) REFERENCES open_item(tenant_id, id),
  FOREIGN KEY (tenant_id, fx_voucher_id) REFERENCES voucher(tenant_id, id));
CREATE INDEX settlement_debit ON settlement (tenant_id, debit_item_id);
CREATE INDEX settlement_credit ON settlement (tenant_id, credit_item_id);
CREATE INDEX settlement_group ON settlement (tenant_id, group_id);
SELECT rls_enable('settlement');
REVOKE UPDATE ON settlement FROM app_user;
-- audit_enable('settlement') đặt sau backfill (mục 9): đối trừ sinh bù cho chứng từ đảo đã có không ghi nhật ký.

-- 5) Dư còn lại tại cuối ngày p_date của các khoản đã ghi sổ đến ngày đó. Khoản lấy theo ngày ghi sổ của dòng (không theo ngày chứng từ)
-- để tổng dư theo (tài khoản, đối tượng) luôn bằng số dư sổ cái tại cùng ngày; doc_date trả ra để tính tuổi nợ.
CREATE OR REPLACE FUNCTION fn_open_items_at(p_tenant uuid, p_date date)
RETURNS TABLE (item_id bigint, account_id bigint, party_id uuid, currency_code char(3), doc_date date, due_date date, residual numeric, residual_currency numeric)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT x.item, sum(x.a) AS a, sum(x.ac) AS ac FROM (
      SELECT debit_item_id AS item, -amount AS a, -amount_currency AS ac FROM settlement WHERE tenant_id = p_tenant AND settle_date <= p_date
      UNION ALL
      SELECT credit_item_id, amount, amount_currency FROM settlement WHERE tenant_id = p_tenant AND settle_date <= p_date) x
    GROUP BY x.item)
  SELECT o.id, o.account_id, o.party_id, o.currency_code, o.doc_date, o.due_date, o.amount + coalesce(s.a, 0), o.amount_currency + coalesce(s.ac, 0)
  FROM open_item o LEFT JOIN s ON s.item = o.id
  WHERE o.tenant_id = p_tenant AND o.line_posting_date <= p_date
$$;

-- 6) Sinh khoản cho mọi dòng của chứng từ (một câu lệnh). Số chứng từ: số của chứng từ; DK lấy số/ngày chứng từ gốc nhập ở Số dư đầu kỳ (extra_dims ghi lúc ghi sổ số dư).
-- Hạn: hạn của dòng, không có thì hạn của chứng từ, không có thì ngày chứng từ + số ngày được nợ của đối tượng.
CREATE OR REPLACE FUNCTION fn_open_items_create(p_voucher uuid) RETURNS int LANGUAGE plpgsql AS $$
DECLARE v voucher; n int;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  INSERT INTO open_item(tenant_id, voucher_id, voucher_line_id, line_posting_date, line_no, account_id, party_id, currency_code, doc_date, doc_no, due_date, amount, amount_currency)
  SELECT l.tenant_id, l.voucher_id, l.id, l.posting_date, l.line_no, l.account_id, l.party_id, l.currency_code, d.doc_date, d.doc_no,
         coalesce(l.due_date, v.due_date, d.doc_date + p.payment_term_days), l.debit - l.credit, l.amount_currency
  FROM voucher_line l JOIN account a ON a.id = l.account_id AND a.reconcile JOIN party p ON p.id = l.party_id
  CROSS JOIN LATERAL (SELECT
      CASE WHEN v.voucher_type = 'DK' THEN coalesce((l.extra_dims->>'opening_doc_date')::date, v.posting_date) ELSE v.document_date END AS doc_date,
      CASE WHEN v.voucher_type = 'DK' THEN nullif(l.extra_dims->>'opening_doc_no', '') ELSE v.voucher_no END AS doc_no) d
  WHERE l.voucher_id = p_voucher AND l.posting_date = v.posting_date;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- 7) Đối trừ cặp khoản gốc/khoản đảo cùng line_no, kiểu 'reversal', ngày đối trừ là ngày đảo. Khoản gốc đã đối trừ thì bỏ qua: đảo lại một bản đảo
-- (khoản của bản đảo đã đối trừ hết với chứng từ gốc) thì khoản của chứng từ mới còn mở, mang lại công nợ.
CREATE OR REPLACE FUNCTION fn_open_items_settle_reversal(p_orig uuid, p_rev uuid) RETURNS int LANGUAGE plpgsql AS $$
DECLARE r voucher; n int; g uuid := gen_random_uuid(); -- một lần đảo là một nhóm đối trừ
BEGIN
  SELECT * INTO r FROM voucher WHERE id = p_rev;
  INSERT INTO settlement(tenant_id, debit_item_id, credit_item_id, amount, amount_currency, settle_date, kind, group_id, created_by)
  SELECT o.tenant_id, CASE WHEN o.amount > 0 OR (o.amount = 0 AND o.amount_currency > 0) THEN o.id ELSE x.id END,
         CASE WHEN o.amount > 0 OR (o.amount = 0 AND o.amount_currency > 0) THEN x.id ELSE o.id END,
         abs(o.amount), abs(o.amount_currency), r.posting_date, 'reversal', g, coalesce(app_user_id(), r.created_by)
  FROM open_item o JOIN open_item x ON x.voucher_id = p_rev AND x.line_no = o.line_no
  WHERE o.voucher_id = p_orig AND NOT EXISTS (SELECT 1 FROM settlement s WHERE s.tenant_id = o.tenant_id AND (s.debit_item_id = o.id OR s.credit_item_id = o.id));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- 8) Ghi sổ, bỏ ghi sổ, đảo.
CREATE OR REPLACE FUNCTION post_voucher(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
  PERFORM fn_open_items_create(p_id); -- công nợ: khoản theo chứng từ cho dòng tài khoản công nợ
  PERFORM mark_balance_stale(v.tenant_id, p.fiscal_year, p.period_no);
  PERFORM fn_audit_voucher(v.tenant_id, 'post', p_id, jsonb_build_object('voucher_no', coalesce(v.voucher_no, v_no), 'posting_date', v.posting_date));
END $function$;

CREATE OR REPLACE FUNCTION unpost_voucher(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; p fiscal_period;
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
  -- công nợ: như bỏ ghi sổ, trừ đối trừ kiểu 'reversal' (khoản của một bản đảo đã đối trừ hết với chứng từ gốc; đảo lại bản đảo vẫn được)
  IF EXISTS (SELECT 1 FROM open_item o JOIN settlement s ON s.tenant_id = o.tenant_id AND (s.debit_item_id = o.id OR s.credit_item_id = o.id) WHERE o.voucher_id = p_id AND s.kind <> 'reversal') THEN
    RAISE EXCEPTION 'OPEN_ITEM_SETTLED: chứng từ đã đối trừ công nợ, hãy hủy đối trừ trước' USING ERRCODE = 'P0001'; END IF;
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
  PERFORM fn_open_items_settle_reversal(p_id, v_new); -- công nợ: khoản gốc và khoản đảo tự đối trừ
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'reversed', reversed_by_id = v_new WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_audit_voucher(v.tenant_id, 'reverse', p_id, jsonb_build_object('reversed_by', v_new, 'date', p_date));
  RETURN v_new;
END $function$;

-- 9) Backfill: khoản cho mọi chứng từ đã ghi sổ hoặc đã đảo, rồi đối trừ các cặp gốc/đảo (chuỗi đảo lại bản đảo xử lý như lúc chạy thật).
DO $$
DECLARE r record;
BEGIN
  PERFORM fn_open_items_create(id) FROM voucher WHERE state IN ('posted', 'reversed');
  -- Theo độ sâu trong chuỗi đảo (đảo của chứng từ gốc trước, đảo lại bản đảo sau): cặp sau phụ thuộc cặp trước đã đối trừ hay chưa; created_at trùng nhau trong một giao dịch nên không dùng được.
  FOR r IN WITH RECURSIVE c AS (
      SELECT v.id, v.reversal_of_id, 1 AS depth FROM voucher v JOIN voucher o ON o.id = v.reversal_of_id WHERE o.reversal_of_id IS NULL
      UNION ALL
      SELECT v.id, v.reversal_of_id, c.depth + 1 FROM voucher v JOIN c ON v.reversal_of_id = c.id)
    SELECT id, reversal_of_id FROM c ORDER BY depth LOOP
    PERFORM fn_open_items_settle_reversal(r.reversal_of_id, r.id);
  END LOOP;
END $$;
SELECT audit_enable('settlement');

-- 10) Số dư đầu kỳ công nợ theo từng hóa đơn: số, ngày chứng từ gốc và hạn thanh toán; khóa duy nhất thêm số chứng từ (giữ tài khoản ngân hàng của 0026).
ALTER TABLE opening_balance ADD COLUMN doc_no text, ADD COLUMN doc_date date, ADD COLUMN due_date date;
DROP INDEX opening_balance_key;
CREATE UNIQUE INDEX opening_balance_key ON opening_balance (tenant_id, fiscal_year, account_id, coalesce(party_id, '00000000-0000-0000-0000-000000000000'::uuid), currency_code, coalesce(bank_account_id, 0), coalesce(doc_no, ''));
