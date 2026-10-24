import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { D } from '@kt/domain';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';

// GĐ6 Task 8: chi lương theo lô bằng tệp CSV/Excel ánh xạ cột. 2026 = TT99, tháng 10. Tham số là Dữ liệu minh họa (payroll-20.json), không phải văn bản pháp lý.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fx = JSON.parse(readFileSync(new URL('../fixtures/payroll-20.json', import.meta.url), 'utf8')) as Json;
let ctx: TestApp; let owner: string; let noFlag: string; let noExport: string; let tenantId: string;
type M = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (method: M, url: string, cookie = owner, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const ok = async (method: M, url: string, payload?: object, cookie = owner) => {
  const r = await call(method, url, cookie, payload); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300); return r.statusCode === 204 ? null : r.json();
};
const fail = async (method: M, url: string, status: number, code: string, payload?: object, cookie = owner) => {
  const r = await call(method, url, cookie, payload); expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(status); expect(r.json().error.code).toBe(code); return r.json().error;
};
const R = '/api/payroll/runs', F = '/api/payroll/payment-formats';
const emp: Record<string, number> = {};
const CODES = ['NV01', 'NV03', 'NV05', 'NV09'];
const day = (d: number) => `2026-10-${String(d).padStart(2, '0')}`;
const body = ({ id: _id, ...f }: Json) => f; // PUT/preview không nhận id
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `pf_${Math.random().toString(36).slice(2, 8)}`;
  await ok('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}
async function setupEmployee(code: string, name: string, i: Json, bank: Json) {
  const id = Number((await ok('POST', '/api/catalogs/employee', { code, name, department_code: 'QL' })).id);
  const ins = i.insurance;
  await ok('PUT', `/api/payroll/profiles/${id}`, { taxResidency: i.taxResidency, contractType: i.contractType, region: 'I', siSalary: i.siSalary ?? null,
    siParticipates: ins.si, hiParticipates: ins.hi, uiParticipates: ins.ui, occupationalParticipates: ins.occupational, ...bank });
  await ok('POST', `/api/payroll/profiles/${id}/salary-history`, { validFrom: '2024-01-01', monthlySalary: i.segments[0].monthlySalary });
  for (const [k, d] of (i.dependents ?? []).entries()) await ok('POST', `/api/payroll/profiles/${id}/dependents`, { name: `Người phụ thuộc ${k + 1}`, relationship: 'child', fromMonth: '2024-01', toMonth: d.to ? d.to.slice(0, 7) : null });
  return id;
}
const file = async (batchId: number, cookie = owner) => { const r = await call('GET', `/api/payroll/payment-batches/${batchId}/file`, cookie); expect(r.statusCode, r.body).toBe(200); return r.rawPayload; };
const csvRows = (b: Buffer) => b.toString('utf8').replace(/^\uFEFF/, '').trimEnd().split('\r\n');

let run: Json; let bank: number; let general: Json; const net: Record<string, string> = {};
beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie: owner, tenantId } = await bootstrapTenant(ctx, { code: `PF${Date.now()}` }));
  await ok('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT99' });
  noFlag = await userWith('ketoan_truong', []);
  noExport = await userWith('ketoan_vien', ['view_salary']); // ketoan_vien không có payroll.export (0094)
  await ok('PUT', '/api/settings', { payroll_standard_hours_per_day: fx.settings.standardHoursPerDay, payroll_standard_days_per_month: fx.settings.standardDays });
  for (const [code, value] of Object.entries(fx.params)) await ok('PUT', '/api/payroll/params', { code, validFrom: '2024-01-01', value, source: fx.source });
  const ql = Number((await ok('POST', '/api/catalogs/department', { code: 'QL', name: 'Quản lý' })).id);
  await ok('PUT', '/api/payroll/cost-accounts', { items: [{ departmentId: ql, kind: 'payroll', role: 'admin' }] });
  const banks: Record<string, Json> = {
    NV01: { bankCode: 'VCB', bankName: 'Vietcombank', bankAccountNo: '0011001234567', bankAccountName: 'NGUYEN VAN AN' },
    NV03: {}, // thiếu số tài khoản nhận
    NV05: { bankName: 'Ngân hàng Á Châu', bankAccountNo: '00123', bankAccountName: null }, // số 0 đầu; tên người nhận lấy tên nhân viên
    NV09: { payMethod: 'cash', bankAccountNo: '0099887766' }, // trả tiền mặt
  };
  for (const c of CODES) { const e = (fx.employees as Json[]).find((x) => x.code === c)!; emp[c] = await setupEmployee(c, e.name, e.input, banks[c]!); }
  await ok('POST', '/api/catalogs/bank', { code: 'VCB', name: 'Vietcombank' });
  bank = Number((await ok('POST', '/api/catalogs/bank_account', { bank_code: 'VCB', account_no: '0071000999', account_name: 'CONG TY ABC', gl_account_code: '112', currency_code: 'VND' })).id);
  const cells: Json[] = [];
  for (const c of CODES) for (let d = 1; d <= 26; d++) cells.push({ employeeId: emp[c], date: day(d), entries: [{ kind: 'work_day', qty: '1' }] });
  await ok('PUT', '/api/attendance?year=2026&month=10', { cells });
  const created = await ok('POST', R, { year: 2026, month: 10, employeeIds: CODES.map((c) => emp[c]) });
  run = await ok('POST', `${R}/${created.id}/calculate`);
  for (const l of (await ok('GET', `${R}/${run.id}/lines`)) as Json[]) net[l.employeeCode] = l.net;
});
afterAll(async () => { await ctx.close(); });

