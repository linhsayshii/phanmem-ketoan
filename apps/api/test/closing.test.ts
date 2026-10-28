import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { LightMyRequestResponse } from 'fastify';
import { withTenant } from '@kt/db';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';
import { runStep } from '../src/modules/ledger/closing.js';

let ctx: TestApp; let cookie: string; let tenantId: string; let userId: string;
const pkt = (date: string, lines: object[]) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'x', autoPost: true, lines } });
const bal = async (asOf: string) => { const r = await ctx.app.inject({ method: 'GET', url: `/api/balances?asOf=${asOf}`, headers: { cookie } }); return Object.fromEntries((r.json().rows as { accountCode: string; debit: string; credit: string }[]).map((x) => [x.accountCode, { d: x.debit, c: x.credit }])); };

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId, userId } = await bootstrapTenant(ctx, { code: `KC${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT200', confirmRegimeOverride: true } });
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2027, dateFrom: '2027-01-01', months: 12, regime: 'TT200', confirmRegimeOverride: true } });
  await pkt('2026-03-05', [{ accountCode: '1121', debit: '1000' }, { accountCode: '5113', credit: '1000' }]);
  await pkt('2026-06-05', [{ accountCode: '6421', debit: '600' }, { accountCode: '1121', credit: '600' }]);
  await pkt('2026-09-05', [{ accountCode: '6422', debit: '100' }, { accountCode: '1111', credit: '100' }]);
}, 30_000);
afterAll(async () => { await ctx.close(); });

describe('kết chuyển', () => {
  it('keepBalance tối đa 16 chữ số', async () => {
    const cur = (await ctx.app.inject({ method: 'GET', url: '/api/closing/steps', headers: { cookie } })).json() as { id: string; stepOrder: number; name: string; mode: string; fromAccounts: string[]; toAccount: string | null; runAt: string }[];
    const put = (keepBalance: string) => ctx.app.inject({ method: 'PUT', url: '/api/closing/steps', headers: { cookie }, payload: { steps: cur.map((s, i) => ({ ...s, keepBalance: i === 0 ? keepBalance : '0' })) } });
    const bad = await put('10000000000000000');
    expect(bad.statusCode).toBe(400); expect(bad.body).toContain('Số tiền VND phải là số nguyên tối đa 16 chữ số');
    expect((await put('9999999999999999')).statusCode).toBe(200);
    expect((await put('0')).statusCode).toBe(200);
  });
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
  it('chứng từ KC/PB do hệ thống sinh: bỏ ghi sổ, hủy, xóa, sửa dòng, nhân bản đều bị chặn (API và SQL trực tiếp)', async () => {
    const kcId = (await ctx.app.inject({ method: 'GET', url: '/api/vouchers?type=KC&from=2026-12-31&to=2026-12-31', headers: { cookie } })).json().rows[0].id as string;
    const MSG = 'Chứng từ do hệ thống sinh (kết chuyển/phân bổ); dùng Chạy lại (đảo cũ) ở màn hình Kết chuyển';
    const call = (method: 'GET' | 'POST' | 'DELETE' | 'PUT', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
    const version = (await call('GET', `/api/vouchers/${kcId}`)).json().version as number;
    for (const [what, r] of [['unpost', await call('POST', `/api/vouchers/${kcId}/unpost`)], ['discard', await call('POST', `/api/vouchers/${kcId}/discard`)], ['delete', await call('DELETE', `/api/vouchers/${kcId}`)],
      ['sửa dòng', await call('PUT', `/api/vouchers/${kcId}`, { version, lines: [{ lineNo: 1, description: 'sửa' }] })]] as const)
      expect([what, r.statusCode, r.json().error.code, r.json().error.message]).toEqual([what, 409, 'VOUCHER_SYSTEM_GENERATED', MSG]);
    const dup = await call('POST', `/api/vouchers/${kcId}/duplicate`, { postingDate: '2026-12-31' });
    expect([dup.statusCode, dup.json().error.code]).toEqual([409, 'VOUCHER_TYPE_SYSTEM']);
    for (const fn of ['unpost_voucher', 'discard_voucher'])
      await expect(withTenant(ctx.t.db, { tenantId, userId }, (trx) => sql`SELECT ${sql.id(fn)}(${kcId}::uuid)`.execute(trx))).rejects.toMatchObject({ code: 'P0001', message: `VOUCHER_SYSTEM_GENERATED: ${MSG}` });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${kcId}`, headers: { cookie } })).json().state).toBe('posted');
  });
  it('phát sinh thêm rồi chạy lại: KC cũ bị đảo, số dư 4212 đúng 320; không sửa đè', async () => {
    await pkt('2026-12-20', [{ accountCode: '1121', debit: '20' }, { accountCode: '5113', credit: '20' }]);
    const steps = (await ctx.app.inject({ method: 'GET', url: '/api/closing/steps', headers: { cookie } })).json() as { id: string; name: string; toAccount: string; stepOrder: number }[];
    for (const s of steps.filter((x) => x.stepOrder <= 4)) {
      const rr = await ctx.app.inject({ method: 'POST', url: '/api/closing/rerun', headers: { cookie }, payload: { stepId: s.id, postingDate: '2026-12-31' } });
      expect(rr.statusCode, rr.body).toBe(200);
      // các bước sau (theo thứ tự) đã chạy cùng ngày không tự chạy lại: báo tên để người dùng chạy lại; bước 5 (đầu năm sau) chưa chạy nên không có
      expect(rr.json().laterStepsDone, `rerun bước ${s.stepOrder}`).toEqual(steps.filter((x) => x.stepOrder > s.stepOrder && x.stepOrder <= 4).map((x) => x.name));
    }
    const run = await ctx.app.inject({ method: 'POST', url: '/api/closing/run', headers: { cookie }, payload: { stepId: steps[0]!.id, postingDate: '2026-12-31' } });
    expect(run.json()).not.toHaveProperty('laterStepsDone'); // chỉ chạy lại mới có
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

// Các kiểm thử dưới đây dùng công ty riêng để không phụ thuộc trạng thái của nhóm trên.
type Call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => Promise<LightMyRequestResponse>;
async function newTenant(label: string, years: [number, string][]) {
  const { cookie: c, tenantId, userId } = await bootstrapTenant(ctx, { code: `${label}${Date.now()}` });
  const call: Call = (method, url, payload) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
  for (const [fiscalYear, regime] of years) {
    const r = await call('POST', '/api/fiscal-years', { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime, confirmRegimeOverride: true });
    expect(r.statusCode, r.body).toBe(201);
  }
  return { call, tenantId, userId, steps: async (): Promise<{ id: string; stepOrder: number }[]> => (await call('GET', '/api/closing/steps')).json() };
}
const post = (call: Call, date: string, lines: object[]) => call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'x', autoPost: true, lines });

