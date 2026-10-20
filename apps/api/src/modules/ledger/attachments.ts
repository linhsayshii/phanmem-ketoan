import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';

// Chứng từ gốc đính kèm là một phần bằng chứng của kỳ đã khóa cứng (chuỗi băm): kỳ khóa cứng thì không thêm hoặc xóa; tải về không bị ảnh hưởng.
async function assertPeriodNotHardLocked(trx: Transaction<Database>, voucherId: string) {
  const p = await trx.selectFrom('voucher as v').innerJoin('fiscal_period as p', (j) => j.onRef('p.tenant_id', '=', 'v.tenant_id').onRef('p.fiscal_year', '=', 'v.fiscal_year').onRef('p.period_no', '=', 'v.period_no'))
    .select('p.status').where('v.id', '=', voucherId).executeTakeFirst();
  if (p?.status === 'hard_locked') throw new AppError('PERIOD_HARD_LOCKED', 'Kỳ đã khóa cứng: không thêm hoặc xóa chứng từ gốc đính kèm', 409);
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const dirOf = (tenantId: string, voucherId: string) => path.join(app.config.ATTACHMENT_DIR, tenantId, voucherId);

  app.post('/api/vouchers/:id/attachments', { preHandler: app.requirePermission('voucher.update'), schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    const file = await req.file(); if (!file) throw new AppError('NO_FILE', 'Thiếu tệp', 400);
    const buf = await file.toBuffer(); const tenantId = req.auth!.tenantId!;
    const written: string[] = []; // tệp đã (hoặc đang) ghi: nếu giao dịch hỏng sau đó thì xóa, không để tệp mồ côi
    try {
      const row = await app.withTenant(req, async (trx) => {
        const v = await trx.selectFrom('voucher').select('id').where('id', '=', req.params.id).executeTakeFirst();
        if (!v) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ', 404);
        await assertPeriodNotHardLocked(trx, v.id);
        const r = await trx.insertInto('voucher_attachment').values({ tenant_id: tenantId, voucher_id: v.id, file_name: file.filename, mime: file.mimetype, bytes: buf.length, storage_key: '', uploaded_by: req.auth!.userId })
          .returning(['id', 'file_name', 'bytes']).executeTakeFirstOrThrow();
        const key = path.join(dirOf(tenantId, v.id), r.id); written.push(key);
        await mkdir(path.dirname(key), { recursive: true }); await writeFile(key, buf);
        await trx.updateTable('voucher_attachment').set({ storage_key: key }).where('id', '=', r.id).execute();
        return r;
      });
      return reply.status(201).send({ id: row.id, fileName: row.file_name, bytes: Number(row.bytes) });
    } catch (e) {
      await Promise.all(written.map((f) => unlink(f).catch(() => undefined)));
      throw e;
    }
  });

  app.get('/api/vouchers/:id/attachments', { preHandler: app.requirePermission('voucher.view'), schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) =>
    app.withTenant(req, (trx) => trx.selectFrom('voucher_attachment').select(['id', 'file_name as fileName', 'mime', 'bytes', 'uploaded_at as uploadedAt']).where('voucher_id', '=', req.params.id).orderBy('uploaded_at').execute()));

  app.get('/api/attachments/:attId', { preHandler: app.requirePermission('voucher.view'), schema: { params: z.object({ attId: z.string().uuid() }) } }, async (req, reply) => {
    const a = await app.withTenant(req, (trx) => trx.selectFrom('voucher_attachment').selectAll().where('id', '=', req.params.attId).executeTakeFirst());
    if (!a) throw new AppError('NOT_FOUND', 'Không có tệp', 404);
    const size = await stat(a.storage_key).then((s) => s.size, () => null);
    if (size === null) throw new AppError('FILE_MISSING', 'Tệp đính kèm không còn trên máy chủ', 404);
    // mime do máy khách khai báo: nosniff + attachment để trình duyệt không tự chạy nội dung (vd. HTML) trong nguồn gốc của ứng dụng
    reply.header('content-type', a.mime).header('content-length', size).header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.file_name)}`);
    return reply.send(createReadStream(a.storage_key));
  });

  app.delete('/api/attachments/:attId', { preHandler: app.requirePermission('voucher.update'), schema: { params: z.object({ attId: z.string().uuid() }) } }, async (req, reply) => {
    const a = await app.withTenant(req, async (trx) => {
      const att = await trx.selectFrom('voucher_attachment').select('voucher_id').where('id', '=', req.params.attId).executeTakeFirst();
      if (att) await assertPeriodNotHardLocked(trx, att.voucher_id);
      return trx.deleteFrom('voucher_attachment').where('id', '=', req.params.attId).returning('storage_key').executeTakeFirst();
    });
    if (!a) throw new AppError('NOT_FOUND', 'Không có tệp', 404);
    await unlink(a.storage_key).catch(() => undefined);
    return reply.status(204).send();
  });
};
export default routes;
