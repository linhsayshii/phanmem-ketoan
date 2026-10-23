# Viettel SInvoice: tham chiếu API cho adapter hóa đơn điện tử

Tài liệu khảo cứu từ nguồn công khai. Chưa thử trên môi trường thật. Không có tài liệu chính thức của Viettel trong nguồn; mọi chi tiết dưới đây suy ra từ mã tích hợp của bên thứ ba.

## 0. Nguồn

Ký hiệu nguồn dùng trong tài liệu:

| Mã | Nguồn |
|---|---|
| ODOO-AM | `https://raw.githubusercontent.com/odoo/odoo/18.0/addons/l10n_vn_edi_viettel/models/account_move.py` (LGPL-3, Odoo 18.0, 930 dòng) |
| ODOO-SEND | `.../models/account_move_send.py` |
| ODOO-SYM | `.../models/sinvoice.py` (mẫu hóa đơn, ký hiệu) |
| ODOO-CO | `.../models/res_company.py`, `.../models/res_partner.py` |
| ODOO-REV | `.../wizard/account_move_reversal.py` (điều chỉnh, thay thế) |
| ODOO-CAN | `.../wizard/l10n_vn_edi_cancellation_request.py` (hủy) |
| ODOO-TEST | `.../tests/test_edi.py` (JSON mẫu mong đợi) |
| NPM | `https://unpkg.com/viettel-s-invoice@1.0.10/README.md` và `lib/viettel-s-invoice.js`, `lib/interfaces/viettel-s-invoice.d.ts` (gói không chính thức, MIT) |

Bản đã tải: `/home/ubuntu/.claude/jobs/040a2c8b/tmp/sinvoice/` (`src/` là mã Odoo, `npm/package/` là gói npm). Nhánh 17.0 của Odoo không kiểm tra; module `viettel_s_invoice` trên apps.odoo.com không truy cập. Mô tả dưới đây chỉ là cấu trúc, không chép mã Python.

Không có trong nguồn: URL môi trường demo/thử nghiệm (v1 demo). Mã Odoo và gói npm chỉ dùng `https://api-vinvoice.viettel.vn`. Địa chỉ demo phải lấy từ tài liệu do Viettel cấp khi đăng ký tài khoản thử, ghi vào mục "Chờ người dùng" của `docs/TIEP-THEO.md`. Adapter phải cho cấu hình `baseUrl`.

## 1. URL gốc, xác thực, timeout

- Gốc đăng nhập: `https://api-vinvoice.viettel.vn/auth/login` (ODOO-AM `_l10n_vn_edi_get_access_token`: "uses another base address"; NPM `login()` cùng URL).
- Gốc nghiệp vụ: `https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/` (ODOO-AM hằng `SINVOICE_API_URL`); NPM nối `apiEndPoint` + `/services/einvoiceapplication/api/InvoiceAPI/...`.
- Đăng nhập: `POST /auth/login`, JSON `{"username": "...", "password": "..."}`. Username thường chính là mã số thuế bên bán: NPM dùng `username` làm `supplierTaxCode`; Odoo dùng `company.vat` làm `supplierTaxCode` và username riêng (hai giá trị có thể khác; adapter nên lưu riêng `username`, `password`, `supplierTaxCode`).
- Response đăng nhập (NPM `IViettelSInvoiceLoginResponse`): `access_token`, `token_type`, `refresh_token`, `expires_in` (giây), `scope`, `iat`, `invoice_cluster`, `type`, `jti`. Odoo chỉ dùng `access_token` và `expires_in`.
- Thời hạn token: Odoo ghi chú "valid for 5 minutes", nhưng không chặn cứng, nó đặt hạn = hiện tại + `expires_in` và dùng lại token đến khi hết hạn (cache trên bản ghi công ty). Adapter: cache token, trừ biên an toàn (ví dụ 30 giây), đăng nhập lại khi hết hạn hoặc khi gặp lỗi xác thực.
- Cách gửi token (hai cách đều có trong nguồn):
  - Odoo: cookie `access_token=<token>` (tham số `cookies={'access_token': ...}`).
  - NPM: header `Authorization: Bearer <token>`.
  Chưa rõ cả hai đều được chấp nhận ở mọi endpoint; ưu tiên Bearer, nếu bị từ chối thử cookie.
