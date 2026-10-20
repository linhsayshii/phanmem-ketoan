-- 0004_so_cai.sql: sổ cái (chứng từ, dòng chứng từ theo tháng, số thứ tự, lịch sử, đính kèm, cặp đối ứng) và trigger bất biến.

-- Khóa ngoại tổng hợp (tenant_id, id): kiểm tra khóa ngoại bỏ qua RLS nên phải ràng buộc cùng công ty (như account, role).
ALTER TABLE party ADD UNIQUE (tenant_id, id);
ALTER TABLE department ADD UNIQUE (tenant_id, id);
ALTER TABLE employee ADD UNIQUE (tenant_id, id);
ALTER TABLE cost_item ADD UNIQUE (tenant_id, id);
ALTER TABLE project ADD UNIQUE (tenant_id, id);

-- ===== Loại chứng từ =====
CREATE TABLE voucher_type (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL,
  module text NOT NULL DEFAULT 'general' CHECK (module IN ('general','cash','bank','inventory','arap','assets','payroll')),
  prefix text NOT NULL DEFAULT '', suffix text NOT NULL DEFAULT '', pad_length int NOT NULL DEFAULT 5 CHECK (pad_length BETWEEN 1 AND 10),
  is_system boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code));
SELECT rls_enable('voucher_type');

