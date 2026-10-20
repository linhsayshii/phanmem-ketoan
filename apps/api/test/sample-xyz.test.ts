import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { sql } from 'kysely';
import { withTenant } from '@kt/db';
import { D, evaluateReport, type ReportLineDef } from '@kt/domain';
import { seedXyz, seedXyzTx, XYZ_ACCOUNT_CANDIDATES } from '@kt/db/seed/dich-vu-xyz';
import { createTestApp, type TestApp } from './helpers.js';
import { assertBalanceSheet } from './invariants/helpers.js';
import { reportData, sqlResolver } from '../src/modules/reporting/financial.js';

const expected = JSON.parse(readFileSync(new URL('../../../packages/db/src/seed/expected-bctc-xyz.json', import.meta.url), 'utf8'));
const net = (rows: { accountCode: string; debit: string; credit: string }[]) => Object.fromEntries(rows.map((x) => [x.accountCode, BigInt(x.debit) - BigInt(x.credit)]));
// Khóa của expected là số dư theo bên tự nhiên của tài khoản; số dư ròng (Nợ − Có) của nhóm bên Có mang dấu âm.
const CREDIT_NATURE = new Set(['331', '334', '33311', '3334', '4111', '4212']);

let ctx: TestApp; let cookie: string; let tenantId: string; let regime: string; let leafCodes: Set<string>;
beforeAll(async () => {
  ctx = await createTestApp();
  ({ tenantId } = await seedXyz(process.env.DATABASE_ADMIN_URL!));
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'Matkhau1!' } });
  cookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
  await ctx.app.inject({ method: 'POST', url: '/api/auth/select-tenant', headers: { cookie }, payload: { tenantId } });
  regime = (await sql<{ regime: string }>`SELECT regime FROM fiscal_period WHERE tenant_id = ${tenantId}::uuid AND fiscal_year = 2026 AND period_no = 1`.execute(ctx.t.admin)).rows[0]!.regime;
  leafCodes = new Set((await sql<{ code: string }>`SELECT code FROM account WHERE tenant_id = ${tenantId}::uuid AND NOT is_group`.execute(ctx.t.admin)).rows.map((r) => r.code));
}, 120_000);
afterAll(async () => { await ctx.close(); });

// Tài khoản của khóa expected trong hệ đang dùng: cùng danh sách ứng viên mà seed dùng (vd. TT133 không có 6427 và 8211).
const resolve = (key: string) => (XYZ_ACCOUNT_CANDIDATES[key] ?? [key]).find((c) => leafCodes.has(c)) ?? key;
const balancesAt = async (asOf: string) => net((await ctx.app.inject({ method: 'GET', url: `/api/balances?asOf=${asOf}`, headers: { cookie } })).json().rows);

describe('Bộ dữ liệu mẫu XYZ', () => {
  it('seed chạy lần hai không tạo thêm; 86 phiếu kế toán, 1 số dư đầu kỳ, 3 kết chuyển, tất cả đã ghi sổ', async () => {
    const again = await seedXyz(process.env.DATABASE_ADMIN_URL!);
    expect(again).toEqual({ tenantId, created: false });
    const r = await sql<{ voucher_type: string; state: string; n: number }>`SELECT voucher_type, state, count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid GROUP BY 1, 2 ORDER BY 1, 2`.execute(ctx.t.admin);
    expect(r.rows).toEqual([{ voucher_type: 'DK', state: 'posted', n: 1 }, { voucher_type: 'KC', state: 'posted', n: 3 }, { voucher_type: 'PKT', state: 'posted', n: 86 }]);
    const dk = await sql<{ source_doc_type: string; ok: boolean }>`SELECT source_doc_type, source_doc_id = md5(tenant_id::text || ':opening:' || fiscal_year)::uuid AS ok FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'DK'`.execute(ctx.t.admin);
    expect(dk.rows).toEqual([{ source_doc_type: 'opening_balance', ok: true }]);
  });

  it('lỗi giữa chừng khi dựng công ty thì hoàn tác tất cả, không để lại công ty', async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL! }); await c.connect();
    try {
      let inside = 0;
      await expect(seedXyzTx(c, { code: 'XYZ_TEST_FAIL', afterTenant: async () => { inside = (await c.query(`SELECT count(*)::int AS n FROM tenant WHERE code = 'XYZ_TEST_FAIL'`)).rows[0].n; throw new Error('lỗi giả lập'); } })).rejects.toThrow('lỗi giả lập');
      expect(inside).toBe(1);
      expect((await c.query(`SELECT count(*)::int AS n FROM tenant WHERE code = 'XYZ_TEST_FAIL'`)).rows[0].n).toBe(0);
    } finally { await c.end(); }
  });

  it('số dư cuối kỳ từng tài khoản khớp tính tay và không còn tài khoản nào khác có số dư', async () => {
    const by = await balancesAt(expected.asOf);
    const keys = Object.entries(expected.soDuCuoiKy as Record<string, string>);
    for (const [key, v] of keys) expect(by[resolve(key)] ?? 0n, `${key} -> ${resolve(key)}`).toBe(BigInt(v) * (CREDIT_NATURE.has(key) ? -1n : 1n));
    const wanted = new Set(keys.filter(([, v]) => v !== '0').map(([k]) => resolve(k)));
    expect(Object.keys(by).sort()).toEqual([...wanted].sort());
  });

  it('Bảng cân đối số phát sinh năm 2026: ba cặp cột Nợ/Có cân', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/reports/ledgers/trial-balance?from=2026-01-01&to=2026-12-31', headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    const { totals } = r.json() as { totals: Record<'opening' | 'period' | 'closing', { debit: string; credit: string }> };
    for (const k of ['opening', 'period', 'closing'] as const) expect(totals[k].debit, k).toBe(totals[k].credit);
    expect(totals.period.debit).not.toBe('0');
  });
});

