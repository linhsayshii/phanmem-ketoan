# Việc tiếp theo

Cập nhật: 2026-10-21, sau khi xong GĐ1.5 (tag `gd0-hoan-tat`, `gd1-hoan-tat`, `gd1-5-hoan-tat`). Việc đang làm: GĐ2 theo `docs/superpowers/plans/2026-10-21-giai-doan-2-chi-tiet.md`. Agent cập nhật file này cuối mỗi giai đoạn và mỗi khi có việc chờ người dùng.

Thứ tự làm: mục 2 (phần còn lại) song song mục 3 (GĐ2 → GĐ7). Mục 4 là việc chờ người dùng, không chặn các mục khác.

## 1. GĐ1.5 (tồn đọng GĐ0–1): xong 2026-10-21, tag `gd1-5-hoan-tat`

Kế hoạch `docs/superpowers/plans/2026-10-20-giai-doan-1-5-chi-tiet.md`, sổ quyết định `2026-10-20-giai-doan-1-5-quyet-dinh.md` (gồm mục "Để lại"). Nhóm A (A1–A12) xong: DB kiểm thử tạm mỗi lần chạy, typecheck cả kiểm thử, `TRUST_PROXY` và cấu hình production, khóa đăng nhập sai theo tên/IP, băm mã phiên, chặn tự nâng quyền, RLS `tenant_user`, thu hẹp `ketoan_vien`, `*_NOT_FOUND` = 404, khóa ngoại tổng hợp `(tenant_id, id)`, kiểm cân bằng theo câu lệnh (khóa ghi trực tiếp partition), script đo 100.000 dòng (BCĐPS năm 175 ms). Migration 0016–0023.

**Nhóm B** đã gộp vào kế hoạch GĐ2 (`2026-10-21-giai-doan-2-chi-tiet.md`, bảng "Đối chiếu nhóm B").

**Nhóm C, để sau**: chuyển số dư khi đổi chế độ (đặc tả 7.2), xuất XML cơ quan thẩm quyền (mục 13), bất biến 7 đầy đủ; mời người dùng đã có vào công ty khác; phạm vi khóa tạo partition; việc chuẩn bị production (Docker, sao lưu, seed); giới hạn số đăng nhập đồng thời dưới kích thước pool kết nối (lũ đăng nhập từ nhiều IP chiếm pool khoảng 0,5 giây); `role.update` gỡ được quyền của vai trò cao hơn (từ chối dịch vụ). Nhóm D (không làm) có lý do trong `2026-10-20-gd1-5-de-xuat.md`.

## 2. Dữ liệu pháp lý (cổng `*.status.json` trong `packages/coa-data`)

Văn bản gốc tải về `~/legal-docs/` trên VPS (ngoài repo): TT 99/2025 và TT 133/2016 từ Công báo (có chữ), TT 91/2026 (Công báo, có chữ), TT 89/2026 (datafiles.chinhphu.vn, bản scan 839 trang, cần OCR).

