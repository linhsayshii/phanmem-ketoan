import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { loadCitLedger, type CitLedgerMap } from '@kt/coa-data';
import { CitError, citRateFor, D, Decimal, quarterlyEstimate, VND_AMOUNT_MSG, type CitRateParam, type Regime } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { legalParam } from '../core/legal.js';
import { evaluateFinancialReport } from '../reporting/financial.js';
import { createVoucher, type VoucherDto } from '../ledger/vouchers.service.js';

// Tạm tính thuế TNDN quý: lợi nhuận kế toán lũy kế lấy đúng chỉ tiêu lợi nhuận trước thuế của B02 (cùng bộ máy báo cáo, không kết chuyển), thuế suất theo tham số
// cit_rate/cit_exempt_revenue (legal_param) và doanh thu năm trước, số đã tạm nộp từ sổ cái (Nợ 3334 đối ứng tiền). Ánh xạ chỉ tiêu, tài khoản theo chế độ: data/tax/cit-ledger.json.
type Trx = Transaction<Database>;
const amount = (what: string) => z.string().regex(/^-?\d{1,16}$/, `${what} phải là số nguyên VND tối đa 16 chữ số, có thể âm`);
export const estimateQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100), quarter: z.coerce.number().int().min(1).max(4),
  prevRevenue: z.string().regex(/^\d{1,16}$/, VND_AMOUNT_MSG).optional(), rate: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Thuế suất là số phần trăm').optional(),
  adjustments: amount('Điều chỉnh').optional(), lossCarried: z.string().regex(/^\d{1,16}$/, VND_AMOUNT_MSG).optional(), paidYtd: z.string().regex(/^\d{1,16}$/, VND_AMOUNT_MSG).optional(),
});
export const estimateVoucherInput = z.object({ year: z.number().int().min(2000).max(2100), quarter: z.number().int().min(1).max(4), amount: z.string().regex(/^[1-9]\d{0,15}$/, 'Số tiền phải là số nguyên VND dương') });

export interface FiscalYearInfo { year: number; regime: Regime; from: string; to: string; months: { no: number; from: string; to: string }[] }
// Năm tài chính (kỳ 1-12) theo số năm; không có thì null.
export async function fiscalYearInfo(trx: Trx, year: number): Promise<FiscalYearInfo | null> {
  const ps = await trx.selectFrom('fiscal_period').select(['period_no', 'date_from', 'date_to', 'regime']).where('fiscal_year', '=', year).where('period_no', '>=', 1).orderBy('period_no').execute();
  if (!ps.length) return null;
  return { year, regime: ps[0]!.regime as Regime, from: ps[0]!.date_from, to: ps[ps.length - 1]!.date_to, months: ps.map((p) => ({ no: p.period_no, from: p.date_from, to: p.date_to })) };
}
export async function requireFiscalYear(trx: Trx, year: number): Promise<FiscalYearInfo> {
  const fy = await fiscalYearInfo(trx, year);
  if (!fy) throw new AppError('PERIOD_NOT_FOUND', `Chưa mở năm tài chính ${year}`, 404);
  return fy;
}
export function citLedger(regime: string): CitLedgerMap {
  const m = loadCitLedger(regime as Regime);
  if (!m) throw new AppError('CIT_LEDGER_UNSUPPORTED', `Chưa có ánh xạ thuế TNDN cho chế độ ${regime}`, 409);
  return m;
}

// Lợi nhuận trước thuế và tổng doanh thu (theo revenueLines) của B02 trong khoảng ngày, cùng hàm báo cáo màn hình B02 dùng.
export async function b02Figures(trx: Trx, tenantId: string, regime: string, from: string, to: string): Promise<{ profit: string; revenue: string }> {
  const m = citLedger(regime);
  const rows = (await evaluateFinancialReport(trx, tenantId, { reportCode: 'B02', from, to, comparePrevYear: false })).rows;
  const val = (code: string) => { const r = rows.find((x) => x.lineCode === code); if (!r) throw new AppError('REPORT_LINE_NOT_FOUND', `B02 của công ty không có chỉ tiêu ${code}`, 409); return D(r.current); };
  return { profit: val(m.profitLine).toFixed(0), revenue: m.revenueLines.reduce((s, c) => s.plus(val(c)), D(0)).toFixed(0) };
}

