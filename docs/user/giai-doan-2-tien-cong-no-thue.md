# Tiền, công nợ, hóa đơn và thuế GTGT (giai đoạn 2)

Giai đoạn 2 thêm các nghiệp vụ hằng ngày của kế toán tiền và kế toán thuế: phiếu thu, phiếu chi, giấy báo ngân hàng, sổ quỹ, kiểm kê quỹ, công nợ phải thu và phải trả, tỷ giá ngoại tệ, hóa đơn dịch vụ mua và bán, bảng kê hóa đơn và tờ khai 01/GTGT. Tài liệu này mô tả đúng những gì phần mềm đang làm. Các việc chưa làm được nằm ở mục cuối, "Giới hạn hiện tại".

Các phím tắt vẫn như giai đoạn 1: Enter/Tab sang ô kế tiếp, F4 tra cứu danh mục, Ctrl+S lưu, F9 ghi sổ, Insert thêm dòng, Ctrl+Insert và Ctrl+Delete thêm và xóa dòng trên lưới. Các màn hình nhập liệu mới (hóa đơn, kiểm kê quỹ, đối trừ, nhập từ Excel) dùng cùng các phím đó.

## Phân quyền cần biết trước

- Giai đoạn này thêm 22 quyền mới (xem, tạo, sửa, xóa cho kiểm kê quỹ, đối trừ, phân bổ, tờ khai thuế…). Vai trò hệ thống đã được cấp các quyền thường dùng.
- Vai trò Kế toán viên mặc định không có năm quyền nhạy cảm: chạy tỷ giá (`fx.run`), chốt tờ khai (`tax_return.finalize`), khấu trừ thuế cuối kỳ (`tax.offset`), chạy phân bổ (`amortization.run`) và khử trùng chứng từ (`dedupe.run`). Quản trị viên cấp thêm cho người cần dùng.
- Số liệu công nợ phải thu, công nợ phải trả và giá vốn vẫn bị chặn ở máy chủ theo các cờ `view_receivable`, `view_payable`, `view_cost`. Người không có cờ không xem được sổ quỹ chứa tài khoản đó, báo cáo công nợ tương ứng, và không chọn được chứng từ công nợ để đối trừ.
- Mọi loại chứng từ dùng chung nhóm quyền `voucher.*` (xem Giới hạn hiện tại).

## Quỹ và ngân hàng: phiếu thu, phiếu chi, giấy báo, chuyển tiền

Các chứng từ nằm trong menu Chứng từ: Phiếu thu (PT), Phiếu chi (PC), Giấy báo Có (BC), Giấy báo Nợ (BN), Chuyển tiền nội bộ (CT), Quyết toán tạm ứng (QTU), Bù trừ công nợ (BT) và Phiếu kế toán. Mỗi màn hình có danh sách (lọc theo khoảng ngày, trạng thái, ô tìm "Số, diễn giải, đối tượng"; nút Thêm hoặc phím Insert; Enter hoặc nhấn đúp để mở một dòng) và form chứng từ.

- Tiêu đề phiếu thu và phiếu chi gồm: Ngày hạch toán, Ngày chứng từ, Đối tượng, Người nộp tiền (phiếu thu) hoặc Người nhận tiền (phiếu chi), Địa chỉ, Số chứng từ gốc kèm theo, Mục đích, Loại tiền, Tỷ giá, Lý do nộp hoặc Lý do chi.
- Phiếu thu và phiếu chi mới có sẵn dòng 1 là tài khoản 1111. Nhập số tiền ở dòng quỹ thì số tiền tự chép sang dòng đối ứng đầu tiên.
- Mục đích điền sẵn tài khoản đối ứng ở dòng 2. Phiếu thu và Giấy báo Có: "Thu tiền khách hàng" (131, bắt buộc có đối tượng), "Thu hoàn ứng" (141), "Thu khác" (711 hoặc 3388). Phiếu chi và Giấy báo Nợ: "Chi trả nhà cung cấp" (331, bắt buộc có đối tượng), "Chi tạm ứng", "Nộp thuế và các khoản phải nộp Nhà nước", "Nộp BHXH, BHYT, BHTN, KPCĐ", "Chi khác" (811 hoặc 3388).
- Đối tượng bắt buộc ở từng dòng đối ứng của mục đích có yêu cầu, không lấy tự động từ tiêu đề.
- Giấy báo Có và Giấy báo Nợ phải chọn Tài khoản ngân hàng ở tiêu đề. Giấy báo Nợ có thêm ô "Tài khoản ngân hàng của đối tượng" (để in ủy nhiệm chi); tài khoản này phải thuộc đúng đối tượng của chứng từ. Trên lưới có cột "TK ngân hàng (F4)": để trống là dùng tài khoản ngân hàng ở tiêu đề.
- Chuyển tiền nội bộ cần "Tài khoản ngân hàng" và "Tài khoản ngân hàng nhận"; hai tài khoản phải khác nhau.
- Loại tiền khác VND: lưới có thêm cột "Nguyên tệ (Nợ +, Có −)", tỷ giá nhập tới 10 chữ số thập phân. Với phiếu chi, giấy báo Nợ và chuyển tiền nội bộ, khi ô tỷ giá còn trống, phần mềm điền sẵn tỷ giá xuất quỹ bình quân di động; nếu bạn đã sửa tay thì không bị ghi đè lại.
- Dưới tiêu đề có nhãn "Tồn quỹ" (phiếu thu, phiếu chi) hoặc "Số dư tiền gửi" (giấy báo) cuối ngày hạch toán, kèm "(chưa kể phiếu này)" khi chứng từ chưa ghi sổ. Nhãn đỏ khi số dư âm.
- Khi ghi sổ làm tồn quỹ hoặc số dư tiền gửi âm, hành vi theo tùy chọn Hệ thống > Thông tin công ty > tab "Tùy chọn hệ thống" > "Khi ghi sổ làm tồn quỹ hoặc số dư tiền gửi âm": "Cảnh báo nhưng vẫn ghi sổ" (mặc định) hoặc "Không cho ghi sổ". Phần mềm xét số dư thấp nhất cuối ngày từ ngày hạch toán trở đi và nêu ngày âm đầu tiên. Bỏ ghi sổ và đảo cũng được kiểm tra như vậy.
- Các nút trên form: "Lưu (Ctrl+S)", "Ghi sổ (F9)", "Bỏ ghi sổ", "Đảo", "Hủy", "Nhân bản" (kỳ khóa cứng: "Nhân bản sang kỳ mở"), "In" và "Thêm tệp" (đính kèm). Chứng từ đã ghi sổ chỉ sửa được diễn giải, bộ phận, vụ việc, khoản mục. Chọn dùng bỏ ghi sổ, đảo hay chứng từ điều chỉnh như đã nêu ở tài liệu giai đoạn 1.
- Các loại chứng từ do hệ thống sinh (số dư đầu kỳ, kết chuyển, chênh lệch tỷ giá CL, đánh giá lại DG, điều chỉnh tỷ giá xuất quỹ XQ, khấu trừ thuế KTT) không lập tay được và không bỏ ghi sổ hay hủy riêng lẻ được (báo "chứng từ do hệ thống sinh"). Muốn sửa phải chạy lại tính năng đã sinh ra chứng từ. Phiếu phân bổ (PB) vẫn lập tay được. Hóa đơn dịch vụ (HDB, HDM, GGB, GGM) chỉ lập ở màn hình hóa đơn.
- Phiếu thu, phiếu chi, giấy báo và Bù trừ công nợ có nút "Chọn chứng từ công nợ" để đối trừ ngay trên chứng từ (xem mục Công nợ).
- Nếu chứng từ có dòng đối ứng 131 hoặc 331, mở hộp thoại bằng nút đó; nút bị khóa kèm nhắc "Nhập dòng tài khoản 131 hoặc 331 để chọn chứng từ công nợ" khi chưa có dòng như vậy.
- Số dư đầu kỳ của tài khoản 112 nhập theo từng tài khoản ngân hàng.
- Số dư đầu kỳ công nợ nhập theo từng hóa đơn (số chứng từ, ngày chứng từ, hạn thanh toán). Mẫu Excel nhập số dư đầu kỳ có ba mẫu 11, 8 và 7 cột tùy loại. Số dư đầu kỳ công nợ đã được đối trừ thì không bỏ ghi sổ hay ghi sổ lại được.

