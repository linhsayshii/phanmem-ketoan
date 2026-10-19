# Lộ trình thực hiện: Phần mềm kế toán doanh nghiệp Việt Nam

> **Dành cho người thực hiện (người hoặc agent):** đây là lộ trình theo giai đoạn và tính năng, không phải kế hoạch từng bước có mã. Sau khi đặc tả được duyệt, mỗi giai đoạn sẽ được tách thành kế hoạch chi tiết theo chuẩn superpowers:writing-plans (từng tác vụ có kiểm thử, mã, lệnh chạy, commit) và thực hiện bằng superpowers:subagent-driven-development hoặc superpowers:executing-plans.

**Mục tiêu:** Ra một phần mềm kế toán web cho doanh nghiệp Việt Nam đạt mặt bằng nghiệp vụ MISA/Fast/SUNSOFT và tuân thủ TT 99/2025, TT 133/2016, hóa đơn điện tử 2026, theo thứ tự ưu tiên "dùng được sớm nhất cho doanh nghiệp dịch vụ, rồi thương mại, rồi sản xuất".

**Kiến trúc:** Modular monolith TypeScript (Fastify API + worker pg-boss) trên PostgreSQL, web React/Ant Design; sổ cái bất biến với máy trạng thái chứng từ, số dư theo kỳ, định nghĩa báo cáo theo dòng, chế độ kế toán đa phiên bản.

**Ngăn xếp:** Node.js 22, TypeScript, Fastify, Kysely, decimal.js, Zod, pg-boss, React 18, Vite, Ant Design 5, AG Grid Community, ExcelJS, Playwright, Vitest, fast-check, Docker Compose, PostgreSQL 16.

**Đặc tả:** `docs/superpowers/specs/2026-10-19-phan-mem-ke-toan-design.md`

## Ràng buộc toàn cục

- Tiền hạch toán VND: `NUMERIC(20,0)`; ngoại tệ `NUMERIC(20,4)`; không `float`, không `number` của JavaScript cho tiền.
- Không `UPDATE`/`DELETE` dòng sổ cái đã ghi sổ; mọi sửa đổi theo máy trạng thái mục 7.1 của đặc tả.
- Mọi bảng có `tenant_id`; mọi `UNIQUE` có `tenant_id`; row-level security bật từ giai đoạn 0.
- Mọi chứng từ tự động (giá vốn, khấu hao, phân bổ, kết chuyển, chênh lệch tỷ giá, lương) là chứng từ thật có số, ngày, người lập, `source_doc_*`.
- Tham số pháp lý theo ngày hiệu lực (`legal_param`), định nghĩa báo cáo là dữ liệu, chế độ kế toán gắn với năm tài chính.
- Tên nghiệp vụ, chứng từ, sổ, báo cáo trong giao diện dùng đúng tiếng Việt kế toán (Phiếu thu, Giấy báo có, Sổ cái, Bảng cân đối phát sinh…).
- Mỗi giai đoạn kết thúc bằng: bản chạy được bằng `docker compose up`, bộ dữ liệu mẫu, kiểm thử bất biến xanh, tài liệu người dùng ngắn cho tính năng mới.

## Nguyên tắc làm việc

1. TDD: viết kiểm thử thất bại trước cho mọi quy tắc nghiệp vụ; bất biến kế toán (mục 14 đặc tả) chạy trong CI trên PostgreSQL thật.
2. Commit nhỏ, thông điệp theo Conventional Commits; nhánh theo giai đoạn.
3. Ưu tiên mức Baseline trước Differentiator và Niche; không làm tính năng ngoài danh sách giai đoạn.
4. Mỗi quy tắc pháp lý ghi nguồn (số văn bản, điều khoản) ngay trong mã hoặc dữ liệu tham số.
5. Dữ liệu mẫu: một doanh nghiệp thương mại giả lập một năm (có ngoại tệ, TSCĐ, kho) được bổ sung dần qua các giai đoạn, dùng làm kiểm thử hồi quy cho BCTC.

---

## Giai đoạn 0: Nền tảng (2–3 tuần)

