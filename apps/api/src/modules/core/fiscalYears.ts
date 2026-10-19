import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Transaction } from 'kysely';
import { buildFiscalPeriods, type Regime } from '@kt/domain';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';

export const fiscalYearBody = z.object({
  fiscalYear: z.number().int().min(2000).max(2100), dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  months: z.number().int().min(1).max(15).default(12), regime: z.enum(['TT99', 'TT133', 'TT200', 'TT58']),
});
export type FiscalYearInput = z.infer<typeof fiscalYearBody>;

export async function createFiscalYear(trx: Transaction<Database>, tenantId: string, input: FiscalYearInput): Promise<number> {
  const existing = await trx.selectFrom('fiscal_period').select('fiscal_year').where('fiscal_year', '=', input.fiscalYear).executeTakeFirst();
  if (existing) throw new AppError('FISCAL_YEAR_EXISTS', `Năm tài chính ${input.fiscalYear} đã tồn tại`, 409);
  const last = await trx.selectFrom('fiscal_period').select('date_to').where('period_no', '>', 0).orderBy('date_to', 'desc').executeTakeFirst();
  if (last) {
    const next = new Date(last.date_to + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
    if (next.toISOString().slice(0, 10) !== input.dateFrom) throw new AppError('FISCAL_YEAR_GAP', `Năm mới phải bắt đầu ngày ${next.toISOString().slice(0, 10)}`, 409);
  }
  const periods = buildFiscalPeriods({ fiscalYear: input.fiscalYear, dateFrom: input.dateFrom, months: input.months, regime: input.regime as Regime });
  await trx.insertInto('fiscal_period').values(periods.map((p) => ({ tenant_id: tenantId, fiscal_year: p.fiscalYear, period_no: p.periodNo, date_from: p.dateFrom, date_to: p.dateTo, regime: p.regime }))).execute();
  return periods.length;
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post('/api/fiscal-years', { preHandler: app.requirePermission('period.create'), schema: { body: fiscalYearBody } }, async (req, reply) => {
    const n = await app.withTenant(req, (trx) => createFiscalYear(trx, req.auth!.tenantId!, req.body));
    return reply.status(201).send({ periods: n });
  });
  app.get('/api/fiscal-years', { preHandler: app.requireAuth }, async (req) =>
    app.withTenant(req, async (trx) => {
      const rows = await trx.selectFrom('fiscal_period').selectAll().orderBy('fiscal_year').orderBy('period_no').execute();
      const years = new Map<number, { fiscalYear: number; regime: string; dateFrom: string; dateTo: string; periods: { periodNo: number; dateFrom: string; dateTo: string; status: string }[] }>();
      for (const r of rows) {
        const y = years.get(r.fiscal_year) ?? { fiscalYear: r.fiscal_year, regime: r.regime, dateFrom: '', dateTo: '', periods: [] };
        y.periods.push({ periodNo: r.period_no, dateFrom: r.date_from, dateTo: r.date_to, status: r.status });
        if (r.period_no === 1) y.dateFrom = r.date_from;
        if (r.period_no > 0) y.dateTo = r.date_to;
        years.set(r.fiscal_year, y);
      }
      return [...years.values()];
    }));
};
export default routes;
