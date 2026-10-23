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
2026-10-21 13:12 | GĐ2 | T13 đánh giá lại ngoại tệ cuối kỳ (2 vòng sửa: chặn đối trừ sau ngày, đảo khoản đã đánh giá lại sinh CL, bỏ khoản ứng trước, chạy lại sau đảo) | 7eada8a 9487668 b92a7a3 d3a440f | API 452/452, db 76/76, bất biến 18/18, lint/typecheck sạch
2026-10-21 13:40 | GĐ2 | Lệnh 03: sổ quyết định GĐ2 T1–T13 (112 mục); thêm Task 27b số thuần chênh lệch đánh giá lại trên B02 TT99 (đối chiếu TT99 TK413 1.5.2, 4.2, Phụ lục IV B02 3.7, 3.8), sửa TIEP-THEO | 5bb89b0 510928e | chỉ tài liệu, không chạy kiểm thử
2026-10-21 14:06 | GĐ2 | T14 bất biến 5 công nợ khớp sổ cái theo đối tượng (2 vòng sửa: từ chối theo thao tác, so ngày đánh giá lại, nguyên tệ lẻ, ghim giới hạn T13-M10) | 86ddfd7 91dffdc adcd339 | bất biến 5 xanh (FC_RUNS=100 71 s, 300 3 phút 22), fxRevaluation 19/19, lint/typecheck sạch
2026-10-21 15:12 | GĐ2 | T15 báo cáo công nợ: sổ chi tiết, tổng hợp, tuổi nợ, biên bản đối chiếu, thư nhắc nợ, màn hình Báo cáo công nợ (1 vòng sửa nhỏ) | 298a3c0 f742d0f | API 468, arapReports 15, web 116, e2e cong-no 1, lint/typecheck sạch
2026-10-21 18:16 | GĐ2 | T16 màn hình Đối trừ chứng từ, chọn công nợ trên phiếu thu chi, Công cụ tỷ giá (xuất quỹ, đánh giá lại có xem trước, cài đặt loại tỷ giá), GET /api/fx/runs (1 vòng sửa) | 5049a37 a7fa79e | web 158, fxRevaluation 21, e2e toàn bộ 11/11 ×2, lint/typecheck sạch
2026-10-21 19:50 | GĐ2 | T17 động cơ thuế: tax_code mở rộng, tax_distribution, computeTaxes, legal_param theo ngày hiệu lực đối chiếu văn bản gốc NQ 204/2025, NĐ 174/2025, NĐ 181/2025, TT 89/2026 (1 vòng sửa) | 47bc1d6 56c4ca2 | domain 119, db 81, coa-data 30, API 474, bất biến 19, e2e phan-bo-thue 1, lint/typecheck sạch
2026-10-21 21:33 | GĐ2 | T18 hóa đơn mua/bán dịch vụ, giảm giá trả lại, voucher_item_line, voucher_invoice, kiểm tra trùng hóa đơn đầu vào (2 vòng sửa) | 816d4d2 02ebb3d 632a1c7 | domain 138, invoices 29, API 503, bất biến 19, lint/typecheck sạch
2026-10-21 23:31 | GĐ2 | T19 màn hình hóa đơn mua/bán dịch vụ, giảm giá, thuế và xem trước bút toán, tab Hóa đơn trên PC/BN/PKT (1 vòng sửa nhỏ) | 177cc82 61edc8e | invoices 31, web 177, e2e hoa-don 1 + toàn bộ 13/13, lint/typecheck sạch
2026-10-22 00:54 | GĐ2 | T20 doanh thu nhận trước và phân bổ theo kỳ (3387→5113), lịch theo kỳ thật, khóa với chạy kỳ (1 vòng sửa) | 3f5bec3 d22263d | db 81, API 515, web 177, e2e phan-bo-doanh-thu 2, lint/typecheck sạch
2026-10-22 00:54 | GĐ2 | T21 chỉ tiêu 01/GTGT TT 89/2026 từ ảnh trang gốc; TT80 chưa tải được, 8% chưa có căn cứ (chờ người dùng) | 958fcd4 1203c5e c3bb422 | coa-data 37, lint/typecheck sạch
2026-10-22 02:04 | GĐ2 | T22 bảng kê hóa đơn mua vào/bán ra, đối chiếu thuế với sổ cái, ghi đè MST/tên/địa chỉ trên hóa đơn, loại kỳ kê khai theo dòng (2 vòng sửa) | 4431139 c623292 2f28601 2736a90 | db 81, API 536, web có liên quan 54, e2e bang-ke-thue + hoa-don + phieu-ke-toan, lint/typecheck sạch
2026-10-22 03:08 | GĐ2 | T23 tờ khai 01/GTGT theo mẫu dữ liệu TT 89/2026, bổ sung theo Phụ lục II điểm 3, chuyển kỳ, khấu trừ thuế cuối kỳ KTT, nhóm kê khai bán ra theo dòng (1 vòng sửa + sửa nhỏ) | 0264b3d bbaa6e6 72db423 | domain 146, API 555, bất biến 19, e2e hoa-don + bang-ke-thue, lint/typecheck sạch
2026-10-22 04:11 | GĐ2 | T24 màn hình tờ khai GTGT, xuất XML qua adapter (chưa kiểm chứng HTKK), in tờ khai, lưu nhóm đầu hóa đơn bán ra (1 vòng sửa + sửa nhỏ) | 6ef418d 5c3327a b6a8dd4 51b066a | db 82, API 566, web có liên quan 42, e2e to-khai-gtgt + bang-ke-thue, lint/typecheck sạch
2026-10-22 05:46 | GĐ2 | T25 nhập chứng từ thu chi và bảng kê hóa đơn từ Excel, nhập danh mục không chèn một phần, chống tệp nén độc (3 vòng sửa) | 8a879ce ae952d7 03179d8 52b36af d00974c c29a4ef | API 592, importExcel 25, importVouchers 18, e2e nhap-chung-tu, lint/typecheck sạch
2026-10-22 06:25 | GĐ2 | T26 khử trùng chứng từ theo cặp loại cấu hình (1 vòng sửa + sửa nhỏ) | 5c37116 fb12d55 4390261 | db 82, API 606, dedupe 13, catalogs 33, e2e khu-trung 2, lint/typecheck sạch
2026-10-22 07:06 | GĐ2 | T27 soát lỗi mở rộng GĐ2 (công nợ lệch sổ cái, hóa đơn thiếu MST/trùng, thuế lệch, tài khoản ngân hàng, 8%, tiền mặt vượt ngưỡng, quá hạn) và cờ nhạy cảm trên kết quả (1 vòng sửa) | ef204d6 072da9c | db 82, API 618, dataCheck 30, web DataCheck 6, lint/typecheck sạch
2026-10-22 07:41 | GĐ2 | T27b B02 TT99 số thuần chênh lệch đánh giá lại ngoại tệ (mã 22/23), hạng tử !REVAL/REVAL_GAIN/REVAL_LOSS, migration 0039 (1 vòng sửa) | 27d1126 1c3b491 10d16f4 | domain 148, db 85, coa-data 38, API 626, bất biến 10, web Financial 6, lint/typecheck sạch
2026-10-22 08:18 | GĐ2 | T28 dữ liệu mẫu ABC năm 2026 có ngoại tệ, công nợ, hóa đơn, thuế, tờ khai quý 3–4 và kiểm thử nghiệm thu GĐ2 (số kỳ vọng tính tay, người rà soát tự tính lại 8 mẫu) | 35e5864 | bất biến + sample-xyz + sample-abc 26, API 633, db 85, lint/typecheck sạch
2026-10-22 08:18 | GĐ2 | tài liệu người dùng GĐ2 | 630fb18 | (tài liệu)
2026-10-22 09:05 | GĐ2 | rà soát toàn nhánh (opus: 0 Critical, 3 Important, 5 Minor) và đợt sửa: thông báo đối trừ trước ngày đánh giá lại, FX_ACCOUNT_MISSING (0040, 0041), phân bổ bỏ qua lịch có chứng từ gốc không còn ghi sổ, xóa tờ khai nháp, ô kỳ khai thuế GTGT, soát lỗi READ_SNAPSHOT, kiểm thử đồng thời hóa đơn trùng | 579eb8e b616487 b0e8d59 6db7553 f743d48 e2654d5 477db23 20eb857 | lô A/B được rà soát duyệt; kiểm thử theo tệp xanh
2026-10-22 09:20 | GĐ2 | bộ kiểm thử web nhanh khoảng 7 lần (lược luật CSS trước getComputedStyle của jsdom) | a75a4d7 | web 210 kiểm thử, 171 giây, xanh
2026-10-22 09:40 | GĐ2 | đo perf:100k: báo cáo không đổi (BCĐPS 180 ms); ghi sổ chậm do DB đo chưa ANALYZE và quét mọi phân vùng; 0042 cắt phân vùng | ea6752e 5441ced 59dcf0d 044266e | 25.000 chứng từ 229 → 100 giây; cùng điều kiện 5.000 chứng từ: GĐ1.5 36,5 / GĐ2 42,8 / sau 0042 19,3 giây
2026-10-22 10:50 | GĐ2 | cổng cuối và kiểm trên bản sao sạch, tag gd2-hoan-tat | 02a33d5 | lint, typecheck sạch; test 1166/1166; bất biến + sample-xyz + sample-abc 27/27; e2e 20/20
2026-10-22 10:13 | GĐ3 | kế hoạch chi tiết GĐ3 (24 tác vụ) | aa2c83e | (tài liệu)
2026-10-22 10:23 | GĐ3 | T1 quyền GĐ3, cờ view_cost cho tài khoản kho (0043) | aa2c83e..4118462 | rà soát sạch
2026-10-22 10:46 | GĐ3 | T2 danh mục VTHH, nhóm hàng, ĐVT quy đổi, kho (0044), Playwright Danh mục | 4118462..8d64d4b | rà soát sạch (1 Important chuyển T5)
2026-10-22 10:55 | GĐ3 | T3 bảng giá bán/mua theo nhóm khách, thời gian, bậc số lượng (0045) | 51c7ebc..d6d48f5 | rà soát sạch
2026-10-22 11:10 | GĐ3 | T4 động cơ giá vốn 4 phương pháp (packages/domain) | d6d48f5..b31e4ae | rà soát sạch (1 vòng sửa)
2026-10-22 11:39 | GĐ3 | T5 sổ kho stock_move, lớp giá, gán giá, lần chạy (0046, 0047) | b977245..ca47e06 | rà soát sạch (1 vòng sửa)
2026-10-22 12:25 | GĐ3 | T6 phiếu nhập, xuất, chuyển kho (0048) | 796dcc6..ba58dba | rà soát sạch (1 vòng sửa)
2026-10-22 12:36 | GĐ3 | T7 kiểm soát tồn âm, tồn bị tiêu thụ, thứ tự trong ngày | f2dec1b..8fdb242 | rà soát sạch
2026-10-22 14:17 | GĐ3 | T8 tính giá vốn, chứng từ GV, chạy lại bằng đảo (0049, 0050) | 8fdb242..869bcbc | rà soát sạch (opus, 1 vòng sửa)
2026-10-22 15:09 | GĐ3 | T9 tồn kho đầu kỳ theo kho/lô, nhập Excel (0051) | 86bdf50..e3c1fd0 | rà soát sạch (1 vòng sửa)
2026-10-22 15:45 | GĐ3 | T10 giá vốn "chưa cập nhật", điều chỉnh giá nhập thành phẩm (0052, 0053) | e3c1fd0..35602c9 | rà soát sạch (opus, 1 vòng sửa)
2026-10-22 17:09 | GĐ3 | T11 mua hàng hóa qua kho, hàng về trước/hóa đơn về trước, trả lại (0054–0056) | 35602c9..f5998d8 | rà soát sạch (2 vòng sửa)
2026-10-22 18:04 | GĐ3 | T12 chi phí mua hàng, mua hàng nhập khẩu (0057, 0058) | ff7e76b..e5da7c8 | rà soát sạch (opus, 1 vòng sửa)
2026-10-22 19:32 | GĐ3 | T13 bán hàng hóa kiêm phiếu xuất, hàng bán bị trả lại, gửi bán, xuất khẩu (0059, 0060) | e5da7c8..2fc696b | rà soát sạch (3 vòng sửa)
2026-10-22 20:02 | GĐ3 | T14 báo giá, đơn bán, đơn mua, hợp đồng, chuyển thành chứng từ (0061) | 0d5ff66..cc6e463 | api 756, rà soát sạch (1 vòng sửa)
2026-10-22 21:20 | GĐ3 | T15 lắp ráp, tháo dỡ tích hợp tính giá vốn (0062) | d416c65..bf21908 | api 764, rà soát sạch (opus, 2 vòng sửa)
2026-10-22 22:11 | GĐ3 | T16 kiểm kê kho, biên bản 05-VT theo chế độ, mở lại biên bản (0063) | 1828249..6ce6e6c | api 775, rà soát sạch (2 vòng sửa)
2026-10-22 22:50 | GĐ3 | T17 báo cáo kho NXT, S10-DN/S06-DNN, S12-DN/S08-DNN, bảng kê, hạn dùng, đối chiếu | 43f4982..7e07a33 | api 781, rà soát sạch (1 vòng sửa)
2026-10-22 23:50 | GĐ3 | T18 báo cáo bán hàng, mua hàng, lãi gộp; nhân viên bán hàng trên hóa đơn | 8c22bf0..be0843c | api 785, rà soát sạch (2 vòng sửa)
2026-10-23 00:23 | GĐ3 | T19 in phiếu nhập kho 01-VT, phiếu xuất kho 02-VT | 916dda9..ba5b457 | api 790, rà soát sạch (1 vòng sửa)
2026-10-23 01:00 | GĐ3 | T20 soát lỗi kho (0064, 0065) | 4ab5cec..171b342 | api 798, rà soát sạch (1 vòng sửa)
2026-10-23 01:58 | GĐ3 | T21 kỳ hạn ngắn/dài hạn B01 TT99, mã luồng tiền B03 (0066) | 0cd0251..e6709dd | api 805, bất biến 19, rà soát sạch (opus, 1 vòng sửa)
2026-10-23 02:34 | GĐ3 | T22 dữ liệu mẫu ABC có kho, 4 phương pháp, số kỳ vọng tính tay (người rà soát tự tính lại 9 mẫu) | 1a40c15 | api 811, bất biến 19
2026-10-23 04:21 | GĐ3 | T23 bất biến 7 sổ kho; perf:costing 54.000 dòng: 17,8–20,3 giây mỗi phương pháp | 193698a | api 811, inv7 xanh (FC_RUNS=40)
2026-10-23 05:23 | GĐ3 | tài liệu người dùng; rà soát toàn nhánh (opus: 1 Critical, 2 Important, 10 Minor) và đợt sửa: trả lại hàng mua sau chi phí mua, quyền xóa chứng từ kho, TK kho mặc định 156 trong đối chiếu/soát lỗi (0067, 0068), Ctrl+S tồn kho đầu kỳ | 47ce682, 6d3bf68..4620551 | db 107, api 818, web 215, lint/typecheck sạch
2026-10-23 06:00 | GĐ3 | cổng cuối và kiểm trên bản sao sạch tại 4620551 (migrate 0001–0068, seed ABC+XYZ), tag gd3-hoan-tat | 4620551 | lint, typecheck sạch; test 1408/1408; bất biến + sample-xyz 20/20; e2e 37/37
2026-10-23 06:24 | GĐ4 | kế hoạch chi tiết, sổ quyết định; T1 quyền GĐ4, loại chứng từ TS/KH/LV, fa_proration, 2141–2143 theo dõi tài sản (0069) | 9dcd81e..4b3cc1d | api 821, rà soát sạch
2026-10-23 06:44 | GĐ4 | T2 loại tài sản, thẻ tài sản, phân bổ chi phí, mã tài sản/khế ước trên dòng chứng từ, GV giữ tài sản (0070) | 74c2707..c021c6b | api 827, rà soát sạch
2026-10-23 06:51 | GĐ4 | T3 động cơ khấu hao/phân bổ thuần (lũy kế mục tiêu, đơn vị theo ngày/tháng/kỳ) | 124af7a..1973348 | domain 197, rà soát sạch
2026-10-23 07:35 | GĐ4 | T4 lịch khấu hao theo phiên bản, chứng từ KH/PB kỳ, chạy lại không trùng, cần chạy lại (0071) | b2c877e..ee13df7 | api 838, rà soát sạch (opus, 1 vòng sửa)
2026-10-23 08:13 | GĐ4 | T5 ghi tăng/ghi giảm/đánh giá lại/điều chuyển/dừng khấu hao TSCĐ (0072) | 14e6025..394fa08 | api 849, rà soát sạch (opus, 1 vòng sửa)
2026-10-23 08:46 | GĐ4 | T6 ghi giảm một phần CCDC, điều chỉnh giá trị, CPTT phân bổ từ kỳ sau | 830ee88..1bd8399 | api 855+, rà soát sạch (opus, 2 vòng sửa)
2026-10-23 09:54 | GĐ4 | T7 màn hình TSCĐ, CCDC, CPTT; cột Tài sản trên chứng từ | 7388968..79cdd33 | api 855, web 215, e2e tai-san/ccdc xanh, rà soát sạch (2 vòng sửa)
