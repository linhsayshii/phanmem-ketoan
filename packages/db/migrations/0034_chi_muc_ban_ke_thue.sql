-- GĐ2 Task 22: kiểu kỳ kê khai theo từng dòng hóa đơn. declare_period là tháng 1-12 hoặc quý 1-4 tùy cài đặt vat_period tại lúc lập; công ty đổi tháng/quý giữa các năm
-- nên bảng kê đọc đơn vị của chính dòng, không đọc cài đặt hiện tại. Dòng đã có điền bù theo cài đặt hiện tại (chưa đặt cài đặt = tháng).
-- Không tạo chỉ mục theo kỳ: kỳ hiệu lực tính từ kiểu, kỳ khai và ngày ghi sổ của chứng từ đảo nên chỉ mục không dùng được.
ALTER TABLE voucher_invoice ADD COLUMN declare_period_kind text NOT NULL DEFAULT 'month' CHECK (declare_period_kind IN ('month', 'quarter'));
-- Kỳ quý chỉ 1-4 (declare_period null thì CHECK đạt).
ALTER TABLE voucher_invoice ADD CONSTRAINT voucher_invoice_quarter_range CHECK (declare_period_kind <> 'quarter' OR declare_period <= 4);
-- Tắt trigger người dùng (nhật ký, chặn sửa dòng con) cho lần điền bù: migration không có người dùng, như 0025/0031.
ALTER TABLE voucher_invoice DISABLE TRIGGER USER;
UPDATE voucher_invoice i SET declare_period_kind = 'quarter'
  WHERE EXISTS (SELECT 1 FROM tenant_setting s WHERE s.tenant_id = i.tenant_id AND s.key = 'vat_period' AND s.value = '"quarter"'::jsonb)
  AND (i.declare_period IS NULL OR i.declare_period <= 4); -- dòng có kỳ 5-12 chắc chắn lập theo tháng
ALTER TABLE voucher_invoice ENABLE TRIGGER USER;