**Mục tiêu:** khung dự án chạy được, đăng nhập, công ty, kỳ kế toán, hệ thống tài khoản đa chế độ, danh mục khung, nhật ký kiểm toán, nhập Excel.

**Công việc**

- [ ] Monorepo pnpm: `apps/api`, `apps/web`, `apps/worker`, `packages/db` (migration + kiểu), `packages/domain` (quy tắc nghiệp vụ thuần), `packages/ui`; Docker Compose (postgres, api, web, worker); CI chạy lint, typecheck, test.
- [ ] Migration nền: `tenant`, `user`, `role`, `permission`, `audit_event`, `legal_param`, `fiscal_period`, `account`, `coa_template`; RLS cho mọi bảng; vai trò DB ứng dụng.
- [ ] Xác thực phiên, mật khẩu Argon2, vai trò/quyền theo chức năng (xem/thêm/sửa/xóa/in/ghi sổ/bỏ ghi sổ/khóa) và cờ dữ liệu nhạy cảm; màn hình quản lý người dùng.
- [ ] Tạo công ty: thông tin pháp lý (tên, MST, địa chỉ, người đại diện, kế toán trưởng), năm tài chính (ngày bắt đầu, 12 tháng, năm đầu ≤ 15 tháng), chế độ kế toán cho năm, tùy chọn hệ thống (hình thức sổ, phương pháp giá vốn mặc định, tiền tệ, đánh số chứng từ, ẩn/hiện nghiệp vụ, trường mở rộng).
- [ ] Mẫu hệ thống tài khoản: nhập TT 99/2025 (từ văn bản gốc, đối chiếu `DesBC_*_99` của SUNSOFT), TT 133/2016 (đối chiếu `OrgDMTK` 133 tài khoản), TT 200/2014 (đối chiếu `OrgDMTK_200` 243 tài khoản và Odoo `l10n_vn`); thuộc tính loại dư, lưỡng tính, chi tiết/tổng hợp, theo dõi ngoại tệ, loại sub-ledger. Sinh hệ thống tài khoản công ty từ mẫu; thêm tiểu khoản; đổi số hiệu/ghép tài khoản (chưa có dữ liệu ở giai đoạn này).
- [ ] Danh mục khung và CRUD + lưới: đối tượng (khách/NCC/nhân viên dùng chung, nhóm, MST/CCCD, địa chỉ hóa đơn, tài khoản ngân hàng, hạn thanh toán, hạn mức), bộ phận/chi nhánh, nhân viên, loại tiền + bảng tỷ giá theo ngày, ngân hàng và tài khoản ngân hàng, hình thức thanh toán, loại thuế (GTGT 0/5/8/10, không chịu thuế, NK, TTĐB), nhóm hóa đơn mua/bán, khoản mục chi phí, vụ việc/công trình (cây), đơn vị tính.
- [ ] Nhập khẩu danh mục từ Excel theo mẫu (tải mẫu, kiểm tra, báo lỗi theo dòng, nhập).
- [ ] Thành phần giao diện chung: lưới nhập liệu điều khiển bằng bàn phím (Enter/Tab/mũi tên, thêm dòng, F4 chọn danh mục, thêm nhanh danh mục tại ô), bộ lọc nhớ theo người dùng, định dạng số/ngày kiểu Việt Nam.
- [ ] Nhật ký kiểm toán ghi mọi thay đổi danh mục/cấu hình với giá trị trước/sau; màn hình xem nhật ký.
- [ ] Sao lưu `pg_dump` theo lịch (worker), phục hồi bằng lệnh.
- [ ] Bộ dữ liệu mẫu: công ty "Thương mại ABC", 30 đối tượng, hệ thống tài khoản TT99.

**Tiêu chí nghiệm thu**

- Hai công ty trong cùng DB không thấy dữ liệu của nhau (kiểm thử RLS tự động cho từng bảng).
- Nhập 500 đối tượng từ Excel dưới 5 giây, lỗi báo đúng dòng.
- Hệ thống tài khoản TT99 và TT133 khớp văn bản (kiểm thử đối chiếu số tài khoản).

**Phụ thuộc:** quyết định ngăn xếp (G7), văn bản gốc TT 99/2025 Phụ lục II.

---

## Giai đoạn 1: Lõi sổ cái (5–6 tuần)

