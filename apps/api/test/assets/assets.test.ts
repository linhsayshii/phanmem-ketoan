import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];

// Mỗi kiểm thử một công ty: năm 2026 TT133, đối tượng KH001, KH002, NCC001.
async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `TS${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const asset = async (body: object) => { const r = await call('POST', '/api/assets', body); expect(r.statusCode, r.body).toBe(201); return r.json() as { id: number }; };
  const fixed = (code: string, more: object = {}) => asset({ code, name: `TSCĐ ${code}`, kind: 'fixed', assetAccountCode: '2111', depreciationAccountCode: '2141', ...more });
  const pkt = (lines: object[]) => call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-03-10', documentDate: '2026-03-10', description: 'mua tài sản', autoPost: true, lines });
  const assetIdsOf = async (voucherId: string, accountCode: string) => (await sql<{ asset_id: string | null }>`SELECT l.asset_id::text FROM voucher_line l JOIN account a ON a.id = l.account_id
    WHERE l.voucher_id = ${voucherId}::uuid AND a.code = ${accountCode} ORDER BY l.line_no`.execute(ctx.t.admin)).rows.map((r) => r.asset_id);
  return { cookie, tenantId, call, asset, fixed, pkt, assetIdsOf };
}
const nợ = (account: string, debit: string, more: object = {}) => ({ accountCode: account, debit, credit: '0', ...more });
const có = (account: string, credit: string, more: object = {}) => ({ accountCode: account, debit: '0', credit, ...more });

describe('thẻ tài sản, phân bổ chi phí', () => {
  it('tạo thẻ TSCĐ 2111/2141, phân bổ 6422 60% + 6421 40%; tổng 90% → ALLOCATION_RATIO', async () => {
    const t = await tenant();
    const a = await t.fixed('TS01', { lifeUnits: 60 });
    const bad = await t.call('PUT', `/api/assets/${a.id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', ratio: '60' }, { expenseAccountCode: '6421', ratio: '30' }] });
    expect(err(bad)).toEqual([400, 'ALLOCATION_RATIO']);
    const ok = await t.call('PUT', `/api/assets/${a.id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', ratio: '60' }, { expenseAccountCode: '6421', ratio: '40' }] });
    expect(ok.statusCode, ok.body).toBe(200);
    const list = await t.call('GET', '/api/assets?kind=fixed');
    expect(list.json()[0].allocations).toMatchObject([{ expenseAccountCode: '6422', ratio: '60.000000' }, { expenseAccountCode: '6421', ratio: '40.000000' }]);
    const look = await t.call('GET', '/api/lookups/assets?q=ts0');
    expect(look.json()).toEqual([{ id: a.id, code: 'TS01', name: 'TSCĐ TS01', kind: 'fixed', assetAccountCode: '2111' }]);
    expect(err(await t.call('POST', '/api/assets', { code: 'X', name: 'X', kind: 'fixed', assetAccountCode: '6422', depreciationAccountCode: '2141' }))).toEqual([400, 'ASSET_ACCOUNT_INVALID']);
  });

  it('PKT Nợ 2111 assetCode TS01 / Có 331 ghi sổ; dòng 2111 thiếu assetCode → LINE_ASSET_REQUIRED', async () => {
    const t = await tenant(); await t.fixed('TS01');
    const ok = await t.pkt([nợ('2111', '50000000', { assetCode: 'TS01' }), có('331', '50000000', { partyCode: 'NCC001' })]);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().lines[0].assetCode).toBe('TS01');
    expect(await t.assetIdsOf(ok.json().id, '2111')).toHaveLength(1);
    const miss = await t.pkt([nợ('2111', '1000000'), có('331', '1000000', { partyCode: 'NCC001' })]);
    expect(err(miss)).toEqual([409, 'LINE_ASSET_REQUIRED']);
    expect(err(await t.pkt([nợ('2111', '1000000', { assetCode: 'KHONGCO' }), có('331', '1000000', { partyCode: 'NCC001' })]))).toEqual([404, 'ASSET_NOT_FOUND']);
  });

  it('Nợ 2112 với thẻ có TK 2111 → ASSET_ACCOUNT_MISMATCH', async () => {
    const t = await tenant(); await t.fixed('TS01');
    const r = await t.pkt([nợ('2112', '1000000', { assetCode: 'TS01' }), có('331', '1000000', { partyCode: 'NCC001' })]);
    expect(err(r)).toEqual([400, 'ASSET_ACCOUNT_MISMATCH']);
  });

  it('HDM dòng 2111 assetCode TS02 + thuế 10%: Nợ 2111 mang asset_id, 1331 không', async () => {
    const t = await tenant(); await t.fixed('TS02');
    const r = await t.call('POST', '/api/invoices', { voucherType: 'HDM', postingDate: '2026-03-10', documentDate: '2026-03-10', partyCode: 'NCC001', autoPost: true,
      items: [{ description: 'Máy', accountCode: '2111', amountCurrency: '20000000', taxCodes: ['V10'], assetCode: 'TS02' }],
      invoice: { serial: 'C26TAA', invoiceNo: '0000009', invoiceDate: '2026-03-10', invoiceGroupCode: '01' } });
    expect(r.statusCode, r.body).toBe(201);
    expect((await t.assetIdsOf(r.json().id, '2111')).every((x) => x !== null)).toBe(true);
    expect(await t.assetIdsOf(r.json().id, '1331')).toEqual([null]);
    expect(r.json().items[0].assetCode).toBe('TS02');
  });

  it('xóa thẻ đã có bút toán → ASSET_IN_USE; đổi TK tài sản → ASSET_ACCOUNT_LOCKED; thẻ chưa dùng xóa được', async () => {
    const t = await tenant(); const a = await t.fixed('TS01'); const free = await t.fixed('TS09');
    expect((await t.pkt([nợ('2111', '5000000', { assetCode: 'TS01' }), có('331', '5000000', { partyCode: 'NCC001' })])).statusCode).toBe(201);
    expect(err(await t.call('DELETE', `/api/assets/${a.id}`))).toEqual([409, 'ASSET_IN_USE']);
    const put = await t.call('PUT', `/api/assets/${a.id}`, { code: 'TS01', name: 'TSCĐ TS01', kind: 'fixed', assetAccountCode: '2112', depreciationAccountCode: '2141' });
    expect(err(put)).toEqual([409, 'ASSET_ACCOUNT_LOCKED']);
    expect((await t.call('DELETE', `/api/assets/${free.id}`)).statusCode).toBe(204);
  });
});
