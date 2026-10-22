# Kho, mua hàng và bán hàng hóa (giai đoạn 3)

Giai đoạn 3 thêm kế toán vật tư hàng hóa: danh mục vật tư, kho, nhập kho, xuất kho, giá vốn, hóa đơn mua và bán hàng hóa. Tài liệu này mô tả đúng những gì phần mềm đang làm và được bổ sung dần theo từng tác vụ. Phím tắt vẫn như các giai đoạn trước: Enter/Tab sang ô kế tiếp, F4 tra cứu danh mục, Ctrl+S lưu, F9 ghi sổ, Insert thêm mới.

## Danh mục

### Cách dùng chung của Danh mục

Mọi danh mục (đối tượng, nhóm đối tượng, bộ phận, ngân hàng, đơn vị tính, vật tư hàng hóa, kho…) nằm trong menu Danh mục hoặc menu Kho và dùng chung một cách thao tác.

- Thêm: bấm nút Thêm hoặc phím Insert, điền biểu mẫu, bấm Đồng ý. Ví dụ thêm một đối tượng: vào Danh mục, Đối tượng, nhập Mã và Tên đối tượng.
- Tìm: ô "Tìm mã, tên…" lọc theo mã và tên. Bộ lọc được nhớ cho lần mở sau.
- Ngưng dùng: bấm "Ngưng dùng" ở cuối dòng. Mục ngưng dùng không còn hiện trong danh sách tra cứu F4 nhưng chứng từ cũ vẫn giữ nguyên. Chọn "Ngưng dùng" hoặc "Tất cả" ở ô Trạng thái để xem lại, bấm "Dùng lại" để dùng tiếp. Mục đã phát sinh chứng từ không xóa được, chỉ ngưng dùng.
- Nhập từ Excel: dùng chức năng nhập Excel của từng danh mục; dòng sai được báo theo số dòng và tên cột trong tệp.

### Vật tư hàng hóa

Menu Kho, Vật tư hàng hóa. Mỗi vật tư hàng hóa có ba nhóm thông tin.

- Thông tin chung: Mã, Tên, Tên tiếng Anh, Nhóm, Tính chất (Hàng hóa, Nguyên vật liệu, Thành phẩm, Dịch vụ, Công cụ dụng cụ), ĐVT cơ sở, thuế suất mặc định, tồn tối thiểu và tối đa, vị trí kho, mã vạch, tài khoản kho, tài khoản doanh thu, tài khoản giá vốn. Dịch vụ không có tồn kho.
- ĐVT quy đổi: khi lưu vật tư, phần mềm tự thêm dòng ĐVT cơ sở với hệ số 1. Sau khi lưu, mở lại vật tư, chọn thẻ "ĐVT quy đổi", chọn ĐVT và nhập hệ số quy đổi ra ĐVT cơ sở (ví dụ THUNG = 24 khi ĐVT cơ sở là CAI), bấm "Thêm ĐVT". Dòng ĐVT cơ sở không xóa được.
- Lô, hạn dùng: chọn theo dõi theo lô hoặc theo lô và hạn dùng, nhập số ngày hạn dùng.

Nhóm vật tư hàng hóa (menu Kho) là danh mục dạng cây: một nhóm có thể thuộc nhóm cha.

### Nhập Excel vật tư hàng hóa

Tệp nhập có thêm cột "ĐVT quy đổi" viết dạng `THUNG=24;HOP=6`, mỗi cặp là mã ĐVT và hệ số quy đổi ra ĐVT cơ sở. Phần mềm báo lỗi bằng tiếng Việt kèm số dòng và tên cột, ví dụ "Dòng 6, cột ĐVT quy đổi: …", khi gặp ĐVT không có trong danh mục, ĐVT trùng, ĐVT trùng ĐVT cơ sở, hệ số không phải số dương hoặc sai khuôn dạng. Số dòng là số dòng trong tệp Excel.

### Kho

Menu Kho, Kho. Mỗi kho có Mã, Tên, Loại kho (Kho thường, Kho gửi bán dùng TK 157, Kho nhận bán hộ), TK kho, Phương pháp tính giá xuất (Bình quân cuối kỳ, Bình quân tức thời, Nhập trước xuất trước, Đích danh) và Chi nhánh.

### Bảng giá

Menu Kho, Bảng giá (Insert để thêm). Mỗi bảng giá có Mã, Tên, Loại (giá bán hoặc giá mua), Loại tiền, Nhóm đối tượng (để trống là áp dụng chung), Hiệu lực từ, Đến (để trống là không giới hạn) và Ưu tiên.

Dòng giá nhập trên lưới: Mã hàng (F4), ĐVT (F4), Từ số lượng, Đơn giá, Chiết khấu (%). Cùng một hàng và ĐVT có thể có nhiều bậc theo "Từ số lượng": mua 10 lấy giá bậc từ 10. Ctrl+S để lưu. Có thể nhập dòng giá từ Excel (nút "Nhập Excel" khi sửa bảng giá, tải mẫu ở liên kết bên cạnh).