## In chứng từ

- Phiếu thu in mẫu "Mẫu số 01 - TT" (Phiếu thu), phiếu chi in "Mẫu số 02 - TT" (Phiếu chi). Hai mẫu này không in mã số thuế của đơn vị và không có dòng chấm.
- Giấy báo Có in "Giấy báo ngân hàng". Giấy báo Nợ có menu "In": "Giấy báo ngân hàng" hoặc "Ủy nhiệm chi". Hai mẫu này là mẫu nội bộ của phần mềm, không mang số mẫu, có mã số thuế của đơn vị. Ủy nhiệm chi ghi bên thụ hưởng theo tên chủ tài khoản ngân hàng của đối tượng; nếu chưa có thì theo tên đối tượng, rồi theo người nhận tiền.
- Chế độ TT200 và TT58 chưa có văn bản gốc trong phần mềm nên phiếu thu, phiếu chi in không có dòng "Mẫu số" và không có căn cứ pháp lý.
- Chứng từ ngoại tệ in số tiền nguyên tệ kèm mã loại tiền, số tiền bằng chữ theo tên loại tiền và thêm số tiền quy đổi VND bằng chữ. Số tiền in là tổng các dòng phía quỹ hoặc ngân hàng của loại chứng từ.
- Kiểm kê quỹ có "In bảng kiểm kê" (mẫu 08a-TT cho VND, 08b-TT cho ngoại tệ; xem mục Kiểm kê quỹ).

## Sổ quỹ và sổ tiền gửi

Menu Báo cáo > "Sổ quỹ và tiền gửi", hai tab "Sổ quỹ" và "Sổ tiền gửi".

- Chọn khoảng ngày (mặc định tháng hiện tại). Tab Sổ quỹ: chọn "Tài khoản quỹ" (nhóm 111) và "Loại tiền". Tab Sổ tiền gửi: chọn "Tài khoản ngân hàng", hoặc bật công tắc "Chưa gán tài khoản ngân hàng (TK 112)" để xem các dòng 112 chưa chọn tài khoản ngân hàng. Bộ lọc được nhớ cho lần sau.
- Phần đầu hiện Tồn đầu kỳ, Thu (Gửi vào), Chi (Rút ra) và Tồn cuối kỳ (đỏ khi âm). Cột nguyên tệ hiện thêm khi loại tiền khác VND.
- Cột Thu và Chi theo chiều thực tế của dòng ghi sổ. Trong cùng một ngày, khoản thu xếp trước khoản chi.
- Nhấn đúp hoặc Enter trên một dòng để mở chứng từ ở tab mới.
- Nút "In PDF" và "Xuất Excel" (cần quyền in báo cáo) dùng đúng bộ lọc đang chọn.
- Biểu mẫu: chế độ TT133 in S04a-DNN (sổ quỹ) và S05-DNN (sổ tiền gửi); chế độ TT99 in S07-DN và S08-DN; chế độ TT200 và TT58 in không có số mẫu.
- Số liệu đọc trong một giao dịch chỉ đọc nhất quán, và sổ bị ẩn nếu bạn không có cờ nhạy cảm tương ứng.

## Kiểm kê quỹ

Menu Quỹ > "Kiểm kê quỹ".

- Chọn "Ngày kiểm kê", "Tài khoản quỹ" (nhóm 111) và "Loại tiền". Bảng bên trái nhập "Mệnh giá" và "Số lượng (tờ)"; với VND đã có sẵn các mệnh giá từ 500.000 đến 1.000. Thành tiền tự tính.
- Khối "Kết quả kiểm kê" so số dư theo sổ cuối ngày kiểm kê với tiền thực tế và hiện chênh lệch (thực tế trừ sổ) kèm nhãn Thiếu, Thừa hoặc Khớp. Ô "Thành viên kiểm kê" nhập mỗi dòng một người theo dạng "Họ tên, chức danh"; có ô "Ghi chú".
- "Lưu kiểm kê (Ctrl+S)" lưu bảng kiểm kê. Giới hạn: mệnh giá tối đa 9 chữ số phần nguyên, số lượng tối đa 100.000, tối đa 30 mệnh giá và 20 thành viên. Danh sách "Các lần kiểm kê gần đây" hiện 200 lần mới nhất.
- Kiểm kê có chênh lệch: bấm "Xử lý chênh lệch" (cần quyền sửa kiểm kê quỹ và quyền tạo chứng từ). Thừa lập Phiếu thu nháp (Nợ quỹ, Có 3381); thiếu lập Phiếu chi nháp (Nợ 1381, Có quỹ). Có thể chọn tài khoản đối ứng khác; để trống là tài khoản mặc định, nếu tài khoản không hợp lệ theo chế độ thì phần mềm báo lỗi. Với ngoại tệ phải nhập tỷ giá để quy đổi chênh lệch ra đồng.
- Phiếu tạo ra ở trạng thái nháp; kiểm tra rồi ghi sổ như thường. Khi đã xử lý, bảng kiểm kê hiện liên kết tới phiếu và không xóa được. Kiểm kê chưa xử lý thì có nút "Xóa". Nếu phiếu nháp bị hủy, kiểm kê được xử lý lại.
- "In bảng kiểm kê" mở mẫu 08a-TT (VND) hoặc 08b-TT (ngoại tệ, bản đơn giản hóa, cần bạn xác nhận lại với mẫu đơn vị đang dùng). Ô "Số:" in số của lần kiểm kê và phần kết quả in chữ "Thừa" hoặc "Thiếu".

