# Quyết định GĐ7: gói 2, cổng pháp lý và làm tròn tiền (dải 1350–1399)

Nguồn: `docs/review/2026-10-28-review-toan-san-pham.md` phụ lục D (trục pháp lý) và phụ lục B (trục tiền, làm tròn). Mỗi mục đã tự xác minh trong mã trước khi sửa. Migration dùng: 0270.

## Pháp lý

1350. Bỏ khỏi `FORMS` mọi số mẫu sổ chưa có bằng chứng đối chiếu: Nhật ký chung S03a, Sổ Cái S03b, S38/S20-DNN, S06 (TT99 "S06-DN" và TT133 "S06-DNN" trùng sổ chi tiết vật liệu đã đối chiếu, quyết định GĐ3 số 331), S02a/S02b/S02c1 (quyết định 1005 tự ghi "chưa đối chiếu") — vì văn bản gốc TT99, TT133 không có trong `legal-docs-gd7` và không đọc lại được; giữ lại mọi mục đã dẫn dòng văn bản (01-TT, 02-TT, 08a/b-TT, 01/02/05-VT, S10-DN/S06-DNN, S12-DN/S08-DNN, S21..S23, S04a/S05, S07/S08, 06-TSCĐ...) và B01/B02/B03 TT99 (Phụ lục IV), TT133 (Phụ lục 2) có nguồn trong `reports/status.json` — giá phải trả: bộ sổ năm in thiếu dòng "Mẫu số" cho các sổ tổng hợp cho tới khi đối chiếu Phụ lục sổ (mục Chờ người dùng). Kiểm thử `forms.test.ts` chặn hai khóa trùng số mẫu trong một chế độ.

1351. Bỏ toàn bộ mục TT200 trong `FORMS` và `ISSUED` (kể cả "ngày 22/12/2014" lấy từ trí nhớ) — nhất quán với `TIEP-THEO` ("TT200 in không có Mẫu số"), trước đây chỉ đúng với chứng từ tiền/kho/TSCĐ — giá phải trả: định nghĩa báo cáo TT200 lưu `form_no = ''`.

1352. `formNoFor` trả `{ formNo: '', issuedBy: '' }` khi không có mục, thay vì lấy mã khóa nội bộ ("S03a") làm số mẫu — tránh in mã khóa như số mẫu — giá phải trả: không (bookSet/financial vẫn dùng `formNoFor`, nay trả trống an toàn).

1353. C2: chặn phát hành HĐĐT 8% ở `buildEInvoiceDoc` (trước khi gửi), bằng `isReducedVatRateEffective()` đọc `legal_param.vat_reduced_rate` (thuế suất giảm = `value.to`, hiệu lực `valid_from`..`valid_to` = 01/7/2025..31/12/2026 đã đối chiếu NQ 204/2025 Điều 2 bằng OCR trong `legal-docs-gd7/nq204-2025/ocr/p001.txt`) — không viết cứng 8% hay ngày; có nghị quyết mới chỉ cần thêm dòng tham số — giá phải trả: chưa cảnh báo ở bước ghi sổ (soát lỗi 0038 và tờ khai vẫn cảnh báo như cũ); mã thuế V8 trong `seed_tenant_defaults` không đổi (không thêm cột hiệu lực cho `tax_code`).

1354. C2: hóa đơn điều chỉnh/thay thế (`relation <> 'original'`) không bị chặn 8% — hóa đơn gốc đã cấp mã đúng hạn không hủy được (TT91 Điều 10), điều chỉnh phải giữ thuế suất gốc — giá phải trả: không kiểm ngày của hóa đơn gốc.

1355. C3: tờ khai 01/GTGT có hóa đơn bán ra 8% khi `01GTGT_TT89_rate8 = false`: chốt cần `acknowledge: ['rate8_unverified']` (409 `VAT_RATE8_UNVERIFIED` nếu thiếu), xác nhận lưu ở cột mới `tax_return.acknowledged_gates` (migration 0270, cùng UPDATE chuyển `final` nên trigger 0035 không chặn; trigger audit ghi trước/sau). Xuất XML và ký số (qua `renderReturnXml`) kiểm lại `assertGatesAcknowledged`; tờ khai đã chốt trước đây (cột rỗng) có hóa đơn 8% bị chặn xuất/ký — đây là chủ ý (phải lập bổ sung kèm xác nhận) — giá phải trả: mỗi lần xuất XML tính lại gợi ý kỳ (một lần `compute`). Không tách [32]/[33] thành dòng 8% riêng vì mẫu không có dòng đó (thêm sẽ là bịa chỉ tiêu).

