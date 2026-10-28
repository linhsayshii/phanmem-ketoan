import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import type { AuthCtx } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { dateIso } from '../ledger/vouchers.service.js';

type Trx = Transaction<Database>;
type Auth = Pick<AuthCtx, 'tenantId' | 'userId' | 'permissions'>;
const APPROVE = 'approval_request.approve';
const TODAY = sql`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

// Ủy quyền duyệt (GĐ7 gói 3): người duyệt vắng mặt giao các bước của mình cho một người khác trong khoảng ngày.
// Quy tắc: không tự ủy quyền, không ủy quyền vòng (A→B→…→A trong khoảng ngày chồng nhau), người được ủy quyền phải có quyền duyệt và không bị giới hạn chi nhánh
// (người bị giới hạn không còn quyền duyệt), người duyệt thay không phải người lập đề nghị, và một người không duyệt hai bước của cùng đề nghị (kể cả qua ủy quyền).
export const delegationInput = z.object({
  delegateId: z.string().uuid(), dateFrom: dateIso, dateTo: dateIso, reason: z.string().trim().max(500).optional(), delegatorId: z.string().uuid().optional(),
}).refine((b) => b.dateFrom <= b.dateTo, 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu');
export type DelegationInput = z.infer<typeof delegationInput>;

// Người dùng còn hoạt động, vai trò có quyền duyệt; chưa bị giới hạn chi nhánh.
async function approverInfo(trx: Trx, userId: string) {
  const r = await sql<{ role_id: string; can_approve: boolean; scoped: boolean }>`
    SELECT tu.role_id,
           EXISTS (SELECT 1 FROM role_permission rp WHERE rp.tenant_id = tu.tenant_id AND rp.role_id = tu.role_id AND rp.permission_code = ${APPROVE}) AS can_approve,
           EXISTS (SELECT 1 FROM user_branch_scope s WHERE s.tenant_id = tu.tenant_id AND s.user_id = tu.user_id) AS scoped
    FROM tenant_user tu WHERE tu.user_id = ${userId}::uuid AND tu.is_active`.execute(trx);
  return r.rows[0] ?? null;
}

export async function createDelegation(trx: Trx, auth: Auth, input: DelegationInput) {
  const delegator = input.delegatorId ?? auth.userId;
  const onBehalf = delegator !== auth.userId;
  // Lập thay người khác cần quyền quản lý người dùng (user.update), không dùng setting.update mà kế toán trưởng cũng có; người nhận không được là chính người lập,
  // nếu không người lập tự cấp quyền duyệt của người khác cho mình (vượt phân tách nhiệm vụ).
  if (onBehalf && !auth.permissions.has('user.update')) throw new AppError('FORBIDDEN', 'Chỉ quản trị người dùng mới lập ủy quyền thay người khác', 403);
  if (onBehalf && input.delegateId === auth.userId) throw new AppError('FORBIDDEN', 'Không được lập ủy quyền thay người khác với người nhận là chính mình', 403);
  if (delegator === input.delegateId) throw new AppError('VALIDATION', 'Không ủy quyền cho chính mình', 400);
  const today = (await sql<{ d: string }>`SELECT ${TODAY}::text AS d`.execute(trx)).rows[0]!.d;
  if (input.dateTo < today) throw new AppError('VALIDATION', 'Khoảng ủy quyền đã qua', 400);
  await sql`SELECT pg_advisory_xact_lock(hashtext(${auth.tenantId + ':approval_delegation'}))`.execute(trx); // hai ủy quyền lập cùng lúc không tạo vòng
  const from = await approverInfo(trx, delegator); const to = await approverInfo(trx, input.delegateId);
  if (!to) throw new AppError('USER_NOT_FOUND', 'Không có người được ủy quyền trong công ty', 404);
  if (!from || !from.can_approve) throw new AppError('APPROVAL_DELEGATOR_NO_PERMISSION', 'Người ủy quyền không có quyền duyệt', 409);
  if (!to.can_approve) throw new AppError('APPROVAL_DELEGATE_NO_PERMISSION', 'Người được ủy quyền không có quyền duyệt đề nghị', 409);
  if (to.scoped) throw new AppError('APPROVAL_DELEGATE_SCOPED', 'Người được ủy quyền đang bị giới hạn theo chi nhánh nên không có quyền duyệt', 409);
  // Vòng: từ người được ủy quyền đi theo các ủy quyền còn hiệu lực chồng khoảng ngày này mà quay về người ủy quyền.
  const edges = (await sql<{ delegator_id: string; delegate_id: string }>`
    SELECT delegator_id, delegate_id FROM approval_delegation
    WHERE revoked_at IS NULL AND date_to >= ${TODAY} AND date_from <= ${input.dateTo}::date AND date_to >= ${input.dateFrom}::date`.execute(trx)).rows;
  const seen = new Set<string>(); const stack = [input.delegateId];
  while (stack.length) {
    const u = stack.pop()!;
    if (u === delegator) throw new AppError('APPROVAL_DELEGATION_CYCLE', 'Ủy quyền vòng: người được ủy quyền (trực tiếp hoặc qua người khác) đã ủy quyền ngược lại cho người ủy quyền', 409);
    if (seen.has(u)) continue; seen.add(u);
    for (const e of edges) if (e.delegator_id === u) stack.push(e.delegate_id);
  }
  const r = await trx.insertInto('approval_delegation').values({ tenant_id: auth.tenantId!, delegator_id: delegator, delegate_id: input.delegateId, date_from: input.dateFrom, date_to: input.dateTo,
    reason: input.reason || null, created_by: auth.userId }).returning('id').executeTakeFirstOrThrow();
  if (onBehalf) {
    await sql`INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, after) VALUES (${auth.tenantId}::uuid, ${auth.userId}::uuid, 'approval_delegation_on_behalf', 'approval_delegation', ${String(r.id)},
      ${JSON.stringify({ delegatorId: delegator, delegateId: input.delegateId, dateFrom: input.dateFrom, dateTo: input.dateTo, createdBy: auth.userId })}::jsonb)`.execute(trx);
  }
  return { id: r.id };
}

export interface DelegationDto {
  id: number; delegatorId: string; delegator: string; delegateId: string; delegate: string; dateFrom: string; dateTo: string; reason: string | null;
  status: 'active' | 'upcoming' | 'expired' | 'revoked'; createdAt: string; revokedAt: string | null;
}
// scope 'mine': mình ủy quyền hoặc được ủy quyền; 'all': mọi ủy quyền của công ty (quyền setting.update).
export async function listDelegations(trx: Trx, auth: Auth, scope: 'mine' | 'all'): Promise<DelegationDto[]> {
  if (scope === 'all' && !auth.permissions.has('setting.update')) throw new AppError('FORBIDDEN', 'Thiếu quyền setting.update', 403);
  const rows = await sql<{ id: number; delegator_id: string; delegator: string; delegate_id: string; delegate: string; date_from: string; date_to: string; reason: string | null; status: DelegationDto['status']; created_at: Date; revoked_at: Date | null }>`
    SELECT d.id, d.delegator_id, a.username AS delegator, d.delegate_id, b.username AS delegate, d.date_from::text, d.date_to::text, d.reason, d.created_at, d.revoked_at,
           CASE WHEN d.revoked_at IS NOT NULL THEN 'revoked' WHEN d.date_to < ${TODAY} THEN 'expired' WHEN d.date_from > ${TODAY} THEN 'upcoming' ELSE 'active' END AS status
    FROM approval_delegation d JOIN app_user a ON a.id = d.delegator_id JOIN app_user b ON b.id = d.delegate_id
    WHERE ${scope === 'all' ? sql`true` : sql`(d.delegator_id = ${auth.userId}::uuid OR d.delegate_id = ${auth.userId}::uuid)`}
    ORDER BY d.date_from DESC, d.id DESC LIMIT 500`.execute(trx);
  return rows.rows.map((r) => ({ id: Number(r.id), delegatorId: r.delegator_id, delegator: r.delegator, delegateId: r.delegate_id, delegate: r.delegate, dateFrom: r.date_from, dateTo: r.date_to,
    reason: r.reason, status: r.status, createdAt: new Date(r.created_at).toISOString(), revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null }));
}

export async function revokeDelegation(trx: Trx, auth: Auth, id: number) {
  const d = await trx.selectFrom('approval_delegation').select(['delegator_id', 'revoked_at']).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!d) throw new AppError('APPROVAL_DELEGATION_NOT_FOUND', 'Không tìm thấy ủy quyền', 404);
  if (d.delegator_id !== auth.userId && !auth.permissions.has('setting.update')) throw new AppError('FORBIDDEN', 'Chỉ người ủy quyền hoặc quản trị được thu hồi', 403);
  if (d.revoked_at) throw new AppError('APPROVAL_DELEGATION_REVOKED', 'Ủy quyền đã thu hồi', 409);
  await trx.updateTable('approval_delegation').set({ revoked_at: new Date().toISOString(), revoked_by: auth.userId }).where('id', '=', id).execute();
}

// Người đã ủy quyền cho `userId` và còn hiệu lực hôm nay (giờ Việt Nam), người ủy quyền còn quyền duyệt và chưa bị giới hạn chi nhánh. Một bước: không bắc cầu.
export interface Delegator { userId: string; roleId: string; username: string; delegationId: number }
export async function activeDelegators(trx: Trx, tenantId: string, userId: string): Promise<Delegator[]> {
  const rows = await sql<{ id: number; delegator_id: string; role_id: string; username: string }>`
    SELECT d.id, d.delegator_id, tu.role_id, u.username
    FROM approval_delegation d
    JOIN tenant_user tu ON tu.tenant_id = d.tenant_id AND tu.user_id = d.delegator_id AND tu.is_active
    JOIN app_user u ON u.id = d.delegator_id
    WHERE d.delegate_id = ${userId}::uuid AND d.revoked_at IS NULL AND ${TODAY} BETWEEN d.date_from AND d.date_to
      AND EXISTS (SELECT 1 FROM role_permission rp WHERE rp.tenant_id = d.tenant_id AND rp.role_id = tu.role_id AND rp.permission_code = ${APPROVE})
      AND NOT EXISTS (SELECT 1 FROM user_branch_scope s WHERE s.tenant_id = d.tenant_id AND s.user_id = d.delegator_id)
    ORDER BY d.id`.execute(trx);
  void tenantId;
  return rows.rows.map((r) => ({ userId: r.delegator_id, roleId: r.role_id, username: r.username, delegationId: Number(r.id) }));
}

// Người có thể nhận ủy quyền: có quyền duyệt, đang hoạt động, không bị giới hạn chi nhánh, khác mình.
export async function delegateCandidates(trx: Trx, auth: Auth) {
  const r = await sql<{ id: string; username: string; full_name: string }>`
    SELECT u.id, u.username, u.full_name FROM tenant_user tu JOIN app_user u ON u.id = tu.user_id
    WHERE tu.is_active AND tu.user_id <> ${auth.userId}::uuid
      AND EXISTS (SELECT 1 FROM role_permission rp WHERE rp.tenant_id = tu.tenant_id AND rp.role_id = tu.role_id AND rp.permission_code = ${APPROVE})
      AND NOT EXISTS (SELECT 1 FROM user_branch_scope s WHERE s.tenant_id = tu.tenant_id AND s.user_id = tu.user_id)
    ORDER BY u.username`.execute(trx);
  return r.rows.map((x) => ({ id: x.id, username: x.username, fullName: x.full_name }));
}
