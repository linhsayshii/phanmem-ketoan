# Giai đoạn 4: Tài sản, công cụ dụng cụ, chi phí trả trước và khế ước vay

Giai đoạn này thêm phân hệ tài sản cố định (TSCĐ), công cụ dụng cụ (CCDC), chi phí trả trước dài hạn (CPTT) và khế ước vay. Phần mềm tính khấu hao, phân bổ, lãi vay thành chứng từ thật, có số, có ngày, có người lập; mọi nghiệp vụ tăng, giảm, đánh giá lại đều đi qua sổ cái. Có thêm quy trình cuối kỳ gom các bước tự động theo đúng thứ tự, sổ và báo cáo tài sản, biên bản kiểm kê và sáu quy tắc soát lỗi mới.

Nguyên tắc cần nhớ: sổ cái là nguồn duy nhất của nguyên giá và hao mòn. Thẻ tài sản chỉ lưu số đầu kỳ; nguyên giá, hao mòn, giá trị còn lại trên màn hình và báo cáo đều tính từ các bút toán có mã tài sản.

Lưu ý quan trọng về pháp lý: khung thời gian khấu hao của TSCĐ (Thông tư 45/2013/TT-BTC và văn bản thay thế) chưa có văn bản gốc trong dự án. Phần mềm không gợi ý và không kiểm tra thời gian sử dụng so với khung quy định. Kế toán tự quyết định số kỳ sử dụng của từng thẻ và chịu trách nhiệm về tính phù hợp với quy định.

## Phím tắt chung

| Màn hình | Phím | Tác dụng |
|---|---|---|
| Danh sách thẻ | Insert | Thêm thẻ mới |
| Danh sách thẻ | Enter | Mở thẻ đang chọn |
| Thẻ tài sản | Ctrl+S | Lưu |
| Hộp thoại biến động | Enter (trong ô nhập), Ctrl+S | Lưu hộp thoại |
| Ô Loại, Bộ phận, Tài khoản, Bên cho vay, Khế ước, Tài sản | F4 | Mở tra cứu |
| Lưới phân bổ chi phí, số dư đầu kỳ | Enter, Tab | Sang ô kế tiếp |
| Số dư đầu kỳ tài sản, Kiểm kê tài sản | Ctrl+S | Lưu |
| Quy trình cuối kỳ | F9 | Chạy bước kế tiếp |

## 1. Loại tài sản

Menu: Tài sản > Loại tài sản.

Mỗi thẻ thuộc một loại. Loại quyết định tài khoản tài sản và tài khoản hao mòn của thẻ.

1. Bấm "Thêm loại".
2. Nhập Mã, Tên. Chọn Nhóm: TSCĐ, CCDC hoặc CPTT. Nhóm không đổi được khi sửa.
3. Chọn TK tài sản (F4). Với TSCĐ chọn thêm TK hao mòn (F4).
4. Nhập Số kỳ sử dụng mặc định và đánh dấu Đang dùng.
5. Lưu. Thông báo "Đã lưu loại tài sản".

Mã tài khoản của thẻ được tra theo chế độ kế toán của năm tài chính muộn nhất. Khi loại đã có thẻ có sổ cái, không đổi được nhóm hoặc tài khoản ("ASSET_ACCOUNT_LOCKED", 409). Loại đã có thẻ không xóa được ("CATEGORY_IN_USE": Loại tài sản đã có thẻ tài sản, không xóa được). Tài khoản không phù hợp với nhóm: "ASSET_ACCOUNT_INVALID".

Các tài khoản hao mòn 2141, 2142, 2143 được gắn sổ chi tiết theo tài sản: dòng hao mòn bắt buộc có mã tài sản.

## 2. Thẻ tài sản

Menu: Tài sản > Tài sản cố định, Công cụ dụng cụ, Chi phí trả trước. Mỗi nhóm có một màn hình riêng, cùng cách dùng.

### 2.1. Danh sách

- Ô tìm "Tìm theo mã, tên" và bộ lọc Loại, Bộ phận, Trạng thái (Mọi trạng thái, Đang dùng, Đã ghi giảm).
- Cột: Mã, Tên, Loại, Bộ phận, Ngày sử dụng, Nguyên giá, Hao mòn lũy kế, Giá trị còn lại, Số kỳ còn lại, Trạng thái.
- Chưa có thẻ: "Chưa có thẻ nào".

### 2.2. Tab "Thông tin chung"

Nhập Mã, Tên, Loại (F4), Bộ phận sử dụng (F4), Ngày sử dụng, Ngày bắt đầu khấu hao hoặc phân bổ, Số kỳ sử dụng (1 đến 1200), Số lượng, ĐVT, Ghi chú. TSCĐ có thêm ô "Có tính khấu hao". Bấm "Lưu (Ctrl+S)"; thông báo "Đã lưu thẻ". Màn hình hiện tài khoản tài sản, tài khoản hao mòn và trạng thái (Đang dùng, Đã ghi giảm).

Thẻ mới: phải lưu thông tin chung trước khi dùng các tab khác.

