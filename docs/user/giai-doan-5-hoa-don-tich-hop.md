# Giai đoạn 5: Hóa đơn điện tử, ký số, hóa đơn đầu vào, ngân hàng, VietQR, thuế TNDN và khóa API

Giai đoạn này nối sổ cái với các hệ thống bên ngoài. Phần mềm phát hành hóa đơn điện tử (HĐĐT) từ chứng từ bán hàng đã ghi sổ, lập thông báo sai sót 04/SS-HĐĐT, ký số tờ khai, nhận hóa đơn đầu vào dạng XML để lập chứng từ mua, nhận giao dịch ngân hàng (webhook SePay, Casso hoặc sao kê Excel) để đối chiếu với chứng từ, in mã VietQR, tính tạm tính và quyết toán thuế thu nhập doanh nghiệp (TNDN), và cấp khóa API cho phần mềm bán hàng (POS).

Nguyên tắc cần nhớ: HĐĐT là lớp nằm trên chứng từ bán hàng đã ghi sổ, không phải luồng ghi sổ thứ hai. Số hóa đơn do nhà cung cấp cấp được ghi ngược vào chứng từ. Giao dịch ngân hàng và hóa đơn đầu vào chỉ là dữ liệu chờ; phần mềm chỉ gợi ý, không tự gắn, không tự ghi sổ. Mọi chứng từ sinh ra từ các màn hình này (Giấy báo Có, Giấy báo Nợ, hóa đơn mua, phiếu kế toán chi phí thuế) là chứng từ thật có số, ngày, người lập.

Lưu ý quan trọng về pháp lý và về mức độ đã thử:

- Chưa thử trên môi trường thật: Viettel SInvoice, SePay, Casso, VNPT SmartCA, mã QR với ứng dụng ngân hàng, XML tờ khai với HTKK. Các tích hợp này làm theo tài liệu công khai của nhà cung cấp, có nhà cung cấp "Giả lập (kiểm thử)" để dùng thử. Hãy thử với tài khoản thử của nhà cung cấp trước khi dùng cho số liệu thật.
- Quy tắc hủy, thay thế, điều chỉnh hóa đơn theo Thông tư 91/2026/TT-BTC Điều 10; mẫu 04/SS-HĐĐT theo Phụ lục III; ký hiệu hóa đơn theo Phụ lục I của thông tư này. Mẫu tờ khai 03/TNDN theo Thông tư 89/2026/TT-BTC (Phụ lục I, trang 270 đến 273).
- Phần mềm không có mẫu phụ lục kết quả hoạt động sản xuất kinh doanh kèm 03/TNDN (không tìm thấy trong TT 89/2026 và TT 20/2026). Số liệu kết quả kinh doanh trên tờ khai lấy từ báo cáo kết quả hoạt động kinh doanh (B02) của phần mềm.
- Giảm 30% thuế TNDN theo Nghị quyết 43/2026/QH16 mới được gợi ý, chờ văn bản hướng dẫn của Chính phủ. Kế toán tự quyết định có áp dụng không.

## Phím tắt chung

| Màn hình | Phím | Tác dụng |
|---|---|---|
| Cấu hình hóa đơn điện tử | Insert | Thêm ký hiệu hóa đơn |
| Cấu hình hóa đơn điện tử (hộp thoại) | Ctrl+S | Lưu |
| Chứng từ bán (Hóa đơn bán, Bán hàng) | Ctrl+Shift+E | Phát hành HĐĐT (F9 vẫn là ghi sổ) |
| Thông báo sai sót 04/SS | Insert | Lập thông báo |
| Lưới hóa đơn trong thông báo 04/SS, ô Số hóa đơn | F4 | Chọn hóa đơn đã phát hành |
| Hóa đơn đầu vào | Insert | Chọn tệp để tải lên |
| Hộp thoại Lập chứng từ mua | Ctrl+S | Lập chứng từ |
| Hộp thoại Lập chứng từ mua, ô Tài khoản, Mã hàng, Mã thuế | F4 | Mở tra cứu |
| Giao dịch ngân hàng | Insert | Lập Giấy báo Có hoặc Nợ cho giao dịch đang chọn |
| Hộp thoại Lập Giấy báo | Ctrl+S | Ghi sổ |
| Hộp thoại Lập Giấy báo, ô Đối tượng | F4 | Mở tra cứu |
| Tạm tính thuế TNDN | F9, Enter | F9 tính; Enter sang ô kế tiếp, ô cuối thì tính |
| Quyết toán thuế TNDN | F9, Ctrl+S | Lưu và tính lại tờ khai nháp |
| Quyết toán thuế TNDN | Enter | Sang ô nhập kế tiếp |
| Cài đặt ký số | Insert | Thêm hồ sơ ký |

## 1. Cấu hình hóa đơn điện tử

Menu: Hóa đơn điện tử > Cấu hình hóa đơn điện tử. Xem cần quyền "einvoice.view"; sửa cần "einvoice.config".

Màn hình có hai phần: "Nhà cung cấp hóa đơn điện tử" và "Ký hiệu hóa đơn".

### Nhà cung cấp

1. Bấm "Thêm nhà cung cấp".
2. Chọn "Loại nhà cung cấp": "Giả lập (kiểm thử)" hoặc "SInvoice (Viettel)".
3. Nhập Tên, "Địa chỉ máy chủ (URL)", Tên đăng nhập, Mật khẩu, Mã số thuế người bán. Đánh dấu "Đang dùng".
4. Bấm "Lưu (Ctrl+S)". Thông báo "Đã lưu nhà cung cấp".
5. Bấm "Kiểm tra kết nối" ở dòng nhà cung cấp để thử đăng nhập.

Mật khẩu được mã hóa khi lưu và không hiển thị lại. Khi sửa, để trống ô Mật khẩu thì giữ mật khẩu cũ. Cột "Mật khẩu" chỉ ghi "Đã đặt" hoặc "Chưa đặt".

Nhà cung cấp "Giả lập (kiểm thử)" cấp số ngay trong phần mềm, dùng để tập luyện và kiểm thử, không có giá trị pháp lý.

Xóa nhà cung cấp: nếu còn ký hiệu hóa đơn thuộc nhà cung cấp, phần mềm báo ("PROVIDER_IN_USE", 409) "Nhà cung cấp còn ký hiệu hóa đơn, xóa ký hiệu trước".

### Ký hiệu hóa đơn (TT 91/2026)

Ký hiệu hóa đơn gồm hai phần: "Ký hiệu mẫu số" (một chữ số từ 1 đến 9) và "Ký hiệu" (6 ký tự, ví dụ C26TAA). Phần mềm tự viết hoa và kiểm tra khi gõ, hiện dòng "Hợp lệ: có/không có mã của cơ quan thuế, năm …, chữ loại hóa đơn …". Cách đọc ký hiệu:

- Chữ đầu: C là hóa đơn có mã của cơ quan thuế (CQT); K là hóa đơn không có mã.
- Hai chữ số tiếp theo: năm lập hóa đơn (26 là 2026).
- Chữ thứ ba: loại hóa đơn (ví dụ T).
- Chữ thứ tư: M chỉ dùng cho hóa đơn khởi tạo từ máy tính tiền, và ngược lại hóa đơn máy tính tiền phải có chữ M. Sai thì báo ("INVOICE_SYMBOL_INVALID", 400).

Các bước thêm ký hiệu:

1. Bấm "Thêm ký hiệu (Insert)". Nếu chưa có nhà cung cấp, màn hình báo "Thêm nhà cung cấp trước".
2. Chọn nhà cung cấp, nhập "Ký hiệu mẫu số (1-9)", "Ký hiệu (vd. C26TAA)".
3. Chọn Loại: "Thông thường" hoặc "Khởi tạo từ máy tính tiền (chữ thứ tư M)".
4. Với SInvoice, nhập "Mã mẫu hóa đơn của nhà cung cấp" (mã mẫu do Viettel cấp cho ký hiệu này).
5. Nhập Ghi chú (tùy chọn), đánh dấu "Đang dùng", bấm "Lưu (Ctrl+S)". Thông báo "Đã lưu ký hiệu hóa đơn".

Ký hiệu đã có hóa đơn thì không sửa ký hiệu, loại, nhà cung cấp và không xóa được ("SERIES_IN_USE", 409). Muốn ngừng dùng, bỏ đánh dấu "Đang dùng". Xóa ký hiệu thành công: "Đã xóa ký hiệu".

## 2. Phát hành hóa đơn điện tử

Menu: Hóa đơn điện tử > Danh sách hóa đơn điện tử. Xem cần "einvoice.view"; phát hành, thử lại, bỏ hóa đơn lỗi cần "einvoice.issue".

### Phát hành từ chứng từ bán

Chỉ phát hành cho chứng từ bán hàng: Hóa đơn bán (HDB), Bán hàng (BH), Giảm giá hàng bán (GGB), Trả lại hàng bán (TLB). Chứng từ phải đã ghi sổ ("EINVOICE_VOUCHER_TYPE", "VOUCHER_NOT_POSTED": "Chứng từ chưa ghi sổ: ghi sổ chứng từ trước khi phát hành hóa đơn điện tử").

