import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Transaction } from 'kysely';
import { withTenant, type Database } from '@kt/db';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string; let userId: string;
type Res = { ruleCode: string; message: string; severity: string; ref: string | null; voucherId: string | null; detail: string | null };
const run = (body: object) => ctx.app.inject({ method: 'POST', url: '/api/data-check/run', headers: { cookie }, payload: body });
const results = async (body: object) => (await run(body)).json().results as Res[];
const ruleRow = async (code: string) => (await ctx.app.inject({ method: 'GET', url: `/api/catalogs/data_check_rule?q=${code}`, headers: { cookie } })).json().rows.find((r: { code: string }) => r.code === code);
const setRule = (id: number, payload: object) => ctx.app.inject({ method: 'PUT', url: `/api/catalogs/data_check_rule/${id}`, headers: { cookie }, payload });
// Quy tắc chỉ có thể do chủ sở hữu CSDL (migration/seed) thêm: kiểm thử dựng quy tắc xấu bằng kết nối owner.
const ownerRule = (code: string, sqlText: string, isSystem = false) => ctx.t.admin.insertInto('data_check_rule')
  .values({ tenant_id: tenantId, code, name: code, severity: 'warning', sql: sqlText, message: 'm', is_system: isSystem }).execute();
const disable = (...codes: string[]) => ctx.t.admin.updateTable('data_check_rule').set({ is_enabled: false }).where('tenant_id', '=', tenantId).where('code', 'in', codes).execute();
const range = { from: '2026-01-01', to: '2099-12-31' }; // gồm hôm nay: quy tắc HDDT_DANG_GUI dựng dòng theo now()
const voucherCount = async () => Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows[0]!.n);

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId, userId } = await bootstrapTenant(ctx, { code: `DC${Date.now()}` }));
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
    // Cả 50 câu SQL hệ thống biên dịch và chạy được trên lược đồ thật (một câu hỏng sẽ hiện thành "Quy tắc lỗi"). CT_KHONG_CAN không có dữ liệu để báo vì DB đã chặn chứng từ lệch.
    expect((r.json().results as Res[]).filter((x) => /Quy tắc lỗi/.test(x.message))).toEqual([]);
    // 4111 (dư Có) bị dư Nợ, 1111 và 1121 (dư Nợ) bị dư Có vì chưa có số dư đầu; 331 lưỡng tính thì không bị báo.
    const wrongSide = (r.json().results as Res[]).filter((x) => x.ruleCode === 'SO_DU_SAI_LOAI');
    expect(wrongSide.map((x) => x.ref).sort()).toEqual(['1111', '1121', '4111']);
    expect(r.json().ran).toBe(50);
    expect(r.json().skipped).toEqual([]); // chủ sở hữu có đủ cờ nhạy cảm
  }, 30_000);

  it('mọi công ty có đủ 50 quy tắc hệ thống bật sẵn; app_user không gọi được hàm seed', async () => {
    const rows = (await ctx.app.inject({ method: 'GET', url: '/api/catalogs/data_check_rule', headers: { cookie } })).json().rows as { code: string; is_system: boolean; is_enabled: boolean }[];
    expect(rows.map((x) => x.code)).toEqual(['CHUA_GHI_SO_TRONG_KY_KHOA', 'CN_LECH_SO_CAI', 'CN_QUA_HAN', 'CN_THIEU_DOI_TUONG', 'CT_KHONG_CAN', 'CT_KHONG_CO_DONG', 'GIA_THANH_154_CON_DU', 'GIA_THANH_621_622_627_CON_DU', 'GIA_THANH_CAN_CHAY_LAI', 'GIA_THANH_DAU_RA_KHONG_MA_HANG', 'GIA_THANH_THIEU_DINH_MUC', 'HDDT_CAN_DAO_GOC', 'HDDT_CHO_MA_CQT', 'HDDT_CHUA_PHAT_HANH', 'HDDT_DANG_GUI', 'HDDT_LOI', 'HDDV_CHUA_LAP_CT', 'HDDV_CHU_KY', 'HD_THIEU_MST', 'HD_TRUNG', 'HOP_DONG_QUA_HAN_DOT', 'HOP_DONG_VUOT_GIA_TRI', 'KHO_HANG_THIEU_KHO', 'KHO_LECH_SO_CAI', 'KHO_SAI_DVT', 'KHO_TON_0_CON_GIA_TRI', 'KHO_TON_AM', 'KHO_XUAT_CHUA_GIA_VON', 'KU_CHUA_TINH_LAI', 'KU_QUA_HAN', 'LCTT_THIEU_MA', 'LUONG_BH_VUOT_TRAN', 'LUONG_CAN_TINH_LAI', 'LUONG_LECH_SO_CAI', 'LUONG_NV_NGHI_VAN_TINH', 'LUONG_THIEU_MST', 'LUONG_THIEU_TK_NH', 'NH_CHUA_DOI_CHIEU', 'NH_LECH_SO_TIEN', 'SO_DU_SAI_LOAI', 'THUE_8_HET_HIEU_LUC', 'THUE_LECH', 'TIEN_MAT_VUOT_NGUONG', 'TK_NH_THIEU', 'TK_TONG_HOP_TREN_DONG', 'TS_DA_GIAM_CON_GIA_TRI', 'TS_HAO_MON_VUOT', 'TS_KHAU_HAO_CAN_CHAY_LAI', 'TS_THIEU_TAI_SAN', 'VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO']);
    expect(rows.every((x) => x.is_system && x.is_enabled)).toBe(true);
    // Công ty tạo trước migration cũng được bổ sung (backfill): không công ty nào thiếu quy tắc hệ thống.
    const thin = await sql<{ n: number }>`SELECT count(*)::int AS n FROM tenant t WHERE (SELECT count(*) FROM data_check_rule r WHERE r.tenant_id = t.id AND r.is_system) < 50`.execute(ctx.t.admin);
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
    const enabledNow = ((await ctx.app.inject({ method: 'GET', url: '/api/catalogs/data_check_rule', headers: { cookie } })).json().rows as { is_enabled: boolean }[]).filter((r) => r.is_enabled).length;
    expect((await results({ from: '2026-01-01', to: '2026-12-31', codes: ['CT_KHONG_CO_DONG'] })).length).toBeGreaterThan(0);
    expect((await setRule(id, { message: 'Chứng từ nháp trống', severity: 'error', fix_hint: 'Xóa đi' })).statusCode).toBe(200);
    const edited = (await results({ from: '2026-01-01', to: '2026-12-31', codes: ['CT_KHONG_CO_DONG'] }))[0]!;
    expect(edited).toMatchObject({ message: 'Chứng từ nháp trống', severity: 'error' });
    expect((await setRule(id, { is_enabled: false })).statusCode).toBe(200);
    const off = await run({ from: '2026-01-01', to: '2026-12-31', codes: ['CT_KHONG_CO_DONG'] });
    expect(off.json()).toEqual({ results: [], ran: 0, truncated: [], skipped: [] });
    const all = await run({ from: '2026-01-01', to: '2026-12-31' });
    expect((all.json().results as Res[]).some((x) => x.ruleCode === 'CT_KHONG_CO_DONG')).toBe(false);
    expect(all.json().ran).toBe(enabledNow - 1);
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

  it('giới hạn độ dài tên, thông điệp, hướng dẫn: API 400, app_user ghi thẳng vượt giới hạn bị CHECK từ chối (23514)', async () => {
    const id = (await ruleRow('CT_KHONG_CAN')).id;
    for (const bad of [{ name: 'x'.repeat(201) }, { message: 'x'.repeat(501) }, { fix_hint: 'x'.repeat(501) }]) {
      const r = await setRule(id, bad);
      expect(r.statusCode, r.body).toBe(400); expect(r.json().error.code).toBe('VALIDATION');
    }
    const at = await setRule(id, { name: 'n'.repeat(200), message: 'm'.repeat(500), fix_hint: 'h'.repeat(500) });
    expect(at.statusCode, at.body).toBe(200);
    await setRule(id, { name: 'Chứng từ không cân', message: 'Tổng Nợ khác tổng Có', fix_hint: 'Mở chứng từ và cân lại các dòng' });
    const as = <T>(fn: (trx: Transaction<Database>) => Promise<T>) => withTenant(ctx.t.db, { tenantId }, fn);
    await expect(as((trx) => sql`UPDATE data_check_rule SET name = repeat('x', 201) WHERE code = 'CT_KHONG_CAN'`.execute(trx))).rejects.toMatchObject({ code: '23514' });
    await expect(as((trx) => sql`UPDATE data_check_rule SET message = repeat('x', 501) WHERE code = 'CT_KHONG_CAN'`.execute(trx))).rejects.toMatchObject({ code: '23514' });
    await expect(as((trx) => sql`UPDATE data_check_rule SET fix_hint = repeat('x', 501) WHERE code = 'CT_KHONG_CAN'`.execute(trx))).rejects.toMatchObject({ code: '23514' });
  });

  it('quyền data_check.manage: admin và kế toán trưởng có, kế toán viên chỉ xem (403 khi sửa/bật tắt)', async () => {
    const username = `kv_${Date.now()}`;
    const mk = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username, fullName: 'KV', password: 'Matkhau1!', roleCode: 'ketoan_vien' } });
    expect(mk.statusCode, mk.body).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const kv = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
    const id = (await ruleRow('CT_KHONG_CAN')).id;
    for (const payload of [{ is_enabled: false }, { message: 'Sửa lén' }]) {
      const r = await ctx.app.inject({ method: 'PUT', url: `/api/catalogs/data_check_rule/${id}`, headers: { cookie: kv }, payload });
      expect(r.statusCode, r.body).toBe(403);
    }
    expect((await ctx.app.inject({ method: 'GET', url: '/api/catalogs/data_check_rule', headers: { cookie: kv } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/data-check/run', headers: { cookie: kv }, payload: range })).statusCode).toBe(200);
    expect((await ruleRow('CT_KHONG_CAN')).is_enabled).toBe(true);
    const holders = await sql<{ code: string }>`SELECT r.code FROM role_permission rp JOIN role r ON r.tenant_id = rp.tenant_id AND r.id = rp.role_id WHERE rp.tenant_id = ${tenantId}::uuid AND rp.permission_code = 'data_check.manage' ORDER BY r.code`.execute(ctx.t.admin);
    expect(holders.rows.map((x) => x.code)).toEqual(['admin', 'ketoan_truong']);
    // Công ty tạo trước migration cũng được cấp (backfill theo mã vai trò).
    const missing = await sql<{ n: number }>`SELECT count(*)::int AS n FROM role r WHERE r.code IN ('admin', 'ketoan_truong') AND NOT EXISTS (SELECT 1 FROM role_permission rp WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id AND rp.permission_code = 'data_check.manage')`.execute(ctx.t.admin);
    expect(missing.rows[0]!.n).toBe(0);
  });

  it('quy tắc đổi công ty của phiên (set_config app.current_tenant) bị phát hiện: 409 RULE_TENANT_CHANGED, cả lần soát bị hủy', async () => {
    await ownerRule('DOI_CONG_TY', "SELECT NULL::uuid, set_config('app.current_tenant', gen_random_uuid()::text, true), 'x'");
    try {
      const r = await run({ ...range, codes: ['DOI_CONG_TY'] });
      expect(r.statusCode, r.body).toBe(409); expect(r.json().error.code).toBe('RULE_TENANT_CHANGED');
      // Cả lần soát bị hủy, kể cả khi các quy tắc đứng trước đã chạy xong.
      const mixed = await run({ ...range, codes: ['CT_KHONG_CO_DONG', 'DOI_CONG_TY'] });
      expect(mixed.statusCode).toBe(409); expect(mixed.json().results).toBeUndefined();
    } finally { await disable('DOI_CONG_TY'); }
  });

  it('quy tắc đặt lại statement_timeout không ảnh hưởng quy tắc sau: mỗi quy tắc xong là đặt lại 15s', async () => {
    await ownerRule('TIMEOUT_A', "SELECT NULL::uuid, set_config('statement_timeout', '0', true), 'x'");
    await ownerRule('TIMEOUT_B', "SELECT NULL::uuid, current_setting('statement_timeout'), 'x'");
    try {
      const res = await results({ ...range, codes: ['TIMEOUT_A', 'TIMEOUT_B'] });
      expect(res.find((x) => x.ruleCode === 'TIMEOUT_B')!.ref).toBe('15s');
    } finally { await disable('TIMEOUT_A', 'TIMEOUT_B'); }
  });

  it('cắt kết quả ở 1000 dòng mỗi quy tắc và báo truncated; đúng 1000 dòng thì không cắt', async () => {
    await ownerRule('CAT_1000', "SELECT NULL::uuid, g::text, 'x' FROM generate_series(1, 1000) g WHERE $1::date < $2::date");
    await ownerRule('CAT_1001', "SELECT NULL::uuid, g::text, 'x' FROM generate_series(1, 1001) g WHERE $1::date < $2::date");
    try {
      const body = (await run({ ...range, codes: ['CAT_1000', 'CAT_1001'] })).json() as { results: Res[]; ran: number; truncated: string[] };
      expect(body.results.filter((x) => x.ruleCode === 'CAT_1000')).toHaveLength(1000);
      expect(body.results.filter((x) => x.ruleCode === 'CAT_1001')).toHaveLength(1000);
      expect(body.truncated).toEqual(['CAT_1001']);
    } finally { await disable('CAT_1000', 'CAT_1001'); }
  });

  it('mỗi công ty chỉ một lần soát tại một thời điểm: đang có lần khác giữ khóa thì 409 DATA_CHECK_RUNNING', async () => {
    await ctx.t.admin.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('data_check:' || ${tenantId}::text, 0))`.execute(trx);
      const r = await run(range);
      expect(r.statusCode, r.body).toBe(409); expect(r.json().error.code).toBe('DATA_CHECK_RUNNING');
    });
    expect((await run(range)).statusCode).toBe(200); // khóa theo giao dịch: nhả khi lần kia xong
  });

  it('phát hiện được CT_KHONG_CAN, CN_THIEU_DOI_TUONG, TK_TONG_HOP_TREN_DONG trên dữ liệu dựng bằng owner; chứng từ đã hủy không bị báo', async () => {
    // DB đã chặn chứng từ lệch và dòng sai bằng trigger; replica tắt trigger để dựng dữ liệu "bẩn" (như sau nhập thô) cho quy tắc có việc làm.
    const ids = await ctx.t.admin.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      const voucher = async (date: string, state: string, lines: [string, number, number][]) => {
        const v = await trx.insertInto('voucher').values({ tenant_id: tenantId, voucher_type: 'PKT', posting_date: date, document_date: date, state, created_by: userId }).returning('id').executeTakeFirstOrThrow();
        let no = 0;
        for (const [code, debit, credit] of lines) {
          no += 1;
          await sql`INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit)
            SELECT ${tenantId}::uuid, ${v.id}::uuid, ${no}, a.id, ${date}::date, ${debit}, ${credit} FROM account a WHERE a.tenant_id = ${tenantId}::uuid AND a.regime = 'TT133' AND a.code = ${code}`.execute(trx);
        }
        return v.id;
      };
      return {
        uneven: await voucher('2026-03-05', 'draft', [['1111', 100, 0], ['5111', 0, 90]]),
        noParty: await voucher('2026-04-05', 'draft', [['331', 50, 0], ['1111', 0, 50]]),
        group: await voucher('2026-05-05', 'draft', [['3331', 10, 0], ['1111', 0, 10]]),
        // đã hủy: vừa lệch, vừa thiếu đối tượng, vừa dùng tài khoản tổng hợp, nhưng không còn sửa được nên không được báo
        cancelled: await voucher('2026-06-05', 'cancelled', [['331', 100, 0], ['3331', 0, 90]]),
      };
    });
    const res = await results({ ...range, codes: ['CT_KHONG_CAN', 'CN_THIEU_DOI_TUONG', 'TK_TONG_HOP_TREN_DONG'] });
    expect(res.every((x) => !/Quy tắc lỗi/.test(x.message))).toBe(true);
    const of = (rule: string) => res.filter((x) => x.ruleCode === rule).map((x) => ({ voucherId: x.voucherId, detail: x.detail }));
    expect(of('CT_KHONG_CAN')).toEqual([{ voucherId: ids.uneven, detail: 'Nợ 100 / Có 90' }]);
    expect(of('CN_THIEU_DOI_TUONG')).toEqual([{ voucherId: ids.noParty, detail: 'TK 331 dòng 1' }]);
    expect(of('TK_TONG_HOP_TREN_DONG')).toEqual([{ voucherId: ids.group, detail: 'TK 3331' }]);
    expect(res.some((x) => x.voucherId === ids.cancelled)).toBe(false);
  }, 30_000);

  it('quy tắc GĐ5: hóa đơn điện tử, hóa đơn đầu vào, giao dịch ngân hàng (mỗi quy tắc một ca dương, một ca âm)', async () => {
    const ids = await ctx.t.admin.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      const voucher = async (date: string, state = 'posted', bankAcc: number | null = null, bankDebit = 0) => {
        const v = await trx.insertInto('voucher').values({ tenant_id: tenantId, voucher_type: 'PKT', posting_date: date, document_date: date, state, created_by: userId }).returning('id').executeTakeFirstOrThrow();
        if (bankAcc) await sql`INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, bank_account_id)
          SELECT ${tenantId}::uuid, ${v.id}::uuid, 1, a.id, ${date}::date, ${bankDebit}, 0, ${bankAcc} FROM account a WHERE a.tenant_id = ${tenantId}::uuid AND a.regime = 'TT133' AND a.code = '1121'`.execute(trx);
        return v.id;
      };
      const pending = async (v: string, flag: boolean) => sql`INSERT INTO voucher_invoice(tenant_id, voucher_id, direction, invoice_no, invoice_date, einvoice_pending, base_amount, tax_amount)
        VALUES (${tenantId}::uuid, ${v}::uuid, 'sale', ${flag ? null : 'N1'}, '2026-03-01', ${flag}, 0, 0)`.execute(trx);
      const prov = (await sql<{ id: string }>`INSERT INTO einvoice_provider(tenant_id, code, name) VALUES (${tenantId}::uuid, 'fake', 'F') RETURNING id`.execute(trx)).rows[0]!.id;
      const series = async (serial: string) => (await sql<{ id: string }>`INSERT INTO einvoice_series(tenant_id, provider_id, form_no, serial, year) VALUES (${tenantId}::uuid, ${prov}, '1', ${serial}, 2026) RETURNING id`.execute(trx)).rows[0]!.id;
      const sC = await series('C26TAA'); const sK = await series('K26TAA');
      const ein = async (v: string, o: { status: string; series?: string; at?: string; cqt?: string; reversal?: boolean; discarded?: boolean }) => sql`INSERT INTO einvoice(tenant_id, voucher_id, series_id, provider_id, status, transaction_uuid, cqt_status, needs_reversal, created_at, last_attempt_at, issued_at, discarded_at)
        VALUES (${tenantId}::uuid, ${v}::uuid, ${o.series ?? sK}, ${prov}, ${o.status}, gen_random_uuid(), ${o.cqt ?? 'none'}, ${o.reversal ?? false}, ${o.at ?? '2026-03-01T03:00:00Z'}, ${o.at ?? '2026-03-01T03:00:00Z'}, ${o.status === 'issued' ? (o.at ?? '2026-03-01T03:00:00Z') : null},
        ${o.discarded ? '2026-03-02T00:00:00Z' : null})`.execute(trx);
      const inbound = async (n: string, o: { status?: string; voucher?: string; valid?: boolean; date?: string }) => sql`INSERT INTO inbound_invoice(tenant_id, source, xml, xml_sha256, form_no, serial, invoice_no, issue_date, seller_name, status, voucher_id, seller_sig)
        VALUES (${tenantId}::uuid, 'upload', '<x/>', ${n}, '1', 'C26TAA', ${n}, ${o.date ?? '2026-03-01'}, 'NCC', ${o.status ?? 'new'}, ${o.voucher ?? null}, ${o.valid === undefined ? null : JSON.stringify({ valid: o.valid })}::jsonb)`.execute(trx);
      const bank = (await sql<{ id: string }>`INSERT INTO bank(tenant_id, code, name) VALUES (${tenantId}::uuid, 'VCBX', 'VCB') RETURNING id`.execute(trx)).rows[0]!.id;
      const acc = Number((await sql<{ id: string }>`INSERT INTO bank_account(tenant_id, bank_id, account_no, gl_account_code) VALUES (${tenantId}::uuid, ${bank}, 'GD5-1', '1121') RETURNING id`.execute(trx)).rows[0]!.id);
      const txn = async (n: string, o: { status?: string; voucher?: string; amount?: number }) => sql`INSERT INTO bank_transaction(tenant_id, bank_account_id, source, external_id, value_date, amount_in, status, voucher_id)
        VALUES (${tenantId}::uuid, ${acc}, 'manual', ${n}, '2026-03-01', ${o.amount ?? 100}, ${o.status ?? 'new'}, ${o.voucher ?? null})`.execute(trx);
      const x = {
        pendPos: await voucher('2026-03-01'), pendNeg: await voucher('2026-03-01'), pendDraft: await voucher('2026-03-01', 'draft'),
        sendPos: await voucher('2026-03-01'), sendNeg: await voucher('2026-03-01'),
        failPos: await voucher('2026-03-01'), failNeg: await voucher('2026-03-01'),
        cqtPos: await voucher('2026-03-01'), cqtNegK: await voucher('2026-03-01'), cqtNegAcc: await voucher('2026-03-01'),
        revPos: await voucher('2026-03-01'), revNeg: await voucher('2026-03-01'),
        sigPos: await voucher('2026-03-01'), sigNeg: await voucher('2026-03-01'),
        lechPos: await voucher('2026-03-01', 'draft', acc, 90), lechNeg: await voucher('2026-03-01', 'posted', acc, 100),
      };
      await pending(x.pendPos, true); await pending(x.pendNeg, false); await pending(x.pendDraft, true);
      await ein(x.sendPos, { status: 'sending' }); await ein(x.sendNeg, { status: 'sending', at: new Date().toISOString() });
      await ein(x.failPos, { status: 'failed' }); await ein(x.failNeg, { status: 'failed', discarded: true });
      await ein(x.cqtPos, { status: 'issued', series: sC, cqt: 'waiting' }); await ein(x.cqtNegK, { status: 'issued', series: sK, cqt: 'waiting' }); await ein(x.cqtNegAcc, { status: 'issued', series: sC, cqt: 'accepted' });
      await ein(x.revPos, { status: 'cancelled', reversal: true }); await ein(x.revNeg, { status: 'cancelled' });
      await inbound('IN1', {}); await inbound('IN2', { status: 'ignored' });
      await inbound('IN3', { status: 'voucher_created', voucher: x.sigPos, valid: false }); await inbound('IN4', { status: 'voucher_created', voucher: x.sigNeg, valid: true }); await inbound('IN5', { valid: false });
      await txn('T1', {}); await txn('T2', { status: 'ignored' });
      await txn('T3', { voucher: x.lechPos }); await txn('T4', { status: 'matched', voucher: x.lechNeg });
      return x;
    });
    const res = await results({ ...range, codes: ['HDDT_CHUA_PHAT_HANH', 'HDDT_DANG_GUI', 'HDDT_LOI', 'HDDT_CHO_MA_CQT', 'HDDT_CAN_DAO_GOC', 'HDDV_CHUA_LAP_CT', 'HDDV_CHU_KY', 'NH_CHUA_DOI_CHIEU', 'NH_LECH_SO_TIEN'] });
    expect(res.filter((x) => /Quy tắc lỗi/.test(x.message))).toEqual([]);
    const of = (rule: string) => res.filter((x) => x.ruleCode === rule);
    expect(of('HDDT_CHUA_PHAT_HANH').map((x) => x.voucherId)).toEqual([ids.pendPos]);
    expect(of('HDDT_DANG_GUI').map((x) => x.voucherId)).toEqual([ids.sendPos]);
    expect(of('HDDT_LOI').map((x) => x.voucherId)).toEqual([ids.failPos]);
    expect(of('HDDT_CHO_MA_CQT').map((x) => x.voucherId)).toEqual([ids.cqtPos]);
    expect(of('HDDT_CAN_DAO_GOC').map((x) => x.voucherId)).toEqual([ids.revPos]);
    expect(of('HDDV_CHUA_LAP_CT').map((x) => x.ref)).toEqual(['IN1', 'IN5']);
    expect(of('HDDV_CHU_KY').map((x) => x.voucherId)).toEqual([ids.sigPos]);
    expect(of('NH_CHUA_DOI_CHIEU').map((x) => x.voucherId)).toEqual([null, ids.lechPos]); // T1 và T3 (nháp gắn, trạng thái new); T2 đã bỏ qua, T4 đã đối chiếu không bị báo
    expect(of('NH_LECH_SO_TIEN').map((x) => ({ v: x.voucherId, d: x.detail }))).toEqual([{ v: ids.lechPos, d: 'Giao dịch 100, chứng từ 90' }]);
  }, 30_000);
});
