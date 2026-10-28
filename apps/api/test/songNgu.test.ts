import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';
import { inferKind, tr } from '../src/modules/reporting/print/i18n.js';
import type { ReportDoc } from '../src/modules/reporting/print/html.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let cookie: string;
const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });
const send = (method: 'PUT' | 'POST', url: string, payload: unknown) => ctx.app.inject({ method, url, headers: { cookie }, payload: payload as object });
const Q = 'from=2026-01-01&to=2026-01-31';
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `SN${Date.now()}` }));
  await send('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  await send('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-01-05', documentDate: '2026-01-05', description: 'Mua giấy', autoPost: true, lines: [{ accountCode: '6422', debit: '2500000' }, { accountCode: '1111', credit: '2500000' }] });
});
afterAll(async () => { await ctx.close(); });

describe('từ điển nhãn', () => {
  it('tr: vi giữ nguyên, en dịch, vi-en ghép; câu lạ rơi về tiếng Việt', () => {
    expect([tr('Nợ', 'vi'), tr('Nợ', 'en'), tr('Nợ', 'vi-en'), tr('Câu lạ', 'en')]).toEqual(['Nợ', 'Debit', 'Nợ / Debit', 'Câu lạ']);
  });
  it('inferKind nhận loại tài liệu qua khóa cột', () => {
    const d = (keys: string[]) => ({ columns: keys.map((key) => ({ key, label: key })) }) as ReportDoc;
    expect([d(['lineCode']), d(['accountName']), d(['documentDate']), d(['partyCode']), d(['voucherNo'])].map(inferKind)).toEqual(['financial', 'trial', 'journal', 'detail', 'ledger']);
  });
});