Lưu ý:
- Nguyên giá không nhập trên thẻ. Nguyên giá phát sinh khi ghi tăng (mục 3) hoặc từ số dư đầu kỳ (mục 8).
- Khi thẻ đã có bút toán, Số lượng và Bộ phận chỉ đổi qua nghiệp vụ ghi giảm hoặc điều chuyển; giá trị sửa trực tiếp trên thẻ bị bỏ qua.
- Thẻ chưa có ngày bắt đầu, chưa có thời gian sử dụng hoặc không tính khấu hao thì không có lịch.
- Xóa thẻ đã có sổ cái: "ASSET_IN_USE" (409).

### 2.3. Tab "Phân bổ chi phí"

Quy định chi phí khấu hao hoặc phân bổ của thẻ ghi vào đâu.

1. Chọn "Hiệu lực từ kỳ … năm …".
2. Mỗi dòng: TK chi phí (F4), Bộ phận, Vụ việc, Khoản mục, Tỷ lệ %.
3. Tổng tỷ lệ phải bằng 100%. Bấm "Lưu phân bổ"; thông báo "Đã lưu phân bổ chi phí".

Thông báo lỗi: "Nhập ít nhất một dòng phân bổ chi phí", "Dòng phân bổ N: chọn tài khoản chi phí", "Dòng phân bổ N: tỷ lệ không hợp lệ", "Tổng tỷ lệ phân bổ phải bằng 100%". Máy chủ trả "ALLOCATION_RATIO" khi tổng khác 100.

Mỗi lần lưu tạo một bộ dòng có hiệu lực từ kỳ đã chọn; các kỳ trước vẫn dùng bộ cũ. Kỳ chưa có phân bổ thì chạy kỳ báo "ASSET_ALLOCATION_MISSING".

### 2.4. Tab "Lịch khấu hao" và "Lịch phân bổ"

Lịch xem trước theo từng kỳ: Kỳ, Số kỳ, Khấu hao (hoặc Phân bổ), Lũy kế, Chứng từ (KH hoặc PB nếu đã chạy). Màn hình chỉ đọc. Lịch rỗng: "Chưa có lịch: thẻ chưa có nguyên giá hoặc chưa nhập ngày bắt đầu".

Lịch theo phiên bản: mỗi lần đổi nguyên giá, thời gian hoặc khoảng dừng thì lập phiên bản mới từ kỳ hiệu lực; kỳ đã qua giữ nguyên.

### 2.5. Tab "Biến động và chứng từ"

Chứa các nút nghiệp vụ (mục 3 đến 6) và bảng biến động: Ngày, Nghiệp vụ, Chứng từ (loại TS), Trạng thái (Hiệu lực, Đã hủy), nút "In biên bản" (chỉ TSCĐ) và "Hủy".

## 3. Ghi tăng

Có ba đường vào.

### 3.1. Mua bằng hóa đơn hoặc chứng từ

Trên dòng chứng từ (hóa đơn mua, phiếu kế toán, phiếu chi...), tài khoản 211 đến 214, 217, 242 có cột "Tài sản (F4)". Chọn thẻ cho dòng đó; chứng từ ghi sổ thì nguyên giá của thẻ tăng. Thẻ chỉ ghi trên tài khoản của loại (hoặc tài khoản hao mòn của loại): sai thì "ASSET_ACCOUNT_MISMATCH" (400), nội dung "tài sản X chỉ ghi trên tài khoản A hoặc B". Dòng 242 không gắn mã tài sản vẫn hợp lệ.

### 3.2. Từ kho

Xuất kho Nợ 242 để đưa công cụ dụng cụ vào sử dụng: chọn mã tài sản trên dòng phiếu xuất kho (PXK). Chứng từ giá vốn (GV) giữ mã tài sản nên thẻ vẫn gắn đúng.

### 3.3. Ghi tăng trực tiếp

Nút "Ghi tăng" ở tab Biến động. Lý do:
- Hoàn thành xây dựng cơ bản
- Nhận góp vốn
- Thuê tài chính
- Được biếu tặng
- Khác

Nhập Ngày nghiệp vụ, Lý do, TK đối ứng (Có, F4), Giá trị ghi tăng, Đối tượng, Diễn giải. Bút toán: Nợ tài khoản tài sản (mang mã thẻ) / Có TK đối ứng. Nếu thẻ chưa có ngày sử dụng hoặc ngày bắt đầu, phần mềm điền theo ngày nghiệp vụ.

Lý do "Mua sắm" hoặc "Từ kho" không dùng ở đây: máy chủ trả 400 "VALIDATION" kèm hướng dẫn lập chứng từ mua hoặc PXK có mã tài sản (mục 3.1, 3.2).

Mọi hộp thoại biến động báo trước: "Các kỳ khấu hao/phân bổ đã chạy từ kỳ chứa ngày nghiệp vụ sẽ được chạy lại khi lưu: chứng từ cũ được đảo, chứng từ mới được lập." Sau khi lưu hiện "Đã ghi nhận …" kèm chứng từ loại TS.

## 4. Khấu hao và phân bổ

### 4.1. Chế độ khấu hao

Chọn ở Hệ thống > Thông tin công ty > tab "Tùy chọn hệ thống" > "Cách tính khấu hao tháng đầu, tháng cuối" (cài đặt "fa_proration"):
- "Theo số ngày thực tế" ("day", mặc định): khấu hao theo ngày, tháng đầu và tháng cuối tính theo số ngày thực tế.
- "Tròn tháng" ("month"): khấu hao theo tháng, tính tháng đủ.

