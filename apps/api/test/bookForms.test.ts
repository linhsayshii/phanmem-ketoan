import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '@kt/db';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let cookie: string; let tenantId: string;
const pkt = (date: string, lines: object[]) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: date, documentDate: date, description: `CT ${date}`, autoPost: true, lines } });
const get = (url: string, c = cookie) => ctx.app.inject({ method: 'GET', url, headers: { cookie: c } });
type Side = { debit: string; credit: string };
const R = 'from=2026-01-01&to=2026-02-28';

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `BF${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code: 'KH001', name: 'Khách 1', is_customer: true } });
  expect((await pkt('2026-01-10', [{ accountCode: '131', debit: '500', partyCode: 'KH001' }, { accountCode: '5113', credit: '500' }])).statusCode).toBe(201);
  expect((await pkt('2026-01-20', [{ accountCode: '1111', debit: '200' }, { accountCode: '131', credit: '200', partyCode: 'KH001' }])).statusCode).toBe(201);
  expect((await pkt('2026-02-05', [{ accountCode: '6421', debit: '300' }, { accountCode: '6422', debit: '100' }, { accountCode: '1111', credit: '400' }])).statusCode).toBe(201);
  await ctx.app.inject({ method: 'POST', url: '/api/balances/recompute', headers: { cookie } });
});
afterAll(async () => { await ctx.close(); });

describe('hình thức sổ', () => {
  it('đặt/đọc hình thức sổ theo năm, mặc định NKC, giá trị lạ bị 400, đổi không ghi chứng từ và không đổi số dư', async () => {
    expect((await get('/api/fiscal-years/2026/book-form')).json().bookForm).toBe('NKC');
    const count = () => withTenant(ctx.t.db, { tenantId }, async (trx) => (await sql<{ v: number; l: number; p: number }>`SELECT (SELECT count(*) FROM voucher)::int v, (SELECT count(*) FROM voucher_line)::int l, (SELECT count(*) FROM voucher_pair)::int p`.execute(trx)).rows[0]!);
    const before = await count(); const tb = (await get(`/api/reports/ledgers/trial-balance?${R}`)).json();
    for (const bookForm of ['CTGS', 'NKSC', 'NKCT']) expect((await ctx.app.inject({ method: 'PUT', url: '/api/fiscal-years/2026/book-form', headers: { cookie }, payload: { bookForm } })).statusCode).toBe(200);
    expect((await get('/api/fiscal-years/2026/book-form')).json().bookForm).toBe('NKCT');
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/fiscal-years/2026/book-form', headers: { cookie }, payload: { bookForm: 'X' } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/fiscal-years/2030/book-form', headers: { cookie }, payload: { bookForm: 'NKC' } })).statusCode).toBe(404);
    expect(await count()).toEqual(before);
    expect((await get(`/api/reports/ledgers/trial-balance?${R}`)).json()).toEqual(tb);
  });

  it('Nhật ký – Sổ Cái: tổng Nợ = tổng Có, cộng theo tài khoản, khớp tổng phát sinh Bảng cân đối số phát sinh', async () => {
    const r = (await get(`/api/reports/books/nksc?${R}`)).json();
    expect(r.rows).toHaveLength(7); expect(r.totalDebit).toBe('1100'); expect(r.totalCredit).toBe('1100');
    const tb = (await get(`/api/reports/ledgers/trial-balance?${R}`)).json();
    expect(r.totalDebit).toBe(tb.totals.period.debit); expect(r.totalCredit).toBe(tb.totals.period.credit);
    expect(r.accounts.find((a: { accountCode: string }) => a.accountCode === '1111')).toMatchObject({ debit: '200', credit: '400' });
  });

  it('Nhật ký – Chứng từ: bảng kê bên Có TK 1111 theo cột TK Nợ đối ứng; tổng khớp tổng phát sinh Có của Sổ Cái 1111', async () => {
    const r = (await get(`/api/reports/books/nkct?${R}&creditAccountCode=1111`)).json();
    expect(r.debitAccounts).toEqual(['6421', '6422']); expect(r.totals).toEqual({ '6421': '300', '6422': '100' }); expect(r.total).toBe('400');
    expect(r.rows).toHaveLength(1);
    const led = (await get(`/api/reports/ledgers/account?${R}&accountCode=1111&mode=voucher`)).json();
    expect(r.total).toBe(led.totalCredit);
    expect((await get(`/api/reports/books/nkct?${R}&creditAccountCode=9999`)).statusCode).toBe(404);
  });

  let setId: number;
  it('Chứng từ ghi sổ: lập gom đủ chứng từ, không lập trùng, sổ đăng ký và Sổ Cái CTGS khớp Bảng cân đối số phát sinh', async () => {
    const mk = (payload: object) => ctx.app.inject({ method: 'POST', url: '/api/voucher-sets', headers: { cookie }, payload });
    const base = { fiscalYear: 2026, description: 'CTGS tháng 1', dateFrom: '2026-01-01', dateTo: '2026-01-31' };
    const a = await mk({ ...base, setDate: '2026-01-31' }); expect(a.statusCode, a.body).toBe(201);
    expect(a.json()).toMatchObject({ setNo: 1, vouchers: 2 }); setId = a.json().id;
    expect((await mk({ ...base, setDate: '2026-01-31' })).statusCode).toBe(409); // hết chứng từ chưa vào nhóm
    const b = await mk({ ...base, description: 'CTGS tháng 2', dateFrom: '2026-02-01', dateTo: '2026-02-28', setDate: '2026-02-28' });
    expect(b.json()).toMatchObject({ setNo: 2, vouchers: 1 });
    expect((await mk({ ...base, dateTo: '2027-01-31', setDate: '2026-01-31' })).statusCode).toBe(400);

    const reg = (await get(`/api/reports/books/ctgs-register?${R}`)).json();
    expect(reg.rows.map((x: { setNo: number; amount: string }) => [x.setNo, x.amount])).toEqual([[1, '700'], [2, '400']]); expect(reg.total).toBe('1100');
    const detail = (await get(`/api/voucher-sets/${setId}`)).json();
    expect(detail.total).toBe('700');

    const tb = (await get(`/api/reports/ledgers/trial-balance?${R}`)).json();
    const leaf = tb.rows.filter((x: { isGroup: boolean }) => !x.isGroup) as { accountCode: string; period: Side }[];
    let td = 0; let tc = 0;
    for (const acc of leaf) {
      const l = (await get(`/api/reports/books/ctgs-ledger?${R}&accountCode=${acc.accountCode}`)).json();
      expect(l.totalDebit, acc.accountCode).toBe(acc.period.debit); expect(l.totalCredit, acc.accountCode).toBe(acc.period.credit); expect(l.unassigned).toBe(0);
      td += Number(l.totalDebit); tc += Number(l.totalCredit);
    }
    expect(td).toBe(tc);
  });

  it('in HTML/PDF/Excel mỗi sổ; bộ sổ năm in theo hình thức đã chọn; xóa nhóm không đổi sổ cái', async () => {
    for (const u of [`nksc?${R}`, `nkct?${R}&creditAccountCode=1111`, `ctgs-register?${R}`, `ctgs-ledger?${R}&accountCode=1111`]) {
      expect((await get(`/api/reports/books/${u}&format=html`)).statusCode, u).toBe(200);
      expect((await get(`/api/reports/books/${u}&format=xlsx`)).statusCode, u).toBe(200);
    }
    const html = (await get(`/api/reports/books/ctgs-register?${R}&format=html`)).body;
    expect(html).toContain('SỔ ĐĂNG KÝ CHỨNG TỪ GHI SỔ');
    expect((await get(`/api/voucher-sets/${setId}?format=html`)).statusCode).toBe(200);
    expect((await get(`/api/reports/books/nksc?${R}&format=pdf`)).headers['content-type']).toBe('application/pdf');
    for (const bookForm of ['NKSC', 'CTGS', 'NKCT']) {
      await ctx.app.inject({ method: 'PUT', url: '/api/fiscal-years/2026/book-form', headers: { cookie }, payload: { bookForm } });
      const r = await ctx.app.inject({ method: 'POST', url: '/api/print/book-set', headers: { cookie }, payload: { fiscalYear: 2026, include: ['journal', 'ledgers', 'trial'], format: 'xlsx' } });
      expect(r.statusCode, bookForm).toBe(200);
    }
    const tb = (await get(`/api/reports/ledgers/trial-balance?${R}`)).json();
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/voucher-sets/${setId}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/voucher-sets/${setId}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await get(`/api/reports/ledgers/trial-balance?${R}`)).json()).toEqual(tb);
    expect((await get(`/api/reports/books/ctgs-ledger?${R}&accountCode=1111`)).json().unassigned).toBe(2);
  });

  it('người thiếu cờ nhạy cảm bị 403 ở mọi sổ hình thức', async () => {
    const username = `bf_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_truong', sensitiveFlags: [] } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const c2 = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    for (const u of [`nksc?${R}`, `nkct?${R}&creditAccountCode=1111`, `ctgs-register?${R}`, `ctgs-ledger?${R}&accountCode=1111`]) expect((await get(`/api/reports/books/${u}`, c2)).statusCode, u).toBe(403);
  });
});
