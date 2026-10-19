Dữ liệu danh mục tài khoản TT133 và TT200 được trích từ bảng danh mục mẫu `OrgDMTK` và `OrgDMTK_200` của SUNSOFT PRO (chỉ số hiệu, tên và thuộc tính tài khoản; cấu trúc cha/tổng hợp được chuẩn hóa theo số hiệu). Việc đối chiếu với Phụ lục 1 TT 133/2016/TT-BTC và Phụ lục 1 TT 200/2014/TT-BTC là bước còn chờ thực hiện; khi hoàn tất, ghi lại bằng cách cập nhật chuỗi `source` trong `src/load.ts`. Hiện chỉ có kiểm tra cấu trúc bằng `validateCoaTemplate`.

Hai mẫu này không chứa các tài khoản ngoài bảng (mã bắt đầu bằng 0, dạng `0xx`) vì danh mục SUNSOFT không có chúng.

Mẫu TT99 (`data/coa/tt99.csv`) để trống, chờ nhập từ Phụ lục II TT 99/2025/TT-BTC (xem `data/coa/tt99.status.json`); các bảng `DesBC_*_99` của SUNSOFT không phải nguồn của TT99.

Hệ thống tài khoản là văn bản quy phạm pháp luật, không thuộc phạm vi bảo hộ quyền tác giả (Luật Sở hữu trí tuệ Điều 15). Không có dữ liệu giao dịch nào của bất kỳ doanh nghiệp nào được trích.
