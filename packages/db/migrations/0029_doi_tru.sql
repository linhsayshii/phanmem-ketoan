-- GĐ2 Task 12: đối trừ chứng từ công nợ (thủ công, tự động, theo kế hoạch gửi kèm chứng từ), hủy đối trừ, chênh lệch tỷ giá thực hiện (chứng từ CL).
-- Thân post_voucher, unpost_voucher, reverse_voucher, discard_voucher, renumber_vouchers, fn_open_items_create, fn_open_items_settle_reversal lấy từ định nghĩa hiện hành (pg_get_functiondef) sau 0028,
-- chỉ thêm các đoạn ghi chú "công nợ"/"đối trừ". Hàm vẫn chạy quyền người gọi.

-- 1) Quy tắc tỷ giá theo chế độ (packages/coa-data/data/tax/fx-rules.json), syncReferenceData nạp vào để hàm SQL đọc được tài khoản lãi/lỗ
-- (gainAccount/lossAccount) theo chế độ của kỳ. Bảng tham chiếu dùng chung như coa_template: không có tenant_id, người dùng ứng dụng chỉ đọc.
CREATE TABLE fx_rule (
  regime text PRIMARY KEY CHECK (regime IN ('TT99', 'TT133', 'TT200', 'TT58')),
  rules jsonb NOT NULL);
REVOKE INSERT, UPDATE, DELETE ON fx_rule FROM app_user;

-- 2) Sửa sau rà soát Task 11: chỉ sinh khoản cho chứng từ đã ghi sổ; đánh lại số cập nhật số chứng từ của khoản; đối trừ đảo chỉ cho đúng cặp gốc/đảo.
CREATE OR REPLACE FUNCTION fn_open_items_create(p_voucher uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; n int;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  IF v.state IS NULL OR v.state NOT IN ('posted', 'reversed') THEN RETURN 0; END IF; -- công nợ: chỉ chứng từ đã ghi sổ (hoặc đã bị đảo) mới có khoản
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
END $function$;

CREATE OR REPLACE FUNCTION fn_open_items_settle_reversal(p_orig uuid, p_rev uuid)
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
  RETURN n;
END $function$;

-- Đánh lại số chạy quyền người gọi: người dùng ứng dụng cần sửa được số chứng từ của khoản.
GRANT UPDATE (doc_no) ON open_item TO app_user;

CREATE OR REPLACE FUNCTION renumber_vouchers(p_tenant uuid, p_type text, p_year integer)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE vt voucher_type; n int; v_before jsonb;
BEGIN
  SELECT * INTO vt FROM voucher_type WHERE tenant_id = p_tenant AND code = p_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_TYPE_NOT_FOUND: %', p_type USING ERRCODE = 'P0001'; END IF;
  -- Khóa bộ đếm trước khi đọc chứng từ: post_voucher cùng loại/năm phải đợi tới khi đánh lại xong, nếu không số vừa cấp sẽ bị last_no = n ghi đè (trùng hoặc hụt số).
  INSERT INTO voucher_counter(tenant_id, voucher_type, fiscal_year, last_no) VALUES (p_tenant, p_type, p_year, 0) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM voucher_counter WHERE tenant_id = p_tenant AND voucher_type = p_type AND fiscal_year = p_year FOR UPDATE;
  -- Giữ FOR SHARE các hàng kỳ của năm trước khi kiểm tra: lock_period (FOR UPDATE) đang chạy song song thì đợi tới khi commit rồi mới thấy trạng thái khóa; khóa sau đó phải đợi đánh lại số xong.
  PERFORM 1 FROM fiscal_period WHERE tenant_id = p_tenant AND fiscal_year = p_year FOR SHARE;
  IF EXISTS (SELECT 1 FROM voucher v JOIN fiscal_period p ON p.tenant_id = v.tenant_id AND p.fiscal_year = v.fiscal_year AND p.period_no = v.period_no
             WHERE v.tenant_id = p_tenant AND v.voucher_type = p_type AND v.fiscal_year = p_year AND v.voucher_no IS NOT NULL AND (p.status <> 'open' OR vt.module = ANY (p.locked_modules))) THEN
    RAISE EXCEPTION 'RENUMBER_PERIOD_LOCKED: có kỳ đã khóa hoặc đã khóa phần hành trong năm, không đánh lại số được' USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'voucher_no', voucher_no) ORDER BY posting_date, created_at, id), '[]') INTO v_before
    FROM voucher WHERE tenant_id = p_tenant AND voucher_type = p_type AND fiscal_year = p_year AND voucher_no IS NOT NULL;
  PERFORM set_config('app.renumbering', 'on', true);
  -- Số tạm trước (UNIQUE kiểm tra từng hàng), rồi gán số cuối cùng một lượt.
  UPDATE voucher SET voucher_no = '~' || id::text WHERE tenant_id = p_tenant AND voucher_type = p_type AND fiscal_year = p_year AND voucher_no IS NOT NULL;
  UPDATE voucher v SET seq_no = x.rn, voucher_no = fn_format_voucher_no(vt.prefix, vt.suffix, vt.pad_length, x.rn, p_year)
    FROM (SELECT id, row_number() OVER (ORDER BY posting_date, created_at, id) AS rn FROM voucher
          WHERE tenant_id = p_tenant AND voucher_type = p_type AND fiscal_year = p_year AND voucher_no IS NOT NULL) x
    WHERE v.id = x.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('app.renumbering', 'off', true);
  -- công nợ: số chứng từ của khoản theo số mới (khoản của DK mang số chứng từ gốc nhập ở Số dư đầu kỳ, không theo số DK)
  UPDATE open_item o SET doc_no = v.voucher_no FROM voucher v WHERE o.voucher_id = v.id AND v.tenant_id = p_tenant AND v.voucher_type = p_type AND v.fiscal_year = p_year AND v.voucher_type <> 'DK';
  UPDATE voucher_counter SET last_no = n WHERE tenant_id = p_tenant AND voucher_type = p_type AND fiscal_year = p_year;
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, after, ip)
    VALUES (p_tenant, app_user_id(), 'renumber', 'voucher_type', p_type, v_before,
            jsonb_build_object('year', p_year, 'count', n, 'map', coalesce((SELECT jsonb_agg(jsonb_build_object('id', b.e->>'id', 'old', b.e->>'voucher_no', 'new', v.voucher_no) ORDER BY v.seq_no)
              FROM jsonb_array_elements(v_before) AS b(e) JOIN voucher v ON v.id = (b.e->>'id')::uuid), '[]')),
            nullif(current_setting('app.client_ip', true), ''));
  RETURN n;
