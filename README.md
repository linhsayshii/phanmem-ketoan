# Phần mềm kế toán doanh nghiệp Việt Nam

[![ci](https://github.com/linhsayshii/phanmem-ketoan/actions/workflows/ci.yml/badge.svg)](https://github.com/linhsayshii/phanmem-ketoan/actions/workflows/ci.yml)

Phần mềm kế toán web cho doanh nghiệp Việt Nam: TypeScript + PostgreSQL, monorepo pnpm. Mục tiêu đạt mặt bằng nghiệp vụ MISA/Fast/SUNSOFT, tuân thủ TT 99/2025, TT 133/2016, TT 200/2014 (năm 2015–2025), hộ kinh doanh TT 152/2025, siêu nhỏ TT 58/2026 và hóa đơn điện tử 2026.

**Trạng thái (2026-10-31):** lộ trình 8 giai đoạn đã xong (tag `gd0-hoan-tat` … `gd7-hoan-tat`). Chưa dùng thật: còn việc chờ người dùng (kiểm tay giao diện, kế toán trưởng rà chỉ tiêu báo cáo, tài khoản thử hóa đơn điện tử và ngân hàng, một số văn bản pháp lý), xem `docs/TIEP-THEO.md`.

## Phân hệ

| Giai đoạn | Nội dung | Tài liệu người dùng |
|---|---|---|
| GĐ0–1 | Nền tảng, đa công ty, phân quyền, nhật ký kiểm toán; sổ cái kép: Phiếu kế toán, ghi sổ/đảo/khóa sổ ba mức, kết chuyển, Nhật ký chung, Sổ cái, Bảng cân đối số phát sinh, BCTC, in PDF/Excel, soát lỗi | `docs/user/giai-doan-0-bat-dau.md`, `giai-doan-1-so-cai.md` |
| GĐ2 | Phiếu thu/chi, Giấy báo nợ/có, UNC, tạm ứng; công nợ, đối trừ, tuổi nợ, chênh lệch tỷ giá; thuế GTGT, tờ khai 01/GTGT và XML HTKK | `giai-doan-2-tien-cong-no-thue.md` |
| GĐ3 | Kho, vật tư hàng hóa, mua hàng, bán hàng, đơn hàng; giá vốn 4 phương pháp; báo cáo kho và lãi gộp | `giai-doan-3-kho-mua-ban.md` |
| GĐ4 | TSCĐ, CCDC, chi phí trả trước, khấu hao/phân bổ; khế ước vay; quy trình cuối kỳ | `giai-doan-4-tai-san-khe-uoc.md` |
| GĐ5 | Hóa đơn điện tử (giả lập, Viettel SInvoice), ký số XML, hóa đơn đầu vào; SePay/Casso, sao kê, VietQR; thuế TNDN 03/TNDN; API ngoài | `giai-doan-5-hoa-don-tich-hop.md`, `ky-so.md` |
| GĐ6 | Lương, chấm công, BHXH, TNCN (05/KK, 05/QTT); giá thành; hợp đồng, vụ việc | `giai-doan-6-luong-gia-thanh-hop-dong.md` |
| GĐ7 | Hình thức sổ CTGS/NKSC/NKCT, đa chi nhánh, ngân sách và phân tích, phê duyệt và API mobile, song ngữ, trợ lý AI, sổ hộ kinh doanh và siêu nhỏ | `giai-doan-7-*.md` |

Hạn chế đã biết: `docs/dev/han-che.md`. Lịch sử phạm vi và kiểm thử từng giai đoạn: `docs/dev/lich-su-giai-doan.md`.

## Cấu trúc

| Gói | Vai trò |
|---|---|
| `apps/api` (`@kt/api`) | Fastify, module nghiệp vụ trong `src/modules/*`, kiểm thử trong `test/` (bất biến fast-check ở `test/invariants`) |
| `apps/web` (`@kt/web`) | React 18 + Vite + Ant Design 5 + AG Grid, E2E Playwright |
| `apps/worker` (`@kt/worker`) | pg-boss: tính lại số dư, đối soát hóa đơn, sao lưu `pg_dump` |
| `packages/db` (`@kt/db`) | Migration SQL, client Kysely, dữ liệu mẫu `demo-abc`, `dich-vu-xyz` |
| `packages/domain` (`@kt/domain`) | Quy tắc thuần: tiền, số Việt Nam, kỳ kế toán |
| `packages/ui` (`@kt/ui`) | Lưới nhập liệu bàn phím, ô số Việt Nam, tra cứu F4, bộ lọc nhớ |
| `packages/coa-data` (`@kt/coa-data`) | Hệ thống tài khoản, sơ đồ kết chuyển, mẫu báo cáo và tờ khai theo chế độ; `*.status.json` là cổng dữ liệu pháp lý |

## Chạy thử

Cần Node 22, pnpm (corepack) và Docker.

```bash
cp .env.example .env                 # đổi SESSION_SECRET
pnpm install
docker compose up -d postgres
pnpm db:migrate
pnpm db:seed:abc && pnpm db:seed:xyz # đăng nhập admin / Matkhau1!
pnpm -F @kt/api dev                  # API :3000
pnpm -F @kt/web dev                  # web :5173
```

Chạy cả hệ (postgres, api, worker, web) bằng Docker: `docker compose up -d`. Sao lưu và phục hồi: `docs/user/sao-luu-phuc-hoi.md`. Khi triển khai production đặt thêm `PUBLIC_BASE_URL`, `DATA_ENCRYPTION_KEY`, `EINVOICE_ALLOWED_HOSTS`.

## Kiểm thử

```bash
pnpm lint && pnpm typecheck && pnpm test
INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts
pnpm -F @kt/web e2e                  # cần trình duyệt Playwright
```

Kiểm thử chạy trên PostgreSQL thật, mỗi lần dùng một cơ sở dữ liệu tạm (`docs/dev/kiem-thu.md`). CI GitHub Actions (`.github/workflows/ci.yml`) chạy ba job: `test`, `invariants`, `e2e`.

## Tài liệu

| Tài liệu | Nội dung |
|---|---|
| `docs/TIEP-THEO.md` | Việc tiếp theo: việc agent làm được, việc chờ người dùng |
| `docs/superpowers/specs/2026-10-19-phan-mem-ke-toan-design.md` | Đặc tả thiết kế: kiến trúc, mô hình dữ liệu, quy tắc nghiệp vụ, phân hệ, tham số pháp lý |
| `docs/superpowers/plans/` | Lộ trình 8 giai đoạn, kế hoạch chi tiết và sổ quyết định từng giai đoạn |
| `docs/user/` | Tài liệu người dùng từng phân hệ |
| `docs/dev/` | Kiểm thử, hiệu năng, API ngoài và mobile, tích hợp, ký số cục bộ, hạn chế |
| `reports/Nghiệp vụ phần mềm kế toán.md`, `research_notes/` | Nghiên cứu nghiệp vụ: MISA, đối thủ, SUNSOFT PRO, mã nguồn mở, pháp lý, thiết kế sổ cái |
| `CLAUDE.md` | Hướng dẫn và quy tắc bất biến cho agent |
