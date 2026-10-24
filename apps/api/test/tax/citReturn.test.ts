import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { sql } from 'kysely';
import { seedAbcFullTx } from '../../scripts/seed-abc.js';
import { createTestApp, type TestApp } from '../helpers.js';
import { postVoucher, setupLedgerTenant } from '../invariants/helpers.js';
import type * as CoaData from '@kt/coa-data';

// Cổng 03TNDN_TT89 của status.json đọc qua isCitTemplateComplete: kiểm thử bật/tắt bằng biến này thay cho sửa tệp dữ liệu.
const gate = vi.hoisted(() => ({ open: true }));
vi.mock('@kt/coa-data', async (orig) => {
  const m = await orig<typeof CoaData>();
  return { ...m, isCitTemplateComplete: (v: 'TT89') => gate.open && m.isCitTemplateComplete(v) };
});

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; headers: Record<string, unknown>; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];
const as = (cookie: string) => (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
const ok = async (p: Promise<Res>, code = 200) => { const r = await p; expect(r.statusCode, r.body).toBe(code); return r.json(); };
interface Ret { id: number; formCode: string; periodKind: string; period: number; revision: number; status: string; values: Record<string, string>; overrides: Record<string, string>; hints: Record<string, string>; warnings: string[] }

async function tenant() {
  const b = await setupLedgerTenant(ctx, `CR${Date.now()}${n++}`); const call = as(b.cookie);
  await sql`UPDATE tenant SET tax_code = '0109999999' WHERE id = ${b.tenantId}::uuid`.execute(ctx.t.admin);
  const post = async (date: string, debit: string, credit: string, amount: string) => { const r = await postVoucher(ctx, b.cookie, date, [{ accountCode: debit, debit: amount, credit: '0' }, { accountCode: credit, debit: '0', credit: amount }]); expect(r.statusCode, r.body).toBe(201); };
  return { ...b, call, post };
}

describe('tờ khai quyết toán thuế TNDN 03/TNDN', () => {
  it('chỉ tiêu lợi nhuận kế toán trước thuế của 03/TNDN = B02 năm (và phụ lục KQSXKD nếu có mẫu gốc khớp B02 từng chỉ tiêu)', async () => {
    // TT 89/2026 và TT 20/2026 không có mẫu phụ lục kết quả hoạt động SXKD: không lập phụ lục, A1 lấy từ B02.
    const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL! }); await c.connect();
    let tenantId: string; try { ({ tenantId } = await seedAbcFullTx(c, { code: 'ABC_CIT' })); } finally { await c.end(); }
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'Matkhau1!' } });
    const cookie = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    await ctx.app.inject({ method: 'POST', url: '/api/auth/select-tenant', headers: { cookie }, payload: { tenantId } });
    const call = as(cookie);
    await ok(call('POST', '/api/report-defs/B02/reload', { regime: 'TT133' })); // dữ liệu mẫu ABC tạo năm tài chính bằng SQL, chưa chép định nghĩa B02
    const b02 = (await ok(call('GET', '/api/reports/financial/B02?from=2026-01-01&to=2026-12-31'))).rows as { lineCode: string; current: string }[];
    const r: Ret = await ok(call('POST', '/api/cit/returns', { year: 2026, overrides: { C7a: '20' } }), 201);
    try {
      expect(r).toMatchObject({ formCode: '03/TNDN', periodKind: 'year', period: 1, revision: 0, status: 'draft' });
      expect(r.values.A1).toBe(b02.find((x) => x.lineCode === '50')!.current);
      expect(r.hints.A1).toMatch(/B02/);
      expect(r.values.B13).toBe(r.values.A1); // chưa điều chỉnh
      expect(r.values).not.toHaveProperty('A');
      // Tờ khai TNDN không lẫn vào danh sách, chi tiết của tờ khai GTGT.
      expect((await ok(call('GET', '/api/tax/vat-returns?year=2026'))).some((x: Ret) => x.id === r.id)).toBe(false);
      expect(err(await call('GET', `/api/tax/vat-returns/${r.id}`))).toEqual([404, 'TAX_RETURN_NOT_FOUND']);
    } finally { expect((await call('DELETE', `/api/cit/returns/${r.id}`)).statusCode).toBe(204); }
  });

  it('tờ khai 03/TNDN chốt rồi sửa → TAX_RETURN_FINAL; bổ sung lần 1 được', async () => {
    const t = await tenant();
    await t.post('2026-03-01', '1111', '5113', '100000000');
    await t.post('2026-05-01', '3334', '1121', '4000000'); // tạm nộp (sau đầu quý 2)
    const r: Ret = await ok(t.call('POST', '/api/cit/returns', { year: 2026 }), 201);
    expect(r.values).toMatchObject({ A1: '100000000', C1: '100000000', C7: '100000000', C7a: '0', C9: '0', G2: '4000000' });
    expect(r.warnings.join(' ')).toMatch(/C7a/); // chưa có doanh thu năm trước: thuế suất nhập tay
    expect(err(await t.call('POST', `/api/cit/returns/${r.id}/finalize`))).toEqual([409, 'CIT_RATE_REQUIRED']);
    const u: Ret = await ok(t.call('PUT', `/api/cit/returns/${r.id}`, { overrides: { B4: '10000000', C7a: '20', '04': 'Dịch vụ tư vấn' } }));
    // Doanh thu năm 2026 (100 triệu) không quá 10 tỷ: gợi ý giảm 30% (NQ 43/2026) ở C15 = 30% × 22.000.000.
    expect(u.values).toMatchObject({ B1: '10000000', B13: '110000000', B14: '110000000', C4: '110000000', C9: '22000000', C15: '6600000', C17: '15400000', E1: '15400000', E: '15400000', G: '4000000', H1: '11400000', I: '11400000', I1: '11400000', '04': 'Dịch vụ tư vấn' });
    expect(u.hints.C15).toMatch(/NQ 43\/2026/);
    expect((await ok(t.call('PUT', `/api/cit/returns/${r.id}`, { overrides: { B4: '10000000', C7a: '20', C15: '0', '04': 'Dịch vụ tư vấn' } }))).values.C17).toBe('22000000'); // không đủ điều kiện giảm: sửa C15
    await ok(t.call('PUT', `/api/cit/returns/${r.id}`, { overrides: { B4: '10000000', C7a: '20', '04': 'Dịch vụ tư vấn' } }));
    expect(err(await t.call('PUT', `/api/cit/returns/${r.id}`, { overrides: { B13: '1' } }))).toEqual([400, 'CIT_INVALID']);
    expect(err(await t.call('POST', '/api/cit/returns', { year: 2026 }))).toEqual([409, 'TAX_RETURN_DRAFT_EXISTS']);
    expect(err(await t.call('GET', `/api/cit/returns/${r.id}/xml`))).toEqual([409, 'TAX_RETURN_NOT_FINAL']);
    const f: Ret = await ok(t.call('POST', `/api/cit/returns/${r.id}/finalize`));
    expect(f.status).toBe('final');
    expect(err(await t.call('PUT', `/api/cit/returns/${r.id}`, { overrides: { B4: '0' } }))).toEqual([409, 'TAX_RETURN_FINAL']);
    expect(err(await t.call('DELETE', `/api/cit/returns/${r.id}`))).toEqual([409, 'TAX_RETURN_FINAL']);

    const xml = await t.call('GET', `/api/cit/returns/${r.id}/xml`);
    expect(xml.statusCode, xml.body).toBe(200);
    expect(xml.headers['x-kt-unverified']).toBe('1');
    expect(xml.body).toContain('<maTKhai>03/TNDN</maTKhai>'); expect(xml.body).toContain('<ctA1>100000000</ctA1>'); expect(xml.body).toContain('<ctC7a>20</ctC7a>');
    expect(String(xml.headers['content-disposition'])).toContain('03TNDN_0109999999_N2026.xml');

    // Ký số qua phiên ký (khóa thử): cit_return dựng XML 03/TNDN, tải bản đã ký.
    await ok(t.call('POST', '/api/signing/profiles', { kind: 'fake', label: 'Thử' }), 201);
    const s = await ok(t.call('POST', '/api/signing/sessions', { docKind: 'cit_return', docRef: String(r.id) }), 201);
    expect((await ok(t.call('POST', `/api/signing/sessions/${s.id}/poll`))).status).toBe('signed');
    const signed = await t.call('GET', `/api/cit/returns/${r.id}/xml?signedSession=${s.id}`);
    expect(signed.statusCode, signed.body).toBe(200); expect(signed.body).toContain('Signature'); expect(String(signed.headers['content-disposition'])).toContain('_signed.xml');

    const b: Ret = await ok(t.call('POST', '/api/cit/returns', { year: 2026, revision: 1 }), 201);
    expect(b).toMatchObject({ revision: 1, status: 'draft' });
    // Bổ sung mặc định chép chỉ tiêu nhập tay/ghi đè của bản chốt gần nhất, số theo sổ tính lại.
    expect(b.overrides).toEqual({ B4: '10000000', C7a: '20', '04': 'Dịch vụ tư vấn' });
    expect(b.values).toMatchObject({ B4: '10000000', C9: '22000000', '04': 'Dịch vụ tư vấn' });
    expect((await ok(t.call('GET', '/api/cit/returns?year=2026'))).map((x: Ret) => [x.revision, x.status])).toEqual([[1, 'draft'], [0, 'final']]);
  });

  it('cổng 03TNDN_TT89 false → 409 CIT_TEMPLATE_UNAVAILABLE', async () => {
    const t = await tenant();
    gate.open = false;
    try {
      expect(err(await t.call('POST', '/api/cit/returns', { year: 2026 }))).toEqual([409, 'CIT_TEMPLATE_UNAVAILABLE']);
      expect(err(await t.call('GET', '/api/cit/template?year=2026'))).toEqual([409, 'CIT_TEMPLATE_UNAVAILABLE']);
      expect((await t.call('GET', '/api/cit/estimate?year=2026&quarter=1&rate=20')).statusCode).toBe(200); // tạm tính quý không phụ thuộc mẫu 03/TNDN
    } finally { gate.open = true; }
    expect((await ok(t.call('GET', '/api/cit/template?year=2026'))).lines.length).toBeGreaterThan(60);
    expect(err(await t.call('POST', '/api/cit/returns', { year: 2025 }))).toEqual([409, 'CIT_TEMPLATE_UNAVAILABLE']); // kỳ kết thúc trước 01/7/2026
  });
});