CREATE OR REPLACE FUNCTION seed_voucher_types(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO voucher_type(tenant_id, code, name, module, prefix, is_system) VALUES
    (p_tenant, 'PKT', 'Phiếu kế toán', 'general', 'PKT', true),
    (p_tenant, 'DK', 'Số dư đầu kỳ', 'general', 'DK', true),
    (p_tenant, 'KC', 'Chứng từ kết chuyển', 'general', 'KC', true),
    (p_tenant, 'PB', 'Chứng từ phân bổ', 'general', 'PB', true)
  ON CONFLICT DO NOTHING;
$$;
-- Như seed_tenant_defaults (0003): chỉ create_tenant (SECURITY DEFINER) gọi; app_user có EXECUTE từ ALTER DEFAULT PRIVILEGES của 0001 nên phải thu riêng.
REVOKE EXECUTE ON FUNCTION seed_voucher_types(uuid) FROM PUBLIC, app_user;

-- Định nghĩa lại seed_tenant_defaults: nội dung 0003 + dòng PERFORM seed_voucher_types. CREATE OR REPLACE giữ nguyên quyền đã thu ở 0003.
CREATE OR REPLACE FUNCTION seed_tenant_defaults(p_tenant uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO currency(tenant_id, code, name, symbol, minor_unit) VALUES (p_tenant, 'VND', 'Đồng Việt Nam', '₫', 0), (p_tenant, 'USD', 'Đô la Mỹ', '$', 2);
  INSERT INTO payment_method(tenant_id, code, name) VALUES (p_tenant, 'TM', 'Tiền mặt'), (p_tenant, 'CK', 'Chuyển khoản'), (p_tenant, 'TM/CK', 'Tiền mặt hoặc chuyển khoản');
  INSERT INTO tax_code(tenant_id, code, name, kind, rate, is_exempt, in_declaration) VALUES
    (p_tenant, 'V0', 'Thuế GTGT 0%', 'vat', 0, false, true), (p_tenant, 'V5', 'Thuế GTGT 5%', 'vat', 5, false, true),
    (p_tenant, 'V8', 'Thuế GTGT 8% (giảm theo NQ 204/2025)', 'vat', 8, false, true), (p_tenant, 'V10', 'Thuế GTGT 10%', 'vat', 10, false, true),
    (p_tenant, 'KCT', 'Không chịu thuế GTGT', 'vat', NULL, true, true), (p_tenant, 'KKK', 'Không kê khai, tính nộp thuế GTGT', 'vat', NULL, true, false),
    (p_tenant, 'NK', 'Thuế nhập khẩu', 'import', NULL, false, false), (p_tenant, 'TTDB', 'Thuế tiêu thụ đặc biệt', 'excise', NULL, false, false);
  INSERT INTO invoice_group(tenant_id, scope, code, name, rate) VALUES
    (p_tenant, 'purchase', '01', 'HHDV dùng riêng cho SXKD chịu thuế GTGT đủ điều kiện khấu trừ', NULL),
    (p_tenant, 'purchase', '02', 'HHDV dùng riêng cho SXKD không chịu thuế GTGT', NULL),
    (p_tenant, 'purchase', '03', 'HHDV dùng chung cho SXKD chịu thuế và không chịu thuế', NULL),
    (p_tenant, 'purchase', '04', 'HHDV dùng cho dự án đầu tư', NULL),
    (p_tenant, 'purchase', '05', 'HHDV không đủ điều kiện khấu trừ / không tổng hợp lên tờ khai', NULL),
    (p_tenant, 'sale', '00', 'Bán ra chịu thuế suất 0%', 0), (p_tenant, 'sale', '05', 'Bán ra chịu thuế suất 5%', 5),
    (p_tenant, 'sale', '08', 'Bán ra chịu thuế suất 8%', 8), (p_tenant, 'sale', '10', 'Bán ra chịu thuế suất 10%', 10),
    (p_tenant, 'sale', 'KCT', 'Bán ra không chịu thuế', NULL);
  INSERT INTO uom(tenant_id, code, name) VALUES (p_tenant, 'CAI', 'Cái'), (p_tenant, 'CHIEC', 'Chiếc'), (p_tenant, 'BO', 'Bộ'), (p_tenant, 'GIO', 'Giờ'), (p_tenant, 'THANG', 'Tháng');
  PERFORM seed_voucher_types(p_tenant);
END $$;
-- Công ty đã tạo trước migration này: bổ sung loại chứng từ.
SELECT seed_voucher_types(id) FROM tenant;
-- Bật audit sau khi bổ sung, để migration không ghi nhật ký kiểm toán không có người dùng cho công ty cũ.
SELECT audit_enable('voucher_type');

-- ===== Chứng từ =====
CREATE TABLE voucher (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  voucher_type text NOT NULL,
  voucher_no text, seq_no bigint,
  posting_date date NOT NULL, document_date date NOT NULL,
  fiscal_year int NOT NULL DEFAULT 0, period_no int NOT NULL DEFAULT -1,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','posted','reversed','cancelled')),
  description text,
  party_id uuid,
  currency_code char(3) NOT NULL DEFAULT 'VND', fx_rate numeric(20,10),
  source_doc_type text, source_doc_id uuid,
  reversal_of_id uuid REFERENCES voucher(id), reversed_by_id uuid REFERENCES voucher(id),
  is_closing boolean NOT NULL DEFAULT false,
  idempotency_key text,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid, posted_at timestamptz,
  version int NOT NULL DEFAULT 1,
  prev_hash bytea, row_hash bytea,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, voucher_type, voucher_no),
  FOREIGN KEY (tenant_id, party_id) REFERENCES party(tenant_id, id),
  FOREIGN KEY (tenant_id, currency_code) REFERENCES currency(tenant_id, code),
  FOREIGN KEY (tenant_id, voucher_type) REFERENCES voucher_type(tenant_id, code)
);
CREATE INDEX ON voucher (tenant_id, posting_date);
CREATE INDEX ON voucher (tenant_id, voucher_type, fiscal_year, seq_no);
CREATE INDEX ON voucher (tenant_id, fiscal_year, period_no, state);
CREATE INDEX ON voucher (tenant_id, source_doc_type, source_doc_id);

CREATE TABLE voucher_line (
  id bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL,
  voucher_id uuid NOT NULL REFERENCES voucher(id),
  line_no int NOT NULL,
  account_id bigint NOT NULL,
  posting_date date NOT NULL,
  currency_code char(3) NOT NULL DEFAULT 'VND', fx_rate numeric(20,10),
  amount_currency numeric(20,4) NOT NULL DEFAULT 0,
  debit numeric(20,0) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(20,0) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  balance numeric(20,0) GENERATED ALWAYS AS (debit - credit) STORED,
  -- item_id, warehouse_id, contract_id, asset_id: khóa ngoại thêm cùng bảng danh mục tương ứng ở giai đoạn sau.
  party_id uuid, item_id bigint, warehouse_id bigint, department_id bigint, project_id bigint, cost_item_id bigint, contract_id bigint, employee_id bigint, asset_id bigint,
  extra_dims jsonb NOT NULL DEFAULT '{}',
  description text, due_date date,
  CONSTRAINT one_side_only CHECK (debit = 0 OR credit = 0),
  CONSTRAINT not_empty_line CHECK (debit > 0 OR credit > 0 OR amount_currency <> 0),
  CONSTRAINT sign_consistent CHECK ((amount_currency >= 0 AND credit = 0) OR (amount_currency <= 0 AND debit = 0)),
  PRIMARY KEY (id, posting_date),
  UNIQUE (voucher_id, line_no, posting_date),
  FOREIGN KEY (tenant_id, account_id) REFERENCES account(tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES party(tenant_id, id),
  FOREIGN KEY (tenant_id, currency_code) REFERENCES currency(tenant_id, code),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee(tenant_id, id),
  FOREIGN KEY (tenant_id, cost_item_id) REFERENCES cost_item(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES project(tenant_id, id)
) PARTITION BY RANGE (posting_date);
CREATE INDEX ON voucher_line (tenant_id, account_id, posting_date) INCLUDE (debit, credit);
CREATE INDEX ON voucher_line (tenant_id, party_id, posting_date);
CREATE INDEX ON voucher_line (voucher_id);

CREATE TABLE voucher_counter (
  tenant_id uuid NOT NULL, voucher_type text NOT NULL, fiscal_year int NOT NULL, last_no bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, voucher_type, fiscal_year));
CREATE TABLE voucher_line_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, voucher_id uuid NOT NULL REFERENCES voucher(id),
  version int NOT NULL, header jsonb NOT NULL, lines jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(), archived_by uuid);
CREATE INDEX ON voucher_line_history (tenant_id, voucher_id);
REVOKE UPDATE, DELETE ON voucher_line_history FROM app_user;
CREATE TABLE voucher_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, voucher_id uuid NOT NULL REFERENCES voucher(id),
  file_name text NOT NULL, mime text NOT NULL, bytes bigint NOT NULL, storage_key text NOT NULL,
  uploaded_by uuid NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE voucher_pair (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, voucher_id uuid NOT NULL REFERENCES voucher(id) ON DELETE CASCADE,
  posting_date date NOT NULL, debit_account_id bigint NOT NULL REFERENCES account(id), credit_account_id bigint NOT NULL REFERENCES account(id),
  debit_party_id uuid, credit_party_id uuid, amount numeric(20,0) NOT NULL CHECK (amount > 0), is_closing boolean NOT NULL DEFAULT false);
CREATE INDEX ON voucher_pair (tenant_id, posting_date, debit_account_id, credit_account_id);
CREATE INDEX ON voucher_pair (voucher_id);
CREATE TABLE balance_stale (tenant_id uuid PRIMARY KEY, stale_year int NOT NULL, stale_period int NOT NULL, marked_at timestamptz NOT NULL DEFAULT now());

SELECT rls_enable(t) FROM unnest(ARRAY['voucher','voucher_line','voucher_counter','voucher_line_history','voucher_attachment','voucher_pair','balance_stale']::regclass[]) AS t;

-- ===== Partition theo tháng =====
CREATE OR REPLACE FUNCTION ensure_line_partitions(p_from date, p_to date) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d date := date_trunc('month', p_from)::date; v_name text;
BEGIN
  -- Chặn đầu vào bất thường (hàm là SECURITY DEFINER): tối đa 24 tháng, năm 1990-2199.
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR extract(year FROM p_from) NOT BETWEEN 1990 AND 2199 OR extract(year FROM p_to) NOT BETWEEN 1990 AND 2199 THEN
    RAISE EXCEPTION 'PARTITION_RANGE_INVALID: khoảng % - % không hợp lệ (cần từ <= đến, năm 1990-2199)', p_from, p_to USING ERRCODE = 'P0001'; END IF;
  IF (extract(year FROM p_to)::int - extract(year FROM p_from)::int) * 12 + extract(month FROM p_to)::int - extract(month FROM p_from)::int + 1 > 24 THEN
    RAISE EXCEPTION 'PARTITION_RANGE_INVALID: khoảng % - % dài hơn 24 tháng', p_from, p_to USING ERRCODE = 'P0001'; END IF;
  -- Khóa kiểm tra hai lần: không thiếu tháng nào thì thoát ngay, không giữ khóa đến hết giao dịch của người gọi.
  IF NOT EXISTS (SELECT 1 FROM generate_series(d, p_to, interval '1 month') g
                 WHERE to_regclass(format('voucher_line_y%sm%s', to_char(g, 'YYYY'), to_char(g, 'MM'))) IS NULL) THEN RETURN; END IF;
  -- Hai giao dịch cùng tạo một tháng sẽ đua nhau tới "already exists": tuần tự hóa bằng khóa tư vấn rồi kiểm tra lại từng tháng.
  -- Còn lại: hai phiên cùng tạo tháng mới, một phiên đã ghi party/account/currency... có thể bế tắc; PostgreSQL hủy một phiên (40P01), chấp nhận được.
  PERFORM pg_advisory_xact_lock(hashtext('ensure_line_partitions'));
  WHILE d <= p_to LOOP
    v_name := format('voucher_line_y%sm%s', to_char(d, 'YYYY'), to_char(d, 'MM'));
    IF to_regclass(v_name) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF voucher_line FOR VALUES FROM (%L) TO (%L)', v_name, d, (d + interval '1 month')::date);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_name);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', v_name);
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', v_name);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', v_name);
    END IF;
    d := (d + interval '1 month')::date;
  END LOOP;
