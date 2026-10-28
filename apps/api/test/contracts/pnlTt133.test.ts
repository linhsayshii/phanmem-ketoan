import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// QĐ #990: lãi lỗ vụ việc/hợp đồng TT133, cột "Chi phí sản xuất" (154) phân loại dòng GV theo từng dòng như tập hợp chi phí (costing/collect.ts, QĐ #960).
// GV gộp mọi chênh lệch của ngày: chênh lệch giá xuất NVL (Có 154 / Nợ 152, gắn vụ việc) nằm chung chứng từ với Nợ 154 / Có 155 của lớp điều chỉnh
// giá nhập thành phẩm và Nợ 155 / Có 632 của hàng bán. Cách cũ (cả chứng từ) bỏ nhầm dòng NVL và tính dòng thành phẩm là chi phí.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let ctx: TestApp; let owner: string;
type M = 'GET' | 'POST' | 'PUT';
const ok = async (method: M, url: string, payload?: object) => {
  const r = await ctx.app.inject({ method, url, headers: { cookie: owner }, ...(payload ? { payload } : {}) });
  expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json();
};
const stock = async (body: object) => { const v = await ok('POST', '/api/stock-vouchers', { description: 'Phiếu kho', ...body }); return ok('POST', `/api/vouchers/${v.id}/post`, {}); };
const costing = () => ok('POST', '/api/inventory/costing-runs', { periodFrom: '2025-05-01', periodTo: '2025-05-31' });

beforeAll(async () => { ctx = await createTestApp(); }, 180_000);
afterAll(async () => { await ctx.close(); });
// Gắn chiều (đối tượng, khoản mục, vụ việc) cho dòng 154 của chứng từ đã ghi sổ (sửa meta).
const tag154 = async (id: string, more: object) => {
  const v = await ok('GET', `/api/vouchers/${id}`);
  const l = (v.lines as Json[]).find((x) => x.accountCode.startsWith('154'))!;
  await ok('PUT', `/api/vouchers/${id}`, { version: v.version, lines: [{ lineNo: l.lineNo, projectCode: 'VV1', ...more }] });
};

