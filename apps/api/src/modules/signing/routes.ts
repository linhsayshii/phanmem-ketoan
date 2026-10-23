import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { fakeSign } from './providers/fake.js';
import { assertFakeAllowed, policyOf } from './providers/policy.js';
import { pollSign, startSign } from './providers/smartca.js';
import { SigningProviderError, type SigningKind } from './providers/types.js';
import {
  completeSession, createSession, deleteProfile, expiredError, isExpired, listProfiles, loadSession, markExpired, markFailed, profileInput, resolveProfileCert, saveProfile,
  sessionDto, sessionInput, setDefaultProfile, setProviderRef, smartcaCfgOf, toAppError, type SessionCtx,
} from './sessions.js';

const numId = z.object({ id: z.coerce.number().int().positive() });
const uuidId = z.object({ id: z.string().uuid() });

// Ký số XML. Hồ sơ và phiên là của riêng từng người dùng (lọc theo user_id; của người khác trả 404).
const routes: FastifyPluginAsyncZod = async (app) => {
  const use = app.requirePermission('signing.use');
  const policy = policyOf(app.config);
  const ctxOf = (req: { auth: { tenantId: string | null; userId: string; permissions: Set<string> } | null }): SessionCtx => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId, permissions: req.auth!.permissions });

  app.get('/api/signing/profiles', { preHandler: use }, async (req) => app.withTenant(req, (trx) => listProfiles(trx, req.auth!.userId), READ_SNAPSHOT));
  app.post('/api/signing/profiles', { preHandler: use, schema: { body: profileInput } }, async (req, reply) => {
    const cert = await resolveProfileCert(req.body, policy).catch(toAppError); // SmartCA gọi VNPT ngoài giao dịch
    return reply.status(201).send(await app.withTenant(req, (trx) => saveProfile(trx, req.auth!.tenantId!, req.auth!.userId, req.body, cert)));
  });
  app.post('/api/signing/profiles/:id/default', { preHandler: use, schema: { params: numId } }, async (req, reply) => {
    await app.withTenant(req, (trx) => setDefaultProfile(trx, req.auth!.userId, req.params.id));
    return reply.status(204).send();
  });
  app.delete('/api/signing/profiles/:id', { preHandler: use, schema: { params: numId } }, async (req, reply) => {
    await app.withTenant(req, (trx) => deleteProfile(trx, req.auth!.userId, req.params.id));
    return reply.status(204).send();
  });

  // Tạo phiên: dựng XML, tính băm SignedInfo. SmartCA: gửi băm đi ngay, người dùng xác nhận trên ứng dụng rồi trình duyệt gọi /poll.
  app.post('/api/signing/sessions', { preHandler: use, schema: { body: sessionInput } }, async (req, reply) => {
    const { session, profile } = await app.withTenant(req, (trx) => createSession(trx, ctxOf(req), policy, req.body));
    if (profile.kind === 'smartca') {
      try {
        const ref = await startSign(smartcaCfgOf(profile), policy, { transactionId: `KT-${session.id}`, docId: session.id, digestB64: session.digest_b64, desc: `Ky ${session.doc_kind} ${session.doc_ref}` });
        await app.withTenant(req, (trx) => setProviderRef(trx, session.id, ref));
      } catch (e) {
        await app.withTenant(req, (trx) => markFailed(trx, session.id, e instanceof Error ? e.message : String(e)));
        return toAppError(e);
      }
    }
    return reply.status(201).send(sessionDto(session, profile.kind as SigningKind));
  });

  const load = async (req: Parameters<typeof ctxOf>[0] & Parameters<typeof app.withTenant>[0], id: string) => {
    const r = await app.withTenant(req, (trx) => loadSession(trx, req.auth!.userId, id), READ_SNAPSHOT);
    if (isExpired(r.session)) {
      await app.withTenant(req, (trx) => markExpired(trx, id));
      throw expiredError();
    }
    return r;
  };

  app.get('/api/signing/sessions/:id', { preHandler: use, schema: { params: uuidId } }, async (req) => {
    const { session, profile } = await app.withTenant(req, (trx) => loadSession(trx, req.auth!.userId, req.params.id), READ_SNAPSHOT);
    return sessionDto(isExpired(session) ? { ...session, status: 'expired' } : session, profile.kind as SigningKind);
  });

  // Tiện ích cục bộ: trình duyệt gửi chữ ký lên; máy chủ ghép và kiểm bằng chứng thư của hồ sơ.
  app.post('/api/signing/sessions/:id/complete', { preHandler: use, schema: { params: uuidId, body: z.object({ signatureB64: z.string().min(1).max(4000) }) } }, async (req) => {
    const { session, profile } = await load(req, req.params.id);
    if (profile.kind !== 'local_agent') throw new AppError('SIGNING_MODE_MISMATCH', 'Hồ sơ này ký phía máy chủ: dùng /poll', 409);
    await app.withTenant(req, (trx) => completeSession(trx, session, profile, req.body.signatureB64));
    return { id: session.id, status: 'signed' };
  });

  // SmartCA/giả lập: máy chủ hỏi kết quả; pending = người dùng chưa xác nhận.
  app.post('/api/signing/sessions/:id/poll', { preHandler: use, schema: { params: uuidId } }, async (req) => {
    const { session, profile } = await load(req, req.params.id);
    if (profile.kind === 'local_agent') throw new AppError('SIGNING_MODE_MISMATCH', 'Hồ sơ này ký bằng tiện ích cục bộ: dùng /complete', 409);
    if (session.status === 'signed') return { id: session.id, status: 'signed' };
    let sig: string | null;
    try {
      if (profile.kind === 'fake') { assertFakeAllowed(policy); sig = fakeSign(session.digest_b64); }
      else sig = await pollSign(smartcaCfgOf(profile), policy, session.provider_ref ?? '', session.id);
    } catch (e) {
      // Lỗi mạng tạm thời hoặc lỗi cấu hình (AppError): giữ phiên 'pending'; chỉ lỗi dứt khoát của SmartCA mới đánh dấu failed.
      if (!(e instanceof SigningProviderError && e.code === 'SMARTCA_UNREACHABLE') && !(e instanceof AppError)) await app.withTenant(req, (trx) => markFailed(trx, session.id, e instanceof Error ? e.message : String(e)));
      return toAppError(e);
    }
    if (sig === null) return { id: session.id, status: 'pending' };
    try { await app.withTenant(req, (trx) => completeSession(trx, session, profile, sig)); } catch (e) {
      if (!(e instanceof AppError && e.code === 'SIGNING_SESSION_NOT_PENDING')) throw e; // lần hỏi song song đã hoàn tất trước: trả trạng thái hiện tại
      return { id: session.id, status: (await app.withTenant(req, (trx) => loadSession(trx, req.auth!.userId, session.id), READ_SNAPSHOT)).session.status };
    }
    return { id: session.id, status: 'signed' };
  });

  app.get('/api/signing/sessions/:id/result', { preHandler: use, schema: { params: uuidId } }, async (req, reply) => {
    const { session } = await app.withTenant(req, (trx) => loadSession(trx, req.auth!.userId, req.params.id), READ_SNAPSHOT);
    if (session.status !== 'signed' || !session.signed_xml) throw new AppError('SIGNING_NOT_COMPLETE', 'Phiên ký số chưa hoàn tất', 409);
    return reply.type('application/xml; charset=utf-8').header('content-disposition', `attachment; filename="${session.doc_kind}-${session.doc_ref}-signed.xml"`).send(session.signed_xml);
  });
};
export default routes;
