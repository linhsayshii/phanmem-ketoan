import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { todayVn } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { branchSessionVars } from '../branch/scope.js';
import { storeInbound } from '../inbound/store.js';
import { dateIso } from '../ledger/vouchers.service.js';
import { recognizeFile, recognizersFor } from './recognizer/index.js';
import { createEntry, deleteEntry, getEntry, listEntries, listRuns, recurringInput, runRecurring, setStatus, updateEntry } from './recurring.js';
import { suggestEntry, suggestInput } from './suggest.js';

const uuid = z.object({ id: z.string().uuid() });
const SETTING_KEY = 'assistant_external_recognition';
const MAX_RUN_AHEAD_DAYS = 45;

// Trợ lý: gợi ý định khoản (cục bộ), bút toán định kỳ (sinh chứng từ nháp), nhận diện hóa đơn. Không route nào ghi sổ, trừ mẫu định kỳ có autoPost do người có voucher.post cấu hình.
const routes: FastifyPluginAsyncZod = async (app) => {
  const use = app.requirePermission('assistant.use');
  const ctx = (req: { auth: { tenantId: string | null; userId: string; permissions: Set<string>; sensitive: Set<string> } | null }) =>
    ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId, auth: { permissions: req.auth!.permissions, sensitive: req.auth!.sensitive } });

  // ---- Gợi ý định khoản ----
  app.post('/api/assistant/suggest-entry', { preValidation: [use, app.requirePermission('voucher.view')], schema: { body: suggestInput } }, async (req) =>
    app.withTenant(req, (trx) => suggestEntry(trx, req.auth!, req.body), READ_SNAPSHOT));

  // ---- Cài đặt và nhận diện hóa đơn ----
  const externalOn = async (req: Parameters<typeof app.withTenant>[0]) => app.withTenant(req, async (trx) =>
    (await trx.selectFrom('tenant_setting').select('value').where('key', '=', SETTING_KEY).executeTakeFirst())?.value === true, READ_SNAPSHOT);
  app.get('/api/assistant/settings', { preValidation: use }, async (req) => ({
    externalRecognition: await externalOn(req), provider: app.config.RECOGNIZER_PROVIDER, imageRecognitionAvailable: recognizersFor(app.config).some((r) => r.supports('pdf')),
  }));
  app.put('/api/assistant/settings', { preValidation: [use, app.requirePermission('setting.update')], schema: { body: z.object({ externalRecognition: z.boolean() }).strict() } }, async (req) => {
    await app.withTenant(req, async (trx) => {
      await trx.insertInto('tenant_setting').values({ tenant_id: req.auth!.tenantId!, key: SETTING_KEY, value: JSON.stringify(req.body.externalRecognition) })
        .onConflict((oc) => oc.columns(['tenant_id', 'key']).doUpdateSet({ value: JSON.stringify(req.body.externalRecognition), updated_at: new Date().toISOString() })).execute();
    });
    return { externalRecognition: req.body.externalRecognition };
  });

  app.post('/api/assistant/recognize', { preValidation: use, schema: { querystring: z.object({ external: z.enum(['true', 'false']).default('false'), save: z.enum(['true', 'false']).default('false') }) } }, async (req) => {
    const file = await req.file({ limits: { fileSize: 10 * 1024 * 1024 } });
    if (!file) throw new AppError('RECOGNIZE_NO_FILE', 'Thiếu tệp', 400);
    let buffer: Buffer;
    try { buffer = await file.toBuffer(); } catch { throw new AppError('RECOGNIZE_TOO_LARGE', 'Tệp vượt 10 MB', 400); }
    const save = req.query.save === 'true';
    if (save && !req.auth!.permissions.has('inbound_invoice.create')) throw new AppError('FORBIDDEN', 'Lưu vào Hóa đơn đầu vào cần quyền inbound_invoice.create', 403);
    const companyAllows = await externalOn(req);
    const out = await recognizeFile(recognizersFor(app.config), { buffer, fileName: file.filename.slice(0, 200) }, { companyAllows, userChose: req.query.external === 'true' });
    // Nhật ký ghi cả lần bị từ chối; chỉ lưu tên tệp, băm và dung lượng, không lưu nội dung.
    await app.withTenant(req, (trx) => trx.insertInto('assistant_recognition_log').values({
      tenant_id: req.auth!.tenantId!, user_id: req.auth!.userId, provider: out.provider, external: out.external, file_name: file.filename.slice(0, 200), file_sha256: out.sha256, bytes: buffer.length,
      status: out.error ? (out.error.status >= 500 ? 'error' : 'rejected') : 'ok', error_code: out.error?.code ?? null,
    }).execute());
    if (out.error) throw out.error;
    // Hóa đơn XML: lưu vào Hóa đơn đầu vào (dùng lại quy trình GĐ5: kiểm trùng, đối chiếu MST, lập chứng từ ở đó). Ảnh/PDF chỉ trả bản nháp để soát.
    let inbound: { id: number; status: string } | null = null;
    if (save) {
      if (out.kind !== 'xml') throw new AppError('RECOGNIZE_SAVE_XML_ONLY', 'Chỉ lưu thẳng vào Hóa đơn đầu vào với tệp XML; ảnh và PDF cần soát rồi nhập tay', 409);
      const r = await app.withTenant(req, (trx) => storeInbound(trx, { tenantId: req.auth!.tenantId! }, buffer.toString('utf8'), 'upload', { receivedBy: req.auth!.userId }));
      inbound = { id: r.id, status: r.status };
    }
    return { recognition: out.recognition, provider: out.provider, external: out.external, inbound };
  });
  app.get('/api/assistant/recognitions', { preValidation: use }, async (req) => app.withTenant(req, async (trx) =>
    (await trx.selectFrom('assistant_recognition_log as l').leftJoin('app_user as u', 'u.id', 'l.user_id').select(['l.id', 'l.provider', 'l.external', 'l.file_name', 'l.bytes', 'l.status', 'l.error_code', 'l.created_at', 'u.username'])
      .orderBy('l.id', 'desc').limit(50).execute()).map((r) => ({ id: r.id, provider: r.provider, external: r.external, fileName: r.file_name, bytes: r.bytes, status: r.status, errorCode: r.error_code, createdAt: r.created_at, username: r.username })), READ_SNAPSHOT));

  // ---- Bút toán định kỳ ----
  const rview = app.requirePermission('recurring.view'); const rmanage = app.requirePermission('recurring.manage');
  app.get('/api/recurring-entries', { preValidation: rview }, async (req) => app.withTenant(req, (trx) => listEntries(trx), READ_SNAPSHOT));
  app.get('/api/recurring-entries/:id', { preValidation: rview, schema: { params: uuid } }, async (req) => app.withTenant(req, (trx) => getEntry(trx, req.params.id, req.auth!), READ_SNAPSHOT));
  app.post('/api/recurring-entries', { preValidation: rmanage, schema: { body: recurringInput } }, async (req, reply) => reply.status(201).send(await app.withTenant(req, (trx) => createEntry(trx, ctx(req), req.body))));
  app.put('/api/recurring-entries/:id', { preValidation: rmanage, schema: { params: uuid, body: recurringInput } }, async (req) => app.withTenant(req, (trx) => updateEntry(trx, ctx(req), req.params.id, req.body)));
  app.post('/api/recurring-entries/:id/status', { preValidation: rmanage, schema: { params: uuid, body: z.object({ status: z.enum(['active', 'paused', 'ended']) }) } }, async (req) =>
    app.withTenant(req, async (trx) => { await getEntry(trx, req.params.id, req.auth!); return setStatus(trx, req.params.id, req.body.status); }));
  app.delete('/api/recurring-entries/:id', { preValidation: rmanage, schema: { params: uuid } }, async (req, reply) => { await app.withTenant(req, (trx) => deleteEntry(trx, req.params.id)); return reply.status(204).send(); });
  app.get('/api/recurring-runs', { preValidation: rview, schema: { querystring: z.object({ entryId: z.string().uuid().optional(), status: z.enum(['created', 'skipped', 'error']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) } }, async (req) =>
    app.withTenant(req, (trx) => listRuns(trx, req.query), READ_SNAPSHOT));
  // "Chạy ngay": sinh chứng từ NHÁP cho các kỳ đã đến hạn (mặc định đến hôm nay; tối đa 45 ngày sau). dryRun chỉ liệt kê kỳ sẽ sinh.
  app.post('/api/recurring-entries/run', { preValidation: [rmanage, app.requirePermission('voucher.create')], schema: { body: z.object({ upTo: dateIso.optional(), entryId: z.string().uuid().optional(), dryRun: z.boolean().default(false) }) } }, async (req) => {
    const today = todayVn(); const limit = new Date(Date.parse(today) + MAX_RUN_AHEAD_DAYS * 86_400_000).toISOString().slice(0, 10);
    const upTo = req.body.upTo ?? today;
    if (upTo > limit) throw new AppError('RECURRING_RUN_AHEAD', `Chỉ chạy trước tối đa ${MAX_RUN_AHEAD_DAYS} ngày`, 400);
    const items = await runRecurring(app.db, req.auth!.tenantId!, {
      upTo, ...(req.body.entryId && { entryId: req.body.entryId }), dryRun: req.body.dryRun, trigger: 'manual', userId: req.auth!.userId, auth: { sensitive: req.auth!.sensitive },
      session: { ip: req.ip, ...branchSessionVars(req.auth!) },
    });
    return { upTo, dryRun: req.body.dryRun, items, created: items.filter((i) => i.status === 'created').length, skipped: items.filter((i) => i.status === 'skipped').length, errors: items.filter((i) => i.status === 'error').length };
  });
};
export default routes;
