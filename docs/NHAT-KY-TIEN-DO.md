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
