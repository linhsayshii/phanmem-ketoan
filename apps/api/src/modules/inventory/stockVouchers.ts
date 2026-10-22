import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, Decimal, stockCounterAccount, stockKindDef, toBaseQty, voucherTypeDef } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import * as S from '../ledger/vouchers.service.js';
import { assertSensitive } from '../reporting/ledgers.js';

type Trx = Transaction<Database>;
type Auth = { sensitive: Set<string> };
const qtyRe = /^\d{1,16}(\.\d{1,4})?$/;
const positive = (s: string) => /[1-9]/.test(s);
const optText = (max: number) => z.string().max(max).nullable().optional();

export const stockItemInput = z.object({
  itemCode: z.string().min(1), uomCode: z.string().min(1), quantity: z.string().regex(qtyRe, 'Số lượng không hợp lệ').refine(positive, 'Số lượng phải lớn hơn 0'),
  unitPrice: z.string().regex(qtyRe, 'Đơn giá không hợp lệ').optional(), lotNo: optText(50), mfgDate: S.dateIso.nullable().optional(), expiryDate: S.dateIso.nullable().optional(),
  debitAccountCode: z.string().nullable().optional(), creditAccountCode: z.string().nullable().optional(), warehouseCode: z.string().nullable().optional(),
  // Cố định giá vốn: dòng xuất giữ đúng đơn giá này khi tính giá vốn.
  fixedUnitCost: z.string().regex(qtyRe, 'Đơn giá vốn không hợp lệ').nullable().optional(),
  // Xuất dùng cho tài sản (TSCĐ, CCDC, chi phí trả trước): dòng Nợ TK tài sản mang thẻ này; giá vốn chạy sau ghi chênh trên cùng thẻ.
  assetCode: z.string().min(1).nullable().optional(),
});
export const stockVoucherInput = z.object({
  voucherType: z.enum(['PNK', 'PXK', 'CK']), stockKind: z.string().min(1), postingDate: S.dateIso, documentDate: S.dateIso.optional(),
  partyCode: z.string().nullable().optional(), personName: optText(200), attachmentsCount: z.number().int().min(0).max(999).nullable().optional(),
  warehouseCode: z.string().min(1), destWarehouseCode: z.string().nullable().optional(), description: z.string().nullable().optional(),
  items: z.array(stockItemInput).min(1, 'Phiếu phải có ít nhất một dòng hàng').max(500, 'Tối đa 500 dòng hàng mỗi phiếu'),
  sourceInvoiceIds: z.array(z.string().uuid()).max(100).optional(), // chỉ PNK mua hàng: hóa đơn mua hàng hóa về trước (MH invoice_first); thành tiền lấy theo hóa đơn, Có 151
});
export type StockVoucherInput = z.infer<typeof stockVoucherInput>;
export interface StockItemDto {
  lineNo: number; itemCode: string; itemName: string; uomCode: string; quantity: string; baseQuantity: string; uomFactor: string; unitPrice: string | null; unitCost: string | null; amount: string;
  lotNo: string | null; mfgDate: string | null; expiryDate: string | null; warehouseCode: string | null; destWarehouseCode: string | null; direction: string | null; debitAccountCode: string | null; creditAccountCode: string | null;
  assetCode: string | null;
  costRatio: string | null; // LR: tỷ lệ giá trị của dòng nhập kho (tổng 100)
  linkLineId: number | null; // dòng hóa đơn mua hàng hóa (về trước) mà dòng nhập này nhận hàng
}
export interface StockLedgerLineDto { lineNo: number; accountCode: string; accountName: string; debit: string; credit: string; itemCode: string | null; warehouseCode: string | null; partyCode: string | null }
export interface StockVoucherDto extends Omit<S.VoucherDto, 'lines'> { stockKind: string | null; warehouseCode: string | null; destWarehouseCode: string | null; items: StockItemDto[]; ledgerLines: StockLedgerLineDto[];
  assembly: { mode: string; extraCost: string; extraCostAccountCode: string | null } | null; // chỉ LR
  warnings: { code: string; message: string; lineNo?: number }[] }

const round0 = (d: Decimal) => d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);

