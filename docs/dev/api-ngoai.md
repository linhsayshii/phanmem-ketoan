# API ngoài cho phần mềm bán hàng (`/api/ext/v1`)

API dành cho phần mềm bán hàng (POS) và hệ thống bên ngoài: đọc danh mục hàng, tồn kho, đẩy đơn bán lẻ, gửi hóa đơn đầu vào dạng XML. Xác thực bằng khóa API (Bearer), không dùng phiên đăng nhập.

## Khóa API

Tạo ở màn hình Hệ thống, Khóa API (quyền `api_key.manage`), hoặc `POST /api/api-keys` bằng phiên đăng nhập.

- Dạng khóa: `kt_<12 ký tự hex>_<64 ký tự hex>`. Khóa đầy đủ chỉ trả đúng một lần lúc tạo. Máy chủ chỉ lưu tiền tố và SHA-256 của khóa; nhật ký kiểm toán che `key_hash`.
- Khóa gắn với người tạo. Quyền hiệu lực là quyền vai trò hiện hành của người đó giao với các quyền của phạm vi đã chọn. Đổi vai trò hoặc khóa người dùng thì khóa API đổi theo ngay.
- Phạm vi:

| Phạm vi | Cho phép | Quyền cần |
|---|---|---|
| `items.read` | `GET /items` | `item.view` |
| `stock.read` | `GET /stock` | `stock_voucher.view` |
| `sales.write` | `POST /sales`, `GET /sales/:externalId` | `voucher.create`, `stock_voucher.create`, `settlement.create` (và `voucher.post` khi khóa tự ghi sổ) |
| `inbound_invoice.write` | `POST /inbound-invoices` | `inbound_invoice.create` |

- Tùy chọn: kho mặc định (`defaultWarehouseCode`), tự ghi sổ chứng từ bán hàng (`postSales`), ngày hết hạn (`expiresAt`).
- Thu hồi: `POST /api/api-keys/:id/revoke`. Khóa thu hồi, hết hạn hoặc người dùng bị khóa đều bị từ chối.
- Giới hạn tốc độ: 60 yêu cầu mỗi phút mỗi khóa (đếm trong bộ nhớ từng tiến trình).

Mọi yêu cầu gửi header `Authorization: Bearer kt_...`. Không ghi khóa vào nhật ký hoặc mã nguồn.

## Điểm cuối

Địa chỉ gốc: `https://<máy chủ>/api/ext/v1`. Số tiền, số lượng, đơn giá là chuỗi thập phân, không bao giờ số thực.

### GET /items

Danh mục hàng đang hoạt động, sắp theo mã, phân trang theo con trỏ.

Tham số: `q` (mã, tên hoặc mã vạch), `updatedSince` (ISO 8601 có múi giờ: hàng tạo mới hoặc sửa từ thời điểm đó), `after` (con trỏ `next` của trang trước), `limit` (1 đến 1000, mặc định 200).

```bash
curl -s -H "Authorization: Bearer $KT_KEY" "https://ketoan.example/api/ext/v1/items?limit=100&updatedSince=2026-10-01T00:00:00%2B07:00"
```

```json
{ "items": [ { "code": "SP1", "name": "Sản phẩm 1", "kind": "goods", "uomCode": "CAI", "taxCode": "V10", "taxRate": "10", "salePrice": "25000", "barcode": null } ], "next": null }
```

`next` khác `null` thì gọi tiếp với `after=<next>`. `salePrice` lấy từ bảng giá bán chung (VND, không theo nhóm khách) đang hiệu lực, `null` nếu chưa có.

### GET /stock

Tồn kho theo mặt hàng và kho. Tham số: `warehouseCode`, `itemCode`, `date` (YYYY-MM-DD, mặc định hôm nay).

```bash
curl -s -H "Authorization: Bearer $KT_KEY" "https://ketoan.example/api/ext/v1/stock?warehouseCode=K1"
```

```json
{ "date": "2026-10-24", "items": [ { "itemCode": "SP1", "warehouseCode": "K1", "quantity": "96", "value": "960" } ] }
```

Tối đa 5000 dòng; chạm giới hạn thì thêm `"truncated": true`, hãy lọc theo `warehouseCode` hoặc `itemCode`. `value` chỉ có khi người dùng của khóa có quyền xem giá vốn (`view_cost`) và không truyền `date`. Giá trị lấy từ các lớp giá vốn theo lần tính giá vốn gần nhất, nên có thể chưa phản ánh xuất kho mới.

### POST /sales

Đẩy một đơn bán. Gọi lại cùng `externalId` là an toàn (idempotent): trả kết quả cũ với mã 200, không lập chứng từ thứ hai.

```bash
curl -s -X POST -H "Authorization: Bearer $KT_KEY" -H "Content-Type: application/json" https://ketoan.example/api/ext/v1/sales -d '{
  "externalId": "POS1-000123",
  "date": "2026-10-24",
  "customer": { "taxCode": "0101234567" },
  "warehouseCode": "K1",
  "lines": [ { "itemCode": "SP1", "quantity": "2", "unitPrice": "25000" } ],
  "payment": { "method": "cash", "amount": "55000" }
}'
```

```json
{ "voucherId": "…", "voucherNo": "BH000001", "state": "posted", "paymentVoucherId": "…", "paymentVoucherNo": "PT000001" }
```

