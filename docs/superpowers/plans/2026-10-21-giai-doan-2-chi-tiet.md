# Kế hoạch thực hiện chi tiết: GĐ2 (Tiền, công nợ, thuế GTGT) gộp nhóm B

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đủ nghiệp vụ hằng ngày của doanh nghiệp dịch vụ/thương mại chưa có kho: Phiếu thu/chi, Giấy báo nợ/có, Ủy nhiệm chi, chuyển tiền nội bộ, tạm ứng; sổ quỹ, sổ tiền gửi, kiểm kê quỹ, tỷ giá xuất quỹ; công nợ theo chứng từ (`open_item`/`settlement`), đối trừ, bù trừ, chênh lệch tỷ giá, đánh giá lại; hóa đơn mua/bán dịch vụ với động cơ thuế; bảng kê, tờ khai 01/GTGT, XML; nhập chứng từ Excel, khử trùng, soát lỗi mở rộng; đồng thời đóng nhóm B của `2026-10-20-gd1-5-de-xuat.md`.

**Architecture:** Giữ modular monolith. Mọi loại chứng từ mới đi qua bảng `voucher`/`voucher_line` và thủ tục `post_voucher/unpost_voucher/reverse_voucher` hiện có; phần riêng của từng loại là cột tiêu đề mới trên `voucher` (được bất biến sau ghi sổ nhờ `fn_voucher_before` sẵn có) và bảng chi tiết con (`voucher_item_line`, `voucher_invoice`) khóa theo trạng thái chứng từ cha. Công nợ là sổ phụ sinh trong `post_voucher` (SQL, nên seed, đảo, kết chuyển cũng đi qua); đối trừ, chênh lệch tỷ giá, đánh giá lại, tỷ giá xuất quỹ, khấu trừ thuế là chứng từ tự động thật (loại hệ thống, `source_doc_*`, chạy lại = đảo cũ sinh mới). Quy tắc thuần (quy đổi tỷ giá, tính thuế, dựng bút toán hóa đơn, công thức tờ khai, cấu hình loại chứng từ) nằm ở `packages/domain` để dùng chung API/web và kiểm thử bằng fast-check. Mẫu tờ khai và tham số pháp lý là dữ liệu (`packages/coa-data/data/tax`, `legal_param`).

**Tech Stack:** như GĐ0–1.5 (Node 22, TypeScript 5, Fastify 5, Kysely 0.27, PostgreSQL 16, Vitest 2.1, fast-check, React 18 + Vite + Ant Design 5 + AG Grid, Playwright, ExcelJS, pnpm 9). Không thêm phụ thuộc npm (XML viết bằng chuỗi có thoát ký tự, không thêm thư viện).

**Spec:** `docs/superpowers/specs/2026-10-19-phan-mem-ke-toan-design.md` (mục 6 công nợ/thuế/`voucher_invoice`, 7.1, 7.3, 7.4, 9 các dòng Quỹ/Ngân hàng/Mua/Bán/Thuế/Tiện ích, 10, 13, 14 bất biến 5); lộ trình `docs/superpowers/plans/2026-10-19-lo-trinh-thuc-hien.md` mục "Giai đoạn 2"; nhóm B của `docs/superpowers/plans/2026-10-20-gd1-5-de-xuat.md`; quyết định `docs/superpowers/plans/2026-10-19-giai-doan-0-1-quyet-dinh.md` (T19, Final); kế hoạch GĐ1.5 `docs/superpowers/plans/2026-10-20-giai-doan-1-5-chi-tiet.md` (quy ước khóa ngoại tổng hợp, `*_NOT_FOUND`).

## Global Constraints

- Mọi quy tắc trong `CLAUDE.md` mục "Quy tắc bất biến". Nhắc lại các điểm GĐ2 chạm nhiều: tiền VND `NUMERIC(20,0)`, nguyên tệ `NUMERIC(20,4)`, tỷ giá `NUMERIC(20,10)`; trong TypeScript tiền là chuỗi thập phân + `D()`/`decimal.js`, không bao giờ `number`; đầu vào VND theo `VND_AMOUNT_RE` (`^\d{1,16}$`) từ `@kt/domain`, không viết lại regex.
- Không `UPDATE`/`DELETE` dòng sổ cái đã ghi sổ. `settlement` không phải sổ cái: hủy đối trừ xóa dòng `settlement` (có `audit_event`) và đảo chứng từ chênh lệch tỷ giá đi kèm.
- Chứng từ tự động (`CL` chênh lệch tỷ giá đối trừ, `DG` đánh giá lại, `XQ` điều chỉnh tỷ giá xuất quỹ, `KTT` khấu trừ thuế GTGT, `PB` phân bổ doanh thu nhận trước) có số, ngày, người lập, `source_doc_type/source_doc_id`; chạy lại bằng đảo cũ sinh mới; không lập tay, không bỏ ghi sổ/hủy/sửa qua route chung.
- Bảng mới: `tenant_id uuid NOT NULL REFERENCES tenant(id)`, `SELECT rls_enable('<bảng>')`; bảng do người dùng thao tác thêm `audit_enable`; mọi `UNIQUE` có `tenant_id`; khóa ngoại giữa hai bảng có `tenant_id` là tổng hợp `(tenant_id, x_id) REFERENCES cha (tenant_id, id)` (kiểm thử bất biến khóa ngoại của GĐ1.5 Task 9 tự bắt vi phạm). Hàm `SECURITY DEFINER` (nếu có) `SET search_path = public, pg_temp`; mặc định hàm chạy quyền người gọi như 0005.
- Migration 0001–0023 đóng băng (0016–0023 thuộc GĐ1.5; 0021 khóa ghi trực tiếp vào partition `voucher_line`, 0022 sửa cuối GĐ1.5 về đăng nhập và hàng đợi cân bằng, 0023 thêm `closing_step.regime`: sơ đồ kết chuyển theo chế độ). GĐ2 bắt đầu ở **0024**, đánh số theo thứ tự thực hiện (bảng "Thứ tự thực hiện" cuối file); nếu số đã bị dùng khi thực hiện thì dịch các số còn lại lên. Định nghĩa lại hàm luôn lấy thân hiện hành bằng `SELECT pg_get_functiondef('<hàm>'::regproc)` trên DB đã migrate, không chép từ migration cũ.
- `app_user` không có quyền ghi trực tiếp lên partition `voucher_line_YYYY_MM` (GĐ1.5, 0021): mọi `INSERT`/`UPDATE`/`DELETE` dòng chứng từ, trong mã TypeScript, hàm SQL, seed và kiểm thử, đi qua bảng gốc `voucher_line`. Đọc thì vẫn lọc `posting_date` để chỉ quét partition cần thiết. Khóa ngoại và chỉ mục mới trên dòng chứng từ khai báo trên bảng gốc.
- Báo cáo, sổ, tờ khai đọc trong `READ_SNAPSHOT` (`REPEATABLE READ READ ONLY`). Mã lỗi kết thúc `_NOT_FOUND` luôn 404; trạng thái không cho thao tác 409 với mã riêng; đầu vào sai 400.
- Cờ nhạy cảm chặn ở API (403 `FORBIDDEN` kèm thông báo nêu cờ), không chỉ ẩn ở giao diện.
- Giao diện, thông báo lỗi, tài liệu người dùng: tiếng Việt kế toán chuẩn (Phiếu thu, Phiếu chi, Giấy báo Nợ, Giấy báo Có, Ủy nhiệm chi, Sổ quỹ tiền mặt, Sổ tiền gửi ngân hàng, Đối trừ chứng từ, Bù trừ công nợ, Biên bản đối chiếu công nợ, Bảng kê hóa đơn, Tờ khai thuế GTGT). Mã, bảng, biến tiếng Anh.
- Màn hình mới hoặc làm lại: skill `evon:ui-ux` chế độ **dựng luôn**; dùng `KeyboardGrid`, `LookupSelect`, `VnNumberInput`, `useRememberedFilter` của `@kt/ui`; thành phần dùng chung mới đặt ở `packages/ui`; phím tắt Insert (thêm), Ctrl+S (lưu), F9 (ghi sổ), F4 (tra cứu), Enter/Tab; mỗi màn hình ít nhất một spec Playwright trong `apps/web/e2e/` cho luồng chính, viết theo khuôn `phieu-ke-toan.spec.ts` (`signIn`).
- Không bịa dữ liệu pháp lý: chỉ tiêu tờ khai chỉ nhập từ văn bản gốc (`~/legal-docs/`), cổng `complete` trong `packages/coa-data/data/tax/status.json`; mẫu số chứng từ/sổ ("Mẫu số 01-TT…") chỉ in khi đã đối chiếu văn bản gốc; tham số theo ngày hiệu lực ở `legal_param` có `source`.
- Kiểm thử chạy tuần tự trên PostgreSQL thật (DB tạm theo lần chạy của GĐ1.5). Một gói: `pnpm -F @kt/api test -- test/<file>.test.ts`. Không chạy hai việc nặng (Playwright, bất biến dài) song song (VPS 2 CPU).
- Commit nhỏ Conventional Commits, mô tả tiếng Việt, scope `db|domain|api|worker|web|ui|coa|docs`; trailer `Co-Authored-By` của model thực sự viết commit (sonnet: `Claude Sonnet 5.5 <noreply@anthropic.com>`, opus: `Claude Opus 5.5 <noreply@anthropic.com>`). Push `origin main` sau mỗi tác vụ. Ghi quyết định vào `docs/superpowers/plans/2026-10-21-giai-doan-2-quyet-dinh.md`.

## Review Focus

1. Thu một phần khoản phải thu ngoại tệ, cuối năm đánh giá lại, năm sau thu nốt: chênh lệch thực hiện phải tính trên giá trị ghi sổ sau đánh giá lại (không phải tỷ giá gốc) và tổng dư `open_item` vẫn bằng số dư 131 theo đối tượng ở mọi ngày (T13 có kiểm thử).
2. Bỏ ghi sổ hoặc đảo một chứng từ mà công nợ của nó đã được đối trừ: kỳ vọng 409 `OPEN_ITEM_SETTLED`, không đổi gì; hủy đối trừ trước thì làm được (T11 có kiểm thử).
3. Phiếu chi ngoại tệ ghi lùi ngày, trước các phiếu chi đã có: tỷ giá xuất quỹ lúc nhập lấy số dư tại ngày đó; chạy "Tính lại tỷ giá xuất quỹ" cuối kỳ sinh chứng từ `XQ` đưa số dư VND của 1122 về đúng bình quân di động; chạy lại đảo `XQ` cũ (T10 có kiểm thử).
4. Cùng một hóa đơn đầu vào (MST người bán + ký hiệu + số) nhập ở hai chứng từ khác loại (Hóa đơn mua dịch vụ và Phiếu chi): lần hai bị từ chối 409 `INVOICE_DUPLICATE`; hóa đơn trên chứng từ đã hủy không chặn (T18 có kiểm thử).
5. Tệp Excel 1.000 dòng có một dòng sai: không chèn gì, báo dòng/cột bằng tiếng Việt; nhập lại cùng tệp đã sửa hai lần không sinh chứng từ trùng (T25 có kiểm thử).

---

## Cấu trúc file

- `packages/domain/src/`: `voucherTypes.ts` (cấu hình loại chứng từ, mục đích thu/chi, danh sách loại hệ thống), `fx.ts` (quy đổi, bình quân di động), `tax.ts` (động cơ thuế), `invoiceLedger.ts` (dựng bút toán hóa đơn), `vatFormula.ts` (công thức tờ khai), `vnTime.ts` (ngày hôm nay giờ Việt Nam), `permissions.ts` (thêm quyền, `sensitiveDenial` chuyển về đây).
- `packages/db/migrations/0024_quyen_gd2.sql` … `0035_soat_loi_gd2.sql` (bảng "Thứ tự thực hiện").
- `apps/api/src/modules/ledger/`: `vouchers.service.ts`, `vouchers.routes.ts` (chứng từ dùng chung theo loại), `openingBalance.ts` (số dư công nợ theo hóa đơn, bỏ ghi sổ số dư).
- `apps/api/src/modules/cash/` (mới): `books.ts` (số dư tại ngày, sổ quỹ, sổ tiền gửi), `cashCount.ts`, `fx.ts` (tỷ giá theo ngày, tỷ giá xuất quỹ, đánh giá lại), `routes.ts`.
- `apps/api/src/modules/arap/` (mới): `openItems.ts`, `settlement.ts`, `reports.ts` (sổ chi tiết, tổng hợp, tuổi nợ, đối chiếu, nhắc nợ), `routes.ts`.
- `apps/api/src/modules/invoices/` (mới): `service.ts` (HDB/HDM/GGB/GGM, `voucher_invoice`), `amortization.ts`, `routes.ts`.
- `apps/api/src/modules/tax/` (mới): `register.ts` (bảng kê, đối chiếu), `vatReturn.ts`, `vatOffset.ts`, `xml/index.ts`, `xml/htkk01gtgt.ts`, `routes.ts`.
- `apps/api/src/modules/tools/`: `importVouchers.ts`, `dedupe.ts`; `apps/api/src/modules/master/excelSheet.ts` (đọc Excel dùng chung cho danh mục và chứng từ).
- `apps/api/src/modules/core/vnTime.ts`: mốc ngày giờ Việt Nam cho bộ lọc theo `timestamptz`.
- `packages/coa-data/data/tax/`: `01gtgt-tt89.json`, (`01gtgt-tt80.json` nếu tải được), `htkk-01gtgt.json`, `fx-rules.json`, `status.json`.
- `packages/ui/src/`: sửa `KeyboardGrid.tsx`, `LookupSelect.tsx`, `VnNumberInput.tsx`; mới `DateRangeFilter.tsx` nếu hai trang trở lên cần.
- `apps/web/src/pages/`: `VoucherForm.tsx` (thay `Voucher.tsx`), `VoucherList.tsx`, `CashBooks.tsx`, `CashCount.tsx`, `Settlement.tsx`, `FxTools.tsx`, `ArapReports.tsx`, `InvoiceRegister.tsx`, `VatReturn.tsx`, `ImportVouchers.tsx`, `Dedupe.tsx`, `Amortization.tsx`.
- `packages/db/src/seed/demo-abc.ts` (thêm nghiệp vụ GĐ2), `apps/api/test/sample-abc.test.ts`, `apps/api/test/invariants/inv5-cong-no.test.ts`.
- `docs/user/giai-doan-2-tien-cong-no-thue.md`.

---

### Task 1: Danh mục dùng chung: siết đầu vào và ngưng dùng (nhóm B "Danh mục")

Model: sonnet.

**Files:**
- Modify: `apps/api/src/modules/master/crud.ts`, `apps/api/src/modules/master/catalogs.ts`, `apps/api/src/modules/master/routes.ts`, `apps/api/src/plugins/errors.ts`, các route có `:id` dạng số dùng `z.coerce.number()` (tìm bằng `grep -rn "coerce.number()" apps/api/src`), `apps/web/src/pages/Catalog.tsx`
- Test: `apps/api/test/catalogs.test.ts`, `apps/api/test/errors.test.ts`

**Interfaces:**
- `GET /api/catalogs/:name` nhận thêm `active: 'true' | 'false' | 'all'` (mặc định `'true'` cho danh mục có cột `is_active`); `page` giới hạn `max(10_000)`.
- `q`: thoát `\`, `%`, `_` trước khi ghép vào `ILIKE … ESCAPE '\'`; helper `export const likePattern = (q: string) => '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'` trong `crud.ts`, dùng lại ở mọi nơi tìm kiếm ILIKE (`grep -rn "ILIKE" apps/api/src`).
- Schema danh mục: `code` và `name` qua `.trim()` rồi `.min(1)`; `credit_limit` dùng `VND_AMOUNT_RE` từ `@kt/domain` (bỏ regex `vnd` cục bộ).
- `POST /api/catalogs/:name/:id/deactivate` và `/activate` (quyền `catalog.update`): đặt `is_active`; danh mục không có cột `is_active` → 400 `CATALOG_NO_ACTIVE_FLAG`.
- Tham số `:id` số: `z.string().regex(/^\d{1,15}$/)` rồi `Number`; số lẻ/chữ → 404 `*_NOT_FOUND` hoặc 400 `VALIDATION`, không bao giờ 500.
- `errors.ts` nhánh `23505`: không lộ tên ràng buộc; thông báo `Mã đã tồn tại` khi tên ràng buộc chứa `code`, ngược lại `Trùng dữ liệu đã có`; mã lỗi giữ `DUPLICATE`.

- [ ] **Step 1: Kiểm thử thất bại** trong `catalogs.test.ts`:

```ts
it('tìm kiếm coi % và _ là ký tự thường', async () => {
  await post('/api/catalogs/party', { code: 'A_1', name: 'Công ty 100%' }); await post('/api/catalogs/party', { code: 'AB1', name: 'Công ty khác' });
  expect((await get('/api/catalogs/party?q=A_1')).json().rows.map((r: any) => r.code)).toEqual(['A_1']);
  expect((await get('/api/catalogs/party?q=100%25')).json().total).toBe(1);
});
it('cắt khoảng trắng mã và tên; mã toàn khoảng trắng bị từ chối', async () => {
  const id = (await post('/api/catalogs/party', { code: '  KH9 ', name: ' Khách 9 ' })).json().id;
  expect((await get(`/api/catalogs/party/${id}`)).json()).toMatchObject({ code: 'KH9', name: 'Khách 9' });
  expect((await post('/api/catalogs/party', { code: '   ', name: 'x' })).statusCode).toBe(400);
});
it('ngưng dùng rồi lọc theo trạng thái', async () => {
  await post(`/api/catalogs/party/${id}/deactivate`, {});
  expect((await get('/api/catalogs/party')).json().rows.some((r: any) => r.id === id)).toBe(false);
  expect((await get('/api/catalogs/party?active=false')).json().rows.some((r: any) => r.id === id)).toBe(true);
});
it('id số lẻ, page quá lớn, trùng mã: không 500, không lộ tên ràng buộc', async () => {
  expect((await get('/api/catalogs/department/1.5')).statusCode).toBe(404);
  expect((await get('/api/catalogs/party?page=10001')).statusCode).toBe(400);
  const dup = await post('/api/catalogs/party', { code: 'KH9', name: 'Trùng' });
  expect(dup.statusCode).toBe(409); expect(dup.json().error.message).toBe('Mã đã tồn tại'); expect(dup.body).not.toMatch(/_key|_tenant_id/);
});
```

- [ ] **Step 2:** `pnpm -F @kt/api test -- test/catalogs.test.ts test/errors.test.ts` → FAIL.
- [ ] **Step 3:** Cài đặt theo Interfaces; trang Danh mục thêm bộ lọc "Đang dùng / Ngưng dùng / Tất cả" (nhớ bằng `useRememberedFilter`) và nút Ngưng dùng/Dùng lại.
- [ ] **Step 4:** Chạy lại → PASS; `pnpm -F @kt/api test` và `pnpm -F @kt/web test` xanh.
- [ ] **Step 5:** Commit `fix(api): danh mục thoát ký tự tìm kiếm, cắt khoảng trắng, ngưng dùng, lỗi trùng mã không lộ ràng buộc`.

