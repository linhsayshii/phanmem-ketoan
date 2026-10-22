import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { READ_SNAPSHOT, type Database } from '@kt/db';
import { D, formatVnDate, formatVnNumber } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import * as S from '../ledger/vouchers.service.js';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { regimeOf } from '../reporting/ledgers.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import { voucherFormFor } from '../reporting/print/forms.js';
import { renderPdf } from '../reporting/print/pdf.js';
import { cell, DOTS, header, sign } from '../cash/cashCount.js';
import { esc, printShell, type CompanyInfo } from '../reporting/print/voucherHtml.js';
import { createStockVoucher, type StockVoucherInput } from './stockVouchers.js';

type Trx = Transaction<Database>;
type Ctx = { tenantId: string; userId: string; auth: { sensitive: Set<string> } };
const qty = /^\d{1,16}(\.\d{1,4})?$/;
const REASONS = ['unknown', 'income', 'cogs', 'loss'] as const;
// Tài khoản đối ứng theo lý do: thừa chưa rõ 3381, thừa ghi nhận thu nhập 711; thiếu chưa rõ 1381, trong định mức 632, mất mát ngoài định mức 811.
const SURPLUS: Record<string, string> = { unknown: '3381', income: '711' };
const SHORTAGE: Record<string, string> = { unknown: '1381', cogs: '632', loss: '811' };

export const createInput = z.object({ docDate: S.dateIso, warehouseCode: z.string().min(1), note: z.string().max(2000).nullable().optional() });
export const updateInput = z.object({
  note: z.string().max(2000).nullable().optional(),
  lines: z.array(z.object({ itemCode: z.string().min(1), lotNo: z.string().max(50).nullable().optional(), countedQty: z.string().regex(qty, 'Số lượng không hợp lệ').nullable(), reason: z.enum(REASONS).nullable().optional() })).max(2000),
});

export interface StocktakeDto {
  id: string; no: number; docDate: string; warehouseCode: string; warehouseName: string; status: string; note: string | null; adjustVoucherIds: string[]; adjustVouchers: { id: string; voucherNo: string | null; voucherType: string }[];
  lines: { itemCode: string; itemName: string; uomCode: string; lotNo: string | null; bookQty: string; countedQty: string | null; diffQty: string | null; reason: string | null }[];
}

async function load(trx: Trx, id: string, lock = false): Promise<StocktakeDto & { warehouseId: number }> {
  const s = await (lock ? trx.selectFrom('stocktake as s').forUpdate() : trx.selectFrom('stocktake as s')).innerJoin('warehouse as w', 'w.id', 's.warehouse_id')
    .select(['s.id', 's.seq', 's.doc_date', 's.status', 's.note', 's.warehouse_id', 'w.code as wh', 'w.name as wh_name']).where('s.id', '=', id).executeTakeFirst();
  if (!s) throw new AppError('STOCKTAKE_NOT_FOUND', 'Không tìm thấy phiếu kiểm kê kho', 404);
  const lines = await trx.selectFrom('stocktake_line as l').innerJoin('item as i', 'i.id', 'l.item_id').innerJoin('uom as u', 'u.id', 'i.base_uom_id')
    .select(['i.code', 'i.name', 'u.code as uom', 'l.lot_no', 'l.book_qty', 'l.counted_qty', 'l.diff_qty', 'l.reason']).where('l.stocktake_id', '=', id).orderBy('i.code').orderBy(sql`coalesce(l.lot_no, '')`).execute();
  const vs = await trx.selectFrom('stocktake_voucher as sv').innerJoin('voucher as v', 'v.id', 'sv.voucher_id').select(['v.id', 'v.voucher_no', 'v.voucher_type']).where('sv.stocktake_id', '=', id).orderBy('sv.id').execute();
  return { id: s.id, no: Number(s.seq), docDate: s.doc_date, warehouseCode: s.wh, warehouseName: s.wh_name, warehouseId: Number(s.warehouse_id), status: s.status, note: s.note,
    adjustVoucherIds: vs.map((v) => v.id), adjustVouchers: vs.map((v) => ({ id: v.id, voucherNo: v.voucher_no, voucherType: v.voucher_type })),
    lines: lines.map((l) => ({ itemCode: l.code, itemName: l.name, uomCode: l.uom, lotNo: l.lot_no, bookQty: D(l.book_qty).toFixed(4), countedQty: l.counted_qty === null ? null : D(l.counted_qty).toFixed(4), diffQty: l.diff_qty === null ? null : D(l.diff_qty).toFixed(4), reason: l.reason })) };
}
export const getStocktake = (trx: Trx, id: string) => load(trx, id);
export async function listStocktakes(trx: Trx) { // shortcut: 200 biên bản gần nhất, thêm phân trang khi cần
  const ids = await trx.selectFrom('stocktake').select('id').orderBy('doc_date', 'desc').orderBy('seq', 'desc').limit(200).execute();
  return Promise.all(ids.map((i) => load(trx, i.id)));
}

