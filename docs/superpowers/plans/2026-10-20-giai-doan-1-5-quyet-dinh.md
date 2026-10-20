# Sổ quyết định GĐ1.5 (2026-10-20 → 2026-10-21)

Kế hoạch: `2026-10-20-giai-doan-1-5-chi-tiet.md`. Mỗi dòng: quyết định — lý do — giá phải trả nếu sai.

## Cách làm

1. Làm thẳng trên `main`, không worktree cho tác vụ GĐ1.5 — CLAUDE.md yêu cầu nhánh `main` và push sau mỗi tác vụ — không (lịch sử tuyến tính, hoàn tác được).
2. Dữ liệu pháp lý làm song song trong worktree riêng, gộp vào `main` bằng merge `--no-ff` khi không có tác vụ GĐ1.5 nào đang sửa cây làm việc — tránh hai agent ghi chung một thư mục — xung đột gộp nhỏ (đã gặp ở `coa.test.ts`, `reference.test.ts`, đã giải).
3. Thứ tự T1, T2, T3, T4, T5, T7, T6, T8, T9, T10, T11 (T7 trước T6 vì T6 dùng `user_tenant_count`).
4. Tác vụ nhỏ và cơ học (T2, T3, T5, T8, T9, T11) do người điều phối tự rà diff thay cho một lượt rà soát riêng; tác vụ bảo mật và sổ cái (T1, T6, T7, T10) có người rà soát riêng — tiết kiệm lượt mà không bỏ cổng ở chỗ rủi ro — một lỗi nhỏ lọt qua sẽ được rà soát toàn nhánh bắt lại.
5. Đợt sửa cuối chia hai lượt tuần tự (A: bảo mật, migration 0022; B: sơ đồ kết chuyển theo chế độ, migration 0023) thay cho một lượt — phạm vi tách rời, khác file — GĐ2 dịch số migration lên 0024.

## Kiểm thử và môi trường

6. Ngưỡng hiệu năng T10 giữ 5 giây (chứng từ 5.000 dòng đo được 3,2–3,4 giây); nếu rớt giả trên VPS thì nâng lên 10 giây, vẫn bắt được O(n²) cũ (18 giây).
7. Kiểm thử đặt mặc định `LOGIN_MAX_FAILS_IP` và `LOGIN_MAX_FAILS_USER_ALL` rất lớn: mọi kiểm thử đăng nhập từ cùng 127.0.0.1 và `login_event` sống suốt lượt chạy; kiểm thử giới hạn theo IP dùng `TRUST_PROXY=true` và `X-Forwarded-For` riêng.
8. `Periods.test.tsx` thỉnh thoảng quá thời gian khi máy bận (hai bộ kiểm thử chạy cùng lúc), chạy riêng thì xanh: coi là rớt giả do tải.
9. Cài thêm `tesseract-ocr`, `tesseract-ocr-vie` để OCR TT 89/2026 (bản scan).

## Bảo mật

10. Lần đăng nhập bị chặn không ghi `login_event` (chỉ log máy chủ) — nếu ghi thì cứ thử là khóa kéo dài mãi.
11. Khóa đăng nhập theo cặp (tên, IP) 5 lần, theo tên trên mọi IP 50 lần, theo IP 20 lần, trong 15 phút; bộ đếm theo tên tuần tự hóa bằng `pg_advisory_xact_lock` — chống khóa hộ tài khoản người khác và vượt ngưỡng bằng yêu cầu song song — kẻ có nhiều IP vẫn khóa được một tên 15 phút mỗi 50 lần sai (ghi trong tài liệu người dùng).
12. `TRUST_PROXY` mặc định `false`; gói Docker đặt `1` (nginx của container web là một bước, nối `X-Forwarded-For` bằng `$proxy_add_x_forwarded_for`); tài liệu khuyên số bước proxy hoặc danh sách IP, không dùng `true`.
13. Quản trị người dùng theo nguyên tắc "không trao quyền mình không có, không sửa người có quyền hơn mình": `ROLE_EXCEEDS_ACTOR`, `TARGET_EXCEEDS_ACTOR`, `PERMISSION_NOT_HELD` (403), cùng `SELF_PRIVILEGE_CHANGE`, `LAST_ADMIN`, `USER_SHARED`, `SYSTEM_ROLE_LOCKED` (409).
14. `user_tenant_count` đếm mọi thành viên (kể cả đang khóa) — nếu không, admin công ty A đặt lại được mật khẩu người đang bị công ty B tạm khóa.
15. Hàng đợi kiểm cân bằng (`voucher_balance_pending`) không có khóa ngoại tới `voucher`: chứng từ nháp bị xóa trong cùng giao dịch vẫn được kiểm và qua lặng lẽ. Hàm kiểm chạy `SECURITY DEFINER`, `app_user` không xóa được hàng đợi.
16. `app_user` mất mọi quyền trên partition `voucher_line_YYYY_MM` (0021): trigger cấp câu lệnh chỉ chạy khi ghi qua bảng gốc.
17. Lỗi lưu sơ đồ kết chuyển với bước đã cũ là `CLOSING_STEP_STALE` 409, không phải `*_NOT_FOUND`.

