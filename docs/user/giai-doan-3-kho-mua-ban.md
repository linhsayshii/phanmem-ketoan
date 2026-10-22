# Kho, mua hàng và bán hàng hóa (giai đoạn 3)

Giai đoạn 3 thêm kế toán vật tư hàng hóa: danh mục vật tư, kho, nhập kho, xuất kho, giá vốn, hóa đơn mua và bán hàng hóa. Tài liệu này mô tả đúng những gì phần mềm đang làm và được bổ sung dần theo từng tác vụ. Phím tắt vẫn như các giai đoạn trước: Enter/Tab sang ô kế tiếp, F4 tra cứu danh mục, Ctrl+S lưu, F9 ghi sổ, Insert thêm mới.

## Danh mục

### Cách dùng chung của Danh mục

Mọi danh mục (đối tượng, nhóm đối tượng, bộ phận, ngân hàng, đơn vị tính, vật tư hàng hóa, kho…) nằm trong menu Danh mục hoặc menu Kho và dùng chung một cách thao tác.

- Thêm: bấm nút Thêm hoặc phím Insert, điền biểu mẫu, bấm Đồng ý. Ví dụ thêm một đối tượng: vào Danh mục, Đối tượng, nhập Mã và Tên đối tượng.
- Tìm: ô "Tìm mã, tên…" lọc theo mã và tên. Bộ lọc được nhớ cho lần mở sau.
- Ngưng dùng: bấm "Ngưng dùng" ở cuối dòng. Mục ngưng dùng không còn hiện trong danh sách tra cứu F4 nhưng chứng từ cũ vẫn giữ nguyên. Chọn "Ngưng dùng" hoặc "Tất cả" ở ô Trạng thái để xem lại, bấm "Dùng lại" để dùng tiếp. Mục đã phát sinh chứng từ không xóa được, chỉ ngưng dùng.
- Nhập từ Excel: dùng chức năng nhập Excel của từng danh mục; dòng sai được báo theo số dòng và tên cột trong tệp.

### Vật tư hàng hóa

Menu Kho, Vật tư hàng hóa. Mỗi vật tư hàng hóa có ba nhóm thông tin.

- Thông tin chung: Mã, Tên, Tên tiếng Anh, Nhóm, Tính chất (Hàng hóa, Nguyên vật liệu, Thành phẩm, Dịch vụ, Công cụ dụng cụ), ĐVT cơ sở, thuế suất mặc định, tồn tối thiểu và tối đa, vị trí kho, mã vạch, tài khoản kho, tài khoản doanh thu, tài khoản giá vốn. Dịch vụ không có tồn kho.
- ĐVT quy đổi: khi lưu vật tư, phần mềm tự thêm dòng ĐVT cơ sở với hệ số 1. Sau khi lưu, mở lại vật tư, chọn thẻ "ĐVT quy đổi", chọn ĐVT và nhập hệ số quy đổi ra ĐVT cơ sở (ví dụ THUNG = 24 khi ĐVT cơ sở là CAI), bấm "Thêm ĐVT". Dòng ĐVT cơ sở không xóa được.
- Lô, hạn dùng: chọn theo dõi theo lô hoặc theo lô và hạn dùng, nhập số ngày hạn dùng.

Nhóm vật tư hàng hóa (menu Kho) là danh mục dạng cây: một nhóm có thể thuộc nhóm cha.

### Nhập Excel vật tư hàng hóa

Tệp nhập có thêm cột "ĐVT quy đổi" viết dạng `THUNG=24;HOP=6`, mỗi cặp là mã ĐVT và hệ số quy đổi ra ĐVT cơ sở. Phần mềm báo lỗi bằng tiếng Việt kèm số dòng và tên cột, ví dụ "Dòng 6, cột ĐVT quy đổi: …", khi gặp ĐVT không có trong danh mục, ĐVT trùng, ĐVT trùng ĐVT cơ sở, hệ số không phải số dương hoặc sai khuôn dạng. Số dòng là số dòng trong tệp Excel.

### Kho

Menu Kho, Kho. Mỗi kho có Mã, Tên, Loại kho (Kho thường, Kho gửi bán dùng TK 157, Kho nhận bán hộ), TK kho, Phương pháp tính giá xuất (Bình quân cuối kỳ, Bình quân tức thời, Nhập trước xuất trước, Đích danh) và Chi nhánh.

### Bảng giá

Menu Kho, Bảng giá (Insert để thêm). Mỗi bảng giá có Mã, Tên, Loại (giá bán hoặc giá mua), Loại tiền, Nhóm đối tượng (để trống là áp dụng chung), Hiệu lực từ, Đến (để trống là không giới hạn) và Ưu tiên.

Dòng giá nhập trên lưới: Mã hàng (F4), ĐVT (F4), Từ số lượng, Đơn giá, Chiết khấu (%). Cùng một hàng và ĐVT có thể có nhiều bậc theo "Từ số lượng": mua 10 lấy giá bậc từ 10. Ctrl+S để lưu. Có thể nhập dòng giá từ Excel (nút "Nhập Excel" khi sửa bảng giá, tải mẫu ở liên kết bên cạnh).

Khi lập chứng từ, phần mềm chọn bảng giá còn hiệu lực ở ngày chứng từ, đúng loại tiền; bảng giá gắn nhóm của đối tượng được ưu tiên trước bảng giá chung, sau đó đến Ưu tiên cao hơn. Giá chỉ điền sẵn vào dòng chứng từ để gợi ý, vẫn sửa được và không ràng buộc sổ cái.

### Các khóa an toàn

Phần mềm từ chối (lỗi 409) các thay đổi làm sai lệch số liệu đã có:

- Đổi ĐVT cơ sở của vật tư đã phát sinh chứng từ: "ITEM_UOM_LOCKED".
- Đổi cách theo dõi lô, hạn dùng của vật tư đã phát sinh: "ITEM_TRACKING_LOCKED".
- Xóa vật tư đã phát sinh chứng từ: "ITEM_IN_USE". Hãy chọn "Ngưng dùng".

### Phân quyền

Vật tư hàng hóa dùng nhóm quyền `item.*`, kho dùng `warehouse.*`, bảng giá dùng `price_list.*`. Quản trị viên cấp cho từng vai trò.
