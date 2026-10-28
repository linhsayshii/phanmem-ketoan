# Review độc lập toàn sản phẩm — `main` @ `daeafe7` (2026-10-28)

Phạm vi: GĐ0–GĐ6 và GĐ7 một phần sau hợp nhất. Chỉ đọc mã (trục 3, 5, 6 có chạy catalog Postgres/migrate/bất biến trên DB tạm). Không chạy e2e, không chạy bộ test đầy đủ. Không sửa mã.
Cách làm: 8 trục, mỗi trục một reviewer (Opus: 1–4; Sonnet: 5–8). Người tổng hợp đọc lại mã cho các phát hiện được đánh dấu **[đã xác minh]**; còn lại là kết quả của reviewer, chưa đọc lại.

## 1. Tóm tắt

| Trục | Nghiêm trọng | Cao | Trung bình | Thấp |
|---|---|---|---|---|
| 1 Toàn vẹn sổ cái | 0 | 0 | 1 | 4 |
| 2 Tiền, làm tròn | 0 | 0 | 3 | 7 |
| 3 Đa công ty, bảo mật | 0 | 4 | 3 | 3 |
| 4 Pháp lý | 0 | 4 | 6 | 6 |
| 5 Migration | 0 | 1 | 1 | 5 |
| 6 Kiểm thử | 0 | 4 | 5 | 4 |
| 7 Giao diện, tài liệu | 0 | 6 | 14 | 9 |
| 8 So sánh MISA/Fast/SUNSOFT | xem ma trận 157 nghiệp vụ ở phụ lục H | | | |

Không có lỗi nghiêm trọng (mất toàn vẹn sổ cái, rò chéo công ty). Điểm tốt đã kiểm: RLS + FORCE, UNIQUE có `tenant_id`, khóa ngoại tổng hợp, `search_path` của hàm DEFINER đều đạt trên catalog; không float trên đường tính tiền; không số pháp lý viết cứng; hợp nhất GĐ6/GĐ7 không làm mất bản sửa của hàm nào; migrate từ DB trống/nâng cấp/thứ tự ngược đều chạy, khoảng trống 0112–0199 không làm runner lỗi; 0001–0015 không đổi; bất biến 1–10 xanh (11 tệp, 28 test, 253 giây) sau `pnpm install --frozen-lockfile`.

