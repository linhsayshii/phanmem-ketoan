import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, TEST_PASSWORD, type TestApp } from '../helpers.js';
import { runs, setupLedgerTenant, timeoutFor } from '../invariants/helpers.js';
import { runRecurring } from '../../src/modules/assistant/recurring.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
let ctx: TestApp; let owner: string; let tenantId: string; let n = 0;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, c = owner) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const line = (accountCode: string, debit: string, credit: string, extra: object = {}) => ({ accountCode, debit, credit, ...extra });
const template = (code: string, o: Json = {}) => ({
  code, name: `Mẫu ${code}`, frequency: 'monthly', dayOfMonth: 31, startDate: '2026-01-01', catchUp: true, description: 'Phân bổ {THANG}/{NAM}',
  lines: [line('6422', '1000000', '0'), line('1111', '0', '1000000')], ...o,
});
const create = async (code: string, o: Json = {}) => { const r = await call('POST', '/api/recurring-entries', template(code, o)); expect(r.statusCode, r.body).toBe(201); return r.json() as Json; };
const run = async (body: Json) => { const r = await call('POST', '/api/recurring-entries/run', body); expect(r.statusCode, r.body).toBe(200); return r.json() as Json; };
const vouchersOf = async (entryId: string) => (await sql<{ id: string; state: string; posting_date: string; description: string; source_doc_type: string; created_by: string; debit: string; credit: string; n: number }>`
  SELECT v.id, v.state, v.posting_date::text, v.description, v.source_doc_type, v.created_by::text, sum(l.debit)::text AS debit, sum(l.credit)::text AS credit, count(*)::int AS n
  FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id WHERE v.source_doc_id = ${entryId}::uuid GROUP BY v.id ORDER BY v.posting_date`.execute(ctx.t.admin)).rows;
async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `rc_${roleCode}_${n++}_${Date.now()}`;
  expect((await call('POST', '/api/users', { username, fullName: 'X', password: TEST_PASSWORD, roleCode, sensitiveFlags })).statusCode).toBe(201);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}

beforeAll(async () => { ctx = await createTestApp(); ({ cookie: owner, tenantId } = await setupLedgerTenant(ctx, `RC${Date.now()}`, 'TT133')); }, 180_000);
afterAll(async () => { await ctx.close(); });

