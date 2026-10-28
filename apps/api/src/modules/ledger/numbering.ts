import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { formatVoucherNo } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { effectiveBranch } from '../branch/scope.js';

const notFound = (code: string) => new AppError('VOUCHER_TYPE_NOT_FOUND', `Không có loại chứng từ ${code}`, 404);
const typeBody = z.object({ name: z.string().min(1).optional(), prefix: z.string().max(20).optional(), suffix: z.string().max(20).optional(),
  padLength: z.number().int().min(1).max(10).optional(), isActive: z.boolean().optional() }).refine((b) => Object.keys(b).length > 0, 'Không có trường nào để cập nhật');

const routes: FastifyPluginAsyncZod = async (app) => {
  app.put('/api/voucher-types/:code', { preHandler: app.requirePermission('setting.update'), schema: { params: z.object({ code: z.string() }), body: typeBody } }, async (req) => {
    const b = req.body;
    const r = await app.withTenant(req, (trx) => trx.updateTable('voucher_type').set({ ...(b.name !== undefined ? { name: b.name } : {}), ...(b.prefix !== undefined ? { prefix: b.prefix } : {}),
      ...(b.suffix !== undefined ? { suffix: b.suffix } : {}), ...(b.padLength !== undefined ? { pad_length: b.padLength } : {}), ...(b.isActive !== undefined ? { is_active: b.isActive } : {}) }).where('code', '=', req.params.code).executeTakeFirst());
    if (r.numUpdatedRows === 0n) throw notFound(req.params.code);
    return { ok: true };
  });
  // branch (HO hoặc id chi nhánh) chỉ có nghĩa khi công ty bật đánh số theo chi nhánh; bỏ trống = chi nhánh làm việc của người dùng.
  app.get('/api/voucher-types/:code/next-no', { preHandler: app.requirePermission('voucher.view'), schema: { params: z.object({ code: z.string() }), querystring: z.object({ year: z.coerce.number().int(), branch: z.string().regex(/^(HO|\d+)$/).optional() }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const vt = await trx.selectFrom('voucher_type').selectAll().where('code', '=', req.params.code).executeTakeFirst();
      if (!vt) throw notFound(req.params.code);
      if (req.query.branch !== undefined) effectiveBranch(req.auth!, req.query.branch); // ngoài phạm vi chi nhánh của người dùng: 403
      const b = req.query.branch === undefined ? (req.auth!.branchWorking ?? 0) : req.query.branch === 'HO' ? 0 : Number(req.query.branch);
      const sc = (await sql<{ branch_key: string; branch_code: string | null }>`SELECT branch_key, branch_code FROM fn_voucher_number_scope(${req.auth!.tenantId!}::uuid, ${b === 0 ? null : b}::bigint)`.execute(trx)).rows[0]!;
      const c = await trx.selectFrom('voucher_counter').select('last_no').where('voucher_type', '=', vt.code).where('fiscal_year', '=', req.query.year).where('branch_key', '=', Number(sc.branch_key)).executeTakeFirst();
      return { preview: formatVoucherNo({ prefix: vt.prefix, suffix: vt.suffix, padLength: vt.pad_length, seq: Number(c?.last_no ?? 0) + 1, year: req.query.year, branchCode: sc.branch_code }) };
    }));
  // Cấu hình đánh số theo chi nhánh của công ty (mặc định tắt). Bật rồi tắt không đổi số đã cấp; đánh lại số (voucher.renumber) áp theo cấu hình hiện tại.
  app.get('/api/voucher-numbering/settings', { preHandler: app.requirePermission('voucher.view') }, async (req) =>
    app.withTenant(req, async (trx) => {
      const s = await trx.selectFrom('voucher_numbering_setting').select(['per_branch', 'hq_code']).executeTakeFirst();
      return { perBranch: s?.per_branch ?? false, hqCode: s?.hq_code ?? 'TSC' };
    }));
  app.put('/api/voucher-numbering/settings', { preHandler: app.requirePermission('setting.update'), schema: { body: z.object({ perBranch: z.boolean(), hqCode: z.string().regex(/^[A-Za-z0-9._/]{0,20}$/, 'Mã trụ sở chính chỉ gồm chữ, số, . _ / (tối đa 20 ký tự)').default('TSC') }) } }, async (req) => {
    const { perBranch, hqCode } = req.body;
    await app.withTenant(req, async (trx) => {
      if (perBranch) {
        // Số phải khác nhau giữa các đơn vị: mã trụ sở chính không được trùng mã chi nhánh nào, và chi nhánh phải có mã khác nhau (department.code đã UNIQUE).
        const dup = await trx.selectFrom('department').select('code').where('is_branch', '=', true).where('code', '=', hqCode).executeTakeFirst();
        if (dup) throw new AppError('NUMBERING_CODE_CONFLICT', `Mã trụ sở chính ${hqCode} trùng mã chi nhánh ${dup.code}`, 409);
      }
      await trx.insertInto('voucher_numbering_setting').values({ tenant_id: req.auth!.tenantId!, per_branch: perBranch, hq_code: hqCode })
        .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ per_branch: perBranch, hq_code: hqCode, updated_at: new Date().toISOString() })).execute();
    });
    return { perBranch, hqCode };
  });
  app.post('/api/vouchers/renumber', { preHandler: app.requirePermission('voucher.renumber'), schema: { body: z.object({ voucherType: z.string(), fiscalYear: z.number().int() }) } }, async (req) =>
    app.withTenant(req, async (trx) => ({ count: (await sql<{ n: number }>`SELECT renumber_vouchers(${req.auth!.tenantId!}::uuid, ${req.body.voucherType}, ${req.body.fiscalYear}) AS n`.execute(trx)).rows[0]!.n })));
  // year bỏ trống: so với mọi năm; có year: chỉ năm tài chính đó (số bắt đầu lại mỗi năm nên cùng số có thể có ở năm khác).
  app.get('/api/vouchers/check-no', { preHandler: app.requirePermission('voucher.view'), schema: { querystring: z.object({ type: z.string(), no: z.string(), year: z.coerce.number().int().optional() }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const v = await trx.selectFrom('voucher').select('id').where('voucher_type', '=', req.query.type).where('voucher_no', '=', req.query.no)
        .$if(req.query.year !== undefined, (q) => q.where('fiscal_year', '=', req.query.year!)).executeTakeFirst();
      return { exists: !!v, voucherId: v?.id };
    }));
};
export default routes;
