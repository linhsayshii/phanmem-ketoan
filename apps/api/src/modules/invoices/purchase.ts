import { sql, type Insertable, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, Decimal, toBaseQty } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { resolvePrice } from '../inventory/priceLists.js';
import { assertSensitive } from '../reporting/ledgers.js';
import type { InvoiceInput } from './service.js';

type Trx = Transaction<Database>;
type Row = Partial<Insertable<Database['voucher_item_line']>>;
type Auth = { sensitive: Set<string>; permissions: Set<string> };

// Dòng hàng của hóa đơn mua hàng hóa (MH) và trả lại, giảm giá hàng mua (TLM) sau khi đối chiếu kho: tài khoản của dòng cơ sở, hàng, kho, giá tạm tính đã ghi ở phiếu nhập
// (offsetVnd, chỉ MH hàng về trước) và các cột kho/liên kết của dòng hàng (voucher_item_line). Tài khoản định danh bằng mã, postItems tra id theo chế độ của năm.
export interface PurchaseLine { accountCode: string; itemCode: string; warehouseCode: string | null; offsetVnd?: string; debitCode?: string; creditCode?: string; row: Row }
export interface PurchaseResult { lines: (PurchaseLine | null)[]; receiptState: string | null; warnings: { code: string; message: string; lineNo?: number }[] }

const round0 = (d: Decimal) => d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
const bad = (code: string, msg: string, status = 400) => new AppError(code, msg, status);

