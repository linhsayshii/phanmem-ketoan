# Giai đoạn 7: Sổ hộ kinh doanh và doanh nghiệp siêu nhỏ

Phần mềm hỗ trợ hai chế độ kế toán không có hệ thống tài khoản: Thông tư 152/2025/TT-BTC (hộ kinh doanh, cá nhân kinh doanh, hiệu lực 01/01/2026) và Thông tư 58/2026/TT-BTC (doanh nghiệp siêu nhỏ, hiệu lực 01/7/2026, thay Thông tư 132/2018/TT-BTC; hộ kinh doanh cũng được chọn áp dụng). Mẫu sổ, cột và công thức nhập từ văn bản gốc (Thông tư 58 từ Công báo số 323; Thông tư 152 từ bản ký số của Bộ Tài chính). Hai chế độ này ghi sổ theo nhóm thuế, không dùng chứng từ ghi sổ bút toán kép, không dùng chung với phiếu thu, phiếu chi, kho, tài sản, lương của chế độ kế toán doanh nghiệp.

## Xem tình trạng các chế độ

Menu **Hệ thống > Chế độ kế toán**. TT 152/2025 và TT 58/2026 hiện **Dùng được, còn giới hạn**. Bấm mũi tên đầu dòng để xem phần nào đã nhập, giới hạn hiện tại và văn bản còn thiếu:

- Thông tư không có hệ thống tài khoản và (với Thông tư 152) không có báo cáo tài chính: hiện "Thông tư không có".
- Thông tư 152 còn thiếu mẫu tờ khai 01/CNKD và Nghị định 68/2026 (ngưỡng doanh thu, tỷ lệ thuế theo ngành): phần mềm chưa tự tính thuế theo ngành nghề.
- Thông tư 58 đã có đủ sổ S4a (công nợ), S4b (tài sản cố định), S4d (vốn chủ sở hữu), báo cáo B01-DNSN và bốn chứng từ; B01-DNSN lập từ sổ ghi đơn nên **không bảo đảm tổng tài sản bằng tổng nguồn vốn** (báo cáo nêu số chênh lệch để bạn rà soát).

## Tạo công ty và năm tài chính

Ở **Tạo công ty mới**, bước năm tài chính, chọn Chế độ kế toán TT 152/2025 hoặc TT 58/2026: màn hình nêu rõ chế độ ghi sổ theo nhóm thuế và các giới hạn. Bấm Hoàn tất chỉ tạo các kỳ kế toán, không sinh hệ thống tài khoản. Thông tư 58 áp dụng cho năm tài chính bắt đầu từ 01/7/2026 trở đi. Mỗi công ty ghi một chế độ cho một năm tài chính.

## Sổ hộ kinh doanh, doanh nghiệp siêu nhỏ

Menu **Sổ HKD, siêu nhỏ**. Các bước:

