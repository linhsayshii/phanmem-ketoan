# Kế hoạch thực hiện chi tiết: GĐ3 (Kho và mua bán hàng hóa)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Doanh nghiệp thương mại có kho dùng được: danh mục VTHH/kho/bảng giá; nhập, xuất, chuyển kho, lắp ráp, kiểm kê; mua và bán hàng hóa (qua kho, hàng về trước/hóa đơn về sau, nhập khẩu, trả lại, gửi bán); tính giá vốn 4 phương pháp; báo cáo kho, bán hàng, mua hàng; soát lỗi và bất biến sổ kho ↔ sổ cái.

**Architecture:** Giữ modular monolith. Chứng từ kho là chứng từ thật trong `voucher`/`voucher_line`; phần vật tư nằm ở `voucher_item_line` (mở rộng kho, lô, chiều nhập/xuất). `stock_move` (lượng, bất biến) sinh trong `post_voucher` bằng SQL (như `open_item`) nên seed, đảo, bỏ ghi sổ cùng đi một đường. Chứng từ xuất ghi sổ cái ngay theo **giá tạm tính** (bình quân tức thời tại ngày); mỗi lần chạy giá vốn (`costing_run`) tính giá thật theo phương pháp của kho, gán vào `stock_cost_assignment` (có phiên bản theo lần chạy) và sinh **một chứng từ giá vốn `GV`** ghi phần chênh (giá thật − giá đã ghi) trên 632/155/156...; chạy lại = đảo `GV` cũ, sinh mới (khuôn `runOutflowAdjust`). Động cơ tính giá là hàm thuần ở `packages/domain` (kiểm thử fast-check). Mua/bán hàng hóa mở rộng động cơ hóa đơn GĐ2 (`invoices`) bằng mã hàng và kho.

**Tech Stack:** như GĐ2 (Node 22, TypeScript 5, Fastify 5, Kysely, PostgreSQL 16, Vitest, fast-check, React 18 + Vite + Ant Design 5 + AG Grid, Playwright, ExcelJS, pnpm). Không thêm phụ thuộc npm.

**Spec:** `docs/superpowers/specs/2026-10-19-phan-mem-ke-toan-design.md` (mục 6 Kho, 7.1, 7.3, 9 dòng VTHH/Kho/Mua/Bán/Tiện ích, 12 mẫu in, 14 bất biến 5); lộ trình `docs/superpowers/plans/2026-10-19-lo-trinh-thuc-hien.md` mục "Giai đoạn 3"; bàn giao `docs/TIEP-THEO.md` mục "Bàn giao GĐ3"; khuôn `2026-10-21-giai-doan-2-chi-tiet.md`; quyết định `2026-10-21-giai-doan-2-quyet-dinh.md`.

## Global Constraints

- Mọi quy tắc trong `CLAUDE.md` mục "Quy tắc bất biến". Nhắc các điểm GĐ3 chạm nhiều: tiền VND `NUMERIC(20,0)`; **số lượng `NUMERIC(20,4)`, đơn giá/giá vốn đơn vị `NUMERIC(20,4)`**; trong TypeScript tiền/số lượng là chuỗi thập phân + `D()`, không bao giờ `number`; đầu vào tiền VND theo `VND_AMOUNT_RE`.
- Không `UPDATE`/`DELETE` dòng sổ cái đã ghi sổ; `stock_move` bất biến sau ghi sổ (xóa chỉ khi `unpost`, đúng như dòng sổ cái); giá vốn thay đổi bằng chứng từ `GV` (đảo cũ, sinh mới), không sửa dòng đã ghi.
- Chứng từ `GV` (giá vốn) là loại hệ thống: có số, ngày, người lập, `source_doc_type='costing_run'`, `source_doc_id` = id lần chạy; không lập tay, không bỏ ghi sổ/hủy/sửa qua route chung. Định nghĩa lại `unpost_voucher`/`discard_voucher`/`post_voucher` lấy **thân cuối** bằng `SELECT pg_get_functiondef('<hàm>'::regproc)` trên DB đã migrate (0042 vừa định nghĩa lại `post_voucher`), không chép từ migration cũ; `SYSTEM_MSG` trong `vouchers.service.ts` thêm `costing_run`.
- Bảng mới: `tenant_id uuid NOT NULL REFERENCES tenant(id)`, `SELECT rls_enable('<bảng>')`; bảng người dùng thao tác thêm `audit_enable`; mọi `UNIQUE` có `tenant_id`; khóa ngoại giữa hai bảng cùng có `tenant_id` là tổng hợp `(tenant_id, x_id) REFERENCES cha (tenant_id, id)`, bảng cha có `UNIQUE (tenant_id, id)`; `ON DELETE SET NULL` dùng `SET NULL (x_id)`. Hàm `SECURITY DEFINER` có `SET search_path = public, pg_temp`.
- Migration 0001–0042 đóng băng; GĐ3 bắt đầu ở **0043** (bảng "Thứ tự thực hiện"); nếu số đã bị dùng thì dịch lên. `app_user` không ghi trực tiếp partition `voucher_line_YYYY_MM`: mọi ghi dòng chứng từ qua bảng gốc; đọc lọc `posting_date`. Khóa ngoại mới `voucher_line.item_id/warehouse_id` khai báo trên bảng gốc `voucher_line`.
- Tham số pháp lý/mẫu in: mẫu số 01-VT, 02-VT, S10-DN, S12-DN chỉ in khi đã đối chiếu `~/legal-docs/tt99-2025/tt99-full.txt` và `~/legal-docs/tt133-2016/tt133-full.txt`; không bịa. Phương pháp giá vốn mặc định TT99: bình quân cuối kỳ (`costing_method=avg_period`).
- Cờ nhạy cảm: giá vốn, đơn giá vốn, giá trị tồn, lãi gộp chặn ở API bằng `view_cost` (403 `FORBIDDEN` nêu cờ), không chỉ ẩn ở giao diện; `SENSITIVE_BY_SUBLEDGER` thêm `inventory: 'view_cost'`.
- Báo cáo đọc trong `READ_SNAPSHOT` (`REPEATABLE READ READ ONLY`). Mã lỗi `_NOT_FOUND` luôn 404; trạng thái không cho thao tác 409; đầu vào sai 400.
- Giao diện, thông báo lỗi, tài liệu: tiếng Việt kế toán chuẩn (Phiếu nhập kho, Phiếu xuất kho, Phiếu chuyển kho, Thẻ kho, Sổ chi tiết vật liệu, dụng cụ, sản phẩm, hàng hóa, Bảng tổng hợp Nhập – Xuất – Tồn). Mã, bảng, biến: tiếng Anh.
- Màn hình mới: skill `evon:ui-ux` chế độ **dựng luôn**; dùng `KeyboardGrid`, `LookupSelect`, `VnNumberInput`, `useHotkeys`, `useRememberedFilter` của `@kt/ui`; phím Insert/Ctrl+S/F9/F4/Enter/Tab; mỗi màn hình ít nhất một spec Playwright trong `apps/web/e2e/` theo khuôn `phieu-thu.spec.ts` (`signIn`).
- Kiểm thử tuần tự trên PostgreSQL thật (DB tạm theo lần chạy). Một gói: `pnpm -F @kt/api test -- test/<file>.test.ts`. Không chạy hai việc nặng (Playwright, bất biến dài, perf) song song (VPS 2 CPU).
- Commit nhỏ Conventional Commits, mô tả tiếng Việt, scope `db|domain|api|worker|web|ui|coa|docs`; trailer `Co-Authored-By` của model viết commit. Push `origin main` sau mỗi tác vụ. Quyết định ghi vào `docs/superpowers/plans/2026-10-22-giai-doan-3-quyet-dinh.md`.

## Quy ước thiết kế đã chốt (kế hoạch này; chi tiết số liệu ở các tác vụ)

1. **Đơn vị cơ sở**: `stock_move.quantity` luôn theo ĐVT cơ sở của hàng (`item.base_uom_id`); dòng chứng từ giữ `uom_id` và `quantity` theo ĐVT nhập, quy đổi bằng `item_uom.factor` (ĐVT → cơ sở), cột `base_quantity`.
2. **Chiều**: `stock_move.direction` `'in'|'out'`; chuyển kho = hai `stock_move` (out ở kho đi, in ở kho đến) cùng `transfer_id`; giá nhập của chiều `in` chuyển kho = giá gán của chiều `out`.
3. **Phương pháp giá vốn** theo kho: `warehouse.costing_method` (null → `tenant_setting costing_method`). Tính theo từng `(item, warehouse)`; chuyển kho giữa kho khác phương pháp: nhập ở kho đến theo giá gán của kho đi.
4. **Giá tạm tính** khi ghi sổ chứng từ xuất = `fn_stock_estimate_cost(item, warehouse, date)`: bình quân tồn tại ngày (giá trị/số lượng từ `stock_cost_layer` còn lại đến ngày, tồn 0 thì giá nhập gần nhất); đây là số trên dòng sổ cái của chứng từ xuất, `GV` sửa phần lệch.
5. **Tồn âm**: `tenant_setting stock_negative` `'forbid'|'warn'|'allow'` (mặc định `forbid`): ghi sổ chứng từ xuất kiểm tồn lũy kế tại mọi ngày từ ngày chứng từ trở đi (ghi lùi không được làm tồn âm ngày sau); `warn` cho qua và trả cảnh báo trong phản hồi.
6. **Khóa cạnh tranh**: mọi ghi `stock_move` lấy `pg_advisory_xact_lock(hashtextextended(tenant||item||warehouse,0))` theo thứ tự khóa tăng dần để không bế tắc.
7. **Thứ tự trong ngày**: `stock_move.seq` tăng theo `(posting_date, voucher.seq_no, line_no)`; nhập trước xuất trong cùng ngày; sắp xếp lại bằng `voucher.day_order` (cột mới, sửa được khi nháp).

## Review Focus

1. Ghi lùi một phiếu nhập vào tháng đã chạy giá vốn: giá vốn tháng đó và các tháng sau phải thành "chưa cập nhật" (dòng soát lỗi + biểu ngữ), chạy lại giá vốn đảo `GV` cũ sinh `GV` mới; không có dòng sổ cái nào bị sửa (Task 10 có kiểm thử).
2. Xuất quá tồn (kể cả tồn đủ hôm nay nhưng ghi lùi một phiếu xuất làm tồn ngày giữa âm): bị từ chối `STOCK_NEGATIVE` nêu ngày và số thiếu; cấu hình `warn` cho qua kèm cảnh báo (Task 7).
3. Bán 12 thùng với hàng khai báo 1 thùng = 24 chai, tồn tính bằng chai; trả lại 5 chai: lượng cơ sở đúng, giá vốn trả lại = giá vốn dòng bán gốc (Task 6, 13).
4. Đảo hoặc bỏ ghi sổ phiếu nhập đã bị xuất hết một phần: `unpost` bị từ chối `STOCK_CONSUMED` nêu chứng từ xuất; đảo thì sinh phiếu xuất đảo và cho phép tồn âm đúng bằng cấu hình (Task 7).
5. Tổng `remaining_value` bằng số dư 152/153/155/156/157 (theo TK của từng kho) sau mọi lần chạy giá vốn, cả khi làm tròn đồng và khi tồn về 0 (phần lẻ làm tròn dồn vào lần xuất cuối) (Task 8, 23).

---

## Cấu trúc file