Khi lập chứng từ, phần mềm chọn bảng giá còn hiệu lực ở ngày chứng từ, đúng loại tiền; bảng giá gắn nhóm của đối tượng được ưu tiên trước bảng giá chung, sau đó đến Ưu tiên cao hơn. Giá chỉ điền sẵn vào dòng chứng từ để gợi ý, vẫn sửa được và không ràng buộc sổ cái.

### Tồn kho đầu kỳ

Menu Sổ cái, Tồn kho đầu kỳ. Nhập tồn đầu năm theo Kho, Mã hàng (F4), Số lượng, Giá trị, Số lô và Hạn dùng (dd/mm/yyyy). Số lượng tính theo ĐVT cơ sở của hàng. Hàng theo dõi lô phải có Số lô; hàng theo dõi lô và hạn dùng phải có thêm Hạn dùng. Cùng kho, hàng, lô chỉ có một dòng. Ctrl+S hoặc nút Lưu để lưu; nút Tải mẫu Excel và Nhập Excel dùng được như ở Số dư đầu kỳ (dòng sai báo số dòng và tên cột, không nhập dòng nào).

Số dư đầu kỳ của tài khoản kho (152, 153, 155, 156...) nhập ở màn hình Số dư đầu kỳ và phải bằng tổng Giá trị tồn đầu kỳ của các kho dùng tài khoản đó (kho chưa gắn tài khoản lấy theo hàng, rồi 156). Lệch thì Kiểm tra và Ghi sổ báo "OPENING_STOCK_MISMATCH" kèm tài khoản và chênh lệch. Tài khoản tài sản cố định (211...) vẫn chưa nhập được ở đây.

Ghi sổ số dư đầu kỳ sinh phiếu nhập kho ở kỳ đầu kỳ (ngày liền trước ngày đầu năm), nên phiếu xuất sau đó dùng được tồn này và tính giá vốn đọc đúng giá trị. Bỏ ghi sổ số dư đầu kỳ khi đã có phiếu xuất dùng tồn này bị từ chối "STOCK_CONSUMED". Xem và sửa tồn đầu kỳ cần cờ "xem giá vốn" vì có giá trị. Chuyển tồn cuối năm sang đầu năm sau chưa có, sẽ làm ở giai đoạn 7.

### Giá vốn chưa cập nhật và sửa giá nhập thành phẩm

Khi ghi sổ, bỏ ghi sổ hoặc đảo một phiếu kho vào kỳ đã tính giá vốn, phần mềm hiện biểu ngữ "Giá vốn của hàng X kho Y chưa cập nhật từ ngày ..." ở màn hình Tính giá vốn và ở phiếu kho liên quan. Chạy lại Tính giá vốn cho kỳ đó: chứng từ giá vốn cũ được đảo, chứng từ mới được sinh; chứng từ gốc không bị sửa.

Phiếu nhập thành phẩm đã ghi sổ có giá nhập sai không sửa trực tiếp được. Người có quyền Tính giá vốn và cờ xem giá vốn sửa giá nhập bằng chức năng điều chỉnh giá nhập (hiện qua API `PUT /api/stock-vouchers/{id}/receipt-price`, chưa có ô trên màn hình): phần mềm ghi một lớp điều chỉnh, đánh dấu giá vốn chưa cập nhật từ ngày phiếu, và lần Tính giá vốn sau ghi phần chênh bằng chứng từ giá vốn (Nợ tài khoản kho, Có tài khoản đối ứng của dòng nhập, thường 154) cùng chênh lệch giá vốn của các lần đã xuất.

### Các khóa an toàn

Phần mềm từ chối (lỗi 409) các thay đổi làm sai lệch số liệu đã có:

- Đổi ĐVT cơ sở của vật tư đã phát sinh chứng từ: "ITEM_UOM_LOCKED".
- Đổi cách theo dõi lô, hạn dùng của vật tư đã phát sinh: "ITEM_TRACKING_LOCKED".
- Xóa vật tư đã phát sinh chứng từ: "ITEM_IN_USE". Hãy chọn "Ngưng dùng".

### Phân quyền

Vật tư hàng hóa dùng nhóm quyền `item.*`, kho dùng `warehouse.*`, bảng giá dùng `price_list.*`. Quản trị viên cấp cho từng vai trò.

## Mua hàng hóa

Menu Mua hàng, "Mua hàng hóa" (loại MH) lập hóa đơn mua có dòng hàng nhập kho. Mỗi dòng chọn Mã hàng (F4), ĐVT, Kho, số lượng, đơn giá, mã thuế; có thể nhập số lô và hạn dùng. Chiết khấu thương mại nhập ở cột % chiết khấu hoặc tiền chiết khấu. Nếu đơn giá cao hơn bảng giá mua từ mức cảnh báo (mặc định 20%, đặt ở thiết lập `purchase_price_warn_pct`), phần mềm hiện cảnh báo nhưng vẫn lưu.

Chọn "Cách nhận hàng" ở đầu tab Hàng tiền:

- **Nhập kho cùng hóa đơn:** ghi sổ Nợ TK kho, Nợ 1331, Có 331 (hoặc 111, 112) và sinh phát sinh nhập kho ngay.
- **Hàng về trước, hóa đơn về sau:** lập và ghi sổ Phiếu nhập kho mua hàng trước (giá tạm tính). Khi hóa đơn về, lập MH và chọn các phiếu nhập kho đã nhận. Phần mềm không nhập kho lần nữa: ghi Nợ 1331, chênh giá giữa hóa đơn và giá tạm tính vào TK kho, Có 331 phần chênh. Chênh giá được giữ thành lớp điều chỉnh giá vốn, cần tính lại giá vốn từ ngày nhập.
- **Hóa đơn về trước, hàng về sau:** ghi sổ Nợ 151 (hàng đang đi đường), Nợ 1331, Có 331, chưa nhập kho. Khi hàng về, lập Phiếu nhập kho mua hàng, điền hóa đơn nguồn (`sourceInvoiceIds`): phiếu ghi Nợ 156, Có 151 theo số tiền trên hóa đơn. Hóa đơn phải đã ghi sổ.
- **Công nợ phải trả:** số tiền tạm tính trên Phiếu nhập kho (hàng về trước hóa đơn) và phần chênh khi hóa đơn về là hai khoản mở riêng trên TK 331, đối trừ khi thanh toán. Hóa đơn hàng về trước phải cùng nhà cung cấp với phiếu nhập và phiếu nhập phải đã ghi sổ; trả lại hàng không vượt số lượng đã nhập. Hóa đơn đã có lần tính giá vốn phủ ngày nhập thì không bỏ ghi sổ, hãy đảo.

"Trả lại, giảm giá hàng mua" (loại TLM) chọn hóa đơn gốc là một MH đã ghi sổ. Trả lại hàng: nhập "Mã dòng nhập gốc" và số lượng; hàng xuất theo đúng giá vốn lúc nhập, số tiền hàng phải bằng số lượng nhân giá nhập (ghi Nợ 331, Có kho, Có 1331). Chỉ giảm giá: để trống mã dòng, phần giảm giảm giá trị tồn kho.

Không sửa, không bỏ ghi sổ được MH hoặc Phiếu nhập kho khi chứng từ khác đã dùng nó (lỗi "LINE_REFERENCED"); phiếu nhập kho theo hóa đơn về trước cần hóa đơn đã ghi sổ ("INVOICE_NOT_POSTED"). Đảo MH mà hàng đã xuất hết thì bị chặn "STOCK_NEGATIVE". Dùng thêm quyền `stock_voucher.*` khi chứng từ có dòng hàng; xem giá vốn cần cờ view_cost.

## Bán hàng hóa

Menu Bán hàng, "Bán hàng hóa" (loại BH) lập hóa đơn bán kiêm phiếu xuất kho. Mỗi dòng chọn Mã hàng (F4), ĐVT, Kho, số lượng, đơn giá, mã thuế; hàng dịch vụ chỉ ghi doanh thu, không xuất kho.

- **Bút toán:** Nợ 131 (hoặc 111, 112), Có TK doanh thu (5111...), Có 33311; đồng thời Nợ 632 (hoặc TK giá vốn của hàng) / Có TK kho theo giá vốn tạm tính của hàng tại ngày bán, và sinh phát sinh xuất kho. Bán nhiều ĐVT (ví dụ thùng) được quy ra ĐVT gốc.
- **Giá vốn thực tế:** khi chạy "Tính giá vốn", chênh lệch so với giá tạm tính được ghi bằng chứng từ GV (Nợ 632 / Có TK kho).
- **Kho gửi bán:** chuyển hàng sang kho loại "Kho gửi bán" (TK 157) bằng Phiếu chuyển kho; khi bán từ kho này ghi Nợ 632 / Có 157. Kho "nhận bán hộ" chỉ theo dõi số lượng, chưa bán được từ kho này.
- **Hàng xuất khẩu:** đánh dấu "Hàng xuất khẩu (thuế GTGT 0%)" để dòng chưa có mã thuế tự nhận mã thuế suất 0%.
- **Cảnh báo:** "bán thấp hơn giá vốn" (số liệu giá vốn chỉ hiện cho người có quyền xem giá vốn) và "giá lệch bảng giá".

"Hàng bán bị trả lại" (loại TLB) chọn hóa đơn gốc là một BH đã ghi sổ, nhập "Mã dòng bán gốc" và số lượng trả. Hàng nhập lại kho theo giá vốn của dòng bán gốc (giá vốn thực tế nếu đã tính); ghi Nợ TK kho / Có 632 và Nợ TK giảm trừ doanh thu / Có 131 (TT200: 5213 Hàng bán bị trả lại; TT99: 521; TT133 không có TK 521 nên ghi giảm thẳng TK doanh thu của dòng bán gốc; có thể đổi bằng cột tài khoản). Trả vượt số đã bán báo "RETURN_EXCEEDS_SALE". BH đã có hàng trả lại thì không bỏ ghi sổ, không đảo được. Chỉ giảm giá về tiền thì dùng "Giảm giá bán".

## Báo giá, đơn hàng, hợp đồng

Menu Bán hàng: "Báo giá", "Đơn đặt hàng bán"; menu Mua hàng: "Đơn đặt hàng mua". Các chứng từ này chưa ghi sổ cái và chưa làm thay đổi tồn kho. Mỗi loại đánh số riêng theo năm (BG-2026-0001, DH-..., DM-...).

