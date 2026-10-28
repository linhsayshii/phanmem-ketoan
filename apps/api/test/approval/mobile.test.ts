import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers.js';
import { payment, setupApprovalTenant, type ApprovalTenant } from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
let ctx: TestApp; let t: ApprovalTenant;
beforeAll(async () => {
  ctx = await createTestApp(); t = await setupApprovalTenant(ctx, `MB${Date.now()}`);
  // Doanh thu 10.000.000, giá vốn 6.000.000, chi phí quản lý 1.000.000 (ghi sổ), thu chi qua 1111 / 1121.
  for (const lines of [
    [{ accountCode: '1111', debit: '10000000' }, { accountCode: '5113', credit: '10000000' }],
    [{ accountCode: '632', debit: '6000000' }, { accountCode: '1111', credit: '6000000' }],
    [{ accountCode: '6422', debit: '1000000' }, { accountCode: '1121', credit: '1000000', bankAccountNo: '1017588888' }],
  ]) {
    const r = await t.call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-03-05', documentDate: '2026-03-05', description: 'mb', autoPost: true, lines });
    expect(r.statusCode, r.body).toBe(201);
  }
});
afterAll(async () => { await ctx.close(); });

const key = async (cookie: string, scopes: string[]) => {
  const r = await t.call('POST', '/api/api-keys', { name: 'Điện thoại', scopes }, cookie);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().key as string;
};
const mobile = (k: string | null, method: 'GET' | 'POST', url: string, payload?: object, cookie?: string) =>
  ctx.app.inject({ method, url: `/api/mobile/v1${url}`, headers: { ...(k && { authorization: `Bearer ${k}` }), ...(cookie && { cookie }) }, ...(payload && { payload }) });