- [x] Hệ thống tài khoản TT 99/2025 (Phụ lục II, 184 tài khoản), `complete=true`, nguồn ghi trong `tt99.status.json` (2026-10-20).
- [x] Đối chiếu hệ thống tài khoản TT133 với Phụ lục 1 TT 133/2016: bỏ 521, sửa 18 tên (2026-10-20).
- [x] Sơ đồ kết chuyển theo chế độ (`closing-steps/tt200|tt133|tt99.json`); tạo năm tài chính đổi chế độ thì nạp lại sơ đồ.
- [x] Chỉ tiêu B01-DN, B02-DN, B03-DN (Phụ lục IV TT 99/2025) và B01a-DNN, B02-DNN, B03-DNN (Phụ lục 2 TT 133/2016), cả sáu cờ `true` (2026-10-20). Các chỗ gần đúng (dòng dài hạn TT99 bằng 0 vì sổ cái chưa có kỳ hạn còn lại; B03 tiền tệ phân loại theo cặp đối ứng; lãi trên cổ phiếu nhập tay) ghi trong `note` của `data/reports/status.json`.
- [ ] Kế toán trưởng rà soát một lượt việc gán tài khoản cho từng chỉ tiêu TT99 (xem mục 4).
- [ ] GĐ2/GĐ3: thêm thuộc tính kỳ hạn (ngắn/dài hạn) cho công nợ, tiền gửi, vay để tách dòng dài hạn B01 TT99; B03 phân loại dòng tiền theo mã luồng tiền trên chứng từ thay vì chỉ theo cặp tài khoản.
- [ ] Hệ thống tài khoản TT200 vẫn lấy từ SUNSOFT, chưa đối chiếu Phụ lục 1 TT 200/2014 (TT200 đã bị TT99 thay từ 2026; ưu tiên thấp).
- [x] Mẫu tờ khai 01/GTGT theo TT 89/2026 (Phụ lục I, trang 241–243): 30 chỉ tiêu [21]–[43] nhập từ ảnh trang gốc vào `data/tax/01gtgt-tt89.json`, cổng `01GTGT_TT89=true` (GĐ2 Task 21, 2026-10-22). Hai cổng còn `false`: `01GTGT_TT89_rate8` (nhóm 8% tạm gộp vào [32]/[33]) và `01GTGT_TT80` (chưa có văn bản gốc TT 80/2021), xem mục 4.
- [ ] Ký hiệu hóa đơn theo TT 91/2026 (Phụ lục I, đã có chữ): dùng cho GĐ5.

## 3. Các giai đoạn tiếp theo

Chi tiết công việc và tiêu chí nghiệm thu: `docs/superpowers/plans/2026-10-19-lo-trinh-thuc-hien.md`. Danh sách nghiệp vụ và mức ưu tiên: đặc tả mục 9. Tham số pháp lý: đặc tả mục 10.

- [ ] **GĐ2 — Tiền, công nợ, thuế GTGT** (5–6 tuần): Phiếu thu/chi, Giấy báo nợ/có, UNC, chuyển tiền nội bộ, tạm ứng; sổ quỹ, sổ tiền gửi, tỷ giá xuất quỹ; `open_item`/`settlement`, đối trừ, bù trừ, chênh lệch tỷ giá, đánh giá lại ngoại tệ, tuổi nợ, biên bản đối chiếu; hóa đơn mua/bán dịch vụ và `voucher_invoice`; động cơ thuế `tax`/`tax_distribution`; bảng kê và tờ khai 01/GTGT, XML HTKK (TT 80/2021 cho kỳ trước 01/07/2026, TT 89/2026 sau đó); nhập chứng từ Excel; khử trùng chứng từ.
- [ ] **GĐ3 — Kho và mua bán hàng hóa** (6–8 tuần): VTHH đầy đủ, kho, số dư tồn đầu kỳ (mở khóa tài khoản 15x), `stock_move`/`stock_cost_layer`/`stock_cost_assignment`/`costing_run`, chứng từ nhập/xuất/chuyển/lắp ráp/kiểm kê, mua/bán hàng hóa, giá vốn 4 phương pháp, báo cáo kho và bán hàng.
- [ ] **GĐ4 — Tài sản và khế ước** (4 tuần): TSCĐ, CCDC, chi phí trả trước, khế ước vay, chứng từ tự động, quy trình cuối kỳ có thứ tự.
- [ ] **GĐ5 — Hóa đơn điện tử và tích hợp** (5–6 tuần): `EInvoiceProvider` + adapter Viettel SInvoice, vòng đời hóa đơn theo NĐ 254/2026 + TT 91/2026, ký số (USB token qua tiện ích cục bộ, ký từ xa), hóa đơn đầu vào XML theo QĐ 1450/QĐ-TCT, ngân hàng (webhook SePay/Casso, sao kê, VietQR), tờ khai TNDN/TNCN, API cho phần mềm bán hàng.
- [ ] **GĐ6 — Lương, giá thành, hợp đồng** (5–6 tuần).
- [ ] **GĐ7 — Mở rộng**: hộ kinh doanh TT 152/2025, siêu nhỏ TT 58/2026, hình thức sổ khác, đa chi nhánh/hợp nhất, ngân sách, song ngữ, mobile, trợ lý AI.

