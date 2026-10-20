import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string; let userId: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId, userId } = await bootstrapTenant(ctx, { code: `VC${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code: 'KH001', name: 'Khách A', is_customer: true } });
});
afterAll(async () => { await ctx.close(); });

const pkt = (date: string, lines: object[], extra: object = {}) => ({ voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Phiếu kế toán thử', lines, ...extra });
const L = (accountCode: string, debit = '0', credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
const post = (id: string) => ctx.app.inject({ method: 'POST', url: `/api/vouchers/${id}/post`, headers: { cookie } });
const create = (body: object) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: body });
const reverse = (id: string, postingDate: string) => ctx.app.inject({ method: 'POST', url: `/api/vouchers/${id}/reverse`, headers: { cookie }, payload: { postingDate } });
// Đặt quyền của một vai trò trong công ty rồi tạo người dùng thuộc vai trò đó; trả cookie đăng nhập. Quyền được đọc lại ở mỗi yêu cầu nên có hiệu lực ngay.
async function userWith(roleCode: string, permissions: string[]) {
  const roles = (await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie } })).json() as { id: string; code: string }[];
  await ctx.app.inject({ method: 'PUT', url: `/api/roles/${roles.find((r) => r.code === roleCode)!.id}/permissions`, headers: { cookie }, payload: { permissions } });
  const username = `${roleCode}_${Date.now()}`;
  await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username, fullName: 'Thử quyền', password: 'Matkhau1!', roleCode } });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
}

describe('chứng từ', () => {
  it('tạo nháp, ghi sổ cấp số PKT00001, lần sau PKT00002', async () => {
    const a = await create(pkt('2026-01-05', [L('1111', '1000000'), L('5113', '0', '1000000')]));
    expect(a.statusCode, a.body).toBe(201); expect(a.json()).toMatchObject({ state: 'draft', voucherNo: null, totalDebit: '1000000' });
    const p = await post(a.json().id); expect(p.json()).toMatchObject({ state: 'posted', voucherNo: 'PKT00001', seqNo: 1 });
    const b = await create(pkt('2026-01-06', [L('1111', '2000'), L('5113', '0', '2000')], { autoPost: true }));
    expect(b.json()).toMatchObject({ state: 'posted', voucherNo: 'PKT00002' });
  });

  it('chứng từ lệch, thiếu đối tượng, tài khoản tổng hợp bị từ chối với mã lỗi rõ', async () => {
    expect((await create(pkt('2026-01-05', [L('1111', '100'), L('5113', '0', '90')]))).json().error.code).toBe('VOUCHER_UNBALANCED');
    expect((await create(pkt('2026-01-05', [L('131', '100'), L('5113', '0', '100')]))).json().error.code).toBe('LINE_PARTY_REQUIRED');
    expect((await create(pkt('2026-01-05', [L('111', '100'), L('5113', '0', '100')]))).json().error.code).toBe('ACCOUNT_IS_GROUP');
    const ok = await create(pkt('2026-01-05', [L('131', '100', '0', { partyCode: 'KH001' }), L('5113', '0', '100')]));
    expect(ok.statusCode).toBe(201); expect(ok.json().lines[0]).toMatchObject({ partyCode: 'KH001', partyName: 'Khách A' });
  });

  it('số tiền Nợ/Có phải là số nguyên đồng: 100.5 bị từ chối 400; mã tra cứu không có bị 404', async () => {
    const frac = await create(pkt('2026-01-05', [L('1111', '100.5'), L('5113', '0', '100.5')]));
    expect(frac.statusCode).toBe(400); expect(frac.json().error.code).toBe('VALIDATION');
    const noParty = await create(pkt('2026-01-05', [L('131', '100', '0', { partyCode: 'KHONGCO' }), L('5113', '0', '100')]));
    expect(noParty.statusCode).toBe(404); expect(noParty.json().error.code).toBe('LOOKUP_NOT_FOUND');
  });

  it('không lập tay chứng từ kết chuyển KC (409 VOUCHER_TYPE_SYSTEM); phân bổ PB lập tay vẫn được', async () => {
    const kc = await create(pkt('2026-01-08', [L('911', '10'), L('5113', '0', '10')], { voucherType: 'KC' }));
    expect(kc.statusCode, kc.body).toBe(409); expect(kc.json().error.code).toBe('VOUCHER_TYPE_SYSTEM');
    const draft = (await create(pkt('2026-01-08', [L('6421', '10'), L('1111', '0', '10')]))).json();
    const edit = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${draft.id}`, headers: { cookie }, payload: { ...pkt('2026-01-08', [L('6421', '10'), L('1111', '0', '10')], { voucherType: 'KC' }), version: draft.version } });
    expect(edit.statusCode, edit.body).toBe(409); expect(edit.json().error.code).toBe('VOUCHER_TYPE_SYSTEM');
    expect((await create(pkt('2026-01-08', [L('6421', '10'), L('1111', '0', '10')], { voucherType: 'PB' }))).statusCode).toBe(201);
  });

  it('tối đa 5.000 dòng mỗi chứng từ: 5.001 dòng bị 400 kèm thông điệp', async () => {
    const lines = Array.from({ length: 5001 }, (_, i) => L(i % 2 ? '1111' : '6422', i % 2 ? '0' : '1', i % 2 ? '1' : '0'));
    const r = await create(pkt('2026-01-09', lines));
    expect(r.statusCode).toBe(400); expect(r.json().error.code).toBe('VALIDATION'); expect(r.body).toContain('Tối đa 5.000 dòng mỗi chứng từ');
  });

  it('số tiền VND tối đa 16 chữ số: 10^16-1 được nhận, 10^16 bị 400 kèm thông điệp', async () => {
    const ok = await create(pkt('2026-01-07', [L('1111', '9999999999999999'), L('5113', '0', '9999999999999999')]));
    expect(ok.statusCode, ok.body).toBe(201); expect(ok.json().totalDebit).toBe('9999999999999999');
    const big = await create(pkt('2026-01-07', [L('1111', '10000000000000000'), L('5113', '0', '10000000000000000')]));
    expect(big.statusCode).toBe(400); expect(big.json().error.code).toBe('VALIDATION'); expect(big.body).toContain('Số tiền VND phải là số nguyên tối đa 16 chữ số');
  });

  it('sửa chứng từ đã ghi sổ: diễn giải và chiều phân tích tại chỗ; số tiền phải bỏ ghi sổ', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/catalogs/department', headers: { cookie }, payload: { code: 'KD', name: 'Kinh doanh' } });
    const v = (await create(pkt('2026-02-01', [L('6421', '500'), L('1111', '0', '500')], { autoPost: true }))).json();
    const meta = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${v.id}`, headers: { cookie }, payload: { version: v.version, description: 'Đã sửa diễn giải', lines: [{ lineNo: 1, departmentCode: 'KD' }] } });
    expect(meta.statusCode, meta.body).toBe(200); expect(meta.json()).toMatchObject({ description: 'Đã sửa diễn giải', state: 'posted' });
    expect(meta.json().lines[0].departmentCode).toBe('KD');
    const amt = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${v.id}`, headers: { cookie }, payload: { ...pkt('2026-02-01', [L('6421', '600'), L('1111', '0', '600')]), version: meta.json().version } });
    expect(amt.json().error.code).toBe('VOUCHER_POSTED_EDIT');
    const stale = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${v.id}`, headers: { cookie }, payload: { version: 1, description: 'cũ' } });
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
  });

  it('bỏ ghi sổ giữ số, lưu lịch sử dòng; sửa rồi ghi sổ lại', async () => {
    const v = (await create(pkt('2026-02-02', [L('6421', '700'), L('1111', '0', '700')], { autoPost: true }))).json();
    const u = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/unpost`, headers: { cookie } });
    expect(u.json()).toMatchObject({ state: 'draft', voucherNo: v.voucherNo });
    const h = await sql<{ n: number }>`SELECT count(*) AS n FROM voucher_line_history WHERE voucher_id = ${v.id}::uuid`.execute(ctx.t.admin);
    expect(h.rows[0]!.n).toBe(1);
    const e = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${v.id}`, headers: { cookie }, payload: { ...pkt('2026-02-02', [L('6421', '750'), L('1111', '0', '750')]), version: u.json().version } });
    expect(e.statusCode, e.body).toBe(200);
    const p = await post(v.id); expect(p.json()).toMatchObject({ state: 'posted', voucherNo: v.voucherNo, totalDebit: '750' });
  });

  it('đảo chứng từ tạo chứng từ mới đã ghi sổ với dòng đảo chiều; gốc thành reversed và không bỏ ghi sổ được nữa', async () => {
    const v = (await create(pkt('2026-03-01', [L('6422', '300'), L('1111', '0', '300')], { autoPost: true }))).json();
    const r = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/reverse`, headers: { cookie }, payload: { postingDate: '2026-03-15' } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ state: 'posted', reversalOfId: v.id, postingDate: '2026-03-15' });
    expect(r.json().lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit])).toEqual([['6422', '0', '300'], ['1111', '300', '0']]);
    const g = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${v.id}`, headers: { cookie } });
    expect(g.json()).toMatchObject({ state: 'reversed', reversedById: r.json().id });
    expect((await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/unpost`, headers: { cookie } })).json().error.code).toBe('STATE_INVALID');
    expect((await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/reverse`, headers: { cookie }, payload: { postingDate: '2026-02-01' } })).json().error.code).toBe('STATE_INVALID');
  });

  it('hủy chứng từ nháp đã có số giữ số; xóa nháp chưa số được; không có đường sửa trực tiếp qua SQL', async () => {
    const v = (await create(pkt('2026-03-02', [L('6422', '10'), L('1111', '0', '10')], { autoPost: true }))).json();
    await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/unpost`, headers: { cookie } });
    const d = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/discard`, headers: { cookie } });
    expect(d.json()).toMatchObject({ state: 'cancelled', voucherNo: v.voucherNo });
    const draft = (await create(pkt('2026-03-03', [L('6422', '10'), L('1111', '0', '10')]))).json();
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/vouchers/${draft.id}`, headers: { cookie } })).statusCode).toBe(204);
    const posted = (await create(pkt('2026-03-04', [L('6422', '20'), L('1111', '0', '20')], { autoPost: true }))).json();
    await expect(ctx.t.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${tenantId}, true)`.execute(trx);
      await sql`UPDATE voucher_line SET debit = 999 WHERE voucher_id = ${posted.id}::uuid AND debit > 0`.execute(trx);
    })).rejects.toThrow(/LINE_IMMUTABLE/);
    await expect(ctx.t.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${tenantId}, true)`.execute(trx);
      await sql`DELETE FROM voucher_line WHERE voucher_id = ${posted.id}::uuid`.execute(trx);
    })).rejects.toThrow(/LINE_IMMUTABLE/);
  });

  it('idempotency_key: gửi 5 lần song song chỉ tạo một chứng từ', async () => {
    const key = `key-${Date.now()}`;
    const rs = await Promise.all(Array.from({ length: 5 }, () => create(pkt('2026-04-01', [L('6422', '1'), L('1111', '0', '1')], { idempotencyKey: key, autoPost: true }))));
    expect(rs.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    const ids = new Set(rs.map((r) => r.json().id));
    expect(ids.size).toBe(1);
    expect(rs.every((r) => r.json().state === 'posted')).toBe(true);
    const n = await sql<{ n: number }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND idempotency_key = ${key}`.execute(ctx.t.admin);
    expect(n.rows[0]!.n).toBe(1);
    // Bỏ ghi sổ rồi gửi lại cùng khóa: trả chứng từ nháp hiện có, không ghi sổ lại.
    const id = rs[0]!.json().id as string;
    await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${id}/unpost`, headers: { cookie } });
    const replay = await create(pkt('2026-04-01', [L('6422', '1'), L('1111', '0', '1')], { idempotencyKey: key, autoPost: true }));
    expect(replay.json()).toMatchObject({ id, state: 'draft' });
    await post(id); // trả lại trạng thái ghi sổ cho test danh sách bên dưới
  });

  it('nhân bản tạo nháp mới cùng dòng, ngày mới; danh sách lọc theo loại/khoảng ngày/trạng thái', async () => {
    const v = (await create(pkt('2026-04-02', [L('6422', '40'), L('1111', '0', '40')], { autoPost: true }))).json();
    const d = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/duplicate`, headers: { cookie }, payload: { postingDate: '2026-04-20' } });
    expect(d.json()).toMatchObject({ state: 'draft', voucherNo: null, postingDate: '2026-04-20', totalDebit: '40' });
    const list = await ctx.app.inject({ method: 'GET', url: '/api/vouchers?type=PKT&from=2026-04-01&to=2026-04-30&state=posted', headers: { cookie } });
    expect(list.json().rows.every((r: { state: string }) => r.state === 'posted')).toBe(true);
    expect(list.json().total).toBeGreaterThanOrEqual(2);
  });

  it('một công ty nhiều hệ tài khoản: mã tài khoản tra theo chế độ của kỳ chứa ngày ghi sổ', async () => {
    const fy = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2027, dateFrom: '2027-01-01', months: 12, regime: 'TT200' } });
    expect(fy.statusCode, fy.body).toBe(201);
    // Mã 1111 và 5113 có ở cả hai hệ. (Chứng từ DK ở kỳ 0 không lập qua API chứng từ nữa: xem openingBalance.test.ts.)
    const a = await create(pkt('2026-12-31', [L('1111', '5'), L('5113', '0', '5')], { autoPost: true }));
    // Loại PB (không phải PKT): số PKT00001 của năm 2027 sẽ trùng PKT00001 của năm 2026 vì tiền tố mặc định chưa có {YY} (thuộc Task 17).
    const c = await create({ ...pkt('2027-01-10', [L('1111', '9'), L('5113', '0', '9')], { autoPost: true }), voucherType: 'PB' });
    expect([a.statusCode, c.statusCode], `${a.body} ${c.body}`).toEqual([201, 201]);
    const regimes = await Promise.all([a, c].map(async (r) => (await sql<{ regime: string }>`SELECT DISTINCT a.regime FROM voucher_line l JOIN account a ON a.id = l.account_id WHERE l.voucher_id = ${r.json().id}::uuid`.execute(ctx.t.admin)).rows.map((x) => x.regime)));
    expect(regimes).toEqual([['TT133'], ['TT200']]);
  });

  it('quyền và khóa kỳ: bỏ ghi sổ cần voucher.edit_posted; kỳ khóa mềm chỉ ghi được khi có voucher.backdate_locked; kỳ khóa không bỏ ghi sổ được nhưng đảo được', async () => {
    const kvCookie = await userWith('ketoan_vien', ['voucher.view', 'voucher.create', 'voucher.post', 'voucher.unpost']);
    const mine = (body: object) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie: kvCookie }, payload: body });

    const v = (await create(pkt('2026-05-04', [L('6422', '3'), L('1111', '0', '3')], { autoPost: true }))).json();
    const noEdit = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/unpost`, headers: { cookie: kvCookie } });
    expect(noEdit.statusCode).toBe(403); expect(noEdit.json().error.code).toBe('FORBIDDEN');

    await sql`UPDATE fiscal_period SET status = 'soft_locked' WHERE tenant_id = ${tenantId}::uuid AND fiscal_year = 2026 AND period_no = 5`.execute(ctx.t.admin);
    const blocked = await mine(pkt('2026-05-05', [L('6422', '4'), L('1111', '0', '4')], { autoPost: true }));
    expect(blocked.statusCode).toBe(409); expect(blocked.json().error.code).toBe('PERIOD_SOFT_LOCKED');
    const ok = await create(pkt('2026-05-05', [L('6422', '4'), L('1111', '0', '4')], { autoPost: true }));
    expect(ok.statusCode, ok.body).toBe(201); expect(ok.json().state).toBe('posted');

    expect((await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/unpost`, headers: { cookie } })).json().error.code).toBe('UNPOST_PERIOD_NOT_OPEN');
    // kỳ khóa cứng (đặt thẳng trạng thái, chứng từ chưa có hash): thông điệp chỉ hướng lập bút toán điều chỉnh ở kỳ đang mở
    const setStatus = (status: string) => sql`UPDATE fiscal_period SET status = ${status} WHERE tenant_id = ${tenantId}::uuid AND fiscal_year = 2026 AND period_no = 5`.execute(ctx.t.admin);
    await setStatus('hard_locked');
    const hard = (await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/unpost`, headers: { cookie } })).json().error;
    expect([hard.code, hard.message]).toEqual(['UNPOST_PERIOD_NOT_OPEN', 'kỳ đã khóa cứng; lập bút toán điều chỉnh ở kỳ đang mở']);
    await setStatus('soft_locked');
    const rev = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/reverse`, headers: { cookie }, payload: { postingDate: '2026-05-10' } });
    expect(rev.statusCode, rev.body).toBe(201); expect(rev.json()).toMatchObject({ state: 'posted', reversalOfId: v.id });
  });

  it('autoPost cần voucher.post: người chỉ có voucher.create bị 403 và không có gì được tạo; tạo nháp vẫn được', async () => {
    const xem = await userWith('xem', ['voucher.view', 'voucher.create']);
    const body = pkt('2026-06-02', [L('6422', '2'), L('1111', '0', '2')]);
    const key = `deny-${Date.now()}`;
    const denied = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie: xem }, payload: { ...body, idempotencyKey: key, autoPost: true } });
    expect(denied.statusCode).toBe(403); expect(denied.json().error.code).toBe('FORBIDDEN');
    const n = await sql<{ n: number }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND idempotency_key = ${key}`.execute(ctx.t.admin);
    expect(n.rows[0]!.n).toBe(0);
    const draft = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie: xem }, payload: body });
    expect(draft.statusCode, draft.body).toBe(201); expect(draft.json().state).toBe('draft');
  });

  it('chứng từ của công ty khác: xem được 404, ghi sổ báo VOUCHER_NOT_FOUND và chứng từ không đổi', async () => {
    const other = await bootstrapTenant(ctx, { code: `VX${Date.now()}` });
    const v = (await create(pkt('2026-06-03', [L('6422', '2'), L('1111', '0', '2')]))).json();
    const get = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${v.id}`, headers: { cookie: other.cookie } });
    expect(get.statusCode).toBe(404); expect(get.json().error.code).toBe('VOUCHER_NOT_FOUND');
    const posted = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/post`, headers: { cookie: other.cookie } });
    expect([posted.statusCode, posted.json().error.code]).toEqual([404, 'VOUCHER_NOT_FOUND']); // từ thủ tục SQL (P0001), mã *_NOT_FOUND nên 404
    expect((await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${v.id}`, headers: { cookie } })).json().state).toBe('draft');
  });

  it('chứng từ đảo không bỏ ghi sổ được (gốc sẽ kẹt ở reversed); đảo lại chứng từ đảo thì được', async () => {
    const o = (await create(pkt('2026-06-10', [L('6422', '8'), L('1111', '0', '8')], { autoPost: true }))).json();
    const r = (await reverse(o.id, '2026-06-11')).json();
    const u = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${r.id}/unpost`, headers: { cookie } });
    expect(u.statusCode).toBe(409); expect(u.json().error.code).toBe('STATE_INVALID');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${r.id}`, headers: { cookie } })).json().state).toBe('posted');
    const rr = await reverse(r.id, '2026-06-12');
    expect(rr.statusCode, rr.body).toBe(201); expect(rr.json()).toMatchObject({ state: 'posted', reversalOfId: r.id });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${o.id}`, headers: { cookie } })).json().state).toBe('reversed');
  });

  it('sửa diễn giải chứng từ đã ghi sổ ghi đúng một dòng audit (trước/sau); sửa chiều phân tích của dòng không ghi thêm dòng audit chứng từ', async () => {
    const v = (await create(pkt('2026-06-15', [L('6422', '9'), L('1111', '0', '9')], { autoPost: true }))).json();
    const audits = async () => (await sql<{ user_id: string; before: unknown; after: unknown }>`SELECT user_id, before, after FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = 'voucher' AND entity_id = ${v.id} AND action = 'update'`.execute(ctx.t.admin)).rows;
    expect(await audits()).toHaveLength(0);
    const e = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${v.id}`, headers: { cookie }, payload: { version: v.version, description: 'Diễn giải mới' } });
    expect(e.statusCode, e.body).toBe(200);
    expect(await audits()).toEqual([{ user_id: userId, before: { description: 'Phiếu kế toán thử' }, after: { description: 'Diễn giải mới' } }]);
    const l = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${v.id}`, headers: { cookie }, payload: { version: e.json().version, lines: [{ lineNo: 1, description: 'Dòng 1' }] } });
    expect(l.statusCode, l.body).toBe(200);
    expect(await audits()).toHaveLength(1);
  });

  it('chứng từ nháp đã có số: không đổi loại hoặc năm tài chính (VOUCHER_NUMBER_LOCKED); đổi ngày trong cùng năm thì được', async () => {
    const v = (await create(pkt('2026-06-20', [L('6422', '11'), L('1111', '0', '11')], { autoPost: true }))).json();
    const u = (await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/unpost`, headers: { cookie } })).json();
    const put = (body: object) => ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${v.id}`, headers: { cookie }, payload: { ...body, version: u.version } });
    const lines = [L('6422', '11'), L('1111', '0', '11')];
    const type = await put({ ...pkt('2026-06-20', lines), voucherType: 'PB' });
    expect(type.statusCode).toBe(409); expect(type.json().error.code).toBe('VOUCHER_NUMBER_LOCKED');
    const year = await put(pkt('2027-01-05', lines)); // năm tài chính 2027 đã tạo ở test nhiều hệ tài khoản
    expect(year.statusCode).toBe(409); expect(year.json().error.code).toBe('VOUCHER_NUMBER_LOCKED');
    const same = await put(pkt('2026-06-25', lines));
    expect(same.statusCode, same.body).toBe(200); expect(same.json()).toMatchObject({ voucherNo: v.voucherNo, postingDate: '2026-06-25', state: 'draft' });
  });

  it('ngoại tệ: dòng thiếu amountCurrency bị 400 VALIDATION; đủ amountCurrency thì ghi sổ được và đảo chiều nguyên tệ', async () => {
    const usd = (lines: object[]) => create(pkt('2026-06-05', lines, { currencyCode: 'USD', fxRate: '25400', autoPost: true }));
    const bad = await usd([L('1111', '25400000'), L('5113', '0', '25400000')]);
    expect(bad.statusCode).toBe(400); expect(bad.json().error.code).toBe('VALIDATION');
    const ok = await usd([L('1111', '25400000', '0', { amountCurrency: '1000' }), L('5113', '0', '25400000', { amountCurrency: '-1000' })]);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().lines.map((l: { amountCurrency: string }) => l.amountCurrency)).toEqual(['1000.0000', '-1000.0000']);
    expect(ok.json().lines.map((l: { fxRate: string }) => Number(l.fxRate))).toEqual([25400, 25400]); // dòng không ghi tỷ giá lấy tỷ giá tiêu đề
    const r = await reverse(ok.json().id, '2026-06-06');
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().lines.map((l: { amountCurrency: string }) => l.amountCurrency)).toEqual(['-1000.0000', '1000.0000']);
  });

  it('ghi sổ gửi việc tính lại số dư vào hàng đợi cho worker', async () => {
    const jobs = async () => (await sql<{ n: number }>`SELECT count(*) AS n FROM pgboss.job WHERE name = 'balance.recompute' AND data->>'tenantId' = ${tenantId}`.execute(ctx.t.admin)).rows[0]!.n;
    await expect.poll(jobs, { timeout: 5000 }).toBeGreaterThan(0);
  });
  it('chứng từ 5.000 dòng tạo và ghi sổ dưới 5 giây (kiểm cân bằng một lần mỗi giao dịch)', async () => {
    const lines = Array.from({ length: 2500 }, () => [L('1111', '10'), L('5113', '0', '10')]).flat();
    const t0 = Date.now();
    const c = await create(pkt('2026-01-20', lines)); expect(c.statusCode, c.body.slice(0, 200)).toBe(201);
    const p = await post(c.json().id); expect(p.statusCode, p.body.slice(0, 200)).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher_balance_pending`.execute(ctx.t.admin)).rows[0]!.n).toBe(0);
  }, 60_000);
});
