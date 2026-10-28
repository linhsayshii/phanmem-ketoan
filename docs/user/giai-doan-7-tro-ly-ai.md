# Trợ lý: gợi ý định khoản, bút toán định kỳ, nhận diện hóa đơn (Giai đoạn 7, nhóm 7)

Menu **Trợ lý** (`/tro-ly`) có ba thẻ: **Bút toán định kỳ**, **Nhận diện hóa đơn**, **Gợi ý định khoản**. Nguyên tắc chung: trợ lý chỉ **gợi ý** hoặc lập **chứng từ nháp**. Bạn xem lại và quyết định; trợ lý không tự ghi sổ (ngoại lệ duy nhất: mẫu định kỳ mà người có quyền ghi sổ chủ động bật **Tự ghi sổ**, mục 2.5).

Quyền: `assistant.use` (gợi ý, nhận diện), `recurring.view` (xem mẫu và lịch sử), `recurring.manage` (lập mẫu, chạy). Quản trị, kế toán trưởng, kế toán viên có cả ba; vai trò chỉ xem có `recurring.view`.

## 1. Gợi ý định khoản

Trợ lý học từ **chứng từ đã ghi sổ của chính công ty bạn** và xếp hạng các cặp tài khoản Nợ/Có đã dùng cho nghiệp vụ tương tự. Không cần khóa API, không gửi dữ liệu ra ngoài; cùng đầu vào luôn cho cùng kết quả.

### Trên phiếu chứng từ

1. Mở một phiếu nháp (ví dụ Phiếu kế toán), nhập **đối tượng** và **diễn giải** (và số tiền nếu đã có).
2. Nhấn **Ctrl+G** hoặc nút **Gợi ý định khoản (Ctrl+G)**.
3. Mỗi gợi ý cho biết các tài khoản Nợ/Có, độ tin cậy (phần trăm) và **lý do**: "Đã dùng 3 lần cho cùng đối tượng NCC001", "2 lần có diễn giải gần giống (từ khóa: thuê, văn phòng)", "Lần gần nhất 2026-05-10", "Chiếm 73% các bút toán tương tự".
4. Bấm **Dùng gợi ý này**: trợ lý điền tài khoản vào các dòng còn trống (Nợ trước, Có sau), không đụng dòng bạn đã nhập và **không điền số tiền**. Phần còn lại nhập bằng bàn phím như bình thường.

### Cách xếp hạng

Mỗi chứng từ trong lịch sử (lập tay, đã ghi sổ, trong 36 tháng gần nhất) cho điểm: cùng đối tượng 3, cùng loại chứng từ 1, mỗi từ khóa diễn giải chung 0,5 (tối đa 3 từ), cùng mặt hàng 2, số tiền chênh dưới 10% là 0,5; chứng từ cũ hơn 365 ngày chỉ tính một nửa. Các chứng từ cùng bộ tài khoản gộp điểm. Chứng từ nháp, đã đảo hoặc do hệ thống tự sinh (khấu hao, giá vốn, lương, kết chuyển) không được học.

### Dữ liệu nhạy cảm và chi nhánh

- Thiếu cờ **xem công nợ phải thu/phải trả, giá vốn hoặc lương**: các chứng từ có dòng ở tài khoản tương ứng bị loại khỏi việc học, nên gợi ý không lộ cặp tài khoản đó. Bạn vẫn nhận gợi ý cho phần còn lại.
- Người dùng bị giới hạn chi nhánh chỉ học từ chứng từ của chi nhánh mình xem được.

## 2. Bút toán định kỳ

Dùng cho bút toán lặp lại: phân bổ chi phí, trích lập, ghi nhận doanh thu theo kỳ... Mẫu sinh **phiếu kế toán nháp** cho mỗi kỳ đến hạn.

### 2.1 Lập mẫu

**Thêm mẫu** rồi nhập:

- **Mã mẫu**, **Tên mẫu** (mã không đổi được sau khi lưu).
- **Tần suất**: hằng tháng, hằng quý (cách 3 tháng) hoặc hằng năm (cách 12 tháng), tính từ tháng của ngày **Bắt đầu từ**; **Ngày trong tháng** (31 = cuối tháng; tháng ngắn hơn lấy ngày cuối tháng); **Kết thúc** (nếu có).
- **Lập bù các kỳ trước**: tắt (mặc định) thì bỏ các kỳ trước tháng lập mẫu; bật thì lập từ ngày bắt đầu.
- **Diễn giải chứng từ**: dùng `{THANG}`, `{QUY}`, `{NAM}`, ví dụ "Phân bổ chi phí thuê văn phòng {THANG}/{NAM}".
- Các dòng: **tài khoản**, **Nợ**, **Có**, đối tượng. Số tiền là số nguyên đồng **hoặc công thức**.

### 2.2 Công thức

Biến: `THANG` (1–12), `QUY` (1–4), `NAM`, `SO_NGAY` (số ngày của tháng). Phép `+ - * /`, ngoặc, hàm `ROUND(x)`, `ROUND(x, n)`, `MIN(a, b)`, `MAX(a, b)`. Ví dụ: `MAX(1000000, 300000 * SO_NGAY)`; `ROUND(120000000 / 12)`. Kết quả làm tròn nửa lên về đồng, không âm, tối đa 16 chữ số. Công thức tính bằng số thập phân chính xác, không sai số nhị phân.

Khi lưu, hệ thống kiểm cú pháp và thử cả 12 tháng: mỗi tháng **tổng Nợ phải bằng tổng Có** và không dòng nào có cả hai bên. Mẫu lệch bị từ chối ngay, nên không có chứng từ lệch Nợ/Có.

### 2.3 Chạy

