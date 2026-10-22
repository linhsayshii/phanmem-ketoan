import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Transaction } from 'kysely';
import { READ_SNAPSHOT, type Database } from '@kt/db';
import { voucherTypeDef } from '@kt/domain';
import * as S from './vouchers.service.js';
import { notifyRecompute } from './notifyRecompute.js';
import { AppError } from '../../plugins/errors.js';
import { stockNegativeWarnings } from '../inventory/stockMoves.js';
import { postWithCashCheck, reverseWithCashCheck, unpostWithCashCheck } from '../cash/books.js';
import { redactCost } from '../invoices/sales.js';
import { formNoFor, voucherFormFor } from '../reporting/print/forms.js';
import { renderCashVoucherHtml, type BankInfo } from '../reporting/print/cashVoucherHtml.js';
import { renderPdf } from '../reporting/print/pdf.js';
import { renderVoucherHtml } from '../reporting/print/voucherHtml.js';
import { assertSensitive } from '../reporting/ledgers.js';

const idParam = z.object({ id: z.string().uuid() });
// Sửa chứng từ đã ghi sổ: phải có diễn giải hoặc ít nhất một dòng cần sửa (thân {} hay chỉ { version } không đổi gì).
const metaBody = S.metaInput.extend({ version: z.number().int() }).refine((b) => b.description !== undefined || !!b.lines?.length, 'Không có nội dung cần sửa');

// Tài khoản ngân hàng của công ty (tiêu đề chứng từ) và của đối tượng, cho Giấy báo và Ủy nhiệm chi.
async function bankInfos(trx: Transaction<Database>, voucherId: string): Promise<{ own: BankInfo | null; party: BankInfo | null }> {
  const info = (r: { account_no: string; account_name: string | null; branch: string | null; bank_name: string } | undefined): BankInfo | null =>
    r ? { accountNo: r.account_no, accountName: r.account_name, bankName: r.bank_name, branch: r.branch } : null;
  const own = await trx.selectFrom('voucher as v').innerJoin('bank_account as a', 'a.id', 'v.bank_account_id').innerJoin('bank as b', 'b.id', 'a.bank_id')
    .select(['a.account_no', 'a.account_name', 'a.branch', 'b.name as bank_name']).where('v.id', '=', voucherId).executeTakeFirst();
  const party = await trx.selectFrom('voucher as v').innerJoin('party_bank_account as p', 'p.id', 'v.party_bank_account_id')
    .select(['p.account_no', 'p.account_name', 'p.branch', 'p.bank_name']).where('v.id', '=', voucherId).executeTakeFirst();
  return { own: info(own), party: info(party) };
}

type Trx = Transaction<Database>;
// Loại chứng từ phát sinh kho hoặc đổi giá trị kho: phiếu kho (module inventory), hóa đơn mua hàng hóa, trả lại hàng mua mang dòng hàng nhập, xuất kho; chi phí mua hàng phân bổ vào giá nhập.
const createsStockMoves = (type: string) => voucherTypeDef(type)?.module === 'inventory' || type === 'MH' || type === 'TLM' || type === 'BH' || type === 'TLB' || type === 'CPM';
type Auth = NonNullable<FastifyRequest['auth']>;
// Chứng từ loại kho (module inventory) cần thêm quyền stock_voucher.*: quyền voucher.* chung chỉ mở chứng từ ngoài kho.
export async function requireStockPerm(trx: Trx, auth: Auth, id: string, perm: string) {
  const r = await trx.selectFrom('voucher').select('voucher_type').where('id', '=', id).executeTakeFirst();
  const stock = r && (voucherTypeDef(r.voucher_type)?.module === 'inventory' || r.voucher_type === 'CPM' // MH, TLM mang dòng hàng nhập, xuất kho khi có hàng hóa; CPM đổi giá nhập kho
    || ((r.voucher_type === 'MH' || r.voucher_type === 'TLM' || r.voucher_type === 'BH' || r.voucher_type === 'TLB') && !!(await trx.selectFrom('voucher_item_line').select('id').where('voucher_id', '=', id).where('item_id', 'is not', null).limit(1).executeTakeFirst())));
  if (stock && !auth.permissions.has(perm)) throw new AppError('FORBIDDEN', `Thiếu quyền ${perm}`, 403);
}
export async function withStockWarnings<T extends { warnings?: unknown[] }>(trx: Trx, tenantId: string, dto: T, voucherId: string): Promise<T> {
  const w = await stockNegativeWarnings(trx, tenantId, voucherId);
  return w.length ? { ...dto, warnings: [...(dto.warnings ?? []), ...w] } : dto;
}
// Số liệu theo dòng chỉ trả khi cờ nhạy cảm (công nợ, giá vốn) che từng tài khoản cho phép.
export async function assertVoucherSensitive(trx: Trx, auth: Auth, v: { id: string; lines: { accountCode: string }[] }) {
  if (!v.lines.length) return;
  const { regime } = await trx.selectFrom('voucher as v').innerJoin('fiscal_period as p', 'p.fiscal_year', 'v.fiscal_year').select('p.regime').where('v.id', '=', v.id).limit(1).executeTakeFirstOrThrow();
  const accs = await trx.selectFrom('account').select(['code', 'subledger_kind']).where('regime', '=', regime).where('code', 'in', [...new Set(v.lines.map((l) => l.accountCode))]).execute();
  for (const a of accs) assertSensitive(auth, a);
}