- **Lập đơn:** Insert, chọn khách hàng (nhà cung cấp), nhập dòng hàng bằng bàn phím (Mã hàng, ĐVT, Kho, Số lượng, Đơn giá, Mã thuế), Ctrl+S. Bỏ trống đơn giá thì lấy từ bảng giá còn hiệu lực; không có trong bảng giá thì báo lỗi, hãy nhập tay. Có thể ghi Mã hợp đồng (hợp đồng tạo qua danh mục hợp đồng của hệ thống).
- **Duyệt, hủy, xóa:** đơn nháp duyệt thành "Đã duyệt". Chỉ sửa, hủy được đơn chưa chuyển thành chứng từ; chỉ xóa đơn nháp.
- **Báo giá thành đơn bán:** nút "Thành đơn bán" đổi loại và cấp số đơn bán mới.
- **Lập BH nháp / MH nháp:** chuyển toàn bộ hoặc một phần số lượng còn lại (nhập số lượng từng dòng); phần mềm tạo chứng từ Bán hàng hóa (từ báo giá, đơn bán) hoặc Mua hàng hóa (từ đơn mua) ở trạng thái nháp, rồi mở chứng từ đó để bạn bổ sung số hóa đơn và ghi sổ. Đơn chuyển một phần có trạng thái "Chuyển một phần", chuyển hết là "Hoàn thành". Chuyển vượt số còn lại bị từ chối. Dòng chưa có kho cần chọn kho khi chuyển.
- **Trả số lượng:** xóa chứng từ nháp, hủy chứng từ (nháp), hoặc đảo chứng từ đã ghi sổ thì số lượng đã chuyển trở lại đơn. Chứng từ chỉ bỏ ghi sổ (về nháp) vẫn giữ số lượng của đơn.
- **Quyền:** cần các quyền "order" (xem, thêm, sửa, xóa) và thêm quyền lập chứng từ khi chuyển thành BH/MH.

## Chi phí mua hàng, nhập khẩu

### Chi phí mua hàng

Menu Mua hàng, "Chi phí mua hàng" (loại CPM) ghi chi phí vận chuyển, bốc xếp, bảo hiểm... của hàng đã nhập kho và phân bổ vào giá nhập. Chứng từ CPM chỉ bằng VND: chi phí bằng ngoại tệ (cước quốc tế) quy đổi ra đồng trước khi nhập.

1. Nhập Ngày hạch toán, Ngày chứng từ, Đối tượng (nhà cung cấp dịch vụ) và chọn cách phân bổ: **Theo giá trị** hoặc **Theo số lượng**.
2. Tab **Phiếu nhập**: chọn khoảng ngày rồi đánh dấu các chứng từ nhập đã ghi sổ cần phân bổ. Danh sách gồm Phiếu nhập kho mua hàng và Mua hàng hóa nhập kho cùng hóa đơn, có ngày không sau ngày hạch toán của CPM.
3. Tab **Chi phí**: mỗi dòng một khoản chi phí, gồm TK thanh toán (F4, ví dụ 331, 1111, 1121), Đối tượng (để trống thì lấy đối tượng của chứng từ), Diễn giải, Số tiền và Thuế GTGT.
4. Tab **Phân bổ**: xem trước chi phí chia cho từng dòng nhập và giá trị sau phân bổ. Theo giá trị, phần mềm dùng giá mua của dòng (gồm chênh giá hóa đơn, giảm giá hàng mua; không gồm chi phí mua đã phân bổ trước). Tổng phân bổ luôn bằng tổng chi phí; phần lẻ từng đồng chia cho dòng có phần lẻ lớn nhất.
5. Tab **Hóa đơn**: nhập hóa đơn của dịch vụ (vận chuyển...) để lên bảng kê mua vào, như trên Phiếu chi.
6. Ctrl+S lưu, F9 ghi sổ.

Bút toán: Nợ TK kho của từng dòng nhập (156...), Nợ 1331 thuế GTGT / Có TK thanh toán. Hệ thống tài khoản TT99 và TT133 không có TK 1562, nên chi phí mua ghi thẳng vào TK kho của dòng nhập. Khi ghi sổ, mỗi dòng nhập nhận một lớp điều chỉnh giá vốn tại ngày nhập; giá vốn hàng đã xuất được tính lại ở lần tính giá vốn kế tiếp (phần mềm báo giá vốn chưa cập nhật từ ngày nhập).

Các khóa an toàn:

- Phiếu nhập đang được CPM nháp hoặc đã ghi sổ dùng thì không bỏ ghi sổ, không đảo được ("LANDED_COST_REFERENCED"): hủy hoặc đảo CPM trước.
- Đã có lần tính giá vốn phủ ngày nhập thì không bỏ ghi sổ CPM ("STOCK_COST_ADJUSTED"), hãy đảo.
- Phiếu nhập chưa ghi sổ ("RECEIPT_NOT_POSTED") hoặc có ngày sau ngày CPM ("LANDED_COST_DATE_INVALID") thì không phân bổ được.
- Chứng từ CPM chỉ lập, sửa ở màn hình này, không qua màn hình chứng từ chung. Cần quyền `stock_voucher.*` và cờ view_cost.

### Mua hàng nhập khẩu

