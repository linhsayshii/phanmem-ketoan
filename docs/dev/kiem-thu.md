# Chạy kiểm thử

Kiểm thử API, cơ sở dữ liệu và worker chạy trên PostgreSQL thật (`docker compose up -d postgres`). Mỗi file kiểm thử tạo công ty riêng; cả bộ chạy trong một cơ sở dữ liệu tạm nên không tích lũy dữ liệu vào cơ sở dữ liệu phát triển.

## Cơ sở dữ liệu tạm theo lần chạy

Mỗi lần `pnpm test` (hoặc `pnpm -F <gói> test`) tự tạo cơ sở dữ liệu `ketoan_t_<8 hex>` trên cùng máy chủ với `DATABASE_ADMIN_URL`, chạy migration và nạp dữ liệu tham chiếu vào đó, trỏ `DATABASE_URL` và `DATABASE_ADMIN_URL` của kiểm thử sang nó, rồi xóa khi xong (`packages/db/src/test-global-setup.ts`). Cơ sở dữ liệu phát triển `ketoan` không bị ghi; không cần tạo hay xóa DB thủ công. Vai trò `app_user` là vai trò của cả cụm nên không cần tạo lại. Hai biến gốc lấy từ môi trường hoặc `.env`; thiếu thì kiểm thử báo lỗi ngay.

Tiến trình kiểm thử bị giết (SIGKILL, mất điện) để lại `ketoan_t_*` hoặc `ketoan_ref_*`. Liệt kê bằng `psql "$DATABASE_ADMIN_URL" -Atc "SELECT datname FROM pg_database WHERE datname ~ '^ketoan_(t|ref)_'"` rồi xóa từng cái bằng `dropdb --force <tên>`.

- `KT_TEST_KEEP_DB=1`: giữ lại cơ sở dữ liệu tạm khi xong (tên in ra stderr) để điều tra; tự xóa bằng `dropdb`.
- Kiểm thử vẫn chạy tuần tự (`--no-file-parallelism`) vì máy chỉ 2 CPU.

## Các biến thường dùng

- `pnpm test`: chạy toàn bộ (mỗi gói tuần tự, `--no-file-parallelism`); một gói: `pnpm -F @kt/api test -- test/vouchers.test.ts`.
- `INVARIANTS=1`: chạy thêm các kiểm thử bất biến (fast-check) trong `apps/api/test/invariants` và bộ dữ liệu mẫu XYZ, mặc định bị bỏ qua: `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts`.
- `FC_RUNS=<số nguyên dương>`: số lần chạy mỗi thuộc tính fast-check (mặc định theo từng kiểm thử); đặt lớn hơn để chạy dài thủ công, thời gian chờ nới theo.
- E2E (Playwright, `pnpm -F @kt/web e2e`): cổng mặc định 3000 và 5173; nếu đang có tiến trình khác chiếm, đặt `E2E_API_PORT` và `E2E_WEB_PORT` sang cổng trống. Điều kiện trước (chạy một lần trên DB phát triển): `pnpm -F @kt/api cli create-admin --username e2e --password 'Matkhau1!' --tenant-code E2E --tenant-name "Công ty E2E"`. `pnpm -F @kt/web e2e -- <spec>` không lọc theo tệp: dùng `pnpm -F @kt/web exec playwright test e2e/<spec>`.
