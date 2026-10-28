import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

// GĐ6 Task 14b: cờ view_salary ở số dư đầu kỳ (334 theo nhân viên, nhóm TK lương/BH), nhật ký kiểm toán (dòng chứng từ, số dư đầu) và sổ quỹ/sổ tiền gửi (đối ứng 334).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let ctx: TestApp; let cookie: string; let tenantId: string; let userId: string; let full: string; let none: string;
const get = (url: string, c: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie: c } });
const send = (method: 'POST' | 'PUT', url: string, payload: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, payload });
const L = (accountCode: string, debit: string, credit: string, more: object = {}) => ({ accountCode, debit, credit, ...more });
async function userWith(flags: string[]) {
  const username = `ss_${Math.random().toString(36).slice(2, 8)}`;
  expect((await send('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_truong', sensitiveFlags: flags })).statusCode).toBe(201);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}
const pkt = async (date: string, description: string, lines: object[]) => {
  const r = await send('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description, autoPost: true, lines });
  expect(r.statusCode, r.body).toBe(201); return r.json() as Json;
};
const OB = (rows: object[]) => rows.map((r) => ({ currencyCode: 'VND', debit: '0', credit: '0', debitCurrency: '0', creditCurrency: '0', partyCode: null, ...r }));

beforeAll(async () => {
  ctx = await createTestApp();
  ({ cookie, tenantId, userId } = await setupLedgerTenant(ctx, `SS${Date.now()}`, 'TT99'));
  full = await userWith(['view_salary']); none = await userWith([]);
  expect((await send('POST', '/api/catalogs/employee', { code: 'NV01', name: 'Nguyễn Văn An' })).statusCode).toBe(201);
});
afterAll(async () => { await ctx.close(); });

describe('số dư đầu kỳ che lương', () => {
  it('thiếu view_salary: không xem, không sửa, không kiểm, không ghi sổ khi năm có số dư 334/BH; đủ cờ thì dùng bình thường; năm không có số dư lương thì không chặn', async () => {
    const rows = OB([{ accountCode: '111', debit: '50000000' }, { accountCode: '334', credit: '20000000' }, { accountCode: '4111', credit: '30000000' }]);
    expect((await send('PUT', '/api/opening-balance/2026', { rows }, full)).statusCode).toBe(200);
    const listed = await get('/api/opening-balance/2026', full);
    expect(listed.statusCode).toBe(200); expect((listed.json() as Json[]).map((r) => r.accountCode)).toContain('334');
    for (const url of ['/api/opening-balance/2026', '/api/opening-balance/2026/check']) {
      const r = await get(url, none);
      expect(r.statusCode, url).toBe(403); expect(r.json().error.code).toBe('SALARY_FORBIDDEN'); expect(r.body).not.toContain('20000000');
    }
    // Lưu cả bộ dòng bằng bản che sẽ ghi đè số lương: chặn ghi, ghi sổ, bỏ ghi sổ; nhập dòng có TK lương cũng chặn.
    expect((await send('PUT', '/api/opening-balance/2026', { rows }, none)).statusCode).toBe(403);
    expect((await send('POST', '/api/opening-balance/2026/post', {}, none)).statusCode).toBe(403);
    expect((await send('POST', '/api/opening-balance/2026/unpost', {}, none)).statusCode).toBe(403);
    // Bảo hiểm cũng là tài khoản lương: năm không có số dư lương nhưng dòng nhập thuộc 3383 thì chặn.
    await send('PUT', '/api/opening-balance/2026', { rows: [] }, full);
    expect((await send('PUT', '/api/opening-balance/2026', { rows: OB([{ accountCode: '3383', credit: '1000000' }, { accountCode: '111', debit: '1000000' }]) }, none)).statusCode).toBe(403);
    expect((await get('/api/opening-balance/2026', none)).statusCode).toBe(200); // không còn số dư lương
    expect((await send('PUT', '/api/opening-balance/2026', { rows: OB([{ accountCode: '111', debit: '5' }, { accountCode: '4111', credit: '5' }]) }, none)).statusCode).toBe(200);
  });
});

describe('nhật ký kiểm toán che lương', () => {
  it('sửa diễn giải dòng 334 đã ghi sổ và dòng số dư 334: người thiếu view_salary không thấy sự kiện (số, nhân viên); dòng TK khác vẫn thấy', async () => {
    const v = await pkt('2026-03-10', 'Tạm ứng lương', [L('334', '7777000', '0', { employeeCode: 'NV01' }), L('111', '0', '7777000')]);
    await pkt('2026-03-11', 'Chi khác', [L('6421', '123000', '0'), L('111', '0', '123000')]);
    await send('PUT', '/api/opening-balance/2026', { rows: OB([{ accountCode: '334', credit: '9999000' }, { accountCode: '4111', credit: '5001000' }, { accountCode: '111', debit: '15000000' }]) }, full);
    await send('PUT', '/api/opening-balance/2026', { rows: OB([{ accountCode: '334', credit: '9998000' }, { accountCode: '4111', credit: '5002000' }, { accountCode: '111', debit: '15000000' }]) }, full);
    // Sửa diễn giải dòng đã ghi sổ (cho phép tại chỗ): trigger ghi voucher_line trước/sau.
    await ctx.t.admin.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`.execute(trx);
      await sql`UPDATE voucher_line SET description = 'Sửa diễn giải' WHERE voucher_id = ${v.id}::uuid`.execute(trx);
    });
    const all = async (c: string) => (await get('/api/audit?size=500', c)).json() as { rows: { entity: string; before: Json | null; after: Json | null }[]; total: number };
    const withKey = (a: Awaited<ReturnType<typeof all>>, key: string) => a.rows.filter((r) => r.entity === 'voucher_line' || r.entity === 'opening_balance').filter((r) => JSON.stringify([r.before, r.after]).includes(key));
    const f = await all(full); const n = await all(none);
    expect(withKey(f, '7777000').length, 'đủ cờ thấy dòng 334 sửa diễn giải').toBeGreaterThan(0);
    expect(withKey(f, '9999000').length, 'đủ cờ thấy số dư đầu 334').toBeGreaterThan(0);
    expect(JSON.stringify(n.rows)).not.toContain('7777000'); expect(JSON.stringify(n.rows)).not.toContain('9999000'); expect(JSON.stringify(n.rows)).not.toContain('9998000');
    expect(n.total).toBeLessThan(f.total);
    // Hỏi thẳng thực thể cũng không lộ.
    for (const e of ['voucher_line', 'opening_balance']) expect(JSON.stringify((await get(`/api/audit?entity=${e}&size=500`, none)).json())).not.toMatch(/777700|999[89]000/);
    // Dòng của tài khoản thường (642, 111 không phải lương) vẫn có trong nhật ký của người thiếu cờ: cùng một sửa diễn giải, dòng thường.
    await ctx.t.admin.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`.execute(trx);
      await sql`UPDATE voucher_line SET description = 'Sửa 642' WHERE tenant_id = ${tenantId}::uuid AND description IS DISTINCT FROM 'x' AND voucher_id IN (SELECT id FROM voucher WHERE description = 'Chi khác')`.execute(trx);
    });
    expect(withKey(await all(none), '123000').length).toBeGreaterThan(0);
  });
});

