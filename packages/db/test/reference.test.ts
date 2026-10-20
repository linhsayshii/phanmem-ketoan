import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { isReportComplete, loadCoaTemplate, loadReportTemplates, REPORT_CODES, REPORT_REGIMES } from '@kt/coa-data';
import { setupTestDb, type TestDb } from '../src/testing.js';
import { syncReferenceData } from '../src/reference.js';

let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });

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
    expect(await count('TT99')).toBe(0);
    await expect(sql`INSERT INTO coa_template(regime, code, name, root_type, normal_balance, source) VALUES ('TT133','999','x','asset','debit','x')`.execute(t.db)).rejects.toThrow(/permission denied/);
  });
  it('đồng bộ lại là upsert: sửa dòng lệch, xóa dòng không còn trong CSV, giữ nguyên số dòng', async () => {
    const expected = loadCoaTemplate('TT133').length;
    await sql`UPDATE coa_template SET name = 'sai' WHERE regime = 'TT133' AND code = '111'`.execute(t.admin);
    await sql`INSERT INTO coa_template(regime, code, name, root_type, normal_balance, source) VALUES ('TT133','999','thừa','asset','debit','x'), ('TT99','111','thừa','asset','debit','x')`.execute(t.admin);
    await syncReferenceData(process.env.DATABASE_ADMIN_URL!);
    expect(await count('TT133')).toBe(expected);
    expect(await count('TT99')).toBe(0);
    const r = await sql<{ name: string }>`SELECT name FROM coa_template WHERE regime = 'TT133' AND code = '111'`.execute(t.admin);
    expect(r.rows[0]!.name).toBe(loadCoaTemplate('TT133').find((x) => x.code === '111')!.name);
  });
  it('mẫu báo cáo: bộ chờ văn bản không vào bảng mẫu hệ thống, bộ hoàn tất vào đủ dòng, dòng thừa bị xóa khi đồng bộ, app_user không sửa được', async () => {
    const n = async (regime: string, code: string): Promise<number> =>
      Number((await sql<{ n: string }>`SELECT count(*) AS n FROM report_template WHERE regime = ${regime} AND report_code = ${code}`.execute(t.admin)).rows[0]!.n);
    await sql`INSERT INTO report_template(regime, report_code, line_code, label, source, side, sort_order) VALUES ('TT133','B01','999','thừa','balance','net_debit',1), ('TT200','B02','999','thừa','balance','net_debit',1)`.execute(t.admin);
    await syncReferenceData(process.env.DATABASE_ADMIN_URL!);
    for (const regime of REPORT_REGIMES) for (const code of REPORT_CODES) {
      const expected = isReportComplete(regime, code) ? loadReportTemplates({ onlyComplete: true }).filter((r) => r.regime === regime && r.reportCode === code).length : 0;
      expect(await n(regime, code), `${regime}/${code}`).toBe(expected);
    }
    expect(await n('TT200', 'B02')).toBe(0);
    await expect(sql`INSERT INTO report_template(regime, report_code, line_code, label, source, side, sort_order) VALUES ('TT133','B01','1','x','balance','net_debit',1)`.execute(t.db)).rejects.toThrow(/permission denied/);
  });
});
