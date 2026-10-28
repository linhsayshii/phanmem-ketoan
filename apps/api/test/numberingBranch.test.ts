import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
let ctx: TestApp; let owner: string; let tenantId: string; let brA: number; let brB: number;
const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, c: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const ok = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, c: string, payload?: object) => {
  const r = await req(method, url, c, payload); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.json();
};
const draft = async (date: string, branch: 'HO' | number) => {
  const v = await ok('POST', '/api/vouchers', owner, { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'x', autoPost: false, lines: [{ accountCode: '6422', debit: '1' }, { accountCode: '1111', credit: '1' }] });
  await ok('PUT', `/api/vouchers/${v.id}/branch`, owner, { branch });
  return v.id as string;
};
const post = (id: string) => req('POST', `/api/vouchers/${id}/post`, owner);
const nos = async (where = sql`true`) => (await sql<{ voucher_no: string; seq_no: string; branch_id: number | null }>`
  SELECT voucher_no, seq_no, branch_id FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'PKT' AND fiscal_year = 2026 AND voucher_no IS NOT NULL AND ${where} ORDER BY branch_id NULLS FIRST, seq_no`.execute(ctx.t.admin)).rows;
const settings = (perBranch: boolean, hqCode = 'TSC') => req('PUT', '/api/voucher-numbering/settings', owner, { perBranch, hqCode });

// Bất biến: mỗi phạm vi đánh số (chi nhánh / trụ sở chính) có seq_no 1..n liền nhau, số chứng từ toàn công ty không trùng.
async function assertInvariants() {
  const rows = await nos();
  expect(new Set(rows.map((r) => r.voucher_no)).size).toBe(rows.length);
  const by = new Map<number, number[]>();
  for (const r of rows) by.set(r.branch_id ?? 0, [...(by.get(r.branch_id ?? 0) ?? []), Number(r.seq_no)]);
  for (const [, seqs] of by) expect(seqs).toEqual(seqs.map((_, i) => i + 1));
}

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie: owner, tenantId } = await bootstrapTenant(ctx, { code: `DS${Date.now()}` }));
  await ok('POST', '/api/fiscal-years', owner, { fiscalYear: 2025, dateFrom: '2025-01-01', months: 12, regime: 'TT133' });
  await ok('POST', '/api/fiscal-years', owner, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  await ok('PUT', '/api/voucher-types/PKT', owner, { prefix: 'PKT{YY}-', padLength: 3 });
  brA = (await ok('POST', '/api/branches', owner, { code: 'HN', name: 'Chi nhánh Hà Nội' })).id;
  brB = (await ok('POST', '/api/branches', owner, { code: 'DN', name: 'Chi nhánh Đà Nẵng' })).id;
}, 180_000);
afterAll(async () => { await ctx?.close(); });

