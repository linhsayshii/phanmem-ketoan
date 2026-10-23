import FormData from 'form-data';
import JSZip from 'jszip';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, TEST_PASSWORD, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';
import { FakeLookup, setTaxCodeLookupForTest } from '../../src/modules/inbound/taxCodeLookup.js';
import { dropKey, makeKey } from '../signing/keys.js';
import { fixture, signInvoice } from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
const key = makeKey('Nguoi ban');
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { setTaxCodeLookupForTest(null); await ctx.close(); dropKey(key); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const VAT = () => fixture('vn-einvoice-vat.xml');
const CASH = () => fixture('vn-einvoice-cashreg.xml');
const withNo = (xml: string, no: string) => xml.replace(/<SHDon>\d+<\/SHDon>/, `<SHDon>${no}</SHDon>`);

async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `IN${Date.now()}${n++}`);
  await sql`UPDATE tenant SET tax_code = '0300000002' WHERE id = ${tenantId}::uuid`.execute(ctx.t.admin);
  const as = (c: string) => (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  const call = as(cookie);
  const upload = (files: { name: string; data: Buffer | string }[], c = cookie) => {
    const fd = new FormData(); for (const f of files) fd.append('file', Buffer.from(f.data), { filename: f.name, contentType: 'application/xml' });
    return ctx.app.inject({ method: 'POST', url: '/api/inbound-invoices', headers: { cookie: c, ...fd.getHeaders() }, payload: fd.getBuffer() }) as unknown as Promise<Res>;
  };
  const one = async (xml: string) => { const r = await upload([{ name: 'a.xml', data: xml }]); expect(r.statusCode, r.body).toBe(200); return r.json().results[0] as { file: string; status: string; id?: number; error?: { code: string; message: string }; existing?: number }; };
  const viewer = `xem_${Date.now()}_${n++}`;
  expect((await call('POST', '/api/users', { username: viewer, fullName: 'Xem', password: TEST_PASSWORD, roleCode: 'xem', sensitiveFlags: [] })).statusCode).toBe(201);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: viewer, password: TEST_PASSWORD } });
  const viewerCookie = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
  return { call, upload, one, tenantId, cookie, viewerCookie, viewerCall: as(viewerCookie) };
}

