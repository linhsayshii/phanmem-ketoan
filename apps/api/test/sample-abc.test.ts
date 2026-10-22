import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { sql } from 'kysely';
import { seedAbcFull, seedAbcFullTx } from '../scripts/seed-abc.js';
import { createTestApp, type TestApp } from './helpers.js';
import { assertBalanceSheet, onlyPartyAccounts, openItemsByParty, sumFromLines } from './invariants/helpers.js';

// Kỳ vọng tính tay (trường calc ghi phép tính), không sinh từ mã đang kiểm.
const expected = JSON.parse(readFileSync(new URL('../../../packages/db/src/seed/expected-gd2-abc.json', import.meta.url), 'utf8'));
// Phần kho (GĐ3) cộng vào GĐ2: chênh lệch số dư, khấu trừ thuế quý 1 ghi đè, thêm chứng từ (GV chỉ kiểm ở test/inventory/sample-abc-kho.test.ts).
const kho = JSON.parse(readFileSync(new URL('../../../packages/db/src/seed/expected-gd3-abc.json', import.meta.url), 'utf8'));
for (const [code, d] of Object.entries(kho.chenhLechSoDuCuoiNam as Record<string, string>)) expected.soDuCuoiNam[code] = (BigInt(expected.soDuCuoiNam[code] ?? '0') + BigInt(d)).toString();
for (const asOf of ['2026-06-30', '2026-12-31']) { const more = { ...kho.congNoThem }; delete more.calc; Object.assign(expected.congNo[asOf], more); } // KH021, NCC011... chưa thu, chưa trả cả năm
expected.chungTuTuDong.KTT.find((v: { date: string }) => v.date === kho.ktt31Thang3.date).lines = kho.ktt31Thang3.lines;
for (const [t, n] of Object.entries(kho.soChungTuThem.counts as Record<string, number>)) expected.soChungTu.counts[t] = (expected.soChungTu.counts[t] ?? 0) + n;
const totalVouchers = (Object.values(expected.soChungTu.counts) as number[]).reduce((a, b) => a + b, 0) + kho.soChungTuThem.gv.total;
type AutoVoucher = { date: string; lines: [string, string, string, string][] };

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => {
  ctx = await createTestApp();
  ({ tenantId } = await seedAbcFull(process.env.DATABASE_ADMIN_URL!));
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'Matkhau1!' } });
  cookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
  await ctx.app.inject({ method: 'POST', url: '/api/auth/select-tenant', headers: { cookie }, payload: { tenantId } });
}, 300_000);
afterAll(async () => { await ctx.close(); });

const get = async (url: string) => { const r = await ctx.app.inject({ method: 'GET', url, headers: { cookie } }); expect(r.statusCode, r.body).toBe(200); return r.json(); };
const net = (x: { debit: string; credit: string }) => (BigInt(x.debit) - BigInt(x.credit)).toString();
const counts = async (id: string) => (await sql<{ k: string; n: number }>`
  SELECT 'voucher:' || voucher_type || ':' || state AS k, count(*)::int AS n FROM voucher WHERE tenant_id = ${id}::uuid GROUP BY 1
  UNION ALL SELECT 'open_item', count(*)::int FROM open_item WHERE tenant_id = ${id}::uuid UNION ALL SELECT 'settlement', count(*)::int FROM settlement WHERE tenant_id = ${id}::uuid
  UNION ALL SELECT 'tax_return', count(*)::int FROM tax_return WHERE tenant_id = ${id}::uuid UNION ALL SELECT 'fx_run', count(*)::int FROM fx_run WHERE tenant_id = ${id}::uuid
  UNION ALL SELECT 'party', count(*)::int FROM party WHERE tenant_id = ${id}::uuid ORDER BY 1`.execute(ctx.t.admin)).rows;

