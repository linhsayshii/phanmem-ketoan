import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { payment, setupApprovalTenant, type ApprovalTenant } from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
let ctx: TestApp; let t: ApprovalTenant;
beforeAll(async () => { ctx = await createTestApp(); t = await setupApprovalTenant(ctx, `UQ${Date.now()}`); });
afterAll(async () => { await ctx.close(); });

const create = async (body: object = payment(), cookie = t.users.requester.cookie) => {
  const r = await t.call('POST', '/api/approvals', body, cookie);
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; requestNo: string };
};
const submit = async (id: string, cookie = t.users.requester.cookie) => { const r = await t.call('POST', `/api/approvals/${id}/submit`, {}, cookie); expect(r.statusCode, r.body).toBe(200); };
const pending = async (body: object = payment(), cookie = t.users.requester.cookie) => { const a = await create(body, cookie); await submit(a.id, cookie); return a.id; };
const act = (id: string, cookie: string, what: 'approve' | 'reject' = 'approve', body: object = {}) => t.call('POST', `/api/approvals/${id}/${what}`, body, cookie);
const get = async (id: string, cookie = t.users.requester.cookie) => (await t.call('GET', `/api/approvals/${id}`, undefined, cookie)).json();
const day = (offset: number) => new Date(Date.now() + 7 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);
const delegate = (from: { cookie: string }, toId: string, o: { dateFrom?: string; dateTo?: string; reason?: string } = {}) =>
  t.call('POST', '/api/approval-delegations', { delegateId: toId, dateFrom: o.dateFrom ?? day(-1), dateTo: o.dateTo ?? day(3), ...(o.reason && { reason: o.reason }) }, from.cookie);
const mkDelegation = async (from: { cookie: string }, toId: string, o = {}) => { const r = await delegate(from, toId, o); expect(r.statusCode, r.body).toBe(201); return r.json().id as number; };
const revoke = (id: number, cookie: string) => t.call('POST', `/api/approval-delegations/${id}/revoke`, {}, cookie);
const inbox = async (cookie: string) => (await t.call('GET', '/api/approvals?box=inbox', undefined, cookie)).json() as { id: string; via?: string | null }[];

