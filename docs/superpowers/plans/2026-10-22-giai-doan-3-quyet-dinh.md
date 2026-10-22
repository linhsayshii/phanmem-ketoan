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

## Bảng giá

200. Bảng giá gắn nhóm đối tượng bằng khóa ngoại tổng hợp tới bảng nhóm đối tượng đã có; `resolvePrice` chỉ khớp đúng ĐVT (không quy đổi), bảng giá không có dòng cho hàng thì xét bảng kế tiếp — kế hoạch không yêu cầu quy đổi, giá theo thùng khác giá theo chai — người dùng phải khai giá cho từng ĐVT bán. (T3, 38c9838)
201. Nhập Excel dòng giá chỉ thêm dòng, trùng khóa báo lỗi; không ghi đè — tránh đổi giá âm thầm — sửa giá phải qua màn hình. (T3, 38c9838)

## Động cơ giá vốn

202. Bình quân (cuối kỳ, tức thời): thành tiền xuất = làm tròn nửa lên của số lượng × giá bình quân chính xác (đủ chữ số), đơn giá báo cáo làm tròn 4 chữ số — số tính tay khớp, không dồn sai số làm tròn đơn giá — thành tiền ≠ số lượng × đơn giá hiển thị vài đồng. (T4, 031869f)
203. Xuất lấy một phần lớp/khối: `round(lượng lấy × giá trị ÷ lượng)`; lấy hết lớp lấy đúng giá trị còn lại; tồn về 0 thì lần xuất cuối không cố định giá hấp thụ phần lẻ, theo nhóm (FIFO một nhóm, đích danh mỗi lô một nhóm, không dời giá trị giữa các lô) — không mất đồng nào, Σ lớp = giá trị tồn — không. (T4, 031869f..b31e4ae)
204. Tồn âm: phần thiếu định giá theo bình quân hiện có của nhóm (hết thì giá nhập gần nhất, rồi bình quân đầu kỳ, rồi 0) và thành lớp âm (`moveId` = chứng từ xuất gây âm); lần nhập sau của nhóm lấp lớp âm trước, lãi/lỗ khi lấp vào giá trị lớp nhập — giữ Σ `remaining_value` = số dư TK kho cả khi âm — lược đồ T5 phải có loại lớp `deficit`. (T4, 031869f)
205. Xuất cố định giá: thành tiền theo đơn giá cố định, chênh lệch so với lớp nằm lại trong tồn; bình quân cuối kỳ không tính xuất cố định vào giá bình quân — giá người dùng chốt thắng — tồn 0 vẫn còn giá trị khi mọi lần xuất đều cố định giá (soát lỗi kho T20 báo). (T4, 031869f)
206. Đích danh: xuất thiếu lô báo `COSTING_LOT_MISSING` và tạm tính FIFO trên mọi lô để vẫn bảo toàn giá trị; lần chạy bị hủy ở T8 — lỗi nhập liệu không làm sai số liệu tạm — không. (T4, 031869f)
207. Lỗi lập trình (nhập có `value=null`, ngày sau cuối kỳ, lượng ≤ 0, giá trị VND lẻ, lô đầu kỳ trùng hoặc không cộng đủ, lô âm cạnh lô khác cùng nhóm) ném `Error`, không vào `errors[]` — người gọi T8 bảo đảm đầu vào — T8 phải gộp lô âm chuyển kỳ thành một nhóm. (T4, b31e4ae)

## Sổ kho

208. Sửa sau rà soát T5 bằng migration bổ sung `0047_so_kho_sua.sql` (0046 đã đẩy); các migration sau dịch lên một số so với bảng kế hoạch (T6 dùng 0048…) — migration đã đẩy đóng băng — không. (T5, ca47e06)
209. `STOCK_CONSUMED` tạm tính theo số dư: bỏ ghi sổ phiếu nhập làm tồn âm ở một ngày từ ngày nhập trở đi → `forbid` báo lỗi nêu chứng từ xuất, `warn` cho qua kèm cảnh báo, `allow` bỏ qua; T8 thêm `stock_cost_assignment.layer_id` và chặn khi lớp của phiếu nhập đang được gán, mọi cấu hình — trước T8 chưa có tham chiếu lớp — đến T8, cấu hình `allow` cho bỏ ghi sổ phiếu nhập đã xuất. (T5, ca47e06)
210. Đảo phiếu xuất: lớp nhập đảo lấy giá trị theo thứ tự Σ gán giá hiện hành của move xuất gốc → `round(lượng × unit_cost)` → `round(lượng × fn_stock_estimate_cost)` tại ngày gốc; không bao giờ lấy `amount` dòng (là doanh thu ở hóa đơn bán) — tránh nhập lại hàng theo giá bán — không. (T5, ca47e06)
211. Giá trị lớp nhập = `amount − discount_amount` của dòng vật tư — dòng hóa đơn mua giữ tiền hàng trước chiết khấu — không. (T5, ca47e06)
212. `stock_move.seq` là cột identity theo thứ tự chèn; thứ tự tính giá dùng `(posting_date, day_order, seq_no, line_no)`, không dùng `seq` — ghi lùi không giữ được thứ tự lưu trữ — T8 sắp sai nếu dùng `seq`. (T5, 29fee79)
213. Chặn chèn `stock_move` trực tiếp bằng trigger kiểm cờ phiên `app.stock_post` và chứng từ đã ghi sổ cùng ngày — chặn nhầm lẫn như `open_item`, không chặn `app_user` cố ý — như các bảng phụ đã có. (T5, ca47e06)

## Chứng từ kho

214. Phiếu kho không ra dòng sổ cái nào (mọi dòng giá trị 0: hàng tặng, giá vốn chưa biết) bị từ chối 409 `STOCK_VALUE_ZERO`, không đổi lược đồ; phiếu lẫn dòng có và không có giá vẫn ghi sổ, sinh `stock_move` cho mọi dòng và cảnh báo `COST_UNKNOWN` — dòng sổ cái cần số tiền khác 0 — chưa nhập được phiếu kho toàn giá trị 0. (T6, ba58dba)
215. Route chung `GET /api/vouchers/:id` kiểm cờ nhạy cảm theo tài khoản của dòng cho mọi loại chứng từ (403 nêu cờ) và đòi `stock_voucher.view` với loại kho; danh sách trả `totalDebit` null cho loại kho khi thiếu `view_cost`; ghi sổ/bỏ ghi sổ/đảo loại kho đòi thêm `stock_voucher.post`, hủy đòi `stock_voucher.delete` — cờ nhạy cảm chặn ở API, khớp sổ quỹ và công nợ — người có `voucher.view` nhưng thiếu `view_receivable` không mở được phiếu thu có dòng 131. (T6, ba58dba)
216. Tài khoản đối ứng mặc định theo loại nhập/xuất (`STOCK_KINDS`) cố định theo chế độ (xuất sản xuất TT133: 154; sử dụng, biếu tặng: 6418/6421), người dùng sửa ở dòng; chưa có cấu hình riêng — kế hoạch không yêu cầu — phải sửa tay từng phiếu nếu công ty hạch toán khác. (T6, 17cb977)
217. In phiếu kho trả 409 `PRINT_FORM_NOT_READY` đến T19; thành tiền quá 16 chữ số trả 400 `AMOUNT_TOO_LARGE` — tránh lỗi 500 — không. (T6, ba58dba)
