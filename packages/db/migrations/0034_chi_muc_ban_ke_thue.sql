-- GĐ2 Task 22: bảng kê hóa đơn và đối chiếu thuế lọc theo chiều, năm và kỳ kê khai.
CREATE INDEX voucher_invoice_declare ON voucher_invoice (tenant_id, direction, declare_year, declare_period);
