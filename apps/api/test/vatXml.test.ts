import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { loadVatTemplate, loadTaxXmlFormat } from '@kt/coa-data';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';
import { escapeXml, XML_FORMATS } from '../src/modules/tax/xml/index.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; headers: Record<string, unknown>; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];
const NAME = 'Công ty A & B <Test> "X"';

async function tenant(taxCode: string | null = '0101234567') {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `VX${Date.now()}${n++}`);
  await sql`UPDATE tenant SET name = ${NAME}, tax_code = ${taxCode}, address = 'Số 1, Đường A & B' WHERE id = ${tenantId}::uuid`.execute(ctx.t.admin);
  const call = (method: 'GET' | 'POST', url: string, payload?: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  const sale = async (date: string, amount: string) => {
    const r = await call('POST', '/api/invoices', { voucherType: 'HDB', postingDate: date, documentDate: date, partyCode: 'KH001', autoPost: true, items: [{ accountCode: '5113', amountCurrency: amount, taxCodes: ['V10'] }],
      invoice: { serial: 'C26TAA', invoiceNo: '0000001', invoiceDate: date, invoiceGroupCode: '10' } });
    expect(r.statusCode, r.body).toBe(201);
  };
  const ret = async (final: boolean) => {
    await sale('2026-07-10', '300000000');
    const c = await call('POST', '/api/tax/vat-returns', { year: 2026, periodKind: 'month', period: 7 }); expect(c.statusCode, c.body).toBe(201);
    const id = c.json().id as number;
    if (final) expect((await call('POST', `/api/tax/vat-returns/${id}/finalize`)).statusCode).toBe(200);
    return id;
  };
  return { cookie, call, ret };
}

// Kiểm cân thẻ bằng ngăn xếp trên kết quả tách regex (không thêm thư viện XML); trả về các cặp thẻ lá và nội dung.
function parse(xml: string): { leaves: Record<string, string>; depthMax: number } {
  const stack: string[] = []; const leaves: Record<string, string> = {}; let depthMax = 0;
  const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const body = xml.replace(/^<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w]*)>([^<]*)/g)) {
    const [, close, tag, text] = m as unknown as [string, string, string, string];
    if (!close) { stack.push(tag); depthMax = Math.max(depthMax, stack.length); leaves[tag] = unescape(text.trim()); }
    else { expect(stack.pop(), `thẻ đóng </${tag}>`).toBe(tag); }
  }
  expect(stack).toEqual([]);
  return { leaves, depthMax };
}