Chỉ đổi được trước lần chạy khấu hao TSCĐ đầu tiên. Đã có lần chạy khấu hao hiệu lực thì máy chủ từ chối "FA_PRORATION_LOCKED" (409): "Đã có lần chạy khấu hao TSCĐ: không đổi được cách tính khấu hao tháng đầu, tháng cuối".

Đây là giả định của phần mềm, vì chưa có văn bản gốc để đối chiếu. CCDC và CPTT luôn phân bổ theo kỳ (tháng), không có phần kỳ.

Lịch là lũy kế mục tiêu, số mỗi kỳ là chênh lệch hai lũy kế liên tiếp. Vì làm tròn đồng, các kỳ đủ tháng có thể lệch nhau 1 đồng; tổng cuối cùng bằng nguyên giá. Hao mòn không vượt nguyên giá.

### 4.2. Chạy kỳ

Chạy ở Sổ cái > Quy trình cuối kỳ (mục 9) cho ba bước: phân bổ CCDC, phân bổ CPTT, khấu hao TSCĐ. Cần quyền "asset.run".

- Mỗi lần chạy lập một chứng từ KH (khấu hao) hoặc PB (phân bổ) ngày cuối kỳ. Dòng số 0 bị bỏ.
- Không có số nào phải ghi thì không sinh chứng từ.
- Chạy lại kỳ đã chạy mà số liệu không đổi: kết quả "không đổi", không có chứng từ mới. Số liệu đổi: chứng từ cũ được đảo, chứng từ mới được lập; không có hai chứng từ trùng cho một kỳ.
- Không chạy cách kỳ: kỳ trước chưa chạy thì "PERIOD_RUN_GAP". Hãy chạy kỳ còn thiếu trước.
- Chưa có thời gian sử dụng: "ASSET_LIFE_MISSING". Chưa có phân bổ chi phí: "ASSET_ALLOCATION_MISSING".
- Kỳ lớn hơn 12 (kỳ điều chỉnh) không tính tài sản nào.
- Kỳ khóa sổ cần quyền "voucher.backdate_locked" nếu lần chạy phải ghi ("PERIOD_SOFT_LOCKED"); kỳ khóa cứng bị từ chối ("PERIOD_HARD_LOCKED").
- Tài sản ghi giảm trong kỳ không có trong chứng từ khấu hao của kỳ đó. Ở chế độ ngày, chứng từ ghi giảm đã gồm khấu hao đến ngày trước ngày giảm.
- Tài sản hết số kỳ mà còn giá trị không tự kéo dài. Soát lỗi báo, kế toán điều chỉnh thời gian sử dụng (mục 6).

### 4.3. Cần chạy lại

Mỗi bước so dữ liệu đầu vào với lần chạy trước. Ghi sổ, bỏ ghi sổ, đảo chứng từ, tài sản vào hoặc ra làm bước chuyển thành "Cần chạy lại". Bấm "Chạy lại" ở Quy trình cuối kỳ.

Nghiệp vụ tài sản có ngày trong kỳ P làm các lần chạy từ kỳ P trở đi được chạy lại khi lưu nghiệp vụ; kỳ khóa thì nghiệp vụ bị từ chối.

## 5. Ghi giảm

Nút "Ghi giảm" ở tab Biến động. Lý do:
- Thanh lý, nhượng bán
- Góp vốn
- Chuyển thành công cụ dụng cụ
- Mất mát
- Khác

### 5.1. TSCĐ

Bút toán: Nợ TK hao mòn 214x toàn bộ hao mòn lũy kế, Nợ TK đối ứng (mặc định 811) giá trị còn lại, Có TK tài sản nguyên giá. Chế độ ngày có thêm khấu hao phần kỳ đến ngày giảm. TK đối ứng không bắt buộc, mặc định 811.

Hộp thoại ghi giảm chỉ lập bút toán giảm tài sản. Khoản thu từ thanh lý không được ghi ở đây; lập bằng chứng từ riêng.

Chuyển thành công cụ dụng cụ: nhập thêm Mã thẻ CCDC, Tên CCDC, Số kỳ phân bổ và lưới phân bổ của thẻ mới. Thẻ CCDC mới ghi TK 242 theo giá trị còn lại, phân bổ từ kỳ sau kỳ ghi giảm. Ngày bắt đầu phân bổ nhập tay phải sau cuối kỳ ghi giảm, nếu không thì 400. Hủy ghi giảm không xóa thẻ CCDC mới.

Lỗi thường gặp: "ASSET_DECREASED" (tài sản đã ghi giảm), "ASSET_QUANTITY" (số lượng không hợp lệ), "PERIOD_RUN_GAP" (kỳ trước chưa chạy khấu hao).

### 5.2. CCDC và CPTT: ghi giảm một phần

Nhập TK đối ứng (bắt buộc), Số lượng ghi giảm (trống là toàn bộ) và Lý do. CPTT không có số lượng, chỉ ghi giảm toàn bộ.

Giá trị ghi giảm = giá trị còn lại tại ngày giảm (bỏ lần phân bổ kỳ đó) x số lượng giảm / số lượng trên thẻ, làm tròn nửa lên.

### 5.3. Điều chỉnh giá trị CCDC, CPTT

