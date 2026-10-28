import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { payment, setupApprovalTenant, type ApprovalTenant } from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
let ctx: TestApp; let t: ApprovalTenant;
beforeAll(async () => { ctx = await createTestApp(); t = await setupApprovalTenant(ctx, `AP${Date.now()}`); });
afterAll(async () => { await ctx.close(); });

const create = async (body: object, cookie = t.users.requester.cookie) => {
  const r = await t.call('POST', '/api/approvals', body, cookie);
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; requestNo: string };
};
const submit = async (id: string) => { const r = await t.call('POST', `/api/approvals/${id}/submit`, {}, t.users.requester.cookie); expect(r.statusCode, r.body).toBe(200); };
const act = (id: string, cookie: string, what: 'approve' | 'reject' = 'approve', body: object = {}) => t.call('POST', `/api/approvals/${id}/${what}`, body, cookie);
const get = async (id: string, cookie = t.users.requester.cookie) => (await t.call('GET', `/api/approvals/${id}`, undefined, cookie)).json();

describe('đề nghị thanh toán / tạm ứng', () => {
  it('đánh số theo loại và năm; người khác không sửa được; gửi duyệt rồi không sửa được', async () => {
    const a = await create(payment());
    const b = await create(payment({ kind: 'advance', partyCode: null, payeeName: 'Nguyễn Văn A', amountCurrency: '2000000' }));
    expect(a.requestNo).toMatch(/^DNTT-2026-\d{5}$/);
    expect(b.requestNo).toMatch(/^DNTU-2026-\d{5}$/);
    expect((await t.call('PUT', `/api/approvals/${a.id}`, payment({ reason: 'x' }), t.users.kv2.cookie)).statusCode).toBe(403);
    expect((await t.call('PUT', `/api/approvals/${a.id}`, payment({ reason: 'Sửa lý do' }), t.users.requester.cookie)).statusCode).toBe(200);
    await submit(a.id);
    const r = await t.call('PUT', `/api/approvals/${a.id}`, payment(), t.users.requester.cookie);
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('APPROVAL_NOT_DRAFT');
    expect(await get(a.id)).toMatchObject({ state: 'submitted', currentStep: 1, reason: 'Sửa lý do', steps: [{ stepNo: 1, roleName: 'Kế toán trưởng' }] });
  });

  it('đầu vào: TK công nợ cần đối tượng, chuyển khoản cần TK ngân hàng, VND không có phần lẻ, ngoại tệ cần tỷ giá', async () => {
    const bad = async (body: object) => { const r = await t.call('POST', '/api/approvals', body, t.users.requester.cookie); expect(r.statusCode, r.body).toBe(400); };
    await bad(payment({ partyCode: null }));
    await bad(payment({ payMethod: 'bank' }));
    await bad(payment({ amountCurrency: '100.5' }));
    await bad(payment({ currencyCode: 'USD', amountCurrency: '100' }));
    const usd = await create(payment({ currencyCode: 'USD', amountCurrency: '100.5', fxRate: '25000' }));
    expect(await get(usd.id)).toMatchObject({ amount: '2512500', amountCurrency: '100.5', fxRate: '25000' });
  });

  it('chưa có quy trình phù hợp thì không gửi duyệt được', async () => {
    const off = await t.call('GET', '/api/approval-flows');
    const adv = (off.json() as { id: number; kind: string; name: string; minAmount: string; steps: { roleId: string | null; userId: string | null }[] }[]).find((f) => f.kind === 'advance')!;
    const body = { kind: 'advance', name: adv.name, minAmount: '0', isActive: false, steps: adv.steps.map((s) => (s.roleId ? { roleId: s.roleId } : { userId: s.userId! })) };
    expect((await t.call('PUT', `/api/approval-flows/${adv.id}`, body)).statusCode).toBe(200);
    const a = await create(payment({ kind: 'advance', partyCode: null, payeeName: 'A' }));
    const r = await t.call('POST', `/api/approvals/${a.id}/submit`, {}, t.users.requester.cookie);
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('APPROVAL_FLOW_NOT_FOUND');
    expect((await t.call('PUT', `/api/approval-flows/${adv.id}`, { ...body, isActive: true })).statusCode).toBe(200);
    // Trùng hạn mức với quy trình đang dùng cùng loại: 409.
    const dup = await t.call('POST', '/api/approval-flows', { ...body, isActive: true });
    expect(dup.statusCode).toBe(409); expect(dup.json().error.code).toBe('APPROVAL_FLOW_DUPLICATE');
    // Người không có setting.update không cấu hình được.
    expect((await t.call('GET', '/api/approval-flows', undefined, t.users.requester.cookie)).statusCode).toBe(403);
  });

  it('duyệt một bước: tự duyệt, sai vai trò, thiếu cờ view_payable bị chặn; duyệt xong sinh Phiếu chi nháp Nợ 331/Có 1111 kèm tệp, ghi nhật ký kiểm toán', async () => {
    const a = await create(payment());
    const up = await t.upload(`/api/approvals/${a.id}/attachments`, 'bao-gia.txt', 'bao gia mau', t.users.requester.cookie);
    expect(up.statusCode, up.body).toBe(201);
    await submit(a.id);
    const self = await act(a.id, t.users.requester.cookie);
    expect(self.statusCode).toBe(403); expect(self.json().error.code).toBe('APPROVAL_SELF');
    const wrong = await act(a.id, t.users.kv2.cookie);
    expect(wrong.statusCode).toBe(403); expect(wrong.json().error.code).toBe('APPROVAL_WRONG_APPROVER');
    expect((await act(a.id, t.users.kttNoPayable.cookie)).statusCode).toBe(403);
    expect((await t.call('GET', `/api/approvals/${a.id}`, undefined, t.users.kttNoPayable.cookie)).statusCode).toBe(403);
    const inboxNp = (await t.call('GET', '/api/approvals?box=inbox', undefined, t.users.kttNoPayable.cookie)).json() as { id: string }[];
    expect(inboxNp.map((x) => x.id)).not.toContain(a.id);
    const inbox = (await t.call('GET', '/api/approvals?box=inbox', undefined, t.users.ktt.cookie)).json() as { id: string }[];
    expect(inbox.map((x) => x.id)).toContain(a.id);
    expect((await t.call('GET', '/api/approvals/inbox/count', undefined, t.users.ktt.cookie)).json().count).toBeGreaterThanOrEqual(1);

    const ok = await act(a.id, t.users.ktt.cookie, 'approve', { note: 'Đồng ý' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ state: 'approved', voucherId: expect.any(String) });
    const v = await t.call('GET', `/api/vouchers/${ok.json().voucherId}`);
    expect(v.json()).toMatchObject({ voucherType: 'PC', state: 'draft', sourceDocType: 'approval_request', sourceDocId: a.id, partyCode: 'NCC001', personName: 'Công ty NCC 1', purpose: 'chi_tra_ncc', attachmentsCount: 1 });
    expect((v.json().lines as { accountCode: string; debit: string; credit: string }[]).map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['331', '5000000', '0'], ['1111', '0', '5000000']]);
    const atts = (await t.call('GET', `/api/vouchers/${ok.json().voucherId}/attachments`)).json() as { id: string }[];
    expect(atts).toHaveLength(1);
    expect((await t.call('GET', `/api/attachments/${atts[0]!.id}`)).body).toBe('bao gia mau');
    expect(await get(a.id)).toMatchObject({ state: 'approved', voucherNo: v.json().voucherNo, log: [{ action: 'submit' }, { action: 'approve', note: 'Đồng ý', username: t.users.ktt.username }] });
    // Duyệt lại: đề nghị không còn chờ duyệt, không sinh thêm phiếu.
    expect((await act(a.id, t.users.ktt2.cookie)).statusCode).toBe(409);
    const n = await sql<{ n: string }>`SELECT count(*)::text AS n FROM voucher WHERE source_doc_id = ${a.id}::uuid`.execute(ctx.t.admin);
    expect(n.rows[0]!.n).toBe('1');
    const audit = await sql<{ action: string; state: string | null }>`SELECT action, after->>'state' AS state FROM audit_event WHERE entity = 'approval_request' AND entity_id = ${a.id} ORDER BY id`.execute(ctx.t.admin);
    expect(audit.rows.map((r) => r.state)).toEqual(['draft', 'submitted', 'approved']);
  });

  it('hạn mức lớn: hai bước (Kế toán trưởng rồi đích danh admin); tạm ứng hai bước cùng vai trò cần hai người khác nhau, sinh Giấy báo Nợ Nợ 141/Có 1121', async () => {
    const big = await create(payment({ amountCurrency: '20000000' }));
    await submit(big.id);
    expect((await get(big.id)).steps).toHaveLength(2);
    expect((await act(big.id, t.users.ktt.cookie)).json()).toMatchObject({ state: 'submitted', currentStep: 2 });
    const notAdmin = await act(big.id, t.users.ktt2.cookie);
    expect(notAdmin.statusCode).toBe(403); expect(notAdmin.json().error.code).toBe('APPROVAL_WRONG_APPROVER');
    expect((await act(big.id, t.admin)).json()).toMatchObject({ state: 'approved' });

    const adv = await create(payment({ kind: 'advance', partyCode: null, payeeName: 'Nguyễn Văn A', reason: 'Tạm ứng công tác', amountCurrency: '3000000', payMethod: 'bank', bankAccountNo: '1017588888' }));
    await submit(adv.id);
    expect((await act(adv.id, t.users.ktt.cookie)).statusCode).toBe(200);
    const twice = await act(adv.id, t.users.ktt.cookie);
    expect(twice.statusCode).toBe(403); expect(twice.json().error.code).toBe('APPROVAL_ALREADY_ACTED');
    const done = await act(adv.id, t.users.ktt2.cookie);
    expect(done.json()).toMatchObject({ state: 'approved' });
    const v = (await t.call('GET', `/api/vouchers/${done.json().voucherId}`)).json();
    expect(v).toMatchObject({ voucherType: 'BN', state: 'draft', bankAccountNo: '1017588888', purpose: 'chi_tam_ung' });
    expect((v.lines as { accountCode: string; debit: string; credit: string }[]).map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['141', '3000000', '0'], ['1121', '0', '3000000']]);
  });

  it('từ chối cần lý do; hủy chỉ do người đề nghị; danh sách theo hộp và quyền', async () => {
    const a = await create(payment());
    await submit(a.id);
    expect((await act(a.id, t.users.ktt.cookie, 'reject', { reason: ' ' })).statusCode).toBe(400);
    expect((await act(a.id, t.users.ktt.cookie, 'reject', { reason: 'Thiếu hóa đơn' })).statusCode).toBe(200);
    expect(await get(a.id)).toMatchObject({ state: 'rejected', rejectReason: 'Thiếu hóa đơn', voucherId: null });
    expect((await t.call('POST', `/api/approvals/${a.id}/cancel`, {}, t.users.requester.cookie)).statusCode).toBe(409);

    const b = await create(payment());
    expect((await t.call('POST', `/api/approvals/${b.id}/cancel`, {}, t.users.ktt.cookie)).statusCode).toBe(403);
    expect((await t.call('POST', `/api/approvals/${b.id}/cancel`, { note: 'Lập nhầm' }, t.users.requester.cookie)).statusCode).toBe(200);
    expect((await get(b.id)).state).toBe('cancelled');

    const mine = (await t.call('GET', '/api/approvals?box=mine', undefined, t.users.requester.cookie)).json() as { requesterName: string }[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.requesterName === t.users.requester.username)).toBe(true);
    expect((await t.call('GET', '/api/approvals?box=inbox', undefined, t.users.viewer.cookie)).statusCode).toBe(403);
    const all = await t.call('GET', '/api/approvals?box=all&state=rejected', undefined, t.users.viewer.cookie);
    expect(all.statusCode).toBe(200);
    expect((all.json() as { id: string }[]).map((x) => x.id)).toContain(a.id);
    // Chỉ xem không lập được đề nghị.
    expect((await t.call('POST', '/api/approvals', payment(), t.users.viewer.cookie)).statusCode).toBe(403);
  });

  it('tệp đính kèm: chỉ người đề nghị thêm/xóa, xóa khi còn nháp; người duyệt tải về được', async () => {
    const a = await create(payment());
    const up = await t.upload(`/api/approvals/${a.id}/attachments`, 'hd.txt', 'noi dung', t.users.requester.cookie);
    expect((await t.upload(`/api/approvals/${a.id}/attachments`, 'x.txt', 'x', t.users.ktt.cookie)).statusCode).toBe(403);
    await submit(a.id);
    expect((await t.call('GET', `/api/approval-attachments/${up.json().id}`, undefined, t.users.ktt.cookie)).body).toBe('noi dung');
    expect((await t.call('DELETE', `/api/approval-attachments/${up.json().id}`, undefined, t.users.requester.cookie)).statusCode).toBe(409);
    const row = await sql<{ storage_key: string }>`SELECT storage_key FROM approval_attachment WHERE id = ${up.json().id}::uuid`.execute(ctx.t.admin);
    expect(readFileSync(row.rows[0]!.storage_key, 'utf8')).toBe('noi dung');
  });
});
