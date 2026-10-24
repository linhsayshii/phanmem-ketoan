import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealSecret } from '../../src/lib/secretBox.js';
import { loadConfig } from '../../src/config.js';
import { assertEInvoiceFakeAllowed, assertEInvoiceUrl, einvoicePolicy } from '../../src/modules/einvoice/providers/policy.js';
import { providerFor } from '../../src/modules/einvoice/providers/index.js';
import { SInvoiceProvider } from '../../src/modules/einvoice/providers/sinvoice.js';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

const prod = einvoicePolicy({ NODE_ENV: 'production' });
const dev = einvoicePolicy({ EINVOICE_ALLOWED_HOSTS: ' 127.0.0.1 ,mock.local', EINVOICE_ALLOW_HTTP: 'true' });

describe('chính sách địa chỉ hóa đơn điện tử (chống SSRF)', () => {
  it('mặc định chỉ https api-vinvoice.viettel.vn', () => {
    expect(() => assertEInvoiceUrl('https://api-vinvoice.viettel.vn', prod)).not.toThrow();
    for (const u of ['http://api-vinvoice.viettel.vn', 'https://evil.example', 'https://api-vinvoice.viettel.vn/x?', 'https://api-vinvoice.viettel.vn/x#a',
      'https://u:p@api-vinvoice.viettel.vn', 'https://api-vinvoice.viettel.vn:8443', 'https://127.0.0.1', 'https://169.254.169.254', 'khong-phai-url'])
      expect(() => assertEInvoiceUrl(u, prod), u).toThrow(expect.objectContaining({ code: 'EINVOICE_URL_NOT_ALLOWED', status: 400 }));
  });
  it('EINVOICE_ALLOWED_HOSTS đổi danh sách; http và cổng khác chỉ khi cờ kiểm thử; production không bao giờ cho http', () => {
    expect(() => assertEInvoiceUrl('http://127.0.0.1:4010', dev)).not.toThrow();
    expect(() => assertEInvoiceUrl('http://10.0.0.5', dev)).toThrow();
    expect(einvoicePolicy({ NODE_ENV: 'production', EINVOICE_ALLOW_HTTP: 'true' }).allowHttp).toBe(false);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', NODE_ENV: 'production', SESSION_SECRET: 'a'.repeat(40), COOKIE_SECURE: 'true', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), EINVOICE_ALLOW_HTTP: 'true' } as NodeJS.ProcessEnv)).toThrow(/EINVOICE_ALLOW_HTTP/);
  });
  it('providerFor kiểm lại địa chỉ đã lưu; fake bị chặn ở production', () => {
    const row = { code: 'sinvoice', base_url: 'http://evil.test', username: 'u', secret: sealSecret('p'), seller_tax_code: '1', options: {} };
    expect(() => providerFor(row)).toThrow(expect.objectContaining({ code: 'EINVOICE_URL_NOT_ALLOWED' }));
    expect(() => providerFor({ ...row, code: 'fake' })).not.toThrow();
    expect(() => assertEInvoiceFakeAllowed(prod)).toThrow(expect.objectContaining({ code: 'EINVOICE_FAKE_DISABLED', status: 400 }));
  });
});

describe('lưu nhà cung cấp và phản hồi bất thường', () => {
  let ctx: TestApp;
  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx.close(); });

  it('lưu baseUrl lạ → 400 EINVOICE_URL_NOT_ALLOWED', async () => {
    const a = await bootstrapTenant(ctx, { code: `EU${Date.now()}` });
    const body = { code: 'sinvoice', name: 'S', baseUrl: 'http://127.0.0.1:3000/x?', username: 'u', password: 'p', sellerTaxCode: '1' };
    const r = await ctx.app.inject({ method: 'POST', url: '/api/einvoice/providers', headers: { cookie: a.cookie }, payload: body });
    expect([r.statusCode, r.json().error.code]).toEqual([400, 'EINVOICE_URL_NOT_ALLOWED']);
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/einvoice/providers', headers: { cookie: a.cookie }, payload: { ...body, baseUrl: 'http://127.0.0.1:3000' } });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  const withServer = async (handler: Parameters<typeof createServer>[1], fn: (url: string) => Promise<void>) => {
    const s = createServer(handler); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try { await fn(`http://127.0.0.1:${(s.address() as AddressInfo).port}`); } finally { s.close(); }
  };
  const ping = (baseUrl: string, logs: unknown[]) => new SInvoiceProvider({ baseUrl, username: 'u', password: 'p', sellerTaxCode: '1' })
    .ping({ db: {} as never, log: async (x) => { logs.push(x); } }).then(() => null, (e: unknown) => e as Error & { code?: string });

  it('chuyển hướng bị từ chối (không theo)', async () => {
    let hits = 0;
    await withServer((req, res) => { hits++; res.writeHead(302, { location: 'http://127.0.0.1:1/noi-bo' }).end(); }, async (url) => {
      const e = await ping(url, []);
      expect(e).toBeInstanceOf(Error);
      expect(hits).toBe(1);
    });
  });

  it('nội dung phản hồi lạ không đi vào lỗi hay nhật ký', async () => {
    await withServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: '<script>x</script>', data: 'BI-MAT-NOI-BO' })); }, async (url) => {
      const logs: unknown[] = []; const e = await ping(url, logs);
      expect(JSON.stringify([e?.message, e?.code, logs])).not.toMatch(/BI-MAT-NOI-BO|script/);
      expect(e?.code).toBe('SINVOICE_AUTH');
    });
    await withServer((req, res) => { res.writeHead(200).end('<html>BI-MAT-NOI-BO</html>'); }, async (url) => {
      const logs: unknown[] = []; await ping(url, logs);
      expect(JSON.stringify(logs)).not.toContain('BI-MAT-NOI-BO');
    });
  });
});
