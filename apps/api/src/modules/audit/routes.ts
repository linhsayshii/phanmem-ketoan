import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { vnDayEnd, vnDayStart } from '../core/vnTime.js';
import { AppError } from '../../plugins/errors.js';
import { SALARY_AUDIT_ENTITIES } from '../payroll/profiles.js';
import { salaryAccountIds } from '../payroll/accounts.js';
import { TNCN_FORMS } from '../payroll/tncnReturn.js';

const COST_AUDIT_ENTITIES = ['cost_run', 'project_alloc_run'];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const paging = { page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(500).default(50) };

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/audit', { preHandler: app.requirePermission('audit.view'), schema: { querystring: z.object({
      entity: z.string().optional(), entityId: z.string().optional(), userId: z.string().uuid().optional(), action: z.string().optional(),
      from: day.optional(), to: day.optional(), ...paging }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const q = req.query;
      let base = trx.selectFrom('audit_event as a').leftJoin('app_user as u', 'u.id', 'a.user_id');
      // Nhật ký của hồ sơ lương chứa số lương trước/sau: thiếu view_salary thì hỏi thẳng là 403, còn xem chung thì bỏ các dòng này.
      if (!req.auth!.sensitive.has('view_salary')) {
        if (q.entity && SALARY_AUDIT_ENTITIES.includes(q.entity)) throw new AppError('SALARY_FORBIDDEN', 'Không có quyền xem lương', 403);
        base = base.where('a.entity', 'not in', SALARY_AUDIT_ENTITIES);
        // Ảnh chụp trước/sau của dòng chứng từ đã ghi sổ (sửa diễn giải, chiều) mang số tiền: bỏ mọi dòng của chứng từ có dòng trên tài khoản lương, BH, TNCN (dòng tiền đối ứng
        // bằng đúng số lương). Dòng số dư đầu kỳ: bỏ dòng thuộc tài khoản lương.
        // Chứng từ đã bỏ ghi sổ rồi xóa nháp không còn dòng để so: xét thêm TK của chính sự kiện và của các sự kiện dòng khác cùng chứng từ.
        const ids = (await salaryAccountIds(trx)).map(String);
        if (ids.length) base = base.where(sql<boolean>`NOT (
          (a.entity = 'voucher_line' AND (coalesce(a.after, a.before)->>'account_id' = ANY(${ids}::text[])
            OR EXISTS (SELECT 1 FROM voucher_line sl WHERE sl.voucher_id = (coalesce(a.after, a.before)->>'voucher_id')::uuid AND sl.posting_date = (coalesce(a.after, a.before)->>'posting_date')::date
              AND sl.account_id::text = ANY(${ids}::text[]))
            OR EXISTS (SELECT 1 FROM audit_event a2 WHERE a2.entity = 'voucher_line' AND coalesce(a2.after, a2.before)->>'voucher_id' = coalesce(a.after, a.before)->>'voucher_id'
              AND coalesce(a2.after, a2.before)->>'account_id' = ANY(${ids}::text[]))))
          OR (a.entity = 'opening_balance' AND coalesce(a.after->>'account_id', a.before->>'account_id') = ANY(${ids}::text[])))`);
        // Tờ khai 05/KK-TNCN, 05/QTT-TNCN lưu bảng kê từng người (tên, MST, thu nhập, thuế) trong values; tax_return còn chứa tờ khai GTGT, TNDN nên chỉ bỏ hai mẫu này.
        base = base.where(sql<boolean>`NOT (a.entity = 'tax_return' AND coalesce(a.after, a.before)->>'form_code' = ANY(${Object.keys(TNCN_FORMS)}::text[]))`);
      }
      // Lần chạy giá thành (cảnh báo, giá thành định mức) và phân bổ, kết chuyển giá vốn vụ việc (số tiền từng vụ việc) là dữ liệu giá vốn.
      if (!req.auth!.sensitive.has('view_cost')) {
        if (q.entity && COST_AUDIT_ENTITIES.includes(q.entity)) throw new AppError('FORBIDDEN', 'Không có quyền xem giá vốn', 403);
        base = base.where('a.entity', 'not in', COST_AUDIT_ENTITIES);
      }
      if (q.entity) base = base.where('a.entity', '=', q.entity);
      if (q.entityId) base = base.where('a.entity_id', '=', q.entityId);
      if (q.userId) base = base.where('a.user_id', '=', q.userId);
      if (q.action) base = base.where('a.action', '=', q.action);
      if (q.from) base = base.where('a.ts', '>=', vnDayStart(q.from));
      if (q.to) base = base.where('a.ts', '<', vnDayEnd(q.to));
      const total = Number((await base.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow()).n);
      const rows = await base.select(['a.id', 'a.ts', 'u.username', 'a.action', 'a.entity', 'a.entity_id as entityId', 'a.before', 'a.after', 'a.ip'])
        .orderBy('a.id', 'desc').limit(q.size).offset((q.page - 1) * q.size).execute();
      return { rows, total };
    }));

  app.get('/api/audit/logins', { preHandler: app.requirePermission('audit.view'), schema: { querystring: z.object({ from: day.optional(), to: day.optional(), ...paging }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const tenantId = req.auth!.tenantId!;
      let base = trx.selectFrom('login_event as l').where('l.username', 'in', trx.selectFrom('tenant_user').innerJoin('app_user', 'app_user.id', 'tenant_user.user_id').select('app_user.username').where('tenant_user.tenant_id', '=', tenantId));
      if (req.query.from) base = base.where('l.ts', '>=', vnDayStart(req.query.from));
      if (req.query.to) base = base.where('l.ts', '<', vnDayEnd(req.query.to));
      const total = Number((await base.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow()).n);
      const rows = await base.select(['l.ts', 'l.username', 'l.success', 'l.ip']).orderBy('l.id', 'desc').limit(req.query.size).offset((req.query.page - 1) * req.query.size).execute();
      return { rows, total };
    }));
};
export default routes;
