# Sổ quyết định GĐ4 (2026-10-23 → …)

Kế hoạch: `2026-10-23-giai-doan-4-chi-tiet.md`. Đánh số tiếp GĐ3 (kết thúc ở #382). Mỗi dòng: quyết định — lý do — giá phải trả nếu sai. Cuối mỗi dòng: tác vụ và mã commit.

## Cách làm

383. Làm trên nhánh worktree `worktree-gd4` (môi trường phiên nền bắt buộc cô lập), sau mỗi tác vụ push `HEAD:main` dạng fast-forward — CLAUDE.md yêu cầu nhánh `main`; lịch sử `main` vẫn tuyến tính như GĐ3 (#192) — không. (chung)
384. Subagent dùng model thấp nhất làm được: Sonnet thực hiện và rà soát tác vụ thường, Haiku cho việc cơ học, sửa theo chỉ dẫn file:dòng và chạy kiểm thử dài; Opus cho động cơ khấu hao (T3), chạy kỳ (T4), nghiệp vụ TSCĐ (T5), lãi vay (T10), rà soát T6, phần B01 của T9, số kỳ vọng T16 và rà soát toàn nhánh — người dùng yêu cầu khi giao GĐ4. (chung)

## Thiết kế

385. Sổ cái là nguồn số tiền duy nhất của tài sản: nguyên giá và hao mòn của một tài sản là tổng dòng sổ cái có `asset_id` trên TK tài sản/hao mòn của nó; thẻ không có ô "nguyên giá" nhập tự do (trừ số dư đầu kỳ, cũng đi vào DK) — một nguồn số, bất biến 211 − 214 không phụ thuộc đồng bộ thẻ với sổ; chứng từ mua, PXK, GV, PKT điều chỉnh đều tự cập nhật lịch — người dùng không thể "sửa nguyên giá trên thẻ", phải lập chứng từ. (kế hoạch)
386. 2141, 2142, 2143 đặt `subledger_kind = 'fixed_asset'` (mọi chế độ, mọi công ty) — dòng hao mòn bắt buộc có mã tài sản nên Σ giá trị còn lại = 211 − 214 theo cấu trúc — PKT trên 214 phải chọn tài sản; dữ liệu cũ thiếu mã do soát lỗi `TS_THIEU_TAI_SAN` báo. 2147 (BĐS đầu tư) không đổi. (kế hoạch)
387. Một sổ `asset` chung cho TSCĐ, CCDC, chi phí trả trước (`kind`), một động cơ lịch; phân bổ doanh thu nhận trước giữ `amortization_schedule` GĐ2 — CCDC và chi phí trả trước cần phân bổ theo nhiều bộ phận/vụ việc/khoản mục và số lượng, lịch GĐ2 chỉ có một TK đến — hai cơ chế phân bổ cùng tồn tại. (kế hoạch)
388. Khế ước vay là `contract` loại `loan` (thêm bảng `loan_term`, `loan_rate`, `loan_installment`), dòng sổ cái dùng cột `contract_id` sẵn có — cột đã có khóa ngoại và được mọi hàm chép dòng (đảo, bỏ ghi sổ) giữ nguyên, không phải thêm cột vào bảng phân vùng `voucher_line` — danh sách hợp đồng mua/bán phải lọc `kind <> 'loan'`. (kế hoạch)
389. Tài sản ghi giảm trong kỳ P không có trong chứng từ KH của P; chế độ theo ngày thì chứng từ ghi giảm tự gồm khấu hao đến ngày trước ngày giảm; mọi nghiệp vụ trong kỳ P chạy lại các lần chạy hiện có từ P — chứng từ ghi giảm luôn xóa hết nguyên giá và hao mòn, không phụ thuộc thứ tự người dùng chạy khấu hao — nghiệp vụ lùi ngày có thể đảo/sinh lại nhiều chứng từ KH; kỳ khóa thì cả nghiệp vụ bị từ chối. (kế hoạch)
390. `fa_proration` mặc định `day` (tháng bắt đầu và tháng ghi giảm tính theo số ngày), có lựa chọn `month` — là giả định của phần mềm; quy tắc ngày bắt đầu/thôi trích khấu hao trong TT 45/2013 chưa có văn bản gốc trên VPS nên không ghi là quy định — nếu văn bản quy định khác, đổi mặc định. (kế hoạch, mục 4 TIEP-THEO)
391. Lịch tính bằng lũy kế mục tiêu `round(B × c / U)`, đơn vị lưu 12 chữ số thập phân — tổng các kỳ đúng bằng giá trị cần khấu hao, không trôi số khi kỳ lẻ ngày — các kỳ đủ tháng có thể lệch nhau 1 đồng. (kế hoạch)
392. Không cho chạy cách kỳ (`PERIOD_RUN_GAP`) — phiên bản lịch tính đơn vị đã tiêu thụ theo các kỳ đã chạy, bỏ kỳ sẽ làm khấu hao dồn sai — người dùng phải chạy lần lượt (quy trình cuối kỳ dẫn bước). (kế hoạch)
393. Lãi vay = Σ dư nợ gốc cuối ngày × lãi suất năm hiệu lực ngày đó / cơ sở ngày (365 hoặc 360, chọn trên khế ước), làm tròn một lần mỗi khế ước mỗi kỳ — không nhập quy tắc tính lãi từ trí nhớ, cơ sở ngày là thuộc tính hợp đồng — lãi trả theo kỳ khác tháng vẫn dự chi theo tháng. (kế hoạch)
394. B01 TT99 tách ngắn/dài hạn khoản vay có khế ước theo lịch trả gốc (số đã trả trừ vào kỳ sớm nhất), thay cho `due_date` của dòng — sửa hạn chế GĐ3 "lách bằng PKT Nợ/Có 3411" — khoản vay không lập khế ước vẫn theo `due_date`. (kế hoạch)
