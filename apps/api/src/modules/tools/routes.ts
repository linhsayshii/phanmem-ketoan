import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../plugins/errors.js';
import { dateIso, type CatalogDef } from '../master/catalogs.js';
import { getRow, listRows, updateRow } from '../master/crud.js';
import { runDataChecks } from './dataCheck.js';

// Quy tắc soát lỗi dùng lại khung danh mục để liệt kê/sửa nhưng KHÔNG nằm trong CATALOGS: thêm mới, xóa và nhập Excel đều đóng, còn lại do DB quyết định (0014: app_user chỉ UPDATE
// name, severity, message, fix_hint, is_enabled). Cột `code` và `sql` không có trong schema (strict) nên API từ chối kể cả khi quyền DB đã chặn.
const ruleDef: CatalogDef = { name: 'data_check_rule', table: 'data_check_rule', label: 'Quy tắc soát lỗi', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'], columns: [],
  schema: z.object({ name: z.string().min(1), severity: z.enum(['error', 'warning']), message: z.string().min(1), fix_hint: z.string().nullable().optional(), is_enabled: z.boolean() }).strict() };

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post('/api/data-check/run', { preHandler: app.requirePermission('data_check.run'), schema: { body: z.object({ from: dateIso, to: dateIso, codes: z.array(z.string()).optional() }) } },
    async (req) => app.withTenant(req, (trx) => runDataChecks(trx, req.body)));

  // Đường tĩnh /api/catalogs/data_check_rule được find-my-way ưu tiên hơn /api/catalogs/:name của khung danh mục chung.
  const base = '/api/catalogs/data_check_rule';
  const params = z.object({ id: z.string() });
  app.get(base, { preHandler: app.requirePermission('catalog.view'), schema: { querystring: z.object({ q: z.string().optional(), page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(1000).default(100) }) } },
    async (req) => app.withTenant(req, (trx) => listRows(trx, ruleDef, req.query)));
  app.get(`${base}/:id`, { preHandler: app.requirePermission('catalog.view'), schema: { params } }, async (req) => app.withTenant(req, (trx) => getRow(trx, ruleDef, req.params.id)));
  app.put(`${base}/:id`, { preHandler: app.requirePermission('catalog.update'), schema: { params } },
    async (req) => { await app.withTenant(req, (trx) => updateRow(trx, ruleDef, req.params.id, req.body)); return { ok: true }; });
  app.post(base, { preHandler: app.requirePermission('catalog.create') }, async () => {
    throw new AppError('RULE_SQL_SYSTEM_ONLY', 'Quy tắc soát lỗi chỉ do hệ thống cung cấp; chỉ được bật/tắt hoặc sửa thông điệp', 409);
  });
  app.delete(`${base}/:id`, { preHandler: app.requirePermission('catalog.delete'), schema: { params } }, async (req) => {
    await app.withTenant(req, (trx) => getRow(trx, ruleDef, req.params.id)); // id không có (hoặc của công ty khác) vẫn là 404
    throw new AppError('RULE_SYSTEM', 'Không xóa được quy tắc hệ thống, chỉ tắt', 409);
  });
};
export default routes;