- **Tự động**: mỗi ngày lúc 01:30 (giờ Việt Nam), máy chủ lập chứng từ nháp cho các kỳ đã đến hạn của mọi mẫu đang chạy.
- **Chạy ngay**: chọn **Đến ngày** (mặc định hôm nay, tối đa 45 ngày sau). **Xem trước** liệt kê kỳ sẽ lập; **Lập chứng từ nháp** thực hiện.

Chứng từ sinh ra là phiếu kế toán thật: có ngày (ngày phát sinh của kỳ), người lập, nhãn nguồn là mẫu; mở từ **Lịch sử chạy** để sửa, ghi sổ hoặc xóa như phiếu thường.

### 2.4 Chạy lại, kỳ khóa sổ, lỗi

- **Chạy lại không sinh trùng**: mỗi (mẫu, kỳ) chỉ có một chứng từ, kể cả khi bấm hai lần hay máy chủ chạy đồng thời. Xóa chứng từ nháp thì kỳ đó không tự lập lại.
- **Kỳ đã khóa sổ** hoặc chưa có trong năm tài chính: bỏ qua, ghi lý do ("Kỳ 01/2026 đã khóa sổ: ..."). Trợ lý không tự lập chứng từ điều chỉnh. Mở lại kỳ rồi chạy lại thì lập bù.
- **Lỗi** (ví dụ mã đối tượng không còn): ghi trạng thái Lỗi kèm lý do; sửa mẫu rồi chạy lại.
- Tạm dừng, tiếp tục, kết thúc mẫu ở cột thao tác. Chỉ xóa được mẫu chưa sinh chứng từ.

### 2.5 Tự ghi sổ

Mặc định mẫu chỉ lập **nháp**. Người có quyền **Ghi sổ** có thể bật **Tự ghi sổ** cho mẫu: chứng từ được ghi sổ ngay sau khi lập (áp dụng cài đặt chặn âm quỹ). Ghi sổ lỗi thì giữ bản nháp và ghi chú trong Lịch sử chạy.

### 2.6 Dữ liệu nhạy cảm

Mẫu có dòng ở tài khoản công nợ, giá vốn hoặc lương chỉ người có cờ tương ứng xem, lập, sửa, chạy được.

## 3. Nhận diện hóa đơn

Kéo thả tệp hóa đơn vào thẻ **Nhận diện hóa đơn**. Kết quả là **bản nháp để soát**, mỗi trường có độ tin cậy (xanh từ 80%, cam dưới 80%, "Thiếu" nếu không đọc được). Trợ lý không tạo chứng từ.

- **XML hóa đơn điện tử (QĐ 1233)**: đọc ngay trên máy chủ, không gửi đi đâu. Chọn **Với tệp XML: lưu luôn vào Hóa đơn đầu vào** để chuyển sang quy trình hóa đơn đầu vào (kiểm trùng, đối chiếu MST, lập chứng từ mua ở đó).
- **PDF, ảnh PNG/JPEG**: cần dịch vụ nhận diện bên ngoài do quản trị máy chủ cấu hình (`RECOGNIZER_PROVIDER`). Tệp **chỉ rời máy chủ** khi cả hai điều kiện đúng: công ty bật công tắc "Cho phép gửi tệp ra dịch vụ nhận diện bên ngoài" (cần quyền sửa tùy chọn hệ thống) **và** bạn đánh dấu "Gửi tệp ở lần này". Chưa cấu hình thì ảnh/PDF báo chưa dùng được; XML vẫn dùng.
- **Cần soát lại** khi có trường thiếu hoặc dưới 80%, hoặc số liệu không khớp (tổng thành tiền các dòng khác tiền hàng; tiền hàng + thuế khác tổng thanh toán), hoặc hóa đơn XML chưa có chữ ký số.
- **Nhật ký nhận diện** ghi từng lần (kể cả lần bị từ chối): ai, tệp nào, bộ nhận diện nào, có gửi ra ngoài không. Nhật ký không lưu nội dung tệp.
- Văn bản trong hóa đơn chỉ là dữ liệu. Nếu có câu giống chỉ dẫn cho máy (ví dụ "bỏ qua mọi chỉ dẫn..."), trợ lý cảnh báo và vẫn không làm theo.

### Tệp bị chặn

Tệp nén hoặc Office (zip), tệp có đuôi không khớp nội dung, XML có DOCTYPE/ENTITY, XML trên 2 MB, PDF hoặc ảnh trên 10 MB, PDF có JavaScript hoặc tệp nhúng, ảnh quá nhiều điểm ảnh (trên 50 triệu) đều bị từ chối. Nhiều hóa đơn XML nén trong một tệp zip: dùng màn **Hóa đơn đầu vào**.

## 4. Cấu hình máy chủ (quản trị hệ thống)

| Biến | Ý nghĩa |
|---|---|
| `RECOGNIZER_PROVIDER` | `off` (mặc định), `http` hoặc `anthropic`. **Chưa thử trên môi trường thật.** |
| `RECOGNIZER_URL` | Địa chỉ dịch vụ OCR khi `http` (https khi chạy production). Gửi `POST` JSON `{ fileName, mimeType, contentBase64 }` kèm `Authorization: Bearer`; trả JSON gồm các trường `formNo, serial, invoiceNo, issueDate, currency, seller, buyer, lines, totals`, mỗi trường `{ value, confidence }`. |
| `RECOGNIZER_API_KEY`, `RECOGNIZER_MODEL`, `RECOGNIZER_TIMEOUT_MS` | Khóa, mô hình (khi `anthropic`), thời gian chờ. |

Worker (`apps/worker`) cần chạy để bút toán định kỳ tự sinh hằng ngày; nút **Chạy ngay** không cần worker.
