import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { TRANSLATION_STATUSES } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

const regime = z.enum(['TT99', 'TT133', 'TT200', 'TT58']);
const reportCode = z.enum(['B01', 'B02', 'B03']);
const status = z.enum(TRANSLATION_STATUSES);
// Bản dịch rỗng hoặc null = xóa bản dịch (trạng thái về NULL do trigger fn_translation_status); có bản dịch mà không nêu trạng thái là 'draft'.
const en = z.string().trim().max(500).nullable();
const accountItem = z.object({ code: z.string().min(1), nameEn: en, status: status.optional() });
const lineItem = z.object({ lineCode: z.string().min(1), labelEn: en, status: status.optional() });

// Tên tiếng Anh của tài khoản và chỉ tiêu báo cáo (tham khảo, không phải dữ liệu pháp lý): xem, sửa hàng loạt, điền chỗ trống từ mẫu hệ thống.
const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/translations/accounts', { preHandler: app.requirePermission('account.view'), schema: { querystring: z.object({ regime }) } }, async (req) =>
    app.withTenant(req, async (trx) => (await trx.selectFrom('account').select(['code', 'name', 'name_en', 'translation_status', 'is_group']).where('regime', '=', req.query.regime).orderBy('code').execute())
      .map((a) => ({ code: a.code, name: a.name, nameEn: a.name_en, status: a.translation_status, isGroup: a.is_group }))));
  app.put('/api/translations/accounts', { preHandler: app.requirePermission('account.update'), schema: { body: z.object({ regime, items: z.array(accountItem).min(1).max(2000) }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      for (const it of req.body.items) {
        const v = it.nameEn?.trim() || null;
        const r = await trx.updateTable('account').set({ name_en: v, translation_status: v ? it.status ?? 'draft' : null }).where('regime', '=', req.body.regime).where('code', '=', it.code).returning('id').executeTakeFirst();
        if (!r) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản ${it.code}`, 404);
      }
      return { count: req.body.items.length };
    }));
  app.get('/api/translations/report-lines', { preHandler: app.requirePermission('report_def.view'), schema: { querystring: z.object({ regime, code: reportCode }) } }, async (req) =>
    app.withTenant(req, async (trx) => (await trx.selectFrom('report_line as l').innerJoin('report_def as d', 'd.id', 'l.report_def_id').select(['l.line_code', 'l.label', 'l.label_en', 'l.translation_status'])
      .where('d.regime', '=', req.query.regime).where('d.report_code', '=', req.query.code).orderBy('l.sort_order').execute())
      .map((l) => ({ lineCode: l.line_code, label: l.label, labelEn: l.label_en, status: l.translation_status }))));
  app.put('/api/translations/report-lines', { preHandler: app.requirePermission('report_def.update'), schema: { body: z.object({ regime, reportCode, items: z.array(lineItem).min(1).max(500) }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const def = await trx.selectFrom('report_def').select('id').where('regime', '=', req.body.regime).where('report_code', '=', req.body.reportCode).executeTakeFirst();
      if (!def) throw new AppError('REPORT_NOT_FOUND', `Chưa có định nghĩa báo cáo ${req.body.reportCode} cho ${req.body.regime}`, 404);
      for (const it of req.body.items) {
        const v = it.labelEn?.trim() || null;
        const r = await trx.updateTable('report_line').set({ label_en: v, translation_status: v ? it.status ?? 'draft' : null }).where('report_def_id', '=', def.id).where('line_code', '=', it.lineCode).returning('id').executeTakeFirst();
        if (!r) throw new AppError('REPORT_LINE_NOT_FOUND', `Không có chỉ tiêu ${it.lineCode}`, 404);
      }
      return { count: req.body.items.length };
    }));
  // Chỉ điền ô còn trống từ mẫu hệ thống (bản nháp); không ghi đè tên đã nhập.
  app.post('/api/translations/fill-from-template', { preHandler: app.requirePermission('account.update'), schema: { body: z.object({ regime, scope: z.enum(['accounts', 'report-lines']) }) } }, async (req) => {
    if (req.body.scope === 'report-lines' && !req.auth!.permissions.has('report_def.update')) throw new AppError('FORBIDDEN', 'Thiếu quyền report_def.update', 403);
    return app.withTenant(req, async (trx) => {
      const r = req.body.scope === 'accounts'
        ? await sql`UPDATE account a SET name_en = t.name_en FROM coa_template t WHERE t.regime = a.regime AND t.code = a.code AND a.regime = ${req.body.regime} AND (a.name_en IS NULL OR btrim(a.name_en) = '') AND t.name_en IS NOT NULL`.execute(trx)
        : await sql`UPDATE report_line l SET label_en = t.label_en FROM report_template t, report_def d WHERE d.id = l.report_def_id AND d.regime = t.regime AND d.report_code = t.report_code AND t.line_code = l.line_code AND d.regime = ${req.body.regime} AND (l.label_en IS NULL OR btrim(l.label_en) = '') AND t.label_en IS NOT NULL`.execute(trx);
      return { count: Number(r.numAffectedRows ?? 0) };
    });
  });
};
export default routes;