### Hạn chế đã biết của GĐ2

- Tỷ giá xuất quỹ (Task 10): chuyển tiền giữa hai tài khoản tiền cùng loại ngoại tệ (chuyển tiền nội bộ giữa hai TK 1122, rút tiền gửi ngoại tệ về quỹ 1112, nộp quỹ ngoại tệ vào ngân hàng) mà có chứng từ ghi lùi: chứng từ XQ tính lại bên chuyển đi theo bình quân di động, đối ứng 515/635; bên nhận giữ giá trị đã ghi cho đến khi chi hết nguyên tệ hoặc đánh giá lại cuối kỳ. Cách sửa đúng: đẩy phần lệch sang nhóm nhận thay vì 515/635, cần một lượt duyệt chung theo ngày qua các nhóm.
- Đánh giá lại ngoại tệ cuối kỳ (Task 13):
  - Mỗi loại tiền chỉ có một tỷ giá đánh giá lại cho tài sản và một cho nợ phải trả. TT99 TK413 mục 1.5.1 và 4.2 yêu cầu tiền gửi không kỳ hạn đánh giá lại theo tỷ giá của ngân hàng nơi mở tài khoản. Cần thêm tỷ giá theo ngân hàng (`bank_account`).
  - Chưa loại trừ khoản phải thu đã trích lập dự phòng nợ khó đòi (TT99 1.5.1) vì chưa có phân hệ dự phòng. Làm khi có phân hệ dự phòng (GĐ6).
  - Chứng từ DG theo TT99 ghi gộp Có 515 và Nợ 635; B02 TT99 mã 22/23 trình bày số thuần chênh lệch đánh giá lại (Task 27b, xong). Nếu sau này có chứng từ hệ thống mới ghi 515/635 do đánh giá lại, phải thêm vào điều kiện nhóm đánh giá lại trong `financial.ts`.
  - Chỉ đánh giá lại tiền, tiền gửi (111x, 112x) và 131, 331. Chưa đánh giá lại 113, 1281, 244, 341, 1388, 3388 và các khoản mục tiền tệ khác (TT99 1.3 a, c, d).
  - Nhóm tiền có nguyên tệ bằng 0 nhưng còn dư VND (công ty dùng phương pháp tỷ giá đích danh) vẫn cần tỷ giá của ngày đánh giá lại; thiếu tỷ giá thì báo `FX_RATE_MISSING`, dù số đánh giá lại không phụ thuộc tỷ giá.
  - Đảo chứng từ có khoản công nợ đã đánh giá lại: chênh lệch đánh giá lại còn lại được kết chuyển bằng chứng từ CL ghi ngày muộn hơn trong hai ngày (ngày đảo, ngày DG). Kỳ của ngày đó phải ghi được. Khi chạy lại đánh giá lại, CL đó ghi ngày đảo. Nếu kỳ chứa ngày đảo đã khóa sổ mà người chạy không có quyền ghi lùi, hoặc phân hệ công nợ của kỳ đó đã khóa, cả lần chạy lại bị hủy. Thông báo lỗi nêu kỳ sau, dễ gây khó hiểu. CL do lần chạy lại sinh ra vẫn mang diễn giải "khi đảo chứng từ…" và chưa liên kết với `fx_run`.
  - Chứng từ đảo ghi ngày trước ngày DG: sau khi chạy lại, cùng ngày có cả lãi 515 và lỗ 635 bằng nhau, số thuần bằng 0 (xử lý cùng mục trình bày thuần B02 ở trên).
  - Mỗi lần chạy lại có thay đổi, bước đóng khoản con của khoản gốc đã đảo quét mọi nhóm đối trừ loại đảo của công ty (có chỉ mục `parent_id`, chưa đo trên dữ liệu lớn). Có thể giới hạn vào các khoản gốc mà lần chạy chạm tới.
  - Số dư đầu kỳ (DK) đã được đánh giá lại thì không sửa được: phải chạy lại đánh giá lại sau khi sửa, nhưng DK chưa có đường gỡ khoản con.
  - Route đối trừ công nợ không giữ khóa `fx`. Một lần đối trừ chạy đúng lúc đang đánh giá lại có thể để lại khoản con mồ côi (cửa sổ rất hẹp).
