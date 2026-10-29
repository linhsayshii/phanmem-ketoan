import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, VND_AMOUNT_MSG, VND_AMOUNT_RE, vnd, type Decimal } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

// Sổ hộ kinh doanh (TT 152/2025) và doanh nghiệp siêu nhỏ (TT 58/2026): ghi sổ đơn theo phương pháp nộp thuế, không qua sổ cái bút toán kép.
// Mọi hàm ở đây chỉ nhận/ghi các bảng book_*; tỷ lệ thuế do người dùng khai báo (không đặt sẵn). Tỷ lệ là số phần trăm (1.5 = 1,5%).
export type Trx = Transaction<Database>;
export const KINDS = ['revenue', 'other_income', 'expense', 'tax_paid', 'vat_input', 'vat_output', 'vat_refund', 'cash_in', 'cash_out', 'opening'] as const;
export const EXPENSE_CATS = ['a', 'b', 'c', 'd', 'dd', 'e'] as const;
export const TAX_METHODS = ['exempt', 'percent', 'income', 'percent_both', 'vat_percent_cit_profit', 'vat_deduct_cit_percent', 'vat_deduct_cit_profit'] as const;
export const OTHER_TAX_KINDS = ['xnk_ttdb', 'env', 'resource', 'land', 'other'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, 'Ngày không hợp lệ');
const money = z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG);
const rate = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Tỷ lệ phải là số phần trăm, tối đa 4 chữ số thập phân').refine((s) => Number(s) <= 100, 'Tỷ lệ không quá 100');
const qty = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Số lượng không hợp lệ (tối đa 4 chữ số thập phân)');
const optText = (n: number) => z.string().trim().max(n).nullable().optional().transform((v) => (v ? v : null));

// ---- Nhóm ngành nghề ----
export const groupInput = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9._-]{1,20}$/, 'Mã nhóm chỉ gồm chữ, số, . _ - tối đa 20 ký tự'), name: z.string().trim().min(1).max(200), vatRate: rate.nullable().optional(), incomeRate: rate.nullable().optional(), isActive: z.boolean().default(true) });
export type GroupIn = z.infer<typeof groupInput>;
export interface GroupDto { id: number; code: string; name: string; vatRate: string | null; incomeRate: string | null; isActive: boolean }
export async function listGroups(trx: Trx): Promise<GroupDto[]> {
  return (await trx.selectFrom('book_group').selectAll().orderBy('code').execute()).map((g) => ({ id: g.id, code: g.code, name: g.name, vatRate: g.vat_rate, incomeRate: g.income_rate, isActive: g.is_active }));
}
export async function createGroup(trx: Trx, tenantId: string, i: GroupIn): Promise<GroupDto> {
  const g = await trx.insertInto('book_group').values({ tenant_id: tenantId, code: i.code, name: i.name, vat_rate: i.vatRate ?? null, income_rate: i.incomeRate ?? null, is_active: i.isActive }).returning('id').executeTakeFirstOrThrow();
  return (await listGroups(trx)).find((x) => x.id === g.id)!;
}
export async function updateGroup(trx: Trx, id: number, i: GroupIn): Promise<GroupDto> {
  const r = await trx.updateTable('book_group').set({ code: i.code, name: i.name, vat_rate: i.vatRate ?? null, income_rate: i.incomeRate ?? null, is_active: i.isActive }).where('id', '=', id).returning('id').executeTakeFirst();
  if (!r) throw new AppError('BOOK_GROUP_NOT_FOUND', 'Không có nhóm ngành nghề', 404);
  return (await listGroups(trx)).find((x) => x.id === id)!;
}

