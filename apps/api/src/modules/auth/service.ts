import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { sql, type Kysely } from 'kysely';
import { withTenant, type Database } from '@kt/db';

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });
export const verifyPassword = (hash: string, pw: string) => argon2.verify(hash, pw).catch(() => false);

// Băm giả để đăng nhập sai tên/tài khoản bị khóa tốn thời gian như sai mật khẩu (tránh dò tên đăng nhập qua thời gian phản hồi)
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(randomUUID()));

export const hashSessionToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface LoginResult { sessionToken: string; userId: string; tenantId: string | null; tenants: { id: string; code: string; name: string }[] }

export async function login(db: Kysely<Database>, input: { username: string; password: string; ip: string; ttlHours: number; limits: { maxFailsUser: number; maxFailsUserAll: number; maxFailsIp: number; lockMinutes: number } }): Promise<LoginResult | null | 'throttled'> {
  const { maxFailsUser, maxFailsUserAll, maxFailsIp, lockMinutes } = input.limits;
  // Đếm, xác minh, ghi trong một giao dịch giữ khóa theo tên: các yêu cầu song song cùng tên xếp hàng nên không vượt ngưỡng
  const outcome = await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${'login:' + input.username.toLowerCase()}))`.execute(trx);
    // Đếm cả tên không tồn tại (không lộ tên có tồn tại); lần đúng gần nhất xóa bộ đếm theo tên.
    // Theo (tên, IP): ngưỡng thấp, người ngoài không khóa được tài khoản của người khác từ IP khác; theo tên mọi IP: ngưỡng cao; theo IP: mọi tên.
    const cnt = await sql<{ ui: string; u: string; i: string }>`
      WITH last_ok AS (SELECT coalesce(max(ts), '-infinity') AS t FROM login_event WHERE username = ${input.username} AND success),
           f AS (SELECT e.username, e.ip FROM login_event e, last_ok WHERE NOT e.success AND e.ts > now() - make_interval(mins => ${lockMinutes})
                   AND (e.username = ${input.username} OR e.ip = ${input.ip}) AND (e.username <> ${input.username} OR e.ts > last_ok.t))
      SELECT count(*) FILTER (WHERE username = ${input.username} AND ip = ${input.ip}) AS ui, count(*) FILTER (WHERE username = ${input.username}) AS u, count(*) FILTER (WHERE ip = ${input.ip}) AS i FROM f`.execute(trx);
    const c = cnt.rows[0]!;
    // Lần bị chặn không ghi login_event (route ghi log máy chủ): nếu ghi thì cứ thử tiếp là khóa kéo dài mãi
    if (Number(c.ui) >= maxFailsUser || Number(c.u) >= maxFailsUserAll || Number(c.i) >= maxFailsIp) return 'throttled' as const;
    const user = await trx.selectFrom('app_user').selectAll().where('username', '=', input.username).executeTakeFirst();
    const verified = await verifyPassword(user?.is_active ? user.password_hash : await getDummyHash(), input.password);
    const ok = verified && !!user?.is_active;
    await trx.insertInto('login_event').values({ username: input.username, user_id: user?.id ?? null, success: ok, ip: input.ip }).execute();
    return ok ? user! : null;
  });
  if (outcome === 'throttled') return 'throttled';
  const user = outcome; const ok = !!user;
  if (!user || !ok) return null;
  const tenants = await listTenantsOf(db, user.id);
  const tenantId = tenants.length === 1 ? tenants[0]!.id : null;
  const sessionToken = randomBytes(32).toString('base64url');
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('user_session').where('expires_at', '<', sql<string>`now()`).execute();
    await trx.insertInto('user_session')
      .values({ user_id: user.id, tenant_id: tenantId, ip: input.ip, token_hash: hashSessionToken(sessionToken), expires_at: sql`now() + make_interval(hours => ${input.ttlHours})` })
      .execute();
  });
  return { sessionToken, userId: user.id, tenantId, tenants };
}

export async function listTenantsOf(db: Kysely<Database>, userId: string) {
  return withTenant(db, { tenantId: '', userId }, (trx) =>
    trx.selectFrom('tenant_user').innerJoin('tenant', 'tenant.id', 'tenant_user.tenant_id')
      .select(['tenant.id', 'tenant.code', 'tenant.name']).where('tenant_user.user_id', '=', userId).where('tenant_user.is_active', '=', true).orderBy('tenant.code').execute());
}

export async function selectTenant(db: Kysely<Database>, sessionId: string, userId: string, tenantId: string): Promise<boolean> {
  const allowed = (await listTenantsOf(db, userId)).some((t) => t.id === tenantId);
  if (!allowed) return false;
  await db.updateTable('user_session').set({ tenant_id: tenantId }).where('id', '=', sessionId).execute();
  return true;
}

export async function logout(db: Kysely<Database>, sessionId: string) {
  await db.deleteFrom('user_session').where('id', '=', sessionId).execute();
}
