// Đo runCosting cả năm trên ~54.000 dòng hàng (59.000 phát sinh kho) cho từng phương pháp giá vốn: DB tạm riêng, dữ liệu sinh bằng chính API phiếu kho (mỗi phiếu 100 dòng, ghi sổ thật),
// mỗi phương pháp đo trong một giao dịch rồi hủy (cùng dữ liệu gốc), kèm lần chạy lại ngay (không đổi). Dùng: pnpm -F @kt/api perf:costing. Tiêu chí: dưới 30 giây mỗi phương pháp.
import '@kt/db/testing'; // nạp .env gốc repo
import { sql } from 'kysely';
import { createDb, createPool, withTenant } from '@kt/db';
import { createTempDb } from '@kt/db/temp-db';
import { createTestUser } from '@kt/db/testing';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/modules/auth/service.js';
import { runCosting } from '../src/modules/inventory/costingRun.js';

process.env.NODE_ENV = 'test'; // tắt nhật ký yêu cầu của Fastify như khi kiểm thử
const PASSWORD = 'Matkhau1!'; const ITEMS = 100; const WHS = 5; const LIMIT_S = 30;
const METHODS = ['avg_period', 'avg_moving', 'fifo', 'specific'] as const;
const p2 = (n: number) => String(n).padStart(2, '0');
const stop = new Error('rollback đo hiệu năng');