describe('kết chuyển: đồng thời và lịch sử chạy', () => {
  it('khóa theo công ty: giao dịch thứ hai chờ giao dịch đầu commit rồi thấy số dư đã về 0, không sinh trùng KC', async () => {
    const { call, steps, tenantId, userId } = await newTenant('KCKHOA', [[2026, 'TT200']]);
    await post(call, '2026-03-05', [{ accountCode: '1121', debit: '1000' }, { accountCode: '5113', credit: '1000' }]);
    const step2 = (await steps()).find((s) => s.stepOrder === 2)!;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    // A chạy xong nhưng chưa commit; B bắt đầu khi A còn mở. Không có khóa thì B cũng thấy số dư chưa kết chuyển và sinh bộ KC thứ hai.
    const a = withTenant(ctx.t.db, { tenantId, userId }, async (trx) => { const ids = await runStep(trx, tenantId, step2.id, '2026-12-31'); await gate; return ids; });
    await wait(300);
    const b = withTenant(ctx.t.db, { tenantId, userId }, (trx) => runStep(trx, tenantId, step2.id, '2026-12-31'));
    await wait(300);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.length, rb.length]).toEqual([1, 0]);
    expect((await call('GET', '/api/vouchers?type=KC')).json().total).toBe(1);
  }, 30_000);

  it('chạy cùng một bước hai lần song song chỉ sinh một bộ chứng từ; nạp lại mẫu không xóa nhật ký chạy', async () => {
    const { call, steps } = await newTenant('KCSONG', [[2026, 'TT200']]);
    expect((await post(call, '2026-03-05', [{ accountCode: '1121', debit: '1000' }, { accountCode: '5113', credit: '1000' }])).statusCode).toBe(201);
    const step2 = (await steps()).find((s) => s.stepOrder === 2)!;
    const run = () => call('POST', '/api/closing/run', { stepId: step2.id, postingDate: '2026-12-31' });
    const rs = await Promise.all([run(), run()]);
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(rs.flatMap((r) => r.json().voucherIds as string[])).toHaveLength(1);
    expect((await call('GET', '/api/vouchers?type=KC')).json().total).toBe(1);

    const reload = await call('POST', '/api/closing/steps/reload');
    expect(reload.statusCode, reload.body).toBe(200);
    const runs = (await call('GET', '/api/closing/runs?year=2026')).json() as { stepName: string; voucherNo: string | null; status: string }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ stepName: 'Bước đã xóa', status: 'done' }); expect(runs[0]!.voucherNo).toMatch(/^KC/);
    // Màn hình mở từ trước khi nạp lại mẫu gửi mã bước cũ: bị từ chối, sơ đồ không bị xóa sạch.
    const stale = await call('PUT', '/api/closing/steps', { steps: [{ id: step2.id, stepOrder: 1, name: 'x', mode: 'transfer', fromAccounts: ['511'], toAccount: '911' }] });
    expect([stale.statusCode, stale.json().error.code]).toEqual([409, 'CLOSING_STEP_STALE']);
    expect(await steps()).toHaveLength(5);
  }, 30_000);

  it('PUT sơ đồ giữ nguyên nhật ký của bước còn lại, đổi chỗ thứ tự được', async () => {
    const { call, steps } = await newTenant('KCPUT', [[2026, 'TT200']]);
    await post(call, '2026-03-05', [{ accountCode: '1121', debit: '1000' }, { accountCode: '5113', credit: '1000' }]);
    const cur = (await call('GET', '/api/closing/steps')).json() as { id: string; stepOrder: number }[];
    await call('POST', '/api/closing/run', { stepId: cur.find((s) => s.stepOrder === 2)!.id, postingDate: '2026-12-31' });
    const swapped = cur.map((s) => ({ ...s, stepOrder: s.stepOrder === 2 ? 3 : s.stepOrder === 3 ? 2 : s.stepOrder }));
    const put = await call('PUT', '/api/closing/steps', { steps: swapped });
    expect(put.statusCode, put.body).toBe(200);
    expect((await steps()).map((s) => s.id)).toEqual([cur[0]!, cur[2]!, cur[1]!, cur[3]!, cur[4]!].map((s) => s.id));
    const runs = (await call('GET', '/api/closing/runs?year=2026')).json() as { stepName: string }[];
    expect(runs.map((r) => r.stepName)).toEqual(['Kết chuyển doanh thu, thu nhập khác']);
    // Xóa hẳn bước: nhật ký còn, tên bước hiện 'Bước đã xóa'.
    expect((await call('PUT', '/api/closing/steps', { steps: [] })).statusCode).toBe(200);
    expect(((await call('GET', '/api/closing/runs')).json() as { stepName: string }[]).map((r) => r.stepName)).toEqual(['Bước đã xóa']);
  }, 30_000);
});

