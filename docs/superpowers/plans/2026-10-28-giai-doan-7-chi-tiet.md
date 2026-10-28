# Kế hoạch thực hiện chi tiết: GĐ7 (Mở rộng, phần không phụ thuộc GĐ6)

> Chạy song song với GĐ6 (lương, giá thành, hợp đồng; nhánh `claude/magical-ritchie-ijawwy`). Nhánh này: `claude/gd7-mo-rong`, tách từ `main` (tag `gd5-hoan-tat`). Không push `main`, không force-push.

**Goal:** Sáu nhóm mở rộng không đụng lương/giá thành/hợp đồng/kho/giá vốn: (1) hình thức sổ Chứng từ ghi sổ, Nhật ký – Sổ cái, Nhật ký – Chứng từ; (2) báo cáo song ngữ Việt–Anh; (3) ngân sách/dự toán, cảnh báo vượt ngân sách, dashboard phân tích; (4) quy trình phê duyệt và API mobile; (5) đa chi nhánh, BCTC tổng hợp; (6) hộ kinh doanh TT 152/2025 và siêu nhỏ TT 58/2026 (chỉ khi có văn bản gốc).

**Architecture:** Modular monolith như cũ. Nhóm 1–2 là lớp trình bày trên sổ cái (không đổi dữ liệu sổ cái). Nhóm 3–5 thêm bảng mới có `tenant_id` + RLS + `audit_enable`; không sửa bảng sổ cái. Mỗi nhóm một thư mục module API riêng và một trang web riêng để hai nhóm hợp nhất ít xung đột.

## Ràng buộc tách khỏi GĐ6

- Migration GĐ7 từ **0200** (GĐ6 dùng 0094–0110+). `packages/db/src/migrate.ts` đọc thư mục, sắp xếp theo tên, áp dụng mọi tệp chưa có trong `schema_migration` → chịu được khoảng trống số và việc hai nhánh hợp nhất theo thứ tự bất kỳ. Dải theo nhóm: nhóm 1 → 0200–0209, nhóm 2 → 0210–0219, nhóm 3 → 0220–0229, nhóm 4 → 0230–0239, nhóm 5 → 0240–0249, nhóm 6 → 0250–0259.
- Sổ quyết định `2026-10-28-giai-doan-7-quyet-dinh.md`, số từ **1000**; dải theo nhóm: 1000–1049, 1050–1099, 1100–1149, 1150–1199, 1200–1249, 1250–1299; chung 1300+.
- Không sửa `ledger/periodClose.ts` (`CLOSE_STEPS`), `costing`, `payroll`, kho/giá vốn. Tệp dùng chung (`app.ts`, `router.tsx`, `permissions.ts`, `packages/db/src/types.ts`) chỉ thêm dòng ở cuối danh sách, ghi vào sổ quyết định.
- Quyền mới thêm vào `permissions.ts` ở khối riêng GĐ7; vai trò mặc định theo quy ước các GĐ trước.

## Quy tắc chung

Mọi quy tắc bất biến trong `CLAUDE.md`. Tiền chuỗi + `D()`; bảng mới `tenant_id`, `rls_enable`, `audit_enable`, khóa ngoại tổng hợp `(tenant_id, id)`; cờ nhạy cảm chặn ở API; báo cáo đọc trong `READ_SNAPSHOT`; `_NOT_FOUND` 404, trạng thái 409, đầu vào 400. Giao diện: skill `evon:ui-ux` chế độ "dựng luôn", dùng `@kt/ui`; mỗi màn hình một spec Playwright. Tài liệu người dùng `docs/user/giai-doan-7-*.md`. Không bịa dữ liệu pháp lý: chỉ nhập từ văn bản gốc, nếu không thì `complete=false` trong `*.status.json` và ghi "Chờ người dùng" ở `docs/TIEP-THEO.md`.

## Nhóm 1 — Hình thức sổ (migration 0200–0209, QĐ 1000–1049)

