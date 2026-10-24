-- GĐ5 Task 17: tờ khai quyết toán thuế TNDN 03/TNDN lưu trong tax_return với kỳ năm (period_kind 'year', period = 1).
-- Định nghĩa lại hai ràng buộc CHECK từ định nghĩa hiện hành (0035): thêm 'year', kỳ năm chỉ có period 1.
ALTER TABLE tax_return DROP CONSTRAINT tax_return_period_kind_check;
ALTER TABLE tax_return ADD CONSTRAINT tax_return_period_kind_check CHECK (period_kind IN ('month', 'quarter', 'year'));
ALTER TABLE tax_return DROP CONSTRAINT tax_return_check;
ALTER TABLE tax_return ADD CONSTRAINT tax_return_check CHECK (period BETWEEN 1 AND CASE period_kind WHEN 'month' THEN 12 WHEN 'quarter' THEN 4 ELSE 1 END);
