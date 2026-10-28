import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { isoDate } from '../reporting/routes.js';
import { createDelegation, delegateCandidates, delegationInput, listDelegations, revokeDelegation } from './delegation.js';
import {
  approveRequest, BOXES, cancelRequest, createRequest, decisionInput, flowInput, getRequest, getRequestRow, inboxCount, listFlows, listRequests, rejectInput, rejectRequest, requestInput, saveFlow,
  submitRequest, updateRequest,
} from './service.js';

const idParam = z.object({ id: z.string().uuid() });
const BATCH_MAX = 100;
const batchIds = z.array(z.string().uuid()).min(1, 'Chọn ít nhất một đề nghị').max(BATCH_MAX, `Tối đa ${BATCH_MAX} đề nghị mỗi lần`).refine((a) => new Set(a).size === a.length, 'Có đề nghị bị chọn trùng');
type BatchResult = { id: string; ok: true; state: string } | { id: string; ok: false; code: string; message: string };
// Kết quả từng đề nghị: lỗi quyền không nêu cờ nhạy cảm nào bị thiếu (danh sách duyệt không lộ cờ).
const batchError = (id: string, e: unknown): BatchResult => {
  if (e instanceof AppError) return e.code === 'FORBIDDEN' ? { id, ok: false, code: 'FORBIDDEN', message: 'Bạn không duyệt được đề nghị này' } : { id, ok: false, code: e.code, message: e.message };
  throw e;
};
const STATES = ['draft', 'submitted', 'approved', 'rejected', 'cancelled'] as const;

