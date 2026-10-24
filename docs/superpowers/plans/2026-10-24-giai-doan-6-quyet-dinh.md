# Quyết định khi thực hiện GĐ6

Đánh số tiếp GĐ5 (đến #598). Kế hoạch: `2026-10-24-giai-doan-6-chi-tiet.md`. Nhánh làm việc: `claude/magical-ritchie-ijawwy` (không push main).

599. Môi trường phiên GĐ6 là cloud (không VPS oracle, không Docker, không `~/legal-docs`; mạng chỉ qua proxy, các trang luật bị chặn — đã thử `vanban.chinhphu.vn`, `thuvienphapluat.vn`, `datafiles.chinhphu.vn`, `congbao.chinhphu.vn`, `gdt.gov.vn`). PostgreSQL 16 cục bộ (`pg_ctlcluster 16 main start`), `.env` từ `.env.example` với `DATA_ENCRYPTION_KEY` ngẫu nhiên. Hệ quả pháp lý ở #600.
600. **Không nhập tham số pháp lý lương/TNCN/BHXH vào `legal-params.json`.** Giá trị ở đặc tả mục 10 là nghiên cứu sơ bộ, chưa đối chiếu văn bản gốc, nên chỉ dùng làm dữ liệu minh họa cho dữ liệu mẫu/kiểm thử, ghi `source` "Dữ liệu minh họa…". Phần mềm có bảng tham số theo công ty (`payroll_param`, người dùng nhập kèm nguồn), tra theo ngày hiệu lực; không có tham số thì 409 `PAYROLL_PARAM_MISSING`. Cổng `payrollParams_*` = false. Việc chờ người dùng đã có ở `docs/TIEP-THEO.md` mục 4.
601. **Mẫu 05/KK-TNCN, 05/QTT-TNCN không dựng được** (TT 89/2026 Phụ lục I không có trên máy này; không chép từ trí nhớ). Làm đầy đủ số liệu nguồn và bảng kê khấu trừ; tờ khai theo mẫu, XML, ký số trả 409 `TNCN_TEMPLATE_UNAVAILABLE` đến khi cổng `05KK_TNCN_TT89`/`05QTT_TNCN_TT89` = true.
602. Chi lương theo lô: không có mẫu tệp từng ngân hàng (đã nêu ở mục 4) nên chỉ làm khung ánh xạ cột do người dùng cấu hình và một bố cục "chung" không gắn tên ngân hàng.
603. Tệp kê khai BHXH (I-VAN): không có đặc tả công khai → xuất danh sách Excel/CSV cột chung, không giả định mẫu D02-LT/TK1-TS.
604. Chọn mô hình hạch toán: `LU` (lương) và `GT` (giá thành) là chứng từ hệ thống sinh từ phiên tính có phiên bản, chạy lại bằng đảo + sinh mới (cùng khuôn `KH`/`LV` GĐ4). Chi lương, nộp BH, nộp TNCN là chứng từ thường (nháp) do người dùng ghi sổ.
