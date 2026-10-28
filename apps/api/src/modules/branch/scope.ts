import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';

type Trx = Transaction<Database>;
// Bộ lọc chi nhánh trên chứng từ: các id chi nhánh và có gồm trụ sở chính (branch_id NULL) không. undefined = toàn công ty.
export interface BranchFilter { ids: number[]; headOffice: boolean }
// Phạm vi của người dùng: id chi nhánh, 0 = trụ sở chính; null = toàn công ty (không có dòng user_branch_scope).
export type BranchScope = number[] | null;

export const HEAD_OFFICE = 0;
export const WORKING_BRANCH_PREF = 'branch.working';

// Người dùng bị giới hạn chi nhánh chỉ giữ các quyền làm việc trên chứng từ sổ cái (voucher có branch_id, RLS lọc) và sổ sách/BCTC (lọc chi nhánh).
// Danh sách cho phép (đóng khi có quyền mới): phân hệ có bảng riêng không mang chi nhánh (công nợ, hóa đơn điện tử, kho, tài sản, thuế, cuối kỳ) tắt với họ.
export const BRANCH_SCOPED_PERMISSIONS = new Set([
  'voucher.view', 'voucher.create', 'voucher.update', 'voucher.delete', 'voucher.print', 'voucher.post', 'voucher.unpost', 'voucher.edit_posted',
  'stock_voucher.view', 'stock_voucher.create', 'stock_voucher.update', 'stock_voucher.delete', 'stock_voucher.post',
  'report.view', 'report.print', 'report_def.view', 'account.view', 'catalog.view', 'item.view', 'warehouse.view', 'price_list.view', 'period.view',
]);
// Báo cáo dưới report.view đọc bảng không mang chi nhánh (số dư kỳ, khoản công nợ, sổ kho, thẻ tài sản, khế ước): chặn với người dùng bị giới hạn.
// Chỉ Sổ sách, BCTC và BCTC tổng hợp tính theo chi nhánh.
const BRANCH_AWARE_REPORTS = ['/api/reports/ledgers/', '/api/reports/financial', '/api/reports/consolidated'];
const COMPANY_WIDE_ROUTES = ['/api/balances', '/api/asset-reports', '/api/loans', '/api/print/book-set'];
export function branchRouteDenied(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith('/api/reports/')) return !BRANCH_AWARE_REPORTS.some((p) => url.startsWith(p));
  return COMPANY_WIDE_ROUTES.some((p) => url === p || url.startsWith(`${p}/`));
}

// Phạm vi và chi nhánh làm việc của người dùng; quyền bị thu về danh sách cho phép khi bị giới hạn.
export async function loadBranchScope(trx: Trx, tenantId: string, userId: string, permissions: Set<string>) {
  const rows = await trx.selectFrom('user_branch_scope').select('branch_id').where('tenant_id', '=', tenantId).where('user_id', '=', userId).execute();
  const scope: BranchScope = rows.length ? rows.map((r) => r.branch_id ?? HEAD_OFFICE).sort((a, b) => a - b) : null;
  const pref = (await trx.selectFrom('user_pref').select('value').where('tenant_id', '=', tenantId).where('user_id', '=', userId).where('key', '=', WORKING_BRANCH_PREF).executeTakeFirst())?.value;
  const wanted = typeof pref === 'number' && Number.isInteger(pref) ? pref : HEAD_OFFICE;
  // Chi nhánh làm việc ngoài phạm vi (phạm vi đổi sau khi chọn) thì về chi nhánh đầu tiên của phạm vi.
  const working = scope === null || scope.includes(wanted) ? wanted : scope[0]!;
  return {
    branchScope: scope, branchWorking: working,
    permissions: scope === null ? permissions : new Set([...permissions].filter((p) => BRANCH_SCOPED_PERMISSIONS.has(p))),
  };
}

// Biến phiên cho withTenant: phạm vi (RLS restrictive trên voucher) và mặc định voucher.branch_id.
export const branchSessionVars = (a: { branchScope?: BranchScope | undefined; branchWorking?: number | undefined }) => ({
  branchScope: a.branchScope ? a.branchScope.join(',') : '',
  branchDefault: a.branchWorking ? String(a.branchWorking) : '',
});

// Bộ lọc hiệu lực = chi nhánh yêu cầu (HO hoặc id; không ghi = mọi chi nhánh) giao phạm vi của người dùng. Ngoài phạm vi: 403.
export function effectiveBranch(auth: { branchScope?: BranchScope | undefined }, requested: string | undefined): BranchFilter | undefined {
  const scope = auth.branchScope ?? null;
  if (requested === undefined || requested === '') return scope === null ? undefined : toFilter(scope);
  const id = requested === 'HO' ? HEAD_OFFICE : Number(requested);
  if (!Number.isInteger(id) || id < 0) throw new AppError('VALIDATION', 'Chi nhánh không hợp lệ (HO hoặc mã số chi nhánh)', 400);
  if (scope !== null && !scope.includes(id)) throw new AppError('BRANCH_FORBIDDEN', 'Không có quyền xem chi nhánh này', 403);
  return toFilter([id]);
}
export const toFilter = (ids: number[]): BranchFilter => ({ ids: ids.filter((x) => x !== HEAD_OFFICE), headOffice: ids.includes(HEAD_OFFICE) });

// Điều kiện chi nhánh trên bảng voucher (bí danh `alias`); không lọc thì luôn đúng.
export const branchWhere = (f: BranchFilter | undefined, alias = 'v') => f
  ? sql`(${sql.ref(`${alias}.branch_id`)} = ANY (${f.ids}::bigint[]) OR (${f.headOffice}::boolean AND ${sql.ref(`${alias}.branch_id`)} IS NULL))`
  : sql`true`;
// Nguồn số dư tại ngày: số dư kỳ của công ty, hoặc khi lọc chi nhánh thì cộng dòng đã ghi sổ của các chi nhánh đó (0241).
export const balancesAt = (tenantId: string, date: string, f: BranchFilter | undefined) => f
  ? sql`fn_balances_at_branch(${tenantId}::uuid, ${date}::date, ${f.ids}::bigint[], ${f.headOffice}::boolean)`
  : sql`fn_balances_at(${tenantId}::uuid, ${date}::date)`;