1. **Cài đặt năm**: chọn phương pháp nộp thuế của năm (Điều 4 đến 6 Thông tư 152; Điều 5 đến 8 Thông tư 58). Phương pháp quyết định các sổ bắt buộc; danh mục ở tab Sổ và báo cáo đánh dấu "bắt buộc". Nhập thuế suất trên thu nhập tính thuế (TNCN của hộ, TNDN của doanh nghiệp) nếu dùng phương pháp tính trên thu nhập.
2. **Nhóm ngành nghề**: mỗi nhóm hàng hóa, dịch vụ, ngành nghề có cùng tỷ lệ % tính thuế. Tự nhập tỷ lệ thuế GTGT và TNCN/TNDN (ví dụ 1,5) theo văn bản thuế hiện hành; **phần mềm không đặt sẵn tỷ lệ**. Nhóm chưa khai tỷ lệ thì thuế tính 0 và sổ in có chú thích.
3. **Ghi sổ**: chọn loại (doanh thu theo nhóm, thu nhập khác, chi phí theo khoản mục a đến e, thuế đã nộp, thuế GTGT đầu vào/đầu ra/được hoàn của doanh nghiệp siêu nhỏ, thu, chi tiền, số dư đầu), ngày, số chứng từ, diễn giải, số tiền; nhập Enter để ghi. Nhập tiền mặt là `TM`, tiền gửi là tên ngân hàng ở ô "Tiền": bút ghi có ô này sẽ lên Sổ chi tiết tiền. Bút ghi sửa, xóa được (có nhật ký kiểm toán).
4. **Kho**: khai mặt hàng, ghi tồn đầu, nhập, xuất cho Sổ chi tiết vật liệu, dụng cụ, sản phẩm, hàng hóa. Dòng xuất chỉ nhập số lượng; đơn giá xuất tính theo công thức của thông tư theo từng tháng.
5. **Thuế khác**: thuế xuất khẩu, nhập khẩu, tiêu thụ đặc biệt, bảo vệ môi trường, tài nguyên, sử dụng đất cho Sổ theo dõi nghĩa vụ thuế khác. Nhập thuế suất theo phần trăm.
6. **Công nợ** (chỉ doanh nghiệp siêu nhỏ, Thông tư 58): ghi số dư đầu, khoản phải thu hoặc phải trả phát sinh, số đã thu hoặc đã trả theo từng đối tượng (khách hàng, người bán, vay, tạm ứng, ký quỹ...). Nghĩa vụ thuế khác (thuế TNCN, xuất nhập khẩu, tiêu thụ đặc biệt...; **không gồm** GTGT, TNDN) chọn tính chất "Nghĩa vụ thuế", bên phải trả; giữ cùng tính chất khi ghi số đã nộp.
7. **Tài sản cố định**: ghi tăng từng tài sản (loại, tên, ngày ghi tăng, tháng đưa vào sử dụng, nguyên giá, tỷ lệ khấu hao năm) và **Ghi giảm** khi thanh lý, nhượng bán. Khấu hao tính đường thẳng tròn tháng: từ tháng đưa vào sử dụng, thôi từ tháng ghi giảm, tháng chưa kết thúc ở ngày cuối kỳ chưa tính. Thông tư không nêu cách tính này; kế toán xác nhận trước khi dùng.
8. **Vốn chủ sở hữu**: ghi số dư đầu và tăng, giảm của vốn góp, lợi nhuận sau thuế chưa phân phối, các quỹ. Lỗ lũy kế đầu kỳ nhập số âm (ví dụ -2.000.000) ở số dư đầu của lợi nhuận chưa phân phối. **Lợi nhuận sau thuế của năm không tự kết chuyển**: ghi tăng vào đây thì mới vào B01-DNSN.
9. **Tài sản khác**: tiền gửi có kỳ hạn, tiền gửi tiết kiệm... (mã 150 của B01-DNSN). Thuế TNDN nộp thừa so với phải nộp được cộng vào mã 150 tự động.
10. **Sổ và báo cáo**: chọn sổ, khoảng ngày, bấm Xem sổ, In PDF hoặc Xuất Excel (khuôn mẫu in có ký hiệu mẫu số, chú thích thông tư, chữ ký theo mẫu).

### Các sổ đã dựng

| Chế độ | Sổ |
|---|---|
| TT 152/2025 | S1a-HKD, S2a-HKD, S2b-HKD, S2c-HKD, S2d-HKD, S2e-HKD, S3a-HKD |
| TT 58/2026 | S1-DNSN, S2a-DNSN, S2b-DNSN, S2c-DNSN, S2d-DNSN, S3a-DNSN, S3b-DNSN, S4a-DNSN, S4b-DNSN, S4c-DNSN, S4d-DNSN; báo cáo B01-DNSN, B02-DNSN; chứng từ 01-TT, 02-TT, 01-VT, 02-VT |

Cách tính chính:

- Thuế GTGT, TNCN, TNDN của từng nhóm = doanh thu nhóm x tỷ lệ đã khai, làm tròn nửa lên đến đồng; "Tổng số thuế phải nộp" là tổng các nhóm.
- Sổ chi tiết doanh thu, chi phí: chênh lệch = doanh thu (và thu nhập khác với doanh nghiệp) - chi phí; thuế = chênh lệch x thuế suất đã khai (0 khi lỗ).
- Số thuế còn phải nộp đầu kỳ = số dư đầu bạn nhập + thuế phát sinh các kỳ trước - thuế đã nộp các kỳ trước. Nhập số dư đầu ở tab Ghi sổ, loại "Số dư đầu", ngày không sau ngày bắt đầu sổ, và đừng ghi bút nào cùng khoản trước ngày đó.
- Sổ theo dõi nghĩa vụ thuế GTGT: lấy số dư ròng (đầu ra trừ đầu vào, đã nộp, đã hoàn); còn được khấu trừ hoặc còn phải nộp cuối kỳ chỉ hiện một bên.
- B02-DNSN: 01 = doanh thu và thu nhập, 02 = chi phí, 03 = 01 - 02, 10 = thuế TNDN (tính như Sổ chi tiết doanh thu, chi phí), 20 = 03 - 10, so với năm trước.
- S4a: mỗi đối tượng một sổ; cột 3 và 6 là số còn lại sau từng dòng (đầu kỳ + phát sinh - đã thu, đã trả).
- S4b: mỗi loại tài sản một sổ; khấu hao lũy kế = nguyên giá x tỷ lệ năm x số tháng / 12, làm tròn đến đồng, không vượt nguyên giá; dòng Cộng chỉ cộng mức khấu hao và khấu hao lũy kế (theo mẫu, ô Nguyên giá của dòng Cộng là x).
- S4d: ba phần (vốn góp, lợi nhuận sau thuế chưa phân phối, các quỹ), mỗi phần có số dư đầu kỳ, phát sinh tăng, giảm và số dư cuối kỳ.
- B01-DNSN: ngày lập là ngày cuối của khoảng chọn; số đầu năm và thuế phát sinh luôn tính từ đầu năm tài chính chứa ngày lập (khoảng chọn một tháng vẫn cho cùng kết quả như chọn cả năm). 110 = số dư cuối kỳ Sổ chi tiết tiền; 120 = nợ phải thu ở S4a và thuế GTGT còn được khấu trừ; 130 = tồn kho cuối kỳ ở sổ vật tư, hàng hóa; 140 = nguyên giá trừ khấu hao lũy kế của tài sản chưa ghi giảm; 150 = tài sản khác và thuế TNDN nộp thừa; 310 = nợ phải trả ở S4a; 320 = thuế GTGT, TNDN còn phải nộp và nghĩa vụ thuế khác ghi ở S4a; 410, 420, 430 = số dư cuối kỳ S4d. Cột "Số đầu năm" gồm các bút "Số dư đầu" ghi đến hết ngày đầu năm và mọi phát sinh trước ngày đầu năm. Cần chọn phương pháp nộp thuế của năm ở tab Cài đặt năm. Nếu tổng tài sản (200) khác tổng nguồn vốn (500), bản in có chú thích nêu số chênh lệch: kiểm tra lại số dư đầu của các sổ và đã ghi tăng lợi nhuận sau thuế vào S4d chưa.
- Sổ vật tư: đơn giá xuất kho bình quân từng tháng = (giá trị tồn đầu tháng + giá trị nhập trong tháng) / (số lượng tồn đầu tháng + số lượng nhập trong tháng).

### In chứng từ (Thông tư 58)

Ở tab **Ghi sổ**, bút ghi thu tiền mặt (ô tiền `TM`) có nút **In phiếu** cho Phiếu thu 01-TT, bút ghi chi tiền mặt cho Phiếu chi 02-TT. Ở tab **Kho**, dòng nhập có nút In phiếu cho Phiếu nhập kho 01-VT, dòng xuất cho Phiếu xuất kho 02-VT; một phiếu gồm mọi dòng cùng số chứng từ, nên nhập chung một số chứng từ cho các mặt hàng cùng phiếu. Hộp thoại hỏi thêm tên người nộp, nhận hoặc giao hàng, địa chỉ, lý do, số chứng từ gốc kèm theo...: thông tin này chỉ dùng cho bản in, không lưu; để trống thì bản in chừa chấm chấm. Cột "Theo chứng từ" (phiếu nhập) và "Yêu cầu" (phiếu xuất) để trống vì phần mềm chỉ lưu một số lượng, ghi ở cột thực nhập, thực xuất. Cần quyền in báo cáo.

## Hạn chế cần biết

- **B01-DNSN không tự cân đối.** Sổ ghi đơn không có bút toán đối ứng, nên tổng tài sản có thể khác tổng nguồn vốn; phần mềm tính từng mã đúng theo sổ và nêu chênh lệch, không điền số cho khớp.
- **Nghĩa vụ thuế khác trong B01** chỉ lấy từ S4a (bên phải trả, tính chất Nghĩa vụ thuế); S4c-DNSN chỉ tính số thuế phải nộp nên không cộng vào mã 320.