- Phân bổ doanh thu nhận trước (Task 20):
  - Lịch kiểm tài khoản theo chế độ kế toán của kỳ bắt đầu. Lịch kéo sang năm có chế độ khác (TT133 sang TT99) mà tài khoản không có ở chế độ mới thì chỉ báo lỗi khi chạy kỳ đó.
  - Năm chưa tạo được giả định 12 kỳ. Năm tạo sau với số kỳ khác 12 thì lịch đã phân bổ không xếp lại được: chạy kỳ báo `AMORTIZATION_PERIOD_LAYOUT`, người dùng ngừng lịch và lập lịch mới cho phần còn lại.
  - Chạy lại và gỡ lịch luôn đảo chứng từ PB vào ngày cuối kỳ, kể cả kỳ mở (giống chứng từ tỷ giá xuất quỹ Task 10, vì guard 0030 chặn bỏ ghi sổ chứng từ tự động).
- Tờ khai 01/GTGT (Task 23):
  - Kỳ trước 01/7/2026 trả 409 `VAT_TEMPLATE_UNAVAILABLE` vì chưa có văn bản gốc TT 80/2021 (mục 4).
  - Hàng bán thuế suất 8% tạm cộng vào [32]/[33], có cảnh báo (mục 4).
  - [25] (thuế đầu vào dùng chung phân bổ theo tỷ lệ doanh thu chịu thuế) là cách tính của phần mềm, người dùng ghi đè được.
  - Tờ khai bổ sung kỳ trước: [22] luôn lấy [43] của tờ khai lần đầu đã chốt của kỳ trước; chênh lệch bổ sung chỉ được gợi ý vào [37]/[38] của kỳ chứa ngày chốt tờ khai bổ sung (TT 89/2026 Phụ lục II điểm 3), "kỳ phát hiện" là giả định của phần mềm.
  - Đối chiếu thuế: chứng từ nộp thuế GTGT nhận diện khi không có hóa đơn, có dòng 111/112 và dư Nợ thuần 33311; nộp qua tài khoản trung gian (3388/1388) vẫn hiện là lệch.
  - Chạy lại khấu trừ thuế một ngày không tự chạy lại các ngày sau (chỉ cảnh báo `laterOffsetDates`).
- Nhập chứng từ từ Excel (Task 25):
  - Tối đa 2.000 nhóm và 20.000 dòng mỗi tệp, chạy đồng bộ trong một yêu cầu (khoảng 25 giây cho 2.000 nhóm, cả lượt Kiểm tra); tệp lớn hơn cần việc nền pg-boss (GĐ sau).
  - Mỗi nhóm chạy trong một SAVEPOINT của cùng giao dịch. Vượt 64 giao dịch con, PostgreSQL đánh dấu tràn bộ đệm giao dịch con và các phiên khác phải tra `pg_subtrans` khi kiểm tra khả kiến: chậm phiên khác trong lượt nhập, không sai kết quả, không giữ thêm khóa. Hướng xử lý: lượt Nhập không dùng SAVEPOINT khi lượt Kiểm tra vừa sạch, hoặc đẩy sang việc nền.
  - Lượt Kiểm tra không ghi sổ nên không phát hiện lỗi chỉ có khi ghi sổ (kỳ đã khóa, quỹ âm); lỗi này hiện ở lượt Nhập.
  - Khóa chống nhập trùng tính theo nội dung từng nhóm (số nhóm + các dòng đã sắp xếp): sửa một nhóm rồi nhập lại tạo chứng từ mới cho nhóm đó, chứng từ cũ vẫn còn.
  - Tệp xlsx giải nén thật có giới hạn (100 MB mỗi mục, 200 MB tổng, 10.000 mục) bằng chính JSZip mà exceljs dùng; tệp 20 MB có hàng trăm nghìn mục thư mục vẫn tốn vài giây trong bước đọc thư mục (exceljs cũng tốn như vậy).
