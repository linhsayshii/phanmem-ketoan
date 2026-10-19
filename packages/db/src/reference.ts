import pg from 'pg';
import { PERMISSIONS } from '@kt/domain';
import { COA_REGIMES, loadCoaTemplate } from '@kt/coa-data';

export async function syncReferenceData(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const p of PERMISSIONS) {
      await client.query(
        `INSERT INTO permission(code, name, group_name) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, group_name = EXCLUDED.group_name`,
        [p.code, p.name, p.group],
      );
    }
    for (const regime of COA_REGIMES) {
      const rows = loadCoaTemplate(regime);
      for (const r of rows) {
        await client.query(
          `INSERT INTO coa_template(regime, code, name, name_en, parent_code, is_group, root_type, normal_balance, track_currency, subledger_kind, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (regime, code) DO UPDATE SET name = EXCLUDED.name, name_en = EXCLUDED.name_en, parent_code = EXCLUDED.parent_code,
             is_group = EXCLUDED.is_group, root_type = EXCLUDED.root_type, normal_balance = EXCLUDED.normal_balance,
             track_currency = EXCLUDED.track_currency, subledger_kind = EXCLUDED.subledger_kind, source = EXCLUDED.source`,
          [r.regime, r.code, r.name, r.nameEn, r.parentCode, r.isGroup, r.rootType, r.normalBalance, r.trackCurrency, r.subledgerKind, r.source]);
      }
      await client.query('DELETE FROM coa_template WHERE regime = $1 AND code <> ALL($2::text[])', [regime, rows.map((r) => r.code)]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { await client.end(); }
}
