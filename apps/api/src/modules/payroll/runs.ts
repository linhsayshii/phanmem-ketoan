import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import {
  computePayrollLine, D, formatVnDate, PayrollError, resolvePayrollParams, workDays,
  type AttendanceKind, type MinWageRegion, type PayrollColumn, type PayrollInput, type PayrollWarning, type ProrationMode, type RawPayrollParams,
} from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';
import { entriesHash, monthEntries, monthRange } from './attendance.js';
import { PARAM_SCHEMAS, payrollParam } from './params.js';
import { ensureDefaultStructure, getStructureRow, prorationEnum, structureBody } from './structures.js';

type Trx = Transaction<Database>;

const id = z.coerce.number().int().positive();
export const runCreateInput = z.object({
  year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12), kind: z.enum(['regular', 'bonus', 'retro']).default('regular'),
  departmentId: id.nullish().transform((v) => v ?? null), structureId: id.nullish().transform((v) => v ?? null),
  employeeIds: z.array(id).min(1).max(10000).optional(), // bỏ trống = mọi nhân viên có hồ sơ lương đang làm trong tháng (theo bộ phận nếu chọn)
  name: z.string().trim().max(200).nullish().transform((v) => v || null), note: z.string().trim().max(500).nullish().transform((v) => v || null),
}).strict();
export const valuesInput = z.object({ values: z.record(z.string(), z.string().regex(/^-?\d{1,16}(\.\d{1,6})?$/, 'Nhập số, tối đa 6 chữ số thập phân').nullable()) }).strict();
export const previewInput = z.object({
  employeeId: id, year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12),
  structureId: id.optional(), proration: prorationEnum.optional(), columns: structureBody.shape.columns.optional(), // cấu trúc đang soạn (chưa lưu)
  manual: z.record(z.string(), z.string().regex(/^-?\d{1,16}(\.\d{1,6})?$/)).optional(),
}).strict();

const KIND_NAME = { regular: 'Bảng lương', bonus: 'Bảng thưởng', retro: 'Bảng truy lĩnh' } as const;
const mmyyyy = (y: number, m: number) => `${String(m).padStart(2, '0')}/${y}`;
const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const OT_KINDS = new Set(['ot_weekday_hour', 'ot_rest_hour', 'ot_holiday_hour']);

interface RunRow { id: number; year: number; month: number; kind: string; status: string; structure_id: number }
interface Structure { columns: PayrollColumn[]; proration: ProrationMode }
interface Gathered {
  emps: Map<number, { code: string; name: string; region: MinWageRegion | undefined; input: PayrollInput; hash: string; warnings: PayrollWarning[] }>;
  raw: RawPayrollParams; runWarnings: PayrollWarning[]; settings: { hours: string | null; days: string | null }; usesHours: boolean;
}

// Tham số tra tại một ngày; thiếu thì bỏ qua (động cơ chỉ báo PAYROLL_PARAM_MISSING khi phép tính thật sự cần).
async function tryParam(trx: Trx, code: string, date: string) {
  try { return await payrollParam(trx, code, date); } catch (e) { if (e instanceof AppError && e.code === 'PAYROLL_PARAM_MISSING') return undefined; throw e; }
}

