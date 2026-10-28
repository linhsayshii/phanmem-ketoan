import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { cellsBody, copyPrevious, getGrid, monthQuery, saveCells, summary } from './attendance.js';
import { buildAttendanceTemplate, importAttendance } from './attendanceImport.js';

// Chấm công không phải dữ liệu tiền lương: chỉ cần quyền attendance.* (không cần view_salary).
const routes: FastifyPluginAsyncZod = async (app) => {
  const view = { preHandler: app.requirePermission('attendance.view') }, edit = { preHandler: app.requirePermission('attendance.update') };
  const A = '/api/attendance';

  app.get(A, { ...view, schema: { querystring: monthQuery } }, async (req) => app.withTenant(req, (trx) => getGrid(trx, req.auth!.tenantId!, req.query), READ_SNAPSHOT));
  app.put(A, { ...edit, schema: { querystring: monthQuery, body: cellsBody } }, async (req) => app.withTenant(req, (trx) => saveCells(trx, req.auth!.tenantId!, req.query, req.body.cells)));
  app.post(`${A}/copy-previous`, { ...edit, schema: { querystring: monthQuery } }, async (req) => app.withTenant(req, (trx) => copyPrevious(trx, req.auth!.tenantId!, req.query)));
  app.get(`${A}/summary`, { ...view, schema: { querystring: monthQuery.pick({ year: true, month: true }) } }, async (req) =>
    app.withTenant(req, (trx) => summary(trx, req.auth!.tenantId!, req.query.year, req.query.month), READ_SNAPSHOT));

  app.get(`${A}/import/template.xlsx`, view, async (_req, reply) => {
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', 'attachment; filename="mau_cham_cong.xlsx"');
    return reply.send(await buildAttendanceTemplate());
  });
  app.post(`${A}/import`, { ...edit, schema: { querystring: monthQuery.extend({ mode: z.enum(['validate', 'commit']).default('validate') }) } }, async (req) => {
    const file = await req.file(); if (!file) throw new AppError('IMPORT_NO_FILE', 'Thiếu tệp', 400);
    const buf = await file.toBuffer();
    return app.withTenant(req, (trx) => importAttendance(trx, req.auth!.tenantId!, req.query, buf, req.query.mode));
  });
};
export default routes;
