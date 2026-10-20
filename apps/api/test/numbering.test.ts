import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Transaction } from 'kysely';
import { withTenant, type Database } from '@kt/db';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
const pkt = (date: string, amount: string, more: object = {}) => ({ voucherType: 'PKT', postingDate: date, documentDate: date, description: 'x', autoPost: true, lines: [{ accountCode: '6422', debit: amount }, { accountCode: '1111', credit: amount }], ...more });
const create = (body: object, c: string = cookie) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie: c }, payload: body });
// Giữ một giao dịch mở (khóa của nó còn nguyên) tới khi gọi release(); ready xong khi fn chạy xong.
const hold = (tenant: string, user: string, fn: (trx: Transaction<Database>) => Promise<unknown>) => {
  let release!: () => void; let ready!: () => void;
  const gate = new Promise<void>((r) => { release = r; }); const readyP = new Promise<void>((r) => { ready = r; });
  const done = withTenant(ctx.t.db, { tenantId: tenant, userId: user }, async (trx) => { await fn(trx); ready(); await gate; });
  return { release, done, ready: Promise.race([readyP, done]) };
};
const renumber2026 = (c: string) => ctx.app.inject({ method: 'POST', url: '/api/vouchers/renumber', headers: { cookie: c }, payload: { voucherType: 'PKT', fiscalYear: 2026 } });
const stillWaiting = async (p: Promise<unknown>) => (await Promise.race([p.then(() => 'done'), new Promise((r) => setTimeout(() => r('waiting'), 500))])) === 'waiting';
const addYear = (c: string, fiscalYear: number, dateFrom: string) => ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: c }, payload: { fiscalYear, dateFrom, months: 12, regime: 'TT133' } });

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `NB${Date.now()}` }));
  await addYear(cookie, 2026, '2026-01-01');
});
afterAll(async () => { await ctx.close(); });