- Timeout: 60 giây (hằng `SINVOICE_TIMEOUT`, chú thích "They recommend between 60 and 90 seconds").
- Phát hiện lỗi (ODOO-AM `_l10n_vn_edi_send_request`): gọi, parse JSON; nếu JSON có khóa `code` hoặc `error` thì coi là lỗi, thông điệp lấy từ `data` hoặc `error`. Lỗi mạng (`RequestException`) hoặc body không phải JSON (`ValueError`) coi là lỗi tạm thời "thử lại sau". Odoo KHÔNG kiểm tra `errorCode` trong response nghiệp vụ; NPM trả nguyên `{errorCode, description, result}`. Adapter nên kiểm tra cả hai: HTTP không 2xx, `code`/`error` ở gốc, `errorCode` khác null/0 (giá trị thành công chính xác không có trong nguồn).

## 2. Endpoint

Tất cả là `POST`. Tiền tố `P` = `https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI`.

| Endpoint | Content-Type | Tham số | Nguồn |
|---|---|---|---|
| `POST /auth/login` | JSON | username, password | ODOO-AM, NPM |
| `P/InvoiceWS/createInvoice/{supplierTaxCode}` | JSON | thân hóa đơn (mục 3) | ODOO-AM `_l10n_vn_edi_send_invoice`; NPM `createInvoice` (dùng `{username}` ở path) |
| `P/InvoiceUtilsWS/createInvoiceDraftPreview/{username}` | JSON | thân hóa đơn | NPM `previewDraftInvoice`; trả `fileToBytes` (PDF base64), `fileName`, `paymentStatus` |
| `P/InvoiceWS/searchInvoiceByTransactionUuid` | form-urlencoded | `supplierTaxCode`, `transactionUuid` | ODOO-AM `_l10n_vn_edi_lookup_invoice`; NPM |
| `P/InvoiceUtilsWS/getInvoiceRepresentationFile` | JSON | `supplierTaxCode`, `templateCode`, `invoiceNo`, `fileType` (`PDF` hoặc `ZIP`) | ODOO-AM `_l10n_vn_edi_try_fetch_invoice_file_data`; NPM |
| `P/InvoiceWS/updatePaymentStatus` | form-urlencoded (tham số ở query/params) | `supplierTaxCode`, `invoiceNo`, `strIssueDate`, `templateCode` | ODOO-AM `action_l10n_vn_edi_update_payment_status` |
| `P/InvoiceWS/cancelPaymentStatus` | form-urlencoded | `supplierTaxCode`, `invoiceNo`, `strIssueDate` (không có `templateCode`) | cùng hàm |
| `P/InvoiceWS/cancelTransactionInvoice` | form-urlencoded | `supplierTaxCode`, `templateCode`, `invoiceNo`, `strIssueDate`, `additionalReferenceDesc`, `additionalReferenceDate`, `reasonDelete` | ODOO-AM `_l10n_vn_edi_cancel_invoice` |
| `P/InvoiceUtilsWS/getListInvoiceDataControl` | JSON | `supplierTaxCode`, `fromDate`, `toDate` (dd/MM/yyyy) | NPM `getInvoicesByDateRange` |
| `P/InvoiceUtilsWS/getInvoiceTemplates` | JSON | `taxCode`, `invoiceType` (ví dụ `01BLP`) | NPM `getInvoiceTemplates` |

Ghi chú:

- Với các endpoint form-urlencoded, Odoo truyền tham số qua `params` (query string) kèm header `Content-Type: application/x-www-form-urlencoded;`, body rỗng. NPM gửi `URLSearchParams` trong body. Không rõ máy chủ nhận cả hai; làm theo NPM (body form) hoặc Odoo (query) và thử khi có tài khoản.
- Định dạng ngày ở mọi tham số `str...Date`, `invoiceIssuedDate`, `originalInvoiceIssueDate`, `additionalReferenceDate`: số mili-giây kể từ epoch (Unix epoch giây x 1000, phần mili-giây luôn 000). Ví dụ `2024-01-01 00:00:00 UTC` thành `1704067200000` (ODOO-TEST). Không có ngày thì Odoo gửi `0`. Múi giờ: Odoo dùng `date.timestamp()` trên datetime không múi giờ (tức giờ máy chủ, tests chạy UTC). Adapter cần chốt múi giờ Việt Nam (UTC+7) khi tạo timestamp; nguồn không nói rõ, ghi vào rủi ro.
- Riêng `getListInvoiceDataControl` dùng chuỗi `dd/MM/yyyy`.

## 3. Cấu trúc JSON `createInvoice`

Nhóm gốc (NPM `IViettelSInvoice`): `generalInvoiceInfo`, `buyerInfo`, `sellerInfo`, `payments`, `deliveryInfo`, `itemInfo`, `discountItemInfo`, `summarizeInfo`, `taxBreakdowns`, `metadata`.

