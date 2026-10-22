-- GĐ3 Task 6: loại chứng từ kho PNK, PXK, CK. Thân seed_voucher_types lấy từ bản hiện hành (0025), thêm 3 loại; công ty đã có được bổ sung (tắt audit như 0025).
CREATE OR REPLACE FUNCTION seed_voucher_types(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO voucher_type(tenant_id, code, name, module, prefix, is_system) VALUES
    (p_tenant, 'PKT', 'Phiếu kế toán', 'general', 'PKT', true),
    (p_tenant, 'DK', 'Số dư đầu kỳ', 'general', 'DK', true),
    (p_tenant, 'KC', 'Chứng từ kết chuyển', 'general', 'KC', true),
    (p_tenant, 'PB', 'Chứng từ phân bổ', 'general', 'PB', true),
    (p_tenant, 'PT', 'Phiếu thu', 'cash', 'PT', true),
    (p_tenant, 'PC', 'Phiếu chi', 'cash', 'PC', true),
    (p_tenant, 'BC', 'Giấy báo Có', 'bank', 'BC', true),
    (p_tenant, 'BN', 'Giấy báo Nợ (in Ủy nhiệm chi)', 'bank', 'BN', true),
    (p_tenant, 'CT', 'Chuyển tiền nội bộ', 'bank', 'CT', true),
    (p_tenant, 'QTU', 'Quyết toán tạm ứng', 'general', 'QTU', true),
    (p_tenant, 'BT', 'Bù trừ công nợ', 'arap', 'BT', true),
    (p_tenant, 'HDB', 'Hóa đơn bán dịch vụ', 'arap', 'HDB', true),
    (p_tenant, 'HDM', 'Hóa đơn mua dịch vụ', 'arap', 'HDM', true),
    (p_tenant, 'GGB', 'Giảm giá, trả lại dịch vụ bán', 'arap', 'GGB', true),
    (p_tenant, 'GGM', 'Giảm giá, trả lại dịch vụ mua', 'arap', 'GGM', true),
    (p_tenant, 'CL', 'Chênh lệch tỷ giá đối trừ', 'arap', 'CL', true),
    (p_tenant, 'DG', 'Đánh giá lại ngoại tệ', 'general', 'DG', true),
    (p_tenant, 'XQ', 'Điều chỉnh tỷ giá xuất quỹ', 'general', 'XQ', true),
    (p_tenant, 'KTT', 'Khấu trừ thuế GTGT', 'general', 'KTT', true),
    (p_tenant, 'PNK', 'Phiếu nhập kho', 'inventory', 'PNK', true),
    (p_tenant, 'PXK', 'Phiếu xuất kho', 'inventory', 'PXK', true),
    (p_tenant, 'CK', 'Phiếu chuyển kho', 'inventory', 'CK', true)
  ON CONFLICT DO NOTHING;
$$;
ALTER TABLE voucher_type DISABLE TRIGGER trg_audit;
SELECT seed_voucher_types(id) FROM tenant;
ALTER TABLE voucher_type ENABLE TRIGGER trg_audit;
