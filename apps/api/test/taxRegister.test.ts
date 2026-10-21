import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql, type RawBuilder } from 'kysely';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; headers: Record<string, unknown>; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];
interface Row { stt: number; serial: string; invoiceNo: string; invoiceDate: string; partyTaxCode: string | null; baseAmount: string; taxRate: string | null; taxAmount: string; voucherId: string; voucherNo: string | null; kind: string; groupCode: string }
interface Group { code: string; rows: Row[]; baseTotal: string; taxTotal: string }
interface Register { groups: Group[]; totals: { baseAmount: string; taxAmount: string }; otherTaxes: { rows: Row[]; baseTotal: string; taxTotal: string } }
const flat = (r: Register) => r.groups.flatMap((g) => g.rows);

// Mỗi kiểm thử một công ty riêng: năm 2026 theo TT133, đối tượng KH001, KH002, NCC001 (NCC001 có mã số thuế).
async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `TR${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  const admin = <T>(q: RawBuilder<T>) => q.execute(ctx.t.admin);
  await admin(sql`UPDATE party SET tax_code = '0312345678' WHERE tenant_id = ${tenantId}::uuid AND code = 'NCC001'`);
  const invoice = (voucherType: 'HDB' | 'HDM' | 'GGB' | 'GGM', date: string, no: string, more: object = {}, inv: object = {}) => {
    const sale = voucherType === 'HDB' || voucherType === 'GGB';
    return { voucherType, postingDate: date, documentDate: date, partyCode: sale ? 'KH001' : 'NCC001', autoPost: true,
      items: [{ description: 'Dịch vụ', accountCode: sale ? '5113' : '6422', amountCurrency: '10000000', taxCodes: ['V10'] }],
      invoice: { serial: 'C26TAA', invoiceNo: no, invoiceDate: date, invoiceGroupCode: sale ? '10' : '01', ...inv }, ...more };
  };
  const create = async (body: object) => { const r = await call('POST', '/api/invoices', body); expect(r.statusCode, r.body).toBe(201); return r.json() as { id: string; voucherNo: string; invoices: { id: number }[] }; };
  const reg = async (direction: 'purchase' | 'sale', period: number, periodKind: 'month' | 'quarter' = 'month', year = 2026): Promise<Register> => {
    const r = await call('GET', `/api/tax/invoices?direction=${direction}&year=${year}&period=${period}&periodKind=${periodKind}`);
    expect(r.statusCode, r.body).toBe(200); return r.json();
  };
  const recon = async (period: number, periodKind: 'month' | 'quarter' = 'month') => {
    const r = await call('GET', `/api/tax/reconcile?year=2026&period=${period}&periodKind=${periodKind}`);
    expect(r.statusCode, r.body).toBe(200); return r.json() as { purchaseTaxInvoices: string; debit1331: string; saleTaxInvoices: string; credit33311: string; differences: { voucherId: string; voucherNo: string | null; invoiceTax: string; ledgerTax: string }[] };
  };
  const pc = (date: string, invoices: object[], taxLine = '1000000') => call('POST', '/api/vouchers', { voucherType: 'PC', postingDate: date, documentDate: date, partyCode: 'NCC001', autoPost: true,
    lines: [{ accountCode: '6422', debit: '10000000', credit: '0' }, { accountCode: '1331', debit: taxLine, credit: '0' }, { accountCode: '1111', debit: '0', credit: String(10000000 + Number(taxLine)) }], invoices });
  const decl = (invoiceNo: string, more: object = {}) => ({ serial: 'PC26T', invoiceNo, invoiceDate: '2026-03-05', partyCode: 'NCC001', invoiceGroupCode: '03', taxCode: 'V10', baseAmount: '10000000', taxAmount: '1000000', ...more });
  return { cookie, tenantId, call, admin, invoice, create, reg, recon, pc, decl };
}

describe('bảng kê hóa đơn mua vào/bán ra', () => {
  it('mua vào gồm hóa đơn HDM và PC, nhóm đúng có cộng; nháp, đã hủy và tháng khác không có', async () => {
    const t = await tenant();
    await t.create(t.invoice('HDM', '2026-03-10', '0000001'));
    const pc = await t.pc('2026-03-12', [t.decl('0000002')]);
    expect(pc.statusCode, pc.body).toBe(201);
    await t.create(t.invoice('HDM', '2026-03-20', '0000003', { autoPost: false }));
    const gone = await t.create(t.invoice('HDM', '2026-03-21', '0000004', { autoPost: false }));
    expect((await t.call('POST', `/api/vouchers/${gone.id}/discard`)).statusCode).toBe(200);
    await t.create(t.invoice('HDM', '2026-04-10', '0000005'));
    await t.create(t.invoice('HDB', '2026-03-11', '0000006'));
    const r = await t.reg('purchase', 3);
    expect(r.groups.map((g) => [g.code, g.rows.map((x) => x.invoiceNo), g.baseTotal, g.taxTotal])).toEqual([['01', ['0000001'], '10000000', '1000000'], ['03', ['0000002'], '10000000', '1000000']]);
    expect(r.totals).toEqual({ baseAmount: '20000000', taxAmount: '2000000' });
    expect(flat(r)[0]).toMatchObject({ stt: 1, serial: 'C26TAA', invoiceDate: '2026-03-10', partyTaxCode: '0312345678', baseAmount: '10000000', taxRate: '10', taxAmount: '1000000', kind: 'original' });
    expect(flat(r)[0]!.voucherNo).toBeTruthy();
    expect(r.otherTaxes.rows).toEqual([]);
    const s = await t.reg('sale', 3);
    expect(s.groups.map((g) => [g.code, g.rows.length, g.taxTotal])).toEqual([['10', 1, '1000000']]);
  });

  it('kỳ quý gom ba tháng, kỳ tháng chỉ một tháng; năm khác không lẫn', async () => {
    const t = await tenant();
    for (const [i, d] of ['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10'].entries()) await t.create(t.invoice('HDM', d, `000010${i}`));
    expect(flat(await t.reg('purchase', 1, 'quarter')).map((x) => x.invoiceNo)).toEqual(['0000100', '0000101', '0000102']);
    expect(flat(await t.reg('purchase', 2, 'quarter')).map((x) => x.invoiceNo)).toEqual(['0000103']);
    expect(flat(await t.reg('purchase', 2)).map((x) => x.invoiceNo)).toEqual(['0000101']);
    expect(flat(await t.reg('purchase', 2, 'month', 2025))).toEqual([]);
  });

  it('kỳ kê khai khác ngày hóa đơn thì hóa đơn thuộc kỳ đã chọn', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDM', '2026-03-10', '0000200', { autoPost: false }));
    await t.admin(sql`UPDATE voucher_invoice SET declare_period = 4 WHERE voucher_id = ${v.id}::uuid`); // khai bổ sung sang tháng sau
    expect((await t.call('POST', `/api/vouchers/${v.id}/post`)).statusCode).toBe(200);
    expect(flat(await t.reg('purchase', 3))).toEqual([]);
    expect(flat(await t.reg('purchase', 4)).map((x) => x.invoiceNo)).toEqual(['0000200']);
  });

  it('đổi kỳ kê khai tháng sang quý: hóa đơn kỳ tháng vẫn đúng tháng và vào quý chứa nó, hóa đơn kỳ quý chỉ hiện ở quý (tháng cuối quý kèm ghi chú)', async () => {
    const t = await tenant();
    await t.create(t.invoice('HDM', '2026-01-10', '0001200')); await t.create(t.invoice('HDM', '2026-02-10', '0001201'));
    expect((await t.call('PUT', '/api/settings', { vat_period: 'quarter' })).statusCode).toBe(200);
    await t.create(t.invoice('HDM', '2026-04-10', '0001202')); await t.create(t.invoice('HDM', '2026-05-10', '0001203'));
    const no = async (p: number, k: 'month' | 'quarter') => flat(await t.reg('purchase', p, k)).map((x) => x.invoiceNo);
    expect(await no(1, 'month')).toEqual(['0001200']); expect(await no(2, 'month')).toEqual(['0001201']);
    expect(await no(1, 'quarter')).toEqual(['0001200', '0001201']);
    expect(await no(2, 'quarter')).toEqual(['0001202', '0001203']);
    expect(await no(4, 'month')).toEqual([]); expect(await no(5, 'month')).toEqual([]); expect(await no(6, 'month')).toEqual(['0001202', '0001203']);
    expect(((await t.reg('purchase', 6)) as Register & { note: string | null }).note).toContain('quý');
    expect(((await t.reg('purchase', 1)) as Register & { note: string | null }).note).toBeNull();
    expect((await t.recon(2, 'quarter')).purchaseTaxInvoices).toBe('2000000');
  });

  it('chứng từ đảo ở kỳ sau: kỳ sau kê khai điều chỉnh giảm (số âm) theo hóa đơn gốc, kỳ gốc vẫn giữ hóa đơn', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDM', '2026-03-10', '0000300'));
    const rev = await t.call('POST', `/api/vouchers/${v.id}/reverse`, { postingDate: '2026-04-15' });
    expect(rev.statusCode, rev.body).toBe(201);
    const mar = flat(await t.reg('purchase', 3));
    expect(mar.map((x) => [x.invoiceNo, x.baseAmount, x.taxAmount, x.kind, x.voucherId])).toEqual([['0000300', '10000000', '1000000', 'original', v.id]]);
    const apr = await t.reg('purchase', 4);
    expect(flat(apr).map((x) => [x.invoiceNo, x.baseAmount, x.taxAmount, x.kind, x.voucherId])).toEqual([['0000300', '-10000000', '-1000000', 'reversal', rev.json().id]]);
    expect(apr.totals).toEqual({ baseAmount: '-10000000', taxAmount: '-1000000' });
    expect((await t.reg('purchase', 2, 'quarter')).totals.taxAmount).toBe('-1000000');
  });

  it('chứng từ đảo ghi trước kỳ kê khai đã ghi đè của hóa đơn gốc thì kê khai cùng kỳ với hóa đơn gốc (triệt tiêu)', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDM', '2026-03-10', '0000350', { autoPost: false }));
    await t.admin(sql`UPDATE voucher_invoice SET declare_period = 5 WHERE voucher_id = ${v.id}::uuid`);
    expect((await t.call('POST', `/api/vouchers/${v.id}/post`)).statusCode).toBe(200);
    expect((await t.call('POST', `/api/vouchers/${v.id}/reverse`, { postingDate: '2026-04-15' })).statusCode).toBe(201);
    for (const p of [3, 4, 5]) expect(flat(await t.reg('purchase', p))).toEqual([]);
    expect((await t.reg('purchase', 2, 'quarter')).totals.taxAmount).toBe('0');
  });

  it('chứng từ bỏ ghi sổ (về nháp) biến mất khỏi bảng kê, ghi sổ lại thì hiện lại', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDM', '2026-03-10', '0000360'));
    expect(flat(await t.reg('purchase', 3))).toHaveLength(1);
    expect((await t.call('POST', `/api/vouchers/${v.id}/unpost`)).statusCode).toBe(200);
    expect(flat(await t.reg('purchase', 3))).toEqual([]);
    expect((await t.call('POST', `/api/vouchers/${v.id}/post`)).statusCode).toBe(200);
    expect(flat(await t.reg('purchase', 3))).toHaveLength(1);
  });

  it('chứng từ đảo cùng kỳ: cả hai triệt tiêu, bảng kê không hiện', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDM', '2026-03-10', '0000400'));
    await t.create(t.invoice('HDM', '2026-03-11', '0000401'));
    expect((await t.call('POST', `/api/vouchers/${v.id}/reverse`, { postingDate: '2026-03-25' })).statusCode).toBe(201);
    const r = await t.reg('purchase', 3);
    expect(flat(r).map((x) => x.invoiceNo)).toEqual(['0000401']);
    expect(r.totals.taxAmount).toBe('1000000');
    expect(flat(await t.reg('purchase', 1, 'quarter')).map((x) => x.invoiceNo)).toEqual(['0000401']);
  });

  it('giảm giá hàng bán (GGB) ghi số âm trong bảng kê bán ra', async () => {
    const t = await tenant();
    const hdb = await t.create(t.invoice('HDB', '2026-03-10', '0000500'));
    await t.create({ ...t.invoice('GGB', '2026-03-20', '0000501', { items: [{ description: 'Giảm giá', accountCode: '5113', amountCurrency: '1000000', taxCodes: ['V10'] }] }, { adjustsInvoiceId: hdb.invoices[0]!.id }) });
    const r = await t.reg('sale', 3);
    expect(flat(r).map((x) => [x.invoiceNo, x.baseAmount, x.taxAmount])).toEqual([['0000500', '10000000', '1000000'], ['0000501', '-1000000', '-100000']]);
    expect(r.totals).toEqual({ baseAmount: '9000000', taxAmount: '900000' });
  });

  it('thuế nhập khẩu, tiêu thụ đặc biệt không vào nhóm kê khai GTGT: liệt kê riêng và không cộng vào tổng', async () => {
    const t = await tenant();
    expect((await t.pc('2026-03-12', [t.decl('0000600'), t.decl('0000601', { taxCode: 'NK', taxAmount: '500000', baseAmount: '5000000' })])).statusCode).toBe(201);
    const r = await t.reg('purchase', 3);
    expect(flat(r).map((x) => x.invoiceNo)).toEqual(['0000600']);
    expect(r.totals.taxAmount).toBe('1000000');
    expect(r.otherTaxes.rows.map((x) => [x.invoiceNo, x.taxAmount])).toEqual([['0000601', '500000']]);
    expect(r.otherTaxes.taxTotal).toBe('500000');
  });

  it('người dùng ghi đè MST của đối tượng trên hóa đơn: lưu vào bảng kê và kiểm trùng đầu vào dùng MST đã ghi đè', async () => {
    const t = await tenant();
    await t.create(t.invoice('HDM', '2026-03-10', '0000700', {}, { partyTaxCode: '0109999999', partyName: 'Công ty ghi đè', partyAddress: 'Hà Nội' }));
    expect(flat(await t.reg('purchase', 3))[0]).toMatchObject({ partyTaxCode: '0109999999', partyName: 'Công ty ghi đè' });
    // cùng MST ghi đè, cùng ký hiệu và số, nhưng đối tượng danh mục khác (KH002 không có MST): trùng
    const dup = t.invoice('HDM', '2026-03-11', '0000700', { partyCode: 'KH002' }, { partyTaxCode: '0109999999' });
    expect(err(await t.call('POST', '/api/invoices', dup))).toEqual([409, 'INVOICE_DUPLICATE']);
    // không ghi đè: KH002 không có MST nên khác đối tượng thì không trùng
    expect((await t.call('POST', '/api/invoices', t.invoice('HDM', '2026-03-11', '0000700', { partyCode: 'KH002' }))).statusCode).toBe(201);
  });

  it('MST ghi đè kiểm tra cùng quy tắc danh mục đối tượng: sai định dạng 400, rỗng là không ghi đè; hóa đơn kê khai trên PC cũng ghi đè và kiểm trùng được', async () => {
    const t = await tenant();
    const bad = ['123', 'abcdefghij', '0312345678-12'];
    for (const m of bad) expect(err(await t.call('POST', '/api/invoices', t.invoice('HDM', '2026-03-10', '0001300', {}, { partyTaxCode: m })))).toEqual([400, 'VALIDATION']);
    expect(err(await t.pc('2026-03-12', [t.decl('0001301', { partyTaxCode: '12' })]))).toEqual([400, 'VALIDATION']);
    await t.create(t.invoice('HDM', '2026-03-10', '0001302', {}, { partyTaxCode: '' }));
    await t.create(t.invoice('HDM', '2026-03-10', '0001303', {}, { partyTaxCode: '0312345678-001' }));
    expect(flat(await t.reg('purchase', 3)).map((x) => [x.invoiceNo, x.partyTaxCode])).toEqual([['0001302', '0312345678'], ['0001303', '0312345678-001']]);
    expect((await t.pc('2026-03-12', [t.decl('0001304', { partyTaxCode: '0109999999', partyName: 'Bên ghi đè', partyAddress: 'Hà Nội' })])).statusCode).toBe(201);
    expect(flat(await t.reg('purchase', 3)).find((x) => x.invoiceNo === '0001304')).toMatchObject({ partyTaxCode: '0109999999', partyName: 'Bên ghi đè' });
    const dup = await t.pc('2026-03-13', [t.decl('0001304', { partyCode: 'KH002', partyTaxCode: '0109999999' })]);
    expect(err(dup)).toEqual([409, 'INVOICE_DUPLICATE']);
  });

  it('lưu lại nháp PC kèm bản chụp người bán đọc về từ chứng từ: MST, tên, địa chỉ ghi đè được giữ', async () => {
    const t = await tenant();
    const body = (invoices: object[], more: object = {}) => ({ voucherType: 'PC', postingDate: '2026-03-12', documentDate: '2026-03-12', partyCode: 'NCC001', autoPost: false,
      lines: [{ accountCode: '6422', debit: '10000000', credit: '0' }, { accountCode: '1331', debit: '1000000', credit: '0' }, { accountCode: '1111', debit: '0', credit: '11000000' }], invoices, ...more });
    const c = await t.call('POST', '/api/vouchers', body([t.decl('0001700', { partyTaxCode: '0109999999', partyName: 'Bên ghi đè', partyAddress: 'Hà Nội' })]));
    expect(c.statusCode, c.body).toBe(201);
    const got = (await t.call('GET', `/api/vouchers/${c.json().id}`)).json();
    const back = got.invoices.map((i: Record<string, string>) => ({ serial: i.serial, invoiceNo: i.invoiceNo, invoiceDate: i.invoiceDate, partyCode: i.partyCode, invoiceGroupCode: i.invoiceGroupCode, taxCode: i.taxCode,
      baseAmount: i.baseAmount, taxAmount: i.taxAmount, partyTaxCode: i.partyTaxCode, partyName: i.partyName, partyAddress: i.partyAddress }));
    const u = await t.call('PUT', `/api/vouchers/${c.json().id}`, body(back, { version: got.version, autoPost: undefined }));
    expect(u.statusCode, u.body).toBe(200);
    expect((await t.call('POST', `/api/vouchers/${c.json().id}/post`)).statusCode).toBe(200);
    expect(flat(await t.reg('purchase', 3)).find((x) => x.invoiceNo === '0001700')).toMatchObject({ partyTaxCode: '0109999999', partyName: 'Bên ghi đè' });
  });

  it('danh sách chứng từ lọc theo mã đối tượng ở máy chủ (ô chọn hóa đơn gốc)', async () => {
    const t = await tenant();
    await t.create(t.invoice('HDB', '2026-03-10', '0000800'));
    await t.create(t.invoice('HDB', '2026-03-11', '0000801', { partyCode: 'KH002' }));
    const r = await t.call('GET', '/api/vouchers?type=HDB&state=posted&partyCode=KH002');
    expect(r.statusCode).toBe(200);
    expect(r.json().rows).toHaveLength(1); expect(r.json().total).toBe(1);
  });

  it('xuất Excel, in HTML không ghi "Mẫu số"; người chỉ có quyền xem xuất Excel bị 403, xem JSON được', async () => {
    const t = await tenant();
    await t.create(t.invoice('HDM', '2026-03-10', '0000900'));
    const x = await t.call('GET', '/api/tax/invoices?direction=purchase&year=2026&period=3&periodKind=month&format=xlsx');
    expect(x.statusCode).toBe(200); expect(String(x.headers['content-type'])).toContain('spreadsheetml');
    const h = await t.call('GET', '/api/tax/invoices?direction=purchase&year=2026&period=3&periodKind=month&format=html');
    expect(h.statusCode).toBe(200); expect(h.body).toContain('Bảng kê hóa đơn'); expect(h.body).not.toContain('Mẫu số');
    await t.admin(sql`DELETE FROM role_permission WHERE tenant_id = ${t.tenantId}::uuid AND permission_code = 'report.print' AND role_id IN (SELECT id FROM role WHERE tenant_id = ${t.tenantId}::uuid AND code = 'xem')`);
    const username = `xem_${Date.now()}`;
    expect((await t.call('POST', '/api/users', { username, fullName: 'Xem', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: [] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const xem = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    const q = '/api/tax/invoices?direction=purchase&year=2026&period=3&periodKind=month';
    expect((await t.call('GET', q, undefined, xem)).statusCode).toBe(200);
    expect(err(await t.call('GET', `${q}&format=xlsx`, undefined, xem))).toEqual([403, 'FORBIDDEN']);
    expect((await ctx.app.inject({ method: 'GET', url: q })).statusCode).toBe(401);
  });
});

describe('đối chiếu thuế hóa đơn với sổ cái', () => {
  it('bắt chứng từ PKT có dòng 1331 mà không kê hóa đơn; hóa đơn khớp bút toán thì không lệch', async () => {
    const t = await tenant();
    await t.create(t.invoice('HDM', '2026-03-10', '0000001'));
    await t.create(t.invoice('HDB', '2026-03-11', '0000002'));
    const pkt = await t.call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-03-15', documentDate: '2026-03-15', autoPost: true,
      lines: [{ accountCode: '1331', debit: '2000000', credit: '0' }, { accountCode: '1111', debit: '0', credit: '2000000' }] });
    expect(pkt.statusCode, pkt.body).toBe(201);
    const r = await t.recon(3);
    expect(r).toMatchObject({ purchaseTaxInvoices: '1000000', debit1331: '3000000', saleTaxInvoices: '1000000', credit33311: '1000000' });
    expect(r.differences).toEqual([expect.objectContaining({ voucherId: pkt.json().id, voucherNo: pkt.json().voucherNo, invoiceTax: '0', ledgerTax: '2000000' })]);
    expect((await t.recon(1, 'quarter')).differences).toHaveLength(1);
    expect((await t.recon(4)).differences).toEqual([]);
  });

  it('chứng từ khấu trừ thuế (KTT) và nộp thuế GTGT (Nợ 33311 / Có tiền, kể cả bản đảo) không phải lệch và không vào tổng sổ cái', async () => {
    const t = await tenant();
    await t.create(t.invoice('HDM', '2026-03-10', '0000001'));
    await t.create(t.invoice('HDB', '2026-03-11', '0000002'));
    const pay = await t.call('POST', '/api/vouchers', { voucherType: 'PC', postingDate: '2026-03-20', documentDate: '2026-03-20', partyCode: 'NCC001', autoPost: true,
      lines: [{ accountCode: '33311', debit: '700000', credit: '0' }, { accountCode: '1111', debit: '0', credit: '700000' }] });
    expect(pay.statusCode, pay.body).toBe(201);
    expect((await t.call('POST', `/api/vouchers/${pay.json().id}/reverse`, { postingDate: '2026-03-25' })).statusCode).toBe(201);
    const off = await t.call('POST', '/api/tax/vat-offset', { date: '2026-03-31' });
    expect(off.statusCode, off.body).toBe(200); expect(off.json().amount).toBe('1000000');
    const r = await t.recon(3);
    expect(r).toMatchObject({ purchaseTaxInvoices: '1000000', debit1331: '1000000', saleTaxInvoices: '1000000', credit33311: '1000000', differences: [] });
  });

  it('mã thuế phân bổ chia đôi hai tài khoản (50/50) không bị báo lệch giả', async () => {
    const t = await tenant();
    await t.admin(sql`UPDATE tax_distribution d SET factor_percent = 50 FROM tax_code c WHERE c.id = d.tax_code_id AND c.tenant_id = ${t.tenantId}::uuid AND c.code = 'V10' AND d.scope = 'purchase' AND d.account_code = '1331'`);
    await t.admin(sql`INSERT INTO tax_distribution(tenant_id, tax_code_id, document_type, scope, line_type, factor_percent, account_code)
      SELECT d.tenant_id, d.tax_code_id, d.document_type, 'purchase', 'tax', 50, '1332' FROM tax_distribution d JOIN tax_code c ON c.id = d.tax_code_id
      WHERE c.tenant_id = ${t.tenantId}::uuid AND c.code = 'V10' AND d.scope = 'purchase' AND d.account_code = '1331'`);
    const v = await t.create(t.invoice('HDM', '2026-03-10', '0001000'));
    const r = await t.recon(3);
    expect(r.differences).toEqual([]);
    expect(r.purchaseTaxInvoices).toBe('1000000'); expect(r.debit1331).toBe('1000000');
    expect(v.invoices).toHaveLength(1);
  });

  it('chứng từ đảo cân với hóa đơn gốc: đảo sang kỳ sau không sinh lệch', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDM', '2026-03-10', '0001100'));
    expect((await t.call('POST', `/api/vouchers/${v.id}/reverse`, { postingDate: '2026-04-15' })).statusCode).toBe(201);
    expect((await t.recon(3)).differences).toEqual([]);
    const apr = await t.recon(4);
    expect(apr.differences).toEqual([]); expect(apr.purchaseTaxInvoices).toBe('-1000000'); expect(apr.debit1331).toBe('-1000000');
  });

  it('số dư đầu kỳ (DK) trên 1331, 33311 không tính vào tổng sổ cái và không sinh lệch (tháng 1, quý 1)', async () => {
    const t = await tenant();
    const R = (accountCode: string, debit = '0', credit = '0') => ({ accountCode, partyCode: null, currencyCode: 'VND', debit, credit, debitCurrency: '0', creditCurrency: '0' });
    expect((await t.call('PUT', '/api/opening-balance/2026', { rows: [R('1331', '500000'), R('33311', '0', '300000'), R('4111', '0', '200000')] })).statusCode).toBe(200);
    const p = await t.call('POST', '/api/opening-balance/2026/post'); expect(p.statusCode, p.body).toBe(200);
    await t.create(t.invoice('HDM', '2026-01-10', '0001400'));
    for (const r of [await t.recon(1), await t.recon(1, 'quarter')]) {
      expect(r).toMatchObject({ purchaseTaxInvoices: '1000000', debit1331: '1000000', saleTaxInvoices: '0', credit33311: '0' }); expect(r.differences).toEqual([]);
    }
  });

  it('giảm giá hàng bán (GGB) và hàng mua (GGM) cân với sổ cái: thuần Có/Nợ, không báo lệch', async () => {
    const t = await tenant();
    const hdb = await t.create(t.invoice('HDB', '2026-03-10', '0001500')); const hdm = await t.create(t.invoice('HDM', '2026-03-10', '0001501'));
    const small = (acc: string) => ({ items: [{ description: 'Giảm giá', accountCode: acc, amountCurrency: '1000000', taxCodes: ['V10'] }] });
    await t.create(t.invoice('GGB', '2026-03-20', '0001502', small('5113'), { adjustsInvoiceId: hdb.invoices[0]!.id }));
    await t.create(t.invoice('GGM', '2026-03-20', '0001503', small('6422'), { adjustsInvoiceId: hdm.invoices[0]!.id }));
    const r = await t.recon(3);
    expect(r).toMatchObject({ purchaseTaxInvoices: '900000', debit1331: '900000', saleTaxInvoices: '900000', credit33311: '900000' }); expect(r.differences).toEqual([]);
  });

  it('xuất Excel đối chiếu; thiếu quyền in thì 403', async () => {
    const t = await tenant();
    await t.create(t.invoice('HDM', '2026-03-10', '0001600'));
    const q = '/api/tax/reconcile?year=2026&period=3&periodKind=month';
    const x = await t.call('GET', `${q}&format=xlsx`);
    expect(x.statusCode).toBe(200); expect(String(x.headers['content-type'])).toContain('spreadsheetml');
    await t.admin(sql`DELETE FROM role_permission WHERE tenant_id = ${t.tenantId}::uuid AND permission_code = 'report.print' AND role_id IN (SELECT id FROM role WHERE tenant_id = ${t.tenantId}::uuid AND code = 'xem')`);
    const username = `xem_${Date.now()}`;
    expect((await t.call('POST', '/api/users', { username, fullName: 'Xem', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: [] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const xem = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    expect((await t.call('GET', q, undefined, xem)).statusCode).toBe(200);
    expect(err(await t.call('GET', `${q}&format=xlsx`, undefined, xem))).toEqual([403, 'FORBIDDEN']);
  });
});
