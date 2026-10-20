import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import pg from 'pg';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
const pkt = (date: string, amount: string) => ({ voucherType: 'PKT', postingDate: date, documentDate: date, description: 'x', autoPost: true, lines: [{ accountCode: '6422', debit: amount }, { accountCode: '1111', credit: amount }] });
const create = (body: object, c: string = cookie) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie: c }, payload: body });
const lock = (no: number, level: string, c: string = cookie) => ctx.app.inject({ method: 'POST', url: `/api/periods/2026/${no}/lock`, headers: { cookie: c }, payload: { level } });
const newYear = (c: string) => ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: c }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `PR${Date.now()}` }));
  await newYear(cookie);
});
afterAll(async () => { await ctx.close(); });

describe('khóa kỳ', () => {
  it('khóa mềm: ghi sổ bị chặn trừ khi có quyền ghi lùi; bỏ khóa mềm mở lại', async () => {
    await create(pkt('2026-01-10', '100'));
    expect((await lock(1, 'soft')).statusCode).toBe(200);
    // admin có voucher.backdate_locked nên vẫn ghi được; tạo người dùng kế toán viên để kiểm tra bị chặn
    const username = `kt_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username, fullName: 'KT', password: 'Matkhau1!', roleCode: 'ketoan_vien' } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const ktCookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    const blocked = await create(pkt('2026-01-20', '5'), ktCookie);
    expect(blocked.json().error.code).toBe('PERIOD_SOFT_LOCKED');
    expect((await create(pkt('2026-01-21', '6'))).statusCode).toBe(201);
    const unpost = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${(await create(pkt('2026-01-22', '7'))).json().id}/unpost`, headers: { cookie } });
    expect(unpost.json().error.code).toBe('UNPOST_PERIOD_NOT_OPEN');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/periods/2026/1/unlock', headers: { cookie } })).statusCode).toBe(200);
    expect((await create(pkt('2026-01-20', '5'), ktCookie)).statusCode).toBe(201);
  });

  it('khóa phần hành chặn đúng loại chứng từ', async () => {
    await ctx.app.inject({ method: 'PUT', url: '/api/periods/2026/2/modules', headers: { cookie }, payload: { modules: ['general'] } });
    expect((await create(pkt('2026-02-05', '1'))).json().error.code).toBe('PERIOD_MODULE_LOCKED');
    await ctx.app.inject({ method: 'PUT', url: '/api/periods/2026/2/modules', headers: { cookie }, payload: { modules: [] } });
    expect((await create(pkt('2026-02-05', '1'))).statusCode).toBe(201);
  });

  it('khóa cứng: cần kỳ trước đã khóa cứng, không còn nháp; tính hash; verify đúng; sửa bằng SQL bị phát hiện; mọi ghi vào kỳ bị từ chối kể cả đảo', async () => {
    expect((await lock(2, 'hard')).json().error.code).toBe('PERIOD_PREV_NOT_HARD_LOCKED');
    const draft = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { ...pkt('2026-01-25', '3'), autoPost: false } });
    expect((await lock(0, 'hard')).statusCode).toBe(200);
    expect((await lock(1, 'hard')).json().error.code).toBe('PERIOD_HAS_DRAFTS');
    await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${draft.json().id}/post`, headers: { cookie } });
    expect((await lock(1, 'hard')).statusCode).toBe(200);
    const periods = (await ctx.app.inject({ method: 'GET', url: '/api/periods?year=2026', headers: { cookie } })).json() as { periodNo: number; status: string; hashTail: string | null }[];
    expect(periods.find((p) => p.periodNo === 1)).toMatchObject({ status: 'hard_locked' }); expect(periods.find((p) => p.periodNo === 1)!.hashTail).toMatch(/^[0-9a-f]{64}$/);
    const hashes = await sql<{ row_hash: Buffer | null; prev_hash: Buffer | null }>`SELECT row_hash, prev_hash FROM voucher WHERE tenant_id = ${tenantId}::uuid AND period_no = 1 AND state <> 'draft'`.execute(ctx.t.admin);
    expect(hashes.rows.length).toBeGreaterThan(0); expect(hashes.rows.every((h) => h.row_hash && h.prev_hash)).toBe(true);
    let verify = await ctx.app.inject({ method: 'GET', url: '/api/periods/2026/1/verify-hash', headers: { cookie } });
    expect(verify.json()).toMatchObject({ mismatched: [] }); expect(verify.json().total).toBeGreaterThan(0);
    // giả lập can thiệp trực tiếp bằng owner DB (bỏ qua trigger)
    await sql`ALTER TABLE voucher DISABLE TRIGGER trg_voucher_before`.execute(ctx.t.admin);
    await sql`UPDATE voucher SET description = 'bị sửa' WHERE tenant_id = ${tenantId}::uuid AND period_no = 1 AND state = 'posted'`.execute(ctx.t.admin);
    await sql`ALTER TABLE voucher ENABLE TRIGGER trg_voucher_before`.execute(ctx.t.admin);
    verify = await ctx.app.inject({ method: 'GET', url: '/api/periods/2026/1/verify-hash', headers: { cookie } });
    expect(verify.json().mismatched.length).toBeGreaterThan(0);
    const posted = (await ctx.app.inject({ method: 'GET', url: '/api/vouchers?from=2026-01-01&to=2026-01-31&state=posted', headers: { cookie } })).json().rows[0];
    expect((await create(pkt('2026-01-28', '1'))).json().error.code).toBe('PERIOD_HARD_LOCKED');
    expect((await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${posted.id}/reverse`, headers: { cookie }, payload: { postingDate: '2026-01-31' } })).json().error.code).toBe('PERIOD_HARD_LOCKED');
    expect((await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${posted.id}/unpost`, headers: { cookie } })).json().error.code).toBe('VOUCHER_HASHED');
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${posted.id}`, headers: { cookie }, payload: { version: 99, description: 'x' } })).statusCode).toBe(409);
    // Đảo sang kỳ mở cũng bị từ chối vì phải đổi trạng thái chứng từ gốc đang nằm trong kỳ khóa cứng (bất biến 6).
    expect((await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${posted.id}/reverse`, headers: { cookie }, payload: { postingDate: '2026-02-10' } })).json().error.code).toBe('PERIOD_HARD_LOCKED');
  });

  it('bỏ khóa cứng cần quyền riêng, xóa hash của kỳ và không được khi kỳ sau đã khóa cứng', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/periods/2026/0/unlock', headers: { cookie } });
    expect(r.json().error.code).toBe('PERIOD_LATER_HARD_LOCKED');
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/periods/2026/1/unlock', headers: { cookie } });
    expect(ok.statusCode).toBe(200); expect(ok.json().status).toBe('soft_locked');
    const hashes = await sql<{ n: number }>`SELECT count(*) AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND period_no = 1 AND row_hash IS NOT NULL`.execute(ctx.t.admin);
    expect(hashes.rows[0]!.n).toBe(0);
    // Kỳ 1 giờ khóa mềm: đảo chứng từ gốc sang kỳ 2 đang mở được phép (đường "chứng từ đảo + chứng từ mới" của mục 7.1).
    const posted = (await ctx.app.inject({ method: 'GET', url: '/api/vouchers?from=2026-01-01&to=2026-01-31&state=posted', headers: { cookie } })).json().rows[0];
    const rev = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${posted.id}/reverse`, headers: { cookie }, payload: { postingDate: '2026-02-10' } });
    expect(rev.statusCode, rev.body).toBe(201);
  });
});

