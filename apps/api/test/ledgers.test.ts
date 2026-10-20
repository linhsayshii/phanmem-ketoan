import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 }); // máy chủ DB có lúc bận: mỗi kiểm thử gọi nhiều API
let ctx: TestApp; let cookie: string;
const pkt = (date: string, lines: object[], c = cookie) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie: c }, payload: { voucherType: 'PKT', postingDate: date, documentDate: date, description: `CT ${date}`, autoPost: true, lines } });
const get = (url: string, c = cookie) => ctx.app.inject({ method: 'GET', url, headers: { cookie: c } });
const ok = async (p: ReturnType<typeof pkt>) => { const r = await p; expect(r.statusCode, r.body).toBe(201); return r; };
type Side = { debit: string; credit: string };
type TRow = { accountCode: string; isGroup: boolean; opening: Side; period: Side; closing: Side };

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
}, 60_000);
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
    // sổ chi tiết cũng bị chặn; giá vốn (632...) cần cờ view_cost
    expect((await get('/api/reports/ledgers/detail?accountCode=131&from=2026-01-01&to=2026-01-31', c2)).statusCode).toBe(403);
    expect((await get('/api/reports/ledgers/account?accountCode=632&from=2026-01-01&to=2026-01-31', c2)).statusCode).toBe(403);
  });
  it('đầu vào sai bị từ chối: ngày đảo ngược, ngày không có thật, tài khoản không tồn tại', async () => {
    expect((await get('/api/reports/ledgers/general-journal?from=2026-02-01&to=2026-01-01')).statusCode).toBe(400);
    expect((await get('/api/reports/ledgers/general-journal?from=2026-13-45&to=2026-14-01')).statusCode).toBe(400);
    const r = await get('/api/reports/ledgers/account?accountCode=9999&from=2026-01-01&to=2026-01-31');
    expect([r.statusCode, r.json().error.code]).toEqual([404, 'ACCOUNT_NOT_FOUND']);
    const p = await get('/api/reports/ledgers/detail?accountCode=131&from=2026-01-01&to=2026-01-31&partyCode=KHONGCO');
    expect([p.statusCode, p.json().error.code]).toEqual([404, 'LOOKUP_NOT_FOUND']);
  });
});

