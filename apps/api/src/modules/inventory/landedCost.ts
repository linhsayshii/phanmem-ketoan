import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { READ_SNAPSHOT, type Database } from '@kt/db';
import { allocateLandedCost, D, LandedCostError, sum, type Decimal, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { postWithCashCheck } from '../cash/books.js';
import { voucherInvoiceInput } from '../invoices/declaration.js';
import * as S from '../ledger/vouchers.service.js';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { assertVoucherSensitive, requireStockPerm } from '../ledger/vouchers.routes.js';
import { assertSensitive } from '../reporting/ledgers.js';

// Chi phí mua hàng (CPM): vận chuyển, bốc xếp, bảo hiểm... của hàng đã nhập, phân bổ vào giá nhập của các dòng nhập (PNK mua hàng, MH nhập kho cùng hóa đơn) theo giá trị hoặc số lượng.
// Bút toán: Nợ TK kho của từng dòng nhập (theo hàng, kho) / Có TK thanh toán của từng dòng chi phí (331, 111, 112...); thuế GTGT của dòng chi phí Nợ 1331 / Có cùng TK thanh toán.
// Hệ thống tài khoản TT99, TT133 không có 1562 (156 là tài khoản chi tiết) nên chi phí vào thẳng TK kho của dòng nhập. Ghi sổ CPM (SQL fn_stock_adjust_links) sinh lớp giá
// 'adjustment' mang voucher_id = CPM cho từng dòng nhập; ghi sổ, bỏ ghi sổ, đảo qua /api/vouchers/:id/*.
type Trx = Transaction<Database>;
type Auth = { sensitive: Set<string>; permissions: Set<string> };
const vnd = z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG);
const optText = (max: number) => z.string().max(max).nullable().optional();

export const landedCostInput = z.object({
  postingDate: S.dateIso, documentDate: S.dateIso.optional(), partyCode: z.string().min(1).nullable().optional(), description: optText(500),
  attachmentsCount: z.number().int().min(0).max(999).nullable().optional(), basis: z.enum(['value', 'quantity']),
  receiptVoucherIds: z.array(z.string().uuid()).min(1, 'Chọn ít nhất một phiếu nhập').max(100),
  costLines: z.array(z.object({ accountCode: z.string().min(1), amount: vnd, vatAmount: vnd.optional(), description: optText(500), partyCode: z.string().min(1).nullable().optional() }))
    .min(1, 'Nhập ít nhất một dòng chi phí').max(50),
  invoices: z.array(voucherInvoiceInput).max(50).optional(), // hóa đơn của dịch vụ vận chuyển... lên bảng kê mua vào
  idempotencyKey: z.string().max(100).optional(),
});
export type LandedCostInput = z.infer<typeof landedCostInput>;

export interface ReceiptLineDto { id: number; voucherId: string; voucherNo: string | null; postingDate: string; lineNo: number; itemCode: string; itemName: string; warehouseCode: string; quantity: string; value: string; accountCode: string }
export interface LandedCostDto extends S.VoucherDto {
  basis: 'value' | 'quantity'; receiptVoucherIds: string[];
  costLines: { accountCode: string; amount: string; vatAmount: string; description: string | null; partyCode: string | null }[];
  allocations: (ReceiptLineDto & { amount: string })[];
}

// Dòng nhập thường (chiều nhập, không chuyển kho, không đảo) của các chứng từ nhập; giá trị là giá mua: lớp nhập cộng điều chỉnh của hóa đơn mua, giảm giá hàng mua (không gồm chi phí mua đã phân bổ).
async function receiptLines(trx: Trx, where: ReturnType<typeof sql>): Promise<ReceiptLineDto[]> {
  return (await sql<ReceiptLineDto>`
    SELECT l.id::int AS id, v.id AS "voucherId", v.voucher_no AS "voucherNo", v.posting_date::text AS "postingDate", l.line_no AS "lineNo", i.code AS "itemCode", i.name AS "itemName", w.code AS "warehouseCode",
      trim_scale(m.quantity)::text AS quantity, a.code AS "accountCode",
      (SELECT coalesce(sum(c.value), 0) FROM stock_cost_layer c LEFT JOIN voucher cv ON cv.id = c.voucher_id
        WHERE c.tenant_id = m.tenant_id AND c.move_id = m.id AND (c.kind = 'receipt' OR (c.kind = 'adjustment' AND cv.voucher_type IN ('MH', 'TLM'))))::text AS value
    FROM stock_move m JOIN voucher v ON v.id = m.voucher_id JOIN voucher_item_line l ON l.tenant_id = m.tenant_id AND l.id = m.item_line_id
      JOIN item i ON i.id = m.item_id JOIN warehouse w ON w.id = m.warehouse_id JOIN account a ON a.id = coalesce(l.debit_account_id, l.account_id)
    WHERE m.direction = 'in' AND m.transfer_id IS NULL AND m.reversal_of IS NULL AND ${where}
    ORDER BY v.posting_date, v.seq_no, v.id, l.line_no`.execute(trx)).rows;
}

