import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Transaction } from 'kysely';
import { withTenant, type Database } from '@kt/db';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
type Res = { ruleCode: string; message: string; severity: string; ref: string | null };
const run = (body: object) => ctx.app.inject({ method: 'POST', url: '/api/data-check/run', headers: { cookie }, payload: body });
const results = async (body: object) => (await run(body)).json().results as Res[];
const ruleRow = async (code: string) => (await ctx.app.inject({ method: 'GET', url: `/api/catalogs/data_check_rule?q=${code}`, headers: { cookie } })).json().rows.find((r: { code: string }) => r.code === code);
const setRule = (id: number, payload: object) => ctx.app.inject({ method: 'PUT', url: `/api/catalogs/data_check_rule/${id}`, headers: { cookie }, payload });
// Quy tắc chỉ có thể do chủ sở hữu CSDL (migration/seed) thêm: kiểm thử dựng quy tắc xấu bằng kết nối owner.
const ownerRule = (code: string, sqlText: string, isSystem = false) => ctx.t.admin.insertInto('data_check_rule')
  .values({ tenant_id: tenantId, code, name: code, severity: 'warning', sql: sqlText, message: 'm', is_system: isSystem }).execute();
const voucherCount = async () => Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.n);

beforeAll(async () => {
  ctx = await createTestApp(); let userId: string; ({ cookie, tenantId, userId } = await bootstrapTenant(ctx, { code: `DC${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  // chứng từ nháp không dòng, kỳ khóa mềm
  await ctx.t.admin.insertInto('voucher').values({ tenant_id: tenantId, voucher_type: 'PKT', posting_date: '2026-01-15', document_date: '2026-01-15', created_by: userId }).execute();
  await ctx.app.inject({ method: 'POST', url: '/api/periods/2026/1/lock', headers: { cookie }, payload: { level: 'soft' } });
  // 331 là tài khoản lưỡng tính (loại dư 'both') nên dư Nợ do trả thừa không bị báo; 4111 (dư Có) bị dư Nợ thì bị báo
  await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code: 'NCC1', name: 'NCC', is_vendor: true } });
  await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: '2026-02-10', documentDate: '2026-02-10', description: 'trả thừa', autoPost: true, lines: [{ accountCode: '331', debit: '100', partyCode: 'NCC1' }, { accountCode: '1111', credit: '100' }] } });
  await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: '2026-02-11', documentDate: '2026-02-11', description: 'ghi nhầm vốn', autoPost: true, lines: [{ accountCode: '4111', debit: '100' }, { accountCode: '1121', credit: '100' }] } });
}, 30_000);
afterAll(async () => { await ctx.close(); });

describe('soát lỗi', () => {
  it('quy tắc hệ thống phát hiện chứng từ nháp không dòng trong kỳ khóa và số dư sai loại', async () => {
    const r = await run({ from: '2026-01-01', to: '2026-12-31' });
    expect(r.statusCode, r.body).toBe(200);
    const codes = (r.json().results as Res[]).map((x) => x.ruleCode);
    expect(codes).toEqual(expect.arrayContaining(['CT_KHONG_CO_DONG', 'CHUA_GHI_SO_TRONG_KY_KHOA', 'SO_DU_SAI_LOAI']));
    // Cả 6 câu SQL hệ thống biên dịch và chạy được trên lược đồ thật (một câu hỏng sẽ hiện thành "Quy tắc lỗi"). CT_KHONG_CAN không có dữ liệu để báo vì DB đã chặn chứng từ lệch.
    expect((r.json().results as Res[]).filter((x) => /Quy tắc lỗi/.test(x.message))).toEqual([]);
    // 4111 (dư Có) bị dư Nợ, 1111 và 1121 (dư Nợ) bị dư Có vì chưa có số dư đầu; 331 lưỡng tính thì không bị báo.
    const wrongSide = (r.json().results as Res[]).filter((x) => x.ruleCode === 'SO_DU_SAI_LOAI');
    expect(wrongSide.map((x) => x.ref).sort()).toEqual(['1111', '1121', '4111']);
    expect(r.json().ran).toBeGreaterThanOrEqual(6);
  }, 30_000);

  it('mọi công ty có đủ 6 quy tắc hệ thống bật sẵn; app_user không gọi được hàm seed', async () => {
    const rows = (await ctx.app.inject({ method: 'GET', url: '/api/catalogs/data_check_rule', headers: { cookie } })).json().rows as { code: string; is_system: boolean; is_enabled: boolean }[];
    expect(rows.map((x) => x.code)).toEqual(['CHUA_GHI_SO_TRONG_KY_KHOA', 'CN_THIEU_DOI_TUONG', 'CT_KHONG_CAN', 'CT_KHONG_CO_DONG', 'SO_DU_SAI_LOAI', 'TK_TONG_HOP_TREN_DONG']);
    expect(rows.every((x) => x.is_system && x.is_enabled)).toBe(true);
    // Công ty tạo trước migration cũng được bổ sung (backfill): không công ty nào thiếu quy tắc hệ thống.
    const thin = await sql<{ n: number }>`SELECT count(*)::int AS n FROM tenant t WHERE (SELECT count(*) FROM data_check_rule r WHERE r.tenant_id = t.id AND r.is_system) < 6`.execute(ctx.t.admin);
    expect(thin.rows[0]!.n).toBe(0);
    await expect(withTenant(ctx.t.db, { tenantId }, (trx) => sql`SELECT seed_data_check_rules(${tenantId}::uuid)`.execute(trx)))
      .rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/permission denied for function seed_data_check_rules/) });
  });

  it('(a) thêm quy tắc qua danh mục bị từ chối: SQL chỉ do hệ thống cung cấp', async () => {
    const add = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/data_check_rule', headers: { cookie }, payload: { code: 'DG_TRONG', name: 'Chứng từ thiếu diễn giải', severity: 'warning',
      sql: "SELECT v.id, v.voucher_no, 'x' FROM voucher v WHERE v.posting_date BETWEEN $1 AND $2", message: 'Chứng từ chưa có diễn giải' } });
    expect(add.statusCode, add.body).toBe(409);
    expect(add.json().error).toEqual({ code: 'RULE_SQL_SYSTEM_ONLY', message: 'Quy tắc soát lỗi chỉ do hệ thống cung cấp; chỉ được bật/tắt hoặc sửa thông điệp' });
    expect(await ruleRow('DG_TRONG')).toBeUndefined();
    // Nhập Excel cũng không phải đường vòng: danh mục này không có trong danh sách danh mục chung.
    const tpl = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/data_check_rule/template.xlsx', headers: { cookie } });
    expect(tpl.statusCode).toBe(404);
  });

  it('(b) app_user không INSERT/UPDATE sql/DELETE trực tiếp được (42501); chỉ sửa được các cột thông điệp', async () => {
    const as = <T>(fn: (trx: Transaction<Database>) => Promise<T>) => withTenant(ctx.t.db, { tenantId }, fn);
    await expect(as((trx) => sql`INSERT INTO data_check_rule(tenant_id, code, name, severity, sql, message) VALUES (${tenantId}::uuid, 'X', 'X', 'error', 'SELECT 1', 'x')`.execute(trx))).rejects.toMatchObject({ code: '42501' });
    await expect(as((trx) => sql`UPDATE data_check_rule SET sql = 'SELECT 1' WHERE code = 'CT_KHONG_CAN'`.execute(trx))).rejects.toMatchObject({ code: '42501' });
    await expect(as((trx) => sql`UPDATE data_check_rule SET code = 'KHAC' WHERE code = 'CT_KHONG_CAN'`.execute(trx))).rejects.toMatchObject({ code: '42501' });
    await expect(as((trx) => sql`DELETE FROM data_check_rule WHERE code = 'CT_KHONG_CAN'`.execute(trx))).rejects.toMatchObject({ code: '42501' });
    await expect(as((trx) => sql`UPDATE data_check_rule SET message = 'Mới' WHERE code = 'CT_KHONG_CAN'`.execute(trx))).resolves.toBeDefined();
    // Qua API: khóa lạ (code, sql) bị schema strict từ chối.
    const id = (await ruleRow('CT_KHONG_CAN')).id;
    for (const bad of [{ sql: 'SELECT 1' }, { code: 'KHAC' }]) {
      const r = await setRule(id, bad);
      expect(r.statusCode, r.body).toBe(400); expect(r.json().error.code).toBe('VALIDATION');
    }
    expect((await ruleRow('CT_KHONG_CAN')).sql).toMatch(/^SELECT v\.id/);
    await ctx.t.admin.updateTable('data_check_rule').set({ message: 'Tổng Nợ khác tổng Có' }).where('tenant_id', '=', tenantId).where('code', '=', 'CT_KHONG_CAN').execute();
  });

  it('(c) tắt quy tắc qua danh mục thì không chạy nữa; sửa thông điệp và mức có hiệu lực ở lần chạy sau', async () => {
    const id = (await ruleRow('CT_KHONG_CO_DONG')).id;
    expect((await results({ from: '2026-01-01', to: '2026-12-31', codes: ['CT_KHONG_CO_DONG'] })).length).toBeGreaterThan(0);
    expect((await setRule(id, { message: 'Chứng từ nháp trống', severity: 'error', fix_hint: 'Xóa đi' })).statusCode).toBe(200);
    const edited = (await results({ from: '2026-01-01', to: '2026-12-31', codes: ['CT_KHONG_CO_DONG'] }))[0]!;
    expect(edited).toMatchObject({ message: 'Chứng từ nháp trống', severity: 'error' });
    expect((await setRule(id, { is_enabled: false })).statusCode).toBe(200);
    const off = await run({ from: '2026-01-01', to: '2026-12-31', codes: ['CT_KHONG_CO_DONG'] });
    expect(off.json()).toEqual({ results: [], ran: 0 });
    const all = await run({ from: '2026-01-01', to: '2026-12-31' });
    expect((all.json().results as Res[]).some((x) => x.ruleCode === 'CT_KHONG_CO_DONG')).toBe(false);
    expect(all.json().ran).toBe(5);
    expect((await setRule(id, { is_enabled: true, message: 'Chứng từ nháp rỗng', severity: 'warning', fix_hint: 'Xóa chứng từ hoặc nhập dòng' })).statusCode).toBe(200);
  }, 30_000);

  it('không xóa được quy tắc hệ thống (409 RULE_SYSTEM), kể cả khi xóa trực tiếp bằng quyền chủ sở hữu', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/data_check_rule?q=CT_KHONG_CAN', headers: { cookie } });
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/catalogs/data_check_rule/${list.json().rows[0].id}`, headers: { cookie } });
    expect(del.statusCode).toBe(409); expect(del.json().error.code).toBe('RULE_SYSTEM');
    const gone = await ctx.app.inject({ method: 'DELETE', url: '/api/catalogs/data_check_rule/999999999', headers: { cookie } });
    expect(gone.statusCode).toBe(404);
    await expect(sql`DELETE FROM data_check_rule WHERE tenant_id = ${tenantId}::uuid AND code = 'CT_KHONG_CAN'`.execute(ctx.t.admin)).rejects.toMatchObject({ message: expect.stringMatching(/RULE_SYSTEM/) });
  });

  it('(d) quy tắc hệ thống lỗi SQL cho kết quả "Quy tắc lỗi" và các quy tắc khác vẫn chạy', async () => {
    await ownerRule('AAA_LOI', 'SELECT cot_khong_ton_tai, 1, 2 FROM voucher WHERE posting_date BETWEEN $1 AND $2', true);
    const res = await results({ from: '2026-01-01', to: '2026-12-31' }); // AAA_LOI xếp trước mọi quy tắc khác
    const bad = res.find((x) => x.ruleCode === 'AAA_LOI')!;
    expect(bad.message).toMatch(/Quy tắc lỗi/); expect(bad.severity).toBe('error');
    expect(res.map((x) => x.ruleCode)).toEqual(expect.arrayContaining(['CT_KHONG_CO_DONG', 'SO_DU_SAI_LOAI']));
    await ctx.t.admin.updateTable('data_check_rule').set({ is_enabled: false }).where('tenant_id', '=', tenantId).where('code', '=', 'AAA_LOI').execute();
  }, 30_000);

  it('(e) quy tắc ghi dữ liệu bị chế độ chỉ đọc từ chối, số chứng từ không đổi', async () => {
    const before = await voucherCount();
    await ownerRule('GHI_XOA', "DELETE FROM voucher WHERE tenant_id = app_tenant() RETURNING id AS voucher_id, voucher_no AS ref, '' AS detail");
    await ownerRule('GHI_SEQ', "SELECT NULL::uuid, nextval('account_id_seq')::text, 'x' WHERE $1::date < $2::date");
    const res = await results({ from: '2026-01-01', to: '2026-12-31', codes: ['GHI_XOA', 'GHI_SEQ'] });
    expect(res).toHaveLength(2);
    for (const x of res) expect(x.message).toMatch(/Quy tắc lỗi/);
    expect(res.find((x) => x.ruleCode === 'GHI_SEQ')!.message).toMatch(/read-only transaction/); // thực sự do chế độ chỉ đọc, không phải lỗi cú pháp
    expect(await voucherCount()).toBe(before);
  });

  it('(f) quy tắc nhiều câu lệnh bị từ chối thay vì chạy hai lần', async () => {
    const before = await voucherCount();
    await ownerRule('NHIEU_CAU', "SELECT v.id, v.voucher_no, 'a' FROM voucher v WHERE v.posting_date BETWEEN $1 AND $2; SELECT NULL::uuid, 'b', 'b'");
    await ownerRule('CHEN_CAU', "SELECT NULL::uuid, '', '' WHERE $1::date < $2::date) q; DELETE FROM voucher; SELECT * FROM (SELECT NULL::uuid, '', ''");
    const res = await results({ from: '2026-01-01', to: '2026-12-31', codes: ['NHIEU_CAU', 'CHEN_CAU'] });
    expect(res).toHaveLength(2);
    for (const x of res) expect(x.message).toMatch(/Quy tắc lỗi/);
    expect(res.find((x) => x.ruleCode === 'CHEN_CAU')!.message).toMatch(/multiple commands/);
    expect(await voucherCount()).toBe(before);
  });

  it('mỗi lần chạy đặt chế độ chỉ đọc và statement_timeout 15s ngay trong giao dịch', async () => {
    await ownerRule('CAI_DAT', "SELECT NULL::uuid, current_setting('statement_timeout') || '/' || current_setting('transaction_read_only'), 'x'");
    expect(await results({ from: '2026-01-01', to: '2026-12-31', codes: ['CAI_DAT'] })).toMatchObject([{ ruleCode: 'CAI_DAT', ref: '15s/on' }]);
  });

  it('tham số ngày là tham số thật: ngày sai định dạng bị Zod từ chối, quy tắc không dùng $1 vẫn chạy', async () => {
    expect((await run({ from: "2026-01-01'; DROP TABLE voucher; --", to: '2026-12-31' })).statusCode).toBe(400);
    await ownerRule('CHI_DUNG_TO', "SELECT NULL::uuid, $2::text, 'x'");
    const res = await results({ from: '2026-01-01', to: '2026-12-31', codes: ['CHI_DUNG_TO'] });
    expect(res).toMatchObject([{ ruleCode: 'CHI_DUNG_TO', ref: '2026-12-31' }]);
  });
});
