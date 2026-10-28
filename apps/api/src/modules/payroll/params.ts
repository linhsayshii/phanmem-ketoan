import { isDeepStrictEqual } from 'node:util';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { dateIso } from '../master/catalogs.js';
import { legalParam } from '../core/legal.js';

type Trx = Kysely<Database> | Transaction<Database>;

// Tham số lương/thuế/bảo hiểm do công ty nhập kèm nguồn văn bản; phần mềm không có giá trị pháp lý mặc định (GĐ6 Quy ước 1).
const vnd = z.string().regex(VND_AMOUNT_RE, 'Số tiền VND phải là số nguyên không âm tối đa 16 chữ số');
const pct = z.number().min(0).max(100);
const mult = z.number().positive().max(10);
const upTo = z.string().regex(VND_AMOUNT_RE).nullable();
const oneOf = (o: object) => Object.values(o).some((v) => v !== undefined);

const brackets = z.array(z.object({ upTo, rate: pct }).strict()).min(1).superRefine((a, ctx) => {
  if (a[a.length - 1]!.upTo !== null) ctx.addIssue({ code: 'custom', message: 'Bậc cuối cùng phải không giới hạn (upTo = null)' });
  a.slice(0, -1).forEach((b, i) => {
    if (b.upTo === null || (i > 0 && BigInt(b.upTo) <= BigInt(a[i - 1]!.upTo ?? 0))) ctx.addIssue({ code: 'custom', message: 'Mức trần các bậc phải tăng dần' });
  });
});

export const PARAM_SCHEMAS = {
  pit_brackets: brackets,
  pit_brackets_annual: brackets, // biểu thuế quyết toán năm, nhập riêng (không suy 12 lần bậc tháng)
  pit_income_timing: z.enum(['period', 'payment_date']), // thu nhập chịu thuế tính theo kỳ lương hay theo thời điểm chi trả (05/KK, quyết toán)
  pit_deduction: z.object({ self: vnd, dependent: vnd }).strict(),
  si_rates: z.object({
    employee: z.object({ si: pct, hi: pct, ui: pct }).strict(),
    employer: z.object({ si: pct, hi: pct, ui: pct, occupational: pct, union: pct.optional(), union_fee: pct.optional() }).strict(), // union: kinh phí công đoàn; union_fee: đoàn phí
    parts: z.record(z.string(), pct).optional(), // tách BHXH theo quỹ khi cần hạch toán chi tiết
  }).strict(),
  si_ceiling: z.object({ si_base_max: vnd.optional(), si_base_max_multiple_of_min_wage: z.number().positive().optional(), ui_base_max_multiple_of_min_wage: z.number().positive().optional() }).strict().refine(oneOf, 'Cần ít nhất một mức trần'),
  si_floor: z.object({ si_base_min: vnd.optional(), si_base_min_multiple_of_min_wage: z.number().positive().optional() }).strict().refine(oneOf, 'Cần ít nhất một mức sàn'),
  min_wage_region: z.object({ I: vnd, II: vnd, III: vnd, IV: vnd }).strict(),
  ot_multipliers: z.object({ weekday: mult, weekly_rest: mult, holiday: mult }).strict(),
  pit_non_resident_rate: z.object({ rate: pct }).strict(),
  pit_flat_rate_no_contract: z.object({ rate: pct }).strict(),
  ot_tax_exempt_extra: z.boolean(),
} as const;
export type PayrollParamCode = keyof typeof PARAM_SCHEMAS;

export const paramInput = z.object({
  code: z.string(), validFrom: dateIso, validTo: dateIso.nullable().optional(), value: z.unknown(), source: z.string().trim().min(1, 'Phải ghi nguồn văn bản (điều, khoản, số hiệu)').max(500),
}).strict().superRefine((b, ctx) => {
  if (b.validTo && b.validTo < b.validFrom) ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'Ngày hết hiệu lực phải sau ngày bắt đầu' });
  const schema = PARAM_SCHEMAS[b.code as PayrollParamCode];
  if (!schema) { ctx.addIssue({ code: 'custom', path: ['code'], message: `Mã tham số không hợp lệ: ${b.code}` }); return; }
  const r = schema.safeParse(b.value);
  if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: 'custom', path: ['value', ...i.path], message: i.message });
});
export type ParamInput = z.infer<typeof paramInput>;