## Tỷ giá xuất quỹ và đánh giá lại ngoại tệ

Menu Công nợ > "Công cụ tỷ giá" (cần quyền `fx.run`), hai tab.

Quy ước chung: tỷ giá của một ngày là tỷ giá mới nhất có hiệu lực không muộn hơn ngày đó, theo loại tỷ giá đã chọn trong Tùy chọn hệ thống ("Loại tỷ giá ghi sổ"). Thiếu tỷ giá thì phần mềm báo lỗi thiếu tỷ giá.

**Tab "Tỷ giá xuất quỹ"**

- Tùy chọn "Tỷ giá xuất quỹ ngoại tệ" của công ty: "Bình quân gia quyền di động (tính lại cuối kỳ)" là mặc định; "Đích danh (tự nhập tỷ giá)" thì mỗi chứng từ chi tự nhập tỷ giá và chức năng tính lại bị khóa. Không có lựa chọn nhập trước xuất trước.
- Chọn "Năm tài chính", "Kỳ kế toán" rồi bấm "Chạy điều chỉnh tỷ giá xuất quỹ". Mỗi tài khoản tiền, tài khoản ngân hàng và loại tiền cho ra một chứng từ XQ ghi ngày cuối kỳ. Ghi Có quá nhiều so với bình quân thì Nợ tiền, Có 515; ghi Có quá ít thì Nợ 635, Có tiền.
- Chạy lại cùng kỳ: chứng từ XQ cũ được đảo và sinh chứng từ mới; nếu kết quả không đổi thì không sinh thêm. Kỳ khóa mềm cần quyền ghi lùi; kỳ khóa cứng bị từ chối.
- Phần mềm nhắc các kỳ sau đã chạy XQ cần chạy lại theo thứ tự, và các ngày đánh giá lại ngoại tệ đã chạy trước điều chỉnh này cần chạy lại.

**Tab "Đánh giá lại ngoại tệ"**

- Hai ô chọn loại tỷ giá: "Tỷ giá đánh giá lại tài sản" và "Tỷ giá đánh giá lại nợ phải trả" với các lựa chọn "Theo quy định của chế độ", "Tỷ giá chuyển khoản trung bình", "Tỷ giá mua", "Tỷ giá bán", "Tỷ giá xuất quỹ" khi áp dụng. Cần quyền sửa tùy chọn để đổi. Chế độ TT133 và TT99 theo tỷ giá chuyển khoản trung bình. Với TT200 phần mềm dùng chuyển khoản trung bình kèm cảnh báo: "Quy tắc đánh giá lại ngoại tệ theo TT200 chưa được đối chiếu với văn bản gốc; kiểm tra kết quả trước khi ghi sổ".
- Chọn "Ngày đánh giá lại"; bảng theo loại tiền hiện tỷ giá điền sẵn từ danh mục tỷ giá, sửa được; loại tiền không sửa lấy theo loại tỷ giá của từng khoản. Bấm "Xem trước" để xem tỷ giá máy chủ áp dụng, cảnh báo, và từng dòng (Tài khoản, Đối tượng / TK ngân hàng, Số dư nguyên tệ, Số dư VND, Tỷ giá, Giá trị đánh giá lại, Chênh lệch). Xem trước từng dòng chỉ dành cho người xem được các tài khoản đó; không thì bị từ chối.
- "Chạy đánh giá lại" chỉ bật sau khi đã xem trước. Chạy thật chỉ cần quyền `fx.run`, không hiện dòng theo từng đối tượng.
- Chỉ đánh giá lại số dư tiền ngoại tệ (111x, 112x), phải thu 131 và phải trả 331 còn số dư nguyên tệ khác 0. Khoản ứng trước cho nhà cung cấp, khoản khách hàng trả trước (số dư nguyên tệ ngược chiều của từng đối tượng) không đánh giá lại.
- Chế độ TT133: đánh giá lại ghi qua tài khoản 413, sau đó chứng từ DG thứ hai chuyển số thuần sang 515 hoặc 635. Chế độ TT99: ghi thẳng Có 515 hoặc Nợ 635, không qua 413.
- Chạy lại cùng ngày: kết quả y hệt thì không sinh chứng từ ("Kết quả không đổi…"); kết quả khác thì đảo chứng từ DG cũ và sinh mới.
- Sau khi chạy, bảng "Các lần đã chạy" liệt kê kỳ, chứng từ sinh, chứng từ đã đảo và giờ chạy cho cả hai loại.
- Khoản đã đánh giá lại: nếu đối trừ với khoản con thì phần mềm báo phải hủy đối trừ trước. Không bỏ ghi sổ được chứng từ chứa khoản đã đánh giá lại ("khoản đã đánh giá lại"); dùng Đảo, phần mềm tự đối trừ cả nhóm và chuyển phần chênh lệch còn lại qua chứng từ CL.
- Báo cáo kết quả hoạt động kinh doanh B02 chế độ TT99: chỉ tiêu 22 (doanh thu hoạt động tài chính) và 23 (chi phí tài chính) trình bày số thuần của đánh giá lại ngoại tệ trong cả kỳ báo cáo, bao gồm cả chứng từ đảo. Nghĩa là lãi và lỗ đánh giá lại bù trừ nhau trên một chỉ tiêu; chênh lệch tỷ giá khi thanh toán (CL thường) và điều chỉnh XQ vẫn trình bày gộp. Xem chi tiết chỉ tiêu 22, 23 sẽ ra dòng "số thuần đánh giá lại", không liên kết sang sổ cái. Công ty đã tự sửa công thức B02 thì công thức đó được giữ nguyên.

## Công nợ và đối trừ

Menu Công nợ > "Đối trừ chứng từ". Khoản công nợ (phải thu 131, phải trả 331) sinh từ dòng chứng từ có đối tượng khi ghi sổ.

