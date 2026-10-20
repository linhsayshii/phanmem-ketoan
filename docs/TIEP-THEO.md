# Việc tiếp theo

Cập nhật: 2026-10-20, sau khi xong GĐ0–1 (tag `gd0-hoan-tat`, `gd1-hoan-tat`, `main` tại thời điểm bàn giao lên VPS oracle). Agent cập nhật file này cuối mỗi giai đoạn và mỗi khi có việc chờ người dùng.

Thứ tự làm: mục 1 → 2 → 3 (GĐ2 → GĐ7). Mục 4 là việc chờ người dùng, không chặn các mục khác.

## 1. Tồn đọng của GĐ0–1: kế hoạch nhỏ "GĐ1.5" (làm trước GĐ2)

Phân loại đầy đủ (nhóm A–D, lý do, mục đã kiểm trên mã): `docs/superpowers/plans/2026-10-20-gd1-5-de-xuat.md`. Nguồn: `2026-10-20-gd1-viec-hoan-lai.md` và phần "Final" của `2026-10-19-giai-doan-0-1-quyet-dinh.md`.

Đã xong (lệnh 01, 2026-10-20): checksum migration chuẩn hóa CRLF/BOM + `.gitattributes`; chữ báo cắt Nhật ký chung chỉ hướng sang Excel; `testTimeout` web 30 giây.

**Nhóm A, làm trước GĐ2** (viết kế hoạch `GĐ1.5` theo khuôn GĐ0–1 rồi thực hiện; thứ tự gợi ý A1 → A2 trước để các mục sau có kiểm thử sạch):

- [ ] A1 (vừa) Cơ sở dữ liệu kiểm thử riêng tự tạo/xóa; cô lập `packages/db/test/reference.test.ts`; bật lại chạy song song file kiểm thử nếu ổn định.
- [ ] A2 (vừa) Typecheck kiểm thử mọi gói, sửa lỗi kiểu phát sinh.
- [ ] A3 (vừa) Đăng nhập: giới hạn tần suất và khóa tạm sau nhiều lần sai.
- [ ] A4 (nhỏ) `trustProxy` chỉ khi cấu hình; production bắt buộc `COOKIE_SECURE=true`, `SESSION_SECRET` ≥ 32 ký tự.
- [ ] A5 (vừa) Chặn tự nâng quyền: không tự sửa vai trò/cờ nhạy cảm của mình, không gán cờ mình không có, giữ ít nhất một quản trị viên, vai trò hệ thống không bị tước quyền.
- [ ] A6 (nhỏ) RLS `tenant_user`: tách chính sách SELECT và ghi; `create_tenant` trả lại `app.current_tenant`.
- [ ] A7 (vừa) Lưu băm mã phiên; dọn phiên hết hạn.
- [ ] A8 (nhỏ) Thu hẹp vai trò mặc định `ketoan_vien`.
- [ ] A9 (nhỏ) Quy ước lỗi `*_NOT_FOUND` (404/409) thống nhất toàn API.
- [ ] A10 (vừa) Khóa ngoại tổng hợp `(tenant_id, id)` cho các bảng sau 0001 và quy ước cho bảng mới.
- [ ] A11 (lớn) Trigger cân bằng/số dư cấp câu lệnh, bỏ hoặc nâng giới hạn 5.000 dòng/chứng từ.
- [ ] A12 (vừa) Đo lại hiệu năng 100.000 dòng (BCĐPS năm < 2 giây); thêm chỉ mục/phân trang nếu chưa đạt.

**Nhóm B, làm cùng GĐ2** (đưa vào kế hoạch GĐ2): màn hình chứng từ dùng chung thay `PKT` viết cứng và "Đảo" chọn ngày; nhập Excel; danh mục dùng chung; lưới nhập liệu và F4; múi giờ Việt Nam cho bộ lọc ngày; cờ nhạy cảm cho dữ liệu GĐ2; siết cân bằng đa tiền tệ. Chi tiết trong đề xuất.

