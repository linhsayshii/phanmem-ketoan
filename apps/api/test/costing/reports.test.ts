import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// GĐ6 Task 12: báo cáo giá thành (thẻ tính giá thành, sổ chi tiết 154, tổng hợp chi phí theo khoản mục, so sánh định mức). TT99, tháng 3/2026; số tính tay ghi trong từng ca.
// Chuỗi: mua NVL1 100 × 10.000 → xuất 60 cho SP1 (+ NVL2 20 × 2.000) → mua 40 × 15.000 → xuất 30 cho SP2 (giá tạm bình quân các lần nhập (1.000.000 + 600.000) ÷ 140 = 11.428,5714 → 342.857) → 622, 627
// → giá thành → nhập kho thành phẩm → giá vốn.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let ctx: TestApp; let owner: string;
type M = 'GET' | 'POST' | 'PUT';
const call = (method: M, url: string, payload?: object, cookie = owner) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const ok = async (method: M, url: string, payload?: object, cookie = owner) => {
  const r = await call(method, url, payload, cookie); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json();
};
const L = (accountCode: string, debit: string, credit: string, more: object = {}) => ({ accountCode, debit, credit, ...more });
const pkt = (date: string, lines: object[]) => ok('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Chi phí sản xuất', lines, autoPost: true });
const stock = async (body: object) => { const v = await ok('POST', '/api/stock-vouchers', { description: 'Phiếu kho', ...body }); return ok('POST', `/api/vouchers/${v.id}/post`, {}); };
const tagObject = async (id: string, objectCode: string) => { // gắn đối tượng cho mọi dòng 621 của phiếu xuất
  const v = await ok('GET', `/api/vouchers/${id}`);
  await ok('PUT', `/api/vouchers/${id}`, { version: v.version, lines: (v.lines as Json[]).filter((l) => l.accountCode === '621').map((l) => ({ lineNo: l.lineNo, costObjectCode: objectCode })) });
};
const R = '/api/costing/reports';
const objectId = async (code: string) => (await ok('GET', `/api/costing/objects?q=${code}`)).rows[0].id as number;
const q = '?year=2026&month=3';
const find = (rows: Json[], label: string) => rows.find((r) => String(r.label ?? r.description ?? '').trim().startsWith(label))!;
async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `gt_${Math.random().toString(36).slice(2, 8)}`;
  await ok('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}

beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner } = await bootstrapTenant(ctx, { code: `BG${Date.now()}` }));
  for (const [fiscalYear, regime] of [[2025, 'TT133'], [2026, 'TT99']] as const) await ok('POST', '/api/fiscal-years', { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime });
  for (const [name, body] of [['party', { code: 'NCC1', name: 'Nhà cung cấp', is_vendor: true }],
    ['warehouse', { code: 'K1', name: 'Kho vật tư', inventory_account_code: '152', costing_method: 'avg_moving' }], ['warehouse', { code: 'K2', name: 'Kho thành phẩm', inventory_account_code: '155', costing_method: 'avg_period' }],
    ['item', { code: 'NVL1', name: 'Gỗ tấm', base_uom_code: 'CAI', kind: 'material' }], ['item', { code: 'NVL2', name: 'Đinh vít', base_uom_code: 'CAI', kind: 'material' }],
    ['item', { code: 'TP1', name: 'Bàn gỗ', base_uom_code: 'CAI', kind: 'finished' }], ['item', { code: 'TP2', name: 'Ghế gỗ', base_uom_code: 'CAI', kind: 'finished' }]] as const) await ok('POST', `/api/catalogs/${name}`, body);
  await ok('POST', '/api/costing/objects', { code: 'SP1', name: 'Bàn gỗ', kind: 'product', itemCode: 'TP1', method: 'simple' });
  await ok('POST', '/api/costing/objects', { code: 'SP2', name: 'Ghế gỗ', kind: 'product', itemCode: 'TP2', method: 'simple' });
  // Định mức một đơn vị: bàn 6 gỗ (hao hụt 5% → 6,3) + 2 đinh; ghế 3 gỗ.
  await ok('POST', '/api/costing/norms', { itemCode: 'TP1', validFrom: '2026-01-01', lines: [{ itemCode: 'NVL1', quantity: '6', lossPercent: '5' }, { itemCode: 'NVL2', quantity: '2' }] });
  await ok('POST', '/api/costing/norms', { itemCode: 'TP2', validFrom: '2026-01-01', lines: [{ itemCode: 'NVL1', quantity: '3' }] });

  await stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-03-02', warehouseCode: 'K1', partyCode: 'NCC1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '100', unitPrice: '10000' }, { itemCode: 'NVL2', uomCode: 'CAI', quantity: '50', unitPrice: '2000' }] });
  const x1 = await stock({ voucherType: 'PXK', stockKind: 'production', postingDate: '2026-03-05', warehouseCode: 'K1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '60' }, { itemCode: 'NVL2', uomCode: 'CAI', quantity: '20' }] });
  await tagObject(x1.id, 'SP1');
  await stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-03-06', warehouseCode: 'K1', partyCode: 'NCC1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '40', unitPrice: '15000' }] });
  const x2 = await stock({ voucherType: 'PXK', stockKind: 'production', postingDate: '2026-03-07', warehouseCode: 'K1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '30' }] });
  await tagObject(x2.id, 'SP2');
  await pkt('2026-03-10', [L('622', '300000', '0', { costObjectCode: 'SP1' }), L('622', '120000', '0', { costObjectCode: 'SP2' }), L('111', '0', '420000')]);
  await pkt('2026-03-15', [L('6272', '100000', '0', { costObjectCode: 'SP1' }), L('111', '0', '100000')]);
  // Nhập kho thành phẩm: bàn 10 (giá tạm 100.000), ghế 8 (giá tạm 50.000).
  await stock({ voucherType: 'PNK', stockKind: 'finished', postingDate: '2026-03-20', warehouseCode: 'K2', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: '10', unitPrice: '100000' }, { itemCode: 'TP2', uomCode: 'CAI', quantity: '8', unitPrice: '50000' }] });
}, 180_000);
afterAll(async () => { await ctx.close(); });

