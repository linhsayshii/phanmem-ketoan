-- GĐ3 Task 2: danh mục nhóm hàng, vật tư hàng hóa (VTHH), ĐVT quy đổi và kho; khóa ngoại tổng hợp từ dòng chứng từ.
CREATE TABLE item_group (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, parent_id bigint,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES item_group (tenant_id, id));

CREATE TABLE item (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, name_en text,
  group_id bigint,
  kind text NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods','material','finished','service','tool')),
  base_uom_id bigint NOT NULL,
  tracking text NOT NULL DEFAULT 'none' CHECK (tracking IN ('none','lot','lot_expiry')),
  shelf_life_days int CHECK (shelf_life_days > 0),
  default_tax_code text,
  min_qty numeric(20,4) CHECK (min_qty >= 0), max_qty numeric(20,4) CHECK (max_qty >= 0),
  location text, barcode text, spec_code text,
  inventory_account_id bigint, revenue_account_id bigint, cogs_account_id bigint,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  CHECK (min_qty IS NULL OR max_qty IS NULL OR min_qty <= max_qty),
  FOREIGN KEY (tenant_id, group_id) REFERENCES item_group (tenant_id, id),
  FOREIGN KEY (tenant_id, base_uom_id) REFERENCES uom (tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_account_id) REFERENCES account (tenant_id, id),
  FOREIGN KEY (tenant_id, revenue_account_id) REFERENCES account (tenant_id, id),
  FOREIGN KEY (tenant_id, cogs_account_id) REFERENCES account (tenant_id, id));
CREATE INDEX item_group_idx ON item (tenant_id, group_id);

CREATE TABLE item_uom (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  item_id bigint NOT NULL, uom_id bigint NOT NULL,
  factor numeric(20,6) NOT NULL CHECK (factor > 0),
  is_purchase boolean NOT NULL DEFAULT false, is_sale boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, item_id, uom_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uom (tenant_id, id));

CREATE TABLE warehouse (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL,
  inventory_account_id bigint,
  costing_method text CHECK (costing_method IN ('avg_period','avg_moving','fifo','specific')),
  kind text NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','consignment_out','consignment_in')),
  branch_id bigint,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, inventory_account_id) REFERENCES account (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES department (tenant_id, id));

SELECT rls_enable(t) FROM unnest(ARRAY['item_group','item','item_uom','warehouse']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['item_group','item','item_uom','warehouse']::regclass[]) AS t;

-- Hàng đã phát sinh? Task 5 định nghĩa lại hàm này, thêm stock_move vào điều kiện.
CREATE OR REPLACE FUNCTION fn_item_in_use(p_item bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM voucher_line WHERE tenant_id = app_tenant() AND item_id = p_item)
      OR EXISTS (SELECT 1 FROM voucher_item_line WHERE tenant_id = app_tenant() AND item_id = p_item) $$;

CREATE OR REPLACE FUNCTION fn_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF fn_item_in_use(OLD.id) THEN RAISE EXCEPTION 'ITEM_IN_USE: Vật tư hàng hóa % đã phát sinh, không xóa được; hãy ngưng dùng', OLD.code; END IF;
    RETURN OLD;
  END IF;
  IF NEW.base_uom_id IS DISTINCT FROM OLD.base_uom_id AND fn_item_in_use(OLD.id) THEN
    RAISE EXCEPTION 'ITEM_UOM_LOCKED: Vật tư hàng hóa % đã phát sinh, không đổi được đơn vị tính cơ sở', OLD.code; END IF;
  IF NEW.tracking IS DISTINCT FROM OLD.tracking AND fn_item_in_use(OLD.id) THEN
    RAISE EXCEPTION 'ITEM_TRACKING_LOCKED: Vật tư hàng hóa % đã phát sinh, không đổi được cách theo dõi lô, hạn dùng', OLD.code; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_item_guard BEFORE UPDATE OR DELETE ON item FOR EACH ROW EXECUTE FUNCTION fn_item_guard();

-- Dòng ĐVT cơ sở (factor 1) tự có khi tạo hàng và theo ĐVT cơ sở khi đổi.
CREATE OR REPLACE FUNCTION fn_item_base_uom() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.base_uom_id = OLD.base_uom_id THEN RETURN NEW; END IF;
    DELETE FROM item_uom WHERE tenant_id = NEW.tenant_id AND item_id = NEW.id AND uom_id = OLD.base_uom_id;
  END IF;
  INSERT INTO item_uom(tenant_id, item_id, uom_id, factor, is_purchase, is_sale) VALUES (NEW.tenant_id, NEW.id, NEW.base_uom_id, 1, true, true)
  ON CONFLICT (tenant_id, item_id, uom_id) DO UPDATE SET factor = 1;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_item_base_uom AFTER INSERT OR UPDATE OF base_uom_id ON item FOR EACH ROW EXECUTE FUNCTION fn_item_base_uom();

-- Dòng ĐVT cơ sở luôn có factor 1 và không xóa riêng được (xóa cả hàng thì dòng đi theo vì hàng đã mất).
CREATE OR REPLACE FUNCTION fn_item_uom_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_base bigint;
BEGIN
  SELECT base_uom_id INTO v_base FROM item WHERE tenant_id = OLD.tenant_id AND id = OLD.item_id;
  IF v_base IS NULL OR OLD.uom_id <> v_base THEN IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ITEM_UOM_BASE: Không xóa được đơn vị tính cơ sở của hàng'; END IF;
  IF NEW.uom_id <> OLD.uom_id OR NEW.factor <> 1 THEN RAISE EXCEPTION 'ITEM_UOM_BASE: Đơn vị tính cơ sở luôn có hệ số quy đổi 1'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_item_uom_guard BEFORE UPDATE OR DELETE ON item_uom FOR EACH ROW EXECUTE FUNCTION fn_item_uom_guard();

-- Dòng chứng từ chỉ tham chiếu hàng/kho cùng công ty. Khóa ngoại tổng hợp trên bảng cha phân vùng.
CREATE INDEX voucher_line_item ON voucher_line (tenant_id, item_id) WHERE item_id IS NOT NULL;
CREATE INDEX voucher_line_warehouse ON voucher_line (tenant_id, warehouse_id) WHERE warehouse_id IS NOT NULL;
CREATE INDEX voucher_item_line_item ON voucher_item_line (tenant_id, item_id) WHERE item_id IS NOT NULL;
ALTER TABLE voucher_line ADD FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id);
ALTER TABLE voucher_line ADD FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id);
ALTER TABLE voucher_item_line ADD FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id) NOT VALID;
ALTER TABLE voucher_item_line VALIDATE CONSTRAINT voucher_item_line_tenant_id_item_id_fkey;
