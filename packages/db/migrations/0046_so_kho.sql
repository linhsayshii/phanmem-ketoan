-- GĐ3 Task 5: sổ kho. stock_move bất biến, lớp giá, gán giá, lần chạy giá vốn; sinh/xóa move trong post_voucher/unpost_voucher/reverse_voucher.
ALTER TABLE voucher
  ADD COLUMN day_order int NOT NULL DEFAULT 0,
  ADD COLUMN stock_kind text CHECK (stock_kind IN ('purchase','finished','return_in','transfer_in','processing_in','consign_in','other_in',
    'sale','production','use','return_out','gift','destroy','processing_out','consign_out','other_out','transfer','assembly','disassembly','stocktake'));

ALTER TABLE voucher_item_line
  ADD COLUMN warehouse_id bigint, ADD COLUMN dest_warehouse_id bigint,
  ADD COLUMN uom_factor numeric(20,6) NOT NULL DEFAULT 1 CHECK (uom_factor > 0),
  ADD COLUMN base_quantity numeric(20,4),
  ADD COLUMN lot_no text, ADD COLUMN mfg_date date, ADD COLUMN expiry_date date,
  ADD COLUMN direction text CHECK (direction IN ('in','out')),
  ADD COLUMN debit_account_id bigint, ADD COLUMN credit_account_id bigint,
  ADD COLUMN unit_cost numeric(20,4), ADD COLUMN source_line_id bigint,
  ADD COLUMN fixed_cost boolean NOT NULL DEFAULT false,
  ADD UNIQUE (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, dest_warehouse_id) REFERENCES warehouse (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, debit_account_id) REFERENCES account (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, credit_account_id) REFERENCES account (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, source_line_id) REFERENCES voucher_item_line (tenant_id, id) ON DELETE SET NULL (source_line_id);
CREATE INDEX voucher_item_line_wh ON voucher_item_line (tenant_id, warehouse_id) WHERE warehouse_id IS NOT NULL;

CREATE TABLE stock_move (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  voucher_id uuid NOT NULL, item_line_id bigint NOT NULL,
  item_id bigint NOT NULL, warehouse_id bigint NOT NULL,
  posting_date date NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY, -- thứ tự ghi; thứ tự trong ngày do động cơ giá vốn sắp theo (ngày, day_order, voucher.seq_no, line_no)
  direction text NOT NULL CHECK (direction IN ('in','out')),
  quantity numeric(20,4) NOT NULL CHECK (quantity > 0), -- theo ĐVT cơ sở
  lot_no text, expiry_date date,
  transfer_id uuid, reversal_of bigint,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id),
  FOREIGN KEY (tenant_id, item_line_id) REFERENCES voucher_item_line (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id),
  FOREIGN KEY (tenant_id, reversal_of) REFERENCES stock_move (tenant_id, id));
CREATE INDEX stock_move_item_wh ON stock_move (tenant_id, item_id, warehouse_id, posting_date);
CREATE INDEX stock_move_voucher ON stock_move (tenant_id, voucher_id);

-- kind 'deficit': lớp âm do xuất thiếu (động cơ giá vốn), move_id trỏ move xuất gây ra; còn lại có thể âm.
CREATE TABLE stock_cost_layer (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  move_id bigint NOT NULL, item_id bigint NOT NULL, warehouse_id bigint NOT NULL, lot_no text,
  kind text NOT NULL CHECK (kind IN ('receipt','adjustment','deficit')),
  posting_date date NOT NULL,
  qty numeric(20,4) NOT NULL, unit_cost numeric(20,4) NOT NULL, value numeric(20,0) NOT NULL,
  remaining_qty numeric(20,4) NOT NULL, remaining_value numeric(20,0) NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, move_id) REFERENCES stock_move (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id));
CREATE INDEX stock_cost_layer_item_wh ON stock_cost_layer (tenant_id, item_id, warehouse_id, posting_date);
CREATE INDEX stock_cost_layer_move ON stock_cost_layer (tenant_id, move_id);

CREATE TABLE costing_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  period_from date NOT NULL, period_to date NOT NULL, method text NOT NULL,
  warehouse_id bigint, item_id bigint,
  status text NOT NULL CHECK (status IN ('done','failed')),
  voucher_ids uuid[] NOT NULL DEFAULT '{}',
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  summary jsonb,
  UNIQUE (tenant_id, id),
  CHECK (period_from <= period_to),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id));

