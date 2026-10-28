# Ngân sách và phân tích tài chính (Giai đoạn 7, nhóm 3)

Menu **Ngân sách và phân tích** gồm hai màn hình: **Ngân sách** (`/ngan-sach`) và **Phân tích tài chính** (`/phan-tich`).

## 1. Lập ngân sách

Ngân sách là dự toán theo **năm tài chính**, có nhiều **phiên bản**; mỗi năm chỉ một phiên bản **Đã duyệt** đang áp dụng.

1. Vào **Ngân sách**, nhấn **Thêm (Insert)**, đặt tên, chọn năm.
2. Nhập mỗi dòng ngân sách trên lưới bàn phím (Enter/Tab chuyển ô, Insert chèn dòng, Ctrl+S lưu):
   - **Tài khoản / nhóm**: mã tài khoản hoặc tiền tố (ví dụ `642` gồm 6421, 6422...).
   - **Khoản mục phí, Bộ phận, Dự án** (tùy chọn): để trống nghĩa là mọi giá trị; nhập mã có trong danh mục.
   - **T1 đến T12**: số tiền từng tháng của kỳ kế toán, đồng nguyên, không âm. Cột **Cả năm** tự cộng.
3. **Duyệt** khi xong (cần quyền duyệt ngân sách). Duyệt một phiên bản làm phiên bản đã duyệt trước đó của năm thành *Đã thay thế*.
4. Ngân sách đã duyệt không sửa được: dùng **Tạo phiên bản mới** để chỉnh.

Loại tài khoản quyết định chiều so sánh: tài khoản loại 1, 2, 6, 8 tính theo bên Nợ (chi phí, đầu tư); loại 3, 4, 5, 7 tính theo bên Có (doanh thu, thu nhập).

### Sao chép từ thực tế năm trước

**Sao chép từ thực tế năm trước** tạo ngân sách nháp: mỗi tài khoản doanh thu, chi phí (loại 5, 6, 7, 8) có phát sinh thành một dòng, số từng tháng bằng thực tế nhân **hệ số** (ví dụ 1.1 là tăng 10%), làm tròn đồng; số âm lấy 0. Tài khoản mà bạn không có quyền xem (giá vốn, công nợ) bị bỏ qua và được báo lại.

### Nhập và xuất Excel

Trong cửa sổ ngân sách nháp: **Tải mẫu Excel**, điền từ dòng 4 (dòng 3 là ví dụ, bị bỏ qua), **Nhập Excel** thay toàn bộ dòng của ngân sách. Có lỗi thì không nhập dòng nào và báo dòng, cột sai. **Xuất Excel** xuất đúng khuôn mẫu để sửa rồi nhập lại.

## 2. Thực hiện so với ngân sách

Thẻ **Thực hiện so với ngân sách**: chọn ngân sách và tháng. Mỗi dòng có ba nhóm cột: **tháng**, **lũy kế từ đầu năm**, **cả năm**, mỗi nhóm gồm Ngân sách, Thực tế, Chênh lệch (thực tế trừ ngân sách) và % thực hiện.

- Thực tế lấy từ sổ cái: chứng từ đã ghi sổ theo kỳ kế toán, bút toán kết chuyển cuối kỳ không tính, chứng từ đã đảo triệt tiêu với bút toán đảo.
- Nhấp đúp một dòng (hoặc **Truy ngược**) để xem các dòng chứng từ tạo nên số thực tế.
- Dòng có tài khoản thuộc nhóm nhạy cảm (công nợ, giá vốn) chỉ xem được khi tài khoản của bạn có cờ tương ứng (phải thu, phải trả, giá vốn); thiếu cờ, máy chủ từ chối xem báo cáo.

## 3. Cảnh báo vượt ngân sách khi ghi sổ

Thẻ **Cảnh báo vượt ngân sách** (cần quyền duyệt ngân sách để sửa). **Tắt mặc định.**

- **Cảnh báo từ x%**: khi ghi sổ chứng từ làm thực tế lũy kế của một dòng ngân sách chi phí đạt từ x% ngân sách lũy kế đến tháng của chứng từ, chứng từ vẫn được ghi sổ và phản hồi kèm cảnh báo (`warnings`).
- **Chặn từ y%** (tùy chọn, y không nhỏ hơn x): vượt mức này thì chứng từ **không ghi sổ được** (mã lỗi `BUDGET_EXCEEDED`); chứng từ giữ nguyên ở trạng thái nháp.
- Dòng ngân sách có ngân sách lũy kế bằng 0 mà đã phát sinh thực tế được coi là vượt mọi mức.
- Chỉ xét chứng từ do người dùng lập, theo ngân sách đã duyệt của năm. Chứng từ tự động của hệ thống (giá vốn, khấu hao, phân bổ, kết chuyển...) không bị chặn.
- Thông báo không nêu số tiền, chỉ nêu tài khoản, dòng ngân sách và % thực hiện.

## 4. Phân tích tài chính

Chọn năm tài chính và tháng cuối kỳ. Màn hình hiển thị:

- Các thẻ: doanh thu, chi phí, lợi nhuận lũy kế, tiền, phải thu, phải trả cuối tháng.
- Biểu đồ **doanh thu, chi phí, lợi nhuận theo tháng**; biểu đồ **tiền, phải thu, phải trả cuối tháng**; biểu đồ **chi phí và doanh thu thực tế so với ngân sách** (khi năm có ngân sách đã duyệt). Rê chuột để xem số, **Xem bảng số** để đọc dạng bảng.
- **Hệ số tài chính** tính từ Báo cáo tình hình tài chính (B01) và Báo cáo kết quả hoạt động kinh doanh (B02) của chính công ty: thanh toán hiện hành, thanh toán nhanh, nợ trên tổng tài sản, nợ trên vốn chủ sở hữu, biên lợi nhuận gộp và ròng, ROA, ROE, vòng quay hàng tồn kho và phải thu. Số lấy ở cuối kỳ, không bình quân và không quy đổi năm. Hệ số nào mà báo cáo của chế độ kế toán đang dùng không có đủ chỉ tiêu (ví dụ không tách ngắn hạn, dài hạn) thì **không hiện**, hệ thống không tự suy ra.
- Số liệu liên quan chi phí/giá vốn, phải thu, phải trả bị ẩn khi tài khoản thiếu cờ nhạy cảm tương ứng; hệ số tài chính cần đủ ba cờ.

## Phân quyền

`budget.view` xem; `budget.create`, `budget.update`, `budget.delete` lập, sửa, xóa ngân sách nháp; `budget.approve` duyệt và cấu hình cảnh báo. Báo cáo thực hiện và phân tích cần thêm `report.view`.