END $function$;

-- 3) Dư còn lại của một khoản sau mọi lần đối trừ (không lọc ngày): mức kiểm "vượt dư" của lần đối trừ mới, vì đối trừ chỉ làm dư nhỏ dần.
CREATE OR REPLACE FUNCTION fn_open_item_residual(p_item bigint, OUT vnd numeric, OUT cur numeric) LANGUAGE sql STABLE AS $$
  SELECT o.amount - coalesce((SELECT sum(s.amount) FROM settlement s WHERE s.tenant_id = o.tenant_id AND s.debit_item_id = o.id), 0)
                  + coalesce((SELECT sum(s.amount) FROM settlement s WHERE s.tenant_id = o.tenant_id AND s.credit_item_id = o.id), 0),
         o.amount_currency - coalesce((SELECT sum(s.amount_currency) FROM settlement s WHERE s.tenant_id = o.tenant_id AND s.debit_item_id = o.id), 0)
                           + coalesce((SELECT sum(s.amount_currency) FROM settlement s WHERE s.tenant_id = o.tenant_id AND s.credit_item_id = o.id), 0)
  FROM open_item o WHERE o.id = p_item
$$;

-- Giống hệt proportionalVnd của @kt/domain (fx.ts): lấy hết nguyên tệ thì lấy đúng hết dư VND; ngược lại tỷ giá bình quân = VND / nguyên tệ làm tròn 10 chữ số,
-- rồi nguyên tệ × tỷ giá làm tròn về đồng (round của numeric: nửa xa số 0, như ROUND_HALF_UP của decimal.js). Phép chia lấy 30 chữ số lẻ trước khi làm tròn
-- (decimal.js tính 40 chữ số có nghĩa): mặc định của numeric chỉ khoảng 16 chữ số có nghĩa, làm tròn hai lần sẽ lệch domain.
CREATE OR REPLACE FUNCTION fn_proportional_vnd(p_vnd numeric, p_cur numeric, p_part numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_part = p_cur THEN round(p_vnd, 0) ELSE round(p_part * round(p_vnd::numeric(60, 30) / p_cur, 10), 0) END
$$;

-- 4) Bất biến của dòng đối trừ, không phụ thuộc mã gọi: hai khoản cùng công ty, tài khoản, đối tượng, loại tiền; khoản bên Nợ là phát sinh Nợ, bên Có là phát sinh Có;
-- không đối trừ trước ngày ghi sổ của khoản (fn_open_items_at lọc khoản theo ngày ghi sổ); khoản VND thì nguyên tệ bằng số tiền. Chạy quyền người gọi: RLS chỉ cho thấy khoản của công ty mình.
CREATE OR REPLACE FUNCTION fn_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d open_item; c open_item;
BEGIN
  SELECT * INTO d FROM open_item WHERE tenant_id = NEW.tenant_id AND id = NEW.debit_item_id;
  SELECT * INTO c FROM open_item WHERE tenant_id = NEW.tenant_id AND id = NEW.credit_item_id;
  IF d.id IS NULL OR c.id IS NULL OR (d.account_id, d.party_id, d.currency_code) IS DISTINCT FROM (c.account_id, c.party_id, c.currency_code) THEN
    RAISE EXCEPTION 'SETTLEMENT_MISMATCH: hai khoản đối trừ phải cùng tài khoản, đối tượng và loại tiền' USING ERRCODE = 'P0001'; END IF;
  IF NOT (d.amount > 0 OR (d.amount = 0 AND d.amount_currency > 0)) OR NOT (c.amount < 0 OR (c.amount = 0 AND c.amount_currency < 0)) THEN
    RAISE EXCEPTION 'SETTLEMENT_MISMATCH: khoản bên Nợ phải là phát sinh Nợ, khoản bên Có phải là phát sinh Có' USING ERRCODE = 'P0001'; END IF;
  IF NEW.settle_date < greatest(d.line_posting_date, c.line_posting_date) THEN
    RAISE EXCEPTION 'SETTLEMENT_DATE_BEFORE_POSTING: ngày đối trừ % trước ngày ghi sổ % của khoản', to_char(NEW.settle_date, 'DD/MM/YYYY'), to_char(greatest(d.line_posting_date, c.line_posting_date), 'DD/MM/YYYY') USING ERRCODE = 'P0001'; END IF;
  IF d.currency_code = 'VND' AND NEW.amount_currency <> NEW.amount THEN
    RAISE EXCEPTION 'SETTLEMENT_VND_CURRENCY: đối trừ khoản VND phải có số nguyên tệ bằng số tiền' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_settlement_guard BEFORE INSERT ON settlement FOR EACH ROW EXECUTE FUNCTION fn_settlement_guard();