Trên "Mua hàng hóa", đánh dấu **Hàng nhập khẩu** ở đầu tab Hàng tiền. Lưới có thêm các cột theo tờ khai hải quan, nhập số tiền VND (phần mềm không có biểu thuế):

- **Thuế NK:** ghi Nợ TK kho / Có 3333.
- **Thuế TTĐB:** ghi Nợ TK kho / Có 3332.
- **Thuế GTGT hàng NK** và **Mã thuế GTGT NK (F4):** ghi Nợ 1331 / Có 33312. Dòng hàng nhập khẩu không ghi mã thuế GTGT, mã thuế nhập khẩu hay mã thuế TTĐB ở cột Mã thuế.
- **Giá tính thuế GTGT NK:** giá tính thuế GTGT ghi trên tờ khai (trị giá tính thuế theo tỷ giá hải quan cộng thuế NK, TTĐB). Để trống thì phần mềm lấy tiền hàng quy đổi theo tỷ giá hóa đơn + thuế NK + thuế TTĐB; nên nhập theo tờ khai vì tỷ giá hải quan và trị giá CIF thường khác.

Giá nhập kho = tiền hàng quy đổi VND + thuế NK + thuế TTĐB. Hóa đơn có thể bằng ngoại tệ; các dòng thuế luôn là VND. Mỗi tờ khai hải quan lập một chứng từ Mua hàng hóa: ở tab Hóa đơn, ghi số tờ khai vào ô Số hóa đơn; tờ khai nhiều mặt hàng thì nhập nhiều dòng hàng trên cùng chứng từ. Bảng kê mua vào có một dòng thuế GTGT hàng nhập (giá tính thuế theo cột Giá tính thuế GTGT NK), lên chỉ tiêu [23], [23a] của tờ khai 01/GTGT, và các dòng thuế NK, TTĐB ở phần thuế khác. Chi phí vận chuyển, bảo hiểm hàng nhập ghi bằng Chi phí mua hàng như trên.

## In phiếu nhập kho, phiếu xuất kho

Phiếu đã lưu có nút **In** (PDF). Mẫu theo chế độ kế toán của kỳ ghi sổ:

- **Phiếu nhập kho (Mẫu số 01 - VT):** in cho Phiếu nhập kho, Mua hàng hóa, Hàng bán bị trả lại; phiếu lắp ráp, tháo dỡ in phần nhập kho qua menu **In**.
- **Phiếu xuất kho (Mẫu số 02 - VT):** in cho Phiếu xuất kho, Phiếu chuyển kho (ghi thêm kho chuyển đến), Bán hàng hóa kiêm phiếu xuất, Trả lại hàng mua; phiếu lắp ráp, tháo dỡ in phần xuất kho.
- Số mẫu và dòng "Ban hành theo/Kèm theo Thông tư" chép từ TT 133/2016 và TT 99/2025. Chế độ TT200 in không có số mẫu.
- Hai cột số lượng ("Theo chứng từ", "Thực nhập" hoặc "Yêu cầu", "Thực xuất") đều lấy số lượng trên dòng phiếu, theo đơn vị tính đã nhập.
- Người dùng có quyền xem phiếu kho nhưng **không có cờ xem giá vốn** vẫn in được cho thủ kho, nhưng bản in bỏ cột Đơn giá, Thành tiền và dòng tổng số tiền bằng chữ. Phiếu bán, mua hàng vẫn cần cờ xem công nợ như khi mở chứng từ.

## Lắp ráp, tháo dỡ

Vào Chứng từ, Phiếu lắp ráp, tháo dỡ, bấm Thêm (Insert), chọn Lắp ráp hoặc Tháo dỡ (chọn được khi lập mới).

- Lắp ráp: nhập thành phẩm, xuất linh kiện cùng một kho. Giá trị thành phẩm nhập kho bằng giá trị linh kiện xuất (giá tạm tính) cộng Chi phí phát sinh. Chi phí ghi Có TK 154 (hoặc tài khoản bạn chọn ở ô TK ghi Có chi phí; bắt buộc chọn nếu hệ thống tài khoản không có TK 154 chi tiết).
- Tháo dỡ: xuất thành phẩm, nhập linh kiện. Tổng giá trị linh kiện nhập đúng bằng giá trị thành phẩm xuất. Nhập Tỷ lệ giá trị (%) ở lưới linh kiện (tổng phải bằng 100), hoặc bỏ trống toàn bộ để chia theo số lượng nhân giá tạm tính.
- Tỷ lệ giá trị chỉ nhập ở bên nhập kho (thành phẩm khi lắp ráp, linh kiện khi tháo dỡ). Mọi hàng nhập kho của một phiếu phải cùng tài khoản kho.
- Tháo dỡ không có chi phí phát sinh: nhập Chi phí phát sinh ở phiếu tháo dỡ sẽ báo lỗi.
- Ở lưới, bấm F4 trên ô Mã hàng hoặc ĐVT để chọn từ danh mục. Hàng theo dõi lô nhập thêm Số lô (và Hạn dùng dạng ngày/tháng/năm nếu theo dõi hạn dùng). ĐVT để trống thì dùng đơn vị tính cơ sở.
- Thiếu tồn linh kiện (hoặc thành phẩm khi tháo dỡ) thì ghi sổ báo lỗi thiếu tồn kho.
- Phiếu ghi sổ theo giá tạm tính. Khi chạy Tính giá vốn, giá trị hàng nhập đổi theo giá gán của hàng xuất và hệ thống lập Phiếu giá vốn ghi phần chênh lệch (Nợ TK kho nhập, Có TK kho xuất). Chạy lại không đổi thì không lập thêm phiếu.
- Bỏ ghi sổ không được nếu hàng nhập đã bị xuất tiếp; khi đó dùng Đảo.


