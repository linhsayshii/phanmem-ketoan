-- GĐ6 Task 5b (đính chính D3): đối tượng tập hợp chi phí và chiều cost_object_id trên dòng sổ cái.
-- Mỗi đối tượng tham chiếu đúng một danh mục theo loại: sản phẩm (item), vụ việc/công trình (project), đơn hàng bán (doc_order), hợp đồng (contract).
CREATE TABLE cost_object (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('product','project','order','contract')),
  item_id bigint, project_id bigint, order_id uuid, contract_id bigint,
  method text CHECK (method IN ('simple','coefficient','ratio','project','order')),
  unit text,
  is_active boolean NOT NULL DEFAULT true,
  CHECK ((kind = 'product') = (item_id IS NOT NULL) AND (kind = 'project') = (project_id IS NOT NULL)
     AND (kind = 'order') = (order_id IS NOT NULL) AND (kind = 'contract') = (contract_id IS NOT NULL)),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES project (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES doc_order (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contract (tenant_id, id));
SELECT rls_enable('cost_object'); SELECT audit_enable('cost_object');

-- Cột mới rỗng trên bảng phân vùng: thêm cột không mặc định chỉ đổi danh mục; khóa ngoại kiểm hết các phân vùng nhưng mọi giá trị đang NULL nên nhanh.
-- Không ON DELETE: như các chiều khác, đối tượng đã dùng trên dòng sổ cái không xóa được (23503 → 409 REFERENCED).
ALTER TABLE voucher_line ADD COLUMN cost_object_id bigint;
ALTER TABLE voucher_line ADD FOREIGN KEY (tenant_id, cost_object_id) REFERENCES cost_object (tenant_id, id);
CREATE INDEX voucher_line_cost_object ON voucher_line (tenant_id, cost_object_id, posting_date) WHERE cost_object_id IS NOT NULL;

-- Dòng đã ghi sổ: cost_object_id sửa được như các chiều phân tích khác (D3). Thân từ pg_get_functiondef sau 0096.
CREATE OR REPLACE FUNCTION public.fn_line_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; v_status text;
BEGIN
  IF current_setting('app.unposting', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT * INTO v FROM voucher WHERE id = OLD.voucher_id;
  IF v.state IN ('posted','reversed','cancelled') THEN
    SELECT p.status INTO v_status FROM fiscal_period p WHERE p.tenant_id = v.tenant_id AND p.fiscal_year = v.fiscal_year AND p.period_no = v.period_no FOR SHARE;
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'LINE_IMMUTABLE: không xóa dòng của chứng từ đã ghi sổ' USING ERRCODE = 'P0001'; END IF;
    IF v_status = 'hard_locked' THEN RAISE EXCEPTION 'PERIOD_HARD_LOCKED: kỳ đã khóa cứng' USING ERRCODE = 'P0001'; END IF;
    -- 'balance' là cột sinh (debit - credit): trong trigger BEFORE, NEW.balance còn NULL nên bỏ ra khi so sánh (debit/credit đã được so sánh) và tính lại khi ghi nhật ký.
    IF (to_jsonb(NEW) - 'balance' - 'description' - 'due_date' - 'cash_flow_code' - 'department_id' - 'project_id' - 'cost_item_id' - 'employee_id' - 'cost_object_id' - 'extra_dims')
       IS DISTINCT FROM (to_jsonb(OLD) - 'balance' - 'description' - 'due_date' - 'cash_flow_code' - 'department_id' - 'project_id' - 'cost_item_id' - 'employee_id' - 'cost_object_id' - 'extra_dims') THEN
      RAISE EXCEPTION 'LINE_IMMUTABLE: dòng đã ghi sổ chỉ sửa được diễn giải và chiều phân tích; dùng Bỏ ghi sổ hoặc Đảo' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, after, ip)
      VALUES (OLD.tenant_id, app_user_id(), 'update', 'voucher_line', OLD.id::text, to_jsonb(OLD), to_jsonb(NEW) || jsonb_build_object('balance', NEW.debit - NEW.credit), nullif(current_setting('app.client_ip', true), ''));
  END IF;
  RETURN COALESCE(NEW, OLD);
END $function$;

-- TK 154 (chi phí SXKD dở dang, sổ chi tiết loại inventory ở cả ba chế độ) nhận dòng theo đối tượng tập hợp chi phí hoặc vụ việc thay cho vật tư (D3).
-- TK kho khác (152, 155, 156...) vẫn bắt buộc có vật tư. Thân từ pg_get_functiondef sau 0096.
CREATE OR REPLACE FUNCTION public.fn_line_before()
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
    IF a.subledger_kind = 'inventory' AND NEW.item_id IS NULL AND NOT (a.code LIKE '154%' AND (NEW.cost_object_id IS NOT NULL OR NEW.project_id IS NOT NULL)) THEN
      RAISE EXCEPTION 'LINE_ITEM_REQUIRED: tài khoản % phải có vật tư%', a.code, CASE WHEN a.code LIKE '154%' THEN ', đối tượng tập hợp chi phí hoặc vụ việc' ELSE '' END USING ERRCODE = 'P0001'; END IF;
    IF a.subledger_kind = 'fixed_asset' AND NEW.asset_id IS NULL THEN RAISE EXCEPTION 'LINE_ASSET_REQUIRED: tài khoản % phải có tài sản', a.code USING ERRCODE = 'P0001'; END IF;
  -- Sửa chiều (kể cả sau ghi sổ) không được bỏ trống cả đối tượng tập hợp chi phí lẫn vụ việc của dòng 154 không có vật tư; không kiểm lại tài khoản khác.
  ELSIF NEW.item_id IS NULL AND NEW.cost_object_id IS NULL AND NEW.project_id IS NULL AND (OLD.cost_object_id IS NOT NULL OR OLD.project_id IS NOT NULL) THEN
    SELECT * INTO a FROM account WHERE id = NEW.account_id;
    IF a.subledger_kind = 'inventory' THEN
      RAISE EXCEPTION 'LINE_ITEM_REQUIRED: tài khoản % phải có vật tư, đối tượng tập hợp chi phí hoặc vụ việc', a.code USING ERRCODE = 'P0001'; END IF;
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

-- Đảo chứng từ mang theo cost_object_id của dòng. Thân từ pg_get_functiondef sau 0096, chỉ thêm cột cost_object_id.
CREATE OR REPLACE FUNCTION public.reverse_voucher(p_id uuid, p_date date, p_description text)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; v_new uuid := gen_random_uuid(); v_by text;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'posted' THEN RAISE EXCEPTION 'STATE_INVALID: chỉ đảo được chứng từ đang ghi sổ (hiện tại: %)', v.state USING ERRCODE = 'P0001'; END IF;
  IF p_date < v.posting_date THEN RAISE EXCEPTION 'REVERSE_DATE_BEFORE_ORIGINAL: ngày đảo % trước ngày chứng từ gốc %', p_date, v.posting_date USING ERRCODE = 'P0001'; END IF;
  -- công nợ: như bỏ ghi sổ, trừ đối trừ kiểu 'reversal' (khoản của một bản đảo đã đối trừ hết với chứng từ gốc; đảo lại bản đảo vẫn được)
  IF EXISTS (SELECT 1 FROM open_item o JOIN settlement s ON s.tenant_id = o.tenant_id AND (s.debit_item_id = o.id OR s.credit_item_id = o.id) WHERE o.voucher_id = p_id AND s.kind <> 'reversal') THEN
    RAISE EXCEPTION 'OPEN_ITEM_SETTLED: chứng từ đã đối trừ công nợ, hãy hủy đối trừ trước' USING ERRCODE = 'P0001'; END IF;
  -- đối trừ: như bỏ ghi sổ, khoản đang được chứng từ nháp chọn để đối trừ (đảo sẽ đối trừ hết khoản gốc, nháp ghi sổ sau sẽ lỗi khó hiểu)
  SELECT coalesce(d.voucher_no, d.voucher_type || ' ngày ' || to_char(d.posting_date, 'DD/MM/YYYY')) INTO v_by
    FROM open_item o JOIN settlement_plan sp ON sp.tenant_id = o.tenant_id AND sp.open_item_id = o.id JOIN voucher d ON d.id = sp.voucher_id
    WHERE o.voucher_id = p_id ORDER BY d.posting_date, d.id LIMIT 1;
  IF v_by IS NOT NULL THEN
    RAISE EXCEPTION 'OPEN_ITEM_PLANNED: khoản công nợ của chứng từ đang được chọn đối trừ ở chứng từ nháp %, hãy bỏ chọn ở chứng từ đó trước', v_by USING ERRCODE = 'P0001'; END IF;
  INSERT INTO voucher(id, tenant_id, voucher_type, posting_date, document_date, description, party_id, currency_code, fx_rate, source_doc_type, source_doc_id, reversal_of_id, is_closing, created_by,
                      person_name, person_address, attachments_count, bank_account_id, counter_bank_account_id, party_bank_account_id, due_date, purpose, stock_kind, day_order)
  VALUES (v_new, v.tenant_id, v.voucher_type, p_date, p_date, coalesce(p_description, 'Đảo chứng từ ' || v.voucher_no || ' ngày ' || to_char(v.posting_date, 'DD/MM/YYYY')),
          v.party_id, v.currency_code, v.fx_rate, v.source_doc_type, v.source_doc_id, p_id, v.is_closing, app_user_id(),
          v.person_name, v.person_address, v.attachments_count, v.bank_account_id, v.counter_bank_account_id, v.party_bank_account_id, v.due_date, v.purpose, v.stock_kind, v.day_order);
  INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, currency_code, fx_rate, amount_currency, debit, credit,
                           party_id, item_id, warehouse_id, department_id, project_id, cost_item_id, contract_id, employee_id, asset_id, cost_object_id, extra_dims, description, due_date, bank_account_id, cash_flow_code)
  SELECT tenant_id, v_new, line_no, account_id, p_date, currency_code, fx_rate, -amount_currency, credit, debit,
         party_id, item_id, warehouse_id, department_id, project_id, cost_item_id, contract_id, employee_id, asset_id, cost_object_id, extra_dims, description, due_date, bank_account_id, cash_flow_code
  FROM voucher_line WHERE voucher_id = p_id ORDER BY line_no;
  -- kho: dòng hàng có kho sao chép đảo chiều (chuyển kho đổi kho đi/đến), tài khoản nợ/có đổi chỗ; source_line_id trỏ dòng gốc
  INSERT INTO voucher_item_line(tenant_id, voucher_id, line_no, description, item_id, uom_id, quantity, unit_price, amount_currency, amount, discount_rate, discount_amount_currency, discount_amount, tax_codes, tax_amount, account_id, department_id, project_id, cost_item_id, uom_factor, base_quantity, lot_no, mfg_date, expiry_date, unit_cost, fixed_cost, warehouse_id, dest_warehouse_id, direction, debit_account_id, credit_account_id, source_line_id, asset_id)
  SELECT tenant_id, v_new, line_no, description, item_id, uom_id, quantity, unit_price, amount_currency, amount, discount_rate, discount_amount_currency, discount_amount, tax_codes, tax_amount, account_id, department_id, project_id, cost_item_id, uom_factor, base_quantity, lot_no, mfg_date, expiry_date, unit_cost, fixed_cost,
         CASE WHEN dest_warehouse_id IS NOT NULL THEN dest_warehouse_id ELSE warehouse_id END, CASE WHEN dest_warehouse_id IS NOT NULL THEN warehouse_id END,
         CASE direction WHEN 'in' THEN 'out' WHEN 'out' THEN 'in' END, credit_account_id, debit_account_id, id, asset_id
  FROM voucher_item_line WHERE voucher_id = p_id AND warehouse_id IS NOT NULL ORDER BY line_no;
  PERFORM post_voucher(v_new);
  PERFORM fn_open_items_settle_reversal(p_id, v_new); -- công nợ: khoản gốc và khoản đảo tự đối trừ
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'reversed', reversed_by_id = v_new WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_audit_voucher(v.tenant_id, 'reverse', p_id, jsonb_build_object('reversed_by', v_new, 'date', p_date));
  RETURN v_new;
END $function$

;