-- 5) Kế hoạch đối trừ gửi kèm chứng từ nháp (thu/chi từ hóa đơn, bù trừ công nợ): dòng line_no của chứng từ đối trừ với khoản open_item_id khi ghi sổ,
-- rồi kế hoạch bị xóa. Là một phần nội dung chứng từ nháp như voucher_line (không audit riêng; đối trừ sinh ra có audit).
CREATE TABLE settlement_plan (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  voucher_id uuid NOT NULL,
  line_no int NOT NULL,
  open_item_id bigint NOT NULL,
  amount numeric(20,0),
  amount_currency numeric(20,4),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher(tenant_id, id) ON DELETE CASCADE, -- xóa nháp thì bỏ kế hoạch
  FOREIGN KEY (tenant_id, open_item_id) REFERENCES open_item(tenant_id, id));
CREATE INDEX settlement_plan_voucher ON settlement_plan (voucher_id);
CREATE INDEX settlement_plan_item ON settlement_plan (tenant_id, open_item_id);
SELECT rls_enable('settlement_plan');

-- Bảng con của chứng từ chỉ ghi được khi chứng từ còn nháp (dùng lại cho các bảng con khác). Chứng từ không còn thấy (đang bị xóa, xóa dây chuyền) thì cho qua.
CREATE OR REPLACE FUNCTION fn_voucher_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    SELECT state INTO v_state FROM voucher WHERE id = NEW.voucher_id;
    IF FOUND AND v_state <> 'draft' THEN RAISE EXCEPTION 'VOUCHER_POSTED_EDIT: chứng từ không còn là nháp (trạng thái %), không sửa được nội dung kèm theo', v_state USING ERRCODE = 'P0001'; END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT state INTO v_state FROM voucher WHERE id = OLD.voucher_id;
    IF FOUND AND v_state <> 'draft' THEN RAISE EXCEPTION 'VOUCHER_POSTED_EDIT: chứng từ không còn là nháp (trạng thái %), không sửa được nội dung kèm theo', v_state USING ERRCODE = 'P0001'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_settlement_plan_guard BEFORE INSERT OR UPDATE OR DELETE ON settlement_plan FOR EACH ROW EXECUTE FUNCTION fn_voucher_child_guard();

