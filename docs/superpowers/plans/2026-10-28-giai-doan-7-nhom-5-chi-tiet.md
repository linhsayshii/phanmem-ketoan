# Kế hoạch chi tiết GĐ7 nhóm 5: Đa chi nhánh, BCTC tổng hợp

> Kế hoạch chung: `2026-10-28-giai-doan-7-chi-tiet.md`. Migration 0240–0249, quyết định 1200–1249 (`2026-10-28-giai-doan-7-quyet-dinh.md`, mục Nhóm 5). Không đụng `periodClose.ts`, giá vốn, lương, kho.

**Goal:** Chi nhánh là chiều của chứng từ trong cùng công ty; người dùng có phạm vi chi nhánh chỉ đọc/ghi chứng từ, sổ sách, BCTC của chi nhánh được phép (chặn ở cơ sở dữ liệu và API); BCTC tổng hợp = cộng BCTC từng chi nhánh trừ phần tài khoản nội bộ. Hợp nhất TT 202/2014 chỉ dựng khung (chưa có văn bản gốc).

**Architecture (ít xâm lấn nhất):**
- Chi nhánh = `department` có `is_branch = true` (đã có từ 0003, `warehouse.branch_id` đã trỏ vào đây); thêm cột `tax_code` (MST đơn vị trực thuộc), `parent_id` có sẵn là đơn vị cấp trên.
- `voucher.branch_id` (NULL = trụ sở chính) đặt ở **tiêu đề chứng từ**, không thêm cột vào `voucher_line` (bảng partition, trigger bất biến, hash): dòng suy ra chi nhánh qua join `voucher`. Thêm cột không giá trị mặc định nên không viết lại dòng cũ, không chạy trigger.
- Mặc định `branch_id` lấy từ biến phiên `app.branch_default` (chi nhánh làm việc của người dùng) → mọi phân hệ lập chứng từ (tiền, hóa đơn, kho...) tự gắn chi nhánh mà không sửa từng dịch vụ. Chứng từ đảo lấy chi nhánh của chứng từ gốc; chứng từ kết chuyển (`is_closing`) về trụ sở chính.
- Phạm vi: `user_branch_scope(tenant_id, user_id, branch_id NULL = trụ sở chính)`; không có dòng = toàn công ty. API đặt `app.branch_scope` trong mọi giao dịch `app.withTenant`; chính sách RLS **RESTRICTIVE** trên `voucher` lọc/kiểm ghi theo biến này.
- Người dùng bị giới hạn chỉ giữ tập quyền làm việc với chứng từ và sổ sách/BCTC (danh sách cho phép, đóng khi có quyền mới); báo cáo ngoài phân hệ reporting (công nợ, quỹ, kho, tài sản, số dư...) đọc bảng không mang chi nhánh nên bị chặn với họ.
- Sổ sách/BCTC: bộ lọc chi nhánh; khi có lọc, dư đầu/cuối tính từ dòng chứng từ (như lọc theo bộ phận) thay vì `account_period_balance`.
- BCTC tổng hợp: đánh giá B01/B02 theo từng chi nhánh trong phạm vi bằng cùng định nghĩa (`evaluateReport`), cộng theo dòng; cột loại trừ = đánh giá báo cáo chỉ trên đơn vị tài khoản nội bộ (mặc định 136, 336 — có trong cả ba hệ tài khoản nguồn văn bản; người dùng khai báo thêm).

## Tác vụ

1. Migration `0240_da_chi_nhanh.sql`: cột, khóa ngoại tổng hợp, chỉ mục, trigger `fn_voucher_branch`, RLS restrictive, `user_branch_scope`, `branch_consolidation_setting` (rls + audit). Kiểm thử: chứng từ cũ không đổi, ghi sổ/đảo giữ chi nhánh, RLS chặn.
2. API `apps/api/src/modules/branch`: danh mục chi nhánh, phạm vi người dùng, chi nhánh làm việc, gán chi nhánh chứng từ nháp; auth nạp phạm vi; `withTenant` đặt biến phiên; chặn đường dẫn báo cáo không theo chi nhánh.
3. Sổ sách và BCTC: tham số `branch` (`HO` hoặc id) cho Nhật ký chung, Sổ Cái, sổ chi tiết, Bảng cân đối số phát sinh, B01/B02/B03.
4. BCTC tổng hợp `GET /api/reports/consolidated/:code` + cấu hình tài khoản nội bộ; khung hợp nhất TT 202 với cổng `consolidation.status.json` `complete=false`.
5. Kiểm thử `apps/api/test/branches.test.ts`: phạm vi A không đọc/ghi chứng từ B; sổ/BCTC theo phạm vi; tổng hợp = tổng chi nhánh; loại trừ nội bộ cân.
6. Web: trang `/chi-nhanh` (danh mục, phạm vi người dùng, chi nhánh làm việc, BCTC tổng hợp), bộ lọc chi nhánh ở Sổ sách và Báo cáo tài chính; `e2e/chi-nhanh.spec.ts`.
7. Tài liệu `docs/user/giai-doan-7-da-chi-nhanh.md`, quyết định 1200+, mục "Chờ người dùng" nhóm 5.

## Ngoài phạm vi (ghi quyết định)

Đánh số chứng từ theo chi nhánh (cần định nghĩa lại `post_voucher`, GĐ6 có thể cũng sửa); phạm vi chi nhánh cho phân hệ có bảng riêng (công nợ, hóa đơn điện tử, kho, tài sản); hợp nhất nhiều pháp nhân TT 202/2014 (chờ văn bản gốc và TT 43/2026 sửa đổi).
