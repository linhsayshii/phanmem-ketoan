# Việc tiếp theo

Cập nhật: 2026-10-21, sau khi xong GĐ1.5 (tag `gd0-hoan-tat`, `gd1-hoan-tat`, `gd1-5-hoan-tat`). Việc đang làm: GĐ2 theo `docs/superpowers/plans/2026-10-21-giai-doan-2-chi-tiet.md`. Agent cập nhật file này cuối mỗi giai đoạn và mỗi khi có việc chờ người dùng.

Thứ tự làm: mục 2 (phần còn lại) song song mục 3 (GĐ2 → GĐ7). Mục 4 là việc chờ người dùng, không chặn các mục khác.

## 1. GĐ1.5 (tồn đọng GĐ0–1): xong 2026-10-21, tag `gd1-5-hoan-tat`

Kế hoạch `docs/superpowers/plans/2026-10-20-giai-doan-1-5-chi-tiet.md`, sổ quyết định `2026-10-20-giai-doan-1-5-quyet-dinh.md` (gồm mục "Để lại"). Nhóm A (A1–A12) xong: DB kiểm thử tạm mỗi lần chạy, typecheck cả kiểm thử, `TRUST_PROXY` và cấu hình production, khóa đăng nhập sai theo tên/IP, băm mã phiên, chặn tự nâng quyền, RLS `tenant_user`, thu hẹp `ketoan_vien`, `*_NOT_FOUND` = 404, khóa ngoại tổng hợp `(tenant_id, id)`, kiểm cân bằng theo câu lệnh (khóa ghi trực tiếp partition), script đo 100.000 dòng (BCĐPS năm 175 ms). Migration 0016–0023.

**Nhóm B** đã gộp vào kế hoạch GĐ2 (`2026-10-21-giai-doan-2-chi-tiet.md`, bảng "Đối chiếu nhóm B").

**Nhóm C, để sau**: chuyển số dư khi đổi chế độ (đặc tả 7.2), xuất XML cơ quan thẩm quyền (mục 13), bất biến 7 đầy đủ; mời người dùng đã có vào công ty khác; phạm vi khóa tạo partition; việc chuẩn bị production (Docker, sao lưu, seed); giới hạn số đăng nhập đồng thời dưới kích thước pool kết nối (lũ đăng nhập từ nhiều IP chiếm pool khoảng 0,5 giây); `role.update` gỡ được quyền của vai trò cao hơn (từ chối dịch vụ). Nhóm D (không làm) có lý do trong `2026-10-20-gd1-5-de-xuat.md`.

## 2. Dữ liệu pháp lý (cổng `*.status.json` trong `packages/coa-data`)

Văn bản gốc tải về `~/legal-docs/` trên VPS (ngoài repo): TT 99/2025 và TT 133/2016 từ Công báo (có chữ), TT 91/2026 (Công báo, có chữ), TT 89/2026 (datafiles.chinhphu.vn, bản scan 839 trang, cần OCR).

