import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, Decimal, formatVnDate } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import type { ReportColumn, ReportDoc } from '../reporting/print/html.js';
import { dateIso } from '../ledger/vouchers.service.js';
import { getContract } from './milestone.js';

// Theo dõi thực hiện hợp đồng bán/mua (GĐ6 Task 13b, QĐ #820–#839) tại một ngày (asOf), lũy kế từ đầu:
// - Giá trị điều chỉnh = giá trị hợp đồng + phụ lục ký đến ngày đó (loại tiền của hợp đồng).
// - Đã xuất/nhận hóa đơn (chưa thuế) = Σ (tiền hàng − chiết khấu) dòng hàng của hóa đơn đã ghi sổ có chiều hợp đồng (giảm giá/trả lại trừ đi);
//   hóa đơn bị đảo sau ngày asOf vẫn tính (tại ngày đó nó còn hiệu lực). % thực hiện = đã xuất hóa đơn / giá trị điều chỉnh.
// - Công nợ theo sổ cái (VND): dòng TK phải thu (hợp đồng bán) / phải trả (hợp đồng mua) có contract_id. Phát sinh = dòng của hóa đơn (kể cả chứng từ đảo
//   của hóa đơn) và số dư đầu kỳ; đã thu/đã trả = mọi dòng khác (PT, BC, PC, BN, bù trừ...) — QĐ #784. Còn phải thu/trả = phát sinh − đã thu/trả.
// - Quá hạn (FIFO): tiền thu/trả trừ vào khoản đến hạn trước; quá hạn = còn phải thu − các khoản chưa đến hạn (hạn thanh toán của khoản công nợ,
//   không có thì ngày dự kiến của đợt lập ra hóa đơn đó; không có cả hai thì coi như chưa đến hạn như báo cáo tuổi nợ). Đến hạn đúng ngày asOf chưa quá hạn.
// - Đợt quá hạn = đợt kế hoạch có ngày dự kiến trước asOf mà chưa có hóa đơn đã ghi sổ.
// Số công nợ cần cờ view_receivable (hợp đồng bán) / view_payable (hợp đồng mua): thiếu cờ thì các cột công nợ là null (debtHidden).
type Trx = Transaction<Database>;
type Auth = { sensitive: Set<string> };
type Kind = 'sale' | 'purchase';
export const INVOICE_TYPES = ['HDB', 'BH', 'GGB', 'TLB', 'HDM', 'MH', 'GGM', 'TLM'];
const REFUND_TYPES = ['GGB', 'TLB', 'GGM', 'TLM'];
export const debtFlag = (kind: Kind) => (kind === 'sale' ? 'view_receivable' : 'view_payable');

export const trackQuery = z.object({
  asOf: dateIso.optional(), kind: z.enum(['sale', 'purchase']).optional(), status: z.string().max(20).optional(), overdue: z.enum(['true', 'false']).default('false'),
  format: z.enum(['json', 'html', 'pdf', 'xlsx']).default('json'),
});
export interface TrackRow {
  id: number; code: string; name: string; kind: Kind; partyCode: string | null; partyName: string | null; currencyCode: string; status: string; signedDate: string | null; validTo: string | null;
  value: string; amendmentTotal: string; adjustedValue: string; invoiced: string; invoicedVnd: string; remainingValue: string; performedPct: string | null;
  milestoneTotal: string; milestoneInvoiced: string; overdueMilestoneCount: number; overdueMilestoneAmount: string; nextDueDate: string | null;
  debtIncurred: string | null; settled: string | null; outstanding: string | null; overdueDebt: string | null; debtHidden: boolean;
}
export interface TrackReport { asOf: string; rows: TrackRow[]; totals: { invoicedVnd: string; debtIncurred: string; settled: string; outstanding: string; overdueDebt: string; overdueMilestoneCount: number } }

