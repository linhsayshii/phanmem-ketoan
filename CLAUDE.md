# CLAUDE.md — hướng dẫn cho agent làm việc trên repo này

Phần mềm kế toán doanh nghiệp Việt Nam (web): TypeScript + PostgreSQL, monorepo pnpm. Mục tiêu: đạt mặt bằng nghiệp vụ MISA/Fast/SUNSOFT, tuân thủ TT 99/2025, TT 133/2016, hóa đơn điện tử 2026.

**Trạng thái:** Giai đoạn 0 (nền tảng) và Giai đoạn 1 (lõi sổ cái) đã xong, tag `gd0-hoan-tat`, `gd1-hoan-tat`. Việc tiếp theo nằm ở `docs/TIEP-THEO.md`: đọc file đó trước khi làm bất cứ gì.

## Đọc trước khi làm

| Tài liệu | Khi nào đọc |
|---|---|
| `docs/TIEP-THEO.md` | Luôn đọc đầu tiên: hàng đợi việc, việc tồn đọng, việc chờ người dùng |
| `docs/superpowers/specs/2026-10-19-phan-mem-ke-toan-design.md` | Đặc tả đã duyệt: kiến trúc, mô hình dữ liệu, quy tắc nghiệp vụ, danh sách phân hệ (mục 9), tham số pháp lý (mục 10) |
| `docs/superpowers/plans/2026-10-19-lo-trinh-thuc-hien.md` | Lộ trình 8 giai đoạn: công việc và tiêu chí nghiệm thu từng giai đoạn |
| `docs/superpowers/plans/2026-10-19-giai-doan-0-1-chi-tiet.md` | Kế hoạch chi tiết GĐ0–1 đã thực hiện: mẫu để viết kế hoạch các giai đoạn sau |
| `docs/superpowers/plans/2026-10-19-giai-doan-0-1-quyet-dinh.md` | 244 quyết định khi thực hiện GĐ0–1: quy ước đã chốt, việc đã hoãn |
| `reports/Nghiệp vụ phần mềm kế toán.md` | Báo cáo nghiên cứu: danh sách nghiệp vụ Baseline/Differentiator/Niche, tích hợp, pháp lý |
| `research_notes/Nghiệp vụ phần mềm kế toán/*.md` | Chi tiết theo nguồn: MISA, đối thủ, SUNSOFT PRO, mã nguồn mở, pháp lý, thiết kế sổ cái |
| `docs/user/*.md` | Tài liệu người dùng từng giai đoạn: cập nhật khi thêm tính năng |
| `docs/dev/kiem-thu.md` | Cách chạy kiểm thử, cơ sở dữ liệu tạm, biến môi trường |

## Cấu trúc

- `apps/api` (`@kt/api`): Fastify, module nghiệp vụ trong `src/modules/*`, kiểm thử trong `test/` (bất biến fast-check ở `test/invariants`).
- `apps/web` (`@kt/web`): React 18 + Vite + Ant Design 5 + AG Grid, trang ở `src/pages`, E2E Playwright.
- `apps/worker` (`@kt/worker`): pg-boss: tính lại số dư, sao lưu `pg_dump`.
- `packages/db` (`@kt/db`): migration SQL đánh số `migrations/00NN_*.sql`, client Kysely, seed `demo-abc`, `dich-vu-xyz`.
- `packages/domain` (`@kt/domain`): quy tắc thuần (tiền, số Việt Nam, kỳ kế toán).
- `packages/ui` (`@kt/ui`): thành phần dùng chung (lưới nhập liệu bàn phím, ô số Việt Nam, tra cứu F4, bộ lọc nhớ).
- `packages/coa-data` (`@kt/coa-data`): mẫu hệ thống tài khoản, sơ đồ kết chuyển, định nghĩa báo cáo theo chế độ; `*.status.json` là cổng dữ liệu pháp lý.

## Lệnh

```bash
cp .env.example .env                 # lần đầu; đổi SESSION_SECRET
pnpm install
docker compose up -d postgres        # trên VPS oracle: sudo docker compose up -d postgres
pnpm db:migrate
pnpm db:seed:abc && pnpm db:seed:xyz # dữ liệu mẫu (đăng nhập admin / Matkhau1!)
pnpm -F @kt/api dev                  # API :3000
pnpm -F @kt/web dev                  # web :5173
pnpm lint && pnpm typecheck && pnpm test
INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts
pnpm -F @kt/web e2e                  # cần trình duyệt Playwright
```

