# Sổ quyết định GĐ7 (2026-10-28 → …)

Kế hoạch: `2026-10-28-giai-doan-7-chi-tiet.md`. Số bắt đầu từ 1000 (GĐ6 dùng 599+). Mỗi nhóm chỉ sửa mục của mình. Mỗi dòng: quyết định — lý do — giá phải trả nếu sai. Cuối dòng: tác vụ/mã commit.

## Chung (1300+)

1300. Nhánh `claude/gd7-mo-rong` từ `main`, không push `main`; migration từ 0200 vì `migrate.ts` sắp tên và áp dụng tệp chưa có, chịu được khoảng trống — khi hợp nhất với GĐ6 không cần đánh lại số; nếu hàm/trigger cùng tên bị định nghĩa lại ở cả hai nhánh thì phải viết migration hòa giải. (chung)

## Nhóm 1 — Hình thức sổ (1000–1049)

## Nhóm 2 — Song ngữ (1050–1099)

## Nhóm 3 — Ngân sách và phân tích (1100–1149)

1100. Ngân sách là bảng riêng `budget` (năm × phiên bản × tên, trạng thái draft → approved → superseded) và `budget_line` (tiền tố tài khoản + khoản mục/bộ phận/dự án tùy chọn + 12 cột `m01..m12` NUMERIC(20,0)) thay vì JSON — lý do: ràng buộc và khóa ngoại tổng hợp, audit từng dòng; đổi lại đọc/ghi 12 cột thay vì mảng. (T1)
1101. Mỗi năm một ngân sách đang áp dụng (chỉ mục duy nhất từng phần `status='approved'`); duyệt bản mới đẩy bản cũ sang `superseded`, bản đã duyệt không sửa, chỉnh bằng phiên bản mới — lý do: số liệu cảnh báo/so sánh không đổi lén; giá phải trả: phải nhân bản để sửa. (T2)
1102. Thực tế của dòng ngân sách = tổng dòng sổ cái đã ghi sổ (posted, reversed) của kỳ 1..12 của năm, bên bình thường theo chữ số đầu tiền tố (1,2,6,8 Nợ-Có; còn lại Có-Nợ), BỎ chứng từ `is_closing` (kết chuyển triệt tiêu chi phí/doanh thu); chiều phân tích trống = mọi giá trị — lý do: khớp ý nghĩa dự toán; giá phải trả: kỳ điều chỉnh 13–15 không tính, dòng chồng chéo (tiền tố cha và con) cộng trùng khi cộng tổng. (T3)
1103. Cờ nhạy cảm của báo cáo thực hiện/truy ngược chặn 403 bằng `assertSensitive` trên mọi tài khoản dưới tiền tố (như sổ chi tiết); xem/sửa chính bảng ngân sách (kế hoạch) không cần cờ — lý do: ngân sách không phải số liệu sổ cái; giá phải trả: người thiếu cờ vẫn thấy kế hoạch giá vốn. Dashboard che từng nhóm (null + `hidden`), hệ số cần đủ ba cờ; ngân sách so thực tế bỏ dòng bị che và báo `hiddenLines`. (T3, T5)
1104. Sao chép từ thực tế bỏ qua tài khoản bị cờ che và trả `skipped`, không 403 — lý do: không lộ số mà vẫn dùng được; số âm lấy 0. (T2)
1105. Cảnh báo vượt ngân sách gắn đúng MỘT chỗ: `postWithCashCheck` (cash/books.ts) gọi `budgetCheck` sau ghi sổ, cùng giao dịch; cứng thì ném 409 `BUDGET_EXCEEDED` làm hủy cả giao dịch ghi sổ (chứng từ còn nháp); mềm thêm vào `warnings` — lý do: mọi đường ghi sổ người dùng (route chung, hóa đơn, nhập Excel, ngân hàng, API ngoài) đều qua hàm này, không sửa `postVoucher`, `periodClose`, costing; giá phải trả: các nơi gọi thẳng `S.postVoucher` (chứng từ hệ thống) không bị kiểm tra, đúng chủ ý. (T4)
1106. Chỉ kiểm chứng từ người dùng (không `source_doc_type`, không `is_closing`), dòng ngân sách loại Nợ (1,2,6,8), chứng từ làm tăng thực tế; so thực tế lũy kế đến tháng của chứng từ với ngân sách lũy kế đến tháng đó; ngân sách lũy kế 0 mà có phát sinh = vượt mọi mức; thông báo không nêu số tiền (người ghi sổ có thể thiếu cờ) — giá phải trả: chỉ có % và tài khoản. Cấu hình `budget_setting` theo công ty, tắt mặc định, `block_pct >= warn_pct`. (T4)
1107. Quyền `budget.view/create/update/delete/approve`; migration 0220 gán cho admin, kế toán trưởng và cả kế toán viên (không định nghĩa lại `create_tenant` để khỏi xung đột với GĐ6, mà hàm 0078 gán theo tiền tố loại trừ nên công ty mới cũng cho kế toán viên mọi quyền `budget.*`) — giá phải trả: kế toán viên duyệt được ngân sách; siết sau bằng migration hòa giải `create_tenant` khi hợp nhất GĐ6. (T1)
1108. Hệ số tài chính tính từ `evaluateFinancialReport` B01/B02, tra chỉ tiêu theo mã dòng KÈM nhãn mong đợi (regex); thiếu dòng hoặc nhãn lệch thì bỏ hệ số, mẫu số ≤ 0 bỏ; số cuối kỳ không bình quân, không quy năm — lý do: mã dòng khác nghĩa giữa TT99/TT133 (TT133 B01 không có ngắn hạn/dài hạn nên không có hệ số thanh toán); giá phải trả: công ty tự sửa nhãn dòng có thể làm mất hệ số. (T5)
1109. Biểu đồ vẽ SVG thuần (`pages/charts.tsx`), không thêm thư viện; bảng màu cố định xanh/cam/ngọc theo kỹ năng dataviz, một trục, chú giải, tooltip, nút xem bảng số — giá phải trả: chưa có thu phóng; số trong biểu đồ là `number` chỉ để vẽ (số tiền hiển thị vẫn định dạng từ chuỗi). (T6)
1110. Nhập/xuất Excel dùng `readSheet` chung (mẫu `Du_lieu`, dòng khóa ẩn, ví dụ dòng 3); nhập thay toàn bộ dòng của ngân sách nháp, `mode=validate` chạy trong giao dịch rồi hủy — giá phải trả: ô Excel số trên 2^53 mất chính xác khi xuất (hiếm với ngân sách tháng). (T2)

## Nhóm 4 — Phê duyệt và mobile (1150–1199)

## Nhóm 5 — Đa chi nhánh (1200–1249)

## Nhóm 6 — HKD và siêu nhỏ (1250–1299)