export async function resolvePurchase(trx: Trx, a: { input: InvoiceInput; regime: string; counterAccountCode: string; partyId: string; selfId?: string; auth?: Auth; perm: string }): Promise<PurchaseResult> {
  const { input } = a; const isMH = input.voucherType === 'MH'; const mode = input.stockMode ?? 'through_stock';
  const out: (PurchaseLine | null)[] = input.items.map(() => null);
  for (const [k, it] of input.items.entries()) if (!it.itemCode && !it.accountCode) throw bad('VALIDATION', `Dòng ${k + 1}: phải chọn hàng hóa hoặc tài khoản`);
  const idx = input.items.flatMap((it, k) => (it.itemCode ? [k] : []));
  if (!idx.length) return { lines: out, receiptState: isMH ? 'with_invoice' : null, warnings: [] };
  const isVnd = input.currencyCode === 'VND';
  if (!isVnd && (mode === 'goods_first' || !isMH)) throw bad('INVOICE_FX_UNSUPPORTED', 'Hóa đơn hàng về trước và trả lại, giảm giá hàng mua chỉ lập bằng VND');
  if (isMH && mode !== 'goods_first' && input.receiptVoucherIds?.length) throw bad('VALIDATION', 'Phiếu nhập liên kết (receiptVoucherIds) chỉ dùng cho hóa đơn hàng về trước');
  if (!isMH && input.receiptVoucherIds?.length) throw bad('VALIDATION', 'Phiếu nhập liên kết chỉ dùng cho hóa đơn mua hàng hóa');

  const itemRows = await trx.selectFrom('item as i').leftJoin('account as ia', 'ia.id', 'i.inventory_account_id').select(['i.id', 'i.code', 'i.kind', 'i.tracking', 'i.is_active', 'ia.code as inv_code'])
    .where('i.code', 'in', [...new Set(idx.map((k) => input.items[k]!.itemCode!))]).execute();
  const items = new Map(itemRows.map((r) => [r.code, r]));
  const uoms = itemRows.length ? await trx.selectFrom('item_uom as iu').innerJoin('uom as u', 'u.id', 'iu.uom_id').select(['iu.item_id', 'u.code', 'iu.factor', 'iu.uom_id']).where('iu.item_id', 'in', itemRows.map((r) => r.id)).execute() : [];
  const whCodes = [...new Set(idx.flatMap((k) => (input.items[k]!.warehouseCode ? [input.items[k]!.warehouseCode!] : [])))];
  const whs = new Map((whCodes.length ? await trx.selectFrom('warehouse as w').leftJoin('account as wa', 'wa.id', 'w.inventory_account_id').select(['w.id', 'w.code', 'w.is_active', 'wa.code as inv_code']).where('w.code', 'in', whCodes).execute() : []).map((r) => [r.code, r]));
  const whById = async (id: number | string) => (await trx.selectFrom('warehouse as w').leftJoin('account as wa', 'wa.id', 'w.inventory_account_id').select(['w.id', 'w.code', 'wa.code as inv_code']).where('w.id', '=', Number(id)).executeTakeFirstOrThrow());

  // Phiếu nhập liên kết (hàng về trước): dòng nhập của chúng, trừ dòng đã gắn với hóa đơn mua khác còn hiệu lực.
  let pnkLines: { id: number; voucher_id: string; item_id: number | null; wh: string; base_quantity: string | null; amount: string; discount_amount: string; acct: string | null }[] = [];
  const used = new Set<number>();
  if (isMH && mode === 'goods_first') {
    const ids = a.input.receiptVoucherIds ?? [];
    if (!ids.length) throw bad('VALIDATION', 'Hóa đơn hàng về trước phải chọn phiếu nhập kho (receiptVoucherIds)');
    const vs = await trx.selectFrom('voucher').select(['id', 'voucher_type', 'state', 'stock_kind', 'party_id']).where('id', 'in', ids).execute();
    for (const id of ids) {
      const v = vs.find((x) => x.id === id);
      if (!v) throw bad('RECEIPT_NOT_FOUND', 'Không tìm thấy phiếu nhập kho đã chọn', 404);
      if (v.voucher_type !== 'PNK' || v.stock_kind !== 'purchase') throw bad('RECEIPT_INVALID', 'Chỉ liên kết phiếu nhập kho loại mua hàng', 409);
      if (v.state !== 'posted') throw bad('RECEIPT_NOT_POSTED', 'Phiếu nhập kho phải ghi sổ trước khi liên kết với hóa đơn mua hàng về trước', 409);
      if (v.party_id !== a.partyId) throw bad('RECEIPT_PARTY_MISMATCH', 'Phiếu nhập kho của nhà cung cấp khác với hóa đơn', 409);
    }
    pnkLines = await trx.selectFrom('voucher_item_line as l').innerJoin('warehouse as w', 'w.id', 'l.warehouse_id').leftJoin('account as da', 'da.id', 'l.debit_account_id')
      .select(['l.id', 'l.voucher_id', 'l.item_id', 'w.code as wh', 'l.base_quantity', 'l.amount', 'l.discount_amount', 'da.code as acct']).where('l.voucher_id', 'in', ids).where('l.direction', '=', 'in').orderBy('l.line_no').execute();
    if (pnkLines.length) {
      let q = trx.selectFrom('voucher_item_line as l').innerJoin('voucher as v', 'v.id', 'l.voucher_id').select('l.link_line_id')
        .where('l.link_line_id', 'in', pnkLines.map((l) => l.id)).where('v.voucher_type', '=', 'MH').where('v.state', 'in', ['draft', 'posted']);
      if (a.selfId) q = q.where('l.voucher_id', '<>', a.selfId);
      for (const r of await q.execute()) used.add(r.link_line_id!);
    }
  }
  // Phiếu nhập kho theo hóa đơn: dòng MH hàng về sau được phiếu khác tham chiếu; kiểm ở sourceInvoiceIds của phiếu kho, không ở đây.

  const returning = new Map<number, Decimal>(); // số lượng trả cộng dồn theo dòng nhập trong cùng hóa đơn
  const lineNo = (k: number) => k + 1;
  for (const k of idx) {
    const it = input.items[k]!; const n = lineNo(k);
    const item = items.get(it.itemCode!);
    if (!item) throw bad('LOOKUP_NOT_FOUND', `Không có vật tư hàng hóa mã "${it.itemCode}"`, 404);
    if (!item.is_active) throw bad('ITEM_INACTIVE', `Vật tư hàng hóa "${it.itemCode}" đã ngừng sử dụng`, 409);
    if (item.kind === 'service') { if (!it.accountCode) throw bad('VALIDATION', `Dòng ${n}: dịch vụ ${it.itemCode} phải chọn tài khoản`); continue; } // dịch vụ: dòng thường
    const u = it.uomCode ? uoms.find((x) => x.item_id === item.id && x.code === it.uomCode) : undefined;
    if (it.uomCode && !u) throw bad('ITEM_UOM_INVALID', `Dòng ${n}: hàng ${it.itemCode} không có đơn vị tính "${it.uomCode}"`);
    const base = it.quantity && u ? toBaseQty(it.quantity, D(u.factor).toString()) : null;
    const unit = u ? { uom_id: u.uom_id, uom_factor: D(u.factor).toString(), base_quantity: base } : {};
    const needQty = () => { if (!it.quantity || !u || !D(it.quantity).gt(0)) throw bad('VALIDATION', `Dòng ${n}: phải nhập số lượng và đơn vị tính`); };

    if (!isMH) { // TLM: trả lại hàng (có số lượng) hoặc chỉ giảm giá (không số lượng, không kho)
      if (!it.sourceLineId) throw bad('PURCHASE_RETURN_SOURCE_INVALID', `Dòng ${n}: phải chỉ rõ dòng hóa đơn mua hoặc phiếu nhập gốc (sourceLineId)`);
      const src = await trx.selectFrom('voucher_item_line as s').innerJoin('voucher as sv', 'sv.id', 's.voucher_id')
        .select(['s.id', 's.link_line_id', 's.item_id', 'sv.state', 'sv.voucher_type', 'sv.receipt_state', 'sv.party_id']).where('s.id', '=', it.sourceLineId).executeTakeFirst();
      if (!src || src.state !== 'posted' || (src.voucher_type !== 'MH' && src.voucher_type !== 'PNK') || src.item_id !== item.id)
        throw bad('PURCHASE_RETURN_SOURCE_INVALID', `Dòng ${n}: dòng gốc phải là dòng hàng ${it.itemCode} đã ghi sổ của hóa đơn mua hàng hóa hoặc phiếu nhập kho`, 409);
      if (src.party_id !== a.partyId) throw bad('PURCHASE_RETURN_PARTY_MISMATCH', `Dòng ${n}: chứng từ gốc của nhà cung cấp khác với hóa đơn trả lại, giảm giá`, 409);
      const lineId = src.voucher_type === 'MH' && src.receipt_state === 'goods_first' ? src.link_line_id : src.id; // hàng về trước: lô nhập nằm ở dòng phiếu nhập
      const mv = lineId === null ? undefined : (await sql<{ wh_id: string; qty: string; lot: string | null; value: string }>`
        SELECT m.warehouse_id::text AS wh_id, m.quantity::text AS qty, m.lot_no AS lot,
          (SELECT coalesce(sum(c.value), 0)::text FROM stock_cost_layer c WHERE c.tenant_id = m.tenant_id AND c.move_id = m.id AND c.kind IN ('receipt', 'adjustment')) AS value
        FROM stock_move m WHERE m.item_line_id = ${lineId} AND m.direction = 'in' AND m.reversal_of IS NULL AND m.transfer_id IS NULL`.execute(trx)).rows[0];
      if (!mv || lineId === null) throw bad('PURCHASE_RETURN_SOURCE_INVALID', `Dòng ${n}: dòng gốc chưa nhập kho (hóa đơn về trước hàng); hãy lập phiếu nhập kho theo hóa đơn trước`, 409);
      const wh = await whById(mv.wh_id); const invCode = wh.inv_code ?? item.inv_code ?? '156';
      if (it.warehouseCode && it.warehouseCode !== wh.code) throw bad('PURCHASE_RETURN_SOURCE_INVALID', `Dòng ${n}: hàng đã nhập vào kho ${wh.code}, không trả từ kho ${it.warehouseCode}`);
      if (D(it.discountCurrency).gt(0)) throw bad('VALIDATION', `Dòng ${n}: dòng trả lại, giảm giá hàng mua không có chiết khấu thương mại`);
      const net = D(it.amountCurrency);
      if (!it.quantity) { // chỉ giảm giá: giảm giá vốn của lô đã nhập, lớp điều chỉnh âm được tạo khi ghi sổ
        if (it.warehouseCode) throw bad('VALIDATION', `Dòng ${n}: giảm giá không trả hàng thì không chọn kho`);
        if (net.gt(mv.value)) throw bad('PURCHASE_DISCOUNT_EXCEEDS', `Dòng ${n}: giảm giá ${net.toFixed(0)} lớn hơn giá trị nhập còn lại ${D(mv.value).toFixed(0)}`);
        out[k] = { accountCode: invCode, itemCode: item.code, warehouseCode: wh.code, row: { item_id: item.id, link_line_id: lineId } };
        continue;
      }
      needQty();
      // Tổng số lượng trả (nháp và đã ghi sổ, gồm các dòng khác của chính hóa đơn này) không vượt số lượng nhập của lô.
      const prior = await trx.selectFrom('voucher_item_line as l').innerJoin('voucher as v', 'v.id', 'l.voucher_id').select('l.base_quantity').where('l.link_line_id', '=', lineId).where('l.direction', '=', 'out')
        .where('v.voucher_type', '=', 'TLM').where('v.state', 'in', ['draft', 'posted']).$if(!!a.selfId, (q) => q.where('l.voucher_id', '<>', a.selfId!)).execute();
      const returned = prior.reduce((s, r) => s.plus(r.base_quantity ?? 0), D(0)).plus(returning.get(lineId) ?? 0).plus(base!);
      if (returned.gt(mv.qty)) throw bad('RETURN_EXCEEDS_RECEIPT', `Dòng ${n}: tổng số lượng trả ${returned.toString()} vượt số lượng đã nhập ${D(mv.qty).toString()}`, 409);
      returning.set(lineId, D(returning.get(lineId) ?? 0).plus(base!));
      const unitCost = D(mv.value).div(mv.qty).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      const expected = round0(D(base!).times(unitCost));
      if (!net.eq(expected)) throw bad('PURCHASE_RETURN_AMOUNT_MISMATCH', `Dòng ${n}: tiền trả lại hàng phải bằng giá nhập gốc ${unitCost.toFixed(4)} × ${base} = ${expected.toFixed(0)} đồng (đang nhập ${net.toFixed(0)}); chênh lệch giá ghi giảm giá riêng`);
      out[k] = { accountCode: invCode, itemCode: item.code, warehouseCode: wh.code, debitCode: a.counterAccountCode, creditCode: invCode,
        row: { item_id: item.id, ...unit, warehouse_id: wh.id, direction: 'out', lot_no: it.lotNo || mv.lot, unit_cost: unitCost.toFixed(4), fixed_cost: true, link_line_id: lineId } };
      continue;
    }

    needQty();
    if (mode === 'invoice_first') { // hàng chưa về: 151 đang đi đường, không phát sinh kho; phiếu nhập sau chuyển 151 → 156
      out[k] = { accountCode: '151', itemCode: item.code, warehouseCode: null, row: { item_id: item.id, ...unit } };
      continue;
    }
    if (mode === 'goods_first') {
      let pl = it.sourceLineId ? pnkLines.find((l) => l.id === it.sourceLineId) : undefined;
      if (it.sourceLineId && (!pl || pl.item_id !== item.id)) throw bad('RECEIPT_LINE_NOT_FOUND', `Dòng ${n}: dòng phiếu nhập ${it.sourceLineId} không thuộc phiếu đã chọn hoặc khác hàng`, 404);
      pl ??= pnkLines.find((l) => !used.has(l.id) && l.item_id === item.id && D(l.base_quantity ?? 0).eq(base!));
      if (!pl) throw bad('RECEIPT_LINE_NOT_FOUND', `Dòng ${n}: không có dòng phiếu nhập chưa gắn hóa đơn cùng hàng ${item.code} và số lượng ${base}`, 404);
      if (used.has(pl.id)) throw bad('RECEIPT_LINE_TAKEN', `Dòng ${n}: dòng phiếu nhập đã gắn với hóa đơn mua khác`, 409);
      if (!D(pl.base_quantity ?? 0).eq(base!)) throw bad('RECEIPT_QTY_MISMATCH', `Dòng ${n}: số lượng hóa đơn ${base} khác số lượng phiếu nhập ${pl.base_quantity}`);
      used.add(pl.id);
      out[k] = { accountCode: pl.acct ?? '156', itemCode: item.code, warehouseCode: pl.wh, offsetVnd: round0(D(pl.amount).minus(pl.discount_amount)).toFixed(0), row: { item_id: item.id, ...unit, receipt_voucher_id: pl.voucher_id, link_line_id: pl.id } };
      continue;
    }
    // qua kho: nhập kho ngay theo dòng hóa đơn
    const wh = it.warehouseCode ? whs.get(it.warehouseCode) : undefined;
    if (!it.warehouseCode) throw bad('VALIDATION', `Dòng ${n}: phải chọn kho nhập`);
    if (!wh) throw bad('LOOKUP_NOT_FOUND', `Không có kho mã "${it.warehouseCode}"`, 404);
    if (!wh.is_active) throw bad('WAREHOUSE_INACTIVE', `Kho "${wh.code}" đã ngừng sử dụng`, 409);
    const tracked = item.tracking !== 'none';
    if (tracked && !it.lotNo) throw bad('LOT_REQUIRED', `Dòng ${n}: hàng ${it.itemCode} theo dõi theo lô, phải nhập số lô`);
    if (item.tracking === 'lot_expiry' && !it.expiryDate) throw bad('LOT_REQUIRED', `Dòng ${n}: hàng ${it.itemCode} theo dõi hạn dùng, phải nhập hạn dùng`);
    if (it.mfgDate && it.expiryDate && it.expiryDate < it.mfgDate) throw bad('EXPIRY_BEFORE_MFG', `Dòng ${n}: hạn dùng trước ngày sản xuất`);
    const invCode = wh.inv_code ?? item.inv_code ?? '156';
    out[k] = { accountCode: invCode, itemCode: item.code, warehouseCode: wh.code, debitCode: invCode, creditCode: a.counterAccountCode,
      row: { item_id: item.id, ...unit, warehouse_id: wh.id, direction: 'in', lot_no: it.lotNo || null, mfg_date: it.mfgDate || null, expiry_date: it.expiryDate || null } };
  }

  const stock = out.filter((x): x is PurchaseLine => !!x);
  if (stock.length) {
    if (a.auth && !a.auth.permissions.has(a.perm)) throw new AppError('FORBIDDEN', `Thiếu quyền ${a.perm}`, 403); // dòng hàng ghi vào kho
    if (a.auth) { // giá trị tồn kho: cần view_cost
      const accs = await trx.selectFrom('account').select(['code', 'subledger_kind']).where('regime', '=', a.regime).where('code', 'in', [...new Set(stock.map((x) => x.accountCode))]).execute();
      for (const acc of accs) assertSensitive(a.auth, acc);
    }
  }

  // Cảnh báo giá mua cao hơn bảng giá mua từ ngưỡng (mặc định 20%).
  const warnings: PurchaseResult['warnings'] = [];
  if (isMH) {
    const pct = D((await sql<{ v: string }>`SELECT value #>> '{}' AS v FROM tenant_setting WHERE tenant_id = app_tenant() AND key = 'purchase_price_warn_pct'`.execute(trx)).rows[0]?.v ?? '20');
    for (const k of idx) {
      const it = input.items[k]!; const pl = out[k];
      if (!pl || !it.unitPrice || !it.uomCode || !it.quantity) continue;
      const row = pl.row;
      const price = await resolvePrice(trx, { kind: 'purchase', itemId: row.item_id!, uomId: row.uom_id as number, partyId: a.partyId, date: input.postingDate, qty: it.quantity, currency: input.currencyCode });
      if (price && D(price.price).gt(0) && D(it.unitPrice).gte(D(price.price).times(D(100).plus(pct)).div(100)))
        warnings.push({ code: 'PURCHASE_PRICE_HIGH', message: `Dòng ${k + 1}: đơn giá ${it.unitPrice} cao hơn bảng giá mua ${price.price} từ ${pct.toString()}%`, lineNo: k + 1 });
    }
  }
  return { lines: out, receiptState: isMH ? (mode === 'through_stock' ? 'with_invoice' : mode) : null, warnings };
}
