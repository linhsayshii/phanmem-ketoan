-- Khóa kỳ cho sổ hộ kinh doanh (TT 152/2025) và doanh nghiệp siêu nhỏ (TT 58/2026), QĐ 1517 (b): bút ghi sổ đơn (book_*) ở ngày thuộc kỳ đã khóa
-- không thêm, sửa, xóa được, cùng ngữ nghĩa với chứng từ (fn_assert_period_writable của 0004): khóa cứng luôn chặn (PERIOD_HARD_LOCKED); khóa sổ
-- chặn trừ khi phiên có app.override_soft_lock (quyền ghi lùi voucher.backdate_locked, đặt bởi withOverride ở API) (PERIOD_SOFT_LOCKED).
-- Sửa kiểm cả ngày cũ và ngày mới. Ngày chưa thuộc kỳ nào đã mở thì không chặn (sổ HKD cho ghi trước khi mở năm tài chính, như yearOf).
-- Không áp khóa phần hành (locked_modules): sổ đơn không thuộc phần hành nào của danh mục phần hành.

-- Kỳ chính (1..15) chứa ngày; đọc FOR SHARE như fn_voucher_before để đua đúng với lock_period.
CREATE FUNCTION fn_book_assert_writable(p_tenant uuid, p_date date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p fiscal_period;
BEGIN
  IF p_date IS NULL THEN RETURN; END IF;
  SELECT * INTO p FROM fiscal_period WHERE tenant_id = p_tenant AND period_no BETWEEN 1 AND 15 AND p_date BETWEEN date_from AND date_to FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM fn_assert_period_writable(p, NULL);
END $$;

-- Bảng có một cột ngày (TG_ARGV[0]): thêm kiểm ngày mới, xóa kiểm ngày cũ, sửa kiểm cả hai (bỏ qua khi dòng không đổi).
CREATE FUNCTION fn_book_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE col text := TG_ARGV[0]; o jsonb; n jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND n = o THEN RETURN NEW; END IF;
  IF o IS NOT NULL THEN PERFORM fn_book_assert_writable((o->>'tenant_id')::uuid, (o->>col)::date); END IF;
  IF n IS NOT NULL THEN PERFORM fn_book_assert_writable((n->>'tenant_id')::uuid, (n->>col)::date); END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

-- Thẻ TSCĐ (S4b) có hai mốc: ghi tăng (inc_date) và ghi giảm (dec_date). Ghi giảm ở kỳ mở cho tài sản mua ở kỳ đã khóa là nghiệp vụ thường,
-- nên sửa chỉ kiểm mốc của phần thay đổi: đổi thông tin ghi tăng, nguyên giá, tỷ lệ khấu hao... kiểm inc_date cũ và mới; đổi phần ghi giảm kiểm dec_date cũ và mới.
-- Thêm, xóa thẻ kiểm cả hai mốc.
CREATE FUNCTION fn_book_asset_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dec_cols text[] := ARRAY['dec_doc_no', 'dec_date', 'dec_reason'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM fn_book_assert_writable(NEW.tenant_id, NEW.inc_date); PERFORM fn_book_assert_writable(NEW.tenant_id, NEW.dec_date); RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM fn_book_assert_writable(OLD.tenant_id, OLD.inc_date); PERFORM fn_book_assert_writable(OLD.tenant_id, OLD.dec_date); RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - dec_cols) IS DISTINCT FROM (to_jsonb(OLD) - dec_cols) THEN
    PERFORM fn_book_assert_writable(OLD.tenant_id, OLD.inc_date); PERFORM fn_book_assert_writable(NEW.tenant_id, NEW.inc_date);
  END IF;
  IF (NEW.dec_doc_no, NEW.dec_date, NEW.dec_reason) IS DISTINCT FROM (OLD.dec_doc_no, OLD.dec_date, OLD.dec_reason) THEN
    PERFORM fn_book_assert_writable(OLD.tenant_id, OLD.dec_date); PERFORM fn_book_assert_writable(NEW.tenant_id, NEW.dec_date);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_book_period BEFORE INSERT OR UPDATE OR DELETE ON book_entry FOR EACH ROW EXECUTE FUNCTION fn_book_period_guard('entry_date');
CREATE TRIGGER trg_book_period BEFORE INSERT OR UPDATE OR DELETE ON book_other_tax FOR EACH ROW EXECUTE FUNCTION fn_book_period_guard('entry_date');
CREATE TRIGGER trg_book_period BEFORE INSERT OR UPDATE OR DELETE ON book_stock_move FOR EACH ROW EXECUTE FUNCTION fn_book_period_guard('move_date');
CREATE TRIGGER trg_book_period BEFORE INSERT OR UPDATE OR DELETE ON book_debt FOR EACH ROW EXECUTE FUNCTION fn_book_period_guard('entry_date');
CREATE TRIGGER trg_book_period BEFORE INSERT OR UPDATE OR DELETE ON book_equity FOR EACH ROW EXECUTE FUNCTION fn_book_period_guard('entry_date');
CREATE TRIGGER trg_book_period BEFORE INSERT OR UPDATE OR DELETE ON book_other_asset FOR EACH ROW EXECUTE FUNCTION fn_book_period_guard('entry_date');
CREATE TRIGGER trg_book_period BEFORE INSERT OR UPDATE OR DELETE ON book_fixed_asset FOR EACH ROW EXECUTE FUNCTION fn_book_asset_period_guard();