"Điều chỉnh giá trị": số tiền có dấu. Dương: Nợ 242, Có TK đối ứng. Âm: bút toán đảo dấu; giá trị còn lại không được âm (400). Tăng giá trị khi lịch đã hết kỳ: "ASSET_SCHEDULE_ENDED".

## 6. Các biến động khác

- Đánh giá lại (TSCĐ): nhập Nguyên giá mới, Hao mòn lũy kế mới, Số kỳ còn lại (tùy chọn) và TK chênh lệch (điền sẵn 412). Chế độ TT133 không có TK 412: phải nhập TK chênh lệch khác, ví dụ 4118, nếu không máy chủ báo không tìm thấy tài khoản. Hao mòn mới lớn hơn nguyên giá mới thì 400. Có số kỳ còn lại thì dựng phiên bản lịch mới.
- Điều chuyển: chọn Bộ phận mới; lưới phân bổ chi phí điền sẵn từ phân bổ hiện hành, sửa nếu cần.
- Dừng khấu hao (TSCĐ): bắt buộc nhập lý do. Khi thẻ đang dừng, nút đổi thành "Tiếp tục khấu hao". Khoảng dừng không tính khấu hao. Lỗi: "ASSET_SUSPENDED", "ASSET_NOT_SUSPENDED", "ASSET_PAUSE_ORDER".
- Điều chỉnh thời gian sử dụng: nhập Số kỳ còn lại. Từ kỳ hiệu lực, mức khấu hao hoặc phân bổ tính lại theo số kỳ mới.
- Hủy biến động: nút "Hủy" ở dòng biến động, xác nhận "Hủy biến động này?". Phải hủy theo thứ tự ngược, biến động sau trước: sai thứ tự "ASSET_EVENT_ORDER". Đã hủy rồi: "ASSET_EVENT_CANCELLED". Hủy dừng khấu hao thì khoảng dừng tự khôi phục. Hủy ghi giảm chuyển CCDC bị chặn "ASSET_EVENT_ORDER" khi thẻ CCDC mới đã có biến động hoặc đã phân bổ.

## 7. Kỳ khóa

- Biến động có ngày trong kỳ khóa sổ cần quyền "voucher.backdate_locked".
- Kỳ khóa cứng không ghi được; dùng chứng từ điều chỉnh ở kỳ mở.
- Kỳ trước còn thiếu lần chạy thì ghi giảm cũng bị chặn "PERIOD_RUN_GAP".

## 8. Số dư đầu kỳ tài sản và nhập Excel

Menu: Sổ cái > Số dư đầu kỳ tài sản. Quyền sửa: "opening_balance.update".

Dùng khi chuyển từ phần mềm khác sang. Chỉ nhập cho năm tài chính đầu tiên ("OPENING_PRIOR_YEAR_EXISTS" nếu đã có năm trước).

1. Chọn năm.
2. Mỗi thẻ một dòng: Mã thẻ, Tên thẻ, Mã loại tài sản, Ngày sử dụng, Bắt đầu KH/PB, Nguyên giá (hoặc giá trị còn lại với CCDC, CPTT), Hao mòn lũy kế, Số tháng còn lại. Loại và tài khoản lấy từ loại tài sản. Ngày bắt đầu mặc định là đầu năm tài chính.
3. Bấm "Kiểm tra" rồi "Lưu" (Ctrl+S). Thông báo "Đã lưu thẻ tài sản đầu kỳ". Màn hình hiện Tổng nguyên giá, Tổng hao mòn. Khớp số dư tài khoản: "Thẻ tài sản khớp số dư tài khoản".

Quy tắc:
- TSCĐ nhập nguyên giá, hao mòn và số tháng còn lại. CCDC, CPTT nhập giá trị còn lại ở cột Nguyên giá và số kỳ còn lại.
- Tổng thẻ theo từng tài khoản phải khớp số dư tài khoản ở màn "Số dư đầu kỳ".
- Mỗi thẻ tạo một dòng chứng từ DK có mã tài sản. Phần số dư 242 ngoài thẻ giữ một dòng riêng.
- Lưu lại thay toàn bộ thẻ đầu kỳ của năm và dựng lại DK. Chỉ làm được khi Số dư đầu kỳ chưa ghi sổ ("OPENING_POSTED"). Cần sửa thì bỏ ghi sổ trước.
- Thẻ đã có sổ cái ngoài DK thì không thay được ("ASSET_IN_USE").
- Ngày sai: "Ngày không hợp lệ, nhập dạng dd/mm/yyyy". Mã thẻ trùng: "DUPLICATE".

Nhập Excel: bấm "Tải mẫu Excel", điền sheet "Du_lieu", bấm "Nhập Excel" rồi chọn "Kiểm tra" hoặc "Nhập". Cột "Số tháng còn lại" bắt buộc ở mọi dòng. Nhập Excel thay thế toàn bộ thẻ đầu kỳ đã lưu của năm. Lỗi hiện theo Dòng, Cột: "N lỗi, chưa nhập dòng nào". Thành công: "Đã nhập N thẻ". Mã lỗi tệp: "IMPORT_BAD_FILE", "IMPORT_NO_SHEET", "IMPORT_TOO_LARGE" (quá 20.000 dòng), "IMPORT_BAD_HEADER", "IMPORT_NO_FILE", "IMPORT_EMPTY".

