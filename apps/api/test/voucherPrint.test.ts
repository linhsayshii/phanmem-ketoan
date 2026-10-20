import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VoucherDto } from '../src/modules/ledger/vouchers.service.js';
import { renderPdf } from '../src/modules/reporting/print/pdf.js';
import { renderVoucherHtml } from '../src/modules/reporting/print/voucherHtml.js';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let id: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `PT${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  id = (await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: '2026-01-05', documentDate: '2026-01-05', description: 'Chi văn phòng phẩm', autoPost: true, lines: [{ accountCode: '6422', debit: '1500000' }, { accountCode: '1111', credit: '1500000' }] } })).json().id;
}, 30_000);
afterAll(async () => { await ctx.close(); });

describe('in phiếu kế toán', () => {
  it('HTML có tên công ty, số chứng từ, số tiền định dạng Việt Nam, chữ ký', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${id}/print?format=html`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('PHIẾU KẾ TOÁN'); expect(r.body).toContain('PKT00001'); expect(r.body).toContain('1.500.000'); expect(r.body).toContain('Kế toán trưởng'); expect(r.body).toContain('6422');
  }, 30_000);
  it('PDF bắt đầu bằng %PDF, tên tệp mã hóa theo RFC 5987', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${id}/print?format=pdf`, headers: { cookie } });
    expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toBe('application/pdf'); expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(r.headers['content-disposition']).toBe(`inline; filename*=UTF-8''${encodeURIComponent('PKT00001.pdf')}`);
  }, 60_000);
});

describe('in phiếu kế toán: nội dung', () => {
  it('diễn giải có thẻ script được thoát ký tự trong HTML in', async () => {
    const c = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: '2026-01-06', documentDate: '2026-01-06', description: '<script>alert(1)</script>', lines: [{ accountCode: '6422', debit: '10' }, { accountCode: '1111', credit: '10' }] } });
    expect(c.statusCode, c.body).toBe(201);
    const r = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${c.json().id}/print?format=html`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('&lt;script&gt;'); expect(r.body).not.toContain('<script>alert');
  }, 30_000);

  it('phiếu nháp lệch: Cộng Nợ và Cộng Có tính riêng (Có không lấy theo Nợ)', () => {
    const line = (lineNo: number, accountCode: string, debit: string, credit: string) => ({ lineNo, accountCode, accountName: 'x', debit, credit, partyCode: null, partyName: null, description: null });
    const v = { id: 'x', voucherType: 'PKT', voucherNo: null, postingDate: '2026-01-05', state: 'draft', description: 'Nháp lệch', partyName: null, totalDebit: '1500000',
      lines: [line(1, '6422', '1500000', '0'), line(2, '1111', '0', '1000000')] } as unknown as VoucherDto;
    const html = renderVoucherHtml(v, { name: 'Cty', address: null, taxCode: null, legalRep: null, chiefAccountant: null, formNo: 'PKT', issuedBy: '' });
    expect(html).toMatch(/<b>Cộng<\/b><\/td><td class="num"><b>1\.500\.000<\/b><\/td><td class="num"><b>1\.000\.000<\/b><\/td>/);
  });
});

// Tiêu đề tài liệu nằm trong từ điển Info của PDF, dạng UTF-16BE (chuỗi hex) hoặc chuỗi thường.
const hasTitle = (pdf: Buffer, title: string) => {
  const s = pdf.toString('latin1');
  const hex = Buffer.from(title, 'utf16le').swap16().toString('hex').toUpperCase();
  return s.toUpperCase().includes(`<FEFF${hex}>`) || s.includes(`(${title})`);
};

describe('renderPdf: cách ly', () => {
  it('không chạy script và không gọi ra ngoài; vẫn tạo được PDF', async () => {
    let hits = 0;
    const srv = createServer((_q, res) => { hits++; res.end(); });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    const port = (srv.address() as AddressInfo).port;
    try {
      const html = `<!doctype html><html><head><title>AN_TOAN</title><link rel="stylesheet" href="http://127.0.0.1:${port}/a.css"></head>
        <body><p>noi dung</p><img src="http://127.0.0.1:${port}/x.png"><img src="http://127.0.0.1:9/x">
        <script>document.title = 'DA_CHAY_SCRIPT'; fetch('http://127.0.0.1:${port}/js');</script></body></html>`;
      const pdf = await renderPdf(html);
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      expect(hasTitle(pdf, 'AN_TOAN')).toBe(true); // đối chứng: kiểm tra tiêu đề thật sự đọc được
      expect(hasTitle(pdf, 'DA_CHAY_SCRIPT')).toBe(false);
      expect(hits).toBe(0);
    } finally { await new Promise((ok) => srv.close(ok)); }
  }, 60_000);
});
