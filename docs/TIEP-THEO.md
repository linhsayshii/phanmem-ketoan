# Việc tiếp theo

Cập nhật: 2026-10-20, sau khi xong GĐ0–1 (tag `gd0-hoan-tat`, `gd1-hoan-tat`, `main` tại thời điểm bàn giao lên VPS oracle). Agent cập nhật file này cuối mỗi giai đoạn và mỗi khi có việc chờ người dùng.

Thứ tự làm: mục 1 → 2 → 3 (GĐ2 → GĐ7). Mục 4 là việc chờ người dùng, không chặn các mục khác.

## 1. Tồn đọng của GĐ0–1 (làm trước GĐ2, gộp thành một kế hoạch nhỏ "GĐ1.5")

Nguồn: phần "Final" của `docs/superpowers/plans/2026-10-19-giai-doan-0-1-quyet-dinh.md` và danh sách việc hoãn theo từng tác vụ `docs/superpowers/plans/2026-10-20-gd1-viec-hoan-lai.md` (sổ theo dõi đầy đủ: `2026-10-20-gd0-gd1-so-theo-doi-sdd.md`).

**Làm đầu tiên** (ba mục đầu dưới đây và phân loại `gd1-viec-hoan-lai.md` thành đề xuất GĐ1.5), rồi mới tới các mục còn lại.

- [ ] **Checksum migration lỗi với CRLF**: chuẩn hóa `text.replace(/\r\n/g, '\n')` trước khi băm trong migrator (`packages/db`) và thêm `.gitattributes` `*.sql text eol=lf`; hash LF đã lưu vẫn hợp lệ; thêm kiểm thử.
- [ ] Bộ kiểm thử dùng cơ sở dữ liệu kiểm thử riêng (tự tạo/xóa) thay vì DB phát triển; cô lập `packages/db/test/reference.test.ts` (ghi `coa_template` toàn cục) để bật lại chạy song song file kiểm thử.
- [ ] Kiểm thử chưa được typecheck (`tsconfig include: ["src"]`): thêm `tsconfig.test.json` hoặc mở rộng include, sửa lỗi kiểu phát sinh.
- [ ] Đăng nhập: giới hạn tần suất và khóa tạm sau nhiều lần sai; `trustProxy` chỉ khi cấu hình; mặc định production: `COOKIE_SECURE=true`, `SESSION_SECRET` tối thiểu 32 ký tự (báo lỗi khi khởi động nếu không đạt).
- [ ] Một tài khoản dùng cho nhiều công ty: luồng mời người dùng đã có vào công ty khác (hiện chỉ CLI `create-admin`).
- [ ] Màn hình Phiếu kế toán: bỏ viết cứng loại `PKT` (dùng chung cho các loại chứng từ sau), "Đảo" cho chọn ngày đảo thay vì luôn là hôm nay.
- [ ] Vai trò mặc định `ketoan_vien` quá rộng (`closing.run`, `closing_step.update`, `report_def.update`, `opening_balance.update`): thu hẹp, để kế toán trưởng giữ.
- [ ] Quy ước lỗi `PERIOD_NOT_FOUND` (404 hay 409) thống nhất toàn API.
- [ ] Trigger cân bằng/số dư theo dòng là O(n²) (đã giới hạn 5.000 dòng/chứng từ): chuyển sang trigger cấp câu lệnh.
- [ ] Phạm vi khóa khi tạo partition `voucher_line` theo kỳ.
- [ ] Khóa ngoại tổng hợp `(tenant_id, id)` cho các bảng sau 0001 (hiện chỉ dựa RLS).
- [ ] Nhỏ: chữ báo cắt Nhật ký chung trong `apps/web/src/pages/Ledgers.tsx` (khoảng dòng 118) và đoạn Nhật ký chung trong `docs/user/giai-doan-1-so-cai.md` bảo "In PDF / Xuất Excel" khi quá 50.000 dòng, nhưng PDF giới hạn 40.000 dòng (`MAX_PRINT_ROWS`): chỉ hướng sang Excel.
- [ ] Nhỏ: `testTimeout` của vitest web đang bằng `asyncUtilTimeout` (5 giây): nâng lên 30 giây.
- [ ] Đo lại hiệu năng 100.000 dòng (BCĐPS năm < 2 giây theo tiêu chí GĐ1); nếu chưa đạt, thêm chỉ mục/phân trang.
- [ ] Khoảng trống đặc tả còn lại: chuyển số dư sang năm sau khi đổi chế độ (mục 7.2), xuất XML cho cơ quan thẩm quyền (mục 13), bất biến 7 đầy đủ khi đã có mẫu B01/B02/B03.

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