## 9. Quy trình cuối kỳ

Menu: Sổ cái > Quy trình cuối kỳ. Quyền xem: "period_close.view". Chọn Năm tài chính và Kỳ (Tháng N).

Thứ tự cố định các bước:
1. Phân bổ công cụ dụng cụ ("asset.run")
2. Phân bổ chi phí trả trước ("asset.run")
3. Khấu hao TSCĐ ("asset.run")
4. Lãi vay ("loan.run")
5. Phân bổ doanh thu nhận trước ("amortization.run")
6. Tính giá vốn ("costing.run")
7. Tỷ giá xuất quỹ ("fx.run")
8. Đánh giá lại ngoại tệ ("fx.run"), bước tùy chọn
9. Khấu trừ thuế GTGT ("tax.offset")
10. Kết chuyển ("closing.run")

Mỗi dòng có Thứ tự, Bước, Trạng thái, Lần chạy cuối (ngày giờ, người), Chứng từ (liên kết) và nút "Chạy" hoặc "Chạy lại".

Trạng thái:
- Chưa chạy.
- Đã chạy.
- Cần chạy lại: có bước đứng trước chạy thật muộn hơn, hoặc số liệu đã đổi (khấu hao, phân bổ; lãi vay tính lại khác số đã lưu; kho còn phát sinh chưa cập nhật giá vốn). Lý do hiện cạnh trạng thái, kèm thông báo "N bước cần chạy lại vì số liệu hoặc bước đứng trước đã thay đổi."
- Đã bỏ qua: chỉ với bước tùy chọn.

Cách dùng:
1. Bấm "Chạy bước tiếp theo (F9): tên bước". Khi xong hiện "Đã xong quy trình".
2. Thông báo "Đã chạy bước". Nếu bước chạy chưa hoàn tất: "Bước chạy chưa hoàn tất: lý do". Lần chạy lỗi không tính là xong; riêng giá vốn lỗi từng mặt hàng vẫn ghi nhật ký kèm cảnh báo.
3. Bước tùy chọn (Đánh giá lại ngoại tệ): bấm "Bỏ qua", xác nhận "Bỏ qua bước này?". Chỉ bỏ qua khi bước còn "Chưa chạy" ("STEP_NOT_PENDING", 409 nếu đã chạy). Bước bắt buộc không bỏ qua được ("STEP_NOT_OPTIONAL").

Lưu ý:
- Phần mềm không chặn chạy sai thứ tự; chỉ cảnh báo bằng trạng thái "Cần chạy lại".
- Chạy từng bước đòi hỏi quyền của bước; thiếu quyền: 403 "FORBIDDEN" ("Thiếu quyền …").
- Nhật ký chỉ ghi khi lần chạy ứng với kỳ tháng đầy đủ (kỳ 1 đến 12).

## 10. Khế ước vay

Menu: Khế ước vay. Quyền: xem "loan.view", tạo "loan.create", sửa "loan.update", xóa "loan.delete", chạy lãi "loan.run".

Khế ước vay cần cờ "view_payable": không có thì mọi màn khế ước đều bị chặn 403 "Không có quyền xem công nợ phải trả". Người có quyền thao tác (tạo, sửa, giải ngân, trả nợ, tất toán, tính lãi vay) mà thiếu cờ vẫn gọi được các thao tác đó, nhưng phản hồi không kèm dư nợ, lãi phải trả, đã rút, lãi từng khế ước (để trống), và thông báo lỗi vượt hạn mức, trả vượt dư nợ, chưa tất toán được không nêu số tiền.

### 10.1. Danh sách và điều khoản

Tab "Danh sách khế ước" liệt kê khế ước với dư nợ gốc, lãi phải trả và Trạng thái (Nháp, Đang hiệu lực, Đã tất toán). Bấm "Thêm" mở khế ước mới.

Tab "Điều khoản":
- Số khế ước, Tên, Bên cho vay (F4), Loại tiền (3 chữ cái), Hạn mức, Ngày ký, Ngày đáo hạn, Trạng thái, Mục đích vay, Ghi chú.
- TK gốc vay (F4, nhóm 341x), TK chi phí lãi vay (F4, tiền tố 635, 241 hoặc 627), TK lãi vay phải trả (F4, 335).
- Cơ sở ngày: 360 ngày hoặc 365 ngày.
- Hạn mức bằng 0 là không giới hạn. Giải ngân làm tổng giải ngân còn hiệu lực vượt hạn mức thì bị từ chối.

Khế ước bằng ngoại tệ cần tài khoản gốc đã bật theo dõi ngoại tệ ("LOAN_CURRENCY_NOT_TRACKED", 400). Phải lưu điều khoản trước khi giải ngân, trả nợ. Khế ước nháp không giải ngân được ("LOAN_DRAFT", 409). Đã có bút toán hoặc số dư đầu kỳ thì không đổi loại tiền, TK gốc hay xóa ("LOAN_IN_USE", 409). Khế ước loại này không sửa, xóa qua màn Hợp đồng thường.

### 10.2. Lãi suất theo hiệu lực

Tab "Lãi suất": mỗi dòng gồm ngày hiệu lực và Lãi suất (%/năm), tối đa 6 số lẻ. Mức lãi áp dụng cho từng ngày theo dòng có ngày hiệu lực gần nhất không muộn hơn ngày đó.

