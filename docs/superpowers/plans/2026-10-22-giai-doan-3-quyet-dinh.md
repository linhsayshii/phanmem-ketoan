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

## Tính giá vốn

218. Số dư đầu kỳ của mỗi cặp hàng – kho dựng lại bằng cách chạy lại lịch sử trước `periodFrom` với mọi lần xuất giữ đúng số tiền đã ghi (gán giá hiện hành, chưa có thì số tạm tính của dòng), không đọc `remaining_*` của lần chạy trước; động cơ thêm `fixedAmount` (xuất giữ đúng số đồng) — chạy lại, chạy lệch thứ tự, chạy phạm vi hẹp đều cho cùng số dư, không phụ thuộc lần chạy nào đã ghi lớp — chạy lâu hơn khi lịch sử dài (đọc lại toàn bộ phát sinh của cặp). (T8, 52c592c..ba8dee6)
219. Thứ tự tính giá: `(ngày, day_order, đảo xếp sau, nhập trước xuất, seq_no, line_no, id)` — cùng ngày nhập trước xuất tránh tồn âm giả, chứng từ đảo xếp sau chứng từ gốc — hai phiếu cùng ngày cùng `day_order` sắp theo số chứng từ, người dùng muốn khác phải đặt `day_order`. (T8, ba8dee6)
220. Chênh lệch giá vốn = giá thực tế − số đã ghi sổ của dòng (tạm tính); chạy lại đảo trọn chứng từ GV cũ và sinh mới; gán giá hiện hành của lần chạy cũ nằm ngoài phạm vi lần chạy mới được chép sang lần mới, chênh lệch của chúng ghi ở ngày GV cũ — không bao giờ sửa dòng sổ cái đã ghi, không mất chênh lệch của cặp không chạy lại — một lần chạy hẹp vẫn sinh lại dòng GV của cặp khác. (T8, ba8dee6)
221. Lần chạy cần đảo = các lần giữ gán giá hiện hành của phát sinh trong phạm vi, cộng lần chạy `done` chồng kỳ có `summary.pairs` giao phạm vi (bắt cả lần chạy mà phát sinh đã bị xóa khi bỏ ghi sổ) — GV cũ của phát sinh đã xóa không còn treo — không. (T8, ba8dee6)
222. Dòng GV gộp theo (ngày, TK, hàng, kho, đối tượng nếu TK công nợ), Nợ TK nợ của dòng vật tư / Có TK có; kho bên Nợ = kho nhận nếu có, không thì kho của dòng; chuyển kho cùng TK 156 vẫn ra dòng riêng từng kho — sổ chi tiết theo kho khớp `remaining_value` — chứng từ GV nhiều dòng hơn mức tối thiểu. (T8, ba8dee6)
223. Phạm vi mở rộng sang cặp kho nhận của phiếu chuyển kho trong kỳ đến khi ổn định, xử lý theo thứ tự tô-pô; vòng chuyển kho lặp tối đa 10 lượt rồi báo `COSTING_TRANSFER_CYCLE` — giá nhập kho nhận phụ thuộc giá xuất kho chuyển — chạy một kho có thể sinh GV ở kho khác. (T8, ba8dee6)
224. Giá trị nhập: phiếu nhập = Σ lớp nhập của nó; nhập chuyển kho = giá xuất kho chuyển; nhập do đảo phiếu xuất = giá thực tế của xuất gốc (có chênh lệch riêng); xuất do đảo phiếu nhập cố định bằng giá trị nhập gốc — đảo triệt tiêu đúng chứng từ gốc — không. (T8, ba8dee6)
225. `STOCK_CONSUMED` sau khi tính giá: bỏ ghi sổ/hủy phiếu nhập bị chặn ở mọi cấu hình tồn âm khi có phiếu xuất (chứng từ khác) cùng hàng – kho, ngày ≥ ngày nhập, đang có gán giá hiện hành; theo quy tắc ngày, không thêm cột `layer_id` như dự kiến ở QĐ 209 — FIFO/bình quân không xác định được lớp nào "thuộc" phiếu xuất khi chạy lại — chặn cả phiếu nhập mà về FIFO không bị xuất tới (người dùng tính lại giá vốn hoặc đảo). (T8, ba8dee6)
226. `COSTING_LOT_MISSING` hủy cả lần chạy, trả 409 kèm `details.errors`, không để lại `costing_run` lỗi; `COSTING_NEGATIVE_STOCK`, `COSTING_RECEIPT_PRICE_MISSING` (phiếu nhập thành phẩm đơn giá 0) chỉ báo trong `summary.errors` — thiếu lô là lỗi nhập liệu làm sai giá đích danh, hai lỗi kia vẫn tính được số bảo toàn — nhật ký không có dòng cho lần chạy bị hủy. (T8, ba8dee6)
227. `summary.items` = số cặp hàng – kho; `costing_run.method` lưu `warehouse` khi không chọn phương pháp; lần chạy không đổi vẫn ghi một dòng `costing_run` (`unchanged`) — nhật ký đủ — nhật ký dài hơn. (T8, ba8dee6)
228. Lớp điều chỉnh (`adjustment`) và đánh dấu `stock_cost_state` khi ghi lùi để lại T10; T8 tạo bảng `stock_cost_state`, xóa dấu khi chạy phủ ngày cũ và đánh dấu `periodTo+1` cho cặp có gán giá sau kỳ khi lần chạy đổi số — kiểm thử ghi lùi giả lập dấu bằng SQL — T10 phải tự đánh dấu ở ghi sổ/bỏ ghi sổ. (T8, ba8dee6)
229. Ngày GV: ngày cuối kỳ nếu kỳ ghi được, không thì ngày đầu kỳ mở kế tiếp; kỳ khóa sổ đòi `voucher.backdate_locked`, khóa cứng/khóa phân hệ chặn — theo máy trạng thái kỳ — GV có thể nằm khác kỳ với phát sinh. (T8, ba8dee6)
230. Đầu vào API `fixedUnitCost` cho dòng phiếu xuất (từ chối ở PNK), chưa có ô trên giao diện — kiểm thử cần, kế hoạch không yêu cầu giao diện — người dùng chưa chốt giá xuất trên màn hình. (T8, ba8dee6)
231. Migration thực tế là `0049_gia_von.sql` (kế hoạch ghi 0048, xem QĐ 208); route đặt trong `costingRun.ts` vì chưa có `routes.ts` của phân hệ kho. (T8, ba8dee6)
232. (Sửa vòng 1) Bình quân cuối kỳ: phiếu xuất và phiếu đảo của nó cùng cặp hàng – kho, cùng kỳ triệt tiêu: cả hai ra khỏi giá bình quân, chiều nhập đảo lấy đúng giá gán của chiều xuất (động cơ: `valueFrom`), không tính lặp; các phương pháp khác chiều nhập đảo cũng lấy giá chiều xuất đứng trước; chiều xuất được đảo không nhận phần lẻ cuối kỳ — trước đây giá trị đảo đi vào giá bình quân, vòng lặp chỉ co ½ mỗi lượt và báo nhầm `COSTING_TRANSFER_CYCLE` ở số tiền lớn — giá bình quân không phản ánh hàng trả lại kho (đúng ý: trả lại là hủy nghiệp vụ xuất). (T8)
233. (Sửa vòng 1) Phụ thuộc chuyển kho (vòng thật) tính lặp đến điểm bất động (không số tiền nguyên nào đổi), tối đa 200 lượt rồi mới báo `COSTING_TRANSFER_CYCLE` — 10 lượt không đủ ở số tiền lớn — lần chạy vòng dài chậm hơn. (T8)
234. (Sửa vòng 1) Lớp còn lại là trạng thái hiện tại: mỗi cặp chạy lại mọi phát sinh (cả sau kỳ); chiều xuất sau kỳ giữ số đã ghi (gán hiện hành, không thì giá tạm tính), không gán lại; Σ mọi lớp theo kho = số dư hiện tại TK kho trên sổ cái — tính lại kỳ trước không còn xóa phần xuất của kỳ sau khỏi lớp — lớp ở kỳ sau mang giá cũ đến khi tính lại kỳ sau (đã đánh dấu chưa cập nhật). (T8)
235. (Sửa vòng 1) Sau khi khóa các cặp, đọc lại phạm vi chuyển kho; lớn thêm thì khóa thêm (theo thứ tự băm của cả tập) và đọc lại đến khi ổn định — khóa thêm ngoài thứ tự có thể bế tắc với ghi sổ đồng thời, PostgreSQL phát hiện và hủy một bên. (T8)
236. (Sửa vòng 1) Phương pháp chọn khi chạy chỉ áp cho cặp khớp bộ lọc (có phát sinh trong kỳ theo kho/hàng lọc); kho nhận chuyển kho kéo vào giữ phương pháp của kho — người dùng chọn phương pháp cho kho mình lọc. (T8)
237. (Sửa vòng 1) Chỉ mục duy nhất một phần `stock_cost_assignment (tenant_id, move_id) WHERE is_current` thay chỉ mục thường, ở `0050_gia_von_sua.sql` (0049 đã đẩy, các migration sau dịch thêm một số). (T8)
238. (Sửa vòng 1, bổ sung QĐ 225) Quy tắc ngày của `STOCK_CONSUMED` chặn thừa: chặn cả phiếu nhập mà lô khác (đích danh) hoặc lớp FIFO chưa bị xuất tới, chỉ vì có phiếu xuất cùng hàng – kho đã tính giá từ ngày nhập trở đi; và bỏ sót: phiếu nhập chỉ bù lớp thiếu của phiếu xuất ngày trước nó (tồn âm) không bị chặn dù giá trị đã đi vào giá vốn — chấp nhận đến khi có tham chiếu lớp theo lần chạy. (T8)