Odoo chỉ gửi: `generalInvoiceInfo`, `buyerInfo`, `sellerInfo`, `payments`, `itemInfo`, `taxBreakdowns`. Không gửi `summarizeInfo`: chú thích "We leave the summarized information computation to SInvoice". Nghĩa là SInvoice tự tính tổng từ `itemInfo`; adapter phải tự đối chiếu tổng của mình với tổng SInvoice trả/hiển thị (số tiền lệch do làm tròn sẽ gây khác biệt giữa sổ cái và hóa đơn). NPM cho phép gửi `summarizeInfo` (`sumOfTotalLineAmountWithoutTax`, `totalAmountWithoutTax`, `totalTaxAmount`, `totalAmountWithTax`, `totalAmountWithTaxInWords`). "Bắt buộc" dưới đây là: B = Odoo luôn gửi (coi là cần), K = Odoo gửi điều kiện, N = chỉ có trong NPM.

### 3.1 `generalInvoiceInfo`

| Trường | Kiểu | Ý nghĩa, giá trị |
|---|---|---|
| `transactionUuid` | chuỗi UUID v4 | B. Khóa chống trùng, Odoo sinh `uuid4()` một lần lúc tạo JSON. |
| `invoiceType` | chuỗi | B. Loại hóa đơn theo mẫu: `1` GTGT, `2` bán hàng, `3` bán tài sản công, `4` bán hàng dự trữ quốc gia, `5` hóa đơn bán hàng dự trữ quốc gia, `6` phiếu xuất kho (ODOO-SYM `template_invoice_type`). Odoo gửi giá trị này. Ví dụ NPM dùng `01BLP` ở `getInvoiceTemplates` (mã loại khác, kiểu mã cũ TT32). |
| `templateCode` | chuỗi | B. Mẫu số, ví dụ `1/001`. |
| `invoiceSeries` | chuỗi | B. Ký hiệu, ví dụ `K24TUT`. Cấu tạo: C hoặc K (có/không mã CQT), 2 số năm, 1 chữ (T, D, L, M, N, B, G, H), 2 ký tự tự đặt (ODOO-SYM). |
| `invoiceIssuedDate` | số (ms epoch) | B. Odoo đặt bằng thời điểm hiện tại lúc tạo JSON, comment: phải khớp thứ tự thời gian với dãy số của SInvoice, nên không dùng ngày chứng từ. Hệ quả cho adapter: hóa đơn gửi phải theo thứ tự thời gian tăng dần; ngày hóa đơn trên hệ thống khác ngày chứng từ kế toán. |
| `currencyCode` | chuỗi | B. `VND` hoặc mã ngoại tệ. |
| `exchangeRate` | chuỗi số | K. Chỉ khi ngoại tệ. Làm tròn 2 chữ số thập phân ("Sinvoice only allow upto 2 decimal place"), chuỗi định dạng đúng 2 chữ số, ví dụ `"0.50"`. Không gửi khi VND (mặc định 1). Hệ quả: tỷ giá hệ thống ta (NUMERIC(20,10)) làm tròn 2 số cho hóa đơn, có thể lệch so với tỷ giá sổ cái. |
| `adjustmentType` | chuỗi | B. `1` hóa đơn gốc, `3` thay thế, `5` điều chỉnh (xem mục 5). Giá trị `2` không có trong nguồn Odoo. |
| `paymentStatus` | boolean | B. `true` nếu chứng từ đã thanh toán (`in_payment` hoặc `paid`). |
| `cusGetInvoiceRight` | boolean | B. `true`: cho khách xem hóa đơn. |
| `validation` | số | B. `1`: SInvoice kiểm tra thông tin thuế khi xử lý (ví dụ mã số thuế người mua). |
| `invoiceNote` | chuỗi | N. Ghi chú hóa đơn. |
| `reservationCode` | chuỗi | N. Có trong kiểu NPM, mục đích không rõ. |
| Trường điều chỉnh/thay thế | | Xem mục 5. |

### 3.2 `buyerInfo`

| Trường | Ghi chú |
|---|---|
| `buyerName` | B. Tên người mua/người liên hệ (partner). |
| `buyerLegalName` | B. Tên đơn vị (partner thương mại). |
| `buyerTaxCode` | B. Rỗng `""` nếu không có. |
| `buyerAddressLine` | B. Địa chỉ ghép bằng dấu phẩy. |
| `buyerPhoneNumber` | B. Chỉ chữ số: `+` đổi thành `00`, bỏ ký tự khác (ODOO-AM `_l10n_vn_edi_format_phone_number`); rỗng nếu không có. |
| `buyerEmail` | B. Rỗng nếu không có. |
| `buyerCityName` | B. Thành phố, hoặc tên tỉnh nếu thiếu. |
| `buyerCountryCode` | B. ISO 2 ký tự (`VN`). |
| `buyerNotGetInvoice` | B. `0` gửi hóa đơn cho người mua; `1` không gửi. |
| `buyerBankName`, `buyerBankAccount` | K. Khi có tài khoản ngân hàng. |
| `buyerPostalCode`, `buyerDistrictName`, `buyerCode`, `buyerBirthDay` | N. |