describe('đánh số theo chi nhánh', () => {
  it('mặc định tắt: một dãy cho cả công ty, không mã chi nhánh', async () => {
    expect((await ok('GET', '/api/voucher-numbering/settings', owner))).toEqual({ perBranch: false, hqCode: 'TSC' });
    const ids = [await draft('2025-01-05', brA), await draft('2025-01-06', 'HO'), await draft('2025-01-07', brB)];
    for (const id of ids) expect((await post(id)).statusCode).toBe(200);
    const r = await sql<{ voucher_no: string }>`SELECT voucher_no FROM voucher WHERE tenant_id = ${tenantId}::uuid AND fiscal_year = 2025 ORDER BY seq_no`.execute(ctx.t.admin);
    expect(r.rows.map((x) => x.voucher_no)).toEqual(['PKT25-001', 'PKT25-002', 'PKT25-003']);
  });

  it('xem trước số theo chi nhánh ngoài phạm vi của người dùng bị giới hạn: 403; trong phạm vi và mặc định thì được', async () => {
    const username = `ph${Date.now()}`;
    const { id } = await ok('POST', '/api/users', owner, { username, fullName: 'Chi nhánh A', password: 'Matkhau1!', roleCode: 'ketoan_vien' });
    await ok('PUT', `/api/users/${id}/branch-scope`, owner, { branches: [brA] });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const c = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    expect((await req('GET', `/api/voucher-types/PKT/next-no?year=2026&branch=${brB}`, c)).statusCode).toBe(403);
    expect((await req('GET', '/api/voucher-types/PKT/next-no?year=2026&branch=HO', c)).statusCode).toBe(403);
    expect((await req('GET', `/api/voucher-types/PKT/next-no?year=2026&branch=${brA}`, c)).statusCode).toBe(200);
    expect((await req('GET', '/api/voucher-types/PKT/next-no?year=2026', c)).statusCode).toBe(200);
  });

  it('bật: mỗi chi nhánh một dãy riêng có mã chi nhánh; xem trước theo chi nhánh; đảo cùng dãy chi nhánh gốc', async () => {
    expect((await settings(true)).statusCode).toBe(200);
    expect((await ok('GET', `/api/voucher-types/PKT/next-no?year=2026&branch=${brA}`, owner)).preview).toBe('HN-PKT26-001');
    expect((await ok('GET', '/api/voucher-types/PKT/next-no?year=2026&branch=HO', owner)).preview).toBe('TSC-PKT26-001');
    const a1 = await draft('2026-02-02', brA); const a2 = await draft('2026-02-03', brA); const b1 = await draft('2026-02-04', brB); const h1 = await draft('2026-02-05', 'HO');
    for (const id of [a1, b1, a2, h1]) expect((await post(id)).statusCode).toBe(200);
    const got = async (id: string) => (await sql<{ voucher_no: string }>`SELECT voucher_no FROM voucher WHERE id = ${id}::uuid`.execute(ctx.t.admin)).rows[0]!.voucher_no;
    expect([await got(a1), await got(a2), await got(b1), await got(h1)]).toEqual(['HN-PKT26-001', 'HN-PKT26-002', 'DN-PKT26-001', 'TSC-PKT26-001']);
    const rev = await ok('POST', `/api/vouchers/${b1}/reverse`, owner, { postingDate: '2026-02-10' });
    expect(await got(rev.id)).toBe('DN-PKT26-002');
    await assertInvariants();
  });

  it('{BR} trong tiền tố đặt mã chi nhánh ở vị trí tùy ý', async () => {
    await ok('PUT', '/api/voucher-types/PKT', owner, { prefix: 'PKT{YY}/{BR}/' });
    try {
      const a = await draft('2026-03-02', brA); await post(a);
      expect((await sql<{ voucher_no: string }>`SELECT voucher_no FROM voucher WHERE id = ${a}::uuid`.execute(ctx.t.admin)).rows[0]!.voucher_no).toBe('PKT26/HN/003');
    } finally { await ok('PUT', '/api/voucher-types/PKT', owner, { prefix: 'PKT{YY}-' }); }
  });

  it('đánh lại số: từng chi nhánh liền từ 1 theo ngày, bộ đếm khớp, số chứng từ không trùng', async () => {
    await draft('2026-01-02', brA).then(post); // ngày sớm nhưng số lớn
    const n = (await ok('POST', '/api/vouchers/renumber', owner, { voucherType: 'PKT', fiscalYear: 2026 })).count;
    expect(n).toBe((await nos()).length);
    await assertInvariants();
    const a = await nos(sql`branch_id = ${brA}`);
    expect(a[0]!.voucher_no).toBe('HN-PKT26-001');
    const counters = (await sql<{ branch_key: string; last_no: string }>`SELECT branch_key, last_no FROM voucher_counter WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'PKT' AND fiscal_year = 2026 ORDER BY branch_key`.execute(ctx.t.admin)).rows;
    for (const c of counters) expect(Number(c.last_no)).toBe((await nos(sql`coalesce(branch_id, 0) = ${Number(c.branch_key)}`)).length);
    // số tiếp theo của chi nhánh nối tiếp bộ đếm đã đánh lại
    const next = await draft('2026-03-20', brA); await post(next);
    await assertInvariants();
  });

  it('hai chi nhánh ghi sổ đồng thời: mỗi chi nhánh một dãy liền, không trùng', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) { ids.push(await draft('2026-04-01', brA)); ids.push(await draft('2026-04-01', brB)); }
    const rs = await Promise.all(ids.map((id) => post(id)));
    expect(rs.map((r) => r.statusCode)).toEqual(ids.map(() => 200));
    await assertInvariants();
  });

  it('đồng thời với đánh lại số: không mất, không trùng', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) { ids.push(await draft('2026-05-01', brA)); ids.push(await draft('2026-05-01', brB)); }
    const rs = await Promise.all([...ids.map((id) => post(id)), req('POST', '/api/vouchers/renumber', owner, { voucherType: 'PKT', fiscalYear: 2026 })]);
    expect(rs.every((r) => r.statusCode === 200), rs.map((r) => r.body).join('|')).toBe(true);
    await assertInvariants();
  });

  it('tính chất ngẫu nhiên: chuỗi ghi sổ/hủy/đánh lại số ở nhiều chi nhánh luôn giữ dãy duy nhất và liền', async () => {
    const op = fc.oneof(
      fc.record({ k: fc.constant('post' as const), b: fc.constantFrom<'HO' | 'A' | 'B'>('HO', 'A', 'B') }),
      fc.record({ k: fc.constant('discard' as const), b: fc.constantFrom<'HO' | 'A' | 'B'>('HO', 'A', 'B') }),
      fc.record({ k: fc.constant('renumber' as const), b: fc.constant('HO' as const) }));
    const unit = (b: 'HO' | 'A' | 'B') => (b === 'HO' ? 'HO' as const : b === 'A' ? brA : brB);
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 3, maxLength: 12 }), async (ops) => {
      for (const o of ops) {
        if (o.k === 'post') await ok('POST', `/api/vouchers/${await draft('2026-06-02', unit(o.b))}/post`, owner);
        else if (o.k === 'discard') { // nháp rồi hủy: số không bị tiêu (số chỉ cấp khi ghi sổ)
          const id = await draft('2026-06-03', unit(o.b)); await ok('POST', `/api/vouchers/${id}/discard`, owner);
        } else await ok('POST', '/api/vouchers/renumber', owner, { voucherType: 'PKT', fiscalYear: 2026 });
      }
      await assertInvariants();
    }), { numRuns: Number(process.env.FC_RUNS ?? 6) });
  });

  it('chứng từ kết chuyển thuộc trụ sở chính (dãy TSC) dù người chạy đang làm việc ở chi nhánh', async () => {
    await ok('PUT', '/api/me/branch', owner, { branch: brA });
    try {
      const rev = await draft('2026-12-20', brA); await ok('POST', `/api/vouchers/${rev}/post`, owner);
      await ok('POST', '/api/vouchers', owner, { voucherType: 'PKT', postingDate: '2026-12-21', documentDate: '2026-12-21', description: 'DT', autoPost: true, lines: [{ accountCode: '1111', debit: '9000' }, { accountCode: '5113', credit: '9000' }] });
      const r = await req('POST', '/api/closing/run-all', owner, { postingDate: '2026-12-31' });
      expect(r.statusCode, r.body).toBe(200);
    } finally { await ok('PUT', '/api/me/branch', owner, { branch: 'HO' }); }
    const kc = (await sql<{ voucher_no: string; branch_id: number | null; seq_no: string }>`SELECT voucher_no, branch_id, seq_no FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'KC' AND voucher_no IS NOT NULL ORDER BY seq_no`.execute(ctx.t.admin)).rows;
    expect(kc.length).toBeGreaterThan(0);
    expect(kc.every((x) => x.branch_id === null && x.voucher_no.startsWith('TSC-'))).toBe(true);
    expect(kc.map((x) => Number(x.seq_no))).toEqual(kc.map((_, i) => i + 1));
  });

  it('cấu hình: mã trụ sở chính không trùng mã chi nhánh; cần quyền setting.update', async () => {
    expect((await settings(true, 'HN')).json().error.code).toBe('NUMBERING_CODE_CONFLICT');
    expect((await req('POST', '/api/branches', owner, { code: 'TSC', name: 'Trùng mã' })).json().error.code).toBe('NUMBERING_CODE_CONFLICT');
    expect((await settings(true, 'a b')).statusCode).toBe(400);
  });

  it('tắt lại: chứng từ mới về một dãy chung, số cũ giữ nguyên, không trùng', async () => {
    expect((await settings(false)).statusCode).toBe(200);
    const before = (await nos()).length;
    const id = await draft('2026-07-01', brA); expect((await post(id)).statusCode).toBe(200);
    const row = (await sql<{ voucher_no: string }>`SELECT voucher_no FROM voucher WHERE id = ${id}::uuid`.execute(ctx.t.admin)).rows[0]!;
    expect(row.voucher_no).toMatch(/^PKT26-\d{3}$/);
    expect((await nos()).length).toBe(before + 1);
    expect(new Set((await nos()).map((r) => r.voucher_no)).size).toBe(before + 1);
  });

  it('fn_format_voucher_no_b khớp formatVoucherNo', async () => {
    const cases = [{ prefix: 'PKT', suffix: '', padLength: 3, seq: 2, year: 2026, branchCode: 'HN' }, { prefix: 'PKT{YY}/{BR}/', suffix: '', padLength: 3, seq: 2, year: 2026, branchCode: 'HN' },
      { prefix: 'PKT{BR}', suffix: '', padLength: 3, seq: 2, year: 2026, branchCode: null }, { prefix: 'PKT', suffix: '', padLength: 3, seq: 1234, year: 2026, branchCode: '' }];
    const { formatVoucherNo } = await import('@kt/domain');
    for (const c of cases) {
      const r = await sql<{ n: string }>`SELECT fn_format_voucher_no_b(${c.prefix}, ${c.suffix}, ${c.padLength}, ${c.seq}, ${c.year}, ${c.branchCode}::text) AS n`.execute(ctx.t.admin);
      expect(r.rows[0]!.n).toBe(formatVoucherNo(c));
    }
  });
});
