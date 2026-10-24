import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { sql, type Transaction } from 'kysely';
import { withTenant, type Database } from '@kt/db';
import { openSecret } from '../../lib/secretBox.js';

// Webhook công khai SePay / Casso. Không qua requireAuth: danh tính là mã trong URL, đối chiếu thêm chữ ký HMAC hoặc khóa API (docs/dev/tich-hop/ngan-hang.md §1, §2).
// Chỉ nhận JSON. Thân thô giữ nguyên bytes để SePay ký; parser thân thô chỉ gắn trong plugin này.
type Trx = Transaction<Database>;
export const WEBHOOK_BODY_LIMIT = 256 * 1024;
const WINDOW_SEC = 300;

export const sha256Hex = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
const hdr = (h: Record<string, unknown>, k: string): string | null => (typeof h[k] === 'string' ? (h[k] as string) : null);

interface FeedRow { id: number; provider: string; auth_kind: string; secret: Buffer | null; apikey_hash: string | null; bank_account_id: number; account_no: string }

const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;

// Trả null khi hợp lệ, hoặc lý do (chỉ để ghi log; phản hồi ra ngoài luôn giống nhau).
export function verifyWebhook(feed: Pick<FeedRow, 'provider' | 'auth_kind' | 'secret' | 'apikey_hash'>, headers: Record<string, unknown>, raw: Buffer, nowMs = Date.now()): string | null {
  if (feed.auth_kind === 'apikey') {
    const given = feed.provider === 'sepay' ? /^Apikey (\S+)$/.exec(hdr(headers, 'authorization') ?? '')?.[1] : hdr(headers, 'secure-token');
    if (!given || !feed.apikey_hash) return 'APIKEY_MISSING';
    return safeEqual(Buffer.from(sha256Hex(given), 'hex'), Buffer.from(feed.apikey_hash, 'hex')) ? null : 'APIKEY_MISMATCH';
  }
  if (!feed.secret) return 'NO_SECRET';
  const secret = openSecret(feed.secret);
  if (feed.provider === 'sepay') {
    const sig = /^sha256=([0-9a-f]{64})$/i.exec(hdr(headers, 'x-sepay-signature') ?? '');
    const ts = /^\d{1,12}$/.exec(hdr(headers, 'x-sepay-timestamp') ?? '');
    if (!sig || !ts) return 'SIGNATURE_MALFORMED';
    if (Math.abs(nowMs / 1000 - Number(ts[0])) > WINDOW_SEC) return 'TIMESTAMP_SKEW';
    const want = createHmac('sha256', secret).update(`${ts[0]}.`).update(raw).digest();
    return safeEqual(want, Buffer.from(sig[1]!, 'hex')) ? null : 'SIGNATURE_MISMATCH';
  }
  const sig = /^t=(\d{1,15}),v1=([0-9a-f]{128})$/i.exec(hdr(headers, 'x-casso-signature') ?? '');
  if (!sig) return 'SIGNATURE_MALFORMED';
  if (Math.abs(nowMs - Number(sig[1])) > WINDOW_SEC * 1000) return 'TIMESTAMP_SKEW';
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { return 'BODY_NOT_JSON'; }
  const want = createHmac('sha512', secret).update(`${sig[1]}.${JSON.stringify(sortKeys(parsed))}`).digest(); // JSON gọn, khóa sắp xếp đệ quy (mã mẫu Casso)
  return safeEqual(want, Buffer.from(sig[2]!, 'hex')) ? null : 'SIGNATURE_MISMATCH';
}

class BadPayload extends Error {}
export interface MappedTxn { externalId: string; txnTime: string; valueDate: string; amountIn: string; amountOut: string; balanceAfter: string | null; description: string | null; reference: string | null;
  counterAccount: string | null; counterName: string | null; paymentCode: string | null; accountNo: string | null; raw: unknown }