**Mục tiêu:** doanh nghiệp dịch vụ không có kho hạch toán được cả năm bằng Phiếu kế toán và in đủ sổ, BCTC.

**Công việc**

- [ ] Bảng `voucher`, `voucher_line` (partition theo tháng), `voucher_counter`, `voucher_line_history`, `account_period_balance`; constraint trigger cân bằng; trigger bất biến; thủ tục `post_voucher`, `unpost_voucher`, `reverse_voucher`, `discard_voucher`.
- [ ] Máy trạng thái chứng từ và bảng quyết định sửa/xóa theo trạng thái kỳ (mục 7.1 đặc tả); quyền "sửa sau ghi sổ".
- [ ] Kỳ kế toán: mở/khóa mềm/khóa cứng theo tháng, khóa theo phần hành, hash chuỗi khi khóa cứng, công cụ kiểm tra hash.
- [ ] Đánh số chứng từ không lỗ hổng theo loại/năm, cấu hình tiền tố/hậu tố/độ dài, đánh lại số theo ngày trong kỳ mở, kiểm tra trùng.
- [ ] Màn hình Phiếu kế toán (chứng từ nghiệp vụ khác): nhiều dòng Nợ/Có, đối tượng, khoản mục chi phí, bộ phận, vụ việc, hợp đồng, ngoại tệ và tỷ giá theo dòng, diễn giải, đính kèm, nhân bản, in.
- [ ] Số dư đầu kỳ tài khoản (kỳ 0): VND/ngoại tệ, đúng loại dư, công nợ chi tiết theo đối tượng; kiểm tra chênh lệch chi tiết với tài khoản; nhập Excel.
- [ ] Số dư theo kỳ: tính, làm bẩn theo ngày hiệu lực, worker tính lại, API đọc số dư tại ngày.
- [ ] Sơ đồ kết chuyển/phân bổ: `closing_step` (kết chuyển giảm trừ doanh thu, kết chuyển doanh thu/chi phí, xác định lãi lỗ; phân bổ theo tỷ lệ), chạy từng bước sinh chứng từ `KC`/`PB`, chạy lại bằng đảo; kết chuyển lợi nhuận năm nay sang năm trước đầu năm.
- [ ] Sổ sách Nhật ký chung: S03a-DN nhật ký chung, S03b-DN sổ cái (theo chứng từ, theo tiểu khoản, chữ T), sổ chi tiết tài khoản, bảng cân đối phát sinh (cộng cấp, tách dư hai bên theo đối tượng cho tài khoản lưỡng tính), sổ chi tiết theo đối tượng/khoản mục/vụ việc; truy ngược về chứng từ.
- [ ] Định nghĩa báo cáo theo dòng: engine công thức mã tài khoản (`'111 + 112'`, `'131(1312)'`, dư Nợ/dư Có/thuần, đối ứng), bộ B01/B02/B03/B09 TT99 và TT133; so sánh năm trước, giữa niên độ; truy ngược chỉ tiêu; người dùng sửa công thức và nạp lại mẫu.
- [ ] In: mẫu HTML theo thông tư (tiêu đề mẫu số, chữ ký), PDF, Excel nhiều sheet, in liên tục cả bộ sổ năm.
- [ ] Soát lỗi: `data_check_rule` với các quy tắc đầu tiên (chứng từ không cân, dòng công nợ thiếu đối tượng, tài khoản tổng hợp trên dòng, số dư sai loại, chứng từ chưa ghi sổ trong kỳ khóa).
- [ ] Xuất toàn bộ dữ liệu kế toán theo kỳ (CSV + PDF sổ) cho cơ quan thẩm quyền.
- [ ] Kiểm thử bất biến 1–4 và 6 (mục 14 đặc tả); bộ dữ liệu mẫu doanh nghiệp dịch vụ một năm với BCTC kỳ vọng.

**Tiêu chí nghiệm thu**

- Nhập 100.000 dòng chứng từ, bảng cân đối phát sinh năm dưới 2 giây; ghi lùi ngày một chứng từ làm số dư đúng lại trong một lần tính.
- BCTC của bộ dữ liệu mẫu khớp 100% chỉ tiêu tính tay.
- Không có đường nào sửa/xóa dòng đã ghi sổ ngoài `unpost`.