Một gói: `pnpm -F @kt/api test -- test/vouchers.test.ts`. Kiểm thử chạy trên PostgreSQL thật; dùng cơ sở dữ liệu tạm theo `docs/dev/kiem-thu.md` khi DB phát triển phình to.

## Quy tắc bất biến (không được phá)

- Tiền VND `NUMERIC(20,0)`, ngoại tệ `NUMERIC(20,4)`, tỷ giá `NUMERIC(20,10)`; trong TypeScript tiền là chuỗi thập phân + `decimal.js` (`D()`), không bao giờ `number`/`float`. Đầu vào tiền VND theo `^\d{1,16}$`.
- Không `UPDATE`/`DELETE` dòng sổ cái đã ghi sổ. Sửa theo máy trạng thái draft → posted → reversed / cancelled (đặc tả mục 7.1): kỳ mở dùng `unpost`, kỳ khóa sổ dùng đảo, kỳ khóa cứng dùng chứng từ điều chỉnh ở kỳ mở.
- Chứng từ tự động (giá vốn, khấu hao, phân bổ, kết chuyển, chênh lệch tỷ giá, lương) là chứng từ thật có số, ngày, người lập và `source_doc_*`; chạy lại bằng đảo cũ, sinh mới. Loại chứng từ hệ thống (KC, DK) không sửa/xóa qua route chung.
- Mọi bảng nghiệp vụ có `tenant_id`, row-level security bật, mọi `UNIQUE` có `tenant_id`. Hàm `SECURITY DEFINER` phải `SET search_path = public, pg_temp`.
- Migration 0001–0015 đã đóng băng: thay đổi lược đồ luôn bằng migration mới số tiếp theo, định nghĩa lại hàm từ thân cuối cùng của nó.
- Tham số pháp lý theo ngày hiệu lực trong `legal_param`; chế độ kế toán gắn với năm tài chính; định nghĩa báo cáo và sơ đồ kết chuyển là dữ liệu (`packages/coa-data`), không viết cứng.
- Không bịa dữ liệu pháp lý. Hệ thống tài khoản TT99 và chỉ tiêu B01/B02/B03 chỉ nhập từ văn bản gốc; khi chưa có, giữ `complete=false` trong `*.status.json`.
- Mọi thay đổi dữ liệu nghiệp vụ ghi `audit_event` (trước/sau). Báo cáo đọc trong giao dịch `REPEATABLE READ READ ONLY`.
- Cờ dữ liệu nhạy cảm (`view_receivable`, `view_payable`, `view_cost`, lương) chặn ở API, không chỉ ẩn ở giao diện.
- Giao diện, thông báo lỗi, tài liệu người dùng: tiếng Việt kế toán chuẩn (Phiếu thu, Giấy báo có, Sổ cái, Bảng cân đối số phát sinh…). Mã, tên bảng, tên biến: tiếng Anh như hiện có.

## Quy trình làm một giai đoạn

1. Đọc `docs/TIEP-THEO.md`, phần giai đoạn tương ứng trong lộ trình và đặc tả.
2. Viết kế hoạch chi tiết bằng skill `superpowers:writing-plans`, lưu `docs/superpowers/plans/<ngày>-giai-doan-N-chi-tiet.md`, theo đúng khuôn kế hoạch GĐ0–1 (tác vụ nhỏ, mã thật, kiểm thử trước, lệnh chạy, commit). Không cần chờ người dùng duyệt kế hoạch: tự rà soát theo mục Self-Review rồi thực hiện.
3. Thực hiện bằng `superpowers:subagent-driven-development`: mỗi tác vụ một subagent thực hiện, một subagent rà soát, sửa, rà soát lại. Ghi các quyết định vào `docs/superpowers/plans/<ngày>-giai-doan-N-quyet-dinh.md`.
4. Kết thúc: rà soát toàn nhánh của giai đoạn, một đợt sửa, `pnpm lint && pnpm typecheck && pnpm test` và kiểm thử bất biến xanh, cập nhật `docs/user/giai-doan-N-*.md`, tag `gdN-hoan-tat`, cập nhật `docs/TIEP-THEO.md`, push.

