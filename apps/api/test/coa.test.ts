import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('hệ thống tài khoản công ty', () => {
  it('tạo năm TT133 tự sinh tài khoản từ mẫu; cây có cha/con đúng', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `CA${Date.now()}` });
    await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/accounts?regime=TT133', headers: { cookie } });
    const rows = r.json() as { code: string; parentId: number | null; id: number; isGroup: boolean }[];
    expect(rows.length).toBeGreaterThan(100);
    const a111 = rows.find((x) => x.code === '111')!; const a1111 = rows.find((x) => x.code === '1111')!;
    expect(a1111.parentId).toBe(a111.id); expect(a111.isGroup).toBe(true);
    const again = await ctx.app.inject({ method: 'POST', url: '/api/accounts/generate', headers: { cookie }, payload: { regime: 'TT133' } });
    expect(again.json().error.code).toBe('ACCOUNTS_EXIST');
  });

  it('thêm tiểu khoản: cha thành tổng hợp; mã không bắt đầu bằng mã cha bị từ chối', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `CB${Date.now()}` });
    await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie }, payload: { regime: 'TT133', parentCode: '1121', code: '11211', name: 'TGNH Vietcombank' } });
    expect(ok.statusCode).toBe(201);
    const list = (await ctx.app.inject({ method: 'GET', url: '/api/accounts?regime=TT133', headers: { cookie } })).json() as { code: string; isGroup: boolean; subledgerKind: string | null }[];
    expect(list.find((x) => x.code === '1121')!.isGroup).toBe(true);
    expect(list.find((x) => x.code === '11211')!.subledgerKind).toBe('bank');
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie }, payload: { regime: 'TT133', parentCode: '1121', code: '11311', name: 'Sai' } });
    expect(bad.statusCode).toBe(409); expect(bad.json().error.code).toBe('ACCOUNT_CODE_PREFIX');
  });

  it('đổi số hiệu đổi cả con; ghép tài khoản chuyển con sang đích và xóa nguồn', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `CC${Date.now()}` });
    await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
    await ctx.app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie }, payload: { regime: 'TT133', parentCode: '1121', code: '11211', name: 'VCB' } });
    await ctx.app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie }, payload: { regime: 'TT133', parentCode: '1121', code: '11212', name: 'ACB' } });
    const rn = await ctx.app.inject({ method: 'POST', url: '/api/accounts/rename', headers: { cookie }, payload: { regime: 'TT133', oldCode: '1121', newCode: '1129' } });
    expect(rn.statusCode).toBe(200);
    let codes = ((await ctx.app.inject({ method: 'GET', url: '/api/accounts?regime=TT133', headers: { cookie } })).json() as { code: string }[]).map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['1129', '11291', '11292'])); expect(codes).not.toContain('1121');
    const mg = await ctx.app.inject({ method: 'POST', url: '/api/accounts/merge', headers: { cookie }, payload: { regime: 'TT133', sourceCode: '11292', targetCode: '11291' } });
    expect(mg.statusCode).toBe(200);
    codes = ((await ctx.app.inject({ method: 'GET', url: '/api/accounts?regime=TT133', headers: { cookie } })).json() as { code: string }[]).map((x) => x.code);
    expect(codes).not.toContain('11292');
  });
});