describe('Bất biến 4 trên bộ dữ liệu mẫu', () => {
  it('Tài sản = Nợ phải trả + Vốn chủ sở hữu tại mọi cuối tháng; tài khoản trung gian về 0 sau kết chuyển', async () => {
    for (let m = 1; m <= 12; m++) await assertBalanceSheet(ctx, cookie, new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10));
    const end = await balancesAt('2026-12-31');
    expect(Object.keys(end).filter((c) => c === '911' || /^[5-9]/.test(c))).toEqual([]);
    const { assets, liab, equity, pnl } = await assertBalanceSheet(ctx, cookie, '2026-12-31');
    expect([assets, liab, equity, pnl]).toEqual([BigInt(expected.tongTaiSan), BigInt(expected.noPhaiTra), BigInt(expected.vonChuSoHuu), 0n]);
  });
});

// Bộ BCTC TT99/TT133 còn chờ văn bản gốc nên công ty mẫu không có định nghĩa B01–B03 và không được nạp chỉ tiêu tự bịa: các tổng hợp dưới đây
// dùng định nghĩa cục bộ của kiểm thử, tính trong bộ nhớ bằng đúng engine công thức và bộ giải SQL của API, không ghi vào report_def.
const L = (lineCode: string, formula: string, source: ReportLineDef['source'], side: ReportLineDef['side']): ReportLineDef => ({ lineCode, formula, source, side });
const B01: ReportLineDef[] = [L('TS', '1 + 2', 'balance', 'net_debit'), L('NPT', '3', 'balance', 'net_credit'), L('VCSH', '4', 'balance', 'net_credit'), L('NV', '[NPT] + [VCSH]', 'lines', 'net_credit')];
const B02: ReportLineDef[] = [L('DT', '511', 'movement', 'net_credit'), L('CPQL', '642', 'movement', 'net_debit'), L('LNTT', '[DT] - [CPQL]', 'lines', 'net_debit'),
  L('THUE', '821', 'movement', 'net_debit'), L('LNST', '[LNTT] - [THUE]', 'lines', 'net_debit')];
const B03: ReportLineDef[] = [L('THU', 'N111,112/C131', 'pair', 'net_debit'), L('NCC', 'N331/C111,112', 'pair', 'net_debit'), L('NLD', 'N334/C111,112', 'pair', 'net_debit'),
  L('KHAC', 'N642,133/C111,112', 'pair', 'net_debit'), L('LCTT', '[THU] - [NCC] - [NLD] - [KHAC]', 'lines', 'net_debit')];

describe('BCTC kỳ vọng của XYZ (định nghĩa cục bộ, tính trong bộ nhớ)', () => {
  const run = (defs: ReportLineDef[], from: string, to: string) => withTenant(ctx.t.db, { tenantId }, async (trx) => {
    const v = await evaluateReport(defs, sqlResolver(reportData(trx, tenantId, regime, { from, to })));
    return Object.fromEntries([...v].map(([k, x]) => [k, x.toString()]));
  });

  it('B01: tổng tài sản = tổng nguồn vốn; nợ phải trả và vốn chủ sở hữu khớp', async () => {
    const b = await run(B01, '2026-01-01', '2026-12-31');
    expect(b).toEqual({ TS: expected.tongTaiSan, NPT: expected.noPhaiTra, VCSH: expected.vonChuSoHuu, NV: expected.tongTaiSan });
  });
  it('B02: doanh thu, chi phí, lợi nhuận trước thuế, thuế TNDN, lợi nhuận sau thuế khớp (không tính chứng từ kết chuyển)', async () => {
    const b = await run(B02, '2026-01-01', '2026-12-31'); const k = expected.kqkd;
    expect(b).toEqual({ DT: k.doanhThuThuan, CPQL: k.chiPhiQuanLy, LNTT: k.loiNhuanTruocThue, THUE: k.chiPhiThueTNDN, LNST: k.loiNhuanSauThue });
    // lợi nhuận sau thuế trên báo cáo = số dư 4212 sau kết chuyển
    expect(b['LNST']).toBe(expected.soDuCuoiKy['4212']);
  });
  it('B03 trực tiếp: các khoản thu chi bằng tiền khớp và lưu chuyển thuần = thay đổi số dư tiền', async () => {
    const b = await run(B03, '2026-01-01', '2026-12-31'); const k = expected.lctt;
    expect(b).toEqual({ THU: k.thuTuKhachHang, NCC: k.chiChoNhaCungCap, NLD: k.chiChoNguoiLaoDong, KHAC: k.chiKhac, LCTT: k.luuChuyenThuan });
    const cashEnd = D(expected.soDuCuoiKy['1111']).plus(expected.soDuCuoiKy['1121']);
    expect(D(b['LCTT']!).toString()).toBe(cashEnd.minus('1000000000').toString()); // tiền cuối kỳ − tiền đầu kỳ (200 + 800 triệu)
  });
  it('công ty mẫu không có định nghĩa báo cáo nào được lưu', async () => {
    const r = await sql<{ n: number }>`SELECT count(*) AS n FROM report_def WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin);
    expect(r.rows[0]!.n).toBe(0);
    const api = await ctx.app.inject({ method: 'GET', url: '/api/reports/financial?year=2026', headers: { cookie } });
    expect(api.json()).toEqual([]);
  });
});