### 10.3. Lịch trả gốc

Tab "Lịch trả gốc": mỗi dòng ngày đến hạn, Gốc phải trả, Ghi chú; hiện Tổng gốc.

Sinh lịch đều: bấm "Sinh lịch trả gốc đều", nhập Số kỳ, Chu kỳ tháng, ngày đến hạn đầu và tổng gốc. Gốc chia đều, làm tròn xuống đồng, phần dư dồn vào kỳ cuối. Ngày đến hạn là bội số của chu kỳ tháng tính từ ngày đầu, cuối tháng giữ cuối tháng (31/01, 28/02, 31/03). Chức năng này ghi đè lịch hiện có mà không hỏi lại.

Lịch trả gốc dùng để tách nợ ngắn hạn, dài hạn trên Bảng cân đối kế toán (B01 theo TT99) và để soát khế ước quá hạn. Khế ước ngoại tệ áp tỷ lệ dài hạn của nguyên tệ vào số dư VND.

### 10.4. Giải ngân

Nút "Giải ngân" (cần "loan.update", "voucher.create" và "voucher.post"). Nhập Ngày, Số tiền giải ngân, Tài khoản ngân hàng (F4), Diễn giải. Khế ước ngoại tệ nhập thêm Tỷ giá. Phần mềm lập Giấy báo có (BC) và ghi sổ ngay, hiện "Đã lập … và ghi sổ" kèm liên kết "Xem chứng từ". Giải ngân không qua ngân hàng thì lập Phiếu kế toán (PKT) và chọn khế ước ở cột "Khế ước (F4)" (mục 10.9).

### 10.5. Trả nợ

Nút "Trả nợ" (cần "loan.update", "voucher.create" và "voucher.post"). Nhập Ngày, Trả gốc, Trả lãi, Tài khoản ngân hàng (F4), Diễn giải; ngoại tệ có thêm Tỷ giá. Phần mềm lập Giấy báo nợ (BN) và ghi sổ.

Khế ước ngoại tệ: phần gốc được ghi theo tỷ giá ghi sổ bình quân của khế ước; chênh lệch so với tỷ giá trả nợ thành một dòng VND vào tài khoản lãi hoặc lỗ tỷ giá theo quy tắc tỷ giá của hệ thống.

Số dư đầu kỳ: ở màn Số dư đầu kỳ, dòng TK 341x và 335 có ô mã khế ước ("contractCode"). Khế ước mang sang bằng DK có số đã trả = số đã trả trong hệ thống + phần chênh giữa tổng lịch và tổng đã ghi Có (nếu dương).

### 10.6. Tính lãi vay (LV)

Bước "Lãi vay" của quy trình cuối kỳ, quyền "loan.run".

Lãi kỳ = tổng theo từng ngày của dư nợ gốc cuối ngày x lãi suất năm hiệu lực / cơ sở ngày (360 hoặc 365), làm tròn một lần cho mỗi khế ước mỗi kỳ. Mọi khế ước không ở trạng thái nháp đều được tính. Chứng từ LV mỗi khế ước một cặp dòng: Nợ TK chi phí lãi vay, Có TK lãi vay phải trả (335), mang mã khế ước.

Dư nợ tính từ sổ cái theo mã khế ước. Chạy lại LV không trùng: số đổi thì đảo cũ, lập mới. Khi khế ước ngoại tệ đã hết nguyên tệ lãi, phần dư VND của 335 được kết chuyển trong LV.

Phần mềm không tự chạy lại LV khi giải ngân hoặc trả nợ lùi ngày; bước "Lãi vay" hiện "Cần chạy lại" khi số lãi tính lại khác số đã lưu.

### 10.7. Tất toán

Nút tất toán (xác nhận "Tất toán khế ước này?"). Chỉ được khi dư nợ gốc và lãi phải trả (335) bằng 0; nếu không "LOAN_OUTSTANDING" (409). Khế ước chuyển sang "Đã tất toán" và không sửa được.

### 10.8. Đánh giá lại ngoại tệ

Bước "Đánh giá lại ngoại tệ" của quy trình cuối kỳ gồm cả gốc vay và lãi phải trả của khế ước ngoại tệ. Theo TT99 chênh lệch đối ứng thẳng vào 635 hoặc 515.

### 10.9. Gắn khế ước trên chứng từ

Lưới Phiếu kế toán và Giấy báo có cột "Khế ước (F4)" khi dòng dùng TK 341x hoặc 335. Cột này không có trên hóa đơn. Tab "Chứng từ" của khế ước liệt kê các chứng từ gắn khế ước: loại, số, ngày, trạng thái (Nháp, Đã ghi sổ, Đã đảo, Đã hủy), diễn giải.

### 10.10. Sổ theo dõi khế ước vay

Tab "Sổ theo dõi khế ước vay". Chọn khoảng ngày. Cột: Dư nợ đầu kỳ, Giải ngân, Trả gốc, Dư nợ cuối kỳ (VND), Lãi phải trả đầu kỳ, Lãi dự tính (LV), Lãi trích khác, Lãi đã trả, Lãi phải trả cuối kỳ, Kỳ trả gốc kế tiếp. Khế ước ngoại tệ có thêm bốn cột nguyên tệ (4 số lẻ). Quyền "report.view"; xuất tệp cần "report.print".

