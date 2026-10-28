# Phê duyệt đề nghị thanh toán, tạm ứng và ứng dụng di động

Giai đoạn 7 thêm quy trình phê duyệt cho **Đề nghị thanh toán** và **Đề nghị tạm ứng**. Đề nghị không phải chứng từ kế toán: không vào sổ cái. Khi duyệt xong bước cuối, phần mềm lập sẵn **Phiếu chi** (chi tiền mặt) hoặc **Giấy báo Nợ** (chuyển khoản) ở trạng thái nháp để kế toán kiểm tra và ghi sổ.

## Cấu hình quy trình phê duyệt

Menu **Phê duyệt → Quy trình phê duyệt** (cần quyền Sửa tùy chọn hệ thống).

- Mỗi quy trình gồm: loại đề nghị (thanh toán / tạm ứng), tên, **áp dụng từ số tiền** (VND) và tối đa 10 bước. Mỗi bước do một **vai trò** (ví dụ Kế toán trưởng) hoặc **một người** cụ thể duyệt.
- Chọn quy trình theo hạn mức: đề nghị dùng quy trình đang dùng cùng loại có mức "áp dụng từ số tiền" lớn nhất không vượt số tiền đề nghị (đề nghị bằng ngoại tệ so theo số quy đổi VND). Ví dụ: quy trình A từ 0 (Kế toán trưởng duyệt), quy trình B từ 10.000.000 (Kế toán trưởng rồi Giám đốc duyệt): đề nghị 5.000.000 đi theo A, đề nghị 20.000.000 đi theo B.
- Hai quy trình đang dùng cùng loại không được trùng mức. Muốn đổi, sửa quy trình hoặc tắt "Đang dùng".
- Sửa quy trình không ảnh hưởng đề nghị đã gửi duyệt: các bước được chụp lại tại lúc gửi.
- Chưa có quy trình phù hợp thì đề nghị không gửi duyệt được.
- Phím tắt: Insert thêm quy trình, Ctrl+S lưu.

## Lập đề nghị

Menu **Phê duyệt → Đề nghị thanh toán, tạm ứng**, nút **Lập đề nghị** (Insert).

| Trường | Ghi chú |
|---|---|
| Loại đề nghị | Đề nghị thanh toán (số DNTT-năm-số thứ tự) hoặc Đề nghị tạm ứng (DNTU-…). |
| Ngày đề nghị, Hạn thanh toán | Phiếu chi nháp lấy ngày đề nghị; kế toán sửa thành ngày chi thực tế trước khi ghi sổ. |
| Đối tượng (F4) | Bắt buộc khi TK Nợ theo dõi công nợ (ví dụ 331 – Phải trả cho người bán). |
| Người nhận tiền, Lý do | Bắt buộc; người nhận in lên phiếu chi. |
| Loại tiền, Số tiền, Tỷ giá | VND là số nguyên; ngoại tệ đến 4 chữ số thập phân, cần tỷ giá. |
| TK Nợ (F4) | Để trống: 331 với đề nghị thanh toán, 141 – Tạm ứng với đề nghị tạm ứng. Có thể chọn TK chi phí. |
| Hình thức chi | Tiền mặt (Có 1111/1112) hoặc Chuyển khoản (Có TK của tài khoản ngân hàng đã chọn). |

**Lưu nháp** (Ctrl+S) để sửa tiếp, **Lưu và gửi duyệt** để chuyển sang Chờ duyệt. Mở đề nghị để **Đính kèm tệp** (báo giá, hóa đơn, giấy đi đường). Tệp thêm được khi đề nghị còn nháp hoặc đang chờ duyệt, xóa được khi còn nháp.

Người đề nghị **hủy** được đề nghị nháp hoặc đang chờ duyệt. Đề nghị đã gửi thì không sửa được nữa; cần thay đổi thì hủy và lập đề nghị mới.

## Duyệt và từ chối

- Tab **Chờ tôi duyệt** liệt kê đề nghị đang ở bước mà bạn (hoặc vai trò của bạn) được duyệt. Huy hiệu **Chờ duyệt** ở đầu trang cho biết số việc đang chờ.
- Mở đề nghị, xem số tiền, người nhận, lý do, tệp đính kèm, các bước và lịch sử; bấm **Duyệt** (có thể ghi chú) hoặc **Từ chối** (bắt buộc nhập lý do).
- Quy tắc: người đề nghị không tự duyệt đề nghị của mình; chỉ đúng người hoặc đúng vai trò của bước hiện tại được duyệt; một người không duyệt hai bước của cùng một đề nghị (bước sau phải là người khác).
- Bị từ chối thì đề nghị kết thúc ở trạng thái **Từ chối** kèm lý do.
- Duyệt xong bước cuối: trạng thái **Đã duyệt**, phần mềm lập Phiếu chi / Giấy báo Nợ nháp: Nợ TK của đề nghị (kèm đối tượng), Có TK tiền; diễn giải gồm số đề nghị và lý do; tệp đính kèm được chép sang chứng từ gốc của phiếu. Đề nghị có đường dẫn đến phiếu. Kế toán kiểm tra rồi ghi sổ như phiếu lập tay.
- Trạng thái: Nháp → Chờ duyệt → Đã duyệt / Từ chối / Đã hủy. Mọi thay đổi đều ghi Nhật ký kiểm toán.