### Task 2: Lưới nhập liệu và tra cứu F4 (nhóm B "Lưới nhập liệu và F4")

Model: sonnet.

**Files:**
- Modify: `packages/domain/src/gridKeyboard.ts`, `packages/ui/src/KeyboardGrid.tsx`, `packages/ui/src/VnNumberInput.tsx`, `packages/ui/src/LookupSelect.tsx`, `apps/web/src/pages/Voucher.tsx` (F9, `validateFields`, nhãn Insert), `apps/web/src/pages/Catalog.tsx`, `apps/web/src/pages/Users.tsx` (nút Sửa/Xóa)
- Test: `packages/domain/test/gridKeyboard.test.ts`, `packages/ui/test/*.test.tsx`, `apps/web/test/Voucher.test.tsx`

**Interfaces:**
- `gridKeyAction`: Tab ở ô sửa được cuối cùng của dòng cuối trả `{ type: 'move', addRow: true, pos: { row: rowCount, col: firstEditable } }` khi `!lockRows`; khi `lockRows` trả `{ type: 'none' }` để trình duyệt chuyển tiêu điểm ra khỏi lưới (hiện kẹt).
- `VnNumberInput`: khi chữ gõ không phân tích được, giữ nguyên chữ hiển thị và **không** gọi `onChange` với tiền tố hợp lệ; rời ô thì trả về giá trị hợp lệ cuối cùng.
- `LookupSelect`: mỗi lần gõ tăng `seq`; chỉ áp dụng kết quả của `seq` mới nhất; debounce 250 ms hủy hẹn giờ cũ và hủy khi gỡ thành phần (`useEffect` cleanup) bằng `AbortController` truyền vào `fetcher(q, signal)`. Chữ ký mới: `fetcher: (q: string, signal: AbortSignal) => Promise<LookupOption[]>` (sửa mọi nơi gọi trong `apps/web/src/lookups.ts`).
- Trang có nhãn "Thêm (Insert)" phải gắn phím Insert thật (hook dùng chung `useHotkeys(map: Record<string, () => void>)` mới trong `packages/ui/src/useHotkeys.ts`, bỏ qua khi đang soạn IME hoặc khi tiêu điểm trong ô nhập của modal).
- Nút Sửa/Xóa trong bảng danh mục/người dùng là `<Button>` (tới được bằng Tab, Enter kích hoạt), không phải `onClick` trên `<td>`.
- Lỗi `form.validateFields()` hiển thị `errorFields[0].errors[0]`, không `String(err)`.
- F9 khi chứng từ chưa cân (`!balanced`) hiện thông báo `Chứng từ chưa cân: tổng Nợ … khác tổng Có …` và không gọi API.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
// gridKeyboard.test.ts
it('Tab ở ô cuối của dòng cuối thêm dòng mới; khóa dòng thì nhả cho trình duyệt', () => {
  const ctx = { rowCount: 2, editableCols: [0, 2, 3], readOnly: false, lockRows: false };
  expect(gridKeyAction(key('Tab'), { row: 1, col: 3 }, ctx)).toEqual({ type: 'move', addRow: true, pos: { row: 2, col: 0 } });
  expect(gridKeyAction(key('Tab'), { row: 1, col: 3 }, { ...ctx, lockRows: true })).toEqual({ type: 'none' });
});
// LookupSelect.test.tsx
it('phản hồi về muộn của lần gõ cũ không ghi đè kết quả mới', async () => { /* fetcher trả 'a' sau 300 ms, 'ab' sau 10 ms → danh sách cuối là kết quả của 'ab'; signal của lần 'a' đã abort */ });
// VnNumberInput.test.tsx
it('gõ "12a" không đẩy 12 ra ngoài; rời ô trả giá trị hợp lệ trước đó', async () => {});
// Voucher.test.tsx
it('F9 khi chưa cân không gọi API ghi sổ và báo lệch', async () => {});
it('thiếu ngày hạch toán: thông báo là chữ lỗi của trường, không phải [object Object]', async () => {});
```

- [ ] **Step 2:** `pnpm -F @kt/domain test`, `pnpm -F @kt/ui test`, `pnpm -F @kt/web test` → FAIL.
- [ ] **Step 3:** Cài đặt.
- [ ] **Step 4:** Ba lệnh trên xanh; `pnpm -F @kt/web e2e -- phieu-ke-toan.spec.ts` xanh.
- [ ] **Step 5:** Commit `fix(ui): Tab ở ô cuối, phản hồi tra cứu lệch thứ tự, ô số giữ chữ sai, phím Insert và F9 khi chưa cân`.

### Task 3: Quyền GĐ2, cờ nhạy cảm dùng chung, mốc giờ Việt Nam

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0024_quyen_gd2.sql`, `packages/domain/src/vnTime.ts`, `apps/api/src/modules/core/vnTime.ts`
- Modify: `packages/domain/src/permissions.ts`, `packages/domain/src/index.ts`, `apps/api/src/modules/reporting/ledgers.ts` (`sensitiveDenial` chuyển sang domain), `apps/api/src/modules/ledger/balances.ts`, `apps/api/src/modules/audit/routes.ts` (dùng helper chung cho cả `/api/audit/logins`), `apps/web/src/pages/AuditLog.tsx` (nếu có lọc ngày đăng nhập)
- Test: `packages/domain/test/permissions.test.ts`, `packages/domain/test/vnTime.test.ts`, `apps/api/test/audit.test.ts`, `apps/api/test/users.test.ts`

**Interfaces:**
- Quyền mới trong `PERMISSIONS`: `...crud('settlement', 'đối trừ công nợ', 'Công nợ')` (dùng `view/create/delete`, bỏ `update`), `{ code: 'fx.run', name: 'Chạy tỷ giá xuất quỹ, đánh giá lại ngoại tệ', group: 'Công nợ' }`, `...crud('cash_count', 'kiểm kê quỹ', 'Quỹ')`, `{ code: 'tax.view', … 'Thuế' }`, `...crud('tax_return', 'tờ khai thuế', 'Thuế', [['finalize', 'Chốt']])`, `{ code: 'tax.offset', name: 'Khấu trừ thuế GTGT cuối kỳ', group: 'Thuế' }`, `{ code: 'voucher.import', name: 'Nhập chứng từ từ Excel', group: 'Chứng từ' }`, `{ code: 'dedupe.run', name: 'Khử trùng chứng từ', group: 'Tiện ích' }`, `...crud('amortization', 'lịch phân bổ', 'Cuối kỳ', [['run', 'Chạy']])`. Bảng `permission` được đồng bộ bởi `syncReferenceData` (`packages/db/src/reference.ts`).
- `0024`: `create_tenant` định nghĩa lại từ thân hiện hành (lấy bằng `pg_get_functiondef`, hiện là bản 0018 hoặc mới hơn), danh sách loại trừ của `ketoan_vien` thêm `'fx.run','tax_return.finalize','tax.offset','amortization.run','dedupe.run'`. Công ty đã có: chèn quyền mới cho `admin` (mọi quyền mới), `ketoan_truong` (mọi quyền mới), `ketoan_vien` (quyền mới trừ danh sách loại trừ), `xem` (`settlement.view`, `cash_count.view`, `tax.view`, `tax_return.view`, `amortization.view`); tắt `trg_audit` của `role_permission` khi chèn bù như 0018. Migration chạy sau `syncReferenceData` nên phải tự `INSERT INTO permission … ON CONFLICT DO NOTHING` các mã mới trước.
- `0024` cũng định nghĩa lại hàm kiểm cân bằng của hàng đợi `voucher_balance_pending` (thân hiện hành bằng `pg_get_functiondef`, `SECURITY DEFINER` từ 0022): chỉ kiểm chứng từ có `voucher.tenant_id` bằng `tenant_id` của dòng hàng đợi, không thì bỏ qua và xóa dòng hàng đợi (việc để lại của GĐ1.5: không để lộ tổng Nợ/Có chứng từ công ty khác qua thông báo lỗi). Kiểm thử: `app_user` chèn dòng hàng đợi với UUID chứng từ công ty khác → COMMIT không báo lỗi chứa số tiền.
- Domain: `export const SENSITIVE_BY_SUBLEDGER = { receivable: 'view_receivable', payable: 'view_payable' } as const;` `export function sensitiveDenial(auth: { sensitive: Set<string> }, acc: { subledger_kind: string | null; code: string }): string | null` (chuyển nguyên thân từ `ledgers.ts`), `export function flagsForAccounts(accs: { subledger_kind: string | null; code: string }[]): SensitiveFlag[]`. Mọi nơi dùng danh sách cờ lấy từ `@kt/domain` (`grep -rn "view_receivable\|view_payable\|view_cost" apps/api/src` chỉ còn trong domain).
- `vnTime.ts` (domain): `export function todayVn(now = new Date()): string` → `YYYY-MM-DD` theo `Asia/Ho_Chi_Minh` (dùng `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' })`).
- `vnTime.ts` (api): `export const vnDayStart = (d: string) => sql\`(${d}::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')\``, `export const vnDayEnd = (d: string) => sql\`((${d}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')\``; `audit/routes.ts` và `tools/exportAuthority.ts` dùng lại thay biểu thức tại chỗ.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('todayVn: 17:30 UTC ngày 31/12 là 01/01 năm sau ở Việt Nam', () => {
  expect(todayVn(new Date('2026-12-31T17:30:00Z'))).toBe('2027-01-01');
});
it('nhật ký đăng nhập lọc theo ngày giờ Việt Nam', async () => {
  // chèn login_event ts = '2026-03-01T17:30:00Z' (00:30 ngày 02/03 giờ VN) → from=to=2026-03-02 thấy, from=to=2026-03-01 không thấy
});
it('công ty mới: ketoan_vien có settlement.create, không có fx.run, tax_return.finalize; xem có tax.view', async () => {});
it('công ty tạo trước 0024 cũng được cấp quyền mới cho admin', async () => { /* kiểm trên tenant tạo bằng create_tenant rồi chạy lại phần chèn bù: admin có đủ PERMISSION_CODES */ });
```

- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt. **Step 4:** `pnpm db:migrate` trên DB dev; `pnpm -F @kt/domain test`, `pnpm -F @kt/api test`, `pnpm -F @kt/db test` xanh.
- [ ] **Step 5:** Commit `feat(db): quyền GĐ2, cờ nhạy cảm và mốc giờ Việt Nam dùng chung`.

### Task 4: Lược đồ chứng từ tiền và loại chứng từ GĐ2; siết cân bằng đa tiền tệ

Model: sonnet (phần SQL cân bằng ngoại tệ rà soát bằng opus).

**Files:**
- Create: `packages/db/migrations/0025_chung_tu_tien.sql`, `packages/domain/src/voucherTypes.ts`
- Modify: `packages/db/src/types.ts`, `packages/domain/src/index.ts`
- Test: `packages/db/test/ledger-schema.test.ts`, `packages/domain/test/voucherTypes.test.ts`

**Interfaces:**
- `seed_voucher_types` định nghĩa lại (thân hiện hành + dòng mới, `ON CONFLICT DO NOTHING`), chạy cho mọi công ty đã có (tắt audit như 0004):

| code | name | module | prefix | is_system |
|---|---|---|---|---|
| PT | Phiếu thu | cash | PT | true |
| PC | Phiếu chi | cash | PC | true |
| BC | Giấy báo Có | bank | BC | true |
| BN | Giấy báo Nợ (in Ủy nhiệm chi) | bank | BN | true |
| CT | Chuyển tiền nội bộ | bank | CT | true |
| QTU | Quyết toán tạm ứng | general | QTU | true |
| BT | Bù trừ công nợ | arap | BT | true |
| HDB | Hóa đơn bán dịch vụ | arap | HDB | true |
| HDM | Hóa đơn mua dịch vụ | arap | HDM | true |
| GGB | Giảm giá, trả lại dịch vụ bán | arap | GGB | true |
| GGM | Giảm giá, trả lại dịch vụ mua | arap | GGM | true |
| CL | Chênh lệch tỷ giá đối trừ | arap | CL | true |
| DG | Đánh giá lại ngoại tệ | general | DG | true |
| XQ | Điều chỉnh tỷ giá xuất quỹ | general | XQ | true |
| KTT | Khấu trừ thuế GTGT | general | KTT | true |

  (`is_system` của `voucher_type` nghĩa là loại do hệ thống định nghĩa, không xóa được; "lập tay hay không" do `SYSTEM_VOUCHER_TYPES` quyết định.) Ủy nhiệm chi là mẫu in của `BN`, không phải loại riêng.
- `ALTER TABLE voucher ADD COLUMN person_name text, ADD COLUMN person_address text, ADD COLUMN attachments_count int CHECK (attachments_count >= 0), ADD COLUMN bank_account_id bigint, ADD COLUMN counter_bank_account_id bigint, ADD COLUMN party_bank_account_id uuid, ADD COLUMN due_date date, ADD COLUMN purpose text`; FK tổng hợp `(tenant_id, bank_account_id)`/`(tenant_id, counter_bank_account_id) REFERENCES bank_account(tenant_id, id)`, `(tenant_id, party_bank_account_id) REFERENCES party_bank_account(tenant_id, id)` (thêm `UNIQUE (tenant_id, id)` cho `bank_account`, `party_bank_account` nếu GĐ1.5 chưa thêm). Cột mới tự được `fn_voucher_before` khóa sau ghi sổ (so `to_jsonb` trừ `description`); `fn_voucher_canonical` không đổi (định dạng hash đóng băng).
- `ALTER TABLE voucher_line ADD COLUMN bank_account_id bigint` + FK tổng hợp tới `bank_account`; `reverse_voucher` định nghĩa lại (thân hiện hành) để sao chép `bank_account_id` sang dòng đảo.
- `unpost_voucher`/`discard_voucher` định nghĩa lại: danh sách `source_doc_type` hệ thống của 0015 thêm `'settlement_fx','fx_revaluation','fx_outflow','vat_offset','amortization'`, cùng mã lỗi `VOUCHER_SYSTEM_GENERATED`.
- Siết đa tiền tệ (quyết định T19): `fn_line_before` định nghĩa lại (thân hiện hành) thêm, chỉ khi `TG_OP = 'INSERT'` hoặc `(currency_code, amount_currency, fx_rate, debit, credit)` đổi: (a) dòng ngoại tệ có `fx_rate`: `abs(round(amount_currency * fx_rate) - (debit - credit)) <= 1`, sai → `LINE_FX_MISMATCH: dòng % nguyên tệ % × tỷ giá % khác số tiền VND %`; (b) dòng ngoại tệ không có `fx_rate` chỉ được khi `amount_currency = 0` (dòng điều chỉnh chỉ VND như `CL`, `DG`, `XQ`) hoặc chứng từ loại `DK`, sai → `LINE_FX_RATE_REQUIRED`. `fn_check_voucher_balance` không đổi (chứng từ một ngoại tệ vẫn cân theo nguyên tệ).
- `packages/domain/src/voucherTypes.ts`:

```ts
export type HeaderField = 'party' | 'personName' | 'personAddress' | 'attachmentsCount' | 'bankAccount' | 'counterBankAccount' | 'partyBankAccount' | 'dueDate' | 'purpose' | 'currency';
export interface VoucherTypeDef { code: string; name: string; module: 'general' | 'cash' | 'bank' | 'arap'; manual: boolean; header: HeaderField[]; required: HeaderField[];
  cashSide?: 'in' | 'out'; moneyKind?: 'cash' | 'bank'; hasItems?: boolean; invoiceDirection?: 'purchase' | 'sale'; refund?: boolean; printForms: string[] }
export const VOUCHER_TYPES: Record<string, VoucherTypeDef>;            // đủ 15 loại trên + PKT, DK, KC, PB
export const SYSTEM_VOUCHER_TYPES: readonly string[];                  // ['DK','KC','CL','DG','XQ','KTT']
export interface CashPurpose { code: string; label: string; types: ('PT'|'PC'|'BC'|'BN')[]; counterAccounts: Record<'TT133'|'TT99'|'TT200', string[]>; partyRequired: boolean }
export const CASH_PURPOSES: readonly CashPurpose[];                    // thu khách hàng 131; thu hoàn ứng 141; thu khác; chi trả NCC 331; chi tạm ứng 141; nộp thuế (33311, 3334, 3335…); nộp BHXH/BHYT/BHTN/KPCĐ; chi khác
```

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('công ty có đủ loại chứng từ GĐ2 với đúng phần hành', async () => { /* PT→cash, BN→bank, HDB→arap, KTT→general */ });
it('dòng ngoại tệ có tỷ giá: nguyên tệ × tỷ giá phải khớp VND trong 1 đồng', async () => {
  // admin: chèn chứng từ PKT nháp USD, dòng 1122 amount_currency 1000 fx_rate 25400 debit 25400000 → được; debit 2540000 → LINE_FX_MISMATCH
});
it('dòng ngoại tệ không tỷ giá chỉ được khi nguyên tệ = 0 hoặc chứng từ DK', async () => {});
it('sửa diễn giải dòng ngoại tệ cũ không tỷ giá vẫn được (không kiểm lại tỷ giá)', async () => {});
it('cột tiêu đề mới bất biến sau ghi sổ', async () => { /* UPDATE voucher SET person_name = 'x' trên chứng từ posted → VOUCHER_IMMUTABLE */ });
it('mọi tài khoản đối ứng trong CASH_PURPOSES tồn tại và là tài khoản chi tiết trong mẫu hệ thống tài khoản của chế độ', () => { /* loadCoaTemplate từ @kt/coa-data */ });
```

- [ ] **Step 2:** `pnpm -F @kt/db test -- test/ledger-schema.test.ts`, `pnpm -F @kt/domain test` → FAIL.
- [ ] **Step 3:** Viết migration và `voucherTypes.ts`; cập nhật `types.ts` (cột mới).
- [ ] **Step 4:** `pnpm db:migrate` dev; `pnpm -F @kt/db test`, `pnpm -F @kt/api test`, `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts` xanh (XYZ không có dòng ngoại tệ thiếu tỷ giá; nếu có thì dữ liệu seed sai, sửa seed).
- [ ] **Step 5:** Commit `feat(db): loại chứng từ tiền, công nợ, hóa đơn; cột tiêu đề chứng từ; siết tỷ giá dòng ngoại tệ`.

### Task 5: API chứng từ dùng chung theo loại (thay `PKT` viết cứng)

Model: sonnet.

**Files:**
- Modify: `apps/api/src/modules/ledger/vouchers.service.ts`, `apps/api/src/modules/ledger/vouchers.routes.ts`
- Test: `apps/api/test/vouchers.test.ts`, `apps/api/test/cashVouchers.test.ts` (mới)