## Kiểm kê kho

Vào **Kho > Kiểm kê kho** (`/kho/kiem-ke`).

1. Chọn **Ngày kiểm kê** và **Kho** (F4 để tra cứu), bấm **Lập biên bản kiểm kê**. Hệ thống lấy tồn sổ cuối ngày kiểm kê theo từng hàng và từng lô.
2. Nhập **Số đếm** thực tế (theo đơn vị tính cơ sở) vào lưới. Cột **Chênh lệch** tự tính: dương là thừa, âm là thiếu. Dòng để trống số đếm sẽ không được điều chỉnh. Có thể thêm dòng hàng chưa có tồn sổ bằng dòng trống cuối lưới (F4 tra mã hàng). Ctrl+S để lưu.
3. Chọn **Lý do chênh lệch** cho từng dòng:
   - Hàng thừa: "Chưa rõ nguyên nhân" ghi Có TK 3381; "Thừa ghi thu nhập khác" ghi Có TK 711.
   - Hàng thiếu: "Chưa rõ nguyên nhân" ghi Nợ TK 1381; "Trong định mức" ghi Nợ TK 632; "Mất mát" ghi Nợ TK 811.
4. Bấm **Điều chỉnh chênh lệch**. Hệ thống lập và ghi sổ ngay một Phiếu nhập kho (hàng thừa) và một Phiếu xuất kho (hàng thiếu), giá trị theo giá tạm tính của hàng. Chỉ điều chỉnh được một lần; biên bản chuyển sang "Đã điều chỉnh" và không sửa được nữa. Nếu kỳ đã khóa sổ hoặc tồn kho sẽ âm, việc điều chỉnh bị từ chối và biên bản vẫn ở trạng thái nháp.
5. **In biên bản** theo Mẫu số 05 - VT của chế độ đang dùng (TT133: Biên bản kiểm kê vật tư, công cụ, sản phẩm, hàng hóa; TT99: Biên bản tổng hợp kiểm kê...). Chế độ TT200 in không có số mẫu. Biên bản không in giá trị.
6. **Mở lại** biên bản đã điều chỉnh nếu cần đếm lại: phiếu điều chỉnh được bỏ ghi sổ và hủy (kỳ đã khóa sổ thì đảo, ngày đảo là hôm nay, phải thuộc kỳ đang mở). Không thao tác trực tiếp trên phiếu điều chỉnh ở màn hình Chứng từ.

Quyền: xem, lập, sửa, xóa biên bản theo nhóm quyền kiểm kê kho; điều chỉnh cần thêm quyền lập và ghi sổ phiếu kho, và cờ xem giá vốn.

## Báo cáo kho

Vào **Kho → Báo cáo kho**. Chọn khoảng ngày (hoặc "tính đến ngày" với Hạn dùng và Đối chiếu), mã hàng và kho bằng F4; bộ lọc được nhớ cho lần sau. Nút **In PDF** và **Xuất Excel** cần quyền in báo cáo.

- **Nhập - Xuất - Tồn:** đầu kỳ, nhập, xuất, cuối kỳ, số lượng và giá trị theo từng hàng và kho.
- **Thẻ kho:** ngày, số chứng từ nhập hoặc xuất, nhập, xuất, tồn (chỉ số lượng). Cần chọn mã hàng; mỗi kho một thẻ. In theo mẫu S12-DN (TT 99) hoặc S08-DNN (TT 133).
- **Sổ chi tiết:** thêm đơn giá, thành tiền và tài khoản đối ứng. In theo mẫu S10-DN (TT 99) hoặc S06-DNN (TT 133).
- **Bảng kê nhập / xuất:** từng dòng phát sinh kèm đối tượng, số lượng, đơn giá, thành tiền.
- **Hạn dùng:** hàng còn tồn theo lô có hạn dùng trong số ngày tới (số ngày âm là đã quá hạn).
- **Đối chiếu kế toán - kho:** so số lượng thẻ kho với sổ chi tiết giá vốn, và giá trị sổ chi tiết giá vốn với số dư tài khoản kho trên sổ cái. Chỉ hiện các dòng lệch. Trước khi chạy Tính giá vốn thường có chênh lệch; sau khi chạy phải bằng 0. Hàng tồn 0 nhưng còn giá trị (do xuất theo giá cố định) khớp sổ cái thì chỉ là ghi chú, không phải sai lệch.

