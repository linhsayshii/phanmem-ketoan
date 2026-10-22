import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, Decimal, sensitiveDenial, toBaseQty, toVnd } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { resolvePrice } from '../inventory/priceLists.js';
import type { LineInput } from '../ledger/vouchers.service.js';
import type { InvoiceInput } from './service.js';
import type { PurchaseLine } from './purchase.js';

type Trx = Transaction<Database>;
type Auth = { sensitive: Set<string>; permissions: Set<string> };

// Dòng hàng của hóa đơn bán hàng hóa kiêm phiếu xuất (BH) và hàng bán bị trả lại (TLB), cùng dạng dòng hàng của hóa đơn mua (PurchaseLine):
// accountCode là TK doanh thu (BH) hoặc TK doanh thu của dòng bán gốc (TLB); debitCode/creditCode là cặp TK giá vốn ghi trên dòng hàng để chạy giá vốn lập chứng từ GV chênh lệch.
// costLines là bút toán giá vốn tạm tính của dòng (BH: Nợ 632 / Có TK kho; TLB: Nợ TK kho / Có 632), số tiền = số lượng gốc × giá vốn tạm tính (BH) hoặc giá vốn đã gán của dòng bán theo tỷ lệ (TLB).
export interface SaleResult { lines: (PurchaseLine | null)[]; costLines: LineInput[][]; warnings: { code: string; message: string; lineNo?: number }[] }

const round0 = (d: Decimal) => d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
const bad = (code: string, msg: string, status = 400) => new AppError(code, msg, status);

// Xuất khẩu: mọi dòng thuế GTGT 0%. Dòng chưa có mã GTGT được gán mã GTGT 0% đang dùng (mã nhỏ nhất, phạm vi bán ra); dòng có mã GTGT khác 0% bị chặn.
export async function applyExportMode(trx: Trx, input: InvoiceInput): Promise<InvoiceInput> {
  if (!input.exportMode) return input;
  if (input.voucherType !== 'BH' && input.voucherType !== 'TLB') throw bad('VALIDATION', 'Xuất khẩu (exportMode) chỉ dùng cho bán hàng hóa và hàng bán bị trả lại');
  const vats = await trx.selectFrom('tax_code').select(['code', 'rate']).where('kind', '=', 'vat').where('is_active', '=', true).where('scope', 'in', ['sale', 'both']).orderBy('code').execute();
  const zero = vats.find((r) => r.rate !== null && D(r.rate).isZero());
  if (!zero) throw bad('EXPORT_TAX_CODE_MISSING', 'Danh mục chưa có mã thuế GTGT 0% dùng cho bán ra để lập hóa đơn xuất khẩu', 409);
  const rateOf = new Map(vats.map((r) => [r.code, r.rate]));
  const items = input.items.map((it, k) => {
    const other = it.taxCodes.find((c) => rateOf.has(c) && !(rateOf.get(c) !== null && D(rateOf.get(c)!).isZero()));
    if (other) throw bad('EXPORT_VAT_NOT_ZERO', `Dòng ${k + 1}: hóa đơn xuất khẩu thuế GTGT 0%, không dùng mã ${other}`);
    return it.taxCodes.some((c) => rateOf.has(c)) ? it : { ...it, taxCodes: [...it.taxCodes, zero.code] };
  });
  return { ...input, items };
}

