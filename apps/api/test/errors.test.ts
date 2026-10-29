import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import errorsPlugin from '../src/plugins/errors.js';

const app = Fastify();
app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
await app.register(errorsPlugin);
const pgError = (code: string) => Object.assign(new Error('lỗi từ PostgreSQL'), { code });
const raise = (message: string) => Object.assign(new Error(message), { code: 'P0001' });
app.get('/deadlock', async () => { throw pgError('40P01'); });
app.get('/serialization', async () => { throw pgError('40001'); });
app.get('/duplicate', async () => { throw pgError('23505'); });
app.get('/duplicate-code', async () => { throw Object.assign(pgError('23505'), { constraint: 'party_tenant_id_code_key' }); });
app.get('/duplicate-other', async () => { throw Object.assign(pgError('23505'), { constraint: 'voucher_tenant_id_idempotency_key_key' }); });
app.get('/overflow', async () => { throw pgError('22003'); });
app.get('/raise-not-found', async () => { throw raise('VOUCHER_NOT_FOUND: x'); });
app.get('/raise-posted', async () => { throw raise('VOUCHER_POSTED: y'); });
app.get('/year/:year', { schema: { params: z.object({ year: z.coerce.number().int() }) } }, async () => ({ ok: true }));
afterAll(async () => { await app.close(); });

// Các đối số của lời gọi AppError(...) (bắt đầu tại dấu '('), bỏ qua chuỗi trong nháy để thông báo chứa ';' hay ')' không làm lệch.
function appErrorArgs(src: string, open: number): string[] {
  const args: string[] = []; let depth = 0; let start = open + 1; let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (--depth === 0) return [...args, src.slice(start, i).trim()]; }
    else if (c === ',' && depth === 1) { args.push(src.slice(start, i).trim()); start = i + 1; }
  }
  return args;
}

describe('lỗi kiểm tra tham số của fastify', () => {
  it('400 VALIDATION giữ thông báo gốc và thêm details (lỗi zod có path mảng, phạm vi) để giao diện dịch ra tiếng Việt', async () => {
    const r = await app.inject({ method: 'GET', url: '/year/undefined' });
    const e = r.json().error;
    expect([r.statusCode, e.code, e.message]).toEqual([400, 'VALIDATION', 'params/year Expected number, received nan']);
    expect(e.details).toHaveLength(1);
    expect(e.details[0]).toMatchObject({ path: ['year'], code: 'invalid_type', expected: 'number', received: 'nan', scope: 'params' });
  });
});

describe('ánh xạ lỗi PostgreSQL', () => {
  it.each(['/deadlock', '/serialization'])('%s -> 409 CONCURRENT_RETRY để người dùng thử lại', async (url) => {
    const r = await app.inject({ method: 'GET', url });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: { code: 'CONCURRENT_RETRY', message: 'Thao tác đồng thời bị xung đột, hãy thử lại' } });
  });
  it('lỗi 23505 vẫn là DUPLICATE', async () => {
    expect((await app.inject({ method: 'GET', url: '/duplicate' })).json().error.code).toBe('DUPLICATE');
  });
  it('lỗi 23505 không lộ tên ràng buộc: "Mã đã tồn tại" khi trùng mã, còn lại "Trùng dữ liệu đã có"', async () => {
    const code = await app.inject({ method: 'GET', url: '/duplicate-code' });
    expect([code.statusCode, code.json().error]).toEqual([409, { code: 'DUPLICATE', message: 'Mã đã tồn tại' }]);
    for (const url of ['/duplicate', '/duplicate-other']) expect((await app.inject({ method: 'GET', url })).json().error).toEqual({ code: 'DUPLICATE', message: 'Trùng dữ liệu đã có' });
  });
  it('lỗi dữ liệu lớp 22 (tràn số) là 400 VALIDATION', async () => {
    const r = await app.inject({ method: 'GET', url: '/overflow' });
    expect([r.statusCode, r.json().error.code]).toEqual([400, 'VALIDATION']);
  });
  it('P0001 mã *_NOT_FOUND từ SQL trả 404, mã khác 409', async () => {
    const nf = await app.inject({ method: 'GET', url: '/raise-not-found' });
    expect([nf.statusCode, nf.json().error.code]).toEqual([404, 'VOUCHER_NOT_FOUND']);
    const posted = await app.inject({ method: 'GET', url: '/raise-posted' });
    expect([posted.statusCode, posted.json().error.code]).toEqual([409, 'VOUCHER_POSTED']);
  });
  it('mọi AppError *_NOT_FOUND trong mã nguồn dùng 404', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const found: [file: string, code: string, status: string][] = [];
    for (const f of (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(root, f), 'utf8');
      for (const m of src.matchAll(/AppError\(\s*'([A-Z_]+_NOT_FOUND)'/g)) found.push([f, m[1]!, appErrorArgs(src, m.index! + 'AppError'.length)[2]!]);
    }
    expect(found.length).toBeGreaterThan(5); // chốt rằng bộ quét thật sự thấy các lời gọi, không khớp rỗng
    expect(found.filter(([, , status]) => status !== '404')).toEqual([]);
  });
});