describe('nhật ký kiểm toán: chứng từ không còn dòng lương (QĐ #986)', () => {
  it('sửa dòng đã ghi sổ của chứng từ lương, rồi bỏ ghi sổ và sửa nháp bỏ dòng 334: sự kiện cũ vẫn bị bỏ khi thiếu view_salary (lọc theo TK của chính sự kiện)', async () => {
    const v = await pkt('2026-05-10', 'Tạm ứng lương 2', [L('334', '8888000', '0', { employeeCode: 'NV01' }), L('111', '0', '8888000')]);
    await ctx.t.admin.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`.execute(trx);
      await sql`UPDATE voucher_line SET description = 'Sửa diễn giải 2' WHERE voucher_id = ${v.id}::uuid`.execute(trx);
    });
    expect((await send('POST', `/api/vouchers/${v.id}/unpost`, {})).statusCode).toBe(200);
    // Chứng từ đã có số không xóa được; sửa nháp thay cả bộ dòng (bỏ dòng 334) nên chứng từ không còn dòng lương để so.
    const cur = (await get(`/api/vouchers/${v.id}`, cookie)).json() as Json;
    const upd = await send('PUT', `/api/vouchers/${v.id}`, { voucherType: 'PKT', postingDate: '2026-05-10', documentDate: '2026-05-10', description: 'Đổi thành chi khác', version: cur.version, lines: [L('6421', '1000', '0'), L('111', '0', '1000')] });
    expect(upd.statusCode, upd.body).toBe(200);
    expect((await get('/api/audit?entity=voucher_line&size=500', full)).body).toContain('8888000');
    for (const url of ['/api/audit?size=500', '/api/audit?entity=voucher_line&size=500']) expect((await get(url, none)).body, url).not.toContain('8888000');
  });
});

describe('sổ quỹ và sổ tiền gửi che đối ứng lương', () => {
  it('chứng từ chi lương: thiếu view_salary mất TK đối ứng 334 và diễn giải (có tên nhân viên), số thu chi và số dư giữ nguyên; chứng từ thường không đổi', async () => {
    const v = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PC', postingDate: '2026-04-05', documentDate: '2026-04-05', description: 'Chi lương Nguyễn Văn An', autoPost: true,
      lines: [L('334', '4000000', '0', { employeeCode: 'NV01' }), L('111', '0', '4000000')] } });
    expect(v.statusCode, v.body).toBe(201);
    const pc = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PC', postingDate: '2026-04-06', documentDate: '2026-04-06', description: 'Mua văn phòng phẩm', autoPost: true,
      lines: [L('6421', '300000', '0'), L('111', '0', '300000')] } });
    expect(pc.statusCode, pc.body).toBe(201);
    const url = '/api/reports/cash-book?accountCode=111&from=2026-04-01&to=2026-04-30';
    const rowsOf = async (c: string) => ((await get(url, c)).json() as { rows: Json[]; closing: string }).rows;
    const fr = await rowsOf(full); const nr = await rowsOf(none);
    expect(fr.map((r) => [r.description, r.counterAccounts])).toEqual([['Chi lương Nguyễn Văn An', '334'], ['Mua văn phòng phẩm', '6421']]);
    expect(nr.map((r) => [r.description, r.counterAccounts])).toEqual([['Đã ẩn do thiếu quyền xem lương', 'Đã ẩn do thiếu quyền xem lương'], ['Mua văn phòng phẩm', '6421']]);
    expect(nr.map((r) => [r.out, r.balance])).toEqual(fr.map((r) => [r.out, r.balance])); // dòng tiền và số dư lũy kế không đổi
    const doc = await get(`${url}&format=html`, none);
    expect(doc.body).not.toContain('Nguyễn Văn An'); expect(doc.body).not.toMatch(/\b334\b/);
  });
});
