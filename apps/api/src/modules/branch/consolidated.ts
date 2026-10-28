import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { evaluateReport, sum, ZERO, type Decimal, type ReportLineDef, type Side, type Source } from '@kt/domain';
import { loadDef, reportData, restrictData, sqlResolver, usesLongTerm } from '../reporting/financial.js';
import { regimeOf } from '../reporting/ledgers.js';
import { HEAD_OFFICE, toFilter, type BranchScope } from './scope.js';

type Trx = Transaction<Database>;

export async function internalPrefixes(trx: Trx): Promise<string[]> {
  return (await trx.selectFrom('branch_consolidation_setting').select('internal_prefixes').executeTakeFirst())?.internal_prefixes ?? ['136', '336'];
}

// Đơn vị cộng: trụ sở chính và các chi nhánh trong phạm vi của người dùng.
export async function consolidationUnits(trx: Trx, scope: BranchScope): Promise<{ id: number; code: string; name: string }[]> {
  const branches = (await sql<{ id: number; code: string; name: string }>`SELECT id, code, name FROM department WHERE is_branch ORDER BY code`.execute(trx)).rows;
  const all = [{ id: HEAD_OFFICE, code: 'HO', name: 'Trụ sở chính' }, ...branches];
  return scope === null ? all : all.filter((u) => scope.includes(u.id));
}

// BCTC tổng hợp (B01/B02): đánh giá cùng định nghĩa báo cáo cho từng đơn vị (chứng từ của đơn vị đó), cộng theo dòng; cột loại trừ = báo cáo đánh giá
// chỉ trên đơn vị số dư/phát sinh của tài khoản nội bộ (công thức tuyến tính theo đơn vị nên phần nội bộ tách được), tổng hợp = cộng − loại trừ.
// internalNet: dư ròng (Nợ − Có) của tài khoản nội bộ cộng mọi đơn vị tại ngày cuối kỳ; khác 0 là phải thu và phải trả nội bộ chưa khớp.
export async function consolidatedReport(trx: Trx, tenantId: string, scope: BranchScope, q: { reportCode: string; from: string; to: string }) {
  const regime = await regimeOf(trx, q);
  const { def, lines } = await loadDef(trx, q.reportCode, regime);
  const defs: ReportLineDef[] = lines.map((l) => ({ lineCode: l.line_code, formula: l.formula, source: l.source as Source, side: l.side as Side }));
  const longTerm = usesLongTerm(lines.map((l) => l.formula));
  const prefixes = await internalPrefixes(trx);
  const internal = (code: string) => prefixes.some((p) => code.startsWith(p));
  const units = await consolidationUnits(trx, scope);
  const cols: { unit: (typeof units)[number]; values: Map<string, Decimal>; elim: Map<string, Decimal> }[] = [];
  let internalNet = ZERO;
  for (const unit of units) {
    const data = reportData(trx, tenantId, regime, q, { longTerm, branch: toFilter([unit.id]) });
    const inner = restrictData(data, internal);
    cols.push({ unit, values: await evaluateReport(defs, sqlResolver(data)), elim: await evaluateReport(defs, sqlResolver(inner)) });
    internalNet = internalNet.plus(sum((await inner.balance()).map((u) => u.d.minus(u.c))));
  }
  const at = (m: Map<string, Decimal>, k: string) => m.get(k) ?? ZERO;
  return {
    reportCode: def.report_code, name: def.name, regime, period: { from: q.from, to: q.to }, internalPrefixes: prefixes, internalNet: internalNet.toString(),
    units: units.map((u) => ({ id: u.id, code: u.code, name: u.name })),
    rows: lines.map((l) => {
      const total = sum(cols.map((c) => at(c.values, l.line_code))); const elimination = sum(cols.map((c) => at(c.elim, l.line_code)));
      return { lineCode: l.line_code, label: l.label, parentLineCode: l.parent_line_code, isBold: l.is_bold, negate: l.negate, formula: l.formula,
        byUnit: cols.map((c) => at(c.values, l.line_code).toString()), total: total.toString(), elimination: elimination.toString(), consolidated: total.minus(elimination).toString() };
    }),
  };
}
