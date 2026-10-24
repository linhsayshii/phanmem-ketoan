import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { READ_SNAPSHOT, type Database } from '@kt/db';
import { D, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { postWithCashCheck } from '../cash/books.js';
import { MAX_INVOICE_XML_BYTES, parseInvoiceXml, stripBom } from '../inbound/parseXml.js';
import { storeInbound } from '../inbound/store.js';
import { createInvoice, type InvoiceInput } from '../invoices/service.js';
import { createVoucher } from '../ledger/vouchers.service.js';
import { notifyRecompute } from '../ledger/notifyRecompute.js';
import { dateIso } from '../master/catalogs.js';
import { createApiKey, createKeyInput, listApiKeys, revokeApiKey } from './apiKeys.js';
import { extAuthHook, need } from './auth.js';

type Trx = Transaction<Database>;
const idParam = z.object({ id: z.string().uuid() });
const vnToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

// Quản lý khóa (phiên đăng nhập, quyền api_key.manage). Khóa đầy đủ chỉ trả một lần khi tạo.
const keyRoutes: FastifyPluginAsyncZod = async (app) => {
  const manage = { preHandler: app.requirePermission('api_key.manage') };
  app.get('/api/api-keys', manage, async (req) => app.withTenant(req, (trx) => listApiKeys(trx), READ_SNAPSHOT));
  app.post('/api/api-keys', { ...manage, schema: { body: createKeyInput } }, async (req, reply) =>
    reply.status(201).send(await app.withTenant(req, (trx) => createApiKey(trx, { tenantId: req.auth!.tenantId!, userId: req.auth!.userId }, req.body))));
  app.post('/api/api-keys/:id/revoke', { ...manage, schema: { params: idParam } }, async (req) => {
    await app.withTenant(req, (trx) => revokeApiKey(trx, req.params.id));
    return { ok: true };
  });
};

// ---- API ngoài /api/ext/v1 ----
const qtyRe = /^(?!0+(\.0+)?$)\d{1,12}(\.\d{1,4})?$/;
const priceRe = /^\d{1,16}(\.\d{1,4})?$/;
const salesBody = z.object({
  externalId: z.string().regex(/^[A-Za-z0-9._\-/]{1,30}$/, 'externalId tối đa 30 ký tự gồm chữ, số, . _ - /'),
  date: dateIso,
  customer: z.object({ code: z.string().min(1).max(50).optional(), taxCode: z.string().min(1).max(20).optional(), name: z.string().max(300).optional(), address: z.string().max(500).optional() }).default({}),
  warehouseCode: z.string().min(1).max(50).optional(),
  lines: z.array(z.object({
    itemCode: z.string().min(1).max(50), quantity: z.string().regex(qtyRe, 'Số lượng phải lớn hơn 0, tối đa 4 chữ số thập phân'), unitPrice: z.string().regex(priceRe, 'Đơn giá không hợp lệ'),
    uomCode: z.string().min(1).max(50).optional(), taxCode: z.string().min(1).max(50).optional(), discount: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG).optional(),
  })).min(1).max(500),
  payment: z.object({ method: z.enum(['cash', 'bank']), bankAccountCode: z.string().min(1).max(50).optional(), amount: z.string().regex(/^[1-9]\d{0,15}$/, VND_AMOUNT_MSG) }).optional(),
  einvoiceSeriesId: z.number().int().positive().optional(),
});
type SalesBody = z.infer<typeof salesBody>;

async function saleResult(trx: Trx, externalId: string) {
  const rows = await trx.selectFrom('voucher').select(['id', 'voucher_no', 'state', 'idempotency_key']).where('idempotency_key', 'in', [`ext:${externalId}`, `ext:${externalId}:pay`]).execute();
  const main = rows.find((r) => r.idempotency_key === `ext:${externalId}`);
  if (!main) return null;
  const pay = rows.find((r) => r.idempotency_key === `ext:${externalId}:pay`);
  return { voucherId: main.id, voucherNo: main.voucher_no, state: main.state, ...(pay && { paymentVoucherId: pay.id, paymentVoucherNo: pay.voucher_no }) };
}

