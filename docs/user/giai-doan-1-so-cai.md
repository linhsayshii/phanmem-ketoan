# Sổ cái và báo cáo (giai đoạn 1)

Tài liệu ngắn cho kế toán viên và kế toán trưởng: nhập Phiếu kế toán, ghi sổ, khóa sổ, kết chuyển cuối năm, xem và in sổ sách. Phần đăng nhập, danh mục và hệ thống tài khoản xem ở `giai-doan-0-bat-dau.md`.

## Dữ liệu mẫu để thử

- Chạy `pnpm db:seed:xyz` (trong Docker: `docker compose exec -T api node --import tsx packages/db/src/seed/dich-vu-xyz.ts`) để có công ty "Công ty TNHH Dịch vụ Tư vấn XYZ" (mã `XYZ`, đăng nhập `admin` / `Matkhau1!`, đổi mật khẩu ngay khi dùng thật).
- Công ty dịch vụ tư vấn, năm 2026: số dư đầu kỳ 01/01 gồm tiền mặt 200 triệu, tiền gửi 800 triệu, vốn góp 1.000 triệu; mỗi tháng có 7 phiếu (doanh thu 100 triệu + thuế GTGT 10 triệu, thuê văn phòng, văn phòng phẩm, thu tiền, trả nhà cung cấp, tính và chi lương); cuối năm có khấu trừ thuế GTGT 30 triệu, thuế TNDN 60 triệu và các phiếu kết chuyển.
- Kết quả để đối chiếu: doanh thu 1.200 triệu, lợi nhuận trước thuế 300 triệu, sau thuế 240 triệu; tổng tài sản 1.390 triệu = nợ phải trả 150 triệu + vốn chủ sở hữu 1.240 triệu. Chạy lại lệnh trên không tạo thêm công ty.

## Phiếu kế toán

- Menu Chứng từ có một mục cho từng loại: Phiếu thu, Phiếu chi, Giấy báo Có, Giấy báo Nợ, Chuyển tiền nội bộ, Quyết toán tạm ứng, Bù trừ công nợ, Phiếu kế toán. Mỗi mục là danh sách chỉ gồm loại đó; Insert ở danh sách mở phiếu mới cùng loại. Phiếu thu/chi và giấy báo có thêm người nộp/nhận, địa chỉ, số chứng từ gốc kèm theo, mục đích (chọn "Thu tiền khách hàng" thì dòng đối ứng tự điền TK 131 theo chế độ kế toán của năm) và tài khoản ngân hàng cho giấy báo. Nhập số tiền ở dòng quỹ (1111) thì dòng đối ứng đầu tiên tự lấy cùng số tiền ở bên ngược lại.
- Vào Chứng từ → Phiếu kế toán, bấm "Thêm (Insert)". Nhập ngày hạch toán, diễn giải rồi các dòng định khoản trên lưới; tổng Nợ phải bằng tổng Có mới ghi sổ được.
- Phím tắt: Enter hoặc Tab sang ô kế tiếp (Enter ở ô cuối thêm dòng mới), F4 tra cứu tài khoản hoặc đối tượng, Ctrl+Insert chèn dòng, Ctrl+Delete xóa dòng, Ctrl+S lưu nháp, F9 lưu và ghi sổ.
- Tài khoản công nợ (131, 331...) bắt buộc có đối tượng; không định khoản vào tài khoản tổng hợp (có tài khoản con).
- Có thể đính kèm tệp, nhân bản phiếu sang ngày mới và in phiếu (PDF).

## Số dư đầu kỳ

- Vào Sổ cái → Số dư đầu kỳ, chọn năm tài chính đầu tiên của công ty, nhập số dư từng tài khoản chi tiết (công nợ nhập theo từng đối tượng) hoặc "Nhập Excel" bằng "Tải mẫu Excel".
- Bấm "Kiểm tra" để xem lỗi (tổng Nợ khác tổng Có, nhập sai bên, thiếu đối tượng, tài khoản loại 5–9), sửa hết lỗi rồi bấm "Ghi sổ số dư đầu kỳ": hệ thống tạo một phiếu loại DK đã ghi sổ.
- Chỉ nhập cho năm đầu tiên; các năm sau số dư tự chuyển từ cuối năm trước. Muốn sửa, nhập lại rồi ghi sổ lần nữa (phiếu DK cũ được thay, giữ nguyên số), hoặc bấm "Bỏ ghi sổ số dư đầu kỳ" (cần quyền sửa số dư đầu kỳ và quyền bỏ ghi sổ; nút chỉ hiện khi phiếu DK của năm đang ghi sổ) để đưa phiếu DK về nháp, sửa số dư rồi ghi sổ lại. Đây là cách duy nhất bỏ ghi sổ phiếu DK; màn hình chứng từ chung không bỏ ghi sổ phiếu DK.

