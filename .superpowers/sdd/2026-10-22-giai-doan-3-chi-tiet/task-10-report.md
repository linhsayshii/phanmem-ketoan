# Task 10 report
Status: DONE (with concerns).
- Migration 0052_gia_von_cu.sql: fn_stock_mark_stale; fn_stock_moves_create/remove redefined from live pg_get_functiondef bodies plus one PERFORM each; stock_cost_layer.voucher_id.
- costingRun.ts: receipt value = receipt + adjustment layers (fixes in-period and opening replay); GV emits adjustment layers (Nợ kho / Có credit_account), re-emits those in reversed GVs; summary.delta includes them; adjustReceiptPrice + PUT /api/stock-vouchers/:id/receipt-price (costing.run + view_cost, audit_event).
- Web: staleText banners in CostingRun.tsx and StockVoucher.tsx; e2e gia-von extended.
- Tests: apps/api/test/inventory/costingStale.test.ts (3); costingRun.test.ts manual stale insert removed.
- Decisions #245-251.
Verification: db 104, api 706, invariants+xyz 19, lint, typecheck, e2e gia-von + phieu-kho green.
Concerns: no UI field for receipt-price edit (API only); fn_stock_estimate_cost unchanged (#250); stale marking broader than plan (#246).

## Sửa vòng 1

Sửa: (1) điều chỉnh tổng 0 đặt lại `voucher_id` NULL; (2) migration 0053 chặn bỏ ghi sổ khi điều chỉnh đã vào GV (`STOCK_COST_ADJUSTED`); (3) phát lại trừ `adj_open` cho phát sinh sau cuối kỳ; (4) `summary.delta` chỉ lớp mới; (5) FK thường; (6) `unit_cost` 0; (7) quyết định #252–256.

Kiểm thử mới trong `apps/api/test/inventory/costingStale.test.ts` (7 test; mỗi lần chạy kiểm Σ remaining_value = số dư 155 theo kho, mọi ngày): ca B (+200/−200), ca C (bỏ ghi sổ 409 và đảo phiếu), ca A (điều chỉnh tháng 2, chạy lại tháng 1), delta = 0.

Lệnh và kết quả: `pnpm -F @kt/api test -- test/inventory/costingStale.test.ts test/inventory/costingRun.test.ts` 25 passed; `pnpm -F @kt/db test` 104 passed; api đầy đủ 710 passed; bất biến + xyz 19 passed; db 104 passed; lint, typecheck sạch.