describe('ủy quyền duyệt', () => {
  it('người được ủy quyền duyệt thay: nhật ký ghi cả hai người, phiếu chi sinh ra, hộp duyệt hiện "duyệt thay"; thu hồi thì mất quyền', async () => {
    const id = await pending();
    // Chưa ủy quyền: kv2 (Kế toán viên) không đúng vai trò của bước.
    expect((await act(id, t.users.kv2.cookie)).json().error.code).toBe('APPROVAL_WRONG_APPROVER');
    expect((await inbox(t.users.kv2.cookie)).map((x) => x.id)).not.toContain(id);
    const d = await mkDelegation(t.users.ktt, t.users.kv2.id, { reason: 'Đi công tác' });
    const box = await inbox(t.users.kv2.cookie);
    expect(box.find((x) => x.id === id)?.via).toBe(t.users.ktt.username);
    expect((await get(id, t.users.kv2.cookie)).canAct).toBe(true);
    const ok = await act(id, t.users.kv2.cookie, 'approve', { note: 'Duyệt thay' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ state: 'approved', voucherId: expect.any(String) });
    const log = (await get(id)).log as { action: string; username: string; onBehalfOf: string | null }[];
    expect(log.at(-1)).toMatchObject({ action: 'approve', username: t.users.kv2.username, onBehalfOf: t.users.ktt.username });
    // Thu hồi: đề nghị mới không còn duyệt thay được.
    const id2 = await pending();
    expect((await revoke(d, t.users.ktt.cookie)).statusCode).toBe(200);
    expect((await act(id2, t.users.kv2.cookie)).json().error.code).toBe('APPROVAL_WRONG_APPROVER');
    expect((await revoke(d, t.users.ktt.cookie)).json().error.code).toBe('APPROVAL_DELEGATION_REVOKED');
    // Người khác (không phải người ủy quyền, không phải quản trị) không thu hồi được.
    const d2 = await mkDelegation(t.users.ktt, t.users.kv2.id);
    expect((await revoke(d2, t.users.requester.cookie)).statusCode).toBe(403);
    expect((await revoke(d2, t.admin)).statusCode).toBe(200);
  });

  it('chỉ trong khoảng ngày hiệu lực: chưa tới hoặc đã qua thì không duyệt thay được', async () => {
    const id = await pending();
    await mkDelegation(t.users.ktt, t.users.kv2.id, { dateFrom: day(2), dateTo: day(5) });
    expect((await act(id, t.users.kv2.cookie)).json().error.code).toBe('APPROVAL_WRONG_APPROVER');
    // Đã hết hạn (chèn thẳng, vì API không cho lập khoảng đã qua)
    expect((await delegate(t.users.ktt, t.users.kv2.id, { dateFrom: day(-9), dateTo: day(-2) })).statusCode).toBe(400);
    await sql`INSERT INTO approval_delegation (tenant_id, delegator_id, delegate_id, date_from, date_to, created_by)
      VALUES (${t.tenantId}::uuid, ${t.users.ktt.id}::uuid, ${t.users.kv2.id}::uuid, ${day(-9)}::date, ${day(-2)}::date, ${t.users.ktt.id}::uuid)`.execute(ctx.t.admin);
    expect((await act(id, t.users.kv2.cookie)).statusCode).toBe(403);
    const list = (await t.call('GET', '/api/approval-delegations', undefined, t.users.kv2.cookie)).json() as { status: string; delegator: string }[];
    expect(list.map((x) => x.status)).toEqual(expect.arrayContaining(['upcoming', 'expired']));
    await sql`UPDATE approval_delegation SET revoked_at = now(), revoked_by = created_by WHERE tenant_id = ${t.tenantId}::uuid AND revoked_at IS NULL`.execute(ctx.t.admin);
    await act(id, t.users.ktt.cookie, 'reject', { reason: 'Dọn' });
  });

  it('không tự duyệt: người ủy quyền lập đề nghị thì người được ủy quyền không duyệt thay; người khác cùng vai trò vẫn duyệt được', async () => {
    const id = await pending(payment(), t.users.ktt.cookie); // Kế toán trưởng tự lập
    const d = await mkDelegation(t.users.ktt, t.users.kv2.id);
    const r = await act(id, t.users.kv2.cookie);
    expect(r.statusCode).toBe(403); expect(r.json().error.code).toBe('APPROVAL_WRONG_APPROVER');
    expect((await inbox(t.users.kv2.cookie)).map((x) => x.id)).not.toContain(id);
    expect((await act(id, t.users.ktt.cookie)).json().error.code).toBe('APPROVAL_SELF');
    expect((await act(id, t.users.ktt2.cookie)).statusCode).toBe(200);
    await revoke(d, t.users.ktt.cookie);
    // Người được ủy quyền tự lập thì không tự duyệt
    const own = await pending(payment(), t.users.kv2.cookie);
    const d2 = await mkDelegation(t.users.ktt, t.users.kv2.id);
    expect((await act(own, t.users.kv2.cookie)).json().error.code).toBe('APPROVAL_SELF');
    await revoke(d2, t.users.ktt.cookie);
    await act(own, t.users.ktt.cookie, 'reject', { reason: 'Dọn' });
  });

  it('mỗi bước một người: người đã duyệt bước trước không qua ủy quyền duyệt tiếp bước sau', async () => {
    const adv = payment({ kind: 'advance', partyCode: null, payeeName: 'Nguyễn Văn A', reason: 'Tạm ứng', amountCurrency: '3000000' }); // hai bước cùng vai trò Kế toán trưởng
    const id = await pending(adv);
    expect((await act(id, t.users.ktt.cookie)).statusCode).toBe(200);
    const d = await mkDelegation(t.users.ktt, t.users.kv2.id); // ktt đã duyệt bước 1 rồi ủy quyền cho kv2
    const r = await act(id, t.users.kv2.cookie);
    expect(r.statusCode).toBe(403); expect(r.json().error.code).toBe('APPROVAL_WRONG_APPROVER');
    // Ngược lại: kv2 duyệt thay ktt ở bước 1 thì ktt không duyệt bước 2 nữa.
    const id2 = await pending(adv);
    expect((await act(id2, t.users.kv2.cookie)).statusCode).toBe(200);
    expect((await act(id2, t.users.ktt.cookie)).json().error.code).toBe('APPROVAL_ALREADY_ACTED');
    expect((await act(id2, t.users.ktt2.cookie)).json()).toMatchObject({ state: 'approved' });
    await revoke(d, t.users.ktt.cookie);
    await act(id, t.users.ktt2.cookie, 'reject', { reason: 'Dọn' });
  });

  it('không tự ủy quyền, không ủy quyền vòng, người nhận phải có quyền duyệt', async () => {
    expect((await delegate(t.users.ktt, t.users.ktt.id)).statusCode).toBe(400);
    expect((await delegate(t.users.ktt, t.users.viewer.id)).json().error.code).toBe('APPROVAL_DELEGATE_NO_PERMISSION');
    expect((await delegate(t.users.ktt, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await t.call('POST', '/api/approval-delegations', { delegateId: t.users.kv2.id, dateFrom: day(3), dateTo: day(1) }, t.users.ktt.cookie)).statusCode).toBe(400);
    expect((await t.call('POST', '/api/approval-delegations', { delegateId: t.users.kv2.id, dateFrom: day(0), dateTo: day(400) }, t.users.ktt.cookie)).statusCode).toBeGreaterThanOrEqual(400);
    // Người chỉ xem không có quyền duyệt nên không lập ủy quyền
    expect((await delegate(t.users.viewer, t.users.ktt.id)).statusCode).toBe(403);
    const a = await mkDelegation(t.users.ktt, t.users.kv2.id);
    const back = await delegate(t.users.kv2, t.users.ktt.id);
    expect(back.statusCode).toBe(409); expect(back.json().error.code).toBe('APPROVAL_DELEGATION_CYCLE');
    const b = await mkDelegation(t.users.kv2, t.users.ktt2.id);
    const loop = await delegate(t.users.ktt2, t.users.ktt.id); // ktt → kv2 → ktt2 → ktt
    expect(loop.statusCode).toBe(409); expect(loop.json().error.code).toBe('APPROVAL_DELEGATION_CYCLE');
    // khoảng ngày không chồng nhau thì không thành vòng
    expect((await delegate(t.users.ktt2, t.users.ktt.id, { dateFrom: day(30), dateTo: day(35) })).statusCode).toBe(201);
    // Không bắc cầu: ktt2 được kv2 ủy quyền, kv2 được ktt ủy quyền, nhưng ktt2 không duyệt thay bước của ktt qua kv2
    const id = await pending();
    expect((await act(id, t.users.kv2.cookie)).statusCode).toBe(200); // kv2 duyệt thay ktt
    const id2 = await pending();
    expect((await act(id2, t.users.viewer.cookie)).statusCode).toBe(403);
    await revoke(a, t.users.ktt.cookie); await revoke(b, t.users.kv2.cookie);
    await act(id2, t.users.ktt.cookie, 'reject', { reason: 'Dọn' });
  });

  it('phân quyền: thiếu cờ nhạy cảm của chính mình thì không duyệt thay và không thấy trong hộp duyệt; người bị giới hạn chi nhánh không nhận/không dùng được ủy quyền', async () => {
    const id = await pending();
    // kttNoPayable đúng vai trò nhưng thiếu view_payable; ủy quyền không cấp cờ
    const d = await mkDelegation(t.users.ktt, t.users.kttNoPayable.id);
    const r = await act(id, t.users.kttNoPayable.cookie);
    expect(r.statusCode).toBe(403);
    expect((await inbox(t.users.kttNoPayable.cookie)).map((x) => x.id)).not.toContain(id);
    expect(JSON.stringify(await inbox(t.users.kttNoPayable.cookie))).not.toContain('view_payable');
    await revoke(d, t.users.ktt.cookie);
    // Người bị giới hạn chi nhánh: quyền duyệt bị thu về, không nhận ủy quyền mới
    const br = (await t.call('POST', '/api/branches', { code: 'CNUQ', name: 'Chi nhánh ủy quyền' })).json().id as number;
    const d2 = await mkDelegation(t.users.ktt, t.users.kv2.id);
    expect((await t.call('PUT', `/api/users/${t.users.kv2.id}/branch-scope`, { branches: [br] })).statusCode).toBe(200);
    const scoped = await act(id, t.users.kv2.cookie); // cookie cũ: quyền được nạp lại mỗi yêu cầu
    expect(scoped.statusCode).toBe(403);
    expect((await delegate(t.users.ktt, t.users.kv2.id)).json().error.code).toBe('APPROVAL_DELEGATE_SCOPED');
    expect((await t.call('GET', '/api/approvals?box=inbox', undefined, t.users.kv2.cookie)).statusCode).toBe(403);
    expect((await t.call('GET', '/api/approval-delegations/candidates', undefined, t.users.ktt.cookie)).json().map((x: { id: string }) => x.id)).not.toContain(t.users.kv2.id);
    await revoke(d2, t.users.ktt.cookie);
    expect((await t.call('PUT', `/api/users/${t.users.kv2.id}/branch-scope`, { branches: [] })).statusCode).toBe(200);
    await act(id, t.users.ktt.cookie, 'reject', { reason: 'Dọn' });
  });

  it('lập thay người khác: kế toán trưởng (chỉ có setting.update) không được; không được lập ủy quyền thay người khác với người nhận là chính mình; quản trị lập thay thì ghi audit_event', async () => {
    // Kịch bản tấn công: kế toán trưởng lập "ktt2 -> chính mình" rồi duyệt thay ktt2.
    const self = await t.call('POST', '/api/approval-delegations', { delegatorId: t.users.ktt2.id, delegateId: t.users.ktt.id, dateFrom: day(0), dateTo: day(2) }, t.users.ktt.cookie);
    expect(self.statusCode, self.body).toBe(403);
    // Quản trị cũng không được tự nhận quyền của người khác.
    const adminSelf = await t.call('POST', '/api/approval-delegations', { delegatorId: t.users.ktt2.id, delegateId: t.adminId, dateFrom: day(0), dateTo: day(2) }, t.admin);
    expect(adminSelf.statusCode, adminSelf.body).toBe(403);
    expect(adminSelf.json().error.code).toBe('FORBIDDEN');
    const ok = await t.call('POST', '/api/approval-delegations', { delegatorId: t.users.ktt2.id, delegateId: t.users.ktt.id, dateFrom: day(0), dateTo: day(2) }, t.admin);
    expect(ok.statusCode, ok.body).toBe(201);
    const ev = await sql<{ n: string }>`SELECT count(*)::text AS n FROM audit_event WHERE tenant_id = ${t.tenantId}::uuid AND action = 'approval_delegation_on_behalf' AND entity_id = ${String(ok.json().id)}`.execute(ctx.t.admin);
    expect(ev.rows[0]!.n).toBe('1');
    await revoke(ok.json().id, t.users.ktt2.cookie);
  });

  it('danh sách và nhật ký: người ủy quyền/được ủy quyền xem của mình, quản trị xem tất cả; sự kiện kiểm toán được ghi', async () => {
    const d = await mkDelegation(t.users.ktt, t.users.kv2.id, { reason: 'Nghỉ phép' });
    const mine = (await t.call('GET', '/api/approval-delegations', undefined, t.users.kv2.cookie)).json() as { id: number; reason: string | null; status: string }[];
    expect(mine.find((x) => x.id === d)).toMatchObject({ reason: 'Nghỉ phép', status: 'active' });
    expect(((await t.call('GET', '/api/approval-delegations', undefined, t.users.ktt2.cookie)).json() as { id: number }[]).map((x) => x.id)).not.toContain(d);
    expect((await t.call('GET', '/api/approval-delegations?scope=all', undefined, t.users.requester.cookie)).statusCode).toBe(403);
    expect(((await t.call('GET', '/api/approval-delegations?scope=all', undefined, t.admin)).json() as { id: number }[]).map((x) => x.id)).toContain(d);
    // quản trị lập thay người khác; người thường thì không
    expect((await t.call('POST', '/api/approval-delegations', { delegatorId: t.users.ktt.id, delegateId: t.users.ktt2.id, dateFrom: day(0), dateTo: day(2) }, t.users.kv2.cookie)).statusCode).toBe(403);
    expect((await t.call('POST', '/api/approval-delegations', { delegatorId: t.users.ktt.id, delegateId: t.users.ktt2.id, dateFrom: day(0), dateTo: day(2) }, t.admin)).statusCode).toBe(201);
    await revoke(d, t.users.ktt.cookie);
    const audit = await sql<{ action: string }>`SELECT action FROM audit_event WHERE tenant_id = ${t.tenantId}::uuid AND entity = 'approval_delegation' AND entity_id = ${String(d)} ORDER BY id`.execute(ctx.t.admin);
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe('duyệt hàng loạt', () => {
  it('duyệt nhiều đề nghị một lần, báo kết quả từng đề nghị; đề nghị không hợp lệ không kéo các đề nghị khác', async () => {
    const a = await pending(); const b = await pending(); const c = await pending();
    const done = await pending(); expect((await act(done, t.users.ktt.cookie)).statusCode).toBe(200);
    const r = await t.call('POST', '/api/approvals/batch/approve', { ids: [a, b, done, c, '00000000-0000-4000-8000-000000000000'], note: 'Duyệt lô' }, t.users.ktt.cookie);
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json() as { approved: number; failed: number; results: { id: string; ok: boolean; code?: string; state?: string }[] };
    expect(j).toMatchObject({ approved: 3, failed: 2 });
    expect(j.results.map((x) => [x.ok, x.code ?? x.state])).toEqual([[true, 'approved'], [true, 'approved'], [false, 'APPROVAL_NOT_PENDING'], [true, 'approved'], [false, 'APPROVAL_REQUEST_NOT_FOUND']]);
    for (const id of [a, b, c]) expect((await get(id)).state).toBe('approved');
    const n = await sql<{ n: string }>`SELECT count(*)::text AS n FROM voucher WHERE source_doc_id = ANY (${[a, b, c]}::uuid[])`.execute(ctx.t.admin);
    expect(n.rows[0]!.n).toBe('3');
  });

  it('phân quyền: người thiếu cờ bị từ chối từng đề nghị mà không lộ tên cờ; người không có quyền duyệt 403; ids trùng hoặc quá nhiều 400', async () => {
    const a = await pending(); const b = await pending();
    const r = await t.call('POST', '/api/approvals/batch/approve', { ids: [a, b] }, t.users.kttNoPayable.cookie);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ approved: 0, failed: 2 });
    expect(r.body).not.toMatch(/view_payable|công nợ/i);
    expect((await get(a)).state).toBe('submitted');
    expect((await t.call('POST', '/api/approvals/batch/approve', { ids: [a] }, t.users.viewer.cookie)).statusCode).toBe(403);
    expect((await t.call('POST', '/api/approvals/batch/approve', { ids: [a, a] }, t.users.ktt.cookie)).statusCode).toBe(400);
    expect((await t.call('POST', '/api/approvals/batch/approve', { ids: [] }, t.users.ktt.cookie)).statusCode).toBe(400);
    // người đề nghị không tự duyệt hàng loạt; người sai vai trò thì từng dòng báo lỗi
    expect((await t.call('POST', '/api/approvals/batch/approve', { ids: [a] }, t.users.requester.cookie)).json().results[0].code).toBe('APPROVAL_SELF');
    expect((await t.call('POST', '/api/approvals/batch/approve', { ids: [a] }, t.users.kv2.cookie)).json().results[0].code).toBe('APPROVAL_WRONG_APPROVER');
    // hàng loạt qua ủy quyền: ghi người duyệt thay
    const d = await mkDelegation(t.users.ktt, t.users.kv2.id);
    const viaDel = await t.call('POST', '/api/approvals/batch/approve', { ids: [a, b] }, t.users.kv2.cookie);
    expect(viaDel.json()).toMatchObject({ approved: 2, failed: 0 });
    expect(((await get(a)).log as { onBehalfOf: string | null }[]).at(-1)!.onBehalfOf).toBe(t.users.ktt.username);
    await revoke(d, t.users.ktt.cookie);
  });

  it('từ chối hàng loạt cần lý do', async () => {
    const a = await pending(); const b = await pending();
    expect((await t.call('POST', '/api/approvals/batch/reject', { ids: [a, b], reason: ' ' }, t.users.ktt.cookie)).statusCode).toBe(400);
    const r = await t.call('POST', '/api/approvals/batch/reject', { ids: [a, b], reason: 'Thiếu chứng từ' }, t.users.ktt.cookie);
    expect(r.json()).toMatchObject({ rejected: 2, failed: 0 });
    expect(await get(a)).toMatchObject({ state: 'rejected', rejectReason: 'Thiếu chứng từ' });
  });
});
