// Đo lương và giá thành (GĐ6) trên DB tạm riêng, dữ liệu sinh bằng chính API: (1) 2.000 nhân viên, chấm công 22 ngày, tạo + tính + hạch toán bảng lương tháng 10/2026, chạy lại hạch toán (không đổi);
// (2) giá thành 200 đối tượng với 10.000 dòng chi phí (621, 622, 6272 gắn đối tượng, 6277 chung): thu thập, xem trước, chạy, chạy lại (không đổi).
// Dùng: pnpm -F @kt/api perf:payroll. Tiêu chí: mỗi bước tính, hạch toán, thu thập, chạy giá thành dưới 15 giây. Tham số lương là dữ liệu minh họa (payroll-20.json), không phải văn bản pháp lý.
import '@kt/db/testing'; // nạp .env gốc repo
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { createDb, createPool } from '@kt/db';
import { createTempDb } from '@kt/db/temp-db';
import { createTestUser } from '@kt/db/testing';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/modules/auth/service.js';

process.env.NODE_ENV = 'test'; // tắt nhật ký yêu cầu của Fastify như khi kiểm thử
const PASSWORD = 'Matkhau1!'; const EMPLOYEES = Number(process.env.PERF_EMPLOYEES ?? 2000); const OBJECTS = 200; const VOUCHERS = 500; const LINES_PER_VOUCHER = 20; const LIMIT_S = 15;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fx = JSON.parse(readFileSync(new URL('../test/fixtures/payroll-20.json', import.meta.url), 'utf8')) as Json;
const p2 = (n: number) => String(n).padStart(2, '0');
const secs = (t0: number) => (performance.now() - t0) / 1000;
const pool = async <T>(items: T[], size: number, f: (x: T, i: number) => Promise<unknown>) => { // chạy song song có giới hạn
  let next = 0; await Promise.all(Array.from({ length: size }, async () => { while (next < items.length) { const i = next++; await f(items[i]!, i); } }));
};

