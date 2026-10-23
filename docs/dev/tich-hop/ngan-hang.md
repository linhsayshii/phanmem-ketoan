# Tích hợp ngân hàng: SePay, Casso, VietQR, tra cứu MST, SmartCA

Khảo cứu tài liệu công khai, tải ngày 2026-10-23. Chỉ ghi điều đã đọc trong nguồn; điều không xác nhận được ghi rõ. Bản tải thô nằm ngoài repo (`/home/ubuntu/.claude/jobs/040a2c8b/tmp/bank/`), không đưa vào repo.

## 1. SePay webhook

Nguồn: https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook.md , https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc.md , https://developer.sepay.vn/vi/sepay-webhooks/bao-mat.md , https://developer.sepay.vn/vi/sepay-webhooks/xu-ly-loi.md , https://developer.sepay.vn/vi/sepay-webhooks/lap-trinh-webhooks/lap-trinh-webhook-nodejs.md , https://docs.sepay.vn/tich-hop-webhooks.html

### Payload (HTTP POST, mặc định `application/json`; có thể cấu hình `multipart/form-data` hoặc `application/x-www-form-urlencoded`)

```json
{"id":92704,"gateway":"Vietcombank","transactionDate":"2024-07-02 11:08:33","accountNumber":"1017588888","subAccount":"","code":"SEVN63DC8E5C","content":"SEVN63DC8E5C chuyen tien","transferType":"in","description":"NGUYEN VAN A chuyen tien","transferAmount":5000000,"accumulated":105000000,"referenceCode":"FT24012345678"}
```

| Trường | Kiểu | Null/rỗng | Ghi chú |
|---|---|---|---|
| `id` | integer | không | ID giao dịch SePay, không đổi qua retry/replay: khóa chống trùng |
| `gateway` | string | không | tên ngân hàng (Vietcombank, BIDV...) |
| `transactionDate` | string | không | `YYYY-MM-DD HH:mm:ss`, giờ Việt Nam |
| `accountNumber` | string | không | số tài khoản |
| `subAccount` | string | có thể `""` | tài khoản ảo (VA) khớp giao dịch |
| `code` | string | có thể `null` | mã thanh toán trích từ nội dung theo tiền tố cấu hình; `null` khi không khớp |
| `content` | string | không | nội dung chuyển khoản gốc |
| `transferType` | string | không | `in` hoặc `out` |
| `description` | string | có thể `""` | mô tả từ ngân hàng |
| `transferAmount` | integer | không | VND, luôn dương |
| `accumulated` | integer | có thể `0` | số dư sau giao dịch; `0` nếu ngân hàng không hỗ trợ |
| `referenceCode` | string | có thể `""` | mã tham chiếu ngân hàng |

Lưu ý: ở webhook, tiền là số nguyên JSON; ở REST API `my.sepay.vn/userapi` tiền là chuỗi "19689000.00" (xem ghi chú nghiên cứu).

### Xác thực (4 kiểu: không, API Key, HMAC-SHA256, OAuth 2.0)

- **API Key**: header `Authorization: Apikey YOUR_API_KEY`; server so với giá trị cấu hình. Chỉ xác minh nguồn, không bảo vệ toàn vẹn payload.
- **HMAC-SHA256 (khuyến nghị)**. Hai header:
  - `X-SePay-Signature: sha256={hex_hash}` (hex, tiền tố `sha256=`)
  - `X-SePay-Timestamp: {unix_seconds}`
  - Chuỗi ký: `{timestamp}.{raw_body}` (timestamp, dấu chấm, thân thô nguyên bytes). Khóa: Secret Key cấu hình khi tạo webhook. Với form-encoded thì ký chuỗi form-encoded thô.
  - Phải dùng raw body (Fastify cần đọc body thô trước khi parse; không `JSON.stringify` lại).
  - Chống replay: từ chối nếu `|now - timestamp| > 300` giây (mẫu Node.js và trang bảo mật).
  - Trang tài liệu không in phép so; mẫu Node dùng so chuỗi sau khi tính lại. Nên dùng `crypto.timingSafeEqual` (khuyến nghị của ta, không phải của SePay).
