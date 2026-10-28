# Giai đoạn 7: cổng pháp lý chặt hơn và làm tròn tiền

Gói này siết các cổng dữ liệu pháp lý đang `false` để người dùng không vô tình lập, ký, nộp hồ sơ dựa trên giả định của phần mềm, và sửa một số chỗ làm tròn tiền làm số lệch vài đồng.

## 1. Hóa đơn điện tử thuế suất 8%

Nghị quyết 204/2025/QH15 giảm 2% thuế GTGT (còn 8%) từ 01/7/2025 đến hết 31/12/2026. Ngày hiệu lực lấy từ tham số pháp lý `vat_reduced_rate`, không viết cứng ở mã.

- Khi phát hành hóa đơn điện tử, nếu một dòng dùng thuế suất 8% mà ngày hóa đơn ngoài khoảng hiệu lực (sau 31/12/2026, hoặc trước 01/7/2025), phần mềm trả lỗi 409 `VAT_RATE_NOT_EFFECTIVE` kèm ngày hóa đơn. Hóa đơn đã cấp mã không hủy được, nên việc chặn nằm trước khi gửi lên cơ quan thuế.
- Chọn lại mã thuế đang áp dụng (ví dụ 10%) rồi phát hành lại.
- Hóa đơn điều chỉnh, thay thế của một hóa đơn gốc 8% đã lập đúng hạn không bị chặn (giữ thuế suất của hóa đơn gốc).
- Ghi sổ hóa đơn 8% sau 31/12/2026 vẫn được; tờ khai 01/GTGT và quy tắc soát lỗi cảnh báo như trước.

## 2. Tờ khai 01/GTGT có hóa đơn 8%

Mẫu 01/GTGT theo Thông tư 89/2026 không có dòng 8%; phần mềm tạm gộp vào [32] và [33] (cổng `01GTGT_TT89_rate8` = false).

- Kỳ có hóa đơn bán ra 8%: bấm "Chốt" hiện hộp thoại "Hóa đơn bán ra 8% chưa có chỉ tiêu trong mẫu". Chỉ bấm "Xác nhận và chốt" khi bạn đã xử lý cách khai (lập kèm Mẫu số 01 Phụ lục II Nghị định 174/2025/NĐ-CP). Xác nhận được lưu trên tờ khai và ghi vào nhật ký kiểm toán.
- Không xác nhận thì tờ khai không chốt được (mã `VAT_RATE8_UNVERIFIED`), và tờ khai đã chốt mà chưa xác nhận (ví dụ chốt từ trước) không xuất XML, không ký số được: lập tờ khai bổ sung rồi xác nhận khi chốt.
- Kỳ không có hóa đơn 8% không bị ảnh hưởng.

## 3. Ký số tệp XML chưa kiểm chứng với HTKK

Định dạng XML của 01/GTGT và 03/TNDN là giả định của phần mềm (chưa có tệp HTKK thật). Xuất XML vẫn được (kèm cảnh báo) để bạn nạp thử vào HTKK. Ký số thì phải xác nhận: hộp thoại "Ký tệp XML chưa kiểm chứng?" → "Vẫn ký". Bản ký được ghi nhật ký kiểm toán (hành động `sign_unverified_xml`). Trang 01/GTGT và 03/TNDN nay cùng cảnh báo khi chưa tải được danh sách định dạng.

## 4. Chế độ kế toán và năm tài chính

- Hiệu lực và cổng của TT99, TT133, TT200 lưu thành dữ liệu (`packages/coa-data/data/regimes/accounting.json`): TT99 áp dụng cho năm tài chính bắt đầu từ 01/01/2026; TT200 chỉ còn cho dữ liệu đến hết 2025 và hệ thống tài khoản chưa đối chiếu Phụ lục 1, chưa có B01/B02/B03 (nên "Chưa dùng cho kế toán thật" ở Hệ thống > Chế độ kế toán).
- Tạo năm tài chính theo chế độ chưa sẵn sàng hoặc ngày bắt đầu ngoài hiệu lực: 409 `REGIME_NOT_READY` / `REGIME_NOT_EFFECTIVE`. Hộp thoại "Tạo năm tài chính theo chế độ này?" cho phép "Vẫn tạo" khi cần xem lại dữ liệu cũ; việc này ghi nhật ký (`fiscal_year_regime_override`).
- TT58 và TT152 chưa có hệ thống tài khoản nên không có cách xác nhận: vẫn trả 409 `COA_TEMPLATE_PENDING`.