type Raw = Omit<TrackRow, 'remainingValue' | 'performedPct' | 'overdueDebt' | 'debtHidden'> & { notDue: string; debtIncurred: string; settled: string; outstanding: string };

export async function trackContracts(trx: Trx, auth: Auth, q: { asOf: string; id?: number; kind?: Kind | undefined; status?: string | undefined; overdue?: boolean }): Promise<TrackReport> {
  const asOf = q.asOf;
  const raw = (await sql<Raw>`
    SELECT c.id::int, c.code, c.name, c.kind, p.code AS "partyCode", p.name AS "partyName", c.currency_code AS "currencyCode", c.status,
      c.signed_date::text AS "signedDate", c.valid_to::text AS "validTo", c.value::text AS value,
      coalesce(am.s, 0)::text AS "amendmentTotal", (c.value + coalesce(am.s, 0))::text AS "adjustedValue",
      trim_scale(coalesce(ms.total, 0))::text AS "milestoneTotal", trim_scale(coalesce(ms.invoiced, 0))::text AS "milestoneInvoiced",
      coalesce(ms.n_over, 0)::int AS "overdueMilestoneCount", trim_scale(coalesce(ms.over_amt, 0))::text AS "overdueMilestoneAmount", ms.next_due::text AS "nextDueDate",
      trim_scale(coalesce(inv.cur, 0))::text AS invoiced, coalesce(inv.vnd, 0)::text AS "invoicedVnd",
      coalesce(d.incurred, 0)::text AS "debtIncurred", coalesce(d.settled, 0)::text AS settled, (coalesce(d.incurred, 0) - coalesce(d.settled, 0))::text AS outstanding,
      coalesce(nd.amt, 0)::text AS "notDue"
    FROM contract c LEFT JOIN party p ON p.tenant_id = c.tenant_id AND p.id = c.party_id
    LEFT JOIN LATERAL (SELECT sum(a.value_change) AS s FROM contract_amendment a WHERE a.contract_id = c.id AND a.signed_date <= ${asOf}::date) am ON true
    LEFT JOIN LATERAL (SELECT sum(m.amount) FILTER (WHERE m.status = 'planned') AS total, sum(m.amount) FILTER (WHERE x.done) AS invoiced,
        count(*) FILTER (WHERE x.late) AS n_over, sum(m.amount) FILTER (WHERE x.late) AS over_amt,
        min(m.due_date) FILTER (WHERE m.status = 'planned' AND NOT x.done AND m.due_date >= ${asOf}::date) AS next_due
      FROM contract_milestone m LEFT JOIN voucher v ON v.tenant_id = m.tenant_id AND v.id = m.voucher_id
      CROSS JOIN LATERAL (SELECT coalesce(v.state = 'posted' AND v.posting_date <= ${asOf}::date, false) AS done) x0
      CROSS JOIN LATERAL (SELECT x0.done, (m.status = 'planned' AND NOT x0.done AND m.due_date < ${asOf}::date) AS late) x
      WHERE m.contract_id = c.id) ms ON true
    LEFT JOIN LATERAL (SELECT sum(s.sg * CASE WHEN v.currency_code = c.currency_code THEN il.amount_currency - il.discount_amount_currency ELSE 0 END) AS cur,
        sum(s.sg * (il.amount - il.discount_amount)) AS vnd
      FROM (SELECT DISTINCT l.voucher_id FROM voucher_line l WHERE l.tenant_id = c.tenant_id AND l.contract_id = c.id AND l.posting_date <= ${asOf}::date) vl
      JOIN voucher v ON v.id = vl.voucher_id JOIN voucher_item_line il ON il.tenant_id = v.tenant_id AND il.voucher_id = v.id
      LEFT JOIN voucher r ON r.id = v.reversed_by_id
      CROSS JOIN LATERAL (SELECT CASE WHEN v.voucher_type = ANY(${REFUND_TYPES}::text[]) THEN -1 ELSE 1 END AS sg) s
      WHERE v.voucher_type = ANY(${INVOICE_TYPES}::text[]) AND v.reversal_of_id IS NULL
        AND (v.state = 'posted' OR (v.state = 'reversed' AND r.posting_date > ${asOf}::date))) inv ON true
    LEFT JOIN LATERAL (SELECT sum(z.nat) FILTER (WHERE z.inc) AS incurred, sum(-z.nat) FILTER (WHERE NOT z.inc) AS settled
      FROM (SELECT CASE WHEN c.kind = 'sale' THEN l.debit - l.credit ELSE l.credit - l.debit END AS nat,
          (coalesce(o.voucher_type, v.voucher_type) = ANY(${INVOICE_TYPES}::text[]) OR v.source_doc_type IS NOT DISTINCT FROM 'opening_balance') AS inc
        FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id LEFT JOIN voucher o ON o.id = v.reversal_of_id
        WHERE l.tenant_id = c.tenant_id AND l.contract_id = c.id AND l.posting_date <= ${asOf}::date AND v.state IN ('posted', 'reversed')
          AND a.subledger_kind = CASE WHEN c.kind = 'sale' THEN 'receivable' ELSE 'payable' END) z) d ON true
    LEFT JOIN LATERAL (SELECT sum(CASE WHEN c.kind = 'sale' THEN o.amount ELSE -o.amount END) AS amt
      FROM voucher_line l JOIN open_item o ON o.tenant_id = l.tenant_id AND o.voucher_line_id = l.id AND o.line_posting_date = l.posting_date
      JOIN voucher v ON v.id = o.voucher_id JOIN account a ON a.id = l.account_id
      LEFT JOIN contract_milestone m ON m.tenant_id = o.tenant_id AND m.voucher_id = o.voucher_id
      WHERE l.tenant_id = c.tenant_id AND l.contract_id = c.id AND l.posting_date <= ${asOf}::date AND v.state = 'posted'
        AND a.subledger_kind = CASE WHEN c.kind = 'sale' THEN 'receivable' ELSE 'payable' END
        AND (CASE WHEN c.kind = 'sale' THEN o.amount > 0 ELSE o.amount < 0 END)
        AND (coalesce(o.due_date, m.due_date) IS NULL OR coalesce(o.due_date, m.due_date) >= ${asOf}::date)) nd ON true
    WHERE c.kind <> 'loan' ${q.id !== undefined ? sql`AND c.id = ${q.id}::bigint` : sql``} ${q.kind ? sql`AND c.kind = ${q.kind}` : sql``} ${q.status ? sql`AND c.status = ${q.status}` : sql``}
    ORDER BY c.code`.execute(trx)).rows;

  const rows: TrackRow[] = raw.map(({ notDue, ...r }) => {
    const adjusted = D(r.adjustedValue); const out = D(r.outstanding);
    // FIFO: phần còn nợ vượt các khoản chưa đến hạn là quá hạn; trả trước/thu thừa (còn nợ âm) không quá hạn.
    const overdue = out.gt(0) ? Decimal.max(0, Decimal.min(out.minus(notDue), out)) : D(0);
    const hidden = !auth.sensitive.has(debtFlag(r.kind));
    return { ...r, remainingValue: adjusted.minus(r.invoiced).toString(), performedPct: adjusted.gt(0) ? D(r.invoiced).div(adjusted).times(100).toFixed(2) : null,
      debtIncurred: hidden ? null : r.debtIncurred, settled: hidden ? null : r.settled, outstanding: hidden ? null : r.outstanding, overdueDebt: hidden ? null : overdue.toFixed(0), debtHidden: hidden };
  }).filter((r) => !q.overdue || r.overdueMilestoneCount > 0 || D(r.overdueDebt ?? 0).gt(0));
  const sumOf = (k: 'invoicedVnd' | 'debtIncurred' | 'settled' | 'outstanding' | 'overdueDebt') => rows.reduce((s, r) => s.plus(r[k] ?? 0), D(0)).toFixed(0);
  return { asOf, rows, totals: { invoicedVnd: sumOf('invoicedVnd'), debtIncurred: sumOf('debtIncurred'), settled: sumOf('settled'), outstanding: sumOf('outstanding'), overdueDebt: sumOf('overdueDebt'),
    overdueMilestoneCount: rows.reduce((n, r) => n + r.overdueMilestoneCount, 0) } };
}

