import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';

let ctx: TestApp;
const put = (cookie: string, id: string, payload: object) => ctx.app.inject({ method: 'PUT', url: `/api/users/${id}`, headers: { cookie }, payload });
// tạo thành viên mới của công ty `by` và đăng nhập
async function mk(by: { cookie: string }, roleCode: string) {
  const username = `u_${Math.random().toString(36).slice(2, 10)}`;
  const c = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: by.cookie }, payload: { username, fullName: 'N', password: 'Matkhau1!', roleCode } });
  if (c.statusCode !== 201) throw new Error(c.body);
  const l = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return { id: c.json().id as string, username, cookie: `sid=${l.cookies.find((x) => x.name === 'sid')!.value}` };
}
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('người dùng và vai trò', () => {
  it('tạo người dùng vai trò kế toán viên, người đó không có quyền user.create', async () => {
    const admin = await bootstrapTenant(ctx, { code: `US${Date.now()}` });
    const created = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin.cookie },
      payload: { username: `kt_${Date.now()}`, fullName: 'Kế toán A', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: ['view_cost'] } });
    expect(created.statusCode).toBe(201);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin.cookie } });
    expect(list.json()).toHaveLength(2);
    const roles = await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie: admin.cookie } });
    const kt = roles.json().find((r: { code: string }) => r.code === 'ketoan_vien');
    expect(kt.permissions).toContain('voucher.post');
    expect(kt.permissions).not.toContain('voucher.unpost');
    expect(kt.permissions).not.toContain('user.create');
  });

  it('người không có quyền bị 403', async () => {
    const admin = await bootstrapTenant(ctx, { code: `UV${Date.now()}` });
    const username = `xem_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin.cookie },
      payload: { username, fullName: 'Xem', password: 'Matkhau1!', roleCode: 'xem' } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const cookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    const res = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username: 'xyz', fullName: 'x', password: 'Matkhau1!', roleCode: 'xem' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('không sửa được người dùng của công ty khác (404) và mật khẩu của họ không đổi', async () => {
    const x = await bootstrapTenant(ctx, { code: `UX${Date.now()}` });
    const y = await bootstrapTenant(ctx, { code: `UY${Date.now()}` });
    const res = await ctx.app.inject({ method: 'PUT', url: `/api/users/${y.userId}`, headers: { cookie: x.cookie }, payload: { password: 'Doimatkhau1!' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('USER_NOT_FOUND');
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: y.username, password: TEST_PASSWORD } });
    expect(login.statusCode).toBe(200);
  });

  it('không gắn tài khoản sẵn có của công ty khác: POST 409 USERNAME_TAKEN, PUT vẫn 404, mật khẩu không đổi', async () => {
    const x = await bootstrapTenant(ctx, { code: `UP${Date.now()}` });
    const y = await bootstrapTenant(ctx, { code: `UQ${Date.now()}` });
    const post = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: x.cookie },
      payload: { username: y.username, fullName: 'Chiếm', password: 'Chiemquyen1!', roleCode: 'xem' } });
    expect(post.statusCode).toBe(409);
    expect(post.json().error.code).toBe('USERNAME_TAKEN');
    const put = await ctx.app.inject({ method: 'PUT', url: `/api/users/${y.userId}`, headers: { cookie: x.cookie }, payload: { password: 'Chiemquyen1!' } });
    expect(put.statusCode).toBe(404);
    expect(put.json().error.code).toBe('USER_NOT_FOUND');
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: y.username, password: TEST_PASSWORD } });
    expect(login.statusCode).toBe(200);
  });

  it('đặt lại mật khẩu thu hồi phiên cũ của người đó', async () => {
    const admin = await bootstrapTenant(ctx, { code: `UR${Date.now()}` });
    const username = `phien_${Date.now()}`;
    const created = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin.cookie },
      payload: { username, fullName: 'Phiên', password: 'Matkhau1!', roleCode: 'xem' } });
    expect(created.statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const cookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
    const reset = await ctx.app.inject({ method: 'PUT', url: `/api/users/${created.json().id}`, headers: { cookie: admin.cookie }, payload: { password: 'Matkhaumoi1!' } });
    expect(reset.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
    const relogin = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhaumoi1!' } });
    expect(relogin.statusCode).toBe(200);
  });

  it('PUT với roleCode không tồn tại trả 404 ROLE_NOT_FOUND', async () => {
    const admin = await bootstrapTenant(ctx, { code: `UT${Date.now()}` });
    const other = await mk(admin, 'xem');
    const res = await put(admin.cookie, other.id, { roleCode: 'khong_ton_tai' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ROLE_NOT_FOUND');
  });

  it('người có user.update không tự nâng mình lên admin, không tự gán cờ nhạy cảm', async () => {
    const admin = await bootstrapTenant(ctx, { code: `SP${Date.now()}` });
    await sql`INSERT INTO role(tenant_id, code, name) VALUES (${admin.tenantId}::uuid, 'qt_phu', 'Quản trị phụ')`.execute(ctx.t.admin);
    await sql`INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT ${admin.tenantId}::uuid, (SELECT id FROM role WHERE tenant_id = ${admin.tenantId}::uuid AND code = 'qt_phu'), p FROM (SELECT permission_code p FROM role_permission rp JOIN role r ON r.id = rp.role_id WHERE r.tenant_id = ${admin.tenantId}::uuid AND r.code IN ('ketoan_vien', 'xem') UNION SELECT unnest(ARRAY['user.view','user.update'])) x`.execute(ctx.t.admin);
    const self = await mk(admin, 'qt_phu'); const other = await mk(admin, 'xem');
    expect((await put(self.cookie, self.id, { roleCode: 'admin' })).json().error.code).toBe('SELF_PRIVILEGE_CHANGE');
    expect((await put(self.cookie, self.id, { sensitiveFlags: ['view_cost'] })).json().error.code).toBe('SELF_PRIVILEGE_CHANGE');
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/users/${self.id}/active`, headers: { cookie: self.cookie }, payload: { isActive: false } })).json().error.code).toBe('SELF_PRIVILEGE_CHANGE');
    expect((await put(self.cookie, other.id, { sensitiveFlags: ['view_cost'] })).statusCode).toBe(403);
    expect((await put(self.cookie, other.id, { roleCode: 'ketoan_vien' })).statusCode).toBe(200); // đối chứng
    expect((await put(self.cookie, self.id, { fullName: 'Tên mới' })).statusCode).toBe(200); // tự đổi họ tên được
  });

  it('không bỏ kích hoạt hay hạ vai trò quản trị viên cuối cùng', async () => {
    const a1 = await bootstrapTenant(ctx, { code: `LA${Date.now()}` });
    const a2 = await mk(a1, 'admin');
    const toggle = (cookie: string, id: string, isActive: boolean) => ctx.app.inject({ method: 'PUT', url: `/api/users/${id}/active`, headers: { cookie }, payload: { isActive } });
    expect((await toggle(a1.cookie, a2.id, false)).statusCode).toBe(200); // còn a1 nên được
    expect((await toggle(a1.cookie, a2.id, true)).statusCode).toBe(200);
    expect((await put(a2.cookie, a1.userId, { roleCode: 'xem' })).statusCode).toBe(200); // đối chứng: hạ a1, còn a2
    // a2 là admin duy nhất: người khác có quyền cũng không hạ được
    await sql`INSERT INTO role(tenant_id, code, name) VALUES (${a1.tenantId}::uuid, 'qt_full', 'Quyền như admin')`.execute(ctx.t.admin);
    await sql`INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT ${a1.tenantId}::uuid, (SELECT id FROM role WHERE tenant_id = ${a1.tenantId}::uuid AND code = 'qt_full'), code FROM permission`.execute(ctx.t.admin);
    const kv = await mk(a2, 'qt_full');
    const res = await put(kv.cookie, a2.id, { roleCode: 'xem' });
    expect(res.statusCode).toBe(409); expect(res.json().error.code).toBe('LAST_ADMIN');
    expect((await toggle(kv.cookie, a2.id, false)).json().error.code).toBe('LAST_ADMIN');
  });

  it('không đặt lại mật khẩu người dùng thuộc hai công ty', async () => {
    const a = await bootstrapTenant(ctx, { code: `SH${Date.now()}` });
    const b = await bootstrapTenant(ctx, { code: `SI${Date.now()}` });
    const u = await mk(a, 'xem');
    await sql`INSERT INTO tenant_user(tenant_id, user_id, role_id) SELECT ${b.tenantId}::uuid, ${u.id}::uuid, id FROM role WHERE tenant_id = ${b.tenantId}::uuid AND code = 'xem'`.execute(ctx.t.admin);
    const r = await put(a.cookie, u.id, { password: 'Doimatkhau1!' });
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('USER_SHARED');
    expect((await put(a.cookie, u.id, { fullName: 'Đổi' })).json().error.code).toBe('USER_SHARED');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u.username, password: 'Matkhau1!' } })).statusCode).toBe(200);
    expect((await put(u.cookie, u.id, { fullName: 'Tự đổi' })).statusCode).toBe(403); // thiếu quyền, không phải USER_SHARED
  });

  it('vai trò admin không bị sửa quyền', async () => {
    const a = await bootstrapTenant(ctx, { code: `SR${Date.now()}` });
    const roles = (await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie: a.cookie } })).json() as { id: string; code: string }[];
    const call = (code: string) => ctx.app.inject({ method: 'PUT', url: `/api/roles/${roles.find((r) => r.code === code)!.id}/permissions`, headers: { cookie: a.cookie }, payload: { permissions: ['voucher.view'] } });
    const r = await call('admin');
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('SYSTEM_ROLE_LOCKED');
    expect((await call('xem')).statusCode).toBe(200);
  });

  it('PUT /active cho người ngoài công ty trả 404', async () => {
    const a = await bootstrapTenant(ctx, { code: `NA${Date.now()}` });
    const b = await bootstrapTenant(ctx, { code: `NB${Date.now()}` });
    const r = await ctx.app.inject({ method: 'PUT', url: `/api/users/${b.userId}/active`, headers: { cookie: a.cookie }, payload: { isActive: false } });
    expect(r.statusCode).toBe(404); expect(r.json().error.code).toBe('USER_NOT_FOUND');
  });

  it('ROLE_EXCEEDS_ACTOR, TARGET_EXCEEDS_ACTOR, PERMISSION_NOT_HELD: không trao quyền mình không có, không sửa người hơn quyền', async () => {
    const admin = await bootstrapTenant(ctx, { code: `EX${Date.now()}` });
    await sql`INSERT INTO role(tenant_id, code, name) VALUES (${admin.tenantId}::uuid, 'qt_nho', 'Quản trị nhỏ')`.execute(ctx.t.admin);
    await sql`INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT ${admin.tenantId}::uuid, (SELECT id FROM role WHERE tenant_id = ${admin.tenantId}::uuid AND code = 'qt_nho'), p FROM (SELECT permission_code p FROM role_permission rp JOIN role r ON r.id = rp.role_id WHERE r.tenant_id = ${admin.tenantId}::uuid AND r.code = 'xem' UNION SELECT unnest(ARRAY['user.view','user.update','user.create','role.view','role.update'])) x`.execute(ctx.t.admin);
    const mid = await mk(admin, 'qt_nho'); const victim = await mk(admin, 'xem');
    const post = (cookie: string, roleCode: string) => ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username: `n_${Math.random().toString(36).slice(2, 10)}`, fullName: 'N', password: 'Matkhau1!', roleCode } });
    // A
    expect((await post(mid.cookie, 'admin')).json().error.code).toBe('ROLE_EXCEEDS_ACTOR');
    expect((await put(mid.cookie, victim.id, { roleCode: 'admin' })).json().error.code).toBe('ROLE_EXCEEDS_ACTOR');
    expect((await post(admin.cookie, 'admin')).statusCode).toBe(201); // đối chứng
    // B
    const r = await put(mid.cookie, admin.userId, { password: 'Chiemquyen1!' });
    expect(r.statusCode).toBe(403); expect(r.json().error.code).toBe('TARGET_EXCEEDS_ACTOR');
    const act = await ctx.app.inject({ method: 'PUT', url: `/api/users/${admin.userId}/active`, headers: { cookie: mid.cookie }, payload: { isActive: false } });
    expect(act.json().error.code).toBe('TARGET_EXCEEDS_ACTOR');
    expect((await put(admin.cookie, mid.id, { fullName: 'Đối chứng' })).statusCode).toBe(200);
    // C
    const roles = (await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie: mid.cookie } })).json() as { id: string; code: string }[];
    const xemId = roles.find((x) => x.code === 'xem')!.id;
    const grant = (cookie: string, permissions: string[]) => ctx.app.inject({ method: 'PUT', url: `/api/roles/${xemId}/permissions`, headers: { cookie }, payload: { permissions } });
    const g = await grant(mid.cookie, ['voucher.post']);
    expect(g.statusCode).toBe(403); expect(g.json().error.code).toBe('PERMISSION_NOT_HELD');
    expect((await grant(mid.cookie, ['user.view'])).statusCode).toBe(200); // đối chứng: quyền mình có
    expect((await grant(admin.cookie, ['voucher.post'])).statusCode).toBe(200);
  });

  it('PUT /api/roles/:id/permissions với vai trò không tồn tại hoặc của công ty khác trả 404', async () => {
    const a = await bootstrapTenant(ctx, { code: `RN${Date.now()}` });
    const b = await bootstrapTenant(ctx, { code: `RM${Date.now()}` });
    const foreign = (await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie: b.cookie } })).json()[0].id as string;
    for (const id of [foreign, '00000000-0000-4000-8000-000000000000'])
      for (const permissions of [[], ['voucher.view']]) {
        const r = await ctx.app.inject({ method: 'PUT', url: `/api/roles/${id}/permissions`, headers: { cookie: a.cookie }, payload: { permissions } });
        expect([r.statusCode, r.json().error.code]).toEqual([404, 'ROLE_NOT_FOUND']);
      }
  });

  it('người dùng bị khóa ở công ty kia vẫn tính là thành viên: không đặt lại mật khẩu', async () => {
    const a = await bootstrapTenant(ctx, { code: `SJ${Date.now()}` });
    const b = await bootstrapTenant(ctx, { code: `SK${Date.now()}` });
    const u = await mk(a, 'xem');
    await sql`INSERT INTO tenant_user(tenant_id, user_id, role_id, is_active) SELECT ${b.tenantId}::uuid, ${u.id}::uuid, id, false FROM role WHERE tenant_id = ${b.tenantId}::uuid AND code = 'xem'`.execute(ctx.t.admin);
    expect((await put(a.cookie, u.id, { password: 'Doimatkhau1!' })).json().error.code).toBe('USER_SHARED');
  });
});
