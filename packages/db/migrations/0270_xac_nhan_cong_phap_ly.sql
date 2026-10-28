-- GĐ7 gói 2 (C3): tờ khai 01/GTGT chốt khi cổng pháp lý còn false (thuế suất 8% chưa có chỉ tiêu trong mẫu) phải có xác nhận rõ ràng của người chốt.
-- acknowledged_gates ghi các cổng đã xác nhận lúc chốt (hiện chỉ 'rate8_unverified'); gán cùng lệnh UPDATE đổi status sang 'final' nên trigger 0035 không chặn,
-- và trigger audit_enable('tax_return') ghi trước/sau vào audit_event. Xuất XML và ký số của tờ khai có cổng chưa xác nhận bị chặn (409).
ALTER TABLE tax_return ADD COLUMN acknowledged_gates text[] NOT NULL DEFAULT '{}';
