# Nhật ký tiến độ

Mỗi dòng: `thời điểm | giai đoạn | việc | commit | kết quả kiểm thử`. Agent thêm một dòng khi xong mỗi tác vụ hoặc giai đoạn.

2026-10-20 21:06 | GĐ1.5 chuẩn bị | lệnh 01: môi trường VPS, CRLF checksum, chữ báo cắt NKC, testTimeout, đề xuất GĐ1.5 | d458fbc..3d75012 | lint+typecheck xanh, 456 passed / 6 skipped
2026-10-20 21:20 | GĐ1.5 T1 (A1) | DB kiểm thử tạm mỗi lần chạy | a87b594, 7dec74f | db 51 passed; toàn bộ 462 passed / 1 skipped
2026-10-20 21:52 | GĐ1.5 T2 (A2) + pháp lý | typecheck thư mục kiểm thử; hệ TK TT99 (Phụ lục II), đối chiếu TT133 (Phụ lục 1), sơ đồ kết chuyển theo chế độ | 87832ac, ae46a93 | lint+typecheck xanh, 473 passed
2026-10-20 21:58 | GĐ1.5 T3 (A4) | TRUST_PROXY, chặn cấu hình production yếu | 2691b8f | api 277 passed, lint+typecheck xanh
2026-10-20 22:16 | GĐ1.5 T4 (A3) | khóa tạm đăng nhập sai (5 lần/tên, 20 lần/IP, 15 phút) | 3ccb1a8, ddfeebb | api 281 passed; web Periods.test chậm do máy bận
2026-10-20 22:22 | GĐ1.5 T5 (A7) | lưu băm mã phiên, dọn phiên hết hạn | 4b17252 | api 283 passed, e2e in-so 2/2
2026-10-20 22:29 | GĐ1.5 T7 (A6+A8) + pháp lý | RLS tenant_user tách đọc/ghi, create_tenant trả biến phiên, thu hẹp ketoan_vien; chỉ tiêu B01/B02/B03 TT99 và TT133 | 01d2352, 982796f | db 54, api 283 passed; coa-data 19, báo cáo 84 passed
2026-10-20 22:41 | GĐ1.5 T6 (A5) | chặn tự nâng quyền, giữ quản trị viên cuối, không trao quyền mình không có | c48d80b, 3e9db9b | users/sensitiveFlags/auth 26 passed, lint+typecheck xanh
2026-10-20 22:51 | GĐ1.5 T8 (A9) | mã lỗi *_NOT_FOUND thống nhất 404 | a344186 | api 292, web 62 passed
2026-10-20 23:02 | GĐ1.5 T9 (A10) | khóa ngoại tổng hợp (tenant_id, id), 20 FK | 195ce46 | toàn bộ 497 passed, lint+typecheck xanh
2026-10-20 23:16 | GĐ1.5 T10 (A11) | kiểm cân bằng theo câu lệnh, khóa ghi trực tiếp partition | 0757d64, ba4e289 | db 62, vouchers+DK 40, bất biến 18 passed; DK 6.002 dòng 25,9 s → 2,9 s
2026-10-20 23:22 | GĐ1.5 T11 (A12) | script đo 100.000 dòng; BCĐPS năm 175 ms | 96c9584 | lint+typecheck xanh, db 62 passed
2026-10-21 00:12 | GĐ1.5 kết thúc | rà soát toàn nhánh (Opus), hai đợt sửa (0022 đăng nhập/hàng đợi, 0023 kết chuyển theo chế độ), nginx X-Forwarded-For, tài liệu; tag gd1-5-hoan-tat | f972086, 1f7b6e0, 3315ffb | lint+typecheck xanh, 511 passed, bất biến 18 passed, e2e 4 passed
2026-10-21 00:39 | GĐ2 T1 | danh mục: thoát ký tự tìm kiếm, cắt khoảng trắng, ngưng dùng, lỗi trùng mã | 3bf4325, 9ac2ee8 | api 306, web 62 passed
2026-10-21 01:07 | GĐ2 | T2 sửa bàn phím, tra cứu, ô số, Insert/F9 + sửa Minor | ec2601b, ca4b7fd | domain 40, ui 27, web 66, e2e phieu-ke-toan 2; lint/typecheck sạch
2026-10-21 01:30 | GĐ2 | T3 quyền GĐ2 (0024), cờ nhạy cảm dùng chung, todayVn/vnDayStart, chặn lộ số tiền qua hàng đợi kiểm cân bằng | fef28ed, bf279b8 | domain 48, db 65, api 308, worker 11, web 66; lint/typecheck sạch
2026-10-21 01:53 | GĐ2 | T4 loại chứng từ GĐ2 (0025), cột tiêu đề chứng từ, siết tỷ giá dòng ngoại tệ, VOUCHER_TYPES/CASH_PURPOSES | 9785790 | domain 54, coa-data 22, db 72, api 309, bất biến 18; lint/typecheck sạch
2026-10-21 02:21 | GĐ2 | T5 API chứng từ theo loại (PT/PC/BC/BN/CT), quy tắc theo loại, DTO periodStatus/hashed | 3181813, c16e9dc, 4f152d9 | api 330, domain 55, db 73, coa-data 22; lint/typecheck sạch
2026-10-21 03:47 | GĐ2 | T6 màn hình chứng từ dùng chung theo loại, Đảo chọn ngày, bỏ ghi sổ số dư đầu kỳ, xác nhận thay đổi chưa lưu | 66e200a, 47c68df | web 87, ui 31, api openingBalance 19, e2e phieu-thu + phieu-ke-toan 3; lint/typecheck sạch
2026-10-21 04:09 | GĐ2 | T7 mẫu in 01-TT, 02-TT, giấy báo Nợ/Có, UNC; đọc số thành chữ (VND và nguyên tệ) | 789ca84, 6e6835e | domain 102, api in 40, e2e 5/5; lint/typecheck sạch
2026-10-21 05:25 | GĐ2 | T8 số dư tại ngày, Sổ quỹ tiền mặt, Sổ tiền gửi ngân hàng, cảnh báo/chặn tồn quỹ âm (số dư thấp nhất từ ngày ghi sổ) | 1e0639e, 46386c6 | api 369, web 98, e2e so-quy 4/4; lint/typecheck sạch
2026-10-21 06:22 | GĐ2 | T9 kiểm kê quỹ và xử lý chênh lệch (0026), đảo giữ tiêu đề, cột opening_balance.bank_account_id | 2e151a6, dec26f0 | pnpm test 720, cashCount 9, e2e kiem-ke-quy; lint/typecheck sạch
2026-10-21 07:06 | GĐ2 | T9b số dư đầu kỳ theo tài khoản ngân hàng; lưới bỏ qua ô không sửa được theo dòng | a0636b3, 4d82656 | ui 34, web 102, api 64, e2e so-du-dau-ky; lint/typecheck sạch
2026-10-21 08:16 | GĐ2 | T10 tỷ giá theo ngày, tỷ giá xuất quỹ bình quân di động, chứng từ XQ cuối kỳ (0027), chặn đảo chứng từ hệ thống qua route chung | ec631bf, a53f1b5 | api 400, domain 106, coa-data 26, db 73, web 103, bất biến 18; lint/typecheck sạch
2026-10-21 09:23 | GĐ2 | T11 công nợ theo chứng từ open_item/settlement (0028), số dư đầu kỳ công nợ theo hóa đơn | a8eacc8, 99a88f5 | pnpm test 773, bất biến 18, web 108, e2e 8/8; lint/typecheck sạch
2026-10-21 10:32 | GĐ2 | T12 đối trừ thủ công/tự động, kế hoạch đối trừ theo chứng từ, bù trừ, hủy đối trừ, chênh lệch tỷ giá thực hiện CL (0029) | f23aa02, b9e8ea9 | api 434, settlement 21, bất biến 18, db 76; lint/typecheck sạch