describe('mẫu tệp chi lương', () => {
  it('có sẵn mẫu Chung (không gắn tên ngân hàng); CRUD; tên trùng 409; kiểm đầu vào', async () => {
    const list = await ok('GET', F);
    expect(list).toHaveLength(1);
    general = list[0];
    expect(general).toMatchObject({ name: 'Chung', fileType: 'csv', utf8Bom: true, hasHeader: true });
    expect(general.columns.map((c: Json) => c.field)).toEqual(['seq', 'account_no', 'account_name', 'bank_name', 'amount', 'content']);
    const body = { name: 'Mẫu thử', fileType: 'csv', columns: [{ field: 'account_no', header: 'STK' }, { field: 'amount', header: 'Tiền' }] };
    const c = await ok('POST', F, body);
    await fail('POST', F, 409, 'DUPLICATE', body);
    const u = await ok('PUT', `${F}/${c.id}`, { ...body, delimiter: ';', asciiOnly: true });
    expect(u).toMatchObject({ delimiter: ';', asciiOnly: true });
    await fail('POST', F, 400, 'VALIDATION', { ...body, name: 'X', columns: [{ field: 'account_no' }] }); // thiếu cột số tiền
    await fail('POST', F, 400, 'VALIDATION', { ...body, name: 'X', contentTemplate: 'Luong {salary}' }); // thẻ lạ
    await fail('POST', F, 400, 'VALIDATION', { ...body, name: 'X', columns: [...body.columns, { field: 'constant' }] }); // giá trị cố định thiếu giá trị
    await ok('DELETE', `${F}/${c.id}`);
    await fail('PUT', `${F}/${c.id}`, 404, 'PAYMENT_FORMAT_NOT_FOUND', body);
  });

  it('xem thử tối đa 5 dòng: dòng minh họa khi không chọn bảng lương, dữ liệu thật khi chọn', async () => {
    const f = { name: 'P', fileType: 'csv', asciiOnly: true, columns: [{ field: 'employee_name', header: 'Ten' }, { field: 'amount' }, { field: 'constant', header: 'Loai', value: 'LUONG' }] };
    const s = await ok('POST', `${F}/preview`, { format: f });
    expect(s).toMatchObject({ sample: true, recipientCount: 2 });
    expect(s.rows).toEqual([['Ten', 'So tien', 'Loai'], ['Nguyen Van An', '12500000', 'LUONG'], ['Tran Thi Bich', '9800000', 'LUONG']]);
    const real = await ok('POST', `${F}/preview`, { format: { ...f, hasHeader: false }, runId: run.id });
    expect(real.sample).toBe(false);
    expect(real.rows).toEqual([['Nguyen Van An', net.NV01, 'LUONG'], ['Hoang Van Em', net.NV05, 'LUONG']]);
    expect(real.warnings.map((w: Json) => w.code).sort()).toEqual(['PAY_METHOD_CASH', 'RECIPIENT_ACCOUNT_MISSING']);
    await fail('POST', `${F}/preview`, 404, 'PAYROLL_RUN_NOT_FOUND', { format: f, runId: 999999 });
  });
});