- Hạn thanh toán của khoản lấy theo thứ tự: hạn ở dòng, hạn ở tiêu đề chứng từ, rồi ngày chứng từ cộng số ngày được nợ của đối tượng.
- Màn hình có "Loại công nợ" (Phải thu 131 / Phải trả 331), "Đối tượng (F4)", "Loại tiền (F4)", "Ngày đối trừ" (để trống: lấy theo chứng từ, tức ngày muộn nhất của hai khoản).
- Tab "Chọn để đối trừ": nhập "Số đối trừ" ở các khoản bên Nợ và bên Có; Enter trên ô trống lấy cả số còn dư. Phía dưới hiện "Tổng Nợ chọn", "Tổng Có chọn", "Chênh lệch". Nút "Đối trừ (Ctrl+S)" chỉ bật khi tổng hai bên bằng nhau theo từng loại tiền. Số đối trừ vượt số còn dư bị từ chối.
- Với ngoại tệ, đối trừ lệch tỷ giá thì phần mềm tự lập chứng từ CL ghi chênh lệch tỷ giá và hiện số CL vừa tạo.
- "Đối trừ tự động": ghép các khoản Nợ và Có của tài khoản (kể cả tài khoản con), mọi loại tiền, theo từng đối tượng và từng loại tiền, thứ tự theo hạn thanh toán (không có thì theo ngày chứng từ), tối đa 10.000 cặp mỗi lần. Báo "còn khoản chưa ghép, chạy lại để tiếp tục" khi chưa hết.
- Tab "Đã đối trừ": lọc theo khoảng ngày, liệt kê nhóm đối trừ với hình thức Thủ công, Tự động, Theo chứng từ, Chênh lệch tỷ giá, Đảo chứng từ. Nút "Hủy đối trừ" xóa nhóm đối trừ; kỳ khóa mềm cần quyền ghi lùi, kỳ khóa cứng không hủy được, nhóm có dòng "Đảo chứng từ" không hủy được.
- Đối trừ ngay trên phiếu thu, phiếu chi, giấy báo, bù trừ công nợ: nút "Chọn chứng từ công nợ" mở hộp thoại, chỉ liệt kê khoản của đối tượng và tài khoản của dòng đang chọn; cột Ngày chứng từ, Số chứng từ, Hạn thanh toán, Nguyên tệ còn lại, Dư VND, Số đối trừ; nút "Áp dụng (Ctrl+S)". Khi có nhiều dòng 131 hoặc 331 thì chọn thêm ô "Dòng chứng từ". Đây là kế hoạch đối trừ lưu cùng chứng từ nháp và chỉ thực hiện khi ghi sổ. Đổi số tiền, tài khoản, đối tượng hoặc loại tiền của dòng thì kế hoạch của dòng đó bị xóa và có cảnh báo; đổi diễn giải, bộ phận, vụ việc thì giữ nguyên. Nhân bản chứng từ không chép kế hoạch đối trừ. Khoản đã được một chứng từ nháp chọn thì không bỏ ghi sổ hoặc đảo chứng từ gốc của khoản đó được.
- Phiếu chi dạng "Chi trả nhà cung cấp" và phiếu thu "Thu tiền khách hàng" có thể không chọn chứng từ nào: khi đó khoản trả trước hay thu trước nằm trên sổ như số dư trái chiều và hiện ở cột riêng của báo cáo tuổi nợ.
- Nếu hai người cùng đối trừ một khoản, người sau nhận thông báo "thử lại".

## Báo cáo công nợ

Menu Công nợ > "Báo cáo công nợ". Chọn "Phải thu (131)" hoặc "Phải trả (331)", khoảng ngày; bộ lọc được nhớ. Các tab:

- "Sổ chi tiết": cần chọn đối tượng (F4), có thêm lọc "Loại tiền". Hiện dư đầu kỳ, phát sinh Nợ, phát sinh Có, dư cuối kỳ và từng dòng chứng từ; nhấn đúp hoặc Enter mở chứng từ.
- "Tổng hợp": toàn bộ đối tượng, các cột dư đầu kỳ, phát sinh, dư cuối kỳ tách Nợ và Có từng đối tượng (không bù trừ giữa các đối tượng, giống bảng cân đối số phát sinh). Có dòng so khớp với số dư tài khoản trên sổ cái, lệch thì hiện cảnh báo.
- "Tuổi nợ": chọn "Tính đến ngày", "Tính tuổi nợ theo" ("Theo hạn thanh toán" hoặc "Theo ngày chứng từ") và "Mốc tuổi nợ (ngày)" (mặc định 30,60,90,180; gõ xong Enter hoặc rời ô để tính lại). Khoản không có hạn thanh toán, khi tính theo hạn, tính là chưa đến hạn. Số dư trái chiều (trả trước, thu thừa) nằm ở cột riêng "Trả trước / dư Có" (với 331: "dư Nợ"). Tổng tuổi nợ bằng số còn dư của các khoản. Chọn một đối tượng thì hiện thêm danh sách các khoản còn nợ. Khoản đã đánh giá lại ngoại tệ tính tuổi theo ngày của khoản gốc.
- "Đối chiếu": chọn đối tượng; hiện kết luận "Đối tượng còn nợ công ty" hoặc "Công ty còn nợ đối tượng" kèm số tiền, hoặc "Hai bên không còn công nợ".
- "In PDF" và "Xuất Excel" (cho ba tab đầu). "In biên bản" in Biên bản đối chiếu công nợ của đối tượng đã chọn. "Thư nhắc nợ" (chỉ với phải thu) in thư nhắc các khoản quá hạn đến ngày đã chọn; nút bị khóa nếu đối tượng không có khoản quá hạn. Biên bản và thư là mẫu nội bộ, không mang số mẫu. Chưa gửi được thư qua email.

## Hóa đơn mua và bán dịch vụ

Menu Mua hàng > "Hóa đơn mua dịch vụ", "Giảm giá mua"; menu Bán hàng > "Hóa đơn bán dịch vụ", "Giảm giá bán". Giảm giá mua và bán dùng cho hóa đơn giảm giá hoặc trả lại.

