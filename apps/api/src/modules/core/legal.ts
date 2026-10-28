import type { Kysely } from 'kysely';
import type { Database } from '@kt/db';

// Tham số pháp lý theo ngày hiệu lực (legal_param, nạp từ packages/coa-data/data/tax/legal-params.json khi migrate): giá trị của dòng có [valid_from, valid_to] chứa ngày;
// không có dòng nào thì null. Các khoảng của cùng mã không chồng nhau (kiểm thử của coa-data).
export async function legalParam<T>(trx: Kysely<Database>, code: string, date: string): Promise<T | null> {
  const r = await trx.selectFrom('legal_param').select('value').where('code', '=', code).where('valid_from', '<=', date)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', date)])).executeTakeFirst();
  return r ? (r.value as T) : null;
}

// Thuế suất GTGT giảm (tham số vat_reduced_rate: value.to là thuế suất sau giảm, hiện 8%) có hiệu lực tại ngày không?
// Trả false chỉ khi `rate` đúng là thuế suất giảm của một dòng tham số mà không dòng nào bao ngày đó (vd. sau 31/12/2026, hết hiệu lực NQ 204/2025). Thuế suất khác (0, 5, 10) luôn true.
// Thuế suất giảm lấy từ dữ liệu, không viết cứng: khi có nghị quyết mới thêm dòng tham số thì tự có hiệu lực.
export async function isReducedVatRateEffective(trx: Kysely<Database>, rate: string, date: string): Promise<boolean> {
  const rows = await trx.selectFrom('legal_param').select(['value', 'valid_from', 'valid_to']).where('code', '=', 'vat_reduced_rate').execute();
  const mine = rows.filter((r) => String((r.value as { to?: number | string }).to) === rate);
  if (!mine.length) return true;
  return mine.some((r) => r.valid_from <= date && (r.valid_to === null || r.valid_to >= date));
}
