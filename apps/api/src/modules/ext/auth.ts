import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { withTenant } from '@kt/db';
import type { AuthCtx } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import type { FastifyInstance } from 'fastify';
import { hashKey, KEY_RE, scopePermissions } from './apiKeys.js';
import { loadBranchScope } from '../branch/scope.js';

export interface ApiKeyCtx { id: string; name: string; scopes: string[]; postSales: boolean; defaultWarehouseCode: string | null }
declare module 'fastify' { interface FastifyRequest { apiKey: ApiKeyCtx | null } }

// Mọi lỗi xác thực (thiếu, sai định dạng, không có, sai khóa, thu hồi, hết hạn, người dùng bị tắt) trả cùng một thân phản hồi: không lộ khóa hay công ty có tồn tại hay không.
const unauthorized = () => new AppError('UNAUTHORIZED', 'Khóa API không hợp lệ', 401);
const DUMMY_HASH = Buffer.from(hashKey('kt_dummy'), 'hex'); // so sánh vẫn chạy khi tiền tố không tồn tại
const safeEqualHex = (a: string, b: Buffer) => { const x = Buffer.from(a, 'hex'); return x.length === b.length && timingSafeEqual(x, b); };

const LIMIT_PER_MIN = 60;
const WINDOW_MS = 60_000;
// shortcut: in-memory, per process. Chạy nhiều tiến trình API thì mỗi tiến trình đếm riêng; chuyển sang bảng đếm dùng chung (Redis/PostgreSQL) khi cần giới hạn chính xác.
const hits = new Map<string, { start: number; count: number }>();
const lastTouch = new Map<string, number>();

export function rateLimit(keyId: string, now = Date.now()): void {
  const h = hits.get(keyId);
  if (!h || now - h.start >= WINDOW_MS) { hits.set(keyId, { start: now, count: 1 }); return; }
  if (h.count >= LIMIT_PER_MIN) throw new AppError('RATE_LIMITED', 'Vượt quá 60 yêu cầu mỗi phút cho khóa API này, thử lại sau', 429);
  h.count += 1;
}

export function extAuthHook(app: FastifyInstance) {
  return async (req: FastifyRequest): Promise<void> => {
    req.auth = null; // phiên cookie không thay được khóa trên đường API ngoài
    req.apiKey = null;
    const m = /^Bearer (\S+)$/.exec(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    const parts = m ? KEY_RE.exec(m[1]!) : null;
    if (!m || !parts) throw unauthorized();
    const found = (await sql<{ id: string; tenant_id: string; user_id: string; key_hash: string; revoked_at: Date | null; expires_at: Date | null }>`SELECT * FROM fn_api_key_lookup(${parts[1]!})`.execute(app.db)).rows[0];
    const hashOk = safeEqualHex(hashKey(m[1]!), found ? Buffer.from(found.key_hash, 'hex') : DUMMY_HASH);
    if (!found || !hashOk || found.revoked_at || (found.expires_at && new Date(found.expires_at).getTime() <= Date.now())) throw unauthorized();

    const ctx = await withTenant(app.db, { tenantId: found.tenant_id, userId: found.user_id, ip: req.ip }, async (trx) => {
      const k = await trx.selectFrom('api_key as k').leftJoin('warehouse as w', (j) => j.onRef('w.tenant_id', '=', 'k.tenant_id').onRef('w.id', '=', 'k.default_warehouse_id'))
        .select(['k.name', 'k.scopes', 'k.post_sales', 'w.code as wh_code']).where('k.id', '=', found.id).where('k.revoked_at', 'is', null).executeTakeFirst();
      const u = await trx.selectFrom('app_user').select(['username', 'is_active']).where('id', '=', found.user_id).executeTakeFirst();
      const tu = await trx.selectFrom('tenant_user').select(['role_id', 'sensitive_flags', 'is_active']).where('tenant_id', '=', found.tenant_id).where('user_id', '=', found.user_id).executeTakeFirst();
      if (!k || !u?.is_active || !tu?.is_active) return null;
      const rolePerms = await trx.selectFrom('role_permission').select('permission_code').where('role_id', '=', tu.role_id).execute();
      const allowed = scopePermissions(k.scopes, k.post_sales);
      const now = Date.now();
      if (now - (lastTouch.get(found.id) ?? 0) >= WINDOW_MS) { // last_used_at tối đa mỗi phút
        await trx.updateTable('api_key').set({ last_used_at: new Date(now).toISOString() }).where('id', '=', found.id).execute();
        lastTouch.set(found.id, now);
      }
      const auth: AuthCtx = { sessionId: `ext:${found.id}`, userId: found.user_id, username: u.username, tenantId: found.tenant_id,
        permissions: new Set(rolePerms.map((p) => p.permission_code).filter((p) => allowed.has(p))), sensitive: new Set(tu.sensitive_flags as string[]) };
      Object.assign(auth, await loadBranchScope(trx, found.tenant_id, found.user_id, auth.permissions)); // khóa API mang phạm vi chi nhánh của người dùng tạo khóa
      return { auth, key: { id: found.id, name: k.name, scopes: k.scopes, postSales: k.post_sales, defaultWarehouseCode: k.wh_code } satisfies ApiKeyCtx };
    });
    if (!ctx) throw unauthorized();
    rateLimit(found.id);
    req.auth = ctx.auth;
    req.apiKey = ctx.key;
  };
}

// Phạm vi của khóa và quyền hiệu lực (vai trò hiện hành ∩ phạm vi) đều phải có.
export const need = (scope: string, perm: string) => async (req: FastifyRequest): Promise<void> => {
  if (!req.apiKey?.scopes.includes(scope)) throw new AppError('SCOPE_FORBIDDEN', `Khóa API không có phạm vi ${scope}`, 403);
  if (!req.auth?.permissions.has(perm)) throw new AppError('FORBIDDEN', `Người dùng của khóa không còn quyền ${perm}`, 403);
};