### 3.3 `sellerInfo`

`sellerLegalName`, `sellerTaxCode` (ở Odoo là `company.vat`), `sellerAddressLine`, `sellerPhoneNumber` (chỉ chữ số), `sellerEmail`, `sellerDistrictName` (Odoo dùng tên tỉnh/thành), `sellerCountryCode`, `sellerWebsite`; có tài khoản: `sellerBankName`, `sellerBankAccount`; nếu tài khoản dạng merchant: `merchantCode`, `merchantName`, `merchantCity` (cho mã QR). NPM thêm `sellerFaxNumber`. Odoo bắt buộc công ty có đường, tỉnh, quốc gia, MST (`_l10n_vn_edi_check_invoice_configuration`).

### 3.4 `payments`

Mảng. Odoo luôn gửi `[{"paymentMethodName": "TM/CK"}]` (chú thích: chưa biết hình thức thanh toán thì ghi TM/CK; chú thích Odoo lẫn TM/CK, thực tế TM = tiền mặt, CK = chuyển khoản). NPM kiểu có thêm `paymentMethod` (mã). Các mã khác (ví dụ `1`, `2`, `3`) không có trong nguồn.

### 3.5 `itemInfo`

Mỗi dòng (ODOO-AM `_l10n_vn_edi_add_item_information`):

| Trường | Ý nghĩa |
|---|---|
| `selection` | Loại dòng: `1` hàng hóa/dịch vụ, `2` ghi chú, `3` chiết khấu (kể cả dòng thanh toán trước/tiền đặt cọc). |
| `itemCode` | Mã hàng, `""` nếu không có. |
| `itemName` | Tên, xuống dòng đổi thành khoảng trắng, cắt tối đa 500 ký tự (thêm `...`). |
| `unitName` | Đơn vị tính; mặc định `"Units"` nếu thiếu (adapter nên dùng tên tiếng Việt). |
| `unitPrice` | Đơn giá. Với hóa đơn điều chỉnh (credit note): nhân -1. |
| `quantity` | Số lượng. |
| `itemTotalAmountWithoutTax` | Thành tiền chưa trừ chiết khấu, chưa thuế = đơn giá x số lượng (dùng giá gốc, không dấu đổi theo loại chứng từ). |
| `taxPercentage` | Thuế suất, mục 6. |
| `taxAmount` | Tiền thuế dòng = tổng có thuế - tổng chưa thuế, làm tròn theo tiền tệ. |
| `discount` | Tỷ lệ chiết khấu %. NPM dùng tên `itemDiscount`; Odoo dùng `discount`. Chưa rõ tên nào đúng, kiểm khi có tài khoản thử (có thể máy chủ chấp nhận cả hai). |
| `itemTotalAmountAfterDiscount` | Thành tiền sau chiết khấu, chưa thuế. |
| `itemTotalAmountWithTax` | Thành tiền có thuế. |
| `isIncreaseItem` | `false` đánh dấu dòng giảm: có ở dòng chiết khấu và mọi dòng của hóa đơn điều chỉnh. NPM kiểu `boolean | null`. Odoo chỉ đặt `false`, không bao giờ đặt `true`; ngữ nghĩa điều chỉnh tăng không có trong nguồn (xem mục 5). |
| `adjustmentTaxAmount` | Chỉ hóa đơn điều chỉnh: bằng `taxAmount`. |
| `lineNumber` | N. Số thứ tự dòng. |

Dòng chiết khấu/đặt cọc: `selection=3`, `isIncreaseItem=false`, và `unitPrice`, `quantity`, `itemTotalAmountWithoutTax`, `itemTotalAmountAfterDiscount`, `itemTotalAmountWithTax` lấy giá trị tuyệt đối (ODOO-TEST: `unitPrice` không âm). Dòng ghi chú (`selection=2`): chỉ gửi `selection` và `itemName`.

NPM còn có `discountItemInfo` (mảng) và `summarizeInfo` mà Odoo không dùng.

### 3.6 `taxBreakdowns`

