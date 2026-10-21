-- GĐ2 Task 24: nhóm kê khai ở đầu hóa đơn, lưu riêng với nhóm theo từng dòng thuế.
-- invoice_group_id của dòng là nhóm kê khai của dòng thuế (hóa đơn bán ra nhiều thuế suất mỗi thuế suất một nhóm); trước đây màn hình hóa đơn đọc nhóm đầu từ dòng đầu tiên nên hóa đơn KTGT/NPV
-- có dòng thuế suất đứng trước khi mở lại và lưu lại sẽ đổi nhóm của dòng không thuế (KCT) sang nhóm của dòng đầu.
-- header_group_id là nhóm người dùng chọn ở đầu hóa đơn. Hóa đơn bán ra (HDB, GGB): cùng giá trị trên mọi dòng của chứng từ. Hóa đơn mua khai trên PC/BN/PKT: mỗi hóa đơn một nhóm riêng nên bằng invoice_group_id của chính dòng.
ALTER TABLE voucher_invoice ADD COLUMN header_group_id bigint;
ALTER TABLE voucher_invoice ADD FOREIGN KEY (tenant_id, header_group_id) REFERENCES invoice_group(tenant_id, id);
-- Điền bù theo hành vi cũ. Bán ra: nhóm của dòng đầu tiên (id nhỏ nhất) của chứng từ. Mua vào: nhóm của chính dòng (một chứng từ tiền có thể khai nhiều hóa đơn, mỗi hóa đơn một nhóm).
-- Tắt trigger người dùng (nhật ký, chặn sửa dòng con) cho lần điền bù: migration không có người dùng, như 0034.
ALTER TABLE voucher_invoice DISABLE TRIGGER USER;
UPDATE voucher_invoice SET header_group_id = invoice_group_id WHERE direction = 'purchase';
UPDATE voucher_invoice i SET header_group_id = f.invoice_group_id
  FROM (SELECT DISTINCT ON (tenant_id, voucher_id) tenant_id, voucher_id, invoice_group_id FROM voucher_invoice WHERE direction = 'sale' ORDER BY tenant_id, voucher_id, id) f
  WHERE f.tenant_id = i.tenant_id AND f.voucher_id = i.voucher_id AND i.direction = 'sale';
ALTER TABLE voucher_invoice ENABLE TRIGGER USER;
