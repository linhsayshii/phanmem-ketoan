-- GĐ5 Task 3: hóa đơn điện tử gắn chứng từ bán, chứng từ bán chờ số, khóa chứng từ đã phát hành.
CREATE TABLE einvoice (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  voucher_id uuid NOT NULL,
  series_id bigint NOT NULL,
  provider_id bigint NOT NULL,
  relation text NOT NULL DEFAULT 'original' CHECK (relation IN ('original', 'adjustment', 'replacement')),
  original_id bigint,
  adjust_kind text CHECK (adjust_kind IN ('increase', 'decrease', 'info')),
  status text NOT NULL CHECK (status IN ('draft', 'sending', 'issued', 'failed', 'replaced', 'cancelled')),
  transaction_uuid uuid NOT NULL,
  invoice_no text,
  issued_at timestamptz,
  issue_date date,
  cqt_code text,
  cqt_status text NOT NULL DEFAULT 'none' CHECK (cqt_status IN ('none', 'waiting', 'accepted', 'rejected')),
  provider_ref jsonb NOT NULL DEFAULT '{}',
  payload jsonb,
  xml text,
  error_code text,
  error_message text,
  needs_reversal boolean NOT NULL DEFAULT false,
  adjusted boolean NOT NULL DEFAULT false,
  paid boolean NOT NULL DEFAULT false,
  attempts int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, transaction_uuid),
  CHECK ((relation = 'original') = (original_id IS NULL)),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id),
  FOREIGN KEY (tenant_id, series_id) REFERENCES einvoice_series (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES einvoice_provider (tenant_id, id),
  FOREIGN KEY (tenant_id, original_id) REFERENCES einvoice (tenant_id, id));
CREATE UNIQUE INDEX einvoice_voucher_live ON einvoice (tenant_id, voucher_id) WHERE status NOT IN ('failed');
CREATE INDEX einvoice_series_idx ON einvoice (tenant_id, series_id);

CREATE TABLE einvoice_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  einvoice_id bigint,
  provider_id bigint NOT NULL,
  action text NOT NULL,
  request jsonb,
  response jsonb,
  http_status int,
  ok boolean NOT NULL,
  error text,
  ms int,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, einvoice_id) REFERENCES einvoice (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES einvoice_provider (tenant_id, id));

-- Kho của nhà cung cấp giả lập (Task 4): mô phỏng phía nhà cung cấp, không phải dữ liệu nghiệp vụ nên không ghi audit.
CREATE TABLE einvoice_fake_store (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  transaction_uuid uuid NOT NULL,
  serial text NOT NULL,
  invoice_no text NOT NULL,
  issue_date date NOT NULL,
  cqt_code text,
  cancelled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, transaction_uuid), UNIQUE (tenant_id, serial, invoice_no));

SELECT rls_enable(t) FROM unnest(ARRAY['einvoice', 'einvoice_log', 'einvoice_fake_store']::regclass[]) AS t;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON einvoice FOR EACH ROW EXECUTE FUNCTION fn_audit_row('xml', 'payload');

CREATE FUNCTION fn_einvoice_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'EINVOICE_LOG_IMMUTABLE: nhật ký hóa đơn điện tử chỉ thêm, không sửa hoặc xóa' USING ERRCODE = 'P0001'; END $$;
CREATE TRIGGER trg_einvoice_log_immutable BEFORE UPDATE OR DELETE ON einvoice_log FOR EACH ROW EXECUTE FUNCTION fn_einvoice_log_append_only();

-- Chứng từ bán chờ số hóa đơn do nhà cung cấp cấp.
ALTER TABLE voucher_invoice
  ADD COLUMN einvoice_series_id bigint,
  ADD COLUMN einvoice_pending boolean NOT NULL DEFAULT false,
  ALTER COLUMN invoice_no DROP NOT NULL,
  DROP CONSTRAINT voucher_invoice_invoice_no_check,
  ADD CONSTRAINT voucher_invoice_invoice_no_check CHECK ((invoice_no IS NOT NULL AND btrim(invoice_no) <> '') OR (invoice_no IS NULL AND einvoice_pending AND direction = 'sale')),
  ADD FOREIGN KEY (tenant_id, einvoice_series_id) REFERENCES einvoice_series (tenant_id, id);

