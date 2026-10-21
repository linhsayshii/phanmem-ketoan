import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { todayVn } from '@kt/domain';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { assertPrint, isoDate, ordered, orderedMsg, respondReport } from '../reporting/routes.js';
import { listOpenItems } from './openItems.js';
import { agingDoc, arapAging, arapDetail, arapSummary, bucketsParam, DEFAULT_BUCKETS, detailDoc, reminderDoc, statementDoc, summaryDoc } from './reports.js';
import { autoInput, autoSettle, listQuery, listSettlements, settle, settleInput, unsettle } from './settlement.js';

const code = z.string().min(1);

const routes: FastifyPluginAsyncZod = async (app) => {
  // Khoản công nợ theo chứng từ và dư còn lại tại ngày (mặc định hôm nay); onlyOpen mặc định chỉ khoản còn dư.
  app.get('/api/open-items', { preHandler: app.requirePermission('settlement.view'),
    schema: { querystring: z.object({ accountCode: z.string().min(1), partyCode: z.string().min(1).optional(), asOf: isoDate.optional(), onlyOpen: z.enum(['true', 'false']).default('true') }) } }, async (req) =>
    app.withTenant(req, (trx) => listOpenItems(trx, req.auth!, req.auth!.tenantId!, { ...req.query, asOf: req.query.asOf ?? todayVn(), onlyOpen: req.query.onlyOpen === 'true' }), READ_SNAPSHOT));

  // Đối trừ và hủy đối trừ qua app.withOverride: kỳ khóa sổ chỉ khi có quyền ghi lùi (như chứng từ, tỷ giá xuất quỹ); kỳ khóa cứng luôn bị chặn trong SQL.
  app.get('/api/settlements', { preHandler: app.requirePermission('settlement.view'), schema: { querystring: listQuery } }, async (req) =>
    app.withTenant(req, (trx) => listSettlements(trx, req.auth!, req.auth!.tenantId!, { ...req.query, today: todayVn() }), READ_SNAPSHOT));
  app.post('/api/settlements', { preHandler: app.requirePermission('settlement.create'), schema: { body: settleInput } }, async (req, reply) => {
    const out = await app.withOverride(req, (trx) => settle(trx, req.auth!, req.body));
    if (out.fxVoucherId) notifyRecompute(app, req.auth!.tenantId!); // chứng từ CL đã ghi sổ
    return reply.status(201).send(out);
  });
  app.post('/api/settlements/auto', { preHandler: app.requirePermission('settlement.create'), schema: { body: autoInput } }, async (req) => {
    const out = await app.withOverride(req, (trx) => autoSettle(trx, req.auth!, req.body));
    if (out.groups) notifyRecompute(app, req.auth!.tenantId!);
    return out;
  });
  app.delete('/api/settlements/groups/:groupId', { preHandler: app.requirePermission('settlement.delete'), schema: { params: z.object({ groupId: z.string().uuid() }) } }, async (req, reply) => {
    await app.withOverride(req, (trx) => unsettle(trx, req.auth!, req.params.groupId));
    notifyRecompute(app, req.auth!.tenantId!);
    return reply.status(204).send();
  });

  // Báo cáo công nợ: cần report.view; in (html/pdf/xlsx) cần thêm report.print. Cờ view_receivable/view_payable kiểm theo từng tài khoản trước khi đọc số liệu (403).
  // Tài liệu dựng trong giao dịch REPEATABLE READ READ ONLY, PDF/Excel dựng ngoài giao dịch.
  const view = app.requirePermission('report.view');
  const format = z.enum(['json', 'html', 'pdf', 'xlsx']).default('json');

  app.get('/api/reports/arap/detail', { preHandler: view, schema: { querystring: z.object({ accountCode: code, partyCode: code, from: isoDate, to: isoDate, currency: code.optional(), format })
    .refine(ordered, orderedMsg) } }, async (req, reply) => {
    const { format, ...q } = req.query; const auth = req.auth!;
    if (format === 'json') return app.withTenant(req, (trx) => arapDetail(trx, auth, auth.tenantId!, q), READ_SNAPSHOT);
    assertPrint(auth);
    return respondReport(reply, [await app.withTenant(req, (trx) => detailDoc(trx, auth, auth.tenantId!, q), READ_SNAPSHOT)], format, `cong-no-chi-tiet-${q.accountCode}-${q.partyCode}-${q.from}-${q.to}`);
  });

  app.get('/api/reports/arap/summary', { preHandler: view, schema: { querystring: z.object({ accountCode: code, from: isoDate, to: isoDate, format })
    .refine(ordered, orderedMsg) } }, async (req, reply) => {
    const { format, ...q } = req.query; const auth = req.auth!;
    if (format === 'json') return app.withTenant(req, (trx) => arapSummary(trx, auth, auth.tenantId!, q), READ_SNAPSHOT);
    assertPrint(auth);
    return respondReport(reply, [await app.withTenant(req, (trx) => summaryDoc(trx, auth, auth.tenantId!, q), READ_SNAPSHOT)], format, `cong-no-tong-hop-${q.accountCode}-${q.from}-${q.to}`);
  });

  app.get('/api/reports/arap/aging', { preHandler: view, schema: { querystring: z.object({ accountCode: code, partyCode: code.optional(), asOf: isoDate, by: z.enum(['due', 'doc']).default('due'),
    buckets: bucketsParam.optional(), format }) } }, async (req, reply) => {
    const { format, buckets, ...rest } = req.query; const auth = req.auth!; const q = { ...rest, buckets: buckets ?? DEFAULT_BUCKETS };
    if (format === 'json') return app.withTenant(req, (trx) => arapAging(trx, auth, auth.tenantId!, q), READ_SNAPSHOT);
    assertPrint(auth);
    return respondReport(reply, [await app.withTenant(req, (trx) => agingDoc(trx, auth, auth.tenantId!, q), READ_SNAPSHOT)], format, `cong-no-tuoi-no-${q.accountCode}-${q.asOf}`);
  });

  // Biên bản đối chiếu và thư nhắc nợ là mẫu nội bộ (không có số mẫu); luôn là tài liệu in nên luôn cần report.print.
  app.get('/api/reports/arap/statement', { preHandler: view, schema: { querystring: z.object({ accountCode: code, partyCode: code, from: isoDate, to: isoDate, format: z.enum(['pdf', 'xlsx', 'html']).default('pdf') })
    .refine(ordered, orderedMsg) } }, async (req, reply) => {
    const { format, ...q } = req.query; const auth = req.auth!; assertPrint(auth);
    const doc = await app.withTenant(req, (trx) => statementDoc(trx, auth, auth.tenantId!, q), READ_SNAPSHOT);
    return respondReport(reply, [doc], format, `bien-ban-doi-chieu-${q.accountCode}-${q.partyCode}-${q.to}`);
  });

  app.get('/api/reports/arap/reminder', { preHandler: view, schema: { querystring: z.object({ accountCode: code, partyCode: code, asOf: isoDate, format: z.enum(['pdf', 'html']).default('pdf') }) } }, async (req, reply) => {
    const { format, ...q } = req.query; const auth = req.auth!; assertPrint(auth);
    const doc = await app.withTenant(req, (trx) => reminderDoc(trx, auth, auth.tenantId!, q), READ_SNAPSHOT);
    return respondReport(reply, [doc], format, `thu-nhac-no-${q.partyCode}-${q.asOf}`);
  });
};
export default routes;