**Interfaces:**
- Consumes: `VOUCHER_TYPES`, `SYSTEM_VOUCHER_TYPES`, `CASH_PURPOSES` (Task 4); `decideEdit` (`packages/domain/src/voucherState.ts`).
- `voucherInput` thêm: `personName`, `personAddress` (chuỗi ≤ 200, nullable), `attachmentsCount: z.number().int().min(0).max(999).nullable().optional()`, `bankAccountNo`, `counterBankAccountNo` (mã `bank_account.account_no`), `partyBankAccountNo` (số tài khoản của đối tượng chính), `dueDate`, `purpose`; `lineInput` thêm `bankAccountNo`.
- Quy tắc theo loại (lỗi 400 trừ ghi khác), kiểm trong `createVoucher`/`updateDraft`:
  - `assertNotSystemType`: loại trong `SYSTEM_VOUCHER_TYPES` hoặc `VOUCHER_TYPES[t].manual === false` → 409 `VOUCHER_TYPE_SYSTEM`. Loại có `hasItems` (HDB/HDM/GGB/GGM) không tạo qua `/api/vouchers` mà qua `/api/invoices` (Task 18) → 409 `VOUCHER_TYPE_USE_INVOICE`.
  - Trường trong `required` thiếu → `VOUCHER_FIELD_REQUIRED` (thông báo nêu nhãn tiếng Việt).
  - `cashSide='in'` + `moneyKind='cash'` (PT): phải có ít nhất một dòng Nợ trên tài khoản `subledger_kind='cash'`; PC: dòng Có trên tài khoản tiền mặt → `VOUCHER_CASH_LINE_REQUIRED`. BC/BN tương tự với `bank`.
  - `bankAccountNo` không có → 404 `BANK_ACCOUNT_NOT_FOUND`; dòng trên tài khoản `subledger_kind='bank'` không ghi `bankAccountNo` thì lấy của tiêu đề; tài khoản sổ cái của dòng khác `bank_account.gl_account_code` → `BANK_ACCOUNT_GL_MISMATCH`.
  - `purpose` không thuộc `CASH_PURPOSES` của loại → `VOUCHER_PURPOSE_INVALID`; mục đích `partyRequired` mà dòng đối ứng thiếu đối tượng → `LINE_PARTY_REQUIRED`.
- `VoucherDto` thêm các trường trên, `lines[].bankAccountNo`, `periodStatus: 'open' | 'soft_locked' | 'hard_locked'`, `hashed: boolean` (cho giao diện gọi `decideEdit`).
- `GET /api/vouchers` nhận `type` là danh sách cách nhau dấu phẩy.
- `PUT /api/vouchers/:id` với thân `{}` hoặc chỉ `{ version }` → 400 `VALIDATION` (hiện đi vào nhánh meta rỗng).
- Không thay đổi số tiền/tài khoản của SQL: thủ tục ghi sổ giữ nguyên.

- [ ] **Step 1: Kiểm thử thất bại** (`cashVouchers.test.ts` dùng `setupLedgerTenant` + tạo `bank`/`bank_account` 1121):

```ts
it('Phiếu thu tiền khách hàng: cần dòng Nợ tiền mặt, đối tượng trên 131', async () => {
  const ok = await create({ voucherType: 'PT', purpose: 'thu_khach_hang', personName: 'Nguyễn Văn A', partyCode: 'KH001', lines: [
    { accountCode: '1111', debit: '5000000' }, { accountCode: '131', credit: '5000000', partyCode: 'KH001' }] });
  expect(ok.statusCode).toBe(201); expect(ok.json()).toMatchObject({ voucherType: 'PT', personName: 'Nguyễn Văn A', periodStatus: 'open', hashed: false });
  const bad = await create({ voucherType: 'PT', lines: [{ accountCode: '6422', debit: '1' }, { accountCode: '1111', credit: '1' }] });
  expect(bad.json().error.code).toBe('VOUCHER_CASH_LINE_REQUIRED');
});
it('Giấy báo Nợ: dòng 1121 nhận tài khoản ngân hàng của tiêu đề; tài khoản sổ cái lệch thì từ chối', async () => {});
it('không lập tay CL/DG/XQ/KTT; HDB phải qua /api/invoices', async () => {});
it('PUT {} trả 400', async () => {});
it('thiếu quyền voucher.create hoặc voucher.post thì 403', async () => { /* người dùng vai trò xem */ });
it('ghi sổ lại sau khi kỳ bị khóa mềm trong lúc chứng từ đang bỏ ghi sổ: 409 PERIOD_SOFT_LOCKED, có quyền ghi lùi thì được', async () => {});
it('hai yêu cầu ghi sổ đồng thời cùng chứng từ: đúng một thành công, số chứng từ không nhảy', async () => {
  const [a, b] = await Promise.all([postIt(id), postIt(id)]);
  expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  // voucher_counter.last_no tăng đúng 1
});
it('danh sách lọc nhiều loại: type=PT,PC', async () => {});
```

- [ ] **Step 2:** `pnpm -F @kt/api test -- test/cashVouchers.test.ts test/vouchers.test.ts` → FAIL.
- [ ] **Step 3:** Cài đặt; tách kiểm tra theo loại thành `function assertTypeRules(trx, def: VoucherTypeDef, input: VoucherInput, resolved: ResolvedLine[]): Promise<void>` trong `vouchers.service.ts`.
- [ ] **Step 4:** PASS; `pnpm -F @kt/api test` xanh.
- [ ] **Step 5:** Commit `feat(api): chứng từ dùng chung theo loại: phiếu thu, phiếu chi, giấy báo nợ/có, chuyển tiền nội bộ`.

### Task 6: Màn hình chứng từ dùng chung, danh sách theo loại, Đảo chọn ngày, bỏ ghi sổ số dư đầu kỳ

Model: sonnet.

**Files:**
- Create: `apps/web/src/pages/VoucherForm.tsx` (từ `Voucher.tsx`, xóa `Voucher.tsx` sau khi chuyển kiểm thử), `apps/web/e2e/phieu-thu.spec.ts`
- Modify: `apps/web/src/router.tsx` (route `/chung-tu/$type` danh sách, `/chung-tu/$type/$id` biểu mẫu; giữ `/chung-tu/phieu-ke-toan` chuyển hướng sang `/chung-tu/PKT`), `apps/web/src/pages/VoucherList.tsx`, `apps/web/src/pages/OpeningBalance.tsx`, `apps/web/test/VoucherPage.test.tsx`, `apps/web/test/Voucher.test.tsx`, `apps/web/e2e/phieu-ke-toan.spec.ts`, `apps/api/src/modules/ledger/openingBalance.ts` + route
- Test: `apps/web/test/VoucherForm.test.tsx`, `apps/api/test/openingBalance.test.ts`

**Interfaces:**
- Việc để lại của GĐ1.5: `Closing.tsx` đổi ngày ghi sổ làm mất sửa đổi chưa lưu của sơ đồ: hỏi xác nhận trước khi tải lại (dùng lại cách màn hình chứng từ dùng chung báo thay đổi chưa lưu).
- Consumes: `VOUCHER_TYPES`, `CASH_PURPOSES`, `decideEdit`, `canTransition`, `todayVn` (domain); `VoucherDto.periodStatus/hashed` (Task 5).
- `VoucherForm` đọc `VOUCHER_TYPES[type]`: tiêu đề màn hình là `name`; ô tiêu đề hiện theo `header`; chọn `purpose` điền sẵn tài khoản đối ứng mặc định của chế độ vào dòng 2; ô tài khoản ngân hàng là `LookupSelect` danh mục `bank_account`; cột lưới thêm `bankAccountNo` khi `moneyKind='bank'`.
- Nút hành động quyết định bởi `canTransition(state, action)` và `decideEdit({ periodStatus, hashed, change, canEditPosted, canBackdateLocked })`: "Sửa" ở chứng từ đã ghi sổ: `unpost_edit_post` → Bỏ ghi sổ; `reverse_and_new` → Đảo + Nhân bản; `adjust_in_open_period` → Nhân bản sang kỳ mở; `forbidden` → ẩn. Đây là nơi `decideEdit`/`canTransition` được dùng thật (nhóm B).
- "Đảo" mở hộp thoại chọn ngày đảo (mặc định `todayVn()`, không cho trước ngày chứng từ gốc), diễn giải mặc định "Đảo chứng từ … ngày …".
- Menu "Chứng từ": Phiếu thu, Phiếu chi, Giấy báo Có, Giấy báo Nợ, Chuyển tiền nội bộ, Quyết toán tạm ứng, Bù trừ công nợ, Phiếu kế toán (mỗi mục là danh sách lọc theo loại; Insert ở danh sách mở biểu mẫu mới cùng loại).
- Số dư đầu kỳ: `POST /api/opening-balances/:year/unpost` (quyền `opening_balance.update` + `voucher.unpost`) bỏ ghi sổ chứng từ DK của năm (dùng biến phiên `app.opening_repost` như `postOpening`), trả 409 `OPEN_ITEM_SETTLED` nếu công nợ đầu kỳ đã đối trừ (sau Task 11); nút "Bỏ ghi sổ số dư đầu kỳ" trên màn hình. (Diễn giải mục B "bỏ DK đã ghi sổ từ màn hình số dư đầu kỳ" là thao tác bỏ ghi sổ tại màn hình này; ghi vào sổ quyết định.)

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
// VoucherForm.test.tsx
it('Phiếu thu: hiện người nộp, lý do, kèm theo; chọn "Thu tiền khách hàng" điền 131 vào dòng đối ứng', async () => {});
it('chứng từ đã ghi sổ ở kỳ khóa mềm: không có nút Bỏ ghi sổ, có Đảo; Đảo hỏi ngày và gửi ngày đã chọn', async () => {});
it('/chung-tu/phieu-ke-toan chuyển sang /chung-tu/PKT', async () => {});
// openingBalance.test.ts
it('bỏ ghi sổ số dư đầu kỳ từ màn hình số dư; route chung vẫn từ chối', async () => {});
```

```ts
// e2e/phieu-thu.spec.ts
test('lập Phiếu thu bằng bàn phím, ghi sổ F9, in 01-TT', async ({ page, request }) => {
  await signIn(page, request); await page.goto('/chung-tu/PT');
  await page.keyboard.press('Insert'); await expect(page.getByText('Phiếu thu (mới)')).toBeVisible();
  // chọn mục đích Thu tiền khách hàng, đối tượng F4, số tiền ở dòng 1111, Ctrl+S, F9 → trạng thái "Đã ghi sổ", số PT00001
});
```

- [ ] **Step 2:** `pnpm -F @kt/web test`, `pnpm -F @kt/api test -- test/openingBalance.test.ts` → FAIL.
- [ ] **Step 3:** Cài đặt theo skill `evon:ui-ux` (dựng luôn).
- [ ] **Step 4:** `pnpm -F @kt/web test`, `pnpm -F @kt/api test`, `pnpm -F @kt/web e2e -- phieu-thu.spec.ts phieu-ke-toan.spec.ts` xanh.
- [ ] **Step 5:** Commit `feat(web): màn hình chứng từ dùng chung theo loại, Đảo chọn ngày, bỏ ghi sổ số dư đầu kỳ`.

### Task 7: Mẫu in Phiếu thu, Phiếu chi, Giấy báo Nợ/Có, Ủy nhiệm chi

Model: sonnet.

**Files:**
- Modify: `apps/api/src/modules/reporting/print/forms.ts`, `apps/api/src/modules/reporting/print/voucherHtml.ts`, `apps/api/src/modules/ledger/vouchers.routes.ts` (route in nhận `form`), `packages/domain/src/format.ts` (đọc số thành chữ nếu chưa có)
- Create: `apps/api/src/modules/reporting/print/cashVoucherHtml.ts`
- Test: `apps/api/test/voucherPrint.test.ts`, `packages/domain/test/format.test.ts`

**Interfaces:**
- `GET /api/vouchers/:id/print?format=html|pdf&form=default|unc`; `form` hợp lệ lấy từ `VOUCHER_TYPES[type].printForms` (PT: `['01-TT']`, PC: `['02-TT']`, BC/BN: `['giay-bao']`, BN thêm `'unc'`), sai → 400 `PRINT_FORM_INVALID`.
- `FORMS` thêm khóa `01-TT`, `02-TT` theo chế độ sau khi đối chiếu văn bản gốc: TT133 (`~/legal-docs/tt133-2016/tt133-full.txt` dòng ~11415, "Mẫu số 01-TT", "Mẫu số 02-TT"), TT99 (`~/legal-docs/tt99-2025/tt99-full.txt` dòng ~9351, danh mục chứng từ). Bố cục (người nộp/nhận, địa chỉ, lý do, số tiền, viết bằng chữ, kèm theo … chứng từ gốc, chữ ký Giám đốc/Kế toán trưởng/Người lập/Thủ quỹ/Người nộp) chép theo mẫu trong văn bản; phần nào văn bản không có thì không in tiêu đề "Mẫu số".
- Giấy báo Nợ/Có và Ủy nhiệm chi: mẫu nội bộ (không ghi "Mẫu số"), UNC chung một bố cục (đơn vị trả tiền, số tài khoản, ngân hàng; đơn vị thụ hưởng từ `party_bank_account`; số tiền bằng số và chữ). Mẫu riêng từng ngân hàng: ghi "Chờ người dùng" (cần mẫu giấy của ngân hàng).
- `export function vndInWords(amount: string): string` (domain): "Một triệu năm trăm nghìn đồng" (viết hoa chữ đầu, "linh"/"lẻ" theo cách đọc phổ thông "lẻ", "mốt", "tư", "lăm").

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it.each([['1500000', 'Một triệu năm trăm nghìn đồng'], ['21', 'Hai mươi mốt đồng'], ['105', 'Một trăm lẻ năm đồng'], ['1000000000000', 'Một nghìn tỷ đồng'], ['0', 'Không đồng']])('vndInWords(%s)', (a, w) => expect(vndInWords(a)).toBe(w));
it('in Phiếu thu TT133: tiêu đề Mẫu số 01-TT, số tiền bằng chữ, người nộp', async () => {});
it('in UNC cho Giấy báo Nợ có tài khoản thụ hưởng; form=unc với Phiếu thu bị từ chối', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt. **Step 4:** `pnpm -F @kt/domain test`, `pnpm -F @kt/api test -- test/voucherPrint.test.ts test/print.test.ts` xanh.
- [ ] **Step 5:** Commit `feat(api): mẫu in phiếu thu 01-TT, phiếu chi 02-TT, giấy báo nợ/có và ủy nhiệm chi`.

### Task 8: Số dư tại ngày, Sổ quỹ tiền mặt, Sổ tiền gửi ngân hàng

Model: sonnet.

**Files:**
- Create: `apps/api/src/modules/cash/books.ts`, `apps/api/src/modules/cash/routes.ts`, `apps/web/src/pages/CashBooks.tsx`, `apps/web/e2e/so-quy.spec.ts`
- Modify: `apps/api/src/app.ts` (đăng ký route), `apps/api/src/modules/ledger/vouchers.routes.ts` (cảnh báo tồn quỹ âm khi ghi sổ), `apps/api/src/modules/core/settings.ts` (khóa `cash_negative`), `apps/api/src/modules/reporting/print/forms.ts`, `apps/web/src/router.tsx`
- Test: `apps/api/test/cashBooks.test.ts`, `apps/web/test/CashBooks.test.tsx`

**Interfaces:**
- `GET /api/cash/balance?accountCode=&bankAccountNo=&currency=&asOf=` (quyền `voucher.view`) → `{ debit: string; credit: string; balance: string; balanceCurrency: string }` từ dòng đã ghi sổ đến hết `asOf` (dùng `fn_balances_at` cho tài khoản; lọc `bank_account_id` khi có `bankAccountNo` thì cộng thẳng từ `voucher_line`).
- `GET /api/reports/cash-book?accountCode=1111&from&to&currency&format=json|xlsx|pdf` (quyền `report.view`): dòng `{ date, documentDate, voucherId, voucherNo, receiptNo, paymentNo, description, counterAccounts, in, out, balance, inCurrency, outCurrency, balanceCurrency }`, đầu kỳ, cộng phát sinh, cuối kỳ; số phiếu thu/chi tách cột theo loại PT/PC (các loại khác ghi vào cột theo chiều Nợ/Có).
- `GET /api/reports/bank-book?bankAccountNo=&from&to&format=…`: như trên nhưng lọc `voucher_line.bank_account_id`; `bankAccountNo` rỗng và `accountCode` có → các dòng chưa gán tài khoản ngân hàng gom ở nhóm "Chưa gán tài khoản ngân hàng".
- Mẫu số: sổ quỹ và sổ tiền gửi tra trong văn bản gốc TT133/TT99 (tìm "Sổ quỹ tiền mặt", "Sổ tiền gửi ngân hàng"); có thì thêm khóa vào `FORMS`, không có thì in không "Mẫu số".
- `tenant_setting` khóa `cash_negative`: `'warn'` (mặc định) | `'block'`. Khi ghi sổ chứng từ làm số dư một tài khoản tiền mặt/tài khoản ngân hàng âm tại ngày ghi sổ: `warn` → phản hồi ghi sổ thêm `warnings: [{ code: 'CASH_NEGATIVE', message }]`; `block` → 409 `CASH_NEGATIVE`.
- Ghi sổ đọc trong `READ_SNAPSHOT`; tồn quỹ hiện trên biểu mẫu chứng từ PT/PC/BC/BN (gọi `/api/cash/balance` theo ngày hạch toán).

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('sổ quỹ: đầu kỳ, thu, chi, tồn sau từng dòng; cuối kỳ = số dư 1111 tại ngày', async () => {});
it('sổ tiền gửi theo từng tài khoản ngân hàng cùng tài khoản 1121', async () => { /* hai bank_account cùng 1121, mỗi sổ chỉ thấy dòng của mình; nhóm chưa gán */ });
it('ngoại tệ: sổ quỹ 1112 USD có cột nguyên tệ', async () => {});
it('chi quá tồn quỹ: warn trả cảnh báo; block trả 409 CASH_NEGATIVE và không ghi sổ', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt; trang "Sổ quỹ và tiền gửi" (tab Sổ quỹ / Sổ tiền gửi, bộ lọc nhớ, xuất Excel/PDF, nhấn dòng mở chứng từ).
- [ ] **Step 4:** `pnpm -F @kt/api test -- test/cashBooks.test.ts`, `pnpm -F @kt/web test`, `pnpm -F @kt/web e2e -- so-quy.spec.ts` xanh.
- [ ] **Step 5:** Commit `feat(cash): số dư tại ngày, sổ quỹ tiền mặt, sổ tiền gửi ngân hàng, cảnh báo tồn quỹ âm`.

### Task 9: Kiểm kê quỹ

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0026_kiem_ke_quy.sql`, `apps/api/src/modules/cash/cashCount.ts`, `apps/web/src/pages/CashCount.tsx`, `apps/web/e2e/kiem-ke-quy.spec.ts`
- Modify: `apps/api/src/modules/cash/routes.ts`, `packages/db/src/types.ts`, `apps/web/src/router.tsx`
- Test: `apps/api/test/cashCount.test.ts`