- **OAuth 2.0**: SePay gọi token endpoint của ta (client_credentials, form `grant_type`, `client_id`, `client_secret`; hoặc dạng JSON tùy chỉnh `clientId/clientSecret`), rồi gửi `Authorization: Bearer {access_token}`. Token endpoint phải HTTPS.
- Danh sách IP nguồn (whitelist, tài liệu docs.sepay.vn): IPv4 172.236.138.20, 172.233.83.68, 171.244.35.2, 151.158.108.68, 151.158.109.79, 103.255.238.139, 45.57.137.67; IPv6 2400:8905::2000:8cff:fe98:45cd, 2600:3c15::2000:8aff:fedd:874b. Danh sách có thể đổi: kiểm tra lại khi triển khai.

### Phản hồi và gửi lại

- Thành công khi đủ ba điều: HTTP 200 hoặc 201, body JSON đúng `{"success": true}`, xong trong 30 giây (connect timeout 5 giây). Mọi thứ khác (202, redirect, 4xx, 5xx, body khác) là thất bại.
- Khuyến nghị của SePay: trả 200 ngay, xử lý nền.
- Retry Fibonacci: 8 lần gửi (1 đầu + 7 retry) trong khoảng 33 phút (chờ 1,1,2,3,5,8,13 phút); sau đó đánh dấu Failed. Lưu ý: docs.sepay.vn ghi "tối đa 7 lần, 5 giờ", trang developer ghi 33 phút: hai trang không khớp, theo trang developer (mới hơn); webhook mất nếu endpoint sập quá thời gian đó nên cần cron đối soát qua REST API 15-30 phút/lần (trang `bao-mat`).
- Idempotent: khóa `id` (UNIQUE). Cùng giao dịch có thể đến nhiều lần do retry, replay thủ công (kể cả log đã thành công) và nhiều webhook cùng URL.

## 2. Casso webhook

Nguồn: https://developer.casso.vn/webhook/thiet-lap-webhook-thu-cong.md , https://developer.casso.vn/webhook/gia-lap-giao-dich-den.md , https://developer.casso.vn/english-v2-new/webhook/thiet-lap-webhook-thu-cong.md , mã mẫu https://github.com/CassoHQ/casso-webhook-v2-verify-signature (đọc qua trình tóm tắt, không có giấy phép đọc được).

Casso có hai loại: Webhook (cũ) và **Webhook V2** (được khuyến nghị, có chữ ký).

### Webhook V2 payload (một giao dịch/lần, `data` là object)

```json
{"error":0,"data":{"id":0,"reference":"MA_GIAO_DICH_THU_NGHIEM","description":"giao dich thu nghiem","amount":599000,"runningBalance":25000000,"transactionDateTime":"2025-02-12 15:36:21","accountNumber":"88888888","bankName":"VPBank","bankAbbreviation":"VPB","virtualAccountNumber":"","virtualAccountName":"","counterAccountName":"NGUYEN VAN A","counterAccountNumber":"8888888888","counterAccountBankId":"970415","counterAccountBankName":"VietinBank"}}
```

Kiểu: `id` số (ID Casso, khóa chống trùng), `amount`/`runningBalance` số nguyên, còn lại chuỗi. Không thấy tài liệu nói âm/dương cho tiền ra (cần kiểm tra bằng giao dịch thật).

### Webhook cũ (v1)

`{"error":0,"data":[{"id":6785,"tid":"BANK_REF_ID","description":"...","amount":79000,"cusum_balance":20079000,"when":"2020-10-14 00:34:57","bank_sub_acc_id":"123456789","subAccId":"123456789","bankName":"VPBank","bankAbbreviation":"VPB","virtualAccount":"","virtualAccountName":"","corresponsiveName":"","corresponsiveAccount":"","corresponsiveBankId":"","corresponsiveBankName":""}]}` (mảng, luôn 1 phần tử khi có giao dịch mới). Xác thực: header **`secure-token`** chứa "Key bảo mật" cấu hình (so bằng nhau; mẫu NodeJS của Casso so `req.header('secure-token') != secure_token`).

### Chữ ký V2 (header `X-Casso-Signature`)