// ---- Cài đặt năm: phương pháp nộp thuế, thuế suất trên thu nhập ----
export const settingInput = z.object({ taxMethod: z.enum(TAX_METHODS), incomeTaxRate: rate.nullable().optional() });
export type SettingIn = z.infer<typeof settingInput>;
export async function getSetting(trx: Trx, year: number): Promise<{ fiscalYear: number; taxMethod: string | null; incomeTaxRate: string | null }> {
  const s = await trx.selectFrom('book_year_setting').selectAll().where('fiscal_year', '=', year).executeTakeFirst();
  return { fiscalYear: year, taxMethod: s?.tax_method ?? null, incomeTaxRate: s?.income_tax_rate ?? null };
}
export async function putSetting(trx: Trx, tenantId: string, year: number, i: SettingIn) {
  await trx.insertInto('book_year_setting').values({ tenant_id: tenantId, fiscal_year: year, tax_method: i.taxMethod, income_tax_rate: i.incomeTaxRate ?? null })
    .onConflict((oc) => oc.columns(['tenant_id', 'fiscal_year']).doUpdateSet({ tax_method: i.taxMethod, income_tax_rate: i.incomeTaxRate ?? null })).execute();
  return getSetting(trx, year);
}
// Năm tài chính chứa ngày (kỳ chính, period_no > 0); chưa mở năm nào thì lấy năm dương lịch.
export async function yearOf(trx: Trx, date: string): Promise<number> {
  const r = await trx.selectFrom('fiscal_period').select('fiscal_year').where('period_no', '>', 0).where('date_from', '<=', date).where('date_to', '>=', date).executeTakeFirst();
  return r?.fiscal_year ?? Number(date.slice(0, 4));
}

// ---- Bút ghi sổ ----
export const entryInput = z.object({
  entryDate: isoDate, docNo: optText(50), description: z.string().trim().min(1, 'Cần diễn giải').max(500), kind: z.enum(KINDS), amount: money,
  groupId: z.number().int().positive().nullable().optional(), expenseCat: z.enum(EXPENSE_CATS).nullable().optional(), taxType: z.enum(['vat', 'income']).nullable().optional(),
  openingRef: z.enum(['cash', 'vat_payable', 'vat_credit', 'income_tax']).nullable().optional(), moneyAccount: optText(100),
}).superRefine((v, c) => {
  const need = (ok: boolean, path: string, message: string) => { if (!ok) c.addIssue({ code: 'custom', path: [path], message }); };
  need((v.kind === 'revenue') === (v.groupId != null), 'groupId', 'Doanh thu phải chọn nhóm ngành nghề (các loại khác không chọn)');
  need((v.kind === 'expense') === (v.expenseCat != null), 'expenseCat', 'Chi phí phải chọn khoản mục a đến e (các loại khác không chọn)');
  need((v.kind === 'tax_paid') === (v.taxType != null), 'taxType', 'Thuế đã nộp phải chọn loại thuế (các loại khác không chọn)');
  need((v.kind === 'opening') === (v.openingRef != null), 'openingRef', 'Số dư đầu phải chọn khoản (các loại khác không chọn)');
  need(!(v.kind === 'cash_in' || v.kind === 'cash_out') || !!v.moneyAccount, 'moneyAccount', 'Thu, chi tiền phải chọn tiền mặt (TM) hoặc ngân hàng');
  need(!(v.kind === 'opening' && v.openingRef === 'cash') || !!v.moneyAccount, 'moneyAccount', 'Số dư đầu tiền phải chọn tiền mặt (TM) hoặc ngân hàng');
  need(v.kind === 'opening' || v.amount !== '0', 'amount', 'Số tiền phải lớn hơn 0');
});
export type EntryIn = z.infer<typeof entryInput>;
export interface EntryDto { id: number; entryDate: string; docNo: string | null; description: string; kind: string; amount: string; groupId: number | null; expenseCat: string | null; taxType: string | null; openingRef: string | null; moneyAccount: string | null }
interface EntryRow { id: number; entry_date: string; doc_no: string | null; description: string; kind: string; amount: string; group_id: number | null; expense_cat: string | null; tax_type: string | null; opening_ref: string | null; money_account: string | null }
const toEntry = (r: EntryRow): EntryDto => ({ id: r.id, entryDate: r.entry_date, docNo: r.doc_no, description: r.description, kind: r.kind, amount: r.amount, groupId: r.group_id, expenseCat: r.expense_cat, taxType: r.tax_type, openingRef: r.opening_ref, moneyAccount: r.money_account });
const entryValues = (i: EntryIn) => ({ entry_date: i.entryDate, doc_no: i.docNo ?? null, description: i.description, kind: i.kind, amount: i.amount, group_id: i.groupId ?? null, expense_cat: i.expenseCat ?? null, tax_type: i.taxType ?? null, opening_ref: i.openingRef ?? null, money_account: i.moneyAccount ?? null });
export async function listEntries(trx: Trx, f: { from: string; to: string; kind?: string | undefined }): Promise<EntryDto[]> {
  let q = trx.selectFrom('book_entry').selectAll().where('entry_date', '>=', f.from).where('entry_date', '<=', f.to);
  if (f.kind) q = q.where('kind', '=', f.kind);
  return (await q.orderBy('entry_date').orderBy('id').limit(5000).execute()).map(toEntry);
}
export async function createEntry(trx: Trx, tenantId: string, userId: string, i: EntryIn): Promise<EntryDto> {
  const e = await trx.insertInto('book_entry').values({ tenant_id: tenantId, created_by: userId, ...entryValues(i) }).returningAll().executeTakeFirstOrThrow();
  return toEntry(e);
}
export async function updateEntry(trx: Trx, id: number, i: EntryIn): Promise<EntryDto> {
  const e = await trx.updateTable('book_entry').set(entryValues(i)).where('id', '=', id).returningAll().executeTakeFirst();
  if (!e) throw new AppError('BOOK_ENTRY_NOT_FOUND', 'Không có bút ghi sổ', 404);
  return toEntry(e);
}
export async function deleteEntry(trx: Trx, id: number): Promise<void> {
  const r = await trx.deleteFrom('book_entry').where('id', '=', id).returning('id').executeTakeFirst();
  if (!r) throw new AppError('BOOK_ENTRY_NOT_FOUND', 'Không có bút ghi sổ', 404);
}