1. Mở chứng từ bán, vào thẻ Hóa đơn, chọn "Ký hiệu HĐĐT". Khi đã chọn, ô số hóa đơn không bắt buộc và hiện "Chưa phát hành". Để trống ô này nếu dùng hóa đơn giấy hoặc tự nhập số.
2. Ghi sổ chứng từ (F9).
3. Bấm "Phát hành HĐĐT (Ctrl+Shift+E)". Nút chỉ hiện khi chứng từ đã ghi sổ, đang chờ số, chưa có HĐĐT, không phải chứng từ giảm giá hoặc trả lại, và bạn có quyền "einvoice.issue".
4. Thành công: "Đã phát hành hóa đơn {số}". Nếu nhà cung cấp chưa trả số ngay: "Đã gửi hóa đơn, đang chờ nhà cung cấp cấp số".

Chứng từ giảm giá (GGB), trả lại (TLB) và chứng từ điều chỉnh không có nút này; dùng "Lập điều chỉnh" ở danh sách (mục 3).

Điều kiện kiểm tra khi phát hành:

- Ký hiệu đang dùng ("SERIES_INACTIVE", 400).
- Năm của ký hiệu phải bằng năm ngày hóa đơn ("SERIES_YEAR_MISMATCH", 400). Nếu tháng ngày hóa đơn khác tháng kê khai của chứng từ, phần mềm vẫn phát hành và hiện cảnh báo "ISSUE_DATE_DIFFERS_PERIOD" trong 12 giây. Chứng từ giữ kỳ kê khai cũ; phát hành sang tháng sau chỉ đổi ngày hóa đơn.
- Mọi dòng hàng phải có mã thuế ("LINE_MISSING_TAX_CODE", 400).
- Mỗi chứng từ chỉ có một hóa đơn đang hiệu lực ("EINVOICE_EXISTS").
- Chứng từ đã điều chỉnh bằng hóa đơn khác thì phải dùng hóa đơn điều chỉnh ("EINVOICE_ADJUSTMENT_REQUIRED", 409).

Thuế suất được quy đổi: KCT, KKKNT, 0, khác. Hình thức thanh toán gửi lên là "TM/CK". Phần mềm không hỗ trợ dòng khuyến mại và dòng chiết khấu riêng khi gửi hóa đơn.

### Các trạng thái

| Trạng thái | Ý nghĩa |
|---|---|
| Nháp | Đã lập bản ghi, chưa gửi |
| Đang gửi | Đã gửi lên nhà cung cấp, chưa nhận kết quả |
| Đã phát hành | Nhà cung cấp đã cấp số hóa đơn |
| Lỗi | Nhà cung cấp từ chối hoặc lỗi khi phát hành |
| Bị thay thế | Có hóa đơn thay thế đã phát hành |
| Đã hủy | Hóa đơn đã hủy |

Thẻ phụ: "Chờ mã CQT" (hóa đơn ký hiệu C đã phát hành nhưng chưa có mã của cơ quan thuế) và "Cần đảo chứng từ gốc" (mục 3).

Màn hình danh sách có bộ lọc Trạng thái, khoảng ngày, tìm "Số hóa đơn, khách hàng", bộ lọc "Cần đảo" ("Tất cả hóa đơn" hoặc "Chỉ hóa đơn cần đảo chứng từ gốc") và nút "Làm mới". Cột gồm Ký hiệu, Số, Ngày, Khách hàng, Loại, MST, Tiền trước thuế, Thuế, Tổng, Trạng thái, Mã CQT. Danh sách lấy tối đa 1000 dòng.

Bấm "Chi tiết" để mở ngăn bên phải: chứng từ, loại, khách hàng, tổng tiền, ngày hóa đơn, "Mã của cơ quan thuế", "Số lần gửi", Thanh toán, "Hóa đơn liên quan" và bảng "Nhật ký gửi và nhận" (từng lần gọi nhà cung cấp, kết quả, thời gian).

### Các nút trong chi tiết hóa đơn

- "Xem PDF", "Tải XML": khi hóa đơn đã phát hành, bị thay thế hoặc đã hủy. Phần mềm lưu XML; PDF lấy từ nhà cung cấp mỗi lần xem.
- "Thử lại": hóa đơn "Đang gửi". Thông báo "Đã gửi lại". Gọi lại cùng mã giao dịch nên không phát hành trùng. Chỉ thử lại được sau 150 giây kể từ lần gửi gần nhất, sớm hơn báo ("EINVOICE_BUSY"). Hóa đơn không ở trạng thái đang gửi thì báo ("EINVOICE_NOT_SENDING", "Chỉ thử lại hóa đơn điện tử đang gửi (chưa nhận được kết quả)").
- "Bỏ hóa đơn lỗi": hóa đơn "Lỗi". Hỏi "Bỏ hóa đơn lỗi này?" "Chứng từ gốc được mở khóa để phát hành lại." Thông báo "Đã bỏ hóa đơn lỗi". Bản ghi lỗi chỉ bị đánh dấu bỏ, không xóa khỏi nhật ký.
- "Tra mã CQT": hóa đơn ký hiệu C đã phát hành chưa có mã của cơ quan thuế. Thông báo "Đã tra cứu mã của cơ quan thuế".
- "Đánh dấu đã thanh toán", "Bỏ đánh dấu đã thanh toán".
- "Lập điều chỉnh", "Lập thay thế", "Hủy", "Đảo chứng từ gốc", "Lập 04/SS": xem mục 3 và 4.

Hóa đơn "Lỗi" không khóa chứng từ gốc; chứng từ chỉ bị khóa "Bỏ ghi sổ" khi hóa đơn đang gửi, đã phát hành, bị thay thế, đã hủy hoặc còn cần đảo.

### Tự động đối soát mỗi 5 phút

Tiến trình nền (worker) chạy mỗi 5 phút, mỗi lượt tối đa 200 hóa đơn:

- Hóa đơn "Đang gửi" quá 150 giây: hỏi lại nhà cung cấp theo mã giao dịch; nhận được số thì chuyển "Đã phát hành", nhà cung cấp từ chối thì chuyển "Lỗi".
- Hóa đơn ký hiệu C đã phát hành, đang chờ mã CQT: tra mã và ghi vào hóa đơn.

Nên dùng "Thử lại" khi cần ngay; không cần theo dõi từng hóa đơn nếu chỉ chờ đối soát tự động.

### Hóa đơn mồ côi

Nếu nhà cung cấp đã phát hành (hoặc đã hủy) hóa đơn nhưng phần mềm không ghi nhận được vì chứng từ đã ở trạng thái khác, phần mềm hiện hộp thoại "Hóa đơn điện tử mồ côi: cần xử lý tay" ("EINVOICE_ORPHAN_ISSUED", "EINVOICE_ORPHAN_CANCELLED", 409) và ghi vào nhật ký. Hộp thoại không tự tắt. Cần xử lý tay: đăng nhập cổng nhà cung cấp, đối chiếu số hóa đơn, rồi lập chứng từ hoặc hủy hóa đơn tương ứng.

## 3. Điều chỉnh, thay thế, hủy hóa đơn (TT 91/2026 Điều 10)

Các thao tác này làm ở chi tiết hóa đơn trong Danh sách hóa đơn điện tử. Hộp thoại có nút "Thực hiện" và "Đóng".

Điều kiện chung:

- Hóa đơn phải đang hiệu lực, đã phát hành ("EINVOICE_NOT_ACTIVE").
- Không có hóa đơn điều chỉnh hoặc thay thế khác đang chờ kết quả ("EINVOICE_BUSY").
- Hóa đơn ký hiệu C chưa có mã của cơ quan thuế: không điều chỉnh, không thay thế được ("EINVOICE_CQT_PENDING"); bấm "Tra mã CQT" hoặc hủy rồi lập lại.
- "Lập thay thế", "Hủy", "Đảo chứng từ gốc" cần cả "einvoice.issue" và "voucher.post"; người thiếu quyền ghi sổ không thấy nút.
- Cảnh báo kèm kết quả hiện 12 giây: "ISSUE_DATE_DIFFERS_PERIOD", "EINVOICE_REVERSAL_PENDING", "EINVOICE_REVERSAL_FAILED".

### Lập điều chỉnh

Nút "Lập điều chỉnh" hiện cho hóa đơn gốc đã phát hành chưa bị điều chỉnh.

1. Bấm "Lập điều chỉnh".
2. Chọn chứng từ điều chỉnh: chứng từ đã ghi sổ của cùng khách hàng. Điều chỉnh tăng dùng Hóa đơn bán (HDB) hoặc Bán hàng (BH); điều chỉnh giảm dùng Giảm giá hàng bán (GGB) hoặc Trả lại hàng bán (TLB) ("EINVOICE_ADJUST_KIND"). Hướng tăng hay giảm do phần mềm tự suy ra từ loại chứng từ.
3. Nhập "Số văn bản thỏa thuận" và "Ngày văn bản" nếu có.
4. Bấm "Thực hiện". Thông báo "Đã lập hóa đơn điều chỉnh".

Chỉ điều chỉnh hóa đơn gốc; hóa đơn gốc là hóa đơn thay thế hoặc điều chỉnh thì không điều chỉnh tiếp ("EINVOICE_ADJUST_NOT_ALLOWED"). Hai bên (khách hàng) phải khớp ("EINVOICE_PARTY_MISMATCH"); chứng từ điều chỉnh phải đúng với hóa đơn gốc ("EINVOICE_ADJUST_MISMATCH"); hóa đơn đã bị điều chỉnh thì không điều chỉnh lần nữa ("EINVOICE_ALREADY_ADJUSTED"). Điều chỉnh chỉ thông tin (không đổi tiền) chưa hỗ trợ ("EINVOICE_ADJUST_INFO_UNSUPPORTED", 400): dùng hóa đơn thay thế, hoặc thông báo sai sót 04/SS (mục 4).