// Đọc mọi đầu vào của các nhân viên trong kỳ và dựng PayrollInput + chữ ký đầu vào từng dòng. Không ghi gì, không ném lỗi thiếu cài đặt (calculate kiểm riêng),
// nên dùng được cả để suy "Cần tính lại" khi đọc bảng lương.
async function gather(trx: Trx, tenantId: string, run: Omit<RunRow, 'status' | 'structure_id'>, structure: Structure, employeeIds: number[], manual: Map<number, Record<string, string>>): Promise<Gathered> {
  const { from, to } = monthRange(run.year, run.month);
  const s = await getSettings(trx, tenantId);
  const settings = { hours: s.payroll_standard_hours_per_day, days: s.payroll_standard_days_per_month };
  // Tham số tại ngày cuối kỳ; khác giá trị đầu kỳ thì cảnh báo (QĐ #661).
  const raw: Record<string, unknown> = {}; const runWarnings: PayrollWarning[] = [];
  for (const code of Object.keys(PARAM_SCHEMAS)) {
    const [end, start] = [await tryParam(trx, code, to), await tryParam(trx, code, from)];
    if (end) raw[code] = end.value;
    if (end?.warning) runWarnings.push({ code: 'PARAM_SOURCE_DIFFERS', message: end.warning });
    if (!isDeepStrictEqual(start?.value, end?.value)) runWarnings.push({ code: 'PARAM_CHANGED_IN_PERIOD', message: `Tham số "${code}" thay đổi trong kỳ: bảng lương dùng giá trị hiệu lực ngày ${formatVnDate(to)} (cuối kỳ)` });
  }
  const regular = run.kind === 'regular';
  const ids = employeeIds.length ? employeeIds : [-1];
  const [profiles, history, allowances, dependents, entries] = await Promise.all([
    trx.selectFrom('employee as e').innerJoin('employee_payroll as p', 'p.employee_id', 'e.id').select(['e.id', 'e.code', 'e.name']).select([
      'p.start_date', 'p.end_date', 'p.region', 'p.si_salary', 'p.si_participates', 'p.hi_participates', 'p.ui_participates', 'p.occupational_participates',
      'p.union_employer', 'p.union_member', 'p.tax_residency', 'p.contract_type']).where('e.id', 'in', ids).execute(),
    trx.selectFrom('employee_salary_history').select(['employee_id', 'valid_from', 'monthly_salary']).where('employee_id', 'in', ids).where('valid_from', '<=', to).orderBy('employee_id').orderBy('valid_from').execute(),
    trx.selectFrom('employee_allowance').select(['employee_id', 'code', 'amount', 'taxable', 'si_base']).where('employee_id', 'in', ids)
      .where((eb) => eb.and([eb.or([eb('valid_from', 'is', null), eb('valid_from', '<=', to)]), eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', from)])])).orderBy('employee_id').orderBy('code').orderBy('id').execute(),
    trx.selectFrom('employee_dependent').select(['employee_id', 'from_month', 'to_month']).where('employee_id', 'in', ids).orderBy('employee_id').orderBy('from_month').orderBy('id').execute(),
    regular ? monthEntries(trx, run.year, run.month, employeeIds) : Promise.resolve([]),
  ]);
  const prior = regular ? new Map<number, NonNullable<PayrollInput['prior']>>() : await priorOf(trx, run, employeeIds);
  const group = <T extends { employee_id: number }>(a: T[]) => { const m = new Map<number, T[]>(); for (const x of a) (m.get(x.employee_id) ?? m.set(x.employee_id, []).get(x.employee_id)!).push(x); return m; };
  const hist = group(history), allow = group(allowances), deps = group(dependents);
  const ents = new Map<number, typeof entries>(); for (const e of entries) (ents.get(e.employeeId) ?? ents.set(e.employeeId, []).get(e.employeeId)!).push(e);
  const std = settings.hours ?? '1'; // thiếu giờ chuẩn mà có giờ: calculate báo 409 trước khi dùng
  const emps: Gathered['emps'] = new Map();
  for (const p of profiles) {
    const warnings: PayrollWarning[] = [];
    // Chỉ tính chấm công trong thời gian làm việc theo hồ sơ (QĐ #662); ngày ngoài thời gian làm việc chỉ cảnh báo.
    const all = ents.get(p.id) ?? [];
    const mine = all.filter((e) => (!p.start_date || e.date >= p.start_date) && (!p.end_date || e.date <= p.end_date));
    if (mine.length < all.length) warnings.push({ code: 'ATTENDANCE_OUT_OF_EMPLOYMENT', message: `Có chấm công ngoài thời gian làm việc (${[...new Set(all.filter((e) => !mine.includes(e)).map((e) => formatVnDate(e.date)))].join(', ')}): không tính vào bảng lương` });
    const input: PayrollInput = {
      period: { year: run.year, month: run.month }, segments: [], proration: structure.proration,
      standardDays: settings.days ?? '0', standardHoursPerDay: settings.hours ?? '0',
      insurance: { si: false, hi: false, ui: false, occupational: false },
      dependents: (deps.get(p.id) ?? []).map((d) => ({ from: d.from_month, to: d.to_month })),
      taxResidency: p.tax_residency as PayrollInput['taxResidency'], contractType: p.contract_type as PayrollInput['contractType'],
      siSalary: p.si_salary, manual: manual.get(p.id) ?? {},
      ...(prior.has(p.id) && { prior: prior.get(p.id)! }),
    };
    if (regular) {
      // Công hưởng lương mỗi ngày = ngày công (ngày, buổi, giờ quy đổi) + nghỉ phép + nghỉ lễ; nghỉ ốm (quỹ BHXH trả) và nghỉ không lương không tính (QĐ #663).
      const byDate = new Map<string, { kind: AttendanceKind; qty: string }[]>();
      for (const e of mine) (byDate.get(e.date) ?? byDate.set(e.date, []).get(e.date)!).push({ kind: e.kind, qty: e.qty });
      const paid = [...byDate].map(([date, items]) => { const w = workDays(items.filter((x) => !OT_KINDS.has(x.kind)), std); return { date, days: D(w.workDays).plus(w.paidLeave).plus(w.holiday) }; });
      // Đoạn lương: mức hiệu lực đầu kỳ (hoặc ngày vào làm) và mọi mức đổi trong kỳ; đoạn cuối là mức hiệu lực cuối kỳ (hoặc ngày nghỉ việc).
      const startEff = p.start_date && p.start_date > from ? p.start_date : from;
      const endEff = p.end_date && p.end_date < to ? p.end_date : to;
      const rows = (hist.get(p.id) ?? []).filter((h) => h.valid_from <= endEff);
      const first = rows.reduce((k, h, i) => (h.valid_from <= startEff ? i : k), 0);
      const segs = rows.slice(first);
      input.segments = segs.map((h, i) => {
        const next = segs[i + 1]?.valid_from;
        const days = paid.filter((x) => x.date >= h.valid_from && (!next || x.date < next)).reduce((a, x) => a.plus(x.days), D(0));
        return { monthlySalary: h.monthly_salary, paidDays: days.toString() };
      });
      if (!segs.length) warnings.push({ code: 'SALARY_MISSING', message: 'Chưa có mức lương hiệu lực trong kỳ (Hồ sơ lương > Lịch sử lương)' });
      else if (paid.some((x) => x.date < segs[0]!.valid_from && !x.days.isZero())) warnings.push({ code: 'SALARY_MISSING', message: `Có ngày công trước ngày hiệu lực mức lương đầu tiên (${formatVnDate(segs[0]!.valid_from)}): không có lương` });
      const w = workDays(mine.filter((e) => OT_KINDS.has(e.kind)), std);
      input.otHours = { weekday: w.otWeekdayHours, rest: w.otRestHours, holiday: w.otHolidayHours };
      input.allowances = (allow.get(p.id) ?? []).map((a) => ({ code: a.code, amount: a.amount, taxable: a.taxable, siBase: a.si_base }));
      input.insurance = { si: p.si_participates, hi: p.hi_participates, ui: p.ui_participates, occupational: p.occupational_participates };
      input.union = { employer: p.union_employer, member: p.union_member };
    }
    const region = (p.region ?? undefined) as MinWageRegion | undefined;
    const hash = sha({ kind: run.kind, structure, raw, settings, region, input, attendance: entriesHash(all) });
    emps.set(p.id, { code: p.code, name: p.name, region, input, hash, warnings });
  }
  return { emps, raw: raw as RawPayrollParams, runWarnings, settings, usesHours: entries.some((e) => e.kind === 'hour' || OT_KINDS.has(e.kind)) };
}

// Bảng thưởng/truy lĩnh (D12): thuế tháng tính trên tổng các bảng của tháng, trừ phần đã khấu trừ. prior = bảng chính và các bảng phụ lập trước (id nhỏ hơn) đã tính.
async function priorOf(trx: Trx, run: { id: number; year: number; month: number }, employeeIds: number[]) {
  const lines = await trx.selectFrom('payroll_line').select(['id', 'employee_id', 'si_emp', 'pit']).where('year', '=', run.year).where('month', '=', run.month)
    .where('employee_id', 'in', employeeIds.length ? employeeIds : [-1]).where('run_id', '<>', run.id).where('run_status', 'in', ['calculated', 'posted'])
    .where((eb) => eb.or([eb('kind', '=', 'regular'), eb('run_id', '<', run.id)])).execute();
  const vals = lines.length ? await trx.selectFrom('payroll_line_value').select(['line_id', 'column_code', 'value']).where('line_id', 'in', lines.map((l) => l.id)).where('column_code', 'in', ['taxable_income', 'deduction_other']).execute() : [];
  const out = new Map<number, NonNullable<PayrollInput['prior']>>();
  for (const l of lines) {
    const v = (c: string) => vals.find((x) => x.line_id === l.id && x.column_code === c)?.value ?? '0';
    const o = out.get(l.employee_id) ?? { taxableIncome: '0', siEmployee: '0', otherRelief: '0', pit: '0' };
    out.set(l.employee_id, { taxableIncome: D(o.taxableIncome).plus(v('taxable_income')).toString(), siEmployee: D(o.siEmployee).plus(l.si_emp).toString(), otherRelief: D(o.otherRelief).plus(v('deduction_other')).toString(), pit: D(o.pit).plus(l.pit).toString() });
  }
  return out;
}

const structureOf = async (trx: Trx, sid: number): Promise<Structure> => { const r = await getStructureRow(trx, sid); return { columns: r.columns as PayrollColumn[], proration: r.proration as ProrationMode }; };

async function manualOf(trx: Trx, lineIds: { id: number; employee_id: number }[]) {
  const m = new Map<number, Record<string, string>>();
  if (!lineIds.length) return m;
  const emp = new Map(lineIds.map((l) => [l.id, l.employee_id]));
  for (const r of await trx.selectFrom('payroll_line_value').select(['line_id', 'column_code', 'value']).where('line_id', 'in', lineIds.map((l) => l.id)).where('manual', '=', true).orderBy('column_code').execute()) {
    const e = emp.get(r.line_id)!; m.set(e, { ...m.get(e), [r.column_code]: r.value });
  }
  return m;
}

// Tính các dòng và ghi kết quả (giá trị tính lại thay hết, ô nhập tay giữ nguyên). Lỗi động cơ nêu nhân viên; thiếu tham số 409 nêu mã tham số và ngày.
async function computeLines(trx: Trx, tenantId: string, run: RunRow, lines: { id: number; employee_id: number }[]) {
  const structure = await structureOf(trx, run.structure_id);
  const g = await gather(trx, tenantId, run, structure, lines.map((l) => l.employee_id), await manualOf(trx, lines));
  const { to } = monthRange(run.year, run.month);
  if (structure.proration === 'calendar' && !(g.settings.days && D(g.settings.days).gt(0)))
    throw new AppError('PAYROLL_SETTING_MISSING', 'Chưa khai "Số ngày công chuẩn mỗi tháng" trong cài đặt công ty (cấu trúc tính lương theo ngày công chuẩn của công ty)', 409);
  if (g.usesHours && !(g.settings.hours && D(g.settings.hours).gt(0)))
    throw new AppError('PAYROLL_SETTING_MISSING', 'Chưa khai "Số giờ làm việc chuẩn mỗi ngày" trong cài đặt công ty nên không quy đổi được giờ làm việc, làm thêm giờ', 409);
  if (run.kind !== 'regular') {
    const draft = await trx.selectFrom('payroll_line as l').innerJoin('employee as e', 'e.id', 'l.employee_id').select('e.code').where('l.year', '=', run.year).where('l.month', '=', run.month)
      .where('l.kind', '=', 'regular').where('l.run_status', '=', 'draft').where('l.employee_id', 'in', lines.map((l) => l.employee_id)).execute();
    if (draft.length) throw new AppError('PAYROLL_REGULAR_NOT_CALCULATED', `Bảng lương chính tháng ${mmyyyy(run.year, run.month)} của ${draft.map((d) => d.code).join(', ')} chưa tính: tính bảng lương chính trước (thuế tháng tính trên tổng các bảng)`, 409);
  }
  const results = lines.map((l) => {
    const e = g.emps.get(l.employee_id);
    if (!e) throw new AppError('PAYROLL_PROFILE_MISSING', `Nhân viên (mã nội bộ ${l.employee_id}) chưa có hồ sơ lương`, 409);
    try {
      const r = computePayrollLine(e.input, { columns: structure.columns }, resolvePayrollParams(g.raw, e.region));
      return { line: l, e, r };
    } catch (err) {
      if (!(err instanceof PayrollError)) throw err;
      const missing = err.code === 'PAYROLL_PARAM_MISSING';
      throw new AppError(err.code, `${e.code} ${e.name}: ${err.message}${missing ? ` hiệu lực ngày ${formatVnDate(to)}: nhập ở Tham số lương kèm nguồn văn bản` : ''}`, missing ? 409 : 400,
        { employeeCode: e.code, column: err.column ?? null, param: err.param ?? null, date: to });
    }
  });
  const ids = lines.map((l) => l.id);
  await trx.deleteFrom('payroll_line_value').where('line_id', 'in', ids).where('manual', '=', false).execute();
  const rows = results.flatMap(({ line, e, r }) => Object.entries(r.values).filter(([c]) => e.input.manual?.[c] === undefined).map(([c, v]) => ({ tenant_id: tenantId, line_id: line.id, column_code: c, value: v })));
  for (let i = 0; i < rows.length; i += 5000) await trx.insertInto('payroll_line_value').values(rows.slice(i, i + 5000)).execute();
  const upd = results.map(({ line, e, r }) => ({ id: line.id, gross: r.gross, si_emp: r.siEmp, si_er: r.siEr, pit: r.pit, net: r.net, warnings: [...e.warnings, ...r.warnings], hash: e.hash }));
  await sql`UPDATE payroll_line l SET gross = x.gross::numeric, si_emp = x.si_emp::numeric, si_er = x.si_er::numeric, pit = x.pit::numeric, net = x.net::numeric, warnings = x.warnings, input_hash = x.hash
    FROM jsonb_to_recordset(${JSON.stringify(upd)}::jsonb) AS x(id bigint, gross text, si_emp text, si_er text, pit text, net text, warnings jsonb, hash text) WHERE l.id = x.id`.execute(trx);
  return g.runWarnings;
}

// Chữ ký cả bảng = băm các chữ ký dòng (theo nhân viên); Task 6 so để biết bảng đã đổi từ lần hạch toán trước.
async function refreshRunHash(trx: Trx, runId: number) {
  const ls = await trx.selectFrom('payroll_line').select(['employee_id', 'input_hash']).where('run_id', '=', runId).orderBy('employee_id').execute();
  await trx.updateTable('payroll_run').set({ input_hash: sha(ls.map((l) => [l.employee_id, l.input_hash])), updated_at: sql`now()` }).where('id', '=', runId).execute();
}

async function lockRun(trx: Trx, runId: number) {
  const r = await trx.selectFrom('payroll_run').select(['id', 'year', 'month', 'kind', 'status', 'structure_id', 'name']).where('id', '=', runId).forUpdate().executeTakeFirst();
  if (!r) throw new AppError('PAYROLL_RUN_NOT_FOUND', 'Không tìm thấy bảng lương', 404);
  return r;
}
function assertEditable(r: { status: string }) {
  if (r.status === 'posted') throw new AppError('PAYROLL_RUN_POSTED', 'Bảng lương đã hạch toán: hủy hạch toán trước khi tính lại hoặc sửa', 409);
  if (r.status === 'cancelled') throw new AppError('PAYROLL_RUN_CANCELLED', 'Bảng lương đã hủy', 409);
}

export async function createRun(trx: Trx, tenantId: string, b: z.infer<typeof runCreateInput>) {
  const structureId = b.structureId ?? await ensureDefaultStructure(trx, tenantId);
  await getStructureRow(trx, structureId);
  const dept = b.departmentId === null ? null : await trx.selectFrom('department').select(['id', 'name']).where('id', '=', b.departmentId).executeTakeFirst();
  if (b.departmentId !== null && !dept) throw new AppError('DEPARTMENT_NOT_FOUND', 'Không tìm thấy bộ phận', 404);
  const { from, to } = monthRange(b.year, b.month);
  let q = trx.selectFrom('employee as e').innerJoin('employee_payroll as p', 'p.employee_id', 'e.id').select(['e.id', 'e.code']);
  if (b.employeeIds) q = q.where('e.id', 'in', b.employeeIds);
  else q = q.where('e.is_active', '=', true).where((eb) => eb.or([eb('p.start_date', 'is', null), eb('p.start_date', '<=', to)])).where((eb) => eb.or([eb('p.end_date', 'is', null), eb('p.end_date', '>=', from)]));
  if (b.departmentId !== null) q = q.where('e.department_id', '=', b.departmentId);
  const emps = await q.orderBy('e.code').execute();
  const lost = (b.employeeIds ?? []).filter((x) => !emps.some((e) => e.id === x));
  if (lost.length) throw new AppError('PAYROLL_PROFILE_MISSING', `Nhân viên (mã nội bộ ${lost.join(', ')}) không có, chưa có hồ sơ lương hoặc không thuộc bộ phận đã chọn`, 409);
  if (!emps.length) throw new AppError('PAYROLL_RUN_EMPTY', `Không có nhân viên nào có hồ sơ lương đang làm việc trong tháng ${mmyyyy(b.year, b.month)}`, 400);
  if (b.kind === 'regular') {
    // Một nhân viên một bảng lương chính chưa hủy mỗi tháng (chỉ mục payroll_line_one_regular là chốt chặn cuối); khóa theo kỳ để báo lỗi rõ thay vì 23505.
    await sql`SELECT pg_advisory_xact_lock(hashtext('payroll_run'), hashtext(${`${tenantId}:${b.year}-${b.month}`}))`.execute(trx);
    const clash = await trx.selectFrom('payroll_line as l').innerJoin('employee as e', 'e.id', 'l.employee_id').innerJoin('payroll_run as r', 'r.id', 'l.run_id').select(['e.code', 'r.name'])
      .where('l.year', '=', b.year).where('l.month', '=', b.month).where('l.kind', '=', 'regular').where('l.run_status', '<>', 'cancelled').where('l.employee_id', 'in', emps.map((e) => e.id)).orderBy('e.code').execute();
    if (clash.length) throw new AppError('PAYROLL_EMPLOYEE_IN_OTHER_RUN', `Nhân viên ${clash.slice(0, 20).map((c) => c.code).join(', ')}${clash.length > 20 ? '…' : ''} đã có trong bảng lương chính "${clash[0]!.name}" tháng ${mmyyyy(b.year, b.month)}: hủy bảng đó hoặc chọn nhân viên khác`, 409, { employeeCodes: clash.map((c) => c.code) });
  }
  const name = b.name ?? `${KIND_NAME[b.kind]} tháng ${mmyyyy(b.year, b.month)}${dept ? ` - ${dept.name}` : ''}`;
  const run = await trx.insertInto('payroll_run').values({ tenant_id: tenantId, year: b.year, month: b.month, kind: b.kind, name, department_id: b.departmentId, structure_id: structureId, note: b.note })
    .returning('id').executeTakeFirstOrThrow();
  for (let i = 0; i < emps.length; i += 5000) await trx.insertInto('payroll_line').values(emps.slice(i, i + 5000).map((e) => ({ tenant_id: tenantId, run_id: run.id, employee_id: e.id }))).execute();
  return getRun(trx, tenantId, run.id);
}

export async function calculateRun(trx: Trx, tenantId: string, runId: number) {
  const run = await lockRun(trx, runId); assertEditable(run);
  const lines = await trx.selectFrom('payroll_line').select(['id', 'employee_id']).where('run_id', '=', runId).execute();
  const warnings = await computeLines(trx, tenantId, run, lines);
  await trx.updateTable('payroll_run').set({ status: 'calculated', calculated_at: new Date(), warnings: JSON.stringify(warnings) }).where('id', '=', runId).execute();
  await refreshRunHash(trx, runId);
  return getRun(trx, tenantId, runId);
}

// Sửa ô nhập tay (cột input) của một nhân viên: đặt manual (null = bỏ ô nhập tay), ghi audit_event trước/sau (D14) rồi tính lại riêng dòng đó.
export async function setManualValues(trx: Trx, tenantId: string, runId: number, employeeId: number, values: Record<string, string | null>) {
  const run = await lockRun(trx, runId); assertEditable(run);
  const line = await trx.selectFrom('payroll_line').select(['id', 'employee_id']).where('run_id', '=', runId).where('employee_id', '=', employeeId).executeTakeFirst();
  if (!line) throw new AppError('PAYROLL_LINE_NOT_FOUND', 'Nhân viên không có trong bảng lương này', 404);
  const { columns } = await structureOf(trx, run.structure_id);
  const bad = Object.keys(values).find((c) => columns.find((x) => x.code === c)?.kind !== 'input');
  if (bad !== undefined) throw new AppError('PAYROLL_COLUMN_NOT_INPUT', `Cột "${bad}" không phải cột nhập tay của cấu trúc bảng lương`, 400);
  const old = new Map((await trx.selectFrom('payroll_line_value').select(['column_code', 'value']).where('line_id', '=', line.id).where('manual', '=', true).execute()).map((r) => [r.column_code, r.value]));
  const before: Record<string, string | null> = {}; const after: Record<string, string | null> = {};
  for (const [c, v] of Object.entries(values)) {
    const prev = old.get(c) ?? null; const next = v === null ? null : D(v).toString();
    if (prev === next) continue;
    before[c] = prev; after[c] = next;
    if (next === null) await trx.deleteFrom('payroll_line_value').where('line_id', '=', line.id).where('column_code', '=', c).execute();
    else await trx.insertInto('payroll_line_value').values({ tenant_id: tenantId, line_id: line.id, column_code: c, value: next, manual: true })
      .onConflict((oc) => oc.columns(['tenant_id', 'line_id', 'column_code']).doUpdateSet({ value: next, manual: true })).execute();
  }
  if (Object.keys(after).length) await sql`INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, after, ip)
    VALUES (${tenantId}::uuid, app_user_id(), 'manual_value', 'payroll_line_value', ${String(line.id)}, ${JSON.stringify({ runId, employeeId, values: before })}::jsonb,
      ${JSON.stringify({ runId, employeeId, values: after })}::jsonb, nullif(current_setting('app.client_ip', true), ''))`.execute(trx);
  await computeLines(trx, tenantId, run, [line]);
  if (run.status === 'calculated') await refreshRunHash(trx, runId);
  return (await linesOf(trx, tenantId, run, [employeeId])).lines[0]!;
}

export async function deleteRun(trx: Trx, runId: number) {
  const r = await lockRun(trx, runId);
  if (r.status !== 'draft') throw new AppError('PAYROLL_RUN_NOT_DRAFT', 'Chỉ xóa được bảng lương nháp; bảng đã tính thì hủy', 409);
  await trx.deleteFrom('payroll_run').where('id', '=', runId).execute();
}

export async function cancelRun(trx: Trx, tenantId: string, runId: number) {
  const r = await lockRun(trx, runId); assertEditable(r);
  await trx.updateTable('payroll_run').set({ status: 'cancelled', updated_at: sql`now()` }).where('id', '=', runId).execute();
  return getRun(trx, tenantId, runId);
}

export async function listRuns(trx: Trx, q: { year: number; month?: number | undefined }) {
  let b = trx.selectFrom('payroll_run as r').innerJoin('payroll_structure as s', 's.id', 'r.structure_id').leftJoin('department as d', 'd.id', 'r.department_id')
    .select(['r.id', 'r.year', 'r.month', 'r.kind', 'r.status', 'r.name', 'r.department_id', 'd.name as department_name', 'r.structure_id', 's.name as structure_name', 'r.calculated_at', 'r.voucher_id', 'r.note', 'r.created_at'])
    .select((eb) => [
      eb.selectFrom('payroll_line as l').whereRef('l.run_id', '=', 'r.id').select(sql<string>`count(*)::int`.as('n')).as('employee_count'),
      eb.selectFrom('payroll_line as l').whereRef('l.run_id', '=', 'r.id').select(sql<string>`json_build_object('gross', coalesce(sum(gross),0)::text, 'siEmp', coalesce(sum(si_emp),0)::text, 'siEr', coalesce(sum(si_er),0)::text, 'pit', coalesce(sum(pit),0)::text, 'net', coalesce(sum(net),0)::text)`.as('t')).as('totals'),
    ]).where('r.year', '=', q.year);
  if (q.month) b = b.where('r.month', '=', q.month);
  return (await b.orderBy('r.month', 'desc').orderBy('r.id', 'desc').execute()).map((r) => ({
    id: r.id, year: r.year, month: r.month, kind: r.kind, status: r.status, name: r.name, departmentId: r.department_id, departmentName: r.department_name,
    structureId: r.structure_id, structureName: r.structure_name, employeeCount: Number(r.employee_count), totals: r.totals, calculatedAt: r.calculated_at, voucherId: r.voucher_id, note: r.note, createdAt: r.created_at,
  }));
}

async function linesOf(trx: Trx, tenantId: string, run: RunRow, employeeIds?: number[]) {
  let q = trx.selectFrom('payroll_line as l').innerJoin('employee as e', 'e.id', 'l.employee_id').leftJoin('department as d', 'd.id', 'e.department_id')
    .select(['l.id', 'l.employee_id', 'e.code', 'e.name', 'd.name as department_name', 'l.gross', 'l.si_emp', 'l.si_er', 'l.pit', 'l.net', 'l.warnings', 'l.input_hash']).where('l.run_id', '=', run.id);
  if (employeeIds) q = q.where('l.employee_id', 'in', employeeIds);
  const ls = await q.orderBy('e.code').execute();
  const vals = ls.length ? await trx.selectFrom('payroll_line_value').select(['line_id', 'column_code', 'value', 'manual']).where('line_id', 'in', ls.map((l) => l.id)).execute() : [];
  // "Cần tính lại": chữ ký đầu vào hiện tại khác chữ ký lúc tính (chỉ có nghĩa khi bảng đã tính).
  let current: Gathered | null = null;
  if (run.status === 'calculated' || run.status === 'posted') current = await gather(trx, tenantId, run, await structureOf(trx, run.structure_id), ls.map((l) => l.employee_id), await manualOf(trx, ls));
  const lines = ls.map((l) => {
    const mine = vals.filter((v) => v.line_id === l.id);
    return {
      lineId: l.id, employeeId: l.employee_id, employeeCode: l.code, employeeName: l.name, departmentName: l.department_name,
      values: Object.fromEntries(mine.map((v) => [v.column_code, v.value])), manual: mine.filter((v) => v.manual).map((v) => v.column_code).sort(),
      gross: l.gross, siEmp: l.si_emp, siEr: l.si_er, pit: l.pit, net: l.net, warnings: l.warnings as PayrollWarning[],
      stale: current !== null && current.emps.get(l.employee_id)?.hash !== l.input_hash,
    };
  });
  return { lines, runWarnings: current?.runWarnings };
}

export async function getRun(trx: Trx, tenantId: string, runId: number) {
  const r = await trx.selectFrom('payroll_run as r').innerJoin('payroll_structure as s', 's.id', 'r.structure_id').leftJoin('department as d', 'd.id', 'r.department_id')
    .selectAll('r').select(['s.name as structure_name', 's.columns', 's.proration', 'd.name as department_name']).where('r.id', '=', runId).executeTakeFirst();
  if (!r) throw new AppError('PAYROLL_RUN_NOT_FOUND', 'Không tìm thấy bảng lương', 404);
  const { lines } = await linesOf(trx, tenantId, r);
  const totals: Record<string, string> = {};
  for (const l of lines) for (const [c, v] of Object.entries(l.values)) totals[c] = D(totals[c] ?? 0).plus(v).toString();
  return {
    id: r.id, year: r.year, month: r.month, kind: r.kind, status: r.status, name: r.name, departmentId: r.department_id, departmentName: r.department_name,
    structureId: r.structure_id, structureName: r.structure_name, proration: r.proration, inputHash: r.input_hash, calculatedAt: r.calculated_at, voucherId: r.voucher_id,
    note: r.note, createdAt: r.created_at, warnings: r.warnings as PayrollWarning[], stale: lines.some((l) => l.stale), employeeCount: lines.length,
    columns: r.columns as PayrollColumn[], lines, totals,
  };
}

export async function getRunLines(trx: Trx, tenantId: string, runId: number) {
  return (await getRun(trx, tenantId, runId)).lines;
}

// Xem thử cấu trúc (đã lưu hoặc đang soạn) với một nhân viên trong một tháng, như dòng bảng lương chính; không ghi gì.
export async function previewLine(trx: Trx, tenantId: string, b: z.infer<typeof previewInput>) {
  const base = b.structureId ? await structureOf(trx, b.structureId) : await structureOf(trx, await ensureDefaultStructure(trx, tenantId));
  const structure: Structure = { columns: (b.columns as PayrollColumn[] | undefined) ?? base.columns, proration: b.proration ?? base.proration };
  const g = await gather(trx, tenantId, { id: 0, year: b.year, month: b.month, kind: 'regular' }, structure, [b.employeeId], new Map([[b.employeeId, b.manual ?? {}]]));
  const e = g.emps.get(b.employeeId);
  if (!e) throw new AppError('PAYROLL_PROFILE_MISSING', 'Nhân viên chưa có hồ sơ lương', 409);
  const r = computePayrollLine(e.input, { columns: structure.columns }, resolvePayrollParams(g.raw, e.region));
  return { ...r, warnings: [...g.runWarnings, ...e.warnings, ...r.warnings] };
}