- `packages/domain/src/`: `costing.ts` (động cơ giá vốn thuần), `stock.ts` (quy đổi ĐVT, kiểm tồn, kiểu), `voucherTypes.ts` (thêm module `inventory`, loại PNK/PXK/CK/LR/KK/GV/MH/BH/TLB/TLM), `permissions.ts`, `unit.ts`.
- `packages/db/migrations/0043_quyen_gd3.sql` … `0054_ky_han_luong_tien.sql` (bảng "Thứ tự thực hiện").
- `apps/api/src/modules/inventory/` (mới): `items.ts` (hàng, đơn vị, bảng giá), `stockMoves.ts` (sinh/kiểm tồn), `stockVouchers.ts` (PNK/PXK/CK/LR/KK), `costingRun.ts`, `openingStock.ts`, `reports.ts` (NXT, thẻ kho, sổ chi tiết, hạn dùng, đối chiếu), `routes.ts`.
- `apps/api/src/modules/invoices/service.ts` (mở rộng mã hàng, kho), `apps/api/src/modules/orders/` (mới: báo giá, đơn bán, đơn mua, hợp đồng), `apps/api/src/modules/reporting/print/stockForms.ts` (01-VT, 02-VT, S10, S12).
- `apps/web/src/pages/`: `Items.tsx`, `Warehouses.tsx`, `PriceLists.tsx`, `StockVoucher.tsx` (+ danh sách), `OpeningStock.tsx`, `CostingRun.tsx`, `StockReports.tsx`, `SalesPurchaseReports.tsx`, `Orders.tsx`, `Stocktake.tsx`.
- `packages/db/src/seed/demo-abc.ts` (thêm kho), `apps/api/scripts/seed-abc.ts`, `packages/db/src/seed/expected-gd3-abc.json`, `apps/api/test/inventory/*.test.ts`, `apps/api/test/invariants/inv5-kho.test.ts`.
- `docs/user/giai-doan-3-kho-mua-ban.md`.

---

### Task 1: Quyền GĐ3, cờ `view_cost` cho tài khoản kho, module `inventory`

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0043_quyen_gd3.sql`
- Modify: `packages/domain/src/permissions.ts`, `packages/domain/src/voucherTypes.ts` (union `module` thêm `'inventory'`), `apps/api/src/modules/core/settings.ts` (`stock_negative`), `apps/web/src/pages/Periods.tsx` (nhãn "Kho" đã có: kiểm tra)
- Test: `packages/domain/test/permissions.test.ts`, `apps/api/test/sensitiveFlags.test.ts`, `apps/api/test/settings.test.ts`

**Interfaces:**
- Quyền mới (`crud(res,name,group,extra)`): `item` (VTHH), `warehouse` (kho), `price_list` (bảng giá) nhóm "Kho"; `stock_voucher` (phiếu kho) với `post`; `costing` với `{ code: 'costing.run', name: 'Chạy tính giá vốn', group: 'Kho' }` và `costing.view`; `order` (báo giá, đơn hàng, hợp đồng) nhóm "Bán hàng"; `stocktake` (kiểm kê kho).
- `SENSITIVE_BY_SUBLEDGER` thêm `inventory: 'view_cost'`; `sensitiveDenial`/`flagsForAccounts` xử lý theo bảng này (đã chung với receivable/payable).
- `0043`: `create_tenant` định nghĩa lại từ **thân hiện hành** (`pg_get_functiondef`); `ketoan_vien` không có `costing.run`; công ty đã có: cấp quyền mới cho `admin`, `ketoan_truong`, `ketoan_vien` (trừ `costing.run`), `xem` (các `*.view`), tắt `trg_audit` của `role_permission` khi chèn (khuôn 0024). `tenant_setting`: khóa `stock_negative` mặc định `'forbid'`.
- `SETTINGS.stock_negative`: enum `forbid|warn|allow`.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('công ty mới: ketoan_vien có stock_voucher.create, không có costing.run; xem có item.view', async () => {});
it('người dùng không có view_cost: sổ chi tiết tài khoản 156 trả 403 FORBIDDEN nêu cờ view_cost', async () => {});
it('stock_negative mặc định forbid; giá trị ngoài enum bị 400', async () => {});
```

- [ ] **Step 2:** `pnpm -F @kt/domain test`, `pnpm -F @kt/api test -- test/sensitiveFlags.test.ts test/settings.test.ts` → FAIL.
- [ ] **Step 3:** Viết migration và sửa domain/settings.
- [ ] **Step 4:** PASS; `pnpm db:migrate` dev; `pnpm -F @kt/db test`, `pnpm -F @kt/api test` xanh.
- [ ] **Step 5:** Commit `feat(db): quyền GĐ3 và cờ view_cost cho tài khoản kho`.

### Task 2: Danh mục VTHH, nhóm hàng, ĐVT quy đổi, kho; Playwright và tài liệu cho Danh mục

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0044_vthh_kho.sql`, `apps/web/e2e/danh-muc.spec.ts`, `apps/web/e2e/vthh.spec.ts`, `docs/user/giai-doan-3-kho-mua-ban.md` (mục Danh mục)
- Modify: `apps/api/src/modules/master/catalogs.ts` (CatalogDef `item_group`, `item`, `warehouse`, `item_uom`), `apps/api/src/modules/master/crud.ts` (`UUID_TABLES` không đổi: bảng mới dùng khóa số), `packages/db/src/types.ts`, `apps/web/src/pages/Catalog.tsx`, `apps/web/src/router.tsx` (menu "Kho"), `apps/web/src/pages/Items.tsx`
- Test: `apps/api/test/inventory/items.test.ts`, `packages/db/test/inventory-schema.test.ts`

**Interfaces:**
- Bảng (id `bigint GENERATED ALWAYS AS IDENTITY`, `tenant_id`, `UNIQUE(tenant_id,id)`, `UNIQUE(tenant_id,code)`, `is_active`, `created_at`):
  - `item_group(code, name, parent_id)` cây.
  - `item(code, name, name_en, group_id, kind CHECK ('goods','material','finished','service','tool'), base_uom_id, tracking CHECK ('none','lot','lot_expiry') DEFAULT 'none', shelf_life_days int, default_tax_code text, min_qty numeric(20,4), max_qty numeric(20,4), location text, barcode text, spec_code text, inventory_account_id, revenue_account_id, cogs_account_id)`; `kind='service'` không có tồn (không sinh `stock_move`).
  - `item_uom(item_id, uom_id, factor numeric(20,6) CHECK (factor > 0), is_purchase, is_sale)` với dòng cơ sở `factor=1` tự có khi tạo hàng; `UNIQUE(tenant_id,item_id,uom_id)`.
  - `warehouse(code, name, inventory_account_id, costing_method CHECK (… IN ('avg_period','avg_moving','fifo','specific') OR NULL), kind CHECK ('normal','consignment_out','consignment_in') DEFAULT 'normal', branch_id)`; `consignment_out` = kho gửi bán (TK 157).
- `ALTER TABLE voucher_line ADD FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id)` và `(tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id)` (`NOT VALID` rồi `VALIDATE`); `voucher_item_line.item_id` cùng khóa ngoại.
- `catalogs.ts`: `lookup` `item_group_code`, `base_uom_code`, `inventory_account_code`; nhập Excel danh mục `item` có cột ĐVT quy đổi dạng `THUNG=24;HOP=6` (cột phụ `uom_conversions`), sai ĐVT báo dòng/cột tiếng Việt.
- Sửa `item.base_uom_id` khi đã có `stock_move` → 409 `ITEM_UOM_LOCKED`; đổi `tracking` khi đã có tồn → 409 `ITEM_TRACKING_LOCKED`; xóa hàng đã dùng → 409 `ITEM_IN_USE` (dùng `is_active=false`).
- `GET /api/items/:id/uoms`, `GET /api/lookups/items?q=` trả `{ id, code, name, baseUom, defaultTaxCode, tracking }` (cho `LookupSelect`).
- Màn hình `Items.tsx`: bảng VTHH, tab ĐVT quy đổi, lô/hạn dùng, kho mặc định, F4 tra cứu dùng chung; **việc GĐ2 để lại**: Playwright cho Danh mục (`danh-muc.spec.ts`: thêm đối tượng, ngưng dùng, lọc) và mục Danh mục trong tài liệu người dùng.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('tạo hàng tự sinh ĐVT cơ sở factor 1; thêm THUNG factor 24', async () => {});
it('sửa ĐVT cơ sở khi đã có stock_move → ITEM_UOM_LOCKED', async () => {});
it('dòng chứng từ không tham chiếu được hàng của công ty khác (khóa ngoại tổng hợp)', async () => {});
it('nhập Excel: dòng 3 ĐVT quy đổi sai báo "Dòng 3, cột ĐVT quy đổi"', async () => {});
```

- [ ] **Step 2:** `pnpm -F @kt/api test -- test/inventory/items.test.ts`, `pnpm -F @kt/db test` → FAIL.
- [ ] **Step 3:** Viết migration, catalog, màn hình.
- [ ] **Step 4:** PASS; `pnpm -F @kt/web e2e -- danh-muc.spec.ts vthh.spec.ts` xanh; kiểm thử bất biến khóa ngoại GĐ1.5 xanh.
- [ ] **Step 5:** Commit `feat(db): danh mục VTHH, nhóm hàng, ĐVT quy đổi và kho`.

### Task 3: Bảng giá bán/mua và chính sách giá

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0045_bang_gia.sql`, `apps/api/src/modules/inventory/priceLists.ts`, `apps/web/src/pages/PriceLists.tsx`, `apps/web/e2e/bang-gia.spec.ts`
- Modify: `apps/api/src/modules/inventory/routes.ts`
- Test: `apps/api/test/inventory/priceLists.test.ts`

**Interfaces:**
- `price_list(code, name, kind CHECK ('sale','purchase'), currency_code, party_group_id NULL, valid_from date, valid_to date NULL, priority int)`; `price_list_line(price_list_id, item_id, uom_id, min_qty numeric(20,4) DEFAULT 0, price numeric(20,4), discount_rate numeric(7,4) DEFAULT 0)`; `UNIQUE(tenant_id, price_list_id, item_id, uom_id, min_qty)`.
- `export async function resolvePrice(trx, a: { kind: 'sale'|'purchase'; itemId: number; uomId: number; partyId?: string; date: string; qty: string; currency: string }): Promise<{ price: string; discountRate: string; priceListId: number } | null>`: lọc bảng giá còn hiệu lực ngày `date` và đúng loại tiền, ưu tiên bảng giá gắn nhóm của đối tượng rồi `priority` cao, lấy dòng có `min_qty` lớn nhất ≤ `qty`; không thấy → `null`.
- `GET /api/price-lists/resolve?kind&itemCode&uomCode&partyCode&date&qty`; CRUD `/api/price-lists`; nhập Excel dòng giá.
- Giá chỉ là gợi ý điền sẵn vào dòng chứng từ (Task 12); không ràng buộc sổ cái.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('giá theo bậc số lượng: mua 10 lấy giá bậc min_qty 10', async () => {});
it('bảng giá nhóm khách ưu tiên hơn bảng chung; hết hiệu lực thì bỏ qua', async () => {});
it('khác loại tiền không áp dụng; không có bảng giá thì null', async () => {});
```

- [ ] **Step 2–5:** chạy FAIL → cài đặt → PASS (`pnpm -F @kt/api test -- test/inventory/priceLists.test.ts`, Playwright `bang-gia.spec.ts` thêm bảng giá và dòng giá) → commit `feat(api): bảng giá bán, mua theo nhóm khách, thời gian, bậc số lượng`.

### Task 4: Động cơ giá vốn thuần (4 phương pháp) ở `packages/domain`

Model: **opus** (logic kế toán khó).

**Files:**
- Create: `packages/domain/src/costing.ts`, `packages/domain/src/unit.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/costing.test.ts`, `packages/domain/test/unit.test.ts`

**Interfaces:**