Mảng, một phần tử cho mỗi thuế suất (ODOO-AM `_l10n_vn_edi_add_tax_breakdowns`): `taxPercentage`, `taxableAmount` (tổng cơ sở tính thuế), `taxAmount`, `taxableAmountPos`, `taxAmountPos` (boolean: `true` với hóa đơn thường; `false` với hóa đơn điều chỉnh để coi số tiền là âm). Lấy theo tiền tệ chứng từ. Thuế suất không thuế dùng `-2`.

### 3.7 Còn lại

- `metadata` (N): mảng `{keyTag, stringValue, valueType, keyLabel}`, trường mở rộng tùy mẫu. Ý nghĩa `valueType` không có trong nguồn.
- `deliveryInfo` (N): đối tượng rỗng trong kiểu NPM; không rõ trường.
- `summarizeInfo` (N): xem đầu mục 3.

### 3.8 JSON mẫu rút gọn (Odoo test, hóa đơn thường VND)

```json
{"generalInvoiceInfo":{"transactionUuid":"<uuid4>","invoiceType":"1","templateCode":"1/001","invoiceSeries":"K24TUT","invoiceIssuedDate":1704067200000,"currencyCode":"VND","adjustmentType":"1","paymentStatus":false,"cusGetInvoiceRight":true,"validation":1},
 "payments":[{"paymentMethodName":"TM/CK"}],
 "itemInfo":[{"itemCode":"BN/1035","itemName":"product_a","unitName":"Units","unitPrice":1000.0,"quantity":1.0,"itemTotalAmountWithoutTax":1000.0,"taxPercentage":10.0,"taxAmount":100.0,"discount":0.0,"itemTotalAmountAfterDiscount":1000.0,"itemTotalAmountWithTax":1100.0,"selection":1}],
 "taxBreakdowns":[{"taxPercentage":10.0,"taxableAmount":1000.0,"taxAmount":100.0,"taxableAmountPos":true,"taxAmountPos":true}]}
```
(buyerInfo, sellerInfo lược bớt.) Nguồn: ODOO-TEST `test_json_data_generation`.

## 4. Response

### 4.1 `createInvoice` (NPM `IViettelSInvoiceResponse`, ODOO-AM)

```json
{"errorCode": null, "description": null,
 "result": {"supplierTaxCode":"...","invoiceNo":"K24TUT01","transactionID":"...","reservationCode":"123456","codeOfTax":"..."}}
```
- `result.invoiceNo`: số hóa đơn đầy đủ, gồm ký hiệu (ví dụ `K24TUT01`, ODOO-TEST; placeholder tên file `{MST}-{ký hiệu}101`). Dùng làm `invoiceNo` ở mọi lệnh sau.
- `result.reservationCode`: mã tra cứu của người mua.
- `result.codeOfTax`: mã của cơ quan thuế (hóa đơn có mã, ký hiệu bắt đầu `C`); Odoo không lưu.
- `result.transactionID`: Odoo không dùng.
- Odoo chỉ đọc `result.reservationCode` và `result.invoiceNo`; không kiểm `errorCode`.

### 4.2 `searchInvoiceByTransactionUuid`

`{"transactionUuid", "errorCode", "description", "result":[{"supplierTaxCode","invoiceNo","reservationCode","issueDate","status", ...}]}`.
- `result` là mảng; Odoo lấy `result[0]`.
- `status` là chuỗi tiếng Việt; Odoo so sánh `"Chưa thanh toán"` (chưa thanh toán), mọi giá trị khác coi là đã thanh toán.
- `issueDate` ms epoch.
- Odoo cũng đọc `exchangeStatus`; giá trị `INVOICE_HAS_CODE_APPROVED` nghĩa là CQT đã chấp nhận mã (ODOO-REV). NPM kiểu danh sách lại ghi `exchangeStatus` là số; hai nguồn không khớp, phải kiểm thử thực tế.
- Khi không có hóa đơn: Odoo kiểm bằng `'result' in response`; nếu khóa `result` không có thì coi như chưa tạo. Ghi chú Odoo: gọi cập nhật trạng thái thanh toán khi đã khớp bên SInvoice trả lỗi `NOT_FOUND_DATA`, nên phải tra trước.

### 4.3 `getInvoiceRepresentationFile`

`{"errorCode", "description", "fileToBytes": "<base64>", "fileName": "...", "paymentStatus": bool}`.
- `fileType=PDF`: `fileToBytes` là PDF base64; `fileName` dùng làm tên file.
- `fileType=ZIP`: base64 của ZIP chứa file `.xml` (và có thể file `.xsl`); đôi khi ZIP lồng ZIP (gói ngoài chứa gói trong chứa XML). Odoo duyệt gói ngoài tìm `*.xml`, nếu không có thì mở từng `*.zip` bên trong tìm tiếp (ODOO-AM `_l10n_vn_edi_fetch_invoice_xml_file_data`; ODOO-TEST có ca zip đơn, zip kép, không có XML).
- Đôi khi `fileToBytes` rỗng ngay sau khi tạo (file chưa sẵn sàng): Odoo thử tối đa 3 lần, nghỉ `0.125 x lần` giây. Adapter nên chờ dài hơn và thử lại không đồng bộ qua pg-boss.

