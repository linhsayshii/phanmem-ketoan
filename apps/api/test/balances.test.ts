import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string;
const L = (accountCode: string, debit = '0', credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
async function voucher(date: string, lines: object[], extra: object = {}) {
  const r = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Phiếu thử số dư', lines, autoPost: true, ...extra } });
  expect(r.statusCode, r.body).toBe(201);
}
const get = (qs: string, c = cookie) => ctx.app.inject({ method: 'GET', url: `/api/balances?${qs}`, headers: { cookie: c } });
const recompute = (c = cookie) => ctx.app.inject({ method: 'POST', url: '/api/balances/recompute', headers: { cookie: c } });
type Row = { accountCode: string; accountName: string; partyCode: string | null; partyName: string | null; currencyCode: string; debit: string; credit: string; debitCur: string; creditCur: string };
const rowsOf = async (qs: string) => { const r = await get(qs); expect(r.statusCode, r.body).toBe(200); return r.json().rows as Row[]; };
const pick = (rows: Row[]) => rows.map((r) => [r.accountCode, r.partyCode, r.debit, r.credit]);

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `BA${Date.now()}` }));
  // Hai năm hai chế độ: một công ty giữ nhiều hệ tài khoản (cùng mã 1111 nhưng là hai tài khoản khác nhau).
  for (const [fiscalYear, dateFrom, regime] of [[2026, '2026-01-01', 'TT133'], [2027, '2027-01-01', 'TT200']] as const) {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear, dateFrom, months: 12, regime, confirmRegimeOverride: true } });
    expect(r.statusCode, r.body).toBe(201);
  }
  for (const [code, name] of [['KH001', 'Khách A'], ['KH002', 'Khách B']]) await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code, name, is_customer: true } });
  await voucher('2026-03-05', [L('131', '1000', '0', { partyCode: 'KH001' }), L('5113', '0', '1000')]);
  await voucher('2026-03-06', [L('131', '500', '0', { partyCode: 'KH002' }), L('5113', '0', '500')]);
  await voucher('2026-04-10', [L('1111', '1500'), L('131', '0', '1500', { partyCode: 'KH001' })]);
  await voucher('2026-05-02', [L('131', '700', '0', { partyCode: 'KH002' }), L('5113', '0', '700')]);
}, 120_000);
afterAll(async () => { await ctx.close(); });

