import type { Kysely, Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { isSalaryAccount, type PayrollAccountMap } from '@kt/domain';
import { COA_REGIMES, loadPayrollAccounts } from '@kt/coa-data';

// Ánh xạ tài khoản lương của chế độ kế toán (coa-data/payroll/accounts.json). Chế độ chưa có ánh xạ (ví dụ TT58) lấy hợp mọi ánh xạ: che nhiều hơn là lộ lương.
const cache = new Map<string, PayrollAccountMap[]>();
export function payrollAccountMaps(regime: string): PayrollAccountMap[] {
  let m = cache.get(regime);
  if (!m) {
    const own = COA_REGIMES.includes(regime as never) ? loadPayrollAccounts(regime as never) : undefined;
    cache.set(regime, m = own ? [own] : COA_REGIMES.flatMap((r) => loadPayrollAccounts(r) ?? []));
  }
  return m;
}
export const isSalaryCode = (regime: string, code: string): boolean => payrollAccountMaps(regime).some((m) => isSalaryAccount(m, code));
// Gắn cờ salary cho tài khoản của một hệ (đầu vào của sensitiveDenial/assertSensitive).
export const withSalary = <T extends { code: string }>(regime: string, rows: T[]): (T & { salary: boolean })[] => rows.map((r) => ({ ...r, salary: isSalaryCode(regime, r.code) }));

// Id các tài khoản lương của công ty (mọi hệ tài khoản, mỗi hệ theo ánh xạ riêng): để SQL so khớp id thay vì lặp lại quy tắc nhận diện.
export async function salaryAccountIds(trx: Kysely<Database> | Transaction<Database>): Promise<number[]> {
  return (await trx.selectFrom('account').select(['id', 'regime', 'code']).execute()).filter((a) => isSalaryCode(a.regime, a.code)).map((a) => a.id);
}