const routes: FastifyPluginAsyncZod = async (app) => {
  // auth đi kèm để kiểm quyền đối trừ và cờ nhạy cảm của kế hoạch đối trừ trên dòng (settle).
  const ctx = (req: FastifyRequest) => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId, auth: req.auth! });

  app.get('/api/voucher-types', { preHandler: app.requireAuth }, async (req) => app.withTenant(req, (trx) => trx.selectFrom('voucher_type').selectAll().where('is_active', '=', true).orderBy('code').execute()));

  app.get('/api/vouchers', { preHandler: app.requirePermission('voucher.view'), schema: { querystring: z.object({ type: z.string().optional(), from: S.dateIso.optional(), to: S.dateIso.optional(),
      state: z.enum(['draft', 'posted', 'reversed', 'cancelled']).optional(), q: z.string().optional(), partyCode: z.string().optional(), page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(500).default(50) }) } },
    async (req) => app.withTenant(req, async (trx) => {
      const out = await S.listVouchers(trx, req.query);
      // phiếu kho: tổng tiền là giá trị tồn kho, che khi thiếu view_cost (không quét dòng từng phiếu)
      if (!req.auth!.sensitive.has('view_cost')) out.rows = out.rows.map((r) => (createsStockMoves(r.voucherType) ? { ...r, totalDebit: null as never } : r));
      return out;
    }));
  app.get('/api/vouchers/:id', { preHandler: app.requirePermission('voucher.view'), schema: { params: idParam } }, async (req) => app.withTenant(req, async (trx) => {
    await requireStockPerm(trx, req.auth!, req.params.id, 'stock_voucher.view');
    const v = await S.getVoucher(trx, req.params.id);
    await assertVoucherSensitive(trx, req.auth!, v);
    return v;
  }));

  app.get('/api/vouchers/:id/print', { preHandler: app.requirePermission('voucher.print'), schema: { params: idParam, querystring: z.object({ format: z.enum(['html', 'pdf']).default('html'), form: z.string().default('default') }) } }, async (req, reply) => {
    const { html, v, form } = await app.withTenant(req, async (trx) => {
      const v = await S.getVoucher(trx, req.params.id);
      await assertVoucherSensitive(trx, req.auth!, v); // in không được lộ dòng công nợ, giá vốn mà GET chứng từ chặn
      // Mẫu in hợp lệ lấy từ cấu hình loại chứng từ; 'default' là mẫu đầu của loại, loại không có mẫu riêng (Phiếu kế toán) in phiếu kế toán.
      if (voucherTypeDef(v.voucherType)?.module === 'inventory') throw new AppError('PRINT_FORM_NOT_READY', 'Mẫu in phiếu kho chưa có', 409); // mẫu 01-VT, 02-VT làm ở Task 19
      const allowed = voucherTypeDef(v.voucherType)?.printForms ?? [];
      const form = req.query.form === 'default' ? allowed[0] : req.query.form;
      if (createsStockMoves(v.voucherType) && (form === '01-VT' || form === '02-VT')) throw new AppError('PRINT_FORM_NOT_READY', 'Mẫu in phiếu kho chưa có', 409);
      if (form !== undefined && !allowed.includes(form)) throw new AppError('PRINT_FORM_INVALID', `Mẫu in "${req.query.form}" không dùng được cho chứng từ loại ${v.voucherType}`, 400);
      const t = await trx.selectFrom('tenant').selectAll().where('id', '=', req.auth!.tenantId!).executeTakeFirstOrThrow();
      // chế độ kế toán gắn với năm tài chính của chứng từ (một công ty có thể giữ nhiều chế độ)
      const { regime } = await trx.selectFrom('voucher as v').innerJoin('fiscal_period as p', 'p.fiscal_year', 'v.fiscal_year').select('p.regime').where('v.id', '=', v.id).executeTakeFirstOrThrow();
      const f = form ? voucherFormFor(regime, form) : formNoFor(regime, 'PKT');
      const c = { name: t.name, address: t.address, taxCode: t.tax_code, legalRep: t.legal_rep, chiefAccountant: t.chief_accountant, formNo: f?.formNo ?? '', issuedBy: f?.issuedBy ?? '' };
      if (!form) return { v, form, html: renderVoucherHtml(v, c) };
      const banks = form === 'giay-bao' || form === 'unc' ? await bankInfos(trx, v.id) : {};
      // loại sổ chi tiết của tài khoản (tìm dòng quỹ/ngân hàng) và tên tiền ngoại tệ, cho số tiền trên phiếu
      const kinds = Object.fromEntries((await trx.selectFrom('account').select(['code', 'subledger_kind']).where('regime', '=', regime).where('code', 'in', [...new Set(v.lines.map((l) => l.accountCode))]).execute()).map((a) => [a.code, a.subledger_kind]));
      const currencyName = v.currencyCode === 'VND' ? null : (await trx.selectFrom('currency').select('name').where('code', '=', v.currencyCode).executeTakeFirst())?.name;
      return { v, form, html: renderCashVoucherHtml(v, c, { form, regime, kinds, currencyName, ...banks }) };
    }, READ_SNAPSHOT);
    if (req.query.format === 'html') return reply.type('text/html; charset=utf-8').send(html);
    // số chứng từ lấy từ tiền tố/hậu tố người dùng cấu hình nên phải mã hóa (RFC 5987), không đưa thẳng vào tiêu đề
    return reply.type('application/pdf').header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(`${v.voucherNo ?? 'phieu-ke-toan'}${form === 'unc' ? '-unc' : ''}.pdf`)}`).send(await renderPdf(html));
  });

  app.post('/api/vouchers', { preHandler: app.requirePermission('voucher.create'), schema: { body: S.voucherInput.extend({ autoPost: z.boolean().optional() }) } }, async (req, reply) => {
    if (req.body.autoPost && !req.auth!.permissions.has('voucher.post')) throw new AppError('FORBIDDEN', 'Thiếu quyền voucher.post', 403);
    const { autoPost, ...input } = req.body;
    // Gửi lại cùng idempotencyKey trả đúng chứng từ cũ, không ghi sổ lại: chỉ ghi sổ chứng từ vừa tạo (nháp, version 1).
    // Chứng từ đã ghi sổ rồi bỏ ghi sổ có version >= 3 nên không bị ghi sổ lại bởi một yêu cầu gửi lại.
    const dto = await app.withOverride(req, async (trx) => {
      const v = await S.createVoucher(trx, ctx(req), input);
      return redactCost(trx, req.auth!, autoPost && v.state === 'draft' && v.version === 1 ? await postWithCashCheck(trx, req.auth!.tenantId!, v.id) : v);
    });
    if (dto.state === 'posted') notifyRecompute(app, req.auth!.tenantId!);
    return reply.status(201).send(dto);
  });

  app.put('/api/vouchers/:id', { preHandler: app.requirePermission('voucher.update'), schema: { params: idParam, body: z.union([S.voucherInput.extend({ version: z.number().int() }), metaBody]) } }, async (req) => {
    const { version, ...input } = req.body;
    return app.withOverride(req, async (trx) => redactCost(trx, req.auth!, 'voucherType' in input ? await S.updateDraft(trx, req.params.id, version, input, req.auth!) : await S.updatePostedMeta(trx, req.params.id, version, input)));
  });

  app.post('/api/vouchers/:id/post', { preHandler: app.requirePermission('voucher.post'), schema: { params: idParam } }, async (req) => {
    const dto = await app.withOverride(req, async (trx) => { await requireStockPerm(trx, req.auth!, req.params.id, 'stock_voucher.post'); const d = await postWithCashCheck(trx, req.auth!.tenantId!, req.params.id); return redactCost(trx, req.auth!, await withStockWarnings(trx, req.auth!.tenantId!, d, d.id)); }); notifyRecompute(app, req.auth!.tenantId!); return dto; });
  // Thứ tự chứng từ kho trong ngày (chỉ nháp): động cơ giá vốn sắp theo (ngày, day_order, số thứ tự).
  app.put('/api/vouchers/:id/day-order', { preHandler: app.requirePermission('stock_voucher.update'), schema: { params: idParam, body: z.object({ dayOrder: z.number().int().min(0).max(1000000) }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const v = await trx.selectFrom('voucher').select(['voucher_type', 'state']).where('id', '=', req.params.id).executeTakeFirst();
      if (!v) throw new AppError('VOUCHER_NOT_FOUND', 'Không có chứng từ', 404);
      if (!createsStockMoves(v.voucher_type) || v.state !== 'draft') throw new AppError('DAY_ORDER_NOT_ALLOWED', 'Chỉ đặt thứ tự trong ngày cho phiếu kho nháp', 409);
      await trx.updateTable('voucher').set({ day_order: req.body.dayOrder }).where('id', '=', req.params.id).execute();
      return { id: req.params.id, dayOrder: req.body.dayOrder };
    }));
  app.post('/api/vouchers/:id/unpost', { preHandler: app.requirePermission('voucher.unpost'), schema: { params: idParam } }, async (req) => {
    if (!req.auth!.permissions.has('voucher.edit_posted')) throw new AppError('FORBIDDEN', 'Thiếu quyền sửa sau ghi sổ', 403);
    const dto = await app.withTenant(req, async (trx) => { await requireStockPerm(trx, req.auth!, req.params.id, 'stock_voucher.post'); return redactCost(trx, req.auth!, await unpostWithCashCheck(trx, req.auth!.tenantId!, req.params.id)); }); notifyRecompute(app, req.auth!.tenantId!); return dto; });
  app.post('/api/vouchers/:id/reverse', { preHandler: app.requirePermission('voucher.post'), schema: { params: idParam, body: z.object({ postingDate: S.dateIso, description: z.string().optional() }) } }, async (req, reply) => {
    // Chứng từ hệ thống sinh (XQ, KC, DK...) chỉ đảo qua chức năng đã sinh ra nó (chạy lại); các bộ sinh gọi S.reverseVoucher trực tiếp nên không bị chặn.
    const dto = await app.withOverride(req, async (trx) => { await requireStockPerm(trx, req.auth!, req.params.id, 'stock_voucher.post'); await S.assertNotSystemGenerated(trx, req.params.id); const d = await reverseWithCashCheck(trx, req.auth!.tenantId!, req.params.id, req.body); return redactCost(trx, req.auth!, await withStockWarnings(trx, req.auth!.tenantId!, d, d.id)); });
    notifyRecompute(app, req.auth!.tenantId!); return reply.status(201).send(dto); });
  app.post('/api/vouchers/:id/discard', { preHandler: app.requirePermission('voucher.delete'), schema: { params: idParam } }, async (req) => app.withTenant(req, async (trx) => { await requireStockPerm(trx, req.auth!, req.params.id, 'stock_voucher.delete'); return redactCost(trx, req.auth!, await S.discardVoucher(trx, req.params.id)); }));
  app.post('/api/vouchers/:id/duplicate', { preHandler: app.requirePermission('voucher.create'), schema: { params: idParam, body: z.object({ postingDate: S.dateIso }) } }, async (req, reply) =>
    reply.status(201).send(await app.withOverride(req, async (trx) => redactCost(trx, req.auth!, await S.duplicateVoucher(trx, ctx(req), req.params.id, req.body.postingDate)))));
  app.delete('/api/vouchers/:id', { preHandler: app.requirePermission('voucher.delete'), schema: { params: idParam } }, async (req, reply) => { await app.withTenant(req, (trx) => S.deleteDraft(trx, req.params.id)); return reply.status(204).send(); });
};
export default routes;