- [x] Hệ thống tài khoản TT 99/2025 (Phụ lục II, 184 tài khoản), `complete=true`, nguồn ghi trong `tt99.status.json` (2026-10-20).
- [x] Đối chiếu hệ thống tài khoản TT133 với Phụ lục 1 TT 133/2016: bỏ 521, sửa 18 tên (2026-10-20).
- [x] Sơ đồ kết chuyển theo chế độ (`closing-steps/tt200|tt133|tt99.json`); tạo năm tài chính đổi chế độ thì nạp lại sơ đồ.
- [x] Chỉ tiêu B01-DN, B02-DN, B03-DN (Phụ lục IV TT 99/2025) và B01a-DNN, B02-DNN, B03-DNN (Phụ lục 2 TT 133/2016), cả sáu cờ `true` (2026-10-20). Các chỗ gần đúng (dòng dài hạn TT99 bằng 0 vì sổ cái chưa có kỳ hạn còn lại; B03 tiền tệ phân loại theo cặp đối ứng; lãi trên cổ phiếu nhập tay) ghi trong `note` của `data/reports/status.json`.
- [ ] Kế toán trưởng rà soát một lượt việc gán tài khoản cho từng chỉ tiêu TT99 (xem mục 4).
- [ ] GĐ2/GĐ3: thêm thuộc tính kỳ hạn (ngắn/dài hạn) cho công nợ, tiền gửi, vay để tách dòng dài hạn B01 TT99; B03 phân loại dòng tiền theo mã luồng tiền trên chứng từ thay vì chỉ theo cặp tài khoản.
- [ ] Hệ thống tài khoản TT200 vẫn lấy từ SUNSOFT, chưa đối chiếu Phụ lục 1 TT 200/2014 (TT200 đã bị TT99 thay từ 2026; ưu tiên thấp).
- [ ] Mẫu tờ khai 01/GTGT theo TT 89/2026 (Phụ lục I): đã OCR trang 241–243 (`~/legal-docs/tt89-2026/ocr/SUMMARY.md`, ảnh 300 dpi kèm theo); đối chiếu bằng mắt và nhập dữ liệu mẫu ở GĐ2 Task 21.
- [ ] Ký hiệu hóa đơn theo TT 91/2026 (Phụ lục I, đã có chữ): dùng cho GĐ5.

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
| Kế toán trưởng rà soát chỉ tiêu B01/B02/B03 TT99 và TT133 (`packages/coa-data/data/reports/*/B0*.csv`, ghi chú gần đúng trong `status.json`) | Gán tài khoản cho chỉ tiêu cần phán đoán nghề nghiệp | Số trên BCTC có thể lệch ở các dòng gần đúng |
| Kiểm tay gõ Telex/VNI trong lưới nhập liệu (Chrome và Safari trên máy thật) | Bộ gõ tiếng Việt không giả lập được trong Playwright headless | Có thể lỗi mất dấu khi nhập diễn giải |
| Văn bản gốc QĐ 1450/QĐ-TCT (07/10/2021) và QĐ 1510/QĐ-TCT (định dạng XML hóa đơn điện tử), hoặc quyết định mới thay thế nếu đã có: gdt.gov.vn không truy cập được từ VPS (timeout), vbpl.vn chặn bằng JavaScript, thuvienphapluat 403. Cần tải bằng trình duyệt ở Việt Nam, chép vào `~/legal-docs/qd1450/` | Trang luật chặn tải tự động | XML hóa đơn GĐ5 chỉ theo tài liệu thứ cấp, chưa kiểm chứng |
| Bộ XML mẫu kết xuất từ HTKK 5.x (01/GTGT, 03/TNDN, 05/KK-TNCN, BCTC) | HTKK chạy trên Windows, không có XSD công khai | XML tờ khai GĐ2 chưa kiểm chứng được |
| Tài khoản thử Viettel SInvoice; SePay hoặc Casso; chứng thư số thử (USB token hoặc VNPT SmartCA) | Đăng ký tài khoản và ký hợp đồng là việc của người dùng | GĐ5 chỉ có adapter giả lập |
| Remote GitHub (nếu muốn CI chạy) | Tạo repo và quyền push là quyết định của người dùng | CI trong `.github/workflows` chưa chạy |
| Tên miền và cách triển khai thật (qua nginx proxy manager sẵn có hay không) | Đụng dịch vụ đang chạy trên VPS | Chỉ chạy được nội bộ qua SSH tunnel |

## 5. Ghi chú môi trường

- VPS oracle: repo ở `~/phanmem-ketoan`, remote `origin` = `~/git/phanmem-ketoan.git` (bare). Trên máy Mac của người dùng, remote `oracle` trỏ tới repo bare đó: `git pull oracle main` để lấy về.
- Xem ứng dụng từ máy Mac: `ssh -L 5173:127.0.0.1:5173 -L 3000:127.0.0.1:3000 oracle` rồi mở `http://localhost:5173`.
- Playwright trên VPS oracle (aarch64, cài 2026-10-20): `playwright install --with-deps` lỗi vì kho apt bên thứ ba `packagecloud.io/ookla/speedtest-cli` trả 404 làm `apt-get update` thất bại (không sửa vì là cấu hình hệ thống ngoài dự án). Cách cài: `pnpm -F @kt/api exec playwright install-deps --dry-run chromium` lấy danh sách gói, `sudo apt-get install -y --no-install-recommends <các gói>` (đã cài: phông `fonts-*`, `libgbm1`, mesa, `xvfb`, `xauth`…; thêm `unzip` cho `exportAuthority.test.ts`), rồi `pnpm -F @kt/api exec playwright install chromium` và tương tự cho `@kt/web` (trình duyệt ở `~/.cache/ms-playwright`).
- Gói hệ thống đã cài thêm cho dự án (2026-10-20): `unzip`, `postgresql-client-16` (`pg_dump` cho kiểm thử sao lưu), `poppler-utils` (`pdftotext` cho văn bản pháp lý), `tesseract-ocr` + `tesseract-ocr-vie` (OCR bản scan TT 89/2026, 2026-10-20). Khi `apt-get update` lỗi vì kho ookla: `sudo apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources -o Dir::Etc::sourceparts=-`.
- Kiểm thử trên VPS chạy với cơ sở dữ liệu tạm `ketoan_test` theo `docs/dev/kiem-thu.md` (Docker cần `sudo`: `sudo docker compose exec -T postgres createdb -U postgres ketoan_test`).
