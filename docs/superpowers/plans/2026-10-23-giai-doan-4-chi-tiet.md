# Kế hoạch thực hiện chi tiết: GĐ4 (Tài sản và khế ước)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Doanh nghiệp quản lý được TSCĐ, CCDC, chi phí trả trước và khế ước vay trong phần mềm: thẻ, ghi tăng/giảm, đánh giá lại, điều chuyển, dừng khấu hao, kiểm kê; khấu hao và phân bổ hằng kỳ bằng chứng từ tự động chạy lại được; lãi vay tự động; số dư đầu kỳ và nhập Excel; sổ/thẻ/bảng theo mẫu chế độ; quy trình cuối kỳ có thứ tự với trạng thái từng bước.

**Architecture:** Giữ modular monolith. Một sổ tài sản chung `asset` (kind `fixed` = TSCĐ, `tool` = CCDC, `prepaid` = chi phí trả trước) gắn vào sổ cái bằng `voucher_line.asset_id`. **Sổ cái là nguồn số tiền duy nhất**: nguyên giá = Σ dòng TK tài sản (211/212/213 hoặc 242) có `asset_id`, hao mòn = Σ dòng TK hao mòn (2141/2142/2143) có `asset_id`; thẻ chỉ giữ thông tin mô tả, thời gian sử dụng, phân bổ chi phí và các biến động. Lịch khấu hao/phân bổ là phiên bản (`asset_schedule`) dựng bằng hàm thuần ở `packages/domain`; mỗi lần chạy kỳ so cơ sở của phiên bản với sổ cái, lệch thì sinh phiên bản mới từ kỳ đó (lịch cũ giữ nguyên). Mỗi lần chạy kỳ (`period_run`) sinh một chứng từ tự động (KH khấu hao, PB phân bổ, LV lãi vay); chạy lại = khớp thì giữ, lệch thì đảo cũ ngày cuối kỳ rồi sinh mới (khuôn `invoices/amortization.ts`). Khế ước vay là `contract` loại `loan` + điều khoản, lãi suất theo ngày hiệu lực, lịch trả gốc; dư nợ đọc từ dòng 341x có `contract_id`.

**Tech Stack:** như GĐ3 (Node 22, TypeScript 5, Fastify 5, Kysely, PostgreSQL 16, Vitest, fast-check, React 18 + Vite + Ant Design 5 + AG Grid, Playwright, ExcelJS, pnpm). Không thêm phụ thuộc npm.

**Spec:** `docs/superpowers/specs/2026-10-19-phan-mem-ke-toan-design.md` (mục 6 dòng "TSCĐ/CCDC/chi phí trả trước/khế ước vay", 7.1, 7.2 kỳ 0, 7.3, 9 dòng Danh mục "Loại TSCĐ/CCDC…", Số dư đầu kỳ, CCDC – chi phí trả trước, TSCĐ, Khế ước vay, Sổ sách – báo cáo); lộ trình `docs/superpowers/plans/2026-10-19-lo-trinh-thuc-hien.md` mục "Giai đoạn 4"; bàn giao `docs/TIEP-THEO.md` mục "Bàn giao GĐ4"; khuôn `2026-10-22-giai-doan-3-chi-tiet.md`; quyết định `2026-10-22-giai-doan-3-quyet-dinh.md`.

## Global Constraints