Giá trị xuất chưa chạy Tính giá vốn là số tạm tính theo phiếu, ghi chú "(tạm tính)" và có biểu ngữ cảnh báo; giá vốn chưa cập nhật do ghi sổ lùi cũng báo ở đầu báo cáo. Báo cáo có giá trị (Nhập - Xuất - Tồn, Sổ chi tiết, Bảng kê, Đối chiếu) cần quyền xem giá vốn; Thẻ kho và Hạn dùng thì không. Báo cáo quá 40.000 dòng chỉ xuất được Excel.

Lưu ý về độ chính xác của báo cáo kho:
- Chênh giá do hóa đơn mua về sau (lớp điều chỉnh) được tính vào kỳ của ngày ghi sổ hóa đơn (hoặc chứng từ chi phí, giảm giá), không phải ngày nhập kho. Nhờ đó giá trị tồn cuối kỳ khớp tài khoản kho trên sổ cái; sổ chi tiết hiện dòng chỉ có giá trị với số lượng 0.
- Đối chiếu "tính đến ngày" trong quá khứ chính xác theo giá gán xuất hiện hành. Nếu có ghi sổ lùi chưa tính lại giá vốn thì báo cáo hiện chênh lệch và biểu ngữ cảnh báo; hãy chạy Tính giá vốn rồi đối chiếu lại.
- Cờ "tạm tính" của Nhập - Xuất - Tồn xét trên toàn bộ phát sinh đến hết kỳ báo cáo, không chỉ trong kỳ.
- Thẻ kho và sổ chi tiết chưa in một số cột phụ của mẫu (ghi chú, thông tin đầu trang).

## Báo cáo bán hàng, mua hàng

Menu **Bán hàng, Báo cáo bán hàng** và **Mua hàng, Báo cáo mua hàng** (cần quyền xem báo cáo; in PDF, xuất Excel cần thêm quyền in báo cáo). Chọn khoảng ngày, cách nhóm và (tùy chọn) mã hàng bằng F4.

### Báo cáo bán hàng
- Nhóm theo khách hàng, mặt hàng, nhân viên bán hàng, nhóm hàng hoặc tháng.
- Các cột: số lượng bán, số lượng trả lại, doanh số, chiết khấu, giảm giá và hàng bán bị trả lại, doanh thu thuần, giá vốn, lãi gộp. Doanh thu thuần = doanh số trừ chiết khấu trừ hàng bán bị trả lại. Lãi gộp = doanh thu thuần trừ giá vốn; hàng bán bị trả lại cũng trừ giá vốn nhập lại.
- Lấy hóa đơn bán hàng hóa, hàng bán bị trả lại và giảm giá bán đã ghi sổ. Chứng từ đã đảo vẫn tính ở kỳ của nó; chứng từ đảo tính số âm ở kỳ đảo, nên mỗi kỳ khớp sổ cái và báo cáo kỳ cũ không đổi. Hóa đơn ngoại tệ báo cáo theo tiền đồng.
- Giá vốn là giá đã tính ở chức năng Tính giá vốn. Kỳ chưa chạy Tính giá vốn thì báo cáo dùng giá vốn tạm tính và hiện cảnh báo vàng; hãy chạy Tính giá vốn rồi xem lại.
- Nhân viên bán hàng nhập ở đầu hóa đơn bán (ô "Nhân viên bán hàng", F4); chứng từ không ghi nhân viên nằm ở nhóm "(Không có nhân viên)".
- Người không có quyền xem giá vốn (cờ view_cost) vẫn xem được doanh số, nhưng không thấy hai cột giá vốn, lãi gộp, kể cả khi in PDF hoặc xuất Excel.

### Báo cáo mua hàng
- Nhóm theo nhà cung cấp, mặt hàng hoặc tháng.
- Gồm hóa đơn mua hàng, trả lại hàng mua và giảm giá hàng mua, đảo tính như báo cáo bán hàng. Các cột: số lượng mua, số lượng trả lại, giá trị mua, chiết khấu, trả lại và giảm giá, giá trị thuần, thuế GTGT, thuế nhập khẩu, thuế tiêu thụ đặc biệt, GTGT hàng nhập khẩu, chi phí mua.
- Chi phí mua là chi phí vận chuyển, bốc xếp... đã phân bổ bằng chứng từ Chi phí mua hàng, tính theo ngày ghi sổ của chứng từ đó; cột này chỉ hiện với người có quyền xem giá vốn.

## Soát lỗi kho
Vào Công cụ, Soát lỗi dữ liệu, chọn khoảng ngày; sáu quy tắc kho chạy cùng các quy tắc khác. Quy tắc có đánh dấu (giá) chỉ chạy với người có quyền xem giá vốn; người thiếu quyền thấy quy tắc ở danh sách "bỏ qua".
- Phiếu xuất kho có giá vốn chưa cập nhật (giá): phiếu xuất của hàng - kho đã bị ghi sổ lùi sau lần Tính giá vốn. Chạy lại Tính giá vốn.
- Giá trị lớp giá kho lệch số dư sổ cái (giá, mức lỗi): so với số dư tài khoản kho theo từng kho tại ngày cuối khoảng, giống Đối chiếu kế toán - thủ kho. Phiếu xuất chưa tính giá vốn chưa được trừ nên cũng làm lệch cho tới khi chạy Tính giá vốn.
- Dòng hàng sai đơn vị tính hoặc quy đổi (mức lỗi): ĐVT không thuộc hàng, hoặc số lượng cơ sở khác số lượng nhân hệ số.
- Tồn kho âm: tồn cuối ngày nhỏ hơn 0 (phiếu nhập cùng ngày được tính trước phiếu xuất); mỗi hàng - kho báo ngày âm đầu tiên trong khoảng.
- Dòng tài khoản kho thiếu kho: dòng định khoản vào tài khoản kho chưa ghi kho nên không lên Thẻ kho và đối chiếu.
- Tồn kho bằng 0 nhưng còn giá trị (giá, cảnh báo): bình thường khi xuất cố định giá hoặc theo lô; chỉ cần xem lại nếu không chủ ý.

