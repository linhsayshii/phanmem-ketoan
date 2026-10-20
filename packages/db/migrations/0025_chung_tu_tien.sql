-- GĐ2 Task 4: loại chứng từ tiền, công nợ, hóa đơn; cột tiêu đề chứng từ và tài khoản ngân hàng trên dòng; chứng từ hệ thống GĐ2 không bỏ ghi sổ/hủy tay; siết tỷ giá dòng ngoại tệ.
-- Thân hàm lấy từ định nghĩa hiện hành (pg_get_functiondef) sau 0024, chỉ thêm các đoạn ghi chú bên dưới. Hàm vẫn chạy quyền người gọi.

-- 1) Loại chứng từ: thân seed_voucher_types hiện hành (PKT, DK, KC, PB) + 15 loại GĐ2. "is_system" nghĩa là loại do hệ thống định nghĩa (không xóa); lập tay hay không do SYSTEM_VOUCHER_TYPES ở packages/domain quyết định.
-- Ủy nhiệm chi là mẫu in của BN, không phải loại riêng.
CREATE OR REPLACE FUNCTION seed_voucher_types(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO voucher_type(tenant_id, code, name, module, prefix, is_system) VALUES
    (p_tenant, 'PKT', 'Phiếu kế toán', 'general', 'PKT', true),
    (p_tenant, 'DK', 'Số dư đầu kỳ', 'general', 'DK', true),
    (p_tenant, 'KC', 'Chứng từ kết chuyển', 'general', 'KC', true),
    (p_tenant, 'PB', 'Chứng từ phân bổ', 'general', 'PB', true),
    (p_tenant, 'PT', 'Phiếu thu', 'cash', 'PT', true),
    (p_tenant, 'PC', 'Phiếu chi', 'cash', 'PC', true),
    (p_tenant, 'BC', 'Giấy báo Có', 'bank', 'BC', true),
    (p_tenant, 'BN', 'Giấy báo Nợ (in Ủy nhiệm chi)', 'bank', 'BN', true),
    (p_tenant, 'CT', 'Chuyển tiền nội bộ', 'bank', 'CT', true),
    (p_tenant, 'QTU', 'Quyết toán tạm ứng', 'general', 'QTU', true),
    (p_tenant, 'BT', 'Bù trừ công nợ', 'arap', 'BT', true),
    (p_tenant, 'HDB', 'Hóa đơn bán dịch vụ', 'arap', 'HDB', true),
    (p_tenant, 'HDM', 'Hóa đơn mua dịch vụ', 'arap', 'HDM', true),
    (p_tenant, 'GGB', 'Giảm giá, trả lại dịch vụ bán', 'arap', 'GGB', true),
    (p_tenant, 'GGM', 'Giảm giá, trả lại dịch vụ mua', 'arap', 'GGM', true),
    (p_tenant, 'CL', 'Chênh lệch tỷ giá đối trừ', 'arap', 'CL', true),
    (p_tenant, 'DG', 'Đánh giá lại ngoại tệ', 'general', 'DG', true),
    (p_tenant, 'XQ', 'Điều chỉnh tỷ giá xuất quỹ', 'general', 'XQ', true),
    (p_tenant, 'KTT', 'Khấu trừ thuế GTGT', 'general', 'KTT', true)
  ON CONFLICT DO NOTHING;
$$;
-- Công ty đã có: bổ sung loại mới. Tắt audit để migration không ghi nhật ký không có người dùng (như 0004).
ALTER TABLE voucher_type DISABLE TRIGGER trg_audit;
SELECT seed_voucher_types(id) FROM tenant;
ALTER TABLE voucher_type ENABLE TRIGGER trg_audit;

-- 2) Cột tiêu đề chứng từ. fn_voucher_before khóa các cột này sau ghi sổ (so to_jsonb trừ description); fn_voucher_canonical không đổi (định dạng hash đóng băng).
ALTER TABLE bank_account ADD CONSTRAINT bank_account_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE party_bank_account ADD CONSTRAINT party_bank_account_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE voucher
  ADD COLUMN person_name text, ADD COLUMN person_address text, ADD COLUMN attachments_count int CHECK (attachments_count >= 0),
  ADD COLUMN bank_account_id bigint, ADD COLUMN counter_bank_account_id bigint, ADD COLUMN party_bank_account_id uuid,
  ADD COLUMN due_date date, ADD COLUMN purpose text,
  ADD FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_account(tenant_id, id),
  ADD FOREIGN KEY (tenant_id, counter_bank_account_id) REFERENCES bank_account(tenant_id, id),
  ADD FOREIGN KEY (tenant_id, party_bank_account_id) REFERENCES party_bank_account(tenant_id, id);
-- Dòng chứng từ ghi tài khoản ngân hàng (sổ tiền gửi theo từng tài khoản); khai báo trên bảng gốc, các partition kế thừa.
ALTER TABLE voucher_line ADD COLUMN bank_account_id bigint,
  ADD FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_account(tenant_id, id);