describe('sổ sách: đối ứng nội bộ, chiều phân tích, hai hệ tài khoản', () => {
  let c: string; let tenantId: string;
  const tb = async (from: string, to: string, qs = '') => { const r = await get(`/api/reports/ledgers/trial-balance?from=${from}&to=${to}${qs}`, c); expect(r.statusCode, r.body).toBe(200); return r.json() as { rows: TRow[]; totals: { opening: Side; period: Side; closing: Side } }; };
  const detail = async (qs: string) => { const r = await get(`/api/reports/ledgers/detail?${qs}`, c); expect(r.statusCode, r.body).toBe(200); return r.json() as { opening: Side; rows: { debit: string; credit: string; costItemCode: string | null; counterAccountCode: string }[]; closing: Side }; };

  beforeAll(async () => {
    ({ cookie: c, tenantId } = await bootstrapTenant(ctx, { code: `LX${Date.now()}` }));
    for (const [fiscalYear, regime] of [[2026, 'TT133'], [2027, 'TT200']] as const) {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: c }, payload: { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime } });
      expect(r.statusCode, r.body).toBe(201);
    }
    for (const code of ['CPA', 'CPB']) expect((await ctx.app.inject({ method: 'POST', url: '/api/catalogs/cost_item', headers: { cookie: c }, payload: { code, name: `Khoản mục ${code}` } })).statusCode).toBe(201);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie: c }, payload: { code: 'KH001', name: 'Khách 1', is_customer: true } })).statusCode).toBe(201);
    await ok(pkt('2026-01-02', [{ accountCode: '1111', debit: '1000' }, { accountCode: '4111', credit: '1000' }], c));
    // một chứng từ, hai dòng 6421 cùng tài khoản khác khoản mục
    await ok(pkt('2026-01-05', [{ accountCode: '6421', debit: '70', costItemCode: 'CPA' }, { accountCode: '6421', debit: '30', costItemCode: 'CPB' }, { accountCode: '1111', credit: '100' }], c));
    await ok(pkt('2026-01-16', [{ accountCode: '1121', debit: '500' }, { accountCode: '5113', credit: '500' }], c));
    await ok(pkt('2026-01-17', [{ accountCode: '1122', debit: '200' }, { accountCode: '1121', credit: '200' }], c)); // chuyển nội bộ trong nhóm 112
    await ok(pkt('2026-01-20', [{ accountCode: '131', debit: '400', partyCode: 'KH001' }, { accountCode: '5113', credit: '400' }], c));
    await ok(pkt('2026-03-10', [{ accountCode: '6421', debit: '50', costItemCode: 'CPB' }, { accountCode: '1111', credit: '50' }], c));
    await ok(pkt('2026-03-12', [{ accountCode: '1111', debit: '100' }, { accountCode: '131', credit: '100', partyCode: 'KH001' }], c));
    await ok(pkt('2026-04-01', [{ accountCode: '1386', debit: '7' }, { accountCode: '5113', credit: '7' }], c)); // chỉ có trong hệ TT133
    await ok(pkt('2027-02-01', [{ accountCode: '1362', debit: '5' }, { accountCode: '5113', credit: '5' }], c)); // chỉ có trong hệ TT200
  }, 60_000);

  it('chuyển nội bộ Nợ 1122 / Có 1121: sổ cái 112 có cả hai bên, bằng phát sinh và dư cuối của bảng cân đối số phát sinh', async () => {
    const led = (await get('/api/reports/ledgers/account?accountCode=112&from=2026-01-01&to=2026-01-31&mode=voucher', c)).json();
    expect(led.rows.map((x: { counterAccountCode: string; debit: string; credit: string }) => [x.counterAccountCode, x.debit, x.credit])).toEqual([['5113', '500', '0'], ['1121', '200', '0'], ['1122', '0', '200']]);
    const t = (await tb('2026-01-01', '2026-01-31')).rows.find((x) => x.accountCode === '112')!;
    expect([led.totalDebit, led.totalCredit]).toEqual([t.period.debit, t.period.credit]);
    expect([led.totalDebit, led.totalCredit]).toEqual(['700', '200']);
    expect(led.closing).toEqual(t.closing); expect(led.closing).toEqual({ debit: '500', credit: '0' });
    const tSide = (await get('/api/reports/ledgers/account?accountCode=112&from=2026-01-01&to=2026-01-31&mode=t', c)).json();
    expect(tSide.debitSide).toEqual([{ counterAccountCode: '1121', amount: '200' }, { counterAccountCode: '5113', amount: '500' }]);
    expect(tSide.creditSide).toEqual([{ counterAccountCode: '1122', amount: '200' }]);
  });

  it('cặp đối ứng ghi đúng dòng gốc và tổng cặp của từng dòng bằng số tiền dòng', async () => {
    const bad = await sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher_line l WHERE l.tenant_id = ${tenantId}::uuid AND (
        (l.debit > 0 AND l.debit <> (SELECT coalesce(sum(p.amount), 0) FROM voucher_pair p WHERE p.debit_line_id = l.id AND p.posting_date = l.posting_date AND p.debit_account_id = l.account_id))
     OR (l.credit > 0 AND l.credit <> (SELECT coalesce(sum(p.amount), 0) FROM voucher_pair p WHERE p.credit_line_id = l.id AND p.posting_date = l.posting_date AND p.credit_account_id = l.account_id)))`.execute(ctx.t.admin);
    expect(bad.rows[0]!.n).toBe(0);
    // dựng lại cặp (như migration 0012 làm với chứng từ cũ) vẫn điền đủ mã dòng
    await sql`UPDATE voucher_pair SET debit_line_id = NULL, credit_line_id = NULL WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin);
    await sql`SELECT fn_build_pairs(id) FROM voucher WHERE tenant_id = ${tenantId}::uuid AND state IN ('posted','reversed')`.execute(ctx.t.admin);
    const nulls = await sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher_pair WHERE tenant_id = ${tenantId}::uuid AND (debit_line_id IS NULL OR credit_line_id IS NULL)`.execute(ctx.t.admin);
    expect(nulls.rows[0]!.n).toBe(0);
  });

  it('hai dòng 6421 cùng chứng từ khác khoản mục: lọc theo khoản mục B ra 30, A ra 70, không lọc ra cả hai đúng chiều', async () => {
    const b = await detail('accountCode=6421&from=2026-01-01&to=2026-01-31&costItemCode=CPB');
    expect(b.rows.map((x) => [x.costItemCode, x.debit, x.counterAccountCode])).toEqual([['CPB', '30', '1111']]);
    expect(b.closing).toEqual({ debit: '30', credit: '0' });
    const a = await detail('accountCode=6421&from=2026-01-01&to=2026-01-31&costItemCode=CPA');
    expect(a.rows.map((x) => [x.costItemCode, x.debit])).toEqual([['CPA', '70']]);
    const all = await detail('accountCode=6421&from=2026-01-01&to=2026-01-31');
    expect(all.rows.map((x) => [x.costItemCode, x.debit])).toEqual([['CPA', '70'], ['CPB', '30']]);
  });

  it('sổ chi tiết lọc theo chiều phân tích tính dư đầu từ các dòng đã ghi sổ trước kỳ với cùng bộ lọc; lọc đối tượng dùng số dư kỳ', async () => {
    const b = await detail('accountCode=6421&from=2026-03-01&to=2026-03-31&costItemCode=CPB');
    expect(b.opening).toEqual({ debit: '30', credit: '0' });
    expect(b.rows.map((x) => x.debit)).toEqual(['50']); expect(b.closing).toEqual({ debit: '80', credit: '0' });
    const a = await detail('accountCode=6421&from=2026-03-01&to=2026-03-31&costItemCode=CPA');
    expect([a.opening, a.rows.length, a.closing]).toEqual([{ debit: '70', credit: '0' }, 0, { debit: '70', credit: '0' }]);
    const p = await detail('accountCode=131&from=2026-03-01&to=2026-03-31&partyCode=KH001');
    expect(p.opening).toEqual({ debit: '400', credit: '0' }); expect(p.rows.map((x) => [x.debit, x.credit])).toEqual([['0', '100']]); expect(p.closing).toEqual({ debit: '300', credit: '0' });
  });

  it('một công ty giữ hai hệ tài khoản: bảng cân đối năm 2026 (TT133) chỉ có tài khoản TT133, mỗi mã một dòng, vẫn cân', async () => {
    const t26 = await tb('2026-01-01', '2026-12-31');
    const codes = t26.rows.map((x) => x.accountCode);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain('1386'); expect(codes).not.toContain('1362');
    expect(t26.rows.find((x) => x.accountCode === '1386')!.period).toEqual({ debit: '7', credit: '0' });
    expect(t26.totals.closing.debit).toBe(t26.totals.closing.credit); expect(t26.totals.period.debit).toBe(t26.totals.period.credit);
    const t27 = await tb('2027-01-01', '2027-12-31');
    const codes27 = t27.rows.map((x) => x.accountCode);
    expect(new Set(codes27).size).toBe(codes27.length);
    expect(codes27).toContain('1362'); expect(codes27).not.toContain('1386');
    expect(t27.rows.find((x) => x.accountCode === '1362')!.period).toEqual({ debit: '5', credit: '0' });
    // sổ cái và sổ chi tiết tra tài khoản theo hệ của kỳ chứa ngày bắt đầu
    const url = (code: string, from: string, to: string) => `/api/reports/ledgers/account?accountCode=${code}&from=${from}&to=${to}&mode=voucher`;
    expect((await get(url('1386', '2026-01-01', '2026-12-31'), c)).statusCode).toBe(200);
    expect((await get(url('1386', '2027-01-01', '2027-12-31'), c)).statusCode).toBe(404);
    expect((await get(url('1362', '2026-01-01', '2026-12-31'), c)).statusCode).toBe(404);
    const l27 = await get(url('1362', '2027-01-01', '2027-12-31'), c);
    expect(l27.statusCode, l27.body).toBe(200); expect(l27.json().totalDebit).toBe('5');
    // khoảng bắt chéo hai năm lấy hệ của kỳ chứa ngày bắt đầu
    expect((await get(url('1386', '2026-12-01', '2027-01-31'), c)).statusCode).toBe(200);
  });

  it('chứng từ kết chuyển KC có mặt trong nhật ký chung và sổ cái 911', async () => {
    const run = await ctx.app.inject({ method: 'POST', url: '/api/closing/run-all', headers: { cookie: c }, payload: { postingDate: '2026-12-31' } });
    expect(run.statusCode, run.body).toBe(200);
    const j = (await get('/api/reports/ledgers/general-journal?from=2026-12-31&to=2026-12-31', c)).json();
    expect(j.rows.length).toBeGreaterThan(0); expect(j.rows.every((x: { voucherType: string }) => x.voucherType === 'KC')).toBe(true);
    expect(j.totalDebit).toBe(j.totalCredit);
    const l911 = (await get('/api/reports/ledgers/account?accountCode=911&from=2026-12-31&to=2026-12-31&mode=voucher', c)).json();
    expect(l911.rows.length).toBeGreaterThan(0); expect(l911.closing).toEqual({ debit: '0', credit: '0' });
  }, 60_000);
});
