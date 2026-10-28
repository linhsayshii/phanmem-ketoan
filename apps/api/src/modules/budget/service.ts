import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

type Trx = Transaction<Database>;
export const MONTHS = ['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10', 'm11', 'm12'] as const;
const money = z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG);
const optCode = z.string().trim().min(1).max(50).nullable().optional();

export const lineInput = z.object({
  accountPrefix: z.string().trim().regex(/^[0-9A-Za-z.]{1,20}$/, 'Tài khoản hoặc tiền tố tài khoản không hợp lệ'),
  costItemCode: optCode, departmentCode: optCode, projectCode: optCode,
  months: z.array(money).length(12, 'Cần đủ 12 số tiền tháng'), note: z.string().max(500).nullable().optional(),
});
export const budgetInput = z.object({
  fiscalYear: z.number().int().min(2000).max(2100), name: z.string().trim().min(1).max(200), note: z.string().max(1000).nullable().optional(),
  lines: z.array(lineInput).max(2000),
});
export type LineIn = z.infer<typeof lineInput>;
export type BudgetIn = z.infer<typeof budgetInput>;

// Tài khoản loại 1, 2, 6, 8 ghi tăng bên Nợ: thực tế = Nợ - Có; còn lại (3, 4, 5, 7, 9) thực tế = Có - Nợ.
export const isDebitNormal = (prefix: string) => /^[1268]/.test(prefix);

export const budgetNotFound = () => new AppError('BUDGET_NOT_FOUND', 'Không có ngân sách', 404);
export const yearRegime = async (trx: Trx, year: number): Promise<string> => {
  const r = await trx.selectFrom('fiscal_period').select('regime').where('fiscal_year', '=', year).limit(1).executeTakeFirst();
  if (!r) throw new AppError('FISCAL_YEAR_NOT_FOUND', `Chưa mở năm tài chính ${year}`, 404);
  return r.regime;
};
export async function loadBudget(trx: Trx, id: number) {
  const b = await trx.selectFrom('budget').selectAll().where('id', '=', id).executeTakeFirst();
  if (!b) throw budgetNotFound();
  return b;
}

// Tra mã khoản mục/bộ phận/dự án → id; mã không có là 400.
async function dimIds(trx: Trx, lines: LineIn[]) {
  const out = { cost_item: new Map<string, number>(), department: new Map<string, number>(), project: new Map<string, number>() };
  const key = { cost_item: 'costItemCode', department: 'departmentCode', project: 'projectCode' } as const;
  const label = { cost_item: 'Khoản mục phí', department: 'Bộ phận', project: 'Dự án' } as const;
  for (const t of ['cost_item', 'department', 'project'] as const) {
    const codes = [...new Set(lines.map((l) => l[key[t]]).filter((c): c is string => !!c))];
    if (!codes.length) continue;
    const rows = await sql<{ id: string; code: string }>`SELECT id::text, code FROM ${sql.table(t)} WHERE code IN (${sql.join(codes)})`.execute(trx);
    for (const r of rows.rows) out[t].set(r.code, Number(r.id));
    const bad = codes.find((c) => !out[t].has(c));
    if (bad) throw new AppError('BUDGET_DIM_INVALID', `${label[t]} ${bad} không có trong danh mục`, 400);
  }
  return out;
}

export async function replaceLines(trx: Trx, tenantId: string, budgetId: number, year: number, lines: LineIn[]) {
  const regime = await yearRegime(trx, year);
  for (const p of new Set(lines.map((l) => l.accountPrefix))) {
    const ok = await sql`SELECT 1 FROM account WHERE regime = ${regime} AND starts_with(code, ${p}) LIMIT 1`.execute(trx);
    if (!ok.rows.length) throw new AppError('BUDGET_ACCOUNT_INVALID', `Không có tài khoản nào bắt đầu bằng ${p} trong hệ tài khoản ${regime}`, 400);
  }
  const dims = await dimIds(trx, lines);
  await trx.deleteFrom('budget_line').where('budget_id', '=', budgetId).execute();
  let no = 0;
  for (const l of lines) {
    await trx.insertInto('budget_line').values({
      tenant_id: tenantId, budget_id: budgetId, line_no: ++no, account_prefix: l.accountPrefix,
      cost_item_id: l.costItemCode ? dims.cost_item.get(l.costItemCode)! : null, department_id: l.departmentCode ? dims.department.get(l.departmentCode)! : null,
      project_id: l.projectCode ? dims.project.get(l.projectCode)! : null, note: l.note ?? null,
      ...Object.fromEntries(MONTHS.map((m, i) => [m, l.months[i]!])),
    }).execute();
  }
}