// Tồn sổ (ĐVT cơ sở) theo (hàng, lô) đến hết ngày kiểm kê, chỉ chứng từ đã ghi sổ (stock_move). Bỏ mọi hàng tồn 0.
async function bookOnHand(trx: Trx, warehouseId: number, date: string, itemId?: number) {
  const r = await sql<{ item_id: string; lot_no: string | null; q: string }>`SELECT item_id::text, lot_no, sum(CASE WHEN direction = 'in' THEN quantity ELSE -quantity END)::text AS q
    FROM stock_move WHERE warehouse_id = ${warehouseId}::bigint AND posting_date <= ${date}::date
      AND NOT EXISTS (SELECT 1 FROM voucher v WHERE v.id = stock_move.voucher_id AND v.source_doc_type = 'stocktake' AND v.state = 'reversed') -- phiếu điều chỉnh đã bị đảo (mở lại ở kỳ khóa): chứng từ đảo mang ngày sau ngày kiểm kê nên bỏ cả phiếu gốc
      ${itemId === undefined ? sql`` : sql`AND item_id = ${itemId}::bigint`}
    GROUP BY item_id, lot_no HAVING sum(CASE WHEN direction = 'in' THEN quantity ELSE -quantity END) <> 0`.execute(trx);
  return new Map(r.rows.map((x) => [`${x.item_id}|${x.lot_no ?? ''}`, x.q]));
}

