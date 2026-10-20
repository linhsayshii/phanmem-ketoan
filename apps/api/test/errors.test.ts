import { afterAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import errorsPlugin from '../src/plugins/errors.js';

const app = Fastify();
await app.register(errorsPlugin);
const pgError = (code: string) => Object.assign(new Error('lỗi từ PostgreSQL'), { code });
app.get('/deadlock', async () => { throw pgError('40P01'); });
app.get('/serialization', async () => { throw pgError('40001'); });
app.get('/duplicate', async () => { throw pgError('23505'); });
afterAll(async () => { await app.close(); });

describe('ánh xạ lỗi PostgreSQL', () => {
  it.each(['/deadlock', '/serialization'])('%s -> 409 CONCURRENT_RETRY để người dùng thử lại', async (url) => {
    const r = await app.inject({ method: 'GET', url });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: { code: 'CONCURRENT_RETRY', message: 'Thao tác đồng thời bị xung đột, hãy thử lại' } });
  });
  it('lỗi 23505 vẫn là DUPLICATE', async () => {
    expect((await app.inject({ method: 'GET', url: '/duplicate' })).json().error.code).toBe('DUPLICATE');
  });
});
