import FormData from 'form-data';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, TEST_PASSWORD, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';
import { fixture } from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const VAT = () => fixture('vn-einvoice-vat.xml');
const withNo = (xml: string, no: string) => xml.replace(/<SHDon>\d+<\/SHDon>/, `<SHDon>${no}</SHDon>`);
const err = (r: Res) => [r.statusCode, r.json().error?.code];
const BODY = { voucherType: 'HDM', postingDate: '2026-01-20', invoiceGroupCode: '01', lines: [{ lineNo: 1, accountCode: '6422', taxCode: 'V10' }, { lineNo: 2, accountCode: '6422', taxCode: 'V10' }] };

async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `TV${Date.now()}${n++}`);
  await sql`UPDATE tenant SET tax_code = '0300000002' WHERE id = ${tenantId}::uuid`.execute(ctx.t.admin);
  const as = (c: string) => (method: 'GET' | 'POST', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  const call = as(cookie);
  const one = async (xml: string) => {
    const fd = new FormData(); fd.append('file', Buffer.from(xml), { filename: 'a.xml', contentType: 'application/xml' });
    const r = await ctx.app.inject({ method: 'POST', url: '/api/inbound-invoices', headers: { cookie, ...fd.getHeaders() }, payload: fd.getBuffer() });
    expect(r.statusCode, r.body).toBe(200); return r.json().results[0] as { status: string; id: number };
  };
  // Người dùng kế toán viên của công ty, sau khi vai trò bị bỏ một quyền.
  const without = async (perm: string) => {
    const u = `kt_${Date.now()}_${n++}`;
    expect((await call('POST', '/api/users', { username: u, fullName: 'KT', password: TEST_PASSWORD, roleCode: 'ketoan_vien', sensitiveFlags: [] })).statusCode).toBe(201);
    await sql`DELETE FROM role_permission WHERE tenant_id = ${tenantId}::uuid AND permission_code = ${perm} AND role_id = (SELECT id FROM role WHERE tenant_id = ${tenantId}::uuid AND code = 'ketoan_vien')`.execute(ctx.t.admin);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: TEST_PASSWORD } });
    return as(`sid=${login.cookies.find((x) => x.name === 'sid')!.value}`);
  };
  return { call, one, tenantId, cookie, without, setVendorMst: () => sql`UPDATE party SET tax_code = '0100000001' WHERE tenant_id = ${tenantId}::uuid AND code = 'NCC001'`.execute(ctx.t.admin) };
}

