# Giai đoạn 6: Lương, giá thành, hợp đồng và vụ việc

Giai đoạn này thêm ba phân hệ nối vào sổ cái: tiền lương (hồ sơ, chấm công, bảng lương, hạch toán, chi lương, bảo hiểm, thuế thu nhập cá nhân), giá thành sản phẩm (đối tượng tập hợp chi phí, định mức, chạy giá thành, nhập kho thành phẩm theo giá thành) và hợp đồng, vụ việc (đợt thanh toán, lập hóa đơn từ đợt, theo dõi thực hiện, lãi lỗ, phân bổ chi phí chung, kết chuyển giá vốn).

Nguyên tắc cần nhớ:

- Chứng từ do phần mềm sinh ra là chứng từ thật có số, ngày, người lập, ghi sổ ngay: Chứng từ hạch toán lương (LU), Chứng từ giá thành (GT), Chứng từ phân bổ (PB). Không sửa, xóa, bỏ ghi sổ, đảo qua màn hình chứng từ chung (báo "do chức năng tự động sinh ra"); muốn đổi số thì đổi dữ liệu nguồn rồi chạy lại: phần mềm đảo chứng từ cũ và sinh chứng từ mới, hoặc báo "không đổi" nếu số liệu giống hệt.
- Phiếu chi lương, chứng từ nộp bảo hiểm, nộp thuế thu nhập cá nhân (TNCN), hóa đơn lập từ đợt hợp đồng là chứng từ nháp thường: bạn kiểm tra rồi tự ghi sổ.
- Dữ liệu lương và giá thành là dữ liệu nhạy cảm, chặn ở máy chủ bằng cờ `view_salary` (xem lương) và `view_cost` (xem giá vốn, giá thành), không chỉ ẩn trên màn hình (mục 20).

Lưu ý quan trọng về dữ liệu pháp lý và mức độ đã thử:

- Phần mềm KHÔNG chứa sẵn thuế suất, mức giảm trừ gia cảnh, tỷ lệ và mức trần bảo hiểm, lương tối thiểu vùng. Các văn bản gốc (Luật Thuế thu nhập cá nhân số 109/2025/QH15 và hướng dẫn, văn bản về BHXH, BHYT, BHTN, lương tối thiểu vùng) chưa có trên máy phát triển, và quy tắc của dự án là không nhập số liệu pháp lý từ trí nhớ. Bạn tự nhập tham số kèm nguồn văn bản (mục 1); chưa có tham số thì tính lương báo lỗi "Chưa có tham số".
- Dữ liệu mẫu ABC, XYZ và các kiểm thử dùng tham số ghi nguồn "Dữ liệu minh họa…". Số liệu đó không phải văn bản pháp lý: không dùng cho công ty thật.
- Tờ khai 05/KK-TNCN, 05/QTT-TNCN theo mẫu của Thông tư 89/2026/TT-BTC (Phụ lục I) chưa dựng được vì chưa có văn bản gốc: phần mềm làm bảng kê số liệu và chứng từ khấu trừ tổng hợp, còn XML và ký số khóa lại (mục 10).
- Tệp danh sách BHXH và tệp chi lương theo lô chưa phải mẫu của cơ quan bảo hiểm hay của ngân hàng nào (mục 8, 9).
- Chưa thử trên hệ thống bên ngoài nào (cổng BHXH, ngân hàng, HTKK).

## Phím tắt chung

Các phím vẫn như các giai đoạn trước: Enter/Tab sang ô kế tiếp, F4 tra cứu danh mục, Ctrl+S lưu, F9 ghi sổ hoặc chạy, Insert thêm dòng.

| Màn hình | Phím | Tác dụng |
|---|---|---|
| Hồ sơ lương | Ctrl+S | Lưu hồ sơ ở thẻ đầu, hoặc lưu phân bổ chi phí ở thẻ cuối |
| Chấm công | Enter, Tab | Sang ô kế tiếp; hết hàng thì sang hàng sau |
| Chấm công | Ctrl+S | Lưu các ô đã đổi |
| Bảng lương | F9 | Chốt ô đang sửa rồi Tính (hoặc Tính lại) |
| Bảng lương, ô nền xanh | Enter | Lưu ô và xuống hàng kế |
| Cấu trúc bảng lương | Ctrl+S | Lưu cấu trúc |
| Mẫu tệp chi lương | Insert, Ctrl+S | Thêm mẫu; lưu |
| Đối tượng tập hợp chi phí, Định mức, Hợp đồng | Insert, Ctrl+S | Thêm; lưu |
| Tính giá thành | F9 | Chạy giá thành kỳ |
| Phân bổ chi phí vào vụ việc | F9 | Chạy |
| Hợp đồng (lưới Đợt, Phụ lục) | Ctrl+S | Lưu hợp đồng, đợt và phụ lục một lần |
| Quy trình cuối kỳ | F9 | Chạy bước kế tiếp |

## 1. Tham số lương

Menu: Lương > Tham số lương. Xem cần quyền `payroll.view`; thêm, sửa, xóa cần `payroll.param`. Màn hình này không cần cờ `view_salary` vì tham số không phải số liệu của từng người.

Tham số là dữ liệu theo công ty, mỗi tham số có Hiệu lực từ ngày, Đến ngày (trống là không giới hạn) và bắt buộc có Nguồn văn bản (ghi số hiệu, điều, khoản của văn bản bạn lấy số liệu). Các khoảng hiệu lực của cùng một tham số không được chồng nhau (liền kề, ví dụ hết 30/6 và bắt đầu 01/7, thì được; trùng một ngày là chồng). Khi bạn thêm tham số cùng mã, cùng ngày bắt đầu thì sửa dòng đó.

Các tham số, mỗi tham số một biểu mẫu đúng hình dạng (không điền sẵn giá trị nào):

- Biểu thuế thu nhập cá nhân lũy tiến (theo tháng) và biểu quyết toán năm (nhập riêng, không suy từ biểu tháng). Mỗi bậc là mức thu nhập tính thuế đến bao nhiêu và thuế suất; bậc cuối là "Không giới hạn". Nút "Thêm bậc".
- Mức giảm trừ gia cảnh: bản thân, mỗi người phụ thuộc (đồng/tháng).
- Thời điểm tính thu nhập chịu thuế: theo kỳ lương hoặc theo thời điểm chi trả (xem hạn chế, mục 21).
- Thuế suất cá nhân không cư trú; thuế suất khấu trừ khi không có hợp đồng lao động hoặc hợp đồng dưới 3 tháng.
- Tỷ lệ bảo hiểm và kinh phí công đoàn: người lao động (BHXH, BHYT, BHTN), doanh nghiệp (BHXH, BHYT, BHTN, bảo hiểm tai nạn lao động, bệnh nghề nghiệp), kinh phí công đoàn (KPCĐ) và đoàn phí nếu có.
- Mức trần và mức sàn lương đóng bảo hiểm: nhập ít nhất một mức, là số tiền cụ thể hoặc bội số lương tối thiểu vùng. Trần BHTN theo bội số lương tối thiểu vùng nhập riêng; không nhập thì phần mềm dùng chung trần BHXH cho BHTN (cách xử lý của phần mềm khi thiếu, không phải quy định).
- Lương tối thiểu vùng I đến IV.
- Hệ số tiền lương làm thêm giờ (ngày thường, ngày nghỉ hằng tuần, ngày lễ) và "phần chênh lệch không chịu thuế" (Có hoặc Không; không có giá trị mặc định).

Trên màn hình:

- Ô "Ngày xem hiệu lực" cho biết giá trị nào đang áp dụng tại ngày đó. Nếu hệ thống có tham số pháp lý đã kiểm cùng mã thì nó được ưu tiên và hiện nhãn "Tham số pháp lý đã kiểm của hệ thống"; khi giá trị của công ty khác giá trị đó, hiện cảnh báo. Hiện tại hệ thống chưa nạp tham số lương nào.
- Nguồn bắt đầu bằng "Dữ liệu minh họa" hiện thẻ cam ở bảng, cảnh báo trong hộp thoại và cảnh báo đầu trang khi tham số đang hiệu lực dùng nguồn đó. Báo cáo lương và bảng kê TNCN xuất Excel cũng có dòng "Dữ liệu minh họa" ở đầu.
- Tham số hiệu lực "Chưa có" nghĩa là chưa nhập; tính lương cần tham số nào thì báo thiếu đúng tham số đó (kèm ngày hiệu lực và mã nhân viên) và liên kết sang màn hình này. Chỉ báo thiếu khi phép tính cần: không có giờ làm thêm thì không cần hệ số làm thêm giờ; không ai tham gia bảo hiểm thì không cần tỷ lệ bảo hiểm.
- Bảng lương lấy tham số theo ngày cuối kỳ lương; nếu giá trị đầu kỳ khác cuối kỳ thì bảng có cảnh báo `PARAM_CHANGED_IN_PERIOD`.

Cài đặt công ty liên quan (Hệ thống > Thông tin công ty > Tùy chọn hệ thống): "Số giờ làm việc chuẩn mỗi ngày" (cần khi có chấm công theo giờ), "Số ngày công chuẩn của tháng" (cần khi tính lương theo "ngày công chuẩn của công ty"). Để trống thì phần mềm báo lỗi `PAYROLL_SETTING_MISSING` khi cần tới, không tự giả định. Ở cùng chỗ có công tắc "Tập hợp chi phí theo đối tượng (giá thành)" (mục 11).

## 2. Hồ sơ lương

Menu: Lương > Hồ sơ lương. Cần quyền `payroll.view` và cờ `view_salary`; sửa cần `payroll.update`. Hồ sơ lương tách khỏi danh mục Nhân viên (danh mục không chứa và không trả số lương); nhân viên vẫn tạo ở Danh mục > Nhân viên, kèm bộ phận.

Bên trái là danh sách nhân viên (ô "Tìm theo mã, tên nhân viên"), bên phải là hồ sơ của người đang chọn với bốn thẻ:

- Thông tin chung (lưu bằng "Lưu hồ sơ (Ctrl+S)"): hình thức trả lương (Chuyển khoản hoặc Tiền mặt), cư trú thuế (Cư trú hoặc Không cư trú), loại hợp đồng lao động (Từ 3 tháng trở lên, Dưới 3 tháng, Không hợp đồng), vùng lương tối thiểu, ngày bắt đầu làm việc, ngày nghỉ việc, ngân hàng nhận lương (mã ngân hàng, số tài khoản, tên chủ tài khoản), mã số BHXH, mức lương đóng bảo hiểm (để trống là theo lương), các ô tham gia BHXH, BHYT, BHTN, bảo hiểm tai nạn lao động; tham gia kinh phí công đoàn, đoàn phí; ủy quyền quyết toán thuế; vụ việc mặc định (F4). Các ô tham gia bảo hiểm mặc định là không: chưa khai thì bảng lương không tính bảo hiểm cho người đó, phần mềm không tự áp dụng quy tắc nào.
- Lương và phụ cấp: mỗi phụ cấp có mã (chữ thường không dấu, số, gạch dưới), tên, số tiền đồng/tháng, "Chịu thuế TNCN", "Tính vào lương đóng bảo hiểm", hiệu lực từ ngày đến ngày (trống là mọi kỳ). Hai cờ do bạn khai, phần mềm không suy. Cùng mã phụ cấp không được chồng hiệu lực.
- Người phụ thuộc: họ tên, quan hệ, MST, CCCD, ngày sinh, từ tháng, đến tháng (trống là còn hiệu lực). Giảm trừ tính theo tháng: đăng ký giữa tháng được tính cả tháng. Một người không trùng khoảng tháng với chính mình (so MST nếu cả hai có, không thì CCCD, không thì tên và quan hệ).
- Lịch sử lương: "Thêm mức lương" với ngày hiệu lực và lương cơ bản/tháng. Lương cơ bản chỉ nằm ở đây. Đổi lương giữa tháng thì bảng lương chia theo ngày công. Mức lương đã được bảng lương (đã tính hoặc hạch toán) dùng thì không xóa, không thêm trước tháng đó (`SALARY_HISTORY_USED`).
- Phân bổ chi phí: chia chi phí lương của người đó cho nhiều vụ việc theo tỷ lệ; tổng phải đúng 100%, để trống là dùng vụ việc mặc định. "Lưu phân bổ (Ctrl+S)".

"Nhập Excel hồ sơ lương": "Tải mẫu" lấy tệp ba trang tính `Du_lieu` (mỗi nhân viên một dòng, lương cơ bản và ngày hiệu lực), `Phu_cap`, `Nguoi_phu_thuoc` (hai trang sau tùy chọn). Bấm "Kiểm tra" (không ghi gì) rồi "Nhập". Chỉ tạo mới: nhân viên đã có hồ sơ là lỗi dòng. Có lỗi thì không ghi dòng nào (`IMPORT_ERRORS`, báo theo dòng, cột).

Nhật ký kiểm toán không hiện hồ sơ lương, lịch sử lương, bảng lương cho người thiếu `view_salary`.

## 3. Chấm công

Menu: Lương > Chấm công. Xem cần `attendance.view`, ghi cần `attendance.update` (không cần cờ `view_salary`). Chọn "Tháng chấm công" và "Bộ phận" (trống là toàn công ty); bộ lọc được nhớ.

Lưới có mỗi nhân viên một hàng, mỗi ngày một cột (kèm thứ; cuối tuần tô xám), cột "Tổng công" tính tại chỗ. Danh sách gồm nhân viên đang làm việc trong tháng theo hồ sơ lương (chưa có hồ sơ thì coi là đang làm) và nhân viên đã có chấm công trong tháng. Gõ mã vào ô, nhiều mã trong một ô cách nhau bằng dấu cách ("Bảng mã" liệt kê đủ):

| Mã | Ý nghĩa |
|---|---|
| X | 1 ngày công |
| N | nửa ngày (một buổi) |
| số (ví dụ 8) | số giờ làm việc |
| P, O, K, H (kèm số ngày, mặc định 1) | nghỉ phép, nghỉ ốm, nghỉ không lương, nghỉ lễ |
| T, C, L (kèm số giờ) | làm thêm ngày thường, ngày nghỉ hằng tuần, ngày lễ |

Quy tắc: mỗi loại một lần trong ô; tổng công và nghỉ trong một ngày không quá 1; làm thêm tối đa 24 giờ. Ô sai mã tô đỏ. Chấm công theo giờ cần khai giờ làm việc chuẩn mỗi ngày ở cài đặt công ty. Chấm công trước ngày vào làm hoặc sau ngày nghỉ việc vẫn lưu nhưng ô tô cam và có cảnh báo; bảng lương không tính các ngày đó.

Các nút: "Lưu (Ctrl+S)" (chỉ gửi ô đã đổi, lỗi một ô thì không ghi ô nào); "Sao chép từ tháng trước" (cùng ngày trong tháng, chỉ ngày công, nửa ngày, giờ làm việc, chỉ vào ô còn trống; nghỉ và làm thêm không sao chép; không bám thứ Bảy, Chủ nhật của tháng trước); "Nhập Excel" (cột mã nhân viên, ngày, loại, số lượng; "Tải mẫu", "Kiểm tra", "Nhập"; tháng lấy từ màn hình; loại nhập bằng mã `work_day`… hoặc tên tiếng Việt; mỗi dòng đặt hoặc thay đúng loại đó của ô).

Khi tháng đã có bảng lương đã hạch toán chứa nhân viên, chấm công của người đó bị khóa (`ATTENDANCE_LOCKED`); hủy hạch toán thì mở lại.

## 4. Cấu trúc bảng lương và công thức

Menu: Lương > Cấu trúc bảng lương (`payroll.view` và `view_salary`; sửa cần `payroll.update`). Cấu trúc là danh sách cột của bảng lương. Công ty có sẵn cấu trúc mặc định "Lương cơ bản" (mã `LUONG_CO_BAN`, tạo lần đầu khi mở màn hình hoặc lập bảng lương): đủ các cột dựng sẵn (ngày công, lương theo ngày công, phụ cấp, làm thêm giờ, thu nhập khác, tổng thu nhập, các khoản bảo hiểm người lao động và doanh nghiệp, KPCĐ, đoàn phí, thu nhập chịu thuế, giảm trừ, thu nhập tính thuế, thuế TNCN, khấu trừ khác, thực lĩnh) cộng ba cột nhập tay: Thưởng, Đóng góp từ thiện/hưu trí tự nguyện (vừa là giảm trừ vừa là khấu trừ), Tạm ứng trừ lương. Cấu trúc mặc định không xóa được.

Thêm cấu trúc: "Thêm cấu trúc" (bắt đầu từ các cột mặc định), rồi "Thêm cột dựng sẵn", "Thêm cột nhập tay", "Thêm cột công thức"; mỗi cột có mã, tên, loại, công thức, "Số chữ số làm tròn" (0 đến 6, mặc định 0 là đồng) và các cờ nối vào cột dựng sẵn:

- Thu nhập (cộng vào tổng thu nhập; bỏ chọn "chịu thuế" thì là thu nhập không chịu thuế), tính vào lương đóng bảo hiểm, giảm trừ khác (trước thuế), khấu trừ khác (trừ vào thực lĩnh). Cột khấu trừ có thêm ô "TK Có khi hạch toán": bỏ trống thì cột Tạm ứng trừ lương (mã `advance`) ghi Có 141 theo nhân viên, cột khấu trừ khác ghi Có 3388; khai mã tài khoản (ví dụ 1388) thì cột ghi Có tài khoản đó theo nhân viên (tài khoản phải có trong hệ thống tài khoản của chế độ và là tài khoản lá, nếu không hạch toán báo `ACCOUNT_MISSING`). Cột người dùng trùng mã cột dựng sẵn là ghi đè cách tính cột đó.
- "Tính lương theo ngày công": chia cho ngày công chuẩn của công ty, chia cho 26 ngày, chia cho 22 ngày, hoặc lương cố định không theo ngày công.

Công thức: số, tham chiếu cột bằng `[mã]`, `+ - * /`, so sánh `> < >= <= == !=`, `&&` `||`, và các hàm `MIN MAX SUM IF ROUND ABS PIT SI_EMP SI_ER PARAM`. `IF(điều kiện, a, b)` chỉ tính nhánh được chọn; `ROUND(x, n)` n từ −9 đến 9; `PARAM('mã')` đọc tham số lương (ví dụ `PARAM('deduction_self')`). Ví dụ `IF([work_days] >= 26, 500000, 0)`. Cột phụ thuộc nhau theo đồ thị, vòng phụ thuộc bị chặn (`FORMULA_CYCLE`, nêu đường vòng).

"Kiểm công thức" kiểm ngay (trùng mã, công thức sai, cột không có, vòng); chưa hợp lệ thì không lưu được. "Xem thử với một nhân viên" tính thử cấu trúc đang soạn (chưa lưu) cho một nhân viên và một tháng, hiện "Thực lĩnh". Ô công thức gợi ý mã cột khi gõ.

Cấu trúc đã có bảng lương đã tính hoặc hạch toán dùng (thẻ "Đã dùng") bị khóa, báo `STRUCTURE_IN_USE`: bấm "Nhân bản" để tạo bản mới rồi sửa. Cấu trúc có bảng lương (kể cả nháp) tham chiếu không xóa được.

## 5. Bảng lương: tạo, tính, sửa tay

Menu: Lương > Bảng lương (`payroll.view` và `view_salary`; tính cần `payroll.update`). Có ba loại bảng: Bảng lương (chính), Bảng thưởng, Bảng truy lĩnh.

Tạo bảng: "Tạo bảng lương", chọn Kỳ lương (tháng), Loại bảng, Cấu trúc (trống là mặc định), Bộ phận (trống là mọi nhân viên có hồ sơ lương và đang làm việc trong tháng), tên (trống là tự đặt theo kỳ), ghi chú. Danh sách nhân viên được cố định lúc tạo: nhân viên vào làm hoặc có hồ sơ sau đó thì xóa bảng nháp, lập lại (mục 21). Mỗi nhân viên chỉ ở một bảng chính chưa hủy trong một tháng (`PAYROLL_EMPLOYEE_IN_OTHER_RUN`, nêu mã nhân viên); hủy bảng thì giải phóng nhân viên.

Tính: bấm "Tính (F9)" (bảng đã tính thì "Tính lại (F9)"). Phần mềm đọc hồ sơ lương, chấm công, tham số lương tại ngày cuối kỳ, cài đặt giờ/ngày chuẩn rồi tính từng cột. Cách tính chính:

- Công hưởng lương = ngày công (ngày, buổi, giờ quy đổi) + nghỉ phép + nghỉ lễ. Nghỉ ốm (do quỹ BHXH chi trả) và nghỉ không lương không tính. Đổi lương giữa tháng, vào làm, nghỉ việc giữa tháng được chia thành đoạn theo ngày hiệu lực.
- Làm thêm giờ theo đơn giá giờ = lương tháng ÷ (ngày chuẩn × giờ chuẩn/ngày) × hệ số. Phần chênh lệch không chịu thuế theo tham số.
- Bảo hiểm: lương đóng (hồ sơ, hoặc lương tháng) cộng phụ cấp và cột được đánh dấu, kẹp giữa sàn và trần; mỗi loại làm tròn riêng. KPCĐ (doanh nghiệp) và đoàn phí (người lao động) tính trên mức đóng BHXH.
- Thuế: người cư trú có hợp đồng từ 3 tháng tính lũy tiến trên thu nhập chịu thuế trừ bản thân, người phụ thuộc, bảo hiểm bắt buộc, giảm trừ khác; người không cư trú hoặc hợp đồng ngắn, không hợp đồng tính theo tỷ lệ cố định, không giảm trừ. Thiếu thuế suất của hai nhóm sau thì cảnh báo `PIT_RATE_MISSING`, thuế 0.
- Làm tròn: mỗi cột một lần (nửa lên), cột sau dùng giá trị đã làm tròn của cột trước.
- Bảng thưởng và truy lĩnh (kỳ phụ): không chấm công, phụ cấp, bảo hiểm; thuế được tính trên cả tháng gồm các bảng đã tính trước của cùng nhân viên, thuế của bảng này là phần chênh (âm thì về 0 kèm cảnh báo). Cần bảng chính của nhân viên đã tính (còn nháp thì `PAYROLL_REGULAR_NOT_CALCULATED`).

Lưới bảng lương: cột ghim trái mã và họ tên, cột Ghi chú bên phải ("Cần tính lại", "Cảnh báo n"), hàng tổng ghim cuối (tính tại chỗ). Chỉ cột nhập tay sửa được khi bảng còn nháp hoặc đã tính. Ô nhập tay nền xanh; ô đã sửa tay nền vàng. Mỗi ô sửa xong được lưu ngay (kèm nhật ký kiểm toán trước/sau) và dòng tính lại tại chỗ; số nhập theo định dạng Việt Nam (`1.500.000` hoặc `1500,5`), nhập sai thì giữ giá trị cũ.

"Cần tính lại": hồ sơ lương, chấm công, tham số hoặc cấu trúc đã đổi sau lần tính gần nhất. Đưa số về như cũ thì hết cảnh báo.

Các nút khác: "Nhập từ Excel" (mục 8), "Hủy bảng lương" (nhân viên được giải phóng), "Xóa nháp" (chỉ bảng nháp, cần `payroll.delete`). Bảng đã hạch toán không tính lại, không hủy được: phải "Hủy hạch toán" trước. Bảng đã hủy không sửa được.

## 6. Hạch toán lương (LU), chạy lại, hủy hạch toán

Trên bảng đã tính, cần `payroll.post`:

- "Hạch toán" sinh Chứng từ hạch toán lương (LU) ngày cuối tháng lương, ghi sổ ngay. Bảng "Cần tính lại" không hạch toán được (`PAYROLL_RUN_STALE`).
- Bút toán (số liệu theo bảng lương): Nợ chi phí lương (tổng thu nhập) và Nợ chi phí bảo hiểm, KPCĐ phần doanh nghiệp, tách theo bộ phận, vụ việc (hồ sơ phân bổ chi phí hoặc vụ việc mặc định), khoản mục, đối tượng tập hợp chi phí. Có phải trả người lao động tổng thu nhập, theo từng nhân viên. Nợ phải trả người lao động một dòng mỗi nhân viên bằng bảo hiểm phần người lao động cộng thuế TNCN cộng khấu trừ khác. Có các tài khoản BHXH (gồm bảo hiểm tai nạn lao động), BHYT, BHTN, KPCĐ (3382), thuế TNCN (3335), tạm ứng trừ lương (141, theo nhân viên) và khấu trừ khác (3388). Sau LU, dư Có phải trả người lao động của từng nhân viên bằng đúng thực lĩnh. Chỉ dòng phải trả người lao động và dòng khấu trừ có tài khoản riêng (tạm ứng 141) mang nhân viên.
- Tài khoản theo chế độ kế toán của kỳ (dữ liệu, không viết cứng): TT99 và TT200 chi phí lương vào 622, 6271, 6411, 6421 theo vai trò bộ phận (trực tiếp, phân xưởng, bán hàng, quản lý); TT133 vào 154, 154, 6421, 6422. Phải trả người lao động là 334 (TT200 là tài khoản lá 3341); BHXH 3383, BHYT 3384, BHTN 3385 (TT133) hoặc 3386 (TT99, TT200).
- Tài khoản chi phí theo bộ phận cấu hình bằng API `GET/PUT /api/payroll/cost-accounts` (vai trò trực tiếp, phân xưởng, bán hàng, quản lý; hoặc mã tài khoản; kèm khoản mục, đối tượng tập hợp chi phí) và cài đặt `payroll_expense_account` (tài khoản dùng cho bộ phận chưa cấu hình, mặc định chưa có); chưa có màn hình riêng. Thiếu cấu hình thì hạch toán báo `ACCOUNT_MISSING` kèm danh sách bộ phận hoặc tài khoản thiếu. TT133 dòng 154 cần đối tượng tập hợp chi phí hoặc vụ việc.
- Tạm ứng trừ lương ghi Có 141 theo nhân viên, bù đúng phiếu chi tạm ứng (Nợ 141 theo nhân viên) nên 141 của nhân viên về 0. Khấu trừ khác (đoàn phí, đóng góp, cột khấu trừ không khai tài khoản) ghi Có 3388. LU lập trước bản sửa này ghi tạm ứng vào 3388: giữ nguyên như lúc hạch toán; chạy lại hạch toán bảng đó ở kỳ mở thì đảo và sinh LU mới ghi 141.
- "Chạy lại hạch toán" (khi chấm công, hồ sơ… đổi): phần mềm tính lại bảng, dựng LU mới và so với LU hiện hành. Giống hệt thì "không đổi", không ghi gì; khác thì đảo LU cũ ngày cuối kỳ và sinh LU mới. Ở kỳ khóa (khóa cứng, hoặc khóa sổ mà bạn không có quyền ghi lùi ngày) chỉ chạy được khi cả số của bảng lương (thu nhập chịu thuế, giảm trừ, thuế…) lẫn LU không đổi; số bảng lương đổi dù LU không đổi (ví dụ thêm người phụ thuộc cho người không phải nộp thuế) cũng báo `PERIOD_HARD_LOCKED`/`PERIOD_SOFT_LOCKED` và không ghi gì, để bảng kê và quyết toán TNCN của kỳ đã khóa không đổi. Đổi bộ phận, vụ việc mặc định, tỷ lệ phân bổ chi phí của nhân viên, tài khoản chi phí theo bộ phận hoặc tài khoản mặc định sau khi hạch toán thì bảng hiện "Cần chạy lại" (số lương không đổi nên không cần tính lại).
- "Hủy hạch toán" luôn đảo LU (không bỏ ghi sổ) và đưa bảng về "Đã tính"; chấm công mở lại. Còn chứng từ chi (mục 7) đã ghi sổ của bảng thì bị chặn (`PAYROLL_PAYMENT_POSTED`, liệt kê chứng từ): bỏ ghi sổ (kỳ mở) hoặc đảo chứng từ chi trước. Chứng từ chi còn nháp không chặn, nhưng có cảnh báo kiểm lại số tiền.
- Kỳ khóa cứng: không hạch toán, không chạy lại có thay đổi (`PERIOD_HARD_LOCKED`). Kỳ khóa sổ cần quyền ghi lùi (`voucher.backdate_locked`), nếu không `PERIOD_SOFT_LOCKED`.
- Nhiều loại: cuối kỳ lương được hạch toán trong Quy trình cuối kỳ (mục 18), hoặc từng bảng ở màn hình này.

## 7. Chi lương, nộp bảo hiểm, nộp thuế TNCN

Trên bảng đã hạch toán, cần `payroll.pay` và `view_salary`. Ba nút lập chứng từ nháp (hộp thoại chọn Tiền mặt, tức Phiếu chi, hoặc Chuyển khoản, tức Giấy báo Nợ, tài khoản ngân hàng F4, ngày), mỗi loại một chứng từ cho một bảng lương:

- "Lập phiếu chi lương": mỗi nhân viên một dòng bằng thực lĩnh trên LU (nhân viên thực lĩnh bằng 0 hoặc âm bị bỏ). Số tiền lấy từ chứng từ LU, không từ số dư 334 có thể gồm tạm ứng hay kỳ trước.
- "Lập chứng từ nộp bảo hiểm": nộp BHXH, BHYT, BHTN (cả phần doanh nghiệp và người lao động, gồm bảo hiểm tai nạn lao động). KPCĐ (3382) không nằm trong phiếu này: nộp cho tổ chức công đoàn, lập tay.
- "Lập chứng từ nộp thuế TNCN": thuế TNCN trên LU (3335).

Đã có chứng từ cùng loại thì lập lại báo `PAYROLL_VOUCHER_EXISTS` (kèm số chứng từ, trạng thái). Bảng "Chứng từ chi của bảng lương" liệt kê chứng từ, kèm thẻ "Lập từ hạch toán cũ: hủy chứng từ và lập lại" khi LU đã đổi (chạy lại, hủy hạch toán). Bạn mở chứng từ (liên kết sang màn chứng từ), kiểm tra, sửa nếu cần và ghi sổ như phiếu bình thường; ghi sổ phiếu chi thì dư 334 từng nhân viên về 0. Hủy, đảo, xóa nháp chứng từ chi thì liên kết tự gỡ để lập lại. Bỏ ghi sổ chứng từ chi thì GIỮ liên kết: chứng từ nháp vẫn là chứng từ chi của bảng lương (lập lại báo `PAYROLL_VOUCHER_EXISTS`), sửa và ghi sổ lại chính chứng từ đó, hoặc hủy/xóa nó rồi lập mới.

## 8. Báo cáo lương và phiếu lương

Menu: Lương > Báo cáo lương (`payroll.view` và `view_salary`; xuất Excel, CSV cần thêm `payroll.export`). Chọn kỳ (Tháng, Quý, Cả năm) và tab:

- Bảng thanh toán lương: theo nhân viên, các cột thu nhập, khấu trừ, thực lĩnh, có chữ ký Người lập, Kế toán trưởng, Giám đốc.
- Tổng hợp bảo hiểm (tháng, quý): phần doanh nghiệp và người lao động theo loại.
- Chi phí lương: nhóm "Theo bộ phận" hoặc "Theo vụ việc"; nhân viên không có bộ phận hoặc vụ việc gom vào dòng "(Không có …)" để tổng luôn khớp Nợ các tài khoản chi phí của LU.
- Thuế TNCN khấu trừ: theo nhân viên và tháng.
- So sánh hai kỳ: hai tháng bất kỳ, chênh lệch tổng thu nhập, bảo hiểm người lao động, thuế, thực lĩnh.
- Phiếu lương: mỗi nhân viên một trang A4 (chỉ cột có giá trị khác 0), in từ trình duyệt; không gửi email phiếu lương.
- Tệp BHXH: danh sách cột chung (STT, mã số BHXH, họ tên, số CCCD, mã nhân viên, lương đóng BHXH/BHYT, lương đóng BHTN, phụ cấp, loại tham gia, tháng đóng, ngày vào làm, ngày nghỉ việc) xuất Excel hoặc CSV. KHÔNG phải mẫu D02-LT hay TK1-TS của cơ quan bảo hiểm (chưa có văn bản gốc): kê khai trên cổng BHXH bằng cách nhập lại hoặc dán từ tệp này.
- Sổ chi tiết 334: chọn tài khoản 334 hoặc 3341 và nhân viên (dùng sổ chi tiết công nợ có sẵn).

Mỗi báo cáo lấy số từ bảng lương đã tính hoặc đã hạch toán (không tính lại) và có khối "Đối chiếu" so tổng báo cáo với dòng LU trên sổ cái (thực lĩnh với 334, bảo hiểm, TNCN 3335, chi phí). Bảng lương chưa hạch toán được liệt kê riêng và không đưa vào đối chiếu. Báo cáo lương không in dòng "Mẫu số": mẫu của chế độ hiện hành chưa nhập từ văn bản gốc.

### Nhập bảng lương từ Excel

Trên bảng nháp hoặc đã tính, cần `payroll.update`: nút "Nhập từ Excel": "Tải mẫu" (cột `employee_code` và các cột nhập tay của cấu trúc), "Kiểm tra" rồi "Nhập". Kiểm từng dòng (mã trùng, mã không có trong bảng, tiền đúng định dạng, không âm); có lỗi thì không ghi dòng nào (`IMPORT_ERRORS`). Ô trống giữ nguyên, ô có giá trị thay ô nhập tay và ghi nhật ký trước/sau. Không tự tính lại: bảng chuyển "Cần tính lại", bạn bấm Tính. Bảng đã hạch toán hoặc đã hủy bị từ chối.

## 9. Chi lương theo lô (tệp cho ngân hàng)

Menu: Lương > Mẫu tệp chi lương. Cần quyền `payroll.export` (vai trò Kế toán viên mặc định không có) và `view_salary` cho mọi thao tác, kể cả tải lại tệp cũ.

Phần mềm không có mẫu nhập chi hộ của ngân hàng nào. Có một mẫu "Chung" dựng sẵn (STT, số tài khoản, tên người nhận, ngân hàng, số tiền, nội dung; CSV, dấu phẩy, BOM UTF-8). Bạn tự khai cột theo mẫu ngân hàng cấp: "Thêm mẫu", "Thêm cột" (số thứ tự, mã nhân viên, họ tên, số tài khoản nhận, tên người nhận, mã hoặc tên ngân hàng nhận, số tiền, nội dung, số hoặc tên tài khoản chi, giá trị cố định), "Lên"/"Xuống" sắp thứ tự. Tùy chọn: Loại tệp (CSV hoặc xlsx), Dấu phân cách, BOM UTF-8, Dòng tiêu đề, Bỏ dấu tiếng Việt (nhiều ngân hàng từ chối nội dung có dấu), Nội dung chuyển khoản theo mẫu có các thẻ `{month} {year} {employee_name} {employee_code} {run_name}`. Phải có cột Số tiền. Chỉ mã hóa UTF-8. "Xem thử 5 dòng" (có thể chọn bảng lương tháng để xem người nhận thật).

Xuất tệp: ở bảng đã hạch toán, nút "Xuất tệp chi lương": chọn mẫu, tài khoản ngân hàng chi (F4, không bắt buộc), nhận về liên kết tải. Điều kiện: bảng đã hạch toán, không "Cần chạy lại". Số tiền từng người là thực lĩnh. Người thiếu số tài khoản nhận hoặc có hình thức trả "Tiền mặt" bị loại khỏi tệp và liệt kê ở cảnh báo (kèm số tiền); không còn ai thì `PAYMENT_FILE_EMPTY`. Nếu bảng lương đã có phiếu chi lương thì tổng phải chi của cả bảng phải bằng tổng phiếu, lệch thì không xuất (`PAYMENT_TOTAL_MISMATCH`). Mỗi lần xuất lưu một lô kèm đúng nội dung tệp, có "Tải lại" các lần trước (không tạo lại từ dữ liệu hiện tại vì lương có thể đã đổi). Mẫu hoặc bảng lương đã có lô không xóa được. Nội dung tệp không hiện trong nhật ký kiểm toán.

Tệp chuyển cho ngân hàng, không mở bằng Excel rồi lưu lại. Chưa thử trên hệ thống ngân hàng nào; kiểm số tài khoản theo độ dài của từng ngân hàng chưa có.

## 10. Thuế thu nhập cá nhân (TNCN)

Menu: Lương > Thuế TNCN (`payroll.view` và `view_salary`; xuất bảng kê Excel cần `payroll.export`; lập, chốt, xóa tờ khai theo quyền `tax_return.*`). Màn hình báo "Chưa có mẫu tờ khai theo TT 89/2026: xuất bảng kê Excel". Chọn Năm, rồi "Khấu trừ theo quý", "Khấu trừ theo tháng" hoặc "Quyết toán năm".

### Bảng kê khấu trừ (nguồn của 05/KK-TNCN)

Nguồn số liệu chỉ là bảng lương đã hạch toán (mọi loại bảng: chính, thưởng, truy lĩnh); bảng nháp hoặc đã tính trong kỳ không vào bảng kê và có cảnh báo số bảng chưa hạch toán. Gộp theo nhân viên và tháng: MST, cư trú, loại hợp đồng, thu nhập chịu thuế, thu nhập miễn thuế, giảm trừ bản thân, người phụ thuộc, bảo hiểm, giảm trừ khác, thu nhập tính thuế, thuế đã khấu trừ; có hàng Cộng. "Xuất bảng kê Excel", "In bảng kê". Phần "khấu trừ ngoài lương": thuế TNCN khấu trừ trên hóa đơn mua dịch vụ (mã thuế `TNCN_KT`) theo đối tượng, kèm MST, chỉ có số thuế (xem hạn chế).

### Tờ khai lưu bảng kê

"Lập tờ khai" lưu bảng kê hiện tại thành tờ khai nháp (lần đầu, hoặc bổ sung lần n); mỗi kỳ chỉ một nháp. "Tính lại" làm mới nháp theo bảng lương hiện tại. "Chốt" tính lại và so với số đã lưu: lệch thì `TAX_RETURN_STALE`, tính lại rồi chốt lại. Tờ khai đã chốt không sửa, không xóa (`TAX_RETURN_FINAL`); sai thì lập bổ sung. Tờ khai này lưu bảng kê số liệu, KHÔNG phải tờ khai theo mẫu của cơ quan thuế.

### Quyết toán năm

Quyết toán thay chỉ cho người cư trú, hợp đồng từ 3 tháng, có đánh dấu ủy quyền quyết toán trong hồ sơ lương. Người không ủy quyền, không cư trú hoặc hợp đồng ngắn bị loại khỏi tính, kèm lý do; chỉ hiện thu nhập và thuế đã khấu trừ. Biểu thuế năm và mức giảm trừ lấy tại 31/12 (thiếu thì `PAYROLL_PARAM_MISSING`; phần mềm không suy từ biểu tháng). Số tháng giảm trừ bản thân là số tháng đã tính giảm trừ trong năm. Kết quả: thuế phải nộp cả năm, đã khấu trừ, chênh lệch (dương là nộp thêm, âm là nộp thừa hoặc hoàn). Tổng giảm trừ năm khác tổng giảm trừ hằng tháng (tham số đổi trong năm) thì cảnh báo, không tự sửa.

### Chứng từ khấu trừ thuế TNCN

"In chứng từ khấu trừ": mỗi người một trang, tổng hợp theo tháng trong năm. Không mẫu số, ký hiệu, số chứng từ (ghi chú cuối trang) vì mẫu chưa nhập từ văn bản gốc.

### XML và ký số

Xuất XML và ký số tờ khai 05/KK-TNCN, 05/QTT-TNCN trả `TNCN_TEMPLATE_UNAVAILABLE` (409) cho đến khi mẫu theo TT 89/2026 Phụ lục I được nhập từ ảnh trang gốc và cổng pháp lý bật. Xem mục 21.

## 11. Đối tượng tập hợp chi phí và định mức

Trước khi dùng: bật công tắc "Tập hợp chi phí theo đối tượng (giá thành)" ở Hệ thống > Thông tin công ty. Khi bật (hoặc khi dòng có tài khoản 621, 622, 627, 154), lưới chứng từ chung hiện cột "Đối tượng THCP (F4)"; cột này sửa được cả sau khi ghi sổ (như bộ phận, vụ việc), việc sửa ghi nhật ký trước/sau. Hóa đơn và phiếu kho chưa có cột này (mục 21).

Danh mục Khoản mục chi phí có thêm trường "Yếu tố giá thành" (Nguyên vật liệu, Nhân công, Sản xuất chung). Với TT133, khoản mục của dòng 154 chưa khai yếu tố thì chi phí xếp vào "chưa phân loại" và giá thành bị chặn cho đến khi bạn khai.

### Đối tượng tập hợp chi phí

