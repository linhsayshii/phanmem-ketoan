# Đo hiệu năng 100.000 dòng sổ cái

## Cách chạy

```bash
pnpm -F @kt/api perf:100k          # cần DATABASE_URL / DATABASE_ADMIN_URL trong .env (trỏ vào PostgreSQL, tài khoản có quyền tạo DB)
PERF_VOUCHERS=2000 pnpm -F @kt/api perf:100k   # chạy thử nhanh với số chứng từ nhỏ hơn
```

Script `apps/api/scripts/perf-100k.ts` tạo cơ sở dữ liệu tạm `ketoan_t_<hex>` (cùng hàm `createTempDb` với kiểm thử), công ty TT133 năm 2026, 20 đối tượng, rồi sinh 25.000 chứng từ PKT × 4 dòng = 100.000 dòng rải 12 tháng trên 30 tài khoản lá (có 131, 331 gắn đối tượng, 1121). Chứng từ sinh bằng SQL theo lô 1.000 (giao dịch riêng, quyền `app_user`, RLS và trigger thật), ghi sổ bằng `post_voucher`. Sau đó tính lại số dư, `VACUUM ANALYZE`, đo qua `app.inject`: một lần chạy khởi động không tính, ba lần đo lấy trung vị. Cơ sở dữ liệu tạm luôn bị xóa khi kết thúc (kể cả khi lỗi). Mã thoát 1 nếu Bảng cân đối số phát sinh năm >= 2 giây.

## Ngưỡng nghiệm thu

Bảng cân đối số phát sinh năm < 2 giây trên 100.000 dòng.

## Kết quả

Ngày 2026-10-20. Máy: Oracle VPS Ubuntu 24.04 aarch64, 2 CPU, 11 GiB RAM; PostgreSQL 16 trong Docker. Sinh dữ liệu và ghi sổ 47 giây, tính lại số dư 5,4 giây.

| Báo cáo | Trung vị (ms) | Lớn nhất (ms) |
|---|---|---|
| Bảng cân đối số phát sinh năm | 175 | 177 |
| Nhật ký chung năm (cắt 50.000 dòng) | 869 | 905 |
| Sổ Cái TK 1121 năm | 151 | 156 |
| Số dư tài khoản `/api/balances` | 38 | 38 |

Đạt ngưỡng: Bảng cân đối số phát sinh năm 175 ms (không cần thêm chỉ mục). Số đo GĐ1 trước đó (~121 ms ở ~100.000 dòng) dùng dữ liệu khác nên chỉ để tham khảo.

## GĐ2 (2026-10-22)

Cùng máy và cùng script (thêm ba ca: tuổi nợ, khử trùng, soát lỗi công nợ). Ghi sổ 25.000 chứng từ PKT × 4 dòng:

| Mốc | Sinh + ghi sổ | Tính lại số dư |
|---|---|---|
| GĐ1.5 (2026-10-20) | 47 giây | 5,4 giây |
| GĐ2 trước sửa (2026-10-22) | 229 giây | 0,3 giây |
| GĐ2 sau sửa (migration 0042, script có `ANALYZE` mỗi lô) | 100 giây | 0,2 giây |

`POST /api/balances/recompute` vẫn chạy đồng bộ (`SELECT recompute_balances`) nên các số tính lại so sánh được; mức giảm 5,4 giây xuống 0,3 giây không do đổi mã (hàm và route không đổi); nhiều khả năng do kế hoạch truy vấn trên bảng chưa có thống kê (script chỉ `VACUUM ANALYZE` sau bước này), chưa điều tra thêm.

Kết quả báo cáo sau sửa (trung vị / lớn nhất, ms):

| Báo cáo | Trung vị (ms) | Lớn nhất (ms) |
|---|---|---|
| Bảng cân đối số phát sinh năm | 180 | 182 |
| Nhật ký chung năm (cắt 50.000 dòng) | 910 | 920 |
| Sổ Cái TK 1121 năm | 151 | 158 |
| Số dư tài khoản `/api/balances` | 39 | 39 |
| Tuổi nợ 131 ngày 31/12 (cả công ty) | 49 | 57 |
| Khử trùng chứng từ năm | 364 | 366 |
| Soát lỗi CN_LECH_SO_CAI năm | 51 | 53 |