describe('báo cáo giá thành TT99', () => {
  it('kỳ chưa chạy giá thành → 404; tham số sai → 400', async () => {
    for (const k of ['card', 'norm-compare']) expect((await call('GET', `${R}/${k}${q}`)).statusCode).toBe(404);
    expect((await call('GET', `${R}/expense-summary?year=2026&month=4&toMonth=3`)).statusCode).toBe(400);
    expect((await call('GET', `${R}/card?year=2026&month=13`)).statusCode).toBe(400);
  });

  it('thẻ tính giá thành khớp cost_run_object, GT; dở dang cuối so với sổ cái chỉ tham khảo (trước giá vốn)', async () => {
    const run = await ok('POST', '/api/costing/runs', { year: 2026, month: 3, params: {} });
    // SP1: 640.000 + 300.000 + 100.000 = 1.040.000 ÷ 10 = 104.000; SP2: 342.857 + 120.000 = 462.857 ÷ 8 = 57.857,125.
    const card = await ok('GET', `${R}/card${q}`);
    expect(card).toMatchObject({ stale: false, status: 'posted', voucherNo: run.voucherNo });
    for (const o of run.objects as Json[]) {
      const sec = (card.rows as Json[]).findIndex((r) => String(r.label).startsWith(`${o.code} — `));
      const sum = (card.rows as Json[]).slice(sec).find((r) => r.label === 'Cộng')!;
      expect(sum).toMatchObject({ qty: o.completedQty, opening: '0', incurred: o.total, closing: '0', cost: o.total, unitCost: o.unitCost });
    }
    expect(card.footer).toMatchObject({ opening: '0', incurred: '1502857', closing: '0', cost: '1502857' });
    const sp1 = (card.rows as Json[]).slice((card.rows as Json[]).findIndex((r) => String(r.label).startsWith('SP1 — ')));
    expect(sp1.slice(1, 4)).toMatchObject([{ label: 'Chi phí nguyên vật liệu trực tiếp', incurred: '640000', unitCost: '64000.0000' }, { incurred: '300000', unitCost: '30000.0000' }, { incurred: '100000', unitCost: '10000.0000' }]);
    expect(sp1[4]).toMatchObject({ cost: '1040000', unitCost: '104000.0000' });
    // GT: Nợ 154 = phát sinh; dở dang cuối 0 so với dư 154 sổ cái (chưa chạy giá vốn: 1.502.857 − PNK 1.400.000 = 102.857) chỉ là dòng tham khảo.
    expect(card.reconciliation.ok).toBe(true);
    expect(card.reconciliation.items.map((i: Json) => [i.report, i.ledger, i.diff, !!i.info])).toEqual([['1502857', '1502857', '0', false], ['0', '102857', '-102857', true]]);
    // Lọc một đối tượng; đối tượng không có trong lần chạy → 404
    const one = await ok('GET', `${R}/card${q}&objectId=${await objectId('SP2')}`);
    expect(one.footer).toMatchObject({ incurred: '462857', cost: '462857' });
    expect(one.reconciliation.items).toHaveLength(1);
    expect((await call('GET', `${R}/card${q}&objectId=999999`)).statusCode).toBe(404);
  });

  it('sổ chi tiết 154 theo đối tượng khớp sổ cái, trước và sau giá vốn; PNK/GV khớp theo vật tư', async () => {
    let l = await ok('GET', `${R}/ledger-154${q}`);
    // Trước giá vốn: SP1 Nợ 1.040.000 (GT) Có 1.000.000 (PNK TP1); SP2 Nợ 462.857 Có 400.000 (PNK TP2).
    expect(l.objects.map((o: Json) => [o.code, o.opening, o.debit, o.credit, o.closing, o.cardClosing, o.diff])).toEqual([
      ['SP1', '0', '1040000', '1000000', '40000', '0', '40000'], ['SP2', '0', '462857', '400000', '62857', '0', '62857']]);
    expect(l.reconciliation).toMatchObject({ ok: true });
    expect(l.reconciliation.items.map((i: Json) => [i.report, i.ledger])).toEqual([['1502857', '1502857'], ['1400000', '1400000'], ['102857', '102857']]);
    expect(l.footer).toMatchObject({ debit: '1502857', credit: '1400000', balance: '102857' });
    const sp1 = (l.rows as Json[]).slice(0, 9);
    expect(sp1[0]!.description).toBe('Đối tượng: SP1 — Bàn gỗ');
    // PNK 20/03 (Có 154, đối ứng 155) rồi GT 31/03 (Nợ 154 theo khoản mục, đối ứng 621, 622, 627)
    expect(sp1.filter((r) => r.voucherNo).map((r) => [r.contra, r.debit, r.credit, r.balance])).toEqual([['155', '0', '1000000', '-1000000'], ['621, 622, 6272', '640000', '0', '-360000'], ['621, 622, 6272', '300000', '0', '-60000'], ['621, 622, 6272', '100000', '0', '40000']]);

    await ok('POST', '/api/inventory/costing-runs', { periodFrom: '2026-03-01', periodTo: '2026-03-31' });
    l = await ok('GET', `${R}/ledger-154${q}`);
    // Sau giá vốn: Có 154 thêm phần chênh (SP1 40.000, SP2 62.857) → dư cuối 0 = dở dang cuối theo thẻ.
    expect(l.objects.map((o: Json) => [o.code, o.credit, o.closing, o.diff])).toEqual([['SP1', '1040000', '0', '0'], ['SP2', '462857', '0', '0']]);
    expect(l.reconciliation).toMatchObject({ ok: true });
    expect(l.footer).toMatchObject({ debit: '1502857', credit: '1502857', balance: '0' });
    expect((await ok('GET', `${R}/card${q}`)).reconciliation.items[1]).toMatchObject({ diff: '0', info: true });
    // Một đối tượng: không đối chiếu sổ cái
    const one = await ok('GET', `${R}/ledger-154${q}&objectId=${await objectId('SP2')}`);
    expect(one.objects).toHaveLength(1);
    expect(one.reconciliation.items).toEqual([]);
  });

  it('tổng hợp chi phí theo khoản mục khớp tập hợp chi phí (collect) và lần chạy; nhiều tháng', async () => {
    // Giá vốn đã tính lại giá xuất NVL cho SP2 (bình quân sau mỗi lần nhập: 12.500 × 30 = 375.000): lần chạy giá thành cũ lệch 32.143 → báo lệch, chạy lại thì khớp.
    expect((await ok('GET', `${R}/expense-summary${q}`)).reconciliation).toMatchObject({ ok: false, items: [{ report: '1535000', ledger: '1502857', diff: '32143' }] });
    expect((await ok('GET', `${R}/card${q}`)).stale).toBe(true);
    await ok('POST', '/api/costing/runs', { year: 2026, month: 3, params: {} });
    const col = await ok('GET', `/api/costing/collect${q}`);
    const s = await ok('GET', `${R}/expense-summary${q}`);
    const objs = (s.rows as Json[]).filter((r) => r.isBold);
    expect(objs.map((r) => [r.label, r.material, r.labor, r.overhead, r.total])).toEqual([['SP1 — Bàn gỗ', '640000', '300000', '100000', '1040000'], ['SP2 — Ghế gỗ', '375000', '120000', '0', '495000']]);
    for (const o of col.objects as Json[]) if (o.lines.length) expect(find(objs, `${o.code} — `).total).toBe(o.amount);
    expect(find(s.rows, 'TK 621')).toMatchObject({ material: '640000' });
    expect(s.footer).toMatchObject({ material: '1015000', labor: '420000', overhead: '100000', total: '1535000' });
    expect(s.reconciliation).toMatchObject({ ok: true, items: [{ report: '1535000', ledger: '1535000', diff: '0' }] });
    // Tháng 3–4: tháng 4 chưa có chi phí, tổng giữ nguyên
    const two = await ok('GET', `${R}/expense-summary?year=2026&month=3&toMonth=4`);
    expect(two.footer).toMatchObject({ total: '1535000' });
    expect(two.subtitle).toBe('Từ tháng 03/2026 đến tháng 04/2026');
    // Chi phí đổi sau khi chạy giá thành → đối chiếu lệch (cần chạy lại)
    await pkt('2026-03-25', [L('622', '10000', '0', { costObjectCode: 'SP1' }), L('111', '0', '10000')]);
    expect((await ok('GET', `${R}/expense-summary${q}`)).reconciliation).toMatchObject({ ok: false, items: [{ report: '1545000', ledger: '1535000', diff: '10000' }] });
    expect((await ok('GET', `${R}/card${q}`)).stale).toBe(true);
  });

  it('so sánh định mức đúng số tính tay', async () => {
    const r = await ok('GET', `${R}/norm-compare${q}`);
    // Sau giá vốn NVL1 xuất cho SP2 là 30 × 12.500 = 375.000. Giá chuẩn NVL1 = (600.000 + 375.000) ÷ 90 = 10.833,3333.
    // SP1 (10 bàn): định mức 6,3 × 10 = 63, thực tế 60: giá trị định mức 63 × 975.000 ÷ 90 = 682.500; thực tế theo giá chuẩn 60 × 975.000 ÷ 90 = 650.000 → CL lượng −32.500, CL giá 600.000 − 650.000 = −50.000, tổng −82.500.
    // SP2 (8 ghế): định mức 24 (260.000), thực tế 30 (theo giá chuẩn 325.000, thực 375.000) → CL lượng +65.000, CL giá +50.000, tổng +115.000. NVL2: định mức 2 × 10 = 20 = thực tế 20 → 0.
    const rows = r.rows as Json[];
    expect(find(rows, 'NVL1 — Gỗ tấm')).toMatchObject({ uom: 'CAI', standardQty: '63.000000', actualQty: '60.000000', qtyDiff: '-3.000000', qtyDiffPct: '-4.76', actualPrice: '10000.0000', standardPrice: '10833.3333',
      actualValue: '600000', standardValue: '682500', qtyVariance: '-32500', priceVariance: '-50000', totalVariance: '-82500' });
    expect(find(rows, 'NVL2 — Đinh vít')).toMatchObject({ standardQty: '20.000000', actualQty: '20.000000', actualValue: '40000', standardValue: '40000', totalVariance: '0' });
    expect(find(rows, 'Cộng SP1')).toMatchObject({ actualValue: '640000', standardValue: '722500', qtyVariance: '-32500', priceVariance: '-50000', totalVariance: '-82500' });
    const sp2 = rows.filter((x) => String(x.label).startsWith('  NVL1')).at(-1)!;
    expect(sp2).toMatchObject({ standardQty: '24.000000', actualQty: '30.000000', qtyDiff: '6.000000', actualPrice: '12500.0000', actualValue: '375000', standardValue: '260000', qtyVariance: '65000', priceVariance: '50000', totalVariance: '115000' });
    expect(r.footer).toMatchObject({ actualValue: '1015000', standardValue: '982500', qtyVariance: '32500', priceVariance: '0', totalVariance: '32500' });
    expect(r.reconciliation).toMatchObject({ ok: true, items: [{ report: '1015000', ledger: '1015000' }] });
    expect(r.intro.some((t: string) => t.includes('chưa có định mức'))).toBe(false);
  });

  it('vật tư ngoài định mức; TT133 không có 621', async () => {
    // Tháng 4: ghế cần 3 gỗ/cái, nhập 2 ghế → định mức 6; xuất 10 gỗ và 5 đinh (đinh không có trong định mức ghế).
    const x = await stock({ voucherType: 'PXK', stockKind: 'production', postingDate: '2026-04-05', warehouseCode: 'K1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '10' }, { itemCode: 'NVL2', uomCode: 'CAI', quantity: '5' }] });
    await tagObject(x.id, 'SP2');
    await stock({ voucherType: 'PNK', stockKind: 'finished', postingDate: '2026-04-20', warehouseCode: 'K2', items: [{ itemCode: 'TP2', uomCode: 'CAI', quantity: '2', unitPrice: '50000' }] });
    await ok('POST', '/api/costing/runs', { year: 2026, month: 4, params: {} });
    const r = await ok('GET', `${R}/norm-compare?year=2026&month=4`);
    const rows = r.rows as Json[];
    expect(find(rows, 'NVL1')).toMatchObject({ standardQty: '6.000000', actualQty: '10.000000', qtyDiff: '4.000000' });
    expect(find(rows, 'NVL2')).toMatchObject({ standardQty: '0.000000', actualQty: '5.000000', qtyDiffPct: '' });
    expect(String(find(rows, 'NVL2').label)).toContain('(ngoài định mức)');
    expect(r.reconciliation.ok).toBe(true);
    // TT133 (năm 2025): không có TK 621 → báo cáo rỗng kèm giải thích, không đòi lần chạy
    const t = await ok('GET', `${R}/norm-compare?year=2025&month=2`);
    expect(t.rows).toEqual([]);
    expect(t.intro[0]).toContain('TT133');
  });

  it('xuất Excel, HTML, mở được; thiếu view_cost → 403 mọi báo cáo', async () => {
    for (const k of ['card', 'ledger-154', 'expense-summary', 'norm-compare']) {
      const x = await call('GET', `${R}/${k}${q}&format=xlsx`);
      expect([k, x.statusCode]).toEqual([k, 200]);
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
      expect(wb.worksheets[0]!.rowCount).toBeGreaterThan(6);
      expect([k, (await call('GET', `${R}/${k}${q}&format=html`)).body.includes('<table')]).toEqual([k, true]);
    }
    const noCost = await userWith('ketoan_vien', ['view_receivable', 'view_payable']);
    for (const k of ['card', 'ledger-154', 'expense-summary', 'norm-compare']) for (const f of ['json', 'xlsx']) {
      const x = await call('GET', `${R}/${k}${q}&format=${f}`, undefined, noCost);
      expect([k, f, x.statusCode]).toEqual([k, f, 403]);
    }
  });

  it('công ty khác không thấy dữ liệu: chưa chạy → 404, không đọc được đối tượng của công ty này', async () => {
    const { cookie: other } = await bootstrapTenant(ctx, { code: `BH${Date.now()}` });
    for (const [fiscalYear, regime] of [[2025, 'TT133'], [2026, 'TT99']] as const) await ok('POST', '/api/fiscal-years', { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime }, other);
    expect((await call('GET', `${R}/card${q}`, undefined, other)).statusCode).toBe(404);
    const l = await ok('GET', `${R}/ledger-154${q}`, undefined, other);
    expect([l.objects, l.rows, l.footer.balance]).toEqual([[], [], '0']);
    expect((await call('GET', `${R}/ledger-154${q}&objectId=1`, undefined, other)).statusCode).toBe(404);
    expect((await ok('GET', `${R}/expense-summary${q}`, undefined, other)).rows).toEqual([]);
  });
});