Menu: Giá thành > Đối tượng tập hợp chi phí (`costing_obj.view` và cờ `view_cost`; thêm sửa xóa theo `costing_obj.*`). Mỗi đối tượng có Mã, Tên, Loại đối tượng gắn với một danh mục: Sản phẩm (vật tư), Vụ việc, Đơn hàng (đơn bán), Hợp đồng; Phương pháp giá thành (giản đơn, hệ số, tỷ lệ, vụ việc, đơn hàng; để trống thì theo loại), Đơn vị tính sản lượng, Đang dùng. Mỗi vụ việc, mỗi hợp đồng chỉ có một đối tượng. Đối tượng đã có trên dòng sổ cái hoặc có định mức không xóa được (`REFERENCED`): chuyển "Ngưng dùng".

### Định mức nguyên vật liệu

Menu: Giá thành > Định mức nguyên vật liệu. Định mức theo sản phẩm hoặc theo đối tượng, có Hiệu lực từ, đến; dòng là vật tư và số lượng cho một đơn vị sản phẩm (đơn vị tính cơ sở), tỷ lệ hao hụt %. Cột "Định mức gồm hao hụt" = số lượng × (1 + hao hụt%). Khoảng hiệu lực cùng đích không chồng nhau (`NORM_OVERLAP`); sản phẩm không làm nguyên liệu của chính nó. Định mức dùng cho báo cáo so sánh thực tế với định mức (mục 13).

## 12. Tính giá thành

Menu: Giá thành > Tính giá thành (`cost_run.view` và `view_cost`; chạy cần `cost_run.run`). Kỳ giá thành là tháng dương lịch.

Cách chi phí được tập hợp: theo TT99 và TT200 lấy phát sinh Nợ trừ Có của 621 (nguyên vật liệu trực tiếp), 622 (nhân công trực tiếp), 627 (sản xuất chung) trong tháng; theo TT133 lấy 154 theo yếu tố của khoản mục. Chứng từ kết chuyển và chứng từ giá thành không tính. Dòng gắn đối tượng bằng cột "Đối tượng THCP", nếu trống thì theo vụ việc, rồi theo hợp đồng của dòng; sản phẩm và đơn hàng chỉ gắn qua cột đối tượng. Chi phí sản xuất chung (627) chưa gắn đối tượng được phân bổ theo tiêu thức; nguyên vật liệu, nhân công trực tiếp chưa gắn thì chặn (bạn gắn đối tượng cho dòng rồi chạy lại).

Cách dùng:

1. Chọn Năm tài chính, Kỳ, "Tiêu thức phân bổ chi phí sản xuất chung" (nhân công trực tiếp, nguyên vật liệu trực tiếp, hoặc giá trị nhập tay như giờ máy, doanh thu).
2. Mỗi đối tượng có chi phí, dở dang đầu kỳ hoặc do bạn thêm ("Thêm sản phẩm") hiện một hàng: phương pháp, dở dang cuối kỳ (không có, theo nguyên vật liệu trực tiếp, hoặc theo sản lượng tương đương với % hoàn thành nhân công và sản xuất chung), sản lượng hoàn thành và dở dang, tiêu thức nhập tay. Mở rộng hàng để nhập đầu ra có hệ số hoặc giá thành định mức (phương pháp hệ số, tỷ lệ; mã vật tư F4). Vụ việc, đơn hàng phải đánh dấu "Đã hoàn thành" mới có giá thành, nếu không toàn bộ chi phí nằm lại dở dang.
3. "Xem trước" tính ngay không ghi gì: hiện dở dang đầu, phát sinh, phần sản xuất chung phân bổ, dở dang cuối, tổng giá thành, giá thành đơn vị; khối "chặn" liệt kê dòng chưa phân loại hoặc chưa gắn đối tượng; cảnh báo.
4. "Chạy (F9)" ghi kết quả và, với TT99 và TT200, sinh Chứng từ giá thành (GT) ngày cuối tháng: Có từng dòng chi phí của đối tượng, Nợ 154 theo đối tượng và khoản mục giá thành (kèm mã sản phẩm khi đối tượng có đúng một đầu ra). Sau GT, 621, 622, 627 của tháng về 0. Theo TT133 không sinh GT (chi phí đã nằm ở 154), kết quả lưu ở trạng thái "Đã tính". Công ty đã mở tài khoản con của 154 thì chạy báo `ACCOUNT_IS_GROUP` (hạn chế).

Dở dang đầu kỳ lấy từ dở dang cuối của lần chạy gần nhất trước kỳ. Sản lượng hoàn thành để trống thì lấy từ phiếu nhập kho thành phẩm trong tháng; khai khác số nhập kho thì có cảnh báo. Giá thành làm tròn đồng; phần dư khi chia cho nhiều đối tượng hoặc sản phẩm chia theo phần lẻ lớn nhất nên không âm; tổng luôn cân (đầu + phát sinh = giá thành + cuối).

Chạy lại: sửa chi phí, nhập kho, dở dang đầu hoặc tham số rồi chạy lại; phần mềm đảo GT cũ ngày cuối tháng và sinh GT mới, hoặc báo "không đổi" (kể cả ở kỳ khóa). Lần chạy "Cần chạy lại" khi chi phí, nhập kho thành phẩm, dở dang đầu từ kỳ trước đổi, hoặc GT bị đảo ngoài luồng. Phần mềm không tự lan truyền: chạy lại từng kỳ theo thứ tự tháng. Không có nút hủy lần chạy (chạy lại thay thế). Bảng "Các kỳ đã tính" liệt kê trạng thái, "Cần chạy lại", GT, tổng giá thành, dở dang cuối.

### Nhập kho thành phẩm theo giá thành

Khi chạy giá thành, tổng giá thành mỗi sản phẩm được chia cho các dòng phiếu nhập kho thành phẩm (loại "Nhập thành phẩm", không phải chuyển kho) của tháng theo số lượng, phần lẻ đồng chia theo phần lẻ lớn nhất (bằng nhau thì dòng sau nhận trước, nên dòng cuối nhận phần dư), không dòng nào lệch quá 1 đồng; phần chênh so với giá nhập hiện tại ghi thành lớp điều chỉnh giá nhập. Việc này làm bước tính giá vốn báo "Cần chạy lại" ("Kho còn phát sinh chưa cập nhật giá vốn trong kỳ"): chạy Tính giá vốn thì 155 và giá vốn hàng bán (632) theo giá thành, và 154 còn lại đúng bằng dở dang cuối. Phản hồi chạy liệt kê phiếu và dòng đã điều chỉnh. Đầu ra không có mã hàng (vụ việc, hợp đồng, đơn hàng không nhập kho) không qua kho: kết chuyển 154 sang 632 ở mục 16.

Chạy giá thành xong mà thêm hoặc đảo phiếu nhập thành phẩm thì giá thành "Cần chạy lại" để chia lại. Sửa giá nhập tay của dòng đã nhận giá thành thì chưa tự báo: chạy lại giá thành đưa về đúng phần chia (mục 21).

## 13. Báo cáo giá thành

Menu: Giá thành > Báo cáo giá thành (`cost_run.view` và `view_cost`; xuất Excel, PDF cần `report.print`). Chọn năm tài chính, kỳ (tháng), đối tượng (F4, trống là tất cả); mỗi báo cáo có "Xuất Excel" và in. Kỳ chưa chạy giá thành thì hiện hướng dẫn sang màn Tính giá thành (404 `COST_RUN_NOT_FOUND` ở API). Bốn tab, đều là mẫu nội bộ của phần mềm, không in số mẫu (thẻ tính giá thành, sổ chi tiết chưa nhập từ văn bản gốc):

- Thẻ tính giá thành: theo từng đối tượng, ba dòng khoản mục (nguyên vật liệu trực tiếp, nhân công trực tiếp, sản xuất chung) với cột dở dang đầu kỳ, phát sinh trong kỳ (sản xuất chung đã gồm phần phân bổ), dở dang cuối kỳ, tổng giá thành, giá thành đơn vị; sản lượng hoàn thành; từng sản phẩm đầu ra khi có nhiều. Lấy kết quả đã lưu của lần chạy, kèm cờ "Cần chạy lại" và số GT.
- Sổ chi tiết TK 154 theo đối tượng: dòng 154 xếp theo đối tượng (dòng nhập kho và giá vốn không mang đối tượng nên được xếp theo vật tư là đầu ra của đúng một đối tượng); dòng không gắn được vào "Chưa xác định đối tượng". Có dư đầu, phát sinh, dư cuối, so với "dở dang cuối theo thẻ".
- Tổng hợp chi phí theo khoản mục, yếu tố: khoảng "Đến tháng" cùng năm; so tổng chi phí tập hợp với phát sinh của các lần chạy giá thành, lệch nghĩa là chi phí đổi sau khi chạy.
- So sánh định mức nguyên vật liệu: thực tế (từ sổ cái và phiếu kho) với định mức × sản lượng hoàn thành; chênh lệch do lượng và do giá. Giá chuẩn lấy bằng đơn giá bình quân gia quyền trong tháng của vật tư (danh mục chưa có giá định mức); nguyên vật liệu xuất ngoài định mức hiện "(ngoài định mức)". Theo TT133 báo cáo này rỗng (không có TK 621).

Mỗi báo cáo có khối "Đối chiếu" với sổ cái; dòng chỉ để tham khảo không làm đỏ. Ví dụ dở dang cuối của thẻ so với dư 154 là tham khảo, vì thành phẩm nhập kho giá tạm còn nằm ở 154 cho đến khi chạy Tính giá vốn. Theo TT133, phần sản xuất chung đã phân bổ chỉ nằm ở kết quả giá thành, không nằm trên dòng 154 của sổ chi tiết.

## 14. Hợp đồng

Menu: Hợp đồng (`order.view`; thêm, sửa, xóa theo `order.*`). Danh sách lọc loại, trạng thái, tìm kiếm (bộ lọc được nhớ); Insert thêm.

Ngăn kéo hợp đồng có các thẻ:

