# Sổ cái và báo cáo (giai đoạn 1)

Tài liệu ngắn cho kế toán viên và kế toán trưởng: nhập Phiếu kế toán, ghi sổ, khóa sổ, kết chuyển cuối năm, xem và in sổ sách. Phần đăng nhập, danh mục và hệ thống tài khoản xem ở `giai-doan-0-bat-dau.md`.

## Dữ liệu mẫu để thử

- Chạy `pnpm db:seed:xyz` (trong Docker: `docker compose exec -T api node --import tsx packages/db/src/seed/dich-vu-xyz.ts`) để có công ty "Công ty TNHH Dịch vụ Tư vấn XYZ" (mã `XYZ`, đăng nhập `admin` / `Matkhau1!`, đổi mật khẩu ngay khi dùng thật).
- Công ty dịch vụ tư vấn, năm 2026: số dư đầu kỳ 01/01 gồm tiền mặt 200 triệu, tiền gửi 800 triệu, vốn góp 1.000 triệu; mỗi tháng có 7 phiếu (doanh thu 100 triệu + thuế GTGT 10 triệu, thuê văn phòng, văn phòng phẩm, thu tiền, trả nhà cung cấp, tính và chi lương); cuối năm có khấu trừ thuế GTGT 30 triệu, thuế TNDN 60 triệu và các phiếu kết chuyển.
- Kết quả để đối chiếu: doanh thu 1.200 triệu, lợi nhuận trước thuế 300 triệu, sau thuế 240 triệu; tổng tài sản 1.390 triệu = nợ phải trả 150 triệu + vốn chủ sở hữu 1.240 triệu. Chạy lại lệnh trên không tạo thêm công ty.

## Phiếu kế toán

- Vào Chứng từ → Phiếu kế toán, bấm "Thêm (Insert)". Nhập ngày hạch toán, diễn giải rồi các dòng định khoản trên lưới; tổng Nợ phải bằng tổng Có mới ghi sổ được.
- Phím tắt: Enter hoặc Tab sang ô kế tiếp (Enter ở ô cuối thêm dòng mới), F4 tra cứu tài khoản hoặc đối tượng, Ctrl+Insert chèn dòng, Ctrl+Delete xóa dòng, Ctrl+S lưu nháp, F9 lưu và ghi sổ.
- Tài khoản công nợ (131, 331...) bắt buộc có đối tượng; không định khoản vào tài khoản tổng hợp (có tài khoản con).
- Có thể đính kèm tệp, nhân bản phiếu sang ngày mới và in phiếu (PDF).

## Số dư đầu kỳ

- Vào Sổ cái → Số dư đầu kỳ, chọn năm tài chính đầu tiên của công ty, nhập số dư từng tài khoản chi tiết (công nợ nhập theo từng đối tượng) hoặc "Nhập Excel" bằng "Tải mẫu Excel".
- Bấm "Kiểm tra" để xem lỗi (tổng Nợ khác tổng Có, nhập sai bên, thiếu đối tượng, tài khoản loại 5–9), sửa hết lỗi rồi bấm "Ghi sổ số dư đầu kỳ": hệ thống tạo một phiếu loại DK đã ghi sổ.
- Chỉ nhập cho năm đầu tiên; các năm sau số dư tự chuyển từ cuối năm trước. Muốn sửa, nhập lại rồi ghi sổ lần nữa (phiếu DK cũ được thay, giữ nguyên số).

## Ghi sổ, bỏ ghi sổ, đảo, hủy: dùng cái nào

- Phiếu nháp chưa ghi sổ: sửa tự do; không cần nữa thì "Hủy" (số phiếu đã cấp được giữ lại, không dùng lại).
- Phiếu đã ghi sổ, kỳ còn mở: chỉ sửa diễn giải và chiều phân tích (bộ phận, vụ việc, khoản mục) tại chỗ, có ghi nhật ký. Sửa số tiền, tài khoản hoặc ngày thì "Bỏ ghi sổ", sửa rồi ghi sổ lại; dòng cũ được lưu lại trong lịch sử. Cần quyền "sửa sau ghi sổ".
- Kỳ đã khóa sổ: không bỏ ghi sổ được; lập phiếu "Đảo" (ghi sổ ngay với ngày hôm nay, đối ứng ngược phiếu gốc) rồi nhập phiếu đúng; ghi vào ngày thuộc kỳ khóa sổ thì cần quyền ghi lùi ngày. Không xóa được phiếu đã ghi sổ.
- Kỳ khóa cứng: không sửa, không đảo, không ghi lùi vào kỳ đó; điều chỉnh bằng phiếu mới ở kỳ mở gần nhất.