Điều chỉnh không đảo chứng từ gốc: chứng từ điều chỉnh (giảm giá, trả lại) tự đã là bút toán điều chỉnh.

### Lập thay thế

Nút "Lập thay thế" hiện cho hóa đơn đã phát hành, chưa bị điều chỉnh và không phải hóa đơn điều chỉnh.

1. Lập sẵn và ghi sổ chứng từ mới (Hóa đơn bán hoặc Bán hàng, cùng khách hàng) làm chứng từ thay thế. Chỉ HDB, BH ("EINVOICE_REPLACE_KIND").
2. Bấm "Lập thay thế", chọn chứng từ, bấm "Thực hiện". Thông báo "Đã lập hóa đơn thay thế".
3. Khi hóa đơn thay thế phát hành, hóa đơn gốc chuyển "Bị thay thế".

### Hủy

Nút "Hủy" hiện khi hóa đơn là hóa đơn gốc, đã phát hành, chưa bị điều chỉnh, và: ký hiệu K (không mã), hoặc ký hiệu C nhưng chưa có mã của cơ quan thuế. Hóa đơn C đã có mã của cơ quan thuế không hủy được ("EINVOICE_CANCEL_NOT_ALLOWED"): dùng hóa đơn thay thế hoặc thông báo 04/SS.

1. Bấm "Hủy". Nhập "Ngày hủy" và "Lý do".
2. Bấm "Thực hiện". Thông báo "Đã hủy hóa đơn".

Nhà cung cấp không hỗ trợ thao tác thì báo ("PROVIDER_UNSUPPORTED").

### Đảo chứng từ gốc

Hóa đơn bị thay thế hoặc đã hủy thì chứng từ bán gốc không còn đúng với thực tế, cần đảo khỏi sổ cái. Phần mềm thực hiện như sau:

1. Ngay sau khi thao tác thay thế hoặc hủy thành công, phần mềm tự thử đảo chứng từ gốc. Ngày đảo là ngày ghi sổ của chứng từ gốc nếu kỳ đó còn mở; nếu không thì dùng ngày chứng từ thay thế (hoặc ngày hủy). Cả hai kỳ đều khóa thì báo lỗi 409 ("EINVOICE_REVERSAL_LOCKED"); khi đó cần người có "voucher.backdate_locked" hoặc mở kỳ.
2. Nếu việc đảo tự động không thành (kỳ khóa, chứng từ gốc đã đối trừ công nợ "OPEN_ITEM_SETTLED": bỏ đối trừ trước, hoặc lỗi khác), thao tác thay thế hoặc hủy vẫn được giữ. Phần mềm hiện cảnh báo "EINVOICE_REVERSAL_FAILED" (hoặc "EINVOICE_REVERSAL_PENDING"), hóa đơn mang thẻ đỏ "Cần đảo chứng từ gốc".
3. Khi đó mở chi tiết hóa đơn và bấm "Đảo chứng từ gốc" (thông báo "Đã đảo chứng từ gốc") sau khi xử lý nguyên nhân. Hóa đơn không cần đảo mà bấm thì báo ("EINVOICE_NO_REVERSAL_NEEDED").
4. Lọc "Chỉ hóa đơn cần đảo chứng từ gốc" để xem toàn bộ hóa đơn còn tồn.

Việc thử lại và tiến trình nền chỉ hoàn tất trạng thái hóa đơn, không tự đảo chứng từ gốc: cờ "Cần đảo chứng từ gốc" chỉ tắt sau khi chứng từ gốc đã đảo. Quy tắc Soát lỗi "HDDT_CAN_DAO_GOC" nhắc các hóa đơn còn tồn (mục 11).

## 4. Thông báo sai sót 04/SS-HĐĐT

Menu: Hóa đơn điện tử > Thông báo sai sót 04/SS. Xem cần "einvoice.view"; lập, sửa, gửi cần "einvoice.issue".

Mẫu "Thông báo hóa đơn điện tử có sai sót (04/SS-HĐĐT)" theo Phụ lục III TT 91/2026, gồm 9 cột. Dùng khi hóa đơn đã lập có sai sót mà không hủy, điều chỉnh hay thay thế được (ví dụ hóa đơn C đã có mã).

1. Bấm "Lập thông báo (Insert)". Hộp thoại "Lập thông báo sai sót".
2. Chọn loại:
   - "Người bán tự thông báo": cột (8) ghi "Thông báo".
   - "Theo thông báo của CQT (01/TB-RSĐT)": cột (8) ghi "Giải trình"; bắt buộc nhập "Số thông báo của CQT" và "Ngày thông báo của CQT" ("Thông báo của cơ quan thuế phải ghi số và ngày của thông báo (Mẫu số 01/TB-RSĐT)").
3. Nhập "Ngày lập thông báo", "Địa danh", chọn "Nhà cung cấp gửi".
4. Thêm hóa đơn vào lưới. Ở ô Số hóa đơn bấm F4 mở "Chọn hóa đơn đã phát hành". Có thể nhập tay hóa đơn lập ngoài phần mềm: phải đủ ký hiệu mẫu số, ký hiệu, số hóa đơn và ngày lập ("Dòng N: hóa đơn ngoài phần mềm phải nhập đủ ký hiệu mẫu, ký hiệu, số hóa đơn và ngày lập").
5. Các cột lưới: (1) STT, (2) Mã của CQT, (3 đến 5) Mẫu số, Ký hiệu, Số hóa đơn, (6) Ngày lập, (7) Loại áp dụng (mặc định theo chữ đầu của ký hiệu mẫu số, sửa được), (8) Thông báo hoặc Giải trình, (9) Lý do. Phải chọn ít nhất một hóa đơn ("Chọn ít nhất một hóa đơn") và nhập lý do cho mọi dòng ("Nhập lý do (9) cho mọi dòng").
6. Bấm "Lưu". Thông báo "Đã lưu thông báo". Trạng thái Nháp.

Từ chi tiết một hóa đơn đã phát hành, nút "Lập 04/SS" mở thẳng màn hình này với hóa đơn đó đã chọn.

Gửi thông báo:

- Bấm "Gửi" để gửi qua nhà cung cấp. Thành công: "Đã gửi thông báo", trạng thái Đã gửi.
- Nhà cung cấp SInvoice (và nhà cung cấp chưa hỗ trợ) không gửi được qua phần mềm ("PROVIDER_UNSUPPORTED", 409): phần mềm hỏi "Nhà cung cấp chưa hỗ trợ gửi thông báo" / "Nộp thông báo trên cổng thuế rồi đánh dấu đã gửi.". Hãy bấm "In (HTML)" hoặc "In (PDF)", nộp thông báo trên cổng thuế hoặc cổng nhà cung cấp, rồi bấm "Đánh dấu đã gửi" (thông báo "Đã đánh dấu đã gửi").
- Thông báo đã gửi thì không sửa, xóa hay gửi lại ("ERROR_NOTICE_NOT_DRAFT": "Thông báo đã gửi, không sửa, xóa hoặc gửi lại được"). Thông báo nháp xóa được: "Đã xóa thông báo".
- Thiếu nhà cung cấp để gửi: "ERROR_NOTICE_NO_PROVIDER".

Phần mềm chỉ có hai trạng thái Nháp và Đã gửi. Kết quả tiếp nhận hay từ chối của cơ quan thuế (thông báo 01/TB-SSĐT) không theo dõi trong phần mềm.

## 5. Ký số

Chi tiết cài đặt và cách ký xem `docs/user/ky-so.md`. Tóm tắt:

- Menu: Thuế > Cài đặt ký số. Cần quyền "signing.use".
- Ký được hai loại tờ khai: Tờ khai thuế GTGT (01/GTGT) và Quyết toán thuế TNDN (03/TNDN), sau khi tờ khai đã chốt, bằng nút "Ký và tải XML".
- Thông báo sai sót 04/SS không ký được trong phần mềm ("SIGNING_DOC_UNSUPPORTED": "Chưa có XML để ký cho loại chứng từ …"). Ký bản in hoặc ký trên cổng nộp.
- Khóa riêng không rời máy bạn. Chứng thư hết hạn hoặc chưa hiệu lực thì không ký được.

## 6. Hóa đơn đầu vào

Menu: Hóa đơn điện tử > Hóa đơn đầu vào. Xem cần "inbound_invoice.view"; tải lên cần "inbound_invoice.create"; bỏ qua, lập chứng từ cần "inbound_invoice.update" (lập chứng từ cần thêm "voucher.create").

Màn hình nhận hóa đơn mua vào dạng XML theo Quyết định 1233 và biến thành chứng từ mua hàng nháp.

### Tải lên

1. Kéo thả hoặc bấm vào vùng "Kéo thả hoặc bấm để chọn nhiều tệp hóa đơn XML hoặc zip (phím Insert)". Chấp nhận .xml và .zip.
2. Bảng "Kết quả tải lên" liệt kê từng tệp: Mới, Trùng, Bỏ qua, Lỗi. Mỗi tệp một dòng, kể cả tệp hỏng; tệp hỏng không làm hỏng cả lượt. Tải lại cùng tệp là an toàn.

Giới hạn:

| Giới hạn | Mức | Mã lỗi |
|---|---|---|
| Một tệp XML | 2 MB | "XML_TOO_LARGE": "Tệp XML vượt 2 MB (giới hạn thông điệp theo QĐ 1233)" |
| Số tệp mỗi lượt | 50 | "TOO_MANY_FILES": "Mỗi lượt tải tối đa 50 tệp: phần còn lại chưa được nhận" |
| Số mục trong một tệp zip | 200 | "ZIP_TOO_LARGE" |
| Dung lượng giải nén một lượt | 50 MB (tệp zip 20 MB) | "ZIP_TOO_LARGE", "REQUEST_TOO_LARGE" |
| Tổng dung lượng một lượt tải | 50 MB | "REQUEST_TOO_LARGE": "Tổng dung lượng một lượt tải vượt 50 MB" |

Tệp bị từ chối: zip hỏng ("ZIP_INVALID"), XML không đọc được ("XML_INVALID"), XML có khai báo DOCTYPE hoặc ENTITY ("XML_UNSAFE"), tệp có hơn một thân hóa đơn, nghi đánh tráo nội dung ("XML_AMBIGUOUS"), không có tệp ("NO_FILE").

### Trùng hóa đơn

- Cùng nội dung tệp (cùng mã băm SHA-256): trả bản đã có, không tạo mới. Ghi chú "Hóa đơn đã có trong hệ thống".
- Cùng MST người bán, ký hiệu và số hóa đơn (sau khi chuẩn hóa số): trạng thái "Trùng". Hóa đơn trùng chỉ bỏ qua được, không lập chứng từ được.
- Hóa đơn đã có chứng từ mua nhập tay trùng số: vẫn nhận, kèm cảnh báo "VOUCHER_EXISTS" ("Hóa đơn này đã được nhập thành chứng từ …").

### Cột chữ ký

Phần mềm đối chiếu chữ ký số của người bán với nội dung hóa đơn, nhưng chưa kiểm chuỗi chứng thư của tổ chức cấp chứng thư (CA):

- "Hợp lệ": chữ ký khớp nội dung (chưa kiểm CA).
- "Không hợp lệ": "Chữ ký số không khớp nội dung hóa đơn".
- "Không có": "Tệp XML không có chữ ký người bán".

Hóa đơn chữ ký sai hoặc thiếu vẫn lưu, kèm cảnh báo, để kế toán xử lý. Mã cảnh báo thường gặp: "UNSIGNED", "SELLER_SIGNATURE_INVALID", "CQT_SIGNATURE_INVALID", "CQT_CODE_UNSIGNED", "SIGNER_TAXCODE_UNKNOWN", "SIGNER_TAXCODE_MISMATCH", "BUYER_MISMATCH" ("MST người mua (…) khác MST công ty (…)"), "TOTAL_MISMATCH", "TAX_RATE_UNKNOWN", "VND_FRACTION" (hóa đơn đồng Việt Nam có phần thập phân, ví dụ "500.000" có thể bị đọc thành 500), "FX_RATE_MISSING". Bấm "Chi tiết" để xem đầy đủ.

### Tra cứu mã số thuế người bán

Tính năng tra MST người bán (dịch vụ api.vietqr.io) mặc định tắt vì nó gửi MST người bán tới dịch vụ bên thứ ba. Khi tắt, gọi tra cứu báo ("TAXCODE_LOOKUP_OFF": "Tra cứu mã số thuế đang tắt: bật ở Cài đặt (gửi MST người bán tới dịch vụ bên thứ ba)"). Khi bật, phần mềm tự tra lúc tải lên và ghi cảnh báo nếu tra không được ("TAXCODE_LOOKUP_FAILED"), không thấy ("TAXCODE_NOT_FOUND") hoặc tên khác hóa đơn ("TAXCODE_NAME_MISMATCH"). Hiện chưa có ô bật tính năng này trên giao diện: cài đặt "tax_code_lookup" chỉ đặt được qua API cài đặt, và chưa có nút "Tra MST" trên màn hình Hóa đơn đầu vào.

### Hóa đơn bị chặn

Số tiền trong XML sai dạng, vượt giới hạn (quá 16 chữ số nguyên hoặc 4 chữ số thập phân), nhóm thuế thiếu tiền hoặc thuế, hoặc ngoại tệ thiếu tỷ giá thì phần mềm không lưu số 0 thay số hỏng: để trống, ghi cảnh báo và đánh thẻ "Bị chặn". Ngăn chi tiết hiện "Hóa đơn bị chặn: số tiền trong tệp XML sai dạng hoặc vượt giới hạn, không thể lập chứng từ". Hóa đơn bị chặn chỉ bỏ qua được; nhập tay chứng từ mua.

### Lập chứng từ mua

1. Chọn hóa đơn trạng thái "Mới", bấm "Chi tiết", bấm "Lập chứng từ". Nút chỉ bật khi hóa đơn không bị chặn và còn trạng thái Mới. Hộp thoại "Lập chứng từ mua hàng từ hóa đơn đầu vào".
2. Chọn "Loại chứng từ": Hóa đơn mua dịch vụ (HDM) hoặc Mua hàng (MH). Nhập "Ngày hạch toán", "Nhóm hóa đơn" (mặc định 01), "Diễn giải".
3. Chọn "Nhà cung cấp". Nếu chưa có, đánh dấu "Tạo nhà cung cấp mới từ hóa đơn" (cần "catalog.create"); nhà cung cấp mới có mã `NCC` cộng MST ("PARTY_CODE_TAKEN" nếu mã đã dùng cho MST khác). Chưa chọn thì báo ("PARTY_REQUIRED": "Chưa có đối tượng cho người bán: chọn nhà cung cấp hoặc tạo mới từ hóa đơn").
4. Ở lưới dòng hàng, điền cột "Tài khoản (F4)", "Mã hàng (F4)", "Mã thuế (F4)" cho từng dòng. Các cột Dòng, Tên hàng hóa dịch vụ, Thành tiền, TS lấy từ hóa đơn.
5. Bấm "Lập chứng từ (Ctrl+S)". Thông báo "Đã lập chứng từ mua hàng (nháp)". Chứng từ nháp mang ký hiệu, số, ngày của hóa đơn; kiểm tra rồi ghi sổ như chứng từ thường.

Phần mềm nhớ ánh xạ: với mỗi cặp (MST người bán, tên hàng đã chuẩn hóa), tài khoản, mã hàng, mã thuế bạn chọn lần trước được điền sẵn ở hóa đơn sau, đánh dấu "Nhớ". Ô để trống không xóa giá trị đã nhớ. Mã thuế còn được gợi ý theo thuế suất (KCT thành `KCT`, KKKNT thành `KKK`). Gợi ý chỉ là gợi ý, hãy kiểm tra lại.

Lỗi thường gặp khi lập:

- "INBOUND_STATUS": "Hóa đơn đã nhập thành chứng từ hoặc đã bỏ qua"; "INBOUND_ALREADY_CONVERTED".
- "INBOUND_BLOCKED": hóa đơn bị chặn.
- "INBOUND_DISCOUNT_UNSUPPORTED": hóa đơn có dòng chiết khấu thương mại, phải nhập chứng từ tay.
- "Hóa đơn không có dòng hàng để lập chứng từ"; "Dòng N: chưa chọn tài khoản, vật tư và mã thuế"; "Dòng N: chưa chọn mã thuế".
- "Thuế suất X đang ánh xạ nhiều mã thuế: chọn cùng một mã cho các dòng cùng thuế suất".
- "TAX_DECLARED_MISMATCH" (400): thuế kê khai lệch quá mức làm tròn so với hóa đơn.
- "FORBIDDEN": thiếu "catalog.create" để tạo đối tượng mới.

"Bỏ qua" trên ngăn chi tiết chuyển hóa đơn sang "Đã bỏ qua". Bộ lọc: Trạng thái (Mới, Đã lập chứng từ, Đã bỏ qua, Trùng), khoảng ngày, tìm "Người bán, MST, số hóa đơn".

Phần mềm bán hàng bên ngoài cũng gửi được hóa đơn đầu vào qua khóa API có phạm vi "Gửi hóa đơn đầu vào (XML)" (mục 10).

## 7. Kết nối ngân hàng (SePay, Casso)

Menu: Ngân hàng > Kết nối ngân hàng. Xem cần "bank_feed.view"; thêm cần "bank_feed.create"; sửa, đổi mã cần "bank_feed.update"; xóa cần "bank_feed.delete". Vai trò kế toán viên mặc định chỉ có xem và đối chiếu; thêm kết nối là việc của kế toán trưởng hoặc quản trị.

Một kết nối nối một tài khoản ngân hàng của công ty với một dịch vụ báo biến động số dư. Dịch vụ gọi (webhook) về phần mềm mỗi khi có giao dịch.

### Thêm kết nối

1. Bấm "Thêm kết nối".
2. Chọn "Tài khoản ngân hàng", "Nhà cung cấp" (SePay hoặc Casso), "Cách xác thực" ("Chữ ký HMAC" hoặc "Khóa API"). Có thể nhập "Khóa bí mật" riêng; để trống thì hệ thống tự sinh.
3. Bấm "Tạo kết nối". Hộp thoại "Địa chỉ webhook và khóa" hiện: "Địa chỉ webhook", "Khóa bí mật (HMAC)" hoặc "Khóa API". Mỗi ô có nút "Chép".
4. Dán địa chỉ webhook và khóa vào trang cấu hình webhook của SePay hoặc Casso. Địa chỉ webhook dạng `/api/hooks/bank/<mã>`; nếu quản trị đã đặt biến `PUBLIC_BASE_URL` thì địa chỉ đầy đủ theo đó, không thì theo địa chỉ bạn đang truy cập.
5. Khóa chỉ hiện một lần ("Khóa chỉ hiện một lần. Hãy chép và dán sang SePay/Casso ngay."). Bấm "Đã lưu, đóng" khi đã chép.

