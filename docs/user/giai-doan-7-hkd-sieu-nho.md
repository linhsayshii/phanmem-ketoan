# Giai đoạn 7: Sổ hộ kinh doanh và doanh nghiệp siêu nhỏ

Phần mềm hỗ trợ hai chế độ kế toán không có hệ thống tài khoản: Thông tư 152/2025/TT-BTC (hộ kinh doanh, cá nhân kinh doanh, hiệu lực 01/01/2026) và Thông tư 58/2026/TT-BTC (doanh nghiệp siêu nhỏ, hiệu lực 01/7/2026, thay Thông tư 132/2018/TT-BTC; hộ kinh doanh cũng được chọn áp dụng). Mẫu sổ, cột và công thức nhập từ văn bản gốc (Thông tư 58 từ Công báo số 323; Thông tư 152 từ bản ký số của Bộ Tài chính). Hai chế độ này ghi sổ theo nhóm thuế, không dùng chứng từ ghi sổ bút toán kép, không dùng chung với phiếu thu, phiếu chi, kho, tài sản, lương của chế độ kế toán doanh nghiệp.

## Xem tình trạng các chế độ

Menu **Hệ thống > Chế độ kế toán**. TT 152/2025 và TT 58/2026 hiện **Dùng được, còn giới hạn**. Bấm mũi tên đầu dòng để xem phần nào đã nhập, giới hạn hiện tại và văn bản còn thiếu:

- Thông tư không có hệ thống tài khoản và (với Thông tư 152) không có báo cáo tài chính: hiện "Thông tư không có".
- Thông tư 152 còn thiếu mẫu tờ khai 01/CNKD và Nghị định 68/2026 (ngưỡng doanh thu, tỷ lệ thuế theo ngành): phần mềm chưa tự tính thuế theo ngành nghề.
- Thông tư 58 chưa lập được B01-DNSN, chưa có sổ S4a (công nợ), S4b (tài sản cố định), S4d (vốn chủ sở hữu).

## Tạo công ty và năm tài chính

Ở **Tạo công ty mới**, bước năm tài chính, chọn Chế độ kế toán TT 152/2025 hoặc TT 58/2026: màn hình nêu rõ chế độ ghi sổ theo nhóm thuế và các giới hạn. Bấm Hoàn tất chỉ tạo các kỳ kế toán, không sinh hệ thống tài khoản. Thông tư 58 áp dụng cho năm tài chính bắt đầu từ 01/7/2026 trở đi. Mỗi công ty ghi một chế độ cho một năm tài chính.

## Sổ hộ kinh doanh, doanh nghiệp siêu nhỏ

Menu **Sổ HKD, siêu nhỏ**. Các bước:

1. **Cài đặt năm**: chọn phương pháp nộp thuế của năm (Điều 4 đến 6 Thông tư 152; Điều 5 đến 8 Thông tư 58). Phương pháp quyết định các sổ bắt buộc; danh mục ở tab Sổ và báo cáo đánh dấu "bắt buộc". Nhập thuế suất trên thu nhập tính thuế (TNCN của hộ, TNDN của doanh nghiệp) nếu dùng phương pháp tính trên thu nhập.
2. **Nhóm ngành nghề**: mỗi nhóm hàng hóa, dịch vụ, ngành nghề có cùng tỷ lệ % tính thuế. Tự nhập tỷ lệ thuế GTGT và TNCN/TNDN (ví dụ 1,5) theo văn bản thuế hiện hành; **phần mềm không đặt sẵn tỷ lệ**. Nhóm chưa khai tỷ lệ thì thuế tính 0 và sổ in có chú thích.
3. **Ghi sổ**: chọn loại (doanh thu theo nhóm, thu nhập khác, chi phí theo khoản mục a đến e, thuế đã nộp, thuế GTGT đầu vào/đầu ra/được hoàn của doanh nghiệp siêu nhỏ, thu, chi tiền, số dư đầu), ngày, số chứng từ, diễn giải, số tiền; nhập Enter để ghi. Nhập tiền mặt là `TM`, tiền gửi là tên ngân hàng ở ô "Tiền": bút ghi có ô này sẽ lên Sổ chi tiết tiền. Bút ghi sửa, xóa được (có nhật ký kiểm toán).
4. **Kho**: khai mặt hàng, ghi tồn đầu, nhập, xuất cho Sổ chi tiết vật liệu, dụng cụ, sản phẩm, hàng hóa. Dòng xuất chỉ nhập số lượng; đơn giá xuất tính theo công thức của thông tư theo từng tháng.
5. **Thuế khác**: thuế xuất khẩu, nhập khẩu, tiêu thụ đặc biệt, bảo vệ môi trường, tài nguyên, sử dụng đất cho Sổ theo dõi nghĩa vụ thuế khác. Nhập thuế suất theo phần trăm.
6. **Sổ và báo cáo**: chọn sổ, khoảng ngày, bấm Xem sổ, In PDF hoặc Xuất Excel (khuôn mẫu in có ký hiệu mẫu số, chú thích thông tư, chữ ký theo mẫu).

