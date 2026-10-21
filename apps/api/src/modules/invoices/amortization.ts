import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import * as S from '../ledger/vouchers.service.js';

type Trx = Transaction<Database>;
const ctxOf = (c: { tenantId: string; userId: string }) => ({ tenantId: c.tenantId, userId: c.userId });

export const scheduleInput = z.object({
  sourceVoucherId: z.string().uuid().nullable().optional(), fromAccountCode: z.string().min(1), toAccountCode: z.string().min(1),
  total: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG), periods: z.number().int().min(1).max(120), startYear: z.number().int().min(1900).max(2200), startPeriod: z.number().int().min(1).max(12),
  description: z.string().max(500).nullable().optional(),
});
export const scheduleUpdate = scheduleInput.extend({ isActive: z.boolean().optional() });
export const runInput = z.object({ fiscalYear: z.number().int(), periodNo: z.number().int().min(1).max(12) });

// Chia đều floor(total / kỳ), kỳ cuối nhận phần dư: tổng đúng bằng total. Kỳ thứ seq tính từ (startYear, startPeriod), 12 kỳ mỗi năm.
// shortcut: năm tài chính ngắn hoặc dài hơn 12 kỳ chưa hỗ trợ; làm khi có yêu cầu.
export function buildLines(total: string, periods: number, startYear: number, startPeriod: number) {
  const each = D(total).div(periods).floor();
  return Array.from({ length: periods }, (_, i) => {
    const k = startPeriod - 1 + i;
    return { seq: i + 1, fiscal_year: startYear + Math.floor(k / 12), period_no: (k % 12) + 1, amount: (i === periods - 1 ? D(total).minus(each.times(periods - 1)) : each).toFixed(0) };
  });
}

// source_doc_id của chứng từ PB: uuid suy từ công ty và mã lịch (source_doc_id là uuid còn id lịch là số), như XQ của tỷ giá xuất quỹ.
const sourceId = async (trx: Trx, tenantId: string, scheduleId: number) => (await sql<{ id: string }>`SELECT md5(${`${tenantId}:amortization:${scheduleId}`})::uuid::text AS id`.execute(trx)).rows[0]!.id;

