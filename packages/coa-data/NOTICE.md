Nguồn danh mục tài khoản:

- TT99 (`data/coa/tt99.csv`): nhập từ Phụ lục II (A - Danh mục tài khoản kế toán) Thông tư số 99/2025/TT-BTC ngày 27/10/2025, Công báo số 1565 + 1566 ngày 16/11/2025, https://congbao.chinhphu.vn/van-ban/thong-tu-so-99-2025-tt-btc-46529.htm. Gồm 184 tài khoản (đúng bảng danh mục, không có tài khoản ngoài bảng). Số hiệu, tên và quan hệ cha/con theo văn bản; `normal_balance`, `track_currency`, `subledger_kind` là thuộc tính phần mềm, không phải dữ liệu pháp lý.
- TT133 (`data/coa/tt133.csv`): đối chiếu từng dòng với Phụ lục 1 Thông tư số 133/2016/TT-BTC ngày 26/8/2016, Công báo số 1103 + 1104 ngày 12/10/2016, https://congbao.chinhphu.vn/van-ban/thong-tu-so-133-2016-tt-btc-21048/15522.htm. Gồm 123 tài khoản. Bản đầu lấy từ bảng danh mục mẫu `OrgDMTK` của SUNSOFT PRO; tên và số hiệu nay theo văn bản gốc (đã bỏ TK 521, sửa 18 tên), thuộc tính phần mềm giữ từ bản SUNSOFT.
- TT200 (`data/coa/tt200.csv`): trích từ bảng danh mục mẫu `OrgDMTK_200` của SUNSOFT PRO (chỉ số hiệu, tên và thuộc tính; cấu trúc cha/tổng hợp chuẩn hóa theo số hiệu). Việc đối chiếu với Phụ lục 1 TT 200/2014/TT-BTC còn chờ thực hiện; khi hoàn tất, ghi lại bằng cách cập nhật chuỗi `source` trong `src/load.ts`.

Các mẫu không chứa các tài khoản ngoài bảng (mã bắt đầu bằng 0). Các bảng `DesBC_*_99` của SUNSOFT là bản sao định nghĩa TT200, không phải nguồn của TT99; chỉ dùng để đối chiếu (xem `test/coa.test.ts`).

Hệ thống tài khoản là văn bản quy phạm pháp luật, không thuộc phạm vi bảo hộ quyền tác giả (Luật Sở hữu trí tuệ Điều 15). Không có dữ liệu giao dịch nào của bất kỳ doanh nghiệp nào được trích.