## Ghi sổ, bỏ ghi sổ, đảo, hủy: dùng cái nào

- Phiếu nháp chưa ghi sổ: sửa tự do; không cần nữa thì "Hủy" (số phiếu đã cấp được giữ lại, không dùng lại).
- Phiếu đã ghi sổ, kỳ còn mở: chỉ sửa diễn giải và chiều phân tích (bộ phận, vụ việc, khoản mục) tại chỗ, có ghi nhật ký. Sửa số tiền, tài khoản hoặc ngày thì "Bỏ ghi sổ", sửa rồi ghi sổ lại; dòng cũ được lưu lại trong lịch sử. Cần quyền "sửa sau ghi sổ".
- Kỳ đã khóa sổ: không bỏ ghi sổ được; lập phiếu "Đảo" (hỏi ngày hạch toán của phiếu đảo, mặc định hôm nay và không sớm hơn ngày phiếu gốc, kèm diễn giải "Đảo chứng từ … ngày …" sửa được; ghi sổ ngay, đối ứng ngược phiếu gốc) rồi nhập phiếu đúng; ghi vào ngày thuộc kỳ khóa sổ thì cần quyền ghi lùi ngày. Không xóa được phiếu đã ghi sổ.
- Kỳ khóa cứng: không sửa, không đảo, không ghi lùi vào kỳ đó, không thêm hoặc xóa chứng từ gốc đính kèm (tải về vẫn được); điều chỉnh bằng phiếu mới ở kỳ mở gần nhất ("Nhân bản sang kỳ mở").
- Đang nhập dở mà bấm Đảo, Bỏ ghi sổ, Nhân bản hoặc Hủy thì hệ thống hỏi "Bỏ thay đổi chưa lưu?" trước; màn hình Kết chuyển cuối kỳ hỏi tương tự khi đổi ngày kết chuyển lúc sơ đồ đang sửa dở.
- Phiếu do hệ thống sinh (KC/PB của màn hình Kết chuyển, DK của màn hình Số dư đầu kỳ) không bỏ ghi sổ, hủy, xóa hay sửa dòng được ở màn hình Phiếu kế toán, và không lập tay phiếu KC hay DK: kết chuyển dùng "Chạy lại (đảo cũ)", số dư đầu kỳ sửa ở màn hình Số dư đầu kỳ. Phiếu PB vẫn lập tay được. Một phiếu tối đa 5.000 dòng.

## Khóa sổ ba mức

- Vào Sổ cái → Kỳ kế toán và khóa sổ, chọn năm. Mỗi kỳ có ba mức: Mở (ghi bình thường); "Khóa sổ" (chặn ghi, riêng người có quyền ghi lùi ngày vẫn ghi được); "Khóa cứng" (chặn tuyệt đối).
- Khóa cứng phải đi lần lượt từ kỳ 0 (mở sổ) tới kỳ sau, không còn phiếu nháp trong kỳ; hệ thống tính chuỗi hash cho phiếu của kỳ, "Kiểm tra hash" báo phiếu nào bị can thiệp. Bỏ khóa cứng cần quyền riêng và phải bỏ từ kỳ sau trở về trước.
- Cột "Phần hành khóa" khóa riêng một phần hành (ví dụ phần hành chung) mà vẫn cho ghi các phần hành khác.

## Kết chuyển cuối kỳ

