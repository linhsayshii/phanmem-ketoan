import { afterEach, describe, expect, it } from 'vitest';
import { hasEncryptionKey, openSecret, sealSecret } from '../src/lib/secretBox.js';
import { redact } from '../src/lib/http.js';

const KEY = process.env.DATA_ENCRYPTION_KEY;
afterEach(() => { if (KEY === undefined) delete process.env.DATA_ENCRYPTION_KEY; else process.env.DATA_ENCRYPTION_KEY = KEY; });

describe('secretBox', () => {
  it('sealSecret/openSecret khứ hồi; sửa một byte ciphertext → openSecret ném', () => {
    expect(hasEncryptionKey()).toBe(true);
    const sealed = sealSecret('Mật khẩu-123');
    expect(sealed.subarray(0, 2).toString()).toBe('v1');
    expect(openSecret(sealed)).toBe('Mật khẩu-123');
    expect(sealSecret('x').equals(sealSecret('x'))).toBe(false);
    sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 1;
    expect(() => openSecret(sealed)).toThrow();
  });
  it('không có DATA_ENCRYPTION_KEY: sealSecret ném ENCRYPTION_KEY_MISSING 409', () => {
    delete process.env.DATA_ENCRYPTION_KEY;
    expect(hasEncryptionKey()).toBe(false);
    expect(() => sealSecret('x')).toThrowError(expect.objectContaining({ code: 'ENCRYPTION_KEY_MISSING', status: 409 }));
  });
  it('khóa không đúng 32 byte → lỗi', () => {
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');
    expect(() => sealSecret('x')).toThrow(/32 byte/);
  });
  it('redact thay password, secret ở mọi cấp', () => {
    expect(redact({ a: 1, password: 'p', n: { secret: 's', list: [{ password: 'q', ok: 1 }] } }, ['password', 'secret']))
      .toEqual({ a: 1, password: '***', n: { secret: '***', list: [{ password: '***', ok: 1 }] } });
  });
});
