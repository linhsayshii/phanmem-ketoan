#!/usr/bin/env node
/* global process, console, Buffer, URL */
// Tiện ích ký số cục bộ THAM CHIẾU (docs/dev/ky-so-cuc-bo.md). Chỉ dùng module node:, khóa riêng đọc từ tệp PEM (node:crypto không đọc được .pfx;
// đổi: openssl pkcs12 -in a.pfx -nodes -out a.pem, tách khóa và chứng thư ra hai tệp). USB token thật cần thư viện PKCS#11 của hãng: chưa thử với token thật.
import { constants, createPrivateKey, privateEncrypt, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const { values: o } = parseArgs({ options: {
  key: { type: 'string' }, cert: { type: 'string' }, port: { type: 'string', default: '18765' },
  origin: { type: 'string', default: process.env.WEB_ORIGIN ?? 'http://localhost:5173' }, yes: { type: 'boolean', default: false },
} });
if (!o.key || !o.cert) { console.error('Dùng: node index.mjs --key khoa.pem --cert chungthu.pem [--origin http://localhost:5173] [--port 18765] [--yes]'); process.exit(2); }

const privateKey = createPrivateKey(readFileSync(o.key));
const cert = new X509Certificate(readFileSync(o.cert));
const SHA256_PREFIX = Buffer.from('3031300d060960864801650304020105000420', 'hex'); // DigestInfo của SHA-256
const info = { serial: cert.serialNumber.toLowerCase(), subject: cert.subject.split('\n').reverse().join(','), notAfter: new Date(cert.validTo).toISOString(), certB64: cert.raw.toString('base64') };
const rl = o.yes ? null : createInterface({ input: process.stdin, output: process.stderr });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(/^y(es)?$/i.test(a.trim()))));

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', ...(origin === o.origin && { 'access-control-allow-origin': origin, vary: 'origin' }) });
    res.end(JSON.stringify(body));
  };
  // Chống DNS rebinding: chỉ nhận Host là địa chỉ lặp.
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) return send(403, { error: 'HOST_REJECTED' });
  if (req.method === 'OPTIONS') {
    if (origin !== o.origin) return send(403, { error: 'ORIGIN_REJECTED' });
    res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true', 'access-control-max-age': '600', vary: 'origin' });
    return res.end();
  }
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/certificates') return send(200, [info]);
    if (req.method === 'POST' && url.pathname === '/v1/sign') {
      if (origin !== o.origin) return send(403, { error: 'ORIGIN_REJECTED' }); // trang lạ không được ký
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON_REQUIRED' });
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 4096) return send(413, { error: 'TOO_LARGE' }); }
      const b = JSON.parse(raw);
      const digest = Buffer.from(String(b.digestB64 ?? ''), 'base64');
      if (b.algorithm !== 'RSA-SHA256' || digest.length !== 32) return send(400, { error: 'BAD_REQUEST', message: 'Cần algorithm RSA-SHA256 và digestB64 là SHA-256 (32 byte)' });
      if (String(b.certSerial ?? '').toLowerCase() !== info.serial) return send(404, { error: 'CERT_NOT_FOUND' });
      if (new Date(info.notAfter) <= new Date()) return send(409, { error: 'CERT_EXPIRED' });
      if (!o.yes && !(await ask(`Ký băm ${digest.toString('hex').slice(0, 16)}… bằng chứng thư "${info.subject}"? (y/n) `))) return send(403, { error: 'USER_DECLINED' });
      const sig = privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA256_PREFIX, digest]));
      return send(200, { signatureB64: sig.toString('base64') });
    }
    return send(404, { error: 'NOT_FOUND' });
  } catch (e) {
    return send(500, { error: 'INTERNAL', message: e instanceof Error ? e.message : String(e) });
  }
});
// Chỉ lắng nghe 127.0.0.1.
server.listen(Number(o.port), '127.0.0.1', () => console.log(`signer-agent listening on http://127.0.0.1:${server.address().port}`));
