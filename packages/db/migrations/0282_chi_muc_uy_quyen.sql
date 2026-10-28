-- 0282_chi_muc_uy_quyen.sql: GĐ7 gói ủy quyền duyệt — chỉ mục dẫn đầu cho khóa ngoại (tenant_id, on_behalf_of) của 0281 (xóa/đổi người dùng không quét tuần tự nhật ký bước).
CREATE INDEX IF NOT EXISTS approval_step_log_on_behalf_of_idx ON approval_step_log (tenant_id, on_behalf_of) WHERE on_behalf_of IS NOT NULL;