Định dạng: `t=<unix_ms>,v1=<hex>`; ví dụ tài liệu `t=1727948258788,v1=ed0a4bd2...b7ff3` (128 hex ký tự = SHA-512). Cách tính theo mã mẫu JS/Python của Casso:
1. Parse `t` (mili giây) và `v1` bằng regex `t=(\d+),v1=([a-f0-9]+)`.
2. Sắp xếp khóa **đệ quy A-Z** của **toàn bộ body** (gồm `error` và `data`).
3. `message = t + "." + JSON.stringify(sorted)` (JSON gọn, không khoảng trắng; Python dùng `separators=(',',':')`, `ensure_ascii` mặc định tức escape `\uXXXX`, JS không escape: chênh lệch với tiếng Việt có dấu cần thử thật).
4. `HMAC-SHA512(key = Key bảo mật của Webhook V2, message)` dạng hex thường; so với `v1`.
5. Mã mẫu không kiểm tra độ lệch `t`; ta nên tự đặt dung sai (đề xuất 5 phút) và so bằng `timingSafeEqual`.

Chưa xác minh: chưa có khóa mẫu để chạy lại ví dụ trong tài liệu, nên khẳng định "ký toàn body đã sắp xếp" dựa trên mã mẫu, chưa kiểm bằng chữ ký thật. Vì ký lại từ JSON đã parse, không cần raw body (khác SePay).

### Phản hồi, gửi lại, trùng

- Trả HTTP 200 trong 5 giây (timeout 5 giây). "Strict mode" tùy chọn: kiểm thêm JSON `success: 1` hoặc `true`, 0/false là thất bại. Nên trả `{"success":true}`.
- URL: HTTPS công khai; whitelist IP Casso nếu có Cloudflare/chống DDoS.
- Thất bại: gọi lại trong 12 giờ (bản tiếng Việt ghi 24 giờ; bản tiếng Anh ghi 12 giờ: không khớp), lần đầu sau 1 phút, giãn theo Fibonacci, tối đa 17 lần, rồi FAIL. Liên tục thất bại 24 giờ: cấu hình PAUSED, giao dịch mới ở HOLDING (replay được); PAUSED 7 ngày: DISABLE, không replay được.
- Chống trùng theo `id`. Khuyến nghị đối soát bằng REST API (API Key hoặc OAuth2) để bù giao dịch sót.

## 3. VietQR (NAPAS, EMVCo)

Đặc tả NAPAS chính thức không công khai (ghi nhận trong research_notes). Cấu trúc dưới đây lấy từ thư viện mở **vietnam-qr-pay** (xuannghia), giấy phép **MIT** (kiểm bằng GitHub API `spdx_id: MIT`, file LICENSE "Copyright (c) xuannghia"): https://github.com/xuannghia/vietnam-qr-pay (README, `src/crc16.ts`, `src/constants/qr-pay.ts`). Đối chiếu thêm: https://github.com/Cat1m/emv_qr_builder (MIT, test chứa tiền tố `00020101021138580010A0000007270128000697041501141133666688880208QRIBFTTA53037045802VN...`), https://pub.dev/packages/vietqr_core (MIT).

Định dạng TLV: `ID(2) + LEN(2 chữ số thập phân) + VALUE`.

| Tag | Nội dung |
|---|---|
| 00 | `01` phiên bản payload |
| 01 | `11` QR tĩnh, `12` QR động (thư viện đặt 12 khi có số tiền) |
| 38 | Merchant Account Information (VietQR). Sub-tag: `00` = GUID `A000000727` (NAPAS); `01` = thông tin thụ hưởng, lồng: `00` = BIN ngân hàng 6 số, `01` = số tài khoản (hoặc số thẻ); `02` = dịch vụ `QRIBFTTA` (chuyển nhanh tới tài khoản) hoặc `QRIBFTTC` (tới thẻ) |
| 52 | MCC (tùy chọn, không có trong các vector) |
| 53 | `704` tiền tệ VND |
| 54 | số tiền (chỉ QR động), chuỗi số không dấu phân cách |
| 58 | `VN` |
| 59, 60 | tên merchant, thành phố (tùy chọn, không có trong vector) |
| 62 | Additional Data. Sub-tag `08` = nội dung chuyển khoản (purpose); còn `01` bill, `05` reference label... |
| 63 | CRC, luôn cuối, `6304` + 4 hex hoa |

