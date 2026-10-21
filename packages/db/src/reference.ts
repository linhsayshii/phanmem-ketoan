import pg from 'pg';
import { PERMISSIONS } from '@kt/domain';
import { COA_REGIMES, loadCoaTemplate, loadFxRules, loadReportTemplates } from '@kt/coa-data';

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
    // Mẫu báo cáo: chỉ bộ đã đối chiếu văn bản gốc (status.json = true) mới thành mẫu hệ thống; bộ chờ văn bản thì bảng rỗng và công ty tự định nghĩa trong trình sửa.
    const tpl = loadReportTemplates({ onlyComplete: true });
    for (const r of tpl) {
      await client.query(
        `INSERT INTO report_template(regime, report_code, line_code, label, parent_line_code, source, side, formula, sort_order, is_bold, negate, note_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (regime, report_code, line_code) DO UPDATE SET label = EXCLUDED.label, parent_line_code = EXCLUDED.parent_line_code, source = EXCLUDED.source, side = EXCLUDED.side,
           formula = EXCLUDED.formula, sort_order = EXCLUDED.sort_order, is_bold = EXCLUDED.is_bold, negate = EXCLUDED.negate, note_ref = EXCLUDED.note_ref`,
        [r.regime, r.reportCode, r.lineCode, r.label, r.parentLineCode, r.source, r.side, r.formula, r.sortOrder, r.isBold, r.negate, r.noteRef]);
    }
    await client.query(
      `DELETE FROM report_template WHERE (regime, report_code, line_code) NOT IN (SELECT a, b, c FROM unnest($1::text[], $2::text[], $3::text[]) AS t(a, b, c))`,
      [tpl.map((r) => r.regime), tpl.map((r) => r.reportCode), tpl.map((r) => r.lineCode)]);
    // Quy tắc tỷ giá theo chế độ (fx-rules.json) cho hàm SQL đối trừ (tài khoản lãi/lỗ của chứng từ CL). DB tạm dừng ở migration trước 0029 (kiểm thử backfill) chưa có bảng.
    if ((await client.query<{ t: string | null }>(`SELECT to_regclass('public.fx_rule')::text AS t`)).rows[0]!.t) {
      for (const regime of COA_REGIMES) {
        const rules = loadFxRules(regime);
        if (rules) await client.query('INSERT INTO fx_rule(regime, rules) VALUES ($1, $2) ON CONFLICT (regime) DO UPDATE SET rules = EXCLUDED.rules', [regime, JSON.stringify(rules)]);
        else await client.query('DELETE FROM fx_rule WHERE regime = $1', [regime]);
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { await client.end(); }
}
