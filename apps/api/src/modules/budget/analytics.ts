import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, SENSITIVE_FLAGS_ALL, type Decimal } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { evaluateFinancialReport } from '../reporting/financial.js';
import { actualMatrix, hiddenPrefixes } from './actuals.js';
import { getBudget, isDebitNormal, yearRegime } from './service.js';

type Trx = Transaction<Database>;
type Auth = { sensitive: Set<string> };
export interface ReportRow { lineCode: string; label: string; current: string }

// Hệ số tài chính: chỉ tính khi định nghĩa báo cáo của công ty CÓ dòng với đúng mã và nhãn mong đợi (nhãn kiểm để một mã dòng mang nghĩa khác ở chế độ khác không cho ra con số sai).
// Thiếu một dòng thì bỏ hệ số, không suy diễn. Mọi số lấy ở cuối kỳ báo cáo (không bình quân đầu/cuối kỳ), không quy năm.
type Pick = [code: string, label: RegExp][];
const TOTAL_ASSETS: Pick = [['280', /^TỔNG CỘNG TÀI SẢN/i], ['270', /^TỔNG CỘNG TÀI SẢN/i], ['200', /^TỔNG CỘNG TÀI SẢN/i]];
const LIABILITIES: Pick = [['300', /Nợ phải trả/i]];
const EQUITY: Pick = [['400', /VỐN CHỦ SỞ HỮU/i]];
const CURRENT_ASSETS: Pick = [['100', /TÀI SẢN NGẮN HẠN/i]];
const CURRENT_LIAB: Pick = [['310', /Nợ ngắn hạn/i]];
const INVENTORY: Pick = [['140', /Hàng tồn kho/i]];
const RECEIVABLE: Pick = [['131', /Phải thu.*khách hàng/i]];
const NET_REVENUE: Pick = [['10', /Doanh thu thuần/i]];
const GROSS_PROFIT: Pick = [['20', /Lợi nhuận gộp/i]];
const COGS: Pick = [['11', /Giá vốn/i]];
const NET_PROFIT: Pick = [['60', /Lợi nhuận sau thuế/i]];
interface RatioDef { code: string; name: string; unit: 'lan' | 'percent'; num: { b: 'B01' | 'B02'; pick: Pick; minus?: { b: 'B01' | 'B02'; pick: Pick } }; den: { b: 'B01' | 'B02'; pick: Pick } }
export const RATIO_DEFS: RatioDef[] = [
  { code: 'current', name: 'Hệ số thanh toán hiện hành', unit: 'lan', num: { b: 'B01', pick: CURRENT_ASSETS }, den: { b: 'B01', pick: CURRENT_LIAB } },
  { code: 'quick', name: 'Hệ số thanh toán nhanh', unit: 'lan', num: { b: 'B01', pick: CURRENT_ASSETS, minus: { b: 'B01', pick: INVENTORY } }, den: { b: 'B01', pick: CURRENT_LIAB } },
  { code: 'debt_assets', name: 'Nợ phải trả / Tổng tài sản', unit: 'percent', num: { b: 'B01', pick: LIABILITIES }, den: { b: 'B01', pick: TOTAL_ASSETS } },
  { code: 'debt_equity', name: 'Nợ phải trả / Vốn chủ sở hữu', unit: 'lan', num: { b: 'B01', pick: LIABILITIES }, den: { b: 'B01', pick: EQUITY } },
  { code: 'gross_margin', name: 'Biên lợi nhuận gộp', unit: 'percent', num: { b: 'B02', pick: GROSS_PROFIT }, den: { b: 'B02', pick: NET_REVENUE } },
  { code: 'net_margin', name: 'Biên lợi nhuận ròng', unit: 'percent', num: { b: 'B02', pick: NET_PROFIT }, den: { b: 'B02', pick: NET_REVENUE } },
  { code: 'roa', name: 'Lợi nhuận sau thuế / Tổng tài sản (ROA)', unit: 'percent', num: { b: 'B02', pick: NET_PROFIT }, den: { b: 'B01', pick: TOTAL_ASSETS } },
  { code: 'roe', name: 'Lợi nhuận sau thuế / Vốn chủ sở hữu (ROE)', unit: 'percent', num: { b: 'B02', pick: NET_PROFIT }, den: { b: 'B01', pick: EQUITY } },
  { code: 'inventory_turnover', name: 'Vòng quay hàng tồn kho (giá vốn / hàng tồn kho cuối kỳ)', unit: 'lan', num: { b: 'B02', pick: COGS }, den: { b: 'B01', pick: INVENTORY } },
  { code: 'receivable_turnover', name: 'Vòng quay phải thu (doanh thu thuần / phải thu khách hàng cuối kỳ)', unit: 'lan', num: { b: 'B02', pick: NET_REVENUE }, den: { b: 'B01', pick: RECEIVABLE } },
];
export interface Ratio { code: string; name: string; unit: 'lan' | 'percent'; value: string }