```ts
export type CostMethod = 'avg_period' | 'avg_moving' | 'fifo' | 'specific';
export interface CostMove { id: string; seq: number; date: string; direction: 'in' | 'out'; qty: string; lot?: string;
  /** chiều in: giá trị đã biết (mua, nhập thành phẩm...) hoặc null khi lấy theo giá gán của chiều out (chuyển kho) */ value: string | null;
  /** chiều out đã gán giá cố định (cố định giá vốn) */ fixedUnitCost?: string }
export interface CostOpening { qty: string; value: string; lots?: { lot: string; qty: string; value: string }[] }
export interface CostResult { assignments: { moveId: string; unitCost: string; amount: string; lot?: string }[];
  layers: { moveId: string; remainingQty: string; remainingValue: string }[];   // lớp nhập còn lại sau tính
  endQty: string; endValue: string; errors: { moveId: string; code: 'COSTING_NEGATIVE_STOCK' | 'COSTING_LOT_MISSING'; detail: string }[] }
export function computeCosting(method: CostMethod, opening: CostOpening, moves: CostMove[], periodEnd: string): CostResult;
export function toBaseQty(qty: string, factor: string): string;       // qty × factor, 4 chữ số thập phân, decimal.js
export function fromBaseQty(base: string, factor: string): string;
```

Quy tắc: tiền `amount` làm tròn VND nửa lên (`ROUND_HALF_UP`); đơn giá `unitCost` 4 chữ số thập phân; **bình quân cuối kỳ**: đơn giá = (giá trị đầu + tổng giá trị nhập có giá trong kỳ) ÷ (lượng đầu + lượng nhập); mỗi dòng xuất = `round(qty × unitCost)`; dòng xuất làm tồn về 0 lấy phần còn lại (giá trị tồn − đã xuất) để tồn cuối bằng 0 giá trị; **bình quân tức thời**: đơn giá cập nhật sau mỗi nhập theo thứ tự `seq`; **FIFO**: tiêu thụ lớp nhập theo `seq`; **đích danh**: xuất bắt buộc có `lot`, giá = giá lô đó, thiếu lô → lỗi `COSTING_LOT_MISSING`. Xuất vượt tồn → `COSTING_NEGATIVE_STOCK` và gán theo giá bình quân gần nhất (cho phép tính tiếp khi cấu hình cho tồn âm). Chiều `in` có `value=null` (chuyển kho) phải được người gọi điền sau khi có giá gán của chiều `out` tương ứng (người gọi chạy `computeCosting` theo thứ tự phụ thuộc; xem Task 8).

- [ ] **Step 1: Kiểm thử thất bại.** Tình huống chuẩn (hàng X, kho W, tồn đầu 0): 02/01 nhập 100 giá 10 (1.000); 10/01 xuất 60; 15/01 nhập 50 giá 12 (600); 20/01 xuất 70. Kết quả tính tay:

```ts
const moves = [ /* in 100 @1000, out 60, in 50 @600, out 70 */ ];
it('bình quân cuối kỳ: đơn giá 10,6667; xuất 640 và 747; tồn 20 giá trị 213', () => {
  const r = computeCosting('avg_period', zero, moves, '2026-01-31');
  expect(r.assignments.map((a) => a.amount)).toEqual(['640', '747']); expect([r.endQty, r.endValue]).toEqual(['20', '213']);
});
it('bình quân tức thời: xuất 600 và 778; tồn 20 giá trị 222', () => {});
it('FIFO: xuất 600 và 760; tồn 20 giá trị 240 (lớp 12)', () => {});
it('đích danh (lô A 100@10, lô B 50@12; xuất 60 lô A, 70 = 30 lô A + 40 lô B): xuất 600 và 780; tồn 220', () => {});
it('đích danh thiếu lô → COSTING_LOT_MISSING', () => {});
it('xuất vượt tồn → COSTING_NEGATIVE_STOCK', () => {});
it('toBaseQty("12", "24") = "288"; fromBaseQty("288","24") = "12"; factor lẻ 0,5', () => {});
// fast-check
it('mọi phương pháp: tổng giá vốn xuất + giá trị tồn cuối = giá trị đầu + tổng giá trị nhập (không mất đồng nào)', () => {});
it('kết quả không phụ thuộc thứ tự mảng đầu vào (chỉ phụ thuộc seq)', () => {});
```

- [ ] **Step 2:** `pnpm -F @kt/domain test -- costing unit` → FAIL.
- [ ] **Step 3:** Cài đặt `computeCosting`, `toBaseQty`, `fromBaseQty` bằng `decimal.js` (`D()`); không `number`.
- [ ] **Step 4:** PASS (fast-check `numRuns` ≥ 200).
- [ ] **Step 5:** Commit `feat(domain): động cơ giá vốn bình quân cuối kỳ, tức thời, FIFO, đích danh`.

### Task 5: Lược đồ sổ kho: `stock_move`, lớp giá, gán giá, `costing_run`; sinh trong `post_voucher`

Model: sonnet (thủ tục SQL rà soát bằng opus).

**Files:**
- Create: `packages/db/migrations/0046_so_kho.sql`
- Modify: `packages/db/src/types.ts`
- Test: `packages/db/test/stock-schema.test.ts`

**Interfaces:**
- `ALTER TABLE voucher_item_line ADD COLUMN warehouse_id bigint, dest_warehouse_id bigint, uom_factor numeric(20,6) NOT NULL DEFAULT 1, base_quantity numeric(20,4), lot_no text, mfg_date date, expiry_date date, direction text CHECK (direction IN ('in','out')), debit_account_id bigint, credit_account_id bigint, unit_cost numeric(20,4), source_line_id bigint, fixed_cost boolean NOT NULL DEFAULT false`; khóa ngoại tổng hợp tới `warehouse`, `account`; `ALTER TABLE voucher ADD COLUMN day_order int NOT NULL DEFAULT 0, stock_kind text` (`stock_kind` ∈ `purchase|finished|return_in|transfer_in|processing_in|consign_in|other_in|sale|production|use|return_out|gift|destroy|processing_out|consign_out|other_out|transfer|assembly|disassembly|stocktake`).
- `stock_move(id bigint identity, tenant_id, voucher_id uuid, item_line_id bigint, item_id, warehouse_id, posting_date date, seq bigint, direction, quantity numeric(20,4) CHECK (quantity > 0), lot_no, expiry_date, transfer_id uuid NULL, reversal_of bigint NULL)`; `stock_cost_layer(id, tenant_id, move_id, item_id, warehouse_id, lot_no, kind CHECK ('receipt','adjustment'), posting_date, qty numeric(20,4), unit_cost numeric(20,4), value numeric(20,0), remaining_qty numeric(20,4), remaining_value numeric(20,0))`; `costing_run(id uuid, tenant_id, period_from date, period_to date, method text, warehouse_id NULL, item_id NULL, status CHECK ('done','failed'), voucher_ids uuid[], created_by, created_at, summary jsonb)`; `stock_cost_assignment(id, tenant_id, run_id, move_id, unit_cost, amount, lot_no, is_current boolean)` với chỉ mục `(tenant_id, move_id) WHERE is_current`.
- `fn_stock_moves_create(p_voucher uuid)` gọi trong `post_voucher` (lấy thân cuối, chèn một dòng `PERFORM`, ngay sau `fn_open_items_create`): với mỗi `voucher_item_line` có `warehouse_id` và hàng không phải `service`: khóa advisory theo `(item, warehouse)` (quy ước 6), kiểm tồn âm (quy ước 5, cấu hình `stock_negative`; lỗi `STOCK_NEGATIVE: hàng % kho % ngày % thiếu %`), chèn `stock_move`; chiều `in` chèn `stock_cost_layer` kind `receipt` (`value` = số tiền dòng nhập; chuyển kho `in` lấy sau từ giá gán, nên chèn giá tạm tính). Chuyển kho: hai move cùng `transfer_id`.
- `unpost_voucher`: xóa `stock_move` (và layer) của chứng từ; nếu có `stock_move` chiều `out` ghi sau ngày đó đã tiêu thụ lớp này (có `stock_cost_assignment` hiện hành lấy từ lớp) → `STOCK_CONSUMED: phiếu nhập đã được xuất ở chứng từ %`. `reverse_voucher`: sao chép `voucher_item_line` đảo `direction`, `source_line_id` trỏ dòng gốc, `reversal_of` ở move.
- `stock_move` bất biến: trigger chặn `UPDATE` (trừ qua `app.state_change`) và `DELETE` ngoài `unpost`.
- `fn_stock_estimate_cost(p_item bigint, p_wh bigint, p_date date) RETURNS numeric(20,4)` (quy ước 4).
- RLS/audit theo Global Constraints; không đổi định dạng `fn_voucher_canonical`.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('ghi sổ phiếu nhập sinh stock_move in và lớp giá; unpost xóa chúng', async () => {});
it('ghi sổ phiếu xuất quá tồn → STOCK_NEGATIVE; stock_negative=allow cho qua', async () => {});
it('ghi lùi phiếu xuất làm tồn ngày giữa âm bị từ chối nêu ngày thiếu', async () => {});
it('unpost phiếu nhập đã bị xuất → STOCK_CONSUMED', async () => {});
it('UPDATE stock_move trực tiếp bị chặn; app_user không thấy move công ty khác', async () => {});
it('fn_stock_estimate_cost: tồn 100 giá trị 1.000 rồi nhập 50 giá trị 600 → 10,6667', async () => {});
it('hai phiên ghi sổ xuất cùng hàng đồng thời không làm tồn âm', async () => {});
```

- [ ] **Step 2:** `pnpm -F @kt/db test -- stock-schema` → FAIL. **Step 3:** migration (thân hàm lấy bằng `pg_get_functiondef`). **Step 4:** `pnpm db:migrate`; `pnpm -F @kt/db test`, `pnpm -F @kt/api test`, `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts` xanh.
- [ ] **Step 5:** Commit `feat(db): sổ kho stock_move, lớp giá, gán giá, lần chạy giá vốn; sinh trong ghi sổ`.

### Task 6: Loại chứng từ kho và API Phiếu nhập, Phiếu xuất, Chuyển kho; màn hình

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0047_chung_tu_kho.sql`, `apps/api/src/modules/inventory/stockVouchers.ts`, `apps/api/src/modules/inventory/stockMoves.ts`, `apps/web/src/pages/StockVoucher.tsx`, `apps/web/e2e/phieu-kho.spec.ts`
- Modify: `packages/domain/src/voucherTypes.ts`, `packages/domain/src/stock.ts` (mới: `STOCK_KINDS`), `apps/api/src/modules/ledger/vouchers.service.ts` (`resolveLine` ánh xạ `itemCode`/`warehouseCode`; loại `inventory` đi qua `/api/stock-vouchers`), `apps/api/src/modules/ledger/vouchers.routes.ts`, `apps/web/src/router.tsx` (menu Kho)
- Test: `apps/api/test/inventory/stockVouchers.test.ts`