export async function createStocktake(trx: Trx, ctx: { tenantId: string; userId: string }, input: z.infer<typeof createInput>): Promise<StocktakeDto> {
  await S.periodOf(trx, input.docDate, 'PNK'); // ngày phải thuộc kỳ đã mở
  const wh = await trx.selectFrom('warehouse').select(['id', 'is_active']).where('code', '=', input.warehouseCode).executeTakeFirst();
  if (!wh) throw new AppError('LOOKUP_NOT_FOUND', `Không có kho mã "${input.warehouseCode}"`, 404);
  if (!wh.is_active) throw new AppError('WAREHOUSE_INACTIVE', `Kho "${input.warehouseCode}" đã ngừng sử dụng`, 409);
  const s = await trx.insertInto('stocktake').values({ tenant_id: ctx.tenantId, doc_date: input.docDate, warehouse_id: wh.id, note: input.note ?? null, created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow();
  const book = await bookOnHand(trx, Number(wh.id), input.docDate);
  if (book.size) {
    const rows = [...book].map(([k, q]) => { const [itemId, lot] = k.split('|'); return { tenant_id: ctx.tenantId, stocktake_id: s.id, item_id: itemId!, lot_no: lot || null, book_qty: D(q).toFixed(4) }; });
    await trx.insertInto('stocktake_line').values(rows).execute();
  }
  return load(trx, s.id);
}

export async function updateStocktake(trx: Trx, ctx: { tenantId: string }, id: string, input: z.infer<typeof updateInput>): Promise<StocktakeDto> {
  const s = await load(trx, id, true);
  if (s.status !== 'draft') throw new AppError('STOCKTAKE_ADJUSTED', 'Kiểm kê đã điều chỉnh hoặc hủy, không sửa được', 409);
  if (input.note !== undefined) await trx.updateTable('stocktake').set({ note: input.note }).where('id', '=', id).execute();
  const codes = [...new Set(input.lines.map((l) => l.itemCode))];
  const items = new Map((await trx.selectFrom('item').select(['id', 'code', 'kind', 'tracking']).where('code', 'in', codes).execute()).map((r) => [r.code, r]));
  for (const l of input.lines) {
    const it = items.get(l.itemCode);
    if (!it) throw new AppError('LOOKUP_NOT_FOUND', `Không có vật tư hàng hóa mã "${l.itemCode}"`, 404);
    if (it.kind === 'service') throw new AppError('VALIDATION', `"${l.itemCode}" là dịch vụ, không kiểm kê kho`, 400);
    if (it.tracking === 'none' && l.lotNo) throw new AppError('LOT_NOT_TRACKED', `Hàng ${l.itemCode} không theo dõi theo lô, bỏ trống số lô`, 400);
    if (it.tracking !== 'none' && !l.lotNo) throw new AppError('LOT_REQUIRED', `Hàng ${l.itemCode} theo dõi theo lô, phải nhập số lô`, 400);
    const lot = l.lotNo || null;
    const cur = await trx.selectFrom('stocktake_line').select('id').where('stocktake_id', '=', id).where('item_id', '=', it.id).where(sql`coalesce(lot_no, '')`, '=', lot ?? '').executeTakeFirst();
    const set = { counted_qty: l.countedQty === null ? null : D(l.countedQty).toFixed(4), ...(l.reason !== undefined && { reason: l.reason }) };
    if (cur) await trx.updateTable('stocktake_line').set(set).where('id', '=', cur.id).execute();
    else { // hàng ngoài danh sách tồn sổ (thừa hàng không có tồn): tồn sổ lấy lại theo ngày kiểm kê
      const book = (await bookOnHand(trx, s.warehouseId, s.docDate, Number(it.id))).get(`${it.id}|${lot ?? ''}`) ?? '0';
      await trx.insertInto('stocktake_line').values({ tenant_id: ctx.tenantId, stocktake_id: id, item_id: it.id, lot_no: lot, book_qty: D(book).toFixed(4), ...set }).execute();
    }
  }
  return load(trx, id);
}

export async function deleteStocktake(trx: Trx, id: string): Promise<void> {
  const s = await load(trx, id, true);
  if (s.status !== 'draft') throw new AppError('STOCKTAKE_ADJUSTED', 'Kiểm kê đã điều chỉnh, không xóa được', 409);
  await trx.deleteFrom('stocktake').where('id', '=', id).execute();
}

// Điều chỉnh: thừa lập PNK (other_in), thiếu lập PXK (other_out) ở kho kiểm kê, ngày = ngày kiểm kê, ghi sổ ngay; giá trị theo giá tạm tính (xuất) và giá vốn tạm tính (nhập) tại ngày đó.
// Một giao dịch: lỗi ở bước nào (kỳ khóa, xuất âm, thiếu giá) thì không phiếu nào được ghi và kiểm kê vẫn là bản nháp. Tồn sổ làm mới theo ngày kiểm kê trước khi tính chênh lệch.
export async function adjustStocktake(trx: Trx, ctx: Ctx, id: string): Promise<StocktakeDto> {
  const s = await load(trx, id, true);
  if (s.status === 'adjusted') throw new AppError('STOCKTAKE_ADJUSTED', 'Kiểm kê đã điều chỉnh, không chạy lại được', 409);
  if (s.status !== 'draft') throw new AppError('STOCKTAKE_ADJUSTED', 'Kiểm kê đã hủy', 409);
  const rows = await trx.selectFrom('stocktake_line as l').innerJoin('item as i', 'i.id', 'l.item_id').innerJoin('uom as u', 'u.id', 'i.base_uom_id')
    .select(['l.id', 'l.item_id', 'i.code', 'i.tracking', 'u.code as uom', 'l.lot_no', 'l.counted_qty', 'l.reason']).where('l.stocktake_id', '=', id).where('l.counted_qty', 'is not', null).execute();
  const book = await bookOnHand(trx, s.warehouseId, s.docDate);
  const diffs: ((typeof rows)[number] & { diff: ReturnType<typeof D> })[] = [];
  for (const r of rows) {
    const b = D(book.get(`${r.item_id}|${r.lot_no ?? ''}`) ?? '0'); const d = D(r.counted_qty!).minus(b);
    await trx.updateTable('stocktake_line').set({ book_qty: b.toFixed(4) }).where('id', '=', r.id).execute();
    if (!d.isZero()) diffs.push({ ...r, diff: d });
  }
  if (!diffs.length) throw new AppError('STOCKTAKE_NO_DIFFERENCE', 'Không có chênh lệch giữa tồn sổ và số đếm để điều chỉnh', 400);

  const { regime } = await S.periodOf(trx, s.docDate, 'PNK');
  const accountOf = (r: (typeof diffs)[number]) => {
    const reason = r.reason ?? 'unknown'; const code = (r.diff.gt(0) ? SURPLUS : SHORTAGE)[reason];
    if (!code) throw new AppError('STOCKTAKE_REASON_INVALID', `Hàng ${r.code}: lý do "${reason}" không dùng cho ${r.diff.gt(0) ? 'hàng thừa' : 'hàng thiếu'}`, 400);
    return code;
  };
  const codes = [...new Set(diffs.map(accountOf))];
  const accs = await trx.selectFrom('account').select(['code', 'is_group']).where('regime', '=', regime).where('code', 'in', codes).execute();
  for (const c of codes) if (!accs.find((a) => a.code === c && !a.is_group)) throw new AppError('STOCKTAKE_ACCOUNT_INVALID', `Tài khoản ${c} không có hoặc không phải tài khoản chi tiết trong chế độ ${regime}`, 400);

  const out: string[] = [];
  const common = { postingDate: s.docDate, documentDate: s.docDate, warehouseCode: s.warehouseCode, description: `Điều chỉnh chênh lệch kiểm kê kho ${s.warehouseCode} ngày ${formatVnDate(s.docDate)}` };
  for (const surplus of [true, false]) {
    const part = diffs.filter((r) => r.diff.gt(0) === surplus);
    if (!part.length) continue;
    const items: StockVoucherInput['items'] = [];
    for (const r of part) {
      const base = { itemCode: r.code, uomCode: r.uom, quantity: r.diff.abs().toFixed(4), ...(r.lot_no ? { lotNo: r.lot_no } : {}) };
      if (!surplus) { items.push({ ...base, debitAccountCode: accountOf(r) }); continue; }
      const cost = (await sql<{ c: string }>`SELECT fn_stock_estimate_cost(${r.item_id}::bigint, ${s.warehouseId}::bigint, ${s.docDate}::date)::text AS c`.execute(trx)).rows[0]!.c;
      // Hàng theo hạn dùng: lô đã có thì lấy lại hạn dùng của lô.
      const exp = r.tracking === 'lot_expiry' && r.lot_no ? (await trx.selectFrom('stock_move').select('expiry_date').where('item_id', '=', Number(r.item_id)).where('lot_no', '=', r.lot_no).where('expiry_date', 'is not', null).orderBy('id', 'desc').executeTakeFirst())?.expiry_date : undefined;
      items.push({ ...base, unitPrice: D(cost).toFixed(4), creditAccountCode: accountOf(r), ...(exp ? { expiryDate: exp } : {}) });
    }
    const v = await createStockVoucher(trx, ctx, { ...common, voucherType: surplus ? 'PNK' : 'PXK', stockKind: surplus ? 'other_in' : 'other_out', items });
    await trx.updateTable('voucher').set({ source_doc_type: 'stocktake', source_doc_id: id }).where('id', '=', v.id).execute();
    await trx.insertInto('stocktake_voucher').values({ tenant_id: ctx.tenantId, stocktake_id: id, voucher_id: v.id }).execute();
    await S.postVoucher(trx, v.id);
    out.push(v.id);
  }
  await trx.updateTable('stocktake').set({ status: 'adjusted', adjusted_at: sql`now()` }).where('id', '=', id).execute();
  return load(trx, id);
}

// ---- Biên bản kiểm kê: mẫu 05-VT chép số mẫu từ văn bản gốc (TT 133/2016, TT 99/2025); chế độ không có văn bản gốc thì không in dòng "Mẫu số". Không in đơn giá, thành tiền (giá vốn là dữ liệu nhạy cảm). ----
export function renderStocktakeHtml(k: StocktakeDto, c: CompanyInfo, regime = 'TT133'): string {
  const [y, m, d] = k.docDate.split('-'); const f = (v: string) => formatVnNumber(v, 4).replace(/,?0+$/, '').replace(/[.,]$/, '');
  const body = k.lines.map((l, i) => {
    const diff = l.diffQty === null ? null : D(l.diffQty);
    return `<tr>${cell(i + 1)}${cell(`${esc(l.itemCode)} - ${esc(l.itemName)}`)}${cell(esc(l.uomCode))}${cell(esc(l.lotNo ?? ''))}${cell(f(l.bookQty), 'num')}${cell(l.countedQty === null ? '' : f(l.countedQty), 'num')}`
      + `${cell(diff && diff.gt(0) ? f(diff.toFixed(4)) : '', 'num')}${cell(diff && diff.lt(0) ? f(diff.abs().toFixed(4)) : '', 'num')}${cell('')}</tr>`;
  }).join('');
  // Tiêu đề và người ký chép từ văn bản gốc: TT99 là biên bản tổng hợp, có Hội đồng kiểm kê; TT133 (và TT200, chưa có văn bản gốc nên không in số mẫu) dùng bản 133.
  const t99 = regime === 'TT99';
  const title = t99 ? 'BIÊN BẢN TỔNG HỢP KIỂM KÊ VẬT TƯ, CÔNG CỤ, SẢN PHẨM, HÀNG HÓA' : 'BIÊN BẢN KIỂM KÊ VẬT TƯ, CÔNG CỤ, SẢN PHẨM, HÀNG HÓA';
  const html = `<div class="cv">${header(c)}<h1>${title}</h1>
    <p>Số: <b>${k.no}</b> &nbsp; Thời điểm kiểm kê: ngày <b>${d}</b> tháng <b>${m}</b> năm <b>${y}</b></p>
    <p>Kho: <b>${esc(k.warehouseCode)} - ${esc(k.warehouseName)}</b></p>
    <p>${t99 ? 'Ban kiểm kê/Hội đồng kiểm kê gồm' : 'Ban kiểm kê gồm'}: ${DOTS}${DOTS}</p>
    <table class="grid"><thead><tr><th rowspan="2">STT</th><th rowspan="2">Mã, tên vật tư, hàng hóa</th><th rowspan="2">Đơn vị tính</th><th rowspan="2">Số lô</th><th rowspan="2">Số lượng theo sổ</th><th rowspan="2">Số lượng kiểm kê</th><th colspan="2">Chênh lệch</th><th rowspan="2">Ghi chú</th></tr><tr><th>Thừa</th><th>Thiếu</th></tr></thead><tbody>${body}</tbody></table>
    <p>- Ý kiến giải quyết số chênh lệch: ${k.note ? esc(k.note) : DOTS}</p>
    ${sign(['Giám đốc', 'Kế toán trưởng', 'Thủ kho', t99 ? 'Trưởng ban/Chủ tịch Hội đồng kiểm kê' : 'Trưởng ban kiểm kê'])}</div>`;
  return printShell(`${title} ${formatVnDate(k.docDate)}`, html);
}

// Mở lại biên bản đã điều chỉnh: kỳ mở thì bỏ ghi sổ rồi hủy phiếu điều chỉnh; kỳ đã khóa thì đảo (chứng từ đảo ghi sổ ở postingDate, kỳ đang mở). Phiếu cũ vẫn mang source_doc_id của biên bản và nằm trong audit_event.
export async function reopenStocktake(trx: Trx, id: string, postingDate: string): Promise<StocktakeDto> {
  const s = await load(trx, id, true);
  if (s.status !== 'adjusted') throw new AppError('STOCKTAKE_NOT_ADJUSTED', 'Chỉ mở lại được biên bản đã điều chỉnh', 409);
  const vs = await trx.selectFrom('stocktake_voucher as sv').innerJoin('voucher as v', 'v.id', 'sv.voucher_id').select(['v.id', 'v.state', 'v.posting_date']).where('sv.stocktake_id', '=', id).orderBy('v.id').execute();
  for (const v of vs) {
    if (v.state === 'posted') {
      const p = await trx.selectFrom('fiscal_period').select('status').where('period_no', '>=', 1).where('period_no', '<=', 15).where('date_from', '<=', v.posting_date).where('date_to', '>=', v.posting_date).executeTakeFirst();
      if (p?.status === 'open') { await sql`SELECT unpost_voucher(${v.id}::uuid)`.execute(trx); await sql`SELECT discard_voucher(${v.id}::uuid)`.execute(trx); }
      else await S.reverseVoucher(trx, v.id, { postingDate, description: `Đảo điều chỉnh kiểm kê kho ngày ${formatVnDate(s.docDate)} (mở lại biên bản)` });
    } else if (v.state === 'draft') await sql`SELECT discard_voucher(${v.id}::uuid)`.execute(trx);
  }
  await trx.deleteFrom('stocktake_voucher').where('stocktake_id', '=', id).execute();
  await trx.updateTable('stocktake').set({ status: 'draft', adjusted_at: null }).where('id', '=', id).execute();
  return load(trx, id);
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const idParam = z.object({ id: z.string().uuid() });
  const ctx = (req: { auth: { tenantId: string | null; userId: string; sensitive: Set<string> } | null }) => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId, auth: req.auth! });
  app.get('/api/stocktakes', { preHandler: app.requirePermission('stocktake.view') }, async (req) => app.withTenant(req, (trx) => listStocktakes(trx), READ_SNAPSHOT));
  app.get('/api/stocktakes/:id', { preHandler: app.requirePermission('stocktake.view'), schema: { params: idParam } }, async (req) => app.withTenant(req, (trx) => getStocktake(trx, req.params.id), READ_SNAPSHOT));
  app.post('/api/stocktakes', { preHandler: app.requirePermission('stocktake.create'), schema: { body: createInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => createStocktake(trx, ctx(req), req.body))));
  app.put('/api/stocktakes/:id', { preHandler: app.requirePermission('stocktake.update'), schema: { params: idParam, body: updateInput } }, async (req) =>
    app.withTenant(req, (trx) => updateStocktake(trx, ctx(req), req.params.id, req.body)));
  app.delete('/api/stocktakes/:id', { preHandler: app.requirePermission('stocktake.delete'), schema: { params: idParam } }, async (req, reply) => {
    await app.withTenant(req, (trx) => deleteStocktake(trx, req.params.id)); return reply.status(204).send(); });
  // Điều chỉnh lập và ghi sổ phiếu kho nên cần thêm quyền phiếu kho; ctx.auth mang cờ view_cost (giá trị tồn kho là dữ liệu nhạy cảm, thiếu thì 403).
  app.post('/api/stocktakes/:id/adjust', { preHandler: app.requirePermission('stocktake.update'), schema: { params: idParam } }, async (req) => {
    for (const p of ['stock_voucher.create', 'stock_voucher.post']) if (!req.auth!.permissions.has(p)) throw new AppError('FORBIDDEN', `Thiếu quyền ${p}`, 403);
    const dto = await app.withOverride(req, (trx) => adjustStocktake(trx, ctx(req), req.params.id));
    notifyRecompute(app, req.auth!.tenantId!);
    return dto;
  });
  app.post('/api/stocktakes/:id/reopen', { preHandler: app.requirePermission('stocktake.update'), schema: { params: idParam, body: z.object({ postingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).default({}) } }, async (req) => {
    for (const p of ['stock_voucher.create', 'stock_voucher.post']) if (!req.auth!.permissions.has(p)) throw new AppError('FORBIDDEN', `Thiếu quyền ${p}`, 403);
    const dto = await app.withOverride(req, (trx) => reopenStocktake(trx, req.params.id, req.body.postingDate ?? new Date().toISOString().slice(0, 10)));
    notifyRecompute(app, req.auth!.tenantId!);
    return dto;
  });
  app.get('/api/stocktakes/:id/print', { preHandler: app.requirePermission('stocktake.view'), schema: { params: idParam, querystring: z.object({ format: z.enum(['html', 'pdf']).default('html') }) } }, async (req, reply) => {
    const { html, no } = await app.withTenant(req, async (trx) => {
      const k = await load(trx, req.params.id);
      const regime = await regimeOf(trx, { from: k.docDate, to: k.docDate });
      const f = voucherFormFor(regime, '05-VT');
      return { no: k.no, html: renderStocktakeHtml(k, { ...(await companyInfo(trx, req.auth!.tenantId!, regime, '05-VT')), formNo: f?.formNo ?? '', issuedBy: f?.issuedBy ?? '' }, regime) };
    }, READ_SNAPSHOT);
    if (req.query.format === 'html') return reply.type('text/html; charset=utf-8').send(html);
    return reply.type('application/pdf').header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(`kiem-ke-kho-${no}.pdf`)}`).send(await renderPdf(html));
  });
};
export default routes;