describe('tên tiếng Anh và bản in song ngữ', () => {
  it('điền chỗ trống từ mẫu là bản nháp; sửa tay đặt đã soát; không ghi đè tên đã nhập', async () => {
    // Công ty mới đã nhận tên từ mẫu khi tạo tài khoản (bản nháp); xóa 111 rồi điền lại để thử đường điền chỗ trống của công ty có từ trước.
    expect((await get('/api/translations/accounts?regime=TT133')).json().find((a: { code: string }) => a.code === '111')).toMatchObject({ nameEn: 'Cash on hand', status: 'draft' });
    await send('PUT', '/api/translations/accounts', { regime: 'TT133', items: [{ code: '111', nameEn: null }] });
    const f = await send('POST', '/api/translations/fill-from-template', { regime: 'TT133', scope: 'accounts' });
    expect(f.statusCode, f.body).toBe(200); expect(f.json().count).toBe(1);
    const list = (await get('/api/translations/accounts?regime=TT133')).json() as { code: string; nameEn: string | null; status: string | null }[];
    expect(list.find((a) => a.code === '111')).toMatchObject({ nameEn: 'Cash on hand', status: 'draft' });
    expect(list.find((a) => a.code === '1111')).toMatchObject({ nameEn: null, status: null }); // chưa dịch chắc chắn: để trống
    const p = await send('PUT', '/api/translations/accounts', { regime: 'TT133', items: [{ code: '1111', nameEn: 'Cash in VND', status: 'reviewed' }, { code: '111', nameEn: 'Cash (edited)' }, { code: '6422', nameEn: 'Office expenses' }] });
    expect(p.statusCode, p.body).toBe(200);
    const after = (await get('/api/translations/accounts?regime=TT133')).json() as { code: string; nameEn: string | null; status: string | null }[];
    expect(after.find((a) => a.code === '1111')).toMatchObject({ nameEn: 'Cash in VND', status: 'reviewed' });
    expect(after.find((a) => a.code === '111')).toMatchObject({ nameEn: 'Cash (edited)', status: 'draft' });
    expect((await send('POST', '/api/translations/fill-from-template', { regime: 'TT133', scope: 'accounts' })).json().count).toBe(0);
    const bad = await send('PUT', '/api/translations/accounts', { regime: 'TT133', items: [{ code: '99999', nameEn: 'x' }] });
    expect([bad.statusCode, bad.json().error.code]).toEqual([404, 'ACCOUNT_NOT_FOUND']);
  });

  it('Bảng cân đối số phát sinh và Sổ Cái theo lang; JSON và lang=vi không đổi; số giữ định dạng Việt', async () => {
    const vi_ = (await get(`/api/reports/ledgers/trial-balance?${Q}&format=html`)).body;
    expect(vi_).not.toContain('Trial Balance'); expect(vi_).not.toContain('Reference translation');
    const en = (await get(`/api/reports/ledgers/trial-balance?${Q}&format=html&lang=en`)).body;
    expect(en).toContain('TRIAL BALANCE'); expect(en).toContain('Account name'); expect(en).toContain('Cash in VND'); expect(en).toContain('Office expenses'); expect(en).toContain('Reference translation only'); expect(en).toContain('2.500.000');
    const both = (await get(`/api/reports/ledgers/trial-balance?${Q}&format=html&lang=vi-en`)).body;
    expect(both).toContain('Tên tài khoản / Account name'); expect(both).toContain('Tiền Việt Nam / Cash in VND'); expect(both).toContain('Bản dịch tham khảo, không phải bản dịch chính thức');
    const json = (await get(`/api/reports/ledgers/trial-balance?${Q}`)).json() as { rows: { accountCode: string; accountName: string }[] };
    expect(json.rows.find((r) => r.accountCode === '1111')!.accountName).toBe('Tiền Việt Nam');
    const led = (await get(`/api/reports/ledgers/account?${Q}&accountCode=1111&format=html&lang=vi-en`)).body;
    expect(led).toContain('GENERAL LEDGER – ACCOUNT 1111 – CASH IN VND'); expect(led).toContain('Số dư đầu kỳ / Opening balance'); expect(led).toContain('Ngày ghi sổ / Posting date');
    const j = (await get(`/api/reports/ledgers/general-journal?${Q}&format=html&lang=en`)).body;
    expect(j).toContain('GENERAL JOURNAL'); expect(j).toContain('From 01/01/2026 to 31/01/2026');
    expect((await get(`/api/reports/ledgers/general-journal?${Q}&format=html&lang=fr`)).statusCode).toBe(400);
  });

  it('B01: tên chỉ tiêu tiếng Anh từ mẫu, sửa tay, và lưu công thức không làm mất bản dịch', async () => {
    await send('PUT', '/api/translations/report-lines', { regime: 'TT133', reportCode: 'B01', items: [{ lineCode: '200', labelEn: null }] });
    const f = await send('POST', '/api/translations/fill-from-template', { regime: 'TT133', scope: 'report-lines' });
    expect(f.statusCode, f.body).toBe(200); expect(f.json().count).toBe(1);
    const lines = (await get('/api/translations/report-lines?regime=TT133&code=B01')).json() as { lineCode: string; label: string; labelEn: string | null; status: string | null }[];
    expect(lines.find((l) => l.lineCode === '200')).toMatchObject({ labelEn: 'TOTAL ASSETS', status: 'draft' });
    expect((await send('PUT', '/api/translations/report-lines', { regime: 'TT133', reportCode: 'B01', items: [{ lineCode: '200', labelEn: 'TOTAL ASSETS (reviewed)', status: 'reviewed' }] })).statusCode).toBe(200);
    // màn hình công thức lưu lại không gửi labelEn: bản dịch giữ nguyên
    const def = (await get('/api/report-defs/B01?regime=TT133')).json() as { lines: Record<string, unknown>[] };
    const strip = def.lines.map(({ labelEn: _e, translationStatus: _s, ...rest }) => rest);
    expect((await send('PUT', '/api/report-defs/B01', { regime: 'TT133', lines: strip })).statusCode).toBe(200);
    const en = (await get(`/api/reports/financial/B01?${Q}&format=html&lang=en`)).body;
    expect(en).toContain('TOTAL ASSETS (reviewed)'); expect(en).toContain('Statement of Financial Position'.toUpperCase()); expect(en).toContain('Closing balance');
    const both = (await get(`/api/reports/financial/B01?${Q}&format=html&lang=vi-en`)).body;
    expect(both).toContain('1. Phải thu của khách hàng / 1. Trade receivables'); expect(both).toContain('Số cuối kỳ / Closing balance');
  });

  it('bộ sổ năm có lang', async () => {
    const x = await send('POST', '/api/print/book-set', { fiscalYear: 2026, include: ['journal', 'trial'], format: 'xlsx', lang: 'vi-en' });
    expect(x.statusCode, x.body).toBe(200);
    expect((await send('POST', '/api/print/book-set', { fiscalYear: 2026, include: ['journal'], format: 'xlsx', lang: 'xx' })).statusCode).toBe(400);
  });
});
