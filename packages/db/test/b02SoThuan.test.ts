import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { withDb } from '../src/temp-db.js';

// 0039: DB tạm migrate tới 0038, tạo ba công ty có B02 (A: mẫu cũ; B: đã sửa tay dòng 22; C: TT133), rồi áp 0039.
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATION = '0039_b02_so_thuan.sql';
const adminUrl = process.env.DATABASE_ADMIN_URL!;
const name = `ketoan_t_${randomBytes(4).toString('hex')}`;
const url = withDb(adminUrl, name);
let c: pg.Client; let dir: string; const ids: Record<string, string> = {};
const q = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) => (await c.query<T>(text, values)).rows;
const formulas = async (tenant: string, regime: string) => Object.fromEntries((await q<{ line_code: string; formula: string }>(
  `SELECT l.line_code, l.formula FROM report_line l JOIN report_def d ON d.id = l.report_def_id WHERE l.tenant_id = $1 AND d.regime = $2 AND d.report_code = 'B02' ORDER BY 1`, [tenant, regime])).map((r) => [r.line_code, r.formula]));

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  dir = mkdtempSync(path.join(tmpdir(), 'kt-mig-0039-'));
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f < MIGRATION)) copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  await migrate(url, dir);
  c = new pg.Client({ connectionString: url }); await c.connect();
  const owner = (await q<{ id: string }>(`INSERT INTO app_user(username, full_name, password_hash) VALUES ('u39', 'u39', 'x') RETURNING id`))[0]!.id;
  for (const code of ['A', 'B', 'C']) ids[code] = (await q<{ id: string }>(`SELECT create_tenant($1, $1, NULL, $2::uuid) AS id`, [code, owner]))[0]!.id;
  const def = async (tenant: string, regime: string, lines: [string, string][]) => {
    const d = (await q<{ id: string }>(`INSERT INTO report_def(tenant_id, regime, report_code, name, form_no, issued_by) VALUES ($1, $2, 'B02', 'B02', 'B02-DN', 'x') RETURNING id`, [tenant, regime]))[0]!.id;
    for (const [i, [lc, f]] of lines.entries()) await c.query(`INSERT INTO report_line(tenant_id, report_def_id, line_code, label, source, side, formula, sort_order) VALUES ($1, $2, $3, $3, 'movement', 'net_credit', $4, $5)`, [tenant, d, lc, f, i + 1]);
  };
  await def(ids.A!, 'TT99', [['21', '0'], ['22', '515'], ['23', '635'], ['24', '0']]);
  await def(ids.B!, 'TT99', [['22', '515 + 5158'], ['23', '635']]); // 22 đã sửa tay, 23 còn mẫu cũ
  await def(ids.C!, 'TT133', [['21', '515'], ['22', '635']]);
  copyFileSync(path.join(MIGRATIONS, MIGRATION), path.join(dir, MIGRATION));
  expect(await migrate(url, dir)).toEqual([MIGRATION]);
}, 180_000);
afterAll(async () => {
  await c?.end();
  rmSync(dir, { recursive: true, force: true });
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end();
});

describe('0039: B02 TT99 số thuần chênh lệch đánh giá lại', () => {
  it('cập nhật dòng 22/23 của công ty chưa sửa định nghĩa B02 TT99, giữ nguyên dòng đã sửa tay và dòng khác', async () => {
    expect(await formulas(ids.A!, 'TT99')).toEqual({ '21': '0', '22': '515!REVAL + REVAL_GAIN', '23': '635!REVAL + REVAL_LOSS', '24': '0' });
    expect(await formulas(ids.B!, 'TT99')).toEqual({ '22': '515 + 5158', '23': '635!REVAL + REVAL_LOSS' });
  });
  it('TT133 không đổi', async () => {
    expect(await formulas(ids.C!, 'TT133')).toEqual({ '21': '515', '22': '635' });
  });
  it('ghi nhật ký kiểm toán trước/sau cho từng dòng đổi', async () => {
    const ev = await q<{ tenant_id: string; before: { formula: string }; after: { formula: string } }>(`SELECT tenant_id::text, before, after FROM audit_event WHERE entity = 'report_line' AND action = 'update' ORDER BY id`);
    expect(ev.map((e) => [e.tenant_id === ids.A ? 'A' : 'B', e.before.formula, e.after.formula])).toEqual([
      ['A', '515', '515!REVAL + REVAL_GAIN'], ['A', '635', '635!REVAL + REVAL_LOSS'], ['B', '635', '635!REVAL + REVAL_LOSS']]);
  });
});
