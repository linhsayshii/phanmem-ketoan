import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import { withTenant, type Database } from '@kt/db';
import { D, sensitiveDenial, todayVn, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { dateIso, createSystemVoucher, type SystemVoucherInput } from '../ledger/vouchers.service.js';
import { postWithCashCheck } from '../cash/books.js';
import { isSalaryCode } from '../payroll/accounts.js';
import { checkFormula, evalAmount, FormulaError, type FormulaVars } from './formula.js';
import { daysInMonth, dueOccurrences, type Frequency, type Occurrence } from './schedule.js';

type Trx = Transaction<Database>;
export const SOURCE_TYPE = 'recurring_entry';

const expr = z.string().trim().min(1).max(200).default('0');
const code30 = z.string().trim().min(1).max(30);
export const recurringLine = z.object({
  accountCode: z.string().regex(/^[0-9A-Za-z.]{1,20}$/, 'Mã tài khoản không hợp lệ'), debit: expr, credit: expr,
  partyCode: code30.nullish(), departmentCode: code30.nullish(), projectCode: code30.nullish(), costItemCode: code30.nullish(), description: z.string().max(500).nullish(),
});
export const recurringInput = z.object({
  code: z.string().regex(/^[A-Za-z0-9_.-]{1,30}$/, 'Mã gồm chữ, số, dấu _ . - (tối đa 30 ký tự)'), name: z.string().trim().min(1).max(200),
  frequency: z.enum(['monthly', 'quarterly', 'yearly']), dayOfMonth: z.number().int().min(1).max(31), startDate: dateIso, endDate: dateIso.nullish(),
  catchUp: z.boolean().default(false), description: z.string().max(500).nullish(), autoPost: z.boolean().default(false),
  lines: z.array(recurringLine).min(2, 'Mẫu cần ít nhất hai dòng').max(50),
});
export type RecurringInput = z.infer<typeof recurringInput>;

const monthVars = (year: number, month: number): FormulaVars => ({ THANG: month, QUY: Math.ceil(month / 3), NAM: year, SO_NGAY: daysInMonth(year, month) });

export interface EvaluatedLine { accountCode: string; debit: string; credit: string; partyCode: string | null; departmentCode: string | null; projectCode: string | null; costItemCode: string | null; description: string | null }
// Tính các dòng của mẫu cho một kỳ. Dòng cả hai bên bằng 0 bị bỏ; dòng có cả Nợ và Có là lỗi; tổng Nợ khác tổng Có là lỗi (không bao giờ sinh chứng từ lệch).
export function evaluateLines(lines: RecurringInput['lines'], vars: FormulaVars): { lines: EvaluatedLine[]; total: string } {
  const out: EvaluatedLine[] = [];
  lines.forEach((l, i) => {
    const debit = evalAmount(l.debit, vars); const credit = evalAmount(l.credit, vars);
    if (D(debit).gt(0) && D(credit).gt(0)) throw new AppError('RECURRING_LINE_BOTH_SIDES', `Dòng ${i + 1} (${l.accountCode}): chỉ được một bên Nợ hoặc Có có số tiền`, 400);
    if (D(debit).isZero() && D(credit).isZero()) return;
    out.push({ accountCode: l.accountCode, debit, credit, partyCode: l.partyCode ?? null, departmentCode: l.departmentCode ?? null, projectCode: l.projectCode ?? null, costItemCode: l.costItemCode ?? null, description: l.description ?? null });
  });
  const d = out.reduce((a, l) => a.plus(l.debit), D(0)); const c = out.reduce((a, l) => a.plus(l.credit), D(0));
  if (!d.eq(c)) throw new AppError('RECURRING_UNBALANCED', `Mẫu cho chứng từ lệch Nợ/Có (Nợ ${d.toFixed(0)}, Có ${c.toFixed(0)}): sửa số tiền hoặc công thức`, 400);
  if (!VND_AMOUNT_RE.test(d.toFixed(0))) throw new AppError('RECURRING_AMOUNT', 'Tổng số tiền vượt giới hạn', 400);
  return { lines: out, total: d.toFixed(0) };
}

// Kiểm khi lưu mẫu: công thức đúng cú pháp, mỗi tháng của một năm mẫu cho chứng từ cân Nợ/Có, tài khoản có trong hệ tài khoản.
export async function validateTemplate(trx: Trx, b: RecurringInput): Promise<void> {
  try {
    for (const l of b.lines) { checkFormula(l.debit); checkFormula(l.credit); }
    for (let m = 1; m <= 12; m++) evaluateLines(b.lines, monthVars(2026, m));
  } catch (e) {
    if (e instanceof FormulaError) throw new AppError('RECURRING_FORMULA', `Công thức không hợp lệ: ${e.message}`, 400);
    throw e;
  }
  const codes = [...new Set(b.lines.map((l) => l.accountCode))];
  const found = new Set((await trx.selectFrom('account').select('code').where('code', 'in', codes).where('is_group', '=', false).execute()).map((a) => a.code));
  const missing = codes.filter((c) => !found.has(c));
  if (missing.length) throw new AppError('RECURRING_ACCOUNT_INVALID', `Tài khoản không có hoặc là tài khoản tổng hợp: ${missing.join(', ')}`, 400);
}

type Entry = { id: string; code: string; name: string; status: string; frequency: string; day_of_month: number; start_date: string; end_date: string | null; catch_up: boolean; description: string | null; auto_post: boolean; created_by: string; created_at: string };
const toDto = (e: Entry, lines: RecurringInput['lines'], extra: object = {}) => ({
  id: e.id, code: e.code, name: e.name, status: e.status, frequency: e.frequency as Frequency, dayOfMonth: e.day_of_month, startDate: e.start_date, endDate: e.end_date, catchUp: e.catch_up,
  description: e.description, autoPost: e.auto_post, createdBy: e.created_by, lines, ...extra,
});
const notFound = () => new AppError('RECURRING_NOT_FOUND', 'Không tìm thấy mẫu bút toán định kỳ', 404);
const linesOf = async (trx: Trx, id: string): Promise<RecurringInput['lines']> => (await trx.selectFrom('recurring_entry_line').selectAll().where('entry_id', '=', id).orderBy('line_no').execute())
  .map((l) => ({ accountCode: l.account_code, debit: l.debit_expr, credit: l.credit_expr, partyCode: l.party_code, departmentCode: l.department_code, projectCode: l.project_code, costItemCode: l.cost_item_code, description: l.description }));
const insertLines = async (trx: Trx, tenantId: string, id: string, lines: RecurringInput['lines']) => {
  await trx.insertInto('recurring_entry_line').values(lines.map((l, i) => ({
    tenant_id: tenantId, entry_id: id, line_no: i + 1, account_code: l.accountCode, debit_expr: l.debit, credit_expr: l.credit, party_code: l.partyCode ?? null,
    department_code: l.departmentCode ?? null, project_code: l.projectCode ?? null, cost_item_code: l.costItemCode ?? null, description: l.description ?? null,
  }))).execute();
};
const scheduleOf = (e: Entry) => ({ frequency: e.frequency as Frequency, dayOfMonth: e.day_of_month, startDate: e.start_date, endDate: e.end_date, catchUp: e.catch_up, createdAt: e.created_at });

export async function listEntries(trx: Trx) {
  const es = await trx.selectFrom('recurring_entry').selectAll().orderBy('code').execute();
  const runs = await trx.selectFrom('recurring_run').select(['entry_id', 'status']).select((e) => [e.fn.count<string>('id').as('n')]).groupBy(['entry_id', 'status']).execute();
  const last = await trx.selectFrom('recurring_run').select(['entry_id']).select((e) => e.fn.max('occurrence_date').as('last')).where('status', '=', 'created').groupBy('entry_id').execute();
  return Promise.all(es.map(async (e) => {
    const done = new Set((await trx.selectFrom('recurring_run').select('period_key').where('entry_id', '=', e.id).where('status', '=', 'created').execute()).map((r) => r.period_key));
    // Kỳ kế tiếp chưa lập: kỳ sớm nhất đến hạn trong 24 tháng tới chưa có chứng từ.
    const horizon = new Date(Date.now() + 730 * 86_400_000).toISOString().slice(0, 10);
    const next = e.status === 'active' ? dueOccurrences(scheduleOf(e), horizon).find((o) => !done.has(o.periodKey)) : undefined;
    const count = (s: string) => Number(runs.find((r) => r.entry_id === e.id && r.status === s)?.n ?? 0);
    return toDto(e, [], { createdCount: count('created'), skippedCount: count('skipped'), errorCount: count('error'), lastDate: last.find((l) => l.entry_id === e.id)?.last ?? null, nextDate: next?.date ?? null });
  }));
}
export async function getEntry(trx: Trx, id: string, auth?: { sensitive: Set<string> }) {
  const e = await trx.selectFrom('recurring_entry').selectAll().where('id', '=', id).executeTakeFirst();
  if (!e) throw notFound();
  const lines = await linesOf(trx, id);
  if (auth) await assertTemplateAllowed(trx, auth, lines);
  return toDto(e, lines);
}
type Auth = { permissions: Set<string>; sensitive?: Set<string> };
// Mẫu có dòng ở tài khoản bị cờ nhạy cảm che (công nợ, giá vốn, lương) chỉ người có đủ cờ xem, lập, sửa, chạy được; số tiền trong mẫu cũng là số liệu nhạy cảm.
export async function deniedReason(trx: Trx, auth: { sensitive: Set<string> }, lines: { accountCode: string }[]): Promise<string | null> {
  const codes = [...new Set(lines.map((l) => l.accountCode))];
  if (!codes.length) return null;
  for (const a of await trx.selectFrom('account').select(['code', 'regime', 'subledger_kind']).where('code', 'in', codes).execute()) {
    const d = sensitiveDenial(auth, { subledger_kind: a.subledger_kind, code: a.code, salary: isSalaryCode(a.regime, a.code) });
    if (d) return d;
  }
  return null;
}
export async function assertTemplateAllowed(trx: Trx, auth: { sensitive: Set<string> }, lines: { accountCode: string }[]) {
  const d = await deniedReason(trx, auth, lines);
  if (d) throw new AppError('FORBIDDEN', `${d}: mẫu có tài khoản thuộc dữ liệu nhạy cảm`, 403);
}
function assertAutoPost(auth: Auth, b: { autoPost: boolean }) {
  if (b.autoPost && !auth.permissions.has('voucher.post')) throw new AppError('FORBIDDEN', 'Bật tự ghi sổ cần quyền voucher.post', 403);
}
export async function createEntry(trx: Trx, ctx: { tenantId: string; userId: string; auth: Auth }, b: RecurringInput) {
  assertAutoPost(ctx.auth, b);
  if (ctx.auth.sensitive) await assertTemplateAllowed(trx, { sensitive: ctx.auth.sensitive }, b.lines);
  await validateTemplate(trx, b);
  if (await trx.selectFrom('recurring_entry').select('id').where('code', '=', b.code).executeTakeFirst()) throw new AppError('RECURRING_CODE_TAKEN', `Mã ${b.code} đã dùng cho mẫu khác`, 409);
  if (b.endDate && b.endDate < b.startDate) throw new AppError('VALIDATION', 'Ngày kết thúc trước ngày bắt đầu', 400);
  const e = await trx.insertInto('recurring_entry').values({
    tenant_id: ctx.tenantId, code: b.code, name: b.name, frequency: b.frequency, day_of_month: b.dayOfMonth, start_date: b.startDate, end_date: b.endDate ?? null,
    catch_up: b.catchUp, description: b.description ?? null, auto_post: b.autoPost, created_by: ctx.userId,
  }).returningAll().executeTakeFirstOrThrow();
  await insertLines(trx, ctx.tenantId, e.id, b.lines);
  return getEntry(trx, e.id);
}
export async function updateEntry(trx: Trx, ctx: { tenantId: string; auth: Auth }, id: string, b: RecurringInput) {
  assertAutoPost(ctx.auth, b);
  const cur = await trx.selectFrom('recurring_entry').select(['id', 'code']).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!cur) throw notFound();
  if (ctx.auth.sensitive) { await assertTemplateAllowed(trx, { sensitive: ctx.auth.sensitive }, await linesOf(trx, id)); await assertTemplateAllowed(trx, { sensitive: ctx.auth.sensitive }, b.lines); }
  if (cur.code !== b.code) throw new AppError('RECURRING_CODE_LOCKED', 'Không đổi mã mẫu; lập mẫu mới nếu cần', 409);
  await validateTemplate(trx, b);
  await trx.updateTable('recurring_entry').set({ name: b.name, frequency: b.frequency, day_of_month: b.dayOfMonth, start_date: b.startDate, end_date: b.endDate ?? null, catch_up: b.catchUp,
    description: b.description ?? null, auto_post: b.autoPost, updated_at: sql<string>`now()` }).where('id', '=', id).execute();
  await trx.deleteFrom('recurring_entry_line').where('entry_id', '=', id).execute();
  await insertLines(trx, ctx.tenantId, id, b.lines);
  return getEntry(trx, id);
}
export async function setStatus(trx: Trx, id: string, status: 'active' | 'paused' | 'ended') {
  const r = await trx.updateTable('recurring_entry').set({ status, updated_at: sql<string>`now()` }).where('id', '=', id).returning('id').executeTakeFirst();
  if (!r) throw notFound();
  return getEntry(trx, id);
}
export async function deleteEntry(trx: Trx, id: string) {
  const made = await trx.selectFrom('recurring_run').select('id').where('entry_id', '=', id).where('status', '=', 'created').limit(1).executeTakeFirst();
  if (made) throw new AppError('RECURRING_HAS_RUNS', 'Mẫu đã sinh chứng từ: không xóa, hãy chuyển sang trạng thái Đã kết thúc', 409);
  const r = await trx.deleteFrom('recurring_entry').where('id', '=', id).returning('id').executeTakeFirst();
  if (!r) throw notFound();
}
export async function listRuns(trx: Trx, f: { entryId?: string | undefined; status?: string | undefined; limit: number }) {
  let q = trx.selectFrom('recurring_run as r').innerJoin('recurring_entry as e', 'e.id', 'r.entry_id').leftJoin('voucher as v', 'v.id', 'r.voucher_id')
    .select(['r.id', 'r.entry_id', 'e.code as entry_code', 'e.name as entry_name', 'r.period_key', 'r.occurrence_date', 'r.status', 'r.reason_code', 'r.message', 'r.voucher_id', 'r.trigger', 'r.run_at', 'v.voucher_no', 'v.state as voucher_state'])
    .orderBy('r.run_at', 'desc').orderBy('r.id', 'desc').limit(f.limit);
  if (f.entryId) q = q.where('r.entry_id', '=', f.entryId);
  if (f.status) q = q.where('r.status', '=', f.status);
  return (await q.execute()).map((r) => ({ id: r.id, entryId: r.entry_id, entryCode: r.entry_code, entryName: r.entry_name, periodKey: r.period_key, date: r.occurrence_date, status: r.status, reasonCode: r.reason_code,
    message: r.message, voucherId: r.voucher_id, voucherNo: r.voucher_no, voucherState: r.voucher_state, trigger: r.trigger, runAt: r.run_at }));
}