- Tiêu đề: Ngày hạch toán, Ngày chứng từ, Đối tượng (bắt buộc), Loại tiền, Tỷ giá, Hạn thanh toán, Diễn giải. Phần mềm tự chọn tài khoản đối ứng 131 hoặc 331 theo tài khoản mặc định của đối tượng nếu bắt đầu bằng 131 hoặc 331.
- Tab "Hàng tiền": Diễn giải, "TK doanh thu (F4)" (bán) hoặc "TK chi phí (F4)" (mua), Số lượng, Đơn giá, Thành tiền, "% chiết khấu", "Tiền chiết khấu", "Mã thuế (F4)", "Tiền thuế" (tự tính, chỉ đọc), Bộ phận, Vụ việc, Khoản mục. Số lượng nhân đơn giá ra Thành tiền (vẫn sửa tay được). Nhập % chiết khấu thì tiền chiết khấu tự tính; sửa tay tiền chiết khấu thì bỏ %.
- Mã thuế lấy từ danh mục "Loại thuế" và "Phân bổ thuế" (mỗi mã khai báo phạm vi dùng mua, bán hay cả hai; phương pháp khấu trừ, trực tiếp hoặc không tính; thuế suất; các tài khoản thuế và tỷ lệ phân bổ cộng đúng 100%). Mã không chịu thuế và không kê khai có phương pháp "không tính". Mã khấu trừ thuế TNCN tại nguồn (`TNCN_KT`) cần bạn nhập thuế suất, chưa nhập thì phần mềm báo lỗi thiếu thuế suất. Một dòng hàng chỉ mang một mã GTGT (có thể thêm một mã thuế khác như TNCN); nhiều mã cách nhau bằng dấu phẩy.
- Thuế tính làm tròn từng dòng (VND không lẻ, ngoại tệ 2 chữ số). Hỗ trợ đơn giá đã gồm thuế.
- Tab "Thuế": theo từng mã thuế hiện "Số dòng", "Thuế tính (đồng)", "Thuế ghi trên hóa đơn (đồng)" (nhập số khớp hóa đơn giấy, nguyên đồng) và "Chênh lệch / dung sai" với nhãn "Trong dung sai" hoặc "Quá dung sai". Dung sai bằng số dòng mang mã đó (ngoại tệ thêm lệch 1 đồng mỗi dòng thuế). Quá dung sai không lưu được.
- Tab "Hóa đơn": Mẫu số, Ký hiệu, Số hóa đơn, Ngày hóa đơn (bắt buộc số và ngày), "Nhóm kê khai (F4)", "Mã số thuế", "Tên đơn vị", "Địa chỉ". Ba ô cuối là ghi đè thông tin của đối tượng ngay trên hóa đơn này; để trống là lấy theo danh mục đối tượng. Mã số thuế đúng dạng 10 số hoặc 10 số-3 số. Đổi đối tượng của chứng từ thì thông tin ghi đè cũ bị xóa. Nhóm kê khai tự điền theo mã thuế GTGT đầu tiên nếu bạn chưa chọn.
- Bán hàng: nhóm kê khai ghi ở tiêu đề; mỗi dòng được xếp vào nhóm tiêu đề nếu thuế suất khớp, nếu không thì vào nhóm cùng mã với mã thuế (KCT, KKK), nếu không có thì nhóm cùng thuế suất; không có nhóm hợp lệ thì lỗi "không khớp nhóm". Các nhóm KKK, KTGT, NPV đã có sẵn. Mua hàng: dòng giữ nhóm ở tiêu đề.
- Hóa đơn giảm giá hoặc trả lại (Giảm giá mua, Giảm giá bán): ở tab "Hóa đơn" chọn "Hóa đơn gốc" (chỉ liệt kê hóa đơn đã ghi sổ cùng đối tượng và cùng chiều, 200 hóa đơn mới nhất) và "Dòng hóa đơn gốc".
- Hóa đơn mua trùng (cùng mã số thuế, ký hiệu và số) bị chặn; thông báo có liên kết mở chứng từ đã có, kể cả khi đó mới là bản nháp. Chứng từ đã hủy hoặc đã đảo không tính là trùng.
- Tab "Hạch toán": bút toán xem trước, tính ngay trên màn hình bằng chính hàm của máy chủ; máy chủ tính lại khi lưu và ghi sổ. Chân form có Tiền hàng (sau chiết khấu), Tiền thuế, Cộng.
- Hóa đơn có dòng hạch toán vào tài khoản 3387 hiện liên kết "Tạo lịch phân bổ" sang màn hình phân bổ doanh thu nhận trước, điền sẵn số liệu.
- Phiếu chi, Giấy báo Nợ và Phiếu kế toán có thêm tab "Hóa đơn" để kê khai tay hóa đơn đầu vào (Mẫu số, Ký hiệu, Số hóa đơn, Ngày hóa đơn, Nhóm kê khai, Mã thuế, Tiền hàng, Tiền thuế, Người bán, MST người bán, Tên người bán, Địa chỉ, Ghi chú). Thuế để trống tính là 0; để trống ba ô MST, tên, địa chỉ là lấy theo đối tượng. Các hóa đơn này luôn là hóa đơn mua vào.
- Quyền xem hóa đơn đi theo quyền chứng từ.

## Doanh thu nhận trước và phân bổ

Menu Sổ cái > "Phân bổ doanh thu nhận trước" (cần quyền xem phân bổ).

- Mỗi lịch phân bổ gồm: "Tài khoản nhận trước (Nợ, F4)" (thường 3387x), "Tài khoản doanh thu (Có, F4)", "Tổng số tiền", "Năm bắt đầu", "Kỳ bắt đầu", "Số kỳ" (tối đa 15), "Diễn giải". Tiền chia đều theo kỳ, kỳ cuối nhận phần dư do làm tròn.
- Nút "Thêm lịch", "Sửa", "Ngừng" và "Tiếp tục" (đổi trạng thái), "Xóa" (chỉ xóa được lịch chưa phân bổ kỳ nào). Lịch đã phân bổ ít nhất một kỳ thì chỉ sửa được diễn giải. Bảng liệt kê Kỳ phân bổ, Số tiền, Đã phân bổ, Trạng thái.
- "Chạy phân bổ kỳ": chọn "Năm tài chính", "Kỳ kế toán" rồi bấm nút. Mỗi lịch đến kỳ sinh một chứng từ phân bổ (PB), Nợ tài khoản nhận trước, Có tài khoản doanh thu, ghi ngày cuối kỳ. Chạy lại cùng kỳ thì đảo PB cũ và sinh mới (kết quả không đổi thì không sinh thêm); chạy lại hoặc xóa lịch luôn đảo PB ở ngày cuối kỳ kể cả khi kỳ đang mở.
- Nếu năm tài chính chưa tạo, phần mềm tạm tính 12 kỳ. Khi năm đó tạo ra có số kỳ khác, lần chạy báo lỗi bố cục kỳ; hãy ngừng lịch cũ và tạo lịch mới cho phần còn lại. Sửa hoặc xóa lịch đúng lúc đang chạy phân bổ có thể báo xung đột; thử lại sau.
- Tài khoản của lịch được kiểm tra theo chế độ kế toán của kỳ bắt đầu; lịch kéo sang năm khác chế độ sẽ báo lỗi ở kỳ đó khi chạy.
- Lịch lập từ hóa đơn mà hóa đơn gốc đã đảo, đã hủy hoặc chưa ghi sổ thì không phân bổ kỳ đó: sau khi chạy, màn hình hiện cảnh báo "Bỏ qua … lịch vì chứng từ gốc không còn ghi sổ" kèm tên lịch và số chứng từ gốc. Ngừng lịch (khách hủy hợp đồng) hoặc sửa lịch rồi chạy lại.

## Bảng kê hóa đơn và đối chiếu thuế

Menu Thuế > "Bảng kê hóa đơn" (cần quyền xem thuế). Bảng kê nội bộ, không phải mẫu bắt buộc.

