import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, TAX_CODE_RE, toVnd } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { createInvoice, type InvoiceInput } from '../invoices/service.js';
import { dateIso } from '../ledger/vouchers.service.js';
import { catalogByName } from '../master/catalogs.js';
import { createRow } from '../master/crud.js';
import { parseInvoiceXml } from './parseXml.js';

type Trx = Transaction<Database>;
type Auth = { sensitive: Set<string>; permissions: Set<string> };

export const voucherBody = z.object({
  voucherType: z.enum(['HDM', 'MH']), postingDate: dateIso, partyCode: z.string().min(1).optional(), createParty: z.boolean().optional(),
  counterAccountCode: z.string().min(1).optional(), invoiceGroupCode: z.string().min(1), stockMode: z.enum(['through_stock', 'goods_first', 'invoice_first']).optional(),
  description: z.string().max(500).nullable().optional(),
  lines: z.array(z.object({
    lineNo: z.number().int().positive(), itemCode: z.string().min(1).nullish(), accountCode: z.string().min(1).nullish(), warehouseCode: z.string().min(1).nullish(),
    taxCode: z.string().min(1).nullish(), uomCode: z.string().min(1).nullish(),
  })).min(1).max(500),
});
export type VoucherBody = z.infer<typeof voucherBody>;

const conflict = (code: string, msg: string) => new AppError(code, msg, 409);
async function loadRow(trx: Trx, id: number, lock: boolean) {
  const q = trx.selectFrom('inbound_invoice').selectAll().where('id', '=', id);
  const r = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!r) throw new AppError('NOT_FOUND', 'Không tìm thấy hóa đơn đầu vào', 404);
  return r;
}
const loadLines = (trx: Trx, id: number) => trx.selectFrom('inbound_invoice_line').selectAll().where('invoice_id', '=', id).where('kind', '<>', 'note').orderBy('line_no').execute();

// Đoán mã thuế GTGT mua vào theo thuế suất trên hóa đơn: mã đang dùng, phạm vi mua/cả hai, mã nhỏ nhất khớp.
async function guessTaxCodes(trx: Trx, rates: (string | null)[]): Promise<Map<string, string>> {
  const taxes = await trx.selectFrom('tax_code').select(['code', 'rate']).where('kind', '=', 'vat').where('is_active', '=', true).where('scope', 'in', ['purchase', 'both']).orderBy('code').execute();
  const out = new Map<string, string>();
  for (const r of new Set(rates)) {
    if (r === null) continue;
    const hit = /^\d+(\.\d+)?$/.test(r) ? taxes.find((t) => t.rate !== null && D(t.rate).eq(r))?.code : r === 'KCT' ? 'KCT' : r === 'KKKNT' ? 'KKK' : undefined;
    if (hit) out.set(r, hit);
  }
  return out;
}

export async function buildProposal(trx: Trx, id: number) {
  const r = await loadRow(trx, id, false); const lines = await loadLines(trx, id);
  const party = r.party_id ? await trx.selectFrom('party').select(['code', 'name']).where('id', '=', r.party_id).executeTakeFirst() : undefined;
  const maps = r.seller_tax_code ? await trx.selectFrom('inbound_invoice_line as l').innerJoin('inbound_item_map as m', (j) => j.on(sql<boolean>`m.name_key = fn_invoice_key(l.name)`).on(sql<boolean>`m.seller_tax_code = fn_invoice_key(${r.seller_tax_code})`))
    .leftJoin('item as i', 'i.id', 'm.item_id').leftJoin('account as a', 'a.id', 'm.account_id').leftJoin('tax_code as t', 't.id', 'm.tax_code_id')
    .select(['l.line_no', 'i.code as item_code', 'a.code as account_code', 't.code as tax_code']).where('l.invoice_id', '=', id).execute() : [];
  const guess = await guessTaxCodes(trx, lines.map((l) => l.tax_rate));
  const itemCodes = maps.flatMap((m) => (m.item_code ? [m.item_code] : []));
  const kinds = new Map((itemCodes.length ? await trx.selectFrom('item').select(['code', 'kind']).where('code', 'in', itemCodes).execute() : []).map((i) => [i.code, i.kind]));
  const out = lines.map((l) => {
    const m = maps.find((x) => x.line_no === l.line_no);
    const taxCode = m?.tax_code ?? (l.tax_rate !== null ? guess.get(l.tax_rate) ?? null : null);
    return { lineNo: l.line_no, kind: l.kind, name: l.name, amount: l.amount === null ? null : D(l.amount).toFixed(), taxRate: l.tax_rate, itemCode: m?.item_code ?? null, accountCode: m?.account_code ?? null, taxCode, source: m ? 'map' as const : 'guess' as const };
  });
  return {
    partyCode: party?.code ?? null, partyName: party?.name ?? null, sellerName: r.seller_name, sellerTaxCode: r.seller_tax_code, blocked: r.blocked, status: r.status,
    voucherType: out.some((l) => l.itemCode && kinds.get(l.itemCode) !== 'service') ? 'MH' as const : 'HDM' as const, lines: out,
  };
}