### 4.4 Mã lỗi

Nguồn công khai KHÔNG liệt kê bảng mã lỗi. Chỉ thấy: `NOT_FOUND_DATA` (cập nhật/hủy trạng thái thanh toán khi trạng thái đã khớp; ODOO-AM comment trong `action_l10n_vn_edi_update_payment_status`), và cấu trúc `errorCode`/`description` ở response nghiệp vụ, hoặc `code`/`error`/`data` ở gốc khi lỗi nền tảng (đăng nhập sai, token hết hạn...). Phải thu thập bảng mã lỗi từ tài liệu Viettel cấp.

## 5. Luồng nghiệp vụ

### 5.1 Tạo hóa đơn và chống trùng

1. Tạo JSON một lần, sinh `transactionUuid` (UUID v4) và lưu cùng JSON lên chứng từ (Odoo lưu JSON thành tệp đính kèm; lần gửi sau dùng lại JSON cũ, không sinh lại).
2. Trước khi gọi `createInvoice` lần đầu, Odoo đặt `l10n_vn_edi_invoice_transaction_id` từ `transactionUuid` trong JSON. Nghĩa là: có `transaction_id` trên chứng từ mà chưa có `invoiceNo` = đã từng thử gửi (có thể thành công mà ta không nhận được trả lời).
3. Lần gửi lại (đã có `transaction_id`): gọi `searchInvoiceByTransactionUuid` trước; nếu có `result` thì ghi `invoiceNo`, `reservationCode` rồi chuyển `sent`, KHÔNG gọi `createInvoice` nữa. Nếu không có thì gọi `createInvoice` với đúng JSON cũ (cùng `transactionUuid`). Lỗi của lần tra này bị bỏ qua có chủ ý.
4. Khóa dòng bản ghi (Odoo `_with_locked_records`) trước khi gửi để tránh hai tiến trình gửi cùng lúc; commit ngay khi ghi `invoiceNo`.
5. Hạn chế: SInvoice có thể từ chối `transactionUuid` trùng ở `createInvoice` (hành vi cụ thể không có trong nguồn); đây là lý do Odoo tra trước.

### 5.2 Trạng thái (`l10n_vn_edi_invoice_state`)

Giá trị: `ready_to_send`, `sent`, `payment_state_to_update`, `canceled`, `adjusted`, `replaced`. Máy trạng thái trong Odoo:
- Ghi sổ hóa đơn bán (quốc gia VN, chưa gửi) thành `ready_to_send`.
- Gửi thành công thành `sent`.
- Khi `payment_state` của chứng từ đổi mà trạng thái đang `sent` thành `payment_state_to_update` (đơn giản, có thể đặt thừa); chạy `action_l10n_vn_edi_update_payment_status` đưa về `sent`.
- Hủy thành công thành `canceled`.
- Điều chỉnh: hóa đơn gốc thành `adjusted`; thay thế: thành `replaced` (ghi lúc bấm lập chứng từ đảo, trước khi hóa đơn mới được gửi; ODOO-REV `reverse_moves`).
- "Đã gửi" tức một trong `sent`, `payment_state_to_update`, `canceled`, `adjusted`, `replaced`.
- Chứng từ đã gửi không được đặt về nháp; chỉ khi đã `canceled` và chứng từ `cancel` mới được `button_draft`, và lúc đó xóa `transaction_id`, `invoiceNo`, `reservationCode`, `issue_date`, state và tệp đính kèm để gửi lại như mới (lưu ý với ta: hóa đơn đã hủy có số đã dùng trên hệ thống thuế, gửi lại phải ra số mới).
- Sổ cái ta có máy trạng thái riêng draft/posted/reversed/cancelled; trạng thái HĐĐT nên là cột riêng, không trộn.

### 5.3 Lấy số hóa đơn, tệp

Số hóa đơn (`invoiceNo`), mã tra cứu (`reservationCode`) lấy từ response `createInvoice` (hoặc từ tra theo `transactionUuid` khi phục hồi). Sau khi `sent`, gọi `getInvoiceRepresentationFile` (PDF và ZIP) với `supplierTaxCode`, `templateCode`, `invoiceNo`; lưu PDF, XML. Cần `templateCode` và `invoiceNo` đã lưu.

