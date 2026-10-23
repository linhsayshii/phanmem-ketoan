import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { httpJson, NetworkError } from '../../src/lib/http.js';

let srv: Server; let base: string;
beforeAll(async () => {
  srv = createServer((req, res) => {
    if (req.url === '/slow') return void setTimeout(() => res.end('{}'), 500);
    if (req.url === '/html') { res.setHeader('content-type', 'text/html'); return void res.end('<html>502</html>'); }
    res.setHeader('content-type', 'application/json'); res.end('{"a":1}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }));

describe('httpJson', () => {
  it('JSON hợp lệ: status, body, raw', async () => {
    const r = await httpJson<{ a: number }>(`${base}/ok`, { method: 'GET', timeoutMs: 2000 });
    expect(r).toMatchObject({ status: 200, body: { a: 1 }, raw: '{"a":1}' });
  });
  it('quá thời gian chờ → NetworkError timeout', async () => {
    const p = httpJson(`${base}/slow`, { method: 'GET', timeoutMs: 50 });
    await expect(p).rejects.toBeInstanceOf(NetworkError);
    await expect(p).rejects.toMatchObject({ kind: 'timeout' });
  });
  it('từ chối kết nối → NetworkError network', async () => {
    const s = createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port; await new Promise<void>((r) => s.close(() => r()));
    await expect(httpJson(`http://127.0.0.1:${port}/`, { method: 'GET', timeoutMs: 2000 })).rejects.toMatchObject({ kind: 'network' });
  });
  it('phản hồi không phải JSON: body null, raw giữ nguyên, status trả về', async () => {
    const r = await httpJson(`${base}/html`, { method: 'GET', timeoutMs: 2000 });
    expect(r).toMatchObject({ status: 200, body: null, raw: '<html>502</html>' });
  });
});