CREATE TABLE stock_cost_assignment (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  run_id uuid NOT NULL, move_id bigint NOT NULL,
  unit_cost numeric(20,4) NOT NULL, amount numeric(20,0) NOT NULL, lot_no text,
  is_current boolean NOT NULL DEFAULT true,
  FOREIGN KEY (tenant_id, run_id) REFERENCES costing_run (tenant_id, id),
  FOREIGN KEY (tenant_id, move_id) REFERENCES stock_move (tenant_id, id) ON DELETE CASCADE);
CREATE INDEX stock_cost_assignment_cur ON stock_cost_assignment (tenant_id, move_id) WHERE is_current;

SELECT rls_enable(t) FROM unnest(ARRAY['stock_move','stock_cost_layer','costing_run','stock_cost_assignment']::regclass[]) AS t;
SELECT audit_enable('costing_run'::regclass);

-- stock_move bất biến: sửa chỉ qua máy trạng thái (app.state_change), xóa chỉ khi bỏ ghi sổ (app.unposting).
CREATE OR REPLACE FUNCTION fn_stock_move_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('app.state_change', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'STOCK_MOVE_IMMUTABLE: Phát sinh kho đã ghi sổ không sửa được' USING ERRCODE = 'P0001'; END IF;
  IF TG_OP = 'DELETE' AND current_setting('app.unposting', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'STOCK_MOVE_IMMUTABLE: Phát sinh kho chỉ xóa được khi bỏ ghi sổ chứng từ' USING ERRCODE = 'P0001'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_stock_move_immutable BEFORE UPDATE OR DELETE ON stock_move FOR EACH ROW EXECUTE FUNCTION fn_stock_move_immutable();

-- Hàng đã phát sinh (thêm stock_move) và khóa hệ số quy đổi ĐVT của hàng đã phát sinh.
CREATE OR REPLACE FUNCTION fn_item_in_use(p_item bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM voucher_line WHERE tenant_id = app_tenant() AND item_id = p_item)
      OR EXISTS (SELECT 1 FROM voucher_item_line WHERE tenant_id = app_tenant() AND item_id = p_item)
      OR EXISTS (SELECT 1 FROM stock_move WHERE tenant_id = app_tenant() AND item_id = p_item) $$;

CREATE OR REPLACE FUNCTION fn_item_uom_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_base bigint;
BEGIN
  SELECT base_uom_id INTO v_base FROM item WHERE tenant_id = OLD.tenant_id AND id = OLD.item_id;
  IF v_base IS NULL THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF; -- hàng đã mất (xóa dây chuyền)
  IF OLD.uom_id <> v_base THEN
    IF fn_item_in_use(OLD.item_id) AND (TG_OP = 'DELETE' OR NEW.factor <> OLD.factor OR NEW.uom_id <> OLD.uom_id) THEN
      RAISE EXCEPTION 'ITEM_UOM_LOCKED: Hàng đã phát sinh, không sửa hệ số quy đổi hay xóa đơn vị tính quy đổi' USING ERRCODE = 'P0001'; END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ITEM_UOM_BASE: Không xóa được đơn vị tính cơ sở của hàng'; END IF;
  IF NEW.uom_id <> OLD.uom_id OR NEW.factor <> 1 THEN RAISE EXCEPTION 'ITEM_UOM_BASE: Đơn vị tính cơ sở luôn có hệ số quy đổi 1'; END IF;
  RETURN NEW;
END $$;

-- Giá tạm tính: bình quân các lớp còn lại đến ngày; tồn không dương thì giá nhập gần nhất; chưa nhập bao giờ thì 0.
CREATE OR REPLACE FUNCTION fn_stock_estimate_cost(p_item bigint, p_wh bigint, p_date date) RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE q numeric; val numeric; c numeric;
BEGIN
  SELECT coalesce(sum(remaining_qty), 0), coalesce(sum(remaining_value), 0) INTO q, val FROM stock_cost_layer
    WHERE tenant_id = app_tenant() AND item_id = p_item AND warehouse_id = p_wh AND posting_date <= p_date;
  IF q > 0 THEN RETURN round(val / q, 4); END IF;
  SELECT unit_cost INTO c FROM stock_cost_layer
    WHERE tenant_id = app_tenant() AND item_id = p_item AND warehouse_id = p_wh AND posting_date <= p_date AND kind = 'receipt'
    ORDER BY posting_date DESC, id DESC LIMIT 1;
  RETURN coalesce(c, 0);
END $$;

-- Khóa (hàng, kho) của chứng từ theo thứ tự băm tăng dần để hai phiên không bế tắc.
CREATE OR REPLACE FUNCTION fn_stock_lock_keys(p_keys bigint[][]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE i int;
BEGIN
  FOR i IN 1 .. coalesce(array_length(p_keys, 1), 0) LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(app_tenant()::text || ':' || p_keys[i][1] || ':' || p_keys[i][2], 0));
  END LOOP;
END $$;

-- Tồn lũy kế cuối ngày đầu tiên (từ p_from) âm; trả (ngày, số dư) hoặc không dòng.
CREATE OR REPLACE FUNCTION fn_stock_first_negative(p_item bigint, p_wh bigint, p_from date) RETURNS TABLE(d date, bal numeric) LANGUAGE sql STABLE AS $$
  SELECT c.posting_date, c.bal FROM (
    SELECT posting_date, sum(sum(CASE direction WHEN 'in' THEN quantity ELSE -quantity END)) OVER (ORDER BY posting_date) AS bal
    FROM stock_move WHERE tenant_id = app_tenant() AND item_id = p_item AND warehouse_id = p_wh GROUP BY posting_date) c
  WHERE c.posting_date >= p_from AND c.bal < 0 ORDER BY c.posting_date LIMIT 1 $$;

CREATE OR REPLACE FUNCTION fn_stock_moves_create(p_voucher uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v voucher; l record; m record; k record; v_q numeric; v_xfer uuid; v_est numeric; v_val numeric; v_mv bigint; v_rev bigint;
        v_neg text; n int := 0; v_keys bigint[][];
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  SELECT array_agg(ARRAY[x.item_id, x.wh] ORDER BY hashtextextended(v.tenant_id::text || ':' || x.item_id || ':' || x.wh, 0)) INTO v_keys FROM (
    SELECT DISTINCT il.item_id, w.wh FROM voucher_item_line il JOIN item i ON i.tenant_id = il.tenant_id AND i.id = il.item_id AND i.kind <> 'service'
      CROSS JOIN LATERAL (VALUES (il.warehouse_id), (il.dest_warehouse_id)) w(wh)
      WHERE il.voucher_id = p_voucher AND il.warehouse_id IS NOT NULL AND w.wh IS NOT NULL) x;
  IF v_keys IS NULL THEN RETURN 0; END IF;
  PERFORM fn_stock_lock_keys(v_keys);
  FOR l IN SELECT il.* FROM voucher_item_line il JOIN item i ON i.tenant_id = il.tenant_id AND i.id = il.item_id AND i.kind <> 'service'
           WHERE il.voucher_id = p_voucher AND il.warehouse_id IS NOT NULL ORDER BY il.line_no LOOP
    v_q := coalesce(l.base_quantity, l.quantity * l.uom_factor);
    IF v_q IS NULL OR v_q <= 0 THEN RAISE EXCEPTION 'STOCK_QUANTITY_INVALID: dòng % phải có số lượng lớn hơn 0', l.line_no USING ERRCODE = 'P0001'; END IF;
    IF l.dest_warehouse_id IS NULL AND l.direction IS NULL THEN RAISE EXCEPTION 'STOCK_DIRECTION_REQUIRED: dòng % chưa có chiều nhập/xuất', l.line_no USING ERRCODE = 'P0001'; END IF;
    v_xfer := CASE WHEN l.dest_warehouse_id IS NOT NULL THEN gen_random_uuid() END;
    v_est := CASE WHEN l.dest_warehouse_id IS NOT NULL THEN fn_stock_estimate_cost(l.item_id, l.warehouse_id, v.posting_date) END;
    FOR m IN SELECT * FROM (VALUES (l.warehouse_id, CASE WHEN l.dest_warehouse_id IS NOT NULL THEN 'out' ELSE l.direction END),
                                   (l.dest_warehouse_id, 'in')) t(wh, dir) WHERE wh IS NOT NULL LOOP
      v_rev := NULL;
      IF l.source_line_id IS NOT NULL THEN
        SELECT id INTO v_rev FROM stock_move WHERE tenant_id = v.tenant_id AND item_line_id = l.source_line_id AND warehouse_id = m.wh AND direction <> m.dir ORDER BY id LIMIT 1;
      END IF;
      INSERT INTO stock_move(tenant_id, voucher_id, item_line_id, item_id, warehouse_id, posting_date, direction, quantity, lot_no, expiry_date, transfer_id, reversal_of)
      VALUES (v.tenant_id, p_voucher, l.id, l.item_id, m.wh, v.posting_date, m.dir, v_q, l.lot_no, l.expiry_date, v_xfer, v_rev) RETURNING id INTO v_mv;
      IF m.dir = 'in' THEN -- giá nhập: tiền dòng; chuyển kho đến lấy giá tạm tính của kho đi (giá gán thay sau khi chạy giá vốn)
        v_val := CASE WHEN v_xfer IS NOT NULL THEN round(v_q * v_est) ELSE round(l.amount) END;
        INSERT INTO stock_cost_layer(tenant_id, move_id, item_id, warehouse_id, lot_no, kind, posting_date, qty, unit_cost, value, remaining_qty, remaining_value)
        VALUES (v.tenant_id, v_mv, l.item_id, m.wh, l.lot_no, 'receipt', v.posting_date, v_q, round(v_val / v_q, 4), v_val, v_q, v_val);
      END IF;
      n := n + 1;
    END LOOP;
  END LOOP;
  -- tồn âm: kiểm tồn cuối ngày từ ngày chứng từ trở đi (nhập trước xuất trong ngày nên số dư cuối ngày là thấp nhất)
  SELECT coalesce((SELECT value #>> '{}' FROM tenant_setting WHERE tenant_id = v.tenant_id AND key = 'stock_negative'), 'forbid') INTO v_neg;
  IF v_neg <> 'allow' THEN
    FOR k IN SELECT item_id, warehouse_id FROM stock_move WHERE voucher_id = p_voucher AND direction = 'out' GROUP BY item_id, warehouse_id LOOP
      SELECT d, bal INTO m FROM fn_stock_first_negative(k.item_id, k.warehouse_id, v.posting_date);
      IF m.d IS NOT NULL THEN
        IF v_neg = 'forbid' THEN
          RAISE EXCEPTION 'STOCK_NEGATIVE: hàng % kho % ngày % thiếu %', (SELECT code FROM item WHERE id = k.item_id), (SELECT code FROM warehouse WHERE id = k.warehouse_id),
            to_char(m.d, 'DD/MM/YYYY'), trim_scale(-m.bal) USING ERRCODE = 'P0001';
        END IF;
        RAISE WARNING 'STOCK_NEGATIVE: hàng % kho % ngày % thiếu %', k.item_id, k.warehouse_id, to_char(m.d, 'DD/MM/YYYY'), trim_scale(-m.bal);
      END IF;
    END LOOP;
  END IF;
  RETURN n;
END $$;

-- Gọi trong unpost_voucher (đã bật app.unposting): xóa move và lớp giá; từ chối nếu phiếu nhập đã bị xuất.
CREATE OR REPLACE FUNCTION fn_stock_moves_remove(p_voucher uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE k record; v_keys bigint[][]; n int; v_neg text; r record; v_out text; v_rm jsonb;
BEGIN
  SELECT array_agg(ARRAY[x.item_id, x.warehouse_id] ORDER BY hashtextextended(app_tenant()::text || ':' || x.item_id || ':' || x.warehouse_id, 0)) INTO v_keys
    FROM (SELECT DISTINCT item_id, warehouse_id FROM stock_move WHERE voucher_id = p_voucher) x;
  IF v_keys IS NULL THEN RETURN 0; END IF;
  PERFORM fn_stock_lock_keys(v_keys);
  SELECT coalesce(jsonb_agg(jsonb_build_object('i', item_id, 'w', warehouse_id, 'd', d)), '[]') INTO v_rm
    FROM (SELECT item_id, warehouse_id, min(posting_date) d FROM stock_move WHERE voucher_id = p_voucher AND direction = 'in' GROUP BY item_id, warehouse_id) x;
  DELETE FROM stock_move WHERE voucher_id = p_voucher; -- lớp giá, gán giá đi theo (ON DELETE CASCADE)
  GET DIAGNOSTICS n = ROW_COUNT;
  SELECT coalesce((SELECT value #>> '{}' FROM tenant_setting WHERE tenant_id = app_tenant() AND key = 'stock_negative'), 'forbid') INTO v_neg;
  IF v_neg <> 'allow' THEN
    FOR k IN SELECT (e->>'i')::bigint AS item_id, (e->>'w')::bigint AS warehouse_id, (e->>'d')::date AS d FROM jsonb_array_elements(v_rm) e LOOP
      SELECT d, bal INTO r FROM fn_stock_first_negative(k.item_id, k.warehouse_id, k.d);
      IF r.d IS NOT NULL THEN
        SELECT coalesce(ov.voucher_no, ov.voucher_type) || ' ngày ' || to_char(ov.posting_date, 'DD/MM/YYYY') INTO v_out
          FROM stock_move sm JOIN voucher ov ON ov.id = sm.voucher_id
          WHERE sm.tenant_id = app_tenant() AND sm.item_id = k.item_id AND sm.warehouse_id = k.warehouse_id AND sm.direction = 'out' AND sm.posting_date >= k.d
          ORDER BY (sm.posting_date = r.d) DESC, sm.posting_date, sm.id LIMIT 1;
        RAISE EXCEPTION 'STOCK_CONSUMED: phiếu nhập đã được xuất ở chứng từ %', v_out USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END IF;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.post_voucher(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; vt voucher_type; p fiscal_period; v_seq bigint; v_no text; v_n int; v_plan settlement_plan[]; pl settlement_plan; v_item open_item;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'draft' THEN RAISE EXCEPTION 'STATE_INVALID: chứng từ đang ở trạng thái %, không ghi sổ được', v.state USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_n FROM voucher_line WHERE voucher_id = p_id AND posting_date = v.posting_date;
  IF v_n = 0 THEN RAISE EXCEPTION 'VOUCHER_EMPTY: chứng từ không có dòng' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO vt FROM voucher_type WHERE tenant_id = v.tenant_id AND code = v.voucher_type;
  p := fn_period_of(v.tenant_id, v.posting_date, v.voucher_type = 'DK');
  PERFORM fn_assert_period_writable(p, vt.module);
  IF v.voucher_no IS NULL THEN
    INSERT INTO voucher_counter(tenant_id, voucher_type, fiscal_year, last_no) VALUES (v.tenant_id, v.voucher_type, p.fiscal_year, 1)
      ON CONFLICT (tenant_id, voucher_type, fiscal_year) DO UPDATE SET last_no = voucher_counter.last_no + 1 RETURNING last_no INTO v_seq;
    v_no := fn_format_voucher_no(vt.prefix, vt.suffix, vt.pad_length, v_seq, p.fiscal_year);
  END IF;
  -- đối trừ: kế hoạch dùng một lần, đọc và xóa khi chứng từ còn nháp (fn_voucher_child_guard chặn sửa sau khi ghi sổ)
  SELECT coalesce(array_agg(s ORDER BY s.id), '{}') INTO v_plan FROM settlement_plan s WHERE s.voucher_id = p_id;
  IF cardinality(v_plan) > 0 THEN DELETE FROM settlement_plan WHERE voucher_id = p_id; END IF;
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'posted', voucher_no = coalesce(voucher_no, v_no), seq_no = coalesce(seq_no, v_seq), posted_by = app_user_id(), posted_at = now() WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_build_pairs(p_id);
  PERFORM fn_open_items_create(p_id); -- công nợ: khoản theo chứng từ cho dòng tài khoản công nợ
  PERFORM fn_stock_moves_create(p_id); -- kho: phát sinh nhập/xuất, lớp giá, kiểm tồn âm
  FOREACH pl IN ARRAY v_plan LOOP -- đối trừ theo kế hoạch
    SELECT * INTO v_item FROM open_item WHERE voucher_id = p_id AND line_no = pl.line_no;
    IF NOT FOUND THEN RAISE EXCEPTION 'SETTLEMENT_PLAN_LINE_INVALID: dòng % không phải dòng công nợ có đối tượng, không đối trừ được', pl.line_no USING ERRCODE = 'P0001'; END IF;
    IF v_item.amount > 0 OR (v_item.amount = 0 AND v_item.amount_currency > 0) THEN
      PERFORM settle_open_items(v_item.id, pl.open_item_id, pl.amount_currency, pl.amount, v.posting_date, 'plan', gen_random_uuid());
    ELSE
      PERFORM settle_open_items(pl.open_item_id, v_item.id, pl.amount_currency, pl.amount, v.posting_date, 'plan', gen_random_uuid());
    END IF;
  END LOOP;
  PERFORM mark_balance_stale(v.tenant_id, p.fiscal_year, p.period_no);
  PERFORM fn_audit_voucher(v.tenant_id, 'post', p_id, jsonb_build_object('voucher_no', coalesce(v.voucher_no, v_no), 'posting_date', v.posting_date));
END $function$;

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
  PERFORM fn_stock_moves_remove(p_id); -- kho: xóa phát sinh, từ chối nếu đã bị xuất
  PERFORM set_config('app.state_change', 'off', true); PERFORM set_config('app.unposting', 'off', true);
  PERFORM mark_balance_stale(v.tenant_id, p.fiscal_year, p.period_no);
  PERFORM fn_audit_voucher(v.tenant_id, 'unpost', p_id, jsonb_build_object('voucher_no', v.voucher_no));
END $function$;

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
                           party_id, item_id, warehouse_id, department_id, project_id, cost_item_id, contract_id, employee_id, asset_id, extra_dims, description, due_date, bank_account_id)
  SELECT tenant_id, v_new, line_no, account_id, p_date, currency_code, fx_rate, -amount_currency, credit, debit,
         party_id, item_id, warehouse_id, department_id, project_id, cost_item_id, contract_id, employee_id, asset_id, extra_dims, description, due_date, bank_account_id
  FROM voucher_line WHERE voucher_id = p_id ORDER BY line_no;
  -- kho: dòng hàng có kho sao chép đảo chiều (chuyển kho đổi kho đi/đến), tài khoản nợ/có đổi chỗ; source_line_id trỏ dòng gốc
  INSERT INTO voucher_item_line(tenant_id, voucher_id, line_no, description, item_id, uom_id, quantity, unit_price, amount_currency, amount, discount_rate, discount_amount_currency, discount_amount, tax_codes, tax_amount, account_id, department_id, project_id, cost_item_id, uom_factor, base_quantity, lot_no, mfg_date, expiry_date, unit_cost, fixed_cost, warehouse_id, dest_warehouse_id, direction, debit_account_id, credit_account_id, source_line_id)
  SELECT tenant_id, v_new, line_no, description, item_id, uom_id, quantity, unit_price, amount_currency, amount, discount_rate, discount_amount_currency, discount_amount, tax_codes, tax_amount, account_id, department_id, project_id, cost_item_id, uom_factor, base_quantity, lot_no, mfg_date, expiry_date, unit_cost, fixed_cost,
         CASE WHEN dest_warehouse_id IS NOT NULL THEN dest_warehouse_id ELSE warehouse_id END, CASE WHEN dest_warehouse_id IS NOT NULL THEN warehouse_id END,
         CASE direction WHEN 'in' THEN 'out' WHEN 'out' THEN 'in' END, credit_account_id, debit_account_id, id
  FROM voucher_item_line WHERE voucher_id = p_id AND warehouse_id IS NOT NULL ORDER BY line_no;
  PERFORM post_voucher(v_new);
  PERFORM fn_open_items_settle_reversal(p_id, v_new); -- công nợ: khoản gốc và khoản đảo tự đối trừ
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'reversed', reversed_by_id = v_new WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_audit_voucher(v.tenant_id, 'reverse', p_id, jsonb_build_object('reversed_by', v_new, 'date', p_date));
  RETURN v_new;
END $function$;