### 5.4 Trạng thái thanh toán

Quy trình: tra theo `transactionUuid` lấy `status`; nếu chứng từ đã thanh toán mà SInvoice còn "Chưa thanh toán" thì gọi `updatePaymentStatus` (kèm `templateCode`); nếu chứng từ chưa thanh toán mà SInvoice đã thanh toán thì `cancelPaymentStatus` (không `templateCode`); còn lại bỏ qua. Mọi thành công đưa trạng thái về `sent`. Đây là cờ hiển thị trên hóa đơn, không ảnh hưởng hiệu lực pháp lý.

### 5.5 Hủy hóa đơn

`cancelTransactionInvoice` với `reasonDelete` (lý do), `additionalReferenceDesc` (tên văn bản thỏa thuận; mặc định `"NA"`), `additionalReferenceDate` (ngày văn bản; mặc định hiện tại), cùng `templateCode`, `invoiceNo`, `strIssueDate` (ngày phát hành hóa đơn gốc, ms epoch). Thành công thì state `canceled`; sau đó Odoo thử hủy chứng từ kế toán, nếu bị khóa kỳ thì chỉ ghi chú lỗi ở chatter (đã hủy bên SInvoice mà sổ chưa hủy). Adapter của ta: hủy HĐĐT và đảo bút toán là hai bước tách bạch, phải xử lý trường hợp một bước thất bại.

### 5.6 Điều chỉnh (credit note)

Chứng từ `out_refund` liên kết hóa đơn đã gửi; JSON `generalInvoiceInfo` có thêm:

| Trường | Giá trị |
|---|---|
| `adjustmentType` | `"5"` |
| `adjustmentInvoiceType` | `"1"` điều chỉnh tiền, `"2"` điều chỉnh thông tin (ODOO-REV, trường chọn). |
| `originalInvoiceId` | `invoiceNo` của hóa đơn gốc |
| `originalInvoiceIssueDate` | ngày phát hành hóa đơn gốc (ms epoch) |
| `originalTemplateCode` | `templateCode` của hóa đơn gốc |
| `additionalReferenceDesc` | tên văn bản thỏa thuận (mặc định `NA`) |
| `additionalReferenceDate` | ngày văn bản (mặc định hiện tại) |

Dòng `itemInfo` của hóa đơn điều chỉnh (ODOO-TEST `test_adjustment_invoice`): `unitPrice` âm (nhân -1), `itemTotalAmountWithoutTax` dương (tính từ giá gốc của chứng từ), `taxAmount` dương, `adjustmentTaxAmount` = `taxAmount`, `isIncreaseItem=false`; `taxBreakdowns` có `taxableAmountPos=false`, `taxAmountPos=false`. Chỉ hỗ trợ điều chỉnh giảm; điều chỉnh tăng (`isIncreaseItem=true`) không có trong Odoo. Với `adjustmentInvoiceType=2` (điều chỉnh thông tin) cách điền dòng không có trong nguồn. Điều kiện chặn: ký hiệu bắt đầu `C` (hóa đơn có mã) mà `exchangeStatus` khác `INVOICE_HAS_CODE_APPROVED` thì không được điều chỉnh/thay thế, phải hủy và lập mới (ODOO-REV). Chưa chắc giá trị đó khớp trường kiểu số trong NPM.

### 5.7 Thay thế

Hóa đơn mới (chứng từ gốc đã `sent`) mang `adjustmentType="3"` với cùng nhóm trường `originalInvoiceId`, `originalInvoiceIssueDate`, `originalTemplateCode`, `additionalReferenceDesc/Date`, `adjustmentInvoiceType`; nội dung dòng là giá trị đúng mới (dương, `unitPrice` 900 thay vì 1000 trong test), không có `isIncreaseItem`/`adjustmentTaxAmount`. Hóa đơn gốc đặt `replaced`. Hóa đơn gốc của thay thế không bị hủy riêng; việc "hủy" gốc do thay thế (theo NĐ 123 và TT 78) không cần gọi `cancelTransactionInvoice` theo cách Odoo làm (Odoo không gọi).

## 6. Thuế suất, làm tròn, ngoại tệ