type Row = { id: number; code: string; parentId: number | null; isGroup: boolean };
const post = (cookie: string, url: string, payload: unknown) => ctx.app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as object });
const list = async (cookie: string, regime = 'TT133') => (await ctx.app.inject({ method: 'GET', url: `/api/accounts?regime=${regime}`, headers: { cookie } })).json() as Row[];
async function tenantWithCoa(prefix: string) {
  const t = await bootstrapTenant(ctx, { code: `${prefix}${Date.now()}` });
  await post(t.cookie, '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  return t;
}
const templateCount = async (regime: string) =>
  Number((await ctx.t.admin.selectFrom('coa_template').select((e) => e.fn.countAll().as('n')).where('regime', '=', regime).executeTakeFirstOrThrow()).n);

describe('sinh tài khoản từ mẫu', () => {
  it('số tài khoản sinh ra bằng số dòng mẫu; sinh thêm TT200 cho công ty đã có TT133', async () => {
    const { cookie } = await tenantWithCoa('CD');
    expect((await list(cookie)).length).toBe(await templateCount('TT133'));
    const gen = await post(cookie, '/api/accounts/generate', { regime: 'TT200' });
    expect(gen.statusCode).toBe(201);
    expect(gen.json()).toEqual({ count: await templateCount('TT200') });
    expect((await list(cookie, 'TT200')).length).toBe(await templateCount('TT200'));
  });

  it('TT99 chưa có mẫu: tạo năm tài chính bị 409 COA_TEMPLATE_PENDING và không để lại kỳ nào', async () => {
    const { cookie } = await bootstrapTenant(ctx, { code: `CE${Date.now()}` });
    const r = await post(cookie, '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' });
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('COA_TEMPLATE_PENDING');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/fiscal-years', headers: { cookie } })).json()).toEqual([]);
    const g = await post(cookie, '/api/accounts/generate', { regime: 'TT99' });
    expect(g.statusCode).toBe(409); expect(g.json().error.code).toBe('COA_TEMPLATE_PENDING');
  });

  it('năm thứ hai cùng chế độ không sinh lại tài khoản', async () => {
    const { cookie } = await tenantWithCoa('CF');
    const before = (await list(cookie)).length;
    expect(before).toBe(await templateCount('TT133'));
    const r = await post(cookie, '/api/fiscal-years', { fiscalYear: 2027, dateFrom: '2027-01-01', months: 12, regime: 'TT133' });
    expect(r.statusCode).toBe(201);
    expect((await list(cookie)).length).toBe(before);
  });
});

