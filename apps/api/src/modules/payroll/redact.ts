import type { Kysely, Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { isSalaryCode, salaryAccountIds } from './accounts.js';

type Trx = Kysely<Database> | Transaction<Database>;
type Auth = { sensitive: Set<string> };
interface SalaryLine { accountCode: string; debit: string; credit: string; amountCurrency?: string | null | undefined; employeeCode?: string | null | undefined; settle?: unknown }
interface SalaryDto { id: string; totalDebit: string; lines: SalaryLine[] }

// Mã tài khoản lương trong các dòng của chứng từ (theo hệ tài khoản của năm tài chính chứng từ); rỗng khi người gọi có view_salary hoặc chứng từ không có dòng lương.
async function salaryCodesOf(trx: Trx, auth: Auth, dto: SalaryDto): Promise<Set<string>> {
  if (auth.sensitive.has('view_salary') || !dto.lines.length) return new Set();
  const { regime } = await trx.selectFrom('voucher as v').innerJoin('fiscal_period as p', 'p.fiscal_year', 'v.fiscal_year').select('p.regime').where('v.id', '=', dto.id).limit(1).executeTakeFirstOrThrow();
  return new Set(dto.lines.map((l) => l.accountCode).filter((c) => isSalaryCode(regime, c)));
}

// Thiếu view_salary: che số tiền, nhân viên và kế hoạch đối trừ của các dòng trên tài khoản lương (phải trả người lao động, KPCĐ, BHXH, BHYT, BHTN) ở chứng từ mọi loại; các dòng khác giữ nguyên.
// Tổng tiền của chứng từ cũng bị che (null) vì gồm số lương. salaryRedacted cho giao diện biết dòng nào là số che chứ không phải số 0.
export async function redactSalary<T extends SalaryDto>(trx: Trx, auth: Auth, dto: T): Promise<T & { salaryRedacted?: true }> {
  const hidden = await salaryCodesOf(trx, auth, dto);
  if (!hidden.size) return dto;
  const lines = dto.lines.map((l) => (hidden.has(l.accountCode) ? { ...l, debit: '0', credit: '0', amountCurrency: l.amountCurrency == null ? l.amountCurrency : '0', employeeCode: null, settle: undefined } : l));
  return { ...dto, lines, totalDebit: null as never, salaryRedacted: true };
}

// Chứng từ có dòng lương thì thiếu view_salary là 403 cho thao tác không thể làm trên bản che: in (mẫu in cộng tiền theo dòng) và sửa nháp cả bộ dòng (lưu lại bản che sẽ ghi đè số lương bằng 0).
export async function assertNoSalaryLines(trx: Trx, auth: Auth, dto: SalaryDto): Promise<void> {
  if ((await salaryCodesOf(trx, auth, dto)).size) throw new AppError('FORBIDDEN', 'Không có quyền xem lương', 403);
}

// Danh sách chứng từ: tổng tiền của chứng từ có dòng trên tài khoản lương bị che (null) khi thiếu view_salary.
export async function redactSalaryTotals<T extends { id: string; totalDebit: string; postingDate: string }>(trx: Trx, auth: Auth, rows: T[]): Promise<T[]> {
  if (auth.sensitive.has('view_salary') || !rows.length) return rows;
  const ids = await salaryAccountIds(trx);
  if (!ids.length) return rows;
  const dates = rows.map((r) => r.postingDate).sort(); // giới hạn ngày để chỉ quét các phân vùng tháng của trang này
  const hit = new Set((await trx.selectFrom('voucher_line').select('voucher_id').distinct().where('voucher_id', 'in', rows.map((r) => r.id)).where('account_id', 'in', ids)
    .where('posting_date', '>=', dates[0]!).where('posting_date', '<=', dates.at(-1)!).execute()).map((r) => r.voucher_id));
  return rows.map((r) => (hit.has(r.id) ? { ...r, totalDebit: null as never } : r));
}
