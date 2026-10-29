# Hạn chế đã biết

Chuyển từ `docs/TIEP-THEO.md` ngày 2026-10-30. Đây là giới hạn của sản phẩm hiện tại (cách làm gần đúng, trường hợp hiếm chưa xử lý, chỗ chưa đo hiệu năng), không phải việc tồn đọng. Khi một hạn chế trở thành việc cần làm (có người dùng gặp, hoặc cần trước khi đưa vào dùng thật), chuyển nó sang mục "Việc agent" của `docs/TIEP-THEO.md`.

## Hạn chế đã biết của GĐ6

Chi tiết ở mục 21 của `docs/user/giai-doan-6-luong-gia-thanh-hop-dong.md` và sổ quyết định `2026-10-24-giai-doan-6-quyet-dinh.md`.

- Pháp lý: tham số lương, TNCN, BHXH, lương tối thiểu vùng kỳ 2026 đã nhập từ văn bản gốc (QĐ 1760–1771, `data/tax/legal-params-payroll.json`); chưa nhập làm thêm giờ, miễn thuế bổ sung, thời điểm tính thu nhập và mọi kỳ trước 2026 (công ty tự nhập); dòng `legal_param` thắng tham số công ty nên không ghi đè được 0,3% TNLĐ-BNN hay miễn KPCĐ. Mẫu 05/KK-TNCN, 05/QTT-TNCN và phụ lục đã nhập (cổng `05KK_TNCN_TT89`, `05QTT_TNCN_TT89` true) nhưng XML, ký số vẫn 409 `TNCN_TEMPLATE_UNAVAILABLE` (cổng `TNCN_XML_HTKK` false, chưa có tệp kết xuất HTKK) và chưa ánh xạ bảng kê vào chỉ tiêu; chứng từ khấu trừ chưa có mẫu gốc; tệp chi hộ ngân hàng chỉ có mẫu "Chung"; tệp BHXH là bảng cột chung (chưa I-VAN); chưa in số mẫu cho báo cáo lương, thẻ giá thành.
- Lương: bảng đã hạch toán trước bản sửa 0111 vẫn ghi tạm ứng vào 3388 và không tự hiện "Cần chạy lại"; 3388 tính bằng phép trừ nên có thể âm nếu ghi đè cột `other_withholding`; tài khoản Có của cột khấu trừ dùng chung mọi chế độ; người thiếu `view_salary` vẫn thấy dòng 141 theo nhân viên trên chứng từ LU; bảng lương một người lộ tổng của người đó (ngang sổ quỹ).
- Giá thành: dòng GV gộp bị bỏ cả dòng khi cùng hàng, kho vừa nhập thành phẩm vừa xuất lại vào sản xuất cùng chiều (#965a); TK 154 còn viết cứng ở `collect.ts` (TT133) và sổ chi tiết 154 trong `reports.ts` (#963); dự phòng nợ khó đòi (TT99 1.5.1) vẫn ngoài phạm vi.
- Bảo mật còn khe: sự kiện kiểm toán của `payroll_structure`, `attendance_*`, `payroll_run_voucher` chưa rà; sửa riêng dòng 111/112 của chứng từ lương rồi đổi hết dòng lương thì sự kiện dòng tiền vẫn hiện (#989).
- Hiệu năng chưa đo: quy tắc soát lỗi VU_VIEC (nhìn lại 36 tháng), cột tùy biến bằng công thức, lưới 500×40, điều kiện EXISTS mới trên nhật ký kiểm toán, cột `cost_hash` mỗi lần mở bảng lương. Đã đo: lương 2.000 nhân viên, giá thành 200 đối tượng × 10.000 dòng (`docs/dev/hieu-nang.md`).
- Môi trường: DB tạm `ketoan_e2e` trong sandbox chưa xóa được (vai trò `root` không tồn tại); DB phát triển `ketoan` cần `pnpm db:migrate` lên 0111 trước khi chạy E2E.

## Hạn chế đã biết của GĐ5

Chi tiết và lý do trong sổ quyết định `2026-10-24-giai-doan-5-quyet-dinh.md`; phần dành cho người dùng ở mục "Hạn chế đã biết" của `docs/user/giai-doan-5-hoa-don-tich-hop.md`.

- Tích hợp chưa thử trên môi trường thật: Viettel SInvoice, SePay, Casso (chuẩn JSON ký V2 với chữ có dấu, chiều số tiền âm), VNPT SmartCA (`tranId`, trạng thái), USB token qua PKCS#11 (tiện ích tham chiếu chỉ ký bằng `.pfx`); chưa có adapter meInvoice/VNPT/BKAV, T-VAN, nhận hóa đơn qua email, ký PDF (PAdES), kiểm chuỗi tin cậy CA của chữ ký, mẫu sao kê riêng từng ngân hàng.
- XML: hóa đơn điện tử theo QĐ 1233 lấy từ tài liệu thứ cấp; XML HTKK 01/GTGT và 03/TNDN `verified=false`.
- Hóa đơn điện tử: dữ liệu cũ không được dọn khi chuyển từ 0092 sang 0093 (chỉ ảnh hưởng DB phát triển); tệp không phải PDF của nhà cung cấp giả lập tải xuống không có tên tệp; thay thế/hủy hóa đơn gỡ liên kết giao dịch ngân hàng đã đối chiếu mà không cảnh báo; soát lỗi `HDDT_CHUA_PHAT_HANH` lặp chứng từ theo từng thuế suất và trùng ý với `HDDT_DANG_GUI`/`HDDT_LOI`; job đối soát dựa vào hạn pg-boss mặc định (15 phút) — chạy quá lâu có thể chạy chồng (chỉ phí công, không phát hành trùng); thiếu kiểm thử zip bom/zip lồng của tệp nhà cung cấp.
- Ngân hàng: gắn giao dịch đồng thời với bỏ ghi sổ chứng từ có thể bế tắc (500, thử lại được); ngày không năm trong diễn giải ("05/10") có thể gợi ý nhầm hóa đơn số 5, 10; chứng từ đảo và bị đảo hiện là dòng sổ cái chưa đối chiếu; lập Giấy báo từ giao dịch tài khoản ngoại tệ chưa hỗ trợ; xoay khóa API/bí mật HMAC phải xóa và tạo lại kết nối; SePay dạng form-encoded chưa hỗ trợ; `PUBLIC_BASE_URL` phải đặt ở production (không thì URL webhook lấy theo Host của yêu cầu).
- VietQR: chưa có cờ "tài khoản nhận mặc định" (lấy tài khoản VND có BIN mã nhỏ nhất); chưa quét thử bằng ứng dụng ngân hàng; danh sách BIN lấy từ VietQR, không phải văn bản NAPAS.
- Khóa API: giới hạn 60 yêu cầu/phút đếm trong bộ nhớ từng tiến trình; lỗi xác thực chưa giới hạn theo IP; `/stock` giá trị theo lần tính giá vốn gần nhất; dấu vân tay đơn bán không gồm `einvoiceSeriesId`, tên/địa chỉ khách.
- Thuế TNDN: không có phụ lục kết quả SXKD (không có mẫu gốc); giảm 30% NQ 43 chỉ gợi ý trên thuế SXKD, tạm tính quý chưa giảm; số đã tạm nộp tính từ 01/04 (nộp sớm tháng 3 phải ghi đè); quy đổi 12 tháng theo số tháng năm tài chính; bấm "Lập chứng từ chi phí thuế TNDN" hai lần trước khi ghi sổ sinh hai bản nháp; cửa sổ đã nộp theo chế độ hiện hành khi năm sau đổi chế độ.
- Màn hình: mã lỗi chưa thống nhất ở vài chỗ (`NOT_FOUND`, 422), hàm `vnToday` lặp; bất biến 9 mặc định 12 chuỗi (dùng `FC_RUNS` để chạy sâu) và chưa khẳng định chuỗi ngẫu nhiên đi qua trạng thái "đang gửi".

## Hạn chế đã biết của GĐ4

Chi tiết và lý do trong sổ quyết định `2026-10-23-giai-doan-4-quyet-dinh.md`; phần dành cho người dùng ở mục "Hạn chế đã biết" của `docs/user/giai-doan-4-tai-san-khe-uoc.md`.

- Tài sản:
  - Lần chạy khấu hao, phân bổ không hủy được (chỉ chạy lại bằng đảo): sau lần chạy đầu tiên, đổi cách tính tháng đầu/cuối (`FA_PRORATION_LOCKED`) và sửa ngày bắt đầu, thời gian sử dụng, cờ khấu hao trên thẻ (`ASSET_SCHEDULE_LOCKED`) bị chặn vĩnh viễn; chỉ còn nghiệp vụ đổi thời gian sử dụng, ngừng/tiếp tục khấu hao. API PUT thẻ bỏ trống `lifeUnits`/`isDepreciable` trên thẻ đã chạy cũng trả 409.
  - Sửa phân bổ chi phí của thẻ chưa vào lần chạy nào không tự chạy lại kỳ (QĐ 514): soát lỗi và quy trình cuối kỳ báo "Cần chạy lại".
  - Chạy lại giá vốn (bước đầu quy trình cuối kỳ) làm mọi bước sau chuyển "Cần chạy lại"; chạy lại không đổi số nhưng thêm thao tác.
  - Dòng 214x của chứng từ trước GĐ4 không có `asset_id` không đảo được (`LINE_ASSET_REQUIRED` từ migration 0069); chưa có dữ liệu thật nên chưa xử lý.
  - Hủy ghi giảm "chuyển thành CCDC" không xét nghiệp vụ sau đó của thẻ CCDC; số dư đầu kỳ nhiều dòng trên một tài khoản thẻ có thể làm phần dư âm; danh sách thẻ cột "Số kỳ còn lại" đọc lịch đã lưu (cũ đến lần chạy sau); `assertNoGap` thử kỳ trước trong savepoint mỗi lần chạy; soát lỗi tài sản gọi `fn_asset_values_at` theo từng lần chạy (chậm với công ty lớn).
  - Màn hình: chọn cách tính tháng đầu/cuối trên màn Công ty chưa có Playwright; nút "In biên bản" và Ghi giảm từ kiểm kê chưa có Playwright; PDF biên bản chưa kiểm (chỉ HTML).
- Khế ước vay:
  - Trả lãi không bị chặn theo số dư 335 của khế ước; báo cáo khế ước tính dòng đánh giá lại ngoại tệ vào cột Giải ngân/Trả gốc VND (tổng vẫn khớp sổ cái).
  - Dòng lãi vay LV ghi 627/241 chưa có đối tượng chi phí (bộ phận, vụ việc): GĐ6 giá thành cần bổ sung.
  - Giải ngân, trả nợ trả về chứng từ BC/BN không che số tiền với người thiếu `view_payable`; `period_run.result` lưu dòng lãi theo khế ước (chỉ đọc nội bộ khi kiểm "Cần chạy lại").
  - Trả lãi không kèm gốc vẫn bị 409 khi dư nợ ngày sau đã âm; đảo chứng từ chung đề ngày sau chặn ghi giảm ngày trước (phía an toàn).
- Kho liên quan: khóa ngoại `voucher_line → asset` thêm thẳng (không `NOT VALID`), an toàn vì bảng mới; phiếu xuất kho sinh CCDC/TSCĐ dùng giá vốn nên mỗi lần chạy lại giá vốn có thể đổi nguyên giá và làm khấu hao "Cần chạy lại".

## Hạn chế đã biết của GĐ3

Chi tiết và lý do trong sổ quyết định `2026-10-22-giai-doan-3-quyet-dinh.md`; phần dành cho người dùng ở mục "Hạn chế đã biết" của `docs/user/giai-doan-3-kho-mua-ban.md`.

- Giá vốn:
  - Lớp điều chỉnh (chênh giá hóa đơn, chi phí mua, hàng trả lại) được động cơ áp ở ngày nhập; sổ cái ghi ở ngày chứng từ nguồn. Đối chiếu lớp và sổ cái chỉ đúng từ ngày chứng từ nguồn trở đi; một lần tính giá vốn trải nhiều tháng lệch giá trị đến ngày chứng từ GV (QĐ 335, 382).
  - Gán giá theo quy tắc ngày thay vì `layer_id` nên chặn bỏ ghi sổ phiếu nhập hơi rộng (QĐ 225, 238); `fn_stock_estimate_cost` đọc giá của lần chạy trước (QĐ 250).
  - Tồn 0 còn giá trị khi mọi lần xuất cố định giá (đích danh, giá xuất cố định): soát lỗi `KHO_TON_0_CON_GIA_TRI` báo.
  - Chạy lại giá vốn ngay sau một lần chạy lớn trên công ty chưa `ANALYZE` có thể chọn kế hoạch truy vấn chậm (đo được 210 giây thay vì 17 giây trong `perf:costing`); autovacuum xử lý ở môi trường thật, chưa đo.
  - Hai phiếu trả lại hàng mua nháp cùng một dòng nhập không trừ nhau phần chi phí mua cho đến khi ghi sổ lần lượt.
- Màn hình: giá nhập thành phẩm, giá xuất cố định, thứ tự chứng từ trong ngày, cấu hình `stock_negative` chỉ có API; hợp đồng chỉ có API `/api/contracts`; lưới lắp ráp chưa chọn tài khoản chi phí bằng F4; e2e chưa phủ tháo dỡ, tỷ lệ phân bổ, điều chỉnh giá nhập.
- Đơn hàng: sửa số lượng trên BH/MH nháp sinh từ đơn không đồng bộ về đơn; liên kết của chứng từ đã hủy/đảo vẫn khóa đơn (`ORDER_LOCKED`); đơn ngoại tệ chưa thử chuyển thành chứng từ.
- Kiểm kê: chứng từ điều chỉnh chỉ chặn sửa/xóa ở API (không ở SQL); mở lại biên bản ở kỳ khóa cứng trả 409.
- Báo cáo: in S08-DNN/S12-DN thiếu cột F/G, S06-DNN thiếu "Ghi chú"; 01-VT/02-VT in cột "Theo chứng từ/Yêu cầu" bằng số thực nhập/xuất (hệ thống chỉ lưu một số lượng); giá trị PNK/MH trên 01-VT không gồm chi phí mua phân bổ (QĐ 350); báo cáo bán hàng chưa tính đảo của đảo; xuất Excel báo cáo bán hàng không giới hạn dòng.
- B01/B03 TT99: các dòng B01 bằng 0 ở mục 2; khoản vay dài hạn trong số dư đầu kỳ chưa nhập được ngày đáo hạn (lách bằng PKT Nợ 3411/Có 3411 cùng số tiền, ngày đáo hạn ở dòng Có); B03 ghép cặp nhiều dòng theo thứ tự nên mã luồng tiền chia theo cặp; `LCTT_THIEU_MA` đếm cả dòng nháp; CSV xuất cơ quan thẩm quyền chưa có `cash_flow_code`.

## Hạn chế đã biết của GĐ2

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
  - Đối trừ một khoản đã đánh giá lại với ngày trước ngày đánh giá lại bị từ chối (`SETTLEMENT_BEFORE_REVALUATION`, nêu ngày DG). Phiếu thu ghi lùi kèm chọn khoản công nợ đó cũng không ghi sổ được: bỏ chọn khoản, ghi sổ, rồi đối trừ ở màn hình Đối trừ chứng từ với ngày từ ngày DG. Sổ cái vẫn đúng vì đánh giá lại đã xét khoản Có chưa đối trừ của đối tượng; chỉ ngày đối trừ bị dời.
  - Chưa có kiểm thử chạy lại đánh giá lại khi kỳ sau đã khóa sổ mà người chạy không có quyền ghi lùi (hành vi đã mô tả ở trên).
- Phân bổ doanh thu nhận trước (Task 20):
  - Lịch kiểm tài khoản theo chế độ kế toán của kỳ bắt đầu. Lịch kéo sang năm có chế độ khác (TT133 sang TT99) mà tài khoản không có ở chế độ mới thì chỉ báo lỗi khi chạy kỳ đó.
  - Năm chưa tạo được giả định 12 kỳ. Năm tạo sau với số kỳ khác 12 thì lịch đã phân bổ không xếp lại được: chạy kỳ báo `AMORTIZATION_PERIOD_LAYOUT`, người dùng ngừng lịch và lập lịch mới cho phần còn lại.
  - Chạy lại và gỡ lịch luôn đảo chứng từ PB vào ngày cuối kỳ, kể cả kỳ mở (giống chứng từ tỷ giá xuất quỹ Task 10, vì guard 0030 chặn bỏ ghi sổ chứng từ tự động).
  - Chưa có kiểm thử đồng thời sửa/xóa lịch với chạy kỳ (cùng khóa tư vấn `amortization`, cập nhật `voucher_id` phải trúng đúng 1 dòng).
  - Lịch có chứng từ gốc nháp, đã đảo hoặc đã hủy bị bỏ qua khi chạy kỳ (`skipped`); lịch tự do (không có chứng từ gốc) vẫn chạy.
- Tờ khai 01/GTGT (Task 23):
  - Kỳ trước 01/01/2022 trả 409 `VAT_TEMPLATE_UNAVAILABLE`; kỳ 01/01/2022-30/6/2026 dùng mẫu TT 80/2021 (không có [32b], [34a]: số nhóm KTGT, NPV không vào tờ khai, có cảnh báo).
  - Hàng bán thuế suất 8% tạm cộng vào [32]/[33], có cảnh báo (mục 4).
  - [25] (thuế đầu vào dùng chung phân bổ theo tỷ lệ doanh thu chịu thuế) là cách tính của phần mềm, người dùng ghi đè được.
  - Tờ khai bổ sung kỳ trước: [22] luôn lấy [43] của tờ khai lần đầu đã chốt của kỳ trước; chênh lệch bổ sung chỉ được gợi ý vào [37]/[38] của kỳ chứa ngày chốt tờ khai bổ sung (TT 89/2026 Phụ lục II điểm 3), "kỳ phát hiện" là giả định của phần mềm.
  - Đối chiếu thuế: chứng từ nộp thuế GTGT nhận diện khi không có hóa đơn, có dòng 111/112 và dư Nợ thuần 33311; nộp qua tài khoản trung gian (3388/1388) vẫn hiện là lệch.
  - Chạy lại khấu trừ thuế một ngày không tự chạy lại các ngày sau (chỉ cảnh báo `laterOffsetDates`).
  - Khấu trừ thuế (KTT) và gợi ý [22] đọc toàn bộ lịch sử dòng 33311/133x, không dùng số dư đã tính sẵn; đo cùng `perf:100k` (`docs/dev/hieu-nang.md`).
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
- Công nợ và hóa đơn khác:
  - Tuổi nợ tính số còn dư của mọi khoản của công ty trước khi lọc theo đối tượng (đúng số; số đo trong `docs/dev/hieu-nang.md`). Nếu chậm: hàm `fn_open_items_at` có tham số tài khoản (GĐ3).
  - Màn hình chứng từ xóa kế hoạch đối trừ trong `useEffect` khi đổi đối tượng; Ctrl+S ngay lúc đó có thể gửi kế hoạch cũ, máy chủ kiểm lại khi ghi sổ (sai chiều hoặc vượt dư bị từ chối) nên không sai sổ. E2E `ty-gia` tích lũy hóa đơn trên DB E2E dùng lâu: dọn DB E2E định kỳ.
  - Dòng giá đã gồm thuế có cả GTGT và TNCN: TNCN không tính lại sau khi làm tròn số thuế GTGT khai báo (lệch vài đồng, hiếm).
  - Danh mục chưa có kiểm thử Playwright và tài liệu người dùng riêng (làm đầu GĐ3 cùng danh mục VTHH); E2E sổ quỹ rớt một lần khi chạy cả bộ.
- Hiệu năng ghi sổ (`docs/dev/hieu-nang.md`): việc ghi nhiều chứng từ trong một giao dịch trên công ty chưa được `ANALYZE` có thể chọn sai chỉ mục cho tra cứu `voucher` theo `id`. Từ 0042 kiểm cân bằng chỉ đọc dòng có `posting_date` bằng ngày chứng từ (`fn_line_before` và `trg_voucher_date_sync` bảo đảm); hai giao dịch cùng sửa một chứng từ nháp chưa khóa dòng chứng từ trong `fn_line_before`, về lý thuyết có thể để một dòng lệch ngày (không đi qua API được).
- Soát lỗi GĐ2 (Task 27):
  - Quy tắc có cờ nhạy cảm bị bỏ cả quy tắc khi người dùng thiếu một cờ (`skipped`), không lọc từng dòng; `SO_DU_SAI_LOAI` nay cần `view_cost`.
  - `THUE_LECH` sao lại logic đối chiếu thuế của `register.ts` bằng SQL (có kiểm thử so khớp), danh sách loại giảm giá/trả lại GGB/GGM viết cứng vì cờ `refund` chỉ có trong TypeScript.
  - `TIEN_MAT_VUOT_NGUONG` coi hóa đơn kê khai trên chứng từ có dòng Có tài khoản tiền mặt là trả tiền mặt; chứng từ gộp nhiều nội dung có thể báo thừa.
  - Chưa đo hiệu năng `CN_LECH_SO_CAI`, `HD_TRUNG` trên dữ liệu lớn (giới hạn 15 giây mỗi quy tắc).