// Doanh thu năm trước từ sổ cái: năm tài chính trước đã mở và có chứng từ đã ghi sổ; năm dưới 12 tháng thì quy đổi 12 tháng (NĐ 320/2025 Điều 11 khoản 4 điểm a,
// lấy số tháng của năm tài chính thay cho số tháng thực tế hoạt động). Năm trước không có số liệu thì null: không coi là doanh thu 0 (sẽ thành miễn thuế sai).
export async function prevYearRevenue(trx: Trx, tenantId: string, year: number): Promise<{ revenue: string; note: string } | null> {
  const fy = await fiscalYearInfo(trx, year - 1);
  if (!fy) return null;
  const any = await trx.selectFrom('voucher').select('id').where('state', 'in', ['posted', 'reversed']).where('posting_date', '>=', fy.from).where('posting_date', '<=', fy.to).where('voucher_type', '<>', 'DK').limit(1).executeTakeFirst();
  if (!any) return null;
  const { revenue } = await b02Figures(trx, tenantId, fy.regime, fy.from, fy.to);
  const n = fy.months.length;
  if (n >= 12) return { revenue, note: `Doanh thu năm ${year - 1} theo B02 (chỉ tiêu ${citLedger(fy.regime).revenueLines.join(', ')})` };
  return { revenue: D(revenue).times(12).div(n).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0), note: `Doanh thu năm ${year - 1} theo B02 (${n} tháng) quy đổi 12 tháng (NĐ 320/2025 Điều 11 khoản 4 điểm a)` };
}