describe('mẫu bút toán định kỳ: lập và kiểm tra', () => {
  it('lập mẫu hợp lệ; mã trùng 409; không đổi mã khi sửa', async () => {
    const e = await create('KH-VP');
    expect(e).toMatchObject({ code: 'KH-VP', status: 'active', autoPost: false, lines: [{ accountCode: '6422', debit: '1000000' }, { accountCode: '1111', credit: '1000000' }] });
    expect((await call('POST', '/api/recurring-entries', template('KH-VP'))).json().error.code).toBe('RECURRING_CODE_TAKEN');
    expect((await call('PUT', `/api/recurring-entries/${e.id}`, template('KH-KHAC'))).json().error.code).toBe('RECURRING_CODE_LOCKED');
    const up = await call('PUT', `/api/recurring-entries/${e.id}`, template('KH-VP', { name: 'Đổi tên', lines: [line('6422', '2', '0'), line('1111', '0', '2')] }));
    expect(up.json()).toMatchObject({ name: 'Đổi tên', lines: [{ debit: '2' }, { credit: '2' }] });
  });
  it.each([
    ['lệch Nợ/Có', { lines: [line('6422', '1000', '0'), line('1111', '0', '999')] }, 'RECURRING_UNBALANCED'],
    ['công thức sai cú pháp', { lines: [line('6422', '1000 *', '0'), line('1111', '0', '1000')] }, 'RECURRING_FORMULA'],
    ['chia cho 0', { lines: [line('6422', '1 / 0', '0'), line('1111', '0', '1')] }, 'RECURRING_FORMULA'],
    ['số vượt 16 chữ số', { lines: [line('6422', '10000000000000000', '0'), line('1111', '0', '10000000000000000')] }, 'RECURRING_FORMULA'],
    ['công thức chỉ cân một số tháng', { lines: [line('6422', 'THANG * 1000', '0'), line('1111', '0', '5000')] }, 'RECURRING_UNBALANCED'],
    ['tài khoản không có', { lines: [line('6422', '1', '0'), line('9999', '0', '1')] }, 'RECURRING_ACCOUNT_INVALID'],
    ['tài khoản tổng hợp', { lines: [line('642', '1', '0'), line('1111', '0', '1')] }, 'RECURRING_ACCOUNT_INVALID'],
    ['một dòng có cả Nợ và Có', { lines: [line('6422', '5', '5'), line('1111', '0', '0')] }, 'RECURRING_LINE_BOTH_SIDES'],
  ])('từ chối %s', async (_n, o, code) => {
    const r = await call('POST', '/api/recurring-entries', template(`E${n++}`, o));
    expect(r.statusCode).toBe(400); expect(r.json().error.code).toBe(code);
  });
  it('thân sai: thiếu dòng, ngày > 31, ngày kết thúc trước ngày bắt đầu', async () => {
    expect((await call('POST', '/api/recurring-entries', template(`E${n++}`, { lines: [line('6422', '1', '0')] }))).statusCode).toBe(400);
    expect((await call('POST', '/api/recurring-entries', template(`E${n++}`, { dayOfMonth: 32 }))).statusCode).toBe(400);
    expect((await call('POST', '/api/recurring-entries', template(`E${n++}`, { endDate: '2025-12-31' }))).json().error.code).toBe('VALIDATION');
  });
  it('quyền: xem cần recurring.view; lập cần recurring.manage; chỉ xem thì không chạy', async () => {
    const viewer = await userWith('xem', []);
    expect((await call('GET', '/api/recurring-entries', undefined, viewer)).statusCode).toBe(200);
    expect((await call('POST', '/api/recurring-entries', template(`E${n++}`), viewer)).statusCode).toBe(403);
    expect((await call('POST', '/api/recurring-entries/run', {}, viewer)).statusCode).toBe(403);
    expect((await call('GET', '/api/recurring-entries', undefined, '')).statusCode).toBe(401);
  });
  it('autoPost cần quyền voucher.post của người lập mẫu', async () => {
    const nopost = await userWith('ketoan_vien', []);
    // gỡ voucher.post khỏi kế toán viên của công ty này
    await sql`DELETE FROM role_permission WHERE tenant_id = ${tenantId}::uuid AND permission_code = 'voucher.post' AND role_id = (SELECT id FROM role WHERE tenant_id = ${tenantId}::uuid AND code = 'ketoan_vien')`.execute(ctx.t.admin);
    const r = await call('POST', '/api/recurring-entries', template(`E${n++}`, { autoPost: true }), nopost);
    expect(r.statusCode).toBe(403);
    expect((await call('POST', '/api/recurring-entries', template(`E${n++}`), nopost)).statusCode).toBe(201);
  });
});