**Nhóm C, để sau**: chuyển số dư khi đổi chế độ (đặc tả 7.2, sau khi có TT99), xuất XML cơ quan thẩm quyền (mục 13), bất biến 7 đầy đủ; mời người dùng đã có vào công ty khác; phạm vi khóa tạo partition; việc chuẩn bị production (Docker, sao lưu, seed). Nhóm D (không làm) có lý do trong đề xuất.

## 2. Dữ liệu pháp lý còn thiếu (cổng `*.status.json` trong `packages/coa-data`)

- [ ] Hệ thống tài khoản TT 99/2025 (Phụ lục II) và chỉ tiêu B01-DN, B02-DN, B03-DN (Phụ lục IV): hiện `complete=false`, mặc định công ty mới dùng TT133. Thử lấy văn bản gốc từ nguồn chính thức (vbpl.vn, congbao.chinhphu.vn, mof.gov.vn, datafiles chinhphu.vn; PDF đọc bằng `pdftotext` của `poppler-utils`). Nhập theo hướng dẫn trong `tt99.status.json`, chạy kiểm thử đối chiếu, đặt `complete=true` và ghi `source`. Không lấy được thì chuyển sang mục 4.
- [ ] Chỉ tiêu B01a-DNN, B02-DNN, B03-DNN theo TT 133/2016 (Phụ lục 2): cùng cách.
- [ ] Hai hệ thống tài khoản TT133 và TT200 hiện lấy từ SUNSOFT, ghi "chưa đối chiếu Phụ lục 1": đối chiếu với văn bản gốc, bổ sung tài khoản ngoài bảng nếu thiếu.
- [ ] Mẫu tờ khai theo TT 89/2026 (Phụ lục I) và ký hiệu hóa đơn theo TT 91/2026 (Phụ lục I): cần cho GĐ2 và GĐ5.

## 3. Các giai đoạn tiếp theo

Chi tiết công việc và tiêu chí nghiệm thu: `docs/superpowers/plans/2026-10-19-lo-trinh-thuc-hien.md`. Danh sách nghiệp vụ và mức ưu tiên: đặc tả mục 9. Tham số pháp lý: đặc tả mục 10.

- [ ] **GĐ2 — Tiền, công nợ, thuế GTGT** (5–6 tuần): Phiếu thu/chi, Giấy báo nợ/có, UNC, chuyển tiền nội bộ, tạm ứng; sổ quỹ, sổ tiền gửi, tỷ giá xuất quỹ; `open_item`/`settlement`, đối trừ, bù trừ, chênh lệch tỷ giá, đánh giá lại ngoại tệ, tuổi nợ, biên bản đối chiếu; hóa đơn mua/bán dịch vụ và `voucher_invoice`; động cơ thuế `tax`/`tax_distribution`; bảng kê và tờ khai 01/GTGT, XML HTKK (TT 80/2021 cho kỳ trước 01/07/2026, TT 89/2026 sau đó); nhập chứng từ Excel; khử trùng chứng từ.
- [ ] **GĐ3 — Kho và mua bán hàng hóa** (6–8 tuần): VTHH đầy đủ, kho, số dư tồn đầu kỳ (mở khóa tài khoản 15x), `stock_move`/`stock_cost_layer`/`stock_cost_assignment`/`costing_run`, chứng từ nhập/xuất/chuyển/lắp ráp/kiểm kê, mua/bán hàng hóa, giá vốn 4 phương pháp, báo cáo kho và bán hàng.
- [ ] **GĐ4 — Tài sản và khế ước** (4 tuần): TSCĐ, CCDC, chi phí trả trước, khế ước vay, chứng từ tự động, quy trình cuối kỳ có thứ tự.
- [ ] **GĐ5 — Hóa đơn điện tử và tích hợp** (5–6 tuần): `EInvoiceProvider` + adapter Viettel SInvoice, vòng đời hóa đơn theo NĐ 254/2026 + TT 91/2026, ký số (USB token qua tiện ích cục bộ, ký từ xa), hóa đơn đầu vào XML theo QĐ 1450/QĐ-TCT, ngân hàng (webhook SePay/Casso, sao kê, VietQR), tờ khai TNDN/TNCN, API cho phần mềm bán hàng.
- [ ] **GĐ6 — Lương, giá thành, hợp đồng** (5–6 tuần).
- [ ] **GĐ7 — Mở rộng**: hộ kinh doanh TT 152/2025, siêu nhỏ TT 58/2026, hình thức sổ khác, đa chi nhánh/hợp nhất, ngân sách, song ngữ, mobile, trợ lý AI.

