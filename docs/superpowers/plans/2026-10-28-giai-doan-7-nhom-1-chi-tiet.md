# GĐ7 – Nhóm 1: Hình thức sổ (kế hoạch ngắn)

Migration 0200 (dải 0200–0209), quyết định 1000–1010. Lớp trình bày: không sửa dòng sổ cái.

1. Migration `0200_hinh_thuc_so.sql`: `fiscal_year_setting` (book_form), `ledger_voucher_set`, `ledger_voucher_set_item`, RLS + audit, quyền `voucher_set.*` (cuối `permissions.ts`), kiểu bảng cuối `types.ts`.
2. `reporting/bookForms.ts`: đặt/đọc hình thức; Nhật ký – Sổ Cái; Nhật ký – Chứng từ; lập/xóa/đăng ký/chi tiết Chứng từ ghi sổ; Sổ Cái CTGS. Kiểm thử trước trong `test/bookForms.test.ts` (tổng Nợ = Có, khớp Bảng cân đối số phát sinh, đổi hình thức không đổi dữ liệu, 403 thiếu cờ).
3. `print/bookFormDocs.ts` + `bookSet.ts`: tài liệu in (HTML/PDF/Excel qua `respondReport`), bộ sổ năm theo hình thức; `forms.ts` số mẫu S02a/b/c1 (TT99, TT200).
4. `bookFormRoutes.ts` đăng ký cuối `app.ts`, đọc `READ_SNAPSHOT`, `assertAllSensitive`.
5. Web: trang `BookForms.tsx` (`/bao-cao/hinh-thuc-so`), menu và route thêm cuối; `e2e/hinh-thuc-so.spec.ts`.
6. Tài liệu `docs/user/giai-doan-7-hinh-thuc-so.md`, quyết định, lint/typecheck/kiểm thử liên quan.