## Kỳ hạn ngắn hạn, dài hạn và mã luồng tiền (B01, B03)
Lưới định khoản của chứng từ (Phiếu kế toán, Phiếu thu, Phiếu chi, Giấy báo Nợ, Giấy báo Có...) có thêm hai cột cuối:
- **Hạn thanh toán/đáo hạn** (gõ dd/mm/yyyy, để trống là không có hạn). Dòng công nợ (131, 331...) là hạn thanh toán của khoản; dòng vay (341), tiền gửi có kỳ hạn (1281), ký quỹ (244)... là ngày đáo hạn. Số dư đầu kỳ công nợ nhập hạn ở cột "Hạn thanh toán" như trước; Số dư đầu kỳ chưa nhận hạn cho tài khoản khác, nên khoản vay dài hạn có từ đầu kỳ ghi hạn bằng một Phiếu kế toán Nợ 3411 / Có 3411 cùng số tiền, dòng Có ghi ngày đáo hạn (không đổi số dư, chỉ đánh dấu phần dài hạn).
- **Mã luồng tiền (F4)**: chỉ ở dòng tiền mặt, tiền gửi; F4 mở danh mục là các chỉ tiêu luồng tiền của Báo cáo lưu chuyển tiền tệ theo chế độ của năm (TT99: 01-07, 21-27, 31-36). Ghi mã ở dòng tài khoản khác hoặc mã không có trong danh mục bị từ chối.

Hai cột sửa được cả khi chứng từ đã ghi sổ (như diễn giải, bộ phận), Ctrl+S để lưu; mỗi lần sửa ghi nhật ký. Chứng từ đảo chép hạn và mã của chứng từ gốc.

**Báo cáo tình hình tài chính (B01) TT99**: phần số dư có hạn sau ngày lập báo cáo quá 12 tháng vào dòng dài hạn, phần còn lại vào dòng ngắn hạn: phải thu khách hàng (131/211), trả trước người bán (132/212), phải thu nội bộ (133/214), phải thu khác (135/215), đầu tư nắm giữ đến ngày đáo hạn (123/265), phải trả người bán (311/331), người mua trả tiền trước (312/332), thuế phải nộp (314/333), chi phí phải trả (316/334), phải trả nội bộ (317/336), phải trả khác (320/338), vay và nợ thuê tài chính (321/339), dự phòng phải trả (322/343). Công nợ tính theo hạn của từng khoản còn dư tại ngày lập báo cáo; tài khoản khác tính theo hạn ghi ở dòng, dòng trả nợ không ghi hạn trừ vào phần ngắn hạn trước (nên ghi cùng ngày đáo hạn với khoản vay khi trả trước hạn khoản dài hạn). Khoản dài hạn tự chuyển sang ngắn hạn khi còn dưới 12 tháng. Chưa xét chu kỳ kinh doanh dài hơn 12 tháng; các dòng 112, 124-126, 165, 216, 236-238, 251, 266, 271, 273, 337, 341 vẫn để 0.

**Báo cáo lưu chuyển tiền tệ (B03, trực tiếp)**: dòng tiền có mã vào đúng chỉ tiêu đó (thu cộng, chi trừ; ví dụ người bán hoàn tiền gắn mã 02 làm giảm "Tiền chi trả cho người cung cấp"); dòng tiền không mã vẫn xếp theo cặp tài khoản đối ứng như trước. Không gắn mã cho chuyển tiền giữa hai tài khoản tiền (Chuyển tiền nội bộ, nộp tiền mặt vào ngân hàng): lưu chuyển thuần sẽ lệch và hiện ở dòng 50 + 60 + 61 khác 70. Tài khoản 113 (tiền đang chuyển) không gắn được mã.

**Soát lỗi**: quy tắc "Dòng tiền chưa có mã luồng tiền" (cảnh báo) liệt kê dòng tiền của chứng từ đã ghi sổ chưa gắn mã; chỉ chạy khi trong khoảng soát đã có dòng gắn mã, nên công ty không dùng mã không bị báo.

Công thức báo cáo (Báo cáo tài chính, Sửa công thức) có thêm: `LT(131)` phần dài hạn của số dư (chỉ dòng nguồn Số dư; `131-LT(131)` là phần ngắn hạn), `CF(01)` luồng tiền gắn mã 01, hậu tố `!CF` sau đối ứng (`N111/C511!CF`) bỏ các cặp đã gắn mã. Công ty đã sửa tay công thức các dòng này giữ nguyên công thức của mình; "Nạp lại mẫu" để lấy công thức mới.