- Thông tin hợp đồng: số hợp đồng, tên, loại (hợp đồng bán hoặc mua; hợp đồng cho thuê là bán, đi thuê là mua, thầu xây lắp là bán), đối tác, loại tiền (F4), giá trị, ngày ký, hiệu lực từ, hiệu lực đến, trạng thái (đang hiệu lực, hoàn thành, hủy…), TK mặc định (doanh thu cho hợp đồng bán, chi phí cho hợp đồng mua), Thuế GTGT mặc định (F4).
- Đợt thanh toán: lưới STT, nội dung, ngày dự kiến, tỷ lệ, số tiền (chưa thuế), thuế GTGT (F4). Nhập tỷ lệ thì số tiền tính lại từ giá trị ký (làm tròn theo loại tiền); đổi giá trị hợp đồng không tự tính lại đợt cũ (lưu lại đợt để tính). Tổng đợt lệch giá trị hợp đồng chỉ cảnh báo. Ctrl+S lưu hợp đồng, đợt, phụ lục một lần. Đợt đã lập hóa đơn không xóa, không đổi số tiền, thuế, trạng thái (`MILESTONE_INVOICED`), vẫn đổi nội dung, ngày, STT.
- Phụ lục: STT, số phụ lục, ngày ký, nội dung, tăng hoặc giảm giá trị (âm được), ghi chú; dòng "Giá trị sau phụ lục". Phụ lục chỉ gia hạn ghi 0. Báo cáo ngày cũ không thấy phụ lục ký sau.
- Theo dõi (có `contract_track.view`): chọn "Theo dõi tại ngày": giá trị, đã xuất (hoặc nhận) hóa đơn, % thực hiện, còn lại, công nợ, đợt quá hạn, bảng đợt với "Quá hạn lập hóa đơn".

### Chiều hợp đồng trên chứng từ

Ô "Hợp đồng (F4)" ở màn hình hóa đơn (HDB, HDM, bán hàng, mua hàng hóa, giảm giá, trả lại) ghi hợp đồng lên mọi dòng sổ cái của hóa đơn (doanh thu, công nợ, thuế, giá vốn). Hợp đồng phải cùng chiều mua hoặc bán với loại hóa đơn (`CONTRACT_KIND_MISMATCH`) và cùng đối tượng (`CONTRACT_PARTY_MISMATCH`). Phiếu thu, chi, giấy báo, phiếu kế toán có cột "Hợp đồng/Khế ước (F4)" theo dòng (F4 tra khế ước vay ở dòng 341, 335 và hợp đồng bán, mua ở dòng khác). Nhập Excel thu chi có cột "Mã hợp đồng/khế ước". Chiều hợp đồng của dòng đã ghi sổ không sửa được (cùng cột phục vụ khế ước vay): bỏ ghi sổ hoặc đảo, lập lại.

### Lập hóa đơn từ đợt

Nút "Lập hóa đơn từ đợt" (cần `order.update` và `voucher.create`): hộp thoại nhập ngày hạch toán, ngày hóa đơn, nhóm kê khai (F4), tài khoản hạch toán (F4, mặc định theo hợp đồng), ký hiệu hóa đơn điện tử (hợp đồng bán, để trống số) hoặc ký hiệu và số hóa đơn, tỷ giá nếu ngoại tệ. Phần mềm tạo hóa đơn bán (hợp đồng bán) hoặc hóa đơn mua dịch vụ (hợp đồng mua) ở trạng thái nháp, một dòng hàng bằng nội dung và số tiền chưa thuế của đợt, thuế của đợt hoặc của hợp đồng, kèm hợp đồng; bạn mở hóa đơn kiểm tra rồi ghi sổ. Điều kiện: hợp đồng đang hiệu lực (`CONTRACT_NOT_ACTIVE`), có đối tác (`CONTRACT_PARTY_REQUIRED`), có tài khoản (`CONTRACT_ACCOUNT_REQUIRED`), đợt chưa hủy và chưa lập. Bấm hai lần chỉ được một hóa đơn (lần hai báo đã lập). Xóa hóa đơn nháp, hủy hoặc đảo hóa đơn thì đợt trở về "Chưa lập hóa đơn" để lập lại; bỏ ghi sổ thì GIỮ liên kết (hóa đơn nháp vẫn là hóa đơn của đợt). Nút "Hủy đợt" và "Khôi phục đợt" bỏ hoặc phục hồi đợt kế hoạch.

## 15. Báo cáo hợp đồng, vụ việc

Menu: Báo cáo hợp đồng, vụ việc (`contract_track.view`). Ba thẻ đầu và thẻ số dư:

- Theo dõi thực hiện, quá hạn: tại ngày, hợp đồng bán hoặc mua, "Chỉ hợp đồng quá hạn". "Đã xuất hóa đơn" là tiền hàng trừ chiết khấu của hóa đơn đã ghi sổ có dòng mang hợp đồng, giảm giá và trả lại trừ đi; ngoại tệ chỉ cộng hóa đơn cùng loại tiền hợp đồng, cột VND cộng mọi hóa đơn. % thực hiện = đã xuất hóa đơn ÷ giá trị sau phụ lục. Công nợ hợp đồng theo sổ cái (VND): đã thu hoặc đã trả là mọi dòng không phải hóa đơn, còn phải thu hoặc trả bằng tổng Nợ trừ Có và khớp sổ cái. Quá hạn theo thứ tự cũ trước (hạn của khoản công nợ, không thì ngày dự kiến của đợt đã lập hóa đơn; không có thì chưa đến hạn). Số công nợ cần cờ `view_receivable` (hợp đồng bán) hoặc `view_payable` (hợp đồng mua); thiếu cờ thì các số đó để trống và có thông báo, còn giá trị, hóa đơn, đợt vẫn xem được; báo cáo tổng hợp quá hạn thì 403.
- Lãi lỗ theo hợp đồng và Lãi lỗ theo vụ việc (thêm cờ `view_cost`): doanh thu, giảm trừ, giá vốn, lãi gộp, chi phí bán hàng, quản lý gắn chiều, lãi (lỗ). Nhóm tài khoản theo chế độ (TT99, TT200: 511, 521, 632, 641, 642; TT133: 511, 632, 6421, 6422, sản xuất ở 154). Chi phí sản xuất (621 đến 627, TT133 154) gắn chiều chỉ hiển thị, không trừ trực tiếp vì đã vào giá vốn qua 154 (tránh tính trùng). Dòng không gắn chiều gom vào hàng ghim "Chưa gắn … (chi phí chung chưa phân bổ)". Vụ việc có cấu trúc cha con: số của cha cộng con; cột dự toán (từ "Giá trị dự toán" của danh mục vụ việc) và % chi phí trên dự toán. Chứng từ kết chuyển sang 911 và số dư đầu kỳ không tính (lãi lỗ là phát sinh).
- Số dư theo vụ việc, hợp đồng: dư đầu, phát sinh, dư cuối từng tài khoản theo vụ việc hoặc hợp đồng (ô "Tài khoản" để lọc một tài khoản; lọc cần cờ của tài khoản đó, không lọc cần đủ bốn cờ), có dòng "không gắn" để tổng theo tài khoản khớp sổ cái, và cột dở dang 154 theo vụ việc, hợp đồng. Đầu năm sau bằng cuối năm trước theo từng vụ việc (kết chuyển năm giữ chiều).

"In PDF" và "Xuất Excel" cần `report.print`. Màn Sổ sách kế toán, Sổ chi tiết có thêm bộ lọc F4 hợp đồng và đối tượng tập hợp chi phí.

## 16. Phân bổ chi phí chung vào vụ việc và kết chuyển giá vốn

Menu: Phân bổ chi phí vào vụ việc (`contract_track.view` và `view_cost`; chạy cần `contract_track.run`). Hai thẻ, mỗi thẻ chọn Năm tài chính, Kỳ.

### Phân bổ chi phí chung

Phần chung của mỗi tài khoản chi phí bán hàng và quản lý (TT99, TT200: 641, 642; TT133: 6421, 6422) là phát sinh Nợ trừ Có trong tháng của dòng không gắn vụ việc (không tính kết chuyển, số dư đầu kỳ và mọi phân bổ trước đó). Chọn "Tiêu thức phân bổ": Doanh thu thuần (của chính vụ việc), Chi phí trực tiếp (giá vốn, bán hàng, quản lý gắn chính vụ việc; tích "Cộng chi phí sản xuất" để thêm), hoặc Nhập tay (bảng trọng số theo mã vụ việc, F4). "Xem trước" hiện phần chung theo tài khoản và bảng phân bổ; "Chạy (F9)" sinh Chứng từ phân bổ (PB) ngày cuối tháng: Có tài khoản không chiều, Nợ cùng tài khoản gắn từng vụ việc. Tổng công ty theo tài khoản không đổi, "chưa phân bổ" của lãi lỗ vụ việc về 0. Làm tròn: các vụ việc (xếp theo mã) nhận phần làm tròn xuống đồng, vụ việc cuối nhận phần còn lại. Tổng tiêu thức bằng 0 mà có chi phí chung thì `PROJECT_ALLOC_BASIS_ZERO`; tài khoản dư Có thì không phân bổ (có cảnh báo).

Chạy lại: đổi số liệu rồi chạy lại thì đảo PB cũ, sinh PB mới; giống hệt thì "không đổi". Trạng thái Chưa chạy, Đã hạch toán, Cần chạy lại, Không có số liệu. Quy tắc soát lỗi `VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO` nhắc tháng còn chi phí chung chưa phân bổ.

### Kết chuyển giá vốn vụ việc, hợp đồng hoàn thành

Chọn "Vụ việc đã hoàn thành" và "Hợp đồng đã hoàn thành" (F4, thêm bằng "Thêm vụ việc", gỡ bằng thẻ). Chạy sinh Chứng từ giá thành (GT) ngày cuối tháng: Nợ 632, Có 154 giữ nguyên các chiều (vụ việc, hợp đồng, đối tượng, hàng, kho), với toàn bộ số dư Nợ 154 lũy kế đến cuối tháng của vụ việc hoặc hợp đồng được chọn. Dư Có không kết chuyển (có cảnh báo). Đây là bản kết chuyển tối thiểu: không theo tỷ lệ doanh thu đã ghi nhận hay phần trăm hoàn thành (xem hạn chế). Chạy lại cho kết quả như phân bổ.

## 17. Số dư đầu kỳ có chiều vụ việc, hợp đồng

Màn Sổ cái > Số dư đầu kỳ có thêm cột "Vụ việc (F4)" và "Hợp đồng/Khế ước (F4)" (F4 tra khế ước vay ở tài khoản 341, 335; hợp đồng bán, mua ở tài khoản khác như 131, 331, 154). Dòng có vụ việc ở 154 là dở dang theo vụ việc, ghi thẳng dòng sổ cái, không đối chiếu với tồn kho đầu kỳ. Hợp đồng bán, mua ở 341, 335 bị từ chối (`OPENING_CONTRACT_NOT_ALLOWED`). Dở dang đầu kỳ theo đối tượng tập hợp chi phí và 334 theo nhân viên chưa có cột. Công ty có số dư tài khoản lương thì người thiếu `view_salary` không dùng được màn này của năm đó (mục 20).

