import { X509Certificate } from 'node:crypto';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { openSecret, sealSecret } from '../../lib/secretBox.js';
import { renderReturnXml } from '../tax/vatXml.js';
import { renderCitXml } from '../tax/citReturn.js';
import { assertTncnTemplate, formOfDocKind } from '../payroll/tncnReturn.js';
import { FAKE_CERT_DER } from './providers/fake.js';
import { assertFakeAllowed, assertSmartcaUrl, type SigningPolicy } from './providers/policy.js';
import { describeCertificate, LOCAL_AGENT_URL } from './providers/localAgent.js';
import { getCertificates, SMARTCA_UAT_URL, type SmartCaCfg } from './providers/smartca.js';
import { SIGNING_MODE, SigningProviderError, type SigningKind } from './providers/types.js';
import { prepareEnveloped, verifyEnveloped } from './xmldsig.js';

type Trx = Transaction<Database>;
const text = (max: number) => z.string().trim().max(max);
export const SESSION_TTL_MS = 10 * 60 * 1000;

// Hồ sơ ký: local_agent nhận chứng thư từ tiện ích (trình duyệt gửi lên), smartca lấy chứng thư từ VNPT, fake là khóa thử (không dùng ở production).
export const profileInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local_agent'), label: text(100).min(1), certB64: z.string().min(100).max(20000), isDefault: z.boolean().default(false) }),
  z.object({ kind: z.literal('fake'), label: text(100).min(1), isDefault: z.boolean().default(false) }),
  z.object({ kind: z.literal('smartca'), label: text(100).min(1), baseUrl: text(300).url().default(SMARTCA_UAT_URL), spId: text(200).min(1), spPassword: z.string().min(1).max(200),
    userId: text(50).min(1), serial: text(100).optional(), isDefault: z.boolean().default(false) }),
]);
export type ProfileInput = z.infer<typeof profileInput>;
export const sessionInput = z.object({ docKind: z.enum(['vat_return', 'cit_return', 'error_notice', '05kk_tncn', '05qtt_tncn']), docRef: text(50).min(1), profileId: z.number().int().positive().optional() });

type ProfileRow = Selectable<Database['signing_profile']>;
export const profileDto = (r: ProfileRow) => ({ id: r.id, kind: r.kind as SigningKind, label: r.label, certSubject: r.cert_subject, certSerial: r.cert_serial, certNotAfter: new Date(r.cert_not_after).toISOString(),
  isDefault: r.is_default, hasCredentials: r.credentials !== null, expired: new Date(r.cert_not_after).getTime() <= Date.now() });

const profileNotFound = () => new AppError('SIGNING_PROFILE_NOT_FOUND', 'Không tìm thấy hồ sơ ký số', 404);
const sessionNotFound = () => new AppError('SIGNING_SESSION_NOT_FOUND', 'Không tìm thấy phiên ký số', 404);

export const listProfiles = async (trx: Trx, userId: string) => (await trx.selectFrom('signing_profile').selectAll().where('user_id', '=', userId).orderBy('id').execute()).map(profileDto);

// Chứng thư của hồ sơ mới: SmartCA gọi VNPT nên chạy NGOÀI giao dịch (gọi trước, lưu sau).
export interface ProfileCert { der: Buffer; subject: string; serial: string; notAfter: Date; credentials: Buffer | null }
export async function resolveProfileCert(b: ProfileInput, pol: SigningPolicy): Promise<ProfileCert> {
  if (b.kind === 'local_agent') return { ...describeCertificate(b.certB64), credentials: null };
  if (b.kind === 'fake') {
    assertFakeAllowed(pol);
    return { ...describeCertificate(FAKE_CERT_DER.toString('base64')), credentials: null };
  }
  assertSmartcaUrl(b.baseUrl, pol); // trước khi mã hóa hay gọi ra ngoài
  const cfg: SmartCaCfg = { baseUrl: b.baseUrl, spId: b.spId, spPassword: b.spPassword, userId: b.userId, ...(b.serial && { serial: b.serial }) };
  const credentials = sealSecret(JSON.stringify(cfg)); // thiếu DATA_ENCRYPTION_KEY: 409 trước khi gọi ra ngoài
  const certs = (await getCertificates(cfg, pol)).filter((c) => !c.status || /hoạt động|active/i.test(c.status));
  const c = b.serial ? certs.find((x) => x.serial.toLowerCase() === b.serial!.toLowerCase()) : certs[0];
  if (!c) throw new AppError('SMARTCA_CERT_NOT_FOUND', 'Không tìm thấy chứng thư SmartCA đang hoạt động của thuê bao này', 404);
  return { ...describeCertificate(c.certB64), credentials };
}