// Số thuế TNDN đã nộp: phát sinh Nợ - Có TK thuế TNDN (3334) trên chứng từ có dòng tiền (111, 112), trong khoảng ngày; chứng từ đảo tự trừ.
export async function paidBetween(trx: Trx, regime: string, from: string, to: string): Promise<string> {
  const m = citLedger(regime);
  const cash = sql.join(m.cashAccounts.map((c) => sql`starts_with(a2.code, ${c})`), sql` OR `);
  const r = await sql<{ v: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS v FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.state IN ('posted', 'reversed') AND a.regime = ${regime} AND starts_with(a.code, ${m.payableAccount}) AND l.posting_date BETWEEN ${from}::date AND ${to}::date
      AND EXISTS (SELECT 1 FROM voucher_line l2 JOIN account a2 ON a2.id = l2.account_id WHERE l2.voucher_id = v.id AND (${cash}))`.execute(trx);
  return D(r.rows[0]!.v).toFixed(0);
}
// Ngày cuối tháng thứ n sau ngày `iso` (n = 0: cuối tháng của chính ngày đó).
export const monthEndAfter = (iso: string, n: number) => { const [y, m] = iso.split('-').map(Number) as [number, number]; const d = new Date(Date.UTC(y, m + n, 0)); return d.toISOString().slice(0, 10); };

// Thuế suất đề xuất cho năm: tham số tra theo ngày đầu năm tài chính. Lỗi CIT_RATE_REQUIRED để người gọi quyết định (tạm tính trả rate null, tờ khai để C7a trống).
export async function rateOfYear(trx: Trx, fy: FiscalYearInfo, prevRevenue: string | null, override?: string, withExempt = true) {
  const param = await legalParam<CitRateParam>(trx, 'cit_rate', fy.from);
  const exemptMax = withExempt ? await legalParam<string>(trx, 'cit_exempt_revenue', fy.from) : null;
  return citRateFor(prevRevenue, param, override, exemptMax);
}
export const RATE_CONDITIONS = 'Thuế suất 15%, 17% và miễn thuế theo doanh thu không áp dụng cho công ty con, công ty có quan hệ liên kết với doanh nghiệp không đáp ứng điều kiện và một số khoản thu nhập (Luật 67/2025/QH15 Điều 18 khoản 3, 4; NĐ 320/2025 Điều 11 khoản 4 điểm c; NĐ 141/2026 Điều 2 điểm d): khi đó nhập thuế suất.';

export async function citEstimate(trx: Trx, tenantId: string, q: z.infer<typeof estimateQuery>) {
  const fy = await requireFiscalYear(trx, q.year);
  if (fy.months.length < q.quarter * 3) throw new AppError('PERIOD_NOT_FOUND', `Năm tài chính ${q.year} không có quý ${q.quarter}`, 404);
  const m = citLedger(fy.regime); const qEnd = fy.months[q.quarter * 3 - 1]!.to;
  const warnings: string[] = [];
  const cur = await b02Figures(trx, tenantId, fy.regime, fy.from, qEnd);
  const prev = q.prevRevenue !== undefined ? { revenue: q.prevRevenue, note: 'Doanh thu năm trước nhập tay' } : await prevYearRevenue(trx, tenantId, q.year);
  let rate: { rate: string; basis: string; exempt: boolean } | null = null;
  try { rate = await rateOfYear(trx, fy, prev?.revenue ?? null, q.rate); } catch (e) { if (!(e instanceof CitError) || e.code !== 'CIT_RATE_REQUIRED') throw e; warnings.push(e.message); }
  if (rate && q.rate === undefined) warnings.push(RATE_CONDITIONS);
  // Đã tạm nộp cho năm: chứng từ nộp từ đầu quý 2 đến hết quý tính (khoản nộp tháng 1-3 thường là quý 4 và quyết toán năm trước); quý 1 chưa có.
  const paidWindow = q.quarter === 1 ? null : { from: fy.months[3]!.from, to: qEnd };
  const paidYtd = q.paidYtd ?? (paidWindow ? await paidBetween(trx, fy.regime, paidWindow.from, paidWindow.to) : '0');
  const adjustments = q.adjustments ?? '0'; const lossCarried = q.lossCarried ?? '0';
  const est = rate ? quarterlyEstimate({ ytdProfit: cur.profit, adjustments, lossCarried, rate: rate.rate, paidYtd }) : null;

  const reduction = await legalParam<{ rate: number; maxRevenue: string }>(trx, 'cit_reduction', fy.from);
  if (reduction) warnings.push(`NQ 43/2026/QH16: doanh nghiệp có doanh thu năm ${q.year} không quá ${D(reduction.maxRevenue).div(1e9).toString()} tỷ đồng được giảm ${reduction.rate}% số thuế TNDN phải nộp của năm; phần mềm chỉ áp dụng khi lập tờ khai quyết toán (03/TNDN chỉ tiêu C15), số tạm tính quý chưa giảm.`);
  if (q.quarter === 4) {
    const ratio = await legalParam<number>(trx, 'cit_prepay_min_ratio', fy.to);
    const ret = await trx.selectFrom('tax_return').select(['revision', 'values']).where('form_code', '=', '03/TNDN').where('year', '=', q.year).where('status', '=', 'final').orderBy('revision', 'desc').executeTakeFirst();
    if (ratio && ret) {
      const due = D(ret.values.E1 ?? '0').plus(ret.values.E5 ?? '0'); const paid4 = await paidBetween(trx, fy.regime, fy.months[3]!.from, monthEndAfter(fy.to, 1));
      if (D(paid4).lt(due.times(ratio).div(100))) warnings.push(`Tổng số thuế đã tạm nộp 4 quý (${paid4}) thấp hơn ${ratio}% số thuế phải nộp theo quyết toán (${due.toFixed(0)}): phần nộp thiếu chịu tiền chậm nộp (NĐ 252/2026/NĐ-CP Điều 24 khoản 3).`);
    }
  }
  return {
    year: q.year, quarter: q.quarter, regime: fy.regime, period: { from: fy.from, to: qEnd },
    ytdProfit: cur.profit, revenueYtd: cur.revenue, profitSource: `B02 chỉ tiêu ${m.profitLine} từ ${fy.from} đến ${qEnd}`,
    prevRevenue: prev?.revenue ?? null, prevRevenueSource: q.prevRevenue !== undefined ? 'manual' as const : prev ? 'ledger' as const : null, prevRevenueNote: prev?.note ?? null,
    rate: rate?.rate ?? null, rateBasis: rate?.basis ?? null, exempt: rate?.exempt ?? false,
    adjustments, lossCarried, paidYtd, paidWindow,
    taxableIncome: est?.taxableIncome ?? null, taxYtd: est?.taxYtd ?? null, payable: est?.payable ?? null,
    accounts: { expense: m.expenseAccount, payable: m.payableAccount }, warnings,
  };
}

// Chứng từ chi phí thuế TNDN tạm tính quý: PKT nháp ngày cuối quý, Nợ TK chi phí thuế TNDN hiện hành / Có 3334; người dùng kiểm tra rồi ghi sổ như chứng từ thường.
export async function createEstimateVoucher(trx: Trx, ctx: { tenantId: string; userId: string }, b: z.infer<typeof estimateVoucherInput>): Promise<VoucherDto> {
  const fy = await requireFiscalYear(trx, b.year);
  if (fy.months.length < b.quarter * 3) throw new AppError('PERIOD_NOT_FOUND', `Năm tài chính ${b.year} không có quý ${b.quarter}`, 404);
  const m = citLedger(fy.regime); const date = fy.months[b.quarter * 3 - 1]!.to;
  const description = `Chi phí thuế TNDN tạm tính quý ${b.quarter}/${b.year}`;
  return createVoucher(trx, ctx, { voucherType: 'PKT', postingDate: date, documentDate: date, description, currencyCode: 'VND',
    lines: [{ accountCode: m.expenseAccount, debit: b.amount, credit: '0', description }, { accountCode: m.payableAccount, debit: '0', credit: b.amount, description }] });
}