**Interfaces:**
- `0047`: `seed_voucher_types` định nghĩa lại từ thân hiện hành (0025) thêm PNK Phiếu nhập kho, PXK Phiếu xuất kho, CK Phiếu chuyển kho (module `inventory`, `is_system`), + `SELECT seed_voucher_types(id) FROM tenant` (tắt `trg_audit`). Loại `GV` thêm ở Task 8.
- `VOUCHER_TYPES`: `PNK {module:'inventory', manual:true, hasItems:true, stockDirection:'in', printForms:['01-VT']}`, `PXK {…'out', printForms:['02-VT']}`, `CK {…, printForms:['02-VT']}`; `VoucherTypeDef` thêm `stockDirection?: 'in'|'out'|'transfer'`; `STOCK_KINDS[type]` liệt kê `stock_kind` hợp lệ và TK đối ứng mặc định theo chế độ (nhập mua: Có 331; nhập thành phẩm: Có 154; nhập trả lại: Có 632 hoặc theo bán gốc...; xuất bán: Nợ 632; xuất sản xuất: Nợ 621; sử dụng: Nợ 641/642; biếu tặng: Nợ 641/642/811 theo cấu hình; hủy: Nợ 811 hoặc 1388; trả NCC: Nợ 331; gia công: Nợ 154; ký gửi: Nợ 157), mọi mã tài khoản có trong mẫu hệ thống tài khoản TT99/TT133 (kiểm thử đọc `loadCoaTemplate`).
- `POST/PUT /api/stock-vouchers` thân `{ voucherType: 'PNK'|'PXK'|'CK', stockKind, postingDate, partyCode?, personName?, warehouseCode, destWarehouseCode? (CK), description, items: [{ itemCode, uomCode, quantity, unitPrice?, lotNo?, mfgDate?, expiryDate?, debitAccountCode?, creditAccountCode?, warehouseCode? }] }`. Dịch vụ: quy đổi `base_quantity`; hàng `tracking='lot'|'lot_expiry'` bắt buộc `lotNo` (và `expiryDate`) → `LOT_REQUIRED`; chiều `in`: số tiền = `round(quantity × unitPrice)` (VND) (nhập kho trả lại/chuyển đến lấy giá theo Task 13/chuyển kho); dựng `voucher_line` ghi sổ cái: nhập Nợ `warehouse.inventory_account` (mặc định `item.inventory_account`) / Có TK đối ứng, mang `item_id`, `warehouse_id`; xuất: Nợ TK đối ứng / Có TK kho theo **giá tạm tính** `fn_stock_estimate_cost` (hàng chưa có tồn: 0 và cảnh báo `COST_UNKNOWN`); CK cùng TK kho: không có dòng sổ cái đối ứng ngoài hai dòng 156 đối ứng nhau (vẫn ghi để có `item_id`/`warehouse_id` theo kho), khác TK kho: Nợ TK kho đến / Có TK kho đi. Nhóm dòng theo (TK, hàng, kho).
- `GET /api/stock-vouchers/:id` trả `items` và `ledgerLines`, `warnings`. Ghi sổ, bỏ ghi sổ, đảo, hủy dùng route chung `/api/vouchers/:id/*`.
- Màn hình `StockVoucher.tsx`: tiêu đề theo `stock_kind` (chọn loại nhập/xuất ở nút "Thêm"), lưới `KeyboardGrid` mã hàng F4, ĐVT, số lượng, đơn giá, thành tiền, lô/HSD; hiện tồn khả dụng của dòng đang chọn (`GET /api/inventory/on-hand?itemCode&warehouseCode&date`).

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('Phiếu nhập mua 100 cái giá 10: Nợ 156 1.000 / Có 331 1.000, stock_move in 100 sau ghi sổ', async () => {});
it('nhập 12 THUNG (1 THUNG = 24 CHAI): base_quantity 288, thành tiền theo số lượng nhập', async () => {});
it('hàng theo lô thiếu lô → LOT_REQUIRED; hạn dùng trước ngày sản xuất → 400', async () => {});
it('Phiếu xuất bán 60 sau khi tồn 100 giá 10: Nợ 632 / Có 156 600 (giá tạm tính)', async () => {});
it('Phiếu chuyển kho giữa kho TK 156 và kho gửi bán TK 157: Nợ 157 / Có 156; stock_move out và in cùng transfer_id', async () => {});
it('TK đối ứng không có trong hệ thống tài khoản → ACCOUNT_NOT_FOUND 404', async () => {});
it('trộn hàng dịch vụ trong phiếu kho: dịch vụ không sinh stock_move', async () => {});
it('thiếu quyền stock_voucher.create → 403; loại PNK qua /api/vouchers → VOUCHER_TYPE_USE_STOCK 409', async () => {});
```

- [ ] **Step 2–5:** FAIL → cài đặt → `pnpm -F @kt/api test -- test/inventory/stockVouchers.test.ts` PASS, `pnpm -F @kt/web test`, Playwright `phieu-kho.spec.ts` (lập Phiếu nhập bằng bàn phím, F9, thấy tồn) → commit `feat(api): phiếu nhập, xuất, chuyển kho với ghi sổ cái giá tạm tính`.

### Task 7: Kiểm soát tồn, đảo/bỏ ghi sổ phiếu kho, thứ tự trong ngày

Model: sonnet.

**Files:**
- Modify: `apps/api/src/modules/inventory/stockMoves.ts`, `apps/api/src/modules/ledger/vouchers.service.ts` (thông báo lỗi `STOCK_*` → 409), `apps/web/src/pages/StockVoucher.tsx`
- Test: `apps/api/test/inventory/stockControl.test.ts`

**Interfaces:**
- Lỗi SQL `STOCK_NEGATIVE`, `STOCK_CONSUMED` ánh xạ 409 có chi tiết (`details: { itemCode, warehouseCode, date, shortBy }`), thông báo tiếng Việt: `Hàng % ở kho % thiếu % tại ngày %`.
- `warn`: ghi sổ thành công, phản hồi `warnings: [{ code: 'STOCK_NEGATIVE', … }]`, giao diện hiện cảnh báo.
- `PUT /api/vouchers/:id/day-order` `{ dayOrder }` cho chứng từ nháp kho; `GET /api/inventory/on-hand` trả tồn theo ngày (lượng cơ sở và theo ĐVT hỏi).
- Đảo phiếu nhập đã xuất một phần với `stock_negative=forbid`: đảo sinh phiếu xuất đảo, nếu làm tồn âm → 409 `STOCK_NEGATIVE` (người dùng phải đảo phiếu xuất trước).

- [ ] **Step 1: Kiểm thử thất bại:** các kịch bản Review Focus 2 và 4, cộng:

```ts
it('nhập sau trong ngày (day_order lớn) không dùng được cho xuất sớm hơn trong ngày', async () => {});
it('warn: ghi sổ xuất quá tồn thành công và trả warnings', async () => {});
it('on-hand theo ĐVT THUNG làm tròn 4 chữ số', async () => {});
```

- [ ] **Step 2–5:** FAIL → cài đặt → PASS (`pnpm -F @kt/api test -- test/inventory/stockControl.test.ts`) → commit `feat(api): kiểm soát tồn âm, tồn bị tiêu thụ và thứ tự chứng từ trong ngày`.

### Task 8: Tính giá vốn (`costing_run`) và chứng từ `GV`

Model: **opus**.

**Files:**
- Create: `packages/db/migrations/0048_gia_von.sql`, `apps/api/src/modules/inventory/costingRun.ts`, `apps/web/src/pages/CostingRun.tsx`, `apps/web/e2e/gia-von.spec.ts`
- Modify: `packages/domain/src/voucherTypes.ts` (GV), `apps/api/src/modules/ledger/vouchers.service.ts` (`SYSTEM_MSG`, `assertNotSystemGenerated`), `apps/api/src/modules/inventory/routes.ts`, `apps/api/src/modules/core/settings.ts`
- Test: `apps/api/test/inventory/costingRun.test.ts`

**Interfaces:**
- `0048`: loại `GV` Chứng từ giá vốn (module `inventory`, `is_system`, thêm vào `SYSTEM_VOUCHER_TYPES`); `unpost_voucher`/`discard_voucher`/`reverse` chặn `source_doc_type='costing_run'` bằng `VOUCHER_SYSTEM_GENERATED`; `costing_run` thêm `stale_from date` ở bảng `stock_cost_state(tenant_id, item_id, warehouse_id, stale_from date)` (đánh dấu cần tính lại).
- `export async function runCosting(trx, ctx: AuthCtx, input: { periodFrom: string; periodTo: string; warehouseCode?: string; itemCode?: string; method?: CostMethod }): Promise<{ runId: string; voucherIds: string[]; summary: { items: number; moves: number; delta: string; errors: CostResult['errors'] }; unchanged: boolean }>`. Khuôn `runOutflowAdjust` (`cash/fx.ts:48-141`): khóa (`pg_advisory_xact_lock` theo tenant+kỳ) → kiểm kỳ (`PERIOD_HARD_LOCKED`; khóa mềm cần quyền ghi lùi) → với mỗi `(item, warehouse)` trong phạm vi (sắp xếp tăng để khóa theo quy ước 6): đọc `CostOpening` từ lớp còn lại trước `periodFrom`, `CostMove[]` trong kỳ → `computeCosting(method của kho, …)`; chuyển kho: xử lý theo thứ tự phụ thuộc (kho đi trước kho đến), kho đến lấy `value` từ giá gán chiều out; vòng phụ thuộc quá 10 lượt → `COSTING_TRANSFER_CYCLE` → tính **chênh** mỗi chiều out = giá gán − số đã ghi sổ cái trên dòng (kể cả mọi `GV` hiện hành của kỳ trước) → so `keyOf` với `GV` lần trước (đọc qua `costing_run.voucher_ids`): không đổi → `unchanged: true`, không sinh gì; đổi → `reverseVoucher` mỗi `GV` cũ, đặt `is_current=false` các gán cũ, ghi gán mới, sinh một `GV` (`createSystemVoucher` `{type:'costing_run', id}`, ngày = `periodTo`; nếu kỳ đó đã khóa → ngày đầu của kỳ mở gần nhất sau đó) với dòng Nợ TK đối ứng của dòng xuất / Có TK kho (đảo dấu khi chênh âm; cùng khóa `(debit, credit, item, warehouse)` cộng dồn), `postVoucher`, cập nhật `voucher_ids`, `stock_cost_layer.remaining_*` theo `CostResult.layers`, xóa `stock_cost_state` trong phạm vi. Lỗi `CostResult.errors` nghiêm trọng (`COSTING_LOT_MISSING`) → hủy cả lần chạy.
- `unitCost` của dòng nhập thành phẩm (kind `finished`) chưa có giá: `unit_cost` nhập tay ở dòng; nếu để trống, lần chạy báo `COSTING_RECEIPT_PRICE_MISSING` (giá thành do GĐ6 cấp sau).
- `fixed_cost`: dòng xuất đặt `fixed_cost=true` có `unit_cost` → `fixedUnitCost` của `CostMove`, động cơ dùng đúng giá đó.
- Route `POST /api/inventory/costing-runs` (quyền `costing.run`), `GET /api/inventory/costing-runs` (nhật ký), `GET /api/inventory/costing-runs/:id` (gán giá chi tiết, `view_cost`), `GET /api/inventory/costing-status` (các cặp hàng–kho chưa cập nhật).
- Màn hình: chọn kỳ, kho, hàng, phương pháp (mặc định theo kho), "Tính giá vốn", bảng kết quả và nhật ký lần chạy; cảnh báo "Giá vốn chưa cập nhật từ ngày …".

- [ ] **Step 1: Kiểm thử thất bại** (dữ liệu Task 4, cả bốn phương pháp qua DB):

```ts
it.each([['avg_period', '1387', '213'], ['avg_moving', '1378', '222'], ['fifo', '1360', '240'], ['specific', '1380', '220']])(
  '%s: tổng giá vốn xuất %s, tồn cuối %s; 632 và 156 trên sổ cái khớp', async (method, cogs, endValue) => {
    // dựng nhập 100@10, xuất 60, nhập 50@12, xuất 70 (warehouse.costing_method = method), chạy runCosting kỳ 01/2026
    // sổ cái: số dư 632 = cogs; số dư 156 = endValue; Σ stock_cost_layer.remaining_value = endValue
  });
