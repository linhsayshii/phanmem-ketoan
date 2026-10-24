import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { COST_ROLES } from '@kt/domain';
import { COA_REGIMES, loadPayrollAccounts } from '@kt/coa-data';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';

// Tài khoản chi phí lương theo bộ phận (bảng department_cost_account): vai trò bộ phận (tài khoản theo chế độ của năm) hoặc mã tài khoản cụ thể,
// kèm khoản mục chi phí, đối tượng tập hợp chi phí tùy chọn. PUT thay toàn bộ.
type Trx = Transaction<Database>;
const id = z.coerce.number().int().positive();
export const costAccountsInput = z.object({
  items: z.array(z.object({
    departmentId: id, kind: z.enum(['payroll', 'insurance']), role: z.enum(COST_ROLES).nullish().transform((v) => v ?? null),
    accountCode: z.string().regex(/^\d{3,10}$/, 'Mã tài khoản gồm 3 đến 10 chữ số').nullish().transform((v) => v ?? null),
    costItemId: id.nullish().transform((v) => v ?? null), costObjectId: id.nullish().transform((v) => v ?? null),
  }).strict().refine((i) => (i.role === null) !== (i.accountCode === null), 'Chọn vai trò bộ phận hoặc nhập tài khoản (một trong hai)')).max(2000),
}).strict().superRefine((b, ctx) => {
  if (new Set(b.items.map((i) => `${i.departmentId}:${i.kind}`)).size !== b.items.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Mỗi bộ phận chỉ một dòng lương và một dòng bảo hiểm' });
});

export async function listCostAccounts(trx: Trx, tenantId: string) {
  const rows = await trx.selectFrom('department_cost_account as c').innerJoin('department as d', 'd.id', 'c.department_id').leftJoin('cost_item as ci', 'ci.id', 'c.cost_item_id').leftJoin('cost_object as co', 'co.id', 'c.cost_object_id')
    .select(['c.department_id', 'd.code', 'd.name', 'c.kind', 'c.role', 'c.account_code', 'c.cost_item_id', 'ci.code as cost_item_code', 'c.cost_object_id', 'co.code as cost_object_code']).orderBy('d.code').orderBy('c.kind').execute();
  return {
    items: rows.map((r) => ({ departmentId: r.department_id, departmentCode: r.code, departmentName: r.name, kind: r.kind, role: r.role, accountCode: r.account_code,
      costItemId: r.cost_item_id, costItemCode: r.cost_item_code, costObjectId: r.cost_object_id, costObjectCode: r.cost_object_code })),
    defaultAccount: (await getSettings(trx, tenantId)).payroll_expense_account,
    // Tài khoản của từng vai trò theo chế độ (coa-data/payroll/accounts.json), để giao diện hiện tài khoản sẽ dùng.
    roleAccounts: Object.fromEntries(COA_REGIMES.map((r) => [r, loadPayrollAccounts(r)?.cost ?? null])),
  };
}

export async function saveCostAccounts(trx: Trx, tenantId: string, b: z.infer<typeof costAccountsInput>) {
  const missing = async (table: 'department' | 'cost_item' | 'cost_object', ids: (number | null)[], label: string) => {
    const want = [...new Set(ids.filter((x): x is number => x !== null))];
    if (!want.length) return;
    const have = new Set((await trx.selectFrom(table).select('id').where('id', 'in', want).execute()).map((r) => Number(r.id)));
    const lost = want.filter((x) => !have.has(x));
    if (lost.length) throw new AppError('VALIDATION', `Không tìm thấy ${label} (mã nội bộ ${lost.join(', ')})`, 400);
  };
  await missing('department', b.items.map((i) => i.departmentId), 'bộ phận');
  await missing('cost_item', b.items.map((i) => i.costItemId), 'khoản mục chi phí');
  await missing('cost_object', b.items.map((i) => i.costObjectId), 'đối tượng tập hợp chi phí');
  await trx.deleteFrom('department_cost_account').execute();
  if (b.items.length) await trx.insertInto('department_cost_account').values(b.items.map((i) => ({ tenant_id: tenantId, department_id: i.departmentId, kind: i.kind, role: i.role,
    account_code: i.accountCode, cost_item_id: i.costItemId, cost_object_id: i.costObjectId }))).execute();
  return listCostAccounts(trx, tenantId);
}