export async function resolveSale(trx: Trx, a: { input: InvoiceInput; counterAccountCode: string; partyId: string; rate: string | null; selfId?: string; auth?: Auth; perm: string }): Promise<SaleResult> {
  const { input } = a; const isBH = input.voucherType === 'BH';
  const out: (PurchaseLine | null)[] = input.items.map(() => null);
  const costLines: LineInput[][] = input.items.map(() => []);
  const warnings: SaleResult['warnings'] = [];
  for (const [k, it] of input.items.entries()) if (!it.itemCode && !it.accountCode) throw bad('VALIDATION', `Dòng ${k + 1}: phải chọn hàng hóa hoặc tài khoản`);
  if (input.stockMode || input.receiptVoucherIds?.length) throw bad('VALIDATION', 'Bán hàng hóa không có cách nhận hàng (stockMode, receiptVoucherIds chỉ dùng cho mua hàng hóa)');
  const idx = input.items.flatMap((it, k) => (it.itemCode ? [k] : []));
  if (!idx.length) return { lines: out, costLines, warnings };
  const isVnd = input.currencyCode === 'VND';
  if (!isVnd && !isBH) throw bad('INVOICE_FX_UNSUPPORTED', 'Hàng bán bị trả lại chỉ lập bằng VND');
  const vndLine = isVnd ? {} : { currencyCode: 'VND' };

  const itemRows = await trx.selectFrom('item as i').leftJoin('account as ia', 'ia.id', 'i.inventory_account_id').leftJoin('account as ra', 'ra.id', 'i.revenue_account_id').leftJoin('account as ca', 'ca.id', 'i.cogs_account_id')
    .select(['i.id', 'i.code', 'i.kind', 'i.tracking', 'i.is_active', 'ia.code as inv_code', 'ra.code as rev_code', 'ca.code as cogs_code'])
    .where('i.code', 'in', [...new Set(idx.map((k) => input.items[k]!.itemCode!))]).execute();
  const items = new Map(itemRows.map((r) => [r.code, r]));
  const uoms = itemRows.length ? await trx.selectFrom('item_uom as iu').innerJoin('uom as u', 'u.id', 'iu.uom_id').select(['iu.item_id', 'u.code', 'iu.factor', 'iu.uom_id']).where('iu.item_id', 'in', itemRows.map((r) => r.id)).execute() : [];
  const whCodes = [...new Set(idx.flatMap((k) => (input.items[k]!.warehouseCode ? [input.items[k]!.warehouseCode!] : [])))];
  const whs = new Map((whCodes.length ? await trx.selectFrom('warehouse as w').leftJoin('account as wa', 'wa.id', 'w.inventory_account_id').select(['w.id', 'w.code', 'w.kind', 'w.is_active', 'wa.code as inv_code']).where('w.code', 'in', whCodes).execute() : []).map((r) => [r.code, r]));
  const whById = async (id: number | string) => trx.selectFrom('warehouse as w').leftJoin('account as wa', 'wa.id', 'w.inventory_account_id').select(['w.id', 'w.code', 'wa.code as inv_code']).where('w.id', '=', Number(id)).executeTakeFirstOrThrow();

  const returning = new Map<number, Decimal>(); // số lượng trả cộng dồn theo dòng bán trong cùng hóa đơn
  const costOf: (Decimal | null)[] = input.items.map(() => null);
  const estimates = new Map<string, string>();
  for (const k of idx) {
    const it = input.items[k]!; const n = k + 1;
    const item = items.get(it.itemCode!);
    if (!item) throw bad('LOOKUP_NOT_FOUND', `Không có vật tư hàng hóa mã "${it.itemCode}"`, 404);
    if (!item.is_active) throw bad('ITEM_INACTIVE', `Vật tư hàng hóa "${it.itemCode}" đã ngừng sử dụng`, 409);
    if (item.kind === 'service') { // dịch vụ: chỉ ghi doanh thu, không xuất kho
      if (it.warehouseCode || it.sourceLineId) throw bad('VALIDATION', `Dòng ${n}: dịch vụ ${it.itemCode} không có kho, không trả lại theo dòng hàng`);
      const acc = it.accountCode ?? item.rev_code;
      if (!acc) throw bad('VALIDATION', `Dòng ${n}: dịch vụ ${it.itemCode} phải chọn tài khoản doanh thu`);
      out[k] = { accountCode: acc, itemCode: item.code, warehouseCode: null, row: { item_id: item.id } };
      continue;
    }
    const u = it.uomCode ? uoms.find((x) => x.item_id === item.id && x.code === it.uomCode) : undefined;
    if (it.uomCode && !u) throw bad('ITEM_UOM_INVALID', `Dòng ${n}: hàng ${it.itemCode} không có đơn vị tính "${it.uomCode}"`);
    if (!it.quantity || !u || !D(it.quantity).gt(0)) throw bad('VALIDATION', `Dòng ${n}: phải nhập số lượng và đơn vị tính`);
    const base = D(toBaseQty(it.quantity, D(u.factor).toString()));
    const unit = { uom_id: u.uom_id, uom_factor: D(u.factor).toString(), base_quantity: base.toString() };
    const tracked = item.tracking !== 'none';

    if (isBH) {
      const wh = it.warehouseCode ? whs.get(it.warehouseCode) : undefined;
      if (!it.warehouseCode) throw bad('VALIDATION', `Dòng ${n}: phải chọn kho xuất`);
      if (!wh) throw bad('LOOKUP_NOT_FOUND', `Không có kho mã "${it.warehouseCode}"`, 404);
      if (!wh.is_active) throw bad('WAREHOUSE_INACTIVE', `Kho "${wh.code}" đã ngừng sử dụng`, 409);
      if (wh.kind === 'consignment_in') throw bad('CONSIGNMENT_IN_UNSUPPORTED', `Dòng ${n}: kho ${wh.code} là kho nhận bán hộ (chỉ theo dõi số lượng, không có bút toán giá vốn); chưa hỗ trợ bán hàng từ kho này`, 409);
      if (tracked && !it.lotNo) throw bad('LOT_REQUIRED', `Dòng ${n}: hàng ${it.itemCode} theo dõi theo lô, phải nhập số lô`);
      const revenue = it.accountCode ?? item.rev_code;
      if (!revenue) throw bad('VALIDATION', `Dòng ${n}: hàng ${it.itemCode} chưa có tài khoản doanh thu, phải chọn tài khoản`);
      const key = `${item.id}:${wh.id}`;
      if (!estimates.has(key)) estimates.set(key, (await sql<{ c: string }>`SELECT fn_stock_estimate_cost(${item.id}::bigint, ${wh.id}::bigint, ${input.postingDate}::date)::text AS c`.execute(trx)).rows[0]!.c);
      const unitCost = D(estimates.get(key)!).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      const cost = round0(base.times(unitCost));
      const invCode = wh.inv_code ?? item.inv_code ?? '156'; const cogsCode = item.cogs_code ?? '632';
      if (cost.isZero()) warnings.push({ code: 'COST_UNKNOWN', message: `Dòng ${n}: hàng ${it.itemCode} chưa có giá vốn, ghi giá vốn 0 cho đến khi tính giá vốn`, lineNo: n });
      else costLines[k] = [
        { accountCode: cogsCode, debit: cost.toFixed(0), credit: '0', itemCode: item.code, warehouseCode: wh.code, ...vndLine, description: `Giá vốn dòng ${n}` },
        { accountCode: invCode, debit: '0', credit: cost.toFixed(0), itemCode: item.code, warehouseCode: wh.code, ...vndLine, description: `Giá vốn dòng ${n}` }];
      costOf[k] = cost;
      out[k] = { accountCode: revenue, itemCode: item.code, warehouseCode: wh.code, debitCode: cogsCode, creditCode: invCode,
        row: { item_id: item.id, ...unit, warehouse_id: wh.id, direction: 'out', lot_no: it.lotNo || null, mfg_date: it.mfgDate || null, expiry_date: it.expiryDate || null, unit_cost: unitCost.toFixed(4) } };
      continue;
    }

    // TLB: nhập lại kho theo giá vốn của dòng bán gốc
    if (!it.sourceLineId) throw bad('SALE_RETURN_SOURCE_INVALID', `Dòng ${n}: phải chỉ rõ dòng hóa đơn bán hàng hóa gốc (sourceLineId)`);
    const src = await trx.selectFrom('voucher_item_line as s').innerJoin('voucher as sv', 'sv.id', 's.voucher_id').innerJoin('account as ra', 'ra.id', 's.account_id')
      .leftJoin('account as da', 'da.id', 's.debit_account_id').leftJoin('account as ca', 'ca.id', 's.credit_account_id')
      .select(['s.id', 's.item_id', 's.unit_cost', 'sv.state', 'sv.voucher_type', 'sv.party_id', 'ra.code as rev_code', 'da.code as cogs_code', 'ca.code as inv_code'])
      .where('s.id', '=', it.sourceLineId).executeTakeFirst();
    if (!src || src.state !== 'posted' || src.voucher_type !== 'BH' || src.item_id !== item.id)
      throw bad('SALE_RETURN_SOURCE_INVALID', `Dòng ${n}: dòng gốc phải là dòng hàng ${it.itemCode} đã ghi sổ của hóa đơn bán hàng hóa`, 409);
    if (src.party_id !== a.partyId) throw bad('SALE_RETURN_PARTY_MISMATCH', `Dòng ${n}: hóa đơn bán gốc của khách hàng khác với hàng bán bị trả lại`, 409);
    const mv = (await sql<{ id: string; wh_id: string; qty: string; lot: string | null; assigned: string | null }>`
      SELECT m.id::text, m.warehouse_id::text AS wh_id, m.quantity::text AS qty, m.lot_no AS lot,
        (SELECT sum(a.amount)::text FROM stock_cost_assignment a WHERE a.tenant_id = m.tenant_id AND a.is_current AND a.move_id = m.id) AS assigned
      FROM stock_move m WHERE m.item_line_id = ${src.id} AND m.direction = 'out' AND m.reversal_of IS NULL AND m.transfer_id IS NULL`.execute(trx)).rows[0];
    if (!mv) throw bad('SALE_RETURN_SOURCE_INVALID', `Dòng ${n}: dòng bán gốc không xuất kho`, 409);
    const wh = await whById(mv.wh_id);
    if (it.warehouseCode && it.warehouseCode !== wh.code) throw bad('SALE_RETURN_SOURCE_INVALID', `Dòng ${n}: hàng đã xuất từ kho ${wh.code}, không nhập lại vào kho ${it.warehouseCode}`);
    if (D(it.discountCurrency).gt(0)) throw bad('VALIDATION', `Dòng ${n}: dòng hàng bán bị trả lại không có chiết khấu thương mại`);
    // Tổng số lượng trả (nháp và đã ghi sổ, gồm các dòng khác của chính hóa đơn này) không vượt số lượng bán.
    const prior = await trx.selectFrom('voucher_item_line as l').innerJoin('voucher as v', 'v.id', 'l.voucher_id').select('l.base_quantity').where('l.link_line_id', '=', src.id).where('l.direction', '=', 'in')
      .where('v.voucher_type', '=', 'TLB').where('v.state', 'in', ['draft', 'posted']).$if(!!a.selfId, (q) => q.where('l.voucher_id', '<>', a.selfId!)).execute();
    const returned = prior.reduce((s, r) => s.plus(r.base_quantity ?? 0), D(0)).plus(returning.get(src.id) ?? 0).plus(base);
    if (returned.gt(mv.qty)) throw bad('RETURN_EXCEEDS_SALE', `Dòng ${n}: tổng số lượng trả ${returned.toString()} vượt số lượng đã bán ${D(mv.qty).toString()}`, 409);
    returning.set(src.id, D(returning.get(src.id) ?? 0).plus(base));
    // Giá vốn nhập lại: giá vốn đã gán của dòng bán theo tỷ lệ số lượng trả; chưa chạy giá vốn thì giá tạm tính trên dòng bán.
    const cost = mv.assigned !== null ? round0(D(mv.assigned).times(base).div(mv.qty)) : round0(base.times(D(src.unit_cost ?? 0)));
    const unitCost = base.isZero() ? D(0) : cost.div(base).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    const invCode = src.inv_code ?? wh.inv_code ?? item.inv_code ?? '156'; const cogsCode = src.cogs_code ?? item.cogs_code ?? '632';
    if (tracked && !(it.lotNo || mv.lot)) throw bad('LOT_REQUIRED', `Dòng ${n}: hàng ${it.itemCode} theo dõi theo lô, phải nhập số lô`);
    if (!cost.isZero()) costLines[k] = [
      { accountCode: invCode, debit: cost.toFixed(0), credit: '0', itemCode: item.code, warehouseCode: wh.code, ...vndLine, description: `Giá vốn hàng trả lại dòng ${n}` },
      { accountCode: cogsCode, debit: '0', credit: cost.toFixed(0), itemCode: item.code, warehouseCode: wh.code, ...vndLine, description: `Giá vốn hàng trả lại dòng ${n}` }];
    out[k] = { accountCode: it.accountCode ?? src.rev_code, itemCode: item.code, warehouseCode: wh.code, debitCode: invCode, creditCode: cogsCode,
      row: { item_id: item.id, ...unit, warehouse_id: wh.id, direction: 'in', lot_no: it.lotNo || mv.lot, unit_cost: unitCost.toFixed(4), link_line_id: src.id } };
  }

  const stock = out.filter((x): x is PurchaseLine => !!x && !!x.warehouseCode);
  if (stock.length && a.auth && !a.auth.permissions.has(a.perm)) throw new AppError('FORBIDDEN', `Thiếu quyền ${a.perm}`, 403); // dòng hàng ghi vào kho

  if (isBH) { // cảnh báo bán dưới giá vốn (người không có view_cost chỉ thấy cảnh báo, không thấy số) và giá lệch bảng giá bán
    const canCost = !a.auth || a.auth.sensitive.has('view_cost');
    const pct = D((await sql<{ v: string }>`SELECT value #>> '{}' AS v FROM tenant_setting WHERE tenant_id = app_tenant() AND key = 'sale_price_warn_pct'`.execute(trx)).rows[0]?.v ?? '20');
    for (const k of idx) {
      const it = input.items[k]!; const pl = out[k]; const n = k + 1;
      if (!pl?.warehouseCode) continue;
      const net = D(it.amountCurrency).minus(it.discountCurrency);
      const revVnd = D(isVnd ? net.toFixed(0) : toVnd(net.toFixed(), a.rate!));
      const cost = costOf[k];
      if (cost && cost.gt(0) && revVnd.lt(cost))
        warnings.push({ code: 'SALE_BELOW_COST', message: canCost ? `Dòng ${n}: doanh thu ${revVnd.toFixed(0)} thấp hơn giá vốn tạm tính ${cost.toFixed(0)}` : `Dòng ${n}: bán thấp hơn giá vốn`, lineNo: n });
      if (!it.unitPrice || !it.uomCode || !it.quantity) continue;
      const price = await resolvePrice(trx, { kind: 'sale', itemId: pl.row.item_id!, uomId: pl.row.uom_id as number, partyId: a.partyId, date: input.postingDate, qty: it.quantity, currency: input.currencyCode });
      if (price && D(price.price).gt(0) && D(it.unitPrice).minus(price.price).abs().gte(D(price.price).times(pct).div(100)))
        warnings.push({ code: 'SALE_PRICE_DIFF', message: `Dòng ${n}: đơn giá ${it.unitPrice} lệch bảng giá bán ${price.price} từ ${pct.toString()}%`, lineNo: n });
    }
  }
  return { lines: out, costLines, warnings };
}