describe('lập chứng từ mua từ hóa đơn đầu vào', () => {
  it('proposal: người bán đã có theo MST; thuế 10% → mã GTGT mua vào 10%', async () => {
    const t = await tenant(); await t.setVendorMst();
    const a = await t.one(VAT());
    const r = await t.call('GET', `/api/inbound-invoices/${a.id}/proposal`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ partyCode: 'NCC001', voucherType: 'HDM', lines: [{ lineNo: 1, itemCode: null, accountCode: null, taxCode: 'V10', source: 'guess' }, { lineNo: 2, taxCode: 'V10' }] });
  });

  it('lập HDM từ hóa đơn dịch vụ: chứng từ nháp, số/ký hiệu/ngày đúng hóa đơn, thuế = TgTThue', async () => {
    const t = await tenant(); await t.setVendorMst();
    const a = await t.one(VAT());
    const r = await t.call('POST', `/api/inbound-invoices/${a.id}/voucher`, BODY);
    expect(r.statusCode, r.body).toBe(201);
    const inv = (await t.call('GET', `/api/invoices/${r.json().voucherId}`)).json();
    expect(inv).toMatchObject({ state: 'draft', voucherType: 'HDM', totalDebit: '1430000' });
    expect(inv.invoices).toHaveLength(1);
    expect(inv.invoices[0]).toMatchObject({ invoiceNo: '00000123', serial: 'C26TAA', formNo: '1', invoiceDate: '2026-01-15', baseAmount: '1300000', taxAmount: '130000', partyTaxCode: '0100000001' });
    const d = (await t.call('GET', `/api/inbound-invoices/${a.id}`)).json();
    expect(d).toMatchObject({ status: 'voucher_created', voucherId: r.json().voucherId });
  });

  it('lập lần hai → 409 INBOUND_ALREADY_CONVERTED; ánh xạ dòng được nhớ cho hóa đơn sau cùng người bán; hai yêu cầu đồng thời chỉ ra một chứng từ', async () => {
    const t = await tenant(); await t.setVendorMst();
    const a = await t.one(VAT());
    expect((await t.call('POST', `/api/inbound-invoices/${a.id}/voucher`, BODY)).statusCode).toBe(201);
    expect(err(await t.call('POST', `/api/inbound-invoices/${a.id}/voucher`, BODY))).toEqual([409, 'INBOUND_ALREADY_CONVERTED']);
    const b = await t.one(withNo(VAT(), '00000124'));
    const p = (await t.call('GET', `/api/inbound-invoices/${b.id}/proposal`)).json();
    expect(p.lines.map((l: { accountCode: string; source: string }) => [l.accountCode, l.source])).toEqual([['6422', 'map'], ['6422', 'map']]);
    const rs = await Promise.all([1, 2].map(() => t.call('POST', `/api/inbound-invoices/${b.id}/voucher`, BODY)));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const cnt = await sql<{ n: string }>`SELECT count(*)::text n FROM voucher_invoice WHERE tenant_id = ${t.tenantId}::uuid AND invoice_no = '00000124'`.execute(ctx.t.admin);
    expect(cnt.rows[0]!.n).toBe('1');
  });

  it('người bán chưa có, createParty true → tạo đối tượng tên, MST, địa chỉ từ hóa đơn; không createParty → 400', async () => {
    const t = await tenant();
    const a = await t.one(VAT());
    expect(err(await t.call('POST', `/api/inbound-invoices/${a.id}/voucher`, BODY))).toEqual([400, 'PARTY_REQUIRED']);
    const r = await t.call('POST', `/api/inbound-invoices/${a.id}/voucher`, { ...BODY, createParty: true });
    expect(r.statusCode, r.body).toBe(201);
    const p = await sql<{ name: string; tax_code: string; address: string; is_vendor: boolean }>`SELECT name, tax_code, address, is_vendor FROM party WHERE tenant_id = ${t.tenantId}::uuid AND tax_code = '0100000001'`.execute(ctx.t.admin);
    expect(p.rows).toEqual([{ name: 'Công ty TNHH Thương mại Mẫu An Phát', tax_code: '0100000001', address: 'Số 1, Đường Mẫu, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh', is_vendor: true }]);
  });

  it('từ chối: bị chặn (số tiền hỏng), trùng, bỏ qua, dòng chiết khấu; loại tiền viết thường vẫn là VND', async () => {
    const t = await tenant(); await t.setVendorMst();
    const blocked = await t.one(withNo(VAT(), '00000200').replace('<ThTien>300000</ThTien>', '<ThTien>3.0e5</ThTien>'));
    expect(err(await t.call('POST', `/api/inbound-invoices/${blocked.id}/voucher`, BODY))).toEqual([409, 'INBOUND_BLOCKED']);
    await t.one(VAT());
    const dup = await t.one(VAT().replace('Giấy in A4 70gsm', 'Giấy in A4 80gsm'));
    expect(dup.status).toBe('duplicate');
    expect(err(await t.call('POST', `/api/inbound-invoices/${dup.id}/voucher`, BODY))).toEqual([409, 'INBOUND_STATUS']);
    expect((await t.call("POST", `/api/inbound-invoices/${dup.id}/ignore`)).statusCode).toBe(200);
    expect(err(await t.call('POST', `/api/inbound-invoices/${dup.id}/voucher`, BODY))).toEqual([409, 'INBOUND_STATUS']);
    const disc = await t.one(withNo(VAT(), '00000300').replace('</DSHHDVu>', '<HHDVu><TChat>3</TChat><STT>3</STT><THHDVu>Chiết khấu</THHDVu><ThTien>100000</ThTien><TSuat>10%</TSuat></HHDVu></DSHHDVu>'));
    expect(err(await t.call('POST', `/api/inbound-invoices/${disc.id}/voucher`, { ...BODY, lines: [...BODY.lines, { lineNo: 3, accountCode: '6422', taxCode: 'V10' }] }))).toEqual([409, 'INBOUND_DISCOUNT_UNSUPPORTED']);
    const low = await t.one(withNo(VAT(), '00000400').replace('<Ma>VND</Ma>', '<Ma>vnd</Ma>'));
    expect((await t.call('POST', `/api/inbound-invoices/${low.id}/voucher`, BODY)).statusCode).toBe(201);
  });

  it('quyền: thiếu voucher.create 403; createParty thiếu catalog.create 403; thiếu inbound_invoice.update 403', async () => {
    const t = await tenant();
    const a = await t.one(VAT());
    expect((await (await t.without('voucher.create'))('POST', `/api/inbound-invoices/${a.id}/voucher`, { ...BODY, createParty: true })).statusCode).toBe(403);
    const t2 = await tenant();
    const b = await t2.one(VAT());
    expect((await (await t2.without('catalog.create'))('POST', `/api/inbound-invoices/${b.id}/voucher`, { ...BODY, createParty: true })).statusCode).toBe(403);
    const t3 = await tenant();
    const c = await t3.one(VAT());
    expect((await (await t3.without('inbound_invoice.update'))('POST', `/api/inbound-invoices/${c.id}/voucher`, BODY)).statusCode).toBe(403);
    expect((await t3.call('GET', `/api/inbound-invoices/${c.id}`)).json().status).toBe('new');
  });
  it('voucherType có trong danh sách và chi tiết; mã thuế KCT/KKK chỉ gợi ý khi còn dùng được cho mua vào', async () => {
    const t = await tenant(); await t.setVendorMst();
    const a = await t.one(VAT());
    const r = await t.call('POST', `/api/inbound-invoices/${a.id}/voucher`, BODY);
    expect(r.statusCode, r.body).toBe(201);
    expect((await t.call('GET', `/api/inbound-invoices/${a.id}`)).json().voucherType).toBe('HDM');
    expect((await t.call('GET', '/api/inbound-invoices')).json().find((x: { id: number }) => x.id === a.id).voucherType).toBe('HDM');
    const kct = VAT().replace(/<TSuat>10%<\/TSuat>/g, '<TSuat>KCT</TSuat>');
    const b = await t.one(withNo(kct, '00000501').replace('Giấy in A4 70gsm', 'Mặt hàng khác').replace('Dịch vụ giao hàng', 'Dịch vụ khác'));
    expect((await t.call('GET', `/api/inbound-invoices/${b.id}/proposal`)).json().lines[0].taxCode).toBe('KCT');
    await sql`UPDATE tax_code SET is_active = false WHERE tenant_id = ${t.tenantId}::uuid AND code = 'KCT'`.execute(ctx.t.admin);
    expect((await t.call('GET', `/api/inbound-invoices/${b.id}/proposal`)).json().lines[0].taxCode).toBeNull();
  });

  it('ánh xạ đã nhớ không bị ghi đè bằng rỗng khi lần sau bỏ trống trường', async () => {
    const t = await tenant(); await t.setVendorMst();
    expect((await t.call('POST', '/api/catalogs/item', { code: 'GIAY', name: 'Giấy', base_uom_code: 'CAI', kind: 'goods', tracking: 'none', inventory_account_code: '156' })).statusCode).toBe(201);
    const a = await t.one(VAT());
    expect((await t.call('POST', `/api/inbound-invoices/${a.id}/voucher`, BODY)).statusCode).toBe(201);
    await sql`UPDATE inbound_item_map SET item_id = (SELECT id FROM item WHERE tenant_id = ${t.tenantId}::uuid AND code = 'GIAY') WHERE tenant_id = ${t.tenantId}::uuid`.execute(ctx.t.admin);
    const b = await t.one(withNo(VAT(), '00000502'));
    expect((await t.call('POST', `/api/inbound-invoices/${b.id}/voucher`, BODY)).statusCode).toBe(201);
    const m = await sql<{ n: string }>`SELECT count(*)::text n FROM inbound_item_map WHERE tenant_id = ${t.tenantId}::uuid AND item_id IS NOT NULL`.execute(ctx.t.admin);
    expect(m.rows[0]!.n).toBe('2');
  });

  it('createParty: mã NCC<MST> đã có với cùng MST thì dùng lại; khác MST → 409 PARTY_CODE_TAKEN', async () => {
    const t = await tenant();
    await sql`INSERT INTO party (tenant_id, code, name, tax_code, is_vendor) VALUES (${t.tenantId}::uuid, 'NCC0100000001', 'Có sẵn', '0100000001', true)`.execute(ctx.t.admin);
    const a = await t.one(VAT());
    const r = await t.call('POST', `/api/inbound-invoices/${a.id}/voucher`, { ...BODY, createParty: true });
    expect(r.statusCode, r.body).toBe(201);
    const t2 = await tenant();
    await sql`INSERT INTO party (tenant_id, code, name, tax_code, is_vendor) VALUES (${t2.tenantId}::uuid, 'NCC0100000001', 'Khác MST', '0999999999', true)`.execute(ctx.t.admin);
    const b = await t2.one(VAT());
    expect(err(await t2.call('POST', `/api/inbound-invoices/${b.id}/voucher`, { ...BODY, createParty: true }))).toEqual([409, 'PARTY_CODE_TAKEN']);
  });

  it('hóa đơn ngoại tệ USD có TGia → chứng từ ngoại tệ, thuế khai báo quy đổi VND', async () => {
    const t = await tenant(); await t.setVendorMst();
    const usd = withNo(VAT(), '00000504').replace('<Ma>VND</Ma>', '<Ma>USD</Ma>').replace('</DVTTe>', '</DVTTe><TGia>25000</TGia>').replace('<TgTCThue>1300000', '<TgTCThue>1000').replace('<TgTThue>130000', '<TgTThue>100').replace('<TgTTTBSo>1430000', '<TgTTTBSo>1100')
      .replace('<DGia>50000</DGia>', '<DGia>40</DGia>').replace('<ThTien>1000000</ThTien>', '<ThTien>800</ThTien>')
      .replace('<DGia>300000</DGia>', '<DGia>200</DGia>').replace('<ThTien>300000</ThTien>', '<ThTien>200</ThTien>');
    const a = await t.one(usd);
    const r = await t.call('POST', `/api/inbound-invoices/${a.id}/voucher`, BODY);
    expect(r.statusCode, r.body).toBe(201);
    const inv = (await t.call('GET', `/api/invoices/${r.json().voucherId}`)).json();
    expect(inv).toMatchObject({ currencyCode: 'USD', fxRate: expect.stringMatching(/^25000/), totalDebit: '27500000' });
    expect(inv.invoices[0]).toMatchObject({ taxAmount: '2500000' });
  });
});
