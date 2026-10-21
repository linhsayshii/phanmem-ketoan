import type { Kysely } from 'kysely';
import type { Database } from '@kt/db';

// Tham số pháp lý theo ngày hiệu lực (legal_param, nạp từ packages/coa-data/data/tax/legal-params.json khi migrate): giá trị của dòng có [valid_from, valid_to] chứa ngày;
// không có dòng nào thì null. Các khoảng của cùng mã không chồng nhau (kiểm thử của coa-data).
export async function legalParam<T>(trx: Kysely<Database>, code: string, date: string): Promise<T | null> {
  const r = await trx.selectFrom('legal_param').select('value').where('code', '=', code).where('valid_from', '<=', date)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', date)])).executeTakeFirst();
  return r ? (r.value as T) : null;
}
