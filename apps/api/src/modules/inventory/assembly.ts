import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, Decimal, splitByRatio, toBaseQty, voucherTypeDef } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import * as S from '../ledger/vouchers.service.js';
import { assertSensitive } from '../reporting/ledgers.js';
import { getStockVoucher, type StockVoucherDto } from './stockVouchers.js';

type Trx = Transaction<Database>;
type Auth = { sensitive: Set<string> };
type Ctx = { tenantId: string; userId: string; auth?: Auth };
const qtyRe = /^\d{1,16}(\.\d{1,4})?$/;
const optText = (max: number) => z.string().max(max).nullable().optional();
const round0 = (d: Decimal) => d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);

// LR: lắp ráp (xuất linh kiện, nhập thành phẩm) hoặc tháo dỡ (xuất thành phẩm, nhập linh kiện), cùng một kho. `outputs` luôn là thành phẩm, `components` luôn là linh kiện.
// costRatio (tổng 100) chỉ ở chiều nhập kho; bỏ trống cả chiều thì chia theo số lượng × giá vốn tạm tính của hàng nhập (không có giá thì theo số lượng).
const lineIn = z.object({
  itemCode: z.string().min(1), uomCode: z.string().min(1).optional(), quantity: z.string().regex(qtyRe, 'Số lượng không hợp lệ').refine((s) => /[1-9]/.test(s), 'Số lượng phải lớn hơn 0'),
  costRatio: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Tỷ lệ giá trị không hợp lệ').optional(), lotNo: optText(50), expiryDate: S.dateIso.nullable().optional(),
});
export const assemblyInput = z.object({
  mode: z.enum(['assembly', 'disassembly']), postingDate: S.dateIso, documentDate: S.dateIso.optional(), warehouseCode: z.string().min(1), description: z.string().nullable().optional(),
  personName: optText(200), attachmentsCount: z.number().int().min(0).max(999).nullable().optional(),
  outputs: z.array(lineIn).min(1, 'Phải có ít nhất một thành phẩm').max(50), components: z.array(lineIn).min(1, 'Phải có ít nhất một linh kiện').max(200),
  extraCost: z.string().regex(/^\d{1,16}$/, 'Chi phí phải là số nguyên VND').optional(), extraCostAccountCode: z.string().nullable().optional(),
});
export type AssemblyInput = z.infer<typeof assemblyInput>;