END $$;
-- Chỉ trigger này (SECURITY DEFINER) và migration gọi được ensure_line_partitions; app_user không có EXECUTE.
REVOKE EXECUTE ON FUNCTION ensure_line_partitions(date, date) FROM PUBLIC, app_user;
CREATE OR REPLACE FUNCTION fn_fiscal_period_partitions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN PERFORM ensure_line_partitions(NEW.date_from, NEW.date_to); RETURN NEW; END $$;
CREATE TRIGGER trg_fiscal_period_partitions AFTER INSERT ON fiscal_period FOR EACH ROW EXECUTE FUNCTION fn_fiscal_period_partitions();
-- Từng khoảng (không gộp min..max để không vượt giới hạn 24 tháng).
SELECT ensure_line_partitions(date_from, date_to) FROM (SELECT DISTINCT date_from, date_to FROM fiscal_period) AS r;

-- ===== Kỳ =====
ALTER TABLE fiscal_period ADD COLUMN locked_modules text[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION fn_period_of(p_tenant uuid, p_date date, p_opening boolean) RETURNS fiscal_period LANGUAGE plpgsql STABLE AS $$
DECLARE p fiscal_period;
BEGIN
  IF p_opening THEN
    SELECT * INTO p FROM fiscal_period WHERE tenant_id = p_tenant AND period_no = 0 AND date_from = p_date;
  ELSE
    SELECT * INTO p FROM fiscal_period WHERE tenant_id = p_tenant AND period_no BETWEEN 1 AND 15 AND p_date BETWEEN date_from AND date_to;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERIOD_NOT_FOUND: ngày % không thuộc kỳ kế toán nào đã mở', p_date USING ERRCODE = 'P0001'; END IF;
  RETURN p;
END $$;

CREATE OR REPLACE FUNCTION fn_assert_period_writable(p fiscal_period, p_module text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p.status = 'hard_locked' THEN RAISE EXCEPTION 'PERIOD_HARD_LOCKED: kỳ %/% đã khóa cứng', p.period_no, p.fiscal_year USING ERRCODE = 'P0001'; END IF;
  IF p.status = 'soft_locked' AND current_setting('app.override_soft_lock', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'PERIOD_SOFT_LOCKED: kỳ %/% đã khóa sổ, cần quyền ghi lùi ngày', p.period_no, p.fiscal_year USING ERRCODE = 'P0001'; END IF;
  IF p_module = ANY (p.locked_modules) THEN RAISE EXCEPTION 'PERIOD_MODULE_LOCKED: phần hành % đã khóa ở kỳ %/%', p_module, p.period_no, p.fiscal_year USING ERRCODE = 'P0001'; END IF;
END $$;

-- ===== Trigger chứng từ =====
-- Biến phiên chưa đặt trả về NULL (đã đặt rồi hết giao dịch thì trả ''), nên so sánh bằng IS NOT DISTINCT FROM để cờ luôn là true/false, không bao giờ NULL.
CREATE OR REPLACE FUNCTION fn_voucher_before() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p fiscal_period; vt voucher_type; v_in_proc boolean := current_setting('app.state_change', true) IS NOT DISTINCT FROM 'on';
        v_renum boolean := current_setting('app.renumbering', true) IS NOT DISTINCT FROM 'on'; v_lock boolean := current_setting('app.locking', true) IS NOT DISTINCT FROM 'on';
BEGIN
  SELECT * INTO vt FROM voucher_type WHERE tenant_id = NEW.tenant_id AND code = NEW.voucher_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_TYPE_NOT_FOUND: loại chứng từ %', NEW.voucher_type USING ERRCODE = 'P0001'; END IF;
  p := fn_period_of(NEW.tenant_id, NEW.posting_date, NEW.voucher_type = 'DK');
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
CREATE TRIGGER trg_voucher_before BEFORE INSERT OR UPDATE ON voucher FOR EACH ROW EXECUTE FUNCTION fn_voucher_before();

CREATE OR REPLACE FUNCTION fn_voucher_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'draft' OR OLD.voucher_no IS NOT NULL THEN
    RAISE EXCEPTION 'VOUCHER_DELETE_FORBIDDEN: chỉ xóa được chứng từ nháp chưa cấp số; dùng Hủy' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, ip)
    VALUES (OLD.tenant_id, app_user_id(), 'delete', 'voucher', OLD.id::text, to_jsonb(OLD), nullif(current_setting('app.client_ip', true), ''));
  RETURN OLD;
END $$;
CREATE TRIGGER trg_voucher_delete BEFORE DELETE ON voucher FOR EACH ROW EXECUTE FUNCTION fn_voucher_delete();

-- Đổi ngày ghi sổ của chứng từ nháp: dòng đi theo (fn_line_before gán lại posting_date, dòng chuyển sang partition của tháng mới).
-- Chứng từ đã ghi sổ không đổi ngày được nên không tới đây.
CREATE OR REPLACE FUNCTION fn_voucher_date_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE voucher_line SET line_no = line_no WHERE voucher_id = NEW.id; RETURN NULL; END $$;
CREATE TRIGGER trg_voucher_date_sync AFTER UPDATE OF posting_date ON voucher FOR EACH ROW WHEN (NEW.posting_date IS DISTINCT FROM OLD.posting_date) EXECUTE FUNCTION fn_voucher_date_sync();

-- ===== Trigger dòng =====
CREATE OR REPLACE FUNCTION fn_line_before() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v voucher; a account; v_regime text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.voucher_id IS DISTINCT FROM OLD.voucher_id THEN
    RAISE EXCEPTION 'LINE_IMMUTABLE: không chuyển dòng sang chứng từ khác' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM voucher WHERE id = NEW.voucher_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', NEW.voucher_id USING ERRCODE = 'P0001'; END IF;
  NEW.tenant_id := v.tenant_id; NEW.posting_date := v.posting_date;
  IF TG_OP = 'INSERT' AND v.state <> 'draft' AND current_setting('app.unposting', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'LINE_IMMUTABLE: không thêm dòng vào chứng từ đã ghi sổ' USING ERRCODE = 'P0001'; END IF;
  -- Kiểm tra tài khoản/đối tượng chỉ khi thêm dòng hoặc đổi tài khoản, đối tượng, vật tư, tài sản: sửa diễn giải dòng cũ không bị chặn khi tài khoản đã ngừng dùng.
  IF TG_OP = 'INSERT' OR (NEW.account_id, NEW.party_id, NEW.item_id, NEW.asset_id) IS DISTINCT FROM (OLD.account_id, OLD.party_id, OLD.item_id, OLD.asset_id) THEN
    SELECT * INTO a FROM account WHERE id = NEW.account_id AND tenant_id = v.tenant_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: tài khoản id %', NEW.account_id USING ERRCODE = 'P0001'; END IF;
    -- Một công ty có thể giữ nhiều hệ tài khoản; mỗi năm tài chính dùng đúng một chế độ (fiscal_period.regime).
    SELECT regime INTO v_regime FROM fiscal_period WHERE tenant_id = v.tenant_id AND fiscal_year = v.fiscal_year AND period_no = v.period_no;
    IF a.regime IS DISTINCT FROM v_regime THEN
      RAISE EXCEPTION 'ACCOUNT_REGIME_MISMATCH: tài khoản % thuộc chế độ %, kỳ chứng từ dùng chế độ %', a.code, a.regime, v_regime USING ERRCODE = 'P0001'; END IF;
    IF a.is_group THEN RAISE EXCEPTION 'ACCOUNT_IS_GROUP: tài khoản % là tài khoản tổng hợp, không định khoản được', a.code USING ERRCODE = 'P0001'; END IF;
    IF NOT a.is_active THEN RAISE EXCEPTION 'ACCOUNT_INACTIVE: tài khoản % đã ngừng sử dụng', a.code USING ERRCODE = 'P0001'; END IF;
    IF a.subledger_kind IN ('receivable','payable') AND NEW.party_id IS NULL THEN RAISE EXCEPTION 'LINE_PARTY_REQUIRED: tài khoản % phải có đối tượng', a.code USING ERRCODE = 'P0001'; END IF;
    IF a.subledger_kind = 'inventory' AND NEW.item_id IS NULL THEN RAISE EXCEPTION 'LINE_ITEM_REQUIRED: tài khoản % phải có vật tư', a.code USING ERRCODE = 'P0001'; END IF;
    IF a.subledger_kind = 'fixed_asset' AND NEW.asset_id IS NULL THEN RAISE EXCEPTION 'LINE_ASSET_REQUIRED: tài khoản % phải có tài sản', a.code USING ERRCODE = 'P0001'; END IF;
  END IF;
  IF NEW.currency_code = 'VND' THEN NEW.amount_currency := NEW.debit - NEW.credit; NEW.fx_rate := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_line_before BEFORE INSERT OR UPDATE ON voucher_line FOR EACH ROW EXECUTE FUNCTION fn_line_before();

CREATE OR REPLACE FUNCTION fn_line_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_state text; v_status text;
BEGIN
  IF current_setting('app.unposting', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT v.state, p.status INTO v_state, v_status FROM voucher v JOIN fiscal_period p ON p.tenant_id = v.tenant_id AND p.fiscal_year = v.fiscal_year AND p.period_no = v.period_no WHERE v.id = OLD.voucher_id;
  IF v_state IN ('posted','reversed','cancelled') THEN
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
CREATE TRIGGER trg_line_immutable BEFORE UPDATE OR DELETE ON voucher_line FOR EACH ROW EXECUTE FUNCTION fn_line_immutable();

-- ===== Cân bằng (constraint trigger, kiểm tra lúc COMMIT) =====
CREATE OR REPLACE FUNCTION fn_check_voucher_balance(p_voucher uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher; v_d numeric; v_c numeric; v_n int; v_cur record;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  IF NOT FOUND THEN RETURN; END IF;  -- chứng từ đã bị xóa trong cùng transaction
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) INTO v_d, v_c, v_n FROM voucher_line WHERE voucher_id = p_voucher;
  IF v_n = 0 AND v.state IN ('posted','reversed') THEN RAISE EXCEPTION 'VOUCHER_EMPTY: chứng từ % không có dòng', coalesce(v.voucher_no, v.id::text) USING ERRCODE = 'P0001'; END IF;
  IF v_d <> v_c THEN RAISE EXCEPTION 'VOUCHER_UNBALANCED: tổng Nợ % khác tổng Có %', v_d, v_c USING ERRCODE = 'P0001'; END IF;
  FOR v_cur IN SELECT currency_code, sum(amount_currency) AS s FROM voucher_line WHERE voucher_id = p_voucher AND currency_code <> 'VND' GROUP BY currency_code HAVING sum(amount_currency) <> 0 LOOP
    RAISE EXCEPTION 'VOUCHER_UNBALANCED_CURRENCY: nguyên tệ % lệch %', v_cur.currency_code, v_cur.s USING ERRCODE = 'P0001';
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION fn_trg_line_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM fn_check_voucher_balance(COALESCE(NEW.voucher_id, OLD.voucher_id)); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER trg_voucher_balanced AFTER INSERT OR UPDATE OR DELETE ON voucher_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_trg_line_balanced();
CREATE OR REPLACE FUNCTION fn_trg_voucher_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM fn_check_voucher_balance(NEW.id); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER trg_voucher_state_balanced AFTER UPDATE OF state ON voucher DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_trg_voucher_balanced();

-- ===== Cặp đối ứng =====
CREATE OR REPLACE FUNCTION fn_build_pairs(p_voucher uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher; nd int; nc int; total numeric;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  DELETE FROM voucher_pair WHERE voucher_id = p_voucher;
  SELECT count(*) FILTER (WHERE debit > 0), count(*) FILTER (WHERE credit > 0), coalesce(sum(debit),0) INTO nd, nc, total FROM voucher_line WHERE voucher_id = p_voucher;
  IF total = 0 THEN RETURN; END IF;
  IF nd = 1 OR nc = 1 THEN
    INSERT INTO voucher_pair(tenant_id, voucher_id, posting_date, debit_account_id, credit_account_id, debit_party_id, credit_party_id, amount, is_closing)
    SELECT v.tenant_id, p_voucher, v.posting_date, d.account_id, c.account_id, d.party_id, c.party_id, CASE WHEN nd = 1 THEN c.credit ELSE d.debit END, v.is_closing
    FROM voucher_line d JOIN voucher_line c ON c.voucher_id = d.voucher_id WHERE d.voucher_id = p_voucher AND d.debit > 0 AND c.credit > 0;
  ELSE
    -- n–n: ghép tham lam theo thứ tự line_no (góc tây bắc). Dòng Nợ và dòng Có là các đoạn nối tiếp trên trục [0, total);
    -- mỗi cặp là phần giao của một đoạn Nợ với một đoạn Có, nên tổng các cặp của từng dòng đúng bằng số Nợ/Có của dòng đó.
    INSERT INTO voucher_pair(tenant_id, voucher_id, posting_date, debit_account_id, credit_account_id, debit_party_id, credit_party_id, amount, is_closing)
    WITH d AS (SELECT account_id, party_id, debit AS amt, sum(debit) OVER (ORDER BY line_no) AS hi FROM voucher_line WHERE voucher_id = p_voucher AND debit > 0),
         c AS (SELECT account_id, party_id, credit AS amt, sum(credit) OVER (ORDER BY line_no) AS hi FROM voucher_line WHERE voucher_id = p_voucher AND credit > 0)
    SELECT v.tenant_id, p_voucher, v.posting_date, d.account_id, c.account_id, d.party_id, c.party_id,
           least(d.hi, c.hi) - greatest(d.hi - d.amt, c.hi - c.amt), v.is_closing
    FROM d JOIN c ON least(d.hi, c.hi) > greatest(d.hi - d.amt, c.hi - c.amt)
    ORDER BY d.hi, c.hi;
  END IF;
END $$;

-- ===== Làm bẩn số dư =====
CREATE OR REPLACE FUNCTION mark_balance_stale(p_tenant uuid, p_year int, p_period int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO balance_stale(tenant_id, stale_year, stale_period) VALUES (p_tenant, p_year, p_period)
  ON CONFLICT (tenant_id) DO UPDATE
    SET stale_year = CASE WHEN (EXCLUDED.stale_year, EXCLUDED.stale_period) < (balance_stale.stale_year, balance_stale.stale_period) THEN EXCLUDED.stale_year ELSE balance_stale.stale_year END,
        stale_period = CASE WHEN (EXCLUDED.stale_year, EXCLUDED.stale_period) < (balance_stale.stale_year, balance_stale.stale_period) THEN EXCLUDED.stale_period ELSE balance_stale.stale_period END,
        marked_at = now();
END $$;

-- ===== Tài khoản đã dùng: không đổi mã/xóa =====
-- UPDATE chỉ bị chặn khi mã hoặc tài khoản cha thực sự đổi (SET code = code không phải là đổi).
CREATE OR REPLACE FUNCTION fn_account_in_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.code IS NOT DISTINCT FROM OLD.code AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM voucher_line WHERE tenant_id = OLD.tenant_id AND account_id = OLD.id LIMIT 1) THEN
    RAISE EXCEPTION 'ACCOUNT_IN_USE: tài khoản % đã có phát sinh, không đổi số hiệu hoặc xóa được', OLD.code USING ERRCODE = 'P0001'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_account_in_use BEFORE UPDATE OF code, parent_id OR DELETE ON account FOR EACH ROW EXECUTE FUNCTION fn_account_in_use();
