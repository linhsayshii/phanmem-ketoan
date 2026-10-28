-- 0210_song_ngu.sql: GĐ7 nhóm 2, tên tiếng Anh của tài khoản (account.name_en có từ 0001) và chỉ tiêu báo cáo, kèm trạng thái dịch.
-- translation_status KHÔNG phải dữ liệu pháp lý: 'draft' = bản dịch tham khảo chưa ai soát, 'reviewed' = kế toán đã soát; NULL = chưa có bản dịch.
ALTER TABLE account ADD COLUMN translation_status text CHECK (translation_status IN ('draft', 'reviewed'));
ALTER TABLE report_line ADD COLUMN label_en text, ADD COLUMN translation_status text CHECK (translation_status IN ('draft', 'reviewed'));
ALTER TABLE report_template ADD COLUMN label_en text;

-- Có bản dịch mà chưa nêu trạng thái thì là 'draft'; không có bản dịch thì không có trạng thái. TG_ARGV[0] là tên cột bản dịch.
CREATE FUNCTION fn_translation_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v text := to_jsonb(NEW) ->> TG_ARGV[0];
BEGIN
  IF v IS NULL OR btrim(v) = '' THEN NEW.translation_status := NULL;
  ELSIF NEW.translation_status IS NULL THEN NEW.translation_status := 'draft';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_translation_status BEFORE INSERT OR UPDATE ON account FOR EACH ROW EXECUTE FUNCTION fn_translation_status('name_en');
CREATE TRIGGER report_line_translation_status BEFORE INSERT OR UPDATE ON report_line FOR EACH ROW EXECUTE FUNCTION fn_translation_status('label_en');

-- Tên đã có sẵn (nhập tay trước đây) coi là bản nháp.
UPDATE account SET translation_status = 'draft' WHERE name_en IS NOT NULL AND btrim(name_en) <> '';