async function build(trx: Trx, input: AssemblyInput, auth?: Auth) {
  const { regime } = await S.periodOf(trx, input.postingDate, 'LR');
  const assembling = input.mode === 'assembly';
  const outSide = assembling ? input.components : input.outputs; const inSide = assembling ? input.outputs : input.components;
  if (outSide.some((l) => l.costRatio !== undefined)) throw new AppError('COST_RATIO_INVALID', 'Tỷ lệ giá trị chỉ nhập ở chiều nhập kho (thành phẩm khi lắp ráp, linh kiện khi tháo dỡ)', 400);

  const codes = [...new Set([...outSide, ...inSide].map((l) => l.itemCode))];
  const items = new Map((await trx.selectFrom('item as i').leftJoin('account as ia', 'ia.id', 'i.inventory_account_id').select(['i.id', 'i.code', 'i.kind', 'i.tracking', 'i.is_active', 'ia.code as inv_code', 'i.base_uom_id'])
    .where('i.code', 'in', codes).execute()).map((r) => [r.code, r]));
  for (const c of codes) {
    const r = items.get(c); if (!r) throw new AppError('LOOKUP_NOT_FOUND', `Không có vật tư hàng hóa mã "${c}"`, 404);
    if (!r.is_active) throw new AppError('ITEM_INACTIVE', `Vật tư hàng hóa "${c}" đã ngừng sử dụng`, 409);
    if (r.kind === 'service') throw new AppError('VALIDATION', `"${c}" là dịch vụ, không lắp ráp, tháo dỡ được`, 400);
  }
  const uoms = await trx.selectFrom('item_uom as iu').innerJoin('uom as u', 'u.id', 'iu.uom_id').select(['iu.item_id', 'u.code', 'iu.factor', 'iu.uom_id']).where('iu.item_id', 'in', [...items.values()].map((r) => r.id)).execute();
  const wh = await trx.selectFrom('warehouse as w').leftJoin('account as wa', 'wa.id', 'w.inventory_account_id').select(['w.id', 'w.code', 'w.is_active', 'wa.code as inv_code']).where('w.code', '=', input.warehouseCode).executeTakeFirst();
  if (!wh) throw new AppError('LOOKUP_NOT_FOUND', `Không có kho mã "${input.warehouseCode}"`, 404);
  if (!wh.is_active) throw new AppError('WAREHOUSE_INACTIVE', `Kho "${input.warehouseCode}" đã ngừng sử dụng`, 409);

  const est = new Map<number, string>(); // giá vốn tạm tính theo hàng (tồn đến ngày phiếu)
  const estimate = async (itemId: number) => {
    if (!est.has(itemId)) est.set(itemId, (await sql<{ c: string }>`SELECT fn_stock_estimate_cost(${itemId}::bigint, ${wh.id}::bigint, ${input.postingDate}::date)::text AS c`.execute(trx)).rows[0]!.c);
    return est.get(itemId)!;
  };
  const prep = async (side: typeof outSide, dir: 'in' | 'out', first: number) => Promise.all(side.map(async (it, i) => {
    const item = items.get(it.itemCode)!; const n = first + i;
    const uomCode = it.uomCode ?? uoms.find((x) => x.item_id === item.id && x.uom_id === item.base_uom_id)?.code;
    const u = uoms.find((x) => x.item_id === item.id && x.code === uomCode);
    if (!u) throw new AppError('ITEM_UOM_INVALID', `Dòng ${n}: hàng ${it.itemCode} không có đơn vị tính "${uomCode ?? ''}"`, 400);
    if (item.tracking !== 'none' && !it.lotNo) throw new AppError('LOT_REQUIRED', `Dòng ${n}: hàng ${it.itemCode} theo dõi theo lô, phải nhập số lô`, 400);
    if (item.tracking === 'lot_expiry' && dir === 'in' && !it.expiryDate) throw new AppError('LOT_REQUIRED', `Dòng ${n}: hàng ${it.itemCode} theo dõi hạn dùng, phải nhập hạn dùng`, 400);
    const base = toBaseQty(it.quantity, D(u.factor).toString());
    let unitCost: string | null = null; let amount = '0';
    if (dir === 'out') {
      unitCost = D(await estimate(item.id)).toFixed(4); amount = round0(D(base).times(unitCost));
    }
    return { it, item, n, u, base, unitCost, amount, invCode: wh.inv_code ?? item.inv_code ?? '156' };
  }));
  const outs = await prep(outSide, 'out', 1); const ins = await prep(inSide, 'in', outs.length + 1);

  // Tỷ lệ giá trị chiều nhập: nhập tay (tổng đúng 100) hoặc theo số lượng × giá tạm tính; lưu vào dòng để lần tính giá vốn chia lại đúng như lúc lập.
  const given = ins.filter((l) => l.it.costRatio !== undefined).length;
  let ratios: string[];
  if (given) {
    if (given !== ins.length) throw new AppError('COST_RATIO_INVALID', 'Tỷ lệ giá trị phải nhập đủ cho mọi dòng nhập kho hoặc để trống tất cả', 400);
    if (!ins.reduce((s, l) => s.plus(l.it.costRatio!), D(0)).eq(100)) throw new AppError('COST_RATIO_INVALID', 'Tổng tỷ lệ giá trị phải bằng 100', 400);
    ratios = ins.map((l) => D(l.it.costRatio!).toFixed(4));
  } else if (ins.length === 1) ratios = ['100.0000'];
  else {
    let w = await Promise.all(ins.map(async (l) => D(l.base).times(await estimate(l.item.id))));
    if (w.every((x) => x.isZero())) w = ins.map((l) => D(l.base));
    const tot = w.reduce((s, x) => s.plus(x), D(0));
    ratios = w.map((x, i) => i === w.length - 1 ? '' : x.div(tot).times(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4));
    ratios[ratios.length - 1] = D(100).minus(ratios.slice(0, -1).reduce((s, x) => s.plus(x), D(0))).toFixed(4);
  }

  const extra = D(input.extraCost ?? '0');
  const total = outs.reduce((s, l) => s.plus(l.amount), D(0)).plus(extra);
  const inAmounts = splitByRatio(total, ratios);
  if (total.toFixed(0).length > 16) throw new AppError('AMOUNT_TOO_LARGE', 'Giá trị phiếu vượt quá 16 chữ số', 400);
  const invCodes = new Set(ins.map((l) => l.invCode));
  if (invCodes.size > 1) throw new AppError('ASSEMBLY_ACCOUNT_MISMATCH', 'Các dòng nhập kho của phiếu lắp ráp, tháo dỡ phải cùng tài khoản kho', 400);
  const inCode = [...invCodes][0]!;

  let extraCode: string | null = null;
  if (!extra.isZero()) {
    extraCode = input.extraCostAccountCode || null;
    if (!extraCode) {
      const a154 = await trx.selectFrom('account').select('id').where('regime', '=', regime).where('code', '=', '154').where('is_group', '=', false).executeTakeFirst();
      if (!a154) throw new AppError('EXTRA_COST_ACCOUNT_REQUIRED', 'Hệ thống tài khoản không có TK 154 chi tiết: chọn tài khoản ghi có cho chi phí lắp ráp', 400);
      extraCode = '154';
    }
  }
  const acctCodes = [...new Set([inCode, ...outs.map((l) => l.invCode), ...(extraCode ? [extraCode] : [])])];
  const accs = new Map((await trx.selectFrom('account').select(['id', 'code', 'name', 'subledger_kind']).where('regime', '=', regime).where('code', 'in', acctCodes).execute()).map((a) => [a.code, a]));
  for (const c of acctCodes) if (!accs.has(c)) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản "${c}" trong hệ thống tài khoản`, 404);
  if (auth) for (const c of acctCodes) assertSensitive(auth, accs.get(c)!);

  // Sổ cái: Nợ TK kho nhập (từng hàng) / Có TK kho xuất (từng hàng) và Có TK chi phí cho phần chi phí nhập tay.
  const groups = new Map<string, S.LineInput>(); const sums = new Map<string, Decimal>();
  const add = (side: 'debit' | 'credit', code: string, itemCode: string | undefined, amount: string | Decimal) => {
    if (D(amount).isZero()) return;
    const key = `${side}|${code}|${itemCode ?? ''}`;
    if (!groups.has(key)) groups.set(key, { accountCode: code, debit: '0', credit: '0', ...(itemCode && { itemCode, warehouseCode: wh.code }), description: input.description ?? null });
    sums.set(key, (sums.get(key) ?? D(0)).plus(amount));
  };
  outs.forEach((l) => add('credit', l.invCode, l.it.itemCode, l.amount));
  ins.forEach((l, i) => add('debit', inCode, l.it.itemCode, inAmounts[i]!));
  // TK chi phí có chi tiết vật tư (vd. 154) bắt buộc có hàng: gắn vào hàng nhập đầu tiên.
  if (extraCode) add('credit', extraCode, accs.get(extraCode)!.subledger_kind === 'inventory' ? ins[0]!.it.itemCode : undefined, extra);
  const ledger: S.LineInput[] = [...groups].map(([k, g]) => ({ ...g, [k.startsWith('debit') ? 'debit' : 'credit']: sums.get(k)!.toFixed(0) }));
  if (!ledger.length) throw new AppError('STOCK_VALUE_ZERO', 'Phiếu chưa có giá trị để ghi sổ cái: kiểm tra giá vốn tạm tính hoặc nhập chi phí', 409);
  return { ledger, outs, ins, inAmounts, ratios, inCode, extraCode, accs, warehouseId: wh.id };
}

async function insertItems(trx: Trx, tenantId: string, voucherId: string, b: Awaited<ReturnType<typeof build>>) {
  const common = (l: (typeof b.outs)[number]) => ({ tenant_id: tenantId, voucher_id: voucherId, line_no: l.n, item_id: l.item.id, uom_id: l.u.uom_id, quantity: l.it.quantity, warehouse_id: b.warehouseId,
    uom_factor: l.u.factor, base_quantity: l.base, lot_no: l.it.lotNo || null, expiry_date: l.it.expiryDate || null });
  const rows = [
    ...b.outs.map((l) => ({ ...common(l), amount_currency: l.amount, amount: l.amount, account_id: b.accs.get(l.invCode)!.id, direction: 'out', debit_account_id: b.accs.get(b.inCode)!.id, credit_account_id: b.accs.get(l.invCode)!.id, unit_cost: l.unitCost })),
    ...b.ins.map((l, i) => ({ ...common(l), amount_currency: b.inAmounts[i]!, amount: b.inAmounts[i]!, account_id: b.accs.get(b.inCode)!.id, direction: 'in', debit_account_id: b.accs.get(b.inCode)!.id,
      credit_account_id: b.accs.get(b.extraCode ?? b.outs[0]!.invCode)!.id, cost_ratio: b.ratios[i]! })),
  ];
  await trx.insertInto('voucher_item_line').values(rows).execute();
}

const header = (input: AssemblyInput, ledger: S.LineInput[]): S.SystemVoucherInput => ({
  voucherType: 'LR', postingDate: input.postingDate, documentDate: input.documentDate ?? input.postingDate, description: input.description ?? null, partyCode: null,
  currencyCode: 'VND', personName: input.personName ?? null, attachmentsCount: input.attachmentsCount ?? null, stockKind: input.mode, lines: ledger });

export async function createAssembly(trx: Trx, ctx: Ctx, input: AssemblyInput): Promise<StockVoucherDto> {
  const b = await build(trx, input, ctx.auth);
  const v = await S.createStockVoucherHeader(trx, ctx, header(input, b.ledger));
  await insertItems(trx, ctx.tenantId, v.id, b);
  return getStockVoucher(trx, v.id);
}
export async function updateAssembly(trx: Trx, ctx: Ctx, id: string, version: number, input: AssemblyInput): Promise<StockVoucherDto> {
  const cur = await trx.selectFrom('voucher').select('voucher_type').where('id', '=', id).executeTakeFirst();
  if (!cur || cur.voucher_type !== 'LR' || voucherTypeDef(cur.voucher_type)?.module !== 'inventory') throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy phiếu lắp ráp, tháo dỡ', 404);
  const b = await build(trx, input, ctx.auth);
  const h = header(input, b.ledger);
  await S.updateStockDraftHeader(trx, id, version, { ...h, currencyCode: 'VND', lines: h.lines } as S.VoucherInput & { stockKind: string });
  await trx.deleteFrom('voucher_item_line').where('voucher_id', '=', id).execute();
  await insertItems(trx, ctx.tenantId, id, b);
  return getStockVoucher(trx, id);
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const ctx = (req: { auth: { tenantId: string | null; userId: string; sensitive: Set<string> } | null }) => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId, auth: req.auth! });
  app.post('/api/assembly-vouchers', { preHandler: app.requirePermission('stock_voucher.create'), schema: { body: assemblyInput } }, async (req, reply) =>
    reply.status(201).send(await app.withOverride(req, (trx) => createAssembly(trx, ctx(req), req.body))));
  app.put('/api/assembly-vouchers/:id', { preHandler: app.requirePermission('stock_voucher.update'), schema: { params: z.object({ id: z.string().uuid() }), body: assemblyInput.extend({ version: z.number().int() }) } }, async (req) => {
    const { version, ...input } = req.body;
    return app.withOverride(req, (trx) => updateAssembly(trx, ctx(req), req.params.id, version, input));
  });
};
export default routes;
