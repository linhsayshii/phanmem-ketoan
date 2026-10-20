import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { sql, type Kysely } from 'kysely';
import { withTenant, type Database } from '@kt/db';

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });
export const verifyPassword = (hash: string, pw: string) => argon2.verify(hash, pw).catch(() => false);

// Băm giả để đăng nhập sai tên/tài khoản bị khóa tốn thời gian như sai mật khẩu (tránh dò tên đăng nhập qua thời gian phản hồi)
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(randomUUID()));

export interface LoginResult { sessionId: string; userId: string; tenantId: string | null; tenants: { id: string; code: string; name: string }[] }

export async function login(db: Kysely<Database>, input: { username: string; password: string; ip: string; ttlHours: number; limits: { maxFailsUser: number; maxFailsIp: number; lockMinutes: number } }): Promise<LoginResult | null | 'throttled'> {
  const { maxFailsUser, maxFailsIp, lockMinutes } = input.limits;
  // Đếm cả tên không tồn tại (không lộ tên có tồn tại); lần đúng gần nhất xóa bộ đếm theo tên
  const cnt = await sql<{ u: string; i: string }>`
    SELECT (SELECT count(*) FROM login_event WHERE username = ${input.username} AND NOT success
              AND ts > now() - make_interval(mins => ${lockMinutes})
              AND ts > coalesce((SELECT max(ts) FROM login_event WHERE username = ${input.username} AND success), '-infinity')) AS u,
           (SELECT count(*) FROM login_event WHERE ip = ${input.ip} AND NOT success AND ts > now() - make_interval(mins => ${lockMinutes})) AS i`.execute(db);
  if (Number(cnt.rows[0]!.u) >= maxFailsUser || Number(cnt.rows[0]!.i) >= maxFailsIp) {
    await db.insertInto('login_event').values({ username: input.username, user_id: null, success: false, ip: input.ip }).execute();
    return 'throttled';
  }
  const user = await db.selectFrom('app_user').selectAll().where('username', '=', input.username).executeTakeFirst();
  const verified = await verifyPassword(user?.is_active ? user.password_hash : await getDummyHash(), input.password);
  const ok = verified && !!user?.is_active;
  await db.insertInto('login_event').values({ username: input.username, user_id: user?.id ?? null, success: ok, ip: input.ip }).execute();
  if (!user || !ok) return null;
  const tenants = await listTenantsOf(db, user.id);
  const tenantId = tenants.length === 1 ? tenants[0]!.id : null;
  const s = await db.insertInto('user_session')
    .values({ user_id: user.id, tenant_id: tenantId, ip: input.ip, expires_at: sql`now() + make_interval(hours => ${input.ttlHours})` })
    .returning('id').executeTakeFirstOrThrow();
  return { sessionId: s.id, userId: user.id, tenantId, tenants };
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