Ghi chú: tag 38 GUID `A000000727` là NAPAS; ví dụ khác trong README dùng tag 26 với GUID `A000000775` (QR VNPay/CellphoneS), không phải VietQR chuyển khoản. Nội dung nên là ASCII không dấu; độ dài tính theo ký tự, CRC tính theo byte UTF-8 (thư viện dùng `stringToUint8Array`; với nội dung có dấu cần kiểm thêm, nên ép về ASCII).

### CRC-16/CCITT-FALSE

Đa thức 0x1021, khởi tạo 0xFFFF, không đảo bit, xorout 0. Tính trên toàn chuỗi gồm cả `6304` (không gồm 4 hex CRC). Kiểm chuẩn: `"123456789"` cho `29B1`. Thư viện dùng bảng tra 256 mục của node-crc (MIT); ta tự cài bằng vòng lặp bit (xem script).

### Vector kiểm thử (đã tự kiểm CRC)

Nguồn: README vietnam-qr-pay (MIT). BIN 970416 = ACB. Script: `/home/ubuntu/.claude/jobs/040a2c8b/tmp/bank/crc.mjs`; kết quả chạy: cả 6 chuỗi `OK`, và `crc("123456789") = 29B1`.

| # | Đầu vào | Payload đầy đủ | CRC |
|---|---|---|---|
| 1 | tĩnh; BIN 970416; TK 257678859; không số tiền, không nội dung | `00020101021138530010A0000007270123000697041601092576788590208QRIBFTTA53037045802VN6304AE9F` | AE9F, khớp |
| 2 | động; BIN 970416; TK 257678859; số tiền 10000; nội dung `Chuyen tien` | `00020101021238530010A0000007270123000697041601092576788590208QRIBFTTA53037045405100005802VN62150811Chuyen tien630453E6` | 53E6, khớp |
| 3 | như 2 nhưng số tiền 999999; nội dung `Cam on nhe` | `00020101021238530010A0000007270123000697041601092576788590208QRIBFTTA530370454069999995802VN62140810Cam on nhe6304E786` | E786, khớp |
| 4 | như 2 nhưng số tiền 1000 (chuỗi trong ví dụ parse của README; chú thích README ghi 10000 là sai) | `00020101021238530010A0000007270123000697041601092576788590208QRIBFTTA5303704540410005802VN62150811Chuyen tien6304BBB8` | BBB8, khớp |
| 5 | QR MoMo qua BVBank: BIN 970454; TK `99MM24011M34875080` | `00020101021138620010A00000072701320006970454011899MM24011M348750800208QRIBFTTA53037045802VN62190515MOMOW2W3487508080030466304EBC8` | EBC8, khớp |

Giải mã mẫu 2: `000201` | `010212` | `3853`[`0010A000000727` `0123`[`00 06 970416` + `01 09 257678859`] `0208QRIBFTTA`] | `5303704` | `540510000` (54,05,"10000") | `5802VN` | `6215`[`0811Chuyen tien`] | `6304 53E6`.

Chuỗi thứ 6 (tag 26 GUID A000000775, `...6304 7685`) cũng khớp CRC nhưng là QR VNPay, không dùng làm vector VietQR chuyển khoản.

Dùng cho test: viết hàm `buildVietQr({bin, account, amount?, purpose?})` phải sinh đúng chuỗi 1 đến 3; hàm parse phải đọc được 1 đến 5; sửa 1 ký tự phải làm CRC sai.

## 4. Danh sách BIN ngân hàng

