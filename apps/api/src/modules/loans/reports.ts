import { sql, type Transaction } from 'kysely';
import { D } from '@kt/domain';
import type { Database } from '@kt/db';
import { companyInfo } from '../reporting/print/bookSet.js';
import { periodSubtitle, type ReportColumn, type ReportDoc } from '../reporting/print/html.js';

type Trx = Transaction<Database>;
export interface LoanReportRow {
  id: number; code: string; name: string; currency: string; status: string;
  openingCur: string; openingVnd: string; drawnCur: string; drawnVnd: string; repaidCur: string; repaidVnd: string; closingCur: string; closingVnd: string;
  interestOpening: string; interestEstimated: string; interestOther: string; interestPaid: string; interestClosing: string; nextDueDate: string | null; nextDuePrincipal: string | null;
}
const SUMS = ['openingVnd', 'drawnVnd', 'repaidVnd', 'closingVnd', 'interestOpening', 'interestEstimated', 'interestOther', 'interestPaid', 'interestClosing'] as const;
export type LoanReport = { from: string; to: string; rows: LoanReportRow[]; totals: Record<(typeof SUMS)[number], string> };

// Sổ theo dõi khế ước vay: dư nợ gốc (TK gốc vay) và lãi phải trả (TK lãi vay phải trả) của từng khế ước theo sổ cái. Số dư đầu kỳ nhập (DK) luôn tính vào đầu kỳ.
// Lãi dự tính = Có TK lãi phải trả từ chứng từ LV trong kỳ (ròng sau đảo); lãi trích khác = Có từ chứng từ khác LV; lãi đã trả = Nợ từ chứng từ khác LV.
export async function loanReport(trx: Trx, from: string, to: string): Promise<LoanReport> {
  const rows = (await sql<LoanReportRow>`
    WITH x AS (
      SELECT l.contract_id, (a.code = lt.principal_account_code) AS pr, (a.code = lt.interest_payable_account_code) AS ip, l.debit, l.credit,
        CASE WHEN c.currency_code = 'VND' THEN l.credit - l.debit ELSE -coalesce(l.amount_currency, 0) END AS cv, v.voucher_type = 'LV' AS lv,
        (l.posting_date < ${from}::date OR coalesce(v.source_doc_type = 'opening_balance', false)) AS pre
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.state IN ('posted','reversed') JOIN account a ON a.id = l.account_id
      JOIN contract c ON c.tenant_id = l.tenant_id AND c.id = l.contract_id AND c.kind = 'loan' JOIN loan_term lt ON lt.tenant_id = c.tenant_id AND lt.contract_id = c.id
      WHERE l.posting_date <= ${to}::date)
    SELECT c.id::int AS id, c.code, c.name, c.currency_code AS currency, c.status,
      coalesce(sum(cv) FILTER (WHERE pr AND pre), 0)::text AS "openingCur", coalesce(sum(credit - debit) FILTER (WHERE pr AND pre), 0)::text AS "openingVnd",
      coalesce(sum(greatest(cv, 0)) FILTER (WHERE pr AND NOT pre), 0)::text AS "drawnCur", coalesce(sum(credit) FILTER (WHERE pr AND NOT pre), 0)::text AS "drawnVnd",
      coalesce(sum(greatest(-cv, 0)) FILTER (WHERE pr AND NOT pre), 0)::text AS "repaidCur", coalesce(sum(debit) FILTER (WHERE pr AND NOT pre), 0)::text AS "repaidVnd",
      coalesce(sum(cv) FILTER (WHERE pr), 0)::text AS "closingCur", coalesce(sum(credit - debit) FILTER (WHERE pr), 0)::text AS "closingVnd",
      coalesce(sum(credit - debit) FILTER (WHERE ip AND pre), 0)::text AS "interestOpening",
      coalesce(sum(credit - debit) FILTER (WHERE ip AND NOT pre AND lv), 0)::text AS "interestEstimated",
      coalesce(sum(credit) FILTER (WHERE ip AND NOT pre AND NOT lv), 0)::text AS "interestOther",
      coalesce(sum(debit) FILTER (WHERE ip AND NOT pre AND NOT lv), 0)::text AS "interestPaid",
      coalesce(sum(credit - debit) FILTER (WHERE ip), 0)::text AS "interestClosing",
      n.due::text AS "nextDueDate", trim_scale(n.principal)::text AS "nextDuePrincipal"
    FROM contract c LEFT JOIN x ON x.contract_id = c.id
    LEFT JOIN LATERAL (SELECT i.due_date AS due, i.principal FROM loan_installment i WHERE i.contract_id = c.id AND i.due_date > ${to}::date ORDER BY i.due_date, i.id LIMIT 1) n ON true
    WHERE c.kind = 'loan' AND c.status <> 'draft' GROUP BY c.id, n.due, n.principal ORDER BY c.code`.execute(trx)).rows;
  const kept = rows.filter((r) => r.status === 'active' || SUMS.some((k) => !D(r[k]).isZero()));
  const totals = Object.fromEntries(SUMS.map((k) => [k, kept.reduce((s, r) => s.plus(r[k]), D(0)).toString()])) as LoanReport['totals'];
  return { from, to, rows: kept, totals };
}

const num = (key: string, label: string, scale = 0): ReportColumn => ({ key, label, type: 'number', scale });
export async function loanDoc(trx: Trx, tenantId: string, regime: string, r: LoanReport): Promise<ReportDoc> {
  const c = await companyInfo(trx, tenantId, regime, null);
  return { company: { ...c, formNo: '', issuedBy: '' }, formNo: '', issuedBy: '', title: 'Sổ theo dõi khế ước vay', subtitle: periodSubtitle(r.from, r.to), sheetName: 'Khế ước vay', landscape: true,
    columns: [{ key: 'code', label: 'Khế ước' }, { key: 'name', label: 'Tên' }, { key: 'currency', label: 'Loại tiền' }, num('openingCur', 'Dư nợ đầu kỳ (nguyên tệ)', 4), num('openingVnd', 'Dư nợ đầu kỳ'),
      num('drawnVnd', 'Giải ngân'), num('repaidVnd', 'Trả gốc'), num('closingCur', 'Dư nợ cuối kỳ (nguyên tệ)', 4), num('closingVnd', 'Dư nợ cuối kỳ'),
      num('interestOpening', 'Lãi phải trả đầu kỳ'), num('interestEstimated', 'Lãi dự tính (LV)'), num('interestOther', 'Lãi trích khác'), num('interestPaid', 'Lãi đã trả'), num('interestClosing', 'Lãi phải trả cuối kỳ'),
      { key: 'nextDueDate', label: 'Kỳ trả gốc kế tiếp', type: 'date' }, num('nextDuePrincipal', 'Gốc phải trả kỳ tới')],
    rows: r.rows as unknown as Record<string, unknown>[], footer: { code: 'Cộng', ...r.totals } };
}

// Chứng từ có dòng gắn khế ước (giải ngân, trả nợ, LV, đầu kỳ...) cho thẻ "Chứng từ" của màn hình khế ước.
export async function loanVouchers(trx: Trx, id: number) {
  return (await sql<{ id: string; voucherType: string; voucherNo: string | null; postingDate: string; state: string; description: string | null }>`
    SELECT DISTINCT v.id::text AS id, v.voucher_type AS "voucherType", v.voucher_no AS "voucherNo", v.posting_date::text AS "postingDate", v.state, v.description
    FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id WHERE l.contract_id = ${id}::bigint ORDER BY "postingDate", id`.execute(trx)).rows;
}