it('chạy lại không đổi dữ liệu: unchanged và không sinh chứng từ', async () => {});
it('ghi lùi phiếu nhập vào tháng đã tính: costing-status báo từ ngày đó; chạy lại đảo GV cũ, sinh GV mới; không dòng sổ cái nào bị sửa', async () => {});
it('kỳ khóa mềm không quyền ghi lùi: 409; kỳ khóa cứng: PERIOD_HARD_LOCKED', async () => {});
it('GV không bỏ ghi sổ/hủy qua route chung → VOUCHER_SYSTEM_GENERATED', async () => {});
it('chuyển kho giữa hai kho khác phương pháp: kho đến nhập theo giá gán của kho đi', async () => {});
it('cố định giá vốn: dòng xuất fixed_cost giữ đúng đơn giá', async () => {});
it('thiếu quyền costing.run → 403; không view_cost → chi tiết gán giá 403', async () => {});
```

- [ ] **Step 2–5:** FAIL → cài đặt → PASS (`pnpm -F @kt/api test -- test/inventory/costingRun.test.ts`; Playwright `gia-von.spec.ts`) → commit `feat(api): tính giá vốn bốn phương pháp, chứng từ giá vốn GV, chạy lại bằng đảo`.

### Task 9: Tồn kho đầu kỳ theo kho/lô, mở khóa tài khoản 15x, nhập Excel

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0049_ton_dau_kho.sql`, `apps/api/src/modules/inventory/openingStock.ts`, `apps/web/src/pages/OpeningStock.tsx`, `apps/web/e2e/ton-dau-ky.spec.ts`
- Modify: `apps/api/src/modules/ledger/openingBalance.ts` (`issuesOf` bỏ `SUBLEDGER_MODULE_REQUIRED` cho `inventory`, giữ cho `fixed_asset`; kiểm số dư 15x bằng tổng tồn đầu kỳ), `apps/web/src/pages/OpeningBalance.tsx`
- Test: `apps/api/test/inventory/openingStock.test.ts`, `apps/api/test/openingBalance.test.ts`

**Interfaces:**
- `opening_stock(tenant_id, fiscal_year, item_id, warehouse_id, lot_no text NOT NULL DEFAULT '', expiry_date, quantity numeric(20,4), value numeric(20,0))`, `UNIQUE(tenant_id, fiscal_year, item_id, warehouse_id, lot_no)`; khóa ngoại tổng hợp.
- `GET/PUT /api/opening-stock/:year` (thay toàn bộ nháp, như `replaceOpening`), `template.xlsx`, `import?mode=validate|commit` (cột: mã kho, mã hàng, ĐVT, số lượng, giá trị, lô, hạn dùng).
- `checkOpening` thêm so từng tài khoản kho: Σ `opening_stock.value` theo TK kho = số dư đầu kỳ nhập ở `opening_balance` của TK đó; lệch → `OPENING_STOCK_MISMATCH` nêu TK và chênh lệch.
- `postOpening` (chứng từ DK): với `opening_stock`, dòng sổ cái 15x mang `item_id`/`warehouse_id` (gộp theo hàng–kho; tổng theo TK vẫn = `opening_balance`), kèm `voucher_item_line` chiều `in` để `fn_stock_moves_create` sinh `stock_move` và lớp giá `receipt` ngày đầu năm; `unpostOpening` xóa `stock_move` (kiểm `STOCK_CONSUMED` như Task 5).
- Tồn đầu kỳ năm sau: chuyển từ số dư cuối năm khi mở năm mới là việc GĐ7 (nhóm C "chuyển số dư"); ghi vào sổ quyết định.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('số dư đầu kỳ 156 = 1.600.000 phải khớp tổng tồn đầu kỳ các kho; lệch → OPENING_STOCK_MISMATCH', async () => {});
it('ghi sổ DK sinh stock_move in ngày đầu năm và lớp giá; sổ cái 156 mang item_id/warehouse_id', async () => {});
it('nhập Excel tồn đầu theo lô: dòng sai báo dòng/cột, không chèn gì', async () => {});
it('xuất sau đó dùng được tồn đầu kỳ; bỏ ghi sổ DK khi đã xuất → STOCK_CONSUMED', async () => {});
it('tài khoản TSCĐ (211) vẫn bị khóa SUBLEDGER_MODULE_REQUIRED', async () => {});
```

- [ ] **Step 2–5:** FAIL → cài đặt → PASS → commit `feat(api): tồn kho đầu kỳ theo kho và lô, mở khóa tài khoản kho`.

### Task 10: Điều chỉnh khi ghi lùi, đối chiếu giá nhập thành phẩm thủ công, nhật ký

Model: sonnet.

**Files:**
- Modify: `apps/api/src/modules/inventory/costingRun.ts`, `apps/api/src/modules/inventory/stockMoves.ts`, `apps/web/src/pages/CostingRun.tsx`, `apps/web/src/pages/StockVoucher.tsx`
- Test: `apps/api/test/inventory/costingStale.test.ts`

**Interfaces:**
- `fn_stock_moves_create`/`unpost`/`reverse` ghi `stock_cost_state.stale_from = min(stale_from, posting_date)` cho cặp hàng–kho bị chạm, chỉ khi đã có `costing_run` `done` phủ ngày đó.
- `PUT /api/stock-vouchers/:id/receipt-price` (quyền `costing.run`): sửa `unit_cost` dòng nhập thành phẩm của phiếu **đã ghi sổ** bằng lớp `adjustment` (không sửa dòng đã ghi): chèn `stock_cost_layer` kind `adjustment` với `value` chênh và đánh dấu stale; sổ cái được điều chỉnh bằng `GV` ở lần chạy sau (dòng Nợ 155/Có 154 theo `credit_account` của dòng nhập).
- Biểu ngữ ở màn hình giá vốn và phiếu kho: "Giá vốn của hàng X kho Y chưa cập nhật từ ngày …".

- [ ] **Step 1: Kiểm thử thất bại:** Review Focus 1 đầy đủ; sửa giá nhập thành phẩm sinh lớp `adjustment` và `GV` ở lần chạy sau, `remaining_value` vẫn khớp 155.
- [ ] **Step 2–5:** FAIL → cài đặt → PASS (`pnpm -F @kt/api test -- test/inventory/costingStale.test.ts`) → commit `feat(api): đánh dấu giá vốn chưa cập nhật khi ghi lùi, điều chỉnh giá nhập thành phẩm`.

### Task 11: Mua hàng hóa qua kho, hàng về trước hóa đơn về sau và ngược lại

Model: sonnet (quy tắc kế toán rà soát bằng opus).

**Files:**
- Create: `packages/db/migrations/0050_mua_ban_hang.sql`, `apps/web/e2e/mua-hang.spec.ts`
- Modify: `apps/api/src/modules/invoices/service.ts` (`invoiceItemInput` thêm `itemCode?`, `warehouseCode?`, `lotNo?`, `mfgDate?`, `expiryDate?`; loại mới đi qua `buildInvoice`), `packages/domain/src/invoiceLedger.ts` (`buildInvoiceLedgerDetail` nhận `inventoryLine?` để dòng hàng đi vào Nợ TK kho kèm `item_id`/`warehouse_id`), `packages/domain/src/voucherTypes.ts` (MH, TLM), `apps/web/src/pages/InvoiceForm.tsx`
- Test: `apps/api/test/inventory/purchase.test.ts`

**Interfaces:**
- `0050`: loại `MH` Mua hàng hóa (module `arap`, `hasItems`, `invoiceDirection:'purchase'`, `stockDirection:'in'`, `printForms:['01-VT']`) và `TLM` Trả lại, giảm giá hàng mua (`refund:true`, `stockDirection:'out'`); `seed_voucher_types` định nghĩa lại từ thân cuối (0047); `voucher_item_line.receipt_voucher_id uuid NULL` (liên kết phiếu nhập trước), `voucher.receipt_state text` (`'with_invoice'|'goods_first'|'invoice_first'`).
- `POST /api/invoices` `voucherType:'MH'`, `stockMode: 'through_stock' | 'goods_first' | 'invoice_first'`:
  - `through_stock`: Nợ TK kho (hàng), Nợ 1331 (thuế), Có 331/111/112; chiều `in` sinh `stock_move` ở kho của dòng; hóa đơn kê khai như HDM (`voucher_invoice`).
  - `goods_first` = phiếu nhập `PNK` kind `purchase` đã ghi (Nợ 156 / Có 331 giá tạm tính); hóa đơn về sau: `MH` với `receiptVoucherIds[]`: dòng liên kết không sinh `stock_move` mới; ghi Nợ 1331, chênh giá `(giá hóa đơn − giá tạm)` vào Nợ/Có TK kho kèm lớp `adjustment` (Task 5), Có 331 (số trên hóa đơn − số tạm trừ).
  - `invoice_first`: hóa đơn ghi Nợ 151 (hàng mua đang đi đường)/Nợ 1331/Có 331, không `stock_move`; phiếu nhập sau (`PNK` với `sourceInvoiceIds[]`) ghi Nợ 156/Có 151 đúng số hóa đơn.
- `TLM`: trả lại NCC xuất kho theo **giá nhập gốc** của dòng liên kết (`source_line_id`): Nợ 331/Có 156/Có 1331; giảm giá (không trả hàng): giảm giá vốn tồn bằng lớp `adjustment` âm.
- Chiết khấu thương mại: dùng `discountRate`/`discountCurrency` sẵn có, giá nhập kho = đơn giá sau chiết khấu.
- Cảnh báo giá mua cao hơn giá bảng giá mua ≥ ngưỡng (`tenant_setting purchase_price_warn_pct`, mặc định 20): `warnings`.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('MH through_stock 100 cái giá 10, thuế 10%: Nợ 156 1.000, Nợ 1331 100, Có 331 1.100; stock_move in 100; hóa đơn vào bảng kê mua', async () => {});
it('hàng về trước: PNK giá tạm 10 → MH giá thực 10,5 liên kết: lớp adjustment +50, 156 = 1.050, không stock_move thêm', async () => {});
it('hóa đơn về trước: Nợ 151; PNK sau chuyển 151 → 156, tồn tăng ngày nhập', async () => {});
it('trả lại 20 cái: xuất kho theo giá nhập gốc 10, Nợ 331 / Có 156 200 / Có 1331 20', async () => {});
it('chiết khấu thương mại 5% làm giá nhập kho 9,5', async () => {});
it('MH đảo: stock_move đảo và công nợ 331 đảo; nếu hàng đã xuất → STOCK_NEGATIVE/STOCK_CONSUMED', async () => {});
```

- [ ] **Step 2–5:** FAIL → cài đặt → PASS (`test/inventory/purchase.test.ts`, `test/invoices.test.ts` không hồi quy; Playwright `mua-hang.spec.ts`) → commit `feat(api): mua hàng hóa qua kho, hàng về trước và hóa đơn về trước`.

### Task 12: Chi phí mua hàng, nhập khẩu (thuế NK/TTĐB/GTGT hàng nhập) và phân bổ

Model: **opus**.

**Files:**
- Create: `packages/domain/src/landedCost.ts`, `apps/api/src/modules/inventory/landedCost.ts`
- Modify: `packages/db/migrations/0050_mua_ban_hang.sql` (thêm bảng, cùng migration nếu chưa đẩy; ngược lại `0050b`), `apps/api/src/modules/inventory/routes.ts`, `apps/web/src/pages/InvoiceForm.tsx`
- Test: `packages/domain/test/landedCost.test.ts`, `apps/api/test/inventory/landedCost.test.ts`

