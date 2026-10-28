import { expect } from 'vitest';
import FormData from 'form-data';
import type { TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

export type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ApprovalTenant {
  tenantId: string; admin: string; adminId: string;
  users: Record<'requester' | 'ktt' | 'ktt2' | 'kttNoPayable' | 'kv2' | 'viewer', { cookie: string; id: string; username: string }>;
  call: (method: Method, url: string, payload?: object, cookie?: string) => Promise<Res>;
  upload: (url: string, name: string, body: string, cookie: string) => Promise<Res>;
}

// Công ty TT133 có NCC001, tài khoản ngân hàng 1121; người lập (Kế toán viên), hai Kế toán trưởng có view_payable, một Kế toán trưởng không có, một Kế toán viên khác, một người Chỉ xem.
// Quy trình: thanh toán từ 0 (1 bước: Kế toán trưởng), thanh toán từ 10.000.000 (Kế toán trưởng rồi admin), tạm ứng từ 0 (Kế toán trưởng 2 bước liên tiếp).
export async function setupApprovalTenant(ctx: TestApp, code: string): Promise<ApprovalTenant> {
  const b = await setupLedgerTenant(ctx, code);
  const call: ApprovalTenant['call'] = (method, url, payload, cookie = b.cookie) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload && { payload }) }) as unknown as Promise<Res>;
  const upload: ApprovalTenant['upload'] = (url, name, body, cookie) => {
    const fd = new FormData(); fd.append('file', Buffer.from(body), { filename: name, contentType: 'text/plain' });
    return ctx.app.inject({ method: 'POST', url, headers: { cookie, ...fd.getHeaders() }, payload: fd.getBuffer() }) as unknown as Promise<Res>;
  };
  expect((await call('POST', '/api/catalogs/bank', { code: 'VCB', name: 'Vietcombank' })).statusCode).toBe(201);
  expect((await call('POST', '/api/catalogs/bank_account', { bank_code: 'VCB', account_no: '1017588888', gl_account_code: '1121' })).statusCode).toBe(201);
  const mk = async (key: string, roleCode: string, flags: string[]) => {
    const username = `${key.toLowerCase()}_${code.toLowerCase()}`;
    const u = await call('POST', '/api/users', { username, fullName: key, password: 'Matkhau1!', roleCode, sensitiveFlags: flags });
    expect(u.statusCode, u.body).toBe(201);
    const l = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return { cookie: `sid=${l.cookies.find((x) => x.name === 'sid')!.value}`, id: u.json().id as string, username };
  };
  const users = {
    requester: await mk('Requester', 'ketoan_vien', []),
    ktt: await mk('Ktt', 'ketoan_truong', ['view_payable', 'view_receivable', 'view_cost']),
    ktt2: await mk('Ktt2', 'ketoan_truong', ['view_payable']),
    kttNoPayable: await mk('KttNP', 'ketoan_truong', []),
    kv2: await mk('Kv2', 'ketoan_vien', ['view_payable']),
    viewer: await mk('Viewer', 'xem', ['view_payable']),
  };
  const roles = (await call('GET', '/api/roles')).json() as { id: string; code: string }[];
  const ktt = roles.find((r) => r.code === 'ketoan_truong')!.id;
  for (const f of [
    { kind: 'payment', name: 'Thanh toán nhỏ', minAmount: '0', steps: [{ roleId: ktt }] },
    { kind: 'payment', name: 'Thanh toán lớn', minAmount: '10000000', steps: [{ roleId: ktt }, { userId: b.userId }] },
    { kind: 'advance', name: 'Tạm ứng', minAmount: '0', steps: [{ roleId: ktt }, { roleId: ktt }] },
  ]) { const r = await call('POST', '/api/approval-flows', f); expect(r.statusCode, r.body).toBe(201); }
  return { tenantId: b.tenantId, admin: b.cookie, adminId: b.userId, users, call, upload };
}

export const payment = (more: object = {}) => ({ kind: 'payment', requestDate: '2026-03-10', partyCode: 'NCC001', payeeName: 'Công ty NCC 1', reason: 'Thanh toán tiền hàng tháng 3', amountCurrency: '5000000', payMethod: 'cash', ...more });
