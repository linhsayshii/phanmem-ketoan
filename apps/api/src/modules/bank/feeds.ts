import { randomBytes } from 'node:crypto';
import { type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { sealSecret } from '../../lib/secretBox.js';
import { sha256Hex } from './webhook.js';

type Trx = Transaction<Database>;

export const feedInput = z.object({
  bankAccountId: z.number().int().positive(), provider: z.enum(['sepay', 'casso']), authKind: z.enum(['hmac', 'apikey']),
  secret: z.string().min(8).max(200).optional(), // khóa HMAC tự đặt (phải trùng khóa cấu hình ở nhà cung cấp); bỏ trống = hệ thống sinh và trả một lần
});
export const feedUpdate = z.object({ bankAccountId: z.number().int().positive().optional(), isActive: z.boolean().optional() });

const notFound = () => new AppError('BANK_FEED_NOT_FOUND', 'Không tìm thấy kết nối ngân hàng', 404);
const newToken = () => randomBytes(32).toString('base64url');
const urlOf = (base: string, token: string) => `${base.replace(/\/+$/, '')}/api/hooks/bank/${token}`;

type FeedRow = Selectable<Database['bank_feed']>;
const dto = (r: FeedRow) => ({ id: r.id, bankAccountId: r.bank_account_id, provider: r.provider, authKind: r.auth_kind, hasSecret: r.secret !== null, hasApiKey: r.apikey_hash !== null,
  isActive: r.is_active, lastReceivedAt: r.last_received_at, createdAt: r.created_at });

export const listFeeds = async (trx: Trx) => (await trx.selectFrom('bank_feed').selectAll().orderBy('id').execute()).map(dto);

async function requireAccount(trx: Trx, id: number) {
  if (!(await trx.selectFrom('bank_account').select('id').where('id', '=', id).executeTakeFirst())) throw new AppError('BANK_ACCOUNT_NOT_FOUND', 'Không tìm thấy tài khoản ngân hàng', 404);
}

// Token, khóa API và khóa HMAC sinh ra chỉ trả đúng một lần ở đây; cơ sở dữ liệu giữ băm (token, khóa API) hoặc bản mã hóa (khóa HMAC).
export async function createFeed(trx: Trx, tenantId: string, baseUrl: string, b: z.infer<typeof feedInput>) {
  await requireAccount(trx, b.bankAccountId);
  const token = newToken();
  const apiKey = b.authKind === 'apikey' ? randomBytes(24).toString('base64url') : null;
  const generated = b.authKind === 'hmac' && !b.secret ? randomBytes(24).toString('hex') : null;
  const secret = b.authKind === 'hmac' ? b.secret ?? generated! : null;
  const row = await trx.insertInto('bank_feed').values({ tenant_id: tenantId, bank_account_id: b.bankAccountId, provider: b.provider, token_hash: sha256Hex(token), auth_kind: b.authKind,
    secret: secret ? sealSecret(secret) : null, apikey_hash: apiKey ? sha256Hex(apiKey) : null }).returningAll().executeTakeFirstOrThrow();
  return { ...dto(row), webhookUrl: urlOf(baseUrl, token), ...(apiKey && { apiKey }), ...(generated && { secret: generated }) };
}

export async function updateFeed(trx: Trx, id: number, b: z.infer<typeof feedUpdate>) {
  if (b.bankAccountId !== undefined) await requireAccount(trx, b.bankAccountId);
  const set = { ...(b.bankAccountId !== undefined && { bank_account_id: b.bankAccountId }), ...(b.isActive !== undefined && { is_active: b.isActive }) };
  const q = Object.keys(set).length ? trx.updateTable('bank_feed').set(set).where('id', '=', id) : null;
  const r = q ? await q.returningAll().executeTakeFirst() : await trx.selectFrom('bank_feed').selectAll().where('id', '=', id).executeTakeFirst();
  if (!r) throw notFound();
  return dto(r);
}

export async function rotateFeed(trx: Trx, id: number, baseUrl: string) {
  const token = newToken();
  const r = await trx.updateTable('bank_feed').set({ token_hash: sha256Hex(token) }).where('id', '=', id).returningAll().executeTakeFirst();
  if (!r) throw notFound();
  return { ...dto(r), webhookUrl: urlOf(baseUrl, token) };
}

export async function deleteFeed(trx: Trx, id: number) {
  const r = await trx.deleteFrom('bank_feed').where('id', '=', id).executeTakeFirst();
  if (!r.numDeletedRows) throw notFound();
}
