import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// Nhóm tài khoản lương nhạy cảm theo chế độ kế toán của từng năm tài chính (coa-data/payroll/accounts.json): 2024 = TT133, 2025 = TT200, 2026 = TT99.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let ctx: TestApp; let owner: string; let none: string; let salary: string;
const get = (url: string, c = owner) => ctx.app.inject({ method: 'GET', url, headers: { cookie: c } });
const post = (url: string, payload: object, c = owner) => ctx.app.inject({ method: 'POST', url, headers: { cookie: c }, payload });
const put = (url: string, payload: object, c = owner) => ctx.app.inject({ method: 'PUT', url, headers: { cookie: c }, payload });
async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `sa_${roleCode}_${sensitiveFlags.length}_${Date.now()}`;
  expect((await post('/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags })).statusCode).toBe(201);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}
const detail = (code: string, year: number, c: string, extra = '') => get(`/api/reports/ledgers/detail?accountCode=${code}&from=${year}-01-01&to=${year}-12-31${extra}`, c);
const voucher = async (type: 'PKT' | 'PC', date: string, lines: object[], autoPost = true) => {
  const r = await post('/api/vouchers', { voucherType: type, postingDate: date, documentDate: date, description: `CT ${type} ${date}`, autoPost, lines });
  expect(r.statusCode, r.body).toBe(201); return r.json() as { id: string };
};

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie: owner } = await bootstrapTenant(ctx, { code: `SA${Date.now()}` }));
  for (const [fiscalYear, regime] of [[2024, 'TT133'], [2025, 'TT200'], [2026, 'TT99']] as const)
    expect((await post('/api/fiscal-years', { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime })).statusCode).toBe(201);
  none = await userWith('ketoan_truong', []); salary = await userWith('ketoan_truong', ['view_salary']);
}, 60_000);
afterAll(async () => { await ctx.close(); });

describe('nhận diện tài khoản lương theo chế độ của năm tài chính', () => {
  // [năm, mã, bị che khi thiếu view_salary?]: 3385 là BHTN ở TT133 nhưng là cổ phần hóa ở TT200; 3386 là ký quỹ ở TT133 nhưng là BHTN ở TT200 và TT99.
  const CASES: [number, string, boolean][] = [
    [2024, '334', true], [2024, '3382', true], [2024, '3383', true], [2024, '3384', true], [2024, '3385', true], [2024, '3386', false], [2024, '3335', false], [2024, '3381', false], [2024, '3387', false],
    [2025, '334', true], [2025, '3341', true], [2025, '3348', true], [2025, '3382', true], [2025, '3386', true], [2025, '3385', false], [2025, '3335', false],
    [2026, '334', true], [2026, '3382', true], [2026, '3383', true], [2026, '3384', true], [2026, '3386', true], [2026, '3335', false], [2026, '3388', false],
  ];
  it.each(CASES)('năm %i, TK %s: thiếu view_salary %s', async (year, code, masked) => {
    const r = await detail(code, year, none);
    if (masked) { expect(r.statusCode, r.body).toBe(403); expect(r.json().error.message).toBe('Không có quyền xem lương'); } else expect(r.statusCode, r.body).toBe(200);
    expect((await detail(code, year, salary)).statusCode).toBe(200);
  });
  it('TT99 không có 3385: 404 chứ không phải 403', async () => {
    expect((await detail('3385', 2026, none)).statusCode).toBe(404);
  });
  it('số dư: bỏ dòng tài khoản lương theo chế độ; 334 tổng hợp của TT200 chỉ trúng toàn tài khoản bị che thì 403', async () => {
    expect((await get('/api/balances?asOf=2025-12-31&accountCode=334', none)).statusCode).toBe(403);
    expect((await get('/api/balances?asOf=2024-12-31&accountCode=3386', none)).statusCode).toBe(200);
    expect((await get('/api/balances?asOf=2024-12-31&accountCode=3385', none)).statusCode).toBe(403);
    expect((await get('/api/balances?asOf=2025-12-31&accountCode=3385', none)).statusCode).toBe(200);
  });
  it('báo cáo hai năm lệch chế độ: bộ sổ/Nhật ký chung cần view_salary dù đủ ba cờ cũ', async () => {
    const three = await userWith('ketoan_truong', ['view_receivable', 'view_payable', 'view_cost']);
    expect((await get('/api/reports/ledgers/general-journal?from=2026-01-01&to=2026-12-31', three)).statusCode).toBe(403);
    expect((await get('/api/reports/ledgers/general-journal?from=2026-01-01&to=2026-12-31', owner)).statusCode).toBe(200);
  });
});

