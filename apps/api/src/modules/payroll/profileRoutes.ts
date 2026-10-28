import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { MAX_ERRORS } from '../master/importExcel.js';
import { buildProfileTemplate, importProfiles, parseProfileWorkbook } from './profileImport.js';
import { addAllowance, addDependent, addSalary, allowanceInput, costSplitInput, deleteAllowance, deleteDependent, deleteSalary, dependentInput, getProfile, listProfiles, profileInput, salaryInput,
  saveCostSplit, saveProfile, updateAllowance, updateDependent } from './profiles.js';

class DryRun extends Error {} // chỉ để hoàn tác giao dịch sau khi kiểm tra thử

// Hồ sơ lương là dữ liệu nhạy cảm: mọi route cần quyền payroll.* VÀ cờ view_salary (thiếu cờ là 403 ở API, không chỉ ẩn ở giao diện).
const routes: FastifyPluginAsyncZod = async (app) => {
  const guard = (perm: 'payroll.view' | 'payroll.update') => async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requirePermission(perm)(req, reply);
    if (!req.auth!.sensitive.has('view_salary')) throw new AppError('SALARY_FORBIDDEN', 'Không có quyền xem lương', 403);
  };
  const view = { preHandler: guard('payroll.view') }, edit = { preHandler: guard('payroll.update') };
  const eid = z.object({ employeeId: z.coerce.number().int().positive() });
  const sub = z.object({ employeeId: z.coerce.number().int().positive(), id: z.coerce.number().int().positive() });
  const P = '/api/payroll/profiles';

  app.get(P, { ...view, schema: { querystring: z.object({ q: z.string().optional(), active: z.enum(['true', 'false', 'all']).default('true'), size: z.coerce.number().int().min(1).max(2000).default(500) }) } }, async (req) =>
    app.withTenant(req, (trx) => listProfiles(trx, req.query), READ_SNAPSHOT));

  // Nhập hàng loạt (đặt trước :employeeId để đường tĩnh không bị nuốt).
  app.get(`${P}/import/template.xlsx`, view, async (_req, reply) => {
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', 'attachment; filename="mau_ho_so_luong.xlsx"');
    return reply.send(await buildProfileTemplate());
  });
  app.post(`${P}/import`, { ...edit, schema: { querystring: z.object({ mode: z.enum(['validate', 'commit']).default('validate') }) } }, async (req) => {
    const file = await req.file(); if (!file) throw new AppError('IMPORT_NO_FILE', 'Thiếu tệp', 400);
    const parsed = await parseProfileWorkbook(await file.toBuffer());
    const errors = [...parsed.errors];
    const total = parsed.profiles.length + parsed.allowances.length + parsed.dependents.length + new Set(errors.map((e) => e.row)).size;
    const dry = req.query.mode === 'validate';
    const report = (c = { profiles: 0, allowances: 0, dependents: 0 }) => ({ total, inserted: c.profiles, allowances: c.allowances, dependents: c.dependents, errors: [...errors].sort((a, b) => a.row - b.row).slice(0, MAX_ERRORS), errorCount: errors.length });
    // Cả hai chế độ chạy cùng đường ghi trong giao dịch; kiểm tra thử ném DryRun để hoàn tác nên báo đúng các lỗi như khi nhập thật.
    try {
      const counts = await app.withTenant(req, async (trx) => { const c = await importProfiles(trx, req.auth!.tenantId!, parsed, errors); if (dry) throw new DryRun(); return c; });
      return report(counts);
    } catch (e) {
      if (dry && (e instanceof DryRun || (e instanceof AppError && e.code === 'IMPORT_ERRORS'))) return report();
      throw e;
    }
  });

  app.get(`${P}/:employeeId`, { ...view, schema: { params: eid } }, async (req) => app.withTenant(req, (trx) => getProfile(trx, req.params.employeeId), READ_SNAPSHOT));
  app.put(`${P}/:employeeId`, { ...edit, schema: { params: eid, body: profileInput } }, async (req) =>
    app.withTenant(req, (trx) => saveProfile(trx, req.auth!.tenantId!, req.params.employeeId, req.body)));

  app.post(`${P}/:employeeId/allowances`, { ...edit, schema: { params: eid, body: allowanceInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => addAllowance(trx, req.auth!.tenantId!, req.params.employeeId, req.body))));
  app.put(`${P}/:employeeId/allowances/:id`, { ...edit, schema: { params: sub, body: allowanceInput } }, async (req) =>
    app.withTenant(req, (trx) => updateAllowance(trx, req.params.employeeId, req.params.id, req.body)));
  app.delete(`${P}/:employeeId/allowances/:id`, { ...edit, schema: { params: sub } }, async (req, reply) => {
    await app.withTenant(req, (trx) => deleteAllowance(trx, req.params.employeeId, req.params.id)); return reply.status(204).send();
  });

  app.post(`${P}/:employeeId/dependents`, { ...edit, schema: { params: eid, body: dependentInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => addDependent(trx, req.auth!.tenantId!, req.params.employeeId, req.body))));
  app.put(`${P}/:employeeId/dependents/:id`, { ...edit, schema: { params: sub, body: dependentInput } }, async (req) =>
    app.withTenant(req, (trx) => updateDependent(trx, req.auth!.tenantId!, req.params.employeeId, req.params.id, req.body)));
  app.delete(`${P}/:employeeId/dependents/:id`, { ...edit, schema: { params: sub } }, async (req, reply) => {
    await app.withTenant(req, (trx) => deleteDependent(trx, req.params.employeeId, req.params.id)); return reply.status(204).send();
  });

  app.post(`${P}/:employeeId/salary-history`, { ...edit, schema: { params: eid, body: salaryInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => addSalary(trx, req.auth!.tenantId!, req.params.employeeId, req.body))));
  app.delete(`${P}/:employeeId/salary-history/:id`, { ...edit, schema: { params: sub } }, async (req, reply) => {
    await app.withTenant(req, (trx) => deleteSalary(trx, req.params.employeeId, req.params.id)); return reply.status(204).send();
  });

  app.put(`${P}/:employeeId/cost-split`, { ...edit, schema: { params: eid, body: costSplitInput } }, async (req) =>
    app.withTenant(req, (trx) => saveCostSplit(trx, req.auth!.tenantId!, req.params.employeeId, req.body)));
};
export default routes;
