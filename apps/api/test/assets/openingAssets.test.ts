import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import FormData from 'form-data';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const bal = (accountCode: string, debit: string, credit = '0') => ({ accountCode, partyCode: null, currencyCode: 'VND', debit, credit, debitCurrency: '0', creditCurrency: '0' });
const card = (code: string, categoryCode: string, openingCost: string, more: object = {}) => ({ code, name: `Thẻ ${code}`, categoryCode, openingCost, openingAccumulated: '0', openingRemainingUnits: '12', ...more });

async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `DKTS${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const ok = async (r: Promise<Res>, code = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(code); return x.json(); };
  await ok(call('POST', '/api/asset-categories', { code: 'TSCD', name: 'Máy móc', kind: 'fixed', assetAccountCode: '2111', depreciationAccountCode: '2141', defaultLifeUnits: 60 }), 201);
  await ok(call('POST', '/api/asset-categories', { code: 'CC', name: 'Công cụ', kind: 'tool', assetAccountCode: '242', defaultLifeUnits: 12 }), 201);
  const putBal = (rows: object[]) => ok(call('PUT', '/api/opening-balance/2026', { rows }));
  const putCards = (rows: object[]) => call('PUT', '/api/opening-assets/2026', { rows });
  const dk = async () => { const id = (await sql<{ id: string }>`SELECT id FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'DK'`.execute(ctx.t.admin)).rows[0]!.id; return ok(call('GET', `/api/vouchers/${id}`)); };
  return { cookie, tenantId, call, ok, putBal, putCards, dk };
}
const lineKey = (l: { accountCode: string; debit: string; credit: string; assetCode?: string | null }) => `${l.accountCode}|${l.debit}|${l.credit}|${l.assetCode ?? ''}`;
const fixedCard = card('TS01', 'TSCD', '60000000', { openingAccumulated: '40000000', openingRemainingUnits: '20' });
const codesOf = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('số dư đầu kỳ tài sản', () => {
  it('TS cũ nguyên giá 60.000.000, hao mòn 40.000.000, còn 20 tháng; số dư 2111 60tr, 2141 40tr: DK có dòng theo tài sản; KH kỳ 1 = 1.000.000', async () => {
    const t = await tenant();
    await t.putBal([bal('2111', '60000000'), bal('2141', '0', '40000000'), bal('4111', '0', '20000000')]);
    expect((await t.putCards([fixedCard])).statusCode).toBe(200);
    expect(await t.ok(t.call('GET', '/api/opening-balance/2026/check'))).toEqual([]);
    await t.ok(t.call('POST', '/api/opening-balance/2026/post'));
    expect((await t.dk()).lines.map(lineKey).sort()).toEqual(['2111|60000000|0|TS01', '2141|0|40000000|TS01', '4111|0|20000000|'].sort());
    const a = (await t.ok(t.call('GET', '/api/assets?kind=fixed')))[0];
    await t.ok(t.call('PUT', `/api/assets/${a.id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', ratio: '100' }] }));
    const r = await t.ok(t.call('POST', '/api/asset-runs', { kind: 'depreciation', fiscalYear: 2026, periodNo: 1 }));
    expect(r.lines).toMatchObject([{ assetCode: 'TS01', amount: '1000000' }]);
    expect((await t.ok(t.call('GET', '/api/assets?kind=fixed')))[0]).toMatchObject({ remainingUnits: '19' });
    // DK đã ghi sổ: không thay thẻ đầu kỳ
    const again = await t.putCards([fixedCard]); expect(again.statusCode).toBe(409); expect(again.json().error.code).toBe('OPENING_POSTED');
  });

  it('số dư 2141 là 41.000.000 khác tổng thẻ → OPENING_INVALID chứa ASSET_OPENING_MISMATCH 2141', async () => {
    const t = await tenant();
    await t.putBal([bal('2111', '60000000'), bal('2141', '0', '41000000'), bal('4111', '0', '19000000')]);
    await t.putCards([fixedCard]);
    expect(await t.ok(t.call('GET', '/api/opening-balance/2026/check'))).toEqual([expect.objectContaining({ code: 'ASSET_OPENING_MISMATCH', accountCode: '2141' })]);
    const p = await t.call('POST', '/api/opening-balance/2026/post');
    expect(p.statusCode).toBe(409); expect(p.json().error.code).toBe('OPENING_INVALID');
    expect(p.json().error.details).toEqual([expect.objectContaining({ code: 'ASSET_OPENING_MISMATCH', accountCode: '2141' })]);
  });

  it('hao mòn lớn hơn nguyên giá, TSCĐ thiếu số tháng còn lại → ASSET_OPENING_INVALID; TK 2111 không thẻ vẫn bị SUBLEDGER_MODULE_REQUIRED', async () => {
    const t = await tenant();
    await t.putBal([bal('2111', '10'), bal('2141', '0', '20'), bal('4111', '0', '0')]);
    await t.putCards([card('TS01', 'TSCD', '10', { openingAccumulated: '20', openingRemainingUnits: null })]);
    expect(codesOf(await t.ok(t.call('GET', '/api/opening-balance/2026/check'))).filter((c) => c === 'ASSET_OPENING_INVALID')).toHaveLength(2);
    await t.putCards([]);
    expect(codesOf(await t.ok(t.call('GET', '/api/opening-balance/2026/check')))).toContain('SUBLEDGER_MODULE_REQUIRED');
  });

  it('242 có 10.000.000, thẻ CCDC 6.000.000: DK có dòng 242 CC01 6.000.000 và dòng 242 không tài sản 4.000.000', async () => {
    const t = await tenant();
    await t.putBal([bal('242', '10000000'), bal('4111', '0', '10000000')]);
    await t.putCards([card('CC01', 'CC', '6000000')]);
    await t.ok(t.call('POST', '/api/opening-balance/2026/post'));
    expect((await t.dk()).lines.map(lineKey).sort()).toEqual(['242|6000000|0|CC01', '242|4000000|0|', '4111|0|10000000|'].sort());
    // thẻ vượt số dư 242
    await t.ok(t.call('POST', '/api/opening-balance/2026/unpost'));
    await t.putCards([card('CC01', 'CC', '11000000')]);
    expect(await t.ok(t.call('GET', '/api/opening-balance/2026/check'))).toEqual([expect.objectContaining({ code: 'ASSET_OPENING_MISMATCH', accountCode: '242' })]);
  });

  it('thẻ đã có bút toán ngoài DK không bị thay: ASSET_IN_USE; DK nháp được thay thẻ', async () => {
    const t = await tenant();
    await t.putBal([bal('242', '10000000'), bal('4111', '0', '10000000')]);
    await t.putCards([card('CC01', 'CC', '6000000')]);
    await t.ok(t.call('POST', '/api/opening-balance/2026/post'));
    await t.ok(t.call('POST', '/api/opening-balance/2026/unpost'));
    expect((await t.putCards([card('CC02', 'CC', '5000000')])).statusCode).toBe(200); // dòng DK nháp của thẻ cũ bị xóa cùng thẻ
    await t.ok(t.call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-02-01', documentDate: '2026-02-01', description: 'x', autoPost: true,
      lines: [{ accountCode: '242', debit: '1000', credit: '0', assetCode: 'CC02' }, { accountCode: '4111', debit: '0', credit: '1000' }] }), 201);
    const r = await t.putCards([]); expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('ASSET_IN_USE');
  });

  it('nhập Excel: dòng 5 thiếu số tháng còn lại báo "Dòng 5, cột Số tháng còn lại"; hợp lệ thì thay thẻ của năm', async () => {
    const t = await tenant();
    const mk = async (rows: unknown[][]) => {
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await ctx.app.inject({ method: 'GET', url: '/api/opening-assets/template', headers: { cookie: t.cookie } })).rawPayload as unknown as ArrayBuffer);
      const ws = wb.getWorksheet('Du_lieu')!; ws.spliceRows(3, 1); for (const r of rows) ws.addRow(r); return wb;
    };
    const upload = async (wb: ExcelJS.Workbook, mode: string) => {
      const fd = new FormData(); fd.append('file', Buffer.from(await wb.xlsx.writeBuffer()), { filename: 'ts.xlsx' });
      return ctx.app.inject({ method: 'POST', url: `/api/opening-assets/2026/import?mode=${mode}`, headers: { cookie: t.cookie, ...fd.getHeaders() }, payload: fd.getBuffer() });
    };
    const bad = (await upload(await mk([['A1', 'Máy A', 'TSCD', '', '', 1000, 0, 5], ['A2', 'Máy B', 'TSCD', '', '', 1000, 0, 5], ['A4', 'Máy D', 'TSCD', '', '', 1000, 100, '']]), 'commit')).json();
    expect(bad.errors).toEqual([expect.objectContaining({ row: 5, column: 'Số tháng còn lại' })]); expect(bad.inserted).toBe(0);
    const good = (await upload(await mk([['A1', 'Máy A', 'TSCD', '', '', 1000, 100, 5], ['C1', 'Công cụ', 'CC', '', '', 500, '', 3]]), 'commit')).json();
    expect(good).toMatchObject({ inserted: 2, errorCount: 0 });
    expect((await t.ok(t.call('GET', '/api/opening-assets/2026'))).map((r: { code: string }) => r.code)).toEqual(['A1', 'C1']);
  });
});
