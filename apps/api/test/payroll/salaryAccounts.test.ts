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
    expect((await post('/api/fiscal-years', { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime, confirmRegimeOverride: true })).statusCode).toBe(201);
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

// QĐ #981–#983: cặp đối ứng ghép từng dòng 334 theo nhân viên với bên kia, nên sổ 6421/111 của người thiếu view_salary gộp đối ứng lương theo chứng từ và che diễn giải.
describe('sổ cái, sổ chi tiết TK không phải lương: đối ứng lương gộp theo chứng từ khi thiếu view_salary', () => {
  type Book = { rows: { voucherId: string; counterAccountCode: string; debit: string; credit: string; description: string | null }[]; totalDebit: string; totalCredit: string; closing: object };
  const book = async (path: 'detail' | 'account', code: string, from: string, to: string, c: string) => {
    const r = await get(`/api/reports/ledgers/${path}?accountCode=${code}&from=${from}&to=${to}`, c); expect(r.statusCode, r.body).toBe(200); return r.json() as Book;
  };
  it('bảng nhiều người (LU, chi lương) và bảng một người: không còn số, tên theo từng người; tổng và số dư không đổi; đủ cờ thấy đủ', async () => {
    const pc = (date: string, description: string, lines: object[]) => post('/api/vouchers', { voucherType: 'PC', postingDate: date, documentDate: date, description, autoPost: true, lines });
    await voucher('PKT', '2026-06-30', [{ accountCode: '6421', debit: '4100000' }, { accountCode: '334', credit: '1700000', employeeCode: 'NV1' }, { accountCode: '334', credit: '2400000', employeeCode: 'NV2' }]);
    const p6 = await pc('2026-06-30', 'Chi lương tháng 6', [{ accountCode: '334', debit: '1700000', employeeCode: 'NV1', description: 'Chi lương T6: Nhân viên 1' },
      { accountCode: '334', debit: '2400000', employeeCode: 'NV2', description: 'Chi lương T6: Nhân viên 2' }, { accountCode: '111', credit: '4100000' }]);
    expect(p6.statusCode, p6.body).toBe(201);
    const p7 = await pc('2026-07-31', 'Chi lương tháng 7 Nhân viên 1', [{ accountCode: '334', debit: '3300000', employeeCode: 'NV1', description: 'Chi lương T7: Nhân viên 1' }, { accountCode: '111', credit: '3300000' }]);
    expect(p7.statusCode, p7.body).toBe(201);
    for (const path of ['detail', 'account'] as const) for (const code of ['6421', '111']) {
      const f = await book(path, code, '2026-06-01', '2026-06-30', salary); const n = await book(path, code, '2026-06-01', '2026-06-30', none);
      expect(f.rows.filter((r) => r.counterAccountCode === '334').map((r) => r.debit === '0' ? r.credit : r.debit).sort(), `${path} ${code} đủ cờ`).toEqual(['1700000', '2400000']);
      const s = n.rows.filter((r) => r.counterAccountCode === '334');
      expect(s.map((r) => [r.debit === '0' ? r.credit : r.debit, r.description]), `${path} ${code} thiếu cờ`).toEqual([['4100000', 'Đã ẩn do thiếu quyền xem lương']]);
      expect(JSON.stringify(n)).not.toMatch(/1700000|2400000|Nhân viên/);
      expect([n.totalDebit, n.totalCredit, n.closing]).toEqual([f.totalDebit, f.totalCredit, f.closing]);
    }
    const html = await get('/api/reports/ledgers/detail?accountCode=6421&from=2026-06-01&to=2026-06-30&format=html', none);
    expect(html.statusCode).toBe(200); expect(html.body).toContain('4.100.000'); expect(html.body).not.toMatch(/1\.700\.000|2\.400\.000/);
    // Bảng một người: số chi là thực lĩnh của người đó (như sổ quỹ, QĐ #936), nhưng diễn giải có tên bị che ở sổ và ở dòng 334 của chứng từ.
    const one = await book('detail', '111', '2026-07-01', '2026-07-31', none);
    expect(one.rows.map((r) => [r.credit, r.description])).toEqual([['3300000', 'Đã ẩn do thiếu quyền xem lương']]);
    const v7 = (await get(`/api/vouchers/${p7.json().id}`, none)).json() as { lines: { accountCode: string; description: string | null }[] };
    expect(JSON.stringify(v7.lines)).not.toContain('Nhân viên 1');
    expect((await get(`/api/vouchers/${p7.json().id}`, salary)).body).toContain('Chi lương T7: Nhân viên 1');
  });

  it('sửa chiều dòng của chứng từ lương đã ghi sổ (thân chỉ meta): 403 SALARY_FORBIDDEN khi thiếu view_salary; chỉ sửa diễn giải đầu chứng từ thì được và phản hồi vẫn che', async () => {
    const v = await voucher('PC', '2026-08-05', [{ accountCode: '334', debit: '5100000', employeeCode: 'NV1' }, { accountCode: '111', credit: '5100000' }]);
    const cur = (await get(`/api/vouchers/${v.id}`, salary)).json() as { version: number; lines: { lineNo: number; accountCode: string }[] };
    const lineNo = cur.lines.find((l) => l.accountCode === '334')!.lineNo;
    const bad = await put(`/api/vouchers/${v.id}`, { version: cur.version, lines: [{ lineNo, employeeCode: 'NV2' }] }, none);
    expect(bad.statusCode, bad.body).toBe(403); expect(bad.json().error.code).toBe('SALARY_FORBIDDEN');
    const head = await put(`/api/vouchers/${v.id}`, { version: cur.version, description: 'Sửa đầu chứng từ' }, none);
    expect(head.statusCode, head.body).toBe(200); expect(head.json().lines.find((l: { accountCode: string }) => l.accountCode === '334')).toMatchObject({ debit: '0', employeeCode: null });
    const after = (await get(`/api/vouchers/${v.id}`, salary)).json() as { lines: { accountCode: string; employeeCode: string | null }[] };
    expect(after.lines.find((l) => l.accountCode === '334')!.employeeCode).toBe('NV1');
    expect((await put(`/api/vouchers/${v.id}`, { version: cur.version + 1, lines: [{ lineNo, employeeCode: 'NV2' }] }, salary)).statusCode).toBe(200);
  });
});
