// Đo hiệu năng báo cáo trên ~100.000 dòng sổ cái: DB tạm riêng, chứng từ sinh bằng SQL theo lô rồi ghi sổ qua post_voucher thật. Dùng: pnpm -F @kt/api perf:100k
import '@kt/db/testing'; // nạp .env gốc repo
import { sql } from 'kysely';
import { createDb, createPool } from '@kt/db';
import { createTempDb } from '@kt/db/temp-db';
import { createTestUser } from '@kt/db/testing';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/modules/auth/service.js';

process.env.NODE_ENV = 'test'; // tắt nhật ký yêu cầu của Fastify như khi kiểm thử
const VOUCHERS = Number(process.env.PERF_VOUCHERS ?? 25_000); // × 4 dòng
const CHUNK = 1_000;
const PASSWORD = 'Matkhau1!';
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const adminUrl = process.env.DATABASE_ADMIN_URL!;
const tmp = await createTempDb(adminUrl, process.env.DATABASE_URL!);
const adminPool = createPool(tmp.adminUrl);
const appPool = createPool(tmp.appUrl);
try {
  const admin = createDb(adminPool);
  const app = await buildApp({ db: createDb(appPool), config: loadConfig({ ...process.env, SESSION_SECRET: 'perf-secret-123', LOGIN_MAX_FAILS_IP: '1000000' }) });
  await app.ready();
  try {
    const username = 'perf_admin';
    const userId = await createTestUser(admin, { username, passwordHash: await hashPassword(PASSWORD) });
    const tenantId = (await sql<{ id: string }>`SELECT create_tenant('PERF', 'Công ty đo hiệu năng', NULL, ${userId}::uuid) AS id`.execute(admin)).rows[0]!.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
    if (login.statusCode !== 200) throw new Error(`login thất bại: ${login.body}`);
    const headers = { cookie: `sid=${login.cookies.find((c) => c.name === 'sid')!.value}` };
    const call = async (method: 'GET' | 'POST', url: string, payload?: object) => {
      const r = await app.inject(payload ? { method, url, headers, payload } : { method, url, headers });
      if (r.statusCode >= 300) throw new Error(`${method} ${url} -> ${r.statusCode}: ${r.body.slice(0, 300)}`);
      return r;
    };
    await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
    for (let i = 0; i < 20; i++) await call('POST', '/api/catalogs/party', { code: `DT${String(i).padStart(3, '0')}`, name: `Đối tượng ${i}`, is_customer: true, is_vendor: true });

    // 30 tài khoản lá: 131, 331, 1121 và 27 tài khoản không đòi vật tư/tài sản. Thứ tự theo mã để tái lập.
    const acc = (await sql<{ id: string; code: string; subledger_kind: string | null }>`SELECT id::text, code, subledger_kind FROM account WHERE tenant_id = ${tenantId}::uuid AND regime = 'TT133' AND NOT is_group AND is_active
      AND (code IN ('131','331','1121') OR coalesce(subledger_kind, '') NOT IN ('inventory','fixed_asset','receivable','payable')) ORDER BY (code IN ('131','331','1121')) DESC, code LIMIT 30`.execute(admin)).rows;
    if (acc.length < 30 || !['131', '331', '1121'].every((c) => acc.some((a) => a.code === c))) throw new Error('Thiếu tài khoản lá để sinh dữ liệu');
    const parties = (await sql<{ id: string }>`SELECT id FROM party WHERE tenant_id = ${tenantId}::uuid ORDER BY code`.execute(admin)).rows.map((r) => r.id);

    // Sinh theo lô: mỗi lô một giao dịch với tư cách app_user (RLS, trigger thật), chứng từ nháp -> dòng qua bảng gốc -> post_voucher.
    const t0 = performance.now();
    const c = await appPool.connect();
    try {
      for (let lo = 0; lo < VOUCHERS; lo += CHUNK) {
        const hi = Math.min(lo + CHUNK, VOUCHERS);
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.current_tenant', $1::text, true), set_config('app.current_user', $2::text, true)", [tenantId, userId]);
        await c.query(`INSERT INTO voucher(tenant_id, voucher_type, posting_date, document_date, description, created_by, idempotency_key)
          SELECT $1, 'PKT', DATE '2026-01-01' + (n % 360), DATE '2026-01-01' + (n % 360), 'perf ' || n, $2, 'perf-' || n FROM generate_series($3::int, $4::int - 1) n`, [tenantId, userId, lo, hi]);
        // 2 bút toán (4 dòng) mỗi chứng từ: Nợ a / Có b và Nợ c / Có d, tài khoản chọn theo n; 131/331 gắn đối tượng.
        await c.query(`INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, party_id)
          SELECT $1, v.id, k + 1, ac.id, v.posting_date, CASE WHEN k % 2 = 0 THEN amt ELSE 0 END, CASE WHEN k % 2 = 1 THEN amt ELSE 0 END, CASE WHEN ac.needs_party THEN ($7::uuid[])[1 + n % 20] END
          FROM voucher v CROSS JOIN LATERAL (SELECT substring(v.idempotency_key FROM 6)::int AS n) q CROSS JOIN generate_series(0, 3) k
          CROSS JOIN LATERAL (SELECT (1000 + (n * 37 + (k / 2) * 11) % 90000) * 1000 AS amt) m
          JOIN (SELECT (o - 1)::int AS i, id, needs_party FROM unnest($5::bigint[], $6::boolean[]) WITH ORDINALITY AS u(id, needs_party, o)) ac
            ON ac.i = (n * 7 + k * 5 + (k / 2) * (n % 5 + 1)) % 30
          WHERE v.tenant_id = $1 AND $2::text IS NOT NULL AND v.idempotency_key LIKE 'perf-%' AND v.state = 'draft' AND substring(v.idempotency_key FROM 6)::int BETWEEN $3 AND $4 - 1`,
          [tenantId, userId, lo, hi, acc.map((a) => a.id), acc.map((a) => a.subledger_kind === 'receivable' || a.subledger_kind === 'payable'), parties]);
        await c.query(`SELECT post_voucher(id) FROM voucher WHERE tenant_id = $1 AND state = 'draft' AND idempotency_key LIKE 'perf-%'`, [tenantId]);
        await c.query('COMMIT');
        if ((hi / CHUNK) % 5 === 0) console.error(`  ${hi}/${VOUCHERS} chứng từ (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
      }
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    const genSec = (performance.now() - t0) / 1000;

    const tr = performance.now();
    await call('POST', '/api/balances/recompute');
    const recomputeSec = (performance.now() - tr) / 1000;
    await adminPool.query('VACUUM ANALYZE');
    const lines = Number((await adminPool.query('SELECT count(*) AS n FROM voucher_line')).rows[0].n);

    const cases: [string, string][] = [
      ['Bảng cân đối số phát sinh năm', '/api/reports/ledgers/trial-balance?from=2026-01-01&to=2026-12-31&format=json'],
      ['Nhật ký chung năm (cắt 50.000 dòng)', '/api/reports/ledgers/general-journal?from=2026-01-01&to=2026-12-31&format=json'],
      ['Sổ Cái TK 1121 năm', '/api/reports/ledgers/account?from=2026-01-01&to=2026-12-31&accountCode=1121&format=json'],
      ['Số dư tài khoản /api/balances', '/api/balances?asOf=2026-12-31'],
    ];
    const rows: [string, number, number][] = [];
    for (const [name, url] of cases) {
      await call('GET', url); // chạy khởi động, không tính
      const ms: number[] = [];
      for (let i = 0; i < 3; i++) { const s = performance.now(); await call('GET', url); ms.push(performance.now() - s); }
      rows.push([name, Math.round(median(ms)), Math.round(Math.max(...ms))]);
    }
    console.log(`\nDòng sổ cái: ${lines}; chứng từ: ${VOUCHERS}; sinh + ghi sổ: ${genSec.toFixed(0)} s; tính lại số dư: ${recomputeSec.toFixed(1)} s`);
    console.log('| Báo cáo | Trung vị (ms) | Lớn nhất (ms) |\n|---|---|---|');
    for (const [n, m, x] of rows) console.log(`| ${n} | ${m} | ${x} |`);
    if (rows[0]![1] >= 2000) { console.error('KHÔNG ĐẠT: Bảng cân đối số phát sinh năm >= 2 giây'); process.exitCode = 1; }
  } finally { await app.close(); }
} finally {
  await adminPool.end(); await appPool.end(); await tmp.drop();
}