describe('xuất tệp chi lương', () => {
  it('bảng lương chưa hạch toán: 409', async () => {
    await fail('POST', `${R}/${run.id}/payment-file`, 409, 'PAYROLL_RUN_NOT_POSTED', { formatId: general.id });
    await ok('POST', `${R}/${run.id}/post`);
  });

  it('mẫu Chung: BOM UTF-8, tiêu đề, đúng cột và thứ tự; người thiếu tài khoản và trả tiền mặt thành cảnh báo, không vào tệp', async () => {
    const out = await ok('POST', `${R}/${run.id}/payment-file`, { formatId: general.id, bankAccountId: bank });
    expect(out).toMatchObject({ fileType: 'csv', count: 2, voucherId: null });
    expect(out.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RECIPIENT_ACCOUNT_MISSING', employeeCode: 'NV03', amount: net.NV03 }),
      expect.objectContaining({ code: 'PAY_METHOD_CASH', employeeCode: 'NV09', amount: net.NV09 }),
    ]));
    expect(out.warnings).toHaveLength(2);
    expect(out.total).toBe(D(net.NV01!).plus(net.NV05!).toFixed(0));
    expect(out.payableTotal).toBe(CODES.reduce((s, c) => s.plus(net[c]!), D(0)).toFixed(0));
    const buf = await file(out.batchId);
    expect(buf.subarray(0, 3).equals(BOM)).toBe(true);
    expect(csvRows(buf)).toEqual([
      'STT,Số tài khoản,Tên người nhận,Ngân hàng,Số tiền,Nội dung',
      `1,0011001234567,NGUYEN VAN AN,Vietcombank,${net.NV01},Lương tháng 10/2026 Nguyễn Văn An`,
      `2,00123,Hoàng Văn Em,Ngân hàng Á Châu,${net.NV05},Lương tháng 10/2026 Hoàng Văn Em`,
    ]);
    const batches = await ok('GET', `${R}/${run.id}/payment-batches`);
    expect(batches[0]).toMatchObject({ id: out.batchId, total: out.total, count: 2, formatName: 'Chung', bankAccountId: bank });
  });

  it('CSV tùy chọn: dấu chấm phẩy, không BOM, không tiêu đề, bỏ dấu tiếng Việt, ô có dấu phân cách được bọc nháy; giá trị cố định và tài khoản chi', async () => {
    const f = await ok('POST', F, { name: 'Tùy chọn', fileType: 'csv', delimiter: ';', utf8Bom: false, hasHeader: false, asciiOnly: true, contentTemplate: 'Luong; {run_name} {employee_code}',
      columns: [{ field: 'payer_account_no' }, { field: 'constant', value: 'VND' }, { field: 'account_no' }, { field: 'employee_name' }, { field: 'amount' }, { field: 'content' }] });
    const out = await ok('POST', `${R}/${run.id}/payment-file`, { formatId: f.id, bankAccountId: bank });
    const buf = await file(out.batchId);
    expect(buf.subarray(0, 3).equals(BOM)).toBe(false);
    expect(csvRows(buf)).toEqual([
      `0071000999;VND;0011001234567;Nguyen Van An;${net.NV01};"Luong; Bang luong thang 10/2026 NV01"`,
      `0071000999;VND;00123;Hoang Van Em;${net.NV05};"Luong; Bang luong thang 10/2026 NV05"`,
    ]);
  });

  it('Excel: số tài khoản giữ dạng chữ (số 0 đầu), số tiền là ô số, tiêu đề đậm', async () => {
    const f = await ok('POST', F, { name: 'Excel', fileType: 'xlsx', columns: [{ field: 'account_no', header: 'STK' }, { field: 'employee_name', header: 'Tên' }, { field: 'amount', header: 'Số tiền' }] });
    const out = await ok('POST', `${R}/${run.id}/payment-file`, { formatId: f.id });
    expect(out.fileName).toBe('chi_luong_2026_10.xlsx');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await file(out.batchId)) as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(1).values).toEqual([undefined, 'STK', 'Tên', 'Số tiền']);
    expect(ws.getRow(2).values).toEqual([undefined, '0011001234567', 'Nguyễn Văn An', Number(net.NV01)]);
    expect(ws.getRow(3).values).toEqual([undefined, '00123', 'Hoàng Văn Em', Number(net.NV05)]);
  });

  it('số tiền là chuỗi đồng nguyên, không qua number: 16 chữ số vượt 2^53 giữ nguyên từng chữ số', async () => {
    const big = '9007199254740993'; // 2^53 + 1: Number() làm tròn thành ...992
    await sql`UPDATE payroll_line SET net = ${big}::numeric WHERE run_id = ${run.id} AND employee_id = ${emp.NV01}`.execute(ctx.t.admin);
    const out = await ok('POST', `${R}/${run.id}/payment-file`, { formatId: general.id });
    expect(csvRows(await file(out.batchId))[1]).toContain(`,${big},`);
    expect(out.total).toBe(D(big).plus(net.NV05!).toFixed(0));
    await sql`UPDATE payroll_line SET net = ${net.NV01!}::numeric WHERE run_id = ${run.id} AND employee_id = ${emp.NV01}`.execute(ctx.t.admin);
  });

  it('phiếu chi lương: tổng cần chi (kể cả người không vào tệp) khớp phiếu thì xuất và gắn voucherId; lệch → 409; phiếu lạ → 409', async () => {
    const pv = await ok('POST', `${R}/${run.id}/pay-voucher`, { kind: 'bank', bankAccountId: bank, date: '2026-11-05' });
    const out = await ok('POST', `${R}/${run.id}/payment-file`, { formatId: general.id, bankAccountId: bank });
    expect(out).toMatchObject({ voucherId: pv.voucherId, payableTotal: pv.amount });
    expect(D(out.total).lt(pv.amount)).toBe(true); // tệp thiếu NV03 và NV09 nên nhỏ hơn phiếu; phần thiếu nằm ở cảnh báo
    expect(D(out.total).plus(out.warnings.reduce((s: ReturnType<typeof D>, w: Json) => s.plus(w.amount), D(0))).toFixed(0)).toBe(pv.amount);
    expect(await ok('POST', `${R}/${run.id}/payment-file`, { formatId: general.id, voucherId: pv.voucherId })).toMatchObject({ voucherId: pv.voucherId });
    await fail('POST', `${R}/${run.id}/payment-file`, 409, 'PAYMENT_VOUCHER_NOT_LINKED', { formatId: general.id, voucherId: '00000000-0000-4000-8000-000000000000' });
    await sql`UPDATE payroll_line SET net = net + 1 WHERE run_id = ${run.id} AND employee_id = ${emp.NV01}`.execute(ctx.t.admin);
    const e = await fail('POST', `${R}/${run.id}/payment-file`, 409, 'PAYMENT_TOTAL_MISMATCH', { formatId: general.id });
    expect(e.details).toMatchObject({ voucherId: pv.voucherId, voucherTotal: pv.amount });
    await sql`UPDATE payroll_line SET net = ${net.NV01!}::numeric WHERE run_id = ${run.id} AND employee_id = ${emp.NV01}`.execute(ctx.t.admin);
  });

  it('không ai đủ điều kiện vào tệp: 409 PAYMENT_FILE_EMPTY; mẫu không tồn tại: 404', async () => {
    await sql`UPDATE employee_payroll SET bank_account_no = NULL WHERE employee_id IN (${emp.NV01}, ${emp.NV05})`.execute(ctx.t.admin);
    const e = await fail('POST', `${R}/${run.id}/payment-file`, 409, 'PAYMENT_FILE_EMPTY', { formatId: general.id });
    expect(e.details.warnings.length).toBe(4);
    await fail('POST', `${R}/${run.id}/payment-file`, 404, 'PAYMENT_FORMAT_NOT_FOUND', { formatId: 999999 });
  });

  it('mẫu đã có lô dùng không xóa được (REFERENCED); nhật ký che nội dung tệp', async () => {
    await fail('DELETE', `${F}/${general.id}`, 409, 'REFERENCED');
    const a = await sql<{ content: string | null }>`SELECT "after"->>'file_content' AS content FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = 'payroll_payment_batch' AND action = 'insert'`.execute(ctx.t.admin);
    expect(a.rows.length).toBeGreaterThan(0);
    for (const r of a.rows) expect(r.content).toBe('***');
  });
});