describe('xuất XML tờ khai 01/GTGT', () => {
  it('tờ khai đã chốt: XML cân thẻ, giá trị từng thẻ theo tags, tên công ty được thoát, header chưa kiểm chứng, tên tệp RFC 5987', async () => {
    const t = await tenant(); const id = await t.ret(true);
    const stored = (await t.call('GET', `/api/tax/vat-returns/${id}`)).json().values as Record<string, string>;
    const r = await t.call('GET', `/api/tax/vat-returns/${id}/xml?format=htkk-01gtgt`);
    expect(r.statusCode, r.body).toBe(200);
    expect(String(r.headers['content-type'])).toContain('application/xml');
    expect(r.headers['x-kt-unverified']).toBe('1');
    expect(r.headers['content-disposition']).toBe("attachment; filename*=UTF-8''01GTGT_0101234567_T7-2026.xml");
    expect(r.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(r.body).toContain('Công ty A &amp; B &lt;Test&gt; &quot;X&quot;');
    expect(r.body).not.toContain('<Test>');
    const { leaves } = parse(r.body);
    const f = loadTaxXmlFormat('htkk-01gtgt'); const tpl = loadVatTemplate('TT89');
    for (const l of tpl.lines) expect(leaves[f.tags[l.code]!], `[${l.code}]`).toBe(stored[l.code] ?? '');
    expect(stored['32']).toBe('300000000'); expect(stored['33']).toBe('30000000'); // có số thật, không phải toàn 0
    expect(leaves['tenNNT']).toBe(NAME); expect(leaves['maSoThue']).toBe('0101234567'); expect(leaves['loaiTKhai']).toBe('C'); expect(leaves['kyKKhaiTuNgay']).toBe('2026-07-01'); expect(leaves['kyKKhaiDenNgay']).toBe('2026-07-31');
  });

  it('tờ khai bổ sung đánh dấu loại và số lần, tên tệp có -BS', async () => {
    const t = await tenant(); const id = await t.ret(true);
    const s = await t.call('POST', '/api/tax/vat-returns', { year: 2026, periodKind: 'month', period: 7 }); expect(s.statusCode, s.body).toBe(201);
    expect((await t.call('POST', `/api/tax/vat-returns/${s.json().id}/finalize`)).statusCode).toBe(200);
    const r = await t.call('GET', `/api/tax/vat-returns/${s.json().id}/xml`);
    expect(r.statusCode, r.body).toBe(200);
    expect(String(r.headers['content-disposition'])).toContain('T7-2026-BS1.xml');
    const { leaves } = parse(r.body); expect([leaves['loaiTKhai'], leaves['soLanBoSung']]).toEqual(['B', '1']);
    expect(id).toBeGreaterThan(0);
  });

  it('định dạng lạ: 400 XML_FORMAT_INVALID (kể cả tên thuộc tính của Object); nháp: 409; thiếu mã số thuế: 409; chưa đăng nhập: 401', async () => {
    const t = await tenant(); const id = await t.ret(false);
    expect(err(await t.call('GET', `/api/tax/vat-returns/${id}/xml?format=htkk-03tndn`))).toEqual([400, 'XML_FORMAT_INVALID']);
    expect(err(await t.call('GET', `/api/tax/vat-returns/${id}/xml?format=toString`))).toEqual([400, 'XML_FORMAT_INVALID']);
    expect(err(await t.call('GET', `/api/tax/vat-returns/${id}/xml`))).toEqual([409, 'TAX_RETURN_NOT_FINAL']);
    expect(err(await t.call('GET', '/api/tax/vat-returns/999999/xml'))).toEqual([404, 'TAX_RETURN_NOT_FOUND']);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/tax/vat-returns/${id}/xml` })).statusCode).toBe(401);
    const n0 = await tenant(null); const id0 = await n0.ret(true);
    expect(err(await n0.call('GET', `/api/tax/vat-returns/${id0}/xml`))).toEqual([409, 'COMPANY_TAX_CODE_MISSING']);
  });

  it('thiếu tax.view: 403 FORBIDDEN dù có tax_return.view', async () => {
    const t = await tenant(); const id = await t.ret(true);
    const roles = (await t.call('GET', '/api/roles')).json() as { id: string; code: string }[];
    const xem = roles.find((r) => r.code === 'xem')!;
    const put = await ctx.app.inject({ method: 'PUT', url: `/api/roles/${xem.id}/permissions`, headers: { cookie: t.cookie }, payload: { permissions: ['tax_return.view'] } }); expect(put.statusCode, put.body).toBe(200);
    const username = `vx_xem_${Date.now()}${n++}`;
    expect((await t.call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'xem', sensitiveFlags: [] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const viewer = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    expect(err(await t.call('GET', `/api/tax/vat-returns/${id}/xml`, undefined, viewer))).toEqual([403, 'FORBIDDEN']);
    expect((await t.call('GET', `/api/tax/vat-returns/${id}`, undefined, viewer)).statusCode).toBe(200);
    const fm = await t.call('GET', '/api/tax/xml-formats', undefined, viewer);
    expect(fm.json()).toEqual([{ id: 'htkk-01gtgt', formCode: '01/GTGT', verified: false }, { id: 'htkk-03tndn', formCode: '03/TNDN', verified: false }]);
  });

  it('in tờ khai: HTML theo bố cục mẫu (mọi chỉ tiêu, số lưu), bản nháp ghi rõ', async () => {
    const t = await tenant(); const id = await t.ret(false);
    const r = await t.call('GET', `/api/tax/vat-returns/${id}/print?format=html`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('TỜ KHAI THUẾ GIÁ TRỊ GIA TĂNG'); expect(r.body).toContain('Mẫu số 01/GTGT'); expect(r.body).toContain('bản nháp, chưa chốt');
    for (const l of loadVatTemplate('TT89').lines) expect(r.body, `[${l.code}]`).toContain(`[${l.code}]`);
    expect(r.body).toContain('300.000.000');
    expect(r.body).toContain('Chỉ tiêu [41] hiện số dương: là phần âm của biểu thức [36]-[22]+[37]-[38]-[39a] đổi dấu'); // chú thích dựng từ clamp/formula của mẫu
    expect(r.body).toContain('Chỉ tiêu [43] = [41]-[42]');
  });
});

describe('escapeXml', () => {
  it('thoát & < > " \' và bỏ ký tự điều khiển; XML_FORMATS có htkk-01gtgt, htkk-03tndn, cùng verified=false', () => {
    expect(escapeXml('a&b<c>"d\'e\u0001\u000Bf')).toBe('a&amp;b&lt;c&gt;&quot;d&apos;ef');
    expect(escapeXml('Tiếng Việt: đồng')).toBe('Tiếng Việt: đồng');
    expect(escapeXml('a\uD83D\uDE00b')).toBe('a\uD83D\uDE00b'); // cặp thay thế đủ giữ nguyên
    expect(escapeXml('a\uD83Db\uDE00c\uFFFEd\uFFFFe')).toBe('abcde'); // nửa cặp lẻ, U+FFFE, U+FFFF bị bỏ
    expect(Object.keys(XML_FORMATS)).toEqual(['htkk-01gtgt', 'htkk-03tndn']);
    expect(XML_FORMATS['htkk-03tndn']).toMatchObject({ verified: false, formCode: '03/TNDN', templateVersions: ['TT89', 'TT80'] });
    expect(XML_FORMATS['htkk-01gtgt']).toMatchObject({ verified: false, formCode: '01/GTGT', templateVersions: ['TT89', 'TT80'] });
  });
});

describe('mẫu và gợi ý cho màn hình tờ khai', () => {
  it('vat-template trả chỉ tiêu theo mẫu của kỳ; kỳ trước 01/7/2026 dùng mẫu TT80', async () => {
    const t = await tenant();
    const ok = await t.call('GET', '/api/tax/vat-template?year=2026&periodKind=month&period=7');
    expect(ok.statusCode, ok.body).toBe(200);
    const body = ok.json(); expect(body.version).toBe('TT89');
    expect(body.lines.map((l: { code: string }) => l.code)).toEqual(loadVatTemplate('TT89').lines.map((l) => l.code));
    const old = await t.call('GET', '/api/tax/vat-template?year=2026&periodKind=month&period=6');
    expect(old.statusCode, old.body).toBe(200);
    expect(old.json().version).toBe('TT80');
    expect(old.json().lines.map((l: { code: string }) => l.code)).toEqual(loadVatTemplate('TT80').lines.map((l) => l.code));
  });

  it('hints: kỳ trước có tờ khai lần đầu đã chốt thì carryLocked = true (khóa ô [22])', async () => {
    const t = await tenant(); await t.ret(true);
    const c = await t.call('POST', '/api/tax/vat-returns', { year: 2026, periodKind: 'month', period: 8 }); expect(c.statusCode, c.body).toBe(201);
    expect(c.json().carryLocked).toBe(true);
    expect((await t.call('GET', `/api/tax/vat-returns/${c.json().id}/hints`)).json().carryLocked).toBe(true);
  });

  it('hints: nháp trả gợi ý [25] và số lệch rỗng; sổ đổi sau khi lập thì changed nêu chỉ tiêu; đã chốt thì rỗng', async () => {
    const t = await tenant(); const id = await t.ret(false);
    const h = (await t.call('GET', `/api/tax/vat-returns/${id}/hints`)).json();
    expect(h.carryLocked).toBe(false); // kỳ trước chưa có tờ khai đã chốt: [22] nhập tay được
    expect(h.changed).toEqual([]); expect(h.hints['25']).toContain('Gợi ý'); expect(Array.isArray(h.warnings)).toBe(true);
    await t.call('POST', '/api/invoices', { voucherType: 'HDB', postingDate: '2026-07-20', documentDate: '2026-07-20', partyCode: 'KH001', autoPost: true, items: [{ accountCode: '5113', amountCurrency: '100000000', taxCodes: ['V10'] }],
      invoice: { serial: 'C26TAA', invoiceNo: '0000002', invoiceDate: '2026-07-20', invoiceGroupCode: '10' } });
    const h2 = (await t.call('GET', `/api/tax/vat-returns/${id}/hints`)).json();
    expect(h2.changed.map((x: { code: string }) => x.code)).toContain('32');
    expect((await t.call('POST', `/api/tax/vat-returns/${id}/finalize`)).statusCode).toBe(409);
    const put = await ctx.app.inject({ method: 'PUT', url: `/api/tax/vat-returns/${id}`, headers: { cookie: t.cookie }, payload: {} }); expect(put.statusCode, put.body).toBe(200);
    expect((await t.call('POST', `/api/tax/vat-returns/${id}/finalize`)).statusCode).toBe(200);
    expect((await t.call('GET', `/api/tax/vat-returns/${id}/hints`)).json()).toEqual({ hints: {}, warnings: [], carryLocked: false, changed: [] });
  });
});
