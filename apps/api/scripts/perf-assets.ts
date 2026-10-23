// Đo chạy kỳ khấu hao / phân bổ trên 5.000 thẻ (3.000 TSCĐ + 1.500 CCDC + 500 chi phí trả trước, mỗi thẻ 2 dòng phân bổ): DB tạm riêng, dữ liệu sinh bằng API thật
// (thẻ, phân bổ, phiếu kế toán 100 thẻ mỗi phiếu), chạy lần lượt 12 kỳ cho cả ba loại rồi chạy lại từng kỳ (không đổi).
// Dùng: pnpm -F @kt/api perf:assets. Tiêu chí: mỗi lần chạy kỳ dưới 15 giây, chạy lại không đổi dưới 10 giây.
import '@kt/db/testing'; // nạp .env gốc repo
import { sql } from 'kysely';
import { createDb, createPool } from '@kt/db';
import { createTempDb } from '@kt/db/temp-db';
import { createTestUser } from '@kt/db/testing';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/modules/auth/service.js';

process.env.NODE_ENV = 'test'; // tắt nhật ký yêu cầu của Fastify như khi kiểm thử
const PASSWORD = 'Matkhau1!'; const FIXED = Number(process.env.PERF_FIXED ?? 3000); const TOOLS = Number(process.env.PERF_TOOLS ?? 1500); const PREPAID = Number(process.env.PERF_PREPAID ?? 500);
const LIMIT_RUN_S = 15; const LIMIT_AGAIN_S = 10; const PER_VOUCHER = 100;
const KINDS = [{ kind: 'depreciation', label: 'Khấu hao TSCĐ' }, { kind: 'tool', label: 'Phân bổ CCDC' }, { kind: 'prepaid', label: 'Phân bổ trả trước' }] as const;

const adminUrl = process.env.DATABASE_ADMIN_URL!;
const tmp = await createTempDb(adminUrl, process.env.DATABASE_URL!);
const adminPool = createPool(tmp.adminUrl); const appPool = createPool(tmp.appUrl);
try {
  const admin = createDb(adminPool); const appDb = createDb(appPool);
  const app = await buildApp({ db: appDb, config: loadConfig({ ...process.env, SESSION_SECRET: 'perf-secret-123', LOGIN_MAX_FAILS_IP: '1000000' }) });
  await app.ready();
  try {
    const userId = await createTestUser(admin, { username: 'perf_admin', passwordHash: await hashPassword(PASSWORD) });
    await sql`SELECT create_tenant('PERFA', 'Công ty đo khấu hao', NULL, ${userId}::uuid) AS id`.execute(admin);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'perf_admin', password: PASSWORD } });
    if (login.statusCode !== 200) throw new Error(`login thất bại: ${login.body}`);
    const headers = { cookie: `sid=${login.cookies.find((c) => c.name === 'sid')!.value}` };
    const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
      const r = await app.inject(payload ? { method, url, headers, payload } : { method, url, headers });
      if (r.statusCode >= 300) throw new Error(`${method} ${url} -> ${r.statusCode}: ${r.body.slice(0, 300)}`);
      return r;
    };
    await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
    await call('POST', '/api/catalogs/party', { code: 'NCC1', name: 'Nhà cung cấp một', is_vendor: true });

    const t0 = performance.now();
    const cards = [...Array.from({ length: FIXED }, (_, i) => ({ kind: 'fixed' as const, code: `TS${String(i + 1).padStart(5, '0')}`, life: 36 + (i % 5) * 12, cost: 12_000_000 + i * 1_037 })),
      ...Array.from({ length: TOOLS }, (_, i) => ({ kind: 'tool' as const, code: `CC${String(i + 1).padStart(5, '0')}`, life: 6 + (i % 4) * 6, cost: 1_500_000 + i * 311 })),
      ...Array.from({ length: PREPAID }, (_, i) => ({ kind: 'prepaid' as const, code: `TT${String(i + 1).padStart(5, '0')}`, life: 12, cost: 6_000_000 + i * 997 }))];
    const lines = { fixed: '2111', tool: '242', prepaid: '242' } as const;
    for (const [n, c] of cards.entries()) {
      const r = await call('POST', '/api/assets', { code: c.code, name: c.code, kind: c.kind, assetAccountCode: lines[c.kind], ...(c.kind === 'fixed' ? { depreciationAccountCode: '2141' } : {}),
        depreciationStartDate: `2026-01-${String(1 + (n % 20)).padStart(2, '0')}`, lifeUnits: c.life });
      await call('PUT', `/api/assets/${r.json().id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', ratio: '70' }, { expenseAccountCode: '6421', ratio: '30' }] });
    }
    for (let i = 0; i < cards.length; i += PER_VOUCHER) {
      const part = cards.slice(i, i + PER_VOUCHER); const total = part.reduce((s, c) => s + c.cost, 0);
      await call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-01-01', documentDate: '2026-01-01', description: 'mua tài sản đo hiệu năng', autoPost: true, lines: [
        ...part.map((c) => ({ accountCode: lines[c.kind], debit: String(c.cost), credit: '0', assetCode: c.code })), { accountCode: '331', debit: '0', credit: String(total), partyCode: 'NCC1' }] });
    }
    const genSec = (performance.now() - t0) / 1000;
    await adminPool.query('VACUUM ANALYZE');

    const rows: { label: string; max: number; avg: number; againMax: number; amountLines: number }[] = [];
    for (const { kind, label } of KINDS) {
      const first: number[] = []; const again: number[] = []; let amountLines = 0;
      for (let p = 1; p <= 12; p++) {
        let s = performance.now(); const r = await call('POST', '/api/asset-runs', { kind, fiscalYear: 2026, periodNo: p }); first.push((performance.now() - s) / 1000);
        amountLines += r.json().lines.length;
        await adminPool.query('ANALYZE');
        s = performance.now(); const r2 = await call('POST', '/api/asset-runs', { kind, fiscalYear: 2026, periodNo: p }); again.push((performance.now() - s) / 1000);
        if (!r2.json().unchanged) throw new Error(`${kind} kỳ ${p}: chạy lại lần hai không "unchanged"`);
      }
      rows.push({ label, max: Math.max(...first), avg: first.reduce((a, b) => a + b, 0) / 12, againMax: Math.max(...again), amountLines });
    }
    console.log(`\nThẻ: ${cards.length} (TSCĐ ${FIXED}, CCDC ${TOOLS}, trả trước ${PREPAID}); sinh thẻ + phân bổ + ghi sổ: ${genSec.toFixed(0)} s`);
    console.log('| Loại | Chạy kỳ lớn nhất (s) | Chạy kỳ trung bình (s) | Chạy lại lớn nhất (s) | Dòng phát sinh (12 kỳ) |\n|---|---|---|---|---|');
    for (const r of rows) console.log(`| ${r.label} | ${r.max.toFixed(1)} | ${r.avg.toFixed(1)} | ${r.againMax.toFixed(1)} | ${r.amountLines} |`);
    const slow = rows.filter((r) => r.max >= LIMIT_RUN_S || r.againMax >= LIMIT_AGAIN_S);
    if (slow.length) { console.error(`KHÔNG ĐẠT: ${slow.map((r) => r.label).join(', ')} (chạy kỳ >= ${LIMIT_RUN_S} giây hoặc chạy lại >= ${LIMIT_AGAIN_S} giây)`); process.exitCode = 1; }
  } finally { await app.close(); }
} finally {
  await adminPool.end(); await appPool.end(); await tmp.drop();
}
