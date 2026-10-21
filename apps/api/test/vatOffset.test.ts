import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { postVoucher, setupLedgerTenant } from './invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];
interface Offset { laterOffsetDates: string[]; amount: string; voucherId: string | null; reversedVoucherIds: string[]; unchanged: boolean; outputBalance: string; inputBalances: { accountCode: string; balance: string }[] }
const M = (x: number) => String(x * 1_000_000);

async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `VO${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  const pkt = async (date: string, lines: object[]) => { const r = await postVoucher(ctx, cookie, date, lines); expect(r.statusCode, r.body).toBe(201); };
  const run = (date: string, c = cookie) => call('POST', '/api/tax/vat-offset', { date }, c);
  const runOk = async (date: string): Promise<Offset> => { const r = await run(date); expect(r.statusCode, r.body).toBe(200); return r.json(); };
  const voucher = async (id: string) => (await call('GET', `/api/vouchers/${id}`)).json() as { voucherType: string; state: string; postingDate: string; sourceDocType: string | null; lines: { accountCode: string; debit: string; credit: string }[] };
  return { cookie, tenantId, call, pkt, run, runOk, voucher };
}
const sale = (amt: string) => [{ accountCode: '131', partyCode: 'KH001', debit: amt, credit: '0' }, { accountCode: '33311', debit: '0', credit: amt }];
const buy = (acc: string, amt: string) => [{ accountCode: acc, debit: amt, credit: '0' }, { accountCode: '331', partyCode: 'NCC001', debit: '0', credit: amt }];

describe('khấu trừ thuế GTGT cuối kỳ', () => {
  it('khấu trừ thuế: dư Có 33311 30tr, dư Nợ 1331 12tr → KTT 12tr; chạy lại đảo cũ', async () => {
    const t = await tenant();
    await t.pkt('2026-07-10', sale(M(30)));
    await t.pkt('2026-07-12', buy('1331', M(12)));
    const r = await t.runOk('2026-07-31');
    expect(r).toMatchObject({ amount: M(12), outputBalance: M(30), inputBalances: [{ accountCode: '1331', balance: M(12) }], reversedVoucherIds: [], unchanged: false });
    const v = await t.voucher(r.voucherId!);
    expect(v).toMatchObject({ voucherType: 'KTT', state: 'posted', postingDate: '2026-07-31', sourceDocType: 'vat_offset' });
    expect(v.lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['33311', M(12), '0'], ['1331', '0', M(12)]]);

    // chạy lại không đổi: không chạm sổ
    expect(await t.runOk('2026-07-31')).toMatchObject({ amount: M(12), voucherId: r.voucherId, reversedVoucherIds: [], unchanged: true });
    // thêm thuế đầu vào cùng kỳ: đảo KTT cũ cùng ngày, sinh mới
    await t.pkt('2026-07-20', buy('1331', M(5)));
    const r2 = await t.runOk('2026-07-31');
    expect(r2).toMatchObject({ amount: M(17), reversedVoucherIds: [r.voucherId], unchanged: false });
    expect((await t.voucher(r.voucherId!)).state).toBe('reversed');
    expect((await t.voucher(r2.voucherId!)).lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['33311', M(17), '0'], ['1331', '0', M(17)]]);
    // KTT là chứng từ hệ thống: không bỏ ghi sổ, không lập tay
    expect(err(await t.call('POST', `/api/vouchers/${r2.voucherId}/unpost`))).toEqual([409, 'VOUCHER_SYSTEM_GENERATED']);
    expect(err(await t.call('POST', '/api/vouchers', { voucherType: 'KTT', postingDate: '2026-07-31', documentDate: '2026-07-31', lines: sale('1') }))).toEqual([409, 'VOUCHER_TYPE_SYSTEM']);
  });

  it('1331 không đủ thì Có tiếp 1332; 33311 nhỏ hơn thì khấu trừ bằng 33311; không có gì để khấu trừ thì không sinh', async () => {
    const t = await tenant();
    expect(await t.runOk('2026-07-31')).toMatchObject({ amount: '0', voucherId: null, unchanged: true });
    await t.pkt('2026-07-10', sale(M(30)));
    await t.pkt('2026-07-11', buy('1331', M(17)));
    await t.pkt('2026-07-12', buy('1332', M(20)));
    const r = await t.runOk('2026-07-31');
    expect(r.amount).toBe(M(30));
    expect((await t.voucher(r.voucherId!)).lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['33311', M(30), '0'], ['1331', '0', M(17)], ['1332', '0', M(13)]]);
    // ngày sau trong kỳ: dư Có 33311 đã về 0 nên không sinh thêm
    expect(await t.runOk('2026-08-31')).toMatchObject({ amount: '0', voucherId: null });
  });

  it('chạy lại ngày trước khi đã có KTT ngày sau: báo laterOffsetDates và cảnh báo, không tự chạy lại', async () => {
    const t = await tenant();
    await t.pkt('2026-07-10', sale(M(30)));
    await t.pkt('2026-07-12', buy('1331', M(12)));
    const aug = await t.runOk('2026-08-31');
    expect(aug).toMatchObject({ amount: M(12), laterOffsetDates: [], warnings: [] });
    await t.pkt('2026-07-20', buy('1331', M(5)));
    const jul = await t.runOk('2026-07-31');
    expect(jul).toMatchObject({ amount: M(17), laterOffsetDates: ['2026-08-31'] });
    expect((jul as Offset & { warnings: string[] }).warnings.join(' ')).toContain('31/08/2026');
    expect((await t.voucher(aug.voucherId!)).state).toBe('posted'); // KTT 31/8 giữ nguyên
  });

  it('kỳ khóa mềm cần quyền ghi lùi; khóa cứng 409; không có kỳ 404; quyền tax.offset', async () => {
    const t = await tenant();
    await t.pkt('2026-07-10', sale(M(3)));
    await t.pkt('2026-07-12', buy('1331', M(1)));
    const lock = async (level: string, no: number) => { const r = await t.call('POST', `/api/periods/2026/${no}/lock`, { level }); expect(r.statusCode, r.body).toBe(200); };
    const username = `kt_${Date.now()}`;
    expect((await t.call('POST', '/api/users', { username, fullName: 'KT', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: [] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    expect(err(await t.run('2026-07-31', `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`))).toEqual([403, 'FORBIDDEN']);
    await lock('soft', 7);
    expect((await t.runOk('2026-07-31')).amount).toBe(M(1)); // chủ sở hữu có quyền ghi lùi
    for (const p of [0, 1, 2, 3, 4, 5, 6, 7]) await lock('hard', p);
    expect(err(await t.run('2026-07-31'))).toEqual([409, 'PERIOD_HARD_LOCKED']);
    expect(err(await t.run('2027-01-31'))).toEqual([404, 'PERIOD_NOT_FOUND']);
  });
});
