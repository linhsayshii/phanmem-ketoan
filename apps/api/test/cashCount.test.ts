import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

const L = (accountCode: string, debit = '0', credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
const voucher = (voucherType: string, date: string, lines: object[], more: object = {}) => ({ voucherType, postingDate: date, documentDate: date, description: `Thử ${voucherType}`, lines, ...more });
// Mệnh giá: 500.000 x 1 + 200.000 x 2 + 50.000 x 1 = 950.000
const D950 = [{ value: '500000', qty: 1 }, { value: '200000', qty: 2 }, { value: '50000', qty: 1 }];
const D1100 = [{ value: '500000', qty: 2 }, { value: '100000', qty: 1 }];

// Mỗi nhóm kiểm thử một công ty riêng; quỹ 1111 có sẵn 1.000.000 ngày 10/01/2026.
async function tenant(regime: 'TT133' | 'TT99' = 'TT133') {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `KK${Date.now()}${n++}`, regime);
  const cash = regime === 'TT99' ? '111' : '1111';
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const post = async (body: object) => { const r = await call('POST', '/api/vouchers', { ...body, autoPost: true }); expect(r.statusCode, r.body).toBe(201); return r.json(); };
  await post(voucher('PT', '2026-01-10', [L(cash, '1000000'), L(regime === 'TT99' ? '511' : '5113', '0', '1000000')]));
  const count = async (body: object = {}) => call('POST', '/api/cash-counts', { countDate: '2026-01-31', accountCode: cash, currency: 'VND', denominations: D950, members: [{ name: 'Nguyễn Văn A', role: 'Thủ quỹ' }], note: 'Kiểm kê cuối tháng', ...body });
  const created = async (body: object = {}) => { const r = await count(body); expect(r.statusCode, r.body).toBe(201); return r.json(); };
  return { cookie, tenantId, cash, call, post, count, created };
}

