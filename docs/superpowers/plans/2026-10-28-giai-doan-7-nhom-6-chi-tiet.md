# GĐ7 nhóm 6 — Hộ kinh doanh TT 152/2025, siêu nhỏ TT 58/2026: kế hoạch chi tiết

Migration 0250–0259 (dùng 0250), quyết định 1250–1299 (ghi ở `2026-10-28-giai-doan-7-nhom-6-quyet-dinh.md`, chuyển vào mục "Nhóm 6" của sổ quyết định GĐ7 khi hợp nhất).

Kết quả bước 1: không tải được văn bản gốc (thuvienphapluat.vn, luatvietnam.vn trả 403; không có bản Công báo qua tìm kiếm). Chỉ có bài thứ cấp (MISA AMIS cho TT 58, Nhanh.vn cho TT 152) nêu tên sổ và báo cáo, không có cột, chỉ tiêu hay danh mục tài khoản. Theo quy tắc "không bịa", thực hiện nhánh dựng khung (bước 2').

## Tác vụ

1. Cổng dữ liệu: `packages/coa-data/data/regimes/status.json` (TT58, TT152: `gates` đều false, `missing`, `sources`, danh mục sổ thứ cấp), `src/regimes.ts` (`regimeStatus`, `isRegimeReady`), kiểm thử `test/regimeStatus.test.ts` (mọi cổng false khi chưa có văn bản gốc; không có mẫu tài khoản).
2. Chế độ mới: `Regime` thêm `TT152` (`packages/domain`), enum `fiscalYearBody` và `regimeEnum` báo cáo; migration `0250_che_do_hkd.sql` thêm `'TT152'` vào mọi CHECK `regime` có `'TT58'`.
3. API: `GET /api/regimes` (`modules/core/regimes.ts`), kiểm thử `apps/api/test/regimes.test.ts` (TT58/TT152 `ready=false`; tạo năm tài chính TT152 trả 409 `COA_TEMPLATE_PENDING`, không để lại kỳ).
4. Giao diện: trang `/he-thong/che-do-ke-toan` (`pages/Regimes.tsx`), cảnh báo "Chưa có văn bản gốc, chưa dùng cho kế toán thật" khi chọn chế độ ở màn Tạo công ty; E2E `e2e/hkd-sieu-nho.spec.ts`.
5. Tài liệu `docs/user/giai-doan-7-hkd-sieu-nho.md`; mục "GĐ7 nhóm 6 — Chờ người dùng" ở cuối `docs/TIEP-THEO.md`.

## Khi có văn bản gốc (việc tiếp theo)

Nhập sổ S1a–S3a-HKD, S1–S4d-DNSN, B01/B02-DNSN, 01/CNKD thành dữ liệu có cấu trúc theo khuôn `data/reports`, đặt `gates.*=true` từng phần đã đối chiếu, dựng báo cáo in trên dữ liệu ghi sổ kèm kiểm thử số liệu tính tay. Cần quyết định mô hình (sổ theo nhóm thuế, không tài khoản) trước khi dựng.

## Self-review

Không có số liệu, tài khoản, ngưỡng hay công thức pháp lý nào được nhập; danh mục sổ thứ cấp chỉ hiển thị và gắn nhãn chưa đối chiếu.
