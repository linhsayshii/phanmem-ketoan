# Kế hoạch chi tiết GĐ7 nhóm 4: Phê duyệt và API mobile

> Phạm vi trong `2026-10-28-giai-doan-7-chi-tiet.md` (nhóm 4). Migration 0230–0239, quyết định 1150–1199. Không đụng sổ cái, `periodClose.ts`, kho, lương.

**Goal:** Đề nghị thanh toán / đề nghị tạm ứng đi qua quy trình phê duyệt nhiều bước theo hạn mức; duyệt xong sinh Phiếu chi / Giấy báo Nợ nháp; API `/api/mobile/v1` để duyệt và xem số liệu tóm tắt trên điện thoại.

**Architecture:** Module mới `apps/api/src/modules/approval` (dịch vụ `service.ts`, route web `routes.ts`, route mobile `mobile.ts`). Bảng mới có `tenant_id`, RLS, `audit_enable`; đề nghị không phải chứng từ sổ cái. Chứng từ tiền sinh qua `createSystemVoucher` (dịch vụ chứng từ có sẵn) với `source_doc_type = 'approval_request'` và khóa idempotency `apr:<id>`. Mobile dùng khóa API GĐ5 (phạm vi mới `mobile`) hoặc phiên cookie.

## Mô hình dữ liệu (0230)

- `approval_flow (id, tenant_id, kind payment|advance, name, min_amount numeric(20,0), is_active)`; chọn quy trình: đang dùng, cùng loại, `min_amount` lớn nhất ≤ số tiền (VND) đề nghị. Chỉ mục duy nhất `(tenant_id, kind, min_amount) WHERE is_active`.
- `approval_flow_step (tenant_id, flow_id, step_no, role_id | user_id)`: đúng một trong hai.
- `approval_request`: số `DNTT-YYYY-00001` / `DNTU-…`, ngày, người đề nghị, đối tượng (tùy chọn), người nhận, lý do, loại tiền, nguyên tệ `numeric(20,4)`, tỷ giá `numeric(20,10)`, số tiền VND `numeric(20,0)`, TK Nợ, hình thức chi (tiền mặt/chuyển khoản + TK ngân hàng), hạn thanh toán, trạng thái `draft → submitted → approved | rejected | cancelled`, bản chụp các bước (`steps jsonb`) lúc gửi duyệt, bước hiện tại, lý do từ chối, `voucher_id`.
- `approval_step_log`: mỗi lần gửi/duyệt/từ chối/hủy một dòng (người, bước, ghi chú).
- `approval_attachment`: tệp đính kèm của đề nghị (bảng đính kèm chứng từ cần `voucher_id` nên không dùng chung); khi duyệt xong chép sang `voucher_attachment` của phiếu sinh ra.
- `api_key.scopes` thêm `mobile`.
- Quyền: `approval_request.view` (xem mọi đề nghị), `.create` (lập đề nghị của mình), `.approve` (duyệt). Cấu hình quy trình dùng `setting.update`.

## Tác vụ

1. Migration 0230 + kiểu `packages/db/src/types.ts` + quyền `permissions.ts`. Kiểm: `pnpm db:migrate`, kiểm thử quyền hiện có (`test/config.test.ts`/`roles`).
2. Dịch vụ + route web `/api/approvals*`, `/api/approval-flows*`. Kiểm thử trước `apps/api/test/approval/approval.test.ts`: chọn quy trình theo hạn mức; người đề nghị không tự duyệt; sai vai trò 403; một người không duyệt hai bước; từ chối cần lý do; hủy; duyệt xong sinh PC nháp (Nợ 331/Có 1111) và BN tạm ứng (Nợ 141/Có 1121), idempotent; cờ `view_payable` chặn xem/duyệt; mỗi chuyển trạng thái có `audit_event`; đính kèm chép sang phiếu.
3. Route mobile `/api/mobile/v1`: `me`, `approvals` (chờ duyệt), `approvals/:id`, duyệt/từ chối, `reports/financial/:code` (B01/B02 tóm tắt), `reports/cash`, `reports/pnl`. Kiểm thử `apps/api/test/approval/mobile.test.ts`: khóa phạm vi `mobile` dùng được; khóa không phạm vi `mobile` 403; khóa mobile không vào `/api/users` hay `/api/ext/v1/items`; quyền = vai trò ∩ phạm vi; phiên cookie dùng được; giá vốn bị ẩn khi thiếu `view_cost`.
4. Web: trang `/phe-duyet` (Đề nghị của tôi / Chờ tôi duyệt / Tất cả; ngăn kéo chi tiết; lập đề nghị Ctrl+S, Insert), `/phe-duyet/quy-trinh`; huy hiệu số việc chờ duyệt ở đầu trang; thanh menu thu gọn ở màn hình hẹp. Playwright `e2e/phe-duyet.spec.ts`.
5. Tài liệu `docs/user/giai-doan-7-phe-duyet-mobile.md`, `docs/dev/api-mobile.md`; quyết định 1150+.

Lệnh kiểm: `pnpm lint && pnpm typecheck && pnpm -F @kt/api test -- test/approval test/ext`; e2e `E2E_API_PORT=3040 E2E_WEB_PORT=5184 pnpm -F @kt/web exec playwright test e2e/phe-duyet.spec.ts`.