describe('chạy bút toán định kỳ', () => {
  it('sinh chứng từ NHÁP theo kỳ đến hạn, có nguồn, người lập, công thức theo tháng; chạy lại không sinh trùng', async () => {
    // Nợ 6422 / Có 1111 = MAX(1.000.000; 300.000 × số ngày): tháng 2 (28 ngày) = 8.400.000; ngày 31 cắt về cuối tháng.
    const e = await create('CT-CT', { lines: [line('6422', 'MAX(1000000, 300000 * SO_NGAY)', '0'), line('1111', '0', 'MAX(1000000, 300000 * SO_NGAY)')] });
    const dry = await run({ upTo: '2026-03-31', entryId: e.id, dryRun: true });
    expect(dry.items.map((i: Json) => [i.periodKey, i.status])).toEqual([['2026-01', 'planned'], ['2026-02', 'planned'], ['2026-03', 'planned']]);
    expect(await vouchersOf(e.id)).toHaveLength(0);

    const r = await run({ upTo: '2026-03-31', entryId: e.id });
    expect(r).toMatchObject({ created: 3, skipped: 0, errors: 0 });
    const vs = await vouchersOf(e.id);
    expect(vs.map((v) => [v.posting_date, v.state, v.debit, v.credit, v.description, v.source_doc_type])).toEqual([
      ['2026-01-31', 'draft', '9300000', '9300000', 'Phân bổ 01/2026', 'recurring_entry'],
      ['2026-02-28', 'draft', '8400000', '8400000', 'Phân bổ 02/2026', 'recurring_entry'],
      ['2026-03-31', 'draft', '9300000', '9300000', 'Phân bổ 03/2026', 'recurring_entry'],
    ]);
    const again = await run({ upTo: '2026-03-31', entryId: e.id });
    expect(again).toMatchObject({ created: 0 }); expect(again.items.map((i: Json) => i.status)).toEqual(['exists', 'exists', 'exists']);
    expect(await vouchersOf(e.id)).toHaveLength(3);
    // chạy tiếp tới tháng sau: chỉ sinh thêm kỳ mới
    expect((await run({ upTo: '2026-04-30', entryId: e.id })).created).toBe(1);
    expect(await vouchersOf(e.id)).toHaveLength(4);
    // chứng từ nháp là chứng từ thật: sửa được, ghi sổ được bằng đường chung
    const post = await call('POST', `/api/vouchers/${vs[0]!.id}/post`);
    expect(post.statusCode, post.body).toBe(200); expect(post.json().state).toBe('posted'); expect(post.json().voucherNo).toBeTruthy();
    const runs1 = (await call('GET', `/api/recurring-runs?entryId=${e.id}`)).json() as Json[];
    expect(runs1).toHaveLength(4); expect(runs1[0]).toMatchObject({ status: 'created', entryCode: 'CT-CT' });
  });
  it('hai lần chạy đồng thời không sinh trùng', async () => {
    const e = await create('CT-SS');
    const rs = await Promise.all([run({ upTo: '2026-02-28', entryId: e.id }), run({ upTo: '2026-02-28', entryId: e.id }), run({ upTo: '2026-02-28', entryId: e.id })]);
    expect(rs.reduce((a, r) => a + r.created, 0)).toBe(2);
    expect(await vouchersOf(e.id)).toHaveLength(2);
  });
  it('kỳ khóa sổ: bỏ qua kèm lý do, không tạo chứng từ; mở khóa rồi chạy lại thì sinh', async () => {
    const e = await create('CT-KHOA');
    expect((await call('POST', '/api/periods/2026/1/lock', { level: 'soft' })).statusCode).toBe(200);
    const r = await run({ upTo: '2026-02-28', entryId: e.id });
    expect(r).toMatchObject({ created: 1, skipped: 1 });
    expect(r.items[0]).toMatchObject({ periodKey: '2026-01', status: 'skipped', reasonCode: 'PERIOD_LOCKED' });
    expect(r.items[0].message).toContain('đã khóa sổ');
    expect((await vouchersOf(e.id)).map((v) => v.posting_date)).toEqual(['2026-02-28']);
    expect(((await call('GET', `/api/recurring-runs?entryId=${e.id}&status=skipped`)).json() as Json[])[0]).toMatchObject({ periodKey: '2026-01', reasonCode: 'PERIOD_LOCKED' });
    expect((await call('POST', '/api/periods/2026/1/unlock')).statusCode).toBe(200);
    expect(await run({ upTo: '2026-02-28', entryId: e.id })).toMatchObject({ created: 1 });
    expect((await vouchersOf(e.id)).map((v) => v.posting_date)).toEqual(['2026-01-31', '2026-02-28']);
    expect((await call('GET', `/api/recurring-runs?entryId=${e.id}&status=skipped`)).json()).toEqual([]);
  });
  it('worker (app_user, không người dùng): kỳ chưa có trong năm tài chính bị bỏ qua, kỳ bỏ qua không chặn kỳ khác', async () => {
    const a = await create('CT-W1', { startDate: '2026-12-01', catchUp: true });
    const r = await runRecurring(ctx.t.db, tenantId, { trigger: 'worker', upTo: '2027-01-31', entryId: a.id });
    expect(r.map((i) => [i.periodKey, i.status, i.reasonCode])).toEqual([['2026-12', 'created', undefined], ['2027-01', 'skipped', 'PERIOD_NOT_FOUND']]);
    expect((await vouchersOf(a.id))[0]).toMatchObject({ created_by: expect.any(String), state: 'draft' });
    // Worker (app_user) tìm công ty có mẫu đang chạy qua hàm SECURITY DEFINER, không đọc được bảng của công ty khác.
    expect((await sql<{ tenant_id: string }>`SELECT tenant_id FROM fn_recurring_tenants()`.execute(ctx.t.db)).rows.map((r) => r.tenant_id)).toContain(tenantId);
  });
  it('mẫu tạm dừng hoặc kết thúc không chạy; mẫu có chứng từ không xóa được, mẫu chưa chạy xóa được', async () => {
    const e = await create('CT-DUNG');
    expect((await call('POST', `/api/recurring-entries/${e.id}/status`, { status: 'paused' })).json().status).toBe('paused');
    const r = await call('POST', '/api/recurring-entries/run', { entryId: e.id, upTo: '2026-01-31' });
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('RECURRING_NOT_ACTIVE');
    await call('POST', `/api/recurring-entries/${e.id}/status`, { status: 'active' });
    await run({ entryId: e.id, upTo: '2026-01-31' });
    expect((await call('DELETE', `/api/recurring-entries/${e.id}`)).json().error.code).toBe('RECURRING_HAS_RUNS');
    const fresh = await create('CT-XOA');
    expect((await call('DELETE', `/api/recurring-entries/${fresh.id}`)).statusCode).toBe(204);
    expect((await call('GET', `/api/recurring-entries/${fresh.id}`)).statusCode).toBe(404);
  });
  it('chạy trước tối đa 45 ngày; ngày sai 400', async () => {
    expect((await call('POST', '/api/recurring-entries/run', { upTo: '2099-01-01' })).json().error.code).toBe('RECURRING_RUN_AHEAD');
    expect((await call('POST', '/api/recurring-entries/run', { upTo: '31/01/2026' })).statusCode).toBe(400);
  });
  it('tự ghi sổ chỉ khi mẫu cấu hình rõ: chứng từ sinh ra đã ghi sổ và có số', async () => {
    const e = await create('CT-GS', { autoPost: true, startDate: '2026-05-01' });
    expect((await run({ entryId: e.id, upTo: '2026-05-31' })).created).toBe(1);
    const [v] = await vouchersOf(e.id);
    expect(v!.state).toBe('posted');
    const no = await sql<{ voucher_no: string }>`SELECT voucher_no FROM voucher WHERE id = ${v!.id}::uuid`.execute(ctx.t.admin);
    expect(no.rows[0]!.voucher_no).toBeTruthy();
  });
  it('lỗi dữ liệu của một kỳ (đối tượng không có) ghi trạng thái error, không chặn mẫu khác, thử lại được sau khi sửa', async () => {
    const bad = await create('CT-LOI', { startDate: '2026-06-01', lines: [line('6422', '100', '0', { partyCode: 'KHONGCO' }), line('1111', '0', '100')] });
    const good = await create('CT-TOT', { startDate: '2026-06-01' });
    const r = await run({ upTo: '2026-06-30' });
    const mine = r.items.filter((i: Json) => [bad.id, good.id].includes(i.entryId));
    expect(mine.map((i: Json) => [i.entryCode, i.status, i.reasonCode])).toEqual([['CT-LOI', 'error', 'LOOKUP_NOT_FOUND'], ['CT-TOT', 'created', undefined]]);
    expect(await vouchersOf(bad.id)).toHaveLength(0);
    await call('PUT', `/api/recurring-entries/${bad.id}`, template('CT-LOI', { startDate: '2026-06-01', lines: [line('6422', '100', '0', { partyCode: 'KH001' }), line('1111', '0', '100')] }));
    expect((await run({ upTo: '2026-06-30', entryId: bad.id })).created).toBe(1);
    expect(((await call('GET', `/api/recurring-runs?entryId=${bad.id}`)).json() as Json[]).map((x) => x.status)).toEqual(['created']);
  });
  it('mẫu có tài khoản lương/giá vốn: thiếu cờ nhạy cảm thì không lập, không xem, không chạy', async () => {
    const e = await create('CT-632', { startDate: '2026-07-01', lines: [line('632', '500', '0'), line('1111', '0', '500')] });
    const noCost = await userWith('ketoan_truong', []);
    expect((await call('POST', '/api/recurring-entries', template('CT-632B', { lines: [line('632', '500', '0'), line('1111', '0', '500')] }), noCost)).statusCode).toBe(403);
    expect((await call('GET', `/api/recurring-entries/${e.id}`, undefined, noCost)).statusCode).toBe(403);
    expect((await call('PUT', `/api/recurring-entries/${e.id}`, template('CT-632'), noCost)).statusCode).toBe(403);
    const r = await call('POST', '/api/recurring-entries/run', { entryId: e.id, upTo: '2026-07-31' }, noCost);
    expect(r.json().items[0]).toMatchObject({ status: 'skipped', reasonCode: 'SENSITIVE_DENIED' });
    expect(await vouchersOf(e.id)).toHaveLength(0);
    const list = (await call('GET', '/api/recurring-entries', undefined, noCost)).json() as Json[];
    expect(list.every((x) => x.lines.length === 0)).toBe(true); // danh sách không trả dòng
    expect((await call('POST', '/api/recurring-entries/run', { entryId: e.id, upTo: '2026-07-31' })).json().created).toBe(1); // đủ cờ thì chạy
  });
});