// Duyệt bước cuối sinh phiếu và chép tệp đính kèm: tệp đã chép bị xóa nếu giao dịch hỏng (không để tệp mồ côi). Dùng chung cho web và mobile.
export async function approveWithFiles(app: FastifyInstance, req: FastifyRequest, id: string, note: string | null) {
  const written: string[] = [];
  try {
    return await app.withOverride(req, (trx) => approveRequest(trx, req.auth!, id, note, app.config.ATTACHMENT_DIR, written));
  } catch (e) {
    await Promise.all(written.map((f) => unlink(f).catch(() => undefined)));
    throw e;
  }
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const auth = app.requireAuth.bind(app);
  const perm = (p: string) => app.requirePermission(p);
  const settings = perm('setting.update');

  // ---- Quy trình phê duyệt (cấu hình) ----
  app.get('/api/approval-flows', { preHandler: settings }, async (req) => app.withTenant(req, (trx) => listFlows(trx), READ_SNAPSHOT));
  app.post('/api/approval-flows', { preHandler: settings, schema: { body: flowInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => saveFlow(trx, req.auth!.tenantId!, null, req.body))));
  app.put('/api/approval-flows/:id', { preHandler: settings, schema: { params: z.object({ id: z.coerce.number().int().positive() }), body: flowInput } }, async (req) =>
    app.withTenant(req, (trx) => saveFlow(trx, req.auth!.tenantId!, req.params.id, req.body)));

  // ---- Đề nghị ----
  app.get('/api/approvals', { preHandler: auth, schema: { querystring: z.object({ box: z.enum(BOXES).default('mine'), state: z.enum(STATES).optional(), from: isoDate.optional(), to: isoDate.optional() }) } }, async (req) =>
    app.withTenant(req, (trx) => listRequests(trx, req.auth!, req.query.box, req.query), READ_SNAPSHOT));
  // Thông báo trong ứng dụng: số đề nghị đang chờ chính người này duyệt (đầu trang).
  app.get('/api/approvals/inbox/count', { preHandler: auth }, async (req) => ({ count: await app.withTenant(req, (trx) => inboxCount(trx, req.auth!), READ_SNAPSHOT) }));
  app.get('/api/approvals/:id', { preHandler: auth, schema: { params: idParam } }, async (req) => app.withTenant(req, (trx) => getRequest(trx, req.auth!, req.params.id), READ_SNAPSHOT));
  app.post('/api/approvals', { preHandler: perm('approval_request.create'), schema: { body: requestInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => createRequest(trx, req.auth!, req.body))));
  app.put('/api/approvals/:id', { preHandler: perm('approval_request.create'), schema: { params: idParam, body: requestInput } }, async (req) => {
    await app.withTenant(req, (trx) => updateRequest(trx, req.auth!, req.params.id, req.body));
    return { ok: true };
  });
  app.post('/api/approvals/:id/submit', { preHandler: perm('approval_request.create'), schema: { params: idParam } }, async (req) => {
    await app.withTenant(req, (trx) => submitRequest(trx, req.auth!, req.params.id));
    return { ok: true };
  });
  app.post('/api/approvals/:id/cancel', { preHandler: perm('approval_request.create'), schema: { params: idParam, body: decisionInput } }, async (req) => {
    await app.withTenant(req, (trx) => cancelRequest(trx, req.auth!, req.params.id, req.body.note ?? null));
    return { ok: true };
  });
  app.post('/api/approvals/:id/approve', { preHandler: perm('approval_request.approve'), schema: { params: idParam, body: decisionInput } }, async (req) =>
    approveWithFiles(app, req, req.params.id, req.body.note ?? null));
  app.post('/api/approvals/:id/reject', { preHandler: perm('approval_request.approve'), schema: { params: idParam, body: rejectInput } }, async (req) => {
    await app.withTenant(req, (trx) => rejectRequest(trx, req.auth!, req.params.id, req.body.reason));
    return { ok: true };
  });

  // ---- Duyệt hàng loạt: từng đề nghị một giao dịch riêng (đề nghị lỗi không kéo các đề nghị khác), trả kết quả từng đề nghị ----
  app.post('/api/approvals/batch/approve', { preHandler: perm('approval_request.approve'), schema: { body: z.object({ ids: batchIds, note: z.string().trim().max(1000).optional() }) } }, async (req) => {
    const results: BatchResult[] = [];
    for (const id of req.body.ids) {
      try { results.push({ id, ok: true, state: (await approveWithFiles(app, req, id, req.body.note ?? null)).state }); } catch (e) { results.push(batchError(id, e)); }
    }
    return { results, approved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  });
  app.post('/api/approvals/batch/reject', { preHandler: perm('approval_request.approve'), schema: { body: z.object({ ids: batchIds, reason: rejectInput.shape.reason }) } }, async (req) => {
    const results: BatchResult[] = [];
    for (const id of req.body.ids) {
      try { await app.withTenant(req, (trx) => rejectRequest(trx, req.auth!, id, req.body.reason)); results.push({ id, ok: true, state: 'rejected' }); } catch (e) { results.push(batchError(id, e)); }
    }
    return { results, rejected: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  });

  // ---- Ủy quyền duyệt khi vắng mặt ----
  // Mọi người dùng có quyền duyệt xem/lập/thu hồi ủy quyền của mình; quản trị (setting.update) xem mọi ủy quyền và lập/thu hồi thay người khác.
  app.get('/api/approval-delegations', { preHandler: perm('approval_request.approve'), schema: { querystring: z.object({ scope: z.enum(['mine', 'all']).default('mine') }) } }, async (req) =>
    app.withTenant(req, (trx) => listDelegations(trx, req.auth!, req.query.scope), READ_SNAPSHOT));
  app.get('/api/approval-delegations/candidates', { preHandler: perm('approval_request.approve') }, async (req) => app.withTenant(req, (trx) => delegateCandidates(trx, req.auth!), READ_SNAPSHOT));
  app.post('/api/approval-delegations', { preHandler: perm('approval_request.approve'), schema: { body: delegationInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => createDelegation(trx, req.auth!, req.body))));
  app.post('/api/approval-delegations/:id/revoke', { preHandler: perm('approval_request.approve'), schema: { params: z.object({ id: z.coerce.number().int().positive() }) } }, async (req) => {
    await app.withTenant(req, (trx) => revokeDelegation(trx, req.auth!, req.params.id));
    return { ok: true };
  });

  // ---- Tệp đính kèm của đề nghị (người đề nghị thêm khi nháp hoặc đang chờ duyệt, xóa khi nháp) ----
  app.post('/api/approvals/:id/attachments', { preHandler: perm('approval_request.create'), schema: { params: idParam } }, async (req, reply) => {
    const file = await req.file(); if (!file) throw new AppError('NO_FILE', 'Thiếu tệp', 400);
    const buf = await file.toBuffer(); const tenantId = req.auth!.tenantId!;
    const written: string[] = [];
    try {
      const row = await app.withTenant(req, async (trx) => {
        const r = await getRequestRow(trx, req.params.id, true);
        if (r.requester_id !== req.auth!.userId) throw new AppError('FORBIDDEN', 'Chỉ người đề nghị được đính kèm tệp', 403);
        if (r.state !== 'draft' && r.state !== 'submitted') throw new AppError('APPROVAL_CLOSED', 'Đề nghị đã kết thúc, không thêm tệp', 409);
        const a = await trx.insertInto('approval_attachment').values({ tenant_id: tenantId, request_id: r.id, file_name: file.filename, mime: file.mimetype, bytes: buf.length, storage_key: '', uploaded_by: req.auth!.userId })
          .returning(['id', 'file_name', 'bytes']).executeTakeFirstOrThrow();
        const key = path.join(app.config.ATTACHMENT_DIR, tenantId, 'approval', r.id, a.id); written.push(key);
        await mkdir(path.dirname(key), { recursive: true }); await writeFile(key, buf);
        await trx.updateTable('approval_attachment').set({ storage_key: key }).where('id', '=', a.id).execute();
        return a;
      });
      return reply.status(201).send({ id: row.id, fileName: row.file_name, bytes: Number(row.bytes) });
    } catch (e) {
      await Promise.all(written.map((f) => unlink(f).catch(() => undefined)));
      throw e;
    }
  });
  app.get('/api/approval-attachments/:attId', { preHandler: auth, schema: { params: z.object({ attId: z.string().uuid() }) } }, async (req, reply) => {
    const a = await app.withTenant(req, async (trx) => {
      const att = await trx.selectFrom('approval_attachment').selectAll().where('id', '=', req.params.attId).executeTakeFirst();
      if (!att) throw new AppError('NOT_FOUND', 'Không có tệp', 404);
      await getRequest(trx, req.auth!, att.request_id); // cùng điều kiện xem như đề nghị
      return att;
    }, READ_SNAPSHOT);
    const size = await stat(a.storage_key).then((s) => s.size, () => null);
    if (size === null) throw new AppError('FILE_MISSING', 'Tệp đính kèm không còn trên máy chủ', 404);
    reply.header('content-type', a.mime).header('content-length', size).header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.file_name)}`);
    return reply.send(createReadStream(a.storage_key));
  });
  app.delete('/api/approval-attachments/:attId', { preHandler: perm('approval_request.create'), schema: { params: z.object({ attId: z.string().uuid() }) } }, async (req, reply) => {
    const key = await app.withTenant(req, async (trx) => {
      const att = await trx.selectFrom('approval_attachment').select(['request_id', 'storage_key']).where('id', '=', req.params.attId).executeTakeFirst();
      if (!att) throw new AppError('NOT_FOUND', 'Không có tệp', 404);
      const r = await getRequestRow(trx, att.request_id, true);
      if (r.requester_id !== req.auth!.userId || r.state !== 'draft') throw new AppError('APPROVAL_NOT_DRAFT', 'Chỉ người đề nghị xóa được tệp khi đề nghị còn nháp', 409);
      await trx.deleteFrom('approval_attachment').where('id', '=', req.params.attId).execute();
      return att.storage_key;
    });
    await unlink(key).catch(() => undefined);
    return reply.status(204).send();
  });
};
export default routes;