-- fn_voucher_child_guard từ thân hiện hành (0043 trở đi), thêm: UPDATE chỉ đổi form_no, serial, invoice_no, invoice_date, einvoice_pending được qua khi app.einvoice_number = 'on'.
CREATE OR REPLACE FUNCTION fn_voucher_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  IF current_setting('app.unposting', true) = 'on' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'voucher_invoice' AND current_setting('app.einvoice_number', true) = 'on'
     AND to_jsonb(NEW) - ARRAY['form_no', 'serial', 'invoice_no', 'invoice_date', 'einvoice_pending'] = to_jsonb(OLD) - ARRAY['form_no', 'serial', 'invoice_no', 'invoice_date', 'einvoice_pending']
  THEN RETURN NEW; END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT state INTO v_state FROM voucher WHERE id = NEW.voucher_id;
    IF FOUND AND v_state <> 'draft' THEN RAISE EXCEPTION 'VOUCHER_CHILD_IMMUTABLE: chứng từ không còn là nháp (trạng thái %), không sửa được hóa đơn; chứng từ đã ghi sổ thì bỏ ghi sổ trước', v_state USING ERRCODE = 'P0001'; END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT state INTO v_state FROM voucher WHERE id = OLD.voucher_id;
    IF FOUND AND v_state <> 'draft' THEN RAISE EXCEPTION 'VOUCHER_CHILD_IMMUTABLE: chứng từ không còn là nháp (trạng thái %), không sửa được hóa đơn; chứng từ đã ghi sổ thì bỏ ghi sổ trước', v_state USING ERRCODE = 'P0001'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- Ghi ngược số hóa đơn vào chứng từ đã ghi sổ: chỉ dòng đang chờ số, và chỉ năm cột được phép (guard ở trên).
CREATE FUNCTION fn_einvoice_set_number(p_voucher uuid, p_form text, p_serial text, p_no text, p_date date) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.einvoice_number', 'on', true);
  UPDATE voucher_invoice SET form_no = p_form, serial = p_serial, invoice_no = p_no, invoice_date = p_date, einvoice_pending = false
   WHERE voucher_id = p_voucher AND einvoice_pending AND invoice_no IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('app.einvoice_number', 'off', true);
  IF n = 0 THEN RAISE EXCEPTION 'EINVOICE_NUMBER_SET: chứng từ không có dòng hóa đơn chờ số (đã có số hóa đơn)' USING ERRCODE = 'P0001'; END IF;
  RETURN n;
END $$;

-- Khóa chứng từ đã phát hành hóa đơn điện tử: không bỏ ghi sổ, đảo, hủy, xóa (trừ luồng thay thế/hủy hóa đơn đặt app.einvoice_reversal).
CREATE FUNCTION fn_voucher_einvoice_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_no text; v_found boolean;
BEGIN
  IF current_setting('app.einvoice_reversal', true) = 'on' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT true, coalesce(invoice_no, '(chưa có số)') INTO v_found, v_no FROM einvoice WHERE tenant_id = OLD.tenant_id AND voucher_id = OLD.id AND status <> 'failed' LIMIT 1;
  ELSIF OLD.state = 'posted' AND NEW.state <> 'posted' THEN
    SELECT true, coalesce(invoice_no, '(chưa có số)') INTO v_found, v_no FROM einvoice WHERE tenant_id = OLD.tenant_id AND voucher_id = OLD.id AND status IN ('sending', 'issued') LIMIT 1;
  END IF;
  IF v_found THEN RAISE EXCEPTION 'EINVOICE_ISSUED: chứng từ đã phát hành hóa đơn điện tử số %; lập hóa đơn điều chỉnh/thay thế hoặc hủy hóa đơn', v_no USING ERRCODE = 'P0001'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
-- Tên bắt đầu "trg_voucher_a_" để chạy trước trg_voucher_before, trg_voucher_delete: EINVOICE_ISSUED là lý do được báo.
CREATE TRIGGER trg_voucher_a_einvoice_lock BEFORE UPDATE OF state ON voucher FOR EACH ROW EXECUTE FUNCTION fn_voucher_einvoice_lock();
CREATE TRIGGER trg_voucher_a_einvoice_lock_del BEFORE DELETE ON voucher FOR EACH ROW EXECUTE FUNCTION fn_voucher_einvoice_lock();
