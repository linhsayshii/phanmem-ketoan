import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { DEFAULT_PAYROLL_STRUCTURE, validateStructure, type PayrollColumn } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

type Trx = Transaction<Database>;

// Cấu trúc bảng lương: danh sách cột PayrollColumn (jsonb) + cách tính lương theo ngày công. Kiểm bằng validateStructure (PayrollError → 400 qua bộ xử lý lỗi chung).
const column = z.object({
  code: z.string().max(40), name: z.string().trim().min(1, 'Nhập tên cột').max(200), kind: z.enum(['builtin', 'input', 'formula']),
  formula: z.string().max(2000).optional(), round: z.number().int().min(0).max(6).optional(),
  income: z.boolean().optional(), taxable: z.boolean().optional(), siBase: z.boolean().optional(), pitRelief: z.boolean().optional(), deduct: z.boolean().optional(),
}).strict();
export const prorationEnum = z.enum(['calendar', 'standard_26', 'standard_22', 'fixed']);
export const structureBody = z.object({ proration: prorationEnum.default('calendar'), columns: z.array(column).min(1).max(200) }).strict();
export const structureInput = structureBody.extend({
  code: z.string().trim().min(1, 'Nhập mã cấu trúc').max(30), name: z.string().trim().min(1, 'Nhập tên cấu trúc').max(200), note: z.string().trim().max(500).nullish().transform((v) => v || null),
}).strict();
export const cloneInput = z.object({ code: z.string().trim().min(1).max(30), name: z.string().trim().min(1).max(200) }).strict();
export type StructureInput = z.infer<typeof structureInput>;

export const DEFAULT_STRUCTURE_CODE = 'LUONG_CO_BAN';

const dto = (r: Selectable<Database['payroll_structure']>, inUse: boolean) => ({
  id: r.id, code: r.code, name: r.name, proration: r.proration, isDefault: r.is_default, parentId: r.parent_id, note: r.note,
  columns: r.columns as PayrollColumn[], inUse, createdAt: r.created_at, updatedAt: r.updated_at,
});

// Cấu trúc mặc định "Lương cơ bản" tạo lười ở lần đầu cần (từ DEFAULT_PAYROLL_STRUCTURE của domain, QĐ #620).
export async function ensureDefaultStructure(trx: Trx, tenantId: string): Promise<number> {
  const find = () => trx.selectFrom('payroll_structure').select('id').where((eb) => eb.or([eb('is_default', '=', true), eb('code', '=', DEFAULT_STRUCTURE_CODE)]))
    .orderBy('is_default', 'desc').executeTakeFirst();
  const hit = await find(); if (hit) return hit.id;
  await trx.insertInto('payroll_structure').values({ tenant_id: tenantId, code: DEFAULT_STRUCTURE_CODE, name: 'Lương cơ bản', columns: JSON.stringify(DEFAULT_PAYROLL_STRUCTURE.columns), is_default: true })
    .onConflict((oc) => oc.doNothing()).execute(); // hai yêu cầu đầu tiên cùng lúc: một bên thắng
  return (await find())!.id;
}

// "Đã dùng": có bảng lương không phải nháp tham chiếu (bảng nháp tính lại theo cấu trúc mới được).
const usedIds = async (trx: Trx, ids: number[]) => new Set(ids.length
  ? (await trx.selectFrom('payroll_run').select('structure_id').where('structure_id', 'in', ids).where('status', '<>', 'draft').distinct().execute()).map((r) => r.structure_id) : []);

export async function getStructureRow(trx: Trx, id: number) {
  const r = await trx.selectFrom('payroll_structure').selectAll().where('id', '=', id).executeTakeFirst();
  if (!r) throw new AppError('STRUCTURE_NOT_FOUND', 'Không tìm thấy cấu trúc bảng lương', 404);
  return r;
}

export async function listStructures(trx: Trx, tenantId: string) {
  await ensureDefaultStructure(trx, tenantId);
  const rows = await trx.selectFrom('payroll_structure').selectAll().orderBy('is_default', 'desc').orderBy('code').execute();
  const used = await usedIds(trx, rows.map((r) => r.id));
  return rows.map((r) => dto(r, used.has(r.id)));
}

export async function getStructure(trx: Trx, id: number) {
  const r = await getStructureRow(trx, id);
  return dto(r, (await usedIds(trx, [id])).has(id));
}

const duplicate = (code: string) => new AppError('STRUCTURE_DUPLICATE', `Đã có cấu trúc bảng lương mã "${code}"`, 409);
async function assertCode(trx: Trx, code: string, selfId: number | null) {
  const r = await trx.selectFrom('payroll_structure').select('id').where('code', '=', code).executeTakeFirst();
  if (r && r.id !== selfId) throw duplicate(code);
}

export async function createStructure(trx: Trx, tenantId: string, b: StructureInput, parentId: number | null = null) {
  validateStructure({ columns: b.columns as PayrollColumn[] });
  await assertCode(trx, b.code, null);
  const r = await trx.insertInto('payroll_structure').values({ tenant_id: tenantId, code: b.code, name: b.name, proration: b.proration, columns: JSON.stringify(b.columns), parent_id: parentId, note: b.note })
    .returningAll().executeTakeFirstOrThrow();
  return dto(r, false);
}

export async function cloneStructure(trx: Trx, tenantId: string, id: number, b: z.infer<typeof cloneInput>) {
  const src = await getStructureRow(trx, id);
  return createStructure(trx, tenantId, { code: b.code, name: b.name, proration: src.proration as StructureInput['proration'], columns: src.columns as StructureInput['columns'], note: src.note }, id);
}

const inUse = () => new AppError('STRUCTURE_IN_USE', 'Cấu trúc đã được bảng lương dùng nên không sửa, xóa được: nhân bản cấu trúc rồi sửa bản mới', 409);

export async function updateStructure(trx: Trx, id: number, b: StructureInput) {
  await getStructureRow(trx, id);
  if ((await usedIds(trx, [id])).has(id)) throw inUse();
  validateStructure({ columns: b.columns as PayrollColumn[] });
  await assertCode(trx, b.code, id);
  const r = await trx.updateTable('payroll_structure').set({ code: b.code, name: b.name, proration: b.proration, columns: JSON.stringify(b.columns), note: b.note, updated_at: sql`now()` })
    .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  return dto(r, false);
}

export async function deleteStructure(trx: Trx, id: number) {
  const r = await getStructureRow(trx, id);
  if (r.is_default) throw new AppError('STRUCTURE_DEFAULT', 'Không xóa cấu trúc bảng lương mặc định', 409);
  if (await trx.selectFrom('payroll_run').select('id').where('structure_id', '=', id).executeTakeFirst()) throw inUse(); // kể cả bảng nháp (khóa ngoại)
  await trx.deleteFrom('payroll_structure').where('id', '=', id).execute();
}
