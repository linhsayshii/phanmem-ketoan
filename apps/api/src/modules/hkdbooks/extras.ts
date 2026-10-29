import { z } from 'zod';
import { VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import type { Trx } from './service.js';

// TT 58/2026 Điều 9 khoản 1: dữ liệu của S4a (công nợ), S4b (TSCĐ), S4d (vốn chủ sở hữu) và tài sản khác (mã 150 của B01-DNSN). Ghi sổ đơn như các bảng book_* của 0251; tiền là chuỗi thập phân.
export const DEBT_SIDES = ['recv', 'pay'] as const;
export const DEBT_KINDS = ['opening', 'incur', 'settle'] as const;
export const DEBT_NATURES = ['trade', 'loan', 'advance', 'deposit', 'payroll', 'tax', 'other'] as const;
export const EQUITY_SECTIONS = ['capital', 'retained', 'funds'] as const;
export const MOVE_KINDS = ['opening', 'increase', 'decrease'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, 'Ngày không hợp lệ');
const money = z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG);
const optText = (n: number) => z.string().trim().max(n).nullable().optional().transform((v) => (v ? v : null));
const positive = (v: string) => v !== '0' && /[1-9]/.test(v);
const rate = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Tỷ lệ phải là số phần trăm, tối đa 4 chữ số thập phân').refine((s) => Number(s) <= 100, 'Tỷ lệ không quá 100');
const notFound = (code: string, what: string): never => { throw new AppError(code, `Không có ${what}`, 404); };

// ---- S4a: công nợ ----
export const debtInput = z.object({
  entryDate: isoDate, docNo: optText(50), description: z.string().trim().min(1, 'Cần diễn giải').max(500), party: z.string().trim().min(1, 'Cần đối tượng công nợ').max(200),
  side: z.enum(DEBT_SIDES), kind: z.enum(DEBT_KINDS), nature: z.enum(DEBT_NATURES).default('other'), amount: money,
}).superRefine((v, c) => {
  if (!positive(v.amount)) c.addIssue({ code: 'custom', path: ['amount'], message: 'Số tiền phải lớn hơn 0' });
  if (v.nature === 'tax' && v.side !== 'pay') c.addIssue({ code: 'custom', path: ['nature'], message: 'Nghĩa vụ thuế chỉ ghi ở bên nợ phải trả' });
});
export type DebtIn = z.infer<typeof debtInput>;
export interface DebtDto { id: number; entryDate: string; docNo: string | null; description: string; party: string; side: string; kind: string; nature: string; amount: string }
const toDebt = (r: { id: number; entry_date: string; doc_no: string | null; description: string; party: string; side: string; kind: string; nature: string; amount: string }): DebtDto =>
  ({ id: r.id, entryDate: r.entry_date, docNo: r.doc_no, description: r.description, party: r.party, side: r.side, kind: r.kind, nature: r.nature, amount: r.amount });
const debtValues = (i: DebtIn) => ({ entry_date: i.entryDate, doc_no: i.docNo ?? null, description: i.description, party: i.party, side: i.side, kind: i.kind, nature: i.nature, amount: i.amount });
// sides: bên người dùng được xem (cờ view_receivable, view_payable); bỏ trống là cả hai.
export async function listDebts(trx: Trx, f: { from?: string | undefined; to?: string | undefined; party?: string | undefined; sides?: readonly string[] | undefined }): Promise<DebtDto[]> {
  let q = trx.selectFrom('book_debt').selectAll();
  if (f.sides) q = q.where('side', 'in', f.sides.length ? [...f.sides] : ['-']);
  if (f.from) q = q.where('entry_date', '>=', f.from);
  if (f.to) q = q.where('entry_date', '<=', f.to);
  if (f.party) q = q.where('party', '=', f.party);
  return (await q.orderBy('entry_date').orderBy('id').limit(5000).execute()).map(toDebt);
}
export async function listParties(trx: Trx, sides?: readonly string[]): Promise<string[]> {
  let q = trx.selectFrom('book_debt').select('party').distinct();
  if (sides) q = q.where('side', 'in', sides.length ? [...sides] : ['-']);
  return (await q.orderBy('party').limit(2000).execute()).map((r) => r.party);
}
export async function createDebt(trx: Trx, tenantId: string, userId: string, i: DebtIn): Promise<DebtDto> {
  return toDebt(await trx.insertInto('book_debt').values({ tenant_id: tenantId, created_by: userId, ...debtValues(i) }).returningAll().executeTakeFirstOrThrow());
}
// Bên của bút ghi hiện có (để kiểm cờ nhạy cảm trước khi sửa, xóa); không có bút thì 404.
export async function debtSide(trx: Trx, id: number): Promise<string> {
  const r = await trx.selectFrom('book_debt').select('side').where('id', '=', id).executeTakeFirst();
  return r ? r.side : notFound('BOOK_DEBT_NOT_FOUND', 'bút ghi công nợ');
}
export async function updateDebt(trx: Trx, id: number, i: DebtIn): Promise<DebtDto> {
  const r = await trx.updateTable('book_debt').set(debtValues(i)).where('id', '=', id).returningAll().executeTakeFirst();
  return r ? toDebt(r) : notFound('BOOK_DEBT_NOT_FOUND', 'bút ghi công nợ');
}
export async function deleteDebt(trx: Trx, id: number): Promise<void> {
  if (!(await trx.deleteFrom('book_debt').where('id', '=', id).returning('id').executeTakeFirst())) notFound('BOOK_DEBT_NOT_FOUND', 'bút ghi công nợ');
}