describe('hash chuỗi: múi giờ phiên và đua với khóa cứng', () => {
  let c: string; let tid: string; let uid: string; let draftId: string; let postedId: string;
  beforeAll(async () => {
    ({ cookie: c, tenantId: tid, userId: uid } = await bootstrapTenant(ctx, { code: `PH${Date.now()}` }));
    await newYear(c);
    expect((await create(pkt('2026-01-15', '10'), c)).statusCode).toBe(201);
    draftId = (await create({ ...pkt('2026-02-10', '20'), autoPost: false }, c)).json().id;
    postedId = (await create(pkt('2026-03-10', '30'), c)).json().id;
    expect((await lock(0, 'hard', c)).statusCode).toBe(200);
    expect((await lock(1, 'hard', c)).statusCode).toBe(200);
  });

  it('kiểm tra hash không phụ thuộc múi giờ và DateStyle của phiên', async () => {
    const rows = await ctx.t.admin.transaction().execute(async (trx) => {
      await sql`SET LOCAL TimeZone = 'Pacific/Kiritimati'`.execute(trx);
      await sql`SET LOCAL DateStyle = 'SQL, DMY'`.execute(trx);
      return (await sql<{ ok: boolean }>`SELECT ok FROM verify_period_hash(${tid}::uuid, 2026, 1)`.execute(trx)).rows;
    });
    expect(rows.length).toBeGreaterThan(0); expect(rows.every((r) => r.ok)).toBe(true);
  });

  it('chỉ kiểm tra được kỳ đã khóa cứng', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/periods/2026/2/verify-hash', headers: { cookie: c } });
    expect(r.json().error.code).toBe('PERIOD_STATE_INVALID');
  });

  // Hai phiên thật (app_user, có RLS): A sửa và chưa commit, B khóa cứng cùng kỳ. B phải đợi A (khóa chia sẻ trên kỳ) rồi tính hash trên dữ liệu A đã commit.
  async function race(periodNo: number, work: (a: pg.Client) => Promise<unknown>) {
    const open = async () => {
      const cl = new pg.Client({ connectionString: process.env.DATABASE_URL }); await cl.connect(); await cl.query('BEGIN');
      await cl.query(`SELECT set_config('app.current_tenant', $1, true), set_config('app.current_user', $2, true)`, [tid, uid]);
      return cl;
    };
    const a = await open(); const b = await open();
    try {
      await work(a);
      const pid = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      let done = false;
      const locked = b.query('SELECT lock_period($1::uuid, 2026, $2, $3)', [tid, periodNo, 'hard']).then(() => null, (e: Error) => e).finally(() => { done = true; });
      let waiting = false;
      for (let i = 0; i < 100 && !waiting && !done; i++) {
        waiting = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'`.execute(ctx.t.admin)).rows[0]!.n === 1;
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      await a.query('COMMIT');
      const err = await locked;
      await b.query(err ? 'ROLLBACK' : 'COMMIT');
      return { waiting, err };
    } finally { await a.end(); await b.end(); }
  }
  const afterRace = async (periodNo: number, voucherId: string, err: Error | null) => {
    const status = (await sql<{ status: string }>`SELECT status FROM fiscal_period WHERE tenant_id = ${tid}::uuid AND fiscal_year = 2026 AND period_no = ${periodNo}`.execute(ctx.t.admin)).rows[0]!.status;
    if (err) { expect(status).not.toBe('hard_locked'); return; } // B báo lỗi thì kỳ chưa bị khóa cứng: vẫn nhất quán
    expect(status).toBe('hard_locked');
    const v = (await sql<{ row_hash: Buffer | null }>`SELECT row_hash FROM voucher WHERE id = ${voucherId}::uuid`.execute(ctx.t.admin)).rows[0]!;
    expect(v.row_hash).not.toBeNull(); // chứng từ của A nằm trong chuỗi hash
    const verify = (await ctx.app.inject({ method: 'GET', url: `/api/periods/2026/${periodNo}/verify-hash`, headers: { cookie: c } })).json();
    expect(verify.mismatched).toEqual([]); expect(verify.total).toBeGreaterThan(0);
  };

  it('ghi sổ chưa commit chặn khóa cứng cùng kỳ cho tới khi commit; hash gồm chứng từ đó', async () => {
    const r = await race(2, (a) => a.query('SELECT post_voucher($1::uuid)', [draftId]));
    expect(r.waiting).toBe(true);
    await afterRace(2, draftId, r.err);
  });

  it('sửa diễn giải dòng chứng từ đã ghi sổ chưa commit chặn khóa cứng; hash gồm diễn giải mới', async () => {
    const r = await race(3, (a) => a.query(`UPDATE voucher_line SET description = 'sửa lúc khóa' WHERE voucher_id = $1::uuid`, [postedId]));
    expect(r.waiting).toBe(true);
    await afterRace(3, postedId, r.err);
  });
});