**Interfaces:**
- Domain: `export function allocateLandedCost(costs: string[], lines: { id: string; qty: string; value: string }[], basis: 'value' | 'quantity'): Record<string, string>`: phân bổ tổng chi phí theo tỷ lệ, làm tròn VND, phần dư dồn vào dòng có tỷ trọng lớn nhất; tổng phân bổ luôn đúng bằng tổng chi phí.
- `landed_cost_alloc(tenant_id, voucher_id (chứng từ chi phí), receipt_line_id, amount numeric(20,0), basis)`; loại chứng từ `CPM` Chi phí mua hàng (module `arap`, `hasItems:false`): thân `{ costLines: [{ accountCode: '1562'|'331'..., amount }], receiptVoucherIds[], basis }` ghi Nợ TK kho (hoặc 1562 nếu hệ thống tài khoản có)/Có TK thanh toán, sinh lớp `adjustment` cho từng dòng nhập theo phân bổ (tăng giá nhập, đánh dấu stale).
- Nhập khẩu: dòng MH `importMode: true` có `importTax` (thuế NK), `specialConsumptionTax` (TTĐB), `vatImport`: giá nhập kho = giá + thuế NK + TTĐB (+ chi phí mua phân bổ); thuế NK/TTĐB Có 3333/3332; thuế GTGT hàng nhập Nợ 1331/Có 33312. Tham số thuế suất là dữ liệu nhập tay trên dòng (không bịa biểu thuế).
- Cấm phân bổ vào phiếu nhập đã bị xuất hết: vẫn cho (lớp `adjustment` đẩy sang `GV` ở lần chạy sau).

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('allocateLandedCost: 100 phân bổ theo giá trị 3 dòng 1.000/2.000/3.000 → 17, 33, 50 và tổng 100', () => {});
it('phân bổ theo số lượng; chi phí 1 đồng cho 3 dòng vẫn tổng đúng 1 (fast-check: Σ = tổng)', () => {});
// api
it('CPM phân bổ cước 600.000 theo giá trị: giá nhập kho các dòng tăng đúng; 156 sổ cái = Σ remaining_value', async () => {});
it('nhập khẩu: giá nhập = giá + thuế NK + TTĐB; 3333, 33312, 1331 đúng', async () => {});
```

- [ ] **Step 2–5:** FAIL → cài đặt → PASS → commit `feat(api): chi phí mua hàng và nhập khẩu phân bổ vào giá nhập kho`.

### Task 13: Bán hàng hóa kiêm phiếu xuất, hóa đơn, trả lại, giảm giá, gửi bán

Model: sonnet (quy tắc kế toán rà soát bằng opus).

**Files:**
- Create: `apps/web/e2e/ban-hang.spec.ts`
- Modify: `packages/db/migrations/0050_mua_ban_hang.sql` (BH, TLB), `apps/api/src/modules/invoices/service.ts`, `packages/domain/src/invoiceLedger.ts`, `packages/domain/src/voucherTypes.ts`, `apps/web/src/pages/InvoiceForm.tsx`
- Test: `apps/api/test/inventory/sales.test.ts`

**Interfaces:**
- Loại `BH` Bán hàng hóa kiêm phiếu xuất (module `arap`, `hasItems`, `invoiceDirection:'sale'`, `stockDirection:'out'`, `printForms:['02-VT']`) và `TLB` Hàng bán bị trả lại (`refund:true`, `stockDirection:'in'`); nhiều hóa đơn từ một chứng từ và bảng kê kèm hóa đơn dùng sẵn `voucher_invoice` GĐ2.
- `POST /api/invoices` `voucherType:'BH'`: mỗi dòng `itemCode`+`warehouseCode`; sổ cái: Nợ 131/111/112 (thu tiền ngay), Có 511x, Có 33311 (động cơ thuế sẵn có); **và** dòng giá vốn tạm: Nợ 632 (hoặc `cogs_account` của hàng) / Có TK kho theo `fn_stock_estimate_cost`; `stock_move` out; hàng `service` chỉ ghi doanh thu.
- `TLB`: bắt buộc `sourceLineId` (dòng `BH` gốc); nhập kho theo **giá vốn thực gán của dòng gốc** (`stock_cost_assignment` hiện hành, nếu chưa chạy giá vốn thì giá tạm của dòng gốc): Nợ TK kho / Có 632, và Nợ 5212 hoặc 511 / Có 131 (giảm giá, trả lại theo mẫu `GGB` GĐ2); số lượng trả không vượt số bán còn lại → `RETURN_EXCEEDS_SALE`.
- Gửi bán/đại lý: `CK` sang kho `kind='consignment_out'` (TK 157); khi bên nhận bán, `BH` có `warehouseCode` là kho gửi bán: giá vốn Nợ 632/Có 157. Kho `consignment_in` (nhận ký gửi) không ghi sổ cái, chỉ số lượng (tài khoản ngoài bảng 002 không được dựng trong GĐ3; ghi hạn chế vào quyết định).
- Cảnh báo `warnings`: giá bán thấp hơn giá vốn tạm (`SALE_BELOW_COST`, chỉ người có `view_cost` thấy giá vốn; người khác thấy cảnh báo không kèm số); giá khác bảng giá ≥ ngưỡng.
- Xuất khẩu: `exportMode: true` ép thuế 0% theo `tax_code` có sẵn; không thêm biểu thuế mới.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('BH 60 cái giá 20 thuế 10%, tồn 100@10: Nợ 131 1.320, Có 511 1.200, Có 33311 120; Nợ 632 / Có 156 600', async () => {});
it('bán 12 THUNG khi 1 THUNG = 24 CHAI: stock_move out 288 chai', async () => {});
it('TLB 5 chai trả lại: nhập kho theo giá vốn của dòng gốc; số trả > số bán → RETURN_EXCEEDS_SALE', async () => {});
it('chuyển 157 rồi bán từ kho gửi bán: Nợ 632 / Có 157', async () => {});
it('SALE_BELOW_COST: có view_cost thấy số; không có thì chỉ thấy cảnh báo', async () => {});
it('bán dịch vụ không sinh stock_move', async () => {});
it('đảo BH: stock_move đảo, giá vốn đảo, 131 đảo', async () => {});
```

- [ ] **Step 2–5:** FAIL → cài đặt → PASS (`test/inventory/sales.test.ts`, `test/invoices.test.ts`; Playwright `ban-hang.spec.ts`) → commit `feat(api): bán hàng hóa kiêm phiếu xuất, hàng bán trả lại, gửi bán`.

### Task 14: Báo giá, đơn đặt hàng, đơn mua, hợp đồng và chuyển thành chứng từ

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0051_don_hang.sql`, `apps/api/src/modules/orders/service.ts`, `apps/api/src/modules/orders/routes.ts`, `apps/web/src/pages/Orders.tsx`, `apps/web/e2e/don-hang.spec.ts`
- Test: `apps/api/test/orders.test.ts`

**Interfaces:**
- `contract(code, name, party_id, kind CHECK ('sale','purchase'), signed_date, valid_to, value numeric(20,0), currency_code, status)` (khóa ngoại tổng hợp từ `voucher_line.contract_id` nếu chưa có: `ALTER … ADD FOREIGN KEY`); `doc_order(id uuid, tenant_id, kind CHECK ('quote','sale_order','purchase_order'), doc_no, doc_date, party_id, contract_id NULL, currency_code, fx_rate, status CHECK ('draft','confirmed','partial','done','cancelled'), note)`; `doc_order_line(order_id, line_no, item_id, uom_id, quantity, unit_price numeric(20,4), discount_rate, tax_code, delivered_qty numeric(20,4) DEFAULT 0)`.
- Không ghi sổ cái, không `stock_move`; đánh số riêng `doc_order_counter` theo loại/năm (khuôn `voucher_counter`).
- `POST /api/orders/:id/convert` `{ to: 'BH'|'MH', lines?: [{ lineNo, quantity }] }` sinh chứng từ nháp (gọi `buildInvoice` ở chế độ nháp), cộng `delivered_qty`, đặt `partial`/`done`; báo giá → đơn bán `kind` chuyển. Điền giá từ `resolvePrice` (Task 3) khi tạo dòng.
- Bỏ ghi sổ/hủy chứng từ sinh từ đơn trả `delivered_qty` về (trigger ở dịch vụ, không ở SQL).

- [ ] **Step 1: Kiểm thử thất bại:** báo giá → đơn bán → chuyển thành `BH` một phần 40/100 rồi phần còn lại; chuyển vượt số còn lại → 409 `ORDER_QTY_EXCEEDED`; đơn đã hủy không chuyển; đơn công ty khác → 404.
- [ ] **Step 2–5:** FAIL → cài đặt → PASS → commit `feat(api): báo giá, đơn bán, đơn mua, hợp đồng và chuyển thành chứng từ`.

### Task 15: Lắp ráp, tháo dỡ

Model: sonnet.

**Files:**
- Modify: `packages/db/migrations/0047_chung_tu_kho.sql` (loại `LR`; nếu đã đẩy: migration bổ sung `0050b`), `apps/api/src/modules/inventory/stockVouchers.ts`, `packages/domain/src/stock.ts`
- Test: `apps/api/test/inventory/assembly.test.ts`

**Interfaces:**
- `LR` Lắp ráp/tháo dỡ (module `inventory`): thân `{ mode: 'assembly'|'disassembly', warehouseCode, outputs: [{ itemCode, quantity }], components: [{ itemCode, quantity, uomCode }] }`. Lắp ráp: xuất linh kiện (chiều out, giá tạm) và nhập thành phẩm (chiều in); giá nhập thành phẩm = tổng giá trị linh kiện xuất theo **giá gán thật** (lần chạy giá vốn, thứ tự phụ thuộc như chuyển kho) cộng chi phí nhập tay `extraCost` phân bổ theo giá trị; trước khi chạy giá vốn thì lấy giá tạm. Sổ cái: Nợ TK kho thành phẩm / Có TK kho linh kiện. Tháo dỡ ngược lại, phân bổ giá linh kiện thu hồi theo tỷ lệ nhập tay `costRatio`, tổng = giá trị hàng tháo.
- Quan hệ phụ thuộc vào `runCosting` (Task 8): nhóm `assembly_id` được xử lý như chuyển kho (out trước in); vòng phụ thuộc → `COSTING_TRANSFER_CYCLE`.

- [ ] **Step 1: Kiểm thử thất bại:** lắp 1 bộ từ 2 linh kiện A@10 và 1 B@5 (+ chi phí 5): nhập bộ 30; sau chạy giá vốn bình quân cuối kỳ giá nhập bộ đổi theo giá gán của linh kiện, `GV` điều chỉnh 155/156; tháo dỡ phân bổ 100% giá trị; thiếu linh kiện → `STOCK_NEGATIVE`.
- [ ] **Step 2–5:** FAIL → cài đặt → PASS → commit `feat(api): lắp ráp và tháo dỡ`.

### Task 16: Kiểm kê kho và chứng từ điều chỉnh

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0052_kiem_ke_kho.sql`, `apps/api/src/modules/inventory/stocktake.ts`, `apps/web/src/pages/Stocktake.tsx`, `apps/web/e2e/kiem-ke-kho.spec.ts`
- Test: `apps/api/test/inventory/stocktake.test.ts`

**Interfaces:**
- `stocktake(id uuid, tenant_id, doc_date, warehouse_id, status 'draft'|'adjusted'|'cancelled', note, adjust_voucher_ids uuid[])`, `stocktake_line(stocktake_id, item_id, lot_no, book_qty numeric(20,4), counted_qty numeric(20,4), diff_qty numeric(20,4) generated, reason text)`.
- `POST /api/stocktakes` điền `book_qty` từ tồn tại `doc_date` (lô); `PUT` nhập `counted_qty`; `POST /:id/adjust` sinh `PNK` (kind `other_in`, thừa; Nợ kho/Có 3381 hoặc 711 theo `reason`) và `PXK` (kind `other_out`, thiếu; Nợ 1381 hoặc 632/811 theo `reason`) với mọi giá trị lấy theo giá tạm tính; không chạy được hai lần (409 `STOCKTAKE_ADJUSTED`).
- Biên bản kiểm kê in được (`GET /api/stocktakes/:id/print` theo khuôn cash-count; mẫu 05-VT chỉ in "Mẫu số" khi đã đối chiếu văn bản gốc, chưa thì in không có số mẫu).

