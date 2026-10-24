import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { COA_REGIMES, loadPayrollAccounts } from '@kt/coa-data';
import { D } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import { periodSubtitle, type ReportDoc } from '../reporting/print/html.js';
import { regimeOf } from '../reporting/ledgers.js';

// Số dư theo vụ việc/hợp đồng (GĐ6 Task 13c, QĐ #860–#889): dư đầu (mọi dòng đã ghi sổ trước `from`, gồm DK số dư đầu kỳ và KC), phát sinh, dư cuối theo (chiều, TK)
// đọc thẳng sổ cái (số dư kỳ fn_balances_at không mang chiều vụ việc/hợp đồng). Chỉ TK có ít nhất một dòng gắn chiều đến `to`; mỗi TK thêm dòng "không gắn" để
// Σ các dòng = sổ cái của TK. Cột dở dang = dư cuối TK chi phí dở dang (`wip` theo chế độ, 154) của từng vụ việc/hợp đồng. Cuối năm trước = đầu năm sau vì số dư lũy kế.
type Trx = Transaction<Database>;
export interface Side { debit: string; credit: string }
export interface BalanceRow { dimId: number | null; dimCode: string | null; dimName: string | null; accountCode: string; accountName: string; opening: Side; debit: string; credit: string; closing: Side }
export interface BalanceReport { by: 'project' | 'contract'; from: string; to: string; regime: string; rows: BalanceRow[]; wip: { dimId: number; dimCode: string; dimName: string; amount: string }[] }
const side = (n: string): Side => (D(n).gte(0) ? { debit: D(n).toFixed(0), credit: '0' } : { debit: '0', credit: D(n).neg().toFixed(0) });

export async function projectBalances(trx: Trx, q: { from: string; to: string; by: 'project' | 'contract'; accountCode?: string | undefined; id?: number | undefined }): Promise<BalanceReport> {
  const regime = await regimeOf(trx, q);
  const dim = q.by === 'project' ? sql`l.project_id` : sql`CASE WHEN ct.kind <> 'loan' THEN l.contract_id END`;
  if (q.id !== undefined) {
    const found = q.by === 'project' ? await trx.selectFrom('project').select('id').where('id', '=', q.id).executeTakeFirst()
      : await trx.selectFrom('contract').select('id').where('id', '=', q.id).where('kind', '<>', 'loan').executeTakeFirst();
    if (!found) throw new AppError('NOT_FOUND', q.by === 'project' ? 'Không tìm thấy vụ việc' : 'Không tìm thấy hợp đồng', 404);
  }
  const raw = (await sql<{ dim: number | null; code: string; name: string; o: string; d: string; c: string }>`
    WITH x AS (
      SELECT ${dim}::int AS dim, l.account_id, l.posting_date, l.debit, l.credit
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
      LEFT JOIN contract ct ON ct.tenant_id = l.tenant_id AND ct.id = l.contract_id
      WHERE v.state IN ('posted', 'reversed') AND l.posting_date <= ${q.to}::date AND a.regime = ${regime}
        ${q.accountCode ? sql`AND starts_with(a.code, ${q.accountCode})` : sql``})
    SELECT x.dim, a.code, a.name, coalesce(sum(x.debit - x.credit) FILTER (WHERE x.posting_date < ${q.from}::date), 0)::text AS o,
      coalesce(sum(x.debit) FILTER (WHERE x.posting_date >= ${q.from}::date), 0)::text AS d, coalesce(sum(x.credit) FILTER (WHERE x.posting_date >= ${q.from}::date), 0)::text AS c
    FROM x JOIN account a ON a.id = x.account_id
    WHERE x.account_id IN (SELECT account_id FROM x WHERE dim IS NOT NULL) ${q.id !== undefined ? sql`AND x.dim = ${q.id}` : sql``}
    GROUP BY x.dim, a.code, a.name`.execute(trx)).rows;
  const ids = [...new Set(raw.flatMap((r) => (r.dim === null ? [] : [r.dim])))];
  const names = new Map((ids.length ? q.by === 'project' ? await trx.selectFrom('project').select(['id', 'code', 'name']).where('id', 'in', ids).execute()
    : await trx.selectFrom('contract').select(['id', 'code', 'name']).where('id', 'in', ids).execute() : []).map((x) => [Number(x.id), x]));
  const rows: BalanceRow[] = raw.map((r) => {
    const n = r.dim === null ? undefined : names.get(r.dim);
    return { dimId: r.dim, dimCode: n?.code ?? null, dimName: n?.name ?? null, accountCode: r.code, accountName: r.name, opening: side(r.o), debit: D(r.d).toFixed(0), credit: D(r.c).toFixed(0),
      closing: side(D(r.o).plus(r.d).minus(r.c).toString()) };
  }).filter((r) => [r.opening.debit, r.opening.credit, r.debit, r.credit].some((x) => x !== '0'))
    .sort((a, b) => (a.dimCode === null ? 1 : 0) - (b.dimCode === null ? 1 : 0) || (a.dimCode ?? '').localeCompare(b.dimCode ?? '') || a.accountCode.localeCompare(b.accountCode));
  const wipCode = COA_REGIMES.includes(regime as never) ? loadPayrollAccounts(regime as never)?.wip : undefined;
  const wip = new Map<number, BalanceReport['wip'][number]>();
  for (const r of rows) if (wipCode && r.dimId !== null && r.accountCode.startsWith(wipCode)) {
    const w = wip.get(r.dimId) ?? { dimId: r.dimId, dimCode: r.dimCode!, dimName: r.dimName!, amount: '0' };
    w.amount = D(w.amount).plus(r.closing.debit).minus(r.closing.credit).toFixed(0); wip.set(r.dimId, w);
  }
  return { by: q.by, from: q.from, to: q.to, regime, rows, wip: [...wip.values()].filter((w) => w.amount !== '0') };
}

export async function balancesDoc(trx: Trx, tenantId: string, r: BalanceReport): Promise<ReportDoc> {
  const company = await companyInfo(trx, tenantId, r.regime, null);
  const project = r.by === 'project'; const n = (key: string, label: string) => ({ key, label, type: 'number' as const, scale: 0 });
  return { company, formNo: '', issuedBy: '', title: project ? 'Số dư theo vụ việc, công trình' : 'Số dư theo hợp đồng', subtitle: periodSubtitle(r.from, r.to),
    sheetName: project ? 'Số dư vụ việc' : 'Số dư hợp đồng', landscape: true,
    columns: [{ key: 'dimCode', label: project ? 'Mã vụ việc' : 'Số hợp đồng' }, { key: 'dimName', label: 'Tên' }, { key: 'accountCode', label: 'Tài khoản' },
      n('openingDebit', 'Dư đầu kỳ Nợ'), n('openingCredit', 'Dư đầu kỳ Có'), n('debit', 'Phát sinh Nợ'), n('credit', 'Phát sinh Có'), n('closingDebit', 'Dư cuối kỳ Nợ'), n('closingCredit', 'Dư cuối kỳ Có')],
    rows: r.rows.map((x) => ({ dimCode: x.dimCode ?? '', dimName: x.dimName ?? (project ? 'Không gắn vụ việc' : 'Không gắn hợp đồng'), accountCode: x.accountCode,
      openingDebit: x.opening.debit, openingCredit: x.opening.credit, debit: x.debit, credit: x.credit, closingDebit: x.closing.debit, closingCredit: x.closing.credit })) };
}
