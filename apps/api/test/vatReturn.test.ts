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
interface Ret { acknowledgedGates?: string[]; id: number; revision: number; status: string; templateVersion: string; values: Record<string, string>; overrides: Record<string, string>; hints: Record<string, string>; warnings: string[] }
const M = (x: number) => String(x * 1_000_000);

// Mỗi kiểm thử một công ty: năm 2026 theo TT133, khai thuế theo tháng (mặc định).
async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `VR${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  let no = 0;
  // items: [số tiền, mã thuế] mỗi dòng hàng; trả về phản hồi thô (kiểm lỗi).
  const post = (voucherType: 'HDB' | 'HDM', date: string, items: [string, string][], group: string) => {
    const sale = voucherType === 'HDB';
    return call('POST', '/api/invoices', { voucherType, postingDate: date, documentDate: date, partyCode: sale ? 'KH001' : 'NCC001', autoPost: true,
      items: items.map(([amount, taxCode]) => ({ description: 'Hàng', accountCode: sale ? '5113' : '6422', amountCurrency: amount, taxCodes: [taxCode] })),
      invoice: { serial: 'C26TAA', invoiceNo: String(++no).padStart(7, '0'), invoiceDate: date, invoiceGroupCode: group } });
  };
  const invoice = async (voucherType: 'HDB' | 'HDM', date: string, amount: string, taxCode: string, group: string) => {
    const r = await post(voucherType, date, [[amount, taxCode]], group); expect(r.statusCode, r.body).toBe(201); return r.json() as { id: string };
  };
  const setting = async (vatPeriod: 'month' | 'quarter') => expect((await call('PUT', '/api/settings', { vat_period: vatPeriod })).statusCode).toBe(200);
  const year2027 = async () => expect((await call('POST', '/api/fiscal-years', { fiscalYear: 2027, dateFrom: '2027-01-01', months: 12, regime: 'TT133' })).statusCode).toBe(201);
  const create = async (body: object): Promise<Ret> => { const r = await call('POST', '/api/tax/vat-returns', body); expect(r.statusCode, r.body).toBe(201); return r.json(); };
  const month = (period: number, more: object = {}) => ({ year: 2026, periodKind: 'month', period, ...more });
  const finalize = async (id: number): Promise<Ret> => { const r = await call('POST', `/api/tax/vat-returns/${id}/finalize`); expect(r.statusCode, r.body).toBe(200); return r.json(); };
  return { cookie, tenantId, call, post, invoice, create, month, finalize, setting, year2027 };
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
    // TT 89/2026 Phụ lục II điểm 3: [22] vẫn lấy tờ khai lần đầu; bổ sung làm giảm số chuyển kỳ sau 3tr thì khai [37] của kỳ phát hiện
    const aug = await t.create(t.month(8));
    expect(aug.values['22']).toBe(M(10));
    expect(aug.hints['22']).toContain('tờ khai lần đầu tháng 7/2026');
    await ctx.t.admin.transaction().execute(async (trx) => { // giả lập bổ sung chốt trong tháng 8 (kỳ phát hiện); trigger chặn sửa dòng đã chốt nên tắt trigger trong giao dịch này
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await sql`UPDATE tax_return SET finalized_at = '2026-08-15 10:00+07' WHERE id = ${r1.id}`.execute(trx);
    });
    const re = await t.call('PUT', `/api/tax/vat-returns/${aug.id}`, {});
    expect(re.statusCode, re.body).toBe(200);
    expect(re.json().hints['37']).toContain('Gợi ý 3000000');
    expect(re.json().hints['37']).toContain('tháng 7/2026 lần 1');
    expect(re.json().warnings.join(' ')).not.toContain('nhập tay không dùng'); // [22] đã lưu lấy từ kỳ trước, không phải nhập tay
    const adj = await t.call('PUT', `/api/tax/vat-returns/${aug.id}`, { manual: { '37': M(3) } });
    expect([adj.json().values['37'], adj.json().values['41'], adj.json().values['43']]).toEqual([M(3), M(7), M(7)]); // = [43] của tờ khai bổ sung
    const list = await t.call('GET', '/api/tax/vat-returns?year=2026');
    expect((list.json() as Ret[]).map((x) => [x.id, x.revision, x.status])).toEqual([[aug.id, 0, 'draft'], [r1.id, 1, 'final'], [r0.id, 0, 'final']]);
    expect((list.json() as { discovery: unknown }[]).map((x) => x.discovery)).toEqual([null, { year: 2026, periodKind: 'month', period: 8 }, null]); // kỳ phát hiện của bổ sung = kỳ chứa ngày chốt (15/8)
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
  it('chốt khóa đúng số đã thấy: sổ đổi sau lần tính thì 409 TAX_RETURN_STALE, không ghi gì; lưu lại nháp thì chốt được', async () => {
    const t = await tenant();
    await t.invoice('HDM', '2026-07-05', M(100), 'V10', '01');
    const r = await t.create(t.month(7));
    await t.invoice('HDM', '2026-07-06', M(20), 'V10', '01');
    const stale = await t.call('POST', `/api/tax/vat-returns/${r.id}/finalize`);
    expect(err(stale)).toEqual([409, 'TAX_RETURN_STALE']);
    expect(stale.json().error.details.changed).toEqual(expect.arrayContaining([{ code: '24', stored: M(10), fresh: M(12) }, { code: '43', stored: M(10), fresh: M(12) }]));
    expect((await t.call('GET', `/api/tax/vat-returns/${r.id}`)).json()).toMatchObject({ status: 'draft', values: { '24': M(10) } });
    expect((await t.call('PUT', `/api/tax/vat-returns/${r.id}`, {})).json().values['24']).toBe(M(12));
    expect((await t.finalize(r.id)).values['24']).toBe(M(12));
  });

  it('hóa đơn bán ra nhiều thuế suất: nhóm theo từng dòng mã thuế', async () => {
    const t = await tenant();
    expect((await t.post('HDB', '2026-07-10', [[M(100), 'V10'], [M(50), 'KCT']], '10')).statusCode).toBe(201);
    expect((await t.post('HDB', '2026-07-11', [[M(20), 'V5'], [M(30), 'V10']], '10')).statusCode).toBe(201);
    expect((await t.post('HDB', '2026-07-12', [[M(7), 'KKK'], [M(3), 'KCT']], 'KCT')).statusCode).toBe(201); // nhóm KCT không nhận dòng KKK
    expect((await t.post('HDB', '2026-07-13', [[M(9), 'KCT'], [M(1), 'V10']], 'NPV')).statusCode).toBe(201); // nhóm NPV nhận dòng KCT, dòng V10 sang nhóm 10
    const r = await t.create(t.month(7));
    expect([r.values['26'], r.values['30'], r.values['31'], r.values['32'], r.values['33'], r.values['32a'], r.values['34a']])
      .toEqual([M(53), M(20), M(1), M(131), String(13_100_000), M(7), M(9)]);
    await sql`DELETE FROM invoice_group WHERE tenant_id = ${t.tenantId}::uuid AND scope = 'sale' AND code = '00'`.execute(ctx.t.admin); // không còn nhóm 0%
    const bad = await t.post('HDB', '2026-07-14', [[M(20), 'V0']], '10');
    expect(err(bad)).toEqual([400, 'INVOICE_GROUP_MISMATCH']);
    expect(bad.json().error.message).toContain('Dòng thuế V0');
  });

  it('[22] qua mốc năm (tháng 12 → tháng 1, quý 4 → quý 1) và khi đổi kỳ khai tháng ↔ quý; cả tháng 12 lẫn quý 4 cùng chốt thì cảnh báo', async () => {
    const t = await tenant();
    await t.year2027();
    await t.invoice('HDM', '2026-10-05', M(50), 'V10', '01');
    await t.invoice('HDM', '2026-12-05', M(100), 'V10', '01');
    const dec = await t.create(t.month(12));
    await t.finalize(dec.id);
    expect(dec.values['43']).toBe(M(10));
    expect((await t.create({ year: 2027, periodKind: 'month', period: 1 })).values['22']).toBe(M(10)); // tháng 12 → tháng 1
    await t.setting('quarter');
    const q4 = await t.create({ year: 2026, periodKind: 'quarter', period: 4 });
    await t.finalize(q4.id);
    expect(q4.values['43']).toBe(M(15));
    const q1 = await t.create({ year: 2027, periodKind: 'quarter', period: 1 }); // quý 4 → quý 1: chọn tờ khai quý, cảnh báo có cả tháng 12
    expect(q1.values['22']).toBe(M(15));
    expect(q1.warnings.join(' ')).toContain('cả tờ khai tháng và tờ khai quý');
  });

  it('đổi kỳ khai: tháng 12 → quý 1 năm sau, quý 4 → tháng 1 năm sau; thuế suất 8% ngoài thời gian giảm thuế thì cảnh báo', async () => {
    const t = await tenant();
    await t.year2027();
    await t.invoice('HDM', '2026-12-05', M(100), 'V10', '01');
    await t.finalize((await t.create(t.month(12))).id);
    await t.setting('quarter');
    await t.invoice('HDB', '2027-01-10', M(100), 'V8', '08'); // 2027: hết hiệu lực vat_reduced_rate (31/12/2026)
    const q1 = await t.create({ year: 2027, periodKind: 'quarter', period: 1 });
    expect(q1.values['22']).toBe(M(10));
    expect(q1.warnings.join(' ')).toContain('ngoài thời gian giảm thuế GTGT');

    const u = await tenant();
    await u.year2027();
    await u.setting('quarter');
    await u.invoice('HDM', '2026-11-05', M(40), 'V10', '01');
    await u.finalize((await u.create({ year: 2026, periodKind: 'quarter', period: 4 })).id);
    await u.setting('month');
    expect((await u.create({ year: 2027, periodKind: 'month', period: 1 })).values['22']).toBe(M(4));
  });

  it('ghi đè được số âm', async () => {
    const t = await tenant();
    const r = await t.create(t.month(7, { overrides: { '25': '-5' } }));
    expect([r.values['25'], r.values['36']]).toEqual(['-5', '5']);
    expect(err(await t.call('POST', '/api/tax/vat-returns', t.month(8, { manual: { '37': '-5' } })))).toEqual([400, 'VALIDATION']); // nhập tay vẫn không âm
  });

  it('xóa tờ khai nháp: được và ghi audit; đã chốt 409 TAX_RETURN_FINAL; không có quyền 403; không thấy 404; sau khi xóa lập lại kỳ được', async () => {
    const t = await tenant();
    await t.invoice('HDM', '2026-07-05', M(100), 'V10', '01');
    const d = await t.create(t.month(7));
    const username = `xd_${Date.now()}`;
    expect((await t.call('POST', '/api/users', { username, fullName: 'KT', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: [] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const vien = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    // vai trò 'xem' không có tax_return.delete
    expect(err(await t.call('DELETE', `/api/tax/vat-returns/${d.id}`, undefined, vien))).toEqual([403, 'FORBIDDEN']);
    expect((await t.call('DELETE', `/api/tax/vat-returns/${d.id}`)).statusCode).toBe(204);
    expect(err(await t.call('GET', `/api/tax/vat-returns/${d.id}`))).toEqual([404, 'TAX_RETURN_NOT_FOUND']);
    expect(err(await t.call('DELETE', `/api/tax/vat-returns/${d.id}`))).toEqual([404, 'TAX_RETURN_NOT_FOUND']);
    const audit = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = ${t.tenantId}::uuid AND entity = 'tax_return' AND entity_id = ${String(d.id)} AND action = 'delete'`.execute(ctx.t.admin)).rows[0]!.n;
    expect(audit).toBe(1);
    const again = await t.create(t.month(7));
    await t.finalize(again.id);
    expect(err(await t.call('DELETE', `/api/tax/vat-returns/${again.id}`))).toEqual([409, 'TAX_RETURN_FINAL']);
  });

  it('hai yêu cầu lập tờ khai cùng kỳ đồng thời: một 201, bên kia 409 TAX_RETURN_DRAFT_EXISTS (không phải DUPLICATE chung)', async () => {
    const t = await tenant();
    const [a, b] = await Promise.all([t.call('POST', '/api/tax/vat-returns', t.month(9)), t.call('POST', '/api/tax/vat-returns', t.month(9))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(err([a, b].find((r) => r.statusCode === 409)!)).toEqual([409, 'TAX_RETURN_DRAFT_EXISTS']);
  });
  // GĐ7 gói 2 (C3): cổng 01GTGT_TT89_rate8 = false không còn là cảnh báo suông.
  it('hóa đơn bán ra 8%: chốt phải xác nhận rõ (409 VAT_RATE8_UNVERIFIED), xác nhận được lưu; kỳ không có 8% chốt bình thường', async () => {
    const t = await tenant();
    await t.invoice('HDB', '2026-07-10', M(300), 'V8', '08');
    const r = await t.create(t.month(7));
    const no = await t.call('POST', `/api/tax/vat-returns/${r.id}/finalize`);
    expect(err(no)).toEqual([409, 'VAT_RATE8_UNVERIFIED']);
    expect((await t.call('GET', `/api/tax/vat-returns/${r.id}`)).json().status).toBe('draft');
    expect((await t.call('POST', `/api/tax/vat-returns/${r.id}/finalize`, { acknowledge: [] })).statusCode).toBe(409);
    const ok = await t.call('POST', `/api/tax/vat-returns/${r.id}/finalize`, { acknowledge: ['rate8_unverified'] });
    expect(ok.statusCode, ok.body).toBe(200); expect(ok.json().acknowledgedGates).toEqual(['rate8_unverified']);
    await sql`UPDATE tenant SET tax_code = '0101234567', address = 'Số 1' WHERE id = ${t.tenantId}::uuid`.execute(ctx.t.admin);
    const xml = await t.call('GET', `/api/tax/vat-returns/${r.id}/xml`); expect(xml.statusCode, xml.body).toBe(200); // đã xác nhận: xuất được
    const audit = await sql<{ n: string }>`SELECT count(*)::text AS n FROM audit_event WHERE tenant_id = ${t.tenantId}::uuid AND entity = 'tax_return' AND entity_id = ${String(r.id)} AND after::text LIKE '%rate8_unverified%'`.execute(ctx.t.admin);
    expect(Number(audit.rows[0]!.n)).toBeGreaterThan(0);
    const u = await tenant();
    await u.invoice('HDB', '2026-07-10', M(300), 'V10', '10');
    const clean = await u.finalize((await u.create(u.month(7))).id);
    expect(clean.acknowledgedGates).toEqual([]);
  });

  it('tờ khai chốt khi chưa có xác nhận (dữ liệu cũ) có hóa đơn 8%: xuất XML bị chặn', async () => {
    const t = await tenant();
    await t.invoice('HDB', '2026-07-10', M(300), 'V8', '08');
    const r = await t.create(t.month(7));
    await t.call('POST', `/api/tax/vat-returns/${r.id}/finalize`, { acknowledge: ['rate8_unverified'] });
    await sql`ALTER TABLE tax_return DISABLE TRIGGER trg_tax_return_final`.execute(ctx.t.admin);
    try { await sql`UPDATE tax_return SET acknowledged_gates = '{}' WHERE id = ${r.id}`.execute(ctx.t.admin); } finally { await sql`ALTER TABLE tax_return ENABLE TRIGGER trg_tax_return_final`.execute(ctx.t.admin); }
    expect(err(await t.call('GET', `/api/tax/vat-returns/${r.id}/xml`))).toEqual([409, 'VAT_RATE8_UNVERIFIED']);
  });
});
