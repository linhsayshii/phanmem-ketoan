import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `VC${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code: 'KH001', name: 'Khách A', is_customer: true } });
});
afterAll(async () => { await ctx.close(); });

const pkt = (date: string, lines: object[], extra: object = {}) => ({ voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Phiếu kế toán thử', lines, ...extra });
const L = (accountCode: string, debit = '0', credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
const post = (id: string) => ctx.app.inject({ method: 'POST', url: `/api/vouchers/${id}/post`, headers: { cookie } });
const create = (body: object) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: body });

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

  it('một công ty nhiều hệ tài khoản: mã tài khoản tra theo chế độ của kỳ chứa ngày ghi sổ, kể cả chứng từ DK ở kỳ 0', async () => {
    const fy = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2027, dateFrom: '2027-01-01', months: 12, regime: 'TT200' } });
    expect(fy.statusCode, fy.body).toBe(201);
    // 31/12/2026 vừa là kỳ 12 của năm 2026 (TT133) vừa là kỳ 0 của năm 2027 (TT200); mã 1111 và 5113 có ở cả hai hệ.
    const a = await create(pkt('2026-12-31', [L('1111', '5'), L('5113', '0', '5')], { autoPost: true }));
    const b = await create({ voucherType: 'DK', postingDate: '2026-12-31', documentDate: '2026-12-31', lines: [L('1111', '7'), L('5113', '0', '7')], autoPost: true });
    // Loại PB (không phải PKT): số PKT00001 của năm 2027 sẽ trùng PKT00001 của năm 2026 vì tiền tố mặc định chưa có {YY} (thuộc Task 17).
    const c = await create({ ...pkt('2027-01-10', [L('1111', '9'), L('5113', '0', '9')], { autoPost: true }), voucherType: 'PB' });
    expect([a.statusCode, b.statusCode, c.statusCode], `${a.body} ${b.body} ${c.body}`).toEqual([201, 201, 201]);
    expect(b.json()).toMatchObject({ voucherNo: 'DK00001', state: 'posted' });
    const regimes = await Promise.all([a, b, c].map(async (r) => (await sql<{ regime: string }>`SELECT DISTINCT a.regime FROM voucher_line l JOIN account a ON a.id = l.account_id WHERE l.voucher_id = ${r.json().id}::uuid`.execute(ctx.t.admin)).rows.map((x) => x.regime)));
    expect(regimes).toEqual([['TT133'], ['TT200'], ['TT200']]);
  });

  it('quyền và khóa kỳ: bỏ ghi sổ cần voucher.edit_posted; kỳ khóa mềm chỉ ghi được khi có voucher.backdate_locked; kỳ khóa không bỏ ghi sổ được nhưng đảo được', async () => {
    const roles = (await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie } })).json() as { id: string; code: string }[];
    const kv = roles.find((r) => r.code === 'ketoan_vien')!;
    await ctx.app.inject({ method: 'PUT', url: `/api/roles/${kv.id}/permissions`, headers: { cookie }, payload: { permissions: ['voucher.view', 'voucher.create', 'voucher.post', 'voucher.unpost'] } });
    const username = `kv_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username, fullName: 'Kế toán viên', password: 'Matkhau1!', roleCode: 'ketoan_vien' } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const kvCookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
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
    const rev = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/reverse`, headers: { cookie }, payload: { postingDate: '2026-05-10' } });
    expect(rev.statusCode, rev.body).toBe(201); expect(rev.json()).toMatchObject({ state: 'posted', reversalOfId: v.id });
  });

  it('ghi sổ gửi việc tính lại số dư vào hàng đợi cho worker', async () => {
    const jobs = async () => (await sql<{ n: number }>`SELECT count(*) AS n FROM pgboss.job WHERE name = 'balance.recompute' AND data->>'tenantId' = ${tenantId}`.execute(ctx.t.admin)).rows[0]!.n;
    await expect.poll(jobs, { timeout: 5000 }).toBeGreaterThan(0);
  });
});