async function resolveParty(trx: Trx, tenantId: string, c: SalesBody['customer']): Promise<string> {
  if (c.code) {
    const p = await trx.selectFrom('party').select('code').where('code', '=', c.code).executeTakeFirst();
    if (!p) throw new AppError('PARTY_NOT_FOUND', `Không có khách hàng mã "${c.code}"`, 404);
    return p.code;
  }
  if (c.taxCode) {
    const p = await trx.selectFrom('party').select('code').where('tax_code', '=', c.taxCode).where('is_customer', '=', true).orderBy('created_at').limit(1).executeTakeFirst();
    if (!p) throw new AppError('PARTY_NOT_FOUND', `Không có khách hàng mã số thuế "${c.taxCode}"`, 404);
    return p.code;
  }
  await trx.insertInto('party').values({ tenant_id: tenantId, code: 'KHACHLE', name: 'Khách lẻ', is_customer: true }).onConflict((oc) => oc.columns(['tenant_id', 'code']).doNothing()).execute();
  return 'KHACHLE';
}

async function createSale(trx: Trx, ctx: { tenantId: string; userId: string; auth: { permissions: Set<string>; sensitive: Set<string> } }, key: { postSales: boolean; defaultWarehouseCode: string | null }, b: SalesBody) {
  const wantsPost = key.postSales;
  if (b.payment && !wantsPost) throw new AppError('PAYMENT_NEEDS_POST', 'Thanh toán chỉ dùng với khóa tự ghi sổ (hóa đơn phải ghi sổ mới có công nợ để đối trừ)', 400);
  if (wantsPost && !ctx.auth.permissions.has('voucher.post')) throw new AppError('FORBIDDEN', 'Người dùng của khóa không còn quyền voucher.post', 403);
  if (b.payment?.method === 'bank' && !b.payment.bankAccountCode) throw new AppError('VALIDATION', 'Thanh toán chuyển khoản cần bankAccountCode (số tài khoản ngân hàng)', 400);

  const partyCode = await resolveParty(trx, ctx.tenantId, b.customer);
  const codes = [...new Set(b.lines.map((l) => l.itemCode))];
  const items = await trx.selectFrom('item as i').innerJoin('uom as u', 'u.id', 'i.base_uom_id').leftJoin('account as a', 'a.id', 'i.revenue_account_id')
    .select(['i.code', 'i.name', 'i.kind', 'i.is_active', 'u.code as uom_code', 'i.default_tax_code', 'a.code as revenue_code']).where('i.code', 'in', codes).execute();
  const byCode = new Map(items.map((i) => [i.code, i]));
  for (const c of codes) if (!byCode.get(c)?.is_active) throw new AppError('ITEM_NOT_FOUND', `Không có mặt hàng mã "${c}"`, 404);
  const goods = b.lines.some((l) => byCode.get(l.itemCode)!.kind !== 'service');
  const warehouseCode = b.warehouseCode ?? key.defaultWarehouseCode ?? undefined;
  if (goods && !warehouseCode) throw new AppError('WAREHOUSE_REQUIRED', 'Có mặt hàng hàng hóa: cần warehouseCode hoặc kho mặc định của khóa', 400);

  const voucherType = goods ? 'BH' : 'HDB';
  const rows = b.lines.map((l, k) => {
    const it = byCode.get(l.itemCode)!;
    const taxCode = l.taxCode ?? it.default_tax_code;
    const base = { quantity: l.quantity, unitPrice: l.unitPrice, uomCode: l.uomCode ?? it.uom_code, amountCurrency: D(l.quantity).times(l.unitPrice).toFixed(0), discountCurrency: l.discount ?? '0', taxCodes: taxCode ? [taxCode] : [] };
    if (!goods) {
      if (!it.revenue_code) throw new AppError('VALIDATION', `Dòng ${k + 1}: mặt hàng ${it.code} chưa có tài khoản doanh thu`, 400);
      return { ...base, accountCode: it.revenue_code, description: it.name };
    }
    return it.kind === 'service' ? { ...base, itemCode: it.code } : { ...base, itemCode: it.code, warehouseCode: warehouseCode! };
  });

  // Nhóm kê khai đầu hóa đơn theo thuế suất của dòng đầu; nhóm từng dòng do createInvoice chọn lại.
  const firstTax = rows[0]!.taxCodes[0];
  const tax = firstTax ? await trx.selectFrom('tax_code').select(['code', 'rate']).where('code', '=', firstTax).executeTakeFirst() : undefined;
  if (firstTax && !tax) throw new AppError('LOOKUP_NOT_FOUND', `Không có mã thuế "${firstTax}"`, 404);
  const groups = await trx.selectFrom('invoice_group').select(['code', 'rate']).where('scope', '=', 'sale').orderBy('code').execute();
  const group = groups.find((g) => (tax?.rate == null ? g.rate === null : g.rate !== null && D(g.rate).eq(tax.rate))) ?? groups.find((g) => g.code === firstTax);
  if (!group) throw new AppError('INVOICE_GROUP_MISMATCH', 'Không có nhóm hóa đơn bán ra khớp thuế suất của dòng hàng đầu tiên', 400);

  const input: InvoiceInput = {
    voucherType, postingDate: b.date, documentDate: b.date, partyCode, currencyCode: 'VND', items: rows as InvoiceInput['items'], idempotencyKey: `ext:${b.externalId}`,
    invoice: { invoiceDate: b.date, invoiceGroupCode: group.code, ...(b.einvoiceSeriesId ? { einvoiceSeriesId: b.einvoiceSeriesId } : { invoiceNo: b.externalId }),
      ...(b.customer.name && { partyName: b.customer.name }), ...(b.customer.address && { partyAddress: b.customer.address }), ...(b.customer.taxCode && !b.customer.code && { partyTaxCode: b.customer.taxCode }) },
  };
  const inv = await createInvoice(trx, ctx, input);
  if (inv.state !== 'draft' || inv.version !== 1) return { created: false };
  if (wantsPost) await postWithCashCheck(trx, ctx.tenantId, inv.id);

  if (b.payment) {
    const open = (await sql<{ id: number; amount: string }>`SELECT o.id, o.amount::text FROM open_item o JOIN account a ON a.id = o.account_id WHERE o.voucher_id = ${inv.id}::uuid AND a.code LIKE '131%' AND o.amount > 0 ORDER BY o.id LIMIT 1`.execute(trx)).rows[0];
    if (!open) throw new AppError('NO_RECEIVABLE', 'Hóa đơn không phát sinh công nợ phải thu để đối trừ', 400);
    if (D(b.payment.amount).gt(open.amount)) throw new AppError('PAYMENT_EXCEEDS', `Số tiền thanh toán vượt giá trị hóa đơn (${D(open.amount).toFixed(0)})`, 400);
    let cashAccount = '1111'; let bankAccountNo: string | undefined;
    if (b.payment.method === 'bank') {
      const ba = await trx.selectFrom('bank_account').select(['account_no', 'gl_account_code']).where('account_no', '=', b.payment.bankAccountCode!).where('is_active', '=', true).executeTakeFirst();
      if (!ba) throw new AppError('BANK_ACCOUNT_NOT_FOUND', `Không có tài khoản ngân hàng "${b.payment.bankAccountCode}"`, 404);
      cashAccount = ba.gl_account_code; bankAccountNo = ba.account_no;
    }
    const amount = b.payment.amount;
    const pay = await createVoucher(trx, ctx, {
      voucherType: b.payment.method === 'cash' ? 'PT' : 'BC', postingDate: b.date, documentDate: b.date, description: `Thu tiền bán hàng ${b.externalId}`, partyCode, currencyCode: 'VND',
      purpose: 'thu_khach_hang', idempotencyKey: `ext:${b.externalId}:pay`, ...(bankAccountNo && { bankAccountNo }),
      lines: [{ accountCode: cashAccount, debit: amount, credit: '0', ...(bankAccountNo && { bankAccountNo }) }, { accountCode: '131', debit: '0', credit: amount, partyCode, settle: [{ openItemId: open.id, amount }] }],
    } as Parameters<typeof createVoucher>[2]);
    await postWithCashCheck(trx, ctx.tenantId, pay.id);
  }
  return { created: true, posted: wantsPost };
}

