-- GĐ3 Task 8 sửa vòng 1: mỗi phát sinh kho có nhiều nhất một gán giá hiện hành (0049 đã đẩy, đóng băng).
DROP INDEX stock_cost_assignment_cur;
CREATE UNIQUE INDEX stock_cost_assignment_cur ON stock_cost_assignment (tenant_id, move_id) WHERE is_current;