export async function saveProfile(trx: Trx, tenantId: string, userId: string, b: ProfileInput, cert: ProfileCert) {
  const existing = await trx.selectFrom('signing_profile').select('id').where('user_id', '=', userId).limit(1).executeTakeFirst();
  const makeDefault = b.isDefault || !existing;
  if (makeDefault) await trx.updateTable('signing_profile').set({ is_default: false }).where('user_id', '=', userId).execute();
  return profileDto(await trx.insertInto('signing_profile').values({ tenant_id: tenantId, user_id: userId, kind: b.kind, label: b.label, cert_der: cert.der, cert_subject: cert.subject,
    cert_serial: cert.serial, cert_not_after: cert.notAfter.toISOString(), credentials: cert.credentials, is_default: makeDefault }).returningAll().executeTakeFirstOrThrow());
}

export async function setDefaultProfile(trx: Trx, userId: string, id: number) {
  const row = await trx.selectFrom('signing_profile').select('id').where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  if (!row) throw profileNotFound();
  await trx.updateTable('signing_profile').set({ is_default: false }).where('user_id', '=', userId).where('id', '!=', id).execute();
  await trx.updateTable('signing_profile').set({ is_default: true }).where('id', '=', id).execute();
}

export async function deleteProfile(trx: Trx, userId: string, id: number) {
  const row = await trx.selectFrom('signing_profile').select('id').where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  if (!row) throw profileNotFound();
  if (await trx.selectFrom('signing_session').select('id').where('profile_id', '=', id).limit(1).executeTakeFirst()) throw new AppError('SIGNING_PROFILE_IN_USE', 'Hồ sơ đã có phiên ký, không xóa được', 409);
  await trx.deleteFrom('signing_profile').where('id', '=', id).execute();
}

export const smartcaCfgOf = (p: ProfileRow): SmartCaCfg => {
  if (!p.credentials) throw new AppError('SIGNING_PROFILE_NO_CREDENTIALS', 'Hồ sơ SmartCA thiếu thông tin đăng nhập', 409);
  return JSON.parse(openSecret(p.credentials)) as SmartCaCfg;
};

// Nguồn XML cần ký theo loại chứng từ: tờ khai 01/GTGT, tờ khai 03/TNDN. Thông báo 04/SS chưa có bộ dựng XML: báo rõ thay vì ký giả.
async function documentXml(trx: Trx, ctx: SessionCtx, kind: string, ref: string): Promise<string> {
  if (kind !== 'vat_return' && kind !== 'cit_return') throw new AppError('SIGNING_DOC_UNSUPPORTED', `Chưa có XML để ký cho loại chứng từ "${kind}"`, 400);
  if (kind === 'vat_return' ? !ctx.permissions.has('tax_return.view') || !ctx.permissions.has('tax.view') : !ctx.permissions.has('cit.view')) throw new AppError('FORBIDDEN', 'Thiếu quyền xem tờ khai thuế', 403);
  if (!/^\d{1,9}$/.test(ref)) throw new AppError('SIGNING_DOC_INVALID', 'Mã tờ khai không hợp lệ', 400);
  return (kind === 'vat_return' ? await renderReturnXml(trx, ctx.tenantId, Number(ref)) : await renderCitXml(trx, ctx.tenantId, Number(ref))).xml;
}

export interface SessionCtx { tenantId: string; userId: string; permissions: Set<string> }
type SessionRow = Selectable<Database['signing_session']>;
export const sessionDto = (s: SessionRow, kind: SigningKind) => ({ id: s.id, status: s.status, docKind: s.doc_kind, docRef: s.doc_ref, kind, mode: SIGNING_MODE[kind], digestB64: s.digest_b64,
  expiresAt: new Date(s.expires_at).toISOString(), ...(kind === 'local_agent' && { agentUrl: LOCAL_AGENT_URL }), ...(s.error_message && { error: s.error_message }) });

export async function createSession(trx: Trx, ctx: SessionCtx, pol: SigningPolicy, b: z.infer<typeof sessionInput>) {
  const tncn = formOfDocKind(b.docKind); if (tncn) assertTncnTemplate(tncn); // tờ khai TNCN chưa có mẫu: 409 trước mọi bước ký
  const q = trx.selectFrom('signing_profile').selectAll().where('user_id', '=', ctx.userId);
  const profile = await (b.profileId ? q.where('id', '=', b.profileId) : q.where('is_default', '=', true)).executeTakeFirst();
  if (!profile) { if (b.profileId) throw profileNotFound(); throw new AppError('SIGNING_PROFILE_MISSING', 'Chưa có hồ sơ ký số: thêm chứng thư ở Cài đặt ký số', 409); }
  if (profile.kind === 'fake') assertFakeAllowed(pol);
  if (new Date(profile.cert_not_after).getTime() <= Date.now()) throw new AppError('CERTIFICATE_EXPIRED', 'Chứng thư số đã hết hạn, không ký được', 409);
  const xml = await documentXml(trx, ctx, b.docKind, b.docRef);
  const id = (await sql<{ id: string }>`SELECT gen_random_uuid() AS id`.execute(trx)).rows[0]!.id;
  const signingTime = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 19); // GMT+7, không hậu tố múi giờ (xml-hoa-don.md)
  const p = prepareEnveloped(xml, profile.cert_der, { signingTime, signatureId: `sig-${id}` });
  const row = await trx.insertInto('signing_session').values({ id, tenant_id: ctx.tenantId, user_id: ctx.userId, profile_id: profile.id, doc_kind: b.docKind, doc_ref: b.docRef,
    xml_unsigned: xml, signing_time: signingTime, signed_info_c14n: p.signedInfoC14n, digest_b64: p.digestB64, expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() }).returningAll().executeTakeFirstOrThrow();
  return { session: row, profile };
}