**Phụ thuộc:** giai đoạn 0.

---

## Giai đoạn 2: Tiền, công nợ, thuế GTGT (5–6 tuần)

**Mục tiêu:** đủ nghiệp vụ hằng ngày của doanh nghiệp dịch vụ/thương mại chưa có kho: thu chi, ngân hàng, công nợ, hóa đơn, thuế GTGT.

**Công việc**

- [ ] Phiếu thu, Phiếu chi (VND, ngoại tệ; mẫu 01-TT, 02-TT), Giấy báo nợ, Giấy báo có, Ủy nhiệm chi (mẫu in theo ngân hàng), chuyển tiền nội bộ, tạm ứng/quyết toán tạm ứng; nhiều bút toán, nhiều đối tượng, thu/chi từ hóa đơn, nộp thuế/BHXH.
- [ ] Sổ quỹ tiền mặt, sổ tiền gửi (theo tài khoản ngân hàng), kiểm kê quỹ, số dư tại ngày, tỷ giá xuất quỹ theo phương pháp cấu hình.
- [ ] Công nợ: `open_item`, `settlement`; đối trừ tự động/thủ công khi thu/chi, bù trừ công nợ, hủy đối trừ; chênh lệch tỷ giá thực hiện (515/635); đánh giá lại số dư ngoại tệ cuối kỳ (413 hoặc theo chế độ); sổ chi tiết công nợ, tổng hợp công nợ, tuổi nợ/đến hạn, biên bản đối chiếu, nhắc nợ.
- [ ] Hóa đơn mua dịch vụ, hóa đơn bán dịch vụ (chưa có kho): dòng dịch vụ với thuế, hóa đơn GTGT kê khai (`voucher_invoice`: ký hiệu, số, ngày, MST, nhóm kê khai), chiết khấu, hạn thanh toán, giảm giá/trả lại dịch vụ, doanh thu nhận trước phân bổ.
- [ ] Động cơ thuế: `tax`, `tax_distribution`; GTGT khấu trừ 0/5/8/10, không chịu thuế, trực tiếp; làm tròn theo dòng và dòng làm tròn; TNCN khấu trừ tại nguồn (phân bổ âm) cho chi trả cá nhân.
- [ ] Thuế GTGT: bảng kê mua vào/bán ra theo nhóm kê khai, tờ khai 01/GTGT (điều chỉnh, còn khấu trừ chuyển kỳ, hoàn), khấu trừ thuế cuối kỳ (bút toán 1331/33311), kiểm tra trùng hóa đơn đầu vào, đối chiếu bút toán thuế với hóa đơn; xuất XML định dạng HTKK (mẫu kết xuất từ HTKK 5.x, kiểm thử đối chiếu); mẫu TT 80/2021 cho kỳ trước 01/07/2026 và TT 89/2026 sau đó.
- [ ] Nhập chứng từ từ Excel (bảng kê mua/bán, phiếu thu/chi), khử trùng chứng từ (cấu hình cặp loại chứng từ trùng).
- [ ] Mở rộng soát lỗi: công nợ không khớp sổ cái, hóa đơn thiếu MST, thuế lệch.
- [ ] Bất biến 5 (phần công nợ); dữ liệu mẫu thêm ngoại tệ và công nợ.

**Tiêu chí nghiệm thu**

- Tổng dư của `open_item` bằng số dư 131/331 theo từng đối tượng tại mọi ngày trong dữ liệu mẫu.
- Tờ khai 01/GTGT XML được HTKK/iTaxViewer mở và đọc đúng mọi chỉ tiêu.

**Phụ thuộc:** giai đoạn 1.

---

## Giai đoạn 3: Kho và mua bán hàng hóa (6–8 tuần)

**Mục tiêu:** doanh nghiệp thương mại có kho dùng được: mua, bán, nhập xuất, giá vốn, báo cáo kho.

**Công việc**