// ---- Kho: mặt hàng và lần nhập, xuất ----
export const itemInput = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9._-]{1,30}$/, 'Mã chỉ gồm chữ, số, . _ - tối đa 30 ký tự'), name: z.string().trim().min(1).max(200), unit: z.string().trim().min(1).max(20), warehouse: optText(100) });
export type ItemIn = z.infer<typeof itemInput>;
export const moveInput = z.object({ itemId: z.number().int().positive(), moveDate: isoDate, docNo: optText(50), description: z.string().trim().min(1).max(500), direction: z.enum(['opening', 'in', 'out']), quantity: qty, unitPrice: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Đơn giá không hợp lệ').nullable().optional() })
  .superRefine((v, c) => {
    if (v.direction === 'out' && v.unitPrice != null) c.addIssue({ code: 'custom', path: ['unitPrice'], message: 'Dòng xuất không nhập đơn giá (tính theo bình quân)' });
    if (v.direction !== 'out' && v.unitPrice == null) c.addIssue({ code: 'custom', path: ['unitPrice'], message: 'Dòng nhập và tồn đầu phải có đơn giá' });
    if (D(v.quantity).lte(0)) c.addIssue({ code: 'custom', path: ['quantity'], message: 'Số lượng phải lớn hơn 0' });
  });
export type MoveIn = z.infer<typeof moveInput>;
export async function listItems(trx: Trx) { return (await trx.selectFrom('book_stock_item').selectAll().orderBy('code').execute()).map((x) => ({ id: x.id, code: x.code, name: x.name, unit: x.unit, warehouse: x.warehouse })); }
export async function createItem(trx: Trx, tenantId: string, i: ItemIn) {
  const x = await trx.insertInto('book_stock_item').values({ tenant_id: tenantId, code: i.code, name: i.name, unit: i.unit, warehouse: i.warehouse ?? null }).returningAll().executeTakeFirstOrThrow();
  return { id: x.id, code: x.code, name: x.name, unit: x.unit, warehouse: x.warehouse };
}
export async function listMoves(trx: Trx, f: { itemId?: number | undefined; from?: string | undefined; to?: string | undefined }) {
  let q = trx.selectFrom('book_stock_move').selectAll();
  if (f.itemId) q = q.where('item_id', '=', f.itemId);
  if (f.from) q = q.where('move_date', '>=', f.from);
  if (f.to) q = q.where('move_date', '<=', f.to);
  return (await q.orderBy('move_date').orderBy('id').limit(5000).execute()).map((m) => ({ id: m.id, itemId: m.item_id, moveDate: m.move_date, docNo: m.doc_no, description: m.description, direction: m.direction, quantity: m.quantity, unitPrice: m.unit_price }));
}
export async function createMove(trx: Trx, tenantId: string, userId: string, i: MoveIn) {
  const m = await trx.insertInto('book_stock_move').values({ tenant_id: tenantId, created_by: userId, item_id: i.itemId, move_date: i.moveDate, doc_no: i.docNo ?? null, description: i.description, direction: i.direction, quantity: i.quantity, unit_price: i.unitPrice ?? null }).returning('id').executeTakeFirstOrThrow();
  return { id: m.id };
}
// Chiều của dòng nhập, xuất hiện có (để kiểm cờ view_cost trước khi xóa); không có dòng thì 404.
export async function moveDirection(trx: Trx, id: number): Promise<string> {
  const r = await trx.selectFrom('book_stock_move').select('direction').where('id', '=', id).executeTakeFirst();
  if (!r) throw new AppError('BOOK_MOVE_NOT_FOUND', 'Không có dòng nhập, xuất kho', 404);
  return r.direction;
}
export async function deleteMove(trx: Trx, id: number) {
  if (!(await trx.deleteFrom('book_stock_move').where('id', '=', id).returning('id').executeTakeFirst())) throw new AppError('BOOK_MOVE_NOT_FOUND', 'Không có dòng nhập, xuất kho', 404);
}

// ---- Thuế khác ----
export const otherTaxInput = z.object({
  entryDate: isoDate, description: z.string().trim().min(1).max(500), taxKind: z.enum(OTHER_TAX_KINDS), quantity: qty.nullable().optional(), absRate: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/).nullable().optional(),
  unitPrice: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/).nullable().optional(), ratePct: z.string().regex(/^\d{1,4}(\.\d{1,4})?$/).nullable().optional(), otherAmount: money.nullable().optional(),
}).superRefine((v, c) => {
  if ((v.taxKind === 'other') !== (v.otherAmount != null)) c.addIssue({ code: 'custom', path: ['otherAmount'], message: 'Chỉ loại "Khác" nhập số thuế trực tiếp' });
  if (v.taxKind === 'xnk_ttdb' && v.ratePct == null && v.absRate == null) c.addIssue({ code: 'custom', path: ['ratePct'], message: 'Thuế xuất khẩu, nhập khẩu, tiêu thụ đặc biệt cần thuế suất hoặc mức thuế tuyệt đối' });
});
export type OtherTaxIn = z.infer<typeof otherTaxInput>;
export async function listOtherTax(trx: Trx, f: { from: string; to: string }) {
  return (await trx.selectFrom('book_other_tax').selectAll().where('entry_date', '>=', f.from).where('entry_date', '<=', f.to).orderBy('entry_date').orderBy('id').limit(5000).execute())
    .map((r) => ({ id: r.id, entryDate: r.entry_date, description: r.description, taxKind: r.tax_kind, quantity: r.quantity, absRate: r.abs_rate, unitPrice: r.unit_price, ratePct: r.rate_pct, otherAmount: r.other_amount }));
}
export async function createOtherTax(trx: Trx, tenantId: string, userId: string, i: OtherTaxIn) {
  const r = await trx.insertInto('book_other_tax').values({ tenant_id: tenantId, created_by: userId, entry_date: i.entryDate, description: i.description, tax_kind: i.taxKind, quantity: i.quantity ?? null, abs_rate: i.absRate ?? null, unit_price: i.unitPrice ?? null, rate_pct: i.ratePct ?? null, other_amount: i.otherAmount ?? null }).returning('id').executeTakeFirstOrThrow();
  return { id: r.id };
}
export async function deleteOtherTax(trx: Trx, id: number) {
  if (!(await trx.deleteFrom('book_other_tax').where('id', '=', id).returning('id').executeTakeFirst())) throw new AppError('BOOK_OTHER_TAX_NOT_FOUND', 'Không có dòng thuế khác', 404);
}

