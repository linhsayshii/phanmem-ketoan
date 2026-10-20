# Xuất dữ liệu kế toán cho cơ quan thẩm quyền

Mục đích: khi cơ quan thuế hoặc cơ quan có thẩm quyền yêu cầu cung cấp dữ liệu đầu ra (Điều 28 Thông tư 99/2025), xuất một lần ra một tệp zip gồm dữ liệu dạng bảng (CSV), sổ kế toán (PDF) và bảng băm để người nhận kiểm tra tệp không bị sửa.

## Cách xuất

1. Vào menu Tiện ích → "Xuất dữ liệu cho cơ quan thẩm quyền".
2. Chọn khoảng ngày ghi sổ, bấm "Xuất gói dữ liệu". Trình duyệt tải về tệp `xuat-du-lieu-<từ ngày>-<đến ngày>.zip`.
3. Mỗi lần xuất được ghi vào Nhật ký kiểm toán (hành động `export`, kèm khoảng ngày và người xuất).

Quyền cần có:
- Quyền "Xuất dữ liệu cho cơ quan thẩm quyền" (`export.authority`). Vai trò Kế toán viên mặc định không có quyền này.
- Cả ba cờ nhạy cảm xem công nợ phải thu (`view_receivable`), công nợ phải trả (`view_payable`) và giá vốn (`view_cost`), vì gói chứa Sổ Nhật ký chung và Sổ Cái của mọi tài khoản. Thiếu một cờ thì máy chủ trả 403 và không xuất gì; màn hình báo cờ còn thiếu và khóa nút.

## Nội dung gói

Các tệp CSV mã hóa UTF-8 có BOM (Excel mở đúng tiếng Việt), phân cách bằng dấu chấm phẩy (`;`), dòng đầu là tên cột. Ô có dấu `;`, nháy kép hoặc xuống dòng được bọc nháy kép (nháy kép trong ô viết đôi). Tiền hạch toán VND là số nguyên, ngày dạng `YYYY-MM-DD`.

| Tệp | Nội dung |
| --- | --- |
| `README.txt` | Tên công ty, mã số thuế, khoảng kỳ, thời điểm xuất, mô tả từng tệp và cột |
| `chung_tu.csv` | Phần đầu các chứng từ đã ghi sổ có ngày ghi sổ trong khoảng kỳ (gồm đã đảo, đã hủy; không có nháp), kèm `row_hash` |
| `dong_chung_tu.csv` | Dòng định khoản của các chứng từ trên: tài khoản, Nợ/Có, ngoại tệ, đối tượng và các chiều phân tích |
| `he_thong_tai_khoan.csv` | Mọi hệ tài khoản của công ty (cột `regime`: TT99, TT133, TT200, TT58) |
| `doi_tuong.csv` | Danh mục đối tượng |
| `ky_ke_toan.csv` | Các kỳ kế toán, trạng thái khóa, `hash_tail` của kỳ khóa cứng |
| `nhat_ky_kiem_toan.csv` | Mọi sự kiện trong khoảng kỳ (theo thời điểm xảy ra) với giá trị trước/sau dạng JSON |
| `so_nhat_ky_chung.pdf`, `so_cai.pdf`, `bang_can_doi_so_phat_sinh.pdf` | Sổ Nhật ký chung, Sổ Cái (mọi tài khoản có số liệu), Bảng cân đối số phát sinh |
| `B01.pdf`, `B02.pdf`, `B03.pdf` | Báo cáo tài chính; chỉ có khi công ty đã định nghĩa báo cáo đó |
| `MANIFEST.sha256` | Mã băm SHA-256 của từng tệp trên (trừ chính nó) |

Lưu ý: tệp CSV chỉ có dữ liệu trong khoảng ngày chọn, còn các tệp PDF là sổ và báo cáo của **cả năm tài chính chứa ngày kết thúc**. Khoảng ngày phải thuộc một năm tài chính đã tạo, nếu không máy chủ báo không có năm tài chính.

Giới hạn: PDF chỉ dựng được tới 40.000 dòng mỗi tệp. Năm có sổ lớn hơn bị từ chối (413 `PRINT_TOO_LARGE`) và không xuất gì; khi đó in từng sổ theo khoảng ngày ngắn hơn ở Báo cáo → Sổ sách kế toán hoặc xuất Excel. Tệp CSV không bị giới hạn.

## Kiểm tra toàn vẹn

Giải nén gói, trong thư mục vừa giải nén chạy:

```
shasum -a 256 -c MANIFEST.sha256
```

Mỗi tệp báo `OK` thì không bị sửa kể từ lúc xuất (Windows: `certutil -hashfile <tệp> SHA256` rồi so với dòng tương ứng trong `MANIFEST.sha256`). Bản thân `MANIFEST.sha256` nên gửi qua kênh riêng hoặc ghi lại giá trị băm của nó khi bàn giao.

Chuỗi hash của kỳ khóa cứng (cột `row_hash` ở `chung_tu.csv`, `hash_tail` ở `ky_ke_toan.csv`) kiểm tra được trên hệ thống nguồn bằng dòng lệnh, cần `DATABASE_ADMIN_URL` (chỉ người quản trị hệ thống):

```
pnpm -F @kt/api cli verify-hash --tenant-code <mã công ty> --year 2026 --period 3
```

Lệnh tính lại hash từng chứng từ của kỳ và báo điểm lệch; kỳ chưa khóa cứng không có `row_hash` (cột để trống).