- Chọn "Loại kỳ kê khai" (Tháng hoặc Quý), "Năm", "Kỳ". Ba tab "Mua vào", "Bán ra", "Đối chiếu"; nút "Xuất Excel".
- Tab Mua vào và Bán ra liệt kê hóa đơn theo nhóm kê khai, với cộng nhóm và tổng cộng. Cột: STT, Ngày, Ký hiệu, Số hóa đơn, Mã số thuế, Tên người bán/mua, Thuế suất, thuế, số chứng từ và các cột tiền. Thuế khác như nhập khẩu, tiêu thụ đặc biệt hiện ở phần riêng, không cộng vào tổng GTGT và không đối chiếu.
- Mỗi hóa đơn thuộc về kỳ kê khai lưu cùng dòng hóa đơn (tháng hoặc quý theo kỳ kê khai của công ty lúc lập). Dòng kỳ tháng cộng được vào quý; dòng kỳ quý hiện ở tháng cuối quý kèm ghi chú. Công ty kê khai quý xem theo tháng vẫn xem được kèm ghi chú.
- Chứng từ đảo: đảo trong cùng kỳ thì triệt tiêu; đảo ở kỳ sau thì hiện số âm ở kỳ muộn hơn giữa kỳ đảo và kỳ kê khai của hóa đơn gốc.
- Tab "Đối chiếu": so thuế GTGT đầu vào và đầu ra trên hóa đơn với phát sinh các tài khoản thuế trên sổ cái (số dư đầu kỳ DK không tính). Nếu khớp hiện "Thuế trên hóa đơn khớp sổ cái ở mọi chứng từ của kỳ"; nếu lệch hiện danh sách chứng từ lệch với cột "Chênh lệch". Chứng từ nộp thuế và chứng từ khấu trừ KTT bị loại khỏi so sánh. Phiếu chi nộp thuế đi qua tài khoản trung gian 3388 hoặc 1388 vẫn hiện là lệch.
- Từ tờ khai GTGT bấm vào chỉ tiêu có nguồn hóa đơn sẽ mở bảng kê đã lọc theo nhóm (và hàng nhập khẩu); có nút "Bỏ lọc". Khi lọc, cộng nhóm và tổng cộng tính lại trên các dòng đang hiện.

## Tờ khai 01/GTGT

Menu Thuế > "Tờ khai thuế GTGT" (cần quyền xem tờ khai). Kỳ khai tháng hoặc quý lấy theo ô "Kỳ khai thuế GTGT" (Theo tháng / Theo quý) ở tab "Tùy chọn hệ thống" của màn hình Thông tin công ty, mặc định theo tháng. Hóa đơn đã nhập trước khi đổi sang quý vẫn được gộp vào tờ khai quý.

**Điều cần biết trước khi nộp**

- Tệp XML xuất ra chưa được kiểm chứng với HTKK. Phần mềm chưa có tệp mẫu hay XSD của HTKK nên tên thẻ, mã mẫu và phiên bản trong tệp là giả định tạm. Màn hình cảnh báo "XML chưa kiểm chứng với HTKK"; hãy nạp thử vào HTKK và đối chiếu số liệu rồi mới nộp.
- Phần mềm mới có mẫu 01/GTGT theo Thông tư 89/2026 (áp dụng từ 01/7/2026) với 30 chỉ tiêu [21] đến [43]. Mẫu theo Thông tư 80 chưa có văn bản gốc nên không lập được tờ khai cho kỳ trước 01/7/2026: phần mềm báo kỳ này chưa có mẫu tờ khai.
- Thuế suất 8% (giảm thuế GTGT theo Nghị quyết 204/2025/QH15 và Nghị định 174/2025) hiện chưa có chỉ tiêu xác nhận riêng. Hàng hóa 8% tạm gộp vào [32] và [33] kèm cảnh báo; hãy tự đối chiếu trước khi chốt.
- Chỉ tiêu [25] (thuế đầu vào dùng chung được phân bổ theo tỷ lệ doanh thu chịu thuế) là cách tính của phần mềm, bạn có thể ghi đè.

**Cách lập**

- Chọn năm, kỳ. Chưa có tờ khai thì bấm "Tính tờ khai" để lập bản nháp. Bảng có các cột Mục, Chỉ tiêu, Nội dung, Giá trị (VND), Nguồn. Nguồn cho biết chỉ tiêu "Tự tính" (công thức hoặc hóa đơn, chỉ đọc), "Nhập tay", "Kỳ trước chuyển sang" hoặc "Ghi đè". Chỉ tiêu cho ghi đè sửa được thẳng trong ô giá trị khi tờ khai còn nháp; ô bị ghi đè hiện nhãn "Ghi đè" kèm nút "Bỏ ghi đè" để trả về số tự tính. Chỉ tiêu nguồn hóa đơn có liên kết mở bảng kê. Chỉ tiêu [41] hiện ở dạng nhỏ hơn hoặc bằng 0 trên bản in; số lưu là phần dương.
- "Tính lại (F9)" (và "Có thay đổi chưa lưu (Ctrl+S)") lưu bản nháp và tính lại từ sổ cái. Khi sổ đã đổi từ lần tính trước, màn hình báo lỗi đỏ và nút "Lưu lại nháp".
- "Chốt" hỏi lại "Chốt tờ khai?". Khi chốt, phần mềm tính lại từ sổ cái và đối chiếu bản nháp; lệch thì từ chối và nêu các chỉ tiêu lệch, bạn lưu nháp lại rồi chốt. Tờ khai đã chốt bị khóa; muốn sửa phải lập tờ khai bổ sung.
- "Xuất XML" chỉ bật sau khi chốt. "In" xuất PDF.
- Tờ khai nháp lập nhầm kỳ xóa được bằng nút "Xóa nháp" (cần quyền xóa tờ khai, hỏi lại trước khi xóa). Tờ khai đã chốt không xóa được.

**Khấu trừ thuế cuối kỳ**

- Nút "Khấu trừ thuế cuối kỳ" mở hộp thoại: chọn "Ngày khấu trừ" (mặc định cuối kỳ) rồi "Chạy khấu trừ". Phần mềm lấy số nhỏ hơn giữa dư Có 33311 và dư Nợ 133x, ghi Nợ 33311 và Có 1331 trước, sau đó 1332, thành chứng từ KTT. Chạy lại cùng ngày thì đảo KTT cũ rồi sinh mới; kết quả không đổi thì không ghi thêm. Chạy lại một ngày không tự chạy lại các ngày sau; nếu đã có khấu trừ ở ngày sau thì có cảnh báo liệt kê các ngày cần chạy lại theo thứ tự.

**Tờ khai bổ sung**

- Sau khi chốt, "Lập bổ sung" tạo lần khai tiếp theo. Chỉ tiêu [22] của tờ khai bổ sung luôn lấy [43] của tờ khai lần đầu đã chốt của kỳ trước.
- Chênh lệch [43] của tờ khai bổ sung so với lần khai liền trước không tự điền vào tờ khai nào. Phần mềm chỉ gợi ý và ghi vào [37] (giảm) hoặc [38] (tăng) của kỳ chứa ngày chốt tờ khai bổ sung (kỳ phát hiện sai sót, theo Thông tư 89/2026 Phụ lục II điểm 3). Đây là giả định của phần mềm về "kỳ phát hiện". Mục "Tờ khai bổ sung đã chốt" liệt kê từng tờ khai bổ sung với chênh lệch, kỳ phát hiện và nút "Mở"; gợi ý hiện ở tờ khai nháp của kỳ đó. Nếu tờ khai kỳ đó đã chốt, phần mềm nhắc "nếu đã khai [37]/[38] cho chênh lệch này thì không khai lại lần nữa".