// ---- S4b: tài sản cố định ----
export const assetInput = z.object({
  assetType: z.string().trim().min(1, 'Cần loại tài sản').max(100), name: z.string().trim().min(1, 'Cần tên TSCĐ').max(300), incDocNo: optText(50), incDate: isoDate,
  inUseMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Tháng đưa vào sử dụng có dạng YYYY-MM'), cost: money, depRate: rate,
  decDocNo: optText(50), decDate: isoDate.nullable().optional(), decReason: optText(300),
}).superRefine((v, c) => {
  if (!positive(v.cost)) c.addIssue({ code: 'custom', path: ['cost'], message: 'Nguyên giá phải lớn hơn 0' });
  if ((v.decDate == null) !== (v.decReason == null)) c.addIssue({ code: 'custom', path: ['decReason'], message: 'Ghi giảm cần cả ngày chứng từ và lý do giảm' });
  if (v.decDate != null && v.decDate < v.incDate) c.addIssue({ code: 'custom', path: ['decDate'], message: 'Ngày ghi giảm không trước ngày ghi tăng' });
  if (v.decDocNo != null && v.decDate == null) c.addIssue({ code: 'custom', path: ['decDate'], message: 'Có số chứng từ ghi giảm thì phải có ngày ghi giảm' });
});
export type AssetIn = z.infer<typeof assetInput>;
export interface AssetDto { id: number; assetType: string; name: string; incDocNo: string | null; incDate: string; inUseMonth: string; cost: string; depRate: string; decDocNo: string | null; decDate: string | null; decReason: string | null }
interface AssetRow { id: number; asset_type: string; name: string; inc_doc_no: string | null; inc_date: string; in_use_month: string; cost: string; dep_rate: string; dec_doc_no: string | null; dec_date: string | null; dec_reason: string | null }
const toAsset = (r: AssetRow): AssetDto => ({ id: r.id, assetType: r.asset_type, name: r.name, incDocNo: r.inc_doc_no, incDate: r.inc_date, inUseMonth: String(r.in_use_month).slice(0, 7), cost: r.cost, depRate: r.dep_rate, decDocNo: r.dec_doc_no, decDate: r.dec_date, decReason: r.dec_reason });
const assetValues = (i: AssetIn) => ({ asset_type: i.assetType, name: i.name, inc_doc_no: i.incDocNo ?? null, inc_date: i.incDate, in_use_month: `${i.inUseMonth}-01`, cost: i.cost, dep_rate: i.depRate, dec_doc_no: i.decDocNo ?? null, dec_date: i.decDate ?? null, dec_reason: i.decReason ?? null });
export async function listAssets(trx: Trx): Promise<AssetDto[]> {
  return (await trx.selectFrom('book_fixed_asset').selectAll().orderBy('asset_type').orderBy('inc_date').orderBy('id').limit(5000).execute()).map(toAsset);
}
export async function createAsset(trx: Trx, tenantId: string, userId: string, i: AssetIn): Promise<AssetDto> {
  return toAsset(await trx.insertInto('book_fixed_asset').values({ tenant_id: tenantId, created_by: userId, ...assetValues(i) }).returningAll().executeTakeFirstOrThrow());
}
export async function updateAsset(trx: Trx, id: number, i: AssetIn): Promise<AssetDto> {
  const r = await trx.updateTable('book_fixed_asset').set(assetValues(i)).where('id', '=', id).returningAll().executeTakeFirst();
  return r ? toAsset(r) : notFound('BOOK_ASSET_NOT_FOUND', 'thẻ tài sản cố định');
}
export async function deleteAsset(trx: Trx, id: number): Promise<void> {
  if (!(await trx.deleteFrom('book_fixed_asset').where('id', '=', id).returning('id').executeTakeFirst())) notFound('BOOK_ASSET_NOT_FOUND', 'thẻ tài sản cố định');
}