## Khóa sổ ba mức

- Vào Sổ cái → Kỳ kế toán và khóa sổ, chọn năm. Mỗi kỳ có ba mức: Mở (ghi bình thường); "Khóa sổ" (chặn ghi, riêng người có quyền ghi lùi ngày vẫn ghi được); "Khóa cứng" (chặn tuyệt đối).
- Khóa cứng phải đi lần lượt từ kỳ 0 (mở sổ) tới kỳ sau, không còn phiếu nháp trong kỳ; hệ thống tính chuỗi hash cho phiếu của kỳ, "Kiểm tra hash" báo phiếu nào bị can thiệp. Bỏ khóa cứng cần quyền riêng và phải bỏ từ kỳ sau trở về trước.
- Cột "Phần hành khóa" khóa riêng một phần hành (ví dụ phần hành chung) mà vẫn cho ghi các phần hành khác.

## Kết chuyển cuối kỳ

- Vào Sổ cái → Kết chuyển cuối kỳ. Sơ đồ mặc định gồm: kết chuyển giảm trừ doanh thu, doanh thu và thu nhập khác, giá vốn và chi phí sang 911, rồi 911 sang 4212 (lợi nhuận năm nay); bước 4212 sang 4211 chạy ngày đầu năm sau. Sửa sơ đồ được (thêm bước chuyển hoặc phân bổ theo tỷ lệ), "Nạp lại mẫu" để quay về mặc định.
- Chọn ngày kết chuyển (thường 31/12), bấm "Chạy tất cả bước cuối kỳ" hoặc "Chạy" từng bước. Mỗi bước sinh phiếu KC/PB thật, có số, đã ghi sổ.
- Phát sinh thêm sau khi kết chuyển thì bấm "Chạy lại (đảo cũ)": phiếu cũ bị đảo rồi tính lại, không sửa đè. Trước khi kết chuyển nên ghi sổ hết phiếu nháp.

## Xem và in sổ sách, báo cáo

- Báo cáo → Sổ sách kế toán: Sổ Nhật ký chung, Sổ Cái (theo chứng từ, theo tài khoản con hoặc dạng chữ T), Sổ chi tiết tài khoản (lọc theo đối tượng, khoản mục, vụ việc, bộ phận), Bảng cân đối số phát sinh (tổng cộng ba cặp cột Nợ/Có phải cân). Nhấn đúp hoặc Enter trên một dòng để truy ngược về phiếu hoặc sổ của tài khoản.
- "In PDF" và "Xuất Excel" theo mẫu của thông tư đang áp dụng; "In cả bộ sổ năm…" in liên tục nhiều sổ và báo cáo của cả năm thành một PDF hoặc một Excel nhiều sheet (cần các cờ xem công nợ và giá vốn).
- Báo cáo → Báo cáo tài chính (B01, B02, B03): mỗi dòng là công thức trên tài khoản. Bộ mẫu TT99 và TT133 chưa được nhập vì chờ văn bản gốc, nên công ty chưa có sẵn dòng báo cáo: tự định nghĩa ở "Sửa công thức" (cộng trừ tiền tố tài khoản `111+112`, loại trừ `131(1312)`, đối ứng `N911/C632`, dòng khác `[100]`) hoặc chờ bộ mẫu chính thức rồi "Nạp lại mẫu". Có cột so sánh năm trước và truy ngược từng chỉ tiêu về tài khoản.

## Soát lỗi dữ liệu

- Tiện ích → Soát lỗi dữ liệu, chọn khoảng ngày ghi sổ rồi bấm "Soát lỗi". Các quy tắc có sẵn: chứng từ không cân, chứng từ nháp không có dòng, dòng công nợ thiếu đối tượng, tài khoản tổng hợp trên dòng định khoản, số dư trái loại dư, chứng từ nháp trong kỳ đã khóa.
- Mỗi lỗi có thông điệp, mức (lỗi hoặc cảnh báo) và hướng dẫn sửa; bấm "Sửa chứng từ" để mở phiếu. Người có quyền quản lý quy tắc đổi được tên, mức, thông điệp và bật hoặc tắt từng quy tắc; câu SQL chỉ xem, không sửa.

## Xuất dữ liệu cho cơ quan thẩm quyền

- Tiện ích → "Xuất dữ liệu cho cơ quan thẩm quyền": chọn khoảng ngày, tải gói zip gồm CSV, sổ PDF và bảng băm `MANIFEST.sha256`. Cần quyền xuất và đủ ba cờ nhạy cảm. Chi tiết và cách kiểm tra toàn vẹn xem `xuat-du-lieu-co-quan-thue.md`.