## Dữ liệu pháp lý

18. 137, 246, 351 là mã chỉ tiêu B01, không phải tài khoản: không nhập vào hệ thống tài khoản TT99 (ghi chú cũ trong `tt99.status.json` sai, đã sửa).
19. TT133 bỏ TK 521 và sửa 18 tên theo Phụ lục 1; `normal_balance` của 521, 243, 229x, 3525 sửa theo bản chất (thuộc tính phần mềm, không phải dữ liệu pháp lý).
20. Sơ đồ kết chuyển là dữ liệu theo chế độ (`closing-steps/tt200|tt133|tt99.json`) và `closing_step.regime` (0023): các chế độ cùng tồn tại; tạo năm chế độ mới chỉ thêm sơ đồ của chế độ đó; chạy bước khác chế độ của kỳ bị chặn `CLOSING_STEP_REGIME_MISMATCH`.
21. B01 TT99: tài khoản dùng chung ngắn/dài hạn vào dòng ngắn hạn, dòng dài hạn bằng 0 (sổ cái chưa có kỳ hạn còn lại); B03 tiền đầu kỳ = tiền cuối kỳ trừ lưu chuyển thuần của tài khoản tiền theo cặp đối ứng (không còn công thức vòng); lãi trên cổ phiếu nhập tay. Danh sách đầy đủ trong `note` của `data/reports/status.json`; chờ kế toán trưởng rà.
22. Dữ liệu mẫu `demo-abc`, `dich-vu-xyz` giữ TT133 (dữ liệu mẫu dùng tài khoản cấp 2 của TT133).

## Để lại (không sửa trong GĐ1.5)

- `role.update` gỡ được quyền khỏi vai trò không phải admin cao hơn mình (từ chối dịch vụ, không leo thang).
- "admin = mọi quyền" dựa trên vai trò admin giữ mọi mã quyền: quyền mới phải có migration cấp cho admin (GĐ2 Task 3 đã làm vậy).
- Đăng nhập giữ một kết nối pool qua argon2 và khóa tư vấn: lũ đăng nhập từ nhiều IP chiếm pool ~0,5 giây; bộ đếm theo IP vượt ngưỡng tối đa cỡ kích thước pool. Cân nhắc giới hạn đồng thời cho route đăng nhập (TIEP-THEO nhóm C).
- Hàm kiểm cân bằng `SECURITY DEFINER` chưa kiểm `tenant_id` của dòng hàng đợi khớp chứng từ: `app_user` viết SQL thô có thể đọc tổng Nợ/Có của chứng từ công ty khác qua thông báo lỗi nếu biết UUID. Thêm điều kiện tenant ở migration đầu GĐ2.
- Backfill 0023 sinh ~381 dòng `audit_event` không có người dùng trên DB phát triển (nhiễu).
- `Closing.tsx`: đổi ngày ghi sổ làm mất sửa đổi chưa lưu của sơ đồ (GĐ2, nhóm B giao diện).