describe('Bộ dữ liệu mẫu ABC năm 2026 (GĐ2)', () => {
  it('tiêu chí nghiệm thu: tổng dư open_item = số dư 131/331 theo từng đối tượng tại MỌI ngày năm 2026', async () => {
    for (let d = new Date(Date.UTC(2026, 0, 1)); d.getUTCFullYear() === 2026; d.setUTCDate(d.getUTCDate() + 1)) {
      const asOf = d.toISOString().slice(0, 10);
      expect(await openItemsByParty(ctx, tenantId, asOf), asOf).toEqual(onlyPartyAccounts(await sumFromLines(ctx, tenantId, asOf)));
    }
  }, 600_000);

  it('số dư cuối năm từng tài khoản khớp expected-gd2-abc.json và không còn tài khoản nào khác có số dư', async () => {
    const by: Record<string, string> = {}; // một dòng mỗi (tài khoản, loại tiền): cộng các loại tiền về tài khoản
    for (const x of (await get(`/api/balances?asOf=${expected.asOf}`)).rows as { accountCode: string; debit: string; credit: string }[]) by[x.accountCode] = (BigInt(by[x.accountCode] ?? 0) + BigInt(net(x))).toString();
    for (const [code, v] of Object.entries(expected.soDuCuoiNam as Record<string, string>)) expect(by[code] ?? '0', code).toBe(v);
    expect(Object.keys(by).filter((k) => by[k] !== '0').sort()).toEqual(Object.keys(expected.soDuCuoiNam).filter((k) => expected.soDuCuoiNam[k] !== '0').sort());
    const usd = await sql<{ cur: string; vnd: string }>`SELECT sum(l.amount_currency)::text AS cur, sum(l.debit - l.credit)::text AS vnd FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted', 'reversed') AND a.code = '1122' AND l.currency_code = 'USD'`.execute(ctx.t.admin);
    expect({ usd: usd.rows[0]!.cur, vnd: usd.rows[0]!.vnd }).toEqual(expected.nguyenTe1122);
  });

  it('dư công nợ theo đối tượng ngày 30/06 và 31/12 (API số dư theo đối tượng)', async () => {
    for (const asOf of ['2026-06-30', '2026-12-31']) {
      const rows = (await get(`/api/balances?asOf=${asOf}&byParty=true`)).rows as { accountCode: string; partyCode: string | null; debit: string; credit: string }[];
      const m = new Map<string, bigint>();
      for (const r of rows.filter((x) => ['131', '331'].includes(x.accountCode))) m.set(`${r.accountCode}|${r.partyCode}`, (m.get(`${r.accountCode}|${r.partyCode}`) ?? 0n) + BigInt(net(r)));
      expect(Object.fromEntries([...m].filter(([, v]) => v !== 0n).map(([k, v]) => [k, v.toString()])), asOf).toEqual(expected.congNo[asOf]);
    }
  });

  it('tờ khai 01/GTGT quý 3/2026 khớp từng chỉ tiêu kỳ vọng; quý 4 nhận [22] từ quý 3; quý 1, 2 không lập (mẫu TT80 chưa có)', async () => {
    const r = await sql<{ period: number; revision: number; status: string; template_version: string; values: Record<string, string> }>`
      SELECT period, revision, status, template_version, values FROM tax_return WHERE tenant_id = ${tenantId}::uuid AND form_code = '01/GTGT' ORDER BY period, revision`.execute(ctx.t.admin);
    expect(r.rows.map((x) => [x.period, x.revision, x.status, x.template_version])).toEqual([[3, 0, 'final', 'TT89'], [4, 0, 'final', 'TT89']]);
    expect(r.rows[0]!.values).toEqual(expected.toKhaiQ3.values);
    expect(r.rows[1]!.values).toEqual(expected.toKhaiQ4.values);
    // Hai cách ra cùng số: [43] quý 3 = dư Nợ 1331 sau khấu trừ 30/09; [40] quý 4 = dư Có 33311 cuối năm.
    const b = await sumFromLines(ctx, tenantId, '2026-09-30');
    expect(b['1331||VND']).toBe(expected.toKhaiQ3.values['43']);
    expect(expected.soDuCuoiNam['33311']).toBe(`-${expected.toKhaiQ4.values['40']}`);
  });

  it('chứng từ tự động CL, XQ, DG, KTT, PB: ngày và từng dòng khớp tính tay; số chứng từ theo loại, tất cả đã ghi sổ', async () => {
    const rows = (await sql<{ type: string; date: string; id: string; code: string; party: string | null; debit: string; credit: string }>`
      SELECT v.voucher_type AS type, v.posting_date AS date, v.id, a.code, p.code AS party, l.debit::text AS debit, l.credit::text AS credit
      FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id AND l.posting_date = v.posting_date JOIN account a ON a.id = l.account_id LEFT JOIN party p ON p.id = l.party_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.voucher_type IN ('CL', 'XQ', 'DG', 'KTT', 'PB') AND v.state = 'posted' ORDER BY v.posting_date, v.seq_no, l.line_no`.execute(ctx.t.admin)).rows;
    for (const type of ['CL', 'XQ', 'DG', 'KTT', 'PB']) {
      const ids = [...new Set(rows.filter((r) => r.type === type).map((r) => r.id))];
      const got: AutoVoucher[] = ids.map((id) => ({ date: rows.find((r) => r.id === id)!.date,
        lines: rows.filter((r) => r.id === id).map((r) => [r.code, r.party ?? '', r.debit, r.credit] as [string, string, string, string]).sort() }));
      expect(got, type).toEqual((expected.chungTuTuDong[type] as AutoVoucher[]).map((v) => ({ date: v.date, lines: [...v.lines].sort() })));
    }
    const byType = await sql<{ t: string; s: string; n: number }>`SELECT voucher_type AS t, state AS s, count(*)::int AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid GROUP BY 1, 2 ORDER BY 1`.execute(ctx.t.admin);
    expect(byType.rows.every((x) => x.s === 'posted' || (x.t === 'GV' && x.s === 'reversed'))).toBe(true); // GV tháng 3 bị đảo khi chạy lại giá vốn
    expect(Object.fromEntries(byType.rows.filter((x) => x.t !== 'GV').map((x) => [x.t, x.n]))).toEqual(expected.soChungTu.counts);
  });

  it('Bất biến 4 vẫn đúng mọi cuối tháng; bảng cân đối số phát sinh cân', async () => {
    for (let m = 1; m <= 12; m++) await assertBalanceSheet(ctx, cookie, new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10));
    const { totals } = await get('/api/reports/ledgers/trial-balance?from=2026-01-01&to=2026-12-31') as { totals: Record<'opening' | 'period' | 'closing', { debit: string; credit: string }> };
    for (const k of ['opening', 'period', 'closing'] as const) expect(totals[k].debit, k).toBe(totals[k].credit);
    expect(totals.opening.debit).toBe('1523500000'); // 1.515.000.000 của GĐ2 + tồn kho đầu năm 8.500.000
  });

  it('seed chạy lần hai không tạo thêm; lỗi giữa chừng hoàn tác hết', async () => {
    const before = await counts(tenantId);
    expect(await seedAbcFull(process.env.DATABASE_ADMIN_URL!)).toEqual({ tenantId, created: false, extended: false });
    expect(await counts(tenantId)).toEqual(before);
    const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL! }); await c.connect();
    try {
      let inside = 0;
      await expect(seedAbcFullTx(c, { code: 'ABC_TEST_FAIL', afterYear: async () => {
        inside = (await c.query(`SELECT count(*)::int AS n FROM voucher v JOIN tenant t ON t.id = v.tenant_id WHERE t.code = 'ABC_TEST_FAIL'`)).rows[0].n;
        throw new Error('lỗi giả lập');
      } })).rejects.toThrow('lỗi giả lập');
      expect(inside).toBe(totalVouchers); // cả năm nghiệp vụ đã ghi trong giao dịch trước khi lỗi
      expect((await c.query(`SELECT count(*)::int AS n FROM tenant WHERE code = 'ABC_TEST_FAIL'`)).rows[0].n).toBe(0);
    } finally { await c.end(); }
  }, 300_000);

  it('quý 3/2026 có hóa đơn bán 8% (V8): lập tờ khai bổ sung nháp cảnh báo thuế suất 8%; xóa nháp thì còn đúng 2 tờ khai', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/tax/vat-returns', headers: { cookie }, payload: { year: 2026, periodKind: 'quarter', period: 3 } });
    expect(r.statusCode, r.body).toBe(201);
    const ret = r.json() as { id: number; revision: number; status: string; warnings: string[] };
    try {
      expect([ret.revision, ret.status]).toEqual([1, 'draft']);
      expect(ret.warnings.join('\n')).toMatch(/8%/);
      expect(ret.warnings.join('\n')).toMatch(/\[32\]/);
    } finally {
      const d = await ctx.app.inject({ method: 'DELETE', url: `/api/tax/vat-returns/${ret.id}`, headers: { cookie } });
      expect(d.statusCode, d.body).toBe(204);
    }
    expect((await counts(tenantId)).find((x) => x.k === 'tax_return')!.n).toBe(2);
  });
});
