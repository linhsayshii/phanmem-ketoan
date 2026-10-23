# Sổ quyết định GĐ5 (2026-10-24 → …)

Kế hoạch: `2026-10-24-giai-doan-5-chi-tiet.md`. Đánh số tiếp GĐ4 (kết thúc ở #514). Mỗi dòng: quyết định — lý do — giá phải trả nếu sai. Cuối mỗi dòng: tác vụ và mã commit.

## Cách làm

515. Làm trên nhánh worktree `worktree-gd5`, sau mỗi tác vụ push `HEAD:main` dạng fast-forward (như #383) — CLAUDE.md yêu cầu nhánh `main` — không. (chung)
516. Subagent dùng model thấp nhất làm được: Sonnet thực hiện và rà soát tác vụ thường; Haiku cho sửa theo chỉ dẫn file:dòng, chạy kiểm thử dài, kiểm bản sao sạch; Opus cho phát hành hai pha (T5), điều chỉnh/thay thế (T6), dữ liệu pháp lý TNDN (T17), rà soát bảo mật (T10, T11, T13, T16) và rà soát toàn nhánh — người dùng yêu cầu "subagent dùng model tier thấp hơn, chỉ dùng opus khi cần" — tác vụ khó do Sonnet làm có thể cần thêm vòng sửa. (chung)

## Thiết kế

517. Thêm phụ thuộc `@xmldom/xmldom`, `xml-crypto` (API) và `qrcode` (web) — đọc XML hóa đơn của nhà cung cấp khác và kiểm chữ ký XML-DSig cần C14N đúng chuẩn, tự viết dễ sai; vẽ QR tự viết không đáng — thêm bề mặt phụ thuộc; chọn gói MIT phổ biến, khóa phiên bản. (kế hoạch)
518. 05/KK-TNCN, quyết toán TNCN và chi lương theo lô chuyển GĐ6 — nguồn số của các tờ khai/tệp này là bảng lương (GĐ6); làm trước sẽ chỉ có ô nhập tay rồi phải làm lại — lộ trình GĐ5 chưa đủ mục, GĐ6 nặng thêm. (kế hoạch)
519. Hóa đơn điện tử là lớp trên chứng từ bán đã ghi sổ; số do nhà cung cấp cấp được ghi ngược vào `voucher_invoice` qua hàm hẹp `fn_einvoice_set_number`; chứng từ đã phát hành bị khóa ở mức trigger — một luồng ghi sổ, bảng kê/tờ khai đọc đúng nguồn cũ — người dùng phải ghi sổ trước khi phát hành. (kế hoạch)
520. Gọi nhà cung cấp ngoài giao dịch, hai pha, `transaction_uuid` giữ qua các lần thử, thử lại luôn tra theo mã giao dịch trước — mạng đứt sau khi nhà cung cấp cấp số không sinh hóa đơn thứ hai (khuyến nghị của mã Odoo, `docs/dev/tich-hop/sinvoice.md`) — hóa đơn có thể nằm `sending` đến khi worker đối soát. (kế hoạch)
521. Điều chỉnh thông tin (không đổi tiền) không có chứng từ tiền đi kèm: GĐ5 xử lý bằng thay thế hoặc 04/SS — mô hình "một chứng từ một hóa đơn" không chứa hóa đơn không tiền — người dùng không lập được hóa đơn điều chỉnh thông tin qua phần mềm. (kế hoạch)
522. Adapter SInvoice không khai `sendErrorNotice` và ký bằng USB token qua hash — không có trong nguồn công khai — 04/SS phải in và gửi qua cổng nhà cung cấp/CQT, đánh dấu "đã gửi" tay. (kế hoạch)
523. Tra MST qua `api.vietqr.io` mặc định tắt (`tax_code_lookup = 'off'`) — gửi MST đối tác ra dịch vụ bên thứ ba không có SLA là quyết định của người dùng — người dùng phải bật trên màn Công ty. (kế hoạch)
524. Không kiểm chuỗi tin cậy CA của chữ ký hóa đơn đầu vào, chỉ kiểm toàn vẹn và MST trong chứng thư — chưa có danh sách CA gốc được công nhận trong phạm vi — chữ ký tự cấp vẫn báo "hợp lệ (chưa kiểm CA)". (kế hoạch)
525. Sao kê ngân hàng nhập theo mẫu cột người dùng khai, không có mẫu sẵn theo ngân hàng — không có nguồn chính thức về định dạng (`docs/dev/tich-hop/ngan-hang.md` mục 5) — người dùng phải khai cột lần đầu. (kế hoạch)
526. Bí mật tích hợp mã hóa AES-256-GCM bằng `DATA_ENCRYPTION_KEY` riêng, không dùng `SESSION_SECRET` — xoay khóa phiên không làm mất bí mật; tách vai trò — triển khai thêm một biến môi trường bắt buộc ở production. (kế hoạch)
527. Khóa API chỉ dùng cho `/api/ext/v1`, quyền = vai trò hiện hành của người tạo ∩ phạm vi — khóa lộ không chạm được route quản trị; mất quyền người tạo là mất quyền khóa — tích hợp ngừng chạy khi người tạo nghỉ việc (tạo khóa cho tài khoản dịch vụ riêng). (kế hoạch)
