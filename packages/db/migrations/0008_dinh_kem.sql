-- Đính kèm chứng từ: bảng đã có từ 0004; ghi nhật ký kiểm toán và chỉ mục tra theo chứng từ.
SELECT audit_enable('voucher_attachment');
CREATE INDEX ON voucher_attachment (tenant_id, voucher_id);
