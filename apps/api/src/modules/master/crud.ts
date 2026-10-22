import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { catalogByName, idKeyOf, type CatalogDef } from './catalogs.js';
import { applyConversions, resolveConversions } from './itemUoms.js';

type Trx = Transaction<Database>;
// currency có khóa chính (tenant_id, code) nên "id" của nó là code.
export const idColumn = (def: CatalogDef): string => (def.table === 'currency' ? 'code' : 'id');
const UUID_TABLES = new Set(['party_group', 'party', 'party_bank_account']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Thoát \, % và _ để từ khóa tìm kiếm là chuỗi thường, không phải mẫu LIKE (dùng cùng ILIKE ... ESCAPE '\').
export const likePattern = (q: string) => '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
// Danh mục có cột is_active (schema khai báo) mới có ngưng dùng / lọc trạng thái.
export const hasActiveFlag = (def: Pick<CatalogDef, 'schema'>): boolean => 'is_active' in def.schema.shape;
// Kiểm tra :id theo kiểu cột khóa trước khi truy vấn để id sai dạng trả 404 thay vì lỗi cast của PostgreSQL.
function assertId(def: CatalogDef, id: string): void {
  const re = def.table === 'currency' ? /^[A-Z]{3}$/ : UUID_TABLES.has(def.table as string) ? UUID_RE : /^\d{1,15}$/;
  if (!re.test(id)) throw new AppError('NOT_FOUND', 'Không tìm thấy bản ghi', 404);
}
const lookupsOf = (def: CatalogDef) => def.columns.filter((c) => (c.lookup && c.lookup.catalog !== 'currency') || c.account).map((c, i) => ({ key: c.key, idKey: idKeyOf(c), table: c.account ? 'account' : catalogByName(c.lookup!.catalog)!.table as string, alias: `l${i}` }));

// Cột `<x>_code` có lookup → cột `<x>_id` trong DB (trừ currency_code: khóa là chính mã).
// `cache` (tùy chọn, dùng khi nhập hàng loạt) nhớ kết quả tra cứu thành công theo (danh mục, mã); không nhớ kết quả không tìm thấy.
export async function resolveLookups(trx: Trx, def: CatalogDef, row: Record<string, unknown>, cache?: Map<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...row };
  for (const col of def.columns) {
    if ((!col.lookup && !col.account) || !(col.key in row)) continue;
    const catalog = col.account ? 'account' : col.lookup!.catalog;
    const target = col.account ? { table: 'account', label: 'hệ thống tài khoản' } : catalogByName(catalog)!;
    const value = row[col.key];
    const ck = `${catalog}|${String(value)}`;
    const notFound = () => new AppError('LOOKUP_NOT_FOUND', `Cột ${col.key}: không có mã "${String(value)}" trong ${target.label}`, 404);
    if (catalog === 'currency') {
      // Khóa của currency là chính mã nên giữ nguyên cột, chỉ kiểm tra mã có tồn tại trong công ty.
      if (value !== null && value !== undefined && value !== '' && !cache?.has(ck)) {
        if ((await sql`SELECT 1 FROM currency WHERE code = ${String(value)}`.execute(trx)).rows.length === 0) throw notFound();
        cache?.set(ck, true);
      }
      continue;
    }
    delete out[col.key];
    const idKey = idKeyOf(col);
    if (value === null || value === undefined || value === '') { out[idKey] = null; continue; }
    let id = cache?.get(ck);
    if (id === undefined) {
      // Tài khoản trùng mã giữa các chế độ: lấy theo chế độ của kỳ kế toán mới nhất.
      const q = col.account ? sql<{ id: unknown }>`SELECT id FROM account WHERE code = ${String(value)} AND regime = (SELECT regime FROM fiscal_period ORDER BY date_to DESC LIMIT 1)`
        : sql<{ id: unknown }>`SELECT id FROM ${sql.table(target.table as string)} WHERE code = ${String(value)}`;
      id = (await q.execute(trx)).rows[0]?.id;
      if (id === undefined) throw notFound();
      cache?.set(ck, id);
    }
    out[idKey] = id;
  }
  return out;
}

// Trả hàng kèm `<x>_code` thay cho `<x>_id` để giao diện và Excel dùng mã.
export async function listRows(trx: Trx, def: CatalogDef, q: { q?: string | undefined; page: number; size: number; active?: 'true' | 'false' | 'all' | undefined }, whereId?: string) {
  const lk = lookupsOf(def);
  const extra = lk.length ? sql.join(lk.map((j) => sql`, ${sql.ref(`${j.alias}.code`)} AS ${sql.ref(j.key)}`), sql``) : sql``;
  const joins = lk.length ? sql.join(lk.map((j) => sql` LEFT JOIN ${sql.table(j.table)} AS ${sql.ref(j.alias)} ON ${sql.ref(`${j.alias}.id`)} = ${sql.ref(`t.${j.idKey}`)}`), sql``) : sql``;
  const conds = [];
  if (q.q) { const like = likePattern(q.q); conds.push(sql`(${sql.join(def.searchIn.map((c) => sql`${sql.ref(`t.${c}`)}::text ILIKE ${like} ESCAPE '\\'`), sql` OR `)})`); }
  if (hasActiveFlag(def) && q.active && q.active !== 'all') conds.push(sql`${sql.ref('t.is_active')} = ${q.active === 'true'}`);
  if (whereId !== undefined) conds.push(sql`${sql.ref(`t.${idColumn(def)}`)} = ${whereId}`);
  const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
  const total = await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(def.table as string)} t ${where}`.execute(trx);
  const rows = await sql<Record<string, unknown>>`SELECT t.* ${extra} FROM ${sql.table(def.table as string)} t ${joins} ${where} ORDER BY ${sql.ref(`t.${def.sort}`)}, ${sql.ref(`t.${idColumn(def)}`)} LIMIT ${q.size} OFFSET ${(q.page - 1) * q.size}`.execute(trx);
  return { rows: rows.rows, total: Number(total.rows[0]!.n) };
}

export async function getRow(trx: Trx, def: CatalogDef, id: string) {
  assertId(def, id);
  const { rows } = await listRows(trx, def, { page: 1, size: 1 }, id);
  if (!rows[0]) throw new AppError('NOT_FOUND', `Không tìm thấy ${def.label}`, 404);
  return rows[0];
}

export async function setActive(trx: Trx, def: CatalogDef, id: string, active: boolean): Promise<void> {
  if (!hasActiveFlag(def)) throw new AppError('CATALOG_NO_ACTIVE_FLAG', `${def.label} không có trạng thái ngưng dùng`, 400);
  assertId(def, id);
  const r = await trx.updateTable(def.table as never).set({ is_active: active } as never).where(idColumn(def) as never, '=', id as never).executeTakeFirst();
  if (r.numUpdatedRows === 0n) throw new AppError('NOT_FOUND', `Không tìm thấy ${def.label}`, 404);
}

export async function createRow(trx: Trx, tenantId: string, def: CatalogDef, body: unknown): Promise<string> {
  const { uom_conversions: conv, ...values } = await resolveLookups(trx, def, def.schema.parse(body));
  const convs = typeof conv === 'string' && conv.trim() ? await resolveConversions(trx, conv, values['base_uom_id'] as number) : [];
  const r = await trx.insertInto(def.table as never).values({ ...values, tenant_id: tenantId } as never).returning(idColumn(def) as never).executeTakeFirstOrThrow() as Record<string, unknown>;
  await applyConversions(trx, tenantId, Number(r['id']), convs);
  return String(r[idColumn(def)]);
}

export async function updateRow(trx: Trx, def: CatalogDef, id: string, body: unknown): Promise<void> {
  assertId(def, id);
  const { uom_conversions: conv, ...values } = await resolveLookups(trx, def, def.schema.partial().parse(body));
  if (typeof conv === 'string' && conv.trim()) {
    const it = await trx.selectFrom('item').select(['tenant_id', 'base_uom_id']).where('id', '=', id as never).executeTakeFirst();
    if (it) await applyConversions(trx, it.tenant_id, Number(id), await resolveConversions(trx, conv, (values['base_uom_id'] as number | undefined) ?? it.base_uom_id));
  }
  if (Object.keys(values).length === 0) { await getRow(trx, def, id); return; }
  const r = await trx.updateTable(def.table as never).set(values as never).where(idColumn(def) as never, '=', id as never).executeTakeFirst();
  if (r.numUpdatedRows === 0n) throw new AppError('NOT_FOUND', `Không tìm thấy ${def.label}`, 404);
}

export async function deleteRow(trx: Trx, def: CatalogDef, id: string): Promise<void> {
  assertId(def, id);
  const r = await trx.deleteFrom(def.table as never).where(idColumn(def) as never, '=', id as never).executeTakeFirst();
  if (r.numDeletedRows === 0n) throw new AppError('NOT_FOUND', `Không tìm thấy ${def.label}`, 404);
}