**Interfaces:**
- Bảng `cash_count (id bigint identity PK, tenant_id, count_date date, account_id bigint, currency_code char(3), book_balance numeric(20,0), book_balance_currency numeric(20,4), denominations jsonb NOT NULL DEFAULT '[]' /* [{ "value": "500000", "qty": 3 }] */, counted_total numeric(20,4), difference numeric(20,4), members jsonb, note text, voucher_id uuid, created_by uuid, created_at timestamptz)`; FK tổng hợp tới `account`, `currency`, `voucher`; RLS + audit.
- `POST /api/cash-counts` (quyền `cash_count.create`) thân `{ countDate, accountCode, currency, denominations, members, note }`: `book_balance` lấy từ số dư tại ngày (Task 8), `counted_total = Σ value × qty` (decimal), `difference = counted_total − book`. `POST /api/cash-counts/:id/settle` thân `{ accountCode }` (TK xử lý chênh lệch, mặc định thừa `3381`, thiếu `1381`; mã theo chế độ có thể khác, tra bằng `accountsUnder`): tạo Phiếu thu (thừa) hoặc Phiếu chi (thiếu) nháp có `source_doc_type='cash_count'`, `source_doc_id` là id kiểm kê, lưu `voucher_id`. Đã có `voucher_id` → 409 `CASH_COUNT_SETTLED`.
- `GET /api/cash-counts/:id/print` in Bảng kiểm kê quỹ (mẫu số tra văn bản gốc như Task 7).

- [ ] **Step 1: Kiểm thử thất bại:** tạo kiểm kê với mệnh giá → `counted_total`, `difference` đúng; xử lý thiếu 50.000 sinh PC nháp Nợ 1381/Có 1111 50.000; xử lý lần hai 409; kiểm kê công ty khác 404.
- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt; màn hình: lưới mệnh giá (`KeyboardGrid`), tổng tự tính, nút "Xử lý chênh lệch".
- [ ] **Step 4:** `pnpm db:migrate`; `pnpm -F @kt/api test -- test/cashCount.test.ts`; `pnpm -F @kt/web e2e -- kiem-ke-quy.spec.ts` xanh.
- [ ] **Step 5:** Commit `feat(cash): kiểm kê quỹ và xử lý chênh lệch`.

### Task 10: Tỷ giá theo ngày và tỷ giá xuất quỹ

Model: **opus**.

**Files:**
- Create: `packages/db/migrations/0027_ty_gia_xuat_quy.sql`, `packages/domain/src/fx.ts`, `apps/api/src/modules/cash/fx.ts`
- Modify: `apps/api/src/modules/cash/routes.ts`, `apps/api/src/modules/core/settings.ts`, `packages/domain/src/index.ts`
- Test: `packages/domain/test/fx.test.ts`, `apps/api/test/fxOutflow.test.ts`

**Interfaces:**
- Domain: `export function toVnd(amountCurrency: string, rate: string): string` (làm tròn nửa lên về đồng); `export function avgRate(balanceVnd: string, balanceCurrency: string): string | null` (10 chữ số thập phân, `null` khi nguyên tệ = 0); `export function proportionalVnd(residualVnd: string, residualCurrency: string, part: string): string` (bằng `residualVnd` khi `part = residualCurrency`).
- `GET /api/fx/rate?currency&date&type=transfer_avg|buy|sell` → tỷ giá có `rate_date` lớn nhất ≤ `date`; không có → 409 `FX_RATE_MISSING`.
- `tenant_setting` `fx_outflow_method`: `'moving_average'` (mặc định) | `'specific'` (người dùng nhập tỷ giá). FIFO không làm.
- `GET /api/fx/outflow-rate?accountCode&bankAccountNo&currency&date` → `{ rate: string | null, balance, balanceCurrency }`: bình quân di động = số dư VND / số dư nguyên tệ của (tài khoản, tài khoản ngân hàng, loại tiền) đến hết `date` (dòng đã ghi sổ). Biểu mẫu PC/BN/CT ngoại tệ điền sẵn tỷ giá này vào `fxRate` tiêu đề khi phương pháp là bình quân.
- Bảng `fx_run (id bigint identity PK, tenant_id, kind text CHECK (kind IN ('outflow','revaluation')), fiscal_year int, period_no int, run_date date, voucher_ids uuid[] NOT NULL DEFAULT '{}', reversed_voucher_ids uuid[] NOT NULL DEFAULT '{}', params jsonb, created_by uuid, created_at timestamptz)`; RLS + audit. Dùng chung với Task 13.
- `POST /api/fx/outflow-adjust` (quyền `fx.run`) thân `{ fiscalYear, periodNo }`: thuật toán, cho mỗi (tài khoản `subledger_kind IN ('cash','bank')`, `bank_account_id`, loại tiền ≠ VND):

```
duyệt dòng đã ghi sổ theo (posting_date, chiều: Nợ trước Có, posted_at, line_no), bỏ chứng từ XQ của chính kỳ đang chạy:
  dòng Nợ (vào):    sdVND += debit; sdNT += amount_currency
  dòng Có (ra) trong kỳ đang chạy: đúng = toVnd(−amount_currency, avgRate(sdVND, sdNT)); lệch += (credit − đúng); sdVND −= đúng; sdNT += amount_currency
  dòng Có ngoài kỳ đang chạy: sdVND −= credit; sdNT += amount_currency
```
  Tổng `lệch` khác 0 → một chứng từ `XQ` ngày cuối kỳ, mỗi nhóm một cặp dòng: dòng tiền (cùng tài khoản, `bank_account_id`, loại tiền, `amount_currency = 0`, `fx_rate NULL`) Nợ `lệch` nếu đã ghi Có thừa, ngược lại Có; đối ứng 515 (lãi) / 635 (lỗ) đọc từ `packages/coa-data/data/tax/fx-rules.json`. Task này tạo tệp với khóa `gainAccount`, `lossAccount` theo chế độ (kèm `source`) và hàm `loadFxRules(regime): FxRules` trong `packages/coa-data/src/load.ts`; Task 12 dùng lại, Task 13 bổ sung các khóa đánh giá lại. `source_doc_type='fx_outflow'`, `source_doc_id` = id `fx_run`. Chạy lại cùng kỳ: đảo các `XQ` của lần trước (ngày đảo = ngày cuối kỳ nếu kỳ mở, ngày hôm nay theo `todayVn` nếu kỳ khóa mềm và có quyền ghi lùi, kỳ khóa cứng → 409 `PERIOD_HARD_LOCKED`) rồi sinh mới; ghi `reversed_voucher_ids`.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