// PNK mua hàng theo hóa đơn về trước: mỗi dòng nhập ghép với dòng hóa đơn (MH invoice_first) cùng hàng còn đủ số lượng chưa nhận; thành tiền theo hóa đơn (chia tỷ lệ số lượng,
// dòng nhận nốt phần còn lại lấy phần dư để tổng đúng bằng tiền hàng của hóa đơn). Số đã nhận tính từ các phiếu nhập khác (nháp hoặc đã ghi sổ) cùng liên kết.
async function invoiceLinks(trx: Trx, input: StockVoucherInput, selfId?: string): Promise<({ lineId: number; amount: string } | null)[] | null> {
  const ids = input.sourceInvoiceIds;
  if (!ids?.length) return null;
  if (input.voucherType !== 'PNK' || input.stockKind !== 'purchase') throw new AppError('VALIDATION', 'Hóa đơn nguồn (sourceInvoiceIds) chỉ dùng cho phiếu nhập kho mua hàng', 400);
  if (input.items.some((i) => i.creditAccountCode && i.creditAccountCode !== '151')) throw new AppError('VALIDATION', 'Phiếu nhập theo hóa đơn về trước luôn ghi Có 151, không đổi tài khoản Có', 400);
  const vs = await trx.selectFrom('voucher').select(['id', 'voucher_type', 'state', 'receipt_state', 'party_id']).where('id', 'in', ids).execute();
  const pid = input.partyCode ? (await trx.selectFrom('party').select('id').where('code', '=', input.partyCode).executeTakeFirst())?.id : undefined;
  for (const id of ids) {
    const v = vs.find((x) => x.id === id);
    if (!v || v.voucher_type !== 'MH' || v.receipt_state !== 'invoice_first') throw new AppError('INVOICE_NOT_FOUND', 'Không tìm thấy hóa đơn mua hàng hóa về trước đã chọn', 404);
    if (v.party_id !== (pid ?? null)) throw new AppError('RECEIPT_PARTY_MISMATCH', 'Hóa đơn mua hàng hóa của nhà cung cấp khác với phiếu nhập kho', 409);
    if (v.state !== 'posted') throw new AppError('INVOICE_NOT_POSTED', 'Hóa đơn mua hàng hóa chưa ghi sổ, không lập phiếu nhập theo hóa đơn được', 409);
  }
  const mh = await trx.selectFrom('voucher_item_line as l').select(['l.id', 'l.item_id', 'l.base_quantity', 'l.amount', 'l.discount_amount', 'l.stock_value']).where('l.voucher_id', 'in', ids).where('l.item_id', 'is not', null).orderBy('l.voucher_id').orderBy('l.line_no').execute();
  const got = mh.length ? await trx.selectFrom('voucher_item_line as l').innerJoin('voucher as v', 'v.id', 'l.voucher_id').select(['l.link_line_id', 'l.base_quantity', 'l.amount'])
    .where('l.link_line_id', 'in', mh.map((m) => m.id)).where('v.voucher_type', '=', 'PNK').where('v.state', 'in', ['draft', 'posted']).$if(!!selfId, (q) => q.where('l.voucher_id', '<>', selfId!)).execute() : [];
  const left = new Map(mh.map((m) => [m.id, { qty: D(m.base_quantity ?? 0).minus(got.filter((g) => g.link_line_id === m.id).reduce((s, g) => s.plus(g.base_quantity ?? 0), D(0))),
    amt: (m.stock_value !== null ? D(m.stock_value) : D(m.amount).minus(m.discount_amount).toDecimalPlaces(0, Decimal.ROUND_HALF_UP)).minus(got.filter((g) => g.link_line_id === m.id).reduce((s, g) => s.plus(g.amount), D(0))) }]));
  const itemIds = new Map((await trx.selectFrom('item').select(['id', 'code']).where('code', 'in', [...new Set(input.items.map((i) => i.itemCode))]).execute()).map((r) => [r.code, r.id]));
  const uf = new Map((await trx.selectFrom('item_uom as iu').innerJoin('uom as u', 'u.id', 'iu.uom_id').select(['iu.item_id', 'u.code', 'iu.factor']).where('iu.item_id', 'in', [...itemIds.values()]).execute()).map((r) => [`${r.item_id}:${r.code}`, r.factor]));
  return input.items.map((it, i) => {
    const itemId = itemIds.get(it.itemCode); const factor = itemId === undefined ? undefined : uf.get(`${itemId}:${it.uomCode}`);
    if (itemId === undefined || factor === undefined) return null; // build báo lỗi hàng, đơn vị tính
    const base = D(toBaseQty(it.quantity, D(factor).toString()));
    const m = mh.find((x) => x.item_id === itemId && left.get(x.id)!.qty.gte(base));
    if (!m) throw new AppError('INVOICE_LINE_UNMATCHED', `Dòng ${i + 1}: không có dòng hóa đơn mua cùng hàng ${it.itemCode} còn đủ số lượng chưa nhập kho`, 409);
    const l = left.get(m.id)!;
    const amount = base.eq(l.qty) ? l.amt : l.amt.times(base).div(l.qty).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    left.set(m.id, { qty: l.qty.minus(base), amt: l.amt.minus(amount) });
    return { lineId: m.id, amount: amount.toFixed(0) };
  });
}

