import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, TEST_PASSWORD, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

// Quét quyền trợ lý: mọi route /api/assistant và /api/recurring phải chặn người chưa đăng nhập (401) và người thiếu quyền (403); quyền mới có trong danh sách quyền và vai trò mặc định.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
let ctx: TestApp; let owner: string; let tenantId: string;

function listRoutes(tree: string): { method: string; path: string }[] {
  const stack: string[] = []; const out: { method: string; path: string }[] = [];
  for (const line of tree.split('\n')) {
    const i = line.indexOf('/'); if (i < 0) continue;
    const m = /^(\S+)(?: \((.*)\))?$/.exec(line.slice(i)); if (!m) continue;
    stack.length = Math.max(0, i / 4 - 1); stack.push(m[1]!);
    for (const method of (m[2] ?? '').split(', ').filter((x) => x && x !== 'HEAD')) out.push({ method, path: stack.join('') });
  }
  return out;
}
const fill = (p: string) => p.replace(/:id/g, '00000000-0000-4000-8000-000000000000');

beforeAll(async () => { ctx = await createTestApp(); ({ cookie: owner, tenantId } = await setupLedgerTenant(ctx, `QY${Date.now()}`, 'TT133')); }, 180_000);
afterAll(async () => { await ctx.close(); });

describe('quyền trợ lý', () => {
  it('mọi route trợ lý: không đăng nhập 401; người thiếu quyền 403', async () => {
    const routes = listRoutes(ctx.app.printRoutes({ commonPrefix: false })).filter((r) => /^\/api\/(assistant|recurring-)/.test(r.path));
    expect(routes.length).toBe(13);
    // vai trò không quyền nào: tạo vai trò rỗng
    await sql`INSERT INTO role(tenant_id, code, name, is_system) VALUES (${tenantId}::uuid, 'trong', 'Trống', false)`.execute(ctx.t.admin);
    const u = `qy_${Date.now()}`;
    const mk = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: owner }, payload: { username: u, fullName: 'X', password: TEST_PASSWORD, roleCode: 'trong', sensitiveFlags: [] } });
    expect(mk.statusCode, mk.body).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: TEST_PASSWORD } });
    const empty = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    for (const r of routes) {
      const base = { method: r.method as 'GET', url: fill(r.path) };
      expect((await ctx.app.inject(base)).statusCode, `${r.method} ${r.path} không cookie`).toBe(401);
      const denied = await ctx.app.inject({ ...base, headers: { cookie: empty }, ...(r.method !== 'GET' && r.method !== 'DELETE' ? { payload: {} } : {}) });
      expect(denied.statusCode, `${r.method} ${r.path} thiếu quyền: ${denied.body}`).toBe(403);
    }
  });
  it('quyền mới có trong danh sách và vai trò mặc định', async () => {
    const perms = (await sql<{ code: string }>`SELECT code FROM permission WHERE code IN ('assistant.use', 'recurring.view', 'recurring.manage')`.execute(ctx.t.admin)).rows.map((r) => r.code).sort();
    expect(perms).toEqual(['assistant.use', 'recurring.manage', 'recurring.view']);
    const by = async (role: string) => (await sql<{ permission_code: string }>`SELECT rp.permission_code FROM role_permission rp JOIN role r ON r.id = rp.role_id AND r.tenant_id = rp.tenant_id
      WHERE r.tenant_id = ${tenantId}::uuid AND r.code = ${role} AND rp.permission_code IN ('assistant.use', 'recurring.view', 'recurring.manage') ORDER BY 1`.execute(ctx.t.admin)).rows.map((r) => r.permission_code);
    expect(await by('admin')).toEqual(['assistant.use', 'recurring.manage', 'recurring.view']);
    expect(await by('ketoan_truong')).toEqual(['assistant.use', 'recurring.manage', 'recurring.view']);
    expect(await by('ketoan_vien')).toEqual(['assistant.use', 'recurring.manage', 'recurring.view']);
    expect(await by('xem')).toEqual(['recurring.view']);
  });
});