// Báo cáo tổng hợp quá hạn: cần cờ công nợ của (các) chiều được xem — số quá hạn là công nợ, không ẩn từng dòng như danh sách theo dõi.
export function assertOverdueFlags(auth: Auth, kind?: Kind) {
  for (const k of kind ? [kind] : (['sale', 'purchase'] as const)) {
    if (!auth.sensitive.has(debtFlag(k))) throw new AppError('FORBIDDEN', k === 'sale' ? 'Không có quyền xem công nợ phải thu' : 'Không có quyền xem công nợ phải trả', 403);
  }
}

// Một hợp đồng: dòng theo dõi + đợt (đánh dấu quá hạn) + phụ lục.
export async function trackContract(trx: Trx, auth: Auth, id: number, asOf: string) {
  const c = await getContract(trx, id);
  const t = (await trackContracts(trx, auth, { asOf, id })).rows[0]!;
  const milestones = c.milestones.map((m) => ({ ...m, overdue: m.status === 'planned' && !!m.dueDate && m.dueDate < asOf }));
  return { asOf, ...t, milestones, amendments: c.amendments };
}

const num = (key: string, label: string, scale = 0): ReportColumn => ({ key, label, type: 'number', scale });
const KIND: Record<Kind, string> = { sale: 'Bán', purchase: 'Mua' };
export async function trackDoc(trx: Trx, tenantId: string, regime: string, r: TrackReport, overdueOnly: boolean): Promise<ReportDoc> {
  const company = await companyInfo(trx, tenantId, regime, null);
  return { company, formNo: '', issuedBy: '', title: overdueOnly ? 'Tổng hợp hợp đồng quá hạn thu, trả' : 'Theo dõi thực hiện hợp đồng', subtitle: `Tại ngày ${formatVnDate(r.asOf)}`,
    sheetName: overdueOnly ? 'Hợp đồng quá hạn' : 'Theo dõi hợp đồng', landscape: true,
    columns: [{ key: 'code', label: 'Số hợp đồng' }, { key: 'name', label: 'Tên hợp đồng' }, { key: 'kindLabel', label: 'Loại' }, { key: 'partyName', label: 'Đối tác' }, { key: 'currencyCode', label: 'Tiền' },
      num('adjustedValue', 'Giá trị (gồm phụ lục)'), num('invoiced', 'Đã xuất/nhận hóa đơn', 4), num('performedPct', '% thực hiện', 2),
      num('debtIncurred', 'Phát sinh công nợ'), num('settled', 'Đã thu/đã trả'), num('outstanding', 'Còn phải thu/trả'), num('overdueDebt', 'Quá hạn'),
      num('overdueMilestoneCount', 'Đợt quá hạn'), num('overdueMilestoneAmount', 'Tiền đợt quá hạn', 4), { key: 'nextDueDate', label: 'Đợt kế tiếp', type: 'date' }],
    rows: r.rows.map((x) => ({ ...x, kindLabel: KIND[x.kind], ...(x.debtHidden ? { partyName: `${x.partyName ?? ''} (công nợ ẩn)` } : {}) })),
    footer: { code: 'Cộng', debtIncurred: r.totals.debtIncurred, settled: r.totals.settled, outstanding: r.totals.outstanding, overdueDebt: r.totals.overdueDebt, overdueMilestoneCount: String(r.totals.overdueMilestoneCount) } };
}
