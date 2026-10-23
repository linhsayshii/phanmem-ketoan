# Kế hoạch thực hiện chi tiết: GĐ5 (Hóa đơn điện tử và tích hợp)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Doanh nghiệp phát hành, điều chỉnh, thay thế hóa đơn điện tử từ chứng từ bán hàng qua nhà cung cấp (Viettel SInvoice trước), nhận và đọc hóa đơn đầu vào XML để lập chứng từ mua, nhận giao dịch ngân hàng qua webhook SePay/Casso hoặc sao kê và đối chiếu với công nợ, in VietQR, ký số tờ khai XML, lập tờ khai quyết toán TNDN 03/TNDN và tạm tính TNDN quý, và mở API có khóa cho phần mềm bán hàng.

**Architecture:** Giữ modular monolith. **Hóa đơn điện tử là lớp trình bày pháp lý của chứng từ bán đã ghi sổ**: một chứng từ bán (HDB, BH, GGB, TLB) có tối đa một hóa đơn điện tử còn hiệu lực (`einvoice`), số hóa đơn do nhà cung cấp cấp được ghi ngược vào `voucher_invoice` bằng hàm hẹp; không có luồng ghi sổ thứ hai. Gọi nhà cung cấp luôn **ngoài giao dịch DB** theo hai pha (ghi `sending` + `transaction_uuid` → gọi → ghi kết quả), lỗi mạng để trạng thái `sending` và worker đối soát bằng `transaction_uuid`. Mọi tích hợp ngoài (nhà cung cấp HĐĐT, ký số từ xa, tra MST, ngân hàng) đi qua giao diện adapter có bản giả lập dùng trong kiểm thử và bản thật theo tài liệu công khai (đánh dấu "chưa thử trên môi trường thật"). Giao dịch ngân hàng vào hộp thư `bank_transaction` (khóa chống trùng theo nguồn), đối chiếu sinh Giấy báo có/nợ thường hoặc gắn chứng từ có sẵn. API ngoài dùng khóa băm như mã phiên, quyền = quyền người tạo khóa ∩ phạm vi khóa.

**Tech Stack:** như GĐ4 (Node 22, TypeScript 5, Fastify 5, Kysely, PostgreSQL 16, pg-boss, Vitest, fast-check, React 18 + Vite + Ant Design 5 + AG Grid, Playwright, ExcelJS, pnpm). Phụ thuộc npm mới (QĐ 517): `@xmldom/xmldom` và `xml-crypto` ở `@kt/api` (đọc XML hóa đơn, chuẩn hóa C14N, kiểm/ghép chữ ký XML-DSig), `qrcode` ở `@kt/web` (vẽ VietQR). Không thêm gì khác.

**Spec:** `docs/superpowers/specs/2026-10-19-phan-mem-ke-toan-design.md` (mục 9 dòng Ngân hàng, Mua hàng "hóa đơn đầu vào từ XML HĐĐT, kiểm tra tình trạng MST người bán", Thuế "TNDN", Hóa đơn điện tử; mục 10 dòng TNDN, Hóa đơn điện tử, Chữ ký điện tử; mục 11 Tích hợp; mục 13); lộ trình `docs/superpowers/plans/2026-10-19-lo-trinh-thuc-hien.md` mục "Giai đoạn 5"; bàn giao `docs/TIEP-THEO.md` mục "Bàn giao GĐ5"; khuôn `2026-10-23-giai-doan-4-chi-tiet.md`. Tài liệu tích hợp khảo cứu cho GĐ5: `docs/dev/tich-hop/sinvoice.md`, `docs/dev/tich-hop/ngan-hang.md`, `docs/dev/tich-hop/xml-hoa-don.md` (Task 0).

## Global Constraints