-- 6) Đối trừ khoản Nợ p_debit với khoản Có p_credit; trả id các dòng settlement tạo ra (cùng nhóm p_group).
-- Ngày đối trừ = muộn nhất của p_date, ngày chứng từ và ngày ghi sổ của hai khoản; kỳ của ngày đó phải ghi được (phần hành công nợ).
-- VND: đối trừ p_amount (bắt buộc), nguyên tệ = số tiền. Ngoại tệ: đối trừ q = p_amount_currency nguyên tệ; mỗi bên lấy ra giá trị VND tỷ lệ với dư nguyên tệ
-- (dư VND của khoản gốc cộng các khoản con điều chỉnh đánh giá lại, parent_id), khoản con đối trừ trước theo tỷ lệ q / dư nguyên tệ của khoản gốc.
-- Hai bên lệch nhau thì sinh chứng từ CL ngày đối trừ (lãi: Nợ TK công nợ / Có TK lãi; lỗ: Nợ TK lỗ / Có TK công nợ; tài khoản theo fx_rule của chế độ của kỳ),
-- khoản của dòng CL đối trừ ngay với phần VND còn dư (kiểu 'fx'). Sau đó mọi khoản có dư VND đúng tỷ lệ với dư nguyên tệ.
CREATE OR REPLACE FUNCTION settle_open_items(p_debit bigint, p_credit bigint, p_amount_currency numeric, p_amount numeric, p_date date, p_kind text, p_group uuid)
RETURNS bigint[] LANGUAGE plpgsql AS $$
DECLARE
  d open_item; c open_item; rd record; rc record; ch record; p fiscal_period; v_rules jsonb; v_acc bigint;
  v_date date; v_user uuid; v_group uuid := coalesce(p_group, gen_random_uuid());
  v_q numeric; v_s numeric; a_d numeric; a_c numeric; x_d numeric; x_c numeric; v_e numeric; v_m numeric;
  sum_r_d numeric := 0; sum_r_c numeric := 0; sum_s_d numeric := 0; sum_s_c numeric := 0;
  pos_id bigint[] := '{}'; pos_amt numeric[] := '{}'; neg_id bigint[] := '{}'; neg_amt numeric[] := '{}';
  chp_id bigint[] := '{}'; chp_amt numeric[] := '{}'; chn_id bigint[] := '{}'; chn_amt numeric[] := '{}';
  v_cl uuid; v_cl_item bigint; v_id bigint; v_ids bigint[] := '{}'; i int := 1; j int := 1;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('manual', 'auto', 'plan') THEN RAISE EXCEPTION 'SETTLEMENT_KIND_INVALID: kiểu đối trừ % không lập được', p_kind USING ERRCODE = 'P0001'; END IF;
  -- Khóa hai khoản theo thứ tự id trước khi đọc dư: hai lần đối trừ đồng thời trên cùng một khoản chạy nối tiếp, lần sau thấy dư đã giảm (không bế tắc khi chéo nhau).
  PERFORM 1 FROM open_item WHERE id IN (p_debit, p_credit) ORDER BY id FOR UPDATE;
  SELECT * INTO d FROM open_item WHERE id = p_debit;
  IF NOT FOUND THEN RAISE EXCEPTION 'OPEN_ITEM_NOT_FOUND: không có khoản công nợ %', p_debit USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO c FROM open_item WHERE id = p_credit;
  IF NOT FOUND THEN RAISE EXCEPTION 'OPEN_ITEM_NOT_FOUND: không có khoản công nợ %', p_credit USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM open_item WHERE tenant_id = d.tenant_id AND parent_id IN (p_debit, p_credit) ORDER BY id FOR UPDATE;
  IF d.tenant_id <> c.tenant_id OR (d.account_id, d.party_id, d.currency_code) IS DISTINCT FROM (c.account_id, c.party_id, c.currency_code) THEN
    RAISE EXCEPTION 'SETTLEMENT_MISMATCH: hai khoản đối trừ phải cùng tài khoản, đối tượng và loại tiền' USING ERRCODE = 'P0001'; END IF;
  IF NOT (d.amount > 0 OR (d.amount = 0 AND d.amount_currency > 0)) OR NOT (c.amount < 0 OR (c.amount = 0 AND c.amount_currency < 0)) THEN
    RAISE EXCEPTION 'SETTLEMENT_MISMATCH: khoản bên Nợ phải là phát sinh Nợ, khoản bên Có phải là phát sinh Có' USING ERRCODE = 'P0001'; END IF;
  IF d.parent_id IS NOT NULL OR c.parent_id IS NOT NULL THEN
    RAISE EXCEPTION 'SETTLEMENT_MISMATCH: khoản điều chỉnh đánh giá lại được đối trừ cùng khoản gốc, không đối trừ riêng' USING ERRCODE = 'P0001'; END IF;
  v_date := greatest(p_date, d.doc_date, c.doc_date, d.line_posting_date, c.line_posting_date);
  p := fn_period_of(d.tenant_id, v_date, false);
  PERFORM fn_assert_period_writable(p, 'arap');
  v_user := coalesce(app_user_id(), (SELECT created_by FROM voucher WHERE id = d.voucher_id));
  SELECT * INTO rd FROM fn_open_item_residual(p_debit);
  SELECT * INTO rc FROM fn_open_item_residual(p_credit);

  IF d.currency_code = 'VND' THEN
    IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'SETTLEMENT_AMOUNT_REQUIRED: đối trừ khoản VND phải có số tiền lớn hơn 0' USING ERRCODE = 'P0001'; END IF;
    IF p_amount > rd.vnd OR p_amount > -rc.vnd THEN
      RAISE EXCEPTION 'SETTLEMENT_EXCEEDS_RESIDUAL: số đối trừ % vượt số còn lại của khoản (Nợ %, Có %)', p_amount, rd.vnd, -rc.vnd USING ERRCODE = 'P0001'; END IF;
    INSERT INTO settlement(tenant_id, debit_item_id, credit_item_id, amount, amount_currency, settle_date, kind, group_id, created_by)
      VALUES (d.tenant_id, p_debit, p_credit, p_amount, p_amount, v_date, p_kind, v_group, v_user) RETURNING id INTO v_id;
    RETURN ARRAY[v_id];
  END IF;

  v_q := p_amount_currency;
  IF v_q IS NULL OR v_q <= 0 THEN RAISE EXCEPTION 'SETTLEMENT_AMOUNT_REQUIRED: đối trừ khoản ngoại tệ phải có số nguyên tệ lớn hơn 0' USING ERRCODE = 'P0001'; END IF;
  IF v_q > rd.cur OR v_q > -rc.cur THEN
    RAISE EXCEPTION 'SETTLEMENT_EXCEEDS_RESIDUAL: số nguyên tệ đối trừ % vượt số còn lại của khoản (Nợ %, Có %)', v_q, rd.cur, -rc.cur USING ERRCODE = 'P0001'; END IF;
  -- Khoản con: phần đối trừ s cùng dấu với dư của khoản con, theo tỷ lệ q / dư nguyên tệ của khoản gốc (lấy hết nguyên tệ thì lấy hết dư khoản con).
  FOR ch IN SELECT o.id, o.parent_id, r.vnd FROM open_item o CROSS JOIN LATERAL fn_open_item_residual(o.id) r
            WHERE o.tenant_id = d.tenant_id AND o.parent_id IN (p_debit, p_credit) AND r.vnd <> 0 ORDER BY o.parent_id = p_credit, o.id LOOP
    v_s := sign(ch.vnd) * fn_proportional_vnd(abs(ch.vnd), CASE WHEN ch.parent_id = p_debit THEN rd.cur ELSE -rc.cur END, v_q);
    IF ch.parent_id = p_debit THEN sum_r_d := sum_r_d + ch.vnd; sum_s_d := sum_s_d + v_s; ELSE sum_r_c := sum_r_c + ch.vnd; sum_s_c := sum_s_c + v_s; END IF;
    IF v_s > 0 THEN chp_id := chp_id || ch.id; chp_amt := chp_amt || v_s; ELSIF v_s < 0 THEN chn_id := chn_id || ch.id; chn_amt := chn_amt || -v_s; END IF;
  END LOOP;
  a_d := fn_proportional_vnd(rd.vnd + sum_r_d, rd.cur, v_q);
  a_c := fn_proportional_vnd(-(rc.vnd + sum_r_c), -rc.cur, v_q);
  -- Phần của khoản gốc = phần của cả nhóm trừ phần của khoản con, giữ trong [0, dư VND của khoản gốc] (lệch làm tròn dồn vào CL).
  x_d := least(greatest(a_d - sum_s_d, 0), greatest(rd.vnd, 0));
  x_c := least(greatest(a_c + sum_s_c, 0), greatest(-rc.vnd, 0));
  -- Chênh lệch: bên Có (thu/trả) lấy ra nhiều VND hơn bên Nợ thì lãi (khoản CL bên Nợ), ít hơn thì lỗ (khoản CL bên Có); bằng a_c − a_d khi không phải giữ trong khoảng.
  v_e := x_c - x_d - sum_s_d - sum_s_c;
  IF v_e <> 0 THEN
    SELECT rules INTO v_rules FROM fx_rule WHERE regime = p.regime;
    IF NOT FOUND THEN RAISE EXCEPTION 'FX_RULES_MISSING: Chưa khai báo tài khoản lãi, lỗ chênh lệch tỷ giá cho chế độ kế toán %', p.regime USING ERRCODE = 'P0001'; END IF;
    SELECT id INTO v_acc FROM account WHERE tenant_id = d.tenant_id AND regime = p.regime AND code = v_rules->>(CASE WHEN v_e > 0 THEN 'gainAccount' ELSE 'lossAccount' END);
    IF NOT FOUND THEN RAISE EXCEPTION 'LOOKUP_NOT_FOUND: Không có tài khoản mã "%"', v_rules->>(CASE WHEN v_e > 0 THEN 'gainAccount' ELSE 'lossAccount' END) USING ERRCODE = 'P0001'; END IF;
    v_cl := gen_random_uuid();
    INSERT INTO voucher(id, tenant_id, voucher_type, posting_date, document_date, description, party_id, currency_code, source_doc_type, source_doc_id, created_by)
      VALUES (v_cl, d.tenant_id, 'CL', v_date, v_date, 'Chênh lệch tỷ giá đối trừ ' || concat_ws(' – ', d.doc_no, c.doc_no), d.party_id, 'VND', 'settlement_fx', v_group, v_user);
    -- Dòng trên tài khoản công nợ mang loại tiền của khoản, nguyên tệ 0, không tỷ giá; dòng lãi/lỗ bằng VND.
    INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, currency_code, amount_currency, debit, credit, party_id, description)
    SELECT d.tenant_id, v_cl, x.no, x.acc, v_date, x.cur, 0, x.dr, x.cr, x.party, 'Chênh lệch tỷ giá đối trừ'
    FROM (VALUES (1, CASE WHEN v_e > 0 THEN d.account_id ELSE v_acc END, CASE WHEN v_e > 0 THEN d.currency_code ELSE 'VND' END, abs(v_e), 0::numeric, CASE WHEN v_e > 0 THEN d.party_id END),
                 (2, CASE WHEN v_e > 0 THEN v_acc ELSE d.account_id END, CASE WHEN v_e > 0 THEN 'VND' ELSE d.currency_code END, 0::numeric, abs(v_e), CASE WHEN v_e < 0 THEN d.party_id END))
         AS x(no, acc, cur, dr, cr, party);
    PERFORM post_voucher(v_cl);
    SELECT id INTO v_cl_item FROM open_item WHERE voucher_id = v_cl;
  END IF;

  -- Dòng 1: khoản gốc với khoản gốc, mang toàn bộ nguyên tệ q.
  v_m := least(x_d, x_c);
  INSERT INTO settlement(tenant_id, debit_item_id, credit_item_id, amount, amount_currency, settle_date, kind, fx_voucher_id, group_id, created_by)
    VALUES (d.tenant_id, p_debit, p_credit, v_m, v_q, v_date, p_kind, v_cl, v_group, v_user) RETURNING id INTO v_id;
  v_ids := v_ids || v_id;
  -- Phần VND còn lại (khoản gốc, khoản con, khoản CL) ghép bên Nợ với bên Có theo thứ tự, nguyên tệ 0; tổng hai bên bằng nhau nhờ cách tính v_e.
  IF x_d > v_m THEN pos_id := pos_id || p_debit; pos_amt := pos_amt || (x_d - v_m); END IF;
  IF x_c > v_m THEN neg_id := neg_id || p_credit; neg_amt := neg_amt || (x_c - v_m); END IF;
  pos_id := pos_id || chp_id; pos_amt := pos_amt || chp_amt; neg_id := neg_id || chn_id; neg_amt := neg_amt || chn_amt;
  IF v_e > 0 THEN pos_id := pos_id || v_cl_item; pos_amt := pos_amt || v_e; ELSIF v_e < 0 THEN neg_id := neg_id || v_cl_item; neg_amt := neg_amt || -v_e; END IF;
  WHILE i <= cardinality(pos_id) AND j <= cardinality(neg_id) LOOP
    v_m := least(pos_amt[i], neg_amt[j]);
    INSERT INTO settlement(tenant_id, debit_item_id, credit_item_id, amount, amount_currency, settle_date, kind, fx_voucher_id, group_id, created_by)
      VALUES (d.tenant_id, pos_id[i], neg_id[j], v_m, 0, v_date, CASE WHEN v_cl_item IN (pos_id[i], neg_id[j]) THEN 'fx' ELSE p_kind END, v_cl, v_group, v_user) RETURNING id INTO v_id;
    v_ids := v_ids || v_id;
    pos_amt[i] := pos_amt[i] - v_m; neg_amt[j] := neg_amt[j] - v_m;
    IF pos_amt[i] = 0 THEN i := i + 1; END IF;
    IF neg_amt[j] = 0 THEN j := j + 1; END IF;
  END LOOP;
  IF i <= cardinality(pos_id) OR j <= cardinality(neg_id) THEN
    RAISE EXCEPTION 'SETTLEMENT_UNBALANCED: phần đối trừ hai bên không bằng nhau' USING ERRCODE = 'P0001'; END IF;
  RETURN v_ids;