- Vào Sổ cái → Kết chuyển cuối kỳ. Sơ đồ mặc định gồm: kết chuyển giảm trừ doanh thu, doanh thu và thu nhập khác, giá vốn và chi phí sang 911, rồi 911 sang 4212 (lợi nhuận năm nay); bước 4212 sang 4211 chạy ngày đầu năm sau. Sửa sơ đồ được (thêm bước chuyển hoặc phân bổ theo tỷ lệ), "Nạp lại mẫu" để quay về mặc định.
- Chọn ngày kết chuyển (thường 31/12), bấm "Chạy tất cả bước cuối kỳ" hoặc "Chạy" từng bước. Mỗi bước sinh phiếu KC/PB thật, có số, đã ghi sổ.
- Phát sinh thêm sau khi kết chuyển thì bấm "Chạy lại (đảo cũ)": phiếu cũ của đúng bước đó bị đảo rồi tính lại, không sửa đè. Các bước sau của sơ đồ đã chạy cùng ngày không tự chạy lại (số của chúng còn theo số dư cũ): màn hình liệt kê tên các bước đó, hãy chạy lại từng bước hoặc bấm "Chạy tất cả bước cuối kỳ". Trước khi kết chuyển nên ghi sổ hết phiếu nháp.
- Mỗi chế độ kế toán (TT200, TT99, TT133...) có sơ đồ kết chuyển riêng, và sơ đồ hiện theo chế độ của kỳ chứa ngày kết chuyển. Tạo năm tài chính theo chế độ mới chỉ thêm sơ đồ mặc định của chế độ đó (nếu công ty chưa có), không đụng sơ đồ chế độ cũ nên vẫn kết chuyển được năm cũ. Chạy một bước vào ngày thuộc kỳ của chế độ khác sẽ bị từ chối; "Nạp lại mẫu" chỉ nạp lại sơ đồ của chế độ đang xem.

## Xem và in sổ sách, báo cáo

- Báo cáo → Sổ sách kế toán: Sổ Nhật ký chung, Sổ Cái (theo chứng từ, theo tài khoản con hoặc dạng chữ T), Sổ chi tiết tài khoản (lọc theo đối tượng, khoản mục, vụ việc, bộ phận), Bảng cân đối số phát sinh (tổng cộng ba cặp cột Nợ/Có phải cân). Nhấn đúp hoặc Enter trên một dòng để truy ngược về phiếu hoặc sổ của tài khoản.
- "In PDF" và "Xuất Excel" theo mẫu của thông tư đang áp dụng; "In cả bộ sổ năm…" in liên tục nhiều sổ và báo cáo của cả năm thành một PDF hoặc một Excel nhiều sheet (cần các cờ xem công nợ và giá vốn).
- Trong giai đoạn 1, ba cờ nhạy cảm (xem công nợ phải thu, công nợ phải trả, giá vốn) bảo vệ sổ sách, báo cáo và số dư: sổ của tài khoản công nợ hoặc 632 cần cờ tương ứng; Sổ Nhật ký chung, Bảng cân đối số phát sinh và bộ sổ năm có các sổ này cần cả ba cờ; số dư theo tài khoản bỏ các dòng bị che. Màn hình chứng từ, nhật ký kiểm toán và soát lỗi vẫn hiển thị dòng của các tài khoản đó.
- Sổ Nhật ký chung trên màn hình hiện tối đa 50.000 dòng đầu (có thông báo; tổng phát sinh vẫn là của cả khoảng); muốn đủ các dòng thì Xuất Excel (không bị cắt); In PDF chỉ dựng tối đa 40.000 dòng nên khoảng ngày lớn hơn thế phải thu hẹp lại.
- Báo cáo → Báo cáo tài chính (B01, B02, B03): mỗi dòng là công thức trên tài khoản. Bộ mẫu B01, B02, B03 của TT99 (Phụ lục IV Thông tư 99/2025) và TT133 (Phụ lục 2 Thông tư 133/2016) đã nhập từ văn bản gốc; "Nạp lại mẫu" để lấy bộ mẫu theo chế độ. Có thể sửa ở "Sửa công thức" (cộng trừ tiền tố tài khoản `111+112`, loại trừ `131(1312)`, đối ứng `N911/C632`, dòng khác `[100]`).
- Giới hạn của báo cáo tài chính (các chỉ tiêu gần đúng, cần kế toán trưởng đối chiếu): sổ cái không có kỳ hạn còn lại nên TT99 B01 các dòng dài hạn chỉ lấy tài khoản chỉ thuộc nhóm dài hạn, tài khoản dùng chung vào dòng ngắn hạn và nhiều dòng dài hạn (như 112, 124-126, 211-216, 331-343) để 0; B02 TT99 dòng 21, 24 để 0 và 70, 71 (lãi trên cổ phiếu) để 0, nhập tay; B02 TT133 dòng 31, 32 lấy gộp 711 và 811; B03 (cả hai chế độ) lập theo phương pháp trực tiếp từ cặp tài khoản đối ứng nên một số khoản (lãi vay trả, mua TSCĐ qua công nợ, thanh lý qua 711, cổ tức qua 3388) rơi vào dòng gần nhất thay vì dòng đúng văn bản; B01 chưa kết chuyển thì tổng tài sản lệch nguồn vốn bằng lãi lỗ chưa kết chuyển. Danh sách đầy đủ ở `packages/coa-data/data/reports/status.json`. Có cột so sánh năm trước và truy ngược từng chỉ tiêu về tài khoản.

