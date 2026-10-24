-- GĐ6 Task 10b: định mức nguyên vật liệu, khoản mục chi phí theo yếu tố giá thành, một đối tượng mỗi vụ việc/hợp đồng.
-- (0102 dành cho Task 7 chạy song song.)

-- Tập hợp chi phí theo vụ việc/hợp đồng dò đối tượng từ project_id/contract_id của dòng sổ cái: mỗi vụ việc, hợp đồng chỉ một đối tượng (NULL không trùng nhau).
ALTER TABLE cost_object ADD CONSTRAINT cost_object_project_key UNIQUE (tenant_id, project_id);
ALTER TABLE cost_object ADD CONSTRAINT cost_object_contract_key UNIQUE (tenant_id, contract_id);

-- Yếu tố giá thành của khoản mục: TT133 (và dòng ghi thẳng 154) không có 621/622/627, nên NVL/nhân công/SXC đọc theo khoản mục của dòng.
ALTER TABLE cost_item ADD COLUMN cost_element text CHECK (cost_element IN ('material','labor','overhead'));

-- Định mức NVL cho một đơn vị sản phẩm (vật tư thành phẩm) hoặc đối tượng tập hợp chi phí, theo khoảng hiệu lực (API chặn chồng khoảng).
CREATE TABLE cost_norm (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  item_id bigint, cost_object_id bigint,
  valid_from date NOT NULL, valid_to date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((item_id IS NULL) <> (cost_object_id IS NULL)),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  UNIQUE (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, item_id, cost_object_id, valid_from),
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_object_id) REFERENCES cost_object (tenant_id, id));
SELECT rls_enable('cost_norm'); SELECT audit_enable('cost_norm');

-- quantity: lượng NVL cho một đơn vị sản phẩm (ĐVT cơ sở của vật tư); loss_percent: tỷ lệ hao hụt cộng thêm (định mức gồm hao hụt = quantity × (1 + loss_percent/100)).
CREATE TABLE cost_norm_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  norm_id bigint NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  item_id bigint NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  loss_percent numeric(7,4) NOT NULL DEFAULT 0 CHECK (loss_percent >= 0),
  note text,
  UNIQUE (tenant_id, norm_id, line_no), UNIQUE (tenant_id, norm_id, item_id),
  FOREIGN KEY (tenant_id, norm_id) REFERENCES cost_norm (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id));
SELECT rls_enable('cost_norm_line'); SELECT audit_enable('cost_norm_line');
