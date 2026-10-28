import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import type { ColumnDef } from '../master/catalogs.js';
import { buildSheetTemplate, readSheet, zodIssueVi, type ImportError } from '../master/excelSheet.js';
import { MAX_ERRORS, MAX_ROWS } from '../master/importExcel.js';
import { addAllowance, addDependent, addSalary, allowanceInput, dependentInput, profileInput, RELATIONSHIPS, saveProfile, type AllowanceInput, type DependentInput, type ProfileInput } from './profiles.js';

// Nhập Excel hồ sơ lương hàng loạt: loại riêng (không phải danh mục), cần payroll.update + view_salary. Ba sheet: Du_lieu (hồ sơ và mức lương hiện tại, một dòng một nhân viên),
// Phu_cap và Nguoi_phu_thuoc (tùy chọn, mỗi dòng một khoản). Tất cả hoặc không gì: có lỗi nào thì không ghi dòng nào.
type Trx = Transaction<Database>;
const SHEET = 'Du_lieu', ALLOWANCE_SHEET = 'Phu_cap', DEPENDENT_SHEET = 'Nguoi_phu_thuoc';
const KEY_ROW = 2, FIRST_DATA_ROW = 4;

const yn = { type: 'boolean' } as const;
export const PROFILE_COLUMNS: ColumnDef[] = [
  { key: 'employee_code', label: 'Mã nhân viên', type: 'text', required: true },
  { key: 'base_salary', label: 'Lương cơ bản (VND/tháng)', type: 'number' }, { key: 'salary_from', label: 'Lương hiệu lực từ ngày', type: 'date' },
  { key: 'pay_method', label: 'Hình thức trả', type: 'select', options: [{ value: 'transfer', label: 'Chuyển khoản' }, { value: 'cash', label: 'Tiền mặt' }] },
  { key: 'bank_code', label: 'Mã ngân hàng', type: 'text' }, { key: 'bank_name', label: 'Tên ngân hàng', type: 'text' },
  { key: 'bank_account_no', label: 'Số tài khoản nhận lương', type: 'text' }, { key: 'bank_account_name', label: 'Tên chủ tài khoản', type: 'text' },
  { key: 'tax_residency', label: 'Cư trú thuế', type: 'select', options: [{ value: 'resident', label: 'Cư trú' }, { value: 'non_resident', label: 'Không cư trú' }] },
  { key: 'contract_type', label: 'Loại hợp đồng lao động', type: 'select', options: [{ value: 'long', label: 'Từ 3 tháng trở lên' }, { value: 'short', label: 'Dưới 3 tháng' }, { value: 'none', label: 'Không hợp đồng' }] },
  { key: 'start_date', label: 'Ngày bắt đầu làm việc', type: 'date' }, { key: 'end_date', label: 'Ngày nghỉ việc', type: 'date' },
  { key: 'region', label: 'Vùng (I–IV)', type: 'select', options: ['I', 'II', 'III', 'IV'].map((v) => ({ value: v, label: `Vùng ${v}` })) },
  { key: 'si_no', label: 'Mã số BHXH', type: 'text' },
  { key: 'si_participates', label: 'Tham gia BHXH', ...yn }, { key: 'hi_participates', label: 'Tham gia BHYT', ...yn }, { key: 'ui_participates', label: 'Tham gia BHTN', ...yn },
  { key: 'occupational_participates', label: 'Tham gia BH TNLĐ-BNN', ...yn },
  { key: 'si_salary', label: 'Mức lương đóng bảo hiểm (để trống = theo lương)', type: 'number' },
  { key: 'union_employer', label: 'Đóng kinh phí công đoàn', ...yn }, { key: 'union_member', label: 'Là đoàn viên', ...yn }, { key: 'pit_authorized', label: 'Ủy quyền quyết toán thuế TNCN', ...yn },
  { key: 'default_project_code', label: 'Vụ việc mặc định', type: 'text', lookup: { catalog: 'project' } }, { key: 'note', label: 'Ghi chú', type: 'text' },
];
export const ALLOWANCE_COLUMNS: ColumnDef[] = [
  { key: 'employee_code', label: 'Mã nhân viên', type: 'text', required: true }, { key: 'code', label: 'Mã phụ cấp', type: 'text', required: true }, { key: 'name', label: 'Tên phụ cấp', type: 'text', required: true },
  { key: 'amount', label: 'Số tiền (VND/tháng)', type: 'number', required: true }, { key: 'taxable', label: 'Chịu thuế TNCN', ...yn }, { key: 'si_base', label: 'Tính vào lương đóng bảo hiểm', ...yn },
  { key: 'valid_from', label: 'Hiệu lực từ ngày', type: 'date' }, { key: 'valid_to', label: 'Hiệu lực đến ngày', type: 'date' },
];
export const DEPENDENT_COLUMNS: ColumnDef[] = [
  { key: 'employee_code', label: 'Mã nhân viên', type: 'text', required: true }, { key: 'name', label: 'Họ tên người phụ thuộc', type: 'text', required: true },
  { key: 'relationship', label: 'Quan hệ', type: 'select', required: true, options: Object.entries(RELATIONSHIPS).map(([value, label]) => ({ value, label })) },
  { key: 'tax_code', label: 'MST', type: 'text' }, { key: 'id_number', label: 'Số CCCD', type: 'text' }, { key: 'birth_date', label: 'Ngày sinh', type: 'date' },
  { key: 'from_month', label: 'Từ tháng (YYYY-MM)', type: 'text', required: true }, { key: 'to_month', label: 'Đến tháng (YYYY-MM)', type: 'text' },
];

