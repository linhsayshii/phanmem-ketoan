-- GĐ6 Task 6c: quy trình cuối kỳ thêm bước payroll (tính lương và hạch toán) và product_cost (giá thành sản phẩm, bộ chạy ở Task 11).
-- CHECK ban đầu ở 0074 (không đặt tên: period_close_log_step_check); giữ đủ các bước cũ.
ALTER TABLE period_close_log DROP CONSTRAINT period_close_log_step_check;
ALTER TABLE period_close_log ADD CONSTRAINT period_close_log_step_check CHECK (step IN
  ('payroll','tool','prepaid','depreciation','loan_interest','amortization','costing','product_cost','fx_outflow','fx_revaluation','vat_offset','closing'));
