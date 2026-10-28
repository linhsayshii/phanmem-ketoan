export type Regime = 'TT99' | 'TT133' | 'TT200' | 'TT58' | 'TT152';
export interface FiscalPeriodInput { fiscalYear: number; periodNo: number; dateFrom: string; dateTo: string; regime: Regime }

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function buildFiscalPeriods(input: { fiscalYear: number; dateFrom: string; months: number; regime: Regime }): FiscalPeriodInput[] {
  const first = new Date(input.dateFrom + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-01$/.test(input.dateFrom) || Number.isNaN(first.getTime()) || iso(first) !== input.dateFrom) throw new Error('dateFrom phải là ngày đầu tháng dạng YYYY-MM-01');
  if (!Number.isInteger(input.fiscalYear)) throw new Error('fiscalYear phải là số nguyên');
  if (!Number.isInteger(input.months) || input.months < 1 || input.months > 15) throw new Error('Số tháng phải từ 1 đến 15');
  const start = new Date(input.dateFrom + 'T00:00:00Z');
  if (Number.isNaN(start.getTime()) || start.getUTCDate() !== 1) throw new Error('Ngày bắt đầu phải là ngày đầu tháng');
  const out: FiscalPeriodInput[] = [];
  const dayBefore = new Date(start); dayBefore.setUTCDate(0);
  out.push({ fiscalYear: input.fiscalYear, periodNo: 0, dateFrom: iso(dayBefore), dateTo: iso(dayBefore), regime: input.regime });
  for (let i = 0; i < input.months; i++) {
    const from = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const to = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, 0));
    out.push({ fiscalYear: input.fiscalYear, periodNo: i + 1, dateFrom: iso(from), dateTo: iso(to), regime: input.regime });
  }
  return out;
}
