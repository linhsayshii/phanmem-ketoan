import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import FormData from 'form-data';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); };
const R = (accountCode: string, debit = '0', credit = '0') => ({ accountCode, partyCode: null, currencyCode: 'VND', debit, credit, debitCurrency: '0', creditCurrency: '0' });
const S = (warehouseCode: string, itemCode: string, quantity: string, value: string, more: object = {}) => ({ warehouseCode, itemCode, quantity, value, ...more });
const putStock = (rows: object[]) => call('PUT', '/api/opening-stock/2026', { rows });
const putBal = (rows: object[]) => call('PUT', '/api/opening-balance/2026', { rows });
const codes = async () => ((await call('GET', '/api/opening-balance/2026/check')).json() as { code: string; message: string; accountCode?: string }[]);

async function sheet() {
  const tpl = await call('GET', '/api/opening-stock/template.xlsx');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(tpl.rawPayload as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Du_lieu')!; ws.spliceRows(3, 1);
  return { wb, ws };
}
async function upload(wb: ExcelJS.Workbook, mode: string) {
  const fd = new FormData(); fd.append('file', Buffer.from(await wb.xlsx.writeBuffer()), { filename: 'ton.xlsx' });
  return ctx.app.inject({ method: 'POST', url: `/api/opening-stock/2026/import?mode=${mode}`, headers: { cookie, ...fd.getHeaders() }, payload: fd.getBuffer() });
}

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `OS${Date.now()}` }));
  expect((await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' })).statusCode).toBe(201);
  await call('POST', '/api/catalogs/uom', { code: 'CAI', name: 'Cái' }); await call('POST', '/api/catalogs/uom', { code: 'HOP', name: 'Hộp' });
  await cat('item', { code: 'SP1', name: 'Hàng một', base_uom_code: 'CAI', kind: 'goods' });
  await cat('item', { code: 'SP2', name: 'Hàng hai', base_uom_code: 'CAI', kind: 'goods' });
  await cat('item', { code: 'LO1', name: 'Hàng theo lô', base_uom_code: 'CAI', kind: 'goods', tracking: 'lot_expiry' });
  await cat('item_uom', { item_code: 'SP2', uom_code: 'HOP', factor: '10' });
  await cat('warehouse', { code: 'K1', name: 'Kho chính', inventory_account_code: '156', costing_method: 'avg_period' });
  await cat('warehouse', { code: 'K2', name: 'Kho hai', inventory_account_code: '156', costing_method: 'avg_period' });
}, 60_000);
afterAll(async () => { await ctx.close(); });

