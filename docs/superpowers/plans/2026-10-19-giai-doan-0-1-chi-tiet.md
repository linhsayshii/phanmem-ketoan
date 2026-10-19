# Kế hoạch thực hiện chi tiết: Giai đoạn 0 (Nền tảng) và Giai đoạn 1 (Lõi sổ cái)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng monorepo chạy được bằng `docker compose up` với đăng nhập, công ty, kỳ kế toán, hệ thống tài khoản đa chế độ, danh mục khung, nhật ký kiểm toán, sao lưu (GĐ0), rồi lõi sổ cái bất biến với Phiếu kế toán, khóa kỳ, số dư theo kỳ, kết chuyển, sổ sách và BCTC TT99/TT133 đủ cho doanh nghiệp dịch vụ không kho hạch toán cả năm (GĐ1).

**Architecture:** Modular monolith TypeScript: một API Fastify, một worker pg-boss, một web React, một PostgreSQL 16. Sổ cái là bảng `voucher`/`voucher_line` bất biến sau ghi sổ, mọi sửa đổi đi qua máy trạng thái (`post`/`unpost`/`reverse`/`discard`) cài bằng thủ tục PL/pgSQL và trigger; số dư theo kỳ là snapshot dẫn xuất (`account_period_balance`) được làm bẩn theo ngày hiệu lực và tính lại bằng worker; báo cáo tài chính, sơ đồ kết chuyển và quy tắc soát lỗi là dữ liệu, không phải mã. Đa thuê bao kiểu pool: `tenant_id` trên mọi bảng, `FORCE ROW LEVEL SECURITY`, API chạy bằng vai trò DB không phải owner.

**Tech Stack:** Node.js 22, TypeScript 5, pnpm 9, Fastify 5, Kysely 0.27 + `pg`, decimal.js, Zod, pg-boss 10, React 18 + Vite 5, TanStack Router/Query, Ant Design 5, AG Grid Community 33, ExcelJS, Playwright (PDF + E2E), Vitest + fast-check, Docker Compose, PostgreSQL 16, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-19-phan-mem-ke-toan-design.md` (đặc biệt mục 5.2, 6, 7, 13, 14). Lộ trình: `docs/superpowers/plans/2026-10-19-lo-trinh-thuc-hien.md` (phần "Ràng buộc toàn cục", "Giai đoạn 0", "Giai đoạn 1"). Tham khảo: `research_notes/Nghiệp vụ phần mềm kế toán/thiet-ke-so-cai.md` (Q1–Q3, Q6, Q7), `research_notes/Nghiệp vụ phần mềm kế toán/sunsoft-pro.md` (mục 6–7, 10.3, 11.1, 13).

## Global Constraints

- Tiền hạch toán VND: `NUMERIC(20,0)`; ngoại tệ `NUMERIC(20,4)`; tỷ giá `NUMERIC(20,10)`; không `float`, không `money`, không `number` của JavaScript cho tiền (driver `pg` trả `numeric` dạng chuỗi; tầng nghiệp vụ dùng `decimal.js`).
- Không `UPDATE`/`DELETE` dòng sổ cái đã ghi sổ; mọi sửa đổi theo máy trạng thái mục 7.1 của đặc tả; dòng cũ lưu `voucher_line_history`.
- Mọi bảng nghiệp vụ có `tenant_id uuid NOT NULL`; mọi `UNIQUE` có `tenant_id`; `ENABLE` + `FORCE ROW LEVEL SECURITY` với policy `tenant_id = app_tenant()`; API kết nối bằng vai trò `app_user` (không owner, không `BYPASSRLS`); `SET LOCAL` biến phiên trong transaction.
- Mọi chứng từ tự động (kết chuyển `KC`, phân bổ `PB`, số dư đầu kỳ `DK`) là chứng từ thật có số, ngày, người lập, `source_doc_type`/`source_doc_id`; chạy lại bằng đảo chứng từ cũ, không sửa đè.
- Tham số pháp lý theo ngày hiệu lực trong `legal_param(code, value, valid_from, valid_to, source)`; định nghĩa báo cáo (`report_def`/`report_line`), sơ đồ kết chuyển (`closing_step`), quy tắc soát lỗi (`data_check_rule`) là dữ liệu; chế độ kế toán gắn với năm tài chính (`fiscal_period.regime`).
- Tên nghiệp vụ trong giao diện và API dùng đúng tiếng Việt kế toán: Phiếu kế toán, Sổ Nhật ký chung, Sổ Cái, Sổ chi tiết tài khoản, Bảng cân đối số phát sinh, Báo cáo tình hình tài chính (B01-DN TT99), Bảng cân đối kế toán (B01-DNN TT133).
- Mỗi giai đoạn kết thúc bằng: `docker compose up` chạy được, bộ dữ liệu mẫu, kiểm thử bất biến xanh trong CI trên PostgreSQL thật, tài liệu người dùng ngắn.
- Số liệu TT 99/2025 (Phụ lục II hệ thống tài khoản, Phụ lục IV mẫu BCTC) phải nhập từ văn bản gốc và đối chiếu với `DesBC_*_99` của SUNSOFT; **không bịa danh mục**. Khi chưa có văn bản gốc, tác vụ liên quan ghi rõ trạng thái "chờ văn bản" và kiểm thử cấu trúc vẫn phải chạy.
- Thư mục `~/Downloads/SUNSOFTPRO` chứa dữ liệu khách hàng thật: chỉ trích các bảng danh mục/định nghĩa (`OrgDMTK`, `OrgDMTK_200`, `DesBC_*_99`, `DesBC_*_133`, `DesHT_*`, `DesDataErr`, `OrgDMCT`, `OrgDMTHUE`, `OrgDMHTTT`, `OrgDMNTE`) và **bỏ mọi cột số liệu** (`DU_DAU`, `DU_CUOI`, `KY_NAY`, `KY_TRUOC`, `LUY_KE`, `NAM_TRUOC`, `Q0..Q4`, `TIEN_*`) trước khi đưa vào repo; không đọc bảng `OrgCT*`, `OrgDauKy*`, `Tmp*`.
- Commit nhỏ theo Conventional Commits (`feat`, `fix`, `test`, `chore`, `docs`, `refactor`) với scope là gói/ứng dụng: `db`, `domain`, `coa-data`, `ui`, `api`, `worker`, `web`, `ci`, `deps`. Mô tả bằng tiếng Việt không dấu câu cuối.
- Tất cả lệnh chạy từ gốc repo `/Users/linhsayshii/Documents/PetProject/phanmem-ketoan` trừ khi ghi khác. Kiểm thử cần DB chạy `docker compose up -d postgres` trước; biến môi trường trong `.env` (sao từ `.env.example`).

---

## Cấu trúc file monorepo

```
phanmem-ketoan/
├── .github/workflows/ci.yml           # lint, typecheck, test (Postgres service), e2e
├── .env.example                        # DATABASE_URL, DATABASE_ADMIN_URL, SESSION_SECRET, BACKUP_DIR, PORT
├── .gitignore  .nvmrc  .editorconfig  .npmrc
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  vitest.workspace.ts  eslint.config.js
├── docker-compose.yml                  # postgres, api, worker, web; volume pgdata, backups
├── docker/
│   ├── postgres/init/01-roles.sql      # tạo vai trò app_user (cluster-level, chạy 1 lần khi khởi tạo volume)
│   ├── api.Dockerfile  worker.Dockerfile  web.Dockerfile
│   └── restore.sh                      # phục hồi từ file pg_dump
├── packages/
│   ├── db/                             # @kt/db — migration SQL, bộ chạy migration, Kysely types, withTenant, helper kiểm thử
│   │   ├── migrations/0001_nen_tang.sql ... 0012_*.sql
│   │   ├── src/{index,client,migrate,types,testing}.ts
│   │   ├── src/seed/{demo-abc.ts,dich-vu-xyz.ts,expected-bctc-xyz.json}
│   │   └── test/{migrate,rls,...}.test.ts
│   ├── domain/                         # @kt/domain — quy tắc thuần, không I/O
│   │   ├── src/{money,format,permissions,period,voucherState,numbering,accountCode,coaTemplate,reportFormula,gridKeyboard,index}.ts
│   │   └── test/*.test.ts
│   ├── coa-data/                       # @kt/coa-data — dữ liệu mẫu theo chế độ (CSV/JSON) + script trích SUNSOFT
│   │   ├── data/coa/{tt133,tt200,tt99}.csv
│   │   ├── data/reports/{tt99,tt133}/{B01,B02,B03}.csv
│   │   ├── data/closing-steps/default.json
│   │   ├── reference/sunsoft/*.csv     # bản trích đã lọc cột số liệu
│   │   ├── scripts/extract-sunsoft.sh
│   │   └── src/{index,load}.ts  test/*.test.ts
│   └── ui/                             # @kt/ui — thành phần React dùng chung
│       ├── src/{KeyboardGrid,LookupSelect,VnNumberInput,useRememberedFilter,index}.tsx
│       └── test/*.test.tsx
├── apps/
│   ├── api/                            # @kt/api — Fastify
│   │   ├── src/{server,app,config,cli}.ts
│   │   ├── src/plugins/{db,auth,errors}.ts
│   │   ├── src/modules/auth/{service,routes}.ts
│   │   ├── src/modules/core/{tenants,fiscalYears,settings,users,roles}.ts
│   │   ├── src/modules/coa/{service,routes}.ts
│   │   ├── src/modules/master/{catalogs,crud,routes,importExcel}.ts
│   │   ├── src/modules/audit/routes.ts
│   │   ├── src/modules/ledger/{vouchers.service,vouchers.routes,periods.service,periods.routes,numbering,openingBalance,balances,closing}.ts
│   │   ├── src/modules/reporting/{ledgers,financial,routes}.ts  src/modules/reporting/print/{html,pdf,excel,templates}.ts
│   │   ├── src/modules/tools/{dataCheck,exportAuthority,routes}.ts
│   │   └── test/{helpers.ts,*.test.ts}  test/invariants/*.test.ts
│   ├── worker/                         # @kt/worker — pg-boss
│   │   └── src/{index,boss}.ts  src/jobs/{backup,recomputeBalances}.ts  test/*.test.ts
│   └── web/                            # @kt/web — React + Vite + Ant Design
│       ├── src/{main,router,api/client}.tsx
│       ├── src/pages/{Login,Users,CompanyWizard,Accounts,Catalog,ImportExcel,AuditLog,Voucher,VoucherList,OpeningBalance,Periods,Closing,Ledgers,Financial,DataCheck,Export}.tsx
│       ├── test/*.test.tsx
│       └── e2e/{phieu-ke-toan.spec.ts,in-so.spec.ts}  playwright.config.ts
└── docs/{user/*.md, superpowers/...}
```

Quy ước chung dùng xuyên suốt (mọi tác vụ phải theo):

- Tên gói: `@kt/db`, `@kt/domain`, `@kt/coa-data`, `@kt/ui`, `@kt/api`, `@kt/worker`, `@kt/web`. Chạy test một gói: `pnpm -F @kt/<tên> test -- <đường dẫn test>`; toàn bộ: `pnpm test`.
- Biến môi trường: `DATABASE_URL=postgres://app_user:app_pass@localhost:5432/ketoan` (API/worker/test), `DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/ketoan` (migration, seed, helper kiểm thử).
- Biến phiên PostgreSQL: `app.current_tenant` (uuid), `app.current_user` (uuid), `app.client_ip` (text); hàm SQL `app_tenant()`, `app_user_id()`.
- Số tiền đi qua API dưới dạng **chuỗi số thập phân** (`"1500000"`), ngày dạng ISO `YYYY-MM-DD`; giao diện định dạng kiểu Việt Nam (`1.500.000`, `dd/MM/yyyy`).
- Lỗi API: HTTP 4xx với body `{ "error": { "code": "VOUCHER_UNBALANCED", "message": "Chứng từ không cân" } }`; lỗi từ PostgreSQL `RAISE EXCEPTION ... USING ERRCODE='P0001', MESSAGE='<CODE>: <thông điệp>'` được plugin `errors` dịch sang dạng trên (tách bằng dấu hai chấm đầu tiên).
- Kiểm thử DB dùng `setupTestDb()` từ `@kt/db/testing`; mỗi file test tạo tenant riêng bằng `createTestTenant()` nên không cần dọn dữ liệu.
- Mọi migration là một file SQL chạy trong một transaction, tên `NNNN_mo_ta.sql`, không sửa file đã commit; thêm bảng mới thì gọi `SELECT rls_enable('<bảng>')` và `SELECT audit_enable('<bảng>')` (với bảng danh mục/cấu hình) ngay trong file.

---

# GIAI ĐOẠN 0: NỀN TẢNG

### Task 1: Khởi tạo git, monorepo pnpm, Docker Compose, CI

**Files:**
- Create: `.gitignore`, `.nvmrc`, `.npmrc`, `.editorconfig`, `.env.example`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `eslint.config.js`
- Create: `docker-compose.yml`, `docker/postgres/init/01-roles.sql`, `docker/api.Dockerfile`, `docker/worker.Dockerfile`, `docker/web.Dockerfile`
- Create: `packages/domain/package.json`, `packages/domain/tsconfig.json`, `packages/domain/src/index.ts`, `packages/domain/test/smoke.test.ts`
- Create: `.github/workflows/ci.yml`
- Test: `packages/domain/test/smoke.test.ts`

**Interfaces:**
- Consumes: không có.
- Produces: khung workspace; lệnh `pnpm lint`, `pnpm typecheck`, `pnpm test`; dịch vụ `postgres` tại `localhost:5432` với DB `ketoan`, vai trò `postgres/postgres` (owner) và `app_user/app_pass` (ứng dụng).

- [ ] **Step 1: Khởi tạo git và commit tài liệu hiện có**

```bash
cd /Users/linhsayshii/Documents/PetProject/phanmem-ketoan
git init -b main
cat > .gitignore <<'EOF'
node_modules/
dist/
coverage/
.env
*.log
backups/
apps/web/test-results/
apps/web/playwright-report/
.DS_Store
EOF
git add .gitignore README.md docs reports research_notes
git commit -m "docs: thêm đặc tả, lộ trình và ghi chú nghiên cứu"
```

Expected: `git log --oneline` hiển thị 1 commit.

- [ ] **Step 2: Cài pnpm và tạo file cấu hình workspace**

```bash
corepack enable && corepack prepare pnpm@9.12.0 --activate
pnpm --version   # 9.12.0
echo "22" > .nvmrc
printf 'shamefully-hoist=false\nstrict-peer-dependencies=false\n' > .npmrc
cat > .editorconfig <<'EOF'
root = true
[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
EOF
cat > .env.example <<'EOF'
DATABASE_URL=postgres://app_user:app_pass@localhost:5432/ketoan
DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/ketoan
SESSION_SECRET=doi-chuoi-nay-khi-trien-khai
SESSION_TTL_HOURS=12
COOKIE_SECURE=false
PORT=3000
BACKUP_DIR=./backups
WEB_ORIGIN=http://localhost:5173
EOF
cp .env.example .env
```

`package.json` (gốc):

```json
{
  "name": "phanmem-ketoan",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "lint": "eslint .",
    "typecheck": "pnpm -r --parallel typecheck",
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "pnpm -r build",
    "db:migrate": "pnpm -F @kt/db migrate",
    "db:seed:abc": "pnpm -F @kt/db seed:abc"
  },
  "devDependencies": {
    "@eslint/js": "^9.12.0",
    "@types/node": "^22.7.5",
    "eslint": "^9.12.0",
    "typescript": "^5.6.3",
    "typescript-eslint": "^8.8.1",
    "vitest": "^2.1.2"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`vitest.workspace.ts`:

```ts
export default ['packages/*', 'apps/api', 'apps/worker', 'apps/web'];
```

`eslint.config.js`:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
```

- [ ] **Step 3: Tạo gói `@kt/domain` tối thiểu với một test khói (để xác nhận chuỗi công cụ chạy)**

`packages/domain/package.json`:

```json
{
  "name": "@kt/domain",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "decimal.js": "^10.4.3", "zod": "^3.23.8" },
  "devDependencies": { "fast-check": "^3.22.0" }
}
```

`packages/domain/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

`packages/domain/src/index.ts`:

```ts
export const DOMAIN_VERSION = '0.0.1';
```

`packages/domain/test/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DOMAIN_VERSION } from '../src/index.js';

describe('khói', () => {
  it('gói domain nạp được', () => {
    expect(DOMAIN_VERSION).toBe('0.0.1');
  });
});
```

- [ ] **Step 4: Cài phụ thuộc và chạy test khói**

Run: `pnpm install && pnpm test`
Expected: `✓ packages/domain/test/smoke.test.ts (1 test)`; `pnpm lint` và `pnpm typecheck` kết thúc mã 0.

- [ ] **Step 5: Viết Docker Compose và file khởi tạo vai trò**

`docker/postgres/init/01-roles.sql`:

```sql
-- Chạy một lần khi khởi tạo volume. Vai trò ứng dụng: không owner, không BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_pass' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
GRANT CONNECT ON DATABASE ketoan TO app_user;
```

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: ketoan
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d ketoan"]
      interval: 5s
      timeout: 3s
      retries: 20

  api:
    build: { context: ., dockerfile: docker/api.Dockerfile }
    environment:
      DATABASE_URL: postgres://app_user:app_pass@postgres:5432/ketoan
      DATABASE_ADMIN_URL: postgres://postgres:postgres@postgres:5432/ketoan
      SESSION_SECRET: ${SESSION_SECRET:-doi-chuoi-nay-khi-trien-khai}
      SESSION_TTL_HOURS: "12"
      COOKIE_SECURE: "false"
      PORT: "3000"
      WEB_ORIGIN: http://localhost:8080
    ports: ["3000:3000"]
    depends_on:
      postgres: { condition: service_healthy }
    command: ["sh", "-c", "node packages/db/dist/migrate-cli.js && node apps/api/dist/server.js"]

  worker:
    build: { context: ., dockerfile: docker/worker.Dockerfile }
    environment:
      DATABASE_URL: postgres://app_user:app_pass@postgres:5432/ketoan
      DATABASE_ADMIN_URL: postgres://postgres:postgres@postgres:5432/ketoan
      BACKUP_DIR: /backups
      BACKUP_CRON: "0 2 * * *"
      BACKUP_KEEP: "14"
    volumes:
      - backups:/backups
    depends_on:
      postgres: { condition: service_healthy }

  web:
    build: { context: ., dockerfile: docker/web.Dockerfile }
    ports: ["8080:80"]
    depends_on: [api]

volumes:
  pgdata:
  backups:
```

`docker/api.Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @kt/api... --filter @kt/db...
RUN pnpm -r --filter @kt/api... --filter @kt/db... build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-dejavu fonts-liberation && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
```

`docker/worker.Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN pnpm install --frozen-lockfile --filter @kt/worker... && pnpm -r --filter @kt/worker... build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
CMD ["node", "apps/worker/dist/index.js"]
```

`docker/web.Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @kt/web... && pnpm -F @kt/web build

FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

(`apps/web/nginx.conf` được tạo ở Task 4b; Dockerfile web chỉ build được từ Task 4b trở đi. `packages/db/dist/migrate-cli.js` tạo ở Task 2.)

- [ ] **Step 6: Khởi động PostgreSQL và xác nhận vai trò**

Run: `docker compose up -d postgres && sleep 5 && docker compose exec postgres psql -U postgres -d ketoan -c "\du app_user"`
Expected: dòng `app_user | No inheritance` (không có Superuser, không Bypass RLS).

- [ ] **Step 7: Viết CI**

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-24.04
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_USER: postgres, POSTGRES_PASSWORD: postgres, POSTGRES_DB: ketoan }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres -d ketoan" --health-interval 5s --health-timeout 3s --health-retries 20
    env:
      DATABASE_URL: postgres://app_user:app_pass@localhost:5432/ketoan
      DATABASE_ADMIN_URL: postgres://postgres:postgres@localhost:5432/ketoan
      SESSION_SECRET: ci-secret
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: sudo apt-get update && sudo apt-get install -y postgresql-client-16
      - run: psql "$DATABASE_ADMIN_URL" -f docker/postgres/init/01-roles.sql
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm db:migrate
      - run: pnpm test
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: khởi tạo monorepo pnpm, docker compose và CI"
```

---

### Task 2: Gói `@kt/db`: bộ chạy migration, kết nối, `withTenant`, migration nền và RLS

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`
- Create: `packages/db/src/migrate.ts`, `packages/db/src/migrate-cli.ts`, `packages/db/src/client.ts`, `packages/db/src/types.ts`, `packages/db/src/testing.ts`, `packages/db/src/index.ts`
- Create: `packages/db/migrations/0001_nen_tang.sql`
- Test: `packages/db/test/migrate.test.ts`, `packages/db/test/rls.test.ts`

**Interfaces:**
- Consumes: DB từ Task 1.
- Produces:
  - `migrate(adminUrl: string, dir?: string): Promise<string[]>` (tên migration vừa áp dụng).
  - `createPool(url: string): pg.Pool`; `createDb(pool: pg.Pool): Kysely<Database>`.
  - `interface TenantCtx { tenantId: string; userId?: string; ip?: string }`; `withTenant<T>(db, ctx, fn: (trx: Transaction<Database>) => Promise<T>): Promise<T>`.
  - `setupTestDb(): Promise<TestDb>` với `TestDb = { admin: Kysely<Database>; db: Kysely<Database>; close(): Promise<void> }`; `createTestTenant(admin, input: {code: string; name: string}): Promise<string>`; `createTestUser(admin, input: {username: string; passwordHash: string}): Promise<string>`; `newId(): string` (uuid v4).
  - Bảng: `tenant`, `app_user`, `permission`, `role`, `role_permission`, `tenant_user`, `user_session`, `login_event`, `audit_event`, `legal_param`, `fiscal_period`, `account`, `coa_template`, `tenant_setting`, `user_pref`, `schema_migration`.
  - Hàm SQL: `app_tenant()`, `app_user_id()`, `rls_enable(regclass)`, `audit_enable(regclass)`, `fn_audit_row()`, `create_tenant(p_code, p_name, p_tax_code, p_owner_user) RETURNS uuid` (SECURITY DEFINER).

- [ ] **Step 1: Khai báo gói và viết test cho bộ chạy migration (thất bại)**

`packages/db/package.json`:

```json
{
  "name": "@kt/db",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./src/index.ts", "import": "./src/index.ts" },
    "./testing": { "types": "./src/testing.ts", "import": "./src/testing.ts" }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json && cp -r migrations dist/",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "migrate": "tsx src/migrate-cli.ts",
    "seed:abc": "tsx src/seed/demo-abc.ts",
    "seed:xyz": "tsx src/seed/dich-vu-xyz.ts"
  },
  "dependencies": { "@kt/domain": "workspace:*", "kysely": "^0.27.4", "pg": "^8.13.0", "dotenv": "^16.4.5" },
  "devDependencies": { "@types/pg": "^8.11.10", "tsx": "^4.19.1" }
}
```

`packages/db/tsconfig.json`: giống `packages/domain/tsconfig.json`.

`packages/db/test/migrate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '../src/migrate.js';

const adminUrl = process.env.DATABASE_ADMIN_URL!;

describe('migrate', () => {
  it('áp dụng migration một lần và ghi vào schema_migration', async () => {
    const first = await migrate(adminUrl);
    const second = await migrate(adminUrl);
    expect(second).toEqual([]);
    const pool = new pg.Pool({ connectionString: adminUrl });
    const r = await pool.query('SELECT name FROM schema_migration ORDER BY name');
    await pool.end();
    expect(r.rows.map((x) => x.name)).toEqual(expect.arrayContaining(['0001_nen_tang.sql']));
    expect(first.length + 0).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm install && pnpm -F @kt/db test -- test/migrate.test.ts`
Expected: FAIL `Cannot find module '../src/migrate.js'`.

- [ ] **Step 3: Viết bộ chạy migration, CLI, client, types, testing**

`packages/db/src/migrate.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const defaultDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(adminUrl: string, dir: string = defaultDir): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query('SELECT name FROM schema_migration')).rows.map((r) => r.name as string));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sqlText = await readFile(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sqlText);
        await client.query('INSERT INTO schema_migration(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} thất bại: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    await client.end();
  }
  return applied;
}
```

`packages/db/src/migrate-cli.ts`:

```ts
import 'dotenv/config';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('Thiếu DATABASE_ADMIN_URL');
const applied = await migrate(url);
console.log(applied.length ? `Đã áp dụng: ${applied.join(', ')}` : 'Không có migration mới');
```

`packages/db/src/client.ts`:

```ts
import pg from 'pg';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import type { Database } from './types.js';

// numeric (1700) và int8 (20) giữ nguyên dạng chuỗi: không bao giờ để driver ép sang number.
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => v);
pg.types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD'

export interface TenantCtx {
  tenantId: string;
  userId?: string;
  ip?: string;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export async function withTenant<T>(
  db: Kysely<Database>,
  ctx: TenantCtx,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.current_tenant', ${ctx.tenantId}, true),
                     set_config('app.current_user', ${ctx.userId ?? ''}, true),
                     set_config('app.client_ip', ${ctx.ip ?? ''}, true)`.execute(trx);
    return fn(trx);
  });
}
```

`packages/db/src/types.ts` (phần nền; các task sau nối thêm bảng vào `Database`):

```ts
import type { ColumnType, Generated, JSONColumnType } from 'kysely';

export type Numeric = ColumnType<string, string | number, string | number>;
export type Timestamp = ColumnType<string, string | Date | undefined, string | Date>;
export type DateOnly = ColumnType<string, string, string>;

export interface TenantTable {
  id: Generated<string>;
  code: string;
  name: string;
  tax_code: string | null;
  address: string | null;
  legal_rep: string | null;
  chief_accountant: string | null;
  phone: string | null;
  email: string | null;
  created_at: Generated<string>;
}
export interface AppUserTable {
  id: Generated<string>;
  username: string;
  full_name: string;
  password_hash: string;
  is_active: Generated<boolean>;
  created_at: Generated<string>;
}
export interface PermissionTable { code: string; name: string; group_name: string }
export interface RoleTable { id: Generated<string>; tenant_id: string; code: string; name: string; is_system: Generated<boolean> }
export interface RolePermissionTable { tenant_id: string; role_id: string; permission_code: string }
export interface TenantUserTable {
  tenant_id: string; user_id: string; role_id: string;
  sensitive_flags: JSONColumnType<string[]>; is_active: Generated<boolean>;
}
export interface UserSessionTable { id: Generated<string>; user_id: string; tenant_id: string | null; expires_at: Timestamp; created_at: Generated<string>; ip: string | null }
export interface LoginEventTable { id: Generated<string>; ts: Generated<string>; username: string; user_id: string | null; success: boolean; ip: string | null }
export interface AuditEventTable {
  id: Generated<string>; tenant_id: string; ts: Generated<string>; user_id: string | null;
  action: string; entity: string; entity_id: string; before: JSONColumnType<unknown> | null; after: JSONColumnType<unknown> | null; ip: string | null;
}
export interface LegalParamTable { id: Generated<number>; code: string; value: JSONColumnType<unknown>; valid_from: DateOnly; valid_to: DateOnly | null; source: string }
export interface FiscalPeriodTable {
  id: Generated<number>; tenant_id: string; fiscal_year: number; period_no: number;
  date_from: DateOnly; date_to: DateOnly; regime: string; status: Generated<string>;
}
export interface AccountTable {
  id: Generated<number>; tenant_id: string; regime: string; code: string; name: string; name_en: string | null;
  parent_id: number | null; is_group: Generated<boolean>; root_type: string; normal_balance: string;
  track_currency: Generated<boolean>; subledger_kind: string | null; reconcile: Generated<boolean>; is_active: Generated<boolean>;
}
export interface CoaTemplateTable {
  regime: string; code: string; name: string; name_en: string | null; parent_code: string | null; is_group: boolean;
  root_type: string; normal_balance: string; track_currency: boolean; subledger_kind: string | null; source: string;
}
export interface TenantSettingTable { tenant_id: string; key: string; value: JSONColumnType<unknown>; updated_at: Generated<string> }
export interface UserPrefTable { user_id: string; tenant_id: string; key: string; value: JSONColumnType<unknown> }

export interface Database {
  tenant: TenantTable;
  app_user: AppUserTable;
  permission: PermissionTable;
  role: RoleTable;
  role_permission: RolePermissionTable;
  tenant_user: TenantUserTable;
  user_session: UserSessionTable;
  login_event: LoginEventTable;
  audit_event: AuditEventTable;
  legal_param: LegalParamTable;
  fiscal_period: FiscalPeriodTable;
  account: AccountTable;
  coa_template: CoaTemplateTable;
  tenant_setting: TenantSettingTable;
  user_pref: UserPrefTable;
}
```

`packages/db/src/testing.ts`:

```ts
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { createDb, createPool } from './client.js';
import { migrate } from './migrate.js';
import type { Database } from './types.js';

export interface TestDb { admin: Kysely<Database>; db: Kysely<Database>; close(): Promise<void> }

export const newId = (): string => randomUUID();

export async function setupTestDb(): Promise<TestDb> {
  const adminUrl = process.env.DATABASE_ADMIN_URL!;
  const appUrl = process.env.DATABASE_URL!;
  await migrate(adminUrl);
  const adminPool = createPool(adminUrl);
  const appPool = createPool(appUrl);
  return {
    admin: createDb(adminPool),
    db: createDb(appPool),
    close: async () => { await adminPool.end(); await appPool.end(); },
  };
}

export async function createTestUser(admin: Kysely<Database>, input: { username: string; passwordHash: string }): Promise<string> {
  const r = await admin.insertInto('app_user')
    .values({ username: input.username, full_name: input.username, password_hash: input.passwordHash })
    .returning('id').executeTakeFirstOrThrow();
  return r.id;
}

export async function createTestTenant(admin: Kysely<Database>, input: { code: string; name: string; ownerUserId?: string }): Promise<string> {
  const owner = input.ownerUserId ?? (await createTestUser(admin, { username: `u_${input.code}_${newId().slice(0, 8)}`, passwordHash: 'x' }));
  const r = await sql<{ id: string }>`SELECT create_tenant(${input.code}, ${input.name}, NULL, ${owner}::uuid) AS id`.execute(admin);
  return r.rows[0]!.id;
}
```

`packages/db/src/index.ts`:

```ts
export * from './types.js';
export { createPool, createDb, withTenant, type TenantCtx } from './client.js';
export { migrate } from './migrate.js';
```

- [ ] **Step 4: Viết migration nền `0001_nen_tang.sql`**

```sql
-- 0001_nen_tang.sql: biến phiên, RLS, audit, bảng nền. Chạy bằng owner (postgres).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

GRANT USAGE ON SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app_user;

CREATE OR REPLACE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.current_tenant', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.current_user', true), '')::uuid $$;

-- Bật RLS chuẩn cho một bảng có cột tenant_id.
CREATE OR REPLACE FUNCTION rls_enable(t regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
END $$;

-- ===== Bảng toàn cục (không tenant) =====
CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  full_name text NOT NULL,
  password_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE permission (code text PRIMARY KEY, name text NOT NULL, group_name text NOT NULL);
REVOKE INSERT, UPDATE, DELETE ON permission FROM app_user;

CREATE TABLE legal_param (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL, value jsonb NOT NULL,
  valid_from date NOT NULL, valid_to date,
  source text NOT NULL,
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX ON legal_param (code, valid_from);
REVOKE INSERT, UPDATE, DELETE ON legal_param FROM app_user;

CREATE TABLE coa_template (
  regime text NOT NULL CHECK (regime IN ('TT99','TT133','TT200','TT58')),
  code text NOT NULL, name text NOT NULL, name_en text,
  parent_code text, is_group boolean NOT NULL DEFAULT false,
  root_type text NOT NULL CHECK (root_type IN ('asset','liability','equity','income','expense','off_balance')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit','credit','both')),
  track_currency boolean NOT NULL DEFAULT false,
  subledger_kind text CHECK (subledger_kind IN ('receivable','payable','inventory','fixed_asset','bank','cash')),
  source text NOT NULL,
  PRIMARY KEY (regime, code)
);
REVOKE INSERT, UPDATE, DELETE ON coa_template FROM app_user;

CREATE TABLE user_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id),
  tenant_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ip text
);
CREATE INDEX ON user_session (user_id);
CREATE TABLE login_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  username text NOT NULL, user_id uuid, success boolean NOT NULL, ip text
);
REVOKE UPDATE, DELETE ON login_event FROM app_user;

-- ===== Bảng theo tenant =====
CREATE TABLE tenant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  tax_code text, address text, legal_rep text, chief_accountant text, phone text, email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, is_system boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, code)
);
CREATE TABLE role_permission (
  tenant_id uuid NOT NULL, role_id uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permission(code),
  PRIMARY KEY (tenant_id, role_id, permission_code)
);
CREATE TABLE tenant_user (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  role_id uuid NOT NULL REFERENCES role(id),
  sensitive_flags jsonb NOT NULL DEFAULT '[]',
  is_active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE audit_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  ts timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  action text NOT NULL,        -- 'insert'|'update'|'delete'|'post'|'unpost'|'reverse'|'discard'|'lock'|'unlock'|'login'...
  entity text NOT NULL, entity_id text NOT NULL,
  before jsonb, after jsonb, ip text
);
CREATE INDEX ON audit_event (tenant_id, ts DESC);
CREATE INDEX ON audit_event (tenant_id, entity, entity_id);
REVOKE UPDATE, DELETE ON audit_event FROM app_user;

CREATE TABLE fiscal_period (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  fiscal_year int NOT NULL, period_no int NOT NULL CHECK (period_no BETWEEN 0 AND 15),  -- 0 = kỳ mở sổ
  date_from date NOT NULL, date_to date NOT NULL CHECK (date_to >= date_from),
  regime text NOT NULL CHECK (regime IN ('TT99','TT133','TT200','TT58')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','soft_locked','hard_locked')),
  UNIQUE (tenant_id, fiscal_year, period_no)
);
CREATE INDEX ON fiscal_period (tenant_id, date_from, date_to);

CREATE TABLE account (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  regime text NOT NULL,
  code text NOT NULL, name text NOT NULL, name_en text,
  parent_id bigint REFERENCES account(id),
  is_group boolean NOT NULL DEFAULT false,
  root_type text NOT NULL CHECK (root_type IN ('asset','liability','equity','income','expense','off_balance')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit','credit','both')),
  track_currency boolean NOT NULL DEFAULT false,
  subledger_kind text CHECK (subledger_kind IN ('receivable','payable','inventory','fixed_asset','bank','cash')),
  reconcile boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, regime, code)
);
CREATE INDEX ON account (tenant_id, parent_id);

CREATE TABLE tenant_setting (
  tenant_id uuid NOT NULL REFERENCES tenant(id), key text NOT NULL, value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
CREATE TABLE user_pref (
  user_id uuid NOT NULL REFERENCES app_user(id), tenant_id uuid NOT NULL, key text NOT NULL, value jsonb NOT NULL,
  PRIMARY KEY (user_id, tenant_id, key)
);

-- ===== Audit trigger dùng chung =====
CREATE OR REPLACE FUNCTION fn_audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_tenant uuid; v_id text; v_before jsonb; v_after jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN v_before := to_jsonb(OLD); v_tenant := OLD.tenant_id; v_id := (to_jsonb(OLD)->>'id');
  ELSIF TG_OP = 'INSERT' THEN v_after := to_jsonb(NEW); v_tenant := NEW.tenant_id; v_id := (to_jsonb(NEW)->>'id');
  ELSE v_before := to_jsonb(OLD); v_after := to_jsonb(NEW); v_tenant := NEW.tenant_id; v_id := (to_jsonb(NEW)->>'id');
    IF v_before = v_after THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, after, ip)
  VALUES (v_tenant, app_user_id(), lower(TG_OP), TG_TABLE_NAME, coalesce(v_id, ''), v_before, v_after,
          nullif(current_setting('app.client_ip', true), ''));
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION audit_enable(t regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON %s', t);
  EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION fn_audit_row()', t);
END $$;

-- ===== RLS =====
SELECT rls_enable(t) FROM unnest(ARRAY['role','role_permission','audit_event','fiscal_period','account','tenant_setting','user_pref']::regclass[]) AS t;

ALTER TABLE tenant ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenant USING (id = app_tenant() OR EXISTS (
  SELECT 1 FROM tenant_user tu WHERE tu.tenant_id = tenant.id AND tu.user_id = app_user_id()));
CREATE POLICY tenant_self_update ON tenant FOR UPDATE USING (id = app_tenant()) WITH CHECK (id = app_tenant());

ALTER TABLE tenant_user ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_user FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_user_access ON tenant_user USING (tenant_id = app_tenant() OR user_id = app_user_id())
  WITH CHECK (tenant_id = app_tenant());

ALTER TABLE user_session ENABLE ROW LEVEL SECURITY; ALTER TABLE user_session FORCE ROW LEVEL SECURITY;
CREATE POLICY session_all ON user_session USING (true) WITH CHECK (true);  -- tra cứu theo id phiên trước khi biết user

SELECT audit_enable(t) FROM unnest(ARRAY['role','role_permission','tenant_user','account','tenant_setting']::regclass[]) AS t;

-- ===== Tạo công ty: SECURITY DEFINER vì chưa có app.current_tenant lúc tạo =====
CREATE OR REPLACE FUNCTION create_tenant(p_code text, p_name text, p_tax_code text, p_owner_user uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_admin_role uuid;
BEGIN
  INSERT INTO tenant(code, name, tax_code) VALUES (p_code, p_name, p_tax_code) RETURNING id INTO v_tenant;
  PERFORM set_config('app.current_tenant', v_tenant::text, true);
  INSERT INTO role(tenant_id, code, name, is_system) VALUES
    (v_tenant, 'admin', 'Quản trị', true), (v_tenant, 'ketoan_truong', 'Kế toán trưởng', true),
    (v_tenant, 'ketoan_vien', 'Kế toán viên', true), (v_tenant, 'xem', 'Chỉ xem', true);
  SELECT id INTO v_admin_role FROM role WHERE tenant_id = v_tenant AND code = 'admin';
  INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT v_tenant, v_admin_role, code FROM permission;
  INSERT INTO role_permission(tenant_id, role_id, permission_code)
    SELECT v_tenant, r.id, p.code FROM role r CROSS JOIN permission p
    WHERE r.tenant_id = v_tenant AND r.code = 'ketoan_truong' AND p.code NOT LIKE 'user.%' AND p.code NOT LIKE 'role.%';
  INSERT INTO role_permission(tenant_id, role_id, permission_code)
    SELECT v_tenant, r.id, p.code FROM role r CROSS JOIN permission p
    WHERE r.tenant_id = v_tenant AND r.code = 'ketoan_vien'
      AND p.code NOT LIKE 'user.%' AND p.code NOT LIKE 'role.%' AND p.code NOT LIKE 'period.%'
      AND p.code NOT LIKE '%.unpost' AND p.code NOT IN ('voucher.edit_posted','voucher.backdate_locked','voucher.renumber','export.authority','backup.run','setting.update','company.update');
  INSERT INTO role_permission(tenant_id, role_id, permission_code)
    SELECT v_tenant, r.id, p.code FROM role r CROSS JOIN permission p
    WHERE r.tenant_id = v_tenant AND r.code = 'xem' AND (p.code LIKE '%.view' OR p.code LIKE '%.print');
  INSERT INTO tenant_user(tenant_id, user_id, role_id, sensitive_flags)
    VALUES (v_tenant, p_owner_user, v_admin_role, '["view_cost","view_receivable","view_payable","view_salary"]');
  RETURN v_tenant;
END $$;
REVOKE ALL ON FUNCTION create_tenant(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_tenant(text, text, text, uuid) TO app_user;
```

Lưu ý: bảng `permission` được nạp dữ liệu ở Task 4a (migration `0002`), nên `create_tenant` trong Task 2 tạo vai trò nhưng chưa có quyền; test ở bước 6 không phụ thuộc quyền.

- [ ] **Step 5: Chạy test migrate**

Run: `pnpm -F @kt/db test -- test/migrate.test.ts`
Expected: PASS; `psql "$DATABASE_ADMIN_URL" -c "\dt"` liệt kê 16 bảng.

- [ ] **Step 6: Viết test RLS (cấu trúc cho mọi bảng + hành vi trên `account`)**

`packages/db/test/rls.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '../src/client.js';
import { createTestTenant, setupTestDb, type TestDb } from '../src/testing.js';

// Bảng có tenant_id nhưng dùng policy riêng (không phải tenant_isolation chuẩn).
const CUSTOM_POLICY = new Set(['tenant', 'tenant_user', 'user_session', 'user_pref']);

let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });

describe('RLS', () => {
  it('mọi bảng có cột tenant_id đều bật và ép RLS với policy', async () => {
    const r = await sql<{ table_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean; npol: number }>`
      SELECT c.table_name, pc.relrowsecurity, pc.relforcerowsecurity,
             (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.table_name)::int AS npol
      FROM information_schema.columns c
      JOIN pg_class pc ON pc.relname = c.table_name AND pc.relnamespace = 'public'::regnamespace
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND pc.relkind IN ('r','p')
      ORDER BY 1`.execute(t.admin);
    expect(r.rows.length).toBeGreaterThan(5);
    for (const row of r.rows) {
      expect(row.relrowsecurity, `${row.table_name} chưa ENABLE RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.table_name} chưa FORCE RLS`).toBe(true);
      expect(row.npol, `${row.table_name} chưa có policy`).toBeGreaterThan(0);
    }
    // user_pref dùng rls_enable chuẩn; tenant/tenant_user/user_session có policy riêng đã được khai báo ở trên.
    expect(CUSTOM_POLICY.has('tenant')).toBe(true);
  });

  it('hai công ty không thấy tài khoản của nhau', async () => {
    const a = await createTestTenant(t.admin, { code: `A${Date.now()}`, name: 'Công ty A' });
    const b = await createTestTenant(t.admin, { code: `B${Date.now()}`, name: 'Công ty B' });
    await withTenant(t.db, { tenantId: a }, (trx) =>
      trx.insertInto('account').values({ tenant_id: a, regime: 'TT99', code: '111', name: 'Tiền mặt', root_type: 'asset', normal_balance: 'debit' }).execute());
    const seenByB = await withTenant(t.db, { tenantId: b }, (trx) => trx.selectFrom('account').selectAll().execute());
    expect(seenByB).toHaveLength(0);
    const seenByA = await withTenant(t.db, { tenantId: a }, (trx) => trx.selectFrom('account').select('code').execute());
    expect(seenByA.map((x) => x.code)).toEqual(['111']);
  });

  it('không chèn được dòng mang tenant_id khác', async () => {
    const a = await createTestTenant(t.admin, { code: `C${Date.now()}`, name: 'C' });
    const b = await createTestTenant(t.admin, { code: `D${Date.now()}`, name: 'D' });
    await expect(withTenant(t.db, { tenantId: a }, (trx) =>
      trx.insertInto('account').values({ tenant_id: b, regime: 'TT99', code: '112', name: 'TGNH', root_type: 'asset', normal_balance: 'debit' }).execute(),
    )).rejects.toThrow(/row-level security/);
  });

  it('không có biến phiên thì không thấy gì', async () => {
    const rows = await t.db.selectFrom('account').selectAll().execute();
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 7: Chạy test RLS**

Run: `pnpm -F @kt/db test -- test/rls.test.ts`
Expected: PASS 4 test.

- [ ] **Step 8: Commit**

```bash
git add packages/db
git commit -m "feat(db): bộ chạy migration, withTenant, migration nền và RLS"
```

---

### Task 3: Gói `@kt/domain`: tiền tệ Decimal, định dạng Việt Nam, danh sách quyền, kỳ kế toán

**Files:**
- Create: `packages/domain/src/money.ts`, `packages/domain/src/format.ts`, `packages/domain/src/permissions.ts`, `packages/domain/src/period.ts`
- Modify: `packages/domain/src/index.ts` (xuất các module trên)
- Test: `packages/domain/test/money.test.ts`, `packages/domain/test/format.test.ts`, `packages/domain/test/period.test.ts`

**Interfaces:**
- Produces:
  - `D(v: string | number | Decimal): Decimal`; `vnd(v): Decimal` (làm tròn 0 chữ số, ROUND_HALF_UP); `sum(xs: Iterable<string | Decimal>): Decimal`; `isBalanced(lines: {debit: string; credit: string}[]): boolean`; `ZERO: Decimal`.
  - `formatVnNumber(v: string | Decimal | null, scale = 0): string`; `parseVnNumber(text: string): string | null`; `formatVnDate(iso: string): string` (`dd/MM/yyyy`); `parseVnDate(text: string): string | null` (trả ISO).
  - `PERMISSIONS: readonly {code: string; name: string; group: string}[]`; `PERMISSION_CODES: readonly string[]`; `SENSITIVE_FLAGS = ['view_cost','view_receivable','view_payable','view_salary'] as const`.
  - `buildFiscalPeriods(input: {fiscalYear: number; dateFrom: string; months: number; regime: Regime}): FiscalPeriodInput[]` với `FiscalPeriodInput = {fiscalYear, periodNo, dateFrom, dateTo, regime}`; `Regime = 'TT99' | 'TT133' | 'TT200' | 'TT58'`.

- [ ] **Step 1: Viết test tiền tệ và định dạng (thất bại)**

`packages/domain/test/money.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { D, isBalanced, sum, vnd } from '../src/money.js';

describe('money', () => {
  it('vnd làm tròn nửa lên về 0 chữ số', () => {
    expect(vnd('1234.5').toString()).toBe('1235');
    expect(vnd('1234.4999').toString()).toBe('1234');
    expect(vnd(-0.5).toString()).toBe('-1');
  });
  it('sum cộng chính xác chuỗi số lớn', () => {
    expect(sum(['9999999999999999', '1']).toString()).toBe('10000000000000000');
  });
  it('isBalanced đúng khi tổng Nợ = tổng Có', () => {
    expect(isBalanced([{ debit: '100', credit: '0' }, { debit: '0', credit: '100' }])).toBe(true);
    expect(isBalanced([{ debit: '100', credit: '0' }, { debit: '0', credit: '99' }])).toBe(false);
  });
  it('tính chất: sum(a) - sum(b) = sum(a - b)', () => {
    fc.assert(fc.property(fc.array(fc.bigInt({ min: -10n ** 15n, max: 10n ** 15n })), (xs) => {
      const s = sum(xs.map((x) => x.toString()));
      const expected = xs.reduce((acc, x) => acc + x, 0n);
      return s.toString() === expected.toString();
    }));
  });
  it('D không nhận NaN', () => {
    expect(() => D('abc')).toThrow();
  });
});
```

`packages/domain/test/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatVnDate, formatVnNumber, parseVnDate, parseVnNumber } from '../src/format.js';

describe('format', () => {
  it('số kiểu Việt Nam', () => {
    expect(formatVnNumber('1500000')).toBe('1.500.000');
    expect(formatVnNumber('-1500000')).toBe('-1.500.000');
    expect(formatVnNumber('1234.5', 2)).toBe('1.234,50');
    expect(formatVnNumber(null)).toBe('');
    expect(formatVnNumber('0')).toBe('0');
  });
  it('phân tích số người dùng gõ', () => {
    expect(parseVnNumber('1.500.000')).toBe('1500000');
    expect(parseVnNumber('1 500 000,25')).toBe('1500000.25');
    expect(parseVnNumber('')).toBeNull();
    expect(parseVnNumber('abc')).toBeNull();
  });
  it('ngày dd/MM/yyyy', () => {
    expect(formatVnDate('2026-01-31')).toBe('31/01/2026');
    expect(parseVnDate('31/01/2026')).toBe('2026-01-31');
    expect(parseVnDate('31/02/2026')).toBeNull();
    expect(parseVnDate('1/2/26')).toBe('2026-02-01');
  });
});
```

`packages/domain/test/period.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildFiscalPeriods } from '../src/period.js';

describe('buildFiscalPeriods', () => {
  it('năm dương lịch 12 tháng có kỳ 0 là ngày trước ngày bắt đầu', () => {
    const ps = buildFiscalPeriods({ fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' });
    expect(ps).toHaveLength(13);
    expect(ps[0]).toEqual({ fiscalYear: 2026, periodNo: 0, dateFrom: '2025-12-31', dateTo: '2025-12-31', regime: 'TT99' });
    expect(ps[1]).toMatchObject({ periodNo: 1, dateFrom: '2026-01-01', dateTo: '2026-01-31' });
    expect(ps[2]).toMatchObject({ periodNo: 2, dateFrom: '2026-02-01', dateTo: '2026-02-28' });
    expect(ps[12]).toMatchObject({ periodNo: 12, dateFrom: '2026-12-01', dateTo: '2026-12-31' });
  });
  it('năm đầu 15 tháng bắt đầu 01/10/2025', () => {
    const ps = buildFiscalPeriods({ fiscalYear: 2026, dateFrom: '2025-10-01', months: 15, regime: 'TT99' });
    expect(ps).toHaveLength(16);
    expect(ps[15]).toMatchObject({ periodNo: 15, dateFrom: '2026-12-01', dateTo: '2026-12-31' });
  });
  it('từ chối số tháng ngoài 1..15 hoặc ngày không phải đầu tháng', () => {
    expect(() => buildFiscalPeriods({ fiscalYear: 2026, dateFrom: '2026-01-01', months: 16, regime: 'TT99' })).toThrow();
    expect(() => buildFiscalPeriods({ fiscalYear: 2026, dateFrom: '2026-01-15', months: 12, regime: 'TT99' })).toThrow();
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/domain test`
Expected: FAIL 3 file với `Cannot find module`.

- [ ] **Step 3: Viết mã**

`packages/domain/src/money.ts`:

```ts
import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
export const ZERO = new Decimal(0);

export function D(v: string | number | Decimal): Decimal {
  const d = new Decimal(v);
  if (d.isNaN()) throw new Error(`Số không hợp lệ: ${String(v)}`);
  return d;
}

export function vnd(v: string | number | Decimal): Decimal {
  return D(v).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

export function sum(xs: Iterable<string | Decimal>): Decimal {
  let acc = ZERO;
  for (const x of xs) acc = acc.plus(D(x));
  return acc;
}

export function isBalanced(lines: { debit: string; credit: string }[]): boolean {
  return sum(lines.map((l) => l.debit)).equals(sum(lines.map((l) => l.credit)));
}
```

`packages/domain/src/format.ts`:

```ts
import { D, type Decimal } from './money.js';

export function formatVnNumber(v: string | Decimal | null | undefined, scale = 0): string {
  if (v === null || v === undefined || v === '') return '';
  const d = D(v).toFixed(scale);
  const [intPart, frac] = d.split('.');
  const sign = intPart!.startsWith('-') ? '-' : '';
  const digits = intPart!.replace('-', '');
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return sign + grouped + (frac ? ',' + frac : '');
}

export function parseVnNumber(text: string): string | null {
  const cleaned = text.trim().replace(/[\s.]/g, '').replace(',', '.');
  if (cleaned === '' || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return D(cleaned).toString();
}

export function formatVnDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export function parseVnDate(text: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text.trim());
  if (!m) return null;
  const day = Number(m[1]); const month = Number(m[2]);
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
```

`packages/domain/src/permissions.ts`:

```ts
export const SENSITIVE_FLAGS = ['view_cost', 'view_receivable', 'view_payable', 'view_salary'] as const;
export type SensitiveFlag = (typeof SENSITIVE_FLAGS)[number];

const crud = (res: string, name: string, group: string, extra: [string, string][] = []) => [
  { code: `${res}.view`, name: `Xem ${name}`, group },
  { code: `${res}.create`, name: `Thêm ${name}`, group },
  { code: `${res}.update`, name: `Sửa ${name}`, group },
  { code: `${res}.delete`, name: `Xóa ${name}`, group },
  ...extra.map(([a, n]) => ({ code: `${res}.${a}`, name: `${n} ${name}`, group })),
];

export const PERMISSIONS: readonly { code: string; name: string; group: string }[] = [
  ...crud('user', 'người dùng', 'Hệ thống'),
  ...crud('role', 'vai trò', 'Hệ thống'),
  { code: 'company.update', name: 'Sửa thông tin công ty', group: 'Hệ thống' },
  { code: 'setting.update', name: 'Sửa tùy chọn hệ thống', group: 'Hệ thống' },
  { code: 'audit.view', name: 'Xem nhật ký kiểm toán', group: 'Hệ thống' },
  { code: 'backup.run', name: 'Sao lưu dữ liệu', group: 'Hệ thống' },
  { code: 'export.authority', name: 'Xuất dữ liệu cho cơ quan thẩm quyền', group: 'Hệ thống' },
  ...crud('account', 'hệ thống tài khoản', 'Danh mục'),
  ...crud('catalog', 'danh mục', 'Danh mục', [['import', 'Nhập Excel']]),
  ...crud('period', 'kỳ kế toán', 'Kỳ kế toán', [['lock', 'Khóa'], ['unlock', 'Bỏ khóa'], ['unlock_hard', 'Bỏ khóa cứng']]),
  ...crud('voucher', 'chứng từ', 'Chứng từ', [['print', 'In'], ['post', 'Ghi sổ'], ['unpost', 'Bỏ ghi sổ'], ['edit_posted', 'Sửa sau ghi sổ'], ['renumber', 'Đánh lại số'], ['backdate_locked', 'Ghi lùi ngày vào kỳ khóa mềm']]),
  ...crud('opening_balance', 'số dư đầu kỳ', 'Chứng từ'),
  { code: 'closing.run', name: 'Chạy kết chuyển/phân bổ', group: 'Cuối kỳ' },
  ...crud('closing_step', 'sơ đồ kết chuyển', 'Cuối kỳ'),
  { code: 'report.view', name: 'Xem sổ sách, báo cáo', group: 'Báo cáo' },
  { code: 'report.print', name: 'In sổ sách, báo cáo', group: 'Báo cáo' },
  ...crud('report_def', 'định nghĩa báo cáo', 'Báo cáo'),
  { code: 'data_check.run', name: 'Soát lỗi dữ liệu', group: 'Tiện ích' },
];
export const PERMISSION_CODES: readonly string[] = PERMISSIONS.map((p) => p.code);
```

`packages/domain/src/period.ts`:

```ts
export type Regime = 'TT99' | 'TT133' | 'TT200' | 'TT58';
export interface FiscalPeriodInput { fiscalYear: number; periodNo: number; dateFrom: string; dateTo: string; regime: Regime }

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function buildFiscalPeriods(input: { fiscalYear: number; dateFrom: string; months: number; regime: Regime }): FiscalPeriodInput[] {
  if (!Number.isInteger(input.months) || input.months < 1 || input.months > 15) throw new Error('Số tháng phải từ 1 đến 15');
  const start = new Date(input.dateFrom + 'T00:00:00Z');
  if (Number.isNaN(start.getTime()) || start.getUTCDate() !== 1) throw new Error('Ngày bắt đầu phải là ngày đầu tháng');
  const out: FiscalPeriodInput[] = [];
  const dayBefore = new Date(start); dayBefore.setUTCDate(0);
  out.push({ fiscalYear: input.fiscalYear, periodNo: 0, dateFrom: iso(dayBefore), dateTo: iso(dayBefore), regime: input.regime });
  for (let i = 0; i < input.months; i++) {
    const from = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const to = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, 0));
    out.push({ fiscalYear: input.fiscalYear, periodNo: i + 1, dateFrom: iso(from), dateTo: iso(to), regime: input.regime });
  }
  return out;
}
```

`packages/domain/src/index.ts`:

```ts
export const DOMAIN_VERSION = '0.0.1';
export * from './money.js';
export * from './format.js';
export * from './permissions.js';
export * from './period.js';
```

- [ ] **Step 4: Chạy test**

Run: `pnpm -F @kt/domain test`
Expected: PASS (money 5, format 3, period 3, smoke 1).

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): tiền tệ Decimal, định dạng Việt Nam, danh sách quyền, kỳ kế toán"
```

---

### Task 4a: API khung Fastify, xác thực phiên (Argon2), phân quyền, quản lý người dùng, CLI tạo quản trị

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/config.ts`, `apps/api/src/app.ts`, `apps/api/src/server.ts`, `apps/api/src/cli.ts`
- Create: `apps/api/src/plugins/errors.ts`, `apps/api/src/plugins/db.ts`, `apps/api/src/plugins/auth.ts`
- Create: `apps/api/src/modules/auth/service.ts`, `apps/api/src/modules/auth/routes.ts`, `apps/api/src/modules/core/users.ts`, `apps/api/src/modules/core/roles.ts`
- Create: `packages/db/src/reference.ts` (đồng bộ bảng `permission` từ `@kt/domain`)
- Modify: `packages/db/src/migrate-cli.ts`, `packages/db/src/testing.ts` (gọi `syncReferenceData` sau migrate)
- Create: `apps/api/test/helpers.ts`
- Test: `apps/api/test/auth.test.ts`, `apps/api/test/users.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `setupTestDb`, `createTestUser`, `createTestTenant` (Task 2); `PERMISSIONS`, `SENSITIVE_FLAGS` (Task 3).
- Produces:
  - `buildApp(opts: { db: Kysely<Database>; config: Config }): Promise<FastifyInstance>`; `loadConfig(env?): Config`.
  - `class AppError extends Error { constructor(code: string, message: string, status = 400) }`.
  - `request.auth: AuthCtx | null` với `AuthCtx = { sessionId: string; userId: string; username: string; tenantId: string | null; permissions: Set<string>; sensitive: Set<string> }`.
  - `app.requireAuth` (preHandler, 401 nếu chưa đăng nhập, 409 `NO_TENANT` nếu chưa chọn công ty); `app.requirePermission(code: string)` (403 `FORBIDDEN`).
  - `app.withTenant<T>(req, fn: (trx) => Promise<T>): Promise<T>`.
  - `hashPassword(pw): Promise<string>`, `verifyPassword(hash, pw): Promise<boolean>`.
  - `syncReferenceData(adminUrl: string): Promise<void>` (upsert `permission`; Task 6 nối thêm `coa_template`).
  - Test helper: `createTestApp(): Promise<{ app: FastifyInstance; t: TestDb; close(): Promise<void> }>`; `bootstrapTenant(ctx, { code }): Promise<{ tenantId: string; userId: string; cookie: string }>` (tạo user mật khẩu `Matkhau1!`, công ty, đăng nhập, trả header cookie).
  - Route: `POST /api/auth/login`, `POST /api/auth/select-tenant`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/users`, `POST /api/users`, `PUT /api/users/:id`, `GET /api/roles`, `PUT /api/roles/:id/permissions`, `GET /api/permissions`.

- [ ] **Step 1: Khai báo gói API và viết test đăng nhập (thất bại)**

`apps/api/package.json`:

```json
{
  "name": "@kt/api",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --pool=forks --poolOptions.forks.singleFork=true",
    "cli": "tsx src/cli.ts"
  },
  "dependencies": {
    "@fastify/cookie": "^10.0.1", "@fastify/cors": "^10.0.1", "@fastify/multipart": "^9.0.1",
    "@kt/coa-data": "workspace:*", "@kt/db": "workspace:*", "@kt/domain": "workspace:*",
    "archiver": "^7.0.1", "argon2": "^0.41.1", "dotenv": "^16.4.5", "exceljs": "^4.4.0",
    "fastify": "^5.0.0", "fastify-plugin": "^5.0.1", "fastify-type-provider-zod": "^4.0.1",
    "kysely": "^0.27.4", "pg": "^8.13.0", "pg-boss": "^10.1.3", "playwright": "^1.48.0", "zod": "^3.23.8"
  },
  "devDependencies": { "@types/archiver": "^6.0.2", "@types/pg": "^8.11.10", "fast-check": "^3.22.0", "pino-pretty": "^11.2.2", "tsx": "^4.19.1" }
}
```

`apps/api/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }`.

`apps/api/test/helpers.ts`:

```ts
import 'dotenv/config';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { createTestUser, setupTestDb, newId, type TestDb } from '@kt/db/testing';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/modules/auth/service.js';

export interface TestApp { app: FastifyInstance; t: TestDb; close(): Promise<void> }

export async function createTestApp(): Promise<TestApp> {
  const t = await setupTestDb();
  const app = await buildApp({ db: t.db, config: loadConfig({ ...process.env, SESSION_SECRET: 'test-secret-123' }) });
  await app.ready();
  return { app, t, close: async () => { await app.close(); await t.close(); } };
}

export const TEST_PASSWORD = 'Matkhau1!';

export async function bootstrapTenant(ctx: TestApp, input: { code: string }) {
  const username = `admin_${input.code}_${newId().slice(0, 6)}`.toLowerCase();
  const userId = await createTestUser(ctx.t.admin, { username, passwordHash: await hashPassword(TEST_PASSWORD) });
  const r = await sql<{ id: string }>`SELECT create_tenant(${input.code}, ${'Công ty ' + input.code}, NULL, ${userId}::uuid) AS id`.execute(ctx.t.admin);
  const tenantId = r.rows[0]!.id;
  const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login thất bại: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'sid')!;
  return { tenantId, userId, username, cookie: `sid=${cookie.value}` };
}
```

`apps/api/test/auth.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestUser } from '@kt/db/testing';
import { bootstrapTenant, createTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';
import { hashPassword } from '../src/modules/auth/service.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('xác thực', () => {
  it('đăng nhập đúng trả cookie sid và danh sách công ty; tự chọn công ty khi chỉ có một', async () => {
    const { cookie, tenantId } = await bootstrapTenant(ctx, { code: `AU${Date.now()}` });
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ tenantId, permissions: expect.arrayContaining(['voucher.post', 'user.create']) });
  });

  it('sai mật khẩu trả 401 và ghi login_event thất bại', async () => {
    const username = `sai_${Date.now()}`;
    await createTestUser(ctx.t.admin, { username, passwordHash: await hashPassword(TEST_PASSWORD) });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'khac' } });
    expect(res.statusCode).toBe(401);
    const ev = await sql<{ success: boolean }>`SELECT success FROM login_event WHERE username = ${username}`.execute(ctx.t.admin);
    expect(ev.rows).toEqual([{ success: false }]);
  });

  it('chưa đăng nhập thì route bảo vệ trả 401; đăng xuất hủy phiên', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/users' })).statusCode).toBe(401);
    const { cookie } = await bootstrapTenant(ctx, { code: `AO${Date.now()}` });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('người dùng thuộc hai công ty phải chọn công ty', async () => {
    const a = await bootstrapTenant(ctx, { code: `AM${Date.now()}` });
    const b = await bootstrapTenant(ctx, { code: `AN${Date.now()}` });
    // thêm user của a vào b bằng admin
    await sql`INSERT INTO tenant_user(tenant_id, user_id, role_id)
              SELECT ${b.tenantId}::uuid, ${a.userId}::uuid, id FROM role WHERE tenant_id = ${b.tenantId}::uuid AND code = 'xem'`.execute(ctx.t.admin);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: a.username, password: TEST_PASSWORD } });
    expect(res.json()).toMatchObject({ tenantId: null, tenants: expect.arrayContaining([expect.objectContaining({ id: a.tenantId }), expect.objectContaining({ id: b.tenantId })]) });
    const cookie = `sid=${res.cookies.find((c) => c.name === 'sid')!.value}`;
    expect((await ctx.app.inject({ method: 'GET', url: '/api/users', headers: { cookie } })).statusCode).toBe(409);
    const sel = await ctx.app.inject({ method: 'POST', url: '/api/auth/select-tenant', headers: { cookie }, payload: { tenantId: b.tenantId } });
    expect(sel.statusCode).toBe(200);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json().tenantId).toBe(b.tenantId);
    expect(me.json().permissions).not.toContain('user.create');
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm install && pnpm -F @kt/api test -- test/auth.test.ts`
Expected: FAIL `Cannot find module '../src/app.js'`.

- [ ] **Step 3: Đồng bộ bảng `permission` từ domain**

`packages/db/src/reference.ts`:

```ts
import pg from 'pg';
import { PERMISSIONS } from '@kt/domain';

export async function syncReferenceData(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const p of PERMISSIONS) {
      await client.query(
        `INSERT INTO permission(code, name, group_name) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, group_name = EXCLUDED.group_name`,
        [p.code, p.name, p.group],
      );
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { await client.end(); }
}
```

Sửa `packages/db/src/migrate-cli.ts`: sau `migrate(url)` thêm `await syncReferenceData(url); console.log('Đã đồng bộ dữ liệu tham chiếu');`. Sửa `packages/db/src/testing.ts` `setupTestDb`: sau `await migrate(adminUrl)` thêm `await syncReferenceData(adminUrl)`. Thêm `export { syncReferenceData } from './reference.js';` vào `packages/db/src/index.ts`.

- [ ] **Step 4: Viết config, plugin lỗi, plugin db, plugin auth, service và route**

`apps/api/src/config.ts`:

```ts
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(8),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  PORT: z.coerce.number().int().default(3000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  BACKUP_DIR: z.string().default('./backups'),
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: z.string().optional(),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config { return schema.parse(env); }
```

`apps/api/src/plugins/errors.ts`:

```ts
import fp from 'fastify-plugin';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

interface PgError extends Error { code?: string; detail?: string; constraint?: string }

export default fp(async (app) => {
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Dữ liệu không hợp lệ', details: err.issues } });
    const e = err as PgError & { validation?: unknown; statusCode?: number };
    if (e.validation) return reply.status(400).send({ error: { code: 'VALIDATION', message: e.message } });
    if (e.code === 'P0001' && e.message.includes(':')) {
      const [code, ...rest] = e.message.split(':');
      return reply.status(409).send({ error: { code: code!.trim(), message: rest.join(':').trim() } });
    }
    if (e.code === '23505') return reply.status(409).send({ error: { code: 'DUPLICATE', message: `Trùng dữ liệu (${e.constraint ?? ''})` } });
    if (e.code === '23503') return reply.status(409).send({ error: { code: 'REFERENCED', message: 'Dữ liệu đang được tham chiếu' } });
    if (e.code === '42501') return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Không có quyền trên dữ liệu' } });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: 'HTTP', message: e.message } });
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Lỗi hệ thống' } });
  });
});
```

`apps/api/src/plugins/db.ts`:

```ts
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { withTenant, type Database } from '@kt/db';
import { AppError } from './errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<Database>;
    withTenant<T>(req: FastifyRequest, fn: (trx: Transaction<Database>) => Promise<T>): Promise<T>;
  }
}

export default fp<{ db: Kysely<Database> }>(async (app, opts) => {
  app.decorate('db', opts.db);
  app.decorate('withTenant', <T>(req: FastifyRequest, fn: (trx: Transaction<Database>) => Promise<T>) => {
    if (!req.auth?.tenantId) throw new AppError('NO_TENANT', 'Chưa chọn công ty', 409);
    return withTenant(opts.db, { tenantId: req.auth.tenantId, userId: req.auth.userId, ip: req.ip }, fn);
  });
});
```

`apps/api/src/plugins/auth.ts`:

```ts
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withTenant } from '@kt/db';
import { AppError } from './errors.js';

export interface AuthCtx {
  sessionId: string; userId: string; username: string; tenantId: string | null;
  permissions: Set<string>; sensitive: Set<string>;
}
declare module 'fastify' {
  interface FastifyRequest { auth: AuthCtx | null }
  interface FastifyInstance {
    requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void>;
    requirePermission(code: string): (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (app) => {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req) => {
    const sid = req.cookies['sid'];
    if (!sid) return;
    const unsigned = req.unsignCookie(sid);
    if (!unsigned.valid || !unsigned.value) return;
    const s = await app.db.selectFrom('user_session').innerJoin('app_user', 'app_user.id', 'user_session.user_id')
      .select(['user_session.id', 'user_session.user_id', 'user_session.tenant_id', 'user_session.expires_at', 'app_user.username', 'app_user.is_active'])
      .where('user_session.id', '=', unsigned.value).executeTakeFirst();
    if (!s || !s.is_active || new Date(s.expires_at) < new Date()) return;
    const ctx: AuthCtx = { sessionId: s.id, userId: s.user_id, username: s.username, tenantId: s.tenant_id, permissions: new Set(), sensitive: new Set() };
    if (s.tenant_id) {
      const tenantId = s.tenant_id;
      await withTenant(app.db, { tenantId, userId: s.user_id }, async (trx) => {
        const tu = await trx.selectFrom('tenant_user').select(['role_id', 'sensitive_flags', 'is_active'])
          .where('tenant_id', '=', tenantId).where('user_id', '=', s.user_id).executeTakeFirst();
        if (!tu || !tu.is_active) { ctx.tenantId = null; return; }
        const perms = await trx.selectFrom('role_permission').select('permission_code').where('role_id', '=', tu.role_id).execute();
        ctx.permissions = new Set(perms.map((p) => p.permission_code));
        ctx.sensitive = new Set(tu.sensitive_flags as string[]);
      });
    }
    req.auth = ctx;
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Chưa đăng nhập', 401);
    if (!req.auth.tenantId) throw new AppError('NO_TENANT', 'Chưa chọn công ty', 409);
  });
  app.decorate('requirePermission', (code: string) => async (req: FastifyRequest) => {
    await app.requireAuth(req, undefined as unknown as FastifyReply);
    if (!req.auth!.permissions.has(code)) throw new AppError('FORBIDDEN', `Thiếu quyền ${code}`, 403);
  });
});
```

`apps/api/src/modules/auth/service.ts`:

```ts
import argon2 from 'argon2';
import { sql, type Kysely } from 'kysely';
import { withTenant, type Database } from '@kt/db';

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });
export const verifyPassword = (hash: string, pw: string) => argon2.verify(hash, pw).catch(() => false);

export interface LoginResult { sessionId: string; userId: string; tenantId: string | null; tenants: { id: string; code: string; name: string }[] }

export async function login(db: Kysely<Database>, input: { username: string; password: string; ip: string; ttlHours: number }): Promise<LoginResult | null> {
  const user = await db.selectFrom('app_user').selectAll().where('username', '=', input.username).executeTakeFirst();
  const ok = user?.is_active ? await verifyPassword(user.password_hash, input.password) : false;
  await db.insertInto('login_event').values({ username: input.username, user_id: user?.id ?? null, success: ok, ip: input.ip }).execute();
  if (!user || !ok) return null;
  const tenants = await listTenantsOf(db, user.id);
  const tenantId = tenants.length === 1 ? tenants[0]!.id : null;
  const s = await db.insertInto('user_session')
    .values({ user_id: user.id, tenant_id: tenantId, ip: input.ip, expires_at: sql`now() + make_interval(hours => ${input.ttlHours})` })
    .returning('id').executeTakeFirstOrThrow();
  return { sessionId: s.id, userId: user.id, tenantId, tenants };
}

export async function listTenantsOf(db: Kysely<Database>, userId: string) {
  return withTenant(db, { tenantId: '', userId }, (trx) =>
    trx.selectFrom('tenant_user').innerJoin('tenant', 'tenant.id', 'tenant_user.tenant_id')
      .select(['tenant.id', 'tenant.code', 'tenant.name']).where('tenant_user.user_id', '=', userId).where('tenant_user.is_active', '=', true).orderBy('tenant.code').execute());
}

export async function selectTenant(db: Kysely<Database>, sessionId: string, userId: string, tenantId: string): Promise<boolean> {
  const allowed = (await listTenantsOf(db, userId)).some((t) => t.id === tenantId);
  if (!allowed) return false;
  await db.updateTable('user_session').set({ tenant_id: tenantId }).where('id', '=', sessionId).execute();
  return true;
}

export async function logout(db: Kysely<Database>, sessionId: string) {
  await db.deleteFrom('user_session').where('id', '=', sessionId).execute();
}
```

`apps/api/src/modules/auth/routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../plugins/errors.js';
import { listTenantsOf, login, logout, selectTenant } from './service.js';

const routes: FastifyPluginAsyncZod = async (app) => {
  const cfg = app.config;
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: cfg.COOKIE_SECURE === 'true', signed: true, maxAge: cfg.SESSION_TTL_HOURS * 3600 };

  app.post('/api/auth/login', { schema: { body: z.object({ username: z.string().min(1), password: z.string().min(1) }) } }, async (req, reply) => {
    const r = await login(app.db, { ...req.body, ip: req.ip, ttlHours: cfg.SESSION_TTL_HOURS });
    if (!r) throw new AppError('BAD_CREDENTIALS', 'Sai tên đăng nhập hoặc mật khẩu', 401);
    reply.setCookie('sid', r.sessionId, cookieOpts);
    return { userId: r.userId, tenantId: r.tenantId, tenants: r.tenants };
  });

  app.post('/api/auth/select-tenant', { schema: { body: z.object({ tenantId: z.string().uuid() }) } }, async (req) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Chưa đăng nhập', 401);
    const ok = await selectTenant(app.db, req.auth.sessionId, req.auth.userId, req.body.tenantId);
    if (!ok) throw new AppError('FORBIDDEN', 'Không thuộc công ty này', 403);
    return { tenantId: req.body.tenantId };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth) await logout(app.db, req.auth.sessionId);
    reply.clearCookie('sid', { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Chưa đăng nhập', 401);
    const tenants = await listTenantsOf(app.db, req.auth.userId);
    return { userId: req.auth.userId, username: req.auth.username, tenantId: req.auth.tenantId, tenants,
      permissions: [...req.auth.permissions], sensitive: [...req.auth.sensitive] };
  });
};
export default routes;
```

`apps/api/src/modules/core/users.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { SENSITIVE_FLAGS } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { hashPassword } from '../auth/service.js';

const userBody = z.object({
  username: z.string().min(3).max(50).regex(/^[a-z0-9_.]+$/),
  fullName: z.string().min(1), password: z.string().min(8),
  roleCode: z.string().min(1), sensitiveFlags: z.array(z.enum(SENSITIVE_FLAGS)).default([]),
});

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/users', { preHandler: app.requirePermission('user.view') }, async (req) =>
    app.withTenant(req, (trx) => trx.selectFrom('tenant_user').innerJoin('app_user', 'app_user.id', 'tenant_user.user_id')
      .innerJoin('role', 'role.id', 'tenant_user.role_id')
      .select(['app_user.id', 'app_user.username', 'app_user.full_name as fullName', 'role.code as roleCode', 'tenant_user.sensitive_flags as sensitiveFlags', 'tenant_user.is_active as isActive'])
      .orderBy('app_user.username').execute()));

  app.post('/api/users', { preHandler: app.requirePermission('user.create'), schema: { body: userBody } }, async (req, reply) => {
    const b = req.body; const tenantId = req.auth!.tenantId!;
    const passwordHash = await hashPassword(b.password);
    const id = await app.withTenant(req, async (trx) => {
      const role = await trx.selectFrom('role').select('id').where('code', '=', b.roleCode).executeTakeFirst();
      if (!role) throw new AppError('ROLE_NOT_FOUND', `Không có vai trò ${b.roleCode}`, 404);
      const existing = await trx.selectFrom('app_user').select('id').where('username', '=', b.username).executeTakeFirst();
      const userId = existing?.id ?? (await trx.insertInto('app_user').values({ username: b.username, full_name: b.fullName, password_hash: passwordHash }).returning('id').executeTakeFirstOrThrow()).id;
      await trx.insertInto('tenant_user').values({ tenant_id: tenantId, user_id: userId, role_id: role.id, sensitive_flags: JSON.stringify(b.sensitiveFlags) }).execute();
      return userId;
    });
    return reply.status(201).send({ id });
  });

  app.put('/api/users/:id', { preHandler: app.requirePermission('user.update'),
    schema: { params: z.object({ id: z.string().uuid() }), body: userBody.partial().omit({ username: true }) } }, async (req) => {
    const b = req.body; const tenantId = req.auth!.tenantId!;
    await app.withTenant(req, async (trx) => {
      if (b.roleCode) {
        const role = await trx.selectFrom('role').select('id').where('code', '=', b.roleCode).executeTakeFirstOrThrow();
        await trx.updateTable('tenant_user').set({ role_id: role.id }).where('tenant_id', '=', tenantId).where('user_id', '=', req.params.id).execute();
      }
      if (b.sensitiveFlags) await trx.updateTable('tenant_user').set({ sensitive_flags: JSON.stringify(b.sensitiveFlags) }).where('tenant_id', '=', tenantId).where('user_id', '=', req.params.id).execute();
      if (b.fullName) await trx.updateTable('app_user').set({ full_name: b.fullName }).where('id', '=', req.params.id).execute();
      if (b.password) {
        await trx.updateTable('app_user').set({ password_hash: await hashPassword(b.password) }).where('id', '=', req.params.id).execute();
        await sql`INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id) VALUES (${tenantId}::uuid, app_user_id(), 'reset_password', 'app_user', ${req.params.id})`.execute(trx);
      }
    });
    return { ok: true };
  });

  app.put('/api/users/:id/active', { preHandler: app.requirePermission('user.update'),
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ isActive: z.boolean() }) } }, async (req) => {
    await app.withTenant(req, (trx) => trx.updateTable('tenant_user').set({ is_active: req.body.isActive })
      .where('tenant_id', '=', req.auth!.tenantId!).where('user_id', '=', req.params.id).execute());
    return { ok: true };
  });
};
export default routes;
```

`apps/api/src/modules/core/roles.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PERMISSIONS } from '@kt/domain';

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/permissions', { preHandler: app.requireAuth }, async () => PERMISSIONS);

  app.get('/api/roles', { preHandler: app.requirePermission('role.view') }, async (req) =>
    app.withTenant(req, async (trx) => {
      const roles = await trx.selectFrom('role').select(['id', 'code', 'name', 'is_system as isSystem']).orderBy('code').execute();
      const perms = await trx.selectFrom('role_permission').select(['role_id', 'permission_code']).execute();
      return roles.map((r) => ({ ...r, permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.permission_code) }));
    }));

  app.put('/api/roles/:id/permissions', { preHandler: app.requirePermission('role.update'),
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ permissions: z.array(z.string()) }) } }, async (req) => {
    const tenantId = req.auth!.tenantId!;
    await app.withTenant(req, async (trx) => {
      await trx.deleteFrom('role_permission').where('role_id', '=', req.params.id).execute();
      if (req.body.permissions.length)
        await trx.insertInto('role_permission').values(req.body.permissions.map((p) => ({ tenant_id: tenantId, role_id: req.params.id, permission_code: p }))).execute();
    });
    return { ok: true };
  });
};
export default routes;
```

`apps/api/src/app.ts`:

```ts
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { Kysely } from 'kysely';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Database } from '@kt/db';
import type { Config } from './config.js';
import errorsPlugin from './plugins/errors.js';
import dbPlugin from './plugins/db.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './modules/auth/routes.js';
import userRoutes from './modules/core/users.js';
import roleRoutes from './modules/core/roles.js';

declare module 'fastify' { interface FastifyInstance { config: Config } }

export async function buildApp(opts: { db: Kysely<Database>; config: Config }) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', trustProxy: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('config', opts.config);
  await app.register(errorsPlugin);
  await app.register(cors, { origin: opts.config.WEB_ORIGIN, credentials: true });
  await app.register(cookie, { secret: opts.config.SESSION_SECRET });
  await app.register(dbPlugin, { db: opts.db });
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(roleRoutes);
  app.get('/api/health', async () => ({ ok: true }));
  return app;
}
```

`apps/api/src/server.ts`:

```ts
import 'dotenv/config';
import { createDb, createPool } from '@kt/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const db = createDb(createPool(config.DATABASE_URL));
const app = await buildApp({ db, config });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
```

`apps/api/src/cli.ts`:

```ts
import 'dotenv/config';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { hashPassword } from './modules/auth/service.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  username: { type: 'string' }, password: { type: 'string' }, 'full-name': { type: 'string' },
  'tenant-code': { type: 'string' }, 'tenant-name': { type: 'string' }, 'tax-code': { type: 'string' } } });

if (positionals[0] !== 'create-admin') { console.error('Dùng: cli create-admin --username ... --password ... --tenant-code ... --tenant-name ...'); process.exit(1); }
const { username, password, 'tenant-code': tenantCode, 'tenant-name': tenantName } = values;
if (!username || !password || !tenantCode || !tenantName) { console.error('Thiếu tham số'); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
const u = await client.query(
  `INSERT INTO app_user(username, full_name, password_hash) VALUES ($1, $2, $3)
   ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`,
  [username, values['full-name'] ?? username, await hashPassword(password)]);
const t = await client.query('SELECT create_tenant($1, $2, $3, $4) AS id', [tenantCode, tenantName, values['tax-code'] ?? null, u.rows[0].id]);
console.log(`Đã tạo công ty ${tenantCode} (${t.rows[0].id}) với quản trị ${username}`);
await client.end();
```

- [ ] **Step 5: Chạy test xác thực**

Run: `pnpm -F @kt/api test -- test/auth.test.ts`
Expected: PASS 4 test.

- [ ] **Step 6: Viết và chạy test người dùng/vai trò**

`apps/api/test/users.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('người dùng và vai trò', () => {
  it('tạo người dùng vai trò kế toán viên, người đó không có quyền user.create', async () => {
    const admin = await bootstrapTenant(ctx, { code: `US${Date.now()}` });
    const created = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin.cookie },
      payload: { username: `kt_${Date.now()}`, fullName: 'Kế toán A', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: ['view_cost'] } });
    expect(created.statusCode).toBe(201);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin.cookie } });
    expect(list.json()).toHaveLength(2);
    const roles = await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie: admin.cookie } });
    const kt = roles.json().find((r: { code: string }) => r.code === 'ketoan_vien');
    expect(kt.permissions).toContain('voucher.post');
    expect(kt.permissions).not.toContain('voucher.unpost');
    expect(kt.permissions).not.toContain('user.create');
  });

  it('người không có quyền bị 403', async () => {
    const admin = await bootstrapTenant(ctx, { code: `UV${Date.now()}` });
    const username = `xem_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin.cookie },
      payload: { username, fullName: 'Xem', password: 'Matkhau1!', roleCode: 'xem' } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const cookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    const res = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username: 'x', fullName: 'x', password: 'Matkhau1!', roleCode: 'xem' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});
```

Run: `pnpm -F @kt/api test`
Expected: PASS 6 test.

- [ ] **Step 7: Commit**

```bash
git add apps/api packages/db
git commit -m "feat(api): khung Fastify, xác thực phiên Argon2, phân quyền và quản lý người dùng"
```

---

### Task 4b: Web khung React, đăng nhập, chọn công ty, quản lý người dùng

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/nginx.conf`, `apps/web/vitest.setup.ts`
- Create: `apps/web/src/main.tsx`, `apps/web/src/router.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/auth.tsx`, `apps/web/src/layout/AppLayout.tsx`
- Create: `apps/web/src/pages/Login.tsx`, `apps/web/src/pages/SelectTenant.tsx`, `apps/web/src/pages/Users.tsx`
- Test: `apps/web/test/Login.test.tsx`, `apps/web/test/Users.test.tsx`

**Interfaces:**
- Consumes: route `/api/auth/*`, `/api/users`, `/api/roles` (Task 4a).
- Produces:
  - `api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>` ném `ApiError { code, message, status }`.
  - `useAuth(): { me: Me | null; refresh(): Promise<void>; logout(): Promise<void>; can(code: string): boolean }` với `Me = { userId; username; tenantId: string | null; tenants: {id; code; name}[]; permissions: string[]; sensitive: string[] }`.
  - `AppLayout` (menu trái Ant Design, nội dung `<Outlet/>`); các task sau thêm mục menu trong `apps/web/src/router.tsx` mảng `MENU`.

- [ ] **Step 1: Khai báo gói web và viết test màn hình đăng nhập (thất bại)**

`apps/web/package.json`:

```json
{
  "name": "@kt/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --environment jsdom",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@ant-design/icons": "^5.5.1", "@kt/domain": "workspace:*", "@kt/ui": "workspace:*",
    "@tanstack/react-query": "^5.59.0", "@tanstack/react-router": "^1.64.0",
    "antd": "^5.21.2", "dayjs": "^1.11.13", "react": "^18.3.1", "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.0", "@testing-library/jest-dom": "^6.5.0", "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2", "@types/react": "^18.3.11", "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.2", "jsdom": "^25.0.1", "vite": "^5.4.8"
  }
}
```

`apps/web/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"], "noEmit": true, "types": ["vite/client", "@testing-library/jest-dom"] },
  "include": ["src", "test", "vitest.setup.ts"] }
```

`apps/web/vite.config.ts`:

```ts
/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  test: { environment: 'jsdom', setupFiles: ['./vitest.setup.ts'], globals: false },
});
```

`apps/web/vitest.setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
// Ant Design cần matchMedia trong jsdom
Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn().mockImplementation((q: string) => ({ matches: false, media: q, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) });
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="vi">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Phần mềm kế toán</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

`apps/web/nginx.conf`:

```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  location /api/ { proxy_pass http://api:3000; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
  location / { try_files $uri /index.html; }
}
```

`apps/web/test/Login.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from '../src/pages/Login.js';

describe('Đăng nhập', () => {
  it('gửi tên đăng nhập và mật khẩu, báo lỗi khi sai', async () => {
    const onLogin = vi.fn().mockRejectedValue(Object.assign(new Error('Sai tên đăng nhập hoặc mật khẩu'), { code: 'BAD_CREDENTIALS' }));
    render(<LoginForm onLogin={onLogin} />);
    await userEvent.type(screen.getByLabelText('Tên đăng nhập'), 'admin');
    await userEvent.type(screen.getByLabelText('Mật khẩu'), 'sai');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(onLogin).toHaveBeenCalledWith({ username: 'admin', password: 'sai' });
    expect(await screen.findByText('Sai tên đăng nhập hoặc mật khẩu')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm install && pnpm -F @kt/web test`
Expected: FAIL `Cannot find module '../src/pages/Login.js'`.

- [ ] **Step 3: Viết client API, auth context, layout, router, trang đăng nhập/chọn công ty/người dùng**

`apps/web/src/api/client.ts`:

```ts
export class ApiError extends Error { constructor(public code: string, message: string, public status: number, public details?: unknown) { super(message); } }

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, { credentials: 'include', ...rest,
    headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body });
  if (res.status === 204) return undefined as T;
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = (body as { error?: { code: string; message: string; details?: unknown } }).error; throw new ApiError(e?.code ?? 'HTTP', e?.message ?? String(body), res.status, e?.details); }
  return body as T;
}
export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) throw new ApiError('HTTP', await res.text(), res.status);
  return res.blob();
}
```

`apps/web/src/auth.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api/client.js';

export interface Me { userId: string; username: string; tenantId: string | null; tenants: { id: string; code: string; name: string }[]; permissions: string[]; sensitive: string[] }
interface AuthCtx { me: Me | null; loading: boolean; refresh(): Promise<void>; logout(): Promise<void>; can(code: string): boolean }
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setMe(await api<Me>('/api/auth/me')); } catch { setMe(null); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const value = useMemo<AuthCtx>(() => ({
    me, loading, refresh,
    logout: async () => { await api('/api/auth/logout', { method: 'POST' }); setMe(null); },
    can: (code) => !!me?.permissions.includes(code),
  }), [me, loading, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useAuth(): AuthCtx { const v = useContext(Ctx); if (!v) throw new Error('Thiếu AuthProvider'); return v; }
```

`apps/web/src/pages/Login.tsx`:

```tsx
import { useState } from 'react';
import { Alert, Button, Card, Form, Input } from 'antd';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

export interface LoginInput { username: string; password: string }

export function LoginForm({ onLogin }: { onLogin: (v: LoginInput) => Promise<unknown> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Đăng nhập" style={{ maxWidth: 360, margin: '80px auto' }}>
      {error && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      <Form layout="vertical" onFinish={async (v: LoginInput) => { setBusy(true); setError(null); try { await onLogin(v); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>
        <Form.Item label="Tên đăng nhập" name="username" rules={[{ required: true, message: 'Nhập tên đăng nhập' }]}><Input autoFocus /></Form.Item>
        <Form.Item label="Mật khẩu" name="password" rules={[{ required: true, message: 'Nhập mật khẩu' }]}><Input.Password /></Form.Item>
        <Button type="primary" htmlType="submit" loading={busy} block>Đăng nhập</Button>
      </Form>
    </Card>
  );
}

export default function LoginPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  return <LoginForm onLogin={async (v) => {
    const r = await api<{ tenantId: string | null }>('/api/auth/login', { method: 'POST', json: v });
    await refresh();
    void navigate({ to: r.tenantId ? '/' : '/chon-cong-ty' });
  }} />;
}
```

`apps/web/src/pages/SelectTenant.tsx`:

```tsx
import { Card, List } from 'antd';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

export default function SelectTenantPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  return (
    <Card title="Chọn công ty" style={{ maxWidth: 480, margin: '80px auto' }}>
      <List dataSource={me?.tenants ?? []} renderItem={(t) => (
        <List.Item onClick={async () => { await api('/api/auth/select-tenant', { method: 'POST', json: { tenantId: t.id } }); await refresh(); void navigate({ to: '/' }); }} style={{ cursor: 'pointer' }}>
          <List.Item.Meta title={t.name} description={t.code} />
        </List.Item>)} />
    </Card>
  );
}
```

`apps/web/src/layout/AppLayout.tsx`:

```tsx
import { Layout, Menu, Typography } from 'antd';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useAuth } from '../auth.js';

export interface MenuItem { key: string; label: string; to: string; permission?: string; children?: MenuItem[] }

export function AppLayout({ menu }: { menu: MenuItem[] }) {
  const { me, can, logout } = useAuth();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const visible = (items: MenuItem[]): MenuItem[] => items.filter((i) => !i.permission || can(i.permission)).map((i) => ({ ...i, children: i.children ? visible(i.children) : undefined }));
  const toAntd = (items: MenuItem[]): { key: string; label: React.ReactNode; children?: unknown[] }[] =>
    items.map((i) => ({ key: i.to, label: i.children ? i.label : <Link to={i.to}>{i.label}</Link>, children: i.children ? toAntd(i.children) : undefined }));
  const company = me?.tenants.find((t) => t.id === me.tenantId);
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider width={240} theme="light"><div style={{ padding: 12 }}><Typography.Text strong>{company?.name ?? 'Kế toán'}</Typography.Text></div>
        <Menu mode="inline" selectedKeys={[path]} items={toAntd(visible(menu))} /></Layout.Sider>
      <Layout><Layout.Header style={{ background: '#fff', display: 'flex', justifyContent: 'flex-end', gap: 16 }}>
        <span>{me?.username}</span><a onClick={() => void logout()}>Đăng xuất</a></Layout.Header>
        <Layout.Content style={{ padding: 16 }}><Outlet /></Layout.Content></Layout>
    </Layout>
  );
}
```

`apps/web/src/pages/Users.tsx`:

```tsx
import { useState } from 'react';
import { Button, Checkbox, Form, Input, Modal, Select, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SENSITIVE_FLAGS } from '@kt/domain';
import { api } from '../api/client.js';

interface UserRow { id: string; username: string; fullName: string; roleCode: string; sensitiveFlags: string[]; isActive: boolean }
interface Role { id: string; code: string; name: string }
const FLAG_LABEL: Record<string, string> = { view_cost: 'Xem giá vốn', view_receivable: 'Xem công nợ phải thu', view_payable: 'Xem công nợ phải trả', view_salary: 'Xem lương' };

export function UsersTable({ users, roles, onCreate }: { users: UserRow[]; roles: Role[]; onCreate: (v: Record<string, unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  return (
    <>
      <Button type="primary" onClick={() => setOpen(true)} style={{ marginBottom: 12 }}>Thêm người dùng</Button>
      <Table rowKey="id" dataSource={users} pagination={false} columns={[
        { title: 'Tên đăng nhập', dataIndex: 'username' }, { title: 'Họ tên', dataIndex: 'fullName' },
        { title: 'Vai trò', dataIndex: 'roleCode', render: (c: string) => roles.find((r) => r.code === c)?.name ?? c },
        { title: 'Dữ liệu nhạy cảm', dataIndex: 'sensitiveFlags', render: (f: string[]) => f.map((x) => <Tag key={x}>{FLAG_LABEL[x] ?? x}</Tag>) },
        { title: 'Trạng thái', dataIndex: 'isActive', render: (a: boolean) => (a ? 'Đang dùng' : 'Khóa') }]} />
      <Modal title="Thêm người dùng" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} destroyOnClose>
        <Form form={form} layout="vertical" onFinish={async (v) => { await onCreate(v); setOpen(false); form.resetFields(); }}>
          <Form.Item label="Tên đăng nhập" name="username" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="Họ tên" name="fullName" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="Mật khẩu" name="password" rules={[{ required: true, min: 8 }]}><Input.Password /></Form.Item>
          <Form.Item label="Vai trò" name="roleCode" rules={[{ required: true }]}><Select options={roles.map((r) => ({ value: r.code, label: r.name }))} /></Form.Item>
          <Form.Item label="Dữ liệu nhạy cảm" name="sensitiveFlags" initialValue={[]}><Checkbox.Group options={SENSITIVE_FLAGS.map((f) => ({ value: f, label: FLAG_LABEL[f] }))} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

export default function UsersPage() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/api/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<Role[]>('/api/roles') });
  const create = useMutation({ mutationFn: (v: Record<string, unknown>) => api('/api/users', { method: 'POST', json: v }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['users'] }); void message.success('Đã thêm người dùng'); },
    onError: (e) => void message.error((e as Error).message) });
  return <UsersTable users={users.data ?? []} roles={roles.data ?? []} onCreate={(v) => create.mutateAsync(v).then(() => undefined)} />;
}
```

`apps/web/src/router.tsx`:

```tsx
import { Outlet, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { Spin } from 'antd';
import { AppLayout, type MenuItem } from './layout/AppLayout.js';
import { useAuth } from './auth.js';
import LoginPage from './pages/Login.js';
import SelectTenantPage from './pages/SelectTenant.js';
import UsersPage from './pages/Users.js';
import { api } from './api/client.js';

// Các task sau thêm mục vào MENU và route vào routeTree.
export const MENU: MenuItem[] = [
  { key: 'hethong', label: 'Hệ thống', to: '/he-thong', children: [
    { key: 'users', label: 'Người dùng', to: '/he-thong/nguoi-dung', permission: 'user.view' },
  ] },
];

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/dang-nhap', component: LoginPage });
const selectTenantRoute = createRoute({ getParentRoute: () => rootRoute, path: '/chon-cong-ty', component: SelectTenantPage });
const requireMe = async () => {
  try { const me = await api<{ tenantId: string | null }>('/api/auth/me'); if (!me.tenantId) throw redirect({ to: '/chon-cong-ty' }); }
  catch (e) { if ((e as { status?: number }).status === 401) throw redirect({ to: '/dang-nhap' }); throw e; }
};
export const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', beforeLoad: requireMe,
  component: () => { const { loading } = useAuth(); return loading ? <Spin /> : <AppLayout menu={MENU} />; } });
const homeRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: () => <div>Chọn chức năng ở menu trái.</div> });
const usersRoute = createRoute({ getParentRoute: () => appRoute, path: '/he-thong/nguoi-dung', component: UsersPage });

export const routeTree = rootRoute.addChildren([loginRoute, selectTenantRoute, appRoute.addChildren([homeRoute, usersRoute])]);
export const router = createRouter({ routeTree });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
```

`apps/web/src/main.tsx`:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import viVN from 'antd/locale/vi_VN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import dayjs from 'dayjs';
import 'dayjs/locale/vi';
import 'antd/dist/reset.css';
import { AuthProvider } from './auth.js';
import { router } from './router.js';

dayjs.locale('vi');
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={viVN}><QueryClientProvider client={qc}><AuthProvider><RouterProvider router={router} /></AuthProvider></QueryClientProvider></ConfigProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 4: Viết test bảng người dùng và chạy toàn bộ test web**

`apps/web/test/Users.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsersTable } from '../src/pages/Users.js';

describe('Bảng người dùng', () => {
  it('hiển thị tên vai trò và cờ dữ liệu nhạy cảm bằng tiếng Việt', () => {
    render(<UsersTable roles={[{ id: '1', code: 'ketoan_vien', name: 'Kế toán viên' }]}
      users={[{ id: 'u1', username: 'kt1', fullName: 'Kế toán A', roleCode: 'ketoan_vien', sensitiveFlags: ['view_cost'], isActive: true }]} onCreate={vi.fn()} />);
    expect(screen.getByText('Kế toán viên')).toBeInTheDocument();
    expect(screen.getByText('Xem giá vốn')).toBeInTheDocument();
    expect(screen.getByText('Đang dùng')).toBeInTheDocument();
  });
});
```

Run: `pnpm -F @kt/web test && pnpm -F @kt/web typecheck`
Expected: PASS 2 test; typecheck mã 0. Kiểm tra tay: `pnpm -F @kt/api dev` và `pnpm -F @kt/web dev`, mở `http://localhost:5173/dang-nhap`, đăng nhập bằng tài khoản tạo từ `pnpm -F @kt/api cli create-admin --username admin --password Matkhau1! --tenant-code ABC --tenant-name "Công ty ABC"`.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): khung React, đăng nhập, chọn công ty và quản lý người dùng"
```

---

### Task 5: Công ty, năm tài chính, kỳ kế toán, tùy chọn hệ thống

**Files:**
- Create: `apps/api/src/modules/core/tenants.ts`, `apps/api/src/modules/core/fiscalYears.ts`, `apps/api/src/modules/core/settings.ts`
- Modify: `apps/api/src/app.ts` (đăng ký 3 route plugin)
- Create: `apps/web/src/pages/CompanyWizard.tsx`, `apps/web/src/pages/Company.tsx`
- Modify: `apps/web/src/router.tsx` (thêm route `/he-thong/cong-ty`, `/he-thong/tao-cong-ty`, mục menu)
- Test: `apps/api/test/fiscalYears.test.ts`, `apps/api/test/settings.test.ts`

**Interfaces:**
- Consumes: `buildFiscalPeriods` (Task 3); `create_tenant` SQL (Task 2); `app.withTenant`, `requirePermission` (Task 4a).
- Produces:
  - `POST /api/tenants { code, name, taxCode?, address?, legalRep?, chiefAccountant? }` → `{ id }` (người tạo thành quản trị, phiên chuyển sang công ty mới); `GET /api/company`; `PUT /api/company`.
  - `POST /api/fiscal-years { fiscalYear, dateFrom, months, regime }` → `{ periods: number }`; `GET /api/fiscal-years` → `{ fiscalYear, regime, dateFrom, dateTo, periods: {periodNo, dateFrom, dateTo, status}[] }[]`.
  - `createFiscalYear(trx, tenantId, input): Promise<void>` (dùng lại ở seed và test).
  - `SETTINGS` schema (Zod) với khóa: `book_form` (`'NKC'`), `costing_method` (`'avg_period' | 'avg_moving' | 'fifo' | 'specific'`), `base_currency` (`'VND'`), `hidden_modules` (`string[]`), `extra_dims` (`{ key: string; label: string }[]`), `fx_rate_type` (`'transfer_avg' | 'buy' | 'sell'`); `GET /api/settings` → object đầy đủ (mặc định nếu chưa có); `PUT /api/settings` (partial).
  - `getSettings(trx, tenantId): Promise<Settings>`.

- [ ] **Step 1: Viết test năm tài chính và tùy chọn (thất bại)**

`apps/api/test/fiscalYears.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('năm tài chính', () => {
  it('tạo năm 2026 TT99 sinh 13 kỳ (0..12), không tạo trùng năm', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `FY${Date.now()}` });
    const r = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ periods: 13 });
    const list = await ctx.app.inject({ method: 'GET', url: '/api/fiscal-years', headers: { cookie } });
    expect(list.json()[0]).toMatchObject({ fiscalYear: 2026, regime: 'TT99', dateFrom: '2026-01-01', dateTo: '2026-12-31' });
    expect(list.json()[0].periods).toHaveLength(13);
    expect(list.json()[0].periods[0]).toMatchObject({ periodNo: 0, dateFrom: '2025-12-31', status: 'open' });
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' } });
    expect(dup.statusCode).toBe(409);
  });
  it('năm sau phải nối tiếp ngày kết thúc năm trước', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `FZ${Date.now()}` });
    await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' } });
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2027, dateFrom: '2027-02-01', months: 12, regime: 'TT99' } });
    expect(bad.json().error.code).toBe('FISCAL_YEAR_GAP');
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2027, dateFrom: '2027-01-01', months: 12, regime: 'TT99' } });
    expect(ok.statusCode).toBe(201);
  });
  it('tạo công ty mới chuyển phiên sang công ty đó và cập nhật thông tin pháp lý', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `FT${Date.now()}` });
    const code = `MOI${Date.now()}`;
    const r = await ctx.app.inject({ method: 'POST', url: '/api/tenants', headers: { cookie }, payload: { code, name: 'Công ty mới', taxCode: '0101234567' } });
    expect(r.statusCode).toBe(201);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json().tenantId).toBe(r.json().id);
    await ctx.app.inject({ method: 'PUT', url: '/api/company', headers: { cookie }, payload: { legalRep: 'Nguyễn Văn A', chiefAccountant: 'Trần Thị B' } });
    const c = await ctx.app.inject({ method: 'GET', url: '/api/company', headers: { cookie } });
    expect(c.json()).toMatchObject({ code, taxCode: '0101234567', legalRep: 'Nguyễn Văn A', chiefAccountant: 'Trần Thị B' });
  });
});
```

`apps/api/test/settings.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('tùy chọn hệ thống', () => {
  it('mặc định đầy đủ, cập nhật từng phần, từ chối giá trị sai', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `ST${Date.now()}` });
    const d = await ctx.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(d.json()).toEqual({ book_form: 'NKC', costing_method: 'avg_period', base_currency: 'VND', hidden_modules: [], extra_dims: [], fx_rate_type: 'transfer_avg' });
    const u = await ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { costing_method: 'fifo', extra_dims: [{ key: 'ma_thong_ke', label: 'Mã thống kê' }] } });
    expect(u.statusCode).toBe(200);
    const d2 = await ctx.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(d2.json()).toMatchObject({ costing_method: 'fifo', book_form: 'NKC', extra_dims: [{ key: 'ma_thong_ke', label: 'Mã thống kê' }] });
    const bad = await ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { costing_method: 'lifo' } });
    expect(bad.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/api test -- test/fiscalYears.test.ts test/settings.test.ts`
Expected: FAIL với 404 (route chưa có).

- [ ] **Step 3: Viết route công ty, năm tài chính, tùy chọn**

`apps/api/src/modules/core/tenants.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { AppError } from '../../plugins/errors.js';

const companyBody = z.object({
  name: z.string().min(1), taxCode: z.string().regex(/^\d{10}(-\d{3})?$/).nullable().optional(),
  address: z.string().nullable().optional(), legalRep: z.string().nullable().optional(),
  chiefAccountant: z.string().nullable().optional(), phone: z.string().nullable().optional(), email: z.string().email().nullable().optional(),
});

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post('/api/tenants', { schema: { body: companyBody.extend({ code: z.string().min(1).max(20).regex(/^[A-Z0-9_]+$/) }) } }, async (req, reply) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Chưa đăng nhập', 401);
    const b = req.body;
    const r = await sql<{ id: string }>`SELECT create_tenant(${b.code}, ${b.name}, ${b.taxCode ?? null}, ${req.auth.userId}::uuid) AS id`.execute(app.db);
    const id = r.rows[0]!.id;
    await app.db.updateTable('user_session').set({ tenant_id: id }).where('id', '=', req.auth.sessionId).execute();
    await app.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${id}, true), set_config('app.current_user', ${req.auth!.userId}, true)`.execute(trx);
      await trx.updateTable('tenant').set({ address: b.address ?? null, legal_rep: b.legalRep ?? null, chief_accountant: b.chiefAccountant ?? null, phone: b.phone ?? null, email: b.email ?? null }).where('id', '=', id).execute();
    });
    return reply.status(201).send({ id });
  });

  app.get('/api/company', { preHandler: app.requireAuth }, async (req) =>
    app.withTenant(req, async (trx) => {
      const t = await trx.selectFrom('tenant').selectAll().where('id', '=', req.auth!.tenantId!).executeTakeFirstOrThrow();
      return { id: t.id, code: t.code, name: t.name, taxCode: t.tax_code, address: t.address, legalRep: t.legal_rep, chiefAccountant: t.chief_accountant, phone: t.phone, email: t.email };
    }));

  app.put('/api/company', { preHandler: app.requirePermission('company.update'), schema: { body: companyBody.partial() } }, async (req) => {
    const b = req.body;
    await app.withTenant(req, (trx) => trx.updateTable('tenant').set({
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.taxCode !== undefined ? { tax_code: b.taxCode } : {}),
      ...(b.address !== undefined ? { address: b.address } : {}), ...(b.legalRep !== undefined ? { legal_rep: b.legalRep } : {}),
      ...(b.chiefAccountant !== undefined ? { chief_accountant: b.chiefAccountant } : {}), ...(b.phone !== undefined ? { phone: b.phone } : {}),
      ...(b.email !== undefined ? { email: b.email } : {}),
    }).where('id', '=', req.auth!.tenantId!).execute());
    return { ok: true };
  });
};
export default routes;
```

`apps/api/src/modules/core/fiscalYears.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Transaction } from 'kysely';
import { buildFiscalPeriods, type Regime } from '@kt/domain';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';

export const fiscalYearBody = z.object({
  fiscalYear: z.number().int().min(2000).max(2100), dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  months: z.number().int().min(1).max(15).default(12), regime: z.enum(['TT99', 'TT133', 'TT200', 'TT58']),
});
export type FiscalYearInput = z.infer<typeof fiscalYearBody>;

export async function createFiscalYear(trx: Transaction<Database>, tenantId: string, input: FiscalYearInput): Promise<number> {
  const existing = await trx.selectFrom('fiscal_period').select('fiscal_year').where('fiscal_year', '=', input.fiscalYear).executeTakeFirst();
  if (existing) throw new AppError('FISCAL_YEAR_EXISTS', `Năm tài chính ${input.fiscalYear} đã tồn tại`, 409);
  const last = await trx.selectFrom('fiscal_period').select('date_to').where('period_no', '>', 0).orderBy('date_to', 'desc').executeTakeFirst();
  if (last) {
    const next = new Date(last.date_to + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
    if (next.toISOString().slice(0, 10) !== input.dateFrom) throw new AppError('FISCAL_YEAR_GAP', `Năm mới phải bắt đầu ngày ${next.toISOString().slice(0, 10)}`, 409);
  }
  const periods = buildFiscalPeriods({ fiscalYear: input.fiscalYear, dateFrom: input.dateFrom, months: input.months, regime: input.regime as Regime });
  await trx.insertInto('fiscal_period').values(periods.map((p) => ({ tenant_id: tenantId, fiscal_year: p.fiscalYear, period_no: p.periodNo, date_from: p.dateFrom, date_to: p.dateTo, regime: p.regime }))).execute();
  return periods.length;
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post('/api/fiscal-years', { preHandler: app.requirePermission('period.create'), schema: { body: fiscalYearBody } }, async (req, reply) => {
    const n = await app.withTenant(req, (trx) => createFiscalYear(trx, req.auth!.tenantId!, req.body));
    return reply.status(201).send({ periods: n });
  });
  app.get('/api/fiscal-years', { preHandler: app.requireAuth }, async (req) =>
    app.withTenant(req, async (trx) => {
      const rows = await trx.selectFrom('fiscal_period').selectAll().orderBy('fiscal_year').orderBy('period_no').execute();
      const years = new Map<number, { fiscalYear: number; regime: string; dateFrom: string; dateTo: string; periods: { periodNo: number; dateFrom: string; dateTo: string; status: string }[] }>();
      for (const r of rows) {
        const y = years.get(r.fiscal_year) ?? { fiscalYear: r.fiscal_year, regime: r.regime, dateFrom: '', dateTo: '', periods: [] };
        y.periods.push({ periodNo: r.period_no, dateFrom: r.date_from, dateTo: r.date_to, status: r.status });
        if (r.period_no === 1) y.dateFrom = r.date_from;
        if (r.period_no > 0) y.dateTo = r.date_to;
        years.set(r.fiscal_year, y);
      }
      return [...years.values()];
    }));
};
export default routes;
```

`apps/api/src/modules/core/settings.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';

export const SETTINGS = z.object({
  book_form: z.enum(['NKC']).default('NKC'),
  costing_method: z.enum(['avg_period', 'avg_moving', 'fifo', 'specific']).default('avg_period'),
  base_currency: z.literal('VND').default('VND'),
  hidden_modules: z.array(z.string()).default([]),
  extra_dims: z.array(z.object({ key: z.string().regex(/^[a-z_]+$/), label: z.string().min(1) })).default([]),
  fx_rate_type: z.enum(['transfer_avg', 'buy', 'sell']).default('transfer_avg'),
});
export type Settings = z.infer<typeof SETTINGS>;

export async function getSettings(trx: Transaction<Database>, tenantId: string): Promise<Settings> {
  const rows = await trx.selectFrom('tenant_setting').select(['key', 'value']).where('tenant_id', '=', tenantId).execute();
  return SETTINGS.parse(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/settings', { preHandler: app.requireAuth }, async (req) => app.withTenant(req, (trx) => getSettings(trx, req.auth!.tenantId!)));
  app.put('/api/settings', { preHandler: app.requirePermission('setting.update'), schema: { body: SETTINGS.partial().strict() } }, async (req) => {
    const tenantId = req.auth!.tenantId!;
    await app.withTenant(req, async (trx) => {
      for (const [key, value] of Object.entries(req.body)) {
        await trx.insertInto('tenant_setting').values({ tenant_id: tenantId, key, value: JSON.stringify(value) })
          .onConflict((oc) => oc.columns(['tenant_id', 'key']).doUpdateSet({ value: JSON.stringify(value), updated_at: new Date() })).execute();
      }
    });
    return { ok: true };
  });
};
export default routes;
```

Sửa `apps/api/src/app.ts`: import và `await app.register(tenantRoutes); await app.register(fiscalYearRoutes); await app.register(settingRoutes);` sau `roleRoutes`.

- [ ] **Step 4: Chạy test**

Run: `pnpm -F @kt/api test -- test/fiscalYears.test.ts test/settings.test.ts`
Expected: PASS 4 test.

- [ ] **Step 5: Màn hình web: thông tin công ty, tạo công ty + năm tài chính (wizard 2 bước)**

`apps/web/src/pages/CompanyWizard.tsx`:

```tsx
import { useState } from 'react';
import { Button, Card, DatePicker, Form, Input, InputNumber, Select, Steps, message } from 'antd';
import dayjs from 'dayjs';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

export const REGIMES = [
  { value: 'TT99', label: 'TT 99/2025/TT-BTC (từ năm tài chính 2026)' },
  { value: 'TT133', label: 'TT 133/2016/TT-BTC (DNNVV)' },
  { value: 'TT200', label: 'TT 200/2014/TT-BTC (dữ liệu 2025 trở về trước)' },
];

export default function CompanyWizard() {
  const [step, setStep] = useState(0);
  const { refresh } = useAuth();
  const navigate = useNavigate();
  return (
    <Card title="Tạo công ty mới" style={{ maxWidth: 640, margin: '0 auto' }}>
      <Steps current={step} items={[{ title: 'Thông tin pháp lý' }, { title: 'Năm tài chính' }]} style={{ marginBottom: 24 }} />
      {step === 0 && (
        <Form layout="vertical" onFinish={async (v) => { try { await api('/api/tenants', { method: 'POST', json: v }); await refresh(); setStep(1); } catch (e) { void message.error((e as Error).message); } }}>
          <Form.Item label="Mã công ty" name="code" rules={[{ required: true, pattern: /^[A-Z0-9_]+$/, message: 'Chữ in hoa, số, gạch dưới' }]}><Input /></Form.Item>
          <Form.Item label="Tên công ty" name="name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="Mã số thuế" name="taxCode" rules={[{ pattern: /^\d{10}(-\d{3})?$/, message: '10 chữ số hoặc 10-3' }]}><Input /></Form.Item>
          <Form.Item label="Địa chỉ" name="address"><Input /></Form.Item>
          <Form.Item label="Người đại diện pháp luật" name="legalRep"><Input /></Form.Item>
          <Form.Item label="Kế toán trưởng" name="chiefAccountant"><Input /></Form.Item>
          <Button type="primary" htmlType="submit">Tiếp tục</Button>
        </Form>
      )}
      {step === 1 && (
        <Form layout="vertical" initialValues={{ fiscalYear: 2026, dateFrom: dayjs('2026-01-01'), months: 12, regime: 'TT99' }}
          onFinish={async (v) => { try {
            await api('/api/fiscal-years', { method: 'POST', json: { ...v, dateFrom: (v.dateFrom as dayjs.Dayjs).format('YYYY-MM-DD') } });
            void message.success('Đã tạo năm tài chính'); void navigate({ to: '/' });
          } catch (e) { void message.error((e as Error).message); } }}>
          <Form.Item label="Năm tài chính" name="fiscalYear" rules={[{ required: true }]}><InputNumber min={2000} max={2100} /></Form.Item>
          <Form.Item label="Ngày bắt đầu" name="dateFrom" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" /></Form.Item>
          <Form.Item label="Số tháng (năm đầu tối đa 15)" name="months" rules={[{ required: true }]}><InputNumber min={1} max={15} /></Form.Item>
          <Form.Item label="Chế độ kế toán" name="regime" rules={[{ required: true }]}><Select options={REGIMES} /></Form.Item>
          <Button type="primary" htmlType="submit">Hoàn tất</Button>
        </Form>
      )}
    </Card>
  );
}
```

`apps/web/src/pages/Company.tsx`:

```tsx
import { Button, Card, Form, Input, Select, Tabs, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

interface Company { code: string; name: string; taxCode: string | null; address: string | null; legalRep: string | null; chiefAccountant: string | null; phone: string | null; email: string | null }
interface Settings { book_form: string; costing_method: string; base_currency: string; fx_rate_type: string; hidden_modules: string[]; extra_dims: { key: string; label: string }[] }

export default function CompanyPage() {
  const qc = useQueryClient();
  const company = useQuery({ queryKey: ['company'], queryFn: () => api<Company>('/api/company') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings') });
  const saveCompany = useMutation({ mutationFn: (v: Partial<Company>) => api('/api/company', { method: 'PUT', json: v }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['company'] }); void message.success('Đã lưu'); } });
  const saveSettings = useMutation({ mutationFn: (v: Partial<Settings>) => api('/api/settings', { method: 'PUT', json: v }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settings'] }); void message.success('Đã lưu'); } });
  if (!company.data || !settings.data) return null;
  return (
    <Tabs items={[
      { key: 'phaply', label: 'Thông tin pháp lý', children: (
        <Card><Form layout="vertical" initialValues={company.data} onFinish={(v) => saveCompany.mutate(v)}>
          <Form.Item label="Mã" name="code"><Input disabled /></Form.Item>
          <Form.Item label="Tên công ty" name="name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="Mã số thuế" name="taxCode"><Input /></Form.Item>
          <Form.Item label="Địa chỉ" name="address"><Input /></Form.Item>
          <Form.Item label="Người đại diện pháp luật" name="legalRep"><Input /></Form.Item>
          <Form.Item label="Kế toán trưởng" name="chiefAccountant"><Input /></Form.Item>
          <Form.Item label="Điện thoại" name="phone"><Input /></Form.Item>
          <Form.Item label="Email" name="email"><Input /></Form.Item>
          <Button type="primary" htmlType="submit">Lưu</Button></Form></Card>) },
      { key: 'tuychon', label: 'Tùy chọn hệ thống', children: (
        <Card><Form layout="vertical" initialValues={settings.data} onFinish={(v) => saveSettings.mutate(v)}>
          <Form.Item label="Hình thức sổ" name="book_form"><Select options={[{ value: 'NKC', label: 'Nhật ký chung' }]} /></Form.Item>
          <Form.Item label="Phương pháp giá vốn mặc định" name="costing_method"><Select options={[
            { value: 'avg_period', label: 'Bình quân cuối kỳ' }, { value: 'avg_moving', label: 'Bình quân tức thời' }, { value: 'fifo', label: 'Nhập trước xuất trước' }, { value: 'specific', label: 'Đích danh' }]} /></Form.Item>
          <Form.Item label="Loại tỷ giá ghi sổ" name="fx_rate_type"><Select options={[
            { value: 'transfer_avg', label: 'Mua bán chuyển khoản trung bình' }, { value: 'buy', label: 'Tỷ giá mua' }, { value: 'sell', label: 'Tỷ giá bán' }]} /></Form.Item>
          <Form.Item label="Ẩn phân hệ" name="hidden_modules"><Select mode="multiple" options={['inventory', 'assets', 'payroll', 'costing'].map((m) => ({ value: m, label: m }))} /></Form.Item>
          <Form.List name="extra_dims">{(fields, { add, remove }) => (<>
            <div style={{ marginBottom: 8 }}>Trường mở rộng (chiều phân tích thêm)</div>
            {fields.map((f) => (<div key={f.key} style={{ display: 'flex', gap: 8 }}>
              <Form.Item name={[f.name, 'key']} rules={[{ required: true, pattern: /^[a-z_]+$/ }]}><Input placeholder="ma_thong_ke" /></Form.Item>
              <Form.Item name={[f.name, 'label']} rules={[{ required: true }]}><Input placeholder="Mã thống kê" /></Form.Item>
              <Button onClick={() => remove(f.name)}>Xóa</Button></div>))}
            <Button onClick={() => add()}>Thêm trường</Button></>)}</Form.List>
          <div style={{ marginTop: 16 }}><Button type="primary" htmlType="submit">Lưu</Button></div></Form></Card>) },
    ]} />
  );
}
```

Sửa `apps/web/src/router.tsx`: thêm import 2 trang, route `/he-thong/cong-ty` → `CompanyPage` (con của `appRoute`), route `/he-thong/tao-cong-ty` → `CompanyWizard` (con của `rootRoute`, chỉ cần đăng nhập, không cần tenant), mục menu `{ key: 'company', label: 'Thông tin công ty', to: '/he-thong/cong-ty' }` và `{ key: 'newco', label: 'Tạo công ty mới', to: '/he-thong/tao-cong-ty' }` vào nhóm "Hệ thống". Trang `SelectTenant` thêm nút "Tạo công ty mới" trỏ `/he-thong/tao-cong-ty`.

Run: `pnpm -F @kt/web typecheck && pnpm -F @kt/web test`
Expected: mã 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api apps/web
git commit -m "feat(core): công ty, năm tài chính, kỳ kế toán và tùy chọn hệ thống"
```

---

### Task 6: Mẫu hệ thống tài khoản TT99/TT133/TT200 (gói `@kt/coa-data`)

**Files:**
- Create: `packages/coa-data/package.json`, `packages/coa-data/tsconfig.json`, `packages/coa-data/src/index.ts`, `packages/coa-data/src/load.ts`
- Create: `packages/coa-data/scripts/extract-sunsoft.sh`, `packages/coa-data/scripts/pick-columns.mjs`, `packages/coa-data/scripts/convert-sunsoft-coa.ts`
- Create: `packages/coa-data/reference/sunsoft/*.csv` (sinh bằng script), `packages/coa-data/data/coa/tt133.csv`, `packages/coa-data/data/coa/tt200.csv`, `packages/coa-data/data/coa/tt99.csv`, `packages/coa-data/data/coa/tt99.status.json`, `packages/coa-data/NOTICE.md`
- Create: `packages/domain/src/coaTemplate.ts`; Modify: `packages/domain/src/index.ts`
- Modify: `packages/db/src/reference.ts` (upsert `coa_template`), `packages/db/package.json` (thêm `@kt/coa-data`)
- Test: `packages/domain/test/coaTemplate.test.ts`, `packages/coa-data/test/coa.test.ts`, `packages/db/test/reference.test.ts`

**Interfaces:**
- Consumes: `coa_template` (Task 2); `syncReferenceData` (Task 4a).
- Produces:
  - `interface CoaTemplateRow { regime: Regime; code: string; name: string; nameEn: string | null; parentCode: string | null; isGroup: boolean; rootType: RootType; normalBalance: 'debit'|'credit'|'both'; trackCurrency: boolean; subledgerKind: SubledgerKind | null; source: string }`; `type RootType = 'asset'|'liability'|'equity'|'income'|'expense'|'off_balance'`; `type SubledgerKind = 'receivable'|'payable'|'inventory'|'fixed_asset'|'bank'|'cash'`.
  - `parseCoaCsv(text: string, regime: Regime, source: string): CoaTemplateRow[]`; `validateCoaTemplate(rows): string[]` (danh sách lỗi, rỗng = hợp lệ); `rootTypeOf(code: string): RootType`; `defaultNormalBalance(code: string): 'debit'|'credit'`.
  - `loadCoaTemplate(regime: Regime): CoaTemplateRow[]` (đọc CSV đã đóng gói); `COA_REGIMES = ['TT133','TT200','TT99']`.
  - Định dạng CSV `data/coa/*.csv`: cột `code,name,name_en,parent_code,is_group,normal_balance,track_currency,subledger_kind` (`normal_balance` ∈ `N|C|L`; `is_group`/`track_currency` ∈ `0|1`; `subledger_kind` ∈ rỗng|`receivable`|`payable`|`inventory`|`fixed_asset`|`bank`|`cash`).

- [ ] **Step 1: Viết test bộ phân tích/kiểm tra mẫu tài khoản (thất bại)**

`packages/domain/test/coaTemplate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { defaultNormalBalance, parseCoaCsv, rootTypeOf, validateCoaTemplate } from '../src/coaTemplate.js';

const csv = `code,name,name_en,parent_code,is_group,normal_balance,track_currency,subledger_kind
111,Tiền mặt,Cash,,1,N,0,
1111,Tiền mặt Việt Nam,,111,0,N,0,cash
1112,Tiền mặt ngoại tệ,,111,0,N,1,cash
131,Phải thu của khách hàng,,,0,L,0,receivable
511,Doanh thu bán hàng và cung cấp dịch vụ,,,0,C,0,
`;

describe('coaTemplate', () => {
  it('phân tích CSV sang dòng mẫu', () => {
    const rows = parseCoaCsv(csv, 'TT99', 'test');
    expect(rows).toHaveLength(5);
    expect(rows[1]).toEqual({ regime: 'TT99', code: '1111', name: 'Tiền mặt Việt Nam', nameEn: null, parentCode: '111', isGroup: false,
      rootType: 'asset', normalBalance: 'debit', trackCurrency: false, subledgerKind: 'cash', source: 'test' });
    expect(rows[3]!.normalBalance).toBe('both');
    expect(rows[4]!.rootType).toBe('income');
  });
  it('rootTypeOf và defaultNormalBalance theo chữ số đầu', () => {
    expect(rootTypeOf('1561')).toBe('asset'); expect(rootTypeOf('331')).toBe('liability'); expect(rootTypeOf('4211')).toBe('equity');
    expect(rootTypeOf('711')).toBe('income'); expect(rootTypeOf('642')).toBe('expense'); expect(rootTypeOf('911')).toBe('income'); expect(rootTypeOf('002')).toBe('off_balance');
    expect(defaultNormalBalance('111')).toBe('debit'); expect(defaultNormalBalance('331')).toBe('credit'); expect(defaultNormalBalance('6421')).toBe('debit'); expect(defaultNormalBalance('515')).toBe('credit');
  });
  it('validate phát hiện cha thiếu, mã con không bắt đầu bằng mã cha, nhóm không có con, trùng mã', () => {
    const rows = parseCoaCsv(`code,name,name_en,parent_code,is_group,normal_balance,track_currency,subledger_kind
111,Tiền mặt,,,1,N,0,
1121,TGNH VND,,112,0,N,0,bank
1311,Phải thu,,111,0,N,0,
1311,Phải thu trùng,,111,0,N,0,
`, 'TT99', 'test');
    const errs = validateCoaTemplate(rows);
    expect(errs).toEqual(expect.arrayContaining([
      expect.stringContaining('1121: không có tài khoản cha 112'),
      expect.stringContaining('1311: mã không bắt đầu bằng mã cha 111'),
      expect.stringContaining('1311: trùng mã'),
    ]));
    const errs2 = validateCoaTemplate(parseCoaCsv(csv.replace('1111,Tiền mặt Việt Nam,,111,0,N,0,cash\n1112,Tiền mặt ngoại tệ,,111,0,N,1,cash\n', ''), 'TT99', 'test'));
    expect(errs2).toEqual([expect.stringContaining('111: là tài khoản tổng hợp nhưng không có tài khoản con')]);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/domain test -- test/coaTemplate.test.ts`
Expected: FAIL `Cannot find module '../src/coaTemplate.js'`.

- [ ] **Step 3: Viết `coaTemplate.ts` trong domain**

`packages/domain/src/coaTemplate.ts`:

```ts
import type { Regime } from './period.js';

export type RootType = 'asset' | 'liability' | 'equity' | 'income' | 'expense' | 'off_balance';
export type SubledgerKind = 'receivable' | 'payable' | 'inventory' | 'fixed_asset' | 'bank' | 'cash';
export interface CoaTemplateRow {
  regime: Regime; code: string; name: string; nameEn: string | null; parentCode: string | null; isGroup: boolean;
  rootType: RootType; normalBalance: 'debit' | 'credit' | 'both'; trackCurrency: boolean; subledgerKind: SubledgerKind | null; source: string;
}

export function rootTypeOf(code: string): RootType {
  switch (code[0]) {
    case '1': case '2': return 'asset';
    case '3': return 'liability';
    case '4': return 'equity';
    case '5': case '7': case '9': return 'income';
    case '6': case '8': return 'expense';
    default: return 'off_balance';
  }
}
export function defaultNormalBalance(code: string): 'debit' | 'credit' {
  return ['3', '4', '5', '7'].includes(code[0]!) ? 'credit' : 'debit';
}

// CSV đơn giản: không có dấu phẩy trong tên; nếu cần thì bọc bằng dấu nháy kép.
function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseCoaCsv(text: string, regime: Regime, source: string): CoaTemplateRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = splitCsvLine(lines[0] ?? '');
  const expected = ['code', 'name', 'name_en', 'parent_code', 'is_group', 'normal_balance', 'track_currency', 'subledger_kind'];
  if (header.join(',') !== expected.join(',')) throw new Error(`Tiêu đề CSV phải là: ${expected.join(',')}`);
  return lines.slice(1).map((l, i) => {
    const c = splitCsvLine(l);
    if (c.length !== 8) throw new Error(`Dòng ${i + 2}: cần 8 cột`);
    const nb = c[5] === 'C' ? 'credit' : c[5] === 'L' ? 'both' : c[5] === 'N' ? 'debit' : null;
    if (!nb) throw new Error(`Dòng ${i + 2}: normal_balance phải là N, C hoặc L`);
    const sk = c[7] === '' ? null : (c[7] as SubledgerKind);
    return { regime, code: c[0]!, name: c[1]!, nameEn: c[2] === '' ? null : c[2]!, parentCode: c[3] === '' ? null : c[3]!,
      isGroup: c[4] === '1', rootType: rootTypeOf(c[0]!), normalBalance: nb, trackCurrency: c[6] === '1', subledgerKind: sk, source };
  });
}

export function validateCoaTemplate(rows: CoaTemplateRow[]): string[] {
  const errs: string[] = [];
  const seen = new Set<string>(); const byCode = new Map<string, CoaTemplateRow>(); const children = new Map<string, number>();
  for (const r of rows) {
    if (seen.has(r.code)) errs.push(`${r.code}: trùng mã`); seen.add(r.code); byCode.set(r.code, r);
    if (r.parentCode) children.set(r.parentCode, (children.get(r.parentCode) ?? 0) + 1);
    if (!/^[0-9]{1,8}$/.test(r.code)) errs.push(`${r.code}: mã phải là 1–8 chữ số`);
  }
  for (const r of rows) {
    if (r.parentCode) {
      if (!byCode.has(r.parentCode)) errs.push(`${r.code}: không có tài khoản cha ${r.parentCode}`);
      if (!r.code.startsWith(r.parentCode)) errs.push(`${r.code}: mã không bắt đầu bằng mã cha ${r.parentCode}`);
    }
    if (r.isGroup && !children.has(r.code)) errs.push(`${r.code}: là tài khoản tổng hợp nhưng không có tài khoản con`);
    if (!r.isGroup && children.has(r.code)) errs.push(`${r.code}: có tài khoản con nhưng không đánh dấu tổng hợp`);
  }
  return errs;
}
```

Thêm `export * from './coaTemplate.js';` vào `packages/domain/src/index.ts`.

Run: `pnpm -F @kt/domain test -- test/coaTemplate.test.ts`
Expected: PASS 3 test.

- [ ] **Step 4: Trích bảng tham chiếu từ SUNSOFT (chỉ danh mục/định nghĩa, bỏ cột số liệu)**

`packages/coa-data/scripts/pick-columns.mjs`:

```js
// Dùng: node pick-columns.mjs COL1,COL2,... < in.csv > out.csv  (giữ đúng thứ tự cột yêu cầu)
import { readFileSync } from 'node:fs';
const want = process.argv[2].split(',');
const text = readFileSync(0, 'utf8');
const lines = text.split(/\r?\n/).filter(Boolean);
const split = (l) => { const o = []; let c = ''; let q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (ch === '"') { if (q && l[i+1] === '"') { c += '"'; i++; } else q = !q; } else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const header = split(lines[0]); const idx = want.map((w) => { const i = header.indexOf(w); if (i < 0) throw new Error(`thiếu cột ${w}`); return i; });
console.log(want.join(','));
for (const l of lines.slice(1)) { const c = split(l); console.log(idx.map((i) => esc(c[i] ?? '')).join(',')); }
```

`packages/coa-data/scripts/extract-sunsoft.sh`:

```bash
#!/usr/bin/env bash
# Trích bảng tham chiếu từ bản sao SUNSOFT PRO. Chỉ danh mục/định nghĩa; KHÔNG cột số liệu, KHÔNG bảng giao dịch.
set -euo pipefail
SRC="${SUNSOFT_DIR:-$HOME/Downloads/SUNSOFTPRO}/KTDATA.dat"
OUT="$(dirname "$0")/../reference/sunsoft"; mkdir -p "$OUT"
PICK="node $(dirname "$0")/pick-columns.mjs"
x() { mdb-export -D '%Y-%m-%d' "$SRC" "$1" | $PICK "$2" > "$OUT/$3.csv"; echo "$3: $(($(wc -l < "$OUT/$3.csv") - 1)) dòng"; }
x OrgDMTK     "TK_TI,TEN_TK,TEN_TK_E,LOAI_DU,TK_NTE,CHI_TIET,NHOM_ME,TC_KHAC,CAP_TK" OrgDMTK_133
x OrgDMTK_200 "TK_TI,TEN_TK,TEN_TK_E,LOAI_DU,TK_NTE,CHI_TIET,NHOM_ME,TC_KHAC,CAP_TK" OrgDMTK_200
for R in 99 133 200; do
  x "DesBC_CDKT_B01_$R"    "MASO,TEN_TK,THUYET_MINH,NGUON,TK,LOAI_DU,DK_KHAC,HIEN_AN,KIEU_CHU,SO_AM,MAU_DAM" "DesBC_CDKT_B01_$R" || true
  x "DesBC_KQKD_LAILO_$R"  "MASO,DIEN_GIAI,THUYET_MINH,NHAP,NGUON,TK_TI,TK_DU,LOAI_PS,DIEU_KIEN,HIEN_AN,KIEU_CHU,SO_AM,MAU_DAM" "DesBC_KQKD_LAILO_$R" || true
  x "DesBC_LCTT_TTIEP_$R"  "MASO,CHI_TIEU,TK_NO,LEN_TK_NO,TK_CO,LEN_TK_CO,DK_KHAC,CHI_TIET,THUYET_MINH,NGUON,KIEU_CHU,HIEN_AN,MAU_DAM,SO_AM" "DesBC_LCTT_TTIEP_$R" || true
done
x DesBC_CDKT_B01A_133 "MASO,TEN_TK,THUYET_MINH,NGUON,TK,LOAI_DU,DK_KHAC,HIEN_AN,KIEU_CHU,SO_AM,MAU_DAM" DesBC_CDKT_B01A_133 || true
x DesBC_CDKT_B01B_133 "MASO,TEN_TK,THUYET_MINH,NGUON,TK,LOAI_DU,DK_KHAC,HIEN_AN,KIEU_CHU,SO_AM,MAU_DAM" DesBC_CDKT_B01B_133 || true
x DesHT_Buoc   "BUOC,DIEN_GIAI,PRE_PROC" DesHT_Buoc
x DesHT_KC_CTu "CT_ID,BUOC,STT_CTU,TK_KC,TK_DICH,LOAI_KC,DELAI,MASP,MA_SP,MAVV,MA_VV,DIEN_GIAI" DesHT_KC_CTu
x DesDataErr   "Err_Code,Err_Description,Table_Name,Err_Formula,Err_Help,Err_Check" DesDataErr
x OrgDMCT      "MA_CT,TEN_CT,NHOM_CT,STT,TK_CT,MAU_SO,QD_SO,SOCT_THANG" OrgDMCT
x OrgDMTHUE    "MA_THUE,TEN_THUE,THUE_SUAT,STT" OrgDMTHUE
x OrgDMHTTT    "MA_TT,TEN_TT" OrgDMHTTT
x OrgDMNTE     "MA_NTE,TEN_NTE" OrgDMNTE
```

Run: `chmod +x packages/coa-data/scripts/extract-sunsoft.sh && packages/coa-data/scripts/extract-sunsoft.sh`
Expected: `OrgDMTK_133: 133 dòng`, `OrgDMTK_200: 243 dòng`, `DesBC_CDKT_B01_99: 118 dòng`, `DesBC_KQKD_LAILO_99: 28 dòng`, `DesBC_LCTT_TTIEP_99: 32 dòng`, `DesHT_KC_CTu: 12 dòng`, `DesDataErr: 12 dòng`. Kiểm tra bằng mắt rằng không file nào chứa cột tiền (`grep -l "DU_CUOI\|KY_NAY" packages/coa-data/reference/sunsoft/*.csv` không trả gì).

- [ ] **Step 5: Chuyển `OrgDMTK` → `tt133.csv`, `OrgDMTK_200` → `tt200.csv`; tạo khung `tt99.csv`**

`packages/coa-data/package.json`:

```json
{
  "name": "@kt/coa-data",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } },
  "files": ["data", "reference", "src"],
  "scripts": {
    "build": "tsc -p tsconfig.json && cp -r data dist/",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "extract": "scripts/extract-sunsoft.sh",
    "convert": "tsx scripts/convert-sunsoft-coa.ts"
  },
  "dependencies": { "@kt/domain": "workspace:*" },
  "devDependencies": { "tsx": "^4.19.1" }
}
```

`packages/coa-data/scripts/convert-sunsoft-coa.ts`:

```ts
// Chuyển OrgDMTK (TT133) và OrgDMTK_200 (TT200) của SUNSOFT sang định dạng data/coa/*.csv.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const split = (l: string) => { const o: string[] = []; let c = ''; let q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]!; if (ch === '"') { if (q && l[i + 1] === '"') { c += '"'; i++; } else q = !q; } else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
const esc = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function convert(src: string, dst: string) {
  const lines = readFileSync(path.join(here, '..', 'reference', 'sunsoft', src), 'utf8').split(/\r?\n/).filter(Boolean);
  const h = split(lines[0]!); const col = (r: string[], n: string) => r[h.indexOf(n)] ?? '';
  const rows = lines.slice(1).map(split).filter((r) => /^\d+$/.test(col(r, 'TK_TI')));  // bỏ dòng nhánh gốc 'N', '1'..'9' một chữ số
  const codes = new Set(rows.map((r) => col(r, 'TK_TI')));
  const out = ['code,name,name_en,parent_code,is_group,normal_balance,track_currency,subledger_kind'];
  for (const r of rows) {
    const code = col(r, 'TK_TI'); if (code.length < 3) continue;
    const parent = codes.has(col(r, 'NHOM_ME')) && col(r, 'NHOM_ME').length >= 3 ? col(r, 'NHOM_ME') : '';
    const loaiDu = col(r, 'LOAI_DU');
    const nb = loaiDu === 'C' ? 'C' : loaiDu === 'L' ? 'L' : loaiDu === 'N' ? 'N' : (['3', '4', '5', '7'].includes(code[0]!) ? 'C' : 'N');
    const tc = col(r, 'TC_KHAC');
    const sk = tc === 'CN' ? (code.startsWith('1') ? 'receivable' : 'payable') : tc === 'VT' ? 'inventory' : tc === 'TS' ? 'fixed_asset'
      : code.startsWith('112') && code.length > 3 ? 'bank' : code.startsWith('111') && code.length > 3 ? 'cash' : '';
    out.push([code, esc(col(r, 'TEN_TK')), esc(col(r, 'TEN_TK_E')), parent, col(r, 'CHI_TIET') === '1' ? '0' : '1', nb, col(r, 'TK_NTE') === '1' ? '1' : '0', sk].join(','));
  }
  writeFileSync(path.join(here, '..', 'data', 'coa', dst), out.join('\n') + '\n');
  console.log(`${dst}: ${out.length - 1} tài khoản`);
}
convert('OrgDMTK_133.csv', 'tt133.csv');
convert('OrgDMTK_200.csv', 'tt200.csv');
```

Run: `pnpm install && pnpm -F @kt/coa-data convert`
Expected: `tt133.csv: ~130 tài khoản`, `tt200.csv: ~240 tài khoản` (số chính xác bằng số dòng có mã ≥ 3 chữ số). Sau đó **rà bằng tay** `tt133.csv` với Phụ lục 1 TT 133/2016 và `tt200.csv` với Phụ lục 1 TT 200/2014; sửa tên tài khoản SUNSOFT viết tắt/không dấu (`OrgDMTK_200` có tên không dấu như "TAI SAN LUU ĐONG") thành đúng tên trong thông tư; thêm `is_group=1` cho tài khoản cấp 1 có tiểu khoản.

`packages/coa-data/data/coa/tt99.csv` tạo với **chỉ dòng tiêu đề**:

```
code,name,name_en,parent_code,is_group,normal_balance,track_currency,subledger_kind
```

`packages/coa-data/data/coa/tt99.status.json`:

```json
{ "complete": false, "source": "", "note": "Nhập toàn bộ Phụ lục II TT 99/2025/TT-BTC từ văn bản gốc (Công báo). Đối chiếu: cột TK của reference/sunsoft/DesBC_CDKT_B01_99.csv và TK_TI/TK_DU của DesBC_KQKD_LAILO_99.csv phải tồn tại trong tt99.csv; các tài khoản mới 137, 215, 2295, 246, 332, 351, 1383 phải có; các tài khoản bỏ 161, 417, 441, 461, 466, 611, 631 không được có. Khi xong đặt complete=true và ghi source." }
```

**Quy trình nhập TT99 (bắt buộc làm, không được bịa):** (1) lấy Phụ lục II TT 99/2025 từ Công báo/thuvienphapluat bản PDF gốc; (2) nhập từng tài khoản cấp 1, 2, 3 theo đúng số hiệu và tên; (3) `LOAI_DU` theo bản chất tài khoản (131/331/138/338/1388/3388: `L`); (4) `subledger_kind`: 131 nhánh → `receivable`, 331 nhánh → `payable`, 141/136/1388 → `receivable`, 336/3388 → `payable`, 15x → `inventory`, 211/212/213 → `fixed_asset`, 1121/1122 → `bank`, 1111/1112 → `cash`; (5) chạy test ở bước 7; (6) đặt `complete=true`.

`packages/coa-data/NOTICE.md`:

```markdown
Dữ liệu danh mục tài khoản TT133/TT200 được trích từ bảng danh mục mẫu của SUNSOFT PRO (chỉ số hiệu, tên, thuộc tính) để đối chiếu, sau đó rà soát với Phụ lục 1 TT 133/2016/TT-BTC và TT 200/2014/TT-BTC. Hệ thống tài khoản là văn bản quy phạm pháp luật, không thuộc phạm vi bảo hộ quyền tác giả (Luật Sở hữu trí tuệ Điều 15). Không có dữ liệu giao dịch nào của bất kỳ doanh nghiệp nào được trích.
```

- [ ] **Step 6: Viết loader và test dữ liệu**

`packages/coa-data/src/load.ts`:

```ts
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoaCsv, type CoaTemplateRow, type Regime } from '@kt/domain';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const COA_REGIMES: Regime[] = ['TT133', 'TT200', 'TT99'];
const SOURCE: Record<string, string> = {
  TT133: 'Phụ lục 1 TT 133/2016/TT-BTC (đối chiếu SUNSOFT OrgDMTK)',
  TT200: 'Phụ lục 1 TT 200/2014/TT-BTC (đối chiếu SUNSOFT OrgDMTK_200, Odoo l10n_vn)',
  TT99: 'Phụ lục II TT 99/2025/TT-BTC',
};
export function dataPath(...p: string[]): string { return path.join(dataDir, ...p); }
export function loadCoaTemplate(regime: Regime): CoaTemplateRow[] {
  return parseCoaCsv(readFileSync(dataPath('coa', `${regime.toLowerCase()}.csv`), 'utf8'), regime, SOURCE[regime] ?? regime);
}
export function tt99Status(): { complete: boolean; source: string } {
  const p = dataPath('coa', 'tt99.status.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { complete: boolean; source: string }) : { complete: false, source: '' };
}
```

`packages/coa-data/src/index.ts`: `export * from './load.js';`

`packages/coa-data/test/coa.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateCoaTemplate } from '@kt/domain';
import { COA_REGIMES, dataPath, loadCoaTemplate, tt99Status } from '../src/index.js';

const refCodes = (file: string, col: string): string[] => {
  const lines = readFileSync(dataPath('..', 'reference', 'sunsoft', file), 'utf8').split(/\r?\n/).filter(Boolean);
  const h = lines[0]!.split(','); const i = h.indexOf(col);
  return lines.slice(1).map((l) => l.split(',')[i]?.replace(/"/g, '') ?? '').filter((v) => /^\d{3,}$/.test(v));
};

describe('mẫu hệ thống tài khoản', () => {
  for (const regime of COA_REGIMES) {
    it(`${regime}: cấu trúc hợp lệ`, () => {
      const rows = loadCoaTemplate(regime);
      expect(validateCoaTemplate(rows)).toEqual([]);
    });
  }
  it('TT133 có 131/331 lưỡng tính, 1112/1122 theo dõi ngoại tệ, đủ tài khoản SUNSOFT', () => {
    const rows = loadCoaTemplate('TT133'); const by = new Map(rows.map((r) => [r.code, r]));
    expect(by.get('131')?.normalBalance).toBe('both'); expect(by.get('131')?.subledgerKind).toBe('receivable');
    expect(by.get('331')?.subledgerKind).toBe('payable'); expect(by.get('1112')?.trackCurrency).toBe(true);
    for (const c of refCodes('OrgDMTK_133.csv', 'TK_TI')) expect(by.has(c), `thiếu ${c}`).toBe(true);
  });
  it('TT200 đủ tài khoản SUNSOFT OrgDMTK_200', () => {
    const by = new Set(loadCoaTemplate('TT200').map((r) => r.code));
    for (const c of refCodes('OrgDMTK_200.csv', 'TK_TI')) expect(by.has(c), `thiếu ${c}`).toBe(true);
  });
  it('TT99: đối chiếu Phụ lục II và DesBC_*_99 (chỉ chạy khi complete=true)', (t) => {
    const st = tt99Status();
    if (!st.complete) { console.warn('CẢNH BÁO: tt99.csv chưa hoàn tất, bỏ qua kiểm tra đối chiếu TT99'); t.skip(); return; }
    const by = new Set(loadCoaTemplate('TT99').map((r) => r.code));
    for (const c of ['137', '215', '2295', '246', '332', '351', '1383']) expect(by.has(c), `thiếu TK mới ${c}`).toBe(true);
    for (const c of ['161', '417', '441', '461', '466', '611', '631']) expect(by.has(c), `TK ${c} đã bỏ theo TT99`).toBe(false);
    for (const c of refCodes('DesBC_CDKT_B01_99.csv', 'TK')) expect(by.has(c), `B01 tham chiếu ${c}`).toBe(true);
    for (const c of [...refCodes('DesBC_KQKD_LAILO_99.csv', 'TK_TI'), ...refCodes('DesBC_KQKD_LAILO_99.csv', 'TK_DU')]) expect(by.has(c), `B02 tham chiếu ${c}`).toBe(true);
  });
});
```

Run: `pnpm -F @kt/coa-data test`
Expected: PASS 5, skip 1 (TT99 cảnh báo). Khi tt99 nhập xong và `complete=true`: PASS 6.

- [ ] **Step 7: Nạp `coa_template` trong `syncReferenceData` và test**

Sửa `packages/db/package.json`: thêm `"@kt/coa-data": "workspace:*"` vào dependencies. Sửa `packages/db/src/reference.ts`, trong transaction sau vòng lặp permission:

```ts
import { COA_REGIMES, loadCoaTemplate } from '@kt/coa-data';
// ...
for (const regime of COA_REGIMES) {
  const rows = loadCoaTemplate(regime);
  await client.query('DELETE FROM coa_template WHERE regime = $1', [regime]);
  for (const r of rows) {
    await client.query(
      `INSERT INTO coa_template(regime, code, name, name_en, parent_code, is_group, root_type, normal_balance, track_currency, subledger_kind, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [r.regime, r.code, r.name, r.nameEn, r.parentCode, r.isGroup, r.rootType, r.normalBalance, r.trackCurrency, r.subledgerKind, r.source]);
  }
}
```

`packages/db/test/reference.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { setupTestDb, type TestDb } from '../src/testing.js';

let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });

describe('dữ liệu tham chiếu', () => {
  it('permission và coa_template được nạp, app_user không sửa được', async () => {
    const p = await sql<{ n: string }>`SELECT count(*) AS n FROM permission`.execute(t.admin);
    expect(Number(p.rows[0]!.n)).toBeGreaterThan(30);
    const c = await sql<{ regime: string; n: string }>`SELECT regime, count(*) AS n FROM coa_template GROUP BY regime ORDER BY regime`.execute(t.admin);
    expect(c.rows.find((r) => r.regime === 'TT133')!.n).toMatch(/^\d{3}$/);
    await expect(sql`INSERT INTO coa_template(regime, code, name, root_type, normal_balance, source) VALUES ('TT133','999','x','asset','debit','x')`.execute(t.db)).rejects.toThrow(/permission denied/);
  });
});
```

Run: `pnpm -F @kt/db test -- test/reference.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/coa-data packages/domain packages/db
git commit -m "feat(coa-data): mẫu hệ thống tài khoản TT133/TT200 từ SUNSOFT và khung TT99 chờ Phụ lục II"
```

---

### Task 7: Sinh hệ thống tài khoản công ty từ mẫu, thêm tiểu khoản, đổi số hiệu, ghép tài khoản, màn hình cây tài khoản

**Files:**
- Create: `packages/db/migrations/0002_account_rules.sql`
- Create: `apps/api/src/modules/coa/service.ts`, `apps/api/src/modules/coa/routes.ts`
- Modify: `apps/api/src/app.ts` (đăng ký route), `apps/api/src/modules/core/fiscalYears.ts` (sau khi tạo năm, nếu chưa có tài khoản của `regime` thì gọi `generateAccounts`)
- Create: `apps/web/src/pages/Accounts.tsx`; Modify: `apps/web/src/router.tsx`
- Test: `apps/api/test/coa.test.ts`

**Interfaces:**
- Consumes: `coa_template`, `account` (Task 2); `createFiscalYear` (Task 5).
- Produces:
  - `generateAccounts(trx, tenantId, regime): Promise<number>`; `addSubAccount(trx, tenantId, input: { regime; parentCode; code; name; nameEn?; normalBalance?; trackCurrency?; subledgerKind? }): Promise<number>`; `renameAccount(trx, tenantId, input: { regime; oldCode; newCode }): Promise<void>`; `mergeAccounts(trx, tenantId, input: { regime; sourceCode; targetCode }): Promise<void>`; `listAccounts(trx, regime): Promise<AccountDto[]>`; `AccountDto = { id: number; code; name; nameEn; parentId; isGroup; rootType; normalBalance; trackCurrency; subledgerKind; isActive }`.
  - Route: `GET /api/accounts?regime=TT99`, `POST /api/accounts/generate { regime }`, `POST /api/accounts { regime, parentCode, code, name, ... }`, `PUT /api/accounts/:id { name?, nameEn?, isActive?, trackCurrency?, subledgerKind? }`, `POST /api/accounts/rename { regime, oldCode, newCode }`, `POST /api/accounts/merge { regime, sourceCode, targetCode }`.
  - Trigger SQL `fn_account_check()` (mã con bắt đầu bằng mã cha; cha cùng `regime`/`tenant`; cha tự chuyển `is_group=true` khi có con đầu tiên). Task 14 bổ sung chặn đổi mã/xóa khi đã có dòng sổ cái.

- [ ] **Step 1: Viết test (thất bại)**

`apps/api/test/coa.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('hệ thống tài khoản công ty', () => {
  it('tạo năm TT133 tự sinh tài khoản từ mẫu; cây có cha/con đúng', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `CA${Date.now()}` });
    await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/accounts?regime=TT133', headers: { cookie } });
    const rows = r.json() as { code: string; parentId: number | null; id: number; isGroup: boolean }[];
    expect(rows.length).toBeGreaterThan(100);
    const a111 = rows.find((x) => x.code === '111')!; const a1111 = rows.find((x) => x.code === '1111')!;
    expect(a1111.parentId).toBe(a111.id); expect(a111.isGroup).toBe(true);
    const again = await ctx.app.inject({ method: 'POST', url: '/api/accounts/generate', headers: { cookie }, payload: { regime: 'TT133' } });
    expect(again.json().error.code).toBe('ACCOUNTS_EXIST');
  });

  it('thêm tiểu khoản: cha thành tổng hợp; mã không bắt đầu bằng mã cha bị từ chối', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `CB${Date.now()}` });
    await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie }, payload: { regime: 'TT133', parentCode: '1121', code: '11211', name: 'TGNH Vietcombank' } });
    expect(ok.statusCode).toBe(201);
    const list = (await ctx.app.inject({ method: 'GET', url: '/api/accounts?regime=TT133', headers: { cookie } })).json() as { code: string; isGroup: boolean; subledgerKind: string | null }[];
    expect(list.find((x) => x.code === '1121')!.isGroup).toBe(true);
    expect(list.find((x) => x.code === '11211')!.subledgerKind).toBe('bank');
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie }, payload: { regime: 'TT133', parentCode: '1121', code: '11311', name: 'Sai' } });
    expect(bad.statusCode).toBe(409); expect(bad.json().error.code).toBe('ACCOUNT_CODE_PREFIX');
  });

  it('đổi số hiệu đổi cả con; ghép tài khoản chuyển con sang đích và xóa nguồn', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `CC${Date.now()}` });
    await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
    await ctx.app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie }, payload: { regime: 'TT133', parentCode: '1121', code: '11211', name: 'VCB' } });
    await ctx.app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie }, payload: { regime: 'TT133', parentCode: '1121', code: '11212', name: 'ACB' } });
    const rn = await ctx.app.inject({ method: 'POST', url: '/api/accounts/rename', headers: { cookie }, payload: { regime: 'TT133', oldCode: '1121', newCode: '1129' } });
    expect(rn.statusCode).toBe(200);
    let codes = ((await ctx.app.inject({ method: 'GET', url: '/api/accounts?regime=TT133', headers: { cookie } })).json() as { code: string }[]).map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['1129', '11291', '11292'])); expect(codes).not.toContain('1121');
    const mg = await ctx.app.inject({ method: 'POST', url: '/api/accounts/merge', headers: { cookie }, payload: { regime: 'TT133', sourceCode: '11292', targetCode: '11291' } });
    expect(mg.statusCode).toBe(200);
    codes = ((await ctx.app.inject({ method: 'GET', url: '/api/accounts?regime=TT133', headers: { cookie } })).json() as { code: string }[]).map((x) => x.code);
    expect(codes).not.toContain('11292');
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/api test -- test/coa.test.ts`
Expected: FAIL (404 / `rows.length` 0).

- [ ] **Step 3: Migration quy tắc tài khoản**

`packages/db/migrations/0002_account_rules.sql`:

```sql
CREATE OR REPLACE FUNCTION fn_account_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p account%ROWTYPE;
BEGIN
  -- Đổi số hiệu cả cây: từng dòng UPDATE thấy cha chưa đổi, nên bỏ kiểm tra tiền tố khi app.bulk_rename = on (toàn cây đổi cùng tiền tố).
  IF current_setting('app.bulk_rename', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO p FROM account WHERE id = NEW.parent_id;
    IF p.tenant_id <> NEW.tenant_id OR p.regime <> NEW.regime THEN
      RAISE EXCEPTION 'ACCOUNT_PARENT_MISMATCH: tài khoản cha khác công ty hoặc chế độ' USING ERRCODE = 'P0001';
    END IF;
    IF left(NEW.code, length(p.code)) <> p.code OR length(NEW.code) <= length(p.code) THEN
      RAISE EXCEPTION 'ACCOUNT_CODE_PREFIX: mã % phải bắt đầu bằng mã cha %', NEW.code, p.code USING ERRCODE = 'P0001';
    END IF;
    IF NOT p.is_group THEN UPDATE account SET is_group = true WHERE id = p.id; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_account_check BEFORE INSERT OR UPDATE OF code, parent_id ON account FOR EACH ROW EXECUTE FUNCTION fn_account_check();

-- Khi xóa con cuối cùng, cha trở lại tài khoản chi tiết.
CREATE OR REPLACE FUNCTION fn_account_after_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM account WHERE parent_id = OLD.parent_id) THEN
    UPDATE account SET is_group = false WHERE id = OLD.parent_id;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_account_after_delete AFTER DELETE ON account FOR EACH ROW EXECUTE FUNCTION fn_account_after_delete();
```

- [ ] **Step 4: Service và route**

`apps/api/src/modules/coa/service.ts`:

```ts
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { defaultNormalBalance, rootTypeOf, type Regime } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

export interface AccountDto { id: number; code: string; name: string; nameEn: string | null; parentId: number | null; isGroup: boolean; rootType: string; normalBalance: string; trackCurrency: boolean; subledgerKind: string | null; isActive: boolean }

const toDto = (a: { id: number; code: string; name: string; name_en: string | null; parent_id: number | null; is_group: boolean; root_type: string; normal_balance: string; track_currency: boolean; subledger_kind: string | null; is_active: boolean }): AccountDto =>
  ({ id: a.id, code: a.code, name: a.name, nameEn: a.name_en, parentId: a.parent_id, isGroup: a.is_group, rootType: a.root_type, normalBalance: a.normal_balance, trackCurrency: a.track_currency, subledgerKind: a.subledger_kind, isActive: a.is_active });

export async function listAccounts(trx: Transaction<Database>, regime: string): Promise<AccountDto[]> {
  return (await trx.selectFrom('account').selectAll().where('regime', '=', regime).orderBy('code').execute()).map(toDto);
}

export async function generateAccounts(trx: Transaction<Database>, tenantId: string, regime: Regime): Promise<number> {
  const existing = await trx.selectFrom('account').select('id').where('regime', '=', regime).limit(1).executeTakeFirst();
  if (existing) throw new AppError('ACCOUNTS_EXIST', `Công ty đã có hệ thống tài khoản ${regime}`, 409);
  const tpl = await trx.selectFrom('coa_template').selectAll().where('regime', '=', regime).orderBy(sql`length(code)`).orderBy('code').execute();
  if (tpl.length === 0) throw new AppError('TEMPLATE_EMPTY', `Chưa có mẫu hệ thống tài khoản ${regime} (xem packages/coa-data)`, 409);
  const idByCode = new Map<string, number>();
  for (const t of tpl) {
    const r = await trx.insertInto('account').values({
      tenant_id: tenantId, regime, code: t.code, name: t.name, name_en: t.name_en, parent_id: t.parent_code ? idByCode.get(t.parent_code) ?? null : null,
      is_group: t.is_group, root_type: t.root_type, normal_balance: t.normal_balance, track_currency: t.track_currency, subledger_kind: t.subledger_kind,
    }).returning('id').executeTakeFirstOrThrow();
    idByCode.set(t.code, r.id);
  }
  return tpl.length;
}

export async function addSubAccount(trx: Transaction<Database>, tenantId: string, input: { regime: string; parentCode: string; code: string; name: string; nameEn?: string | undefined; normalBalance?: 'debit' | 'credit' | 'both' | undefined; trackCurrency?: boolean | undefined; subledgerKind?: string | null | undefined }): Promise<number> {
  const parent = await trx.selectFrom('account').selectAll().where('regime', '=', input.regime).where('code', '=', input.parentCode).executeTakeFirst();
  if (!parent) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản ${input.parentCode}`, 404);
  const r = await trx.insertInto('account').values({
    tenant_id: tenantId, regime: input.regime, code: input.code, name: input.name, name_en: input.nameEn ?? null, parent_id: parent.id,
    root_type: rootTypeOf(input.code), normal_balance: input.normalBalance ?? parent.normal_balance ?? defaultNormalBalance(input.code),
    track_currency: input.trackCurrency ?? parent.track_currency, subledger_kind: input.subledgerKind === undefined ? parent.subledger_kind : input.subledgerKind,
  }).returning('id').executeTakeFirstOrThrow();
  return r.id;
}

export async function renameAccount(trx: Transaction<Database>, _tenantId: string, input: { regime: string; oldCode: string; newCode: string }): Promise<void> {
  const acc = await trx.selectFrom('account').select('id').where('regime', '=', input.regime).where('code', '=', input.oldCode).executeTakeFirst();
  if (!acc) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản ${input.oldCode}`, 404);
  if (!/^\d{1,8}$/.test(input.newCode)) throw new AppError('ACCOUNT_CODE_INVALID', 'Mã phải là 1–8 chữ số', 400);
  // Đổi cả cây (tài khoản và mọi tài khoản con) cùng một tiền tố; trigger tiền tố được tạm bỏ qua bằng biến phiên trong transaction này.
  await sql`SELECT set_config('app.bulk_rename', 'on', true)`.execute(trx);
  await sql`UPDATE account SET code = ${input.newCode} || substr(code, ${input.oldCode.length + 1})
            WHERE regime = ${input.regime} AND (code = ${input.oldCode} OR code LIKE ${input.oldCode + '%'})`.execute(trx);
  await sql`SELECT set_config('app.bulk_rename', 'off', true)`.execute(trx);
}

export async function mergeAccounts(trx: Transaction<Database>, _tenantId: string, input: { regime: string; sourceCode: string; targetCode: string }): Promise<void> {
  const src = await trx.selectFrom('account').selectAll().where('regime', '=', input.regime).where('code', '=', input.sourceCode).executeTakeFirst();
  const dst = await trx.selectFrom('account').selectAll().where('regime', '=', input.regime).where('code', '=', input.targetCode).executeTakeFirst();
  if (!src || !dst) throw new AppError('ACCOUNT_NOT_FOUND', 'Không có tài khoản nguồn hoặc đích', 404);
  if (src.root_type !== dst.root_type) throw new AppError('ACCOUNT_ROOT_MISMATCH', 'Hai tài khoản khác loại', 409);
  // Con của nguồn chuyển sang đích với mã đổi tiền tố.
  await sql`UPDATE account SET parent_id = ${dst.id}, code = ${dst.code} || substr(code, ${src.code.length + 1})
            WHERE parent_id = ${src.id}`.execute(trx);
  await trx.deleteFrom('account').where('id', '=', src.id).execute();
}
```

`apps/api/src/modules/coa/routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { addSubAccount, generateAccounts, listAccounts, mergeAccounts, renameAccount } from './service.js';

const regime = z.enum(['TT99', 'TT133', 'TT200', 'TT58']);
const code = z.string().regex(/^\d{1,8}$/);

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/accounts', { preHandler: app.requirePermission('account.view'), schema: { querystring: z.object({ regime }) } },
    async (req) => app.withTenant(req, (trx) => listAccounts(trx, req.query.regime)));
  app.post('/api/accounts/generate', { preHandler: app.requirePermission('account.create'), schema: { body: z.object({ regime }) } },
    async (req, reply) => reply.status(201).send({ count: await app.withTenant(req, (trx) => generateAccounts(trx, req.auth!.tenantId!, req.body.regime)) }));
  app.post('/api/accounts', { preHandler: app.requirePermission('account.create'), schema: { body: z.object({
      regime, parentCode: code, code, name: z.string().min(1), nameEn: z.string().optional(),
      normalBalance: z.enum(['debit', 'credit', 'both']).optional(), trackCurrency: z.boolean().optional(),
      subledgerKind: z.enum(['receivable', 'payable', 'inventory', 'fixed_asset', 'bank', 'cash']).nullable().optional() }) } },
    async (req, reply) => reply.status(201).send({ id: await app.withTenant(req, (trx) => addSubAccount(trx, req.auth!.tenantId!, req.body)) }));
  app.put('/api/accounts/:id', { preHandler: app.requirePermission('account.update'), schema: { params: z.object({ id: z.coerce.number() }), body: z.object({
      name: z.string().min(1).optional(), nameEn: z.string().nullable().optional(), isActive: z.boolean().optional(), trackCurrency: z.boolean().optional(),
      subledgerKind: z.enum(['receivable', 'payable', 'inventory', 'fixed_asset', 'bank', 'cash']).nullable().optional() }) } },
    async (req) => { const b = req.body; await app.withTenant(req, (trx) => trx.updateTable('account').set({
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.nameEn !== undefined ? { name_en: b.nameEn } : {}), ...(b.isActive !== undefined ? { is_active: b.isActive } : {}),
      ...(b.trackCurrency !== undefined ? { track_currency: b.trackCurrency } : {}), ...(b.subledgerKind !== undefined ? { subledger_kind: b.subledgerKind } : {}) }).where('id', '=', req.params.id).execute()); return { ok: true }; });
  app.post('/api/accounts/rename', { preHandler: app.requirePermission('account.update'), schema: { body: z.object({ regime, oldCode: code, newCode: code }) } },
    async (req) => { await app.withTenant(req, (trx) => renameAccount(trx, req.auth!.tenantId!, req.body)); return { ok: true }; });
  app.post('/api/accounts/merge', { preHandler: app.requirePermission('account.update'), schema: { body: z.object({ regime, sourceCode: code, targetCode: code }) } },
    async (req) => { await app.withTenant(req, (trx) => mergeAccounts(trx, req.auth!.tenantId!, req.body)); return { ok: true }; });
};
export default routes;
```

Sửa `apps/api/src/modules/core/fiscalYears.ts` cuối `createFiscalYear` trước `return`: 

```ts
const hasAccounts = await trx.selectFrom('account').select('id').where('regime', '=', input.regime).limit(1).executeTakeFirst();
if (!hasAccounts) await generateAccounts(trx, tenantId, input.regime as Regime);
```

(import `generateAccounts` từ `../coa/service.js`). Đăng ký `coaRoutes` trong `app.ts`.

- [ ] **Step 5: Chạy test**

Run: `pnpm -F @kt/api test -- test/coa.test.ts`
Expected: PASS 3 test.

- [ ] **Step 6: Màn hình cây tài khoản**

`apps/web/src/pages/Accounts.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Select, Space, Table, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

interface Acc { id: number; code: string; name: string; parentId: number | null; isGroup: boolean; normalBalance: string; trackCurrency: boolean; subledgerKind: string | null; isActive: boolean; children?: Acc[] }
const NB: Record<string, string> = { debit: 'Dư Nợ', credit: 'Dư Có', both: 'Lưỡng tính' };
const SK: Record<string, string> = { receivable: 'Phải thu', payable: 'Phải trả', inventory: 'Vật tư', fixed_asset: 'TSCĐ', bank: 'Ngân hàng', cash: 'Tiền mặt' };

export function buildTree(rows: Acc[]): Acc[] {
  const by = new Map<number, Acc>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: Acc[] = [];
  for (const a of by.values()) { if (a.parentId && by.has(a.parentId)) by.get(a.parentId)!.children!.push(a); else roots.push(a); }
  const strip = (xs: Acc[]): Acc[] => xs.map((x) => (x.children!.length ? { ...x, children: strip(x.children!) } : { ...x, children: undefined }));
  return strip(roots);
}

export default function AccountsPage() {
  const { can } = useAuth(); const qc = useQueryClient();
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<{ fiscalYear: number; regime: string }[]>('/api/fiscal-years') });
  const [regime, setRegime] = useState<string | undefined>();
  const current = regime ?? years.data?.at(-1)?.regime;
  const accounts = useQuery({ queryKey: ['accounts', current], queryFn: () => api<Acc[]>(`/api/accounts?regime=${current}`), enabled: !!current });
  const tree = useMemo(() => buildTree(accounts.data ?? []), [accounts.data]);
  const [modal, setModal] = useState<{ kind: 'sub' | 'rename' | 'merge'; code: string } | null>(null);
  const [form] = Form.useForm();
  const run = useMutation({
    mutationFn: (v: Record<string, unknown>) => modal!.kind === 'sub' ? api('/api/accounts', { method: 'POST', json: { regime: current, parentCode: modal!.code, ...v } })
      : modal!.kind === 'rename' ? api('/api/accounts/rename', { method: 'POST', json: { regime: current, oldCode: modal!.code, newCode: v.newCode } })
      : api('/api/accounts/merge', { method: 'POST', json: { regime: current, sourceCode: modal!.code, targetCode: v.targetCode } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['accounts'] }); setModal(null); form.resetFields(); void message.success('Đã lưu'); },
    onError: (e) => void message.error((e as Error).message) });
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <span>Chế độ kế toán</span>
        <Select style={{ width: 120 }} value={current} onChange={setRegime} options={[...new Set((years.data ?? []).map((y) => y.regime))].map((r) => ({ value: r, label: r }))} />
      </Space>
      <Table<Acc> rowKey="id" dataSource={tree} pagination={false} size="small" expandable={{ defaultExpandAllRows: false }} columns={[
        { title: 'Số hiệu', dataIndex: 'code', width: 140 }, { title: 'Tên tài khoản', dataIndex: 'name' },
        { title: 'Loại dư', dataIndex: 'normalBalance', width: 110, render: (v: string) => NB[v] },
        { title: 'Theo dõi', width: 200, render: (_, a) => <>{a.subledgerKind && <Tag>{SK[a.subledgerKind]}</Tag>}{a.trackCurrency && <Tag>Ngoại tệ</Tag>}{a.isGroup && <Tag color="blue">Tổng hợp</Tag>}</> },
        { title: '', width: 260, render: (_, a) => can('account.update') && (<Space>
          <a onClick={() => setModal({ kind: 'sub', code: a.code })}>Thêm tiểu khoản</a>
          <a onClick={() => setModal({ kind: 'rename', code: a.code })}>Đổi số hiệu</a>
          {!a.isGroup && <a onClick={() => setModal({ kind: 'merge', code: a.code })}>Ghép</a>}</Space>) }]} />
      <Modal open={!!modal} onCancel={() => setModal(null)} onOk={() => form.submit()} destroyOnClose
        title={modal?.kind === 'sub' ? `Thêm tiểu khoản của ${modal.code}` : modal?.kind === 'rename' ? `Đổi số hiệu ${modal.code}` : `Ghép ${modal?.code} vào tài khoản khác`}>
        <Form form={form} layout="vertical" onFinish={(v) => run.mutate(v)}>
          {modal?.kind === 'sub' && (<>
            <Form.Item label="Số hiệu" name="code" rules={[{ required: true, pattern: /^\d{1,8}$/ }]}><Input /></Form.Item>
            <Form.Item label="Tên tài khoản" name="name" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item label="Loại dư" name="normalBalance"><Select allowClear options={Object.entries(NB).map(([value, label]) => ({ value, label }))} /></Form.Item>
            <Form.Item label="Theo dõi chi tiết" name="subledgerKind"><Select allowClear options={Object.entries(SK).map(([value, label]) => ({ value, label }))} /></Form.Item></>)}
          {modal?.kind === 'rename' && <Form.Item label="Số hiệu mới" name="newCode" rules={[{ required: true, pattern: /^\d{1,8}$/ }]}><Input /></Form.Item>}
          {modal?.kind === 'merge' && <Form.Item label="Ghép vào tài khoản" name="targetCode" rules={[{ required: true }]}><Input /></Form.Item>}
        </Form>
      </Modal>
    </>
  );
}
```

Sửa `apps/web/src/router.tsx`: route `/danh-muc/he-thong-tai-khoan` → `AccountsPage`; nhóm menu mới `{ key: 'danhmuc', label: 'Danh mục', to: '/danh-muc', children: [{ key: 'accounts', label: 'Hệ thống tài khoản', to: '/danh-muc/he-thong-tai-khoan', permission: 'account.view' }] }`.

`apps/web/test/Accounts.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { buildTree } from '../src/pages/Accounts.js';

describe('buildTree', () => {
  it('xếp tài khoản con dưới cha', () => {
    const t = buildTree([
      { id: 1, code: '111', name: 'Tiền mặt', parentId: null, isGroup: true, normalBalance: 'debit', trackCurrency: false, subledgerKind: null, isActive: true },
      { id: 2, code: '1111', name: 'VND', parentId: 1, isGroup: false, normalBalance: 'debit', trackCurrency: false, subledgerKind: 'cash', isActive: true },
      { id: 3, code: '131', name: 'Phải thu', parentId: null, isGroup: false, normalBalance: 'both', trackCurrency: false, subledgerKind: 'receivable', isActive: true }]);
    expect(t).toHaveLength(2); expect(t[0]!.children![0]!.code).toBe('1111'); expect(t[1]!.children).toBeUndefined();
  });
});
```

Run: `pnpm -F @kt/web test && pnpm -F @kt/web typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db apps/api apps/web
git commit -m "feat(coa): sinh hệ thống tài khoản từ mẫu, tiểu khoản, đổi số hiệu, ghép và màn hình cây"
```

---

### Task 8: Danh mục khung: migration, CRUD tổng quát, nhật ký kiểm toán tự động

**Files:**
- Create: `packages/db/migrations/0003_danh_muc.sql`
- Modify: `packages/db/src/types.ts` (thêm 14 bảng vào `Database`)
- Create: `apps/api/src/modules/master/catalogs.ts`, `apps/api/src/modules/master/crud.ts`, `apps/api/src/modules/master/routes.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/catalogs.test.ts`

**Interfaces:**
- Consumes: `rls_enable`, `audit_enable` (Task 2); `requirePermission('catalog.*')` (Task 4a).
- Produces:
  - Bảng: `party_group`, `party`, `party_bank_account`, `department`, `employee`, `currency`, `exchange_rate`, `bank`, `bank_account`, `payment_method`, `tax_code`, `invoice_group`, `cost_item`, `project`, `uom` (mọi bảng có `tenant_id`, `id`, phần lớn có `code`, `name`, `is_active`).
  - `CATALOGS: CatalogDef[]` với `CatalogDef = { name: string; table: keyof Database; label: string; schema: z.ZodObject<any>; columns: ColumnDef[]; uniqueBy: string[]; sort: string }`, `ColumnDef = { key: string; label: string; type: 'text'|'number'|'boolean'|'date'|'select'; required?: boolean; options?: {value: string; label: string}[]; lookup?: { catalog: string } }`. Khóa `key` là snake_case trùng tên cột DB; trường tham chiếu dùng `<x>_code` ở API/Excel và được đổi sang `<x>_id` khi ghi.
  - `registerCatalog(app, def)` sinh: `GET /api/catalogs/:name?q=&page=&size=` → `{ rows, total }`; `GET /api/catalogs/:name/:id`; `POST /api/catalogs/:name`; `PUT /api/catalogs/:name/:id`; `DELETE /api/catalogs/:name/:id`; `GET /api/catalogs` → danh sách `CatalogDef` không có `schema`.
  - `resolveLookups(trx, def, row)`: đổi `*_code` → `*_id` (ném `LOOKUP_NOT_FOUND` kèm tên cột và mã).
  - Seed mặc định khi tạo công ty (bổ sung vào `create_tenant`): `currency` VND/USD, `payment_method` TM/CK/TM-CK, `tax_code` V0/V5/V8/V10/KCT/KKK/NK/TTDB, `invoice_group` mua 01–05 và bán 00/05/08/10/KCT, `uom` Cái/Chiếc/Bộ/Giờ/Tháng.

- [ ] **Step 1: Viết test (thất bại)**

`apps/api/test/catalogs.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => { ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `DM${Date.now()}` })); });
afterAll(async () => { await ctx.close(); });

const SAMPLES: Record<string, Record<string, unknown>> = {
  party_group: { code: 'KH_LE', name: 'Khách lẻ' },
  party: { code: 'KH001', name: 'Công ty Cổ phần Alpha', is_customer: true, tax_code: '0101234567', address: 'Hà Nội', payment_term_days: 30, credit_limit: '500000000', group_code: 'KH_LE' },
  department: { code: 'KD', name: 'Phòng kinh doanh' },
  employee: { code: 'NV01', name: 'Nguyễn Văn A', department_code: 'KD' },
  bank: { code: 'VCB', name: 'Ngân hàng TMCP Ngoại thương Việt Nam', short_name: 'Vietcombank' },
  bank_account: { account_no: '0011001234567', account_name: 'CONG TY ABC', bank_code: 'VCB', currency_code: 'VND', gl_account_code: '1121' },
  cost_item: { code: 'CP_VP', name: 'Chi phí văn phòng phẩm', default_account_code: '6422' },
  project: { code: 'DA01', name: 'Dự án 01', party_code: 'KH001' },
  uom: { code: 'KG', name: 'Kilogram' },
  exchange_rate: { currency_code: 'USD', rate_date: '2026-01-15', rate_type: 'transfer_avg', rate: '25400.5' },
};

describe('danh mục khung', () => {
  it('GET /api/catalogs liệt kê định nghĩa có cột và nhãn tiếng Việt', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/catalogs', headers: { cookie } });
    const names = (r.json() as { name: string; label: string; columns: unknown[] }[]).map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(['party', 'department', 'employee', 'currency', 'exchange_rate', 'bank', 'bank_account', 'payment_method', 'tax_code', 'invoice_group', 'cost_item', 'project', 'uom', 'party_group']));
    expect((r.json() as { name: string; label: string }[]).find((d) => d.name === 'party')!.label).toBe('Đối tượng');
  });

  it('công ty mới có sẵn loại tiền, hình thức thanh toán, loại thuế, nhóm hóa đơn, đơn vị tính', async () => {
    const tax = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/tax_code', headers: { cookie } });
    expect((tax.json().rows as { code: string }[]).map((x) => x.code)).toEqual(expect.arrayContaining(['V0', 'V5', 'V8', 'V10', 'KCT', 'NK', 'TTDB']));
    const cur = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/currency', headers: { cookie } });
    expect((cur.json().rows as { code: string }[]).map((x) => x.code)).toEqual(expect.arrayContaining(['VND', 'USD']));
  });

  for (const [name, sample] of Object.entries(SAMPLES)) {
    it(`CRUD ${name}`, async () => {
      const c = await ctx.app.inject({ method: 'POST', url: `/api/catalogs/${name}`, headers: { cookie }, payload: sample });
      expect(c.statusCode, c.body).toBe(201);
      const id = c.json().id as string;
      const one = await ctx.app.inject({ method: 'GET', url: `/api/catalogs/${name}/${id}`, headers: { cookie } });
      expect(one.statusCode).toBe(200);
      if ('name' in sample) {
        const u = await ctx.app.inject({ method: 'PUT', url: `/api/catalogs/${name}/${id}`, headers: { cookie }, payload: { name: `${sample.name} (sửa)` } });
        expect(u.statusCode).toBe(200);
        const list = await ctx.app.inject({ method: 'GET', url: `/api/catalogs/${name}?q=${encodeURIComponent('(sửa)')}`, headers: { cookie } });
        expect(list.json().total).toBe(1);
      }
    });
  }

  it('xóa đối tượng đang được dự án tham chiếu bị 409; trùng mã bị 409; tham chiếu sai mã báo cột', async () => {
    const parties = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party?q=KH001', headers: { cookie } });
    const id = parties.json().rows[0].id;
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/catalogs/party/${id}`, headers: { cookie } });
    expect(del.statusCode).toBe(409); expect(del.json().error.code).toBe('REFERENCED');
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/department', headers: { cookie }, payload: { code: 'KD', name: 'Trùng' } });
    expect(dup.statusCode).toBe(409);
    const badFk = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/employee', headers: { cookie }, payload: { code: 'NV02', name: 'B', department_code: 'KHONG_CO' } });
    expect(badFk.json().error).toMatchObject({ code: 'LOOKUP_NOT_FOUND', message: expect.stringContaining('department_code') });
  });

  it('mọi thay đổi danh mục ghi audit_event có giá trị trước/sau', async () => {
    const ev = await sql<{ action: string; before: { name?: string } | null; after: { name?: string } | null }>`
      SELECT action, before, after FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = 'department' ORDER BY id`.execute(ctx.t.admin);
    expect(ev.rows.map((e) => e.action)).toEqual(expect.arrayContaining(['insert', 'update']));
    const upd = ev.rows.find((e) => e.action === 'update')!;
    expect(upd.before!.name).toBe('Phòng kinh doanh'); expect(upd.after!.name).toBe('Phòng kinh doanh (sửa)');
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/api test -- test/catalogs.test.ts`
Expected: FAIL 404.

- [ ] **Step 3: Migration danh mục**

`packages/db/migrations/0003_danh_muc.sql`:

```sql
CREATE TABLE party_group (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE party (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL,
  is_customer boolean NOT NULL DEFAULT false, is_vendor boolean NOT NULL DEFAULT false, is_employee boolean NOT NULL DEFAULT false,
  group_id uuid REFERENCES party_group(id),
  tax_code text, id_number text, id_issue_date date, id_issue_place text,
  address text, invoice_address text, contact_name text, phone text, email text,
  payment_term_days int, credit_limit numeric(20,0),
  default_account_code text, note text, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, code));
CREATE INDEX ON party (tenant_id, tax_code);
CREATE TABLE party_bank_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  bank_name text NOT NULL, account_no text NOT NULL, account_name text, branch text, UNIQUE (tenant_id, party_id, account_no));
CREATE TABLE department (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, parent_id bigint REFERENCES department(id), is_branch boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE employee (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, department_id bigint REFERENCES department(id), party_id uuid REFERENCES party(id),
  tax_code text, id_number text, position text, phone text, email text, is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE currency (
  tenant_id uuid NOT NULL REFERENCES tenant(id), code char(3) NOT NULL, name text NOT NULL, symbol text, minor_unit int NOT NULL DEFAULT 2,
  is_active boolean NOT NULL DEFAULT true, PRIMARY KEY (tenant_id, code));
CREATE TABLE exchange_rate (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  currency_code char(3) NOT NULL, rate_date date NOT NULL,
  rate_type text NOT NULL CHECK (rate_type IN ('transfer_avg','buy','sell')), rate numeric(20,10) NOT NULL CHECK (rate > 0),
  UNIQUE (tenant_id, currency_code, rate_date, rate_type),
  FOREIGN KEY (tenant_id, currency_code) REFERENCES currency(tenant_id, code));
CREATE TABLE bank (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, short_name text, is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE bank_account (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  bank_id bigint NOT NULL REFERENCES bank(id), account_no text NOT NULL, account_name text, branch text,
  currency_code char(3) NOT NULL DEFAULT 'VND', gl_account_code text NOT NULL, is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, account_no));
CREATE TABLE payment_method (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE tax_code (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, kind text NOT NULL CHECK (kind IN ('vat','import','excise')),
  rate numeric(5,2), is_exempt boolean NOT NULL DEFAULT false, in_declaration boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE invoice_group (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  scope text NOT NULL CHECK (scope IN ('purchase','sale')), code text NOT NULL, name text NOT NULL, rate numeric(5,2),
  is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, scope, code));
CREATE TABLE cost_item (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, parent_id bigint REFERENCES cost_item(id), default_account_code text,
  is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE project (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, parent_id bigint REFERENCES project(id), party_id uuid REFERENCES party(id),
  date_from date, date_to date, budget numeric(20,0), is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));
CREATE TABLE uom (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));

SELECT rls_enable(t), audit_enable(t) FROM unnest(ARRAY['party_group','party','party_bank_account','department','employee','currency','exchange_rate',
  'bank','bank_account','payment_method','tax_code','invoice_group','cost_item','project','uom']::regclass[]) AS t;

-- Dữ liệu mặc định cho công ty mới
CREATE OR REPLACE FUNCTION seed_tenant_defaults(p_tenant uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO currency(tenant_id, code, name, symbol, minor_unit) VALUES (p_tenant, 'VND', 'Đồng Việt Nam', '₫', 0), (p_tenant, 'USD', 'Đô la Mỹ', '$', 2);
  INSERT INTO payment_method(tenant_id, code, name) VALUES (p_tenant, 'TM', 'Tiền mặt'), (p_tenant, 'CK', 'Chuyển khoản'), (p_tenant, 'TM/CK', 'Tiền mặt hoặc chuyển khoản');
  INSERT INTO tax_code(tenant_id, code, name, kind, rate, is_exempt, in_declaration) VALUES
    (p_tenant, 'V0', 'Thuế GTGT 0%', 'vat', 0, false, true), (p_tenant, 'V5', 'Thuế GTGT 5%', 'vat', 5, false, true),
    (p_tenant, 'V8', 'Thuế GTGT 8% (giảm theo NQ 204/2025)', 'vat', 8, false, true), (p_tenant, 'V10', 'Thuế GTGT 10%', 'vat', 10, false, true),
    (p_tenant, 'KCT', 'Không chịu thuế GTGT', 'vat', NULL, true, true), (p_tenant, 'KKK', 'Không kê khai, tính nộp thuế GTGT', 'vat', NULL, true, false),
    (p_tenant, 'NK', 'Thuế nhập khẩu', 'import', NULL, false, false), (p_tenant, 'TTDB', 'Thuế tiêu thụ đặc biệt', 'excise', NULL, false, false);
  INSERT INTO invoice_group(tenant_id, scope, code, name, rate) VALUES
    (p_tenant, 'purchase', '01', 'HHDV dùng riêng cho SXKD chịu thuế GTGT đủ điều kiện khấu trừ', NULL),
    (p_tenant, 'purchase', '02', 'HHDV dùng riêng cho SXKD không chịu thuế GTGT', NULL),
    (p_tenant, 'purchase', '03', 'HHDV dùng chung cho SXKD chịu thuế và không chịu thuế', NULL),
    (p_tenant, 'purchase', '04', 'HHDV dùng cho dự án đầu tư', NULL),
    (p_tenant, 'purchase', '05', 'HHDV không đủ điều kiện khấu trừ / không tổng hợp lên tờ khai', NULL),
    (p_tenant, 'sale', '00', 'Bán ra chịu thuế suất 0%', 0), (p_tenant, 'sale', '05', 'Bán ra chịu thuế suất 5%', 5),
    (p_tenant, 'sale', '08', 'Bán ra chịu thuế suất 8%', 8), (p_tenant, 'sale', '10', 'Bán ra chịu thuế suất 10%', 10),
    (p_tenant, 'sale', 'KCT', 'Bán ra không chịu thuế', NULL);
  INSERT INTO uom(tenant_id, code, name) VALUES (p_tenant, 'CAI', 'Cái'), (p_tenant, 'CHIEC', 'Chiếc'), (p_tenant, 'BO', 'Bộ'), (p_tenant, 'GIO', 'Giờ'), (p_tenant, 'THANG', 'Tháng');
END $$;

CREATE OR REPLACE FUNCTION create_tenant(p_code text, p_name text, p_tax_code text, p_owner_user uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_admin_role uuid;
BEGIN
  INSERT INTO tenant(code, name, tax_code) VALUES (p_code, p_name, p_tax_code) RETURNING id INTO v_tenant;
  PERFORM set_config('app.current_tenant', v_tenant::text, true);
  INSERT INTO role(tenant_id, code, name, is_system) VALUES
    (v_tenant, 'admin', 'Quản trị', true), (v_tenant, 'ketoan_truong', 'Kế toán trưởng', true),
    (v_tenant, 'ketoan_vien', 'Kế toán viên', true), (v_tenant, 'xem', 'Chỉ xem', true);
  SELECT id INTO v_admin_role FROM role WHERE tenant_id = v_tenant AND code = 'admin';
  INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT v_tenant, v_admin_role, code FROM permission;
  INSERT INTO role_permission(tenant_id, role_id, permission_code)
    SELECT v_tenant, r.id, p.code FROM role r CROSS JOIN permission p
    WHERE r.tenant_id = v_tenant AND r.code = 'ketoan_truong' AND p.code NOT LIKE 'user.%' AND p.code NOT LIKE 'role.%';
  INSERT INTO role_permission(tenant_id, role_id, permission_code)
    SELECT v_tenant, r.id, p.code FROM role r CROSS JOIN permission p
    WHERE r.tenant_id = v_tenant AND r.code = 'ketoan_vien'
      AND p.code NOT LIKE 'user.%' AND p.code NOT LIKE 'role.%' AND p.code NOT LIKE 'period.%'
      AND p.code NOT LIKE '%.unpost' AND p.code NOT IN ('voucher.edit_posted','voucher.backdate_locked','voucher.renumber','export.authority','backup.run','setting.update','company.update');
  INSERT INTO role_permission(tenant_id, role_id, permission_code)
    SELECT v_tenant, r.id, p.code FROM role r CROSS JOIN permission p
    WHERE r.tenant_id = v_tenant AND r.code = 'xem' AND (p.code LIKE '%.view' OR p.code LIKE '%.print');
  INSERT INTO tenant_user(tenant_id, user_id, role_id, sensitive_flags)
    VALUES (v_tenant, p_owner_user, v_admin_role, '["view_cost","view_receivable","view_payable","view_salary"]');
  PERFORM seed_tenant_defaults(v_tenant);
  RETURN v_tenant;
END $$;
```

Thêm vào `packages/db/src/types.ts` các interface tương ứng (kiểu cột theo bảng; `id` của `party*` là `Generated<string>`, các bảng còn lại `Generated<number>`; `numeric` dùng `Numeric`; `date` dùng `DateOnly`) và các khóa `party_group, party, party_bank_account, department, employee, currency, exchange_rate, bank, bank_account, payment_method, tax_code, invoice_group, cost_item, project, uom` trong `Database`.

- [ ] **Step 4: Định nghĩa danh mục và CRUD tổng quát**

`apps/api/src/modules/master/catalogs.ts`:

```ts
import { z } from 'zod';
import type { Database } from '@kt/db';

export interface ColumnDef { key: string; label: string; type: 'text' | 'number' | 'boolean' | 'date' | 'select'; required?: boolean; options?: { value: string; label: string }[]; lookup?: { catalog: string }; width?: number }
export interface CatalogDef { name: string; table: keyof Database; label: string; schema: z.ZodObject<z.ZodRawShape>; columns: ColumnDef[]; uniqueBy: string[]; sort: string; searchIn: string[] }

const money = z.string().regex(/^-?\d+(\.\d+)?$/);
const dateIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const code = z.string().min(1).max(30);
const text = (o = true) => (o ? z.string().nullable().optional() : z.string().min(1));

export const CATALOGS: CatalogDef[] = [
  { name: 'party_group', table: 'party_group', label: 'Nhóm đối tượng', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên nhóm', type: 'text', required: true }] },
  { name: 'party', table: 'party', label: 'Đối tượng', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name', 'tax_code'],
    schema: z.object({ code, name: text(false), is_customer: z.boolean().optional(), is_vendor: z.boolean().optional(), is_employee: z.boolean().optional(),
      group_code: text(), tax_code: z.string().regex(/^\d{10}(-\d{3})?$/).nullable().optional(), id_number: text(), id_issue_date: dateIso.nullable().optional(), id_issue_place: text(),
      address: text(), invoice_address: text(), contact_name: text(), phone: text(), email: z.string().email().nullable().optional(),
      payment_term_days: z.number().int().min(0).nullable().optional(), credit_limit: money.nullable().optional(), default_account_code: text(), note: text(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên đối tượng', type: 'text', required: true },
      { key: 'is_customer', label: 'Khách hàng', type: 'boolean' }, { key: 'is_vendor', label: 'Nhà cung cấp', type: 'boolean' }, { key: 'is_employee', label: 'Nhân viên', type: 'boolean' },
      { key: 'group_code', label: 'Nhóm', type: 'text', lookup: { catalog: 'party_group' } }, { key: 'tax_code', label: 'Mã số thuế', type: 'text' }, { key: 'id_number', label: 'Số CCCD', type: 'text' },
      { key: 'address', label: 'Địa chỉ', type: 'text' }, { key: 'invoice_address', label: 'Địa chỉ hóa đơn', type: 'text' }, { key: 'contact_name', label: 'Người liên hệ', type: 'text' },
      { key: 'phone', label: 'Điện thoại', type: 'text' }, { key: 'email', label: 'Email', type: 'text' }, { key: 'payment_term_days', label: 'Hạn thanh toán (ngày)', type: 'number' },
      { key: 'credit_limit', label: 'Hạn mức nợ', type: 'number' }, { key: 'default_account_code', label: 'TK công nợ ngầm định', type: 'text' }] },
  { name: 'party_bank_account', table: 'party_bank_account', label: 'Tài khoản ngân hàng đối tượng', uniqueBy: ['party_code', 'account_no'], sort: 'account_no', searchIn: ['account_no', 'bank_name'],
    schema: z.object({ party_code: code, bank_name: text(false), account_no: text(false), account_name: text(), branch: text() }),
    columns: [{ key: 'party_code', label: 'Đối tượng', type: 'text', required: true, lookup: { catalog: 'party' } }, { key: 'bank_name', label: 'Ngân hàng', type: 'text', required: true },
      { key: 'account_no', label: 'Số tài khoản', type: 'text', required: true }, { key: 'account_name', label: 'Tên tài khoản', type: 'text' }, { key: 'branch', label: 'Chi nhánh', type: 'text' }] },
  { name: 'department', table: 'department', label: 'Bộ phận / chi nhánh', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), parent_code: text(), is_branch: z.boolean().optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên bộ phận', type: 'text', required: true },
      { key: 'parent_code', label: 'Thuộc bộ phận', type: 'text', lookup: { catalog: 'department' } }, { key: 'is_branch', label: 'Là chi nhánh', type: 'boolean' }] },
  { name: 'employee', table: 'employee', label: 'Nhân viên', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), department_code: text(), party_code: text(), tax_code: text(), id_number: text(), position: text(), phone: text(), email: text(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Họ tên', type: 'text', required: true },
      { key: 'department_code', label: 'Bộ phận', type: 'text', lookup: { catalog: 'department' } }, { key: 'party_code', label: 'Đối tượng công nợ', type: 'text', lookup: { catalog: 'party' } },
      { key: 'tax_code', label: 'MST cá nhân', type: 'text' }, { key: 'id_number', label: 'Số CCCD', type: 'text' }, { key: 'position', label: 'Chức vụ', type: 'text' }, { key: 'phone', label: 'Điện thoại', type: 'text' }, { key: 'email', label: 'Email', type: 'text' }] },
  { name: 'currency', table: 'currency', label: 'Loại tiền', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code: z.string().length(3), name: text(false), symbol: text(), minor_unit: z.number().int().min(0).max(4).optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên', type: 'text', required: true }, { key: 'symbol', label: 'Ký hiệu', type: 'text' }, { key: 'minor_unit', label: 'Số lẻ', type: 'number' }] },
  { name: 'exchange_rate', table: 'exchange_rate', label: 'Tỷ giá', uniqueBy: ['currency_code', 'rate_date', 'rate_type'], sort: 'rate_date', searchIn: ['currency_code'],
    schema: z.object({ currency_code: z.string().length(3), rate_date: dateIso, rate_type: z.enum(['transfer_avg', 'buy', 'sell']), rate: money }),
    columns: [{ key: 'currency_code', label: 'Loại tiền', type: 'text', required: true, lookup: { catalog: 'currency' } }, { key: 'rate_date', label: 'Ngày', type: 'date', required: true },
      { key: 'rate_type', label: 'Loại tỷ giá', type: 'select', required: true, options: [{ value: 'transfer_avg', label: 'Mua bán CK trung bình' }, { value: 'buy', label: 'Mua' }, { value: 'sell', label: 'Bán' }] },
      { key: 'rate', label: 'Tỷ giá', type: 'number', required: true }] },
  { name: 'bank', table: 'bank', label: 'Ngân hàng', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name', 'short_name'],
    schema: z.object({ code, name: text(false), short_name: text(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên ngân hàng', type: 'text', required: true }, { key: 'short_name', label: 'Tên viết tắt', type: 'text' }] },
  { name: 'bank_account', table: 'bank_account', label: 'Tài khoản ngân hàng công ty', uniqueBy: ['account_no'], sort: 'account_no', searchIn: ['account_no', 'account_name'],
    schema: z.object({ bank_code: code, account_no: text(false), account_name: text(), branch: text(), currency_code: z.string().length(3).optional(), gl_account_code: text(false), is_active: z.boolean().optional() }),
    columns: [{ key: 'bank_code', label: 'Ngân hàng', type: 'text', required: true, lookup: { catalog: 'bank' } }, { key: 'account_no', label: 'Số tài khoản', type: 'text', required: true },
      { key: 'account_name', label: 'Tên tài khoản', type: 'text' }, { key: 'branch', label: 'Chi nhánh', type: 'text' }, { key: 'currency_code', label: 'Loại tiền', type: 'text', lookup: { catalog: 'currency' } },
      { key: 'gl_account_code', label: 'Tài khoản kế toán (112x)', type: 'text', required: true }] },
  { name: 'payment_method', table: 'payment_method', label: 'Hình thức thanh toán', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên', type: 'text', required: true }] },
  { name: 'tax_code', table: 'tax_code', label: 'Loại thuế', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), kind: z.enum(['vat', 'import', 'excise']), rate: money.nullable().optional(), is_exempt: z.boolean().optional(), in_declaration: z.boolean().optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên', type: 'text', required: true },
      { key: 'kind', label: 'Loại', type: 'select', required: true, options: [{ value: 'vat', label: 'GTGT' }, { value: 'import', label: 'Nhập khẩu' }, { value: 'excise', label: 'TTĐB' }] },
      { key: 'rate', label: 'Thuế suất %', type: 'number' }, { key: 'is_exempt', label: 'Không chịu thuế', type: 'boolean' }, { key: 'in_declaration', label: 'Lên tờ khai', type: 'boolean' }] },
  { name: 'invoice_group', table: 'invoice_group', label: 'Nhóm hóa đơn', uniqueBy: ['scope', 'code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ scope: z.enum(['purchase', 'sale']), code, name: text(false), rate: money.nullable().optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'scope', label: 'Mua/Bán', type: 'select', required: true, options: [{ value: 'purchase', label: 'Mua vào' }, { value: 'sale', label: 'Bán ra' }] },
      { key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên nhóm', type: 'text', required: true }, { key: 'rate', label: 'Thuế suất %', type: 'number' }] },
  { name: 'cost_item', table: 'cost_item', label: 'Khoản mục chi phí', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), parent_code: text(), default_account_code: text(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên khoản mục', type: 'text', required: true },
      { key: 'parent_code', label: 'Thuộc khoản mục', type: 'text', lookup: { catalog: 'cost_item' } }, { key: 'default_account_code', label: 'TK chi phí ngầm định', type: 'text' }] },
  { name: 'project', table: 'project', label: 'Vụ việc / công trình', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), parent_code: text(), party_code: text(), date_from: dateIso.nullable().optional(), date_to: dateIso.nullable().optional(), budget: money.nullable().optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên vụ việc', type: 'text', required: true },
      { key: 'parent_code', label: 'Thuộc vụ việc', type: 'text', lookup: { catalog: 'project' } }, { key: 'party_code', label: 'Khách hàng / chủ đầu tư', type: 'text', lookup: { catalog: 'party' } },
      { key: 'date_from', label: 'Từ ngày', type: 'date' }, { key: 'date_to', label: 'Đến ngày', type: 'date' }, { key: 'budget', label: 'Giá trị dự toán', type: 'number' }] },
  { name: 'uom', table: 'uom', label: 'Đơn vị tính', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên', type: 'text', required: true }] },
];
export const catalogByName = (name: string): CatalogDef | undefined => CATALOGS.find((c) => c.name === name);
```

`apps/api/src/modules/master/crud.ts`:

```ts
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { catalogByName, type CatalogDef } from './catalogs.js';

type Trx = Transaction<Database>;
// currency có khóa chính (tenant_id, code) nên "id" của nó là code.
export const idColumn = (def: CatalogDef): string => (def.table === 'currency' ? 'code' : 'id');
const lookupsOf = (def: CatalogDef) => def.columns.filter((c) => c.lookup && c.lookup.catalog !== 'currency').map((c, i) => ({ key: c.key, idKey: c.key.replace(/_code$/, '_id'), table: catalogByName(c.lookup!.catalog)!.table as string, alias: `l${i}` }));

// Cột `<x>_code` có lookup → cột `<x>_id` trong DB (trừ currency_code: khóa là chính mã).
export async function resolveLookups(trx: Trx, def: CatalogDef, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...row };
  for (const col of def.columns) {
    if (!col.lookup || !(col.key in row) || col.lookup.catalog === 'currency') continue;
    const target = catalogByName(col.lookup.catalog)!;
    const value = row[col.key]; delete out[col.key];
    const idKey = col.key.replace(/_code$/, '_id');
    if (value === null || value === undefined || value === '') { out[idKey] = null; continue; }
    const found = (await sql<{ id: unknown }>`SELECT id FROM ${sql.table(target.table as string)} WHERE code = ${String(value)}`.execute(trx)).rows[0];
    if (!found) throw new AppError('LOOKUP_NOT_FOUND', `Cột ${col.key}: không có mã "${String(value)}" trong ${target.label}`, 409);
    out[idKey] = found.id;
  }
  return out;
}

// Trả hàng kèm `<x>_code` thay cho `<x>_id` để giao diện và Excel dùng mã.
export async function listRows(trx: Trx, def: CatalogDef, q: { q?: string | undefined; page: number; size: number }, whereId?: string) {
  const lk = lookupsOf(def);
  const extra = lk.length ? sql.join(lk.map((j) => sql`, ${sql.ref(`${j.alias}.code`)} AS ${sql.ref(j.key)}`), sql``) : sql``;
  const joins = lk.length ? sql.join(lk.map((j) => sql` LEFT JOIN ${sql.table(j.table)} AS ${sql.ref(j.alias)} ON ${sql.ref(`${j.alias}.id`)} = ${sql.ref(`t.${j.idKey}`)}`), sql``) : sql``;
  const conds = [];
  if (q.q) conds.push(sql`(${sql.join(def.searchIn.map((c) => sql`${sql.ref(`t.${c}`)}::text ILIKE ${'%' + q.q + '%'}`), sql` OR `)})`);
  if (whereId !== undefined) conds.push(sql`${sql.ref(`t.${idColumn(def)}`)}::text = ${whereId}`);
  const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
  const total = await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(def.table as string)} t ${where}`.execute(trx);
  const rows = await sql<Record<string, unknown>>`SELECT t.* ${extra} FROM ${sql.table(def.table as string)} t ${joins} ${where} ORDER BY ${sql.ref(`t.${def.sort}`)} LIMIT ${q.size} OFFSET ${(q.page - 1) * q.size}`.execute(trx);
  return { rows: rows.rows, total: Number(total.rows[0]!.n) };
}

export async function getRow(trx: Trx, def: CatalogDef, id: string) {
  const { rows } = await listRows(trx, def, { page: 1, size: 1 }, id);
  if (!rows[0]) throw new AppError('NOT_FOUND', `Không tìm thấy ${def.label}`, 404);
  return rows[0];
}

export async function createRow(trx: Trx, tenantId: string, def: CatalogDef, body: unknown): Promise<string> {
  const values = await resolveLookups(trx, def, def.schema.parse(body));
  const r = await trx.insertInto(def.table as never).values({ ...values, tenant_id: tenantId } as never).returning(idColumn(def) as never).executeTakeFirstOrThrow() as Record<string, unknown>;
  return String(r[idColumn(def)]);
}

export async function updateRow(trx: Trx, def: CatalogDef, id: string, body: unknown): Promise<void> {
  const values = await resolveLookups(trx, def, def.schema.partial().parse(body));
  if (Object.keys(values).length === 0) return;
  const r = await trx.updateTable(def.table as never).set(values as never).where(idColumn(def) as never, '=', id as never).executeTakeFirst();
  if (r.numUpdatedRows === 0n) throw new AppError('NOT_FOUND', `Không tìm thấy ${def.label}`, 404);
}

export async function deleteRow(trx: Trx, def: CatalogDef, id: string): Promise<void> {
  const r = await trx.deleteFrom(def.table as never).where(idColumn(def) as never, '=', id as never).executeTakeFirst();
  if (r.numDeletedRows === 0n) throw new AppError('NOT_FOUND', `Không tìm thấy ${def.label}`, 404);
}
```

`apps/api/src/modules/master/routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CATALOGS, catalogByName } from './catalogs.js';
import { createRow, deleteRow, getRow, listRows, updateRow } from './crud.js';
import { AppError } from '../../plugins/errors.js';

const routes: FastifyPluginAsyncZod = async (app) => {
  const def = (name: string) => { const d = catalogByName(name); if (!d) throw new AppError('NOT_FOUND', `Không có danh mục ${name}`, 404); return d; };
  app.get('/api/catalogs', { preHandler: app.requirePermission('catalog.view') }, async () => CATALOGS.map(({ schema: _s, ...rest }) => rest));
  app.get('/api/catalogs/:name', { preHandler: app.requirePermission('catalog.view'), schema: { params: z.object({ name: z.string() }),
    querystring: z.object({ q: z.string().optional(), page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(1000).default(100) }) } },
    async (req) => app.withTenant(req, (trx) => listRows(trx, def(req.params.name), req.query)));
  app.get('/api/catalogs/:name/:id', { preHandler: app.requirePermission('catalog.view'), schema: { params: z.object({ name: z.string(), id: z.string() }) } },
    async (req) => app.withTenant(req, (trx) => getRow(trx, def(req.params.name), req.params.id)));
  app.post('/api/catalogs/:name', { preHandler: app.requirePermission('catalog.create'), schema: { params: z.object({ name: z.string() }) } },
    async (req, reply) => reply.status(201).send({ id: await app.withTenant(req, (trx) => createRow(trx, req.auth!.tenantId!, def(req.params.name), req.body)) }));
  app.put('/api/catalogs/:name/:id', { preHandler: app.requirePermission('catalog.update'), schema: { params: z.object({ name: z.string(), id: z.string() }) } },
    async (req) => { await app.withTenant(req, (trx) => updateRow(trx, def(req.params.name), req.params.id, req.body)); return { ok: true }; });
  app.delete('/api/catalogs/:name/:id', { preHandler: app.requirePermission('catalog.delete'), schema: { params: z.object({ name: z.string(), id: z.string() }) } },
    async (req, reply) => { await app.withTenant(req, (trx) => deleteRow(trx, def(req.params.name), req.params.id)); return reply.status(204).send(); });
};
export default routes;
```

Đăng ký `masterRoutes` trong `app.ts`.

- [ ] **Step 5: Chạy test**

Run: `pnpm -F @kt/api test -- test/catalogs.test.ts`
Expected: PASS 14 test (2 + 10 CRUD + 2).

- [ ] **Step 6: Commit**

```bash
git add packages/db apps/api
git commit -m "feat(master): danh mục khung với CRUD tổng quát, tra cứu theo mã và audit tự động"
```

---

### Task 9: Nhập khẩu danh mục từ Excel theo mẫu

**Files:**
- Create: `apps/api/src/modules/master/importExcel.ts`
- Modify: `apps/api/src/modules/master/routes.ts` (thêm 2 route), `apps/api/src/app.ts` (đăng ký `@fastify/multipart`)
- Create: `apps/web/src/pages/ImportExcel.tsx`; Modify: `apps/web/src/router.tsx`
- Test: `apps/api/test/importExcel.test.ts`

**Interfaces:**
- Consumes: `CatalogDef`, `resolveLookups`, `createRow` (Task 8).
- Produces:
  - `buildTemplate(def: CatalogDef): Promise<Buffer>` (sheet "Du_lieu": dòng 1 nhãn cột, dòng 2 khóa kỹ thuật ẩn, dòng 3 ví dụ; sheet "Huong_dan").
  - `parseWorkbook(def, buffer): Promise<{ rows: Record<string, unknown>[]; errors: ImportError[] }>` với `ImportError = { row: number; column: string; message: string }`; dòng dữ liệu bắt đầu từ dòng 3 (dòng ví dụ bị bỏ qua nếu ô A3 = `VI_DU`).
  - `importRows(trx, tenantId, def, rows): Promise<{ inserted: number; errors: ImportError[] }>` (toàn bộ hoặc không gì: có lỗi thì ném `IMPORT_ERRORS` kèm danh sách).
  - Route: `GET /api/catalogs/:name/template.xlsx`; `POST /api/catalogs/:name/import?mode=validate|commit` (multipart, trường `file`) → `{ total, inserted, errors }`.

- [ ] **Step 1: Viết test (thất bại)**

`apps/api/test/importExcel.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import FormData from 'form-data';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';
import { buildTemplate, parseWorkbook } from '../src/modules/master/importExcel.js';
import { catalogByName } from '../src/modules/master/catalogs.js';

let ctx: TestApp; let cookie: string;
beforeAll(async () => { ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `IM${Date.now()}` })); });
afterAll(async () => { await ctx.close(); });

async function workbookWith(rows: (string | number | boolean | null)[][]): Promise<Buffer> {
  const tpl = await buildTemplate(catalogByName('party')!);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(tpl as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Du_lieu')!;
  ws.spliceRows(3, 1);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
function upload(name: string, buf: Buffer, mode: string) {
  const fd = new FormData(); fd.append('file', buf, { filename: 'x.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  return ctx.app.inject({ method: 'POST', url: `/api/catalogs/${name}/import?mode=${mode}`, headers: { cookie, ...fd.getHeaders() }, payload: fd.getBuffer() });
}

describe('nhập Excel', () => {
  it('mẫu tải về có nhãn cột tiếng Việt và sheet hướng dẫn', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party/template.xlsx', headers: { cookie } });
    expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    expect(wb.getWorksheet('Du_lieu')!.getRow(1).getCell(2).value).toBe('Tên đối tượng');
    expect(wb.getWorksheet('Huong_dan')).toBeTruthy();
  });

  it('parseWorkbook báo lỗi đúng dòng và cột', async () => {
    const buf = await workbookWith([['KH100', 'Công ty X', true, false, false, null, '0101234567'], ['', 'Thiếu mã', true, false, false, null, 'MST_SAI']]);
    const { rows, errors } = await parseWorkbook(catalogByName('party')!, buf);
    expect(rows).toHaveLength(1);
    expect(errors).toEqual(expect.arrayContaining([
      { row: 4, column: 'code', message: expect.any(String) }, { row: 4, column: 'tax_code', message: expect.any(String) }]));
  });

  it('mode=validate không ghi; mode=commit ghi toàn bộ hoặc không gì; 500 dòng dưới 5 giây', async () => {
    const many = Array.from({ length: 500 }, (_, i) => [`KHX${String(i).padStart(4, '0')}`, `Khách hàng số ${i}`, true, false, false, null, null]);
    const v = await upload('party', await workbookWith(many), 'validate');
    expect(v.json()).toMatchObject({ total: 500, inserted: 0, errors: [] });
    let list = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party?q=KHX', headers: { cookie } });
    expect(list.json().total).toBe(0);
    const t0 = Date.now();
    const c = await upload('party', await workbookWith(many), 'commit');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(c.json()).toMatchObject({ total: 500, inserted: 500 });
    list = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party?q=KHX', headers: { cookie } });
    expect(list.json().total).toBe(500);
    const bad = await upload('party', await workbookWith([['KHY1', 'Đúng', true, false, false, null, null], ['KHY1', 'Trùng mã trong file', true, false, false, null, null]]), 'commit');
    expect(bad.statusCode).toBe(409); expect(bad.json().error.code).toBe('IMPORT_ERRORS');
    list = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party?q=KHY1', headers: { cookie } });
    expect(list.json().total).toBe(0);
  });
});
```

(Thêm `form-data` vào devDependencies của `@kt/api`: `"form-data": "^4.0.1"`.)

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm install && pnpm -F @kt/api test -- test/importExcel.test.ts`
Expected: FAIL `Cannot find module '../src/modules/master/importExcel.js'`.

- [ ] **Step 3: Viết bộ nhập Excel**

`apps/api/src/modules/master/importExcel.ts`:

```ts
import ExcelJS from 'exceljs';
import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import type { CatalogDef, ColumnDef } from './catalogs.js';
import { resolveLookups } from './crud.js';

export interface ImportError { row: number; column: string; message: string }
const SHEET = 'Du_lieu';

const example = (c: ColumnDef): string | number | boolean | null =>
  c.type === 'boolean' ? true : c.type === 'number' ? 0 : c.type === 'date' ? '2026-01-01' : c.options ? c.options[0]!.value : c.key === 'code' ? 'VI_DU' : `Ví dụ ${c.label.toLowerCase()}`;

export async function buildTemplate(def: CatalogDef): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET);
  ws.addRow(def.columns.map((c) => c.label + (c.required ? ' (*)' : '')));
  ws.addRow(def.columns.map((c) => c.key)); ws.getRow(2).hidden = true;
  ws.addRow(def.columns.map(example));
  ws.getRow(1).font = { bold: true }; ws.columns.forEach((col) => { col.width = 22; });
  const hd = wb.addWorksheet('Huong_dan');
  hd.addRow([`Mẫu nhập ${def.label}`]); hd.addRow(['Dòng 1: tên cột (cột có (*) bắt buộc). Dòng 3 là ví dụ, sẽ bị bỏ qua nếu ô A3 = VI_DU. Nhập dữ liệu từ dòng 3 hoặc 4.']);
  hd.addRow(['Cột tham chiếu nhập MÃ của danh mục liên quan (ví dụ nhóm đối tượng, bộ phận). Ngày dạng YYYY-MM-DD hoặc dd/MM/yyyy. Ô đúng/sai nhập TRUE/FALSE hoặc 1/0 hoặc x.']);
  for (const c of def.columns) hd.addRow([c.key, c.label, c.type, c.required ? 'bắt buộc' : '', c.options ? c.options.map((o) => `${o.value}=${o.label}`).join('; ') : c.lookup ? `mã ${c.lookup.catalog}` : '']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function cellValue(c: ColumnDef, raw: ExcelJS.CellValue): unknown {
  if (raw === null || raw === undefined || raw === '') return null;
  const v = typeof raw === 'object' && raw !== null && 'result' in raw ? (raw as { result: unknown }).result : raw;
  switch (c.type) {
    case 'boolean': return typeof v === 'boolean' ? v : ['1', 'true', 'x', 'có', 'co'].includes(String(v).trim().toLowerCase());
    case 'number': return typeof v === 'number' ? (c.key.endsWith('_days') || c.key === 'minor_unit' ? v : String(v)) : String(v).replace(/[\s.]/g, '').replace(',', '.');
    case 'date': {
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v).trim());
      return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : String(v).trim();
    }
    default: return String(v).trim();
  }
}

export async function parseWorkbook(def: CatalogDef, buffer: Buffer): Promise<{ rows: Record<string, unknown>[]; errors: ImportError[] }> {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.getWorksheet(SHEET) ?? wb.worksheets[0];
  if (!ws) throw new AppError('IMPORT_NO_SHEET', `Không tìm thấy sheet ${SHEET}`, 400);
  const keys = def.columns.map((c) => c.key);
  const rows: Record<string, unknown>[] = []; const errors: ImportError[] = []; const seen = new Map<string, number>();
  ws.eachRow((row, rowNo) => {
    if (rowNo <= 2) return;
    if (rowNo === 3 && String(row.getCell(1).value ?? '') === 'VI_DU') return;
    const obj: Record<string, unknown> = {};
    def.columns.forEach((c, i) => { const v = cellValue(c, row.getCell(i + 1).value); if (v !== null) obj[c.key] = v; });
    if (Object.keys(obj).length === 0) return;
    const parsed = def.schema.safeParse(obj);
    if (!parsed.success) { for (const issue of parsed.error.issues) errors.push({ row: rowNo, column: String(issue.path[0] ?? keys[0]), message: issue.message }); return; }
    const uk = def.uniqueBy.map((k) => String(obj[k] ?? '')).join('|');
    if (seen.has(uk)) errors.push({ row: rowNo, column: def.uniqueBy[0]!, message: `Trùng với dòng ${seen.get(uk)}` }); else seen.set(uk, rowNo);
    rows.push({ __row: rowNo, ...parsed.data });
  });
  return { rows, errors };
}

export async function importRows(trx: Transaction<Database>, tenantId: string, def: CatalogDef, rows: Record<string, unknown>[], errors: ImportError[]): Promise<number> {
  const resolved: Record<string, unknown>[] = [];
  for (const r of rows) {
    const { __row, ...data } = r as { __row: number } & Record<string, unknown>;
    try { resolved.push({ ...(await resolveLookups(trx, def, data)), tenant_id: tenantId }); }
    catch (e) { errors.push({ row: __row, column: (e as AppError).message.match(/Cột (\w+)/)?.[1] ?? '', message: (e as Error).message }); }
  }
  if (errors.length) throw new AppError('IMPORT_ERRORS', `${errors.length} dòng lỗi`, 409);
  for (let i = 0; i < resolved.length; i += 200) {
    await trx.insertInto(def.table as never).values(resolved.slice(i, i + 200) as never).execute();
  }
  return resolved.length;
}
```

Sửa `plugins/errors.ts`: khi `AppError.code === 'IMPORT_ERRORS'` kèm `details` → thêm thuộc tính tùy chọn `details?: unknown` vào `AppError` (constructor thứ tư) và trả `details` trong body. Trong `importRows`, ném `new AppError('IMPORT_ERRORS', ..., 409, errors)`.

Thêm vào `apps/api/src/modules/master/routes.ts`:

```ts
import { buildTemplate, importRows, parseWorkbook } from './importExcel.js';
// ...
app.get('/api/catalogs/:name/template.xlsx', { preHandler: app.requirePermission('catalog.view'), schema: { params: z.object({ name: z.string() }) } }, async (req, reply) => {
  const d = def(req.params.name);
  reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="mau_${d.name}.xlsx"`);
  return reply.send(await buildTemplate(d));
});
app.post('/api/catalogs/:name/import', { preHandler: app.requirePermission('catalog.import'), schema: { params: z.object({ name: z.string() }), querystring: z.object({ mode: z.enum(['validate', 'commit']).default('validate') }) } }, async (req) => {
  const d = def(req.params.name);
  const file = await req.file(); if (!file) throw new AppError('IMPORT_NO_FILE', 'Thiếu tệp', 400);
  const buf = await file.toBuffer();
  const { rows, errors } = await parseWorkbook(d, buf);
  if (req.query.mode === 'validate' || errors.length) {
    if (errors.length && req.query.mode === 'commit') throw new AppError('IMPORT_ERRORS', `${errors.length} dòng lỗi`, 409, errors);
    return { total: rows.length + errors.length, inserted: 0, errors };
  }
  const inserted = await app.withTenant(req, (trx) => importRows(trx, req.auth!.tenantId!, d, rows, errors));
  return { total: rows.length, inserted, errors: [] };
});
```

`app.ts`: `await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });` (import từ `@fastify/multipart`) trước các route.

- [ ] **Step 4: Chạy test**

Run: `pnpm -F @kt/api test -- test/importExcel.test.ts`
Expected: PASS 3 test; thời gian commit 500 dòng in ra dưới 5 giây.

- [ ] **Step 5: Màn hình nhập Excel**

`apps/web/src/pages/ImportExcel.tsx`:

```tsx
import { useState } from 'react';
import { Alert, Button, Card, Select, Space, Table, Upload, message } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';

interface Def { name: string; label: string }
interface Result { total: number; inserted: number; errors: { row: number; column: string; message: string }[] }

export default function ImportExcelPage() {
  const defs = useQuery({ queryKey: ['catalog-defs'], queryFn: () => api<Def[]>('/api/catalogs') });
  const [name, setName] = useState<string>('party');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const send = async (mode: 'validate' | 'commit') => {
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`/api/catalogs/${name}/import?mode=${mode}`, { method: 'POST', body: fd, credentials: 'include' });
    const body = await res.json();
    if (!res.ok) { setResult({ total: 0, inserted: 0, errors: body.error?.details ?? [] }); void message.error(body.error?.message ?? 'Lỗi'); return; }
    setResult(body as Result); if (mode === 'commit') void message.success(`Đã nhập ${(body as Result).inserted} dòng`);
  };
  return (
    <Card title="Nhập danh mục từ Excel">
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space>
          <Select style={{ width: 280 }} value={name} onChange={setName} options={(defs.data ?? []).map((d) => ({ value: d.name, label: d.label }))} />
          <Button href={`/api/catalogs/${name}/template.xlsx`}>Tải mẫu</Button>
          <Upload beforeUpload={(f) => { setFile(f); setResult(null); return false; }} maxCount={1} accept=".xlsx"><Button>Chọn tệp</Button></Upload>
          <Button onClick={() => void send('validate')} disabled={!file}>Kiểm tra</Button>
          <Button type="primary" onClick={() => void send('commit')} disabled={!file || !result || result.errors.length > 0}>Nhập</Button>
        </Space>
        {result && result.errors.length === 0 && <Alert type="success" message={`${result.total} dòng hợp lệ${result.inserted ? `, đã nhập ${result.inserted}` : ''}`} />}
        {result && result.errors.length > 0 && (<>
          <Alert type="error" message={`${result.errors.length} lỗi, chưa nhập dòng nào`} />
          <Table size="small" rowKey={(r) => `${r.row}-${r.column}`} dataSource={result.errors} pagination={{ pageSize: 20 }}
            columns={[{ title: 'Dòng', dataIndex: 'row', width: 80 }, { title: 'Cột', dataIndex: 'column', width: 180 }, { title: 'Lỗi', dataIndex: 'message' }]} /></>)}
      </Space>
    </Card>
  );
}
```

Route `/danh-muc/nhap-excel` và mục menu `{ key: 'import', label: 'Nhập Excel', to: '/danh-muc/nhap-excel', permission: 'catalog.import' }`.

- [ ] **Step 6: Commit**

```bash
git add apps/api apps/web
git commit -m "feat(master): nhập danh mục từ Excel theo mẫu với báo lỗi theo dòng"
```

---

### Task 10: Gói `@kt/ui`: lưới nhập liệu bàn phím, chọn danh mục F4 + thêm nhanh, ô số kiểu Việt Nam, bộ lọc nhớ; màn hình danh mục dùng chung

**Files:**
- Create: `packages/domain/src/gridKeyboard.ts`; Modify: `packages/domain/src/index.ts`
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/vitest.setup.ts`, `packages/ui/src/index.ts`, `packages/ui/src/KeyboardGrid.tsx`, `packages/ui/src/LookupSelect.tsx`, `packages/ui/src/VnNumberInput.tsx`, `packages/ui/src/useRememberedFilter.ts`
- Create: `apps/api/src/modules/core/prefs.ts`; Modify: `apps/api/src/app.ts`
- Create: `apps/web/src/pages/Catalog.tsx`; Modify: `apps/web/src/router.tsx`
- Test: `packages/domain/test/gridKeyboard.test.ts`, `packages/ui/test/VnNumberInput.test.tsx`, `packages/ui/test/LookupSelect.test.tsx`, `apps/api/test/prefs.test.ts`

**Interfaces:**
- Consumes: `formatVnNumber`, `parseVnNumber` (Task 3); `/api/catalogs/*` (Task 8).
- Produces:
  - `nextCellOnEnter(pos: {row: number; col: number}, g: {rowCount: number; editableCols: number[]}): { row: number; col: number; addRow: boolean }`; `nextCellOnTab(...)` cùng dạng; `isLookupKey(e: {key: string}): boolean` (F4).
  - `<KeyboardGrid<T> rows columns onRowsChange onLookup(colId, rowIndex) addRowTemplate height />` (bọc `AgGridReact`, Enter/Tab theo hàm trên, F4 gọi `onLookup`, Ctrl+Delete xóa dòng, Ctrl+Insert chèn dòng).
  - `<LookupSelect catalog valueField="code" value onChange onQuickAdd? placeholder />` tải `GET /api/catalogs/:catalog?q=` khi gõ; phím F4 mở danh sách; mục cuối "+ Thêm nhanh" mở modal (nếu `onQuickAdd`), lưu qua `POST /api/catalogs/:catalog`.
  - `<VnNumberInput value: string|null onChange(v: string|null) scale />` hiển thị `1.500.000`, nhận gõ `1500000` hoặc `1.500.000`.
  - `useRememberedFilter<T>(key: string, defaults: T): [T, (v: T) => void]` (lưu `PUT /api/prefs/:key`, đọc `GET /api/prefs/:key`, dự phòng `localStorage`).
  - Route: `GET /api/prefs/:key` → `{ value }` (hoặc `null`), `PUT /api/prefs/:key { value }`.
  - Trang `Catalog.tsx` tại `/danh-muc/:name` cho mọi danh mục trong `CATALOGS` (bảng AG Grid + modal form sinh từ `columns`, ô tham chiếu dùng `LookupSelect`, số dùng `VnNumberInput`, bộ lọc `q` nhớ theo người dùng).

- [ ] **Step 1: Viết test logic bàn phím (thất bại)**

`packages/domain/test/gridKeyboard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isLookupKey, nextCellOnEnter, nextCellOnTab } from '../src/gridKeyboard.js';

const g = { rowCount: 2, editableCols: [0, 2, 3] };
describe('gridKeyboard', () => {
  it('Enter đi sang cột sửa được kế tiếp, cuối dòng xuống dòng sau, cuối lưới thêm dòng', () => {
    expect(nextCellOnEnter({ row: 0, col: 0 }, g)).toEqual({ row: 0, col: 2, addRow: false });
    expect(nextCellOnEnter({ row: 0, col: 3 }, g)).toEqual({ row: 1, col: 0, addRow: false });
    expect(nextCellOnEnter({ row: 1, col: 3 }, g)).toEqual({ row: 2, col: 0, addRow: true });
    expect(nextCellOnEnter({ row: 0, col: 1 }, g)).toEqual({ row: 0, col: 2, addRow: false });
  });
  it('Tab giống Enter nhưng không thêm dòng ở cuối', () => {
    expect(nextCellOnTab({ row: 1, col: 3 }, g)).toEqual({ row: 1, col: 3, addRow: false });
  });
  it('F4 là phím tra cứu', () => { expect(isLookupKey({ key: 'F4' })).toBe(true); expect(isLookupKey({ key: 'F2' })).toBe(false); });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/domain test -- test/gridKeyboard.test.ts`
Expected: FAIL.

- [ ] **Step 3: Viết `gridKeyboard.ts`**

```ts
export interface CellPos { row: number; col: number }
export interface GridShape { rowCount: number; editableCols: number[] }
export interface Move extends CellPos { addRow: boolean }

export function nextCellOnEnter(pos: CellPos, g: GridShape): Move {
  const cols = [...g.editableCols].sort((a, b) => a - b);
  const next = cols.find((c) => c > pos.col);
  if (next !== undefined) return { row: pos.row, col: next, addRow: false };
  const first = cols[0] ?? 0;
  if (pos.row + 1 < g.rowCount) return { row: pos.row + 1, col: first, addRow: false };
  return { row: pos.row + 1, col: first, addRow: true };
}
export function nextCellOnTab(pos: CellPos, g: GridShape): Move {
  const m = nextCellOnEnter(pos, g);
  return m.addRow ? { ...pos, addRow: false } : m;
}
export const isLookupKey = (e: { key: string }): boolean => e.key === 'F4';
```

Thêm `export * from './gridKeyboard.js';` vào index. Run test → PASS.

- [ ] **Step 4: Gói `@kt/ui`: thành phần và test**

`packages/ui/package.json`:

```json
{
  "name": "@kt/ui", "version": "0.0.1", "private": true, "type": "module",
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } },
  "scripts": { "typecheck": "tsc -p tsconfig.json --noEmit", "test": "vitest run --environment jsdom", "build": "tsc -p tsconfig.json --noEmit" },
  "peerDependencies": { "antd": "^5.21.2", "react": "^18.3.1", "react-dom": "^18.3.1" },
  "dependencies": { "@kt/domain": "workspace:*", "ag-grid-community": "^33.0.2", "ag-grid-react": "^33.0.2" },
  "devDependencies": { "@testing-library/jest-dom": "^6.5.0", "@testing-library/react": "^16.0.1", "@testing-library/user-event": "^14.5.2", "@types/react": "^18.3.11", "@types/react-dom": "^18.3.0", "antd": "^5.21.2", "jsdom": "^25.0.1", "react": "^18.3.1", "react-dom": "^18.3.1" }
}
```

`packages/ui/tsconfig.json` giống web (`jsx: react-jsx`, `moduleResolution: Bundler`, `noEmit`). `packages/ui/vitest.setup.ts` giống `apps/web/vitest.setup.ts`; thêm `vite.config.ts` với `test.setupFiles`.

`packages/ui/src/VnNumberInput.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Input, type InputProps } from 'antd';
import { formatVnNumber, parseVnNumber } from '@kt/domain';

export interface VnNumberInputProps extends Omit<InputProps, 'value' | 'onChange'> { value?: string | null; onChange?: (v: string | null) => void; scale?: number }

export function VnNumberInput({ value, onChange, scale = 0, ...rest }: VnNumberInputProps) {
  const [text, setText] = useState(formatVnNumber(value ?? null, scale));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(formatVnNumber(value ?? null, scale)); }, [value, scale, focused]);
  return (
    <Input {...rest} value={text} style={{ textAlign: 'right', ...(rest.style ?? {}) }} inputMode="decimal"
      onFocus={(e) => { setFocused(true); e.target.select(); rest.onFocus?.(e); }}
      onChange={(e) => { setText(e.target.value); const p = e.target.value.trim() === '' ? null : parseVnNumber(e.target.value); if (p !== null || e.target.value.trim() === '') onChange?.(p); }}
      onBlur={(e) => { setFocused(false); const p = parseVnNumber(text); setText(formatVnNumber(p, scale)); onChange?.(p); rest.onBlur?.(e); }} />
  );
}
```

`packages/ui/src/LookupSelect.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Form, Input, Modal, Select, type SelectProps } from 'antd';
import { isLookupKey } from '@kt/domain';

export interface LookupRow { id: string | number; code: string; name: string }
export interface LookupSelectProps extends Omit<SelectProps, 'options' | 'onChange' | 'value'> {
  catalog: string; value?: string | null; onChange?: (code: string | null, row: LookupRow | null) => void;
  valueField?: 'code' | 'id'; quickAddFields?: { key: string; label: string }[];
  fetcher?: (catalog: string, q: string) => Promise<LookupRow[]>; creator?: (catalog: string, body: Record<string, unknown>) => Promise<LookupRow>;
}
const defaultFetcher = async (catalog: string, q: string): Promise<LookupRow[]> => {
  const r = await fetch(`/api/catalogs/${catalog}?q=${encodeURIComponent(q)}&size=50`, { credentials: 'include' });
  return ((await r.json()) as { rows: LookupRow[] }).rows;
};
const defaultCreator = async (catalog: string, body: Record<string, unknown>): Promise<LookupRow> => {
  const r = await fetch(`/api/catalogs/${catalog}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(((await r.json()) as { error: { message: string } }).error.message);
  const { id } = (await r.json()) as { id: string };
  return { id, code: String(body['code']), name: String(body['name']) };
};
const QUICK = '__quick_add__';

export function LookupSelect({ catalog, value, onChange, valueField = 'code', quickAddFields, fetcher = defaultFetcher, creator = defaultCreator, ...rest }: LookupSelectProps) {
  const [rows, setRows] = useState<LookupRow[]>([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form] = Form.useForm();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const search = (q: string) => { clearTimeout(timer.current); timer.current = setTimeout(() => { void fetcher(catalog, q).then(setRows); }, 150); };
  useEffect(() => { void fetcher(catalog, '').then(setRows); }, [catalog, fetcher]);
  const options = [...rows.map((r) => ({ value: String(r[valueField]), label: `${r.code} - ${r.name}` })), ...(quickAddFields ? [{ value: QUICK, label: '+ Thêm nhanh…' }] : [])];
  return (
    <>
      <Select {...rest} showSearch filterOption={false} open={open} onDropdownVisibleChange={setOpen} onSearch={search} value={value ?? undefined} options={options}
        onKeyDown={(e) => { if (isLookupKey(e)) { e.preventDefault(); setOpen(true); } }}
        onChange={(v: string) => { if (v === QUICK) { setOpen(false); setAdding(true); return; } onChange?.(v ?? null, rows.find((r) => String(r[valueField]) === v) ?? null); }} allowClear />
      {quickAddFields && (
        <Modal title="Thêm nhanh" open={adding} onCancel={() => setAdding(false)} onOk={() => form.submit()} destroyOnClose>
          <Form form={form} layout="vertical" onFinish={async (v) => { const row = await creator(catalog, v); setRows((xs) => [row, ...xs]); onChange?.(String(row[valueField]), row); setAdding(false); form.resetFields(); }}>
            {quickAddFields.map((f) => <Form.Item key={f.key} name={f.key} label={f.label} rules={[{ required: true }]}><Input /></Form.Item>)}
          </Form>
        </Modal>)}
    </>
  );
}
```

`packages/ui/src/KeyboardGrid.tsx`:

```tsx
import { useCallback, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type CellKeyDownEvent, type ColDef, type GridApi } from 'ag-grid-community';
import { isLookupKey, nextCellOnEnter, nextCellOnTab } from '@kt/domain';

ModuleRegistry.registerModules([AllCommunityModule]);

export interface KeyboardGridProps<T> {
  rows: T[]; columns: ColDef<T>[]; onRowsChange: (rows: T[]) => void; addRowTemplate: () => T;
  onLookup?: (colId: string, rowIndex: number) => void; height?: number | string; readOnly?: boolean;
}

export function KeyboardGrid<T extends object>({ rows, columns, onRowsChange, addRowTemplate, onLookup, height = 320, readOnly }: KeyboardGridProps<T>) {
  const apiRef = useRef<GridApi<T> | null>(null);
  const colDefs = useMemo(() => columns.map((c) => ({ ...c, editable: readOnly ? false : c.editable ?? true })), [columns, readOnly]);
  const editableIdx = useMemo(() => colDefs.map((c, i) => (c.editable ? i : -1)).filter((i) => i >= 0), [colDefs]);
  const colId = (i: number) => (colDefs[i]!.colId ?? colDefs[i]!.field) as string;

  const onCellKeyDown = useCallback((e: CellKeyDownEvent<T>) => {
    const ev = e.event as KeyboardEvent | undefined; const api = e.api; if (!ev) return;
    const pos = { row: e.rowIndex ?? 0, col: colDefs.findIndex((c) => (c.colId ?? c.field) === e.column.getColId()) };
    const shape = { rowCount: api.getDisplayedRowCount(), editableCols: editableIdx };
    if (isLookupKey(ev)) { ev.preventDefault(); onLookup?.(e.column.getColId(), pos.row); return; }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault(); api.stopEditing();
      const m = ev.key === 'Enter' ? nextCellOnEnter(pos, shape) : nextCellOnTab(pos, shape);
      if (m.addRow && !readOnly) onRowsChange([...rows, addRowTemplate()]);
      setTimeout(() => { api.setFocusedCell(m.row, colId(m.col)); api.startEditingCell({ rowIndex: m.row, colKey: colId(m.col) }); }, 0);
      return;
    }
    if (ev.ctrlKey && ev.key === 'Delete' && !readOnly) { ev.preventDefault(); onRowsChange(rows.filter((_, i) => i !== pos.row)); }
    if (ev.ctrlKey && ev.key === 'Insert' && !readOnly) { ev.preventDefault(); const copy = [...rows]; copy.splice(pos.row, 0, addRowTemplate()); onRowsChange(copy); }
  }, [colDefs, editableIdx, rows, onRowsChange, addRowTemplate, onLookup, readOnly]);

  return (
    <div style={{ height }}>
      <AgGridReact<T> theme={themeQuartz} rowData={rows} columnDefs={colDefs} singleClickEdit stopEditingWhenCellsLoseFocus suppressClickEdit={false}
        onGridReady={(e) => { apiRef.current = e.api; }} onCellKeyDown={onCellKeyDown}
        onCellValueChanged={(e) => { const copy = [...rows]; copy[e.rowIndex ?? 0] = { ...(e.data as T) }; onRowsChange(copy); }}
        defaultColDef={{ resizable: true, suppressKeyboardEvent: (p) => ['Enter', 'Tab', 'F4'].includes((p.event as KeyboardEvent).key) }} />
    </div>
  );
}
```

`packages/ui/src/useRememberedFilter.ts`:

```ts
import { useEffect, useState } from 'react';

export function useRememberedFilter<T extends object>(key: string, defaults: T): [T, (v: T) => void] {
  const storageKey = `filter:${key}`;
  const [value, setValue] = useState<T>(() => { try { const s = localStorage.getItem(storageKey); return s ? { ...defaults, ...(JSON.parse(s) as T) } : defaults; } catch { return defaults; } });
  useEffect(() => {
    void fetch(`/api/prefs/${encodeURIComponent(storageKey)}`, { credentials: 'include' }).then(async (r) => { if (!r.ok) return; const b = (await r.json()) as { value: T | null }; if (b.value) setValue({ ...defaults, ...b.value }); }).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  const update = (v: T) => {
    setValue(v);
    try { localStorage.setItem(storageKey, JSON.stringify(v)); } catch { /* bỏ qua */ }
    void fetch(`/api/prefs/${encodeURIComponent(storageKey)}`, { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: v }) }).catch(() => undefined);
  };
  return [value, update];
}
```

`packages/ui/src/index.ts`: `export * from './VnNumberInput.js'; export * from './LookupSelect.js'; export * from './KeyboardGrid.js'; export * from './useRememberedFilter.js';`

`packages/ui/test/VnNumberInput.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VnNumberInput } from '../src/VnNumberInput.js';

describe('VnNumberInput', () => {
  it('hiển thị 1.500.000 và trả chuỗi số thuần khi gõ', () => {
    const onChange = vi.fn();
    render(<VnNumberInput value="1500000" onChange={onChange} aria-label="so" />);
    const input = screen.getByLabelText('so') as HTMLInputElement;
    expect(input.value).toBe('1.500.000');
    fireEvent.focus(input); fireEvent.change(input, { target: { value: '2500000' } }); fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith('2500000'); expect(input.value).toBe('2.500.000');
  });
});
```

`packages/ui/test/LookupSelect.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LookupSelect } from '../src/LookupSelect.js';

describe('LookupSelect', () => {
  it('tải danh sách theo từ khóa và trả mã khi chọn; có mục Thêm nhanh', async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: '1', code: 'KH001', name: 'Alpha' }]);
    const onChange = vi.fn();
    render(<LookupSelect catalog="party" fetcher={fetcher} onChange={onChange} quickAddFields={[{ key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }]} aria-label="dt" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('party', ''));
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByText('KH001 - Alpha'));
    expect(onChange).toHaveBeenCalledWith('KH001', expect.objectContaining({ code: 'KH001' }));
    await userEvent.click(screen.getByRole('combobox'));
    expect(await screen.findByText('+ Thêm nhanh…')).toBeInTheDocument();
  });
});
```

Run: `pnpm install && pnpm -F @kt/ui test && pnpm -F @kt/ui typecheck`
Expected: PASS 2 test.

- [ ] **Step 5: API tùy chọn người dùng và test**

`apps/api/src/modules/core/prefs.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/prefs/:key', { preHandler: app.requireAuth, schema: { params: z.object({ key: z.string().max(200) }) } }, async (req) =>
    app.withTenant(req, async (trx) => ({ value: (await trx.selectFrom('user_pref').select('value').where('user_id', '=', req.auth!.userId).where('tenant_id', '=', req.auth!.tenantId!).where('key', '=', req.params.key).executeTakeFirst())?.value ?? null })));
  app.put('/api/prefs/:key', { preHandler: app.requireAuth, schema: { params: z.object({ key: z.string().max(200) }), body: z.object({ value: z.unknown() }) } }, async (req) => {
    await app.withTenant(req, (trx) => trx.insertInto('user_pref').values({ user_id: req.auth!.userId, tenant_id: req.auth!.tenantId!, key: req.params.key, value: JSON.stringify(req.body.value) })
      .onConflict((oc) => oc.columns(['user_id', 'tenant_id', 'key']).doUpdateSet({ value: JSON.stringify(req.body.value) })).execute());
    return { ok: true };
  });
};
export default routes;
```

`apps/api/test/prefs.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('tùy chọn người dùng', () => {
  it('lưu và đọc lại bộ lọc theo người dùng, không thấy của người khác', async () => {
    const a = await bootstrapTenant(ctx, { code: `PA${Date.now()}` });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/prefs/filter:test', headers: { cookie: a.cookie } })).json()).toEqual({ value: null });
    await ctx.app.inject({ method: 'PUT', url: '/api/prefs/filter:test', headers: { cookie: a.cookie }, payload: { value: { q: 'abc', page: 2 } } });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/prefs/filter:test', headers: { cookie: a.cookie } })).json()).toEqual({ value: { q: 'abc', page: 2 } });
    const b = await bootstrapTenant(ctx, { code: `PB${Date.now()}` });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/prefs/filter:test', headers: { cookie: b.cookie } })).json()).toEqual({ value: null });
  });
});
```

Đăng ký `prefRoutes` trong `app.ts`. Run: `pnpm -F @kt/api test -- test/prefs.test.ts` → PASS.

- [ ] **Step 6: Trang danh mục dùng chung**

`apps/web/src/pages/Catalog.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { Button, Checkbox, DatePicker, Form, Input, Modal, Select, Space, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnDate, formatVnNumber } from '@kt/domain';
import { KeyboardGrid, LookupSelect, VnNumberInput, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';
import { useAuth } from '../auth.js';

interface ColumnDef { key: string; label: string; type: 'text' | 'number' | 'boolean' | 'date' | 'select'; required?: boolean; options?: { value: string; label: string }[]; lookup?: { catalog: string } }
interface Def { name: string; label: string; columns: ColumnDef[] }
type Row = Record<string, unknown> & { id: string | number };

export function FieldFor({ c }: { c: ColumnDef }) {
  const rules = c.required ? [{ required: true, message: `Nhập ${c.label.toLowerCase()}` }] : [];
  if (c.lookup) return <Form.Item name={c.key} label={c.label} rules={rules}><LookupSelect catalog={c.lookup.catalog} quickAddFields={[{ key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }]} /></Form.Item>;
  if (c.type === 'boolean') return <Form.Item name={c.key} label={c.label} valuePropName="checked"><Checkbox /></Form.Item>;
  if (c.type === 'number') return <Form.Item name={c.key} label={c.label} rules={rules}><VnNumberInput scale={c.key === 'rate' ? 4 : 0} /></Form.Item>;
  if (c.type === 'date') return <Form.Item name={c.key} label={c.label} rules={rules} getValueProps={(v) => ({ value: v ? dayjs(v as string) : undefined })} normalize={(v) => (v ? (v as dayjs.Dayjs).format('YYYY-MM-DD') : null)}><DatePicker format="DD/MM/YYYY" /></Form.Item>;
  if (c.type === 'select') return <Form.Item name={c.key} label={c.label} rules={rules}><Select options={c.options} /></Form.Item>;
  return <Form.Item name={c.key} label={c.label} rules={rules}><Input /></Form.Item>;
}

export default function CatalogPage() {
  const { name } = useParams({ strict: false }) as { name: string };
  const { can } = useAuth(); const qc = useQueryClient();
  const defs = useQuery({ queryKey: ['catalog-defs'], queryFn: () => api<Def[]>('/api/catalogs') });
  const def = defs.data?.find((d) => d.name === name);
  const [filter, setFilter] = useRememberedFilter(`catalog:${name}`, { q: '' });
  const rows = useQuery({ queryKey: ['catalog', name, filter.q], queryFn: () => api<{ rows: Row[]; total: number }>(`/api/catalogs/${name}?q=${encodeURIComponent(filter.q)}&size=1000`), enabled: !!def });
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => editing === 'new' ? api(`/api/catalogs/${name}`, { method: 'POST', json: v }) : api(`/api/catalogs/${name}/${(editing as Row).id}`, { method: 'PUT', json: v }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['catalog', name] }); setEditing(null); form.resetFields(); void message.success('Đã lưu'); },
    onError: (e) => void message.error((e as Error).message) });
  const remove = useMutation({ mutationFn: (id: string | number) => api(`/api/catalogs/${name}/${id}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['catalog', name] }); void message.success('Đã xóa'); }, onError: (e) => void message.error((e as Error).message) });
  const columns = useMemo<ColDef<Row>[]>(() => (def?.columns ?? []).map((c) => ({
    field: c.key, headerName: c.label, editable: false, width: c.type === 'boolean' ? 110 : 180,
    valueFormatter: (p) => c.type === 'number' ? formatVnNumber(p.value as string | null) : c.type === 'date' && p.value ? formatVnDate(p.value as string) : c.type === 'boolean' ? (p.value ? '✓' : '') : c.type === 'select' ? (c.options?.find((o) => o.value === p.value)?.label ?? '') : String(p.value ?? ''),
  })), [def]);
  if (!def) return null;
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{def.label}</h2>
        <Input.Search placeholder="Tìm mã, tên…" defaultValue={filter.q} onSearch={(q) => setFilter({ q })} style={{ width: 280 }} allowClear />
        {can('catalog.create') && <Button type="primary" onClick={() => { setEditing('new'); form.resetFields(); }}>Thêm (Insert)</Button>}
      </Space>
      <KeyboardGrid<Row> rows={rows.data?.rows ?? []} columns={[...columns, { headerName: '', width: 140, editable: false, cellRenderer: (p: { data: Row }) => (
        <Space>{can('catalog.update') && <a onClick={() => { setEditing(p.data); form.setFieldsValue(p.data); }}>Sửa</a>}
          {can('catalog.delete') && <a onClick={() => Modal.confirm({ title: `Xóa ${def.label.toLowerCase()} này?`, onOk: () => remove.mutate(p.data.id) })}>Xóa</a>}</Space>) }]}
        onRowsChange={() => undefined} addRowTemplate={() => ({ id: '' })} readOnly height="calc(100vh - 200px)" />
      <Modal title={editing === 'new' ? `Thêm ${def.label.toLowerCase()}` : `Sửa ${def.label.toLowerCase()}`} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()} width={720} destroyOnClose>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 16 }}>
          {def.columns.map((c) => <FieldFor key={c.key} c={c} />)}
        </Form>
      </Modal>
    </>
  );
}
```

`router.tsx`: route `/danh-muc/$name` → `CatalogPage`; menu "Danh mục" thêm các mục: Đối tượng `/danh-muc/party`, Nhóm đối tượng `/danh-muc/party_group`, Bộ phận `/danh-muc/department`, Nhân viên `/danh-muc/employee`, Loại tiền `/danh-muc/currency`, Tỷ giá `/danh-muc/exchange_rate`, Ngân hàng `/danh-muc/bank`, Tài khoản ngân hàng `/danh-muc/bank_account`, Hình thức thanh toán `/danh-muc/payment_method`, Loại thuế `/danh-muc/tax_code`, Nhóm hóa đơn `/danh-muc/invoice_group`, Khoản mục chi phí `/danh-muc/cost_item`, Vụ việc / công trình `/danh-muc/project`, Đơn vị tính `/danh-muc/uom` (tất cả `permission: 'catalog.view'`).

Run: `pnpm -F @kt/web typecheck && pnpm -F @kt/web test`
Expected: mã 0.

- [ ] **Step 7: Commit**

```bash
git add packages/domain packages/ui apps/api apps/web
git commit -m "feat(ui): lưới nhập liệu bàn phím, chọn danh mục F4 với thêm nhanh, ô số Việt Nam, bộ lọc nhớ và trang danh mục chung"
```

---

### Task 11: Màn hình nhật ký kiểm toán và nhật ký đăng nhập

**Files:**
- Create: `apps/api/src/modules/audit/routes.ts`; Modify: `apps/api/src/app.ts`
- Create: `apps/web/src/pages/AuditLog.tsx`; Modify: `apps/web/src/router.tsx`
- Test: `apps/api/test/audit.test.ts`, `apps/web/test/AuditLog.test.tsx`

**Interfaces:**
- Consumes: `audit_event`, `login_event` (Task 2); audit tự động từ danh mục (Task 8).
- Produces:
  - `GET /api/audit?entity=&entityId=&userId=&action=&from=&to=&page=&size=` → `{ rows: { id, ts, username, action, entity, entityId, before, after, ip }[], total }`.
  - `GET /api/audit/logins?from=&to=&page=` → `{ rows: { ts, username, success, ip }[], total }` (chỉ của người dùng thuộc công ty hiện tại).
  - `diffJson(before, after): { key: string; before: unknown; after: unknown }[]` (web) hiển thị các khóa thay đổi.

- [ ] **Step 1: Viết test (thất bại)**

`apps/api/test/audit.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('nhật ký kiểm toán', () => {
  it('lọc theo thực thể và hành động, có tên người dùng, không thấy của công ty khác', async () => {
    const a = await bootstrapTenant(ctx, { code: `AL${Date.now()}` });
    const c = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/department', headers: { cookie: a.cookie }, payload: { code: 'HC', name: 'Hành chính' } });
    await ctx.app.inject({ method: 'PUT', url: `/api/catalogs/department/${c.json().id}`, headers: { cookie: a.cookie }, payload: { name: 'Hành chính nhân sự' } });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/audit?entity=department&action=update', headers: { cookie: a.cookie } });
    expect(r.json().total).toBe(1);
    expect(r.json().rows[0]).toMatchObject({ username: a.username, entity: 'department', action: 'update', before: { name: 'Hành chính' }, after: { name: 'Hành chính nhân sự' } });
    const b = await bootstrapTenant(ctx, { code: `AK${Date.now()}` });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/audit?entity=department', headers: { cookie: b.cookie } })).json().total).toBe(0);
  });
  it('nhật ký đăng nhập liệt kê lần đăng nhập của người dùng công ty', async () => {
    const a = await bootstrapTenant(ctx, { code: `AJ${Date.now()}` });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/audit/logins', headers: { cookie: a.cookie } });
    expect(r.json().rows[0]).toMatchObject({ username: a.username, success: true });
  });
  it('người không có quyền audit.view bị 403', async () => {
    const a = await bootstrapTenant(ctx, { code: `AI${Date.now()}` });
    const roles = (await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie: a.cookie } })).json() as { id: string; code: string; permissions: string[] }[];
    const xem = roles.find((r) => r.code === 'xem')!;
    await ctx.app.inject({ method: 'PUT', url: `/api/roles/${xem.id}/permissions`, headers: { cookie: a.cookie }, payload: { permissions: xem.permissions.filter((p) => p !== 'audit.view') } });
    const username = `kt_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: a.cookie }, payload: { username, fullName: 'KT', password: 'Matkhau1!', roleCode: 'xem' } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const cookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    expect((await ctx.app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })).statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/api test -- test/audit.test.ts` → FAIL 404.

- [ ] **Step 3: Route**

`apps/api/src/modules/audit/routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';

const paging = { page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(500).default(50) };

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/audit', { preHandler: app.requirePermission('audit.view'), schema: { querystring: z.object({
      entity: z.string().optional(), entityId: z.string().optional(), userId: z.string().uuid().optional(), action: z.string().optional(),
      from: z.string().optional(), to: z.string().optional(), ...paging }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const q = req.query;
      let base = trx.selectFrom('audit_event as a').leftJoin('app_user as u', 'u.id', 'a.user_id');
      if (q.entity) base = base.where('a.entity', '=', q.entity);
      if (q.entityId) base = base.where('a.entity_id', '=', q.entityId);
      if (q.userId) base = base.where('a.user_id', '=', q.userId);
      if (q.action) base = base.where('a.action', '=', q.action);
      if (q.from) base = base.where('a.ts', '>=', q.from);
      if (q.to) base = base.where('a.ts', '<', sql<string>`(${q.to}::date + 1)`);
      const total = Number((await base.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow()).n);
      const rows = await base.select(['a.id', 'a.ts', 'u.username', 'a.action', 'a.entity', 'a.entity_id as entityId', 'a.before', 'a.after', 'a.ip'])
        .orderBy('a.id', 'desc').limit(q.size).offset((q.page - 1) * q.size).execute();
      return { rows, total };
    }));

  app.get('/api/audit/logins', { preHandler: app.requirePermission('audit.view'), schema: { querystring: z.object({ from: z.string().optional(), to: z.string().optional(), ...paging }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const tenantId = req.auth!.tenantId!;
      let base = trx.selectFrom('login_event as l').where('l.username', 'in', trx.selectFrom('tenant_user').innerJoin('app_user', 'app_user.id', 'tenant_user.user_id').select('app_user.username').where('tenant_user.tenant_id', '=', tenantId));
      if (req.query.from) base = base.where('l.ts', '>=', req.query.from);
      if (req.query.to) base = base.where('l.ts', '<', sql<string>`(${req.query.to}::date + 1)`);
      const total = Number((await base.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow()).n);
      const rows = await base.select(['l.ts', 'l.username', 'l.success', 'l.ip']).orderBy('l.id', 'desc').limit(req.query.size).offset((req.query.page - 1) * req.query.size).execute();
      return { rows, total };
    }));
};
export default routes;
```

Đăng ký trong `app.ts`. Run test → PASS 3.

- [ ] **Step 4: Màn hình**

`apps/web/src/pages/AuditLog.tsx`:

```tsx
import { useState } from 'react';
import { DatePicker, Input, Select, Space, Table, Tabs, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api } from '../api/client.js';

interface Row { id: number; ts: string; username: string | null; action: string; entity: string; entityId: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; ip: string | null }
const ACTION: Record<string, string> = { insert: 'Thêm', update: 'Sửa', delete: 'Xóa', post: 'Ghi sổ', unpost: 'Bỏ ghi sổ', reverse: 'Đảo', discard: 'Hủy', lock: 'Khóa kỳ', unlock: 'Bỏ khóa', reset_password: 'Đặt lại mật khẩu' };

export function diffJson(before: Record<string, unknown> | null, after: Record<string, unknown> | null): { key: string; before: unknown; after: unknown }[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])).map((k) => ({ key: k, before: before?.[k], after: after?.[k] }));
}

export default function AuditLogPage() {
  const [f, setF] = useState<{ entity?: string; action?: string; from?: string; to?: string; page: number }>({ page: 1 });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();
  const events = useQuery({ queryKey: ['audit', qs], queryFn: () => api<{ rows: Row[]; total: number }>(`/api/audit?${qs}`) });
  const logins = useQuery({ queryKey: ['audit-logins'], queryFn: () => api<{ rows: { ts: string; username: string; success: boolean; ip: string | null }[]; total: number }>('/api/audit/logins') });
  return (
    <Tabs items={[
      { key: 'events', label: 'Nhật ký thay đổi', children: (<>
        <Space style={{ marginBottom: 12 }}>
          <Input placeholder="Thực thể (party, voucher…)" onPressEnter={(e) => setF({ ...f, entity: (e.target as HTMLInputElement).value, page: 1 })} />
          <Select allowClear placeholder="Hành động" style={{ width: 160 }} options={Object.entries(ACTION).map(([value, label]) => ({ value, label }))} onChange={(v) => setF({ ...f, action: v, page: 1 })} />
          <DatePicker.RangePicker format="DD/MM/YYYY" onChange={(r) => setF({ ...f, from: r?.[0]?.format('YYYY-MM-DD'), to: r?.[1]?.format('YYYY-MM-DD'), page: 1 })} />
        </Space>
        <Table rowKey="id" size="small" dataSource={events.data?.rows ?? []} pagination={{ current: f.page, total: events.data?.total, pageSize: 50, onChange: (page) => setF({ ...f, page }) }}
          columns={[{ title: 'Thời gian', dataIndex: 'ts', render: (v: string) => dayjs(v).format('DD/MM/YYYY HH:mm:ss'), width: 170 }, { title: 'Người dùng', dataIndex: 'username', width: 140 },
            { title: 'Hành động', dataIndex: 'action', width: 110, render: (a: string) => <Tag>{ACTION[a] ?? a}</Tag> }, { title: 'Thực thể', dataIndex: 'entity', width: 140 }, { title: 'ID', dataIndex: 'entityId', width: 120, ellipsis: true },
            { title: 'Thay đổi', render: (_, r) => <ul style={{ margin: 0, paddingLeft: 16 }}>{diffJson(r.before, r.after).map((d) => <li key={d.key}><b>{d.key}</b>: {JSON.stringify(d.before)} → {JSON.stringify(d.after)}</li>)}</ul> },
            { title: 'IP', dataIndex: 'ip', width: 120 }]} /></>) },
      { key: 'logins', label: 'Nhật ký đăng nhập', children: (
        <Table rowKey={(r) => r.ts + r.username} size="small" dataSource={logins.data?.rows ?? []} columns={[
          { title: 'Thời gian', dataIndex: 'ts', render: (v: string) => dayjs(v).format('DD/MM/YYYY HH:mm:ss') }, { title: 'Người dùng', dataIndex: 'username' },
          { title: 'Kết quả', dataIndex: 'success', render: (s: boolean) => (s ? <Tag color="green">Thành công</Tag> : <Tag color="red">Thất bại</Tag>) }, { title: 'IP', dataIndex: 'ip' }]} />) },
    ]} />
  );
}
```

`apps/web/test/AuditLog.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { diffJson } from '../src/pages/AuditLog.js';
describe('diffJson', () => {
  it('chỉ liệt kê khóa thay đổi', () => {
    expect(diffJson({ name: 'A', code: 'X' }, { name: 'B', code: 'X' })).toEqual([{ key: 'name', before: 'A', after: 'B' }]);
    expect(diffJson(null, { name: 'A' })).toEqual([{ key: 'name', before: undefined, after: 'A' }]);
  });
});
```

Route `/he-thong/nhat-ky` + menu `{ key: 'audit', label: 'Nhật ký kiểm toán', to: '/he-thong/nhat-ky', permission: 'audit.view' }`. Run web test → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api apps/web
git commit -m "feat(audit): API và màn hình nhật ký kiểm toán, nhật ký đăng nhập"
```

---

### Task 12: Worker pg-boss, sao lưu `pg_dump` theo lịch, phục hồi bằng lệnh, nút sao lưu ngay

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/src/boss.ts`, `apps/worker/src/index.ts`, `apps/worker/src/jobs/backup.ts`
- Create: `docker/restore.sh`, `docs/user/sao-luu-phuc-hoi.md`
- Modify: `apps/api/src/app.ts` (nhận `boss?: PgBoss`), `apps/api/src/server.ts`, `apps/api/test/helpers.ts` (khởi động PgBoss thật), `apps/api/src/modules/core/tenants.ts` (route `POST /api/backup/run`)
- Test: `apps/worker/test/backup.test.ts`, `apps/api/test/backup.test.ts`

**Interfaces:**
- Consumes: `DATABASE_ADMIN_URL`, `BACKUP_DIR`, `BACKUP_CRON`, `BACKUP_KEEP`.
- Produces:
  - `createBoss(connectionString: string): PgBoss` (schema `pgboss`, `migrate: true`), hằng tên hàng đợi `QUEUES = { backup: 'backup', recomputeBalances: 'balance.recompute' } as const` (xuất từ `@kt/db` để API và worker dùng chung: thêm `packages/db/src/queues.ts`).
  - `runBackup(opts: { adminUrl: string; dir: string; keep: number; pgDumpPath?: string }): Promise<{ file: string; bytes: number; pruned: string[] }>`.
  - Worker: `boss.schedule(QUEUES.backup, BACKUP_CRON)`, `boss.work(QUEUES.backup, ...)`; log JSON ra stdout.
  - `POST /api/backup/run` (quyền `backup.run`) → `{ jobId }`; `GET /api/backup` → danh sách file trong `BACKUP_DIR` (tên, kích thước, thời gian).
  - `docker/restore.sh <file.dump>`: `pg_restore --clean --if-exists --no-owner -d "$DATABASE_ADMIN_URL" <file>`.

- [ ] **Step 1: Viết test `runBackup` (thất bại)**

`apps/worker/test/backup.test.ts`:

```ts
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runBackup } from '../src/jobs/backup.js';

const hasPgDump = (() => { try { execSync('pg_dump --version', { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!hasPgDump)('sao lưu', () => {
  it('tạo file .dump khác rỗng và chỉ giữ lại keep file mới nhất', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kt-backup-'));
    for (const n of ['ketoan_20250101T000000.dump', 'ketoan_20250102T000000.dump']) writeFileSync(path.join(dir, n), 'x');
    const r = await runBackup({ adminUrl: process.env.DATABASE_ADMIN_URL!, dir, keep: 2 });
    expect(r.bytes).toBeGreaterThan(1000);
    expect(statSync(r.file).size).toBe(r.bytes);
    expect(r.pruned).toEqual(['ketoan_20250101T000000.dump']);
    expect(readdirSync(dir).sort()).toEqual(['ketoan_20250102T000000.dump', path.basename(r.file)].sort());
  });
});
if (!hasPgDump) console.warn('CẢNH BÁO: không có pg_dump trên máy, bỏ qua test sao lưu (cài: brew install libpq && brew link --force libpq)');
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/worker test` → FAIL (module không tồn tại) hoặc skip kèm cảnh báo nếu thiếu `pg_dump`.

- [ ] **Step 3: Viết worker**

`packages/db/src/queues.ts`:

```ts
export const QUEUES = { backup: 'backup', recomputeBalances: 'balance.recompute' } as const;
export interface RecomputeBalancesJob { tenantId: string }
```

(xuất trong `packages/db/src/index.ts`).

`apps/worker/package.json`:

```json
{
  "name": "@kt/worker", "version": "0.0.1", "private": true, "type": "module",
  "scripts": { "dev": "tsx watch src/index.ts", "build": "tsc -p tsconfig.json", "typecheck": "tsc -p tsconfig.json --noEmit", "test": "vitest run" },
  "dependencies": { "@kt/db": "workspace:*", "dotenv": "^16.4.5", "kysely": "^0.27.4", "pg": "^8.13.0", "pg-boss": "^10.1.3", "zod": "^3.23.8" },
  "devDependencies": { "tsx": "^4.19.1" }
}
```

`apps/worker/src/boss.ts`:

```ts
import PgBoss from 'pg-boss';
export function createBoss(connectionString: string): PgBoss {
  return new PgBoss({ connectionString, schema: 'pgboss', migrate: true, retryLimit: 3, retryDelay: 60, archiveCompletedAfterSeconds: 7 * 24 * 3600 });
}
```

`apps/worker/src/jobs/backup.ts`:

```ts
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface BackupOpts { adminUrl: string; dir: string; keep: number; pgDumpPath?: string }

export async function runBackup(opts: BackupOpts): Promise<{ file: string; bytes: number; pruned: string[] }> {
  mkdirSync(opts.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  const file = path.join(opts.dir, `ketoan_${stamp}.dump`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn(opts.pgDumpPath ?? 'pg_dump', ['--format=custom', '--no-owner', '--file', file, '--dbname', opts.adminUrl], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', reject); p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump thoát mã ${code}: ${err}`))));
  });
  const all = readdirSync(opts.dir).filter((f) => /^ketoan_\d{8}T\d{6}\.dump$/.test(f)).sort();
  const pruned = all.slice(0, Math.max(0, all.length - opts.keep));
  for (const f of pruned) unlinkSync(path.join(opts.dir, f));
  return { file, bytes: statSync(file).size, pruned };
}
```

`apps/worker/src/index.ts`:

```ts
import 'dotenv/config';
import { z } from 'zod';
import { QUEUES } from '@kt/db';
import { createBoss } from './boss.js';
import { runBackup } from './jobs/backup.js';

const env = z.object({ DATABASE_ADMIN_URL: z.string(), BACKUP_DIR: z.string().default('./backups'), BACKUP_CRON: z.string().default('0 2 * * *'), BACKUP_KEEP: z.coerce.number().int().min(1).default(14) }).parse(process.env);
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

const boss = createBoss(env.DATABASE_ADMIN_URL);
boss.on('error', (e) => log('boss error', { error: String(e) }));
await boss.start();
await boss.createQueue(QUEUES.backup);
await boss.schedule(QUEUES.backup, env.BACKUP_CRON, {}, { tz: 'Asia/Ho_Chi_Minh' });
await boss.work(QUEUES.backup, async () => {
  const r = await runBackup({ adminUrl: env.DATABASE_ADMIN_URL, dir: env.BACKUP_DIR, keep: env.BACKUP_KEEP });
  log('backup done', r);
});
log('worker started', { cron: env.BACKUP_CRON, dir: env.BACKUP_DIR });
// Task 20 thêm boss.work(QUEUES.recomputeBalances, ...) tại đây.
```

`docker/restore.sh`:

```bash
#!/usr/bin/env bash
# Dùng: DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/ketoan docker/restore.sh backups/ketoan_20260101T020000.dump
set -euo pipefail
[ $# -eq 1 ] || { echo "Dùng: $0 <file.dump>"; exit 1; }
: "${DATABASE_ADMIN_URL:?Thiếu DATABASE_ADMIN_URL}"
echo "Phục hồi $1 vào $DATABASE_ADMIN_URL (ghi đè dữ liệu hiện có). Nhấn Enter để tiếp tục, Ctrl+C để hủy."; read -r
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_ADMIN_URL" "$1"
echo "Xong."
```

Run: `pnpm install && pnpm -F @kt/worker test` → PASS (hoặc skip có cảnh báo nếu không có `pg_dump`).

- [ ] **Step 4: API: nút sao lưu ngay và danh sách bản sao lưu**

Sửa `apps/api/src/app.ts`: `buildApp(opts: { db; config; boss?: PgBoss })`, `app.decorate('boss', opts.boss ?? null)` (khai báo `boss: PgBoss | null` trong module augmentation). `server.ts`: tạo `createBoss`-tương-đương bằng `new PgBoss({ connectionString: process.env.DATABASE_ADMIN_URL!, schema: 'pgboss' })`, `await boss.start()`, truyền vào `buildApp`. `test/helpers.ts`: khởi động PgBoss với `DATABASE_ADMIN_URL`, `await boss.start()`, truyền `boss`, và `boss.stop({ graceful: false })` trong `close`.

Thêm vào `apps/api/src/modules/core/tenants.ts`:

```ts
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { QUEUES } from '@kt/db';
// ...
app.post('/api/backup/run', { preHandler: app.requirePermission('backup.run') }, async (req) => {
  if (!app.boss) throw new AppError('NO_QUEUE', 'Hàng đợi chưa sẵn sàng', 503);
  await app.boss.createQueue(QUEUES.backup);
  const jobId = await app.boss.send(QUEUES.backup, { requestedBy: req.auth!.userId }, { singletonKey: 'manual', singletonSeconds: 60 });
  return { jobId };
});
app.get('/api/backup', { preHandler: app.requirePermission('backup.run') }, async () => {
  let files: string[] = []; try { files = readdirSync(app.config.BACKUP_DIR); } catch { files = []; }
  return files.filter((f) => f.endsWith('.dump')).sort().reverse().map((f) => { const s = statSync(path.join(app.config.BACKUP_DIR, f)); return { name: f, bytes: s.size, mtime: s.mtime.toISOString() }; });
});
```

`apps/api/test/backup.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('sao lưu', () => {
  it('đưa job vào hàng đợi backup', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `BK${Date.now()}` });
    const r = await ctx.app.inject({ method: 'POST', url: '/api/backup/run', headers: { cookie } });
    expect(r.statusCode).toBe(200); expect(typeof r.json().jobId).toBe('string');
    const job = await ctx.app.boss!.getJobById('backup', r.json().jobId);
    expect(job?.name).toBe('backup');
  });
});
```

Run: `pnpm -F @kt/api test -- test/backup.test.ts` → PASS.

- [ ] **Step 5: Tài liệu người dùng và nút trên màn hình công ty**

`docs/user/sao-luu-phuc-hoi.md`:

```markdown
# Sao lưu và phục hồi dữ liệu

- Hệ thống tự sao lưu toàn bộ cơ sở dữ liệu mỗi ngày lúc 02:00 (giờ Việt Nam) vào thư mục sao lưu (`/backups` trong Docker, biến `BACKUP_DIR`), giữ 14 bản gần nhất (`BACKUP_KEEP`).
- Sao lưu ngay: Hệ thống → Thông tin công ty → thẻ "Sao lưu" → nút "Sao lưu ngay" (cần quyền "Sao lưu dữ liệu"). Danh sách bản sao lưu hiển thị tên, dung lượng, thời gian.
- Phục hồi (người quản trị hệ thống, dòng lệnh): `DATABASE_ADMIN_URL=... docker/restore.sh backups/ketoan_YYYYMMDDTHHMMSS.dump`. Lệnh ghi đè toàn bộ dữ liệu hiện có của mọi công ty trong cơ sở dữ liệu; dừng API và worker trước khi phục hồi.
- Phục hồi thử định kỳ: khuyến nghị mỗi quý phục hồi vào một cơ sở dữ liệu tạm (`createdb ketoan_test && DATABASE_ADMIN_URL=.../ketoan_test docker/restore.sh ...`) và mở bằng một bản API trỏ vào đó.
```

`apps/web/src/pages/Company.tsx`: thêm thẻ `{ key: 'saoluu', label: 'Sao lưu', children: <BackupTab /> }` với `BackupTab` gọi `GET /api/backup` (bảng tên/dung lượng/thời gian) và nút "Sao lưu ngay" gọi `POST /api/backup/run` rồi `message.success('Đã đưa vào hàng đợi, bản sao lưu xuất hiện sau ít phút')`, chỉ hiển thị khi `can('backup.run')`.

- [ ] **Step 6: Commit**

```bash
git add apps/worker apps/api apps/web packages/db docker docs/user
git commit -m "feat(worker): sao lưu pg_dump theo lịch, phục hồi bằng lệnh, sao lưu ngay từ API"
```

---

### Task 13: Dữ liệu mẫu giai đoạn 0: công ty "Thương mại ABC"

**Files:**
- Create: `packages/db/src/seed/demo-abc.ts`, `packages/db/src/seed/common.ts`
- Test: `packages/db/test/seed-abc.test.ts`

**Interfaces:**
- Consumes: `create_tenant`, `seed_tenant_defaults` (Task 2, 8); `buildFiscalPeriods` (Task 3); `coa_template` (Task 6); hàm `generateAccounts` của API không dùng được từ gói db, nên `seed/common.ts` có bản SQL thuần `generateAccountsSql(client, tenantId, regime)`.
- Produces:
  - `seedAbc(adminUrl: string): Promise<{ tenantId: string; created: boolean }>`; CLI `pnpm db:seed:abc`.
  - Công ty mã `ABC` "Công ty TNHH Thương mại ABC", MST `0101234567`, năm 2026 TT99 (nếu `tt99Status().complete`, ngược lại TT133 kèm cảnh báo), người dùng `admin`/`Matkhau1!`, 30 đối tượng (`KH001`–`KH020` khách hàng, `NCC001`–`NCC010` nhà cung cấp), 4 bộ phận, 6 khoản mục chi phí, 2 dự án, tỷ giá USD 3 ngày.
  - `seed/common.ts`: `ensureUser(client, username, passwordHash, fullName): Promise<string>`, `ensureTenant(client, {code, name, taxCode, ownerUserId}): Promise<{id, created}>`, `withTenantClient(client, tenantId, fn)`, `insertFiscalYear(client, tenantId, input)`, `generateAccountsSql(client, tenantId, regime)`.

- [ ] **Step 1: Viết test (thất bại)**

`packages/db/test/seed-abc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { seedAbc } from '../src/seed/demo-abc.js';

describe('dữ liệu mẫu ABC', () => {
  it('chạy hai lần chỉ tạo một công ty với 30 đối tượng và hệ thống tài khoản', async () => {
    const url = process.env.DATABASE_ADMIN_URL!;
    const a = await seedAbc(url); const b = await seedAbc(url);
    expect(b.tenantId).toBe(a.tenantId); expect(b.created).toBe(false);
    const c = new pg.Client({ connectionString: url }); await c.connect();
    const n = await c.query('SELECT count(*)::int AS n FROM party WHERE tenant_id = $1', [a.tenantId]);
    const acc = await c.query('SELECT count(*)::int AS n FROM account WHERE tenant_id = $1', [a.tenantId]);
    const fp = await c.query('SELECT count(*)::int AS n FROM fiscal_period WHERE tenant_id = $1', [a.tenantId]);
    await c.end();
    expect(n.rows[0].n).toBe(30); expect(acc.rows[0].n).toBeGreaterThan(100); expect(fp.rows[0].n).toBe(13);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/db test -- test/seed-abc.test.ts` → FAIL.

- [ ] **Step 3: Viết seed**

`packages/db/src/seed/common.ts`:

```ts
import type pg from 'pg';
import { buildFiscalPeriods, type Regime } from '@kt/domain';

export async function ensureUser(c: pg.Client, username: string, passwordHash: string, fullName: string): Promise<string> {
  const r = await c.query(`INSERT INTO app_user(username, full_name, password_hash) VALUES ($1,$2,$3) ON CONFLICT (username) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`, [username, fullName, passwordHash]);
  return r.rows[0].id;
}
export async function ensureTenant(c: pg.Client, t: { code: string; name: string; taxCode: string; ownerUserId: string }): Promise<{ id: string; created: boolean }> {
  const ex = await c.query('SELECT id FROM tenant WHERE code = $1', [t.code]);
  if (ex.rows[0]) return { id: ex.rows[0].id, created: false };
  const r = await c.query('SELECT create_tenant($1,$2,$3,$4) AS id', [t.code, t.name, t.taxCode, t.ownerUserId]);
  return { id: r.rows[0].id, created: true };
}
export async function withTenantClient<T>(c: pg.Client, tenantId: string, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN'); await c.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
  try { const r = await fn(); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; }
}
export async function insertFiscalYear(c: pg.Client, tenantId: string, input: { fiscalYear: number; dateFrom: string; months: number; regime: Regime }) {
  for (const p of buildFiscalPeriods(input))
    await c.query('INSERT INTO fiscal_period(tenant_id, fiscal_year, period_no, date_from, date_to, regime) VALUES ($1,$2,$3,$4,$5,$6)', [tenantId, p.fiscalYear, p.periodNo, p.dateFrom, p.dateTo, p.regime]);
}
export async function generateAccountsSql(c: pg.Client, tenantId: string, regime: Regime): Promise<number> {
  const tpl = await c.query('SELECT * FROM coa_template WHERE regime = $1 ORDER BY length(code), code', [regime]);
  if (tpl.rows.length === 0) throw new Error(`Chưa có mẫu hệ thống tài khoản ${regime}`);
  const idByCode = new Map<string, number>();
  for (const t of tpl.rows) {
    const r = await c.query(`INSERT INTO account(tenant_id, regime, code, name, name_en, parent_id, is_group, root_type, normal_balance, track_currency, subledger_kind)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [tenantId, regime, t.code, t.name, t.name_en, t.parent_code ? idByCode.get(t.parent_code) ?? null : null, t.is_group, t.root_type, t.normal_balance, t.track_currency, t.subledger_kind]);
    idByCode.set(t.code, r.rows[0].id);
  }
  return tpl.rows.length;
}
```

`packages/db/src/seed/demo-abc.ts`:

```ts
import 'dotenv/config';
import pg from 'pg';
import argon2 from 'argon2';
import { tt99Status } from '@kt/coa-data';
import { ensureTenant, ensureUser, generateAccountsSql, insertFiscalYear, withTenantClient } from './common.js';

export async function seedAbc(adminUrl: string): Promise<{ tenantId: string; created: boolean }> {
  const c = new pg.Client({ connectionString: adminUrl }); await c.connect();
  try {
    const admin = await ensureUser(c, 'admin', await argon2.hash('Matkhau1!'), 'Quản trị hệ thống');
    const t = await ensureTenant(c, { code: 'ABC', name: 'Công ty TNHH Thương mại ABC', taxCode: '0101234567', ownerUserId: admin });
    if (!t.created) return { tenantId: t.id, created: false };
    const regime = tt99Status().complete ? 'TT99' : 'TT133';
    if (regime === 'TT133') console.warn('CẢNH BÁO: tt99.csv chưa hoàn tất, công ty mẫu dùng TT133');
    await withTenantClient(c, t.id, async () => {
      await c.query(`UPDATE tenant SET address = '12 Lý Thường Kiệt, Hoàn Kiếm, Hà Nội', legal_rep = 'Nguyễn Văn An', chief_accountant = 'Trần Thị Bình' WHERE id = $1`, [t.id]);
      await insertFiscalYear(c, t.id, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime });
      await generateAccountsSql(c, t.id, regime);
      for (const [code, name] of [['BGD', 'Ban giám đốc'], ['KD', 'Phòng kinh doanh'], ['KT', 'Phòng kế toán'], ['HC', 'Phòng hành chính']])
        await c.query('INSERT INTO department(tenant_id, code, name) VALUES ($1,$2,$3)', [t.id, code, name]);
      for (const [code, name, acc] of [['CP_LUONG', 'Chi phí lương', '6421'], ['CP_VP', 'Văn phòng phẩm', '6422'], ['CP_THUE_VP', 'Thuê văn phòng', '6427'], ['CP_DIEN', 'Điện nước', '6427'], ['CP_KHAC', 'Chi phí khác', '6428'], ['CP_QC', 'Quảng cáo', '6417']])
        await c.query('INSERT INTO cost_item(tenant_id, code, name, default_account_code) VALUES ($1,$2,$3,$4)', [t.id, code, name, acc]);
      const g = await c.query(`INSERT INTO party_group(tenant_id, code, name) VALUES ($1,'KH_DN','Khách hàng doanh nghiệp'),($1,'NCC','Nhà cung cấp') RETURNING id, code`, [t.id]);
      const gid = (code: string) => g.rows.find((r) => r.code === code).id;
      for (let i = 1; i <= 20; i++)
        await c.query(`INSERT INTO party(tenant_id, code, name, is_customer, group_id, tax_code, address, payment_term_days, default_account_code) VALUES ($1,$2,$3,true,$4,$5,$6,30,'131')`,
          [t.id, `KH${String(i).padStart(3, '0')}`, `Công ty Cổ phần Khách hàng ${i}`, gid('KH_DN'), `01012345${String(i).padStart(2, '0')}`, `Số ${i} đường Láng, Hà Nội`]);
      for (let i = 1; i <= 10; i++)
        await c.query(`INSERT INTO party(tenant_id, code, name, is_vendor, group_id, tax_code, address, payment_term_days, default_account_code) VALUES ($1,$2,$3,true,$4,$5,$6,15,'331')`,
          [t.id, `NCC${String(i).padStart(3, '0')}`, `Công ty TNHH Nhà cung cấp ${i}`, gid('NCC'), `03098765${String(i).padStart(2, '0')}`, `Số ${i} Nguyễn Trãi, Hà Nội`]);
      await c.query(`INSERT INTO project(tenant_id, code, name, party_id) SELECT $1, 'DA01', 'Dự án triển khai phần mềm A', id FROM party WHERE tenant_id = $1 AND code = 'KH001'`, [t.id]);
      await c.query(`INSERT INTO project(tenant_id, code, name, party_id) SELECT $1, 'DA02', 'Dự án tư vấn B', id FROM party WHERE tenant_id = $1 AND code = 'KH002'`, [t.id]);
      await c.query(`INSERT INTO exchange_rate(tenant_id, currency_code, rate_date, rate_type, rate) VALUES ($1,'USD','2026-01-02','transfer_avg',25350),($1,'USD','2026-01-15','transfer_avg',25400),($1,'USD','2026-02-02','transfer_avg',25450)`, [t.id]);
      const b = await c.query(`INSERT INTO bank(tenant_id, code, name, short_name) VALUES ($1,'VCB','Ngân hàng TMCP Ngoại thương Việt Nam','Vietcombank') RETURNING id`, [t.id]);
      await c.query(`INSERT INTO bank_account(tenant_id, bank_id, account_no, account_name, branch, currency_code, gl_account_code) VALUES ($1,$2,'0011001234567','CONG TY TNHH THUONG MAI ABC','Sở giao dịch','VND','1121')`, [t.id, b.rows[0].id]);
    });
    return { tenantId: t.id, created: true };
  } finally { await c.end(); }
}

if (process.argv[1] && process.argv[1].endsWith('demo-abc.ts')) {
  const r = await seedAbc(process.env.DATABASE_ADMIN_URL!);
  console.log(r.created ? `Đã tạo công ty mẫu ABC (${r.tenantId}); đăng nhập admin / Matkhau1!` : `Công ty ABC đã có (${r.tenantId})`);
}
```

Thêm `argon2` vào dependencies của `@kt/db`. Run: `pnpm install && pnpm -F @kt/db test -- test/seed-abc.test.ts` → PASS.

- [ ] **Step 4: Kiểm tra `docker compose up` toàn bộ và viết tài liệu người dùng GĐ0**

Run:

```bash
docker compose build && docker compose up -d && sleep 15 && curl -s localhost:3000/api/health
docker compose exec api node packages/db/dist/seed/demo-abc.js
```

Expected: `{"ok":true}`; mở `http://localhost:8080`, đăng nhập `admin`/`Matkhau1!`, thấy công ty ABC, menu Danh mục có 30 đối tượng, Hệ thống tài khoản có cây.

`docs/user/giai-doan-0-bat-dau.md`: hướng dẫn ngắn (đăng nhập, tạo công ty, năm tài chính, hệ thống tài khoản, danh mục, nhập Excel, người dùng và quyền, nhật ký kiểm toán, sao lưu), mỗi mục 2–4 dòng và đường dẫn menu.

- [ ] **Step 5: Commit và gắn thẻ kết thúc giai đoạn 0**

```bash
git add packages/db docs/user
git commit -m "feat(db): dữ liệu mẫu công ty Thương mại ABC và tài liệu người dùng giai đoạn 0"
git tag gd0-hoan-tat
```

---

# GIAI ĐOẠN 1: LÕI SỔ CÁI

### Task 14: Migration sổ cái: `voucher_type`, `voucher`, `voucher_line` (partition), `voucher_counter`, `voucher_line_history`, `voucher_attachment`, `voucher_pair`, `balance_stale`; trigger cân bằng, bất biến, tài khoản kiểm soát, kỳ

**Files:**
- Create: `packages/db/migrations/0004_so_cai.sql`
- Modify: `packages/db/src/types.ts` (thêm bảng), `packages/db/src/seed/common.ts` (không đổi; `voucher_type` được seed trong `seed_tenant_defaults`)
- Test: `packages/db/test/ledger-schema.test.ts`

**Interfaces:**
- Consumes: `fiscal_period`, `account`, `party`, `rls_enable`, `audit_enable`, `seed_tenant_defaults` (Task 2, 8).
- Produces (SQL):
  - Bảng `voucher_type(id, tenant_id, code, name, module, prefix, suffix, pad_length, is_system, is_active)`; seed cho công ty mới: `PKT` Phiếu kế toán, `DK` Số dư đầu kỳ, `KC` Chứng từ kết chuyển, `PB` Chứng từ phân bổ (module `general`).
  - Bảng `voucher` (đúng mục 6 đặc tả, thêm `fiscal_year int NOT NULL`, `period_no int NOT NULL` do trigger điền), `voucher_line` (partition theo tháng, PK `(id, posting_date)`), `voucher_counter`, `voucher_line_history(id, tenant_id, voucher_id, version, header jsonb, lines jsonb, archived_at, archived_by)`, `voucher_attachment`, `voucher_pair(id, tenant_id, voucher_id, posting_date, debit_account_id, credit_account_id, debit_party_id, credit_party_id, amount, is_closing)`, `balance_stale(tenant_id PK, stale_year int, stale_period int)`.
  - Hàm: `fn_period_of(p_tenant uuid, p_date date, p_opening boolean) RETURNS fiscal_period`; `fn_assert_period_writable(p fiscal_period, p_module text)`; `ensure_line_partitions(p_from date, p_to date)` (SECURITY DEFINER, bật RLS cho từng partition); `fn_build_pairs(p_voucher uuid)`; `mark_balance_stale(p_tenant uuid, p_year int, p_period int)`.
  - Trigger: `trg_voucher_before` (điền `fiscal_year/period_no`, kiểm tra kỳ, chặn đổi trạng thái ngoài thủ tục qua biến `app.state_change`, bất biến header khi đã ghi sổ trừ `description`, tự tăng `version`), `trg_voucher_delete` (chỉ xóa draft chưa có số), `trg_line_before` (điền `tenant_id/posting_date`, kiểm tra tài khoản chi tiết/đang dùng, đối tượng bắt buộc, chặn thêm dòng vào chứng từ đã ghi sổ), `trg_line_immutable` (chặn sửa/xóa dòng đã ghi sổ trừ chiều phân tích; bỏ qua khi `app.unposting = 'on'`), `trg_voucher_balanced` (constraint trigger deferred trên `voucher_line` và `voucher`), `trg_fiscal_period_partitions` (AFTER INSERT fiscal_period → tạo partition), `trg_account_in_use` (không đổi mã/xóa tài khoản đã có dòng).
  - Mã lỗi: `PERIOD_NOT_FOUND`, `PERIOD_HARD_LOCKED`, `PERIOD_SOFT_LOCKED`, `PERIOD_MODULE_LOCKED`, `STATE_CHANGE_VIA_PROC`, `VOUCHER_IMMUTABLE`, `VOUCHER_DELETE_FORBIDDEN`, `LINE_IMMUTABLE`, `ACCOUNT_IS_GROUP`, `ACCOUNT_INACTIVE`, `LINE_PARTY_REQUIRED`, `LINE_ITEM_REQUIRED`, `LINE_ASSET_REQUIRED`, `VOUCHER_UNBALANCED`, `VOUCHER_UNBALANCED_CURRENCY`, `VOUCHER_EMPTY`, `ACCOUNT_IN_USE`, `VOUCHER_TYPE_NOT_FOUND`.

- [ ] **Step 1: Viết test lược đồ (thất bại)**

`packages/db/test/ledger-schema.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '../src/client.js';
import { createTestTenant, setupTestDb, type TestDb } from '../src/testing.js';
import { insertFiscalYear, generateAccountsSql } from '../src/seed/common.js';
import pg from 'pg';

let t: TestDb; let tenantId: string; let userId: string;
const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
async function acc(code: string) { return (await sql<{ id: number }>`SELECT id FROM account WHERE tenant_id = ${tenantId}::uuid AND code = ${code}`.execute(t.admin)).rows[0]!.id; }

beforeAll(async () => {
  t = await setupTestDb(); await admin.connect();
  tenantId = await createTestTenant(t.admin, { code: `LS${Date.now()}`, name: 'Lược đồ sổ cái' });
  userId = (await sql<{ user_id: string }>`SELECT user_id FROM tenant_user WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin)).rows[0]!.user_id;
  await admin.query(`SELECT set_config('app.current_tenant', $1, false)`, [tenantId]);
  await insertFiscalYear(admin, tenantId, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  await generateAccountsSql(admin, tenantId, 'TT133');
});
afterAll(async () => { await admin.end(); await t.close(); });

const ctx = () => ({ tenantId, userId });
async function newVoucher(date: string, lines: { code: string; debit?: string; credit?: string; party?: string | null }[], type = 'PKT') {
  return withTenant(t.db, ctx(), async (trx) => {
    const v = await trx.insertInto('voucher').values({ tenant_id: tenantId, voucher_type: type, posting_date: date, document_date: date, state: 'draft', description: 'test', currency_code: 'VND', created_by: userId })
      .returning('id').executeTakeFirstOrThrow();
    let n = 0;
    for (const l of lines) {
      await trx.insertInto('voucher_line').values({ tenant_id: tenantId, voucher_id: v.id, line_no: ++n, account_id: await acc(l.code), posting_date: date, currency_code: 'VND',
        debit: l.debit ?? '0', credit: l.credit ?? '0', amount_currency: l.debit ? l.debit : `-${l.credit}`, party_id: l.party ?? null }).execute();
    }
    return v.id;
  });
}

describe('lược đồ sổ cái', () => {
  it('partition theo tháng được tạo cho năm tài chính và có RLS', async () => {
    const r = await sql<{ relname: string; relrowsecurity: boolean }>`SELECT c.relname, c.relrowsecurity FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'voucher_line'::regclass AND c.relname LIKE 'voucher_line_y2026%' ORDER BY 1`.execute(t.admin);
    expect(r.rows.map((x) => x.relname)).toEqual(expect.arrayContaining(['voucher_line_y2026m01', 'voucher_line_y2026m12']));
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
    expect((await sql<{ n: string }>`SELECT count(*) AS n FROM pg_class WHERE relname = 'voucher_line_y2025m12'`.execute(t.admin)).rows[0]!.n).toBe('1');
  });

  it('chứng từ lệch bị từ chối khi commit; cân thì ghi được và trigger điền fiscal_year/period_no', async () => {
    await expect(newVoucher('2026-03-10', [{ code: '1111', debit: '100' }, { code: '5113', credit: '90' }])).rejects.toThrow(/VOUCHER_UNBALANCED/);
    const id = await newVoucher('2026-03-10', [{ code: '1111', debit: '100' }, { code: '5113', credit: '100' }]);
    const v = await withTenant(t.db, ctx(), (trx) => trx.selectFrom('voucher').select(['fiscal_year', 'period_no', 'state']).where('id', '=', id).executeTakeFirstOrThrow());
    expect(v).toEqual({ fiscal_year: 2026, period_no: 3, state: 'draft' });
  });

  it('ngày ngoài năm tài chính, tài khoản tổng hợp, thiếu đối tượng trên 131 đều bị từ chối', async () => {
    await expect(newVoucher('2027-01-05', [{ code: '1111', debit: '1' }, { code: '5113', credit: '1' }])).rejects.toThrow(/PERIOD_NOT_FOUND/);
    await expect(newVoucher('2026-01-05', [{ code: '111', debit: '1' }, { code: '5113', credit: '1' }])).rejects.toThrow(/ACCOUNT_IS_GROUP/);
    await expect(newVoucher('2026-01-05', [{ code: '131', debit: '1' }, { code: '5113', credit: '1' }])).rejects.toThrow(/LINE_PARTY_REQUIRED/);
  });

  it('đổi state trực tiếp bị chặn; xóa chứng từ draft chưa có số thì được', async () => {
    const id = await newVoucher('2026-02-01', [{ code: '1111', debit: '5' }, { code: '5113', credit: '5' }]);
    await expect(withTenant(t.db, ctx(), (trx) => trx.updateTable('voucher').set({ state: 'posted' }).where('id', '=', id).execute())).rejects.toThrow(/STATE_CHANGE_VIA_PROC/);
    await withTenant(t.db, ctx(), async (trx) => { await trx.deleteFrom('voucher_line').where('voucher_id', '=', id).execute(); await trx.deleteFrom('voucher').where('id', '=', id).execute(); });
  });

  it('fn_build_pairs ghép 1 Nợ – n Có chính xác và n–n theo tỷ lệ không mất đồng nào', async () => {
    const id = await newVoucher('2026-02-02', [{ code: '6421', debit: '70' }, { code: '6422', debit: '30' }, { code: '1111', credit: '33' }, { code: '1121', credit: '67' }]);
    await sql`SELECT set_config('app.current_tenant', ${tenantId}, true), fn_build_pairs(${id}::uuid)`.execute(t.admin);
    const pairs = await sql<{ amount: string }>`SELECT amount FROM voucher_pair WHERE voucher_id = ${id}::uuid`.execute(t.admin);
    expect(pairs.rows.reduce((s, p) => s + Number(p.amount), 0)).toBe(100);
    expect(pairs.rows).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/db test -- test/ledger-schema.test.ts`
Expected: FAIL `relation "voucher" does not exist`.

- [ ] **Step 3: Viết migration `0004_so_cai.sql`**

```sql
-- ===== Loại chứng từ =====
CREATE TABLE voucher_type (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL,
  module text NOT NULL DEFAULT 'general' CHECK (module IN ('general','cash','bank','inventory','arap','assets','payroll')),
  prefix text NOT NULL DEFAULT '', suffix text NOT NULL DEFAULT '', pad_length int NOT NULL DEFAULT 5 CHECK (pad_length BETWEEN 1 AND 10),
  is_system boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code));
SELECT rls_enable('voucher_type'), audit_enable('voucher_type');

CREATE OR REPLACE FUNCTION seed_voucher_types(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO voucher_type(tenant_id, code, name, module, prefix, is_system) VALUES
    (p_tenant, 'PKT', 'Phiếu kế toán', 'general', 'PKT', true),
    (p_tenant, 'DK', 'Số dư đầu kỳ', 'general', 'DK', true),
    (p_tenant, 'KC', 'Chứng từ kết chuyển', 'general', 'KC', true),
    (p_tenant, 'PB', 'Chứng từ phân bổ', 'general', 'PB', true)
  ON CONFLICT DO NOTHING;
$$;
-- Nối vào seed_tenant_defaults: thêm dòng PERFORM seed_voucher_types(p_tenant); (định nghĩa lại hàm với nội dung cũ + dòng này)
CREATE OR REPLACE FUNCTION seed_tenant_defaults(p_tenant uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO currency(tenant_id, code, name, symbol, minor_unit) VALUES (p_tenant, 'VND', 'Đồng Việt Nam', '₫', 0), (p_tenant, 'USD', 'Đô la Mỹ', '$', 2) ON CONFLICT DO NOTHING;
  INSERT INTO payment_method(tenant_id, code, name) VALUES (p_tenant, 'TM', 'Tiền mặt'), (p_tenant, 'CK', 'Chuyển khoản'), (p_tenant, 'TM/CK', 'Tiền mặt hoặc chuyển khoản') ON CONFLICT DO NOTHING;
  INSERT INTO tax_code(tenant_id, code, name, kind, rate, is_exempt, in_declaration) VALUES
    (p_tenant, 'V0', 'Thuế GTGT 0%', 'vat', 0, false, true), (p_tenant, 'V5', 'Thuế GTGT 5%', 'vat', 5, false, true),
    (p_tenant, 'V8', 'Thuế GTGT 8% (giảm theo NQ 204/2025)', 'vat', 8, false, true), (p_tenant, 'V10', 'Thuế GTGT 10%', 'vat', 10, false, true),
    (p_tenant, 'KCT', 'Không chịu thuế GTGT', 'vat', NULL, true, true), (p_tenant, 'KKK', 'Không kê khai, tính nộp thuế GTGT', 'vat', NULL, true, false),
    (p_tenant, 'NK', 'Thuế nhập khẩu', 'import', NULL, false, false), (p_tenant, 'TTDB', 'Thuế tiêu thụ đặc biệt', 'excise', NULL, false, false) ON CONFLICT DO NOTHING;
  INSERT INTO invoice_group(tenant_id, scope, code, name, rate) VALUES
    (p_tenant, 'purchase', '01', 'HHDV dùng riêng cho SXKD chịu thuế GTGT đủ điều kiện khấu trừ', NULL),
    (p_tenant, 'purchase', '02', 'HHDV dùng riêng cho SXKD không chịu thuế GTGT', NULL),
    (p_tenant, 'purchase', '03', 'HHDV dùng chung cho SXKD chịu thuế và không chịu thuế', NULL),
    (p_tenant, 'purchase', '04', 'HHDV dùng cho dự án đầu tư', NULL),
    (p_tenant, 'purchase', '05', 'HHDV không đủ điều kiện khấu trừ / không tổng hợp lên tờ khai', NULL),
    (p_tenant, 'sale', '00', 'Bán ra chịu thuế suất 0%', 0), (p_tenant, 'sale', '05', 'Bán ra chịu thuế suất 5%', 5),
    (p_tenant, 'sale', '08', 'Bán ra chịu thuế suất 8%', 8), (p_tenant, 'sale', '10', 'Bán ra chịu thuế suất 10%', 10),
    (p_tenant, 'sale', 'KCT', 'Bán ra không chịu thuế', NULL) ON CONFLICT DO NOTHING;
  INSERT INTO uom(tenant_id, code, name) VALUES (p_tenant, 'CAI', 'Cái'), (p_tenant, 'CHIEC', 'Chiếc'), (p_tenant, 'BO', 'Bộ'), (p_tenant, 'GIO', 'Giờ'), (p_tenant, 'THANG', 'Tháng') ON CONFLICT DO NOTHING;
  PERFORM seed_voucher_types(p_tenant);
END $$;
-- Công ty đã tạo trước migration này: bổ sung loại chứng từ.
SELECT seed_voucher_types(id) FROM tenant;

-- ===== Chứng từ =====
CREATE TABLE voucher (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  voucher_type text NOT NULL,
  voucher_no text, seq_no bigint,
  posting_date date NOT NULL, document_date date NOT NULL,
  fiscal_year int NOT NULL DEFAULT 0, period_no int NOT NULL DEFAULT -1,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','posted','reversed','cancelled')),
  description text,
  party_id uuid REFERENCES party(id),
  currency_code char(3) NOT NULL DEFAULT 'VND', fx_rate numeric(20,10),
  source_doc_type text, source_doc_id uuid,
  reversal_of_id uuid REFERENCES voucher(id), reversed_by_id uuid REFERENCES voucher(id),
  is_closing boolean NOT NULL DEFAULT false,
  idempotency_key text,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid, posted_at timestamptz,
  version int NOT NULL DEFAULT 1,
  prev_hash bytea, row_hash bytea,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, voucher_type, voucher_no)
);
CREATE INDEX ON voucher (tenant_id, posting_date);
CREATE INDEX ON voucher (tenant_id, voucher_type, fiscal_year, seq_no);
CREATE INDEX ON voucher (tenant_id, fiscal_year, period_no, state);
CREATE INDEX ON voucher (tenant_id, source_doc_type, source_doc_id);

CREATE TABLE voucher_line (
  id bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL,
  voucher_id uuid NOT NULL REFERENCES voucher(id),
  line_no int NOT NULL,
  account_id bigint NOT NULL REFERENCES account(id),
  posting_date date NOT NULL,
  currency_code char(3) NOT NULL DEFAULT 'VND', fx_rate numeric(20,10),
  amount_currency numeric(20,4) NOT NULL DEFAULT 0,
  debit numeric(20,0) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(20,0) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  balance numeric(20,0) GENERATED ALWAYS AS (debit - credit) STORED,
  party_id uuid, item_id bigint, warehouse_id bigint, department_id bigint, project_id bigint, cost_item_id bigint, contract_id bigint, employee_id bigint, asset_id bigint,
  extra_dims jsonb NOT NULL DEFAULT '{}',
  description text, due_date date,
  CONSTRAINT one_side_only CHECK (debit = 0 OR credit = 0),
  CONSTRAINT not_empty_line CHECK (debit > 0 OR credit > 0 OR amount_currency <> 0),
  CONSTRAINT sign_consistent CHECK ((amount_currency >= 0 AND credit = 0) OR (amount_currency <= 0 AND debit = 0)),
  PRIMARY KEY (id, posting_date),
  UNIQUE (voucher_id, line_no, posting_date)
) PARTITION BY RANGE (posting_date);
CREATE INDEX ON voucher_line (tenant_id, account_id, posting_date) INCLUDE (debit, credit);
CREATE INDEX ON voucher_line (tenant_id, party_id, posting_date);
CREATE INDEX ON voucher_line (voucher_id);

CREATE TABLE voucher_counter (
  tenant_id uuid NOT NULL, voucher_type text NOT NULL, fiscal_year int NOT NULL, last_no bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, voucher_type, fiscal_year));
CREATE TABLE voucher_line_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, voucher_id uuid NOT NULL REFERENCES voucher(id),
  version int NOT NULL, header jsonb NOT NULL, lines jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(), archived_by uuid);
CREATE INDEX ON voucher_line_history (tenant_id, voucher_id);
REVOKE UPDATE, DELETE ON voucher_line_history FROM app_user;
CREATE TABLE voucher_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, voucher_id uuid NOT NULL REFERENCES voucher(id),
  file_name text NOT NULL, mime text NOT NULL, bytes bigint NOT NULL, storage_key text NOT NULL,
  uploaded_by uuid NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE voucher_pair (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, voucher_id uuid NOT NULL REFERENCES voucher(id) ON DELETE CASCADE,
  posting_date date NOT NULL, debit_account_id bigint NOT NULL REFERENCES account(id), credit_account_id bigint NOT NULL REFERENCES account(id),
  debit_party_id uuid, credit_party_id uuid, amount numeric(20,0) NOT NULL CHECK (amount > 0), is_closing boolean NOT NULL DEFAULT false);
CREATE INDEX ON voucher_pair (tenant_id, posting_date, debit_account_id, credit_account_id);
CREATE INDEX ON voucher_pair (voucher_id);
CREATE TABLE balance_stale (tenant_id uuid PRIMARY KEY, stale_year int NOT NULL, stale_period int NOT NULL, marked_at timestamptz NOT NULL DEFAULT now());

SELECT rls_enable(t) FROM unnest(ARRAY['voucher','voucher_line','voucher_counter','voucher_line_history','voucher_attachment','voucher_pair','balance_stale']::regclass[]) AS t;

-- ===== Partition theo tháng =====
CREATE OR REPLACE FUNCTION ensure_line_partitions(p_from date, p_to date) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d date := date_trunc('month', p_from)::date; v_name text;
BEGIN
  WHILE d <= p_to LOOP
    v_name := format('voucher_line_y%sm%s', to_char(d, 'YYYY'), to_char(d, 'MM'));
    IF to_regclass(v_name) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF voucher_line FOR VALUES FROM (%L) TO (%L)', v_name, d, (d + interval '1 month')::date);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_name);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', v_name);
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', v_name);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', v_name);
    END IF;
    d := (d + interval '1 month')::date;
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION fn_fiscal_period_partitions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM ensure_line_partitions(NEW.date_from, NEW.date_to); RETURN NEW; END $$;
CREATE TRIGGER trg_fiscal_period_partitions AFTER INSERT ON fiscal_period FOR EACH ROW EXECUTE FUNCTION fn_fiscal_period_partitions();
SELECT ensure_line_partitions(min(date_from), max(date_to)) FROM fiscal_period HAVING count(*) > 0;

-- ===== Kỳ =====
CREATE OR REPLACE FUNCTION fn_period_of(p_tenant uuid, p_date date, p_opening boolean) RETURNS fiscal_period LANGUAGE plpgsql STABLE AS $$
DECLARE p fiscal_period;
BEGIN
  IF p_opening THEN
    SELECT * INTO p FROM fiscal_period WHERE tenant_id = p_tenant AND period_no = 0 AND date_from = p_date;
  ELSE
    SELECT * INTO p FROM fiscal_period WHERE tenant_id = p_tenant AND period_no BETWEEN 1 AND 15 AND p_date BETWEEN date_from AND date_to;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERIOD_NOT_FOUND: ngày % không thuộc kỳ kế toán nào đã mở', p_date USING ERRCODE = 'P0001'; END IF;
  RETURN p;
END $$;

CREATE OR REPLACE FUNCTION fn_assert_period_writable(p fiscal_period, p_module text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p.status = 'hard_locked' THEN RAISE EXCEPTION 'PERIOD_HARD_LOCKED: kỳ %/% đã khóa cứng', p.period_no, p.fiscal_year USING ERRCODE = 'P0001'; END IF;
  IF p.status = 'soft_locked' AND current_setting('app.override_soft_lock', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'PERIOD_SOFT_LOCKED: kỳ %/% đã khóa sổ, cần quyền ghi lùi ngày', p.period_no, p.fiscal_year USING ERRCODE = 'P0001'; END IF;
  IF p_module = ANY (p.locked_modules) THEN RAISE EXCEPTION 'PERIOD_MODULE_LOCKED: phần hành % đã khóa ở kỳ %/%', p_module, p.period_no, p.fiscal_year USING ERRCODE = 'P0001'; END IF;
END $$;
ALTER TABLE fiscal_period ADD COLUMN locked_modules text[] NOT NULL DEFAULT '{}';

-- ===== Trigger chứng từ =====
CREATE OR REPLACE FUNCTION fn_voucher_before() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p fiscal_period; vt voucher_type; v_in_proc boolean := current_setting('app.state_change', true) = 'on';
        v_renum boolean := current_setting('app.renumbering', true) = 'on'; v_lock boolean := current_setting('app.locking', true) = 'on';
BEGIN
  SELECT * INTO vt FROM voucher_type WHERE tenant_id = NEW.tenant_id AND code = NEW.voucher_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_TYPE_NOT_FOUND: loại chứng từ %', NEW.voucher_type USING ERRCODE = 'P0001'; END IF;
  p := fn_period_of(NEW.tenant_id, NEW.posting_date, NEW.voucher_type = 'DK');
  NEW.fiscal_year := p.fiscal_year; NEW.period_no := p.period_no;
  IF TG_OP = 'INSERT' THEN
    PERFORM fn_assert_period_writable(p, vt.module);
    NEW.state := 'draft'; NEW.version := 1;
    RETURN NEW;
  END IF;
  NEW.version := OLD.version + 1;
  IF NEW.state <> OLD.state AND NOT v_in_proc THEN RAISE EXCEPTION 'STATE_CHANGE_VIA_PROC: đổi trạng thái chỉ qua post/unpost/reverse/discard' USING ERRCODE = 'P0001'; END IF;
  IF NEW.posting_date <> OLD.posting_date OR (OLD.state = 'draft' AND NEW.state = 'posted') OR (OLD.state = 'posted' AND NEW.state = 'draft') THEN
    PERFORM fn_assert_period_writable(p, vt.module);
    IF NEW.posting_date <> OLD.posting_date THEN PERFORM fn_assert_period_writable(fn_period_of(OLD.tenant_id, OLD.posting_date, OLD.voucher_type = 'DK'), vt.module); END IF;
  ELSIF p.status = 'hard_locked' AND NOT v_lock THEN
    RAISE EXCEPTION 'PERIOD_HARD_LOCKED: kỳ %/% đã khóa cứng', p.period_no, p.fiscal_year USING ERRCODE = 'P0001';
  END IF;
  IF OLD.state IN ('posted','reversed','cancelled') AND NOT v_in_proc AND NOT v_renum AND NOT v_lock THEN
    IF (to_jsonb(NEW) - 'description' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'description' - 'version') THEN
      RAISE EXCEPTION 'VOUCHER_IMMUTABLE: chứng từ đã ghi sổ chỉ sửa được diễn giải; dùng Bỏ ghi sổ hoặc Đảo' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_voucher_before BEFORE INSERT OR UPDATE ON voucher FOR EACH ROW EXECUTE FUNCTION fn_voucher_before();

CREATE OR REPLACE FUNCTION fn_voucher_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'draft' OR OLD.voucher_no IS NOT NULL THEN
    RAISE EXCEPTION 'VOUCHER_DELETE_FORBIDDEN: chỉ xóa được chứng từ nháp chưa cấp số; dùng Hủy' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, ip)
    VALUES (OLD.tenant_id, app_user_id(), 'delete', 'voucher', OLD.id::text, to_jsonb(OLD), nullif(current_setting('app.client_ip', true), ''));
  RETURN OLD;
END $$;
CREATE TRIGGER trg_voucher_delete BEFORE DELETE ON voucher FOR EACH ROW EXECUTE FUNCTION fn_voucher_delete();

-- ===== Trigger dòng =====
CREATE OR REPLACE FUNCTION fn_line_before() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v voucher; a account;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = NEW.voucher_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', NEW.voucher_id USING ERRCODE = 'P0001'; END IF;
  NEW.tenant_id := v.tenant_id; NEW.posting_date := v.posting_date;
  IF TG_OP = 'INSERT' AND v.state <> 'draft' AND current_setting('app.unposting', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'LINE_IMMUTABLE: không thêm dòng vào chứng từ đã ghi sổ' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO a FROM account WHERE id = NEW.account_id AND tenant_id = v.tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: tài khoản id %', NEW.account_id USING ERRCODE = 'P0001'; END IF;
  IF a.is_group THEN RAISE EXCEPTION 'ACCOUNT_IS_GROUP: tài khoản % là tài khoản tổng hợp, không định khoản được', a.code USING ERRCODE = 'P0001'; END IF;
  IF NOT a.is_active THEN RAISE EXCEPTION 'ACCOUNT_INACTIVE: tài khoản % đã ngừng sử dụng', a.code USING ERRCODE = 'P0001'; END IF;
  IF a.subledger_kind IN ('receivable','payable') AND NEW.party_id IS NULL THEN RAISE EXCEPTION 'LINE_PARTY_REQUIRED: tài khoản % phải có đối tượng', a.code USING ERRCODE = 'P0001'; END IF;
  IF a.subledger_kind = 'inventory' AND NEW.item_id IS NULL THEN RAISE EXCEPTION 'LINE_ITEM_REQUIRED: tài khoản % phải có vật tư', a.code USING ERRCODE = 'P0001'; END IF;
  IF a.subledger_kind = 'fixed_asset' AND NEW.asset_id IS NULL THEN RAISE EXCEPTION 'LINE_ASSET_REQUIRED: tài khoản % phải có tài sản', a.code USING ERRCODE = 'P0001'; END IF;
  IF NEW.currency_code = 'VND' THEN NEW.amount_currency := NEW.debit - NEW.credit; NEW.fx_rate := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_line_before BEFORE INSERT OR UPDATE ON voucher_line FOR EACH ROW EXECUTE FUNCTION fn_line_before();

CREATE OR REPLACE FUNCTION fn_line_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_state text; v_status text;
BEGIN
  IF current_setting('app.unposting', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT v.state, p.status INTO v_state, v_status FROM voucher v JOIN fiscal_period p ON p.tenant_id = v.tenant_id AND p.fiscal_year = v.fiscal_year AND p.period_no = v.period_no WHERE v.id = OLD.voucher_id;
  IF v_state IN ('posted','reversed','cancelled') THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'LINE_IMMUTABLE: không xóa dòng của chứng từ đã ghi sổ' USING ERRCODE = 'P0001'; END IF;
    IF v_status = 'hard_locked' THEN RAISE EXCEPTION 'PERIOD_HARD_LOCKED: kỳ đã khóa cứng' USING ERRCODE = 'P0001'; END IF;
    IF (to_jsonb(NEW) - 'description' - 'due_date' - 'department_id' - 'project_id' - 'cost_item_id' - 'employee_id' - 'extra_dims')
       IS DISTINCT FROM (to_jsonb(OLD) - 'description' - 'due_date' - 'department_id' - 'project_id' - 'cost_item_id' - 'employee_id' - 'extra_dims') THEN
      RAISE EXCEPTION 'LINE_IMMUTABLE: dòng đã ghi sổ chỉ sửa được diễn giải và chiều phân tích; dùng Bỏ ghi sổ hoặc Đảo' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, after, ip)
      VALUES (OLD.tenant_id, app_user_id(), 'update', 'voucher_line', OLD.id::text, to_jsonb(OLD), to_jsonb(NEW), nullif(current_setting('app.client_ip', true), ''));
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_line_immutable BEFORE UPDATE OR DELETE ON voucher_line FOR EACH ROW EXECUTE FUNCTION fn_line_immutable();

-- ===== Cân bằng (constraint trigger, kiểm tra lúc COMMIT) =====
CREATE OR REPLACE FUNCTION fn_check_voucher_balance(p_voucher uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher; v_d numeric; v_c numeric; v_n int; v_cur record;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  IF NOT FOUND THEN RETURN; END IF;  -- chứng từ đã bị xóa trong cùng transaction
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) INTO v_d, v_c, v_n FROM voucher_line WHERE voucher_id = p_voucher;
  IF v_n = 0 AND v.state <> 'draft' THEN RAISE EXCEPTION 'VOUCHER_EMPTY: chứng từ % không có dòng', coalesce(v.voucher_no, v.id::text) USING ERRCODE = 'P0001'; END IF;
  IF v_d <> v_c THEN RAISE EXCEPTION 'VOUCHER_UNBALANCED: tổng Nợ % khác tổng Có %', v_d, v_c USING ERRCODE = 'P0001'; END IF;
  FOR v_cur IN SELECT currency_code, sum(amount_currency) AS s FROM voucher_line WHERE voucher_id = p_voucher AND currency_code <> 'VND' GROUP BY currency_code HAVING sum(amount_currency) <> 0 LOOP
    RAISE EXCEPTION 'VOUCHER_UNBALANCED_CURRENCY: nguyên tệ % lệch %', v_cur.currency_code, v_cur.s USING ERRCODE = 'P0001';
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION fn_trg_line_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM fn_check_voucher_balance(COALESCE(NEW.voucher_id, OLD.voucher_id)); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER trg_voucher_balanced AFTER INSERT OR UPDATE OR DELETE ON voucher_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_trg_line_balanced();
CREATE OR REPLACE FUNCTION fn_trg_voucher_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM fn_check_voucher_balance(NEW.id); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER trg_voucher_state_balanced AFTER UPDATE OF state ON voucher DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_trg_voucher_balanced();

-- ===== Cặp đối ứng =====
CREATE OR REPLACE FUNCTION fn_build_pairs(p_voucher uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher; nd int; nc int; total numeric; rem numeric;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_voucher;
  DELETE FROM voucher_pair WHERE voucher_id = p_voucher;
  SELECT count(*) FILTER (WHERE debit > 0), count(*) FILTER (WHERE credit > 0), coalesce(sum(debit),0) INTO nd, nc, total FROM voucher_line WHERE voucher_id = p_voucher;
  IF total = 0 THEN RETURN; END IF;
  IF nd = 1 OR nc = 1 THEN
    INSERT INTO voucher_pair(tenant_id, voucher_id, posting_date, debit_account_id, credit_account_id, debit_party_id, credit_party_id, amount, is_closing)
    SELECT v.tenant_id, p_voucher, v.posting_date, d.account_id, c.account_id, d.party_id, c.party_id, CASE WHEN nd = 1 THEN c.credit ELSE d.debit END, v.is_closing
    FROM voucher_line d JOIN voucher_line c ON c.voucher_id = d.voucher_id WHERE d.voucher_id = p_voucher AND d.debit > 0 AND c.credit > 0;
  ELSE
    INSERT INTO voucher_pair(tenant_id, voucher_id, posting_date, debit_account_id, credit_account_id, debit_party_id, credit_party_id, amount, is_closing)
    SELECT v.tenant_id, p_voucher, v.posting_date, d.account_id, c.account_id, d.party_id, c.party_id, floor(d.debit * c.credit / total), v.is_closing
    FROM voucher_line d JOIN voucher_line c ON c.voucher_id = d.voucher_id WHERE d.voucher_id = p_voucher AND d.debit > 0 AND c.credit > 0 AND floor(d.debit * c.credit / total) > 0;
    SELECT total - coalesce(sum(amount),0) INTO rem FROM voucher_pair WHERE voucher_id = p_voucher;
    IF rem > 0 THEN UPDATE voucher_pair SET amount = amount + rem WHERE id = (SELECT id FROM voucher_pair WHERE voucher_id = p_voucher ORDER BY amount DESC, id LIMIT 1); END IF;
  END IF;
END $$;

-- ===== Làm bẩn số dư =====
CREATE OR REPLACE FUNCTION mark_balance_stale(p_tenant uuid, p_year int, p_period int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO balance_stale(tenant_id, stale_year, stale_period) VALUES (p_tenant, p_year, p_period)
  ON CONFLICT (tenant_id) DO UPDATE
    SET stale_year = CASE WHEN (EXCLUDED.stale_year, EXCLUDED.stale_period) < (balance_stale.stale_year, balance_stale.stale_period) THEN EXCLUDED.stale_year ELSE balance_stale.stale_year END,
        stale_period = CASE WHEN (EXCLUDED.stale_year, EXCLUDED.stale_period) < (balance_stale.stale_year, balance_stale.stale_period) THEN EXCLUDED.stale_period ELSE balance_stale.stale_period END,
        marked_at = now();
END $$;

-- ===== Tài khoản đã dùng: không đổi mã/xóa =====
CREATE OR REPLACE FUNCTION fn_account_in_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM voucher_line WHERE account_id = OLD.id LIMIT 1) THEN
    RAISE EXCEPTION 'ACCOUNT_IN_USE: tài khoản % đã có phát sinh, không đổi số hiệu hoặc xóa được', OLD.code USING ERRCODE = 'P0001'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_account_in_use BEFORE UPDATE OF code, parent_id OR DELETE ON account FOR EACH ROW EXECUTE FUNCTION fn_account_in_use();
```

Thêm interface vào `packages/db/src/types.ts`: `VoucherTypeTable`, `VoucherTable` (các cột như SQL; `Numeric` cho tiền; `state: Generated<string>`; `fiscal_year/period_no: Generated<number>`; `version: Generated<number>`), `VoucherLineTable` (`balance: Generated<string>`), `VoucherCounterTable`, `VoucherLineHistoryTable`, `VoucherAttachmentTable`, `VoucherPairTable`, `BalanceStaleTable`; khóa `voucher_type, voucher, voucher_line, voucher_counter, voucher_line_history, voucher_attachment, voucher_pair, balance_stale` trong `Database`. `FiscalPeriodTable` thêm `locked_modules: Generated<string[]>`.

- [ ] **Step 4: Chạy test**

Run: `pnpm -F @kt/db test -- test/ledger-schema.test.ts test/rls.test.ts`
Expected: PASS 5 + 4 (test RLS cấu trúc vẫn xanh với các bảng mới).

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): lược đồ sổ cái với partition, trigger cân bằng, bất biến, tài khoản kiểm soát và cặp đối ứng"
```

---

### Task 15: Thủ tục `post_voucher`/`unpost_voucher`/`reverse_voucher`/`discard_voucher`, máy trạng thái, service và API chứng từ

**Files:**
- Create: `packages/db/migrations/0005_thu_tuc_chung_tu.sql`
- Create: `packages/domain/src/voucherState.ts`; Modify: `packages/domain/src/index.ts`
- Create: `apps/api/src/modules/ledger/vouchers.service.ts`, `apps/api/src/modules/ledger/vouchers.routes.ts`
- Modify: `apps/api/src/app.ts`
- Test: `packages/domain/test/voucherState.test.ts`, `apps/api/test/vouchers.test.ts`

**Interfaces:**
- Consumes: bảng và trigger Task 14; `QUEUES.recomputeBalances` (Task 12; job được gửi từ route sau mỗi thao tác đổi sổ cái, worker xử lý ở Task 20).
- Produces:
  - SQL: `post_voucher(p_id uuid) RETURNS void`; `unpost_voucher(p_id uuid) RETURNS void`; `reverse_voucher(p_id uuid, p_date date, p_description text) RETURNS uuid`; `discard_voucher(p_id uuid) RETURNS void`; `fn_format_voucher_no(p_prefix text, p_suffix text, p_pad int, p_seq bigint, p_year int) RETURNS text` (thay `{YY}`/`{YYYY}` trong prefix/suffix). Lỗi: `VOUCHER_NOT_FOUND`, `STATE_INVALID`, `UNPOST_PERIOD_NOT_OPEN`, `VOUCHER_HASHED`, `REVERSE_DATE_BEFORE_ORIGINAL`.
  - Domain: `type VoucherState = 'draft'|'posted'|'reversed'|'cancelled'`; `type VoucherAction = 'post'|'unpost'|'reverse'|'discard'`; `canTransition(state, action): boolean`; `decideEdit(input: { periodStatus: 'open'|'soft_locked'|'hard_locked'; hashed: boolean; change: 'meta'|'amount'|'delete'|'backdate'; canEditPosted: boolean; canBackdateLocked: boolean }): 'in_place'|'unpost_edit_post'|'reverse_and_new'|'adjust_in_open_period'|'discard'|'allowed'|'forbidden'` (bảng quyết định mục 7.1).
  - Service (mọi hàm nhận `trx: Transaction<Database>`): `createVoucher(trx, ctx: {tenantId; userId}, input: VoucherInput): Promise<VoucherDto>`; `updateDraft(trx, id, version, input): Promise<VoucherDto>`; `updatePostedMeta(trx, id, version, input: {description?; lines?: {lineNo; description?; departmentCode?; projectCode?; costItemCode?; employeeCode?}[]}): Promise<VoucherDto>`; `postVoucher(trx, id)`; `unpostVoucher(trx, id)`; `reverseVoucher(trx, id, input: {postingDate; description?}): Promise<VoucherDto>`; `discardVoucher(trx, id)`; `duplicateVoucher(trx, ctx, id, postingDate): Promise<VoucherDto>`; `getVoucher(trx, id): Promise<VoucherDto>`; `listVouchers(trx, f: {type?; from?; to?; state?; q?; page; size}): Promise<{rows: VoucherListRow[]; total}>`.
  - `VoucherInput = { voucherType: string; postingDate; documentDate; description?; partyCode?; currencyCode?: string; fxRate?: string; idempotencyKey?; lines: LineInput[] }`; `LineInput = { accountCode; debit?: string; credit?: string; amountCurrency?: string; fxRate?: string; partyCode?; departmentCode?; projectCode?; costItemCode?; employeeCode?; description?; dueDate?; extraDims?: Record<string, string> }`; `VoucherDto = { id; voucherType; voucherNo; seqNo; postingDate; documentDate; state; description; partyCode; partyName; currencyCode; fxRate; isClosing; reversalOfId; reversedById; sourceDocType; sourceDocId; version; createdBy; createdAt; postedBy; postedAt; totalDebit: string; lines: LineDto[] }`; `LineDto = LineInput & { lineNo; accountName; partyName }`.
  - Route: `GET /api/voucher-types`; `GET /api/vouchers`; `GET /api/vouchers/:id`; `POST /api/vouchers` (body `VoucherInput & { autoPost?: boolean }`); `PUT /api/vouchers/:id` (body `VoucherInput & { version }` cho draft, hoặc `{ version, description, lines: meta }` cho posted); `POST /api/vouchers/:id/post|unpost|discard`; `POST /api/vouchers/:id/reverse { postingDate, description? }`; `POST /api/vouchers/:id/duplicate { postingDate }`; `DELETE /api/vouchers/:id` (draft chưa số). Quyền: `voucher.view/create/update/delete/post/unpost`; `unpost` còn cần `voucher.edit_posted`; ghi vào kỳ `soft_locked` cần `voucher.backdate_locked` (route đặt `app.override_soft_lock = on` trong transaction).

- [ ] **Step 1: Viết test domain máy trạng thái (thất bại)**

`packages/domain/test/voucherState.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canTransition, decideEdit } from '../src/voucherState.js';

describe('máy trạng thái chứng từ', () => {
  it('chuyển trạng thái hợp lệ theo mục 7.1', () => {
    expect(canTransition('draft', 'post')).toBe(true); expect(canTransition('posted', 'unpost')).toBe(true);
    expect(canTransition('posted', 'reverse')).toBe(true); expect(canTransition('draft', 'discard')).toBe(true);
    expect(canTransition('reversed', 'unpost')).toBe(false); expect(canTransition('cancelled', 'post')).toBe(false);
    expect(canTransition('draft', 'reverse')).toBe(false); expect(canTransition('posted', 'discard')).toBe(false);
  });
  it('bảng quyết định sửa chứng từ đã ghi sổ', () => {
    const base = { hashed: false, canEditPosted: true, canBackdateLocked: false };
    expect(decideEdit({ ...base, periodStatus: 'open', change: 'meta' })).toBe('in_place');
    expect(decideEdit({ ...base, periodStatus: 'soft_locked', change: 'meta' })).toBe('in_place');
    expect(decideEdit({ ...base, periodStatus: 'hard_locked', change: 'meta' })).toBe('forbidden');
    expect(decideEdit({ ...base, periodStatus: 'open', change: 'amount' })).toBe('unpost_edit_post');
    expect(decideEdit({ ...base, periodStatus: 'open', change: 'amount', canEditPosted: false })).toBe('forbidden');
    expect(decideEdit({ ...base, periodStatus: 'soft_locked', change: 'amount' })).toBe('reverse_and_new');
    expect(decideEdit({ ...base, periodStatus: 'hard_locked', change: 'amount' })).toBe('adjust_in_open_period');
    expect(decideEdit({ ...base, periodStatus: 'open', change: 'amount', hashed: true })).toBe('adjust_in_open_period');
    expect(decideEdit({ ...base, periodStatus: 'open', change: 'delete' })).toBe('discard');
    expect(decideEdit({ ...base, periodStatus: 'soft_locked', change: 'delete' })).toBe('reverse_and_new');
    expect(decideEdit({ ...base, periodStatus: 'hard_locked', change: 'delete' })).toBe('forbidden');
    expect(decideEdit({ ...base, periodStatus: 'open', change: 'backdate' })).toBe('allowed');
    expect(decideEdit({ ...base, periodStatus: 'soft_locked', change: 'backdate' })).toBe('forbidden');
    expect(decideEdit({ ...base, periodStatus: 'soft_locked', change: 'backdate', canBackdateLocked: true })).toBe('allowed');
    expect(decideEdit({ ...base, periodStatus: 'hard_locked', change: 'backdate', canBackdateLocked: true })).toBe('forbidden');
  });
});
```

- [ ] **Step 2: Viết `voucherState.ts`, chạy test**

```ts
export type VoucherState = 'draft' | 'posted' | 'reversed' | 'cancelled';
export type VoucherAction = 'post' | 'unpost' | 'reverse' | 'discard';
const TRANSITIONS: Record<VoucherState, Partial<Record<VoucherAction, VoucherState>>> = {
  draft: { post: 'posted', discard: 'cancelled' },
  posted: { unpost: 'draft', reverse: 'reversed' },
  reversed: {}, cancelled: {},
};
export const canTransition = (state: VoucherState, action: VoucherAction): boolean => TRANSITIONS[state][action] !== undefined;
export const nextState = (state: VoucherState, action: VoucherAction): VoucherState | null => TRANSITIONS[state][action] ?? null;

export type EditDecision = 'in_place' | 'unpost_edit_post' | 'reverse_and_new' | 'adjust_in_open_period' | 'discard' | 'allowed' | 'forbidden';
export function decideEdit(i: { periodStatus: 'open' | 'soft_locked' | 'hard_locked'; hashed: boolean; change: 'meta' | 'amount' | 'delete' | 'backdate'; canEditPosted: boolean; canBackdateLocked: boolean }): EditDecision {
  const locked = i.periodStatus === 'hard_locked' || i.hashed;
  switch (i.change) {
    case 'meta': return locked ? 'forbidden' : 'in_place';
    case 'amount':
      if (locked) return 'adjust_in_open_period';
      if (i.periodStatus === 'soft_locked') return 'reverse_and_new';
      return i.canEditPosted ? 'unpost_edit_post' : 'forbidden';
    case 'delete':
      if (locked) return 'forbidden';
      return i.periodStatus === 'soft_locked' ? 'reverse_and_new' : 'discard';
    case 'backdate':
      if (locked) return 'forbidden';
      return i.periodStatus === 'open' || i.canBackdateLocked ? 'allowed' : 'forbidden';
  }
}
```

Run: `pnpm -F @kt/domain test -- test/voucherState.test.ts` → PASS.

- [ ] **Step 3: Viết test API chứng từ (thất bại)**

`apps/api/test/vouchers.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `VC${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code: 'KH001', name: 'Khách A', is_customer: true } });
});
afterAll(async () => { await ctx.close(); });

const pkt = (date: string, lines: object[], extra: object = {}) => ({ voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Phiếu kế toán thử', lines, ...extra });
const L = (accountCode: string, debit = '0', credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
const post = (id: string) => ctx.app.inject({ method: 'POST', url: `/api/vouchers/${id}/post`, headers: { cookie } });
const create = (body: object) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: body });

describe('chứng từ', () => {
  it('tạo nháp, ghi sổ cấp số PKT00001, lần sau PKT00002', async () => {
    const a = await create(pkt('2026-01-05', [L('1111', '1000000'), L('5113', '0', '1000000')]));
    expect(a.statusCode, a.body).toBe(201); expect(a.json()).toMatchObject({ state: 'draft', voucherNo: null, totalDebit: '1000000' });
    const p = await post(a.json().id); expect(p.json()).toMatchObject({ state: 'posted', voucherNo: 'PKT00001', seqNo: '1' });
    const b = await create(pkt('2026-01-06', [L('1111', '2000'), L('5113', '0', '2000')], { autoPost: true }));
    expect(b.json()).toMatchObject({ state: 'posted', voucherNo: 'PKT00002' });
  });

  it('chứng từ lệch, thiếu đối tượng, tài khoản tổng hợp bị từ chối với mã lỗi rõ', async () => {
    expect((await create(pkt('2026-01-05', [L('1111', '100'), L('5113', '0', '90')]))).json().error.code).toBe('VOUCHER_UNBALANCED');
    expect((await create(pkt('2026-01-05', [L('131', '100'), L('5113', '0', '100')]))).json().error.code).toBe('LINE_PARTY_REQUIRED');
    expect((await create(pkt('2026-01-05', [L('111', '100'), L('5113', '0', '100')]))).json().error.code).toBe('ACCOUNT_IS_GROUP');
    const ok = await create(pkt('2026-01-05', [L('131', '100', '0', { partyCode: 'KH001' }), L('5113', '0', '100')]));
    expect(ok.statusCode).toBe(201); expect(ok.json().lines[0]).toMatchObject({ partyCode: 'KH001', partyName: 'Khách A' });
  });

  it('sửa chứng từ đã ghi sổ: diễn giải và chiều phân tích tại chỗ; số tiền phải bỏ ghi sổ', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/catalogs/department', headers: { cookie }, payload: { code: 'KD', name: 'Kinh doanh' } });
    const v = (await create(pkt('2026-02-01', [L('6421', '500'), L('1111', '0', '500')], { autoPost: true }))).json();
    const meta = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${v.id}`, headers: { cookie }, payload: { version: v.version, description: 'Đã sửa diễn giải', lines: [{ lineNo: 1, departmentCode: 'KD' }] } });
    expect(meta.statusCode, meta.body).toBe(200); expect(meta.json()).toMatchObject({ description: 'Đã sửa diễn giải', state: 'posted' });
    expect(meta.json().lines[0].departmentCode).toBe('KD');
    const amt = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${v.id}`, headers: { cookie }, payload: { ...pkt('2026-02-01', [L('6421', '600'), L('1111', '0', '600')]), version: meta.json().version } });
    expect(amt.json().error.code).toBe('VOUCHER_POSTED_EDIT');
    const stale = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${v.id}`, headers: { cookie }, payload: { version: 1, description: 'cũ' } });
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
  });

  it('bỏ ghi sổ giữ số, lưu lịch sử dòng; sửa rồi ghi sổ lại', async () => {
    const v = (await create(pkt('2026-02-02', [L('6421', '700'), L('1111', '0', '700')], { autoPost: true }))).json();
    const u = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/unpost`, headers: { cookie } });
    expect(u.json()).toMatchObject({ state: 'draft', voucherNo: v.voucherNo });
    const h = await sql<{ n: string }>`SELECT count(*) AS n FROM voucher_line_history WHERE voucher_id = ${v.id}::uuid`.execute(ctx.t.admin);
    expect(h.rows[0]!.n).toBe('1');
    const e = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${v.id}`, headers: { cookie }, payload: { ...pkt('2026-02-02', [L('6421', '750'), L('1111', '0', '750')]), version: u.json().version } });
    expect(e.statusCode, e.body).toBe(200);
    const p = await post(v.id); expect(p.json()).toMatchObject({ state: 'posted', voucherNo: v.voucherNo, totalDebit: '750' });
  });

  it('đảo chứng từ tạo chứng từ mới đã ghi sổ với dòng đảo chiều; gốc thành reversed và không bỏ ghi sổ được nữa', async () => {
    const v = (await create(pkt('2026-03-01', [L('6422', '300'), L('1111', '0', '300')], { autoPost: true }))).json();
    const r = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/reverse`, headers: { cookie }, payload: { postingDate: '2026-03-15' } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ state: 'posted', reversalOfId: v.id, postingDate: '2026-03-15' });
    expect(r.json().lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit])).toEqual([['6422', '0', '300'], ['1111', '300', '0']]);
    const g = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${v.id}`, headers: { cookie } });
    expect(g.json()).toMatchObject({ state: 'reversed', reversedById: r.json().id });
    expect((await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/unpost`, headers: { cookie } })).json().error.code).toBe('STATE_INVALID');
    expect((await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/reverse`, headers: { cookie }, payload: { postingDate: '2026-02-01' } })).json().error.code).toBe('STATE_INVALID');
  });

  it('hủy chứng từ nháp đã có số giữ số; xóa nháp chưa số được; không có đường sửa trực tiếp qua SQL', async () => {
    const v = (await create(pkt('2026-03-02', [L('6422', '10'), L('1111', '0', '10')], { autoPost: true }))).json();
    await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/unpost`, headers: { cookie } });
    const d = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/discard`, headers: { cookie } });
    expect(d.json()).toMatchObject({ state: 'cancelled', voucherNo: v.voucherNo });
    const draft = (await create(pkt('2026-03-03', [L('6422', '10'), L('1111', '0', '10')]))).json();
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/vouchers/${draft.id}`, headers: { cookie } })).statusCode).toBe(204);
    const posted = (await create(pkt('2026-03-04', [L('6422', '20'), L('1111', '0', '20')], { autoPost: true }))).json();
    await expect(ctx.t.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${tenantId}, true)`.execute(trx);
      await sql`UPDATE voucher_line SET debit = 999 WHERE voucher_id = ${posted.id}::uuid AND debit > 0`.execute(trx);
    })).rejects.toThrow(/LINE_IMMUTABLE/);
    await expect(ctx.t.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${tenantId}, true)`.execute(trx);
      await sql`DELETE FROM voucher_line WHERE voucher_id = ${posted.id}::uuid`.execute(trx);
    })).rejects.toThrow(/LINE_IMMUTABLE/);
  });

  it('idempotency_key: gửi 5 lần song song chỉ tạo một chứng từ', async () => {
    const key = `key-${Date.now()}`;
    const rs = await Promise.all(Array.from({ length: 5 }, () => create(pkt('2026-04-01', [L('6422', '1'), L('1111', '0', '1')], { idempotencyKey: key, autoPost: true }))));
    const ids = new Set(rs.map((r) => r.json().id));
    expect(ids.size).toBe(1);
    const n = await sql<{ n: string }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND idempotency_key = ${key}`.execute(ctx.t.admin);
    expect(n.rows[0]!.n).toBe('1');
  });

  it('nhân bản tạo nháp mới cùng dòng, ngày mới; danh sách lọc theo loại/khoảng ngày/trạng thái', async () => {
    const v = (await create(pkt('2026-04-02', [L('6422', '40'), L('1111', '0', '40')], { autoPost: true }))).json();
    const d = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/duplicate`, headers: { cookie }, payload: { postingDate: '2026-04-20' } });
    expect(d.json()).toMatchObject({ state: 'draft', voucherNo: null, postingDate: '2026-04-20', totalDebit: '40' });
    const list = await ctx.app.inject({ method: 'GET', url: '/api/vouchers?type=PKT&from=2026-04-01&to=2026-04-30&state=posted', headers: { cookie } });
    expect(list.json().rows.every((r: { state: string }) => r.state === 'posted')).toBe(true);
    expect(list.json().total).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 4: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/api test -- test/vouchers.test.ts` → FAIL 404.

- [ ] **Step 5: Migration thủ tục**

`packages/db/migrations/0005_thu_tuc_chung_tu.sql`:

```sql
CREATE OR REPLACE FUNCTION fn_format_voucher_no(p_prefix text, p_suffix text, p_pad int, p_seq bigint, p_year int) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(replace(p_prefix, '{YYYY}', p_year::text), '{YY}', right(p_year::text, 2)) || lpad(p_seq::text, p_pad, '0')
      || replace(replace(p_suffix, '{YYYY}', p_year::text), '{YY}', right(p_year::text, 2));
$$;

CREATE OR REPLACE FUNCTION fn_audit_voucher(p_tenant uuid, p_action text, p_id uuid, p_after jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, after, ip)
  VALUES (p_tenant, app_user_id(), p_action, 'voucher', p_id::text, p_after, nullif(current_setting('app.client_ip', true), ''));
$$;

CREATE OR REPLACE FUNCTION post_voucher(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher; vt voucher_type; p fiscal_period; v_seq bigint; v_no text; v_n int;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'draft' THEN RAISE EXCEPTION 'STATE_INVALID: chứng từ đang ở trạng thái %, không ghi sổ được', v.state USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_n FROM voucher_line WHERE voucher_id = p_id;
  IF v_n = 0 THEN RAISE EXCEPTION 'VOUCHER_EMPTY: chứng từ không có dòng' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO vt FROM voucher_type WHERE tenant_id = v.tenant_id AND code = v.voucher_type;
  p := fn_period_of(v.tenant_id, v.posting_date, v.voucher_type = 'DK');
  PERFORM fn_assert_period_writable(p, vt.module);
  IF v.voucher_no IS NULL THEN
    INSERT INTO voucher_counter(tenant_id, voucher_type, fiscal_year, last_no) VALUES (v.tenant_id, v.voucher_type, p.fiscal_year, 1)
      ON CONFLICT (tenant_id, voucher_type, fiscal_year) DO UPDATE SET last_no = voucher_counter.last_no + 1 RETURNING last_no INTO v_seq;
    v_no := fn_format_voucher_no(vt.prefix, vt.suffix, vt.pad_length, v_seq, p.fiscal_year);
  END IF;
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'posted', voucher_no = coalesce(voucher_no, v_no), seq_no = coalesce(seq_no, v_seq), posted_by = app_user_id(), posted_at = now() WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_build_pairs(p_id);
  PERFORM mark_balance_stale(v.tenant_id, p.fiscal_year, p.period_no);
  PERFORM fn_audit_voucher(v.tenant_id, 'post', p_id, jsonb_build_object('voucher_no', coalesce(v.voucher_no, v_no), 'posting_date', v.posting_date));
END $$;

CREATE OR REPLACE FUNCTION unpost_voucher(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher; p fiscal_period;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'posted' THEN RAISE EXCEPTION 'STATE_INVALID: chỉ bỏ ghi sổ được chứng từ đang ghi sổ (hiện tại: %)', v.state USING ERRCODE = 'P0001'; END IF;
  IF v.row_hash IS NOT NULL THEN RAISE EXCEPTION 'VOUCHER_HASHED: chứng từ đã nằm trong chuỗi khóa cứng' USING ERRCODE = 'P0001'; END IF;
  p := fn_period_of(v.tenant_id, v.posting_date, v.voucher_type = 'DK');
  IF p.status <> 'open' THEN RAISE EXCEPTION 'UNPOST_PERIOD_NOT_OPEN: kỳ %/% đã khóa, hãy lập chứng từ đảo', p.period_no, p.fiscal_year USING ERRCODE = 'P0001'; END IF;
  INSERT INTO voucher_line_history(tenant_id, voucher_id, version, header, lines, archived_by)
    SELECT v.tenant_id, p_id, v.version, to_jsonb(v), coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.line_no), '[]'), app_user_id() FROM voucher_line l WHERE l.voucher_id = p_id;
  PERFORM set_config('app.state_change', 'on', true); PERFORM set_config('app.unposting', 'on', true);
  UPDATE voucher SET state = 'draft', posted_by = NULL, posted_at = NULL WHERE id = p_id;
  DELETE FROM voucher_pair WHERE voucher_id = p_id;
  PERFORM set_config('app.state_change', 'off', true); PERFORM set_config('app.unposting', 'off', true);
  PERFORM mark_balance_stale(v.tenant_id, p.fiscal_year, p.period_no);
  PERFORM fn_audit_voucher(v.tenant_id, 'unpost', p_id, jsonb_build_object('voucher_no', v.voucher_no));
END $$;

CREATE OR REPLACE FUNCTION reverse_voucher(p_id uuid, p_date date, p_description text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v voucher; v_new uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'posted' THEN RAISE EXCEPTION 'STATE_INVALID: chỉ đảo được chứng từ đang ghi sổ (hiện tại: %)', v.state USING ERRCODE = 'P0001'; END IF;
  IF p_date < v.posting_date THEN RAISE EXCEPTION 'REVERSE_DATE_BEFORE_ORIGINAL: ngày đảo % trước ngày chứng từ gốc %', p_date, v.posting_date USING ERRCODE = 'P0001'; END IF;
  INSERT INTO voucher(id, tenant_id, voucher_type, posting_date, document_date, description, party_id, currency_code, fx_rate, source_doc_type, source_doc_id, reversal_of_id, is_closing, created_by)
  VALUES (v_new, v.tenant_id, v.voucher_type, p_date, p_date, coalesce(p_description, 'Đảo chứng từ ' || v.voucher_no || ' ngày ' || to_char(v.posting_date, 'DD/MM/YYYY')),
          v.party_id, v.currency_code, v.fx_rate, v.source_doc_type, v.source_doc_id, p_id, v.is_closing, app_user_id());
  INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, currency_code, fx_rate, amount_currency, debit, credit,
                           party_id, item_id, warehouse_id, department_id, project_id, cost_item_id, contract_id, employee_id, asset_id, extra_dims, description, due_date)
  SELECT tenant_id, v_new, line_no, account_id, p_date, currency_code, fx_rate, -amount_currency, credit, debit,
         party_id, item_id, warehouse_id, department_id, project_id, cost_item_id, contract_id, employee_id, asset_id, extra_dims, description, due_date
  FROM voucher_line WHERE voucher_id = p_id ORDER BY line_no;
  PERFORM post_voucher(v_new);
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'reversed', reversed_by_id = v_new WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_audit_voucher(v.tenant_id, 'reverse', p_id, jsonb_build_object('reversed_by', v_new, 'date', p_date));
  RETURN v_new;
END $$;

CREATE OR REPLACE FUNCTION discard_voucher(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v voucher;
BEGIN
  SELECT * INTO v FROM voucher WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_NOT_FOUND: %', p_id USING ERRCODE = 'P0001'; END IF;
  IF v.state <> 'draft' THEN RAISE EXCEPTION 'STATE_INVALID: chỉ hủy được chứng từ nháp (hiện tại: %)', v.state USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('app.state_change', 'on', true);
  UPDATE voucher SET state = 'cancelled' WHERE id = p_id;
  PERFORM set_config('app.state_change', 'off', true);
  PERFORM fn_audit_voucher(v.tenant_id, 'discard', p_id, jsonb_build_object('voucher_no', v.voucher_no));
END $$;
```

- [ ] **Step 6: Service**

`apps/api/src/modules/ledger/vouchers.service.ts`:

```ts
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, sum } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

const money = z.string().regex(/^-?\d+(\.\d{1,4})?$/);
const dateIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const lineInput = z.object({
  accountCode: z.string().min(1), debit: money.default('0'), credit: money.default('0'), amountCurrency: money.optional(), fxRate: money.optional(),
  partyCode: z.string().nullable().optional(), departmentCode: z.string().nullable().optional(), projectCode: z.string().nullable().optional(),
  costItemCode: z.string().nullable().optional(), employeeCode: z.string().nullable().optional(), description: z.string().nullable().optional(),
  dueDate: dateIso.nullable().optional(), extraDims: z.record(z.string()).optional(),
});
export const voucherInput = z.object({
  voucherType: z.string().min(1), postingDate: dateIso, documentDate: dateIso, description: z.string().nullable().optional(),
  partyCode: z.string().nullable().optional(), currencyCode: z.string().length(3).default('VND'), fxRate: money.optional(), idempotencyKey: z.string().max(100).optional(),
  lines: z.array(lineInput).min(1),
});
export const metaInput = z.object({ version: z.number().int(), description: z.string().nullable().optional(),
  lines: z.array(lineInput.pick({ departmentCode: true, projectCode: true, costItemCode: true, employeeCode: true, description: true, dueDate: true }).extend({ lineNo: z.number().int() })).optional() });
export type VoucherInput = z.infer<typeof voucherInput>;
export type LineInput = z.infer<typeof lineInput>;

export interface LineDto extends LineInput { lineNo: number; accountName: string; partyName: string | null }
export interface VoucherDto {
  id: string; voucherType: string; voucherNo: string | null; seqNo: string | null; postingDate: string; documentDate: string; state: string; description: string | null;
  partyCode: string | null; partyName: string | null; currencyCode: string; fxRate: string | null; isClosing: boolean; reversalOfId: string | null; reversedById: string | null;
  sourceDocType: string | null; sourceDocId: string | null; version: number; createdBy: string; createdAt: string; postedBy: string | null; postedAt: string | null; totalDebit: string; lines: LineDto[];
}

type Trx = Transaction<Database>;
async function codeToId<T extends 'account' | 'party' | 'department' | 'project' | 'cost_item' | 'employee'>(trx: Trx, table: T, code: string | null | undefined, label: string) {
  if (!code) return null;
  const r = await trx.selectFrom(table).select('id').where('code', '=', code).executeTakeFirst() as { id: number | string } | undefined;
  if (!r) throw new AppError('LOOKUP_NOT_FOUND', `Không có ${label} mã "${code}"`, 409);
  return r.id;
}
async function resolveLine(trx: Trx, l: LineInput, currency: string) {
  const accountId = (await codeToId(trx, 'account', l.accountCode, 'tài khoản')) as number;
  const debit = D(l.debit); const credit = D(l.credit);
  if (debit.gt(0) && credit.gt(0)) throw new AppError('LINE_BOTH_SIDES', `Dòng ${l.accountCode}: chỉ được một bên Nợ hoặc Có`, 400);
  return {
    account_id: accountId, currency_code: currency, fx_rate: l.fxRate ?? null,
    amount_currency: currency === 'VND' ? debit.minus(credit).toString() : (l.amountCurrency ?? debit.minus(credit).toString()),
    debit: debit.toString(), credit: credit.toString(),
    party_id: (await codeToId(trx, 'party', l.partyCode, 'đối tượng')) as string | null,
    department_id: (await codeToId(trx, 'department', l.departmentCode, 'bộ phận')) as number | null,
    project_id: (await codeToId(trx, 'project', l.projectCode, 'vụ việc')) as number | null,
    cost_item_id: (await codeToId(trx, 'cost_item', l.costItemCode, 'khoản mục chi phí')) as number | null,
    employee_id: (await codeToId(trx, 'employee', l.employeeCode, 'nhân viên')) as number | null,
    extra_dims: JSON.stringify(l.extraDims ?? {}), description: l.description ?? null, due_date: l.dueDate ?? null,
  };
}

export async function getVoucher(trx: Trx, id: string): Promise<VoucherDto> {
  const v = await trx.selectFrom('voucher as v').leftJoin('party as p', 'p.id', 'v.party_id').selectAll('v').select(['p.code as party_code', 'p.name as party_name']).where('v.id', '=', id).executeTakeFirst();
  if (!v) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ', 404);
  const lines = await trx.selectFrom('voucher_line as l').innerJoin('account as a', 'a.id', 'l.account_id')
    .leftJoin('party as p', 'p.id', 'l.party_id').leftJoin('department as d', 'd.id', 'l.department_id').leftJoin('project as pr', 'pr.id', 'l.project_id')
    .leftJoin('cost_item as ci', 'ci.id', 'l.cost_item_id').leftJoin('employee as e', 'e.id', 'l.employee_id')
    .select(['l.line_no', 'a.code as account_code', 'a.name as account_name', 'l.debit', 'l.credit', 'l.amount_currency', 'l.fx_rate', 'p.code as party_code', 'p.name as party_name',
      'd.code as department_code', 'pr.code as project_code', 'ci.code as cost_item_code', 'e.code as employee_code', 'l.description', 'l.due_date', 'l.extra_dims'])
    .where('l.voucher_id', '=', id).orderBy('l.line_no').execute();
  return {
    id: v.id, voucherType: v.voucher_type, voucherNo: v.voucher_no, seqNo: v.seq_no, postingDate: v.posting_date, documentDate: v.document_date, state: v.state, description: v.description,
    partyCode: v.party_code, partyName: v.party_name, currencyCode: v.currency_code, fxRate: v.fx_rate, isClosing: v.is_closing, reversalOfId: v.reversal_of_id, reversedById: v.reversed_by_id,
    sourceDocType: v.source_doc_type, sourceDocId: v.source_doc_id, version: v.version, createdBy: v.created_by, createdAt: v.created_at, postedBy: v.posted_by, postedAt: v.posted_at,
    totalDebit: sum(lines.map((l) => l.debit)).toString(),
    lines: lines.map((l) => ({ lineNo: l.line_no, accountCode: l.account_code, accountName: l.account_name, debit: l.debit, credit: l.credit, amountCurrency: l.amount_currency, fxRate: l.fx_rate ?? undefined,
      partyCode: l.party_code, partyName: l.party_name, departmentCode: l.department_code, projectCode: l.project_code, costItemCode: l.cost_item_code, employeeCode: l.employee_code,
      description: l.description, dueDate: l.due_date, extraDims: l.extra_dims as Record<string, string> })),
  };
}

async function insertLines(trx: Trx, tenantId: string, voucherId: string, postingDate: string, currency: string, lines: LineInput[]) {
  let n = 0;
  for (const l of lines) await trx.insertInto('voucher_line').values({ tenant_id: tenantId, voucher_id: voucherId, line_no: ++n, posting_date: postingDate, ...(await resolveLine(trx, l, currency)) }).execute();
}

export async function createVoucher(trx: Trx, ctx: { tenantId: string; userId: string }, input: VoucherInput): Promise<VoucherDto> {
  if (input.idempotencyKey) {
    const existing = await trx.selectFrom('voucher').select('id').where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
    if (existing) return getVoucher(trx, existing.id);
  }
  const partyId = (await codeToId(trx, 'party', input.partyCode, 'đối tượng')) as string | null;
  const v = await trx.insertInto('voucher').values({
    tenant_id: ctx.tenantId, voucher_type: input.voucherType, posting_date: input.postingDate, document_date: input.documentDate, description: input.description ?? null,
    party_id: partyId, currency_code: input.currencyCode, fx_rate: input.fxRate ?? null, idempotency_key: input.idempotencyKey ?? null, created_by: ctx.userId,
  }).onConflict((oc) => oc.columns(['tenant_id', 'idempotency_key']).doNothing()).returning('id').executeTakeFirst();
  if (!v) { // thua cuộc đua idempotency
    const existing = await trx.selectFrom('voucher').select('id').where('idempotency_key', '=', input.idempotencyKey!).executeTakeFirstOrThrow();
    return getVoucher(trx, existing.id);
  }
  await insertLines(trx, ctx.tenantId, v.id, input.postingDate, input.currencyCode, input.lines);
  return getVoucher(trx, v.id);
}

async function lockAndCheckVersion(trx: Trx, id: string, version: number) {
  const v = await trx.selectFrom('voucher').select(['id', 'version', 'state', 'tenant_id', 'voucher_no']).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!v) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ', 404);
  if (v.version !== version) throw new AppError('VERSION_CONFLICT', 'Chứng từ đã được người khác sửa, hãy tải lại', 409);
  return v;
}

export async function updateDraft(trx: Trx, id: string, version: number, input: VoucherInput): Promise<VoucherDto> {
  const v = await lockAndCheckVersion(trx, id, version);
  if (v.state !== 'draft') throw new AppError('VOUCHER_POSTED_EDIT', 'Chứng từ đã ghi sổ: chỉ sửa được diễn giải/chiều phân tích, hoặc Bỏ ghi sổ trước', 409);
  const partyId = (await codeToId(trx, 'party', input.partyCode, 'đối tượng')) as string | null;
  await trx.deleteFrom('voucher_line').where('voucher_id', '=', id).execute();
  await trx.updateTable('voucher').set({ voucher_type: input.voucherType, posting_date: input.postingDate, document_date: input.documentDate, description: input.description ?? null,
    party_id: partyId, currency_code: input.currencyCode, fx_rate: input.fxRate ?? null }).where('id', '=', id).execute();
  await insertLines(trx, v.tenant_id, id, input.postingDate, input.currencyCode, input.lines);
  return getVoucher(trx, id);
}

export async function updatePostedMeta(trx: Trx, id: string, input: z.infer<typeof metaInput>): Promise<VoucherDto> {
  await lockAndCheckVersion(trx, id, input.version);
  if (input.description !== undefined) await trx.updateTable('voucher').set({ description: input.description }).where('id', '=', id).execute();
  for (const l of input.lines ?? []) {
    const set: Record<string, unknown> = {};
    if (l.description !== undefined) set['description'] = l.description;
    if (l.dueDate !== undefined) set['due_date'] = l.dueDate;
    if (l.departmentCode !== undefined) set['department_id'] = await codeToId(trx, 'department', l.departmentCode, 'bộ phận');
    if (l.projectCode !== undefined) set['project_id'] = await codeToId(trx, 'project', l.projectCode, 'vụ việc');
    if (l.costItemCode !== undefined) set['cost_item_id'] = await codeToId(trx, 'cost_item', l.costItemCode, 'khoản mục chi phí');
    if (l.employeeCode !== undefined) set['employee_id'] = await codeToId(trx, 'employee', l.employeeCode, 'nhân viên');
    if (Object.keys(set).length) await trx.updateTable('voucher_line').set(set as never).where('voucher_id', '=', id).where('line_no', '=', l.lineNo).execute();
  }
  if (input.description === undefined && !input.lines?.length) return getVoucher(trx, id);
  await trx.updateTable('voucher').set({ description: sql`description` }).where('id', '=', id).execute(); // tăng version qua trigger
  return getVoucher(trx, id);
}

export const postVoucher = async (trx: Trx, id: string) => { await sql`SELECT post_voucher(${id}::uuid)`.execute(trx); return getVoucher(trx, id); };
export const unpostVoucher = async (trx: Trx, id: string) => { await sql`SELECT unpost_voucher(${id}::uuid)`.execute(trx); return getVoucher(trx, id); };
export const discardVoucher = async (trx: Trx, id: string) => { await sql`SELECT discard_voucher(${id}::uuid)`.execute(trx); return getVoucher(trx, id); };
export async function reverseVoucher(trx: Trx, id: string, input: { postingDate: string; description?: string | undefined }) {
  const r = await sql<{ id: string }>`SELECT reverse_voucher(${id}::uuid, ${input.postingDate}::date, ${input.description ?? null}) AS id`.execute(trx);
  return getVoucher(trx, r.rows[0]!.id);
}
export async function duplicateVoucher(trx: Trx, ctx: { tenantId: string; userId: string }, id: string, postingDate: string) {
  const src = await getVoucher(trx, id);
  return createVoucher(trx, ctx, { voucherType: src.voucherType, postingDate, documentDate: postingDate, description: src.description, partyCode: src.partyCode, currencyCode: src.currencyCode,
    fxRate: src.fxRate ?? undefined, lines: src.lines.map(({ lineNo: _n, accountName: _a, partyName: _p, ...l }) => ({ ...l, fxRate: l.fxRate ?? undefined })) });
}
export async function deleteDraft(trx: Trx, id: string) {
  await trx.deleteFrom('voucher_line').where('voucher_id', '=', id).execute();
  await trx.deleteFrom('voucher').where('id', '=', id).execute();
}
export async function listVouchers(trx: Trx, f: { type?: string; from?: string; to?: string; state?: string; q?: string; page: number; size: number }) {
  let q = trx.selectFrom('voucher as v').leftJoin('party as p', 'p.id', 'v.party_id');
  if (f.type) q = q.where('v.voucher_type', '=', f.type);
  if (f.from) q = q.where('v.posting_date', '>=', f.from);
  if (f.to) q = q.where('v.posting_date', '<=', f.to);
  if (f.state) q = q.where('v.state', '=', f.state);
  if (f.q) q = q.where((eb) => eb.or([eb('v.voucher_no', 'ilike', `%${f.q}%`), eb('v.description', 'ilike', `%${f.q}%`), eb('p.name', 'ilike', `%${f.q}%`)]));
  const total = Number((await q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow()).n);
  const rows = await q.select(['v.id', 'v.voucher_type as voucherType', 'v.voucher_no as voucherNo', 'v.posting_date as postingDate', 'v.state', 'v.description', 'p.name as partyName',
      sql<string>`(SELECT coalesce(sum(debit),0) FROM voucher_line l WHERE l.voucher_id = v.id)`.as('totalDebit')])
    .orderBy('v.posting_date', 'desc').orderBy('v.seq_no', 'desc').orderBy('v.created_at', 'desc').limit(f.size).offset((f.page - 1) * f.size).execute();
  return { rows, total };
}
```

- [ ] **Step 7: Route**

`apps/api/src/modules/ledger/vouchers.routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { QUEUES } from '@kt/db';
import * as S from './vouchers.service.js';
import { AppError } from '../../plugins/errors.js';

const idParam = z.object({ id: z.string().uuid() });

const routes: FastifyPluginAsyncZod = async (app) => {
  const ctx = (req: { auth: { tenantId: string | null; userId: string } | null }) => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId });
  const notify = (tenantId: string) => app.boss?.send(QUEUES.recomputeBalances, { tenantId }, { singletonKey: tenantId, singletonSeconds: 5 }).catch((e) => app.log.error(e));
  // Ghi vào kỳ khóa mềm chỉ khi có quyền; biến phiên được đặt trong transaction.
  const withOverride = <T>(req: Parameters<typeof app.withTenant>[0], fn: Parameters<typeof app.withTenant<T>>[1]) => app.withTenant<T>(req, async (trx) => {
    if (req.auth!.permissions.has('voucher.backdate_locked')) await sql`SELECT set_config('app.override_soft_lock', 'on', true)`.execute(trx);
    return fn(trx);
  });

  app.get('/api/voucher-types', { preHandler: app.requireAuth }, async (req) => app.withTenant(req, (trx) => trx.selectFrom('voucher_type').selectAll().where('is_active', '=', true).orderBy('code').execute()));

  app.get('/api/vouchers', { preHandler: app.requirePermission('voucher.view'), schema: { querystring: z.object({ type: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
      state: z.enum(['draft', 'posted', 'reversed', 'cancelled']).optional(), q: z.string().optional(), page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(500).default(50) }) } },
    async (req) => app.withTenant(req, (trx) => S.listVouchers(trx, req.query)));
  app.get('/api/vouchers/:id', { preHandler: app.requirePermission('voucher.view'), schema: { params: idParam } }, async (req) => app.withTenant(req, (trx) => S.getVoucher(trx, req.params.id)));

  app.post('/api/vouchers', { preHandler: app.requirePermission('voucher.create'), schema: { body: S.voucherInput.extend({ autoPost: z.boolean().optional() }) } }, async (req, reply) => {
    if (req.body.autoPost && !req.auth!.permissions.has('voucher.post')) throw new AppError('FORBIDDEN', 'Thiếu quyền voucher.post', 403);
    const dto = await withOverride(req, async (trx) => {
      const { autoPost, ...input } = req.body;
      const v = await S.createVoucher(trx, ctx(req), input);
      return autoPost && v.state === 'draft' ? S.postVoucher(trx, v.id) : v;
    });
    if (dto.state === 'posted') void notify(req.auth!.tenantId!);
    return reply.status(201).send(dto);
  });

  app.put('/api/vouchers/:id', { preHandler: app.requirePermission('voucher.update'), schema: { params: idParam, body: z.union([S.voucherInput.extend({ version: z.number().int() }), S.metaInput]) } }, async (req) => {
    const b = req.body;
    return withOverride(req, async (trx) => {
      const cur = await trx.selectFrom('voucher').select('state').where('id', '=', req.params.id).executeTakeFirst();
      if (!cur) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ', 404);
      if ('voucherType' in b) {
        if (cur.state !== 'draft') throw new AppError('VOUCHER_POSTED_EDIT', 'Chứng từ đã ghi sổ: chỉ sửa được diễn giải/chiều phân tích, hoặc Bỏ ghi sổ trước', 409);
        const { version, ...input } = b; return S.updateDraft(trx, req.params.id, version, input);
      }
      if (cur.state === 'draft') throw new AppError('VALIDATION', 'Chứng từ nháp phải gửi đầy đủ nội dung', 400);
      return S.updatePostedMeta(trx, req.params.id, b);
    });
  });

  app.post('/api/vouchers/:id/post', { preHandler: app.requirePermission('voucher.post'), schema: { params: idParam } }, async (req) => {
    const dto = await withOverride(req, (trx) => S.postVoucher(trx, req.params.id)); void notify(req.auth!.tenantId!); return dto; });
  app.post('/api/vouchers/:id/unpost', { preHandler: app.requirePermission('voucher.unpost'), schema: { params: idParam } }, async (req) => {
    if (!req.auth!.permissions.has('voucher.edit_posted')) throw new AppError('FORBIDDEN', 'Thiếu quyền sửa sau ghi sổ', 403);
    const dto = await app.withTenant(req, (trx) => S.unpostVoucher(trx, req.params.id)); void notify(req.auth!.tenantId!); return dto; });
  app.post('/api/vouchers/:id/reverse', { preHandler: app.requirePermission('voucher.post'), schema: { params: idParam, body: z.object({ postingDate: z.string(), description: z.string().optional() }) } }, async (req, reply) => {
    const dto = await withOverride(req, (trx) => S.reverseVoucher(trx, req.params.id, req.body)); void notify(req.auth!.tenantId!); return reply.status(201).send(dto); });
  app.post('/api/vouchers/:id/discard', { preHandler: app.requirePermission('voucher.delete'), schema: { params: idParam } }, async (req) => app.withTenant(req, (trx) => S.discardVoucher(trx, req.params.id)));
  app.post('/api/vouchers/:id/duplicate', { preHandler: app.requirePermission('voucher.create'), schema: { params: idParam, body: z.object({ postingDate: z.string() }) } }, async (req, reply) =>
    reply.status(201).send(await withOverride(req, (trx) => S.duplicateVoucher(trx, ctx(req), req.params.id, req.body.postingDate))));
  app.delete('/api/vouchers/:id', { preHandler: app.requirePermission('voucher.delete'), schema: { params: idParam } }, async (req, reply) => { await app.withTenant(req, (trx) => S.deleteDraft(trx, req.params.id)); return reply.status(204).send(); });
};
export default routes;
```

Đăng ký `voucherRoutes` trong `app.ts`; thêm `export * from './voucherState.js';` vào domain index.

- [ ] **Step 8: Chạy test**

Run: `pnpm -F @kt/api test -- test/vouchers.test.ts`
Expected: PASS 8 test.

- [ ] **Step 9: Commit**

```bash
git add packages/db packages/domain apps/api
git commit -m "feat(ledger): thủ tục post/unpost/reverse/discard, máy trạng thái và API chứng từ"
```

---

### Task 16: Khóa kỳ ba mức, khóa theo phần hành, chuỗi hash khi khóa cứng, công cụ kiểm tra hash

**Files:**
- Create: `packages/db/migrations/0006_khoa_ky.sql`
- Create: `apps/api/src/modules/ledger/periods.service.ts`, `apps/api/src/modules/ledger/periods.routes.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/cli.ts` (lệnh `verify-hash`)
- Create: `apps/web/src/pages/Periods.tsx`; Modify: `apps/web/src/router.tsx`
- Test: `apps/api/test/periods.test.ts`

**Interfaces:**
- Consumes: `fiscal_period.status/locked_modules`, `voucher.prev_hash/row_hash`, `fn_assert_period_writable` (Task 14, 15).
- Produces:
  - SQL: `fiscal_period` thêm `hash_tail bytea`, `locked_by uuid`, `locked_at timestamptz`; `fn_voucher_canonical(p_id uuid) RETURNS text`; `lock_period(p_tenant uuid, p_year int, p_period int, p_level text)` (`'soft'|'hard'`); `unlock_period(p_tenant, p_year, p_period)` (hard→soft cần `app.unlock_hard = 'on'`, soft→open); `set_period_modules(p_tenant, p_year, p_period, p_modules text[])`; `verify_period_hash(p_tenant, p_year, p_period) RETURNS TABLE(voucher_id uuid, voucher_no text, stored bytea, computed bytea, ok boolean)`. Lỗi: `PERIOD_PREV_NOT_HARD_LOCKED`, `PERIOD_HAS_DRAFTS`, `PERIOD_LATER_HARD_LOCKED`, `PERIOD_UNLOCK_HARD_FORBIDDEN`, `PERIOD_STATE_INVALID`.
  - Route: `GET /api/periods?year=` → danh sách kỳ với `status`, `lockedModules`, `hashTail` (hex), `draftCount`; `POST /api/periods/:year/:no/lock { level }` (quyền `period.lock`); `POST /api/periods/:year/:no/unlock` (`period.unlock`; hard→soft cần thêm `period.unlock_hard`); `PUT /api/periods/:year/:no/modules { modules }` (`period.lock`); `GET /api/periods/:year/:no/verify-hash` (`period.view`) → `{ total, mismatched: [...] }`.
  - CLI độc lập: `pnpm -F @kt/api cli verify-hash --tenant-code ABC --year 2026 --period 3` (dùng `DATABASE_ADMIN_URL`, in kết quả, mã thoát 1 nếu lệch).
  - Thứ tự chuỗi hash: trong một tenant, các chứng từ trạng thái `posted|reversed|cancelled` của kỳ sắp xếp theo `(posting_date, voucher_type, seq_no, id)`; `prev_hash` của chứng từ đầu kỳ = `hash_tail` của kỳ hard-locked liền trước (hoặc `'\x00'`); `row_hash = sha256(prev_hash || canonical)`.

- [ ] **Step 1: Viết test (thất bại)**

`apps/api/test/periods.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
const pkt = (date: string, amount: string) => ({ voucherType: 'PKT', postingDate: date, documentDate: date, description: 'x', autoPost: true, lines: [{ accountCode: '6422', debit: amount }, { accountCode: '1111', credit: amount }] });
const create = (body: object) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: body });
const lock = (no: number, level: string) => ctx.app.inject({ method: 'POST', url: `/api/periods/2026/${no}/lock`, headers: { cookie }, payload: { level } });

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `PR${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
});
afterAll(async () => { await ctx.close(); });

describe('khóa kỳ', () => {
  it('khóa mềm: ghi sổ bị chặn trừ khi có quyền ghi lùi; bỏ khóa mềm mở lại', async () => {
    await create(pkt('2026-01-10', '100'));
    expect((await lock(1, 'soft')).statusCode).toBe(200);
    // admin có voucher.backdate_locked nên vẫn ghi được; tạo người dùng kế toán viên để kiểm tra bị chặn
    const username = `kt_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username, fullName: 'KT', password: 'Matkhau1!', roleCode: 'ketoan_vien' } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const ktCookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    const blocked = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie: ktCookie }, payload: pkt('2026-01-20', '5') });
    expect(blocked.json().error.code).toBe('PERIOD_SOFT_LOCKED');
    expect((await create(pkt('2026-01-21', '6'))).statusCode).toBe(201);
    const unpost = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${(await create(pkt('2026-01-22', '7'))).json().id}/unpost`, headers: { cookie } });
    expect(unpost.json().error.code).toBe('UNPOST_PERIOD_NOT_OPEN');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/periods/2026/1/unlock', headers: { cookie } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie: ktCookie }, payload: pkt('2026-01-20', '5') })).statusCode).toBe(201);
  });

  it('khóa phần hành chặn đúng loại chứng từ', async () => {
    await ctx.app.inject({ method: 'PUT', url: '/api/periods/2026/2/modules', headers: { cookie }, payload: { modules: ['general'] } });
    expect((await create(pkt('2026-02-05', '1'))).json().error.code).toBe('PERIOD_MODULE_LOCKED');
    await ctx.app.inject({ method: 'PUT', url: '/api/periods/2026/2/modules', headers: { cookie }, payload: { modules: [] } });
    expect((await create(pkt('2026-02-05', '1'))).statusCode).toBe(201);
  });

  it('khóa cứng: cần kỳ trước đã khóa cứng, không còn nháp; tính hash; verify đúng; sửa bằng SQL bị phát hiện; mọi ghi vào kỳ bị từ chối kể cả đảo', async () => {
    expect((await lock(2, 'hard')).json().error.code).toBe('PERIOD_PREV_NOT_HARD_LOCKED');
    const draft = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { ...pkt('2026-01-25', '3'), autoPost: false } });
    expect((await lock(0, 'hard')).statusCode).toBe(200);
    expect((await lock(1, 'hard')).json().error.code).toBe('PERIOD_HAS_DRAFTS');
    await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${draft.json().id}/post`, headers: { cookie } });
    expect((await lock(1, 'hard')).statusCode).toBe(200);
    const periods = (await ctx.app.inject({ method: 'GET', url: '/api/periods?year=2026', headers: { cookie } })).json() as { periodNo: number; status: string; hashTail: string | null }[];
    expect(periods.find((p) => p.periodNo === 1)).toMatchObject({ status: 'hard_locked' }); expect(periods.find((p) => p.periodNo === 1)!.hashTail).toMatch(/^[0-9a-f]{64}$/);
    const hashes = await sql<{ row_hash: Buffer | null; prev_hash: Buffer | null }>`SELECT row_hash, prev_hash FROM voucher WHERE tenant_id = ${tenantId}::uuid AND period_no = 1 AND state <> 'draft'`.execute(ctx.t.admin);
    expect(hashes.rows.length).toBeGreaterThan(0); expect(hashes.rows.every((h) => h.row_hash && h.prev_hash)).toBe(true);
    let verify = await ctx.app.inject({ method: 'GET', url: '/api/periods/2026/1/verify-hash', headers: { cookie } });
    expect(verify.json()).toMatchObject({ mismatched: [] }); expect(verify.json().total).toBeGreaterThan(0);
    // giả lập can thiệp trực tiếp bằng owner DB (bỏ qua trigger)
    await sql`ALTER TABLE voucher DISABLE TRIGGER trg_voucher_before`.execute(ctx.t.admin);
    await sql`UPDATE voucher SET description = 'bị sửa' WHERE tenant_id = ${tenantId}::uuid AND period_no = 1 AND state = 'posted'`.execute(ctx.t.admin);
    await sql`ALTER TABLE voucher ENABLE TRIGGER trg_voucher_before`.execute(ctx.t.admin);
    verify = await ctx.app.inject({ method: 'GET', url: '/api/periods/2026/1/verify-hash', headers: { cookie } });
    expect(verify.json().mismatched.length).toBeGreaterThan(0);
    const posted = (await ctx.app.inject({ method: 'GET', url: '/api/vouchers?from=2026-01-01&to=2026-01-31&state=posted', headers: { cookie } })).json().rows[0];
    expect((await create(pkt('2026-01-28', '1'))).json().error.code).toBe('PERIOD_HARD_LOCKED');
    expect((await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${posted.id}/reverse`, headers: { cookie }, payload: { postingDate: '2026-01-31' } })).json().error.code).toBe('PERIOD_HARD_LOCKED');
    expect((await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${posted.id}/unpost`, headers: { cookie } })).json().error.code).toBe('VOUCHER_HASHED');
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${posted.id}`, headers: { cookie }, payload: { version: 99, description: 'x' } })).statusCode).toBe(409);
    // Đảo sang kỳ mở cũng bị từ chối vì phải đổi trạng thái chứng từ gốc đang nằm trong kỳ khóa cứng (bất biến 6).
    expect((await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${posted.id}/reverse`, headers: { cookie }, payload: { postingDate: '2026-02-10' } })).json().error.code).toBe('PERIOD_HARD_LOCKED');
  });

  it('bỏ khóa cứng cần quyền riêng, xóa hash của kỳ và không được khi kỳ sau đã khóa cứng', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/periods/2026/0/unlock', headers: { cookie } });
    expect(r.json().error.code).toBe('PERIOD_LATER_HARD_LOCKED');
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/periods/2026/1/unlock', headers: { cookie } });
    expect(ok.statusCode).toBe(200); expect(ok.json().status).toBe('soft_locked');
    const hashes = await sql<{ n: string }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND period_no = 1 AND row_hash IS NOT NULL`.execute(ctx.t.admin);
    expect(hashes.rows[0]!.n).toBe('0');
    // Kỳ 1 giờ khóa mềm: đảo chứng từ gốc sang kỳ 2 đang mở được phép (đường "chứng từ đảo + chứng từ mới" của mục 7.1).
    const posted = (await ctx.app.inject({ method: 'GET', url: '/api/vouchers?from=2026-01-01&to=2026-01-31&state=posted', headers: { cookie } })).json().rows[0];
    const rev = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${posted.id}/reverse`, headers: { cookie }, payload: { postingDate: '2026-02-10' } });
    expect(rev.statusCode, rev.body).toBe(201);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/api test -- test/periods.test.ts` → FAIL 404.

- [ ] **Step 3: Migration khóa kỳ**

`packages/db/migrations/0006_khoa_ky.sql`:

```sql
ALTER TABLE fiscal_period ADD COLUMN hash_tail bytea, ADD COLUMN locked_by uuid, ADD COLUMN locked_at timestamptz;

CREATE OR REPLACE FUNCTION fn_voucher_canonical(p_id uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT (jsonb_build_object(
    'id', v.id, 'type', v.voucher_type, 'no', v.voucher_no, 'seq', v.seq_no, 'posting_date', v.posting_date, 'document_date', v.document_date,
    'state', v.state, 'description', v.description, 'party_id', v.party_id, 'currency', v.currency_code, 'fx_rate', v.fx_rate,
    'reversal_of', v.reversal_of_id, 'is_closing', v.is_closing, 'posted_at', v.posted_at,
    'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('n', l.line_no, 'acc', a.code, 'd', l.debit, 'c', l.credit, 'ac', l.amount_currency, 'cur', l.currency_code,
        'party', l.party_id, 'dept', l.department_id, 'proj', l.project_id, 'ci', l.cost_item_id, 'emp', l.employee_id, 'desc', l.description, 'due', l.due_date) ORDER BY l.line_no)
      FROM voucher_line l JOIN account a ON a.id = l.account_id WHERE l.voucher_id = v.id), '[]'::jsonb)))::text
  FROM voucher v WHERE v.id = p_id;
$$;

CREATE OR REPLACE FUNCTION fn_period_audit(p_tenant uuid, p_action text, p_year int, p_period int, p_extra jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, after, ip)
  VALUES (p_tenant, app_user_id(), p_action, 'fiscal_period', p_year || '/' || p_period, p_extra, nullif(current_setting('app.client_ip', true), ''));
$$;

CREATE OR REPLACE FUNCTION lock_period(p_tenant uuid, p_year int, p_period int, p_level text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p fiscal_period; prev bytea; h bytea; r record; n_draft int;
BEGIN
  SELECT * INTO p FROM fiscal_period WHERE tenant_id = p_tenant AND fiscal_year = p_year AND period_no = p_period FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERIOD_NOT_FOUND: kỳ %/%', p_period, p_year USING ERRCODE = 'P0001'; END IF;
  IF p_level = 'soft' THEN
    IF p.status <> 'open' THEN RAISE EXCEPTION 'PERIOD_STATE_INVALID: kỳ đang ở trạng thái %', p.status USING ERRCODE = 'P0001'; END IF;
    UPDATE fiscal_period SET status = 'soft_locked', locked_by = app_user_id(), locked_at = now() WHERE id = p.id;
    PERFORM fn_period_audit(p_tenant, 'lock', p_year, p_period, '{"level":"soft"}');
    RETURN;
  END IF;
  IF p_level <> 'hard' THEN RAISE EXCEPTION 'VALIDATION: mức khóa phải là soft hoặc hard' USING ERRCODE = 'P0001'; END IF;
  IF p.status = 'hard_locked' THEN RAISE EXCEPTION 'PERIOD_STATE_INVALID: kỳ đã khóa cứng' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM fiscal_period q WHERE q.tenant_id = p_tenant AND (q.fiscal_year, q.period_no) < (p_year, p_period) AND q.status <> 'hard_locked') THEN
    RAISE EXCEPTION 'PERIOD_PREV_NOT_HARD_LOCKED: phải khóa cứng các kỳ trước theo thứ tự' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO n_draft FROM voucher WHERE tenant_id = p_tenant AND fiscal_year = p_year AND period_no = p_period AND state = 'draft';
  IF n_draft > 0 THEN RAISE EXCEPTION 'PERIOD_HAS_DRAFTS: còn % chứng từ nháp trong kỳ', n_draft USING ERRCODE = 'P0001'; END IF;
  SELECT hash_tail INTO prev FROM fiscal_period q WHERE q.tenant_id = p_tenant AND (q.fiscal_year, q.period_no) < (p_year, p_period) AND q.hash_tail IS NOT NULL
    ORDER BY q.fiscal_year DESC, q.period_no DESC LIMIT 1;
  prev := coalesce(prev, '\x00'::bytea);
  PERFORM set_config('app.locking', 'on', true);
  FOR r IN SELECT id FROM voucher WHERE tenant_id = p_tenant AND fiscal_year = p_year AND period_no = p_period AND state IN ('posted','reversed','cancelled')
           ORDER BY posting_date, voucher_type, seq_no, id LOOP
    h := digest(prev || convert_to(fn_voucher_canonical(r.id), 'UTF8'), 'sha256');
    UPDATE voucher SET prev_hash = prev, row_hash = h WHERE id = r.id;
    prev := h;
  END LOOP;
  PERFORM set_config('app.locking', 'off', true);
  UPDATE fiscal_period SET status = 'hard_locked', hash_tail = prev, locked_by = app_user_id(), locked_at = now() WHERE id = p.id;
  PERFORM fn_period_audit(p_tenant, 'lock', p_year, p_period, jsonb_build_object('level', 'hard', 'hash_tail', encode(prev, 'hex')));
END $$;

CREATE OR REPLACE FUNCTION unlock_period(p_tenant uuid, p_year int, p_period int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE p fiscal_period; v_new text;
BEGIN
  SELECT * INTO p FROM fiscal_period WHERE tenant_id = p_tenant AND fiscal_year = p_year AND period_no = p_period FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERIOD_NOT_FOUND: kỳ %/%', p_period, p_year USING ERRCODE = 'P0001'; END IF;
  IF p.status = 'open' THEN RAISE EXCEPTION 'PERIOD_STATE_INVALID: kỳ đang mở' USING ERRCODE = 'P0001'; END IF;
  IF p.status = 'hard_locked' THEN
    IF current_setting('app.unlock_hard', true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'PERIOD_UNLOCK_HARD_FORBIDDEN: cần quyền bỏ khóa cứng' USING ERRCODE = 'P0001'; END IF;
    IF EXISTS (SELECT 1 FROM fiscal_period q WHERE q.tenant_id = p_tenant AND (q.fiscal_year, q.period_no) > (p_year, p_period) AND q.status = 'hard_locked') THEN
      RAISE EXCEPTION 'PERIOD_LATER_HARD_LOCKED: phải bỏ khóa cứng kỳ sau trước' USING ERRCODE = 'P0001'; END IF;
    PERFORM set_config('app.locking', 'on', true);
    UPDATE voucher SET prev_hash = NULL, row_hash = NULL WHERE tenant_id = p_tenant AND fiscal_year = p_year AND period_no = p_period;
    PERFORM set_config('app.locking', 'off', true);
    v_new := 'soft_locked';
    UPDATE fiscal_period SET status = v_new, hash_tail = NULL WHERE id = p.id;
  ELSE
    v_new := 'open';
    UPDATE fiscal_period SET status = v_new, locked_by = NULL, locked_at = NULL WHERE id = p.id;
  END IF;
  PERFORM fn_period_audit(p_tenant, 'unlock', p_year, p_period, jsonb_build_object('from', p.status, 'to', v_new));
  RETURN v_new;
END $$;

CREATE OR REPLACE FUNCTION set_period_modules(p_tenant uuid, p_year int, p_period int, p_modules text[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE fiscal_period SET locked_modules = p_modules WHERE tenant_id = p_tenant AND fiscal_year = p_year AND period_no = p_period;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERIOD_NOT_FOUND: kỳ %/%', p_period, p_year USING ERRCODE = 'P0001'; END IF;
  PERFORM fn_period_audit(p_tenant, 'lock_modules', p_year, p_period, to_jsonb(p_modules));
END $$;

CREATE OR REPLACE FUNCTION verify_period_hash(p_tenant uuid, p_year int, p_period int)
RETURNS TABLE(voucher_id uuid, voucher_no text, stored bytea, computed bytea, ok boolean) LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
DECLARE prev bytea; r record; h bytea;
BEGIN
  SELECT hash_tail INTO prev FROM fiscal_period q WHERE q.tenant_id = p_tenant AND (q.fiscal_year, q.period_no) < (p_year, p_period) AND q.hash_tail IS NOT NULL ORDER BY q.fiscal_year DESC, q.period_no DESC LIMIT 1;
  prev := coalesce(prev, '\x00'::bytea);
  FOR r IN SELECT v.id, v.voucher_no, v.row_hash FROM voucher v WHERE v.tenant_id = p_tenant AND v.fiscal_year = p_year AND v.period_no = p_period AND v.state IN ('posted','reversed','cancelled')
           ORDER BY v.posting_date, v.voucher_type, v.seq_no, v.id LOOP
    h := digest(prev || convert_to(fn_voucher_canonical(r.id), 'UTF8'), 'sha256');
    voucher_id := r.id; voucher_no := r.voucher_no; stored := r.row_hash; computed := h; ok := (r.row_hash = h);
    RETURN NEXT;
    prev := h;
  END LOOP;
END $$;
```

Bổ sung vào `fn_voucher_before` (định nghĩa lại hàm với thêm điều kiện): khi `v_lock` đúng, cho phép cập nhật `prev_hash/row_hash` (đã có qua `NOT v_lock` trong nhánh bất biến). Không cần đổi gì thêm.

- [ ] **Step 4: Service, route, CLI**

`apps/api/src/modules/ledger/periods.service.ts`:

```ts
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';

export async function listPeriods(trx: Transaction<Database>, year?: number) {
  let q = trx.selectFrom('fiscal_period as p').select(['p.fiscal_year as fiscalYear', 'p.period_no as periodNo', 'p.date_from as dateFrom', 'p.date_to as dateTo', 'p.regime', 'p.status', 'p.locked_modules as lockedModules',
    sql<string | null>`encode(p.hash_tail, 'hex')`.as('hashTail'), 'p.locked_at as lockedAt',
    sql<number>`(SELECT count(*)::int FROM voucher v WHERE v.tenant_id = p.tenant_id AND v.fiscal_year = p.fiscal_year AND v.period_no = p.period_no AND v.state = 'draft')`.as('draftCount')]);
  if (year) q = q.where('p.fiscal_year', '=', year);
  return q.orderBy('p.fiscal_year').orderBy('p.period_no').execute();
}
export const lockPeriod = (trx: Transaction<Database>, tenantId: string, year: number, no: number, level: 'soft' | 'hard') => sql`SELECT lock_period(${tenantId}::uuid, ${year}, ${no}, ${level})`.execute(trx);
export async function unlockPeriod(trx: Transaction<Database>, tenantId: string, year: number, no: number, allowHard: boolean) {
  if (allowHard) await sql`SELECT set_config('app.unlock_hard', 'on', true)`.execute(trx);
  return (await sql<{ s: string }>`SELECT unlock_period(${tenantId}::uuid, ${year}, ${no}) AS s`.execute(trx)).rows[0]!.s;
}
export const setPeriodModules = (trx: Transaction<Database>, tenantId: string, year: number, no: number, modules: string[]) => sql`SELECT set_period_modules(${tenantId}::uuid, ${year}, ${no}, ${sql.val(modules)}::text[])`.execute(trx);
export async function verifyPeriodHash(trx: Transaction<Database>, tenantId: string, year: number, no: number) {
  const r = await sql<{ voucher_id: string; voucher_no: string; stored: Buffer | null; computed: Buffer; ok: boolean }>`SELECT * FROM verify_period_hash(${tenantId}::uuid, ${year}, ${no})`.execute(trx);
  return { total: r.rows.length, mismatched: r.rows.filter((x) => !x.ok).map((x) => ({ voucherId: x.voucher_id, voucherNo: x.voucher_no, stored: x.stored?.toString('hex') ?? null, computed: x.computed.toString('hex') })) };
}
```

`apps/api/src/modules/ledger/periods.routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { listPeriods, lockPeriod, setPeriodModules, unlockPeriod, verifyPeriodHash } from './periods.service.js';

const params = z.object({ year: z.coerce.number().int(), no: z.coerce.number().int().min(0).max(15) });
const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/periods', { preHandler: app.requirePermission('period.view'), schema: { querystring: z.object({ year: z.coerce.number().int().optional() }) } }, async (req) => app.withTenant(req, (trx) => listPeriods(trx, req.query.year)));
  app.post('/api/periods/:year/:no/lock', { preHandler: app.requirePermission('period.lock'), schema: { params, body: z.object({ level: z.enum(['soft', 'hard']) }) } }, async (req) => {
    await app.withTenant(req, (trx) => lockPeriod(trx, req.auth!.tenantId!, req.params.year, req.params.no, req.body.level)); return { ok: true }; });
  app.post('/api/periods/:year/:no/unlock', { preHandler: app.requirePermission('period.unlock'), schema: { params } }, async (req) =>
    ({ status: await app.withTenant(req, (trx) => unlockPeriod(trx, req.auth!.tenantId!, req.params.year, req.params.no, req.auth!.permissions.has('period.unlock_hard'))) }));
  app.put('/api/periods/:year/:no/modules', { preHandler: app.requirePermission('period.lock'), schema: { params, body: z.object({ modules: z.array(z.enum(['general', 'cash', 'bank', 'inventory', 'arap', 'assets', 'payroll'])) }) } }, async (req) => {
    await app.withTenant(req, (trx) => setPeriodModules(trx, req.auth!.tenantId!, req.params.year, req.params.no, req.body.modules)); return { ok: true }; });
  app.get('/api/periods/:year/:no/verify-hash', { preHandler: app.requirePermission('period.view'), schema: { params } }, async (req) => app.withTenant(req, (trx) => verifyPeriodHash(trx, req.auth!.tenantId!, req.params.year, req.params.no)));
};
export default routes;
```

Thêm vào `apps/api/src/cli.ts` lệnh `verify-hash` (nhánh `positionals[0] === 'verify-hash'`): đọc `--tenant-code`, `--year`, `--period`; kết nối `DATABASE_ADMIN_URL`; `SELECT id FROM tenant WHERE code=$1`; `SELECT set_config('app.current_tenant', id, false)`; `SELECT voucher_no, ok, encode(stored,'hex'), encode(computed,'hex') FROM verify_period_hash($1,$2,$3)`; in từng dòng lệch; `process.exit(mismatched ? 1 : 0)`.

Đăng ký `periodRoutes` trong `app.ts`. Run: `pnpm -F @kt/api test -- test/periods.test.ts` → PASS 4.

- [ ] **Step 5: Màn hình kỳ kế toán**

`apps/web/src/pages/Periods.tsx`: bảng kỳ của năm chọn (`Select` năm từ `/api/fiscal-years`), cột: Kỳ, Từ ngày, Đến ngày, Trạng thái (`Tag` Mở / Khóa sổ / Khóa cứng), Phần hành khóa (`Select mode="multiple"` ghi ngay qua `PUT .../modules`), Chứng từ nháp, Hash (8 ký tự đầu), nút "Khóa sổ" (soft), "Khóa cứng" (xác nhận `Modal.confirm` với nội dung "Khóa cứng tính chuỗi hash, không sửa được chứng từ trong kỳ; chỉ bỏ khóa được với quyền riêng"), "Bỏ khóa", "Kiểm tra hash" (hiển thị `message.success('Toàn bộ N chứng từ khớp')` hoặc bảng lệch). Route `/so-cai/ky-ke-toan`, nhóm menu mới "Sổ cái" `{ key: 'socai', label: 'Sổ cái', to: '/so-cai', children: [{ key: 'periods', label: 'Kỳ kế toán và khóa sổ', to: '/so-cai/ky-ke-toan', permission: 'period.view' }] }`.

Run: `pnpm -F @kt/web typecheck` → mã 0.

- [ ] **Step 6: Commit**

```bash
git add packages/db apps/api apps/web
git commit -m "feat(ledger): khóa kỳ ba mức, khóa phần hành, chuỗi hash khi khóa cứng và công cụ kiểm tra"
```

---

### Task 17: Đánh số chứng từ không lỗ hổng: cấu hình theo loại, đánh lại số theo ngày, kiểm tra trùng

**Files:**
- Create: `packages/db/migrations/0007_danh_so.sql`
- Create: `packages/domain/src/numbering.ts`; Modify: `packages/domain/src/index.ts`
- Create: `apps/api/src/modules/ledger/numbering.ts`; Modify: `apps/api/src/app.ts`
- Modify: `apps/web/src/pages/Periods.tsx` (thẻ "Loại chứng từ và đánh số")
- Test: `packages/domain/test/numbering.test.ts`, `apps/api/test/numbering.test.ts`

**Interfaces:**
- Consumes: `voucher_counter`, `fn_format_voucher_no`, `voucher_type` (Task 14, 15).
- Produces:
  - Domain: `formatVoucherNo(i: { prefix: string; suffix: string; padLength: number; seq: number; year: number }): string` (bản TS giống `fn_format_voucher_no`).
  - SQL: `renumber_vouchers(p_tenant uuid, p_type text, p_year int) RETURNS int` (số chứng từ đã đánh lại; yêu cầu mọi kỳ của năm có chứng từ loại đó đang `open`, lỗi `RENUMBER_PERIOD_LOCKED`; sắp xếp theo `(posting_date, created_at)`; `voucher_counter.last_no` = số lượng; audit `renumber`).
  - Route: `PUT /api/voucher-types/:code { name?, prefix?, suffix?, padLength?, isActive? }` (quyền `setting.update`); `GET /api/voucher-types/:code/next-no?year=` → `{ preview }`; `POST /api/vouchers/renumber { voucherType, fiscalYear }` (quyền `voucher.renumber`) → `{ count }`; `GET /api/vouchers/check-no?type=&no=` → `{ exists: boolean; voucherId? }`.

- [ ] **Step 1: Viết test (thất bại)**

`packages/domain/test/numbering.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatVoucherNo } from '../src/numbering.js';
describe('formatVoucherNo', () => {
  it('ghép tiền tố, số đệm, hậu tố và thay năm', () => {
    expect(formatVoucherNo({ prefix: 'PKT', suffix: '', padLength: 5, seq: 7, year: 2026 })).toBe('PKT00007');
    expect(formatVoucherNo({ prefix: 'PC{YY}/', suffix: '', padLength: 4, seq: 12, year: 2026 })).toBe('PC26/0012');
    expect(formatVoucherNo({ prefix: '', suffix: '/{YYYY}', padLength: 3, seq: 1234, year: 2026 })).toBe('1234/2026');
  });
});
```

`apps/api/test/numbering.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
const pkt = (date: string, amount: string, more: object = {}) => ({ voucherType: 'PKT', postingDate: date, documentDate: date, description: 'x', autoPost: true, lines: [{ accountCode: '6422', debit: amount }, { accountCode: '1111', credit: amount }], ...more });
const create = (body: object) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: body });

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `NB${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
});
afterAll(async () => { await ctx.close(); });

describe('đánh số', () => {
  it('cấu hình tiền tố/hậu tố/độ dài áp dụng cho số tiếp theo; xem trước đúng', async () => {
    const u = await ctx.app.inject({ method: 'PUT', url: '/api/voucher-types/PKT', headers: { cookie }, payload: { prefix: 'PKT{YY}-', padLength: 4 } });
    expect(u.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/voucher-types/PKT/next-no?year=2026', headers: { cookie } })).json()).toEqual({ preview: 'PKT26-0001' });
    expect((await create(pkt('2026-01-05', '1'))).json().voucherNo).toBe('PKT26-0001');
  });
  it('ghi sổ thất bại không tiêu tốn số; hủy giữ số; không có lỗ hổng', async () => {
    const bad = await create({ ...pkt('2026-01-06', '1'), lines: [{ accountCode: '6422', debit: '1' }, { accountCode: '1111', credit: '2' }] });
    expect(bad.statusCode).toBe(409);
    const v2 = (await create(pkt('2026-01-07', '2'))).json(); expect(v2.voucherNo).toBe('PKT26-0002');
    await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v2.id}/unpost`, headers: { cookie } });
    await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v2.id}/discard`, headers: { cookie } });
    const v3 = (await create(pkt('2026-01-08', '3'))).json(); expect(v3.voucherNo).toBe('PKT26-0003');
    const seqs = await sql<{ seq_no: string }>`SELECT seq_no FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'PKT' AND seq_no IS NOT NULL ORDER BY seq_no`.execute(ctx.t.admin);
    expect(seqs.rows.map((r) => Number(r.seq_no))).toEqual([1, 2, 3]);
  });
  it('đánh lại số theo ngày chứng từ trong kỳ mở; bị từ chối khi có kỳ khóa', async () => {
    await create(pkt('2026-01-02', '4'));  // ngày sớm hơn nhưng số lớn hơn
    const r = await ctx.app.inject({ method: 'POST', url: '/api/vouchers/renumber', headers: { cookie }, payload: { voucherType: 'PKT', fiscalYear: 2026 } });
    expect(r.statusCode, r.body).toBe(200); expect(r.json().count).toBe(4);
    const rows = await sql<{ posting_date: string; voucher_no: string }>`SELECT posting_date, voucher_no FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'PKT' AND voucher_no IS NOT NULL ORDER BY seq_no`.execute(ctx.t.admin);
    expect(rows.rows.map((x) => x.posting_date)).toEqual(['2026-01-02', '2026-01-05', '2026-01-07', '2026-01-08']);
    expect(rows.rows[0]!.voucher_no).toBe('PKT26-0001');
    await ctx.app.inject({ method: 'POST', url: '/api/periods/2026/1/lock', headers: { cookie }, payload: { level: 'soft' } });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/vouchers/renumber', headers: { cookie }, payload: { voucherType: 'PKT', fiscalYear: 2026 } })).json().error.code).toBe('RENUMBER_PERIOD_LOCKED');
  });
  it('kiểm tra trùng số', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/vouchers/check-no?type=PKT&no=PKT26-0001', headers: { cookie } });
    expect(r.json().exists).toBe(true);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/vouchers/check-no?type=PKT&no=KHONGCO', headers: { cookie } })).json().exists).toBe(false);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/domain test -- test/numbering.test.ts && pnpm -F @kt/api test -- test/numbering.test.ts` → FAIL.

- [ ] **Step 3: Mã**

`packages/domain/src/numbering.ts`:

```ts
export function formatVoucherNo(i: { prefix: string; suffix: string; padLength: number; seq: number; year: number }): string {
  const sub = (s: string) => s.replace(/\{YYYY\}/g, String(i.year)).replace(/\{YY\}/g, String(i.year).slice(-2));
  return sub(i.prefix) + String(i.seq).padStart(i.padLength, '0') + sub(i.suffix);
}
```

`packages/db/migrations/0007_danh_so.sql`:

```sql
CREATE OR REPLACE FUNCTION renumber_vouchers(p_tenant uuid, p_type text, p_year int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE vt voucher_type; r record; n int := 0;
BEGIN
  SELECT * INTO vt FROM voucher_type WHERE tenant_id = p_tenant AND code = p_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOUCHER_TYPE_NOT_FOUND: %', p_type USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM voucher v JOIN fiscal_period p ON p.tenant_id = v.tenant_id AND p.fiscal_year = v.fiscal_year AND p.period_no = v.period_no
             WHERE v.tenant_id = p_tenant AND v.voucher_type = p_type AND v.fiscal_year = p_year AND v.voucher_no IS NOT NULL AND p.status <> 'open') THEN
    RAISE EXCEPTION 'RENUMBER_PERIOD_LOCKED: có kỳ đã khóa trong năm, không đánh lại số được' USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('app.renumbering', 'on', true);
  -- bước 1: tránh đụng UNIQUE bằng số tạm
  UPDATE voucher SET voucher_no = '~' || id::text WHERE tenant_id = p_tenant AND voucher_type = p_type AND fiscal_year = p_year AND voucher_no IS NOT NULL;
  FOR r IN SELECT id FROM voucher WHERE tenant_id = p_tenant AND voucher_type = p_type AND fiscal_year = p_year AND voucher_no IS NOT NULL ORDER BY posting_date, created_at, id LOOP
    n := n + 1;
    UPDATE voucher SET seq_no = n, voucher_no = fn_format_voucher_no(vt.prefix, vt.suffix, vt.pad_length, n, p_year) WHERE id = r.id;
  END LOOP;
  PERFORM set_config('app.renumbering', 'off', true);
  INSERT INTO voucher_counter(tenant_id, voucher_type, fiscal_year, last_no) VALUES (p_tenant, p_type, p_year, n)
    ON CONFLICT (tenant_id, voucher_type, fiscal_year) DO UPDATE SET last_no = n;
  INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, after) VALUES (p_tenant, app_user_id(), 'renumber', 'voucher_type', p_type, jsonb_build_object('year', p_year, 'count', n));
  RETURN n;
END $$;
```

`apps/api/src/modules/ledger/numbering.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { formatVoucherNo } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

const routes: FastifyPluginAsyncZod = async (app) => {
  app.put('/api/voucher-types/:code', { preHandler: app.requirePermission('setting.update'), schema: { params: z.object({ code: z.string() }),
    body: z.object({ name: z.string().min(1).optional(), prefix: z.string().max(20).optional(), suffix: z.string().max(20).optional(), padLength: z.number().int().min(1).max(10).optional(), isActive: z.boolean().optional() }) } }, async (req) => {
    const b = req.body;
    const r = await app.withTenant(req, (trx) => trx.updateTable('voucher_type').set({ ...(b.name !== undefined ? { name: b.name } : {}), ...(b.prefix !== undefined ? { prefix: b.prefix } : {}),
      ...(b.suffix !== undefined ? { suffix: b.suffix } : {}), ...(b.padLength !== undefined ? { pad_length: b.padLength } : {}), ...(b.isActive !== undefined ? { is_active: b.isActive } : {}) }).where('code', '=', req.params.code).executeTakeFirst());
    if (r.numUpdatedRows === 0n) throw new AppError('VOUCHER_TYPE_NOT_FOUND', `Không có loại chứng từ ${req.params.code}`, 404);
    return { ok: true };
  });
  app.get('/api/voucher-types/:code/next-no', { preHandler: app.requireAuth, schema: { params: z.object({ code: z.string() }), querystring: z.object({ year: z.coerce.number().int() }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const vt = await trx.selectFrom('voucher_type').selectAll().where('code', '=', req.params.code).executeTakeFirst();
      if (!vt) throw new AppError('VOUCHER_TYPE_NOT_FOUND', `Không có loại chứng từ ${req.params.code}`, 404);
      const c = await trx.selectFrom('voucher_counter').select('last_no').where('voucher_type', '=', vt.code).where('fiscal_year', '=', req.query.year).executeTakeFirst();
      return { preview: formatVoucherNo({ prefix: vt.prefix, suffix: vt.suffix, padLength: vt.pad_length, seq: Number(c?.last_no ?? 0) + 1, year: req.query.year }) };
    }));
  app.post('/api/vouchers/renumber', { preHandler: app.requirePermission('voucher.renumber'), schema: { body: z.object({ voucherType: z.string(), fiscalYear: z.number().int() }) } }, async (req) =>
    app.withTenant(req, async (trx) => ({ count: (await sql<{ n: number }>`SELECT renumber_vouchers(${req.auth!.tenantId!}::uuid, ${req.body.voucherType}, ${req.body.fiscalYear}) AS n`.execute(trx)).rows[0]!.n })));
  app.get('/api/vouchers/check-no', { preHandler: app.requirePermission('voucher.view'), schema: { querystring: z.object({ type: z.string(), no: z.string() }) } }, async (req) =>
    app.withTenant(req, async (trx) => { const v = await trx.selectFrom('voucher').select('id').where('voucher_type', '=', req.query.type).where('voucher_no', '=', req.query.no).executeTakeFirst(); return { exists: !!v, voucherId: v?.id }; }));
};
export default routes;
```

Đăng ký `numberingRoutes` trong `app.ts` **trước** `voucherRoutes` (để `/api/vouchers/renumber` và `/api/vouchers/check-no` không bị `/api/vouchers/:id` nuốt; Fastify ưu tiên route tĩnh nên thứ tự không bắt buộc, nhưng giữ để rõ). Thêm `export * from './numbering.js';` vào domain index.

- [ ] **Step 4: Chạy test**

Run: `pnpm -F @kt/domain test -- test/numbering.test.ts && pnpm -F @kt/api test -- test/numbering.test.ts` → PASS 1 + 4.

- [ ] **Step 5: Giao diện cấu hình loại chứng từ**

Thêm vào `apps/web/src/pages/Periods.tsx` một `Tabs` với thẻ thứ hai "Loại chứng từ và đánh số": bảng `voucher_type` (`GET /api/voucher-types`) cột Mã, Tên, Tiền tố, Hậu tố, Độ dài số, Số tiếp theo (gọi `next-no` với năm đang chọn), chỉnh sửa inline bằng `Form` trong `Modal` → `PUT /api/voucher-types/:code`; nút "Đánh lại số theo ngày" (`Modal.confirm` nêu rõ chỉ chạy khi mọi kỳ của năm còn mở) → `POST /api/vouchers/renumber`.

- [ ] **Step 6: Commit**

```bash
git add packages/db packages/domain apps/api apps/web
git commit -m "feat(ledger): cấu hình đánh số theo loại chứng từ, đánh lại số theo ngày và kiểm tra trùng"
```

---

### Task 18: Màn hình Phiếu kế toán: danh sách, nhập liệu bằng bàn phím, đính kèm, nhân bản, in, kiểm thử Playwright

**Files:**
- Create: `packages/db/migrations/0008_dinh_kem.sql`
- Create: `apps/api/src/modules/ledger/attachments.ts`, `apps/api/src/modules/reporting/print/pdf.ts`, `apps/api/src/modules/reporting/print/voucherHtml.ts`
- Modify: `apps/api/src/config.ts` (`ATTACHMENT_DIR`), `apps/api/src/app.ts`, `apps/api/src/modules/ledger/vouchers.routes.ts` (route in)
- Create: `apps/web/src/pages/VoucherList.tsx`, `apps/web/src/pages/Voucher.tsx`, `apps/web/src/lookups.ts`; Modify: `apps/web/src/router.tsx`
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/phieu-ke-toan.spec.ts`
- Modify: `.github/workflows/ci.yml` (job `e2e`)
- Test: `apps/api/test/attachments.test.ts`, `apps/api/test/voucherPrint.test.ts`, `apps/web/test/Voucher.test.tsx`

**Interfaces:**
- Consumes: API chứng từ (Task 15), `KeyboardGrid`, `LookupSelect`, `VnNumberInput`, `useRememberedFilter` (Task 10), `GET /api/accounts` (Task 7).
- Produces:
  - `POST /api/vouchers/:id/attachments` (multipart `file`, quyền `voucher.update`) → `{ id, fileName, bytes }`; `GET /api/vouchers/:id/attachments`; `GET /api/attachments/:attId` (stream, `content-disposition: attachment`); `DELETE /api/attachments/:attId`. Tệp lưu tại `ATTACHMENT_DIR/<tenantId>/<voucherId>/<attId>` (mặc định `./attachments`; Docker volume `attachments:/attachments`).
  - `renderVoucherHtml(v: VoucherDto, company: CompanyInfo): string` với `CompanyInfo = { name; address; taxCode; legalRep; chiefAccountant; formNo: string; issuedBy: string }`; `GET /api/vouchers/:id/print?format=html|pdf` (quyền `voucher.print`).
  - `renderPdf(html: string, opts?: { landscape?: boolean }): Promise<Buffer>` (Playwright Chromium, `format: 'A4'`, `printBackground: true`, lề 12 mm; dùng `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` nếu có; trình duyệt dùng lại trong tiến trình).
  - Web: `accountFetcher(q)` (lọc từ `/api/accounts?regime=` đã cache), trang `/chung-tu/phieu-ke-toan` (danh sách) và `/chung-tu/phieu-ke-toan/$id` (`moi` = tạo mới). Phím tắt: `Ctrl+S` lưu, `F9` ghi sổ, `F4` chọn danh mục tại ô, `Ctrl+Insert`/`Ctrl+Delete` chèn/xóa dòng, `Insert` ở danh sách = thêm mới, `Enter` ở danh sách = mở.

- [ ] **Step 1: Viết test đính kèm và in (thất bại)**

`apps/api/test/attachments.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import FormData from 'form-data';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let voucherId: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `AT${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  voucherId = (await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: '2026-01-05', documentDate: '2026-01-05', description: 'x', lines: [{ accountCode: '6422', debit: '10' }, { accountCode: '1111', credit: '10' }] } })).json().id;
});
afterAll(async () => { await ctx.close(); });

describe('đính kèm', () => {
  it('tải lên, liệt kê, tải về đúng nội dung, xóa', async () => {
    const fd = new FormData(); fd.append('file', Buffer.from('hoa don mau'), { filename: 'hoadon.txt', contentType: 'text/plain' });
    const up = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${voucherId}/attachments`, headers: { cookie, ...fd.getHeaders() }, payload: fd.getBuffer() });
    expect(up.statusCode, up.body).toBe(201); expect(up.json()).toMatchObject({ fileName: 'hoadon.txt', bytes: 11 });
    const list = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${voucherId}/attachments`, headers: { cookie } });
    expect(list.json()).toHaveLength(1);
    const dl = await ctx.app.inject({ method: 'GET', url: `/api/attachments/${up.json().id}`, headers: { cookie } });
    expect(dl.body).toBe('hoa don mau'); expect(dl.headers['content-disposition']).toContain('hoadon.txt');
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/attachments/${up.json().id}`, headers: { cookie } })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${voucherId}/attachments`, headers: { cookie } })).json()).toHaveLength(0);
  });
});
```

`apps/api/test/voucherPrint.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let id: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `PT${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  id = (await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: '2026-01-05', documentDate: '2026-01-05', description: 'Chi văn phòng phẩm', autoPost: true, lines: [{ accountCode: '6422', debit: '1500000' }, { accountCode: '1111', credit: '1500000' }] } })).json().id;
});
afterAll(async () => { await ctx.close(); });

describe('in phiếu kế toán', () => {
  it('HTML có tên công ty, số chứng từ, số tiền định dạng Việt Nam, chữ ký', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${id}/print?format=html`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('PHIẾU KẾ TOÁN'); expect(r.body).toContain('PKT00001'); expect(r.body).toContain('1.500.000'); expect(r.body).toContain('Kế toán trưởng'); expect(r.body).toContain('6422');
  });
  it('PDF bắt đầu bằng %PDF', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${id}/print?format=pdf`, headers: { cookie } });
    expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toBe('application/pdf'); expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  }, 60_000);
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/api test -- test/attachments.test.ts test/voucherPrint.test.ts` → FAIL 404.

- [ ] **Step 3: Migration, đính kèm, in**

`packages/db/migrations/0008_dinh_kem.sql`:

```sql
SELECT audit_enable('voucher_attachment');
CREATE INDEX ON voucher_attachment (tenant_id, voucher_id);
```

`apps/api/src/config.ts`: thêm `ATTACHMENT_DIR: z.string().default('./attachments')`. `docker-compose.yml`: service `api` thêm `ATTACHMENT_DIR: /attachments` và volume `attachments:/attachments` (khai báo volume `attachments:`).

`apps/api/src/modules/ledger/attachments.ts`:

```ts
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../plugins/errors.js';

const routes: FastifyPluginAsyncZod = async (app) => {
  const dirOf = (tenantId: string, voucherId: string) => path.join(app.config.ATTACHMENT_DIR, tenantId, voucherId);

  app.post('/api/vouchers/:id/attachments', { preHandler: app.requirePermission('voucher.update'), schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    const file = await req.file(); if (!file) throw new AppError('NO_FILE', 'Thiếu tệp', 400);
    const buf = await file.toBuffer(); const tenantId = req.auth!.tenantId!;
    const row = await app.withTenant(req, async (trx) => {
      const v = await trx.selectFrom('voucher').select('id').where('id', '=', req.params.id).executeTakeFirst();
      if (!v) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ', 404);
      const r = await trx.insertInto('voucher_attachment').values({ tenant_id: tenantId, voucher_id: v.id, file_name: file.filename, mime: file.mimetype, bytes: buf.length, storage_key: '', uploaded_by: req.auth!.userId })
        .returning(['id', 'file_name', 'bytes']).executeTakeFirstOrThrow();
      const key = path.join(dirOf(tenantId, v.id), r.id);
      await mkdir(path.dirname(key), { recursive: true }); await writeFile(key, buf);
      await trx.updateTable('voucher_attachment').set({ storage_key: key }).where('id', '=', r.id).execute();
      return r;
    });
    return reply.status(201).send({ id: row.id, fileName: row.file_name, bytes: Number(row.bytes) });
  });

  app.get('/api/vouchers/:id/attachments', { preHandler: app.requirePermission('voucher.view'), schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) =>
    app.withTenant(req, (trx) => trx.selectFrom('voucher_attachment').select(['id', 'file_name as fileName', 'mime', 'bytes', 'uploaded_at as uploadedAt']).where('voucher_id', '=', req.params.id).orderBy('uploaded_at').execute()));

  app.get('/api/attachments/:attId', { preHandler: app.requirePermission('voucher.view'), schema: { params: z.object({ attId: z.string().uuid() }) } }, async (req, reply) => {
    const a = await app.withTenant(req, (trx) => trx.selectFrom('voucher_attachment').selectAll().where('id', '=', req.params.attId).executeTakeFirst());
    if (!a) throw new AppError('NOT_FOUND', 'Không có tệp', 404);
    reply.header('content-type', a.mime).header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.file_name)}`);
    return reply.send(createReadStream(a.storage_key));
  });

  app.delete('/api/attachments/:attId', { preHandler: app.requirePermission('voucher.update'), schema: { params: z.object({ attId: z.string().uuid() }) } }, async (req, reply) => {
    const a = await app.withTenant(req, (trx) => trx.deleteFrom('voucher_attachment').where('id', '=', req.params.attId).returning('storage_key').executeTakeFirst());
    if (!a) throw new AppError('NOT_FOUND', 'Không có tệp', 404);
    await unlink(a.storage_key).catch(() => undefined);
    return reply.status(204).send();
  });
};
export default routes;
```

`apps/api/src/modules/reporting/print/pdf.ts`:

```ts
import { chromium, type Browser } from 'playwright';

let browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  return browser;
}
export async function renderPdf(html: string, opts: { landscape?: boolean } = {}): Promise<Buffer> {
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, landscape: opts.landscape ?? false, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } }));
  } finally { await page.close(); }
}
export async function closePdfBrowser(): Promise<void> { await browser?.close(); browser = null; }
```

(Trong `apps/api/test/helpers.ts` `close()` gọi thêm `closePdfBrowser()`; `server.ts` gọi khi `SIGTERM`. Cài trình duyệt cho máy phát triển: `pnpm -F @kt/api exec playwright install chromium`.)

`apps/api/src/modules/reporting/print/voucherHtml.ts`:

```ts
import { formatVnDate, formatVnNumber } from '@kt/domain';
import type { VoucherDto } from '../../ledger/vouchers.service.js';

export interface CompanyInfo { name: string; address: string | null; taxCode: string | null; legalRep: string | null; chiefAccountant: string | null; formNo: string; issuedBy: string }
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const PRINT_CSS = `
  @page { size: A4; margin: 12mm; }
  body { font-family: "Times New Roman", "Liberation Serif", serif; font-size: 12pt; color: #000; }
  .head { display: flex; justify-content: space-between; font-size: 10pt; }
  .head b { display: block; }
  h1 { text-align: center; font-size: 16pt; margin: 12px 0 2px; text-transform: uppercase; }
  .sub { text-align: center; margin-bottom: 10px; }
  table.grid { width: 100%; border-collapse: collapse; }
  table.grid th, table.grid td { border: 1px solid #000; padding: 3px 5px; }
  table.grid th { text-align: center; font-weight: bold; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .sign { display: flex; justify-content: space-around; margin-top: 24px; text-align: center; font-size: 11pt; }
  .sign i { display: block; font-size: 10pt; }
  .sign .gap { height: 64px; }
  .pb { page-break-after: always; }
`;

export function printShell(title: string, body: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
}

export function renderVoucherHtml(v: VoucherDto, c: CompanyInfo): string {
  const rows = v.lines.map((l) => `<tr><td>${l.lineNo}</td><td>${esc(l.description ?? v.description)}</td><td>${esc(l.accountCode)}</td><td>${esc(l.partyCode ?? '')}</td>
      <td class="num">${formatVnNumber(l.debit)}</td><td class="num">${formatVnNumber(l.credit)}</td></tr>`).join('');
  const body = `
    <div class="head"><div><b>${esc(c.name)}</b>${esc(c.address ?? '')}<br>MST: ${esc(c.taxCode ?? '')}</div><div style="text-align:right"><b>Mẫu số ${esc(c.formNo)}</b>${esc(c.issuedBy)}</div></div>
    <h1>Phiếu kế toán</h1>
    <div class="sub">Ngày ${formatVnDate(v.postingDate)} &nbsp;&nbsp; Số: ${esc(v.voucherNo ?? '(chưa cấp số)')}</div>
    <p>Diễn giải: ${esc(v.description ?? '')}${v.partyName ? ` &nbsp;–&nbsp; Đối tượng: ${esc(v.partyName)}` : ''}</p>
    <table class="grid"><thead><tr><th>STT</th><th>Diễn giải</th><th>Tài khoản</th><th>Đối tượng</th><th class="num">Số tiền Nợ</th><th class="num">Số tiền Có</th></tr></thead>
    <tbody>${rows}<tr><td colspan="4"><b>Cộng</b></td><td class="num"><b>${formatVnNumber(v.totalDebit)}</b></td><td class="num"><b>${formatVnNumber(v.totalDebit)}</b></td></tr></tbody></table>
    <p>Kèm theo: ……… chứng từ gốc.</p>
    <div class="sign"><div><b>Người lập</b><i>(Ký, họ tên)</i><div class="gap"></div></div><div><b>Kế toán trưởng</b><i>(Ký, họ tên)</i><div class="gap"></div>${esc(c.chiefAccountant ?? '')}</div><div><b>Giám đốc</b><i>(Ký, họ tên, đóng dấu)</i><div class="gap"></div>${esc(c.legalRep ?? '')}</div></div>`;
  return printShell(`Phiếu kế toán ${v.voucherNo ?? ''}`, body);
}
```

Thêm vào `vouchers.routes.ts`:

```ts
import { renderPdf } from '../reporting/print/pdf.js';
import { renderVoucherHtml } from '../reporting/print/voucherHtml.js';
import { formNoFor } from '../reporting/print/forms.js';
// ...
app.get('/api/vouchers/:id/print', { preHandler: app.requirePermission('voucher.print'), schema: { params: idParam, querystring: z.object({ format: z.enum(['html', 'pdf']).default('html') }) } }, async (req, reply) => {
  const { v, c } = await app.withTenant(req, async (trx) => {
    const v = await S.getVoucher(trx, req.params.id);
    const t = await trx.selectFrom('tenant').selectAll().where('id', '=', req.auth!.tenantId!).executeTakeFirstOrThrow();
    const regime = (await trx.selectFrom('fiscal_period').select('regime').where('fiscal_year', '=', (await trx.selectFrom('voucher').select('fiscal_year').where('id', '=', v.id).executeTakeFirstOrThrow()).fiscal_year).executeTakeFirstOrThrow()).regime;
    const f = formNoFor(regime, 'PKT');
    return { v, c: { name: t.name, address: t.address, taxCode: t.tax_code, legalRep: t.legal_rep, chiefAccountant: t.chief_accountant, formNo: f.formNo, issuedBy: f.issuedBy } };
  });
  const html = renderVoucherHtml(v, c);
  if (req.query.format === 'html') return reply.type('text/html; charset=utf-8').send(html);
  return reply.type('application/pdf').header('content-disposition', `inline; filename="${v.voucherNo ?? 'phieu-ke-toan'}.pdf"`).send(await renderPdf(html));
});
```

`apps/api/src/modules/reporting/print/forms.ts` (bảng mẫu số theo chế độ, dùng lại ở Task 24):

```ts
export interface FormRef { formNo: string; issuedBy: string }
const ISSUED: Record<string, string> = {
  TT99: 'Ban hành theo Thông tư số 99/2025/TT-BTC ngày 27/10/2025 của Bộ Tài chính',
  TT133: 'Ban hành theo Thông tư số 133/2016/TT-BTC ngày 26/8/2016 của Bộ Tài chính',
  TT200: 'Ban hành theo Thông tư số 200/2014/TT-BTC ngày 22/12/2014 của Bộ Tài chính',
};
// Mẫu số theo phụ lục: DN = TT99/TT200, DNN = TT133. Phiếu kế toán không có mẫu bắt buộc: dùng số nội bộ "PKT".
// Các mã TT133 (S38/S20-DNN, S06/S04-DNN) phải đối chiếu lại với Phụ lục 4 TT 133/2016 trước khi phát hành; sửa bảng này là đủ, không sửa mã in.
const FORMS: Record<string, Record<string, string>> = {
  PKT: { TT99: 'PKT', TT133: 'PKT', TT200: 'PKT' },
  S03a: { TT99: 'S03a-DN', TT133: 'S03a-DNN', TT200: 'S03a-DN' },
  S03b: { TT99: 'S03b-DN', TT133: 'S03b-DNN', TT200: 'S03b-DN' },
  S38: { TT99: 'S38-DN', TT133: 'S20-DNN', TT200: 'S38-DN' },
  S06: { TT99: 'S06-DN', TT133: 'S06-DNN', TT200: 'S06-DN' },
  B01: { TT99: 'B01-DN', TT133: 'B01a-DNN', TT200: 'B01-DN' },
  B02: { TT99: 'B02-DN', TT133: 'B02-DNN', TT200: 'B02-DN' },
  B03: { TT99: 'B03-DN', TT133: 'B03-DNN', TT200: 'B03-DN' },
};
export function formNoFor(regime: string, key: string): FormRef {
  return { formNo: FORMS[key]?.[regime] ?? key, issuedBy: ISSUED[regime] ?? '' };
}
```

Đăng ký `attachmentRoutes` trong `app.ts`. Run: `pnpm -F @kt/api test -- test/attachments.test.ts test/voucherPrint.test.ts` → PASS 3.

- [ ] **Step 4: Trang web Phiếu kế toán**

`apps/web/src/lookups.ts`:

```ts
import type { LookupRow } from '@kt/ui';
import { api } from './api/client.js';

let cache: { regime: string; rows: LookupRow[] } | null = null;
export async function currentRegime(): Promise<string> {
  const years = await api<{ fiscalYear: number; regime: string }[]>('/api/fiscal-years');
  return years.at(-1)?.regime ?? 'TT99';
}
export async function accountFetcher(_catalog: string, q: string): Promise<LookupRow[]> {
  const regime = await currentRegime();
  if (!cache || cache.regime !== regime) {
    const rows = await api<{ id: number; code: string; name: string; isGroup: boolean; isActive: boolean }[]>(`/api/accounts?regime=${regime}`);
    cache = { regime, rows: rows.filter((a) => !a.isGroup && a.isActive).map((a) => ({ id: a.id, code: a.code, name: a.name })) };
  }
  const k = q.trim().toLowerCase();
  return cache.rows.filter((r) => !k || r.code.startsWith(k) || r.name.toLowerCase().includes(k)).slice(0, 50);
}
```

`apps/web/src/pages/VoucherList.tsx`:

```tsx
import { useEffect } from 'react';
import { Button, DatePicker, Input, Select, Space, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnDate, formatVnNumber } from '@kt/domain';
import { KeyboardGrid, useRememberedFilter } from '@kt/ui';
import { api } from '../api/client.js';

interface Row { id: string; voucherType: string; voucherNo: string | null; postingDate: string; state: string; description: string | null; partyName: string | null; totalDebit: string }
export const STATE_LABEL: Record<string, string> = { draft: 'Nháp', posted: 'Đã ghi sổ', reversed: 'Đã đảo', cancelled: 'Đã hủy' };
const STATE_COLOR: Record<string, string> = { draft: 'default', posted: 'green', reversed: 'orange', cancelled: 'red' };

export default function VoucherListPage() {
  const navigate = useNavigate();
  const [f, setF] = useRememberedFilter('vouchers:PKT', { from: dayjs().startOf('month').format('YYYY-MM-DD'), to: dayjs().endOf('month').format('YYYY-MM-DD'), state: '' as string, q: '' });
  const qs = new URLSearchParams({ type: 'PKT', from: f.from, to: f.to, size: '500', ...(f.state ? { state: f.state } : {}), ...(f.q ? { q: f.q } : {}) }).toString();
  const data = useQuery({ queryKey: ['vouchers', qs], queryFn: () => api<{ rows: Row[]; total: number }>(`/api/vouchers?${qs}`) });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Insert' && !(e.target as HTMLElement).closest('input')) void navigate({ to: '/chung-tu/phieu-ke-toan/$id', params: { id: 'moi' } }); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
  const columns: ColDef<Row>[] = [
    { field: 'postingDate', headerName: 'Ngày', width: 110, valueFormatter: (p) => formatVnDate(p.value as string) },
    { field: 'voucherNo', headerName: 'Số', width: 130, valueFormatter: (p) => (p.value as string | null) ?? '(nháp)' },
    { field: 'description', headerName: 'Diễn giải', flex: 1 }, { field: 'partyName', headerName: 'Đối tượng', width: 200 },
    { field: 'totalDebit', headerName: 'Số tiền', width: 140, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => formatVnNumber(p.value as string) },
    { field: 'state', headerName: 'Trạng thái', width: 120, cellRenderer: (p: { value: string }) => <Tag color={STATE_COLOR[p.value]}>{STATE_LABEL[p.value]}</Tag> },
  ];
  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <h2 style={{ margin: 0 }}>Phiếu kế toán</h2>
        <DatePicker.RangePicker format="DD/MM/YYYY" value={[dayjs(f.from), dayjs(f.to)]} onChange={(r) => r && setF({ ...f, from: r[0]!.format('YYYY-MM-DD'), to: r[1]!.format('YYYY-MM-DD') })} />
        <Select style={{ width: 140 }} value={f.state} onChange={(state) => setF({ ...f, state })} options={[{ value: '', label: 'Mọi trạng thái' }, ...Object.entries(STATE_LABEL).map(([value, label]) => ({ value, label }))]} />
        <Input.Search placeholder="Số, diễn giải, đối tượng" defaultValue={f.q} onSearch={(q) => setF({ ...f, q })} style={{ width: 260 }} allowClear />
        <Button type="primary" onClick={() => void navigate({ to: '/chung-tu/phieu-ke-toan/$id', params: { id: 'moi' } })}>Thêm (Insert)</Button>
        <span>{data.data?.total ?? 0} chứng từ</span>
      </Space>
      <KeyboardGrid<Row> rows={data.data?.rows ?? []} columns={columns.map((c) => ({ ...c, editable: false, onCellDoubleClicked: (e) => void navigate({ to: '/chung-tu/phieu-ke-toan/$id', params: { id: (e.data as Row).id } }) }))}
        onRowsChange={() => undefined} addRowTemplate={() => ({} as Row)} readOnly height="calc(100vh - 180px)" />
    </>
  );
}
```

`apps/web/src/pages/Voucher.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, DatePicker, Form, Input, Modal, Row, Space, Tag, Upload, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import type { ColDef } from 'ag-grid-community';
import dayjs from 'dayjs';
import { formatVnNumber, isBalanced, parseVnNumber, sum } from '@kt/domain';
import { KeyboardGrid, LookupSelect } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcher } from '../lookups.js';
import { STATE_LABEL } from './VoucherList.js';

export interface Line { lineNo?: number; accountCode: string; accountName?: string; description: string | null; debit: string; credit: string; partyCode: string | null; departmentCode: string | null; projectCode: string | null; costItemCode: string | null }
interface Voucher { id: string; voucherType: string; voucherNo: string | null; postingDate: string; documentDate: string; state: string; description: string | null; partyCode: string | null; currencyCode: string; version: number; totalDebit: string; lines: Line[] }
export const emptyLine = (): Line => ({ accountCode: '', description: null, debit: '0', credit: '0', partyCode: null, departmentCode: null, projectCode: null, costItemCode: null });
export const totals = (lines: Line[]) => ({ debit: sum(lines.map((l) => l.debit || '0')).toString(), credit: sum(lines.map((l) => l.credit || '0')).toString() });
export const cleanLines = (lines: Line[]) => lines.filter((l) => l.accountCode.trim() !== '').map(({ accountName: _n, lineNo: _l, ...rest }) => ({ ...rest, debit: rest.debit || '0', credit: rest.credit || '0' }));

const numCol = (field: 'debit' | 'credit', headerName: string): ColDef<Line> => ({ field, headerName, width: 150, cellClass: 'ag-right-aligned-cell',
  valueFormatter: (p) => formatVnNumber((p.value as string) || '0'), valueParser: (p) => parseVnNumber(String(p.newValue ?? '')) ?? '0' });

export default function VoucherPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const isNew = id === 'moi';
  const navigate = useNavigate(); const qc = useQueryClient(); const { can } = useAuth();
  const [form] = Form.useForm();
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [lookup, setLookup] = useState<{ col: string; row: number } | null>(null);
  const v = useQuery({ queryKey: ['voucher', id], queryFn: () => api<Voucher>(`/api/vouchers/${id}`), enabled: !isNew });
  useEffect(() => { if (v.data) { form.setFieldsValue({ ...v.data, postingDate: dayjs(v.data.postingDate), documentDate: dayjs(v.data.documentDate) }); setLines([...v.data.lines, emptyLine()]); } }, [v.data, form]);
  const state = v.data?.state ?? 'draft'; const editable = state === 'draft';
  const t = totals(lines); const balanced = isBalanced(cleanLines(lines));

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['voucher', id] }); void qc.invalidateQueries({ queryKey: ['vouchers'] }); };
  const onErr = (e: unknown) => void message.error(e instanceof ApiError ? `${e.message} (${e.code})` : String(e));
  const save = useMutation({
    mutationFn: async () => {
      const f = await form.validateFields();
      const body = { voucherType: 'PKT', postingDate: f.postingDate.format('YYYY-MM-DD'), documentDate: f.documentDate.format('YYYY-MM-DD'), description: f.description ?? null, partyCode: f.partyCode ?? null, currencyCode: 'VND', lines: cleanLines(lines) };
      if (isNew) return api<Voucher>('/api/vouchers', { method: 'POST', json: body });
      if (editable) return api<Voucher>(`/api/vouchers/${id}`, { method: 'PUT', json: { ...body, version: v.data!.version } });
      return api<Voucher>(`/api/vouchers/${id}`, { method: 'PUT', json: { version: v.data!.version, description: f.description ?? null, lines: cleanLines(lines).map((l, i) => ({ lineNo: i + 1, description: l.description, departmentCode: l.departmentCode, projectCode: l.projectCode, costItemCode: l.costItemCode })) } });
    },
    onSuccess: (r) => { void message.success('Đã lưu'); if (isNew) void navigate({ to: '/chung-tu/phieu-ke-toan/$id', params: { id: r.id } }); else invalidate(); }, onError: onErr });
  const action = useMutation({ mutationFn: (p: { act: string; body?: object }) => api<Voucher>(`/api/vouchers/${id}/${p.act}`, { method: 'POST', json: p.body ?? {} }),
    onSuccess: (r, p) => { void message.success({ post: 'Đã ghi sổ', unpost: 'Đã bỏ ghi sổ', reverse: `Đã tạo chứng từ đảo ${r.voucherNo}`, discard: 'Đã hủy', duplicate: 'Đã nhân bản' }[p.act] ?? 'Xong');
      if (p.act === 'reverse' || p.act === 'duplicate') void navigate({ to: '/chung-tu/phieu-ke-toan/$id', params: { id: r.id } }); else invalidate(); }, onError: onErr });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); save.mutate(); }
      if (e.key === 'F9' && !isNew && editable && can('voucher.post')) { e.preventDefault(); action.mutate({ act: 'post' }); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [save, action, isNew, editable, can]);

  const columns = useMemo<ColDef<Line>[]>(() => [
    { field: 'accountCode', headerName: 'TK (F4)', width: 110 }, { field: 'description', headerName: 'Diễn giải', flex: 1 },
    numCol('debit', 'Nợ'), numCol('credit', 'Có'),
    { field: 'partyCode', headerName: 'Đối tượng (F4)', width: 130 }, { field: 'departmentCode', headerName: 'Bộ phận', width: 100 },
    { field: 'projectCode', headerName: 'Vụ việc', width: 100 }, { field: 'costItemCode', headerName: 'Khoản mục', width: 110 },
  ], []);
  const onLookup = useCallback((col: string, row: number) => { if (['accountCode', 'partyCode', 'departmentCode', 'projectCode', 'costItemCode'].includes(col)) setLookup({ col, row }); }, []);
  const lookupCatalog: Record<string, string> = { accountCode: 'account', partyCode: 'party', departmentCode: 'department', projectCode: 'project', costItemCode: 'cost_item' };

  return (
    <Card title={<Space><span>Phiếu kế toán {v.data?.voucherNo ?? (isNew ? '(mới)' : '(chưa cấp số)')}</span><Tag>{STATE_LABEL[state]}</Tag></Space>}
      extra={<Space>
        <Button onClick={() => save.mutate()} type="primary" loading={save.isPending}>Lưu (Ctrl+S)</Button>
        {!isNew && editable && can('voucher.post') && <Button onClick={() => action.mutate({ act: 'post' })} disabled={!balanced}>Ghi sổ (F9)</Button>}
        {!isNew && state === 'posted' && can('voucher.unpost') && <Button onClick={() => action.mutate({ act: 'unpost' })}>Bỏ ghi sổ</Button>}
        {!isNew && state === 'posted' && can('voucher.post') && <Button onClick={() => Modal.confirm({ title: 'Lập chứng từ đảo?', content: 'Chứng từ đảo ghi sổ ngay với ngày hôm nay.', onOk: () => action.mutate({ act: 'reverse', body: { postingDate: dayjs().format('YYYY-MM-DD') } }) })}>Đảo</Button>}
        {!isNew && editable && can('voucher.delete') && <Button danger onClick={() => Modal.confirm({ title: 'Hủy chứng từ?', content: 'Số chứng từ (nếu có) được giữ lại.', onOk: () => action.mutate({ act: 'discard' }) })}>Hủy</Button>}
        {!isNew && <Button onClick={() => action.mutate({ act: 'duplicate', body: { postingDate: dayjs().format('YYYY-MM-DD') } })}>Nhân bản</Button>}
        {!isNew && can('voucher.print') && <Button href={`/api/vouchers/${id}/print?format=pdf`} target="_blank">In</Button>}
      </Space>}>
      <Form form={form} layout="vertical" initialValues={{ postingDate: dayjs(), documentDate: dayjs() }}>
        <Row gutter={12}>
          <Col span={4}><Form.Item label="Ngày hạch toán" name="postingDate" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" disabled={!editable} /></Form.Item></Col>
          <Col span={4}><Form.Item label="Ngày chứng từ" name="documentDate" rules={[{ required: true }]}><DatePicker format="DD/MM/YYYY" disabled={!editable} /></Form.Item></Col>
          <Col span={6}><Form.Item label="Đối tượng" name="partyCode"><LookupSelect catalog="party" disabled={!editable} quickAddFields={[{ key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }]} /></Form.Item></Col>
          <Col span={10}><Form.Item label="Diễn giải" name="description"><Input /></Form.Item></Col>
        </Row>
      </Form>
      <KeyboardGrid<Line> rows={lines} columns={columns.map((c) => ({ ...c, editable: editable || ['description', 'departmentCode', 'projectCode', 'costItemCode'].includes(c.field as string) }))}
        onRowsChange={setLines} addRowTemplate={emptyLine} onLookup={onLookup} height={360} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 8 }}>
        <b>Tổng Nợ: {formatVnNumber(t.debit)}</b><b>Tổng Có: {formatVnNumber(t.credit)}</b>
        {!balanced && <Tag color="red">Chênh lệch {formatVnNumber(sum([t.debit, `-${t.credit}`]).toString())}</Tag>}
      </div>
      {!isNew && <Attachments voucherId={id} canEdit={can('voucher.update')} />}
      <Modal open={!!lookup} onCancel={() => setLookup(null)} footer={null} title="Chọn từ danh mục" destroyOnClose>
        {lookup && <LookupSelect autoFocus open catalog={lookupCatalog[lookup.col]!} fetcher={lookup.col === 'accountCode' ? accountFetcher : undefined} style={{ width: '100%' }}
          quickAddFields={lookup.col === 'accountCode' ? undefined : [{ key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }]}
          onChange={(code) => { const copy = [...lines]; copy[lookup.row] = { ...copy[lookup.row]!, [lookup.col]: code }; setLines(copy); setLookup(null); }} />}
      </Modal>
    </Card>
  );
}

function Attachments({ voucherId, canEdit }: { voucherId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['attachments', voucherId], queryFn: () => api<{ id: string; fileName: string; bytes: number }[]>(`/api/vouchers/${voucherId}/attachments`) });
  return (
    <div style={{ marginTop: 16 }}>
      <Space wrap>
        <b>Đính kèm:</b>
        {(list.data ?? []).map((a) => <span key={a.id}><a href={`/api/attachments/${a.id}`}>{a.fileName}</a> ({Math.ceil(a.bytes / 1024)} KB){canEdit && <a style={{ marginLeft: 4 }} onClick={() => void api(`/api/attachments/${a.id}`, { method: 'DELETE' }).then(() => qc.invalidateQueries({ queryKey: ['attachments', voucherId] }))}>✕</a>}</span>)}
        {canEdit && <Upload showUploadList={false} customRequest={async ({ file, onSuccess, onError }) => { const fd = new FormData(); fd.append('file', file as File);
          const r = await fetch(`/api/vouchers/${voucherId}/attachments`, { method: 'POST', body: fd, credentials: 'include' });
          if (r.ok) { onSuccess?.(await r.json()); void qc.invalidateQueries({ queryKey: ['attachments', voucherId] }); } else onError?.(new Error(await r.text())); }}><Button size="small">Thêm tệp</Button></Upload>}
      </Space>
    </div>
  );
}
```

Thêm route `/chung-tu/phieu-ke-toan` và `/chung-tu/phieu-ke-toan/$id` vào `router.tsx`; nhóm menu "Chứng từ" `{ key: 'chungtu', label: 'Chứng từ', to: '/chung-tu', children: [{ key: 'pkt', label: 'Phiếu kế toán', to: '/chung-tu/phieu-ke-toan', permission: 'voucher.view' }] }`.

`apps/web/test/Voucher.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { cleanLines, emptyLine, totals } from '../src/pages/Voucher.js';

describe('Phiếu kế toán: tổng và làm sạch dòng', () => {
  it('bỏ dòng trống, tính tổng Nợ/Có', () => {
    const lines = [{ ...emptyLine(), accountCode: '6422', debit: '1500000' }, { ...emptyLine(), accountCode: '1111', credit: '1500000' }, emptyLine()];
    expect(cleanLines(lines)).toHaveLength(2);
    expect(totals(lines)).toEqual({ debit: '1500000', credit: '1500000' });
  });
});
```

Run: `pnpm -F @kt/web test && pnpm -F @kt/web typecheck` → PASS.

- [ ] **Step 5: Playwright E2E luồng nhập bằng bàn phím**

`apps/web/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 60_000, retries: process.env.CI ? 1 : 0,
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173', locale: 'vi-VN', trace: 'retain-on-failure' },
  webServer: process.env.E2E_BASE_URL ? undefined : [
    { command: 'pnpm -F @kt/api dev', port: 3000, reuseExistingServer: true, cwd: '../..' },
    { command: 'pnpm -F @kt/web dev', port: 5173, reuseExistingServer: true, cwd: '../..' },
  ],
});
```

`apps/web/e2e/phieu-ke-toan.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"
test('nhập phiếu kế toán hoàn toàn bằng bàn phím rồi ghi sổ', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } });
  expect(login.ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();

  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await page.goto('/chung-tu/phieu-ke-toan');
  await page.keyboard.press('Insert');
  await expect(page.getByText('Phiếu kế toán (mới)')).toBeVisible();
  await page.getByLabel('Ngày hạch toán').fill('15/01/2026'); await page.keyboard.press('Enter');
  await page.getByLabel('Diễn giải').fill('Chi văn phòng phẩm tháng 1');

  const firstCell = page.locator('.ag-center-cols-container .ag-row[row-index="0"] [col-id="accountCode"]');
  await firstCell.click(); await page.keyboard.type('6422'); await page.keyboard.press('Enter');
  await page.keyboard.type('Giấy A4'); await page.keyboard.press('Enter');
  await page.keyboard.type('1500000'); await page.keyboard.press('Enter'); // Nợ
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); // Có, đối tượng, bộ phận, vụ việc, khoản mục -> sang dòng 2
  await page.keyboard.type('1111'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); // TK, diễn giải, Nợ
  await page.keyboard.type('1500000'); await page.keyboard.press('Enter'); // Có
  await expect(page.getByText('Tổng Nợ: 1.500.000')).toBeVisible();
  await expect(page.getByText('Tổng Có: 1.500.000')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Đã lưu')).toBeVisible();
  await expect(page).toHaveURL(/phieu-ke-toan\/[0-9a-f-]{36}$/);
  await page.keyboard.press('F9');
  await expect(page.getByText('Đã ghi sổ')).toBeVisible();
  await expect(page.locator('.ant-card-head-title')).toContainText(/PKT\d+/);
});
```

CI: thêm job `e2e` vào `.github/workflows/ci.yml` (sau `test`, cùng service postgres): các bước giống job `test` đến `pnpm db:migrate`, rồi `pnpm -F @kt/web exec playwright install --with-deps chromium`, `pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"`, `pnpm -F @kt/web e2e`; upload `apps/web/playwright-report` khi thất bại (`actions/upload-artifact@v4`, `if: failure()`).

Run cục bộ: `pnpm -F @kt/web exec playwright install chromium && pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E" && pnpm -F @kt/web e2e`
Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
git add packages/db apps/api apps/web .github docker-compose.yml
git commit -m "feat(web): màn hình Phiếu kế toán nhập bằng bàn phím, đính kèm, in PDF và kiểm thử Playwright"
```

---

### Task 19: Số dư đầu kỳ (kỳ 0): bảng nhập, kiểm tra, ghi sổ chứng từ `DK`, nhập Excel, màn hình

**Files:**
- Create: `packages/db/migrations/0009_so_du_dau_ky.sql`
- Modify: `packages/db/src/types.ts` (bảng `opening_balance`)
- Create: `apps/api/src/modules/ledger/openingBalance.ts`; Modify: `apps/api/src/app.ts`
- Create: `apps/web/src/pages/OpeningBalance.tsx`; Modify: `apps/web/src/router.tsx`
- Test: `apps/api/test/openingBalance.test.ts`

**Interfaces:**
- Consumes: `post_voucher`, `unpost_voucher` (Task 15); `fn_period_of(..., true)` cho kỳ 0 (Task 14); `buildTemplate`-style Excel (Task 9, viết riêng vì cột cố định).
- Produces:
  - Bảng `opening_balance(id, tenant_id, fiscal_year, account_id, party_id, currency_code, debit, credit, debit_currency, credit_currency)` với unique index `(tenant_id, fiscal_year, account_id, coalesce(party_id, '00000000-0000-0000-0000-000000000000'), currency_code)`, CHECK một bên.
  - `OpeningRow = { accountCode; partyCode: string | null; currencyCode: string; debit: string; credit: string; debitCurrency: string; creditCurrency: string }`.
  - Service: `listOpening(trx, year): Promise<(OpeningRow & { id; accountName; partyName })[]>`; `replaceOpening(trx, tenantId, year, rows: OpeningRow[]): Promise<number>`; `checkOpening(trx, year): Promise<OpeningIssue[]>` với `OpeningIssue = { code: 'UNBALANCED'|'ACCOUNT_GROUP'|'WRONG_SIDE'|'PARTY_REQUIRED'|'PARTY_NOT_ALLOWED'|'CURRENCY_NOT_TRACKED'|'ACCOUNT_PNL'; message; accountCode?; partyCode? }`; `postOpening(trx, ctx, year): Promise<VoucherDto>` (tạo/ghi lại chứng từ `DK` ngày `fiscal_period.period_no = 0`, lỗi `OPENING_INVALID` kèm `details` khi còn `issues`).
  - Route (quyền `opening_balance.*`): `GET /api/opening-balance/:year`; `PUT /api/opening-balance/:year { rows }`; `GET /api/opening-balance/:year/check`; `POST /api/opening-balance/:year/post`; `GET /api/opening-balance/template.xlsx`; `POST /api/opening-balance/:year/import?mode=validate|commit`.

- [ ] **Step 1: Viết test (thất bại)**

`apps/api/test/openingBalance.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
const put = (rows: object[]) => ctx.app.inject({ method: 'PUT', url: '/api/opening-balance/2026', headers: { cookie }, payload: { rows } });
const R = (accountCode: string, debit = '0', credit = '0', partyCode: string | null = null) => ({ accountCode, partyCode, currencyCode: 'VND', debit, credit, debitCurrency: '0', creditCurrency: '0' });

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `OB${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  for (const [code, name] of [['KH001', 'Khách 1'], ['KH002', 'Khách 2']]) await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code, name, is_customer: true } });
});
afterAll(async () => { await ctx.close(); });

describe('số dư đầu kỳ', () => {
  it('kiểm tra báo lệch, tài khoản tổng hợp, sai loại dư, thiếu đối tượng, tài khoản loại 5–9', async () => {
    await put([R('1111', '100000000'), R('111', '1'), R('331', '5', '0', null), R('5113', '0', '7'), R('1121', '0', '1'), R('4111', '0', '90000000')]);
    const c = await ctx.app.inject({ method: 'GET', url: '/api/opening-balance/2026/check', headers: { cookie } });
    const codes = (c.json() as { code: string }[]).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['UNBALANCED', 'ACCOUNT_GROUP', 'PARTY_REQUIRED', 'ACCOUNT_PNL', 'WRONG_SIDE']));
    const p = await ctx.app.inject({ method: 'POST', url: '/api/opening-balance/2026/post', headers: { cookie } });
    expect(p.statusCode).toBe(409); expect(p.json().error.code).toBe('OPENING_INVALID');
  });

  it('ghi sổ tạo chứng từ DK ở kỳ 0; 131 lưỡng tính theo đối tượng; ghi lại thay thế chứng từ cũ', async () => {
    await put([R('1111', '100000000'), R('1121', '400000000'), R('131', '30000000', '0', 'KH001'), R('131', '0', '10000000', 'KH002'), R('4111', '0', '520000000')]);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/opening-balance/2026/check', headers: { cookie } })).json()).toEqual([]);
    const p = await ctx.app.inject({ method: 'POST', url: '/api/opening-balance/2026/post', headers: { cookie } });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toMatchObject({ voucherType: 'DK', state: 'posted', postingDate: '2025-12-31', totalDebit: '530000000' });
    expect(p.json().lines).toHaveLength(5);
    await put([R('1111', '120000000'), R('1121', '400000000'), R('131', '30000000', '0', 'KH001'), R('131', '0', '10000000', 'KH002'), R('4111', '0', '540000000')]);
    const p2 = await ctx.app.inject({ method: 'POST', url: '/api/opening-balance/2026/post', headers: { cookie } });
    expect(p2.json()).toMatchObject({ id: p.json().id, voucherNo: p.json().voucherNo, totalDebit: '550000000' });
    const n = await sql<{ n: string }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'DK' AND state <> 'cancelled'`.execute(ctx.t.admin);
    expect(n.rows[0]!.n).toBe('1');
    const period0 = await sql<{ period_no: number; fiscal_year: number }>`SELECT period_no, fiscal_year FROM voucher WHERE id = ${p.json().id}::uuid`.execute(ctx.t.admin);
    expect(period0.rows[0]).toEqual({ period_no: 0, fiscal_year: 2026 });
  });

  it('nhập Excel số dư đầu kỳ báo lỗi theo dòng và ghi khi hợp lệ', async () => {
    const ExcelJS = (await import('exceljs')).default; const FormData = (await import('form-data')).default;
    const tpl = await ctx.app.inject({ method: 'GET', url: '/api/opening-balance/template.xlsx', headers: { cookie } });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(tpl.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Du_lieu')!; ws.spliceRows(3, 1);
    ws.addRow(['1111', null, 'VND', 50000000, 0, 0, 0]); ws.addRow(['4111', null, 'VND', 0, 50000000, 0, 0]); ws.addRow(['9999', null, 'VND', 1, 0, 0, 0]);
    const send = async (mode: string) => { const fd = new FormData(); fd.append('file', Buffer.from(await wb.xlsx.writeBuffer()), { filename: 'sd.xlsx' });
      return ctx.app.inject({ method: 'POST', url: `/api/opening-balance/2026/import?mode=${mode}`, headers: { cookie, ...fd.getHeaders() }, payload: fd.getBuffer() }); };
    const v = await send('validate'); expect(v.json().errors).toEqual([{ row: 5, column: 'account_code', message: expect.stringContaining('9999') }]);
    ws.spliceRows(5, 1);
    const c = await send('commit'); expect(c.json()).toMatchObject({ inserted: 2 });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/opening-balance/2026', headers: { cookie } })).json()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/api test -- test/openingBalance.test.ts` → FAIL 404.

- [ ] **Step 3: Migration và service**

`packages/db/migrations/0009_so_du_dau_ky.sql`:

```sql
CREATE TABLE opening_balance (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  fiscal_year int NOT NULL, account_id bigint NOT NULL REFERENCES account(id), party_id uuid REFERENCES party(id),
  currency_code char(3) NOT NULL DEFAULT 'VND',
  debit numeric(20,0) NOT NULL DEFAULT 0 CHECK (debit >= 0), credit numeric(20,0) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  debit_currency numeric(20,4) NOT NULL DEFAULT 0, credit_currency numeric(20,4) NOT NULL DEFAULT 0,
  CONSTRAINT ob_one_side CHECK (debit = 0 OR credit = 0));
CREATE UNIQUE INDEX opening_balance_key ON opening_balance (tenant_id, fiscal_year, account_id, coalesce(party_id, '00000000-0000-0000-0000-000000000000'::uuid), currency_code);
SELECT rls_enable('opening_balance'), audit_enable('opening_balance');
```

`apps/api/src/modules/ledger/openingBalance.ts`:

```ts
import ExcelJS from 'exceljs';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, sum } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getVoucher, postVoucher, unpostVoucher, type VoucherDto } from './vouchers.service.js';

const money = z.string().regex(/^\d+(\.\d{1,4})?$/);
export const openingRow = z.object({ accountCode: z.string().min(1), partyCode: z.string().nullable().default(null), currencyCode: z.string().length(3).default('VND'),
  debit: money.default('0'), credit: money.default('0'), debitCurrency: money.default('0'), creditCurrency: money.default('0') });
export type OpeningRow = z.infer<typeof openingRow>;
export interface OpeningIssue { code: 'UNBALANCED' | 'ACCOUNT_GROUP' | 'WRONG_SIDE' | 'PARTY_REQUIRED' | 'PARTY_NOT_ALLOWED' | 'CURRENCY_NOT_TRACKED' | 'ACCOUNT_PNL' | 'BOTH_SIDES'; message: string; accountCode?: string; partyCode?: string | null }
type Trx = Transaction<Database>;

export async function listOpening(trx: Trx, year: number) {
  return trx.selectFrom('opening_balance as o').innerJoin('account as a', 'a.id', 'o.account_id').leftJoin('party as p', 'p.id', 'o.party_id')
    .select(['o.id', 'a.code as accountCode', 'a.name as accountName', 'p.code as partyCode', 'p.name as partyName', 'o.currency_code as currencyCode', 'o.debit', 'o.credit', 'o.debit_currency as debitCurrency', 'o.credit_currency as creditCurrency'])
    .where('o.fiscal_year', '=', year).orderBy('a.code').orderBy('p.code').execute();
}

export async function replaceOpening(trx: Trx, tenantId: string, year: number, rows: OpeningRow[]): Promise<number> {
  await trx.deleteFrom('opening_balance').where('fiscal_year', '=', year).execute();
  for (const r of rows) {
    const acc = await trx.selectFrom('account').select('id').where('code', '=', r.accountCode).executeTakeFirst();
    if (!acc) throw new AppError('LOOKUP_NOT_FOUND', `Không có tài khoản ${r.accountCode}`, 409);
    const party = r.partyCode ? await trx.selectFrom('party').select('id').where('code', '=', r.partyCode).executeTakeFirst() : null;
    if (r.partyCode && !party) throw new AppError('LOOKUP_NOT_FOUND', `Không có đối tượng ${r.partyCode}`, 409);
    await trx.insertInto('opening_balance').values({ tenant_id: tenantId, fiscal_year: year, account_id: acc.id, party_id: party?.id ?? null, currency_code: r.currencyCode,
      debit: r.debit, credit: r.credit, debit_currency: r.debitCurrency, credit_currency: r.creditCurrency }).execute();
  }
  return rows.length;
}

export async function checkOpening(trx: Trx, year: number): Promise<OpeningIssue[]> {
  const rows = await trx.selectFrom('opening_balance as o').innerJoin('account as a', 'a.id', 'o.account_id').leftJoin('party as p', 'p.id', 'o.party_id')
    .select(['a.code', 'a.is_group', 'a.normal_balance', 'a.subledger_kind', 'a.track_currency', 'a.root_type', 'p.code as party_code', 'o.currency_code', 'o.debit', 'o.credit']).where('o.fiscal_year', '=', year).execute();
  const issues: OpeningIssue[] = [];
  for (const r of rows) {
    const base = { accountCode: r.code, partyCode: r.party_code };
    if (r.is_group) issues.push({ code: 'ACCOUNT_GROUP', message: `Tài khoản ${r.code} là tài khoản tổng hợp`, ...base });
    if (['income', 'expense'].includes(r.root_type)) issues.push({ code: 'ACCOUNT_PNL', message: `Tài khoản ${r.code} loại 5–9 không có số dư đầu kỳ`, ...base });
    if (r.normal_balance === 'debit' && D(r.credit).gt(0)) issues.push({ code: 'WRONG_SIDE', message: `Tài khoản ${r.code} chỉ có số dư Nợ`, ...base });
    if (r.normal_balance === 'credit' && D(r.debit).gt(0)) issues.push({ code: 'WRONG_SIDE', message: `Tài khoản ${r.code} chỉ có số dư Có`, ...base });
    if (['receivable', 'payable'].includes(r.subledger_kind ?? '') && !r.party_code) issues.push({ code: 'PARTY_REQUIRED', message: `Tài khoản ${r.code} phải nhập chi tiết theo đối tượng`, ...base });
    if (!['receivable', 'payable'].includes(r.subledger_kind ?? '') && r.party_code) issues.push({ code: 'PARTY_NOT_ALLOWED', message: `Tài khoản ${r.code} không theo dõi đối tượng`, ...base });
    if (r.currency_code !== 'VND' && !r.track_currency) issues.push({ code: 'CURRENCY_NOT_TRACKED', message: `Tài khoản ${r.code} không theo dõi ngoại tệ`, ...base });
  }
  const d = sum(rows.map((r) => r.debit)); const c = sum(rows.map((r) => r.credit));
  if (!d.equals(c)) issues.push({ code: 'UNBALANCED', message: `Tổng dư Nợ ${d.toString()} khác tổng dư Có ${c.toString()}` });
  return issues;
}

export async function postOpening(trx: Trx, ctx: { tenantId: string; userId: string }, year: number): Promise<VoucherDto> {
  const issues = await checkOpening(trx, year);
  if (issues.length) throw new AppError('OPENING_INVALID', 'Số dư đầu kỳ chưa hợp lệ', 409, issues);
  const p0 = await trx.selectFrom('fiscal_period').select('date_from').where('fiscal_year', '=', year).where('period_no', '=', 0).executeTakeFirst();
  if (!p0) throw new AppError('PERIOD_NOT_FOUND', `Chưa có năm tài chính ${year}`, 404);
  let v = await trx.selectFrom('voucher').select(['id', 'state']).where('voucher_type', '=', 'DK').where('fiscal_year', '=', year).where('state', 'in', ['draft', 'posted']).executeTakeFirst();
  if (v?.state === 'posted') { await unpostVoucher(trx, v.id); }
  if (v) await trx.deleteFrom('voucher_line').where('voucher_id', '=', v.id).execute();
  else v = await trx.insertInto('voucher').values({ tenant_id: ctx.tenantId, voucher_type: 'DK', posting_date: p0.date_from, document_date: p0.date_from, description: `Số dư đầu kỳ năm ${year}`, currency_code: 'VND',
    source_doc_type: 'opening_balance', created_by: ctx.userId }).returning(['id', 'state']).executeTakeFirstOrThrow();
  const rows = await trx.selectFrom('opening_balance').selectAll().where('fiscal_year', '=', year).execute();
  let n = 0;
  for (const r of rows) {
    const debit = D(r.debit).gt(0);
    await trx.insertInto('voucher_line').values({ tenant_id: ctx.tenantId, voucher_id: v.id, line_no: ++n, account_id: r.account_id, posting_date: p0.date_from, currency_code: r.currency_code,
      debit: r.debit, credit: r.credit, amount_currency: r.currency_code === 'VND' ? D(r.debit).minus(r.credit).toString() : (debit ? r.debit_currency : D(r.credit_currency).neg().toString()),
      party_id: r.party_id, description: 'Số dư đầu kỳ' }).execute();
  }
  await postVoucher(trx, v.id);
  return getVoucher(trx, v.id);
}

const COLS = [['account_code', 'Số hiệu TK (*)'], ['party_code', 'Mã đối tượng'], ['currency_code', 'Loại tiền (*)'], ['debit', 'Dư Nợ'], ['credit', 'Dư Có'], ['debit_currency', 'Dư Nợ nguyên tệ'], ['credit_currency', 'Dư Có nguyên tệ']] as const;
export async function openingTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Du_lieu');
  ws.addRow(COLS.map((c) => c[1])); ws.addRow(COLS.map((c) => c[0])); ws.getRow(2).hidden = true; ws.addRow(['VI_DU', '', 'VND', 0, 0, 0, 0]); ws.getRow(1).font = { bold: true };
  const hd = wb.addWorksheet('Huong_dan'); hd.addRow(['Mỗi dòng một tài khoản chi tiết (và một đối tượng với TK công nợ). Chỉ nhập một bên Nợ hoặc Có. Tổng dư Nợ phải bằng tổng dư Có.']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
export async function parseOpeningWorkbook(trx: Trx, buffer: Buffer): Promise<{ rows: OpeningRow[]; errors: { row: number; column: string; message: string }[] }> {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Du_lieu') ?? wb.worksheets[0]!;
  const rows: OpeningRow[] = []; const errors: { row: number; column: string; message: string }[] = [];
  const accounts = new Set((await trx.selectFrom('account').select('code').execute()).map((a) => a.code));
  const parties = new Set((await trx.selectFrom('party').select('code').execute()).map((p) => p.code));
  const num = (v: ExcelJS.CellValue) => (v === null || v === undefined || v === '' ? '0' : String(typeof v === 'object' && 'result' in (v as object) ? (v as { result: unknown }).result : v).replace(/[\s.]/g, '').replace(',', '.'));
  ws.eachRow((row, i) => {
    if (i <= 2 || (i === 3 && row.getCell(1).value === 'VI_DU')) return;
    const obj = { accountCode: String(row.getCell(1).value ?? '').trim(), partyCode: String(row.getCell(2).value ?? '').trim() || null, currencyCode: String(row.getCell(3).value ?? 'VND').trim() || 'VND',
      debit: num(row.getCell(4).value), credit: num(row.getCell(5).value), debitCurrency: num(row.getCell(6).value), creditCurrency: num(row.getCell(7).value) };
    const parsed = openingRow.safeParse(obj);
    if (!parsed.success) { for (const is of parsed.error.issues) errors.push({ row: i, column: String(is.path[0]), message: is.message }); return; }
    if (!accounts.has(parsed.data.accountCode)) { errors.push({ row: i, column: 'account_code', message: `Không có tài khoản ${parsed.data.accountCode}` }); return; }
    if (parsed.data.partyCode && !parties.has(parsed.data.partyCode)) { errors.push({ row: i, column: 'party_code', message: `Không có đối tượng ${parsed.data.partyCode}` }); return; }
    rows.push(parsed.data);
  });
  return { rows, errors };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const yearParam = z.object({ year: z.coerce.number().int() });
  app.get('/api/opening-balance/template.xlsx', { preHandler: app.requirePermission('opening_balance.view') }, async (_req, reply) =>
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', 'attachment; filename="mau_so_du_dau_ky.xlsx"').send(await openingTemplate()));
  app.get('/api/opening-balance/:year', { preHandler: app.requirePermission('opening_balance.view'), schema: { params: yearParam } }, async (req) => app.withTenant(req, (trx) => listOpening(trx, req.params.year)));
  app.put('/api/opening-balance/:year', { preHandler: app.requirePermission('opening_balance.update'), schema: { params: yearParam, body: z.object({ rows: z.array(openingRow) }) } }, async (req) =>
    ({ count: await app.withTenant(req, (trx) => replaceOpening(trx, req.auth!.tenantId!, req.params.year, req.body.rows)) }));
  app.get('/api/opening-balance/:year/check', { preHandler: app.requirePermission('opening_balance.view'), schema: { params: yearParam } }, async (req) => app.withTenant(req, (trx) => checkOpening(trx, req.params.year)));
  app.post('/api/opening-balance/:year/post', { preHandler: app.requirePermission('opening_balance.update'), schema: { params: yearParam } }, async (req) =>
    app.withTenant(req, (trx) => postOpening(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId }, req.params.year)));
  app.post('/api/opening-balance/:year/import', { preHandler: app.requirePermission('opening_balance.update'), schema: { params: yearParam, querystring: z.object({ mode: z.enum(['validate', 'commit']).default('validate') }) } }, async (req) => {
    const file = await req.file(); if (!file) throw new AppError('IMPORT_NO_FILE', 'Thiếu tệp', 400);
    const buf = await file.toBuffer();
    return app.withTenant(req, async (trx) => {
      const { rows, errors } = await parseOpeningWorkbook(trx, buf);
      if (req.query.mode === 'validate' || errors.length) return { total: rows.length + errors.length, inserted: 0, errors };
      return { total: rows.length, inserted: await replaceOpening(trx, req.auth!.tenantId!, req.params.year, rows), errors: [] };
    });
  });
};
export default routes;
```

Đăng ký trong `app.ts`. Thêm `OpeningBalanceTable` vào `types.ts`. Trong `plugins/errors.ts`, `AppError` đã có `details` (Task 9); `postOpening` ném kèm `issues`.

Lưu ý `sql` import không dùng thì bỏ; `postVoucher` cho `DK` dùng `fn_period_of(..., true)` vì `voucher_type = 'DK'` (Task 14).

- [ ] **Step 4: Chạy test**

Run: `pnpm -F @kt/api test -- test/openingBalance.test.ts` → PASS 3.

- [ ] **Step 5: Màn hình**

`apps/web/src/pages/OpeningBalance.tsx`: chọn năm (`/api/fiscal-years`); `KeyboardGrid` cột: TK (F4 → `accountFetcher`), Tên TK (readonly), Đối tượng (F4), Loại tiền, Dư Nợ, Dư Có, Dư Nợ NT, Dư Có NT; dòng tổng dưới lưới; nút "Lưu" (`PUT`), "Kiểm tra" (hiển thị `issues` trong `Alert` danh sách), "Ghi sổ số dư đầu kỳ" (`POST .../post`, hiển thị số chứng từ `DK`), "Tải mẫu Excel", "Nhập Excel" (dùng lại mẫu trang `ImportExcel`: chọn tệp → Kiểm tra → Nhập). Route `/so-cai/so-du-dau-ky`, menu nhóm "Sổ cái" `{ key: 'opening', label: 'Số dư đầu kỳ', to: '/so-cai/so-du-dau-ky', permission: 'opening_balance.view' }`.

- [ ] **Step 6: Commit**

```bash
git add packages/db apps/api apps/web
git commit -m "feat(ledger): số dư đầu kỳ kỳ 0 với kiểm tra, ghi sổ chứng từ DK và nhập Excel"
```

---

### Task 20: Số dư theo kỳ `account_period_balance`: tính lại, làm bẩn theo kỳ hiệu lực, worker, API đọc số dư tại ngày

**Files:**
- Create: `packages/db/migrations/0010_so_du_ky.sql`
- Modify: `packages/db/src/types.ts`
- Create: `apps/api/src/modules/ledger/balances.ts`; Modify: `apps/api/src/app.ts`
- Create: `apps/worker/src/jobs/recomputeBalances.ts`; Modify: `apps/worker/src/index.ts`
- Test: `packages/db/test/balances.test.ts`, `apps/worker/test/recompute.test.ts`

**Interfaces:**
- Consumes: `balance_stale`, `mark_balance_stale` (Task 14); `QUEUES.recomputeBalances` (Task 12); route chứng từ đã gửi job (Task 15).
- Produces:
  - Bảng `account_period_balance(tenant_id, account_id, fiscal_year, period_no, currency_code, party_id NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000', opening_debit, opening_credit, period_debit, period_credit, closing_debit, closing_credit, opening_debit_cur, opening_credit_cur, period_debit_cur, period_credit_cur, closing_debit_cur, closing_credit_cur, computed_at)` PK 6 cột đầu; **một hạt**: theo `(account, party)` với `party_id` thật cho mọi dòng có đối tượng, sentinel khi không có; số dư tài khoản = tổng các dòng.
  - `recompute_balances(p_tenant uuid) RETURNS int` (số kỳ đã tính; xóa bản ghi từ kỳ bẩn trở đi, tính lại phát sinh từ dòng, lan truyền số dư đầu kỳ theo thứ tự `(fiscal_year, period_no)`, xóa `balance_stale` nếu mốc không đổi trong lúc chạy).
  - `fn_balances_at(p_tenant uuid, p_date date) RETURNS TABLE(account_id bigint, party_id uuid, currency_code char(3), debit numeric, credit numeric, debit_cur numeric, credit_cur numeric)`: số dư cuối ngày `p_date` theo hạt `(account, party, currency)`; `debit/credit` là phần tách của số dư ròng (một trong hai bằng 0). Đọc snapshot kỳ chứa ngày cộng dòng trong kỳ đến ngày; nếu snapshot bẩn đến kỳ đó thì tính toàn bộ từ dòng.
  - Route: `GET /api/balances?asOf=YYYY-MM-DD&accountCode=&byParty=true` (quyền `report.view`) → `{ rows: { accountCode, accountName, partyCode?, partyName?, currencyCode, debit, credit, debitCur, creditCur }[], stale: boolean }`; `POST /api/balances/recompute` (quyền `report.view`) → `{ periods }` (chạy đồng bộ).
  - Worker: `boss.work(QUEUES.recomputeBalances, handler)` với `handler({ tenantId })` gọi `recompute_balances` trong `withTenant`.

- [ ] **Step 1: Viết test (thất bại)**

`packages/db/test/balances.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import pg from 'pg';
import fc from 'fast-check';
import { withTenant } from '../src/client.js';
import { createTestTenant, setupTestDb, type TestDb } from '../src/testing.js';
import { generateAccountsSql, insertFiscalYear } from '../src/seed/common.js';

let t: TestDb; let tenantId: string; let userId: string;
const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
const ctx = () => ({ tenantId, userId });
const accId = async (code: string) => (await sql<{ id: number }>`SELECT id FROM account WHERE tenant_id = ${tenantId}::uuid AND code = ${code}`.execute(t.admin)).rows[0]!.id;

async function postPkt(date: string, debitCode: string, creditCode: string, amount: string) {
  return withTenant(t.db, ctx(), async (trx) => {
    const v = await trx.insertInto('voucher').values({ tenant_id: tenantId, voucher_type: 'PKT', posting_date: date, document_date: date, created_by: userId }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('voucher_line').values([
      { tenant_id: tenantId, voucher_id: v.id, line_no: 1, account_id: await accId(debitCode), posting_date: date, debit: amount, credit: '0', amount_currency: amount },
      { tenant_id: tenantId, voucher_id: v.id, line_no: 2, account_id: await accId(creditCode), posting_date: date, debit: '0', credit: amount, amount_currency: `-${amount}` }]).execute();
    await sql`SELECT post_voucher(${v.id}::uuid)`.execute(trx);
    return v.id;
  });
}
const recompute = () => withTenant(t.db, ctx(), (trx) => sql`SELECT recompute_balances(${tenantId}::uuid)`.execute(trx));
async function fromLines(asOf: string) {
  const r = await sql<{ code: string; net: string }>`SELECT a.code, sum(l.debit - l.credit)::text AS net FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND l.posting_date <= ${asOf}::date GROUP BY a.code HAVING sum(l.debit - l.credit) <> 0 ORDER BY a.code`.execute(t.admin);
  return Object.fromEntries(r.rows.map((x) => [x.code, x.net]));
}
async function fromSnapshot(asOf: string) {
  const r = await withTenant(t.db, ctx(), (trx) => sql<{ code: string; net: string }>`SELECT a.code, sum(b.debit - b.credit)::text AS net FROM fn_balances_at(${tenantId}::uuid, ${asOf}::date) b JOIN account a ON a.id = b.account_id GROUP BY a.code HAVING sum(b.debit - b.credit) <> 0 ORDER BY a.code`.execute(trx));
  return Object.fromEntries(r.rows.map((x) => [x.code, x.net]));
}

beforeAll(async () => {
  t = await setupTestDb(); await admin.connect();
  tenantId = await createTestTenant(t.admin, { code: `BL${Date.now()}`, name: 'Số dư' });
  userId = (await sql<{ user_id: string }>`SELECT user_id FROM tenant_user WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin)).rows[0]!.user_id;
  await admin.query(`SELECT set_config('app.current_tenant', $1, false)`, [tenantId]);
  await insertFiscalYear(admin, tenantId, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  await generateAccountsSql(admin, tenantId, 'TT133');
});
afterAll(async () => { await admin.end(); await t.close(); });

describe('số dư theo kỳ', () => {
  it('ghi sổ làm bẩn từ kỳ hiệu lực; tính lại cho snapshot bằng tổng dòng ở mọi cuối tháng; ghi lùi ngày chỉ làm bẩn từ kỳ đó', async () => {
    await postPkt('2026-01-10', '1111', '5113', '1000'); await postPkt('2026-02-10', '6422', '1111', '300'); await postPkt('2026-03-10', '1121', '5113', '5000');
    let st = await sql<{ stale_period: number }>`SELECT stale_period FROM balance_stale WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin);
    expect(st.rows[0]!.stale_period).toBe(1);
    await recompute();
    expect((await sql`SELECT 1 FROM balance_stale WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin)).rows).toHaveLength(0);
    for (const d of ['2026-01-31', '2026-02-28', '2026-03-31', '2026-06-30']) expect(await fromSnapshot(d), d).toEqual(await fromLines(d));
    const snap = await sql<{ period_no: number; opening_debit: string; period_debit: string; closing_debit: string }>`SELECT b.period_no, b.opening_debit, b.period_debit, b.closing_debit FROM account_period_balance b JOIN account a ON a.id = b.account_id WHERE b.tenant_id = ${tenantId}::uuid AND a.code = '1111' ORDER BY period_no`.execute(t.admin);
    expect(snap.rows.map((r) => [r.period_no, r.opening_debit, r.period_debit, r.closing_debit])).toEqual(expect.arrayContaining([[1, '0', '1000', '1000'], [2, '1000', '0', '700'], [3, '700', '0', '700']]));
    await postPkt('2026-02-20', '1111', '5113', '50');
    st = await sql<{ stale_period: number }>`SELECT stale_period FROM balance_stale WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin);
    expect(st.rows[0]!.stale_period).toBe(2);
    expect(await fromSnapshot('2026-03-31')).toEqual(await fromLines('2026-03-31')); // đường chậm khi bẩn vẫn đúng
    await recompute();
    expect(await fromSnapshot('2026-12-31')).toEqual(await fromLines('2026-12-31'));
  });

  it('tính chất: với chuỗi chứng từ ngẫu nhiên, snapshot sau tính lại bằng tổng dòng tại mọi ngày', async () => {
    const codes = ['1111', '1121', '5113', '6421', '6422', '33311'];
    await fc.assert(fc.asyncProperty(fc.array(fc.record({ d: fc.integer({ min: 1, max: 28 }), m: fc.integer({ min: 1, max: 12 }), i: fc.nat(5), j: fc.nat(5), amt: fc.integer({ min: 1, max: 1_000_000 }) }), { minLength: 1, maxLength: 8 }), async (ops) => {
      for (const o of ops) {
        if (o.i === o.j) continue;
        const date = `2026-${String(o.m).padStart(2, '0')}-${String(o.d).padStart(2, '0')}`;
        await postPkt(date, codes[o.i]!, codes[o.j]!, String(o.amt));
      }
      await recompute();
      for (const d of ['2026-01-31', '2026-05-15', '2026-12-31']) expect(await fromSnapshot(d)).toEqual(await fromLines(d));
    }), { numRuns: 5 });
  }, 120_000);
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/db test -- test/balances.test.ts` → FAIL `function recompute_balances does not exist`.

- [ ] **Step 3: Migration**

`packages/db/migrations/0010_so_du_ky.sql`:

```sql
CREATE TABLE account_period_balance (
  tenant_id uuid NOT NULL, account_id bigint NOT NULL REFERENCES account(id), fiscal_year int NOT NULL, period_no int NOT NULL,
  currency_code char(3) NOT NULL, party_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  opening_debit numeric(20,0) NOT NULL DEFAULT 0, opening_credit numeric(20,0) NOT NULL DEFAULT 0,
  period_debit numeric(20,0) NOT NULL DEFAULT 0, period_credit numeric(20,0) NOT NULL DEFAULT 0,
  closing_debit numeric(20,0) NOT NULL DEFAULT 0, closing_credit numeric(20,0) NOT NULL DEFAULT 0,
  opening_debit_cur numeric(20,4) NOT NULL DEFAULT 0, opening_credit_cur numeric(20,4) NOT NULL DEFAULT 0,
  period_debit_cur numeric(20,4) NOT NULL DEFAULT 0, period_credit_cur numeric(20,4) NOT NULL DEFAULT 0,
  closing_debit_cur numeric(20,4) NOT NULL DEFAULT 0, closing_credit_cur numeric(20,4) NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, fiscal_year, period_no, currency_code, party_id));
CREATE INDEX ON account_period_balance (tenant_id, fiscal_year, period_no);
SELECT rls_enable('account_period_balance');

CREATE OR REPLACE FUNCTION recompute_balances(p_tenant uuid) RETURNS int LANGUAGE plpgsql AS $$
DECLARE st balance_stale; per record; prev record; n int := 0; v_nil uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  SELECT * INTO st FROM balance_stale WHERE tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN 0; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('recompute_balances'), hashtext(p_tenant::text));
  DELETE FROM account_period_balance WHERE tenant_id = p_tenant AND (fiscal_year, period_no) >= (st.stale_year, st.stale_period);
  INSERT INTO account_period_balance(tenant_id, account_id, fiscal_year, period_no, currency_code, party_id, period_debit, period_credit, period_debit_cur, period_credit_cur)
  SELECT v.tenant_id, l.account_id, v.fiscal_year, v.period_no, l.currency_code, coalesce(l.party_id, v_nil),
         sum(l.debit), sum(l.credit), sum(greatest(l.amount_currency, 0)), sum(greatest(-l.amount_currency, 0))
  FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
  WHERE v.tenant_id = p_tenant AND v.state IN ('posted','reversed') AND (v.fiscal_year, v.period_no) >= (st.stale_year, st.stale_period)
  GROUP BY v.tenant_id, l.account_id, v.fiscal_year, v.period_no, l.currency_code, coalesce(l.party_id, v_nil);
  prev := NULL;
  FOR per IN SELECT fiscal_year, period_no FROM fiscal_period WHERE tenant_id = p_tenant AND (fiscal_year, period_no) >= (st.stale_year, st.stale_period) ORDER BY fiscal_year, period_no LOOP
    SELECT fiscal_year, period_no INTO prev FROM fiscal_period WHERE tenant_id = p_tenant AND (fiscal_year, period_no) < (per.fiscal_year, per.period_no) ORDER BY fiscal_year DESC, period_no DESC LIMIT 1;
    IF prev.fiscal_year IS NOT NULL THEN
      INSERT INTO account_period_balance(tenant_id, account_id, fiscal_year, period_no, currency_code, party_id, opening_debit, opening_credit, opening_debit_cur, opening_credit_cur)
      SELECT b.tenant_id, b.account_id, per.fiscal_year, per.period_no, b.currency_code, b.party_id, b.closing_debit, b.closing_credit, b.closing_debit_cur, b.closing_credit_cur
      FROM account_period_balance b WHERE b.tenant_id = p_tenant AND b.fiscal_year = prev.fiscal_year AND b.period_no = prev.period_no
        AND (b.closing_debit <> 0 OR b.closing_credit <> 0 OR b.closing_debit_cur <> 0 OR b.closing_credit_cur <> 0)
      ON CONFLICT (tenant_id, account_id, fiscal_year, period_no, currency_code, party_id) DO UPDATE
        SET opening_debit = EXCLUDED.opening_debit, opening_credit = EXCLUDED.opening_credit, opening_debit_cur = EXCLUDED.opening_debit_cur, opening_credit_cur = EXCLUDED.opening_credit_cur;
    END IF;
    UPDATE account_period_balance SET
      closing_debit = greatest(opening_debit - opening_credit + period_debit - period_credit, 0),
      closing_credit = greatest(-(opening_debit - opening_credit + period_debit - period_credit), 0),
      closing_debit_cur = greatest(opening_debit_cur - opening_credit_cur + period_debit_cur - period_credit_cur, 0),
      closing_credit_cur = greatest(-(opening_debit_cur - opening_credit_cur + period_debit_cur - period_credit_cur), 0),
      computed_at = now()
    WHERE tenant_id = p_tenant AND fiscal_year = per.fiscal_year AND period_no = per.period_no;
    n := n + 1;
  END LOOP;
  DELETE FROM balance_stale WHERE tenant_id = p_tenant AND stale_year = st.stale_year AND stale_period = st.stale_period AND marked_at = st.marked_at;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION fn_balances_at(p_tenant uuid, p_date date)
RETURNS TABLE(account_id bigint, party_id uuid, currency_code char(3), debit numeric, credit numeric, debit_cur numeric, credit_cur numeric) LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
DECLARE p fiscal_period; st balance_stale; slow boolean; v_nil uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  SELECT f.* INTO p FROM fiscal_period f WHERE f.tenant_id = p_tenant AND f.date_from <= p_date
    AND (f.period_no >= 1 OR NOT EXISTS (SELECT 1 FROM fiscal_period g WHERE g.tenant_id = p_tenant AND g.period_no >= 1 AND g.date_to <= f.date_from))
  ORDER BY f.fiscal_year DESC, f.period_no DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO st FROM balance_stale WHERE tenant_id = p_tenant;
  slow := FOUND AND (st.stale_year, st.stale_period) <= (p.fiscal_year, p.period_no);
  IF slow THEN
    RETURN QUERY
    SELECT l.account_id, coalesce(l.party_id, v_nil), l.currency_code,
           greatest(sum(l.debit - l.credit), 0), greatest(-sum(l.debit - l.credit), 0), greatest(sum(l.amount_currency), 0), greatest(-sum(l.amount_currency), 0)
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
    WHERE v.tenant_id = p_tenant AND v.state IN ('posted','reversed')
      AND ((v.fiscal_year, v.period_no) < (p.fiscal_year, p.period_no) OR (v.fiscal_year = p.fiscal_year AND v.period_no = p.period_no AND l.posting_date <= p_date))
    GROUP BY l.account_id, coalesce(l.party_id, v_nil), l.currency_code HAVING sum(l.debit - l.credit) <> 0 OR sum(l.amount_currency) <> 0;
  ELSE
    RETURN QUERY
    WITH o AS (SELECT b.account_id, b.party_id, b.currency_code, b.opening_debit - b.opening_credit AS net, b.opening_debit_cur - b.opening_credit_cur AS net_cur
               FROM account_period_balance b WHERE b.tenant_id = p_tenant AND b.fiscal_year = p.fiscal_year AND b.period_no = p.period_no),
         m AS (SELECT l.account_id, coalesce(l.party_id, v_nil) AS party_id, l.currency_code, sum(l.debit - l.credit) AS net, sum(l.amount_currency) AS net_cur
               FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
               WHERE v.tenant_id = p_tenant AND v.state IN ('posted','reversed') AND v.fiscal_year = p.fiscal_year AND v.period_no = p.period_no AND l.posting_date <= p_date
               GROUP BY l.account_id, coalesce(l.party_id, v_nil), l.currency_code),
         u AS (SELECT * FROM o UNION ALL SELECT * FROM m)
    SELECT u.account_id, u.party_id, u.currency_code, greatest(sum(u.net), 0), greatest(-sum(u.net), 0), greatest(sum(u.net_cur), 0), greatest(-sum(u.net_cur), 0)
    FROM u GROUP BY u.account_id, u.party_id, u.currency_code HAVING sum(u.net) <> 0 OR sum(u.net_cur) <> 0;
  END IF;
END $$;
```

Thêm `AccountPeriodBalanceTable` vào `types.ts`.

- [ ] **Step 4: Chạy test DB**

Run: `pnpm -F @kt/db test -- test/balances.test.ts` → PASS 2.

- [ ] **Step 5: Worker và API**

`apps/worker/src/jobs/recomputeBalances.ts`:

```ts
import { sql, type Kysely } from 'kysely';
import { withTenant, type Database, type RecomputeBalancesJob } from '@kt/db';

export async function recomputeBalances(db: Kysely<Database>, job: RecomputeBalancesJob): Promise<number> {
  return withTenant(db, { tenantId: job.tenantId }, async (trx) =>
    (await sql<{ n: number }>`SELECT recompute_balances(${job.tenantId}::uuid) AS n`.execute(trx)).rows[0]!.n);
}
```

`apps/worker/src/index.ts`: thêm `DATABASE_URL` vào schema env; `const db = createDb(createPool(env.DATABASE_URL));`; `await boss.createQueue(QUEUES.recomputeBalances); await boss.work<RecomputeBalancesJob>(QUEUES.recomputeBalances, { batchSize: 1 }, async ([job]) => { const n = await recomputeBalances(db, job!.data); log('recompute done', { tenantId: job!.data.tenantId, periods: n }); });`

`apps/worker/test/recompute.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestTenant, setupTestDb, type TestDb } from '@kt/db/testing';
import { recomputeBalances } from '../src/jobs/recomputeBalances.js';

let t: TestDb; let tenantId: string;
beforeAll(async () => { t = await setupTestDb(); tenantId = await createTestTenant(t.admin, { code: `WR${Date.now()}`, name: 'Worker' }); });
afterAll(async () => { await t.close(); });

describe('job tính lại số dư', () => {
  it('không có mốc bẩn thì trả 0; có mốc bẩn thì xóa mốc', async () => {
    expect(await recomputeBalances(t.db, { tenantId })).toBe(0);
    await sql`INSERT INTO balance_stale(tenant_id, stale_year, stale_period) VALUES (${tenantId}::uuid, 2026, 1)`.execute(t.admin);
    await recomputeBalances(t.db, { tenantId });
    expect((await sql`SELECT 1 FROM balance_stale WHERE tenant_id = ${tenantId}::uuid`.execute(t.admin)).rows).toHaveLength(0);
  });
});
```

`apps/api/src/modules/ledger/balances.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/balances', { preHandler: app.requirePermission('report.view'), schema: { querystring: z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), accountCode: z.string().optional(), byParty: z.enum(['true', 'false']).default('false') }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const tenantId = req.auth!.tenantId!; const byParty = req.query.byParty === 'true';
      const rows = await sql<{ accountCode: string; accountName: string; partyCode: string | null; partyName: string | null; currencyCode: string; debit: string; credit: string; debitCur: string; creditCur: string }>`
        SELECT a.code AS "accountCode", a.name AS "accountName", ${byParty ? sql`p.code` : sql`NULL`} AS "partyCode", ${byParty ? sql`p.name` : sql`NULL`} AS "partyName", b.currency_code AS "currencyCode",
               ${byParty ? sql`sum(b.debit)` : sql`greatest(sum(b.debit - b.credit), 0)`}::text AS debit, ${byParty ? sql`sum(b.credit)` : sql`greatest(-sum(b.debit - b.credit), 0)`}::text AS credit,
               ${byParty ? sql`sum(b.debit_cur)` : sql`greatest(sum(b.debit_cur - b.credit_cur), 0)`}::text AS "debitCur", ${byParty ? sql`sum(b.credit_cur)` : sql`greatest(-sum(b.debit_cur - b.credit_cur), 0)`}::text AS "creditCur"
        FROM fn_balances_at(${tenantId}::uuid, ${req.query.asOf}::date) b JOIN account a ON a.id = b.account_id LEFT JOIN party p ON p.id = b.party_id
        WHERE ${req.query.accountCode ? sql`a.code LIKE ${req.query.accountCode + '%'}` : sql`true`}
        GROUP BY a.code, a.name, b.currency_code ${byParty ? sql`, p.code, p.name` : sql``} ORDER BY a.code, 3`.execute(trx);
      const stale = (await trx.selectFrom('balance_stale').select('tenant_id').where('tenant_id', '=', tenantId).executeTakeFirst()) !== undefined;
      return { rows: rows.rows, stale };
    }));
  app.post('/api/balances/recompute', { preHandler: app.requirePermission('report.view') }, async (req) =>
    app.withTenant(req, async (trx) => ({ periods: (await sql<{ n: number }>`SELECT recompute_balances(${req.auth!.tenantId!}::uuid) AS n`.execute(trx)).rows[0]!.n })));
};
export default routes;
```

Đăng ký trong `app.ts`. Run: `pnpm -F @kt/worker test && pnpm -F @kt/api typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db apps/api apps/worker
git commit -m "feat(ledger): số dư theo kỳ với làm bẩn theo kỳ hiệu lực, tính lại bằng worker và đọc số dư tại ngày"
```

---

### Task 21: Sơ đồ kết chuyển/phân bổ `closing_step`, chạy từng bước sinh chứng từ `KC`/`PB`, chạy lại bằng đảo, kết chuyển lợi nhuận đầu năm sau

**Files:**
- Create: `packages/db/migrations/0011_ket_chuyen.sql`
- Create: `packages/coa-data/data/closing-steps/default.json`; Modify: `packages/coa-data/src/load.ts` (`loadDefaultClosingSteps()`)
- Modify: `packages/db/src/types.ts`
- Create: `apps/api/src/modules/ledger/closing.ts`; Modify: `apps/api/src/app.ts`, `apps/api/src/modules/core/fiscalYears.ts` (nạp sơ đồ mặc định khi chưa có)
- Create: `apps/web/src/pages/Closing.tsx`; Modify: `apps/web/src/router.tsx`
- Test: `apps/api/test/closing.test.ts`

**Interfaces:**
- Consumes: `post_voucher`, `reverse_voucher` (Task 15); `voucher_type` `KC`/`PB` (Task 14).
- Produces:
  - Bảng `closing_step(id uuid, tenant_id, step_order int, name, mode 'transfer'|'allocate', from_accounts text[], to_account text, keep_balance numeric(20,0) DEFAULT 0, by_dimension text NULL|'project', ratio_source jsonb, run_at 'period_end'|'next_year_start', is_active)`, `closing_run(id, tenant_id, step_id, posting_date, voucher_id, status 'done'|'reversed', created_at, created_by)`.
  - SQL `run_closing_step(p_tenant uuid, p_step uuid, p_date date) RETURNS uuid[]` (0–2 chứng từ: một cho các tài khoản nguồn dư Có, một cho dư Nợ; `allocate` một chứng từ); `rerun_closing_step(p_tenant, p_step, p_date) RETURNS uuid[]` (đảo các `closing_run` `done` cùng bước và ngày rồi chạy lại). Lỗi: `CLOSING_STEP_NOT_FOUND`, `CLOSING_TO_ACCOUNT_INVALID`, `CLOSING_RATIO_INVALID`.
  - `ratio_source` cho `allocate`: `{ "ratios": [{ "account": "6421", "percent": "60" }, ...] }` tổng 100.
  - `default.json` (5 bước mặc định theo SUNSOFT `DesHT_KC_CTu`, không gồm 1331→33311 vì thuộc GĐ2).
  - Route (quyền `closing.run`; CRUD sơ đồ qua `closing_step.*`): `GET /api/closing/steps`; `PUT /api/closing/steps` (thay toàn bộ sơ đồ); `POST /api/closing/steps/reload` (nạp mẫu); `POST /api/closing/run { stepId, postingDate }` → `{ voucherIds }`; `POST /api/closing/rerun { stepId, postingDate }`; `POST /api/closing/run-all { postingDate }` (chạy tuần tự các bước `run_at = 'period_end'` theo `step_order`, mỗi bước là một transaction, dừng ở lỗi đầu tiên) → `{ steps: { stepId, voucherIds }[] }`; `GET /api/closing/runs?year=`.

- [ ] **Step 1: Viết test (thất bại)**

`apps/api/test/closing.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string;
const pkt = (date: string, lines: object[]) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'x', autoPost: true, lines } });
const bal = async (asOf: string) => { const r = await ctx.app.inject({ method: 'GET', url: `/api/balances?asOf=${asOf}`, headers: { cookie } }); return Object.fromEntries((r.json().rows as { accountCode: string; debit: string; credit: string }[]).map((x) => [x.accountCode, { d: x.debit, c: x.credit }])); };

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `KC${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2027, dateFrom: '2027-01-01', months: 12, regime: 'TT133' } });
  await pkt('2026-03-05', [{ accountCode: '1121', debit: '1000' }, { accountCode: '5113', credit: '1000' }]);
  await pkt('2026-06-05', [{ accountCode: '6421', debit: '600' }, { accountCode: '1121', credit: '600' }]);
  await pkt('2026-09-05', [{ accountCode: '6422', debit: '100' }, { accountCode: '1111', credit: '100' }]);
});
afterAll(async () => { await ctx.close(); });

describe('kết chuyển', () => {
  it('sơ đồ mặc định được nạp khi tạo năm', async () => {
    const steps = (await ctx.app.inject({ method: 'GET', url: '/api/closing/steps', headers: { cookie } })).json() as { stepOrder: number; name: string; toAccount: string }[];
    expect(steps.map((s) => s.toAccount)).toEqual(['5111', '911', '911', '4212', '4211']);
  });
  it('chạy tất cả bước cuối năm: 5–9 về 0, 911 về 0, 4212 dư Có 300; chứng từ KC có is_closing và đối ứng đúng', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/closing/run-all', headers: { cookie }, payload: { postingDate: '2026-12-31' } });
    expect(r.statusCode, r.body).toBe(200);
    const b = await bal('2026-12-31');
    expect(b['5113']).toBeUndefined(); expect(b['6421']).toBeUndefined(); expect(b['6422']).toBeUndefined(); expect(b['911']).toBeUndefined();
    expect(b['4212']).toEqual({ d: '0', c: '300' });
    const kc = await ctx.app.inject({ method: 'GET', url: '/api/vouchers?type=KC&from=2026-12-31&to=2026-12-31', headers: { cookie } });
    expect(kc.json().total).toBe(3); // doanh thu→911, chi phí→911, 911→4212
    const first = (await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${kc.json().rows.at(-1).id}`, headers: { cookie } })).json();
    expect(first.isClosing).toBe(true); expect(first.sourceDocType).toBe('closing_step');
  });
  it('phát sinh thêm rồi chạy lại: KC cũ bị đảo, số dư 4212 đúng 320; không sửa đè', async () => {
    await pkt('2026-12-20', [{ accountCode: '1121', debit: '20' }, { accountCode: '5113', credit: '20' }]);
    const steps = (await ctx.app.inject({ method: 'GET', url: '/api/closing/steps', headers: { cookie } })).json() as { id: string; toAccount: string; stepOrder: number }[];
    for (const s of steps.filter((x) => x.stepOrder <= 4)) {
      const rr = await ctx.app.inject({ method: 'POST', url: '/api/closing/rerun', headers: { cookie }, payload: { stepId: s.id, postingDate: '2026-12-31' } });
      expect(rr.statusCode, rr.body).toBe(200);
    }
    expect((await bal('2026-12-31'))['4212']).toEqual({ d: '0', c: '320' });
    const runs = (await ctx.app.inject({ method: 'GET', url: '/api/closing/runs?year=2026', headers: { cookie } })).json() as { status: string }[];
    expect(runs.filter((x) => x.status === 'reversed').length).toBe(3);
    const reversed = await ctx.app.inject({ method: 'GET', url: '/api/vouchers?type=KC&state=reversed', headers: { cookie } });
    expect(reversed.json().total).toBe(3);
  });
  it('bước đầu năm sau chuyển 4212 → 4211 ngày 01/01/2027', async () => {
    const steps = (await ctx.app.inject({ method: 'GET', url: '/api/closing/steps', headers: { cookie } })).json() as { id: string; runAt: string }[];
    const s = steps.find((x) => x.runAt === 'next_year_start')!;
    const r = await ctx.app.inject({ method: 'POST', url: '/api/closing/run', headers: { cookie }, payload: { stepId: s.id, postingDate: '2027-01-01' } });
    expect(r.json().voucherIds).toHaveLength(1);
    const b = await bal('2027-01-01');
    expect(b['4211']).toEqual({ d: '0', c: '320' }); expect(b['4212']).toBeUndefined();
  });
  it('phân bổ theo tỷ lệ: 242 (chi phí trả trước) → 6421 60% / 6422 40% với số dư 1001, làm tròn dồn phần dư về dòng cuối', async () => {
    await pkt('2027-02-01', [{ accountCode: '242', debit: '1001' }, { accountCode: '1111', credit: '1001' }]);
    const cur = (await ctx.app.inject({ method: 'GET', url: '/api/closing/steps', headers: { cookie } })).json() as object[];
    const put = await ctx.app.inject({ method: 'PUT', url: '/api/closing/steps', headers: { cookie }, payload: { steps: [...cur, { stepOrder: 99, name: 'Phân bổ chi phí trả trước', mode: 'allocate', fromAccounts: ['242'], toAccount: null, ratioSource: { ratios: [{ account: '6421', percent: '60' }, { account: '6422', percent: '40' }] }, runAt: 'period_end' }] } });
    expect(put.statusCode, put.body).toBe(200);
    const steps = (await ctx.app.inject({ method: 'GET', url: '/api/closing/steps', headers: { cookie } })).json() as { id: string; stepOrder: number }[];
    const r = await ctx.app.inject({ method: 'POST', url: '/api/closing/run', headers: { cookie }, payload: { stepId: steps.find((x) => x.stepOrder === 99)!.id, postingDate: '2027-02-28' } });
    expect(r.statusCode, r.body).toBe(200);
    const v = (await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${r.json().voucherIds[0]}`, headers: { cookie } })).json();
    expect(v.voucherType).toBe('PB');
    expect(v.lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit])).toEqual([['6421', '601', '0'], ['6422', '400', '0'], ['242', '0', '1001']]);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/api test -- test/closing.test.ts` → FAIL 404.

- [ ] **Step 3: Dữ liệu mẫu sơ đồ và migration**

`packages/coa-data/data/closing-steps/default.json`:

```json
[
  { "stepOrder": 1, "name": "Kết chuyển các khoản giảm trừ doanh thu", "mode": "transfer", "fromAccounts": ["521"], "toAccount": "5111", "runAt": "period_end" },
  { "stepOrder": 2, "name": "Kết chuyển doanh thu, thu nhập khác", "mode": "transfer", "fromAccounts": ["511", "515", "711"], "toAccount": "911", "runAt": "period_end" },
  { "stepOrder": 3, "name": "Kết chuyển giá vốn, chi phí", "mode": "transfer", "fromAccounts": ["632", "635", "641", "642", "811", "821"], "toAccount": "911", "runAt": "period_end" },
  { "stepOrder": 4, "name": "Xác định kết quả kinh doanh", "mode": "transfer", "fromAccounts": ["911"], "toAccount": "4212", "runAt": "period_end" },
  { "stepOrder": 5, "name": "Kết chuyển lợi nhuận năm nay sang năm trước (chạy ngày đầu năm sau)", "mode": "transfer", "fromAccounts": ["4212"], "toAccount": "4211", "runAt": "next_year_start" }
]
```

`packages/coa-data/src/load.ts` thêm:

```ts
export interface ClosingStepTemplate { stepOrder: number; name: string; mode: 'transfer' | 'allocate'; fromAccounts: string[]; toAccount: string | null; keepBalance?: string; byDimension?: 'project' | null; ratioSource?: { ratios: { account: string; percent: string }[] } | null; runAt: 'period_end' | 'next_year_start' }
export function loadDefaultClosingSteps(): ClosingStepTemplate[] { return JSON.parse(readFileSync(dataPath('closing-steps', 'default.json'), 'utf8')) as ClosingStepTemplate[]; }
```

`packages/db/migrations/0011_ket_chuyen.sql`:

```sql
CREATE TABLE closing_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
  step_order int NOT NULL, name text NOT NULL, mode text NOT NULL CHECK (mode IN ('transfer','allocate')),
  from_accounts text[] NOT NULL, to_account text, keep_balance numeric(20,0) NOT NULL DEFAULT 0,
  by_dimension text CHECK (by_dimension IN ('project')), ratio_source jsonb,
  run_at text NOT NULL DEFAULT 'period_end' CHECK (run_at IN ('period_end','next_year_start')), is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, step_order));
CREATE TABLE closing_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, step_id uuid NOT NULL REFERENCES closing_step(id) ON DELETE CASCADE,
  posting_date date NOT NULL, voucher_id uuid NOT NULL REFERENCES voucher(id), status text NOT NULL DEFAULT 'done' CHECK (status IN ('done','reversed')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid);
CREATE INDEX ON closing_run (tenant_id, step_id, posting_date);
SELECT rls_enable('closing_step'), audit_enable('closing_step'), rls_enable('closing_run');

-- Số dư ròng tại ngày theo (tài khoản lá thuộc các tiền tố, [vụ việc]) từ dòng sổ cái.
CREATE OR REPLACE FUNCTION fn_closing_sources(p_tenant uuid, p_prefixes text[], p_date date, p_by_project boolean)
RETURNS TABLE(account_id bigint, project_id bigint, net numeric) LANGUAGE sql STABLE AS $$
  -- hàm SQL thuần: không có xung đột tên biến
  SELECT l.account_id, CASE WHEN p_by_project THEN l.project_id ELSE NULL END, sum(l.debit - l.credit)
  FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
  WHERE v.tenant_id = p_tenant AND v.state IN ('posted','reversed') AND l.posting_date <= p_date
    AND EXISTS (SELECT 1 FROM unnest(p_prefixes) pf WHERE a.code LIKE pf || '%')
  GROUP BY l.account_id, CASE WHEN p_by_project THEN l.project_id ELSE NULL END HAVING sum(l.debit - l.credit) <> 0;
$$;

CREATE OR REPLACE FUNCTION fn_closing_new_voucher(p_tenant uuid, p_type text, p_date date, p_desc text, p_step uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO voucher(tenant_id, voucher_type, posting_date, document_date, description, is_closing, source_doc_type, source_doc_id, created_by)
  VALUES (p_tenant, p_type, p_date, p_date, p_desc, p_type = 'KC', 'closing_step', p_step, app_user_id()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION run_closing_step(p_tenant uuid, p_step uuid, p_date date) RETURNS uuid[] LANGUAGE plpgsql AS $$
DECLARE s closing_step; a_to account; src record; v_cr uuid; v_dr uuid; n_cr int := 0; n_dr int := 0; out uuid[] := '{}';
        v_desc text; r jsonb; total numeric := 0; alloc numeric; remain numeric; v_id uuid; n int := 0; a_t account; last_line int;
BEGIN
  SELECT * INTO s FROM closing_step WHERE id = p_step AND tenant_id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLOSING_STEP_NOT_FOUND: %', p_step USING ERRCODE = 'P0001'; END IF;
  v_desc := s.name || ' đến ngày ' || to_char(p_date, 'DD/MM/YYYY');
  IF s.mode = 'transfer' THEN
    SELECT * INTO a_to FROM account WHERE tenant_id = p_tenant AND code = s.to_account AND NOT is_group AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'CLOSING_TO_ACCOUNT_INVALID: tài khoản đích % không tồn tại hoặc là tổng hợp', s.to_account USING ERRCODE = 'P0001'; END IF;
    FOR src IN SELECT * FROM fn_closing_sources(p_tenant, s.from_accounts, p_date, s.by_dimension = 'project') LOOP
      IF src.account_id = a_to.id THEN CONTINUE; END IF;
      alloc := src.net - sign(src.net) * least(abs(src.net), s.keep_balance);
      IF alloc = 0 THEN CONTINUE; END IF;
      IF alloc < 0 THEN  -- nguồn dư Có: Nợ nguồn / Có đích
        IF v_cr IS NULL THEN v_cr := fn_closing_new_voucher(p_tenant, 'KC', p_date, v_desc, p_step); END IF;
        n_cr := n_cr + 1;
        INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, amount_currency, project_id, description)
        VALUES (p_tenant, v_cr, n_cr, src.account_id, p_date, -alloc, 0, -alloc, src.project_id, s.name);
      ELSE                -- nguồn dư Nợ: Nợ đích / Có nguồn
        IF v_dr IS NULL THEN v_dr := fn_closing_new_voucher(p_tenant, 'KC', p_date, v_desc, p_step); END IF;
        n_dr := n_dr + 1;
        INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, amount_currency, project_id, description)
        VALUES (p_tenant, v_dr, n_dr, src.account_id, p_date, 0, alloc, -alloc, src.project_id, s.name);
      END IF;
    END LOOP;
    IF v_cr IS NOT NULL THEN
      INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, amount_currency, description)
      SELECT p_tenant, v_cr, n_cr + 1, a_to.id, p_date, 0, sum(debit), -sum(debit), s.name FROM voucher_line WHERE voucher_id = v_cr;
      PERFORM post_voucher(v_cr); INSERT INTO closing_run(tenant_id, step_id, posting_date, voucher_id, created_by) VALUES (p_tenant, p_step, p_date, v_cr, app_user_id()); out := out || v_cr;
    END IF;
    IF v_dr IS NOT NULL THEN
      INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, amount_currency, description)
      SELECT p_tenant, v_dr, n_dr + 1, a_to.id, p_date, sum(credit), 0, sum(credit), s.name FROM voucher_line WHERE voucher_id = v_dr;
      PERFORM post_voucher(v_dr); INSERT INTO closing_run(tenant_id, step_id, posting_date, voucher_id, created_by) VALUES (p_tenant, p_step, p_date, v_dr, app_user_id()); out := out || v_dr;
    END IF;
    RETURN out;
  END IF;
  -- allocate: một tài khoản nguồn, chia theo tỷ lệ phần trăm
  IF s.ratio_source IS NULL OR (SELECT coalesce(sum((x->>'percent')::numeric), 0) FROM jsonb_array_elements(s.ratio_source->'ratios') x) <> 100 THEN
    RAISE EXCEPTION 'CLOSING_RATIO_INVALID: tổng tỷ lệ phải bằng 100' USING ERRCODE = 'P0001'; END IF;
  SELECT sum(net) INTO total FROM fn_closing_sources(p_tenant, s.from_accounts, p_date, false);
  IF total IS NULL OR total = 0 THEN RETURN out; END IF;
  v_id := fn_closing_new_voucher(p_tenant, 'PB', p_date, v_desc, p_step);
  remain := abs(total); last_line := jsonb_array_length(s.ratio_source->'ratios');
  FOR r IN SELECT x FROM jsonb_array_elements(s.ratio_source->'ratios') x LOOP
    n := n + 1;
    SELECT * INTO a_t FROM account WHERE tenant_id = p_tenant AND code = r->>'account' AND NOT is_group;
    IF NOT FOUND THEN RAISE EXCEPTION 'CLOSING_TO_ACCOUNT_INVALID: tài khoản % không tồn tại hoặc là tổng hợp', r->>'account' USING ERRCODE = 'P0001'; END IF;
    alloc := CASE WHEN n = last_line THEN remain ELSE round(abs(total) * (r->>'percent')::numeric / 100) END;
    remain := remain - alloc;
    IF alloc > 0 THEN
      INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, amount_currency, description)
      VALUES (p_tenant, v_id, n, a_t.id, p_date, CASE WHEN total > 0 THEN alloc ELSE 0 END, CASE WHEN total > 0 THEN 0 ELSE alloc END, CASE WHEN total > 0 THEN alloc ELSE -alloc END, s.name);
    END IF;
  END LOOP;
  FOR src IN SELECT * FROM fn_closing_sources(p_tenant, s.from_accounts, p_date, false) LOOP
    n := n + 1;
    INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, amount_currency, description)
    VALUES (p_tenant, v_id, n, src.account_id, p_date, CASE WHEN src.net < 0 THEN -src.net ELSE 0 END, CASE WHEN src.net > 0 THEN src.net ELSE 0 END, -src.net, s.name);
  END LOOP;
  PERFORM post_voucher(v_id);
  INSERT INTO closing_run(tenant_id, step_id, posting_date, voucher_id, created_by) VALUES (p_tenant, p_step, p_date, v_id, app_user_id());
  RETURN out || v_id;
END $$;

CREATE OR REPLACE FUNCTION rerun_closing_step(p_tenant uuid, p_step uuid, p_date date) RETURNS uuid[] LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT cr.id, cr.voucher_id FROM closing_run cr JOIN voucher v ON v.id = cr.voucher_id
           WHERE cr.tenant_id = p_tenant AND cr.step_id = p_step AND cr.posting_date = p_date AND cr.status = 'done' AND v.state = 'posted' ORDER BY cr.id LOOP
    PERFORM reverse_voucher(r.voucher_id, p_date, 'Đảo để chạy lại kết chuyển');
    UPDATE closing_run SET status = 'reversed' WHERE id = r.id;
  END LOOP;
  RETURN run_closing_step(p_tenant, p_step, p_date);
END $$;
```

Thêm `ClosingStepTable`, `ClosingRunTable` vào `types.ts`.

- [ ] **Step 4: Service/route, nạp mẫu khi tạo năm**

`apps/api/src/modules/ledger/closing.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { loadDefaultClosingSteps } from '@kt/coa-data';
import { QUEUES } from '@kt/db';

export const stepInput = z.object({ id: z.string().uuid().optional(), stepOrder: z.number().int(), name: z.string().min(1), mode: z.enum(['transfer', 'allocate']),
  fromAccounts: z.array(z.string().min(1)).min(1), toAccount: z.string().nullable().optional(), keepBalance: z.string().regex(/^\d+$/).default('0'),
  byDimension: z.enum(['project']).nullable().optional(), ratioSource: z.object({ ratios: z.array(z.object({ account: z.string(), percent: z.string() })) }).nullable().optional(),
  runAt: z.enum(['period_end', 'next_year_start']).default('period_end'), isActive: z.boolean().default(true) });

export async function loadClosingTemplate(trx: Transaction<Database>, tenantId: string): Promise<number> {
  await trx.deleteFrom('closing_step').execute();
  const tpl = loadDefaultClosingSteps();
  for (const s of tpl) await trx.insertInto('closing_step').values({ tenant_id: tenantId, step_order: s.stepOrder, name: s.name, mode: s.mode, from_accounts: s.fromAccounts, to_account: s.toAccount,
    keep_balance: s.keepBalance ?? '0', by_dimension: s.byDimension ?? null, ratio_source: s.ratioSource ? JSON.stringify(s.ratioSource) : null, run_at: s.runAt }).execute();
  return tpl.length;
}
export async function listSteps(trx: Transaction<Database>) {
  return (await trx.selectFrom('closing_step').selectAll().orderBy('step_order').execute()).map((s) => ({ id: s.id, stepOrder: s.step_order, name: s.name, mode: s.mode, fromAccounts: s.from_accounts, toAccount: s.to_account,
    keepBalance: s.keep_balance, byDimension: s.by_dimension, ratioSource: s.ratio_source, runAt: s.run_at, isActive: s.is_active }));
}
export const runStep = async (trx: Transaction<Database>, tenantId: string, stepId: string, date: string) => (await sql<{ ids: string[] }>`SELECT run_closing_step(${tenantId}::uuid, ${stepId}::uuid, ${date}::date) AS ids`.execute(trx)).rows[0]!.ids;
export const rerunStep = async (trx: Transaction<Database>, tenantId: string, stepId: string, date: string) => (await sql<{ ids: string[] }>`SELECT rerun_closing_step(${tenantId}::uuid, ${stepId}::uuid, ${date}::date) AS ids`.execute(trx)).rows[0]!.ids;

const routes: FastifyPluginAsyncZod = async (app) => {
  const notify = (tenantId: string) => app.boss?.send(QUEUES.recomputeBalances, { tenantId }, { singletonKey: tenantId, singletonSeconds: 5 }).catch((e) => app.log.error(e));
  app.get('/api/closing/steps', { preHandler: app.requirePermission('closing_step.view') }, async (req) => app.withTenant(req, listSteps));
  app.put('/api/closing/steps', { preHandler: app.requirePermission('closing_step.update'), schema: { body: z.object({ steps: z.array(stepInput) }) } }, async (req) => {
    const tenantId = req.auth!.tenantId!;
    await app.withTenant(req, async (trx) => {
      const keep = req.body.steps.map((s) => s.id).filter((x): x is string => !!x);
      await trx.deleteFrom('closing_step').where('id', 'not in', keep.length ? keep : ['00000000-0000-0000-0000-000000000000']).execute();
      for (const s of req.body.steps) {
        const row = { tenant_id: tenantId, step_order: s.stepOrder, name: s.name, mode: s.mode, from_accounts: s.fromAccounts, to_account: s.toAccount ?? null, keep_balance: s.keepBalance, by_dimension: s.byDimension ?? null,
          ratio_source: s.ratioSource ? JSON.stringify(s.ratioSource) : null, run_at: s.runAt, is_active: s.isActive };
        if (s.id) await trx.updateTable('closing_step').set(row).where('id', '=', s.id).execute(); else await trx.insertInto('closing_step').values(row).execute();
      }
    });
    return { ok: true };
  });
  app.post('/api/closing/steps/reload', { preHandler: app.requirePermission('closing_step.update') }, async (req) => ({ count: await app.withTenant(req, (trx) => loadClosingTemplate(trx, req.auth!.tenantId!)) }));
  app.post('/api/closing/run', { preHandler: app.requirePermission('closing.run'), schema: { body: z.object({ stepId: z.string().uuid(), postingDate: z.string() }) } }, async (req) => {
    const ids = await app.withTenant(req, (trx) => runStep(trx, req.auth!.tenantId!, req.body.stepId, req.body.postingDate)); void notify(req.auth!.tenantId!); return { voucherIds: ids }; });
  app.post('/api/closing/rerun', { preHandler: app.requirePermission('closing.run'), schema: { body: z.object({ stepId: z.string().uuid(), postingDate: z.string() }) } }, async (req) => {
    const ids = await app.withTenant(req, (trx) => rerunStep(trx, req.auth!.tenantId!, req.body.stepId, req.body.postingDate)); void notify(req.auth!.tenantId!); return { voucherIds: ids }; });
  app.post('/api/closing/run-all', { preHandler: app.requirePermission('closing.run'), schema: { body: z.object({ postingDate: z.string() }) } }, async (req) => {
    const steps = (await app.withTenant(req, listSteps)).filter((s) => s.isActive && s.runAt === 'period_end');
    const out: { stepId: string; voucherIds: string[] }[] = [];
    for (const s of steps) out.push({ stepId: s.id, voucherIds: await app.withTenant(req, (trx) => runStep(trx, req.auth!.tenantId!, s.id, req.body.postingDate)) });
    void notify(req.auth!.tenantId!); return { steps: out };
  });
  app.get('/api/closing/runs', { preHandler: app.requirePermission('closing_step.view'), schema: { querystring: z.object({ year: z.coerce.number().int().optional() }) } }, async (req) =>
    app.withTenant(req, async (trx) => { let q = trx.selectFrom('closing_run as r').innerJoin('closing_step as s', 's.id', 'r.step_id').innerJoin('voucher as v', 'v.id', 'r.voucher_id')
      .select(['r.id', 's.name as stepName', 'r.posting_date as postingDate', 'v.voucher_no as voucherNo', 'r.voucher_id as voucherId', 'r.status', 'r.created_at as createdAt']);
      if (req.query.year) q = q.where(sql`extract(year from r.posting_date)`, '=', req.query.year);
      return q.orderBy('r.id', 'desc').execute(); }));
};
export default routes;
```

Trong `createFiscalYear` (Task 5) sau sinh tài khoản: `if (!(await trx.selectFrom('closing_step').select('id').limit(1).executeTakeFirst())) await loadClosingTemplate(trx, tenantId);` (import từ `../ledger/closing.js`). Đăng ký `closingRoutes` trong `app.ts`.

- [ ] **Step 5: Chạy test**

Run: `pnpm -F @kt/api test -- test/closing.test.ts` → PASS 5.

- [ ] **Step 6: Màn hình Kết chuyển cuối kỳ**

`apps/web/src/pages/Closing.tsx`: chọn ngày kết chuyển (mặc định cuối tháng hiện tại); bảng bước (thứ tự, tên, chế độ, TK nguồn, TK đích, chạy lúc) với nút từng dòng "Chạy", "Chạy lại (đảo cũ)" và nút chung "Chạy tất cả bước cuối kỳ"; thẻ "Nhật ký chạy" (`/api/closing/runs?year`) có liên kết tới chứng từ; thẻ "Sơ đồ" cho sửa (`Form.List`, `PUT /api/closing/steps`) và "Nạp lại mẫu". Route `/so-cai/ket-chuyen`, menu `{ key: 'closing', label: 'Kết chuyển cuối kỳ', to: '/so-cai/ket-chuyen', permission: 'closing.run' }`.

- [ ] **Step 7: Commit**

```bash
git add packages/db packages/coa-data apps/api apps/web
git commit -m "feat(ledger): sơ đồ kết chuyển/phân bổ chạy từng bước sinh chứng từ KC/PB và chạy lại bằng đảo"
```

---

### Task 22: Sổ Nhật ký chung (S03a), Sổ Cái (S03b: theo chứng từ, theo tiểu khoản, chữ T), Sổ chi tiết tài khoản (S38), Bảng cân đối số phát sinh (S06); truy ngược về chứng từ

**Files:**
- Create: `apps/api/src/modules/reporting/ledgers.ts`, `apps/api/src/modules/reporting/routes.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/web/src/pages/Ledgers.tsx`; Modify: `apps/web/src/router.tsx`
- Test: `apps/api/test/ledgers.test.ts`

**Interfaces:**
- Consumes: `fn_balances_at` (Task 20), `voucher_pair` (Task 14), cờ nhạy cảm `view_receivable/view_payable/view_cost` (Task 4a).
- Produces (mọi hàm nhận `trx`, trả số tiền dạng chuỗi):
  - `generalJournal(trx, { from, to }): Promise<{ rows: JournalRow[]; totalDebit; totalCredit }>` với `JournalRow = { postingDate; voucherId; voucherNo; voucherType; documentDate; description; accountCode; accountName; debit; credit }` sắp xếp `(posting_date, voucher_type, seq_no, line_no)`; chỉ chứng từ `posted|reversed`.
  - `accountLedger(trx, { accountCode, from, to, mode: 'voucher'|'subaccount'|'t' }): Promise<{ opening: Side; rows: LedgerRow[]; totalDebit; totalCredit; closing: Side }>`; `Side = { debit: string; credit: string }`; `LedgerRow = { postingDate; voucherId; voucherNo; description; counterAccountCode; debit; credit; running: Side }` (mode `voucher`); mode `subaccount` trả `rows` gộp theo tiểu khoản (`accountCode`, `accountName`, opening/debit/credit/closing); mode `t` trả `{ debitSide: {counterAccountCode; amount}[]; creditSide: ... }`.
  - `accountDetail(trx, { accountCode, from, to, partyCode?, costItemCode?, projectCode?, departmentCode? }): Promise<{ opening: Side; rows: DetailRow[]; closing: Side }>` với `DetailRow = LedgerRow & { partyCode; partyName; costItemCode; projectCode; departmentCode }`.
  - `trialBalance(trx, { from, to, level?: number; splitParty?: boolean }): Promise<{ rows: TrialRow[]; totals: { opening: Side; period: Side; closing: Side } }>` với `TrialRow = { accountCode; accountName; level; isGroup; opening: Side; period: Side; closing: Side }`; dòng tổng hợp = tổng con; `splitParty` tách dư hai bên theo đối tượng cho tài khoản `subledger_kind receivable|payable` (tổng dư Nợ của các đối tượng dư Nợ và tổng dư Có của các đối tượng dư Có).
  - Route (`report.view`): `GET /api/reports/ledgers/general-journal?from&to`, `GET /api/reports/ledgers/account?accountCode&from&to&mode`, `GET /api/reports/ledgers/detail?accountCode&from&to&partyCode&...`, `GET /api/reports/ledgers/trial-balance?from&to&level&splitParty`. Thiếu cờ `view_receivable` → 403 khi tài khoản `receivable`; `view_payable` với `payable`; `view_cost` với tài khoản bắt đầu `632`.
  - Hàm `openingSide(trx, tenantId, accountPrefix, dateBefore): Promise<Side>` dùng chung: từ `fn_balances_at(tenant, dateBefore)` gộp theo tiền tố; `openingSideSplit(...)` cho `splitParty`.

- [ ] **Step 1: Viết test (thất bại)**

`apps/api/test/ledgers.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string;
const pkt = (date: string, lines: object[]) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: date, documentDate: date, description: `CT ${date}`, autoPost: true, lines } });
const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `LG${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  for (const [code, name] of [['KH001', 'Khách 1'], ['KH002', 'Khách 2']]) await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code, name, is_customer: true } });
  await ctx.app.inject({ method: 'PUT', url: '/api/opening-balance/2026', headers: { cookie }, payload: { rows: [
    { accountCode: '1111', currencyCode: 'VND', debit: '1000', credit: '0', debitCurrency: '0', creditCurrency: '0', partyCode: null },
    { accountCode: '4111', currencyCode: 'VND', debit: '0', credit: '1000', debitCurrency: '0', creditCurrency: '0', partyCode: null }] } });
  await ctx.app.inject({ method: 'POST', url: '/api/opening-balance/2026/post', headers: { cookie } });
  await pkt('2026-01-10', [{ accountCode: '131', debit: '500', partyCode: 'KH001' }, { accountCode: '5113', credit: '500' }]);
  await pkt('2026-01-20', [{ accountCode: '1111', debit: '200', partyCode: null }, { accountCode: '131', credit: '200', partyCode: 'KH002' }]); // KH002 trả trước
  await pkt('2026-02-05', [{ accountCode: '6421', debit: '300' }, { accountCode: '6422', debit: '100' }, { accountCode: '1111', credit: '400' }]);
  await ctx.app.inject({ method: 'POST', url: '/api/balances/recompute', headers: { cookie } });
});
afterAll(async () => { await ctx.close(); });

describe('sổ sách', () => {
  it('Nhật ký chung: đủ dòng theo thứ tự, tổng Nợ = tổng Có, không gồm chứng từ DK ngoài khoảng', async () => {
    const r = await get('/api/reports/ledgers/general-journal?from=2026-01-01&to=2026-02-28');
    expect(r.statusCode).toBe(200);
    expect(r.json().rows).toHaveLength(7); expect(r.json().totalDebit).toBe('1100'); expect(r.json().totalCredit).toBe('1100');
    expect(r.json().rows[0]).toMatchObject({ postingDate: '2026-01-10', accountCode: '131', debit: '500' });
    expect(r.json().rows.every((x: { voucherId: string }) => x.voucherId)).toBe(true);
  });
  it('Sổ Cái 1111 theo chứng từ: dư đầu 1000, phát sinh, dư cuối 800, đối ứng đúng', async () => {
    const r = await get('/api/reports/ledgers/account?accountCode=1111&from=2026-01-01&to=2026-02-28&mode=voucher');
    expect(r.json().opening).toEqual({ debit: '1000', credit: '0' });
    expect(r.json().rows.map((x: { counterAccountCode: string; debit: string; credit: string }) => [x.counterAccountCode, x.debit, x.credit])).toEqual([['131', '200', '0'], ['6421', '0', '300'], ['6422', '0', '100']]);
    expect(r.json().rows[2].running).toEqual({ debit: '800', credit: '0' });
    expect(r.json().closing).toEqual({ debit: '800', credit: '0' });
    const t = await get('/api/reports/ledgers/account?accountCode=1111&from=2026-01-01&to=2026-02-28&mode=t');
    expect(t.json().creditSide).toEqual(expect.arrayContaining([{ counterAccountCode: '6421', amount: '300' }, { counterAccountCode: '6422', amount: '100' }]));
    const s = await get('/api/reports/ledgers/account?accountCode=642&from=2026-02-01&to=2026-02-28&mode=subaccount');
    expect(s.json().rows.map((x: { accountCode: string; period: { debit: string } }) => [x.accountCode, x.period.debit])).toEqual([['6421', '300'], ['6422', '100']]);
  });
  it('Sổ chi tiết 131 theo đối tượng', async () => {
    const r = await get('/api/reports/ledgers/detail?accountCode=131&from=2026-01-01&to=2026-01-31&partyCode=KH001');
    expect(r.json().rows).toHaveLength(1); expect(r.json().rows[0]).toMatchObject({ partyCode: 'KH001', debit: '500', counterAccountCode: '5113' });
    expect(r.json().closing).toEqual({ debit: '500', credit: '0' });
  });
  it('Bảng cân đối số phát sinh cân ba cột; cộng cấp; tách dư hai bên 131 theo đối tượng', async () => {
    const r = await get('/api/reports/ledgers/trial-balance?from=2026-01-01&to=2026-02-28&splitParty=true');
    const t = r.json().totals;
    expect(t.opening.debit).toBe(t.opening.credit); expect(t.period.debit).toBe(t.period.credit); expect(t.closing.debit).toBe(t.closing.credit);
    const rows = r.json().rows as { accountCode: string; isGroup: boolean; closing: { debit: string; credit: string }; period: { debit: string } }[];
    expect(rows.find((x) => x.accountCode === '131')!.closing).toEqual({ debit: '500', credit: '200' });
    expect(rows.find((x) => x.accountCode === '642')!.period.debit).toBe('400'); expect(rows.find((x) => x.accountCode === '642')!.isGroup).toBe(true);
    const net = await get('/api/reports/ledgers/trial-balance?from=2026-01-01&to=2026-02-28&splitParty=false&level=1');
    expect((net.json().rows as { accountCode: string; closing: { debit: string; credit: string } }[]).find((x) => x.accountCode === '131')!.closing).toEqual({ debit: '300', credit: '0' });
    expect((net.json().rows as { accountCode: string }[]).every((x) => x.accountCode.length <= 3)).toBe(true);
  });
  it('người thiếu cờ xem công nợ bị 403 với sổ 131', async () => {
    const username = `xemcn_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_truong', sensitiveFlags: [] } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const c2 = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    expect((await ctx.app.inject({ method: 'GET', url: '/api/reports/ledgers/account?accountCode=131&from=2026-01-01&to=2026-01-31&mode=voucher', headers: { cookie: c2 } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/reports/ledgers/account?accountCode=1111&from=2026-01-01&to=2026-01-31&mode=voucher', headers: { cookie: c2 } })).statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/api test -- test/ledgers.test.ts` → FAIL 404.

- [ ] **Step 3: Truy vấn sổ sách**

`apps/api/src/modules/reporting/ledgers.ts`:

```ts
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, sum, ZERO, type Decimal } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

type Trx = Transaction<Database>;
export interface Side { debit: string; credit: string }
const side = (net: Decimal): Side => ({ debit: net.gt(0) ? net.toString() : '0', credit: net.lt(0) ? net.neg().toString() : '0' });
const dayBefore = (iso: string) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const POSTED = sql`v.state IN ('posted','reversed')`;

export async function openingNet(trx: Trx, tenantId: string, prefix: string, from: string, filters: { partyId?: string | null } = {}): Promise<Decimal> {
  const r = await sql<{ net: string | null }>`SELECT sum(b.debit - b.credit)::text AS net FROM fn_balances_at(${tenantId}::uuid, ${dayBefore(from)}::date) b JOIN account a ON a.id = b.account_id
    WHERE a.code LIKE ${prefix + '%'} ${filters.partyId ? sql`AND b.party_id = ${filters.partyId}::uuid` : sql``}`.execute(trx);
  return D(r.rows[0]?.net ?? '0');
}
export async function openingSplit(trx: Trx, tenantId: string, prefix: string, from: string): Promise<Side> {
  const r = await sql<{ d: string | null; c: string | null }>`SELECT sum(b.debit)::text AS d, sum(b.credit)::text AS c FROM fn_balances_at(${tenantId}::uuid, ${dayBefore(from)}::date) b JOIN account a ON a.id = b.account_id WHERE a.code LIKE ${prefix + '%'}`.execute(trx);
  return { debit: r.rows[0]?.d ?? '0', credit: r.rows[0]?.c ?? '0' };
}

export async function generalJournal(trx: Trx, f: { from: string; to: string }) {
  const rows = await sql<{ postingDate: string; voucherId: string; voucherNo: string; voucherType: string; documentDate: string; description: string | null; accountCode: string; accountName: string; debit: string; credit: string }>`
    SELECT v.posting_date AS "postingDate", v.id AS "voucherId", v.voucher_no AS "voucherNo", v.voucher_type AS "voucherType", v.document_date AS "documentDate", coalesce(l.description, v.description) AS description,
           a.code AS "accountCode", a.name AS "accountName", l.debit::text AS debit, l.credit::text AS credit
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE ${POSTED} AND v.posting_date BETWEEN ${f.from}::date AND ${f.to}::date
    ORDER BY v.posting_date, v.voucher_type, v.seq_no, l.line_no`.execute(trx);
  return { rows: rows.rows, totalDebit: sum(rows.rows.map((r) => r.debit)).toString(), totalCredit: sum(rows.rows.map((r) => r.credit)).toString() };
}

async function pairRows(trx: Trx, prefix: string, f: { from: string; to: string }, filters: { partyId?: string | null; costItemId?: number | null; projectId?: number | null; departmentId?: number | null } = {}) {
  // Mỗi dòng của tài khoản được tách theo đối ứng từ voucher_pair; lọc chiều phân tích qua dòng gốc.
  return (await sql<{ postingDate: string; voucherId: string; voucherNo: string; description: string | null; counterAccountCode: string; debit: string; credit: string; partyCode: string | null; partyName: string | null; costItemCode: string | null; projectCode: string | null; departmentCode: string | null; lineAccountCode: string }>`
    WITH pr AS (
      SELECT p.voucher_id, p.posting_date, ad.code AS dcode, ac.code AS ccode, p.amount, p.debit_party_id, p.credit_party_id, p.debit_account_id, p.credit_account_id
      FROM voucher_pair p JOIN account ad ON ad.id = p.debit_account_id JOIN account ac ON ac.id = p.credit_account_id
      WHERE p.posting_date BETWEEN ${f.from}::date AND ${f.to}::date AND (ad.code LIKE ${prefix + '%'} OR ac.code LIKE ${prefix + '%'}))
    SELECT pr.posting_date AS "postingDate", v.id AS "voucherId", v.voucher_no AS "voucherNo", v.description,
           CASE WHEN pr.dcode LIKE ${prefix + '%'} THEN pr.ccode ELSE pr.dcode END AS "counterAccountCode",
           CASE WHEN pr.dcode LIKE ${prefix + '%'} THEN pr.amount ELSE 0 END::text AS debit, CASE WHEN pr.dcode LIKE ${prefix + '%'} THEN 0 ELSE pr.amount END::text AS credit,
           pt.code AS "partyCode", pt.name AS "partyName", ci.code AS "costItemCode", pj.code AS "projectCode", dp.code AS "departmentCode",
           CASE WHEN pr.dcode LIKE ${prefix + '%'} THEN pr.dcode ELSE pr.ccode END AS "lineAccountCode"
    FROM pr JOIN voucher v ON v.id = pr.voucher_id
    LEFT JOIN LATERAL (SELECT l.* FROM voucher_line l WHERE l.voucher_id = pr.voucher_id AND l.account_id = CASE WHEN pr.dcode LIKE ${prefix + '%'} THEN pr.debit_account_id ELSE pr.credit_account_id END
                       AND l.party_id IS NOT DISTINCT FROM CASE WHEN pr.dcode LIKE ${prefix + '%'} THEN pr.debit_party_id ELSE pr.credit_party_id END LIMIT 1) ln ON true
    LEFT JOIN party pt ON pt.id = ln.party_id LEFT JOIN cost_item ci ON ci.id = ln.cost_item_id LEFT JOIN project pj ON pj.id = ln.project_id LEFT JOIN department dp ON dp.id = ln.department_id
    WHERE ${POSTED}
      ${filters.partyId ? sql`AND ln.party_id = ${filters.partyId}::uuid` : sql``} ${filters.costItemId ? sql`AND ln.cost_item_id = ${filters.costItemId}` : sql``}
      ${filters.projectId ? sql`AND ln.project_id = ${filters.projectId}` : sql``} ${filters.departmentId ? sql`AND ln.department_id = ${filters.departmentId}` : sql``}
    ORDER BY pr.posting_date, v.voucher_type, v.seq_no, "counterAccountCode"`.execute(trx)).rows;
}

export async function accountLedger(trx: Trx, tenantId: string, f: { accountCode: string; from: string; to: string; mode: 'voucher' | 'subaccount' | 't' }) {
  const acc = await trx.selectFrom('account').selectAll().where('code', '=', f.accountCode).executeTakeFirst();
  if (!acc) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản ${f.accountCode}`, 404);
  const openNet = await openingNet(trx, tenantId, f.accountCode, f.from);
  const rows = await pairRows(trx, f.accountCode, f);
  if (f.mode === 'subaccount') {
    const leaves = await trx.selectFrom('account').select(['code', 'name']).where('code', 'like', `${f.accountCode}%`).where('is_group', '=', false).orderBy('code').execute();
    const out = [];
    for (const l of leaves) {
      const o = await openingNet(trx, tenantId, l.code, f.from); const mine = rows.filter((r) => r.lineAccountCode === l.code);
      const d = sum(mine.map((r) => r.debit)); const c = sum(mine.map((r) => r.credit));
      if (o.isZero() && d.isZero() && c.isZero()) continue;
      out.push({ accountCode: l.code, accountName: l.name, opening: side(o), period: { debit: d.toString(), credit: c.toString() }, closing: side(o.plus(d).minus(c)) });
    }
    return { opening: side(openNet), rows: out, totalDebit: sum(rows.map((r) => r.debit)).toString(), totalCredit: sum(rows.map((r) => r.credit)).toString(), closing: side(openNet.plus(sum(rows.map((r) => r.debit))).minus(sum(rows.map((r) => r.credit)))) };
  }
  if (f.mode === 't') {
    const agg = (key: 'debit' | 'credit') => { const m = new Map<string, Decimal>(); for (const r of rows) if (!D(r[key]).isZero()) m.set(r.counterAccountCode, (m.get(r.counterAccountCode) ?? ZERO).plus(r[key])); return [...m].map(([counterAccountCode, a]) => ({ counterAccountCode, amount: a.toString() })).sort((a, b) => a.counterAccountCode.localeCompare(b.counterAccountCode)); };
    return { opening: side(openNet), debitSide: agg('debit'), creditSide: agg('credit'), totalDebit: sum(rows.map((r) => r.debit)).toString(), totalCredit: sum(rows.map((r) => r.credit)).toString(), closing: side(openNet.plus(sum(rows.map((r) => r.debit))).minus(sum(rows.map((r) => r.credit)))) };
  }
  let run = openNet;
  const out = rows.map((r) => { run = run.plus(r.debit).minus(r.credit); return { ...r, running: side(run) }; });
  return { opening: side(openNet), rows: out, totalDebit: sum(rows.map((r) => r.debit)).toString(), totalCredit: sum(rows.map((r) => r.credit)).toString(), closing: side(run) };
}

export async function accountDetail(trx: Trx, tenantId: string, f: { accountCode: string; from: string; to: string; partyCode?: string | undefined; costItemCode?: string | undefined; projectCode?: string | undefined; departmentCode?: string | undefined }) {
  const id = async (table: 'party' | 'cost_item' | 'project' | 'department', code?: string) => code ? ((await trx.selectFrom(table).select('id').where('code', '=', code).executeTakeFirst()) as { id: string | number } | undefined)?.id ?? null : undefined;
  const filters = { partyId: (await id('party', f.partyCode)) as string | null | undefined, costItemId: (await id('cost_item', f.costItemCode)) as number | null | undefined, projectId: (await id('project', f.projectCode)) as number | null | undefined, departmentId: (await id('department', f.departmentCode)) as number | null | undefined };
  const openNet = filters.partyId ? await openingNet(trx, tenantId, f.accountCode, f.from, { partyId: filters.partyId }) : (f.costItemCode || f.projectCode || f.departmentCode) ? ZERO : await openingNet(trx, tenantId, f.accountCode, f.from);
  const rows = await pairRows(trx, f.accountCode, f, filters);
  let run = openNet;
  return { opening: side(openNet), rows: rows.map((r) => { run = run.plus(r.debit).minus(r.credit); return { ...r, running: side(run) }; }), closing: side(run) };
}

export async function trialBalance(trx: Trx, tenantId: string, f: { from: string; to: string; level?: number | undefined; splitParty?: boolean | undefined }) {
  const accounts = await trx.selectFrom('account').select(['id', 'code', 'name', 'is_group', 'subledger_kind']).where('is_active', '=', true).orderBy('code').execute();
  const open = await sql<{ account_id: number; party_id: string; d: string; c: string }>`SELECT b.account_id, b.party_id, sum(b.debit)::text AS d, sum(b.credit)::text AS c FROM fn_balances_at(${tenantId}::uuid, ${dayBefore(f.from)}::date) b GROUP BY 1, 2`.execute(trx);
  const close = await sql<{ account_id: number; party_id: string; d: string; c: string }>`SELECT b.account_id, b.party_id, sum(b.debit)::text AS d, sum(b.credit)::text AS c FROM fn_balances_at(${tenantId}::uuid, ${f.to}::date) b GROUP BY 1, 2`.execute(trx);
  const mv = await sql<{ account_id: number; d: string; c: string }>`SELECT l.account_id, sum(l.debit)::text AS d, sum(l.credit)::text AS c FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
    WHERE ${POSTED} AND v.posting_date BETWEEN ${f.from}::date AND ${f.to}::date GROUP BY l.account_id`.execute(trx);
  const leafSide = (rows: { account_id: number; d: string; c: string }[], accId: number, split: boolean): Side => {
    const mine = rows.filter((r) => r.account_id === accId);
    if (split) return { debit: sum(mine.map((r) => r.d)).toString(), credit: sum(mine.map((r) => r.c)).toString() };
    return side(sum(mine.map((r) => r.d)).minus(sum(mine.map((r) => r.c))));
  };
  const leaf = new Map<string, { opening: Side; period: Side; closing: Side }>();
  for (const a of accounts.filter((x) => !x.is_group)) {
    const split = !!f.splitParty && ['receivable', 'payable'].includes(a.subledger_kind ?? '');
    const m = mv.rows.find((r) => r.account_id === a.id);
    leaf.set(a.code, { opening: leafSide(open.rows, a.id, split), period: { debit: m?.d ?? '0', credit: m?.c ?? '0' }, closing: leafSide(close.rows, a.id, split) });
  }
  const add = (x: Side, y: Side): Side => ({ debit: D(x.debit).plus(y.debit).toString(), credit: D(x.credit).plus(y.credit).toString() });
  const rows = accounts.map((a) => {
    const kids = [...leaf.entries()].filter(([code]) => code.startsWith(a.code)).map(([, v]) => v);
    const agg = kids.reduce((acc, v) => ({ opening: add(acc.opening, v.opening), period: add(acc.period, v.period), closing: add(acc.closing, v.closing) }), { opening: { debit: '0', credit: '0' }, period: { debit: '0', credit: '0' }, closing: { debit: '0', credit: '0' } });
    const netIfGroup = (s: Side, split: boolean) => (a.is_group && !split ? side(D(s.debit).minus(s.credit)) : s);
    const split = !!f.splitParty && ['receivable', 'payable'].includes(a.subledger_kind ?? '');
    return { accountCode: a.code, accountName: a.name, level: a.code.length <= 3 ? 1 : a.code.length - 2, isGroup: a.is_group, opening: netIfGroup(agg.opening, split), period: agg.period, closing: netIfGroup(agg.closing, split) };
  }).filter((r) => [r.opening, r.period, r.closing].some((s) => s.debit !== '0' || s.credit !== '0')).filter((r) => !f.level || r.level <= f.level);
  const tops = rows.filter((r) => r.level === 1);
  const totals = tops.reduce((acc, r) => ({ opening: add(acc.opening, r.opening), period: add(acc.period, r.period), closing: add(acc.closing, r.closing) }), { opening: { debit: '0', credit: '0' }, period: { debit: '0', credit: '0' }, closing: { debit: '0', credit: '0' } });
  return { rows, totals };
}

export function assertSensitive(auth: { sensitive: Set<string> }, acc: { subledger_kind: string | null; code: string }) {
  if (acc.subledger_kind === 'receivable' && !auth.sensitive.has('view_receivable')) throw new AppError('FORBIDDEN', 'Không có quyền xem công nợ phải thu', 403);
  if (acc.subledger_kind === 'payable' && !auth.sensitive.has('view_payable')) throw new AppError('FORBIDDEN', 'Không có quyền xem công nợ phải trả', 403);
  if (acc.code.startsWith('632') && !auth.sensitive.has('view_cost')) throw new AppError('FORBIDDEN', 'Không có quyền xem giá vốn', 403);
}
```

Lưu ý về cấp tài khoản trong `trialBalance`: `level` = 1 cho mã ≤ 3 ký tự, 2 cho 4 ký tự, 3 cho 5 ký tự (TT: cấp 1 ba chữ số). Các dòng tổng hợp lấy tổng con theo tiền tố, nên tổng cấp 1 chính là tổng toàn sổ.

`apps/api/src/modules/reporting/routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { accountDetail, accountLedger, assertSensitive, generalJournal, trialBalance } from './ledgers.js';
import { AppError } from '../../plugins/errors.js';

const range = { from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) };
const routes: FastifyPluginAsyncZod = async (app) => {
  const guard = async (req: Parameters<typeof app.withTenant>[0], code: string) => app.withTenant(req, async (trx) => {
    const a = await trx.selectFrom('account').select(['code', 'subledger_kind']).where('code', '=', code).executeTakeFirst();
    if (!a) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản ${code}`, 404); assertSensitive(req.auth!, a); });
  app.get('/api/reports/ledgers/general-journal', { preHandler: app.requirePermission('report.view'), schema: { querystring: z.object(range) } }, async (req) => app.withTenant(req, (trx) => generalJournal(trx, req.query)));
  app.get('/api/reports/ledgers/account', { preHandler: app.requirePermission('report.view'), schema: { querystring: z.object({ ...range, accountCode: z.string(), mode: z.enum(['voucher', 'subaccount', 't']).default('voucher') }) } }, async (req) => {
    await guard(req, req.query.accountCode); return app.withTenant(req, (trx) => accountLedger(trx, req.auth!.tenantId!, req.query)); });
  app.get('/api/reports/ledgers/detail', { preHandler: app.requirePermission('report.view'), schema: { querystring: z.object({ ...range, accountCode: z.string(), partyCode: z.string().optional(), costItemCode: z.string().optional(), projectCode: z.string().optional(), departmentCode: z.string().optional() }) } }, async (req) => {
    await guard(req, req.query.accountCode); return app.withTenant(req, (trx) => accountDetail(trx, req.auth!.tenantId!, req.query)); });
  app.get('/api/reports/ledgers/trial-balance', { preHandler: app.requirePermission('report.view'), schema: { querystring: z.object({ ...range, level: z.coerce.number().int().min(1).max(6).optional(), splitParty: z.enum(['true', 'false']).default('true') }) } }, async (req) =>
    app.withTenant(req, (trx) => trialBalance(trx, req.auth!.tenantId!, { ...req.query, splitParty: req.query.splitParty === 'true' })));
};
export default routes;
```

Đăng ký `reportingRoutes` trong `app.ts`.

- [ ] **Step 4: Chạy test**

Run: `pnpm -F @kt/api test -- test/ledgers.test.ts` → PASS 5.

- [ ] **Step 5: Màn hình sổ sách với truy ngược**

`apps/web/src/pages/Ledgers.tsx`: `Tabs` bốn thẻ (Nhật ký chung, Sổ Cái, Sổ chi tiết, Bảng cân đối số phát sinh); bộ lọc chung nhớ theo người dùng (`useRememberedFilter('ledgers', { from, to, accountCode, mode, level, splitParty })`), ô tài khoản dùng `LookupSelect` với `accountFetcher`, ô đối tượng/khoản mục/vụ việc/bộ phận dùng `LookupSelect` danh mục; bảng `KeyboardGrid` chỉ đọc với cột số định dạng `formatVnNumber`; dòng có `voucherId` → nhấn đúp hoặc Enter mở `/chung-tu/phieu-ke-toan/$id` ở tab mới (truy ngược chứng từ); Bảng cân đối số phát sinh có nút chọn cấp 1/2/3/Tất cả và công tắc "Tách dư hai bên theo đối tượng"; nhấn đúp một dòng BCĐPS mở thẻ Sổ Cái với tài khoản đó (truy ngược cấp 1). Route `/bao-cao/so-sach`, nhóm menu "Báo cáo" `{ key: 'baocao', label: 'Báo cáo', to: '/bao-cao', children: [{ key: 'ledgers', label: 'Sổ sách kế toán', to: '/bao-cao/so-sach', permission: 'report.view' }] }`.

- [ ] **Step 6: Commit**

```bash
git add apps/api apps/web
git commit -m "feat(reporting): sổ nhật ký chung, sổ cái ba dạng, sổ chi tiết và bảng cân đối số phát sinh có truy ngược"
```

---

### Task 23: Engine công thức dòng báo cáo, bảng `report_def`/`report_line`, bộ B01/B02/B03 TT99 và TT133, so sánh năm trước, truy ngược chỉ tiêu, sửa công thức và nạp lại mẫu

**Files:**
- Create: `packages/domain/src/reportFormula.ts`; Modify: `packages/domain/src/index.ts`
- Create: `packages/db/migrations/0012_bao_cao.sql`; Modify: `packages/db/src/types.ts`, `packages/db/src/reference.ts` (nạp `report_template` từ CSV)
- Create: `packages/coa-data/data/reports/tt99/{B01,B02,B03}.csv`, `packages/coa-data/data/reports/tt133/{B01,B02,B03}.csv`, `packages/coa-data/data/reports/status.json`; Modify: `packages/coa-data/src/load.ts` (`loadReportTemplates()`)
- Create: `apps/api/src/modules/reporting/financial.ts`; Modify: `apps/api/src/modules/reporting/routes.ts`, `apps/api/src/modules/core/fiscalYears.ts` (sao chép mẫu vào `report_def` khi tạo năm)
- Create: `apps/web/src/pages/Financial.tsx`; Modify: `apps/web/src/router.tsx`
- Test: `packages/domain/test/reportFormula.test.ts`, `packages/coa-data/test/reports.test.ts`, `apps/api/test/financial.test.ts`

**Interfaces:**
- Consumes: `fn_balances_at`, `voucher_pair`, `voucher_line` (Task 14, 20); `formNoFor` (Task 18).
- Produces:
  - Ngữ pháp công thức (một dòng `report_line` có `source` và `side`; công thức là biểu thức cộng/trừ các hạng):
    ```
    expr       := term (('+' | '-') term)*
    term       := '[' LINE ']' | pair | accountRef | NUMBER
    accountRef := CODE ( '(' CODE (',' CODE)* ')' )?      -- '131(1312)' = tiền tố 131 trừ tiền tố 1312
    pair       := 'N' codes '/' 'C' codes                    -- đối ứng: Nợ các TK / Có các TK, ví dụ N911/C632
    codes      := CODE (',' CODE)*
    ```
    `source ∈ 'balance' | 'movement' | 'pair' | 'lines'`; `side ∈ 'debit' | 'credit' | 'net_debit' | 'net_credit'`. Với `balance`: `debit` = tổng số dư Nợ (theo từng đối tượng với tài khoản công nợ, theo tài khoản với loại khác), `credit` tương tự, `net_debit` = ΣNợ − ΣCó (có dấu), `net_credit` = ngược lại. Với `movement`: phát sinh trong kỳ **không gồm chứng từ `is_closing`**, `debit`/`credit` = tổng phát sinh một bên, `net_*` = chênh lệch có dấu. `pair` lấy từ `voucher_pair` trong kỳ (gồm cả kết chuyển). `lines` cộng/trừ dòng khác qua `[MÃ]`.
  - Domain: `parseFormula(text: string): Expr` (ném `Error('Công thức ... : <lý do>')`), `type Expr = { kind: 'bin'; op: '+'|'-'; left: Expr; right: Expr } | { kind: 'line'; code: string } | { kind: 'pair'; debit: string[]; credit: string[] } | { kind: 'account'; prefix: string; exclude: string[] } | { kind: 'num'; value: string }`; `formulaRefs(expr): { lines: string[]; accounts: string[] }`; `interface Resolver { account(ref: { prefix; exclude }, source: 'balance'|'movement', side: Side): Promise<Decimal>; pair(debit: string[], credit: string[]): Promise<Decimal> }`; `evaluateReport(lines: ReportLineDef[], resolver): Promise<Map<string, Decimal>>` với `ReportLineDef = { lineCode; formula: string | null; source; side }` (tính theo thứ tự phụ thuộc, phát hiện vòng lặp → `Error('Vòng lặp ...')`).
  - Bảng toàn cục `report_template(regime, report_code, line_code, label, parent_line_code, source, side, formula, sort_order, is_bold, negate, note_ref)`; bảng theo công ty `report_def(id uuid, tenant_id, regime, report_code, name, form_no, issued_by, UNIQUE(tenant_id, regime, report_code))`, `report_line(id, tenant_id, report_def_id, line_code, label, parent_line_code, source, side, formula, sort_order, is_bold, negate, note_ref, UNIQUE(report_def_id, line_code))`.
  - CSV mẫu cột: `line_code,label,parent_line_code,source,side,formula,is_bold,negate,note_ref`. **Nội dung TT99 (Phụ lục IV TT 99/2025) và TT133 (Phụ lục 2 TT 133/2016) phải nhập từ văn bản gốc và đối chiếu với `reference/sunsoft/DesBC_*_99.csv`, `DesBC_*_133.csv`; không bịa chỉ tiêu.** `status.json` ghi `complete` theo từng bộ; test đối chiếu chỉ chạy khi `complete = true`.
  - `copyReportTemplates(trx, tenantId, regime): Promise<number>`; `evaluateFinancialReport(trx, tenantId, { reportCode, from, to, comparePrevYear }): Promise<FinancialResult>` với `FinancialResult = { reportCode; name; formNo; issuedBy; period: { from; to }; rows: { lineCode; label; parentLineCode; isBold; negate; noteRef; current: string; previous: string | null }[] }` (B01 dùng số dư tại `to`; "số đầu năm" = số dư tại ngày trước ngày đầu năm tài chính chứa `to`; B02/B03 dùng khoảng `from..to`; `comparePrevYear` tính cùng khoảng lùi 1 năm).
  - `drillLine(trx, tenantId, { reportCode, lineCode, from, to }): Promise<{ accounts: { accountCode; accountName; partyCode?; amount }[] }>` (truy ngược cấp 1: chỉ tiêu → tài khoản/đối tượng; cấp 2 dùng sổ sách Task 22).
  - Route (`report.view`): `GET /api/reports/financial?regime=&year=` (danh sách báo cáo); `GET /api/reports/financial/:code?from&to&comparePrevYear=true`; `GET /api/reports/financial/:code/lines/:lineCode?from&to`; (`report_def.update`): `GET /api/report-defs/:code?regime=` → dòng; `PUT /api/report-defs/:code { regime, lines }`; `POST /api/report-defs/:code/reload { regime }`.

- [ ] **Step 1: Viết test bộ phân tích và đánh giá công thức (thất bại)**

`packages/domain/test/reportFormula.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { D } from '../src/money.js';
import { evaluateReport, formulaRefs, parseFormula, type Resolver } from '../src/reportFormula.js';

describe('parseFormula', () => {
  it('phân tích tiền tố, loại trừ, dòng, đối ứng, số', () => {
    expect(parseFormula('111 + 112 + 113')).toEqual({ kind: 'bin', op: '+', left: { kind: 'bin', op: '+', left: { kind: 'account', prefix: '111', exclude: [] }, right: { kind: 'account', prefix: '112', exclude: [] } }, right: { kind: 'account', prefix: '113', exclude: [] } });
    expect(parseFormula('131(1312,1313)')).toEqual({ kind: 'account', prefix: '131', exclude: ['1312', '1313'] });
    expect(parseFormula('[100] + [200]')).toEqual({ kind: 'bin', op: '+', left: { kind: 'line', code: '100' }, right: { kind: 'line', code: '200' } });
    expect(parseFormula('N911/C632 - N632/C911')).toEqual({ kind: 'bin', op: '-', left: { kind: 'pair', debit: ['911'], credit: ['632'] }, right: { kind: 'pair', debit: ['632'], credit: ['911'] } });
    expect(parseFormula('N111,112/C511,131')).toEqual({ kind: 'pair', debit: ['111', '112'], credit: ['511', '131'] });
    expect(parseFormula('0')).toEqual({ kind: 'num', value: '0' });
  });
  it('báo lỗi công thức sai', () => {
    expect(() => parseFormula('111 +')).toThrow(/Công thức/); expect(() => parseFormula('[100')).toThrow(/Công thức/); expect(() => parseFormula('N911/632')).toThrow(/Công thức/);
  });
  it('formulaRefs liệt kê dòng và tài khoản tham chiếu', () => {
    expect(formulaRefs(parseFormula('[10] - 131(1312) + N911/C632'))).toEqual({ lines: ['10'], accounts: ['131', '1312', '911', '632'] });
  });
});

describe('evaluateReport', () => {
  const resolver: Resolver = {
    account: async (ref, source, side) => D(ref.prefix === '111' ? 100 : ref.prefix === '131' ? (side === 'debit' ? 500 : side === 'credit' ? 200 : 300) : 0).times(source === 'movement' ? 2 : 1),
    pair: async (d, c) => D(d[0] === '911' && c[0] === '632' ? 700 : 0),
  };
  it('tính theo thứ tự phụ thuộc, không phụ thuộc thứ tự khai báo', async () => {
    const r = await evaluateReport([
      { lineCode: '100', formula: '[110] + [130]', source: 'lines', side: 'net_debit' },
      { lineCode: '110', formula: '111', source: 'balance', side: 'net_debit' },
      { lineCode: '130', formula: '131', source: 'balance', side: 'debit' },
      { lineCode: '312', formula: '131', source: 'balance', side: 'credit' },
      { lineCode: '11', formula: 'N911/C632', source: 'pair', side: 'net_debit' },
      { lineCode: '01', formula: '111', source: 'movement', side: 'credit' },
      { lineCode: 'TXT', formula: null, source: 'lines', side: 'net_debit' },
    ], resolver);
    expect(r.get('110')!.toString()).toBe('100'); expect(r.get('130')!.toString()).toBe('500'); expect(r.get('312')!.toString()).toBe('200');
    expect(r.get('100')!.toString()).toBe('600'); expect(r.get('11')!.toString()).toBe('700'); expect(r.get('01')!.toString()).toBe('200'); expect(r.get('TXT')!.toString()).toBe('0');
  });
  it('phát hiện vòng lặp và dòng tham chiếu không tồn tại', async () => {
    await expect(evaluateReport([{ lineCode: 'A', formula: '[B]', source: 'lines', side: 'net_debit' }, { lineCode: 'B', formula: '[A]', source: 'lines', side: 'net_debit' }], resolver)).rejects.toThrow(/Vòng lặp/);
    await expect(evaluateReport([{ lineCode: 'A', formula: '[Z]', source: 'lines', side: 'net_debit' }], resolver)).rejects.toThrow(/không tồn tại/);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/domain test -- test/reportFormula.test.ts` → FAIL.

- [ ] **Step 3: Viết `reportFormula.ts`**

```ts
import { D, ZERO, type Decimal } from './money.js';

export type Side = 'debit' | 'credit' | 'net_debit' | 'net_credit';
export type Source = 'balance' | 'movement' | 'pair' | 'lines';
export type Expr = { kind: 'bin'; op: '+' | '-'; left: Expr; right: Expr } | { kind: 'line'; code: string } | { kind: 'pair'; debit: string[]; credit: string[] } | { kind: 'account'; prefix: string; exclude: string[] } | { kind: 'num'; value: string };
export interface ReportLineDef { lineCode: string; formula: string | null; source: Source; side: Side }
export interface Resolver { account(ref: { prefix: string; exclude: string[] }, source: 'balance' | 'movement', side: Side): Promise<Decimal>; pair(debit: string[], credit: string[]): Promise<Decimal> }

type Tok = { t: 'num' | 'code' | 'line' | 'op' | 'lp' | 'rp' | 'comma' | 'N' | 'C' | 'slash'; v: string };
function tokenize(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '[') { const j = src.indexOf(']', i); if (j < 0) throw new Error(`Công thức "${src}": thiếu ]`); out.push({ t: 'line', v: src.slice(i + 1, j).trim() }); i = j + 1; continue; }
    if (ch === '+' || ch === '-') { out.push({ t: 'op', v: ch }); i++; continue; }
    if (ch === '(') { out.push({ t: 'lp', v: ch }); i++; continue; }
    if (ch === ')') { out.push({ t: 'rp', v: ch }); i++; continue; }
    if (ch === ',') { out.push({ t: 'comma', v: ch }); i++; continue; }
    if (ch === '/') { out.push({ t: 'slash', v: ch }); i++; continue; }
    if (ch === 'N' || ch === 'C') { out.push({ t: ch, v: ch }); i++; continue; }
    if (/\d/.test(ch)) { let j = i; while (j < src.length && /[\d.]/.test(src[j]!)) j++; out.push({ t: 'code', v: src.slice(i, j) }); i = j; continue; }
    throw new Error(`Công thức "${src}": ký tự không hợp lệ "${ch}"`);
  }
  return out;
}

export function parseFormula(src: string): Expr {
  const toks = tokenize(src); let p = 0;
  const peek = () => toks[p]; const next = () => toks[p++]!;
  const fail = (why: string): never => { throw new Error(`Công thức "${src}": ${why}`); };
  const codes = (): string[] => { const cs: string[] = []; do { const t = next(); if (!t || t.t !== 'code') fail('cần mã tài khoản'); cs.push(t.v); } while (peek()?.t === 'comma' && next()); return cs; };
  const term = (): Expr => {
    const t = peek(); if (!t) return fail('thiếu hạng tử');
    if (t.t === 'line') { next(); return { kind: 'line', code: t.v }; }
    if (t.t === 'N') { next(); const d = codes(); if (peek()?.t !== 'slash') fail('cần / sau danh sách Nợ'); next(); if (peek()?.t !== 'C') fail('cần C sau /'); next(); return { kind: 'pair', debit: d, credit: codes() }; }
    if (t.t === 'code') {
      next();
      if (t.v.includes('.')) return { kind: 'num', value: t.v };
      let exclude: string[] = [];
      if (peek()?.t === 'lp') { next(); exclude = codes(); if (peek()?.t !== 'rp') fail('thiếu )'); next(); }
      // số nguyên đứng một mình không phải mã tài khoản khi không có chữ số đầu 1-9 hợp lệ: coi '0' là số
      if (t.v === '0' && exclude.length === 0) return { kind: 'num', value: '0' };
      return { kind: 'account', prefix: t.v, exclude };
    }
    return fail(`hạng tử không hợp lệ "${t.v}"`);
  };
  let left = term();
  while (peek()?.t === 'op') { const op = next().v as '+' | '-'; const right = term(); left = { kind: 'bin', op, left, right }; }
  if (p < toks.length) fail(`dư ký hiệu "${toks[p]!.v}"`);
  return left;
}

export function formulaRefs(e: Expr): { lines: string[]; accounts: string[] } {
  const lines: string[] = []; const accounts: string[] = [];
  const walk = (x: Expr) => {
    if (x.kind === 'bin') { walk(x.left); walk(x.right); } else if (x.kind === 'line') lines.push(x.code);
    else if (x.kind === 'account') accounts.push(x.prefix, ...x.exclude); else if (x.kind === 'pair') accounts.push(...x.debit, ...x.credit);
  };
  walk(e); return { lines, accounts };
}

export async function evaluateReport(lines: ReportLineDef[], resolver: Resolver): Promise<Map<string, Decimal>> {
  const byCode = new Map(lines.map((l) => [l.lineCode, l])); const parsed = new Map<string, Expr | null>(); const value = new Map<string, Decimal>(); const visiting = new Set<string>();
  for (const l of lines) parsed.set(l.lineCode, l.formula && l.formula.trim() !== '' ? parseFormula(l.formula) : null);
  const evalExpr = async (e: Expr, l: ReportLineDef): Promise<Decimal> => {
    switch (e.kind) {
      case 'num': return D(e.value);
      case 'bin': { const a = await evalExpr(e.left, l); const b = await evalExpr(e.right, l); return e.op === '+' ? a.plus(b) : a.minus(b); }
      case 'line': return evalLine(e.code);
      case 'pair': return resolver.pair(e.debit, e.credit);
      case 'account': return resolver.account({ prefix: e.prefix, exclude: e.exclude }, l.source === 'movement' ? 'movement' : 'balance', l.side);
    }
  };
  const evalLine = async (code: string): Promise<Decimal> => {
    if (value.has(code)) return value.get(code)!;
    const l = byCode.get(code); if (!l) throw new Error(`Dòng [${code}] không tồn tại`);
    if (visiting.has(code)) throw new Error(`Vòng lặp tại dòng [${code}]`);
    visiting.add(code);
    const e = parsed.get(code) ?? null; const v = e ? await evalExpr(e, l) : ZERO;
    visiting.delete(code); value.set(code, v); return v;
  };
  for (const l of lines) await evalLine(l.lineCode);
  return value;
}
```

Thêm `export * from './reportFormula.js';`. Run test → PASS.

- [ ] **Step 4: Dữ liệu mẫu báo cáo và test cấu trúc**

`packages/coa-data/data/reports/status.json`:

```json
{ "tt99": { "B01": false, "B02": false, "B03": false, "source": "" }, "tt133": { "B01": false, "B02": false, "B03": false, "source": "" },
  "note": "Nhập đủ chỉ tiêu từ Phụ lục IV TT 99/2025 (B01-DN, B02-DN, B03-DN trực tiếp) và Phụ lục 2 TT 133/2016 (B01a-DNN, B02-DNN, B03-DNN). Đối chiếu từng dòng với reference/sunsoft/DesBC_CDKT_B01_99.csv, DesBC_KQKD_LAILO_99.csv, DesBC_LCTT_TTIEP_99.csv (và bản _133). Khi xong đặt true và ghi source." }
```

Mỗi file CSV tạo với dòng tiêu đề và **các dòng ví dụ định dạng** sau (chuyển thể từ `DesBC_*_99` của SUNSOFT; giữ lại khi nhập đủ, kiểm tra lại mã chỉ tiêu với văn bản gốc):

`data/reports/tt99/B01.csv` (ví dụ 6 dòng đầu):

```
line_code,label,parent_line_code,source,side,formula,is_bold,negate,note_ref
100,A. TÀI SẢN NGẮN HẠN,,lines,net_debit,[110]+[130],1,0,
110,I. Tiền và các khoản tương đương tiền,100,lines,net_debit,[111]+[112],1,0,
111,1. Tiền,110,balance,net_debit,111+112+113,0,0,
112,2. Các khoản tương đương tiền,110,balance,net_debit,1281,0,0,
130,III. Các khoản phải thu ngắn hạn,100,lines,net_debit,[131]+[136],1,0,
131,1. Phải thu ngắn hạn của khách hàng,130,balance,debit,131,0,0,
136,6. Phải thu ngắn hạn khác,130,balance,debit,1388+334+338(3387),0,0,
312,2. Người mua trả tiền trước ngắn hạn,310,balance,credit,131,0,0,
```

`data/reports/tt99/B02.csv` (ví dụ):

```
line_code,label,parent_line_code,source,side,formula,is_bold,negate,note_ref
01,1. Doanh thu bán hàng và cung cấp dịch vụ,,movement,net_credit,511,0,0,
02,2. Các khoản giảm trừ doanh thu,,movement,net_debit,521,0,0,
10,3. Doanh thu thuần về bán hàng và cung cấp dịch vụ,,lines,net_debit,[01]-[02],1,0,
11,4. Giá vốn hàng bán,,movement,net_debit,632,0,0,
20,5. Lợi nhuận gộp về bán hàng và cung cấp dịch vụ,,lines,net_debit,[10]-[11],1,0,
```

`data/reports/tt99/B03.csv` (ví dụ, nguồn đối ứng):

```
line_code,label,parent_line_code,source,side,formula,is_bold,negate,note_ref
01,1. Tiền thu từ bán hàng cung cấp dịch vụ và doanh thu khác,,pair,net_debit,N111,112/C511,131,0,0,
02,2. Tiền chi trả cho người cung cấp hàng hóa và dịch vụ,,pair,net_debit,N331,152,153,156,641,642/C111,112,0,1,
03,3. Tiền chi trả cho người lao động,,pair,net_debit,N334/C111,112,0,1,
```

`packages/coa-data/src/load.ts` thêm:

```ts
export interface ReportTemplateRow { regime: Regime; reportCode: string; lineCode: string; label: string; parentLineCode: string | null; source: string; side: string; formula: string | null; sortOrder: number; isBold: boolean; negate: boolean; noteRef: string | null }
export function loadReportTemplates(): ReportTemplateRow[] {
  const out: ReportTemplateRow[] = [];
  for (const regime of ['TT99', 'TT133'] as Regime[]) for (const code of ['B01', 'B02', 'B03']) {
    const p = dataPath('reports', regime.toLowerCase(), `${code}.csv`); if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    lines.slice(1).forEach((l, i) => {
      const c = splitCsv(l); // dùng lại hàm tách CSV của parseCoaCsv (xuất từ @kt/domain dưới tên splitCsvLine)
      out.push({ regime, reportCode: code, lineCode: c[0]!, label: c[1]!, parentLineCode: c[2] || null, source: c[3]!, side: c[4]!, formula: c[5] || null, sortOrder: i + 1, isBold: c[6] === '1', negate: c[7] === '1', noteRef: c[8] || null });
    });
  }
  return out;
}
export function reportStatus(): Record<string, Record<string, boolean | string>> { return JSON.parse(readFileSync(dataPath('reports', 'status.json'), 'utf8')); }
```

(Xuất `splitCsvLine` từ `packages/domain/src/coaTemplate.ts`.)

`packages/coa-data/test/reports.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formulaRefs, parseFormula } from '@kt/domain';
import { loadCoaTemplate, loadReportTemplates, reportStatus } from '../src/index.js';

describe('mẫu báo cáo tài chính', () => {
  const rows = loadReportTemplates();
  it('mọi công thức phân tích được, dòng cha tồn tại, dòng [x] tham chiếu tồn tại', () => {
    for (const regime of ['TT99', 'TT133']) for (const code of ['B01', 'B02', 'B03']) {
      const ls = rows.filter((r) => r.regime === regime && r.reportCode === code); const codes = new Set(ls.map((l) => l.lineCode));
      for (const l of ls) {
        if (l.parentLineCode) expect(codes.has(l.parentLineCode), `${regime}/${code}/${l.lineCode}: cha ${l.parentLineCode}`).toBe(true);
        if (!l.formula) continue;
        const refs = formulaRefs(parseFormula(l.formula));
        for (const x of refs.lines) expect(codes.has(x), `${regime}/${code}/${l.lineCode}: dòng [${x}]`).toBe(true);
      }
    }
  });
  it('tài khoản trong công thức tồn tại trong mẫu hệ thống tài khoản (chỉ khi bộ báo cáo complete=true)', () => {
    const st = reportStatus();
    for (const regime of ['TT99', 'TT133'] as const) {
      const coa = new Set(loadCoaTemplate(regime).map((a) => a.code));
      for (const code of ['B01', 'B02', 'B03']) {
        if (st[regime.toLowerCase()]?.[code] !== true) { console.warn(`CẢNH BÁO: ${regime}/${code} chưa hoàn tất, bỏ qua đối chiếu tài khoản`); continue; }
        for (const l of rows.filter((r) => r.regime === regime && r.reportCode === code)) if (l.formula)
          for (const a of formulaRefs(parseFormula(l.formula)).accounts) expect([...coa].some((c) => c.startsWith(a) || a.startsWith(c)), `${regime}/${code}/${l.lineCode}: TK ${a}`).toBe(true);
      }
    }
  });
});
```

Run: `pnpm -F @kt/coa-data test` → PASS (với cảnh báo cho bộ chưa hoàn tất).

- [ ] **Step 5: Migration, nạp mẫu, service đánh giá**

`packages/db/migrations/0012_bao_cao.sql`:

```sql
CREATE TABLE report_template (
  regime text NOT NULL, report_code text NOT NULL, line_code text NOT NULL, label text NOT NULL, parent_line_code text,
  source text NOT NULL CHECK (source IN ('balance','movement','pair','lines')), side text NOT NULL CHECK (side IN ('debit','credit','net_debit','net_credit')),
  formula text, sort_order int NOT NULL, is_bold boolean NOT NULL DEFAULT false, negate boolean NOT NULL DEFAULT false, note_ref text,
  PRIMARY KEY (regime, report_code, line_code));
REVOKE INSERT, UPDATE, DELETE ON report_template FROM app_user;
CREATE TABLE report_def (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id), regime text NOT NULL, report_code text NOT NULL,
  name text NOT NULL, form_no text NOT NULL, issued_by text NOT NULL, UNIQUE (tenant_id, regime, report_code));
CREATE TABLE report_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, report_def_id uuid NOT NULL REFERENCES report_def(id) ON DELETE CASCADE,
  line_code text NOT NULL, label text NOT NULL, parent_line_code text,
  source text NOT NULL CHECK (source IN ('balance','movement','pair','lines')), side text NOT NULL CHECK (side IN ('debit','credit','net_debit','net_credit')),
  formula text, sort_order int NOT NULL, is_bold boolean NOT NULL DEFAULT false, negate boolean NOT NULL DEFAULT false, note_ref text,
  UNIQUE (report_def_id, line_code));
SELECT rls_enable('report_def'), audit_enable('report_def'), rls_enable('report_line'), audit_enable('report_line');
```

`packages/db/src/reference.ts`: thêm nạp `report_template` (xóa theo `(regime, report_code)` rồi insert từ `loadReportTemplates()`).

`apps/api/src/modules/reporting/financial.ts`:

```ts
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, evaluateReport, ZERO, type Decimal, type ReportLineDef, type Resolver, type Side } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { formNoFor } from './print/forms.js';

type Trx = Transaction<Database>;
export const REPORT_NAMES: Record<string, Record<string, string>> = {
  B01: { TT99: 'Báo cáo tình hình tài chính', TT133: 'Báo cáo tình hình tài chính', TT200: 'Bảng cân đối kế toán' },
  B02: { TT99: 'Báo cáo kết quả hoạt động kinh doanh', TT133: 'Báo cáo kết quả hoạt động kinh doanh', TT200: 'Báo cáo kết quả hoạt động kinh doanh' },
  B03: { TT99: 'Báo cáo lưu chuyển tiền tệ (phương pháp trực tiếp)', TT133: 'Báo cáo lưu chuyển tiền tệ (phương pháp trực tiếp)', TT200: 'Báo cáo lưu chuyển tiền tệ (phương pháp trực tiếp)' },
};

export async function copyReportTemplates(trx: Trx, tenantId: string, regime: string): Promise<number> {
  const tpl = await trx.selectFrom('report_template').selectAll().where('regime', '=', regime).orderBy('report_code').orderBy('sort_order').execute();
  let n = 0;
  for (const code of [...new Set(tpl.map((t) => t.report_code))]) {
    await trx.deleteFrom('report_def').where('regime', '=', regime).where('report_code', '=', code).execute();
    const f = formNoFor(regime, code);
    const def = await trx.insertInto('report_def').values({ tenant_id: tenantId, regime, report_code: code, name: REPORT_NAMES[code]?.[regime] ?? code, form_no: f.formNo, issued_by: f.issuedBy }).returning('id').executeTakeFirstOrThrow();
    for (const t of tpl.filter((x) => x.report_code === code)) {
      await trx.insertInto('report_line').values({ tenant_id: tenantId, report_def_id: def.id, line_code: t.line_code, label: t.label, parent_line_code: t.parent_line_code, source: t.source, side: t.side, formula: t.formula, sort_order: t.sort_order, is_bold: t.is_bold, negate: t.negate, note_ref: t.note_ref }).execute();
      n++;
    }
  }
  return n;
}

function sqlResolver(trx: Trx, tenantId: string, p: { from: string; to: string }): Resolver {
  const dayBefore = (iso: string) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
  const like = (prefixes: string[]) => sql.join(prefixes.map((x) => sql`a.code LIKE ${x + '%'}`), sql` OR `);
  const sideOf = (side: Side, d: Decimal, c: Decimal) => side === 'debit' ? d : side === 'credit' ? c : side === 'net_debit' ? d.minus(c) : c.minus(d);
  return {
    async account(ref, source, side) {
      const excl = ref.exclude.length ? sql`AND NOT (${like(ref.exclude)})` : sql``;
      if (source === 'balance') {
        // dư tại ngày cuối kỳ theo hạt (tài khoản, đối tượng): debit/credit đã tách theo đối tượng nên "dư Nợ 131" đúng từng khách
        const r = await sql<{ d: string | null; c: string | null; nd: string | null }>`SELECT sum(b.debit)::text AS d, sum(b.credit)::text AS c, sum(b.debit - b.credit)::text AS nd
          FROM fn_balances_at(${tenantId}::uuid, ${p.to}::date) b JOIN account a ON a.id = b.account_id WHERE (${like([ref.prefix])}) ${excl}`.execute(trx);
        const row = r.rows[0]!;
        if (side === 'net_debit') return D(row.nd ?? '0'); if (side === 'net_credit') return D(row.nd ?? '0').neg();
        return sideOf(side, D(row.d ?? '0'), D(row.c ?? '0'));
      }
      const r = await sql<{ d: string | null; c: string | null }>`SELECT sum(l.debit)::text AS d, sum(l.credit)::text AS c FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
        WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND NOT v.is_closing AND v.posting_date BETWEEN ${p.from}::date AND ${p.to}::date AND (${like([ref.prefix])}) ${excl}`.execute(trx);
      return sideOf(side, D(r.rows[0]!.d ?? '0'), D(r.rows[0]!.c ?? '0'));
    },
    async pair(debit, credit) {
      const r = await sql<{ s: string | null }>`SELECT sum(p.amount)::text AS s FROM voucher_pair p JOIN account ad ON ad.id = p.debit_account_id JOIN account ac ON ac.id = p.credit_account_id JOIN voucher v ON v.id = p.voucher_id
        WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND p.posting_date BETWEEN ${p.from}::date AND ${p.to}::date
          AND (${sql.join(debit.map((x) => sql`ad.code LIKE ${x + '%'}`), sql` OR `)}) AND (${sql.join(credit.map((x) => sql`ac.code LIKE ${x + '%'}`), sql` OR `)})`.execute(trx);
      return D(r.rows[0]!.s ?? '0');
    },
  };
}

async function loadDef(trx: Trx, reportCode: string, regime: string) {
  const def = await trx.selectFrom('report_def').selectAll().where('report_code', '=', reportCode).where('regime', '=', regime).executeTakeFirst();
  if (!def) throw new AppError('REPORT_NOT_FOUND', `Chưa có định nghĩa báo cáo ${reportCode} cho ${regime}; dùng Nạp lại mẫu`, 404);
  const lines = await trx.selectFrom('report_line').selectAll().where('report_def_id', '=', def.id).orderBy('sort_order').execute();
  return { def, lines };
}
async function regimeOf(trx: Trx, date: string): Promise<{ regime: string; yearStart: string }> {
  const p = await trx.selectFrom('fiscal_period').select(['regime', 'fiscal_year']).where('period_no', '>=', 1).where('date_from', '<=', date).where('date_to', '>=', date).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Ngày ${date} không thuộc năm tài chính nào`, 404);
  const first = await trx.selectFrom('fiscal_period').select('date_from').where('fiscal_year', '=', p.fiscal_year).where('period_no', '=', 1).executeTakeFirstOrThrow();
  return { regime: p.regime, yearStart: first.date_from };
}
const shiftYear = (iso: string, n: number) => `${Number(iso.slice(0, 4)) + n}${iso.slice(4)}`;
const dayBeforeIso = (iso: string) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

export async function evaluateFinancialReport(trx: Trx, tenantId: string, q: { reportCode: string; from: string; to: string; comparePrevYear: boolean }) {
  const { regime, yearStart } = await regimeOf(trx, q.to);
  const { def, lines } = await loadDef(trx, q.reportCode, regime);
  const defs: ReportLineDef[] = lines.map((l) => ({ lineCode: l.line_code, formula: l.formula, source: l.source as ReportLineDef['source'], side: l.side as Side }));
  const run = (from: string, to: string) => evaluateReport(defs, sqlResolver(trx, tenantId, { from, to }));
  const current = await run(q.from, q.to);
  // B01: cột so sánh là "số đầu năm"; B02/B03: cùng kỳ năm trước.
  const previous = q.reportCode === 'B01' ? await run(q.from, dayBeforeIso(yearStart)) : q.comparePrevYear ? await run(shiftYear(q.from, -1), shiftYear(q.to, -1)) : null;
  return { reportCode: def.report_code, name: def.name, formNo: def.form_no, issuedBy: def.issued_by, regime, period: { from: q.from, to: q.to },
    rows: lines.map((l) => ({ lineCode: l.line_code, label: l.label, parentLineCode: l.parent_line_code, isBold: l.is_bold, negate: l.negate, noteRef: l.note_ref, source: l.source, formula: l.formula,
      current: (current.get(l.line_code) ?? ZERO).toString(), previous: previous ? (previous.get(l.line_code) ?? ZERO).toString() : null })) };
}

export async function drillLine(trx: Trx, tenantId: string, q: { reportCode: string; lineCode: string; from: string; to: string }) {
  const { regime } = await regimeOf(trx, q.to);
  const { lines } = await loadDef(trx, q.reportCode, regime);
  const l = lines.find((x) => x.line_code === q.lineCode); if (!l || !l.formula) return { accounts: [] };
  const { parseFormula, formulaRefs } = await import('@kt/domain');
  const refs = formulaRefs(parseFormula(l.formula));
  if (l.source === 'balance') {
    const byParty = ['debit', 'credit'].includes(l.side);
    const r = await sql<{ accountCode: string; accountName: string; partyCode: string | null; amount: string }>`SELECT a.code AS "accountCode", a.name AS "accountName", ${byParty ? sql`p.code` : sql`NULL`} AS "partyCode",
        ${l.side === 'debit' ? sql`sum(b.debit)` : l.side === 'credit' ? sql`sum(b.credit)` : l.side === 'net_debit' ? sql`sum(b.debit - b.credit)` : sql`sum(b.credit - b.debit)`}::text AS amount
      FROM fn_balances_at(${tenantId}::uuid, ${q.to}::date) b JOIN account a ON a.id = b.account_id LEFT JOIN party p ON p.id = b.party_id
      WHERE (${sql.join(refs.accounts.map((x) => sql`a.code LIKE ${x + '%'}`), sql` OR `)}) GROUP BY a.code, a.name ${byParty ? sql`, p.code` : sql``} HAVING ${l.side === 'debit' ? sql`sum(b.debit) <> 0` : l.side === 'credit' ? sql`sum(b.credit) <> 0` : sql`sum(b.debit - b.credit) <> 0`} ORDER BY 1, 3`.execute(trx);
    return { accounts: r.rows };
  }
  const r = await sql<{ accountCode: string; accountName: string; partyCode: string | null; amount: string }>`SELECT a.code AS "accountCode", a.name AS "accountName", NULL AS "partyCode",
      ${l.side === 'debit' ? sql`sum(l.debit)` : l.side === 'credit' ? sql`sum(l.credit)` : l.side === 'net_debit' ? sql`sum(l.debit - l.credit)` : sql`sum(l.credit - l.debit)`}::text AS amount
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND ${l.source === 'movement' ? sql`NOT v.is_closing` : sql`true`} AND v.posting_date BETWEEN ${q.from}::date AND ${q.to}::date
      AND (${sql.join(refs.accounts.map((x) => sql`a.code LIKE ${x + '%'}`), sql` OR `)}) GROUP BY a.code, a.name ORDER BY 1`.execute(trx);
  return { accounts: r.rows };
}
```

Thêm vào `reporting/routes.ts`:

```ts
import { sql } from 'kysely';
import { copyReportTemplates, drillLine, evaluateFinancialReport, REPORT_NAMES } from './financial.js';
import { formNoFor } from './print/forms.js';
// ...
app.get('/api/reports/financial', { preHandler: app.requirePermission('report.view'), schema: { querystring: z.object({ regime: z.string().optional() }) } }, async (req) =>
  app.withTenant(req, (trx) => { let q = trx.selectFrom('report_def').select(['id', 'regime', 'report_code as reportCode', 'name', 'form_no as formNo']); if (req.query.regime) q = q.where('regime', '=', req.query.regime); return q.orderBy('regime').orderBy('report_code').execute(); }));
app.get('/api/reports/financial/:code', { preHandler: app.requirePermission('report.view'), schema: { params: z.object({ code: z.string() }), querystring: z.object({ ...range, comparePrevYear: z.enum(['true', 'false']).default('false') }) } }, async (req) =>
  app.withTenant(req, (trx) => evaluateFinancialReport(trx, req.auth!.tenantId!, { reportCode: req.params.code, from: req.query.from, to: req.query.to, comparePrevYear: req.query.comparePrevYear === 'true' })));
app.get('/api/reports/financial/:code/lines/:lineCode', { preHandler: app.requirePermission('report.view'), schema: { params: z.object({ code: z.string(), lineCode: z.string() }), querystring: z.object(range) } }, async (req) =>
  app.withTenant(req, (trx) => drillLine(trx, req.auth!.tenantId!, { reportCode: req.params.code, lineCode: req.params.lineCode, ...req.query })));
app.get('/api/report-defs/:code', { preHandler: app.requirePermission('report_def.view'), schema: { params: z.object({ code: z.string() }), querystring: z.object({ regime: z.string() }) } }, async (req) =>
  app.withTenant(req, async (trx) => { const d = await trx.selectFrom('report_def').select('id').where('report_code', '=', req.params.code).where('regime', '=', req.query.regime).executeTakeFirst();
    if (!d) return { lines: [] }; return { lines: await trx.selectFrom('report_line').selectAll().where('report_def_id', '=', d.id).orderBy('sort_order').execute() }; }));
app.put('/api/report-defs/:code', { preHandler: app.requirePermission('report_def.update'), schema: { params: z.object({ code: z.string() }), body: z.object({ regime: z.string(), lines: z.array(z.object({
    lineCode: z.string(), label: z.string(), parentLineCode: z.string().nullable(), source: z.enum(['balance', 'movement', 'pair', 'lines']), side: z.enum(['debit', 'credit', 'net_debit', 'net_credit']), formula: z.string().nullable(), isBold: z.boolean().default(false), negate: z.boolean().default(false), noteRef: z.string().nullable().default(null) })) }) } }, async (req) => {
  const { parseFormula } = await import('@kt/domain');
  for (const l of req.body.lines) if (l.formula) parseFormula(l.formula); // ném lỗi công thức sớm -> 400 qua plugin lỗi
  const tenantId = req.auth!.tenantId!;
  await app.withTenant(req, async (trx) => {
    const f = formNoFor(req.body.regime, req.params.code);
    const d = await trx.insertInto('report_def').values({ tenant_id: tenantId, regime: req.body.regime, report_code: req.params.code, name: REPORT_NAMES[req.params.code]?.[req.body.regime] ?? req.params.code, form_no: f.formNo, issued_by: f.issuedBy })
      .onConflict((oc) => oc.columns(['tenant_id', 'regime', 'report_code']).doUpdateSet({ name: sql`report_def.name` })).returning('id').executeTakeFirstOrThrow();
    await trx.deleteFrom('report_line').where('report_def_id', '=', d.id).execute();
    let i = 0; for (const l of req.body.lines) await trx.insertInto('report_line').values({ tenant_id: tenantId, report_def_id: d.id, line_code: l.lineCode, label: l.label, parent_line_code: l.parentLineCode, source: l.source, side: l.side, formula: l.formula, sort_order: ++i, is_bold: l.isBold, negate: l.negate, note_ref: l.noteRef }).execute();
  });
  return { ok: true };
});
app.post('/api/report-defs/:code/reload', { preHandler: app.requirePermission('report_def.update'), schema: { params: z.object({ code: z.string() }), body: z.object({ regime: z.string() }) } }, async (req) =>
  ({ lines: await app.withTenant(req, (trx) => copyReportTemplates(trx, req.auth!.tenantId!, req.body.regime)) }));
```

(Lỗi `Error` từ `parseFormula` chưa phải `AppError`: trong plugin lỗi thêm nhánh `if (e.message?.startsWith('Công thức')) return reply.status(400).send({ error: { code: 'FORMULA_INVALID', message: e.message } })`.)

Trong `createFiscalYear` (Task 5): sau nạp sơ đồ kết chuyển thêm `if (!(await trx.selectFrom('report_def').select('id').where('regime', '=', input.regime).limit(1).executeTakeFirst())) await copyReportTemplates(trx, tenantId, input.regime);`.

- [ ] **Step 6: Test API với định nghĩa báo cáo nhỏ nội tuyến (không phụ thuộc dữ liệu Phụ lục)**

`apps/api/test/financial.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string;
const pkt = (date: string, lines: object[]) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'x', autoPost: true, lines } });
const MINI_B01 = [
  { lineCode: '100', label: 'A. Tài sản', parentLineCode: null, source: 'lines', side: 'net_debit', formula: '[111]+[131]' },
  { lineCode: '111', label: 'Tiền', parentLineCode: '100', source: 'balance', side: 'net_debit', formula: '111+112' },
  { lineCode: '131', label: 'Phải thu khách hàng', parentLineCode: '100', source: 'balance', side: 'debit', formula: '131' },
  { lineCode: '300', label: 'C. Nợ phải trả', parentLineCode: null, source: 'lines', side: 'net_debit', formula: '[312]+[331]' },
  { lineCode: '312', label: 'Người mua trả tiền trước', parentLineCode: '300', source: 'balance', side: 'credit', formula: '131' },
  { lineCode: '331', label: 'Phải trả người bán', parentLineCode: '300', source: 'balance', side: 'credit', formula: '331' },
  { lineCode: '400', label: 'D. Vốn chủ sở hữu', parentLineCode: null, source: 'lines', side: 'net_debit', formula: '[411]+[421]' },
  { lineCode: '411', label: 'Vốn góp', parentLineCode: '400', source: 'balance', side: 'net_credit', formula: '411' },
  { lineCode: '421', label: 'Lợi nhuận chưa phân phối', parentLineCode: '400', source: 'balance', side: 'net_credit', formula: '421+911+5+6', isBold: false },
  { lineCode: '440', label: 'Tổng cộng nguồn vốn', parentLineCode: null, source: 'lines', side: 'net_debit', formula: '[300]+[400]', isBold: true },
];
const MINI_B02 = [
  { lineCode: '01', label: 'Doanh thu', parentLineCode: null, source: 'movement', side: 'net_credit', formula: '511' },
  { lineCode: '11', label: 'Giá vốn / chi phí', parentLineCode: null, source: 'movement', side: 'net_debit', formula: '632+642' },
  { lineCode: '50', label: 'Lợi nhuận', parentLineCode: null, source: 'lines', side: 'net_debit', formula: '[01]-[11]' },
  { lineCode: '60', label: 'Kết chuyển (đối ứng)', parentLineCode: null, source: 'pair', side: 'net_debit', formula: 'N911/C642' },
];

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `FR${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code: 'KH001', name: 'K1', is_customer: true } });
  await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code: 'KH002', name: 'K2', is_customer: true } });
  // PUT tự tạo report_def nếu chưa có (mẫu CSV có thể còn trống khi chưa nhập Phụ lục).
  expect((await ctx.app.inject({ method: 'PUT', url: '/api/report-defs/B01', headers: { cookie }, payload: { regime: 'TT133', lines: MINI_B01 } })).statusCode).toBe(200);
  expect((await ctx.app.inject({ method: 'PUT', url: '/api/report-defs/B02', headers: { cookie }, payload: { regime: 'TT133', lines: MINI_B02 } })).statusCode).toBe(200);
  await ctx.app.inject({ method: 'PUT', url: '/api/opening-balance/2026', headers: { cookie }, payload: { rows: [{ accountCode: '1111', currencyCode: 'VND', debit: '1000', credit: '0', debitCurrency: '0', creditCurrency: '0', partyCode: null }, { accountCode: '4111', currencyCode: 'VND', debit: '0', credit: '1000', debitCurrency: '0', creditCurrency: '0', partyCode: null }] } });
  await ctx.app.inject({ method: 'POST', url: '/api/opening-balance/2026/post', headers: { cookie } });
  await pkt('2026-02-01', [{ accountCode: '131', debit: '500', partyCode: 'KH001' }, { accountCode: '5113', credit: '500' }]);
  await pkt('2026-02-02', [{ accountCode: '1111', debit: '100' }, { accountCode: '131', credit: '100', partyCode: 'KH002' }]);
  await pkt('2026-03-01', [{ accountCode: '6421', debit: '300' }, { accountCode: '1111', credit: '300' }]);
});
afterAll(async () => { await ctx.close(); });

describe('báo cáo tài chính theo dòng', () => {
  it('B01 trước kết chuyển: tổng tài sản = nợ phải trả + vốn (gồm P&L chưa kết chuyển); 131 tách dư hai bên', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/reports/financial/B01?from=2026-01-01&to=2026-03-31', headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    const row = (c: string) => r.json().rows.find((x: { lineCode: string }) => x.lineCode === c);
    expect(row('111').current).toBe('800'); expect(row('131').current).toBe('500'); expect(row('312').current).toBe('100'); expect(row('100').current).toBe('1300');
    expect(row('421').current).toBe('200'); // 500 doanh thu − 300 chi phí
    expect(row('440').current).toBe('1300'); expect(row('111').previous).toBe('1000'); // số đầu năm
  });
  it('B02 theo phát sinh không gồm kết chuyển; đối ứng nhìn thấy kết chuyển; so sánh năm trước rỗng', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/closing/run-all', headers: { cookie }, payload: { postingDate: '2026-03-31' } });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/reports/financial/B02?from=2026-01-01&to=2026-03-31&comparePrevYear=true', headers: { cookie } });
    const row = (c: string) => r.json().rows.find((x: { lineCode: string }) => x.lineCode === c);
    expect(row('01').current).toBe('500'); expect(row('11').current).toBe('300'); expect(row('50').current).toBe('200'); expect(row('60').current).toBe('300');
    expect(row('01').previous).toBe('0');
  });
  it('truy ngược chỉ tiêu 131 ra từng đối tượng; công thức sai bị 400', async () => {
    const d = await ctx.app.inject({ method: 'GET', url: '/api/reports/financial/B01/lines/131?from=2026-01-01&to=2026-03-31', headers: { cookie } });
    expect(d.json().accounts).toEqual([{ accountCode: '131', accountName: expect.any(String), partyCode: 'KH001', amount: '500' }]);
    const bad = await ctx.app.inject({ method: 'PUT', url: '/api/report-defs/B01', headers: { cookie }, payload: { regime: 'TT133', lines: [{ ...MINI_B01[0], formula: '[111] +' }] } });
    expect(bad.statusCode).toBe(400); expect(bad.json().error.code).toBe('FORMULA_INVALID');
  });
});
```

Run: `pnpm -F @kt/api test -- test/financial.test.ts` → PASS 3.

- [ ] **Step 7: Màn hình BCTC**

`apps/web/src/pages/Financial.tsx`: chọn báo cáo (`/api/reports/financial`), khoảng ngày (B01 chỉ cần "đến ngày"), công tắc "So sánh năm trước"; bảng dòng thụt lề theo `parentLineCode`, in đậm `isBold`, số âm trong ngoặc khi `negate`; nhấn vào số → `Drawer` truy ngược (`/lines/:lineCode`) với liên kết sang Sổ Cái tài khoản; nút "In" (Task 24), "Sửa công thức" (bảng chỉnh sửa `lineCode/label/parent/source/side/formula`, lưu `PUT /api/report-defs/:code`), "Nạp lại mẫu". Route `/bao-cao/bao-cao-tai-chinh`, menu `{ key: 'financial', label: 'Báo cáo tài chính', to: '/bao-cao/bao-cao-tai-chinh', permission: 'report.view' }`.

- [ ] **Step 8: Commit**

```bash
git add packages/domain packages/db packages/coa-data apps/api apps/web
git commit -m "feat(reporting): engine công thức dòng báo cáo, định nghĩa B01/B02/B03 theo chế độ, truy ngược và nạp lại mẫu"
```

---

### Task 24: In sổ sách và BCTC: mẫu HTML theo thông tư, PDF, Excel nhiều sheet, in liên tục cả bộ sổ năm

**Files:**
- Create: `apps/api/src/modules/reporting/print/html.ts`, `apps/api/src/modules/reporting/print/excel.ts`, `apps/api/src/modules/reporting/print/bookSet.ts`
- Modify: `apps/api/src/modules/reporting/routes.ts` (tham số `format`, route in liên tục)
- Create: `apps/web/e2e/in-so.spec.ts`
- Test: `apps/api/test/print.test.ts`

**Interfaces:**
- Consumes: `renderPdf`, `printShell`, `PRINT_CSS`, `formNoFor` (Task 18); hàm sổ sách (Task 22), `evaluateFinancialReport` (Task 23).
- Produces:
  - `interface ReportDoc { title: string; formNo: string; issuedBy: string; company: CompanyInfo; subtitle: string; columns: { key: string; label: string; align?: 'left'|'right'|'center'; width?: string }[]; rows: Record<string, unknown>[]; footer?: Record<string, unknown>; signatures?: string[]; landscape?: boolean }`.
  - `renderReportHtml(doc: ReportDoc): string`; `renderReportsHtml(docs: ReportDoc[]): string` (ngắt trang giữa các sổ); `renderReportXlsx(docs: ReportDoc[]): Promise<Buffer>` (mỗi `doc` một sheet, tiêu đề 3 dòng, số dạng số với định dạng `#,##0`, cột rộng tự động).
  - `respondReport(reply, docs: ReportDoc[], format: 'html'|'pdf'|'xlsx', fileName: string)`.
  - Mọi route sổ sách/BCTC nhận thêm `format=json|html|pdf|xlsx` (mặc định `json`); các bộ dựng `ReportDoc`: `journalDoc`, `ledgerDoc`, `detailDoc`, `trialBalanceDoc`, `financialDoc` trong `print/html.ts`.
  - `POST /api/print/book-set { fiscalYear, include: ('journal'|'ledgers'|'trial'|'B01'|'B02'|'B03')[], format: 'pdf'|'xlsx' }` (quyền `report.print`) → một PDF nhiều phần hoặc một XLSX nhiều sheet; Sổ Cái in cho mọi tài khoản có phát sinh/dư trong năm.
  - Tiêu đề in: dòng 1 tên công ty + địa chỉ (trái), "Mẫu số …" + "Ban hành theo …" (phải); tiêu đề sổ in hoa; dòng kỳ "Từ ngày … đến ngày …"; chân ký "Người ghi sổ / Kế toán trưởng / Người đại diện theo pháp luật" với "Ngày … tháng … năm …".

- [ ] **Step 1: Viết test (thất bại)**

`apps/api/test/print.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `PR${Date.now()}` }));
  await ctx.app.inject({ method: 'PUT', url: '/api/company', headers: { cookie }, payload: { name: 'Công ty TNHH In Thử', address: '1 Tràng Tiền', legalRep: 'Lê Văn C', chiefAccountant: 'Phạm Thị D' } });
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: '2026-01-05', documentDate: '2026-01-05', description: 'Mua giấy', autoPost: true, lines: [{ accountCode: '6422', debit: '2500000' }, { accountCode: '1111', credit: '2500000' }] } });
});
afterAll(async () => { await ctx.close(); });

describe('in sổ', () => {
  it('Nhật ký chung HTML có mẫu số S03a-DNN, tên công ty, số tiền; PDF hợp lệ', async () => {
    const h = await ctx.app.inject({ method: 'GET', url: '/api/reports/ledgers/general-journal?from=2026-01-01&to=2026-01-31&format=html', headers: { cookie } });
    expect(h.body).toContain('S03a-DNN'); expect(h.body).toContain('Công ty TNHH In Thử'); expect(h.body).toContain('SỔ NHẬT KÝ CHUNG'); expect(h.body).toContain('2.500.000'); expect(h.body).toContain('Phạm Thị D');
    const p = await ctx.app.inject({ method: 'GET', url: '/api/reports/ledgers/general-journal?from=2026-01-01&to=2026-01-31&format=pdf', headers: { cookie } });
    expect(p.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  }, 60_000);
  it('Bảng cân đối số phát sinh xuất Excel đọc lại được với số dạng số', async () => {
    const x = await ctx.app.inject({ method: 'GET', url: '/api/reports/ledgers/trial-balance?from=2026-01-01&to=2026-01-31&format=xlsx', headers: { cookie } });
    expect(x.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!; expect(ws.name).toContain('S06');
    let found = false; ws.eachRow((row) => { row.eachCell((c) => { if (typeof c.value === 'number' && c.value === 2500000) found = true; }); }); expect(found).toBe(true);
  });
  it('in liên tục cả bộ sổ năm ra một PDF và một XLSX nhiều sheet', async () => {
    const p = await ctx.app.inject({ method: 'POST', url: '/api/print/book-set', headers: { cookie }, payload: { fiscalYear: 2026, include: ['journal', 'ledgers', 'trial'], format: 'pdf' } });
    expect(p.statusCode, p.body).toBe(200); expect(p.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    const x = await ctx.app.inject({ method: 'POST', url: '/api/print/book-set', headers: { cookie }, payload: { fiscalYear: 2026, include: ['journal', 'ledgers', 'trial'], format: 'xlsx' } });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.length).toBeGreaterThanOrEqual(4); // NKC + Sổ cái 1111 + Sổ cái 6422 + BCĐPS
  }, 120_000);
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/api test -- test/print.test.ts` → FAIL (format bị Zod từ chối / thiếu route).

- [ ] **Step 3: Mã in**

`apps/api/src/modules/reporting/print/html.ts`:

```ts
import { formatVnDate, formatVnNumber } from '@kt/domain';
import { printShell, type CompanyInfo } from './voucherHtml.js';

export interface ReportColumn { key: string; label: string; align?: 'left' | 'right' | 'center'; width?: string; type?: 'text' | 'number' | 'date' }
export interface ReportDoc { title: string; formNo: string; issuedBy: string; company: CompanyInfo; subtitle: string; columns: ReportColumn[]; rows: Record<string, unknown>[]; footer?: Record<string, unknown>; signatures?: string[]; landscape?: boolean; sheetName?: string }
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cell = (c: ReportColumn, v: unknown) => c.type === 'number' ? formatVnNumber(v as string | null) : c.type === 'date' && v ? formatVnDate(String(v)) : esc(v);

export function renderReportBody(d: ReportDoc): string {
  const head = d.columns.map((c) => `<th style="width:${c.width ?? 'auto'}">${esc(c.label)}</th>`).join('');
  const body = d.rows.map((r) => `<tr${r['isBold'] ? ' style="font-weight:bold"' : ''}>${d.columns.map((c) => `<td class="${c.align ?? (c.type === 'number' ? 'num' : '')}">${cell(c, r[c.key])}</td>`).join('')}</tr>`).join('');
  const foot = d.footer ? `<tr style="font-weight:bold">${d.columns.map((c) => `<td class="${c.type === 'number' ? 'num' : ''}">${cell(c, d.footer![c.key])}</td>`).join('')}</tr>` : '';
  const signs = (d.signatures ?? ['Người ghi sổ', 'Kế toán trưởng', 'Người đại diện theo pháp luật']).map((s, i) => `<div><b>${esc(s)}</b><i>(Ký, họ tên${i === 2 ? ', đóng dấu' : ''})</i><div class="gap"></div>${i === 1 ? esc(d.company.chiefAccountant ?? '') : i === 2 ? esc(d.company.legalRep ?? '') : ''}</div>`).join('');
  return `<div class="head"><div><b>${esc(d.company.name)}</b>${esc(d.company.address ?? '')}<br>MST: ${esc(d.company.taxCode ?? '')}</div><div style="text-align:right"><b>Mẫu số ${esc(d.formNo)}</b>${esc(d.issuedBy)}</div></div>
    <h1>${esc(d.title)}</h1><div class="sub">${esc(d.subtitle)}</div>
    <table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}${foot}</tbody></table>
    <p style="text-align:right;margin-top:16px"><i>Ngày … tháng … năm …</i></p><div class="sign">${signs}</div>`;
}
export const renderReportHtml = (d: ReportDoc) => printShell(d.title, renderReportBody(d));
export const renderReportsHtml = (docs: ReportDoc[]) => printShell(docs[0]?.title ?? 'Sổ kế toán', docs.map((d, i) => `<section class="${i < docs.length - 1 ? 'pb' : ''}">${renderReportBody(d)}</section>`).join(''));
export const periodSubtitle = (from: string, to: string) => `Từ ngày ${formatVnDate(from)} đến ngày ${formatVnDate(to)}`;
```

`apps/api/src/modules/reporting/print/excel.ts`:

```ts
import ExcelJS from 'exceljs';
import { formatVnDate } from '@kt/domain';
import type { ReportDoc } from './html.js';

export async function renderReportXlsx(docs: ReportDoc[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const used = new Set<string>();
  for (const d of docs) {
    let name = (d.sheetName ?? d.formNo).replace(/[\\/*?:[\]]/g, '-').slice(0, 28); let k = 1; while (used.has(name)) name = `${name.slice(0, 25)}(${++k})`; used.add(name);
    const ws = wb.addWorksheet(name);
    ws.addRow([d.company.name]); ws.addRow([`Mẫu số ${d.formNo} – ${d.issuedBy}`]); ws.addRow([d.title]).font = { bold: true, size: 14 }; ws.addRow([d.subtitle]); ws.addRow([]);
    const header = ws.addRow(d.columns.map((c) => c.label)); header.font = { bold: true };
    for (const r of d.rows) { const row = ws.addRow(d.columns.map((c) => c.type === 'number' ? Number(r[c.key] ?? 0) : c.type === 'date' && r[c.key] ? formatVnDate(String(r[c.key])) : (r[c.key] ?? ''))); if (r['isBold']) row.font = { bold: true }; }
    if (d.footer) ws.addRow(d.columns.map((c) => c.type === 'number' ? Number(d.footer![c.key] ?? 0) : (d.footer![c.key] ?? ''))).font = { bold: true };
    d.columns.forEach((c, i) => { const col = ws.getColumn(i + 1); col.width = c.type === 'number' ? 18 : c.key === 'description' || c.key === 'label' ? 48 : 16; if (c.type === 'number') col.numFmt = '#,##0;[Red]-#,##0'; });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
```

`apps/api/src/modules/reporting/print/bookSet.ts`:

```ts
import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { accountDetail, accountLedger, generalJournal, trialBalance } from '../ledgers.js';
import { evaluateFinancialReport } from '../financial.js';
import { formNoFor } from './forms.js';
import { periodSubtitle, type ReportDoc } from './html.js';
import type { CompanyInfo } from './voucherHtml.js';

type Trx = Transaction<Database>;
export async function companyInfo(trx: Trx, tenantId: string, regime: string, formKey: string): Promise<CompanyInfo> {
  const t = await trx.selectFrom('tenant').selectAll().where('id', '=', tenantId).executeTakeFirstOrThrow(); const f = formNoFor(regime, formKey);
  return { name: t.name, address: t.address, taxCode: t.tax_code, legalRep: t.legal_rep, chiefAccountant: t.chief_accountant, formNo: f.formNo, issuedBy: f.issuedBy };
}
export async function journalDoc(trx: Trx, tenantId: string, regime: string, p: { from: string; to: string }): Promise<ReportDoc> {
  const j = await generalJournal(trx, p);
  return { title: 'Sổ Nhật ký chung', ...(await companyInfo(trx, tenantId, regime, 'S03a').then((c) => ({ company: c, formNo: c.formNo, issuedBy: c.issuedBy }))), subtitle: periodSubtitle(p.from, p.to), sheetName: 'S03a NKC',
    columns: [{ key: 'postingDate', label: 'Ngày ghi sổ', type: 'date', width: '11%' }, { key: 'voucherNo', label: 'Số hiệu', width: '11%' }, { key: 'documentDate', label: 'Ngày CT', type: 'date', width: '11%' }, { key: 'description', label: 'Diễn giải' }, { key: 'accountCode', label: 'TK', width: '8%' }, { key: 'debit', label: 'Số phát sinh Nợ', type: 'number', width: '14%' }, { key: 'credit', label: 'Số phát sinh Có', type: 'number', width: '14%' }],
    rows: j.rows, footer: { description: 'Cộng', debit: j.totalDebit, credit: j.totalCredit } };
}
export async function ledgerDoc(trx: Trx, tenantId: string, regime: string, p: { accountCode: string; from: string; to: string }): Promise<ReportDoc> {
  const l = await accountLedger(trx, tenantId, { ...p, mode: 'voucher' }); const acc = await trx.selectFrom('account').select('name').where('code', '=', p.accountCode).executeTakeFirstOrThrow();
  const c = await companyInfo(trx, tenantId, regime, 'S03b');
  return { title: `Sổ Cái – Tài khoản ${p.accountCode} – ${acc.name}`, company: c, formNo: c.formNo, issuedBy: c.issuedBy, subtitle: periodSubtitle(p.from, p.to), sheetName: `S03b ${p.accountCode}`,
    columns: [{ key: 'postingDate', label: 'Ngày ghi sổ', type: 'date' }, { key: 'voucherNo', label: 'Số hiệu' }, { key: 'description', label: 'Diễn giải' }, { key: 'counterAccountCode', label: 'TK đối ứng' }, { key: 'debit', label: 'Nợ', type: 'number' }, { key: 'credit', label: 'Có', type: 'number' }],
    rows: [{ description: 'Số dư đầu kỳ', debit: l.opening.debit, credit: l.opening.credit, isBold: true }, ...(l.rows as Record<string, unknown>[]), { description: 'Cộng số phát sinh', debit: l.totalDebit, credit: l.totalCredit, isBold: true }, { description: 'Số dư cuối kỳ', debit: l.closing.debit, credit: l.closing.credit, isBold: true }] };
}
export async function detailDoc(trx: Trx, tenantId: string, regime: string, p: Parameters<typeof accountDetail>[2]): Promise<ReportDoc> {
  const l = await accountDetail(trx, tenantId, p); const c = await companyInfo(trx, tenantId, regime, 'S38');
  return { title: `Sổ chi tiết tài khoản ${p.accountCode}${p.partyCode ? ` – Đối tượng ${p.partyCode}` : ''}`, company: c, formNo: c.formNo, issuedBy: c.issuedBy, subtitle: periodSubtitle(p.from, p.to), sheetName: `S38 ${p.accountCode}`,
    columns: [{ key: 'postingDate', label: 'Ngày', type: 'date' }, { key: 'voucherNo', label: 'Số hiệu' }, { key: 'description', label: 'Diễn giải' }, { key: 'partyCode', label: 'Đối tượng' }, { key: 'counterAccountCode', label: 'TK đối ứng' }, { key: 'debit', label: 'Nợ', type: 'number' }, { key: 'credit', label: 'Có', type: 'number' }],
    rows: [{ description: 'Số dư đầu kỳ', debit: l.opening.debit, credit: l.opening.credit, isBold: true }, ...(l.rows as Record<string, unknown>[]), { description: 'Số dư cuối kỳ', debit: l.closing.debit, credit: l.closing.credit, isBold: true }] };
}
export async function trialBalanceDoc(trx: Trx, tenantId: string, regime: string, p: { from: string; to: string; level?: number | undefined; splitParty?: boolean | undefined }): Promise<ReportDoc> {
  const t = await trialBalance(trx, tenantId, p); const c = await companyInfo(trx, tenantId, regime, 'S06');
  return { title: 'Bảng cân đối số phát sinh', company: c, formNo: c.formNo, issuedBy: c.issuedBy, subtitle: periodSubtitle(p.from, p.to), landscape: true, sheetName: 'S06 BCĐPS',
    columns: [{ key: 'accountCode', label: 'Số hiệu TK' }, { key: 'accountName', label: 'Tên tài khoản' }, { key: 'openingDebit', label: 'Dư đầu kỳ Nợ', type: 'number' }, { key: 'openingCredit', label: 'Dư đầu kỳ Có', type: 'number' }, { key: 'periodDebit', label: 'Phát sinh Nợ', type: 'number' }, { key: 'periodCredit', label: 'Phát sinh Có', type: 'number' }, { key: 'closingDebit', label: 'Dư cuối kỳ Nợ', type: 'number' }, { key: 'closingCredit', label: 'Dư cuối kỳ Có', type: 'number' }],
    rows: t.rows.map((r) => ({ accountCode: r.accountCode, accountName: r.accountName, openingDebit: r.opening.debit, openingCredit: r.opening.credit, periodDebit: r.period.debit, periodCredit: r.period.credit, closingDebit: r.closing.debit, closingCredit: r.closing.credit, isBold: r.level === 1 })),
    footer: { accountName: 'Tổng cộng', openingDebit: t.totals.opening.debit, openingCredit: t.totals.opening.credit, periodDebit: t.totals.period.debit, periodCredit: t.totals.period.credit, closingDebit: t.totals.closing.debit, closingCredit: t.totals.closing.credit } };
}
export async function financialDoc(trx: Trx, tenantId: string, regime: string, p: { reportCode: string; from: string; to: string }): Promise<ReportDoc> {
  const r = await evaluateFinancialReport(trx, tenantId, { ...p, comparePrevYear: true }); const c = await companyInfo(trx, tenantId, regime, p.reportCode);
  const prevLabel = p.reportCode === 'B01' ? 'Số đầu năm' : 'Năm trước';
  return { title: r.name, company: c, formNo: r.formNo, issuedBy: r.issuedBy, subtitle: p.reportCode === 'B01' ? `Tại ngày ${p.to.split('-').reverse().join('/')}` : periodSubtitle(p.from, p.to), sheetName: r.formNo,
    columns: [{ key: 'label', label: 'Chỉ tiêu' }, { key: 'lineCode', label: 'Mã số', align: 'center' }, { key: 'noteRef', label: 'Thuyết minh', align: 'center' }, { key: 'current', label: p.reportCode === 'B01' ? 'Số cuối kỳ' : 'Năm nay', type: 'number' }, { key: 'previous', label: prevLabel, type: 'number' }],
    rows: r.rows.map((x) => ({ ...x, label: `${'    '.repeat(x.parentLineCode ? 1 : 0)}${x.label}` })), signatures: ['Người lập biểu', 'Kế toán trưởng', 'Người đại diện theo pháp luật'] };
}
export async function bookSetDocs(trx: Trx, tenantId: string, year: number, include: string[]): Promise<ReportDoc[]> {
  const ps = await trx.selectFrom('fiscal_period').select(['date_from', 'date_to', 'regime']).where('fiscal_year', '=', year).where('period_no', '>=', 1).orderBy('period_no').execute();
  if (!ps.length) return [];
  const from = ps[0]!.date_from; const to = ps.at(-1)!.date_to; const regime = ps[0]!.regime; const docs: ReportDoc[] = [];
  if (include.includes('journal')) docs.push(await journalDoc(trx, tenantId, regime, { from, to }));
  if (include.includes('ledgers')) {
    const tb = await trialBalance(trx, tenantId, { from, to, splitParty: false });
    for (const r of tb.rows.filter((x) => !x.isGroup)) docs.push(await ledgerDoc(trx, tenantId, regime, { accountCode: r.accountCode, from, to }));
  }
  if (include.includes('trial')) docs.push(await trialBalanceDoc(trx, tenantId, regime, { from, to, splitParty: true }));
  for (const code of ['B01', 'B02', 'B03']) if (include.includes(code)) { try { docs.push(await financialDoc(trx, tenantId, regime, { reportCode: code, from, to })); } catch (e) { if ((e as { code?: string }).code !== 'REPORT_NOT_FOUND') throw e; } }
  return docs;
}
```

Sửa `reporting/routes.ts`: thêm `format: z.enum(['json', 'html', 'pdf', 'xlsx']).default('json')` vào querystring của 4 route sổ sách và route BCTC; helper:

```ts
async function respondReport(reply: FastifyReply, docs: ReportDoc[], format: 'html' | 'pdf' | 'xlsx', fileName: string) {
  if (format === 'html') return reply.type('text/html; charset=utf-8').send(renderReportsHtml(docs));
  if (format === 'pdf') return reply.type('application/pdf').header('content-disposition', `inline; filename="${fileName}.pdf"`).send(await renderPdf(renderReportsHtml(docs), { landscape: docs.some((d) => d.landscape) }));
  return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="${fileName}.xlsx"`).send(await renderReportXlsx(docs));
}
```

Mỗi route: nếu `format !== 'json'` → lấy `regime` của ngày `to` (hàm `regimeOf` tách ra `financial.ts` và xuất), dựng doc tương ứng (`journalDoc`/`ledgerDoc`/`detailDoc`/`trialBalanceDoc`/`financialDoc`) và `respondReport`; các route in cần quyền `report.print` (kiểm tra thêm `req.auth.permissions.has('report.print')` khi `format !== 'json'`). Route mới:

```ts
app.post('/api/print/book-set', { preHandler: app.requirePermission('report.print'), schema: { body: z.object({ fiscalYear: z.number().int(), include: z.array(z.enum(['journal', 'ledgers', 'trial', 'B01', 'B02', 'B03'])).min(1), format: z.enum(['pdf', 'xlsx']) }) } }, async (req, reply) => {
  const docs = await app.withTenant(req, (trx) => bookSetDocs(trx, req.auth!.tenantId!, req.body.fiscalYear, req.body.include));
  if (!docs.length) throw new AppError('PERIOD_NOT_FOUND', `Không có năm tài chính ${req.body.fiscalYear}`, 404);
  return respondReport(reply, docs, req.body.format, `bo-so-${req.body.fiscalYear}`);
});
```

- [ ] **Step 4: Chạy test**

Run: `pnpm -F @kt/api test -- test/print.test.ts` → PASS 3.

- [ ] **Step 5: Nút in trên web và E2E in sổ**

`Ledgers.tsx` và `Financial.tsx`: nút "In PDF" / "Xuất Excel" mở cùng URL với `format=pdf|xlsx` (`window.open`); `Ledgers.tsx` thêm nút "In cả bộ sổ năm…" mở `Modal` chọn năm, các mục, định dạng → `fetch POST /api/print/book-set` → tải blob về (`a.download`).

`apps/web/e2e/in-so.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
test('in Nhật ký chung ra PDF từ màn hình sổ sách', async ({ page, request }) => {
  await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } });
  await page.goto('/dang-nhap'); await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await page.goto('/bao-cao/so-sach');
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'In PDF' }).first().click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toContain('format=pdf');
  const res = await request.get(popup.url());
  expect(res.headers()['content-type']).toBe('application/pdf');
});
```

Run: `pnpm -F @kt/web e2e` → 2 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/api apps/web
git commit -m "feat(reporting): in sổ sách và BCTC ra HTML/PDF/Excel theo mẫu thông tư và in liên tục cả bộ sổ năm"
```

---

### Task 25: Soát lỗi dữ liệu bằng bảng quy tắc `data_check_rule`

**Files:**
- Create: `packages/db/migrations/0013_soat_loi.sql`
- Modify: `packages/db/src/types.ts`, `apps/api/src/modules/master/catalogs.ts` (thêm danh mục `data_check_rule`)
- Create: `apps/api/src/modules/tools/dataCheck.ts`, `apps/api/src/modules/tools/routes.ts`; Modify: `apps/api/src/app.ts`
- Create: `apps/web/src/pages/DataCheck.tsx`; Modify: `apps/web/src/router.tsx`
- Test: `apps/api/test/dataCheck.test.ts`

**Interfaces:**
- Consumes: `fn_balances_at` (Task 20), chứng từ (Task 15), kỳ (Task 16).
- Produces:
  - Bảng `data_check_rule(id, tenant_id, code, name, severity 'error'|'warning', sql text, message, fix_hint, is_system, is_enabled, UNIQUE(tenant_id, code))`. Hợp đồng SQL của quy tắc: câu `SELECT` trả các cột `voucher_id uuid NULL`, `ref text` (mã TK/đối tượng/số CT), `detail text`; tham số `$1 date` (từ ngày), `$2 date` (đến ngày); chạy trong transaction `READ ONLY` dưới RLS.
  - 6 quy tắc hệ thống seed cho mọi công ty (`seed_tenant_defaults` + backfill): `CT_KHONG_CAN`, `CT_KHONG_CO_DONG`, `CN_THIEU_DOI_TUONG`, `TK_TONG_HOP_TREN_DONG`, `SO_DU_SAI_LOAI`, `CHUA_GHI_SO_TRONG_KY_KHOA`.
  - `runDataChecks(trx, { from, to, codes? }): Promise<{ results: CheckResult[]; ran: number }>` với `CheckResult = { ruleCode; ruleName; severity; message; fixHint; voucherId; voucherNo; ref; detail }`; lỗi SQL của một quy tắc → kết quả `severity: 'error'`, `message: 'Quy tắc lỗi: ...'` cho quy tắc đó (không làm hỏng các quy tắc khác).
  - Route: `POST /api/data-check/run { from, to, codes? }` (quyền `data_check.run`); CRUD quy tắc qua `/api/catalogs/data_check_rule` (quyền `catalog.*`; quy tắc `is_system` không xóa được, chỉ bật/tắt).

- [ ] **Step 1: Viết test (thất bại)**

`apps/api/test/dataCheck.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
const run = (body: object) => ctx.app.inject({ method: 'POST', url: '/api/data-check/run', headers: { cookie }, payload: body });

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `DC${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  // chứng từ nháp không dòng, kỳ khóa mềm
  await ctx.t.admin.insertInto('voucher').values({ tenant_id: tenantId, voucher_type: 'PKT', posting_date: '2026-01-15', document_date: '2026-01-15', created_by: (await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json().userId }).execute();
  await ctx.app.inject({ method: 'POST', url: '/api/periods/2026/1/lock', headers: { cookie }, payload: { level: 'soft' } });
  // 331 (dư Có) bị dư Nợ do trả thừa
  await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code: 'NCC1', name: 'NCC', is_vendor: true } });
  await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: '2026-02-10', documentDate: '2026-02-10', description: 'trả thừa', autoPost: true, lines: [{ accountCode: '331', debit: '100', partyCode: 'NCC1' }, { accountCode: '1111', credit: '100' }] } });
});
afterAll(async () => { await ctx.close(); });

describe('soát lỗi', () => {
  it('quy tắc hệ thống phát hiện chứng từ nháp không dòng trong kỳ khóa và số dư sai loại', async () => {
    const r = await run({ from: '2026-01-01', to: '2026-12-31' });
    expect(r.statusCode, r.body).toBe(200);
    const codes = (r.json().results as { ruleCode: string }[]).map((x) => x.ruleCode);
    expect(codes).toEqual(expect.arrayContaining(['CT_KHONG_CO_DONG', 'CHUA_GHI_SO_TRONG_KY_KHOA', 'SO_DU_SAI_LOAI']));
    expect((r.json().results as { ruleCode: string; ref: string }[]).find((x) => x.ruleCode === 'SO_DU_SAI_LOAI')!.ref).toContain('331');
    expect(r.json().ran).toBeGreaterThanOrEqual(6);
  });
  it('quy tắc do người dùng thêm chạy được; quy tắc ghi dữ liệu bị từ chối vì read only', async () => {
    const add = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/data_check_rule', headers: { cookie }, payload: { code: 'DG_TRONG', name: 'Chứng từ thiếu diễn giải', severity: 'warning',
      sql: "SELECT v.id AS voucher_id, v.voucher_no AS ref, 'Thiếu diễn giải' AS detail FROM voucher v WHERE v.posting_date BETWEEN $1 AND $2 AND coalesce(v.description,'') = ''", message: 'Chứng từ chưa có diễn giải', fix_hint: 'Bổ sung diễn giải' } });
    expect(add.statusCode, add.body).toBe(201);
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/data_check_rule', headers: { cookie }, payload: { code: 'XAU', name: 'Xấu', severity: 'error', sql: "DELETE FROM voucher RETURNING id AS voucher_id, '' AS ref, '' AS detail", message: 'x' } });
    expect(bad.statusCode).toBe(201);
    const r = await run({ from: '2026-01-01', to: '2026-12-31', codes: ['DG_TRONG', 'XAU'] });
    const res = r.json().results as { ruleCode: string; message: string }[];
    expect(res.some((x) => x.ruleCode === 'DG_TRONG')).toBe(true);
    expect(res.find((x) => x.ruleCode === 'XAU')!.message).toMatch(/Quy tắc lỗi/);
    expect((await sql<{ n: string }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.n).not.toBe('0');
  });
  it('không xóa được quy tắc hệ thống', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/data_check_rule?q=CT_KHONG_CAN', headers: { cookie } });
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/catalogs/data_check_rule/${list.json().rows[0].id}`, headers: { cookie } });
    expect(del.statusCode).toBe(409); expect(del.json().error.code).toBe('RULE_SYSTEM');
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/api test -- test/dataCheck.test.ts` → FAIL 404.

- [ ] **Step 3: Migration và mã**

`packages/db/migrations/0013_soat_loi.sql`:

```sql
CREATE TABLE data_check_rule (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL, name text NOT NULL, severity text NOT NULL CHECK (severity IN ('error','warning')),
  sql text NOT NULL, message text NOT NULL, fix_hint text, is_system boolean NOT NULL DEFAULT false, is_enabled boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code));
SELECT rls_enable('data_check_rule'), audit_enable('data_check_rule');
CREATE OR REPLACE FUNCTION fn_rule_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.is_system THEN RAISE EXCEPTION 'RULE_SYSTEM: không xóa được quy tắc hệ thống, chỉ tắt' USING ERRCODE = 'P0001'; END IF; RETURN OLD; END $$;
CREATE TRIGGER trg_rule_protect BEFORE DELETE ON data_check_rule FOR EACH ROW EXECUTE FUNCTION fn_rule_protect();

CREATE OR REPLACE FUNCTION seed_data_check_rules(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO data_check_rule(tenant_id, code, name, severity, sql, message, fix_hint, is_system) VALUES
  (p_tenant, 'CT_KHONG_CAN', 'Chứng từ không cân', 'error',
   $q$SELECT v.id AS voucher_id, v.voucher_no AS ref, 'Nợ ' || sum(l.debit) || ' / Có ' || sum(l.credit) AS detail FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id WHERE v.state <> 'cancelled' AND v.posting_date BETWEEN $1 AND $2 GROUP BY v.id HAVING sum(l.debit) <> sum(l.credit)$q$,
   'Tổng Nợ khác tổng Có', 'Mở chứng từ và cân lại các dòng', true),
  (p_tenant, 'CT_KHONG_CO_DONG', 'Chứng từ không có dòng định khoản', 'warning',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'Ngày ' || to_char(v.posting_date, 'DD/MM/YYYY') FROM voucher v WHERE v.state = 'draft' AND v.posting_date BETWEEN $1 AND $2 AND NOT EXISTS (SELECT 1 FROM voucher_line l WHERE l.voucher_id = v.id)$q$,
   'Chứng từ nháp rỗng', 'Xóa chứng từ hoặc nhập dòng', true),
  (p_tenant, 'CN_THIEU_DOI_TUONG', 'Dòng công nợ thiếu đối tượng', 'error',
   $q$SELECT v.id, v.voucher_no, 'TK ' || a.code || ' dòng ' || l.line_no FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id WHERE a.subledger_kind IN ('receivable','payable') AND l.party_id IS NULL AND l.posting_date BETWEEN $1 AND $2$q$,
   'Tài khoản công nợ phải có đối tượng', 'Bỏ ghi sổ và bổ sung đối tượng', true),
  (p_tenant, 'TK_TONG_HOP_TREN_DONG', 'Tài khoản tổng hợp trên dòng định khoản', 'error',
   $q$SELECT v.id, v.voucher_no, 'TK ' || a.code FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id WHERE a.is_group AND l.posting_date BETWEEN $1 AND $2$q$,
   'Chỉ định khoản vào tài khoản chi tiết', 'Chuyển sang tiểu khoản', true),
  (p_tenant, 'SO_DU_SAI_LOAI', 'Số dư trái loại dư của tài khoản', 'warning',
   $q$SELECT NULL::uuid, a.code || CASE WHEN p.code IS NOT NULL THEN ' / ' || p.code ELSE '' END, CASE WHEN a.normal_balance = 'debit' THEN 'Dư Có ' || sum(b.credit) ELSE 'Dư Nợ ' || sum(b.debit) END FROM fn_balances_at(app_tenant(), $2) b JOIN account a ON a.id = b.account_id LEFT JOIN party p ON p.id = b.party_id WHERE a.normal_balance IN ('debit','credit') GROUP BY a.code, a.normal_balance, p.code HAVING (a.normal_balance = 'debit' AND sum(b.debit - b.credit) < 0) OR (a.normal_balance = 'credit' AND sum(b.debit - b.credit) > 0)$q$,
   'Số dư cuối kỳ trái với loại dư', 'Kiểm tra định khoản hoặc đổi loại dư tài khoản (lưỡng tính)', true),
  (p_tenant, 'CHUA_GHI_SO_TRONG_KY_KHOA', 'Chứng từ chưa ghi sổ trong kỳ đã khóa', 'error',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'Kỳ ' || v.period_no || '/' || v.fiscal_year FROM voucher v JOIN fiscal_period fp ON fp.tenant_id = v.tenant_id AND fp.fiscal_year = v.fiscal_year AND fp.period_no = v.period_no WHERE v.state = 'draft' AND fp.status <> 'open' AND v.posting_date BETWEEN $1 AND $2$q$,
   'Kỳ đã khóa nhưng còn chứng từ nháp', 'Ghi sổ (cần quyền ghi lùi) hoặc hủy chứng từ', true)
  ON CONFLICT DO NOTHING;
$$;
SELECT seed_data_check_rules(id) FROM tenant;
-- Bổ sung vào seed_tenant_defaults: PERFORM seed_data_check_rules(p_tenant); (định nghĩa lại hàm như Task 14 kèm dòng này)
```

(Định nghĩa lại `seed_tenant_defaults` với nội dung ở Task 14 cộng thêm `PERFORM seed_data_check_rules(p_tenant);` ở cuối.)

`catalogs.ts` thêm:

```ts
{ name: 'data_check_rule', table: 'data_check_rule', label: 'Quy tắc soát lỗi', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
  schema: z.object({ code, name: text(false), severity: z.enum(['error', 'warning']), sql: z.string().min(10), message: text(false), fix_hint: text(), is_enabled: z.boolean().optional() }),
  columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên quy tắc', type: 'text', required: true },
    { key: 'severity', label: 'Mức', type: 'select', required: true, options: [{ value: 'error', label: 'Lỗi' }, { value: 'warning', label: 'Cảnh báo' }] },
    { key: 'sql', label: 'Câu SQL (trả voucher_id, ref, detail; tham số $1 từ ngày, $2 đến ngày)', type: 'text', required: true }, { key: 'message', label: 'Thông điệp', type: 'text', required: true }, { key: 'fix_hint', label: 'Hướng dẫn sửa', type: 'text' }, { key: 'is_enabled', label: 'Bật', type: 'boolean' }] },
```

`apps/api/src/modules/tools/dataCheck.ts`:

```ts
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';

export interface CheckResult { ruleCode: string; ruleName: string; severity: string; message: string; fixHint: string | null; voucherId: string | null; voucherNo: string | null; ref: string | null; detail: string | null }

export async function runDataChecks(trx: Transaction<Database>, f: { from: string; to: string; codes?: string[] | undefined }): Promise<{ results: CheckResult[]; ran: number }> {
  await sql`SET LOCAL transaction_read_only = on`.execute(trx);
  let q = trx.selectFrom('data_check_rule').selectAll().where('is_enabled', '=', true);
  if (f.codes?.length) q = q.where('code', 'in', f.codes);
  const rules = await q.orderBy('code').execute();
  const results: CheckResult[] = [];
  for (const r of rules) {
    const base = { ruleCode: r.code, ruleName: r.name, severity: r.severity, message: r.message, fixHint: r.fix_hint };
    try {
      await sql`SAVEPOINT rule`.execute(trx);
      const rows = await sql<{ voucher_id: string | null; ref: string | null; detail: string | null }>`SELECT q.voucher_id, q.ref, q.detail FROM (${sql.raw(r.sql.replace(/\$1/g, `'${f.from}'::date`).replace(/\$2/g, `'${f.to}'::date`))}) q(voucher_id, ref, detail) LIMIT 1000`.execute(trx);
      await sql`RELEASE SAVEPOINT rule`.execute(trx);
      const ids = rows.rows.map((x) => x.voucher_id).filter((x): x is string => !!x);
      const nos = ids.length ? new Map((await trx.selectFrom('voucher').select(['id', 'voucher_no']).where('id', 'in', ids).execute()).map((v) => [v.id, v.voucher_no])) : new Map<string, string | null>();
      for (const x of rows.rows) results.push({ ...base, voucherId: x.voucher_id, voucherNo: x.voucher_id ? nos.get(x.voucher_id) ?? null : null, ref: x.ref, detail: x.detail });
    } catch (e) {
      await sql`ROLLBACK TO SAVEPOINT rule`.execute(trx);
      results.push({ ...base, severity: 'error', message: `Quy tắc lỗi: ${(e as Error).message}`, voucherId: null, voucherNo: null, ref: null, detail: null });
    }
  }
  return { results, ran: rules.length };
}
```

(`f.from`/`f.to` đã qua Zod regex `YYYY-MM-DD` nên nội suy an toàn; `sql.raw` chỉ nhận câu của quy tắc, chạy trong transaction chỉ đọc nên `DELETE/UPDATE` bị PostgreSQL từ chối với `cannot execute DELETE in a read-only transaction`.)

`apps/api/src/modules/tools/routes.ts`:

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { runDataChecks } from './dataCheck.js';

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post('/api/data-check/run', { preHandler: app.requirePermission('data_check.run'), schema: { body: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), codes: z.array(z.string()).optional() }) } },
    async (req) => app.withTenant(req, (trx) => runDataChecks(trx, req.body)));
};
export default routes;
```

Đăng ký `toolsRoutes` trong `app.ts`; thêm `DataCheckRuleTable` vào `types.ts`.

- [ ] **Step 4: Chạy test**

Run: `pnpm -F @kt/api test -- test/dataCheck.test.ts test/catalogs.test.ts` → PASS.

- [ ] **Step 5: Màn hình soát lỗi**

`apps/web/src/pages/DataCheck.tsx`: khoảng ngày, danh sách quy tắc (checkbox bật/tắt tạm thời cho lần chạy), nút "Soát lỗi"; kết quả nhóm theo quy tắc với `Tag` Lỗi/Cảnh báo, cột tham chiếu, chi tiết, hướng dẫn sửa, liên kết "Sửa chứng từ" mở `/chung-tu/phieu-ke-toan/$id`; liên kết "Quản lý quy tắc" tới `/danh-muc/data_check_rule`. Route `/tien-ich/soat-loi`, nhóm menu "Tiện ích" `{ key: 'tienich', label: 'Tiện ích', to: '/tien-ich', children: [{ key: 'datacheck', label: 'Soát lỗi dữ liệu', to: '/tien-ich/soat-loi', permission: 'data_check.run' }] }`.

- [ ] **Step 6: Commit**

```bash
git add packages/db apps/api apps/web
git commit -m "feat(tools): soát lỗi dữ liệu bằng bảng quy tắc SQL chạy chỉ đọc với 6 quy tắc hệ thống"
```

---

### Task 26: Xuất toàn bộ dữ liệu kế toán theo kỳ cho cơ quan thẩm quyền (CSV + PDF sổ, có bảng băm)

**Files:**
- Create: `apps/api/src/modules/tools/exportAuthority.ts`; Modify: `apps/api/src/modules/tools/routes.ts`
- Create: `apps/web/src/pages/Export.tsx`; Modify: `apps/web/src/router.tsx`
- Create: `docs/user/xuat-du-lieu-co-quan-thue.md`
- Test: `apps/api/test/exportAuthority.test.ts`

**Interfaces:**
- Consumes: `bookSetDocs`, `renderPdf`, `renderReportsHtml` (Task 24), `archiver`.
- Produces:
  - `buildAuthorityPackage(trx, tenantId, { from, to }): Promise<Buffer>` (zip): `README.txt` (tên công ty, MST, khoảng kỳ, thời điểm xuất, mô tả từng tệp và cột, mã hóa UTF-8 có BOM, dấu phân cách `;`), `chung_tu.csv`, `dong_chung_tu.csv`, `he_thong_tai_khoan.csv`, `doi_tuong.csv`, `ky_ke_toan.csv`, `nhat_ky_kiem_toan.csv` (sự kiện trong khoảng), `so_nhat_ky_chung.pdf`, `so_cai.pdf`, `bang_can_doi_so_phat_sinh.pdf`, `B01.pdf/B02.pdf/B03.pdf` (khi có định nghĩa), `MANIFEST.sha256` (băm từng tệp).
  - `POST /api/export/authority { from, to }` (quyền `export.authority`) → `application/zip`, ghi `audit_event` hành động `export` với khoảng kỳ.
  - `toCsv(rows: Record<string, unknown>[], columns: string[]): string` (BOM, `;`, bọc nháy kép khi cần).

- [ ] **Step 1: Viết test (thất bại)**

`apps/api/test/exportAuthority.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `EX${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  for (let i = 1; i <= 3; i++) await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: `2026-01-0${i}`, documentDate: `2026-01-0${i}`, description: `CT ${i}`, autoPost: true, lines: [{ accountCode: '6422', debit: String(i * 1000) }, { accountCode: '1111', credit: String(i * 1000) }] } });
});
afterAll(async () => { await ctx.close(); });

describe('xuất dữ liệu cho cơ quan thẩm quyền', () => {
  it('gói zip đủ tệp, CSV đúng số dòng, băm khớp, có audit', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/export/authority', headers: { cookie }, payload: { from: '2026-01-01', to: '2026-01-31' } });
    expect(r.statusCode, r.body).toBe(200); expect(r.headers['content-type']).toBe('application/zip');
    const dir = mkdtempSync(path.join(tmpdir(), 'kt-export-')); const zip = path.join(dir, 'x.zip'); writeFileSync(zip, r.rawPayload);
    execSync(`unzip -q "${zip}" -d "${dir}/out"`);
    const files = readdirSync(`${dir}/out`);
    expect(files).toEqual(expect.arrayContaining(['README.txt', 'chung_tu.csv', 'dong_chung_tu.csv', 'he_thong_tai_khoan.csv', 'doi_tuong.csv', 'ky_ke_toan.csv', 'nhat_ky_kiem_toan.csv', 'so_nhat_ky_chung.pdf', 'so_cai.pdf', 'bang_can_doi_so_phat_sinh.pdf', 'MANIFEST.sha256']));
    const ct = readFileSync(`${dir}/out/chung_tu.csv`, 'utf8'); expect(ct.charCodeAt(0)).toBe(0xfeff); expect(ct.trim().split('\n')).toHaveLength(4);
    expect(readFileSync(`${dir}/out/dong_chung_tu.csv`, 'utf8').trim().split('\n')).toHaveLength(7);
    for (const line of readFileSync(`${dir}/out/MANIFEST.sha256`, 'utf8').trim().split('\n')) {
      const [hash, name] = line.split(/\s+/); expect(createHash('sha256').update(readFileSync(`${dir}/out/${name}`)).digest('hex')).toBe(hash);
    }
    const ev = await sql<{ n: string }>`SELECT count(*) AS n FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND action = 'export'`.execute(ctx.t.admin);
    expect(ev.rows[0]!.n).toBe('1');
  }, 120_000);
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pnpm -F @kt/api test -- test/exportAuthority.test.ts` → FAIL 404.

- [ ] **Step 3: Mã xuất**

`apps/api/src/modules/tools/exportAuthority.ts`:

```ts
import archiver from 'archiver';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { renderPdf } from '../reporting/print/pdf.js';
import { renderReportsHtml } from '../reporting/print/html.js';
import { bookSetDocs } from '../reporting/print/bookSet.js';

type Trx = Transaction<Database>;
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [columns.join(';'), ...rows.map((r) => columns.map((c) => esc(r[c])).join(';'))].join('\n') + '\n';
}

export async function buildAuthorityPackage(trx: Trx, tenantId: string, p: { from: string; to: string }): Promise<Buffer> {
  const t = await trx.selectFrom('tenant').selectAll().where('id', '=', tenantId).executeTakeFirstOrThrow();
  const files: { name: string; data: Buffer }[] = [];
  const addCsv = (name: string, rows: Record<string, unknown>[], cols: string[]) => files.push({ name, data: Buffer.from(toCsv(rows, cols), 'utf8') });
  const vouchers = (await sql<Record<string, unknown>>`SELECT v.id, v.voucher_type, v.voucher_no, v.seq_no, v.posting_date, v.document_date, v.state, v.description, p.code AS party_code, p.name AS party_name, v.currency_code, v.fx_rate, v.is_closing, v.reversal_of_id, v.reversed_by_id, v.source_doc_type, v.source_doc_id, u.username AS created_by, v.created_at, pu.username AS posted_by, v.posted_at, encode(v.row_hash, 'hex') AS row_hash
    FROM voucher v LEFT JOIN party p ON p.id = v.party_id LEFT JOIN app_user u ON u.id = v.created_by LEFT JOIN app_user pu ON pu.id = v.posted_by WHERE v.posting_date BETWEEN ${p.from}::date AND ${p.to}::date AND v.state <> 'draft' ORDER BY v.posting_date, v.voucher_type, v.seq_no`.execute(trx)).rows;
  addCsv('chung_tu.csv', vouchers, ['id', 'voucher_type', 'voucher_no', 'seq_no', 'posting_date', 'document_date', 'state', 'description', 'party_code', 'party_name', 'currency_code', 'fx_rate', 'is_closing', 'reversal_of_id', 'reversed_by_id', 'source_doc_type', 'source_doc_id', 'created_by', 'created_at', 'posted_by', 'posted_at', 'row_hash']);
  const lines = (await sql<Record<string, unknown>>`SELECT l.voucher_id, v.voucher_no, l.line_no, a.code AS account_code, a.name AS account_name, l.debit, l.credit, l.currency_code, l.amount_currency, l.fx_rate, p.code AS party_code, d.code AS department_code, pr.code AS project_code, ci.code AS cost_item_code, e.code AS employee_code, l.description, l.due_date, l.posting_date
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id LEFT JOIN party p ON p.id = l.party_id LEFT JOIN department d ON d.id = l.department_id LEFT JOIN project pr ON pr.id = l.project_id LEFT JOIN cost_item ci ON ci.id = l.cost_item_id LEFT JOIN employee e ON e.id = l.employee_id
    WHERE v.posting_date BETWEEN ${p.from}::date AND ${p.to}::date AND v.state <> 'draft' ORDER BY v.posting_date, v.voucher_type, v.seq_no, l.line_no`.execute(trx)).rows;
  addCsv('dong_chung_tu.csv', lines, ['voucher_id', 'voucher_no', 'line_no', 'account_code', 'account_name', 'debit', 'credit', 'currency_code', 'amount_currency', 'fx_rate', 'party_code', 'department_code', 'project_code', 'cost_item_code', 'employee_code', 'description', 'due_date', 'posting_date']);
  addCsv('he_thong_tai_khoan.csv', await trx.selectFrom('account').select(['regime', 'code', 'name', 'is_group', 'root_type', 'normal_balance', 'subledger_kind', 'track_currency', 'is_active']).orderBy('regime').orderBy('code').execute() as Record<string, unknown>[], ['regime', 'code', 'name', 'is_group', 'root_type', 'normal_balance', 'subledger_kind', 'track_currency', 'is_active']);
  addCsv('doi_tuong.csv', await trx.selectFrom('party').select(['code', 'name', 'tax_code', 'address', 'is_customer', 'is_vendor', 'is_employee', 'is_active']).orderBy('code').execute() as Record<string, unknown>[], ['code', 'name', 'tax_code', 'address', 'is_customer', 'is_vendor', 'is_employee', 'is_active']);
  addCsv('ky_ke_toan.csv', (await trx.selectFrom('fiscal_period').select(['fiscal_year', 'period_no', 'date_from', 'date_to', 'regime', 'status', sql<string>`encode(hash_tail, 'hex')`.as('hash_tail'), 'locked_at']).orderBy('fiscal_year').orderBy('period_no').execute()) as Record<string, unknown>[], ['fiscal_year', 'period_no', 'date_from', 'date_to', 'regime', 'status', 'hash_tail', 'locked_at']);
  addCsv('nhat_ky_kiem_toan.csv', (await trx.selectFrom('audit_event as a').leftJoin('app_user as u', 'u.id', 'a.user_id').select(['a.ts', 'u.username', 'a.action', 'a.entity', 'a.entity_id', sql<string>`a.before::text`.as('before'), sql<string>`a.after::text`.as('after'), 'a.ip'])
    .where('a.ts', '>=', p.from).where('a.ts', '<', sql<string>`(${p.to}::date + 1)`).orderBy('a.id').execute()) as Record<string, unknown>[], ['ts', 'username', 'action', 'entity', 'entity_id', 'before', 'after', 'ip']);
  const year = Number(p.to.slice(0, 4));
  const docs = await bookSetDocs(trx, tenantId, year, ['journal', 'ledgers', 'trial', 'B01', 'B02', 'B03']);
  const pick = (pred: (title: string) => boolean) => docs.filter((d) => pred(d.title));
  const pdfs: [string, typeof docs][] = [['so_nhat_ky_chung.pdf', pick((x) => x.startsWith('Sổ Nhật ký chung'))], ['so_cai.pdf', pick((x) => x.startsWith('Sổ Cái'))], ['bang_can_doi_so_phat_sinh.pdf', pick((x) => x.startsWith('Bảng cân đối số phát sinh'))],
    ['B01.pdf', docs.filter((d) => d.formNo.startsWith('B01'))], ['B02.pdf', docs.filter((d) => d.formNo.startsWith('B02'))], ['B03.pdf', docs.filter((d) => d.formNo.startsWith('B03'))]];
  for (const [name, ds] of pdfs) if (ds.length) files.push({ name, data: await renderPdf(renderReportsHtml(ds), { landscape: ds.some((d) => d.landscape) }) });
  const readme = [`CÔNG TY: ${t.name}`, `MÃ SỐ THUẾ: ${t.tax_code ?? ''}`, `KHOẢNG KỲ: ${p.from} đến ${p.to}`, `THỜI ĐIỂM XUẤT: ${new Date().toISOString()}`, '',
    'Tệp CSV mã hóa UTF-8 có BOM, phân cách bằng dấu chấm phẩy (;), tiền hạch toán VND là số nguyên, ngày dạng YYYY-MM-DD.',
    'chung_tu.csv: phần đầu chứng từ đã ghi sổ (gồm đã đảo, đã hủy); row_hash là băm SHA-256 chuỗi khi kỳ khóa cứng.',
    'dong_chung_tu.csv: dòng định khoản (debit/credit theo VND, amount_currency theo nguyên tệ có dấu).',
    'he_thong_tai_khoan.csv, doi_tuong.csv, ky_ke_toan.csv: danh mục và trạng thái khóa kỳ.',
    'nhat_ky_kiem_toan.csv: mọi thay đổi trong khoảng kỳ với giá trị trước/sau (Điều 28 TT 99/2025).',
    'so_*.pdf, B0*.pdf: sổ kế toán và báo cáo tài chính năm chứa ngày kết thúc.', 'MANIFEST.sha256: băm SHA-256 từng tệp để kiểm tra toàn vẹn.'].join('\n');
  files.unshift({ name: 'README.txt', data: Buffer.from(readme, 'utf8') });
  files.push({ name: 'MANIFEST.sha256', data: Buffer.from(files.map((f) => `${createHash('sha256').update(f.data).digest('hex')}  ${f.name}`).join('\n') + '\n', 'utf8') });
  const out = new PassThrough(); const chunks: Buffer[] = []; out.on('data', (c: Buffer) => chunks.push(c));
  const zip = archiver('zip', { zlib: { level: 6 } }); zip.pipe(out);
  for (const f of files) zip.append(f.data, { name: f.name });
  await zip.finalize(); await new Promise<void>((res) => out.on('end', () => res()));
  return Buffer.concat(chunks);
}
```

Thêm vào `tools/routes.ts`:

```ts
app.post('/api/export/authority', { preHandler: app.requirePermission('export.authority'), schema: { body: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }) } }, async (req, reply) => {
  const buf = await app.withTenant(req, async (trx) => {
    const b = await buildAuthorityPackage(trx, req.auth!.tenantId!, req.body);
    await sql`INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, after, ip) VALUES (${req.auth!.tenantId!}::uuid, app_user_id(), 'export', 'tenant', ${req.auth!.tenantId!}, ${JSON.stringify(req.body)}::jsonb, ${req.ip})`.execute(trx);
    return b;
  });
  return reply.type('application/zip').header('content-disposition', `attachment; filename="xuat-du-lieu-${req.body.from}-${req.body.to}.zip"`).send(buf);
});
```

- [ ] **Step 4: Chạy test**

Run: `pnpm -F @kt/api test -- test/exportAuthority.test.ts` → PASS.

- [ ] **Step 5: Màn hình, tài liệu**

`apps/web/src/pages/Export.tsx`: chọn khoảng ngày, nút "Xuất gói dữ liệu" tải blob; ghi chú nội dung gói. Route `/tien-ich/xuat-du-lieu`, menu `{ key: 'export', label: 'Xuất dữ liệu cho cơ quan thẩm quyền', to: '/tien-ich/xuat-du-lieu', permission: 'export.authority' }`.

`docs/user/xuat-du-lieu-co-quan-thue.md`: mô tả mục đích (Điều 28 TT 99/2025: cung cấp dữ liệu đầu ra), cách xuất, nội dung từng tệp, cách kiểm tra `MANIFEST.sha256` (`shasum -a 256 -c MANIFEST.sha256`), cách kiểm tra hash chuỗi kỳ khóa cứng bằng `pnpm -F @kt/api cli verify-hash`.

- [ ] **Step 6: Commit**

```bash
git add apps/api apps/web docs/user
git commit -m "feat(tools): xuất gói dữ liệu kế toán theo kỳ (CSV, PDF sổ, bảng băm) cho cơ quan thẩm quyền"
```

---

### Task 27: Kiểm thử bất biến 1–4, 6 bằng fast-check và bộ dữ liệu mẫu doanh nghiệp dịch vụ một năm với BCTC kỳ vọng

**Files:**
- Create: `apps/api/test/invariants/helpers.ts`, `apps/api/test/invariants/inv1-can-bang.test.ts`, `apps/api/test/invariants/inv2-chuoi-thao-tac.test.ts`, `apps/api/test/invariants/inv3-idempotency.test.ts`, `apps/api/test/invariants/inv4-can-doi-ke-toan.test.ts`, `apps/api/test/invariants/inv6-khoa-cung.test.ts`
- Create: `packages/db/src/seed/dich-vu-xyz.ts`, `packages/db/src/seed/expected-bctc-xyz.json`
- Create: `apps/api/test/sample-xyz.test.ts`, `docs/user/giai-doan-1-so-cai.md`
- Modify: `.github/workflows/ci.yml` (job `invariants` chạy riêng, `timeout-minutes: 30`)

**Interfaces:**
- Consumes: toàn bộ API GĐ1.
- Produces:
  - `invariants/helpers.ts`: `setupLedgerTenant(ctx, code, regime = 'TT133')` (tạo công ty, năm 2026, 3 đối tượng, trả `{ cookie, tenantId, userId }`); `postVoucher(ctx, cookie, date, lines)`; `sumFromLines(admin, tenantId, asOf)`; `snapshot(ctx, cookie, asOf)`; `recompute(ctx, cookie)`; sinh dữ liệu fast-check: `arbAmount` (1..10^9), `arbDate2026`, `arbBalancedLines(accounts)` (n dòng Nợ, m dòng Có, tổng bằng nhau), `arbUnbalancedLines`.
  - `seedXyz(adminUrl): Promise<{ tenantId: string; created: boolean }>`; công ty `XYZ` "Công ty TNHH Dịch vụ Tư vấn XYZ", MST `0109876543`, năm 2026, chế độ `TT99` nếu `tt99Status().complete` ngược lại `TT133`; 12 tháng nghiệp vụ lặp theo bảng dưới; kết chuyển cuối năm; `expected-bctc-xyz.json` số tính tay.
  - Dữ liệu mẫu XYZ (số dư đầu 01/01/2026: 1111 Nợ 200.000.000; 1121 Nợ 800.000.000; 4111 Có 1.000.000.000) và mỗi tháng `m` = 1..12:

    | Ngày | Nghiệp vụ | Định khoản |
    |---|---|---|
    | m/05 | Doanh thu dịch vụ tư vấn KH001 | Nợ 131 (KH001) 110.000.000 / Có 5113 100.000.000, Có 33311 10.000.000 |
    | m/10 | Thuê văn phòng NCC001 | Nợ 6427 20.000.000, Nợ 1331 2.000.000 / Có 331 (NCC001) 22.000.000 |
    | m/15 | Văn phòng phẩm tiền mặt | Nợ 6422 5.000.000, Nợ 1331 500.000 / Có 1111 5.500.000 |
    | m/20 | Thu tiền KH001 | Nợ 1121 110.000.000 / Có 131 (KH001) 110.000.000 |
    | m/25 | Trả NCC001 | Nợ 331 (NCC001) 22.000.000 / Có 1121 22.000.000 |
    | m/28 | Lương | Nợ 6421 50.000.000 / Có 334 50.000.000; Nợ 334 50.000.000 / Có 1121 50.000.000 |
    | 31/12 | Khấu trừ thuế GTGT | Nợ 33311 30.000.000 / Có 1331 30.000.000 |
    | 31/12 | Thuế TNDN 20% | Nợ 8211 (hoặc 821 nếu chế độ không có 8211) 60.000.000 / Có 3334 60.000.000 |
    | 31/12 | Kết chuyển | `POST /api/closing/run-all` ngày 2026-12-31 |

    Mã tài khoản chọn theo danh sách ứng viên: `pick(['5113','511'])`, `pick(['33311','3331'])`, `pick(['8211','821'])`, `pick(['6421','642'])`, `pick(['6422','642'])`, `pick(['6427','642'])`, `pick(['4111','411'])`, lấy mã đầu tiên tồn tại và là tài khoản chi tiết.
  - `expected-bctc-xyz.json`:

    ```json
    {
      "asOf": "2026-12-31",
      "soDuCuoiKy": { "1111": "134000000", "1121": "1256000000", "131": "0", "1331": "0", "331": "0", "334": "0", "33311": "90000000", "3334": "60000000", "4111": "1000000000", "4212": "240000000", "911": "0", "5113": "0", "6421": "0", "6422": "0", "6427": "0", "8211": "0" },
      "tongTaiSan": "1390000000", "noPhaiTra": "150000000", "vonChuSoHuu": "1240000000",
      "kqkd": { "doanhThuThuan": "1200000000", "chiPhiQuanLy": "900000000", "loiNhuanTruocThue": "300000000", "chiPhiThueTNDN": "60000000", "loiNhuanSauThue": "240000000" },
      "lctt": { "thuTuKhachHang": "1320000000", "chiChoNhaCungCap": "264000000", "chiChoNguoiLaoDong": "600000000", "chiKhac": "66000000", "luuChuyenThuan": "390000000" }
    }
    ```

    Số kiểm tra tay: tiền mặt 200 − 12×5,5 = 134 triệu; tiền gửi 800 + 12×110 − 12×22 − 12×50 = 1.256 triệu; thuế GTGT đầu ra 120 triệu trừ khấu trừ 30 triệu còn 90 triệu; lợi nhuận 1.200 − (600 + 60 + 240) = 300 triệu, thuế 60, sau thuế 240; tổng tài sản 1.390 = nợ phải trả 150 + vốn 1.240; lưu chuyển tiền thuần 1.320 − 264 − 600 − 66 = 390 = (134 + 1.256) − 1.000.

- [ ] **Step 1: Helper và bất biến 1 (cân bằng)**

`apps/api/test/invariants/helpers.ts`:

```ts
import fc from 'fast-check';
import { sql } from 'kysely';
import { bootstrapTenant, type TestApp } from '../helpers.js';

// Tài khoản chi tiết tồn tại ở cả TT133 và TT99, không theo dõi đối tượng.
export const ACCOUNTS = ['1111', '1121', '5113', '6421', '6422', '242', '33311', '4111'];
export async function setupLedgerTenant(ctx: TestApp, code: string, regime: 'TT133' | 'TT99' = 'TT133') {
  const b = await bootstrapTenant(ctx, { code });
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: b.cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime } });
  for (const [c, n] of [['KH001', 'Khách 1'], ['KH002', 'Khách 2'], ['NCC001', 'NCC 1']]) await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie: b.cookie }, payload: { code: c, name: n, is_customer: true, is_vendor: true } });
  return b;
}
export const postVoucher = (ctx: TestApp, cookie: string, date: string, lines: object[], extra: object = {}) =>
  ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'inv', autoPost: true, lines, ...extra } });
export async function sumFromLines(ctx: TestApp, tenantId: string, asOf: string): Promise<Record<string, string>> {
  const r = await sql<{ code: string; net: string }>`SELECT a.code, sum(l.debit - l.credit)::text AS net FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND l.posting_date <= ${asOf}::date GROUP BY a.code HAVING sum(l.debit - l.credit) <> 0`.execute(ctx.t.admin);
  return Object.fromEntries(r.rows.map((x) => [x.code, x.net]));
}
export async function snapshot(ctx: TestApp, cookie: string, asOf: string): Promise<Record<string, string>> {
  const r = await ctx.app.inject({ method: 'GET', url: `/api/balances?asOf=${asOf}`, headers: { cookie } });
  return Object.fromEntries((r.json().rows as { accountCode: string; debit: string; credit: string }[]).map((x) => [x.accountCode, (BigInt(x.debit) - BigInt(x.credit)).toString()]));
}
export const recompute = (ctx: TestApp, cookie: string) => ctx.app.inject({ method: 'POST', url: '/api/balances/recompute', headers: { cookie } });
export const arbAmount = fc.bigInt({ min: 1n, max: 1_000_000_000n }).map(String);
export const arbDate2026 = fc.record({ m: fc.integer({ min: 1, max: 12 }), d: fc.integer({ min: 1, max: 28 }) }).map(({ m, d }) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
export const arbBalancedLines = fc.record({ debits: fc.array(fc.record({ acc: fc.constantFrom(...ACCOUNTS), amt: arbAmount }), { minLength: 1, maxLength: 4 }), credits: fc.array(fc.constantFrom(...ACCOUNTS), { minLength: 1, maxLength: 4 }) })
  .map(({ debits, credits }) => {
    const total = debits.reduce((s, d) => s + BigInt(d.amt), 0n); const each = total / BigInt(credits.length); const rest = total - each * BigInt(credits.length);
    return [...debits.map((d) => ({ accountCode: d.acc, debit: d.amt })), ...credits.map((c, i) => ({ accountCode: c, credit: (each + (i === 0 ? rest : 0n)).toString() })).filter((c) => c.credit !== '0')];
  });
```

`apps/api/test/invariants/inv1-can-bang.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { arbBalancedLines, arbDate2026, postVoucher, setupLedgerTenant } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => { ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `I1${Date.now()}`)); });
afterAll(async () => { await ctx.close(); });

describe('Bất biến 1: mọi chứng từ ghi sổ cân; chứng từ lệch bị từ chối', () => {
  it('chứng từ cân luôn ghi được và SUM(debit)=SUM(credit) trong DB', async () => {
    await fc.assert(fc.asyncProperty(arbDate2026, arbBalancedLines, async (date, lines) => {
      const r = await postVoucher(ctx, cookie, date, lines);
      expect(r.statusCode, r.body).toBe(201);
    }), { numRuns: 30 });
    const bad = await sql<{ n: string }>`SELECT count(*) AS n FROM (SELECT voucher_id FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id WHERE v.tenant_id = ${tenantId}::uuid GROUP BY voucher_id HAVING sum(debit) <> sum(credit)) x`.execute(ctx.t.admin);
    expect(bad.rows[0]!.n).toBe('0');
  });
  it('lệch một đồng ở bất kỳ dòng nào đều bị từ chối với VOUCHER_UNBALANCED', async () => {
    await fc.assert(fc.asyncProperty(arbDate2026, arbBalancedLines, fc.nat(), async (date, lines, k) => {
      const i = k % lines.length; const l = lines[i]!;
      const tweaked = lines.map((x, j) => j !== i ? x : ('debit' in x ? { ...x, debit: (BigInt(x.debit) + 1n).toString() } : { ...x, credit: (BigInt((x as { credit: string }).credit) + 1n).toString() }));
      void l;
      const r = await postVoucher(ctx, cookie, date, tweaked);
      expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('VOUCHER_UNBALANCED');
    }), { numRuns: 30 });
  });
});
```

Run: `pnpm -F @kt/api test -- test/invariants/inv1-can-bang.test.ts` → PASS 2.

- [ ] **Step 2: Bất biến 2 (chuỗi thao tác ngẫu nhiên) và 3 (idempotency)**

`apps/api/test/invariants/inv2-chuoi-thao-tac.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { arbBalancedLines, arbDate2026, postVoucher, recompute, setupLedgerTenant, snapshot, sumFromLines } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => { ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `I2${Date.now()}`)); });
afterAll(async () => { await ctx.close(); });

type Op = { kind: 'post'; date: string; lines: object[] } | { kind: 'reverse' } | { kind: 'unpost' } | { kind: 'backdate'; lines: object[] };
const arbOp: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('post' as const), date: arbDate2026, lines: arbBalancedLines }),
  fc.record({ kind: fc.constant('reverse' as const) }), fc.record({ kind: fc.constant('unpost' as const) }),
  fc.record({ kind: fc.constant('backdate' as const), lines: arbBalancedLines }));

describe('Bất biến 2: chuỗi post/reverse/unpost/ghi lùi ngày ngẫu nhiên', () => {
  it('snapshot = SUM dòng tại mọi ngày; gốc + đảo = 0 theo tài khoản và đối tượng', async () => {
    const posted: { id: string; date: string }[] = [];
    await fc.assert(fc.asyncProperty(fc.array(arbOp, { minLength: 5, maxLength: 15 }), async (ops) => {
      for (const op of ops) {
        if (op.kind === 'post') { const r = await postVoucher(ctx, cookie, op.date, op.lines); if (r.statusCode === 201) posted.push({ id: r.json().id, date: op.date }); }
        else if (op.kind === 'backdate') { const r = await postVoucher(ctx, cookie, '2026-01-02', op.lines); if (r.statusCode === 201) posted.push({ id: r.json().id, date: '2026-01-02' }); }
        else if (op.kind === 'reverse' && posted.length) { const v = posted[posted.length - 1]!; const r = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/reverse`, headers: { cookie }, payload: { postingDate: v.date } }); if (r.statusCode === 201) posted.pop(); }
        else if (op.kind === 'unpost' && posted.length) { const v = posted.shift()!; const r = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/unpost`, headers: { cookie } }); if (r.statusCode === 200) { const p = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/post`, headers: { cookie } }); if (p.statusCode === 200) posted.push(v); } }
      }
      await recompute(ctx, cookie);
      for (const d of ['2026-01-15', '2026-03-31', '2026-07-31', '2026-12-31']) expect(await snapshot(ctx, cookie, d), d).toEqual(await sumFromLines(ctx, tenantId, d));
    }), { numRuns: 6 });
    const pairs = await sql<{ n: string }>`SELECT count(*) AS n FROM (
      SELECT l.account_id, l.party_id, sum(l.debit - l.credit) AS s FROM voucher v JOIN voucher r ON r.reversal_of_id = v.id JOIN voucher_line l ON l.voucher_id IN (v.id, r.id)
      WHERE v.tenant_id = ${tenantId}::uuid AND v.state = 'reversed' GROUP BY l.account_id, l.party_id HAVING sum(l.debit - l.credit) <> 0) x`.execute(ctx.t.admin);
    expect(pairs.rows[0]!.n).toBe('0');
  }, 300_000);
});
```

`apps/api/test/invariants/inv3-idempotency.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { arbBalancedLines, arbDate2026, postVoucher, setupLedgerTenant } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => { ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `I3${Date.now()}`)); });
afterAll(async () => { await ctx.close(); });

describe('Bất biến 3: cùng idempotency_key lặp k lần', () => {
  it('đúng một chứng từ, tổng phát sinh không đổi', async () => {
    await fc.assert(fc.asyncProperty(arbDate2026, arbBalancedLines, fc.integer({ min: 2, max: 8 }), fc.uuid(), async (date, lines, k, key) => {
      const before = await sql<{ s: string }>`SELECT coalesce(sum(debit),0)::text AS s FROM voucher_line WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin);
      const rs = await Promise.all(Array.from({ length: k }, () => postVoucher(ctx, cookie, date, lines, { idempotencyKey: key })));
      expect(new Set(rs.map((r) => r.json().id)).size).toBe(1);
      const n = await sql<{ n: string }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND idempotency_key = ${key}`.execute(ctx.t.admin);
      expect(n.rows[0]!.n).toBe('1');
      const after = await sql<{ s: string }>`SELECT coalesce(sum(debit),0)::text AS s FROM voucher_line WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin);
      const expected = BigInt(before.rows[0]!.s) + lines.reduce((s, l) => s + BigInt('debit' in l ? (l as { debit: string }).debit : '0'), 0n);
      expect(after.rows[0]!.s).toBe(expected.toString());
    }), { numRuns: 15 });
  }, 120_000);
});
```

Run: `pnpm -F @kt/api test -- test/invariants/inv2-chuoi-thao-tac.test.ts test/invariants/inv3-idempotency.test.ts` → PASS.

- [ ] **Step 3: Dữ liệu mẫu XYZ**

`packages/db/src/seed/dich-vu-xyz.ts`:

```ts
import 'dotenv/config';
import pg from 'pg';
import argon2 from 'argon2';
import { tt99Status } from '@kt/coa-data';
import { ensureTenant, ensureUser, generateAccountsSql, insertFiscalYear, withTenantClient } from './common.js';

const M = (n: number) => String(n * 1_000_000);
export async function seedXyz(adminUrl: string): Promise<{ tenantId: string; created: boolean }> {
  const c = new pg.Client({ connectionString: adminUrl }); await c.connect();
  try {
    const admin = await ensureUser(c, 'admin', await argon2.hash('Matkhau1!'), 'Quản trị hệ thống');
    const t = await ensureTenant(c, { code: 'XYZ', name: 'Công ty TNHH Dịch vụ Tư vấn XYZ', taxCode: '0109876543', ownerUserId: admin });
    if (!t.created) return { tenantId: t.id, created: false };
    const regime = tt99Status().complete ? 'TT99' : 'TT133';
    await withTenantClient(c, t.id, async () => {
      await c.query(`SELECT set_config('app.current_user', $1, true)`, [admin]);
      await insertFiscalYear(c, t.id, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime });
      await generateAccountsSql(c, t.id, regime);
      const acc = new Map<string, number>((await c.query('SELECT code, id FROM account WHERE tenant_id = $1 AND NOT is_group', [t.id])).rows.map((r) => [r.code, r.id]));
      const pick = (cands: string[]) => { const f = cands.find((x) => acc.has(x)); if (!f) throw new Error(`Không có tài khoản nào trong ${cands.join(',')}`); return f; };
      const K = { tm: pick(['1111']), tg: pick(['1121']), pthu: pick(['131']), ptra: pick(['331']), vatIn: pick(['1331']), vatOut: pick(['33311', '3331']), tndn: pick(['3334']), luong: pick(['334']), von: pick(['4111', '411']),
        dt: pick(['5113', '511']), cpl: pick(['6421', '642']), cpvpp: pick(['6422', '642']), cpthue: pick(['6427', '6422', '642']), cptndn: pick(['8211', '821']) };  // TT133 không có 6427: thuê văn phòng ghi vào 6422
      const kh = (await c.query(`INSERT INTO party(tenant_id, code, name, is_customer, tax_code) VALUES ($1,'KH001','Công ty Cổ phần Khách hàng Lớn',true,'0101111111') RETURNING id`, [t.id])).rows[0].id;
      const ncc = (await c.query(`INSERT INTO party(tenant_id, code, name, is_vendor, tax_code) VALUES ($1,'NCC001','Công ty TNHH Cho thuê Văn phòng',true,'0102222222') RETURNING id`, [t.id])).rows[0].id;
      const ob = async (code: string, d: string, cr: string) => c.query(`INSERT INTO opening_balance(tenant_id, fiscal_year, account_id, debit, credit) VALUES ($1, 2026, $2, $3, $4)`, [t.id, acc.get(code), d, cr]);
      await ob(K.tm, M(200), '0'); await ob(K.tg, M(800), '0'); await ob(K.von, '0', M(1000));
      const p0 = (await c.query(`SELECT date_from FROM fiscal_period WHERE tenant_id = $1 AND fiscal_year = 2026 AND period_no = 0`, [t.id])).rows[0].date_from;
      const voucher = async (type: string, date: string, desc: string, lines: [string, string, string, string | null][]) => {
        const v = (await c.query(`INSERT INTO voucher(tenant_id, voucher_type, posting_date, document_date, description, created_by, source_doc_type) VALUES ($1,$2,$3,$3,$4,$5,$6) RETURNING id`, [t.id, type, date, desc, admin, type === 'DK' ? 'opening_balance' : null])).rows[0].id;
        let n = 0;
        for (const [code, d, cr, party] of lines) await c.query(`INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, amount_currency, party_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [t.id, v, ++n, acc.get(code), date, d, cr, (BigInt(d) - BigInt(cr)).toString(), party]);
        await c.query('SELECT post_voucher($1)', [v]);
      };
      await voucher('DK', p0, 'Số dư đầu kỳ năm 2026', [[K.tm, M(200), '0', null], [K.tg, M(800), '0', null], [K.von, '0', M(1000), null]]);
      for (let m = 1; m <= 12; m++) {
        const d = (day: number) => `2026-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        await voucher('PKT', d(5), `Doanh thu dịch vụ tư vấn tháng ${m}`, [[K.pthu, M(110), '0', kh], [K.dt, '0', M(100), null], [K.vatOut, '0', M(10), null]]);
        await voucher('PKT', d(10), `Thuê văn phòng tháng ${m}`, [[K.cpthue, M(20), '0', null], [K.vatIn, M(2), '0', null], [K.ptra, '0', M(22), ncc]]);
        await voucher('PKT', d(15), `Văn phòng phẩm tháng ${m}`, [[K.cpvpp, M(5), '0', null], [K.vatIn, '500000', '0', null], [K.tm, '0', '5500000', null]]);
        await voucher('PKT', d(20), `Thu tiền khách hàng tháng ${m}`, [[K.tg, M(110), '0', null], [K.pthu, '0', M(110), kh]]);
        await voucher('PKT', d(25), `Trả tiền thuê văn phòng tháng ${m}`, [[K.ptra, M(22), '0', ncc], [K.tg, '0', M(22), null]]);
        await voucher('PKT', d(28), `Tính lương tháng ${m}`, [[K.cpl, M(50), '0', null], [K.luong, '0', M(50), null]]);
        await voucher('PKT', d(28), `Chi lương tháng ${m}`, [[K.luong, M(50), '0', null], [K.tg, '0', M(50), null]]);
      }
      await voucher('PKT', '2026-12-31', 'Khấu trừ thuế GTGT năm 2026', [[K.vatOut, M(30), '0', null], [K.vatIn, '0', M(30), null]]);
      await voucher('PKT', '2026-12-31', 'Thuế TNDN năm 2026 (20%)', [[K.cptndn, M(60), '0', null], [K.tndn, '0', M(60), null]]);
      for (const s of (await c.query(`SELECT id FROM closing_step WHERE tenant_id = $1 AND run_at = 'period_end' AND is_active ORDER BY step_order`, [t.id])).rows) await c.query('SELECT run_closing_step($1, $2, $3)', [t.id, s.id, '2026-12-31']);
      await c.query('SELECT recompute_balances($1)', [t.id]);
    });
    return { tenantId: t.id, created: true };
  } finally { await c.end(); }
}
if (process.argv[1] && process.argv[1].endsWith('dich-vu-xyz.ts')) { const r = await seedXyz(process.env.DATABASE_ADMIN_URL!); console.log(r.created ? `Đã tạo công ty mẫu XYZ (${r.tenantId})` : `Công ty XYZ đã có (${r.tenantId})`); }
```

Lưu ý: `closing_step` được nạp bởi API khi tạo năm (Task 21); seed chạy bằng SQL thuần nên gọi `loadClosingTemplate` tương đương: thêm vào `seed/common.ts` hàm `insertDefaultClosingSteps(c, tenantId)` chèn từ `loadDefaultClosingSteps()` và gọi ngay sau `generateAccountsSql` trong seed này.

- [ ] **Step 4: Test dữ liệu mẫu và bất biến 4, 6**

`apps/api/test/sample-xyz.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { seedXyz } from '@kt/db/seed/dich-vu-xyz';   // thêm export "./seed/*" vào exports của @kt/db
import { createTestApp, type TestApp } from './helpers.js';

const expected = JSON.parse(readFileSync(new URL('../../../packages/db/src/seed/expected-bctc-xyz.json', import.meta.url), 'utf8'));
let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => {
  ctx = await createTestApp();
  ({ tenantId } = await seedXyz(process.env.DATABASE_ADMIN_URL!));
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'Matkhau1!' } });
  cookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
  await ctx.app.inject({ method: 'POST', url: '/api/auth/select-tenant', headers: { cookie }, payload: { tenantId } });
});
afterAll(async () => { await ctx.close(); });

describe('Bộ dữ liệu mẫu XYZ và bất biến 4', () => {
  it('số dư cuối kỳ từng tài khoản khớp tính tay', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: `/api/balances?asOf=${expected.asOf}`, headers: { cookie } });
    const by = Object.fromEntries((r.json().rows as { accountCode: string; debit: string; credit: string }[]).map((x) => [x.accountCode, (BigInt(x.debit) - BigInt(x.credit)).toString()]));
    const net = (code: string) => Object.entries(by).filter(([c]) => c.startsWith(code)).reduce((s, [, v]) => s + BigInt(v), 0n);
    for (const [code, v] of Object.entries(expected.soDuCuoiKy as Record<string, string>)) {
      const alt = code === '8211' ? '821' : code === '33311' ? '3331' : code;
      const actual = net(code) !== 0n || by[code] !== undefined ? net(code) : net(alt);
      const sign = ['4111', '4212', '33311', '3334', '331', '334'].includes(code) ? -1n : 1n;
      expect(actual.toString(), code).toBe((BigInt(v) * sign).toString());
    }
  });
  it('Bất biến 4: Tài sản = Nợ phải trả + Vốn chủ sở hữu tại mọi cuối tháng; tài khoản trung gian về 0 sau kết chuyển', async () => {
    for (let m = 1; m <= 12; m++) {
      const to = new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10);
      const r = await ctx.app.inject({ method: 'GET', url: `/api/reports/ledgers/trial-balance?from=2026-01-01&to=${to}&splitParty=false&level=1`, headers: { cookie } });
      const rows = r.json().rows as { accountCode: string; closing: { debit: string; credit: string } }[];
      const cls = (p: string) => rows.filter((x) => x.accountCode.startsWith(p)).reduce((s, x) => s + BigInt(x.closing.debit) - BigInt(x.closing.credit), 0n);
      const assets = cls('1') + cls('2'); const liab = -cls('3'); const equity = -cls('4'); const pnl = -(cls('5') + cls('6') + cls('7') + cls('8') + cls('9'));
      expect(assets, to).toBe(liab + equity + pnl);
    }
    const end = await ctx.app.inject({ method: 'GET', url: '/api/balances?asOf=2026-12-31', headers: { cookie } });
    const codes = (end.json().rows as { accountCode: string }[]).map((x) => x.accountCode);
    expect(codes.filter((c) => /^[5-9]/.test(c))).toEqual([]);
  });
  it('BCTC: tổng cộng tài sản = tổng cộng nguồn vốn và các chỉ tiêu then chốt khớp (khi đã có định nghĩa báo cáo)', async () => {
    const defs = (await ctx.app.inject({ method: 'GET', url: '/api/reports/financial', headers: { cookie } })).json() as { reportCode: string }[];
    if (!defs.some((d) => d.reportCode === 'B01')) { console.warn('CẢNH BÁO: chưa có định nghĩa B01, bỏ qua đối chiếu BCTC'); return; }
    const b01 = (await ctx.app.inject({ method: 'GET', url: '/api/reports/financial/B01?from=2026-01-01&to=2026-12-31', headers: { cookie } })).json();
    const find = (re: RegExp) => (b01.rows as { label: string; current: string }[]).find((x) => re.test(x.label));
    const ts = find(/tổng cộng tài sản/i); const nv = find(/tổng cộng nguồn vốn/i);
    if (ts && nv) { expect(ts.current).toBe(expected.tongTaiSan); expect(nv.current).toBe(expected.tongTaiSan); }
    const b02 = (await ctx.app.inject({ method: 'GET', url: '/api/reports/financial/B02?from=2026-01-01&to=2026-12-31', headers: { cookie } })).json();
    const lnst = (b02.rows as { label: string; current: string }[]).find((x) => /lợi nhuận sau thuế/i.test(x.label));
    if (lnst) expect(lnst.current).toBe(expected.kqkd.loiNhuanSauThue);
  });
});
```

`apps/api/test/invariants/inv4-can-doi-ke-toan.test.ts`: tái sử dụng `setupLedgerTenant` với chuỗi `arbBalancedLines` ngẫu nhiên 20 chứng từ, sau đó kiểm tra đẳng thức `assets = liab + equity + pnl` tại 4 ngày như trên (hàm chung `assertBalanceSheet(ctx, cookie, to)` đặt trong `invariants/helpers.ts`, dùng lại ở `sample-xyz.test.ts`), rồi `run-all` kết chuyển ngày 2026-12-31 và kiểm tra `911` cùng toàn bộ tài khoản `5–9` bằng 0 và `assets = liab + equity`.

`apps/api/test/invariants/inv6-khoa-cung.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { postVoucher, setupLedgerTenant } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string; let posted: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `I6${Date.now()}`));
  posted = (await postVoucher(ctx, cookie, '2026-01-10', [{ accountCode: '6422', debit: '100' }, { accountCode: '1111', credit: '100' }])).json().id;
  await ctx.app.inject({ method: 'POST', url: '/api/periods/2026/0/lock', headers: { cookie }, payload: { level: 'hard' } });
  await ctx.app.inject({ method: 'POST', url: '/api/periods/2026/1/lock', headers: { cookie }, payload: { level: 'hard' } });
});
afterAll(async () => { await ctx.close(); });

describe('Bất biến 6: kỳ khóa cứng từ chối mọi ghi', () => {
  const expectLocked = (r: { statusCode: number; json: () => { error: { code: string } } }) => { expect(r.statusCode).toBe(409); expect(['PERIOD_HARD_LOCKED', 'VOUCHER_HASHED', 'LINE_IMMUTABLE']).toContain(r.json().error.code); };
  it('qua API: tạo, ghi sổ, bỏ ghi sổ, đảo, hủy, sửa diễn giải', async () => {
    expectLocked(await postVoucher(ctx, cookie, '2026-01-20', [{ accountCode: '6422', debit: '1' }, { accountCode: '1111', credit: '1' }]));
    expectLocked(await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${posted}/unpost`, headers: { cookie } }));
    expectLocked(await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${posted}/reverse`, headers: { cookie }, payload: { postingDate: '2026-01-31' } }));
    expectLocked(await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${posted}/reverse`, headers: { cookie }, payload: { postingDate: '2026-02-01' } }));
    const v = (await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${posted}`, headers: { cookie } })).json();
    expectLocked(await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${posted}`, headers: { cookie }, payload: { version: v.version, description: 'sửa' } }));
    expectLocked(await ctx.app.inject({ method: 'POST', url: '/api/opening-balance/2026/post', headers: { cookie } }));
  });
  it('qua SQL với vai trò ứng dụng: insert/update/delete dòng và header đều bị từ chối', async () => {
    const asApp = (fn: (trx: Parameters<Parameters<typeof ctx.t.db.transaction>[0]>[0]) => Promise<unknown>) => ctx.t.db.transaction().execute(async (trx) => { await sql`SELECT set_config('app.current_tenant', ${tenantId}, true)`.execute(trx); return fn(trx as never); });
    await expect(asApp((trx) => sql`UPDATE voucher_line SET description = 'x' WHERE voucher_id = ${posted}::uuid`.execute(trx))).rejects.toThrow(/PERIOD_HARD_LOCKED|LINE_IMMUTABLE/);
    await expect(asApp((trx) => sql`DELETE FROM voucher_line WHERE voucher_id = ${posted}::uuid`.execute(trx))).rejects.toThrow(/LINE_IMMUTABLE/);
    await expect(asApp((trx) => sql`INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, amount_currency) SELECT tenant_id, voucher_id, 9, account_id, posting_date, 1, 0, 1 FROM voucher_line WHERE voucher_id = ${posted}::uuid LIMIT 1`.execute(trx))).rejects.toThrow(/LINE_IMMUTABLE/);
    await expect(asApp((trx) => sql`UPDATE voucher SET description = 'x' WHERE id = ${posted}::uuid`.execute(trx))).rejects.toThrow(/PERIOD_HARD_LOCKED/);
    await expect(asApp((trx) => sql`DELETE FROM voucher WHERE id = ${posted}::uuid`.execute(trx))).rejects.toThrow(/VOUCHER_DELETE_FORBIDDEN/);
  });
});
```

Run: `pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts` → PASS.

- [ ] **Step 5: CI, tài liệu, thẻ kết thúc giai đoạn 1**

`.github/workflows/ci.yml`: thêm job `invariants` (giống `test` nhưng chạy `pnpm -F @kt/api test -- test/invariants test/sample-xyz.test.ts`, `timeout-minutes: 30`); job `test` loại trừ thư mục `invariants` bằng `vitest.config.ts` của `@kt/api` với `exclude: ['test/invariants/**']` khi `process.env.INVARIANTS !== '1'`.

`docs/user/giai-doan-1-so-cai.md`: hướng dẫn ngắn: Phiếu kế toán (phím tắt), số dư đầu kỳ, ghi sổ/bỏ ghi sổ/đảo/hủy và khi nào dùng cái nào (bảng quyết định mục 7.1 bằng lời), khóa sổ ba mức, kết chuyển cuối kỳ, xem và in sổ/BCTC, soát lỗi, xuất dữ liệu; mỗi mục 3–6 dòng.

Kiểm tra toàn bộ: `docker compose build && docker compose up -d && docker compose exec api node packages/db/dist/seed/dich-vu-xyz.js`, mở web, xem BCĐPS năm 2026 của XYZ (tổng cộng ba cột cân), xem B01/B02 (nếu đã nhập mẫu), in bộ sổ năm.

```bash
git add -A
git commit -m "test(api): kiểm thử bất biến 1–4, 6 bằng fast-check và bộ dữ liệu mẫu doanh nghiệp dịch vụ XYZ"
git tag gd1-hoan-tat
```

---

## Tự rà soát (đã thực hiện khi viết kế hoạch)

**Độ phủ đặc tả và lộ trình GĐ0–GĐ1:**

| Yêu cầu | Tác vụ |
|---|---|
| Monorepo, Docker Compose, CI | 1 |
| Migration nền, RLS mọi bảng, vai trò DB ứng dụng | 2 (kiểm thử cấu trúc RLS chạy lại cho mọi bảng thêm sau) |
| Xác thực phiên Argon2, vai trò/quyền theo chức năng, cờ nhạy cảm, màn hình người dùng | 4a, 4b |
| Công ty, năm tài chính (≤ 15 tháng), chế độ theo năm, tùy chọn hệ thống | 5 |
| Mẫu HTTK TT99/TT133/TT200, thuộc tính, sinh HTTK công ty, tiểu khoản, đổi số hiệu/ghép | 6, 7 (chặn khi có dữ liệu: 14) |
| Danh mục khung + CRUD + lưới, nhập Excel, thêm nhanh tại ô, nhớ bộ lọc, định dạng VN | 8, 9, 10 |
| Nhật ký kiểm toán trước/sau, nhật ký đăng nhập | 2, 8, 11 |
| Sao lưu theo lịch, phục hồi | 12 |
| Dữ liệu mẫu ABC | 13 |
| `voucher`/`voucher_line` partition, counter, history, trigger cân bằng/bất biến/kiểm soát, `voucher_pair` | 14 |
| `post/unpost/reverse/discard`, máy trạng thái, bảng quyết định 7.1, quyền sửa sau ghi sổ, idempotency | 15 |
| Khóa kỳ ba mức, khóa phần hành, hash chuỗi, công cụ kiểm tra | 16 |
| Đánh số không lỗ hổng, cấu hình, đánh lại số, kiểm tra trùng | 17 |
| Màn hình Phiếu kế toán (nhiều dòng, chiều phân tích, đính kèm, nhân bản, in), Playwright | 18 |
| Số dư đầu kỳ kỳ 0 (VND/ngoại tệ, loại dư, công nợ theo đối tượng, kiểm tra, Excel) | 19 |
| Số dư theo kỳ, làm bẩn theo kỳ hiệu lực, worker, đọc số dư tại ngày | 20 |
| Sơ đồ kết chuyển/phân bổ, KC/PB, chạy lại bằng đảo, kết chuyển lợi nhuận đầu năm | 21 |
| S03a, S03b (3 dạng), S38, S06 (cộng cấp, tách dư hai bên), truy ngược | 22 |
| Engine công thức, B01/B02/B03 TT99 + TT133 là dữ liệu, so sánh năm trước, giữa niên độ, truy ngược chỉ tiêu, sửa/nạp lại | 23 |
| In HTML/PDF/Excel theo mẫu số, in liên tục bộ sổ | 24 |
| `data_check_rule` và 5 quy tắc đầu tiên (+1) | 25 |
| Xuất dữ liệu cho cơ quan thẩm quyền | 26 |
| Bất biến 1–4, 6; dữ liệu mẫu dịch vụ với BCTC kỳ vọng; tiêu chí nghiệm thu | 27 (hiệu năng 100.000 dòng: đo bằng seed nhân bản 12 tháng × 7 chứng từ × 120 lần trong kiểm tra tay trước khi gắn thẻ `gd1-hoan-tat`) |

**Điểm chưa phủ có chủ ý (ghi rõ, để GĐ2 hoặc chờ văn bản):** B09 thuyết minh (lộ trình GĐ1 nhắc "B09" trong bộ định nghĩa nhưng là báo cáo dạng văn bản, để GĐ2 cùng thuế); ngoại tệ trên Phiếu kế toán chỉ có cột dữ liệu (`currency_code`, `amount_currency`, `fx_rate`) và kiểm tra cân nguyên tệ, màn hình nhập ngoại tệ theo dòng và bảng tỷ giá tự điền để GĐ2 cùng chênh lệch tỷ giá; danh sách tài khoản TT99 và dòng B01/B02/B03 TT99/TT133 chờ văn bản gốc, có cổng `status.json` và kiểm thử đối chiếu với SUNSOFT.

**Nhất quán tên gọi đã kiểm tra chéo:** `withTenant`, `setupTestDb`, `createTestTenant`, `bootstrapTenant`, `app.withTenant`, `requirePermission`, `AppError(code, message, status, details?)`, `post_voucher/unpost_voucher/reverse_voucher/discard_voucher`, `fn_period_of(tenant, date, opening)`, `fn_assert_period_writable`, `mark_balance_stale(tenant, year, period)`, `recompute_balances(tenant)`, `fn_balances_at(tenant, date)`, `fn_build_pairs`, `lock_period/unlock_period/verify_period_hash`, `run_closing_step/rerun_closing_step`, `renderPdf`, `printShell`, `formNoFor`, `ReportDoc`, `evaluateReport/parseFormula/formulaRefs`, `QUEUES.recomputeBalances`, `loadCoaTemplate/loadReportTemplates/loadDefaultClosingSteps/tt99Status`.