Lãi dự tính xem trước theo tháng dương lịch không ghi sổ qua `GET /api/loans/:id/interest-preview`.

## 11. Sổ và báo cáo tài sản

Menu: Tài sản > Báo cáo tài sản. Quyền xem "report.view"; "In PDF" và "Xuất Excel" cần thêm "report.print". Bộ lọc được ghi nhớ.

| Tab | Nội dung |
|---|---|
| Sổ TSCĐ | Sổ tài sản cố định (S21-DN, S09-DNN) |
| Thẻ TSCĐ | Thẻ từng tài sản đến một ngày (S23-DN, S11-DNN) |
| Sổ theo nơi sử dụng | Theo bộ phận, dựng từ sự kiện điều chuyển (S22-DN, S10-DNN) |
| Bảng khấu hao | Theo tài khoản chi phí, cột "Chưa phân bổ"; mẫu 06-TSCĐ |
| Tăng giảm tài sản | Theo nhóm TSCĐ, CCDC, Chi phí trả trước |
| Sổ CCDC, trả trước | Ban đầu - phân bổ - ghi giảm = còn lại |
| Bảng phân bổ CCDC | Phân bổ theo kỳ (phần CCDC của mẫu 07-VT) |

Ghi chú:
- Số mẫu chỉ in cho chế độ TT99 và TT133; TT200 và TT58 không in dòng "Mẫu số". Bảng phân bổ CCDC, báo cáo tăng giảm và sổ CCDC, CPTT in bố cục quản trị, không có số mẫu.
- Bảng khấu hao và bảng phân bổ chọn Năm, Kỳ (1 đến 12). Tab Thẻ chọn "Tính đến ngày" và tài sản ("Chọn tài sản để xem thẻ tài sản" nếu chưa chọn).
- Mẫu 06-TSCĐ: I + II - III = IV; số tiền chia theo phân bổ chi phí hiệu lực. Tài sản ghi giảm giữa tháng khi tính theo số ngày thực tế: khấu hao từ đầu tháng đến trước ngày ghi giảm nằm trong chứng từ TS và được cộng vào số khấu hao của tháng đó, nên IV khớp phát sinh Có 214 của tháng trên Sổ cái.
- Cột Ghi chú của S10-DNN chưa có (để trống).

## 12. Kiểm kê tài sản và biên bản

### 12.1. Kiểm kê

Menu: Tài sản > Kiểm kê tài sản.

1. Chọn Đối tượng kiểm kê (TSCĐ hoặc CCDC), Ngày kiểm kê, Bộ phận (F4, trống là toàn đơn vị). Bấm "Lập biên bản kiểm kê".
2. Bấm "Điền số sổ sách": phần mềm chụp số lượng, nguyên giá, giá trị còn lại tại ngày kiểm kê ("ASSET_COUNT_EMPTY" nếu chưa điền).
3. Nhập SL kiểm kê, Tình trạng, Ghi chú từng dòng; Ctrl+S để lưu. Nguyên giá và giá trị còn lại theo kiểm kê = số sổ x SL kiểm kê / SL sổ, làm tròn nửa lên.
4. Bấm "Hoàn thành" (xác nhận "Sau khi hoàn thành không sửa số kiểm kê được."). Cần ít nhất một dòng và nhập đủ số kiểm kê ("ASSET_COUNT_INCOMPLETE": Còn N dòng chưa nhập số kiểm kê). Biên bản đã hoàn thành không sửa, không xóa ("ASSET_COUNT_DONE", 409).

Biên bản có trạng thái Nháp, Đã hoàn thành; dòng tóm tắt số dòng thiếu, số dòng thừa. Chênh lệch không tự ghi sổ: bảng gợi ý đề nghị Ghi giảm (thiếu) hoặc Ghi tăng (thừa), bấm để mở hộp thoại biến động của thẻ.

### 12.2. In biên bản

- Biên bản kiểm kê: nút "In biên bản", cần "report.print". Kiểm kê TSCĐ in theo mẫu 05-TSCĐ (chỉ phần hiện vật). Kiểm kê CCDC in "BIÊN BẢN KIỂM KÊ CÔNG CỤ, DỤNG CỤ", không có số mẫu. TT200 không in số mẫu.
- Biên bản biến động TSCĐ: nút "In biên bản" ở dòng biến động. 01-TSCĐ cho ghi tăng, 02-TSCĐ cho ghi giảm lý do thanh lý, 04-TSCĐ cho đánh giá lại. Chỉ cho TSCĐ; mẫu không khớp biến động trả 400, biến động đã hủy trả 409.

## 13. Soát lỗi mới

Màn hình Soát lỗi có thêm sáu quy tắc:

| Mã | Mức | Tên quy tắc |
|---|---|---|
| TS_THIEU_TAI_SAN | Lỗi | Dòng tài khoản tài sản thiếu tài sản |
| TS_HAO_MON_VUOT | Lỗi | Hao mòn vượt nguyên giá |
| TS_DA_GIAM_CON_GIA_TRI | Lỗi | Tài sản đã ghi giảm còn giá trị trên sổ |
| TS_KHAU_HAO_CAN_CHAY_LAI | Cảnh báo | Khấu hao hoặc phân bổ cần chạy lại |
| KU_CHUA_TINH_LAI | Cảnh báo | Khế ước vay chưa tính lãi kỳ đã kết chuyển |
| KU_QUA_HAN | Cảnh báo | Khế ước vay quá hạn trả gốc |

