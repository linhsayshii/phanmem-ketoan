# Kế hoạch thực hiện chi tiết: GĐ1.5 (tồn đọng nhóm A trước GĐ2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đóng 12 mục nhóm A của `2026-10-20-gd1-5-de-xuat.md` (bảo mật đăng nhập/phiên/phân quyền, RLS, khóa ngoại theo công ty, trigger cân bằng O(n), quy ước lỗi, hạ tầng kiểm thử) để GĐ2 xây trên nền sạch.

**Architecture:** Không thêm phân hệ. Sửa tại chỗ trong `apps/api` (auth, users, config, errors), `packages/db` (migration mới 0016–0020, `testing.ts`, globalSetup vitest) và cấu hình typecheck các gói. Mỗi thay đổi lược đồ là một migration mới, định nghĩa lại hàm từ thân cuối cùng của nó (lấy bằng `pg_get_functiondef` trên DB đã migrate, không chép từ migration cũ hơn).

**Tech Stack:** như GĐ0–1 (Node 22, TypeScript 5, Fastify 5, Kysely 0.27, PostgreSQL 16, Vitest 2.1, pnpm 9). Không thêm phụ thuộc mới.

**Spec:** `docs/superpowers/specs/2026-10-19-phan-mem-ke-toan-design.md` (mục 6, 7.1, 13, 14); đề xuất `docs/superpowers/plans/2026-10-20-gd1-5-de-xuat.md` (nhóm A); quyết định GĐ0–1 `docs/superpowers/plans/2026-10-19-giai-doan-0-1-quyet-dinh.md`.

## Global Constraints

- Mọi quy tắc trong `CLAUDE.md` mục "Quy tắc bất biến": tiền là chuỗi + `decimal.js`; không `UPDATE`/`DELETE` dòng đã ghi sổ; mọi bảng nghiệp vụ có `tenant_id`, RLS bật, `UNIQUE` có `tenant_id`; hàm `SECURITY DEFINER` có `SET search_path = public, pg_temp`; mọi thay đổi dữ liệu nghiệp vụ ghi `audit_event`.
- Migration 0001–0015 đóng băng. GĐ1.5 dùng đúng số: 0016 (T4), 0017 (T5), 0018 (T7), 0019 (T9), 0020 (T10). Tác vụ không cần SQL thì không tạo migration.
- Thông báo lỗi, chú thích, tài liệu người dùng: tiếng Việt kế toán chuẩn. Mã, tên bảng, biến: tiếng Anh.
- Kiểm thử chạy trên PostgreSQL thật, tuần tự (`--no-file-parallelism`), VPS 2 CPU. Lệnh kiểm thử một gói: `pnpm -F @kt/api test -- test/<file>.test.ts`.
- Commit nhỏ Conventional Commits, mô tả tiếng Việt, scope `db|domain|api|worker|web|ui|ci|docs`; trailer `Co-Authored-By` của model thực sự viết commit (subagent sonnet: `Claude Sonnet 5.5 <noreply@anthropic.com>`). Push `origin main` sau mỗi tác vụ.
- Không thêm phụ thuộc npm (giới hạn tần suất làm bằng bảng `login_event` sẵn có).

## Review Focus

1. Người dùng thuộc hai công ty bị quản trị viên công ty A đặt lại mật khẩu: tài khoản dùng chung ở công ty B bị chiếm. Kỳ vọng: chỉ đặt lại được khi người đó chỉ thuộc công ty hiện tại (T6 có kiểm thử).
2. Kẻ tấn công gửi `X-Forwarded-For` giả khi API không đứng sau proxy: kỳ vọng `req.ip` là IP thật của socket, giới hạn theo IP không bị lách (T3 có kiểm thử).
3. Chứng từ sửa nhiều câu lệnh trong một giao dịch (xóa dòng, chèn dòng, đổi ngày sang tháng khác): kỳ vọng kiểm tra cân bằng chạy một lần trên trạng thái cuối và vẫn bắt lệch (T10 có kiểm thử).
4. Dữ liệu dev cũ khi áp migration mới (phiên đăng nhập đang sống, vai trò `ketoan_vien` đã sửa tay, FK đơn cột có dữ liệu): migration phải chạy được trên DB đã có dữ liệu seed ABC/XYZ (mỗi tác vụ có migration chạy `pnpm db:migrate` trên DB dev sau khi xanh trên DB tạm).
5. Khóa tài khoản theo tên đăng nhập bị lợi dụng để khóa người khác: chấp nhận (khóa tạm 15 phút, ghi trong tài liệu người dùng); đăng nhập đúng trong thời gian khóa vẫn bị từ chối với thông báo rõ (T4 có kiểm thử).

---

## Cấu trúc file