Mất khóa thì đổi mã mới: bấm "Đổi mã" ở dòng kết nối, xác nhận "Đổi mã mới?" ("Mã cũ ngừng dùng được ngay; phải cập nhật lại bên SePay/Casso."). Công tắc "Hoạt động" tạm ngừng nhận mà không xóa. "Xóa kết nối này?" xóa hẳn kết nối (thông báo "Đã xóa kết nối"); các giao dịch đã nhận vẫn giữ.

Cột "Nhận gần nhất" cho biết lần webhook cuối; "Chưa nhận" nếu chưa có giao dịch nào.

Cách phần mềm kiểm tra webhook:

- Tài khoản ngân hàng nhận giao dịch lấy từ cấu hình kênh, không lấy từ nội dung gửi tới. Lộ mã webhook cũng chỉ ghi được vào đúng tài khoản đó.
- SePay: chữ ký HMAC-SHA256 hoặc `Authorization: Apikey`. Casso (bản V2): chữ ký HMAC-SHA512 hoặc `secure-token`. Lệch giờ quá 300 giây hoặc sai chữ ký thì bị từ chối.
- Số tài khoản trong nội dung so khớp sau khi bỏ ký tự không phải chữ và số. Không khớp thì phần mềm vẫn trả thành công (để dịch vụ không gửi lại vô hạn) nhưng ghi "ACCOUNT_MISMATCH" vào nhật ký webhook, không tạo giao dịch.
- Gửi lặp (cùng mã giao dịch của bên gửi) chỉ tạo một giao dịch.
- SePay luôn ghi tiền vào theo loại giao dịch của SePay. Casso: số âm hiểu là tiền ra. Chuẩn JSON của Casso chưa thử với chữ ký thật.

### Mẫu cột sao kê

Phần "Mẫu cột sao kê" khai cách đọc tệp sao kê Excel (.xlsx) hoặc .csv tải từ ngân hàng. Phần mềm không có mẫu riêng theo từng ngân hàng; bạn khai vị trí cột một lần.

1. Bấm "Thêm mẫu" (cần "bank_feed.update").
2. Nhập "Tên mẫu", "Mã ngân hàng" (tùy chọn), "Dòng tiêu đề", "Trang tính" (tính từ 0), "Định dạng ngày" (`dd/MM/yyyy`, `yyyy-MM-dd`, `dd-MM-yyyy` hoặc "Ngày của Excel").
3. Nhập chữ cái cột (viết hoa, ví dụ A, B, AA): bắt buộc "Cột ngày" và "Cột diễn giải". Số tiền khai một trong hai cách: "Cột ghi có" và "Cột ghi nợ" riêng, hoặc "Cột số tiền có dấu". Tùy chọn "Cột tham chiếu", "Cột số dư".
4. Bấm "Lưu". Thông báo "Đã lưu mẫu cột sao kê".

## 8. Giao dịch ngân hàng và đối chiếu

Menu: Ngân hàng > Giao dịch ngân hàng. Xem cần "bank_feed.view"; gắn, lập chứng từ, bỏ qua cần "bank_feed.match" (lập chứng từ cần thêm "voucher.create" và "voucher.post"); nhập sao kê cần "bank_feed.create".

### Hộp thư giao dịch

Giao dịch từ webhook hoặc sao kê vào đây, trạng thái "Mới". Bộ lọc: Tài khoản ngân hàng, Trạng thái (mặc định Mới; Mới, Đã đối chiếu, Đã bỏ qua), khoảng ngày, tìm "Tìm diễn giải, tham chiếu". Bộ lọc được nhớ cho lần sau. Cột: Ngày, Diễn giải, Tham chiếu, Tiền vào, Tiền ra, Số dư, Trạng thái, Chứng từ ("Mở").

Chọn một giao dịch, khung bên phải hiện thông tin và Gợi ý.

### Gợi ý đối chiếu

Gợi ý chỉ để tham khảo, phần mềm không bao giờ tự gắn. Mỗi gợi ý có điểm và lý do ghi dưới thẻ:

- Chứng từ đã ghi sổ cùng tài khoản ngân hàng, cùng số tiền, lệch tối đa 3 ngày: Giấy báo Có (BC) cho tiền vào, Giấy báo Nợ (BN) cho tiền ra. Cùng ngày được thêm điểm.
- Khoản công nợ phải thu (131) hoặc phải trả (331) còn dư đúng bằng số tiền giao dịch: thêm điểm.
- Số hóa đơn, số chứng từ, mã đối tượng hoặc mã thanh toán xuất hiện đúng một từ nguyên trong diễn giải: thêm điểm.
- Mã số thuế hoặc tên đối tượng khớp: thêm điểm ít hơn.

Khi so diễn giải, phần mềm bỏ các ngày dạng ngày/tháng/năm và số có dấu phân cách hàng nghìn, và bỏ số 0 đứng đầu: "HD 0000123" khớp hóa đơn 123, nhưng "CK 12.345.000" không bị hiểu thành hóa đơn 2345. Ngày không có năm (ví dụ "05/10") vẫn có thể khớp nhầm hóa đơn số 5 hoặc 10: hãy đọc lý do trước khi gắn.

Thiếu cờ xem công nợ phải thu ("view_receivable") hoặc phải trả ("view_payable") thì gợi ý công nợ bị ẩn, hiện "Một số gợi ý công nợ bị ẩn do quyền xem công nợ.".

### Xử lý một giao dịch

- "Gắn" (ở gợi ý chứng từ): gắn giao dịch với chứng từ có sẵn. Điều kiện: cùng tài khoản ngân hàng, đúng chiều thu hoặc chi, đúng số tiền, chứng từ đã ghi sổ và không phải chứng từ đảo, chưa gắn giao dịch khác. Gắn xong trạng thái là "Đã đối chiếu".
- "Lập Giấy báo Có" (tiền vào) hoặc "Lập Giấy báo Nợ" (tiền ra), hoặc phím Insert: lập chứng từ mới từ giao dịch.
- "Bỏ qua": đánh dấu giao dịch không cần chứng từ. Giao dịch đã gắn chứng từ nháp không bỏ qua được. "Bỏ trạng thái bỏ qua" đưa về "Mới".
- "Gỡ liên kết": bỏ liên kết giao dịch với chứng từ.

Trạng thái giao dịch tự theo chứng từ gắn: ghi sổ chứng từ thì giao dịch thành "Đã đối chiếu" nếu số tiền phía ngân hàng của chứng từ vẫn khớp, không khớp thì gỡ liên kết (không chặn ghi sổ, bạn gắn lại); bỏ ghi sổ thì về "Mới" và giữ liên kết; hủy, đảo hoặc xóa chứng từ thì gỡ liên kết.

### Lập Giấy báo Có hoặc Nợ từ giao dịch

1. Chọn giao dịch trạng thái Mới, bấm "Lập Giấy báo Có" hoặc "Lập Giấy báo Nợ". Hộp thoại "Lập Giấy báo Có" hoặc "Lập Giấy báo Nợ" hiện ngày, số tiền, tham chiếu.
2. Chọn "Đối tượng (F4)". Bảng liệt kê các khoản công nợ còn mở của đối tượng (131 cho tiền vào, 331 cho tiền ra): chọn các khoản cần đối trừ. Phần mềm phân bổ lần lượt theo thứ tự chọn, mỗi khoản nhận tối đa số còn lại, tổng không vượt số tiền giao dịch. Phần dư ghi nhận trả trước ("phần dư ghi nhận trả trước").
3. Nếu không đối trừ công nợ, chọn "Mục đích" (danh sách mục đích thu chi). Khi đã có khoản đối trừ thì ô Mục đích bị khóa ("Theo khoản đối trừ").
4. Sửa "Diễn giải" nếu cần (mặc định lấy diễn giải giao dịch).
5. Bấm "Ghi sổ (Ctrl+S)". Thông báo "Đã lập và ghi sổ Giấy báo Có" (hoặc Nợ). Chứng từ được ghi sổ ngay.

Cần "voucher.create", "voucher.post"; đối trừ công nợ cần thêm "settlement.create". Tài khoản ngân hàng ngoại tệ không lập được từ giao dịch ("lập tay" Giấy báo).

### Nhập sao kê

Dùng khi không có webhook, hoặc cần nạp giao dịch cũ.

1. Chọn tài khoản ngân hàng ở bộ lọc (bắt buộc: "Chọn tài khoản ngân hàng ở bộ lọc trước khi nhập sao kê.").
2. Bấm "Nhập sao kê". Chọn "Mẫu cột sao kê" (khai ở Kết nối ngân hàng; chưa có mẫu thì "Chưa có mẫu, khai ở Kết nối ngân hàng").
3. Bấm "Chọn tệp sao kê (.xlsx, .csv)", rồi "Nhập".
4. Thông báo "Đã nhập N giao dịch" và số dòng trùng hoặc lỗi bị bỏ. Lỗi báo theo từng dòng.