describe('đánh số', () => {
  it('cấu hình tiền tố/hậu tố/độ dài áp dụng cho số tiếp theo; xem trước đúng', async () => {
    const u = await ctx.app.inject({ method: 'PUT', url: '/api/voucher-types/PKT', headers: { cookie }, payload: { prefix: 'PKT{YY}-', padLength: 4 } });
    expect(u.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/voucher-types/PKT/next-no?year=2026', headers: { cookie } })).json()).toEqual({ preview: 'PKT26-0001' });
    expect((await create(pkt('2026-01-05', '1'))).json().voucherNo).toBe('PKT26-0001');
  });
  it('ghi sổ thất bại không tiêu tốn số; hủy giữ số; không có lỗ hổng', async () => {
    const bad = await create({ ...pkt('2026-01-06', '1'), lines: [{ accountCode: '6422', debit: '1' }, { accountCode: '1111', credit: '2' }] });
    expect(bad.statusCode).toBe(409);
    const v2 = (await create(pkt('2026-01-07', '2'))).json(); expect(v2.voucherNo).toBe('PKT26-0002');
    await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v2.id}/unpost`, headers: { cookie } });
    await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v2.id}/discard`, headers: { cookie } });
    const v3 = (await create(pkt('2026-01-08', '3'))).json(); expect(v3.voucherNo).toBe('PKT26-0003');
    const seqs = await sql<{ seq_no: string }>`SELECT seq_no FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'PKT' AND seq_no IS NOT NULL ORDER BY seq_no`.execute(ctx.t.admin);
    expect(seqs.rows.map((r) => Number(r.seq_no))).toEqual([1, 2, 3]);
  });
  it('đánh lại số theo ngày chứng từ trong kỳ mở; bị từ chối khi có kỳ khóa', async () => {
    await create(pkt('2026-01-02', '4'));  // ngày sớm hơn nhưng số lớn hơn
    const r = await ctx.app.inject({ method: 'POST', url: '/api/vouchers/renumber', headers: { cookie }, payload: { voucherType: 'PKT', fiscalYear: 2026 } });
    expect(r.statusCode, r.body).toBe(200); expect(r.json().count).toBe(4);
    const rows = await sql<{ posting_date: string; voucher_no: string }>`SELECT posting_date, voucher_no FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'PKT' AND voucher_no IS NOT NULL ORDER BY seq_no`.execute(ctx.t.admin);
    expect(rows.rows.map((x) => x.posting_date)).toEqual(['2026-01-02', '2026-01-05', '2026-01-07', '2026-01-08']);
    expect(rows.rows[0]!.voucher_no).toBe('PKT26-0001');
    const counter = await sql<{ last_no: number }>`SELECT last_no FROM voucher_counter WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'PKT' AND fiscal_year = 2026`.execute(ctx.t.admin);
    expect(counter.rows[0]!.last_no).toBe(4);
    const audit = await sql<{ ip: string | null; before: { id: string; voucher_no: string }[]; after: { year: number; count: number; map: { id: string; old: string; new: string }[] } }>`SELECT ip, before, after FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND action = 'renumber'`.execute(ctx.t.admin);
    expect(audit.rows).toHaveLength(1); expect(audit.rows[0]!.ip).toBeTruthy();
    // Ánh xạ id -> số cũ -> số mới giữ đủ để khôi phục số gốc: chứng từ ngày 2026-01-02 đứng số 4 trước khi đánh lại, thành số 1 sau đó.
    const { before, after } = audit.rows[0]!;
    expect(after).toMatchObject({ year: 2026, count: 4 }); expect(before).toHaveLength(4); expect(after.map).toHaveLength(4);
    expect(before.map((b) => b.voucher_no).sort()).toEqual(['PKT26-0001', 'PKT26-0002', 'PKT26-0003', 'PKT26-0004']);
    const first = await sql<{ id: string }>`SELECT id FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'PKT' AND posting_date = '2026-01-02'`.execute(ctx.t.admin);
    expect(after.map.find((m) => m.id === first.rows[0]!.id)).toEqual({ id: first.rows[0]!.id, old: 'PKT26-0004', new: 'PKT26-0001' });
    expect(new Set(after.map.map((m) => m.id))).toEqual(new Set(before.map((b) => b.id)));
    await ctx.app.inject({ method: 'POST', url: '/api/periods/2026/1/lock', headers: { cookie }, payload: { level: 'soft' } });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/vouchers/renumber', headers: { cookie }, payload: { voucherType: 'PKT', fiscalYear: 2026 } })).json().error.code).toBe('RENUMBER_PERIOD_LOCKED');
  });
  it('kiểm tra trùng số', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/vouchers/check-no?type=PKT&no=PKT26-0001', headers: { cookie } });
    expect(r.json().exists).toBe(true);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/vouchers/check-no?type=PKT&no=KHONGCO', headers: { cookie } })).json().exists).toBe(false);
  });
  it('fn_format_voucher_no khớp formatVoucherNo kể cả khi số dài hơn độ dài đệm', async () => {
    const r = await sql<{ a: string; b: string }>`SELECT fn_format_voucher_no('', '/{YYYY}', 3, 1234, 2026) AS a, fn_format_voucher_no('PC{YY}/', '', 4, 12, 2026) AS b`.execute(ctx.t.admin);
    expect(r.rows[0]).toEqual({ a: '1234/2026', b: 'PC26/0012' });
  });
  it('loại chứng từ không có: 404; chưa đăng nhập: 401', async () => {
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/voucher-types/KHONGCO', headers: { cookie }, payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/voucher-types/KHONGCO/next-no?year=2026', headers: { cookie } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/voucher-types/PKT', payload: { name: 'x' } })).statusCode).toBe(401);
  });
});