describe('bất biến: chứng từ định kỳ không bao giờ lệch Nợ/Có', () => {
  it('mẫu cân sinh chứng từ cân bằng đúng số; mẫu lệch bị từ chối từ lúc lập (decimal.js, biên 16 chữ số)', async () => {
    const acct = fc.constantFrom('6422', '242', '5113', '33311');
    const amount = fc.oneof(fc.bigInt({ min: 1n, max: 2_400_000_000_000_000n }), fc.integer({ min: 1, max: 1_000_000 }).map(BigInt), fc.constantFrom(1n, 2_400_000_000_000_000n));
    const arb = fc.record({
      side: fc.boolean(), parts: fc.array(fc.tuple(acct, amount), { minLength: 1, maxLength: 4 }), useFormula: fc.boolean(), skew: fc.constantFrom(0n, 0n, 1n), cash: fc.constantFrom('1111', '1121'),
    });
    let executed = 0;
    await fc.assert(fc.asyncProperty(arb, async ({ side, parts, useFormula, skew, cash }) => {
      // Tổng các dòng một bên; dòng đối ứng ở tiền. Công thức: nhân với THANG rồi chia THANG (kết quả giữ nguyên số) để chạy bộ tính công thức.
      const total = parts.reduce((a, [, x]) => a + x, 0n);
      executed++;
      const f = (x: bigint) => (useFormula ? `${x} * THANG / THANG` : String(x));
      const lines = [...parts.map(([a, x]) => (side ? line(a, f(x), '0') : line(a, '0', f(x)))), side ? line(cash, '0', f(total + skew)) : line(cash, f(total + skew), '0')];
      const code = `P${n++}`;
      const r = await call('POST', '/api/recurring-entries', template(code, { lines, startDate: '2026-02-01' }));
      if (skew !== 0n) { expect(r.statusCode).toBe(400); expect(r.json().error.code).toBe('RECURRING_UNBALANCED'); return; }
      expect(r.statusCode, r.body).toBe(201);
      const e = r.json() as Json;
      expect((await run({ entryId: e.id, upTo: '2026-03-31' })).created).toBe(2);
      for (const v of await vouchersOf(e.id)) { expect(v.debit).toBe(v.credit); expect(v.debit).toBe(total.toString()); expect(v.state).toBe('draft'); }
    }), { numRuns: runs(12) });
    expect(executed).toBeGreaterThanOrEqual(12);
  }, timeoutFor(300_000));
  it('biên: một dòng đúng 9.999.999.999.999.999 đồng sinh được; công thức nhân ra 10^16 bị từ chối khi lập', async () => {
    const max = '9999999999999999';
    const e = await create('BIEN-MAX', { startDate: '2026-02-01', lines: [line('6422', max, '0'), line('1111', '0', max)] });
    expect((await run({ entryId: e.id, upTo: '2026-02-28' })).created).toBe(1);
    expect((await vouchersOf(e.id))[0]).toMatchObject({ debit: max, credit: max });
    const r = await call('POST', '/api/recurring-entries', template('BIEN-QUA', { lines: [line('6422', '9999999999999999 + 1', '0'), line('1111', '0', '10000000000000000')] }));
    expect(r.json().error.code).toBe('RECURRING_FORMULA');
  });
});
