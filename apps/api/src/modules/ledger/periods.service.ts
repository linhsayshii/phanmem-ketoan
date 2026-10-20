import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';

export async function listPeriods(trx: Transaction<Database>, year?: number) {
  let q = trx.selectFrom('fiscal_period as p').select(['p.fiscal_year as fiscalYear', 'p.period_no as periodNo', 'p.date_from as dateFrom', 'p.date_to as dateTo', 'p.regime', 'p.status', 'p.locked_modules as lockedModules',
    sql<string | null>`encode(p.hash_tail, 'hex')`.as('hashTail'), 'p.locked_at as lockedAt',
    sql<number>`(SELECT count(*)::int FROM voucher v WHERE v.tenant_id = p.tenant_id AND v.fiscal_year = p.fiscal_year AND v.period_no = p.period_no AND v.state = 'draft')`.as('draftCount')]);
  if (year) q = q.where('p.fiscal_year', '=', year);
  return q.orderBy('p.fiscal_year').orderBy('p.period_no').execute();
}
export const lockPeriod = (trx: Transaction<Database>, tenantId: string, year: number, no: number, level: 'soft' | 'hard') => sql`SELECT lock_period(${tenantId}::uuid, ${year}, ${no}, ${level})`.execute(trx);
export async function unlockPeriod(trx: Transaction<Database>, tenantId: string, year: number, no: number, allowHard: boolean) {
  if (allowHard) await sql`SELECT set_config('app.unlock_hard', 'on', true)`.execute(trx);
  // Thiếu period.unlock_hard là lỗi quyền (403), không phải xung đột trạng thái: chặn tại đây; unlock_period vẫn giữ kiểm tra riêng (PERIOD_UNLOCK_HARD_FORBIDDEN) làm lớp bảo vệ.
  else if ((await trx.selectFrom('fiscal_period').select('status').where('fiscal_year', '=', year).where('period_no', '=', no).executeTakeFirst())?.status === 'hard_locked')
    throw new AppError('FORBIDDEN', 'Thiếu quyền period.unlock_hard để bỏ khóa cứng', 403);
  return (await sql<{ s: string }>`SELECT unlock_period(${tenantId}::uuid, ${year}, ${no}) AS s`.execute(trx)).rows[0]!.s;
}
export const setPeriodModules = (trx: Transaction<Database>, tenantId: string, year: number, no: number, modules: string[]) => sql`SELECT set_period_modules(${tenantId}::uuid, ${year}, ${no}, ${sql.val(modules)}::text[])`.execute(trx);
export async function verifyPeriodHash(trx: Transaction<Database>, tenantId: string, year: number, no: number) {
  // voucher_id NULL là dòng so hash cuối chuỗi với hash_tail của kỳ (phát hiện chứng từ bị xóa); dòng đó không tính vào total.
  const r = await sql<{ voucher_id: string | null; voucher_no: string | null; stored: Buffer | null; computed: Buffer; ok: boolean }>`SELECT * FROM verify_period_hash(${tenantId}::uuid, ${year}, ${no})`.execute(trx);
  return { total: r.rows.filter((x) => x.voucher_id).length, mismatched: r.rows.filter((x) => !x.ok).map((x) => ({ voucherId: x.voucher_id, voucherNo: x.voucher_no, stored: x.stored?.toString('hex') ?? null, computed: x.computed.toString('hex') })) };
}