async function accountId(trx: Trx, code: string, regime: string): Promise<number> {
  const a = await trx.selectFrom('account').select(['id', 'is_group', 'is_active']).where('regime', '=', regime).where('code', '=', code).executeTakeFirst();
  if (!a) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản ${code}`, 404);
  if (a.is_group || !a.is_active) throw new AppError('VALIDATION', `Tài khoản ${code} là tài khoản tổng hợp hoặc đã ngừng dùng, không phân bổ được`, 400);
  return a.id;
}

const SCHEDULE_COLS = ['s.id', 's.kind', 's.source_voucher_id', 's.total', 's.periods', 's.start_year', 's.start_period', 's.description', 's.is_active', 'f.code as from_code', 't.code as to_code'] as const;
const scheduleQuery = (trx: Trx) => trx.selectFrom('amortization_schedule as s').innerJoin('account as f', 'f.id', 's.from_account_id').innerJoin('account as t', 't.id', 's.to_account_id').select(SCHEDULE_COLS);
type Row = Awaited<ReturnType<ReturnType<typeof scheduleQuery>['execute']>>[number];

async function dto(trx: Trx, rows: Row[]) {
  const lines = rows.length ? await trx.selectFrom('amortization_line as l').leftJoin('voucher as v', 'v.id', 'l.voucher_id')
    .select(['l.schedule_id', 'l.seq', 'l.fiscal_year', 'l.period_no', 'l.amount', 'l.voucher_id', 'v.voucher_no', 'v.state']).where('l.schedule_id', 'in', rows.map((r) => r.id)).orderBy('l.seq').execute() : [];
  return rows.map((r) => {
    const mine = lines.filter((l) => l.schedule_id === r.id);
    return { id: r.id, kind: r.kind, sourceVoucherId: r.source_voucher_id, fromAccountCode: r.from_code, toAccountCode: r.to_code, total: r.total, periods: r.periods, startYear: r.start_year, startPeriod: r.start_period,
      description: r.description, isActive: r.is_active, started: mine.some((l) => l.voucher_id), postedAmount: mine.filter((l) => l.state === 'posted').reduce((s, l) => s.plus(l.amount), D(0)).toFixed(0),
      lines: mine.map((l) => ({ seq: l.seq, fiscalYear: l.fiscal_year, periodNo: l.period_no, amount: l.amount, voucherId: l.voucher_id, voucherNo: l.voucher_no, voucherState: l.state })) };
  });
}
export type ScheduleDto = Awaited<ReturnType<typeof dto>>[number];

export const listSchedules = async (trx: Trx): Promise<ScheduleDto[]> => dto(trx, await scheduleQuery(trx).orderBy('s.id', 'desc').execute());
export async function getSchedule(trx: Trx, id: number): Promise<ScheduleDto> {
  const r = await scheduleQuery(trx).where('s.id', '=', id).executeTakeFirst();
  if (!r) throw new AppError('AMORTIZATION_NOT_FOUND', 'Không tìm thấy lịch phân bổ', 404);
  return (await dto(trx, [r]))[0]!;
}

async function save(trx: Trx, tenantId: string, id: number | null, input: z.infer<typeof scheduleInput>, isActive?: boolean) {
  if (D(input.total).lt(input.periods)) throw new AppError('VALIDATION', 'Tổng số tiền phải từ 1 đồng mỗi kỳ trở lên', 400);
  const p = await trx.selectFrom('fiscal_period').select('regime').where('fiscal_year', '=', input.startYear).where('period_no', '=', input.startPeriod).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Không có kỳ ${input.startPeriod}/${input.startYear}`, 404);
  const from = await accountId(trx, input.fromAccountCode, p.regime); const to = await accountId(trx, input.toAccountCode, p.regime);
  if (from === to) throw new AppError('VALIDATION', 'Tài khoản phân bổ đi và đến phải khác nhau', 400);
  if (input.sourceVoucherId && !(await trx.selectFrom('voucher').select('id').where('id', '=', input.sourceVoucherId).executeTakeFirst())) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ gốc', 404);
  const v = { source_voucher_id: input.sourceVoucherId ?? null, from_account_id: from, to_account_id: to, total: input.total, periods: input.periods, start_year: input.startYear, start_period: input.startPeriod, description: input.description ?? null };
  let sid = id;
  if (sid === null) sid = (await trx.insertInto('amortization_schedule').values({ tenant_id: tenantId, kind: 'deferred_revenue', ...v }).returning('id').executeTakeFirstOrThrow()).id;
  else {
    await trx.updateTable('amortization_schedule').set({ ...v, ...(isActive === undefined ? {} : { is_active: isActive }) }).where('id', '=', sid).execute();
    await trx.deleteFrom('amortization_line').where('schedule_id', '=', sid).execute();
  }
  await trx.insertInto('amortization_line').values(buildLines(input.total, input.periods, input.startYear, input.startPeriod).map((l) => ({ tenant_id: tenantId, schedule_id: sid, ...l }))).execute();
  return getSchedule(trx, sid);
}

export const createSchedule = (trx: Trx, tenantId: string, input: z.infer<typeof scheduleInput>) => save(trx, tenantId, null, input);

const NOT_STARTED = 'Lịch đã phân bổ ít nhất một kỳ: không sửa được số tiền, số kỳ, tài khoản và không xóa được; có thể ngừng lịch (is_active = false) để dừng các kỳ sau';
async function lockSchedule(trx: Trx, id: number) {
  const s = await trx.selectFrom('amortization_schedule').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
  if (!s) throw new AppError('AMORTIZATION_NOT_FOUND', 'Không tìm thấy lịch phân bổ', 404);
  return (await trx.selectFrom('amortization_line').select('id').where('schedule_id', '=', id).where('voucher_id', 'is not', null).limit(1).executeTakeFirst()) !== undefined;
}
export async function updateSchedule(trx: Trx, tenantId: string, id: number, input: z.infer<typeof scheduleUpdate>) {
  const started = await lockSchedule(trx, id);
  const { isActive, ...rest } = input;
  if (started) {
    // Đã phân bổ: chỉ đổi được diễn giải và trạng thái hoạt động; các trường khác phải giữ nguyên.
    const cur = await getSchedule(trx, id);
    const same = cur.fromAccountCode === rest.fromAccountCode && cur.toAccountCode === rest.toAccountCode && cur.total === rest.total && cur.periods === rest.periods
      && cur.startYear === rest.startYear && cur.startPeriod === rest.startPeriod && (cur.sourceVoucherId ?? null) === (rest.sourceVoucherId ?? null);
    if (!same) throw new AppError('AMORTIZATION_STARTED', NOT_STARTED, 409);
    await trx.updateTable('amortization_schedule').set({ description: rest.description ?? null, ...(isActive === undefined ? {} : { is_active: isActive }) }).where('id', '=', id).execute();
    return getSchedule(trx, id);
  }
  return save(trx, tenantId, id, rest, isActive);
}
export async function deleteSchedule(trx: Trx, id: number) {
  if (await lockSchedule(trx, id)) throw new AppError('AMORTIZATION_STARTED', NOT_STARTED, 409);
  await trx.deleteFrom('amortization_schedule').where('id', '=', id).execute(); // dòng xóa theo (ON DELETE CASCADE)
}