const RECEIPT_TYPES = sql`(v.voucher_type = 'MH' OR (v.voucher_type = 'PNK' AND v.stock_kind = 'purchase'))`;

async function build(trx: Trx, input: LandedCostInput, auth?: Auth) {
  const { regime } = await S.periodOf(trx, input.postingDate, 'CPM');
  const ids = [...new Set(input.receiptVoucherIds)];
  const vs = await trx.selectFrom('voucher').select(['id', 'voucher_type', 'stock_kind', 'state', 'posting_date', 'voucher_no']).where('id', 'in', ids).execute();
  for (const id of ids) {
    const v = vs.find((x) => x.id === id);
    if (!v || !(v.voucher_type === 'MH' || (v.voucher_type === 'PNK' && v.stock_kind === 'purchase'))) throw new AppError('RECEIPT_NOT_FOUND', 'Không tìm thấy phiếu nhập kho mua hàng hoặc hóa đơn mua hàng hóa đã chọn', 404);
    if (v.state !== 'posted') throw new AppError('RECEIPT_NOT_POSTED', `Chứng từ nhập ${v.voucher_no ?? '(nháp)'} chưa ghi sổ`, 409);
    if (v.posting_date > input.postingDate) throw new AppError('LANDED_COST_DATE_INVALID', `Ngày chi phí mua hàng trước ngày nhập kho của ${v.voucher_no}: ghi chi phí từ ngày nhập trở đi`, 409);
  }
  const lines = await receiptLines(trx, sql`v.id = ANY(${ids}::uuid[])`);
  if (!lines.length) throw new AppError('LANDED_COST_NO_RECEIPT_LINES', 'Các chứng từ đã chọn không có dòng nhập kho', 409);
  let alloc: Record<string, string>;
  try { alloc = allocateLandedCost(input.costLines.map((c) => c.amount), lines.map((l) => ({ id: String(l.id), qty: l.quantity, value: l.value })), input.basis); }
  catch (e) { if (e instanceof LandedCostError) throw new AppError(e.code, e.message, 409); throw e; }

  // Nợ TK kho theo (tài khoản, hàng, kho); Có từng dòng chi phí, thuế GTGT ngay sau dòng chi phí của nó (getLandedCost đọc lại theo thứ tự này).
  const lineSet: S.LineInput[] = [];
  for (const c of input.costLines) {
    const vat = D(c.vatAmount ?? '0');
    if (D(c.amount).isZero() && vat.isZero()) throw new AppError('VALIDATION', 'Dòng chi phí phải có số tiền', 400);
    const partyCode = c.partyCode ?? input.partyCode ?? undefined;
    lineSet.push({ accountCode: c.accountCode, debit: '0', credit: D(c.amount).plus(vat).toFixed(0), ...(partyCode && { partyCode }), description: c.description ?? input.description ?? 'Chi phí mua hàng' });
    if (vat.gt(0)) lineSet.push({ accountCode: '1331', debit: vat.toFixed(0), credit: '0', description: 'Thuế GTGT chi phí mua hàng' });
  }
  const inv = new Map<string, { accountCode: string; itemCode: string; warehouseCode: string; amount: Decimal }>();
  for (const l of lines) {
    const a = D(alloc[String(l.id)]!); if (a.isZero()) continue;
    const k = `${l.accountCode}|${l.itemCode}|${l.warehouseCode}`;
    inv.set(k, { accountCode: l.accountCode, itemCode: l.itemCode, warehouseCode: l.warehouseCode, amount: (inv.get(k)?.amount ?? D(0)).plus(a) });
  }
  for (const g of inv.values()) lineSet.push({ accountCode: g.accountCode, debit: g.amount.toFixed(0), credit: '0', itemCode: g.itemCode, warehouseCode: g.warehouseCode, description: input.description ?? 'Chi phí mua hàng phân bổ' });
  if (!inv.size) throw new AppError('LANDED_COST_EMPTY', 'Tổng chi phí phân bổ bằng 0', 400);

  const codes = [...new Set(lineSet.map((l) => l.accountCode))];
  const accs = await trx.selectFrom('account').select(['code', 'subledger_kind']).where('regime', '=', regime).where('code', 'in', codes).execute();
  for (const c of codes) if (!accs.some((a) => a.code === c)) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản "${c}" trong hệ thống tài khoản`, 404);
  if (auth) {
    if (!auth.permissions.has('stock_voucher.create')) throw new AppError('FORBIDDEN', 'Thiếu quyền stock_voucher.create', 403); // đổi giá trị tồn kho
    for (const a of accs) assertSensitive(auth, a); // giá trị kho cần view_cost, công nợ cần view_payable
  }
  const voucher: S.VoucherInput = { voucherType: 'CPM', postingDate: input.postingDate, documentDate: input.documentDate ?? input.postingDate, description: input.description ?? null,
    partyCode: input.partyCode ?? null, currencyCode: 'VND', attachmentsCount: input.attachmentsCount ?? null, lines: lineSet,
    ...(input.invoices?.length && { invoices: input.invoices }), ...(input.idempotencyKey && { idempotencyKey: input.idempotencyKey }) };
  const rows = (tenantId: string, voucherId: string) => lines.map((l) => ({ tenant_id: tenantId, voucher_id: voucherId, receipt_line_id: l.id, receipt_voucher_id: l.voucherId, receipt_line_no: l.lineNo, amount: alloc[String(l.id)]!, basis: input.basis }));
  return { voucher, rows };
}

export async function getLandedCost(trx: Trx, id: string): Promise<LandedCostDto> {
  const v = await S.getVoucher(trx, id);
  if (v.voucherType !== 'CPM') throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ chi phí mua hàng', 404);
  const src = v.reversalOfId ?? id; // chứng từ đảo không có phân bổ riêng: hiện phân bổ của chứng từ gốc
  const al = await trx.selectFrom('landed_cost_alloc').select(['id', 'receipt_line_id', 'receipt_voucher_id', 'receipt_line_no', 'amount', 'basis']).where('voucher_id', '=', src).orderBy('id').execute();
  const live = al.some((a) => a.receipt_line_id !== null) ? await receiptLines(trx, sql`l.id = ANY(${al.flatMap((a) => (a.receipt_line_id === null ? [] : [a.receipt_line_id]))}::bigint[])`) : [];
  // Phiếu nhập đã bỏ ghi sổ (không còn phát sinh nhập) hoặc đã sửa nháp (dòng cũ bị xóa, receipt_line_id NULL): chỉ còn chứng từ và số dòng đã chụp.
  const rv = new Map((al.length ? await trx.selectFrom('voucher').select(['id', 'voucher_no', 'posting_date']).where('id', 'in', [...new Set(al.map((a) => a.receipt_voucher_id))]).execute() : []).map((r) => [r.id, r]));
  const lines = al.map((a): ReceiptLineDto => live.find((l) => l.id === a.receipt_line_id) ?? { id: a.receipt_line_id ?? -a.id, voucherId: a.receipt_voucher_id, voucherNo: rv.get(a.receipt_voucher_id)?.voucher_no ?? null,
    postingDate: String(rv.get(a.receipt_voucher_id)?.posting_date ?? ''), lineNo: a.receipt_line_no, itemCode: '', itemName: '', warehouseCode: '', quantity: '0', value: '0', accountCode: '' });
  const costLines: LandedCostDto['costLines'] = [];
  const base = v.reversalOfId ? await S.getVoucher(trx, src) : v;
  base.lines.forEach((l, i) => {
    if (D(l.credit).isZero()) return;
    const next = base.lines[i + 1]; const vat = next && next.accountCode === '1331' && D(next.debit).gt(0) ? next.debit : '0';
    costLines.push({ accountCode: l.accountCode, amount: D(l.credit).minus(vat).toFixed(0), vatAmount: vat, description: l.description ?? null, partyCode: l.partyCode ?? null });
  });
  return { ...v, basis: (al[0]?.basis ?? 'value') as LandedCostDto['basis'], receiptVoucherIds: [...new Set(lines.map((l) => l.voucherId))], costLines,
    allocations: lines.map((l, i) => ({ ...l, amount: al[i]!.amount })) };
}

type Ctx = { tenantId: string; userId: string; auth?: Auth };
export async function createLandedCost(trx: Trx, ctx: Ctx, input: LandedCostInput): Promise<LandedCostDto> {
  if (input.idempotencyKey) {
    const existing = await trx.selectFrom('voucher').select('id').where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
    if (existing) return getLandedCost(trx, existing.id);
  }
  const b = await build(trx, input, ctx.auth);
  const v = await S.createLandedCostVoucher(trx, ctx, b.voucher);
  if (!(await trx.selectFrom('landed_cost_alloc').select('id').where('voucher_id', '=', v.id).limit(1).executeTakeFirst())) // thua cuộc đua idempotency: giao dịch thắng đã ghi
    await trx.insertInto('landed_cost_alloc').values(b.rows(ctx.tenantId, v.id)).execute();
  return getLandedCost(trx, v.id);
}
export async function updateLandedCost(trx: Trx, ctx: Ctx, id: string, version: number, input: LandedCostInput): Promise<LandedCostDto> {
  const cur = await trx.selectFrom('voucher').select('voucher_type').where('id', '=', id).executeTakeFirst();
  if (cur?.voucher_type !== 'CPM') throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ chi phí mua hàng', 404);
  const b = await build(trx, input, ctx.auth);
  await S.updateLandedCostDraft(trx, id, version, b.voucher);
  await trx.deleteFrom('landed_cost_alloc').where('voucher_id', '=', id).execute();
  await trx.insertInto('landed_cost_alloc').values(b.rows(ctx.tenantId, id)).execute();
  return getLandedCost(trx, id);
}

const routes: FastifyPluginAsyncZod = async (app) => {
  const ctx = (req: { auth: { tenantId: string | null; userId: string; sensitive: Set<string>; permissions: Set<string> } | null }) => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId, auth: req.auth! });
  const idParam = z.object({ id: z.string().uuid() });
  // Chứng từ nhập (PNK mua hàng, MH) đã ghi sổ trong khoảng ngày kèm dòng nhập, để chọn và xem trước phân bổ.
  app.get('/api/landed-costs/receipts', { preHandler: app.requirePermission('stock_voucher.view'), schema: { querystring: z.object({ from: S.dateIso, to: S.dateIso }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      if (!req.auth!.sensitive.has('view_cost')) throw new AppError('FORBIDDEN', 'Cần quyền xem giá vốn, giá trị tồn kho (view_cost)', 403);
      const lines = await receiptLines(trx, sql`${RECEIPT_TYPES} AND v.state = 'posted' AND v.posting_date BETWEEN ${req.query.from}::date AND ${req.query.to}::date`);
      const meta = new Map((lines.length ? await trx.selectFrom('voucher as v').leftJoin('party as p', 'p.id', 'v.party_id').select(['v.id', 'v.voucher_type', 'p.name']).where('v.id', 'in', [...new Set(lines.map((l) => l.voucherId))]).execute() : []).map((r) => [r.id, r]));
      const out = new Map<string, { id: string; voucherType: string; voucherNo: string | null; postingDate: string; partyName: string | null; value: string; lines: ReceiptLineDto[] }>();
      for (const l of lines) {
        const m = meta.get(l.voucherId)!;
        const r = out.get(l.voucherId) ?? { id: l.voucherId, voucherType: m.voucher_type, voucherNo: l.voucherNo, postingDate: l.postingDate, partyName: m.name, value: '0', lines: [] };
        r.lines.push(l); r.value = sum(r.lines.map((x) => x.value)).toFixed(0); out.set(l.voucherId, r);
      }
      return [...out.values()].slice(0, 500);
    }, READ_SNAPSHOT));
  app.post('/api/landed-costs', { preHandler: app.requirePermission('voucher.create'), schema: { body: landedCostInput.extend({ autoPost: z.boolean().optional() }) } }, async (req, reply) => {
    if (req.body.autoPost && !(req.auth!.permissions.has('voucher.post') && req.auth!.permissions.has('stock_voucher.post'))) throw new AppError('FORBIDDEN', 'Thiếu quyền voucher.post, stock_voucher.post', 403);
    const { autoPost, ...input } = req.body;
    const tenantId = req.auth!.tenantId!;
    const dto = await app.withOverride(req, async (trx) => {
      const d = await createLandedCost(trx, ctx(req), input);
      if (!(autoPost && d.state === 'draft' && d.version === 1)) return d;
      await postWithCashCheck(trx, tenantId, d.id);
      return getLandedCost(trx, d.id);
    });
    if (dto.state === 'posted') notifyRecompute(app, tenantId);
    return reply.status(201).send(dto);
  });
  app.put('/api/landed-costs/:id', { preHandler: app.requirePermission('voucher.update'), schema: { params: idParam, body: landedCostInput.extend({ version: z.number().int() }) } }, async (req) => {
    const { version, ...input } = req.body;
    return app.withOverride(req, async (trx) => { await requireStockPerm(trx, req.auth!, req.params.id, 'stock_voucher.update'); return updateLandedCost(trx, ctx(req), req.params.id, version, input); });
  });
  app.get('/api/landed-costs/:id', { preHandler: app.requirePermission('voucher.view'), schema: { params: idParam } }, async (req) => app.withTenant(req, async (trx) => {
    await requireStockPerm(trx, req.auth!, req.params.id, 'stock_voucher.view');
    const d = await getLandedCost(trx, req.params.id);
    await assertVoucherSensitive(trx, req.auth!, d);
    return d;
  }));
};
export default routes;