describe('quyền', () => {
  it('thiếu view_salary: 403 SALARY_FORBIDDEN ở mọi route, cả tải lại tệp cũ; nhật ký lô bị che', async () => {
    const [b] = await ok('GET', `${R}/${run.id}/payment-batches`);
    expect((await file(b.id)).length).toBeGreaterThan(0);
    const exp = { formatId: general.id };
    await fail('GET', F, 403, 'SALARY_FORBIDDEN', undefined, noFlag);
    await fail('POST', F, 403, 'SALARY_FORBIDDEN', { name: 'Z', fileType: 'csv', columns: [{ field: 'amount' }] }, noFlag);
    await fail('POST', `${F}/preview`, 403, 'SALARY_FORBIDDEN', { format: body(general) }, noFlag);
    await fail('POST', `${R}/${run.id}/payment-file`, 403, 'SALARY_FORBIDDEN', exp, noFlag);
    await fail('GET', `${R}/${run.id}/payment-batches`, 403, 'SALARY_FORBIDDEN', undefined, noFlag);
    await fail('GET', `/api/payroll/payment-batches/${b.id}/file`, 403, 'SALARY_FORBIDDEN', undefined, noFlag);
    await fail('GET', '/api/audit?entity=payroll_payment_batch', 403, 'SALARY_FORBIDDEN', undefined, noFlag);
  });

  it('thiếu payroll.export: 403 FORBIDDEN ở mọi route dù có view_salary', async () => {
    const [b] = await ok('GET', `${R}/${run.id}/payment-batches`);
    await fail('GET', F, 403, 'FORBIDDEN', undefined, noExport);
    await fail('POST', `${F}/preview`, 403, 'FORBIDDEN', { format: body(general) }, noExport);
    await fail('POST', `${R}/${run.id}/payment-file`, 403, 'FORBIDDEN', { formatId: general.id }, noExport);
    await fail('GET', `${R}/${run.id}/payment-batches`, 403, 'FORBIDDEN', undefined, noExport);
    await fail('GET', `/api/payroll/payment-batches/${b.id}/file`, 403, 'FORBIDDEN', undefined, noExport);
  });
});