const extRoutes: FastifyPluginAsyncZod = async (app) => {
  app.decorateRequest('apiKey', null);
  app.addHook('onRequest', extAuthHook(app));

  app.get('/items', {
    preHandler: need('items.read', 'item.view'),
    schema: { querystring: z.object({ q: z.string().max(100).optional(), updatedSince: z.string().datetime({ offset: true }).optional(), after: z.string().max(50).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }) },
  }, async (req) => {
    const { q, updatedSince, after, limit } = req.query;
    const today = vnToday();
    const like = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const rows = await app.withTenant(req, async (trx) => (await sql<{ code: string; name: string; kind: string; uom_code: string; tax_code: string | null; tax_rate: string | null; barcode: string | null; sale_price: string | null }>`
      SELECT i.code, i.name, i.kind, u.code AS uom_code, i.default_tax_code AS tax_code, t.rate::text AS tax_rate, i.barcode, pr.price::text AS sale_price
      FROM item i JOIN uom u ON u.id = i.base_uom_id LEFT JOIN tax_code t ON t.code = i.default_tax_code
      LEFT JOIN LATERAL (SELECT l.price FROM price_list_line l JOIN price_list p ON p.id = l.price_list_id
        WHERE l.item_id = i.id AND l.uom_id = i.base_uom_id AND l.min_qty = 0 AND p.kind = 'sale' AND p.is_active AND p.party_group_id IS NULL AND p.currency_code = 'VND'
          AND p.valid_from <= ${today}::date AND (p.valid_to IS NULL OR p.valid_to >= ${today}::date) ORDER BY p.priority DESC, p.id LIMIT 1) pr ON true
      WHERE i.is_active
        ${like ? sql`AND (i.code ILIKE ${like} OR i.name ILIKE ${like} OR i.barcode = ${q!})` : sql``}
        ${after ? sql`AND i.code > ${after}` : sql``}
        ${updatedSince ? sql`AND (i.created_at >= ${updatedSince}::timestamptz OR EXISTS (SELECT 1 FROM audit_event ae WHERE ae.entity = 'item' AND ae.entity_id = i.id::text AND ae.ts >= ${updatedSince}::timestamptz))` : sql``}
      ORDER BY i.code LIMIT ${limit + 1}`.execute(trx)).rows, READ_SNAPSHOT);
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({ code: r.code, name: r.name, kind: r.kind, uomCode: r.uom_code, taxCode: r.tax_code, taxRate: r.tax_rate === null ? null : D(r.tax_rate).toString(), salePrice: r.sale_price === null ? null : D(r.sale_price).toString(), barcode: r.barcode })),
      next: rows.length > limit ? page[page.length - 1]!.code : null,
    };
  });

  app.get('/stock', {
    preHandler: need('stock.read', 'stock_voucher.view'),
    schema: { querystring: z.object({ warehouseCode: z.string().max(50).optional(), itemCode: z.string().max(50).optional(), date: dateIso.optional() }) },
  }, async (req) => {
    const { warehouseCode, itemCode, date } = req.query;
    const withValue = req.auth!.sensitive.has('view_cost') && !date; // giá trị tồn là giá hiện tại của các lớp giá vốn, không tính lùi theo ngày
    return app.withTenant(req, async (trx) => {
      const qty = (await sql<{ item_code: string; wh_code: string; qty: string }>`
        SELECT i.code AS item_code, w.code AS wh_code, sum(CASE WHEN m.direction = 'in' THEN m.quantity ELSE -m.quantity END)::text AS qty
        FROM stock_move m JOIN item i ON i.id = m.item_id JOIN warehouse w ON w.id = m.warehouse_id
        WHERE m.posting_date <= ${date ?? vnToday()}::date ${warehouseCode ? sql`AND w.code = ${warehouseCode}` : sql``} ${itemCode ? sql`AND i.code = ${itemCode}` : sql``}
        GROUP BY i.code, w.code ORDER BY i.code, w.code LIMIT 5000`.execute(trx)).rows;
      const val = new Map<string, string>();
      if (withValue) {
        const v = (await sql<{ item_code: string; wh_code: string; value: string }>`
          SELECT i.code AS item_code, w.code AS wh_code, sum(c.remaining_value)::text AS value FROM stock_cost_layer c JOIN item i ON i.id = c.item_id JOIN warehouse w ON w.id = c.warehouse_id
          WHERE true ${warehouseCode ? sql`AND w.code = ${warehouseCode}` : sql``} ${itemCode ? sql`AND i.code = ${itemCode}` : sql``} GROUP BY i.code, w.code`.execute(trx)).rows;
        for (const r of v) val.set(`${r.item_code}\u0000${r.wh_code}`, D(r.value).toString());
      }
      return { date: date ?? vnToday(), items: qty.map((r) => ({ itemCode: r.item_code, warehouseCode: r.wh_code, quantity: D(r.qty).toString(), ...(withValue && { value: val.get(`${r.item_code}\u0000${r.wh_code}`) ?? '0' }) })) };
    }, READ_SNAPSHOT);
  });

  app.post('/sales', { preHandler: need('sales.write', 'voucher.create'), schema: { body: salesBody } }, async (req, reply) => {
    const tenantId = req.auth!.tenantId!;
    const key = req.apiKey!;
    const out = await app.withOverride(req, async (trx) => {
      const prior = await saleResult(trx, req.body.externalId);
      if (prior) return { status: 200, body: prior, posted: false };
      const r = await createSale(trx, { tenantId, userId: req.auth!.userId, auth: req.auth! }, key, req.body);
      return { status: r.created ? 201 : 200, body: (await saleResult(trx, req.body.externalId))!, posted: !!r.created && !!r.posted };
    });
    if (out.posted) notifyRecompute(app, tenantId);
    return reply.status(out.status).send(out.body);
  });

  app.get('/sales/:externalId', { preHandler: need('sales.write', 'voucher.create'), schema: { params: z.object({ externalId: z.string().min(1).max(30) }) } }, async (req) => {
    const r = await app.withTenant(req, (trx) => saleResult(trx, req.params.externalId), READ_SNAPSHOT);
    if (!r) throw new AppError('SALE_NOT_FOUND', 'Không có đơn bán hàng với externalId này', 404);
    return r;
  });

  // Phân tích thân XML chỉ gắn trong plugin con này: các route khác của ứng dụng không nhận application/xml.
  await app.register(async (xml) => {
    xml.addContentTypeParser(['application/xml', 'text/xml'], { parseAs: 'string', bodyLimit: MAX_INVOICE_XML_BYTES }, (_req, body, done) => done(null, body));
    xml.post('/inbound-invoices', { bodyLimit: MAX_INVOICE_XML_BYTES, preHandler: need('inbound_invoice.write', 'inbound_invoice.create') }, async (req, reply) => {
      if (typeof req.body !== 'string' || !req.body.trim()) throw new AppError('VALIDATION', 'Thân yêu cầu phải là XML hóa đơn (Content-Type: application/xml)', 400);
      const text = stripBom(req.body);
      const parsed = parseInvoiceXml(text);
      const r = await app.withTenant(req, (trx) => storeInbound(trx, { tenantId: req.auth!.tenantId! }, text, 'api', { receivedBy: req.auth!.userId, apiKeyId: req.apiKey!.id, parsed }));
      return reply.status(r.status === 'new' ? 201 : 200).send({ id: r.id, status: r.status, ...(r.existing !== undefined && { existing: r.existing }) });
    });
  });
};

const routes: FastifyPluginAsyncZod = async (app) => {
  await app.register(keyRoutes);
  await app.register(extRoutes, { prefix: '/api/ext/v1' });
};
export default routes;
