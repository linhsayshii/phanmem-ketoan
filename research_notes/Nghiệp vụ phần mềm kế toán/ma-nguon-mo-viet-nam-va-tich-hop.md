# Mã nguồn mở kế toán Việt Nam và các bề mặt tích hợp (e-invoice, thuế, ngân hàng, BHXH, chữ ký số)

Phạm vi: Việt Nam, tình trạng đến tháng 10/2026. Ghi chú này tách theo 8 câu hỏi; mỗi câu có Takeaway / Cited Findings / Inferences / Gaps. Tên API, thẻ XML, URL repo, giấy phép và số hiệu văn bản giữ nguyên gốc.

Lưu ý chung về bối cảnh pháp lý (ảnh hưởng toàn bộ phần e-invoice): từ 01/7/2026, hóa đơn điện tử chịu sự điều chỉnh của Luật Quản lý thuế số 108/2025/QH15, Nghị định 254/2026/NĐ-CP (30/6/2026) và Thông tư 91/2026/TT-BTC (30/6/2026); Thông tư 32/2025/TT-BTC và Nghị định 70/2025/NĐ-CP hết hiệu lực từ ngày Thông tư 91 có hiệu lực — [MISA eShop](https://www.misaeshop.vn/44493/thong-tu-91-2026-tt-btc-huong-dan-nghi-dinh-254-2026-nd-cp/); [KPMG](https://kpmg.com/vn/en/insights/2026/07/decree-254-and-circular-91-on-electronic-invoices.html); [EY](https://www.ey.com/content/dam/ey-unified-site/ey-com/vi-vn/technical/tax/documents/ey-vn-decree-254-on-electronic-invoices-and-electronic-documents.pdf). Tôi KHÔNG tìm thấy quyết định nào của Cục Thuế thay thế Quyết định 1450/QĐ-TCT về định dạng XML sau 01/7/2026 (xem Gaps câu 2).

---

## Câu 1. Odoo `l10n_vn` và localization của Viindoo cung cấp chính xác những gì (tài khoản, thuế, báo cáo, e-invoice)? Phần nào mã nguồn mở, giấy phép gì?

### Takeaway
Odoo chính thức (LGPL-3) chỉ có 2 module mở cho Việt Nam: `l10n_vn` (hệ thống tài khoản TT200 dạng rút gọn 218 tài khoản, 15 thuế GTGT/nhập khẩu, VietQR, danh mục ngân hàng) và `l10n_vn_edi_viettel` (phát hành HĐĐT qua Viettel SInvoice). Toàn bộ phần "làm cho ra kế toán Việt Nam" của Viindoo (hệ thống tài khoản đầy đủ TT200/TT133, báo cáo B01/B02/B03-DN, sổ S03a/S03b, tờ khai 01/GTGT, kết nối MISA/SInvoice/VNInvoice, đọc số thành chữ) đều là OPL-1 (proprietary, trả phí), không tái sử dụng mã được.

### Cited Findings
**Odoo core `addons/l10n_vn` (nhánh 18.0)**
- Manifest: tên "Vietnam - Accounting", version 2.0.3, author General Solutions, license **LGPL-3**, depends `account_qr_code_emv`, `base_iban`, `account`; mô tả: hệ thống tài khoản theo chuẩn VAS dựa trên Thông tư 200/2014/TT-BTC, kèm dữ liệu ngân hàng Việt Nam (NHNN cập nhật hàng năm) và tính năng VietQR trên hóa đơn; credits General Solutions, Trobz, Jean Nguyen (VietQR). Data: `data/account_tax_report_data.xml`, `views/account_move_views.xml`, `views/res_bank_views.xml` — [__manifest__.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/l10n_vn/__manifest__.py)
- Cấu trúc thư mục: `data/`, `demo/`, `i18n/`, `migrations/`, `models/`, `tests/`, `views/`; `data/` chứa `template/` và `account_tax_report_data.xml` — [GitHub l10n_vn](https://github.com/odoo/odoo/tree/18.0/addons/l10n_vn); [data/](https://github.com/odoo/odoo/tree/18.0/addons/l10n_vn/data)
- `data/template/account.account-vn.csv`: **218 tài khoản**, cột `id,name,code,account_type,reconcile,name@vi_VN`; tên tiếng Anh, bản dịch tiếng Việt ở `name@vi_VN`; ví dụ 111 Cash, 112 Demand Deposit, 1121 Bank Suspense Account, 1311, 3311, 511, 632, 911, 6411, 41111; **không có** mã 1111, 131, 331 dạng chính xác (chỉ có tiểu khoản) — [account.account-vn.csv](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/l10n_vn/data/template/account.account-vn.csv)
- `data/template/account.tax-vn.csv`: **15 thuế**: `tax_purchase_vat10/8/5/0`, `tax_purchase_vat_exemption`, `tax_purchase_import_10/8/5/0`, `tax_import` (Import Tax 5%), `tax_sale_vat10/8/5/0`, `tax_sale_vat_exemption`; nhóm `tax_group_10/8/5/0/exemption/import`; các dòng 0% và miễn thuế không gắn tag ở dòng thuế — [account.tax-vn.csv](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/l10n_vn/data/template/account.tax-vn.csv)
- `addons/l10n_vn_edi_viettel` (18.0): tên "Vietnam - E-invoicing", summary "E-invoicing using SInvoice by Viettel", version 1.0, license **LGPL-3**, depends `l10n_vn`, countries `['vn']`; data: `security/ir.model.access.csv`, `views/account_move_views.xml`, `views/res_config_settings_views.xml`, `views/res_partner_views.xml`, `views/sinvoice_views.xml`, `wizard/account_move_reversal_view.xml`, `wizard/l10n_vn_edi_cancellation_request_views.xml` — [__manifest__.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/l10n_vn_edi_viettel/__manifest__.py). Chi tiết API xem câu 2.

**OCA**
- `OCA/l10n-vietnam` tồn tại, license AGPL-3.0, nhánh `19.0` có 1 commit, 7 stars, 20 forks, 5 issue mở; README chưa sinh bảng module ("will be replaced when running the oca-gen-addons-table script") — [OCA/l10n-vietnam](https://github.com/OCA/l10n-vietnam)

**Viindoo (tvtma) — tất cả OPL-1**
- `l10n_vn_viin` (16.0): mở rộng `l10n_vn` chuẩn, phủ cả Thông tư 200/2014/TT-BTC (DN lớn) và Thông tư 133/2016/TT-BTC (SME) — [viindoo.com l10n_vn_viin](https://viindoo.com/apps/app/16.0/l10n_vn_viin); bản 15.0 có mẫu phiếu in PDF — [about.viindoo.com](https://about.viindoo.com/vi/apps/app/15.0/l10n_vn_viin)
- Tiền thân `l10n_vn_c200` (Odoo 10–14): "fixed l10n_vn module to get fully compliant with the Circular #200/2014/TT-BTC", "partially compliant with Circular 133", thêm trường `code` cho `account.account.tag` để 1111/1112 cuộn lên tag 111 — [apps.odoo.com l10n_vn_c200 13.0](https://apps.odoo.com/apps/modules/13.0/l10n_vn_c200); [14.0](https://apps.odoo.com/apps/modules/14.0/l10n_vn_c200)
- `l10n_vn_viin_account_reports` (16.0): license **OPL-1**, giá niêm yết 61,209,365 ₫; báo cáo: Balance Sheet (B01-DN), Profit & Loss (B02-DN), Cash Flow (B03-DN), tờ khai GTGT 01-1/GTGT và 01-2/GTGT, sổ S38, S03a, S03b, S07, S08 xuất PDF/XLSX, VAT Declaration, Account Detail Sheet, General Journal, Cash Book, Bank Deposit Book; theo TT 200/2014, TT 133/2016, TT 119/2014/TT-BTC; phụ thuộc `to_account_reports`, `to_vietnamese_number2words`, `to_base`, `l10n_vn_viin`, `viin_account`, `to_legal_invoice_number`; "Odoo 16 Community Edition"; phải gỡ Accounting Reports mặc định của Odoo — [viindoo.com](https://viindoo.com/apps/app/16.0/l10n_vn_viin_account_reports)
- `l10n_vn_viin_edi` (16.0.1.1.2): license **OPL-1** ("Odoo Proprietary License", cấm phân phối/sublicense), giá 5,000,347 ₫; nhà cung cấp cấu hình sẵn: MISA (meInvoice), Viettel Sinvoice, VNInvoice; phát hành/hủy/điều chỉnh HĐĐT, theo dõi trạng thái; phụ thuộc `to_vietnamese_number2words`, `viin_partner_budget_code`, `viin_partner_identity`, `to_base`, `l10n_vn_viin`, `viin_account`, `to_legal_invoice_number`; extension `l10n_vn_viin_edi_pos`, `_patch1..4`, `l10n_vn_viin_einvoice_sale`, `l10n_vn_edi_summary` — [viindoo.com l10n_vn_viin_edi](https://viindoo.com/apps/app/16.0/l10n_vn_viin_edi)
- `l10n_vn_viin_edi_patch3`: hóa đơn thay thế theo Nghị định 70/2025/NĐ-CP (hiệu lực 01/6/2025), OPL-1 — [apps.odoo.com](https://apps.odoo.com/apps/modules/16.0/l10n_vn_viin_edi_patch3)
- `to_vietnamese_number2words` (đọc số thành chữ): OPL-1 — [developer.viindoo.com](https://developer.viindoo.com/apps/app/15.0/to_vietnamese_number2words)
- Tổ chức GitHub `Viindoo` có 25 repo public, nổi bật `odoo` (fork, 10 stars), `OpenUpgrade` (fork tvtma, AGPL-3.0); **không có repo nào tên/mô tả chứa l10n_vn** — [github.com/Viindoo](https://github.com/Viindoo)

**Module bên thứ ba khác trên Odoo Apps**
- `dff_coa_data_vn` (18.0, devluoicode): gói dữ liệu TT200/TT133/TT99, "467 mẫu tài khoản và 70 quy tắc chuyển đổi", chỉ dữ liệu không có code — [apps.odoo.com](https://apps.odoo.com/apps/modules/18.0/dff_coa_data_vn)
- `biz_einvoice_vnpt` (16.0): kết nối VNPT Invoice, luồng cấu hình → phát hành từ Odoo invoice → tải file → ký qua SmartCA — [apps.odoo.com](https://apps.odoo.com/apps/modules/16.0/biz_einvoice_vnpt); `james_vnpt_invoice_integration` (18.0) — [apps.odoo.com](https://apps.odoo.com/apps/modules/18.0/james_vnpt_invoice_integration); `viettel_s_invoice` (12/13/17) dùng demo `https://demo-sinvoice.viettel.vn:8443`, production `https://api-sinvoice.viettel.vn:443` — [apps.odoo.com](https://apps.odoo.com/apps/modules/17.0/viettel_s_invoice)

### Inferences
- `l10n_vn` của Odoo là nền (LGPL-3) có thể lấy làm khung dữ liệu: danh sách 218 tài khoản + 15 thuế là CSV dễ trích; nhưng thiếu tiểu khoản bắt buộc (1111, 1112, 131, 331 dạng đầy đủ theo Phụ lục TT200) và không có báo cáo tài chính/sổ sách VN — chính khoảng trống này Viindoo bán OPL-1.
- `l10n_vn_edi_viettel` là tài liệu "sống" tốt nhất về API SInvoice v2 (mã Python LGPL-3, xem câu 2), tái sử dụng được logic payload, trạng thái và điều chỉnh/thay thế.
- Không nên dựa OCA/l10n-vietnam: chưa có module.

### Gaps
- Không mở được nội dung `account_tax_report_data.xml` (cấu trúc tờ khai GTGT trong Odoo) và `account.chart.template-vn.csv`; chưa xác nhận Odoo có `account.group` cho VN.
- Không truy cập được mã nguồn Viindoo để đối chiếu mức độ tuân thủ TT200 (OPL-1, không công khai repo).
- Chưa xác minh được giấy phép riêng của `l10n_vn_viin` (trang liệt kê chỉ ở vai trò dependency).

---

## Câu 2. API nhà cung cấp HĐĐT nào được công bố công khai, và cấu trúc XML (TDiep, HDon, DLHDon…) theo Quyết định 1450/QĐ-TCT ra sao?

### Takeaway
Chỉ Viettel SInvoice có "tài liệu" công khai dưới dạng mã nguồn Odoo (LGPL-3) với đầy đủ URL, endpoint, cách xác thực và JSON; MISA chỉ công bố mô hình kết nối và môi trường test/prod, phần endpoint nằm sau đăng ký; VNPT, BKAV, EasyInvoice, FPT, M-Invoice, CyberBill, Thái Sơn không có tài liệu API công khai tìm được. Về XML, Quyết định 1450/QĐ-TCT (07/10/2021, thay QĐ 635/QĐ-TCT 11/5/2020, sửa bởi QĐ 1510/QĐ-TCT 21/9/2022) định nghĩa thông điệp `TDiep` = `TTChung` + `DLieu`, phiên bản `PBan` = "2.0.0", XML Signature chuẩn W3C, UTF-8, giới hạn 2MB; danh sách mã `MLTDiep` và lược đồ chi tiết `DLHDon` nằm ở Phụ lục mà không nguồn web nào trả về được toàn văn.

### Cited Findings
**Quyết định 1450/QĐ-TCT và hệ văn bản**
- QĐ 1450/QĐ-TCT ký 07/10/2021 (Phó Tổng cục trưởng Đặng Ngọc Minh), hiệu lực từ ngày ký, thay thế QĐ 635/QĐ-TCT ngày 11/5/2020, được sửa đổi bởi QĐ 1510/QĐ-TCT; phạm vi: tiêu chuẩn kỹ thuật, cấu trúc dữ liệu, thành phần dữ liệu, phương thức truyền nhận HĐĐT giữa DN, tổ chức cung cấp dịch vụ và cơ quan thuế theo Nghị định 123/2020/NĐ-CP — [LuatVietnam QĐ 1450](https://luatvietnam.vn/thue/quyet-dinh-1450-qd-tct-bo-tai-chinh-210675-d1.html)
- Cấu trúc văn bản: Phần I (quy tắc đặt tên thẻ, UTF-8, định dạng số/ngày/ngày-giờ, chữ ký số, định dạng thông điệp, thông điệp phản hồi kỹ thuật, QR code); Phần II (tờ khai đăng ký/thay đổi `TKhai`, thông báo, đề nghị cấp mã, cấu trúc hóa đơn `HDon`, `DLHDon`, `TTChung`, `NDHDon`, `NBan`, `NMua`, `DSHHDVu`, `TToan`) — [LuatVietnam](https://luatvietnam.vn/thue/quyet-dinh-1450-qd-tct-bo-tai-chinh-210675-d1.html)
- Thông điệp `TDiep` gồm `TTChung` và `DLieu` (chứa hóa đơn / thông báo hủy / đề nghị / bảng tổng hợp). Bảng `TDiep\TTChung`: `PBan` (phiên bản, "2.0.0", 6 ký tự), `MNGui` (mã nơi gửi, 14), `MNNhan` (14), `MLTDiep` (mã loại thông điệp, 3 chữ số), `MTDiep` (mã thông điệp, 46), `MTDTChieu` (mã thông điệp tham chiếu, 46), `MST` (14), `SLuong` (số lượng, 7). Mã nơi gửi: TCT, TCTN (tổ chức truyền nhận) hoặc TCKNGTT (DN kết nối trực tiếp), bắt đầu bằng "V" hoặc "K" + MST; mỗi thông điệp ≤ 2MB, một loại dữ liệu cho một NNT — [HoaTieu QĐ 1450](https://hoatieu.vn/phap-luat/quyet-dinh-1450-qd-tct-2021-211892)
- Định dạng: số tối đa 21 chữ số, phần thập phân ≤ 6; ngày `YYYY-MM-DD`; ngày giờ `YYYY-MM-DDThh:mm:ss` múi giờ GMT+7; chữ ký là "chữ ký điện tử an toàn" theo chuẩn XML Signature Syntax and Processing; thời điểm ký tại `Signature\Object\SignatureProperties\SignatureProperty\SigningTime`; chứng thư tại `X509SubjectName` và `X509Certificate`; Phụ lục II quy định ký hiệu mẫu số/ký hiệu hóa đơn, Phụ lục VI danh mục loại hóa đơn — [LuatVietnam](https://luatvietnam.vn/thue/quyet-dinh-1450-qd-tct-bo-tai-chinh-210675-d1.html); [HoaTieu](https://hoatieu.vn/phap-luat/quyet-dinh-1450-qd-tct-2021-211892)
- Quy tắc đặt tên thẻ (theo tóm tắt nguồn thứ cấp trong kết quả tìm kiếm, chưa đối chiếu toàn văn): không dấu, viết tắt lấy chữ cái đầu viết hoa của từng từ, giữ nguyên từ cuối với chữ cái đầu viết hoa; ví dụ `DLHDon` = dữ liệu hóa đơn — [Thư viện Pháp luật QĐ 1450](https://thuvienphapluat.vn/van-ban/thue-phi-le-phi/quyet-dinh-1450-qd-tct-2021-thanh-phan-chua-du-lieu-nghiep-vu-hoa-don-dien-tu-490526.aspx) (trang trả 403 khi fetch trực tiếp)
- Nghị định 123/2020/NĐ-CP Điều 12: HĐĐT dùng XML, định dạng theo chuẩn Tổng cục Thuế; MISA mô tả định dạng gồm hai thành phần (dữ liệu nghiệp vụ, chữ ký số) và thành phần thứ ba chứa dữ liệu mã CQT với hóa đơn có mã — [meinvoice.vn](https://www.meinvoice.vn/tin-tuc/9169/hoa-don-dien-tu-file-xml/); file XML là file có giá trị pháp lý, PDF chỉ là bản thể hiện — [Sapo](https://www.sapo.vn/blog/file-xml-hoa-don-dien-tu)
- Ký hiệu hóa đơn 6 ký tự: ký tự đầu C (có mã) / K (không mã), 2 số năm, 1 chữ loại (T, D, L, M, N, B, G, H), 2 ký tự DN tự định; số hóa đơn tối đa 8 chữ số, reset theo năm (tối đa 99,999,999); ký hiệu mẫu số 1 chữ số (1–6) — [ihoadon.vn](https://ihoadon.vn/hddt/quy-dinh-ve-dinh-dang-hoa-don-dien-tu.html). Theo Phụ lục I Thông tư 91/2026/TT-BTC ký hiệu mẫu số mở rộng 1–9 (1 = GTGT, 2 = bán hàng) — [meinvoice.vn](https://www.meinvoice.vn/?p=12961)
- QĐ 1510/QĐ-TCT: Công văn 2107/TCT-CS (2023) dẫn "Quyết định 1510/QĐ-TCT ngày 21/9/2022 ... sửa đổi, bổ sung Quyết định số 1450/QĐ-TCT ngày 07/10/2021", cùng điểm c khoản 1 Điều 7 Thông tư 78/2021/TT-BTC về xử lý bảng tổng hợp dữ liệu HĐĐT sai sót — [CV 2107/TCT-CS](https://thuvienphapluat.vn/cong-van/Thue-Phi-Le-Phi/Cong-van-2107-TCT-CS-2023-hoa-don-gia-tri-gia-tang-588007.aspx); một trang tổng hợp ghi 1510 ban hành "07/10/2021" — mâu thuẫn, nhiều khả năng là lỗi của trang đó — [thuviennhadat.vn](https://thuviennhadat.vn/phap-luat/tong-hop-van-ban-ve-hoa-don-dien-tu-moi-nhat-2025-683095.html)
- Hóa đơn máy tính tiền: QĐ 1391/QĐ-TCT ngày 23/08/2022 ban hành quy trình quản lý HĐĐT có mã khởi tạo từ máy tính tiền (được nhắc trong kết quả tìm kiếm liên quan CV 1754/TCT-CS 2023) — [CV 1754/TCT-CS](https://thuvienphapluat.vn/cong-van/thue-phi-le-phi/cong-van-1754-tct-cs-2023-hoa-don-dien-tu-593557.aspx); Nghị định 70/2025/NĐ-CP khoản 1 Điều 11 bắt buộc bán lẻ, ăn uống, khách sạn… dùng HĐĐT từ máy tính tiền có kết nối chuyển dữ liệu; Thông tư 32/2025/TT-BTC (31/5/2025, hiệu lực 01/6/2025) không quy định thời điểm chuyển dữ liệu trong khi TT 78/2021 yêu cầu "trong ngày" — [helpact.misa.vn](https://helpact.misa.vn/kb/thoi-diem-chuyen-du-lieu-hoa-don-khoi-tao-tu-may-tinh-tien-den-co-quan-thue/)
- Thông tư 91/2026/TT-BTC: ban hành 30/06/2026, hiệu lực 01/07/2026, 05 chương 25 điều 05 phụ lục (Phụ lục I–IV biểu mẫu/định dạng bắt buộc, Phụ lục V mẫu tham khảo); Điều 25 bãi bỏ Thông tư 32/2025; Điều 10 sai sót: thông báo sai sót / hóa đơn điều chỉnh / hóa đơn thay thế — [MISA eShop](https://www.misaeshop.vn/44493/thong-tu-91-2026-tt-btc-huong-dan-nghi-dinh-254-2026-nd-cp/); Công văn 4831/CT-CS ngày 15/7/2026 của Cục Thuế giới thiệu điểm mới NĐ 254 và TT 91 — [Thư viện Pháp luật](https://thuvienphapluat.vn/hoi-dap-phap-luat/cong-van-4831ctcs-cuc-thue-gioi-thieu-diem-moi-cua-nghi-dinh-2542026-va-thong-tu-912026-hoa-don-die-138097913.html)

**Viettel SInvoice (từ mã `l10n_vn_edi_viettel`, LGPL-3)**
- Base: `SINVOICE_API_URL = https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/`; login `https://api-vinvoice.viettel.vn/auth/login`; `SINVOICE_TIMEOUT = 60`s. Auth: POST JSON `{'username','password'}` → `access_token`, `expires_in` (comment: token 5 phút), cache theo company, gửi lại dưới dạng cookie `access_token` (không dùng Bearer). Endpoint (POST): `InvoiceAPI/InvoiceWS/createInvoice/{company.vat}`, `InvoiceAPI/InvoiceUtilsWS/getInvoiceRepresentationFile` (ZIP/PDF theo `fileType`), `InvoiceAPI/InvoiceWS/searchInvoiceByTransactionUuid`, `InvoiceAPI/InvoiceWS/updatePaymentStatus`, `InvoiceAPI/InvoiceWS/cancelPaymentStatus`, `InvoiceAPI/InvoiceWS/cancelTransactionInvoice` — [account_move.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/l10n_vn_edi_viettel/models/account_move.py)
- JSON `createInvoice`: `generalInvoiceInfo` {`transactionUuid`, `invoiceType`, `templateCode`, `invoiceSeries`, `invoiceIssuedDate`, `currencyCode`, `adjustmentType`, `paymentStatus`, `cusGetInvoiceRight`, `validation`, `exchangeRate` (ngoại tệ), `adjustmentInvoiceType`, `originalInvoiceId`, `originalInvoiceIssueDate`, `originalTemplateCode`, `additionalReferenceDesc`, `additionalReferenceDate`}; `buyerInfo` {`buyerName`, `buyerLegalName`, `buyerTaxCode`, `buyerAddressLine`, `buyerPhoneNumber`, `buyerEmail`, `buyerCityName`, `buyerCountryCode`, `buyerNotGetInvoice`, `buyerBankName`, `buyerBankAccount`}; `sellerInfo` {`sellerLegalName`, `sellerTaxCode`, `sellerAddressLine`, `sellerPhoneNumber`, `sellerEmail`, `sellerDistrictName`, `sellerCountryCode`, `sellerWebsite`, `sellerBankName`, `sellerBankAccount`, `merchantCode`, `merchantName`, `merchantCity`}; `payments` `[{'paymentMethodName': 'TM/CK'}]`; `itemInfo` {`itemCode`, `itemName`, `unitName`, `unitPrice`, `quantity`, `itemTotalAmountWithoutTax`, `taxPercentage`, `taxAmount`, `discount`, `itemTotalAmountAfterDiscount`, `itemTotalAmountWithTax`, `selection`, `isIncreaseItem`, `adjustmentTaxAmount`}; `taxBreakdowns` {`taxPercentage`, `taxableAmount`, `taxAmount`, `taxableAmountPos`, `taxAmountPos`}. `adjustmentType`: '1' gốc, '5' điều chỉnh (credit note), '3' thay thế; `adjustmentInvoiceType` '1' tiền / '2' thông tin; credit note gửi số âm. Trạng thái nội bộ: `ready_to_send`, `sent`, `payment_state_to_update`, `canceled`, `adjusted`, `replaced` — [account_move.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/l10n_vn_edi_viettel/models/account_move.py)
- Viindoo: SInvoice có 2 phiên bản API, URL do Viettel cấp theo DN; v1 `demo-sinvoice.viettel.vn:8443`, v2 `api-vinvoice.viettel.vn/services/einvoiceapplication/api/`; quy trình khai báo giống nhau chỉ đổi URL — [Viindoo docs](https://viindoo.com/documentation/15.0/applications/finance/accounting-and-invoicing/fiscal-localizations/issue-e-invoice-by-integrating-viindoo-with-viettel-s-s-invoice-service.html)
- npm `viettel-s-invoice` 1.0.10: wrapper không chính thức ("not affiliated with or endorsed by Viettel"), MIT, class `ViettelSInvoice(username, password, apiEndPoint)`, methods `previewDraftInvoice`, `createInvoice`, `getInvoiceByTransactionUuid`, `getInvoicesByDateRange`, `getInvoiceFile(invoiceNo, templateCode, fileType)`, `getInvoiceTemplates` — [unpkg README](https://unpkg.com/viettel-s-invoice@1.0.10/README.md)

**MISA meInvoice**
- Tài liệu `doc.meinvoice.vn` (DocFX) mô tả 2 mô hình: "Tích hợp sâu" (gọi API hoặc SDK từ ERP tới cloud MISA: phát hành có ký, gửi, tải, xem) và "Tích hợp nhanh" (đẩy dữ liệu thô vào webapp/desktop MISA để phát hành tại đó); môi trường test `https://testapp.meinvoice.vn`, production `https://app.meinvoice.vn`, nội bộ `https://app.meinvoice.misa.local`; phải đăng ký dịch vụ tại meinvoice.vn trước — [doc.meinvoice.vn/about](http://doc.meinvoice.vn/about/); [doc.meinvoice.vn](http://doc.meinvoice.vn/)
- Có MCP connector bên thứ ba (create_invoice / publish_invoice / query_invoice) cho meInvoice — [glama.ai](https://glama.ai/mcp/connectors/app.wishpool/vietnam-invoice-mcp)

**VNPT Invoice**
- Không có tài liệu công khai; "API information connected to the VNPT Invoice system such as url, username, password is provided to users when they register" — [Chrome extension Biên lai điện tử VNPT](https://chrome.google.com/webstore/detail/viettel-toolbox/detail/bi%C3%AAn-lai-%C4%91i%E1%BB%87n-t%E1%BB%AD-vnpt/gecofbbdlfhclfiagfafmmgnnoehenpf); module Odoo `biz_einvoice_vnpt` mô tả luồng ký qua SmartCA — [apps.odoo.com](https://apps.odoo.com/apps/modules/16.0/biz_einvoice_vnpt)

**FPT.eInvoice**
- Là nhà cung cấp HĐĐT đầu tiên tại VN được SAP đưa vào danh sách tích hợp SAP Document and Reporting Compliance; tự động ký số và gửi Tổng cục Thuế — [fpt-is.com](https://fpt-is.com/en/fpt-becomes-saps-first-partner-in-vietnam-to-integrate-e-invoicing-solutions/)

**Tra cứu/tải hóa đơn từ hoadondientu.gdt.gov.vn (reverse-engineered, không chính thức)**
- `dieutx/TaiHoaDonDienTu` (Excel VBA, 5 stars, v6.7.7, không có license — xem NOTICE.md, push 2026-10-18): tải/tra cứu/tổng hợp hóa đơn mua vào–bán ra, cả hóa đơn máy tính tiền; dùng endpoint `query` và `sco-query`, phân trang theo `state`; tải XML/HTML dạng ZIP; fallback API detail khi XML trả 500/504; retry khi rate-limit; đăng nhập lại khi 401/403 — [GitHub](https://github.com/dieutx/TaiHoaDonDienTu); bản PowerShell `dieutx/hddt-downloader-windows` tự nhận CAPTCHA, cấu hình `GDT_USERNAME`/`GDT_PASSWORD` trong `.env` — [GitHub](https://github.com/dieutx/hddt-downloader-windows)
- `TranHoangAnhTuan/invoices-hoadondientu.gdt.gov.vn` (Python, 1 star): dùng `cookies.json` của phiên đăng nhập, `python getInvoice.py --type purchase|sold --month --year`, xuất `data_json` — [GitHub](https://github.com/TranHoangAnhTuan/invoices-hoadondientu.gdt.gov.vn)
- Tra cứu web thủ công cần MST bên bán, loại HĐ, ký hiệu, số HĐ, tổng tiền + captcha; `hoadondientu.gdt.gov.vn` thay cho `tracuuhoadon.gdt.gov.vn`; tra cứu hàng loạt yêu cầu đăng nhập — [ketoanthuanthien.vn](https://ketoanthuanthien.vn/?p=7356); [accgroup.vn](https://accgroup.vn/hoa-don-dien-tu-gov)

### Inferences
- Một phần mềm kế toán VN thực tế không tự gửi XML tới CQT mà đi qua "tổ chức cung cấp dịch vụ" (MISA/Viettel/VNPT…); do đó bề mặt tích hợp chính là REST/JSON của từng nhà cung cấp, còn XML 1450 là thứ nhận về (file gốc có giá trị pháp lý) để lưu trữ/đối chiếu. Cần parser XML 1450 (đọc `DLHDon`, `NBan`, `NMua`, `DSHHDVu`, `TToan`, xác minh `Signature`) hơn là generator.
- Mẫu JSON SInvoice trong Odoo cho thấy mô hình dữ liệu tối thiểu phần mềm cần có: UUID giao dịch, mẫu số/ký hiệu, loại điều chỉnh, tham chiếu hóa đơn gốc + văn bản thỏa thuận, dòng hàng có `isIncreaseItem`, breakdown theo thuế suất. Mô hình này gần như ánh xạ 1-1 với thẻ 1450.
- Vì các nguồn xác nhận "Thông tư 91/2026 là quy định định dạng hiện hành" nhưng không tìm thấy quyết định kỹ thuật mới, có khả năng QĐ 1450 (sửa bởi 1510) vẫn là chuẩn XML đang áp dụng (chưa xác minh).

### Gaps
- Không lấy được toàn văn Phụ lục QĐ 1450: danh sách mã `MLTDiep`, cấu trúc đầy đủ `DLHDon/TTChung/NDHDon/HHDVu/TToan/DSCKS/MCCQT`, cấu trúc `BTHDLieu` (bảng tổng hợp), phương thức truyền nhận (web service) — các trang pháp luật cắt nội dung hoặc chặn (403). Cần tải file .doc/.pdf gốc từ gdt.gov.vn hoặc thuvienphapluat.
- Không có toàn văn QĐ 1510/QĐ-TCT (nội dung sửa đổi cụ thể).
- Không tìm thấy tài liệu API công khai của VNPT Invoice (tên phương thức SOAP `ImportAndPublishInv`, `PublishService` không xác minh được), BKAV eHoadon, EasyInvoice/SoftDreams, M-Invoice, CyberBill, Thái Sơn, FPT.eInvoice; MISA không công bố endpoint ngoài trang giới thiệu.
- Chưa xác định URL/port chính xác các endpoint hoadondientu.gdt.gov.vn (`security-taxpayer/authenticate`, `query/invoices/...`) từ README; phải đọc mã nguồn các repo trên.
- Chưa xác nhận có quyết định mới của Cục Thuế thay thế QĐ 1450 sau 01/7/2026; nội dung Điều 3–4 Thông tư 91/2026 về định dạng chưa đọc được từ văn bản gốc (PDF EY mã hóa AES-256, không trích được).

---

## Câu 3. HTKK XML schema là gì, phần mềm có thể tự sinh file nộp trực tiếp không, có đặc tả chính thức không?

### Takeaway
Không tìm thấy đặc tả XML/XSD chính thức nào được công bố cho tờ khai HTKK (chuẩn mà ứng dụng bên thứ ba gọi là "HSoThueDTu"); luồng chính thức là HTKK (Windows, hiện 5.7.2) "Kết xuất XML" → nộp qua thuedientu.gdt.gov.vn hoặc T-VAN, và đọc lại bằng iTaxViewer (2.7.0). Giải pháp thực tế cho phần mềm thứ ba là trở thành/hợp tác với T-VAN (được quy định bởi Thông tư 89/2026/TT-BTC) hoặc sinh XML bằng cách reverse-engineer file mẫu xuất từ HTKK.

### Cited Findings
- HTKK 5.7.2 được Cục Thuế nâng cấp ngày 10/07/2026 để thực hiện Nghị quyết 34/2026/NQ-CP (gia hạn thuế xăng dầu), bổ sung mã thuế BVMT 0 đồng cho xăng, dầu, nhiên liệu bay — [amis.misa.vn](https://amis.misa.vn/61453/phan-mem-ho-tro-ke-khai-thue-htkk/); HTKK 5.7.1 thay 5.7.0 đáp ứng Thông tư 50/2026/TT-BTC — [Thư viện Pháp luật](https://thuvienphapluat.vn/phap-luat/ho-tro-phap-luat/tai-phan-mem-htkk-571-moi-nhat-thay-the-htkk-570-dap-ung-thong-tu-502026ttbtc-link-tai-phan-mem-htk-273553.html); HTKK không tự cập nhật, phải gỡ bản cũ cài bản mới và sao lưu dữ liệu — [Thư viện Pháp luật](https://thuvienphapluat.vn/ma-so-thue/phap-luat-thue/cach-cap-nhat-htkk-moi-nhat-2026-phan-mem-htkk-con-tu-dong-cap-nhat-khong-391939-218393.html); tải tại gdt.gov.vn mục "hotrokekhai" — [hoatieu.vn](https://hoatieu.vn/htkk-90318)
- iTaxViewer 2.7.0 đi kèm HTKK 5.6.1 phục vụ quyết toán thuế 2025 — [Thư viện Pháp luật](https://thuvienphapluat.vn/hoi-dap-phap-luat/link-va-file-tai-htkk-561-va-itaxviewer-270-moi-nhat-ho-tro-quyet-toan-thue-2025-o-dau-138083751.html); iTaxViewer do Tổng cục Thuế phát hành để đọc XML xuất từ HTKK (tờ khai tháng/quý, quyết toán TNCN/TNDN, thông báo) và xem chữ ký điện tử — [Thư viện Pháp luật](https://thuvienphapluat.vn/ma-so-thue/phap-luat-thue/to-khai-xml-la-gi-cach-xem-to-khai-thue-dinh-dang-xml-tren-itax-viewer-moi-nhat-2026-237125-224250.html)
- Luồng xuất/nộp: lập tờ khai trong HTKK → "Kết xuất XML" → thuedientu.gdt.gov.vn chức năng "Nộp tờ khai XML" / "Trình ký" / "Nộp tờ khai từ HTKK" — [hoatieu.vn](https://hoatieu.vn/bieu-mau/huong-dan-gui-to-khai-dinh-dang-xml-qua-chuc-nang-nop-to-khai-tu-htkk-98643); hộ kinh doanh tải XML đã kết xuất lên thuedientu.gdt.gov.vn rồi ký số — [hethongphapluat.com](https://hethongphapluat.com/phap-luat/huong-dan/ke-khai-thue-ho-kinh-doanh-tren-htkk-huong-dan-chi-tiet-tu-z-de-tranh-bi-phat.html)
- Ứng dụng iOS "Xem Tờ khai XML" nêu rõ đọc theo "chuẩn HSoThueDTu của Cục Thuế" và có thể hiển thị dữ liệu thô khi chưa hỗ trợ mẫu — [mwm.ai](https://mwm.ai/apps/xem-t-khai-xml/6779834554)
- Mẫu 01/GTGT theo Thông tư 80/2021/TT-BTC, sau được sửa bởi Nghị định 70/2025/NĐ-CP — [Sapo](https://www.sapo.vn/blog/huong-dan-ke-khai-thue-gtgt)
- T-VAN: Sapo tự công bố là tổ chức T-VAN được CQT chấp thuận theo Thông tư 19/2021/TT-BTC, cho nộp tờ khai ngay trên nền tảng — [sapo.vn](https://www.sapo.vn/blog/sapo-ket-noi-dich-vu-thue-dien-tu-t-van); CQT hoặc T-VAN gửi thông báo xác nhận đã nhận hồ sơ chậm nhất 15 phút — [Thư viện Pháp luật chủ đề thuế điện tử](https://thuvienphapluat.vn/phap-luat/chu-de/thue-dien-tu)
- Thông tư 89/2026/TT-BTC (30/6/2026, hiệu lực 01/7/2026) hướng dẫn Luật Quản lý thuế 2025 và Nghị định 252/2026/NĐ-CP về giao dịch điện tử thuế; với T-VAN: thời gian chấp nhận hồ sơ kết nối rút từ 20 xuống 05 ngày làm việc, công bố danh sách T-VAN từ 10 xuống 05 ngày làm việc; xác nhận điện tử quy định tại Điều 10 — [luatvietan.vn](https://luatvietan.vn/thong-tu-89-2026-tt-btc.html); [MISA eShop toàn văn](https://www.misaeshop.vn/?p=45023); [RSM](https://www.rsm.global/vietnam/vi/node/1500)
- GitHub: `thien0247/HTKK` (Batchfile, 2 stars) chỉ là script cài đặt; `cuongtranba/vietnam-accounting-skills` (MIT) có "HTKK/MISA schedules" dưới dạng agent skill — [api.github.com search](https://api.github.com/search/repositories?q=ketoan+OR+%22ke+toan%22+OR+%22phan+mem+ke+toan%22+OR+%22k%E1%BA%BF+to%C3%A1n%22+OR+TT200+OR+HTKK&sort=stars&order=desc&per_page=30)

### Inferences
- Không có công bố XSD nên cách duy nhất để sinh XML tương thích là lấy file mẫu từ HTKK cho từng mẫu (01/GTGT, 03/TNDN, 05/KK-TNCN, BCTC) và đối chiếu bằng iTaxViewer; rủi ro: mỗi bản HTKK (thay đổi rất thường xuyên theo thông tư mới) có thể đổi phiên bản mẫu/thẻ.
- Con đường "chuẩn" cho phần mềm thương mại là tích hợp với T-VAN (MISA, Sapo…) hoặc đăng ký T-VAN theo Thông tư 89/2026, chứ không phải gọi API thuedientu.gdt.gov.vn trực tiếp (không có API công khai).

### Gaps
- Không tìm được tài liệu đặc tả XML tờ khai (tên thẻ `HSoThueDTu`, `TKhaiThue`, `CTieuTKhaiChinh`…), XSD, hay hướng dẫn kỹ thuật kết nối T-VAN từ Cục Thuế.
- Chưa xác nhận danh sách T-VAN chính thức hiện hành và tư cách T-VAN của MISA mTax, TS24, Thái Sơn.
- Chưa xác minh Thông tư 89/2026 có bãi bỏ Thông tư 19/2021/TT-BTC hay không (nguồn mâu thuẫn).

---

## Câu 4. Ngân hàng nào mở API cho nhà cung cấp phần mềm, yêu cầu tích hợp ra sao?

### Takeaway
VietinBank (openapi.vietinbank.vn — REST/JSON, client_id/secret, whitelist IP, mã hóa bằng chứng thư số), BIDV (openapi.bidv.com.vn, ra mắt 29/11/2023, có sandbox, token qua đăng nhập iBank), TPBank (hàng trăm API cho DN), ACB (developer.acb.com.vn, sandbox — theo nguồn bên thứ ba) có cổng Open API; MB kết nối phần mềm kế toán qua trung gian JetPay BankHub trên Biz MBBank. Với phần mềm nhỏ, hai aggregator Casso và SePay cung cấp webhook biến động số dư + REST API tra giao dịch được tài liệu hóa đầy đủ; VietQR theo chuẩn NAPAS v1.5.2 (EMVCo) có nhiều thư viện mở.

### Cited Findings
**VietinBank**
- Cổng mới `openapi.vietinbank.vn`: 8 gói giải pháp theo ngành, 19 sản phẩm/dịch vụ số, tích hợp trực tiếp vào ERP hoặc phần mềm kế toán — [vietinbank.vn (15/06/2026)](https://vietinbank.vn/en/doanh-nghiep/tin-tuc-va-su-kien/vietinbank-open-api-portal-phien-ban-moi-don-dau-xu-huong-tai-chinh-so-thong-minh-20260615044700-00-html); `developer.vietinbank.vn` chuyển hướng (302) sang `openapi.vietinbank.vn` (trang render bằng JS, không trích được nội dung)
- Tài liệu ERP use case (PDF 08/2025): RESTful API qua HTTPS, JSON; xác thực bằng client ID và client secret do VietinBank cấp; production phải đăng ký IP của DN; dùng chứng thư số của DN để mã hóa giao dịch trước khi gửi; use case: tiền gửi & tất toán trước hạn, chi lương, mua/chuyển ngoại tệ, sao kê — [UseCase Tiền gửi](https://developer.vietinbank.vn/vtb/openbanking/system/files/2025-08/VietinBank_ERP_UseCase_Ti%E1%BB%81n%20g%E1%BB%ADi%20v%C3%A0%20t%E1%BA%A5t%20to%C3%A1n%20tr%C6%B0%E1%BB%9Bc%20h%E1%BA%A1n_v1.0.pdf); [UseCase Chi lương](https://developer.vietinbank.vn/vtb/openbanking/system/files/2025-08/VietinBank_ERP_UseCase_Chi%20l%C6%B0%C6%A1ng_v1.0.pdf); [UseCase Sao kê](https://developer.vietinbank.vn/vtb/openbanking/system/files/2025-08/VietinBank_ERP_UseCase_Sao%20k%C3%AA_v1.0.pdf)
- VietinBank ERP-Connect (2021) đã có đối tác ERP: MISA, NC9, BRAVO, FAST, EFFECT, VACOM, 1C, CITECK, CLOUDIFY, SAP, Oracle — [tuoitre.vn](https://tuoitre.vn/vietinbank-erp-connect-but-toc-trong-cuoc-dua-so-hoa-20211227180452956.htm)

**BIDV**
- BIDV Open API ra mắt 29/11/2023, 4 module: API Product Management, Open API Portal (developer), API Gateway, API Analytics; xây dựng cùng FPT IS — [fpt-is.com](https://fpt-is.com/en/customers/bidv-open-api-system-developed-by-bidv-in-partnership-with-fpt-is/); sandbox: >240.000 lượt gọi, ~600 tài khoản trải nghiệm, >100 đối tác đăng ký — [sggp.org.vn](https://www.sggp.org.vn/bidv-open-api-dan-dau-xu-the-ngan-hang-mo-post731898.html)
- Use case "Gói Chuyển tiền trong nước doanh nghiệp – Kết nối BIDV iBank" (08/2025): đối tác đăng nhập bằng user BIDV iBank trên website xác thực do BIDV cấp, dùng access token còn hiệu lực; hết hạn gọi "API Get Token"; luồng gồm API "Tra cứu loại doanh nghiệp 2 bước hay 3 bước", "iBank_Check Step Approve"… — [openapi.bidv.com.vn PDF](https://openapi.bidv.com.vn/devportal/sites/devportal.openapi.bidv.com.vn/files/2025-08/Usecase%20G%C3%B3i%20Chuy%E1%BB%83n%20ti%E1%BB%81n%20trong%20n%C6%B0%E1%BB%9Bc%20doanh%20nghi%E1%BB%87p%20-%20K%E1%BA%BF%20n%E1%BB%91i%20BIDV%20iBank.pdf) (fetch trực tiếp chỉ trả tiêu đề; nội dung từ snippet tìm kiếm)

**MB, TPBank, ACB, Techcombank, VPBank**
- MB: kết nối AMIS Kế toán qua JetPay BankHub, DN phải đăng ký BankHub trên Biz MBBank; sau kết nối: chuyển tiền, tra số dư, lấy sao kê, đối chiếu, nhận biến động số dư tự hạch toán — [helpact.misa.vn](https://helpact.misa.vn/kb/ket-noi-voi-ngan-hang-dien-tu-mb/); [điều kiện](https://helpact.misa.vn/kb/ket-noi-voi-ngan-hang-dien-tu-mb-2/); hợp tác MB–MISA trên SME.NET 2020/AMIS — [sme.misa.vn](https://sme.misa.vn/116346/dich-vu-ngan-hang-dien-tu-cua-mb-ket-hop-voi-misa-gia-tang-loi-ich-cho-doanh-nghiep/)
- TPBank: cung cấp API cho khách hàng từ 2019–2020, "hàng trăm loại API", DN truyền dữ liệu từ hệ thống riêng thay vì đăng nhập eBank; nhóm mục tiêu tập đoàn, chứng khoán, bảo hiểm, bán lẻ, TMĐT, ví — [diendandoanhnghiep.vn](https://diendandoanhnghiep.vn/tpbank-ra-doi-hang-tram-loai-api-khac-nhau-phuc-vu-doanh-nghiep-247154.html); MISA có hướng dẫn điều kiện kết nối TPBank — [helpact.misa.vn](https://helpact.misa.vn/kb/dieu-kien-ket-noi-ngan-hang-dien-tu-tpbank/)
- ACB: cổng `developer.acb.com.vn` với sandbox, đăng ký ứng dụng lấy credentials (nguồn bên thứ ba, chưa kiểm chứng) — [openbankingtracker](https://openbankingtracker.com/provider/asia-commercial-bank/apis); [banq.ai](https://banq.ai/provider/asia-commercial-bank)
- Techcombank, VPBank: không tìm thấy cổng Open API doanh nghiệp (kết quả "VP Bank" là ngân hàng Liechtenstein) — [vpbank.com (Liechtenstein)](https://www.vpbank.com/en-li/node/1239)

**Aggregator — Casso**
- Webhook: Casso gọi endpoint của bạn mỗi khi có giao dịch mới; payload `{"error":0,"data":[{...}]}` với `id` (ID Casso), `tid` (mã tham chiếu ngân hàng), `description`, `amount`, `cusum_balance` (số dư sau GD), `when`, `bank_sub_acc_id` (số TK); mỗi gọi có "Key bảo mật" trong HTTP header để xác thực; timeout 5 giây; phải trả HTTP 200 (Strict mode cần `success: 1`/`true`); retry trong 12 giờ, lần đầu sau 1 phút, giãn theo Fibonacci; URL phải HTTPS công khai; whitelist IP Casso nếu dùng Cloudflare; dedupe theo `id` — [developer.casso.vn webhook](https://developer.casso.vn/v1/webhook/thiet-lap-webhook-thu-cong.md); bản v1 ghi tối đa 17 lần thử — [developer.casso.vn/v1/webhook](https://developer.casso.vn/v1/webhook)
- REST API (stable): xác thực API Key hoặc OAuth2; endpoint: lấy thông tin user (tài khoản, DN, ngân hàng liên kết), lấy giao dịch, lấy tài khoản ngân hàng, thiết lập webhook, check giao dịch mới (ép đồng bộ) — [developer.casso.vn/llms.txt](https://developer.casso.vn/llms.txt)

**Aggregator — SePay**
- Webhook HTTP POST, payload mẫu: `id` 92704, `gateway` "Vietcombank", `transactionDate` "2024-07-02 11:08:33", `accountNumber`, `subAccount`, `code` "SEVN63DC8E5C" (mã thanh toán khớp), `content`, `transferType` "in", `description`, `transferAmount` 5000000, `accumulated` 105000000, `referenceCode` "FT24012345678"; xác thực None / API Key (`Authorization: Apikey <KEY>`) / HMAC-SHA256 (khuyến nghị, chữ ký trong header) / OAuth 2.0; phải trả 200/201, body `{"success": true}` trong 30 giây; retry tối đa 7 lần trong 5 giờ, connect timeout 5 giây — [docs.sepay.vn](https://docs.sepay.vn/tich-hop-webhooks.html); trang developer ghi 7 lần, giãn Fibonacci ~33 phút (mâu thuẫn số liệu thời gian với docs.sepay.vn); lọc theo tài khoản/VA/mã thanh toán, "Skip transactions without code", giám sát + replay (10 lần/phút/công ty), endpoint phải idempotent; đối tác chiến lược: Vietcombank, BIDV, VietinBank, MBBank, ACB, VPBank, TPBank, Sacombank, MSB, OCB, KienlongBank, Shinhan, NAPAS — [developer.sepay.vn](https://developer.sepay.vn/en/sepay-webhooks); [tạo webhook](https://developer.sepay.vn/en/sepay-webhooks/tao-webhook); [giám sát](https://developer.sepay.vn/en/sepay-webhooks/giam-sat)
- REST API: base `https://my.sepay.vn/userapi/`; `GET transactions/list` (params `account_number`, `transaction_date_min/max`, `since_id`, `limit` ≤ 5000, `reference_number`, `amount_in`, `amount_out`), `GET transactions/details/{id}`, `GET transactions/count`; trường: `id`, `transaction_date`, `account_number`, `sub_account`, `amount_in`, `amount_out`, `accumulated`, `code`, `transaction_content`, `reference_number`, `bank_brand_name`, `bank_account_id`; số tiền trả dạng chuỗi "19689000.00" — [docs.sepay.vn API giao dịch](https://docs.sepay.vn/api-giao-dich.html); API quản lý webhook OAuth2 scope `webhook:read/write/delete` — [docs.sepay.vn](https://docs.sepay.vn/oauth2/api-webhooks.html)

**VietQR / NAPAS**
- Thư viện mở theo "NAPAS VietQR v1.5.2 specification (EMVCo standard)" — [laravel-vietqr](https://laraplugins.io/plugins/takashato/laravel-vietqr); phân biệt chuyển khoản tới tài khoản `QRIBFTTA` và tới thẻ `QRIBFTTC`, checksum CRC-16-CCITT (ISO/IEC 13239), BIN ngân hàng, QR tĩnh (chỉ bank+số TK) vs động (có số tiền/nội dung) — [vietqr_gen (Dart)](https://pub.dev/packages/vietqr_gen); [sonjeremy/vietqr (PHP)](https://root.packagist.org/packages/sonjeremy/vietqr)
- `vietqr/vietqr-node` (MIT): URL ảnh dạng `https://api.vietqr.io/Vietinbank/113366668888/790000/Gop%20Quy/qr_only.jpg?accountName=...`, template `qr_only`/`compact`/`compact2`; `getBanks()` trả `bin`, `code`, `short_name`; constructor nhận `clientID`, `apiKey` — [GitHub](https://github.com/vietqr/vietqr-node); một repo khác dùng `api.vietqr.io/v1/banks` — [vietqr-io/vietqr-api](https://github.com/vietqr-io/vietqr-api); `api.vietqr.io` là dịch vụ bên thứ ba do VietQR.io vận hành, không bảo đảm uptime/rate limit — [vietqr_gen](https://pub.dev/packages/vietqr_gen)
- Odoo `l10n_vn` tạo VietQR qua dependency `account_qr_code_emv` — [__manifest__.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/l10n_vn/__manifest__.py)
- `api.vietqr.vn` có mục "Declare merchant connection", "Description of VietQR API Workflow", "Synchronize information" — [api.vietqr.vn](https://api.vietqr.vn/en)

### Inferences
- Tích hợp trực tiếp ngân hàng lớn yêu cầu pháp nhân ký hợp đồng, whitelist IP, chứng thư số và thường đăng nhập iBank/eFAST của chính khách hàng — phù hợp ERP lớn, không phù hợp SaaS kế toán nhỏ. Casso/SePay là đường tắt: webhook JSON + REST cho đối chiếu công nợ; phần mềm nên thiết kế bảng giao dịch ngân hàng với trường `reference_number`/`tid` làm khóa idempotent và nhận mã thanh toán (`code`) để tự khớp.
- Định dạng sao kê file (MT940/CSV) không được bất kỳ nguồn nào tài liệu hóa cho ngân hàng VN; thực tế các phần mềm (MISA) lấy sao kê qua API/trung gian hơn là import file chuẩn.

### Gaps
- Không đọc được nội dung openapi.vietinbank.vn và openapi.bidv.com.vn (render JS / PDF không trích được) → chưa có danh sách endpoint, mô hình OAuth2 cụ thể, sandbox host.
- Không tìm thấy tài liệu API chính thức của MB, Techcombank, VPBank, TPBank, ACB (chỉ nguồn báo chí/bên thứ ba).
- Không tìm thấy đặc tả định dạng file sao kê ngân hàng VN, cũng như tài liệu kỹ thuật NAPAS VietQR chính thức (chỉ thư viện mở trích dẫn v1.5.2).
- Chưa có thông tin giá/điều khoản Casso và SePay.

---

## Câu 5. Có dự án kế toán VN mã nguồn mở nào đủ trưởng thành để mượn? (URL, stars, commit cuối, license)

### Takeaway
Không có dự án nào trưởng thành: dự án "ra dáng" nhất là `fanha99/odoo-ce-vas` (AGPL-3.0, Odoo 20, TT133 + sổ S03a/S03b + CDPS XML, 2 stars, đang cập nhật 10/2026) và `n8n2erpnext/erpnext-vietnam` (ERPNext v16, TT99 184 tài khoản, VAT/PIT/BHXH, 0.1.0-rc1, 1 star). Các dự án cũ (`openaccounting` AGPL 2015, `quanlyviet` GPL PHP 5) không theo TT200. Phần đáng mượn thực sự là dữ liệu (CSV tài khoản/thuế của Odoo, danh mục TT99/TT133) và mã kết nối SInvoice của Odoo.

### Cited Findings
Tổng hợp từ GitHub Search API (3 truy vấn: 205 kết quả cho "hoa don dien tu / einvoice vietnam", 619 cho "ketoan / phần mềm kế toán / TT200 / HTKK", 10 cho "l10n_vn / vietnam accounting / erpnext vietnam") — [search 1](https://api.github.com/search/repositories?q=hoa+don+dien+tu+OR+einvoice+vietnam+OR+hoadondientu&sort=stars&order=desc&per_page=30); [search 2](https://api.github.com/search/repositories?q=ketoan+OR+%22ke+toan%22+OR+%22phan+mem+ke+toan%22+OR+%22k%E1%BA%BF+to%C3%A1n%22+OR+TT200+OR+HTKK&sort=stars&order=desc&per_page=30); [search 3](https://api.github.com/search/repositories?q=l10n_vn+OR+%22vietnam+accounting%22+OR+%22erpnext+vietnam%22+OR+%22vietnam+chart+of+accounts%22&sort=stars&order=desc&per_page=30)

| Repo | Mô tả | Stack | License | Stars | Push cuối |
|---|---|---|---|---|---|
| [fanha99/odoo-ce-vas](https://github.com/fanha99/odoo-ce-vas) | Module Odoo CE 20.0 cho VAS: `l10n_vn_tt133` (TT133), `fg_vn_accounting_reports` (xuất Excel/PDF), `fg_vn_report_cdps` (bảng cân đối số phát sinh + XML F01-CDTK), `fg_vn_report_s03a` (S03a-DNN), `fg_vn_report_s03b` (S03b-DNN), `fg_account_counterpart`, `fg_vn_transfer_account`, `fg_vn_stock_reports`; README ghi "Module đã hoàn thành", cập nhật 2026-10-10…18; không có TT200, không e-invoice | Python/Odoo 20 | AGPL-3.0 | 2 | 2026-10-19 |
| [n8n2erpnext/erpnext-vietnam](https://github.com/n8n2erpnext/erpnext-vietnam) | Lớp tuân thủ VN cho Frappe 16.17.0/ERPNext 16.16.0/HRMS 16.5.4: danh mục TT99 184 tài khoản (71 cấp 1), tùy chọn TT133_2016, VAT 0/5/8/10/không chịu thuế, TNCN + BHXH/BHYT/BHTN (baseline 2026), tờ khai theo Thông tư 89/2026/TT-BTC, khung e-invoice (lifecycle, idempotency, gateway contract) nhưng "no provider adapter is production-certified yet"; v0.1.0-rc1 | Python/Frappe | không ghi | 1 | 2026-09-06 |
| [nguyenhuuduong-lkf/erpnext-vietnam-localization](https://github.com/nguyenhuuduong-lkf/erpnext-vietnam-localization) | Gói dịch ERPNext v16.13.3 (~17,600 chuỗi, phần lớn do LLM sinh), patch `money_in_words()` ra "đồng chẵn", Dockerfile; không có hệ thống tài khoản | Python | MIT (scripts, frappe.vi.po), GPL-3 (erpnext/hrms .po) | 2 | 2026-04-18 |
| [Openroadvietnam/openaccounting](https://github.com/Openroadvietnam/openaccounting) | "Phần mềm kế toán nguồn mở Việt Nam" của Sao Tiên Phong: tiền mặt, mua/bán, kho, sổ cái, TSCĐ; 0.0.1 beta; Node 0.10 | Node.js/MongoDB/AngularJS | AGPL-3.0 | 29 | 2015-05-05 |
| [aodieu/quanlyviet](https://github.com/aodieu/quanlyviet) | ERP/kế toán web PHP 5.0–8.4, 479 commits, có demo; không nêu TT200/TT133 | PHP/MySQL | GPL-3.0 | 7 | 2026-05-10 |
| [chinhducle828-lang/ketoan-erp](https://github.com/chinhducle828-lang/ketoan-erp) | "Accounting ERP System" | JavaScript | không | 4 | 2026-07-24 |
| [vqton/tt99acct](https://github.com/vqton/tt99acct) | Hệ thống kế toán TT99, ASP.NET Core clean architecture | C# | MIT | 1 | 2025-11-19 |
| [hatuan/OpenAccounting](https://github.com/hatuan/OpenAccounting) | Odoo-based VAS | — | không | 0 | 2021-05-29 |
| [Vietbuzz/l10n_vn_edi_viettel_mini_custom](https://github.com/Vietbuzz/l10n_vn_edi_viettel_mini_custom) | custom module Odoo trên l10n_vn_edi_viettel | Python | không | 0 | 2026-09-30 |
| [dieutx/TaiHoaDonDienTu](https://github.com/dieutx/TaiHoaDonDienTu) | Tải/tra cứu HĐĐT từ hoadondientu.gdt.gov.vn (VBA, v6.7.7) | VBA | không (NOTICE.md) | 5 | 2026-10-18 |
| [diginno-net/opc-vn-business-law](https://github.com/diginno-net/opc-vn-business-law) | Agent skill tham chiếu pháp lý/thuế/kế toán cho công ty 1 thành viên | Python | NOASSERTION | 63 | 2026-10-18 |
| [cuongtranba/vietnam-accounting-skills](https://github.com/cuongtranba/vietnam-accounting-skills) | Agent skill: e-invoice, đối chiếu sổ, HTKK/MISA schedules | Python | MIT | 2 | 2026-10-16 |
| [abm-dungtq/vn-accounting-codex-skills](https://github.com/abm-dungtq/vn-accounting-codex-skills) | Skill Codex: quy tắc có nguồn, tính thuế/lương | Python | MIT | 0 | 2026-08-07 |

- `fg_vn_accounting_reports` manifest: "Vietnam Accounting Reports - Core", depends `account`, AGPL-3, version 20.0.1.2.2, summary "Shared screen, Excel export and PDF printing of the Vietnamese accounting books", không khai báo `external_dependencies` — [__manifest__.py](https://raw.githubusercontent.com/fanha99/odoo-ce-vas/20.0/fg_vn_accounting_reports/__manifest__.py)
- Frappe: hệ thống tài khoản vùng được đóng góp vào core ERPNext, còn tính năng tuân thủ vùng để ở app riêng (như India Compliance) — [docs.frappe.io](https://docs.frappe.io/cloud/guidelines-for-contributing-regional-localisation); không thấy VN trên charts.erpnext.com — [discuss.frappe.io](https://discuss.frappe.io/t/proposed-ifrs-compliant-chart-of-accounts/22375/2)
- Phần mềm "miễn phí" nhưng không mở mã (LinkQ, 3TSoft, FTS, SSE, EasyBooks) — [ketoanthuanthien.vn](https://ketoanthuanthien.vn/kien-thuc/phan-mem-ke-toan-mien-phi/)

### Inferences
- Xu hướng 2026: nhiều repo mới là "agent skills" chứa quy tắc kế toán/thuế VN (opc-vn-business-law 63 stars) hơn là phần mềm; có thể mượn làm nguồn quy tắc nghiệp vụ (cần kiểm chứng).
- Nếu chọn nền Odoo: ghép `l10n_vn` (LGPL) + `odoo-ce-vas` (AGPL, sổ sách/CDPS) + `l10n_vn_edi_viettel` là bộ mở gần đủ cho SME theo TT133; nhưng AGPL "lây" sang sản phẩm nếu phân phối.
- Nếu tự viết: dữ liệu đáng mượn nhất là CSV 218 tài khoản/15 thuế của Odoo và danh mục TT99 của erpnext-vietnam; logic báo cáo B01/B02/B03 chưa có bản mở nào đáng tin.

### Gaps
- Không đọc được mã các repo để đánh giá chất lượng (chỉ README/metadata); erpnext-vietnam không ghi license.
- GitHub Search bị cắt (chỉ 14–18 kết quả đầu mỗi truy vấn), có thể bỏ sót repo ít sao nhưng hữu ích.

---

## Câu 6. Chữ ký số (USB token, HSM, ký số từ xa) và BHXH điện tử: chuẩn, nhà cung cấp, bề mặt tích hợp

### Takeaway
Ký số từ xa ở VN được điều chỉnh bởi Thông tư 16/2019/TT-BTTTT (05/12/2019, danh mục tiêu chuẩn bắt buộc cho ký số di động/từ xa) với hướng dẫn cấp phép của NEAC (2021, cập nhật 02/2022) dựa trên bộ CEN EN 419 241 / ETSI TS 119 431/432; VNPT SmartCA có tài liệu tích hợp API v1.0 (2024) với `client_id`/`ClientSecret`. BHXH điện tử bắt buộc qua I-VAN (VNPT, Thái Sơn eBH, EFY, TS24, Bkav, Viettel, MISA) — chuẩn XML hồ sơ do BHXH VN cấp cho I-VAN, không công bố.

### Cited Findings
**Chữ ký số / ký số từ xa**
- Thông tư 16/2019/TT-BTTTT ngày 05/12/2019 quy định danh mục tiêu chuẩn bắt buộc áp dụng về chữ ký số và dịch vụ chứng thực chữ ký số theo mô hình ký số trên thiết bị di động và ký số từ xa — [khanhson.khanhhoa.gov.vn](https://khanhson.khanhhoa.gov.vn/tin-chi-tiet/id/16657/Trien-khai-thuc-hien-Thong-tu-so-16/2019/TT-BTTTT-ngay-05/12/2019-cua-Bo-Thong-tin-va-Truyen-thong); CA công cộng muốn cung cấp ký số từ xa phải tuân thủ thông tư này; đến 9/2023 Bộ TT&TT đã cấp phép 7 CA công cộng cung cấp ký số từ xa — [Ascertia](https://blog.ascertia.com/remote-signing-vietnam-legal-framework)
- NEAC ban hành "Hướng dẫn remote signing" (27/8/2021) và bản cập nhật (23/02/2022) — [NEAC 2021 PDF](https://dichvucong.neac.gov.vn/Uploads/admin/2021/8/27/HUONG_DAN_REMOTE_SIGNING.pdf); [NEAC 2022 PDF](https://storage-new.neac.gov.vn/Data/2022/02/23/huong-dan-remote-signing-637812049658094044.PDF) (PDF tải được nhưng không trích được text trong phiên này)
- Chuẩn quốc tế liên quan: ETSI TS 119 432 V1.1.1 (2019-03) "protocols for remote digital signature creation"; CEN EN 419241-1:2018, EN 419241-2:2019 và ETSI TS 119 431 về server signing — [ETSI](https://www.etsi.org/committee?id=1573); [ETSI TS 119 432 PDF](https://etsi.org/deliver/etsi_TS/119400_119499/119432/01.01.01_60/ts_119432v010101p.pdf)
- VNPT SmartCA: "Hướng dẫn tích hợp dịch vụ ký số từ xa VNPT SmartCA" v1.0 (2024) cho tổ chức/doanh nghiệp, có mô tả API và ví dụ request; hệ thống gọi API phải được cấp `client_id` và `ClientSecret` — [doitac-smartca.vnpt.vn PDF](https://doitac-smartca.vnpt.vn/help/document/TL_tich_hop_ban_hang_SmartCA_v1.0.pdf); SmartCA tích hợp >2.000 hệ thống, chứng thư công nhận giai đoạn 2026–2031 — [baophapluat.vn](https://baophapluat.vn/go-diem-nghen-cho-ky-voi-vnpt-smartca.html); [vneconomy.vn](https://vneconomy.vn/vnpt-smartca-duoc-gia-han-chung-thu-so-den-2031-cung-co-niem-tin-khach-hang-so.htm)
- Viettel MySign: ký số từ xa, xác thực hai lớp, tự mô tả theo eIDAS — [vov.vn](https://vov.vn/doanh-nghiep/doanh-nghiep-24h/viettel-telecom-tham-du-hoi-nghi-tuyen-truyen-ve-chu-ky-so-post987237.vov); Tanca tích hợp cả VNPT SmartCA và Viettel MySign theo luồng xác nhận trên app + OTP — [tanca.io](https://tanca.io/de/user-guide/downloading-the-app-and-signing-with-a-digital-signature)
- Trong XML HĐĐT: chữ ký theo XML Signature (W3C) với `SigningTime`, `X509SubjectName`, `X509Certificate` (xem câu 2) — [LuatVietnam QĐ 1450](https://luatvietnam.vn/thue/quyet-dinh-1450-qd-tct-bo-tai-chinh-210675-d1.html); thư viện XML-DSig mở: `xmldsigjs` (Web Crypto, RSA/ECDSA, có polyfill PKCS#11 cho HSM) — [npm xmldsigjs](https://www.npmjs.com/package/xmldsigjs); `xml-dsig` (Node, cần xmldom) — [npm xml-dsig](https://npmjs.com/package/xml-dsig)

**BHXH điện tử / I-VAN**
- Danh sách nhà I-VAN: VNPT, ThaiSonSoft (eBH), EFY, TS24, Bkav, Viettel, MISA và một số đơn vị khác — [ebh.vn](https://ebh.vn/tin-tuc/nen-su-dung-phan-mem-khai-bao-hiem-xa-hoi-dien-tu-cua-nha-cung-cap-ivan-nao); eBH ký hợp đồng I-VAN với BHXH VN năm 2015 — [ebh.vn giới thiệu](https://ebh.vn/gioi-thieu); EFY-eBHXH theo mô hình I-VAN — [baohiemxahoidientu.vn](https://baohiemxahoidientu.vn/bhxh/bang-gia-dich-vu-i-van.html)
- Nhà I-VAN được BHXH VN hỗ trợ nghiệp vụ, "được cung cấp các mẫu, khuôn dạng chuẩn", phải chuyển hồ sơ lên Cổng BHXH trong vòng 2 giờ kể từ khi nhận — [baohiemxahoidientu.vn](https://baohiemxahoidientu.vn/bhxh/cach-dang-ky-giao-dich-dien-tu-bhxh-qua-to-chuc-i-van.html)
- Quyết định 763/QĐ-BHXH (2015) về hồ sơ, thủ tục, quy trình đăng ký cung cấp dịch vụ I-VAN — [caselaw.vn](https://caselaw.vn/van-ban-phap-luat/154275-quyet-dinh-763-qd-bhxh-nam-2015-quy-dinh-ve-ho-so-thu-tuc-quy-trinh-dang-ky-cung-cap-dich-vu-i-van-do-tong-giam-doc-bao-hiem-xa-hoi-viet-nam-ban-hanh); Quyết định 838/QĐ-BHXH: DN lập hồ sơ BHXH điện tử bằng phần mềm "đáp ứng chuẩn định dạng dữ liệu của Bảo hiểm xã hội Việt Nam", đổi I-VAN phải đăng ký ngừng trước — [xcyber.vn](https://xcyber.vn/?p=4417); mẫu D02-LT ban hành kèm QĐ 1040/QĐ-BHXH — [ebh.vn](https://ebh.vn/tin-tuc/mau-d02-lt)
- Quyết định 3680/QĐ-BHXH ban hành quy định kỹ thuật cấu trúc thông điệp dữ liệu trao đổi với Cơ sở dữ liệu quốc gia về bảo hiểm — [baohiemxahoi.gov.vn PDF](https://baohiemxahoi.gov.vn:4545/File_Server_BHXH/documents/3680_Q%C4%90_BHXH.pdf); Công văn 1245/BHXH-CNTT (2024) kiểm thử tiếp nhận dữ liệu XML theo bảng chỉ tiêu Quyết định 4750/QĐ-BYT (lĩnh vực KCB, không phải hồ sơ thu) — [LuatVietnam](https://luatvietnam.vn/bao-hiem/cong-van-1245-bhxh-cntt-2024-trien-khai-kiem-thu-tiep-nhan-du-lieu-dien-tu-xml-413387-d6.html)
- `n8n2erpnext/erpnext-vietnam` có tính BHXH/BHYT/BHTN và bằng chứng lương (baseline 2026) — [GitHub](https://github.com/n8n2erpnext/erpnext-vietnam)

### Inferences
- Phần mềm kế toán muốn "ký số trong app" có 3 lựa chọn: (1) ký phía client bằng USB token qua plugin/desktop tool của nhà cung cấp HĐĐT (MISA/VNPT), (2) ủy quyền ký cho nhà cung cấp HĐĐT (HSM của họ), (3) tích hợp ký số từ xa (SmartCA/MySign) bằng API client_id/secret + xác nhận trên app. Lựa chọn (2) là đơn giản nhất vì không phải tự sinh XML-DSig.
- Với BHXH, không có API công khai → xuất file theo mẫu (D02-LT, TK1-TS…) để nhập vào phần mềm I-VAN, hoặc ký hợp tác kỹ thuật với một I-VAN.

### Gaps
- Không trích được danh mục tiêu chuẩn cụ thể của Thông tư 16/2019 và hướng dẫn NEAC (PDF không chuyển được sang text trong phiên này; đường dẫn đã lưu ở trên).
- Không có tài liệu kỹ thuật/XSD chuẩn hồ sơ BHXH điện tử dành cho I-VAN; không có API của VssID.
- Chưa xác minh Thông tư 16/2019 còn hiệu lực hay đã thay thế theo Luật Giao dịch điện tử 2023.

---

## Câu 7. API tra cứu dữ liệu (mã số thuế doanh nghiệp, hóa đơn)

### Takeaway
Không có API công khai chính thức của cơ quan thuế; `api.vietqr.io/v2/business/{taxCode}` là endpoint miễn phí bên thứ ba được dùng rộng rãi (trả tên, tên quốc tế, tên viết tắt, địa chỉ), tra cứu chỉ theo đúng MST 10/13 số; tra cứu hóa đơn chỉ có web form captcha hoặc reverse-engineered client.

### Cited Findings
- VietQR.IO `v2/business/:taxCode`: tra cứu thông tin DN theo MST; phản hồi gồm mã kết quả, tên công ty (tiếng Việt và tiếng Anh), tên viết tắt, địa chỉ — [vietqr.io](https://www.vietqr.io/en/business/:taxCode) (fetch trực tiếp 404; nội dung từ snippet)
- Apify actor "vietnam-company-data" mô tả endpoint business của VietQR là nguồn đọc, phản ánh hồ sơ công khai của Tổng cục Thuế; cổng quốc gia không tìm theo tên, chỉ tra đúng MST 10 số (13 số với chi nhánh) — [apify.com](https://apify.com/foxlabs/vietnam-company-data.md)
- Cổng đăng ký kinh doanh quốc gia dangkykinhdoanh.gov.vn là kênh tra cứu khác — [bizzi.vn](https://bizzi.vn/en/6-ways-to-look-up-the-latest-business-tax-code-2024/amp)
- Tra cứu hóa đơn tại hoadondientu.gdt.gov.vn: nhập MST bên bán, ký hiệu (bỏ số 1 đầu, giữ C/K), loại HĐ, số HĐ, tổng tiền thuế, tổng thanh toán + captcha; kết quả "Đã cấp mã hóa đơn" = hợp lệ — [ketoanthuanthien.vn](https://ketoanthuanthien.vn/?p=7356); [accgroup.vn](https://accgroup.vn/hoa-don-dien-tu-gov)
- Client không chính thức: xem câu 2 (`dieutx/TaiHoaDonDienTu`, `hddt-downloader-windows`, `TranHoangAnhTuan/...`).

### Inferences
- Dùng VietQR business API để auto-fill tên/địa chỉ khách hàng khi nhập MST là chuẩn thực tế của nhiều phần mềm VN; cần cache và fallback vì không có SLA.

### Gaps
- Không tìm thấy tài liệu chính thức, rate limit, điều khoản của `api.vietqr.io/v2/business`; không xác nhận tồn tại API tại `tracuunnt.gdt.gov.vn`.

---

## Câu 8. Thư viện/tiện ích tiếng Việt: đọc số thành chữ, định dạng ngày/số, Excel mẫu sổ sách

### Takeaway
Đọc số thành chữ có sẵn ở mọi stack: `vn-num2words` / `@oorts/read-vn-number` (npm), `chiecthuyenngoaixa` (PyPI, thuần Python, xử lý thập phân), `num2words` (PyPI, mã ngôn ngữ `vi`); ERPNext VN patch cho đuôi "đồng chẵn"; Viindoo có module nhưng OPL-1. Về Excel mẫu sổ sách, các dự án mở chỉ nói "xuất XLSX/PDF" mà không nêu thư viện; không tìm được template chuẩn mở cho S03a/S03b/B01-DN.

### Cited Findings
- `vn-num2words` (npm) 1.0.4: chuyển số thành chữ tiếng Việt, chạy Node và trình duyệt — [npmjs.com](https://npmjs.com/package/vn-num2words)
- `@oorts/read-vn-number` (npm): `toVNWord(15)` → "mười lăm" — [skypack](https://www.skypack.dev/view/@oorts/read-vn-number)
- `chiecthuyenngoaixa` (PyPI/GitHub): thuần Python ≥3.8, `num_to_words` hỗ trợ thập phân (ví dụ `num_to_words(123456789021003.45)`), kèm bỏ dấu, sắp xếp tiếng Việt — [pypi](https://pypi.org/project/chiecthuyenngoaixa); [GitHub](https://github.com/IoeCmcomc/chiecthuyenngoaixa)
- `num2words` (PyPI): đa ngôn ngữ, có mã `vi` — [pypi](https://pypi.org/project/num2words)
- ERPNext VN: patch `frappe.utils.money_in_words()` xuất tiếng Việt kết thúc bằng "đồng chẵn" khi site language = `vi` (MIT) — [GitHub](https://github.com/nguyenhuuduong-lkf/erpnext-vietnam-localization)
- Viindoo `to_vietnamese_number2words`: OPL-1, gắn với quy định lập hóa đơn/phiếu thu chi — [developer.viindoo.com](https://developer.viindoo.com/apps/app/15.0/to_vietnamese_number2words)
- Định dạng trong XML thuế: ngày `YYYY-MM-DD`, ngày giờ `YYYY-MM-DDThh:mm:ss` GMT+7, số ≤21 chữ số/≤6 thập phân (QĐ 1450) — [LuatVietnam](https://luatvietnam.vn/thue/quyet-dinh-1450-qd-tct-bo-tai-chinh-210675-d1.html); số tiền trong API SePay là chuỗi "19689000.00" — [docs.sepay.vn](https://docs.sepay.vn/api-giao-dich.html); hóa đơn hiển thị ngày ký dạng ngày/tháng/năm dương lịch — [ihoadon.vn](https://ihoadon.vn/hddt/quy-dinh-ve-dinh-dang-hoa-don-dien-tu.html)
- Excel: `fanha99/odoo-ce-vas` xuất Excel/PDF cho S03a-DNN, S03b-DNN, CDPS nhưng manifest không khai báo thư viện ngoài — [__manifest__.py](https://raw.githubusercontent.com/fanha99/odoo-ce-vas/20.0/fg_vn_accounting_reports/__manifest__.py); Viindoo xuất PDF/XLSX cho S38, S03a, S03b, S07, S08 (OPL-1) — [viindoo.com](https://viindoo.com/apps/app/16.0/l10n_vn_viin_account_reports); `hdedev/excel-vba` "Useful Excel functions for accounting" (VBA, 2 stars) — [GitHub search](https://api.github.com/search/repositories?q=ketoan+OR+%22ke+toan%22+OR+%22phan+mem+ke+toan%22+OR+%22k%E1%BA%BF+to%C3%A1n%22+OR+TT200+OR+HTKK&sort=stars&order=desc&per_page=30)

### Inferences
- Nên tự kiểm thử các thư viện đọc số với các ca "mười/mươi", "lăm/năm", "linh/lẻ", số 0 và số lớn; đuôi "đồng chẵn" / "đồng" là quy ước thực hành (ERPNext VN đã hard-code).
- Mẫu sổ sách theo TT200/TT133 (S03a-DN, S03b-DN, B01-DN…) phải tự dựng từ phụ lục thông tư; không có template mở sẵn để mượn.

### Gaps
- Không có nguồn xác nhận thư viện Excel cụ thể (openpyxl/xlsxwriter/ExcelJS/Apache POI) được dùng phổ biến cho mẫu sổ VN; không tìm thấy repo template XLSX mở theo TT200/TT133.
- Chưa kiểm tra chất lượng đầu ra tiếng Việt của `num2words` với số lớn (chính tài liệu ghi nhận lỗi nhỏ ở một số ngôn ngữ).