Tệp tối đa 5 MB và 10.000 dòng ("IMPORT_FILE_TOO_LARGE" nếu vượt). Nhập lại cùng tệp không sinh giao dịch mới: mỗi dòng có dấu vân tay từ tài khoản, ngày, số tiền, tham chiếu, diễn giải và thứ tự lặp.

### Đối chiếu sổ phụ

Thẻ "Đối chiếu sổ phụ" so sổ cái với sao kê của một tài khoản ngân hàng.

1. Chọn tài khoản ngân hàng ở bộ lọc phía trên.
2. Chọn khoảng ngày, bấm "Đối chiếu".
3. Kết quả: số dư đầu kỳ và cuối kỳ theo sổ, số dư theo sổ phụ (số dư sau giao dịch cuối cùng đến hết ngày cuối kỳ; "Chưa có" nếu sao kê không có cột số dư), "Chênh lệch".
4. Hai bảng: "Giao dịch ngân hàng chưa có chứng từ" và "Bút toán sổ cái chưa có giao dịch ngân hàng". Chứng từ đảo và chứng từ bị đảo vẫn hiện trong bảng sổ cái (cộng triệt tiêu).
5. Bấm "Xuất Excel" để tải bảng đối chiếu.

## 9. Mã QR thanh toán VietQR

Phần mềm in mã QR chuẩn VietQR để khách quét và chuyển tiền đúng số tiền, đúng nội dung.

### Khai BIN ngân hàng

Mã QR cần mã BIN NAPAS (6 chữ số) của ngân hàng nhận tiền.

1. Vào Danh mục > Ngân hàng, mở ngân hàng của công ty.
2. Ở trường "BIN NAPAS (mã VietQR)" chọn trong danh sách (dạng "970436 – tên ngân hàng"). Danh sách gồm 76 ngân hàng, lấy từ dịch vụ api.vietqr.io ngày 2026-10-23, không phải văn bản chính thức của NAPAS. Cột chỉ nhận đúng 6 chữ số ("BIN NAPAS gồm 6 chữ số").
3. Vào Danh mục > Tài khoản ngân hàng, bảo đảm tài khoản dùng loại tiền VND, đang hoạt động và thuộc ngân hàng vừa khai BIN.

Tài khoản nhận tiền trên mã QR: tài khoản ngân hàng VND đang dùng, thuộc ngân hàng có BIN, có mã nhỏ nhất. Hiện chưa có cờ "tài khoản mặc định" để chọn tài khoản khác. Công ty có nhiều tài khoản cần lưu ý. Chưa có tài khoản nào đủ điều kiện thì báo ("QR_NO_BANK_ACCOUNT", 409): "Chưa có tài khoản ngân hàng VND nào của công ty có BIN NAPAS; khai BIN ở danh mục Ngân hàng".

### QR trên hóa đơn bán

1. Mở Hóa đơn bán (HDB) hoặc Bán hàng (BH) đã ghi sổ.
2. Bấm "Mã QR thanh toán". Hộp thoại "Mã QR thanh toán" hiện mã, ngân hàng, STK, số tiền, nội dung.

Số tiền là số còn phải thu của hóa đơn sau đối trừ (cần cờ "view_receivable"). Nội dung là số hóa đơn, hoặc số chứng từ nếu chưa có số hóa đơn; nội dung được ép thành chữ không dấu và tối đa 25 ký tự để mọi ứng dụng ngân hàng đọc được. Số tiền chỉ nhận số nguyên đồng. Lỗi: chứng từ không phải HDB, BH đã ghi sổ ("QR_VOUCHER_STATE"); hóa đơn đã thu đủ ("QR_NOTHING_DUE").

### QR trên biên bản đối chiếu công nợ

Biên bản đối chiếu công nợ (khi in) có mã QR của tổng số còn nợ, nội dung "Doi chieu <mã đối tượng>". QR chỉ in khi đây là công nợ phải thu, khách còn nợ công ty, và công ty có tài khoản ngân hàng đủ điều kiện ở trên. Biên bản công nợ phải trả không in QR.

Mã QR theo cấu trúc EMVCo/NAPAS (từ thư viện mã nguồn mở vietnam-qr-pay), chưa quét thử bằng ứng dụng ngân hàng thật. Hãy tự quét thử một mã bằng ứng dụng ngân hàng trước khi gửi cho khách.

## 10. Thuế thu nhập doanh nghiệp (TNDN)

Phần tham số pháp lý (thuế suất, ngưỡng miễn, tạm nộp) nằm trong dữ liệu có ngày hiệu lực và ghi nguồn, không viết cứng trong mã.

| Nội dung | Mức dùng trong phần mềm | Nguồn |
|---|---|---|
| Thuế suất | 20%; 15% khi doanh thu năm trước không quá 3 tỷ đồng; 17% khi trên 3 tỷ đến 50 tỷ đồng; áp dụng từ kỳ 2025 | Luật Thuế TNDN số 67/2025/QH15 Điều 10 |
| Cách xác định doanh thu | Doanh thu bán hàng, cung cấp dịch vụ (không gồm giảm trừ) cộng doanh thu tài chính và thu nhập khác của năm trước, quy đổi 12 tháng theo số tháng của năm tài chính | NĐ 320/2025/NĐ-CP Điều 11 khoản 4 |
| Miễn thuế | Doanh thu năm trước không quá 1 tỷ đồng, từ kỳ 2026 | NĐ 141/2026/NĐ-CP Điều 2 |
| Giảm 30% thuế phải nộp | Kỳ 2026 và 2027, doanh thu không quá 10 tỷ đồng: chỉ gợi ý, chờ hướng dẫn | NQ 43/2026/QH16 Điều 1 khoản 2 |
| Tạm nộp | Tổng 4 quý không thấp hơn 80% số quyết toán, từ 01/7/2026 | NĐ 252/2026/NĐ-CP Điều 24 khoản 3 điểm a |
| Mẫu tờ khai 03/TNDN | Mẫu theo TT 89/2026/TT-BTC, áp dụng cho kỳ tính thuế năm kết thúc từ 01/7/2026 | TT 89/2026/TT-BTC Điều 99, Điều 100, Phụ lục I |

Năm tính thuế kết thúc trước 01/7/2026 (ví dụ năm 2025 trở về trước): phần mềm không có mẫu 03/TNDN theo TT 80/2021 nên báo ("CIT_TEMPLATE_UNAVAILABLE", 409). Cảnh báo ngưỡng 80% chỉ có từ năm 2026.

### Tạm tính thuế TNDN quý

Menu: Thuế > Tạm tính thuế TNDN. Xem cần "cit.view"; lập chứng từ cần "cit.create" và "voucher.create".

1. Nhập Năm, chọn Quý. Màn hình tính ngay theo sổ.
2. Có thể ghi đè ô nhập rồi bấm "Tính (F9)": "Doanh thu năm trước" (để trống thì lấy theo sổ), "Thuế suất" (để trống thì theo luật), "Điều chỉnh", "Lỗ được chuyển", "Đã tạm nộp" (để trống thì lấy theo sổ). Enter chuyển sang ô kế tiếp, ô cuối thì tính.
3. Bảng kết quả (cột Chỉ tiêu, Số tiền (VND), Nguồn):
   - Lợi nhuận kế toán trước thuế lũy kế: lấy từ chỉ tiêu 50 của B02, không gồm bút toán kết chuyển.
   - Điều chỉnh tăng hoặc giảm, Lỗ được chuyển, Thu nhập tính thuế lũy kế.
   - Doanh thu năm trước, Thuế suất (%) (hiện "Miễn thuế" nếu thuộc diện miễn, "Chưa xác định" nếu thiếu doanh thu năm trước).
   - Thuế TNDN lũy kế.
   - "Đã tạm nộp các quý trước": mặc định là số phát sinh Nợ TK 3334 đối ứng tiền (111, 112) từ 01/04 đến hết quý; ghi đè được. Nộp sớm trong tháng 3 không tự tính, hãy nhập tay.
   - "Số tạm nộp quý N" = thuế lũy kế trừ số đã tạm nộp.
   - "Chi phí thuế TNDN đã hạch toán từ đầu năm": chỉ tiêu 51 của B02.
   - "Chi phí thuế TNDN cần ghi thêm" = thuế lũy kế trừ chi phí thuế đã hạch toán.

Tạm tính quý không áp giảm 30% của NQ 43.

Lập chứng từ chi phí thuế:

1. Bấm "Lập chứng từ chi phí thuế TNDN". Nút bật khi "Chi phí thuế TNDN cần ghi thêm" khác 0.
2. Phần mềm lập Phiếu kế toán nháp ngày cuối quý: Nợ TK chi phí thuế (82111 theo TT 99 hoặc 821 theo TT 133), Có TK 3334. Số tiền là chi phí thuế chưa ghi nhận, không phải số phải nộp. Thông báo "Đã lập chứng từ nghiệp vụ khác (nháp)" kèm liên kết mở chứng từ.
3. Kiểm tra rồi ghi sổ. Chứng từ nháp chưa ghi sổ chưa được trừ vào "đã hạch toán", nên bấm hai lần sẽ sinh hai chứng từ nháp: xóa bản thừa.

Màn hình hiện hộp "Lưu ý" khi có cảnh báo (thiếu doanh thu năm trước, đề nghị giảm 30% chờ hướng dẫn…).

### Quyết toán thuế TNDN 03/TNDN