### Các sổ đã dựng

| Chế độ | Sổ |
|---|---|
| TT 152/2025 | S1a-HKD, S2a-HKD, S2b-HKD, S2c-HKD, S2d-HKD, S2e-HKD, S3a-HKD |
| TT 58/2026 | S1-DNSN, S2a-DNSN, S2b-DNSN, S2c-DNSN, S2d-DNSN, S3a-DNSN, S3b-DNSN, S4c-DNSN, báo cáo B02-DNSN |
| Chưa dựng | S4a-DNSN, S4b-DNSN, S4d-DNSN, B01-DNSN (đã nhập định nghĩa cột và chỉ tiêu, chưa tính được) |

Cách tính chính:

- Thuế GTGT, TNCN, TNDN của từng nhóm = doanh thu nhóm x tỷ lệ đã khai, làm tròn nửa lên đến đồng; "Tổng số thuế phải nộp" là tổng các nhóm.
- Sổ chi tiết doanh thu, chi phí: chênh lệch = doanh thu (và thu nhập khác với doanh nghiệp) - chi phí; thuế = chênh lệch x thuế suất đã khai (0 khi lỗ).
- Số thuế còn phải nộp đầu kỳ = số dư đầu bạn nhập + thuế phát sinh các kỳ trước - thuế đã nộp các kỳ trước. Nhập số dư đầu ở tab Ghi sổ, loại "Số dư đầu", ngày không sau ngày bắt đầu sổ, và đừng ghi bút nào cùng khoản trước ngày đó.
- Sổ theo dõi nghĩa vụ thuế GTGT: lấy số dư ròng (đầu ra trừ đầu vào, đã nộp, đã hoàn); còn được khấu trừ hoặc còn phải nộp cuối kỳ chỉ hiện một bên.
- B02-DNSN: 01 = doanh thu và thu nhập, 02 = chi phí, 03 = 01 - 02, 10 = thuế TNDN (tính như Sổ chi tiết doanh thu, chi phí), 20 = 03 - 10, so với năm trước.
- Sổ vật tư: đơn giá xuất kho bình quân từng tháng = (giá trị tồn đầu tháng + giá trị nhập trong tháng) / (số lượng tồn đầu tháng + số lượng nhập trong tháng).

## Hạn chế cần biết

- **Thuế còn phải nộp đầu kỳ tính lại bằng tỷ lệ hiện hành.** Số thuế phát sinh của các kỳ trước được tính lại theo tỷ lệ thuế và phương pháp nộp thuế đang khai báo cho năm, không theo tỷ lệ tại thời điểm đó. Nếu đổi tỷ lệ giữa năm, số "còn phải nộp đầu kỳ" của kỳ sau đổi theo và bản in kỳ cũ có thể khác bản đã in trước đó. Cần đổi tỷ lệ thì nên đổi đầu năm, hoặc nhập số dư đầu kỳ bằng tay.
- **Sổ chưa áp cờ dữ liệu nhạy cảm và chưa khóa kỳ.** Người có quyền xem sổ hộ kinh doanh thấy mọi sổ; người có quyền sửa, xóa sửa được bút ghi ở mọi ngày. Hãy cấp quyền `sohkd.*` cẩn thận.
- **Kiểm tra tệp PDF hóa đơn chỉ là lớp phụ.** Phần mềm chặn PDF có mã chạy ngầm bằng cách dò nội dung thô của tệp; không thay cho phần mềm diệt virus và không phát hiện nội dung nén hoặc mã hóa.

## Chưa có

Tờ khai 01/CNKD (chưa có văn bản gốc của mẫu), tự tính thuế theo ngành nghề và ngưỡng doanh thu của hộ kinh doanh (chờ Nghị định 68/2026), hóa đơn từ máy tính tiền, chứng từ 01-TT, 02-TT, 01-VT, 02-VT của Thông tư 58, B01-DNSN và các sổ S4a, S4b, S4d. Chi tiết: mục "GĐ7 nhóm 6 — Chờ người dùng" trong `docs/TIEP-THEO.md`.