describe('API mobile /api/mobile/v1', () => {
  it('khóa phạm vi mobile: duyệt đề nghị chờ duyệt; khóa không có mobile bị 403; khóa mobile không vào route quản trị hay API ngoài', async () => {
    const k = await key(t.users.ktt.cookie, ['mobile']);
    const a = (await t.call('POST', '/api/approvals', payment(), t.users.requester.cookie)).json();
    expect((await t.call('POST', `/api/approvals/${a.id}/submit`, {}, t.users.requester.cookie)).statusCode).toBe(200);

    const me = await mobile(k, 'GET', '/me');
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toMatchObject({ username: t.users.ktt.username, via: 'api_key', canApprove: true, canViewReports: true, pending: 1 });
    const list = await mobile(k, 'GET', '/approvals');
    expect(list.json().items).toEqual([expect.objectContaining({ id: a.id, requestNo: a.requestNo, amount: '5000000', payee: 'Công ty NCC 1', step: 1, steps: 1 })]);
    const d = await mobile(k, 'GET', `/approvals/${a.id}`);
    expect(d.json()).toMatchObject({ canAct: true, approvals: [{ action: 'submit' }] });
    const ok = await mobile(k, 'POST', `/approvals/${a.id}/approve`, { note: 'Duyệt trên điện thoại' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ state: 'approved', voucherId: expect.any(String) });
    expect((await mobile(k, 'GET', '/approvals')).json().items).toEqual([]);

    const b = (await t.call('POST', '/api/approvals', payment(), t.users.requester.cookie)).json();
    await t.call('POST', `/api/approvals/${b.id}/submit`, {}, t.users.requester.cookie);
    expect((await mobile(k, 'POST', `/approvals/${b.id}/reject`, {})).statusCode).toBe(400);
    expect((await mobile(k, 'POST', `/approvals/${b.id}/reject`, { reason: 'Chưa đủ chứng từ' })).json()).toEqual({ state: 'rejected' });

    const other = await key(t.users.ktt.cookie, ['items.read']);
    const s = await mobile(other, 'GET', '/me');
    expect(s.statusCode).toBe(403); expect(s.json().error.code).toBe('SCOPE_FORBIDDEN');
    expect((await mobile('kt_000000000000_' + '0'.repeat(64), 'GET', '/me')).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/users', headers: { authorization: `Bearer ${k}` } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/approvals?box=inbox', headers: { authorization: `Bearer ${k}` } })).statusCode).toBe(401);
    const ext = await ctx.app.inject({ method: 'GET', url: '/api/ext/v1/items', headers: { authorization: `Bearer ${k}` } });
    expect(ext.statusCode).toBe(403); expect(ext.json().error.code).toBe('SCOPE_FORBIDDEN');
  });

  it('quyền = vai trò ∩ phạm vi: người Chỉ xem không duyệt được qua khóa mobile, vẫn xem báo cáo; người đề nghị không tự duyệt qua mobile', async () => {
    const k = await key(t.admin, ['mobile']); // khóa tạo cho chính mình; người Chỉ xem không có api_key.manage
    expect((await mobile(k, 'GET', '/me')).json()).toMatchObject({ canApprove: true });
    // Người Chỉ xem (cho thêm quyền tạo khóa): khóa mobile của họ không có approval_request.approve vì vai trò không có.
    const roles = (await t.call('GET', '/api/roles')).json() as { id: string; code: string; permissions: string[] }[];
    const xem = roles.find((r) => r.code === 'xem')!;
    expect((await t.call('PUT', `/api/roles/${xem.id}/permissions`, { permissions: [...xem.permissions, 'api_key.manage'] })).statusCode).toBe(200);
    const vk = await key(t.users.viewer.cookie, ['mobile']);
    const viewer = await mobile(vk, 'GET', '/approvals');
    expect(viewer.statusCode).toBe(403); expect(viewer.json().error.code).toBe('FORBIDDEN');
    expect((await mobile(vk, 'GET', '/reports/cash?asOf=2026-03-31')).statusCode).toBe(200);
    expect((await mobile(null, 'GET', '/me', undefined, t.users.viewer.cookie)).json()).toMatchObject({ via: 'session', canApprove: false, canViewReports: true });
    expect((await mobile(null, 'GET', '/reports/cash?asOf=2026-03-31', undefined, t.users.viewer.cookie)).statusCode).toBe(200);
    // Phạm vi mobile không mở quyền lập chứng từ: route không có trong /api/mobile/v1.
    expect((await mobile(k, 'POST', '/approvals', payment())).statusCode).toBe(404);
    const own = (await t.call('POST', '/api/approvals', payment({ amountCurrency: '20000000' }))).json(); // admin tự lập
    await t.call('POST', `/api/approvals/${own.id}/submit`, {});
    expect((await mobile(k, 'GET', '/approvals')).json().items.map((x: { id: string }) => x.id)).not.toContain(own.id);
    expect((await mobile(k, 'POST', `/approvals/${own.id}/approve`, {})).json().error.code).toBe('APPROVAL_SELF');
    expect((await mobile(null, 'GET', '/me')).statusCode).toBe(401);
  });

  it('báo cáo: số dư tiền, doanh thu chi phí kỳ (giá vốn ẩn khi thiếu view_cost), B01/B02 tóm tắt', async () => {
    const k = await key(t.users.ktt.cookie, ['mobile']);
    // Phiếu chi nháp do duyệt đề nghị chưa ghi sổ nên không làm đổi số dư.
    expect((await mobile(k, 'GET', '/reports/cash?asOf=2026-03-31')).json()).toEqual({ asOf: '2026-03-31', cash: '4000000', bank: '-1000000', total: '3000000' });
    const pnl = (await mobile(k, 'GET', '/reports/pnl?from=2026-03-01&to=2026-03-31')).json();
    expect(pnl).toMatchObject({ totalRevenue: '10000000', totalExpense: '7000000', profit: '3000000' });
    expect(pnl.expense.map((x: { accountCode: string }) => x.accountCode)).toEqual(['632', '642']);
    const np = (await mobile(null, 'GET', '/reports/pnl?from=2026-03-01&to=2026-03-31', undefined, t.users.kttNoPayable.cookie)).json();
    expect(np).toMatchObject({ totalRevenue: '10000000', totalExpense: '1000000', costHidden: true });
    expect(np).not.toHaveProperty('profit');
    expect((await mobile(k, 'GET', '/reports/pnl?from=2026-03-31&to=2026-03-01')).statusCode).toBe(400);
    for (const code of ['B01', 'B02']) {
      const r = await mobile(k, 'GET', `/reports/financial/${code}?from=2026-01-01&to=2026-03-31`);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ reportCode: code, regime: 'TT133' });
      expect(r.json().rows.length).toBeGreaterThan(0);
    }
    expect((await mobile(k, 'GET', '/reports/financial/B03?from=2026-01-01&to=2026-03-31')).statusCode).toBe(400);
  });
});
