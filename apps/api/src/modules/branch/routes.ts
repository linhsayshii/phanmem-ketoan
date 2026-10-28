import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { READ_SNAPSHOT, type Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { isoDate, ordered, orderedMsg } from '../reporting/routes.js';
import { consolidatedReport, internalPrefixes } from './consolidated.js';
import { HEAD_OFFICE, WORKING_BRANCH_PREF } from './scope.js';

type Trx = Transaction<Database>;
// Đơn vị: 'HO' (trụ sở chính) hoặc id chi nhánh.
const unitRef = z.union([z.literal('HO'), z.number().int().positive()]);
const toId = (u: 'HO' | number) => (u === 'HO' ? HEAD_OFFICE : u);
const toRef = (id: number) => (id === HEAD_OFFICE ? 'HO' as const : id);
const branchBody = z.object({ code: z.string().trim().min(1).max(50), name: z.string().trim().min(1).max(500), taxCode: z.string().trim().regex(/^\d{10}(-\d{3})?$/, 'MST gồm 10 chữ số hoặc 10 chữ số, dấu gạch, 3 chữ số').nullable().default(null),
  parentCode: z.string().trim().min(1).nullable().default(null), isActive: z.boolean().default(true) });

async function assertBranch(trx: Trx, id: number) {
  if (id === HEAD_OFFICE) return;
  const r = await sql<{ id: number }>`SELECT id FROM department WHERE id = ${id} AND is_branch`.execute(trx);
  if (!r.rows[0]) throw new AppError('BRANCH_NOT_FOUND', `Không có chi nhánh ${id}`, 404);
}
// Bật đánh số theo chi nhánh: mã chi nhánh nằm trong số chứng từ nên không được trùng mã trụ sở chính (GĐ7 gói 3).
async function assertCodeNotHq(trx: Trx, code: string) {
  const r = await sql<{ hq_code: string }>`SELECT hq_code FROM voucher_numbering_setting WHERE per_branch AND hq_code = ${code}`.execute(trx);
  if (r.rows[0]) throw new AppError('NUMBERING_CODE_CONFLICT', `Mã ${code} trùng mã trụ sở chính trong cấu hình đánh số theo chi nhánh`, 409);
}
async function parentId(trx: Trx, code: string | null): Promise<number | null> {
  if (!code) return null;
  const r = await trx.selectFrom('department').select('id').where('code', '=', code).executeTakeFirst();
  if (!r) throw new AppError('DEPARTMENT_NOT_FOUND', `Không có đơn vị cấp trên ${code}`, 404);
  return r.id;
}
const listBranches = (trx: Trx) => sql<{ id: number; code: string; name: string; taxCode: string | null; parentCode: string | null; isActive: boolean }>`
  SELECT d.id, d.code, d.name, d.tax_code AS "taxCode", p.code AS "parentCode", d.is_active AS "isActive"
  FROM department d LEFT JOIN department p ON p.id = d.parent_id WHERE d.is_branch ORDER BY d.code`.execute(trx);

const routes: FastifyPluginAsyncZod = async (app) => {
  // Danh mục chi nhánh (bộ phận là chi nhánh): quyền danh mục; inScope cho biết người dùng có xem được chứng từ của đơn vị đó không.
  app.get('/api/branches', { preHandler: app.requirePermission('catalog.view') }, async (req) => app.withTenant(req, async (trx) => {
    const scope = req.auth!.branchScope ?? null; const inScope = (id: number) => scope === null || scope.includes(id);
    return { headOffice: { inScope: inScope(HEAD_OFFICE) }, rows: (await listBranches(trx)).rows.map((b) => ({ ...b, inScope: inScope(b.id) })) };
  }));
  app.post('/api/branches', { preHandler: app.requirePermission('catalog.create'), schema: { body: branchBody } }, async (req, reply) => {
    const b = req.body;
    const r = await app.withTenant(req, async (trx) => { await assertCodeNotHq(trx, b.code); return sql<{ id: number }>`INSERT INTO department (tenant_id, code, name, tax_code, parent_id, is_branch, is_active)
      VALUES (${req.auth!.tenantId!}::uuid, ${b.code}, ${b.name}, ${b.taxCode}, ${await parentId(trx, b.parentCode)}, true, ${b.isActive}) RETURNING id`.execute(trx); });
    return reply.status(201).send({ id: r.rows[0]!.id });
  });
  app.put('/api/branches/:id', { preHandler: app.requirePermission('catalog.update'), schema: { params: z.object({ id: z.coerce.number().int().positive() }), body: branchBody } }, async (req) =>
    app.withTenant(req, async (trx) => {
      await assertBranch(trx, req.params.id);
      const b = req.body; await assertCodeNotHq(trx, b.code); const parent = await parentId(trx, b.parentCode);
      if (parent === req.params.id) throw new AppError('VALIDATION', 'Đơn vị cấp trên không được là chính chi nhánh', 400);
      await sql`UPDATE department SET code = ${b.code}, name = ${b.name}, tax_code = ${b.taxCode}, parent_id = ${parent}, is_active = ${b.isActive} WHERE id = ${req.params.id}`.execute(trx);
      return { ok: true };
    }));

  // Phạm vi chi nhánh của người dùng: danh sách rỗng = toàn công ty.
  const userParam = z.object({ userId: z.string().uuid() });
  const assertMember = async (trx: Trx, userId: string) => {
    if (!await trx.selectFrom('tenant_user').select('user_id').where('user_id', '=', userId).where('tenant_id', '=', sql<string>`app_tenant()`).executeTakeFirst())
      throw new AppError('USER_NOT_FOUND', 'Không có người dùng trong công ty', 404);
  };
  app.get('/api/users/:userId/branch-scope', { preHandler: app.requirePermission('user.view'), schema: { params: userParam } }, async (req) => app.withTenant(req, async (trx) => {
    await assertMember(trx, req.params.userId);
    const rows = await trx.selectFrom('user_branch_scope').select('branch_id').where('user_id', '=', req.params.userId).execute();
    return { branches: rows.map((r) => toRef(r.branch_id ?? HEAD_OFFICE)) };
  }));
  app.put('/api/users/:userId/branch-scope', { preHandler: app.requirePermission('user.update'), schema: { params: userParam, body: z.object({ branches: z.array(unitRef).max(500) }) } }, async (req) => {
    // Tự giới hạn mình làm mất quyền quản lý người dùng (không còn trong danh sách quyền khi bị giới hạn) và không tự gỡ được.
    if (req.params.userId === req.auth!.userId) throw new AppError('BRANCH_SCOPE_SELF', 'Không tự đặt phạm vi chi nhánh cho chính mình', 409);
    await app.withTenant(req, async (trx) => {
      await assertMember(trx, req.params.userId);
      const ids = [...new Set(req.body.branches.map(toId))];
      for (const id of ids) await assertBranch(trx, id);
      await trx.deleteFrom('user_branch_scope').where('user_id', '=', req.params.userId).execute();
      if (ids.length) await trx.insertInto('user_branch_scope').values(ids.map((id) => ({ tenant_id: req.auth!.tenantId!, user_id: req.params.userId, branch_id: id === HEAD_OFFICE ? null : id }))).execute();
    });
    return { ok: true };
  });

  // Chi nhánh làm việc của chính mình: chứng từ mới lập ở mọi phân hệ gắn chi nhánh này (voucher.branch_id mặc định).
  app.get('/api/me/branch', { preHandler: app.requireAuth }, async (req) =>
    ({ scope: req.auth!.branchScope ? req.auth!.branchScope.map(toRef) : null, working: toRef(req.auth!.branchWorking ?? HEAD_OFFICE) }));
  app.put('/api/me/branch', { preHandler: app.requireAuth, schema: { body: z.object({ branch: unitRef }) } }, async (req) => {
    const id = toId(req.body.branch); const scope = req.auth!.branchScope ?? null;
    if (scope !== null && !scope.includes(id)) throw new AppError('BRANCH_FORBIDDEN', 'Chi nhánh ngoài phạm vi được phân quyền', 403);
    await app.withTenant(req, async (trx) => {
      await assertBranch(trx, id);
      await trx.insertInto('user_pref').values({ user_id: req.auth!.userId, tenant_id: req.auth!.tenantId!, key: WORKING_BRANCH_PREF, value: JSON.stringify(id) })
        .onConflict((oc) => oc.columns(['user_id', 'tenant_id', 'key']).doUpdateSet({ value: JSON.stringify(id) })).execute();
    });
    return { ok: true };
  });

  // Chi nhánh của chứng từ: xem; đổi khi còn nháp (chứng từ đã ghi sổ chặn ở trg_voucher_before: bỏ ghi sổ rồi đổi). RLS chặn chứng từ và chi nhánh ngoài phạm vi.
  const vParam = z.object({ id: z.string().uuid() });
  const voucherBranch = async (trx: Trx, id: string) => {
    const r = await sql<{ branch_id: number | null; state: string }>`SELECT branch_id, state FROM voucher WHERE id = ${id}::uuid`.execute(trx);
    if (!r.rows[0]) throw new AppError('VOUCHER_NOT_FOUND', 'Không có chứng từ', 404);
    return r.rows[0];
  };
  app.get('/api/vouchers/:id/branch', { preHandler: app.requirePermission('voucher.view'), schema: { params: vParam } }, async (req) =>
    app.withTenant(req, async (trx) => ({ branch: toRef((await voucherBranch(trx, req.params.id)).branch_id ?? HEAD_OFFICE) })));
  app.put('/api/vouchers/:id/branch', { preHandler: app.requirePermission('voucher.update'), schema: { params: vParam, body: z.object({ branch: unitRef }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const v = await voucherBranch(trx, req.params.id);
      if (v.state !== 'draft') throw new AppError('VOUCHER_IMMUTABLE', 'Chỉ đổi chi nhánh của chứng từ nháp; chứng từ đã ghi sổ hãy bỏ ghi sổ trước', 409);
      const id = toId(req.body.branch); await assertBranch(trx, id);
      await sql`UPDATE voucher SET branch_id = ${id === HEAD_OFFICE ? null : id} WHERE id = ${req.params.id}::uuid`.execute(trx);
      return { branch: req.body.branch };
    }));

  // Cấu hình BCTC tổng hợp: tiền tố tài khoản nội bộ loại trừ khi cộng các đơn vị.
  app.get('/api/branch-consolidation/settings', { preHandler: app.requirePermission('report.view') }, async (req) =>
    app.withTenant(req, async (trx) => ({ internalPrefixes: await internalPrefixes(trx) })));
  app.put('/api/branch-consolidation/settings', { preHandler: app.requirePermission('setting.update'), schema: { body: z.object({ internalPrefixes: z.array(z.string().regex(/^\d{1,10}$/)).max(50) }) } }, async (req) => {
    const v = [...new Set(req.body.internalPrefixes)];
    await app.withTenant(req, (trx) => trx.insertInto('branch_consolidation_setting').values({ tenant_id: req.auth!.tenantId!, internal_prefixes: v })
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ internal_prefixes: v, updated_at: new Date().toISOString() })).execute());
    return { ok: true };
  });

  // BCTC tổng hợp các chi nhánh trong phạm vi người dùng (B01, B02).
  app.get('/api/reports/consolidated/:code', { preHandler: app.requirePermission('report.view'), schema: { params: z.object({ code: z.enum(['B01', 'B02']) }), querystring: z.object({ from: isoDate, to: isoDate }).refine(ordered, orderedMsg) } }, async (req) =>
    app.withTenant(req, (trx) => consolidatedReport(trx, req.auth!.tenantId!, req.auth!.branchScope ?? null, { reportCode: req.params.code, ...req.query }), READ_SNAPSHOT));
};
export default routes;
