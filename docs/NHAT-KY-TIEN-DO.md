# Nhật ký tiến độ

Mỗi dòng: `thời điểm | giai đoạn | việc | commit | kết quả kiểm thử`. Agent thêm một dòng khi xong mỗi tác vụ hoặc giai đoạn.

2026-10-20 21:06 | GĐ1.5 chuẩn bị | lệnh 01: môi trường VPS, CRLF checksum, chữ báo cắt NKC, testTimeout, đề xuất GĐ1.5 | d458fbc..3d75012 | lint+typecheck xanh, 456 passed / 6 skipped
2026-10-20 21:20 | GĐ1.5 T1 (A1) | DB kiểm thử tạm mỗi lần chạy | a87b594, 7dec74f | db 51 passed; toàn bộ 462 passed / 1 skipped
2026-10-20 21:52 | GĐ1.5 T2 (A2) + pháp lý | typecheck thư mục kiểm thử; hệ TK TT99 (Phụ lục II), đối chiếu TT133 (Phụ lục 1), sơ đồ kết chuyển theo chế độ | 87832ac, ae46a93 | lint+typecheck xanh, 473 passed
2026-10-20 21:58 | GĐ1.5 T3 (A4) | TRUST_PROXY, chặn cấu hình production yếu | 2691b8f | api 277 passed, lint+typecheck xanh
2026-10-20 22:16 | GĐ1.5 T4 (A3) | khóa tạm đăng nhập sai (5 lần/tên, 20 lần/IP, 15 phút) | 3ccb1a8, ddfeebb | api 281 passed; web Periods.test chậm do máy bận
2026-10-20 22:22 | GĐ1.5 T5 (A7) | lưu băm mã phiên, dọn phiên hết hạn | 4b17252 | api 283 passed, e2e in-so 2/2
2026-10-20 22:29 | GĐ1.5 T7 (A6+A8) + pháp lý | RLS tenant_user tách đọc/ghi, create_tenant trả biến phiên, thu hẹp ketoan_vien; chỉ tiêu B01/B02/B03 TT99 và TT133 | 01d2352, 982796f | db 54, api 283 passed; coa-data 19, báo cáo 84 passed