describe('kết chuyển: phạm vi chế độ, đối tượng, lỗi', () => {
  it('công ty giữ hai hệ tài khoản: tiền tố chỉ quét tài khoản của chế độ kỳ chứa ngày chạy', async () => {
    const { call } = await newTenant('KC2HE', [[2026, 'TT133'], [2027, 'TT200']]);
    await post(call, '2026-03-05', [{ accountCode: '1121', debit: '1000' }, { accountCode: '5113', credit: '1000' }]); // 5113 của TT133, không kết chuyển
    await post(call, '2027-03-05', [{ accountCode: '1121', debit: '500' }, { accountCode: '5113', credit: '500' }]); // 5113 của TT200
    const r = await call('POST', '/api/closing/run-all', { postingDate: '2027-12-31' });
    expect(r.statusCode, r.body).toBe(200);
    const kc = (await call('GET', '/api/vouchers?type=KC&from=2027-12-31&to=2027-12-31')).json();
    expect(kc.total).toBe(2); // doanh thu→911, 911→4212
    const lines = (await call('GET', `/api/vouchers/${kc.rows.at(-1).id}`)).json().lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit]);
    expect(lines).toEqual([['5113', '500', '0'], ['911', '0', '500']]);
  }, 30_000);

  it('chế độ TT99: 521 kết chuyển vào 511, rồi 511 vào 911, 911 vào 4212', async () => {
    const { call } = await newTenant('KC99', [[2026, 'TT99']]);
    expect((await post(call, '2026-03-05', [{ accountCode: '111', debit: '1000' }, { accountCode: '511', credit: '1000' }])).statusCode).toBe(201);
    expect((await post(call, '2026-03-06', [{ accountCode: '521', debit: '100' }, { accountCode: '111', credit: '100' }])).statusCode).toBe(201);
    const r = await call('POST', '/api/closing/run-all', { postingDate: '2026-12-31' });
    expect(r.statusCode, r.body).toBe(200);
    const kc = (await call('GET', '/api/vouchers?type=KC&from=2026-12-31&to=2026-12-31')).json();
    expect(kc.total).toBe(3); // 521→511, 511→911, 911→4212
    const lines: string[] = [];
    for (const v of kc.rows as { id: string }[])
      for (const l of (await call('GET', `/api/vouchers/${v.id}`)).json().lines as { accountCode: string; debit: string; credit: string }[]) lines.push(`${l.accountCode} ${l.debit}/${l.credit}`);
    expect(lines.sort()).toEqual(['4212 0/900', '511 100/0', '511 900/0', '521 0/100', '911 0/900', '911 900/0']);
  }, 30_000);
  it('nguồn là tài khoản công nợ: dòng kết chuyển mang theo đối tượng', async () => {
    const { call } = await newTenant('KCDT', [[2026, 'TT200']]);
    expect((await call('POST', '/api/catalogs/party', { code: 'KH1', name: 'Khách 1', is_customer: true })).statusCode).toBe(201);
    await post(call, '2026-03-05', [{ accountCode: '131', debit: '500', partyCode: 'KH1' }, { accountCode: '5113', credit: '500' }]);
    const put = await call('PUT', '/api/closing/steps', { steps: [{ stepOrder: 1, name: 'Chuyển công nợ', mode: 'transfer', fromAccounts: ['131'], toAccount: '4212' }] });
    expect(put.statusCode, put.body).toBe(200);
    const [s] = (await call('GET', '/api/closing/steps')).json() as { id: string }[];
    const r = await call('POST', '/api/closing/run', { stepId: s!.id, postingDate: '2026-12-31' });
    expect(r.statusCode, r.body).toBe(200);
    const v = (await call('GET', `/api/vouchers/${r.json().voucherIds[0]}`)).json();
    expect(v.lines.map((l: { accountCode: string; partyCode: string | null; debit: string; credit: string }) => [l.accountCode, l.partyCode, l.debit, l.credit])).toEqual([['131', 'KH1', '0', '500'], ['4212', null, '500', '0']]);
  }, 30_000);

  it('mã lỗi: bước không có, tỷ lệ sai, tài khoản đích sai, ngày ngoài kỳ, ngày sai định dạng', async () => {
    const { call } = await newTenant('KCLOI', [[2026, 'TT200']]);
    const put = await call('PUT', '/api/closing/steps', { steps: [
      { stepOrder: 1, name: 'Tỷ lệ sai', mode: 'allocate', fromAccounts: ['242'], ratioSource: { ratios: [{ account: '6421', percent: '60' }, { account: '6422', percent: '30' }] } },
      { stepOrder: 2, name: 'Đích sai', mode: 'transfer', fromAccounts: ['511'], toAccount: '99999' },
      { stepOrder: 3, name: 'Đích tổng hợp', mode: 'transfer', fromAccounts: ['511'], toAccount: '421' }] });
    expect(put.statusCode, put.body).toBe(200);
    const [a, b, c] = await (async () => (await call('GET', '/api/closing/steps')).json() as { id: string }[])();
    const run = (stepId: string, postingDate: string) => call('POST', '/api/closing/run', { stepId, postingDate });
    const code = async (stepId: string, date: string) => { const r = await run(stepId, date); return [r.statusCode, r.json().error?.code]; };
    expect(await code('00000000-0000-4000-8000-000000000000', '2026-12-31')).toEqual([404, 'CLOSING_STEP_NOT_FOUND']);
    expect(await code(a!.id, '2026-12-31')).toEqual([409, 'CLOSING_RATIO_INVALID']);
    expect(await code(b!.id, '2026-12-31')).toEqual([409, 'CLOSING_TO_ACCOUNT_INVALID']);
    expect(await code(c!.id, '2026-12-31')).toEqual([409, 'CLOSING_TO_ACCOUNT_INVALID']);
    expect(await code(b!.id, '2030-12-31')).toEqual([404, 'PERIOD_NOT_FOUND']);
    expect((await run(b!.id, '31/12/2026')).statusCode).toBe(400);
  }, 30_000);
});