const tmp = await createTempDb(process.env.DATABASE_ADMIN_URL!, process.env.DATABASE_URL!);
const adminPool = createPool(tmp.adminUrl); const appPool = createPool(tmp.appUrl);
try {
  const admin = createDb(adminPool); const appDb = createDb(appPool);
  const app = await buildApp({ db: appDb, config: loadConfig({ ...process.env, SESSION_SECRET: 'perf-secret-123', LOGIN_MAX_FAILS_IP: '1000000' }) });
  await app.ready();
  try {
    const userId = await createTestUser(admin, { username: 'perf_admin', passwordHash: await hashPassword(PASSWORD) });
    await sql`SELECT create_tenant('PERFL', 'Công ty đo lương, giá thành', NULL, ${userId}::uuid)`.execute(admin);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'perf_admin', password: PASSWORD } });
    if (login.statusCode !== 200) throw new Error(`login thất bại: ${login.body}`);
    const headers = { cookie: `sid=${login.cookies.find((c) => c.name === 'sid')!.value}` };
    const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
      const r = await app.inject(payload ? { method, url, headers, payload } : { method, url, headers });
      if (r.statusCode >= 300) throw new Error(`${method} ${url} -> ${r.statusCode}: ${r.body.slice(0, 300)}`);
      return r.json() as Json;
    };
    await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' });
    const timings: [string, number, string][] = [];

    // ---------------------------------------------------------------- Lương
    let t0 = performance.now();
    await call('PUT', '/api/settings', { payroll_standard_hours_per_day: fx.settings.standardHoursPerDay, payroll_standard_days_per_month: fx.settings.standardDays });
    for (const [code, value] of Object.entries(fx.params)) await call('PUT', '/api/payroll/params', { code, validFrom: '2026-01-01', value, source: fx.source });
    const id = async (table: string, body: object) => Number((await call('POST', `/api/catalogs/${table}`, body)).id);
    const dept = { SX: await id('department', { code: 'SX', name: 'Sản xuất' }), BH: await id('department', { code: 'BH', name: 'Bán hàng' }), QL: await id('department', { code: 'QL', name: 'Quản lý' }) };
    await id('project', { code: 'P1', name: 'Vụ việc 1' });
    const nc = await id('cost_item', { code: 'NC', name: 'Nhân công' });
    const obj = Number((await call('POST', '/api/costing/objects', { code: 'OBJ1', name: 'Vụ việc P1', kind: 'project', projectCode: 'P1' })).id);
    await call('PUT', '/api/payroll/cost-accounts', { items: [{ departmentId: dept.SX, kind: 'payroll', role: 'direct', costItemId: nc, costObjectId: obj },
      { departmentId: dept.BH, kind: 'payroll', role: 'selling' }, { departmentId: dept.QL, kind: 'payroll', role: 'admin' }] });
    const emp: number[] = []; const depts = ['SX', 'BH', 'QL'] as const;
    await pool(Array.from({ length: EMPLOYEES }, (_, i) => i), 10, async (i) => {
      const e = Number((await call('POST', '/api/catalogs/employee', { code: `E${String(i + 1).padStart(5, '0')}`, name: `Nhân viên ${i + 1}`, department_code: depts[i % 3] })).id);
      await call('PUT', `/api/payroll/profiles/${e}`, { taxResidency: 'resident', contractType: 'long', region: 'I', siSalary: null, startDate: null, endDate: null, siParticipates: true, hiParticipates: true, uiParticipates: true, occupationalParticipates: true, defaultProjectId: null });
      await call('POST', `/api/payroll/profiles/${e}/salary-history`, { validFrom: '2026-01-01', monthlySalary: String((8 + (i % 40)) * 1_000_000) });
      emp[i] = e;
    });
    const workDays = Array.from({ length: 31 }, (_, d) => d + 1).filter((d) => [0, 6].indexOf(new Date(Date.UTC(2026, 9, d)).getUTCDay()) < 0);
    const cells = emp.flatMap((e) => workDays.map((d) => ({ employeeId: e, date: `2026-10-${p2(d)}`, entries: [{ kind: 'work_day', qty: '1' }] })));
    for (let i = 0; i < cells.length; i += 10_000) await call('PUT', '/api/attendance?year=2026&month=10', { cells: cells.slice(i, i + 10_000) });
    const setupPay = secs(t0);
    await adminPool.query('VACUUM ANALYZE');

    t0 = performance.now(); const run = await call('POST', '/api/payroll/runs', { year: 2026, month: 10 }); timings.push(['Tạo bảng lương', secs(t0), `${EMPLOYEES} nhân viên`]);
    t0 = performance.now(); await call('POST', `/api/payroll/runs/${run.id}/calculate`); timings.push(['Tính lương', secs(t0), '']);
    t0 = performance.now(); const posted = await call('POST', `/api/payroll/runs/${run.id}/post`); timings.push(['Hạch toán LU', secs(t0), `chứng từ ${posted.voucherNo}`]);
    t0 = performance.now(); const again = await call('POST', `/api/payroll/runs/${run.id}/repost`); timings.push(['Chạy lại hạch toán (không đổi)', secs(t0), again.unchanged ? 'unchanged' : 'KHÔNG unchanged']);
    if (!again.unchanged) throw new Error('repost lần hai không unchanged');

    // ---------------------------------------------------------------- Giá thành
    t0 = performance.now();
    await call('POST', '/api/catalogs/warehouse', { code: 'K2', name: 'Kho thành phẩm', inventory_account_code: '155', costing_method: 'avg_moving' });
    await call('POST', '/api/catalogs/cost_item', { code: 'KM-NVL', name: 'Nguyên vật liệu', cost_element: 'material' });
    await call('POST', '/api/catalogs/cost_item', { code: 'KM-NC2', name: 'Nhân công trực tiếp', cost_element: 'labor' });
    await call('POST', '/api/catalogs/cost_item', { code: 'KM-SXC', name: 'Sản xuất chung', cost_element: 'overhead' });
    const codes = Array.from({ length: OBJECTS }, (_, i) => `SP${String(i + 1).padStart(3, '0')}`);
    await pool(codes, 10, async (c) => {
      await call('POST', '/api/catalogs/item', { code: c, name: `Sản phẩm ${c}`, base_uom_code: 'CAI', kind: 'finished' });
      await call('POST', '/api/costing/objects', { code: c, name: `Sản phẩm ${c}`, kind: 'product', itemCode: c, method: 'simple' });
    });
    const rec = await call('POST', '/api/stock-vouchers', { description: 'Nhập thành phẩm', voucherType: 'PNK', stockKind: 'finished', postingDate: '2026-10-28', warehouseCode: 'K2', items: codes.map((c) => ({ itemCode: c, uomCode: 'CAI', quantity: '100', unitPrice: '1' })) });
    await call('POST', `/api/vouchers/${rec.id}/post`, {});
    // 500 phiếu x 20 dòng chi phí = 10.000 dòng: 621, 622, 6272 gắn đối tượng theo vòng; mỗi 10 dòng có 1 dòng 6277 chung (không đối tượng).
    const vouchers = Array.from({ length: VOUCHERS }, (_, v) => v);
    await pool(vouchers, 5, async (v) => {
      const lines: object[] = []; let total = 0;
      for (let k = 0; k < LINES_PER_VOUCHER; k++) {
        const n = v * LINES_PER_VOUCHER + k; const amount = 1000 + (n % 97) * 10; total += amount;
        const shared = n % 10 === 9; const account = shared ? '6277' : (['621', '622', '6272'] as const)[n % 3]!;
        const costItemCode = account === '621' ? 'KM-NVL' : account === '622' ? 'KM-NC2' : 'KM-SXC';
        lines.push({ accountCode: account, debit: String(amount), credit: '0', ...(shared ? {} : { costObjectCode: codes[n % OBJECTS], costItemCode }) });
      }
      lines.push({ accountCode: '111', debit: '0', credit: String(total) });
      const d = `2026-10-${p2(1 + (v % 27))}`;
      await call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: d, documentDate: d, description: 'Chi phí sản xuất đo hiệu năng', lines, autoPost: true });
    });
    const setupCost = secs(t0);
    await adminPool.query('VACUUM ANALYZE');
    const lineCount = Number((await adminPool.query(`SELECT count(*) AS n FROM voucher_line l JOIN account a ON a.id = l.account_id WHERE a.code IN ('621','622','6272','6277')`)).rows[0].n);

    const params = { overheadBasis: 'direct_labor' };
    t0 = performance.now(); const col = await call('GET', '/api/costing/collect?year=2026&month=10'); timings.push(['Thu thập chi phí', secs(t0), `${lineCount} dòng, ${(col.groups ?? col.objects ?? []).length} nhóm`]);
    t0 = performance.now(); await call('POST', '/api/costing/runs/preview', { year: 2026, month: 10, params }); timings.push(['Xem trước giá thành', secs(t0), `${OBJECTS} đối tượng`]);
    t0 = performance.now(); const cr = await call('POST', '/api/costing/runs', { year: 2026, month: 10, params }); timings.push(['Chạy giá thành (sinh GT)', secs(t0), `trạng thái ${cr.status ?? ''}`]);
    t0 = performance.now(); const cr2 = await call('POST', '/api/costing/runs', { year: 2026, month: 10, params }); timings.push(['Chạy lại giá thành (không đổi)', secs(t0), cr2.unchanged ? 'unchanged' : 'KHÔNG unchanged']);
    if (!cr2.unchanged) throw new Error('chạy lại giá thành lần hai không unchanged');

    console.log(`\nNhân viên: ${EMPLOYEES}; ô chấm công: ${cells.length}; sinh dữ liệu lương: ${setupPay.toFixed(0)} s. Đối tượng: ${OBJECTS}; dòng chi phí: ${lineCount}; phiếu: ${VOUCHERS}; sinh dữ liệu giá thành: ${setupCost.toFixed(0)} s`);
    console.log('| Bước | Thời gian (s) | Ghi chú |\n|---|---|---|');
    for (const [name, s, note] of timings) console.log(`| ${name} | ${s.toFixed(1)} | ${note} |`);
    const slow = timings.filter(([, s]) => s >= LIMIT_S);
    if (slow.length) { console.error(`KHÔNG ĐẠT: ${slow.map((r) => r[0]).join(', ')} >= ${LIMIT_S} giây`); process.exitCode = 1; }
  } finally { await app.close(); }
} finally {
  await adminPool.end(); await appPool.end(); await tmp.drop();
}