## Soát lỗi dữ liệu

- Tiện ích → Soát lỗi dữ liệu (cần quyền chạy soát lỗi): chọn khoảng ngày ghi sổ rồi bấm "Soát lỗi". Các quy tắc có sẵn: chứng từ không cân, chứng từ nháp không có dòng, dòng công nợ thiếu đối tượng, tài khoản tổng hợp trên dòng định khoản, số dư trái loại dư, chứng từ nháp trong kỳ đã khóa. Bỏ tích quy tắc nào thì lần soát này không chạy quy tắc đó.
- Kết quả gom theo quy tắc: mỗi dòng có chứng từ, tham chiếu, chi tiết, hướng dẫn sửa và liên kết "Sửa chứng từ" để mở phiếu. Mỗi quy tắc hiện tối đa 1.000 dòng đầu (có cảnh báo khi bị cắt); quy tắc tự báo lỗi thì hiện dòng "Quy tắc lỗi" thay vì làm hỏng cả lần soát; mỗi công ty chỉ soát một lần tại một thời điểm.
- Quy tắc do hệ thống cung cấp: không thêm quy tắc mới bằng SQL, không xóa quy tắc (chỉ tắt), câu SQL chỉ để xem. Người có quyền quản lý quy tắc (`data_check.manage`) bật/tắt từng quy tắc bằng công tắc ở cột "Bật" hoặc sửa tên, mức (lỗi hay cảnh báo), thông điệp và hướng dẫn sửa; người khác chỉ xem.

## Xuất dữ liệu cho cơ quan thẩm quyền

- Tiện ích → "Xuất dữ liệu cho cơ quan thẩm quyền": chọn khoảng ngày, tải gói zip gồm CSV, sổ PDF và bảng băm `MANIFEST.sha256`. Cần quyền xuất dữ liệu và cả ba cờ nhạy cảm (xem công nợ phải thu, công nợ phải trả, giá vốn) vì gói chứa Sổ Nhật ký chung và Sổ Cái của mọi tài khoản; thiếu một cờ thì không xuất gì.
- Một tệp PDF chỉ dựng được tối đa 40.000 dòng: tệp quá lớn được bỏ riêng khỏi gói (các tệp còn lại vẫn xuất) và `README.txt` có mục "CÁC TỆP BỊ BỎ KHỎI GÓI" liệt kê từng tệp kèm lý do. Khi đó in sổ đó riêng theo khoảng ngày ngắn hơn hoặc xuất Excel; các tệp CSV luôn đủ.
- Mỗi lần xuất ghi hai dòng vào Nhật ký kiểm toán: `export` khi đọc xong dữ liệu và `export_completed` khi gói đã dựng xong, kèm mã băm SHA-256 của `MANIFEST.sha256` và của tệp zip để đối chiếu về sau. Chi tiết nội dung gói và cách kiểm tra toàn vẹn xem `xuat-du-lieu-co-quan-thue.md`.

## Giới hạn của giai đoạn 1

- Tài khoản theo dõi chi tiết vật tư hoặc tài sản cố định (hệ TT133 hiện có: 152–157 và 2111–2113) chưa ghi sổ được cho tới giai đoạn 2: định khoản vào đó bị từ chối vì thiếu vật tư/tài sản, và số dư đầu kỳ của chúng không nhập được ở màn hình Số dư đầu kỳ; sẽ nhập ở phân hệ kho và tài sản của giai đoạn 2.
- Đổi chế độ kế toán giữa hai năm (ví dụ TT200 sang TT99) cần bước chuyển đổi số dư giữa hai hệ tài khoản, chưa có. Sau khi đổi, cột so sánh (số đầu năm của B01, năm trước của B02/B03) hiện "—" kèm cảnh báo thay vì số sai, và số dư cuối năm cũ không tự chuyển sang tài khoản của hệ mới.
- Hệ tài khoản TT99 đã nhập từ Phụ lục II Thông tư 99/2025 (công ty mới chọn TT99 được ngay); công ty mẫu XYZ vẫn dùng TT133 vì dữ liệu mẫu dùng tài khoản của TT133.
- Chọn loại tiền khác VND ở tiêu đề chứng từ thì hiện ô Tỷ giá (nhập tới 10 chữ số lẻ) và cột Nguyên tệ (Nợ dương, Có âm) để nhập; bảng tỷ giá tự điền theo ngày chưa có (làm trong giai đoạn 2). Một dòng VND tối đa 9.999.999.999.999.999 đồng (vượt thì bị từ chối).