describe('hóa đơn đầu vào: lưu và chống trùng', () => {
  it('tải cùng tệp hai lần: một bản ghi; tệp khác nhưng cùng (MST, ký hiệu, số) → duplicate; tải XML về đúng từng byte', async () => {
    const t = await tenant();
    const a = await t.one(VAT()); expect(a).toMatchObject({ file: 'a.xml', status: 'new' });
    const again = await t.one(VAT()); expect(again).toMatchObject({ status: 'duplicate', id: a.id, existing: a.id });
    const variant = await t.one(VAT().replace('</HDon>', '<!-- gui lai --></HDon>'));
    expect(variant.status).toBe('duplicate'); expect(variant.id).not.toBe(a.id); expect(variant.existing).toBe(a.id);
    const list = (await t.call('GET', '/api/inbound-invoices')).json() as { id: number; status: string }[];
    expect(list.map((r) => r.status).sort()).toEqual(['duplicate', 'new']);
    const d = (await t.call('GET', `/api/inbound-invoices/${variant.id}`)).json();
    expect(d).toMatchObject({ status: 'duplicate', duplicateOf: a.id });
    expect((await t.call('GET', `/api/inbound-invoices/${a.id}/xml`)).body).toBe(VAT());
  });

  it('chi tiết: dòng hàng, tổng, người mua khớp công ty, chưa ký → cảnh báo UNSIGNED', async () => {
    const t = await tenant();
    const a = await t.one(VAT());
    const d = (await t.call('GET', `/api/inbound-invoices/${a.id}`)).json();
    expect(d).toMatchObject({ serial: 'C26TAA', invoiceNo: '00000123', issueDate: '2026-01-15', sellerTaxCode: '0100000001', buyerMatches: true, totalBeforeTax: '1300000.0000', totalTax: '130000.0000', total: '1430000.0000', sellerSig: null, status: 'new', source: 'upload' });
    expect(d.lines).toHaveLength(2); expect(d.lines[0]).toMatchObject({ lineNo: 1, code: 'SP001', amount: '1000000.0000', taxRate: '10' });
    expect(d.warnings.map((w: { code: string }) => w.code)).toContain('UNSIGNED');
    const c = await t.one(CASH());
    expect((await t.call('GET', `/api/inbound-invoices/${c.id}`)).json().buyerMatches).toBeNull();
  });

  it('chữ ký hợp lệ lưu valid; sửa ThTien sau khi ký lưu invalid nhưng vẫn nhận', async () => {
    const t = await tenant();
    const signed = signInvoice(VAT(), key);
    const ok = await t.one(signed);
    expect((await t.call('GET', `/api/inbound-invoices/${ok.id}`)).json().sellerSig).toMatchObject({ valid: true, caChain: 'unchecked' });
    const bad = await t.one(withNo(signed, '00000999').replace('<ThTien>300000</ThTien>', '<ThTien>300001</ThTien>'));
    const d = (await t.call('GET', `/api/inbound-invoices/${bad.id}`)).json();
    expect(d.sellerSig.valid).toBe(false); expect(d.warnings.map((w: { code: string }) => w.code)).toContain('SELLER_SIGNATURE_INVALID');
  });

  it('hóa đơn mua đã nhập thành chứng từ → cảnh báo VOUCHER_EXISTS kèm chứng từ', async () => {
    const t = await tenant();
    await sql`UPDATE party SET tax_code = '0100000001' WHERE tenant_id = ${t.tenantId}::uuid AND code = 'NCC001'`.execute(ctx.t.admin);
    const v = await t.call('POST', '/api/invoices', { voucherType: 'HDM', postingDate: '2026-01-15', documentDate: '2026-01-15', partyCode: 'NCC001', autoPost: true,
      items: [{ description: 'x', accountCode: '6422', amountCurrency: '1300000', taxCodes: ['V10'] }], invoice: { serial: 'C26TAA', invoiceNo: '00000123', invoiceDate: '2026-01-15', invoiceGroupCode: '01' } });
    expect(v.statusCode, v.body).toBe(201);
    const a = await t.one(VAT());
    const d = (await t.call('GET', `/api/inbound-invoices/${a.id}`)).json();
    const w = d.warnings.find((x: { code: string }) => x.code === 'VOUCHER_EXISTS');
    expect(w).toBeTruthy(); expect(w.voucherId).toBe(v.json().id);
    expect(d.partyId).toBeTruthy(); // đối tượng NCC001 khớp theo MST người bán
  });

  it('tệp zip 3 XML + tệp không phải XML + thư mục → 3 nhận, 1 lỗi, tệp lạ báo skipped; XML có DOCTYPE chỉ hỏng dòng của nó', async () => {
    const t = await tenant();
    const zip = new JSZip();
    zip.file('../../etc/a.xml', VAT()); zip.file('b.XML', CASH()); zip.file('thu-muc/c.xml', withNo(VAT(), '00000777'));
    zip.file('doc.txt', 'bo qua'); zip.file('trong.zip', 'PK'); zip.folder('rong');
    zip.file('xxe.xml', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><HDon>&a;</HDon>');
    const r = await t.upload([{ name: 'goi.zip', data: await zip.generateAsync({ type: 'nodebuffer' }) }]);
    expect(r.statusCode, r.body).toBe(200);
    const res = r.json().results as { file: string; status: string; error?: { code: string } }[];
    expect(res.filter((x) => x.status === 'new')).toHaveLength(3);
    expect(res.filter((x) => x.status === 'error')).toEqual([expect.objectContaining({ file: 'goi.zip/xxe.xml', error: expect.objectContaining({ code: 'XML_UNSAFE' }) })]);
    expect(res.filter((x) => x.status === 'skipped').map((x) => x.file).sort()).toEqual(['goi.zip/doc.txt', 'goi.zip/trong.zip']);
    expect(res).toHaveLength(6);
  });

  it('zip quá nhiều tệp hoặc giải nén vượt giới hạn → dòng lỗi ZIP_TOO_LARGE, không nhận gì', async () => {
    const t = await tenant();
    const many = new JSZip(); for (let i = 0; i < 201; i++) many.file(`f${i}.xml`, '<a/>');
    const r1 = await t.upload([{ name: 'nhieu.zip', data: await many.generateAsync({ type: 'nodebuffer' }) }]);
    expect(r1.json().results).toEqual([expect.objectContaining({ file: 'nhieu.zip', status: 'error', error: expect.objectContaining({ code: 'ZIP_TOO_LARGE' }) })]);
    const big = new JSZip(); for (let i = 0; i < 11; i++) big.file(`b${i}.xml`, Buffer.alloc(2 * 1024 * 1024, 32), { compression: 'DEFLATE' }); // 22 MB giải nén > 20 MB
    const r2 = await t.upload([{ name: 'bom.zip', data: await big.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) }]);
    expect(r2.json().results[0]).toMatchObject({ status: 'error', error: { code: 'ZIP_TOO_LARGE' } });
    expect((await t.call('GET', '/api/inbound-invoices')).json()).toHaveLength(0);
  });

  it('thiếu quyền: người chỉ xem không tải lên được (403) nhưng xem được danh sách', async () => {
    const t = await tenant();
    const r = await t.upload([{ name: 'a.xml', data: VAT() }], t.viewerCookie);
    expect([r.statusCode, r.json().error.code]).toEqual([403, 'FORBIDDEN']);
    expect((await t.viewerCall('GET', '/api/inbound-invoices')).statusCode).toBe(200);
    expect((await t.viewerCall('POST', '/api/inbound-invoices/1/ignore')).statusCode).toBe(403);
  });

  it('lọc danh sách, bỏ qua hóa đơn; không có tệp → 400', async () => {
    const t = await tenant();
    const a = await t.one(VAT()); await t.one(CASH());
    expect((await t.call('GET', '/api/inbound-invoices?from=2026-02-01&to=2026-02-28')).json()).toHaveLength(1);
    expect((await t.call('GET', '/api/inbound-invoices?q=0100000001')).json().map((r: { id: number }) => r.id)).toEqual([a.id]);
    expect((await t.call('POST', `/api/inbound-invoices/${a.id}/ignore`)).statusCode).toBe(200);
    expect((await t.call('GET', '/api/inbound-invoices?status=ignored')).json()).toHaveLength(1);
    const empty = await ctx.app.inject({ method: 'POST', url: '/api/inbound-invoices', headers: { cookie: t.cookie, 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x--\r\n' });
    expect(empty.statusCode).toBe(400);
  });

  it('tra MST: tắt mặc định (409), bật vietqr với FakeLookup lưu tax_code_check và cảnh báo khi tên khác; lỗi tra không làm hỏng tải lên', async () => {
    const t = await tenant();
    const a = await t.one(VAT());
    expect((await t.call('GET', `/api/inbound-invoices/${a.id}`)).json().taxCodeCheck).toBeNull();
    const off = await t.call('POST', `/api/inbound-invoices/${a.id}/check-tax-code`); expect([off.statusCode, off.json().error.code]).toEqual([409, 'TAXCODE_LOOKUP_OFF']);
    expect((await t.call('PUT', '/api/settings', { tax_code_lookup: 'vietqr' })).statusCode).toBe(200);
    setTaxCodeLookupForTest(new FakeLookup({ '0100000001': { name: 'CÔNG TY TNHH KHÁC HẲN', address: 'HN', status: 'NNT đang hoạt động' } }));
    const r = await t.call('POST', `/api/inbound-invoices/${a.id}/check-tax-code`); expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ found: true, name: 'CÔNG TY TNHH KHÁC HẲN', status: 'NNT đang hoạt động', source: 'fake' });
    const d = (await t.call('GET', `/api/inbound-invoices/${a.id}`)).json();
    expect(d.taxCodeCheck).toMatchObject({ found: true });
    expect(d.warnings.map((w: { code: string }) => w.code)).toContain('TAXCODE_NAME_MISMATCH');
    // tải lên khi bật: tra luôn lúc nhận
    const b = await t.one(CASH()); expect((await t.call('GET', `/api/inbound-invoices/${b.id}`)).json().taxCodeCheck).toMatchObject({ found: false });
    setTaxCodeLookupForTest(new FakeLookup({}, true));
    const c = await t.one(withNo(CASH(), '00000457')); expect(c.status).toBe('new');
    expect((await t.call('GET', `/api/inbound-invoices/${c.id}`)).json().warnings.map((w: { code: string }) => w.code)).toContain('TAXCODE_LOOKUP_FAILED');
  });

  it('quá 50 tệp: xử lý 50 tệp đầu, thêm dòng lỗi TOO_MANY_FILES cho phần còn lại', async () => {
    const t = await tenant();
    const r = await t.upload(Array.from({ length: 51 }, (_, i) => ({ name: `f${i}.xml`, data: '<a/>' })));
    expect(r.statusCode, r.body).toBe(200);
    const res = r.json().results as { file: string; error?: { code: string } }[];
    expect(res).toHaveLength(51); expect(res[50]!.error!.code).toBe('TOO_MANY_FILES');
    expect(res.slice(0, 50).every((x) => x.error?.code === 'XML_INVALID')).toBe(true);
  });

  it('XML > 2 MB: dòng lỗi XML_TOO_LARGE của riêng nó, tệp hợp lệ cùng lượt vẫn nhận', async () => {
    const t = await tenant();
    const r = await t.upload([{ name: 'to.xml', data: Buffer.alloc(3 * 1024 * 1024, 32) }, { name: 'ok.xml', data: VAT() }]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().results).toEqual([expect.objectContaining({ file: 'to.xml', status: 'error', error: expect.objectContaining({ code: 'XML_TOO_LARGE' }) }), expect.objectContaining({ file: 'ok.xml', status: 'new' })]);
  });

  it('một tệp độc (lồng sâu, ký tự điều khiển) chỉ hỏng dòng của nó', async () => {
    const t = await tenant();
    const r = await t.upload([{ name: 'sau.xml', data: `<HDon>${'<x>'.repeat(6000)}${'</x>'.repeat(6000)}</HDon>` }, { name: 'dk.xml', data: VAT().replace('Giấy in A4', 'Giấy&#1;in') }, { name: 'ok.xml', data: VAT() }]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().results.map((x: { status: string; error?: { code: string } }) => x.error?.code ?? x.status)).toEqual(['XML_INVALID', 'XML_INVALID', 'new']);
  });

  it('số hỏng lưu NULL + blocked, không thành 0; BOM được bỏ khỏi bản lưu', async () => {
    const t = await tenant();
    const a = await t.one(`\uFEFF${VAT().replace('<ThTien>1000000</ThTien>', '<ThTien>12345678901234567</ThTien>')}`);
    expect(a.status).toBe('new');
    const d = (await t.call('GET', `/api/inbound-invoices/${a.id}`)).json();
    expect(d.blocked).toBe(true); expect(d.lines[0].amount).toBeNull(); expect(d.warnings.map((w: { code: string }) => w.code)).toContain('NUMBER_FORMAT');
    expect((await t.call('GET', `/api/inbound-invoices/${a.id}/xml`)).body.charCodeAt(0)).toBe('<'.charCodeAt(0));
    const ok = await t.one(`\uFEFF${withNo(VAT(), '00000555')}`);
    expect((await t.call('GET', `/api/inbound-invoices/${ok.id}`)).json().blocked).toBe(false);
  });

  it('tra MST: tải lại cùng tệp không gọi dịch vụ ngoài; phản hồi sai kiểu không làm hỏng tải lên', async () => {
    const t = await tenant();
    expect((await t.call('PUT', '/api/settings', { tax_code_lookup: 'vietqr' })).statusCode).toBe(200);
    let calls = 0;
    setTaxCodeLookupForTest({ lookup: async () => { calls++; return { found: true, name: 123, address: {}, status: null, source: 'x', checkedAt: 'now' } as never; } });
    const a = await t.one(VAT()); expect(a.status).toBe('new'); expect(calls).toBe(1);
    expect((await t.call('GET', `/api/inbound-invoices/${a.id}`)).json().warnings.map((w: { code: string }) => w.code)).toContain('TAXCODE_LOOKUP_FAILED');
    expect((await t.one(VAT())).status).toBe('duplicate'); expect(calls).toBe(1);
  });
});
