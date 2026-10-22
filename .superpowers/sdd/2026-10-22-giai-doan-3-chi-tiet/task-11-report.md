# Báo cáo Tác vụ 11: mua hàng hóa

Trạng thái: xong. Migration 0054_mua_hang.sql. Loại MH, TLM; ba cách nhận hàng (qua kho, hàng về trước, hóa đơn về trước); PNK `sourceInvoiceIds`; TLM trả hàng theo giá nhập gốc và chỉ giảm giá bằng lớp adjustment.
Web: InvoiceForm mở rộng (cách nhận hàng, mã hàng, ĐVT, kho, lô, hạn, mã dòng nhập gốc); e2e `mua-hang.spec.ts` xanh.
Kiểm thử: db 104, domain 172, api 716 (sau sửa mã lỗi INVOICE_LINE_UNMATCHED), bất biến 19, web 214, lint và typecheck sạch.
Quyết định 257-264 trong file quyết định GĐ3. Tài liệu: mục "Mua hàng hóa".
Lưu ý: phải chạy `pnpm db:migrate` trên DB phát triển trước khi chạy e2e.
Giới hạn: xem quyết định 263.

## Fix round 1

Migration `0055_mua_hang_sua.sql` (cột `voucher_item_line.stock_value`; định nghĩa lại `fn_stock_adjust_links`, `fn_stock_adjust_unlink`, `fn_stock_moves_create` từ thân 0054). Quyết định 265–273.

Đã sửa: 1 (cùng đối tượng), 2a/b/c (liên kết tới phiếu đã ghi sổ, nháp tham chiếu cũng chặn, `RECEIPT_LINK_LOST`/`INVOICE_LINK_LOST`), 3 (`stock_value` từ `detail.baseVnd`), 4 (`RETURN_EXCEEDS_RECEIPT`), 6 (`STOCK_COST_ADJUSTED` khi MH/TLM đã được tính giá vốn), 7 (hàm `createsStockMoves`), 8 (autoPost kiểm `stock_voucher.post`, cảnh báo tồn âm), 9 (Có 151 cố định), 11 (tài liệu). Hoãn: 5, 10 (quyết định 272–273).

Kiểm thử mới (`apps/api/test/inventory/purchase.test.ts`, 7 test): đối tượng khác; liên kết tới nháp và LINE_REFERENCED; mất liên kết (3 trường hợp + 400 đổi TK Có); USD 0,33 + 0,33 @25.432,5 (làm tròn từng dòng 16.786, sổ cái 156 = 16.785): Σ lớp = 156, 151 về 0; trả quá số lượng; STOCK_COST_ADJUSTED sau chạy giá vốn (đảo vẫn được); autoPost thiếu quyền 403 và in mẫu kho 409.

Lệnh và kết quả (tuần tự): `pnpm db:migrate` (0055 áp dụng); `pnpm -F @kt/db test` 104 xanh; `pnpm -F @kt/api test` 723 xanh (55 file); `INVARIANTS=1 ... test/invariants test/sample-xyz.test.ts` 19 xanh; `pnpm lint` sạch; `pnpm typecheck` sạch.

Chưa làm: kiểm đối tượng giữa PNK và MH hóa đơn về trước (`sourceInvoiceIds`); e2e web không chạy lại (hợp đồng API giữ nguyên).

## Fix round 2

- PNK theo `sourceInvoiceIds` phải cùng đối tượng với hóa đơn MH: 409 `RECEIPT_PARTY_MISMATCH` (`inventory/stockVouchers.ts`).
- Migration `0056_mua_hang_sua2.sql`: định nghĩa lại `fn_stock_adjust_links` từ thân 0055, bỏ kiểm `INVOICE_LINK_LOST` (PNK nhập tay Có 151 từ số dư đầu kỳ hợp lệ); giữ `RECEIPT_LINK_LOST` cho MH. Quyết định 266 đã cập nhật.
- Kiểm thử: bỏ khẳng định PNK Có 151 thất bại; thêm PNK tay Có 151 ghi sổ được và PNK khác nhà cung cấp bị 409. Kiểm thử đúng: purchase + stockVouchers 25 xanh; db 104; api 723; lint, typecheck sạch.
- Không còn kiểm liên kết ở SQL cho PNK từ `sourceInvoiceIds` (API luôn dựng liên kết; chỉ mất khi sửa dữ liệu ngoài API).