describe('đánh số theo năm tài chính', () => {
  let c2: string; let t2: string; let u2: string;
  beforeAll(async () => {
    ({ cookie: c2, tenantId: t2, userId: u2 } = await bootstrapTenant(ctx, { code: `NY${Date.now()}` }));
    await addYear(c2, 2026, '2026-01-01'); await addYear(c2, 2027, '2027-01-01');
  });
  const checkNo = async (no: string, year?: number) => (await ctx.app.inject({ method: 'GET', url: `/api/vouchers/check-no?type=PKT&no=${no}${year ? `&year=${year}` : ''}`, headers: { cookie: c2 } })).json();

  it('số bắt đầu lại từ 1 mỗi năm; tiền tố mặc định không có năm vẫn không trùng', async () => {
    const a = await create(pkt('2026-03-01', '1'), c2); const b = await create(pkt('2027-03-01', '1'), c2);
    expect(a.statusCode, a.body).toBe(201); expect(b.statusCode, b.body).toBe(201);
    expect(a.json().voucherNo).toBe('PKT00001'); expect(b.json().voucherNo).toBe('PKT00001');
  });
  it('kiểm tra trùng số lọc theo năm khi có tham số year', async () => {
    await create(pkt('2026-03-02', '1'), c2);  // PKT00002 chỉ có ở 2026
    expect((await checkNo('PKT00002')).exists).toBe(true);
    expect((await checkNo('PKT00002', 2026)).exists).toBe(true);
    expect((await checkNo('PKT00002', 2027)).exists).toBe(false);
    expect((await checkNo('PKT00001', 2027)).exists).toBe(true);
  });
  it('đánh lại số chờ lượt ghi sổ đang giữ bộ đếm, không để mất số', async () => {
    const draft = (await create(pkt('2026-03-03', '1', { autoPost: false }), c2)).json();
    const h = hold(t2, u2, (trx) => sql`SELECT post_voucher(${draft.id}::uuid)`.execute(trx));  // giữ khóa bộ đếm tới khi commit
    try {
      await h.ready;
      const renum = renumber2026(c2);
      expect(await stillWaiting(renum)).toBe(true);
      h.release(); await h.done;
      const r = await renum; expect(r.statusCode, r.body).toBe(200); expect(r.json().count).toBe(3);
    } finally { h.release(); await h.done.catch(() => undefined); }
    const seqs = await sql<{ seq_no: number }>`SELECT seq_no FROM voucher WHERE tenant_id = ${t2}::uuid AND voucher_type = 'PKT' AND fiscal_year = 2026 AND seq_no IS NOT NULL ORDER BY seq_no`.execute(ctx.t.admin);
    expect(seqs.rows.map((x) => x.seq_no)).toEqual([1, 2, 3]);
    expect((await create(pkt('2026-03-04', '1'), c2)).json().voucherNo).toBe('PKT00004');
  });
  it('kỳ có khóa phần hành của loại chứng từ thì không đánh lại số', async () => {
    const mod = (modules: string[]) => ctx.app.inject({ method: 'PUT', url: '/api/periods/2026/3/modules', headers: { cookie: c2 }, payload: { modules } });
    expect((await mod(['general'])).statusCode).toBe(200);
    expect((await renumber2026(c2)).json().error.code).toBe('RENUMBER_PERIOD_LOCKED');
    expect((await mod(['cash'])).statusCode).toBe(200);  // khóa phần hành khác loại thì vẫn đánh lại được
    expect((await renumber2026(c2)).json().count).toBe(4);
    await mod([]);
  });
  it('khóa mềm kỳ đang commit song song: đánh lại số đợi rồi bị từ chối', async () => {
    const h = hold(t2, u2, (trx) => sql`SELECT lock_period(${t2}::uuid, 2026, 3, 'soft')`.execute(trx));
    try {
      await h.ready;
      const renum = renumber2026(c2);
      expect(await stillWaiting(renum)).toBe(true);
      h.release(); await h.done;
      expect((await renum).json().error.code).toBe('RENUMBER_PERIOD_LOCKED');
    } finally { h.release(); await h.done.catch(() => undefined); }
    expect((await ctx.app.inject({ method: 'POST', url: '/api/periods/2026/3/unlock', headers: { cookie: c2 } })).statusCode).toBe(200);
  });
});