- Mọi quy tắc trong `CLAUDE.md` mục "Quy tắc bất biến". Tiền VND `NUMERIC(20,0)`, nguyên tệ `NUMERIC(20,4)`, lãi suất năm `NUMERIC(9,6)` (phần trăm), số tháng/kỳ (đơn vị khấu hao) `NUMERIC(24,12)`; trong TypeScript tiền và số thập phân là chuỗi + `D()`, không bao giờ `number`; đầu vào tiền VND theo `VND_AMOUNT_RE`.
- Không `UPDATE`/`DELETE` dòng sổ cái đã ghi sổ. KH, PB tự động, LV, TS là chứng từ hệ thống: có số, ngày, người lập, `source_doc_type`/`source_doc_id`; không lập tay, không bỏ ghi sổ/hủy/sửa qua route chung (KH, LV, TS thêm vào `SYSTEM_VOUCHER_TYPES`; PB tự động nhận diện bằng `source_doc_type` như GĐ2). Định nghĩa lại `unpost_voucher`/`discard_voucher` (và hàm khác cần chặn) lấy **thân hiện hành** bằng `SELECT pg_get_functiondef('<hàm>'::regprocedure)` trên DB đã migrate tới 0068, không chép từ migration cũ; `SYSTEM_MSG` trong `vouchers.service.ts` thêm `asset_run`, `asset_event`, `loan_interest`.
- Bảng mới: `tenant_id uuid NOT NULL REFERENCES tenant(id)`, `SELECT rls_enable('<bảng>')`; bảng người dùng thao tác thêm `audit_enable`; mọi `UNIQUE` có `tenant_id`; khóa ngoại giữa hai bảng cùng có `tenant_id` là tổng hợp `(tenant_id, x_id) REFERENCES cha (tenant_id, id)`, bảng cha có `UNIQUE (tenant_id, id)`; `ON DELETE SET NULL (x_id)`. Hàm `SECURITY DEFINER` có `SET search_path = public, pg_temp`. Khóa ngoại mới trên `voucher_line` khai báo trên bảng gốc (`NOT VALID` rồi `VALIDATE`).
- Migration 0001–0068 đóng băng; GĐ4 bắt đầu ở **0069** (bảng "Thứ tự thực hiện"); số đã dùng thì dịch lên. `app_user` không ghi trực tiếp partition `voucher_line_YYYY_MM`; đọc dòng sổ cái luôn lọc `posting_date`.
- Tài khoản trên thẻ, loại tài sản, phân bổ, khế ước lưu **mã** (text) và tra theo chế độ của năm chứng từ khi ghi sổ (quyết định GĐ3 #198): TT99 `211→2141`, `212→2142`, `213→2143`; TT133/TT200 `2111/2112/2113→2141/2142/2143` (TT200 còn 2114–2138: hao mòn theo nhóm 2141/2143). Tài khoản không có trong chế độ thì 409 `ACCOUNT_NOT_FOUND` nêu mã và chế độ.
- Pháp lý: mẫu số 01..06-TSCĐ, S21-DN, S22-DN, S23-DN (TT99) và 01-TSCĐ, 02-TSCĐ, 06-TSCĐ, S09-DNN, S10-DNN, S11-DNN (TT133), 07-VT chỉ in "Mẫu số" sau khi đối chiếu `~/legal-docs/tt99-2025/tt99-full.txt` (danh mục dòng 1190–1197, 18938–18942; giải thích S21/S22/S23 từ dòng 20674) và `~/legal-docs/tt133-2016/tt133-full.txt` (dòng 9366–9371, 12248–12251, 12925–13010); TT200 in không có dòng "Mẫu số". **Khung thời gian khấu hao (TT 45/2013 và văn bản thay thế) chưa có văn bản gốc: không gợi ý, không kiểm thời gian sử dụng theo khung**, người dùng tự nhập (mục 4 TIEP-THEO). Không nhập lãi suất, quy tắc tính lãi từ trí nhớ: cơ sở ngày (365/360) là thuộc tính khế ước người dùng chọn.
- Cờ nhạy cảm: tài sản không thêm cờ mới; ghi tăng từ kho đi qua phiếu xuất kho nên `view_cost` chặn như chứng từ kho. Khế ước vay (341x/335) không nhạy cảm.
- Báo cáo đọc trong `READ_SNAPSHOT` (`REPEATABLE READ READ ONLY`). Mã lỗi `_NOT_FOUND` 404; trạng thái không cho thao tác 409; đầu vào sai 400. Mọi thay đổi thẻ, phân bổ, biến động, khế ước ghi `audit_event`.
- Giao diện, thông báo lỗi, tài liệu: tiếng Việt kế toán chuẩn (Thẻ tài sản cố định, Sổ tài sản cố định, Bảng tính và phân bổ khấu hao TSCĐ, Ghi tăng, Ghi giảm, Đánh giá lại, Điều chuyển, Công cụ dụng cụ, Chi phí trả trước, Khế ước vay, Giải ngân, Lãi vay). Mã, bảng, biến: tiếng Anh.
- Màn hình mới: skill `evon:ui-ux` chế độ **dựng luôn**; dùng `KeyboardGrid`, `LookupSelect`, `VnNumberInput`, `useHotkeys`, `useRememberedFilter` của `@kt/ui`; phím Insert/Ctrl+S/F9/F4/Enter/Tab; mỗi màn hình ít nhất một spec Playwright trong `apps/web/e2e/` theo khuôn `phieu-thu.spec.ts` (`signIn`).
- Kiểm thử tuần tự trên PostgreSQL thật (DB tạm theo lần chạy). Một gói: `pnpm -F @kt/api test -- test/<file>.test.ts`. Không chạy hai việc nặng (Playwright, bất biến dài, perf) song song (VPS 2 CPU).
- Commit nhỏ Conventional Commits, mô tả tiếng Việt, scope `db|domain|api|worker|web|ui|coa|docs`; trailer `Co-Authored-By` của model viết commit. Làm trên nhánh worktree `worktree-gd4`, **push `HEAD:main` (fast-forward) sau mỗi tác vụ**. Quyết định ghi vào `docs/superpowers/plans/2026-10-23-giai-doan-4-quyet-dinh.md` (đánh số tiếp GĐ3, từ #383).

## Quy ước thiết kế đã chốt

1. **Sổ cái là nguồn số tiền.** Với tài sản A tại ngày t: `cost(A,t)` = Σ (Nợ − Có) dòng có `asset_id = A` trên TK tài sản của A (`asset.asset_account_code`, gồm cả 242 cho CCDC/CPTT), chứng từ `state IN ('posted','reversed')`, `posting_date ≤ t`; `acc(A,t)` = Σ (Có − Nợ) dòng có `asset_id = A` trên TK hao mòn (chỉ `fixed`). Giá trị còn lại `nbv = cost − acc`. Báo cáo, lịch, bất biến đều đọc theo định nghĩa này (hàm SQL `fn_asset_values_at(tenant, date)` ở Task 4).
2. **2141, 2142, 2143 theo dõi tài sản** (`subledger_kind = 'fixed_asset'`, Task 1) để `fn_line_before` bắt `LINE_ASSET_REQUIRED` trên mọi dòng hao mòn: tổng giá trị còn lại của sổ tài sản bằng 211(+212+213) − 214 **theo cấu trúc**. 2147 (BĐS đầu tư) và 217 ngoài phạm vi GĐ4. Dòng 242 không bắt buộc có tài sản (chi phí trả trước không lập thẻ vẫn ghi được); bất biến CCDC/CPTT so Σ thẻ với Σ dòng 242 **có** `asset_id`.
3. **Đơn vị thời gian.** TSCĐ: thời gian sử dụng tính bằng **tháng**; một kỳ kế toán tiêu thụ `units(P)` tháng = Σ theo từng tháng dương lịch nằm trong kỳ của phần hoạt động: chế độ `fa_proration = 'day'` (mặc định) lấy `ngày hoạt động / số ngày của tháng`; `'month'` lấy 1 cho tháng có ngày bắt đầu khấu hao và mọi tháng hoạt động vào ngày 1, 0 cho tháng ghi giảm. "Hoạt động" = từ `depreciation_start_date`, trừ các khoảng dừng khấu hao, trước ngày ghi giảm. CCDC/CPTT: đơn vị là **kỳ**, mỗi kỳ hoạt động tiêu thụ 1 (không chia theo ngày). Kỳ 0 và kỳ điều chỉnh (period_no > 12 hoặc không có ngày) tiêu thụ 0.
4. **Làm tròn theo lũy kế.** Phiên bản có cơ sở `B` (giá trị cần khấu hao) và `U` (đơn vị còn lại); sau khi tiêu thụ `c` đơn vị, lũy kế mục tiêu `T(c) = c ≥ U ? B : round_half_up(B × c / U)`; số kỳ = `T(c_sau) − T(c_trước)`. Tổng các kỳ đúng bằng `B`, không trôi số.
5. **Phiên bản lịch.** Phiên bản V áp cho kỳ P nếu V chưa bị thay và `V.eff ≤ P` (lấy V muộn nhất). Khi chạy P, dùng dòng của V cho P **chỉ khi** (a) `cost(A, P.to)` = `V.basis_cost`; (b) `acc_excl(A,P)` = `V.basis_acc + Σ dòng V trước P`, với `acc_excl` = hao mòn đến `P.to` trừ mọi chứng từ của các lần chạy kỳ P (`source_doc_type='asset_run'` và `source_doc_id` thuộc `period_run` của P, kể cả bản đảo); với CCDC/CPTT thay (b) bằng `cost` sau các kỳ trước khớp; (c) V có dòng cho P với `units` bằng `units(P)` tính lại. Sai một điều kiện → phiên bản mới `eff = P`, `B = nbv` tại P (theo `acc_excl`), `U = V.U − Σ units các dòng V trước P` (cộng/trừ điều chỉnh thời gian), mọi phiên bản `eff ≥ P` đánh dấu `superseded_at`. Phiên bản đầu: `U = life_units` (hoặc `opening_remaining_units` với tài sản nhập đầu kỳ). Dòng lịch tương lai dựng cho các kỳ đã tạo; năm chưa tạo giả định 12 kỳ tháng dương lịch (như `amortization.buildLines`).
6. **Không chạy cách kỳ.** Chạy kỳ P của một loại (`depreciation`/`tool`/`prepaid`/`loan_interest`) bị từ chối 409 `PERIOD_RUN_GAP` nếu kỳ liền trước có tài sản (khế ước) phát sinh số khác 0 mà chưa có lần chạy hiệu lực.
7. **Ghi giảm trong kỳ P.** Tài sản có ngày ghi giảm `d` ∈ P không có trong KH của P và các kỳ sau. Chế độ `day`: chứng từ ghi giảm (TS) tự gồm khấu hao từ `P.from` đến `d − 1` theo phiên bản của P; chế độ `month`: không khấu hao kỳ P. Mọi nghiệp vụ ngày `d` ∈ P (ghi giảm, hủy ghi giảm, đánh giá lại, điều chuyển, dừng/tiếp tục, điều chỉnh thời gian) **chạy lại các lần chạy hiện có của kỳ P và các kỳ sau** của loại đó trong cùng giao dịch (`refreshRuns`); kỳ nào khóa mà người dùng không có quyền ghi lùi thì cả nghiệp vụ 409, thông báo nêu kỳ.
8. **Lãi vay.** Lãi kỳ P của khế ước K = Σ ngày d ∈ [P.from, P.to] của `dư nợ gốc cuối ngày d × lãi suất năm hiệu lực ngày d / 100 / cơ sở ngày` (cơ sở 365 hoặc 360 trên khế ước); dư nợ gốc = Σ (Có − Nợ) nguyên tệ dòng 341x có `contract_id = K`. Làm tròn một lần mỗi khế ước mỗi kỳ: VND 0 chữ số, ngoại tệ 2 chữ số; quy VND theo tỷ giá ngày `P.to` (loại tỷ giá nợ phải trả như đánh giá lại GĐ2).
9. **Khóa cạnh tranh.** Mọi lần chạy kỳ và nghiệp vụ tài sản lấy `pg_advisory_xact_lock(hashtext('asset_run'), hashtext(tenant))` (lãi vay: `'loan_run'`); cùng khóa với sửa/xóa thẻ, phân bổ, khế ước.

## Hợp đồng ghi sổ GĐ4 (ai ghi sổ cái giá trị nào)

| Chứng từ | Ai sinh | Ngày | Dòng | `source_doc_*` | Chạy lại / hủy |
|---|---|---|---|---|---|
| Chứng từ mua có tài sản (HDM, PC, BN, PKT) | người dùng | ngày chứng từ | Nợ TK tài sản (`assetCode`) / Có 331, 111, 112… | không | sửa như chứng từ thường; thay đổi làm lịch kỳ sau lệch → phiên bản mới |
| PXK xuất dùng (TSCĐ/CCDC từ kho) | người dùng qua `stockVouchers` | ngày phiếu | Nợ TK tài sản (`assetCode` của dòng hàng) / Có 152/153/155/156 | không | GV của giá vốn chạy sau ghi chênh **trên cùng `asset_id`** (Task 2) |
| TS ghi tăng khác (XDCB, góp vốn, thuê tài chính, biếu tặng, khác) | màn hình tài sản | ngày ghi tăng | Nợ TK tài sản (A) / Có TK đối ứng chọn | `asset_event`, id biến động | hủy = đảo cùng ngày |
| TS ghi giảm | màn hình tài sản | ngày ghi giảm `d` | [day: Nợ chi phí theo phân bổ / Có 214x (A) phần đến `d−1`]; Nợ 214x (A) toàn bộ hao mòn; Nợ TK đối ứng (811 mặc định; 242 + thẻ CCDC mới khi chuyển CCDC) giá trị còn lại; Có TK tài sản (A) nguyên giá. CCDC/CPTT: Nợ TK đối ứng / Có 242 (A) phần giá trị còn lại của số lượng giảm | `asset_event` | hủy = đảo cùng ngày + `refreshRuns` |
| TS đánh giá lại (TSCĐ) | màn hình tài sản | ngày đánh giá | Nợ/Có TK tài sản Δ nguyên giá; Có/Nợ 214x Δ hao mòn; đối ứng TK chọn (412 mặc định nếu có trong chế độ) phần ròng | `asset_event` | hủy = đảo + `refreshRuns` |
| TS điều chỉnh giá trị CCDC/CPTT | màn hình tài sản | ngày điều chỉnh | Nợ/Có 242 (A) Δ / đối ứng chọn | `asset_event` | như trên |
| KH khấu hao kỳ | `runAssetPeriod('depreciation')` | `P.to` | mỗi tài sản: Nợ TK chi phí theo phân bổ (bộ phận, vụ việc, khoản mục) / Có 214x (A) | `asset_run`, id `period_run` | khớp giữ; lệch đảo ngày `P.to` rồi sinh mới |
| PB phân bổ CCDC, CPTT kỳ (hai lần chạy riêng) | `runAssetPeriod('tool'|'prepaid')` | `P.to` | mỗi thẻ: Nợ TK chi phí theo phân bổ / Có 242 (A) | `asset_run` | như KH |
| BC/BN/PKT giải ngân, trả nợ | `loans` hoặc người dùng | ngày chứng từ | Có 341x (K) / Nợ 112, 331…; trả: Nợ 341x (K), Nợ 335 (K) / Có 112 | không | chứng từ thường |
| LV lãi vay kỳ | `runLoanInterest` | `P.to` | mỗi khế ước: Nợ TK chi phí lãi (635 mặc định, hoặc 2412/627 vốn hóa) / Có TK lãi phải trả của khế ước (335 mặc định), `contract_id = K` ở dòng Có | `loan_interest`, id `period_run` | như KH |
| DK số dư đầu kỳ | `postOpening` | ngày đầu năm | thêm dòng theo thẻ: Nợ TK tài sản (A) nguyên giá, Có 214x (A) hao mòn, Nợ 242 (A) giá trị còn lại; dòng 341x/335 có `contract_id` | `opening_balance` | như GĐ1/GĐ3 |

Người đọc: `fn_asset_values_at` (sổ TSCĐ, thẻ, bất biến, soát lỗi), động cơ lịch (Task 4), B01 TT99 (dư nợ vay theo khế ước, Task 9), quy trình cuối kỳ (Task 12).

## Review Focus

1. Ghi lùi một chứng từ mua thêm nguyên giá (Nợ 211 tài sản A) vào kỳ đã khấu hao: kỳ đó hiện "cần chạy lại" ở quy trình cuối kỳ và soát lỗi; chạy lại kỳ đó sinh phiên bản lịch mới, đảo KH cũ, KH mới khớp; kỳ sau chạy tiếp không lệch (Task 4, 12, 15 có kiểm thử).
2. Ghi giảm tài sản giữa tháng khi KH tháng đó và tháng sau đã chạy: KH hai tháng được chạy lại không còn tài sản, chứng từ ghi giảm gồm khấu hao đến ngày trước ngày giảm (chế độ ngày), sau ghi giảm nguyên giá và hao mòn của A đều bằng 0 (Task 5).
3. Chạy lại khấu hao một kỳ hai lần liên tiếp không đổi sổ cái (`unchanged`), không có hai lần chạy hiệu lực cho cùng kỳ (chỉ mục duy nhất), kể cả hai yêu cầu đồng thời (Task 4, 17).
4. Tài sản nhập số dư đầu kỳ đã khấu hao 40/60 tháng: kỳ 1 khấu hao `(nguyên giá − hao mòn) / 20`, tổng đến hết đời bằng đúng giá trị còn lại; số dư đầu kỳ 211/214 lệch tổng thẻ bị chặn ghi sổ (Task 8).
5. Khế ước có lịch trả gốc: B01 TT99 tại 31/12 tách đúng phần đến hạn trong 12 tháng sang ngắn hạn kể cả khi đã trả trước một kỳ; lãi kỳ có giải ngân giữa tháng và lãi suất đổi giữa tháng tính theo ngày đúng tay (Task 9, 10).

---

## Cấu trúc file

- `packages/domain/src/`: `depreciation.ts` (đơn vị kỳ, lũy kế mục tiêu, dựng lịch, chia theo tỷ lệ), `loanInterest.ts` (lãi theo ngày, tách ngắn/dài hạn theo lịch trả), `voucherTypes.ts`, `permissions.ts`.
- `packages/db/migrations/0069_quyen_gd4.sql` … `0077_soat_loi_gd4.sql` (bảng "Thứ tự thực hiện").
- `apps/api/src/modules/assets/` (mới): `assets.ts` (danh mục loại, thẻ, phân bổ, tra cứu), `schedule.ts` (phiên bản lịch), `periodRun.ts` (chạy kỳ chung, `refreshRuns`), `events.ts` (ghi tăng/giảm/đánh giá lại/điều chuyển/dừng/điều chỉnh), `openingAssets.ts`, `reports.ts`, `assetCount.ts`, `routes.ts`.
- `apps/api/src/modules/loans/` (mới): `loans.ts` (khế ước, lãi suất, lịch trả, giải ngân/trả nợ), `interest.ts`, `reports.ts`, `routes.ts`.
- `apps/api/src/modules/ledger/periodClose.ts` (mới): đăng ký bước, trạng thái, chạy bước.
- `apps/api/src/modules/reporting/print/assetForms.ts` (mới): 01/02/04/05/06-TSCĐ, S21/S22/S23 (S09/S10/S11-DNN), 07-VT.
- `apps/web/src/pages/`: `Assets.tsx` (+ `assetDialogs.tsx`), `AssetOpening.tsx`, `AssetReports.tsx`, `AssetCount.tsx`, `Loans.tsx`, `PeriodClose.tsx`.
- `apps/api/test/assets/*.test.ts`, `apps/api/test/loans/*.test.ts`, `apps/api/test/periodClose.test.ts`, `apps/api/test/invariants/inv8-tai-san.test.ts`, `packages/domain/test/depreciation.test.ts`, `packages/domain/test/loanInterest.test.ts`.
- `packages/db/src/seed/expected-gd4-abc.json`, `apps/api/scripts/seed-abc.ts`, `docs/user/giai-doan-4-tai-san-khe-uoc.md`.

---

### Task 1: Quyền GĐ4, loại chứng từ TS/KH/LV, cài đặt khấu hao, 214x theo dõi tài sản

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0069_quyen_gd4.sql`
- Modify: `packages/domain/src/permissions.ts`, `packages/domain/src/voucherTypes.ts`, `apps/api/src/modules/core/settings.ts`, `apps/api/src/modules/ledger/vouchers.service.ts` (`SYSTEM_MSG`), `packages/coa-data/data/coa/tt99.csv`, `tt133.csv`, `tt200.csv` (cột `subledger_kind` của 2141, 2142, 2143)
- Test: `packages/domain/test/permissions.test.ts`, `apps/api/test/settings.test.ts`, `apps/api/test/vouchers.test.ts`, `packages/coa-data/test/*.test.ts`

**Interfaces:**
- Quyền: `...crud('asset', 'tài sản, công cụ dụng cụ, chi phí trả trước', 'Tài sản', [['run', 'Chạy khấu hao, phân bổ']])`, `...crud('loan', 'khế ước vay', 'Khế ước vay', [['run', 'Tính lãi vay']])`, `{ code: 'period_close.view', name: 'Xem quy trình cuối kỳ', group: 'Cuối kỳ' }`.
- `0069`: `create_tenant` định nghĩa lại từ thân hiện hành; `ketoan_vien` có `asset.*`, `loan.*` trừ `asset.run`, `loan.run`; `xem` có `*.view`; công ty đã có được cấp như vậy (tắt `trg_audit` của `role_permission` khi chèn, khuôn 0043). `UPDATE account SET subledger_kind = 'fixed_asset' WHERE code IN ('2141','2142','2143')` cho mọi công ty (trước đó kiểm: không dòng sổ cái nào trên các TK này thiếu `asset_id`, có thì `RAISE NOTICE` và để soát lỗi Task 15 báo — không chặn migration). Loại chứng từ mới trong bảng `voucher_type` (khuôn `seed_voucher_types` 0025): `TS`, `KH`, `LV`.
- `voucherTypes.ts`: `module` thêm `'assets'`; `SYSTEM_VOUCHER_TYPES` thêm `'TS', 'KH', 'LV'`; `def({ code: 'TS', name: 'Chứng từ tài sản (ghi tăng, ghi giảm, đánh giá lại)', module: 'assets' })`, `def({ code: 'KH', name: 'Chứng từ khấu hao TSCĐ', module: 'assets' })`, `def({ code: 'LV', name: 'Chứng từ lãi vay', module: 'general' })`.
- `SETTINGS.fa_proration: z.enum(['day', 'month']).default('day')`.
- `SYSTEM_MSG`: `asset_event: 'Chứng từ sinh từ nghiệp vụ tài sản; hủy nghiệp vụ ở màn hình Tài sản'`, `asset_run: 'Chứng từ khấu hao/phân bổ tự động; chạy lại ở Quy trình cuối kỳ'`, `loan_interest: 'Chứng từ lãi vay tự động; chạy lại ở Quy trình cuối kỳ'`. Hàm SQL chặn bỏ ghi sổ/hủy thêm ba giá trị vào danh sách `source_doc_type` hệ thống.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('công ty mới: ketoan_vien có asset.create, loan.create; không có asset.run, loan.run; xem có asset.view', async () => {});
it('fa_proration mặc định day; giá trị khác day|month bị 400', async () => {});
it('lập tay chứng từ KH/TS/LV qua /api/vouchers → 409 VOUCHER_TYPE_SYSTEM', async () => {});
it('dòng Có 2141 không có tài sản → LINE_ASSET_REQUIRED (TT133 và TT99)', async () => {});
it('bỏ ghi sổ chứng từ source_doc_type asset_run → 409 VOUCHER_SYSTEM_GENERATED', async () => {});
```

- [ ] **Step 2:** `pnpm -F @kt/domain test`, `pnpm -F @kt/api test -- test/settings.test.ts test/vouchers.test.ts` → FAIL.
- [ ] **Step 3:** Viết migration, domain, settings, CSV.
- [ ] **Step 4:** PASS; `pnpm db:migrate`; `pnpm -F @kt/db test`, `pnpm -F @kt/coa-data test`, `pnpm -F @kt/api test` xanh.
- [ ] **Step 5:** Commit `feat(db): quyền GĐ4, loại chứng từ tài sản, khấu hao, lãi vay`.

### Task 2: Danh mục loại tài sản, thẻ tài sản, phân bổ chi phí; mã tài sản và khế ước trên dòng chứng từ

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0070_the_tai_san.sql`, `apps/api/src/modules/assets/assets.ts`, `apps/api/src/modules/assets/routes.ts`
- Modify: `packages/db/src/types.ts`, `apps/api/src/app.ts` (đăng ký route), `apps/api/src/modules/ledger/vouchers.service.ts` (`lineInput` thêm `assetCode`, `contractCode`; DTO dòng trả `assetCode`, `contractCode`), `apps/api/src/modules/invoices/service.ts` (`invoiceItemInput.assetCode` sang dòng Nợ sổ cái), `apps/api/src/modules/inventory/stockVouchers.ts` (dòng hàng `assetCode` đặt `asset_id` cho dòng Nợ), `apps/api/src/modules/inventory/costingRun.ts` (khóa gom dòng GV thêm `asset`, truyền `assetCode`)
- Test: `apps/api/test/assets/assets.test.ts`, `apps/api/test/inventory/costingRun.test.ts`

**Interfaces:**
- `asset_category(id, code, name, kind CHECK ('fixed','tool','prepaid'), asset_account_code text, depreciation_account_code text NULL, default_life_units int NULL, is_active)`; `UNIQUE(tenant_id, code)`, `UNIQUE(tenant_id, id)`.
- `asset(id bigint, code, name, kind CHECK ('fixed','tool','prepaid'), category_id NULL, asset_account_code text NOT NULL, depreciation_account_code text NULL CHECK ((kind='fixed') = (depreciation_account_code IS NOT NULL)), department_id NULL, use_date date NULL, depreciation_start_date date NULL, life_units int NULL CHECK (life_units BETWEEN 1 AND 1200), is_depreciable boolean DEFAULT true, capital_source text NULL CHECK (IN ('owner','loan','grant','other')), card_no text, country text, year_made int, spec text, quantity numeric(20,4) NOT NULL DEFAULT 1 CHECK (quantity >= 0), uom text, status text DEFAULT 'active' CHECK (IN ('active','decreased')), decrease_date date NULL, opening_year int NULL, opening_cost numeric(20,0) NULL, opening_accumulated numeric(20,0) NULL, opening_remaining_units numeric(24,12) NULL, note, created_at)`; `UNIQUE(tenant_id, code)`.
- `asset_allocation(id, asset_id, valid_from_year int, valid_from_period int, expense_account_code text, department_id NULL, project_id NULL, cost_item_id NULL, ratio numeric(9,6) CHECK (ratio > 0 AND ratio <= 100))`; tổng `ratio` của một `(asset_id, valid_from_year, valid_from_period)` = 100 (kiểm ở API, 400 `ALLOCATION_RATIO`).
- `ALTER TABLE voucher_line ADD FOREIGN KEY (tenant_id, asset_id) REFERENCES asset (tenant_id, id)`.
- API: CRUD `/api/asset-categories`, `/api/assets?kind=` (thẻ kèm `allocations` hiện hành), `PUT /api/assets/:id/allocations { validFromYear, validFromPeriod, lines[] }`, `GET /api/lookups/assets?q=&kind=` → `{ id, code, name, kind, assetAccountCode }`. Xóa thẻ có dòng sổ cái → 409 `ASSET_IN_USE`. Sửa `kind`, TK tài sản, TK hao mòn khi đã có dòng sổ cái → 409 `ASSET_ACCOUNT_LOCKED`. Kiểm mã TK: TK tài sản thuộc `fixed_asset` (fixed) hoặc 242 (tool/prepaid), TK hao mòn thuộc 214x, TK chi phí phân bổ không phải TK tổng hợp; tra theo chế độ năm muộn nhất.
- `lineInput.assetCode` → `asset_id` (404 `ASSET_NOT_FOUND`); dòng trên TK tài sản của tài sản khác TK của thẻ → 400 `ASSET_ACCOUNT_MISMATCH` (thẻ `fixed` chỉ nhận TK tài sản hoặc TK hao mòn của nó; `tool/prepaid` chỉ nhận TK tài sản của nó). `lineInput.contractCode` → `contract_id`.
- Giá vốn: dòng GV của phiếu xuất có dòng Nợ mang `asset_id` giữ `asset_id` đó (nếu không, GV trên 211 lỗi `LINE_ASSET_REQUIRED` và lệch sổ tài sản).

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('tạo thẻ TSCĐ TT133 TK 2111/2141 và phân bổ 6422 60% + 6421 40%; tổng 90% → 400 ALLOCATION_RATIO', async () => {});
it('PKT Nợ 2111 assetCode TS01 / Có 331 ghi sổ; dòng 2111 không assetCode → LINE_ASSET_REQUIRED', async () => {});
it('dòng Nợ 2112 với tài sản có TK 2111 → 400 ASSET_ACCOUNT_MISMATCH', async () => {});
it('HDM dòng TK 2111 assetCode TS02 + thuế 10%: dòng Nợ 2111 có asset_id, 1332 không', async () => {});
it('PXK xuất CCDC từ kho Nợ 242 assetCode CC01 / Có 153; chạy giá vốn lệch giá tạm tính: dòng GV trên 242 mang asset_id CC01', async () => {});
it('xóa thẻ đã có dòng sổ cái → 409 ASSET_IN_USE; đổi TK tài sản → 409 ASSET_ACCOUNT_LOCKED', async () => {});
```

- [ ] **Step 2:** `pnpm -F @kt/api test -- test/assets/assets.test.ts test/inventory/costingRun.test.ts` → FAIL.
- [ ] **Step 3:** Migration, module, mở rộng `lineInput`/hóa đơn/phiếu kho/GV.
- [ ] **Step 4:** PASS; `pnpm -F @kt/api test` xanh.
- [ ] **Step 5:** Commit `feat(api): thẻ tài sản, loại tài sản, phân bổ chi phí và mã tài sản trên dòng chứng từ`.

### Task 3: Động cơ khấu hao, phân bổ thuần ở `packages/domain`

Model: **opus** (logic kế toán khó).

**Files:**
- Create: `packages/domain/src/depreciation.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/depreciation.test.ts`

**Interfaces (Produces):**
```ts
export type Proration = 'day' | 'month';
export interface PeriodSpan { fiscalYear: number; periodNo: number; from: string; to: string } // ngày ISO, from ≤ to
export interface ActiveWindow { start: string; end: string | null; pauses: { from: string; to: string | null }[] } // end = ngày ghi giảm (không tính ngày đó)
export function periodUnits(span: PeriodSpan, w: ActiveWindow, unit: 'month_day' | 'month_whole' | 'period'): string; // thập phân 12 chữ số (sai số làm tròn ≤ 5e-13 × giá trị mỗi đơn vị)
export function targetAccumulated(basis: string, units: string, consumed: string): string; // T(c), quy ước 4
export interface ScheduleLine { fiscalYear: number; periodNo: number; units: string; amount: string; accumulated: string } // accumulated = basisAcc + lũy kế trong phiên bản
export function buildSchedule(a: { basisValue: string; basisAcc: string; units: string; periods: PeriodSpan[]; window: ActiveWindow; unit: 'month_day' | 'month_whole' | 'period' }): ScheduleLine[]; // dừng khi tiêu thụ đủ units hoặc hết periods
export function splitByRatio(amount: string, ratios: string[]): string[]; // phần dư lớn nhất, tổng đúng amount, thứ tự ổn định
export function futurePeriods(known: PeriodSpan[], fromYear: number, fromPeriod: number, count: number): PeriodSpan[]; // năm chưa có: 12 kỳ tháng dương lịch
```
- `unit`: `month_day` = TSCĐ chế độ `day`, `month_whole` = TSCĐ chế độ `month`, `period` = CCDC/CPTT (quy ước 3). Kỳ 0 và kỳ `periodNo > 12` trả `'0'`.

- [ ] **Step 1: Kiểm thử thất bại (giá trị tính tay):**

```ts
it('month_day: bắt đầu 16/01/2026, kỳ tháng 1 tiêu thụ 16/31', () => expect(periodUnits(jan, { start: '2026-01-16', end: null, pauses: [] }, 'month_day')).toBe('0.516129032258'));
it('month_whole: bắt đầu 16/01 tính đủ tháng 1; ghi giảm 10/03 thì tháng 3 bằng 0', () => {});
it('dừng 10/02–19/02 (to là ngày tiếp tục): tháng 2 tiêu thụ 19/28', () => {});
it('nguyên giá 120.000.000, 60 tháng, bắt đầu 01/01/2026: mỗi kỳ 2.000.000, kỳ 60 lũy kế 120.000.000', () => {});
it('100.000.000 / 7 kỳ: các kỳ 14285714 hoặc 14285715, tổng đúng 100.000.000', () => {});
it('month_day bắt đầu 16/01, 12 tháng, 12.000.000: kỳ 1 = 516.129, kỳ 13 nhận phần còn lại, tổng 12.000.000', () => {});
it('splitByRatio("1000001", ["60","40"]) = ["600001","400000"]; tổng luôn bằng amount (fast-check)', () => {});
it('thuộc tính: mọi lịch tổng amount = basisValue khi đủ kỳ; không kỳ nào âm; accumulated tăng đơn điệu (fast-check)', () => {});
```

- [ ] **Step 2:** `pnpm -F @kt/domain test -- test/depreciation.test.ts` → FAIL.
- [ ] **Step 3:** Cài đặt theo quy ước 3–5; mọi phép tính bằng `D()`, làm tròn `ROUND_HALF_UP`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(domain): động cơ khấu hao và phân bổ theo lũy kế mục tiêu`.

### Task 4: Phiên bản lịch, chạy khấu hao/phân bổ kỳ (KH, PB), chạy lại không trùng

Model: **opus**.

**Files:**
- Create: `packages/db/migrations/0071_lich_khau_hao.sql`, `apps/api/src/modules/assets/schedule.ts`, `apps/api/src/modules/assets/periodRun.ts`
- Modify: `apps/api/src/modules/assets/routes.ts`, `packages/db/src/types.ts`
- Test: `apps/api/test/assets/depreciationRun.test.ts`, `apps/api/test/assets/allocationRun.test.ts`

**Interfaces:**
- `period_run(id uuid DEFAULT gen_random_uuid(), tenant_id, kind CHECK ('depreciation','tool','prepaid','loan_interest'), fiscal_year, period_no, voucher_id uuid NULL, status CHECK ('active','superseded'), result jsonb, created_by, created_at, checked_at)`; `CREATE UNIQUE INDEX ... ON period_run (tenant_id, kind, fiscal_year, period_no) WHERE status = 'active'`. Lần chạy không có số nào vẫn tạo `period_run` với `voucher_id NULL` (để quy trình cuối kỳ biết đã chạy).
- `asset_schedule(id, asset_id, version int, eff_year, eff_period, basis_cost numeric(20,0), basis_acc numeric(20,0), units numeric(24,12), reason CHECK ('initial','ledger_change','window_change','life_change','rerun'), superseded_at timestamptz NULL, created_at)`; `UNIQUE(tenant_id, asset_id, version)`. `asset_schedule_line(schedule_id, fiscal_year, period_no, units numeric(24,12), amount numeric(20,0), accumulated numeric(20,0), run_id uuid NULL)`; `UNIQUE(tenant_id, schedule_id, fiscal_year, period_no)`.
- SQL `fn_asset_values_at(p_tenant uuid, p_date date) RETURNS TABLE(asset_id bigint, cost numeric, accumulated numeric)` theo quy ước 1 (`STABLE`, đọc theo `posting_date ≤ p_date`).
- `schedule.ts`: `export async function scheduleFor(trx, assetId: number, span: PeriodSpan, opts: { proration: Proration; runIdsOfPeriod: string[] }): Promise<{ schedule: AssetSchedule; line: ScheduleLine | null; created: boolean }>` theo quy ước 5; `export async function previewSchedule(trx, assetId): Promise<ScheduleLine[]>` (lịch hiện hành cho màn hình).
- `periodRun.ts`:
  - `export async function runAssetPeriod(trx, ctx: { tenantId: string; userId: string; canBackdate: boolean }, input: { kind: 'depreciation' | 'tool' | 'prepaid'; fiscalYear: number; periodNo: number }): Promise<{ runId: string; voucherId: string | null; reversedVoucherIds: string[]; unchanged: boolean; lines: { assetCode: string; amount: string }[] }>` — khóa (quy ước 9), kiểm kỳ (khuôn `runAmortization`: hard_locked 409, soft_locked cần `canBackdate`), kiểm quy ước 6 (`PERIOD_RUN_GAP`), chọn tài sản đúng loại, `status='active'` hoặc giảm sau `P.to`, `is_depreciable`, có `depreciation_start_date ≤ P.to` (CCDC/CPTT: kỳ bắt đầu ≤ P), tính số từng tài sản qua `scheduleFor`, chia theo phân bổ hiện hành tại P (`splitByRatio`), dựng dòng (quy ước bảng hợp đồng); so với chứng từ của lần chạy hiệu lực (khóa so: TK, nợ, có, `asset_id`, bộ phận, vụ việc, khoản mục, sắp xếp) → `unchanged` (cập nhật `checked_at`), hoặc đảo chứng từ cũ ngày `P.to`, đánh dấu `superseded`, tạo lần chạy mới + chứng từ KH (depreciation) hoặc PB (tool/prepaid), ghi `run_id` vào dòng lịch.
  - `export async function refreshRuns(trx, ctx, kind, fromYear: number, fromPeriod: number): Promise<{ fiscalYear: number; periodNo: number; unchanged: boolean }[]>` — chạy lại theo thứ tự mọi lần chạy hiệu lực của loại đó từ kỳ đã cho.
  - `export async function assetRunStale(trx, kind, fiscalYear, periodNo): Promise<{ stale: boolean; reason: string | null }>` — có dòng sổ cái của tài sản loại đó với `posting_date ≤ P.to` thuộc chứng từ ghi sổ sau `checked_at`/`created_at` của lần chạy (trừ chứng từ của chính các lần chạy), hoặc lần chạy kỳ trước tạo sau lần chạy kỳ này.
- Route: `POST /api/asset-runs { kind, fiscalYear, periodNo }` (`asset.run`), `GET /api/asset-runs?kind&year`, `GET /api/assets/:id/schedule`.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('TS01 nguyên giá 120.000.000, 60 tháng từ 01/01/2026: KH tháng 1 Nợ 6422 2.000.000 / Có 2141 TS01', async () => {});
it('chạy lại tháng 1 không đổi gì → unchanged, không chứng từ mới, vẫn một period_run active', async () => {});
it('hai yêu cầu chạy tháng 1 đồng thời → đúng một period_run active (chỉ mục duy nhất + khóa tư vấn)', async () => {});
it('chạy tháng 3 khi tháng 2 chưa chạy → 409 PERIOD_RUN_GAP', async () => {});
it('ghi lùi PKT Nợ 2111 TS01 12.000.000 ngày 15/02 sau khi chạy tháng 2: assetRunStale(2) = true; chạy lại tháng 2 đảo KH cũ, phiên bản mới eff 2/2026 B = 130.000.000, U = 59, KH = 2.203.390', async () => {});
it('phân bổ 60/40 theo hai bộ phận: tổng dòng Nợ = số khấu hao, dòng Có 2141 một dòng mỗi tài sản', async () => {});
it('CCDC CC01 Nợ 242 6.000.000, 3 kỳ từ kỳ 1: PB kỳ 1–3 mỗi kỳ 2.000.000 Nợ 6273 / Có 242 CC01; kỳ 4 không còn', async () => {});
it('kỳ khóa cứng → 409 PERIOD_HARD_LOCKED; khóa sổ không có quyền ghi lùi → 409 PERIOD_SOFT_LOCKED', async () => {});
it('tài sản hết khấu hao vẫn dùng: không có dòng KH; is_depreciable=false: không có dòng KH', async () => {});
```

- [ ] **Step 2:** `pnpm -F @kt/api test -- test/assets/depreciationRun.test.ts test/assets/allocationRun.test.ts` → FAIL.
- [ ] **Step 3:** Migration, `schedule.ts`, `periodRun.ts`, route.
- [ ] **Step 4:** PASS; `pnpm -F @kt/api test` xanh.
- [ ] **Step 5:** Commit `feat(api): lịch khấu hao theo phiên bản, chứng từ khấu hao và phân bổ kỳ, chạy lại không trùng`.

### Task 5: Nghiệp vụ TSCĐ: ghi tăng, ghi giảm, đánh giá lại, điều chuyển, dừng/tiếp tục, điều chỉnh thời gian

Model: **opus**.

**Files:**
- Create: `packages/db/migrations/0072_bien_dong_tai_san.sql`, `apps/api/src/modules/assets/events.ts`
- Modify: `apps/api/src/modules/assets/routes.ts`, `apps/api/src/modules/assets/periodRun.ts` (cửa sổ hoạt động đọc biến động)
- Test: `apps/api/test/assets/fixedEvents.test.ts`

**Interfaces:**
- `asset_event(id uuid DEFAULT gen_random_uuid(), tenant_id, asset_id, kind CHECK ('increase','decrease','revaluation','transfer','suspend','resume','life_change','value_adjust','quantity_change'), event_date, voucher_id uuid NULL, data jsonb NOT NULL, state CHECK ('active','cancelled') DEFAULT 'active', created_by, created_at)`; `audit_enable`.
- `events.ts` (mọi hàm khóa quy ước 9, kiểm kỳ của `event_date` ghi được, ghi `audit_event`, rồi `refreshRuns(kind, kỳ của event_date)`):
  - `increaseAsset(trx, ctx, id, { date, reason: 'construction'|'contribution'|'finance_lease'|'donation'|'other', counterAccountCode, amount, partyCode?, description? })` → chứng từ TS Nợ TK tài sản / Có đối ứng; điền `use_date`, `depreciation_start_date` nếu trống. Ghi tăng mua dùng chứng từ mua có `assetCode` (Task 2), ghi tăng từ kho dùng PXK có `assetCode`: hàm này không làm hai lý do đó (400 nêu cách làm).
  - `decreaseAsset(trx, ctx, id, { date, reason: 'liquidation'|'contribution'|'to_tool'|'loss'|'other', counterAccountCode, toolCard?: { code, name, periods, allocations } })` → quy ước 7 và bảng hợp đồng; `to_tool` tạo thẻ CCDC mới với TK 242 làm đối ứng; trả `{ eventId, voucherId, partialDepreciation }`. Tài sản đã giảm → 409 `ASSET_DECREASED`.
  - `revalueAsset(trx, ctx, id, { date, newCost, newAccumulated, remainingUnits?, counterAccountCode })`.
  - `transferAsset(trx, ctx, id, { date, departmentId, allocations })` → phân bổ mới `valid_from` = kỳ của `date`, `asset.department_id` đổi; không chứng từ.
  - `suspendAsset(trx, ctx, id, { date, reason })`, `resumeAsset(trx, ctx, id, { date })` (ngày tiếp tục > ngày dừng, 400 `ASSET_PAUSE_ORDER`).
  - `changeLife(trx, ctx, id, { date, remainingUnits })` → phiên bản mới `life_change` từ kỳ của `date`.
  - `cancelEvent(trx, ctx, eventId)` → đảo chứng từ của biến động cùng ngày (kỳ không ghi được → 409 kèm kỳ), `state='cancelled'`, khôi phục trạng thái thẻ, `refreshRuns`. Hủy biến động khi còn biến động hiệu lực muộn hơn của cùng tài sản → 409 `ASSET_EVENT_ORDER`.
- Route: `POST /api/assets/:id/{increase|decrease|revalue|transfer|suspend|resume|life}` (`asset.update`), `POST /api/asset-events/:id/cancel`, `GET /api/assets/:id/events`.

- [ ] **Step 1: Kiểm thử thất bại (số tính tay, chế độ day):**

```ts
it('ghi tăng XDCB TS02 Nợ 2111 / Có 2412 240.000.000 ngày 10/01, 48 tháng: KH tháng 1 = round(240.000.000 × (22/31) / 48) = 3.548.387', async () => {});
it('ghi giảm TS01 ngày 16/03 khi KH tháng 3, 4 đã chạy: KH 3 và 4 chạy lại không còn TS01; TS gồm khấu hao 15/31 tháng 3 = 967.742; sau đó cost = acc = 0 cho TS01', async () => {});
it('chế độ month: ghi giảm 16/03 không khấu hao tháng 3, TS không có dòng khấu hao', async () => {});
it('ghi giảm chuyển CCDC: Nợ 242 thẻ CC mới bằng giá trị còn lại; CC mới phân bổ từ kỳ sau', async () => {});
it('đánh giá lại tăng nguyên giá 12.000.000, hao mòn 2.000.000, đối ứng 412: Nợ 2111 12.000.000 / Có 2141 2.000.000 / Có 412 10.000.000; kỳ đó phiên bản mới', async () => {});
it('dừng khấu hao 01/04, tiếp tục 01/06: tháng 4, 5 không khấu hao; tổng đời vẫn bằng nguyên giá', async () => {});
it('điều chuyển bộ phận 01/05: KH tháng 5 Nợ theo phân bổ mới; tháng 4 giữ phân bổ cũ', async () => {});
it('hủy ghi giảm: đảo TS, tài sản active, KH các kỳ sau chạy lại có lại tài sản', async () => {});
it('kỳ của ngày ghi giảm đã khóa cứng → 409 PERIOD_HARD_LOCKED, không chứng từ nào được ghi', async () => {});
```

- [ ] **Step 2:** `pnpm -F @kt/api test -- test/assets/fixedEvents.test.ts` → FAIL.
- [ ] **Step 3:** Cài đặt.
- [ ] **Step 4:** PASS; `pnpm -F @kt/api test` xanh.
- [ ] **Step 5:** Commit `feat(api): ghi tăng, ghi giảm, đánh giá lại, điều chuyển, dừng khấu hao TSCĐ`.

### Task 6: Nghiệp vụ CCDC và chi phí trả trước

Model: sonnet (động cơ đã có ở Task 3–5; rà soát bằng opus).

**Files:**
- Modify: `apps/api/src/modules/assets/events.ts`, `apps/api/src/modules/assets/routes.ts`
- Test: `apps/api/test/assets/toolEvents.test.ts`

**Interfaces:**
- Ghi tăng CCDC/CPTT: mua dùng ngay (chứng từ mua có `assetCode` trên dòng 242), từ kho (PXK `assetCode` dòng Nợ 242), từ TSCĐ (`decreaseAsset` lý do `to_tool`), khác (`increaseAsset` với TK 242). `use_date` = ngày ghi tăng; kỳ bắt đầu phân bổ = kỳ của `depreciation_start_date` (mặc định kỳ ghi tăng; người dùng chọn kỳ sau).
- `decreaseTool(trx, ctx, id, { date, quantity, counterAccountCode, reason })` → giá trị ghi giảm = `round_half_up(nbv × quantity / asset.quantity)` (giảm hết số lượng = toàn bộ nbv); `quantity` thẻ giảm; Có 242 (A) / Nợ đối ứng; hết số lượng → `status='decreased'`. Số lượng lớn hơn còn lại → 400 `ASSET_QUANTITY`.
- `adjustToolValue(trx, ctx, id, { date, delta, counterAccountCode })`, `changeLife` dùng chung (số kỳ còn lại), `transferAsset` dùng chung.
- CPTT không có số lượng (quantity = 1, không giảm một phần).

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('10 CCDC 12.000.000, 12 kỳ; sau 3 kỳ giảm 4 cái: ghi giảm round(9.000.000 × 4/10) = 3.600.000; kỳ sau phân bổ 5.400.000 / 9', async () => {});
it('CPTT tiền thuê 36.000.000, 12 kỳ từ kỳ 2: kỳ 1 không phân bổ; kỳ 2/2026 đến kỳ 1/2027 mỗi kỳ 3.000.000 (năm 2027 chưa tạo: giả định 12 kỳ)', async () => {});
it('điều chỉnh tăng 600.000 ở kỳ 4 còn 9 kỳ: phiên bản mới, tổng phân bổ = tổng giá trị', async () => {});
it('giảm 11 cái khi còn 10 → 400 ASSET_QUANTITY', async () => {});
```

- [ ] **Step 2–4:** FAIL → cài đặt → PASS (`pnpm -F @kt/api test -- test/assets/toolEvents.test.ts`), cả bộ api xanh.
- [ ] **Step 5:** Commit `feat(api): ghi tăng, ghi giảm, điều chỉnh công cụ dụng cụ và chi phí trả trước`.

### Task 7: Màn hình TSCĐ, CCDC, chi phí trả trước

Model: sonnet.

**Files:**
- Create: `apps/web/src/pages/Assets.tsx`, `apps/web/src/pages/assetDialogs.tsx`, `apps/web/e2e/tai-san.spec.ts`, `apps/web/e2e/ccdc.spec.ts`
- Modify: `apps/web/src/router.tsx` (menu "Tài sản": TSCĐ `/tai-san/tscd`, CCDC `/tai-san/ccdc`, Chi phí trả trước `/tai-san/chi-phi-tra-truoc`, Loại tài sản `/tai-san/loai`), `apps/web/src/pages/VoucherForm.tsx` và `InvoiceForm.tsx` (cột "Tài sản" F4 hiện khi TK của dòng theo dõi tài sản hoặc 242; cột "Khế ước" khi TK 341x/335), `apps/web/src/pages/StockVoucher.tsx` (cột "Tài sản" khi TK Nợ là TK tài sản/242)

**Interfaces:**
- Danh sách theo `kind` (lọc nhớ `useRememberedFilter`: loại, bộ phận, trạng thái), cột: mã, tên, loại, bộ phận, ngày sử dụng, nguyên giá, hao mòn lũy kế, giá trị còn lại (đọc `GET /api/assets?kind&at=`), số kỳ còn lại.
- Thẻ (Drawer): tab Thông tin chung; Phân bổ chi phí (`KeyboardGrid`: TK chi phí F4, bộ phận, vụ việc, khoản mục, tỷ lệ; Ctrl+S lưu, tổng 100%); Lịch khấu hao/phân bổ (`GET /api/assets/:id/schedule`, chỉ đọc, kỳ đã chạy có số chứng từ); Biến động và chứng từ (danh sách biến động, nút Hủy).
- Hộp thoại nghiệp vụ: Ghi tăng, Ghi giảm, Đánh giá lại (TSCĐ), Điều chuyển, Dừng/Tiếp tục (TSCĐ), Điều chỉnh thời gian/giá trị; mỗi hộp thoại hiện trước các kỳ sẽ chạy lại (từ phản hồi API).
- Kiểm thử e2e: tạo TSCĐ, ghi tăng XDCB, xem lịch; CCDC ghi giảm một phần.

- [ ] **Step 1:** Viết `tai-san.spec.ts`, `ccdc.spec.ts` (luồng chính) → FAIL.
- [ ] **Step 2:** Dựng màn hình theo `evon:ui-ux` "dựng luôn".
- [ ] **Step 3:** `pnpm -F @kt/web exec playwright test e2e/tai-san.spec.ts e2e/ccdc.spec.ts` PASS; `pnpm -F @kt/web test`, `pnpm -F @kt/web typecheck` xanh.
- [ ] **Step 4:** Commit `feat(web): màn hình tài sản cố định, công cụ dụng cụ, chi phí trả trước`.

### Task 8: Số dư đầu kỳ TSCĐ, CCDC, chi phí trả trước; nhập Excel

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0073_so_du_tai_san.sql` (nếu cần cột/khóa mới), `apps/api/src/modules/assets/openingAssets.ts`, `apps/web/src/pages/AssetOpening.tsx`, `apps/web/e2e/tai-san-dau-ky.spec.ts`
- Modify: `apps/api/src/modules/ledger/openingBalance.ts` (bỏ `SUBLEDGER_MODULE_REQUIRED` cho TK tài sản/hao mòn khi có thẻ đầu kỳ; thêm `assetIssues`; `postOpening` tách dòng DK theo thẻ), `apps/web/src/router.tsx` (Sổ cái → "Số dư đầu kỳ tài sản" `/so-cai/tai-san-dau-ky`)
- Test: `apps/api/test/assets/openingAssets.test.ts`, `apps/api/test/openingBalance.test.ts` (sửa kỳ vọng `SUBLEDGER_MODULE_REQUIRED` cũ)

**Interfaces:**
- Thẻ đầu kỳ: `opening_year`, `opening_cost`, `opening_accumulated` (fixed), `opening_remaining_units`, `use_date`, `depreciation_start_date`. `PUT /api/opening-assets/:year { rows[] }` (thay toàn bộ thẻ đầu kỳ của năm; thẻ đã có dòng sổ cái ngoài DK thì không xóa được: 409 `ASSET_IN_USE`), `GET /api/opening-assets/:year`, mẫu và nhập Excel `GET /api/opening-assets/template`, `POST /api/opening-assets/:year/import` (khuôn `parseOpeningStockWorkbook`; lỗi nêu dòng thật và cột tiếng Việt).
- `assetIssues`: với mỗi TK tài sản/hao mòn theo dõi tài sản: Σ thẻ = số dư TK trong `opening_balance`, lệch → `ASSET_OPENING_MISMATCH` (nêu TK, số trên thẻ, số trên TK); 242: Σ thẻ CCDC/CPTT ≤ số dư 242 (vượt → `ASSET_OPENING_MISMATCH`); `opening_accumulated > opening_cost` → `ASSET_OPENING_INVALID`; TSCĐ đầu kỳ thiếu `opening_remaining_units` → `ASSET_OPENING_INVALID`.
- DK: mỗi thẻ một dòng Nợ TK tài sản (`asset_id`) nguyên giá (CCDC/CPTT: giá trị còn lại) và một dòng Có TK hao mòn (`asset_id`); phần 242 còn lại không thuộc thẻ giữ một dòng không `asset_id`. Phiên bản lịch đầu của thẻ đầu kỳ: `U = opening_remaining_units`, `B = nbv` theo DK.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('TS cũ nguyên giá 60.000.000, hao mòn 40.000.000, còn 20 tháng; số dư 2111 60tr, 2141 40tr: DK có dòng theo tài sản; KH kỳ 1 = 1.000.000', async () => {});
it('số dư 2141 là 41.000.000 khác tổng thẻ → OPENING_INVALID chứa ASSET_OPENING_MISMATCH 2141', async () => {});
it('nhập Excel: dòng 5 thiếu số tháng còn lại báo "Dòng 5, cột Số tháng còn lại"', async () => {});
it('242 có 10.000.000, thẻ CCDC 6.000.000: DK có dòng 242 CC01 6.000.000 và dòng 242 không tài sản 4.000.000', async () => {});
```

- [ ] **Step 2–4:** FAIL → cài đặt → PASS (`pnpm -F @kt/api test -- test/assets/openingAssets.test.ts test/openingBalance.test.ts`), `pnpm -F @kt/web exec playwright test e2e/tai-san-dau-ky.spec.ts`.
- [ ] **Step 5:** Commit `feat(api): số dư đầu kỳ tài sản, công cụ dụng cụ, chi phí trả trước và nhập Excel`.

### Task 9: Khế ước vay: hợp đồng, lãi suất, lịch trả gốc, giải ngân, trả nợ, số dư đầu kỳ, B01 theo lịch trả

Model: sonnet (phần B01 rà soát bằng opus).

**Files:**
- Create: `packages/db/migrations/0074_khe_uoc_vay.sql`, `packages/domain/src/loanInterest.ts` (phần `loanLongTermPart`), `apps/api/src/modules/loans/loans.ts`, `apps/api/src/modules/loans/routes.ts`
- Modify: `apps/api/src/modules/reporting/financial.ts` (phần dài hạn 341x theo khế ước), `apps/api/src/modules/ledger/openingBalance.ts` (cột `contractCode` cho 341x/335), `apps/api/src/modules/orders/*` (danh sách `/api/contracts` loại trừ `loan`), `apps/api/src/app.ts`
- Test: `apps/api/test/loans/loans.test.ts`, `packages/domain/test/loanInterest.test.ts`, `apps/api/test/financial.test.ts`

**Interfaces:**
- `contract.kind` thêm `'loan'` (định nghĩa lại CHECK). `loan_term(contract_id PK, tenant_id, principal_account_code text DEFAULT '3411', interest_expense_account_code text DEFAULT '635', interest_payable_account_code text DEFAULT '335', day_basis int CHECK (IN (360,365)) DEFAULT 365, purpose text)`; `loan_rate(id, contract_id, valid_from date, annual_rate numeric(9,6) CHECK (>= 0))` `UNIQUE(tenant_id, contract_id, valid_from)`; `loan_installment(id, contract_id, due_date, principal numeric(20,4) CHECK (> 0), note)`. `opening_balance` thêm `contract_id` (khóa ngoại tổng hợp; chỉ mục duy nhất định nghĩa lại có `contract_id`).
- `domain/loanInterest.ts`: `export function loanLongTermPart(outstanding: string, repaidTotal: string, installments: { dueDate: string; principal: string }[], reportDate: string, maturity: string | null): string` — phân bổ số đã trả vào kỳ trả sớm nhất trước; phần còn của kỳ trả hạn ≤ `reportDate + 12 tháng` (kể cả quá hạn) là ngắn hạn; dài hạn = `max(0, outstanding − ngắn hạn)`; không có lịch: dài hạn = `outstanding` nếu `maturity > reportDate + 12 tháng`, không thì 0.
- API (`loan.*`): CRUD `/api/loans` (thân: mã, tên, bên cho vay `partyCode`, loại tiền, hạn mức `value`, ngày ký, ngày đáo hạn `validTo`, điều khoản, `rates[]`, `installments[]`); `POST /api/loans/:id/disburse { date, amount, fxRate?, bankAccountNo? | counterAccountCode + partyCode }` → BC (có `bankAccountNo`) hoặc PKT, Có TK gốc `contract_id`, `party_id` bên cho vay, ghi sổ; `POST /api/loans/:id/repay { date, principal, interest, bankAccountNo, fxRate? }` → BN Nợ TK gốc, Nợ TK lãi phải trả (K), Có 112x; `POST /api/loans/:id/settle` → dư nợ gốc và lãi phải trả bằng 0 thì `status='terminated'`, không → 409 `LOAN_OUTSTANDING` nêu số. Giải ngân vượt hạn mức → 409 `LOAN_LIMIT`.
- B01 TT99: trong `reportData.balance` (khi `longTerm`), dòng 341x có `contract_id` loại `loan` không cộng theo `voucher_line.due_date`; thay bằng `loanLongTermPart` từng khế ước (số âm vì dư Có). Dòng 341x không khế ước giữ cách cũ.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('loanLongTermPart: vay 900tr, lịch 6 kỳ 150tr mỗi 6 tháng từ 30/06/2026, đã trả kỳ 30/06/2026 (dư 750tr), ngày báo cáo 31/12/2026: ngắn hạn 450tr (31/12/2026, 30/06/2027, 31/12/2027), dài hạn 300tr', () => {});
it('đã trả ba kỳ (gồm trả trước kỳ 30/06/2027, dư 450tr): ngắn hạn 150tr (kỳ 31/12/2027), dài hạn 300tr', () => {});
it('giải ngân 1.000.000.000 qua TK ngân hàng: BC Nợ 1121 / Có 3411 contract VAY01; vượt hạn mức → 409 LOAN_LIMIT', async () => {});
it('B01 TT99 31/12/2026: vay dài hạn VAY01 theo lịch trả, không theo due_date dòng', async () => {});
it('số dư đầu kỳ 3411 có contractCode VAY01: DK dòng có contract_id; B01 đầu năm tách theo lịch', async () => {});
it('tất toán khi còn dư nợ → 409 LOAN_OUTSTANDING', async () => {});
```

- [ ] **Step 2–4:** FAIL → cài đặt → PASS (`pnpm -F @kt/domain test -- test/loanInterest.test.ts`, `pnpm -F @kt/api test -- test/loans/loans.test.ts test/financial.test.ts`), cả bộ api xanh.
- [ ] **Step 5:** Commit `feat(api): khế ước vay, giải ngân, trả nợ, lịch trả gốc và tách ngắn/dài hạn B01`.

### Task 10: Lãi vay tự động theo kỳ (LV)

Model: **opus**.

**Files:**
- Create: `apps/api/src/modules/loans/interest.ts`
- Modify: `packages/domain/src/loanInterest.ts` (`dailyInterest`), `apps/api/src/modules/loans/routes.ts`
- Test: `packages/domain/test/loanInterest.test.ts`, `apps/api/test/loans/interest.test.ts`

**Interfaces:**
- `export function periodInterest(a: { from: string; to: string; balances: { date: string; balance: string }[]; rates: { validFrom: string; annualRate: string }[]; dayBasis: 360 | 365; decimals: 0 | 2 }): string` — `balances` là dư nợ cuối ngày theo từng ngày thay đổi (bậc thang), quy ước 8.
- `export async function runLoanInterest(trx, ctx: { tenantId; userId; canBackdate }, input: { fiscalYear; periodNo }): Promise<{ runId: string; voucherId: string | null; reversedVoucherIds: string[]; unchanged: boolean; lines: { loanCode: string; interest: string; interestVnd: string }[] }>` — dùng `period_run` kind `loan_interest`, quy ước 6 và 9, khuôn chạy lại của Task 4; mỗi khế ước `active` có lãi khác 0 một cặp dòng (bảng hợp đồng). Khế ước ngoại tệ: dòng Có 335 có nguyên tệ và tỷ giá ngày `P.to` theo loại tỷ giá nợ phải trả của chế độ; thiếu tỷ giá → 409 `FX_RATE_MISSING`.
- Route: `POST /api/loan-runs { fiscalYear, periodNo }` (`loan.run`), `GET /api/loans/:id/interest-preview?from&to` (lãi dự tính theo lịch trả cho màn hình).

- [ ] **Step 1: Kiểm thử thất bại (số tính tay):**

```ts
it('giải ngân 1.000.000.000 ngày 11/01, lãi 9%/năm, 365: lãi tháng 1 = round(1e9 × 0,09 × 21/365) = 5.178.082', async () => {});
it('lãi suất đổi 9% → 10% từ 16/02, trả 200tr ngày 20/02: lãi tháng 2 tính bậc thang đúng tay', () => {});
it('chạy lại tháng 1 không đổi → unchanged; ghi lùi giải ngân thêm ngày 25/01 → chạy lại đảo LV cũ sinh mới', async () => {});
it('khế ước USD 100.000 lãi 6%, 360, tỷ giá 31/01 25.000: Có 335 nguyên tệ 500,00 (30 ngày từ 02/01), VND 12.500.000', async () => {});
it('chạy tháng 3 khi tháng 2 chưa chạy mà có dư nợ → 409 PERIOD_RUN_GAP', async () => {});
```

- [ ] **Step 2–4:** FAIL → cài đặt → PASS, cả bộ api xanh.
- [ ] **Step 5:** Commit `feat(api): tính lãi vay tự động theo kỳ bằng chứng từ LV`.

### Task 11: Màn hình khế ước vay và sổ theo dõi khế ước

Model: sonnet.

**Files:**
- Create: `apps/web/src/pages/Loans.tsx`, `apps/api/src/modules/loans/reports.ts`, `apps/web/e2e/khe-uoc.spec.ts`
- Modify: `apps/api/src/modules/loans/routes.ts`, `apps/web/src/router.tsx` (menu "Khế ước vay" `/khe-uoc`)
- Test: `apps/api/test/loans/loanReports.test.ts`

**Interfaces:**
- `GET /api/loans/report?from&to` (`READ_SNAPSHOT`, `report.view`): mỗi khế ước: dư nợ đầu kỳ, giải ngân, trả gốc, dư nợ cuối kỳ (nguyên tệ và VND), lãi phải trả đầu kỳ, lãi dự tính (LV), lãi đã trả, lãi phải trả cuối kỳ, kỳ trả gốc kế tiếp; tổng VND khớp số dư 341x/335 có `contract_id` (kiểm thử). Xuất Excel.
- Màn hình: danh sách, form khế ước (tab Điều khoản, Lãi suất `KeyboardGrid`, Lịch trả gốc `KeyboardGrid` với nút "Sinh lịch đều" (số kỳ, chu kỳ tháng), Chứng từ), nút Giải ngân, Trả nợ, Tất toán; tab báo cáo "Sổ theo dõi khế ước vay".

- [ ] **Step 1:** Kiểm thử API báo cáo + `khe-uoc.spec.ts` (tạo khế ước, giải ngân, xem sổ) → FAIL.
- [ ] **Step 2–3:** Cài đặt → PASS (`pnpm -F @kt/api test -- test/loans/loanReports.test.ts`, `pnpm -F @kt/web exec playwright test e2e/khe-uoc.spec.ts`).
- [ ] **Step 4:** Commit `feat(web): màn hình khế ước vay và sổ theo dõi khế ước`.

### Task 12: Quy trình cuối kỳ có thứ tự

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0075_quy_trinh_cuoi_ky.sql`, `apps/api/src/modules/ledger/periodClose.ts`, `apps/web/src/pages/PeriodClose.tsx`, `apps/web/e2e/cuoi-ky.spec.ts`
- Modify: các route chạy hiện có để ghi nhật ký (`invoices/routes.ts` phân bổ doanh thu, `inventory` giá vốn, `cash` tỷ giá xuất quỹ và đánh giá lại, `tax` khấu trừ thuế, `ledger/closing.ts` kết chuyển), `apps/web/src/router.tsx` (Sổ cái → "Quy trình cuối kỳ" `/so-cai/cuoi-ky`, đặt đầu nhóm)
- Test: `apps/api/test/periodClose.test.ts`

**Interfaces:**
- `period_close_log(id, tenant_id, fiscal_year, period_no, step text, ran_at timestamptz DEFAULT now(), user_id, ok boolean, summary jsonb)`; chỉ mục `(tenant_id, fiscal_year, period_no, step, ran_at DESC)`.
- `export const CLOSE_STEPS = [{ key: 'tool', name: 'Phân bổ công cụ dụng cụ', permission: 'asset.run' }, { key: 'prepaid', name: 'Phân bổ chi phí trả trước', permission: 'asset.run' }, { key: 'depreciation', name: 'Khấu hao TSCĐ', permission: 'asset.run' }, { key: 'loan_interest', name: 'Lãi vay', permission: 'loan.run' }, { key: 'amortization', name: 'Phân bổ doanh thu nhận trước', permission: 'amortization.run' }, { key: 'costing', name: 'Tính giá vốn', permission: 'costing.run' }, { key: 'fx_outflow', name: 'Tỷ giá xuất quỹ', permission: 'fx.run' }, { key: 'fx_revaluation', name: 'Đánh giá lại ngoại tệ', permission: 'fx.run', optional: true }, { key: 'vat_offset', name: 'Khấu trừ thuế GTGT', permission: 'tax.offset' }, { key: 'closing', name: 'Kết chuyển', permission: 'closing.run' }] as const`.
- `export async function logCloseStep(trx, ctx, a: { fiscalYear; periodNo; step; ok; summary })` — mọi route chạy bước (kể cả qua màn hình cũ) gọi sau khi chạy xong.
- `export async function closeStatus(trx, fiscalYear, periodNo): Promise<{ steps: { key; name; status: 'done' | 'rerun' | 'pending' | 'skipped_empty'; lastRunAt: string | null; reason: string | null }[]; nextStep: string | null }>` — `done`: có nhật ký `ok`; `rerun`: một bước đứng trước có nhật ký muộn hơn, hoặc (`tool|prepaid|depreciation`) `assetRunStale`, (`costing`) kho còn "chưa cập nhật" trong kỳ (`stock_cost_state.stale_from ≤ P.to`); `pending`: chưa chạy; `nextStep` = bước đầu tiên không `done`.
- `POST /api/period-close/run { fiscalYear, periodNo, step }` gọi hàm chạy của từng bước (kiểm quyền của bước, 403 `FORBIDDEN` nêu quyền), ghi nhật ký, trả kết quả + trạng thái mới; `GET /api/period-close/:year/:period`.
- Màn hình: chọn kỳ; danh sách bước theo thứ tự với trạng thái (đã chạy / cần chạy lại / chưa chạy), thời điểm, người chạy, số chứng từ (mở chứng từ); nút "Chạy bước tiếp theo" (F9) và "Chạy lại" từng bước; bước tùy chọn có thể bỏ qua.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('kỳ mới: nextStep = tool; chạy tool, prepaid, depreciation → ba bước done', async () => {});
it('chạy lại tool sau depreciation → depreciation có status rerun, reason nêu bước trước chạy sau', async () => {});
it('ghi lùi chứng từ Nợ 2111 tài sản vào kỳ sau khi khấu hao → depreciation rerun', async () => {});
it('chạy kết chuyển qua /api/closing/run-all vẫn ghi nhật ký bước closing', async () => {});
it('người thiếu loan.run chạy bước loan_interest → 403 FORBIDDEN nêu quyền', async () => {});
```

- [ ] **Step 2–4:** FAIL → cài đặt → PASS (`pnpm -F @kt/api test -- test/periodClose.test.ts`, `pnpm -F @kt/web exec playwright test e2e/cuoi-ky.spec.ts`).
- [ ] **Step 5:** Commit `feat(api): quy trình cuối kỳ có thứ tự và trạng thái từng bước`.

### Task 13: Báo cáo và sổ TSCĐ, CCDC, chi phí trả trước

Model: sonnet.

**Files:**
- Create: `apps/api/src/modules/assets/reports.ts`, `apps/api/src/modules/reporting/print/assetForms.ts` (phần sổ), `apps/web/src/pages/AssetReports.tsx`, `apps/web/e2e/bao-cao-tai-san.spec.ts`
- Modify: `apps/api/src/modules/assets/routes.ts`, `apps/web/src/router.tsx` (Tài sản → "Báo cáo tài sản")
- Test: `apps/api/test/assets/assetReports.test.ts`

**Interfaces (mọi báo cáo `READ_SNAPSHOT`, `report.view`, có xuất Excel và in):**
- `GET /api/asset-reports/register?kind=fixed&from&to` — Sổ tài sản cố định (S21-DN / S09-DNN): theo loại tài sản, từng tài sản: ghi tăng (chứng từ, ngày, nguyên giá), khấu hao (năm sử dụng, tỷ lệ %/năm = 1200 / life_units, số khấu hao lũy kế đến khi ghi giảm), ghi giảm (chứng từ, ngày, lý do). Số lấy từ `fn_asset_values_at` và dòng sổ cái theo `asset_id`.
- `GET /api/asset-reports/card/:id?to` — Thẻ TSCĐ (S23-DN / S11-DNN): thông tin thẻ, dòng nguyên giá theo chứng từ, giá trị hao mòn theo năm, dụng cụ phụ tùng (bỏ trống), ghi giảm.
- `GET /api/asset-reports/by-location?from&to&departmentId` — Sổ theo dõi TSCĐ và CCDC tại nơi sử dụng (S22-DN / S10-DNN).
- `GET /api/asset-reports/depreciation-sheet?fiscalYear&periodNo` — Bảng tính và phân bổ khấu hao TSCĐ (06-TSCĐ): khấu hao kỳ trước, tăng, giảm, kỳ này, phân theo TK chi phí và bộ phận; tổng = Có 214x của KH kỳ (kiểm thử).
- `GET /api/asset-reports/movement?kind&from&to` — Báo cáo tăng giảm tài sản (quản trị): đầu kỳ, tăng, giảm, cuối kỳ (nguyên giá, hao mòn, còn lại) theo loại; dòng tổng = 211(+212+213) và 214x tại hai ngày.
- `GET /api/asset-reports/allocation-sheet?fiscalYear&periodNo` — Bảng phân bổ NVL, CCDC (07-VT) phần CCDC/CPTT theo TK chi phí.
- `GET /api/asset-reports/tool-register?kind=tool|prepaid&from&to` — Sổ theo dõi CCDC / chi phí trả trước: giá trị ban đầu, đã phân bổ, phân bổ kỳ, còn lại, số kỳ còn lại.
- In: bố cục theo văn bản gốc (đọc dòng đã nêu ở Global Constraints), "Mẫu số" chỉ khi chế độ của năm là TT99/TT133 và đã đối chiếu; ghi nguồn đối chiếu vào sổ quyết định.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('báo cáo tăng giảm: tổng còn lại cuối kỳ = số dư 2111 − 2141 tại to', async () => {});
it('06-TSCĐ kỳ 3: tổng = Có 2141 của chứng từ KH kỳ 3; dòng giảm có TS01 ghi giảm', async () => {});
it('sổ TSCĐ in TT99 có "Mẫu số S21-DN"; TT200 không có dòng Mẫu số', async () => {});
it('sổ CCDC: còn lại cuối kỳ = Σ dòng 242 có asset_id', async () => {});
```

- [ ] **Step 2–4:** FAIL → cài đặt → PASS (`pnpm -F @kt/api test -- test/assets/assetReports.test.ts`, `pnpm -F @kt/web exec playwright test e2e/bao-cao-tai-san.spec.ts`).
- [ ] **Step 5:** Commit `feat(api): sổ, thẻ, bảng khấu hao và báo cáo tăng giảm tài sản`.

### Task 14: Biên bản TSCĐ (01, 02, 04-TSCĐ) và kiểm kê tài sản, CCDC (05-TSCĐ)

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0076_kiem_ke_tai_san.sql`, `apps/api/src/modules/assets/assetCount.ts`, `apps/web/src/pages/AssetCount.tsx`, `apps/web/e2e/kiem-ke-tai-san.spec.ts`
- Modify: `apps/api/src/modules/reporting/print/assetForms.ts`, `apps/api/src/modules/assets/routes.ts`, `apps/web/src/pages/Assets.tsx` (nút in biên bản từ biến động), `apps/web/src/router.tsx`
- Test: `apps/api/test/assets/assetCount.test.ts`, `apps/api/test/assets/assetPrint.test.ts`

**Interfaces:**
- `asset_count(id, kind CHECK ('fixed','tool'), count_date, department_id NULL, members jsonb, note, status CHECK ('draft','done'))`, `asset_count_line(count_id, asset_id, book_quantity numeric(20,4), actual_quantity numeric(20,4), book_cost, book_nbv, condition text, note)`; CRUD `/api/asset-counts`, `POST /api/asset-counts/:id/fill` (điền số sổ sách tại ngày từ `fn_asset_values_at` và `asset.quantity`), `POST /:id/finish`. Chênh lệch không tự sinh chứng từ: màn hình gợi ý Ghi giảm (thiếu) hoặc Ghi tăng (thừa) qua Task 5/6.
- In: `GET /api/print/asset-event/:eventId?form=01-TSCD|02-TSCD|04-TSCD` (giao nhận: ghi tăng; thanh lý: ghi giảm lý do thanh lý; đánh giá lại), `GET /api/print/asset-count/:id` (05-TSCĐ). TT133 chỉ in mẫu có trong Phụ lục TT133 (đọc dòng 9366–9371); mẫu không có thì không in "Mẫu số".

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('kiểm kê TSCĐ 31/12: fill điền nguyên giá và giá trị còn lại tại ngày; TS thiếu hiện chênh lệch số lượng -1', async () => {});
it('in 02-TSCĐ từ biến động ghi giảm thanh lý: có nguyên giá, hao mòn đến ngày giảm, giá trị còn lại', async () => {});
```

- [ ] **Step 2–4:** FAIL → cài đặt → PASS (kiểm thử API và `kiem-ke-tai-san.spec.ts`).
- [ ] **Step 5:** Commit `feat(api): kiểm kê tài sản và in biên bản giao nhận, thanh lý, đánh giá lại TSCĐ`.

### Task 15: Soát lỗi tài sản và khế ước

Model: sonnet.

**Files:**
- Create: `packages/db/migrations/0077_soat_loi_gd4.sql`
- Test: `apps/api/test/assets/dataCheckGd4.test.ts`

**Interfaces:**
- `seed_data_check_rules` định nghĩa lại từ thân hiện hành (khuôn 0064), thêm quy tắc (cờ nhạy cảm không có):
  - `TS_THIEU_TAI_SAN` (error): dòng TK theo dõi tài sản không có `asset_id` (dữ liệu trước 0069).
  - `TS_HAO_MON_VUOT` (error): tài sản có `acc > cost` hoặc `nbv < 0` tại `$2`.
  - `TS_DA_GIAM_CON_GIA_TRI` (error): tài sản `decreased` còn `cost ≠ 0` hoặc `acc ≠ 0` sau ngày giảm.
  - `TS_KHAU_HAO_CAN_CHAY_LAI` (warning): kỳ trong `[$1,$2]` có lần chạy `depreciation|tool|prepaid` bị `assetRunStale` (cài bằng SQL tương đương; kiểm thử so khớp với hàm TypeScript như `THUE_LECH` GĐ2).
  - `KU_CHUA_TINH_LAI` (warning): khế ước có dư nợ trong kỳ đã đóng bước kết chuyển mà chưa có lần chạy `loan_interest`.
  - `KU_QUA_HAN` (warning): kỳ trả gốc quá hạn tại `$2` còn phần chưa trả (theo phân bổ của `loanLongTermPart`).

- [ ] **Step 1: Kiểm thử thất bại:** mỗi quy tắc một ca bắt lỗi và một ca sạch.
- [ ] **Step 2–4:** FAIL → migration → PASS (`pnpm -F @kt/api test -- test/assets/dataCheckGd4.test.ts test/dataCheck.test.ts`).
- [ ] **Step 5:** Commit `feat(db): soát lỗi tài sản và khế ước vay`.

### Task 16: Dữ liệu mẫu ABC có tài sản, CCDC, chi phí trả trước, khế ước

Model: sonnet (số kỳ vọng tính tay, rà soát bằng opus).

**Files:**
- Modify: `apps/api/scripts/seed-abc.ts`, `packages/db/src/seed/demo-abc.ts` (loại tài sản), `apps/api/test/sample-abc.test.ts` (danh sách TK có số dư)
- Create: `packages/db/src/seed/expected-gd4-abc.json`, `apps/api/test/assets/sample-abc-tai-san.test.ts`

**Interfaces:**
- Thêm vào ABC (FY2026) qua chính các dịch vụ API: 2 TSCĐ đầu kỳ (một đã khấu hao một phần), 1 TSCĐ mua bằng HDM tháng 2 (VAT 10%), 1 TSCĐ XDCB tháng 4, đánh giá lại tháng 6, ghi giảm thanh lý một tài sản tháng 9; 1 CCDC từ kho (PXK) phân bổ 6 kỳ, 1 CCDC mua dùng ngay ghi giảm một phần; 1 CPTT tiền thuê 12 kỳ; 1 khế ước VND có lịch trả 4 kỳ và lãi suất đổi giữa năm; chạy quy trình cuối kỳ tháng 1–12 theo thứ tự.
- `expected-gd4-abc.json`: số dư cuối năm 2111/2141/242/3411/335/635/6422/6421/811/412 và KH, PB, LV từng tháng của từng thẻ/khế ước, **tính tay**, trường `calc` ghi phép tính; người rà soát tự tính lại tối thiểu 6 mẫu (tài sản đầu kỳ, mua giữa tháng, đánh giá lại, ghi giảm, CCDC giảm một phần, lãi tháng đổi lãi suất).

- [ ] **Step 1:** `sample-abc-tai-san.test.ts` so từng số của `expected-gd4-abc.json`; B01 TT133/TT99 dòng TSCĐ (nguyên giá, hao mòn) khớp sổ; bất biến cân đối → FAIL.
- [ ] **Step 2–4:** viết seed và số kỳ vọng → PASS (`pnpm -F @kt/api test -- test/assets/sample-abc-tai-san.test.ts test/sample-abc.test.ts test/inventory/sample-abc-kho.test.ts`).
- [ ] **Step 5:** Commit `feat(db): dữ liệu mẫu ABC có tài sản, công cụ dụng cụ, khế ước vay`.

### Task 17: Bất biến 8 (tài sản và lãi vay), đo hiệu năng khấu hao

Model: sonnet.

**Files:**
- Create: `apps/api/test/invariants/inv8-tai-san.test.ts`, `apps/api/scripts/perf-assets.ts`
- Modify: `apps/api/test/invariants/helpers.ts` (`arbAssetOps`), `apps/api/package.json` (`perf:assets`), `docs/dev/hieu-nang.md`, `docs/dev/kiem-thu.md`

**Interfaces:**
- Bất biến (fast-check, `INVARIANTS=1`), chuỗi ngẫu nhiên: tạo thẻ (fixed/tool/prepaid), ghi tăng (chứng từ thường, TS), PKT ghi lùi thêm nguyên giá, chạy kỳ, chạy lại kỳ, ghi giảm (toàn bộ/một phần), hủy biến động, đánh giá lại, dừng/tiếp tục, điều chỉnh thời gian, bỏ ghi sổ chứng từ thường; với cả hai `fa_proration`:
  - (a) **tại mọi ngày cuối kỳ và ngày ngẫu nhiên**: Σ `nbv` tài sản `fixed` = số dư (211+212+213 hoặc 211x) − (2141+2142+2143); Σ `nbv` tool/prepaid = Σ dòng 242 có `asset_id`;
  - (b) chạy lại một kỳ hai lần liên tiếp: lần hai `unchanged`, sổ cái không đổi (so `fn_voucher_canonical`), đúng một `period_run` active mỗi `(kind, kỳ)`;
  - (c) không tài sản nào `acc > cost` hoặc `nbv < 0`; tài sản đã giảm có `cost = acc = 0`;
  - (d) tài sản không biến động, chạy đủ đời: tổng khấu hao = nguyên giá − hao mòn đầu;
  - (e) lãi vay: Σ LV kỳ = `periodInterest` tính độc lập từ dòng sổ cái.
- `perf:assets`: 3.000 TSCĐ + 2.000 CCDC, mỗi thẻ 2 dòng phân bổ, chạy 12 kỳ ba loại; **tiêu chí: mỗi lần chạy kỳ dưới 15 giây**, chạy lại không đổi dưới 10 giây; ghi số đo vào `docs/dev/hieu-nang.md`. Chậm thì nạp giá trị sổ cái cả kỳ bằng một truy vấn (`fn_asset_values_at`) và chèn dòng lịch theo lô.

- [ ] **Step 1:** `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants/inv8-tai-san.test.ts` FAIL (hàm sinh chưa có).
- [ ] **Step 2–4:** cài đặt → PASS; `pnpm -F @kt/api perf:assets` đạt tiêu chí.
- [ ] **Step 5:** Commit `test(api): bất biến sổ tài sản, lãi vay và đo khấu hao 5.000 thẻ`.

### Task 18: Tài liệu người dùng, rà soát toàn nhánh, kết thúc GĐ4

Model: opus (rà soát), sonnet (tài liệu), haiku (kiểm trên bản sao sạch).

**Files:**
- Create: `docs/user/giai-doan-4-tai-san-khe-uoc.md`
- Modify: `docs/TIEP-THEO.md`, `docs/NHAT-KY-TIEN-DO.md`, `docs/superpowers/plans/2026-10-23-giai-doan-4-quyet-dinh.md`, `docs/dev/kiem-thu.md`

- [ ] **Step 1:** Tài liệu người dùng: loại tài sản, thẻ, ghi tăng (mua bằng hóa đơn có mã tài sản, từ kho, XDCB…), khấu hao (chế độ theo ngày/theo tháng, phiên bản lịch, chạy lại), ghi giảm, đánh giá lại, điều chuyển, dừng; CCDC và chi phí trả trước; số dư đầu kỳ và Excel; khế ước vay, giải ngân, trả nợ, lãi vay, tất toán; quy trình cuối kỳ; sổ, báo cáo, biên bản; soát lỗi; hạn chế đã biết.
- [ ] **Step 2:** Rà soát toàn nhánh `gd3-hoan-tat..HEAD` (opus, `superpowers:requesting-code-review`): RLS, `UNIQUE` có `tenant_id`, `search_path` hàm `SECURITY DEFINER`, khóa ngoại tổng hợp, không route nào sửa dòng đã ghi, chứng từ hệ thống không sửa được qua route chung, số tính đúng tay; một đợt sửa (ghi quyết định; migration đã đẩy không sửa tại chỗ).
- [ ] **Step 3:** Kiểm trên bản sao sạch: `git clone ~/git/phanmem-ketoan.git` vào thư mục tạm, `pnpm install`, `pnpm db:migrate`, `pnpm db:seed:abc && pnpm db:seed:xyz` trên DB tạm, `pnpm lint && pnpm typecheck && pnpm test`, `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts`, `pnpm -F @kt/web e2e` (tuần tự).
- [ ] **Step 4:** Cập nhật `docs/TIEP-THEO.md` (GĐ4 xong, bàn giao GĐ5, hạn chế đã biết GĐ4, chờ người dùng: khung khấu hao, quy tắc ngày bắt đầu/thôi khấu hao), `docs/NHAT-KY-TIEN-DO.md`.
- [ ] **Step 5:** `git tag gd4-hoan-tat`, `git push origin HEAD:main --tags`.

---

## Thứ tự thực hiện

T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14 → T15 → T16 → T17 → T18.

Phụ thuộc chính: T3 trước T4; T4 trước T5–T8, T12, T13; T9 trước T10, T11; T10 và T4 trước T12; T15 sau T4, T9; T16 sau T5–T12; T17 sau T16.

| Migration | Tác vụ |
|---|---|
| 0069_quyen_gd4.sql | T1 |
| 0070_the_tai_san.sql | T2 |
| 0071_lich_khau_hao.sql | T4 |
| 0072_bien_dong_tai_san.sql | T5 (+ T6 nếu cần) |
| 0073_so_du_tai_san.sql | T8 |
| 0074_khe_uoc_vay.sql | T9 |
| 0075_quy_trinh_cuoi_ky.sql | T12 |
| 0076_kiem_ke_tai_san.sql | T14 |
| 0077_soat_loi_gd4.sql | T15 |

Migration đã đẩy là đóng băng: tác vụ sau cần sửa thì thêm migration số kế tiếp (đánh số lại bảng này khi thực hiện).

## Đối chiếu lộ trình GĐ4

| Mục lộ trình | Tác vụ |
|---|---|
| TSCĐ: thẻ, ghi tăng (mua, XDCB, góp vốn, từ kho, thuê tài chính), ghi giảm (thanh lý, góp vốn, chuyển CCDC), đánh giá lại, điều chuyển, dừng khấu hao, kiểm kê | T2, T5, T14 |
| Lịch khấu hao đường thẳng, chứng từ khấu hao hằng kỳ, lịch mới khi thay đổi | T3, T4 |
| Sổ TSCĐ, thẻ TSCĐ, bảng tính và phân bổ khấu hao, tăng giảm, kiểm kê | T13, T14 |
| CCDC và chi phí trả trước: ghi tăng (mua dùng ngay, từ kho, từ TSCĐ), giảm, điều chuyển, điều chỉnh, kiểm kê, phân bổ nhiều kỳ theo bộ phận/vụ việc/khoản mục, sổ theo dõi | T2, T4, T6, T13, T14 |
| Khế ước vay: hợp đồng, giải ngân, lịch trả gốc/lãi, lãi vay tự động, tất toán, báo cáo | T9, T10, T11 |
| Số dư đầu kỳ TSCĐ/CCDC/chi phí trả trước; nhập Excel | T8 (khế ước đầu kỳ: T9) |
| Quy trình cuối kỳ có thứ tự với trạng thái | T12 |
| Tiêu chí: giá trị còn lại tổng = 211 − 214 mọi ngày; chạy lại khấu hao không trùng | quy ước 1–2, T4, T17 |
| Bàn giao: `asset_id` khóa ngoại, mở khóa TK TSCĐ ở số dư đầu kỳ, khuôn chứng từ tự động, ghi tăng từ kho qua PXK, `due_date` khế ước cho B01 | T2, T8, T4, T2, T9 |

Ngoài phạm vi (ghi hạn chế): khấu hao số dư giảm dần và theo sản lượng (GĐ7 theo lộ trình), BĐS đầu tư (217/2147), tài sản sinh học (215), khung thời gian khấu hao (chờ văn bản), khế ước cho vay (1283), lãi nhập gốc.

## Self-Review (đã chạy)

1. **Phủ đặc tả:** mọi dòng lộ trình GĐ4 có tác vụ (bảng trên). Đặc tả mục 6 "`schedule_line(date, amount, accumulated, voucher_id)`; đổi nguyên giá/thời gian sinh lịch mới, lịch cũ giữ nguyên" → `asset_schedule` + `asset_schedule_line.run_id` (chứng từ qua `period_run.voucher_id`), phiên bản bị thay giữ nguyên dòng. Mục 9 Danh mục "Loại TSCĐ/CCDC, nguồn vốn, lý do tăng giảm, tham số khấu hao/phân bổ gắn TK chi phí/bộ phận/vụ việc" → T2 (`asset_category`, `capital_source`, lý do là enum ở T5/T6, phân bổ). Khế ước vay như "đối tượng" (mục 9) → khế ước là `contract` loại `loan` có bên cho vay là đối tượng.
2. **Bước mơ hồ:** T4 và T5 chạm cùng `periodRun.ts`; T5 thêm đọc cửa sổ hoạt động từ biến động (nêu ở Files). T6 có thể không cần migration (dùng `asset_event` của T5).
3. **Nhất quán kiểu:** `periodUnits`/`buildSchedule`/`splitByRatio`/`futurePeriods` (T3) dùng ở T4–T6; `runAssetPeriod`/`refreshRuns`/`assetRunStale` (T4) dùng ở T5, T6, T12, T15; `period_run` (T4) dùng ở T10, T12; `loanLongTermPart` (T9) dùng ở T15; `periodInterest` (T10) dùng ở T17; `fn_asset_values_at` (T4) dùng ở T8, T13, T14, T15, T17.
4. **Review Focus:** 5 mục có kiểm thử ở T4/T12/T15, T5, T4/T17, T8, T9/T10.
5. **Tỷ lệ:** 18 tác vụ, mã chỉ ở chữ ký và kiểm thử; thân SQL/TypeScript để người thực hiện viết theo quy ước thiết kế và bảng hợp đồng ghi sổ.