describe('GET /api/balances', () => {
  it('byParty=true trả mã và tên đối tượng, mỗi đối tượng một bên; byParty=false gộp theo tài khoản; số dư ròng bằng 0 thì không liệt kê', async () => {
    const byParty = await get('asOf=2026-04-30&accountCode=131&byParty=true');
    expect(byParty.json().rows).toMatchObject([
      { accountCode: '131', partyCode: 'KH001', partyName: 'Khách A', currencyCode: 'VND', debit: '0', credit: '500' },
      { accountCode: '131', partyCode: 'KH002', partyName: 'Khách B', currencyCode: 'VND', debit: '500', credit: '0' }]);
    expect(pick(await rowsOf('asOf=2026-03-31&accountCode=131&byParty=true'))).toEqual([['131', 'KH001', '1000', '0'], ['131', 'KH002', '500', '0']]);
    // 30/4: 131 có Nợ 500 (KH002) và Có 500 (KH001) -> ròng 0; 31/5: KH001 Có 500, KH002 Nợ 1200 -> ròng Nợ 700
    expect(await rowsOf('asOf=2026-04-30&accountCode=131')).toEqual([]);
    const net = await rowsOf('asOf=2026-05-31&accountCode=131');
    expect(net).toMatchObject([{ accountCode: '131', partyCode: null, partyName: null, debit: '700', credit: '0' }]);
    expect(pick(await rowsOf('asOf=2026-05-31&accountCode=1&byParty=true').then((r) => r.filter((x) => x.accountCode !== '131')))).toEqual([['1111', null, '1500', '0']]);
    // accountCode là tiền tố, không phải mẫu LIKE: dấu % và _ không thành ký tự đại diện
    expect((await rowsOf('asOf=2026-05-31&accountCode=511')).map((r) => r.accountCode)).toEqual(['5113']);
    expect(await rowsOf('asOf=2026-05-31&accountCode=%25')).toEqual([]);
    expect(await rowsOf('asOf=2026-05-31&accountCode=1_1')).toEqual([]);
  });

  it('cờ stale đúng: true sau ghi sổ, tính lại đồng bộ trả số kỳ, rồi false mà số liệu không đổi (đường chậm bằng đường nhanh)', async () => {
    const slow = await get('asOf=2026-05-31&byParty=true');
    expect(slow.json().stale).toBe(true);
    const r = await recompute();
    expect(r.statusCode, r.body).toBe(200); expect(r.json().periods).toBeGreaterThan(0); expect(typeof r.json().periods).toBe('number');
    const fast = await get('asOf=2026-05-31&byParty=true');
    expect(fast.json()).toEqual({ rows: slow.json().rows, stale: false });
    expect(fast.json().rows.length).toBeGreaterThan(0);
    expect((await recompute()).json()).toEqual({ periods: 0 });
  });

  it('chỉ liệt kê tài khoản của chế độ kế toán chứa asOf: kỳ 2027 (TT200) không lẫn tài khoản 2026 (TT133) cùng mã', async () => {
    await voucher('2027-03-10', [L('1111', '300'), L('5113', '0', '300')]);
    // 2026-12-31 cũng là ngày của kỳ 0 năm 2027: ưu tiên kỳ thường (năm 2026, TT133) như hàm số dư
    expect(pick(await rowsOf('asOf=2026-12-31&accountCode=1111'))).toEqual([['1111', null, '1500', '0']]);
    expect(pick(await rowsOf('asOf=2027-03-31'))).toEqual([['1111', null, '300', '0'], ['5113', null, '0', '300']]);
    expect(pick(await rowsOf('asOf=2027-02-15'))).toEqual([]); // TT200 chưa có phát sinh; số dư TT133 kết chuyển không thuộc chế độ này
    // sau kỳ cuối: dùng kỳ bắt đầu gần nhất trước ngày (12/2027, TT200); trước mọi kỳ: không có dòng nào
    expect(pick(await rowsOf('asOf=2028-06-30'))).toEqual([['1111', null, '300', '0'], ['5113', null, '0', '300']]);
    expect(await rowsOf('asOf=2025-06-30')).toEqual([]);
  });

  it('ngày sai bị từ chối 400; cần quyền report.view; chưa đăng nhập 401', async () => {
    expect((await get('asOf=2026-02-30')).statusCode).toBe(400);
    expect((await get('asOf=hom-nay')).statusCode).toBe(400);
    expect((await get('byParty=true')).statusCode).toBe(400);
    const roles = (await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie } })).json() as { id: string; code: string }[];
    await ctx.app.inject({ method: 'PUT', url: `/api/roles/${roles.find((x) => x.code === 'xem')!.id}/permissions`, headers: { cookie }, payload: { permissions: ['voucher.view'] } });
    const username = `xem_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username, fullName: 'Chỉ xem phiếu', password: 'Matkhau1!', roleCode: 'xem' } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const xem = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    expect((await get('asOf=2026-05-31', xem)).statusCode).toBe(403);
    expect((await recompute(xem)).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/balances?asOf=2026-05-31' })).statusCode).toBe(401);
  });

  it('thứ tự ổn định: cùng tài khoản nhiều loại tiền sắp theo mã tiền, kể cả khi gộp hay tách theo đối tượng', async () => {
    await voucher('2026-06-10', [L('1122', '25400000', '0', { amountCurrency: '1000' }), L('5113', '0', '25400000', { amountCurrency: '-1000' })], { currencyCode: 'USD', fxRate: '25400' });
    await voucher('2026-06-11', [L('1122', '1000'), L('5113', '0', '1000')]);
    for (const qs of ['asOf=2026-06-30&accountCode=1122', 'asOf=2026-06-30&accountCode=1122&byParty=true']) {
      const rows = await rowsOf(qs);
      expect(rows.map((r) => [r.accountCode, r.currencyCode, r.debit]), qs).toEqual([['1122', 'USD', '25400000'], ['1122', 'VND', '1000']]);
      expect(Number(rows[0]!.debitCur)).toBe(1000); expect(Number(rows[1]!.debitCur)).toBe(1000);
    }
  });
});