- Mọi quy tắc trong `CLAUDE.md` mục "Quy tắc bất biến". Tiền VND `NUMERIC(20,0)`, nguyên tệ `NUMERIC(20,4)`, tỷ giá `NUMERIC(20,10)`; trong TypeScript tiền là chuỗi + `D()`; đầu vào tiền VND theo `VND_AMOUNT_RE`. Số tiền nhận từ bên ngoài (JSON SePay "19689000.00", XML hóa đơn) đọc bằng chuỗi, không qua `Number`.
- Không `UPDATE`/`DELETE` dòng sổ cái đã ghi sổ. Hóa đơn điện tử không sinh bút toán. Ghi ngược số hóa đơn vào `voucher_invoice` của chứng từ đã ghi sổ chỉ qua hàm `fn_einvoice_set_number` (Task 3); chứng từ có hóa đơn điện tử đã phát hành không bỏ ghi sổ, không hủy, không đảo qua route chung (409 `EINVOICE_ISSUED`) — chỉ luồng thay thế/hủy hóa đơn (Task 6) được đảo.
- Bảng mới: `tenant_id uuid NOT NULL REFERENCES tenant(id)`, `SELECT rls_enable('<bảng>')`; bảng người dùng thao tác thêm `audit_enable` (trừ nhật ký `einvoice_log`, `bank_webhook_log`: chỉ thêm, không sửa); mọi `UNIQUE` có `tenant_id`; khóa ngoại tổng hợp `(tenant_id, x_id) REFERENCES cha (tenant_id, id)`; `ON DELETE SET NULL (x_id)`. Hàm `SECURITY DEFINER` có `SET search_path = public, pg_temp` và chỉ trả đúng cột cần (tra cấu hình webhook, khóa API theo băm khi chưa biết công ty).
- Migration 0001–0077 đóng băng; GĐ5 bắt đầu ở **0078** (bảng "Thứ tự thực hiện"). Định nghĩa lại hàm lấy thân hiện hành bằng `SELECT pg_get_functiondef('<hàm>'::regprocedure)` trên DB đã migrate tới số trước, không chép từ migration cũ.
- **Bí mật** (mật khẩu nhà cung cấp HĐĐT, khóa HMAC ngân hàng, thông tin ký số từ xa) mã hóa AES-256-GCM bằng `DATA_ENCRYPTION_KEY` (32 byte base64, biến môi trường mới; production bắt buộc; thiếu khóa thì lưu bí mật trả 409 `ENCRYPTION_KEY_MISSING`); không bao giờ trả về API, không ghi vào `audit_event` (cột bí mật thay bằng `"***"`), không ghi vào nhật ký gửi/nhận. Khóa API và mã webhook chỉ lưu băm SHA-256.
- **Gọi ra ngoài**: timeout mặc định 30 giây (SInvoice 60 giây theo tài liệu), không gọi trong giao dịch DB đang giữ khóa; mọi lần gọi nhà cung cấp HĐĐT ghi `einvoice_log` (yêu cầu, phản hồi đã che bí mật, mã HTTP, thời gian). Kiểm thử không gọi mạng thật: adapter thật kiểm bằng máy chủ giả lập cục bộ (Fastify trong kiểm thử) theo hợp đồng ở `docs/dev/tich-hop/*.md`.
- Pháp lý: ký hiệu mẫu/ký hiệu hóa đơn theo **TT 91/2026 Phụ lục I** (`~/legal-docs/tt91-2026/tt91-full.txt` dòng 1211–1301); mẫu 04/SS-HĐĐT theo TT 91/2026 Phụ lục III (cùng tệp, tìm "04/SS-HĐĐT"); 03/TNDN và 03-1A/TNDN theo TT 89/2026 Phụ lục I (OCR ở Task 0). **Không dựng cấu trúc XML 1450 hay quy tắc thuế từ trí nhớ**: thẻ XML lấy từ mẫu thật có nguồn (Task 0) và tài liệu thứ cấp ghi trong `docs/dev/tich-hop/xml-hoa-don.md`; thuế suất TNDN chỉ nhập khi có văn bản gốc trong `~/legal-docs/`, không có thì `complete=false` và người dùng nhập thuế suất.
- Cờ nhạy cảm chặn ở API: gợi ý đối chiếu giao dịch ngân hàng với khoản phải thu cần `view_receivable`, phải trả cần `view_payable` (thiếu cờ thì không trả gợi ý công nợ, vẫn trả gợi ý chứng từ có sẵn); API ngoài trả giá trị tồn kho chỉ khi người tạo khóa có `view_cost`; tạm tính TNDN đọc giá vốn tổng hợp (632) như B02 — theo quyền `cit.view`, không thêm cờ.
- Báo cáo đọc trong `READ_SNAPSHOT`. Mã lỗi `_NOT_FOUND` 404; trạng thái không cho thao tác 409; đầu vào sai 400; xác thực webhook/khóa API sai 401 (không lộ công ty có tồn tại hay không).
- Giao diện, thông báo lỗi, tài liệu: tiếng Việt kế toán chuẩn (Hóa đơn điện tử, Phát hành, Ký hiệu mẫu số, Ký hiệu hóa đơn, Mã của cơ quan thuế, Hóa đơn điều chỉnh, Hóa đơn thay thế, Thông báo hóa đơn điện tử có sai sót, Hóa đơn đầu vào, Giao dịch ngân hàng, Sao kê, Giấy báo Có, Giấy báo Nợ, Quyết toán thuế TNDN). Mã, bảng, biến: tiếng Anh.
- Màn hình mới: skill `evon:ui-ux` chế độ **dựng luôn**; dùng `KeyboardGrid`, `LookupSelect`, `VnNumberInput`, `useHotkeys`, `useRememberedFilter` của `@kt/ui`; mỗi màn hình ít nhất một spec Playwright trong `apps/web/e2e/` theo khuôn `phieu-thu.spec.ts` (`signIn`). E2E dùng nhà cung cấp `fake`.
- Kiểm thử tuần tự trên PostgreSQL thật (DB tạm theo lần chạy). Một gói: `pnpm -F @kt/api test -- test/<file>.test.ts`. Không chạy hai việc nặng song song (VPS 2 CPU). E2E: `E2E_API_PORT=3010 E2E_WEB_PORT=5183 pnpm -F @kt/web e2e`.
- Commit nhỏ Conventional Commits, mô tả tiếng Việt, scope `db|domain|api|worker|web|ui|coa|docs`; trailer `Co-Authored-By` của model viết commit. Làm trên nhánh worktree `worktree-gd5`, **push `HEAD:main` (fast-forward) sau mỗi tác vụ**. Quyết định ghi vào `docs/superpowers/plans/2026-10-24-giai-doan-5-quyet-dinh.md` (đánh số tiếp GĐ4, từ #515). Nhật ký tiến độ một dòng mỗi tác vụ vào `docs/NHAT-KY-TIEN-DO.md`.

## Quy ước thiết kế đã chốt

1. **Một chứng từ bán – một hóa đơn điện tử còn hiệu lực.** `einvoice.voucher_id` duy nhất trong các hàng `status <> 'failed'`; hóa đơn điều chỉnh/thay thế là chứng từ bán mới (GGB/TLB giảm, HDB/BH tăng hoặc thay thế) có hóa đơn riêng trỏ `original_id`. Hóa đơn phát hành cho chứng từ `posted`; sau phát hành chứng từ khóa (quy ước 4).
2. **Số hóa đơn do nhà cung cấp cấp.** Chứng từ bán chọn `invoice.einvoiceSeriesId` thì `invoiceNo` bỏ trống; `voucher_invoice.invoice_no` được NULL chỉ khi `direction = 'sale'` và `einvoice_pending = true`. Phát hành thành công: `fn_einvoice_set_number(voucher, form_no, serial, invoice_no, invoice_date)` điền bốn cột trên mọi dòng `voucher_invoice` của chứng từ và đặt `einvoice_pending = false` — chỉ chạy được khi các cột đó đang NULL/pending (không ghi đè số đã có).
3. **Hai pha, chống trùng.** Pha 1 (giao dịch): kiểm điều kiện, khóa tư vấn `('einvoice', voucher_id)`, tạo/đặt `einvoice.status = 'sending'`, `transaction_uuid` (giữ nguyên qua các lần thử lại), lưu `payload` gửi đi. Pha 2: gọi `provider.create(doc)`. Pha 3 (giao dịch): thành công → `issued` + số; lỗi nghiệp vụ có mã từ nhà cung cấp → `failed` + mã/lỗi (được sửa chứng từ? không — chứng từ vẫn khóa đến khi người dùng "Bỏ phát hành" hóa đơn `failed`, Task 5); lỗi mạng/timeout → giữ `sending`. Thử lại hoặc worker: `provider.findByTransaction(uuid)` trước, có thì nhận kết quả, không có mới gọi `create` lại với cùng `uuid`.
4. **Khóa chứng từ đã phát hành.** Trigger `BEFORE UPDATE OF state ON voucher`: chuyển khỏi `posted` khi có `einvoice` cùng chứng từ ở `sending|issued` → `EINVOICE_ISSUED`, trừ khi `app.einvoice_reversal = 'on'` (chỉ Task 6 đặt, trong giao dịch thay thế/hủy). `updatePostedMeta` (sửa diễn giải sau ghi sổ) vẫn được.
5. **Mô hình trung lập.** `EInvoiceDoc` (Task 4) là dữ liệu nhà cung cấp cần: người bán, người mua, dòng hàng (tên, ĐVT, số lượng, đơn giá, tiền, chiết khấu, thuế suất, tiền thuế), tổng theo thuế suất (lấy từ `voucher_invoice`, đúng số đã kê khai), tiền tệ/tỷ giá, hình thức thanh toán, liên kết điều chỉnh/thay thế. Adapter chỉ ánh xạ `EInvoiceDoc` ↔ API của mình.
6. **Hóa đơn đầu vào là hộp thư.** `inbound_invoice` lưu nguyên XML (khóa trùng SHA-256 và (MST người bán, ký hiệu, số)); lập chứng từ mua là thao tác riêng tạo chứng từ nháp qua `createInvoice` hiện có, gắn `voucher_id`; không sửa hóa đơn đầu vào sau khi đã lập chứng từ.
7. **Giao dịch ngân hàng là hộp thư.** `bank_transaction` khóa trùng `(tenant_id, source, external_id)`; webhook trả thành công cả khi trùng (nhà cung cấp gửi lại). Đối chiếu = tạo BC/BN mới (thường, người dùng sở hữu) hoặc gắn chứng từ BC/BN đã ghi sổ cùng TK ngân hàng, cùng số tiền; một giao dịch gắn tối đa một chứng từ, một chứng từ tối đa một giao dịch.
8. **Khóa API.** Dạng `kt_<prefix 8>_<secret 32>` (base62), lưu `prefix` + SHA-256 của toàn chuỗi; chỉ dùng cho `/api/ext/v1/*`; quyền hiệu lực = quyền vai trò hiện hành của người tạo ∩ quyền của phạm vi khóa; cờ nhạy cảm của người tạo. Thu hồi có hiệu lực ngay.

## Hợp đồng ghi sổ GĐ5 (ai ghi sổ cái giá trị nào)

| Thao tác | Ai | Sổ cái | Ghi chú |
|---|---|---|---|
| Phát hành HĐĐT cho HDB/BH/GGB/TLB đã ghi sổ | `einvoice/issue.ts` | không | chỉ điền số vào `voucher_invoice` (quy ước 2) |
| Điều chỉnh tăng/giảm | người dùng lập chứng từ bán mới, rồi phát hành dạng điều chỉnh | chứng từ mới (thường) | hóa đơn gốc giữ `issued`, có `adjusted = true` |
| Thay thế | người dùng lập chứng từ bán mới; phát hành dạng thay thế | chứng từ mới; **chứng từ gốc đảo** (ngày gốc nếu kỳ gốc mở và người dùng có quyền, nếu không ngày chứng từ mới) trong pha 3 | gốc `replaced`; đảo hỏng ở pha 3 → `needs_reversal = true`, soát lỗi báo |
| Hủy hóa đơn (nhà cung cấp cho phép) | `einvoice/lifecycle.ts` | chứng từ gốc đảo như thay thế | gốc `cancelled` |
| Lập chứng từ từ hóa đơn đầu vào | `inbound/toVoucher.ts` → `createInvoice` | HDM/MH nháp (thường) | `inbound_invoice.voucher_id` |
| Đối chiếu giao dịch ngân hàng: lập mới | `bank/match.ts` → tạo BC/BN qua dịch vụ chứng từ tiền hiện có (+ đối trừ `settlement` nếu chọn khoản công nợ) | BC/BN (thường) | `bank_transaction.voucher_id` |
| Đối chiếu: gắn chứng từ có sẵn | `bank/match.ts` | không | |
| Chi phí thuế TNDN tạm tính quý | người dùng bấm "Lập chứng từ" trên màn tạm tính → PKT nháp Nợ 8211 / Có 3334 | PKT (thường) | không phải chứng từ hệ thống |
| Bán hàng qua API ngoài | `ext/sales.ts` → `createInvoice` (BH/HDB) + tùy chọn PT/BC | chứng từ thường, `idempotency_key = 'ext:' + externalId` | |

## Review Focus

1. Mạng đứt sau khi nhà cung cấp đã cấp số nhưng trước khi API nhận phản hồi: hóa đơn ở `sending`; bấm "Thử lại" hoặc worker chạy → tra theo `transaction_uuid` nhận đúng số cũ, không phát hành hóa đơn thứ hai; hai người bấm phát hành cùng lúc → một lần gọi `create` (Task 5 có kiểm thử với nhà cung cấp giả lập chế độ `timeout_after_create`).
2. Bỏ ghi sổ, hủy, đảo, xóa chứng từ bán đã có hóa đơn `issued` qua route chung → 409 `EINVOICE_ISSUED`, kể cả qua lô ghi sổ/bỏ ghi sổ và quy trình chạy lại giá vốn (giá vốn chỉ sinh GV riêng, không chạm chứng từ BH) (Task 3).
3. Webhook SePay gửi lại cùng giao dịch 7 lần, có lần đồng thời: đúng một `bank_transaction`; chữ ký HMAC sai, token sai, công ty khác → 401 và không ghi gì; giao dịch tiền ra (`transferType = 'out'`) ghi `amount_out` (Task 13).
4. Hóa đơn đầu vào: XML có namespace/tiền tố khác nhau giữa nhà cung cấp, số có phần thập phân "1.000.000,5" hay "1000000.50", thuế suất "KCT"/"KKKNT"/"8%", hóa đơn ngoại tệ; tệp không phải XML hoặc XML có DOCTYPE/thực thể ngoài → 400 không đọc thực thể ngoài (chống XXE); cùng tệp tải lại → `duplicate` (Task 11).
5. Khóa API bị thu hồi hoặc người tạo bị khóa/mất quyền `voucher.create`: gọi `/api/ext/v1/sales` → 401/403 ngay; khóa không dùng được cho route thường `/api/vouchers`; gửi cùng `externalId` hai lần → một chứng từ (Task 16).

---

## Cấu trúc file

- `packages/domain/src/`: `invoiceSymbol.ts` (ký hiệu TT91), `vietqr.ts` (payload EMVCo + CRC), `permissions.ts`, `cit.ts` (tạm tính TNDN thuần).
- `packages/db/migrations/0078_quyen_gd5.sql` … `0086_soat_loi_gd5.sql` (bảng "Thứ tự thực hiện").
- `apps/api/src/lib/secretBox.ts` (AES-256-GCM), `apps/api/src/lib/http.ts` (fetch có timeout, che bí mật trong nhật ký).
- `apps/api/src/modules/einvoice/`: `config.ts` (nhà cung cấp, ký hiệu), `doc.ts` (`buildEInvoiceDoc`), `providers/types.ts`, `providers/fake.ts`, `providers/sinvoice.ts`, `providers/index.ts`, `issue.ts`, `lifecycle.ts` (điều chỉnh, thay thế, hủy, thanh toán), `errorNotice.ts` (04/SS), `reconcile.ts`, `routes.ts`.
- `apps/api/src/modules/signing/`: `xmldsig.ts`, `sessions.ts`, `providers/{types,localAgent,smartca,fake}.ts`, `routes.ts`; `tools/signer-agent/` (tiện ích ký cục bộ tham chiếu, ký bằng tệp .pfx).
- `apps/api/src/modules/inbound/`: `parse1450.ts`, `verify.ts`, `store.ts`, `toVoucher.ts`, `taxCodeLookup.ts`, `routes.ts`.
- `apps/api/src/modules/bank/`: `feeds.ts`, `webhook.ts`, `statementImport.ts`, `match.ts`, `reconReport.ts`, `routes.ts`.
- `apps/api/src/modules/ext/`: `apiKeys.ts`, `auth.ts`, `routes.ts` (`/api/ext/v1`).
- `apps/api/src/modules/tax/`: `citEstimate.ts`, `citReturn.ts`, `xml/htkk03tndn.ts`.
- `apps/worker/src/jobs/einvoiceReconcile.ts`.
- `packages/coa-data/data/tax/03tndn-tt89.json`, `03-1a-tndn-tt89.json`, `htkk-03tndn.json`, `legal-params.json` (thêm TNDN nếu có văn bản), `data/banks/napas-bins.json`.
- `apps/web/src/pages/`: `EInvoices.tsx`, `EInvoiceConfig.tsx`, `EInvoiceErrorNotice.tsx`, `InboundInvoices.tsx`, `BankTransactions.tsx`, `BankFeeds.tsx`, `ApiKeys.tsx`, `CitEstimate.tsx`, `CitReturn.tsx`, `SigningSetup.tsx`; `packages/ui/src/VietQr.tsx`.
- Kiểm thử: `apps/api/test/einvoice/*.test.ts`, `test/inbound/*.test.ts` (mẫu XML ở `test/fixtures/xml/`), `test/bank/*.test.ts`, `test/ext/*.test.ts`, `test/signing/*.test.ts`, `test/tax/cit*.test.ts`, `test/invariants/inv9-hoa-don-ngan-hang.test.ts`, `packages/domain/test/{invoiceSymbol,vietqr,cit}.test.ts`.
- `docs/user/giai-doan-5-hoa-don-tich-hop.md`, `docs/dev/tich-hop/*.md`, `docs/dev/ky-so-cuc-bo.md`.

---

### Task 0: Khảo cứu tích hợp, văn bản gốc và mẫu XML (đã giao trước khi viết kế hoạch)

Model: sonnet (ba agent song song). Controller rà kết quả, ghi quyết định, commit cùng kế hoạch.

**Đầu ra:** `docs/dev/tich-hop/sinvoice.md` (API SInvoice theo mã Odoo `l10n_vn_edi_viettel`, LGPL-3: endpoint, JSON, mã lỗi, điều chỉnh/thay thế), `docs/dev/tich-hop/ngan-hang.md` (SePay/Casso webhook và xác thực, VietQR EMVCo + vector kiểm thử đã kiểm CRC, nguồn BIN, tra MST, SmartCA), văn bản gốc ở `~/legal-docs/` (Luật 67/2025, NĐ 320/2025, NĐ 254/2026, trang 03/TNDN và 03-1A trong TT 89/2026), mẫu XML hóa đơn của ít nhất 3 nhà cung cấp (`/home/ubuntu/.claude/jobs/040a2c8b/tmp/xml-samples/` + `NGUON.md`). Controller viết `docs/dev/tich-hop/xml-hoa-don.md` (đường dẫn thẻ thật, khác biệt giữa nhà cung cấp) và chép mẫu XML có giấy phép cho phép vào `apps/api/test/fixtures/xml/` (mẫu không rõ giấy phép: tự dựng lại mẫu tối giản cùng cấu trúc, ghi rõ "dựng theo cấu trúc của …"). Thứ gì không có: ghi mục 4 TIEP-THEO.

---

### Task 1: Quyền GĐ5, khóa mã hóa bí mật, cài đặt

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0078_quyen_gd5.sql`, `apps/api/src/lib/secretBox.ts`, `apps/api/src/lib/http.ts`
- Modify: `packages/domain/src/permissions.ts`, `apps/api/src/config.ts`, `.env.example`, `apps/api/test/helpers*` (đặt `DATA_ENCRYPTION_KEY` kiểm thử), `apps/api/src/modules/core/settings.ts`, `docs/dev/kiem-thu.md`
- Test: `packages/domain/test/permissions.test.ts`, `apps/api/test/secretBox.test.ts`, `apps/api/test/config.test.ts`, `apps/api/test/settings.test.ts`

**Interfaces:**
- Quyền: `...crud('einvoice', 'hóa đơn điện tử', 'Hóa đơn điện tử', [['issue', 'Phát hành'], ['config', 'Cấu hình nhà cung cấp, ký hiệu']])`, `...crud('inbound_invoice', 'hóa đơn đầu vào', 'Hóa đơn điện tử')`, `...crud('bank_feed', 'kết nối và giao dịch ngân hàng', 'Ngân hàng', [['match', 'Đối chiếu']])`, `{ code: 'api_key.manage', name: 'Quản lý khóa API', group: 'Hệ thống' }`, `...crud('cit', 'thuế TNDN', 'Thuế')`, `{ code: 'signing.use', name: 'Ký số', group: 'Hệ thống' }`.
- `0078`: `create_tenant` định nghĩa lại từ thân hiện hành; `ketoan_vien` có `einvoice.*` trừ `einvoice.config`, `inbound_invoice.*`, `bank_feed.view|match`, `cit.*`, `signing.use`; `xem` có `*.view`; công ty đã có được cấp như vậy (tắt `trg_audit` của `role_permission` khi chèn, khuôn 0069).
- `secretBox.ts`: `sealSecret(plain: string): Buffer` (định dạng `v1|iv 12|tag 16|ciphertext`), `openSecret(sealed: Buffer): string`, `hasEncryptionKey(): boolean`; khóa đọc từ `process.env.DATA_ENCRYPTION_KEY` (base64 đúng 32 byte, sai → lỗi khởi động). Thiếu khóa: `sealSecret` ném `AppError('ENCRYPTION_KEY_MISSING', 'Chưa cấu hình DATA_ENCRYPTION_KEY nên không lưu được mật khẩu, khóa bí mật', 409)`.
- `config.ts`: `DATA_ENCRYPTION_KEY: z.string().optional()` (production bắt buộc), `PUBLIC_BASE_URL: z.string().url().optional()` (in URL webhook cho người dùng).
- `http.ts`: `httpJson<T>(url: string, init: { method: string; headers?: Record<string,string>; body?: unknown; timeoutMs: number }): Promise<{ status: number; body: T; raw: string; ms: number }>` dùng `fetch` + `AbortSignal.timeout`; lỗi mạng/timeout ném `NetworkError` (lớp riêng, `kind: 'timeout' | 'network'`); `redact(obj, keys: string[])` thay giá trị khóa nhạy cảm bằng `"***"` đệ quy.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('công ty mới: ketoan_vien có einvoice.issue, bank_feed.match; không có einvoice.config, api_key.manage; xem có einvoice.view', async () => {});
it('sealSecret/openSecret khứ hồi; sửa một byte ciphertext → openSecret ném', () => {});
it('không có DATA_ENCRYPTION_KEY: sealSecret ném ENCRYPTION_KEY_MISSING 409', () => {});
it('NODE_ENV=production thiếu DATA_ENCRYPTION_KEY → loadConfig ném', () => {});
it('redact thay password, secret ở mọi cấp', () => {});
```

- [ ] **Step 2:** `pnpm -F @kt/domain test`, `pnpm -F @kt/api test -- test/secretBox.test.ts test/config.test.ts` → FAIL.
- [ ] **Step 3:** Viết migration, domain, `secretBox.ts`, `http.ts`, cấu hình.
- [ ] **Step 4:** PASS; `pnpm db:migrate`; `pnpm -F @kt/api test` xanh.
- [ ] **Step 5:** Commit `feat(db): quyền GĐ5, mã hóa bí mật tích hợp`.

### Task 2: Ký hiệu hóa đơn TT 91/2026, nhà cung cấp HĐĐT, dải ký hiệu

Model: sonnet.

**Files:**
- Create: `packages/domain/src/invoiceSymbol.ts`, `packages/db/migrations/0079_hddt_cau_hinh.sql`, `apps/api/src/modules/einvoice/config.ts`, `apps/api/src/modules/einvoice/routes.ts`
- Modify: `packages/domain/src/index.ts`, `packages/db/src/types.ts`, `apps/api/src/app.ts`
- Test: `packages/domain/test/invoiceSymbol.test.ts`, `apps/api/test/einvoice/config.test.ts`

**Interfaces:**
- `parseInvoiceSymbol(formNo: string, serial: string): { ok: true; formNo: '1'..'9'; withCode: boolean; year: number; typeLetter: string; suffix: string } | { ok: false; message: string }` theo TT 91/2026 Phụ lục I: `formNo` một chữ số 1–9; `serial` sáu ký tự: `C|K`, hai chữ số năm, một chữ trong `T D L M N B G H X F`, hai chữ cái in hoa cuối (người bán tự đặt; không nhu cầu dùng `YY`). Ghi nguồn bằng chú thích (Phụ lục I mục 1, 2). Ví dụ phải đúng: `1`+`C26TAA`, `2`+`C26TBB`, `1`+`K26TYY`, `6`+`K26NAB`, `7`+`K26XAB`.
- `einvoice_provider(id, code text CHECK IN ('fake','sinvoice'), name, base_url text, username text, secret bytea NULL, seller_tax_code text, options jsonb DEFAULT '{}', is_active, created_at)`; `UNIQUE(tenant_id, id)`.
- `einvoice_series(id, provider_id, form_no text, serial text, year int, kind text CHECK IN ('standard','cash_register'), provider_template text NULL (mã mẫu của nhà cung cấp, ví dụ `1/001`), is_active, note)`; `UNIQUE(tenant_id, form_no, serial)`; `kind = 'cash_register'` ⇔ chữ thứ tư `M`; năm = 2000 + hai chữ số.
- API (`einvoice.config` để ghi, `einvoice.view` để đọc): `GET/POST/PUT/DELETE /api/einvoice/providers` (DTO không có mật khẩu, có `hasSecret: boolean`; PUT `password` bỏ trống = giữ), `POST /api/einvoice/providers/:id/test` (gọi `provider.ping()`, trả `{ ok, message }`), `GET/POST/PUT/DELETE /api/einvoice/series` (409 `SERIES_IN_USE` khi đã có hóa đơn). Ký hiệu sai → 400 `INVOICE_SYMBOL_INVALID` với thông điệp của `parseInvoiceSymbol`.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it.each([['1','C26TAA',true],['2','C26TBB',true],['1','C26LBB',true],['1','K26TYY',true],['3','C26DYY',true],['6','K26NAB',true],['7','K26XAB',true],
  ['0','C26TAA',false],['1','A26TAA',false],['1','C26ZAA',false],['1','C26Taa',false],['1','C2TAA',false]])('parseInvoiceSymbol(%s,%s) → %s', () => {});
it('tạo nhà cung cấp sinvoice có mật khẩu: GET không trả mật khẩu, hasSecret true; audit_event không chứa mật khẩu', async () => {});
it('ký hiệu 1C26MAA kind standard → 400 (M là máy tính tiền)', async () => {});
it('ketoan_vien POST /api/einvoice/providers → 403', async () => {});
```

- [ ] **Step 2:** chạy → FAIL. **Step 3:** viết. **Step 4:** PASS, `pnpm -F @kt/api test` xanh.
- [ ] **Step 5:** Commit `feat(api): ký hiệu hóa đơn TT 91/2026, cấu hình nhà cung cấp và dải ký hiệu HĐĐT`.

### Task 3: Bảng hóa đơn điện tử, chứng từ bán chờ số, khóa chứng từ đã phát hành

Model: sonnet; rà soát opus (trigger trạng thái chứng từ, hàm ghi số).

**Files:**
- Create: `packages/db/migrations/0080_hddt.sql`
- Modify: `packages/db/src/types.ts`, `apps/api/src/modules/invoices/service.ts` (`invoiceHeaderInput.einvoiceSeriesId`, `invoiceNo` tùy chọn khi có ký hiệu), `apps/api/src/modules/invoices/declaration.ts`, `apps/api/src/modules/ledger/vouchers.service.ts` (ánh xạ lỗi `EINVOICE_ISSUED` 409), `apps/api/src/modules/tax/register.ts` (cột số hóa đơn trống hiện "Chưa phát hành")
- Test: `apps/api/test/einvoice/schema.test.ts`, `apps/api/test/invoices.test.ts`

**Interfaces:**
- `einvoice(id bigint, voucher_id uuid NOT NULL, series_id NOT NULL, provider_id NOT NULL, relation text CHECK IN ('original','adjustment','replacement') DEFAULT 'original', original_id bigint NULL, adjust_kind text NULL CHECK IN ('increase','decrease','info'), status text CHECK IN ('draft','sending','issued','failed','replaced','cancelled'), transaction_uuid uuid NOT NULL, invoice_no text, issued_at timestamptz, issue_date date, cqt_code text, cqt_status text CHECK IN ('none','waiting','accepted','rejected') DEFAULT 'none', provider_ref jsonb DEFAULT '{}' (reservationCode, transactionID…), payload jsonb, xml text NULL (XML đã ký khi lấy về), error_code text, error_message text, needs_reversal boolean DEFAULT false, adjusted boolean DEFAULT false, paid boolean DEFAULT false, attempts int DEFAULT 0, last_attempt_at timestamptz, created_by, created_at)`; `UNIQUE(tenant_id, transaction_uuid)`; `UNIQUE(tenant_id, id)`; chỉ mục duy nhất `(tenant_id, voucher_id) WHERE status NOT IN ('failed')`; `CHECK ((relation = 'original') = (original_id IS NULL))`; khóa ngoại tổng hợp tới `voucher`, `einvoice_series`, `einvoice_provider`, `einvoice` (gốc).
- `einvoice_log(id bigint, einvoice_id bigint NULL, provider_id, action text, request jsonb, response jsonb, http_status int, ok boolean, error text, ms int, created_by uuid, created_at)`; chỉ `INSERT` (trigger chặn UPDATE/DELETE).
- `voucher_invoice`: thêm `einvoice_series_id bigint NULL`, `einvoice_pending boolean NOT NULL DEFAULT false`; `invoice_no` bỏ `NOT NULL`, thay CHECK thành `(invoice_no IS NOT NULL AND btrim(invoice_no) <> '') OR (invoice_no IS NULL AND einvoice_pending AND direction = 'sale')`.
- `fn_voucher_child_guard` (thân hiện hành): cho qua `UPDATE` trên `voucher_invoice` khi `current_setting('app.einvoice_number', true) = 'on'` **và** chỉ các cột `form_no, serial, invoice_no, invoice_date, einvoice_pending` thay đổi.
- `fn_einvoice_set_number(p_voucher uuid, p_form text, p_serial text, p_no text, p_date date) RETURNS int` (SECURITY INVOKER; đặt `app.einvoice_number` cục bộ trong hàm bằng `set_config(..., true)` rồi trả về số dòng): chỉ cập nhật dòng `einvoice_pending`; 0 dòng → `EINVOICE_NUMBER_SET` (đã có số).
- Trigger `trg_voucher_einvoice_lock BEFORE UPDATE OF state ON voucher`: `OLD.state = 'posted' AND NEW.state <> 'posted'` và tồn tại `einvoice` của `OLD.id` ở `sending|issued` → `EINVOICE_ISSUED: chứng từ đã phát hành hóa đơn điện tử số …; lập hóa đơn điều chỉnh/thay thế hoặc hủy hóa đơn`, trừ khi `app.einvoice_reversal = 'on'`. `BEFORE DELETE ON voucher` có `einvoice` bất kỳ trạng thái trừ `failed` → cùng lỗi.
- `invoiceHeaderInput.einvoiceSeriesId?: number`: chỉ cho `HDB, BH, GGB, TLB`; có thì `invoiceNo` phải trống, `formNo`/`serial` lấy từ dải ký hiệu, dòng `voucher_invoice` ghi `einvoice_pending = true`; ký hiệu ngừng dùng → 409 `SERIES_INACTIVE`; năm ký hiệu khác năm `postingDate` → 400 `SERIES_YEAR_MISMATCH`.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('HDB có einvoiceSeriesId, không invoiceNo: ghi sổ được; voucher_invoice.invoice_no NULL, einvoice_pending true, serial C26TAA', async () => {});
it('HDM không invoiceNo → 400 (chỉ hóa đơn bán được chờ số)', async () => {});
it('fn_einvoice_set_number điền số cho chứng từ đã ghi sổ; gọi lần hai → EINVOICE_NUMBER_SET; UPDATE thẳng base_amount vẫn VOUCHER_CHILD_IMMUTABLE', async () => {});
it('chứng từ có einvoice issued: bỏ ghi sổ, đảo, hủy qua /api/vouchers → 409 EINVOICE_ISSUED; sửa diễn giải sau ghi sổ vẫn được', async () => {});
it('einvoice failed không khóa chứng từ; hai einvoice không failed cùng chứng từ → vi phạm duy nhất', async () => {});
it('einvoice_log không UPDATE/DELETE được', async () => {});
it('bảng kê bán ra: hóa đơn chờ số hiện số "Chưa phát hành", vẫn cộng vào tờ khai theo kỳ chứng từ', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** viết migration (lấy thân hàm hiện hành), dịch vụ. **Step 4:** PASS, `pnpm -F @kt/api test` xanh (kiểm thử hóa đơn cũ không đổi).
- [ ] **Step 5:** Commit `feat(db): hóa đơn điện tử gắn chứng từ bán, chờ số, khóa chứng từ đã phát hành`.

### Task 4: `EInvoiceProvider`, mô hình hóa đơn trung lập, nhà cung cấp giả lập

Model: sonnet.

**Files:**
- Create: `apps/api/src/modules/einvoice/providers/types.ts`, `providers/fake.ts`, `providers/index.ts`, `apps/api/src/modules/einvoice/doc.ts`
- Test: `apps/api/test/einvoice/doc.test.ts`, `apps/api/test/einvoice/fakeProvider.test.ts`

**Interfaces:**
```ts
export interface EInvoiceParty { name: string; taxCode: string | null; address: string | null; buyerName?: string | null; email?: string | null; phone?: string | null; bankAccount?: string | null; bankName?: string | null; idNo?: string | null }
export interface EInvoiceLine { lineNo: number; kind: 'goods' | 'promotion' | 'discount' | 'note'; code: string | null; name: string; uom: string | null; quantity: string | null; unitPrice: string | null;
  amount: string; discountRate: string | null; discountAmount: string; taxRate: string /* '0','5','8','10','KCT','KKKNT','KHAC' */; taxAmount: string; total: string; increase?: boolean }
export interface EInvoiceTaxGroup { taxRate: string; base: string; tax: string }
export interface EInvoiceDoc {
  transactionUuid: string; formNo: string; serial: string; providerTemplate: string | null; issueDate: string; currency: string; fxRate: string; paymentMethod: string;
  seller: EInvoiceParty; buyer: EInvoiceParty; lines: EInvoiceLine[]; taxGroups: EInvoiceTaxGroup[];
  totals: { beforeTax: string; tax: string; discount: string; total: string; totalInWords: string };
  relation: { kind: 'original' } | { kind: 'adjustment'; adjust: 'increase' | 'decrease' | 'info'; original: OriginalRef; agreementNo?: string; agreementDate?: string; reason: string }
    | { kind: 'replacement'; original: OriginalRef; agreementNo?: string; agreementDate?: string; reason: string };
}
export interface OriginalRef { formNo: string; serial: string; invoiceNo: string; issueDate: string; providerRef: Record<string, unknown> }
export interface IssueResult { invoiceNo: string; issueDate: string; cqtCode: string | null; cqtStatus: 'none' | 'waiting' | 'accepted' | 'rejected'; providerRef: Record<string, unknown> }
export class ProviderError extends Error { constructor(public code: string, message: string, public retriable: boolean) }
export interface ProviderCtx { log(entry: { action: string; request: unknown; response: unknown; httpStatus: number | null; ok: boolean; error?: string; ms: number }): Promise<void> }
export interface EInvoiceProvider {
  readonly code: 'fake' | 'sinvoice';
  ping(ctx: ProviderCtx): Promise<void>;
  create(ctx: ProviderCtx, doc: EInvoiceDoc): Promise<IssueResult>;
  findByTransaction(ctx: ProviderCtx, doc: Pick<EInvoiceDoc, 'transactionUuid' | 'seller'>): Promise<IssueResult | null>;
  getFile(ctx: ProviderCtx, ref: OriginalRef, kind: 'pdf' | 'xml'): Promise<Buffer>;
  refreshStatus(ctx: ProviderCtx, ref: OriginalRef): Promise<Pick<IssueResult, 'cqtCode' | 'cqtStatus'>>;
  cancel?(ctx: ProviderCtx, ref: OriginalRef, reason: string, date: string): Promise<void>;
  setPaid?(ctx: ProviderCtx, ref: OriginalRef, paid: boolean): Promise<void>;
  sendErrorNotice?(ctx: ProviderCtx, notice: ErrorNoticeDoc): Promise<{ ref: string }>;
}
export function providerFor(row: { code: string; base_url: string; username: string; secret: Buffer | null; seller_tax_code: string; options: unknown }): EInvoiceProvider;
export async function buildEInvoiceDoc(trx: Trx, einvoiceId: number): Promise<EInvoiceDoc>;
```
- `buildEInvoiceDoc`: người bán = thông tin công ty (`tenant` + cài đặt địa chỉ, MST); người mua = `voucher_invoice.party_*` (ghi đè) hoặc đối tượng; dòng từ `voucher_item_line` (tên = diễn giải hoặc tên VTHH; chiết khấu dòng `discount_amount_currency`; thuế suất từ mã GTGT của dòng: `rate` → chuỗi số, `rate null` → mã báo cáo KCT/KKKNT theo `tax_distribution.report_tag`); `taxGroups` = Σ `voucher_invoice.base_amount`/`tax_amount` theo mã thuế (đúng số đã kê khai; ngoại tệ thì tiền nguyên tệ theo dòng hàng, VND theo `voucher_invoice`); tổng tiền bằng chữ dùng hàm đọc số tiếng Việt đã có (tìm `numberToWords`/`docSo` trong `@kt/domain`). GGB/TLB: `adjust = 'decrease'`, số tiền dương.
- Giả lập `fake`: lưu trong bảng `einvoice_fake_store(tenant_id, transaction_uuid, serial, invoice_no, issue_date, cqt_code, cancelled)` (migration 0080 cùng Task 3; RLS) để sống qua khởi động lại API; số tăng dần theo ký hiệu từ 1; `withCode` → `cqtCode` = 34 ký tự hex lấy từ băm `uuid`; `options.mode`: `'ok' | 'reject' (ProviderError 'FAKE_REJECT', không thử lại) | 'timeout_before' (ném NetworkError, không lưu) | 'timeout_after_create' (lưu rồi ném NetworkError)`; `getFile` trả HTML/“PDF” giả và XML tối giản theo cấu trúc `HDon` (Task 0) có `MCCQT`.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('buildEInvoiceDoc HDB 2 dòng 10% + 1 dòng 8% (giảm thuế NQ 204): taxGroups khớp voucher_invoice, totals.total = Σ dòng + thuế, totalInWords tiếng Việt', async () => {});
it('BH USD tỷ giá 25.000: currency USD, lines theo nguyên tệ, fxRate "25000"', async () => {});
it('GGB điều chỉnh giảm trỏ hóa đơn gốc: relation adjustment decrease, original.invoiceNo của gốc', async () => {});
it('fake: create cùng transactionUuid hai lần trả cùng số; timeout_after_create rồi findByTransaction trả số đã cấp', async () => {});
it('fake reject → ProviderError retriable false', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** viết. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(api): giao diện nhà cung cấp HĐĐT, mô hình hóa đơn trung lập, nhà cung cấp giả lập`.

### Task 5: Phát hành hai pha, thử lại, đối soát nền, lấy PDF/XML

Model: opus (đồng thời, chống trùng).

**Files:**
- Create: `apps/api/src/modules/einvoice/issue.ts`, `apps/api/src/modules/einvoice/reconcile.ts`, `apps/worker/src/jobs/einvoiceReconcile.ts`, `packages/db/migrations/0081_hddt_doi_soat.sql`
- Modify: `apps/api/src/modules/einvoice/routes.ts`, `apps/worker/src/index.ts`, `packages/db/src/queues.ts` (hoặc nơi khai `QUEUES`)
- Test: `apps/api/test/einvoice/issue.test.ts`, `apps/worker/test/einvoiceReconcile.test.ts`

**Interfaces:**
- `issueEInvoice(db: Kysely<Database>, ctx: { tenantId: string; userId: string }, voucherId: string, opts: { issueDate?: string }): Promise<EInvoiceDto>`: pha 1 trong `withTenant` (khóa `pg_advisory_xact_lock(hashtext('einvoice'), hashtext(voucherId))`; chứng từ phải `posted`, loại HDB/BH/GGB/TLB, có `einvoice_pending`; đã có einvoice `issued|sending` → 409 `EINVOICE_EXISTS`; `issueDate` mặc định ngày Việt Nam hôm nay, không trước `postingDate` của chứng từ quá 0 ngày? — **không chặn**, chỉ cảnh báo `ISSUE_DATE_DIFFERS_PERIOD` khi khác tháng; tạo einvoice `sending` (hoặc dùng lại hàng `failed`/`draft` của chứng từ với `transaction_uuid` mới chỉ khi hàng cũ `failed`), lưu `payload` = `buildEInvoiceDoc`); pha 2 gọi `provider.create` (ngoài giao dịch); pha 3 `finalizeIssue(db, ctx, einvoiceId, outcome)`.
- `finalizeIssue`: thành công → `fn_einvoice_set_number`, `status = 'issued'`, lưu `invoice_no`, `issue_date`, `cqt_*`, `provider_ref`; `ProviderError retriable=false` → `failed`, `error_*`; `NetworkError` hoặc `retriable=true` → giữ `sending`, tăng `attempts`. Tất cả trong một giao dịch, kiểm `status = 'sending'` trước khi ghi (hai pha 3 song song: một bên thắng).
- `retryEInvoice(db, ctx, id)`: chỉ hàng `sending`; gọi `findByTransaction` trước, `null` mới `create` (cùng `transaction_uuid`, cùng `payload` đã lưu — không dựng lại).
- `discardFailed(db, ctx, id)`: hàng `failed` → xóa mềm (giữ hàng, chứng từ hết khóa); quyền `einvoice.issue`.
- `reconcilePending(db, providerFactory, opts: { olderThanSec: number; limit: number }): Promise<{ checked: number; issued: number; failed: number }>`: duyệt `fn_einvoice_pending_tenants()` (SECURITY DEFINER, trả `tenant_id` có hàng `sending` cũ hơn ngưỡng hoặc `cqt_status = 'waiting'`), mỗi công ty `withTenant` → `retryEInvoice` / `provider.refreshStatus`.
- Worker: hàng đợi `einvoice-reconcile` lịch `*/5 * * * *`, `olderThanSec = 120`.
- Routes: `POST /api/einvoices { voucherId, issueDate? }` (`einvoice.issue`), `POST /api/einvoices/:id/retry`, `POST /api/einvoices/:id/discard`, `POST /api/einvoices/:id/refresh` (tra mã CQT), `GET /api/einvoices?status=&from=&to=&q=` (`einvoice.view`, danh sách: số, ký hiệu, ngày, khách, tổng tiền, trạng thái, mã CQT, chứng từ), `GET /api/einvoices/:id` (kèm nhật ký), `GET /api/einvoices/:id/file?kind=pdf|xml` (XML lấy về được thì lưu `einvoice.xml` một lần), `GET /api/vouchers/:id/einvoice`.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('phát hành HDB đã ghi sổ qua fake: issued, invoice_no 1, voucher_invoice có số, einvoice_log 1 dòng ok', async () => {});
it('chứng từ nháp → 409 VOUCHER_NOT_POSTED; HDM → 400; đã issued → 409 EINVOICE_EXISTS', async () => {});
it('timeout_after_create: trạng thái sending; retry → findByTransaction trả số cũ, create không gọi lại (đếm lời gọi), issued', async () => {});
it('hai yêu cầu phát hành đồng thời cùng chứng từ: một issued, một 409; fake ghi đúng một hóa đơn', async () => {});
it('reject → failed, chứng từ bỏ ghi sổ được sau discard; phát hành lại dùng transaction_uuid mới', async () => {});
it('reconcilePending với hai công ty: chỉ đụng hàng sending cũ hơn 120 giây, mỗi công ty dưới RLS của nó', async () => {});
it('ký hiệu C: cqt_status waiting rồi refresh → accepted có cqt_code', async () => {});
it('GET file xml lưu einvoice.xml; người chỉ có einvoice.view tải được, không có quyền → 403', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** viết. **Step 4:** PASS; `pnpm -F @kt/worker test`, `pnpm -F @kt/api test` xanh.
- [ ] **Step 5:** Commit `feat(api): phát hành hóa đơn điện tử hai pha, thử lại theo mã giao dịch, đối soát nền`.

### Task 6: Điều chỉnh, thay thế, hủy, trạng thái thanh toán

Model: opus.

**Files:**
- Create: `apps/api/src/modules/einvoice/lifecycle.ts`
- Modify: `apps/api/src/modules/einvoice/routes.ts`, `apps/api/src/modules/einvoice/issue.ts` (pha 3 chung), `apps/api/src/modules/invoices/service.ts` (HDB/BH được `adjustsInvoiceId` khi là điều chỉnh tăng — kiểm cùng khách hàng, gốc đã ghi sổ)
- Test: `apps/api/test/einvoice/lifecycle.test.ts`

**Interfaces:**
- Hóa đơn gốc ký hiệu C chỉ được điều chỉnh/thay thế/hủy khi `cqt_status = 'accepted'` (SInvoice yêu cầu `INVOICE_HAS_CODE_APPROVED`, `docs/dev/tich-hop/sinvoice.md`), nếu không 409 `EINVOICE_CQT_PENDING`.
- `issueAdjustment(db, ctx, originalId: number, input: { voucherId: string; adjust: 'increase' | 'decrease' | 'info'; reason: string; agreementNo?: string; agreementDate?: string })`: chứng từ mới cùng khách hàng, đã ghi sổ, chờ số; `decrease` ⇔ GGB/TLB, `increase` ⇔ HDB/BH, `info` ⇔ chứng từ không có tiền? — **`info` (điều chỉnh thông tin) không có chứng từ tiền**: dùng HDB tổng 0 không hợp lệ, nên `info` lập einvoice không có chứng từ (`voucher_id` của gốc? không) → **hoãn**: `info` đi bằng 04/SS hoặc thay thế (QĐ 521). Gốc phải `issued` (không `replaced/cancelled`); thành công đặt gốc `adjusted = true`.
- `issueReplacement(db, ctx, originalId, input: { voucherId: string; reason: string; agreementNo?: string; agreementDate?: string })`: pha 1 kiểm thêm: chứng từ gốc đảo được (kỳ của ngày đảo dự kiến mở hoặc người dùng có `voucher.backdate_locked` cho kỳ khóa mềm); pha 3 thành công: gốc `replaced`, đặt `app.einvoice_reversal = 'on'` cục bộ, `reverseVoucher(gốc, { postingDate: kỳ gốc mở ? ngày gốc : ngày chứng từ mới, description: 'Đảo do hóa đơn bị thay thế bởi …' })`; đảo lỗi → `needs_reversal = true` (vẫn ghi kết quả phát hành).
- `cancelEInvoice(db, ctx, id, input: { reason: string; date: string })`: chỉ khi nhà cung cấp hỗ trợ `cancel` (không → 409 `PROVIDER_UNSUPPORTED`); pha 3 như thay thế (gốc `cancelled`, đảo chứng từ). Ghi chú QĐ: NĐ 254/2026 về hủy hóa đơn đã lập (Task 0 trích); nếu văn bản không cho hủy hóa đơn đã gửi người mua thì UI chỉ hiện "Hủy" khi `cqt_status <> 'accepted'` hoặc ký hiệu K.
- `setPaid(db, ctx, id, paid: boolean)`: gọi `provider.setPaid` nếu có, lưu `paid`.
- Routes: `POST /api/einvoices/:id/adjust`, `/replace`, `/cancel`, `/paid`, `POST /api/einvoices/:id/reverse-original` (thử lại đảo khi `needs_reversal`).

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('điều chỉnh giảm: GGB 1.000.000 + thuế trỏ hóa đơn gốc → einvoice adjustment decrease issued; gốc adjusted; payload.relation.original.invoiceNo = số gốc', async () => {});
it('điều chỉnh tăng bằng HDB adjustsInvoiceId cùng khách → increase; khác khách → 409', async () => {});
it('thay thế: gốc replaced, chứng từ gốc reversed bằng đảo ngày gốc (kỳ mở); tờ khai kỳ gốc không còn doanh thu gốc', async () => {});
it('thay thế khi kỳ gốc khóa mềm và không có quyền ghi lùi: đảo ngày chứng từ thay thế', async () => {});
it('thay thế hóa đơn đã replaced → 409 EINVOICE_NOT_ACTIVE', async () => {});
it('hủy với nhà cung cấp không hỗ trợ → 409 PROVIDER_UNSUPPORTED; fake hỗ trợ: cancelled, chứng từ đảo', async () => {});
it('đảo hỏng ở pha 3 (giả lập lỗi): einvoice vẫn issued, needs_reversal true; reverse-original thành công xóa cờ', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** viết. **Step 4:** PASS, `pnpm -F @kt/api test` xanh.
- [ ] **Step 5:** Commit `feat(api): hóa đơn điều chỉnh, thay thế, hủy và trạng thái thanh toán`.

### Task 7: Adapter Viettel SInvoice theo tài liệu công khai

Model: sonnet; rà soát sonnet đối chiếu `docs/dev/tich-hop/sinvoice.md` từng trường.

**Files:**
- Create: `apps/api/src/modules/einvoice/providers/sinvoice.ts`, `apps/api/test/einvoice/sinvoiceMock.ts` (máy chủ Fastify giả lập theo tài liệu)
- Modify: `providers/index.ts`
- Test: `apps/api/test/einvoice/sinvoice.test.ts`

**Interfaces:**
- `class SInvoiceProvider implements EInvoiceProvider` với `{ baseUrl, username, password, sellerTaxCode, timeoutMs = 60000 }`: đăng nhập lấy `access_token` (cache theo nhà cung cấp, làm mới khi 401 hoặc hết hạn), gửi token đúng cách tài liệu ghi; ánh xạ `EInvoiceDoc` → JSON (`generalInvoiceInfo`, `buyerInfo`, `sellerInfo`, `payments`, `itemInfo`, `taxBreakdowns`, `summarizeInfo`) theo bảng trong tài liệu; `transactionUuid` là khóa chống trùng; điều chỉnh/thay thế theo trường `adjustmentType`, `adjustmentInvoiceType`, `originalInvoiceId`, `originalInvoiceIssueDate`, `additionalReferenceDesc/Date`, `isIncreaseItem`; thuế suất theo bảng ánh xạ của tài liệu (KCT, KKKNT, 0, 5, 8, 10); `result.invoiceNo` của SInvoice gồm cả ký hiệu (ví dụ `K24TUT01`): tách phần số sau sáu ký tự ký hiệu thành `invoiceNo`, giữ chuỗi đầy đủ trong `providerRef`; `issueDate` = thời điểm gọi (mili-giây epoch, múi giờ +07); `findByTransaction` = `searchInvoiceByTransactionUuid`; điều chỉnh tăng (`isIncreaseItem=true`) **không có trong nguồn** — suy ra từ tên trường, ghi rõ trong chú thích và QĐ; `getFile` = `getInvoiceRepresentationFile` (giải nén ZIP bằng `jszip` sẵn có); `cancel` = API hủy của tài liệu (nếu tài liệu không có thì không khai `cancel`); `setPaid` = `updatePaymentStatus`/`cancelPaymentStatus`; `sendErrorNotice` **không khai** (không có trong nguồn công khai, QĐ 522). Mã lỗi nhà cung cấp → `ProviderError(code, description, retriable)` (5xx, timeout: thử lại; lỗi dữ liệu: không).
- Mọi lời gọi qua `httpJson` và `ctx.log` (che `password`, `access_token`).
- Chú thích đầu tệp: nguồn (`docs/dev/tich-hop/sinvoice.md`), "chưa thử trên môi trường thật".

- [ ] **Step 1: Kiểm thử thất bại (máy chủ giả lập):**

```ts
it('create: đăng nhập một lần, gửi JSON đúng các trường bắt buộc của tài liệu (so ảnh chụp JSON), nhận invoiceNo', async () => {});
it('token hết hạn (401) → đăng nhập lại một lần rồi gửi lại', async () => {});
it('timeout → NetworkError; findByTransaction trả kết quả khi máy giả lập đã tạo', async () => {});
it('điều chỉnh giảm: adjustmentType/originalInvoiceId/isIncreaseItem theo tài liệu', async () => {});
it('thuế suất 8%, KCT ánh xạ taxPercentage theo bảng tài liệu; ngoại tệ có currencyCode, exchangeRate', async () => {});
it('getFile pdf giải nén ZIP; einvoice_log che password và token', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** viết. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(api): adapter Viettel SInvoice theo tài liệu công khai (chưa thử môi trường thật)`.

### Task 8: Thông báo hóa đơn điện tử có sai sót 04/SS-HĐĐT

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0082_thong_bao_sai_sot.sql`, `apps/api/src/modules/einvoice/errorNotice.ts`, `apps/api/src/modules/reporting/print/einvoiceForms.ts`
- Modify: `apps/api/src/modules/einvoice/routes.ts`
- Test: `apps/api/test/einvoice/errorNotice.test.ts`

**Interfaces:**
- `einvoice_error_notice(id, notice_kind text CHECK IN ('self','tax_notice'), tax_notice_no text, tax_notice_date date, notice_date date, place text, status CHECK IN ('draft','sent','accepted','rejected'), provider_ref text, created_by, created_at)`; `einvoice_error_notice_line(id, notice_id, line_no, einvoice_id NULL, form_no, serial, invoice_no, issue_date, cqt_code, action text CHECK IN ('cancel','adjust','replace','explain'), reason text)` — các cột của bảng và nhãn tính chất lấy **đúng theo mẫu 04/SS-HĐĐT trong TT 91/2026 Phụ lục III** (đọc mẫu trong `tt91-full.txt` trước khi viết; mã `action` ánh xạ đúng các lựa chọn của mẫu; nếu mẫu có lựa chọn khác bốn giá trị trên thì theo mẫu và ghi QĐ).
- API: `GET/POST/PUT/DELETE /api/einvoice/error-notices` (`einvoice.issue`; chỉ nháp sửa/xóa), `POST /:id/send` (provider `sendErrorNotice`; không hỗ trợ → 409 `PROVIDER_UNSUPPORTED`, người dùng in và gửi qua cổng của nhà cung cấp/CQT, đánh dấu `sent` tay bằng `POST /:id/mark-sent`), `GET /:id/print?format=html|pdf` theo mẫu, dòng "Mẫu số: 04/SS-HĐĐT (Kèm theo Thông tư số 91/2026/TT-BTC …)" đúng văn bản.
- Dòng có `einvoice_id` lấy ký hiệu/số/ngày/mã CQT từ hóa đơn; dòng nhập tay (hóa đơn ngoài phần mềm) bắt buộc đủ ký hiệu, số, ngày.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('lập 04/SS cho hóa đơn issued với tính chất hủy: dòng lấy số, ký hiệu, ngày, mã CQT từ einvoice', async () => {});
it('in HTML có tiêu đề và dòng Mẫu số đúng TT 91/2026; cột theo mẫu', async () => {});
it('send với fake → sent; mark-sent tay khi sinvoice; sửa thông báo đã gửi → 409', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** viết. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(api): thông báo hóa đơn điện tử có sai sót 04/SS-HĐĐT theo TT 91/2026`.

### Task 9: Màn hình hóa đơn điện tử

Model: sonnet.

**Files:**
- Create: `apps/web/src/pages/EInvoices.tsx`, `apps/web/src/pages/EInvoiceConfig.tsx`, `apps/web/src/pages/EInvoiceErrorNotice.tsx`, `apps/web/e2e/hoa-don-dien-tu.spec.ts`
- Modify: `apps/web/src/pages/InvoiceForm.tsx` (chọn "Ký hiệu HĐĐT" thay ô số hóa đơn với HDB/BH/GGB/TLB; sau ghi sổ có nút "Phát hành HĐĐT" (F9 khi đã ghi sổ? giữ F9 cho ghi sổ; dùng Ctrl+Shift+E), trạng thái và số hiện ở đầu form; chứng từ đã phát hành ẩn "Bỏ ghi sổ"), menu và router
- Test: e2e

**Nội dung:**
- `EInvoiceConfig`: hai thẻ "Nhà cung cấp" (biểu mẫu: loại, URL, tên đăng nhập, mật khẩu chỉ ghi, MST người bán, nút "Kiểm tra kết nối") và "Ký hiệu hóa đơn" (lưới: ký hiệu mẫu số, ký hiệu, năm, loại, mã mẫu nhà cung cấp, đang dùng); ô ký hiệu kiểm bằng `parseInvoiceSymbol` của `@kt/domain` khi gõ.
- `EInvoices`: lưới lọc (trạng thái, khoảng ngày, tìm số/khách) nhớ bằng `useRememberedFilter`; cột Ký hiệu, Số, Ngày, Khách hàng, MST, Tiền trước thuế, Thuế, Tổng, Trạng thái (thẻ màu: Đang gửi, Đã phát hành, Chờ mã CQT, Lỗi, Bị thay thế, Đã hủy, Cần đảo chứng từ gốc), Mã CQT; ngăn chi tiết: thông tin, liên kết điều chỉnh/thay thế, nhật ký gửi/nhận; hành động: Xem PDF, Tải XML, Thử lại, Tra mã CQT, Lập điều chỉnh (chọn chứng từ GGB/TLB/HDB/BH đã ghi sổ cùng khách), Lập thay thế, Hủy, Đánh dấu đã thanh toán, Lập 04/SS.
- `EInvoiceErrorNotice`: danh sách + biểu mẫu với `KeyboardGrid` dòng hóa đơn (F4 chọn hóa đơn điện tử), In, Gửi.

- [ ] **Step 1:** e2e thất bại: đăng nhập → cấu hình nhà cung cấp `fake` + ký hiệu `1C26TAA` → lập HDB chọn ký hiệu, Ctrl+S, ghi sổ → "Phát hành HĐĐT" → thấy số `1` và trạng thái "Đã phát hành" → mở danh sách thấy dòng → lập điều chỉnh từ một GGB → thấy hai dòng liên kết.
- [ ] **Step 2:** dựng màn hình theo `evon:ui-ux` (dựng luôn). **Step 3:** `pnpm -F @kt/web typecheck`, `pnpm -F @kt/web test`, e2e spec mới xanh.
- [ ] **Step 4:** Commit `feat(web): màn hình hóa đơn điện tử, cấu hình ký hiệu, thông báo sai sót`.

### Task 10: Ký số: XML-DSig, phiên ký, tiện ích ký cục bộ, ký từ xa

Model: sonnet; rà soát opus (mật mã).

**Files:**
- Create: `apps/api/src/modules/signing/xmldsig.ts`, `sessions.ts`, `providers/types.ts`, `providers/localAgent.ts`, `providers/smartca.ts`, `providers/fake.ts`, `routes.ts`, `packages/db/migrations/0083_ky_so.sql`, `tools/signer-agent/index.mjs`, `tools/signer-agent/README.md`, `docs/dev/ky-so-cuc-bo.md`, `apps/web/src/pages/SigningSetup.tsx`, `apps/web/src/signing/signXml.ts`, `apps/web/e2e/ky-so.spec.ts`
- Modify: `apps/api/package.json` (`@xmldom/xmldom`, `xml-crypto`), `apps/api/src/modules/tax/routes.ts` (tải XML tờ khai đã ký), `apps/web/src/pages/VatReturn.tsx` (nút "Ký và tải XML")
- Test: `apps/api/test/signing/*.test.ts`

**Interfaces:**
- `signing_profile(id, user_id, kind CHECK IN ('local_agent','smartca','fake'), label, cert_der bytea, cert_subject, cert_serial, cert_not_after timestamptz, credentials bytea NULL (smartca: client_id/secret/user, mã hóa), is_default)`; `UNIQUE(tenant_id, user_id, cert_serial)`; người dùng chỉ thấy hồ sơ của mình.
- `signing_session(id uuid, user_id, profile_id, doc_kind text, doc_ref text, xml_unsigned text, signed_info_c14n text, digest_b64 text, status CHECK IN ('pending','signed','failed','expired'), signed_xml text NULL, expires_at, created_at)`.
- `xmldsig.ts`: `prepareEnveloped(xml: string, cert: Buffer, opts: { refUri?: string; signingTime: string }): { signedInfoC14n: string; digestB64: string /* SHA-256 của SignedInfo C14N, base64 */; finish(signatureB64: string): string }` dùng `xml-crypto` (C14N `http://www.w3.org/TR/2001/REC-xml-c14n-20010315`, RSA-SHA256, digest SHA-256, `X509Data/X509SubjectName` + `X509Certificate`, `Object/SignatureProperties/SignatureProperty/SigningTime` theo mô tả QĐ 1450 trong `research_notes`); `verifyEnveloped(xml: string): { valid: boolean; certDer: Buffer | null; subject: string | null; signingTime: string | null; reason?: string }` (dùng chung cho Task 11).
- Phiên ký: `POST /api/signing/sessions { docKind: 'vat_return' | 'cit_return' | 'error_notice', docRef, profileId? }` → `{ id, digestB64, kind, agentUrl? }`; `POST /api/signing/sessions/:id/complete { signatureB64 }` (local agent: trình duyệt gửi lên; server ghép, **kiểm chữ ký bằng chứng thư của hồ sơ**, sai → 400 `SIGNATURE_INVALID`); `smartca`: server tự gọi `providers/smartca.ts` (gửi hash, người dùng xác nhận trên ứng dụng, `POST /:id/poll`) theo tài liệu SmartCA v4.1 (`docs/dev/tich-hop/ngan-hang.md` mục 7: `sp_id`/`sp_password`, `v1/credentials/get_certificate`, `v1/signatures/sign` với `sign_type=hash`, polling `v1/signatures/sign/{tranId}/status`; UAT `rmgateway.vnptit.vn/sca/sp769`), kiểm bằng máy giả lập, "chưa thử môi trường thật"; `GET /api/signing/sessions/:id/result` trả XML đã ký. Hết hạn 10 phút.
- Giao thức tiện ích ký cục bộ (`docs/dev/ky-so-cuc-bo.md`): `http://127.0.0.1:18765`, `GET /v1/certificates` → `[{ serial, subject, notAfter, certB64 }]`, `POST /v1/sign { certSerial, digestB64, algorithm: 'RSA-SHA256' }` → `{ signatureB64 }`; CORS chỉ cho `WEB_ORIGIN` cấu hình trong tiện ích; tiện ích hiện hộp xác nhận (bản tham chiếu: dòng lệnh hỏi y/n, tùy chọn `--yes` cho kiểm thử). `tools/signer-agent/index.mjs` ký bằng tệp `.pfx` (`node:crypto`, không phụ thuộc) — tham chiếu và kiểm thử; USB token thật cần thư viện PKCS#11 của hãng, ghi "chưa thử với token thật".
- Web: `SigningSetup` (thêm chứng thư từ tiện ích cục bộ hoặc SmartCA), `signXml.ts` (gọi phiên → tiện ích → complete); tờ khai 01/GTGT có "Ký và tải XML".

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('prepareEnveloped + ký bằng khóa thử (pfx sinh trong kiểm thử bằng openssl hoặc node:crypto) + finish → verifyEnveloped valid, SigningTime đúng', () => {});
it('sửa một ký tự nội dung sau ký → verifyEnveloped invalid', () => {});
it('phiên ký local_agent: complete chữ ký sai khóa → 400 SIGNATURE_INVALID; đúng → signed, tải XML tờ khai đã ký', async () => {});
it('phiên của người khác → 404; hết hạn → 409 SIGNING_SESSION_EXPIRED', async () => {});
it('tiện ích tham chiếu: GET /v1/certificates trả chứng thư của pfx; POST /v1/sign ký đúng digest', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** viết. **Step 4:** PASS, e2e `ky-so.spec.ts` (hồ sơ `fake`) xanh.
- [ ] **Step 5:** Commit `feat(api): ký số XML-DSig, phiên ký, tiện ích ký cục bộ tham chiếu, ký tờ khai`.

### Task 11: Hóa đơn đầu vào: đọc XML, kiểm chữ ký, lưu, chống trùng, tra MST

Model: sonnet; rà soát opus (XXE, chuẩn số).

**Files:**
- Create: `packages/db/migrations/0084_hoa_don_dau_vao.sql`, `apps/api/src/modules/inbound/parse1450.ts`, `verify.ts`, `store.ts`, `taxCodeLookup.ts`, `routes.ts`, `apps/api/test/fixtures/xml/*`
- Test: `apps/api/test/inbound/parse.test.ts`, `apps/api/test/inbound/store.test.ts`

**Interfaces:**
- `parse1450(xml: string): ParsedInvoice` — chặn trước khi đọc: chứa `<!DOCTYPE` hoặc `<!ENTITY` → `AppError('XML_UNSAFE', …, 400)`; kích thước > 2 MB → 400 (giới hạn thông điệp QĐ 1450 theo `research_notes`); tìm phần tử `HDon` ở bất kỳ độ sâu (gốc `HDon` hoặc trong `TDiep/DLieu`), bỏ qua tiền tố namespace; trường theo `docs/dev/tich-hop/xml-hoa-don.md` (`TTChung/KHMSHDon`, `KHHDon`, `SHDon`, `NLap`, `DVTTe`, `TGia`, `HTTToan`; `NDHDon/NBan/{Ten,MST,DChi}`, `NMua/{Ten,MST,DChi,HVTNMHang}`; `DSHHDVu/HHDVu/{TChat,STT,MHHDVu,THHDVu,DVTinh,SLuong,DGia,TLCKhau,STCKhau,ThTien,TSuat}`; `TToan/{THTTLTSuat/LTSuat/{TSuat,ThTien,TThue},TgTCThue,TgTThue,TTCKTMai,TgTTTBSo,TgTTTBChu}`; `MCCQT`; `TTKhac/TTin` giữ thô) — đường dẫn thật chốt ở Task 0. Số đọc chuỗi: chấp nhận `1000000.50`; dạng khác → cảnh báo `NUMBER_FORMAT` và giữ chuỗi gốc. `TSuat`: `'10%'|'8%'|'5%'|'0%'|'KCT'|'KKKNT'|'KHAC:…'` chuẩn hóa thành `'10'|'8'|'5'|'0'|'KCT'|'KKKNT'|'KHAC'`.
```ts
export interface ParsedInvoice { formNo: string; serial: string; invoiceNo: string; issueDate: string; currency: string; fxRate: string | null; paymentMethod: string | null; cqtCode: string | null;
  seller: { name: string; taxCode: string | null; address: string | null }; buyer: { name: string | null; taxCode: string | null; address: string | null };
  lines: { lineNo: number; kind: 'goods' | 'promotion' | 'discount' | 'note'; code: string | null; name: string; uom: string | null; quantity: string | null; unitPrice: string | null; discountAmount: string | null; amount: string; taxRate: string | null }[];
  taxGroups: { taxRate: string; base: string; tax: string }[]; totals: { beforeTax: string; tax: string; discount: string | null; total: string }; warnings: { code: string; message: string }[] }
```
- `verify.ts`: `verifyInvoiceSignatures(xml): { seller: SigCheck | null; cqt: SigCheck | null }` dùng `verifyEnveloped` (Task 10) cho chữ ký người bán (`DSCKS/NBan`) và CQT (`DSCKS/CQT`); `SigCheck = { valid: boolean; subject: string | null; taxCodeInCert: string | null; signingTime: string | null; reason?: string }`; MST trong chứng thư khác MST người bán → cảnh báo `SIGNER_TAXCODE_MISMATCH`. Không kiểm chuỗi tin cậy CA (không có danh sách CA gốc trong phạm vi; QĐ).
- `inbound_invoice(id bigint, source CHECK IN ('upload','api','email'), received_at, received_by uuid NULL, api_key_id uuid NULL, xml text, xml_sha256 text, form_no, serial, invoice_no, issue_date, seller_tax_code, seller_name, seller_address, buyer_tax_code, currency, fx_rate numeric(20,10), total_before_tax numeric(20,4), total_tax numeric(20,4), total numeric(20,4), cqt_code, seller_sig jsonb, cqt_sig jsonb, buyer_matches boolean, tax_code_check jsonb, warnings jsonb, status CHECK IN ('new','voucher_created','ignored','duplicate'), duplicate_of bigint NULL, voucher_id uuid NULL, party_id uuid NULL)`; `UNIQUE (tenant_id, xml_sha256)`; chỉ mục `(tenant_id, fn_invoice_key(seller_tax_code), fn_invoice_key(serial), fn_invoice_key(invoice_no))`; `inbound_invoice_line(…các cột của ParsedInvoice.lines…)`.
- `storeInbound(trx, ctx, xml: string, source, meta): Promise<{ id: number; status: 'new' | 'duplicate'; existing?: number }>`: trùng SHA → trả bản cũ (không chèn); trùng (MST, ký hiệu, số) với hóa đơn đầu vào khác → `duplicate` + `duplicate_of`; trùng với `voucher_invoice` mua đã có → cảnh báo `VOUCHER_EXISTS` kèm chứng từ; `buyer_matches` = MST người mua == MST công ty.
- `taxCodeLookup.ts`: `interface TaxCodeLookup { lookup(taxCode: string): Promise<{ found: boolean; name: string | null; address: string | null; status: string | null; source: string; checkedAt: string }> }`; `VietQrBusinessLookup` (`https://api.vietqr.io/v2/business/{mst}`, cấu trúc theo `docs/dev/tich-hop/ngan-hang.md`; trường tình trạng nếu không có thì `status = null`), `FakeLookup`; chọn theo cài đặt `tax_code_lookup` (`'off' | 'vietqr'`, mặc định `'off'` — gửi MST ra dịch vụ bên thứ ba là quyết định của người dùng, QĐ). Kết quả lưu `tax_code_check`; tên khác tên trên hóa đơn → cảnh báo.
- Routes: `POST /api/inbound-invoices` (multipart nhiều tệp `.xml` hoặc `.zip` chứa XML; mỗi tệp một kết quả), `GET /api/inbound-invoices?status=&from=&to=&q=`, `GET /:id` (dòng, chữ ký, cảnh báo), `GET /:id/xml`, `POST /:id/ignore`, `POST /:id/check-tax-code`.

- [ ] **Step 1: Kiểm thử thất bại (mẫu ở `test/fixtures/xml/`):**

```ts
it.each(fixtures)('parse1450 %s: ký hiệu, số, ngày, MST người bán, tổng = Σ dòng + thuế đúng giá trị ghi trong NGUON.md', () => {});
it('XML có DOCTYPE/ENTITY → 400 XML_UNSAFE; tệp 2,1 MB → 400', () => {});
it('TSuat KCT, KKKNT, 8% chuẩn hóa; số "1000000.50" giữ nguyên chuỗi', () => {});
it('tải cùng tệp hai lần: một bản ghi; tệp khác cùng (MST, ký hiệu, số) → duplicate', async () => {});
it('chữ ký người bán hợp lệ của mẫu có chữ ký → valid; sửa ThTien → invalid', async () => {});
it('zip chứa 3 XML → 3 kết quả; người thiếu inbound_invoice.create → 403', async () => {});
it('tra MST tắt mặc định; bật vietqr với FakeLookup lưu tax_code_check', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** viết. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(api): hóa đơn đầu vào XML: đọc, kiểm chữ ký, chống trùng, tra MST`.

### Task 12: Lập chứng từ mua từ hóa đơn đầu vào; màn hình hóa đơn đầu vào

Model: sonnet.

**Files:**
- Create: `apps/api/src/modules/inbound/toVoucher.ts`, `packages/db/migrations/0085_anh_xa_hang_dau_vao.sql`, `apps/web/src/pages/InboundInvoices.tsx`, `apps/web/e2e/hoa-don-dau-vao.spec.ts`
- Modify: `apps/api/src/modules/inbound/routes.ts`
- Test: `apps/api/test/inbound/toVoucher.test.ts`

**Interfaces:**
- `inbound_item_map(id, seller_tax_code, name_key text (fn_invoice_key của tên hàng), item_id NULL, account_code text NULL, tax_code text NULL, updated_at)`; `UNIQUE (tenant_id, seller_tax_code, name_key)`.
- `GET /api/inbound-invoices/:id/proposal` → `{ partyCode | null (tìm theo MST), voucherType: 'HDM' | 'MH', lines: [{ lineNo, itemCode | null, accountCode | null, taxCode | null, source: 'map' | 'guess' | null }] }`: ánh xạ đã nhớ; thuế suất → mã thuế GTGT mua vào có cùng `rate` (KCT/KKKNT theo `report_tag`), nhiều mã cùng suất thì mã nhỏ nhất.
- `POST /api/inbound-invoices/:id/voucher { voucherType, postingDate, partyCode?, createParty?: boolean, counterAccountCode?, invoiceGroupCode, lines: [{ lineNo, itemCode?, accountCode?, warehouseCode?, taxCode? }], stockMode? }` → gọi `createInvoice` (chứng từ nháp) với `invoice.formNo/serial/invoiceNo/invoiceDate` của hóa đơn, `declaredTax` = thuế theo mã từ `taxGroups` (khớp số trên hóa đơn); `createParty` tạo đối tượng từ người bán (cần `catalog.create`); dòng `kind = 'note'` bỏ qua; `discount` (TChat 3) trở thành chiết khấu dòng trước nếu có `STT` liên quan, không thì dòng giảm giá âm → 409 `INBOUND_DISCOUNT_UNSUPPORTED` (người dùng tự lập; QĐ). Lưu ánh xạ; `status = 'voucher_created'`, `voucher_id`. Hóa đơn ngoại tệ: `currencyCode`, `fxRate` theo hóa đơn.
- Màn hình: lưới hóa đơn (lọc trạng thái, ngày, người bán; cột Người bán, MST, Ký hiệu, Số, Ngày, Tổng, Chữ ký (biểu tượng), Mã CQT, Trạng thái), kéo-thả tải nhiều tệp, ngăn chi tiết (dòng hàng, cảnh báo, chữ ký), hộp "Lập chứng từ" với `KeyboardGrid` ánh xạ dòng → VTHH/TK/kho/mã thuế (F4), Ctrl+S tạo chứng từ rồi mở `InvoiceForm`.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('proposal: người bán đã có theo MST; thuế 10% → mã GTGT mua vào 10%', async () => {});
it('lập HDM từ hóa đơn dịch vụ: chứng từ nháp, voucher_invoice số/ký hiệu/ngày đúng hóa đơn, thuế = TgTThue', async () => {});
it('lập lần hai cùng hóa đơn → 409 INBOUND_ALREADY_CONVERTED; ánh xạ dòng được nhớ cho hóa đơn sau cùng người bán', async () => {});
it('người bán chưa có, createParty true → tạo đối tượng tên, MST, địa chỉ từ hóa đơn', async () => {});
```
- e2e: tải `test/fixtures/xml/<mẫu dịch vụ>.xml` → thấy dòng → Lập chứng từ → chọn TK 6422, Ctrl+S → mở hóa đơn mua nháp đúng tổng tiền.

- [ ] **Step 2:** FAIL. **Step 3:** viết. **Step 4:** PASS, e2e xanh.
- [ ] **Step 5:** Commit `feat(api): lập chứng từ mua từ hóa đơn đầu vào, nhớ ánh xạ hàng; màn hình hóa đơn đầu vào`.

### Task 13: Kết nối ngân hàng: webhook SePay/Casso, hộp thư giao dịch, nhập sao kê

Model: sonnet; rà soát opus (xác thực công khai, RLS).

**Files:**
- Create: `packages/db/migrations/0086_giao_dich_ngan_hang.sql`, `apps/api/src/modules/bank/feeds.ts`, `webhook.ts`, `statementImport.ts`, `routes.ts`
- Modify: `apps/api/src/app.ts` (route webhook ngoài `requireAuth`, `bodyLimit` 256 KB, giữ thân thô để kiểm HMAC)
- Test: `apps/api/test/bank/webhook.test.ts`, `apps/api/test/bank/statementImport.test.ts`

**Interfaces:**
- `bank_feed(id, bank_account_id, provider CHECK IN ('sepay','casso'), token_hash text UNIQUE (toàn cục, không tenant — mã ngẫu nhiên 32 byte), auth_kind CHECK IN ('hmac','apikey'), secret bytea (HMAC: mã hóa; apikey: NULL), apikey_hash text NULL, is_active, last_received_at)`; `UNIQUE(tenant_id, id)`.
- `fn_bank_feed_by_token(p_hash text) RETURNS TABLE(tenant_id uuid, feed_id bigint)` SECURITY DEFINER (chỉ feed `is_active`).
- `bank_transaction(id bigint, bank_account_id, feed_id NULL, source CHECK IN ('sepay','casso','import','manual'), external_id text NOT NULL, txn_time timestamptz, value_date date NOT NULL, amount_in numeric(20,4) DEFAULT 0, amount_out numeric(20,4) DEFAULT 0 CHECK ((amount_in > 0) <> (amount_out > 0)), balance_after numeric(20,4) NULL, description text, reference text, counter_account text, counter_name text, payment_code text, raw jsonb, status CHECK IN ('new','matched','ignored') DEFAULT 'new', voucher_id uuid NULL, matched_by, matched_at)`; `UNIQUE (tenant_id, source, external_id)`; chỉ mục duy nhất `(tenant_id, voucher_id) WHERE voucher_id IS NOT NULL`; `bank_webhook_log(id, feed_id, received_at, ok, http_status, error, body_sha256)` (không lưu thân thô khi xác thực sai).
- Webhook: `POST /api/hooks/bank/:token` — băm token → `fn_bank_feed_by_token` → không có: 401; `withTenant`; xác thực theo `docs/dev/tich-hop/ngan-hang.md` (SePay: `X-SePay-Signature: sha256=<hex>` = HMAC-SHA256(secret, `<X-SePay-Timestamp>.<thân thô>`), lệch thời gian quá 300 giây → 401, hoặc `Authorization: Apikey <key>`; Casso V2: `X-Casso-Signature: t=<ms>,v1=<hex>` = HMAC-SHA512(secret, `t + '.' + JSON khóa sắp xếp đệ quy`), tự thêm kiểm lệch 300 giây, hoặc header `secure-token` kiểu cũ — chi tiết và nguồn `docs/dev/tich-hop/ngan-hang.md`), so sánh `timingSafeEqual`; ánh xạ payload → `bank_transaction` (`external_id` = `id` của nhà cung cấp; số tiền chuỗi; SePay `transferType in|out`; ngày giờ theo múi giờ +07); `INSERT … ON CONFLICT DO NOTHING`; trả đúng thân phản hồi tài liệu yêu cầu (SePay `{"success": true}` mã 200/201). Số TK trong payload khác TK ngân hàng của feed → bỏ qua giao dịch, ghi log `ACCOUNT_MISMATCH`, vẫn trả thành công (tránh gửi lại vô hạn).
- `feeds.ts` API (`bank_feed.update`… dùng quyền `bank_feed.create|update|delete`): `GET/POST/PUT/DELETE /api/bank-feeds` — POST trả **một lần** `{ webhookUrl: PUBLIC_BASE_URL + '/api/hooks/bank/' + token, apiKey? }`; `POST /:id/rotate` đổi token.
- Sao kê: `bank_statement_format(id, name, bank_code, header_row int, date_col, date_format text CHECK IN ('dd/MM/yyyy','yyyy-MM-dd','dd-MM-yyyy','excel'), description_col, amount_in_col, amount_out_col, signed_amount_col, reference_col, balance_col, sheet_index int DEFAULT 0)` (cột theo chữ cái Excel; hoặc một cột số tiền có dấu); `POST /api/bank-transactions/import { bankAccountId, formatId, file }` (xlsx/csv qua ExcelJS) → `{ inserted, skipped, errors: [{ row, message }] }`; `external_id = 'imp:' + sha256(TK|ngày|số tiền|tham chiếu|diễn giải|thứ tự lặp trong tệp)`; nhập lại cùng tệp → `skipped`. Không có mẫu sẵn của ngân hàng nào (không có nguồn chính thức; QĐ) — người dùng tự khai cột.
- `GET /api/bank-transactions?bankAccountId=&status=&from=&to=&q=` (`bank_feed.view`), `POST /:id/ignore`, `POST /:id/unignore`, `POST /api/bank-transactions` (nhập tay, `source = 'manual'`).

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('SePay HMAC đúng: 1 giao dịch new amount_in "5000000"; gửi lại 7 lần (3 đồng thời) → vẫn 1; phản hồi {"success":true}', async () => {});
it('chữ ký sai / token sai / feed tắt → 401, không ghi bank_transaction; log ok=false', async () => {});
it('Casso apikey header đúng: giao dịch out ghi amount_out', async () => {});
it('token của công ty A không ghi được vào công ty B (RLS): giao dịch thuộc tenant của feed', async () => {});
it('số TK khác TK của feed → bỏ qua, log ACCOUNT_MISMATCH, trả 200', async () => {});
it('nhập sao kê xlsx 5 dòng theo mẫu cột; nhập lại → inserted 0 skipped 5; dòng ngày sai → errors', async () => {});
it('GET /api/bank-feeds không trả token, secret', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** viết. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(api): webhook SePay/Casso, hộp thư giao dịch ngân hàng, nhập sao kê theo mẫu cột`.

### Task 14: Đối chiếu giao dịch ngân hàng: gợi ý, lập BC/BN, gắn chứng từ, đối chiếu sổ phụ

Model: sonnet; rà soát opus.

**Files:**
- Create: `apps/api/src/modules/bank/match.ts`, `apps/api/src/modules/bank/reconReport.ts`
- Modify: `apps/api/src/modules/bank/routes.ts`
- Test: `apps/api/test/bank/match.test.ts`

**Interfaces:**
- `suggestMatches(trx, auth, txnId): Promise<Suggestion[]>`; `Suggestion = { kind: 'voucher'; voucherId; voucherNo; date; amount; score; reasons: string[] } | { kind: 'open_item'; openItemId; partyCode; partyName; invoiceNo; dueDate; residual; score; reasons: string[] }`. Quy tắc điểm (cộng, cắt 100): chứng từ BC (giao dịch vào)/BN (ra) đã ghi sổ cùng TK ngân hàng, cùng số tiền, chưa gắn giao dịch, ngày ±3 → 60 + 10 nếu cùng ngày; khoản công nợ (131 cho vào, 331 cho ra) còn dư: số dư bằng số tiền → 40; số hóa đơn, số chứng từ, mã đối tượng hoặc `payment_code` xuất hiện trong diễn giải (so `fn_invoice_key`) → 40; MST/tên đối tượng trong diễn giải → 20. Trả tối đa 10, điểm giảm dần. Gợi ý `open_item` 131 cần `view_receivable`, 331 cần `view_payable` (thiếu cờ: bỏ, kèm `hiddenBySensitivity: true` trong phản hồi).
- `matchToVoucher(trx, ctx, txnId, voucherId)`: kiểm cùng TK ngân hàng, cùng chiều, cùng số tiền, chứng từ `posted`, chưa gắn → `matched`.
- `createVoucherFromTxn(trx, ctx, txnId, input: { postingDate?: string; partyCode?: string; purposeCode?: string; counterAccountCode?: string; description?: string; settle?: { openItemId: number; amount: string }[]; post: boolean })`: lập BC (vào)/BN (ra) qua dịch vụ chứng từ tiền hiện có (`purpose` của `voucherTypes.ts`: `thu_khach_hang`/`chi_tra_ncc` mặc định khi có `settle`), số tiền = số giao dịch, TK ngân hàng của giao dịch, diễn giải mặc định = diễn giải giao dịch; `settle` → đối trừ qua `arap/settlement.ts` sau ghi sổ; `post=false` để nháp (chứng từ nháp vẫn gắn, trạng thái giao dịch `matched` chỉ khi chứng từ ghi sổ — trước đó `new` kèm `voucher_id`). Chứng từ bị xóa/hủy → `voucher_id` SET NULL (khóa ngoại), giao dịch về `new` (trigger).
- `POST /api/bank-transactions/:id/suggestions`, `/match { voucherId }`, `/create-voucher`, `/unmatch` (`bank_feed.match`).
- `bankReconciliation(trx, { bankAccountId, from, to })` (READ_SNAPSHOT): số dư đầu/cuối sổ cái TK ngân hàng, số dư theo sao kê (`balance_after` cuối kỳ nếu có), danh sách giao dịch chưa đối chiếu, danh sách dòng sổ cái TK ngân hàng không gắn giao dịch nào; `GET /api/bank-reconciliation?…` + xuất Excel.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('giao dịch vào 11.000.000 "TT HD 0000123 CTY A": gợi ý khoản phải thu hóa đơn 123 điểm cao nhất', async () => {});
it('BC đã ghi sổ cùng TK, cùng tiền, cách 1 ngày → gợi ý voucher; match → matched; match chứng từ khác tiền → 409', async () => {});
it('create-voucher post=true settle hóa đơn 123: BC ghi sổ, open_item còn 0, giao dịch matched', async () => {});
it('người thiếu view_receivable: không có gợi ý open_item, hiddenBySensitivity true', async () => {});
it('bỏ ghi sổ rồi xóa BC đã gắn → giao dịch về new', async () => {});
it('đối chiếu sổ phụ: liệt kê giao dịch chưa đối chiếu và dòng 1121 không có giao dịch', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** viết. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(api): gợi ý và đối chiếu giao dịch ngân hàng với công nợ, chứng từ; đối chiếu sổ phụ`.

### Task 15: VietQR; màn hình giao dịch ngân hàng và kết nối

Model: sonnet.

**Files:**
- Create: `packages/domain/src/vietqr.ts`, `packages/coa-data/data/banks/napas-bins.json` (+ `status.json` nguồn, ngày tải), `packages/ui/src/VietQr.tsx`, `apps/web/src/pages/BankTransactions.tsx`, `apps/web/src/pages/BankFeeds.tsx`, `apps/web/e2e/ngan-hang.spec.ts`
- Modify: migration bổ sung cột `bank.napas_bin text NULL` (thêm vào 0086 nếu chưa đẩy, không thì migration mới), danh mục ngân hàng trên web (ô BIN, F4 chọn từ danh sách NAPAS), `apps/web/src/pages/InvoiceForm.tsx` (nút "Mã QR thanh toán" cho HDB/BH đã ghi sổ: TK ngân hàng mặc định công ty, số tiền còn phải thu của hóa đơn, nội dung = số hóa đơn hoặc số chứng từ), in biên bản đối chiếu công nợ (QR tổng còn nợ), `apps/web/package.json` (`qrcode`)
- Test: `packages/domain/test/vietqr.test.ts`

**Interfaces:**
- `vietQrPayload(i: { bin: string /* 6 số */; accountNo: string; amount?: string /* VND nguyên */; content?: string /* ≤ 25 ký tự sau bỏ dấu */; service?: 'QRIBFTTA' | 'QRIBFTTC' }): string` theo cấu trúc EMVCo/NAPAS trong `docs/dev/tich-hop/ngan-hang.md` (tag 00 `01`, 01 `11` tĩnh / `12` có số tiền, 38 GUID `A000000727` + 01(00 BIN, 01 số TK) + 02 dịch vụ, 53 `704`, 54 số tiền, 58 `VN`, 62/08 nội dung, 63 CRC-16/CCITT-FALSE in hoa 4 ký tự hex); nội dung bỏ dấu tiếng Việt, chỉ `[A-Za-z0-9 ]`; `crc16ccitt(s: string): string`.
- `VietQr` (React): nhận `payload`, vẽ bằng `qrcode` (canvas/SVG), hiển thị ngân hàng, số TK, số tiền, nội dung dưới mã.
- `BankFeeds`: danh sách kết nối, thêm (chọn TK ngân hàng, SePay/Casso, kiểu xác thực, khóa) → hộp hiện URL webhook và khóa một lần (nút sao chép), xoay token; mẫu cột sao kê.
- `BankTransactions`: chọn TK ngân hàng, lọc trạng thái/ngày; lưới (Ngày, Diễn giải, Tham chiếu, Tiền vào, Tiền ra, Số dư, Trạng thái, Chứng từ); ngăn phải gợi ý đối chiếu với nút "Gắn" / "Lập Giấy báo Có/Nợ" (biểu mẫu nhỏ: đối tượng F4, mục đích, chọn khoản công nợ đối trừ, Ctrl+S ghi sổ); "Nhập sao kê"; "Bỏ qua"; thẻ "Đối chiếu sổ phụ".

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it.each(vectors /* ≥ 2 chuỗi mẫu từ thư viện mở, đã kiểm CRC ở Task 0 */)('vietQrPayload khớp mẫu %#', () => {});
it('crc16ccitt("123456789") = "29B1"', () => {});
it('nội dung có dấu "Thanh toán HĐ 12" → "Thanh toan HD 12"; quá 25 ký tự cắt', () => {});
```
- e2e: tạo kết nối SePay HMAC → gọi webhook bằng `request` của Playwright với chữ ký đúng → giao dịch hiện trong hộp thư → "Lập Giấy báo Có" đối trừ hóa đơn mẫu → trạng thái "Đã đối chiếu"; mở hóa đơn bán đã ghi sổ → "Mã QR thanh toán" hiện mã.

- [ ] **Step 2:** FAIL. **Step 3:** viết (BIN lấy từ JSON đã tải ở Task 0, ghi nguồn và ngày trong `status.json`). **Step 4:** PASS, e2e xanh.
- [ ] **Step 5:** Commit `feat(web): VietQR trên hóa đơn và biên bản đối chiếu; màn hình giao dịch ngân hàng, kết nối webhook`.

### Task 16: Khóa API và API cho phần mềm bán hàng

Model: sonnet; rà soát opus (bảo mật).

**Files:**
- Create: `packages/db/migrations/0087_khoa_api.sql`, `apps/api/src/modules/ext/apiKeys.ts`, `apps/api/src/modules/ext/auth.ts`, `apps/api/src/modules/ext/routes.ts`, `apps/web/src/pages/ApiKeys.tsx`, `apps/web/e2e/khoa-api.spec.ts`, `docs/dev/api-ngoai.md`
- Modify: `apps/api/src/plugins/auth.ts` (bỏ qua `Authorization: Bearer kt_…` ngoài `/api/ext/`), `apps/api/src/app.ts`
- Test: `apps/api/test/ext/*.test.ts`

**Interfaces:**
- `api_key(id uuid, user_id uuid NOT NULL, name, prefix text NOT NULL, key_hash text NOT NULL, scopes text[] NOT NULL CHECK (scopes <@ ARRAY['items.read','stock.read','sales.write','inbound_invoice.write']), default_warehouse_id NULL, post_sales boolean DEFAULT false, expires_at timestamptz NULL, revoked_at, last_used_at, created_at)`; `UNIQUE (prefix)` toàn cục; `fn_api_key_lookup(p_prefix text) RETURNS TABLE(id uuid, tenant_id uuid, user_id uuid, key_hash text, scopes text[], revoked_at timestamptz, expires_at timestamptz)` SECURITY DEFINER.
- Phạm vi → quyền: `items.read → item.view`, `stock.read → stock_voucher.view`, `sales.write → voucher.create (+ voucher.post khi post_sales)`, `inbound_invoice.write → inbound_invoice.create`. `ext/auth.ts` hook `onRequest` cho prefix `/api/ext/v1`: tách `kt_<prefix>_<secret>`, tra, so băm `timingSafeEqual`, kiểm thu hồi/hết hạn, người dùng còn hoạt động trong công ty; dựng `req.auth` như phiên với quyền = vai trò hiện hành ∩ phạm vi; cập nhật `last_used_at` tối đa mỗi phút; giới hạn 60 yêu cầu/phút/khóa (bộ đếm trong bộ nhớ; 429 `RATE_LIMITED`). Route thường gặp `Authorization: Bearer kt_` mà không có cookie → 401 (khóa không thay phiên).
- API quản lý (`api_key.manage`): `GET/POST /api/api-keys` (POST trả khóa đầy đủ một lần; `userId` mặc định người tạo, người quản lý chỉ tạo cho chính mình), `POST /api/api-keys/:id/revoke`.
- `/api/ext/v1`: `GET /items?q=&updatedSince=` (mã, tên, ĐVT, thuế suất mặc định, giá bán theo bảng giá mặc định), `GET /stock?warehouseCode=&itemCode=&date=` (số lượng tồn theo `stock_move`; `value` chỉ khi `view_cost`), `POST /sales { externalId, date, customer: { code? | taxCode?, name?, address? }, warehouseCode?, lines: [{ itemCode, quantity, unitPrice, uomCode?, taxCode?, discount? }], payment?: { method: 'cash' | 'bank'; bankAccountCode?: string; amount: string }, einvoiceSeriesId?: number }` → BH (VTHH) hoặc HDB (chỉ dịch vụ) qua `createInvoice` với `idempotencyKey = 'ext:' + externalId`, ghi sổ khi `post_sales`; khách lẻ không mã → đối tượng "Khách lẻ" mặc định (tạo nếu chưa có, mã `KHACHLE`); `payment` → PT/BC đối trừ hóa đơn; trả `{ voucherId, voucherNo, state, einvoice? }`; gửi lại cùng `externalId` → 200 cùng kết quả. `GET /sales/:externalId`. `POST /inbound-invoices` (thân XML, `Content-Type: application/xml`) → `storeInbound(source='api')`.
- Màn hình `ApiKeys`: danh sách (tên, tiền tố, phạm vi, người dùng, dùng lần cuối, hết hạn, trạng thái), tạo (chọn phạm vi, kho mặc định, tự ghi sổ) → hộp hiện khóa một lần, thu hồi.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('khóa sales.write tạo BH 2 dòng đã ghi sổ (post_sales) và PT đối trừ; cùng externalId lần hai → cùng voucherId', async () => {});
it('khóa thu hồi → 401; người tạo bị tắt trong công ty → 401; vai trò người tạo mất voucher.create → 403', async () => {});
it('Bearer kt_ gọi /api/vouchers → 401', async () => {});
it('stock.read: không view_cost thì không có value', async () => {});
it('khóa sai một ký tự → 401 (so sánh hằng thời gian); 61 yêu cầu/phút → 429', async () => {});
it('POST /api/ext/v1/inbound-invoices XML hợp lệ → inbound_invoice source api', async () => {});
```
- e2e: tạo khóa → thấy khóa một lần → thu hồi → trạng thái "Đã thu hồi".

- [ ] **Step 2:** FAIL. **Step 3:** viết (+ `docs/dev/api-ngoai.md` mô tả endpoint, ví dụ curl). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(api): khóa API và API cho phần mềm bán hàng (sản phẩm, tồn kho, bán hàng, hóa đơn đầu vào)`.

### Task 17: Thuế TNDN: tham số, tạm tính quý, tờ khai quyết toán 03/TNDN và phụ lục 03-1A

Model: opus (dữ liệu pháp lý, công thức).

**Files:**
- Create: `packages/coa-data/data/tax/03tndn-tt89.json`, `03-1a-tndn-tt89.json`, `htkk-03tndn.json`, `packages/domain/src/cit.ts`, `apps/api/src/modules/tax/citEstimate.ts`, `apps/api/src/modules/tax/citReturn.ts`, `apps/api/src/modules/tax/xml/htkk03tndn.ts`, `apps/web/src/pages/CitEstimate.tsx`, `apps/web/src/pages/CitReturn.tsx`, `apps/web/e2e/thue-tndn.spec.ts`
- Modify: `packages/coa-data/data/tax/legal-params.json` (thuế suất TNDN nếu Task 0 có văn bản gốc), `packages/coa-data/data/tax/status.json` (cổng `03TNDN_TT89`, `CIT_RATES`), `apps/api/src/modules/tax/routes.ts`
- Test: `packages/domain/test/cit.test.ts`, `apps/api/test/tax/citEstimate.test.ts`, `apps/api/test/tax/citReturn.test.ts`, `packages/coa-data/test/*.test.ts`

**Interfaces:**
- Dữ liệu mẫu: `03tndn-tt89.json` `{ version: 'TT89', source: 'TT 89/2026 Phụ lục I trang …', lines: [{ code: 'A1', name, kind: 'input' | 'formula' | 'from_appendix', formula?: string, overridable: boolean }] }` nhập **từ ảnh/OCR trang mẫu** (Task 0); `03-1a-tndn-tt89.json` chỉ tiêu phụ lục kết quả kinh doanh gán tới chỉ tiêu B02 theo chế độ (`b02: { tt99: ['01','02',…], tt133: […] }`) — đối chiếu tên chỉ tiêu, ghi `note` chỗ gần đúng. Cổng `03TNDN_TT89` chỉ `true` khi đã đối chiếu ảnh mọi chỉ tiêu; `false` thì API 409 `CIT_TEMPLATE_UNAVAILABLE` như `VAT_TEMPLATE_UNAVAILABLE`.
- `legal_param` `cit_rate` (nếu có văn bản): `{ standard: 20, tiers: [{ maxRevenue: '3000000000', rate: 15 }, { maxRevenue: '50000000000', rate: 17 }] }` với `validFrom` và `source` nguyên văn điều khoản; không có văn bản → không thêm, người dùng nhập thuế suất trên tờ khai (QĐ).
- `packages/domain/src/cit.ts`: `citRateFor(prevYearRevenue: string, param: CitRateParam | null, override?: string): { rate: string; basis: string }`; `quarterlyEstimate(i: { ytdProfit: string; adjustments: string; lossCarried: string; rate: string; paidYtd: string }): { taxableIncome: string; taxYtd: string; payable: string }` (làm tròn đồng, âm thì 0).
- `citEstimate.ts`: `GET /api/cit/estimate?year=&quarter=` (`cit.view`, READ_SNAPSHOT) → lợi nhuận kế toán lũy kế từ đầu năm đến hết quý (theo cùng nguồn B02: doanh thu − chi phí theo dòng sổ cái, trừ kết chuyển), doanh thu năm trước (B02 chỉ tiêu doanh thu năm trước từ sổ cái hoặc nhập tay), thuế suất đề xuất, số đã tạm nộp (Nợ 3334 đối ứng 111/112 lũy kế năm), số phải nộp quý; cảnh báo 80% ở quý 4 (`Σ tạm nộp 4 quý < 80% số quyết toán` khi đã có tờ khai năm). `POST /api/cit/estimate/voucher { year, quarter, amount }` → PKT nháp Nợ 8211 / Có 3334 (TK theo chế độ; TT133 `821`).
- `citReturn.ts`: lưu trong `tax_return` (`form_code = '03/TNDN'`, `period_kind` thêm `'year'` bằng migration (CHECK mới), `period = 1`), `values` tính từ dữ liệu + `overrides` chỉ tiêu nhập tay (điều chỉnh tăng/giảm B…, lỗ chuyển, ưu đãi); chốt/bổ sung như 01/GTGT; `GET /api/cit/returns/:id/xml` qua `htkk03tndn.ts` (định dạng chưa kiểm chứng như 01/GTGT, `verified=false`), ký được qua Task 10.
- Màn hình: tạm tính quý (bảng số, nút "Lập chứng từ chi phí thuế TNDN"), tờ khai 03/TNDN (lưới chỉ tiêu, ô nhập cho chỉ tiêu overridable, phụ lục 03-1A, Chốt, Tải XML, Ký và tải XML).

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('citRateFor theo bậc doanh thu năm trước khi có tham số; không tham số và không override → lỗi CIT_RATE_REQUIRED', () => {});
it('quarterlyEstimate: lỗ lũy kế → payable 0', () => {});
it('dữ liệu mẫu ABC quý 2: lợi nhuận lũy kế = B02 6 tháng (chỉ tiêu lợi nhuận trước thuế); đã tạm nộp quý 1 trừ đúng', async () => {});
it('phụ lục 03-1A: số khớp B02 năm của cùng công ty (từng chỉ tiêu gán)', async () => {});
it('tờ khai 03/TNDN chốt rồi sửa → TAX_RETURN_FINAL; bổ sung lần 1 được', async () => {});
it('cổng 03TNDN_TT89 false → 409 CIT_TEMPLATE_UNAVAILABLE', async () => {});
```
- e2e: mở tạm tính quý → thấy số → lập chứng từ → PKT nháp; mở 03/TNDN năm → nhập điều chỉnh tăng → Chốt.

- [ ] **Step 2:** FAIL. **Step 3:** viết (dữ liệu chỉ từ văn bản gốc; chỗ không đọc được ghi `note`, cổng `false`). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(api): tạm tính thuế TNDN quý, tờ khai quyết toán 03/TNDN và phụ lục 03-1A theo TT 89/2026`.

### Task 18: Soát lỗi GĐ5

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0088_soat_loi_gd5.sql`
- Test: `apps/api/test/dataCheck.test.ts`

**Quy tắc** (`seed_data_check_rules` thân hiện hành + công ty đã có; SQL chỉ đọc, theo khoảng ngày):
- `HDDT_CHUA_PHAT_HANH` (cảnh báo): chứng từ bán đã ghi sổ còn `einvoice_pending` quá 1 ngày sau ngày chứng từ.
- `HDDT_DANG_GUI` (lỗi): `einvoice.status = 'sending'` quá 1 giờ.
- `HDDT_LOI` (lỗi): `failed` chưa bỏ.
- `HDDT_CHO_MA_CQT` (cảnh báo): ký hiệu C, `cqt_status = 'waiting'` quá 1 ngày.
- `HDDT_CAN_DAO_GOC` (lỗi): `needs_reversal`.
- `HDDV_CHUA_LAP_CT` (cảnh báo): hóa đơn đầu vào `new` quá 7 ngày.
- `HDDV_CHU_KY` (lỗi): hóa đơn đầu vào có chứng từ mà chữ ký người bán `valid = false`.
- `NH_CHUA_DOI_CHIEU` (cảnh báo): giao dịch ngân hàng `new` quá 3 ngày.
- `NH_LECH_SO_TIEN` (lỗi): giao dịch gắn chứng từ có tổng TK ngân hàng khác số giao dịch (chứng từ sửa sau khi gắn).

- [ ] **Step 1:** kiểm thử thất bại mỗi quy tắc một ca dương, một ca âm. **Step 2:** FAIL. **Step 3:** migration. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(db): soát lỗi hóa đơn điện tử, hóa đơn đầu vào, giao dịch ngân hàng`.

### Task 19: Dữ liệu mẫu ABC GĐ5, bất biến 9

Model: sonnet.

**Files:**
- Modify: `apps/api/scripts/seed-abc.ts` (nhà cung cấp `fake`, ký hiệu `1C26TAA`, phát hành hóa đơn cho các chứng từ bán đã có của 2026, một điều chỉnh giảm, một thay thế; 3 hóa đơn đầu vào từ mẫu XML, 1 đã lập chứng từ; kết nối SePay giả với 5 giao dịch, 3 đã đối chiếu), `packages/db/src/seed/expected-gd4-abc.json` → kiểm số BCTC không đổi ngoài chỗ thay thế (ghi số mới tính tay vào `expected-gd5-abc.json` nếu đổi)
- Create: `apps/api/test/invariants/inv9-hoa-don-ngan-hang.test.ts`
- Test: `apps/api/test/sample-abc*.test.ts`

**Bất biến 9 (fast-check, chuỗi thao tác ngẫu nhiên phát hành/thử lại/timeout/điều chỉnh/thay thế/webhook lặp):**
1. Mỗi chứng từ có ≤ 1 `einvoice` ở `sending|issued`; mỗi `einvoice` `issued` có `voucher_invoice` của chứng từ mang đúng số, ký hiệu, ngày; không còn `einvoice_pending`.
2. Chứng từ có `einvoice` `issued` luôn `posted`; `replaced|cancelled` ⇒ chứng từ `reversed` hoặc `needs_reversal`.
3. Số hóa đơn trong một ký hiệu không trùng và (với `fake`) liên tục từ 1.
4. Gửi lại webhook k lần (kể cả đồng thời) ⇒ đúng một `bank_transaction` mỗi `external_id`; giao dịch `matched` ⇒ chứng từ `posted` cùng TK, cùng số tiền.

- [ ] **Step 1:** viết bất biến (thất bại trước khi seed/mã hoàn chỉnh nếu có lỗi). **Step 2:** `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts` xanh. **Step 3:** seed `pnpm db:seed:abc` chạy lại được (idempotent như hiện có).
- [ ] **Step 4:** Commit `test(api): bất biến 9 hóa đơn điện tử và giao dịch ngân hàng; dữ liệu mẫu ABC GĐ5`.

### Task 20: Tài liệu người dùng, rà soát toàn nhánh, kết thúc GĐ5

Model: controller (tài liệu), opus (rà soát toàn nhánh), haiku (cổng cuối, bản sao sạch).

- [ ] `docs/user/giai-doan-5-hoa-don-tich-hop.md`: cấu hình nhà cung cấp, ký hiệu; phát hành, điều chỉnh, thay thế, 04/SS; hóa đơn đầu vào; kết nối ngân hàng (URL webhook, khóa, sao kê), đối chiếu; VietQR; ký số (tiện ích cục bộ); thuế TNDN; khóa API; "Hạn chế đã biết" (chưa thử SInvoice thật, chưa kiểm chứng XML 1450 với văn bản gốc, …).
- [ ] Rà soát toàn nhánh `gd4-hoan-tat..HEAD` (opus), một đợt sửa, rà soát lại.
- [ ] `pnpm lint && pnpm typecheck && pnpm test`, `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts`, e2e đầy đủ xanh; kiểm trên bản sao sạch tại commit cuối (migrate 0001–cuối, seed ABC+XYZ).
- [ ] Tag `gd5-hoan-tat`, push `main` và tag; cập nhật `docs/TIEP-THEO.md` (GĐ5 xong, "Bàn giao GĐ6" gồm 05/KK-TNCN, quyết toán TNCN, chi lương theo lô; "Hạn chế đã biết của GĐ5"; mục 4 việc chờ người dùng mới), `docs/NHAT-KY-TIEN-DO.md`.
- [ ] Mở phiên nền GĐ6 (`claude --bg --model opus -n "Giai đoạn 6" "Đọc docs/TIEP-THEO.md mục Bàn giao GĐ6 (bản mới nhất ở origin/main, tag gd5-hoan-tat) rồi làm GĐ6 theo quy trình CLAUDE.md; subagent dùng model tier thấp hơn, chỉ dùng opus khi cần. Xong GĐ6 thì tự mở session nền mới cho GĐ7 theo cùng cách."`).

## Thứ tự thực hiện

T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14 → T15 → T16 → T17 → T18 → T19 → T20.

Phụ thuộc chính: T3 trước T4–T9; T4 trước T5, T7; T5 trước T6, T9; T10 (`verifyEnveloped`) trước T11; T11 trước T12, T16 (inbound qua API); T13 trước T14, T15; T17 độc lập (sau T10 cho ký XML). T18 sau T5–T14; T19 sau mọi tác vụ chức năng.

| Migration | Tác vụ |
|---|---|
| 0078_quyen_gd5.sql | T1 |
| 0079_hddt_cau_hinh.sql | T2 |
| 0080_hddt.sql | T3 (+ `einvoice_fake_store` của T4) |
| 0081_hddt_doi_soat.sql | T5 |
| 0082_thong_bao_sai_sot.sql | T8 |
| 0083_ky_so.sql | T10 |
| 0084_hoa_don_dau_vao.sql | T11 |
| 0085_anh_xa_hang_dau_vao.sql | T12 |
| 0086_giao_dich_ngan_hang.sql | T13 (+ `bank.napas_bin` T15) |
| 0087_khoa_api.sql | T16 |
| 0088_tndn.sql | T17 (`tax_return.period_kind 'year'`) |
| 0089_soat_loi_gd5.sql | T18 |

Migration đã đẩy là đóng băng: tác vụ sau cần sửa thì thêm migration số kế tiếp (đánh số lại bảng này khi thực hiện).

## Đối chiếu lộ trình GĐ5

| Mục lộ trình | Tác vụ |
|---|---|
| `EInvoiceProvider`; adapter SInvoice (tạo, tra cứu, điều chỉnh/thay thế, hủy giao dịch, cập nhật thanh toán, lấy PDF/XML) | T4, T5, T6, T7 |
| Ký hiệu mẫu số/ký hiệu theo TT 91/2026; vòng đời lập → ký → gửi CQT → có mã → điều chỉnh/thay thế → 04/SS-HĐĐT; hóa đơn máy tính tiền; nhật ký gửi/nhận | T2, T3, T5, T6, T8, T9 (máy tính tiền: ký hiệu loại M, phát hành như hóa đơn thường; bán qua API ngoài T16) |
| Ký số: tiện ích cục bộ USB token (localhost, XML-DSig), ký từ xa (SmartCA trước) | T10 (PKCS#7/PDF chưa làm, QĐ) |
| Hóa đơn đầu vào: nhận XML (tải lên/API; email hoãn), parse QĐ 1450, kiểm chữ ký, lập chứng từ mua, kiểm MST người bán | T11, T12, T16 |
| Ngân hàng: webhook SePay/Casso, hộp thư, gợi ý đối chiếu, nhập sao kê, VietQR | T13, T14, T15 |
| Chi lương theo lô (file mẫu ngân hàng) | **chuyển GĐ6** cùng bảng lương (QĐ 518) |
| Thuế TNDN tạm nộp quý, 03/TNDN + phụ lục kết quả kinh doanh, điều chỉnh tăng/giảm; XML; tham số 15/17/20% | T17 |
| 05/KK-TNCN quý và quyết toán TNCN | **chuyển GĐ6** (nguồn số là bảng lương; QĐ 518) |
| API REST có khóa cho phần mềm bán hàng (đẩy đơn/hóa đơn, lấy tồn) | T16 |
| Tiêu chí: phát hành và nhận lại hóa đơn có mã trên môi trường thử SInvoice | **chờ tài khoản thử** (mục 4): làm đến máy giả lập theo tài liệu (T7) |
| Tiêu chí: XML đầu vào mẫu của 3 nhà cung cấp parse đúng | T0, T11 |
| Tiêu chí: webhook SePay thử tạo được giao dịch chờ đối chiếu | T13 (máy giả lập theo tài liệu; tài khoản thử SePay chờ người dùng) |

Ngoài phạm vi (ghi hạn chế): adapter meInvoice/VNPT/BKAV (không có tài liệu công khai); nhận hóa đơn qua email (cần hộp thư, quyết định người dùng); kiểm chuỗi tin cậy CA của chữ ký; ký PDF (PAdES); kết nối T-VAN; mẫu sao kê riêng từng ngân hàng.

## Self-Review (đã chạy)

1. **Phủ đặc tả:** mục 9 Hóa đơn điện tử (phát hành có mã/không mã — ký hiệu C/K T2; ký số T10; gửi CQT/tra trạng thái T5; điều chỉnh/thay thế T6; 04/SS T8; máy tính tiền T2/T16; nhận XML T11; lập chứng từ T12; adapter SInvoice T7), Ngân hàng (webhook T13, sao kê T13, VietQR T15, đối chiếu sổ phụ T14), Mua hàng (XML, MST T11–T12), Thuế TNDN (T17; TNCN chuyển GĐ6), mục 11 Tích hợp (tra cứu MST T11; BHXH I-VAN là GĐ6). Không còn mục lộ trình không có tác vụ, trừ các mục chuyển có QĐ.
2. **Bước:** mỗi tác vụ có Interfaces, tên kiểm thử và giá trị; các chỗ phụ thuộc tài liệu khảo cứu trỏ đúng tệp `docs/dev/tich-hop/*.md` (T0) thay vì đoán tên trường.
3. **Kiểu:** `EInvoiceDoc`, `IssueResult`, `OriginalRef`, `ProviderError` (T4) dùng nguyên ở T5–T8; `verifyEnveloped` (T10) dùng ở T11; `storeInbound` (T11) dùng ở T16; `fn_einvoice_set_number` (T3) dùng ở T5.
4. **Review Focus:** 5 mục, mỗi mục có kiểm thử ở tác vụ sở hữu (T5, T3, T13, T11, T16).
5. **Cân đối:** kế hoạch không chứa thân hàm; chỉ chữ ký, bảng, tên kiểm thử.