const vnDate = (d: string) => d.split('-').reverse().join('/');

export interface ParamResult<T> { value: T; source: 'legal_param' | 'payroll_param'; warning?: string }
// Tra theo ngày: legal_param (đã kiểm theo văn bản, CLAUDE.md) thắng khi có dòng hiệu lực; payroll_param của công ty chỉ dùng khi legal_param không có; không có cả hai thì 409 PAYROLL_PARAM_MISSING.
// Cả hai có mà giá trị khác nhau: dùng legal_param và trả kèm warning (không lỗi) để màn hình nhắc người dùng dọn dòng của công ty.
export async function payrollParam<T = unknown>(trx: Trx, code: string, date: string): Promise<ParamResult<T>> {
  const own = await trx.selectFrom('payroll_param').select('value').where('code', '=', code).where('valid_from', '<=', date)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', date)])).executeTakeFirst();
  const legal = await legalParam<T>(trx as Kysely<Database>, code, date);
  if (legal !== null) {
    const differs = own && !isDeepStrictEqual(own.value, legal);
    return { value: legal, source: 'legal_param', ...(differs && { warning: `Tham số "${code}" ngày ${vnDate(date)}: giá trị công ty nhập khác tham số pháp lý đã kiểm; hệ thống dùng tham số pháp lý` }) };
  }
  if (own) return { value: own.value as T, source: 'payroll_param' };
  throw new AppError('PAYROLL_PARAM_MISSING', `Chưa có tham số "${code}" hiệu lực ngày ${vnDate(date)}: nhập ở Tham số lương kèm nguồn văn bản`, 409);
}

const dto = (r: { id: number; code: string; valid_from: string; valid_to: string | null; value: unknown; source: string }) =>
  ({ id: r.id, code: r.code, validFrom: r.valid_from, validTo: r.valid_to, value: r.value, source: r.source });

export async function listParams(trx: Trx, code?: string) {
  let q = trx.selectFrom('payroll_param').selectAll();
  if (code) q = q.where('code', '=', code);
  return (await q.orderBy('code').orderBy('valid_from').execute()).map(dto);
}

export async function saveParam(trx: Trx, tenantId: string, b: ParamInput) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':payroll_param:' + b.code}, 0))`.execute(trx); // hai người nhập cùng lúc không lọt chồng khoảng
  const to = b.validTo ?? null;
  const clash = await trx.selectFrom('payroll_param').select(['valid_from', 'valid_to']).where('code', '=', b.code).where('valid_from', '<>', b.validFrom)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', b.validFrom)]))
    .$if(to !== null, (qb) => qb.where('valid_from', '<=', to!)).executeTakeFirst();
  if (clash) throw new AppError('PARAM_OVERLAP', `Khoảng hiệu lực chồng với dòng đã có của "${b.code}" (từ ${vnDate(clash.valid_from)}${clash.valid_to ? ` đến ${vnDate(clash.valid_to)}` : ''})`, 409);
  const v = { value: JSON.stringify(b.value) as never, valid_to: to, source: b.source };
  const row = await trx.insertInto('payroll_param').values({ tenant_id: tenantId, code: b.code, valid_from: b.validFrom, ...v })
    .onConflict((oc) => oc.columns(['tenant_id', 'code', 'valid_from']).doUpdateSet({ ...v, updated_at: sql`now()` })).returningAll().executeTakeFirstOrThrow();
  return dto(row);
}

export async function deleteParam(trx: Trx, id: number) {
  const r = await trx.deleteFrom('payroll_param').where('id', '=', id).executeTakeFirst();
  if (!r.numDeletedRows) throw new AppError('PARAM_NOT_FOUND', 'Không tìm thấy tham số lương', 404);
}