describe('quy tắc cây tài khoản', () => {
  it('trigger từ chối cha khác công ty hoặc khác chế độ; xóa con cuối cùng trả cha về tài khoản chi tiết', async () => {
    const x = await tenantWithCoa('CG'); const y = await tenantWithCoa('CH');
    const a = await post(x.cookie, '/api/accounts', { regime: 'TT133', parentCode: '1121', code: '11211', name: 'VCB' });
    const child = a.json().id as number;
    const parentX = (await list(x.cookie)).find((r) => r.code === '1121')!;
    const parentY = (await list(y.cookie)).find((r) => r.code === '1121')!;
    const base = { name: 'Sai', root_type: 'asset', normal_balance: 'debit' } as const;
    await expect(ctx.t.admin.insertInto('account').values({ ...base, tenant_id: x.tenantId, regime: 'TT133', code: '11219', parent_id: parentY.id }).execute()).rejects.toThrow(/ACCOUNT_PARENT_MISMATCH/);
    await expect(ctx.t.admin.insertInto('account').values({ ...base, tenant_id: x.tenantId, regime: 'TT200', code: '11219', parent_id: parentX.id }).execute()).rejects.toThrow(/ACCOUNT_PARENT_MISMATCH/);
    expect((await list(x.cookie)).find((r) => r.code === '1121')!.isGroup).toBe(true);
    await ctx.t.admin.deleteFrom('account').where('id', '=', child).execute();
    expect((await list(x.cookie)).find((r) => r.code === '1121')!.isGroup).toBe(false);
  });

  it('đổi số hiệu một tiểu khoản sang mã không bắt đầu bằng mã cha bị từ chối và không đổi gì', async () => {
    const { cookie } = await tenantWithCoa('CI');
    await post(cookie, '/api/accounts', { regime: 'TT133', parentCode: '1121', code: '11211', name: 'VCB' });
    const bad = await post(cookie, '/api/accounts/rename', { regime: 'TT133', oldCode: '11211', newCode: '11311' });
    expect(bad.statusCode).toBe(409); expect(bad.json().error.code).toBe('ACCOUNT_CODE_PREFIX');
    expect((await list(cookie)).map((r) => r.code)).toContain('11211');
    const ok = await post(cookie, '/api/accounts/rename', { regime: 'TT133', oldCode: '11211', newCode: '11219' });
    expect(ok.statusCode).toBe(200);
    expect((await list(cookie)).map((r) => r.code)).toContain('11219');
  });

  it('ghép tài khoản có con cháu: cả cây nguồn chuyển sang đích với mã đổi tiền tố; từ chối ghép sai', async () => {
    const { cookie } = await tenantWithCoa('CJ');
    for (const [parentCode, code] of [['1121', '11211'], ['1121', '11212'], ['11211', '112111']] as const) {
      await post(cookie, '/api/accounts', { regime: 'TT133', parentCode, code, name: code });
    }
    const dst = (await list(cookie)).find((r) => r.code === '11212')!;
    const mg = await post(cookie, '/api/accounts/merge', { regime: 'TT133', sourceCode: '11211', targetCode: '11212' });
    expect(mg.statusCode).toBe(200);
    const after = await list(cookie);
    expect(after.map((r) => r.code)).not.toContain('11211');
    const moved = after.find((r) => r.code === '112121')!;
    expect(after.find((r) => r.code === '11212')!.isGroup).toBe(true);
    expect(moved.parentId).toBe(dst.id);
    const into = await post(cookie, '/api/accounts/merge', { regime: 'TT133', sourceCode: '1121', targetCode: '11212' });
    expect(into.statusCode).toBe(409); expect(into.json().error.code).toBe('ACCOUNT_MERGE_INVALID');
    const cross = await post(cookie, '/api/accounts/merge', { regime: 'TT133', sourceCode: '112121', targetCode: '511' });
    expect(cross.statusCode).toBe(409); expect(cross.json().error.code).toBe('ACCOUNT_ROOT_MISMATCH');
    const missing = await post(cookie, '/api/accounts/merge', { regime: 'TT133', sourceCode: '99999', targetCode: '11212' });
    expect(missing.statusCode).toBe(404);
  });

  it('sửa tên, ngừng dùng; thân rỗng không lỗi; không có tài khoản thì 404', async () => {
    const { cookie } = await tenantWithCoa('CK');
    const a = (await list(cookie)).find((r) => r.code === '1111')!;
    const put = (id: number, payload: object) => ctx.app.inject({ method: 'PUT', url: `/api/accounts/${id}`, headers: { cookie }, payload });
    expect((await put(a.id, { name: 'Tiền Việt Nam', isActive: false })).statusCode).toBe(200);
    const got = ((await ctx.app.inject({ method: 'GET', url: '/api/accounts?regime=TT133', headers: { cookie } })).json() as { code: string; name: string; isActive: boolean }[]).find((r) => r.code === '1111')!;
    expect(got).toMatchObject({ name: 'Tiền Việt Nam', isActive: false });
    expect((await put(a.id, {})).statusCode).toBe(200);
    const none = await put(999999999, { name: 'x' });
    expect(none.statusCode).toBe(404); expect(none.json().error.code).toBe('ACCOUNT_NOT_FOUND');
  });
});

describe('phân quyền hệ thống tài khoản', () => {
  it('vai trò chỉ xem đọc được nhưng bị 403 khi sinh, thêm, sửa, đổi số hiệu, ghép', async () => {
    const admin = await tenantWithCoa('CL');
    const username = `xem_${Date.now()}`;
    await post(admin.cookie, '/api/users', { username, fullName: 'Xem', password: 'Matkhau1!', roleCode: 'xem' });
    const login = await post('', '/api/auth/login', { username, password: 'Matkhau1!' });
    const cookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    expect((await list(cookie)).length).toBeGreaterThan(100);
    const id = (await list(cookie))[0]!.id;
    const calls = [
      post(cookie, '/api/accounts/generate', { regime: 'TT200' }),
      post(cookie, '/api/accounts', { regime: 'TT133', parentCode: '1121', code: '11211', name: 'VCB' }),
      ctx.app.inject({ method: 'PUT', url: `/api/accounts/${id}`, headers: { cookie }, payload: { name: 'x' } }),
      post(cookie, '/api/accounts/rename', { regime: 'TT133', oldCode: '1121', newCode: '1129' }),
      post(cookie, '/api/accounts/merge', { regime: 'TT133', sourceCode: '1111', targetCode: '1112' }),
    ];
    for (const r of await Promise.all(calls)) { expect(r.statusCode).toBe(403); expect(r.json().error.code).toBe('FORBIDDEN'); }
    expect((await list(admin.cookie)).map((r) => r.code)).not.toContain('11211');
  });
});
