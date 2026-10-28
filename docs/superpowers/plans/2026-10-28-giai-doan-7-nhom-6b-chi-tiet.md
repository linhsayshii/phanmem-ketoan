# GĐ7 nhóm 6b — Hộ kinh doanh (TT 152/2025) và doanh nghiệp siêu nhỏ (TT 58/2026) từ văn bản gốc: kế hoạch chi tiết

Migration 0251–0259 (dùng 0251), quyết định 1500–1599 (`2026-10-28-giai-doan-7-quyet-dinh-hkd-sieu-nho.md`). Thay cho "Khi có văn bản gốc" của kế hoạch nhóm 6 (`...-nhom-6-chi-tiet.md`). Văn bản gốc: `~/Documents/PetProject/legal-docs-gd7/tt58-2026`, `tt152-2025`.

## Kết quả đọc văn bản (tóm tắt ở `research_notes/Nghiệp vụ phần mềm kế toán/tt152-2025-tt58-2026-van-ban-goc.md`)

Cả hai thông tư không có hệ thống tài khoản, không có tỷ lệ thuế hay ngưỡng; ghi sổ theo phương pháp nộp thuế. TT152: 7 sổ, không có báo cáo tài chính. TT58: sổ S1, S2a–d, S3a–b, S4a–d, B01 và B02-DNSN.

## Tác vụ

1. Dữ liệu: `packages/coa-data/data/books/tt152.json`, `tt58.json` (sổ, cột, điều, phương pháp nộp thuế → danh mục sổ, chỉ tiêu B01/B02); `data/regimes/status.json` (`applicable`, `gates` trung thực, `limits`); `src/regimes.ts` (`isRegimeReady` bỏ qua phần thông tư không có, `regimeReportsReady`, `loadBookSet`); kiểm thử `regimeStatus.test.ts` (số cột từng mẫu).
2. Mô hình: không dùng sổ cái bút toán kép. Migration `0251_so_hkd.sql`: `book_group` (nhóm ngành nghề, tỷ lệ % do người dùng khai), `book_year_setting` (phương pháp nộp thuế, thuế suất trên thu nhập), `book_entry` (một bảng giao dịch ghi sổ đơn), `book_stock_item`, `book_stock_move`, `book_other_tax`; quyền `sohkd.*`; RLS, audit.
3. API `modules/hkdbooks`: nhóm, bút ghi, kho, thuế khác, cài đặt năm; `GET /api/hkd/books/:code` (json, html, pdf, xlsx) dùng khung `ReportDoc` và `respondReport`; `GET /api/hkd/books` danh mục sổ theo phương pháp. Tính thuế theo nhóm (doanh thu x tỷ lệ, làm tròn nửa lên), thuế trên thu nhập, đơn giá bình quân kỳ của sổ vật tư, S3b, S3a/S4c, B02-DNSN. Kiểm thử số liệu tính tay.
4. `createFiscalYear`: chế độ sổ (TT58, TT152) chỉ tạo kỳ, không sinh tài khoản, sơ đồ kết chuyển, báo cáo; chặn bằng `isRegimeReady`.
5. Giao diện: `Regimes.tsx` (tình trạng thật, giới hạn), `RegimeNotice` (cảnh báo giới hạn thay vì "chưa có văn bản"), trang mới `HkdBooks.tsx` (`/so-hkd`: Sổ và báo cáo, Ghi sổ, Nhóm ngành nghề, Kho, Thuế khác, Cài đặt năm); Playwright `e2e/hkd-sieu-nho.spec.ts`.
6. Tài liệu `docs/user/giai-doan-7-hkd-sieu-nho.md`, mục "GĐ7 nhóm 6 — Chờ người dùng" của `docs/TIEP-THEO.md`.

## Self-review

Không nhập tỷ lệ thuế, ngưỡng hay chỉ tiêu 01/CNKD (không có văn bản). Mọi cổng `true` có đối chiếu từng chữ; B01-DNSN, S4a, S4b, S4d nhập định nghĩa nhưng `built=false` có lý do.
