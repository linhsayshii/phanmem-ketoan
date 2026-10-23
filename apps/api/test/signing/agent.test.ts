import { spawn, type ChildProcess } from 'node:child_process';
import { constants, createPublicKey, publicDecrypt, X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropKey, makeKey } from './keys.js';

const key = makeKey('Tien ich ky');
let proc: ChildProcess; let base = '';
const ORIGIN = 'http://localhost:5173';
const agentPath = new URL('../../../../tools/signer-agent/index.mjs', import.meta.url).pathname;

beforeAll(async () => {
  proc = spawn(process.execPath, [agentPath, '--key', key.keyFile, '--cert', key.certFile, '--port', '0', '--origin', ORIGIN, '--yes'], { stdio: ['ignore', 'pipe', 'inherit'] });
  base = await new Promise<string>((res, rej) => { proc.stdout!.on('data', (d: Buffer) => { const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d)); if (m) res(m[1]!); }); proc.on('exit', () => rej(new Error('agent thoát'))); });
});
afterAll(() => { proc.kill(); dropKey(key); });

const sha = Buffer.alloc(32, 7);
const serial = new X509Certificate(key.certDer).serialNumber.toLowerCase();
const sign = (headers: Record<string, string>, body: object) => fetch(`${base}/v1/sign`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('tiện ích ký cục bộ tham chiếu', () => {
  it('GET /v1/certificates trả chứng thư của khóa; POST /v1/sign ký đúng digest (PKCS#1 v1.5 DigestInfo SHA-256)', async () => {
    const list = await (await fetch(`${base}/v1/certificates`, { headers: { origin: ORIGIN } })).json() as { serial: string; subject: string; certB64: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ serial, certB64: key.certDer.toString('base64') });
    expect(list[0]!.subject).toContain('CN=Tien ich ky');
    const r = await sign({ origin: ORIGIN }, { certSerial: serial, digestB64: sha.toString('base64'), algorithm: 'RSA-SHA256' });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const sig = Buffer.from(((await r.json()) as { signatureB64: string }).signatureB64, 'base64');
    const plain = publicDecrypt({ key: createPublicKey(key.certPem), padding: constants.RSA_PKCS1_PADDING }, sig);
    expect(plain.subarray(-32).equals(sha)).toBe(true);
    expect(plain.subarray(0, 19).toString('hex')).toBe('3031300d060960864801650304020105000420');
  });
  it('từ chối: nguồn lạ, Host lạ, thuật toán/độ dài sai, serial lạ; CORS chỉ cho origin cấu hình', async () => {
    const ok = { certSerial: serial, digestB64: sha.toString('base64'), algorithm: 'RSA-SHA256' };
    expect((await sign({ origin: 'https://evil.example' }, ok)).status).toBe(403);
    expect((await sign({}, ok)).status).toBe(403);
    expect((await sign({ origin: ORIGIN }, { ...ok, algorithm: 'RSA-SHA1' })).status).toBe(400);
    expect((await sign({ origin: ORIGIN }, { ...ok, digestB64: 'AAAA' })).status).toBe(400);
    expect((await sign({ origin: ORIGIN }, { ...ok, certSerial: 'dead' })).status).toBe(404);
    const evil = await fetch(`${base}/v1/certificates`, { headers: { origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await fetch(`${base}/v1/sign`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-private-network')).toBe('true');
    expect((await fetch(`${base}/v1/sign`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });
});

describe('tiện ích ký: xác nhận y/n tuần tự', () => {
  it('hai yêu cầu ký đồng thời: câu hỏi hiện lần lượt, câu trả lời không bị lẫn (y cho yêu cầu đầu, n cho yêu cầu sau)', async () => {
    const p = spawn(process.execPath, [agentPath, '--key', key.keyFile, '--cert', key.certFile, '--port', '0', '--origin', ORIGIN], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      let asked = 0; let err = '';
      p.stderr!.on('data', (d: Buffer) => { err += String(d); asked = (err.match(/\(y\/n\)/g) ?? []).length; });
      const url = await new Promise<string>((res, rej) => { p.stdout!.on('data', (d: Buffer) => { const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d)); if (m) res(m[1]!); }); p.on('exit', () => rej(new Error('agent thoát'))); });
      const go = (digest: Buffer) => fetch(`${url}/v1/sign`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ certSerial: serial, digestB64: digest.toString('base64'), algorithm: 'RSA-SHA256' }) });
      const a = go(Buffer.alloc(32, 1)); const b = go(Buffer.alloc(32, 2));
      const until = async (n: number) => { for (let i = 0; i < 100 && asked < n; i++) await new Promise((r) => setTimeout(r, 50)); expect(asked).toBe(n); };
      await until(1); await new Promise((r) => setTimeout(r, 200)); expect(asked).toBe(1); // câu hỏi thứ hai chưa hiện khi câu đầu chưa trả lời
      p.stdin!.write('y\n'); await until(2); p.stdin!.write('n\n');
      const [ra, rb] = await Promise.all([a, b]);
      expect([ra.status, rb.status].sort()).toEqual([200, 403]);
      expect(((await (ra.status === 403 ? ra : rb).json()) as { error: string }).error).toBe('USER_DECLINED');
    } finally { p.kill(); }
  });
});