Số đo trước sửa gần như y hệt (Bảng cân đối số phát sinh 180 ms, Nhật ký chung 891 ms, Sổ Cái 150 ms, `/api/balances` 39 ms, Tuổi nợ 50 ms, Khử trùng 365 ms, Soát lỗi 52 ms): thời gian báo cáo không đổi, chỉ ghi sổ chậm đi. Vẫn đạt ngưỡng < 2 giây.

### Nguyên nhân ghi sổ chậm (đo bằng `track_functions = 'pl'` và `auto_explain`)

1. **Kế hoạch đoán sai trong DB tạm chưa có thống kê.** Mỗi lô 1.000 chứng từ nằm trong một giao dịch và bảng `voucher` chưa được phân tích, nên truy vấn `SELECT * FROM voucher WHERE id = $1` (có thêm điều kiện `tenant_id` của RLS) chọn chỉ mục `voucher_tenant_id_voucher_type_voucher_no_idx` thay cho khóa chính và lọc từng dòng (`Rows Removed by Filter: 999`). Chi phí mỗi tra cứu tăng gần 20 lần dần theo số chứng từ trong lô (0,01 ms lên 0,15-0,25 ms), tổng bậc hai theo cỡ lô. Dòng `voucher` GĐ2 rộng hơn (471 lên 607 byte) nên ở GĐ1.5 cùng cảnh vô tình chọn đúng khóa chính. Ghi sổ từng chứng từ qua màn hình ít bị ảnh hưởng vì autovacuum phân tích bảng và mỗi chứng từ một giao dịch. Các việc ghi nhiều chứng từ trong một giao dịch (nhập Excel, phân bổ, tỷ giá xuất quỹ, đánh giá lại) trên công ty mới chưa được phân tích vẫn có thể gặp kế hoạch sai này; chưa xử lý (ví dụ `ANALYZE voucher` trước lượt lớn). Script đo giờ chạy `ANALYZE` sau mỗi lô.
2. **Quét mọi phân vùng tháng.** `fn_build_pairs`, `fn_check_voucher_balance` và đếm dòng của `post_voucher` tra `voucher_line` chỉ theo `voucher_id` nên mở chỉ mục của cả 13 phân vùng mỗi truy vấn (khoảng 65 lần quét chỉ mục cho một chứng từ 4 dòng). Migration `0042_ghi_so_cat_phan_vung.sql` thêm `posting_date = v.posting_date` (dòng luôn mang ngày của chứng từ: `fn_line_before` gán, `fn_voucher_date_sync` dời) để cắt còn một phân vùng. Hai CTE của nhánh n-n phải khai báo `MATERIALIZED`: sau khi cắt phân vùng, bộ lập kế hoạch đoán mỗi CTE một dòng và chọn vòng lặp lồng tính lại hàm cửa sổ cho từng dòng (chứng từ 5.000 dòng từ 3,7 lên 17,8 giây; kiểm thử `vouchers.test.ts` bắt được).
3. **Chi phí thật của GĐ2 (nhỏ):** `fn_open_items_create` (khoản công nợ) khoảng 0,7 ms và `fn_line_before` (kiểm tra ngoại tệ) khoảng 0,2 ms mỗi chứng từ, chưa tối ưu thêm.

A/B 5.000 chứng từ, script có `ANALYZE` mỗi lô: GĐ1.5 36,5 giây, GĐ2 trước 0042 42,8 giây, GĐ2 sau 0042 19,3 giây.

## Giá vốn 50.000 dòng kho (GĐ3, `pnpm -F @kt/api perf:costing`)

Dữ liệu: DB tạm, 100 hàng × 5 kho, cả năm 2026, 540 phiếu kho ghi sổ thật qua API (mỗi tháng và kho: 4 phiếu nhập, 4 phiếu xuất, 1 phiếu chuyển kho; mỗi phiếu 100 dòng): 54.000 dòng hàng, 60.000 phát sinh kho (sinh và ghi sổ khoảng 144 giây). Mỗi phương pháp đo trong một giao dịch rồi hủy, nên cả bốn chạy trên cùng dữ liệu; `runCosting` cả năm (01/01 đến 31/12), tiêu chí dưới 30 giây.

| Phương pháp | Lần đầu (giây) | Chạy lại, không đổi (giây) |
|---|---|---|
| Bình quân cuối kỳ (`avg_period`) | 19,0 | 17,3 |
| Bình quân tức thời (`avg_moving`) | 18,8 | 17,3 |
| Nhập trước xuất trước (`fifo`) | 20,3 | 18,1 |
| Đích danh (`specific`) | 17,8 | 16,8 |

