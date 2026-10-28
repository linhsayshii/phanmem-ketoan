# GĐ7 nhóm 3 — Ngân sách và phân tích: kế hoạch chi tiết

Phạm vi theo `2026-10-28-giai-doan-7-chi-tiet.md` (migration 0220–0229, quyết định 1100–1149). Cổng E2E: API 3030, web 5183, DB `ketoan_gd7_3`.

## Tác vụ (kiểm thử trước, commit nhỏ)

1. **Migration 0220** `budget`, `budget_line` (12 cột tháng `NUMERIC(20,0)`), `budget_setting` (cảnh báo, tắt mặc định); quyền `budget.*`; kiểu Kysely cuối `types.ts`; quyền cuối `permissions.ts`.
2. **Dịch vụ ngân sách** `apps/api/src/modules/budget/`: CRUD ngân sách + dòng (thay toàn bộ dòng một lần), duyệt (draft → approved, bản duyệt cũ cùng năm thành `superseded`), sao chép từ thực tế năm trước × hệ số, nhập/xuất Excel (dùng `readSheet`/`buildSheetTemplate`).
3. **Thực hiện so với ngân sách** `actuals.ts`: thực tế từng dòng × tháng từ sổ cái (bỏ chứng từ kết chuyển), `READ_SNAPSHOT`, cờ nhạy cảm bằng `assertSensitive` theo mọi tài khoản dưới tiền tố; truy ngược tới dòng chứng từ.
4. **Cảnh báo vượt ngân sách** `alert.ts`: `budgetCheck` gọi từ MỘT chỗ (`postWithCashCheck`, cửa ghi sổ chung của chứng từ người dùng); mềm → `warnings[]`, cứng → 409 `BUDGET_EXCEEDED`.
5. **Dashboard phân tích** `analytics.ts`: doanh thu/chi phí/lợi nhuận theo tháng, tiền, phải thu/phải trả cuối tháng, hệ số từ `evaluateFinancialReport` (chỉ khi mã dòng và nhãn khớp), ngân sách so thực tế.
6. **Web**: `/ngan-sach` (lưới bàn phím, báo cáo thực hiện, cấu hình cảnh báo), `/phan-tich` (biểu đồ SVG); Playwright `ngan-sach.spec.ts`, `phan-tich.spec.ts`.
7. **Tài liệu** `docs/user/giai-doan-7-ngan-sach-phan-tich.md`; quyết định 1100+.

## Self-review
Không sửa `periodClose`, `costing`, kho; ghi sổ chỉ thêm một lời gọi; tiền chuỗi + `D()`; mọi bảng `tenant_id` + RLS + audit; khóa ngoại tổng hợp.
