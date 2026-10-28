-- GĐ6 Task 11b: giá thành vào kho bằng lớp điều chỉnh giá nhập GĐ3 (D4). Lớp 'adjustment' của phiếu nhập thành phẩm do chạy giá thành sinh ra
-- mang cost_run_id: chạy lại giá thành tính lại phần chênh so với giá trị nhập hiện tại (gồm lớp cũ) và chèn lớp mới cùng liên kết,
-- không sửa/xóa lớp cũ; giá vốn (runCosting) ghi Nợ 155 / Có 154 phần chênh như mọi lớp điều chỉnh giá nhập.
ALTER TABLE stock_cost_layer ADD COLUMN cost_run_id bigint;
ALTER TABLE stock_cost_layer ADD FOREIGN KEY (tenant_id, cost_run_id) REFERENCES cost_run (tenant_id, id);
ALTER TABLE stock_cost_layer ADD CONSTRAINT stock_cost_layer_cost_run_kind CHECK (cost_run_id IS NULL OR kind = 'adjustment');
CREATE INDEX stock_cost_layer_cost_run ON stock_cost_layer (tenant_id, cost_run_id) WHERE cost_run_id IS NOT NULL;
