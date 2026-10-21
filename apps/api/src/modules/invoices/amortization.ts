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
  total: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG), periods: z.number().int().min(1).max(120), startYear: z.number().int().min(1900).max(2200), startPeriod: z.number().int().min(1).max(15),
  description: z.string().max(500).nullable().optional(),
});
export const scheduleUpdate = scheduleInput.extend({ isActive: z.boolean().optional() });
export const runInput = z.object({ fiscalYear: z.number().int(), periodNo: z.number().int().min(1).max(15) });

// Chia đều floor(total / kỳ), kỳ cuối nhận phần dư: tổng đúng bằng total. Kỳ thứ seq tính từ (startYear, startPeriod) theo các kỳ thật của năm tài chính (layout: năm -> số kỳ, theo thứ tự);
// năm chưa tạo giả định 12 kỳ. Năm tạo sau với số kỳ khác 12 thì lần chạy kỳ báo AMORTIZATION_PERIOD_LAYOUT (sửa lịch khi chưa bắt đầu để xếp lại).
const DEFAULT_NOS = Array.from({ length: 12 }, (_, i) => i + 1);
export function buildLines(total: string, periods: number, startYear: number, startPeriod: number, layout: Record<number, number[]> = {}) {
  const each = D(total).div(periods).floor();
  const nosOf = (y: number) => layout[y] ?? DEFAULT_NOS;
  let year = startYear; let idx = Math.max(0, nosOf(year).indexOf(startPeriod));
  return Array.from({ length: periods }, (_, i) => {
    if (idx >= nosOf(year).length) { year++; idx = 0; }
    return { seq: i + 1, fiscal_year: year, period_no: nosOf(year)[idx++]!, amount: (i === periods - 1 ? D(total).minus(each.times(periods - 1)) : each).toFixed(0) };
  });
}
async function loadLayout(trx: Trx, startYear: number, periods: number) {
  const rows = await trx.selectFrom('fiscal_period').select(['fiscal_year', 'period_no']).where('period_no', '>', 0).where('fiscal_year', '>=', startYear).where('fiscal_year', '<=', startYear + periods).orderBy('fiscal_year').orderBy('period_no').execute();
  const layout: Record<number, number[]> = {};
  for (const r of rows) (layout[r.fiscal_year] ??= []).push(r.period_no);
  return layout;
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

async function save(trx: Trx, tenantId: string, userId: string | null, id: number | null, input: z.infer<typeof scheduleInput>, isActive?: boolean) {
  if (D(input.total).lt(input.periods)) throw new AppError('VALIDATION', 'Tổng số tiền phải từ 1 đồng mỗi kỳ trở lên', 400);
  const p = await trx.selectFrom('fiscal_period').select('regime').where('fiscal_year', '=', input.startYear).where('period_no', '=', input.startPeriod).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Không có kỳ ${input.startPeriod}/${input.startYear}`, 404);
  const from = await accountId(trx, input.fromAccountCode, p.regime); const to = await accountId(trx, input.toAccountCode, p.regime);
  if (from === to) throw new AppError('VALIDATION', 'Tài khoản phân bổ đi và đến phải khác nhau', 400);
  if (input.sourceVoucherId && !(await trx.selectFrom('voucher').select('id').where('id', '=', input.sourceVoucherId).executeTakeFirst())) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ gốc', 404);
  const v = { source_voucher_id: input.sourceVoucherId ?? null, from_account_id: from, to_account_id: to, total: input.total, periods: input.periods, start_year: input.startYear, start_period: input.startPeriod, description: input.description ?? null };
  let sid = id;
  if (sid === null) sid = (await trx.insertInto('amortization_schedule').values({ tenant_id: tenantId, kind: 'deferred_revenue', created_by: userId, ...v }).returning('id').executeTakeFirstOrThrow()).id;
  else {
    await trx.updateTable('amortization_schedule').set({ ...v, ...(isActive === undefined ? {} : { is_active: isActive }) }).where('id', '=', sid).execute();
    await trx.deleteFrom('amortization_line').where('schedule_id', '=', sid).execute();
  }
  await trx.insertInto('amortization_line').values(buildLines(input.total, input.periods, input.startYear, input.startPeriod, await loadLayout(trx, input.startYear, input.periods)).map((l) => ({ tenant_id: tenantId, schedule_id: sid, ...l }))).execute();
  return getSchedule(trx, sid);
}

export const createSchedule = (trx: Trx, tenantId: string, userId: string, input: z.infer<typeof scheduleInput>) => save(trx, tenantId, userId, null, input);

const NOT_STARTED = 'Lịch đã phân bổ ít nhất một kỳ: không sửa được số tiền, số kỳ, tài khoản và không xóa được; có thể ngừng lịch (is_active = false) để dừng các kỳ sau';
const lockRuns = (trx: Trx, tenantId: string) => sql`SELECT pg_advisory_xact_lock(hashtext('amortization'), hashtext(${tenantId}::text))`.execute(trx);
async function lockSchedule(trx: Trx, tenantId: string, id: number) {
  await lockRuns(trx, tenantId); // cùng khóa với chạy kỳ: sửa/xóa lịch và chạy kỳ không chạy song song (nếu không PB có thể mồ côi hoặc ghi doanh thu hai lần)
  const s = await trx.selectFrom('amortization_schedule').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
  if (!s) throw new AppError('AMORTIZATION_NOT_FOUND', 'Không tìm thấy lịch phân bổ', 404);
  return (await trx.selectFrom('amortization_line').select('id').where('schedule_id', '=', id).where('voucher_id', 'is not', null).limit(1).executeTakeFirst()) !== undefined;
}
export async function updateSchedule(trx: Trx, tenantId: string, id: number, input: z.infer<typeof scheduleUpdate>) {
  const started = await lockSchedule(trx, tenantId, id);
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
  return save(trx, tenantId, null, id, rest, isActive);
}
export async function deleteSchedule(trx: Trx, tenantId: string, id: number) {
  if (await lockSchedule(trx, tenantId, id)) throw new AppError('AMORTIZATION_STARTED', NOT_STARTED, 409);
  await trx.deleteFrom('amortization_schedule').where('id', '=', id).execute(); // dòng xóa theo (ON DELETE CASCADE)
}

// Chạy phân bổ kỳ: mỗi dòng của lịch đang hoạt động trong kỳ có một chứng từ PB (Nợ đi / Có đến) ngày cuối kỳ.
// Chứng từ đang hiệu lực khớp tài khoản và số tiền thì giữ nguyên (không chạm sổ, kể cả kỳ khóa sổ); lệch (hoặc đã bị đảo) thì đảo cũ ngày cuối kỳ rồi sinh mới, như tỷ giá xuất quỹ.
// Chứng từ phân bổ là chứng từ hệ thống nên không bỏ ghi sổ/hủy được, kể cả kỳ đang mở: luôn dùng đảo.
export async function runAmortization(trx: Trx, ctx: { tenantId: string; userId: string; canBackdate: boolean }, input: z.infer<typeof runInput>) {
  await lockRuns(trx, ctx.tenantId);
  const { fiscalYear: fy, periodNo: pn } = input;
  const p = await trx.selectFrom('fiscal_period').select(['date_to', 'status']).where('fiscal_year', '=', fy).where('period_no', '=', pn).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Không có kỳ ${pn}/${fy}`, 404);
  if (p.status === 'hard_locked') throw new AppError('PERIOD_HARD_LOCKED', `Kỳ ${pn}/${fy} đã khóa cứng: không chạy phân bổ`, 409);
  if (p.status === 'soft_locked' && !ctx.canBackdate) throw new AppError('PERIOD_SOFT_LOCKED', `Kỳ ${pn}/${fy} đã khóa sổ, cần quyền ghi lùi ngày`, 409);

  // Lịch lập khi năm này chưa có (giả định 12 kỳ) mà năm được tạo sau với số kỳ khác: dòng trỏ vào kỳ không tồn tại thì không chạy tiếp, tránh ghi sai kỳ hoặc không bao giờ phân bổ hết.
  const orphan = await trx.selectFrom('amortization_line as l').innerJoin('amortization_schedule as s', 's.id', 'l.schedule_id').select('l.period_no').where('l.fiscal_year', '=', fy).where('s.is_active', '=', true)
    .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM fiscal_period fp WHERE fp.tenant_id = l.tenant_id AND fp.fiscal_year = l.fiscal_year AND fp.period_no = l.period_no)`).orderBy('l.period_no').limit(1).executeTakeFirst();
  if (orphan) throw new AppError('AMORTIZATION_PERIOD_LAYOUT', `Có lịch phân bổ trỏ vào kỳ ${orphan.period_no}/${fy} không tồn tại trong năm tài chính ${fy} (năm được tạo sau với số kỳ khác 12). Lịch chưa phân bổ kỳ nào: sửa lịch để xếp lại kỳ. Lịch đã phân bổ: ngừng lịch rồi lập lịch mới cho phần còn lại`, 409);

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
    const upd = await trx.updateTable('amortization_line').set({ voucher_id: v.id }).where('id', '=', r.id).executeTakeFirst();
    if (Number(upd.numUpdatedRows) !== 1) throw new AppError('AMORTIZATION_CONFLICT', 'Lịch phân bổ vừa bị sửa hoặc xóa trong lúc chạy kỳ, hãy chạy lại', 409);
    created.push({ scheduleId: r.schedule_id, voucherId: v.id });
  }
  return { fiscalYear: fy, periodNo: pn, created, reversedVoucherIds: reversed, unchanged };
}
