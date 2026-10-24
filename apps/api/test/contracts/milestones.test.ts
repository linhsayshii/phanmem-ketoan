import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let cookie: string; let tenantId: string; let seq = 0;
type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (method: 'POST' | 'PUT' | 'GET' | 'DELETE', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const code = (r: Res) => r.json().error?.code ?? r.json().code;
const ok = async (r: Promise<Res>, status = 201) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json(); };
const cat = async (name: string, payload: object) => ok(call('POST', `/api/catalogs/${name}`, payload));
// Mã hợp đồng trên từng dòng sổ cái của chứng từ (đọc thẳng DB, không qua DTO).
const contractsOf = async (voucherId: string) => (await sql<{ a: string; c: string | null }>`SELECT a.code AS a, ct.code AS c FROM voucher_line l JOIN account a ON a.id = l.account_id
  LEFT JOIN contract ct ON ct.id = l.contract_id WHERE l.voucher_id = ${voucherId}::uuid ORDER BY l.line_no`.execute(ctx.t.admin)).rows;
const contract = (code: string, kind: 'sale' | 'purchase', more: object = {}) =>
  ok(call('POST', '/api/contracts', { code, name: `Hợp đồng ${code}`, kind, partyCode: kind === 'sale' ? 'KH001' : 'NCC001', value: '100000000', status: 'active', accountCode: kind === 'sale' ? '5113' : '6422', taxCode: 'V10', ...more }));