const example = (c: ColumnDef): string | number | boolean | null => c.type === 'boolean' ? true : c.type === 'number' ? 0 : c.type === 'date' ? '2026-01-01' : c.options ? c.options[0]!.value
  : c.key === 'employee_code' ? 'NV01' : c.key === 'code' ? 'an_trua' : c.key.endsWith('_month') ? '2026-01' : `Ví dụ ${c.label.toLowerCase()}`;

export function buildProfileTemplate(): Promise<Buffer> {
  return buildSheetTemplate({
    sheet: SHEET, columns: PROFILE_COLUMNS, example, keyRow: KEY_ROW, extra: [{ sheet: ALLOWANCE_SHEET, columns: ALLOWANCE_COLUMNS }, { sheet: DEPENDENT_SHEET, columns: DEPENDENT_COLUMNS }],
    help: [
      ['Mẫu nhập hồ sơ lương nhân viên'],
      ['Sheet Du_lieu: một dòng một nhân viên (mã nhân viên phải có trong danh mục Nhân viên, chưa có hồ sơ lương). Sheet Phu_cap và Nguoi_phu_thuoc là tùy chọn, mỗi dòng một khoản.'],
      ['Dòng 1: tên cột (cột có (*) bắt buộc). Dòng 3 là ví dụ và luôn bị bỏ qua. Nhập dữ liệu từ dòng 4. Cột tham gia bảo hiểm để trống là không tham gia. Có lương cơ bản thì cần ngày hiệu lực (mặc định lấy ngày bắt đầu làm việc).'],
      ['Có lỗi ở bất kỳ dòng nào thì không nhập dòng nào. Ngày dạng YYYY-MM-DD hoặc dd/MM/yyyy; tháng dạng YYYY-MM.'],
      ...[[SHEET, PROFILE_COLUMNS], [ALLOWANCE_SHEET, ALLOWANCE_COLUMNS], [DEPENDENT_SHEET, DEPENDENT_COLUMNS]].flatMap(([sheet, cols]) =>
        (cols as ColumnDef[]).map((c) => [sheet as string, c.key, c.label, c.type, c.required ? 'bắt buộc' : '', c.options ? c.options.map((o) => `${o.value}=${o.label}`).join('; ') : ''])),
    ],
  });
}

// Lược đồ từng dòng theo khóa Excel; chuyển sang đầu vào của dịch vụ ở các hàm toXxx.
const opt = z.string().trim().nullish();
const profileRow = z.object({
  employee_code: z.string().trim().min(1), base_salary: opt, salary_from: opt, pay_method: z.enum(['transfer', 'cash']).optional(), bank_code: opt, bank_name: opt, bank_account_no: opt, bank_account_name: opt,
  tax_residency: z.enum(['resident', 'non_resident']).optional(), contract_type: z.enum(['long', 'short', 'none']).optional(), start_date: opt, end_date: opt, region: z.enum(['I', 'II', 'III', 'IV']).optional(), si_no: opt,
  si_participates: z.boolean().optional(), hi_participates: z.boolean().optional(), ui_participates: z.boolean().optional(), occupational_participates: z.boolean().optional(),
  si_salary: opt, union_employer: z.boolean().optional(), union_member: z.boolean().optional(), pit_authorized: z.boolean().optional(), default_project_code: opt, note: opt,
}).strict();
const allowanceRow = z.object({ employee_code: z.string().trim().min(1), code: z.string(), name: z.string(), amount: z.string(), taxable: z.boolean().optional(), si_base: z.boolean().optional(), valid_from: opt, valid_to: opt }).strict();
const dependentRow = z.object({
  employee_code: z.string().trim().min(1), name: z.string(), relationship: z.enum(Object.keys(RELATIONSHIPS) as [string, ...string[]]), tax_code: opt, id_number: opt, birth_date: opt, from_month: z.string(), to_month: opt,
}).strict();
// Ô tháng bị Excel đổi thành ngày (2026-03-01) vẫn nhận: lấy 7 ký tự đầu.
const monthOf = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(0, 7) : s ?? null);