// Phiên của chính người dùng; hết hạn thì đánh dấu 'expired' (cập nhật trong giao dịch riêng của người gọi: xem expireIfNeeded).
export async function loadSession(trx: Trx, userId: string, id: string) {
  const s = await trx.selectFrom('signing_session').selectAll().where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  if (!s) throw sessionNotFound();
  const profile = await trx.selectFrom('signing_profile').selectAll().where('id', '=', s.profile_id).executeTakeFirstOrThrow();
  return { session: s, profile };
}
export const isExpired = (s: SessionRow) => s.status === 'expired' || (s.status === 'pending' && new Date(s.expires_at).getTime() <= Date.now());
export const expiredError = () => new AppError('SIGNING_SESSION_EXPIRED', 'Phiên ký số đã hết hạn (10 phút): bắt đầu lại', 409);

export async function markExpired(trx: Trx, id: string) { await trx.updateTable('signing_session').set({ status: 'expired' }).where('id', '=', id).where('status', '=', 'pending').execute(); }
export async function markFailed(trx: Trx, id: string, message: string) { await trx.updateTable('signing_session').set({ status: 'failed', error_message: message.slice(0, 500) }).where('id', '=', id).where('status', '=', 'pending').execute(); }
export async function setProviderRef(trx: Trx, id: string, ref: string) { await trx.updateTable('signing_session').set({ provider_ref: ref }).where('id', '=', id).execute(); }

// Ghép chữ ký, kiểm bằng chứng thư của hồ sơ; sai → 400 SIGNATURE_INVALID (phiên vẫn 'pending' để thử lại tới khi hết hạn).
const notPending = (what: string) => new AppError('SIGNING_SESSION_NOT_PENDING', `Phiên ký số đã ${what}`, 409);
export async function completeSession(trx: Trx, s: SessionRow, profile: ProfileRow, signatureB64: string): Promise<string> {
  if (s.status !== 'pending') throw notPending(s.status === 'signed' ? 'hoàn tất' : 'kết thúc');
  if (new Date(profile.cert_not_after).getTime() <= Date.now()) throw new AppError('CERTIFICATE_EXPIRED', 'Chứng thư số đã hết hạn, không ký được', 409);
  if (!/^[A-Za-z0-9+/]{100,}={0,2}$/.test(signatureB64)) throw new AppError('SIGNATURE_INVALID', 'Chữ ký không hợp lệ', 400);
  const p = prepareEnveloped(s.xml_unsigned, profile.cert_der, { signingTime: s.signing_time, signatureId: `sig-${s.id}` });
  if (p.digestB64 !== s.digest_b64) throw new Error('Không dựng lại được SignedInfo của phiên ký'); // lỗi hệ thống, không phải do người dùng
  const signed = p.finish(signatureB64);
  const v = verifyEnveloped(signed);
  if (!v.valid || !v.certDer?.equals(profile.cert_der) || new X509Certificate(v.certDer).serialNumber.toLowerCase() !== profile.cert_serial) {
    throw new AppError('SIGNATURE_INVALID', 'Chữ ký không khớp chứng thư số của hồ sơ ký', 400);
  }
  // Chỉ chuyển từ pending: hai lần hoàn tất song song thì lần sau 0 dòng → 409 (không ghi đè XML đã ký).
  const done = await trx.updateTable('signing_session').set({ status: 'signed', signed_xml: signed, error_message: null }).where('id', '=', s.id).where('status', '=', 'pending').returning('id').executeTakeFirst();
  if (!done) throw notPending('kết thúc');
  return signed;
}

export const toAppError = (e: unknown): never => {
  if (e instanceof SigningProviderError) throw new AppError(e.code, e.message, e.code === 'CERTIFICATE_INVALID' || e.code === 'SMARTCA_URL_NOT_ALLOWED' ? 400 : 502);
  throw e;
};
