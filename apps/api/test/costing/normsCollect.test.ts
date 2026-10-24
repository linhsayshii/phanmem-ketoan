import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// GĐ6 Task 10b: định mức NVL (CRUD, chồng khoảng, khóa công ty) và tập hợp chi phí theo đối tượng (621/622/627 TT99; 154 theo khoản mục TT133).
let ctx: TestApp; let owner: string; let other: string;
type M = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (method: M, url: string, payload?: object, cookie = owner) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const ok = async (method: M, url: string, payload?: object, cookie = owner) => {
  const r = await call(method, url, payload, cookie); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.statusCode === 204 ? null : r.json();
};
const L = (accountCode: string, debit: string, credit: string, more: object = {}) => ({ accountCode, debit, credit, ...more });
const pkt = (date: string, lines: object[], autoPost = true) => ok('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Chi phí sản xuất', lines, autoPost });
async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `gt_${Math.random().toString(36).slice(2, 8)}`;
  await ok('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}

beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner } = await bootstrapTenant(ctx, { code: `GT${Date.now()}` }));
  ({ cookie: other } = await bootstrapTenant(ctx, { code: `GU${Date.now()}` }));
  for (const [fiscalYear, regime] of [[2025, 'TT133'], [2026, 'TT99']] as const) await ok('POST', '/api/fiscal-years', { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime });
  for (const [name, body] of [['project', { code: 'VV1', name: 'Công trình 1' }], ['project', { code: 'VV2', name: 'Công trình 2 (chưa có đối tượng)' }],
    ['item', { code: 'TP1', name: 'Bàn gỗ', base_uom_code: 'CAI', kind: 'finished' }], ['item', { code: 'TP2', name: 'Ghế gỗ', base_uom_code: 'CAI', kind: 'finished' }],
    ['item', { code: 'NVL1', name: 'Gỗ tấm', base_uom_code: 'CAI', kind: 'material' }], ['item', { code: 'NVL2', name: 'Đinh vít', base_uom_code: 'CAI', kind: 'material' }],
    ['cost_item', { code: 'KM-NVL', name: 'Nguyên vật liệu', cost_element: 'material' }], ['cost_item', { code: 'KM-NC', name: 'Nhân công', cost_element: 'labor' }],
    ['cost_item', { code: 'KM-KHAC', name: 'Chưa phân loại' }]] as const) await ok('POST', `/api/catalogs/${name}`, body);
  for (const o of [{ code: 'SP1', name: 'Bàn gỗ', kind: 'product', itemCode: 'TP1', method: 'simple' }, { code: 'SP2', name: 'Ghế gỗ', kind: 'product', itemCode: 'TP2' },
    { code: 'CT1', name: 'Công trình 1', kind: 'project', projectCode: 'VV1', method: 'project' }]) await ok('POST', '/api/costing/objects', o);
}, 120_000);
afterAll(async () => { await ctx.close(); });

