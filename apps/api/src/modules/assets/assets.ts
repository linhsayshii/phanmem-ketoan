import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { dateIso } from '../ledger/vouchers.service.js';
import { likePattern } from '../master/crud.js';

type Trx = Transaction<Database>;
const KINDS = ['fixed', 'tool', 'prepaid'] as const;
const optText = (max: number) => z.string().max(max).nullable().optional();
const life = z.number().int().min(1).max(1200).nullable().optional();

export const categoryInput = z.object({
  code: z.string().trim().min(1).max(30), name: z.string().trim().min(1).max(200), kind: z.enum(KINDS),
  assetAccountCode: z.string().min(1), depreciationAccountCode: z.string().min(1).nullable().optional(), defaultLifeUnits: life, isActive: z.boolean().optional(),
});
export const assetInput = z.object({
  code: z.string().trim().min(1).max(30), name: z.string().trim().min(1).max(200), kind: z.enum(KINDS), categoryCode: z.string().nullable().optional(),
  assetAccountCode: z.string().min(1).optional(), depreciationAccountCode: z.string().min(1).nullable().optional(), departmentCode: z.string().nullable().optional(),
  useDate: dateIso.nullable().optional(), depreciationStartDate: dateIso.nullable().optional(), lifeUnits: life, isDepreciable: z.boolean().optional(),
  capitalSource: z.enum(['owner', 'loan', 'grant', 'other']).nullable().optional(), cardNo: optText(50), country: optText(100), yearMade: z.number().int().min(1900).max(2200).nullable().optional(),
  spec: optText(500), quantity: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Số lượng không hợp lệ').optional(), uom: optText(50),
  openingYear: z.number().int().min(1900).max(2200).nullable().optional(), openingCost: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG).nullable().optional(),
  openingAccumulated: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG).nullable().optional(), openingRemainingUnits: z.string().regex(/^\d{1,12}(\.\d{1,12})?$/).nullable().optional(), note: optText(1000),
});
export const allocationInput = z.object({
  validFromYear: z.number().int().min(1900).max(2200), validFromPeriod: z.number().int().min(1).max(12),
  lines: z.array(z.object({
    expenseAccountCode: z.string().min(1), departmentCode: z.string().nullable().optional(), projectCode: z.string().nullable().optional(), costItemCode: z.string().nullable().optional(),
    ratio: z.string().regex(/^\d{1,3}(\.\d{1,6})?$/, 'Tỷ lệ không hợp lệ'),
  })).min(1).max(50),
});

