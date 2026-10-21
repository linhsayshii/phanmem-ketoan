import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];
interface Ret { id: number; revision: number; status: string; templateVersion: string; values: Record<string, string>; overrides: Record<string, string>; hints: Record<string, string>; warnings: string[] }
const M = (x: number) => String(x * 1_000_000);

// Mỗi kiểm thử một công ty: năm 2026 theo TT133, khai thuế theo tháng (mặc định).
async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `VR${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  let no = 0;
  const invoice = async (voucherType: 'HDB' | 'HDM', date: string, amount: string, taxCode: string, group: string) => {
    const sale = voucherType === 'HDB';
    const r = await call('POST', '/api/invoices', { voucherType, postingDate: date, documentDate: date, partyCode: sale ? 'KH001' : 'NCC001', autoPost: true,
      items: [{ description: 'Hàng', accountCode: sale ? '5113' : '6422', amountCurrency: amount, taxCodes: [taxCode] }],
      invoice: { serial: 'C26TAA', invoiceNo: String(++no).padStart(7, '0'), invoiceDate: date, invoiceGroupCode: group } });
    expect(r.statusCode, r.body).toBe(201); return r.json() as { id: string };
  };
  const create = async (body: object): Promise<Ret> => { const r = await call('POST', '/api/tax/vat-returns', body); expect(r.statusCode, r.body).toBe(201); return r.json(); };
  const month = (period: number, more: object = {}) => ({ year: 2026, periodKind: 'month', period, ...more });
  const finalize = async (id: number): Promise<Ret> => { const r = await call('POST', `/api/tax/vat-returns/${id}/finalize`); expect(r.statusCode, r.body).toBe(200); return r.json(); };
  return { cookie, tenantId, call, invoice, create, month, finalize };
}

describe('tờ khai 01/GTGT', () => {
  it('kỳ tháng 7/2026 dùng TT89; tháng 6/2026 trả VAT_TEMPLATE_UNAVAILABLE khi TT80 chưa có', async () => {
    const t = await tenant();
    const r = await t.create(t.month(7));
    expect(r).toMatchObject({ revision: 0, status: 'draft', templateVersion: 'TT89' });
    expect(r.values['21']).toBe('X'); // không có hóa đơn
    const old = await t.call('POST', '/api/tax/vat-returns', t.month(6));
    expect(err(old)).toEqual([409, 'VAT_TEMPLATE_UNAVAILABLE']);
    expect(old.json().error.message).toContain('TT 80/2021');
    expect(err(await t.call('POST', '/api/tax/vat-returns', t.month(13)))).toEqual([400, 'VALIDATION']);
  });

  it('mua 100tr thuế 10tr (nhóm 01), bán 10% 300tr thuế 30tr, KCT 50tr: [23]=100tr [24]=10tr [25]=10tr [26]=50tr [32]=300tr [33]=30tr [27]=300tr [28]=30tr [34]=350tr [35]=30tr [36]=20tr', async () => {
    const t = await tenant();
    await t.invoice('HDM', '2026-07-05', M(100), 'V10', '01');
    await t.invoice('HDB', '2026-07-10', M(300), 'V10', '10');
    await t.invoice('HDB', '2026-07-12', M(50), 'KCT', 'KCT');
    await t.invoice('HDB', '2026-08-01', M(999), 'V10', '10'); // kỳ khác
    const r = await t.create(t.month(7));
    expect(r.values).toMatchObject({ '21': '', '22': '0', '23': M(100), '24': M(10), '25': M(10), '26': M(50), '32': M(300), '33': M(30), '27': M(300), '28': M(30), '34': M(350), '35': M(30), '36': M(20), '40a': M(20), '40': M(20), '41': '0', '43': '0' });
    expect(r.hints['25']).toContain('Gợi ý của phần mềm');
    expect(r.hints['22']).toContain('số dư Nợ TK 133 đầu kỳ 0');
    expect(r.warnings).toEqual([]);
  });

  it('nhóm KKK, KTGT, NPV đã gieo và lên [32a], [32b], [34a], không gộp vào KCT [26]', async () => {
    const t = await tenant();
    await t.invoice('HDB', '2026-07-10', M(40), 'KKK', 'KKK');
    await t.invoice('HDB', '2026-07-11', M(7), 'KCT', 'KTGT');
    await t.invoice('HDB', '2026-07-12', M(9), 'KCT', 'NPV');
    const r = await t.create(t.month(7));
    expect([r.values['26'], r.values['32a'], r.values['32b'], r.values['34a'], r.values['27'], r.values['34']]).toEqual(['0', M(40), M(7), M(9), M(33), M(42)]);
  });

  it('[22] lấy [43] của tờ khai đã chốt kỳ trước; [40a]/[41] theo dấu của biểu thức; [43]=[41]-[42]', async () => {
    const t = await tenant();
    await t.invoice('HDM', '2026-07-05', M(100), 'V10', '01'); // tháng 7: chỉ mua, thuế 10tr chưa khấu trừ hết
    const jul = await t.create(t.month(7));
    expect([jul.values['36'], jul.values['40a'], jul.values['41'], jul.values['43']]).toEqual([M(-10), '0', M(10), M(10)]);
    expect(err(await t.call('PUT', `/api/tax/vat-returns/${jul.id}`, { manual: { '42': M(11) } }))).toEqual([400, 'VALIDATION']); // [42] ≤ [41]
    expect(err(await t.call('PUT', `/api/tax/vat-returns/${jul.id}`, { manual: { '36': '1' } }))).toEqual([400, 'VALIDATION']);
    const put = await t.call('PUT', `/api/tax/vat-returns/${jul.id}`, { manual: { '42': M(4) } });
    expect(put.statusCode, put.body).toBe(200);
    expect([put.json().values['42'], put.json().values['43']]).toEqual([M(4), M(6)]);
    const fin = await t.finalize(jul.id);
    expect(fin).toMatchObject({ status: 'final' }); expect(fin.values['43']).toBe(M(6)); // manual giữ khi chốt (tính lại)

    await t.invoice('HDB', '2026-08-10', M(300), 'V10', '10');
    const aug = await t.create(t.month(8, { manual: { '22': M(99) } }));
    expect([aug.values['22'], aug.values['36'], aug.values['40a'], aug.values['41'], aug.values['43']]).toEqual([M(6), M(30), M(24), '0', '0']);
    expect(aug.hints['22']).toContain('tháng 7/2026');
    expect(aug.warnings.join(' ')).toContain('nhập tay không dùng');
    // kỳ trước (8) chưa chốt: [22] nhập tay
    const sep = await t.create(t.month(9, { manual: { '22': M(2) } }));
    expect([sep.values['22'], sep.values['41']]).toEqual([M(2), M(2)]);
    expect(sep.hints['22']).toContain('Kỳ trước chưa có tờ khai đã chốt');
  });

  it('bổ sung lần 1 sau khi đã chốt; tờ khai đã chốt không sửa được', async () => {
    const t = await tenant();
    await t.invoice('HDM', '2026-07-05', M(100), 'V10', '01');
    const r0 = await t.create(t.month(7));
    expect(err(await t.call('POST', '/api/tax/vat-returns', t.month(7)))).toEqual([409, 'TAX_RETURN_DRAFT_EXISTS']);
    await t.finalize(r0.id);
    expect(err(await t.call('PUT', `/api/tax/vat-returns/${r0.id}`, { manual: { '42': '1' } }))).toEqual([409, 'TAX_RETURN_FINAL']);
    expect(err(await t.call('POST', `/api/tax/vat-returns/${r0.id}/finalize`))).toEqual([409, 'TAX_RETURN_FINAL']);
    await expect(sql`UPDATE tax_return SET values = '{}' WHERE id = ${r0.id}`.execute(ctx.t.admin)).rejects.toThrow(/TAX_RETURN_FINAL/);
    await expect(sql`DELETE FROM tax_return WHERE id = ${r0.id}`.execute(ctx.t.admin)).rejects.toThrow(/TAX_RETURN_FINAL/);
    expect(err(await t.call('POST', '/api/tax/vat-returns', t.month(7, { revision: 2 })))).toEqual([409, 'TAX_RETURN_REVISION']);
    const r1 = await t.create(t.month(7, { revision: 1, manual: { '42': M(3) } }));
    expect(r1).toMatchObject({ revision: 1, status: 'draft' });
    await t.finalize(r1.id);
    // kỳ sau lấy [43] của lần bổ sung cuối đã chốt
    const aug = await t.create(t.month(8));
    expect(aug.values['22']).toBe(M(7));
    expect(aug.hints['22']).toContain('bổ sung lần 1');
    const list = await t.call('GET', '/api/tax/vat-returns?year=2026');
    expect((list.json() as Ret[]).map((x) => [x.id, x.revision, x.status])).toEqual([[aug.id, 0, 'draft'], [r1.id, 1, 'final'], [r0.id, 0, 'final']]);
    expect((await t.call('GET', `/api/tax/vat-returns/${r0.id}`)).json()).toMatchObject({ id: r0.id, status: 'final', revision: 0 });
    expect(err(await t.call('GET', '/api/tax/vat-returns/999999999'))).toEqual([404, 'TAX_RETURN_NOT_FOUND']);
  });

  it('ghi đè [25] được lưu trong overrides và ghi audit', async () => {
    const t = await tenant();
    await t.invoice('HDM', '2026-07-05', M(100), 'V10', '01');
    await t.invoice('HDB', '2026-07-10', M(300), 'V10', '10');
    expect(err(await t.call('POST', '/api/tax/vat-returns', t.month(7, { overrides: { '36': '1' } })))).toEqual([400, 'VALIDATION']);
    const r = await t.create(t.month(7, { overrides: { '25': M(7) } }));
    expect(r.overrides).toEqual({ '25': M(7) });
    expect([r.values['25'], r.values['36'], r.values['40a']]).toEqual([M(7), M(23), M(23)]);
    const put = await t.call('PUT', `/api/tax/vat-returns/${r.id}`, { overrides: { '25': M(8) } });
    expect(put.json().values['36']).toBe(M(22));
    const audit = await sql<{ action: string; overrides: unknown }>`SELECT action, after->'overrides' AS overrides FROM audit_event WHERE tenant_id = ${t.tenantId}::uuid AND entity = 'tax_return' AND entity_id = ${String(r.id)} ORDER BY id`.execute(ctx.t.admin);
    expect(audit.rows).toEqual([{ action: 'insert', overrides: { '25': M(7) } }, { action: 'update', overrides: { '25': M(8) } }]);
  });

  it('thuế đầu vào dùng chung (nhóm 03) phân bổ theo doanh thu; cảnh báo thuế suất 8%', async () => {
    const t = await tenant();
    await t.invoice('HDM', '2026-07-05', M(60), 'V10', '03'); // thuế 6tr dùng chung
    await t.invoice('HDB', '2026-07-10', M(300), 'V8', '08'); // 8%: gộp tạm vào [32]/[33]
    await t.invoice('HDB', '2026-07-11', M(100), 'KCT', 'KCT');
    const r = await t.create(t.month(7));
    expect([r.values['24'], r.values['25'], r.values['32'], r.values['33']]).toEqual([M(6), String(4_500_000), M(300), M(24)]); // 6tr × 300/400
    expect(r.warnings.join(' ')).toContain('thuế suất 8%');
    expect(r.warnings.join(' ')).toContain('phân bổ thuế đầu vào dùng chung');
    expect(r.hints['25']).toContain('[27]/[34]');
  });

  it('kỳ khai theo quý: không lập tờ khai tháng; quyền chốt riêng', async () => {
    const t = await tenant();
    expect((await t.call('PUT', '/api/settings', { vat_period: 'quarter' })).statusCode).toBe(200);
    expect(err(await t.call('POST', '/api/tax/vat-returns', t.month(7)))).toEqual([400, 'VALIDATION']);
    await t.invoice('HDM', '2026-08-05', M(100), 'V10', '01');
    const q = await t.create({ year: 2026, periodKind: 'quarter', period: 3 });
    expect(q.values['24']).toBe(M(10));
    const username = `tk_${Date.now()}`;
    expect((await t.call('POST', '/api/users', { username, fullName: 'KT', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: [] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const vien = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    expect((await t.call('PUT', `/api/tax/vat-returns/${q.id}`, {}, vien)).statusCode).toBe(200);
    expect(err(await t.call('POST', `/api/tax/vat-returns/${q.id}/finalize`, undefined, vien))).toEqual([403, 'FORBIDDEN']);
  });
});
