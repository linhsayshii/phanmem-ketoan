import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// GĐ3 Task 21: kỳ hạn ngắn/dài hạn trên B01 TT99 (hạn của khoản công nợ, hạn đáo hạn ở dòng) và mã luồng tiền trên B03 trực tiếp.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 90_000 });
let ctx: TestApp; let cookie: string; let tenantId: string;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
type Ln = { accountCode: string; debit?: string; credit?: string; partyCode?: string; dueDate?: string; cashFlowCode?: string };
const pkt = (date: string, lines: Ln[]) => call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'x', autoPost: true, lines });
const ok = async (p: ReturnType<typeof pkt>) => { const r = await p; expect(r.statusCode, r.body).toBe(201); return r.json() as { id: string; version: number; lines: { lineNo: number; cashFlowCode?: string | null; dueDate?: string | null }[] }; };
type Row = { lineCode: string; current: string; previous: string | null };
const report = async (code: string, to: string) => { const r = await call('GET', `/api/reports/financial/${code}?from=2026-01-01&to=${to}`); expect(r.statusCode, r.body).toBe(200); return (c: string) => (r.json().rows as Row[]).find((x) => x.lineCode === c)!.current; };
let receipt: Awaited<ReturnType<typeof ok>>; let other: Awaited<ReturnType<typeof ok>>; let prepay: Awaited<ReturnType<typeof ok>>;

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `LT${Date.now()}` }));
  expect((await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' })).statusCode).toBe(201);
  for (const [code, kind] of [['KH1', 'is_customer'], ['KH2', 'is_customer'], ['KH3', 'is_customer'], ['NCC1', 'is_vendor']] as const)
    expect((await call('POST', '/api/catalogs/party', { code, name: code, [kind]: true })).statusCode).toBe(201);
  await ok(pkt('2026-01-10', [{ accountCode: '131', debit: '1000', partyCode: 'KH1', dueDate: '2026-03-31' }, { accountCode: '511', credit: '1000' }]));
  await ok(pkt('2026-01-11', [{ accountCode: '131', debit: '2000', partyCode: 'KH1', dueDate: '2028-06-30' }, { accountCode: '511', credit: '2000' }]));
  prepay = await ok(pkt('2026-01-12', [{ accountCode: '111', debit: '300' }, { accountCode: '131', credit: '300', partyCode: 'KH2' }])); // không mã: rơi theo cặp N111/C131 vào mã 01
  await ok(pkt('2026-01-13', [{ accountCode: '111', debit: '5000' }, { accountCode: '3411', credit: '5000', dueDate: '2029-01-01' }])); // vay dài hạn
  await ok(pkt('2026-01-14', [{ accountCode: '111', debit: '800' }, { accountCode: '3411', credit: '800', dueDate: '2026-12-31' }])); // vay ngắn hạn
  await ok(pkt('2026-01-15', [{ accountCode: '131', debit: '700', partyCode: 'KH3', dueDate: '2027-03-31' }, { accountCode: '511', credit: '700' }]));
  receipt = await ok(pkt('2026-02-01', [{ accountCode: '111', debit: '400', cashFlowCode: '06' }, { accountCode: '131', credit: '400', partyCode: 'KH1' }])); // thu khách hàng nhưng gắn mã 06
  await ok(pkt('2026-02-02', [{ accountCode: '3411', debit: '500' }, { accountCode: '111', credit: '500' }])); // trả nợ gốc không ghi hạn: giảm phần ngắn hạn trước
  other = await ok(pkt('2026-02-03', [{ accountCode: '111', debit: '150', cashFlowCode: '06' }, { accountCode: '3388', credit: '150' }])); // không cặp nào của B03 nhận N111/C3388
  await ok(pkt('2026-02-04', [{ accountCode: '111', debit: '200', cashFlowCode: '02' }, { accountCode: '331', credit: '200', partyCode: 'NCC1' }])); // người bán hoàn tiền: giảm mã 02
}, 90_000);
afterAll(async () => { await ctx.close(); });