export interface ParsedProfiles {
  profiles: { row: number; code: string; projectCode: string | null; salary: { validFrom: string; monthlySalary: string } | null; input: ProfileInput }[];
  allowances: { row: number; code: string; input: AllowanceInput }[];
  dependents: { row: number; code: string; input: DependentInput }[];
  errors: ImportError[];
}

// Đọc một sheet, kiểm từng dòng bằng lược đồ và `convert` (ném zod lỗi). Lỗi ghi theo dòng/cột kèm tên sheet khi không phải sheet chính.
async function readRows<R>(buf: Buffer, sheet: string, columns: ColumnDef[], schema: z.ZodType<Record<string, unknown>>, optional: boolean, errors: ImportError[],
  convert: (row: number, v: Record<string, unknown>) => R, tag: string): Promise<R[]> {
  let sh;
  try { sh = await readSheet(buf, { sheet, keyRow: KEY_ROW, firstDataRow: FIRST_DATA_ROW, maxRows: MAX_ROWS, columns, strictKeys: true, optional }); } catch (e) {
    if (e instanceof AppError && e.code === 'IMPORT_BAD_TEMPLATE') throw new AppError(e.code, 'File không đúng mẫu hồ sơ lương', 400);
    throw e;
  }
  const label = (key: string) => columns.find((c) => c.key === key)?.label ?? key;
  const at = (e: ImportError): ImportError => (tag ? { ...e, message: `${tag}: ${e.message}` } : e);
  const bad = new Set(sh.errors.map((e) => e.row));
  errors.push(...sh.errors.map(at));
  const out: R[] = [];
  for (const { row, values } of sh.rows) {
    if (bad.has(row)) continue;
    const p = schema.safeParse(values);
    if (!p.success) { for (const i of p.error.issues) errors.push(at({ row, column: String(i.path[0] ?? columns[0]!.key), message: zodIssueVi(i, label(String(i.path[0] ?? ''))) })); continue; }
    try { out.push(convert(row, p.data)); } catch (e) {
      if (!(e instanceof z.ZodError)) throw e;
      for (const i of e.issues) errors.push(at({ row, column: columns.find((c) => c.key === snake(String(i.path[0])))?.key ?? columns[0]!.key, message: zodIssueVi(i, label(snake(String(i.path[0] ?? '')))) }));
    }
  }
  return out;
}
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

export async function parseProfileWorkbook(buf: Buffer): Promise<ParsedProfiles> {
  const errors: ImportError[] = [];
  const seen = new Map<string, number>();
  const profiles = (await readRows(buf, SHEET, PROFILE_COLUMNS, profileRow, false, errors, (row, v) => {
    const r = v as z.infer<typeof profileRow>;
    const input = profileInput.parse({
      payMethod: r.pay_method, bankCode: r.bank_code, bankName: r.bank_name, bankAccountNo: r.bank_account_no, bankAccountName: r.bank_account_name, taxResidency: r.tax_residency, contractType: r.contract_type,
      startDate: r.start_date, endDate: r.end_date, region: r.region, siNo: r.si_no, siParticipates: r.si_participates, hiParticipates: r.hi_participates, uiParticipates: r.ui_participates,
      occupationalParticipates: r.occupational_participates, siSalary: r.si_salary, unionEmployer: r.union_employer, unionMember: r.union_member, pitAuthorized: r.pit_authorized, note: r.note,
    });
    let salary = null;
    if (r.base_salary) {
      const from = r.salary_from ?? input.startDate;
      if (!from) throw new z.ZodError([{ code: 'custom', path: ['salaryFrom'], message: 'Có lương cơ bản thì phải nhập ngày hiệu lực (hoặc ngày bắt đầu làm việc)' }]);
      salary = { validFrom: from, monthlySalary: r.base_salary };
    } else if (r.salary_from) throw new z.ZodError([{ code: 'custom', path: ['baseSalary'], message: 'Có ngày hiệu lực thì phải nhập lương cơ bản' }]);
    return { row, code: r.employee_code, projectCode: r.default_project_code ?? null, salary, input };
  }, '')).filter((p) => {
    if (seen.has(p.code)) { errors.push({ row: p.row, column: 'employee_code', message: `Trùng với dòng ${seen.get(p.code)}` }); return false; }
    seen.set(p.code, p.row); return true;
  });
  const allowances = await readRows(buf, ALLOWANCE_SHEET, ALLOWANCE_COLUMNS, allowanceRow, true, errors, (row, v) => {
    const r = v as z.infer<typeof allowanceRow>;
    return { row, code: r.employee_code, input: allowanceInput.parse({ code: r.code.trim(), name: r.name, amount: r.amount, taxable: r.taxable, siBase: r.si_base, validFrom: r.valid_from, validTo: r.valid_to }) };
  }, 'Phụ cấp');
  const dependents = await readRows(buf, DEPENDENT_SHEET, DEPENDENT_COLUMNS, dependentRow, true, errors, (row, v) => {
    const r = v as z.infer<typeof dependentRow>;
    return { row, code: r.employee_code, input: dependentInput.parse({ name: r.name, relationship: r.relationship, taxCode: r.tax_code, idNumber: r.id_number, birthDate: r.birth_date, fromMonth: monthOf(r.from_month), toMonth: monthOf(r.to_month) }) };
  }, 'Người phụ thuộc');
  return { profiles, allowances, dependents, errors };
}