- [ ] VTHH đầy đủ: đa ĐVT có hệ số, tính chất, thuế mặc định, lô/hạn dùng/ngày sản xuất, tồn min/max, mã quy cách, vị trí; kho với TK kho và phương pháp giá vốn riêng; bảng giá bán/mua theo khách/thời gian/ĐVT; chính sách giá đơn giản.
- [ ] Số dư tồn kho đầu kỳ theo kho/lô; nhập Excel.
- [ ] `stock_move`, `stock_cost_layer`, `stock_cost_assignment`, `costing_run`; advisory lock theo (mặt hàng, kho).
- [ ] Chứng từ kho: phiếu nhập (mua, thành phẩm, trả lại, chuyển đến, gia công về, ký gửi, khác), phiếu xuất (bán, sản xuất/sử dụng, điều chuyển tự sinh nhập, trả NCC, biếu tặng, hủy, gia công, khác), chuyển kho, lắp ráp/tháo dỡ, kiểm kê và điều chỉnh; mẫu 01-VT, 02-VT; cảnh báo tồn âm/xuất quá tồn (cấu hình cho phép), sắp xếp thứ tự chứng từ trong ngày.
- [ ] Mua hàng hóa: đơn mua, hợp đồng mua, chứng từ mua hàng qua kho/không qua kho, nhập khẩu (thuế NK/TTĐB/GTGT hàng nhập, chi phí mua hàng phân bổ theo giá trị/số lượng), hàng về trước hóa đơn về sau và ngược lại, trả lại/giảm giá hàng mua, chiết khấu thương mại.
- [ ] Bán hàng hóa: báo giá, đơn đặt hàng, hợp đồng bán, chứng từ bán hàng kiêm phiếu xuất/hóa đơn/bút toán (nhiều hóa đơn từ một chứng từ, bảng kê kèm hóa đơn), xuất khẩu, chiết khấu/khuyến mãi/giảm giá/trả lại hàng bán, bán qua đại lý/gửi bán, thu tiền ngay, cảnh báo giá bán thấp hơn giá mua.
- [ ] Tính giá vốn: bình quân cuối kỳ (mặc định TT99), bình quân tức thời, FIFO, đích danh; chạy/chạy lại theo kỳ và phạm vi; chứng từ điều chỉnh chênh lệch 632/155/156; cố định giá vốn; cập nhật giá nhập kho thành phẩm thủ công; nhật ký costing run.
- [ ] Báo cáo kho: nhập xuất tồn (tổng hợp/chi tiết/theo kho/theo lô), thẻ kho S12-DN, sổ chi tiết vật tư S10-DN, bảng kê nhập/xuất, hàng tồn theo hạn dùng, kiểm kê, đối chiếu kế toán – thủ kho; báo cáo bán hàng (doanh số, lãi gộp theo khách/mặt hàng/nhân viên/nhóm), báo cáo mua hàng.
- [ ] Soát lỗi: chênh lệch kho với sổ cái, chứng từ xuất chưa có giá vốn, sai ĐVT.
- [ ] Bất biến 5 (phần kho); dữ liệu mẫu thêm kho và 4 phương pháp giá vốn với kết quả tính tay.

**Tiêu chí nghiệm thu**

- Tính lại giá vốn một năm 50.000 dòng kho dưới 30 giây, sổ cái không có dòng bị sửa, chỉ có chứng từ điều chỉnh.
- Tổng `remaining_value` bằng số dư 152/155/156 sau mọi costing run.

**Phụ thuộc:** giai đoạn 2.

---

## Giai đoạn 4: Tài sản và khế ước (4 tuần)

**Công việc**

