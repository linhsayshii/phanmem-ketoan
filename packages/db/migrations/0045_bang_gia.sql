-- GĐ3 Task 3: bảng giá bán/mua theo nhóm đối tượng, thời gian hiệu lực, bậc số lượng. Giá chỉ là gợi ý điền sẵn, không ràng buộc sổ cái.

CREATE TABLE price_list (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sale','purchase')),
  currency_code char(3) NOT NULL,
  party_group_id uuid,
  valid_from date NOT NULL, valid_to date,
  priority int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (tenant_id, currency_code) REFERENCES currency (tenant_id, code),
  FOREIGN KEY (tenant_id, party_group_id) REFERENCES party_group (tenant_id, id));

CREATE TABLE price_list_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  price_list_id bigint NOT NULL, item_id bigint NOT NULL, uom_id bigint NOT NULL,
  min_qty numeric(20,4) NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  price numeric(20,4) NOT NULL CHECK (price >= 0),
  discount_rate numeric(7,4) NOT NULL DEFAULT 0 CHECK (discount_rate >= 0 AND discount_rate <= 100),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, price_list_id, item_id, uom_id, min_qty),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_list (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES uom (tenant_id, id));
CREATE INDEX price_list_line_item ON price_list_line (tenant_id, item_id, uom_id);
CREATE INDEX price_list_kind ON price_list (tenant_id, kind, valid_from);

SELECT rls_enable(t) FROM unnest(ARRAY['price_list','price_list_line']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['price_list','price_list_line']::regclass[]) AS t;