// Chạy phân bổ kỳ: mỗi dòng của lịch đang hoạt động trong kỳ có một chứng từ PB (Nợ đi / Có đến) ngày cuối kỳ.
// Chứng từ đang hiệu lực khớp tài khoản và số tiền thì giữ nguyên (không chạm sổ, kể cả kỳ khóa sổ); lệch (hoặc đã bị đảo) thì đảo cũ ngày cuối kỳ rồi sinh mới, như tỷ giá xuất quỹ.
// Chứng từ phân bổ là chứng từ hệ thống nên không bỏ ghi sổ/hủy được, kể cả kỳ đang mở: luôn dùng đảo.
export async function runAmortization(trx: Trx, ctx: { tenantId: string; userId: string; canBackdate: boolean }, input: z.infer<typeof runInput>) {
  await sql`SELECT pg_advisory_xact_lock(hashtext('amortization'), hashtext(${ctx.tenantId}::text))`.execute(trx);
  const { fiscalYear: fy, periodNo: pn } = input;
  const p = await trx.selectFrom('fiscal_period').select(['date_to', 'status']).where('fiscal_year', '=', fy).where('period_no', '=', pn).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Không có kỳ ${pn}/${fy}`, 404);
  if (p.status === 'hard_locked') throw new AppError('PERIOD_HARD_LOCKED', `Kỳ ${pn}/${fy} đã khóa cứng: không chạy phân bổ`, 409);
  if (p.status === 'soft_locked' && !ctx.canBackdate) throw new AppError('PERIOD_SOFT_LOCKED', `Kỳ ${pn}/${fy} đã khóa sổ, cần quyền ghi lùi ngày`, 409);

  const rows = await trx.selectFrom('amortization_line as l').innerJoin('amortization_schedule as s', 's.id', 'l.schedule_id').innerJoin('account as f', 'f.id', 's.from_account_id').innerJoin('account as t', 't.id', 's.to_account_id')
    .leftJoin('voucher as v', 'v.id', 'l.voucher_id')
    .select(['l.id', 'l.schedule_id', 'l.seq', 'l.amount', 'l.voucher_id', 'v.state', 's.description', 's.periods', 'f.code as from_code', 't.code as to_code'])
    .where('l.fiscal_year', '=', fy).where('l.period_no', '=', pn).where('s.is_active', '=', true).orderBy('l.schedule_id').execute();
  const created: { scheduleId: number; voucherId: string }[] = []; const reversed: string[] = []; let unchanged = 0;
  for (const r of rows) {
    if (r.voucher_id && r.state === 'posted') {
      const cur = await trx.selectFrom('voucher_line as l').innerJoin('account as a', 'a.id', 'l.account_id').select(['a.code', 'l.debit', 'l.credit']).where('l.voucher_id', '=', r.voucher_id).orderBy('l.line_no').execute();
      const key = (x: { code: string; debit: string; credit: string }[]) => x.map((l) => `${l.code}|${l.debit}|${l.credit}`).join(';');
      if (key(cur) === key([{ code: r.from_code, debit: r.amount, credit: '0' }, { code: r.to_code, debit: '0', credit: r.amount }])) { unchanged++; continue; }
      await S.reverseVoucher(trx, r.voucher_id, { postingDate: p.date_to });
      reversed.push(r.voucher_id);
    }
    const description = `${r.description ?? 'Phân bổ doanh thu nhận trước'} (kỳ ${r.seq}/${r.periods})`;
    const v = await S.createSystemVoucher(trx, ctxOf(ctx), { voucherType: 'PB', postingDate: p.date_to, documentDate: p.date_to, description, currencyCode: 'VND',
      lines: [{ accountCode: r.from_code, debit: r.amount, credit: '0', description }, { accountCode: r.to_code, debit: '0', credit: r.amount, description }] },
    { type: 'amortization', id: await sourceId(trx, ctx.tenantId, r.schedule_id) });
    await S.postVoucher(trx, v.id);
    await trx.updateTable('amortization_line').set({ voucher_id: v.id }).where('id', '=', r.id).execute();
    created.push({ scheduleId: r.schedule_id, voucherId: v.id });
  }
  return { fiscalYear: fy, periodNo: pn, created, reversedVoucherIds: reversed, unchanged };
}