// Dựng dòng hàng và dòng sổ cái từ phiếu. Tài khoản tra theo mã trong chế độ của năm tài chính (không tin id lưu ở hàng/kho: có thể thuộc chế độ khác).
async function build(trx: Trx, input: StockVoucherInput, auth?: Auth, selfId?: string) {
  const kind = stockKindDef(input.voucherType, input.stockKind);
  if (!kind) throw new AppError('STOCK_KIND_INVALID', `Loại nghiệp vụ "${input.stockKind}" không dùng cho ${voucherTypeDef(input.voucherType)!.name}`, 400);
  const transfer = input.voucherType === 'CK'; const dir = input.voucherType === 'PNK' ? 'in' : 'out';
  if (dir === 'in' && input.items.some((i) => i.fixedUnitCost)) throw new AppError('VALIDATION', 'Cố định giá vốn chỉ dùng cho dòng xuất kho', 400);
  if (transfer && !input.destWarehouseCode) throw new AppError('VALIDATION', 'Phiếu chuyển kho phải có kho nhận', 400);
  if (!transfer && input.destWarehouseCode) throw new AppError('VALIDATION', 'Kho nhận chỉ dùng cho phiếu chuyển kho', 400);
  const { regime } = await S.periodOf(trx, input.postingDate, input.voucherType);
  const links = await invoiceLinks(trx, input, selfId);

  const itemCodes = [...new Set(input.items.map((i) => i.itemCode))];
  const items = new Map((await trx.selectFrom('item as i').leftJoin('account as ia', 'ia.id', 'i.inventory_account_id').select(['i.id', 'i.code', 'i.name', 'i.kind', 'i.tracking', 'i.is_active', 'ia.code as inv_code', 'i.base_uom_id'])
    .where('i.code', 'in', itemCodes).execute()).map((r) => [r.code, r]));
  for (const c of itemCodes) { const r = items.get(c); if (!r) throw new AppError('LOOKUP_NOT_FOUND', `Không có vật tư hàng hóa mã "${c}"`, 404); if (!r.is_active) throw new AppError('ITEM_INACTIVE', `Vật tư hàng hóa "${c}" đã ngừng sử dụng`, 409); }
  const uoms = await trx.selectFrom('item_uom as iu').innerJoin('uom as u', 'u.id', 'iu.uom_id').select(['iu.item_id', 'u.code', 'iu.factor', 'iu.uom_id']).where('iu.item_id', 'in', [...items.values()].map((r) => r.id)).execute();

  const whCodes = [...new Set([input.warehouseCode, ...(input.destWarehouseCode ? [input.destWarehouseCode] : []), ...input.items.flatMap((i) => (i.warehouseCode ? [i.warehouseCode] : []))])];
  const whs = new Map((await trx.selectFrom('warehouse as w').leftJoin('account as wa', 'wa.id', 'w.inventory_account_id').select(['w.id', 'w.code', 'w.is_active', 'wa.code as inv_code']).where('w.code', 'in', whCodes).execute()).map((r) => [r.code, r]));
  for (const c of whCodes) { const r = whs.get(c); if (!r) throw new AppError('LOOKUP_NOT_FOUND', `Không có kho mã "${c}"`, 404); if (!r.is_active) throw new AppError('WAREHOUSE_INACTIVE', `Kho "${c}" đã ngừng sử dụng`, 409); }

  const counterDefault = transfer ? '' : stockCounterAccount(kind, regime as never);
  const rows = input.items.map((it, i) => {
    const item = items.get(it.itemCode)!; const n = i + 1;
    const service = item.kind === 'service';
    const u = uoms.find((x) => x.item_id === item.id && x.code === it.uomCode);
    if (!u) throw new AppError('ITEM_UOM_INVALID', `Dòng ${n}: hàng ${it.itemCode} không có đơn vị tính "${it.uomCode}"`, 400);
    const srcCode = it.warehouseCode || input.warehouseCode;
    if (transfer && srcCode === input.destWarehouseCode) throw new AppError('STOCK_TRANSFER_SAME_WAREHOUSE', `Dòng ${n}: kho đi và kho nhận phải khác nhau`, 400);
    const tracked = !service && item.tracking !== 'none';
    if (tracked && !it.lotNo) throw new AppError('LOT_REQUIRED', `Dòng ${n}: hàng ${it.itemCode} theo dõi theo lô, phải nhập số lô`, 400);
    if (tracked && item.tracking === 'lot_expiry' && dir === 'in' && !it.expiryDate) throw new AppError('LOT_REQUIRED', `Dòng ${n}: hàng ${it.itemCode} theo dõi hạn dùng, phải nhập hạn dùng`, 400);
    if (it.mfgDate && it.expiryDate && it.expiryDate < it.mfgDate) throw new AppError('EXPIRY_BEFORE_MFG', `Dòng ${n}: hạn dùng trước ngày sản xuất`, 400);
    const factor = D(u.factor).toString(); const base = toBaseQty(it.quantity, factor);
    return { it, item, n, service, u, factor, base, src: whs.get(srcCode)!, dst: input.destWarehouseCode ? whs.get(input.destWarehouseCode)! : null };
  });

  // Giá tạm tính của dòng xuất, chuyển (tồn đến ngày phiếu).
  const est = new Map<string, string>(); const warnings: StockVoucherDto['warnings'] = [];
  const priced = await Promise.all(rows.map(async (r, i) => {
    let unitCost: string | null = null; let amount: string; const link = links?.[i] ?? null;
    if (link) {
      amount = link.amount; // giá theo hóa đơn mua hàng hóa
    } else if (r.service || dir === 'in' && !transfer) {
      amount = round0(D(r.it.quantity).times(r.it.unitPrice ?? '0'));
    } else {
      const key = `${r.item.id}:${r.src.id}`;
      if (!r.it.fixedUnitCost && !est.has(key)) est.set(key, (await sql<{ c: string }>`SELECT fn_stock_estimate_cost(${r.item.id}::bigint, ${r.src.id}::bigint, ${input.postingDate}::date)::text AS c`.execute(trx)).rows[0]!.c);
      unitCost = D(r.it.fixedUnitCost || est.get(key)!).toFixed(4); amount = round0(D(r.base).times(unitCost));
      if (!r.it.fixedUnitCost && D(unitCost).isZero()) warnings.push({ code: 'COST_UNKNOWN', message: `Dòng ${r.n}: hàng ${r.it.itemCode} chưa có giá vốn, ghi giá 0 cho đến khi tính giá vốn`, lineNo: r.n });
    }
    if (amount.length > 16) throw new AppError('AMOUNT_TOO_LARGE', `Dòng ${r.n}: thành tiền vượt quá 16 chữ số`, 400);
    return { ...r, unitCost, amount, link };
  }));

  // Tài khoản kho: kho, rồi hàng, rồi 156. Tài khoản đối ứng: dòng ghi đè, rồi mặc định của loại nghiệp vụ.
  const lines = priced.map((r) => {
    const inv = (w: typeof r.src) => w.inv_code ?? r.item.inv_code ?? '156';
    const invCode = inv(r.src);
    let debit: string; let credit: string;
    if (transfer) { debit = r.it.debitAccountCode || inv(r.dst!); credit = r.it.creditAccountCode || invCode; }
    else if (dir === 'in') { debit = r.it.debitAccountCode || invCode; credit = r.it.creditAccountCode || (r.link ? '151' : counterDefault); }
    else { debit = r.it.debitAccountCode || counterDefault; credit = r.it.creditAccountCode || invCode; }
    return { ...r, debit, credit };
  });
  const codes = [...new Set(lines.flatMap((l) => [l.debit, l.credit]))];
  const accs = new Map((await trx.selectFrom('account').select(['id', 'code', 'name', 'subledger_kind']).where('regime', '=', regime).where('code', 'in', codes).execute()).map((a) => [a.code, a]));
  for (const c of codes) if (!accs.has(c)) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản "${c}" trong hệ thống tài khoản`, 404);
  if (auth) for (const c of codes) assertSensitive(auth, accs.get(c)!); // phiếu kho ghi giá trị tồn kho (cần view_cost)

  // Nhóm dòng sổ cái theo (bên, tài khoản, hàng, kho); bỏ dòng 0 đồng (dòng sổ cái không được rỗng).
  const groups = new Map<string, S.LineInput>(); const sums = new Map<string, Decimal>();
  const add = (side: 'debit' | 'credit', code: string, itemCode: string, wh: string, amount: string, assetCode?: string | null) => {
    if (D(amount).isZero()) return;
    const key = `${side}|${code}|${itemCode}|${wh}|${assetCode ?? ''}`;
    const kindOf = accs.get(code)!.subledger_kind;
    if (!groups.has(key)) groups.set(key, { accountCode: code, debit: '0', credit: '0', itemCode, warehouseCode: wh, description: input.description ?? null, ...(assetCode && { assetCode }),
      ...(input.partyCode && (kindOf === 'receivable' || kindOf === 'payable') && { partyCode: input.partyCode }) });
    sums.set(key, (sums.get(key) ?? D(0)).plus(amount));
  };
  for (const l of lines) {
    add('debit', l.debit, l.it.itemCode, transfer ? l.dst!.code : l.src.code, l.amount, l.it.assetCode);
    add('credit', l.credit, l.it.itemCode, l.src.code, l.amount);
  }
  const ledger: S.LineInput[] = [...groups].map(([k, g]) => ({ ...g, [k.startsWith('debit') ? 'debit' : 'credit']: sums.get(k)!.toFixed(0) }));
  if (!ledger.length) throw new AppError('STOCK_VALUE_ZERO', 'Phiếu chưa có giá trị để ghi sổ cái: nhập đơn giá hoặc kiểm tra giá vốn tạm tính', 409);
  return { regime, lines, ledger, accs, warnings, transfer, dir };
}

async function insertItems(trx: Trx, tenantId: string, voucherId: string, b: Awaited<ReturnType<typeof build>>) {
  const codes = [...new Set(b.lines.flatMap((l) => (l.it.assetCode ? [l.it.assetCode] : [])))];
  const assetIds = new Map((codes.length ? await trx.selectFrom('asset').select(['id', 'code']).where('code', 'in', codes).execute() : []).map((r) => [r.code, r.id]));
  for (const c of codes) if (!assetIds.has(c)) throw new AppError('ASSET_NOT_FOUND', `Không có thẻ tài sản mã "${c}"`, 404);
  const rows = b.lines.map((l) => ({
    asset_id: l.it.assetCode ? assetIds.get(l.it.assetCode)! : null,
    tenant_id: tenantId, voucher_id: voucherId, line_no: l.n, item_id: l.item.id, uom_id: l.u.uom_id, quantity: l.it.quantity, unit_price: l.link ? D(l.amount).div(l.it.quantity).toFixed(4) : b.dir === 'in' && !b.transfer || l.service ? (l.it.unitPrice ?? '0') : null,
    amount_currency: l.amount, amount: l.amount, account_id: b.accs.get(b.dir === 'in' && !b.transfer ? l.debit : l.credit)!.id, warehouse_id: l.src.id, dest_warehouse_id: l.dst?.id ?? null,
    uom_factor: l.factor, base_quantity: l.base, lot_no: l.it.lotNo || null, mfg_date: l.it.mfgDate || null, expiry_date: l.it.expiryDate || null,
    direction: b.transfer ? null : b.dir, debit_account_id: b.accs.get(l.debit)!.id, credit_account_id: b.accs.get(l.credit)!.id, unit_cost: l.unitCost, fixed_cost: !!l.it.fixedUnitCost, link_line_id: l.link?.lineId ?? null,
  }));
  await trx.insertInto('voucher_item_line').values(rows).execute();
}

type Ctx = { tenantId: string; userId: string; auth?: Auth };
const header = (input: StockVoucherInput, ledger: S.LineInput[]): S.SystemVoucherInput => ({
  voucherType: input.voucherType, postingDate: input.postingDate, documentDate: input.documentDate ?? input.postingDate, description: input.description ?? null, partyCode: input.partyCode ?? null,
  currencyCode: 'VND', personName: input.personName ?? null, attachmentsCount: input.attachmentsCount ?? null, stockKind: input.stockKind, lines: ledger });

export async function createStockVoucher(trx: Trx, ctx: Ctx, input: StockVoucherInput): Promise<StockVoucherDto> {
  const b = await build(trx, input, ctx.auth);
  const v = await S.createStockVoucherHeader(trx, ctx, header(input, b.ledger));
  await insertItems(trx, ctx.tenantId, v.id, b);
  return getStockVoucher(trx, v.id);
}
export async function updateStockVoucher(trx: Trx, ctx: Ctx, id: string, version: number, input: StockVoucherInput): Promise<StockVoucherDto> {
  const cur = await trx.selectFrom('voucher').select('voucher_type').where('id', '=', id).executeTakeFirst();
  if (!cur || voucherTypeDef(cur.voucher_type)?.module !== 'inventory') throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy phiếu kho', 404);
  const b = await build(trx, input, ctx.auth, id);
  const h = header(input, b.ledger);
  await S.updateStockDraftHeader(trx, id, version, { ...h, currencyCode: 'VND', lines: h.lines } as S.VoucherInput & { stockKind: string });
  await trx.deleteFrom('voucher_item_line').where('voucher_id', '=', id).execute();
  await insertItems(trx, ctx.tenantId, id, b);
  return getStockVoucher(trx, id);
}

export async function getStockVoucher(trx: Trx, id: string, auth?: Auth): Promise<StockVoucherDto> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { lines: _lines, ...v } = await S.getVoucher(trx, id);
  if (voucherTypeDef(v.voucherType)?.module !== 'inventory') throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy phiếu kho', 404);
  const kind = (await trx.selectFrom('voucher').select('stock_kind').where('id', '=', id).executeTakeFirstOrThrow()).stock_kind;
  const items = (await trx.selectFrom('voucher_item_line as l').innerJoin('item as i', 'i.id', 'l.item_id').innerJoin('uom as u', 'u.id', 'l.uom_id')
    .leftJoin('warehouse as w', 'w.id', 'l.warehouse_id').leftJoin('warehouse as dw', 'dw.id', 'l.dest_warehouse_id')
    .leftJoin('account as da', 'da.id', 'l.debit_account_id').leftJoin('account as ca', 'ca.id', 'l.credit_account_id').leftJoin('asset as ast', 'ast.id', 'l.asset_id')
    .select(['l.line_no', 'i.code as item_code', 'i.name as item_name', 'u.code as uom_code', 'l.quantity', 'l.base_quantity', 'l.uom_factor', 'l.unit_price', 'l.unit_cost', 'l.amount', 'l.lot_no', 'l.mfg_date', 'l.expiry_date',
      'w.code as wh', 'dw.code as dwh', 'l.direction', 'da.code as dcode', 'ca.code as ccode', 'l.link_line_id', 'l.cost_ratio', 'ast.code as asset_code']).where('l.voucher_id', '=', id).orderBy('l.line_no').execute());
  const ledger = await trx.selectFrom('voucher_line as l').innerJoin('account as a', 'a.id', 'l.account_id').leftJoin('item as i', 'i.id', 'l.item_id').leftJoin('warehouse as w', 'w.id', 'l.warehouse_id').leftJoin('party as p', 'p.id', 'l.party_id')
    .select(['l.line_no', 'a.code', 'a.name', 'a.subledger_kind', 'l.debit', 'l.credit', 'i.code as item_code', 'w.code as wh', 'p.code as party_code'])
    .where('l.voucher_id', '=', id).where('l.posting_date', '=', v.postingDate).orderBy('l.line_no').execute();
  if (auth) for (const l of ledger) assertSensitive(auth, { subledger_kind: l.subledger_kind, code: l.code }); // giá trị tồn kho và giá vốn: cần view_cost
  const fresh = items.length ? items[0]! : null;
  return {
    ...v, stockKind: kind, warehouseCode: fresh?.wh ?? null, destWarehouseCode: fresh?.dwh ?? null,
    items: items.map((r) => ({ lineNo: r.line_no, itemCode: r.item_code, itemName: r.item_name, uomCode: r.uom_code, quantity: r.quantity ?? '0', baseQuantity: r.base_quantity ?? r.quantity ?? '0', uomFactor: r.uom_factor, unitPrice: r.unit_price, unitCost: r.unit_cost,
      amount: r.amount, lotNo: r.lot_no, mfgDate: r.mfg_date, expiryDate: r.expiry_date, warehouseCode: r.wh, destWarehouseCode: r.dwh, direction: r.direction, debitAccountCode: r.dcode, creditAccountCode: r.ccode, assetCode: r.asset_code, costRatio: r.cost_ratio, linkLineId: r.link_line_id })),
    assembly: v.voucherType !== 'LR' ? null : (() => { // chi phí nhập tay = giá trị nhập − giá trị xuất; tài khoản ghi có lấy ở dòng nhập
      const sum = (dir: string) => items.filter((r) => r.direction === dir).reduce((t, r) => t.plus(r.amount), D(0)); const extra = sum('in').minus(sum('out'));
      return { mode: kind ?? 'assembly', extraCost: extra.toFixed(0), extraCostAccountCode: extra.isZero() ? null : items.find((r) => r.direction === 'in')?.ccode ?? null };
    })(),
    ledgerLines: ledger.map((l) => ({ lineNo: l.line_no, accountCode: l.code, accountName: l.name, debit: l.debit, credit: l.credit, itemCode: l.item_code, warehouseCode: l.wh, partyCode: l.party_code })),
    warnings: items.filter((r) => r.direction !== null || r.dwh !== null).filter((r) => r.unit_cost !== null && D(r.unit_cost).isZero())
      .map((r) => ({ code: 'COST_UNKNOWN', message: `Dòng ${r.line_no}: hàng ${r.item_code} chưa có giá vốn, ghi giá 0 cho đến khi tính giá vốn`, lineNo: r.line_no })),
  };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const ctx = (req: { auth: { tenantId: string | null; userId: string; sensitive: Set<string> } | null }) => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId, auth: req.auth! });
  const idParam = z.object({ id: z.string().uuid() });
  app.post('/api/stock-vouchers', { preHandler: app.requirePermission('stock_voucher.create'), schema: { body: stockVoucherInput } }, async (req, reply) =>
    reply.status(201).send(await app.withOverride(req, (trx) => createStockVoucher(trx, ctx(req), req.body))));
  app.put('/api/stock-vouchers/:id', { preHandler: app.requirePermission('stock_voucher.update'), schema: { params: idParam, body: stockVoucherInput.extend({ version: z.number().int() }) } }, async (req) => {
    const { version, ...input } = req.body;
    return app.withOverride(req, (trx) => updateStockVoucher(trx, ctx(req), req.params.id, version, input));
  });
  app.get('/api/stock-vouchers/:id', { preHandler: app.requirePermission('stock_voucher.view'), schema: { params: idParam } }, async (req) => app.withTenant(req, (trx) => getStockVoucher(trx, req.params.id, req.auth!)));
};
export default routes;
