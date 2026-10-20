# Chạy kiểm thử

Kiểm thử API, cơ sở dữ liệu và worker chạy trên PostgreSQL thật (`docker compose up -d postgres`). Mỗi file kiểm thử tạo công ty riêng nên không cần dọn dữ liệu, nhưng dữ liệu tích lũy dần trong cơ sở dữ liệu phát triển (hàng trăm MB: sao lưu `pg_dump` và truy vấn chậm dần).

## Chạy trên cơ sở dữ liệu tạm

Biến môi trường đã đặt sẵn thắng tệp `.env`, nên trỏ hai biến sau vào một cơ sở dữ liệu mới là đủ; kiểm thử tự chạy migration vào đó:

```sh
docker compose exec postgres createdb -U postgres ketoan_test
export DATABASE_URL=postgres://app_user:app_pass@localhost:5432/ketoan_test
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/ketoan_test
pnpm test
docker compose exec postgres dropdb -U postgres ketoan_test   # xong thì bỏ
```

Vai trò `app_user` là vai trò của cả cụm nên không cần tạo lại. Cơ sở dữ liệu `ketoan` của môi trường phát triển không bị ảnh hưởng.

## Các biến thường dùng

- `pnpm test`: chạy toàn bộ (mỗi gói tuần tự, `--no-file-parallelism`); một gói: `pnpm -F @kt/api test -- test/vouchers.test.ts`.
- `INVARIANTS=1`: chạy thêm các kiểm thử bất biến (fast-check) trong `apps/api/test/invariants` và bộ dữ liệu mẫu XYZ, mặc định bị bỏ qua: `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts`.
- `FC_RUNS=<số nguyên dương>`: số lần chạy mỗi thuộc tính fast-check (mặc định theo từng kiểm thử); đặt lớn hơn để chạy dài thủ công, thời gian chờ nới theo.
- E2E (Playwright, `pnpm -F @kt/web e2e`): cổng mặc định 3000 và 5173; nếu đang có tiến trình khác chiếm, đặt `E2E_API_PORT` và `E2E_WEB_PORT` sang cổng trống.