- [ ] **Step 1: Kiểm thử thất bại:** tồn sổ 100 đếm 97 sinh PXK 3; đếm 102 sinh PNK 2; hai lần `adjust` → 409; kho khóa kỳ → 409 kỳ khóa.
- [ ] **Step 2–5:** FAIL → cài đặt → PASS → commit `feat(api): kiểm kê kho và điều chỉnh chênh lệch`.

### Task 17: Báo cáo kho: NXT, thẻ kho S12-DN, sổ chi tiết S10-DN, bảng kê, hạn dùng, đối chiếu

Model: sonnet.

**Files:**
- Create: `apps/api/src/modules/inventory/reports.ts`, `apps/api/src/modules/reporting/print/stockForms.ts`, `apps/web/src/pages/StockReports.tsx`, `apps/web/e2e/bao-cao-kho.spec.ts`
- Modify: `apps/api/src/modules/reporting/routes.ts` (`respondReport`), `apps/api/src/modules/reporting/print/forms.ts` (mục S10-DN, S12-DN sau khi đối chiếu văn bản gốc)
- Test: `apps/api/test/inventory/stockReports.test.ts`

**Interfaces:**
- `GET /api/reports/stock-summary?from&to&warehouse?&item?&group?&detail=lot|none&format=json|html|pdf|xlsx` (Bảng tổng hợp Nhập – Xuất – Tồn: đầu kỳ, nhập, xuất, cuối kỳ, lượng và giá trị); `/stock-card` (Thẻ kho S12-DN: ngày, số chứng từ, diễn giải, nhập, xuất, tồn lượng — **không có giá trị**, nên không cần `view_cost`); `/stock-ledger` (Sổ chi tiết vật liệu, dụng cụ, sản phẩm, hàng hóa S10-DN: có đơn giá, thành tiền → `view_cost`); `/stock-register?direction=in|out` (bảng kê nhập/xuất); `/stock-expiry?asOf&days` (hàng sắp hết hạn theo lô); `/stock-reconcile?asOf` (đối chiếu kế toán – thủ kho: số lượng thẻ kho vs sổ chi tiết; giá trị Σ lớp vs sổ cái theo TK kho; chênh lệch nêu hàng/kho).
- Đọc trong `READ_SNAPSHOT`; số liệu từ `stock_move` + `stock_cost_assignment` hiện hành (chưa chạy giá vốn dùng giá tạm: cờ `provisional: true` ở từng dòng và biểu ngữ); phân trang tối đa `MAX_PRINT_ROWS`; in theo `ReportDoc` có `formNo` S10-DN/S12-DN **chỉ khi** đã đối chiếu tiêu đề, kích thước cột, chữ ký trong văn bản gốc của chế độ (TT99/TT133 phụ lục sổ kế toán).
- Sổ xuyên kỳ tính đầu kỳ từ `stock_move` đến trước `from` cộng `opening_stock` (không quét lại toàn bộ lịch sử khi có thể dùng lớp: dùng chỉ mục `(tenant_id, item_id, warehouse_id, posting_date)`).

- [ ] **Step 1: Kiểm thử thất bại:** dữ liệu Task 4 sau `fifo`: NXT tháng 1 hàng X: đầu 0/0, nhập 150 / 1.600, xuất 130 / 1.360, cuối 20 / 240; thẻ kho số dư chạy 100, 40, 90, 20; sổ chi tiết có đơn giá; thiếu `view_cost` → 403 ở `/stock-ledger` và NXT có giá trị, thẻ kho vẫn xem được; `/stock-reconcile` báo 0 chênh sau chạy giá vốn và chênh khi chưa chạy; PDF/XLSX tạo được.
- [ ] **Step 2–5:** FAIL → cài đặt → PASS (`test/inventory/stockReports.test.ts`, Playwright `bao-cao-kho.spec.ts`) → commit `feat(api): báo cáo kho NXT, thẻ kho, sổ chi tiết, hạn dùng, đối chiếu`.

### Task 18: Báo cáo bán hàng và mua hàng; lãi gộp

Model: sonnet.

**Files:**
- Create: `apps/api/src/modules/inventory/tradeReports.ts`, `apps/web/src/pages/SalesPurchaseReports.tsx`, `apps/web/e2e/bao-cao-ban-hang.spec.ts`
- Test: `apps/api/test/inventory/tradeReports.test.ts`

**Interfaces:**
- `GET /api/reports/sales?from&to&groupBy=party|item|salesperson|item_group|month&format=…` (doanh số, chiết khấu, trả lại, doanh thu thuần; lãi gộp = doanh thu thuần − giá vốn gán hiện hành: cột giá vốn/lãi gộp yêu cầu `view_cost`, thiếu thì trả báo cáo không hai cột đó và `costHidden: true`); `GET /api/reports/purchases?…groupBy=party|item|month` (giá trị mua, chiết khấu, trả lại, thuế).
- Nhân viên bán hàng lấy từ `voucher.employee_id` (cột có sẵn nếu có; nếu `voucher_line.employee_id` chỉ có ở dòng: dùng dòng doanh thu).

- [ ] **Step 1: Kiểm thử thất bại:** BH 60 cái giá 20 giá vốn 600 → doanh thu 1.200, giá vốn 600, lãi gộp 600; trả lại 5 cái trừ cả doanh thu và giá vốn; không `view_cost` → không có cột lãi gộp.
- [ ] **Step 2–5:** FAIL → cài đặt → PASS → commit `feat(api): báo cáo bán hàng, mua hàng và lãi gộp`.

### Task 19: In Phiếu nhập kho 01-VT, Phiếu xuất kho 02-VT

Model: sonnet.

**Files:**
- Create: `apps/api/src/modules/reporting/print/stockVoucherHtml.ts`
- Modify: `apps/api/src/modules/reporting/print/forms.ts` (FORMS `01-VT`, `02-VT`), `apps/api/src/modules/ledger/vouchers.routes.ts` (nhánh in), `apps/web/src/pages/StockVoucher.tsx` (nút In)
- Test: `apps/api/test/inventory/stockVoucherPrint.test.ts`

**Interfaces:**
- Đọc `~/legal-docs/tt99-2025/tt99-full.txt` và `~/legal-docs/tt133-2016/tt133-full.txt` tìm mẫu 01-VT, 02-VT: ghi vào sổ quyết định số trang, tiêu đề "Mẫu số … Ban hành theo …", các cột và chữ ký; chế độ nào không đối chiếu được thì `formNoFor` trả `null` và in không có dòng "Mẫu số" (đúng quy tắc không bịa).
- `GET /api/vouchers/:id/print?form=01-VT|02-VT` cho PNK/PXK/CK (CK dùng 02-VT hoặc mẫu chuyển kho nội bộ nếu văn bản có); nội dung: kho, số, ngày, người giao/nhận, bảng hàng (mã, tên, ĐVT, yêu cầu/thực nhập-xuất, đơn giá, thành tiền; đơn giá/thành tiền ẩn khi thiếu `view_cost`), tổng bằng chữ, chữ ký.

- [ ] **Step 1: Kiểm thử thất bại:** HTML có tiêu đề đúng chế độ, tổng bằng chữ đúng (dùng helper số đọc tiếng Việt có sẵn), người không có `view_cost` nhận phiếu xuất không đơn giá; PDF tạo được.
- [ ] **Step 2–5:** FAIL → cài đặt → PASS → commit `feat(api): in phiếu nhập kho 01-VT và phiếu xuất kho 02-VT`.