export interface ImportCounts { profiles: number; allowances: number; dependents: number }
// Ghi tất cả hoặc không gì: lỗi nghiệp vụ từng dòng (nhân viên không có, đã có hồ sơ, người phụ thuộc trùng khoảng...) gom lại; có lỗi thì ném IMPORT_ERRORS và giao dịch của người gọi hoàn tác.
// Mọi kiểm tra ném AppError trước khi ghi câu lệnh nào của dòng đó nên giao dịch PostgreSQL không bị hỏng giữa chừng.
export async function importProfiles(trx: Trx, tenantId: string, p: ParsedProfiles, errors: ImportError[]): Promise<ImportCounts> {
  const codes = [...new Set([...p.profiles, ...p.allowances, ...p.dependents].map((r) => r.code))];
  const emp = new Map((codes.length ? await trx.selectFrom('employee').select(['id', 'code']).where('code', 'in', codes).execute() : []).map((e) => [e.code, e.id]));
  const projCodes = [...new Set(p.profiles.flatMap((r) => (r.projectCode ? [r.projectCode] : [])))];
  const proj = new Map((projCodes.length ? await trx.selectFrom('project').select(['id', 'code']).where('code', 'in', projCodes).execute() : []).map((e) => [e.code, e.id]));
  const has = new Set((await trx.selectFrom('employee_payroll').select('employee_id').execute()).map((r) => r.employee_id));
  const counts: ImportCounts = { profiles: 0, allowances: 0, dependents: 0 };
  const attempt = async (row: number, column: string, tag: string, f: () => Promise<void>) => {
    try { await f(); } catch (e) {
      if (!(e instanceof AppError)) throw e;
      errors.push({ row, column, message: tag ? `${tag}: ${e.message}` : e.message });
    }
  };
  const need = (code: string) => { const id = emp.get(code); if (id === undefined) throw new AppError('EMPLOYEE_NOT_FOUND', `Không có nhân viên mã "${code}" trong danh mục Nhân viên`, 404); return id; };

  for (const r of p.profiles) await attempt(r.row, 'employee_code', '', async () => {
    const id = need(r.code);
    if (has.has(id)) throw new AppError('PROFILE_EXISTS', 'Nhân viên đã có hồ sơ lương (nhập hàng loạt chỉ tạo mới)', 409);
    let projectId: number | null = null;
    if (r.projectCode) { projectId = proj.get(r.projectCode) ?? null; if (projectId === null) throw new AppError('PROJECT_NOT_FOUND', `Không có vụ việc mã "${r.projectCode}"`, 404); }
    await saveProfile(trx, tenantId, id, { ...r.input, defaultProjectId: projectId });
    if (r.salary) await addSalary(trx, tenantId, id, { validFrom: r.salary.validFrom, monthlySalary: r.salary.monthlySalary, note: null });
    has.add(id); counts.profiles++;
  });
  for (const r of p.allowances) await attempt(r.row, 'code', 'Phụ cấp', async () => { await addAllowance(trx, tenantId, need(r.code), r.input); counts.allowances++; });
  for (const r of p.dependents) await attempt(r.row, 'name', 'Người phụ thuộc', async () => { await addDependent(trx, tenantId, need(r.code), r.input); counts.dependents++; });
  if (errors.length) throw new AppError('IMPORT_ERRORS', `${errors.length} dòng lỗi`, 409, [...errors].sort((a, b) => a.row - b.row).slice(0, MAX_ERRORS));
  return counts;
}
