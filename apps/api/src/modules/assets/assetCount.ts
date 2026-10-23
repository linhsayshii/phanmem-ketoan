import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, Decimal } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { dateIso } from '../ledger/vouchers.service.js';
import { idOf } from './assets.js';
import { departmentAt } from './reports.js';
import { assetValues } from './schedule.js';

// Kiểm kê TSCĐ, công cụ dụng cụ (05 - TSCĐ): số sổ sách là ảnh chụp tại ngày kiểm kê (fill), số kiểm kê chỉ nhập số lượng, nguyên giá và giá trị còn lại theo kiểm kê tính tỷ lệ.
// Chênh lệch không tự sinh chứng từ: màn hình gợi ý Ghi giảm (thiếu) hoặc Ghi tăng (thừa).
type Trx = Transaction<Database>;
const qty = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Số lượng không hợp lệ');
export const countInput = z.object({
  kind: z.enum(['fixed', 'tool']), countDate: dateIso, departmentCode: z.string().nullable().optional(), note: z.string().max(2000).nullable().optional(),
  members: z.array(z.object({ name: z.string().trim().min(1).max(100), position: z.string().max(100).nullable().optional(), role: z.string().max(100).nullable().optional() })).max(20).optional(),
});
export const countUpdate = z.object({
  note: z.string().max(2000).nullable().optional(), members: countInput.shape.members,
  lines: z.array(z.object({ assetId: z.number().int().positive(), actualQuantity: qty.nullable(), condition: z.string().max(200).nullable().optional(), note: z.string().max(500).nullable().optional() })).max(5000),
});

export interface CountLine {
  assetId: number; code: string; name: string; uom: string | null; departmentCode: string | null; bookQuantity: string; actualQuantity: string | null; diffQuantity: string | null;
  bookCost: string; bookNbv: string; actualCost: string | null; actualNbv: string | null; diffCost: string | null; diffNbv: string | null; condition: string | null; note: string | null; suggestion: 'decrease' | 'increase' | null;
}
export interface CountDto { id: number; kind: string; countDate: string; departmentCode: string | null; departmentName: string | null; members: { name: string; position?: string | null; role?: string | null }[]; note: string | null; status: string; lines: CountLine[] }

// Theo kiểm kê = số sổ × số kiểm kê / số lượng sổ (làm tròn nửa lên): thẻ một đơn vị thiếu → 0, CCDC giảm một phần → tỷ lệ.
const prorate = (v: string, actual: Decimal, book: string) => D(v).times(actual).div(book).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

// Điều chuyển hiệu lực theo từng thẻ, sắp theo ngày: để dựng bộ phận tại ngày kiểm kê.
async function transfersOf(trx: Trx, ids: number[]) {
  const m = new Map<number, { date: string; data: Record<string, unknown> }[]>();
  if (!ids.length) return m;
  const es = await trx.selectFrom('asset_event').select(['asset_id', 'event_date', 'data']).where('asset_id', 'in', ids).where('kind', '=', 'transfer').where('state', '=', 'active').orderBy('event_date').orderBy('created_at').execute();
  for (const e of es) (m.get(Number(e.asset_id)) ?? m.set(Number(e.asset_id), []).get(Number(e.asset_id))!).push({ date: e.event_date, data: e.data as Record<string, unknown> });
  return m;
}