describe('B01 TT99: kỳ hạn còn lại tại ngày lập báo cáo', () => {
  it('phải thu tách ngắn hạn/dài hạn theo hạn thanh toán của khoản; vay theo hạn đáo hạn ở dòng', async () => {
    const jun = await report('B01', '2026-06-30');
    expect(jun('131')).toBe('1300'); // KH1 ngắn hạn 1.000 - 400 + KH3 700 (hạn 31/03/2027 còn dưới 12 tháng)
    expect(jun('211')).toBe('2000'); // KH1 hạn 30/06/2028
    expect(jun('312')).toBe('300'); expect(jun('332')).toBe('0');
    expect(jun('311')).toBe('200'); expect(jun('331')).toBe('0'); // NCC1 dư Có không có hạn: ngắn hạn
    expect(jun('321')).toBe('300'); expect(jun('339')).toBe('5000'); // dư Có 5.300: phần dài hạn 5.000, trả nợ 500 không hạn trừ vào phần ngắn hạn 800
    expect(jun('320')).toBe('150'); expect(jun('338')).toBe('0');
    const jan = await report('B01', '2026-01-31');
    expect(jan('131')).toBe('1000'); expect(jan('211')).toBe('2700'); // tại 31/01/2026, hạn 31/03/2027 còn trên 12 tháng
    expect(jan('321')).toBe('800'); expect(jan('339')).toBe('5000');
  });
  it('truy ngược dòng dài hạn liệt kê đối tượng', async () => {
    const r = await call('GET', '/api/reports/financial/B01/lines/211?from=2026-01-01&to=2026-06-30'); expect(r.statusCode, r.body).toBe(200);
    expect(r.json().accounts).toEqual([expect.objectContaining({ accountCode: '131', partyCode: 'KH1', amount: '2000' })]);
    const s = await call('GET', '/api/reports/financial/B01/lines/131?from=2026-01-01&to=2026-06-30');
    expect((s.json().accounts as { partyCode: string; amount: string }[]).map((a) => [a.partyCode, a.amount])).toEqual([['KH1', '600'], ['KH3', '700']]);
  });
});