Lớp trình bày, không đổi dữ liệu sổ cái. Chọn hình thức sổ theo năm tài chính (`fiscal_year.book_form`: `NKC` mặc định, `CTGS`, `NKSC`, `NKCT`; chỉ ảnh hưởng bộ sổ in và màn Sổ sách, không đổi cách ghi sổ).
- Chứng từ ghi sổ (TT 200 mẫu S02a-DN Chứng từ ghi sổ, S02b-DN Sổ đăng ký chứng từ ghi sổ, S02c1/c2 Sổ Cái): Chứng từ ghi sổ = tập hợp chứng từ gốc cùng loại theo kỳ do người dùng lập; đăng ký có số hiệu, ngày. Số liệu lấy từ sổ cái; bảng `ledger_voucher_set` chỉ đánh dấu nhóm chứng từ.
- Nhật ký – Sổ Cái (S06-DN): một sổ, cột phát sinh theo tài khoản.
- Nhật ký – Chứng từ (S07..S10-DN, theo TK có Nợ đối ứng): bảng kê theo bên Có của tài khoản.
Kiểm thử: tổng Nợ = tổng Có từng sổ; khớp Bảng cân đối số phát sinh cùng kỳ; bất biến “đổi hình thức sổ không đổi số dư”.

## Nhóm 2 — Song ngữ (migration 0210–0219, QĐ 1050–1099)

Tên tài khoản/chỉ tiêu báo cáo thêm cột `name_en`; ngôn ngữ in chọn khi in (`lang=vi|en|vi-en`). Dữ liệu tên tiếng Anh tài khoản/chỉ tiêu: dịch thuật, đánh dấu `translation_status` (không phải dữ liệu pháp lý) và cho sửa tay; mẫu hệ thống chỉ nạp phần đã có nguồn.

## Nhóm 3 — Ngân sách và phân tích (migration 0220–0229, QĐ 1100–1149)

Ngân sách theo năm × tài khoản/khoản mục phí/bộ phận/dự án × tháng; so sánh thực tế với ngân sách (báo cáo chênh lệch), cảnh báo vượt ngân sách khi ghi sổ chứng từ (mềm: cảnh báo; cứng: chặn, theo cấu hình), dashboard phân tích tài chính (doanh thu, chi phí, lợi nhuận, tiền, công nợ, hệ số tài chính) với biểu đồ.

## Nhóm 4 — Phê duyệt và mobile (migration 0230–0239, QĐ 1150–1199)

Đề nghị thanh toán / đề nghị tạm ứng là chứng từ đề nghị (không phải chứng từ sổ cái) đi qua quy trình phê duyệt nhiều bước theo hạn mức; khi duyệt xong tạo Phiếu chi/Giấy báo nợ nháp qua dịch vụ chứng từ tiền có sẵn. API mobile: xem báo cáo và duyệt chứng từ, xác thực theo khóa API/phiên có phạm vi hẹp.

## Nhóm 5 — Đa chi nhánh (migration 0240–0249, QĐ 1200–1249)

Chi nhánh là chiều của dữ liệu trong cùng công ty (tenant), có phạm vi quyền theo người dùng; BCTC tổng hợp cộng các chi nhánh và loại trừ giao dịch nội bộ. Hợp nhất TT 202/2014 chỉ khi có văn bản gốc.

## Nhóm 6 — Hộ kinh doanh TT 152/2025, siêu nhỏ TT 58/2026 (migration 0250–0259, QĐ 1250–1299)

Tải văn bản gốc trước. Nếu có: nhập sổ S1a/S2a/S2b–S2e/S3a-HKD, 01/CNKD, hệ thống tài khoản và B01/B02-DNSN vào `packages/coa-data` với `complete=true` chỉ khi đủ. Nếu không: dựng khung, `complete=false`, ghi “Chờ người dùng”.

## Kết thúc giai đoạn

Rà soát nhánh, một đợt sửa, `pnpm lint && pnpm typecheck && pnpm test` và bất biến xanh, tài liệu `docs/user/giai-doan-7-*.md`, cập nhật `docs/TIEP-THEO.md` (mục GĐ7: nhóm đã làm/chưa làm). Tag `gd7-hoan-tat` chỉ khi đủ phạm vi; trợ lý AI để sau cùng.
