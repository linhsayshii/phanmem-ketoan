import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { loadConfig } from '../src/config.js';
import { createTestApp } from './helpers.js';

const base = { DATABASE_URL: 'postgres://x', SESSION_SECRET: 'test-secret-123' };

const GOOD_KEY = Buffer.alloc(32, 1).toString('base64');

describe('cấu hình', () => {
  it('DATA_ENCRYPTION_KEY: khóa 32 byte base64 hợp lệ; sai độ dài hoặc ký tự lạ thì dừng (mọi NODE_ENV)', () => {
    expect(loadConfig({ ...base, DATA_ENCRYPTION_KEY: GOOD_KEY }).DATA_ENCRYPTION_KEY).toBe(GOOD_KEY);
    for (const bad of [Buffer.alloc(16).toString('base64'), Buffer.alloc(33).toString('base64'), 'k', GOOD_KEY.slice(0, -2) + '!!', `${GOOD_KEY}\n`])
      expect(() => loadConfig({ ...base, DATA_ENCRYPTION_KEY: bad }), bad).toThrow(/DATA_ENCRYPTION_KEY/);
  });
  it('production thiếu COOKIE_SECURE hoặc SESSION_SECRET ngắn thì dừng', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'doi-chuoi-nay-khi-trien-khai', COOKIE_SECURE: 'true' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'a'.repeat(32) })).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'a'.repeat(32), COOKIE_SECURE: 'true' })).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'a'.repeat(32), COOKIE_SECURE: 'true', DATA_ENCRYPTION_KEY: GOOD_KEY }).COOKIE_SECURE).toBe('true');
  });
  it('TRUST_PROXY: mặc định false, nhận true, số bước, danh sách IP', () => {
    expect(loadConfig(base).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.1,172.16.0.0/12' }).TRUST_PROXY).toBe('10.0.0.1,172.16.0.0/12');
  });
  it('không tin proxy thì X-Forwarded-For không đổi IP ghi vào login_event', async () => {
    const ctx = await createTestApp();
    try {
      const username = `xff_${Date.now()}`;
      await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '1.2.3.4' }, payload: { username, password: 'sai-mat-khau' } });
      const r = await sql<{ ip: string }>`SELECT ip::text AS ip FROM login_event WHERE username = ${username} ORDER BY 1 DESC LIMIT 1`.execute(ctx.t.admin);
      expect(r.rows.length).toBe(1);
      expect(r.rows[0]!.ip).not.toContain('1.2.3.4');
    } finally { await ctx.close(); }
  });
});
