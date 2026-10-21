import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { z } from 'zod';
import { SENSITIVE_FLAGS_ALL } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { dateIso, type CatalogDef } from '../master/catalogs.js';
import { getRow, listRows, updateRow } from '../master/crud.js';
import { runDataChecks } from './dataCheck.js';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { buildAuthorityPackage, collectAuthorityData } from './exportAuthority.js';
import { buildVoucherTemplate, isKind, runImport, templateFileName, type ImportReport } from './importVouchers.js';

class Rollback extends Error { constructor(public report: ImportReport) { super('rollback'); } } // hoàn tác giao dịch nhưng vẫn trả báo cáo
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Quy tắc soát lỗi dùng lại khung danh mục để liệt kê/sửa nhưng KHÔNG nằm trong CATALOGS: thêm mới, xóa và nhập Excel đều đóng, còn lại do DB quyết định (0014: app_user chỉ UPDATE
// name, severity, message, fix_hint, is_enabled). Cột `code` và `sql` không có trong schema (strict) nên API từ chối kể cả khi quyền DB đã chặn. Sửa/bật tắt cần quyền riêng data_check.manage.
const ruleDef: CatalogDef = { name: 'data_check_rule', table: 'data_check_rule', label: 'Quy tắc soát lỗi', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'], columns: [],
  schema: z.object({ name: z.string().min(1).max(200), severity: z.enum(['error', 'warning']), message: z.string().min(1).max(500), fix_hint: z.string().max(500).nullable().optional(), is_enabled: z.boolean() }).strict() };

const routes: FastifyPluginAsyncZod = async (app) => {
  // Nhập chứng từ thu chi và bảng kê hóa đơn từ Excel (mẫu theo loại). Cả hai chế độ chạy cùng một đường ghi trong một giao dịch: validate luôn hoàn tác, commit chỉ giữ khi không có lỗi.
  const kindParam = z.object({ kind: z.string() });
  const kindOf = (s: string) => { if (!isKind(s)) throw new AppError('IMPORT_KIND_UNKNOWN', 'Loại nhập không hợp lệ (thu-chi, bang-ke-mua, bang-ke-ban)', 404); return s; };
  app.get('/api/import/vouchers/:kind/template.xlsx', { preHandler: app.requirePermission('voucher.import'), schema: { params: kindParam } }, async (req, reply) => {
    const kind = kindOf(req.params.kind);
    reply.header('content-type', XLSX).header('content-disposition', `attachment; filename="${templateFileName(kind)}"`);
    return reply.send(await buildVoucherTemplate(kind));
  });
  app.post('/api/import/vouchers/:kind', { preHandler: app.requirePermission('voucher.import'),
    schema: { params: kindParam, querystring: z.object({ mode: z.enum(['validate', 'commit']).default('validate'), autoPost: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') }) } }, async (req) => {
    const kind = kindOf(req.params.kind); const { mode, autoPost } = req.query; const auth = req.auth!;
    if (autoPost && !auth.permissions.has('voucher.post')) throw new AppError('FORBIDDEN', 'Thiếu quyền voucher.post', 403);
    const file = await req.file(); if (!file) throw new AppError('IMPORT_NO_FILE', 'Thiếu tệp', 400);
    const buf = await file.toBuffer();
    try {
      const report = await app.withOverride(req, async (trx) => {
        const r = await runImport(trx, { tenantId: auth.tenantId!, userId: auth.userId }, kind, buf, autoPost);
        if (mode === 'validate' || r.errorCount) throw new Rollback(r);
        return r;
      });
      if (report.posted) notifyRecompute(app, auth.tenantId!);
      return report;
    } catch (e) {
      if (e instanceof Rollback) return e.report;
      throw e;
    }
  });

  app.post('/api/data-check/run', { preHandler: app.requirePermission('data_check.run'), schema: { body: z.object({ from: dateIso, to: dateIso, codes: z.array(z.string()).optional() }) } },
    async (req) => app.withTenant(req, (trx) => runDataChecks(trx, req.body)));

  // Đường tĩnh /api/catalogs/data_check_rule được find-my-way ưu tiên hơn /api/catalogs/:name của khung danh mục chung.
  const base = '/api/catalogs/data_check_rule';
  const params = z.object({ id: z.string() });
  app.get(base, { preHandler: app.requirePermission('catalog.view'), schema: { querystring: z.object({ q: z.string().optional(), page: z.coerce.number().int().min(1).max(10_000).default(1), size: z.coerce.number().int().min(1).max(1000).default(100) }) } },
    async (req) => app.withTenant(req, (trx) => listRows(trx, ruleDef, req.query)));
  app.get(`${base}/:id`, { preHandler: app.requirePermission('catalog.view'), schema: { params } }, async (req) => app.withTenant(req, (trx) => getRow(trx, ruleDef, req.params.id)));
  app.put(`${base}/:id`, { preHandler: app.requirePermission('data_check.manage'), schema: { params } },
    async (req) => { await app.withTenant(req, (trx) => updateRow(trx, ruleDef, req.params.id, req.body)); return { ok: true }; });
  app.post(base, { preHandler: app.requirePermission('catalog.create') }, async () => {
    throw new AppError('RULE_SQL_SYSTEM_ONLY', 'Quy tắc soát lỗi chỉ do hệ thống cung cấp; chỉ được bật/tắt hoặc sửa thông điệp', 409);
  });
  app.delete(`${base}/:id`, { preHandler: app.requirePermission('catalog.delete'), schema: { params } }, async (req) => {
    await app.withTenant(req, (trx) => getRow(trx, ruleDef, req.params.id)); // id không có (hoặc của công ty khác) vẫn là 404
    throw new AppError('RULE_SYSTEM', 'Không xóa được quy tắc hệ thống, chỉ tắt', 409);
  });

  // Gói xuất gồm Nhật ký chung và Sổ Cái (mọi tài khoản, kể cả công nợ và giá vốn): cần đủ các cờ nhạy cảm như khi in bộ sổ năm (/api/print/book-set).
  // Đọc dữ liệu và ghi dòng audit `export` trong cùng một giao dịch; dựng PDF và nén zip ngoài giao dịch; zip dựng xong mới ghi dòng `export_completed` (kèm băm) ở giao dịch ngắn riêng,
  // ghi không được thì không trả tệp.
  app.post('/api/export/authority', { preHandler: app.requirePermission('export.authority'), schema: { body: z.object({ from: dateIso, to: dateIso }).refine((b) => b.from <= b.to, { message: 'Từ ngày phải trước hoặc bằng đến ngày' }) } }, async (req, reply) => {
    for (const flag of SENSITIVE_FLAGS_ALL) if (!req.auth!.sensitive.has(flag)) throw new AppError('FORBIDDEN', `Xuất dữ liệu cho cơ quan thẩm quyền gồm Nhật ký chung và Sổ Cái, cần cờ nhạy cảm ${flag}`, 403);
    const tenantId = req.auth!.tenantId!;
    const audit = (trx: Transaction<Database>, action: string, after: object) =>
      sql`INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, after, ip) VALUES (${tenantId}::uuid, app_user_id(), ${action}, 'tenant', ${tenantId}, ${JSON.stringify(after)}::jsonb, ${req.ip})`.execute(trx);
    const data = await app.withTenant(req, async (trx) => {
      const d = await collectAuthorityData(trx, tenantId, req.body);
      await audit(trx, 'export', req.body);
      return d;
    }, { isolation: 'repeatable read' }); // đọc nhiều bảng trên một ảnh chụp dữ liệu; vẫn đọc ghi vì ghi dòng audit
    const pkg = await buildAuthorityPackage(data);
    await app.withTenant(req, (trx) => audit(trx, 'export_completed', { ...req.body, manifestSha256: pkg.manifestSha256, zipSha256: pkg.zipSha256 }));
    const name = encodeURIComponent(`xuat-du-lieu-${req.body.from}-${req.body.to}.zip`);
    return reply.type('application/zip').header('content-disposition', `attachment; filename*=UTF-8''${name}`).send(pkg.zip);
  });
};
export default routes;