- Nguồn: `GET https://api.vietqr.io/v2/banks` (công khai, không khóa), tải 2026-10-23; phản hồi `{"code":"00","desc":"Get Bank list successful! Total 76 banks","data":[...]}`.
- 76 ngân hàng, 76 BIN khác nhau. Trường mỗi mục: `id`, `name` (tên đầy đủ), `code` (mã ngắn, ví dụ `ICB`, `VCB`, `BIDV`, `VBA`), `bin` (6 số NAPAS), `shortName`/`short_name`, `logo`, `transferSupported`, `lookupSupported`, `support`, `isTransfer`, `swift_code`. Ví dụ: 970415 ICB VietinBank; 970436 VCB Vietcombank; 970418 BIDV; 970405 VBA Agribank.
- `transferSupported=1`: 48 ngân hàng; `lookupSupported=1`: 53 (một số mục thiếu trường): dùng `transferSupported` khi lọc ngân hàng nhận chuyển khoản.
- Bản gốc: `/home/ubuntu/.claude/jobs/040a2c8b/tmp/bank/banks.json` (21 176 byte, sha256 `7f905bc2da19a8848bd805646e74c64fee8531314f68ce2476fcccb977dd6596`). Không đưa vào repo (dịch vụ bên thứ ba, chưa rõ điều khoản).
- Tái tạo: `curl -sS https://api.vietqr.io/v2/banks -o banks.json`; có thể chuyển thành seed `bank_directory(bin, code, short_name, name)` khi cần, ghi ngày tải.

## 5. Sao kê ngân hàng (file Excel/CSV)

Không tìm được nguồn chính thức công khai nào về mẫu file sao kê của Vietcombank, Techcombank, MB, BIDV (tìm kiếm ngày 2026-10-23 chỉ ra bài chung chung của công cụ chuyển đổi). Cũng không có định dạng chuẩn (MT940/CSV) được tài liệu hóa cho ngân hàng Việt Nam (khớp ghi chú trong research_notes). Cột thường gặp theo kinh nghiệm chung, **chưa có nguồn**: ngày giao dịch, số tham chiếu/chứng từ, diễn giải, phát sinh nợ (ghi nợ/rút), phát sinh có (ghi có/nạp), số dư. Thiết kế nhập sao kê nên dùng bản đồ cột do người dùng ánh xạ, và lấy mẫu thật từ khách hàng (mục "Chờ người dùng").

## 6. Tra cứu MST: `api.vietqr.io/v2/business/{taxCode}`

Nguồn: gọi thật 2026-10-23, `curl https://api.vietqr.io/v2/business/0100109106` (MST công khai của Tập đoàn Viettel). Phản hồi thật (lưu `/home/ubuntu/.claude/jobs/040a2c8b/tmp/bank/mst.json`):

```json
{"code":"00","desc":"Success - Thành công","data":{"id":"0100109106","name":"TẬP ĐOÀN CÔNG NGHIỆP - VIỄN THÔNG QUÂN ĐỘI","internationalName":null,"shortName":null,"address":"Số 5, Phố Nguyễn Hữu An, Phường Cầu Giấy, TP Hà Nội","status":"NNT đang hoạt động"},"metadata":{"disclaimer":"Dữ liệu tổng hợp từ Trang thông tin điện tử của Cục Thuế 12 giờ trước","source":"https://www.gdt.gov.vn","updatedAt":"2026-10-23T03:58:23.000Z","contact":"idkit@cas.so"}}
```

- **Có trường tình trạng hoạt động**: `data.status` (ví dụ "NNT đang hoạt động"). Các giá trị khác chưa quan sát (chỉ thử một MST): xử lý `status` là chuỗi tự do, không so khớp cứng.
- Gồm `name`, `internationalName` và `shortName` (có thể `null`), `address`; có `metadata.updatedAt` và cảnh báo dữ liệu trễ. Không có SLA/điều khoản công bố: cần cache và cho nhập tay khi lỗi. Không trả người đại diện, ngành nghề.

## 7. VNPT SmartCA: ký số từ xa

Có tài liệu dùng được. Tải được (HTTP 200):
- `Tai_lieu_tich_hop_smartca_v4.1.pdf` (phiên bản bìa ghi 4.0, theo văn bản 769/QĐ-BTTTT): https://doitac-smartca.vnpt.vn/help/document/Tai_lieu_tich_hop_smartca_v4.1.pdf . Đây là tài liệu ký số chính.
- Đặc tả QĐ 769 v2.0: https://smartca.vnpt.vn/cms_img/upload/20240524141119VNPT.IT_SmartCA_SP_QD769_API_specification_document_v2.0.pdf (chưa đọc kỹ, cùng họ API 769).
- Tài liệu bạn nêu `TL_tich_hop_ban_hang_SmartCA_v1.0.pdf` **không phải API ký**: chỉ mô tả đăng ký/khởi tạo chứng thư số (`POST /thirdpartyapi/Register/partner_init`, trường `uid`, `loaiGiayTo`, `pricingCode`...), dùng cho đại lý bán hàng.
- Trang cổng: https://doitac-smartca.vnpt.vn/help/docs/tich-hop-ky-so-webapi/

