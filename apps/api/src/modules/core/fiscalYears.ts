import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Transaction } from 'kysely';
import { buildFiscalPeriods, type Regime } from '@kt/domain';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { generateAccounts } from '../coa/service.js';
import { loadClosingTemplate } from '../ledger/closing.js';
import { copyReportTemplates } from '../reporting/financial.js';
import { BOOK_REGIMES, isRegimeReady, type BookRegime } from '@kt/coa-data';

export const fiscalYearBody = z.object({
  fiscalYear: z.number().int().min(2000).max(2100), dateFrom: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/, 'Ngày bắt đầu phải là ngày đầu tháng (YYYY-MM-01)'),
  months: z.number().int().min(1).max(15).default(12), regime: z.enum(['TT99', 'TT133', 'TT200', 'TT58', 'TT152']),
});
export type FiscalYearInput = z.infer<typeof fiscalYearBody>;

export async function createFiscalYear(trx: Transaction<Database>, tenantId: string, input: FiscalYearInput): Promise<number> {
  const existing = await trx.selectFrom('fiscal_period').select('fiscal_year').where('fiscal_year', '=', input.fiscalYear).executeTakeFirst();
  if (existing) throw new AppError('FISCAL_YEAR_EXISTS', `Năm tài chính ${input.fiscalYear} đã tồn tại`, 409);
  const last = await trx.selectFrom('fiscal_period').select(['date_to', 'regime']).where('period_no', '>', 0).orderBy('date_to', 'desc').executeTakeFirst();
  if (last) {
    const next = new Date(last.date_to + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
    if (next.toISOString().slice(0, 10) !== input.dateFrom) throw new AppError('FISCAL_YEAR_GAP', `Năm mới phải bắt đầu ngày ${next.toISOString().slice(0, 10)}`, 409);
  }
  let periods: ReturnType<typeof buildFiscalPeriods>;
  try { periods = buildFiscalPeriods({ fiscalYear: input.fiscalYear, dateFrom: input.dateFrom, months: input.months, regime: input.regime as Regime }); }
  catch (e) { throw new AppError('VALIDATION', (e as Error).message, 400); }
  await trx.insertInto('fiscal_period').values(periods.map((p) => ({ tenant_id: tenantId, fiscal_year: p.fiscalYear, period_no: p.periodNo, date_from: p.dateFrom, date_to: p.dateTo, regime: p.regime }))).execute();
  // GĐ7 nhóm 6b: TT58, TT152 không có hệ thống tài khoản; ghi sổ đơn ở modules/hkdbooks nên chỉ tạo kỳ, không sinh tài khoản, sơ đồ kết chuyển, báo cáo.
  if ((BOOK_REGIMES as string[]).includes(input.regime)) {
    if (!isRegimeReady(input.regime as BookRegime)) throw new AppError('COA_TEMPLATE_PENDING', `Chế độ ${input.regime} chưa đủ dữ liệu pháp lý để dùng (xem Hệ thống > Chế độ kế toán)`, 409);
    return periods.length;
  }
  const hasAccounts = await trx.selectFrom('account').select('id').where('regime', '=', input.regime).limit(1).executeTakeFirst();
  if (!hasAccounts) await generateAccounts(trx, tenantId, input.regime as Regime);
  // Sơ đồ kết chuyển mặc định của chế độ này nạp khi công ty chưa có bước nào của chế độ đó; không bao giờ xóa sơ đồ chế độ khác (năm cũ còn cần kết chuyển).
  if (!(await trx.selectFrom('closing_step').select('id').where('regime', '=', input.regime).limit(1).executeTakeFirst())) await loadClosingTemplate(trx, tenantId, input.regime as Regime);
  // Định nghĩa báo cáo của hệ này chỉ sao chép từ mẫu khi công ty chưa có: năm sau không ghi đè báo cáo đã sửa (bộ chờ văn bản thì không có mẫu để sao chép).
  if (!(await trx.selectFrom('report_def').select('id').where('regime', '=', input.regime).limit(1).executeTakeFirst())) await copyReportTemplates(trx, tenantId, input.regime);
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