// fx.test.ts (fast-check)
it('proportionalVnd: chia nhiều lần cộng lại đúng bằng số dư VND', () => { fc.assert(fc.property(/* residual, các phần cộng = residualCurrency */ (…) => sum(parts.map(...)) === residualVnd)); });
// fxOutflow.test.ts
it('bình quân di động tại ngày: nhập 1000 USD @25.000, 1000 USD @25.400 → xuất @25.200', async () => {});
it('phiếu chi ghi lùi ngày trước phiếu chi đã có: chạy tính lại sinh XQ, sau đó số dư VND 1122 = Σ nguyên tệ × bình quân cuối', async () => {});
it('chạy lại cùng kỳ đảo XQ cũ, chỉ còn một XQ hiệu lực; không lệch thì không sinh chứng từ', async () => {});
it('XQ không bỏ ghi sổ/hủy được qua route chung', async () => { /* 409 VOUCHER_SYSTEM_GENERATED */ });
it('thiếu tỷ giá ngày → 409 FX_RATE_MISSING', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt (thuật toán tính lại viết trong TypeScript đọc dòng theo thứ tự trong một giao dịch có `pg_advisory_xact_lock(hashtext('fx_outflow'), hashtext(tenant))`, ghi chứng từ qua `createVoucher` nội bộ bỏ qua `assertNotSystemType` + `post_voucher`).
- [ ] **Step 4:** `pnpm db:migrate`; `pnpm -F @kt/domain test`, `pnpm -F @kt/api test -- test/fxOutflow.test.ts` xanh.
- [ ] **Step 5:** Commit `feat(cash): tỷ giá theo ngày, tỷ giá xuất quỹ bình quân di động và chứng từ điều chỉnh cuối kỳ`.

### Task 11: Công nợ theo chứng từ: `open_item`, `settlement`, móc vào ghi sổ, số dư đầu kỳ theo hóa đơn

Model: **opus**.

**Files:**
- Create: `packages/db/migrations/0028_cong_no.sql`, `apps/api/src/modules/arap/openItems.ts`, `apps/api/src/modules/arap/routes.ts`
- Modify: `packages/db/src/types.ts`, `apps/api/src/app.ts`, `apps/api/src/modules/ledger/openingBalance.ts` (cột chứng từ/hạn), `apps/web/src/pages/OpeningBalance.tsx` (cột Số chứng từ, Ngày chứng từ, Hạn thanh toán cho tài khoản công nợ)
- Test: `packages/db/test/openItem.test.ts`, `apps/api/test/openItems.test.ts`, `apps/api/test/openingBalance.test.ts`

**Interfaces:**
- `ALTER TABLE voucher_line ADD UNIQUE (tenant_id, id, posting_date)` (khóa của bảng phân vùng phải gồm `posting_date`).
- `open_item (id bigint identity PK, tenant_id, voucher_id uuid NOT NULL, voucher_line_id bigint NOT NULL, line_posting_date date NOT NULL, line_no int NOT NULL, account_id bigint NOT NULL, party_id uuid NOT NULL, currency_code char(3) NOT NULL, doc_date date NOT NULL, doc_no text, due_date date, amount numeric(20,0) NOT NULL /* Nợ − Có, có dấu */, amount_currency numeric(20,4) NOT NULL, parent_id bigint /* dòng điều chỉnh đánh giá lại của khoản gốc */, invoice_id bigint /* Task 18 thêm FK */, UNIQUE (tenant_id, voucher_line_id, line_posting_date), UNIQUE (tenant_id, id))`; FK tổng hợp tới `voucher`, `voucher_line (tenant_id, id, posting_date)`, `account`, `party`, `open_item(parent_id)`; chỉ mục `(tenant_id, account_id, party_id, doc_date)`. RLS; **không** `audit_enable` (dữ liệu sinh từ ghi sổ, ghi sổ đã có audit; ghi vào sổ quyết định).
- `settlement (id bigint identity PK, tenant_id, debit_item_id bigint NOT NULL, credit_item_id bigint NOT NULL, amount numeric(20,0) NOT NULL CHECK (amount >= 0), amount_currency numeric(20,4) NOT NULL CHECK (amount_currency >= 0), settle_date date NOT NULL, kind text NOT NULL CHECK (kind IN ('manual','auto','plan','reversal','fx')), fx_voucher_id uuid, group_id uuid NOT NULL /* các dòng của một lần đối trừ, hủy cùng nhau */, created_by uuid, created_at timestamptz DEFAULT now(), CHECK (amount > 0 OR amount_currency > 0))`; FK tổng hợp; RLS + audit; `REVOKE UPDATE ON settlement FROM app_user`.
- Dư còn lại tại ngày: khoản Nợ `amount − Σ settlement.amount (debit_item_id, settle_date ≤ d)`; khoản Có `amount + Σ (credit_item_id …)`; nguyên tệ tương tự. Hàm `fn_open_items_at(p_tenant uuid, p_date date) RETURNS TABLE (item_id bigint, account_id bigint, party_id uuid, currency_code char(3), doc_date date, due_date date, residual numeric, residual_currency numeric)` (khoản có `doc_date ≤ p_date`).
- Tài khoản có công nợ: `account.reconcile = true`; migration đặt `reconcile = true` cho mọi tài khoản `subledger_kind IN ('receivable','payable')` của mọi công ty và sửa chỗ sinh tài khoản cho công ty mới (`generateAccountsSql`/`coa` service, tìm `subledger_kind` khi chèn `account`).
- `fn_open_items_create(p_voucher uuid) RETURNS int`: chèn một `open_item` cho mỗi dòng có `account.reconcile` và `party_id`; `doc_no` = số chứng từ (DK: `voucher_line.description` chứa số chứng từ gốc nhập ở số dư đầu kỳ, hoặc cột riêng nếu đã thêm), `due_date` = `voucher_line.due_date` ?? `voucher.due_date` ?? `doc_date + party.payment_term_days` (nếu có).
- `post_voucher` định nghĩa lại (thân hiện hành) gọi `fn_open_items_create` sau `fn_build_pairs`. `unpost_voucher`: trước khi đổi trạng thái, có `settlement` trên khoản của chứng từ → `OPEN_ITEM_SETTLED: chứng từ đã đối trừ công nợ, hãy hủy đối trừ trước`; không có thì `DELETE FROM open_item WHERE voucher_id = p_id`. `reverse_voucher`: kiểm tra như unpost (409 cùng mã); sau khi chứng từ đảo được ghi sổ, đối trừ từng cặp (khoản gốc, khoản đảo cùng `line_no`) với `kind='reversal'`, `settle_date` = ngày đảo.
- Backfill trong migration: tạo `open_item` cho mọi chứng từ đã ghi sổ hoặc đã đảo (trạng thái `posted`, `reversed`) và đối trừ `reversal` cho các cặp gốc/đảo đã có. Tắt audit của `settlement` khi backfill.
- Số dư đầu kỳ: `opening_balance` thêm `doc_no text, doc_date date, due_date date`; chỉ mục duy nhất thay bằng `(tenant_id, fiscal_year, account_id, coalesce(party_id, nil), currency_code, coalesce(doc_no, ''))`; dòng DK sinh ra mang `due_date` và `description = 'Số dư ' || doc_no`; `fn_open_items_create` lấy `doc_no`/`doc_date` từ `opening_balance` khi chứng từ là DK (nối qua `extra_dims->>'opening_doc_no'`, `extra_dims->>'opening_doc_date'` ghi lúc `postOpening`).
- API: `GET /api/open-items?accountCode&partyCode&asOf&onlyOpen=true` (quyền `settlement.view` + cờ theo tài khoản qua `sensitiveDenial`) → `{ id, voucherId, voucherNo, voucherType, docNo, docDate, dueDate, currency, amount, amountCurrency, residual, residualCurrency }[]`.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('ghi sổ chứng từ có dòng 131 sinh một open_item mỗi dòng; bỏ ghi sổ xóa', async () => {});
it('chứng từ đã đối trừ: bỏ ghi sổ và đảo đều 409 OPEN_ITEM_SETTLED, không đổi trạng thái', async () => {
  // settle bằng INSERT settlement trực tiếp (admin) để không phụ thuộc Task 12
});
it('đảo chứng từ chưa đối trừ: khoản gốc và khoản đảo tự đối trừ, dư còn lại 0', async () => {});
it('tổng dư open_item = số dư 131/331 theo đối tượng tại mỗi cuối tháng sau một chuỗi thao tác cố định', async () => {});
it('số dư đầu kỳ công nợ theo từng hóa đơn: hai hóa đơn cùng khách sinh hai open_item có hạn riêng', async () => {});
it('backfill: DB có chứng từ GĐ1 (seed XYZ) sau migration có open_item khớp số dư', async () => { /* kiểm trên DB tạm đã seed XYZ trước khi áp 0027: dùng migrate tới 0026, seed, migrate tiếp */ });
it('người không có view_receivable không xem được open-items của 131', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Viết migration (thân `post_voucher`/`unpost_voucher`/`reverse_voucher` lấy bằng `pg_get_functiondef`), `openItems.ts`, route.
- [ ] **Step 4:** `pnpm db:migrate` dev (có seed ABC/XYZ); `pnpm -F @kt/db test`, `pnpm -F @kt/api test`, `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts` xanh.
- [ ] **Step 5:** Commit `feat(db): công nợ theo chứng từ open_item/settlement sinh khi ghi sổ, số dư đầu kỳ công nợ theo hóa đơn`.

### Task 12: Đối trừ: thủ công, tự động, thu/chi từ hóa đơn, bù trừ, hủy đối trừ, chênh lệch tỷ giá thực hiện

Model: **opus**.

**Files:**
- Create: `packages/db/migrations/0029_doi_tru.sql`, `apps/api/src/modules/arap/settlement.ts`
- Modify: `apps/api/src/modules/arap/routes.ts`, `apps/api/src/modules/ledger/vouchers.service.ts` (kế hoạch đối trừ gửi kèm chứng từ), `packages/db/src/types.ts`
- Test: `apps/api/test/settlement.test.ts`

**Interfaces:**
- SQL `settle_open_items(p_debit bigint, p_credit bigint, p_amount_currency numeric, p_amount numeric, p_date date, p_kind text, p_group uuid) RETURNS bigint[]` (id các `settlement` tạo ra). Quy tắc:
  - Hai khoản cùng tài khoản, cùng đối tượng, cùng loại tiền; khác → `SETTLEMENT_MISMATCH` (409). Khoản Nợ phải dư > 0, khoản Có dư < 0; số đối trừ vượt dư → `SETTLEMENT_EXCEEDS_RESIDUAL`.
  - `settle_date = max(p_date, doc_date hai khoản)`; kỳ của `settle_date` phải ghi được (`fn_assert_period_writable(…, 'arap')`).
  - VND: `p_amount` là số đối trừ (bắt buộc), `p_amount_currency` bỏ qua (0).
  - Ngoại tệ (công thức tỷ lệ viết lại bằng SQL giống hệt `proportionalVnd` của domain; kiểm thử chéo cùng bộ số): `q = p_amount_currency`; `aD = proportionalVnd(dư VND Nợ, dư NT Nợ, q)`, `aC = proportionalVnd(|dư VND Có|, |dư NT Có|, q)`; dòng 1: `settlement(amount = min(aD, aC), amount_currency = q)`. Nếu `aD ≠ aC`: sinh chứng từ `CL` ngày `settle_date` (`source_doc_type='settlement_fx'`, `source_doc_id = p_group`): `aC > aD` (thu nhiều VND hơn ghi sổ, lãi) → Nợ TK công nợ `aC − aD` (loại tiền của khoản, `amount_currency = 0`, `fx_rate NULL`, cùng đối tượng) / Có 515; `aD > aC` (lỗ) → Nợ 635 / Có TK công nợ. Khoản mới sinh từ dòng `CL` được đối trừ ngay với khoản còn dư VND (`kind='fx'`, `amount_currency = 0`). Tài khoản lãi/lỗ đọc từ `fx-rules.json` theo chế độ của kỳ. Kết quả: mọi khoản về đúng dư VND tỷ lệ với dư nguyên tệ (kiểm thử bằng số cụ thể dưới đây).
  - Khoản có `parent_id` (điều chỉnh đánh giá lại, Task 13): khi đối trừ khoản gốc, dư VND dùng để tính `aD/aC` là dư của khoản gốc cộng dư các khoản con; các khoản con được đối trừ trước (`amount_currency = 0`) theo tỷ lệ `q / dư NT gốc`.
- `unsettle(p_group uuid) RETURNS void`: xóa mọi `settlement` của nhóm (audit ghi trước/sau), đảo chứng từ `CL` của nhóm (ngày đảo = `settle_date` nếu kỳ mở, ngược lại 409 `PERIOD_SOFT_LOCKED`/`PERIOD_HARD_LOCKED`; khoản của chứng từ đảo tự đối trừ với khoản `CL` theo quy tắc đảo của Task 11). Nhóm `kind='reversal'` không hủy được → 409 `SETTLEMENT_REVERSAL_LOCKED`.
- `auto_settle(p_account bigint, p_party uuid, p_date date) RETURNS int` (số nhóm tạo): ghép khoản Có còn dư với khoản Nợ còn dư cùng loại tiền theo thứ tự hạn thanh toán (`coalesce(due_date, doc_date)`) rồi `doc_date`, id; mỗi cặp một nhóm `kind='auto'`.
- Kế hoạch đối trừ (thu/chi từ hóa đơn, bù trừ): bảng `settlement_plan (id bigint identity PK, tenant_id, voucher_id uuid NOT NULL, line_no int NOT NULL, open_item_id bigint NOT NULL, amount numeric(20,0), amount_currency numeric(20,4))`; FK tổng hợp; khóa theo trạng thái chứng từ (chỉ ghi khi `voucher.state = 'draft'`, trigger `fn_voucher_child_guard()` mới dùng lại ở Task 18). `post_voucher` định nghĩa lại: sau `fn_open_items_create`, với mỗi dòng kế hoạch gọi `settle_open_items(khoản của dòng line_no, open_item_id, …, kind 'plan')` (đúng chiều Nợ/Có), rồi xóa kế hoạch. `lineInput` thêm `settle: z.array(z.object({ openItemId: z.number().int(), amount: vndAmount.optional(), amountCurrency: foreignAmount.optional() })).max(500).optional()`.
- Bù trừ công nợ: chứng từ `BT` (Task 4) Nợ 331 / Có 131 cùng đối tượng, mỗi dòng có `settle` trỏ khoản cần bù; không cần logic riêng.
- API (quyền `settlement.create`/`settlement.delete`, cờ theo tài khoản): `POST /api/settlements` thân `{ debitItemId, creditItemId, amount?, amountCurrency?, date? }` → `{ groupId, settlementIds, fxVoucherId }`; `POST /api/settlements/auto` thân `{ accountCode, partyCode?, date }` → `{ groups: number }`; `DELETE /api/settlements/groups/:groupId` → 204; `GET /api/settlements?partyCode&accountCode&from&to`.

- [ ] **Step 1: Kiểm thử thất bại** (số cụ thể, tỷ giá có sẵn trong `exchange_rate`):

```ts
it('thu đủ 1.000 USD ghi sổ 25.000 bằng 25.400: CL lãi 400.000, mọi khoản về 0', async () => {
  // HĐ: Nợ 131 KH001 USD 1000 @25000 = 25.000.000; Thu: BC Nợ 1122 / Có 131 USD 1000 @25400 = 25.400.000
  const r = await settle({ debitItemId: inv, creditItemId: rcv, amountCurrency: '1000' });
  expect(await fxVoucherLines(r.fxVoucherId)).toEqual([{ account: '131', debit: '400000' }, { account: '515', credit: '400000' }]);
  expect(await residual(inv)).toEqual({ vnd: '0', cur: '0' }); expect(await residual(rcv)).toEqual({ vnd: '0', cur: '0' });
});
it('thu một phần 500 USD @25.400: lãi 200.000; khoản HĐ còn 12.500.000 / 500 USD', async () => {});
it('tỷ giá giảm: thu 1.000 USD @24.800 → CL lỗ 200.000 Nợ 635', async () => {});
it('hủy đối trừ: xóa settlement, đảo CL, dư trở lại như trước; ghi audit_event', async () => {});
it('đối trừ tự động theo hạn thanh toán sớm nhất trước', async () => {});
it('phiếu thu từ hóa đơn: ghi sổ áp kế hoạch; bỏ ghi sổ sau đó bị chặn vì đã đối trừ', async () => {});
it('bù trừ công nợ: khách hàng đồng thời là NCC, BT Nợ 331 / Có 131 có settle cả hai phía', async () => {});
it('đối trừ khác loại tiền, vượt dư, kỳ khóa: 409 với mã riêng', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt (SQL cho `settle_open_items`/`unsettle`/`auto_settle` để seed và kiểm thử dùng chung; `settlement.ts` chỉ dịch mã → id và gọi hàm).
- [ ] **Step 4:** `pnpm db:migrate`; `pnpm -F @kt/api test -- test/settlement.test.ts test/openItems.test.ts` xanh; `pnpm -F @kt/api test` xanh.
- [ ] **Step 5:** Commit `feat(arap): đối trừ thủ công/tự động, thu chi từ hóa đơn, bù trừ, hủy đối trừ, chênh lệch tỷ giá thực hiện`.

### Task 13: Đánh giá lại số dư ngoại tệ cuối kỳ

Model: **opus**.

**Files:**
- Create: `apps/api/src/modules/cash/revaluation.ts`
- Modify: `packages/coa-data/data/tax/fx-rules.json` (thêm khóa đánh giá lại), `packages/coa-data/src/load.ts` (kiểu `FxRules` thêm trường), `apps/api/src/modules/cash/routes.ts`, `packages/coa-data/data/tax/status.json`
- Test: `apps/api/test/fxRevaluation.test.ts`, `packages/coa-data/test/fxRules.test.ts`

**Interfaces:**
- `fx-rules.json`: `{ "TT133": { "revalAccount": "413", "gainAccount": "515", "lossAccount": "635", "transferToPnl": true, "assetRate": "…", "liabilityRate": "…", "source": "Điều … TT 133/2016" }, "TT99": {…}, "TT200": {…} }`. Giá trị nhập từ văn bản gốc (`~/legal-docs/tt133-2016/tt133-full.txt`, `~/legal-docs/tt99-2025/tt99-full.txt`: tìm "đánh giá lại", "tỷ giá"), mỗi chế độ có `source` nêu điều/khoản; chưa xác định được loại tỷ giá cho tài sản/nợ phải trả thì để `"transfer_avg"` và `status.json` `"fxRules_TT99": false` kèm ghi chú (người dùng chọn lại ở tham số `fx_reval_rate_asset`/`fx_reval_rate_liability` của `tenant_setting`).
- `POST /api/fx/revaluation` (quyền `fx.run`) thân `{ date, rates?: Record<string, string> }` (thiếu tỷ giá thì lấy theo `GET /api/fx/rate` loại cấu hình):
  1. Khoản công nợ ngoại tệ còn dư tại `date` (`fn_open_items_at`): chênh = `toVnd(dư NT, tỷ giá) − dư VND nhóm (gốc + con)`; mỗi khoản ≠ 0 một dòng trên TK công nợ (đối tượng, loại tiền, `amount_currency = 0`, `fx_rate NULL`); `open_item` của dòng này có `parent_id` = khoản gốc (đặt trong `fn_open_items_create` khi `voucher.source_doc_type = 'fx_revaluation'`, đọc id khoản gốc từ `voucher_line.extra_dims->>'reval_of'`).
  2. Tiền ngoại tệ (tài khoản `cash`/`bank`, theo `bank_account_id`, loại tiền): chênh = `toVnd(số dư NT, tỷ giá) − số dư VND`.
  3. Đối ứng `revalAccount` (413). Một chứng từ `DG` ngày `date`, `source_doc_type='fx_revaluation'`, `source_doc_id` = id `fx_run`.
  4. `transferToPnl = true`: chứng từ `DG` thứ hai cùng ngày kết chuyển số dư ròng 413 do bước 3 sinh sang 515/635.
  Chạy lại cùng ngày: đảo `DG` cũ rồi sinh mới (như Task 10), ghi `fx_run`.
- Tổng dư `open_item` vẫn bằng số dư sổ cái theo đối tượng sau đánh giá lại (khoản con mang phần chênh).

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('đánh giá lại 1.000 USD phải thu ghi sổ 25.000 tại 25.600: DG Nợ 131 600.000 / Có 413; kết chuyển 413 → 515', async () => {});
it('đánh giá lại tiền gửi 1122 theo từng tài khoản ngân hàng', async () => {});
it('sau đánh giá lại, thu nốt 1.000 USD @25.500: CL lỗ 100.000 (so với 25.600), không phải lãi 500.000 so với tỷ giá gốc', async () => {});
it('chạy lại cùng ngày đảo DG cũ; tổng dư open_item = số dư 131 theo đối tượng trước và sau', async () => {});
it('fx-rules.json mỗi chế độ có source và tài khoản tồn tại trong mẫu hệ thống tài khoản', () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Đọc văn bản gốc, điền `fx-rules.json`, cài đặt.
- [ ] **Step 4:** `pnpm -F @kt/coa-data test`, `pnpm -F @kt/api test -- test/fxRevaluation.test.ts test/settlement.test.ts` xanh.
- [ ] **Step 5:** Commit `feat(cash): đánh giá lại số dư ngoại tệ cuối kỳ, kết chuyển chênh lệch theo chế độ`.

### Task 14: Bất biến 5 (công nợ) bằng fast-check

Model: sonnet.

**Files:**
- Create: `apps/api/test/invariants/inv5-cong-no.test.ts`
- Modify: `apps/api/test/invariants/helpers.ts` (`openItemsByParty(ctx, tenantId, asOf)`, `arbFxOps`)

**Interfaces:**
- Consumes: `fn_open_items_at` (T11), `/api/settlements`, `/api/settlements/auto`, `DELETE /api/settlements/groups/:id` (T12), `/api/fx/revaluation` (T13), `postVoucher`, `sumFromLines` (helpers sẵn có).
- `openItemsByParty(ctx, tenantId, asOf): Promise<Record<string, string>>` khóa `mã TK|mã đối tượng` → Σ dư VND (bỏ khóa có tổng 0).
- `onlyPartyAccounts(keyed: Record<string, string>): Record<string, string>`: từ kết quả `sumFromLines` (khóa `TK|đối tượng|tiền tệ`) giữ tài khoản `reconcile`, cộng gộp các loại tiền về khóa `TK|đối tượng`, bỏ tổng 0.

- [ ] **Step 1: Viết thuộc tính** (bỏ qua khi không có `INVARIANTS=1`, như các bất biến khác):

```ts
it('chuỗi ngẫu nhiên ghi sổ/đảo/bỏ ghi sổ/đối trừ/hủy đối trừ/đối trừ tự động/đánh giá lại: Σ dư open_item = số dư 131, 331 theo đối tượng tại mọi ngày', async () => {
  await fc.assert(fc.asyncProperty(fc.array(arbArapOp, { minLength: 5, maxLength: 25 }), fc.array(arbDate2026, { minLength: 3, maxLength: 6 }), async (ops, dates) => {
    for (const op of ops) expect(await apply(op)).toSatisfy(expectedStatus(op)); // 5xx hoặc 4xx ngoài dự kiến là lỗi
    for (const d of dates) expect(await openItemsByParty(ctx, tenantId, d)).toEqual(onlyPartyAccounts(await sumFromLines(ctx, tenantId, d)));
  }), { numRuns: runs(15) });
}, timeoutFor(600_000));
```

  `arbArapOp`: tạo HĐ (PKT Nợ 131 / Có 511, VND hoặc USD), thu (BC/PT Có 131), chi trả NCC, ghi sổ có kế hoạch đối trừ, đảo một chứng từ ngẫu nhiên, bỏ ghi sổ, đối trừ thủ công một cặp ngẫu nhiên, hủy một nhóm ngẫu nhiên, đối trừ tự động, đánh giá lại ở cuối một tháng ngẫu nhiên. Thao tác bị từ chối hợp lệ (409 `OPEN_ITEM_SETTLED`, `SETTLEMENT_*`) được chấp nhận.
- [ ] **Step 2:** `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants/inv5-cong-no.test.ts` xanh; `FC_RUNS=100` chạy một lần thủ công, ghi thời gian vào sổ quyết định.
- [ ] **Step 3:** Commit `test(api): bất biến 5 công nợ khớp sổ cái theo đối tượng`.

### Task 15: Báo cáo công nợ: sổ chi tiết, tổng hợp, tuổi nợ, biên bản đối chiếu, nhắc nợ

Model: sonnet.

**Files:**
- Create: `apps/api/src/modules/arap/reports.ts`, `apps/web/src/pages/ArapReports.tsx`, `apps/web/e2e/cong-no.spec.ts`
- Modify: `apps/api/src/modules/arap/routes.ts`, `apps/api/src/modules/reporting/print/html.ts` (khung in dùng chung), `apps/web/src/router.tsx` (menu "Công nợ")
- Test: `apps/api/test/arapReports.test.ts`, `apps/web/test/ArapReports.test.tsx`

**Interfaces (mọi route: quyền `report.view`, `READ_SNAPSHOT`, cờ theo tài khoản: 131/receivable cần `view_receivable`, 331/payable cần `view_payable`, thiếu → 403 trước khi đọc dữ liệu):**
- `GET /api/reports/arap/detail?accountCode&partyCode&from&to&currency&format=json|xlsx|pdf`: đầu kỳ, từng chứng từ (ngày, số, diễn giải, TK đối ứng, Nợ, Có, nguyên tệ), số dư lũy kế, cuối kỳ.
- `GET /api/reports/arap/summary?accountCode&from&to&format`: mỗi đối tượng: dư đầu Nợ/Có, phát sinh Nợ/Có, dư cuối Nợ/Có (tách hai bên theo đối tượng, như BCĐPS); khớp tổng tài khoản.
- `GET /api/reports/arap/aging?accountCode&asOf&buckets=30,60,90,180&by=due|doc&format`: mỗi đối tượng: chưa đến hạn, `1–30`, `31–60`, `61–90`, `91–180`, `>180` ngày quá hạn (theo `due_date`, `by=doc` theo ngày chứng từ), tổng = Σ dư `open_item` của đối tượng; danh sách khoản chi tiết khi `partyCode`.
- `GET /api/reports/arap/statement?accountCode&partyCode&from&to&format=pdf|xlsx`: Biên bản đối chiếu công nợ (thông tin hai bên, dư đầu, phát sinh, dư cuối, danh sách chứng từ, khối xác nhận); mẫu nội bộ, không ghi "Mẫu số".
- `GET /api/reports/arap/reminder?accountCode&partyCode&asOf&format=pdf`: Thư nhắc nợ liệt kê khoản quá hạn và tổng; không gửi email (GĐ5).

- [ ] **Step 1: Kiểm thử thất bại:** tuổi nợ ba khoản hạn khác nhau rơi đúng nhóm và tổng = Σ dư; tổng hợp: Σ dư cuối từng đối tượng = số dư 131 tại `to`; biên bản PDF chứa tên hai bên và dư cuối; người có `view_payable` nhưng không `view_receivable`: 403 ở 131, 200 ở 331; `by=doc` khác `by=due`.
- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt; trang "Báo cáo công nợ" (tab Sổ chi tiết / Tổng hợp / Tuổi nợ / Đối chiếu, chọn đối tượng F4, nút In biên bản, Thư nhắc nợ).
- [ ] **Step 4:** `pnpm -F @kt/api test -- test/arapReports.test.ts`, `pnpm -F @kt/web test`, `pnpm -F @kt/web e2e -- cong-no.spec.ts` xanh.
- [ ] **Step 5:** Commit `feat(arap): sổ chi tiết, tổng hợp, tuổi nợ, biên bản đối chiếu và thư nhắc nợ`.

### Task 16: Màn hình Đối trừ chứng từ và Công cụ tỷ giá

Model: sonnet.

**Files:**
- Create: `apps/web/src/pages/Settlement.tsx`, `apps/web/src/pages/FxTools.tsx`, `apps/web/e2e/doi-tru.spec.ts`, `apps/web/e2e/ty-gia.spec.ts`
- Modify: `apps/web/src/router.tsx`, `apps/web/src/pages/VoucherForm.tsx` (nút "Chọn chứng từ công nợ" trên PT/PC/BC/BN/BT: hộp thoại liệt kê `open-items` còn dư của đối tượng, chọn và nhập số đối trừ → `lines[].settle`)
- Test: `apps/web/test/Settlement.test.tsx`, `apps/web/test/FxTools.test.tsx`

**Interfaces:**
- Consumes: route Task 10–13 (không thêm route API).
- Đối trừ chứng từ: chọn tài khoản (131/331), đối tượng (F4), loại tiền; hai lưới "Phát sinh Nợ còn dư" / "Phát sinh Có còn dư" (cột: ngày, số, hạn, nguyên tệ, dư VND, số đối trừ nhập được); nút Đối trừ (Ctrl+S), Đối trừ tự động, tab "Đã đối trừ" có Hủy đối trừ theo nhóm; hiện số CL sinh ra.
- Công cụ tỷ giá: tab "Tỷ giá xuất quỹ" (chọn kỳ, chạy, xem chứng từ XQ, lịch sử `fx_run`), tab "Đánh giá lại ngoại tệ" (ngày, bảng tỷ giá theo loại tiền điền sẵn từ danh mục, xem trước chênh lệch trước khi chạy: route `POST /api/fx/revaluation?dryRun=true` trả dòng dự kiến không ghi; thêm vào Task 13 nếu chưa có: ghi chú cho người thực hiện T16 thêm tham số `dryRun` vào route T13, kèm kiểm thử).

- [ ] **Step 1: Kiểm thử thất bại** (vitest + Testing Library với API giả): chọn hai khoản, nhập số, Đối trừ gửi đúng thân; Hủy đối trừ hỏi xác nhận; đánh giá lại xem trước hiện chênh lệch, nút Chạy chỉ bật sau xem trước. Thêm kiểm thử `dryRun` ở `apps/api/test/fxRevaluation.test.ts` (không tạo chứng từ, kết quả bằng lần chạy thật).
- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt theo `evon:ui-ux`.
- [ ] **Step 4:** `pnpm -F @kt/web test`, `pnpm -F @kt/api test -- test/fxRevaluation.test.ts`, `pnpm -F @kt/web e2e -- doi-tru.spec.ts ty-gia.spec.ts` xanh.
- [ ] **Step 5:** Commit `feat(web): màn hình đối trừ chứng từ, chọn công nợ trên phiếu thu chi, công cụ tỷ giá`.

### Task 17: Động cơ thuế: `tax_code` mở rộng, `tax_distribution`, tham số pháp lý

Model: **opus**.

**Files:**
- Create: `packages/db/migrations/0030_dong_co_thue.sql`, `packages/domain/src/tax.ts`
- Modify: `packages/db/src/types.ts`, `packages/domain/src/index.ts`, `apps/api/src/modules/master/catalogs.ts` (danh mục `tax_code` thêm cột, danh mục mới `tax_distribution`), `packages/db/src/reference.ts` (nạp `legal_param`)
- Test: `packages/domain/test/tax.test.ts`, `packages/db/test/tax.test.ts`

**Interfaces:**
- Quyết định: bảng `tax_code` hiện có là bảng `tax` của đặc tả (không tạo bảng trùng). `0030`: `ALTER TABLE tax_code ADD COLUMN scope text NOT NULL DEFAULT 'both' CHECK (scope IN ('sale','purchase','both')), ADD COLUMN method text NOT NULL DEFAULT 'deduct' CHECK (method IN ('deduct','direct','none')), ADD COLUMN price_include boolean NOT NULL DEFAULT false`; `kind` thêm giá trị `'pit'` (đổi CHECK); thêm `UNIQUE (tenant_id, id)`.
- `tax_distribution (id bigint identity PK, tenant_id, tax_code_id bigint NOT NULL, document_type text CHECK (document_type IN ('invoice','refund')), scope text CHECK (scope IN ('sale','purchase')), line_type text CHECK (line_type IN ('base','tax')), factor_percent numeric(7,4) NOT NULL, account_code text, report_tag text, UNIQUE (tenant_id, tax_code_id, document_type, scope, line_type, account_code))`; FK tổng hợp; RLS + audit.
- `seed_tenant_defaults` định nghĩa lại (thân hiện hành) và chèn bù cho công ty đã có: phân bổ mặc định cho V0/V5/V8/V10: mua → tax 100% `1331`, tag `purchase_tax`; bán → tax 100% `33311`, tag `sale_tax`; refund cùng tài khoản. Mã mới `TNCN_KT` "Khấu trừ thuế TNCN tại nguồn" `kind='pit'`, `rate NULL` (người dùng nhập thuế suất; văn bản Luật 109/2025 chưa có trong máy → "Chờ người dùng" xác nhận), `scope='purchase'`, phân bổ tax `factor_percent = -100` vào `3335`. Mã trực tiếp không gieo thuế suất (người dùng tự tạo mã `method='direct'` và nhập tỷ lệ).
- `legal_param` (qua `syncReferenceData`, nguồn ghi đúng mục 10 đặc tả): `vat_reduced_rate` `{ "from": 10, "to": 8 }` hiệu lực 2025-07-01 → 2026-12-31, nguồn "NQ 204/2025, NĐ 174/2025"; `vat_noncash_threshold` `"5000000"` từ 2025-07-01, nguồn "Luật 48/2024, NĐ 181/2025"; `vat_return_template` `"TT80"` hiệu lực đến 2026-06-30 và `"TT89"` từ 2026-07-01, nguồn "TT 89/2026 Đ22, Đ100". Hàm `export async function legalParam<T>(trx, code: string, date: string): Promise<T | null>` trong `apps/api/src/modules/core/legal.ts`.
- Domain:

```ts
export interface TaxDistribution { documentType: 'invoice' | 'refund'; scope: 'sale' | 'purchase'; lineType: 'base' | 'tax'; factorPercent: string; accountCode: string | null; reportTag: string | null }
export interface TaxDef { code: string; kind: 'vat' | 'pit' | 'import' | 'excise'; method: 'deduct' | 'direct' | 'none'; rate: string | null; priceInclude: boolean; distributions: TaxDistribution[] }
export interface TaxableLine { lineNo: number; amountCurrency: string; discountCurrency: string; taxCodes: string[] }   // VAT và TNCN có thể cùng dòng
export interface TaxLineResult { lineNo: number; baseCurrency: string; baseVnd: string; taxes: { code: string; amountCurrency: string; amountVnd: string }[] }
export interface TaxPosting { code: string; accountCode: string; amountVnd: string; amountCurrency: string; reportTag: string | null }   // dương = cùng chiều thuế, âm = phân bổ âm (khấu trừ)
export interface TaxResult { lines: TaxLineResult[]; postings: TaxPosting[]; roundingVnd: string }
export function computeTaxes(lines: TaxableLine[], taxes: Record<string, TaxDef>, opts: { scope: 'sale' | 'purchase'; documentType: 'invoice' | 'refund'; currency: string; fxRate: string | null; declaredTaxVnd?: Record<string, string> }): TaxResult;
```

  Quy tắc: cơ sở = `amountCurrency − discountCurrency` (giá chưa thuế; `priceInclude` thì tách ngược `base = gross / (1 + rate)`); thuế từng dòng = `round(base × rate / 100)` theo đơn vị nhỏ nhất của loại tiền (VND 0 chữ số, ngoại tệ 2); VND = `toVnd` từng dòng. `declaredTaxVnd[code]` (thuế ghi trên hóa đơn) lệch Σ thuế dòng: |lệch| ≤ số dòng có mã đó → dồn vào dòng có thuế lớn nhất, `roundingVnd` = lệch; lớn hơn → ném `TaxError('TAX_DECLARED_MISMATCH', …)`. `rate` NULL với `method='deduct'` hoặc `kind='pit'` → `TaxError('TAX_RATE_MISSING')`. KCT/KKK (`is_exempt`) thuế 0. `method='direct'` (GTGT trực tiếp trên doanh thu): không sinh thuế trên hóa đơn (thuế 0, không posting), `TaxLineResult` thêm `directRate: string | null` để báo cáo sau; tờ khai 04/GTGT không làm ở GĐ2. Chênh làm tròn được dồn vào dòng thuế lớn nhất của mã đó (ảnh hưởng sổ cái giống "dòng làm tròn" riêng trên cùng tài khoản thuế, nhưng bảng kê và bút toán không có dòng lẻ); ghi quyết định này.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('3 dòng 333.333 đ thuế 10%: mỗi dòng 33.333, hóa đơn ghi 100.000 → dồn 1 đồng, roundingVnd = 1', () => {});
it('chênh lớn hơn số dòng → TAX_DECLARED_MISMATCH', () => {});
it('chi trả cá nhân 10.000.000 có TNCN_KT 10%: posting 3335 = -1.000.000', () => {});
it('giá đã gồm thuế 11.000.000 thuế 10% → cơ sở 10.000.000, thuế 1.000.000', () => {});
it('USD 2 dòng 100,55 @25.400: cơ sở VND từng dòng làm tròn rồi cộng', () => {});
it('thuộc tính: Σ baseVnd + Σ thuế VND (theo dấu) = Σ toVnd(gross) ± roundingVnd', () => { fc.assert(…); });
it('công ty mới có phân bổ thuế mặc định; legalParam vat_return_template ngày 2026-06-30 = TT80, 2026-07-01 = TT89', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt. **Step 4:** `pnpm db:migrate`; `pnpm -F @kt/domain test`, `pnpm -F @kt/db test`, `pnpm -F @kt/api test -- test/catalogs.test.ts` xanh.
- [ ] **Step 5:** Commit `feat(domain): động cơ thuế GTGT và TNCN khấu trừ, phân bổ thuế, tham số pháp lý theo ngày hiệu lực`.

### Task 18: Hóa đơn mua/bán dịch vụ, giảm giá/trả lại, `voucher_invoice`, kiểm tra trùng hóa đơn

Model: sonnet (rà soát opus vì dựng bút toán).

**Files:**
- Create: `packages/db/migrations/0031_hoa_don.sql`, `packages/domain/src/invoiceLedger.ts`, `apps/api/src/modules/invoices/service.ts`, `apps/api/src/modules/invoices/routes.ts`
- Modify: `packages/db/src/types.ts`, `apps/api/src/app.ts`, `apps/api/src/modules/ledger/vouchers.service.ts` (`voucher_invoice` trên PC/BN/PKT qua `invoices` trong thân chứng từ), `apps/api/src/modules/ledger/vouchers.routes.ts`
- Test: `packages/domain/test/invoiceLedger.test.ts`, `apps/api/test/invoices.test.ts`

**Interfaces:**
- `fn_voucher_child_guard()` (tạo ở Task 12 nếu chưa có): trigger BEFORE INSERT/UPDATE/DELETE trên bảng con; chỉ cho khi chứng từ cha `state = 'draft'` hoặc `app.unposting = 'on'`; ngược lại `VOUCHER_CHILD_IMMUTABLE: chứng từ đã ghi sổ, hãy bỏ ghi sổ để sửa hóa đơn`.
- `voucher_item_line (id bigint identity PK, tenant_id, voucher_id uuid NOT NULL, line_no int NOT NULL, description text, item_id bigint /* FK ở GĐ3 */, uom_id bigint, quantity numeric(20,4), unit_price numeric(20,4), amount_currency numeric(20,4) NOT NULL, amount numeric(20,0) NOT NULL, discount_rate numeric(7,4) NOT NULL DEFAULT 0, discount_amount_currency numeric(20,4) NOT NULL DEFAULT 0, discount_amount numeric(20,0) NOT NULL DEFAULT 0, tax_codes text[] NOT NULL DEFAULT '{}', tax_amount numeric(20,0) NOT NULL DEFAULT 0, account_id bigint NOT NULL, department_id bigint, project_id bigint, cost_item_id bigint, UNIQUE (tenant_id, voucher_id, line_no))`; FK tổng hợp; RLS + audit + `fn_voucher_child_guard`.
- `voucher_invoice (id bigint identity PK, tenant_id, voucher_id uuid NOT NULL, direction text CHECK (direction IN ('purchase','sale')), form_no text, serial text, invoice_no text NOT NULL, invoice_date date NOT NULL, party_id uuid, party_name text, party_tax_code text, party_address text, invoice_group_id bigint, tax_code_id bigint, base_amount numeric(20,0) NOT NULL, tax_amount numeric(20,0) NOT NULL, is_import boolean NOT NULL DEFAULT false, adjusts_invoice_id bigint, declare_year int, declare_period int /* tháng 1–12 hoặc quý 1–4 theo kỳ khai của công ty */, note text, UNIQUE (tenant_id, id))`; một dòng mỗi (hóa đơn, thuế suất/nhóm kê khai); FK tổng hợp; RLS + audit + guard. Thêm FK `open_item(tenant_id, invoice_id) → voucher_invoice`.
- `tenant_setting` `vat_period`: `'month'` | `'quarter'` (mặc định `'month'`).
- Trùng hóa đơn đầu vào: cùng công ty, `direction='purchase'`, `party_tax_code` + `serial` + `invoice_no` (so sánh không phân biệt hoa thường, bỏ khoảng trắng) đã có trên chứng từ khác trạng thái ≠ `cancelled` → 409 `INVOICE_DUPLICATE` nêu số chứng từ đã có. Kiểm trong service và bằng chỉ mục `CREATE INDEX ON voucher_invoice (tenant_id, direction, upper(party_tax_code), upper(serial), invoice_no)`.
- Domain:

```ts
export interface InvoiceItemInput { lineNo: number; description: string | null; accountCode: string; amountCurrency: string; discountCurrency: string; taxCodes: string[]; departmentCode?: string | null; projectCode?: string | null; costItemCode?: string | null }
export interface InvoiceLedgerInput { scope: 'sale' | 'purchase'; documentType: 'invoice' | 'refund'; counterAccountCode: string; partyCode: string; currency: string; fxRate: string | null; dueDate: string | null; items: InvoiceItemInput[]; tax: TaxResult }
export interface LedgerLine { accountCode: string; debit: string; credit: string; amountCurrency: string; fxRate: string | null; partyCode: string | null; description: string | null; dueDate: string | null; departmentCode?: string | null; projectCode?: string | null; costItemCode?: string | null }
export function buildInvoiceLedger(i: InvoiceLedgerInput): LedgerLine[];
```

  Bán (invoice): Có TK doanh thu từng dòng (cơ sở sau chiết khấu), Có 33311 mỗi `TaxPosting`, Nợ TK công nợ **một dòng** tổng (cơ sở + thuế − khấu trừ) mang `partyCode`, `dueDate`. Mua: đảo chiều (Nợ chi phí, Nợ 1331, Có 331; TNCN phân bổ âm thành Có 3335 và giảm Có 331). Refund (GGB/GGM): đảo chiều toàn bộ so với invoice cùng phạm vi. Dòng có `amountCurrency` = 0 bị loại. Kết quả luôn cân VND và cân nguyên tệ khi một loại tiền.
- API (quyền `voucher.*` như chứng từ): `POST /api/invoices` thân `{ voucherType: 'HDB'|'HDM'|'GGB'|'GGM', postingDate, documentDate, partyCode, counterAccountCode (mặc định 131/331 theo `party.default_account_code`), currencyCode, fxRate?, dueDate? (mặc định ngày + `payment_term_days`), description, items: InvoiceItemInput[], invoice: { formNo?, serial?, invoiceNo, invoiceDate, invoiceGroupCode, isImport?, adjustsInvoiceId?, declaredTax?: Record<string,string> }, autoPost?, idempotencyKey? }` → `VoucherDto & { items, invoices }`; `PUT /api/invoices/:id` (nháp, có `version`); `GET /api/invoices/:id`. Service: `computeTaxes` → `buildInvoiceLedger` → `createVoucher` nội bộ (bỏ chặn `VOUCHER_TYPE_USE_INVOICE`) → chèn `voucher_item_line` → chèn `voucher_invoice` (nhóm theo mã thuế: `base_amount` = Σ cơ sở VND, `tax_amount` = Σ thuế VND). GGB/GGM bắt buộc `adjustsInvoiceId` thuộc hóa đơn cùng đối tượng → sai 404 `INVOICE_NOT_FOUND`.
- Chứng từ khác (PC/BN/PKT) gửi `invoices: VoucherInvoiceInput[]` trong thân `POST/PUT /api/vouchers` để kê khai hóa đơn đầu vào trả tiền ngay (không sinh bút toán, chỉ lưu kê khai, kiểm trùng như trên).

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('HĐ bán dịch vụ 2 dòng 10% và 8%, chiết khấu 5%: Có 5113 theo dòng, Có 33311 hai mức, Nợ 131 một dòng có hạn thanh toán', async () => {});
it('HĐ mua dịch vụ của cá nhân 10.000.000 khấu trừ TNCN 10%: Nợ 6422 10tr / Có 3335 1tr / Có 331 9tr', async () => {});
it('voucher_invoice: một dòng mỗi thuế suất, tổng khớp thuế trên bút toán', async () => {});
it('trùng hóa đơn đầu vào giữa HDM và PC → 409 INVOICE_DUPLICATE; HĐ trên chứng từ đã hủy không chặn', async () => {});
it('sửa hóa đơn của chứng từ đã ghi sổ bị chặn VOUCHER_CHILD_IMMUTABLE; bỏ ghi sổ thì sửa được', async () => {});
it('GGB trả lại một phần HĐ bán: bút toán đảo chiều, open_item Có đối trừ được với HĐ gốc', async () => {});
it('thuộc tính: buildInvoiceLedger luôn cân VND', () => { fc.assert(…); });
```

- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt. **Step 4:** `pnpm db:migrate`; `pnpm -F @kt/domain test`, `pnpm -F @kt/api test -- test/invoices.test.ts` và cả gói xanh.
- [ ] **Step 5:** Commit `feat(api): hóa đơn mua/bán dịch vụ, giảm giá trả lại, kê khai hóa đơn và kiểm tra trùng`.

### Task 19: Màn hình hóa đơn mua/bán dịch vụ

Model: sonnet.

**Files:**
- Modify: `apps/web/src/pages/VoucherForm.tsx` (tab "Hàng tiền", "Thuế", "Hóa đơn", "Hạch toán" chỉ đọc cho loại `hasItems`; tab "Hóa đơn" nhập tay cho PC/BN/PKT), `apps/web/src/router.tsx` (menu "Mua hàng": Hóa đơn mua dịch vụ, Giảm giá mua; "Bán hàng": Hóa đơn bán dịch vụ, Giảm giá bán)
- Create: `apps/web/e2e/hoa-don.spec.ts`
- Test: `apps/web/test/InvoiceForm.test.tsx`

**Interfaces:**
- Consumes: `/api/invoices` (T18); `computeTaxes`, `buildInvoiceLedger` (domain) để xem trước bút toán ngay trên trình duyệt (cùng mã với API, không tính hai kiểu).
- Lưới hàng tiền (`KeyboardGrid`): diễn giải, TK doanh thu/chi phí (F4), số lượng, đơn giá (thành tiền tự tính = SL × đơn giá khi có, sửa được), % chiết khấu, tiền chiết khấu, mã thuế (F4 `tax_code` theo `scope`), tiền thuế (tự tính, chỉ đọc), bộ phận/vụ việc/khoản mục. Ô "Thuế ghi trên hóa đơn" theo từng mã ở tab Thuế (để dồn làm tròn). Tab Hóa đơn: mẫu số, ký hiệu, số, ngày, nhóm kê khai (mặc định theo mã thuế), MST/tên/địa chỉ lấy từ đối tượng (sửa được).
- Lỗi `INVOICE_DUPLICATE` hiện liên kết mở chứng từ đã có.

- [ ] **Step 1: Kiểm thử thất bại:** nhập 2 dòng, đổi mã thuế cập nhật tiền thuế và bút toán xem trước; thuế ghi trên hóa đơn lệch 1 đồng không báo lỗi, lệch 1.000 đồng báo; MST lấy từ đối tượng.
- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt theo `evon:ui-ux`.
- [ ] **Step 4:** `pnpm -F @kt/web test`, `pnpm -F @kt/web e2e -- hoa-don.spec.ts` xanh (spec: HĐ bán dịch vụ bằng bàn phím, ghi sổ, mở Báo cáo công nợ thấy khoản phải thu).
- [ ] **Step 5:** Commit `feat(web): màn hình hóa đơn mua/bán dịch vụ có thuế và xem trước bút toán`.

### Task 20: Doanh thu nhận trước và phân bổ

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0032_phan_bo.sql`, `apps/api/src/modules/invoices/amortization.ts`, `apps/web/src/pages/Amortization.tsx`, `apps/web/e2e/phan-bo-doanh-thu.spec.ts`
- Modify: `apps/api/src/modules/invoices/routes.ts`, `packages/db/src/types.ts`, `apps/web/src/router.tsx`
- Test: `apps/api/test/amortization.test.ts`

**Interfaces:**
- `amortization_schedule (id bigint identity PK, tenant_id, kind text CHECK (kind IN ('deferred_revenue')) /* GĐ4 thêm 'prepaid_expense' */, source_voucher_id uuid, from_account_id bigint, to_account_id bigint, total numeric(20,0), periods int CHECK (periods BETWEEN 1 AND 120), start_year int, start_period int, description text, is_active boolean DEFAULT true)`; `amortization_line (id bigint identity PK, tenant_id, schedule_id bigint, seq int, fiscal_year int, period_no int, amount numeric(20,0), voucher_id uuid, UNIQUE (tenant_id, schedule_id, seq))`; FK tổng hợp; RLS + audit.
- Lịch: chia đều `floor(total / periods)`, kỳ cuối nhận phần dư (Σ = total).
- `POST /api/amortizations` (quyền `amortization.create`) thân `{ sourceVoucherId?, fromAccountCode (3387), toAccountCode (5113…), total, periods, startYear, startPeriod, description }`; `POST /api/amortizations/run` (quyền `amortization.run`) thân `{ fiscalYear, periodNo }`: mỗi dòng lịch của kỳ chưa có chứng từ → một chứng từ `PB` (Nợ from / Có to), `source_doc_type='amortization'`, `source_doc_id` = id lịch; chạy lại kỳ đã có → đảo cũ sinh mới (cùng quy tắc Task 10). HĐ bán dịch vụ có dòng hạch toán vào 3387: biểu mẫu gợi ý tạo lịch.

- [ ] **Step 1: Kiểm thử thất bại:** 12.000.001 chia 12 kỳ → 11 × 1.000.000 + 1.000.001; chạy kỳ 3 sinh PB đúng; chạy lại đảo PB cũ; PB không bỏ ghi sổ qua route chung; tổng phân bổ ≤ total.
- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt. **Step 4:** `pnpm db:migrate`; kiểm thử API + `pnpm -F @kt/web e2e -- phan-bo-doanh-thu.spec.ts` xanh.
- [ ] **Step 5:** Commit `feat(api): doanh thu nhận trước và phân bổ theo kỳ`.

### Task 21: Dữ liệu pháp lý mẫu 01/GTGT: TT 89/2026 và thử tải TT 80/2021

Model: sonnet.

**Files:**
- Create: `packages/coa-data/data/tax/01gtgt-tt89.json`, `packages/coa-data/data/tax/status.json`, `packages/coa-data/test/vatTemplate.test.ts`, (`packages/coa-data/data/tax/01gtgt-tt80.json` nếu tải được)
- Modify: `packages/coa-data/src/load.ts` (`loadVatTemplate(version: 'TT89' | 'TT80'): VatTemplate`, `isVatTemplateComplete(version)`), `docs/TIEP-THEO.md` (mục 2 và "Chờ người dùng")
- Văn bản: `~/legal-docs/tt89-2026/ocr/SUMMARY.md`, `p241.txt`–`p243.txt`, ảnh `form01gtgt-p241.png`–`p243.png`; tải mới vào `~/legal-docs/tt80-2021/`

**Interfaces:**

```ts
export type VatLineKind = 'flag' | 'carry' | 'invoice' | 'formula' | 'manual';
export interface VatTemplateLine { code: string; label: string; section: string; kind: VatLineKind;
  invoice?: { direction: 'purchase' | 'sale'; groups: string[]; field: 'base' | 'tax'; importOnly?: boolean };
  formula?: string;              // vd "[29]+[30]+[32]+[32a]-[32b]"
  clamp?: 'positivePart' | 'negativePart'; // [40a] = max(x,0); [41] = max(-x,0)
  overridable?: boolean }        // người dùng sửa được giá trị tính (vd [25] khi phân bổ thuế đầu vào dùng chung)
export interface VatTemplate { form: '01/GTGT'; version: 'TT89' | 'TT80'; validFrom: string; validTo: string | null; source: string; lines: VatTemplateLine[] }
```

  `01gtgt-tt89.json` gồm đúng các chỉ tiêu [21]–[43] của trang 241–243 (gồm [23a], [24a], [32a], [32b], [34a], [39a], [40a], [40b]), nhãn chép từ ảnh (sửa lỗi OCR bằng cách nhìn ảnh bằng công cụ Read), công thức đúng như in trên mẫu. Ánh xạ nhóm kê khai: [23]/[24] mua nhóm `01`–`04`; [23a]/[24a] `importOnly`; [25] = thuế nhóm `01` + thuế nhóm `03` × tỷ lệ doanh thu chịu thuế (`([27])/([26]+[27]+[34a])`, đánh dấu `overridable`); [26] bán nhóm `KCT`; [29] `00`; [30]/[31] `05`; [32]/[33] `10` và `08` (cách kê khai 8% chưa có văn bản gốc trong máy: ghi `note` trong JSON, `status.json` `"01GTGT_TT89_rate8": false`, thêm "Chờ người dùng"); [32a] nhóm mới `KKK`; [32b] nhóm mới `KTGT`; [34a] nhóm mới `NPV`; [22] `carry`; [37], [38], [39a], [40b], [42] `manual`. Các nhóm bán `KKK`, `KTGT`, `NPV` thêm bằng migration ở Task 23 (gieo cho công ty mới và chèn bù).
- TT 80/2021: thử tải văn bản gốc từ congbao.chinhphu.vn (như cách đã tải TT99: tìm "Thông tư 80/2021/TT-BTC" ngày 29/09/2021, tải PDF vào `~/legal-docs/tt80-2021/pdf/`, `pdftotext`; nếu là ảnh thì OCR `tesseract -l vie` như TT89). Tải được và đối chiếu được mẫu 01/GTGT → tạo `01gtgt-tt80.json`, `status.json` `"01GTGT_TT80": true`. Không tải được → không tạo tệp, `"01GTGT_TT80": false`, thêm dòng "Chờ người dùng" (văn bản gốc TT 80/2021 Phụ lục II mẫu 01/GTGT, đặt vào `~/legal-docs/tt80-2021/`), API tờ khai cho kỳ trước 01/07/2026 trả 409 `VAT_TEMPLATE_UNAVAILABLE` (Task 23).

- [ ] **Step 1: Kiểm thử thất bại** (`vatTemplate.test.ts`): mọi mã chỉ tiêu [21]–[43] của danh sách trong `SUMMARY.md` có mặt đúng một lần; mọi tham chiếu `[x]` trong `formula` trỏ tới chỉ tiêu có thật; không có chu trình; `source` nhắc "TT 89/2026" và trang; khi `status.json` `01GTGT_TT80 = false` thì `loadVatTemplate('TT80')` ném lỗi rõ.
- [ ] **Step 2:** FAIL. **Step 3:** Nhập dữ liệu từ ảnh; thử tải TT80.
- [ ] **Step 4:** `pnpm -F @kt/coa-data test` xanh.
- [ ] **Step 5:** Commit `feat(coa): chỉ tiêu tờ khai 01/GTGT theo TT 89/2026 từ văn bản gốc` (và `docs: chờ người dùng văn bản TT 80/2021` nếu không tải được).

### Task 22: Bảng kê hóa đơn mua vào/bán ra và đối chiếu thuế với sổ cái

Model: sonnet.

**Files:**
- Create: `apps/api/src/modules/tax/register.ts`, `apps/api/src/modules/tax/routes.ts`, `apps/web/src/pages/InvoiceRegister.tsx`, `apps/web/e2e/bang-ke-thue.spec.ts`
- Modify: `apps/api/src/app.ts`, `apps/web/src/router.tsx` (menu "Thuế")
- Test: `apps/api/test/taxRegister.test.ts`

**Interfaces (quyền `tax.view`, `READ_SNAPSHOT`):**
- `GET /api/tax/invoices?direction=purchase|sale&year&period&periodKind=month|quarter&format=json|xlsx`: các `voucher_invoice` của chứng từ `posted` có kỳ kê khai (`declare_year/declare_period`, mặc định theo `invoice_date`) thuộc kỳ, nhóm theo nhóm kê khai, mỗi nhóm có cộng; cột: STT, ký hiệu, số, ngày, tên, MST, giá trị chưa thuế, thuế suất, thuế, số chứng từ (liên kết). Đây là bảng kê nội bộ (TT 80/2021 và TT 89/2026 không còn phụ lục bảng kê bắt buộc), tiêu đề không ghi "Mẫu số".
- `GET /api/tax/reconcile?year&period&periodKind`: `{ purchaseTaxInvoices, debit1331, saleTaxInvoices, credit33311, differences: [{ voucherId, voucherNo, invoiceTax, ledgerTax }] }` theo từng chứng từ: Σ `voucher_invoice.tax_amount` so với Σ phát sinh trên tài khoản thuế (`tax_distribution.account_code` của các mã thuế dùng) của chứng từ đó.

- [ ] **Step 1: Kiểm thử thất bại:** bảng kê mua vào gồm HĐ trên HDM và PC, nhóm đúng, chứng từ nháp/hủy không có; kỳ quý gom ba tháng; `declare_period` khác ngày hóa đơn đưa vào kỳ đã chọn; đối chiếu bắt chứng từ PKT có dòng 1331 mà không kê hóa đơn.
- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt; trang "Bảng kê hóa đơn" (tab Mua vào / Bán ra / Đối chiếu, xuất Excel).
- [ ] **Step 4:** Kiểm thử API, web, `pnpm -F @kt/web e2e -- bang-ke-thue.spec.ts` xanh.
- [ ] **Step 5:** Commit `feat(tax): bảng kê hóa đơn mua vào/bán ra và đối chiếu thuế với sổ cái`.

### Task 23: Tờ khai 01/GTGT: tính, lưu, bổ sung, chuyển kỳ, khấu trừ thuế cuối kỳ

Model: **opus**.

**Files:**
- Create: `packages/db/migrations/0033_to_khai_thue.sql`, `packages/domain/src/vatFormula.ts`, `apps/api/src/modules/tax/vatReturn.ts`, `apps/api/src/modules/tax/vatOffset.ts`
- Modify: `apps/api/src/modules/tax/routes.ts`, `packages/db/src/types.ts`
- Test: `packages/domain/test/vatFormula.test.ts`, `apps/api/test/vatReturn.test.ts`, `apps/api/test/vatOffset.test.ts`

**Interfaces:**
- `tax_return (id bigint identity PK, tenant_id, form_code text NOT NULL /* '01/GTGT' */, template_version text NOT NULL, period_kind text CHECK (period_kind IN ('month','quarter')), year int, period int, revision int NOT NULL DEFAULT 0 /* 0 lần đầu, n bổ sung lần n */, status text CHECK (status IN ('draft','final')), values jsonb NOT NULL, overrides jsonb NOT NULL DEFAULT '{}', created_by uuid, created_at timestamptz, finalized_by uuid, finalized_at timestamptz, UNIQUE (tenant_id, form_code, year, period_kind, period, revision))`; RLS + audit; trigger chặn sửa dòng `final` (`TAX_RETURN_FINAL`).
- `0033` cũng gieo nhóm bán `KKK` "Không kê khai, tính nộp thuế GTGT", `KTGT` "Không tính vào giá tính thuế GTGT", `NPV` "Không thuộc phạm vi điều chỉnh của pháp luật thuế GTGT" (định nghĩa lại `seed_tenant_defaults`, chèn bù công ty đã có).
- Domain: `export function evalVatReturn(t: VatTemplate, inputs: { invoice: Record<string, string>; carry: string; manual: Record<string, string>; overrides: Record<string, string> }): Record<string, string>` (tính theo thứ tự phụ thuộc; `clamp`; số nguyên VND dạng chuỗi; `flag` [21] = `'X'` khi không có hóa đơn nào).
- `POST /api/tax/vat-returns` (quyền `tax_return.create`) thân `{ year, periodKind, period, revision?, manual?: Record<string,string>, overrides?: Record<string,string> }`:
  - Mẫu theo `legalParam('vat_return_template', ngày đầu kỳ)`; mẫu chưa `complete` → 409 `VAT_TEMPLATE_UNAVAILABLE` (thông báo nêu văn bản còn thiếu).
  - `invoice` từ `voucher_invoice` chứng từ `posted` của kỳ (cùng truy vấn với Task 22).
  - [22] = [43] của tờ khai `final` có `revision` lớn nhất của kỳ liền trước; không có → `manual['22']` (gợi ý: số dư Nợ 133 đầu kỳ, trả trong `hints`).
  - Trả `{ id, values, hints, warnings }` (`warnings`: mã 8% đang dùng ngoài hiệu lực `vat_reduced_rate`; tỷ lệ phân bổ [25] là gợi ý).
- `PUT /api/tax/vat-returns/:id` (nháp: sửa `manual`, `overrides`, tính lại); `POST /api/tax/vat-returns/:id/finalize` (quyền `tax_return.finalize`); bổ sung: tạo `revision = max + 1` khi đã có `final`. `GET /api/tax/vat-returns?year` danh sách.
- Khấu trừ thuế cuối kỳ `POST /api/tax/vat-offset` (quyền `tax.offset`) thân `{ date }`: số khấu trừ = min(dư Có 33311, dư Nợ các tài khoản chi tiết 133x) tại `date`; > 0 → chứng từ `KTT` ngày `date` Nợ 33311 / Có 1331 (rồi 1332 nếu 1331 không đủ), `source_doc_type='vat_offset'`; chạy lại cùng ngày đảo cũ sinh mới.

- [ ] **Step 1: Kiểm thử thất bại** (số cụ thể):

```ts
it('kỳ tháng 7/2026 dùng TT89; tháng 6/2026 trả VAT_TEMPLATE_UNAVAILABLE khi TT80 chưa có', async () => {});
it('mua 100tr thuế 10tr (nhóm 01), bán 10% 300tr thuế 30tr, KCT 50tr: [23]=100tr [24]=10tr [25]=10tr [26]=50tr [32]=300tr [33]=30tr [27]=300tr [28]=30tr [34]=350tr [35]=30tr [36]=20tr', async () => {});
it('[22] lấy [43] của tờ khai đã chốt kỳ trước; [40a]/[41] theo dấu của biểu thức; [43]=[41]-[42]', async () => {});
it('bổ sung lần 1 sau khi đã chốt; tờ khai đã chốt không sửa được', async () => {});
it('ghi đè [25] được lưu trong overrides và ghi audit', async () => {});
it('khấu trừ thuế: dư Có 33311 30tr, dư Nợ 1331 12tr → KTT 12tr; chạy lại đảo cũ', async () => {});
// vatFormula.test.ts: thứ tự phụ thuộc, clamp, chu trình bị từ chối
```

- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt. **Step 4:** `pnpm db:migrate`; `pnpm -F @kt/domain test`, `pnpm -F @kt/api test -- test/vatReturn.test.ts test/vatOffset.test.ts` xanh.
- [ ] **Step 5:** Commit `feat(tax): tờ khai 01/GTGT theo mẫu dữ liệu, bổ sung, chuyển kỳ và khấu trừ thuế cuối kỳ`.

### Task 24: Xuất XML tờ khai (adapter định dạng) và màn hình tờ khai

Model: sonnet.

**Files:**
- Create: `apps/api/src/modules/tax/xml/index.ts`, `apps/api/src/modules/tax/xml/htkk01gtgt.ts`, `packages/coa-data/data/tax/htkk-01gtgt.json`, `apps/web/src/pages/VatReturn.tsx`, `apps/web/e2e/to-khai-gtgt.spec.ts`
- Modify: `apps/api/src/modules/tax/routes.ts`, `apps/web/src/router.tsx`
- Test: `apps/api/test/vatXml.test.ts`, `apps/web/test/VatReturn.test.tsx`

**Interfaces:**

```ts
export interface CompanyInfo { name: string; taxCode: string; address: string | null; legalRep: string | null }
export interface TaxReturnXmlFormat { id: string; formCode: string; templateVersions: string[]; verified: boolean; render(ret: TaxReturnDto, company: CompanyInfo): string }
export const XML_FORMATS: Record<string, TaxReturnXmlFormat>;   // 'htkk-01gtgt'
export function escapeXml(s: string): string;
```

- `htkk-01gtgt.json`: `{ "verified": false, "note": "Chưa kiểm chứng với HTKK: chưa có XSD hay tệp kết xuất mẫu (xem Chờ người dùng)", "root": "HSoThueDTu", "header": { … }, "tags": { "21": "ct21", "22": "ct22", … } }`; mọi mã đặc thù HTKK (mã tờ khai, phiên bản) nằm trong tệp này, không nằm trong mã. Khi có tệp mẫu từ HTKK, chỉ sửa tệp JSON và (nếu cấu trúc khác) adapter.
- `GET /api/tax/vat-returns/:id/xml?format=htkk-01gtgt` (quyền `tax.view`): `content-type: application/xml`, tên tệp `01GTGT_<MST>_<kỳ>.xml` mã hóa RFC 5987; phản hồi có header `x-kt-unverified: 1` khi `verified=false`.
- Màn hình "Tờ khai thuế GTGT": chọn kỳ (tháng/quý theo `vat_period`), bảng chỉ tiêu theo mẫu (ô `manual` và `overridable` sửa được bằng `VnNumberInput`, ô tính chỉ đọc, nhấn chỉ tiêu hóa đơn mở bảng kê đã lọc), nút Tính lại, Chốt, Lập bổ sung, Khấu trừ thuế cuối kỳ, Xuất XML (cảnh báo vàng "XML chưa kiểm chứng với HTKK" khi `verified=false`), In (PDF theo bố cục mẫu).

- [ ] **Step 1: Kiểm thử thất bại:** XML cân thẻ (không thêm thư viện: kiểm bằng ngăn xếp thẻ trên kết quả tách regex) và giá trị từng thẻ theo `tags` bằng `values`; ký tự `&<>` trong tên công ty được thoát; header `x-kt-unverified`; format lạ → 400 `XML_FORMAT_INVALID`; web: ô [37] sửa được, [36] chỉ đọc, chốt rồi các ô khóa.
- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt theo `evon:ui-ux`.
- [ ] **Step 4:** Kiểm thử API/web; `pnpm -F @kt/web e2e -- to-khai-gtgt.spec.ts` xanh (tính tờ khai quý 3/2026, sửa [37], chốt, tải XML).
- [ ] **Step 5:** Commit `feat(tax): xuất XML tờ khai qua adapter định dạng (chưa kiểm chứng HTKK) và màn hình tờ khai`.

### Task 25: Nhập chứng từ từ Excel; sửa lỗi nhập Excel dùng chung (nhóm B "Nhập Excel")

Model: sonnet.

**Files:**
- Create: `apps/api/src/modules/master/excelSheet.ts`, `apps/api/src/modules/tools/importVouchers.ts`, `apps/web/src/pages/ImportVouchers.tsx`, `apps/web/e2e/nhap-chung-tu.spec.ts`
- Modify: `apps/api/src/modules/master/importExcel.ts` (dùng `excelSheet.ts`), `apps/api/src/modules/tools/routes.ts`, `apps/web/src/pages/ImportExcel.tsx` (hiển thị lỗi), `apps/web/src/router.tsx`
- Test: `apps/api/test/importExcel.test.ts`, `apps/api/test/importVouchers.test.ts`

**Interfaces:**
- `excelSheet.ts`: `export async function readSheet(buf: Buffer, opts: { sheet: string; keyRow: number; firstDataRow: number; maxRows: number; columns: ColumnDef[] }): Promise<{ rows: { row: number; values: Record<string, unknown> }[]; errors: ImportError[] }>`: kiểm `worksheet.actualRowCount` > `maxRows` **trước** khi đọc ô → `AppError('IMPORT_TOO_MANY_ROWS', 'Tệp có … dòng, tối đa …', 400)`; ánh xạ cột theo dòng khóa (`keyRow`, tên khóa kỹ thuật), không theo vị trí, cột khóa thiếu → `IMPORT_COLUMN_MISSING`; ngày serial Excel → `Math.floor` trước khi đổi (giờ trong ô không làm lệch ngày); `plainCell` chuyển sang đây; ô lỗi/đối tượng lạ → thông báo `Ô không đọc được`, không bao giờ `[object Object]`; lỗi Zod chuyển thành tiếng Việt bằng `zodIssueVi(issue: ZodIssue, label: string): string` (bắt buộc, sai định dạng, quá dài, không thuộc danh sách).
- Danh mục: giữ hành vi hiện có, thêm: có lỗi ở bất kỳ dòng nào → không chèn dòng nào (hiện chèn dòng hợp lệ); chèn theo lô 500 dòng mỗi câu `INSERT … VALUES` trong một giao dịch (thay vì từng dòng).
- Nhập chứng từ: `GET /api/import/vouchers/:kind/template.xlsx`, `POST /api/import/vouchers/:kind?mode=validate|commit&autoPost=false` (quyền `voucher.import`, thêm `voucher.post` khi `autoPost`), `kind ∈ {'thu-chi', 'bang-ke-mua', 'bang-ke-ban'}`:
  - `thu-chi`: cột `group` (Số chứng từ tạm, gom các dòng thành một chứng từ), `type` (PT/PC/BC/BN), `postingDate`, `documentDate`, `description`, `personName`, `partyCode`, `bankAccountNo`, `debitAccount`, `creditAccount`, `amount`, `currency`, `fxRate`, `amountCurrency`, `lineDescription`.
  - `bang-ke-mua`/`bang-ke-ban`: mỗi dòng một hóa đơn một thuế suất; cột `group` (gom nhiều thuế suất vào một hóa đơn), `postingDate`, `serial`, `invoiceNo`, `invoiceDate`, `partyCode`, `partyTaxCode`, `partyName`, `accountCode` (chi phí/doanh thu), `counterAccountCode`, `amount`, `taxCode`, `taxAmount` (thuế ghi trên hóa đơn), `invoiceGroupCode`, `dueDate`, `description` → `POST /api/invoices` nội bộ (HDM/HDB).
  - Quy trình: đọc + kiểm tra toàn bộ (gồm tra mã, cân Nợ/Có, trùng hóa đơn trong tệp và với dữ liệu đã có) không ghi gì; có lỗi → trả `{ total, created: 0, errors }`; không lỗi và `mode=commit` → tạo tất cả trong một giao dịch, chèn dòng theo lô; `idempotencyKey = 'import:' + sha256(tệp) + ':' + group` nên nhập lại cùng tệp trả lại chứng từ cũ (`created` đếm chứng từ mới).
  - Giới hạn 5.000 nhóm và 20.000 dòng mỗi tệp.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('ngày serial có phần giờ (45672.75) đọc thành đúng ngày', async () => {});
it('cột đổi thứ tự vẫn nhập đúng nhờ dòng khóa; thiếu cột khóa bắt buộc báo IMPORT_COLUMN_MISSING', async () => {});
it('tệp 20.001 dòng bị từ chối trước khi đọc ô', async () => {});
it('danh mục: một dòng sai thì không chèn dòng nào', async () => {});
it('thông báo lỗi tiếng Việt, không có [object Object]', async () => {});
it('1.000 dòng phiếu thu/chi có một dòng sai: không tạo chứng từ nào, lỗi nêu dòng và cột', async () => {});
it('nhập cùng tệp hai lần: lần hai created = 0, không trùng chứng từ', async () => {});
it('bảng kê mua vào: trùng hóa đơn trong tệp và với hóa đơn đã có đều báo lỗi', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt; trang "Nhập chứng từ từ Excel" (chọn loại, tải mẫu, Kiểm tra, Nhập, bảng lỗi theo dòng/cột).
- [ ] **Step 4:** `pnpm -F @kt/api test -- test/importExcel.test.ts test/importVouchers.test.ts`, `pnpm -F @kt/web e2e -- nhap-chung-tu.spec.ts` xanh.
- [ ] **Step 5:** Commit `feat(tools): nhập chứng từ và bảng kê hóa đơn từ Excel; nhập Excel không chèn một phần, ánh xạ theo dòng khóa`.

### Task 26: Khử trùng chứng từ

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0034_khu_trung.sql`, `apps/api/src/modules/tools/dedupe.ts`, `apps/web/src/pages/Dedupe.tsx`, `apps/web/e2e/khu-trung.spec.ts`
- Modify: `apps/api/src/modules/tools/routes.ts`, `packages/db/src/types.ts`, `apps/web/src/router.tsx`
- Test: `apps/api/test/dedupe.test.ts`

**Interfaces:**
- `voucher_dup_rule (id bigint identity PK, tenant_id, type_a text, type_b text, days_window int NOT NULL DEFAULT 3 CHECK (days_window BETWEEN 0 AND 31), match_party boolean NOT NULL DEFAULT true, match_counter_account boolean NOT NULL DEFAULT true, is_active boolean DEFAULT true, UNIQUE (tenant_id, type_a, type_b))`; `voucher_dup_ignore (tenant_id, voucher_a uuid, voucher_b uuid, PRIMARY KEY (tenant_id, voucher_a, voucher_b), created_by uuid, created_at timestamptz)` (`voucher_a < voucher_b`); FK tổng hợp; RLS + audit. Gieo mặc định: (`PC`,`BN`), (`PT`,`BC`), (`HDM`,`PC`), (`HDM`,`BN`), (`PKT`,`PC`), (`PKT`,`PT`).
- `GET /api/tools/duplicates?from&to` (quyền `dedupe.run`): cặp chứng từ chưa hủy/chưa đảo, theo quy tắc: tổng tiền bằng nhau, |ngày| ≤ `days_window`, cùng đối tượng chính (nếu `match_party`), cùng tập tài khoản đối ứng tiền/công nợ (nếu `match_counter_account`), cùng hóa đơn (nếu cả hai có `voucher_invoice`), loại trừ cặp đã bỏ qua → `{ a: VoucherListRow, b: VoucherListRow, reasons: string[] }[]`.
- `POST /api/tools/duplicates/ignore` thân `{ a, b }`. Xử lý trùng dùng hành động sẵn có (Hủy nháp, Đảo chứng từ đã ghi sổ) từ màn hình.
- CRUD quy tắc: danh mục `voucher_dup_rule` trong `catalogs.ts`.

- [ ] **Step 1: Kiểm thử thất bại:** PC và BN cùng NCC, cùng số tiền, cách 2 ngày → một cặp có lý do; cách 5 ngày → không; bỏ qua rồi không hiện; chứng từ đã đảo không hiện; cặp chung một hóa đơn được xếp trước.
- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt; màn hình: danh sách cặp, xem cạnh nhau, nút Hủy/Đảo/Không trùng.
- [ ] **Step 4:** `pnpm db:migrate`; kiểm thử API, `pnpm -F @kt/web e2e -- khu-trung.spec.ts` xanh.
- [ ] **Step 5:** Commit `feat(tools): khử trùng chứng từ theo cặp loại cấu hình`.

### Task 27: Soát lỗi mở rộng GĐ2 và cờ nhạy cảm trên kết quả soát lỗi

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0035_soat_loi_gd2.sql`
- Modify: `apps/api/src/modules/tools/dataCheck.ts`, `apps/api/src/modules/tools/routes.ts`
- Test: `apps/api/test/dataCheck.test.ts`

**Interfaces:**
- `seed_data_check_rules` định nghĩa lại (thân hiện hành + quy tắc mới, `ON CONFLICT DO NOTHING`), chạy cho mọi công ty đã có (tắt audit như 0014). Mỗi quy tắc trả `(voucher_id, ref, detail)` với `$1` từ ngày, `$2` đến ngày, cột mới `flags text[]` trong `data_check_rule` (cờ nhạy cảm cần để xem kết quả):

| code | mức | điều kiện | flags |
|---|---|---|---|
| CN_LECH_SO_CAI | error | (tài khoản, đối tượng) có Σ dư `fn_open_items_at(app_tenant(), $2)` khác số dư `fn_balances_at` | `{view_receivable,view_payable}` |
| HD_THIEU_MST | warning | `voucher_invoice` mua thiếu `party_tax_code`; bán cho đối tượng có `tax_code` mà hóa đơn để trống | `{}` |
| HD_TRUNG | error | hóa đơn mua trùng MST + ký hiệu + số trên hai chứng từ chưa hủy | `{}` |
| THUE_LECH | error | chứng từ có Σ `voucher_invoice.tax_amount` khác phát sinh tài khoản thuế (như Task 22) | `{}` |
| TK_NH_THIEU | warning | dòng trên tài khoản `bank` không có `bank_account_id` | `{}` |
| THUE_8_HET_HIEU_LUC | warning | hóa đơn mã V8 ngày ngoài hiệu lực `legal_param` `vat_reduced_rate` | `{}` |
| TIEN_MAT_VUOT_NGUONG | warning | hóa đơn mua tổng thanh toán ≥ `vat_noncash_threshold` có thuế khấu trừ và được đối trừ bằng chứng từ PT/PC | `{}` |
| CN_QUA_HAN | warning | khoản công nợ quá hạn > 90 ngày tại `$2` | `{view_receivable,view_payable}` |

- `dataCheck.ts`: bỏ (không chạy) quy tắc có cờ mà người dùng không đủ, trả kèm `skipped: [{ code, reason }]`; giao diện hiện "Bỏ qua do thiếu quyền xem công nợ".

- [ ] **Step 1: Kiểm thử thất bại:** mỗi quy tắc có một ca dương và một ca âm; người thiếu `view_receivable` không thấy kết quả `CN_LECH_SO_CAI` và có `skipped`.
- [ ] **Step 2:** FAIL. **Step 3:** Viết migration. **Step 4:** `pnpm db:migrate`; `pnpm -F @kt/api test -- test/dataCheck.test.ts`, `pnpm -F @kt/web test -- test/DataCheck.test.tsx` xanh.
- [ ] **Step 5:** Commit `feat(db): soát lỗi công nợ lệch sổ cái, hóa đơn thiếu MST/trùng, thuế lệch, cờ nhạy cảm trên kết quả`.

### Task 28: Dữ liệu mẫu ABC có ngoại tệ, công nợ, hóa đơn, thuế; kiểm thử nghiệm thu

Model: **opus** (số kỳ vọng tính tay).

**Files:**
- Modify: `packages/db/src/seed/demo-abc.ts`, `packages/db/src/seed/common.ts` (nếu cần helper ghi chứng từ qua SQL), `apps/api/test/sample-xyz.test.ts` (không đổi kỳ vọng XYZ)
- Create: `packages/db/src/seed/expected-gd2-abc.json`, `apps/api/test/sample-abc.test.ts`

**Interfaces:**
- ABC (TT133 mặc định, giữ chữ ký `seedAbcTx`): thêm số dư đầu kỳ 2026 theo hóa đơn (131 ba khách, một khách USD; 331 hai NCC; 1111, 1121, 1122 USD), và nghiệp vụ 12 tháng: HĐ bán/mua dịch vụ với V0/V5/V8/V10/KCT, một HĐ mua của cá nhân có TNCN khấu trừ, PT/PC/BC/BN/CT/UNC, thu từ hóa đơn có kế hoạch đối trừ, thu một phần USD có chênh lệch, bù trừ công nợ, tạm ứng và quyết toán tạm ứng, giảm giá dịch vụ bán, doanh thu nhận trước phân bổ 6 kỳ, tỷ giá xuất quỹ cuối tháng có phiếu chi USD, đánh giá lại 31/12, khấu trừ thuế cuối mỗi quý, tờ khai 01/GTGT quý 3 và quý 4 đã chốt (quý 1–2 thuộc TT80: chỉ lập nếu mẫu TT80 đã `complete`). Mọi chứng từ đi qua `post_voucher`/`settle_open_items` (như seed XYZ), seed chạy lần hai không tạo thêm.
- `expected-gd2-abc.json`: số dư cuối năm từng tài khoản, dư công nợ theo đối tượng ngày 30/06 và 31/12, chỉ tiêu tờ khai quý 3 [22]–[43], số CL/DG/XQ/KTT. Tính tay trong bảng tính hoặc ghi chú phép tính ngay trong JSON (trường `calc`), không sinh từ chính mã đang kiểm.

- [ ] **Step 1: Kiểm thử thất bại** (`sample-abc.test.ts`, chạy cùng `INVARIANTS=1` như XYZ):

```ts
it('tiêu chí nghiệm thu: tổng dư open_item = số dư 131/331 theo từng đối tượng tại MỌI ngày năm 2026', async () => {
  for (let d = dayjs('2026-01-01'); d.year() === 2026; d = d.add(1, 'day'))
    expect(await openItemsByParty(ctx, tenantId, d.format('YYYY-MM-DD'))).toEqual(onlyPartyAccounts(await sumFromLines(ctx, tenantId, d.format('YYYY-MM-DD'))));
}, 600_000);
it('số dư cuối năm từng tài khoản khớp expected-gd2-abc.json', async () => {});
it('tờ khai 01/GTGT quý 3/2026 khớp từng chỉ tiêu kỳ vọng', async () => {});
it('Bất biến 4 vẫn đúng mọi cuối tháng; bảng cân đối số phát sinh cân', async () => {});
it('seed chạy lần hai không tạo thêm; lỗi giữa chừng hoàn tác hết', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Viết seed và kỳ vọng.
- [ ] **Step 4:** `pnpm db:seed:abc && pnpm db:seed:xyz` trên DB dev; `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts test/sample-abc.test.ts` xanh.
- [ ] **Step 5:** Commit `feat(db): dữ liệu mẫu ABC có ngoại tệ, công nợ, hóa đơn, thuế và kiểm thử nghiệm thu GĐ2`.

### Kết thúc GĐ2

- [ ] Rà soát toàn nhánh (opus) từ tag `gd1-5-hoan-tat` tới HEAD, đối chiếu từng gạch lộ trình GĐ2 và từng mục nhóm B; một đợt sửa.
- [ ] `pnpm lint && pnpm typecheck && pnpm test`; `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts test/sample-abc.test.ts`; `pnpm -F @kt/web e2e` (tuần tự, không chạy cùng lúc với bất biến) xanh.
- [ ] Đo lại `pnpm -F @kt/api perf:100k` (GĐ1.5) sau khi thêm `open_item`; ghi vào `docs/dev/hieu-nang.md` nếu ghi sổ chậm đi quá 20%.
- [ ] `docs/user/giai-doan-2-tien-cong-no-thue.md`: Quỹ và ngân hàng, In chứng từ, Sổ quỹ/tiền gửi, Kiểm kê quỹ, Tỷ giá xuất quỹ và đánh giá lại, Công nợ và đối trừ, Báo cáo công nợ, Hóa đơn mua/bán dịch vụ, Doanh thu nhận trước, Bảng kê và tờ khai 01/GTGT (ghi rõ XML chưa kiểm chứng với HTKK, mẫu TT80 nếu chưa có, cách kê khai 8% chờ xác nhận), Nhập chứng từ Excel, Khử trùng, Soát lỗi; giới hạn: phân quyền theo loại chứng từ chưa có, séc chưa in, FIFO tỷ giá xuất quỹ chưa có, tờ khai trực tiếp 04/GTGT chưa có.
- [ ] `docs/TIEP-THEO.md`: đánh dấu GĐ2 và nhóm B; "Chờ người dùng" thêm: văn bản TT 80/2021 (nếu chưa tải được), cách kê khai 8% và Phụ lục giảm thuế NĐ 174/2025, thuế suất khấu trừ TNCN theo Luật 109/2025, mẫu UNC riêng từng ngân hàng, kế toán trưởng rà `fx-rules.json` và ánh xạ nhóm kê khai; bộ XML HTKK vẫn ở đó (tiêu chí nghiệm thu "HTKK/iTaxViewer mở được" chưa đạt được cho tới khi có tệp mẫu). `docs/NHAT-KY-TIEN-DO.md`.
- [ ] Tag `gd2-hoan-tat`, push `main` và tag.

## Phạm vi không làm trong GĐ2 (ghi vào sổ quyết định)

- Séc (in séc), đối chiếu sổ phụ/nhập sao kê, webhook ngân hàng, VietQR: GĐ5. Dự báo dòng tiền (D): sau.
- Tỷ giá xuất quỹ FIFO; thuế theo thời điểm thanh toán (`exigibility on_payment`); tờ khai 04/GTGT (phương pháp trực tiếp), 03/TNDN, 05/KK-TNCN: GĐ5.
- Phân quyền theo từng loại chứng từ: dùng `voucher.*` chung cho mọi loại.
- Thuộc tính kỳ hạn ngắn/dài hạn cho dòng dài hạn B01 TT99 và mã luồng tiền B03 (mục 2 `TIEP-THEO.md`): GĐ3, vì cần sửa động cơ báo cáo; `open_item.due_date` của GĐ2 là dữ liệu đầu vào cho việc đó.
- Gửi email nhắc nợ: GĐ5. Mời người dùng đã có vào công ty khác: nhóm C.

## Thứ tự thực hiện

T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14 → T15 → T16 → T17 → T18 → T19 → T20 → T21 → T22 → T23 → T24 → T25 → T26 → T27 → T28.

Phụ thuộc chính: T4 trước mọi tác vụ dùng loại chứng từ mới; T11 → T12 → T13 → T14; T17 → T18 → T19/T20/T22; T21 → T23 → T24; T25 sau T18 (bảng kê dùng `/api/invoices`); T27 sau T11, T18, T22; T28 cuối cùng. T21 không phụ thuộc mã, làm sớm được nếu cần chờ văn bản TT80.

| Migration | Tác vụ |
|---|---|
| 0024_quyen_gd2.sql | T3 |
| 0025_chung_tu_tien.sql | T4 |
| 0026_kiem_ke_quy.sql | T9 |
| 0027_ty_gia_xuat_quy.sql | T10 |
| 0028_cong_no.sql | T11 |
| 0029_doi_tru.sql | T12 |
| 0030_dong_co_thue.sql | T17 |
| 0031_hoa_don.sql | T18 |
| 0032_phan_bo.sql | T20 |
| 0033_to_khai_thue.sql | T23 |
| 0034_khu_trung.sql | T26 |
| 0035_soat_loi_gd2.sql | T27 |

## Đối chiếu nhóm B

| Mục B | Tác vụ |
|---|---|
| Màn hình chứng từ dùng chung thay `PKT`, Đảo chọn ngày, `VoucherList` lọc loại, bỏ ghi sổ DK ở màn hình số dư | T5, T6 |
| Siết cân bằng đa tiền tệ (T19) | T4 |
| Nhập Excel: serial `floor`, chèn theo lô, không chèn một phần, giới hạn dòng trước khi đọc, ánh xạ theo dòng khóa, Zod tiếng Việt, `[object Object]` | T25 |
| Danh mục: `page`, ILIKE, cắt khoảng trắng, ngưng dùng, id số lẻ, 23505 lộ ràng buộc, trùng regex tiền | T1 |
| Lưới và F4: Tab, `VnNumberInput`, `LookupSelect`, phím Insert, nút bàn phím, `validateFields`, F9 `balanced` | T2 |
| Múi giờ Việt Nam cho bộ lọc ngày | T3 (dùng lại ở T6 `todayVn`) |
| Cờ nhạy cảm cho dữ liệu GĐ2 và soát lỗi, hằng dùng chung | T3, T11, T15, T27 |
| `decideEdit`/`canTransition` | T6 (nối vào màn hình chứng từ) |
| Kiểm thử thiếu: PUT `{}`, 403, khóa kỳ khi ghi sổ lại, ghi sổ đồng thời | T5 |
