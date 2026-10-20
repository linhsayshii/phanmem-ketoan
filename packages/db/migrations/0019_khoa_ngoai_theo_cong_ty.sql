-- Khóa ngoại giữa hai bảng cùng có tenant_id chuyển thành tổng hợp (tenant_id, x_id) → cha (tenant_id, id),
-- để một dòng không thể trỏ sang bản ghi của công ty khác kể cả khi chèn bằng quyền quản trị.
-- Giữ nguyên ON DELETE và DEFERRABLE của khóa cũ. ON DELETE SET NULL chỉ xóa cột x_id (không xóa tenant_id).
DO $$
DECLARE r record; col text; act text;
BEGIN
  FOR r IN
    SELECT c.oid, c.conname, c.conrelid::regclass AS child, c.confrelid::regclass AS parent, c.conkey[1] AS ck,
           c.confdeltype, c.condeferrable, c.condeferred
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conparentid = 0 AND array_length(c.conkey, 1) = 1
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'tenant_id')
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'tenant_id')
      AND c.confrelid <> 'tenant'::regclass
    ORDER BY 3, 2
  LOOP
    SELECT attname INTO col FROM pg_attribute WHERE attrelid = r.child AND attnum = r.ck;
    -- bảng cha cần UNIQUE (tenant_id, id) làm đích tham chiếu
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint u WHERE u.conrelid = r.parent AND u.contype IN ('u', 'p')
        AND (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute WHERE attrelid = u.conrelid AND attnum = ANY (u.conkey)) = ARRAY['id', 'tenant_id']) THEN
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (tenant_id, id)', r.parent, replace(r.parent::text, '"', '') || '_tenant_id_id_key');
    END IF;
    act := CASE r.confdeltype WHEN 'c' THEN ' ON DELETE CASCADE' WHEN 'n' THEN format(' ON DELETE SET NULL (%I)', col)
                              WHEN 'r' THEN ' ON DELETE RESTRICT' WHEN 'd' THEN format(' ON DELETE SET DEFAULT (%I)', col) ELSE '' END;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.child, r.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (tenant_id, %I) REFERENCES %s (tenant_id, id)%s%s',
      r.child, r.conname, col, r.parent, act,
      CASE WHEN r.condeferrable THEN ' DEFERRABLE' || CASE WHEN r.condeferred THEN ' INITIALLY DEFERRED' ELSE '' END ELSE '' END);
  END LOOP;
END $$;