END $$;

-- 7) Hủy một lần đối trừ: xóa mọi dòng của nhóm (nhật ký ghi trạng thái trước), đảo chứng từ CL của nhóm cùng ngày đối trừ (khoản của bản đảo tự đối trừ với khoản CL).
-- Kỳ của ngày đối trừ phải ghi được (kỳ khóa sổ cần quyền ghi lùi: app.override_soft_lock). Đối trừ do đảo chứng từ sinh ra không hủy được.
CREATE OR REPLACE FUNCTION unsettle(p_group uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; v_fx uuid[];
BEGIN
  PERFORM 1 FROM open_item WHERE id IN (SELECT debit_item_id FROM settlement WHERE group_id = p_group UNION SELECT credit_item_id FROM settlement WHERE group_id = p_group) ORDER BY id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM settlement WHERE group_id = p_group) THEN RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND: không có lần đối trừ %', p_group USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM settlement WHERE group_id = p_group AND kind = 'reversal') THEN
    RAISE EXCEPTION 'SETTLEMENT_REVERSAL_LOCKED: đối trừ do đảo chứng từ sinh ra, không hủy được; muốn mang lại công nợ hãy đảo lại chứng từ đảo' USING ERRCODE = 'P0001'; END IF;
  FOR r IN SELECT DISTINCT tenant_id, settle_date FROM settlement WHERE group_id = p_group LOOP
    PERFORM fn_assert_period_writable(fn_period_of(r.tenant_id, r.settle_date, false), 'arap');
  END LOOP;
  SELECT coalesce(array_agg(DISTINCT fx_voucher_id), '{}') INTO v_fx FROM settlement WHERE group_id = p_group AND fx_voucher_id IS NOT NULL;
  DELETE FROM settlement WHERE group_id = p_group;
  FOR r IN SELECT id, posting_date FROM voucher WHERE id = ANY (v_fx) AND state = 'posted' ORDER BY posting_date, id LOOP
    PERFORM reverse_voucher(r.id, r.posting_date, NULL);
  END LOOP;
