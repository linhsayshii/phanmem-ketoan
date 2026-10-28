# Sổ quyết định GĐ7 (2026-10-28 → …)

Kế hoạch: `2026-10-28-giai-doan-7-chi-tiet.md`. Số bắt đầu từ 1000 (GĐ6 dùng 599+). Mỗi nhóm chỉ sửa mục của mình. Mỗi dòng: quyết định — lý do — giá phải trả nếu sai. Cuối dòng: tác vụ/mã commit.

## Chung (1300+)

1300. Nhánh `claude/loving-euler-jskha6` từ `main`, không push `main`; migration từ 0200 vì `migrate.ts` sắp tên và áp dụng tệp chưa có, chịu được khoảng trống — khi hợp nhất với GĐ6 không cần đánh lại số; nếu hàm/trigger cùng tên bị định nghĩa lại ở cả hai nhánh thì phải viết migration hòa giải. (chung)

## Nhóm 1 — Hình thức sổ (1000–1049)

## Nhóm 2 — Song ngữ (1050–1099)

## Nhóm 3 — Ngân sách và phân tích (1100–1149)

## Nhóm 4 — Phê duyệt và mobile (1150–1199)

## Nhóm 5 — Đa chi nhánh (1200–1249)

1200. Chi nhánh = `department` có `is_branch` (đã có từ 0003, `warehouse.branch_id` đã trỏ vào), thêm `department.tax_code` (MST đơn vị trực thuộc), đơn vị cấp trên là `parent_id` sẵn có; không tạo bảng `branch` riêng — một khái niệm, kho đã gắn chi nhánh theo bảng này — nếu sau cần thuộc tính riêng nhiều thì tách bảng và chuyển khóa ngoại. (0240)
1201. Chi nhánh gắn ở tiêu đề `voucher.branch_id` (NULL = trụ sở chính), không thêm cột vào `voucher_line`: bảng partition, trigger bất biến, `fn_voucher_canonical`, cặp đối ứng không phải động vào; dòng suy chi nhánh qua join `voucher` — giá: báo cáo theo chi nhánh luôn join `voucher` (đã có trong mọi truy vấn phát sinh). (0240)
1202. `ADD COLUMN branch_id` không giá trị mặc định rồi mới `SET DEFAULT`: không viết lại dòng cũ, không chạy trigger dòng, chứng từ đã ghi sổ không bị UPDATE; chứng từ cũ thuộc trụ sở chính. (0240)
1203. Mặc định `branch_id` = biến phiên `app.branch_default` (chi nhánh làm việc của người dùng, lưu `user_pref` khóa `branch.working`) → mọi phân hệ lập chứng từ (tiền, hóa đơn, kho, tự động) gắn chi nhánh mà không sửa từng dịch vụ hay `vouchers.service.ts`; đổi chi nhánh của chứng từ nháp qua `PUT /api/vouchers/:id/branch` — giá: muốn lập chứng từ cho chi nhánh khác phải đổi chi nhánh làm việc hoặc đổi sau trên nháp; form chứng từ chưa có ô chi nhánh. (0240, branch/routes.ts)
1204. Trigger `fn_voucher_branch`: chứng từ đảo lấy chi nhánh chứng từ gốc (không sửa `reverse_voucher`, GĐ6 có thể cũng định nghĩa lại), chứng từ kết chuyển (`is_closing`) về trụ sở chính; chi nhánh phải là bộ phận `is_branch`. Đổi chi nhánh ghi `audit_event` (action `branch`) bằng trigger. Chứng từ đã ghi sổ không đổi được chi nhánh nhờ `trg_voucher_before` (to_jsonb khác) — không cần định nghĩa lại. `branch_id` không vào chuỗi hash (`fn_voucher_canonical` giữ nguyên để hash cũ còn khớp). (0240)
1205. Phạm vi chi nhánh = `user_branch_scope` (NULL = trụ sở chính; không có dòng = toàn công ty), khóa ngoại tới `tenant_user` CASCADE nhưng tới `department` không CASCADE (xóa chi nhánh làm mất dòng phạm vi duy nhất sẽ biến người dùng thành toàn công ty). Không tự đặt phạm vi cho chính mình (409 `BRANCH_SCOPE_SELF`). (0240)
1206. Chặn ở cơ sở dữ liệu: chính sách RLS **RESTRICTIVE** `branch_scope` trên `voucher` đọc `app.branch_scope` (id cách dấu phẩy, 0 = trụ sở chính) do `withTenant` đặt từ `req.auth`; biểu thức viết thẳng trong chính sách (không gọi hàm mỗi dòng), rỗng là luôn đúng. Mọi đường đọc/ghi chứng từ ở mọi phân hệ (danh sách, mở, sửa, ghi sổ, bỏ ghi sổ, đảo, xóa) tự lọc: chứng từ chi nhánh khác là 404, ghi sang chi nhánh ngoài phạm vi là 403 (WITH CHECK, 42501). Khóa API mang phạm vi của người tạo khóa. (0240, plugins/auth.ts, db.ts, ext/auth.ts)
1207. RLS chỉ phủ `voucher`; bảng không mang chi nhánh (`account_period_balance`, `open_item`, `stock_move`, thẻ tài sản, khế ước, hóa đơn điện tử…) không lọc được → người dùng bị giới hạn chỉ giữ danh sách quyền cho phép (`BRANCH_SCOPED_PERMISSIONS`: chứng từ, phiếu kho, sổ sách/BCTC, xem danh mục), đóng với quyền mới; báo cáo dưới `report.view` ngoài Sổ sách/BCTC/BCTC tổng hợp (công nợ, quỹ, kho, tài sản, số dư, bộ sổ năm) chặn 403 `BRANCH_SCOPE_FORBIDDEN` ở `onRequest` — giá: người dùng chi nhánh chưa dùng được công nợ, hóa đơn điện tử, kho, tài sản, thuế, cuối kỳ; mở dần khi từng phân hệ mang chi nhánh. (branch/scope.ts)
1208. Sổ sách, B01/B02/B03 và truy ngược nhận `branch` (`HO` hoặc id), giao với phạm vi người dùng (ngoài phạm vi 403 `BRANCH_FORBIDDEN`; người bị giới hạn không ghi thì mặc định là phạm vi). Có lọc thì số dư lấy từ `fn_balances_at_branch` (0241: cộng dòng đã ghi sổ, cùng cách chọn kỳ với `fn_balances_at`, không SECURITY DEFINER nên RLS vẫn áp) vì số dư kỳ không mang chi nhánh — giá: chậm hơn số dư kỳ trên sổ lớn. Kiểm: tổng ba đơn vị = toàn công ty. (0241, reporting/*)
1209. Khi lọc chi nhánh, phần dài hạn của gốc vay theo lịch trả khế ước (`loanLongRows`) bỏ qua (khế ước không mang chi nhánh, đọc nó làm lộ số cả công ty) — gốc vay của chi nhánh nằm ở dòng ngắn hạn B01; khoản công nợ dài hạn vẫn lọc theo chứng từ gốc của khoản. (financial.ts)
1210. BCTC tổng hợp (B01, B02) = đánh giá cùng định nghĩa báo cáo của công ty cho từng đơn vị trong phạm vi (trụ sở chính + chi nhánh), cộng theo dòng; cột loại trừ = báo cáo đánh giá chỉ trên đơn vị tài khoản nội bộ (`restrictData`; công thức tuyến tính theo đơn vị, trừ số thuần đánh giá lại 515/635 vốn không phải tài khoản nội bộ); cặp đối ứng tính là nội bộ khi một bên là tài khoản nội bộ. Tổng hợp = cộng − loại trừ; `internalNet` báo phải thu/phải trả nội bộ chưa khớp. Không cột so sánh năm trước, không B03. (branch/consolidated.ts)
1211. Tài khoản nội bộ mặc định 136, 336 (Phải thu nội bộ, Phải trả nội bộ, có trong cả ba hệ tài khoản nạp từ văn bản), người dùng khai báo thêm trong `branch_consolidation_setting` (quyền `setting.update`); không tự đoán doanh thu/giá vốn nội bộ. (0240)
1212. Không thêm quyền mới, không định nghĩa lại `create_tenant`: danh mục chi nhánh dùng `catalog.*`, phạm vi người dùng `user.view/update`, báo cáo `report.view`, cấu hình tổng hợp `setting.update` — tránh xung đột `create_tenant`/`permissions.ts` với GĐ6 và các nhóm khác. (branch/routes.ts)
1213. Chưa làm: đánh số chứng từ theo chi nhánh (cần định nghĩa lại `post_voucher`, GĐ6 có thể cũng sửa; số trùng giữa chi nhánh phải đổi ràng buộc `UNIQUE (tenant_id, voucher_type, voucher_no)`) — ghi "Chờ người dùng"; cột chi nhánh trên danh sách/form chứng từ; số dư đầu kỳ theo chi nhánh (DK lập theo chi nhánh làm việc của người nhập). (—)
1214. Hợp nhất TT 202/2014: thuvienphapluat.vn, vbpl.vn trả 403; tìm thấy thêm TT 43/2026/TT-BTC sửa đổi TT 202 cũng chưa có văn bản gốc → chỉ dựng khung (thẻ "Hợp nhất" nêu rõ chưa có), cổng `packages/coa-data/data/consolidation/status.json` `complete=false`, mục "Chờ người dùng" nhóm 5 trong `docs/TIEP-THEO.md`. (—)
1215. Tệp dùng chung đã chạm: `packages/db/src/client.ts` (thêm hai biến phiên trong `withTenant`), `packages/db/src/types.ts` (cuối), `apps/api/src/app.ts` (cuối), `plugins/auth.ts`, `plugins/db.ts`, `ext/auth.ts`, `reporting/{financial,ledgers,routes}.ts`, `print/bookSet.ts` (tham số `branch` tùy chọn), web `router.tsx` (cuối), `Ledgers.tsx`, `Financial.tsx`, `Users.tsx`. (—)

## Nhóm 6 — HKD và siêu nhỏ (1250–1299)