export function computeRatios(reports: { B01: ReportRow[]; B02: ReportRow[] }): Ratio[] {
  const val = (b: 'B01' | 'B02', pick: Pick): Decimal | null => {
    for (const [code, re] of pick) { const r = reports[b].find((x) => x.lineCode === code); if (r && re.test(r.label)) return D(r.current); }
    return null;
  };
  const out: Ratio[] = [];
  for (const d of RATIO_DEFS) {
    let n = val(d.num.b, d.num.pick); const den = val(d.den.b, d.den.pick);
    if (n && d.num.minus) { const m = val(d.num.minus.b, d.num.minus.pick); n = m ? n.minus(m) : null; }
    if (!n || !den || den.lte(0)) continue;
    const q = n.div(den);
    out.push({ code: d.code, name: d.name, unit: d.unit, value: d.unit === 'percent' ? q.times(100).toDecimalPlaces(2).toString() : q.toDecimalPlaces(2).toString() });
  }
  return out;
}

const NEED_ALL = SENSITIVE_FLAGS_ALL.filter((f) => f !== 'view_cost');
// Tổng quan phân tích tài chính của năm tài chính `year` đến hết tháng `month`. Mỗi nhóm số liệu bị che (null) khi thiếu cờ nhạy cảm tương ứng; `hidden` liệt kê các nhóm đó.
export async function analyticsOverview(trx: Trx, tenantId: string, auth: Auth, year: number, month: number) {
  const regime = await yearRegime(trx, year);
  const periods = (await trx.selectFrom('fiscal_period').select(['period_no', 'date_from', 'date_to']).where('fiscal_year', '=', year).where('period_no', '>=', 1).where('period_no', '<=', 12).orderBy('period_no').execute());
  if (!periods.length) throw new AppError('FISCAL_YEAR_NOT_FOUND', `Chưa mở năm tài chính ${year}`, 404);
  const canCost = auth.sensitive.has('view_cost'), canAr = auth.sensitive.has('view_receivable'), canAp = auth.sensitive.has('view_payable');
  const hidden: string[] = [...(canCost ? [] : ['view_cost']), ...(canAr ? [] : ['view_receivable']), ...(canAp ? [] : ['view_payable'])];

  const pl = await sql<{ period_no: number; rev: string; exp: string }>`SELECT v.period_no,
      coalesce(sum(l.credit - l.debit) FILTER (WHERE left(a.code, 1) IN ('5', '7')), 0)::text AS rev, coalesce(sum(l.debit - l.credit) FILTER (WHERE left(a.code, 1) IN ('6', '8')), 0)::text AS exp
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.fiscal_year = ${year} AND v.period_no BETWEEN 1 AND 12 AND v.state IN ('posted', 'reversed') AND NOT v.is_closing AND a.regime = ${regime} GROUP BY v.period_no`.execute(trx);
  const bal = [] as { cash: string; receivable: string; payable: string }[];
  for (const p of periods) {
    const r = await sql<{ cash: string; ar: string; ap: string }>`SELECT
        coalesce(sum(b.debit - b.credit) FILTER (WHERE a.subledger_kind IN ('cash', 'bank') OR starts_with(a.code, '113')), 0)::text AS cash,
        coalesce(sum(b.debit - b.credit) FILTER (WHERE a.subledger_kind = 'receivable'), 0)::text AS ar, coalesce(sum(b.credit - b.debit) FILTER (WHERE a.subledger_kind = 'payable'), 0)::text AS ap
      FROM fn_balances_at(${tenantId}::uuid, ${p.date_to}::date) b JOIN account a ON a.id = b.account_id WHERE a.regime = ${regime}`.execute(trx);
    bal.push({ cash: r.rows[0]!.cash, receivable: r.rows[0]!.ar, payable: r.rows[0]!.ap });
  }
  const months = periods.map((p, i) => {
    const x = pl.rows.find((r) => r.period_no === p.period_no);
    const rev = D(x?.rev ?? '0'), exp = D(x?.exp ?? '0');
    return { month: p.period_no, dateTo: p.date_to, revenue: rev.toString(), expense: canCost ? exp.toString() : null, profit: canCost ? rev.minus(exp).toString() : null,
      cash: bal[i]!.cash, receivable: canAr ? bal[i]!.receivable : null, payable: canAp ? bal[i]!.payable : null };
  });
  const upTo = months.filter((m) => m.month <= month);
  const sumOf = (k: 'revenue' | 'expense' | 'profit') => (upTo.some((m) => m[k] === null) ? null : upTo.reduce((a, m) => a.plus(m[k]!), D(0)).toString());
  const last = upTo[upTo.length - 1];

  let ratios: Ratio[] | null = null;
  if (NEED_ALL.every((f) => auth.sensitive.has(f)) && canCost) {
    const q = { from: periods[0]!.date_from, to: periods[Math.min(month, periods.length) - 1]!.date_to, comparePrevYear: false };
    try {
      const [b01, b02] = [await evaluateFinancialReport(trx, tenantId, { reportCode: 'B01', ...q }), await evaluateFinancialReport(trx, tenantId, { reportCode: 'B02', ...q })];
      ratios = computeRatios({ B01: b01.rows, B02: b02.rows });
    } catch (e) { if (!(e instanceof AppError)) throw e; ratios = []; } // chưa có định nghĩa báo cáo: không có hệ số
  }

  let budget = null;
  const ab = await trx.selectFrom('budget').select('id').where('fiscal_year', '=', year).where('status', '=', 'approved').executeTakeFirst();
  if (ab) {
    const b = await getBudget(trx, ab.id);
    const hide = await hiddenPrefixes(trx, auth, year, b.lines.map((l) => l.accountPrefix));
    const shown = b.lines.filter((l) => !hide.has(l.accountPrefix));
    const act = await actualMatrix(trx, ab.id, year);
    const agg = (debit: boolean) => Array.from({ length: 12 }, (_, i) => {
      const ls = shown.filter((l) => isDebitNormal(l.accountPrefix) === debit);
      return { month: i + 1, budget: ls.reduce((a, l) => a.plus(l.months[i]!), D(0)).toString(), actual: ls.reduce((a, l) => a.plus((act.get(l.id) ?? [])[i] ?? '0'), D(0)).toString() };
    });
    budget = { id: b.id, name: b.name, version: b.version, hiddenLines: b.lines.length - shown.length, expense: agg(true), revenue: agg(false) };
  }
  return { fiscalYear: year, month, regime, hidden, months,
    summary: { revenue: sumOf('revenue'), expense: sumOf('expense'), profit: sumOf('profit'), cash: last?.cash ?? '0', receivable: last?.receivable ?? null, payable: last?.payable ?? null },
    ratios, budget };
}