const adminUrl = process.env.DATABASE_ADMIN_URL!;
const tmp = await createTempDb(adminUrl, process.env.DATABASE_URL!);
const adminPool = createPool(tmp.adminUrl); const appPool = createPool(tmp.appUrl);
try {
  const admin = createDb(adminPool); const appDb = createDb(appPool);
  const app = await buildApp({ db: appDb, config: loadConfig({ ...process.env, SESSION_SECRET: 'perf-secret-123', LOGIN_MAX_FAILS_IP: '1000000' }) });
  await app.ready();
  try {
    const userId = await createTestUser(admin, { username: 'perf_admin', passwordHash: await hashPassword(PASSWORD) });
    const tenantId = (await sql<{ id: string }>`SELECT create_tenant('PERFK', 'Công ty đo giá vốn', NULL, ${userId}::uuid) AS id`.execute(admin)).rows[0]!.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'perf_admin', password: PASSWORD } });
    if (login.statusCode !== 200) throw new Error(`login thất bại: ${login.body}`);
    const headers = { cookie: `sid=${login.cookies.find((c) => c.name === 'sid')!.value}` };
    const call = async (method: 'GET' | 'POST', url: string, payload?: object) => {
      const r = await app.inject(payload ? { method, url, headers, payload } : { method, url, headers });
      if (r.statusCode >= 300) throw new Error(`${method} ${url} -> ${r.statusCode}: ${r.body.slice(0, 300)}`);
      return r;
    };
    await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
    await call('POST', '/api/catalogs/party', { code: 'NCC1', name: 'Nhà cung cấp một', is_vendor: true });
    const whCodes = Array.from({ length: WHS }, (_, i) => `K${i + 1}`); const itemCodes = Array.from({ length: ITEMS }, (_, i) => `H${String(i + 1).padStart(3, '0')}`);
    for (const k of whCodes) await call('POST', '/api/catalogs/warehouse', { code: k, name: `Kho ${k}`, costing_method: 'avg_period' });
    for (const c of itemCodes) await call('POST', '/api/catalogs/item', { code: c, name: `Hàng ${c}`, base_uom_code: 'CAI', kind: 'goods', tracking: 'none', inventory_account_code: '156' });

    // Mỗi tháng, mỗi kho: 4 phiếu nhập (ngày 2, 8, 14, 20), 4 phiếu xuất (5, 11, 17, 23), 1 phiếu chuyển sang kho kế (26); mỗi phiếu 100 dòng (mỗi hàng một dòng).
    // Giá nhập đổi theo tháng và hàng để giá vốn các phương pháp khác nhau; xuất lấy lô của tháng đó (đích danh).
    const t0 = performance.now(); let vouchers = 0;
    const stock = async (body: object) => {
      const r = await call('POST', '/api/stock-vouchers', { description: 'đo hiệu năng', ...body });
      await call('POST', `/api/vouchers/${r.json().id}/post`, {}); vouchers++;
    };
    for (let m = 1; m <= 12; m++) for (const [w, wh] of whCodes.entries()) {
      const lot = `L${p2(m)}`; const items = (f: (i: number) => object) => itemCodes.map((c, i) => ({ itemCode: c, uomCode: 'CAI', lotNo: lot, ...f(i) }));
      for (const d of [2, 8, 14, 20]) await stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: `2026-${p2(m)}-${p2(d)}`, warehouseCode: wh, partyCode: 'NCC1', items: items((i) => ({ quantity: String(40 + (i % 7) * 5), unitPrice: String(100 + (i % 13) * 7 + m * 3 + d + w)  })) });
      for (const d of [5, 11, 17, 23]) await stock({ voucherType: 'PXK', stockKind: 'sale', postingDate: `2026-${p2(m)}-${p2(d)}`, warehouseCode: wh, items: items((i) => ({ quantity: String(10 + (i % 5)) })) });
      await stock({ voucherType: 'CK', stockKind: 'transfer', postingDate: `2026-${p2(m)}-26`, warehouseCode: wh, destWarehouseCode: whCodes[(w + 1) % WHS]!, items: items((i) => ({ quantity: String(5 + (i % 3)) })) });
      if (m === 1 && w === WHS - 1 || w === WHS - 1 && m % 4 === 0) console.error(`  tháng ${m}: ${vouchers} phiếu (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
    }
    const genSec = (performance.now() - t0) / 1000;
    await adminPool.query('VACUUM ANALYZE');
    const cnt = (await adminPool.query('SELECT (SELECT count(*) FROM stock_move) AS moves, (SELECT count(*) FROM voucher_item_line) AS lines')).rows[0] as { moves: string; lines: string };

    const rows: [string, number, number, number, number][] = [];
    for (const method of (process.env.PERF_METHODS?.split(',') ?? METHODS) as typeof METHODS[number][]) {
      let first = 0; let again = 0; let n = 0; let gv = 0;
      await withTenant(appDb, { tenantId, userId }, async (trx) => {
        const ctx = { tenantId, userId, canBackdate: true };
        const input = { periodFrom: '2026-01-01', periodTo: '2026-12-31', method } as const;
        let s = performance.now(); const r = await runCosting(trx, ctx, input); first = (performance.now() - s) / 1000;
        n = r.summary.moves; gv = r.voucherIds.length;
        if (r.summary.errors.length) throw new Error(`${method}: lỗi giá vốn ${JSON.stringify(r.summary.errors.slice(0, 3))}`);
        await sql`ANALYZE`.execute(trx); // thống kê của kế hoạch truy vấn, như autovacuum sau khi đã ghi thật; thiếu thì lần chạy lại chọn kế hoạch tệ (~210 giây)
        s = performance.now(); const r2 = await runCosting(trx, ctx, input); again = (performance.now() - s) / 1000;
        if (!r2.unchanged) throw new Error(`${method}: chạy lại lần hai không "unchanged"`);
        throw stop;
      }).catch((e) => { if (e !== stop) throw e; });
      rows.push([method, first, again, n, gv]);
      await adminPool.query('VACUUM ANALYZE'); // dọn dòng chết của giao dịch đã hủy, như autovacuum; thiếu thì phương pháp sau chạy lại chậm (~210 giây) vì kế hoạch truy vấn lệch
    }
    console.log(`\nDòng hàng: ${cnt.lines}; phát sinh kho: ${cnt.moves}; phiếu: ${vouchers}; sinh + ghi sổ: ${genSec.toFixed(0)} s`);
    console.log('| Phương pháp | Lần đầu (s) | Chạy lại (s) | Phát sinh có giá gán | Chứng từ GV |\n|---|---|---|---|---|');
    for (const [m, a, b, k, g] of rows) console.log(`| ${m} | ${a.toFixed(1)} | ${b.toFixed(1)} | ${k} | ${g} |`);
    const slow = rows.filter((r) => r[1] >= LIMIT_S);
    if (slow.length) { console.error(`KHÔNG ĐẠT: ${slow.map((r) => r[0]).join(', ')} >= ${LIMIT_S} giây`); process.exitCode = 1; }
  } finally { await app.close(); }
} finally {
  await adminPool.end(); await appPool.end(); await tmp.drop();
}
