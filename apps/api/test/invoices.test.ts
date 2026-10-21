import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql, type RawBuilder } from 'kysely';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Inv {
  id: string; voucherNo: string | null; state: string; version: number; dueDate: string | null; totalDebit: string;
  lines: { lineNo: number; accountCode: string; debit: string; credit: string; partyCode?: string | null; dueDate?: string | null }[];
  invoices: { id: number; taxCode: string | null; baseAmount: string; taxAmount: string; declareYear: number | null; declarePeriod: number | null; invoiceNo: string; adjustsInvoiceId: number | null }[];
  items: { lineNo: number; amount: string; discountAmount: string; taxAmount: string; taxCodes: string[]; accountCode: string }[];
}
const err = (r: Res) => [r.statusCode, r.json().error?.code];
// Dòng sổ gọn: [tài khoản, N|C, số tiền] theo số thứ tự dòng.
const shape = (v: Inv) => v.lines.map((l) => (l.debit !== '0' ? [l.accountCode, 'N', l.debit] : [l.accountCode, 'C', l.credit]));

// Mỗi kiểm thử một công ty riêng: năm 2026 theo TT133, đối tượng KH001, KH002, NCC001 (vừa là khách hàng vừa là nhà cung cấp).
async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `IV${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
  const admin = <T>(q: RawBuilder<T>) => q.execute(ctx.t.admin);
  const invoice = (voucherType: 'HDB' | 'HDM' | 'GGB' | 'GGM', more: object = {}, inv: object = {}) => {
    const sale = voucherType === 'HDB' || voucherType === 'GGB';
    return { voucherType, postingDate: '2026-03-10', documentDate: '2026-03-10', partyCode: sale ? 'KH001' : 'NCC001', autoPost: true,
      items: [{ description: 'Dịch vụ', accountCode: sale ? '5113' : '6422', amountCurrency: '10000000', taxCodes: ['V10'] }],
      invoice: { serial: 'C26TAA', invoiceNo: '0000001', invoiceDate: '2026-03-10', invoiceGroupCode: sale ? '10' : '01', ...inv }, ...more };
  };
  const create = async (body: object): Promise<Inv> => { const r = await call('POST', '/api/invoices', body); expect(r.statusCode, r.body).toBe(201); return r.json(); };
  const itemId = async (voucherId: string, accountCode: string) => (await sql<{ id: number }>`SELECT o.id::int AS id FROM open_item o JOIN account a ON a.id = o.account_id
    WHERE o.voucher_id = ${voucherId}::uuid AND a.code = ${accountCode} ORDER BY o.line_no LIMIT 1`.execute(ctx.t.admin)).rows[0]!.id;
  return { cookie, tenantId, call, admin, invoice, create, itemId };
}

describe('hóa đơn bán dịch vụ (HDB)', () => {
  it('hai dòng thuế 10% và 8% có chiết khấu: Có 5113 từng dòng, Có 33311 hai mức, Nợ 131 một dòng có hạn thanh toán', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDB', {
      dueDate: '2026-04-09',
      items: [{ description: 'Tư vấn', accountCode: '5113', amountCurrency: '10000000', discountCurrency: '500000', taxCodes: ['V10'] },
        { description: 'Đào tạo', accountCode: '5113', amountCurrency: '5000000', discountCurrency: '250000', taxCodes: ['V8'] }],
    }));
    expect(v.state).toBe('posted');
    expect(shape(v)).toEqual([['5113', 'C', '9500000'], ['5113', 'C', '4750000'], ['33311', 'C', '950000'], ['33311', 'C', '380000'], ['131', 'N', '15580000']]);
    const ar = v.lines.filter((l) => l.accountCode === '131');
    expect(ar).toHaveLength(1);
    expect(ar[0]).toMatchObject({ partyCode: 'KH001', dueDate: '2026-04-09' });
    expect(v.items.map((i) => [i.lineNo, i.amount, i.discountAmount, i.taxAmount])).toEqual([[1, '10000000', '500000', '950000'], [2, '5000000', '250000', '380000']]);
    const due = (await t.admin(sql`SELECT due_date::text FROM open_item WHERE voucher_id = ${v.id}::uuid`)).rows as { due_date: string }[];
    expect(due).toEqual([{ due_date: '2026-04-09' }]);
  });

  it('hạn thanh toán mặc định theo số ngày nợ của khách; truyền dueDate null thì không có hạn', async () => {
    const t = await tenant();
    await t.admin(sql`UPDATE party SET payment_term_days = 30 WHERE tenant_id = ${t.tenantId}::uuid AND code = 'KH001'`);
    const a = await t.create(t.invoice('HDB'));
    expect(a.dueDate).toBe('2026-04-09');
    expect(a.lines.find((l) => l.accountCode === '131')!.dueDate).toBe('2026-04-09');
    const b = await t.create(t.invoice('HDB', { dueDate: null }, { invoiceNo: '0000002' }));
    expect(b.dueDate).toBeNull();
  });

  it('bảng kê: một dòng mỗi mức thuế, cơ sở và thuế khớp bút toán, kỳ kê khai theo tháng hoặc quý', async () => {
    const t = await tenant();
    const body = t.invoice('HDB', { items: [
      { accountCode: '5113', amountCurrency: '10000000', discountCurrency: '500000', taxCodes: ['V10'] },
      { accountCode: '5113', amountCurrency: '5000000', discountCurrency: '250000', taxCodes: ['V8'] }] });
    const v = await t.create(body);
    const byCode = Object.fromEntries(v.invoices.map((i) => [i.taxCode, i]));
    expect(v.invoices).toHaveLength(2);
    expect(byCode.V10).toMatchObject({ baseAmount: '9500000', taxAmount: '950000', declareYear: 2026, declarePeriod: 3, invoiceNo: '0000001' });
    expect(byCode.V8).toMatchObject({ baseAmount: '4750000', taxAmount: '380000', declareYear: 2026, declarePeriod: 3 });
    const sum = (f: (i: Inv['invoices'][number]) => string) => v.invoices.reduce((s, i) => s + BigInt(f(i)), 0n);
    const credit = (acc: string) => v.lines.filter((l) => l.accountCode === acc).reduce((s, l) => s + BigInt(l.credit), 0n);
    expect(sum((i) => i.baseAmount)).toBe(credit('5113'));
    expect(sum((i) => i.taxAmount)).toBe(credit('33311'));

    expect((await t.call('PUT', '/api/settings', { vat_period: 'quarter' })).statusCode).toBe(200);
    const q = await t.create({ ...body, invoice: { ...body.invoice, invoiceNo: '0000002', invoiceDate: '2026-05-20' }, postingDate: '2026-05-20', documentDate: '2026-05-20' });
    expect(q.invoices.map((i) => i.declarePeriod)).toEqual([2, 2]); // tháng 5 thuộc quý 2
  });

  it('thuế ghi trên hóa đơn lệch tối đa một đồng mỗi dòng thì dồn vào dòng thuế, lệch hơn thì 400', async () => {
    const t = await tenant();
    const body = t.invoice('HDB', { items: [{ accountCode: '5113', amountCurrency: '1000003', taxCodes: ['V10'] }] });
    const bad = await t.call('POST', '/api/invoices', { ...body, invoice: { ...body.invoice, declaredTax: { V10: '100005' } } });
    expect(err(bad)).toEqual([400, 'TAX_DECLARED_MISMATCH']);
    const v = await t.create({ ...body, invoice: { ...body.invoice, declaredTax: { V10: '100001' } } });
    expect(shape(v)).toEqual([['5113', 'C', '1000003'], ['33311', 'C', '100001'], ['131', 'N', '1100004']]);
    expect(v.invoices[0]).toMatchObject({ baseAmount: '1000003', taxAmount: '100001' });
  });

  it('gửi lại cùng idempotencyKey trả đúng hóa đơn cũ, không ghi thêm dòng hàng', async () => {
    const t = await tenant();
    const body = t.invoice('HDB', { idempotencyKey: `iv-${Date.now()}-${n}` });
    const a = await t.create(body); const b = await t.create(body);
    expect(b.id).toBe(a.id);
    const rows = (await t.admin(sql`SELECT count(*)::int AS c FROM voucher_item_line WHERE voucher_id = ${a.id}::uuid`)).rows as { c: number }[];
    expect(rows[0]!.c).toBe(1);
    const invs = (await t.admin(sql`SELECT count(*)::int AS c FROM voucher_invoice WHERE voucher_id = ${a.id}::uuid`)).rows as { c: number }[];
    expect(invs[0]!.c).toBe(1);
  });

  it('GET /api/invoices/:id trả dòng hàng và bảng kê; chứng từ không phải hóa đơn thì 404', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDB'));
    const g = await t.call('GET', `/api/invoices/${v.id}`);
    expect(g.statusCode).toBe(200);
    expect(g.json().items).toHaveLength(1);
    expect(g.json().invoices).toHaveLength(1);
    const pkt = await t.call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-03-10', documentDate: '2026-03-10', autoPost: true,
      lines: [{ accountCode: '1111', debit: '10', credit: '0' }, { accountCode: '5113', debit: '0', credit: '10' }] });
    expect(pkt.statusCode, pkt.body).toBe(201);
    expect(err(await t.call('GET', `/api/invoices/${pkt.json().id}`))).toEqual([404, 'INVOICE_NOT_FOUND']);
  });

  it('lập HDB qua route chứng từ chung bị chặn, khai bảng kê trên loại chứng từ khác PC/BN/PKT bị từ chối', async () => {
    const t = await tenant();
    const lines = [{ accountCode: '131', partyCode: 'KH001', debit: '100', credit: '0' }, { accountCode: '5113', debit: '0', credit: '100' }];
    const r = await t.call('POST', '/api/vouchers', { voucherType: 'HDB', postingDate: '2026-03-10', documentDate: '2026-03-10', lines });
    expect(err(r)).toEqual([409, 'VOUCHER_TYPE_USE_INVOICE']);
    const pt = await t.call('POST', '/api/vouchers', { voucherType: 'PT', postingDate: '2026-03-10', documentDate: '2026-03-10', lines: [{ accountCode: '1111', debit: '100', credit: '0' }, { accountCode: '131', partyCode: 'KH001', debit: '0', credit: '100' }],
      invoices: [{ invoiceNo: '1', invoiceDate: '2026-03-10', invoiceGroupCode: '01', taxCode: 'V10', baseAmount: '100', taxAmount: '10' }] });
    expect(err(pt)).toEqual([400, 'VALIDATION']);
  });
});

describe('hóa đơn mua dịch vụ (HDM) và thuế TNCN khấu trừ', () => {
  it('mua của cá nhân 10.000.000 khấu trừ TNCN 10%: Nợ 6422 10tr, Có 3335 1tr, Có 331 9tr', async () => {
    const t = await tenant();
    const body = t.invoice('HDM', { items: [{ accountCode: '6422', amountCurrency: '10000000', taxCodes: ['TNCN_KT'] }] });
    // Mã TNCN_KT chưa nhập thuế suất: chặn ngay, không đoán.
    expect(err(await t.call('POST', '/api/invoices', body))).toEqual([400, 'TAX_RATE_MISSING']);
    await t.admin(sql`UPDATE tax_code SET rate = 10 WHERE tenant_id = ${t.tenantId}::uuid AND code = 'TNCN_KT'`);
    const v = await t.create(body);
    expect(shape(v)).toEqual([['6422', 'N', '10000000'], ['3335', 'C', '1000000'], ['331', 'C', '9000000']]);
    expect(v.lines.find((l) => l.accountCode === '331')).toMatchObject({ partyCode: 'NCC001' });
  });

  it('mua có GTGT 10%: Nợ 6422 và Nợ 1331, Có 331', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDM'));
    expect(shape(v)).toEqual([['6422', 'N', '10000000'], ['1331', 'N', '1000000'], ['331', 'C', '11000000']]);
    expect(v.invoices).toHaveLength(1);
    expect(v.invoices[0]).toMatchObject({ taxCode: 'V10', baseAmount: '10000000', taxAmount: '1000000' });
  });

  it('mã thuế chỉ dùng cho chiều bán không dùng được trên hóa đơn mua (và ngược lại): 400 TAX_SCOPE_MISMATCH', async () => {
    const t = await tenant();
    await t.admin(sql`UPDATE tax_code SET scope = 'sale' WHERE tenant_id = ${t.tenantId}::uuid AND code = 'V10'`);
    const r = await t.call('POST', '/api/invoices', t.invoice('HDM'));
    expect(err(r)).toEqual([400, 'TAX_SCOPE_MISMATCH']);
    expect(r.json().error.message).toContain('V10');
    await t.create(t.invoice('HDB')); // đúng chiều bán thì nhập được
    await t.admin(sql`UPDATE tax_code SET scope = 'purchase' WHERE tenant_id = ${t.tenantId}::uuid AND code = 'V10'`);
    expect(err(await t.call('POST', '/api/invoices', t.invoice('HDB', {}, { invoiceNo: '0000009' })))).toEqual([400, 'TAX_SCOPE_MISMATCH']);
  });

  it('mã thuế không có trong danh mục thì 404 TAX_CODE_UNKNOWN', async () => {
    const t = await tenant();
    const r = await t.call('POST', '/api/invoices', t.invoice('HDM', { items: [{ accountCode: '6422', amountCurrency: '1000', taxCodes: ['KHONGCO'] }] }));
    expect(err(r)).toEqual([404, 'TAX_CODE_UNKNOWN']);
  });
});

describe('kiểm tra trùng hóa đơn đầu vào', () => {
  async function withTaxCode() {
    const t = await tenant();
    await t.admin(sql`UPDATE party SET tax_code = '0312345678' WHERE tenant_id = ${t.tenantId}::uuid AND code = 'NCC001'`);
    const pc = (invoices: object[], date = '2026-03-12') => t.call('POST', '/api/vouchers', { voucherType: 'PC', postingDate: date, documentDate: date, partyCode: 'NCC001', autoPost: true,
      lines: [{ accountCode: '6422', debit: '10000000', credit: '0' }, { accountCode: '1331', debit: '1000000', credit: '0' }, { accountCode: '1111', debit: '0', credit: '11000000' }], invoices });
    const decl = (serial: string, invoiceNo: string) => ({ serial, invoiceNo, invoiceDate: '2026-03-05', partyCode: 'NCC001', invoiceGroupCode: '01', taxCode: 'V10', baseAmount: '10000000', taxAmount: '1000000' });
    return { ...t, pc, decl };
  }

  it('hóa đơn đã nhập ở HDM, khai lại trên PC (khác hoa thường và khoảng trắng): 409 INVOICE_DUPLICATE nêu số chứng từ HDM', async () => {
    const t = await withTaxCode();
    const hdm = await t.create(t.invoice('HDM', {}, { serial: 'AB/26E', invoiceNo: '0000123', invoiceDate: '2026-03-05' }));
    const r = await t.pc([t.decl('ab/26e', '00 00123')]);
    expect(err(r)).toEqual([409, 'INVOICE_DUPLICATE']);
    expect(r.json().error.message).toContain(hdm.voucherNo);
    // Số hóa đơn khác thì nhập được, bảng kê lưu kèm chứng từ.
    const ok = await t.pc([t.decl('AB/26E', '0000124')]);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().invoices).toHaveLength(1);
    expect(ok.json().invoices[0]).toMatchObject({ direction: 'purchase', invoiceNo: '0000124', declareYear: 2026, declarePeriod: 3, taxCode: 'V10' });
  });

  it('chứng từ nháp vẫn chặn, chứng từ đã hủy thì không chặn', async () => {
    const t = await withTaxCode();
    const draft = await t.create(t.invoice('HDM', { autoPost: false }, { serial: 'AB/26E', invoiceNo: '0000200', invoiceDate: '2026-03-05' }));
    expect(draft.state).toBe('draft');
    expect(err(await t.pc([t.decl('AB/26E', '0000200')]))).toEqual([409, 'INVOICE_DUPLICATE']);
    const d = await t.call('POST', `/api/vouchers/${draft.id}/discard`);
    expect(d.statusCode, d.body).toBe(200);
    const ok = await t.pc([t.decl('AB/26E', '0000200')]);
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('chứng từ đã đảo thì không chặn: nhập lại đúng hóa đơn đó ở HDM mới được, chứng từ đảo không mang dòng kê khai', async () => {
    const t = await withTaxCode();
    const first = await t.create(t.invoice('HDM', {}, { serial: 'AB/26E', invoiceNo: '0000400', invoiceDate: '2026-03-05' }));
    expect(err(await t.call('POST', '/api/invoices', t.invoice('HDM', {}, { serial: 'AB/26E', invoiceNo: '0000400', invoiceDate: '2026-03-05' })))).toEqual([409, 'INVOICE_DUPLICATE']);
    const rev = await t.call('POST', `/api/vouchers/${first.id}/reverse`, { postingDate: '2026-03-15' });
    expect(rev.statusCode, rev.body).toBe(201);
    const left = (await t.admin(sql`SELECT count(*)::int AS n FROM voucher_invoice WHERE voucher_id = ${rev.json().id}::uuid`)).rows as { n: number }[];
    expect(left[0]!.n).toBe(0);
    expect((await t.call('GET', `/api/vouchers/${first.id}`)).json().state).toBe('reversed');
    const again = await t.create(t.invoice('HDM', {}, { serial: 'AB/26E', invoiceNo: '0000400', invoiceDate: '2026-03-05' }));
    expect(again.invoices[0]).toMatchObject({ invoiceNo: '0000400' });
    expect(err(await t.pc([t.decl('AB/26E', '0000400')]))).toEqual([409, 'INVOICE_DUPLICATE']); // bản nhập lại là chứng từ còn hiệu lực nên chặn tiếp
  });

  it('cùng số hóa đơn hai lần trong một chứng từ cùng mã thuế bị chặn, khác mã thuế thì được', async () => {
    const t = await withTaxCode();
    expect(err(await t.pc([t.decl('AB/26E', '0000300'), t.decl('AB/26E', '0000300')]))).toEqual([409, 'INVOICE_DUPLICATE']);
    const ok = await t.pc([t.decl('AB/26E', '0000301'), { ...t.decl('AB/26E', '0000301'), taxCode: 'V8', baseAmount: '1', taxAmount: '0' }]);
    expect(ok.statusCode, ok.body).toBe(201);
  });
});

describe('sửa hóa đơn đã ghi sổ', () => {
  it('chứng từ đã ghi sổ: sửa qua API bị chặn VOUCHER_CHILD_IMMUTABLE, ghi thẳng vào bảng con cũng bị trigger chặn; bỏ ghi sổ rồi sửa được', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDB'));
    const put = (amount: string, version: number) => t.call('PUT', `/api/invoices/${v.id}`, { ...t.invoice('HDB', {}, {}), items: [{ accountCode: '5113', amountCurrency: amount, taxCodes: ['V10'] }], version });
    expect(err(await put('20000000', v.version))).toEqual([409, 'VOUCHER_CHILD_IMMUTABLE']);

    await expect(t.admin(sql`UPDATE voucher_invoice SET note = 'x' WHERE voucher_id = ${v.id}::uuid`)).rejects.toThrow(/VOUCHER_CHILD_IMMUTABLE/);
    await expect(t.admin(sql`DELETE FROM voucher_item_line WHERE voucher_id = ${v.id}::uuid`)).rejects.toThrow(/VOUCHER_CHILD_IMMUTABLE/);
    await expect(t.admin(sql`DELETE FROM voucher_invoice WHERE voucher_id = ${v.id}::uuid`)).rejects.toThrow(/VOUCHER_CHILD_IMMUTABLE/);

    const un = await t.call('POST', `/api/vouchers/${v.id}/unpost`);
    expect(un.statusCode, un.body).toBe(200);
    const cur = (await t.call('GET', `/api/invoices/${v.id}`)).json() as Inv;
    expect(cur.state).toBe('draft');
    const ok = await put('20000000', cur.version);
    expect(ok.statusCode, ok.body).toBe(200);
    const after = ok.json() as Inv;
    expect(shape(after)).toEqual([['5113', 'C', '20000000'], ['33311', 'C', '2000000'], ['131', 'N', '22000000']]);
    expect(after.items.map((i) => i.amount)).toEqual(['20000000']);
    expect(after.invoices).toHaveLength(1);
    expect(after.invoices[0]).toMatchObject({ baseAmount: '20000000', taxAmount: '2000000' });
  });

  it('hóa đơn nháp không sửa được qua route chung: đổi sang PKT hay giữ nguyên loại đều 409 VOUCHER_TYPE_USE_INVOICE, dòng hàng còn nguyên', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDB', { autoPost: false }));
    expect(v.state).toBe('draft');
    const lines = [{ accountCode: '1111', debit: '10', credit: '0' }, { accountCode: '5113', debit: '0', credit: '10' }];
    for (const voucherType of ['PKT', 'HDB']) {
      const r = await t.call('PUT', `/api/vouchers/${v.id}`, { voucherType, postingDate: '2026-03-10', documentDate: '2026-03-10', lines, version: v.version });
      expect(err(r), voucherType).toEqual([409, 'VOUCHER_TYPE_USE_INVOICE']);
    }
    const after = (await t.call('GET', `/api/invoices/${v.id}`)).json() as Inv;
    expect(after.items).toHaveLength(1);
    expect(after.invoices).toHaveLength(1);
    // chiều ngược lại: phiếu kế toán thường không chuyển thành hóa đơn
    const pkt = await t.call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-03-10', documentDate: '2026-03-10', lines });
    expect(err(await t.call('PUT', `/api/vouchers/${pkt.json().id}`, { voucherType: 'HDB', postingDate: '2026-03-10', documentDate: '2026-03-10', lines, version: pkt.json().version }))).toEqual([409, 'VOUCHER_TYPE_USE_INVOICE']);
  });

  it('bảng kê không nhận số tiền âm (CHECK base_amount, tax_amount)', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDB', { autoPost: false }));
    await expect(t.admin(sql`UPDATE voucher_invoice SET base_amount = -1 WHERE voucher_id = ${v.id}::uuid`)).rejects.toThrow(/voucher_invoice_base_amount_check/);
    await expect(t.admin(sql`UPDATE voucher_invoice SET tax_amount = -1 WHERE voucher_id = ${v.id}::uuid`)).rejects.toThrow(/voucher_invoice_tax_amount_check/);
  });

  it('sửa không đúng loại chứng từ: PUT /api/invoices cho phiếu thường thì 404', async () => {
    const t = await tenant();
    const pkt = await t.call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-03-10', documentDate: '2026-03-10',
      lines: [{ accountCode: '1111', debit: '10', credit: '0' }, { accountCode: '5113', debit: '0', credit: '10' }] });
    expect(pkt.statusCode, pkt.body).toBe(201);
    const r = await t.call('PUT', `/api/invoices/${pkt.json().id}`, { ...t.invoice('HDB'), version: pkt.json().version });
    expect(err(r)).toEqual([404, 'INVOICE_NOT_FOUND']);
  });
});

describe('giảm giá và hàng bán trả lại (GGB, GGM)', () => {
  it('GGB một phần hóa đơn bán: bút toán ngược, khoản Có đối trừ được với khoản Nợ của hóa đơn gốc', async () => {
    const t = await tenant();
    const orig = await t.create(t.invoice('HDB'));
    const origInvId = orig.invoices[0]!.id;
    const gg = await t.create(t.invoice('GGB', { items: [{ description: 'Giảm giá', accountCode: '5113', amountCurrency: '2000000', taxCodes: ['V10'] }] },
      { serial: 'C26TBB', invoiceNo: '0000002', adjustsInvoiceId: origInvId }));
    expect(shape(gg)).toEqual([['5113', 'N', '2000000'], ['33311', 'N', '200000'], ['131', 'C', '2200000']]);
    expect(gg.invoices[0]).toMatchObject({ baseAmount: '2000000', taxAmount: '200000', adjustsInvoiceId: origInvId });

    const debitItem = await t.itemId(orig.id, '131'); const creditItem = await t.itemId(gg.id, '131');
    const s = await t.call('POST', '/api/settlements', { debitItemId: debitItem, creditItemId: creditItem, amount: '2200000' });
    expect(s.statusCode, s.body).toBe(201);
    const res = (await t.admin(sql`SELECT item_id::int AS id, residual::text AS residual FROM fn_open_items_at(${t.tenantId}::uuid, '2026-12-31') WHERE item_id IN (${debitItem}, ${creditItem}) ORDER BY item_id`)).rows as { id: number; residual: string }[];
    expect(Object.fromEntries(res.map((r) => [r.id, r.residual]))).toEqual({ [debitItem]: '8800000', [creditItem]: '0' });
  });

  it('giảm giá, trả lại không mặc định hạn thanh toán theo đối tượng (tránh quá hạn giả); truyền dueDate thì giữ', async () => {
    const t = await tenant();
    await t.admin(sql`UPDATE party SET payment_term_days = 30 WHERE tenant_id = ${t.tenantId}::uuid AND code = 'KH001'`);
    const orig = await t.create(t.invoice('HDB'));
    expect(orig.dueDate).toBe('2026-04-09');
    const item = { accountCode: '5113', amountCurrency: '1000000', taxCodes: ['V10'] };
    const gg = await t.create(t.invoice('GGB', { items: [item] }, { serial: 'C26TBB', invoiceNo: '0000002', adjustsInvoiceId: orig.invoices[0]!.id }));
    expect(gg.dueDate).toBeNull();
    expect(gg.lines.find((l) => l.accountCode === '131')!.dueDate ?? null).toBeNull();
    const gg2 = await t.create(t.invoice('GGB', { items: [item], dueDate: '2026-05-01' }, { serial: 'C26TBB', invoiceNo: '0000003', adjustsInvoiceId: orig.invoices[0]!.id }));
    expect(gg2.dueDate).toBe('2026-05-01');
  });

  it('GGM: Nợ 331, Có 1331 và Có chi phí', async () => {
    const t = await tenant();
    const orig = await t.create(t.invoice('HDM'));
    const gg = await t.create(t.invoice('GGM', { items: [{ accountCode: '6422', amountCurrency: '1000000', taxCodes: ['V10'] }] }, { invoiceNo: '0000002', adjustsInvoiceId: orig.invoices[0]!.id }));
    expect(shape(gg)).toEqual([['6422', 'C', '1000000'], ['1331', 'C', '100000'], ['331', 'N', '1100000']]);
  });

  it('hóa đơn gốc của đối tượng khác, của chiều khác, hoặc thiếu: bị từ chối', async () => {
    const t = await tenant();
    const other = await t.create(t.invoice('HDB', { partyCode: 'KH002' }));
    const buy = await t.create(t.invoice('HDM', {}, { invoiceNo: '0000009' }));
    const gg = (adjusts: number, extra: object = {}) => t.call('POST', '/api/invoices', t.invoice('GGB', extra, { invoiceNo: '0000010', adjustsInvoiceId: adjusts }));
    expect(err(await gg(other.invoices[0]!.id))).toEqual([404, 'INVOICE_NOT_FOUND']); // khác đối tượng
    expect(err(await gg(buy.invoices[0]!.id))).toEqual([404, 'INVOICE_NOT_FOUND']); // khác chiều
    expect(err(await gg(999999999))).toEqual([404, 'INVOICE_NOT_FOUND']);
    expect(err(await t.call('POST', '/api/invoices', t.invoice('GGB')))).toEqual([400, 'VALIDATION']); // thiếu hóa đơn gốc
    expect(err(await t.call('POST', '/api/invoices', t.invoice('HDB', {}, { invoiceNo: '0000011', adjustsInvoiceId: other.invoices[0]!.id })))).toEqual([400, 'VALIDATION']);
  });
});

describe('hóa đơn ngoại tệ: chia chênh làm tròn một đồng mỗi dòng', () => {
  const sums = (v: Inv) => {
    const s = (acc: string[], side: 'debit' | 'credit') => v.lines.filter((l) => acc.includes(l.accountCode)).reduce((x, l) => x + BigInt(l[side]), 0n);
    return { debit: v.lines.reduce((x, l) => x + BigInt(l.debit), 0n), credit: v.lines.reduce((x, l) => x + BigInt(l.credit), 0n), base: s(['6422'], 'debit'), tax: s(['1331'], 'debit') };
  };

  it('USD 1,00 + 3,00 + 1,00 tỷ giá 1,5 không thuế: chi phí 2, 4, 2 và Có 331 là 8; bảng kê khớp', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDM', { currencyCode: 'USD', fxRate: '1.5', items: [
      { accountCode: '6422', amountCurrency: '1.00', taxCodes: [] }, { accountCode: '6422', amountCurrency: '3.00', taxCodes: [] }, { accountCode: '6422', amountCurrency: '1.00', taxCodes: [] }] }));
    expect(shape(v)).toEqual([['6422', 'N', '2'], ['6422', 'N', '4'], ['6422', 'N', '2'], ['331', 'C', '8']]);
    expect(v.invoices).toHaveLength(1);
    expect(v.invoices[0]).toMatchObject({ taxCode: null, baseAmount: '8', taxAmount: '0' });
  });

  it('USD có thuế ghi trên hóa đơn: lệch quy đổi tối đa 1 đồng thì ghi đúng số trên hóa đơn (dòng thuế, dòng hàng, bảng kê khớp), lệch hơn thì 400', async () => {
    const t = await tenant();
    // 3 dòng 33,33 + 33,33 + 33,34 USD × 25.432,5: thuế 10% = 9,99 USD = 254.071 đồng (tổng từng dòng 254.070)
    const body = t.invoice('HDB', { currencyCode: 'USD', fxRate: '25432.5', items: ['33.33', '33.33', '33.34'].map((a) => ({ accountCode: '5113', amountCurrency: a, taxCodes: ['V10'] })) });
    for (const declared of ['254073', '254069']) {
      expect(err(await t.call('POST', '/api/invoices', { ...body, invoice: { ...body.invoice, declaredTax: { V10: declared } } })), declared).toEqual([400, 'TAX_DECLARED_MISMATCH']);
    }
    // không khai số trên hóa đơn: dòng thuế 254.071 (quy đổi từ nguyên tệ) còn tổng thuế từng dòng theo VND là 254.070, phần lệch dồn vào dòng hàng để khớp
    const plain = await t.create({ ...body, invoice: { ...body.invoice, invoiceNo: 'D9' } });
    expect(plain.lines.find((l) => l.accountCode === '33311')!.credit).toBe('254071');
    expect(plain.items.reduce((x, it) => x + BigInt(it.taxAmount), 0n)).toBe(254071n);
    expect(plain.invoices[0]!.taxAmount).toBe('254071');
    for (const [i, declared] of ['254072', '254070'].entries()) {
      const v = await t.create({ ...body, invoice: { ...body.invoice, invoiceNo: `D${i}`, declaredTax: { V10: declared } } });
      const tax = v.lines.find((l) => l.accountCode === '33311')!;
      expect(tax.credit, declared).toBe(declared);
      expect(v.lines.reduce((x, l) => x + BigInt(l.debit), 0n)).toBe(v.lines.reduce((x, l) => x + BigInt(l.credit), 0n));
      expect(v.invoices).toHaveLength(1);
      expect(v.invoices[0]!.taxAmount).toBe(declared);
      expect(v.items.reduce((x, it) => x + BigInt(it.taxAmount), 0n).toString()).toBe(declared); // tổng thuế các dòng hàng bằng dòng thuế đã ghi sổ
      expect(BigInt(v.invoices[0]!.baseAmount) + BigInt(declared)).toBe(BigInt(v.lines.find((l) => l.accountCode === '131')!.debit));
    }
  });

  it('USD một dòng cơ sở + V8 ghi trên hóa đơn + TNCN 10%: chênh làm tròn 2 đồng vượt số dòng cơ sở thì chia tiếp cho dòng TNCN, không lỗi 500', async () => {
    const t = await tenant();
    await t.admin(sql`UPDATE tax_code SET rate = 10 WHERE tenant_id = ${t.tenantId}::uuid AND code = 'TNCN_KT'`);
    // 6,49 USD × 3.988,66: V8 quy đổi 2.074, ghi trên hóa đơn 2.073 (dòng cố định); cơ sở nhích +1 (25.887), dòng TNCN nhích +1 (2.592), công nợ giữ nguyên 25.368
    const v = await t.create(t.invoice('HDM', { currencyCode: 'USD', fxRate: '3988.66', items: [{ accountCode: '6422', amountCurrency: '6.49', taxCodes: ['V8', 'TNCN_KT'] }] }, { declaredTax: { V8: '2073' } }));
    expect(shape(v)).toEqual([['6422', 'N', '25887'], ['1331', 'N', '2073'], ['3335', 'C', '2592'], ['331', 'C', '25368']]);
    expect(v.items[0]!.taxAmount).toBe('2073'); // chỉ thuế GTGT, không kể thuế khấu trừ
    expect(v.invoices).toHaveLength(1);
    expect(v.invoices[0]).toMatchObject({ taxCode: 'V8', baseAmount: '25887', taxAmount: '2073' });
  });

  it('USD một dòng 1.000,10 + V10 ghi trên hóa đơn 2.543.503 (quy đổi 2.543.504): ghi được, dòng cơ sở và dòng công nợ mỗi dòng nhích 1 đồng', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDB', { currencyCode: 'USD', fxRate: '25432.5', items: [{ accountCode: '5113', amountCurrency: '1000.10', taxCodes: ['V10'] }] }, { declaredTax: { V10: '2543503' } }));
    expect(shape(v)).toEqual([['5113', 'C', '25435044'], ['33311', 'C', '2543503'], ['131', 'N', '27978547']]); // cơ sở 25.435.043 + 1, công nợ 27.978.548 - 1
    expect(v.invoices[0]).toMatchObject({ taxCode: 'V10', baseAmount: '25435044', taxAmount: '2543503' });
    expect(v.items[0]!.taxAmount).toBe('2543503');
    expect(v.state).toBe('posted');
  });

  it('một dòng hàng có hai mã GTGT: 400 INVOICE_LINE_MULTIPLE_VAT; GTGT cùng TNCN khấu trừ vẫn được', async () => {
    const t = await tenant();
    await t.admin(sql`UPDATE tax_code SET rate = 10 WHERE tenant_id = ${t.tenantId}::uuid AND code = 'TNCN_KT'`);
    const r = await t.call('POST', '/api/invoices', t.invoice('HDM', { items: [{ accountCode: '6422', amountCurrency: '10000000', taxCodes: ['V8', 'V5'] }] }));
    expect(err(r)).toEqual([400, 'INVOICE_LINE_MULTIPLE_VAT']);
    expect(r.json().error.message).toMatch(/Dòng 1: mỗi dòng hàng chỉ được một mã thuế GTGT, đang có V8, V5/);
    const ok = await t.create(t.invoice('HDM', { items: [{ accountCode: '6422', amountCurrency: '10000000', taxCodes: ['V8', 'TNCN_KT'] }] }, { invoiceNo: '0000002' }));
    expect(ok.invoices).toHaveLength(1);
    expect(ok.invoices[0]).toMatchObject({ taxCode: 'V8', taxAmount: '800000' });
  });

  it('USD có GTGT 10% nhiều dòng: bút toán cân, bảng kê bằng đúng số đã ghi sổ', async () => {
    const t = await tenant();
    for (const [i, amounts] of [['1.00', '3.00', '1.00'], ['25432.50', '25432.50', '25432.50'], ['0.10', '0.30', '0.50', '0.70']].entries()) {
      const v = await t.create(t.invoice('HDM', { currencyCode: 'USD', fxRate: '1.5', items: amounts!.map((a) => ({ accountCode: '6422', amountCurrency: a, taxCodes: ['V10'] })) }, { invoiceNo: `U${i}` }));
      const s = sums(v);
      expect(s.debit, JSON.stringify(shape(v))).toBe(s.credit);
      expect(v.invoices).toHaveLength(1);
      expect(BigInt(v.invoices[0]!.baseAmount)).toBe(s.base);
      expect(BigInt(v.invoices[0]!.taxAmount)).toBe(s.tax);
    }
  });
});