describe('định mức nguyên vật liệu', () => {
  it('thêm theo sản phẩm, xem dòng có hao hụt; chồng khoảng 409; sửa thay dòng; xóa', async () => {
    const n = await ok('POST', '/api/costing/norms', { itemCode: 'TP1', validFrom: '2026-01-01', validTo: '2026-06-30', note: 'Định mức bàn',
      lines: [{ itemCode: 'NVL1', quantity: '2.5', lossPercent: '2' }, { itemCode: 'NVL2', quantity: '12' }] });
    expect(n).toMatchObject({ itemCode: 'TP1', costObjectCode: null, validFrom: '2026-01-01', validTo: '2026-06-30', lineCount: 2 });
    expect(n.lines).toEqual([
      expect.objectContaining({ lineNo: 1, itemCode: 'NVL1', uomCode: 'CAI', quantity: '2.500000', lossPercent: '2.0000', grossQuantity: '2.550000' }),
      expect.objectContaining({ lineNo: 2, itemCode: 'NVL2', quantity: '12.000000', lossPercent: '0.0000', grossQuantity: '12.000000' })]);
    // chồng khoảng (không đến ngày phủ cả sau) → 409; khoảng nối tiếp được
    const clash = await call('POST', '/api/costing/norms', { itemCode: 'TP1', validFrom: '2026-06-01', lines: [{ itemCode: 'NVL1', quantity: '3' }] });
    expect(clash.statusCode).toBe(409); expect(clash.json().error.code).toBe('NORM_OVERLAP');
    const next = await ok('POST', '/api/costing/norms', { itemCode: 'TP1', validFrom: '2026-07-01', lines: [{ itemCode: 'NVL1', quantity: '3' }] });
    expect((await ok('GET', '/api/costing/norms?itemCode=TP1&date=2026-08-15')).map((r: { id: number }) => r.id)).toEqual([next.id]);
    // sửa: dời khoảng của bản đầu chạm bản sau → 409; đổi dòng thì thay toàn bộ
    const bad = await call('PUT', `/api/costing/norms/${n.id}`, { itemCode: 'TP1', validFrom: '2026-01-01', validTo: '2026-07-01', lines: [{ itemCode: 'NVL1', quantity: '1' }] });
    expect(bad.json().error.code).toBe('NORM_OVERLAP');
    const put = await ok('PUT', `/api/costing/norms/${n.id}`, { itemCode: 'TP1', validFrom: '2026-01-01', validTo: '2026-06-30', lines: [{ itemCode: 'NVL2', quantity: '0.000001', lossPercent: '150' }] });
    expect(put.lines).toEqual([expect.objectContaining({ lineNo: 1, itemCode: 'NVL2', quantity: '0.000001', grossQuantity: '0.000003' })]);
    expect((await call('DELETE', `/api/costing/norms/${next.id}`)).statusCode).toBe(204);
    expect((await call('GET', `/api/costing/norms/${next.id}`)).statusCode).toBe(404);
  });

  it('theo đối tượng; lỗi đầu vào: cả hai đích, vật tư lặp, số lượng 0, sản phẩm làm NVL của chính nó, mã không có', async () => {
    const n = await ok('POST', '/api/costing/norms', { costObjectCode: 'CT1', validFrom: '2026-01-01', lines: [{ itemCode: 'NVL1', quantity: '100' }] });
    expect(n).toMatchObject({ itemCode: null, costObjectCode: 'CT1', costObjectName: 'Công trình 1' });
    for (const body of [{ itemCode: 'TP2', costObjectCode: 'CT1', validFrom: '2026-01-01', lines: [{ itemCode: 'NVL1', quantity: '1' }] },
      { validFrom: '2026-01-01', lines: [{ itemCode: 'NVL1', quantity: '1' }] },
      { itemCode: 'TP2', validFrom: '2026-01-01', lines: [{ itemCode: 'NVL1', quantity: '1' }, { itemCode: 'NVL1', quantity: '2' }] },
      { itemCode: 'TP2', validFrom: '2026-01-01', lines: [{ itemCode: 'NVL1', quantity: '0' }] },
      { itemCode: 'TP2', validFrom: '2026-02-01', validTo: '2026-01-01', lines: [{ itemCode: 'NVL1', quantity: '1' }] },
      { itemCode: 'TP2', validFrom: '2026-01-01', lines: [] }]) {
      const r = await call('POST', '/api/costing/norms', body); expect(r.statusCode, r.body).toBe(400);
    }
    const self = await call('POST', '/api/costing/norms', { itemCode: 'TP2', validFrom: '2026-01-01', lines: [{ itemCode: 'TP2', quantity: '1' }] });
    expect(self.statusCode).toBe(400);
    const miss = await call('POST', '/api/costing/norms', { itemCode: 'TP2', validFrom: '2026-01-01', lines: [{ itemCode: 'KHONGCO', quantity: '1' }] });
    expect(miss.statusCode).toBe(404); expect(miss.json().error.code).toBe('LOOKUP_NOT_FOUND');
    // đối tượng đang có định mức không xóa được
    const ct1 = (await ok('GET', '/api/costing/objects?q=CT1')).rows[0];
    expect((await call('DELETE', `/api/costing/objects/${ct1.id}`)).json().error.code).toBe('REFERENCED');
  });

  it('khóa công ty: công ty khác không thấy, không sửa được định mức; người chỉ xem không thêm được', async () => {
    const mine = (await ok('GET', '/api/costing/norms')) as { id: number }[];
    expect(mine.length).toBeGreaterThan(0);
    expect(await ok('GET', '/api/costing/norms', undefined, other)).toEqual([]);
    expect((await call('GET', `/api/costing/norms/${mine[0]!.id}`, undefined, other)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/costing/norms/${mine[0]!.id}`, undefined, other)).statusCode).toBe(404);
    // công ty khác không có vật tư TP1 nên không gắn được định mức vào vật tư của công ty này
    expect((await call('POST', '/api/costing/norms', { itemCode: 'TP1', validFrom: '2026-01-01', lines: [{ itemCode: 'NVL1', quantity: '1' }] }, other)).statusCode).toBe(404);
    const viewer = await userWith('xem', []); // định mức không có tiền: không cần view_cost
    expect((await call('GET', '/api/costing/norms', undefined, viewer)).statusCode).toBe(200);
    expect((await call('POST', '/api/costing/norms', { itemCode: 'TP2', validFrom: '2027-01-01', lines: [{ itemCode: 'NVL1', quantity: '1' }] }, viewer)).statusCode).toBe(403);
  });
});

describe('tập hợp chi phí theo đối tượng', () => {
  it('TT99: 621/622/627 theo đối tượng (cost_object_id, vụ việc), 627 chưa gắn, bỏ nháp và tháng khác; thiếu view_cost 403', async () => {
    await pkt('2026-03-05', [L('621', '1000000', '0', { costObjectCode: 'SP1' }), L('111', '0', '1000000')]);
    await pkt('2026-03-06', [L('111', '100000', '0'), L('621', '0', '100000', { costObjectCode: 'SP1' })]); // nhập lại vật tư thừa: giảm 621
    await pkt('2026-03-07', [L('622', '400000', '0', { projectCode: 'VV1' }), L('111', '0', '400000')]); // vụ việc VV1 → đối tượng CT1
    await pkt('2026-03-08', [L('6272', '50000', '0', { costObjectCode: 'SP1' }), L('6277', '300000', '0'), L('6278', '20000', '0', { projectCode: 'VV2' }), L('111', '0', '370000')]);
    await pkt('2026-03-09', [L('621', '999', '0', { costObjectCode: 'SP1' }), L('111', '0', '999')], false); // nháp: không tính
    await pkt('2026-04-01', [L('621', '777', '0', { costObjectCode: 'SP1' }), L('111', '0', '777')]); // tháng khác
    await pkt('2026-03-10', [L('6421', '5000', '0', { costObjectCode: 'SP1' }), L('111', '0', '5000')]); // chi phí quản lý: không phải chi phí sản xuất

    // mỗi vụ việc một đối tượng (dò đối tượng từ vụ việc của dòng không được mơ hồ)
    const dup = await call('POST', '/api/costing/objects', { code: 'CT1B', name: 'Trùng vụ việc', kind: 'project', projectCode: 'VV1' });
    expect(dup.statusCode).toBe(409); expect(dup.json().error.code).toBe('DUPLICATE');
    const r = await ok('GET', '/api/costing/collect?year=2026&month=3');
    expect(r).toMatchObject({ from: '2026-03-01', to: '2026-03-31', regime: 'TT99', accounts: ['621', '622', '627'] });
    const by = Object.fromEntries((r.objects as { code: string }[]).map((o) => [o.code, o])) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(Object.keys(by)).toEqual(['CT1', 'SP1', 'SP2']); // SP2 đang dùng, chưa có chi phí: vẫn liệt kê
    expect(by['SP1']).toMatchObject({ amount: '950000', total: { material: '900000', labor: '0', overhead: '50000', unclassified: '0' } });
    expect(by['SP1'].lines).toEqual([{ accountCode: '621', costItemCode: null, costItemName: null, element: 'material', amount: '900000' },
      { accountCode: '6272', costItemCode: null, costItemName: null, element: 'overhead', amount: '50000' }]);
    expect(by['CT1']).toMatchObject({ kind: 'project', method: 'project', amount: '400000', total: { labor: '400000' } });
    expect(by['SP2']).toMatchObject({ amount: '0', lines: [] });
    // chưa gắn đối tượng: 6277 không chiều và 6278 của vụ việc VV2 (chưa có đối tượng)
    expect(r.unassigned).toMatchObject({ amount: '320000', total: { overhead: '320000', material: '0', labor: '0' } });
    expect(r.unassigned.lines.map((l: { accountCode: string }) => l.accountCode)).toEqual(['6277', '6278']);

    const one = await ok('GET', `/api/costing/collect?year=2026&month=3&objectId=${by['SP1'].id}`);
    expect(one.objects.map((o: { code: string }) => o.code)).toEqual(['SP1']); expect(one.unassigned.amount).toBe('320000');
    expect((await call('GET', '/api/costing/collect?year=2026&month=3&objectId=999999999')).statusCode).toBe(404);
    expect((await call('GET', '/api/costing/collect?year=2026&month=13')).statusCode).toBe(400);

    const noCost = await userWith('ketoan_vien', ['view_receivable', 'view_payable']);
    const denied = await call('GET', '/api/costing/collect?year=2026&month=3', undefined, noCost);
    expect(denied.statusCode).toBe(403); expect(denied.json().error.message).toBe('Không có quyền xem giá vốn');
    const withCost = await userWith('ketoan_vien', ['view_cost']);
    expect((await call('GET', '/api/costing/collect?year=2026&month=3', undefined, withCost)).statusCode).toBe(200);
    // công ty khác không thấy chi phí của công ty này
    await ok('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' }, other);
    expect(await ok('GET', '/api/costing/collect?year=2026&month=3', undefined, other)).toMatchObject({ objects: [], unassigned: { amount: '0', lines: [] } });
  });

  it('đổi đối tượng của dòng đã ghi sổ chuyển chi phí sang đối tượng mới; đảo chứng từ trừ lại', async () => {
    const v = await pkt('2026-05-10', [L('622', '600000', '0', { costObjectCode: 'SP1' }), L('111', '0', '600000')]);
    const at = async (code: string) => ((await ok('GET', '/api/costing/collect?year=2026&month=5')).objects as { code: string; amount: string }[]).find((o) => o.code === code)!.amount;
    expect(await at('SP1')).toBe('600000');
    await ok('PUT', `/api/vouchers/${v.id}`, { version: v.version, lines: [{ lineNo: 1, costObjectCode: 'SP2' }] });
    expect([await at('SP1'), await at('SP2')]).toEqual(['0', '600000']);
    await ok('POST', `/api/vouchers/${v.id}/reverse`, { postingDate: '2026-05-20' });
    expect(await at('SP2')).toBe('0');
  });

  it('TT133: chi phí ghi thẳng 154 theo khoản mục; Có 154 của nhập kho thành phẩm không tính; khoản mục chưa phân loại', async () => {
    await pkt('2025-02-03', [L('154', '700000', '0', { costObjectCode: 'SP1', costItemCode: 'KM-NVL' }), L('1111', '0', '700000')]);
    await pkt('2025-02-04', [L('154', '200000', '0', { costObjectCode: 'SP1', costItemCode: 'KM-NC' }), L('154', '30000', '0', { costObjectCode: 'SP1', costItemCode: 'KM-KHAC' }), L('1111', '0', '230000')]);
    await pkt('2025-02-05', [L('154', '80000', '0', { projectCode: 'VV1' }), L('1111', '0', '80000')]);
    await pkt('2025-02-06', [L('1111', '40000', '0'), L('154', '0', '40000', { costObjectCode: 'SP1', costItemCode: 'KM-NVL' })]); // giảm chi phí NVL
    // nhập kho thành phẩm Nợ 155 / Có 154: giá thành ra, không phải phát sinh (phiếu kế toán nháp chỉ để có dòng; ghi sổ kho ở Task 11)
    const fg = await call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2025-02-28', documentDate: '2025-02-28', description: 'Nhập kho thành phẩm', autoPost: true,
      lines: [L('155', '500000', '0', { itemCode: 'TP1' }), L('154', '0', '500000', { costObjectCode: 'SP1', costItemCode: 'KM-NVL' })] });
    const r = await ok('GET', '/api/costing/collect?year=2025&month=2');
    expect(r).toMatchObject({ regime: 'TT133', accounts: ['154'] });
    const sp1 = r.objects.find((o: { code: string }) => o.code === 'SP1');
    expect(sp1.total).toEqual({ material: '660000', labor: '200000', overhead: '0', unclassified: '30000' });
    expect(sp1.amount).toBe('890000');
    expect(sp1.lines.find((l: { costItemCode: string }) => l.costItemCode === 'KM-KHAC')).toMatchObject({ element: null, amount: '30000' });
    expect(r.objects.find((o: { code: string }) => o.code === 'CT1')).toMatchObject({ amount: '80000', total: { unclassified: '80000' } });
    expect(fg.statusCode, fg.body).toBe(201);
  });
});