describe('kết chuyển: sơ đồ riêng theo chế độ', () => {
  it('năm TT99 tạo sau không phá sơ đồ TT200: kết chuyển năm TT200 vẫn chạy; sai chế độ thì 409; nạp lại TT99 không đụng TT200', async () => {
    const { call } = await newTenant('KCCHEDO', [[2025, 'TT200'], [2026, 'TT99']]);
    const list = async (q: string) => (await call('GET', `/api/closing/steps?${q}`)).json() as { id: string; regime: string; toAccount: string }[];
    const t200 = await list('regime=TT200'); const t99 = await list('date=2026-06-30');
    expect(t200.map((s) => s.toAccount)).toEqual(['5111', '911', '911', '4212', '4211']);
    expect(t99.length).toBeGreaterThan(0); expect(new Set(t99.map((s) => s.regime))).toEqual(new Set(['TT99']));
    expect(t99.map((s) => s.id).filter((i) => t200.some((s) => s.id === i))).toEqual([]);

    await post(call, '2025-03-05', [{ accountCode: '1121', debit: '1000' }, { accountCode: '5113', credit: '1000' }]);
    await post(call, '2025-04-05', [{ accountCode: '6421', debit: '300' }, { accountCode: '1121', credit: '300' }]);
    const all = await call('POST', '/api/closing/run-all', { postingDate: '2025-12-31' });
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json().steps).toHaveLength(4);

    const bad = await call('POST', '/api/closing/run', { stepId: t99[0]!.id, postingDate: '2025-12-31' });
    expect([bad.statusCode, bad.json().error.code]).toEqual([409, 'CLOSING_STEP_REGIME_MISMATCH']);
    expect(bad.json().error.message).toContain('TT99');

    const reload = await call('POST', '/api/closing/steps/reload', { regime: 'TT99' });
    expect(reload.statusCode, reload.body).toBe(200);
    expect((await list('regime=TT200')).map((s) => s.id)).toEqual(t200.map((s) => s.id));
    expect((await list('regime=TT99')).map((s) => s.id)).not.toEqual(t99.map((s) => s.id));
  }, 30_000);
});