- [ ] TSCĐ: thẻ (nguyên giá, nguồn vốn, bộ phận, thời gian, phương pháp đường thẳng; số dư giảm dần và sản lượng để sau), ghi tăng (mua, XDCB, góp vốn, từ kho, thuê tài chính), ghi giảm (thanh lý, góp vốn, chuyển CCDC), đánh giá lại, điều chuyển, dừng khấu hao, kiểm kê; lịch khấu hao, chứng từ khấu hao hằng kỳ, lịch mới khi thay đổi; số dư đầu kỳ; sổ TSCĐ, thẻ TSCĐ, bảng tính và phân bổ khấu hao, tăng giảm, kiểm kê.
- [ ] CCDC và chi phí trả trước: ghi tăng (mua dùng ngay, từ kho, từ TSCĐ), giảm, điều chuyển, điều chỉnh, kiểm kê, phân bổ nhiều kỳ theo bộ phận/vụ việc/khoản mục, chứng từ phân bổ hằng kỳ, sổ theo dõi.
- [ ] Khế ước vay: hợp đồng tín dụng, giải ngân, lịch trả gốc/lãi, lãi vay tự động, tất toán, báo cáo.
- [ ] Số dư đầu kỳ TSCĐ/CCDC/chi phí trả trước; nhập Excel.
- [ ] Quy trình cuối kỳ có thứ tự gợi ý (phân bổ CCDC → chi phí trả trước → khấu hao → giá vốn → tỷ giá xuất quỹ → kết chuyển) với trạng thái "đã chạy đến bước nào".

**Tiêu chí nghiệm thu:** giá trị còn lại tổng bằng 211 − 214 tại mọi ngày; chạy lại khấu hao một kỳ không tạo trùng.

---

## Giai đoạn 5: Hóa đơn điện tử và tích hợp (5–6 tuần)

**Công việc**