// ---- Tính toán dùng chung ----
export interface Ent { id: number; date: string; docNo: string | null; desc: string; kind: string; amount: Decimal; groupId: number | null; cat: string | null; taxType: string | null; openRef: string | null; money: string | null }
export async function loadEntries(trx: Trx, from: string, to: string): Promise<Ent[]> {
  return (await trx.selectFrom('book_entry').selectAll().where('entry_date', '>=', from).where('entry_date', '<=', to).orderBy('entry_date').orderBy('id').execute())
    .map((e) => ({ id: e.id, date: e.entry_date, docNo: e.doc_no, desc: e.description, kind: e.kind, amount: D(e.amount), groupId: e.group_id, cat: e.expense_cat, taxType: e.tax_type, openRef: e.opening_ref, money: e.money_account }));
}
export interface Grp { id: number; code: string; name: string; vatRate: Decimal | null; incomeRate: Decimal | null }
export async function loadGroups(trx: Trx): Promise<Map<number, Grp>> {
  return new Map((await trx.selectFrom('book_group').selectAll().orderBy('code').execute()).map((g) => [g.id, { id: g.id, code: g.code, name: g.name, vatRate: g.vat_rate === null ? null : D(g.vat_rate), incomeRate: g.income_rate === null ? null : D(g.income_rate) }]));
}
export const sumOf = (xs: Ent[]) => xs.reduce((a, e) => a.plus(e.amount), D(0));
// Thuế của một nhóm = doanh thu nhóm x tỷ lệ %, làm tròn nửa lên đến đồng; chưa khai tỷ lệ thì 0 và báo trong chú thích của sổ.
export const pctTax = (base: Decimal, r: Decimal | null): Decimal => (r === null ? D(0) : vnd(base.times(r).div(100)));
export const profitTax = (rev: Decimal, exp: Decimal, r: Decimal | null): Decimal => { const p = rev.minus(exp); return p.gt(0) ? pctTax(p, r) : D(0); };