-- 3) reverse_voucher: thân hiện hành, dòng đảo chép thêm bank_account_id.
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
  INSERT INTO voucher(id, tenant_id, voucher_type, posting_date, document_date, description, party_id, currency_code, fx_rate, source_doc_type, source_doc_id, reversal_of_id, is_closing, created_by)
  VALUES (v_new, v.tenant_id, v.voucher_type, p_date, p_date, coalesce(p_description, 'Đảo chứng từ ' || v.voucher_no || ' ngày ' || to_char(v.posting_date, 'DD/MM/YYYY')),
          v.party_id, v.currency_code, v.fx_rate, v.source_doc_type, v.source_doc_id, p_id, v.is_closing, app_user_id());
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

-- 4) unpost_voucher, discard_voucher: thân hiện hành, thêm các source_doc_type do hệ thống sinh ở GĐ2 (đối trừ chênh lệch tỷ giá, đánh giá lại, tỷ giá xuất quỹ, khấu trừ thuế GTGT, phân bổ) cùng mã lỗi VOUCHER_SYSTEM_GENERATED.
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
  INSERT INTO voucher_line_history(tenant_id, voucher_id, version, header, lines, archived_by)
    SELECT v.tenant_id, p_id, v.version, to_jsonb(v), coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.line_no), '[]'), app_user_id() FROM voucher_line l WHERE l.voucher_id = p_id;
  PERFORM set_config('app.state_change', 'on', true); PERFORM set_config('app.unposting', 'on', true);
  UPDATE voucher SET state = 'draft', posted_by = NULL, posted_at = NULL WHERE id = p_id;
  DELETE FROM voucher_pair WHERE voucher_id = p_id;
  PERFORM set_config('app.state_change', 'off', true); PERFORM set_config('app.unposting', 'off', true);
  PERFORM mark_balance_stale(v.tenant_id, p.fiscal_year, p.period_no);
  PERFORM fn_audit_voucher(v.tenant_id, 'unpost', p_id, jsonb_build_object('voucher_no', v.voucher_no));
END $function$;

CREATE OR REPLACE FUNCTION discard_voucher(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.source_doc_type = 'closing_step' THEN RAISE EXCEPTION 'VOUCHER_SYSTEM_GENERATED: Chứng từ do hệ thống sinh (kết chuyển/phân bổ); dùng Chạy lại (đảo cũ) ở màn hình Kết chuyển' USING ERRCODE = 'P0001'; END IF;
  IF v.source_doc_type IN ('settlement_fx', 'fx_revaluation', 'fx_outflow', 'vat_offset', 'amortization') THEN
    RAISE EXCEPTION 'VOUCHER_SYSTEM_GENERATED: Chứng từ do hệ thống sinh (chênh lệch tỷ giá, đánh giá lại, tỷ giá xuất quỹ, khấu trừ thuế GTGT, phân bổ); thao tác ở chức năng đã sinh ra chứng từ' USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'draft' THEN RAISE EXCEPTION 'STATE_INVALID: chỉ hủy được chứng từ nháp (hiện tại: %)', v.state USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'cancelled' WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_audit_voucher(v.tenant_id, 'discard', p_id, jsonb_build_object('voucher_no', v.voucher_no));
END $function$;

-- 5) fn_line_before: thân hiện hành + kiểm tra dòng ngoại tệ (quyết định T19). fn_check_voucher_balance không đổi: chứng từ một ngoại tệ vẫn cân theo nguyên tệ.
CREATE OR REPLACE FUNCTION fn_line_before()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
  -- Dòng ngoại tệ: chỉ kiểm khi thêm dòng hoặc đổi tiền tệ, nguyên tệ, tỷ giá, số tiền; sửa diễn giải dòng cũ không bị kiểm lại.
  IF NEW.currency_code <> 'VND' AND (TG_OP = 'INSERT' OR (NEW.currency_code, NEW.amount_currency, NEW.fx_rate, NEW.debit, NEW.credit) IS DISTINCT FROM (OLD.currency_code, OLD.amount_currency, OLD.fx_rate, OLD.debit, OLD.credit)) THEN
    IF NEW.fx_rate IS NOT NULL THEN
      IF abs(round(NEW.amount_currency * NEW.fx_rate) - (NEW.debit - NEW.credit)) > 1 THEN
        RAISE EXCEPTION 'LINE_FX_MISMATCH: dòng % nguyên tệ % × tỷ giá % khác số tiền VND %', NEW.line_no, NEW.amount_currency, NEW.fx_rate, NEW.debit - NEW.credit USING ERRCODE = 'P0001'; END IF;
    -- Dòng điều chỉnh chỉ VND (nguyên tệ = 0: chênh lệch tỷ giá, đánh giá lại, tỷ giá xuất quỹ) và số dư đầu kỳ (DK) không cần tỷ giá.
    ELSIF NEW.amount_currency <> 0 AND v.voucher_type <> 'DK' THEN
      RAISE EXCEPTION 'LINE_FX_RATE_REQUIRED: dòng % ngoại tệ % phải có tỷ giá', NEW.line_no, NEW.currency_code USING ERRCODE = 'P0001'; END IF;
  END IF;
  RETURN NEW;
END $function$;
