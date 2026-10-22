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
});
export const stockVoucherInput = z.object({
  voucherType: z.enum(['PNK', 'PXK', 'CK']), stockKind: z.string().min(1), postingDate: S.dateIso, documentDate: S.dateIso.optional(),
  partyCode: z.string().nullable().optional(), personName: optText(200), attachmentsCount: z.number().int().min(0).max(999).nullable().optional(),
  warehouseCode: z.string().min(1), destWarehouseCode: z.string().nullable().optional(), description: z.string().nullable().optional(),
  items: z.array(stockItemInput).min(1, 'Phiếu phải có ít nhất một dòng hàng').max(500, 'Tối đa 500 dòng hàng mỗi phiếu'),
});
export type StockVoucherInput = z.infer<typeof stockVoucherInput>;
export interface StockItemDto {
  lineNo: number; itemCode: string; itemName: string; uomCode: string; quantity: string; baseQuantity: string; uomFactor: string; unitPrice: string | null; unitCost: string | null; amount: string;
  lotNo: string | null; mfgDate: string | null; expiryDate: string | null; warehouseCode: string | null; destWarehouseCode: string | null; direction: string | null; debitAccountCode: string | null; creditAccountCode: string | null;
}
export interface StockLedgerLineDto { lineNo: number; accountCode: string; accountName: string; debit: string; credit: string; itemCode: string | null; warehouseCode: string | null; partyCode: string | null }
export interface StockVoucherDto extends Omit<S.VoucherDto, 'lines'> { stockKind: string | null; warehouseCode: string | null; destWarehouseCode: string | null; items: StockItemDto[]; ledgerLines: StockLedgerLineDto[]; warnings: { code: string; message: string; lineNo?: number }[] }

const round0 = (d: Decimal) => d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);