## Nhập chứng từ từ Excel

Menu Chứng từ > "Nhập chứng từ từ Excel" (cần quyền nhập chứng từ).

- Chọn "Loại tệp nhập": "Phiếu thu, phiếu chi, giấy báo Có, giấy báo Nợ", "Bảng kê hóa đơn mua vào" hoặc "Bảng kê hóa đơn bán ra". "Tải mẫu" tải tệp Excel mẫu; "Chọn tệp" chọn tệp .xlsx.
- Quy trình hai bước: "Kiểm tra" (không ghi gì, chỉ báo số dòng, số chứng từ, số sẽ tạo, số đã nhập trước đó, cảnh báo và lỗi) rồi "Nhập". Nút "Nhập" chỉ bật sau khi kiểm tra không lỗi. Có lỗi nào thì không chứng từ nào được tạo; bảng lỗi nêu số dòng, cột và thông báo.
- Chứng từ tạo ra ở trạng thái nháp, trừ khi chọn "Ghi sổ ngay" (hộp chọn chỉ hiện với người có quyền ghi sổ).
- Mỗi tệp tối đa 2.000 chứng từ (hoặc hóa đơn) và 20.000 dòng. Tệp lớn hơn thì chia nhỏ. Việc chạy trong một lần gửi, 2.000 nhóm kể cả bước Kiểm tra mất khoảng 25 giây.
- Nhập lại cùng một tệp không tạo trùng: mỗi nhóm có khóa theo nội dung (số nhóm và các dòng đã sắp xếp). Sửa nội dung một nhóm rồi nhập lại sẽ được xem là chứng từ mới và chứng từ cũ vẫn còn; hãy hủy chứng từ cũ. Nhóm trùng với chứng từ đã hủy hoặc đã đảo bị báo là lỗi dòng; trùng với chứng từ nháp khi chọn "Ghi sổ ngay" chỉ là cảnh báo.
- Bảng kê bán ra kiểm tra trùng theo ký hiệu và số hóa đơn với hóa đơn bán ra đã có.
- Ngoại tệ: tiền VND có thể để trống (máy tính theo tỷ giá); nếu nhập, phải lệch không quá 1 đồng so với nguyên tệ nhân tỷ giá.
- Bước Kiểm tra không ghi sổ nên không phát hiện được lỗi chỉ lộ ra khi ghi sổ (như kỳ khóa, quỹ âm); các lỗi đó chỉ hiện ở bước Nhập.
- Tệp .xlsx quá lớn sau khi giải nén bị từ chối (tối đa 100 MB mỗi mục, 200 MB tổng, 10.000 mục). Các danh mục dùng nút "Nhập Excel" riêng: có lỗi ở bất kỳ dòng nào thì không dòng nào được thêm.

## Khử trùng chứng từ

Menu Tiện ích > "Khử trùng chứng từ" (cần quyền `dedupe.run`).

- Chọn khoảng ngày rồi bấm "Tìm". Phần mềm tìm các cặp chứng từ cùng số tiền, gần ngày, cùng đối tượng và cùng cặp tài khoản đối ứng (kể cả chiều Nợ, Có) theo quy tắc cấu hình. Quy tắc mặc định ghép các cặp loại chứng từ PC và BN, PT và BC, HDM và PC, HDM và BN, PKT và PC, PKT và PT. Xem và sửa quy tắc ở Danh mục > "Quy tắc khử trùng chứng từ".
- Mỗi cặp hiện hai chứng từ cạnh nhau (chứng từ, ngày ghi sổ, đối tượng, số tiền, diễn giải, trạng thái) kèm lý do nghi trùng. Với chứng từ nháp có nút "Hủy nháp"; với chứng từ đã ghi sổ có nút "Đảo chứng từ" (chọn ngày và diễn giải chứng từ đảo). Nút "Không trùng" loại cặp khỏi các lần tìm sau.
- Kết quả tối đa 500 cặp; vượt quá thì có cảnh báo, hãy xử lý bớt hoặc thu hẹp khoảng ngày. Cặp chứa tài khoản công nợ hoặc giá vốn mà bạn không có cờ xem thì bị ẩn kèm cảnh báo.

## Soát lỗi dữ liệu

Menu Tiện ích > "Soát lỗi dữ liệu" (cần quyền chạy soát lỗi).

- Chọn khoảng ngày, chọn quy tắc cần chạy (hộp chọn chỉ có tác dụng cho lần chạy này), bấm "Soát lỗi". Kết quả nhóm theo quy tắc với mức Lỗi hoặc Cảnh báo, thông điệp, hướng dẫn sửa và liên kết "Sửa chứng từ". Mỗi quy tắc hiện tối đa 1.000 dòng, quá thì có báo.
- Bảng quy tắc có công tắc "Bật" và nút "Sửa" cho người có quyền quản lý quy tắc soát lỗi (sửa được tên, mức, thông điệp, hướng dẫn). Quy tắc tùy chỉnh bằng SQL chưa hỗ trợ.
- Quy tắc của giai đoạn 1: Chứng từ không cân; Chứng từ không có dòng định khoản; Dòng công nợ thiếu đối tượng; Tài khoản tổng hợp trên dòng định khoản; Số dư trái loại dư của tài khoản; Chứng từ chưa ghi sổ trong kỳ đã khóa.
- Quy tắc thêm ở giai đoạn 2: Công nợ theo khoản lệch số dư sổ cái; Hóa đơn thiếu mã số thuế đối tác; Hóa đơn mua nhập trùng (cả khi nhập hai lần trong cùng một chứng từ); Thuế GTGT trên hóa đơn lệch phát sinh sổ cái; Dòng tiền gửi ngân hàng thiếu tài khoản ngân hàng; Hóa đơn thuế suất 8% ngoài thời gian giảm thuế; Hóa đơn mua từ ngưỡng thanh toán không dùng tiền mặt nhưng trả bằng tiền mặt (ngưỡng 5.000.000 đồng từ 01/7/2025, theo Nghị định 181/2025); Khoản công nợ quá hạn trên 90 ngày.
- Từ giai đoạn 6 có tổng cộng 50 quy tắc (thêm 14 quy tắc lương, giá thành, vụ việc, hợp đồng; xem tài liệu giai đoạn 6, mục 19). Cờ nhạy cảm nay có bốn: thêm `view_salary` (xem lương) và `view_cost` (xem giá vốn, giá thành); quy tắc về lương cần cờ lương, quy tắc về giá thành cần cờ giá vốn.
- Quy tắc cần cờ nhạy cảm (công nợ theo khoản và khoản quá hạn cần cờ phải thu và phải trả; số dư trái loại cần cờ giá vốn) được bỏ qua hoàn toàn nếu bạn thiếu cờ. Khi đó hiện cảnh báo "Có quy tắc không được chạy" kèm lý do; kết quả không bị lọc từng dòng.