Điều kiện: đơn vị đăng ký với VNPT để nhận tài khoản SP (`sp_id`, `sp_password`; email nhận cặp Client_ID/Client Secret). Chưa có tài khoản thử nên **chưa thử trên môi trường thật**. Mã mẫu của VNPT ở Google Drive (không tải).

### Chung

Mọi API là `POST`, JSON. UAT `https://rmgateway.vnptit.vn/sca/sp769`, Production `https://gwsca.vnpt.vn/sca/sp769`. Xác thực **trong body**: `sp_id` + `sp_password` (không có token OAuth/Bearer trong tài liệu này). Phản hồi: `{"status_code":200,"message":"SUCCESS","data":{...}}`. Lỗi: 400 BAD_REQUEST, 401 SP_CREDENTIAL_INVALID, 403 CREDENTIAL_STATUS_INVALID, 500.

### Luồng (SmartCA thường, xác nhận trên app)

1. `POST v1/credentials/get_certificate`: body `sp_id`, `sp_password`, `user_id` (CCCD/CMND/hộ chiếu/MST của thuê bao), `serial_number` (tùy chọn), `transaction_id` (SP tự sinh). Trả `data.user_certificates[]`: `service_type` (SMARTCA/ESEAL), `cert_id`, `cert_status`, `serial_number`, `cert_subject`, `cert_valid_from/to`, `cert_data` (X.509 base64), `chain_data.ca_cert/root_cert`.
2. `POST v1/signatures/sign`: `sp_id`, `sp_password`, `user_id`, `transaction_id` (bắt buộc, duy nhất), `transaction_desc`, `serial_number`, `time_stamp` (`YYYYMMddHHmmSS`), `sign_files[]` với `data_to_be_signed` (hex của hash với `sign_type: "hash"`; base64 nếu file), `doc_id` (phải hiển thị cả ở SP lẫn app xác nhận), `file_type`, `sign_type`. Ký lô bằng nhiều phần tử. Tài liệu ghi: hiện chỉ hỗ trợ ký **hash**. Phản hồi `message: "sig_wait_for_user_confirm"`, `data.transaction_id`, `data.tran_code`.
3. Người dùng xác nhận trên app SmartCA.
4. Nhận kết quả bằng một trong hai cách: webhook CA gọi SP (`sp_id`, `status_code`, `message`, `transaction_id`, `signed_files[]` gồm `doc_id`, `signature_value`, `timestamp_signature`), hoặc polling `POST v1/signatures/sign/{tranId}/status` (trả `data.signatures[]` với `doc_id`, `signature_value` base64, `timestamp_signature`). Tài liệu nói `{tranId}` là "mã id giao dịch ở API ký trả về", không nói rõ là `tran_code` hay `transaction_id`: cần thử trên UAT. Không nêu số lần/khoảng polling hay thời hạn giao dịch.
5. SP ghép `signature_value` vào tài liệu (PKCS#1 trên hash; tự dựng XMLDSig/CMS).

### SmartCA tích hợp (SmartCA TH, ký không cần bấm app)

`v2/signatures/sign` thêm `password` + `otp` (OTP/TOTP của thuê bao), trả `sad`; sau đó `v2/signatures/confirm` với `sad`, `password`, `transaction_id` trả ngay `signatures[]` (kèm `expired_in`). Cần thuê bao dùng gói tích hợp và giao mật khẩu/khóa TOTP cho ứng dụng: nhạy cảm, không nên làm mặc định.

Với HĐĐT SInvoice theo mô hình hiện tại, ký XML hóa đơn cần chứng thư của người bán; SmartCA chỉ ký hash, nên phải tự tính hash `SignedInfo` canonical rồi nhận chữ ký về dựng `Signature`. Điều này chưa kiểm chứng.
