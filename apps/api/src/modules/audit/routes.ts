import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { vnDayEnd, vnDayStart } from '../core/vnTime.js';
import { AppError } from '../../plugins/errors.js';
import { SALARY_AUDIT_ENTITIES } from '../payroll/profiles.js';
import { salaryAccountIds } from '../payroll/accounts.js';
import { TNCN_FORMS } from '../payroll/tncnReturn.js';

// Bảng có trg_audit mang số liệu giá vốn, công nợ (kiểm tra bằng bộ quét danh mục ở test/audit.test.ts: bảng mới có số tiền nhạy cảm phải vào danh sách hoặc danh sách không che).
// Giá vốn: dòng hàng phiếu kho (đơn giá, giá trị tồn, chi phí mua), tồn đầu kỳ, lần chạy giá thành/giá vốn, phân bổ chi phí mua và vụ việc, định mức, hợp đồng (giá trị, lãi lỗ).
const COST_AUDIT_ENTITIES = ['cost_run', 'project_alloc_run', 'voucher_item_line', 'opening_stock', 'costing_run', 'landed_cost_alloc', 'stocktake_line', 'cost_norm', 'cost_norm_line',
  'contract', 'contract_amendment', 'contract_milestone', 'book_stock_move'];
// Phải trả: khế ước vay (dư nợ gốc, lãi), hóa đơn đầu vào. Phải thu: chưa có bảng riêng (khoản phải thu nằm ở dòng chứng từ, số dư đầu kỳ, đối trừ: lọc theo tài khoản bên dưới).
const PAYABLE_AUDIT_ENTITIES = ['loan_installment', 'loan_rate', 'loan_term', 'inbound_invoice', 'inbound_invoice_line'];
const RECEIVABLE_AUDIT_ENTITIES: string[] = [];

