import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { bookRegimeOf, loadBookSet, type BookRegime } from '@kt/coa-data';
import { AppError } from '../../plugins/errors.js';
import { assertPrint, isoDate, ordered, orderedMsg, respondReport } from '../reporting/routes.js';
import { buildBook, catalog } from './books.js';
import { createEntry, createGroup, createItem, createMove, createOtherTax, deleteEntry, deleteMove, deleteOtherTax, entryInput, getSetting, groupInput, itemInput, listEntries, listGroups, listItems, listMoves, listOtherTax, moveInput, otherTaxInput, putSetting, settingInput, updateEntry, updateGroup, yearOf } from './service.js';

const id = z.object({ id: z.coerce.number().int().positive() });
const year = z.coerce.number().int().min(2000).max(2100);
const range = { from: isoDate, to: isoDate };
const format = z.enum(['json', 'html', 'pdf', 'xlsx']).default('json');

// Sổ hộ kinh doanh (TT 152/2025) và doanh nghiệp siêu nhỏ (TT 58/2026): ghi sổ đơn, không qua sổ cái bút toán kép (quyết định 1500).
const routes: FastifyPluginAsyncZod = async (app) => {
  const view = app.requirePermission('sohkd.view');
  const ctx = (req: { auth: { tenantId: string | null; userId: string } | null }) => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId });

  // Danh mục sổ theo chế độ của năm (TT152 hoặc TT58) và phương pháp nộp thuế đã chọn.
  app.get('/api/hkd/books', { preHandler: view, schema: { querystring: z.object({ year: year.optional(), regime: z.enum(['TT152', 'TT58']).optional() }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      let regime = req.query.regime as BookRegime | undefined; let fy = req.query.year;
      if (!regime || fy === undefined) {
        const p = await trx.selectFrom('fiscal_period').select(['regime', 'fiscal_year']).where('period_no', '>', 0).where('regime', 'in', ['TT152', 'TT58']).$call((q) => (fy === undefined ? q : q.where('fiscal_year', '=', fy))).$call((q) => (regime ? q.where('regime', '=', regime) : q)).orderBy('fiscal_year', 'desc').executeTakeFirst();
        if (!p) throw new AppError('FISCAL_YEAR_NOT_FOUND', 'Chưa mở năm tài chính theo TT 152/2025 hoặc TT 58/2026', 404);
        regime = p.regime as BookRegime; fy = p.fiscal_year;
      }
      return catalog(trx, regime, fy!);
    }, READ_SNAPSHOT));

  // In hoặc xem một sổ. Sổ kho trả nhiều tài liệu (mỗi mặt hàng một sổ).
  app.get('/api/hkd/books/:code', { preHandler: view, schema: { params: z.object({ code: z.string().min(1).max(20) }), querystring: z.object({ ...range, itemId: z.coerce.number().int().positive().optional(), format }).refine(ordered, orderedMsg) } }, async (req, reply) => {
    const regime = bookRegimeOf(req.params.code);
    if (!regime || !(loadBookSet(regime).books.some((b) => b.code === req.params.code) || loadBookSet(regime).reports.some((r) => r.code === req.params.code))) throw new AppError('BOOK_NOT_FOUND', `Không có sổ ${req.params.code}`, 404);
    if (req.query.format !== 'json') assertPrint(req.auth!);
    const docs = await app.withTenant(req, (trx) => buildBook(trx, req.auth!.tenantId!, req.params.code, req.query), READ_SNAPSHOT);
    if (req.query.format === 'json') return { docs };
    return respondReport(reply, docs, req.query.format, `${req.params.code}-${req.query.from}-${req.query.to}`);
  });

  app.get('/api/hkd/groups', { preHandler: view }, async (req) => app.withTenant(req, (trx) => listGroups(trx), READ_SNAPSHOT));
  app.post('/api/hkd/groups', { preHandler: app.requirePermission('sohkd.config'), schema: { body: groupInput } }, async (req, reply) => reply.status(201).send(await app.withTenant(req, (trx) => createGroup(trx, req.auth!.tenantId!, req.body))));
  app.put('/api/hkd/groups/:id', { preHandler: app.requirePermission('sohkd.config'), schema: { params: id, body: groupInput } }, async (req) => app.withTenant(req, (trx) => updateGroup(trx, req.params.id, req.body)));

  app.get('/api/hkd/settings/:year', { preHandler: view, schema: { params: z.object({ year }) } }, async (req) => app.withTenant(req, (trx) => getSetting(trx, req.params.year), READ_SNAPSHOT));
  app.put('/api/hkd/settings/:year', { preHandler: app.requirePermission('sohkd.config'), schema: { params: z.object({ year }), body: settingInput } }, async (req) => app.withTenant(req, (trx) => putSetting(trx, req.auth!.tenantId!, req.params.year, req.body)));
  app.get('/api/hkd/year-of', { preHandler: view, schema: { querystring: z.object({ date: isoDate }) } }, async (req) => ({ fiscalYear: await app.withTenant(req, (trx) => yearOf(trx, req.query.date), READ_SNAPSHOT) }));

  app.get('/api/hkd/entries', { preHandler: view, schema: { querystring: z.object({ ...range, kind: z.string().optional() }).refine(ordered, orderedMsg) } }, async (req) => app.withTenant(req, (trx) => listEntries(trx, req.query), READ_SNAPSHOT));
  app.post('/api/hkd/entries', { preHandler: app.requirePermission('sohkd.create'), schema: { body: entryInput } }, async (req, reply) => { const c = ctx(req); return reply.status(201).send(await app.withTenant(req, (trx) => createEntry(trx, c.tenantId, c.userId, req.body))); });
  app.put('/api/hkd/entries/:id', { preHandler: app.requirePermission('sohkd.update'), schema: { params: id, body: entryInput } }, async (req) => app.withTenant(req, (trx) => updateEntry(trx, req.params.id, req.body)));
  app.delete('/api/hkd/entries/:id', { preHandler: app.requirePermission('sohkd.delete'), schema: { params: id } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteEntry(trx, req.params.id)); return reply.status(204).send(); });

  app.get('/api/hkd/stock-items', { preHandler: view }, async (req) => app.withTenant(req, (trx) => listItems(trx), READ_SNAPSHOT));
  app.post('/api/hkd/stock-items', { preHandler: app.requirePermission('sohkd.create'), schema: { body: itemInput } }, async (req, reply) => reply.status(201).send(await app.withTenant(req, (trx) => createItem(trx, req.auth!.tenantId!, req.body))));
  app.get('/api/hkd/stock-moves', { preHandler: view, schema: { querystring: z.object({ itemId: z.coerce.number().int().positive().optional(), from: isoDate.optional(), to: isoDate.optional() }) } }, async (req) => app.withTenant(req, (trx) => listMoves(trx, req.query), READ_SNAPSHOT));
  app.post('/api/hkd/stock-moves', { preHandler: app.requirePermission('sohkd.create'), schema: { body: moveInput } }, async (req, reply) => { const c = ctx(req); return reply.status(201).send(await app.withTenant(req, (trx) => createMove(trx, c.tenantId, c.userId, req.body))); });
  app.delete('/api/hkd/stock-moves/:id', { preHandler: app.requirePermission('sohkd.delete'), schema: { params: id } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteMove(trx, req.params.id)); return reply.status(204).send(); });

  app.get('/api/hkd/other-taxes', { preHandler: view, schema: { querystring: z.object(range).refine(ordered, orderedMsg) } }, async (req) => app.withTenant(req, (trx) => listOtherTax(trx, req.query), READ_SNAPSHOT));
  app.post('/api/hkd/other-taxes', { preHandler: app.requirePermission('sohkd.create'), schema: { body: otherTaxInput } }, async (req, reply) => { const c = ctx(req); return reply.status(201).send(await app.withTenant(req, (trx) => createOtherTax(trx, c.tenantId, c.userId, req.body))); });
  app.delete('/api/hkd/other-taxes/:id', { preHandler: app.requirePermission('sohkd.delete'), schema: { params: id } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteOtherTax(trx, req.params.id)); return reply.status(204).send(); });
};
export default routes;