describe('B03 TT99 trực tiếp: mã luồng tiền ở dòng tiền', () => {
  it('dòng tiền có mã vào đúng chỉ tiêu, không mã rơi theo cặp đối ứng; 50 + 60 + 61 = 70', async () => {
    const b = await report('B03', '2026-06-30');
    expect(b('01')).toBe('300'); // KH2 không mã; KH1 400 có mã 06 nên không vào 01
    expect(b('02')).toBe('-200'); expect(b('06')).toBe('550'); expect(b('20')).toBe('1050');
    expect(b('33')).toBe('5800'); expect(b('34')).toBe('500'); expect(b('40')).toBe('5300');
    expect(b('50')).toBe('6350'); expect(b('60')).toBe('0'); expect(b('61')).toBe('0'); expect(b('70')).toBe('6350');
    const d = await call('GET', '/api/reports/financial/B03/lines/06?from=2026-01-01&to=2026-06-30'); expect(d.statusCode, d.body).toBe(200);
    expect((d.json().accounts as { accountCode: string; counterAccountCode: string; amount: string }[]).map((a) => [a.accountCode, a.counterAccountCode, a.amount])).toEqual([['111', '131', '400'], ['111', '3388', '150']]);
  });
  it('danh mục mã luồng tiền theo định nghĩa B03 của chế độ; kiểm mã và tài khoản tiền khi lưu', async () => {
    const r = await call('GET', '/api/cash-flow-codes?date=2026-03-01'); expect(r.statusCode, r.body).toBe(200);
    const codes = (r.json() as { code: string; name: string }[]).map((x) => x.code);
    expect(codes).toEqual(['01', '02', '03', '04', '05', '06', '07', '21', '22', '23', '24', '25', '26', '27', '31', '32', '33', '34', '35', '36']);
    for (const [lines, msg] of [
      [[{ accountCode: '111', debit: '1', cashFlowCode: '99' }, { accountCode: '511', credit: '1' }], /99/],
      [[{ accountCode: '111', debit: '1', cashFlowCode: '20' }, { accountCode: '511', credit: '1' }], /20/],
      [[{ accountCode: '111', debit: '1' }, { accountCode: '511', credit: '1', cashFlowCode: '01' }], /tiền/],
    ] as [Ln[], RegExp][]) { const x = await pkt('2026-03-01', lines); expect(x.statusCode, x.body).toBe(400); expect(x.json().error.code).toBe('CASH_FLOW_CODE_INVALID'); expect(x.json().error.message).toMatch(msg); }
  });
  it('soát lỗi báo dòng tiền chưa có mã; gắn mã sau ghi sổ qua sửa siêu dữ liệu, có nhật ký', async () => {
    const run = async () => { const r = await call('POST', '/api/data-check/run', { from: '2026-01-01', to: '2026-06-30', codes: ['LCTT_THIEU_MA'] }); expect(r.statusCode, r.body).toBe(200); return r.json().results as { voucherId: string; detail: string }[]; };
    const before = await run();
    expect(before.some((h) => h.voucherId === prepay.id)).toBe(true);
    expect(before.some((h) => h.voucherId === receipt.id)).toBe(false);
    const bad = await call('PUT', `/api/vouchers/${prepay.id}`, { version: prepay.version, lines: [{ lineNo: 2, cashFlowCode: '01' }] }); // dòng 131 không phải tài khoản tiền
    expect(bad.statusCode, bad.body).toBe(400);
    const u = await call('PUT', `/api/vouchers/${prepay.id}`, { version: prepay.version, lines: [{ lineNo: 1, cashFlowCode: '01' }] }); expect(u.statusCode, u.body).toBe(200);
    expect(u.json().lines[0].cashFlowCode).toBe('01');
    expect((await run()).some((h) => h.voucherId === prepay.id)).toBe(false);
    const audit = await ctx.t.admin.selectFrom('audit_event').select(['before', 'after']).where('tenant_id', '=', tenantId).where('entity', '=', 'voucher_line').execute();
    expect(audit.some((a) => (a.before as { cash_flow_code: string | null }).cash_flow_code === null && (a.after as { cash_flow_code: string | null }).cash_flow_code === '01')).toBe(true);
    expect((await report('B03', '2026-06-30'))('01')).toBe('300'); // cùng chỉ tiêu: số không đổi
  });
  it('chứng từ đảo chép mã luồng tiền nên luồng tiền của mã triệt tiêu', async () => {
    const r = await call('POST', `/api/vouchers/${other.id}/reverse`, { postingDate: '2026-02-10' }); expect(r.statusCode, r.body).toBe(201);
    expect((r.json().lines as { accountCode: string; cashFlowCode: string | null }[]).find((l) => l.accountCode === '111')!.cashFlowCode).toBe('06');
    const b = await report('B03', '2026-06-30');
    expect(b('06')).toBe('400'); expect(b('50')).toBe('6200'); expect(b('70')).toBe('6200');
  });
  it('chuyển tiền giữa hai tài khoản tiền không gắn được mã; cặp tiền sang tiền do ghép nhiều dòng bỏ mã, 50 + 60 + 61 = 70', async () => {
    const t = await pkt('2026-07-01', [{ accountCode: '112', debit: '700', cashFlowCode: '33' }, { accountCode: '111', credit: '700' }]);
    expect(t.statusCode, t.body).toBe(400); expect(t.json().error.code).toBe('CASH_FLOW_CODE_INVALID'); expect(t.json().error.message).toMatch(/chuyển tiền giữa các tài khoản tiền/);
    const plain = await ok(pkt('2026-07-01', [{ accountCode: '112', debit: '600' }, { accountCode: '111', credit: '600' }]));
    const meta = await call('PUT', `/api/vouchers/${plain.id}`, { version: plain.version, lines: [{ lineNo: 1, cashFlowCode: '33' }] });
    expect(meta.statusCode, meta.body).toBe(400); expect(meta.json().error.code).toBe('CASH_FLOW_CODE_INVALID');
    // Ghép Nợ/Có theo thứ tự dòng: cặp N111/C112 500 (tiền sang tiền, bỏ mã) và N111/C41111 500 (mã 01), N131/C41111 500 không phải tiền.
    await ok(pkt('2026-07-02', [{ accountCode: '111', debit: '1000', cashFlowCode: '01' }, { accountCode: '131', debit: '500', partyCode: 'KH2' }, { accountCode: '112', credit: '500' }, { accountCode: '41111', credit: '1000' }]));
    const r = await call('GET', '/api/reports/financial/B03?from=2026-07-01&to=2026-07-31'); expect(r.statusCode, r.body).toBe(200);
    const b = (c: string) => (r.json().rows as Row[]).find((x) => x.lineCode === c)!.current;
    expect(b('01')).toBe('500'); expect(b('33')).toBe('0'); expect(b('50')).toBe('500');
    expect(b('60')).toBe('6200'); expect(b('61')).toBe('0'); expect(b('70')).toBe('6700'); // 111: 6.200 - 600 + 1.000; 112: 600 - 500
  });
});
