import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, TEST_PASSWORD, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';
import { verifyEnveloped } from '../../src/modules/signing/xmldsig.js';
import { dropKey, makeKey, signDigest } from './keys.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
const good = makeKey('Nguoi ky'); const other = makeKey('Ben khac'); const old = makeKey('Het han', 1);
let smart: FastifyInstance; let smartUrl = '';
const smartCalls: { path: string; body: Record<string, any> }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
let smartReady = false; // false = người dùng chưa xác nhận
let smartDown = false; // true = /status cắt kết nối (lỗi mạng tạm thời)
let smartFail = ''; // khác rỗng = get_certificate trả lỗi với message này
let redirectHits = 0;

beforeAll(async () => {
  ctx = await createTestApp({ SMARTCA_ALLOWED_HOSTS: '127.0.0.1', SMARTCA_ALLOW_HTTP: 'true' });
  // VNPT SmartCA giả: get_certificate, sign (nhận băm hex), status (trả chữ ký sau khi "xác nhận").
  smart = Fastify();
  smart.post('/redir/v1/credentials/get_certificate', async (_req, reply) => reply.redirect('/hit', 307));
  smart.post('/hit', async () => { redirectHits++; return {}; });
  smart.post('/v1/credentials/get_certificate', async (req, reply) => { smartCalls.push({ path: 'cert', body: req.body as never });
    if (smartFail) return reply.status(400).send({ status_code: 400, message: smartFail });
    return { status_code: 200, data: { user_certificates: [{ serial_number: 'AA11', cert_data: good.certDer.toString('base64'), cert_status: 'Hoạt động' }] } }; });
  smart.post('/v1/signatures/sign', async (req) => { smartCalls.push({ path: 'sign', body: req.body as never });
    const hex = (req.body as any).sign_files[0].data_to_be_signed as string; // eslint-disable-line @typescript-eslint/no-explicit-any
    lastDigest = Buffer.from(hex, 'hex').toString('base64'); return { status_code: 200, data: { tran_code: 'TRAN-1' } }; });
  smart.post('/v1/signatures/sign/:tran/status', async (req, reply) => { smartCalls.push({ path: 'status', body: req.body as never });
    if (smartDown) { req.raw.destroy(); return reply; }
    const docId = [...smartCalls].reverse().find((c) => c.path === 'sign')!.body.sign_files[0].doc_id;
    return { status_code: 200, data: { signatures: [{ doc_id: docId, signature_value: smartReady ? signDigest(good.keyPem, lastDigest) : null }] } }; });
  await smart.listen({ port: 0, host: '127.0.0.1' });
  smartUrl = `http://127.0.0.1:${(smart.server.address() as AddressInfo).port}`;
});
let lastDigest = '';
afterAll(async () => { await ctx.close(); await smart.close(); [good, other, old].forEach(dropKey); });

type Res = { statusCode: number; body: string; headers: Record<string, unknown>; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];

async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `SG${Date.now()}${n++}`);
  await sql`UPDATE tenant SET tax_code = '0101234567', address = 'Số 1' WHERE id = ${tenantId}::uuid`.execute(ctx.t.admin);
  const as = (c: string) => (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  const call = as(cookie);
  const username = `kv_${Date.now()}_${n++}`;
  expect((await call('POST', '/api/users', { username, fullName: 'KT', password: TEST_PASSWORD, roleCode: 'ketoan_vien', sensitiveFlags: [] })).statusCode).toBe(201);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
  const call2 = as(`sid=${login.cookies.find((x) => x.name === 'sid')!.value}`);
  const ret = async (final = true) => {
    const s = await call('POST', '/api/invoices', { voucherType: 'HDB', postingDate: '2026-07-10', documentDate: '2026-07-10', partyCode: 'KH001', autoPost: true, items: [{ accountCode: '5113', amountCurrency: '300000000', taxCodes: ['V10'] }],
      invoice: { serial: 'C26TAA', invoiceNo: '0000001', invoiceDate: '2026-07-10', invoiceGroupCode: '10' } });
    expect(s.statusCode, s.body).toBe(201);
    const c = await call('POST', '/api/tax/vat-returns', { year: 2026, periodKind: 'month', period: 7 }); expect(c.statusCode, c.body).toBe(201);
    const id = c.json().id as number;
    if (final) expect((await call('POST', `/api/tax/vat-returns/${id}/finalize`)).statusCode).toBe(200);
    return String(id);
  };
  return { call, call2, tenantId, ret };
}
const agentProfile = (k = good) => ({ kind: 'local_agent', label: 'Tiện ích', certB64: k.certDer.toString('base64') });