## Duyệt hàng loạt

Ở tab **Chờ tôi duyệt** (màn hình rộng), đánh dấu nhiều đề nghị rồi bấm **Duyệt n đề nghị đã chọn** và xác nhận (tối đa 100 đề nghị mỗi lần). Mỗi đề nghị được duyệt riêng theo đúng quy tắc duyệt từng cái; đề nghị không duyệt được (đã được duyệt, sai bước, thiếu quyền xem số liệu...) được liệt kê kèm lý do và không ảnh hưởng các đề nghị khác. Đề nghị bước cuối duyệt xong vẫn sinh phiếu chi nháp như thường. Từ chối hàng loạt có ở API (`/api/approvals/batch/reject`, cần nhập một lý do chung); trên màn hình, từ chối từng đề nghị.

Báo lỗi hàng loạt không nêu tên quyền xem số liệu bị thiếu: đề nghị bạn không có quyền xem chỉ báo "Bạn không duyệt được đề nghị này".

## Ủy quyền duyệt khi vắng mặt

**Phê duyệt > Ủy quyền duyệt** (hoặc liên kết ở trang Đề nghị): chọn người được ủy quyền, khoảng ngày (tối đa 366 ngày) và lý do (không bắt buộc). Trong khoảng ngày đó người được ủy quyền thấy trong **Chờ tôi duyệt** các đề nghị đang ở bước của bạn (cột **Duyệt thay** ghi tên bạn) và duyệt hoặc từ chối thay bạn. Nhật ký của đề nghị ghi cả hai người, vd. "an (thay binh): Duyệt bước 1".

Quy tắc:
- Người được ủy quyền phải có quyền duyệt và cờ xem số liệu của chính họ (ủy quyền không cấp thêm quyền hay cờ nhạy cảm), và không bị giới hạn theo chi nhánh (người bị giới hạn chi nhánh không còn quyền duyệt).
- Không tự ủy quyền cho mình; không ủy quyền vòng (A cho B, B cho C, C cho A trong khoảng ngày chồng nhau); ủy quyền chỉ một bước, người nhận không ủy quyền tiếp.
- Không tự duyệt: người được ủy quyền không duyệt thay đề nghị do chính người ủy quyền lập, cũng không duyệt đề nghị do chính mình lập. Một người (kể cả khi duyệt thay) không duyệt hai bước của cùng một đề nghị: người ủy quyền đã duyệt bước trước thì người được ủy quyền không duyệt bước sau thay họ, và ngược lại.
- Người ủy quyền hoặc quản trị (quyền sửa tùy chọn hệ thống) thu hồi được bất cứ lúc nào; thu hồi có hiệu lực ngay. Ủy quyền hết hạn tự mất hiệu lực. Quản trị xem mọi ủy quyền của công ty; lập thay người khác (qua API) cần quyền quản lý người dùng và người nhận không được là chính người lập.
- Lập, thu hồi ủy quyền đều ghi Nhật ký kiểm toán.

## Quyền

| Quyền | Mặc định |
|---|---|
| Lập đề nghị thanh toán, tạm ứng | Quản trị, Kế toán trưởng, Kế toán viên |
| Duyệt đề nghị thanh toán, tạm ứng | Quản trị, Kế toán trưởng, Kế toán viên (vẫn chỉ duyệt được bước gán cho mình) |
| Xem mọi đề nghị (tab Tất cả) | Mọi vai trò mặc định, kể cả Chỉ xem |
| Cấu hình quy trình | Quyền Sửa tùy chọn hệ thống (Quản trị, Kế toán trưởng) |

Cờ xem số liệu nhạy cảm vẫn áp dụng: đề nghị có TK Nợ là công nợ phải trả (331) chỉ người có quyền xem công nợ phải trả mới thấy và duyệt được (người đề nghị luôn thấy đề nghị của mình).

## Trên điện thoại

Trang Phê duyệt dùng được trên màn hình hẹp: menu trái tự thu gọn, danh sách hiện dạng thẻ (người nhận, số tiền, trạng thái), chi tiết mở toàn màn hình với nút Duyệt / Từ chối lớn.

Ứng dụng di động riêng (của bên thứ ba) gọi API `/api/mobile/v1` bằng **khóa API phạm vi "Ứng dụng di động"** (menu Hệ thống → Khóa API) hoặc phiên đăng nhập. Khóa chỉ cho xem báo cáo tóm tắt (B01, B02, số dư tiền, doanh thu chi phí kỳ) và duyệt/từ chối đề nghị, theo quyền hiện hành của người tạo khóa; không lập chứng từ, không vào chức năng quản trị. Mất điện thoại: thu hồi khóa ngay ở trang Khóa API. Tài liệu kỹ thuật: `docs/dev/api-mobile.md`.

Chưa có: gửi thông báo qua email hoặc thông báo đẩy; duyệt hàng loạt trên điện thoại (chỉ duyệt từng đề nghị); từ chối hàng loạt trên màn hình; đề nghị thanh toán gắn hóa đơn mua hoặc đối trừ công nợ tự động (kế toán chọn đối trừ trên phiếu chi nháp).