1356. C3: seed ABC (`scripts/seed-abc.ts`) chốt tờ khai có 8% với `acknowledge` — dữ liệu mẫu có hóa đơn 8% năm 2026.

1357. TB4: ký số XML của định dạng `verified = false` (01/GTGT, 03/TNDN) cần `acknowledgeUnverified: true` ở tạo phiên (409 `XML_FORMAT_UNVERIFIED`), ghi `audit_event` `sign_unverified_xml`; giao diện hỏi "Vẫn ký". Xuất XML không bị chặn (cần xuất để nạp thử HTKK, kèm header `x-kt-unverified` và cảnh báo). Có tham số ghi đè vì bản ký vẫn hữu ích khi đã tự nạp thử HTKK thành công — giá phải trả: người ký có thể xác nhận bừa, bù bằng nhật ký. `VatReturn.tsx` đổi `verified === false` thành `!== true` như `CitReturn.tsx`.

1358. C4/TB6: hiệu lực và cổng TT99, TT133, TT200 thành dữ liệu `packages/coa-data/data/regimes/accounting.json` + `checkRegimeForYear(regime, dateFrom)` (TT58, TT152 đọc `regimes/status.json` ở mức tổng quát, không sửa nội dung). TT99: `effectiveFrom 2026-01-01` (đặc tả mục 10), cổng lấy từ `tt99.status.json` và `reports/status.json`; TT200: `effectiveTo 2025-12-31`, `coa=false`, `reports=false`; TT133 không giới hạn. `/api/regimes` đọc từ dữ liệu, không còn `ready: true` cứng — giá phải trả: ngày hiệu lực TT99/TT200 lấy từ đặc tả (`effectiveVerified: false`), chưa đối chiếu điều khoản thi hành của TT99.

1359. C4: `createFiscalYear` tra chế độ theo ngày đầu năm tài chính; chưa sẵn sàng → 409 `REGIME_NOT_READY`, ngoài hiệu lực → 409 `REGIME_NOT_EFFECTIVE`; `confirmRegimeOverride: true` cho qua và ghi `audit_event` `fiscal_year_regime_override` — cần cho dữ liệu cũ (năm 2025 trở về trước theo TT200, nhập số liệu lịch sử). Chế độ sách (TT58, TT152) chưa sẵn sàng: giữ mã `COA_TEMPLATE_PENDING` cũ, không có ghi đè (chưa có hệ thống tài khoản để tạo) — kiểm tra trước mọi thao tác nên không còn phụ thuộc trùng hợp vào bảng `coa_template` rỗng (TB6). TT58 hiệu lực 01/7/2026 nhưng năm bắt đầu 01/01/2026: tạo năm cần ghi đè khi chế độ sẵn sàng — giá phải trả: thận trọng, gói TT58/TT152 có thể chỉnh logic này.

1360. Test helper và ba chục lời gọi tạo năm TT200 trong kiểm thử thêm `confirmRegimeOverride: true`. Giá phải trả: thêm tham số vào kiểm thử cũ.

1361. TB5: `reports/approximations.json` (chỉ tiêu để 0 cố định `fixedZero` và các câu "cách lấy số gần đúng") sao từ ghi chú `reports/status.json` của chính người nhập, không thêm khẳng định pháp lý mới; `evaluateFinancialReport` trả `approximations` (chỉ báo dòng còn công thức 0 trong định nghĩa của công ty), in thành `outro` trên HTML/PDF/Excel và khung thông tin ở màn hình. Kiểm thử `accountingRegimes.test.ts` kiểm mọi `fixedZero` có công thức 0 trong CSV.

1362. TB1, TB2, TB3 (số mẫu): xem 1350, 1351. TB3 (mục D) chỉ bỏ số mẫu, không đối chiếu Phụ lục sổ vì chưa có văn bản.

1363. T1 (docs seed `TNCN_KT` 10%): không đúng — `apps/api/scripts/seed-abc.ts:81` đặt `TNCN_KT` 10%; báo cáo chỉ tìm trong `packages/db/src/seed`. Không sửa tài liệu.

## Làm tròn tiền

