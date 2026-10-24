import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { parseInvoiceSymbol } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { sealSecret } from '../../lib/secretBox.js';
import { assertEInvoiceFakeAllowed, assertEInvoiceUrl } from './providers/policy.js';

// Cấu hình hóa đơn điện tử: nhà cung cấp (mật khẩu mã hóa, không bao giờ trả về) và dải ký hiệu mẫu số/ký hiệu hóa đơn (TT 91/2026 Phụ lục I).
type Trx = Transaction<Database>;
const text = (max: number) => z.string().trim().max(max);

export const providerInput = z.object({
  code: z.enum(['fake', 'sinvoice']), name: text(255).min(1), baseUrl: text(500).default(''), username: text(255).default(''),
  password: z.string().max(500).optional(), // bỏ trống = giữ mật khẩu cũ
  sellerTaxCode: text(20).default(''), options: z.record(z.unknown()).default({}), isActive: z.boolean().default(true),
});
export const seriesInput = z.object({
  providerId: z.number().int().positive(), formNo: z.string(), serial: z.string(), kind: z.enum(['standard', 'cash_register']).default('standard'),
  providerTemplate: text(50).nullable().optional(), isActive: z.boolean().default(true), note: text(500).nullable().optional(),
});

const providerNotFound = () => new AppError('EINVOICE_PROVIDER_NOT_FOUND', 'Không tìm thấy nhà cung cấp hóa đơn điện tử', 404);
const seriesNotFound = () => new AppError('EINVOICE_SERIES_NOT_FOUND', 'Không tìm thấy ký hiệu hóa đơn', 404);

type ProviderRow = Selectable<Database['einvoice_provider']>;
const providerDto = (r: ProviderRow) => ({ id: r.id, code: r.code, name: r.name, baseUrl: r.base_url, username: r.username, hasSecret: r.secret !== null,
  sellerTaxCode: r.seller_tax_code, options: r.options, isActive: r.is_active, createdAt: r.created_at });

export const listProviders = async (trx: Trx) => (await trx.selectFrom('einvoice_provider').selectAll().orderBy('id').execute()).map(providerDto);

export async function saveProvider(trx: Trx, tenantId: string, id: number | null, b: z.infer<typeof providerInput>) {
  if (b.code === 'fake') assertEInvoiceFakeAllowed();
  else assertEInvoiceUrl(b.baseUrl);
  const v ={ code: b.code, name: b.name, base_url: b.baseUrl, username: b.username, seller_tax_code: b.sellerTaxCode, options: JSON.stringify(b.options), is_active: b.isActive,
    ...(b.password ? { secret: sealSecret(b.password) } : {}) };
  if (id === null) return providerDto(await trx.insertInto('einvoice_provider').values({ tenant_id: tenantId, ...v }).returningAll().executeTakeFirstOrThrow());
  const r = await trx.updateTable('einvoice_provider').set(v).where('id', '=', id).returningAll().executeTakeFirst();
  if (!r) throw providerNotFound();
  return providerDto(r);
}

export async function deleteProvider(trx: Trx, id: number) {
  const used = await trx.selectFrom('einvoice_series').select('id').where('provider_id', '=', id).limit(1).executeTakeFirst();
  if (used) throw new AppError('PROVIDER_IN_USE', 'Nhà cung cấp còn ký hiệu hóa đơn, xóa ký hiệu trước', 409);
  const r = await trx.deleteFrom('einvoice_provider').where('id', '=', id).executeTakeFirst();
  if (!r.numDeletedRows) throw providerNotFound();
}

type SeriesRow = Selectable<Database['einvoice_series']>;
const seriesDto = (r: SeriesRow) => ({ id: r.id, providerId: r.provider_id, formNo: r.form_no, serial: r.serial, year: r.year, kind: r.kind,
  providerTemplate: r.provider_template, isActive: r.is_active, note: r.note });

export const listSeries = async (trx: Trx) => (await trx.selectFrom('einvoice_series').selectAll().orderBy('id').execute()).map(seriesDto);

const seriesInUse409 = () => new AppError('SERIES_IN_USE', 'Ký hiệu hóa đơn đã có hóa đơn điện tử, không sửa ký hiệu hoặc xóa', 409);
// Bảng einvoice do Task 3 (migration sau) tạo: trước đó chưa có hóa đơn nào.
const seriesInUse = async (trx: Trx, id: number) => {
  if (!(await sql<{ t: string | null }>`SELECT to_regclass('public.einvoice')::text AS t`.execute(trx)).rows[0]!.t) return false; // parse sẽ lỗi nếu bảng chưa có
  return (await sql`SELECT 1 FROM einvoice WHERE series_id = ${id} LIMIT 1`.execute(trx)).rows.length > 0;
};

export async function saveSeries(trx: Trx, tenantId: string, id: number | null, b: z.infer<typeof seriesInput>) {
  const s = parseInvoiceSymbol(b.formNo, b.serial);
  if (!s.ok) throw new AppError('INVOICE_SYMBOL_INVALID', s.message, 400);
  // Chữ thứ tư M = hóa đơn khởi tạo từ máy tính tiền (Phụ lục I mục 2).
  if ((s.typeLetter === 'M') !== (b.kind === 'cash_register')) throw new AppError('INVOICE_SYMBOL_INVALID', 'Chữ thứ tư M chỉ dùng cho hóa đơn khởi tạo từ máy tính tiền, và ngược lại', 400);
  if (!(await trx.selectFrom('einvoice_provider').select('id').where('id', '=', b.providerId).executeTakeFirst())) throw providerNotFound();
  const v = { provider_id: b.providerId, form_no: b.formNo, serial: b.serial, year: s.year, kind: b.kind, provider_template: b.providerTemplate ?? null, is_active: b.isActive, note: b.note ?? null };
  if (id === null) return seriesDto(await trx.insertInto('einvoice_series').values({ tenant_id: tenantId, ...v }).returningAll().executeTakeFirstOrThrow());
  const cur = await trx.selectFrom('einvoice_series').selectAll().where('id', '=', id).executeTakeFirst();
  if (!cur) throw seriesNotFound();
  // Đã có hóa đơn: chỉ sửa ghi chú, mã mẫu nhà cung cấp, trạng thái; không đổi ký hiệu, loại, nhà cung cấp.
  if ((cur.form_no !== b.formNo || cur.serial !== b.serial || cur.provider_id !== b.providerId || cur.kind !== b.kind) && await seriesInUse(trx, id)) throw seriesInUse409();
  return seriesDto(await trx.updateTable('einvoice_series').set(v).where('id', '=', id).returningAll().executeTakeFirstOrThrow());
}

export async function deleteSeries(trx: Trx, id: number) {
  if (await seriesInUse(trx, id)) throw seriesInUse409();
  const r = await trx.deleteFrom('einvoice_series').where('id', '=', id).executeTakeFirst();
  if (!r.numDeletedRows) throw seriesNotFound();
}