### Chọn model

- Opus hoặc Fable: lập kế hoạch, thiết kế, logic kế toán khó (tính giá vốn, tỷ giá, giá thành, thuế), rà soát toàn nhánh cuối giai đoạn.
- Subagent: model thấp hơn. Sonnet cho thực hiện tác vụ và rà soát từng tác vụ; Haiku cho việc cơ học (đổi tên, sửa nhỏ, tìm kiếm, chạy lệnh, rà soát lại một bản sửa nhỏ). Luôn truyền `model` khi gọi Agent.

### Giao diện

- Mọi màn hình mới hoặc làm lại theo skill `evon:ui-ux` ở chế độ **dựng luôn** ("dựng luôn"): không làm brief, không đưa wireframe chờ chọn, không chờ người dùng duyệt. Áp dụng gu của skill cho ứng dụng dày dữ liệu (bảng, form, lưới chứng từ, báo cáo, cài đặt).
- Giữ nhất quán với thành phần đã có trong `packages/ui` và Ant Design 5; thêm thành phần dùng chung vào `packages/ui` thay vì viết lại trong trang.
- Nhập liệu bằng bàn phím là yêu cầu cốt lõi (Enter/Tab, F4, Ctrl+S, F9, Insert); mọi lưới chứng từ dùng lưới chung.
- Mỗi màn hình có ít nhất một kiểm thử Playwright cho luồng chính.

## Git

- Nhánh `main`, commit nhỏ theo Conventional Commits, mô tả tiếng Việt, ví dụ `feat(cash): phiếu thu, phiếu chi và sổ quỹ`. Dòng cuối commit: trailer `Co-Authored-By` của model thực sự viết commit đó.
- Remote `origin` là repo bare trên cùng VPS (`~/git/phanmem-ketoan.git`). Push `main` và tag sau mỗi tác vụ xong; không force-push.
- Không commit `.env`, bí mật, dữ liệu khách hàng. Không đọc dữ liệu giao dịch thật của SUNSOFT.

## Môi trường VPS oracle (khi chạy trên `linhsayshi-vps`)

- Ubuntu 24.04 aarch64, 2 CPU, 11 GiB RAM, user `ubuntu` có sudo không mật khẩu. Node 22 và pnpm (corepack) nằm ở `~/.local/bin`. Docker cần `sudo`.
- Máy này đang chạy dịch vụ thật khác: container `karaoke502-*` và `npm-app-1` (nginx proxy manager) trên cổng 80, 81, 443, 3502. **Không** dừng, sửa, xóa, kết nối vào các container, volume, mạng hay thư mục `~/502-karaoke`, `~/npm` đó. **Không** chạy `docker system prune`, `docker volume prune`, `docker compose down -v` ngoài thư mục dự án, không sửa cấu hình nginx proxy manager, firewall, SSH, người dùng hệ thống.
- Cổng của dự án chỉ bind `127.0.0.1` (5432, 3000, 8080, 5173). Không mở cổng ra Internet; không dùng 80/81/443/3502.
- Cài thêm gói hệ thống bằng `sudo apt-get install` chỉ khi cần cho dự án (ví dụ thư viện của Playwright, `poppler-utils`, `postgresql-client-16`); ghi lại trong `docs/TIEP-THEO.md`.
- Tài nguyên hạn chế: chạy kiểm thử tuần tự như cấu hình hiện có, tránh chạy nhiều subagent nặng (Playwright, kiểm thử bất biến dài) cùng lúc.

## Khi bị chặn

- Việc cần người dùng (tài khoản thử nghiệm, chứng thư số, văn bản pháp lý không tải được, kiểm tay gõ Telex/VNI, quyết định kinh doanh): ghi vào mục "Chờ người dùng" của `docs/TIEP-THEO.md` với việc cần làm cụ thể, rồi làm tiếp việc khác không phụ thuộc.
- Tích hợp chưa có tài khoản thử (SInvoice, SePay/Casso, ký số): làm giao diện adapter, adapter giả lập cho kiểm thử, và adapter thật theo tài liệu công khai; đánh dấu "chưa thử trên môi trường thật".
