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

// 0066: DB tạm migrate tới 0065, hai công ty TT99 có B01, B03 (A: mẫu cũ; B: đã sửa tay dòng 131 và 01), rồi áp 0066.
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATION = '0066_ky_han_luong_tien.sql';
const adminUrl = process.env.DATABASE_ADMIN_URL!;
const name = `ketoan_t_${randomBytes(4).toString('hex')}`;
const url = withDb(adminUrl, name);
let c: pg.Client; let dir: string; const ids: Record<string, string> = {};
const q = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) => (await c.query<T>(text, values)).rows;
const lines = async (tenant: string, code: string) => Object.fromEntries((await q<{ line_code: string; formula: string; side: string }>(
  `SELECT l.line_code, l.formula, l.side FROM report_line l JOIN report_def d ON d.id = l.report_def_id WHERE l.tenant_id = $1 AND d.report_code = $2 ORDER BY 1`, [tenant, code])).map((r) => [r.line_code, `${r.formula} ${r.side}`]));

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  dir = mkdtempSync(path.join(tmpdir(), 'kt-mig-0066-'));
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f < MIGRATION)) copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  await migrate(url, dir);
  c = new pg.Client({ connectionString: url }); await c.connect();
  const owner = (await q<{ id: string }>(`INSERT INTO app_user(username, full_name, password_hash) VALUES ('u66', 'u66', 'x') RETURNING id`))[0]!.id;
  for (const code of ['A', 'B']) ids[code] = (await q<{ id: string }>(`SELECT create_tenant($1, $1, NULL, $2::uuid) AS id`, [code, owner]))[0]!.id;
  const def = async (tenant: string, report: string, ls: [string, string, string][]) => {
    const d = (await q<{ id: string }>(`INSERT INTO report_def(tenant_id, regime, report_code, name, form_no, issued_by) VALUES ($1, 'TT99', $2, $2, $2, 'x') RETURNING id`, [tenant, report]))[0]!.id;
    for (const [i, [lc, f, side]] of ls.entries()) await c.query(`INSERT INTO report_line(tenant_id, report_def_id, line_code, label, source, side, formula, sort_order) VALUES ($1, $2, $3, $3, 'balance', $4, $5, $6)`, [tenant, d, lc, side, f, i + 1]);
  };
  await def(ids.A!, 'B01', [['131', '131', 'debit'], ['211', '0', 'net_debit'], ['339', '0', 'net_debit'], ['213', '1361', 'debit']]);
  await def(ids.A!, 'B03', [['01', 'N111,112,113/C511,131,33311,3387,121', 'net_debit'], ['70', '111+112+113', 'debit']]);
  await def(ids.B!, 'B01', [['131', '131+1388', 'debit'], ['211', '0', 'net_debit']]);
  await def(ids.B!, 'B03', [['01', 'N111/C511', 'net_debit']]);
  copyFileSync(path.join(MIGRATIONS, MIGRATION), path.join(dir, MIGRATION));
  expect(await migrate(url, dir)).toEqual([MIGRATION]);
}, 180_000);
afterAll(async () => {
  await c?.end();
  rmSync(dir, { recursive: true, force: true });
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end();
});

describe('0066: kỳ hạn B01 TT99, mã luồng tiền B03', () => {
  it('cập nhật dòng còn đúng mẫu cũ (công thức và bên), giữ dòng đã sửa tay và dòng không đổi', async () => {
    expect(await lines(ids.A!, 'B01')).toEqual({ '131': '131-LT(131) debit', '211': 'LT(131) debit', '213': '1361 debit', '339': 'LT(341,3431) credit' });
    expect(await lines(ids.A!, 'B03')).toEqual({ '01': 'N111,112,113/C511,131,33311,3387,121!CF+CF(01) net_debit', '70': '111+112+113 debit' });
    expect(await lines(ids.B!, 'B01')).toEqual({ '131': '131+1388 debit', '211': 'LT(131) debit' });
    expect(await lines(ids.B!, 'B03')).toEqual({ '01': 'N111/C511 net_debit' });
  });
  it('công ty đã có được gieo quy tắc LCTT_THIEU_MA, không ghi nhật ký cho việc gieo', async () => {
    expect((await q(`SELECT tenant_id FROM data_check_rule WHERE code = 'LCTT_THIEU_MA' AND is_system`)).length).toBe(2);
    expect((await q(`SELECT 1 FROM audit_event WHERE entity = 'data_check_rule' AND after->>'code' = 'LCTT_THIEU_MA'`)).length).toBe(0);
    expect((await q(`SELECT 1 FROM audit_event WHERE entity = 'report_line' AND action = 'update'`)).length).toBe(5); // A: 131, 211, 339, B03/01; B: 211
  });
  it('cột cash_flow_code giới hạn độ dài', async () => {
    expect((await q<{ c: string }>(`SELECT pg_get_constraintdef(oid) AS c FROM pg_constraint WHERE conname = 'voucher_line_cash_flow_code_len' AND conrelid = 'voucher_line'::regclass`))[0]!.c).toMatch(/length\(cash_flow_code\)/);
  });
});