export async function createVoucherFromInbound(trx: Trx, ctx: { tenantId: string; userId: string; auth: Auth }, id: number, body: VoucherBody): Promise<{ voucherId: string; warnings: unknown[] }> {
  const r = await loadRow(trx, id, true); // khóa dòng: hai yêu cầu đồng thời chỉ lập được một chứng từ
  if (r.status === 'voucher_created') throw conflict('INBOUND_ALREADY_CONVERTED', 'Hóa đơn đầu vào này đã được lập chứng từ');
  if (r.status !== 'new') throw conflict('INBOUND_STATUS', r.status === 'duplicate' ? 'Hóa đơn đầu vào trùng với hóa đơn đã nhận: không lập chứng từ' : 'Hóa đơn đầu vào đã bị bỏ qua');
  if (r.blocked) throw conflict('INBOUND_BLOCKED', 'Hóa đơn có số liệu hỏng (xem cảnh báo): không lập chứng từ');
  const lines = await loadLines(trx, id);
  if (lines.some((l) => l.kind === 'discount')) throw conflict('INBOUND_DISCOUNT_UNSUPPORTED', 'Hóa đơn có dòng chiết khấu: chưa lập tự động được, hãy lập chứng từ thủ công');
  const lines2 = lines.filter((l) => l.kind === 'goods' || (l.kind === 'promotion' && D(l.amount ?? '0').gt(0)));
  if (lines2.length === 0) throw new AppError('VALIDATION', 'Hóa đơn không có dòng hàng để lập chứng từ', 400);

  // Đối tượng: theo mã chọn, theo người bán đã khớp MST, hoặc tạo mới từ hóa đơn.
  let partyCode = body.partyCode;
  if (!partyCode && r.party_id) partyCode = (await trx.selectFrom('party').select('code').where('id', '=', r.party_id).executeTakeFirst())?.code;
  if (!partyCode) {
    if (!body.createParty) throw new AppError('PARTY_REQUIRED', 'Chưa có đối tượng cho người bán: chọn nhà cung cấp hoặc tạo mới từ hóa đơn', 400);
    const mst = r.seller_tax_code && TAX_CODE_RE.test(r.seller_tax_code) ? r.seller_tax_code : null;
    partyCode = `NCC${(r.seller_tax_code ?? String(r.id)).replace(/[^0-9A-Za-z]/g, '')}`.slice(0, 30);
    await createRow(trx, ctx.tenantId, catalogByName('party')!, { code: partyCode, name: r.seller_name, is_vendor: true, tax_code: mst, address: r.seller_address });
  }
  const party = await trx.selectFrom('party').select(['id', 'tax_code']).where('code', '=', partyCode).executeTakeFirst();
  if (!party) throw new AppError('NOT_FOUND', `Không có đối tượng ${partyCode}`, 404);

  const currency = r.currency.toUpperCase(); const isVnd = currency === 'VND';
  if (!isVnd && !r.fx_rate) throw conflict('INBOUND_BLOCKED', 'Hóa đơn ngoại tệ thiếu tỷ giá');
  const cfg = new Map(body.lines.map((l) => [l.lineNo, l]));
  const money = /^\d{1,16}(\.\d{1,4})?$/; const norm = (s: string | null) => (s === null ? null : D(s).toFixed()); // cột numeric(20,4) trả "1000000.0000"
  const uomOf = new Map((await trx.selectFrom('item as i').innerJoin('uom as u', 'u.id', 'i.base_uom_id').select(['i.code', 'u.code as uom']).execute()).map((x) => [x.code, x.uom]));
  const items: InvoiceInput['items'] = lines2.map((l) => {
    const c = cfg.get(l.line_no);
    if (!c) throw new AppError('VALIDATION', `Dòng ${l.line_no}: chưa chọn tài khoản, vật tư và mã thuế`, 400);
    if (!c.taxCode) throw new AppError('VALIDATION', `Dòng ${l.line_no}: chưa chọn mã thuế`, 400);
    const amount = norm(l.amount); const qty = norm(l.quantity); const price = norm(l.unit_price);
    if (!amount || !money.test(amount)) throw new AppError('VALIDATION', `Dòng ${l.line_no}: thành tiền không hợp lệ cho chứng từ`, 400);
    return {
      description: l.name, ...(c.accountCode && { accountCode: c.accountCode }), amountCurrency: amount, discountCurrency: '0', taxCodes: [c.taxCode],
      ...(qty && money.test(qty) && { quantity: qty }), ...(price && money.test(price) && { unitPrice: price }),
      ...(c.itemCode && { itemCode: c.itemCode, uomCode: c.uomCode ?? uomOf.get(c.itemCode) ?? null }), ...(!c.itemCode && c.uomCode && { uomCode: c.uomCode }), ...(c.warehouseCode && { warehouseCode: c.warehouseCode }),
    };
  });

  // Thuế theo hóa đơn: nhóm thuế suất của XML gốc (không lưu riêng) → thuế theo mã thuế đã chọn. Lệch dòng nhỏ được máy thuế dồn vào dòng lớn nhất, lệch lớn báo TAX_DECLARED_MISMATCH.
  const declared: Record<string, string> = {};
  for (const g of parseInvoiceXml(r.xml).taxGroups) {
    const ls = lines2.filter((l) => (l.tax_rate ?? '') === g.taxRate);
    const codes = new Set(ls.map((l) => cfg.get(l.line_no)!.taxCode!));
    if (codes.size > 1) throw new AppError('VALIDATION', `Thuế suất ${g.taxRate || '(trống)'} đang ánh xạ nhiều mã thuế: chọn cùng một mã cho các dòng cùng thuế suất`, 400);
    if (codes.size === 0 || g.tax === null) continue;
    const code = [...codes][0]!;
    declared[code] = D(declared[code] ?? '0').plus(isVnd ? g.tax : toVnd(g.tax, r.fx_rate!)).toFixed(0);
  }

  const mst = r.seller_tax_code && TAX_CODE_RE.test(r.seller_tax_code) ? r.seller_tax_code : null;
  const input: InvoiceInput = {
    voucherType: body.voucherType, postingDate: body.postingDate, documentDate: body.postingDate, partyCode, ...(body.counterAccountCode && { counterAccountCode: body.counterAccountCode }),
    currencyCode: currency, ...(!isVnd && { fxRate: r.fx_rate! }), description: body.description ?? `Hóa đơn ${r.serial} số ${r.invoice_no} của ${r.seller_name}`.slice(0, 500), items,
    ...(body.stockMode && { stockMode: body.stockMode }),
    invoice: {
      formNo: r.form_no, serial: r.serial, invoiceNo: r.invoice_no, invoiceDate: r.issue_date, invoiceGroupCode: body.invoiceGroupCode, declaredTax: declared,
      ...(mst && { partyTaxCode: mst }), partyName: r.seller_name.slice(0, 300), partyAddress: r.seller_address?.slice(0, 500) ?? null,
    },
  };
  const inv = await createInvoice(trx, ctx, input);

  // Nhớ ánh xạ theo (MST người bán, tên hàng) cho lần sau.
  if (r.seller_tax_code) {
    const regime = (await trx.selectFrom('fiscal_period').select('regime').where('period_no', '>=', 1).where('period_no', '<=', 15).where('date_from', '<=', body.postingDate).where('date_to', '>=', body.postingDate).executeTakeFirst())?.regime;
    for (const l of lines2) {
      const c = cfg.get(l.line_no)!;
      await sql`INSERT INTO inbound_item_map (tenant_id, seller_tax_code, name_key, item_id, account_id, tax_code_id)
        VALUES (${ctx.tenantId}::uuid, fn_invoice_key(${r.seller_tax_code}), fn_invoice_key(${l.name}),
          (SELECT id FROM item WHERE code = ${c.itemCode ?? null}::text), (SELECT id FROM account WHERE code = ${c.accountCode ?? null}::text AND regime = ${regime ?? null}::text), (SELECT id FROM tax_code WHERE code = ${c.taxCode ?? null}::text))
        ON CONFLICT (tenant_id, seller_tax_code, name_key) DO UPDATE SET item_id = EXCLUDED.item_id, account_id = EXCLUDED.account_id, tax_code_id = EXCLUDED.tax_code_id, updated_at = now()`.execute(trx);
    }
  }
  await trx.updateTable('inbound_invoice').set({ status: 'voucher_created', voucher_id: inv.id, party_id: party.id }).where('id', '=', id).execute();
  return { voucherId: inv.id, warnings: inv.warnings ?? [] };
}