describe('tồn kho đầu kỳ', () => {
  it('số dư đầu kỳ 156 = 1.600.000 phải khớp tổng tồn đầu kỳ các kho; lệch → OPENING_STOCK_MISMATCH', async () => {
    expect((await putBal([R('156', '1600000'), R('4111', '0', '1600000')])).statusCode).toBe(200);
    // 100 SP1 = 1.000.000 (K1) + 5 HOP SP2 (= 50 CAI) = 500.000 (K2): tổng 1.500.000
    expect((await putStock([S('K1', 'SP1', '100', '1000000'), S('K2', 'SP2', '5', '500000', { uomCode: 'HOP' })])).statusCode).toBe(200);
    const g = (await call('GET', '/api/opening-stock/2026')).json() as { itemCode: string; quantity: string; value: string }[];
    expect(g.map((x) => `${x.itemCode}:${x.quantity}`)).toEqual(['SP1:100.0000', 'SP2:50.0000']);
    const issue = (await codes()).find((i) => i.code === 'OPENING_STOCK_MISMATCH')!;
    expect(issue.accountCode).toBe('156'); expect(issue.message).toContain('100.000');
    const p = await call('POST', '/api/opening-balance/2026/post');
    expect(p.statusCode).toBe(409); expect(p.json().error.code).toBe('OPENING_INVALID');
    // khớp lại
    await putBal([R('156', '1500000'), R('4111', '0', '1500000')]);
    expect((await codes()).filter((i) => i.code === 'OPENING_STOCK_MISMATCH')).toEqual([]);
  });

  it('ghi sổ DK sinh stock_move in ngày đầu năm và lớp giá; sổ cái 156 mang item_id/warehouse_id', async () => {
    const p = await call('POST', '/api/opening-balance/2026/post');
    expect(p.statusCode, p.body).toBe(200);
    const id = p.json().id as string;
    const moves = (await sql<{ code: string; wh: string; direction: string; quantity: string; posting_date: string; value: string; kind: string }>`
      SELECT i.code, w.code AS wh, m.direction, m.quantity::text, m.posting_date::text, l.value::text, l.kind
      FROM stock_move m JOIN item i ON i.id = m.item_id JOIN warehouse w ON w.id = m.warehouse_id JOIN stock_cost_layer l ON l.move_id = m.id
      WHERE m.voucher_id = ${id}::uuid ORDER BY i.code`.execute(ctx.t.admin)).rows;
    expect(moves.map((m) => `${m.code}|${m.wh}|${m.direction}|${m.quantity}|${m.value}|${m.kind}`)).toEqual(['SP1|K1|in|100.0000|1000000|receipt', 'SP2|K2|in|50.0000|500000|receipt']);
    expect(moves[0]!.posting_date).toBe('2025-12-31'); // kỳ 0 (số dư đầu kỳ) kết thúc ngay trước ngày đầu năm
    const ledger = (await sql<{ code: string; item: string; wh: string; debit: string }>`
      SELECT a.code, i.code AS item, w.code AS wh, l.debit::text FROM voucher_line l JOIN account a ON a.id = l.account_id JOIN item i ON i.id = l.item_id JOIN warehouse w ON w.id = l.warehouse_id
      WHERE l.voucher_id = ${id}::uuid ORDER BY i.code`.execute(ctx.t.admin)).rows;
    expect(ledger).toEqual([{ code: '156', item: 'SP1', wh: 'K1', debit: '1000000' }, { code: '156', item: 'SP2', wh: 'K2', debit: '500000' }]);
    // ghi sổ lại (sửa tồn) cập nhật phát sinh, không nhân đôi
    await putStock([S('K1', 'SP1', '100', '1000000'), S('K2', 'SP2', '5', '500000', { uomCode: 'HOP' })]);
    expect((await call('POST', '/api/opening-balance/2026/post')).statusCode).toBe(200);
    expect(Number((await sql<{ n: string }>`SELECT count(*) AS n FROM stock_move WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.n)).toBe(2);
  });

  it('xuất sau đó dùng được tồn đầu kỳ, giá vốn bình quân kỳ đúng; bỏ ghi sổ DK khi đã xuất → STOCK_CONSUMED', async () => {
    const x = await call('POST', '/api/stock-vouchers', { voucherType: 'PXK', stockKind: 'sale', postingDate: '2026-01-10', warehouseCode: 'K1', items: [{ itemCode: 'SP1', uomCode: 'CAI', quantity: '40' }] });
    expect(x.statusCode, x.body).toBe(201);
    expect((await call('POST', `/api/vouchers/${x.json().id}/post`, {})).statusCode).toBe(200);
    const r = await call('POST', '/api/inventory/costing-runs', { periodFrom: '2026-01-01', periodTo: '2026-01-31' });
    expect(r.statusCode, r.body).toBe(200);
    const cost = (await sql<{ s: string }>`SELECT sum(a.amount)::text AS s FROM stock_cost_assignment a JOIN stock_move m ON m.id = a.move_id WHERE a.is_current AND m.direction = 'out' AND m.tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.s;
    expect(cost).toBe('400000');
    const u = await call('POST', '/api/opening-balance/2026/unpost');
    expect(u.statusCode, u.body).toBe(409); expect(u.json().error.code).toBe('STOCK_CONSUMED');
  });

  it('nhập Excel tồn đầu theo lô: dòng sai báo dòng/cột, không chèn gì; dòng đúng nhập được', async () => {
    const { wb, ws } = await sheet();
    ws.addRow(['K1', 'LO1', '', 10, 100000, 'L01', new Date(Date.UTC(2027, 5, 30))]); // dòng 3: đúng
    ws.addRow(['K9', 'SP1', '', 1, 1, '', '']); // dòng 4: kho không có
    ws.addRow(['K1', 'LO1', '', 5, 1, '', '']); // dòng 5: thiếu lô
    ws.addRow(['K1', 'SP1', 'HOP', 1, 1, '', '']); // dòng 6: ĐVT không thuộc hàng
    ws.addRow(['K1', 'SP1', '', 'abc', 1, '', '']); // dòng 7: số lượng sai
    const before = (await call('GET', '/api/opening-stock/2026')).json() as unknown[];
    for (const mode of ['validate', 'commit']) {
      const r = await upload(wb, mode); expect(r.statusCode, r.body).toBe(200);
      const j = r.json() as { inserted: number; errors: { row: number; column: string }[] };
      expect(j.inserted).toBe(0);
      expect(j.errors.map((e) => `${e.row}:${e.column}`)).toEqual(['4:warehouse_code', '5:lot_no', '6:uom_code', '7:quantity']);
    }
    expect(((await call('GET', '/api/opening-stock/2026')).json() as unknown[]).length).toBe(before.length);
    const fresh = await sheet();
    fresh.ws.addRow(['K1', 'LO1', '', 10, 100000, 'L01', new Date(Date.UTC(2027, 5, 30))]);
    const ok = (await upload(fresh.wb, 'commit')).json() as { inserted: number; errors: unknown[] };
    expect(ok.errors).toEqual([]); expect(ok.inserted).toBe(1);
    const g = (await call('GET', '/api/opening-stock/2026')).json() as { itemCode: string; lotNo: string; expiryDate: string }[];
    expect(g).toEqual([expect.objectContaining({ itemCode: 'LO1', lotNo: 'L01', expiryDate: '2027-06-30' })]);
  });

  it('thiếu lô / thiếu hạn dùng / trùng khóa bị từ chối 400', async () => {
    const a = await putStock([S('K1', 'LO1', '1', '1')]); expect(a.statusCode).toBe(400);
    const b = await putStock([S('K1', 'LO1', '1', '1', { lotNo: 'A' })]); expect(b.statusCode).toBe(400); expect(b.json().error.message).toContain('hạn dùng');
    const c = await putStock([S('K1', 'SP1', '1', '1'), S('K1', 'SP1', '2', '2')]); expect(c.statusCode).toBe(400);
    expect((await putStock([S('K1', 'SP1', '1', '1.5')])).statusCode).toBe(400);
  });

  it('tài khoản TSCĐ (211) vẫn bị khóa SUBLEDGER_MODULE_REQUIRED', async () => {
    await putStock([]); await putBal([R('2111', '100'), R('4111', '0', '100')]);
    expect((await codes()).map((i) => i.code)).toContain('SUBLEDGER_MODULE_REQUIRED');
    expect((await codes()).map((i) => i.code)).not.toContain('OPENING_STOCK_MISMATCH');
  });

  it('thiếu view_cost: giá trị tồn đầu kỳ và số dư tài khoản kho trả 403', async () => {
    await putBal([R('156', '1000'), R('4111', '0', '1000')]); await putStock([S('K1', 'SP1', '1', '1000')]);
    const mk = async (flags: string[]) => {
      const username = `os_${flags.length}_${Date.now()}`;
      const made = await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_truong', sensitiveFlags: flags });
      expect(made.statusCode, made.body).toBe(201);
      const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
      return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    };
    const none = await mk([]); const cost = await mk(['view_cost']);
    expect((await call('PUT', '/api/opening-stock/2026', { rows: [S('K1', 'SP1', '1', '1000')] }, none)).statusCode).toBe(403);
    expect((await call('GET', '/api/opening-balance/2026', undefined, none)).statusCode).toBe(403);
    const g = await call('GET', '/api/opening-stock/2026', undefined, none);
    expect(g.statusCode).toBe(200); expect((g.json() as { value: string | null }[])[0]!.value).toBeNull();
    expect((await call('GET', '/api/opening-stock/2026', undefined, cost)).json()[0].value).toBe('1000');
  });
});