describe('kiểm kê quỹ', () => {
  it('lập kiểm kê: tổng tiền thực tế = tổng số lượng x mệnh giá, chênh lệch = thực tế - sổ; ghi nhật ký kiểm toán', async () => {
    const t = await tenant();
    const c = await t.created();
    expect(c).toMatchObject({ countDate: '2026-01-31', accountCode: t.cash, currency: 'VND', bookBalance: '1000000', countedTotal: '950000', difference: '-50000', voucherId: null, note: 'Kiểm kê cuối tháng' });
    expect(c.denominations).toEqual(D950);
    expect(c.members).toEqual([{ name: 'Nguyễn Văn A', role: 'Thủ quỹ' }]);
    const g = await t.call('GET', `/api/cash-counts/${c.id}`);
    expect(g.statusCode, g.body).toBe(200); expect(g.json()).toMatchObject({ id: c.id, countedTotal: '950000', difference: '-50000' });

    const surplus = await t.created({ denominations: D1100 });
    expect(surplus).toMatchObject({ countedTotal: '1100000', difference: '100000', bookBalance: '1000000' });
    // số dư sổ lấy tại ngày kiểm kê: trước ngày phiếu thu quỹ chưa có tiền
    const early = await t.created({ countDate: '2026-01-05', denominations: [] });
    expect(early).toMatchObject({ bookBalance: '0', countedTotal: '0', difference: '0' });

    const list = (await t.call('GET', '/api/cash-counts')).json();
    expect(list.map((x: { id: string }) => x.id).sort()).toEqual([c.id, surplus.id, early.id].sort());
    const audit = await sql<{ n: string }>`SELECT count(*)::text AS n FROM audit_event WHERE tenant_id = ${t.tenantId}::uuid AND entity = 'cash_count' AND action = 'insert'`.execute(ctx.t.admin);
    expect(audit.rows[0]!.n).toBe('3');
  }, 60_000);

  it('đầu vào sai: tài khoản không phải quỹ, mệnh giá hoặc số lượng sai, loại tiền không theo dõi ngoại tệ', async () => {
    const t = await tenant();
    const code = async (body: object) => { const r = await t.count(body); return [r.statusCode, r.json().error?.code] as const; };
    expect(await code({ accountCode: '5113' })).toEqual([400, 'CASH_COUNT_ACCOUNT_INVALID']);
    expect(await code({ accountCode: '1121' })).toEqual([400, 'CASH_COUNT_ACCOUNT_INVALID']);
    expect(await code({ accountCode: '111' })).toEqual([400, 'CASH_COUNT_ACCOUNT_INVALID']); // TT133: 111 là tài khoản tổng hợp
    expect((await t.count({ accountCode: '9999' })).statusCode).toBe(404);
    expect((await t.count({ denominations: [{ value: '500.000', qty: 1 }] })).statusCode).toBe(400);
    expect((await t.count({ denominations: [{ value: '500000', qty: -1 }] })).statusCode).toBe(400);
    expect((await t.count({ denominations: [{ value: '500000', qty: 1.5 }] })).statusCode).toBe(400);
    expect((await t.count({ countDate: '2026-13-01' })).statusCode).toBe(400);
    expect(await code({ currency: 'USD' })).toEqual([400, 'CASH_COUNT_ACCOUNT_INVALID']); // 1111 là quỹ tiền Việt Nam, không theo dõi ngoại tệ
  }, 60_000);

  it('xử lý thiếu 50.000: sinh Phiếu chi nháp Nợ 1381 / Có 1111, ghi nguồn kiểm kê; xử lý lần hai 409', async () => {
    const t = await tenant();
    const c = await t.created();
    const r = await t.call('POST', `/api/cash-counts/${c.id}/settle`, {});
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json();
    expect(s.voucherId).toEqual(expect.any(String));
    const v = (await t.call('GET', `/api/vouchers/${s.voucherId}`)).json();
    expect(v).toMatchObject({ voucherType: 'PC', state: 'draft', postingDate: '2026-01-31', currencyCode: 'VND', sourceDocType: 'cash_count' });
    expect(v.sourceDocId).toEqual(expect.any(String));
    expect(v.lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit]).sort())
      .toEqual([['1111', '0', '50000'], ['1381', '50000', '0']]);
    // kiểm kê đã lưu mã chứng từ xử lý
    expect((await t.call('GET', `/api/cash-counts/${c.id}`)).json().voucherId).toBe(s.voucherId);

    const again = await t.call('POST', `/api/cash-counts/${c.id}/settle`, {});
    expect(again.statusCode).toBe(409); expect(again.json().error.code).toBe('CASH_COUNT_SETTLED');
    // đã xử lý thì không xóa kiểm kê
    const del = await t.call('DELETE', `/api/cash-counts/${c.id}`);
    expect(del.statusCode).toBe(409); expect(del.json().error.code).toBe('CASH_COUNT_SETTLED');

    // chứng từ xử lý vẫn là chứng từ thường: ghi sổ được qua luồng chứng từ
    const posted = await t.call('POST', `/api/vouchers/${s.voucherId}/post`);
    expect(posted.statusCode, posted.body).toBe(200); expect(posted.json().state).toBe('posted');
  }, 60_000);

  it('xử lý thừa 100.000: Phiếu thu nháp Nợ 1111 / Có 3381; tài khoản đối ứng tự chọn; chênh lệch 0 hoặc tài khoản sai bị từ chối', async () => {
    const t = await tenant();
    const c = await t.created({ denominations: D1100 });
    const s = (await t.call('POST', `/api/cash-counts/${c.id}/settle`, {})).json();
    const v = (await t.call('GET', `/api/vouchers/${s.voucherId}`)).json();
    expect(v).toMatchObject({ voucherType: 'PT', state: 'draft', sourceDocType: 'cash_count' });
    expect(v.lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit]).sort())
      .toEqual([['1111', '100000', '0'], ['3381', '0', '100000']]);

    // đối ứng tự chọn: thiếu ghi vào 1388 thay vì 1381
    const c2 = await t.created();
    const s2 = (await t.call('POST', `/api/cash-counts/${c2.id}/settle`, { accountCode: '1388' })).json();
    const v2 = (await t.call('GET', `/api/vouchers/${s2.voucherId}`)).json();
    expect(v2.lines.map((l: { accountCode: string }) => l.accountCode).sort()).toEqual(['1111', '1388']);

    const zero = await t.created({ denominations: [{ value: '500000', qty: 2 }] });
    const z = await t.call('POST', `/api/cash-counts/${zero.id}/settle`, {});
    expect(z.statusCode).toBe(400); expect(z.json().error.code).toBe('CASH_COUNT_NO_DIFFERENCE');

    const c3 = await t.created();
    for (const accountCode of ['9999', '111']) { // không có trong hệ thống tài khoản; 111 là tài khoản tổng hợp (TT133)
      const bad = await t.call('POST', `/api/cash-counts/${c3.id}/settle`, { accountCode });
      expect(bad.statusCode, bad.body).toBe(400); expect(bad.json().error.code).toBe('CASH_COUNT_COUNTER_ACCOUNT_INVALID');
    }
    expect((await t.call('GET', `/api/cash-counts/${c3.id}`)).json().voucherId).toBeNull(); // xử lý lỗi không để lại chứng từ
  }, 60_000);

  it('quỹ ngoại tệ: kiểm kê theo nguyên tệ, xử lý cần tỷ giá', async () => {
    const t = await tenant();
    await t.post(voucher('PT', '2026-01-12', [L('1112', '25400000', '0', { amountCurrency: '1000' }), L('131', '0', '25400000', { amountCurrency: '-1000', partyCode: 'KH001' })],
      { currencyCode: 'USD', fxRate: '25400', partyCode: 'KH001' }));
    const c = await t.created({ accountCode: '1112', currency: 'USD', denominations: [{ value: '100', qty: 9 }, { value: '50', qty: 1 }, { value: '0.5', qty: 1 }] });
    expect(c).toMatchObject({ currency: 'USD', bookBalance: '25400000', bookBalanceCurrency: '1000.0000', countedTotal: '950.5000', difference: '-49.5000' });

    const noRate = await t.call('POST', `/api/cash-counts/${c.id}/settle`, {});
    expect(noRate.statusCode).toBe(400); expect(noRate.json().error.code).toBe('FX_RATE_REQUIRED');

    const s = await t.call('POST', `/api/cash-counts/${c.id}/settle`, { fxRate: '25500' });
    expect(s.statusCode, s.body).toBe(201);
    const v = (await t.call('GET', `/api/vouchers/${s.json().voucherId}`)).json();
    expect(v).toMatchObject({ voucherType: 'PC', state: 'draft', currencyCode: 'USD', fxRate: '25500.0000000000', sourceDocType: 'cash_count' });
    // 49,5 USD x 25.500 = 1.262.250 đồng
    expect(v.lines.map((l: { accountCode: string; debit: string; credit: string; amountCurrency: string }) => [l.accountCode, l.debit, l.credit, l.amountCurrency]).sort())
      .toEqual([['1112', '0', '1262250', '-49.5000'], ['1381', '1262250', '0', '49.5000']]);
  }, 60_000);

  it('kiểm kê của công ty khác không thấy: 404 khi xem, xử lý, in, xóa', async () => {
    const a = await tenant(); const b = await tenant();
    const c = await a.created();
    for (const [method, url] of [['GET', `/api/cash-counts/${c.id}`], ['POST', `/api/cash-counts/${c.id}/settle`], ['GET', `/api/cash-counts/${c.id}/print`], ['DELETE', `/api/cash-counts/${c.id}`]] as const) {
      const r = await b.call(method, url, method === 'POST' ? {} : undefined);
      expect(r.statusCode, `${method} ${url}`).toBe(404); expect(r.json().error.code).toBe('CASH_COUNT_NOT_FOUND');
    }
    expect((await b.call('GET', '/api/cash-counts')).json()).toEqual([]);
    expect((await a.call('GET', '/api/cash-counts')).json()).toHaveLength(1);
  }, 60_000);

  it('xóa kiểm kê chưa xử lý; bảng kiểm kê in HTML theo mẫu 08a - TT (TT133 và TT99) và PDF', async () => {
    const t = await tenant();
    const c = await t.created();
    const html = await t.call('GET', `/api/cash-counts/${c.id}/print`);
    expect(html.statusCode, html.body).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    for (const s of ['BẢNG KIỂM KÊ QUỸ', 'Mẫu số 08a - TT', 'Số dư theo sổ quỹ', 'Số kiểm kê thực tế', 'Chênh lệch', 'Nguyễn Văn A', '500.000', '950.000', '1.000.000', 'Thiếu', 'Người chịu trách nhiệm kiểm kê quỹ']) expect(html.body, s).toContain(s);
    const pdf = await t.call('GET', `/api/cash-counts/${c.id}/print?format=pdf`);
    expect(pdf.statusCode).toBe(200); expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

    const del = await t.call('DELETE', `/api/cash-counts/${c.id}`);
    expect(del.statusCode, del.body).toBe(204);
    expect((await t.call('GET', `/api/cash-counts/${c.id}`)).statusCode).toBe(404);

    const t99 = await tenant('TT99');
    const c99 = await t99.created();
    expect(c99).toMatchObject({ accountCode: '111', countedTotal: '950000', difference: '-50000' });
    const p99 = await t99.call('GET', `/api/cash-counts/${c99.id}/print`);
    expect(p99.statusCode, p99.body).toBe(200); expect(p99.body).toContain('Mẫu số 08a - TT');
    // TT99: xử lý thiếu ghi Nợ 1381 / Có 111
    const s99 = (await t99.call('POST', `/api/cash-counts/${c99.id}/settle`, {})).json();
    const v99 = (await t99.call('GET', `/api/vouchers/${s99.voucherId}`)).json();
    expect(v99.lines.map((l: { accountCode: string; debit: string }) => [l.accountCode, l.debit]).sort()).toEqual([['111', '0'], ['1381', '50000']]);
  }, 120_000);

  it('quỹ ngoại tệ in theo mẫu 08b - TT', async () => {
    const t = await tenant();
    await t.post(voucher('PT', '2026-01-12', [L('1112', '25400000', '0', { amountCurrency: '1000' }), L('131', '0', '25400000', { amountCurrency: '-1000', partyCode: 'KH001' })],
      { currencyCode: 'USD', fxRate: '25400', partyCode: 'KH001' }));
    const c = await t.created({ accountCode: '1112', currency: 'USD', denominations: [{ value: '100', qty: 10 }] });
    const html = await t.call('GET', `/api/cash-counts/${c.id}/print`);
    expect(html.statusCode, html.body).toBe(200);
    for (const s of ['BẢNG KIỂM KÊ QUỸ', 'Mẫu số 08b - TT', 'USD', 'Đơn giá', 'Tính ra VNĐ']) expect(html.body, s).toContain(s);
  }, 60_000);
  it('xóa chứng từ xử lý nháp thì kiểm kê xử lý lại được; TT200 chưa có văn bản gốc nên bảng kiểm kê in không có Mẫu số', async () => {
    const t = await tenant();
    const c = await t.created();
    const s = (await t.call('POST', `/api/cash-counts/${c.id}/settle`, {})).json();
    expect((await t.call('DELETE', `/api/vouchers/${s.voucherId}`)).statusCode).toBe(204);
    expect((await t.call('GET', `/api/cash-counts/${c.id}`)).json().voucherId).toBeNull();
    expect((await t.call('POST', `/api/cash-counts/${c.id}/settle`, {})).statusCode).toBe(201);

    const { cookie } = await bootstrapTenant(ctx, { code: `KK200${Date.now()}${n++}` });
    const fy = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT200', confirmRegimeOverride: true } });
    expect(fy.statusCode, fy.body).toBe(201);
    const k = await ctx.app.inject({ method: 'POST', url: '/api/cash-counts', headers: { cookie }, payload: { countDate: '2026-01-05', accountCode: '1111', denominations: [{ value: '100000', qty: 3 }] } });
    expect(k.statusCode, k.body).toBe(201);
    const html = await ctx.app.inject({ method: 'GET', url: `/api/cash-counts/${k.json().id}/print`, headers: { cookie } });
    expect(html.statusCode, html.body).toBe(200); expect(html.body).toContain('BẢNG KIỂM KÊ QUỸ'); expect(html.body).not.toContain('Mẫu số');
  }, 60_000);
});
