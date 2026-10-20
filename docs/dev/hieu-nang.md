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
