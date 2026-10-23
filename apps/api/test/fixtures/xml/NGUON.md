# Mẫu XML hóa đơn điện tử cho kiểm thử

Hai tệp lấy nguyên văn từ repo `ngoquangthanhphu/vn-einvoice` (`test/fixtures/invoice-vat.xml` đổi tên thành `vn-einvoice-vat.xml`; `test/fixtures/invoice-cash-register.xml` đổi tên thành `vn-einvoice-cashreg.xml`).

- Giấy phép: MIT. Dòng bản quyền của repo gốc (LICENSE): `Copyright (c) 2026 Ngo Quang Thanh Phu`. Điều kiện MIT: giữ thông báo bản quyền và giấy phép khi phân phối bản sao đáng kể; hai tệp XML này chỉ dùng làm dữ liệu kiểm thử.
- Dữ liệu tổng hợp, không phải bản xuất từ nhà cung cấp (không phải SInvoice, MISA, VNPT, BKAV). Tên, MST, địa chỉ, `MCCQT` đều giả. Không có dữ liệu cá nhân thật.
- Phiên bản thông điệp trong tệp là `2.0.1` (theo QĐ 1450/TT78), không phải `2.1.0` hay `2.1.1`.
- Không có chữ ký số (không có `DSCKS`/`ds:Signature`), không có `TTKhac`, `TTHDLQuan`, `THTTLTSuat`, `MSTTCGP`, `THDon`. Chi tiết khác biệt với QĐ 1233: `docs/dev/tich-hop/xml-hoa-don.md` mục 7.
- Cần thay hoặc bổ sung bằng tệp lấy từ môi trường thử của nhà cung cấp (SInvoice, MISA, VNPT, BKAV) khi có tài khoản.

## Giá trị kỳ vọng (đọc từ chính XML)

### vn-einvoice-vat.xml

Cấu trúc: `HDon/DLHDon[@Id="data"]` trực tiếp dưới `HDon`; `HDon/MCCQT[@Id="data"]`.

| Chỉ tiêu | Thẻ | Giá trị |
|---|---|---|
| Phiên bản | `TTChung/PBan` | `2.0.1` |
| Ký hiệu mẫu số | `TTChung/KHMSHDon` | `1` |
| Ký hiệu hóa đơn | `TTChung/KHHDon` | `C26TAA` |
| Số hóa đơn | `TTChung/SHDon` | `00000123` (chuỗi, giữ số 0 đầu) |
| Ngày lập | `TTChung/NLap` | `2026-01-15` |
| Đơn vị tiền tệ | `TTChung/DVTTe/Ma` | `VND` (mẫu có thẻ con `Ma`, `Ten`) |
| Hình thức thanh toán | `TTChung/HTTToan` | `TM/CK` |
| MST người bán | `NBan/MST` | `0100000001` |
| MST người mua | `NMua/MST` | `0300000002` |
| Tổng tiền trước thuế | `TToan/TgTCThue` | `1300000` |
| Tổng tiền thuế | `TToan/TgTThue` | `130000` |
| Tổng thanh toán | `TToan/TgTTTBSo` | `1430000` |
| Bằng chữ | `TToan/TgTTTBChu` | `Một triệu bốn trăm ba mươi nghìn đồng` |
| Số dòng hàng | `DSHHDVu/HHDVu` | `2` |
| Dòng 1 | `STT` 1, `MHHDVu` SP001, `SLuong` 20, `DGia` 50000, `ThTien` 1000000 | `TSuat` = `10%` |
| Dòng 2 | `STT` 2, `MHHDVu` DV001, `SLuong` 1, `DGia` 300000, `ThTien` 300000 | `TSuat` = `10%` |
| Mã CQT | `HDon/MCCQT` | `00A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5` (32 ký tự, giả) |

Nhất quán số học: 1.000.000 + 300.000 = 1.300.000; 10% = 130.000; tổng 1.430.000. Mọi dòng `TChat` = `1`, `TLCKhau` = `0`, `STCKhau` = `0`.

### vn-einvoice-cashreg.xml

Cấu trúc: `HDon/DLieu/DLHDon[@Id="data"]` (có thêm lớp `DLieu` bên trong `HDon`; lệch với QĐ 1233, nơi `DLieu` nằm ở `TDiep`); `HDon/MCCQT[@Id="data"]` vẫn ở ngoài `DLieu`.

| Chỉ tiêu | Thẻ | Giá trị |
|---|---|---|
| Phiên bản | `TTChung/PBan` | `2.0.1` |
| Ký hiệu mẫu số | `TTChung/KHMSHDon` | `1` |
| Ký hiệu hóa đơn | `TTChung/KHHDon` | `C26MAA` |
| Số hóa đơn | `TTChung/SHDon` | `00000456` |
| Ngày lập | `TTChung/NLap` | `2026-02-02` |
| Đơn vị tiền tệ | `TTChung/DVTTe/Ma` | `VND` |
| Hình thức thanh toán | `TTChung/HTTToan` | `TM` |
| MST người bán | `NBan/MST` | `0400000003` |
| Người mua | `NMua/Ten`, `MST`, `DChi` | thẻ rỗng (bán cho người tiêu dùng, không có thông tin) |
| Tổng tiền trước thuế | `TToan/TgTCThue` | `540000` |
| Tổng tiền thuế | `TToan/TgTThue` | `43200` |
| Tổng thanh toán | `TToan/TgTTTBSo` | `583200` |
| Bằng chữ | `TToan/TgTTTBChu` | `Năm trăm tám mươi ba nghìn hai trăm đồng` |
| Số dòng hàng | `DSHHDVu/HHDVu` | `1` |
| Dòng 1 | `STT` 1, `THHDVu` "Nước uống đóng chai 500ml", `DVTinh` Chai, `SLuong` 90, `DGia` 6000, `ThTien` 540000 | `TSuat` = `8%` (không có `MHHDVu`) |
| Mã CQT | `HDon/MCCQT` | `00F1E2D3C4B5A69788796A5B4C3D2E1F` (32 ký tự, giả; mã máy tính tiền thật có 23 ký tự dạng `M2-26-A1B2C-00001234567`) |

Nhất quán số học: 90 x 6.000 = 540.000; 8% = 43.200; tổng 583.200.