export interface LineDto { id: number; lineNo: number; accountPrefix: string; costItemCode: string | null; departmentCode: string | null; projectCode: string | null; months: string[]; total: string; note: string | null }
export async function getBudget(trx: Trx, id: number) {
  const b = await loadBudget(trx, id);
  const rows = await sql<Record<string, string | number | null>>`SELECT l.id, l.line_no, l.account_prefix, c.code AS cost_item_code, d.code AS department_code, p.code AS project_code, l.note,
      ${sql.join(MONTHS.map((m) => sql`l.${sql.ref(m)}::text AS ${sql.ref(m)}`))}
    FROM budget_line l LEFT JOIN cost_item c ON c.id = l.cost_item_id LEFT JOIN department d ON d.id = l.department_id LEFT JOIN project p ON p.id = l.project_id
    WHERE l.budget_id = ${id} ORDER BY l.line_no`.execute(trx);
  const lines: LineDto[] = rows.rows.map((r) => {
    const months = MONTHS.map((m) => String(r[m]));
    return { id: Number(r['id']), lineNo: Number(r['line_no']), accountPrefix: String(r['account_prefix']), costItemCode: r['cost_item_code'] as string | null, departmentCode: r['department_code'] as string | null,
      projectCode: r['project_code'] as string | null, months, total: months.reduce((a, x) => a.plus(x), D(0)).toString(), note: r['note'] as string | null };
  });
  return { id: b.id, fiscalYear: b.fiscal_year, version: b.version, name: b.name, status: b.status, note: b.note, approvedAt: b.approved_at, createdAt: b.created_at, lines };
}

export async function listBudgets(trx: Trx, year?: number) {
  const r = await sql<{ id: string; fiscal_year: number; version: number; name: string; status: string; line_count: string; total: string }>`
    SELECT b.id::text, b.fiscal_year, b.version, b.name, b.status, count(l.id)::text AS line_count,
      coalesce(sum(l.m01 + l.m02 + l.m03 + l.m04 + l.m05 + l.m06 + l.m07 + l.m08 + l.m09 + l.m10 + l.m11 + l.m12), 0)::text AS total
    FROM budget b LEFT JOIN budget_line l ON l.budget_id = b.id ${year === undefined ? sql`` : sql`WHERE b.fiscal_year = ${year}`}
    GROUP BY b.id ORDER BY b.fiscal_year DESC, b.version DESC`.execute(trx);
  return r.rows.map((x) => ({ id: Number(x.id), fiscalYear: x.fiscal_year, version: x.version, name: x.name, status: x.status, lineCount: Number(x.line_count), total: x.total }));
}

const nextVersion = async (trx: Trx, year: number) => Number((await sql<{ v: string }>`SELECT (coalesce(max(version), 0) + 1)::text AS v FROM budget WHERE fiscal_year = ${year}`.execute(trx)).rows[0]!.v);

export async function createBudget(trx: Trx, ctx: { tenantId: string; userId: string }, input: BudgetIn) {
  await yearRegime(trx, input.fiscalYear);
  const b = await trx.insertInto('budget').values({ tenant_id: ctx.tenantId, fiscal_year: input.fiscalYear, version: await nextVersion(trx, input.fiscalYear), name: input.name, note: input.note ?? null, created_by: ctx.userId })
    .returning('id').executeTakeFirstOrThrow();
  await replaceLines(trx, ctx.tenantId, b.id, input.fiscalYear, input.lines);
  return getBudget(trx, b.id);
}