export interface TaxPosition { vat: Decimal; income: Decimal }
// Thuế phải nộp phát sinh trong [from, to] theo tỷ lệ nhóm (VAT, hoặc TNCN/TNDN theo % doanh thu) hoặc theo thu nhập tính thuế (`profit`).
export async function taxAccrued(trx: Trx, from: string, to: string, opts: { profitRate: Decimal | null; profit: boolean }): Promise<TaxPosition> {
  const ents = await loadEntries(trx, from, to); const groups = await loadGroups(trx);
  let vat = D(0); let inc = D(0);
  for (const g of groups.values()) {
    const rev = sumOf(ents.filter((e) => e.kind === 'revenue' && e.groupId === g.id));
    vat = vat.plus(pctTax(rev, g.vatRate)); if (!opts.profit) inc = inc.plus(pctTax(rev, g.incomeRate));
  }
  if (opts.profit) inc = profitTax(sumOf(ents.filter((e) => e.kind === 'revenue' || e.kind === 'other_income')), sumOf(ents.filter((e) => e.kind === 'expense')), opts.profitRate);
  return { vat, income: inc };
}
export const PROFIT_METHODS = new Set(['income', 'vat_percent_cit_profit', 'vat_deduct_cit_profit']);
export const dayBefore = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
export const yearBack = (d: string) => { const [y, m, day] = d.split('-').map(Number) as [number, number, number]; let x = new Date(Date.UTC(y - 1, m - 1, day)); if (x.getUTCMonth() !== m - 1) x = new Date(Date.UTC(y - 1, m - 1, day - 1)); return x.toISOString().slice(0, 10); };
export const profitFlagFor = (method: string | null) => method !== null && PROFIT_METHODS.has(method);