// Bỏ \u0000: PostgreSQL không lưu được NUL trong text/jsonb.
const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.replaceAll('\u0000', '').trim() ? v.replaceAll('\u0000', '').trim().slice(0, max) : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : null);
// Tiền trong JSON là số nguyên: chuyển qua chuỗi thập phân, không tính toán bằng number.
function intStr(v: unknown, what: string): string {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  if (typeof v === 'string' && /^-?\d{1,16}$/.test(v)) return v.replace(/^(-?)0+(?=\d)/, '$1');
  throw new BadPayload(`${what} không phải số nguyên hợp lệ`);
}
function vnTime(v: unknown): { txnTime: string; valueDate: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(typeof v === 'string' ? v.trim() : '');
  if (!m) throw new BadPayload('Ngày giờ giao dịch sai định dạng YYYY-MM-DD HH:mm:ss');
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) throw new BadPayload('Ngày giờ giao dịch không tồn tại');
  return { valueDate: `${m[1]}-${m[2]}-${m[3]}`, txnTime: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+07:00` };
}
const obj = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BadPayload('Nội dung không phải đối tượng JSON'); return v as Record<string, unknown>; };
const requireId = (v: unknown) => { const id = str(v, 100); if (!id) throw new BadPayload('Thiếu id giao dịch'); return id; };

export function mapSepay(payload: unknown): MappedTxn[] {
  const p = obj(payload);
  const amt = intStr(p.transferAmount, 'transferAmount');
  if (!/^[1-9]\d*$/.test(amt)) throw new BadPayload('transferAmount phải là số nguyên dương');
  if (p.transferType !== 'in' && p.transferType !== 'out') throw new BadPayload('transferType phải là in hoặc out');
  const acc = p.accumulated === undefined || p.accumulated === null ? '0' : intStr(p.accumulated, 'accumulated');
  return [{ externalId: requireId(p.id), ...vnTime(p.transactionDate), amountIn: p.transferType === 'in' ? amt : '0', amountOut: p.transferType === 'out' ? amt : '0',
    balanceAfter: acc === '0' ? null : acc, // 0 = ngân hàng không cung cấp số dư
    description: str(p.content, 1000) ?? str(p.description, 1000), reference: str(p.referenceCode), counterAccount: null, counterName: null, paymentCode: str(p.code), accountNo: str(p.accountNumber), raw: p }];
}

// Casso: V2 `data` là đối tượng, v1 là mảng. Tiền ra là số âm (tài liệu không nêu; xem quyết định T13), vào là số dương.
export function mapCasso(payload: unknown): MappedTxn[] {
  const root = obj(payload);
  if (root.error !== undefined && root.error !== null && root.error !== 0 && root.error !== '0') throw new BadPayload('Casso báo lỗi (error khác 0)');
  const items = Array.isArray(root.data) ? root.data : [root.data];
  if (items.length === 0 || items.length > 100) throw new BadPayload('data rỗng hoặc quá nhiều giao dịch');
  return items.map((it) => {
    const p = obj(it);
    const amt = intStr(p.amount, 'amount');
    if (!/^-?[1-9]\d*$/.test(amt)) throw new BadPayload('amount phải là số nguyên khác 0');
    const out = amt.startsWith('-');
    const bal = p.runningBalance ?? p.cusum_balance;
    return { externalId: requireId(p.id), ...vnTime(p.transactionDateTime ?? p.when), amountIn: out ? '0' : amt, amountOut: out ? amt.slice(1) : '0',
      balanceAfter: bal === undefined || bal === null ? null : intStr(bal, 'số dư'), description: str(p.description, 1000), reference: str(p.reference) ?? str(p.tid),
      counterAccount: str(p.counterAccountNumber) ?? str(p.corresponsiveAccount), counterName: str(p.counterAccountName) ?? str(p.corresponsiveName), paymentCode: null,
      accountNo: str(p.accountNumber) ?? str(p.bank_sub_acc_id) ?? str(p.subAccId), raw: p };
  });
}

// Số tài khoản so khớp bỏ dấu cách, gạch nối; không phân biệt hoa thường.
export const normAcc = (x: string | null) => (x ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();

const deny = (reply: { status(n: number): { send(b: unknown): unknown } }) => reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Không xác thực được yêu cầu webhook' } });

const logRow = (trx: Trx, tenantId: string, feedId: number, ok: boolean, status: number, error: string | null, sha: string) =>
  trx.insertInto('bank_webhook_log').values({ tenant_id: tenantId, feed_id: feedId, ok, http_status: status, error, body_sha256: sha }).execute();

const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser(['application/json', '*'], { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT }, (_req, body, done) => done(null, body));

  app.post<{ Params: { token: string } }>('/api/hooks/bank/:token', { bodyLimit: WEBHOOK_BODY_LIMIT }, async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const sha = sha256Hex(raw);
    const hit = (await sql<{ tenant_id: string; feed_id: number }>`SELECT tenant_id, feed_id FROM fn_bank_feed_by_token(${sha256Hex(req.params.token)})`.execute(app.db)).rows[0];
    if (!hit) return deny(reply);
    const r = await withTenant(app.db, { tenantId: hit.tenant_id, ip: req.ip }, async (trx) => {
      const feed = await trx.selectFrom('bank_feed as f').innerJoin('bank_account as a', (j) => j.onRef('a.id', '=', 'f.bank_account_id').onRef('a.tenant_id', '=', 'f.tenant_id'))
        .select(['f.id', 'f.provider', 'f.auth_kind', 'f.secret', 'f.apikey_hash', 'f.bank_account_id', 'a.account_no']).where('f.id', '=', hit.feed_id).executeTakeFirst();
      if (!feed) return { status: 401 as const };
      let bad: string | null;
      try { bad = verifyWebhook(feed, req.headers, raw); } catch { bad = 'VERIFY_ERROR'; }
      if (bad) { await logRow(trx, hit.tenant_id, feed.id, false, 401, bad, sha); return { status: 401 as const }; }
      let mapped: MappedTxn[];
      try {
        const payload: unknown = JSON.parse(raw.toString('utf8'));
        mapped = feed.provider === 'sepay' ? mapSepay(payload) : mapCasso(payload);
      } catch (e) {
        const msg = e instanceof BadPayload ? e.message : 'Nội dung không phải JSON hợp lệ';
        await logRow(trx, hit.tenant_id, feed.id, false, 400, `BAD_PAYLOAD: ${msg}`, sha);
        return { status: 400 as const, message: msg };
      }
      let mismatch = false;
      for (const m of mapped) {
        if (!m.accountNo || normAcc(m.accountNo) !== normAcc(feed.account_no)) { mismatch = true; continue; } // bỏ qua nhưng vẫn báo thành công để bên gửi không gửi lại vô hạn
        await trx.insertInto('bank_transaction').values({ tenant_id: hit.tenant_id, bank_account_id: feed.bank_account_id, feed_id: feed.id, source: feed.provider, external_id: m.externalId,
          txn_time: m.txnTime, value_date: m.valueDate, amount_in: m.amountIn, amount_out: m.amountOut, balance_after: m.balanceAfter, description: m.description, reference: m.reference,
          counter_account: m.counterAccount, counter_name: m.counterName, payment_code: m.paymentCode, raw: JSON.stringify(m.raw).replaceAll('\\u0000', '') })
          .onConflict((oc) => oc.columns(['tenant_id', 'source', 'external_id']).doNothing()).execute();
      }
      await logRow(trx, hit.tenant_id, feed.id, true, 200, mismatch ? 'ACCOUNT_MISMATCH' : null, sha);
      return { status: 200 as const };
    });
    if (r.status === 401) return deny(reply);
    if (r.status === 400) return reply.status(400).send({ error: { code: 'BAD_PAYLOAD', message: r.message } });
    return reply.status(200).send({ success: true });
  });
};

export default webhookRoutes;