export async function assertDraft(trx: Trx, id: number) {
  const b = await loadBudget(trx, id);
  if (b.status !== 'draft') throw new AppError('BUDGET_NOT_DRAFT', 'Chỉ sửa ngân sách ở trạng thái nháp; hãy tạo phiên bản mới từ ngân sách đã duyệt', 409);
  return b;
}
export async function updateBudget(trx: Trx, ctx: { tenantId: string }, id: number, input: Omit<BudgetIn, 'fiscalYear'>) {
  const b = await assertDraft(trx, id);
  await trx.updateTable('budget').set({ name: input.name, note: input.note ?? null }).where('id', '=', id).execute();
  await replaceLines(trx, ctx.tenantId, id, b.fiscal_year, input.lines);
  return getBudget(trx, id);
}
export async function deleteBudget(trx: Trx, id: number) {
  await assertDraft(trx, id);
  await trx.deleteFrom('budget').where('id', '=', id).execute();
}
export async function approveBudget(trx: Trx, ctx: { userId: string }, id: number) {
  const b = await assertDraft(trx, id);
  const n = await trx.selectFrom('budget_line').select(({ fn }) => fn.countAll<string>().as('n')).where('budget_id', '=', id).executeTakeFirstOrThrow();
  if (Number(n.n) === 0) throw new AppError('BUDGET_EMPTY', 'Ngân sách chưa có dòng nào', 409);
  await trx.updateTable('budget').set({ status: 'superseded' }).where('fiscal_year', '=', b.fiscal_year).where('status', '=', 'approved').execute();
  await trx.updateTable('budget').set({ status: 'approved', approved_by: ctx.userId, approved_at: sql<string>`now()` }).where('id', '=', id).execute();
  return getBudget(trx, id);
}
// Phiên bản mới (nháp) sao từ một ngân sách có sẵn, để chỉnh sau khi đã duyệt.
export async function newVersion(trx: Trx, ctx: { tenantId: string; userId: string }, id: number) {
  const src = await getBudget(trx, id);
  return createBudget(trx, ctx, { fiscalYear: src.fiscalYear, name: src.name, note: src.note, lines: src.lines.map((l) => ({ accountPrefix: l.accountPrefix, costItemCode: l.costItemCode, departmentCode: l.departmentCode, projectCode: l.projectCode, months: l.months, note: l.note })) });
}

export const copyInput = z.object({
  fiscalYear: z.number().int().min(2000).max(2100), sourceYear: z.number().int().min(2000).max(2100), name: z.string().trim().min(1).max(200),
  factor: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Hệ số không hợp lệ (ví dụ 1.1)').default('1'),
});
// Ngân sách nháp từ số thực tế năm trước × hệ số: mỗi tài khoản doanh thu/chi phí (loại 5, 6, 7, 8) có phát sinh một dòng, theo kỳ 1..12; số âm lấy 0.
// Tài khoản bị cờ nhạy cảm che với người gọi được bỏ qua (trả trong `skipped`), không lộ số.
export async function copyFromActual(trx: Trx, ctx: { tenantId: string; userId: string }, input: z.infer<typeof copyInput>, canSee: (a: { subledger_kind: string | null; code: string }) => boolean) {
  const regime = await yearRegime(trx, input.sourceYear);
  const rows = await sql<{ code: string; subledger_kind: string | null; period_no: number; net: string }>`
    SELECT a.code, a.subledger_kind, v.period_no, sum(CASE WHEN left(a.code, 1) IN ('6', '8') THEN l.debit - l.credit ELSE l.credit - l.debit END)::text AS net
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.fiscal_year = ${input.sourceYear} AND v.period_no BETWEEN 1 AND 12 AND v.state IN ('posted', 'reversed') AND NOT v.is_closing AND a.regime = ${regime} AND left(a.code, 1) IN ('5', '6', '7', '8')
    GROUP BY a.code, a.subledger_kind, v.period_no ORDER BY a.code`.execute(trx);
  const by = new Map<string, string[]>(); const skipped = new Set<string>();
  for (const r of rows.rows) {
    if (!canSee({ subledger_kind: r.subledger_kind, code: r.code })) { skipped.add(r.code); continue; }
    const m = by.get(r.code) ?? Array<string>(12).fill('0');
    const v = D(r.net).times(input.factor).toDecimalPlaces(0);
    m[r.period_no - 1] = v.lt(0) ? '0' : v.toString(); by.set(r.code, m);
  }
  const budget = await createBudget(trx, ctx, { fiscalYear: input.fiscalYear, name: input.name, lines: [...by].map(([code, months]) => ({ accountPrefix: code, months })) });
  return { budget, skipped: [...skipped] };
}