- [ ] Giao diện `EInvoiceProvider`; adapter Viettel SInvoice (tạo, tra cứu, điều chỉnh/thay thế, hủy giao dịch, cập nhật thanh toán, lấy PDF/XML); cấu hình ký hiệu mẫu số/ký hiệu hóa đơn theo TT 91/2026 từ 01/07/2026; vòng đời: lập → ký → gửi CQT → có mã → điều chỉnh/thay thế → thông báo sai sót 04/SS-HĐĐT; hóa đơn máy tính tiền; nhật ký gửi/nhận.
- [ ] Ký số: tiện ích ký cục bộ cho USB token (localhost, PKCS#7/XML-DSig) và ký từ xa (VNPT SmartCA trước); dùng cho hóa đơn, tờ khai, BCTC, chứng từ điện tử.
- [ ] Hóa đơn đầu vào: nhận XML (email/tải lên/API), parse theo QĐ 1450/QĐ-TCT (`TDiep/DLieu/HDon/NDHDon`), kiểm tra chữ ký, lập chứng từ mua hàng/dịch vụ từ hóa đơn, kiểm tra tình trạng MST người bán.
- [ ] Ngân hàng: webhook SePay/Casso (xác thực HMAC/API key) vào hộp thư giao dịch, gợi ý đối chiếu với phiếu/hóa đơn, nhập sao kê Excel/CSV theo mẫu ngân hàng, VietQR trên hóa đơn/phiếu, chi lương theo lô (file mẫu ngân hàng).
- [ ] Thuế bổ sung: tờ khai TNDN tạm nộp quý và quyết toán 03/TNDN với phụ lục kết quả kinh doanh, điều chỉnh tăng/giảm; 05/KK-TNCN quý và quyết toán; nộp qua XML eTax; tham số 15/17/20% theo doanh thu năm trước.
- [ ] API REST có khóa cho phần mềm bán hàng/POS (đẩy đơn/hóa đơn, lấy tồn).

**Tiêu chí nghiệm thu:** phát hành và nhận lại hóa đơn có mã trên môi trường thử SInvoice; XML đầu vào mẫu của 3 nhà cung cấp parse đúng; webhook SePay thử tạo được giao dịch chờ đối chiếu.

**Phụ thuộc:** tài khoản thử nghiệm SInvoice, SePay/Casso, chứng thư số thử.

---

## Giai đoạn 6: Lương, giá thành, hợp đồng (5–6 tuần)

**Công việc**

- [ ] Tiền lương: hồ sơ nhân viên (lương, phụ cấp, người phụ thuộc, BHXH), chấm công theo ngày/buổi/giờ, cấu trúc bảng lương cấu hình (cột, công thức), BHXH/BHYT/BHTN theo tỷ lệ/trần/sàn theo ngày hiệu lực, TNCN lũy tiến 5 bậc và giảm trừ (kỳ 2026), làm thêm giờ 150/200/300%, hạch toán chi phí lương theo bộ phận/vụ việc, chứng từ chi lương và nộp bảo hiểm, chứng từ khấu trừ TNCN, nhập bảng lương từ Excel, báo cáo lương, file I-VAN.
- [ ] Giá thành: đối tượng tập hợp chi phí (sản phẩm, vụ việc/công trình, đơn hàng, hợp đồng), định mức NVL, tập hợp 621/622/627 theo đối tượng, đánh giá dở dang (NVL trực tiếp, sản lượng hoàn thành tương đương), phân bổ chi phí chung theo tiêu thức, phương pháp giản đơn, hệ số/tỷ lệ, vụ việc/công trình, đơn hàng; chứng từ nhập kho thành phẩm theo giá thành; sổ chi tiết 154, thẻ tính giá thành, báo cáo so sánh định mức.
- [ ] Hợp đồng và vụ việc: theo dõi thu/chi/doanh số/thực hiện theo hợp đồng, đợt thanh toán, sinh hóa đơn từ hợp đồng, lãi lỗ theo vụ việc/hợp đồng, chuyển số dư vụ việc sang năm sau.
- [ ] Phân bổ chi phí bán hàng/QLDN theo vụ việc để xác định lãi lỗ từng công trình/đơn hàng.

**Tiêu chí nghiệm thu:** bảng lương mẫu 20 nhân viên khớp tính tay (BHXH, TNCN); giá thành giản đơn và hệ số khớp ví dụ chuẩn.

---

## Giai đoạn 7: Mở rộng (liên tục, theo nhu cầu)

- [ ] Hộ kinh doanh theo TT 152/2025: sổ S1a/S2a/S2b–S2e/S3a-HKD, tờ khai 01/CNKD, hóa đơn máy tính tiền, ngưỡng 1 tỷ.
- [ ] Doanh nghiệp siêu nhỏ TT 58/2026 (sổ S1–S4-DNSN, BCTC B01/B02-DNSN).
- [ ] Hình thức sổ Chứng từ ghi sổ, Nhật ký – Sổ cái, Nhật ký – Chứng từ (lớp trình bày).
- [ ] Đa chi nhánh có phân quyền, BCTC tổng hợp; hợp nhất TT 202/2014 (loại trừ nội bộ).
- [ ] Ngân sách/dự toán và cảnh báo; phân tích tài chính/dashboard; báo cáo song ngữ.
- [ ] Mobile (xem báo cáo, duyệt chứng từ), quy trình phê duyệt (đề nghị thanh toán/tạm ứng).
- [ ] Trợ lý AI: nhận diện hóa đơn, gợi ý định khoản, tự động bút toán định kỳ.
- [ ] Khấu hao số dư giảm dần/sản lượng, giá thành phân bước nhiều công đoạn, kế toán ngành (xây lắp, vận tải, nhà hàng).

---

## Việc cần làm trước giai đoạn 0 (chuẩn bị)

1. Duyệt đặc tả: giả định G1–G7, ngăn xếp (mục 5.2), ba hướng tiếp cận (mục 4).
2. Thu thập văn bản gốc: TT 99/2025 (toàn văn + Phụ lục I–IV), TT 133/2016, TT 89/2026 Phụ lục I, TT 91/2026, QĐ 1450/QĐ-TCT và QĐ 1510/QĐ-TCT (toàn bộ phụ lục XML), NĐ 254/2026.
3. Cài HTKK bản mới nhất trên máy Windows, kết xuất XML mẫu cho 01/GTGT, 03/TNDN, 05/KK-TNCN, BCTC để làm bộ kiểm thử.
4. Đăng ký môi trường thử: Viettel SInvoice, SePay hoặc Casso, chứng thư số thử.
5. Khởi tạo git cho thư mục dự án và commit đặc tả, lộ trình, báo cáo nghiên cứu.

## Ước lượng tổng

Giai đoạn 0–6 khoảng 32–41 tuần cho một người làm toàn thời gian với trợ lý AI; bản dùng được cho doanh nghiệp dịch vụ sau giai đoạn 1–2 (khoảng 12–15 tuần), cho doanh nghiệp thương mại sau giai đoạn 3 (khoảng 20–23 tuần). Hai người làm song song (một lõi sổ cái/kho, một giao diện/báo cáo) rút được khoảng 30%.
