-- GĐ6 Task 11a: chạy giá thành theo kỳ tháng (Quy ước 8, D1–D4). Một lần chạy mỗi công ty × kỳ; chạy lại thay kết quả (đảo GT cũ, sinh GT mới).
-- Quyền cost_run.view/run đã có từ 0094. Chứng từ GT (đăng ký ở 0099) chỉ kết chuyển 621/622/627 → 154 theo đối tượng (TT99/TT200);
-- TT133 tập hợp thẳng 154 nên không có GT (status 'calculated'). Thành phẩm vào kho (Nợ 155 / Có 154) là lớp điều chỉnh giá nhập GĐ3 (Task 11b) đọc cost_run_output.
CREATE TABLE cost_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  year int NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  -- calculated: kết quả không cần GT (TT133, không có chi phí); posted: có GT đang hiệu lực; unlinked: GT bị đảo/bỏ ghi sổ/hủy/xóa ngoài luồng → cần chạy lại.
  status text NOT NULL CHECK (status IN ('calculated', 'posted', 'unlinked')),
  regime text NOT NULL,
  params jsonb NOT NULL,          -- tham số người dùng (phương pháp, dở dang, tiêu thức 627, sản phẩm đầu ra) — chạy lại/ kiểm "Cần chạy lại" dùng lại
  input_hash text NOT NULL,       -- chữ ký đầu vào: chi phí tập hợp, dở dang đầu (kỳ trước), sản lượng, tham số
  voucher_id uuid,                -- chứng từ GT
  warnings jsonb NOT NULL DEFAULT '[]',
  run_by uuid DEFAULT app_user_id(), run_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'posted') = (voucher_id IS NOT NULL)),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, year, month),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id) ON DELETE SET NULL (voucher_id));
SELECT rls_enable('cost_run'); SELECT audit_enable('cost_run');

-- Mỗi đối tượng của lần chạy: dở dang đầu, phát sinh (gồm 627 phân bổ), dở dang cuối, giá thành theo khoản mục. Bảng tính toán: audit ở cost_run.
CREATE TABLE cost_run_object (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  run_id bigint NOT NULL,
  cost_object_id bigint NOT NULL,
  method text NOT NULL CHECK (method IN ('simple', 'coefficient', 'ratio', 'project', 'order')),
  wip_method text NOT NULL CHECK (wip_method IN ('none', 'direct_material', 'equivalent_units')),
  completion_material numeric(7,4), completion_labor numeric(7,4), completion_overhead numeric(7,4), -- mức hoàn thành dở dang (%), equivalent_units
  completed boolean,              -- vụ việc/đơn hàng đã hoàn thành
  overhead_basis numeric(20,4) NOT NULL DEFAULT 0, allocated_overhead numeric(20,0) NOT NULL DEFAULT 0,
  opening_material numeric(20,0) NOT NULL, opening_labor numeric(20,0) NOT NULL, opening_overhead numeric(20,0) NOT NULL,
  incurred_material numeric(20,0) NOT NULL, incurred_labor numeric(20,0) NOT NULL, incurred_overhead numeric(20,0) NOT NULL, -- incurred_overhead đã gồm allocated_overhead
  closing_material numeric(20,0) NOT NULL, closing_labor numeric(20,0) NOT NULL, closing_overhead numeric(20,0) NOT NULL,
  cost_material numeric(20,0) NOT NULL, cost_labor numeric(20,0) NOT NULL, cost_overhead numeric(20,0) NOT NULL,
  total_cost numeric(20,0) NOT NULL,
  completed_qty numeric(20,6) NOT NULL DEFAULT 0, wip_qty numeric(20,6) NOT NULL DEFAULT 0,
  unit_cost numeric(20,4),        -- chỉ khi đối tượng có một sản phẩm đầu ra
  CHECK (opening_material + incurred_material = cost_material + closing_material AND opening_labor + incurred_labor = cost_labor + closing_labor
     AND opening_overhead + incurred_overhead = cost_overhead + closing_overhead AND total_cost = cost_material + cost_labor + cost_overhead),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, run_id, cost_object_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES cost_run (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, cost_object_id) REFERENCES cost_object (tenant_id, id));
SELECT rls_enable('cost_run_object');
CREATE INDEX cost_run_object_object ON cost_run_object (tenant_id, cost_object_id);

-- Sản phẩm đầu ra: giá thành theo khoản mục, giá thành đơn vị. item_id NULL với vụ việc/hợp đồng/đơn hàng không nhập kho.
-- Task 11b: giá nhập thành phẩm của kỳ = total của (run, item) phân cho các dòng PNK nhập thành phẩm trong kỳ.
CREATE TABLE cost_run_output (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  run_id bigint NOT NULL,
  run_object_id bigint NOT NULL,
  line_no int NOT NULL,
  item_id bigint,
  qty numeric(20,6) NOT NULL, wip_qty numeric(20,6) NOT NULL DEFAULT 0,
  coefficient numeric(12,6),
  standard_material numeric(20,4), standard_labor numeric(20,4), standard_overhead numeric(20,4), -- giá thành định mức đơn vị (phương pháp tỷ lệ)
  cost_material numeric(20,0) NOT NULL, cost_labor numeric(20,0) NOT NULL, cost_overhead numeric(20,0) NOT NULL,
  total numeric(20,0) NOT NULL, unit_cost numeric(20,4) NOT NULL,
  CHECK (total = cost_material + cost_labor + cost_overhead),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, run_object_id, line_no),
  FOREIGN KEY (tenant_id, run_id) REFERENCES cost_run (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, run_object_id) REFERENCES cost_run_object (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id));
SELECT rls_enable('cost_run_output');
CREATE INDEX cost_run_output_item ON cost_run_output (tenant_id, item_id, run_id) WHERE item_id IS NOT NULL;

-- Liên kết lần chạy ↔ GT (Review Focus 6): GT bị đảo, bỏ ghi sổ, hủy (mọi đường, kể cả ngoài costing/costRun.ts) thì gỡ voucher_id;
-- GT bị xóa thì khóa ngoại SET NULL. Mất GT thì lần chạy "đã hạch toán" thành "unlinked" (Cần chạy lại).
CREATE FUNCTION fn_cost_run_unlinked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.voucher_id IS NULL AND NEW.status = 'posted' THEN NEW.status := 'unlinked'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_cost_run_unlinked BEFORE UPDATE OF voucher_id ON cost_run FOR EACH ROW EXECUTE FUNCTION fn_cost_run_unlinked();

CREATE FUNCTION fn_cost_run_voucher_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE cost_run SET voucher_id = NULL WHERE tenant_id = NEW.tenant_id AND voucher_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_cost_run_voucher_state AFTER UPDATE OF state ON voucher FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('draft', 'cancelled', 'reversed') AND NEW.voucher_type = 'GT') EXECUTE FUNCTION fn_cost_run_voucher_state();