## 5. Số mẫu in trên sổ và báo cáo

Số mẫu chỉ in khi đã đối chiếu văn bản gốc. Đã bỏ: Nhật ký chung (S03a), Sổ Cái (S03b), sổ chi tiết theo đối tượng (S38/S20-DNN), Bảng cân đối số phát sinh (S06 trùng số với sổ chi tiết vật liệu), các sổ Chứng từ ghi sổ (S02a, S02b, S02c1) và mọi số mẫu, dòng "Ban hành theo" của TT200. Các sổ này vẫn in đủ nội dung, chỉ không có dòng "Mẫu số". Còn giữ: B01/B02/B03 của TT99 và TT133, chứng từ tiền, kho, TSCĐ, sổ quỹ, sổ tiền gửi, sổ chi tiết vật liệu và thẻ kho (đã đối chiếu).

## 6. Chú thích trên Báo cáo tài chính

B01/B02/B03 in thêm chú thích của phần mềm: chỉ tiêu luôn bằng 0 (chưa có dữ liệu nguồn, nhập tay nếu có phát sinh) và cách lấy số gần đúng (ví dụ B01 TT99 dòng 112, 124 đến 126; B03 gom 338 vào dòng 07). Màn hình Báo cáo tài chính hiện cùng nội dung ở khung thông tin phía trên bảng.

## 7. Làm tròn tiền

- Bảng lương có cột khấu trừ làm tròn lẻ (ví dụ "Tạm ứng" làm tròn 2 chữ số, TK Có 141): mỗi giá trị làm tròn về đồng (nửa lên) rồi mới cộng và ghi Có; phần dư do làm tròn nằm ở 3388. Chứng từ lương luôn cân Nợ/Có.
- Đợt thanh toán hợp đồng theo tỷ lệ cộng đúng 100%: đợt cuối nhận phần dư, tổng đợt bằng giá trị hợp đồng.
- Sổ tài sản cố định: "Mức khấu hao năm" = nguyên giá x 12 / số tháng (1 tỷ, 84 tháng là 142.857.143), khớp bảng tính khấu hao; cột tỷ lệ vẫn hiện làm tròn 2 chữ số (14,29%).
- Tổng đơn hàng trong danh sách khớp số trên hóa đơn sinh từ đơn (thành tiền dòng làm tròn trước, chiết khấu làm tròn sau).
- Phân bổ chi phí chung cho vụ việc: phần dư chia theo phần lẻ lớn nhất; số có thể lệch 1 đồng so với trước đây.
- Định dạng số không còn in "-0".

## Hạn chế còn lại

- Ngày bắt đầu hiệu lực của TT99 (01/01/2026) và ngày hết hiệu lực của TT200 lấy từ đặc tả mục 10, chưa đối chiếu lại điều khoản thi hành của văn bản gốc TT 99/2025.
- Số mẫu S03a, S03b, S38, S06, S02 của TT99 và TT133 còn để trống chờ đối chiếu Phụ lục sổ kế toán.
- Tờ khai 01/GTGT chưa có chỉ tiêu 8% riêng (chờ hướng dẫn); XML HTKK chưa kiểm chứng.
- Chưa làm: cảnh báo khi đánh giá lại tỷ giá theo TT200 (quy tắc chưa đối chiếu), lãi vay ngoại tệ theo đơn vị nhỏ nhất của loại tiền, nguồn văn bản của sơ đồ kết chuyển, tách câu dẫn luật khỏi mã.