## 4. Chờ người dùng

| Việc | Vì sao cần người dùng | Ảnh hưởng nếu chưa có |
|---|---|---|
| Kiểm tay gõ Telex/VNI trong lưới nhập liệu (Chrome và Safari trên máy thật) | Bộ gõ tiếng Việt không giả lập được trong Playwright headless | Có thể lỗi mất dấu khi nhập diễn giải |
| Văn bản gốc TT 99/2025 (Phụ lục II, IV), TT 89/2026 Phụ lục I, TT 91/2026, QĐ 1450/QĐ-TCT + 1510 (phụ lục XML) nếu agent không tải được | Trang luật chặn tải tự động | Công ty mới phải dùng TT133; tờ khai/HĐĐT chưa đúng mẫu mới |
| Bộ XML mẫu kết xuất từ HTKK 5.x (01/GTGT, 03/TNDN, 05/KK-TNCN, BCTC) | HTKK chạy trên Windows, không có XSD công khai | XML tờ khai GĐ2 chưa kiểm chứng được |
| Tài khoản thử Viettel SInvoice; SePay hoặc Casso; chứng thư số thử (USB token hoặc VNPT SmartCA) | Đăng ký tài khoản và ký hợp đồng là việc của người dùng | GĐ5 chỉ có adapter giả lập |
| Remote GitHub (nếu muốn CI chạy) | Tạo repo và quyền push là quyết định của người dùng | CI trong `.github/workflows` chưa chạy |
| Tên miền và cách triển khai thật (qua nginx proxy manager sẵn có hay không) | Đụng dịch vụ đang chạy trên VPS | Chỉ chạy được nội bộ qua SSH tunnel |

## 5. Ghi chú môi trường

- VPS oracle: repo ở `~/phanmem-ketoan`, remote `origin` = `~/git/phanmem-ketoan.git` (bare). Trên máy Mac của người dùng, remote `oracle` trỏ tới repo bare đó: `git pull oracle main` để lấy về.
- Xem ứng dụng từ máy Mac: `ssh -L 5173:127.0.0.1:5173 -L 3000:127.0.0.1:3000 oracle` rồi mở `http://localhost:5173`.
- Playwright trên VPS oracle (aarch64, cài 2026-10-20): `playwright install --with-deps` lỗi vì kho apt bên thứ ba `packagecloud.io/ookla/speedtest-cli` trả 404 làm `apt-get update` thất bại (không sửa vì là cấu hình hệ thống ngoài dự án). Cách cài: `pnpm -F @kt/api exec playwright install-deps --dry-run chromium` lấy danh sách gói, `sudo apt-get install -y --no-install-recommends <các gói>` (đã cài: phông `fonts-*`, `libgbm1`, mesa, `xvfb`, `xauth`…; thêm `unzip` cho `exportAuthority.test.ts`), rồi `pnpm -F @kt/api exec playwright install chromium` và tương tự cho `@kt/web` (trình duyệt ở `~/.cache/ms-playwright`).
- Gói hệ thống đã cài thêm cho dự án (2026-10-20): `unzip`, `postgresql-client-16` (`pg_dump` cho kiểm thử sao lưu), `poppler-utils` (`pdftotext` cho văn bản pháp lý). Khi `apt-get update` lỗi vì kho ookla: `sudo apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources -o Dir::Etc::sourceparts=-`.
- Kiểm thử trên VPS chạy với cơ sở dữ liệu tạm `ketoan_test` theo `docs/dev/kiem-thu.md` (Docker cần `sudo`: `sudo docker compose exec -T postgres createdb -U postgres ketoan_test`).