Cách xử lý:
- TS_THIEU_TAI_SAN: mở chứng từ, chọn thẻ ở cột "Tài sản (F4)".
- TS_HAO_MON_VUOT, TS_DA_GIAM_CON_GIA_TRI: kiểm tra các biến động đánh giá lại, ghi giảm của thẻ.
- TS_KHAU_HAO_CAN_CHAY_LAI, KU_CHUA_TINH_LAI: vào Quy trình cuối kỳ và chạy lại bước tương ứng.
- KU_QUA_HAN: có kỳ trả gốc đến hạn (ngày đến hạn nhỏ hơn ngày kiểm tra) mà chưa trả; trả nợ hoặc cập nhật lịch.

Hai quy tắc KU_* chỉ hiện với người có cờ "view_payable". Bốn quy tắc TS_* không có cờ nhạy cảm.

## 14. Phân quyền

- Tài sản: "asset.view", "asset.create", "asset.update", "asset.delete"; chạy khấu hao, phân bổ: "asset.run".
- Khế ước: "loan.view", "loan.create", "loan.update", "loan.delete", "loan.run"; giải ngân, trả nợ còn cần "voucher.create" và "voucher.post" (chứng từ ghi sổ ngay); cờ "view_payable" bắt buộc cho mọi thao tác đọc khế ước, thiếu cờ thì phản hồi của thao tác ghi không kèm số liệu khế ước.
- Quy trình cuối kỳ: "period_close.view" để xem, thêm quyền của từng bước để chạy.
- Báo cáo: "report.view"; in, xuất tệp: "report.print".
- Số dư đầu kỳ tài sản: "opening_balance.view", "opening_balance.update".
- Ghi lùi vào kỳ khóa sổ: "voucher.backdate_locked".

## 15. Hạn chế đã biết

### Ngoài phạm vi giai đoạn này

- Khấu hao số dư giảm dần và theo sản lượng (dự kiến giai đoạn 7).
- Bất động sản đầu tư (TK 217, 2147) và tài sản sinh học (TK 215).
- Khung thời gian khấu hao theo TT45/2013 và văn bản thay thế: chờ văn bản gốc; phần mềm không gợi ý, không kiểm tra thời gian sử dụng.
- Khế ước cho vay (TK 1283) và lãi nhập gốc.

### Tài sản

- Xóa thẻ, khóa loại hoặc tài khoản khi đồng thời có người ghi sổ có thể không chặn kịp.
- Ô F4 tra tài sản chưa lọc theo loại thẻ.
- Nhiều dòng đầu kỳ cùng tài khoản thẻ có thể làm phần dư âm ("VOUCHER_UNBALANCED"). Dòng DK đã đảo hoặc hủy vẫn tính là "ASSET_IN_USE". Nhập Excel không kiểm số dư; CCDC, CPTT bỏ trống thì nhập ngầm 0.
- Hủy ghi giảm chuyển CCDC không xét hết các biến động sau của thẻ CCDC mới ngoài trường hợp đã chặn ở mục 6.
- Báo cáo 06-TSCĐ tính lại từ phân bổ, nên lệch nếu sửa phân bổ sau khi chạy kỳ. Tiêu đề nhiều tầng của mẫu được làm phẳng; in TT99 có số liệu chưa kiểm thử.
- Báo cáo tăng giảm: CCDC, CPTT lẫn lần phân bổ trong cột "Nguyên giá giảm".
- Quy tắc TS_DA_GIAM_CON_GIA_TRI có thể báo sớm khi đặt trạng thái trước khi chứng từ ghi sổ.
- Danh sách kiểm kê tải chậm khi có nhiều biên bản; PDF biên bản chỉ kiểm thử bằng HTML.
- Nhập lại form thẻ khi làm mới chi tiết sẽ mất thay đổi chưa lưu.
- Đánh giá lại chế độ TT133: phải tự nhập TK chênh lệch (mục 6).

### Khế ước vay

- Hợp đồng không kiểm tài khoản và loại tiền của dòng đầu kỳ.
- Hạn mức ngoại tệ chỉ nhận số nguyên.
- Trả lãi không bị chặn bởi dư TK 335.
- Dư nợ âm thì lãi tính bằng 0. Lãi vay chưa có chiều chi phí (bộ phận, vụ việc) cho TK 627, 241.
- Không tự chạy lại LV khi giải ngân hoặc trả nợ lùi ngày.
- Sổ khế ước tính dòng đánh giá lại (DG) vào cột giải ngân hoặc trả gốc (tổng vẫn khớp).
- "Sinh lịch trả gốc đều" ghi đè không hỏi lại. Số lẻ hiển thị 4 chữ số cho mọi loại tiền. Không có "view_payable" thì cả màn khế ước bị chặn.

### Quy trình cuối kỳ

- Chạy giá vốn nhiều tháng một lượt chỉ ghi nhật ký tháng cuối.
- Bước tùy chọn đã chạy rồi không bỏ qua được.
- Phần mềm chỉ cảnh báo, không chặn chạy sai thứ tự bước.
