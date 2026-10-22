# Sổ quyết định GĐ3 (2026-10-22 → …)

Kế hoạch: `2026-10-22-giai-doan-3-chi-tiet.md`. Đánh số tiếp GĐ2 (kết thúc ở #191). Mỗi dòng: quyết định — lý do — giá phải trả nếu sai. Cuối mỗi dòng: tác vụ và mã commit.

## Cách làm

192. Làm thẳng trên `main`, không worktree; push sau mỗi tác vụ — CLAUDE.md yêu cầu nhánh `main` — không (lịch sử tuyến tính, hoàn tác được). (chung)
193. Subagent dùng model thấp nhất làm được: Sonnet thực hiện và rà soát tác vụ thường, Haiku cho việc cơ học và rà soát lại bản sửa nhỏ; Opus chỉ cho động cơ giá vốn (T4), chạy giá vốn (T8), chi phí mua và nhập khẩu (T12), kỳ hạn và luồng tiền (T21), rà soát toàn nhánh cuối — người dùng yêu cầu ngày 2026-10-22 — lỗi kế toán tinh vi ở tác vụ Sonnet chỉ bị bắt ở rà soát cuối. (chung)

## Quyền và cài đặt

194. Không chèn dòng `tenant_setting` cho `stock_negative`: mặc định `forbid` do lược đồ zod của `SETTINGS` cấp — giống các khóa cài đặt khác — không. (T1, 4118462)
195. Ẩn cả tài khoản kho (`subledger_kind='inventory'`) trong gợi ý chứng từ trùng (`tools/dedupe.ts`) với người thiếu `view_cost`, cho khớp `flagsOf` — tránh lộ giá trị hàng tồn qua gợi ý — không. (T1, 4118462)

## Danh mục

196. Chưa có cột "kho mặc định" ở `item`: lược đồ kế hoạch không khai báo, màn hình VTHH bỏ tab đó; thêm `item.default_warehouse_id` khi chứng từ kho (T6) cần điền sẵn kho — tránh cột không ai dùng — người dùng phải chọn kho ở từng dòng. (T2, 8d64d4b)
197. Khóa sửa hệ số `item_uom.factor` và xóa ĐVT quy đổi sau khi hàng đã dùng chuyển sang T5 (migration sổ kho định nghĩa lại `fn_item_in_use` và guard, kèm kiểm thử): 0044 đã đẩy nên đóng băng, và T5 phải thêm `stock_move` vào cùng hàm — chưa có `stock_move` nên khoảng hở chỉ ảnh hưởng chứng từ nháp — nếu T5 quên, đổi hệ số làm sai nghĩa lượng cơ sở của dòng nháp/ghi lại. (T2 rà soát)
198. Mã tài khoản ở danh mục VTHH/kho tra theo chế độ của kỳ kế toán muộn nhất; ghi sổ chứng từ kho (T6) đọc tài khoản theo mã ở chế độ của năm chứng từ, không tin `*_account_id` đã lưu khi khác chế độ — chế độ gắn với năm tài chính — công ty đổi chế độ giữa năm phải chọn lại tài khoản ở danh mục. (T2, 8d64d4b)
199. Lỗi nhập Excel danh mục nêu số dòng thật của trang tính (dữ liệu bắt đầu ở dòng 4) — người dùng đối chiếu với tệp Excel đang mở — không. (T2, 8d64d4b)
