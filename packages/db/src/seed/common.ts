import type pg from 'pg';
import { loadDefaultClosingSteps } from '@kt/coa-data';
import { buildFiscalPeriods, type Regime } from '@kt/domain';

export async function ensureUser(c: pg.Client, username: string, passwordHash: string, fullName: string): Promise<string> {
  const r = await c.query(`INSERT INTO app_user(username, full_name, password_hash) VALUES ($1,$2,$3) ON CONFLICT (username) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`, [username, fullName, passwordHash]);
  return r.rows[0].id;
}
export async function ensureTenant(c: pg.Client, t: { code: string; name: string; taxCode: string; ownerUserId: string }): Promise<{ id: string; created: boolean }> {
  const ex = await c.query('SELECT id FROM tenant WHERE code = $1', [t.code]);
  if (ex.rows[0]) return { id: ex.rows[0].id, created: false };
  const r = await c.query('SELECT create_tenant($1,$2,$3,$4) AS id', [t.code, t.name, t.taxCode, t.ownerUserId]);
  return { id: r.rows[0].id, created: true };
}
// Đặt công ty (và người dùng) cho giao dịch đang mở: set_config(..., true) chỉ có hiệu lực trong giao dịch hiện tại.
export async function setTenantContext(c: pg.Client, tenantId: string, userId?: string): Promise<void> {
  await c.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
  if (userId) await c.query(`SELECT set_config('app.current_user', $1, true)`, [userId]);
}
// Dùng khi chưa có giao dịch; trong giao dịch đã mở (như seedAbcTx) gọi setTenantContext trực tiếp.
export async function withTenantClient<T>(c: pg.Client, tenantId: string, fn: () => Promise<T>, userId?: string): Promise<T> {
  await c.query('BEGIN');
  try { await setTenantContext(c, tenantId, userId); const r = await fn(); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; }
}
export async function insertFiscalYear(c: pg.Client, tenantId: string, input: { fiscalYear: number; dateFrom: string; months: number; regime: Regime }) {
  for (const p of buildFiscalPeriods(input))
    await c.query('INSERT INTO fiscal_period(tenant_id, fiscal_year, period_no, date_from, date_to, regime) VALUES ($1,$2,$3,$4,$5,$6)', [tenantId, p.fiscalYear, p.periodNo, p.dateFrom, p.dateTo, p.regime]);
}
export async function generateAccountsSql(c: pg.Client, tenantId: string, regime: Regime): Promise<number> {
  const tpl = await c.query('SELECT * FROM coa_template WHERE regime = $1 ORDER BY length(code), code', [regime]);
  if (tpl.rows.length === 0) throw new Error(`Chưa có mẫu hệ thống tài khoản ${regime}`);
  const idByCode = new Map<string, number>();
  for (const t of tpl.rows) {
    const r = await c.query(`INSERT INTO account(tenant_id, regime, code, name, name_en, parent_id, is_group, root_type, normal_balance, track_currency, subledger_kind)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [tenantId, regime, t.code, t.name, t.name_en, t.parent_code ? idByCode.get(t.parent_code) ?? null : null, t.is_group, t.root_type, t.normal_balance, t.track_currency, t.subledger_kind]);
    idByCode.set(t.code, r.rows[0].id);
  }
  return tpl.rows.length;
}
// Sơ đồ kết chuyển mặc định (giống loadClosingTemplate của API, nhưng bằng SQL thuần cho seed); chỉ gọi khi công ty chưa có bước nào.
export async function insertDefaultClosingSteps(c: pg.Client, tenantId: string, regime: Regime): Promise<number> {
  const steps = loadDefaultClosingSteps(regime);
  for (const s of steps)
    await c.query(`INSERT INTO closing_step(tenant_id, regime, step_order, name, mode, from_accounts, to_account, keep_balance, by_dimension, ratio_source, run_at) VALUES ($1,$11,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tenantId, s.stepOrder, s.name, s.mode, s.fromAccounts, s.toAccount, s.keepBalance ?? '0', s.byDimension ?? null, s.ratioSource ? JSON.stringify(s.ratioSource) : null, s.runAt, regime]);
  return steps.length;
}