- `packages/db/src/testing.ts`, `packages/db/src/test-global-setup.ts` (mới): tạo/xóa DB kiểm thử theo lần chạy.
- `apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts`, `packages/db/vitest.config.ts`: gắn `globalSetup`.
- `*/tsconfig.test.json` (mới, các gói Node), `package.json` từng gói: typecheck gồm `test/`.
- `apps/api/src/config.ts`, `apps/api/src/app.ts`: `TRUST_PROXY`, chặn cấu hình production yếu.
- `apps/api/src/modules/auth/service.ts`, `routes.ts`, `apps/api/src/plugins/auth.ts`: giới hạn đăng nhập, băm mã phiên.
- `apps/api/src/modules/core/users.ts`, `roles.ts`: chặn tự nâng quyền.
- `apps/api/src/plugins/errors.ts`: quy ước `*_NOT_FOUND` → 404.
- `packages/db/migrations/0016_gioi_han_dang_nhap.sql`, `0017_bam_ma_phien.sql`, `0018_rls_thanh_vien_vai_tro.sql`, `0019_khoa_ngoai_theo_cong_ty.sql`, `0020_kiem_can_bang_theo_cau_lenh.sql`.
- `apps/api/scripts/perf-100k.ts` (mới), `docs/dev/hieu-nang.md` (mới).

---

### Task 1 (A1): Cơ sở dữ liệu kiểm thử riêng theo lần chạy

**Files:**
- Create: `packages/db/src/test-global-setup.ts`
- Modify: `packages/db/package.json` (export `./test-global-setup`), `packages/db/vitest.config.ts`, `apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts`, `packages/db/test/reference.test.ts`, `docs/dev/kiem-thu.md`, `.github/workflows/ci.yml` (nếu đang tạo DB thủ công)

**Interfaces:**
- Produces: `export default async function setup(): Promise<() => Promise<void>>` (hình dạng globalSetup của Vitest 2): đọc `DATABASE_ADMIN_URL`/`DATABASE_URL` gốc (từ env hoặc `.env`), tạo DB `ketoan_t_<8 hex>`, chạy `migrate()` + `syncReferenceData()` vào đó, ghi đè `process.env.DATABASE_URL` và `process.env.DATABASE_ADMIN_URL` trỏ tới DB mới (worker Vitest kế thừa env của tiến trình chính), trả về hàm teardown `DROP DATABASE … WITH (FORCE)`.
- `KT_TEST_KEEP_DB=1`: không xóa DB khi xong (in tên DB ra stderr) để điều tra.
- Chạy từ gốc (`vitest.workspace.ts`), globalSetup của ba project chạy trong cùng tiến trình: lần gọi đầu đặt `process.env.KT_TEST_DB = <tên>`; lần sau thấy biến đã có thì dùng lại DB đó và trả teardown rỗng. Chỉ lần tạo mới xóa DB. Nếu env không tới được worker trong Vitest 2.1.9 thì dùng `provide`/`inject` và cho `setupTestDb()` đọc từ đó; kiểm thử Step 1 phải chứng minh cả hai trường hợp `pnpm test` (gốc) và `pnpm -F @kt/api test`.

Quyết định: giữ `--no-file-parallelism` (VPS 2 CPU, `CLAUDE.md` yêu cầu chạy tuần tự); mục "bật lại song song" của đề xuất A1 không làm, ghi vào sổ quyết định.

- [ ] **Step 1: Kiểm thử thất bại** trong `packages/db/test/withTenant.test.ts` (hoặc file mới `packages/db/test/testDb.test.ts`):

```ts
it('kiểm thử chạy trên DB tạm của lần chạy, không phải DB phát triển', () => {
  expect(new URL(process.env.DATABASE_URL!).pathname).toMatch(/^\/ketoan_t_[0-9a-f]{8}$/);
  expect(new URL(process.env.DATABASE_ADMIN_URL!).pathname).toBe(new URL(process.env.DATABASE_URL!).pathname);
});
```

- [ ] **Step 2:** `pnpm -F @kt/db test -- test/testDb.test.ts` → FAIL (pathname `/ketoan`).
- [ ] **Step 3:** Viết `test-global-setup.ts`, gắn `globalSetup: ['@kt/db/test-global-setup']` (hoặc đường dẫn tương đối) vào ba `vitest.config.ts`. `reference.test.ts`: chạy trong DB tạm riêng như `describe('migrate: checksum')` của `migrate.test.ts` (tạo DB, `migrate(url)`, `syncReferenceData(url)`, xóa ở `afterAll`) vì nó sửa `coa_template` toàn cục.
- [ ] **Step 4:** `pnpm test` (gốc) xanh; sau khi chạy, `psql -l` không còn DB `ketoan_t_*`; DB `ketoan` không có công ty mới (đếm `SELECT count(*) FROM tenant` trước/sau bằng nhau).
- [ ] **Step 5:** Cập nhật `docs/dev/kiem-thu.md` (bỏ hướng dẫn tạo `ketoan_test` thủ công, thêm `KT_TEST_KEEP_DB`), commit `test(db): mỗi lần chạy kiểm thử dùng cơ sở dữ liệu tạm riêng`.

### Task 2 (A2): Typecheck cả thư mục kiểm thử

