import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { READ_SNAPSHOT, withTenant } from '@kt/db';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';
import { bookSetDocs } from '../src/modules/reporting/print/bookSet.js';

// "In cả bộ sổ năm" theo hình thức sổ của năm (GĐ7 gói 3): nội dung từng hình thức, không chỉ mã 200.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let cookie: string; let tenantId: string;
const pkt = (date: string, lines: object[]) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: date, documentDate: date, description: `CT ${date}`, autoPost: true, lines } });
const setForm = (bookForm: string) => ctx.app.inject({ method: 'PUT', url: '/api/fiscal-years/2026/book-form', headers: { cookie }, payload: { bookForm } });
const docs = (include: string[]) => withTenant(ctx.t.db, { tenantId }, (trx) => bookSetDocs(trx, tenantId, 2026, include), READ_SNAPSHOT);
const titles = (d: { title: string }[]) => d.map((x) => x.title);

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `BS${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  expect((await pkt('2026-01-10', [{ accountCode: '1111', debit: '500' }, { accountCode: '5113', credit: '500' }])).statusCode).toBe(201);
  expect((await pkt('2026-02-05', [{ accountCode: '6421', debit: '300' }, { accountCode: '6422', debit: '100' }, { accountCode: '1111', credit: '400' }])).statusCode).toBe(201);
  expect((await ctx.app.inject({ method: 'POST', url: '/api/voucher-sets', headers: { cookie }, payload: { fiscalYear: 2026, description: 'CTGS quý 1', dateFrom: '2026-01-01', dateTo: '2026-03-31', setDate: '2026-03-31' } })).statusCode).toBe(201);
});
afterAll(async () => { await ctx.close(); });

describe('bộ sổ năm theo hình thức sổ', () => {
  it('Nhật ký chung (mặc định): Nhật ký chung rồi Sổ Cái từng tài khoản rồi Bảng cân đối số phát sinh', async () => {
    const t = titles(await docs(['journal', 'ledgers', 'trial']));
    expect(t[0]).toBe('Sổ Nhật ký chung');
    expect(t.filter((x) => x.startsWith('Sổ Cái – Tài khoản'))).toHaveLength(4); // 1111, 5113, 6421, 6422: chỉ tài khoản chi tiết có số liệu
    expect(t.at(-1)).toBe('Bảng cân đối số phát sinh');
  });

  it('Chứng từ ghi sổ: sổ đăng ký, từng Chứng từ ghi sổ, Sổ Cái theo CTGS (không còn Nhật ký chung và Sổ Cái thường); số mẫu CTGS chỉ in khi đã đối chiếu', async () => {
    expect((await setForm('CTGS')).statusCode).toBe(200);
    const d = await docs(['journal', 'ledgers', 'trial']);
    const t = titles(d);
    expect(t[0]).toBe('Sổ đăng ký Chứng từ ghi sổ');
    expect(t[1]).toMatch(/^Chứng từ ghi sổ số 1$/);
    expect(t.some((x) => x.startsWith('Sổ Cái (hình thức Chứng từ ghi sổ)'))).toBe(true);
    expect(t.some((x) => x === 'Sổ Nhật ký chung' || x.startsWith('Sổ Cái – Tài khoản'))).toBe(false);
    expect(t.at(-1)).toBe('Bảng cân đối số phát sinh');
    // TT133 chưa có số mẫu S02 đối chiếu: không bịa
    expect(d.filter((x) => x.title.includes('Chứng từ ghi sổ')).every((x) => x.formNo === '')).toBe(true);
  });

  it('Nhật ký – Sổ Cái: một sổ thay Nhật ký và Sổ Cái (mục Sổ Cái không in thêm)', async () => {
    expect((await setForm('NKSC')).statusCode).toBe(200);
    const t = titles(await docs(['journal', 'ledgers']));
    expect(t).toEqual(['Sổ Nhật ký – Sổ Cái']);
  });

  it('Nhật ký – Chứng từ: mỗi tài khoản có phát sinh Có một bảng kê; Sổ Cái thường vẫn in', async () => {
    expect((await setForm('NKCT')).statusCode).toBe(200);
    const t = titles(await docs(['journal', 'ledgers']));
    expect(t.filter((x) => x.startsWith('Nhật ký – Chứng từ (ghi Có TK')).map((x) => x.match(/TK (\d+)/)![1]).sort()).toEqual(['1111', '5113']);
    expect(t.filter((x) => x.startsWith('Sổ Cái – Tài khoản')).length).toBeGreaterThan(0);
  });

  it('hình thức NKC trở lại: bộ sổ như ban đầu; báo cáo tài chính giữ nguyên ở mọi hình thức', async () => {
    const withFs = async (form: string) => { await setForm(form); return titles(await docs(['B01', 'B02'])); };
    const base = await withFs('NKC');
    for (const f of ['CTGS', 'NKSC', 'NKCT']) expect(await withFs(f), f).toEqual(base);
  });
});