Đạt tiêu chí nên không tối ưu mã giá vốn (`costingRun.ts` giữ nguyên). Theo dõi từng giai đoạn của lần đầu (khoảng 19 giây): tải phát sinh và dựng phạm vi khoảng 2 giây, tính giá bằng `computeCosting` cùng truy vấn lớp giá điều chỉnh khoảng 9 giây, ghi gán giá và lập chứng từ GV khoảng 3 giây, ghi lớp giá khoảng 1,5 giây, cập nhật trạng thái tính lại khoảng 2,5 giây.

Bẫy khi đo: nếu hủy giao dịch của phương pháp trước rồi không dọn, lần chạy lại của phương pháp sau mất khoảng 210 giây (kế hoạch truy vấn lệch do dòng chết và thống kê cũ; lần đầu vẫn nhanh). Script chạy `ANALYZE` trước lần chạy lại và `VACUUM ANALYZE` sau mỗi phương pháp, như autovacuum trên hệ thống thật. Số liệu trên ở trạng thái đã dọn.

## Khấu hao 5.000 thẻ (GĐ4, `pnpm -F @kt/api perf:assets`)

Dữ liệu: DB tạm, 3.000 TSCĐ + 1.500 CCDC + 500 chi phí trả trước, mỗi thẻ 2 dòng phân bổ (6422 70%, 6421 30%), thẻ sinh bằng API và ghi nguyên giá bằng phiếu kế toán (100 thẻ mỗi phiếu), thời gian sử dụng 6-84 tháng, ngày bắt đầu rải trong tháng 1. Chạy lần lượt 12 kỳ cho cả ba loại, mỗi kỳ chạy lại ngay (phải `unchanged`). Tiêu chí: mỗi lần chạy kỳ dưới 15 giây, chạy lại không đổi dưới 10 giây. Sinh dữ liệu khoảng 110 giây. Biến môi trường `PERF_FIXED`, `PERF_TOOLS`, `PERF_PREPAID` đổi số thẻ.

Trước tối ưu (đo ở 600 TSCĐ, 300 CCDC, 100 trả trước; tuyến tính khoảng 20 ms mỗi thẻ nên 3.000 TSCĐ ước tính 60 giây): khấu hao kỳ lớn nhất 12,4 giây, trung bình 9,1 giây, chạy lại 11,4 giây; CCDC 7,5 giây; trả trước 2,7 giây.

Sau tối ưu, đủ 5.000 thẻ (giây):

| Loại | Chạy kỳ lớn nhất | Chạy kỳ trung bình | Chạy lại lớn nhất | Dòng phát sinh (12 kỳ) |
|---|---|---|---|---|
| Khấu hao TSCĐ | 13,2 | 5,2 | 1,3 | 36.000 |
| Phân bổ CCDC | 3,0 | 2,0 | 0,4 | 15.750 |
| Phân bổ trả trước | 1,0 | 0,8 | 0,2 | 6.000 |

Ba thay đổi:

1. **`scheduleForMany`** (`schedule.ts`): `computeAmounts` nạp thẻ, biến động dừng/tiếp tục, phiên bản lịch hiện hành và dòng lịch bằng vài truy vấn theo lô, gọi `fn_asset_values_at` một lần cho cả kỳ (không còn một lần mỗi thẻ), quyết định trong bộ nhớ (hàm `decide` dùng chung với `scheduleFor` một thẻ) rồi chèn phiên bản mới và dòng lịch theo lô (`unnest`). Chạy kỳ không đổi từ 11,4 giây xuống 0,3 giây ở 600 thẻ. Kỳ đầu của mỗi thẻ vẫn phải dựng và lưu lịch cả đời thẻ (khoảng 180.000 dòng cho 3.000 thẻ: dựng khoảng 4 giây, chèn khoảng 4,5 giây).
2. **Migration `0077_ghep_cap_tuyen_tinh.sql`**: `fn_build_pairs` nhánh n-n nối Nợ với Có bằng điều kiện giao đoạn nên so từng cặp (6.000 x 3.000 cặp); chứng từ KH 9.000 dòng mất khoảng 8,3 giây ở `post_voucher`. Bản mới cắt trục tại mọi điểm cuối đoạn rồi nối bằng số thứ tự đoạn: 0,3 giây, kết quả ghép và thứ tự không đổi.
3. Bước còn lại đáng kể ở kỳ thường: tạo chứng từ 9.000 dòng khoảng 3 giây (`insertVoucher`, tra cứu và quy tắc từng dòng), chưa tối ưu.