export interface RunItem { entryId: string; entryCode: string; periodKey: string; date: string; status: 'created' | 'skipped' | 'error' | 'exists' | 'planned'; voucherId?: string | null; reasonCode?: string; message?: string }
export interface RunOptions { auth?: { sensitive: Set<string> }; upTo?: string; entryId?: string; dryRun?: boolean; trigger: 'worker' | 'manual'; userId?: string; session?: { ip?: string; branchScope?: string; branchDefault?: string } }

const interpolate = (text: string, o: Occurrence) => text.replaceAll('{THANG}', String(o.month).padStart(2, '0')).replaceAll('{QUY}', String(Math.ceil(o.month / 3))).replaceAll('{NAM}', String(o.year));

// Ghi nhận kỳ không sinh được (bỏ qua hoặc lỗi) mà không đè kỳ đã sinh chứng từ.
async function recordFailure(db: Kysely<Database>, tc: { tenantId: string; userId: string }, e: Entry, o: Occurrence, status: 'skipped' | 'error', reasonCode: string, message: string, o2: RunOptions) {
  await withTenant(db, { ...o2.session, tenantId: tc.tenantId, userId: tc.userId }, async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('recurring_run'), hashtext(${e.id + o.periodKey}))`.execute(trx);
    await sql`INSERT INTO recurring_run(tenant_id, entry_id, period_key, occurrence_date, status, reason_code, message, trigger, run_by)
      VALUES (${tc.tenantId}::uuid, ${e.id}::uuid, ${o.periodKey}, ${o.date}::date, ${status}, ${reasonCode}, ${message.slice(0, 500)}, ${o2.trigger}, ${o2.userId ?? null}::uuid)
      ON CONFLICT (tenant_id, entry_id, period_key) DO UPDATE SET status = EXCLUDED.status, reason_code = EXCLUDED.reason_code, message = EXCLUDED.message, trigger = EXCLUDED.trigger, run_by = EXCLUDED.run_by, run_at = now()
      WHERE recurring_run.status <> 'created'`.execute(trx);
  });
}

// Chạy các kỳ đến hạn của mọi mẫu đang chạy (hoặc một mẫu) cho một công ty. Mỗi kỳ một giao dịch riêng: lỗi kỳ này không chặn kỳ khác, không để lại chứng từ dở.
// Idempotent: (mẫu, kỳ) đã sinh chứng từ thì bỏ qua (khóa duy nhất ở recurring_run, khóa tư vấn theo kỳ, idempotencyKey của chứng từ). Kỳ không mở (khóa sổ) hoặc chưa có kỳ kế toán → bỏ qua kèm lý do, thử lại lần chạy sau.
export async function runRecurring(db: Kysely<Database>, tenantId: string, o: RunOptions): Promise<RunItem[]> {
  const upTo = o.upTo ?? todayVn();
  const entries = await withTenant(db, { ...o.session, tenantId, userId: o.userId ?? '' }, (trx) => {
    let q = trx.selectFrom('recurring_entry').selectAll().where('status', '=', 'active').orderBy('code');
    if (o.entryId) q = q.where('id', '=', o.entryId);
    return q.execute();
  });
  if (o.entryId && entries.length === 0) {
    const any = await withTenant(db, { ...o.session, tenantId, userId: o.userId ?? '' }, (trx) => trx.selectFrom('recurring_entry').select('id').where('id', '=', o.entryId!).executeTakeFirst());
    throw any ? new AppError('RECURRING_NOT_ACTIVE', 'Mẫu không ở trạng thái Đang chạy', 409) : notFound();
  }
  const out: RunItem[] = [];
  for (const e of entries) {
    const userId = o.userId ?? e.created_by;
    const tc = { tenantId, userId };
    const lines = await withTenant(db, { ...o.session, ...tc }, (trx) => linesOf(trx, e.id));
    if (o.auth) { // người chạy thiếu cờ nhạy cảm của mẫu: bỏ qua mẫu này, không ghi lần chạy
      const denied = await withTenant(db, { ...o.session, ...tc }, (trx) => deniedReason(trx, o.auth!, lines));
      if (denied) { out.push({ entryId: e.id, entryCode: e.code, periodKey: '', date: '', status: 'skipped', reasonCode: 'SENSITIVE_DENIED', message: `${denied}: bạn không chạy được mẫu này` }); continue; }
    }
    for (const occ of dueOccurrences(scheduleOf(e), upTo)) {
      const item: RunItem = { entryId: e.id, entryCode: e.code, periodKey: occ.periodKey, date: occ.date, status: 'planned' };
      const done = await withTenant(db, { ...o.session, ...tc }, (trx) => trx.selectFrom('recurring_run').select('voucher_id').where('entry_id', '=', e.id).where('period_key', '=', occ.periodKey).where('status', '=', 'created').executeTakeFirst());
      if (done) { out.push({ ...item, status: 'exists', voucherId: done.voucher_id }); continue; }
      if (o.dryRun) { out.push(item); continue; }
      try {
        const r = await withTenant(db, { ...o.session, ...tc }, async (trx) => {
          await sql`SELECT pg_advisory_xact_lock(hashtext('recurring_run'), hashtext(${e.id + occ.periodKey}))`.execute(trx);
          const again = await trx.selectFrom('recurring_run').select('voucher_id').where('entry_id', '=', e.id).where('period_key', '=', occ.periodKey).where('status', '=', 'created').executeTakeFirst();
          if (again) return { kind: 'exists' as const, voucherId: again.voucher_id };
          const period = await trx.selectFrom('fiscal_period').select(['status', 'fiscal_year', 'period_no']).where('period_no', '>=', 1).where('period_no', '<=', 15).where('date_from', '<=', occ.date).where('date_to', '>=', occ.date).executeTakeFirst();
          if (!period) return { kind: 'skip' as const, code: 'PERIOD_NOT_FOUND', message: `Ngày ${occ.date} không thuộc kỳ kế toán nào đã mở` };
          if (period.status !== 'open') return { kind: 'skip' as const, code: 'PERIOD_LOCKED', message: `Kỳ ${String(period.period_no).padStart(2, '0')}/${period.fiscal_year} đã khóa sổ: không lập chứng từ định kỳ; mở lại kỳ hoặc lập chứng từ điều chỉnh ở kỳ mở` };
          const ev = evaluateLines(lines, monthVars(occ.year, occ.month));
          if (ev.lines.length === 0) return { kind: 'skip' as const, code: 'ZERO_AMOUNT', message: 'Tổng số tiền kỳ này bằng 0: không lập chứng từ' };
          const input: SystemVoucherInput = {
            voucherType: 'PKT', postingDate: occ.date, documentDate: occ.date, currencyCode: 'VND', idempotencyKey: `rec:${e.id}:${occ.periodKey}`,
            description: interpolate(e.description ?? `${e.name} {THANG}/{NAM}`, occ).slice(0, 500),
            lines: ev.lines.map((l) => ({ accountCode: l.accountCode, debit: l.debit, credit: l.credit, partyCode: l.partyCode, departmentCode: l.departmentCode, projectCode: l.projectCode, costItemCode: l.costItemCode, description: l.description })),
          };
          const v = await createSystemVoucher(trx, tc, input, { type: SOURCE_TYPE, id: e.id });
          await sql`INSERT INTO recurring_run(tenant_id, entry_id, period_key, occurrence_date, status, voucher_id, trigger, run_by, reason_code, message)
            VALUES (${tenantId}::uuid, ${e.id}::uuid, ${occ.periodKey}, ${occ.date}::date, 'created', ${v.id}::uuid, ${o.trigger}, ${o.userId ?? null}::uuid, NULL, NULL)
            ON CONFLICT (tenant_id, entry_id, period_key) DO UPDATE SET status = 'created', voucher_id = EXCLUDED.voucher_id, occurrence_date = EXCLUDED.occurrence_date, reason_code = NULL, message = NULL, trigger = EXCLUDED.trigger, run_by = EXCLUDED.run_by, run_at = now()`.execute(trx);
          await sql`INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, after)
            VALUES (${tenantId}::uuid, ${userId}::uuid, 'recurring_generate', 'recurring_entry', ${e.id}, ${JSON.stringify({ periodKey: occ.periodKey, voucherId: v.id, total: ev.total, trigger: o.trigger })}::jsonb)`.execute(trx);
          return { kind: 'created' as const, voucherId: v.id };
        });
        if (r.kind === 'exists') { out.push({ ...item, status: 'exists', voucherId: r.voucherId }); continue; }
        if (r.kind === 'skip') { await recordFailure(db, tc, e, occ, 'skipped', r.code, r.message, o); out.push({ ...item, status: 'skipped', reasonCode: r.code, message: r.message }); continue; }
        item.status = 'created'; item.voucherId = r.voucherId;
        // Ghi sổ (chỉ khi mẫu cấu hình rõ) ở giao dịch riêng sau khi nháp đã lưu: ghi sổ lỗi (âm quỹ, kỳ đổi trạng thái...) vẫn giữ bản nháp để người dùng xử lý.
        if (e.auto_post) {
          try { await withTenant(db, { ...o.session, ...tc }, (trx) => postWithCashCheck(trx, tenantId, r.voucherId)); }
          catch (pe) {
            item.message = `Đã lập nháp nhưng chưa ghi sổ được: ${pe instanceof Error ? pe.message : String(pe)}`;
            await withTenant(db, { ...o.session, ...tc }, (trx) => trx.updateTable('recurring_run').set({ reason_code: 'POST_FAILED', message: item.message!.slice(0, 500) }).where('entry_id', '=', e.id).where('period_key', '=', occ.periodKey).execute());
          }
        }
        out.push(item);
      } catch (err) {
        const code = err instanceof AppError ? err.code : err instanceof FormulaError ? 'RECURRING_FORMULA' : 'ERROR';
        const message = err instanceof Error ? err.message : String(err);
        await recordFailure(db, tc, e, occ, 'error', code, message, o);
        out.push({ ...item, status: 'error', reasonCode: code, message });
      }
    }
  }
  return out;
}