## 18. Quy trình cuối kỳ: hai bước mới

Menu: Sổ cái > Quy trình cuối kỳ. Thứ tự các bước nay là:

1. Tính lương và hạch toán (`payroll.post`, bước tùy chọn)
2. Phân bổ công cụ dụng cụ
3. Phân bổ chi phí trả trước
4. Khấu hao TSCĐ
5. Lãi vay
6. Tính giá vốn
7. Giá thành sản phẩm (`cost_run.run`, bước tùy chọn)
8. Phân bổ doanh thu nhận trước
9. Tỷ giá xuất quỹ
10. Đánh giá lại ngoại tệ (tùy chọn)
11. Khấu trừ thuế GTGT
12. Kết chuyển

Hệ quả so với giai đoạn 4: tính giá vốn nay đứng sau khấu hao, phân bổ nên chạy giá vốn sau khấu hao không còn làm khấu hao "Cần chạy lại"; khấu hao chạy sau giá vốn thì giá vốn "Cần chạy lại". Phần mềm vẫn không chặn chạy sai thứ tự, chỉ báo bằng trạng thái.

- Bước lương: kỳ không có bảng lương thì ghi "Đã bỏ qua" và các bước sau không phải chạy lại. Bảng lương đã tính hợp lệ được hạch toán; bảng đã hạch toán được chạy lại (giống hệt thì không đổi, khác thì đảo LU cũ và sinh mới). Bảng nháp hoặc đang "Cần tính lại" không tự tính: bước vẫn hạch toán các bảng khác nhưng báo chưa hoàn tất (số bảng còn lại), bạn tính rồi chạy lại. "Cần chạy lại" khi còn bảng lương trong kỳ chưa hạch toán hoặc bảng đã hạch toán đổi dữ liệu nguồn hay cấu hình hạch toán (bộ phận, tỷ lệ phân bổ chi phí của nhân viên, tài khoản chi phí theo bộ phận).
- Bước giá thành: chạy với tham số đã lưu của kỳ (chưa có lần chạy thì dùng mặc định: phương pháp theo loại đối tượng, không dở dang). Kỳ không có chi phí sản xuất nào thì tự ghi "Đã bỏ qua", không tạo lần chạy. Kỳ có chi phí sản xuất chung chưa gắn đối tượng mà chưa khai tiêu thức thì báo `OVERHEAD_BASIS_ZERO`: vào Tính giá thành khai tiêu thức và chạy, rồi chạy lại bước. Lỗi chặn (chưa phân loại, chưa gắn đối tượng, kỳ khóa) hiện nguyên thông báo, bước không ghi nhật ký. "Cần chạy lại" khi chi phí, nhập kho thành phẩm hoặc dở dang đầu đổi. Vì giá thành tạo lớp giá nhập mới, sau bước này Tính giá vốn hiện "Cần chạy lại"; chạy giá vốn rồi chạy lại giá thành ra "không đổi" nên hội tụ sau một vòng.
- Che theo cờ: thiếu `view_salary` thì bước lương chỉ hiện trạng thái chung, không số chứng từ, không số bảng; thiếu `view_cost` thì bước giá thành tương tự (chú thích "chi tiết lương cần quyền xem lương", "chi tiết giá thành cần quyền xem giá vốn"). Chạy bước lương hoặc giá thành khi kỳ có dữ liệu mà thiếu cờ tương ứng thì bị từ chối (403 `SALARY_FORBIDDEN` hoặc `FORBIDDEN`) và không ghi gì; kỳ không có dữ liệu lương/giá thành, hoặc bước được bỏ qua tay, vẫn chạy được để công ty không dùng phân hệ này không bị kẹt quy trình.
- Phím F9 chạy cả hai bước mới như các bước khác.

## 19. Soát lỗi mới (50 quy tắc)

Tiện ích > Soát lỗi dữ liệu: GĐ6 thêm 14 quy tắc, nâng tổng lên 50. Quy tắc lương cần `view_salary`, giá thành cần `view_cost`; thiếu cờ thì quy tắc bị bỏ qua hoàn toàn ("Bỏ qua do thiếu quyền xem lương" hoặc "giá vốn") và có cảnh báo "Có quy tắc không được chạy".

| Mã | Mức | Báo khi |
|---|---|---|
| LUONG_THIEU_MST | Lỗi/Cảnh báo | Nhân viên có thu nhập tính thuế mà chưa có MST |
| LUONG_THIEU_TK_NH | | Trả chuyển khoản mà chưa có số tài khoản nhận |
| LUONG_NV_NGHI_VAN_TINH | | Nhân viên đã nghỉ việc từ trước tháng bảng lương mà vẫn có thu nhập |
| LUONG_CAN_TINH_LAI | | Bảng lương đã tính hoặc hạch toán có dữ liệu nguồn đổi (tính theo chữ ký đầu vào) |
| LUONG_LECH_SO_CAI | | Bảng đã hạch toán: Có trừ Nợ 334 của nhân viên trên LU khác thực lĩnh |
| LUONG_BH_VUOT_TRAN | | Lương đóng bảo hiểm trong bảng vượt mức trần (chỉ báo khi đã nhập tham số trần) |
| GIA_THANH_CAN_CHAY_LAI | | Lần chạy giá thành có dữ liệu nguồn đổi |
| GIA_THANH_154_CON_DU | | Đã có giá vốn trong tháng mà dư 154 khác dở dang cuối của lần chạy giá thành |
| GIA_THANH_THIEU_DINH_MUC | | Đối tượng sản phẩm, đơn hàng có nguyên vật liệu phát sinh mà không có định mức hiệu lực |
| GIA_THANH_621_622_627_CON_DU | | Kỳ đã kết chuyển mà 621, 622, 623, 627 cuối kỳ khác 0 |
| GIA_THANH_DAU_RA_KHONG_MA_HANG | | Đối tượng vụ việc, hợp đồng, đơn hàng đã hoàn thành mà 154 còn dư (chưa kết chuyển giá vốn) |
| HOP_DONG_QUA_HAN_DOT | | Đợt kế hoạch quá hạn mà chưa có hóa đơn đã ghi sổ |
| HOP_DONG_VUOT_GIA_TRI | | Hóa đơn lũy kế vượt giá trị hợp đồng cộng phụ lục |
| VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO | Cảnh báo | Tháng có vụ việc hoạt động mà chi phí bán hàng, quản lý chung còn chưa phân bổ (nhìn lùi tối đa 36 tháng) |

Hai quy tắc hợp đồng không cần cờ.

## 20. Phân quyền và cờ nhạy cảm

Quyền mới (xem, thêm, sửa, xóa theo nhóm): `payroll.view|create|update|delete|post|param|pay|export`, `attendance.*`, `costing_obj.*`, `cost_run.view|run`, `contract_track.view|run`. Vai trò Kế toán viên mặc định không có `payroll.post`, `payroll.param`, `payroll.export`; vai trò chỉ xem chỉ có các quyền `.view`.

Cờ dữ liệu nhạy cảm (gán cho từng người dùng, chặn ở máy chủ):

- `view_salary` (xem lương): mọi màn hình và route lương (hồ sơ, bảng lương, cấu trúc, báo cáo, TNCN, chi lương, mẫu tệp chi lương), trừ Tham số lương và Chấm công. Cờ cũng che các tài khoản lương (phải trả người lao động 334 và tài khoản con; KPCĐ 3382, BHXH 3383, BHYT 3384, BHTN; thuế TNCN 3335 và khoản phải nộp 3388 không che) trong sổ cái, số dư, báo cáo, chứng từ. Chứng từ có dòng lương: thiếu cờ thì dòng đó hiện 0, không có nhân viên, tổng tiền hiện "—", chứng từ chỉ để xem (không sửa, ghi sổ, in; in và sửa cả bộ dòng báo 403). Sổ chi tiết lọc theo nhân viên cần cờ. Nhật ký kiểm toán bỏ sự kiện lương. Sổ quỹ, sổ tiền gửi: chứng từ lương hiện diễn giải "Đã ẩn do thiếu quyền xem lương" và tài khoản đối ứng 334 bị che, nhưng số thu chi và số dư giữ nguyên (xem hạn chế). Số dư đầu kỳ: xem mục 17.
- `view_cost` (xem giá vốn): thêm các route giá thành (tính, báo cáo, tập hợp chi phí), lãi lỗ hợp đồng và vụ việc, phân bổ chi phí vào vụ việc; không chặn danh mục đối tượng, định mức, hợp đồng và theo dõi. Chứng từ có dòng 154 vẫn theo cờ này như giai đoạn 3.
- Gói xuất dữ liệu cho cơ quan thẩm quyền, Sổ Nhật ký chung, Bảng cân đối số phát sinh và bộ sổ năm nay cần cả bốn cờ (`view_receivable`, `view_payable`, `view_cost`, `view_salary`).
- Số công nợ của theo dõi hợp đồng cần `view_receivable` (hợp đồng bán), `view_payable` (hợp đồng mua).

## 21. Hạn chế đã biết

Tệp, mẫu và biểu mẫu chưa theo văn bản chính thức:

1. Tệp danh sách BHXH là bảng cột chung, không phải mẫu D02-LT hay TK1-TS của cơ quan bảo hiểm (chưa có văn bản gốc, chưa có đặc tả công khai); kê khai trên cổng BHXH phải nhập lại hoặc dán.
2. Bảng thanh toán tiền lương, báo cáo bảo hiểm, bảng kê TNCN không in số mẫu: mẫu của chế độ hiện hành chưa nhập từ văn bản gốc. Chứng từ khấu trừ thuế TNCN in tổng hợp, không có mẫu số, ký hiệu, số chứng từ.
3. Thẻ tính giá thành và sổ chi tiết TK 154 không in số mẫu (S37-DN).
4. Tờ khai 05/KK-TNCN, 05/QTT-TNCN chỉ là bảng kê số liệu; XML và ký số trả `TNCN_TEMPLATE_UNAVAILABLE` đến khi cổng pháp lý `05KK_TNCN_TT89` và `05QTT_TNCN_TT89` bật (cần mẫu từ Phụ lục I TT 89/2026). Cổng tham số lương (`payrollParams_pit|si|minWage`) cũng đang tắt.
5. Chi lương theo lô chỉ có bố cục "Chung" và các cột bạn tự khai; chưa có mẫu của ngân hàng nào, mã hóa chỉ UTF-8, chưa thử trên hệ thống ngân hàng, không kiểm số tài khoản theo ngân hàng, không có trường chi nhánh (dùng cột giá trị cố định). Trong tệp chi lương và các tệp Excel, CSV GĐ6, ô văn bản bắt đầu bằng `=`, `+`, `-`, `@` bị thêm dấu nháy đơn phía trước để Excel không chạy công thức nên dấu nháy hiện trong ô; khoảng trắng đầu ô không được cắt.