Menu: Thuế > Quyết toán thuế TNDN (03/TNDN). Xem cần "cit.view"; lập cần "cit.create"; sửa nháp "cit.update"; xóa nháp "cit.delete"; chốt cần "tax_return.finalize".

1. Nhập Năm (mặc định năm trước). Bấm "Tính tờ khai" để lập bản nháp "Lần đầu".
2. Lưới chỉ tiêu dựng từ mẫu TT 89/2026: cột STT, Chỉ tiêu, Mã (trong ngoặc vuông), "Số tiền / giá trị", Nguồn. Nhãn Nguồn: "Theo sổ" (lấy từ sổ cái), "Tự tính" (công thức mẫu), "Gợi ý" (chỉ tiêu mẫu không in công thức, phần mềm đặt mặc định, ghi chú trong dấu "i"), "Nhập tay", "Ghi đè".
3. Chỉ tiêu cho phép sửa thì có ô nhập. Số bạn nhập lưu thành ghi đè; bấm "Bỏ ghi đè" để về số phần mềm tính. Bấm "Tính lại (F9)" hoặc Ctrl+S để lưu và tính lại công thức. Enter sang ô kế tiếp.
4. Ghi chú và cảnh báo hiện dưới hộp "Cảnh báo". Nếu số liệu sổ đã đổi từ lần tính trước, hộp đỏ "Số liệu sổ đã thay đổi kể từ lần tính trước: lưu lại nháp để tính lại và kiểm tra trước khi chốt" liệt kê chỉ tiêu cũ và mới. Bấm "Lưu lại nháp" để tính lại.
5. Giảm 30% theo NQ 43 (khi doanh thu năm không quá 10 tỷ) gợi ý ở chỉ tiêu C15, chỉ tính trên thuế thu nhập từ sản xuất kinh doanh, kèm cảnh báo. Miễn thuế theo NĐ 141 gợi ý ở C2. Tất cả là gợi ý: xem xét và sửa theo hướng dẫn chính thức.
6. Bấm "Chốt" (cần "tax_return.finalize"). Hộp "Chốt tờ khai 03/TNDN?" cảnh báo tờ khai đã chốt khóa số liệu; muốn sửa phải lập bổ sung. Chốt xong: "Đã chốt tờ khai". Nếu số liệu sổ đổi giữa lúc tính và lúc chốt, phần mềm từ chối ("TAX_RETURN_STALE") và hiện chỉ tiêu thay đổi để tính lại.
7. Tờ khai đã chốt: "Lập bổ sung" tạo bản "Bổ sung lần 1, 2, …"; bản bổ sung mặc định chép các ô nhập tay của bản chốt gần nhất. Mỗi năm chỉ có một bản nháp ("TAX_RETURN_DRAFT_EXISTS").
8. Chọn "Lần khai" để xem các bản. "Xóa nháp" xóa bản nháp ("Đã xóa tờ khai nháp").

Xuất tệp:

- "Xuất XML": tải XML tờ khai theo định dạng HTKK. Cần đã chốt ("Chốt tờ khai trước khi xuất XML"). Cảnh báo "XML chưa kiểm chứng với HTKK": tên thẻ, mã mẫu, phiên bản trong tệp là giả định tạm của phần mềm vì chưa có XSD hoặc tệp mẫu 03/TNDN của HTKK. Chưa nên nộp thẳng; nạp thử vào HTKK trước.
- "Ký và tải XML": ký số rồi tải tệp `to-khai-03-tndn_signed.xml` (xem `docs/user/ky-so.md`). Cần "signing.use" và tờ khai đã chốt.

Hạn chế của tờ khai: chưa có phụ lục kết quả hoạt động sản xuất kinh doanh (chỉ tiêu A1 lấy từ B02 chỉ tiêu 50); chỉ tiêu mẫu không in công thức (B14, C7, E1, E3) do phần mềm đặt mặc định, kế toán trưởng cần rà.

## 11. Khóa API

Menu: Hệ thống > Khóa API. Cần quyền "api_key.manage" (không có thì màn hình báo "Bạn không có quyền quản lý khóa API"). Dành cho phần mềm bán hàng (POS) và hệ thống ngoài gọi `/api/ext/v1`. Tài liệu kỹ thuật cho đơn vị tích hợp: `docs/dev/api-ngoai.md`.

### Tạo khóa

1. Bấm "Tạo khóa API". Hộp thoại "Tạo khóa API".
2. Nhập "Tên khóa" (ví dụ "POS quầy 1").
3. Chọn "Phạm vi" (ít nhất một):
   - "Đọc danh mục hàng hóa" (`items.read`).
   - "Đọc tồn kho" (`stock.read`).
   - "Lập bán hàng và thu tiền" (`sales.write`).
   - "Gửi hóa đơn đầu vào (XML)" (`inbound_invoice.write`).
4. Chọn "Kho mặc định (cho bán hàng)" nếu đơn bán có hàng hóa mà POS không gửi kho.
5. Bật "Tự ghi sổ chứng từ bán hàng" nếu muốn chứng từ ghi sổ ngay; tắt thì chứng từ ở trạng thái nháp, kế toán duyệt sau. Thu tiền kèm đơn chỉ dùng với khóa tự ghi sổ.
6. Chọn "Ngày hết hạn" (không bắt buộc).
7. Bấm "Tạo khóa". Hộp thoại "Khóa API mới" hiện khóa dạng `kt_<12 ký tự>_<64 ký tự>`. Khóa chỉ hiện một lần ("Khóa chỉ hiện một lần. Hãy chép và lưu vào cấu hình phần mềm bán hàng ngay."). Bấm "Chép", lưu vào cấu hình POS, rồi bấm "Đã lưu, đóng". Phần mềm chỉ giữ dấu vết băm, không khôi phục được khóa.

### Thu hồi

Bấm "Thu hồi" ở dòng khóa, xác nhận "Thu hồi khóa này?" ("Phần mềm đang dùng khóa sẽ bị từ chối ngay."). Thông báo "Đã thu hồi khóa API". Bảng hiện Tên, Tiền tố, Phạm vi, Người dùng, Kho mặc định, Dùng gần nhất, Hết hạn, Trạng thái (Hoạt động, Đã thu hồi, Hết hạn).

### Cần biết

- Khóa gắn với người tạo. Quyền của khóa là quyền hiện hành của người tạo giao với phạm vi đã chọn. Người tạo đổi vai trò, bị khóa hoặc nghỉ việc thì khóa mất quyền theo. Nên tạo khóa bằng tài khoản dịch vụ riêng. Mỗi người chỉ tạo khóa cho chính mình; người có "api_key.manage" thu hồi được mọi khóa trong công ty.
- Khóa chỉ dùng được cho `/api/ext/v1`, không gọi được các chức năng quản trị khác.
- Giới hạn 60 yêu cầu mỗi phút mỗi khóa (đếm trong bộ nhớ từng tiến trình API).
- Mã giao dịch bán hàng (`externalId`) phải duy nhất trong cả công ty, không theo từng khóa. Gửi lại cùng mã và cùng nội dung thì trả kết quả cũ, không lập thêm chứng từ; cùng mã khác nội dung thì từ chối ("EXTERNAL_ID_CONFLICT", 409). Nhiều máy POS nên đặt tiền tố riêng cho mã, ví dụ `POS1-000123`, `POS2-000123`, để không đụng nhau. Mã trở thành số hóa đơn của chứng từ.
- Tồn kho trả về giá trị chỉ khi người tạo khóa có cờ xem giá vốn ("view_cost").
- Kết quả bán hàng qua API chưa kèm hóa đơn điện tử; phát hành HĐĐT làm ở mục 2.

## 12. Soát lỗi mới

Menu: Tiện ích > Soát lỗi dữ liệu. Giai đoạn 5 thêm 9 quy tắc. Mọi quy tắc "quá N ngày" tính theo ngày lịch giờ Việt Nam; "quá 1 giờ" và "quá 1 ngày" của hóa đơn tính theo khoảng thời gian thực.

| Mã | Mức | Tên quy tắc |
|---|---|---|
| HDDT_CHUA_PHAT_HANH | Cảnh báo | Chứng từ bán chưa phát hành hóa đơn điện tử (đã ghi sổ, còn chờ số hóa đơn quá 1 ngày) |
| HDDT_DANG_GUI | Lỗi | Hóa đơn điện tử đang gửi quá 1 giờ |
| HDDT_LOI | Lỗi | Hóa đơn điện tử phát hành lỗi (chưa bỏ) |
| HDDT_CHO_MA_CQT | Cảnh báo | Hóa đơn có mã chờ mã cơ quan thuế quá 1 ngày (ký hiệu C) |
| HDDT_CAN_DAO_GOC | Lỗi | Hóa đơn cần đảo chứng từ gốc |
| HDDV_CHUA_LAP_CT | Cảnh báo | Hóa đơn đầu vào chưa lập chứng từ quá 7 ngày |
| HDDV_CHU_KY | Lỗi | Hóa đơn đầu vào có chữ ký người bán không hợp lệ đã lập chứng từ |
| NH_CHUA_DOI_CHIEU | Cảnh báo | Giao dịch ngân hàng chưa đối chiếu quá 3 ngày |
| NH_LECH_SO_TIEN | Lỗi | Chứng từ gắn giao dịch ngân hàng lệch số tiền |

Cách xử lý:

- HDDT_CHUA_PHAT_HANH: mở chứng từ, bấm "Phát hành HĐĐT" (mục 2), hoặc bỏ chọn ký hiệu nếu dùng hóa đơn giấy.
- HDDT_DANG_GUI: vào Danh sách hóa đơn điện tử, mở hóa đơn, bấm "Thử lại"; kiểm tra kết nối nhà cung cấp.
- HDDT_LOI: xem mã lỗi và thông báo của nhà cung cấp trong chi tiết, sửa nguyên nhân rồi "Bỏ hóa đơn lỗi" và phát hành lại.
- HDDT_CHO_MA_CQT: bấm "Tra mã CQT"; nếu nhà cung cấp mãi không có mã, liên hệ nhà cung cấp.
- HDDT_CAN_DAO_GOC: bấm "Đảo chứng từ gốc" ở chi tiết hóa đơn, hoặc lập chứng từ điều chỉnh nếu kỳ đã khóa.
- HDDV_CHUA_LAP_CT: lập chứng từ mua từ hóa đơn đầu vào, hoặc bấm "Bỏ qua" nếu không dùng.
- HDDV_CHU_KY: kiểm tra lại hóa đơn với người bán; cân nhắc hủy chứng từ đã lập.
- NH_CHUA_DOI_CHIEU: đối chiếu hoặc bỏ qua giao dịch ở Giao dịch ngân hàng. Giao dịch đang gắn chứng từ nháp bỏ quên cũng được báo.
- NH_LECH_SO_TIEN: sửa chứng từ cho khớp số tiền giao dịch, hoặc gỡ liên kết rồi đối chiếu lại. Thực tế chủ yếu gặp với chứng từ nháp, vì chứng từ ghi sổ lệch tiền đã tự gỡ liên kết.

## 13. Phân quyền

- Hóa đơn điện tử: xem "einvoice.view"; phát hành, thử lại, bỏ hóa đơn lỗi, lập 04/SS, điều chỉnh "einvoice.issue"; lập thay thế, hủy, đảo chứng từ gốc cần thêm "voucher.post"; cấu hình nhà cung cấp và ký hiệu "einvoice.config". Đảo vào kỳ khóa cần "voucher.backdate_locked".
- Hóa đơn đầu vào: "inbound_invoice.view", "inbound_invoice.create" (tải lên), "inbound_invoice.update" (bỏ qua, lập chứng từ); lập chứng từ cần thêm "voucher.create"; tạo nhà cung cấp mới cần "catalog.create".
- Ngân hàng: "bank_feed.view" (xem giao dịch, đối chiếu), "bank_feed.match" (gắn, bỏ qua, lập Giấy báo), "bank_feed.create", "bank_feed.update", "bank_feed.delete" (kết nối, mẫu cột, nhập sao kê). Kế toán viên mặc định chỉ có xem và đối chiếu. Gợi ý công nợ cần "view_receivable" hoặc "view_payable".
- QR: "voucher.view"; số tiền phải thu cần "view_receivable".
- Thuế TNDN: "cit.view", "cit.create", "cit.update", "cit.delete"; chốt "tax_return.finalize"; ký số "signing.use".
- Khóa API: "api_key.manage".
- Cờ dữ liệu nhạy cảm chặn ở máy chủ, không chỉ ẩn trên màn hình.

## 14. Hạn chế đã biết

### Ngoài phạm vi giai đoạn này

- Bảng kê chi tiết lương theo đợt, tờ khai 05/KK-TNCN và quyết toán thuế TNCN chuyển sang giai đoạn 6.
- Mẫu 01/BK-ĐCTT (bảng kê hóa đơn đã lập sai).
- Điều chỉnh hóa đơn chỉ thay đổi thông tin (không đổi tiền): dùng thay thế hoặc 04/SS.
- Nhận hóa đơn đầu vào qua email: chỉ có tải lên tệp và qua khóa API.
- Nhà cung cấp hóa đơn khác ngoài SInvoice (meInvoice, VNPT, BKAV): chưa có bộ kết nối. Tiêu chí "XML của ba nhà cung cấp" chưa đạt; XML hóa đơn đầu vào theo QĐ 1233.
- Phụ lục kết quả hoạt động sản xuất kinh doanh kèm 03/TNDN.
- Ký chuẩn PAdES cho tệp PDF; ký số thông báo 04/SS.

### Chưa thử trên môi trường thật

- Viettel SInvoice: bộ kết nối làm theo tài liệu công khai. Tiền gửi lên có tối đa 15 chữ số có nghĩa; tỷ giá làm tròn 2 chữ số theo tài liệu nên tỷ giá trên hóa đơn có thể lệch tỷ giá sổ cái ở chữ số thứ ba. Triển khai thiếu biến `DATA_ENCRYPTION_KEY` thì đối soát báo "ENCRYPTION_KEY_MISSING".
- SePay, Casso (chuẩn JSON và chữ ký thật của Casso), VNPT SmartCA, USB token (cần thư viện PKCS#11 của hãng; tiện ích ký tham chiếu chỉ đọc khóa PEM, không đọc tệp .pfx).
- Mã QR chưa quét bằng ứng dụng ngân hàng thật.
- XML tờ khai 01/GTGT, 03/TNDN chưa nạp thử vào HTKK.
- Chữ ký người bán trên hóa đơn đầu vào chưa kiểm chuỗi chứng thư CA; MST trong chứng thư đọc theo trường UID `MST:` chưa thử trên chứng thư CA thật.

### Hóa đơn điện tử

- Chỉ nhà cung cấp "Giả lập" và SInvoice. SInvoice không gửi được thông báo 04/SS qua phần mềm; không theo dõi cơ quan thuế tiếp nhận hay từ chối 04/SS.
- Danh sách hóa đơn giới hạn 1000 dòng; thông tin khách hàng, tiền hiển thị lấy từ nội dung đã gửi.
- Hóa đơn "Đang gửi" gặp lỗi lạ ở bước nhận kết quả vẫn giữ "Đang gửi" với mã "PENDING" để đối soát; hiện chưa có chỉ báo riêng.
- Đảo chứng từ gốc không tự chạy lại khi thử lại hoặc đối soát nền (mục 3); phải có người bấm nếu việc đảo tự động không thành.
- Hóa đơn đầu vào có dòng chiết khấu thương mại phải nhập chứng từ tay.
- Hình thức thanh toán gửi lên cố định "TM/CK"; không có dòng khuyến mại.
- Tính năng tra MST người bán (mục 6) chưa có nút và ô bật trên giao diện.

### Ngân hàng và QR

- Sao kê dùng mẫu cột do người dùng khai, chưa có mẫu riêng theo từng ngân hàng.
- Casso: số âm hiểu là tiền ra theo suy luận từ tài liệu, cần đối chiếu với giao dịch thật.
- Ngày không có năm trong diễn giải có thể làm gợi ý khớp nhầm hóa đơn có số trùng với ngày hoặc tháng.
- Không có cờ "tài khoản mặc định" cho mã QR; công ty nhiều tài khoản có thể ra QR không đúng tài khoản mong muốn.
- Danh sách BIN lấy từ dịch vụ bên thứ ba, không phải văn bản NAPAS chính thức.
- Webhook SePay dạng form-encoded chưa hỗ trợ. Xoay khóa API hoặc bí mật mà không đổi mã webhook cũng chưa có; "Đổi mã" đổi tất cả. Biến `PUBLIC_BASE_URL` chưa bắt buộc ở môi trường chạy thật (có trong tài liệu triển khai).
- Chứng từ đảo và chứng từ bị đảo vẫn hiện là dòng sổ cái chưa đối chiếu trong đối chiếu sổ phụ.

### Thuế TNDN

- Chưa có phụ lục kết quả kinh doanh; cần văn bản gốc ban hành mẫu.
- Giảm 30% theo NQ 43/2026/QH16 chỉ là gợi ý ở chỉ tiêu C15 chờ hướng dẫn của Chính phủ; mẫu 03/TNDN không có chỉ tiêu riêng.
- Doanh thu quy đổi 12 tháng theo số tháng của năm tài chính, văn bản nói tháng hoạt động thực tế; chênh nhỏ, chỉnh tay được.
- Năm tính thuế kết thúc trước 01/7/2026 chưa có mẫu 03/TNDN (TT 80/2021 chưa có văn bản gốc).
- Số đã tạm nộp tính theo Nợ TK 3334 đối ứng tiền từ 01/04 đến hết quý; nộp sớm hơn hoặc nộp không qua tiền cần nhập tay.
- Kế toán trưởng cần rà cách lấy doanh thu xác định thuế suất và miễn thuế (doanh thu thuần cộng doanh thu tài chính cộng thu nhập khác).

### Khóa API và ký số

- Giới hạn tốc độ nằm trong bộ nhớ từng tiến trình; chạy nhiều tiến trình thì giới hạn thực tế cao hơn.
- Khóa mất quyền theo người tạo (mục 11). Giá trị tồn kho phản ánh lần tính giá vốn gần nhất, không tính lùi theo ngày; tối đa 5000 dòng, quá thì có cờ `truncated`.
- Chỉ ký được 01/GTGT và 03/TNDN. Phiên ký không ghi vào nhật ký kiểm toán vì chứa toàn bộ XML; hồ sơ ký có ghi và che thông tin đăng nhập.
- Máy chủ SmartCA chỉ nhận địa chỉ https trong danh sách cho phép (`rmgateway.vnptit.vn`, `gwsca.vnpt.vn` theo tài liệu); VNPT đổi máy chủ thì quản trị phải sửa biến môi trường.