// Hóa đơn bán hàng hóa mang bút toán giá vốn: người thiếu view_cost vẫn lập, xem hóa đơn nhưng các dòng sổ cái trên tài khoản giá vốn, tồn kho (632, 15x...) và tổng tiền bị che.
export async function redactCost<T extends { id: string; voucherType: string; totalDebit: string; lines: { accountCode: string; debit: string }[] }>(trx: Trx, auth: { sensitive: Set<string> }, dto: T): Promise<T> {
  if ((dto.voucherType !== 'BH' && dto.voucherType !== 'TLB') || auth.sensitive.has('view_cost') || !dto.lines.length) return dto;
  const { regime } = await trx.selectFrom('voucher as v').innerJoin('fiscal_period as p', 'p.fiscal_year', 'v.fiscal_year').select('p.regime').where('v.id', '=', dto.id).limit(1).executeTakeFirstOrThrow();
  const accs = await trx.selectFrom('account').select(['code', 'subledger_kind']).where('regime', '=', regime).where('code', 'in', [...new Set(dto.lines.map((l) => l.accountCode))]).execute();
  const other = { sensitive: new Set(['view_receivable', 'view_payable']) }; // chỉ che phần do thiếu view_cost
  const hidden = new Set(accs.filter((a) => sensitiveDenial(other, a) !== null).map((a) => a.code));
  const lines = dto.lines.filter((l) => !hidden.has(l.accountCode));
  return { ...dto, lines, totalDebit: lines.reduce((s, l) => s.plus(l.debit), D(0)).toFixed(0) };
}