export async function loadCount(trx: Trx, id: number, lock = false, withLines = true): Promise<CountDto> {
  const c = await (lock ? trx.selectFrom('asset_count as c').forUpdate('c') : trx.selectFrom('asset_count as c')).leftJoin('department as d', 'd.id', 'c.department_id')
    .select(['c.id', 'c.kind', 'c.count_date', 'c.members', 'c.note', 'c.status', 'd.code as dept', 'd.name as dept_name']).where('c.id', '=', id).executeTakeFirst();
  if (!c) throw new AppError('ASSET_COUNT_NOT_FOUND', 'Không tìm thấy biên bản kiểm kê tài sản', 404);
  const ls = withLines ? await trx.selectFrom('asset_count_line as l').innerJoin('asset as a', 'a.id', 'l.asset_id')
    .select(['a.id as asset_id', 'a.code', 'a.name', 'a.uom', 'a.department_id as dept_id', 'l.book_quantity', 'l.actual_quantity', 'l.book_cost', 'l.book_nbv', 'l.condition', 'l.note']).where('l.count_id', '=', id).orderBy('a.code').execute() : [];
  const trs = await transfersOf(trx, ls.map((l) => Number(l.asset_id)));
  const codes = new Map((await trx.selectFrom('department').select(['id', 'code']).execute()).map((d) => [Number(d.id), d.code]));
  const lines = ls.map((l): CountLine => {
    const act = l.actual_quantity === null ? null : D(l.actual_quantity);
    const ac = act && D(l.book_quantity).gt(0) ? prorate(l.book_cost, act, l.book_quantity) : null; const an = act && D(l.book_quantity).gt(0) ? prorate(l.book_nbv, act, l.book_quantity) : null;
    const diff = act ? act.minus(l.book_quantity) : null;
    return { assetId: Number(l.asset_id), code: l.code, name: l.name, uom: l.uom, departmentCode: codes.get(departmentAt(trs.get(Number(l.asset_id)) ?? [], c.count_date, l.dept_id === null ? null : Number(l.dept_id), true) ?? -1) ?? null, bookQuantity: D(l.book_quantity).toFixed(4), actualQuantity: act?.toFixed(4) ?? null, diffQuantity: diff?.toFixed(4) ?? null,
      bookCost: D(l.book_cost).toFixed(0), bookNbv: D(l.book_nbv).toFixed(0), actualCost: ac?.toFixed(0) ?? null, actualNbv: an?.toFixed(0) ?? null,
      diffCost: ac ? ac.minus(l.book_cost).toFixed(0) : null, diffNbv: an ? an.minus(l.book_nbv).toFixed(0) : null, condition: l.condition, note: l.note,
      suggestion: diff && !diff.isZero() ? (diff.lt(0) ? 'decrease' : 'increase') : null };
  });
  return { id: Number(c.id), kind: c.kind, countDate: c.count_date, departmentCode: c.dept, departmentName: c.dept_name, members: c.members as CountDto['members'], note: c.note, status: c.status, lines };
}

// Danh sách chỉ có đầu biên bản và số dòng; mở một biên bản mới tải đủ dòng.
export async function listCounts(trx: Trx) { // shortcut: 200 biên bản gần nhất, thêm phân trang khi cần
  const ids = await trx.selectFrom('asset_count').select('id').orderBy('count_date', 'desc').orderBy('id', 'desc').limit(200).execute();
  const n = new Map((await trx.selectFrom('asset_count_line').select(['count_id', (eb) => eb.fn.countAll().as('n')]).groupBy('count_id').execute()).map((r) => [Number(r.count_id), Number(r.n)]));
  return Promise.all(ids.map(async (i) => ({ ...(await loadCount(trx, Number(i.id), false, false)), lineCount: n.get(Number(i.id)) ?? 0 })));
}