// ---- S4d: vốn chủ sở hữu ----
const signedMoney = z.string().regex(/^-?\d{1,16}$/, 'Số tiền VND phải là số nguyên tối đa 16 chữ số');
export const equityInput = z.object({
  entryDate: isoDate, docNo: optText(50), description: z.string().trim().min(1, 'Cần diễn giải').max(500), section: z.enum(EQUITY_SECTIONS), kind: z.enum(MOVE_KINDS), amount: signedMoney,
}).superRefine((v, c) => {
  const lossOpening = v.kind === 'opening' && v.section === 'retained';
  if (v.amount.startsWith('-') && !lossOpening) c.addIssue({ code: 'custom', path: ['amount'], message: 'Chỉ số dư đầu của lợi nhuận chưa phân phối được âm (lỗ lũy kế)' });
  if (!/[1-9]/.test(v.amount)) c.addIssue({ code: 'custom', path: ['amount'], message: 'Số tiền phải khác 0' });
});
export type EquityIn = z.infer<typeof equityInput>;
export interface EquityDto { id: number; entryDate: string; docNo: string | null; description: string; section: string; kind: string; amount: string }
const toEquity = (r: { id: number; entry_date: string; doc_no: string | null; description: string; section: string; kind: string; amount: string }): EquityDto =>
  ({ id: r.id, entryDate: r.entry_date, docNo: r.doc_no, description: r.description, section: r.section, kind: r.kind, amount: r.amount });
const equityValues = (i: EquityIn) => ({ entry_date: i.entryDate, doc_no: i.docNo ?? null, description: i.description, section: i.section, kind: i.kind, amount: i.amount });
export async function listEquity(trx: Trx, f: { from?: string | undefined; to?: string | undefined }): Promise<EquityDto[]> {
  let q = trx.selectFrom('book_equity').selectAll();
  if (f.from) q = q.where('entry_date', '>=', f.from);
  if (f.to) q = q.where('entry_date', '<=', f.to);
  return (await q.orderBy('entry_date').orderBy('id').limit(5000).execute()).map(toEquity);
}
export async function createEquity(trx: Trx, tenantId: string, userId: string, i: EquityIn): Promise<EquityDto> {
  return toEquity(await trx.insertInto('book_equity').values({ tenant_id: tenantId, created_by: userId, ...equityValues(i) }).returningAll().executeTakeFirstOrThrow());
}
export async function updateEquity(trx: Trx, id: number, i: EquityIn): Promise<EquityDto> {
  const r = await trx.updateTable('book_equity').set(equityValues(i)).where('id', '=', id).returningAll().executeTakeFirst();
  return r ? toEquity(r) : notFound('BOOK_EQUITY_NOT_FOUND', 'bút ghi vốn chủ sở hữu');
}
export async function deleteEquity(trx: Trx, id: number): Promise<void> {
  if (!(await trx.deleteFrom('book_equity').where('id', '=', id).returning('id').executeTakeFirst())) notFound('BOOK_EQUITY_NOT_FOUND', 'bút ghi vốn chủ sở hữu');
}

// ---- Tài sản khác (mã 150) ----
export const otherAssetInput = z.object({ entryDate: isoDate, docNo: optText(50), description: z.string().trim().min(1, 'Cần diễn giải').max(500), kind: z.enum(MOVE_KINDS), amount: money })
  .superRefine((v, c) => { if (!positive(v.amount)) c.addIssue({ code: 'custom', path: ['amount'], message: 'Số tiền phải lớn hơn 0' }); });
export type OtherAssetIn = z.infer<typeof otherAssetInput>;
export interface OtherAssetDto { id: number; entryDate: string; docNo: string | null; description: string; kind: string; amount: string }
const toOther = (r: { id: number; entry_date: string; doc_no: string | null; description: string; kind: string; amount: string }): OtherAssetDto =>
  ({ id: r.id, entryDate: r.entry_date, docNo: r.doc_no, description: r.description, kind: r.kind, amount: r.amount });
const otherValues = (i: OtherAssetIn) => ({ entry_date: i.entryDate, doc_no: i.docNo ?? null, description: i.description, kind: i.kind, amount: i.amount });
export async function listOtherAssets(trx: Trx, f: { from?: string | undefined; to?: string | undefined }): Promise<OtherAssetDto[]> {
  let q = trx.selectFrom('book_other_asset').selectAll();
  if (f.from) q = q.where('entry_date', '>=', f.from);
  if (f.to) q = q.where('entry_date', '<=', f.to);
  return (await q.orderBy('entry_date').orderBy('id').limit(5000).execute()).map(toOther);
}
export async function createOtherAsset(trx: Trx, tenantId: string, userId: string, i: OtherAssetIn): Promise<OtherAssetDto> {
  return toOther(await trx.insertInto('book_other_asset').values({ tenant_id: tenantId, created_by: userId, ...otherValues(i) }).returningAll().executeTakeFirstOrThrow());
}
export async function updateOtherAsset(trx: Trx, id: number, i: OtherAssetIn): Promise<OtherAssetDto> {
  const r = await trx.updateTable('book_other_asset').set(otherValues(i)).where('id', '=', id).returningAll().executeTakeFirst();
  return r ? toOther(r) : notFound('BOOK_OTHER_ASSET_NOT_FOUND', 'bút ghi tài sản khác');
}
export async function deleteOtherAsset(trx: Trx, id: number): Promise<void> {
  if (!(await trx.deleteFrom('book_other_asset').where('id', '=', id).returning('id').executeTakeFirst())) notFound('BOOK_OTHER_ASSET_NOT_FOUND', 'bút ghi tài sản khác');
}
