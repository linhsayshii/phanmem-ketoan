# Ký số tờ khai

## Cài đặt ký số

Vào Thuế, Cài đặt ký số (`/thue/ky-so`). Mỗi người dùng có hồ sơ ký riêng; người khác không thấy hồ sơ của bạn.

1. Nhấn Insert hoặc "Thêm hồ sơ".
2. Chọn hình thức:
   - Tiện ích ký số trên máy này: chạy tiện ích ký trên máy, nhấn "Lấy chứng thư từ tiện ích".
   - VNPT SmartCA: nhập mã dịch vụ, mật khẩu dịch vụ, định danh thuê bao. Chưa thử trên môi trường thật.
3. Đặt một hồ sơ làm mặc định. Hồ sơ có chứng thư hết hạn không dùng để ký được.

## Ký và tải tờ khai

Ở Tờ khai thuế GTGT, tờ khai phải ở trạng thái đã chốt. Nhấn "Ký và tải XML". Với tiện ích cục bộ, xác nhận y ở cửa sổ dòng lệnh của tiện ích; với SmartCA, xác nhận trên ứng dụng SmartCA. Tệp tải về có đuôi `_signed.xml`.

Khóa riêng không bao giờ được gửi lên máy chủ.

## Quyết toán thuế TNDN (03/TNDN)

Ký tương tự tờ khai GTGT. Vào Thuế, Quyết toán thuế TNDN (03/TNDN). Nút "Ký và tải XML" chỉ bật khi tờ khai đã chốt và bạn có quyền `signing.use`; chưa chốt thì nút bị khóa, di chuột vào thấy "Chốt tờ khai trước khi ký". Ký xong tệp tải về có tên `to-khai-03-tndn_signed.xml` và hiện thông báo "Đã ký số và tải XML".

## Chứng từ không ký được trong phần mềm

Chỉ có hai loại ký được: Tờ khai thuế GTGT (01/GTGT) và Quyết toán thuế TNDN (03/TNDN). Thông báo sai sót 04/SS-HĐĐT chưa có XML để ký trong phần mềm; yêu cầu ký loại này báo ("SIGNING_DOC_UNSUPPORTED") "Chưa có XML để ký cho loại chứng từ …". Hãy nộp thông báo qua cổng thuế hoặc cổng nhà cung cấp hóa đơn.

Các tính năng giai đoạn 5 khác (hóa đơn điện tử, hóa đơn đầu vào, ngân hàng, thuế TNDN) xem `docs/user/giai-doan-5-hoa-don-tich-hop.md`.