- **Thuế còn phải nộp đầu kỳ tính lại bằng tỷ lệ hiện hành.** Số thuế phát sinh của các kỳ trước được tính lại theo tỷ lệ thuế và phương pháp nộp thuế đang khai báo cho năm, không theo tỷ lệ tại thời điểm đó. Nếu đổi tỷ lệ giữa năm, số "còn phải nộp đầu kỳ" của kỳ sau đổi theo và bản in kỳ cũ có thể khác bản đã in trước đó. Cần đổi tỷ lệ thì nên đổi đầu năm, hoặc nhập số dư đầu kỳ bằng tay.
- **Cờ dữ liệu nhạy cảm và khóa kỳ.** Công nợ phải thu cần cờ xem công nợ phải thu, công nợ phải trả cần cờ xem công nợ phải trả (danh sách, sổ S4a, ghi, sửa, xóa); thiếu cờ thì bên đó bị ẩn hoặc trả 403. Sổ kho (S2d-HKD, S2c-DNSN) và Phiếu nhập kho, Phiếu xuất kho (01-VT, 02-VT) cần cờ xem giá vốn; thiếu cờ thì danh sách nhập, xuất không hiện đơn giá, không ghi hay xóa được dòng nhập kho, tồn đầu (dòng xuất vẫn ghi được). Sổ doanh thu, chi phí, sổ tiền, sổ thuế, B01-DNSN và B02-DNSN không gắn cờ (như B01, B02 của sổ cái). Bút ghi sổ (doanh thu, chi phí, tiền, kho, thuế khác, công nợ, vốn, tài sản khác, TSCĐ) ở ngày thuộc kỳ đã khóa sổ không thêm, sửa, xóa được, trừ người có quyền ghi lùi ngày; kỳ khóa cứng chặn mọi người. Sửa kiểm cả ngày cũ và ngày mới; thẻ TSCĐ mua ở kỳ đã khóa vẫn ghi giảm được ở kỳ đang mở. Nhóm ngành nghề (tỷ lệ thuế) và cài đặt năm không theo kỳ nên không bị khóa: đổi tỷ lệ vẫn làm đổi số thuế của kỳ cũ (xem hạn chế về thuế phải nộp đầu kỳ).
- **Kiểm tra tệp PDF hóa đơn chỉ là lớp phụ.** Phần mềm chặn PDF có mã chạy ngầm bằng cách dò nội dung thô của tệp; không thay cho phần mềm diệt virus và không phát hiện nội dung nén hoặc mã hóa.

## Cảnh báo ngưỡng doanh thu (hộ kinh doanh, Thông tư 152)

Ở tab **Sổ và báo cáo**, khi công ty theo Thông tư 152, phần mềm so tổng doanh thu đã ghi sổ trong năm tài chính với các ngưỡng của Nghị định 68/2026/NĐ-CP (sửa bởi Nghị định 141/2026/NĐ-CP): 1 tỷ đồng (hết miễn thuế GTGT, TNCN và phải dùng hóa đơn điện tử), 3 tỷ đồng (phương pháp tính thuế trên thu nhập tính thuế) và 50 tỷ đồng/tháng (khai thuế GTGT theo tháng). Đây chỉ là cảnh báo để kế toán rà soát: doanh thu là doanh thu **trên sổ**, chưa gồm phần tổ chức khấu trừ hay nộp thay nếu chưa ghi sổ, và chưa loại doanh thu cho thuê bất động sản. Ngưỡng là dữ liệu pháp lý theo ngày hiệu lực; năm chưa có tham số thì phần mềm nói rõ "Chưa có tham số".

## Chưa có

Tờ khai 01/TKN-CNKD (Thông báo doanh thu/Tờ khai thuế năm, thay mẫu 01/CNKD theo Thông tư 89/2026): định nghĩa mẫu và các mã chỉ tiêu đã nhập từ văn bản gốc nhưng chưa có chức năng lập, chốt, xuất tờ khai từ sổ; tự tính thuế theo ngành nghề (tỷ lệ GTGT và TNCN theo ngành chưa nhập vì chưa có văn bản gốc đọc được), hóa đơn từ máy tính tiền, nhập số dư đầu từ Thông tư 132/2018 (Điều 11) bằng chức năng riêng: hiện nhập tay từng bút "Số dư đầu" ở từng sổ. Chi tiết: mục "GĐ7 nhóm 6 — Chờ người dùng" trong `docs/TIEP-THEO.md`.