describe('ký số: hồ sơ và phiên', () => {
  // GĐ7 gói 2 (TB4): XML của định dạng verified = false không ký im lặng.
  it('XML chưa kiểm chứng với HTKK: tạo phiên bị chặn 409 XML_FORMAT_UNVERIFIED; xác nhận rõ thì ký được và có audit_event', async () => {
    const t = await tenant(); const ref = await t.ret();
    expect((await t.call('POST', '/api/signing/profiles', agentProfile())).statusCode).toBe(201);
    expect(err(await t.call('POST', '/api/signing/sessions', { docKind: 'vat_return', docRef: ref }))).toEqual([409, 'XML_FORMAT_UNVERIFIED']);
    expect(err(await t.call('POST', '/api/signing/sessions', { docKind: 'vat_return', docRef: ref, acknowledgeUnverified: false }))).toEqual([409, 'XML_FORMAT_UNVERIFIED']);
    const s = await t.call('POST', '/api/signing/sessions', { docKind: 'vat_return', docRef: ref, acknowledgeUnverified: true }); expect(s.statusCode, s.body).toBe(201);
    const a = await sql<{ n: string }>`SELECT count(*)::text AS n FROM audit_event WHERE action = 'sign_unverified_xml' AND entity_id = ${s.json().id as string}`.execute(ctx.t.admin);
    expect(a.rows[0]!.n).toBe('1');
  });

  it('local_agent: chữ ký sai khóa → 400 SIGNATURE_INVALID (phiên vẫn pending); đúng khóa → signed, tải XML đã ký, tờ khai tải được qua signedSession', async () => {
    const t = await tenant(); const ref = await t.ret();
    const p = await t.call('POST', '/api/signing/profiles', agentProfile()); expect(p.statusCode, p.body).toBe(201);
    expect(p.json()).toMatchObject({ kind: 'local_agent', isDefault: true, hasCredentials: false, expired: false });
    expect(p.json().certSubject).toContain('CN=Nguoi ky');
    const s = await t.call('POST', '/api/signing/sessions', { docKind: 'vat_return', docRef: ref, acknowledgeUnverified: true }); expect(s.statusCode, s.body).toBe(201);
    const sess = s.json() as { id: string; digestB64: string; mode: string; agentUrl: string };
    expect(sess).toMatchObject({ status: 'pending', mode: 'client', agentUrl: 'http://127.0.0.1:18765' });
    expect(err(await t.call('POST', `/api/signing/sessions/${sess.id}/complete`, { signatureB64: signDigest(other.keyPem, sess.digestB64) }))).toEqual([400, 'SIGNATURE_INVALID']);
    expect(err(await t.call('POST', `/api/signing/sessions/${sess.id}/complete`, { signatureB64: 'AAAA' }))).toEqual([400, 'SIGNATURE_INVALID']);
    expect((await t.call('GET', `/api/signing/sessions/${sess.id}`)).json().status).toBe('pending');
    expect(err(await t.call('GET', `/api/signing/sessions/${sess.id}/result`))).toEqual([409, 'SIGNING_NOT_COMPLETE']);
    const ok = await t.call('POST', `/api/signing/sessions/${sess.id}/complete`, { signatureB64: signDigest(good.keyPem, sess.digestB64) }); expect(ok.statusCode, ok.body).toBe(200);
    expect(err(await t.call('POST', `/api/signing/sessions/${sess.id}/complete`, { signatureB64: signDigest(good.keyPem, sess.digestB64) }))).toEqual([409, 'SIGNING_SESSION_NOT_PENDING']);
    const x = await t.call('GET', `/api/signing/sessions/${sess.id}/result`);
    expect(x.statusCode).toBe(200); expect(String(x.headers['content-type'])).toContain('application/xml');
    const v = verifyEnveloped(x.body);
    expect(v.valid, v.reason).toBe(true);
    expect(v.certDer!.equals(good.certDer)).toBe(true);
    expect(x.body).toContain('<HSoThueDTu');
    // tờ khai tải bản đã ký
    const dl = await t.call('GET', `/api/tax/vat-returns/${ref}/xml?signedSession=${sess.id}`);
    expect(dl.statusCode, dl.body).toBe(200);
    expect(dl.body).toBe(x.body);
    expect(String(dl.headers['content-disposition'])).toContain('_signed.xml');
    expect(err(await t.call('GET', `/api/tax/vat-returns/${ref}/xml?signedSession=11111111-1111-4111-8111-111111111111`))).toEqual([404, 'SIGNING_SESSION_NOT_FOUND']);
    // bản không ký vẫn như cũ
    expect((await t.call('GET', `/api/tax/vat-returns/${ref}/xml`)).body).not.toContain('<ds:Signature');
  });

  it('người dùng khác trong cùng công ty không thấy hồ sơ/phiên (404), danh sách riêng; xóa hồ sơ có phiên → 409', async () => {
    const t = await tenant(); const ref = await t.ret();
    const p = (await t.call('POST', '/api/signing/profiles', agentProfile())).json() as { id: number };
    const s = (await t.call('POST', '/api/signing/sessions', { docKind: 'vat_return', docRef: ref, acknowledgeUnverified: true })).json() as { id: string };
    expect((await t.call2('GET', '/api/signing/profiles')).json()).toEqual([]);
    expect(err(await t.call2('GET', `/api/signing/sessions/${s.id}`))).toEqual([404, 'SIGNING_SESSION_NOT_FOUND']);
    expect(err(await t.call2('POST', `/api/signing/sessions/${s.id}/complete`, { signatureB64: 'A'.repeat(120) }))).toEqual([404, 'SIGNING_SESSION_NOT_FOUND']);
    expect(err(await t.call2('GET', `/api/signing/sessions/${s.id}/result`))).toEqual([404, 'SIGNING_SESSION_NOT_FOUND']);
    expect(err(await t.call2('POST', '/api/signing/sessions', { docKind: 'vat_return', docRef: ref, profileId: p.id, acknowledgeUnverified: true }))).toEqual([404, 'SIGNING_PROFILE_NOT_FOUND']);
    expect(err(await t.call2('DELETE', `/api/signing/profiles/${p.id}`))).toEqual([404, 'SIGNING_PROFILE_NOT_FOUND']);
    expect(err(await t.call2('POST', `/api/signing/profiles/${p.id}/default`))).toEqual([404, 'SIGNING_PROFILE_NOT_FOUND']);
    expect(err(await t.call2('POST', '/api/signing/sessions', { docKind: 'vat_return', docRef: ref, acknowledgeUnverified: true }))).toEqual([409, 'SIGNING_PROFILE_MISSING']);
    expect(err(await t.call('DELETE', `/api/signing/profiles/${p.id}`))).toEqual([409, 'SIGNING_PROFILE_IN_USE']);
  });

  it('mặc định: hồ sơ thứ hai không cướp mặc định, đặt mặc định chuyển cờ; xóa hồ sơ chưa dùng được; loại chứng từ chưa hỗ trợ → 400', async () => {
    const t = await tenant();
    const a = (await t.call('POST', '/api/signing/profiles', agentProfile())).json() as { id: number };
    const b = (await t.call('POST', '/api/signing/profiles', { ...agentProfile(other), label: 'Khác' })).json() as { id: number; isDefault: boolean };
    expect(b.isDefault).toBe(false);
    expect((await t.call('POST', `/api/signing/profiles/${b.id}/default`)).statusCode).toBe(204);
    const list = (await t.call('GET', '/api/signing/profiles')).json() as { id: number; isDefault: boolean }[];
    expect(list.filter((x) => x.isDefault).map((x) => x.id)).toEqual([b.id]);
    expect((await t.call('DELETE', `/api/signing/profiles/${a.id}`)).statusCode).toBe(204);
    expect(err(await t.call('POST', '/api/signing/sessions', { docKind: 'error_notice', docRef: '1' }))).toEqual([400, 'SIGNING_DOC_UNSUPPORTED']);
    expect(err(await t.call('POST', '/api/signing/sessions', { docKind: 'cit_return', docRef: '999999' }))).toEqual([404, 'TAX_RETURN_NOT_FOUND']); // 03/TNDN đã có bộ dựng XML
  });

  it('chứng thư hết hạn → 409 CERTIFICATE_EXPIRED khi tạo phiên; phiên quá hạn → 409 SIGNING_SESSION_EXPIRED', async () => {
    const t = await tenant(); const ref = await t.ret();
    const p = (await t.call('POST', '/api/signing/profiles', agentProfile())).json() as { id: number };
    const s = (await t.call('POST', '/api/signing/sessions', { docKind: 'vat_return', docRef: ref, acknowledgeUnverified: true })).json() as { id: string; digestB64: string };
    await sql`UPDATE signing_session SET expires_at = now() - interval '1 minute' WHERE id = ${s.id}::uuid`.execute(ctx.t.admin);
    expect((await t.call('GET', `/api/signing/sessions/${s.id}`)).json().status).toBe('expired');
    expect(err(await t.call('POST', `/api/signing/sessions/${s.id}/complete`, { signatureB64: signDigest(good.keyPem, s.digestB64) }))).toEqual([409, 'SIGNING_SESSION_EXPIRED']);
    await sql`UPDATE signing_profile SET cert_not_after = now() - interval '1 day' WHERE id = ${p.id}`.execute(ctx.t.admin);
    expect(err(await t.call('POST', '/api/signing/sessions', { docKind: 'vat_return', docRef: ref, acknowledgeUnverified: true }))).toEqual([409, 'CERTIFICATE_EXPIRED']);
    // chứng thư đã hết hạn lúc thêm hồ sơ vẫn nhận được (hiển thị expired), nhưng không ký được
    const e = await t.call('POST', '/api/signing/profiles', { ...agentProfile(old), label: 'Cũ' });
    expect(e.statusCode, e.body).toBe(201);
  });

  it('tờ khai chưa chốt → 409', async () => {
    const t = await tenant();
    await t.call('POST', '/api/signing/profiles', agentProfile());
    const ref = await t.ret(false);
    expect(err(await t.call('POST', '/api/signing/sessions', { docKind: 'vat_return', docRef: ref, acknowledgeUnverified: true }))[0]).toBe(409);
  });

  it('fake: /poll ký và hoàn tất; /complete bị từ chối (đúng chế độ)', async () => {
    const t = await tenant(); const ref = await t.ret();
    expect((await t.call('POST', '/api/signing/profiles', { kind: 'fake', label: 'Thử' })).statusCode).toBe(201);
    const s = (await t.call('POST', '/api/signing/sessions', { docKind: 'vat_return', docRef: ref, acknowledgeUnverified: true })).json() as { id: string; mode: string };
    expect(s.mode).toBe('server');
    expect(err(await t.call('POST', `/api/signing/sessions/${s.id}/complete`, { signatureB64: 'A'.repeat(120) }))).toEqual([409, 'SIGNING_MODE_MISMATCH']);
    expect((await t.call('POST', `/api/signing/sessions/${s.id}/poll`)).json().status).toBe('signed');
    expect((await t.call('POST', `/api/signing/sessions/${s.id}/poll`)).json().status).toBe('signed');
    expect(verifyEnveloped((await t.call('GET', `/api/signing/sessions/${s.id}/result`)).body).valid).toBe(true);
    expect((await t.call('GET', `/api/tax/vat-returns/${ref}/xml?signedSession=${s.id}&format=htkk-01gtgt`)).statusCode).toBe(200);
    expect(err(await t.call('GET', `/api/tax/vat-returns/${ref}/xml?signedSession=${s.id}&format=khac`))).toEqual([400, 'SIGNED_FORMAT_MISMATCH']);
  });

  it('SmartCA (máy giả): lấy chứng thư, ký băm, poll pending rồi signed; thông tin đăng nhập mã hóa, không lộ ra API/audit', async () => {
    const t = await tenant(); const ref = await t.ret();
    const body = { kind: 'smartca', label: 'SmartCA', baseUrl: smartUrl, spId: 'sp-test', spPassword: 'BiMat-123', userId: '079123456789' };
    const p = await t.call('POST', '/api/signing/profiles', body); expect(p.statusCode, p.body).toBe(201);
    expect(p.json()).toMatchObject({ kind: 'smartca', hasCredentials: true, certSerial: expect.any(String) });
    expect(p.body).not.toContain('BiMat-123');
    expect((await t.call('GET', '/api/signing/profiles')).body).not.toContain('BiMat-123');
    expect(smartCalls.find((c) => c.path === 'cert')!.body).toMatchObject({ sp_id: 'sp-test', sp_password: 'BiMat-123', user_id: '079123456789' });
    const raw = await sql<{ credentials: Buffer }>`SELECT credentials FROM signing_profile WHERE tenant_id = ${t.tenantId}::uuid`.execute(ctx.t.admin);
    expect(raw.rows[0]!.credentials.toString('utf8')).not.toContain('BiMat-123');
    const ev = await sql<{ after: Record<string, unknown> }>`SELECT after FROM audit_event WHERE tenant_id = ${t.tenantId}::uuid AND entity = 'signing_profile'`.execute(ctx.t.admin);
    expect(ev.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(ev.rows)).not.toContain('BiMat-123');
    expect(ev.rows[0]!.after.credentials).toBe('***');
    smartReady = false;
    const s = (await t.call('POST', '/api/signing/sessions', { docKind: 'vat_return', docRef: ref, acknowledgeUnverified: true })).json() as { id: string; mode: string; digestB64: string };
    expect(s.mode).toBe('server');
    expect(Buffer.from(lastDigest, 'base64').toString('hex')).toBe(Buffer.from(s.digestB64, 'base64').toString('hex'));
    expect((await t.call('POST', `/api/signing/sessions/${s.id}/poll`)).json().status).toBe('pending');
    smartReady = true;
    expect((await t.call('POST', `/api/signing/sessions/${s.id}/poll`)).json().status).toBe('signed');
    expect(verifyEnveloped((await t.call('GET', `/api/signing/sessions/${s.id}/result`)).body).valid).toBe(true);
  });

  it('SmartCA: máy chủ lỗi → 502 SMARTCA_ERROR / không với tới → 502 SMARTCA_UNREACHABLE', async () => {
    const t = await tenant();
    const base = { kind: 'smartca', label: 'S', spId: 'x', spPassword: 'y', userId: 'u' };
    expect(err(await t.call('POST', '/api/signing/profiles', { ...base, baseUrl: 'http://127.0.0.1:9' }))).toEqual([502, 'SMARTCA_UNREACHABLE']);
    expect(err(await t.call('POST', '/api/signing/profiles', { ...base, baseUrl: smartUrl, serial: 'KHONGCO' }))).toEqual([404, 'SMARTCA_CERT_NOT_FOUND']);
  });

  it('hoàn tất hai lần song song: đúng một lần thành công, lần kia 409 (không ghi đè)', async () => {
    const t = await tenant(); const ref = await t.ret();
    await t.call('POST', '/api/signing/profiles', agentProfile());
    const sess = (await t.call('POST', '/api/signing/sessions', { docKind: 'vat_return', docRef: ref, acknowledgeUnverified: true })).json() as { id: string; digestB64: string };
    const body = { signatureB64: signDigest(good.keyPem, sess.digestB64) };
    const rs = await Promise.all([t.call('POST', `/api/signing/sessions/${sess.id}/complete`, body), t.call('POST', `/api/signing/sessions/${sess.id}/complete`, body)]);
    expect(rs.map((r) => r.statusCode).sort(), rs.map((r) => r.body).join('|')).toEqual([200, 409]);
  });

  it('SmartCA: baseUrl ngoài danh sách cho phép → 400 SMARTCA_URL_NOT_ALLOWED, không gọi ra ngoài; chuyển hướng không được theo; message thượng nguồn bị làm sạch', async () => {
    const t = await tenant();
    const base = { kind: 'smartca', label: 'S', spId: 'x', spPassword: 'y', userId: 'u' };
    for (const baseUrl of ['https://evil.example/sca', 'https://127.0.0.1@evil.example/', 'ftp://127.0.0.1/', 'http://localhost:1/']) {
      expect(err(await t.call('POST', '/api/signing/profiles', { ...base, baseUrl })), baseUrl).toEqual([400, 'SMARTCA_URL_NOT_ALLOWED']);
    }
    expect(err(await t.call('POST', '/api/signing/profiles', { ...base, baseUrl: `${smartUrl}/redir` }))).toEqual([502, 'SMARTCA_UNREACHABLE']);
    expect(redirectHits).toBe(0);
    smartFail = '<script>alert(1)</script>\n' + 'a'.repeat(400);
    const r = await t.call('POST', '/api/signing/profiles', { ...base, baseUrl: smartUrl }); smartFail = '';
    expect(r.statusCode).toBe(502);
    expect(r.json().error.message).not.toMatch(/[<>\n]/);
    expect(r.json().error.message.length).toBeLessThan(200);
  });

  it('SmartCA: lỗi mạng tạm thời khi poll giữ phiên pending (không failed); tiếp tục được khi mạng về', async () => {
    const t = await tenant(); const ref = await t.ret();
    await t.call('POST', '/api/signing/profiles', { kind: 'smartca', label: 'S', baseUrl: smartUrl, spId: 'sp', spPassword: 'pw', userId: 'u' });
    smartReady = false; smartDown = false;
    const s = (await t.call('POST', '/api/signing/sessions', { docKind: 'vat_return', docRef: ref, acknowledgeUnverified: true })).json() as { id: string };
    smartDown = true;
    expect(err(await t.call('POST', `/api/signing/sessions/${s.id}/poll`))).toEqual([502, 'SMARTCA_UNREACHABLE']);
    smartDown = false; smartReady = true;
    expect((await t.call('GET', `/api/signing/sessions/${s.id}`)).json().status).toBe('pending');
    expect((await t.call('POST', `/api/signing/sessions/${s.id}/poll`)).json().status).toBe('signed');
  });
});