// Mỗi ca một công ty TT133 riêng. Tháng 5/2025: mua 100 NVL × 10.000, xuất 60 cho SP1 (gắn VV1), mua 100 × 8.000; nhân công 100.000 (VV1);
// nhập 10 thành phẩm giá tạm `price` (dòng Có 154 gắn VV1), bán 4; giá vốn → giá thành → giá vốn lại. Trả lãi lỗ vụ việc và hợp đồng tháng 5.
// NVL bình quân kỳ (100 × 10.000 + 100 × 8.000) ÷ 200 = 9.000 → xuất 60 = 540.000 (GV Có 154 / Nợ 152 60.000, gắn VV1); giá thành 540.000 + 100.000 = 640.000.
async function scenario(price: string): Promise<[Json, Json]> {
  ({ cookie: owner } = await bootstrapTenant(ctx, { code: `LL${Date.now()}` }));
  await ok('POST', '/api/fiscal-years', { fiscalYear: 2025, dateFrom: '2025-01-01', months: 12, regime: 'TT133' });
  for (const [name, body] of [['party', { code: 'NCC1', name: 'Nhà cung cấp', is_vendor: true }],
    ['warehouse', { code: 'K3', name: 'Kho vật tư bình quân kỳ', inventory_account_code: '152', costing_method: 'avg_period' }],
    ['warehouse', { code: 'K2', name: 'Kho thành phẩm', inventory_account_code: '155', costing_method: 'avg_period' }],
    ['item', { code: 'NVL1', name: 'Gỗ tấm', base_uom_code: 'CAI', kind: 'material' }], ['item', { code: 'TP1', name: 'Bàn gỗ', base_uom_code: 'CAI', kind: 'finished' }],
    ['cost_item', { code: 'KM-NVL', name: 'Nguyên vật liệu', cost_element: 'material' }], ['cost_item', { code: 'KM-NC', name: 'Nhân công', cost_element: 'labor' }],
    ['project', { code: 'VV1', name: 'Công trình 1' }]] as const) await ok('POST', `/api/catalogs/${name}`, body);
  await ok('POST', '/api/costing/objects', { code: 'SP1', name: 'Bàn gỗ', kind: 'product', itemCode: 'TP1', method: 'simple' });
  await stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: '2025-05-02', warehouseCode: 'K3', partyCode: 'NCC1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '100', unitPrice: '10000' }] });
  const pxk = await stock({ voucherType: 'PXK', stockKind: 'production', postingDate: '2025-05-05', warehouseCode: 'K3', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '60' }] });
  await tag154(pxk.id, { costObjectCode: 'SP1', costItemCode: 'KM-NVL' });
  await stock({ voucherType: 'PNK', stockKind: 'purchase', postingDate: '2025-05-06', warehouseCode: 'K3', partyCode: 'NCC1', items: [{ itemCode: 'NVL1', uomCode: 'CAI', quantity: '100', unitPrice: '8000' }] });
  await ok('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2025-05-10', documentDate: '2025-05-10', description: 'Nhân công', autoPost: true, lines: [
    { accountCode: '154', debit: '100000', credit: '0', costObjectCode: 'SP1', costItemCode: 'KM-NC', projectCode: 'VV1' }, { accountCode: '1111', debit: '0', credit: '100000' }] });
  const pnk = await stock({ voucherType: 'PNK', stockKind: 'finished', postingDate: '2025-05-20', warehouseCode: 'K2', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: '10', unitPrice: price }] });
  await tag154(pnk.id, {});
  await stock({ voucherType: 'PXK', stockKind: 'sale', postingDate: '2025-05-31', warehouseCode: 'K2', items: [{ itemCode: 'TP1', uomCode: 'CAI', quantity: '4' }] });
  await costing();
  expect((await ok('POST', '/api/costing/runs', { year: 2025, month: 5, params: {} })).objects[0]).toMatchObject({ total: '640000' });
  await costing(); // đảo GV cũ, GV mới gồm chênh lệch NVL, điều chỉnh giá nhập thành phẩm, hàng bán
  return [await ok('GET', '/api/projects/pnl?from=2025-05-01&to=2025-05-31'), await ok('GET', '/api/contracts/pnl?from=2025-05-01&to=2025-05-31')];
}

describe('lãi lỗ vụ việc TT133: chi phí sản xuất phân loại dòng GV theo từng dòng', () => {
  // Chi phí sản xuất VV1 đúng: PXK 600.000 + nhân công 100.000 − GV cũ 60.000 + bản đảo 60.000 − GV mới 60.000 = 640.000;
  // PNK Có 154 (giá tạm) và dòng 154 của lớp điều chỉnh giá nhập thành phẩm ở GV mới là giá thành ra, không tính.
  const expectPnl = ([p, c]: [Json, Json]) => {
    expect(p.rows.find((x: Json) => x.code === 'VV1')).toMatchObject({ production: '640000' });
    expect([p.unassigned.production, p.totals.production, c.totals.production]).toEqual(['0', '640000', '640000']);
  };
  it('giá tạm thành phẩm cao hơn giá thành: dòng GV Nợ 154 / Có 155 360.000 của lớp điều chỉnh không phải chi phí', async () => {
    // Lớp −360.000: GV mới Nợ 154 / Có 155 360.000 (gắn VV1), 155 gộp với hàng bán Nợ 155 / Có 632 144.000 nên GV chỉ có Có 155.
    // Cách cũ (cả chứng từ) chỉ bỏ dòng Có 154: tính 360.000 → VV1 1.000.000.
    expectPnl(await scenario('100000'));
  });
  it('giá tạm thành phẩm thấp hơn giá thành: GV có Nợ 155, Nợ 632 không làm mất chênh lệch NVL Có 154 gắn vụ việc', async () => {
    // Giá tạm 500.000, lớp +140.000: GV mới Nợ 155 / Có 154 140.000 và hàng bán Nợ 632 / Có 155 56.000 cùng chứng từ với chênh lệch NVL Có 154 60.000.
    // Cách cũ bỏ mọi dòng Có 154 của chứng từ có Nợ 155/632 → mất −60.000 của GV mới → VV1 700.000.
    expectPnl(await scenario('50000'));
  });
});