**Files:**
- Create: `apps/api/tsconfig.test.json`, `apps/worker/tsconfig.test.json`, `packages/db/tsconfig.test.json`, `packages/domain/tsconfig.test.json`, `packages/coa-data/tsconfig.test.json`
- Modify: `package.json` của năm gói đó (script `typecheck`), các file kiểm thử có lỗi kiểu

**Interfaces:**
- `tsconfig.test.json`: `{ "extends": "./tsconfig.json", "compilerOptions": { "noEmit": true, "rootDir": "." }, "include": ["src", "test", "scripts", "vitest.config.ts"] }` (bỏ phần tử không tồn tại).
- Script: `"typecheck": "tsc -p tsconfig.test.json"` (đã gồm `src`). `build` giữ `tsconfig.json`.
- `apps/web`, `packages/ui` đã include `test`: không đổi.

- [ ] **Step 1:** Tạo các `tsconfig.test.json`, đổi script; `pnpm typecheck` → liệt kê lỗi (kỳ vọng FAIL, ví dụ `skip(note)` trong `coa.test` theo sổ theo dõi T7).
- [ ] **Step 2:** Sửa lỗi kiểu trong kiểm thử, không đổi hành vi kiểm thử; không dùng `any`/`@ts-ignore` trừ khi kèm chú thích lý do một dòng.
- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm test` xanh.
- [ ] **Step 4:** Commit `chore: typecheck cả thư mục kiểm thử`.

### Task 3 (A4): Proxy tin cậy và cấu hình production

**Files:**
- Modify: `apps/api/src/config.ts`, `apps/api/src/app.ts:36`, `.env.example`, `docker-compose.yml` (thêm `TRUST_PROXY: "false"` cho api), `docs/user/giai-doan-0-nen-tang.md` hoặc tài liệu triển khai hiện có (mục cấu hình production)
- Test: `apps/api/test/config.test.ts` (mới)

**Interfaces:**
- `Config` thêm `TRUST_PROXY: boolean | number | string` (đã chuyển đổi): `''`/`'false'` → `false` (mặc định); `'true'` → `true`; `/^\d+$/` → số bước proxy; còn lại → chuỗi danh sách IP/CIDR cách nhau dấu phẩy (Fastify nhận nguyên chuỗi).
- `Config` thêm `NODE_ENV: string` (mặc định `'development'`). Khi `NODE_ENV === 'production'`: `SESSION_SECRET.length >= 32` và khác `'doi-chuoi-nay-khi-trien-khai'`, `COOKIE_SECURE === 'true'`; vi phạm → `loadConfig` ném lỗi tiếng Việt nêu tên biến (server dừng khi khởi động).
- `buildApp`: `Fastify({ …, trustProxy: opts.config.TRUST_PROXY })`.

- [ ] **Step 1: Kiểm thử thất bại** (`config.test.ts`):

```ts
const base = { DATABASE_URL: 'postgres://x', SESSION_SECRET: 'test-secret-123' };
it('production thiếu COOKIE_SECURE hoặc SESSION_SECRET ngắn thì dừng', () => {
  expect(() => loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true' })).toThrow(/SESSION_SECRET/);
  expect(() => loadConfig({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'a'.repeat(32) })).toThrow(/COOKIE_SECURE/);
  expect(loadConfig({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'a'.repeat(32), COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe('true');
});
it('TRUST_PROXY: mặc định false, nhận true, số bước, danh sách IP', () => {
  expect(loadConfig(base).TRUST_PROXY).toBe(false);
  expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
  expect(loadConfig({ ...base, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
  expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.1,172.16.0.0/12' }).TRUST_PROXY).toBe('10.0.0.1,172.16.0.0/12');
});
it('không tin proxy thì X-Forwarded-For không đổi IP ghi vào login_event', async () => {
  // buildApp với TRUST_PROXY mặc định; POST /api/auth/login sai mật khẩu kèm header x-forwarded-for: 1.2.3.4
  // → dòng login_event mới nhất có ip khác '1.2.3.4' (inject dùng 127.0.0.1)
});
```

- [ ] **Step 2:** `pnpm -F @kt/api test -- test/config.test.ts` → FAIL.
- [ ] **Step 3:** Cài đặt theo Interfaces (`superRefine` của Zod cho ràng buộc production).
- [ ] **Step 4:** Chạy lại → PASS; `pnpm -F @kt/api test` xanh.
- [ ] **Step 5:** Commit `fix(api): chỉ tin proxy khi cấu hình, chặn cấu hình production yếu`.

### Task 4 (A3): Giới hạn đăng nhập sai

**Files:**
- Create: `packages/db/migrations/0016_gioi_han_dang_nhap.sql`
- Modify: `apps/api/src/modules/auth/service.ts`, `apps/api/src/modules/auth/routes.ts`, `apps/api/src/config.ts`, `apps/web/src/pages/Login*.tsx` (hiện thông báo 429 nếu trang đang nuốt lỗi), `docs/user/giai-doan-0-*.md`
- Test: `apps/api/test/auth.test.ts`

**Interfaces:**
- Migration: `CREATE INDEX login_event_username_ts ON login_event (username, ts DESC); CREATE INDEX login_event_ip_ts ON login_event (ip, ts DESC);`
- `Config` thêm `LOGIN_MAX_FAILS_USER` (mặc định 5), `LOGIN_MAX_FAILS_IP` (mặc định 20), `LOGIN_LOCK_MINUTES` (mặc định 15), đều `z.coerce.number().int().positive()`.
- `login(db, input & { limits: { maxFailsUser: number; maxFailsIp: number; lockMinutes: number } })` trả `LoginResult | null | 'throttled'`. Đếm lần sai (`success = false`) trong `lockMinutes` phút gần nhất **kể từ lần đúng gần nhất** của tên đăng nhập đó (lần đúng xóa bộ đếm theo tên); theo IP đếm mọi lần sai. Đạt ngưỡng → ghi `login_event` (success false), không gọi argon2, trả `'throttled'`.
- Route: `'throttled'` → `AppError('LOGIN_THROTTLED', 'Đăng nhập sai quá nhiều lần, thử lại sau ${lockMinutes} phút', 429)`.

- [ ] **Step 1: Kiểm thử thất bại** trong `auth.test.ts` (dùng `createTestApp` với `LOGIN_MAX_FAILS_USER=3`, `LOGIN_MAX_FAILS_IP=1000` truyền qua env của `loadConfig`; nếu `createTestApp` chưa nhận ghi đè config thì thêm tham số `configOverrides?: Partial<NodeJS.ProcessEnv>`):

```ts
it('sai mật khẩu đủ ngưỡng thì khóa tạm, kể cả khi nhập đúng; tên khác không bị ảnh hưởng', async () => {
  for (let i = 0; i < 3; i++) expect((await login(u, 'sai')).statusCode).toBe(401);
  const r = await login(u, TEST_PASSWORD);
  expect(r.statusCode).toBe(429);
  expect(r.json().error.code).toBe('LOGIN_THROTTLED');
  expect((await login(other, TEST_PASSWORD)).statusCode).toBe(200);
});
it('đăng nhập đúng trước ngưỡng thì xóa bộ đếm theo tên', async () => {
  await login(u2, 'sai'); await login(u2, 'sai');
  expect((await login(u2, TEST_PASSWORD)).statusCode).toBe(200);
  await login(u2, 'sai'); await login(u2, 'sai');
  expect((await login(u2, TEST_PASSWORD)).statusCode).toBe(200);
});
it('quá ngưỡng theo IP thì khóa mọi tên từ IP đó', async () => { /* app riêng với LOGIN_MAX_FAILS_IP=4, 4 tên khác nhau sai 1 lần → tên thứ 5 đúng mật khẩu vẫn 429 */ });
```

- [ ] **Step 2:** `pnpm -F @kt/api test -- test/auth.test.ts` → FAIL.
- [ ] **Step 3:** Viết migration và cài đặt. Trang đăng nhập hiện `message` của lỗi 429.
- [ ] **Step 4:** `pnpm db:migrate` trên DB dev, `pnpm -F @kt/api test` và `pnpm -F @kt/web test` xanh.
- [ ] **Step 5:** Tài liệu người dùng: một đoạn "Đăng nhập sai 5 lần liên tiếp thì tài khoản bị khóa 15 phút". Commit `feat(api): khóa tạm đăng nhập sau nhiều lần sai`.

### Task 5 (A7): Băm mã phiên, dọn phiên hết hạn

**Files:**
- Create: `packages/db/migrations/0017_bam_ma_phien.sql`
- Modify: `apps/api/src/modules/auth/service.ts`, `apps/api/src/plugins/auth.ts`, `packages/db/src/types.ts` (cột mới)
- Test: `apps/api/test/auth.test.ts`

**Interfaces:**
- Migration: `DELETE FROM user_session;` (mọi người đăng nhập lại, ghi trong chú thích) rồi `ALTER TABLE user_session ADD COLUMN token_hash text NOT NULL; CREATE UNIQUE INDEX user_session_token_hash ON user_session (token_hash); CREATE INDEX user_session_expires ON user_session (expires_at);`
- `login` sinh `token = randomBytes(32).toString('base64url')`, lưu `token_hash = sha256(token)` hex; `LoginResult.sessionToken: string` (đổi tên từ `sessionId`; route đặt cookie `sid` = token). Cùng giao dịch đăng nhập: `DELETE FROM user_session WHERE expires_at < now()`.
- Plugin auth: tra `user_session` theo `token_hash = sha256(unsigned.value)`; `AuthCtx.sessionId` vẫn là `user_session.id` (uuid) cho `selectTenant`/`logout`.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('cookie phiên không trùng bất kỳ giá trị nào lưu trong user_session', async () => {
  const { cookie, userId } = await bootstrapTenant(ctx, { code: 'SESS1' });
  const token = ctx.app.unsignCookie(cookie.replace(/^sid=/, '')).value!;
  const rows = await ctx.t.admin.selectFrom('user_session').selectAll().where('user_id', '=', userId).execute();
  expect(rows).toHaveLength(1);
  expect(Object.values(rows[0]!).map(String)).not.toContain(token);
  expect(rows[0]!.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
});
it('đăng nhập dọn phiên đã hết hạn', async () => { /* chèn phiên expires_at = now() - 1 day bằng admin, đăng nhập bất kỳ → phiên đó không còn */ });
```

- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt. **Step 4:** `pnpm db:migrate` dev; `pnpm -F @kt/api test` xanh; E2E đăng nhập (`pnpm -F @kt/web e2e`, một spec đăng nhập là đủ) xanh.
- [ ] **Step 5:** Commit `fix(api): lưu băm mã phiên thay vì mã thô, dọn phiên hết hạn`.

### Task 6 (A5): Chặn tự nâng quyền trong quản trị người dùng và vai trò

**Files:**
- Modify: `apps/api/src/modules/core/users.ts`, `apps/api/src/modules/core/roles.ts`, `apps/web/src/pages/Users*.tsx` (ẩn/khóa ô vai trò và cờ khi sửa chính mình)
- Test: `apps/api/test/users.test.ts`

**Interfaces (mã lỗi, đều 409 trừ ghi khác):**
- `SELF_PRIVILEGE_CHANGE`: `PUT /api/users/:id` với `id = req.auth.userId` có `roleCode` hoặc `sensitiveFlags`; `PUT /api/users/:id/active` cho chính mình. Thông báo: `Không tự đổi vai trò, cờ dữ liệu nhạy cảm hay trạng thái của chính mình`.
- `SENSITIVE_FLAG_NOT_HELD` (403): `POST/PUT` gán cờ nhạy cảm mà người thao tác không có (`req.auth.sensitive`).
- `LAST_ADMIN`: thao tác làm công ty không còn thành viên đang hoạt động nào có vai trò `admin`.
- `USER_SHARED`: đặt lại mật khẩu hoặc đổi `fullName` của người dùng thuộc từ hai công ty trở lên (đếm `tenant_user` bằng hàm SQL `SECURITY DEFINER` mới `user_tenant_count(uuid) RETURNS int` trong migration 0018 của Task 7, hoặc truy vấn qua `listTenantsOf` nếu RLS cho phép thấy; chọn cách không lộ dữ liệu công ty khác). Trừ khi đó là chính mình đổi mật khẩu của mình. Thông báo: `Người dùng này thuộc nhiều công ty; chỉ chính họ đổi được mật khẩu và họ tên`.
- `SYSTEM_ROLE_LOCKED`: `PUT /api/roles/:id/permissions` lên vai trò `admin` (vai trò hệ thống `admin` luôn có mọi quyền).
- `PUT /api/users/:id/active` cho người không thuộc công ty → 404 `USER_NOT_FOUND` (hiện trả 200).

Phụ thuộc: nếu chọn hàm `user_tenant_count`, thực hiện Task 7 trước hoặc đưa hàm vào migration 0018 của Task 7 và làm Task 7 trước Task 6. **Thứ tự thực hiện: Task 7 trước Task 6.**

- [ ] **Step 1: Kiểm thử thất bại** (mỗi mã lỗi một `it`, kèm đối chứng dương):

```ts
it('người có user.update không tự nâng mình lên admin, không tự gán cờ nhạy cảm', async () => {
  // tạo vai trò "qt_phu" có user.view+user.update (không có cờ), đăng nhập người đó
  expect((await put(self, `/api/users/${selfId}`, { roleCode: 'admin' })).json().error.code).toBe('SELF_PRIVILEGE_CHANGE');
  expect((await put(self, `/api/users/${otherId}`, { sensitiveFlags: ['view_cost'] })).statusCode).toBe(403);
  expect((await put(self, `/api/users/${otherId}`, { roleCode: 'ketoan_vien' })).statusCode).toBe(200); // đối chứng
});
it('không bỏ kích hoạt hay hạ vai trò quản trị viên cuối cùng', async () => { /* LAST_ADMIN */ });
it('không đặt lại mật khẩu người dùng thuộc hai công ty', async () => { /* thêm tenant_user ở công ty B bằng admin → PUT password → USER_SHARED; mật khẩu cũ vẫn đăng nhập được */ });
it('vai trò admin không bị sửa quyền', async () => { /* SYSTEM_ROLE_LOCKED */ });
it('PUT /active cho người ngoài công ty trả 404', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Cài đặt; giao diện: khi sửa chính mình, ô vai trò/cờ bị khóa kèm chú thích. **Step 4:** `pnpm -F @kt/api test -- test/users.test.ts`, `pnpm -F @kt/web test -- test/Users.test.tsx` xanh.
- [ ] **Step 5:** Commit `fix(api): chặn tự nâng quyền, giữ quản trị viên cuối, không đặt lại mật khẩu người dùng nhiều công ty`.

### Task 7 (A6 + A8): RLS thành viên, `create_tenant` trả biến phiên, thu hẹp `ketoan_vien`

**Files:**
- Create: `packages/db/migrations/0018_rls_thanh_vien_vai_tro.sql`
- Test: `packages/db/test/rls.test.ts`, `apps/api/test/users.test.ts` (hoặc `closing.test.ts`/`financial.test.ts` cho quyền)

**Interfaces:**
- `DROP POLICY tenant_user_access ON tenant_user;` rồi: `tenant_user_select FOR SELECT USING (tenant_id = app_tenant() OR user_id = app_user_id())`; `tenant_user_insert FOR INSERT WITH CHECK (tenant_id = app_tenant())`; `tenant_user_update FOR UPDATE USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())`; `tenant_user_delete FOR DELETE USING (tenant_id = app_tenant())`.
- `create_tenant`: định nghĩa lại từ thân 0014; đầu hàm lưu `v_prev := current_setting('app.current_tenant', true)`, cuối hàm `PERFORM set_config('app.current_tenant', coalesce(v_prev, ''), true)`. Danh sách loại trừ của `ketoan_vien` thêm: `closing.run`, `closing_step.create`, `closing_step.update`, `closing_step.delete`, `report_def.create`, `report_def.update`, `report_def.delete`, `opening_balance.create`, `opening_balance.update`, `opening_balance.delete`. `ketoan_vien` giữ `.view`.
- Công ty đã có: xóa đúng các quyền trên khỏi vai trò `ketoan_vien` (tắt `trg_audit` của `role_permission` khi xóa bù như 0014).
- `user_tenant_count(p_user uuid) RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE`: số dòng `tenant_user` đang hoạt động của người đó; `GRANT EXECUTE … TO app_user`. (Dùng ở Task 6.)

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('thành viên nhiều công ty không xóa hay sửa được dòng tenant_user của công ty khác', async () => {
  // user U thuộc A và B; withTenant(db, { tenantId: A, userId: U }): DELETE FROM tenant_user WHERE tenant_id = B → 0 dòng; UPDATE … SET tenant_id = A WHERE tenant_id = B → 0 dòng
  // SELECT vẫn thấy dòng của U ở B (listTenantsOf cần)
});
it('create_tenant trả lại app.current_tenant của người gọi', async () => {
  // trong một giao dịch admin: set_config('app.current_tenant', A, true); SELECT create_tenant(...); current_setting('app.current_tenant') = A
});
it('công ty mới: ketoan_vien không có closing.run, closing_step.update, report_def.update, opening_balance.update; ketoan_truong có', async () => {});
```

- [ ] **Step 2:** FAIL. **Step 3:** Viết migration (lấy thân `create_tenant` hiện hành bằng `pg_get_functiondef`). **Step 4:** `pnpm db:migrate` dev; `pnpm -F @kt/db test` và `pnpm -F @kt/api test` xanh (sửa kiểm thử API đang dùng `ketoan_vien` để chạy kết chuyển nếu có: dùng `ketoan_truong`).
- [ ] **Step 5:** Tài liệu người dùng (bảng vai trò mặc định nếu có). Commit `fix(db): RLS thành viên tách đọc/ghi, create_tenant trả biến phiên, thu hẹp vai trò kế toán viên`.

### Task 8 (A9): Quy ước mã lỗi `*_NOT_FOUND`

**Files:**
- Modify: `apps/api/src/plugins/errors.ts`, các chỗ `AppError('…_NOT_FOUND', …, 409)` (hiện: `PERIOD_NOT_FOUND` "không thuộc kỳ kế toán nào đã mở", "Chưa mở năm tài chính nào", `CLOSING_STEP_NOT_FOUND`), kiểm thử đang kỳ vọng 409 cho các mã đó, `docs/superpowers/specs/2026-10-19-phan-mem-ke-toan-design.md` mục 13 (một dòng quy ước)
- Test: `apps/api/test/errors.test.ts`

**Interfaces:**
- Quy ước: mã kết thúc `_NOT_FOUND` luôn 404 (thứ được nêu tên không tồn tại hoặc không thấy được trong công ty), dù đến từ đường dẫn, thân yêu cầu hay `RAISE` trong SQL. Trạng thái không cho phép thao tác (kỳ khóa, chứng từ đã ghi sổ…) giữ 409 với mã riêng.
- `errors.ts`: nhánh `P0001` → `status = code.endsWith('_NOT_FOUND') ? 404 : 409`.

- [ ] **Step 1: Kiểm thử thất bại:**

```ts
it('P0001 mã *_NOT_FOUND từ SQL trả 404, mã khác 409', async () => { /* route thử ném { code: 'P0001', message: 'VOUCHER_NOT_FOUND: x' } và 'VOUCHER_POSTED: y' */ });
it('mọi AppError *_NOT_FOUND trong mã nguồn dùng 404', () => {
  // đọc đệ quy apps/api/src/**/*.ts, regex /AppError\('([A-Z_]+_NOT_FOUND)'[^;]*?,\s*(\d{3})\)/g → mọi nhóm 2 là '404'
});
```

- [ ] **Step 2:** FAIL. **Step 3:** Sửa. **Step 4:** `pnpm -F @kt/api test`, `pnpm -F @kt/web test` xanh (giao diện không phụ thuộc mã trạng thái các lỗi này: đã kiểm `Financial.tsx` dùng `error.code`).
- [ ] **Step 5:** Commit `fix(api): mã lỗi *_NOT_FOUND thống nhất 404`.

### Task 9 (A10): Khóa ngoại tổng hợp theo công ty

**Files:**
- Create: `packages/db/migrations/0019_khoa_ngoai_theo_cong_ty.sql`
- Modify: `CLAUDE.md` (một dòng trong "Quy tắc bất biến"), đặc tả mục 6 (một dòng)
- Test: `packages/db/test/rls.test.ts` (hoặc `fk.test.ts` mới)

**Interfaces:**
- Quy ước: khóa ngoại giữa hai bảng cùng có `tenant_id` là tổng hợp `(tenant_id, x_id) REFERENCES cha (tenant_id, id)`; bảng cha có `UNIQUE (tenant_id, id)`.
- Các FK đơn cột phải chuyển (lấy từ `pg_constraint` trên DB đã migrate 0018): `account_period_balance(account_id)`, `bank_account(bank_id)`, `closing_run(step_id)`, `closing_run(voucher_id)`, `cost_item(parent_id)`, `department(parent_id)`, `employee(department_id)`, `employee(party_id)`, `party(group_id)`, `party_bank_account(party_id)`, `project(parent_id)`, `project(party_id)`, `voucher(reversal_of_id)`, `voucher(reversed_by_id)`, `voucher_attachment(voucher_id)`, `voucher_line(voucher_id)`, `voucher_line_history(voucher_id)`, `voucher_pair(voucher_id)`, `voucher_pair(debit_account_id)`, `voucher_pair(credit_account_id)`. Giữ nguyên `ON DELETE`/`DEFERRABLE` của FK cũ (đọc `confdeltype`, `condeferrable`).
- `voucher_line` là bảng phân vùng: FK khai báo trên bảng gốc (PostgreSQL 16 lan xuống partition).

- [ ] **Step 1: Kiểm thử thất bại** (bất biến cho mọi bảng về sau):

```ts
it('mọi khóa ngoại giữa hai bảng có tenant_id đều gồm tenant_id', async () => {
  const r = await sql<{ fk: string }>`
    SELECT c.conname AS fk FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid::regclass::text NOT LIKE 'voucher_line_y%'
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'tenant_id')
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'tenant_id')
      AND c.confrelid <> 'tenant'::regclass
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) AND a.attname = 'tenant_id')`.execute(t.admin);
  expect(r.rows.map((x) => x.fk)).toEqual([]);
});
it('không tham chiếu được chứng từ của công ty khác', async () => { /* admin chèn voucher_attachment tenant A trỏ voucher của tenant B → lỗi 23503 */ });
```

- [ ] **Step 2:** FAIL (liệt kê ~20 FK). **Step 3:** Viết migration. **Step 4:** `pnpm db:migrate` trên DB dev có seed ABC/XYZ chạy được; `pnpm test` xanh.
- [ ] **Step 5:** Commit `fix(db): khóa ngoại tổng hợp (tenant_id, id) giữa các bảng theo công ty`.

### Task 10 (A11): Kiểm tra cân bằng một lần mỗi chứng từ mỗi giao dịch

**Files:**
- Create: `packages/db/migrations/0020_kiem_can_bang_theo_cau_lenh.sql`
- Modify: `apps/api/src/modules/ledger/vouchers.service.ts:22` (chỉ chú thích nếu giữ 5.000), `docs/user/giai-doan-1-so-cai.md` (đoạn "ghi sổ chậm" của số dư đầu kỳ nếu không còn đúng)
- Test: `packages/db/test/ledger-schema.test.ts`, `apps/api/test/vouchers.test.ts`

**Interfaces:**
- Bảng hàng đợi `voucher_balance_pending (tenant_id uuid NOT NULL, voucher_id uuid NOT NULL, PRIMARY KEY (tenant_id, voucher_id))`, RLS bật + `FORCE`, policy `tenant_id = app_tenant()`, `GRANT SELECT, INSERT, DELETE … TO app_user`.
- Ba trigger cấp câu lệnh trên `voucher_line` (bảng gốc phân vùng): `AFTER INSERT REFERENCING NEW TABLE AS nt`, `AFTER UPDATE REFERENCING OLD TABLE AS ot NEW TABLE AS nt`, `AFTER DELETE REFERENCING OLD TABLE AS ot`, cùng gọi hàm chèn `SELECT DISTINCT tenant_id, voucher_id` vào hàng đợi `ON CONFLICT DO NOTHING`.
- `CREATE CONSTRAINT TRIGGER trg_voucher_balance_pending AFTER INSERT ON voucher_balance_pending DEFERRABLE INITIALLY DEFERRED FOR EACH ROW`: `fn_check_voucher_balance(NEW.voucher_id)` rồi xóa dòng hàng đợi đó.
- `DROP TRIGGER trg_voucher_balanced ON voucher_line`. Giữ `trg_voucher_state_balanced` trên `voucher` và `fn_check_voucher_balance` không đổi.
- Giới hạn 5.000 dòng/chứng từ giữ nguyên (giới hạn tham số bind của một lần chèn, không còn vì O(n²)); số dư đầu kỳ giữ 20.000 dòng.

- [ ] **Step 1: Kiểm thử thất bại / hiệu năng:**

```ts
it('chứng từ 5.000 dòng tạo và ghi sổ dưới 5 giây', async () => { /* qua API, đo Date.now() quanh POST tạo + POST ghi sổ */ }, 60_000);
it('nhiều câu lệnh trong một giao dịch: lệch ở trạng thái cuối bị bắt, cân ở trạng thái cuối thì qua', async () => {
  // admin, một giao dịch: chèn 2 dòng cân, xóa 1 dòng, chèn lại dòng khác số tiền → COMMIT lỗi VOUCHER_UNBALANCED
  // giao dịch khác: chèn dòng lệch rồi chèn dòng bù → COMMIT thành công
});
it('đổi ngày chứng từ nháp sang tháng khác (dòng chuyển partition) vẫn kiểm cân bằng', async () => {});
it('hàng đợi rỗng sau mỗi giao dịch thành công', async () => { /* SELECT count(*) FROM voucher_balance_pending = 0 */ });
```

- [ ] **Step 2:** Chạy trên mã cũ: kiểm thử 5.000 dòng FAIL về thời gian (hiện ~18 giây). **Step 3:** Viết migration. **Step 4:** `pnpm -F @kt/db test`, `pnpm -F @kt/api test`, `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants` xanh; đo lại ghi sổ DK 6.002 dòng và ghi vào sổ quyết định.
- [ ] **Step 5:** Commit `perf(db): kiểm cân bằng một lần mỗi chứng từ bằng trigger cấp câu lệnh`.

### Task 11 (A12): Đo hiệu năng 100.000 dòng tái lập được

**Files:**
- Create: `apps/api/scripts/perf-100k.ts`, `docs/dev/hieu-nang.md`
- Modify: `apps/api/package.json` (script `perf:100k`)

**Interfaces:**
- `pnpm -F @kt/api perf:100k`: tạo DB tạm riêng (dùng lại hàm tạo DB của Task 1 nếu xuất được), tạo công ty TT133 năm 2026, sinh 100.000 dòng (≈ 25.000 chứng từ × 4 dòng, rải 12 tháng, 30 tài khoản lá, có đối tượng ở 131/331) bằng SQL qua hàm ghi sổ thật (không bỏ qua trigger), tính lại số dư, `VACUUM ANALYZE`, rồi đo qua `app.inject` 3 lần, lấy trung vị: Bảng cân đối số phát sinh năm, Nhật ký chung năm (bị cắt 50.000 dòng), Sổ Cái 1121 năm, `/api/balances`. In bảng ms, xóa DB tạm.
- `docs/dev/hieu-nang.md`: cách chạy, bảng kết quả trên VPS oracle (ngày, máy), ngưỡng nghiệm thu "BCĐPS năm < 2 giây".

- [ ] **Step 1:** Viết script; chạy; nếu BCĐPS năm ≥ 2 giây thì `EXPLAIN (ANALYZE, BUFFERS)`, thêm chỉ mục bằng migration 0021 và đo lại.
- [ ] **Step 2:** Ghi kết quả vào `docs/dev/hieu-nang.md`. Commit `perf(api): script đo hiệu năng 100.000 dòng và kết quả`.

### Kết thúc GĐ1.5

- [ ] Rà soát toàn nhánh (Opus) từ tag `gd1-hoan-tat` tới HEAD; một đợt sửa.
- [ ] `pnpm lint && pnpm typecheck && pnpm test`, `INVARIANTS=1 pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts`, `pnpm -F @kt/web e2e` xanh.
- [ ] `docs/user/`: đoạn đăng nhập/khóa tạm, vai trò mặc định; `docs/TIEP-THEO.md` mục 1 đánh dấu nhóm A xong; `docs/NHAT-KY-TIEN-DO.md`.
- [ ] Tag `gd1-5-hoan-tat`, push `main` và tag.

## Thứ tự thực hiện

T1 → T2 → T3 → T4 → T5 → T7 → T6 → T8 → T9 → T10 → T11 (T7 trước T6 vì T6 dùng `user_tenant_count`; số migration theo thứ tự thực hiện: T4 0016, T5 0017, T7 0018, T9 0019, T10 0020).
