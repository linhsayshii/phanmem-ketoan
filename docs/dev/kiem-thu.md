# Chạy kiểm thử

Kiểm thử API, cơ sở dữ liệu và worker chạy trên PostgreSQL thật (`docker compose up -d postgres`). Mỗi file kiểm thử tạo công ty riêng; cả bộ chạy trong một cơ sở dữ liệu tạm nên không tích lũy dữ liệu vào cơ sở dữ liệu phát triển.

## Cơ sở dữ liệu tạm theo lần chạy

Mỗi lần `pnpm test` (hoặc `pnpm -F <gói> test`) tự tạo cơ sở dữ liệu `ketoan_t_<8 hex>` trên cùng máy chủ với `DATABASE_ADMIN_URL`, chạy migration và nạp dữ liệu tham chiếu vào đó, trỏ `DATABASE_URL` và `DATABASE_ADMIN_URL` của kiểm thử sang nó, rồi xóa khi xong (`packages/db/src/test-global-setup.ts`). Cơ sở dữ liệu phát triển `ketoan` không bị ghi; không cần tạo hay xóa DB thủ công. Vai trò `app_user` là vai trò của cả cụm nên không cần tạo lại. Hai biến gốc lấy từ môi trường hoặc `.env`; thiếu thì kiểm thử báo lỗi ngay.

Tiến trình kiểm thử bị giết (SIGKILL, mất điện) để lại `ketoan_t_*` hoặc `ketoan_ref_*`. Liệt kê bằng `psql "$DATABASE_ADMIN_URL" -Atc "SELECT datname FROM pg_database WHERE datname ~ '^ketoan_(t|ref)_'"` rồi xóa từng cái bằng `dropdb --force <tên>`.

- `KT_TEST_KEEP_DB=1`: giữ lại cơ sở dữ liệu tạm khi xong (tên in ra stderr) để điều tra; tự xóa bằng `dropdb`.
- Kiểm thử vẫn chạy tuần tự (`--no-file-parallelism`) vì máy chỉ 2 CPU.

## Các biến thường dùng

- `pnpm test`: chạy toàn bộ (mỗi gói tuần tự, `--no-file-parallelism`); một gói: `pnpm -F @kt/api test -- test/vouchers.test.ts`.
- `INVARIANTS=1`: chạy thêm các kiểm thử bất biến (fast-check) trong `apps/api/test/invariants`, mặc định bị bỏ qua; cùng bộ dữ liệu mẫu XYZ và ABC: `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts test/sample-abc.test.ts`.
- `pnpm -F @kt/api perf:costing`: đo `runCosting` cả năm trên 54.000 dòng kho cho bốn phương pháp giá vốn (DB tạm, khoảng 10 phút gồm 144 giây sinh dữ liệu); tiêu chí dưới 30 giây mỗi phương pháp, số đo trong `docs/dev/hieu-nang.md`. Bất biến sổ kho: `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants/inv7-kho.test.ts`.
- Dữ liệu mẫu ABC (`pnpm db:seed:abc`) chạy `apps/api/scripts/seed-abc.ts`: danh mục từ `packages/db/src/seed/demo-abc.ts` (`seedAbcTx`), rồi một năm nghiệp vụ 2026 dựng bằng chính dịch vụ của API (hóa đơn, đối trừ, tỷ giá xuất quỹ, đánh giá lại, phân bổ, khấu trừ thuế, tờ khai), tất cả trong một giao dịch và dưới vai trò `app_user` (RLS lọc theo công ty). Chạy lại không tạo thêm; công ty ABC cũ chỉ có danh mục (chưa có chứng từ nào) được bổ sung năm nghiệp vụ. `pnpm -F @kt/db seed:abc` chỉ tạo danh mục. Kỳ vọng tính tay ở `packages/db/src/seed/expected-gd2-abc.json`, kiểm ở `apps/api/test/sample-abc.test.ts`.
- `FC_RUNS=<số nguyên dương>`: số lần chạy mỗi thuộc tính fast-check (mặc định theo từng kiểm thử); đặt lớn hơn để chạy dài thủ công, thời gian chờ nới theo.
- E2E (Playwright, `pnpm -F @kt/web e2e`): cổng mặc định 3000 và 5173; nếu đang có tiến trình khác chiếm, đặt `E2E_API_PORT` và `E2E_WEB_PORT` sang cổng trống. Điều kiện trước (chạy một lần trên DB phát triển): `pnpm -F @kt/api cli create-admin --username e2e --password 'Matkhau1!' --tenant-code E2E --tenant-name "Công ty E2E"`. `pnpm -F @kt/web e2e -- <spec>` không lọc theo tệp: dùng `pnpm -F @kt/web exec playwright test e2e/<spec>`.

## Thời gian bộ kiểm thử web

Bộ kiểm thử đơn vị web (`pnpm -F @kt/web test`, jsdom) từng mất khoảng 20 phút (tổng thời gian từng tệp 1226 giây, một vài kiểm thử quá hạn). Hồ sơ CPU (`--cpu-prof`) cho thấy gần hết thời gian nằm ở `nwsapi` (so khớp selector CSS) do `window.getComputedStyle` của jsdom so từng luật CSS với phần tử, mà Ant Design chèn hàng nghìn luật; `getByRole` (kiểm tra phần tử bị ẩn) và `user-event` (kiểm tra `pointer-events`) gọi hàm này cho rất nhiều phần tử. `vitest.setup.ts` nay chỉ giữ các luật có thuộc tính `display`, `visibility`, `opacity`, `pointer-events` (thứ duy nhất thư viện kiểm thử đọc) trước khi tính kiểu; kết quả: bộ web còn khoảng 3 phút, `Closing.test.tsx` từ 200 giây xuống 12 giây. Nếu sau này cần đọc thuộc tính CSS khác từ stylesheet trong kiểm thử (ví dụ `toHaveStyle` với kiểu đến từ class, không phải `style` nội tuyến), thêm thuộc tính đó vào tập `READ` trong `vitest.setup.ts`. Đã loại trừ: tắt hiệu ứng antd, độ trễ `userEvent`, cấu hình pool (không phải nguyên nhân chính).