// Dựng dòng hàng và dòng sổ cái từ phiếu. Tài khoản tra theo mã trong chế độ của năm tài chính (không tin id lưu ở hàng/kho: có thể thuộc chế độ khác).
async function build(trx: Trx, input: StockVoucherInput, auth?: Auth) {
  const kind = stockKindDef(input.voucherType, input.stockKind);
  if (!kind) throw new AppError('STOCK_KIND_INVALID', `Loại nghiệp vụ "${input.stockKind}" không dùng cho ${voucherTypeDef(input.voucherType)!.name}`, 400);
  const transfer = input.voucherType === 'CK'; const dir = input.voucherType === 'PNK' ? 'in' : 'out';
  if (transfer && !input.destWarehouseCode) throw new AppError('VALIDATION', 'Phiếu chuyển kho phải có kho nhận', 400);
  if (!transfer && input.destWarehouseCode) throw new AppError('VALIDATION', 'Kho nhận chỉ dùng cho phiếu chuyển kho', 400);
  const { regime } = await S.periodOf(trx, input.postingDate, input.voucherType);

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
  const priced = await Promise.all(rows.map(async (r) => {
    let unitCost: string | null = null; let amount: string;
    if (r.service || dir === 'in' && !transfer) {
      amount = round0(D(r.it.quantity).times(r.it.unitPrice ?? '0'));
    } else {
      const key = `${r.item.id}:${r.src.id}`;
      if (!est.has(key)) est.set(key, (await sql<{ c: string }>`SELECT fn_stock_estimate_cost(${r.item.id}::bigint, ${r.src.id}::bigint, ${input.postingDate}::date)::text AS c`.execute(trx)).rows[0]!.c);
      unitCost = D(est.get(key)!).toFixed(4); amount = round0(D(r.base).times(unitCost));
      if (D(unitCost).isZero()) warnings.push({ code: 'COST_UNKNOWN', message: `Dòng ${r.n}: hàng ${r.it.itemCode} chưa có giá vốn, ghi giá 0 cho đến khi tính giá vốn`, lineNo: r.n });
    }
    return { ...r, unitCost, amount };
  }));

  // Tài khoản kho: kho, rồi hàng, rồi 156. Tài khoản đối ứng: dòng ghi đè, rồi mặc định của loại nghiệp vụ.
  const lines = priced.map((r) => {
    const inv = (w: typeof r.src) => w.inv_code ?? r.item.inv_code ?? '156';
    const invCode = inv(r.src);
    let debit: string; let credit: string;
    if (transfer) { debit = r.it.debitAccountCode || inv(r.dst!); credit = r.it.creditAccountCode || invCode; }
    else if (dir === 'in') { debit = r.it.debitAccountCode || invCode; credit = r.it.creditAccountCode || counterDefault; }
    else { debit = r.it.debitAccountCode || counterDefault; credit = r.it.creditAccountCode || invCode; }
    return { ...r, debit, credit };
  });
  const codes = [...new Set(lines.flatMap((l) => [l.debit, l.credit]))];
  const accs = new Map((await trx.selectFrom('account').select(['id', 'code', 'name', 'subledger_kind']).where('regime', '=', regime).where('code', 'in', codes).execute()).map((a) => [a.code, a]));
  for (const c of codes) if (!accs.has(c)) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản "${c}" trong hệ thống tài khoản`, 404);
  if (auth) for (const c of codes) assertSensitive(auth, accs.get(c)!); // phiếu kho ghi giá trị tồn kho (cần view_cost)

  // Nhóm dòng sổ cái theo (bên, tài khoản, hàng, kho); bỏ dòng 0 đồng (dòng sổ cái không được rỗng).
  const groups = new Map<string, S.LineInput>(); const sums = new Map<string, Decimal>();
  const add = (side: 'debit' | 'credit', code: string, itemCode: string, wh: string, amount: string) => {
    if (D(amount).isZero()) return;
    const key = `${side}|${code}|${itemCode}|${wh}`;
    const kindOf = accs.get(code)!.subledger_kind;
    if (!groups.has(key)) groups.set(key, { accountCode: code, debit: '0', credit: '0', itemCode, warehouseCode: wh, description: input.description ?? null,
      ...(input.partyCode && (kindOf === 'receivable' || kindOf === 'payable') && { partyCode: input.partyCode }) });
    sums.set(key, (sums.get(key) ?? D(0)).plus(amount));
  };
  for (const l of lines) {
    add('debit', l.debit, l.it.itemCode, transfer ? l.dst!.code : l.src.code, l.amount);
    add('credit', l.credit, l.it.itemCode, l.src.code, l.amount);
  }
  const ledger: S.LineInput[] = [...groups].map(([k, g]) => ({ ...g, [k.startsWith('debit') ? 'debit' : 'credit']: sums.get(k)!.toFixed(0) }));
  return { regime, lines, ledger, accs, warnings, transfer, dir };
}

async function insertItems(trx: Trx, tenantId: string, voucherId: string, b: Awaited<ReturnType<typeof build>>) {
  const rows = b.lines.map((l) => ({
    tenant_id: tenantId, voucher_id: voucherId, line_no: l.n, item_id: l.item.id, uom_id: l.u.uom_id, quantity: l.it.quantity, unit_price: b.dir === 'in' && !b.transfer || l.service ? (l.it.unitPrice ?? '0') : null,
    amount_currency: l.amount, amount: l.amount, account_id: b.accs.get(b.dir === 'in' && !b.transfer ? l.debit : l.credit)!.id, warehouse_id: l.src.id, dest_warehouse_id: l.dst?.id ?? null,
    uom_factor: l.factor, base_quantity: l.base, lot_no: l.it.lotNo || null, mfg_date: l.it.mfgDate || null, expiry_date: l.it.expiryDate || null,
    direction: b.transfer ? null : b.dir, debit_account_id: b.accs.get(l.debit)!.id, credit_account_id: b.accs.get(l.credit)!.id, unit_cost: l.unitCost,
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
  const b = await build(trx, input, ctx.auth);
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
    .leftJoin('account as da', 'da.id', 'l.debit_account_id').leftJoin('account as ca', 'ca.id', 'l.credit_account_id')
    .select(['l.line_no', 'i.code as item_code', 'i.name as item_name', 'u.code as uom_code', 'l.quantity', 'l.base_quantity', 'l.uom_factor', 'l.unit_price', 'l.unit_cost', 'l.amount', 'l.lot_no', 'l.mfg_date', 'l.expiry_date',
      'w.code as wh', 'dw.code as dwh', 'l.direction', 'da.code as dcode', 'ca.code as ccode']).where('l.voucher_id', '=', id).orderBy('l.line_no').execute());
  const ledger = await trx.selectFrom('voucher_line as l').innerJoin('account as a', 'a.id', 'l.account_id').leftJoin('item as i', 'i.id', 'l.item_id').leftJoin('warehouse as w', 'w.id', 'l.warehouse_id').leftJoin('party as p', 'p.id', 'l.party_id')
    .select(['l.line_no', 'a.code', 'a.name', 'a.subledger_kind', 'l.debit', 'l.credit', 'i.code as item_code', 'w.code as wh', 'p.code as party_code'])
    .where('l.voucher_id', '=', id).where('l.posting_date', '=', v.postingDate).orderBy('l.line_no').execute();
  if (auth) for (const l of ledger) assertSensitive(auth, { subledger_kind: l.subledger_kind, code: l.code }); // giá trị tồn kho và giá vốn: cần view_cost
  const fresh = items.length ? items[0]! : null;
  return {
    ...v, stockKind: kind, warehouseCode: fresh?.wh ?? null, destWarehouseCode: fresh?.dwh ?? null,
    items: items.map((r) => ({ lineNo: r.line_no, itemCode: r.item_code, itemName: r.item_name, uomCode: r.uom_code, quantity: r.quantity ?? '0', baseQuantity: r.base_quantity ?? r.quantity ?? '0', uomFactor: r.uom_factor, unitPrice: r.unit_price, unitCost: r.unit_cost,
      amount: r.amount, lotNo: r.lot_no, mfgDate: r.mfg_date, expiryDate: r.expiry_date, warehouseCode: r.wh, destWarehouseCode: r.dwh, direction: r.direction, debitAccountCode: r.dcode, creditAccountCode: r.ccode })),
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