// Mã tài khoản tra theo chế độ của kỳ kế toán muộn nhất (như danh mục kho, quyết định 198).
async function latestRegime(trx: Trx): Promise<string> {
  const r = await trx.selectFrom('fiscal_period').select('regime').orderBy('fiscal_year', 'desc').orderBy('period_no', 'desc').limit(1).executeTakeFirst();
  if (!r) throw new AppError('PERIOD_NOT_FOUND', 'Công ty chưa có năm tài chính nào', 404);
  return r.regime;
}
async function accountOf(trx: Trx, regime: string, code: string) {
  const a = await trx.selectFrom('account').select(['code', 'is_group', 'subledger_kind']).where('regime', '=', regime).where('code', '=', code).executeTakeFirst();
  if (!a) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản "${code}" trong hệ thống tài khoản`, 404);
  return a;
}
// TSCĐ: TK tài sản theo dõi tài sản (không phải 214x); TK hao mòn là 214x. CCDC, chi phí trả trước: TK 242.
export async function assertAssetAccounts(trx: Trx, kind: string, assetAccountCode: string, depreciationAccountCode: string | null | undefined): Promise<void> {
  if ((kind === 'fixed') !== !!depreciationAccountCode) throw new AppError('VALIDATION', kind === 'fixed' ? 'Tài sản cố định phải có tài khoản hao mòn' : 'Chỉ tài sản cố định có tài khoản hao mòn', 400);
  const regime = await latestRegime(trx);
  const a = await accountOf(trx, regime, assetAccountCode);
  const bad = (msg: string) => new AppError('ASSET_ACCOUNT_INVALID', msg, 400);
  if (a.is_group) throw bad(`Tài khoản ${assetAccountCode} là tài khoản tổng hợp, chọn tài khoản chi tiết`);
  if (kind === 'fixed') {
    if (a.subledger_kind !== 'fixed_asset' || assetAccountCode.startsWith('214')) throw bad(`Tài khoản ${assetAccountCode} không phải tài khoản nguyên giá tài sản cố định`);
    const d = await accountOf(trx, regime, depreciationAccountCode!);
    if (d.is_group || d.subledger_kind !== 'fixed_asset' || !depreciationAccountCode!.startsWith('214')) throw bad(`Tài khoản ${depreciationAccountCode} không phải tài khoản hao mòn tài sản cố định (214x)`);
  } else if (!assetAccountCode.startsWith('242')) throw bad(`Công cụ dụng cụ, chi phí trả trước ghi trên tài khoản 242, không phải ${assetAccountCode}`);
}
export async function lockTenant(trx: Trx, tenantId: string) { await sql`SELECT pg_advisory_xact_lock(hashtext('asset_run'), hashtext(${tenantId}))`.execute(trx); }
const hasLedger = async (trx: Trx, id: number) => !!(await trx.selectFrom('voucher_line').select('id').where('asset_id', '=', id).limit(1).executeTakeFirst())
  || !!(await trx.selectFrom('voucher_item_line').select('id').where('asset_id', '=', id).limit(1).executeTakeFirst());
export async function idOf(trx: Trx, table: 'department' | 'project' | 'cost_item' | 'asset_category', code: string | null | undefined, label: string): Promise<number | null> {
  if (!code) return null;
  const r = await trx.selectFrom(table).select('id').where('code', '=', code).executeTakeFirst();
  if (!r) throw new AppError('LOOKUP_NOT_FOUND', `Không có ${label} mã "${code}"`, 404);
  return r.id;
}

// ---------- Loại tài sản ----------
export interface CategoryDto { id: number; code: string; name: string; kind: string; assetAccountCode: string; depreciationAccountCode: string | null; defaultLifeUnits: number | null; isActive: boolean }
const catDto = (r: { id: number; code: string; name: string; kind: string; asset_account_code: string; depreciation_account_code: string | null; default_life_units: number | null; is_active: boolean }): CategoryDto =>
  ({ id: r.id, code: r.code, name: r.name, kind: r.kind, assetAccountCode: r.asset_account_code, depreciationAccountCode: r.depreciation_account_code, defaultLifeUnits: r.default_life_units, isActive: r.is_active });
export async function listCategories(trx: Trx, kind?: string): Promise<CategoryDto[]> {
  return (await trx.selectFrom('asset_category').selectAll().$if(!!kind, (q) => q.where('kind', '=', kind!)).orderBy('code').execute()).map(catDto);
}
export async function saveCategory(trx: Trx, tenantId: string, id: number | null, b: z.infer<typeof categoryInput>): Promise<CategoryDto> {
  await assertAssetAccounts(trx, b.kind, b.assetAccountCode, b.depreciationAccountCode);
  const v = { code: b.code, name: b.name, kind: b.kind, asset_account_code: b.assetAccountCode, depreciation_account_code: b.depreciationAccountCode ?? null, default_life_units: b.defaultLifeUnits ?? null, is_active: b.isActive ?? true };
  if (id === null) return catDto(await trx.insertInto('asset_category').values({ tenant_id: tenantId, ...v }).returningAll().executeTakeFirstOrThrow());
  const r = await trx.updateTable('asset_category').set(v).where('id', '=', id).returningAll().executeTakeFirst();
  if (!r) throw new AppError('NOT_FOUND', 'Không tìm thấy loại tài sản', 404);
  return catDto(r);
}
export async function deleteCategory(trx: Trx, id: number): Promise<void> {
  if (await trx.selectFrom('asset').select('id').where('category_id', '=', id).limit(1).executeTakeFirst()) throw new AppError('CATEGORY_IN_USE', 'Loại tài sản đã có thẻ tài sản, không xóa được', 409);
  const r = await trx.deleteFrom('asset_category').where('id', '=', id).executeTakeFirst();
  if (!r.numDeletedRows) throw new AppError('NOT_FOUND', 'Không tìm thấy loại tài sản', 404);
}

// ---------- Thẻ tài sản ----------
export interface AllocationDto { expenseAccountCode: string; departmentCode: string | null; projectCode: string | null; costItemCode: string | null; ratio: string }
export interface AssetDto {
  id: number; code: string; name: string; kind: string; categoryCode: string | null; assetAccountCode: string; depreciationAccountCode: string | null; departmentCode: string | null;
  useDate: string | null; depreciationStartDate: string | null; lifeUnits: number | null; isDepreciable: boolean; capitalSource: string | null; cardNo: string | null; country: string | null;
  yearMade: number | null; spec: string | null; quantity: string; uom: string | null; status: string; decreaseDate: string | null;
  openingYear: number | null; openingCost: string | null; openingAccumulated: string | null; openingRemainingUnits: string | null; note: string | null;
  allocationFrom: { year: number; period: number } | null; allocations: AllocationDto[];
}
async function assetsWhere(trx: Trx, f: { kind?: string | undefined; id?: number | undefined; q?: string | undefined }): Promise<AssetDto[]> {
  const rows = await trx.selectFrom('asset as a').leftJoin('asset_category as c', 'c.id', 'a.category_id').leftJoin('department as d', 'd.id', 'a.department_id')
    .selectAll('a').select(['c.code as category_code', 'd.code as department_code'])
    .$if(!!f.kind, (q) => q.where('a.kind', '=', f.kind!)).$if(f.id !== undefined, (q) => q.where('a.id', '=', f.id!))
    .$if(!!f.q, (q) => { const like = likePattern(f.q!); return q.where(sql<boolean>`(a.code ILIKE ${like} ESCAPE '\\' OR a.name ILIKE ${like} ESCAPE '\\')`); })
    .orderBy('a.code').execute();
  if (!rows.length) return [];
  const al = await trx.selectFrom('asset_allocation as x').leftJoin('department as d', 'd.id', 'x.department_id').leftJoin('project as p', 'p.id', 'x.project_id').leftJoin('cost_item as ci', 'ci.id', 'x.cost_item_id')
    .select(['x.asset_id', 'x.valid_from_year', 'x.valid_from_period', 'x.expense_account_code', 'x.ratio', 'd.code as department_code', 'p.code as project_code', 'ci.code as cost_item_code'])
    .where('x.asset_id', 'in', rows.map((r) => r.id)).orderBy('x.id').execute();
  return rows.map((r) => {
    const mine = al.filter((x) => x.asset_id === r.id);
    const cur = mine.reduce<{ year: number; period: number } | null>((m, x) => (!m || x.valid_from_year * 100 + x.valid_from_period > m.year * 100 + m.period ? { year: x.valid_from_year, period: x.valid_from_period } : m), null);
    return {
      id: r.id, code: r.code, name: r.name, kind: r.kind, categoryCode: r.category_code, assetAccountCode: r.asset_account_code, depreciationAccountCode: r.depreciation_account_code, departmentCode: r.department_code,
      useDate: r.use_date, depreciationStartDate: r.depreciation_start_date, lifeUnits: r.life_units, isDepreciable: r.is_depreciable, capitalSource: r.capital_source, cardNo: r.card_no, country: r.country,
      yearMade: r.year_made, spec: r.spec, quantity: r.quantity, uom: r.uom, status: r.status, decreaseDate: r.decrease_date,
      openingYear: r.opening_year, openingCost: r.opening_cost, openingAccumulated: r.opening_accumulated, openingRemainingUnits: r.opening_remaining_units, note: r.note,
      allocationFrom: cur, allocations: cur ? mine.filter((x) => x.valid_from_year === cur.year && x.valid_from_period === cur.period)
        .map((x) => ({ expenseAccountCode: x.expense_account_code, departmentCode: x.department_code, projectCode: x.project_code, costItemCode: x.cost_item_code, ratio: x.ratio })) : [],
    };
  });
}
export const listAssets = (trx: Trx, kind?: string, q?: string) => assetsWhere(trx, { kind, q });
export async function getAsset(trx: Trx, id: number): Promise<AssetDto> {
  const r = (await assetsWhere(trx, { id }))[0];
  if (!r) throw new AppError('ASSET_NOT_FOUND', 'Không tìm thấy thẻ tài sản', 404);
  return r;
}
export async function lookupAssets(trx: Trx, q: string, kind: string | undefined, size: number) {
  const like = likePattern(q);
  return (await trx.selectFrom('asset').select(['id', 'code', 'name', 'kind', 'asset_account_code'])
    .where(sql<boolean>`(code ILIKE ${like} ESCAPE '\\' OR name ILIKE ${like} ESCAPE '\\')`).$if(!!kind, (b) => b.where('kind', '=', kind!)).orderBy('code').limit(size).execute())
    .map((r) => ({ id: r.id, code: r.code, name: r.name, kind: r.kind, assetAccountCode: r.asset_account_code }));
}

export async function saveAsset(trx: Trx, tenantId: string, id: number | null, b: z.infer<typeof assetInput>): Promise<AssetDto> {
  await lockTenant(trx, tenantId);
  const cat = b.categoryCode ? await trx.selectFrom('asset_category').selectAll().where('code', '=', b.categoryCode).executeTakeFirst() : undefined;
  if (b.categoryCode && !cat) throw new AppError('LOOKUP_NOT_FOUND', `Không có loại tài sản mã "${b.categoryCode}"`, 404);
  if (cat && cat.kind !== b.kind) throw new AppError('VALIDATION', 'Loại tài sản khác loại của thẻ (TSCĐ, CCDC, chi phí trả trước)', 400);
  const assetAccount = b.assetAccountCode ?? cat?.asset_account_code;
  if (!assetAccount) throw new AppError('VALIDATION', 'Thiếu tài khoản tài sản', 400);
  const depAccount = b.kind === 'fixed' ? (b.depreciationAccountCode ?? cat?.depreciation_account_code ?? null) : null;
  await assertAssetAccounts(trx, b.kind, assetAccount, depAccount);
  const v = {
    code: b.code, name: b.name, kind: b.kind, category_id: cat?.id ?? null, asset_account_code: assetAccount, depreciation_account_code: depAccount,
    department_id: await idOf(trx, 'department', b.departmentCode, 'bộ phận'), use_date: b.useDate ?? null, depreciation_start_date: b.depreciationStartDate ?? null,
    life_units: b.lifeUnits ?? cat?.default_life_units ?? null, is_depreciable: b.isDepreciable ?? true, capital_source: b.capitalSource ?? null, card_no: b.cardNo ?? null, country: b.country ?? null,
    year_made: b.yearMade ?? null, spec: b.spec ?? null, quantity: b.quantity ?? '1', uom: b.uom ?? null, opening_year: b.openingYear ?? null, opening_cost: b.openingCost ?? null,
    opening_accumulated: b.openingAccumulated ?? null, opening_remaining_units: b.openingRemainingUnits ?? null, note: b.note ?? null,
  };
  if (id === null) return getAsset(trx, (await trx.insertInto('asset').values({ tenant_id: tenantId, ...v }).returning('id').executeTakeFirstOrThrow()).id);
  const cur = await trx.selectFrom('asset').select(['kind', 'asset_account_code', 'depreciation_account_code', 'quantity', 'department_id']).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!cur) throw new AppError('ASSET_NOT_FOUND', 'Không tìm thấy thẻ tài sản', 404);
  if ((cur.kind !== v.kind || cur.asset_account_code !== v.asset_account_code || cur.depreciation_account_code !== v.depreciation_account_code) && await hasLedger(trx, id))
    throw new AppError('ASSET_ACCOUNT_LOCKED', 'Tài sản đã có bút toán trên sổ cái, không đổi được loại, tài khoản tài sản và tài khoản hao mòn', 409);
  // Thẻ đã có biến động hoặc bút toán: số lượng và bộ phận chỉ đổi qua biến động (ghi giảm, điều chuyển), PUT không ghi đè.
  const touched = await hasLedger(trx, id) || !!(await trx.selectFrom('asset_event').select('id').where('asset_id', '=', id).limit(1).executeTakeFirst());
  await trx.updateTable('asset').set(touched ? { ...v, quantity: cur.quantity, department_id: cur.department_id } : v).where('id', '=', id).execute();
  return getAsset(trx, id);
}
export async function deleteAsset(trx: Trx, tenantId: string, id: number): Promise<void> {
  await lockTenant(trx, tenantId);
  if (!(await trx.selectFrom('asset').select('id').where('id', '=', id).forUpdate().executeTakeFirst())) throw new AppError('ASSET_NOT_FOUND', 'Không tìm thấy thẻ tài sản', 404);
  if (await hasLedger(trx, id)) throw new AppError('ASSET_IN_USE', 'Tài sản đã có bút toán trên sổ cái, không xóa được', 409);
  await trx.deleteFrom('asset').where('id', '=', id).execute();
}

// Phân bổ chi phí hiệu lực từ (năm, kỳ): thay toàn bộ bộ dòng của (thẻ, năm, kỳ); tổng tỷ lệ = 100.
export async function setAllocations(trx: Trx, tenantId: string, id: number, b: z.infer<typeof allocationInput>): Promise<AssetDto> {
  await lockTenant(trx, tenantId);
  if (!(await trx.selectFrom('asset').select('id').where('id', '=', id).forUpdate().executeTakeFirst())) throw new AppError('ASSET_NOT_FOUND', 'Không tìm thấy thẻ tài sản', 404);
  if (!D(b.lines.reduce((s, l) => s.plus(l.ratio), D(0))).eq(100)) throw new AppError('ALLOCATION_RATIO', 'Tổng tỷ lệ phân bổ phải bằng 100%', 400);
  const regime = await latestRegime(trx);
  const rows = [];
  for (const l of b.lines) {
    const a = await accountOf(trx, regime, l.expenseAccountCode);
    if (a.is_group) throw new AppError('ASSET_ACCOUNT_INVALID', `Tài khoản chi phí ${l.expenseAccountCode} là tài khoản tổng hợp`, 400);
    rows.push({ tenant_id: tenantId, asset_id: id, valid_from_year: b.validFromYear, valid_from_period: b.validFromPeriod, expense_account_code: l.expenseAccountCode,
      department_id: await idOf(trx, 'department', l.departmentCode, 'bộ phận'), project_id: await idOf(trx, 'project', l.projectCode, 'vụ việc'), cost_item_id: await idOf(trx, 'cost_item', l.costItemCode, 'khoản mục chi phí'), ratio: l.ratio });
  }
  await trx.deleteFrom('asset_allocation').where('asset_id', '=', id).where('valid_from_year', '=', b.validFromYear).where('valid_from_period', '=', b.validFromPeriod).execute();
  await trx.insertInto('asset_allocation').values(rows).execute();
  return getAsset(trx, id);
}