Lương và thuế TNCN:

6. Tham số `pit_income_timing = payment_date` chưa hỗ trợ: bảng kê vẫn tính theo kỳ lương và cảnh báo.
7. Khấu trừ thuế ngoài lương (hóa đơn mua dịch vụ `TNCN_KT`) chỉ có số thuế, chưa có thu nhập chịu thuế trả cho cá nhân (hóa đơn không lưu dòng thuế TNCN riêng).
8. Cư trú, loại hợp đồng, ủy quyền quyết toán lấy theo hồ sơ lương hiện hành, không theo từng tháng.
9. Người không cư trú, hợp đồng ngắn, không hợp đồng: thuế theo tỷ lệ cố định, không có ngưỡng không khấu trừ; quy tắc làm dưới nửa tháng cho bảo hiểm không tự áp dụng (bạn đánh dấu tham gia hay không).
10. Mỗi bảng lương chỉ có một phiếu chi lương, một chứng từ nộp bảo hiểm, một chứng từ nộp thuế TNCN; chưa tách chi lương nhiều phiếu (một phần tiền mặt, một phần ngân hàng) hay chọn nhân viên.
11. KPCĐ (3382) không nằm trong chứng từ nộp bảo hiểm. Tài khoản Có của cột khấu trừ là một mã cho mọi chế độ kế toán (cấu trúc không theo chế độ); bỏ trống thì theo chế độ (tạm ứng 141, khác 3388).
12. Danh sách nhân viên của bảng lương cố định lúc tạo (chưa có ô chọn từng nhân viên, chỉ theo bộ phận); nhân viên vào sau thì xóa bảng nháp lập lại. Phụ cấp có hiệu lực giao kỳ tính nguyên tháng, không chia theo ngày công. Bộ phận của nhân viên lấy theo danh mục lúc hạch toán, không lưu theo kỳ.
13. Tài khoản chi phí lương theo bộ phận chưa có màn hình cấu hình (dùng API, mục 6).
14. Bước lương hoặc giá thành đã "Đã bỏ qua" mà sau đó mới phát sinh bảng lương hoặc chi phí sản xuất thì không tự thành "Cần chạy lại": hạch toán ở màn Bảng lương hoặc Tính giá thành.
15. Phiếu chi lương nháp cũ không tự mất khi bảng lương hạch toán lại: kiểm tra kẻo chi trùng.
16. Quỹ: sổ quỹ và sổ tiền gửi vẫn cho người thiếu `view_salary` suy ra tổng chi lương trong ngày từ số tiền chi (sổ quỹ phải khớp tồn quỹ thật). Số dư đầu kỳ: nếu công ty có số dư tài khoản lương (334 theo nhân viên, bảo hiểm, thuế) thì người thiếu `view_salary` bị 403 cả màn Số dư đầu kỳ của năm đó, không chỉ dòng lương.
17. Lưới bảng lương chưa đo với 500 nhân viên × 40 cột; bảng lương và cấu trúc chưa có phân trang. Chưa gửi email phiếu lương.

Giá thành:

18. Kỳ có chi phí sản xuất chung (627) chưa gắn đối tượng cần khai tiêu thức ở màn Tính giá thành trước khi chạy bước cuối kỳ.
19. Sửa giá nhập tay của dòng phiếu nhập thành phẩm đã nhận giá thành không tự báo giá thành "Cần chạy lại"; chạy lại giá thành đưa về đúng phần chia. Chạy giá thành không thay đổi lớp giá nhập cũ đã ghi ở giá vốn.
20. Phương pháp đánh giá dở dang chỉ gồm: không có, theo nguyên vật liệu trực tiếp, theo sản lượng tương đương (bình quân); chưa có FIFO tương đương, dở dang theo định mức hay nhập tay. Chưa có giá thành phân bước nhiều công đoạn. Vụ việc, đơn hàng không đánh giá dở dang từng phần: chưa hoàn thành thì toàn bộ nằm ở dở dang.
21. Chi phí thuê gia công ghi thẳng 154 ở TT99, TT200 chưa được tập hợp (chỉ lấy 621, 622, 627).
22. Công ty bắt đầu giữa chừng có dở dang đầu kỳ thì lần chạy đầu thiếu dở dang đầu (số dư đầu 154 theo đối tượng chưa nhập được). Tài khoản 154 phải là tài khoản lá.
23. Phiếu xuất kho cho sản xuất chưa có cột đối tượng giá thành: gắn đối tượng cho dòng 621 sau khi ghi sổ (sửa chiều) hoặc gắn qua vụ việc, hợp đồng.
24. Theo TT133, phần sản xuất chung đã phân bổ không nằm trên dòng 154 theo đối tượng ở sổ chi tiết. So sánh định mức dùng giá chuẩn bình quân kỳ và chưa quy đổi dở dang vào số lượng định mức; báo cáo giá thành theo tháng (tổng hợp chi phí có khoảng tháng). Dòng 621 ghi bằng phiếu kế toán không qua phiếu kho không có số lượng.
25. Quy tắc soát lỗi chi phí chung chưa phân bổ nhìn lùi 36 tháng, trang Soát lỗi có thể chậm hơn với công ty lớn (chưa đo).

Hợp đồng và vụ việc:

26. Kết chuyển giá vốn 154 sang 632 là bản tối thiểu: kết chuyển toàn bộ số dư của vụ việc, hợp đồng bạn đánh dấu đã hoàn thành, không theo tỷ lệ doanh thu đã ghi nhận hay phần trăm hoàn thành. Chạy sai thứ tự tháng (ví dụ chạy tháng sau trước tháng trước) có thể kết chuyển hai lần cùng số dư: chạy theo thứ tự tháng và kiểm bằng Số dư theo vụ việc.
27. Chứng từ PB, GT bị đảo ngoài màn hình (hàm đảo gọi thẳng, vì màn hình chứng từ đã chặn) làm lần chạy thành "Cần chạy lại"; chạy lại sinh bản mới, không phân bổ trùng. Phân bổ chỉ có ba tiêu thức (doanh thu thuần, chi phí trực tiếp, nhập tay), chưa theo doanh thu đã ghi nhận.
28. Nhập số dư đầu kỳ từ Excel chưa có cột vụ việc và hợp đồng, và nhập Excel thay toàn bộ nên xóa dòng vụ việc đã nhập tay trên màn hình; nhập tay hoặc API thì có.
29. Công nợ hợp đồng theo sổ cái (VND): bán hàng thu tiền ngay vào 111, 112 không qua 131 không vào "đã thu" của hợp đồng. Hợp đồng ngoại tệ chưa được kiểm tra đầy đủ (hóa đơn từ đợt ngoại tệ dùng đúng dịch vụ hóa đơn có tỷ giá nhưng chưa thử).
30. Bỏ ghi sổ hóa đơn lập từ đợt vẫn giữ liên kết với đợt. Chưa có hóa đơn gộp nhiều đợt. Đợt tính theo tỷ lệ nhân giá trị ký, không nhân giá trị sau phụ lục. Loại hợp đồng chỉ bán và mua. Chiều hợp đồng (`contract_id`) của dòng đã ghi sổ không sửa được.
31. Lãi lỗ vụ việc không cộng chi phí sản xuất vào chi phí (vào giá vốn qua 154), nên vụ việc xây lắp chưa kết chuyển giá vốn có % chi phí trên dự toán thấp; xem cột chi phí sản xuất. Chưa đo hiệu năng với hàng nghìn hợp đồng; chưa kiểm khi kỳ tài chính không trùng tháng dương lịch.

Khác:

32. Trên máy phát triển không có Chromium đầy đủ nên một số kiểm thử in PDF đỏ sẵn (ghi ở `docs/dev/kiem-thu.md`); không ảnh hưởng chức năng khi triển khai có trình duyệt.

## 22. Việc người dùng cần cung cấp

Những việc này agent không làm thay được và quyết định số liệu pháp lý, nên ghi ở `docs/TIEP-THEO.md` mục "Chờ người dùng":

| Cần | Chép vào | Vì sao |
|---|---|---|
| Luật Thuế thu nhập cá nhân số 109/2025/QH15 và văn bản hướng dẫn (thuế suất, giảm trừ gia cảnh kỳ 2026) | `~/legal-docs/tncn-2025/` | Nhập tham số thuế từ văn bản gốc, không từ trí nhớ |
| Văn bản BHXH, BHYT, BHTN hiện hành (tỷ lệ, mức trần, mức sàn) và lương tối thiểu vùng 2026 | `~/legal-docs/` | Cùng lý do; hiện bạn phải tự nhập ở màn Tham số lương kèm nguồn |
| Ảnh trang hoặc PDF có chữ mẫu 05/KK-TNCN, 05/QTT-TNCN, các phụ lục bảng kê và mẫu chứng từ khấu trừ thuế TNCN trong Thông tư 89/2026/TT-BTC Phụ lục I | `~/legal-docs/tt89-2026/` | Dựng tờ khai theo mẫu, XML, ký số; in chứng từ khấu trừ có mẫu số |
| Mẫu tệp nhập chi hộ (chi lương) của từng ngân hàng công ty dùng | cùng thư mục tài liệu pháp lý hoặc tệp mẫu | Tạo mẫu sẵn cho từng ngân hàng |
| Mẫu tệp kê khai I-VAN của cơ quan BHXH (D02-LT, TK1-TS nếu áp dụng) và đặc tả | như trên | Xuất tệp BHXH đúng định dạng |
| Mẫu thẻ tính giá thành (TT133, TT99 và TT200 nếu cần), mẫu bảng thanh toán tiền lương, nếu muốn in đủ "Mẫu số" | `~/legal-docs/` | In số mẫu trên báo cáo |
| Tài khoản thử nghiệm các hệ thống bên ngoài nếu dùng (ngân hàng, cổng BHXH) | | Các tích hợp chưa thử trên môi trường thật |

Khi các văn bản có, báo cho người phát triển: tham số sẽ được nhập vào dữ liệu pháp lý có kiểm và cổng pháp lý được bật; các mẫu được nhập từ ảnh trang gốc.
