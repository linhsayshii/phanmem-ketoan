# Tác vụ 12: chi phí mua hàng (CPM) và mua hàng nhập khẩu

Trạng thái: XONG. Commit a81ca55 (db, domain), 4a3c058 (api), 39a16d2 (web), 9c2c0d6 (docs), cộng commit báo cáo này.

## Đã làm

- `packages/domain/src/landedCost.ts`: `allocateLandedCost(costs, lines, basis)` thuần, decimal.js, phần dư lớn nhất (Hamilton). Σ = tổng chính xác, không âm, mỗi dòng lệch < 1 đồng (fast-check 300 lần). Ví dụ 100 cho 1.000/2.000/3.000 ra 17/33/50. Lỗi `LANDED_COST_BASIS_ZERO`, `LANDED_COST_INVALID`.
- Loại chứng từ CPM (`voucherTypes.ts`, module arap).
- Migration `0057_chi_phi_mua.sql`:
  - bảng `landed_cost_alloc` (RLS, audit, khóa ngoại tổng hợp, chặn sửa dòng con khi chứng từ không còn nháp);
  - cột nhập khẩu trên `voucher_item_line` kèm CHECK;
  - `seed_voucher_types` định nghĩa lại và bổ sung loại cho công ty có sẵn, `trg_audit` tắt khi bổ sung;
  - `fn_stock_adjust_links`: nhánh CPM sinh lớp điều chỉnh `voucher_id` = CPM tại ngày nhập, rồi `fn_stock_mark_stale_at`. Lỗi: `LANDED_COST_EMPTY`, `LANDED_COST_MISMATCH`, `RECEIPT_NOT_POSTED`, `LANDED_COST_DATE_INVALID`. Đảo phiếu nhập đang được CPM tham chiếu thì báo `LANDED_COST_REFERENCED`;
  - `fn_stock_adjust_unlink`: chặn `LANDED_COST_REFERENCED`;
  - `fn_stock_moves_remove`: thêm CPM vào danh sách kiểm `STOCK_COST_ADJUSTED`.
- API `apps/api/src/modules/inventory/landedCost.ts`:
  - `GET /api/landed-costs/receipts` cần view_cost;
  - `POST`, `PUT`, `GET /api/landed-costs[/:id]`;
  - bút toán Nợ TK kho của dòng nhập, Nợ 1331 / Có TK thanh toán của từng dòng chi phí;
  - hóa đơn dịch vụ qua `invoices` (`DECLARING_TYPES` thêm CPM);
  - route chung chặn CPM (`VOUCHER_TYPE_USE_LANDED_COST`); quyền `stock_voucher.*` và cờ nhạy cảm.
- Nhập khẩu trên MH (`invoices/service.ts`), số tiền VND theo tờ khai, không có thuế suất:
  - các trường `importMode`, `importTax`, `specialConsumptionTax`, `vatImport`, `vatImportCode`;
  - bút toán Nợ kho / Có 3333, Nợ kho / Có 3332, Nợ 1331 / Có 33312;
  - `stock_value` = VND hàng + NK + TTĐB;
  - bảng kê: dòng GTGT hàng nhập, NK và TTĐB vào thuế khác.
- Web:
  - màn `LandedCost.tsx` (menu Mua hàng, "Chi phí mua hàng"). Tab Phiếu nhập chọn chứng từ, tab Chi phí dùng KeyboardGrid và F4. Tab Phân bổ xem trước bằng `allocateLandedCost`. Có thêm tab Hóa đơn (DeclaredInvoices) và tab Hạch toán. Phím Ctrl+S và F9; có Bỏ ghi sổ, Đảo, Hủy;
  - `InvoiceForm.tsx`: ô đánh dấu "Hàng nhập khẩu" mở thêm 4 cột, bút toán xem trước có thêm các dòng thuế nhập khẩu (`importLedger`). Nhóm kê khai mặc định lấy theo mã GTGT hàng nhập.
- Tài liệu: mục "Chi phí mua hàng, nhập khẩu" trong `docs/user/giai-doan-3-kho-mua-ban.md`; quyết định 274–282.

## Kiểm thử

- domain 175/175, db 104/104, api 727/727 (gồm `test/inventory/landedCost.test.ts` 4 ca), web vitest 215/215.
- INVARIANTS (invariants + sample-xyz) 19/19. lint, typecheck sạch.
- Playwright `e2e/chi-phi-mua.spec.ts`: 2/2. Ca 1 là CPM bằng bàn phím: phân bổ 120.000 → 620.000, ghi sổ F9, bút toán 156/1331. Ca 2 là MH nhập khẩu: bút toán xem trước 3333/3332/33312/1331, Tổng Nợ 1.177.000, ghi sổ.
- Ca kiểm của bản giao việc: sau CPM và tính giá vốn, Σ remaining_value theo (TK, kho) = số dư sổ cái (drift rỗng), và GV chỉ ghi phần đã xuất (156 Có / 632 Nợ 34.286), không ghi lại số CPM. Chạy lại tính giá vốn không đổi.

## Điểm cần lưu ý

- Phân bổ dùng phần dư lớn nhất thay cho câu chữ "dư vào dòng tỷ trọng lớn nhất" (quyết định 275): khớp ví dụ 17/33/50.
- TT99/TT133 không có 1562, nên CPM ghi Nợ thẳng TK kho (quyết định 276).
- Lớp giá đặt ở ngày nhập, sổ cái ở ngày CPM: giữa hai ngày đó số dư 156 lệch tạm với giá trị tồn theo lớp giá (quyết định 282).
- Bảng kê nhập khẩu: nhiều dòng cùng `vatImportCode` gộp thành một dòng. Giá tính thuế GTGT hàng nhập lấy hàng VND + NK + TTĐB, chưa tách chi phí vận chuyển, bảo hiểm (CIF) đã có trên tờ khai (quyết định 281).
- Màn CPM lọc phiếu nhập theo khoảng ngày, mặc định từ đầu tháng thứ hai trước đó; máy chủ trả tối đa 500 chứng từ.
