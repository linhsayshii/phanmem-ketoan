import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import FormData from 'form-data';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string; let voucherId: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `AT${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  voucherId = (await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: '2026-01-05', documentDate: '2026-01-05', description: 'x', lines: [{ accountCode: '6422', debit: '10' }, { accountCode: '1111', credit: '10' }] } })).json().id;
}, 30_000);
afterAll(async () => { await ctx.close(); });

const upload = (url: string, name: string, body: string, type = 'text/plain', c = cookie) => {
  const fd = new FormData(); fd.append('file', Buffer.from(body), { filename: name, contentType: type });
  return ctx.app.inject({ method: 'POST', url, headers: { cookie: c, ...fd.getHeaders() }, payload: fd.getBuffer() });
};

describe('đính kèm', () => {
  it('tải lên, liệt kê, tải về đúng nội dung, xóa', async () => {
    const up = await upload(`/api/vouchers/${voucherId}/attachments`, 'hoadon.txt', 'hoa don mau');
    expect(up.statusCode, up.body).toBe(201); expect(up.json()).toMatchObject({ fileName: 'hoadon.txt', bytes: 11 });
    const list = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${voucherId}/attachments`, headers: { cookie } });
    expect(list.json()).toHaveLength(1);
    const dl = await ctx.app.inject({ method: 'GET', url: `/api/attachments/${up.json().id}`, headers: { cookie } });
    expect(dl.body).toBe('hoa don mau'); expect(dl.headers['content-disposition']).toContain('hoadon.txt');
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/attachments/${up.json().id}`, headers: { cookie } })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${voucherId}/attachments`, headers: { cookie } })).json()).toHaveLength(0);
  }, 30_000);

  it('tải về luôn là tệp đính kèm, không đoán kiểu nội dung, tên tiếng Việt qua filename*', async () => {
    const up = await upload(`/api/vouchers/${voucherId}/attachments`, 'hóa đơn #1.html', '<script>alert(1)</script>', 'text/html');
    expect(up.statusCode, up.body).toBe(201);
    const dl = await ctx.app.inject({ method: 'GET', url: `/api/attachments/${up.json().id}`, headers: { cookie } });
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('hóa đơn #1.html')}`);
    await ctx.app.inject({ method: 'DELETE', url: `/api/attachments/${up.json().id}`, headers: { cookie } });
  }, 30_000);

  it('chứng từ không có: 404 và không để lại tệp', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const r = await upload(`/api/vouchers/${id}/attachments`, 'a.txt', 'a');
    expect(r.statusCode).toBe(404); expect(r.json().error.code).toBe('VOUCHER_NOT_FOUND');
    expect(existsSync(path.join(ctx.app.config.ATTACHMENT_DIR, tenantId, id))).toBe(false);
  }, 30_000);

  it('công ty khác không tải được tệp', async () => {
    const up = await upload(`/api/vouchers/${voucherId}/attachments`, 'mat.txt', 'bi mat');
    const other = await bootstrapTenant(ctx, { code: `AU${Date.now()}` });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/attachments/${up.json().id}`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/attachments/${up.json().id}`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    await ctx.app.inject({ method: 'DELETE', url: `/api/attachments/${up.json().id}`, headers: { cookie } });
  }, 30_000);

  it('ghi tệp xong mà giao dịch lỗi thì xóa tệp mồ côi', async () => {
    // Trigger chỉ nổ với tên tệp này, sau khi tệp đã ghi (lúc UPDATE storage_key); luôn dọn trigger ở finally.
    await sql`CREATE OR REPLACE FUNCTION test_att_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.file_name = 'loi-sau-ghi.txt' THEN RAISE EXCEPTION 'thử lỗi' USING ERRCODE = 'XX000'; END IF; RETURN NEW; END $$`.execute(ctx.t.admin);
    await sql`CREATE TRIGGER test_att_fail BEFORE UPDATE ON voucher_attachment FOR EACH ROW EXECUTE FUNCTION test_att_fail()`.execute(ctx.t.admin);
    try {
      const r = await upload(`/api/vouchers/${voucherId}/attachments`, 'loi-sau-ghi.txt', 'mo coi');
      expect(r.statusCode).toBe(500);
      const dir = path.join(ctx.app.config.ATTACHMENT_DIR, tenantId, voucherId);
      expect(existsSync(dir) ? readdirSync(dir) : []).toHaveLength(0);
      expect((await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${voucherId}/attachments`, headers: { cookie } })).json()).toHaveLength(0);
    } finally {
      await sql`DROP TRIGGER IF EXISTS test_att_fail ON voucher_attachment`.execute(ctx.t.admin);
      await sql`DROP FUNCTION IF EXISTS test_att_fail()`.execute(ctx.t.admin);
    }
  }, 30_000);
});