const invoice = (voucherType: string, more: object = {}) => {
  const sale = ['HDB', 'BH'].includes(voucherType);
  return { voucherType, postingDate: '2026-03-10', documentDate: '2026-03-10', partyCode: sale ? 'KH001' : 'NCC001',
    items: [{ description: 'Dịch vụ', accountCode: sale ? '5113' : '6422', amountCurrency: '10000000', taxCodes: ['V10'] }],
    invoice: { serial: 'C26TAA', invoiceNo: `HD${seq++}`, invoiceDate: '2026-03-10', invoiceGroupCode: sale ? '10' : '01' }, ...more };
};
const goods = { itemCode: 'S1', uomCode: 'CAI', warehouseCode: 'K1', quantity: '10', unitPrice: '50000', amountCurrency: '500000', taxCodes: ['V10'] };
const toInvoice = (more: object = {}) => ({ postingDate: '2026-03-15', invoiceGroupCode: '10', invoiceNo: `D${seq++}`, ...more });
const milestones = async (id: number) => (await ok(call('GET', `/api/contracts/${id}`), 200)).milestones as { id: number; seq: number; amount: string; status: string; voucherId: string | null; voucherState: string | null }[];
const login = async (perms: string[]) => {
  const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
  await call('PUT', `/api/roles/${roles.find((r) => r.code === 'xem')!.id}/permissions`, { permissions: perms });
  const username = `hd_${Date.now()}_${seq++}`;
  expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: [] })).statusCode).toBe(201);
  const l = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${l.cookies.find((x) => x.name === 'sid')!.value}`;
};

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `HD${Date.now()}`));
  await call('POST', '/api/catalogs/uom', { code: 'CAI', name: 'Cái' });
  await cat('item', { code: 'S1', name: 'Hàng S1', base_uom_code: 'CAI', kind: 'goods', revenue_account_code: '5111' });
  await cat('warehouse', { code: 'K1', name: 'Kho chính', inventory_account_code: '156', costing_method: 'avg_moving' });
  await call('POST', '/api/catalogs/bank', { code: 'VCB', name: 'Vietcombank' });
  await cat('bank_account', { account_no: '9990001', bank_code: 'VCB', currency_code: 'VND', gl_account_code: '1121' });
  const r = await ok(call('POST', '/api/stock-vouchers', { voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-03-01', warehouseCode: 'K1', partyCode: 'NCC001', items: [{ itemCode: 'S1', uomCode: 'CAI', quantity: '1000', unitPrice: '10000' }] }));
  await ok(call('POST', `/api/vouchers/${r.id}/post`, {}), 200);
});
afterAll(async () => { await ctx.close(); });

describe('chiều hợp đồng trên chứng từ', () => {
  it('HDB, HDM, BH, MH ghi mã hợp đồng lên mọi dòng sổ cái và trả contractCode; PT, BC ghi theo dòng', async () => {
    await contract('HB1', 'sale'); await contract('HM1', 'purchase');
    for (const [type, c, more] of [['HDB', 'HB1', {}], ['HDM', 'HM1', {}], ['BH', 'HB1', { items: [goods] }], ['MH', 'HM1', { stockMode: 'through_stock', items: [goods] }]] as const) {
      const v = await ok(call('POST', '/api/invoices', invoice(type, { contractCode: c, autoPost: true, ...more })));
      expect([type, v.state, v.contractCode]).toEqual([type, 'posted', c]);
      const lines = await contractsOf(v.id);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.filter((l) => l.c !== c), type).toEqual([]);
      expect((await ok(call('GET', `/api/invoices/${v.id}`), 200)).contractCode).toBe(c);
    }
    // Sửa hóa đơn nháp bỏ hợp đồng: mọi dòng mất chiều
    const d = await ok(call('POST', '/api/invoices', invoice('HDB', { contractCode: 'HB1' })));
    const u = await ok(call('PUT', `/api/invoices/${d.id}`, { ...invoice('HDB'), version: d.version }), 200);
    expect(u.contractCode).toBeNull();
    expect((await contractsOf(d.id)).every((l) => l.c === null)).toBe(true);
    const pt = await ok(call('POST', '/api/vouchers', { voucherType: 'PT', postingDate: '2026-03-20', documentDate: '2026-03-20', partyCode: 'KH001', personName: 'A', description: 'Thu tiền hợp đồng',
      lines: [{ accountCode: '1111', debit: '11000000' }, { accountCode: '131', credit: '11000000', partyCode: 'KH001', contractCode: 'HB1' }] }));
    expect((await contractsOf(pt.id)).map((l) => l.c)).toEqual([null, 'HB1']);
    const bc = await ok(call('POST', '/api/vouchers', { voucherType: 'BC', postingDate: '2026-03-20', documentDate: '2026-03-20', partyCode: 'KH001', bankAccountNo: '9990001', description: 'Thu qua ngân hàng',
      lines: [{ accountCode: '1121', debit: '5000000', contractCode: 'HB1' }, { accountCode: '131', credit: '5000000', partyCode: 'KH001', contractCode: 'HB1' }] }));
    expect((await contractsOf(bc.id)).map((l) => l.c)).toEqual(['HB1', 'HB1']);
    expect((await ok(call('GET', `/api/vouchers/${bc.id}`), 200)).lines.map((l: { contractCode: string }) => l.contractCode)).toEqual(['HB1', 'HB1']);
    // In chứng từ (phiếu kế toán của hóa đơn dịch vụ) nêu hợp đồng
    const h = await ok(call('POST', '/api/invoices', invoice('HDB', { contractCode: 'HB1' })));
    const html = await call('GET', `/api/vouchers/${h.id}/print?format=html`);
    expect(html.statusCode, html.body).toBe(200); expect(html.body).toContain('Hợp đồng: HB1');
  });

  it('hợp đồng sai chiều, khác đối tượng, không có: 400/404; khế ước vay không gắn hóa đơn', async () => {
    await contract('HB2', 'sale'); await contract('HM2', 'purchase');
    expect(code(await call('POST', '/api/invoices', invoice('HDB', { contractCode: 'HM2' })))).toBe('CONTRACT_KIND_MISMATCH');
    expect(code(await call('POST', '/api/invoices', invoice('HDM', { contractCode: 'HB2' })))).toBe('CONTRACT_KIND_MISMATCH');
    expect(code(await call('POST', '/api/invoices', invoice('HDB', { contractCode: 'HB2', partyCode: 'KH002' })))).toBe('CONTRACT_PARTY_MISMATCH');
    const r = await call('POST', '/api/invoices', invoice('HDB', { contractCode: 'KHONGCO' }));
    expect([r.statusCode, code(r)]).toEqual([404, 'LOOKUP_NOT_FOUND']);
    // hợp đồng không có đối tượng: gắn được cho mọi đối tượng cùng chiều
    await contract('HB3', 'sale', { partyCode: null });
    expect((await ok(call('POST', '/api/invoices', invoice('HDB', { contractCode: 'HB3', partyCode: 'KH002' })))).contractCode).toBe('HB3');
  });
});

describe('đợt thanh toán và lập hóa đơn từ đợt', () => {
  it('lưu đợt theo tỷ lệ/số tiền, lập HDB nháp đúng số tiền, thuế, chiều hợp đồng; lập lần hai 409; đợt đã lập không sửa số tiền, không xóa', async () => {
    const c = await contract('HB10', 'sale', { value: '100000001' });
    const saved = await ok(call('PUT', `/api/contracts/${c.id}/milestones`, { milestones: [
      { seq: 1, description: 'Tạm ứng 30%', percent: '30', dueDate: '2026-03-31' }, { seq: 2, description: 'Nghiệm thu', amount: '50000000', taxCode: 'V8' }, { seq: 3, description: 'Bảo hành', percent: '20' }] }), 200);
    expect(saved.milestones.map((m: { amount: string; status: string }) => [m.amount, m.status])).toEqual([['30000000.0000', 'planned'], ['50000000.0000', 'planned'], ['20000000.0000', 'planned']]);
    expect([saved.milestoneTotal, saved.invoicedTotal, saved.milestoneCount]).toEqual(['100000000.0000', '0', 3]);
    const [m1, m2] = saved.milestones as { id: number }[];
    const out = await ok(call('POST', `/api/contracts/${c.id}/milestones/${m1!.id}/invoice`, toInvoice()));
    expect(out.invoice).toMatchObject({ voucherType: 'HDB', state: 'draft', partyCode: 'KH001', contractCode: 'HB10' });
    expect(out.milestone).toMatchObject({ status: 'invoiced', voucherId: out.invoice.id, voucherState: 'draft' });
    const shape = (out.invoice.lines as { accountCode: string; debit: string; credit: string }[]).map((l) => `${l.accountCode}:${l.debit}:${l.credit}`).sort();
    expect(shape).toEqual(['131:33000000:0', '33311:0:3000000', '5113:0:30000000']); // 30% × 100.000.001 làm tròn 30.000.000, thuế 10% của hợp đồng
    expect((await contractsOf(out.invoice.id)).every((l) => l.c === 'HB10')).toBe(true);
    // đợt có thuế riêng 8%
    const o2 = await ok(call('POST', `/api/contracts/${c.id}/milestones/${m2!.id}/invoice`, toInvoice({ invoiceGroupCode: '08' })));
    expect((o2.invoice.lines as { accountCode: string; credit: string }[]).find((l) => l.accountCode === '33311')!.credit).toBe('4000000');
    expect(code(await call('POST', `/api/contracts/${c.id}/milestones/${m1!.id}/invoice`, toInvoice()))).toBe('MILESTONE_INVOICED');
    const all = await milestones(c.id);
    expect(code(await call('PUT', `/api/contracts/${c.id}/milestones`, { milestones: all.map((m) => ({ id: m.id, seq: m.seq, description: 'x', amount: m.id === m1!.id ? '1000' : m.amount })) }))).toBe('MILESTONE_INVOICED');
    expect(code(await call('PUT', `/api/contracts/${c.id}/milestones`, { milestones: all.filter((m) => m.id !== m1!.id).map((m) => ({ id: m.id, seq: m.seq, description: 'x', amount: m.amount })) }))).toBe('MILESTONE_INVOICED');
    // đổi nội dung, STT (đổi chỗ) của đợt đã lập vẫn được
    const swapped = await ok(call('PUT', `/api/contracts/${c.id}/milestones`, { milestones: all.map((m) => ({ id: m.id, seq: m.seq === 1 ? 2 : m.seq === 2 ? 1 : m.seq, description: `Đợt ${m.id}`, amount: m.amount, taxCode: m.id === m2!.id ? 'V8' : null })) }), 200);
    expect(swapped.milestones.map((m: { id: number }) => m.id).slice(0, 2)).toEqual([m2!.id, m1!.id]);
    expect(swapped.invoicedTotal).toBe('80000000.0000');
    // hợp đồng chưa hiệu lực, đợt hủy, thiếu tài khoản
    const d = await contract('HB11', 'sale', { status: 'draft', accountCode: null });
    const dm = (await ok(call('PUT', `/api/contracts/${d.id}/milestones`, { milestones: [{ seq: 1, description: 'A', amount: '1000000' }, { seq: 2, description: 'B', amount: '1000000', status: 'cancelled' }] }), 200)).milestones;
    expect(code(await call('POST', `/api/contracts/${d.id}/milestones/${dm[0].id}/invoice`, toInvoice()))).toBe('CONTRACT_NOT_ACTIVE');
    expect(code(await call('POST', `/api/contracts/${d.id}/milestones/${dm[1].id}/invoice`, toInvoice()))).toBe('MILESTONE_CANCELLED');
    await ok(call('PUT', `/api/contracts/${d.id}`, { code: 'HB11', name: 'HB11', kind: 'sale', partyCode: 'KH001', value: '0', status: 'active' }), 200);
    expect(code(await call('POST', `/api/contracts/${d.id}/milestones/${dm[0].id}/invoice`, toInvoice()))).toBe('CONTRACT_ACCOUNT_REQUIRED');
    expect((await ok(call('POST', `/api/contracts/${d.id}/milestones/${dm[0].id}/invoice`, toInvoice({ accountCode: '5113' })))).invoice.lines.length).toBe(2); // không thuế: 131/5113
    expect(code(await call('PUT', `/api/contracts/${d.id}/milestones`, { milestones: [{ seq: 1, description: 'A', percent: '10' }] }))).toBe('VALIDATION'); // giá trị 0
  });

  it('hợp đồng mua lập HDM; hai yêu cầu đồng thời chỉ sinh một hóa đơn', async () => {
    const c = await contract('HM10', 'purchase');
    const [m] = (await ok(call('PUT', `/api/contracts/${c.id}/milestones`, { milestones: [{ seq: 1, description: 'Đợt 1', amount: '20000000' }] }), 200)).milestones;
    const before = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'HDM'`.execute(ctx.t.admin)).rows[0]!.n);
    const rs = await Promise.all([1, 2].map((i) => call('POST', `/api/contracts/${c.id}/milestones/${m.id}/invoice`, toInvoice({ invoiceGroupCode: '01', invoiceNo: `M${i}` }))));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const after = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'HDM'`.execute(ctx.t.admin)).rows[0]!.n);
    expect(after - before).toBe(1);
    const won = rs.find((r) => r.statusCode === 201)!.json();
    expect(won.invoice.voucherType).toBe('HDM');
    expect((won.invoice.lines as { accountCode: string; debit: string; credit: string }[]).map((l) => `${l.accountCode}:${l.debit}:${l.credit}`).sort()).toEqual(['1331:2000000:0', '331:0:22000000', '6422:20000000:0']);
  });

  it('gỡ liên kết: xóa nháp, hủy, đảo trả đợt về chưa lập; bỏ ghi sổ giữ liên kết', async () => {
    const c = await contract('HB20', 'sale');
    const [m] = (await ok(call('PUT', `/api/contracts/${c.id}/milestones`, { milestones: [{ seq: 1, description: 'Đợt 1', amount: '10000000' }] }), 200)).milestones;
    const make = async () => (await ok(call('POST', `/api/contracts/${c.id}/milestones/${m.id}/invoice`, toInvoice()))).invoice as { id: string };
    const state = async () => (await milestones(c.id))[0]!;
    // xóa hóa đơn nháp (khóa ngoại SET NULL)
    const v1 = await make();
    expect((await call('DELETE', `/api/vouchers/${v1.id}`)).statusCode).toBe(204);
    expect(await state()).toMatchObject({ status: 'planned', voucherId: null });
    // hủy
    const v2 = await make();
    expect((await call('POST', `/api/vouchers/${v2.id}/discard`)).statusCode).toBe(200);
    expect(await state()).toMatchObject({ status: 'planned', voucherId: null });
    // ghi sổ rồi bỏ ghi sổ: vẫn là hóa đơn của đợt
    const v3 = await make();
    await ok(call('POST', `/api/vouchers/${v3.id}/post`, {}), 200);
    expect(await state()).toMatchObject({ status: 'invoiced', voucherId: v3.id, voucherState: 'posted' });
    await ok(call('POST', `/api/vouchers/${v3.id}/unpost`, {}), 200);
    expect(await state()).toMatchObject({ status: 'invoiced', voucherId: v3.id, voucherState: 'draft' });
    expect(code(await call('POST', `/api/contracts/${c.id}/milestones/${m.id}/invoice`, toInvoice()))).toBe('MILESTONE_INVOICED');
    // ghi sổ lại rồi đảo
    await ok(call('POST', `/api/vouchers/${v3.id}/post`, {}), 200);
    await ok(call('POST', `/api/vouchers/${v3.id}/reverse`, { postingDate: '2026-03-20' }));
    expect(await state()).toMatchObject({ status: 'planned', voucherId: null });
    expect((await make()).id).not.toBe(v3.id); // lập lại được
    const audit = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = 'contract_milestone' AND entity_id = ${String(m.id)}`.execute(ctx.t.admin)).rows[0]!.n);
    expect(audit).toBeGreaterThanOrEqual(8); // thêm, mỗi lần gắn/gỡ hóa đơn
  });

  it('công ty khác không thấy, không sửa, không lập; quyền order.update và voucher.create', async () => {
    const c = await contract('HB30', 'sale');
    const [m] = (await ok(call('PUT', `/api/contracts/${c.id}/milestones`, { milestones: [{ seq: 1, description: 'Đợt 1', amount: '10000000' }] }), 200)).milestones;
    const other = (await setupLedgerTenant(ctx, `HX${Date.now()}`)).cookie;
    expect((await call('GET', `/api/contracts/${c.id}`, undefined, other)).statusCode).toBe(404);
    expect((await call('PUT', `/api/contracts/${c.id}/milestones`, { milestones: [] }, other)).statusCode).toBe(404);
    expect((await call('POST', `/api/contracts/${c.id}/milestones/${m.id}/invoice`, toInvoice(), other)).statusCode).toBe(404);
    expect((await call('GET', '/api/contracts', undefined, other)).json().some((x: { code: string }) => x.code === 'HB30')).toBe(false);
    const viewer = await login(['order.view']);
    expect((await call('GET', `/api/contracts/${c.id}`, undefined, viewer)).statusCode).toBe(200);
    expect((await call('PUT', `/api/contracts/${c.id}/milestones`, { milestones: [] }, viewer)).statusCode).toBe(403);
    const noVoucher = await login(['order.view', 'order.update']);
    expect((await call('POST', `/api/contracts/${c.id}/milestones/${m.id}/invoice`, toInvoice(), noVoucher)).statusCode).toBe(403);
    expect((await milestones(c.id))[0]!.voucherId).toBeNull();
  });
});