1364. TB1 lương: `post.ts` làm tròn từng giá trị cột khấu trừ có TK Có riêng về đồng (`toDecimalPlaces(0)`, nửa lên như `other_withholding`) trước khi cộng `routedSum` và ghi Có; phần chênh vào `tot.other` (3388). Không ép `round = 0` trong `validateStructure` (sẽ làm hỏng cấu trúc đã lưu) — giá phải trả: cột khấu trừ làm tròn lẻ vẫn nhập được nhưng hạch toán làm tròn từng giá trị. Kiểm thử `postRounding.test.ts` gồm hai ví dụ của báo cáo (100,50 và hai người 100,25), ví dụ dồn 3388 và thuộc tính ngẫu nhiên cân Nợ/Có (8 mẫu cố định, `FC_RUNS` tăng).

1365. TB2 hợp đồng: các đợt theo tỷ lệ (không nhập số tiền) cộng đúng 100% thì đợt cuối theo STT nhận `giá trị - Σ các đợt theo tỷ lệ còn lại`; đợt đã lập hóa đơn giữ số đã lập. Không đủ 100% giữ làm tròn từng đợt. Chọn "đợt cuối nhận dư" (đơn giản, giải thích được) thay cho tính lũy kế — giá phải trả: ví dụ 33,3333/33,3333/33,3334 ra 333.333.000/333.333.000/333.334.001, đợt cuối lệch tối đa n−1 đơn vị so với tính riêng.

1366. TB3 TSCĐ: `annual = round(nguyên giá × 12 / số tháng)`, cột tỷ lệ vẫn làm tròn 2 chữ số khi hiển thị — không lấy từ lịch khấu hao (đơn giản hơn, cùng kết quả với `target` của lịch cho khấu hao đều).

1367. T1 đơn hàng: SQL tổng đơn làm tròn hai bước như TS (thành tiền dòng làm tròn, chiết khấu làm tròn) — số lên hóa đơn là chuẩn. Giao từng phần vẫn làm tròn riêng từng lần (không có lần cuối nhận dư).

1368. T2 `costing/reports.ts`: `Map<number, string>` thay `toNumber()`. T4: `projectAlloc` dùng `allocateByRatio` (phần lẻ lớn nhất) — giá phải trả: số phân bổ vụ việc có thể đổi 1 đồng so với trước (kiểm thử `projectAlloc.test.ts` cập nhật). T6: `formatVnNumber` không in "-0".

1369. Hoãn: T3 (lãi vay ngoại tệ theo `minor_unit`: cần đổi kiểu `decimals` của `periodInterest` ở domain), T5 (web Number/Math.round trong biểu đồ), T6 phần `VnNumberInput` từ chối số lẻ ô VND (đổi hành vi nhập liệu, cần quyết định giao diện), T7 (`Number()` kiểm hợp lệ — không sai trong thực tế), pháp lý T2 (cảnh báo tỷ giá TT200 khi `fxRules_TT200 = false`: phải đụng kết quả API đánh giá lại), T3 (`source` cho sơ đồ kết chuyển), T4 (câu dẫn luật cứng trong `cit.ts`, `citEstimate.ts`, `citReturn.ts`), T5 (hạn nộp tạm nộp viết cứng), T6 (loại hóa đơn `F` ở `invoiceSymbol.ts`, cần Phụ lục I TT91 không có trong thư mục văn bản). Quy tắc soát lỗi 0038 dòng 100-105 không đổi.

## Chờ người dùng (mới)

- Văn bản gốc TT 99/2025/TT-BTC (điều khoản thi hành: năm tài chính áp dụng, thay thế TT 200) để đặt `effectiveVerified = true` trong `regimes/accounting.json` và đối chiếu Phụ lục sổ kế toán (S03a-DN, S03b-DN, S38-DN, S06-DN, S02-DN).
- Văn bản gốc TT 133/2016/TT-BTC Phụ lục 4 (S03a-DNN, S03b-DNN, S20-DNN/S38, S06-DNN của BCĐSPS) và TT 200/2014/TT-BTC (Phụ lục 1, B01-B03) trong `~/legal-docs`.
- Hướng dẫn của cơ quan thuế về khai thuế suất 8% vào 01/GTGT (chỉ tiêu nào / Mẫu 01 Phụ lục II NĐ 174/2025) để mở cổng `01GTGT_TT89_rate8`.
- Tệp xuất HTKK thật của 01/GTGT và 03/TNDN để mở `verified` của `htkk-01gtgt.json`, `htkk-03tndn.json`.
- Phụ lục I TT 91/2026 (loại hóa đơn `F`, ký hiệu) để đối chiếu `invoiceSymbol.ts`.
