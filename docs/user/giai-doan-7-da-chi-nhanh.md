# Đa chi nhánh và BCTC tổng hợp (GĐ7)

Một công ty (một bộ sổ) có thể có nhiều chi nhánh, đơn vị trực thuộc. Mỗi chứng từ thuộc trụ sở chính hoặc một chi nhánh. Kế toán chi nhánh chỉ thấy và ghi chứng từ, sổ sách, báo cáo tài chính của chi nhánh mình. Kế toán trụ sở chính xem từng chi nhánh hoặc lập BCTC tổng hợp.

## 1. Khai báo chi nhánh

Menu **Hệ thống → Chi nhánh**, thẻ **Danh mục chi nhánh**:

- **Insert** (hoặc nút Thêm chi nhánh): nhập mã, tên, MST đơn vị trực thuộc (nếu chi nhánh có mã số thuế riêng, dạng `0101234567-001`), đơn vị cấp trên (để trống là trực thuộc trụ sở chính). **Ctrl+S** để lưu.
- Nhấn đúp một dòng hoặc nút Sửa để sửa; bỏ chọn Đang dùng để ngừng dùng.
- Chi nhánh là một bộ phận có đánh dấu "Là chi nhánh" trong danh mục Bộ phận, nên kho gắn chi nhánh dùng chung danh mục này.

Quyền: xem danh mục (`catalog.view`), thêm (`catalog.create`), sửa (`catalog.update`).

## 2. Chi nhánh làm việc

Thẻ **Chi nhánh làm việc**: chọn đơn vị mà chứng từ bạn lập sẽ thuộc về. Mọi chứng từ mới (phiếu thu, phiếu chi, giấy báo, hóa đơn, phiếu kho, phiếu kế toán, chứng từ tự động) gắn chi nhánh làm việc của người lập.

- Chứng từ đảo luôn thuộc chi nhánh của chứng từ gốc.
- Chứng từ kết chuyển cuối kỳ (KC) thuộc trụ sở chính.
- Chứng từ lập trước khi có chi nhánh thuộc trụ sở chính.
- Đổi chi nhánh của một chứng từ: chỉ khi chứng từ còn nháp. Chứng từ đã ghi sổ phải **Bỏ ghi sổ** rồi đổi. Mỗi lần đổi được ghi vào Nhật ký kiểm toán.

## 3. Phân quyền theo chi nhánh

Menu **Hệ thống → Người dùng**, cột **Phạm vi chi nhánh**: nhấn nút để chọn các đơn vị (trụ sở chính và/hoặc chi nhánh) người dùng được phép. Để trống là toàn công ty. Không tự đặt phạm vi cho chính mình.

Người dùng bị giới hạn chi nhánh:

- Chỉ thấy chứng từ của đơn vị được phép ở mọi màn hình; chứng từ đơn vị khác coi như không có (mở theo đường dẫn cũng báo không tìm thấy), không sửa, ghi sổ, bỏ ghi sổ, đảo, xóa được. Không chuyển được chứng từ sang đơn vị ngoài phạm vi. Kiểm tra nằm ở máy chủ và cơ sở dữ liệu, không chỉ ẩn trên giao diện.
- Chỉ giữ các quyền làm việc với chứng từ, phiếu kho, xem danh mục, Sổ sách và Báo cáo tài chính. Các phân hệ tổng hợp cả công ty (công nợ, đối trừ, quỹ, kho, tài sản, khế ước vay, thuế, hóa đơn điện tử, ngân hàng, cuối kỳ, số dư đầu kỳ, quản trị) bị tắt vì số liệu của chúng chưa tách theo chi nhánh.
- Khóa API do người dùng này tạo cũng mang phạm vi chi nhánh của họ.

## 4. Sổ sách và Báo cáo tài chính theo chi nhánh

Màn **Sổ sách** (Nhật ký chung, Sổ Cái, Sổ chi tiết, Bảng cân đối số phát sinh) và **Báo cáo tài chính** (B01, B02, B03, truy ngược) có ô **Chi nhánh**: Tất cả chi nhánh, Trụ sở chính hoặc một chi nhánh. Bản in PDF/Excel theo cùng bộ lọc. Người dùng bị giới hạn chỉ thấy các đơn vị trong phạm vi; "Tất cả" là tất cả đơn vị trong phạm vi.

Số dư đầu kỳ, cuối kỳ của sổ lọc chi nhánh cộng từ các chứng từ đã ghi sổ của chi nhánh đó. Lưu ý:

- B01 của riêng một chi nhánh thường không cân (tài sản khác nguồn vốn) vì kết chuyển lãi lỗ ghi ở trụ sở chính; số tổng hợp mới cân.
- Khi lọc chi nhánh, phần dài hạn của gốc vay theo khế ước không được tách (khế ước chưa gắn chi nhánh): gốc vay hiện ở dòng ngắn hạn.

## 5. BCTC tổng hợp

Thẻ **BCTC tổng hợp** (quyền xem báo cáo): chọn B01 hoặc B02 và khoảng ngày. Bảng có:

- Một cột cho mỗi đơn vị (trụ sở chính, từng chi nhánh trong phạm vi), lập theo cùng định nghĩa báo cáo của công ty.
- **Cộng**: tổng các cột đơn vị.
- **Loại trừ nội bộ**: phần của các tài khoản nội bộ giữa các đơn vị (mặc định 136 Phải thu nội bộ, 336 Phải trả nội bộ).
- **Tổng hợp** = Cộng − Loại trừ nội bộ.

Khi phải thu nội bộ và phải trả nội bộ chưa khớp nhau (dư ròng các tài khoản nội bộ khác 0), màn hình cảnh báo số chênh lệch: đối chiếu nội bộ trước khi dùng số tổng hợp.

Nút **Khai báo tài khoản nội bộ** (quyền sửa tùy chọn hệ thống): thêm tiền tố tài khoản dùng riêng cho giao dịch nội bộ, ví dụ tài khoản chi tiết doanh thu bán hàng nội bộ mà công ty tự mở. Phần mềm không tự đoán doanh thu, giá vốn nội bộ.

## 6. Hợp nhất nhiều pháp nhân (Thông tư 202/2014/TT-BTC)

Chưa có. Báo cáo tài chính hợp nhất của công ty mẹ và công ty con (loại trừ khoản đầu tư và vốn, lợi ích cổ đông không kiểm soát) chờ văn bản gốc Thông tư 202/2014/TT-BTC và Thông tư 43/2026/TT-BTC sửa đổi. BCTC tổng hợp ở mục 5 chỉ dùng cho các chi nhánh của cùng một công ty.

## 7. Chưa làm

- Đánh số chứng từ riêng theo chi nhánh: mọi chi nhánh dùng chung dãy số theo loại chứng từ và năm.
- Ô chi nhánh trên form và cột chi nhánh trên danh sách chứng từ (đổi chi nhánh làm việc trước khi lập).
- Số dư đầu kỳ theo chi nhánh: chứng từ số dư đầu kỳ thuộc chi nhánh làm việc của người nhập.
