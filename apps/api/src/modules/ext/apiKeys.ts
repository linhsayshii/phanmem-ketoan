import { createHash, randomBytes } from 'node:crypto';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';

type Trx = Transaction<Database>;

export const SCOPES = ['items.read', 'stock.read', 'sales.write', 'inbound_invoice.write', 'mobile'] as const;
export type Scope = (typeof SCOPES)[number];

// Quyền của từng phạm vi (quyền hiệu lực = quyền vai trò hiện hành của người tạo ∩ các quyền này).
// sales.write cần thêm stock_voucher.create (dòng hàng ghi vào kho) và settlement.create (PT/BC đối trừ hóa đơn) ngoài voucher.create trong đặc tả; voucher.post chỉ khi khóa tự ghi sổ.
const SCOPE_PERMS: Record<Scope, string[]> = {
  'items.read': ['item.view'],
  'stock.read': ['stock_voucher.view'],
  'sales.write': ['voucher.create', 'stock_voucher.create', 'settlement.create'],
  'inbound_invoice.write': ['inbound_invoice.create'],
  // GĐ7: ứng dụng di động /api/mobile/v1 — xem báo cáo tóm tắt, duyệt đề nghị; không lập chứng từ.
  mobile: ['report.view', 'approval_request.approve'],
};
export const scopePermissions = (scopes: readonly string[], postSales: boolean): Set<string> => {
  const out = new Set<string>();
  for (const s of scopes) for (const p of SCOPE_PERMS[s as Scope] ?? []) out.add(p);
  if (postSales && scopes.includes('sales.write')) out.add('voucher.post');
  return out;
};

// Dạng khóa: kt_<12 hex tiền tố>_<64 hex bí mật>. Chỉ lưu tiền tố và SHA-256 của toàn chuỗi; hex nên dấu gạch dưới không gây nhập nhằng khi tách.
export const KEY_RE = /^kt_([0-9a-f]{12})_[0-9a-f]{64}$/;
export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');
export const generateKey = (): { key: string; prefix: string; hash: string } => {
  const prefix = randomBytes(6).toString('hex');
  const key = `kt_${prefix}_${randomBytes(32).toString('hex')}`;
  return { key, prefix, hash: hashKey(key) };
};

export const createKeyInput = z.object({
  name: z.string().trim().min(1, 'Nhập tên khóa').max(100),
  scopes: z.array(z.enum(SCOPES)).min(1, 'Chọn ít nhất một phạm vi').max(SCOPES.length),
  userId: z.string().uuid().optional(),
  defaultWarehouseCode: z.string().trim().min(1).max(50).optional(),
  postSales: z.boolean().default(false),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});
export type CreateKeyInput = z.infer<typeof createKeyInput>;

export interface ApiKeyDto {
  id: string; name: string; prefix: string; scopes: string[]; userId: string; username: string; defaultWarehouseCode: string | null; postSales: boolean;
  expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null; createdAt: string; status: 'active' | 'revoked' | 'expired';
}

export async function listApiKeys(trx: Trx): Promise<ApiKeyDto[]> {
  const rows = await trx.selectFrom('api_key as k').innerJoin('app_user as u', 'u.id', 'k.user_id')
    .leftJoin('warehouse as w', (j) => j.onRef('w.tenant_id', '=', 'k.tenant_id').onRef('w.id', '=', 'k.default_warehouse_id'))
    .select(['k.id', 'k.name', 'k.prefix', 'k.scopes', 'k.user_id', 'u.username', 'w.code as wh_code', 'k.post_sales', 'k.expires_at', 'k.revoked_at', 'k.last_used_at', 'k.created_at'])
    .orderBy('k.created_at', 'desc').execute();
  const now = Date.now();
  const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());
  return rows.map((r) => ({
    id: r.id, name: r.name, prefix: r.prefix, scopes: r.scopes, userId: r.user_id, username: r.username, defaultWarehouseCode: r.wh_code, postSales: r.post_sales,
    expiresAt: iso(r.expires_at), revokedAt: iso(r.revoked_at), lastUsedAt: iso(r.last_used_at), createdAt: iso(r.created_at)!,
    status: r.revoked_at ? 'revoked' : r.expires_at && new Date(r.expires_at).getTime() <= now ? 'expired' : 'active',
  }));
}

// Trả khóa đầy đủ đúng một lần; sau đó chỉ còn tiền tố.
export async function createApiKey(trx: Trx, ctx: { tenantId: string; userId: string }, input: CreateKeyInput): Promise<{ id: string; key: string; prefix: string }> {
  if (input.userId && input.userId !== ctx.userId) throw new AppError('FORBIDDEN', 'Chỉ được tạo khóa API cho chính mình', 403);
  if (input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now()) throw new AppError('VALIDATION', 'Ngày hết hạn phải ở tương lai', 400);
  let warehouseId: number | null = null;
  if (input.defaultWarehouseCode) {
    const w = await trx.selectFrom('warehouse').select('id').where('code', '=', input.defaultWarehouseCode).where('is_active', '=', true).executeTakeFirst();
    if (!w) throw new AppError('WAREHOUSE_NOT_FOUND', `Không có kho ${input.defaultWarehouseCode}`, 404);
    warehouseId = w.id;
  }
  const g = generateKey();
  const row = await trx.insertInto('api_key').values({
    tenant_id: ctx.tenantId, user_id: ctx.userId, name: input.name, prefix: g.prefix, key_hash: g.hash, scopes: input.scopes as string[],
    default_warehouse_id: warehouseId, post_sales: input.postSales, expires_at: input.expiresAt ?? null,
  }).returning('id').executeTakeFirstOrThrow();
  return { id: row.id, key: g.key, prefix: g.prefix };
}

export async function revokeApiKey(trx: Trx, id: string): Promise<void> {
  const k = await trx.selectFrom('api_key').select(['id', 'revoked_at']).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!k) throw new AppError('API_KEY_NOT_FOUND', 'Không tìm thấy khóa API', 404);
  if (k.revoked_at) throw new AppError('API_KEY_REVOKED', 'Khóa API đã được thu hồi', 409);
  await trx.updateTable('api_key').set({ revoked_at: new Date().toISOString() }).where('id', '=', id).execute();
}