## Giới hạn hiện tại

Các việc dưới đây chưa làm hoặc làm có điều kiện. Ghi chú trước để tránh nhầm khi dùng.

**Chưa có trong giai đoạn này**

- Chưa phân quyền riêng theo loại chứng từ: phiếu thu, phiếu chi, hóa đơn... cùng dùng nhóm quyền `voucher.*`.
- Chưa in séc.
- Chưa có phương pháp nhập trước xuất trước cho tỷ giá xuất quỹ; chỉ có bình quân di động và đích danh.
- Chưa có tờ khai 04/GTGT (phương pháp trực tiếp), 03/TNDN, 05/KK-TNCN; chưa tính thuế theo thời điểm thanh toán.
- Chưa đối chiếu sao kê ngân hàng, webhook ngân hàng, VietQR, dự báo dòng tiền, gửi thư nhắc nợ qua email.

**Chờ văn bản hoặc tài khoản thử**

- Tờ khai 01/GTGT kỳ trước 01/7/2026 chưa lập được vì thiếu văn bản gốc Thông tư 80/2021. Thuế suất 8% gộp tạm vào [32], [33]. XML chưa kiểm chứng với HTKK. Ủy nhiệm chi chỉ có một mẫu nội bộ, chưa có mẫu riêng của từng ngân hàng. Phiếu thu, phiếu chi của TT200 và TT58 in không có dòng "Mẫu số" và căn cứ pháp lý. Quy tắc tỷ giá xuất quỹ của TT200 chưa có văn bản gốc; chế độ TT58 chưa có quy tắc tỷ giá nên chức năng tỷ giá báo lỗi thiếu quy tắc. Báo cáo tài chính B01, B02, B03 còn chờ kế toán trưởng rà soát; gõ tiếng Việt Telex hoặc VNI chưa kiểm tay.

**Tỷ giá xuất quỹ**

- Chuyển tiền giữa hai tài khoản tiền ngoại tệ cùng loại bằng chứng từ lùi ngày: XQ chỉ tính lại bên chuyển (đối ứng 515 hoặc 635). Bên nhận giữ giá trị đã ghi cho đến khi chi tiêu ngoại tệ đó hoặc đánh giá lại cuối kỳ.

**Đánh giá lại ngoại tệ**

- Chỉ có một tỷ giá đánh giá lại cho tài sản và một cho nợ phải trả theo từng loại tiền; chưa có tỷ giá riêng của từng ngân hàng cho tiền gửi không kỳ hạn (TT99 yêu cầu tỷ giá của ngân hàng nơi mở tài khoản).
- Chưa loại trừ khoản phải thu đã lập dự phòng nợ khó đòi (chưa có phần dự phòng, dự kiến giai đoạn 6).
- Chỉ đánh giá lại 111x, 112x, 131 và 331; chưa đánh giá lại 113, 1281, 244, 341, 1388, 3388 và các khoản tiền tệ khác.
- Nhóm chi tiết theo đích danh còn số VND mà nguyên tệ bằng 0 vẫn cần tỷ giá ở ngày đánh giá lại, nếu không báo thiếu tỷ giá.
- Đảo chứng từ có khoản đã đánh giá lại: chứng từ CL ghi ở ngày muộn hơn giữa ngày đảo và ngày DG. Nếu kỳ đó bị khóa và bạn không có quyền ghi lùi, hoặc phân hệ công nợ bị khóa kỳ đó, cả lần đảo bị hủy và thông báo lỗi nêu kỳ muộn hơn (dễ gây khó hiểu). CL này mang diễn giải "khi đảo chứng từ..." và không gắn với lần chạy tỷ giá.
- Chứng từ đảo có ngày trước ngày DG: sau khi chạy lại trong cùng ngày, lãi 515 và lỗ 635 bằng nhau, thuần 0.
- Số dư đầu kỳ (DK) đã được đánh giá lại thì không sửa được.
- Khoản công nợ đã được đánh giá lại chỉ đối trừ được từ ngày đánh giá lại trở đi. Phiếu thu ghi lùi trước ngày đó mà chọn khoản này trong "Chọn chứng từ công nợ" sẽ không ghi sổ được, thông báo nêu ngày đánh giá lại: bỏ chọn khoản, ghi sổ phiếu thu, rồi vào Đối trừ chứng từ đối trừ với ngày từ ngày đánh giá lại.
- Hủy hoặc lập đối trừ cùng lúc với một lần chạy tỷ giá có thể để lại khoản con đơn lẻ trong trường hợp rất hiếm; chạy lại đánh giá lại để sửa.

**Phân bổ doanh thu nhận trước**

- Xem mục Doanh thu nhận trước và phân bổ: lịch kéo sang năm khác chế độ hoặc khác số kỳ chỉ lỗi khi chạy tới kỳ đó; xử lý bằng cách ngừng lịch và tạo lịch mới.

**Tờ khai 01/GTGT**

- [22] của tờ khai bổ sung luôn lấy theo tờ khai lần đầu đã chốt của kỳ trước. Kỳ phát hiện sai sót là giả định của phần mềm; chênh lệch chỉ gợi ý, không tự điền vào [37], [38].
- Đối chiếu thuế coi phiếu nộp thuế GTGT là phiếu không có hóa đơn, có dòng 111 hoặc 112 và ghi Nợ thuần 33311. Nộp qua tài khoản trung gian 3388 hoặc 1388 vẫn hiện lệch.
- Khấu trừ thuế cuối kỳ chạy lại một ngày không tự chạy lại các ngày sau.

**Nhập Excel và công cụ kiểm tra**

- Nhập Excel: tối đa 2.000 nhóm và 20.000 dòng một tệp; bước Kiểm tra không phát hiện được lỗi chỉ lộ khi ghi sổ; nhóm sửa nội dung rồi nhập lại tạo chứng từ mới.
- Khử trùng chứng từ: chưa đo hiệu năng trên khoảng 100.000 chứng từ. Dấu "Không trùng" chưa xem lại hay gỡ được. Người thiếu cờ phải thu, phải trả hoặc giá vốn không thấy các cặp liên quan.
- Soát lỗi: quy tắc có cờ nhạy cảm bị bỏ qua hoàn toàn nếu thiếu cờ. Quy tắc lệch thuế sao chép logic đối chiếu của bảng kê trong SQL và danh sách loại hóa đơn giảm giá (Giảm giá mua, Giảm giá bán) được viết cứng. Quy tắc tiền mặt vượt ngưỡng coi hóa đơn kê khai trên chứng từ có dòng Có tài khoản tiền mặt là trả bằng tiền mặt; chứng từ gộp nhiều nội dung có thể bị báo thừa. Hiệu năng của quy tắc công nợ lệch sổ cái và hóa đơn trùng trên dữ liệu lớn chưa đo (mỗi quy tắc giới hạn 15 giây).