### Task 20: Soát lỗi kho và đối chiếu sổ cái

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0053_soat_loi_gd3.sql`
- Modify: `apps/api/src/modules/tools/dataCheck.ts` (nếu cần cờ), `apps/web/src/pages/DataCheck.tsx` (nhãn)
- Test: `apps/api/test/inventory/dataCheckGd3.test.ts`

**Interfaces:**
- `seed_data_check_rules` định nghĩa lại từ thân hiện hành (0038), thêm cột `flags text[]` như GĐ2 và chèn bù công ty đã có (tắt audit): `KHO_XUAT_CHUA_GIA_VON` (chứng từ xuất trong khoảng có `stock_cost_state.stale_from` ≤ ngày, cờ `view_cost`), `KHO_LECH_SO_CAI` (Σ `stock_cost_layer.remaining_value` theo TK kho ≠ số dư sổ cái tại cuối khoảng), `KHO_SAI_DVT` (dòng có `uom_id` không thuộc `item_uom` của hàng hoặc `base_quantity` ≠ `quantity × uom_factor`), `KHO_TON_AM` (tồn lũy kế âm tại một ngày trong khoảng), `KHO_HANG_THIEU_KHO` (dòng sổ cái TK kho thiếu `warehouse_id`). SQL trả `(voucher_id uuid, ref text, detail text)`, `$1` từ, `$2` đến.

- [ ] **Step 1: Kiểm thử thất bại:** mỗi quy tắc một kịch bản tạo lỗi bằng `app.withOverride`/SQL (cho tình huống chỉ có thể lọt qua dữ liệu cũ), quy tắc chạy ra đúng chứng từ; người thiếu `view_cost` không thấy `KHO_XUAT_CHUA_GIA_VON`.
- [ ] **Step 2–5:** FAIL → cài đặt → PASS → commit `feat(db): quy tắc soát lỗi kho`.

### Task 21: Kỳ hạn ngắn/dài hạn và mã luồng tiền B03 (việc GĐ2 để lại)

Model: **opus** (động cơ báo cáo).

**Files:**
- Create: `packages/db/migrations/0054_ky_han_luong_tien.sql`
- Modify: `apps/api/src/modules/reporting/financial.ts`, `packages/coa-data/data/reports/tt99/*.json`, `packages/coa-data/data/reports/status.json` (cập nhật `note`), `packages/domain/src/reportFormula.ts` (nếu có công thức), `apps/api/src/modules/ledger/vouchers.service.ts` (`cashFlowCode` ở dòng), `apps/web/src/pages/VoucherForm.tsx`
- Test: `apps/api/test/financial.test.ts`, `apps/api/test/inventory/b03CashFlow.test.ts`

**Interfaces:**
- **Bước 0 (đọc trước khi sửa):** mở `financial.ts` và dữ liệu báo cáo TT99 B01 để xác định chỉ tiêu dài hạn đang bằng 0 (ghi trong `note` của `status.json`) và cơ chế công thức `TAG`/`!` (như `515!REVAL`); ghi vào sổ quyết định danh sách chỉ tiêu cần kỳ hạn (phải thu, phải trả, vay ngắn/dài hạn).
- Kỳ hạn: tài khoản công nợ dùng `open_item.due_date` (GĐ2): phần dư có `due_date > ngày lập báo cáo + 12 tháng` là dài hạn; khoản vay/tiền gửi có kỳ hạn dùng cột mới `voucher_line.maturity_date date NULL` (nhập ở dòng, mặc định NULL = ngắn hạn); báo cáo cộng dài hạn vào dòng `*_DAI_HAN` theo công thức thẻ mới `LT(<tài khoản>)`.
- B03 (phương pháp trực tiếp) theo mã luồng tiền: cột `voucher_line.cash_flow_code text NULL` (danh mục mã theo Phụ lục IV TT99: chỉ nhập mã đã có trong `packages/coa-data` bản B03 sau đối chiếu văn bản gốc); dòng tiền không có mã rơi về phân loại theo cặp đối ứng như cũ (tương thích); thêm cảnh báo "chưa có mã luồng tiền" trong soát lỗi (cùng migration, cờ `view_receivable` không cần).
- Không đổi định dạng `fn_voucher_canonical` (cột mới không vào băm; ghi quyết định lý do: hai cột là siêu dữ liệu trình bày, không phải số tiền).

- [ ] **Step 1: Kiểm thử thất bại:** khoản phải thu ngắn hạn và dài hạn tách đúng dòng B01 TT99 tại ngày lập; vay dài hạn có `maturity_date` xa vào dòng dài hạn; thu tiền khách hàng có `cash_flow_code` vào đúng dòng B03; không mã → rơi theo cặp đối ứng như trước (hồi quy `financial.test.ts` không đổi).
- [ ] **Step 2–5:** FAIL → cài đặt → PASS (`pnpm -F @kt/api test -- test/financial.test.ts`, bộ mẫu `sample-abc.test.ts` không đổi số) → commit `feat(api): kỳ hạn ngắn, dài hạn và mã luồng tiền cho B01, B03`.

### Task 22: Dữ liệu mẫu ABC có kho và bốn phương pháp giá vốn

Model: sonnet (số kỳ vọng tính tay, rà soát bằng opus).

**Files:**
- Modify: `packages/db/src/seed/demo-abc.ts`, `apps/api/scripts/seed-abc.ts`, `apps/api/test/sample-abc.test.ts`
- Create: `packages/db/src/seed/expected-gd3-abc.json`, `apps/api/test/inventory/sample-abc-kho.test.ts`

**Interfaces:**
- Thêm vào ABC (FY2026) qua chính các dịch vụ API (khuôn Task 28 GĐ2): hàng `HANG-A` (đa ĐVT), `HANG-B` (theo lô/HSD), `HANG-C` (đích danh), `HANG-D`; kho `KHO1` (bình quân cuối kỳ), `KHO2` (FIFO), `KHO3` (bình quân tức thời), `KHO4` (đích danh); tồn đầu năm; nhập mua có hóa đơn, hàng về trước, nhập khẩu một lô, chi phí mua; bán có thuế, trả lại, gửi bán; chuyển kho; kiểm kê; chạy giá vốn từng tháng; một ghi lùi phiếu nhập tháng 3 rồi chạy lại.
- `expected-gd3-abc.json`: số dư cuối năm 156/155/632/511/131/331/1331/33311 và NXT năm theo từng hàng–kho, **tính tay** có trường `calc` ghi phép tính (khuôn `expected-gd2-abc.json`); người rà soát tự tính lại tối thiểu 6 mẫu (một hàng mỗi phương pháp, một hàng nhập khẩu, trả lại, kiểm kê).
- `sample-abc.test.ts` hiện khẳng định "không tài khoản nào khác có số dư": cập nhật danh sách tài khoản kỳ vọng.

- [ ] **Step 1: Kiểm thử thất bại:** `sample-abc-kho.test.ts` so từng số `expected-gd3-abc.json`, B01 `Hàng tồn kho` = số dư 156+155+152; bất biến cân đối.
- [ ] **Step 2–5:** FAIL → viết seed và số kỳ vọng → PASS (`pnpm -F @kt/api test -- test/inventory/sample-abc-kho.test.ts test/sample-abc.test.ts`) → commit `feat(db): dữ liệu mẫu ABC có kho và bốn phương pháp giá vốn`.

### Task 23: Bất biến 5 phần kho và đo hiệu năng 50.000 dòng

Model: sonnet.

**Files:**
- Create: `apps/api/test/invariants/inv5-kho.test.ts`, `apps/api/scripts/perf-costing.ts`
- Modify: `apps/api/test/invariants/helpers.ts` (`arbStockOps`), `apps/api/package.json` (script `perf:costing`), `docs/dev/hieu-nang.md`
- Test: chính hai tệp trên

**Interfaces:**
- Bất biến (fast-check, `INVARIANTS=1`): chuỗi ngẫu nhiên nhập/xuất/chuyển/đảo/ghi lùi/chạy giá vốn với một trong bốn phương pháp: (a) Σ `stock_cost_layer.remaining_value` theo TK kho = số dư TK kho (152/153/155/156/157) sau mỗi `runCosting`; (b) Σ `remaining_qty` = Σ `stock_move` in − out; (c) không dòng sổ cái nào bị sửa (so băm `fn_voucher_canonical` trước/sau chạy lại); (d) chạy giá vốn hai lần liên tiếp: lần hai `unchanged`; (e) đảo mọi chứng từ nhập/xuất đưa tồn và giá trị về 0.
- `perf:costing`: sinh 50.000 dòng kho trong một năm (100 hàng × 5 kho, trộn nhập/xuất/chuyển) rồi `runCosting` cả năm cho từng phương pháp; **tiêu chí: dưới 30 giây mỗi phương pháp** (đo `performance.now()`, in bảng); ghi số đo và nguyên nhân nếu chậm vào `docs/dev/hieu-nang.md`. Nếu chậm: tải theo lô `(item, warehouse)` và ghi `stock_cost_assignment` bằng `INSERT … SELECT unnest(...)`, không từng dòng.

- [ ] **Step 1: Kiểm thử thất bại:** `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants/inv5-kho.test.ts` FAIL (hàm sinh chưa có).
- [ ] **Step 2–4:** cài đặt trợ giúp → PASS; `pnpm -F @kt/api perf:costing` đạt tiêu chí; nếu không, tối ưu theo gợi ý trên và đo lại.
- [ ] **Step 5:** Commit `test(api): bất biến sổ kho và đo giá vốn 50.000 dòng`.

### Task 24: Tài liệu người dùng, rà soát toàn nhánh, kết thúc GĐ3

Model: opus (rà soát), sonnet (tài liệu).

**Files:**
- Modify: `docs/user/giai-doan-3-kho-mua-ban.md`, `docs/TIEP-THEO.md`, `docs/NHAT-KY-TIEN-DO.md`, `docs/dev/kiem-thu.md` (nếu thêm biến môi trường), `docs/superpowers/plans/2026-10-22-giai-doan-3-quyet-dinh.md`
- Test: toàn bộ

- [ ] **Step 1:** Tài liệu người dùng (tiếng Việt kế toán): danh mục VTHH/kho/bảng giá, nhập tồn đầu, phiếu nhập/xuất/chuyển, mua/bán hàng hóa, giá vốn và "chưa cập nhật", kiểm kê, báo cáo kho, soát lỗi kho; ghi hạn chế đã biết.
- [ ] **Step 2:** Rà soát toàn nhánh `gd2-hoan-tat..HEAD` (opus, `superpowers:requesting-code-review`): RLS, `UNIQUE` có `tenant_id`, `search_path` hàm `SECURITY DEFINER`, khóa ngoại tổng hợp, `view_cost` ở mọi route mới, không route nào sửa dòng đã ghi; một đợt sửa (ghi quyết định; migration đã đẩy không sửa tại chỗ).
- [ ] **Step 3:** Kiểm trên bản sao sạch: `git clone ~/git/phanmem-ketoan.git` vào thư mục tạm, `pnpm install`, DB tạm, `pnpm db:migrate`, `pnpm db:seed:abc && pnpm db:seed:xyz`, `pnpm lint && pnpm typecheck && pnpm test`, `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts`, `pnpm -F @kt/web e2e` (tuần tự).
- [ ] **Step 4:** Cập nhật `docs/TIEP-THEO.md` (GĐ3 xong, bàn giao GĐ4: TSCĐ/CCDC; hạn chế GĐ3 đã biết; việc chờ người dùng như mẫu 01-VT/02-VT chưa đối chiếu được), `docs/NHAT-KY-TIEN-DO.md`.
- [ ] **Step 5:** `git tag gd3-hoan-tat`, `git push origin main --tags`.

---

## Thứ tự thực hiện

T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14 → T15 → T16 → T17 → T18 → T19 → T20 → T21 → T22 → T23 → T24.

Phụ thuộc chính: T4 trước T8; T5 sau T2 (khóa ngoại `item`, `warehouse`); T6 sau T5; T8 sau T6; T9 sau T5, T6; T11–T13 sau T8; T15 sau T8; T17 sau T8; T22 sau T11–T16; T23 sau T22; T21 độc lập (có thể làm sớm nếu cần chờ văn bản).

| Migration | Tác vụ |
|---|---|
| 0043_quyen_gd3.sql | T1 |
| 0044_vthh_kho.sql | T2 |
| 0045_bang_gia.sql | T3 |
| 0046_so_kho.sql | T5 |
| 0047_chung_tu_kho.sql | T6 (+ LR ở T15) |
| 0048_gia_von.sql | T8 |
| 0049_ton_dau_kho.sql | T9 |
| 0050_mua_ban_hang.sql | T11, T12, T13 |
| 0051_don_hang.sql | T14 |
| 0052_kiem_ke_kho.sql | T16 |
| 0053_soat_loi_gd3.sql | T20 |
| 0054_ky_han_luong_tien.sql | T21 |

Migration đã đẩy là đóng băng: nếu một tác vụ cần sửa migration của tác vụ trước đã đẩy, thêm migration bổ sung số kế tiếp (đánh số lại bảng này khi thực hiện).

## Đối chiếu lộ trình GĐ3

| Mục lộ trình | Tác vụ |
|---|---|
| VTHH đầy đủ, kho, bảng giá | T2, T3 |
| Số dư tồn đầu kỳ theo kho/lô, nhập Excel | T9 |
| `stock_move`, `stock_cost_layer`, `stock_cost_assignment`, `costing_run`, advisory lock | T5, T8 |
| Chứng từ kho: nhập, xuất, chuyển, lắp ráp/tháo dỡ, kiểm kê; 01-VT, 02-VT; tồn âm; thứ tự trong ngày | T6, T7, T15, T16, T19 |
| Mua hàng hóa (qua kho, nhập khẩu, chi phí, hàng về trước/sau, trả lại, chiết khấu) | T11, T12 |
| Bán hàng hóa (đơn, hợp đồng, kiêm xuất kho, trả lại, gửi bán, cảnh báo giá) | T13, T14 |
| Tính giá vốn 4 phương pháp, chạy lại, cố định, điều chỉnh, nhật ký | T4, T8, T10 |
| Báo cáo kho, bán hàng, mua hàng, đối chiếu | T17, T18 |
| Soát lỗi kho | T20 |
| Bất biến 5 phần kho, dữ liệu mẫu 4 phương pháp | T22, T23 |
| Việc GĐ2 để lại (kỳ hạn, mã luồng tiền, Playwright và tài liệu Danh mục, `SENSITIVE_BY_SUBLEDGER`) | T21, T2, T1 |
| Tiêu chí: 50.000 dòng dưới 30 giây; Σ `remaining_value` = số dư 15x | T23, T8 |

## Self-Review (đã chạy)

1. **Phủ đặc tả:** mọi dòng lộ trình GĐ3 có tác vụ (bảng trên). Kho ký gửi nhận (`consignment_in`) chỉ số lượng, tài khoản ngoài bảng không dựng: ghi hạn chế ở T13 và quyết định. Mã vạch/vị trí (mức D) chỉ có cột `barcode`, `location`, không làm màn hình tra cứu bằng máy quét.
2. **Bước mơ hồ:** các tác vụ T11–T13 dùng chung `0050_mua_ban_hang.sql`; nếu T11 đẩy trước thì T12–T13 thêm migration bổ sung (nêu ở bảng).
3. **Nhất quán kiểu:** `computeCosting`/`CostMove`/`CostResult` (T4) được `runCosting` (T8) dùng nguyên; `fn_stock_estimate_cost` (T5) dùng ở T6, T13, T16; `resolvePrice` (T3) dùng ở T14; `STOCK_NEGATIVE`/`STOCK_CONSUMED` (T5) ánh xạ ở T7.
4. **Review Focus:** 5 mục có kiểm thử ở T10, T7, T6/T13, T7, T8/T23.
5. **Tỷ lệ:** kế hoạch ngắn hơn GĐ2 (24 tác vụ, mã chỉ ở chữ ký/kiểm thử); các thân SQL để người thực hiện viết theo quy ước thiết kế.
