# API cho ứng dụng di động (`/api/mobile/v1`)

JSON gọn cho điện thoại: việc chờ duyệt, duyệt/từ chối đề nghị thanh toán, tạm ứng; báo cáo tóm tắt. Không có điểm cuối lập hay sửa chứng từ. Mã nguồn: `apps/api/src/modules/approval/mobile.ts`, kiểm thử `apps/api/test/approval/mobile.test.ts`.

## Xác thực

Hai cách, kiểm ở `onRequest` của nhóm route:

1. **Khóa API phạm vi `mobile`** (khuyên dùng cho ứng dụng cài trên máy): header `Authorization: Bearer kt_…`. Tạo khóa ở Hệ thống → Khóa API, chọn phạm vi "Ứng dụng di động". Xác thực dùng chung với API ngoài (`modules/ext/auth.ts`): tra tiền tố, so SHA-256 thời gian hằng, khóa thu hồi/hết hạn/người dùng bị khóa đều 401 cùng một thông báo; 60 yêu cầu/phút/khóa. Khóa không có phạm vi `mobile` → 403 `SCOPE_FORBIDDEN`.
2. **Phiên cookie** `sid` (ứng dụng web nhúng, trình duyệt): không gửi header `Authorization`. Thiếu phiên → 401 `UNAUTHENTICATED`.

Có header `Authorization` thì cookie bị bỏ qua (không trộn hai cách).

**Quyền hiệu lực** của khóa = quyền vai trò hiện hành của người tạo ∩ quyền của phạm vi `mobile` (`report.view`, `approval_request.approve`); với phiên là quyền vai trò. Cờ nhạy cảm (`view_payable`, `view_cost`…) của người dùng vẫn áp dụng.

Khóa API chỉ được đọc ở `/api/ext/v1` và `/api/mobile/v1`; mọi route khác (quản trị người dùng, vai trò, cấu hình, chứng từ) chỉ nhận phiên cookie nên khóa mobile gọi vào đó nhận 401. Khóa mobile gọi `/api/ext/v1/*` nhận 403 `SCOPE_FORBIDDEN`.

## Lỗi

`{ "error": { "code": "...", "message": "..." } }`, thông báo tiếng Việt. 400 đầu vào, 401 xác thực, 403 quyền/phạm vi/cờ nhạy cảm (`FORBIDDEN`, `SCOPE_FORBIDDEN`, `APPROVAL_SELF`, `APPROVAL_WRONG_APPROVER`, `APPROVAL_ALREADY_ACTED`), 404 không có, 409 trạng thái (`APPROVAL_NOT_PENDING`), 429 vượt giới hạn tốc độ. Tiền là chuỗi số nguyên VND; nguyên tệ chuỗi thập phân.

## Điểm cuối

| Phương thức, đường dẫn | Quyền | Trả về |
|---|---|---|
| `GET /me` | đã xác thực | `{ username, tenantId, via: "api_key"\|"session", canApprove, canViewReports, pending }` |
| `GET /approvals` | `approval_request.approve` | `{ items: [ { id, requestNo, kind, kindLabel, requestDate, requester, payee, reason, amount, currencyCode, amountCurrency, state, step, steps, dueDate } ] }`: đề nghị đang chờ chính người này duyệt |
| `GET /approvals/:id` | `approval_request.approve` | như trên cộng `partyName, payMethod, canAct, rejectReason, voucherNo, approvals: [{ step, action, by, at, note }], attachments` (số tệp) |
| `POST /approvals/:id/approve` | `approval_request.approve` | thân `{ note? }` → `{ state: "submitted"\|"approved", currentStep, voucherId }` |
| `POST /approvals/:id/reject` | `approval_request.approve` | thân `{ reason }` (bắt buộc) → `{ state: "rejected" }` |
| `GET /reports/financial/B01?from=&to=` | `report.view` | `{ reportCode, name, regime, period, rows: [ { lineCode, label, current, previous } ] }`: các chỉ tiêu in đậm của báo cáo đầy đủ |
| `GET /reports/financial/B02?from=&to=` | `report.view` | như trên |
| `GET /reports/cash?asOf=` | `report.view` | `{ asOf, cash, bank, total }`: số dư Nợ − Có của 111 và 112 cuối ngày |
| `GET /reports/pnl?from=&to=` | `report.view` | `{ revenue: [ { accountCode, name, amount } ], expense: [...], totalRevenue, totalExpense, profit }` theo TK cấp 1 loại 5–8, bỏ bút toán kết chuyển; thiếu `view_cost` thì bỏ 632, không có `profit`, có `costHidden: true` |

Quy tắc duyệt giống web (`apps/api/src/modules/approval/service.ts`): người đề nghị không tự duyệt; đúng người hoặc vai trò của bước hiện tại; một người không duyệt hai bước của cùng đề nghị; duyệt bước cuối sinh Phiếu chi / Giấy báo Nợ nháp (khóa idempotency `apr:<id>`, `source_doc_type = 'approval_request'`).

## Ví dụ

```bash
curl -s -H "Authorization: Bearer $KT_MOBILE_KEY" https://ketoan.example/api/mobile/v1/approvals
curl -s -X POST -H "Authorization: Bearer $KT_MOBILE_KEY" -H 'content-type: application/json' \
  -d '{"note":"Đồng ý"}' https://ketoan.example/api/mobile/v1/approvals/<id>/approve
curl -s -H "Authorization: Bearer $KT_MOBILE_KEY" "https://ketoan.example/api/mobile/v1/reports/pnl?from=2026-10-01&to=2026-10-31"
```

Khóa lưu trong kho bảo mật của hệ điều hành (Keychain/Keystore), không lưu ở bộ nhớ thường. Mất máy thì thu hồi khóa ở trang Khóa API.