- `taxPercentage` (ODOO-AM chú thích): `-2` không chịu thuế (không kê khai, không tính thuế), `-1` không kê khai nộp thuế, `0`, `5`, `8`, `10` là phần trăm. Odoo hỗ trợ `-2` (khi dòng không có thuế) và phần trăm. Mỗi dòng Việt Nam chỉ một thuế (lấy thuế đầu). Mã `KCT` / `KKKNT` kiểu chữ không có trong nguồn. Ý nghĩa chính xác của `-1` và `-2` theo nguồn: chú thích Odoo nêu hai giá trị này theo thứ tự đó; kiểm đối chiếu với văn bản TT 78 khi ánh xạ.
- Làm tròn: tiền tệ chứng từ làm tròn theo quy tắc tiền tệ (`currency.round`); `taxAmount` dòng `100.03` cho gốc 1000.25 x 10% (ODOO-TEST `test_decimal_rounding`, ngoại tệ 2 chữ số). `taxBreakdowns` lấy tổng không làm tròn riêng. Làm tròn VND: nguồn không nói; ta dùng số nguyên theo NUMERIC(20,0).
- Ngoại tệ: `currencyCode` + `exchangeRate` (2 chữ số, ngoại tệ sang VND). Mọi số tiền trong JSON theo tiền tệ chứng từ, không phải VND. Odoo chặn gửi nếu VND chưa bật hoặc tỷ giá chưa đặt.
- Hình thức thanh toán: chỉ `TM/CK`.

## 7. Lỗi mạng, timeout, tính idempotent (Odoo)

- Mọi lỗi mạng/timeout/body không phải JSON trả về thông điệp lỗi "Something went wrong, please try again later"; không retry tự động, người dùng gửi lại.
- Quy ước chống trùng dựa hoàn toàn vào `transactionUuid` đã lưu + tra cứu trước khi tạo lại (mục 5.1). Vì `transaction_id` được lưu trước khi gọi, timeout giữa chừng không làm mất khóa.
- Không tìm thấy quy tắc riêng cho HTTP 5xx, giới hạn tần suất (rate limit), hay thử lại có trễ lũy thừa.
- Cập nhật trạng thái thanh toán tra trước vì thông điệp `NOT_FOUND_DATA` không phân biệt được "đã khớp" với "không tìm thấy".
- Thao tác lấy tệp: thử lại 3 lần vì tệp chưa sẵn sàng.
- Lỗi tạo tệp tại bước kiểm cấu hình (`_l10n_vn_edi_check_invoice_configuration`): thiếu thông tin đăng nhập, MST, SĐT chứa ký tự lạ, thiếu ký hiệu/mẫu, credit note không liên kết hóa đơn đã gửi, công ty thiếu đường/tỉnh/quốc gia, ngoại tệ thiếu tỷ giá. Danh sách này hữu ích làm kiểm tra trước khi gửi.

## 8. Không có trong nguồn công khai

- URL môi trường demo/thử nghiệm của SInvoice (v1) và khác biệt với bản `api-vinvoice`.
- Bảng mã lỗi chính thức; giá trị thành công của `errorCode`.
- Thông báo sai sót mẫu 04/SS (TT 78) và cách gửi: không có endpoint nào cho việc này.
- Ký số bằng USB token / HSM qua hash (quy trình ký số phía người bán, `createInvoice` kiểu ký ngoài, trả hash). Odoo và NPM chỉ dùng chế độ SInvoice tự ký (ký tập trung trên máy chủ Viettel).
- Hóa đơn khởi tạo từ máy tính tiền (mã CQT cấp theo từng lần) ngoài cờ ký hiệu `C`/`K`; quy trình xin mã, trạng thái "đã được CQT chấp nhận", mã `codeOfTax` dùng thế nào.
- Gửi hóa đơn cho khách qua email phía SInvoice (chỉ có cờ `buyerNotGetInvoice`, `cusGetInvoiceRight`).
- Điều chỉnh tăng, điều chỉnh thông tin thuần, điều chỉnh nhiều lần, thay thế nhiều lần cho cùng hóa đơn.
- Cấp phát dải số, kiểm tra thứ tự số, tra cứu phát hành mẫu (ngoài `getInvoiceTemplates` của NPM, response mẫu: `template[]` gồm `templateCode`, `invoiceSeri`, `originalTemplateCode`, `taxPolicy`).
- Webhook, đồng bộ trạng thái phía CQT; chỉ có kiểu NPM `getListInvoiceDataControl` trả `invoices[]` với `state`, `stateCode`, `exchangeStatus`, `paymentStatus`, ... (không có nghĩa từng giá trị).
- Hạn mức tần suất gọi, giới hạn kích thước, số dòng tối đa của một hóa đơn.
- Hóa đơn hàng loạt (batch): Odoo chú thích về batch nhưng chỉ gửi từng hóa đơn.
- Tên trường chính xác của tỷ lệ chiết khấu dòng (`discount` hay `itemDiscount`) và cách `summarizeInfo` được kiểm khi gửi.
