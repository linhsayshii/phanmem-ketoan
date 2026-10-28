-- GĐ7 nhóm 6: thêm chế độ TT152 (hộ kinh doanh, TT 152/2025/TT-BTC) vào mọi ràng buộc CHECK regime hiện có (TT99, TT133, TT200, TT58).
-- Không tạo dữ liệu pháp lý: mẫu tài khoản, sổ, báo cáo của TT152/TT58 chờ văn bản gốc (packages/coa-data/data/regimes/status.json).
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conrelid::regclass AS tbl, con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_namespace n ON n.oid = con.connamespace
    WHERE n.nspname = 'public' AND con.contype = 'c' AND pg_get_constraintdef(con.oid) LIKE '%regime%' AND pg_get_constraintdef(con.oid) LIKE '%''TT58''%' AND pg_get_constraintdef(con.oid) NOT LIKE '%''TT152''%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
    -- định nghĩa dạng ((regime = ANY (ARRAY['TT99'::text, ..., 'TT58'::text]))): thêm 'TT152' sau 'TT58'
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', c.tbl, c.conname, replace(c.def, '''TT58''::text', '''TT58''::text, ''TT152''::text'));
  END LOOP;
END $$;