- Khử trùng chứng từ (Task 26):
  - Chưa đo `EXPLAIN ANALYZE` trên 100.000 chứng từ; ước tính 1–3 giây cho một năm. Đo trước khi tag GĐ2 hoặc khi có dữ liệu thật.
  - Đánh dấu "Không trùng" chưa xem lại hay gỡ được (cần màn hình danh sách cặp đã bỏ qua).
  - Người thiếu cờ xem công nợ/giá vốn không thấy cặp có tài khoản đó (có cảnh báo), trong khi danh sách chứng từ chung không lọc theo cờ (quyết định GĐ1 #244).
- Soát lỗi GĐ2 (Task 27):
  - Quy tắc có cờ nhạy cảm bị bỏ cả quy tắc khi người dùng thiếu một cờ (`skipped`), không lọc từng dòng; `SO_DU_SAI_LOAI` nay cần `view_cost`.
  - `THUE_LECH` sao lại logic đối chiếu thuế của `register.ts` bằng SQL (có kiểm thử so khớp), danh sách loại giảm giá/trả lại GGB/GGM viết cứng vì cờ `refund` chỉ có trong TypeScript.
  - `TIEN_MAT_VUOT_NGUONG` coi hóa đơn kê khai trên chứng từ có dòng Có tài khoản tiền mặt là trả tiền mặt; chứng từ gộp nhiều nội dung có thể báo thừa.
  - Chưa đo hiệu năng `CN_LECH_SO_CAI`, `HD_TRUNG` trên dữ liệu lớn (giới hạn 15 giây mỗi quy tắc).

## 4. Chờ người dùng

| Việc | Vì sao cần người dùng | Ảnh hưởng nếu chưa có |
|---|---|---|
| Kế toán trưởng rà soát chỉ tiêu B01/B02/B03 TT99 và TT133 (`packages/coa-data/data/reports/*/B0*.csv`, ghi chú gần đúng trong `status.json`) | Gán tài khoản cho chỉ tiêu cần phán đoán nghề nghiệp | Số trên BCTC có thể lệch ở các dòng gần đúng |
| Kiểm tay gõ Telex/VNI trong lưới nhập liệu (Chrome và Safari trên máy thật) | Bộ gõ tiếng Việt không giả lập được trong Playwright headless | Có thể lỗi mất dấu khi nhập diễn giải |
| Văn bản gốc QĐ 1450/QĐ-TCT (07/10/2021) và QĐ 1510/QĐ-TCT (định dạng XML hóa đơn điện tử), hoặc quyết định mới thay thế nếu đã có: gdt.gov.vn không truy cập được từ VPS (timeout), vbpl.vn chặn bằng JavaScript, thuvienphapluat 403. Cần tải bằng trình duyệt ở Việt Nam, chép vào `~/legal-docs/qd1450/` | Trang luật chặn tải tự động | XML hóa đơn GĐ5 chỉ theo tài liệu thứ cấp, chưa kiểm chứng |
| Bộ XML mẫu kết xuất từ HTKK 5.x (01/GTGT, 03/TNDN, 05/KK-TNCN, BCTC) | HTKK chạy trên Windows, không có XSD công khai | XML tờ khai GĐ2 chưa kiểm chứng được |
| Tài khoản thử Viettel SInvoice; SePay hoặc Casso; chứng thư số thử (USB token hoặc VNPT SmartCA) | Đăng ký tài khoản và ký hợp đồng là việc của người dùng | GĐ5 chỉ có adapter giả lập |
| Remote GitHub (nếu muốn CI chạy) | Tạo repo và quyền push là quyết định của người dùng | CI trong `.github/workflows` chưa chạy |
| Mẫu Ủy nhiệm chi giấy của từng ngân hàng (Vietcombank, BIDV, VietinBank, Agribank, Techcombank, MB, ACB… theo ngân hàng công ty đang dùng): file PDF hoặc ảnh quét mẫu trắng, chép vào `~/legal-docs/unc-ngan-hang/<mã ngân hàng>.pdf` | Mẫu giấy là tài sản của từng ngân hàng, không tải công khai được; cần đối chiếu bố cục từng ô để in đúng lên giấy in sẵn | Ủy nhiệm chi chỉ có một bố cục chung nội bộ (đơn vị trả tiền, đơn vị thụ hưởng, số tiền bằng số và chữ, nội dung), chưa in vừa mẫu giấy của ngân hàng |
| Văn bản gốc TT 200/2014/TT-BTC (Mẫu 01-TT, 02-TT) và văn bản chế độ TT 58 (nếu có mẫu chứng từ), chép vào `~/legal-docs/tt200-2014/`, `~/legal-docs/tt58/` | Chưa tải về VPS; luật dự án không cho chép mẫu từ trí nhớ | Phiếu thu, Phiếu chi của công ty theo TT200 hoặc TT58 in đúng bố cục nhưng không có dòng "Mẫu số" và chú thích ban hành |
| Văn bản gốc TT 80/2021/TT-BTC (29/9/2021), Phụ lục II mẫu 01/GTGT: Công báo, vanban.chinhphu.vn, datafiles.chinhphu.vn không tìm được bản chính thức từ VPS. Cần tải và chép vào `~/legal-docs/tt80-2021/` | Trang luật chặn tải tự động; không chép mẫu từ trí nhớ hay bản sao không chính thức | Tờ khai 01/GTGT cho kỳ trước 01/7/2026 trả 409 `VAT_TEMPLATE_UNAVAILABLE` |
| Xác nhận hàng bán thuế suất 8% (NĐ 174/2025) khai vào chỉ tiêu nào của 01/GTGT TT 89/2026, kèm công văn hướng dẫn của Cục Thuế nếu có | TT 89/2026 và NĐ 174/2025 không nêu chỉ tiêu; cần văn bản hướng dẫn hoặc thực tế HTKK | Nhóm 08 tạm gộp vào [32]/[33]; tờ khai cảnh báo khi kỳ có hóa đơn 8% (`isVatRate8Verified()` = false) |
| Tên miền và cách triển khai thật (qua nginx proxy manager sẵn có hay không) | Đụng dịch vụ đang chạy trên VPS | Chỉ chạy được nội bộ qua SSH tunnel |

## 5. Ghi chú môi trường

- VPS oracle: repo ở `~/phanmem-ketoan`, remote `origin` = `~/git/phanmem-ketoan.git` (bare). Trên máy Mac của người dùng, remote `oracle` trỏ tới repo bare đó: `git pull oracle main` để lấy về.
- Xem ứng dụng từ máy Mac: `ssh -L 5173:127.0.0.1:5173 -L 3000:127.0.0.1:3000 oracle` rồi mở `http://localhost:5173`.
- Playwright trên VPS oracle (aarch64, cài 2026-10-20): `playwright install --with-deps` lỗi vì kho apt bên thứ ba `packagecloud.io/ookla/speedtest-cli` trả 404 làm `apt-get update` thất bại (không sửa vì là cấu hình hệ thống ngoài dự án). Cách cài: `pnpm -F @kt/api exec playwright install-deps --dry-run chromium` lấy danh sách gói, `sudo apt-get install -y --no-install-recommends <các gói>` (đã cài: phông `fonts-*`, `libgbm1`, mesa, `xvfb`, `xauth`…; thêm `unzip` cho `exportAuthority.test.ts`), rồi `pnpm -F @kt/api exec playwright install chromium` và tương tự cho `@kt/web` (trình duyệt ở `~/.cache/ms-playwright`).
- Gói hệ thống đã cài thêm cho dự án (2026-10-20): `unzip`, `postgresql-client-16` (`pg_dump` cho kiểm thử sao lưu), `poppler-utils` (`pdftotext` cho văn bản pháp lý), `tesseract-ocr` + `tesseract-ocr-vie` (OCR bản scan TT 89/2026, 2026-10-20). Khi `apt-get update` lỗi vì kho ookla: `sudo apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources -o Dir::Etc::sourceparts=-`.
- Kiểm thử trên VPS chạy với cơ sở dữ liệu tạm `ketoan_test` theo `docs/dev/kiem-thu.md` (Docker cần `sudo`: `sudo docker compose exec -T postgres createdb -U postgres ketoan_test`).
