import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie: string, payload?: object) =>
  ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const provider = { code: 'sinvoice', name: 'SInvoice', baseUrl: 'https://api.example.test', username: 'u1', password: 'Bi-mat-123', sellerTaxCode: '0100109106-997' };

describe('cấu hình nhà cung cấp hóa đơn điện tử', () => {
  it('GET không trả mật khẩu, hasSecret true; audit_event không chứa mật khẩu; PUT bỏ trống mật khẩu giữ bí mật cũ', async () => {
    const a = await bootstrapTenant(ctx, { code: `EP${Date.now()}` });
    const c = await call('POST', '/api/einvoice/providers', a.cookie, provider);
    expect(c.statusCode, c.body).toBe(201);
    expect(c.body).not.toContain('Bi-mat-123');
    const id = c.json().id;
    const list = await call('GET', '/api/einvoice/providers', a.cookie);
    expect(list.body).not.toContain('Bi-mat-123');
    expect(list.json()[0]).toMatchObject({ id, code: 'sinvoice', hasSecret: true, username: 'u1' });
    expect(list.json()[0]).not.toHaveProperty('secret');
    const before = (await sql<{ s: string }>`SELECT encode(secret, 'hex') AS s FROM einvoice_provider WHERE id = ${id}`.execute(ctx.t.admin)).rows[0]!.s;
    const u = await call('PUT', `/api/einvoice/providers/${id}`, a.cookie, { ...provider, password: '', name: 'SInvoice 2' });
    expect(u.statusCode, u.body).toBe(200);
    expect(u.json()).toMatchObject({ name: 'SInvoice 2', hasSecret: true });
    expect((await sql<{ s: string }>`SELECT encode(secret, 'hex') AS s FROM einvoice_provider WHERE id = ${id}`.execute(ctx.t.admin)).rows[0]!.s).toBe(before);
    await call('PUT', `/api/einvoice/providers/${id}`, a.cookie, { ...provider, password: 'Moi-456' });
    expect((await sql<{ s: string }>`SELECT encode(secret, 'hex') AS s FROM einvoice_provider WHERE id = ${id}`.execute(ctx.t.admin)).rows[0]!.s).not.toBe(before);
    const audit = await sql<{ b: string }>`SELECT (coalesce(before::text, '') || coalesce(after::text, '')) AS b FROM audit_event WHERE tenant_id = ${a.tenantId}::uuid AND entity = 'einvoice_provider'`.execute(ctx.t.admin);
    expect(audit.rows.length).toBe(3);
    expect(audit.rows.map((r) => r.b).join()).toContain('"***"');
    expect(audit.rows.map((r) => r.b).join()).not.toMatch(/\\x[0-9a-f]{20}/);
    expect((await call('DELETE', `/api/einvoice/providers/${id}`, a.cookie)).statusCode).toBe(204);
  });
  it('ký hiệu: hợp lệ tạo được, 1C26MAA kind standard → 400, M ⇔ cash_register, trùng → 409, năm theo ký hiệu', async () => {
    const a = await bootstrapTenant(ctx, { code: `ES${Date.now()}` });
    const pid = (await call('POST', '/api/einvoice/providers', a.cookie, { ...provider, code: 'fake' })).json().id;
    const ok = await call('POST', '/api/einvoice/series', a.cookie, { providerId: pid, formNo: '1', serial: 'C26TAA', kind: 'standard', providerTemplate: '1/001' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ formNo: '1', serial: 'C26TAA', year: 2026, kind: 'standard', providerTemplate: '1/001' });
    const bad = await call('POST', '/api/einvoice/series', a.cookie, { providerId: pid, formNo: '1', serial: 'C26MAA', kind: 'standard' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVOICE_SYMBOL_INVALID');
    expect((await call('POST', '/api/einvoice/series', a.cookie, { providerId: pid, formNo: '1', serial: 'C26TAA', kind: 'standard' })).statusCode).toBe(409);
    expect((await call('POST', '/api/einvoice/series', a.cookie, { providerId: pid, formNo: '0', serial: 'C26TAB', kind: 'standard' })).json().error.code).toBe('INVOICE_SYMBOL_INVALID');
    expect((await call('POST', '/api/einvoice/series', a.cookie, { providerId: pid, formNo: '1', serial: 'K26MAA', kind: 'cash_register' })).statusCode).toBe(201);
    expect((await call('GET', '/api/einvoice/series', a.cookie)).json()).toHaveLength(2);
    expect((await call('PUT', `/api/einvoice/series/${ok.json().id}`, a.cookie, { providerId: pid, formNo: '1', serial: 'C26TAA', kind: 'standard', note: 'ghi chú' })).json().note).toBe('ghi chú');
    expect((await call('DELETE', `/api/einvoice/series/${ok.json().id}`, a.cookie)).statusCode).toBe(204);
  });
  it('ketoan_vien POST /api/einvoice/providers → 403; có einvoice.view thì đọc được', async () => {
    const a = await bootstrapTenant(ctx, { code: `EK${Date.now()}` });
    const username = `ek_${Date.now()}`;
    expect((await call('POST', '/api/users', a.cookie, { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: [] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const kv = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    expect((await call('POST', '/api/einvoice/providers', kv, provider)).statusCode).toBe(403);
    expect((await call('GET', '/api/einvoice/providers', kv)).statusCode).toBe(200);
  });
  it('thiếu DATA_ENCRYPTION_KEY: lưu mật khẩu → 409 ENCRYPTION_KEY_MISSING', async () => {
    const a = await bootstrapTenant(ctx, { code: `EM${Date.now()}` });
    const k = process.env.DATA_ENCRYPTION_KEY; delete process.env.DATA_ENCRYPTION_KEY;
    try {
      const r = await call('POST', '/api/einvoice/providers', a.cookie, provider);
      expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('ENCRYPTION_KEY_MISSING');
    } finally { process.env.DATA_ENCRYPTION_KEY = k; }
  });
});
