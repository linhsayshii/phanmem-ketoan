# Giai đoạn 7 – Hình thức sổ kế toán

Màn hình **Báo cáo > Hình thức sổ** (`/bao-cao/hinh-thuc-so`) cho chọn hình thức ghi sổ của từng năm tài chính: Nhật ký chung (mặc định), Chứng từ ghi sổ, Nhật ký – Sổ Cái, Nhật ký – Chứng từ. Hình thức sổ chỉ là cách trình bày: số liệu vẫn lấy từ sổ cái, đổi hình thức không tạo chứng từ và không làm đổi số dư. Chỉ người có quyền sửa kỳ kế toán mới đổi được hình thức.

Hình thức đã chọn quyết định các sổ in khi dùng **In cả bộ sổ năm** ở trang Sổ sách kế toán (Nhật ký và Sổ Cái được thay bằng các sổ của hình thức đó; Bảng cân đối số phát sinh và báo cáo tài chính giữ nguyên). Hộp **In cả bộ sổ năm** nêu rõ hình thức của năm đang chọn và đổi nhãn hai mục đầu theo hình thức đó:

| Hình thức | Mục "Nhật ký" in | Mục "Sổ Cái" in |
|---|---|---|
| Nhật ký chung | Sổ Nhật ký chung | Sổ Cái từng tài khoản có số liệu |
| Chứng từ ghi sổ | Sổ đăng ký Chứng từ ghi sổ và từng Chứng từ ghi sổ | Sổ Cái theo Chứng từ ghi sổ (từng tài khoản) |
| Nhật ký – Sổ Cái | Sổ Nhật ký – Sổ Cái | Không in thêm (đã gồm trong Nhật ký – Sổ Cái) |
| Nhật ký – Chứng từ | Một bảng kê cho mỗi tài khoản có phát sinh Có | Sổ Cái từng tài khoản như thường |

Năm dùng hình thức Chứng từ ghi sổ mà còn chứng từ chưa gom vào Chứng từ ghi sổ thì Sổ Cái in có cảnh báo; nên lập đủ Chứng từ ghi sổ trước khi in bộ sổ. Đổi hình thức ở **Báo cáo > Hình thức sổ** (cần quyền sửa kỳ kế toán). Các sổ ở đây gồm mọi tài khoản, kể cả công nợ và giá vốn nên cần đủ ba quyền xem công nợ phải thu, phải trả và giá vốn.

## Nhật ký – Sổ Cái
Một sổ liệt kê từng dòng chứng từ (ngày ghi sổ, số hiệu, ngày chứng từ, diễn giải, tài khoản, phát sinh Nợ, phát sinh Có), cuối sổ cộng phát sinh theo từng tài khoản. Tổng Nợ bằng tổng Có và bằng tổng phát sinh của Bảng cân đối số phát sinh cùng kỳ.

## Chứng từ ghi sổ
1. **Lập Chứng từ ghi sổ**: nhập diễn giải, ngày Chứng từ ghi sổ, khoảng ngày (trong năm tài chính) và loại chứng từ nếu muốn lọc. Phần mềm gom các chứng từ gốc đã ghi sổ trong khoảng đó mà chưa thuộc Chứng từ ghi sổ nào và cấp số hiệu theo năm. Không còn chứng từ nào để gom thì báo lỗi.
2. **In Chứng từ ghi sổ** (mẫu S02a): từng cặp tài khoản Nợ, Có và số tiền của các chứng từ gốc trong nhóm.
3. **Sổ đăng ký Chứng từ ghi sổ** (S02b): số hiệu, ngày, diễn giải, số tiền theo ngày Chứng từ ghi sổ.
4. **Sổ Cái** (S02c1): theo từng tài khoản, chỉ gồm chứng từ đã vào Chứng từ ghi sổ, ghi theo số và ngày Chứng từ ghi sổ. Còn chứng từ trong kỳ chưa được gom thì có cảnh báo; sổ chưa gồm các chứng từ đó.

Xóa Chứng từ ghi sổ chỉ gỡ nhóm, không động đến chứng từ gốc và sổ cái; số hiệu đã cấp không được đánh lại. Chứng từ gốc bỏ ghi sổ vẫn nằm trong nhóm nhưng không hiện trong các sổ.

## Nhật ký – Chứng từ
Chọn tài khoản ghi Có: bảng kê liệt kê từng chứng từ có phát sinh Có tài khoản đó, mỗi cột là một tài khoản Nợ đối ứng, cuối bảng có tổng từng cột. Đây là bảng kê chung theo bên Có, chưa chia cột theo mẫu S07–S10-DN của từng tài khoản.

## Lưu ý về số mẫu
Mẫu S02a, S02b, S02c1-DN chỉ in cho chế độ TT99 và TT200 và chưa đối chiếu với văn bản gốc; các chế độ khác và hai sổ Nhật ký – Sổ Cái, Nhật ký – Chứng từ in không có dòng "Mẫu số" cho đến khi đối chiếu xong.

## In và xuất
Mỗi sổ có nút **In PDF** và **Xuất Excel** theo đúng khoảng ngày, tài khoản đang xem (cần quyền in sổ sách, báo cáo).
