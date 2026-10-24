import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, todayVn, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { dateIso } from '../master/catalogs.js';
import { likePattern } from '../master/crud.js';

type Trx = Kysely<Database> | Transaction<Database>;

// Bảng hồ sơ lương: nhật ký kiểm toán của các bảng này che khi thiếu view_salary (audit/routes.ts). Task sau thêm bảng lương, chấm công... vào đây.
export const SALARY_AUDIT_ENTITIES = ['employee_payroll', 'employee_allowance', 'employee_salary_history', 'employee_dependent', 'employee_cost_split'];

const vnd = z.string().regex(VND_AMOUNT_RE, 'Số tiền VND phải là số nguyên không âm tối đa 16 chữ số');
const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Tháng phải dạng YYYY-MM');
const flag = z.boolean().default(false);
const id = z.coerce.number().int().positive();

export const profileInput = z.object({
  payMethod: z.enum(['cash', 'transfer']).default('transfer'),
  bankCode: opt(30), bankName: opt(200), bankAccountNo: opt(50), bankAccountName: opt(200),
  taxResidency: z.enum(['resident', 'non_resident']).default('resident'),
  contractType: z.enum(['long', 'short', 'none']).default('long'),
  startDate: dateIso.nullish().transform((v) => v ?? null), endDate: dateIso.nullish().transform((v) => v ?? null),
  region: z.enum(['I', 'II', 'III', 'IV']).nullish().transform((v) => v ?? null),
  siNo: opt(30),
  siParticipates: flag, hiParticipates: flag, uiParticipates: flag, occupationalParticipates: flag,
  siSalary: vnd.nullish().transform((v) => v ?? null), // rỗng = đóng theo lương
  unionEmployer: flag, unionMember: flag, pitAuthorized: flag,
  defaultProjectId: id.nullish().transform((v) => v ?? null),
  note: opt(500),
}).strict().refine((b) => !b.startDate || !b.endDate || b.endDate >= b.startDate, { path: ['endDate'], message: 'Ngày nghỉ việc phải sau hoặc bằng ngày bắt đầu' });
export type ProfileInput = z.infer<typeof profileInput>;

export const allowanceInput = z.object({
  code: z.string().regex(/^[a-z0-9_]+$/, 'Mã phụ cấp chỉ gồm chữ thường không dấu, số, gạch dưới').max(40), name: z.string().trim().min(1, 'Nhập tên phụ cấp').max(200),
  amount: vnd, taxable: z.boolean().default(true), siBase: z.boolean().default(false),
  validFrom: dateIso.nullish().transform((v) => v ?? null), validTo: dateIso.nullish().transform((v) => v ?? null),
}).strict().refine((b) => !b.validFrom || !b.validTo || b.validTo >= b.validFrom, { path: ['validTo'], message: 'Ngày hết hiệu lực phải sau hoặc bằng ngày bắt đầu' });
export type AllowanceInput = z.infer<typeof allowanceInput>;

export const RELATIONSHIPS = { child: 'Con', spouse: 'Vợ/chồng', father: 'Cha', mother: 'Mẹ', sibling: 'Anh chị em ruột', other: 'Khác' } as const;
export const dependentInput = z.object({
  name: z.string().trim().min(1, 'Nhập họ tên người phụ thuộc').max(200), relationship: z.enum(Object.keys(RELATIONSHIPS) as [keyof typeof RELATIONSHIPS, ...(keyof typeof RELATIONSHIPS)[]]),
  taxCode: opt(20), idNumber: opt(20), birthDate: dateIso.nullish().transform((v) => v ?? null),
  fromMonth: month, toMonth: month.nullish().transform((v) => v ?? null), note: opt(500),
}).strict().refine((b) => !b.toMonth || b.toMonth >= b.fromMonth, { path: ['toMonth'], message: 'Đến tháng phải sau hoặc bằng từ tháng' });
export type DependentInput = z.infer<typeof dependentInput>;

export const salaryInput = z.object({ validFrom: dateIso, monthlySalary: vnd, note: opt(500) }).strict();
export type SalaryInput = z.infer<typeof salaryInput>;

