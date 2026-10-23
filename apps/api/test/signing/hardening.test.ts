import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { describeCertificate } from '../../src/modules/signing/providers/localAgent.js';
import { assertFakeAllowed, assertSmartcaUrl, policyOf } from '../../src/modules/signing/providers/policy.js';
import { dropKey, makeKey } from './keys.js';

const base = { DATABASE_URL: 'postgres://x', SESSION_SECRET: 'test-secret-123' };
const key = makeKey('Chua hieu luc');
afterAll(() => dropKey(key));
afterEach(() => vi.useRealTimers());

describe('chính sách SmartCA (chống SSRF) và hồ sơ giả lập', () => {
  const p = policyOf(loadConfig(base));
  it('mặc định chỉ cho https tới hai cổng VNPT trong tài liệu', () => {
    expect(p.smartcaHosts).toEqual(['rmgateway.vnptit.vn', 'gwsca.vnpt.vn']);
    expect(() => assertSmartcaUrl('https://rmgateway.vnptit.vn/sca/sp769', p)).not.toThrow();
    expect(() => assertSmartcaUrl('https://gwsca.vnpt.vn/sca/sp769', p)).not.toThrow();
  });
  it.each([
    'http://rmgateway.vnptit.vn/sca/sp769', 'https://evil.example/', 'https://rmgateway.vnptit.vn.evil.example/', 'https://rmgateway.vnptit.vn@evil.example/',
    'https://user:pw@rmgateway.vnptit.vn/', 'https://127.0.0.1/', 'https://169.254.169.254/latest', 'ftp://rmgateway.vnptit.vn/', 'khong-phai-url',
  ])('từ chối %s', (u) => {
    expect(() => assertSmartcaUrl(u, p)).toThrow(expect.objectContaining({ code: 'SMARTCA_URL_NOT_ALLOWED' }));
  });
  it('SMARTCA_ALLOWED_HOSTS đổi danh sách; http chỉ khi SMARTCA_ALLOW_HTTP=true và không bao giờ ở production', () => {
    const t = policyOf(loadConfig({ ...base, SMARTCA_ALLOWED_HOSTS: ' 127.0.0.1 ,mock.local', SMARTCA_ALLOW_HTTP: 'true' }));
    expect(() => assertSmartcaUrl('http://127.0.0.1:4000/x', t)).not.toThrow();
    expect(() => assertSmartcaUrl('http://rmgateway.vnptit.vn/', t)).toThrow();
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'a'.repeat(40), COOKIE_SECURE: 'true', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), SMARTCA_ALLOW_HTTP: 'true' })).toThrow(/SMARTCA_ALLOW_HTTP/);
  });
  it('hồ sơ giả lập bị chặn khi production', () => {
    expect(() => assertFakeAllowed({ ...p, production: true })).toThrow(expect.objectContaining({ code: 'SIGNING_FAKE_DISABLED' }));
    expect(() => assertFakeAllowed(p)).not.toThrow();
  });
});

describe('chứng thư của tiện ích', () => {
  it('chưa có hiệu lực (notBefore ở tương lai) → CERTIFICATE_INVALID; tự ký vẫn được', () => {
    expect(() => describeCertificate(key.certDer.toString('base64'))).not.toThrow();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() - 2 * 86400_000));
    expect(() => describeCertificate(key.certDer.toString('base64'))).toThrow(expect.objectContaining({ code: 'CERTIFICATE_INVALID', message: expect.stringMatching(/chưa có hiệu lực/) }));
  });
});