Gốc lỗi lặp lại nhiều nhất: **phạm vi chi nhánh GĐ7 chỉ có RLS trên `voucher`** (trục 1 P1, trục 3 C1/C2/M1, trục 5 #1) và **quét cờ nhạy cảm chưa phủ route GĐ7** (trục 3 C3/C4/M3/T1).

## 2. Top 10 vấn đề nặng nhất

1. **RLS chi nhánh chỉ trên `voucher`** (`0240_da_chi_nhanh.sql:42`). Thử `app.branch_scope='999'` trên ABC: `voucher`=0 nhưng `voucher_line`=759, `voucher_item_line`=72, `open_item`=113, `account_period_balance`=473. Trigger bảo vệ (`fn_line_immutable` 0097:35-36, `fn_check_voucher_balance` 0042:34, `fn_voucher_child_guard` 0080:95,99) "cho qua" khi không thấy chứng từ. Mức cao (trục 5 #1; trục 1 P1 trung bình vì chưa thấy đường API commit được).
2. **API mobile và analytics lộ số cả công ty cho người giới hạn chi nhánh** — `approval/mobile.ts:65-76`, `budget/analytics.ts:73-96`; `branchRouteDenied` (`branch/scope.ts:25`) chỉ chặn `/api/reports/*`. Cao (trục 3 C1, C2). **[đã xác minh một phần: route không bị chặn; chưa chạy thử]**
3. **Ngân sách lộ lương từng nhân viên** cho người thiếu `view_salary` — `budget/actuals.ts:23-37` gọi `assertSensitive` không kèm `salary`; lập dòng tiền tố 334/111 rồi drill `/lines/:id/entries`. Cao (trục 3 C3). **[đã xác minh]**
4. **Nhật ký kiểm toán lộ giá vốn và công nợ** — `audit/routes.ts:10,41-44` chỉ lọc `cost_run`, `project_alloc_run`; `voucher_item_line.unit_cost`, `opening_stock`, `costing_run`, `settlement`, số dư 131/331 vẫn hiện; vai trò `ketoan_vien`, `xem` có `audit.view`. Cao (trục 3 C4). **[đã xác minh]**
5. **Thuế suất 8% không hết hạn** — `0037_khu_trung.sql:53`, `einvoice/doc.ts:14`: phát hành HĐĐT 8% sau 31/12/2026 không bị chặn; hóa đơn đã cấp mã không hủy được. Cao (trục 4 C2).
6. **Cổng pháp lý `false` bị lách** — `01GTGT_TT89_rate8` chỉ cảnh báo, vẫn chốt và ký (`vatReturn.ts:72`, `signing/sessions.ts:85-90`); XML `verified=false` vẫn ký được; TT200 `ready: true` dù chưa đối chiếu (`core/regimes.ts:10`), tạo được năm 2026 theo TT200 (`fiscalYears.ts:11-35`). Cao (trục 4 C3, C4).
7. **"Mẫu số" BCĐSPS TT133 sai** — `reporting/print/forms.ts:18` in S06-DNN, trùng số sổ chi tiết vật liệu (`forms.ts:37`). Cao (trục 4 C1).
8. **Không có test chi nhánh × lương/giá thành; vá `daeafe7` chỉ thêm cờ để test xanh; giá thành `ratio`/`order`/dở dang tương đương chỉ test ở domain; hợp nhất chi nhánh chỉ test kịch bản cân** (`internalNet=0`). Cao (trục 6 F1–F4).
9. **UX nhập liệu**: Ctrl+S chết khi con trỏ ở ô lưới (`OpeningStock.tsx:62`, `AssetOpening.tsx:67`, `useHotkeys.ts:15`), form Enter-để-lưu không chặn IME Telex/VNI (`Contracts.tsx:63`, `Loans.tsx:52`, `PayrollProfiles.tsx:42`, `PayrollRuns.tsx:51`), không chặn rời trang khi chưa lưu (`useUnsavedChanges.ts:4-5`). Cao (trục 7 C1–C3).
10. **Khoảng trống nghiệp vụ so MISA**: không có đường di trú (chuyển số dư TT200→TT99, nhập từ MISA); lương/TNCN chưa dùng ngay được (tham số chưa có, 05/KK và 05/QTT trả 409); thiếu 01/GTGT TT80, GTGT trực tiếp, 02/GTGT, 03-1A; không có dự phòng nợ khó đòi 229x; thiếu B09, B03a, TT200 không có định nghĩa báo cáo riêng (trục 8).

Mức trung bình đáng kể khác: `QĐ 1107` chưa có migration hòa giải nên kế toán viên có `budget.approve` (trục 3 M2); kiểm vượt ngân sách và quỹ âm lúc ghi sổ chạy dưới RLS chi nhánh (M1); bảng lương có cột khấu trừ `round>0` làm chứng từ lệch Nợ/Có (`payroll/post.ts:94-106`, trục 2 TB1); đợt hợp đồng theo tỷ lệ không dồn phần dư, vượt giá trị 1 đồng (`contracts/milestone.ts:106`, TB2); Sổ TSCĐ in khấu hao năm từ tỷ lệ đã làm tròn 14,29% (142.900.000 so với 142.857.143, `assets/reports.ts:40,68`, TB3).

## 3. Khuyến nghị thứ tự sửa

1. **Đợt bảo mật chi nhánh/cờ (1–2 ngày):** thêm RLS `branch_scope` cho `voucher_line` và bảng con/sổ phụ (hoặc chặn route đọc chúng); thêm `/api/mobile/v1/reports/`, `/api/analytics` vào logic chặn chi nhánh hoặc truyền `branch`; sửa `budget/actuals.ts` + `copyFromActual` dùng `withSalary`; mở rộng lọc `audit/routes.ts` (`voucher_item_line`, `opening_stock`, `costing_run`, `landed_cost_alloc`, `settlement`, `opening_balance` 131/331) ; migration hòa giải `budget.approve` (QĐ 1107); mở rộng `sensitiveSweep.test.ts:36` sang `/api/budgets`, `/api/analytics`, `/api/approvals`, `/api/mobile/v1`, `/api/reports/consolidated`, `/api/audit`. Kèm test chi nhánh × lương/giá thành (F1, F2).
2. **Đợt pháp lý (nửa ngày–1 ngày, trước 01/01/2027):** chặn HĐĐT 8% sau hiệu lực; chặn chốt/ký khi cổng `false`; bỏ "Mẫu số" chưa đối chiếu (S06 TT133, S38, S03a/b-DNN, TT200, CTGS) và thêm test chặn trùng số mẫu; chặn tạo năm theo chế độ chưa `ready`.
3. **Đợt tiền/làm tròn (nửa ngày):** TB1–TB3 và T1 (làm tròn đơn hàng SQL vs TS).
4. **Đợt kiểm thử:** giá thành `ratio`/`order`/dở dang; hợp nhất lệch/ngoại tệ/doanh thu nội bộ; nâng số lần chạy inv4/inv10; thêm chiều chi nhánh cho bất biến; cố định lockfile (gói `qrcode` thiếu làm cả 11 tệp bất biến đỏ); chạy e2e Playwright (chưa chạy trong đợt review này) và bổ sung trang chưa có e2e (bảng ở phụ lục F).
5. **Đợt giao diện:** Ctrl+S/F9 trong ô lưới, chặn IME, chặn rời trang, xác nhận F9 chạy/Bỏ ghi sổ/Ctrl+Delete, Việt hóa AG Grid, che mã lỗi thô; sửa tài liệu ("bốn cờ", Insert, mục lương/giá thành cho đa chi nhánh), sửa `TIEP-THEO.md:46` ("Migration bắt đầu ở 0112" — runner sắp xếp theo tên nên nên đặt số mới sau 0250 hoặc chốt quy ước).
6. **Việc nghiệp vụ lớn (lập kế hoạch GĐ8):** di trú, tham số lương/TNCN từ văn bản gốc, TT80, dự phòng 229x, B09/B03a, TT200 định nghĩa báo cáo, hợp nhất TT202.

## 4. Phát hiện chưa kèm kết luận cuối

Các phát hiện mức trung bình/thấp dưới đây là kết quả của reviewer, chưa được đọc lại. Trục 7 ghi rõ một số mục "cần kiểm chứng" (như C4 Esc trong Modal). Trục 8 chưa chạy phần mềm: "Đầy đủ" nghĩa là có mã/route/trang, chưa kiểm đúng nghiệp vụ.

---

# Phụ lục: báo cáo chi tiết từng trục (nguyên văn)



---

## Phụ lục A — truc1-so-cai

### Trục 1: Toàn vẹn sổ cái (rà soát chỉ đọc, `main` @ daeafe7)

Phạm vi: migration 0001–0250 (thân cuối của từng hàm/trigger sổ cái), `apps/api/src/modules/ledger/*`, các bộ sinh chứng từ tự động (giá vốn, khấu hao, phân bổ, lương, giá thành, phân bổ vụ việc, đánh giá lại, tỷ giá xuất quỹ, khấu trừ thuế, lãi vay, kết chuyển), nhánh GĐ7 (0200–0250).

Tóm tắt: **0 nghiêm trọng, 0 cao, 1 trung bình, 4 thấp.** Việc hợp nhất GĐ6 + GĐ7 **không làm mất bản sửa nào** của hàm sổ cái: các migration 0200–0250 không định nghĩa lại hàm nào của sổ cái (xem mục "Đã kiểm").

---

## P1. Trigger bảo vệ sổ cái "mở cửa" khi RLS chi nhánh (GĐ7) che dòng `voucher`. Mức: **trung bình**

Bằng chứng:
- `packages/db/migrations/0240_da_chi_nhanh.sql:42-44`: chính sách `branch_scope AS RESTRICTIVE` chỉ đặt trên `voucher`. `voucher_line`, `voucher_item_line`, `voucher_invoice` vẫn chỉ lọc theo `tenant_id`.
- `packages/db/migrations/0097_doi_tuong_chi_phi.sql:35-36` (thân cuối `fn_line_immutable`): `SELECT * INTO v FROM voucher WHERE id = OLD.voucher_id; IF v.state IN ('posted','reversed','cancelled') THEN ...`. Khi không thấy chứng từ, `v.state` là NULL, hàm bỏ qua mọi kiểm tra và `RETURN COALESCE(NEW, OLD)`, nên lệnh UPDATE hoặc DELETE dòng được đi qua.
- `packages/db/migrations/0042_ghi_so_cat_phan_vung.sql:34` (thân cuối `fn_check_voucher_balance`): `IF NOT FOUND THEN RETURN;`. Kiểm cân bằng lúc COMMIT bị bỏ qua.
- `packages/db/migrations/0080_hddt.sql:95,99` (`fn_voucher_child_guard`): `IF FOUND AND v_state <> 'draft'`. Không thấy chứng từ thì cho qua.
- Cả ba hàm chạy theo quyền người gọi (không phải SECURITY DEFINER) nên chịu RLS `branch_scope`.

Kịch bản: người dùng có phạm vi chi nhánh A (phiên có `app.branch_scope = 'A'`) chạy một lệnh ghi `voucher_line ... WHERE voucher_id = X`, với X là chứng từ **đã ghi sổ** của chi nhánh B. Dòng của X vẫn thấy được vì RLS dòng chỉ lọc theo công ty, nhưng chứng từ X thì bị che. Kết quả: `fn_line_immutable` xem X như nháp nên cho xóa hoặc sửa, rồi `fn_check_voucher_balance` không thấy X nên không báo lệch. Giao dịch commit thì sổ cái đã ghi sổ bị xóa dòng hoặc lệch Nợ/Có. Bất biến "không UPDATE/DELETE dòng đã ghi sổ" lúc này chỉ còn dựa vào việc mã TS luôn đọc `voucher` trước.

Hiện tại chưa thấy đường API nào commit được:
- `updateDraftCore` và `updatePostedMeta` gọi `lockAndCheckVersion` trước, trả 404.
- `deleteDraft` (`apps/api/src/modules/ledger/vouchers.service.ts:511-512`) **xóa dòng trước** rồi mới ném `VOUCHER_NOT_FOUND`. Đường này chỉ an toàn nhờ giao dịch hoàn tác khi có lỗi. Chỉ cần một đường mới nào đó (route, worker, import) ghi dòng theo `voucher_id` mà không kiểm chứng từ trước là lỗ hổng mở ra.

Cách sửa đề xuất:
1. Trong ba hàm trên, đọc trạng thái chứng từ qua một hàm `SECURITY DEFINER SET search_path = public, pg_temp`, ví dụ `fn_voucher_state(p_id) RETURNS text`, lọc theo `tenant_id = app_tenant()` để không vượt công ty. Hoặc đổi logic: không thấy chứng từ thì `RAISE` (lỗi `LINE_IMMUTABLE` hoặc `VOUCHER_NOT_FOUND`), không mặc định cho qua. Riêng `fn_check_voucher_balance` chỉ được `RETURN` im lặng khi chứng từ thực sự đã bị xóa trong giao dịch.
2. Thêm chính sách RESTRICTIVE tương ứng cho `voucher_line`, `voucher_item_line`, `voucher_invoice`: `EXISTS (SELECT 1 FROM voucher v WHERE v.id = voucher_id)`. Cách này cũng chặn rò dòng sổ cái của chi nhánh khác qua các truy vấn đọc thẳng `voucher_line`.
3. `deleteDraft`: khóa và kiểm chứng từ trước (`SELECT ... FOR UPDATE`, không có thì 404), rồi mới xóa dòng.
4. Kiểm thử: phiên có phạm vi chi nhánh xóa hoặc sửa dòng của chứng từ chi nhánh khác bằng SQL trực tiếp phải bị lỗi.

---

## P2. Cờ phiên vượt rào (`app.unposting`, `app.state_change`, `app.locking`, `app.renumbering`) đặt được từ bất kỳ phiên `app_user` nào. Mức: **thấp** (phòng thủ nhiều lớp)

Bằng chứng:
- `0097_doi_tuong_chi_phi.sql:34`: `IF current_setting('app.unposting', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;`. Cờ này tắt hoàn toàn `fn_line_immutable`.
- `0006_khoa_ky.sql:24-50` (thân cuối `fn_voucher_before`): `v_in_proc`, `v_lock`, `v_renum` đọc từ `current_setting(...)`. Khi bật, chứng từ đã ghi sổ sửa được mọi cột, kể cả kỳ khóa cứng (với `app.locking`).
- `0080_hddt.sql:89`: `fn_voucher_child_guard` cũng bỏ qua khi `app.unposting = 'on'`.

Kịch bản: một lỗi tiêm SQL, hoặc mã mới chạy `SELECT set_config('app.unposting','on',true); DELETE FROM voucher_line WHERE voucher_id = <đã ghi sổ>`. Trigger cho qua. Nếu chứng từ vẫn cân thì không còn dấu vết `audit_event` (nhánh ghi audit nằm sau lệnh `RETURN` sớm). Hiện mã TS không đặt các cờ này (đã grep `apps/api/src`, `apps/worker/src`).

Cách sửa: chỉ các hàm thủ tục được đổi trạng thái. Có hai hướng:
- (a) Các hàm `post_voucher`, `unpost_voucher`, `reverse_voucher`, `discard_voucher`, `lock_period`, `renumber_vouchers` chuyển sang `SECURITY DEFINER` (chủ sở hữu riêng), trigger kiểm `current_user` hoặc `session_user` thay cho GUC.
- (b) GUC mang một khóa bí mật theo giao dịch: hàm thủ tục sinh `txid_current()` cộng nonce lưu trong bảng tạm mà `app_user` không ghi được.

Tối thiểu cũng nên ghi `audit_event` cả khi đi đường vượt rào.

---

## P3. Danh sách chứng từ hệ thống ở SQL lệch với TS. Mức: **thấp**

Bằng chứng:
- `apps/api/src/modules/ledger/vouchers.service.ts:321` có ghi chú yêu cầu: "Khớp danh sách source_doc_type trong unpost_voucher/discard_voucher … thêm loại mới thì sửa cả hai nơi".
- TS chặn `stocktake` (`vouchers.service.ts:338`) và `opening_balance` (`:324`) ở bỏ ghi sổ, hủy, xóa, đảo.
- SQL, thân cuối `0099_hach_toan_luong.sql:61` (`unpost_voucher`), không có `stocktake`. SQL `discard_voucher` (`0099_hach_toan_luong.sql:104-110`) không chặn `opening_balance` và không có `stocktake`.

Kịch bản: một đường gọi SQL thẳng như `stocktake.ts:188` hay `openingBalance.ts:182`, hoặc một route mới gọi `discard_voucher` mà không qua `assertNotSystemGenerated`, có thể hủy chứng từ DK nháp hoặc chứng từ điều chỉnh kiểm kê kho. Khi đó biên bản kiểm kê vẫn giữ `voucher_id` trỏ tới chứng từ đã `cancelled`, và màn Số dư đầu kỳ mất chứng từ DK mà không biết.

Cách sửa: thêm `stocktake` vào `unpost_voucher`/`discard_voucher` kèm cờ cho phép riêng, theo khuôn `app.opening_repost` mà `stocktake.ts` sẽ bật quanh lệnh của nó. Thêm kiểm `opening_balance` vào `discard_voucher`. Viết kiểm thử so khớp tự động giữa `SYSTEM_MSG` và hai danh sách SQL (đọc `pg_get_functiondef`).

---

## P4. Nhật ký `audit_event` thiếu ở một số thay đổi dữ liệu nghiệp vụ so với đặc tả. Mức: **thấp**

Bằng chứng:
- Đặc tả `docs/superpowers/specs/2026-10-19-phan-mem-ke-toan-design.md:178` yêu cầu ghi "mọi tạo/sửa/xóa/ghi sổ/bỏ ghi sổ…; lưu cả giá trị trước và sau".
- `voucher` và `voucher_line` không có `trg_audit`. Kiểm theo `audit_enable` trong 0001–0250: chỉ có `voucher_type`, `voucher_attachment`, `voucher_item_line`, `voucher_invoice`. Tạo và sửa chứng từ nháp (`insertVoucher`, `updateDraftCore` ở `vouchers.service.ts:383-447`) không ghi gì. Xóa nháp có ghi (`0004_so_cai.sql:239-240`). Quyết định GĐ2 #23 (`docs/superpowers/plans/2026-10-21-giai-doan-2-quyet-dinh.md:32`) đã coi đây là chủ ý cho dòng, nhưng phần đầu chứng từ (ngày, đối tượng, loại) cũng không được ghi.
- `fn_audit_voucher` (`0005_thu_tuc_chung_tu.sql:7-10`) cho post/unpost/reverse/discard chỉ ghi `after` (số chứng từ), không có `before` trạng thái.
- Tạo năm tài chính, tức ghi `fiscal_period` kèm **chế độ kế toán của năm** (`apps/api/src/modules/core/fiscalYears.ts:28`): `fiscal_period` không bật audit (danh sách 0001:193 không có), TS cũng không ghi. Khóa và mở khóa có ghi (`fn_period_audit`).

Kịch bản: người dùng lập phiếu chi nháp 100 triệu, sửa thành 10 triệu, rồi ghi sổ. Nhật ký chỉ có sự kiện `post`, không còn vết của số tiền ban đầu. Tạo năm 2027 với chế độ sai (TT133 thay vì TT99) cũng không để lại dấu vết người làm.

Cách sửa: bật `audit_enable('fiscal_period')` (trigger đã bỏ qua khi before = after). Với `voucher`: một trigger AFTER INSERT/UPDATE nhẹ, chỉ ghi cột đầu chứng từ khi `state = 'draft'`, hoặc ghi ở `insertVoucher` và `updateDraftCore`. Thêm `before: {state}` vào `fn_audit_voucher`. Nếu giữ quyết định #23 thì cập nhật đặc tả cho khớp.

---

## P5. Sửa chiều `project_id` hoặc `cost_object_id` của dòng đã ghi sổ sau khi đã kết chuyển theo vụ việc: không có cờ "cần chạy lại". Mức: **thấp**

Bằng chứng:
- `0097_doi_tuong_chi_phi.sql:42-43`: dòng đã ghi sổ sửa được `project_id`, `cost_object_id` (kỳ mở và khóa sổ).
- `0011_ket_chuyen.sql:25-29`: `fn_closing_sources` gom số dư theo `l.project_id` khi bước kết chuyển có `by_dimension = 'project'`. Bước KC đã chạy không được đánh dấu lỗi thời khi chiều đổi. Riêng giá thành có cơ chế này (chữ ký `input_hash`, `costing/costRun.ts:222`).

Kịch bản: KC theo vụ việc kỳ 10 đã đưa 632 của vụ việc A và B về 0. Sau đó kế toán đổi một dòng 632 đã ghi sổ (5 triệu) từ A sang B. Tổng 632 vẫn bằng 0, nhưng số dư theo vụ việc thành A = −5 triệu, B = +5 triệu sau KC. Lãi lỗ vụ việc sai mà màn Kết chuyển không báo.

Cách sửa: thêm quy tắc soát lỗi "TK đầu 5–8 còn số dư theo vụ việc sau ngày KC theo vụ việc", hoặc ghi chữ ký đầu vào vào `closing_run` và báo "Cần chạy lại" như `cost_run`.

---

## Đã kiểm, không thấy lỗi

- **Hợp nhất GĐ6 (0094–0111) và GĐ7 (0200–0250):** GĐ7 không `CREATE OR REPLACE` hàm sổ cái nào. Các migration 0200, 0210, 0220, 0230, 0250 chỉ thêm bảng, quyền, CHECK regime; 0240 chỉ thêm `fn_voucher_branch`, `fn_voucher_branch_audit` và chính sách; 0241 thêm `fn_balances_at_branch` chỉ đọc. Thân cuối các hàm như sau:
  - `fn_voucher_before`: 0006
  - `fn_line_immutable`, `fn_line_before`, `reverse_voucher`: 0097
  - `unpost_voucher`, `discard_voucher`, `seed_voucher_types`: 0099
  - `post_voucher`: 0046
  - `fn_check_voucher_balance`, `fn_build_pairs`: 0042 (0077 ghép cặp)
  - `fn_voucher_child_guard`: 0080
- Đã so thân từng bản: 0049 → 0069 → 0099 (unpost, discard) chỉ mở rộng danh sách `source_doc_type`. 0046 → 0066/0070 (vá động: `cash_flow_code`, `asset_id`) → 0097 (`reverse_voucher`) thêm `cost_object_id`, không rơi cột nào. Dòng đảo chép đủ mọi cột chiều của `voucher_line`, kể cả các cột thêm sau 0004.
- Trình chạy migration (`packages/db/src/migrate.ts:26-41`) áp các tệp còn thiếu theo thứ tự tên. Cơ sở dữ liệu đã chạy nhánh GĐ7 trước rồi mới nhận 0094–0111 thì áp lệch thứ tự, nhưng không có hàm nào bị hai nhánh cùng định nghĩa nên kết quả cuối giống nhau.
- **Máy trạng thái:**
  - Chỉ đổi `state` qua thủ tục (`STATE_CHANGE_VIA_PROC`).
  - Bỏ ghi sổ chỉ ở kỳ `open`, chưa băm, không phải chứng từ đảo; có `voucher_line_history`.
  - Đảo chỉ chứng từ `posted`, ngày ≥ gốc. Kỳ khóa cứng chặn đổi trạng thái gốc (`fn_voucher_before` nhánh ELSIF), đúng bảng 7.1.
  - Hủy chỉ nháp, giữ số. Xóa chỉ nháp chưa cấp số, có audit.
  - Chứng từ đã ghi sổ chỉ sửa được diễn giải và chiều phân tích; khóa cứng chặn hết.
- **Cân bằng:** kiểm hoãn tới COMMIT theo hàng đợi (0020/0021), chặn ghi thẳng partition (REVOKE trên partition, 0021). `posting_date` của dòng luôn bằng của chứng từ, dời partition khi đổi ngày nháp. CHECK một phía, dấu nguyên tệ (0004).
- **Khóa kỳ:** `FOR SHARE` hàng kỳ trong trigger, đua đúng với `lock_period`. Chuỗi băm có kiểm thứ tự kỳ, không còn nháp; `verify_period_hash` so cả `hash_tail`. Khóa theo phần hành được kiểm khi ghi sổ, bỏ ghi sổ, đổi ngày.
- **Chứng từ tự động** đều qua `createSystemVoucher` (số, ngày, `created_by`, `source_doc_*`) và chạy lại bằng `reverseVoucher` rồi sinh mới:
  - GV `costingRun.ts:400-415`
  - KH/PB `assets/periodRun.ts:126-135`
  - PB `invoices/amortization.ts:151-158`
  - LU `payroll/post.ts:197,211`
  - GT `costing/costRun.ts:257-261`
  - PB/GT vụ việc `contracts/projectAlloc.ts:196-201`
  - DG `cash/revaluation.ts:191-201`
  - XQ `cash/fx.ts:122-130`
  - KTT `tax/vatOffset.ts:51-55`
  - LV `loans/interest.ts:132-139`
  - KC/PB cuối kỳ `rerun_closing_step` (0011)
- Route chung chặn sửa, bỏ ghi sổ, hủy, xóa, **đảo** chứng từ hệ thống (`vouchers.routes.ts:160` `assertNotSystemGenerated`) và chặn lập tay loại KC/DK (`assertNotSystemType`). Trigger gỡ liên kết LU, GT, phân bổ vụ việc, chi lương, đợt hợp đồng (0099, 0104, 0108, 0105, 0111) chạy trên mọi đường đổi trạng thái.
- `fn_voucher_branch` (0240): chứng từ đảo nhận chi nhánh của gốc, KC về trụ sở chính. Đổi chi nhánh chứng từ đã ghi sổ bị `fn_voucher_before` chặn, có audit trước/sau. Người dùng bị giới hạn chi nhánh không có quyền kết chuyển, khóa kỳ, chạy cuối kỳ (`branch/scope.ts:16-20`).
- `audit_event` và `voucher_line_history` bị REVOKE UPDATE/DELETE với `app_user` (0001:115, 0004). Bảng mới GĐ6/GĐ7 đều `audit_enable`, trừ `payroll_line`, `payroll_line_value`, `cost_run_object`, `cost_run_output`: đây là dữ liệu tính ra, ô nhập tay lương được ghi audit thủ công (quyết định GĐ6 #667).


---

## Phụ lục B — truc2-tien-lam-tron

### Trục 2: Tiền và làm tròn (rà soát chỉ đọc, main @ daeafe7)

Phạm vi: `apps/api/src`, `apps/web/src`, `apps/worker/src`, `packages/*/src`, `packages/db/migrations`.
Tổng: **0 nghiêm trọng, 0 cao, 3 trung bình, 7 thấp.**

Bối cảnh đã xác nhận: `packages/domain/src/money.ts:3` đặt `Decimal.set({ precision: 40, rounding: ROUND_HALF_UP })` cho cả repo. Chỉ có một nơi nhập `decimal.js` (money.ts), nên mọi `toFixed`/`toDecimalPlaces` không truyền chế độ làm tròn đều là nửa xa số 0, giống `round(numeric)` của PostgreSQL. Không có `parseFloat`, `::float`, `double precision`, `real` nào trên đường tính tiền. Mọi cột tiền trong migration đều có precision (88 cột `numeric(20,0)`, 58 cột `numeric(20,4)`, 6 cột `numeric(20,10)`). `numeric` không có precision chỉ xuất hiện ở biến cục bộ và kiểu trả về của hàm plpgsql.

---

## Trung bình

### TB1. Bảng lương có cột khấu trừ làm tròn lẻ (round > 0) không hạch toán được: chứng từ lệch Nợ/Có
- `apps/api/src/modules/payroll/structures.ts:12`: cột người dùng nhận `round` 0..6, kể cả cột `deduct` có `creditAccount`. `packages/domain/src/payroll.ts:277` cũng chỉ kiểm 0..6.
- `apps/api/src/modules/payroll/post.ts:94-95`: dòng Có TK riêng nhận nguyên giá trị lẻ `v(c.code)`. `tot.other = other_withholding − routedSum`. `other_withholding` là cột dựng sẵn, `round: 0` (`payroll.ts:220`, công thức ở `payroll.ts:380,439`), còn `routedSum` vẫn lẻ.
- `post.ts:106`: mỗi dòng gom xong mới làm tròn riêng bằng `toFixed(0)`.
- Ví dụ: cột "Tạm ứng" `deduct`, `creditAccount=141`, `round=2`, một nhân viên có giá trị 100,50.
  - `other_withholding` = round0(100,50) = 101, nên Nợ 334 (khấu trừ) = 101.
  - Có 141 = toFixed(0)(100,50) = 101.
  - `tot.other` = 101 − 100,50 = 0,50, thành Có 3388 = 1.
  - Kết quả: Nợ 101 ≠ Có 102, ghi sổ bị DB chặn vì lệch, bảng lương không hạch toán được.
  - Hai nhân viên, mỗi người 100,25: Có 141 = 100 + 100, `tot.other` = 200 − 200,5 = −0,5, thành Nợ 3388 = 1. Lại lệch 1 đồng.
- Cách sửa: buộc `round = 0` cho cột `deduct`/`income` trong `validateStructure`. Hoặc ở `post.ts` làm tròn `v(c)` về đồng trước khi cộng `routedSum`, rồi để `tot.other` nhận phần dư.

### TB2. Đợt thanh toán hợp đồng theo tỷ lệ không dồn phần dư: tổng các đợt khác giá trị hợp đồng
- `apps/api/src/modules/contracts/milestone.ts:106`: mỗi đợt tính riêng `round_half_up(value × percent / 100)`. Không có bước nào để đợt cuối nhận phần dư, cũng không kiểm Σ đợt = giá trị.
- `apps/api/src/modules/contracts/tracking.ts:92`: `remainingValue = adjusted − invoiced`.
- Ví dụ: hợp đồng VND 100.000.001, hai đợt 50% và 50%. Mỗi đợt = round(50.000.000,5) = 50.000.001, tổng 100.000.002. Xuất hết hóa đơn theo đợt thì vượt giá trị hợp đồng 1 đồng, "Giá trị còn lại" = −1.
- Ví dụ khác: ba đợt 33,3333% / 33,3333% / 33,3334% trên 1.000.000.001. Các đợt ra 333.333.000 / 333.333.000 / 333.334.000, tổng 1.000.000.000, còn lại mãi 1 đồng chưa xuất.
- Cách sửa: khi tổng tỷ lệ các đợt `planned` (theo tỷ lệ) = 100%, đợt cuối (theo `seq`) nhận `value − Σ các đợt khác`. Hoặc tính lũy kế: đợt k = round(V × Σp≤k) − round(V × Σp<k).

### TB3. Sổ TSCĐ (S21-DN/S09-DNN) tính "Mức khấu hao năm" từ tỷ lệ đã làm tròn 2 chữ số
- `apps/api/src/modules/assets/reports.ts:40`: `rate = round(1200 / lifeUnits, 2)`.
- `reports.ts:68`: `annual = round(cost × rate / 100)`.
- Ví dụ: nguyên giá 1.000.000.000, thời gian 84 tháng (7 năm). Tỷ lệ in ra 14,29%, mức năm in ra 142.900.000. Khấu hao thực theo lịch (`depreciation.ts` `target`) là 1e9 × 12/84 = 142.857.143. Sổ lệch 42.857 đ/năm so với bảng tính khấu hao và sổ cái, và `totalAnnual` cộng dồn lệch theo nhóm.
- Cách sửa: `annual = round_half_up(cost × 12 / lifeUnits)`. Tỷ lệ chỉ làm tròn khi hiển thị. Nếu muốn khớp tuyệt đối thì lấy từ lịch khấu hao của năm: Σ `asset_schedule_line.amount`.

---

## Thấp

### T1. Tổng đơn hàng (SQL) và hóa đơn sinh từ đơn (TS) làm tròn khác nhau
- `apps/api/src/modules/orders/service.ts:142`: SQL làm tròn một lần, `round(q × giá × (1 − ck/100), 0)`.
- `orders/service.ts:178-180`: TS làm tròn hai lần, `gross = round(q × giá)` rồi `ck = round(gross × ck/100)`. Thành tiền = gross − ck.
- Ví dụ: q = 1, đơn giá 1.234.565, chiết khấu 10%.
  - SQL: 1.111.108,5 làm tròn thành 1.111.109.
  - TS: gross 1.234.565, ck = round(123.456,5) = 123.457, thành tiền 1.111.108.
  - Đơn hiện 1.111.109, hóa đơn 1.111.108.
- Giao từng phần thì mỗi lần làm tròn riêng, không có lần cuối nhận phần dư.
- Cách sửa: dùng một công thức chung (đề xuất công thức của TS, vì đó là số lên hóa đơn) cho cả SQL tổng đơn.

### T2. `toNumber()` trên tiền trong báo cáo tổng hợp chi phí sản xuất
- `apps/api/src/modules/costing/reports.ts:152,155`: `collected: Map<number, number>` giữ `sum(...).toNumber()`.
- `reports.ts:179`: dùng lại bằng `String(n)`.
- Tổng > 2^53 (khoảng 9e15 đ) mất chính xác. Số ≥ 1e21 thì `String` ra dạng mũ, `D()` ném lỗi. Thực tế hiếm gặp nhưng vi phạm quy tắc bất biến.
- Cách sửa: `Map<number, string>`, giữ `.toFixed(0)`.

### T3. Lãi vay ngoại tệ cố định 2 chữ số lẻ, không theo `currency.minor_unit`
- `apps/api/src/modules/loans/interest.ts:42`: `decimalsOf = VND ? 0 : 2`.
- `interest.ts:98`: `amountCurrency: interest.toFixed(2)`.
- Khế ước JPY hay KRW (đơn vị nhỏ nhất 0) sẽ có lãi lẻ 0,xx yên, khác cách `milestone.ts:90` và động cơ thuế (`tax.ts:50`) dùng `minor_unit`.
- Cách sửa: đọc `currency.minor_unit` như milestone.

### T4. Phân bổ chi phí chung vụ việc: làm tròn xuống, vụ việc cuối nhận toàn bộ phần dư
- `apps/api/src/modules/contracts/projectAlloc.ts:103`: mọi vụ việc lấy phần nguyên làm tròn xuống, vụ việc cuối theo mã nhận dư, tối đa n−1 đồng.
- Ví dụ: quỹ 100 đ cho 3 vụ việc bằng nhau ra 33 / 33 / 34. Quỹ 1.000.000.002 cho 3 vụ việc tiêu thức 1/1/1 ra 333.333.334 / 333.333.334 / 333.333.334 (đúng). Nhưng quỹ 10 đ cho 6 vụ việc bằng nhau ra 1/1/1/1/1/5.
- Tổng đúng, nhưng lệch xa phần chính xác và không nhất quán với `allocateByRatio` (phần dư lớn nhất), thứ mà lương (`payroll/post.ts:86`), TSCĐ (`assets/periodRun.ts:60`) và giá thành (`productCost.ts`) đều dùng.
- Cách sửa: thay bằng `allocateByRatio(pool, bases)`.
- Tương tự nhưng chấp nhận được: `apps/api/src/modules/invoices/amortization.ts:23,28` (doanh thu nhận trước chia đều, kỳ cuối nhận tối đa `periods−1` đồng).

### T5. Web dùng `Number()`/`Math.round` trên tiền để vẽ biểu đồ và tooltip
- `apps/web/src/pages/Analytics.tsx:17,45,48` và `apps/web/src/pages/charts.tsx:11-12`. Tooltip `full()` in số tiền đầy đủ qua `String(Math.round(n))`. Số > 2^53 mất chính xác, số ≥ 1e21 ra dạng mũ thì `D()` ném lỗi.
- Chỉ ảnh hưởng hiển thị.
- Cách sửa: tooltip in từ chuỗi gốc, còn `number` chỉ dùng cho tọa độ.

### T6. Ô nhập số tự làm tròn im lặng; `formatVnNumber` có thể in "-0"
- `packages/ui/src/VnNumberInput.tsx:8,39`: gõ "1.000,6" vào ô VND (scale 0) sẽ tự thành 1.001 mà không báo. Với ô tiền, nên báo lỗi thay vì làm tròn.
- `packages/domain/src/format.ts:5`: `D('-0.4').toFixed(0)` = "-0", nên hiển thị "-0" (`fx.ts:6` và `tax.ts:22` đã tự chặn trường hợp này, `format.ts` thì chưa).
- Cách sửa: ô có `scale=0` thì từ chối số lẻ. Trong `formatVnNumber`, đổi kết quả 0 thành `ZERO` trước khi định dạng.

### T7. `Number()` trong kiểm hợp lệ tỷ lệ, tỷ giá, mệnh giá
- `apps/api/src/modules/ledger/vouchers.service.ts:16` (tỷ giá), `cash/cashCount.ts:15` (mệnh giá), `invoices/service.ts:23` (chiết khấu ≤ 100), `core/settings.ts:30-31`.
- Regex đi trước đã giới hạn độ dài, nên các phép so sánh với 0 hoặc 100 không sai trong thực tế. Đây chỉ là vi phạm câu chữ của quy tắc.
- Cách sửa: dùng `D(s).gt(0)` cho nhất quán.

---

## Đã kiểm, không thấy lỗi
- **Khấu hao, phân bổ CCDC/CPTT** (`packages/domain/src/depreciation.ts`): dùng lũy kế mục tiêu T(c) = round(B·c/U), số kỳ = T(sau) − T(trước), nên Σ = B, không trôi. Đơn vị kỳ lấy 12 chữ số. `allocateByRatio` theo phần dư lớn nhất, đúng dấu với số âm. Ghi giảm CCDC một phần (`assets/events.ts:175`) tính theo NBV/số lượng hiện tại, giảm hết thì lấy đúng NBV. Kiểm kê tài sản (`assetCount.ts:31`) đạt.
- **Giá vốn 4 phương pháp** (`packages/domain/src/costing.ts`): `portionOf` lấy hết lớp thì lấy đúng hết giá trị. `absorbResidual` dồn phần lẻ khi tồn về 0 vào lần xuất cuối không cố định giá. Đích danh dồn theo từng lô. Đảo phiếu cùng kỳ: lần trả cuối nhận phần còn lại. Đơn giá 4 số chỉ để hiển thị, tiền tính từ giá trị.
- **Giá thành** (`packages/domain/src/productCost.ts`): dở dang làm tròn từng khoản mục, giá thành = đầu + phát sinh − cuối, chia sản phẩm bằng `allocateByRatio`, có `assertCostBalance`. Phân bổ 627 (`allocateOverhead`) có lỗi tiêu thức 0. Chia giá thành vào phiếu nhập thành phẩm (`costing/costRun.ts:310`) đạt. Tiêu thức hệ số, tỷ lệ, đơn hàng, vụ việc đạt.
- **Lắp ráp/tháo dỡ** (`stock.ts:37` `splitByRatio`, `inventory/assembly.ts:84-91`): phần cuối nhận dư. **Chi phí mua hàng** (`landedCost.ts`): làm tròn xuống rồi chia dư theo phần lẻ lớn nhất. **Nhập kho theo hóa đơn từng phần** (`inventory/stockVouchers.ts:76`): lần cuối lấy hết phần còn lại.
- **Tỷ giá** (`fx.ts` và `fn_proportional_vnd`, `0029_doi_tru.sql:104`): TS và SQL đồng nhất (chia 30 chữ số, tỷ giá 10 chữ số, nửa xa 0). Lấy hết nguyên tệ thì lấy hết VND. `fn_line_before` (0025) cho lệch ±1 đ giữa nguyên tệ × tỷ giá và VND, nên trả nợ vay ngoại tệ (`loans/loans.ts:209-229`) với dòng ngân hàng là tổng của các phần đã làm tròn vẫn hợp lệ. Chênh lệch dồn vào TK lãi/lỗ tỷ giá.
- **Lãi vay** (`loanInterest.ts` `periodInterest`): cộng tích số theo ngày, chia một lần, làm tròn một lần mỗi kỳ. Xử lý phần dư VND của lãi phải trả ngoại tệ (`interest.ts:102`) đạt.
- **Thuế GTGT** (`packages/domain/src/tax.ts`): giá gồm thuế thì cơ sở = gross − thuế. Nhiều thuế trong giá: mã cuối nhận phần còn lại. Phân bổ thuế: dòng cuối mỗi nhóm nhận phần còn lại. Chênh thuế ghi trên hóa đơn (tối đa bằng số dòng) dồn vào dòng thuế lớn nhất. Tờ khai 01/GTGT (`vatFormula.ts`) làm tròn phần phân bổ nhóm 03 một lần. TNDN (`cit.ts`, `citReturn.ts:67`) đạt.
- **Lương** (`payroll.ts`): TNCN lũy tiến làm tròn lũy kế theo bậc (Σ bậc = tổng). Bảo hiểm làm tròn từng khoản theo sàn và trần. Ngày công không làm tròn đến cột. Tách chi phí lương và bảo hiểm theo vụ việc bằng `allocateByRatio`, tổng tỷ lệ bắt buộc = 100 (`profiles.ts:59`). Các cột dựng sẵn liên quan tiền đều `round: 0`.
- **Kết chuyển** (`0023_so_do_ket_chuyen_theo_che_do.sql:60`): dòng cuối nhận `remain`.
- **Đầu vào VND:** `VND_AMOUNT_RE` `^\d{1,16}$` áp ở các schema tiền (phân bổ, khế ước, ext, tạm tính TNDN, đối trừ, landed cost, hóa đơn khai báo). Hợp đồng đợt và điều chỉnh có kiểm riêng.
- **Excel:** `excel.ts:11` chỉ ghi ô số khi đi qua `Number()` rồi đổi ngược không làm đổi giá trị.


---

## Phụ lục C — truc3-bao-mat

### Trục 3: Đa công ty và bảo mật (rà soát chỉ đọc, `main` @ `daeafe7`)

Phương pháp: đọc mã; áp toàn bộ migration 0001–0250 lên một DB tạm `ketoan_review_truc3` trên Postgres Docker cổng 5432 (đã xóa sau khi xong; DB `ketoan` không bị đụng tới) rồi truy vấn catalog (`pg_class.relrowsecurity/relforcerowsecurity`, `pg_policy`, `pg_proc.prosecdef/proconfig`, `pg_constraint`, `pg_index`, quyền của `app_user`). Không chạy bộ kiểm thử.

Tổng: **0 nghiêm trọng, 4 cao, 3 trung bình, 3 thấp.**

---

## Cao

### C1. Người dùng bị giới hạn chi nhánh xem được B01/B02 và số dư tiền của cả công ty qua API mobile
- `apps/api/src/modules/approval/mobile.ts:65-68` (`/api/mobile/v1/reports/financial/:code`) gọi `evaluateFinancialReport(...)` mà không truyền `branch`; `apps/api/src/modules/reporting/financial.ts:76` khi đó dùng `balancesAt(..., undefined)` = `fn_balances_at` (`branch/scope.ts:67-69`), tức số dư kỳ của cả công ty, không qua RLS `voucher`.
- `mobile.ts:71-76` (`/reports/cash`) gọi `cashBalanceAt` không có `bankAccountNo`, nên đi nhánh `fn_balances_at` (`cash/books.ts:36-40`): cũng là cả công ty.
- Chốt chặn `branchRouteDenied` (`plugins/auth.ts:50-53`, `branch/scope.ts:23-29`) chỉ xét `/api/reports/*` và bốn tiền tố; `/api/mobile/v1/*` không có trong đó. `report.view` lại nằm trong `BRANCH_SCOPED_PERMISSIONS` (`scope.ts:19`), nên người bị giới hạn vẫn giữ quyền này.
- Kịch bản: kế toán chi nhánh A (`user_branch_scope` = {A}, có `report.view`) đăng nhập web rồi gọi `GET /api/mobile/v1/reports/financial/B01?from=2026-01-01&to=2026-12-31` bằng cookie (khi không có header Authorization, `mobileAuth` dùng phiên, `mobile.ts:20-28`), hoặc dùng khóa API phạm vi `mobile`. Kết quả là tổng tài sản, nợ phải trả, doanh thu, lợi nhuận của cả công ty và của mọi chi nhánh khác, trong khi `/api/reports/financial/B01` cùng tài khoản đó chỉ trả số của chi nhánh A.
- Sửa: truyền `branch: effectiveBranch(req.auth!, undefined)` vào `evaluateFinancialReport`; với `/reports/cash`, tính từ dòng sổ khi có `branchScope` (giống `fn_balances_at_branch`) hoặc trả 403 `BRANCH_SCOPE_FORBIDDEN`. Thêm `/api/mobile/v1/reports/` vào logic chặn và thêm ca kiểm thử vào `test/branches.test.ts`.

### C2. `/api/analytics/overview` lộ số dư tiền, phải thu, phải trả và hệ số tài chính của cả công ty cho người bị giới hạn chi nhánh
- `apps/api/src/modules/budget/routes.ts:68` chỉ đòi `report.view`; tiền tố `/api/analytics` không bị `branchRouteDenied` chặn.
- `budget/analytics.ts:73-77` đọc tiền, phải thu, phải trả từ `fn_balances_at` (cả công ty). `analytics.ts:92-96` tính hệ số từ `evaluateFinancialReport` không có `branch`. Doanh thu/chi phí (`analytics.ts:67-70`) thì lại join `voucher`, nên bị RLS lọc theo chi nhánh: các số trên cùng một màn hình lệch phạm vi nhau.
- Kịch bản: người dùng chi nhánh A gọi `GET /api/analytics/overview?year=2026`, thấy `cash/receivable/payable` theo tháng của toàn công ty (có cờ thì thấy cả `ratios`).
- Sửa: với `branchScope` khác null, hoặc dùng `fn_balances_at_branch` + `branch` cho B01/B02, hoặc thêm `/api/analytics` vào `COMPANY_WIDE_ROUTES`.

### C3. Ngân sách lộ số lương từng nhân viên cho người thiếu `view_salary`
- `apps/api/src/modules/budget/actuals.ts:23-37`: `hiddenPrefixes` và `assertPrefixesViewable` gọi `assertSensitive(auth, { code, subledger_kind })` mà **không có `salary`**. Trong `packages/domain/src/permissions.ts:13-17`, cờ `view_salary` chỉ được đòi khi `acc.salary === true`, nên tài khoản lương (334, 3383…) không bao giờ bị che ở đây. Sổ sách thì tính cờ này qua `isSalaryCode` (`reporting/financial.ts:236`, `payroll/accounts.ts:16-20`).
- `budget/routes.ts:25`: `copyFromActual` cũng lọc bằng `sensitiveDenial(req.auth!, a)` không có `salary`.
- `actuals.ts:73-84` (`budgetDrill`) trả từng dòng sổ: số tiền, diễn giải, số chứng từ.
- Kịch bản: kế toán viên thiếu `view_salary` (vai trò mặc định có `budget.*` theo 0220 và có `report.view`) làm như sau: `POST /api/budgets {fiscalYear:2026, name:'x', lines:[{accountPrefix:'334', months:[...0]}]}`, rồi `GET /api/budgets/:id/lines/:lineId/entries?month=10`. Kết quả là từng dòng 334 của chứng từ LU, mỗi nhân viên một dòng (lương, khấu trừ). Làm tương tự với tiền tố `111` hoặc `112` thì thấy thực lĩnh từng người trên phiếu chi lương; sổ sách đã che đúng phần này (`test/sensitiveSweep.test.ts:153-168`). `GET /api/budgets/:id/report` thì trả tổng 334 theo tháng.
- Sửa: dựng tài khoản bằng `withSalary(regime, accs)` trước khi gọi `assertSensitive` ở `hiddenPrefixes`, `assertPrefixesViewable` và `copyFromActual`. Ở drill, khi thiếu `view_salary` thì áp cùng cách che dòng lương như `accountDetail(..., hideSalary)`, vì dòng 111/112 của phiếu chi lương cũng lộ số. Thêm `/api/budgets` và `/api/analytics` vào phạm vi `sensitiveSweep` (xem T1).

### C4. Nhật ký kiểm toán lộ giá vốn và công nợ cho người thiếu `view_cost`, `view_receivable`, `view_payable`
- `apps/api/src/modules/audit/routes.ts:10,41-44`: khi thiếu `view_cost`, route chỉ bỏ `cost_run` và `project_alloc_run`. Các bảng sau vẫn có `trg_audit` (kiểm trên catalog) và mang giá vốn: `voucher_item_line` (`unit_cost`, `stock_value`, `fixed_cost`, `landed_cost_out`), `opening_stock.value`, `costing_run.summary`, `landed_cost_alloc.amount`. Với `view_receivable` và `view_payable`, route không lọc gì: `settlement`, `opening_balance` (131/331) và các sự kiện `voucher_line` trên 131/331 đều hiện nguyên trước/sau.
- `audit.view` có sẵn trong vai trò mặc định `ketoan_vien` (danh sách loại trừ của `create_tenant`, `packages/db/migrations/0094_quyen_gd6.sql:47-52`, không có `audit.view`) và `xem` (`%.view`, `0094_quyen_gd6.sql:56`).
- Kịch bản: người dùng vai trò "Chỉ xem" không có `view_cost` gọi `GET /api/audit?entity=voucher_item_line&size=500` và đọc `after.unit_cost` của mọi phiếu xuất sau mỗi lần tính giá vốn. Gọi `?entity=opening_stock` thì thấy giá trị tồn đầu kỳ, trong khi `GET /api/vouchers/:id` của cùng chứng từ đã che (`redactCost`).
- Sửa: mở rộng `COST_AUDIT_ENTITIES` (`voucher_item_line`, `opening_stock`, `costing_run`, `landed_cost_alloc`, `stock_cost_layer` nếu có audit), hoặc che các trường giá trị. Thêm nhánh lọc cho `view_receivable` và `view_payable` (`settlement`, `opening_balance` theo `account_id` có `subledger_kind`, `voucher_line` 131/331), giống cách đang làm với lương ở `audit/routes.ts:23-39`.

---

## Trung bình

### M1. Kiểm soát lúc ghi sổ (vượt ngân sách, quỹ âm) tính dưới RLS chi nhánh nên bị lách hoặc chặn nhầm; `/api/cash/balance` trả số dư cả công ty
- `cash/books.ts:263-269`: `postWithCashCheck` gọi `budgetCheck` trong giao dịch của người dùng. `budget/alert.ts:31-58` dựa vào `actualMatrix`, mà `actuals.ts:12-17` (`matchFrom`) join `voucher`. Với người bị giới hạn chi nhánh, RLS `branch_scope` chỉ để lại chứng từ trong phạm vi của họ, nên số "đã thực hiện" của ngân sách cả công ty bị tính thiếu. Kịch bản: công ty bật `blockPct=100`, chi nhánh khác đã tiêu gần hết ngân sách 642; kế toán chi nhánh A ghi sổ Phiếu chi 642 vẫn qua, vì phần A nhìn thấy chưa tới ngưỡng.
- Kiểm tra quỹ âm (`books.ts:229-237`) trộn hai nguồn: số dư gốc lấy từ `fn_balances_at` (cả công ty), phần phát sinh sau ngày thì join `voucher` (chỉ chi nhánh). Riêng tài khoản ngân hàng thì cả hai phần đều chỉ của chi nhánh (`books.ts:238-245`). Vì vậy cảnh báo hoặc chặn `cash_negative` sai với tài khoản tiền dùng chung, và câu báo "âm X đ" để lộ số dư của cả công ty.
- `cash/routes.ts:27-30` (`GET /api/cash/balance`, quyền `voucher.view`, nằm trong danh sách quyền được giữ khi bị giới hạn): không có `bankAccountNo` thì `cashBalanceAt` dùng `fn_balances_at`, tức tồn quỹ 111 của cả công ty.
- Sửa: chạy `budgetCheck` và các phép kiểm số dư trong một ngữ cảnh không có `app.branch_scope` (đặt lại biến phiên thành rỗng ngay trước kiểm tra rồi trả lại), hoặc tính bằng hàm `SECURITY DEFINER` chỉ trả kết quả đạt/không đạt. Với `/api/cash/balance`, khi có `branchScope` thì tính theo dòng của chi nhánh hoặc trả 403.

### M2. QĐ 1107 chưa có migration hòa giải: kế toán viên tự lập và tự duyệt được ngân sách
- `packages/db/migrations/0220_ngan_sach.sql:57-62` cấp `budget.approve` cho `ketoan_vien` ở mọi công ty đã có. Thân cuối của `create_tenant` (`0094_quyen_gd6.sql:47-52`, các migration 02xx không định nghĩa lại hàm này) loại trừ theo danh sách, không có `budget.approve`, nên công ty mới cũng cấp quyền đó. Chính sổ quyết định đã ghi nhận (`docs/superpowers/plans/2026-10-28-giai-doan-7-quyet-dinh.md:46`) và `docs/TIEP-THEO.md:42` ghi là việc phải làm khi hợp nhất, nhưng sau 0250 vẫn chưa có migration nào.
- Kịch bản: kế toán viên `POST /api/budgets`, rồi `POST /api/budgets/:id/approve` (`budget/routes.ts:36`), rồi `PUT /api/budget-settings` (`routes.ts:31`) để tắt cảnh báo/chặn vượt ngân sách của cả công ty. Không có điều kiện "người duyệt khác người lập".
- Sửa: migration mới (số tiếp theo, ví dụ 0251) định nghĩa lại `create_tenant` từ thân 0094, thêm `'budget.approve'` vào `NOT IN`; `DELETE FROM role_permission WHERE permission_code='budget.approve' AND role_id IN (SELECT id FROM role WHERE code='ketoan_vien' AND is_system)` cho công ty cũ; cân nhắc chặn `approved_by = created_by`.

### M3. Đề nghị thanh toán trên tài khoản lương hiện với người thiếu `view_salary`
- `approval/service.ts:100-107`: `visible`/`assertVisible` gọi `assertSensitive` không có `salary`. `resolveInput` (`service.ts:116-119`) nhận mọi tài khoản chi tiết, kể cả 334. Vai trò `xem` có `approval_request.view` (`0230_phe_duyet.sql:12-16`), và `ketoan_vien` có cả quyền xem lẫn quyền duyệt.
- Kịch bản: nhân sự lập "Đề nghị thanh toán lương tháng 10, Nguyễn Văn A, 23.456.789" với TK 334. Người vai trò "Chỉ xem" không có `view_salary` gọi `GET /api/approvals?box=all` và thấy người nhận, lý do, số tiền. Người duyệt thiếu `view_salary` duyệt xong thì sinh PC Nợ 334, vượt qua kiểm soát `payroll.pay` + `view_salary` của luồng chi lương.
- Sửa: tính `salary: isSalaryCode(regime, code)` trong `accountsOf` và `assertVisible`; cân nhắc chặn tài khoản lương ở `resolveInput` (đã có luồng chi lương riêng).

---

## Thấp

### T1. `sensitiveSweep` không phủ các route GĐ7
- `apps/api/test/sensitiveSweep.test.ts:36`: `SCOPE = /^\/api\/(payroll|tncn|costing|contracts)(\/|$)|^\/api\/projects\/pnl$/`. Không có `/api/budgets`, `/api/analytics`, `/api/approvals`, `/api/mobile/v1`, `/api/voucher-sets`, `/api/reports/books`, `/api/reports/consolidated`, `/api/audit` (audit chỉ được quét riêng cho lương và giá thành). Lỗi C3, C4, M3 lọt qua chính vì khe này. Bài học số 3 trong `docs/TIEP-THEO.md:47` chưa được áp cho GĐ7.
- Sửa: mở rộng `SCOPE` và bộ số bí mật (thêm giá vốn GV, công nợ 131/331) cho các tiền tố trên.

### T2. Danh sách Chứng từ ghi sổ không đòi cờ nhạy cảm, trong khi Sổ đăng ký CTGS cùng hàm thì đòi đủ bốn cờ
- `reporting/bookFormRoutes.ts:44-45` (`GET /api/voucher-sets`, chỉ cần `voucher_set.view`) gọi `voucherSetRegister`, đúng hàm mà `/api/reports/books/ctgs-register` chỉ trả sau `assertAllSensitive` (`bookFormRoutes.ts:21,38`). `bookForms.ts:63-64`: lúc lập có thể lọc `voucherType`. Kịch bản: kế toán viên thiếu `view_cost` `POST /api/voucher-sets {voucherType:'GV', dateFrom/dateTo một tháng}`, rồi `GET /api/voucher-sets?fiscalYear=2026` và đọc `amount` = tổng giá vốn của tháng. Mức thấp vì B02 trên web cũng hiện dòng giá vốn mà không kiểm cờ (`reporting/routes.ts:87-90`), nhưng hai đường đang không nhất quán.
- Sửa: gọi `assertAllSensitive` ở `GET /api/voucher-sets`, hoặc bỏ cột `amount` khi người dùng thiếu cờ.

### T3. Bảng tạm không lọc chi nhánh và CSV không chống công thức
- `inventory/stockMoves.ts:27-31` (`/api/inventory/on-hand`, quyền `stock_voucher.view` nằm trong danh sách quyền được giữ) đọc `stock_move` của cả công ty: người bị giới hạn chi nhánh thấy tồn kho mọi kho. `ledger/attachments.ts:43-44` liệt kê tệp đính kèm theo `voucher_id` mà không kiểm chứng từ có qua RLS chi nhánh không. Khó khai thác vì id là uuid, nhưng nên đi qua `voucher`.
- `tools/exportAuthority.ts:17-20` (`toCsv`) chỉ bọc nháy, không dùng `formulaSafe`. Diễn giải chứng từ lập từ giao dịch ngân hàng (nội dung chuyển khoản do bên ngoài gửi) bắt đầu bằng `=`/`+`/`@` sẽ thành công thức khi mở CSV trong gói xuất cho cơ quan thẩm quyền bằng Excel.
- Sửa: lọc `warehouse.branch_id` theo phạm vi; kiểm `voucher` trước khi liệt kê tệp; áp `formulaSafe` trong `toCsv`.

---

## Đã kiểm, không thấy lỗi

- **RLS (catalog sau 0250):** mọi bảng có `tenant_id` (142 policy `tenant_id = app_tenant()`) đều `relrowsecurity` và `relforcerowsecurity` = true; không có bảng bật RLS mà thiếu policy. Các bảng không có `tenant_id` (`app_user`, `coa_template`, `fx_rule`, `legal_param`, `login_event`, `permission`, `report_template`, `schema_migration`) là dữ liệu dùng chung hoặc dữ liệu đăng nhập; riêng `tenant` có RLS + FORCE, chỉ có policy SELECT/UPDATE (không có INSERT/DELETE nên bị chặn). `user_session` có policy `true` (cần tra phiên trước khi biết công ty): chủ ý, chỉ lưu băm mã. `tenant_user_select` cho xem dòng của chính mình ở công ty khác: chủ ý. Partition `voucher_line_y*` có RLS, `app_user` không có SELECT/INSERT trực tiếp.
- **RLS `voucher` sau hợp nhất:** `branch_scope` là `RESTRICTIVE`, có cả USING lẫn WITH CHECK; cộng thêm (AND) với `tenant_isolation`.
- **UNIQUE:** chỉ bốn ràng buộc không có `tenant_id`: `api_key.prefix`, `bank_feed.token_hash`, `user_session.token_hash` (khóa tra cứu toàn cục, có chủ ý) và `voucher_line (voucher_id, line_no, posting_date)` (`voucher_id` là uuid toàn cục). Không có lỗi.
- **Khóa ngoại:** không có FK một cột giữa hai bảng cùng có `tenant_id`; không có FK tổng hợp `ON DELETE SET NULL` thiếu danh sách cột (kể cả `budget_line`, `approval_flow_step`, `user_branch_scope`, `voucher_branch_fk`).
- **SECURITY DEFINER:** cả 8 hàm (`create_tenant`, `ensure_line_partitions`, `fn_fiscal_period_partitions`, `user_tenant_count`, `fn_trg_balance_pending`, `fn_einvoice_pending_tenants`, `fn_bank_feed_by_token`, `fn_api_key_lookup`) có `search_path=public, pg_temp` ở thân cuối; `create_tenant` khôi phục `app.current_tenant` của người gọi.
- **`fn_voucher_before` (thân cuối):** so `to_jsonb(NEW)-description-version`, nên `branch_id` của chứng từ đã ghi sổ không đổi được. **`reverse_voucher`:** không chép `branch_id`, nhưng `fn_voucher_branch` gán chi nhánh của chứng từ gốc theo `reversal_of_id` (cả chứng từ kết chuyển).
- **`api_key_scopes_check`:** thân cuối (0230:114-115) gồm `mobile`, khớp `SCOPES` trong `ext/apiKeys.ts:9`.
- **Khóa API `/api/ext/v1`:** khóa `kt_<12hex>_<64hex>`, chỉ lưu SHA-256; so `timingSafeEqual`, có băm giả khi tiền tố không tồn tại; cùng một thông báo 401 cho mọi lỗi; quyền = vai trò hiện hành ∩ phạm vi, tải lại mỗi yêu cầu; `need()` kiểm cả phạm vi lẫn quyền; khóa chỉ tạo cho chính mình; khóa mang phạm vi chi nhánh của người tạo; cookie bị bỏ trên đường ext; `withOverride` không cấp được ghi lùi vì `voucher.backdate_locked` không thuộc phạm vi nào; `/stock` chỉ trả giá trị khi có `view_cost`. Giới hạn 60 yêu cầu/phút trong bộ nhớ và lỗi xác thực chưa giới hạn theo IP là hạn chế đã biết (`docs/TIEP-THEO.md:70`).
- **Webhook SePay/Casso** (`bank/webhook.ts`): mã URL tra bằng băm qua `SECURITY DEFINER`; HMAC-SHA256 trên thân thô (SePay), HMAC-SHA512 trên JSON sắp khóa (Casso); so hằng thời gian; cửa sổ thời gian 300 giây; phát lại bị khử trùng bằng `UNIQUE (tenant_id, source, external_id)` + `ON CONFLICT DO NOTHING`; giới hạn thân 256 KB; parser thân thô chỉ trong plugin (đóng gói); đặt tenant context bằng `withTenant` theo kết quả tra mã; kiểm số tài khoản khớp kết nối.
- **Worker:** tính lại số dư chạy bằng `app_user` qua `withTenant(tenantId)` (có RLS); đối soát HĐĐT lấy danh sách công ty qua hàm DEFINER rồi chạy theo từng công ty; sao lưu dùng URL admin.
- **Phiên/CSRF:** cookie `httpOnly`, `signed`, `sameSite=lax`, `secure` theo cấu hình; mã phiên lưu băm; `selectTenant` kiểm thành viên; CORS chỉ `WEB_ORIGIN`, có credentials; `TRUST_PROXY` mặc định false.
- **SQL injection:** mọi `sql.raw` (`tradeReports.ts`) chỉ nhận chuỗi hằng `qtyTxt(...)`; `sql.table/sql.id/sql.ref` chỉ nhận tên từ hằng hoặc kiểu union; không thấy nối chuỗi đầu vào người dùng.
- **Công thức cột lương:** `lib/formulaSafe.ts` thực chất là chống CSV injection, đã áp ở `print/excel.ts`, `payroll/reports.ts`, `payroll/paymentFiles.ts`; ExcelJS ghi chuỗi dưới dạng giá trị chữ (không phải công thức).
- **Tải tệp:** mọi xlsx đi qua `assertZipSafe` (số dư đầu kỳ, tồn kho đầu kỳ, tài sản đầu kỳ, sao kê, `readSheet`); zip hóa đơn đầu vào giới hạn số mục, dung lượng từng mục và tổng, không mở zip lồng; gói SInvoice có `ZIP_CAPS`, lồng tối đa một cấp; đường dẫn lưu tệp ghép từ `tenantId/uuid`, không lấy tên tệp của người gửi; tải xuống có `nosniff` + `attachment`.
- **SSRF:** `assertEInvoiceUrl` đòi https, tên miền nằm trong `EINVOICE_ALLOWED_HOSTS`, không user/pass/query/cổng; SInvoice gọi với `redirect: 'error'`; SmartCA có `assertSmartcaUrl`.
- **Phê duyệt:** không tự duyệt (`APPROVAL_SELF`); mỗi bước một người khác; đúng người hoặc đúng vai trò của bước; tệp đính kèm chỉ xem được khi xem được đề nghị.
- **Chi nhánh:** không tự đặt phạm vi cho chính mình; quyền bị thu về danh sách cho phép; sổ sách và BCTC web dùng `effectiveBranch`, 403 khi ngoài phạm vi; BCTC tổng hợp lọc theo phạm vi.
- **`SENSITIVE_FLAGS_ALL`** đủ bốn cờ; `assertAllSensitive` áp cho bảng cân đối số phát sinh, NKSC/NKCT/CTGS, bộ sổ năm, xuất cơ quan thẩm quyền; `analyticsOverview` đòi đủ bốn cờ mới tính hệ số.


---

## Phụ lục D — truc4-phap-ly

### Trục 4: Pháp lý (rà soát chỉ đọc, `main` @ daeafe7)

Phạm vi: tham số pháp lý viết cứng, cổng `*.status.json`, dữ liệu `packages/coa-data/data`, thời điểm hiệu lực, dòng "Mẫu số" in trên sổ và biểu mẫu. Mọi phát hiện dưới đây đều đã đọc lại tận dòng mã.

## Tóm tắt

| Mức | Số |
|---|---|
| Nghiêm trọng | 0 |
| Cao | 4 |
| Trung bình | 6 |
| Thấp | 6 |

Kết quả quét hằng số (a): **không** tìm thấy số pháp lý viết cứng trong `apps/api/src`, `apps/worker/src`, `apps/web/src`, `packages/*/src` hay migration. Đã quét giảm trừ 11/4,4/15,5/6,2 triệu, trần 46,8/50,6 triệu, lương tối thiểu vùng, ngưỡng 20 triệu, 500 triệu, 1 tỷ, 3 tỷ, hệ số BHXH và hệ số làm thêm giờ. Tham số lương chỉ có lược đồ (`payroll/params.ts:26-43`), không có giá trị mặc định. Thiếu tham số thì trả 409 `PAYROLL_PARAM_MISSING` (`params.ts:71`). Thuế suất TNDN, ngưỡng miễn thuế, mức giảm và tỷ lệ tạm nộp đều đọc qua `legalParam()` theo ngày. Các số tìm thấy chỉ nằm trong fixture kiểm thử (`apps/api/test/payroll/params.test.ts:54`) và tệp kỳ vọng seed. Ngoại lệ là mã thuế GTGT gieo cứng (phát hiện C2) và văn bản dẫn luật viết cứng (T4).

---

## Cao

### C1. "Mẫu số" của Bảng cân đối số phát sinh TT133 trùng số với sổ chi tiết vật liệu đã đối chiếu
- `apps/api/src/modules/reporting/print/forms.ts:18` gán `S06: { TT133: 'S06-DNN' }`, và `bookSet.ts:47` dùng khóa này cho "Bảng cân đối số phát sinh".
- Cũng trong tệp đó, `forms.ts:37` gán `'stock-ledger': { TT133: 'S06-DNN' }` cho "Sổ chi tiết vật liệu, dụng cụ". Mã này đã được đối chiếu văn bản gốc (quyết định GĐ3 số 331, `docs/superpowers/plans/2026-10-22-giai-doan-3-quyet-dinh.md:167`).
- Một số mẫu không thể là hai sổ khác nhau, nên giá trị của BCĐSPS sai. Ghi chú `forms.ts:8` lại ghi "S06/S04-DNN" và đòi đối chiếu trước khi phát hành, mâu thuẫn với chính bảng.
- Hậu quả: công ty TT133 in BCĐSPS (cả bộ sổ năm) với dòng "Mẫu số S06-DNN, Ban hành theo Thông tư số 133/2016". Đây là số mẫu của một sổ khác, trình nộp hoặc lưu trữ sẽ sai mẫu.
- Cách sửa: bỏ `TT133` khỏi `S06` (in không có số mẫu) cho đến khi đối chiếu được Phụ lục 4 TT133. Làm tương tự với `S38 → S20-DNN`, `S03a-DNN`, `S03b-DNN`, vì ghi chú dòng 8 nói chưa đối chiếu. Nên thêm kiểm thử chặn trùng số mẫu giữa các khóa trong cùng một chế độ.

### C2. Thuế suất 8% gieo cứng không có ngày hết hiệu lực; phát hành HĐĐT sau 31/12/2026 không bị chặn
- `packages/db/migrations/0037_khu_trung.sql:53`, thân cuối của `seed_tenant_defaults`, gieo mã `V8` (8%) và nhóm bán ra `08` cho mọi công ty mới, không có khoảng hiệu lực.
- Tham số `vat_reduced_rate` (`packages/coa-data/data/tax/legal-params.json:3-7`) chỉ hiệu lực đến 2026-12-31. Tuy vậy chỉ có tờ khai cảnh báo (`apps/api/src/modules/tax/vatReturn.ts:74-75`) và quy tắc soát lỗi cảnh báo (`0038_soat_loi_gd2.sql:100-105`).
- `apps/api/src/modules/einvoice/doc.ts:14-17` (`taxRateOf`) và các module `invoices/`, `ledger/` không gọi `legalParam('vat_reduced_rate')`.
- Hậu quả: từ 01/01/2027 người dùng chọn `V8` thì hóa đơn điện tử 8% vẫn được gửi lên CQT. Hóa đơn đã cấp mã thì không hủy được (TT91 Điều 10), chỉ còn cách điều chỉnh.
- Cách sửa: chặn (409 `VAT_RATE_NOT_EFFECTIVE`) khi phát hành HĐĐT, và cảnh báo khi ghi sổ, nếu dòng có thuế suất 8% mà `vat_reduced_rate` không hiệu lực tại ngày hóa đơn. Nên thêm cột hiệu lực cho `tax_code`, hoặc liên kết mã V8 với tham số.

### C3. Cổng `01GTGT_TT89_rate8 = false` chỉ là cảnh báo: tờ khai vẫn chốt, vẫn xuất và ký XML với 8% gộp vào dòng 10%
- `packages/coa-data/data/tax/01gtgt-tt89.json:172-200` gộp nhóm `08` vào [32] và [33] (dòng "thuế suất 10%"). `vatReturn.ts:72` chỉ đẩy cảnh báo. `isVatRate8Verified()` chỉ được dùng ở một chỗ đó (`grep`); chốt tờ khai, xuất XML (`tax/routes.ts:70-84`) và ký số (`signing/sessions.ts:85-90`) không kiểm tra cổng này.
- Hậu quả: kỳ có hóa đơn 8% thì [33] khác [32] × 10%. Tờ khai đã chốt và ký vẫn mang giả định chưa có căn cứ. Phần mềm cũng không lập Mẫu số 01 Phụ lục II NĐ 174/2025, dù chính lời cảnh báo bảo lập kèm.
- Cách sửa: khi `group08 && !isVatRate8Verified()`, đòi người dùng xác nhận rõ ràng (cờ `acknowledge`) lúc chốt, ghi `audit_event`, và chặn ký số. Hoặc tách [32]/[33] thành dòng 8% riêng, có ghi chú "phần mềm tự thêm" và `printed=false` (như cách làm của 03/TNDN).

### C4. Năm tài chính không kiểm tra chế độ theo ngày hiệu lực; TT200 bị đánh dấu `ready: true` dù chưa đối chiếu
- `apps/api/src/modules/core/fiscalYears.ts:11-35` nhận `regime` bất kỳ cho năm bất kỳ. `packages/domain/src/period.ts:6-19` cũng không kiểm tra.
- Theo đặc tả mục 10 dòng 263, TT99 thay TT200 cho năm tài chính từ 01/01/2026, và TT58 hiệu lực từ 01/07/2026. Mã vẫn cho tạo năm 2026 hoặc 2027 theo `TT200`, và năm 2024 theo `TT99`.
- `apps/api/src/modules/core/regimes.ts:10` để `TT200 ready: true`, trong khi nguồn hệ thống tài khoản ghi "SUNSOFT OrgDMTK_200 (chưa đối chiếu Phụ lục 1 TT 200/2014/TT-BTC)" (`packages/coa-data/src/load.ts:10`). TT200 cũng không có mẫu B01/B02/B03 (`data/reports/` chỉ có `tt99`, `tt133`) và `fxRules_TT200=false`.
- Hậu quả: công ty chọn nhầm TT200 cho năm 2026 sẽ có hệ thống tài khoản chưa đối chiếu, không có BCTC, và quy tắc tỷ giá chưa đối chiếu. Phần mềm không cảnh báo, và sổ vẫn in "Ban hành theo TT 200/2014" (xem TB1).
- Cách sửa: đưa khoảng hiệu lực của từng chế độ vào dữ liệu (`legal_param` mã `accounting_regime`, hoặc `regimes/status.json` có `effectiveFrom`/`effectiveTo`, với TT99 tra theo ngày đầu năm tài chính). Trả 409 `REGIME_NOT_EFFECTIVE`, hoặc đòi xác nhận khi tạo năm lệch hiệu lực. Đặt `TT200 ready` theo cờ dữ liệu thay vì `true`.

## Trung bình

### TB1. Sổ theo TT200 vẫn in "Mẫu số" và "Ban hành theo TT 200/2014", trái với trạng thái đã ghi
- `forms.ts:5` (ngày 22/12/2014 lấy từ trí nhớ, chưa có văn bản gốc), `forms.ts:11-21`: `S03a`, `S03b`, `S38`, `S06`, `S02a/b/c1`, `B01/B02/B03` đều có mục `TT200`.
- `formNoFor()` (`forms.ts:52-54`) được `bookSet.ts:22` (Nhật ký chung, Sổ cái, Sổ chi tiết, BCĐSPS) và `financial.ts:26,254` (BCTC công ty tự định nghĩa) dùng mà không qua `bookFormFor`.
- `docs/TIEP-THEO.md:25` lại ghi "Công ty theo TT200 in không có dòng 'Mẫu số'": điều này chỉ đúng với chứng từ tiền, kho và TSCĐ.
- Cách sửa: bỏ mọi mục `TT200` và `ISSUED.TT200` cho đến khi có văn bản gốc. Cho `bookSet`/`financial` dùng `bookFormFor` (trả `null` thì để trống).

### TB2. Hình thức Chứng từ ghi sổ in số mẫu đã tự ghi là "CHƯA đối chiếu"
- `forms.ts:14-17` ghi rõ "CHƯA đối chiếu văn bản gốc" nhưng vẫn gán `S02a-DN`, `S02b-DN`, `S02c1-DN` cho TT99 và TT200. Mã in ở `bookFormDocs.ts:33,39,46`. Quyết định GĐ7 số 1005 (`2026-10-28-giai-doan-7-quyet-dinh.md:16`) thừa nhận làm "theo yêu cầu nghiệp vụ", trái quy tắc "Mẫu số chỉ từ văn bản gốc".
- Cách sửa: để trống số mẫu cho đến khi đối chiếu, hoặc in kèm chú thích "(số mẫu chưa đối chiếu)". Thêm một dòng vào mục "Chờ người dùng".

### TB3. Số mẫu sổ tổng hợp TT99 (S03a-DN, S03b-DN, S38-DN, S06-DN) không có bằng chứng đối chiếu
- Ở `forms.ts:11-18`, chỉ các mục kho, quỹ và TSCĐ dẫn dòng văn bản trong `~/legal-docs`. S03a, S03b, S38, S06 của TT99 không dẫn nguồn. Quyết định 1005 cho thấy chính người làm nghi `S06-DN` (mâu thuẫn với yêu cầu Nhật ký – Sổ Cái).
- Cách sửa: đối chiếu danh mục sổ TT99 (Phụ lục), ghi dòng nguồn vào chú thích như các mục khác, hoặc bỏ số mẫu.

### TB4. XML tờ khai `verified=false` vẫn ký số được; giao diện 01/GTGT cảnh báo lỏng hơn 03/TNDN
- `packages/coa-data/data/tax/htkk-01gtgt.json:3` và `htkk-03tndn.json:3` để `verified: false`. API chỉ gắn header `x-kt-unverified` (`tax/routes.ts:82,137`). `signing/sessions.ts:85-90` ký XML của cả hai mà không kiểm tra `verified`; chỉ tờ khai TNCN bị chặn (`sessions.ts:98`).
- `apps/web/src/pages/VatReturn.tsx:71` dùng `verified === false` (nếu chưa tải được danh sách định dạng thì không cảnh báo), trong khi `CitReturn.tsx:43` dùng `!== true`.
- Hậu quả: người dùng ký số một XML có tên thẻ và mã tờ khai do phần mềm giả định, rồi nộp lên eTax và bị từ chối, hoặc tệp bị hiểu sai.
- Cách sửa: chặn hoặc đòi xác nhận khi ký XML có `verified=false`. Đổi VatReturn thành `!== true`.

### TB5. Cờ B01/B02/B03 = `true` nhưng báo cáo in không báo dòng gần đúng hay dòng để 0 cố định
- `packages/coa-data/data/reports/status.json`: TT99 có `B01:true` nhưng các dòng 112, 124–126, 165, 216, 236–238, 251, 266, 271, 273, 337, 341 luôn bằng 0. TT133 có `B03:true` nhưng chi mua TSCĐ qua N331 rơi vào dòng 02 thay vì 21. Không có mã nào trong `apps/api/src/modules/reporting/*.ts` hay `apps/web` hiển thị các ghi chú này (`grep "gần đúng|reportStatus"` không có kết quả).
- Hậu quả: BCTC in ra trông như đã đầy đủ. Người dùng không biết dòng nào là giả định của phần mềm.
- Cách sửa: tách cờ "chỉ tiêu nhập từ văn bản" khỏi cờ "cách lấy số đã đầy đủ". Đưa danh sách dòng gần đúng vào dữ liệu (`note_ref` hoặc trường `approx`) và in chú thích hoặc cảnh báo.

### TB6. Cổng `regimes/status.json` (TT58, TT152) chỉ chặn được nhờ trùng hợp
- `isRegimeReady()` (`packages/coa-data/src/regimes.ts:14`) chỉ được dùng cho danh sách ở `core/regimes.ts:13`. Việc tạo năm tài chính bị chặn chỉ vì `coa_template` rỗng (`coa/service.ts:19`).
- Nếu sau này có `tt58.csv` (cổng `coa=true`) mà `books`/`reports` vẫn `false`, năm tài chính sẽ tạo được. Khi đó `loadClosingTemplate` đọc `closing-steps/tt58.json` không tồn tại và trả lỗi 500 (`fiscalYears.ts:32`, `load.ts:28`).
- Cách sửa: trong `createFiscalYear`, gọi `isRegimeReady()` cho các chế độ ghi sổ theo nhóm thuế và trả 409 rõ ràng.

## Thấp

- **T1.** Tài liệu ghi seed ABC đặt `TNCN_KT` 10% (`docs/TIEP-THEO.md:189`, `docs/user/giai-doan-0-bat-dau.md:3`), nhưng `packages/db/src/seed/*.ts` không có `TNCN_KT` hay thuế suất TNCN nào. Cần sửa tài liệu (hoặc seed) cho khớp.
- **T2.** `fxRules_TT200=false` (`data/tax/status.json`) nhưng `reference.ts:47-50` vẫn nạp quy tắc TT200, và `cash/fx.ts:42-44` dùng mà không cảnh báo. Nên cảnh báo khi đánh giá lại tỷ giá theo chế độ có cờ `false`.
- **T3.** Sơ đồ kết chuyển `data/closing-steps/tt99|tt133|tt200.json` không có trường nguồn văn bản. Mọi tệp pháp lý khác (`legal-params`, `fx-rules`, `tt99.status`) đều có. Nên thêm `source` cho mỗi chế độ.
- **T4.** Văn bản dẫn luật viết cứng trong mã, không lấy từ `legal_param.source`: `packages/domain/src/cit.ts:28,31-32` ("Luật 67/2025 Điều 10", "NĐ 141/2026 Điều 2"), `tax/citEstimate.ts:80,101,105`, `citReturn.ts:59,66-67`. Khi tham số có dòng mới theo văn bản khác, lời giải thích sẽ sai. Nên dẫn từ `source` của dòng tham số đang áp dụng.
- **T5.** Khoảng ngày tính số đã nộp viết cứng, không có nguồn hay tham số: `citEstimate.ts:89` ("từ đầu quý 2"), `citEstimate.ts:104` (`monthEndAfter(fy.to, 1)`, tức hạn tạm nộp quý 4), `citReturn.ts:40` (đến hết tháng thứ 3, dẫn "ghi chú 3 của mẫu"). Hạn nộp nên là tham số có nguồn.
- **T6.** `packages/domain/src/invoiceSymbol.ts:7,12` nhận thêm loại hóa đơn `F`, trong khi `docs/TIEP-THEO.md` (mục 2, ký hiệu TT91) liệt kê T/D/L/M/N/B/G/H/X và mã không dẫn dòng văn bản nào cho `F`. Cần đối chiếu Phụ lục I TT91 rồi ghi nguồn, hoặc bỏ. Ngoài ra `napas-bins.status.json` để `complete:true` với nguồn VietQR (thứ cấp, có ghi chú): chấp nhận được nhưng tên cờ dễ hiểu nhầm.

---

## Thời điểm hiệu lực (d): các điểm đúng

- 01/GTGT: `templateFor` tra `vat_return_template` theo ngày đầu kỳ (`vatReturn.ts:29-30`). Kỳ trước 01/07/2026 cho TT80, và cổng `01GTGT_TT80=false` thì trả 409 `VAT_TEMPLATE_UNAVAILABLE`; từ 01/07/2026 dùng TT89. Đúng theo TT89 Điều 100.
- 03/TNDN: tra theo ngày cuối năm tài chính (`citReturn.ts:24-26`). Năm kết thúc trước 01/07/2026 trả 409.
- `cit_rate`, `cit_exempt_revenue`, `cit_reduction` tra theo ngày đầu năm tài chính; `cit_prepay_min_ratio` tra theo ngày cuối năm (`citEstimate.ts:75-76,99,102`).
- Tham số lương lấy tại ngày cuối kỳ, có cảnh báo khi đầu kỳ và cuối kỳ khác nhau (`payroll/runs.ts:55-60`). `payroll_param` chặn khoảng hiệu lực chồng nhau (`params.ts:85-88`).
- Đổi chế độ giữa hai năm: tạo năm mới nạp hệ thống tài khoản, sơ đồ kết chuyển và báo cáo của chế độ mới mà không xóa của chế độ cũ (`fiscalYears.ts:29-34`). Không có công cụ chuyển số dư từ hệ TT200 sang TT99: người dùng nhập số dư đầu kỳ (DK) tay. Không có lỗi dữ liệu, nhưng là khoảng trống nghiệp vụ.

## Cổng còn `false`

| Cổng (tệp) | Mã có chặn không | Ảnh hưởng người dùng |
|---|---|---|
| `01GTGT_TT80` (`data/tax/status.json`) | Có: 409 `VAT_TEMPLATE_UNAVAILABLE` (`vatReturn.ts:31-35`, `load.ts:85-88`) | Không lập được 01/GTGT cho kỳ trước 01/07/2026, kể cả tờ khai bổ sung các kỳ 2025 và nửa đầu 2026 |
| `01GTGT_TT89_rate8` | **Không**, chỉ cảnh báo (`vatReturn.ts:72`) | 8% gộp vào [32]/[33]; vẫn chốt, xuất XML và ký được (C3) |
| `legalParam_vat_return_template@2022-01-01` | Nhãn; dòng vẫn nạp (`reference.ts:55-60`). Kết quả vẫn 409 vì `01GTGT_TT80=false` | Không ảnh hưởng thêm |
| `fxRules_TT200` | **Không**, quy tắc vẫn nạp và dùng (`reference.ts:47-50`) | Đánh giá lại tỷ giá TT200 dùng tỷ giá và tài khoản chưa đối chiếu, không có cảnh báo (T2) |
| `payrollParams_pit`, `payrollParams_si`, `payrollParams_minWage` | Có, nhưng gián tiếp: `legal_param` không có giá trị, thiếu tham số thì 409 `PAYROLL_PARAM_MISSING` (`params.ts:71`). Công ty tự nhập `payroll_param` kèm nguồn thì đi qua được (chủ ý) | Phải tự nhập biểu thuế TNCN, giảm trừ, BHXH, lương tối thiểu vùng; giá trị không được phần mềm kiểm tra |
| `05KK_TNCN_TT89`, `05QTT_TNCN_TT89` | Có: 409 `TNCN_TEMPLATE_UNAVAILABLE` khi xuất XML và ký (`tncnReturn.ts:225-228,306`, `signing/sessions.ts:98`) | Chỉ có bảng kê; không có XML hay mẫu chính thức; chứng từ khấu trừ in không có mẫu số |
| `htkk-01gtgt.verified`, `htkk-03tndn.verified` | **Không**, chỉ header và tooltip; ký số vẫn được (TB4) | XML có thể bị eTax từ chối |
| `regimes/status.json` TT58 `coa/books/reports` | Có, gián tiếp: `coa_template` rỗng nên 409 `COA_TEMPLATE_PENDING` (TB6) | Doanh nghiệp siêu nhỏ không dùng được chế độ TT58; không có sổ S1–S4-DNSN, B01/B02-DNSN |
| `regimes/status.json` TT152 `coa/books/reports` | Như trên | Hộ kinh doanh không dùng được; không có sổ HKD hay 01/CNKD |
| `regimes.*.primaryTextObtained` | Chỉ để hiển thị | Không có |
| `consolidation/status.json tt202.complete` | Không có tính năng nào dùng; chưa có BCTC hợp nhất | Chỉ có BCTC tổng hợp chi nhánh trong một công ty |
| Hệ thống tài khoản TT200 (không có tệp status; nguồn ghi "chưa đối chiếu" ở `load.ts:10`) | **Không**: `ready: true` (`core/regimes.ts:10`) | Xem C4, TB1 |

Các cổng `true` đã kiểm tra khớp với mã: `01GTGT_TT89`, `03TNDN_TT89` (409 khi `false`), `CIT_RATES`, `legalParam_*@...=true`, `fxRules_TT99`, `fxRules_TT133`, `tt99.status.complete` (184 dòng trong `tt99.csv` khớp ghi chú), và `reports tt99/tt133 B01–B03`, với lưu ý ở TB5. Không có mã trùng trong `coa/tt99.csv`, `tt133.csv` hay `tt200.csv`. Tệp i18n có `_note` ghi rõ là bản nháp tham khảo, không phải dữ liệu pháp lý.


---

## Phụ lục E — truc5-migration

### Trục 5 — Migration (main @ daeafe7)

Phương pháp: đọc `packages/db/src/migrate.ts`; tạo 6 DB tạm `ketoan_review5*` trên Postgres Docker 5432 (đã xóa hết, DB `ketoan` không đụng); chạy runner thật qua tsx; so `pg_dump -s`; so thân hàm bằng diff; thử dữ liệu mẫu ABC.

## Phát hiện

### 1. [cao] Chính sách RLS `branch_scope` chỉ đặt trên `voucher`, các bảng con/sổ phụ vẫn đọc được mọi chi nhánh
`packages/db/migrations/0240_da_chi_nhanh.sql` (CREATE POLICY branch_scope ON voucher, ~dòng 38–41).
Bằng chứng (DB đã seed ABC, role `app_user` không superuser, FORCE RLS): đặt `app.current_tenant` + `app.branch_scope='999'` (chi nhánh không có chứng từ nào) thì
`voucher = 0`, nhưng `voucher_line = 759`, `voucher_item_line = 72`, `open_item = 113`, `account_period_balance = 473`.
Kịch bản: người dùng bị giới hạn chi nhánh A mà route nào đọc `voucher_line`/`open_item`/số dư không JOIN `voucher` sẽ thấy số liệu chi nhánh B. Có 30 module truy vấn `FROM voucher_line`; RLS (lớp phòng thủ cuối) không chặn. Cờ nhạy cảm theo quy tắc bất biến đòi chặn ở dữ liệu/API, không chỉ ở lớp trình bày.
Cách sửa: thêm chính sách RESTRICTIVE tương đương (EXISTS voucher theo `voucher_id`) cho `voucher_line`, `voucher_item_line`, `open_item`..., hoặc kiểm thử API chứng minh mọi truy vấn sổ đều JOIN voucher (cần trục API xác nhận). Số dư kỳ `account_period_balance` không mang chi nhánh nên báo cáo theo chi nhánh phải dùng `fn_balances_at_branch` (0241) — rà các route khác.

### 2. [trung bình] Hướng dẫn đánh số tiếp theo sai: "Migration bắt đầu ở 0112"
`docs/TIEP-THEO.md:46`. GĐ7 đã dùng 0200–0250; runner sắp xếp theo TÊN (`readdir().sort()`, `migrate.ts`, vòng áp dụng) nên mọi migration 0112–0199 mới sẽ được áp TRƯỚC 0200–0250 trên DB trống, nhưng SAU trên DB hiện có (runner không kiểm thứ tự, chỉ áp tệp chưa có trong `schema_migration`). Nếu migration mới tham chiếu `voucher.branch_id`, bảng ngân sách/phê duyệt hoặc định nghĩa lại một hàm 02xx, DB mới lỗi còn DB cũ chạy được (lệch), hoặc hai đường áp cho kết quả khác nhau khi cùng sửa một hàm.
Cách sửa: sửa tài liệu thành "tiếp từ 0251" (hoặc đánh số mới > 0250) và thêm kiểm tra trong runner/kiểm thử: tệp mới chưa áp phải lớn hơn mọi tệp đã áp, trừ danh sách ngoại lệ có chủ ý (GĐ6/GĐ7 hiện tại).

### 3. [thấp] `0250` sửa CHECK bằng thay chuỗi trên `pg_get_constraintdef`, không xác nhận kết quả
`0250_che_do_hkd.sql` (khối DO). Chỉ chọn ràng buộc có `'TT58'` và chưa có `'TT152'`; ràng buộc `regime` định dạng khác (vd `regime IN`, hay bảng mới ở GĐ sau) bị bỏ qua lặng lẽ. Đã kiểm: trên DB đủ migration cả 6 ràng buộc (`coa_template, fiscal_period, report_template, report_def, closing_step, fx_rule`) đều có TT152, nên hiện đúng. Cách sửa: thêm bước `ASSERT` đếm sau vòng lặp; bảng mới có `regime` phải nêu TT152.

### 4. [thấp] `0230` `DROP CONSTRAINT api_key_scopes_check` không `IF EXISTS`, danh sách phạm vi viết cứng
`0230_phe_duyet.sql:114-115`. Không áp lại được nếu tên ràng buộc đổi; danh sách phạm vi sao chép từ `0090_khoa_api.sql:9` + `'mobile'` — đã đối chiếu: giữ đủ 4 phạm vi cũ, không mất nhánh. Lần thêm phạm vi sau phải liệt kê lại toàn bộ. Cách sửa: `DROP CONSTRAINT IF EXISTS`.

### 5. [thấp] Thiếu chỉ mục cho khóa ngoại tổng hợp mới
Kiểm bằng `pg_constraint`/`pg_index` trên DB đủ migration, FK 02xx không có chỉ mục dẫn đầu: `approval_request(tenant_id, voucher_id)` (ON DELETE SET NULL: xóa chứng từ nháp quét tuần tự `approval_request`), `approval_request(flow_id)`, `approval_request(party_id)`, `approval_request(bank_account_id)`, `approval_flow_step(role_id)`, `approval_flow_step(user_id)`, `approval_step_log(actor_id)`, `ledger_voucher_set(created_by)`, `user_branch_scope(branch_id)`. Bảng nhỏ nên ảnh hưởng thấp; riêng `voucher_id` cần chỉ mục vì xóa phiếu nháp là thao tác thường xuyên. Cách sửa: migration 0251 thêm `CREATE INDEX` cho `approval_request(tenant_id, voucher_id)`.

### 6. [thấp] `0210` UPDATE dữ liệu tài khoản kích hoạt trigger kiểm toán
`0210_song_ngu.sql` (`UPDATE account SET translation_status='draft'...`). Trên DB ABC (mốc 0111 + dữ liệu) sinh thêm 38 dòng `audit_event` với `user_id` NULL (action `update`, entity `account`). Không lỗi, chỉ nhiễu nhật ký; chấp nhận được, hoặc tắt `trg_audit` như đã làm với `role_permission` ở các migration khác.

### 7. [thấp] Khóa/ghi lại bảng lớn ở 0240 (đánh giá, không có lỗi chạy)
`0240_da_chi_nhanh.sql`: `ALTER TABLE voucher ADD COLUMN branch_id` + `SET DEFAULT` chỉ đổi catalog (không viết lại bảng; `voucher_line` là bảng partition không bị chạm — đúng). Nhưng `ADD CONSTRAINT ... FOREIGN KEY` quét `voucher` đầy đủ dưới khóa SHARE ROW EXCLUSIVE và `CREATE INDEX` (không CONCURRENTLY) chặn ghi `voucher` trong lúc dựng; với `voucher` hàng triệu dòng cần cửa sổ bảo trì. Sửa: `ADD CONSTRAINT ... NOT VALID` rồi `VALIDATE`; ghi chú vận hành.

## Kết quả kiểm theo yêu cầu

(a) Số hiệu: 118 tệp, 0001–0111 liền mạch, 0200/0210/0220/0230/0240/0241/0250; không trùng số, không thiếu trong 0001–0111. Khoảng 0112–0199 KHÔNG làm runner lỗi: runner sắp xếp theo tên, không kiểm liên tục, mỗi tệp trong 1 giao dịch (`BEGIN/COMMIT`), bảng `schema_migration(name, applied_at, checksum)`, checksum SHA-256 (chuẩn hóa BOM/CRLF) kiểm trước khi áp tệp mới, khóa `pg_advisory_lock(727001)`.
- DB trống → 118 migration xanh (1,4 s).
- 0001–0111 rồi 0200–0250: xanh; 0001–0093 rồi tất cả: xanh.
- Trường hợp ngược: DB 0001–0093 + 02xx trước (100 tệp) rồi 0094–0111 sau: xanh; `pg_dump -s` của ba đường (thẳng, qua 0111, ngược) giống hệt nhau (chỉ khác mã `\restrict`).
- Nâng cấp có dữ liệu: DB mốc 0111 (+0220 do seed ABC cần `budget_setting`) + seed ABC (204 chứng từ, 759 dòng), rồi áp 0200, 0210, 0230, 0240, 0241, 0250 (một phần áp ngoài thứ tự): xanh, cột `branch_id` NULL, 85 tài khoản có `translation_status='draft'`, lược đồ cuối giống DB tạo thẳng (chỉ khác phân vùng dữ liệu).
- Ghi chú: seed ABC phụ thuộc bảng GĐ7 (`budget_setting`) nên không seed được ở mốc 0111 (không phải lỗi migration).

(b) 0001–0015 không bị sửa: `git diff gd1-hoan-tat HEAD` trên 15 tệp rỗng, `git log gd1-hoan-tat..HEAD` rỗng; 0001–0093 không đổi so với `gd5-hoan-tat`; `gd6-hoan-tat..HEAD` chỉ thêm 7 tệp 02xx. Checksum runner chặn sửa tại chỗ.

(c) Hàm định nghĩa lại: GĐ7 chỉ tạo hàm MỚI (`fn_voucher_branch`, `fn_voucher_branch_audit`, `fn_translation_status`, `fn_balances_at_branch`), không định nghĩa lại hàm cũ → không xung đột với GĐ6. GĐ6 định nghĩa lại, đã diff với thân liền trước: `reverse_voucher` (0046→0097: chỉ thêm `cost_object_id`, `cash_flow_code`, `asset_id`), `fn_line_before` (0025→0097: thêm ngoại lệ 154, giữ nguyên các nhánh khác), `fn_line_immutable` (0006→0097: thêm `cash_flow_code`, `cost_object_id` vào danh sách được sửa), `unpost_voucher`/`discard_voucher` (0069→0099: thêm 3 `source_doc_type`), `seed_voucher_types` (thêm LU, GT), `create_tenant` (0078→0094: thêm 3 quyền lương bị loại khỏi kế toán viên). Đều giữ đủ nhánh trước. `fn_voucher_before` không bị đổi ở GĐ6/7 và khóa `branch_id` sau ghi sổ nhờ so `to_jsonb(NEW)` (kiểm trên thân hàm). `reverse_voucher` không chép `branch_id` nhưng trigger `fn_voucher_branch` gán từ `reversal_of_id` (đúng thiết kế). Hash khóa cứng dùng `fn_voucher_canonical` (không `to_jsonb`) nên thêm cột không phá chuỗi hash.
Phân quyền: tạo công ty cũ (trước nâng cấp) và công ty mới (sau nâng cấp) rồi so `role_permission` từng vai trò: không lệch.

(d) 02xx tham chiếu GĐ6: không dựa bảng GĐ6 nào; 0230 tham chiếu `bank_account` (0087), `role`, `party`; 0241 dùng `fiscal_period`; xác nhận qua thử ngược ở trên.

(e) Không idempotent (CREATE TABLE/TYPE không IF NOT EXISTS) nhưng runner đảm bảo áp một lần và có giao dịch/rollback; chấp nhận. Không có `CONCURRENTLY`.

## Đã kiểm không lỗi
- Thiếu/trùng số 0001–0111, 02xx; runner không yêu cầu liên tục.
- Lược đồ cuối đồng nhất giữa mọi thứ tự áp dụng.
- Tệp 0001–0093, 0094–0111 bất biến so với các tag.
- Seed quyền cho công ty hiện có khớp `create_tenant` cho công ty mới (GĐ6 và GĐ7).
- `api_key_scopes_check` giữ đủ phạm vi cũ.
- Khóa ngoại tổng hợp 02xx đều có `UNIQUE (tenant_id, id)` ở bảng cha; `SET NULL (voucher_id)` đúng quy ước; các bảng mới đều `rls_enable` + `audit_enable`; UNIQUE đều có `tenant_id`.
- Trigger `trg_voucher_branch` kiểm chi nhánh là `is_branch`; chứng từ kết chuyển về trụ sở chính.


---

## Phụ lục F — truc6-kiem-thu

### Trục 6 — Kiểm thử (main, daeafe7)

Phạm vi: đọc mã kiểm thử và mã nguồn tương ứng, chạy bất biến 1–10 + mẫu XYZ. Không sửa mã, không commit. Mọi phát hiện kèm bằng chứng (đường dẫn/grep/kết quả chạy).

## 0. Kết quả chạy bất biến

Lệnh: `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts` (DB tạm tự tạo bởi global-setup; DB `ketoan` không bị ghi; không còn `ketoan_t_*` tồn lại).

**Lần chạy đầu thất bại hoàn toàn (11/11 tệp, "no tests")**: `Failed to load url qrcode ... apps/api/src/modules/bank/vietqr.ts`. Nguyên nhân: `node_modules` của `apps/api` thiếu `qrcode` (và 25 gói khác) dù `apps/api/package.json:26` đã khai báo. Chạy `pnpm install --frozen-lockfile` (chỉ đổi node_modules, `git status` sạch) rồi chạy lại: **PASS 11 tệp / 28 test, 253 s** (tests 246 s). Không có test fail, không skip, không retry, không flaky quan sát được trong một lần chạy.

| Tệp | Test | Thời gian |
|---|---|---|
| inv8-tai-san | 3 | 96,8 s |
| inv10-luong-gia-thanh | 3 | 42,6 s |
| inv7-kho | 1 | 27,0 s |
| inv5-cong-no | 1 | 19,8 s |
| inv2-chuoi-thao-tac | 1 | 19,7 s |
| inv9-hoa-don-ngan-hang | 2 | 13,0 s |
| sample-xyz | 9 | 9,1 s |
| inv4-can-doi-ke-toan | 1 | 8,0 s |
| inv1-can-bang | 3 | 5,4 s |
| inv3-idempotency | 1 | 3,2 s |
| inv6-khoa-cung | 3 | 1,3 s |

### Bất biến còn sơ sài (số lần chạy mặc định, `grep numRuns test/invariants`)
- inv4 cân đối kế toán: `runs(4)` với chuỗi 20 chứng từ (`inv4-can-doi-ke-toan.test.ts:15`). 4 chuỗi là rất ít.
- inv10 lương/giá thành: `runs(6)` cho cả 3 thuộc tính (`inv10...:184,217,248`); tài liệu tự ghi 6 lần ~45 s. Chỉ phủ các ví dụ cố định + 6 mẫu ngẫu nhiên.
- inv7 kho: `runs(10)` trên không gian (4 phương pháp × allowNeg × chuỗi 6–16 thao tác) (`inv7-kho.test.ts:122`); `tracking: 'none'` cố định (dòng ~25), tức không có serial/lô theo mặt hàng; TIEP-THEO mục 1 vẫn ghi "bất biến 7 đầy đủ" thuộc nhóm C để sau.
- inv3 idempotency (20 lần, 1 test), inv6 khóa cứng (3 test tất định, không fast-check).
- Không bất biến nào có chiều chi nhánh (`grep -rli branch test/invariants` rỗng) và không bất biến nào phủ thuế TNCN/quyết toán hay khấu trừ nội bộ hợp nhất.
- Mặc định của inv5: ngưỡng phủ thao tác hiếm chỉ kiểm khi `FC_RUNS>=100/300` (`inv5-cong-no.test.ts:189`) — chạy mặc định (15) chỉ dựa vào kịch bản cố định để bảo đảm thao tác hiếm; chính sổ quyết định #115 thừa nhận.

## 1. Phát hiện

### Nghiêm trọng / Cao

**F1 (Cao) Không có test nào cho giao điểm chi nhánh × lương/giá thành (điểm hòa giải GĐ6/GĐ7).**
Bằng chứng: `grep -rli "branch|chi nhánh" apps/api/test/payroll apps/api/test/costing apps/api/test/contracts apps/api/test/sensitiveSalaryGd6.test.ts apps/api/test/sensitiveSweep.test.ts` không ra tệp nào; `src/modules/payroll/*.ts` không chứa "branch". Chi nhánh chỉ gắn vào chứng từ qua cột mặc định `current_setting('app.branch_default')` (`packages/db/migrations/0240_da_chi_nhanh.sql:12`), nên chứng từ LU/chi lương/giá thành/khấu hao tự sinh lấy chi nhánh làm việc của người đang bấm chạy, không phải chi nhánh của nhân viên/đối tượng giá thành.
Kịch bản lọt: người dùng bị giới hạn chi nhánh A hạch toán bảng lương toàn công ty (hoặc chạy giá thành) → chứng từ LU gắn chi nhánh A (hoặc HO); B02/BCTC tổng hợp theo chi nhánh phản ánh chi phí lương sai đơn vị; chạy lại/đảo (đảo thừa kế chi nhánh gốc theo trigger `fn_voucher_branch`) không đổi lỗi; người dùng chi nhánh B không thấy chứng từ lương hoặc thấy sai số khi `branch_scope` lọc `payroll_line`/`cost_run` (các bảng này không có branch).
Đề xuất test: (a) tenant có 2 chi nhánh, người dùng scope A chạy `POST /api/payroll/runs/:id/post` → khẳng định `GET /api/vouchers/:id/branch` đúng quy tắc đã chốt (chi nhánh làm việc hay chi nhánh phòng ban nhân viên) và B02 tổng hợp cộng đúng; (b) người dùng scope B gọi `/api/payroll/runs`, `/api/costing/runs/*`, `/api/tncn/*` → không lộ/không thấy số của A; (c) đảo bảng lương → chi nhánh thừa kế; (d) mở rộng `sensitiveSweep` có cờ chi nhánh.

**F2 (Cao) Bản vá hợp nhất che lỗi thay vì kiểm tương tác.**
Bằng chứng: commit `daeafe7` chỉ sửa `apps/api/test/branches.test.ts:24` thêm `'view_salary'` vào cờ của người dùng chi nhánh để test cũ xanh; `6f504dc` chỉ đổi kỳ vọng ở `dataCheckGd2/settings/seed-abc`. Không có test mới khẳng định: người dùng chi nhánh **thiếu** `view_salary` xem Nhật ký chung/Sổ cái/tổng hợp (`/api/reports/ledgers/*`, `/api/reports/consolidated/B01|B02`) thì dòng lương (334/BH) bị che đúng (`hideSalary`, `reporting/routes.ts:58`) mà vẫn lọc đúng theo chi nhánh. `sensitiveSweep.test.ts:7` giới hạn SCOPE vào `/api/payroll|tncn|costing|contracts|projects/pnl` — không quét `/api/budget`, `/api/approvals`, `/api/branch*`, `/api/reports/consolidated`. `branch/routes.ts:121` chỉ cần `report.view` cho báo cáo tổng hợp.
Kịch bản lọt: hồi quy che lương ở sổ theo chi nhánh hoặc báo cáo tổng hợp không bị bắt.
Đề xuất: test người dùng chi nhánh không có `view_salary`/`view_cost` đọc ledgers + consolidated + budget actual (TK 334/6421 dòng lương) + approval mobile; mở rộng SCOPE của sweep sang các route GĐ7.

**F3 (Cao) Giá thành: phương pháp `ratio` và `order`, dở dang theo sản lượng tương đương chỉ được test ở tầng domain, không qua API/DB.**
Bằng chứng: `objects.ts:15` cho phép 5 phương pháp `simple|coefficient|ratio|project|order`; `grep "ratio|'order'" test/costing test/sample-abc-gd6.test.ts test/invariants/inv10*.ts` không ra gì; `costRun.test.ts:56-57` chỉ dùng `simple`, `coefficient`, `project`; `wipMethod` duy nhất xuất hiện là `direct_material` (`costRun.test.ts:84`). Domain đã có test tính tay tốt (`packages/domain/test/productCost.test.ts` mục (a)–(f)).
Kịch bản lọt: lỗi nối dữ liệu (định mức khoản mục → `ratio`, số lượng đơn hàng → `order`, mức hoàn thành dở dang → `wipEquivalentUnits`, thiếu định mức → `PRODUCT_COST_STANDARD_MISSING` trả sai mã HTTP) và chứng từ GT sinh sai Nợ 154/Có 621–627 cho 2 phương pháp này.
Đề xuất: thêm 2 đối tượng `ratio` (có định mức) và `order` vào `costRun.test.ts` với số tính tay; 1 đối tượng `wipMethod: equivalent` mức 50%; mở rộng inv10(b) chọn ngẫu nhiên phương pháp.

**F4 (Cao) Hợp nhất chi nhánh: chỉ có kịch bản cân; thiếu nhánh lệch, ngoại tệ, doanh thu nội bộ.**
Bằng chứng: `branches.test.ts:154-165` (B01 `internalNet === '0'`, loại 2000) và `:166-173` (khai báo thêm tiền tố `511` để kiểm `elimination` = 1100, chứng tỏ cột loại trừ chạy, không phải loại trừ nghiệp vụ đúng). `consolidated.ts:23` có nhánh `internalNet ≠ 0` ("phải thu/phải trả nội bộ chưa khớp") nhưng không test nào đặt nó ≠ 0 hay kiểm cảnh báo. Mặc định chỉ `['136','336']`. Không có test cho nội bộ bằng ngoại tệ, cho nội bộ chênh lệch số (A ghi phải thu 2000, B ghi phải trả 1800), cho đơn vị ngoài phạm vi người dùng làm `internalNet` lệch, cho loại trừ giá vốn/doanh thu nội bộ (B02), cho chi nhánh có `is_branch` bị tắt giữa kỳ.
Kịch bản lọt: BCTC tổng hợp cân giả (tổng tài sản = nguồn vốn) trong khi nội bộ lệch; người dùng scope hẹp thấy số loại trừ thiếu.
Đề xuất: test A–B lệch 200 → `internalNet = '200'` và có cảnh báo; nội bộ USD; B02 với bán nội bộ 511/632 qua tiền tố; scope hẹp (A only) → `internalNet` tính trên đơn vị thấy được và không ném.

### Trung bình

**F5 (Trung bình) Quyết toán TNCN năm: nhánh loại trừ và năm lẻ chưa có test.**
Bằng chứng: `tncnReturn.ts:131-136,146` — loại trừ khi `residency !== 'resident' || contractType !== 'long'` và `selfMonths = số tháng có giảm trừ bản thân`. `tncn.test.ts:109-117` chỉ kiểm NV20 (đủ 12 tháng) và NV03 (không ủy quyền). Không test: không cư trú, hợp đồng dưới 3 tháng, nhân viên vào/nghỉ giữa năm (`selfMonths<12`), cảnh báo "tham số đổi trong năm" (`:148`), `pitBase` kẹp về 0 (`pitAnnualSettlement` `Decimal.max(...,0)`: chưa có test domain cho kẹp này — `payroll.test.ts:167` chỉ dùng fixture 12 tháng hoàn thuế), thu nhập 0 cả năm.
Đề xuất: bổ sung 3 nhân viên fixture (nghỉ việc tháng 6; không cư trú; học việc) với số tính tay, 1 test domain `pitAnnualSettlement` có giảm trừ > thu nhập (base 0, difference = −withheld), 1 test `selfMonths=6`.

**F6 (Trung bình) BHXH/BHYT/BHTN: thiếu ranh giới và tổ hợp.**
Bằng chứng: `payroll.test.ts:55-69` kiểm 80tr (vượt trần BHXH, dưới trần BHTN), 4tr (dưới sàn), 150tr với trần chung. Không có: lương đúng bằng trần/sàn ±1; `uiCeiling < ceiling` (BHTN trần thấp hơn); chỉ `ui` hoặc chỉ `occupational` bật; lương đóng âm/0 khi không đặt `floor` (`siContributions` `Decimal.min(raw, ceiling)` cho kết quả âm nếu `base` âm và không có sàn; chưa có test hay guard rõ ràng — cần xác minh); làm tròn nửa lên ở 0,5 đồng (tỷ lệ 8%×giá trị lẻ) — chỉ ví dụ chẵn; tỷ lệ/trần đổi giữa tháng chỉ có cảnh báo `PARAM_CHANGED_IN_PERIOD` (`runs.test.ts:249-254`) cho `pit_non_resident_rate`, không cho `si_*` hay vùng lương tối thiểu.
Đề xuất: test bảng ranh giới (trần−1, trần, trần+1; sàn−1, sàn, sàn+1) và test thuộc tính `employee.si + employer.si` tuyến tính theo base trong [sàn, trần]; test đổi `si_base_max` giữa tháng.

**F7 (Trung bình) Flaky tiềm ẩn do ngày thực trong e2e chi nhánh.**
Bằng chứng: `apps/web/e2e/chi-nhanh.spec.ts:35-36` dùng `new Date().toISOString()` làm `postingDate` với năm tài chính cố định 2026 (`:7-8`), "Sổ sách mặc định xem tháng hiện tại". Từ 01/01/2027 tạo chứng từ ngoài kỳ → spec đỏ không do mã. Cũng đúng khi chạy trên DB e2e đã có năm tài chính khác.
Đề xuất: cố định ngày trong 2026 và đặt tham số `from/to` trên URL sổ.

**F8 (Trung bình) Test đồng thời dựa vào ngủ cố định.**
Bằng chứng: `settlement.test.ts:458` (500 ms rồi khẳng định `pending`), `closing.test.ts:117-124` (300 ms hai lần), `numbering.test.ts:17` (race 500 ms), `signing/agent.test.ts:60-61` (50–200 ms), `sinvoice.test.ts:238` (200 ms), `bang-luong.spec.ts:31` (`waitForTimeout(200)`). Khi máy tải (2 CPU, đã ghi nhận ở TIEP-THEO/QĐ #91, #8 gĐ1.5), khẳng định "đang chờ khóa" có thể đúng vì truy vấn chưa tới được khóa → test xanh giả (không kiểm khóa). `periods.test.ts:118-123` làm đúng (thăm dò `pg_stat_activity.wait_event_type='Lock'`) — nên áp dụng mẫu này cho các test trên.

**F9 (Trung bình) Hóa đơn điện tử SInvoice: vòng đời đầy đủ chỉ chạy với nhà cung cấp giả.**
Bằng chứng: `sinvoiceMock` chỉ được import bởi `sinvoice.test.ts` (adapter). `lifecycle.test.ts` và `issue.test.ts` (`reconcilePending` tại `lifecycle:225`, `issue:210`) dùng `fakeProvider`. Không test: issue → timeout → reconcile → `findByTransaction` qua mock SInvoice; thay thế/hủy qua adapter SInvoice (adjustmentType 3/5 chỉ kiểm payload, `sinvoice.test.ts:107-140`). Phần còn lại (hai pha, thay thế, hủy, orphan, CASH_NEGATIVE) được phủ rất kỹ — đây là điểm mạnh.
Đề xuất: 1 test tích hợp chạy `issue/replace/cancel` + `reconcilePending` với `sinvoiceMock`.

### Thấp

**F10 (Thấp)** `playwright` không có sẵn trong CI này? Trình duyệt có tại `~/Library/Caches/ms-playwright/chromium-1248`, nhưng e2e cần tài khoản `e2e` trên DB dev (`kiem-thu.md`), không có DB tạm tự động → e2e không tự chứa, dễ trộn với DB `ketoan`; không chạy e2e trong lần rà này.
**F11 (Thấp)** `describe.skipIf(!hasPgDump)` ở `apps/worker/test/backup.test.ts:25` — test sao lưu im lặng bỏ qua khi máy không có `pg_dump`; CI nên khẳng định `pg_dump` hiện diện. Đây là chỗ `.skip` duy nhất trong test (không có `.only`, `.todo`, `it.skip`, `xit` trong `apps/api/test`, `apps/web/e2e`, `apps/worker`).
**F12 (Thấp)** TIEP-THEO.md:152 ghi "E2E sổ quỹ rớt một lần khi chạy cả bộ", QĐ gĐ1.5 #8 "`Periods.test.tsx` thỉnh thoảng quá thời gian khi máy bận" — chưa ghi nguyên nhân gốc; coi là flaky do tải, chưa có lần xác nhận lại sau GĐ6/7.
**F13 (Thấp)** Môi trường: node_modules lệch lockfile (thiếu `qrcode`...) làm sập mọi test API; cần bước `pnpm install --frozen-lockfile` bắt buộc trong tài liệu/CI trước khi chạy test.

## 2. Ma trận độ phủ logic khó

| Logic | Test tính tay/biên | Nhánh thiếu |
|---|---|---|
| TNCN lũy tiến | Tốt: `payroll.test.ts:27-53` (≤0, đúng mốc 10/30/60/100tr, làm tròn nửa lên, biểu sai) + fast-check đơn điệu | thu nhập cực lớn; biểu thuế đổi giữa kỳ |
| Giảm trừ + quyết toán | Một cá nhân 12 tháng (fixture NV20) | F5 |
| BHXH/BHYT/BHTN | Trần, sàn, trần BHTN riêng, không tham gia | F6 |
| Giá thành 5 phương pháp | Domain tốt (`productCost.test.ts`, fast-check cân bằng); API chỉ simple/coefficient/project | F3 (ratio, order, tương đương) |
| Hợp nhất chi nhánh | Chỉ kịch bản cân 2 chi nhánh | F4 |
| HĐĐT hai pha, đối soát, hủy/thay thế | Rất tốt (`lifecycle.test.ts` 14 test) | F9 |
| Đánh giá lại ngoại tệ | Rất tốt (`fxRevaluation.test.ts` ~35 test, số cụ thể, làm tròn khoản con, TT99/TT133) | không thấy nhánh lớn thiếu |
| Khấu hao | Tốt (`depreciation.test.ts` domain: month_day, dừng, ghi giảm, tổng chia 7 kỳ) + `inv8` | khấu hao theo chi nhánh chưa có (F1) |

## 3. Bảng "Trang chưa có e2e"

Cách xác định: so route `path` trong `apps/web/src/router.tsx` với `goto(...)`/từ khóa trong `apps/web/e2e/*.spec.ts` (64 spec, 93 trang). Trang có spec mà chỉ 1 test luồng chính không liệt kê.

| Trang / route | Thuộc | Ghi chú |
|---|---|---|
| `/tien-ich/soat-loi` (DataCheck, gồm quy tắc soát GĐ6) | GĐ2/GĐ6 | không spec nào |
| `/tien-ich/xuat-du-lieu` (Export) | GĐ4-5 | không spec |
| `/luong/tham-so` (PayrollParams) | GĐ6 | các spec lương chỉ dùng API để nạp tham số; không có luồng giao diện nhập/sửa tham số theo ngày hiệu lực |
| PayrollRunImport (nhập bảng lương Excel), PayrollPaymentFile/Formats (`/luong/mau-chi-luong` có 1 goto; tệp chi lương) | GĐ6 | kiểm tra: `chi-luong-lo`, `chi-luong` phủ một phần; luồng nhập Excel bảng lương không thấy |
| `/hoa-don-dien-tu/thong-bao-sai-sot` (EInvoiceErrorNotice) | GĐ5 | không spec |
| `/he-thong/nguoi-dung` (Users, gồm phạm vi chi nhánh, cờ nhạy cảm) | GĐ1/GĐ7 | không spec; luồng gán chi nhánh/cờ view_salary không có e2e |
| `/he-thong/nhat-ky` (AuditLog) | GĐ1 | không spec |
| `/he-thong/tao-cong-ty` (CompanyWizard) | GĐ1 | không spec |
| `/so-cai/ky-ke-toan` (Periods) | GĐ1 | chỉ nhắc gián tiếp trong `ty-gia`, `phan-bo-doanh-thu` |
| `/so-cai/ket-chuyen` | GĐ1/2 | chỉ qua `cuoi-ky` (đi theo bước cuối kỳ) |
| `/danh-muc/he-thong-tai-khoan` (Accounts), `/danh-muc/nhap-excel` (ImportExcel) | GĐ1 | không spec |
| Phê duyệt trên di động (`approval/mobile`) | GĐ7 | `phe-duyet.spec.ts` có 1 test; mobile chỉ test API (`test/approval/mobile.test.ts`) |
| Ngân sách / hình thức sổ / song ngữ / chi nhánh / HKD | GĐ7 | mỗi trang chỉ 1 test luồng chính (`ngan-sach` 1, `hinh-thuc-so` 1, `chi-nhanh` 1, `hkd-sieu-nho` 24 dòng — chỉ kiểm cảnh báo chế độ, không có luồng sổ HKD) |
| Giao điểm chi nhánh × lương/giá thành trên giao diện | GĐ6×GĐ7 | không spec (xem F1) |
| `/gia-thanh/chay` luồng giá thành đầy đủ 5 phương pháp | GĐ6 | `chay-gia-thanh` 1 test; không có spec ratio/order |
| Khoản vay (`/khe-uoc` = Loans) | GĐ4 | có `khe-uoc.spec.ts` (đã phủ) |

Chưa chạy e2e (không thử, lý do: cần DB dev cho tài khoản `e2e`, quy tắc không dùng DB `ketoan`).

## 4. Dấu hiệu flaky (tổng hợp)
- `.skip/.todo/.only`: chỉ `apps/worker/test/backup.test.ts:25` (`describe.skipIf`). Không `.only`.
- Ngủ cố định: F8. Phụ thuộc thời gian thực: F7; `Date.now()` dùng sinh mã công ty/người dùng (`TN${Date.now()}`, `inv7 I7${Date.now()}${n++}`) — an toàn do chạy tuần tự, nhưng hai `makeUser` cùng tên trong cùng ms sẽ trùng; hiện khác tên.
- Phụ thuộc thứ tự: các test trong một tệp chia sẻ tenant `beforeAll` và nhiều `it` nối tiếp trạng thái (vd `lifecycle.test.ts`, `fxRevaluation.test.ts`, `branches.test.ts` cuối tệp đổi `branch-scope` rồi "xóa phạm vi": test cuối phụ thuộc test trước). Chạy riêng một `it` bằng `-t` sẽ lỗi — không phải flaky nhưng giảm khả năng cô lập.
- Ghi chú rớt thỉnh thoảng: TIEP-THEO.md:152 (sổ quỹ e2e), QĐ gĐ1.5 #6,#8, QĐ gĐ2 #91.

## 5. (e) Test sau hợp nhất có kiểm điểm hòa giải?
Không. `daeafe7` và `6f504dc` chỉ vá kỳ vọng/cờ (F2). Chưa có test nào đồng thời đụng `payroll`/`costing` và `branch` (F1). Migration chi nhánh 0240/0241 và GĐ6 0100–0111 được áp dụng nối tiếp (không xung đột số), `inv1–inv10` pass sau hợp nhất nhưng không có chiều chi nhánh.


---

## Phụ lục G — truc7-giao-dien

### Trục 7 – Giao diện và tài liệu (main, daeafe7)

Phạm vi: `packages/ui`, `packages/domain/src/gridKeyboard.ts`, `apps/web/src/pages`, `apps/api/src/plugins/errors.ts`, `docs/user/*.md`. Chỉ đọc mã, chưa chạy giao diện; các mục ghi "cần kiểm chứng" là suy luận từ mã.

Đánh giá chung: lưới chung `KeyboardGrid` làm tốt phần lõi (Enter/Tab/F4/Ctrl+Insert/Ctrl+Delete, chặn Enter khi gõ Telex/VNI bằng `isImeComposing`, `lockRows`, giữ focus). Lỗi tập trung ở: phím tắt toàn trang bị vô hiệu khi focus ở ô nhập, form Enter-để-lưu không chặn IME, không có chặn rời trang khi chưa lưu, mô tả cờ nhạy cảm còn "ba cờ" sau khi thêm `view_salary`, và vài chỗ tài liệu lệch mã.

Tổng: 0 nghiêm trọng, 6 cao, 14 trung bình, 9 thấp.

---

## Cao

### C1. Ctrl+S không lưu khi con trỏ đang ở ô lưới (Tồn kho đầu kỳ, Số dư đầu kỳ tài sản)
- `apps/web/src/pages/OpeningStock.tsx:62`, `apps/web/src/pages/AssetOpening.tsx:67` dùng `useHotkeys({ 'Ctrl+s': ... })`; `packages/ui/src/useHotkeys.ts:6` và `:15` bỏ qua phím khi `target` nằm trong `input, textarea, select` (`isTyping`). Ô đang sửa của AG Grid là `<input>`.
- Kịch bản: kế toán nhập số lượng ở ô, bấm Ctrl+S. Hook bỏ qua, không `preventDefault`, trình duyệt mở hộp "Lưu trang". Dữ liệu chưa lưu. Chỉ khi focus ở ô không sửa hoặc ở nút mới lưu được. Các trang chứng từ khác (VoucherForm, InvoiceForm...) tự gắn `window.addEventListener` nên không bị.
- Sửa: dùng mẫu của VoucherForm (listener riêng, `stopEditing()` rồi lưu), hoặc thêm tùy chọn `allowInInputs` cho `useHotkeys` với phím có Ctrl/F-key; kiểm Playwright "gõ ô rồi Ctrl+S".

### C2. Form "Enter để lưu" không chặn bộ gõ tiếng Việt, Enter chốt chữ lại gửi form
- `apps/web/src/pages/Contracts.tsx:63`, `Loans.tsx:52`, `PayrollProfiles.tsx:42`, `PayrollRuns.tsx:51`: `onKeyDown` kiểm `e.key === 'Enter'` và `tagName === 'INPUT'`, không gọi `isImeComposing`. (Amortization.tsx:66 và assetDialogs.tsx:102 làm đúng.)
- Kịch bản: gõ Telex "Công ty Hà Nội" vào ô tên/ghi chú, Enter để chốt chữ cuối, hộp thoại lưu ngay, mất lúc đang nhập dở hoặc lưu bản chưa đủ. Tên bảng lương, hợp đồng, khế ước đều là chữ tiếng Việt.
- Sửa: `if (isImeComposing(e.nativeEvent)) return;` ở đầu mọi handler; gom thành tiện ích `submitOnEnter` trong `@kt/ui` để khỏi lặp 6 chỗ. Thêm kiểm thử đơn vị cho tiện ích.

### C3. Không có chặn rời trang khi dữ liệu chưa lưu (đổi menu, đổi dòng chọn, đóng Drawer/Modal)
- `packages/ui/src/useUnsavedChanges.ts:4-5` tự nói "Không dính router"; toàn repo không có `useBlocker`. Chỉ 9 trang dùng hook, và hook chỉ chặn đóng tab/F5 và các lệnh gọi `confirmIfDirty` tường minh.
- Kịch bản 1: nhập 20 dòng Phiếu kế toán, bấm nhầm menu trái, trang đổi mà không hỏi (kể cả VoucherForm).
- Kịch bản 2 (GĐ6): `PayrollProfiles.tsx:281` + `:291` (`<Editor key={sel}>`) và `:269`: phím mũi tên trong danh sách nhân viên đổi `sel`, Editor dựng lại, mất hết hồ sơ lương/phụ cấp/người phụ thuộc đang sửa. Không có `dirty` ở `PayrollProfiles.tsx`, `PayrollStructures.tsx:164` (đổi cấu trúc khi sửa dở công thức).
- Kịch bản 3 (GĐ7): `Budget.tsx:69` (Modal `onCancel={onClose}`), `Contracts.tsx:234` (Drawer `onClose`), `CostNorms.tsx:75`, `Orders.tsx:91`, `PriceLists.tsx:75`: Esc, bấm nền, nút X đều đóng không hỏi. Trang nhập lưới `OpeningStock`, `AssetOpening`, `Stocktake`, `CashCount`, `AssetCount` không có `useUnsavedChanges` nên cả F5 cũng mất dữ liệu.
- Sửa: thêm `useBlocker` của TanStack Router vào `useUnsavedChanges` (hoặc hook `useGuardedClose`), đặt `maskClosable={false}` cho Modal/Drawer chứa lưới hoặc form dài; thêm `dirty` cho PayrollProfiles/PayrollStructures.

### C4. Esc khi đang sửa ô trong lưới đặt trong Modal/Drawer có thể đóng cả hộp thoại (cần kiểm chứng)
- Budget.tsx:69-82, CostNorms.tsx:75-88, Orders/PriceLists: Modal antd mặc định `keyboard=true`. `KeyboardGrid.tsx:69-78` không chặn lan truyền Esc; AG Grid hủy sửa ô nhưng sự kiện vẫn nổi bọt tới Modal.
- Kịch bản: nhập ngân sách 12 tháng, gõ nhầm, bấm Esc để hủy ô, cả cửa sổ đóng, mất toàn bộ lưới (kết hợp C3).
- Sửa: trong `suppressKeyboardEvent`, khi `Escape` và ô đang sửa thì `stopPropagation`; hoặc `keyboard={false}` cho Modal có lưới và tự xử lý.

### C5. Thông báo và tài liệu còn nói "ba cờ nhạy cảm" trong khi mã đòi bốn (thêm `view_salary` ở GĐ6)
- Mã đúng: `packages/domain/src/permissions.ts:4` (4 cờ), `apps/api/src/modules/reporting/ledgers.ts:208`. Văn bản sai:
  - `apps/web/src/pages/Ledgers.tsx:73`: "cần đủ các quyền xem công nợ phải thu, phải trả và giá vốn" (thiếu lương).
  - `apps/web/src/pages/Export.tsx:31`: cùng câu, kèm `missing.join(', ')` in thô `view_salary, view_cost`.
  - `apps/web/src/pages/Analytics.tsx:50`: "Cần đủ quyền xem giá vốn, công nợ phải thu và phải trả để tính hệ số" nhưng `analytics.ts:58,90` còn đòi `view_salary`; `HIDDEN_LABEL` (`Analytics.tsx:16`) cũng không có `view_salary`.
  - `docs/user/giai-doan-7-hinh-thuc-so.md:5` ("ba quyền"), `docs/user/giai-doan-7-ngan-sach-phan-tich.md:52` ("đủ ba cờ"), comment `apps/api/src/modules/reporting/bookFormRoutes.ts:18`.
- Kịch bản: Kế toán trưởng có đủ ba cờ cũ nhưng thiếu lương mở Sổ sách/Phân tích: ô bị khóa, thông báo bảo "cần đúng ba quyền bạn đang có", không biết thiếu gì. Đây chính là phần giao GĐ6 x GĐ7 mà commit gần nhất (daeafe7) vừa sửa trong test.
- Sửa: dựng thông báo từ danh sách cờ thiếu với nhãn tiếng Việt (xem T14); cập nhật 2 tài liệu; thêm "xem lương" vào `HIDDEN_LABEL`.

### C6. Tài liệu GĐ7 Đa chi nhánh không nói gì về lương, chấm công, giá thành, hợp đồng khi người dùng bị giới hạn chi nhánh
- `docs/user/giai-doan-7-da-chi-nhanh.md:30-33` liệt kê các phân hệ bị tắt (công nợ, quỹ, kho, tài sản, thuế...) nhưng không có Lương, Chấm công, Giá thành, Hợp đồng/Vụ việc, Ngân sách, Phê duyệt. Phần chứng từ lương `LU`/giá thành `GT` thuộc chi nhánh nào cũng không được nêu (khác với "KC thuộc trụ sở chính", `:23`). Mục 4 (`:35-40`) chưa nhắc điều kiện bốn cờ để xem Nhật ký chung/BCĐPS của người bị giới hạn chi nhánh.
- Kịch bản: quản trị viên giới hạn Kế toán chi nhánh A, người này bấm vào Lương hay Giá thành và gặp lỗi hoặc thấy dữ liệu mà tài liệu không hề giải thích.
- Sửa: bổ sung mục "Chi nhánh và các phân hệ GĐ6/GĐ7" (đối chiếu `branchRouteDenied` và danh sách quyền được giữ trong `loadBranchScope`), nêu rõ phân hệ nào bị tắt, chứng từ lương/giá thành gắn chi nhánh làm việc của người chạy.

---

## Trung bình

### T1. Phím F9 qua `useHotkeys` chết khi focus ở ô Select/DatePicker/ô số; còn F9 trong phân hệ GĐ6 mang nghĩa "chạy", không phải "ghi sổ"
- `CostRuns.tsx:63`, `CostingRun.tsx:58`, `ProjectAlloc.tsx:68`, `PeriodClose.tsx:44` (và `CitEstimate.tsx:44`) dùng `useHotkeys`. Chọn "Năm tài chính"/"Kỳ" bằng antd Select thì focus ở `<input>` ẩn của Select, `isTyping` đúng, F9 bị bỏ.
- Kịch bản: chọn kỳ 10 xong bấm F9 để "Chạy" giá thành, không phản ứng, người dùng tưởng máy treo. Phải bấm chuột ra ngoài rồi F9.
- Sửa: cho `useHotkeys` tham số cho phép phím F-key trong ô nhập (F-key không gây ký tự).

### T2. F9 chạy bước kết chuyển/phân bổ/giá thành ngay, không xác nhận
- `PeriodClose.tsx:43-44` `runNext` gọi `run.mutate` trực tiếp; `CostRuns.tsx:63,90` và `ProjectAlloc.tsx:68,91` tương tự (sinh chứng từ GT). Hai nút "Chạy" cũng bấm thẳng. Một phím chạm nhầm sinh chứng từ thật.
- Sửa: `Modal.confirm` cho bước có tác động sổ (nội dung nói rõ chứng từ sẽ sinh/đảo), hoặc ít nhất khi kỳ đã có kết quả cũ.

### T3. "Bỏ ghi sổ" chạy ngay khi bấm nút (nếu không có thay đổi chưa lưu)
- `VoucherForm.tsx:376`, `InvoiceForm.tsx:411`, `StockVoucher.tsx:194`, `LandedCost.tsx:202`, `AssemblyVoucher.tsx:152`: `confirmIfDirty(() => action.mutate({ act: 'unpost' }))`; `confirmIfDirty` chỉ hỏi khi `dirty`. Trong khi "Hủy" cùng thanh nút có `Modal.confirm`. Tương tự `PayrollRuns.tsx:221` ("Chạy lại hạch toán") không xác nhận; "Hủy hạch toán" (`:222`) có Popconfirm.
- Kịch bản: Bỏ ghi sổ phiếu xuất kho làm đổi giá vốn các phiếu sau; bấm nhầm là xảy ra, chỉ khôi phục bằng ghi sổ lại.
- Sửa: Popconfirm/Modal.confirm với câu giải thích hệ quả (kho: tính lại giá vốn; hóa đơn: không có hóa đơn điện tử đã phát hành).

### T4. Ctrl+Delete xóa dòng không xác nhận/không hoàn tác; Ctrl+Insert trùng phím Sao chép của Windows
- `packages/domain/src/gridKeyboard.ts:31-32`, `KeyboardGrid.tsx:51`: Ctrl+Delete xóa cả dòng và `preventDefault`, kể cả khi con trỏ đang trong ô chữ (mặc định là "xóa từ"). Ctrl+Insert (Windows = Copy) bị chặn nên không sao chép được nội dung ô bằng phím này.
- Sửa: chỉ xử lý khi không đang sửa ô (hoặc cần Ctrl+Shift+Delete), kèm Ctrl+Z gần nhất qua `undo`; ghi trong tài liệu. Cân nhắc thêm Ctrl+I/Ctrl+Shift+Insert cho Mac, bàn phím không có Insert.

### T5. Tab trong lưới không rời khỏi lưới được (bẫy bàn phím)
- `gridKeyboard.ts:33-37` + `KeyboardGrid.tsx:73-75`: Tab giống Enter, ở ô cuối thêm dòng mới và `preventDefault`. Chỉ Shift+Tab ra được; Tab tiến không bao giờ tới nút Lưu/Ghi sổ sau lưới (trừ `lockRows`).
- Kịch bản: người dùng chỉ dùng bàn phím (và công cụ đọc màn hình) không thể rời lưới bằng Tab; mỗi lần thử sinh thêm dòng trống.
- Sửa: Tab ở ô sửa được cuối cùng của dòng cuối khi dòng trống thì nhả cho trình duyệt (hoặc Ctrl+Tab/Esc rồi Tab thoát), cập nhật `gridKeyAction` + tài liệu.

### T6. Phím tắt "Insert thêm dòng" trong tài liệu GĐ6/GĐ7 sai với mã; Insert đơn lẻ không thêm dòng trong lưới
- Mã: thêm dòng trong lưới là Ctrl+Insert (`gridKeyboard.ts:32`); Insert trần chỉ mở hộp thoại thêm bản ghi ở màn danh sách.
- Tài liệu sai: `docs/user/giai-doan-6-luong-gia-thanh-hop-dong.md:21` ("Insert thêm dòng"), `docs/user/giai-doan-7-ngan-sach-phan-tich.md:10` ("Insert chèn dòng"). Trong lưới ngân sách (Budget.tsx:82) Insert không làm gì. GĐ1 (`giai-doan-1-so-cai.md:15`) ghi đúng.
- Sửa: sửa hai tài liệu thành "Ctrl+Insert chèn dòng, Ctrl+Delete xóa dòng".

### T7. Tài liệu GĐ6 khẳng định Mẫu tệp chi lương có phím Insert, mã không có
- `docs/user/giai-doan-6-luong-gia-thanh-hop-dong.md:31`: "Mẫu tệp chi lương | Insert, Ctrl+S | Thêm mẫu; lưu". `PayrollPaymentFormats.tsx` không import/dùng `useHotkeys` (nút ở `:97`). Ctrl+S trong hộp thoại thì có (`:42`).
- Cũng thiếu Insert ở Cấu trúc bảng lương (`PayrollStructures.tsx:158`) và Tham số lương (`PayrollParams.tsx:135`) mặc dù các màn khác cùng loại đều có.
- Sửa: thêm `useHotkeys({ Insert })` cho 3 màn, hoặc bỏ khỏi bảng phím.

### T8. Hàng của bảng chỉ mở bằng chuột (GĐ6): không dùng được bằng bàn phím
- Chỉ `onClick`, không `tabIndex`/`onKeyDown`: `PayrollRuns.tsx:279` (danh sách bảng lương), `PayrollStructures.tsx:164`, `PayrollProfiles.tsx:134,144` (phụ cấp, người phụ thuộc), `CostRuns.tsx:150`, `CostingRun.tsx:117`. Các màn GĐ4/5 có (`Assets.tsx:154`, `Contracts.tsx:268`...).
- Kịch bản: yêu cầu "nhập liệu bằng bàn phím là cốt lõi" nhưng muốn mở bảng lương tháng 10 phải dùng chuột. Branches/Budget/Approvals chỉ có `onDoubleClick` (`Branches.tsx:31`, `Budget.tsx:106`, `Approvals.tsx:265`) nhưng có nút Sửa/Truy ngược dùng bàn phím được (Branches, Budget) nên không tính lỗi.
- Sửa: tiện ích `rowProps(onOpen)` dùng chung trả `{ onClick, tabIndex: 0, onKeyDown: Enter/Space, role: 'button' }` (đồng thời tránh Enter nổi bọt từ nút bên trong, như `Approvals.tsx:181`).

### T9. Liên kết `<a onClick>` không có `href` nên không focus được bằng Tab (nút Sửa/Xóa ở GĐ6)
- `PayrollPaymentFormats.tsx:62,106`, `PayrollParams.tsx:35,127,143`, `PayrollStructures.tsx:111`, `PayrollProfiles.tsx:164` (và `Approvals.tsx:131`, `BankTransactions.tsx:189`). Thẻ `<a>` không `href` không nằm trong tab order, đọc màn hình không nhận là nút.
- Sửa: dùng `<Button type="link" size="small">`.

### T10. Lưới ngân sách thiếu F4 tra cứu cho Tài khoản/Khoản mục/Bộ phận/Dự án
- `Budget.tsx:82` không truyền `onLookup`; cột `accountPrefix, costItemCode, departmentCode, projectCode` là chữ tự do (`Budget.tsx:34-37`). Tài liệu `giai-doan-7-ngan-sach-phan-tich.md:13-14` bảo "nhập mã có trong danh mục". Cột Chi nhánh "Đơn vị cấp trên" (`Branches.tsx:44`) cũng chữ tự do.
- Kịch bản: gõ "6421" thành "64211" hoặc mã bộ phận sai dấu, lỗi chỉ báo sau khi lưu; không F4 như mọi lưới khác.
- Sửa: dùng `onLookup` mở `LookupSelect` như `CostNorms.tsx`/`Contracts.tsx`.

### T11. Nhập Excel ngân sách ghi ngay vào dữ liệu và bỏ qua phần đang sửa
- `Budget.tsx:57-63,78`: `beforeUpload` gọi `importXlsx` với `mode=commit` ngay khi chọn tệp, rồi `detail.refetch()`; `useEffect` (`:42`) đặt lại `rows` bằng dữ liệu máy chủ. Tài liệu `giai-doan-7-ngan-sach-phan-tich.md:25` xác nhận "thay toàn bộ dòng".
- Kịch bản: đang sửa lưới, chọn nhầm tệp Excel, mọi dòng đang gõ và dòng đã lưu bị thay, không xác nhận, không bản xem trước (PayrollRunImport có `mode=validate`).
- Sửa: Popconfirm "Thay toàn bộ N dòng hiện có?" + kiểm tra hợp lệ trước (đã có API validate ở các nơi khác).

### T12. Lưới AG Grid chưa Việt hóa (trạng thái rỗng "No Rows To Show", menu cột, bộ lọc)
- `packages/ui/src/KeyboardGrid.tsx:79`: `<AgGridReact>` không có `localeText`, `overlayNoRowsTemplate`, `overlayLoadingTemplate` (toàn repo không có). Lưới chỉ đọc (Sổ cái, báo cáo công nợ, `Ledgers.tsx`, `CashBooks.tsx`, `ArapReports.tsx`, báo cáo giá thành...) khi không có dòng hiện tiếng Anh. `main.tsx:17` chỉ Việt hóa antd (`vi_VN`).
- Sửa: một bộ `localeText` tiếng Việt kế toán trong `@kt/ui`, truyền mặc định; thông báo rỗng "Không có dữ liệu trong kỳ đã chọn".

### T13. Tải tệp bằng `window.open`/`<a href>` hiện JSON thô khi lỗi; `apiBlob` ném nguyên thân JSON
- `packages/ui`/`apps/web/src/api/client.ts:19`: `throw new ApiError('HTTP', await res.text(), ...)`, người dùng thấy `{"error":{"code":"FORBIDDEN","message":...}}` ở `Approvals.tsx:111` và `EInvoices.tsx:98`.
- `Ledgers.tsx:98`, `ContractReports.tsx:63`, `PayrollReports.tsx:80`, `CostReports.tsx:53`, `Budget.tsx:79` mở tab mới trỏ thẳng `/api/...`: thiếu cờ nhạy cảm hoặc hết phiên thì tab mới hiện JSON (hoặc tải về tệp JSON đuôi `.xlsx` ở `Budget.tsx:79`).
- Sửa: `apiBlob` đọc JSON `error.message`; tải qua `fetch` rồi `createObjectURL` (mẫu `Ledgers.tsx` bộ sổ năm, đã làm đúng) hoặc kiểm tra trước bằng HEAD.

### T14. Mã lỗi/mã quyền thô lộ ra người dùng
- `apps/web/src/pages/voucherCommon.tsx:30`, `OpeningBalance.tsx:69`, `InvoiceForm.tsx:418`: nối `(${e.code})` vào mọi lỗi, ví dụ "…(PERIOD_LOCKED)".
- `apps/api/src/plugins/auth.ts:61`: `Thiếu quyền ${code}` (ví dụ "Thiếu quyền payroll.update"); `openingBalance.ts:368,378`, `landedCost.ts:157`, `inventory/reports.ts:250` ghi tên cờ `(view_cost)`, `(view_salary)`.
- `apps/api/src/plugins/errors.ts`: `e.validation` trả `e.message` của Fastify (tiếng Anh, vd "body/xxx must be string"); lỗi `statusCode<500` trả message thô (vd "Unsupported Media Type"); `ZodError` chỉ trả "Dữ liệu không hợp lệ" kèm `issues` tiếng Anh nên đa số trang không chỉ ra ô sai (chỉ `OpeningBalance.tsx:67`, `AssetOpening.tsx:56`, `OpeningStock.tsx:55` đọc `details`). Hàm SQL `RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %'` (32 chỗ, migration 0004/0005...) sinh message chỉ là UUID.
- Sửa: bảng nhãn quyền/cờ tiếng Việt dùng chung ("Bạn chưa có quyền sửa bảng lương"); map ZodError/Fastify validation thành "Trường X: …" tiếng Việt; thay `%` bằng câu đầy đủ trong migration mới; bỏ hậu tố mã khỏi người dùng thường (giữ trong chi tiết kỹ thuật/hover).

---

## Thấp

- **L1. Thuật ngữ: "Hạch toán" và "Ghi sổ".** Phiếu: "Ghi sổ (F9)"/"Bỏ ghi sổ"; Bảng lương: "Hạch toán"/"Chạy lại hạch toán"/"Hủy hạch toán" (`PayrollRuns.tsx:220-222`); tab "Hạch toán" lại là danh sách định khoản (`VoucherForm.tsx:396`, `InvoiceForm.tsx:433`, `LandedCost.tsx:219`). Thống nhất: nút "Ghi sổ"/"Bỏ ghi sổ", tab "Định khoản". F9 trong bảng lương là "Tính" chứ không phải ghi sổ (`PayrollRuns.tsx:218`); nút Hạch toán không có phím.
- **L2. "Sổ cái" và "Sổ Cái".** Menu `router.tsx:161` viết thường, các màn và tab `Ledgers.tsx:164`, `BookForms.tsx:65` viết hoa "Cái", tài liệu lẫn lộn. Chọn một dạng. Tương tự "Phiếu kế toán" (menu, doc GĐ1) và "chứng từ nghiệp vụ khác" (`CitEstimate.tsx:55`) cho cùng loại PKT; "Đối trừ chứng từ" (menu) và "Bù trừ công nợ" (loại BT).
- **L3. Enter chuyển ô trong tờ khai không chặn IME**: `CitReturn.tsx:71`, `VatReturn.tsx:105`, `CitEstimate.tsx:48` (ô số nên ít ảnh hưởng); `onPressEnter` ở `ArapReports.tsx:137`, `ContractReports.tsx:113`, `AuditLog.tsx:38` có thể kích hoạt lọc khi đang gõ dấu.
- **L4. Duyệt đề nghị chi tiền chỉ một lần bấm** (`Approvals.tsx:142`, nút `large` trên điện thoại, tạo Phiếu chi nháp). Từ chối có hộp thoại lý do, Duyệt không có xác nhận; thêm Popconfirm "Duyệt đề nghị … số tiền …?".
- **L5. Insert toàn trang mở hộp thêm khi đang xem Drawer chi tiết**: `useHotkeys.ts:7` chỉ loại `.ant-modal`, không loại `.ant-drawer` (Approvals có Drawer chi tiết).
- **L6. Thiếu nhãn truy cập**: `Approvals.tsx:140` (ghi chú duyệt), `Branches.tsx:87` (RangePicker), `Contracts.tsx:261` (ô tìm kiếm) không có `aria-label`.
- **L7. Tải tệp** `Approvals.tsx:111` gọi `URL.revokeObjectURL` đồng bộ ngay sau `click()` và thẻ `<a>` không gắn DOM; có thể hủy tải ở một số trình duyệt (Ledgers.tsx đã dùng `setTimeout`).
- **L8. Thiếu Playwright theo quy tắc CLAUDE.md "mỗi màn hình một kiểm thử"**: không tìm thấy trong `apps/web/e2e` cho Soát lỗi dữ liệu (`DataCheck`), Xuất dữ liệu cho cơ quan thẩm quyền (`Export`), Nhật ký kiểm toán (`AuditLog`), Nhập Excel danh mục (`ImportExcel`), Người dùng (`Users`), Kết chuyển (`Closing`, chỉ qua `cuoi-ky`); Tham số lương chỉ xuất hiện qua API trong các tệp lương, chưa kiểm thử riêng màn hình `/luong/tham-so`. Không có kiểm thử gõ Telex/VNI, Ctrl+S khi đang ở ô lưới (để bắt C1).
- **L9. Trạng thái tải đơn giản**: `PayrollRuns.tsx` (`if (q.isLoading) return <div>Đang tải…</div>`) thay vì `Spin`/skeleton, không `aria-live`; không có `role="status"`/`aria-live` ở nơi nào trong `apps/web/src`.

---

## Đối chiếu tài liệu (c) – không lệch/đã đạt

- Đủ tài liệu: GĐ6 (`giai-doan-6-luong-gia-thanh-hop-dong.md`, 429 dòng) và 6 tệp `giai-doan-7-*` (đa chi nhánh, hình thức sổ, HKD, ngân sách-phân tích, phê duyệt, song ngữ). Đề bài nêu 7 tệp; thực tế có 6, không thấy tệp riêng nào cho nhóm còn lại (nếu có nhóm thứ 7 thì thiếu tài liệu).
- Không có liên kết hỏng hoặc đường dẫn `docs/…`/`apps/…` trong `docs/user` trỏ vào tệp không tồn tại (đã quét bằng script).
- Menu và tên nút khớp mã: Lương > Hồ sơ lương/Chấm công/Bảng lương/…, Giá thành > Tính giá thành, Hệ thống > Chi nhánh/Tên tiếng Anh/Chế độ kế toán, Báo cáo > Hình thức sổ, Phê duyệt > Quy trình phê duyệt; các nút "Sao chép từ tháng trước", "Lập hóa đơn từ đợt", "Tạo phiên bản mới", "Điền chỗ trống từ mẫu", "Khai báo tài khoản nội bộ"… đều có trong mã.
- Ví dụ số liệu GĐ7 (hạn mức 5.000.000/10.000.000/20.000.000 ở tài liệu phê duyệt) là minh họa logic, không phụ thuộc dữ liệu mẫu; chưa phát hiện số liệu cũ sai. Số quy tắc "50" trong GĐ1/GĐ2/GĐ6 nhất quán với nhau (chưa đối chiếu lại với `data_check` hiện tại).
- Mục T6, T7, C5, C6 là các chỗ lệch tài liệu đã xác nhận.

## Ưu tiên sửa đề xuất
1. C1, C2 (mất dữ liệu/lưu nhầm, sửa nhỏ), 2. C3+C4 (chặn rời trang, `maskClosable`), 3. C5+T14 (thông báo cờ, mã thô), 4. T5, T8, T9 (truy cập bàn phím), 5. cập nhật tài liệu (C6, T6, T7).


---

## Phụ lục H — truc8-so-sanh

### Trục 8: So sánh nghiệp vụ với MISA / Fast / SUNSOFT

Phạm vi: commit `daeafe7` (main). Nguồn danh sách: `reports/Nghiệp vụ phần mềm kế toán.md` (mục "Danh sách tổng hợp nghiệp vụ theo 17 phân hệ"). Chỉ đọc. Bằng chứng là module `apps/api/src/modules/*`, trang `apps/web/src/pages/*`, migration, `packages/coa-data/data/*/status.json`, hoặc mục "Hạn chế đã biết" trong `docs/TIEP-THEO.md` và `docs/user/*`. Chưa chạy phần mềm nên mức "Đầy đủ" nghĩa là có mã và có đường dẫn, không phải đã kiểm thử đúng nghiệp vụ.

Quy ước mức: **Đ** = Đầy đủ, **M** = Một phần, **Y** = Yếu (có khung hoặc dữ liệu nhưng dùng thật khó), **T** = Thiếu (không thấy mã). B = Baseline, D = Differentiator, N = Niche.

## 1. Ma trận

### Hệ thống

| Nghiệp vụ | Loại | Mức | Bằng chứng | Ghi chú |
|---|---|---|---|---|
| Chọn chế độ, năm tài chính, niên độ lệch, khóa sổ | B | Đ | `core/regimes.ts`, `core/fiscalYears.ts`, `Periods.tsx`, `CompanyWizard.tsx` | TT200/TT133/TT99 dùng được. TT58, TT152 `ready=false`, không tạo được năm (TIEP-THEO "GĐ7 nhóm 6") |
| Chuyển đổi dữ liệu giữa chế độ (TT200 sang TT99, QĐ48 sang TT133) | B (2026) | T | `docs/user/giai-doan-1-so-cai.md` dòng 76: "chưa có"; không có route chuyển đổi trong `core/` | Đặc tả 7.2 có, TIEP-THEO nhóm C "để sau" |
| Hình thức Nhật ký chung | B | Đ | `reporting/ledgers.ts` (`generalJournal`), `Ledgers.tsx` | |
| Hình thức CTGS, NKSC, NKCT | D | M | `reporting/bookForms.ts`, routes `/api/reports/books/*`, migration 0200 | Mẫu "chưa đối chiếu văn bản gốc", chỉ in TT99/TT200 (`giai-doan-7-hinh-thuc-so.md`) |
| Nhiều công ty trên một bản cài | B/D | Đ | `core/tenants.ts`, RLS, `SelectTenant.tsx` | |
| Đa chi nhánh, BCTC tổng hợp | D | M | `branch/*`, migration 0240–0241, `Branches.tsx` | Thiếu: đánh số chứng từ theo chi nhánh, ô chi nhánh trên form chứng từ (TIEP-THEO GĐ7) |
| Người dùng, vai trò, quyền theo chức năng, cờ dữ liệu nhạy cảm | B | Đ | `core/roles.ts`, `core/users.ts`, `Users.tsx`, migration 0024/0043/0069/0078/0094 | Vai trò hệ thống chỉ `admin`, `ketoan_vien`, `xem` (migration 0001/0003); chưa có mẫu vai trò Thủ quỹ/Thủ kho |
| Nhật ký truy cập có trước/sau | B/D | Đ | `audit/routes.ts` (đọc `audit_event.before/after`), `AuditLog.tsx`, `/api/audit/logins` | |
| Phục hồi chứng từ xóa nhầm | B | T | Không có route khôi phục; `/api/vouchers/:id/discard` chỉ hủy nháp | Thiết kế bất biến nên không xóa thật, nhưng người dùng MISA quen "khôi phục". Thấp |
| Cất khác Ghi sổ; ghi sổ/bỏ ghi sổ theo lô; xác nhận hàng loạt | B | M | `/api/vouchers/:id/post`, `/unpost` (từng chứng từ). Không có route lô | Một chứng từ mỗi lần |
| Khóa sổ theo kỳ, phần hành, bỏ khóa có kiểm soát | B | Đ | `ledger/periods.*`, `/api/periods/.../lock\|unlock\|modules\|verify-hash` | Không thấy "tự khóa sau N ngày" |
| Quy tắc đánh số, cảnh báo trùng, đánh lại số | B | Đ | `ledger/numbering.ts`, `/api/vouchers/check-no`, `/renumber`, `Periods.tsx` | Theo chi nhánh: chưa |
| Sao lưu tự động theo lịch | B | Đ | `apps/worker` (`pg_dump`), `/api/backup`, `Company.tsx` thẻ Sao lưu | |
| Phục hồi dữ liệu | B | Y | `docs/user/sao-luu-phuc-hoi.md`: chỉ dòng lệnh `docker/restore.sh`; tệp đính kèm sao lưu tay | Kế toán DN nhỏ không tự phục hồi được từ giao diện |
| Trường mở rộng, ẩn/hiện nghiệp vụ, ngưỡng cảnh báo | D | M | `Company.tsx` (`extra_dims`, `hidden_modules`) | `extra_dims` chỉ là nhãn cột chiều phân tích |
| Định dạng, đồng tiền hạch toán, ngoại tệ, tỷ giá xuất quỹ | B | Đ | `cash/fx.ts`, `/api/fx/*`, migration 0027/0030 | |
| Quy trình phê duyệt | D | M | `approval/*`, `Approvals.tsx`, migration 0230 | Chưa duyệt hàng loạt, ủy quyền, thông báo email/đẩy |
| Mobile xem báo cáo, phát hành HĐĐT | D | Y | `approval/mobile.ts`, `docs/dev/api-mobile.md` | Chỉ có API mobile cho phê duyệt, chưa có ứng dụng |
| Báo cáo song ngữ | D | M | `translations/*`, `reporting/print/i18n.ts` | Mới dịch TK cấp 1, B01/B02 chính |
| Trợ lý AI | D | T | Không có module | Ngoài phạm vi hiện tại |

### Danh mục và số dư đầu kỳ

| Nghiệp vụ | Loại | Mức | Bằng chứng | Ghi chú |
|---|---|---|---|---|
| Hệ thống tài khoản dạng cây, ghép/đổi số hiệu | B/D | Đ | `coa/service.ts`, `/api/accounts/merge`, `/rename`, `Accounts.tsx` | TT99 184 TK từ văn bản gốc; TT200 chưa đối chiếu |
| Cơ cấu tổ chức, nhân viên, đối tượng KH/NCC | B | Đ | `master/catalogs.ts`, `Catalog.tsx` | |
| Hạn mức nợ và cảnh báo vượt hạn mức | B | Y | `credit_limit` chỉ ở `master/catalogs.ts`; không route nào kiểm khi ghi sổ | Chỉ lưu trường |
| Tra cứu MST, kiểm tra rủi ro người bán | B (2026) | M | `inbound/taxCodeLookup.ts` (VietQR, tùy chọn tắt mặc định) | Không thấy danh sách MST bỏ trốn/rủi ro |
| VTHH, nhiều ĐVT, thuế suất mặc định | B | Đ | `inventory/items.routes.ts`, `itemUoms.ts`, `Items.tsx` | `min_qty/max_qty` (migration 0044) chỉ là cột, không cảnh báo xuất quá/dưới tồn tối thiểu |
| Lô, HSD | N | M | `/api/reports/stock-expiry`, `stock_cost_layer` | Mã quy cách, vị trí kho, mã vạch: không thấy |
| Bảng giá bán/mua | D | Đ | `inventory/priceLists*.ts`, `PriceLists.tsx` | |
| Kho, loại TSCĐ/CCDC, công trình/vụ việc, đối tượng THCP | B/D | Đ | `inventory`, `assets`, `costing/objects.ts`, `contracts/projectAlloc.ts` | |
| Loại tiền, bảng tỷ giá | B | M | `/api/fx/rate`, `FxTools.tsx` | Không thấy tự tải tỷ giá ngân hàng; nhập tay |
| Ngân hàng, TK ngân hàng gắn 112x | B | Đ | `bank/*`, `napas_bin` (0089) | |
| Loại thuế, thuế suất, nhóm hóa đơn theo mục bảng kê | B | Đ | `/api/invoices/tax-defs`, migration 0031/0034 | |
| Số dư đầu kỳ: TK, công nợ theo hóa đơn, tồn kho, TSCĐ/CCDC/CPTT | B | Đ | `ledger/openingBalance.ts`, `OpeningBalance.tsx`, `OpeningStock.tsx`, `AssetOpening.tsx` | |
| Dở dang đầu kỳ, số dư vụ việc | D | Đ | migration 0108, `contracts/balances.ts` | |
| Doanh thu nhận trước đầu kỳ | D | M | `invoices/amortization.ts` (lịch tự do) | Không thấy nhập đầu kỳ riêng |
| Nhập số dư từ Excel (mẫu, kiểm tra, nhập) | B | Đ | `/api/opening-balance/:id/import`, `check`, `template.xlsx` | |
| Chuyển số dư sang năm sau tự động | B | Đ | `openingStock.ts` dòng 60: "các năm sau tự kết chuyển"; `docs/user/giai-doan-1-so-cai.md` | `giai-doan-3-kho-mua-ban.md` dòng 325 còn ghi "chưa tự chuyển": tài liệu mâu thuẫn mã, cần sửa |
| Chuyển đổi số dư TT200 sang TT99 | B (2026) | T | Xem dòng chuyển đổi chế độ | Doanh nghiệp đang dùng TT200 phải sang TT99 từ 2026: khoảng trống lớn khi chuyển từ MISA |

### Quỹ, ngân hàng

| Nghiệp vụ | Loại | Mức | Bằng chứng | Ghi chú |
|---|---|---|---|---|
| Phiếu thu/chi VND và ngoại tệ, mọi tình huống | B | Đ | `cash/routes.ts`, migration 0025, `VoucherForm.tsx` | |
| Thu/chi tiền ngay từ chứng từ mua/bán, chọn hóa đơn | B | Đ | `arap/settlement.ts`, `settleCommon.tsx` | |
| Nhiều bút toán, nhiều hóa đơn GTGT, số tiền bằng chữ, in A5 | B | Đ | `reporting/print/cashVoucherHtml.ts`, `01-TT`, `02-TT` | Công ty TT200/TT58 in không có dòng "Mẫu số" (TIEP-THEO mục 4) |
| Sổ quỹ S07, sổ chi tiết quỹ, kiểm kê quỹ | B | Đ | `cash/books.ts`, `cashCount.ts`, `CashBooks.tsx`, `CashCount.tsx` | |
| Phân hệ Thủ quỹ riêng | D | Y | Chỉ cờ nhạy cảm | Không có vai trò, màn hình riêng |
| Cảnh báo chi tiền mặt từ 5 triệu | D | Đ | Quy tắc `TIEN_MAT_VUOT_NGUONG` (migration 0038) | |
| Kết nối POS tự lập phiếu thu | N | T | Chỉ `/api/ext/v1` (`ext/routes.ts`) | |
| Thu/chi tiền gửi, chuyển nội bộ, vay, nộp thuế qua NH | B | Đ | Giấy báo Nợ/Có, chuyển tiền nội bộ (migration 0025) | |
| In UNC theo mẫu từng ngân hàng | B | Y | TIEP-THEO mục 4: "chỉ một bố cục chung nội bộ" | MISA có sẵn mẫu 8 ngân hàng |
| Sổ tiền gửi S08, sổ vay, đối chiếu sổ phụ | B | Đ | `/api/reports/bank-book`, `bank/reconReport.ts`, `loans/reports.ts` | |
| Kết nối NH điện tử: sao kê tự động, tự hạch toán | B (2026) | M | `bank/webhook.ts`, `feeds.ts`, `match.ts`, `BankFeeds.tsx` | SePay/Casso chưa thử thật; không có kết nối trực tiếp NH, không lệnh chuyển tiền trực tuyến |
| Nhập sao kê Excel/CSV, gợi ý đối chiếu | D | M | `bank/statementImport.ts`, `/api/bank-statement-formats` | Chỉ mẫu cột người dùng tự khai, không có mẫu dựng sẵn từng NH |
| Chi lương theo lô qua ngân hàng | D | M | `payroll/paymentFiles.ts`, `PayrollPaymentFormats.tsx` | Chỉ mẫu "Chung" |
| Khế ước vay | D | Đ | `loans/*`, `Loans.tsx` | |
| VietQR trên chứng từ | D | Đ | `bank/vietqr.ts` | Chưa quét thử bằng app thật |

### Mua hàng, bán hàng, công nợ

| Nghiệp vụ | Loại | Mức | Bằng chứng | Ghi chú |
|---|---|---|---|---|
| Mua trong nước, dịch vụ, chi phí mua, chiết khấu | B | Đ | `invoices/purchase.ts`, `inventory/landedCost.ts` | |
| Mua nhập khẩu (thuế NK, TTĐB, GTGT NK 1383) | B | M | `invoices/service.ts` (import_mode, excise_tax) | Không có biểu thuế, một tờ khai một chứng từ MH, nhiều dòng cùng mã thuế NK gộp (GĐ3 hạn chế) |
| Hàng về trước/hóa đơn về trước | B | Đ | `invoices/purchase.ts`, migration 0054–0056 | Ngoại tệ chưa hỗ trợ cho hai tình huống này |
| Giảm giá hàng mua, trả lại hàng mua | B | Đ | migration 0068 | |
| Đơn mua, hợp đồng mua | D | M | `orders/*`, `Orders.tsx`, `Contracts.tsx` | Mua theo lệnh sản xuất, lập nhanh hàng loạt: không thấy |
| Công nợ phải trả: tổng hợp, chi tiết, tuổi nợ, đối trừ, bù trừ, biên bản đối chiếu | B | Đ | `arap/*`, chứng từ BT (migration 0025), `Settlement.tsx`, `/api/reports/arap/*` | Bù trừ có chứng từ BT riêng |
| Cảnh báo trùng hóa đơn đầu vào | B | Đ | Quy tắc `HD_TRUNG`, `inbound/store.ts` | |
| Hóa đơn đầu vào tự động: đồng bộ NCC/CQT, lập chứng từ hàng loạt | B (2026) | M | `inbound/*`, `InboundInvoices.tsx` | Chỉ nhập XML thủ công, không đồng bộ CQT/email; thử trên mẫu tự dựng |
| AI hạch toán hóa đơn đầu vào | D | M | `inbound/store.ts` (ánh xạ nhớ), `/proposal` | Quy tắc nhớ, không AI |
| Bán hàng HH/DV/xuất khẩu, CK, KM, giảm giá, trả lại | B | Đ | `invoices/sales.ts`, `InvoiceForm.tsx`, migration 0059–0060 | |
| Phiếu xuất kiêm hóa đơn, thu tiền ngay | B | Đ | `invoices/sales.ts` | |
| Hợp đồng bán, theo dõi, đợt thanh toán | B/D | Đ | `contracts/*`, `Contracts.tsx` | `giai-doan-3` ghi "chỉ có API" đã cũ |
| Báo giá, đơn đặt hàng | D | Đ | `orders/*` | Combo sản phẩm: không thấy |
| Công nợ phải thu: tuổi nợ, đối trừ, bù trừ, biên bản (cả 0 đồng) | B | Đ | `arap/*` | |
| Kế hoạch thu nợ, nhắc nợ | D | M | `/api/reports/arap/reminder` | Không thấy email nhắc nợ tự động |
| Doanh thu nhận trước và phân bổ | D | Đ | `invoices/amortization.ts`, `Amortization.tsx` | |
| Chính sách giá, cảnh báo giá bán thấp | D | M | `/api/price-lists/resolve` | Ngưỡng cảnh báo giá chỉ có API (GĐ3) |
| Doanh số, lãi gộp theo nhân viên/đội; hoa hồng | D | M | `inventory/tradeReports.ts`, `SalesPurchaseReports.tsx` | Không thấy hoa hồng |
| Đồng bộ sàn TMĐT, POS, HĐĐT từ đơn sàn | D | T | Chỉ `/api/ext/v1/sales` | Cho phép phần mềm ngoài đẩy đơn |
| Bán qua đại lý, xăng dầu, vận tải | N | Y | Gửi bán, xuất khẩu có; xăng dầu, cung đường: không thấy | |

### Kho

| Nghiệp vụ | Loại | Mức | Bằng chứng | Ghi chú |
|---|---|---|---|---|
| Phiếu nhập/xuất/chuyển kho các loại | B | Đ | `inventory/stockVouchers.ts`, `StockVoucher.tsx` | |
| Giá xuất 4 phương pháp, theo kho, tính lại, tồn âm | B | Đ | `inventory/costingRun.ts`, migration 0049–0053, `CostingRun.tsx` | Đo 50.000 dòng 17,8–20,3 giây |
| Phương pháp giá riêng từng VT, giá xuất cố định | D | M | `items.costing_method` (migration 0044) | Cố định giá và thứ tự trong ngày chỉ có API (GĐ3) |
| Kiểm kê kho, hỏi tồn tại thời điểm | B | Đ | `inventory/stocktake.ts`, `/api/inventory/on-hand` | Cảnh báo tồn tối thiểu: không có |
| Nhiều ĐVT, hàng DV, landed cost | B | Đ | `itemUoms.ts`, `landedCost.ts`, `LandedCost.tsx` | |
| Lệnh sản xuất, lắp ráp/tháo dỡ, định mức | D | M | `inventory/assembly.ts`, `costing/norms.ts` | Không có lệnh sản xuất |
| Cập nhật giá nhập thành phẩm theo giá thành | B | Đ | migration 0106, `/api/stock-vouchers/:id/receipt-price` | Chỉ API (GĐ3) |
| Báo cáo NXT, thẻ kho, S10/S11/S12, đối chiếu kho-sổ cái | B | Đ | `inventory/reports.ts`, `StockReports.tsx`, `/api/reports/stock-*` | In S08-DNN/S12-DN thiếu cột F/G |
| Phân hệ Thủ kho (ẩn giá vốn) | D | M | Cờ `view_cost` chặn ở API | Không có vai trò, màn hình riêng |
| Kiểm tra SL x ĐG khác thành tiền, sai ĐVT | D | Đ | migration 0064, 0065, 0067 | |

### CCDC, TSCĐ, khế ước

| Nghiệp vụ | Loại | Mức | Bằng chứng | Ghi chú |
|---|---|---|---|---|
| Ghi tăng/giảm/điều chuyển/kiểm kê CCDC, TSCĐ | B | Đ | `assets/*`, `Assets.tsx`, `AssetCount.tsx`, migration 0070–0075 | |
| Phân bổ CCDC/CPTT hàng kỳ, dừng phân bổ, chạy lại | B | Đ | `assets/periodRun.ts`, `Amortization.tsx`, `/api/asset-runs` | Lần chạy không hủy được, chỉ chạy lại bằng đảo (GĐ4 hạn chế) |
| Khấu hao đường thẳng, tháng đầu theo ngày, dừng KH, phân bổ chi phí | B | Đ | `assets/schedule.ts`, migration 0071 | |
| Khấu hao số dư giảm dần, theo sản lượng | D | T | Không có trong `assets/*`, migration 0070–0071 | Chỉ đường thẳng |
| Khung thời gian khấu hao theo quy định | B | Y | TIEP-THEO mục 4: người dùng tự nhập, chưa có TT 45/2013 | |
| Thuê tài chính, tài sản sinh học | N | T | Không thấy | |
| Sổ S21/S22/S23, 06-TSCĐ, biên bản 01/02/04/05-TSCĐ | B | M | `assets/reports.ts`, `reporting/print/assetForms.ts` | PDF biên bản chưa kiểm, chỉ HTML |

### Tiền lương

| Nghiệp vụ | Loại | Mức | Bằng chứng | Ghi chú |
|---|---|---|---|---|
| Chấm công, bảng lương công thức, hạch toán, trả lương, nộp BH | B | M | `payroll/*`, `PayrollRuns.tsx`, `Attendance.tsx`, migration 0095–0102 | Cơ chế đủ, nhưng không có tham số pháp lý mặc định nên không chạy được ngay (dòng dưới) |
| Tham số theo thời gian: tỷ lệ BH, trần, TNCN lũy tiến, giảm trừ, lương tối thiểu vùng | B | Y | `packages/coa-data/data/tax/status.json`: `payrollParams_pit/si/minWage = false`; thiếu thì 409 `PAYROLL_PARAM_MISSING` | Kế toán phải tự nhập mọi tham số kèm nguồn: cản trở lớn khi thay MISA |
| Chứng từ khấu trừ TNCN, 05/KK-TNCN, 05/QTT-TNCN | B | Y | `payroll/tncnReturn.ts`, `TncnReturns.tsx`; `05KK_TNCN_TT89=false`, XML trả 409 `TNCN_TEMPLATE_UNAVAILABLE` | Lưu và chốt số liệu nguồn, chưa có mẫu tờ khai |
| Kê khai BHXH điện tử qua I-VAN | D | Y | `payroll/paymentFiles.ts`: "bảng cột chung" | |
| Nhập Excel bảng lương, hồ sơ, chấm công | B | Đ | `runImport.ts`, `profileImport.ts`, `attendanceImport.ts` | |
| Hoa hồng bán hàng vào lương | D | T | Không thấy | |

### Thuế

| Nghiệp vụ | Loại | Mức | Bằng chứng | Ghi chú |
|---|---|---|---|---|
| Bảng kê mua vào/bán ra, tờ khai 01/GTGT khấu trừ kỳ từ 01/07/2026 | B | Đ | `tax/register.ts`, `vatReturn.ts`, `VatReturn.tsx`, `01GTGT_TT89=true` | |
| Tờ khai 01/GTGT kỳ đến 30/06/2026 và khai bổ sung (TT80) | B (2026) | T | `01GTGT_TT80=false`; trả 409 `VAT_TEMPLATE_UNAVAILABLE` | Kế toán còn nộp bổ sung kỳ 2025–06/2026 |
| Nhóm 8% (NĐ 174) | B | Y | `01GTGT_TT89_rate8=false`: gộp tạm vào [32]/[33] | Cảnh báo, giả định phần mềm |
| GTGT trực tiếp, 02/GTGT dự án đầu tư | B | T | `tax/` chỉ có `vatReturn.ts` khấu trừ; không có phương pháp trực tiếp | Cần cho DN nhỏ áp dụng GTGT trực tiếp |
| Xuất XML HTKK/eTax | B | M | `tax/vatXml.ts`, `tax/xml/*`, `/api/tax/vat-returns/:id/xml` | `verified=false`, chưa có XML mẫu HTKK |
| Nộp BCTC XML qua eTax ký số | B | T | Ký số chỉ cho 01/GTGT, 03/TNDN (`signing/*`) | Chỉ có `/api/export/authority` (xuất dữ liệu), không phải XML BCTC |
| TNDN tạm tính quý, 03/TNDN, điều chỉnh tăng giảm | B | M | `tax/citEstimate.ts`, `citReturn.ts`, `CitReturn.tsx` | Thiếu phụ lục 03-1A (chưa có mẫu gốc), kỳ trước 01/07/2026 trả 409 `CIT_TEMPLATE_UNAVAILABLE` |
| TNCN khai quý, quyết toán, nhập tờ khai QT từ Excel | B | Y | Xem mục Lương | |
| Hai bộ mẫu TT80 và TT89 song song | B (2026) | Y | Chỉ TT89 | |
| Nộp tờ khai và thuế điện tử qua T-VAN, đối chiếu doanh thu CQT | D | T | `docs/TIEP-THEO.md`: "chưa có T-VAN" | |
| TTĐB (01/TTTB), tài nguyên, BVMT | N | T | Chỉ cột `excise_tax` trên dòng nhập khẩu | |
| Lệ phí môn bài | B (thực tế) | T | Không có mã `môn bài` | Không có trong báo cáo Baseline nhưng DN nhỏ nộp hằng năm; thấp |
| Đối chiếu bút toán thuế với hóa đơn, trùng số, MST rủi ro | B | M | `/api/tax/reconcile`, quy tắc `THUE_LECH`, `HD_TRUNG` | MST bỏ trốn: chỉ khi tra MST bật |
| Cảnh báo thanh toán không dùng tiền mặt từ 5 triệu | D | Đ | `TIEN_MAT_VUOT_NGUONG`, `legal_param vat_noncash_threshold` | |
| Hộ kinh doanh: sổ TT152, 01/CNKD | N | T | `regimes/status.json` mọi phần `false`; năm tài chính 409 `COA_TEMPLATE_PENDING` | Phân khúc lớn, nhưng chờ văn bản gốc |
| Báo cáo tình hình sử dụng hóa đơn (BC26/AC) | B (thực tế) | T | Không có mã | Chưa xác minh còn bắt buộc theo TT 91/2026. Thấp đến trung bình |

### Hóa đơn điện tử

| Nghiệp vụ | Loại | Mức | Bằng chứng | Ghi chú |
|---|---|---|---|---|
| Phát hành HĐĐT có mã/không mã qua NCC, ký số | B | M | `einvoice/*`, `signing/*`, `EInvoices.tsx` | Chỉ giả lập và Viettel SInvoice (theo tài liệu công khai, chưa thử thật). Không có meInvoice, VNPT, BKAV, M-Invoice |
| Vòng đời điều chỉnh/thay thế/hủy/04/SS-HĐĐT | B | Đ | `einvoice/lifecycle.ts`, `errorNotice.ts`, `EInvoiceErrorNotice.tsx` | |
| Ký hiệu mẫu số/ký hiệu theo TT 91/2026 | B | Đ | `einvoice/config.ts`, migration 0079, 0036 | |
| Hóa đơn đầu vào XML, kiểm chữ ký, chống trùng | B | M | `inbound/parseXml.ts`, `verify.ts` | Chưa thử XML thật của nhiều NCC; không có chuỗi tin cậy CA |
| Nhập khẩu bảng kê HĐĐT Excel | B | M | `tools/importVouchers.ts`, `ImportVouchers.tsx` | Chưa thấy nhận diện khuyến mại SL khác 0, tiền 0 |
| Hóa đơn từ máy tính tiền, bán lẻ xăng dầu, vé | N | T | Không thấy | |
| Quản lý hóa đơn nhiều NCC trên một màn hình | D | T | Mỗi công ty cấu hình một nhà cung cấp (`EInvoiceConfig.tsx`) | |

### Giá thành, hợp đồng, ngân sách

| Nghiệp vụ | Loại | Mức | Bằng chứng | Ghi chú |
|---|---|---|---|---|
| Tập hợp 621/622/627 theo đối tượng, kết chuyển 154, nhập 155 | B | Đ | `costing/collect.ts`, `costRun.ts`, migration 0097, 0103–0104 | TK 154 còn viết cứng ở vài chỗ (#963) |
| Phương pháp giản đơn, hệ số, tỷ lệ, đơn hàng, công trình, dở dang | B | Đ | `costing/costRun.ts` (simple, coefficient, ratio, order, project) | Không có hợp đồng như phương pháp riêng |
| Giá thành phân bước, nhiều công đoạn, giá thành định mức | D | T | Không có phương pháp phân bước trong `costRun.ts` | |
| Hợp đồng mua/bán, đã giao/còn lại, sổ chi tiết/tổng hợp | B | Đ | `contracts/*`, `ContractReports.tsx` | |
| Ngân sách, cảnh báo vượt dự toán, biểu đồ | D | Đ | `budget/*`, `Budget.tsx`, `Analytics.tsx` | |

### Tổng hợp, khóa sổ, báo cáo

| Nghiệp vụ | Loại | Mức | Bằng chứng | Ghi chú |
|---|---|---|---|---|
| Phiếu kế toán, quyết toán tạm ứng, ngoại tệ từng dòng | B | Đ | `VoucherForm.tsx`, voucher type QTU (migration 0025) | |
| Quy trình cuối kỳ có thứ tự | B/D | Đ | `ledger/periodClose.ts`, migration 0074, `PeriodClose.tsx` | |
| Kết chuyển lãi lỗ nhiều bước theo chế độ | B | Đ | `ledger/closing.ts`, `packages/coa-data/data/closing-steps/{tt200,tt133,tt99}.json` | |
| Tỷ giá xuất quỹ | B | Đ | `cash/fx.ts`, migration 0027 | Ghi lùi chuyển tiền nội bộ ngoại tệ còn lệch (GĐ2 hạn chế) |
| Đánh giá lại ngoại tệ cuối kỳ (TK 413) | B | M | `cash/revaluation.ts`, `FxTools.tsx` | Chỉ 111x, 112x, 131, 331. Thiếu 113, 1281, 244, 341, 1388, 3388. Chưa tỷ giá theo ngân hàng |
| Dự phòng phải thu khó đòi, giảm giá HTK, tổn thất đầu tư (229x) | B | T | Không có module; GĐ2 và GĐ6 hạn chế ghi "vẫn ngoài phạm vi"; TIEP-THEO mục 4 còn hỏi có làm trong GĐ7 | Ảnh hưởng đánh giá lại phải thu, B01 TT99 |
| Bút toán định kỳ/tự động theo quy tắc | D | T | Không có module. Chỉ phân bổ và khấu hao từng loại | |
| Soát lỗi, đối chiếu, quy tắc SQL do người triển khai thêm | B/D | Đ | `tools/dataCheck.ts`, 50+ quy tắc, migration 0014/0038/0064/0092/0109 | |
| BCTC B01/B02/B03 (TT99, TT133) | B | M | `reporting/financial.ts`, `Financial.tsx`, `reports/status.json` cả 6 cờ `true` | Các dòng B01 TT99 dài hạn bằng 0 (112, 124–126, 165, 216…), B03 phân loại theo cặp đối ứng, chưa kế toán trưởng rà |
| Thuyết minh B09 | B | T | `packages/coa-data/data/reports/` chỉ B01, B02, B03 | Bắt buộc nộp cùng BCTC năm |
| BCTC giữa niên độ (B03a) | B | T | Không có mã | |
| BCTC cho công ty TT200 và TT58 (B01-DNSN) | B | T | `packages/coa-data/data/reports/` chỉ có `tt99`, `tt133`; `coa-data/src/load.ts` dòng 44 đọc `reports/<regime>/<code>.csv` nên TT200 không có định nghĩa; `isReportComplete` chỉ xét tt99/tt133. TT58 chờ văn bản gốc | Công ty TT200 (chế độ `ready=true`) chưa có định nghĩa B01/B02/B03 riêng; cần xác minh chạy thực tế |
| BCTC tổng hợp chi nhánh, loại trừ nội bộ | D | Đ | `branch/consolidated.ts`, `/api/reports/consolidated/:id` | |
| BCTC hợp nhất TT202 nhiều pháp nhân | N | T | `consolidation/status.json complete=false` | |
| Khóa sổ, tạo dữ liệu năm mới | B | Đ | `core/fiscalYears.ts`, `Periods.tsx` | |
| Khử trùng chứng từ | N | Đ | `tools/dedupe.ts`, `Dedupe.tsx` | |

### Sổ sách, báo cáo, tiện ích

| Nghiệp vụ | Loại | Mức | Bằng chứng | Ghi chú |
|---|---|---|---|---|
| Sổ NKC S03a, S03b, S06 (BCĐPS), S07, S08, S10–S12, S21–S23 | B | Đ | `reporting/print/forms.ts` có S05–S12, S20–S23, S38 | |
| Nhật ký thu/chi/mua/bán S03a1–S03a4 | B | T | Không có mã `S03a[1-4]` | Báo cáo gốc liệt kê trong sổ bắt buộc NKC |
| Sổ chi tiết S31–S36 (thanh toán người mua/bán, bán hàng, chi phí) | B | M | Có `accountDetail` chung, `arap/reports.ts`; mã S31–S36 không có (chỉ S37, S38 ở `costing/reports.ts`) | Dùng sổ chi tiết tài khoản thay mẫu |
| Báo cáo công nợ các loại | B | Đ | `arap/reports.ts`, `ArapReports.tsx` | |
| Báo cáo quản trị chi phí, lãi lỗ, mua bán, TSCĐ, lương, hợp đồng | B | Đ | `costing/reports.ts`, `contracts/pnl.ts`, `Analytics.tsx` | Báo cáo lương, giá thành không in số mẫu |
| Truy ngược sổ về chứng từ, in cả bộ sổ năm, xuất Excel/PDF | B | M | `/api/reports/financial/:id/lines/:id` (drill), `/api/print/book-set`, `format=xlsx\|pdf` | Không thấy xuất Word. Hình thức sổ khác chưa vào hộp "In cả bộ sổ năm" |
| In sổ đủ tiêu thức Điều 24 (bìa, số trang, chữ ký) | B | M | `reporting/print/bookSet.ts` | Chưa kiểm từng tiêu thức |
| Dashboard phân tích tài chính | D | M | `Analytics.tsx`, `budget/analytics.ts`, `charts.tsx` | |
| Thiết kế mẫu in (logo, thư viện mẫu), gửi email/Zalo | D | T | Không có mã | |
| Nhập Excel danh mục, số dư, chứng từ, lương | B | Đ | `master/importExcel.ts`, `tools/importVouchers.ts`, `ImportExcel.tsx`, `ImportVouchers.tsx` | 2.000 nhóm/20.000 dòng, chạy đồng bộ |
| Nhập tờ khai QT TNCN, CCCD từ Excel | B | T | Không thấy | |
| Lập nhanh/nhân bản; cập nhật hàng loạt (giá, mã HĐ, số HĐ) | B | M | `/api/vouchers/:id/duplicate` | Không có cập nhật hàng loạt |
| Đánh lại số, bảo trì dữ liệu, kiểm tra index | B | M | `/api/vouchers/renumber` | Bảo trì dữ liệu: không thấy |
| Đọc số thành chữ, định dạng VND | B | Đ | `packages/domain`, `@kt/ui` | |
| Tìm kiếm F4, bổ sung danh mục tại ô mã, nhớ bộ lọc | B | Đ | `packages/ui` (tra cứu F4, `useRememberedFilter`) | Kiểm tay Telex/VNI chờ người dùng |
| API mở kết nối phần mềm khác | B (2026) | Đ | `ext/*`, `ApiKeys.tsx`, `docs/dev/api-ngoai.md` | |
| Xuất dữ liệu cho cơ quan thuế | B | Đ | `tools/exportAuthority.ts`, `Export.tsx` | CSV thiếu `cash_flow_code` |
| Nhập/xuất chứng từ giữa các bộ dữ liệu; nhập từ MISA | N | T | Không có | Không có đường di trú từ MISA: xem phát hiện |

## 2. Tổng hợp theo mức

Đếm theo các dòng ma trận ở trên (một dòng ghép nhiều ý được tính một lần, theo mức của ý nặng hơn trong dòng):

Tổng 157 dòng: **Đầy đủ 75**, **Một phần 39**, **Yếu 13**, **Thiếu 30**. Riêng nhóm Baseline (khoảng 107 dòng): Đầy đủ 63, Một phần 21, Yếu 10, Thiếu 13 (gồm dòng loại B hoặc B/D; tổng 107).

## 3. Phát hiện thiếu và yếu, xếp theo ảnh hưởng với một kế toán DN nhỏ thay MISA

### Nghiêm trọng

1. **Không có đường chuyển đổi dữ liệu từ phần mềm cũ và giữa chế độ.** Không có nhập từ MISA/Fast, không có chuyển đổi số dư TT200 sang TT99 (`giai-doan-1-so-cai.md` dòng 76). Doanh nghiệp dùng TT200 phải sang TT99 từ 2026; không có bước này thì không cắt chuyển từ MISA sang được. Đề xuất: bảng ánh xạ TK (đặc tả 7.2 đã liệt kê 161, 417, 441, 461, 466, 611, 631, 1562, 3385), màn hình chuyển số dư cuối năm cũ sang năm TT99 đúng bút toán DK, cộng nhập Excel danh mục/số dư theo mẫu MISA (hiện đã có nhập Excel chung, nên làm trước phần "mẫu cột MISA").
2. **Lương và TNCN không dùng ngay được.** `payrollParams_pit/si/minWage=false`, 05/KK-TNCN và 05/QTT-TNCN trả 409, không có I-VAN. Mọi DN có nhân viên đều cần. Người dùng phải tự nhập toàn bộ tham số và tự làm tờ khai ngoài phần mềm. Phụ thuộc việc người dùng tải văn bản gốc (TIEP-THEO mục 4); đề xuất xếp lên đầu danh sách "chờ người dùng" và cung cấp mẫu nhập tham số kèm hướng dẫn nguồn.
3. **Tờ khai thuế: thiếu TT80 và GTGT trực tiếp.** `01GTGT_TT80=false` làm kỳ đến 30/06/2026 và khai bổ sung kỳ cũ không lập được; không có phương pháp GTGT trực tiếp trên doanh thu/GTGT (DN nhỏ phổ biến); XML HTKK `verified=false`; không có T-VAN nộp thẳng. Kế toán vẫn phải qua HTKK/eTax bằng tay và không kiểm chứng được tệp XML. Đề xuất: ưu tiên GTGT trực tiếp (không cần văn bản đặc biệt ngoài mẫu 01/GTGT hiện hành) và tải TT80.
4. **Dự phòng nợ khó đòi và các khoản dự phòng 229x không có.** Hạn chế GĐ2 (đánh giá lại phải thu cần loại phần dự phòng) và GĐ6; TIEP-THEO mục 4 còn là câu hỏi mở. Ảnh hưởng B01, thuế TNDN (chi phí được trừ), cuối năm của mọi DN có phải thu. Đề xuất: làm trong giai đoạn kế tiếp: mô hình dự phòng theo khoản phải thu/tuổi nợ, chứng từ DP tự động đảo, nối vào B01/B02 và soát lỗi.

### Cao

5. **BCTC chưa đủ bộ.** Chỉ có B01/B02/B03. Thiếu thuyết minh B09 (nộp cùng BCTC năm), B03a giữa niên độ; công ty TT200 (chế độ `ready=true`) không có thư mục định nghĩa báo cáo (`reports/` chỉ `tt99`, `tt133`); các dòng B01 TT99 dài hạn còn bằng 0; chưa kế toán trưởng rà (TIEP-THEO mục 4). Nộp BCTC XML qua eTax không có. Đề xuất: B09 dạng bảng nhập tay có số liệu điền sẵn từ sổ; xác định phạm vi TT200.
6. **Phục hồi dữ liệu chỉ bằng dòng lệnh.** Sao lưu có lịch và nút, nhưng phục hồi cần quản trị hệ thống chạy `docker/restore.sh`, ghi đè mọi công ty; tệp đính kèm sao lưu riêng. Với DN nhỏ tự vận hành đây là rủi ro thực. Đề xuất: bản đóng gói có hướng dẫn một lệnh, sao lưu kèm đính kèm.
7. **Hóa đơn điện tử chỉ một nhà cung cấp thật (Viettel SInvoice) chưa thử thật.** MISA meInvoice, VNPT, BKAV, M-Invoice chiếm phần lớn thị trường; hóa đơn đầu vào chỉ nhập XML thủ công (không đồng bộ từ CQT/NCC). DN đang dùng nhà cung cấp khác không phát hành được từ phần mềm. Đề xuất: adapter meInvoice/VNPT, đồng bộ hóa đơn đầu vào từ cổng CQT nếu có tài liệu công khai.
8. **Tờ khai TNDN thiếu phụ lục kết quả SXKD và kỳ trước 01/07/2026.** Chỉ A1 từ B02; năm 2025 trở về trước trả 409. Quyết toán năm 2025 sẽ nộp trong 2026: ảnh hưởng sớm. Phụ thuộc văn bản gốc.
9. **Hộ kinh doanh và siêu nhỏ (TT152, TT58) chưa dùng được.** Khung có, mọi cổng `false`. Một phân khúc khách hàng lớn; phụ thuộc văn bản gốc và quyết định kiến trúc (sổ không bút toán kép) ở TIEP-THEO.
10. **Đánh giá lại ngoại tệ chưa đủ khoản mục và chưa tỷ giá theo ngân hàng** (chỉ 111x, 112x, 131, 331; TT99 TK 413 mục 1.5.1 yêu cầu tỷ giá của ngân hàng nơi mở TK). DN có vay, tiền gửi, tạm ứng ngoại tệ sai 413.

### Trung bình

11. **Không có nhật ký đặc biệt S03a1–S03a4 và mẫu S31–S36.** Báo cáo gốc liệt kê trong bộ sổ NKC; thay thế được bằng sổ chi tiết tài khoản nhưng không đúng mẫu in nộp cơ quan thuế/kiểm toán.
12. **Ghi sổ/bỏ ghi sổ/xác nhận hàng loạt, cập nhật hàng loạt (giá, số HĐ, mã HĐ), bút toán định kỳ không có.** Tốn công với khối lượng lớn; mức tiện ích hằng ngày của MISA.
13. **Cảnh báo hạn mức nợ, tồn tối thiểu chỉ là trường danh mục.** `credit_limit` và `min_qty/max_qty` không được kiểm khi ghi sổ. Dễ bổ sung bằng quy tắc soát lỗi hoặc cảnh báo khi lưu.
14. **UNC in bố cục chung, không theo mẫu từng ngân hàng; chi lương theo lô chỉ mẫu "Chung".** Cần mẫu của người dùng (TIEP-THEO mục 4).
15. **Vai trò thủ quỹ/thủ kho, kế toán trưởng không dựng sẵn; phân quyền chi tiết có nhưng người dùng phải tự tạo vai trò.** Chỉ có `admin`, `ketoan_vien`, `xem`.
16. **Mobile chỉ có API, trợ lý AI, đồng bộ sàn TMĐT/POS không có.** Là Differentiator; ưu tiên thấp so với các mục trên. POS bán lẻ: chỉ có `/api/ext/v1` cho phần mềm ngoài đẩy đơn.
17. **Hóa đơn đầu vào: nhận diện rủi ro NCC chỉ khi bật tra MST bên thứ ba**, không có danh sách doanh nghiệp rủi ro.
18. **Nhập khẩu thiếu biểu thuế, một tờ khai một chứng từ MH.**
19. **Tài liệu người dùng mâu thuẫn mã:** `giai-doan-3-kho-mua-ban.md` dòng 325 ghi tồn đầu năm sau chưa tự chuyển trong khi `inventory/openingStock.ts` dòng 60 ghi tự kết chuyển; `giai-doan-3` ghi hợp đồng chỉ có API trong khi có `Contracts.tsx`. Cần rà để không làm người dùng hiểu sai.

### Thấp

20. Khấu hao số dư giảm dần, theo sản lượng; thuê tài chính; tài sản sinh học (Differentiator/Niche).
21. Báo cáo tình hình sử dụng hóa đơn BC26/AC, lệ phí môn bài, TTĐB/tài nguyên/BVMT (cần xác minh bắt buộc hiện hành trước khi làm).
22. Thiết kế mẫu in, gửi email/Zalo, phục hồi chứng từ xóa nhầm (đối lập thiết kế bất biến), nhập/xuất chứng từ giữa các bộ dữ liệu, hóa đơn từ máy tính tiền, xăng dầu, vận tải.
23. Giá thành phân bước/nhiều công đoạn, lệnh sản xuất, BOM đa cấp.
24. Hợp nhất TT202 nhiều pháp nhân (Niche, chờ văn bản gốc).

## 4. Phụ thuộc người dùng đang chặn các nhóm trên

Các nhóm 2, 3, 5, 8, 9 phụ thuộc văn bản gốc nằm ở `docs/TIEP-THEO.md` mục 4 và "GĐ7 nhóm 6, nhóm 5". Nhóm 1 (di trú dữ liệu) và nhóm 4 (dự phòng) không phụ thuộc văn bản mới ngoài đặc tả hiện có nên có thể làm ngay. Nhóm 6, 7, 10 làm được độc lập.

## 5. Hạn chế của chính báo cáo này

- Chưa chạy phần mềm; mức "Đ" dựa vào có mã, route, trang và (nếu có) khẳng định của TIEP-THEO.
- Một số dòng (in nhiều mẫu/liên, tiêu thức Điều 24, hoa hồng, combo, mã vạch, vị trí kho) kết luận từ việc không thấy từ khóa khi tìm; có thể có dưới tên khác.
- Số dòng ma trận và cách ghép ý ảnh hưởng đến tổng ở mục 2.