END $$;

-- 8) Đối trừ tự động trên một tài khoản (một đối tượng hoặc mọi đối tượng) đến ngày p_date: theo từng (đối tượng, loại tiền), khoản Nợ còn dư và khoản Có còn dư
-- xếp theo hạn thanh toán (không có hạn thì ngày chứng từ), ngày chứng từ, id; ghép theo kiểu vào trước ra trước bằng khoảng lũy kế (một câu truy vấn), mỗi cặp một nhóm 'auto'.
-- Chỉ khoản ghi sổ và có ngày chứng từ đến p_date (ngày đối trừ là p_date); khoản con đi cùng khoản gốc. Tối đa 10.000 cặp mỗi lần gọi, trả số nhóm đã tạo (gọi lại để làm tiếp).
CREATE OR REPLACE FUNCTION auto_settle(p_account bigint, p_party uuid, p_date date) RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; n int := 0; v_tenant uuid := (SELECT tenant_id FROM account WHERE id = p_account);
BEGIN
  FOR r IN
    WITH x AS (
      SELECT o.id, o.party_id, o.currency_code, coalesce(o.due_date, o.doc_date) AS due, o.doc_date, rs.cur AS res
      FROM open_item o CROSS JOIN LATERAL fn_open_item_residual(o.id) rs
      WHERE o.tenant_id = v_tenant AND o.account_id = p_account AND (p_party IS NULL OR o.party_id = p_party) AND o.parent_id IS NULL
        AND o.line_posting_date <= p_date AND o.doc_date <= p_date AND rs.cur <> 0),
    d AS (SELECT id, party_id, currency_code, sum(res) OVER w - res AS lo, sum(res) OVER w AS hi FROM x WHERE res > 0
          WINDOW w AS (PARTITION BY party_id, currency_code ORDER BY due, doc_date, id)),
    c AS (SELECT id, party_id, currency_code, sum(-res) OVER w + res AS lo, sum(-res) OVER w AS hi FROM x WHERE res < 0
          WINDOW w AS (PARTITION BY party_id, currency_code ORDER BY due, doc_date, id))
    SELECT d.id AS d_id, c.id AS c_id, least(d.hi, c.hi) - greatest(d.lo, c.lo) AS q
    FROM d JOIN c ON c.party_id = d.party_id AND c.currency_code = d.currency_code AND c.lo < d.hi AND d.lo < c.hi
    ORDER BY d.party_id, d.currency_code, greatest(d.lo, c.lo), d.id, c.id
    LIMIT 10000
  LOOP
    -- dư nguyên tệ của khoản VND bằng dư VND: q dùng cho cả hai tham số
    PERFORM settle_open_items(r.d_id, r.c_id, r.q, r.q, p_date, 'auto', gen_random_uuid());
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- 9) Ghi sổ áp kế hoạch đối trừ: đọc rồi xóa kế hoạch khi chứng từ còn nháp; sau khi sinh khoản, mỗi dòng kế hoạch đối trừ khoản của dòng line_no với khoản đã chọn
-- (đúng chiều Nợ/Có), ngày ghi sổ, kiểu 'plan', mỗi dòng kế hoạch một nhóm.
CREATE OR REPLACE FUNCTION post_voucher(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; vt voucher_type; p fiscal_period; v_seq bigint; v_no text; v_n int; v_plan settlement_plan[]; pl settlement_plan; v_item open_item;
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
  -- đối trừ: kế hoạch dùng một lần, đọc và xóa khi chứng từ còn nháp (fn_voucher_child_guard chặn sửa sau khi ghi sổ)
  SELECT coalesce(array_agg(s ORDER BY s.id), '{}') INTO v_plan FROM settlement_plan s WHERE s.voucher_id = p_id;
  IF cardinality(v_plan) > 0 THEN DELETE FROM settlement_plan WHERE voucher_id = p_id; END IF;
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'posted', voucher_no = coalesce(voucher_no, v_no), seq_no = coalesce(seq_no, v_seq), posted_by = app_user_id(), posted_at = now() WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_build_pairs(p_id);
  PERFORM fn_open_items_create(p_id); -- công nợ: khoản theo chứng từ cho dòng tài khoản công nợ
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

-- 10) Bỏ ghi sổ: khoản đang được chứng từ nháp chọn trong kế hoạch đối trừ thì báo rõ chứng từ đó (khóa ngoại của settlement_plan cũng chặn xóa khoản).
-- Hủy chứng từ nháp bỏ kế hoạch của nó: kế hoạch của chứng từ đã hủy không còn dùng, để lại sẽ chặn mãi việc bỏ ghi sổ chứng từ của khoản được chọn.
CREATE OR REPLACE FUNCTION unpost_voucher(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v voucher; p fiscal_period; v_by text;
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
  DELETE FROM settlement_plan WHERE voucher_id = p_id; -- đối trừ: chứng từ đã hủy không giữ kế hoạch đối trừ
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'cancelled' WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_audit_voucher(v.tenant_id, 'discard', p_id, jsonb_build_object('voucher_no', v.voucher_no));
END $function$;

CREATE OR REPLACE FUNCTION reverse_voucher(p_id uuid, p_date date, p_description text)
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