// Id tài khoản (mọi hệ) mà người gọi bị che theo cờ: lương, giá vốn (632*, kho), phải thu, phải trả.
async function hiddenAccounts(trx: Parameters<typeof salaryAccountIds>[0], has: (f: string) => boolean): Promise<{ ids: number[]; codes: string[] }> {
  const ids = new Set<number>();
  if (!has('view_salary')) for (const id of await salaryAccountIds(trx)) ids.add(id);
  const rows = await trx.selectFrom('account').select(['id', 'code', 'subledger_kind']).execute();
  for (const a of rows) {
    if (!has('view_receivable') && a.subledger_kind === 'receivable') ids.add(a.id);
    if (!has('view_payable') && a.subledger_kind === 'payable') ids.add(a.id);
    if (!has('view_cost') && (a.subledger_kind === 'inventory' || a.code.startsWith('632'))) ids.add(a.id);
  }
  return { ids: [...ids], codes: [...new Set(rows.filter((a) => ids.has(a.id)).map((a) => a.code))] };
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const paging = { page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(500).default(50) };

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/audit', { preHandler: app.requirePermission('audit.view'), schema: { querystring: z.object({
      entity: z.string().optional(), entityId: z.string().optional(), userId: z.string().uuid().optional(), action: z.string().optional(),
      from: day.optional(), to: day.optional(), ...paging }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const q = req.query;
      let base = trx.selectFrom('audit_event as a').leftJoin('app_user as u', 'u.id', 'a.user_id');
      const has = (f: string) => req.auth!.sensitive.has(f);
      // Thực thể bị che theo cờ: nhật ký lưu số trước/sau của chính các bảng này. Hỏi thẳng một thực thể bị che là 403; xem chung thì bỏ các dòng đó.
      const hiddenEntities: { flag: string; entities: readonly string[]; msg: string; code: string }[] = [
        { flag: 'view_salary', entities: SALARY_AUDIT_ENTITIES, msg: 'Không có quyền xem lương', code: 'SALARY_FORBIDDEN' },
        { flag: 'view_cost', entities: COST_AUDIT_ENTITIES, msg: 'Không có quyền xem giá vốn', code: 'FORBIDDEN' },
        { flag: 'view_payable', entities: PAYABLE_AUDIT_ENTITIES, msg: 'Không có quyền xem công nợ phải trả', code: 'FORBIDDEN' },
        { flag: 'view_receivable', entities: RECEIVABLE_AUDIT_ENTITIES, msg: 'Không có quyền xem công nợ phải thu', code: 'FORBIDDEN' },
      ];
      for (const h of hiddenEntities) {
        if (has(h.flag) || !h.entities.length) continue;
        if (q.entity && h.entities.includes(q.entity)) throw new AppError(h.code, h.msg, 403);
        base = base.where('a.entity', 'not in', h.entities as string[]);
      }
      // Sổ công nợ HKD/DNSN (S4a, book_debt) mang số phải thu và phải trả trong cùng bảng: bỏ dòng theo chiều (side) mà người gọi thiếu cờ.
      for (const [flag, side] of [['view_receivable', 'recv'], ['view_payable', 'pay']] as const) {
        if (has(flag)) continue;
        base = base.where(sql<boolean>`NOT (a.entity = 'book_debt' AND coalesce(a.after->>'side', a.before->>'side') = ${side})`);
      }
      // Tài khoản bị che: lương, giá vốn (632, kho), phải thu, phải trả theo cờ người gọi thiếu. Ảnh chụp trước/sau của dòng chứng từ đã ghi sổ (sửa diễn giải, chiều) mang số tiền: bỏ mọi dòng của
      // chứng từ có dòng trên các tài khoản đó (dòng đối ứng bằng đúng số tiền). Dòng số dư đầu kỳ: bỏ dòng thuộc tài khoản đó. Đối trừ (settlement): bỏ khi một trong hai khoản thuộc tài khoản đó.
      // Chứng từ đã bỏ ghi sổ rồi xóa nháp không còn dòng để so: xét thêm TK của chính sự kiện và của các sự kiện dòng khác cùng chứng từ.
      const hidden = await hiddenAccounts(trx, has);
      if (hidden.ids.length) {
        const ids = hidden.ids.map(String);
        base = base.where(sql<boolean>`NOT (
          (a.entity = 'voucher_line' AND (coalesce(a.after, a.before)->>'account_id' = ANY(${ids}::text[])
            OR EXISTS (SELECT 1 FROM voucher_line sl WHERE sl.voucher_id = (coalesce(a.after, a.before)->>'voucher_id')::uuid AND sl.posting_date = (coalesce(a.after, a.before)->>'posting_date')::date
              AND sl.account_id::text = ANY(${ids}::text[]))
            OR EXISTS (SELECT 1 FROM audit_event a2 WHERE a2.entity = 'voucher_line' AND coalesce(a2.after, a2.before)->>'voucher_id' = coalesce(a.after, a.before)->>'voucher_id'
              AND coalesce(a2.after, a2.before)->>'account_id' = ANY(${ids}::text[]))))
          OR (a.entity = 'opening_balance' AND coalesce(a.after->>'account_id', a.before->>'account_id') = ANY(${ids}::text[]))
          OR (a.entity = 'settlement' AND EXISTS (SELECT 1 FROM open_item o WHERE o.account_id::text = ANY(${ids}::text[])
            AND o.id::text IN (coalesce(a.after, a.before)->>'debit_item_id', coalesce(a.after, a.before)->>'credit_item_id')))
          OR (a.entity = 'approval_request' AND coalesce(a.after, a.before)->>'account_code' = ANY(${hidden.codes}::text[])))`);
      }
      // Sổ công nợ S4a của hộ kinh doanh, doanh nghiệp siêu nhỏ (book_debt): cùng một bảng cho cả hai bên nên che theo cột side của dòng trước/sau (sửa đổi bên cũng bị che).
      for (const [side, flag] of [['recv', 'view_receivable'], ['pay', 'view_payable']] as const) {
        if (!has(flag)) base = base.where(sql<boolean>`NOT (a.entity = 'book_debt' AND (coalesce(a.before->>'side', '') = ${side} OR coalesce(a.after->>'side', '') = ${side}))`);
      }
      if (!has('view_salary')) {
        // Tờ khai 05/KK-TNCN, 05/QTT-TNCN lưu bảng kê từng người (tên, MST, thu nhập, thuế) trong values; tax_return còn chứa tờ khai GTGT, TNDN nên chỉ bỏ hai mẫu này.
        base = base.where(sql<boolean>`NOT (a.entity = 'tax_return' AND coalesce(a.after, a.before)->>'form_code' = ANY(${Object.keys(TNCN_FORMS)}::text[]))`);
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