- `externalId`: tối đa 30 ký tự gồm chữ, số, `.`, `_`, `-`, `/`; trở thành số hóa đơn của chứng từ (trừ khi truyền `einvoiceSeriesId`, xem dưới). Phải duy nhất trong cả công ty trên mọi máy POS (khóa chống trùng theo công ty, để hai khóa xoay vòng của cùng máy vẫn chống trùng): nên thêm tiền tố máy, ví dụ `POS1-000123`. Gửi lại cùng `externalId` luôn phân giải lại khách (khách đã ngừng hoạt động thì trả 404 `PARTY_NOT_FOUND` dù đơn đã tạo trước đó). Gửi lại cùng `externalId` với nội dung khác (ngày, khách, kho, dòng hàng, thanh toán) trả 409 `EXTERNAL_ID_CONFLICT`.
- `customer`: `code` (mã khách) hoặc `taxCode`; không có cả hai thì dùng khách lẻ `KHACHLE`. Mã không tồn tại trả 404.
- `einvoiceSeriesId` (số nguyên dương, tùy chọn): id dải ký hiệu hóa đơn điện tử của công ty. Có truyền thì hóa đơn bán chờ phát hành điện tử: số hóa đơn để trống (nhà cung cấp cấp số khi phát hành), mẫu và ký hiệu lấy từ dải ký hiệu, và `externalId` chỉ còn là khóa chống trùng, không thành số hóa đơn. Chỉ áp dụng cho Hóa đơn bán hàng và bán dịch vụ.
- Có mặt hàng hàng hóa thì lập Hóa đơn bán hàng (BH, xuất kho) và cần kho (`warehouseCode` hoặc kho mặc định của khóa). Chỉ có dịch vụ thì lập Hóa đơn bán dịch vụ (HDB).
- `lines[].taxCode`, `uomCode`, `discount` (VND, số nguyên) tùy chọn; không truyền thuế thì lấy thuế mặc định của mặt hàng.
- Khóa `postSales`: chứng từ ghi sổ ngay (`state: posted`); ngược lại để `draft`.
- `payment`: chỉ dùng với khóa tự ghi sổ. `cash` lập Phiếu thu; `bank` lập Giấy báo Có và cần `bankAccountCode` (số tài khoản). Số tiền không vượt giá trị hóa đơn, được đối trừ vào khoản phải thu của hóa đơn.
- Trả 201 khi tạo mới, 200 khi `externalId` đã có.

### GET /sales/:externalId

Tra lại kết quả đơn đã đẩy (cùng dạng thân với `POST /sales`). Trả 404 `SALE_NOT_FOUND` nếu chưa có.

### POST /inbound-invoices

Gửi hóa đơn đầu vào dạng XML (tối đa 2 MB), vào hộp thư hóa đơn đầu vào để kế toán đối chiếu.

```bash
curl -s -X POST -H "Authorization: Bearer $KT_KEY" -H "Content-Type: application/xml" --data-binary @hoadon.xml https://ketoan.example/api/ext/v1/inbound-invoices
```

```json
{ "id": 42, "status": "new" }
```

Trả 201 khi mới; 200 khi hóa đơn trùng (`status: "duplicate"`, kèm `existing` là id bản đã có). XML không đọc được trả 400.

## Mã lỗi

Thân lỗi dạng `{ "error": { "code": "...", "message": "..." } }`.

| HTTP | Mã | Ý nghĩa |
|---|---|---|
| 401 | `UNAUTHORIZED` | Thiếu, sai, thu hồi hoặc hết hạn khóa; người dùng bị khóa. Mọi trường hợp trả cùng một thân để không lộ khóa nào tồn tại. |
| 403 | `SCOPE_FORBIDDEN` | Khóa không có phạm vi cho điểm cuối này. |
| 403 | `FORBIDDEN` | Người dùng của khóa không còn quyền cần thiết. |
| 429 | `RATE_LIMITED` | Quá 60 yêu cầu mỗi phút; thử lại sau. |
| 400 | `VALIDATION` | Thân hoặc tham số sai dạng; `message` nêu trường. |
| 400 | `WAREHOUSE_REQUIRED` | Đơn có hàng hóa nhưng không có kho. |
| 400 | `INVOICE_GROUP_MISMATCH` | Không có nhóm hóa đơn bán ra khớp thuế suất dòng đầu. |
| 400 | `PAYMENT_NEEDS_POST` | Có `payment` nhưng khóa không tự ghi sổ. |
| 400 | `PAYMENT_EXCEEDS` | Số tiền thanh toán vượt giá trị hóa đơn. |
| 400 | `NO_RECEIVABLE` | Hóa đơn không phát sinh công nợ để đối trừ. |
| 404 | `PARTY_NOT_FOUND` | Không có khách hàng đang hoạt động theo `code` hoặc `taxCode`. |
| 404 | `NOT_FOUND` | Đường dẫn không tồn tại dưới `/api/ext/v1` (cần khóa hợp lệ, không thì 401). |
| 409 | `EXTERNAL_ID_CONFLICT` | `externalId` đã dùng cho đơn có nội dung khác. |
| 404 | `ITEM_NOT_FOUND` | Không có mặt hàng theo mã. |
| 404 | `BANK_ACCOUNT_NOT_FOUND` | Không có tài khoản ngân hàng theo `bankAccountCode`. |
| 404 | `SALE_NOT_FOUND` | Không có đơn với `externalId`. |

Lỗi nghiệp vụ của sổ cái (kỳ khóa sổ, thiếu tồn kho…) trả mã và thông báo tiếng Việt như các API khác.

## Hạn chế đã biết

- Giới hạn tốc độ nằm trong bộ nhớ từng tiến trình: chạy nhiều tiến trình API thì giới hạn thực tế cao hơn.
- Kết quả `POST /sales` chưa kèm thông tin hóa đơn điện tử; phát hành hóa đơn điện tử làm ở màn hình hóa đơn.
- `value` của `/stock` phản ánh lần tính giá vốn gần nhất, không tính lùi theo ngày.
- Chưa thử với phần mềm bán hàng thật; kiểm thử bằng bộ test tích hợp `apps/api/test/ext`.