export async function createCount(trx: Trx, ctx: { tenantId: string; userId: string }, b: z.infer<typeof countInput>): Promise<CountDto> {
  const r = await trx.insertInto('asset_count').values({ tenant_id: ctx.tenantId, kind: b.kind, count_date: b.countDate, department_id: await idOf(trx, 'department', b.departmentCode, 'bộ phận'),
    members: JSON.stringify(b.members ?? []), note: b.note ?? null, created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow();
  return loadCount(trx, Number(r.id));
}

const draftOf = async (trx: Trx, id: number) => {
  const c = await loadCount(trx, id, true);
  if (c.status !== 'draft') throw new AppError('ASSET_COUNT_DONE', 'Biên bản kiểm kê đã hoàn thành, không sửa được', 409);
  return c;
};

export async function updateCount(trx: Trx, id: number, b: z.infer<typeof countUpdate>): Promise<CountDto> {
  await draftOf(trx, id);
  if (b.note !== undefined || b.members !== undefined) await trx.updateTable('asset_count').set({ ...(b.note !== undefined && { note: b.note }), ...(b.members !== undefined && { members: JSON.stringify(b.members) }) }).where('id', '=', id).execute();
  for (const l of b.lines) {
    const r = await trx.updateTable('asset_count_line').set({ actual_quantity: l.actualQuantity === null ? null : D(l.actualQuantity).toFixed(4), ...(l.condition !== undefined && { condition: l.condition }), ...(l.note !== undefined && { note: l.note }) })
      .where('count_id', '=', id).where('asset_id', '=', l.assetId).executeTakeFirst();
    if (!r.numUpdatedRows) throw new AppError('LOOKUP_NOT_FOUND', `Tài sản mã số ${l.assetId} không có trong biên bản kiểm kê (bấm điền số sổ sách trước)`, 404);
  }
  return loadCount(trx, id);
}

export async function deleteCount(trx: Trx, id: number): Promise<void> {
  await draftOf(trx, id);
  await trx.deleteFrom('asset_count').where('id', '=', id).execute();
}

/**
 * Điền số sổ sách tại ngày kiểm kê: thẻ cùng loại (và bộ phận tại ngày kiểm kê nếu chọn, dựng từ biến động điều chuyển) đã có nguyên giá đến ngày đó và chưa ghi giảm trước hoặc trong ngày.
 * Số lượng tại ngày = số lượng thẻ + phần ghi giảm một phần sau ngày đó (biến động hiệu lực). Làm lại được: giữ số kiểm kê đã nhập, bỏ dòng thẻ không còn thuộc phạm vi.
 */
export async function fillCount(trx: Trx, ctx: { tenantId: string }, id: number): Promise<CountDto> {
  const c = await draftOf(trx, id);
  const dept = c.departmentCode ? await idOf(trx, 'department', c.departmentCode, 'bộ phận') : null;
  const all = await trx.selectFrom('asset').select(['id', 'quantity', 'status', 'decrease_date', 'department_id']).where('kind', '=', c.kind).execute();
  const trs = await transfersOf(trx, all.map((a) => a.id));
  const inScope = (a: { id: number; department_id: number | null }) => dept === null || departmentAt(trs.get(a.id) ?? [], c.countDate, a.department_id === null ? null : Number(a.department_id), true) === dept;
  const assets = all.filter(inScope).filter((a) => !(a.status === 'decreased' && a.decrease_date !== null && a.decrease_date <= c.countDate));
  const ids = assets.map((a) => a.id);
  const vals = await assetValues(trx, ctx.tenantId, c.countDate, [], ids);
  const later = ids.length ? await trx.selectFrom('asset_event').select(['asset_id', 'data']).where('asset_id', 'in', ids).where('kind', '=', 'decrease').where('state', '=', 'active').where('event_date', '>', c.countDate).execute() : [];
  const back = new Map<number, Decimal>();
  for (const e of later) { // ghi giảm một phần sau ngày kiểm kê: số lượng giảm có trong data.quantity và nhỏ hơn số lượng trước đó
    const d = e.data as { quantity?: string; before?: { quantity?: string } };
    if (d.quantity && d.before?.quantity && D(d.quantity).lt(d.before.quantity)) back.set(e.asset_id, (back.get(e.asset_id) ?? D(0)).plus(d.quantity));
  }
  const rows = assets.flatMap((a) => {
    const v = vals.get(a.id); if (!v || D(v.cost).lte(0)) return [];
    return [{ tenant_id: ctx.tenantId, count_id: id, asset_id: a.id, book_quantity: D(a.quantity).plus(back.get(a.id) ?? 0).toFixed(4), book_cost: D(v.cost).toFixed(0), book_nbv: D(v.cost).minus(v.accumulated).toFixed(0) }];
  });
  const keep = rows.map((r) => r.asset_id);
  await trx.deleteFrom('asset_count_line').where('count_id', '=', id).$if(keep.length > 0, (qb) => qb.where('asset_id', 'not in', keep)).execute();
  for (const r of rows) {
    await trx.insertInto('asset_count_line').values(r).onConflict((oc) => oc.columns(['tenant_id', 'count_id', 'asset_id']).doUpdateSet({ book_quantity: r.book_quantity, book_cost: r.book_cost, book_nbv: r.book_nbv })).execute();
  }
  return loadCount(trx, id);
}

export async function finishCount(trx: Trx, id: number): Promise<CountDto> {
  const c = await draftOf(trx, id);
  if (!c.lines.length) throw new AppError('ASSET_COUNT_EMPTY', 'Biên bản kiểm kê chưa có dòng nào: điền số sổ sách trước', 400);
  const open = c.lines.filter((l) => l.actualQuantity === null).length;
  if (open) throw new AppError('ASSET_COUNT_INCOMPLETE', `Còn ${open} dòng chưa nhập số kiểm kê`, 400);
  await trx.updateTable('asset_count').set({ status: 'done' }).where('id', '=', id).execute();
  return loadCount(trx, id);
}