describe('che dòng lương ở chứng từ mọi loại (thiếu view_salary)', () => {
  let nv1: string; let pkt: string; let pc: string; let draft: string; let plain: string;
  const line = (v: { lines: { accountCode: string; debit: string; credit: string; employeeCode: string | null }[] }, code: string) => v.lines.find((l) => l.accountCode === code)!;
  beforeAll(async () => {
    expect((await post('/api/catalogs/employee', { code: 'NV1', name: 'Nhân viên 1' })).statusCode).toBe(201);
    expect((await post('/api/catalogs/employee', { code: 'NV2', name: 'Nhân viên 2' })).statusCode).toBe(201);
    nv1 = 'NV1';
    pkt = (await voucher('PKT', '2026-03-31', [{ accountCode: '6421', debit: '15000000' }, { accountCode: '334', credit: '9000000', employeeCode: 'NV1' }, { accountCode: '334', credit: '6000000', employeeCode: 'NV2' }])).id;
    pc = (await voucher('PC', '2026-04-05', [{ accountCode: '334', debit: '9000000', employeeCode: nv1 }, { accountCode: '111', credit: '9000000' }])).id;
    draft = (await voucher('PKT', '2026-04-30', [{ accountCode: '6421', debit: '100' }, { accountCode: '334', credit: '100', employeeCode: nv1 }], false)).id;
    plain = (await voucher('PKT', '2026-04-30', [{ accountCode: '6421', debit: '700' }, { accountCode: '111', credit: '700' }])).id;
  });

  it('GET chi tiết PKT và PC: dòng 334 mất số tiền và nhân viên, dòng khác giữ nguyên; đủ cờ thì thấy hết', async () => {
    const full = (await get(`/api/vouchers/${pkt}`, salary)).json();
    expect(line(full, '334').credit).toBe('9000000'); expect(line(full, '334').employeeCode).toBe('NV1'); expect(full.totalDebit).toBe('15000000'); expect(full.salaryRedacted).toBeUndefined();
    const r = await get(`/api/vouchers/${pkt}`, none); expect(r.statusCode, r.body).toBe(200);
    const v = r.json();
    expect(v.lines.filter((l: { accountCode: string }) => l.accountCode === '334').map((l: { debit: string; credit: string; employeeCode: unknown }) => [l.debit, l.credit, l.employeeCode])).toEqual([['0', '0', null], ['0', '0', null]]);
    expect(line(v, '6421').debit).toBe('15000000'); expect(v.totalDebit).toBeNull(); expect(v.salaryRedacted).toBe(true);
    expect(JSON.stringify(v)).not.toMatch(/9000000|6000000|NV1|NV2/);
    const p = (await get(`/api/vouchers/${pc}`, none)).json();
    expect(line(p, '334')).toMatchObject({ debit: '0', credit: '0', employeeCode: null }); expect(line(p, '111').credit).toBe('9000000');
    const clean = (await get(`/api/vouchers/${plain}`, none)).json();
    expect(clean.totalDebit).toBe('700'); expect(clean.salaryRedacted).toBeUndefined();
  });
  it('danh sách: tổng tiền che (null) với chứng từ có dòng lương, giữ với chứng từ khác', async () => {
    const rows = (await get('/api/vouchers?from=2026-03-01&to=2026-04-30&size=100', none)).json().rows as { id: string; totalDebit: string | null }[];
    const by = new Map(rows.map((r) => [r.id, r.totalDebit]));
    expect(by.get(pkt)).toBeNull(); expect(by.get(pc)).toBeNull(); expect(by.get(plain)).toBe('700');
    const full = (await get('/api/vouchers?from=2026-03-01&to=2026-04-30&size=100', salary)).json().rows as { id: string; totalDebit: string | null }[];
    expect(full.find((r) => r.id === pkt)!.totalDebit).toBe('15000000');
  });
  it('tìm kiếm theo từ khóa không lộ số tiền (kết quả cùng dạng danh sách đã che)', async () => {
    const rows = (await get('/api/vouchers?q=PKT&from=2026-03-01&to=2026-04-30', none)).json().rows as { id: string; totalDebit: string | null }[];
    expect(rows.find((r) => r.id === pkt)!.totalDebit).toBeNull();
  });
  it('tạo, ghi sổ, bỏ ghi sổ, nhân bản: phản hồi cũng che dòng lương, dữ liệu lưu đúng', async () => {
    const r = await post('/api/vouchers', { voucherType: 'PKT', postingDate: '2026-05-31', documentDate: '2026-05-31', description: 'Lương T5', lines: [{ accountCode: '6421', debit: '500' }, { accountCode: '334', credit: '500', employeeCode: nv1 }] }, none);
    expect(r.statusCode, r.body).toBe(201); const v = r.json();
    expect(line(v, '334')).toMatchObject({ debit: '0', credit: '0', employeeCode: null }); expect(v.totalDebit).toBeNull();
    const posted = (await post(`/api/vouchers/${v.id}/post`, {}, none)); expect(posted.statusCode, posted.body).toBe(200);
    expect(line(posted.json(), '334').credit).toBe('0');
    const dup = (await post(`/api/vouchers/${v.id}/duplicate`, { postingDate: '2026-05-31' }, none)).json();
    expect(line(dup, '334').credit).toBe('0');
    const stored = (await get(`/api/vouchers/${dup.id}`, salary)).json();
    expect(line(stored, '334')).toMatchObject({ credit: '500', employeeCode: 'NV1' }); // bản sao giữ số thật
  });
  it('in chứng từ có dòng lương: 403 khi thiếu view_salary (mẫu in cộng tiền theo dòng), chứng từ không có dòng lương in được', async () => {
    for (const id of [pkt, pc]) { const r = await get(`/api/vouchers/${id}/print`, none); expect(r.statusCode, r.body).toBe(403); expect(r.json().error.message).toBe('Không có quyền xem lương'); }
    expect((await get(`/api/vouchers/${pkt}/print`, salary)).statusCode).toBe(200);
    expect((await get(`/api/vouchers/${plain}/print`, none)).statusCode).toBe(200);
  });
  it('sửa cả bộ dòng của nháp có dòng lương: 403 khi thiếu view_salary (tránh ghi đè bằng bản che); đủ cờ thì sửa được', async () => {
    const cur = (await get(`/api/vouchers/${draft}`, salary)).json();
    const body = { voucherType: 'PKT', postingDate: cur.postingDate, documentDate: cur.documentDate, description: 'sửa', version: cur.version, lines: [{ accountCode: '6421', debit: '100' }, { accountCode: '334', credit: '100', employeeCode: nv1 }] };
    expect((await put(`/api/vouchers/${draft}`, body, none)).statusCode).toBe(403);
    const ok = await put(`/api/vouchers/${draft}`, body, salary); expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe('sổ chi tiết lọc theo nhân viên (employeeCode)', () => {
  it('thiếu view_salary: 403 với mọi tài khoản; đủ cờ: chỉ dòng của nhân viên đó', async () => {
    const r = await detail('6421', 2026, none, '&employeeCode=NV1');
    expect(r.statusCode, r.body).toBe(403); expect(r.json().error.message).toBe('Không có quyền xem lương');
    const nv = async (e: string) => { const x = await detail('334', 2026, salary, `&employeeCode=${e}`); expect(x.statusCode, x.body).toBe(200); return x.json() as { rows: { credit: string; debit: string }[]; totalCredit: string; totalDebit: string; closing: { credit: string } }; };
    const a = await nv('NV1'); const b = await nv('NV2');
    expect(a.totalCredit).toBe('9000500'); // 9.000.000 của PKT tháng 3 + 500 của PKT tháng 5 (nháp và bản nhân bản chưa ghi sổ không tính)
    expect(b.totalCredit).toBe('6000000');
    expect((await detail('334', 2026, salary, '&employeeCode=KHONG_CO')).statusCode).toBe(404);
    const all = (await detail('334', 2026, salary)).json() as { totalCredit: string };
    expect(Number(all.totalCredit)).toBeGreaterThan(Number(a.totalCredit));
  });
});
