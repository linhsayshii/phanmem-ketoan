import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { isReportComplete, loadCoaTemplate, loadLegalParams, loadReportTemplates, REPORT_CODES, REPORT_REGIMES } from '@kt/coa-data';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, createPool } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import type { TestDb } from '../src/testing.js';
import { syncReferenceData } from '../src/reference.js';

// File này sửa coa_template/report_template toàn cục nên chạy trên DB tạm riêng, không dùng chung DB của lần chạy.
const dbName = `ketoan_ref_${randomBytes(4).toString('hex')}`;
const withDb = (url: string): string => { const u = new URL(url); u.pathname = `/${dbName}`; return u.toString(); };
const baseAdmin = process.env.DATABASE_ADMIN_URL!;
const adminUrl = withDb(baseAdmin);
const admin = async (text: string): Promise<void> => { const c = new pg.Client({ connectionString: baseAdmin }); await c.connect(); try { await c.query(text); } finally { await c.end(); } };

let t: TestDb; // beforeAll có thể hỏng trước khi gán: afterAll dùng t?. để vẫn xóa DB tạm
beforeAll(async () => {
  await admin(`CREATE DATABASE ${dbName}`);
  await migrate(adminUrl);
  await syncReferenceData(adminUrl);
  const adminPool = createPool(adminUrl);
  const appPool = createPool(withDb(process.env.DATABASE_URL!));
  t = { admin: createDb(adminPool), db: createDb(appPool), close: async () => { await adminPool.end(); await appPool.end(); } };
});
afterAll(async () => { await t?.close(); await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); });

const count = async (regime: string): Promise<number> =>
  Number((await sql<{ n: string }>`SELECT count(*) AS n FROM coa_template WHERE regime = ${regime}`.execute(t.admin)).rows[0]!.n);

describe('dữ liệu tham chiếu', () => {
  it('permission và coa_template được nạp, app_user không sửa được', async () => {
    const p = await sql<{ n: string }>`SELECT count(*) AS n FROM permission`.execute(t.admin);
    expect(Number(p.rows[0]!.n)).toBeGreaterThan(30);
    const c = await sql<{ regime: string; n: string }>`SELECT regime, count(*) AS n FROM coa_template GROUP BY regime ORDER BY regime`.execute(t.admin);
    expect(String(c.rows.find((r) => r.regime === 'TT133')!.n)).toMatch(/^\d{3}$/);  // int8 được parse thành number
    expect(await count('TT133')).toBe(loadCoaTemplate('TT133').length);
    expect(await count('TT200')).toBe(loadCoaTemplate('TT200').length);
    expect(await count('TT99')).toBe(loadCoaTemplate('TT99').length);
    await expect(sql`INSERT INTO coa_template(regime, code, name, root_type, normal_balance, source) VALUES ('TT133','999','x','asset','debit','x')`.execute(t.db)).rejects.toThrow(/permission denied/);
  });
  it('đồng bộ lại là upsert: sửa dòng lệch, xóa dòng không còn trong CSV, giữ nguyên số dòng', async () => {
    const expected = loadCoaTemplate('TT133').length;
    await sql`UPDATE coa_template SET name = 'sai' WHERE regime = 'TT133' AND code = '111'`.execute(t.admin);
    await sql`INSERT INTO coa_template(regime, code, name, root_type, normal_balance, source) VALUES ('TT133','999','thừa','asset','debit','x'), ('TT99','999','thừa','asset','debit','x')`.execute(t.admin);
    await syncReferenceData(adminUrl);
    expect(await count('TT133')).toBe(expected);
    expect(await count('TT99')).toBe(loadCoaTemplate('TT99').length);
    const r = await sql<{ name: string }>`SELECT name FROM coa_template WHERE regime = 'TT133' AND code = '111'`.execute(t.admin);
    expect(r.rows[0]!.name).toBe(loadCoaTemplate('TT133').find((x) => x.code === '111')!.name);
  });
  it('mẫu báo cáo: bộ chờ văn bản không vào bảng mẫu hệ thống, bộ hoàn tất vào đủ dòng, dòng thừa bị xóa khi đồng bộ, app_user không sửa được', async () => {
    const n = async (regime: string, code: string): Promise<number> =>
      Number((await sql<{ n: string }>`SELECT count(*) AS n FROM report_template WHERE regime = ${regime} AND report_code = ${code}`.execute(t.admin)).rows[0]!.n);
    await sql`INSERT INTO report_template(regime, report_code, line_code, label, source, side, sort_order) VALUES ('TT133','B01','999','thừa','balance','net_debit',1), ('TT200','B02','999','thừa','balance','net_debit',1)`.execute(t.admin);
    await syncReferenceData(adminUrl);
    for (const regime of REPORT_REGIMES) for (const code of REPORT_CODES) {
      const expected = isReportComplete(regime, code) ? loadReportTemplates({ onlyComplete: true }).filter((r) => r.regime === regime && r.reportCode === code).length : 0;
      expect(await n(regime, code), `${regime}/${code}`).toBe(expected);
    }
    expect(await n('TT200', 'B02')).toBeGreaterThan(0); // dòng thừa 999 của TT200 đã bị xóa khi đồng bộ (đếm khớp tệp ở vòng lặp trên)
    await expect(sql`INSERT INTO report_template(regime, report_code, line_code, label, source, side, sort_order) VALUES ('TT133','B01','1','x','balance','net_debit',1)`.execute(t.db)).rejects.toThrow(/permission denied/);
  });
  it('legal_param nạp từ legal-params.json; đồng bộ lại là upsert theo (mã, ngày hiệu lực): sửa dòng lệch, xóa dòng không còn trong tệp; app_user không sửa được', async () => {
    const rows = async () => (await sql<{ code: string; value: unknown; valid_from: string; valid_to: string | null; source: string }>`SELECT code, value, to_char(valid_from, 'YYYY-MM-DD') AS valid_from, to_char(valid_to, 'YYYY-MM-DD') AS valid_to, source FROM legal_param ORDER BY code, valid_from`.execute(t.admin)).rows;
    const file = loadLegalParams().map((r) => ({ code: r.code, value: r.value, valid_from: r.validFrom, valid_to: r.validTo, source: r.source })).sort((a, b) => a.code.localeCompare(b.code) || a.valid_from.localeCompare(b.valid_from));
    expect(await rows()).toEqual(file);
    await sql`UPDATE legal_param SET value = '"TT00"', source = 'sai' WHERE code = 'vat_return_template' AND valid_from = '2026-07-01'`.execute(t.admin);
    await sql`INSERT INTO legal_param(code, value, valid_from, source) VALUES ('thua', '1', '2020-01-01', 'x')`.execute(t.admin);
    await syncReferenceData(adminUrl);
    await syncReferenceData(adminUrl);
    expect(await rows()).toEqual(file);
    await expect(sql`INSERT INTO legal_param(code, value, valid_from, source) VALUES ('x', '1', '2020-01-01', 'x')`.execute(t.db)).rejects.toThrow(/permission denied/);
    await expect(sql`INSERT INTO legal_param(code, value, valid_from, source) VALUES ('vat_return_template', '1', '2026-07-01', 'x')`.execute(t.admin)).rejects.toThrow(/duplicate key/);
  });
});