export const costSplitInput = z.object({
  items: z.array(z.object({ projectId: id, pct: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Tỷ lệ tối đa 4 chữ số thập phân') }).strict()).max(200),
}).strict().superRefine((b, ctx) => {
  if (new Set(b.items.map((i) => i.projectId)).size !== b.items.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Một vụ việc chỉ xuất hiện một lần' });
  if (b.items.some((i) => D(i.pct).lte(0) || D(i.pct).gt(100))) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Tỷ lệ mỗi vụ việc phải lớn hơn 0 và không quá 100' });
  if (b.items.length && !b.items.reduce((s, i) => s.plus(i.pct), D(0)).eq(100)) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Tổng tỷ lệ phân bổ phải bằng 100%' });
});

// Hai khoảng [a1,a2], [b1,b2] (đầu mút rỗng = vô hạn) có chung điểm nào không; so chuỗi ISO/tháng theo thứ tự chữ.
const overlaps = (a1: string | null, a2: string | null, b1: string | null, b2: string | null) => (a2 === null || b1 === null || b1 <= a2) && (b2 === null || a1 === null || a1 <= b2);
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
// Cùng một người: trùng MST, hoặc (cả hai không có MST) trùng CCCD, hoặc (cả hai không có cả hai) trùng họ tên và quan hệ. Có định danh khác nhau thì là hai người.
type Person = { name: string; relationship: string; tax_code: string | null; id_number: string | null };
const samePerson = (a: Person, b: Person) =>
  a.tax_code && b.tax_code ? a.tax_code === b.tax_code
    : a.id_number && b.id_number ? a.id_number === b.id_number
      : norm(a.name) === norm(b.name) && a.relationship === b.relationship;

// Móc cho Task 5: bảng lương calculated|posted đã dùng mức lương hiệu lực từ ngày này chưa. Có dòng bảng lương của nhân viên ở tháng từ tháng của validFrom trở đi thì thêm/xóa dòng lịch sử lương
// làm đổi số đã tính nên bị chặn (409 SALARY_HISTORY_USED). Hiện chưa có bảng lương nên luôn false; Task 5 thay thân hàm bằng truy vấn payroll_line.
export const salaryUse = {
  used: async (_trx: Trx, _employeeId: number, _validFrom: string): Promise<boolean> => false,
};

const notFound = (code: string, msg: string) => new AppError(code, msg, 404);
async function employeeOf(trx: Trx, employeeId: number) {
  const e = await trx.selectFrom('employee as e').leftJoin('department as d', 'd.id', 'e.department_id')
    .select(['e.id', 'e.code', 'e.name', 'e.tax_code', 'e.id_number', 'e.position', 'd.name as department_name']).where('e.id', '=', employeeId).executeTakeFirst();
  if (!e) throw notFound('EMPLOYEE_NOT_FOUND', 'Không tìm thấy nhân viên');
  return e;
}
async function assertProject(trx: Trx, projectId: number | null) {
  if (projectId !== null && !(await trx.selectFrom('project').select('id').where('id', '=', projectId).executeTakeFirst())) throw notFound('PROJECT_NOT_FOUND', 'Không tìm thấy vụ việc');
}

const profileDto = (r: Selectable<Database['employee_payroll']>) => ({
  payMethod: r.pay_method, bankCode: r.bank_code, bankName: r.bank_name, bankAccountNo: r.bank_account_no, bankAccountName: r.bank_account_name,
  taxResidency: r.tax_residency, contractType: r.contract_type, startDate: r.start_date, endDate: r.end_date, region: r.region, siNo: r.si_no,
  siParticipates: r.si_participates, hiParticipates: r.hi_participates, uiParticipates: r.ui_participates, occupationalParticipates: r.occupational_participates,
  siSalary: r.si_salary, unionEmployer: r.union_employer, unionMember: r.union_member, pitAuthorized: r.pit_authorized, defaultProjectId: r.default_project_id, note: r.note,
});
const allowanceDto = (r: Selectable<Database['employee_allowance']>) => ({ id: r.id, code: r.code, name: r.name, amount: r.amount, taxable: r.taxable, siBase: r.si_base, validFrom: r.valid_from, validTo: r.valid_to });
const dependentDto = (r: Selectable<Database['employee_dependent']>) => ({ id: r.id, name: r.name, relationship: r.relationship, taxCode: r.tax_code, idNumber: r.id_number, birthDate: r.birth_date, fromMonth: r.from_month, toMonth: r.to_month, note: r.note });
const salaryDto = (r: Selectable<Database['employee_salary_history']>) => ({ id: r.id, validFrom: r.valid_from, monthlySalary: r.monthly_salary, note: r.note });

export async function listProfiles(trx: Trx, q: { q?: string | undefined; active: 'true' | 'false' | 'all'; size: number }) {
  const today = todayVn();
  let b = trx.selectFrom('employee as e').leftJoin('employee_payroll as p', 'p.employee_id', 'e.id').leftJoin('department as d', 'd.id', 'e.department_id')
    .select(['e.id', 'e.code', 'e.name', 'e.is_active', 'd.name as department_name', 'p.id as profile_id', 'p.start_date', 'p.end_date',
      sql<string | null>`(SELECT h.monthly_salary FROM employee_salary_history h WHERE h.tenant_id = e.tenant_id AND h.employee_id = e.id AND h.valid_from <= ${today}::date ORDER BY h.valid_from DESC LIMIT 1)`.as('current_salary')]);
  if (q.active !== 'all') b = b.where('e.is_active', '=', q.active === 'true');
  if (q.q) { const p = likePattern(q.q); b = b.where(sql<boolean>`(e.code ILIKE ${p} ESCAPE '\\' OR e.name ILIKE ${p} ESCAPE '\\')`); }
  const rows = await b.orderBy('e.code').limit(q.size).execute();
  return rows.map((r) => ({ employeeId: r.id, code: r.code, name: r.name, departmentName: r.department_name, isActive: r.is_active, hasProfile: r.profile_id !== null, startDate: r.start_date, endDate: r.end_date, currentSalary: r.current_salary }));
}

export async function getProfile(trx: Trx, employeeId: number) {
  const e = await employeeOf(trx, employeeId);
  const [p, allowances, dependents, history, split] = await Promise.all([
    trx.selectFrom('employee_payroll').selectAll().where('employee_id', '=', employeeId).executeTakeFirst(),
    trx.selectFrom('employee_allowance').selectAll().where('employee_id', '=', employeeId).orderBy('code').orderBy('valid_from').execute(),
    trx.selectFrom('employee_dependent').selectAll().where('employee_id', '=', employeeId).orderBy('from_month').orderBy('id').execute(),
    trx.selectFrom('employee_salary_history').selectAll().where('employee_id', '=', employeeId).orderBy('valid_from', 'desc').execute(),
    trx.selectFrom('employee_cost_split as s').innerJoin('project as j', 'j.id', 's.project_id').select(['s.project_id', 's.pct', 'j.code', 'j.name']).where('s.employee_id', '=', employeeId).orderBy('j.code').execute(),
  ]);
  const today = todayVn();
  return {
    employee: { id: e.id, code: e.code, name: e.name, taxCode: e.tax_code, idNumber: e.id_number, position: e.position, departmentName: e.department_name },
    profile: p ? profileDto(p) : null,
    allowances: allowances.map((r) => allowanceDto(r)), dependents: dependents.map((r) => dependentDto(r)),
    salaryHistory: history.map((r) => salaryDto(r)), currentSalary: history.find((h) => h.valid_from <= today)?.monthly_salary ?? null,
    costSplit: split.map((r) => ({ projectId: r.project_id, projectCode: r.code, projectName: r.name, pct: r.pct })),
  };
}

export async function saveProfile(trx: Trx, tenantId: string, employeeId: number, b: ProfileInput) {
  await employeeOf(trx, employeeId);
  await assertProject(trx, b.defaultProjectId);
  const v = {
    pay_method: b.payMethod, bank_code: b.bankCode, bank_name: b.bankName, bank_account_no: b.bankAccountNo, bank_account_name: b.bankAccountName,
    tax_residency: b.taxResidency, contract_type: b.contractType, start_date: b.startDate, end_date: b.endDate, region: b.region, si_no: b.siNo,
    si_participates: b.siParticipates, hi_participates: b.hiParticipates, ui_participates: b.uiParticipates, occupational_participates: b.occupationalParticipates,
    si_salary: b.siSalary, union_employer: b.unionEmployer, union_member: b.unionMember, pit_authorized: b.pitAuthorized, default_project_id: b.defaultProjectId, note: b.note,
  };
  const row = await trx.insertInto('employee_payroll').values({ tenant_id: tenantId, employee_id: employeeId, ...v })
    .onConflict((oc) => oc.columns(['tenant_id', 'employee_id']).doUpdateSet({ ...v, updated_at: sql`now()` })).returningAll().executeTakeFirstOrThrow();
  return profileDto(row);
}

export async function addAllowance(trx: Trx, tenantId: string, employeeId: number, b: AllowanceInput) {
  await employeeOf(trx, employeeId);
  await assertAllowance(trx, employeeId, b, null);
  const row = await trx.insertInto('employee_allowance').values({ tenant_id: tenantId, employee_id: employeeId, code: b.code, name: b.name, amount: b.amount, taxable: b.taxable, si_base: b.siBase, valid_from: b.validFrom, valid_to: b.validTo })
    .returningAll().executeTakeFirstOrThrow();
  return allowanceDto(row);
}
export async function updateAllowance(trx: Trx, employeeId: number, allowanceId: number, b: AllowanceInput) {
  await assertAllowance(trx, employeeId, b, allowanceId);
  const row = await trx.updateTable('employee_allowance').set({ code: b.code, name: b.name, amount: b.amount, taxable: b.taxable, si_base: b.siBase, valid_from: b.validFrom, valid_to: b.validTo })
    .where('id', '=', allowanceId).where('employee_id', '=', employeeId).returningAll().executeTakeFirst();
  if (!row) throw notFound('ALLOWANCE_NOT_FOUND', 'Không tìm thấy phụ cấp');
  return allowanceDto(row);
}
export async function deleteAllowance(trx: Trx, employeeId: number, allowanceId: number) {
  if (!(await trx.deleteFrom('employee_allowance').where('id', '=', allowanceId).where('employee_id', '=', employeeId).executeTakeFirst()).numDeletedRows) throw notFound('ALLOWANCE_NOT_FOUND', 'Không tìm thấy phụ cấp');
}
// Cùng mã phụ cấp không có hai khoảng hiệu lực chồng nhau (sẽ tính trùng).
async function assertAllowance(trx: Trx, employeeId: number, b: AllowanceInput, selfId: number | null) {
  const same = await trx.selectFrom('employee_allowance').select(['id', 'valid_from', 'valid_to']).where('employee_id', '=', employeeId).where('code', '=', b.code).execute();
  if (same.some((r) => r.id !== selfId && overlaps(r.valid_from, r.valid_to, b.validFrom, b.validTo)))
    throw new AppError('ALLOWANCE_OVERLAP', `Phụ cấp "${b.code}" đã có khoảng hiệu lực trùng với khoảng này`, 409);
}

export async function addDependent(trx: Trx, tenantId: string, employeeId: number, b: DependentInput) {
  await employeeOf(trx, employeeId);
  await assertDependent(trx, tenantId, employeeId, b, null);
  const row = await trx.insertInto('employee_dependent').values({ tenant_id: tenantId, employee_id: employeeId, name: b.name, relationship: b.relationship, tax_code: b.taxCode, id_number: b.idNumber, birth_date: b.birthDate, from_month: b.fromMonth, to_month: b.toMonth, note: b.note })
    .returningAll().executeTakeFirstOrThrow();
  return dependentDto(row);
}
export async function updateDependent(trx: Trx, tenantId: string, employeeId: number, dependentId: number, b: DependentInput) {
  await assertDependent(trx, tenantId, employeeId, b, dependentId);
  const row = await trx.updateTable('employee_dependent').set({ name: b.name, relationship: b.relationship, tax_code: b.taxCode, id_number: b.idNumber, birth_date: b.birthDate, from_month: b.fromMonth, to_month: b.toMonth, note: b.note })
    .where('id', '=', dependentId).where('employee_id', '=', employeeId).returningAll().executeTakeFirst();
  if (!row) throw notFound('DEPENDENT_NOT_FOUND', 'Không tìm thấy người phụ thuộc');
  return dependentDto(row);
}
export async function deleteDependent(trx: Trx, employeeId: number, dependentId: number) {
  if (!(await trx.deleteFrom('employee_dependent').where('id', '=', dependentId).where('employee_id', '=', employeeId).executeTakeFirst()).numDeletedRows) throw notFound('DEPENDENT_NOT_FOUND', 'Không tìm thấy người phụ thuộc');
}
// Một người phụ thuộc chỉ được tính giảm trừ một lần trong mỗi tháng cho cùng nhân viên: nhận diện bằng MST, CCCD hoặc (họ tên + quan hệ).
async function assertDependent(trx: Trx, tenantId: string, employeeId: number, b: DependentInput, selfId: number | null) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':employee_dependent:' + employeeId}, 0))`.execute(trx); // hai người nhập cùng lúc không lọt trùng khoảng
  const mine = { name: b.name, relationship: b.relationship, tax_code: b.taxCode, id_number: b.idNumber };
  const clash = (await trx.selectFrom('employee_dependent').selectAll().where('employee_id', '=', employeeId).execute())
    .find((r) => r.id !== selfId && samePerson(r, mine) && overlaps(r.from_month, r.to_month, b.fromMonth, b.toMonth));
  if (clash) throw new AppError('DEPENDENT_OVERLAP', `Người phụ thuộc "${clash.name}" đã được tính giảm trừ cho nhân viên này trong khoảng tháng trùng (từ ${clash.from_month}${clash.to_month ? ` đến ${clash.to_month}` : ''})`, 409);
}

export async function addSalary(trx: Trx, tenantId: string, employeeId: number, b: SalaryInput) {
  await employeeOf(trx, employeeId);
  if (await trx.selectFrom('employee_salary_history').select('id').where('employee_id', '=', employeeId).where('valid_from', '=', b.validFrom).executeTakeFirst())
    throw new AppError('SALARY_HISTORY_DUPLICATE', 'Đã có mức lương hiệu lực từ ngày này; xóa dòng cũ rồi nhập lại nếu cần sửa', 409);
  if (await salaryUse.used(trx, employeeId, b.validFrom)) throw new AppError('SALARY_HISTORY_USED', 'Bảng lương đã tính từ kỳ này trở đi nên không thêm mức lương hiệu lực từ ngày này; hủy hạch toán và tính lại bảng lương trước', 409);
  const row = await trx.insertInto('employee_salary_history').values({ tenant_id: tenantId, employee_id: employeeId, valid_from: b.validFrom, monthly_salary: b.monthlySalary, note: b.note }).returningAll().executeTakeFirstOrThrow();
  return salaryDto(row);
}
export async function deleteSalary(trx: Trx, employeeId: number, historyId: number) {
  const r = await trx.selectFrom('employee_salary_history').select('valid_from').where('id', '=', historyId).where('employee_id', '=', employeeId).executeTakeFirst();
  if (!r) throw notFound('SALARY_HISTORY_NOT_FOUND', 'Không tìm thấy mức lương');
  if (await salaryUse.used(trx, employeeId, r.valid_from)) throw new AppError('SALARY_HISTORY_USED', 'Mức lương này đã được bảng lương dùng nên không xóa được', 409);
  await trx.deleteFrom('employee_salary_history').where('id', '=', historyId).execute();
}

export async function saveCostSplit(trx: Trx, tenantId: string, employeeId: number, b: z.infer<typeof costSplitInput>) {
  await employeeOf(trx, employeeId);
  if (b.items.length) {
    const found = new Set((await trx.selectFrom('project').select('id').where('id', 'in', b.items.map((i) => i.projectId)).execute()).map((r) => r.id));
    const missing = b.items.find((i) => !found.has(i.projectId));
    if (missing) throw notFound('PROJECT_NOT_FOUND', `Không tìm thấy vụ việc (id ${missing.projectId})`);
  }
  await trx.deleteFrom('employee_cost_split').where('employee_id', '=', employeeId).execute();
  if (b.items.length) await trx.insertInto('employee_cost_split').values(b.items.map((i) => ({ tenant_id: tenantId, employee_id: employeeId, project_id: i.projectId, pct: i.pct }))).execute();
  return (await getProfile(trx, employeeId)).costSplit;
}
