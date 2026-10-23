import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { withTenant, type Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { dateIso } from '../master/catalogs.js';
import { assertReversible, finalizeIssue, loadDto, loadIssued, notFound, prepare, send, tctx, tryReverse, type EInvoiceCtx, type EInvoiceDto, type ProviderFactory, type Relation } from './issue.js';
import { providerFor, ProviderError, withProviderCtx } from './providers/index.js';

// Hóa đơn điều chỉnh, thay thế, hủy, trạng thái thanh toán (TT 91/2026/TT-BTC Điều 10). Điều chỉnh/thay thế là chứng từ bán mới phát hành hai pha như hóa đơn gốc
// (issue.ts: prepare/send/finalizeIssue); thay thế và hủy đảo chứng từ của hóa đơn gốc sau khi kết quả đã commit.
type Trx = Transaction<Database>;
type Db = Kysely<Database>;

const reason = z.string().trim().min(1).max(500);
const agreement = { agreementNo: z.string().trim().min(1).max(100).optional(), agreementDate: dateIso.optional() };
export const adjustInput = z.object({ voucherId: z.string().uuid(), adjust: z.enum(['increase', 'decrease', 'info']), reason, ...agreement, issueDate: dateIso.optional() });
export const replaceInput = z.object({ voucherId: z.string().uuid(), reason, ...agreement, issueDate: dateIso.optional() });
export const cancelInput = z.object({ reason, date: dateIso });

const ADJUST_TYPES = { increase: ['HDB', 'BH'], decrease: ['GGB', 'TLB'] } as const;
const STATUS_TEXT: Record<string, string> = { replaced: 'đã bị thay thế', cancelled: 'đã bị hủy' };

// Khóa hóa đơn gốc và kiểm còn hiệu lực. Hóa đơn ký hiệu C phải đã có mã của cơ quan thuế mới điều chỉnh/thay thế được (SInvoice INVOICE_HAS_CODE_APPROVED).
async function lockActive(trx: Trx, id: number, op: 'adjust' | 'replace' | 'cancel') {
  if (!(await trx.selectFrom('einvoice').select('id').where('id', '=', id).forUpdate().executeTakeFirst())) throw notFound();
  const o = await trx.selectFrom('einvoice as e').innerJoin('einvoice_series as s', 's.id', 'e.series_id').innerJoin('voucher as v', 'v.id', 'e.voucher_id')
    .select(['e.id', 'e.status', 'e.relation', 'e.adjusted', 'e.cqt_status', 'e.voucher_id', 'e.invoice_no', 's.serial', 'v.party_id']).where('e.id', '=', id).executeTakeFirstOrThrow();
  const name = `Hóa đơn ${o.serial} số ${o.invoice_no ?? '(chưa có số)'}`;
  if (o.status !== 'issued') throw new AppError('EINVOICE_NOT_ACTIVE', `${name} ${STATUS_TEXT[o.status] ?? 'chưa phát hành'}: chỉ điều chỉnh, thay thế, hủy hóa đơn đang hiệu lực`, 409);
  const busy = await trx.selectFrom('einvoice').select('id').where('original_id', '=', id).where('status', '=', 'sending').executeTakeFirst();
  if (busy) throw new AppError('EINVOICE_BUSY', `${name} đang có hóa đơn điều chỉnh/thay thế chờ kết quả từ nhà cung cấp: thử lại hoặc chờ đối soát`, 409);
  if (op !== 'cancel' && o.serial.startsWith('C') && o.cqt_status !== 'accepted')
    throw new AppError('EINVOICE_CQT_PENDING', `${name} chưa được cơ quan thuế cấp mã: tra mã của cơ quan thuế trước; cơ quan thuế không cấp mã thì hủy hóa đơn rồi lập lại`, 409);
  return { ...o, name };
}

export async function issueAdjustment(db: Db, ctx: EInvoiceCtx, originalId: number, input: z.infer<typeof adjustInput>, factory: ProviderFactory = providerFor): Promise<EInvoiceDto> {
  // QĐ 521: điều chỉnh thông tin không có chứng từ tiền; sai thông tin hành chính đi bằng 04/SS-HĐĐT, còn lại lập hóa đơn thay thế.
  if (input.adjust === 'info') throw new AppError('EINVOICE_ADJUST_INFO_UNSUPPORTED', 'Chưa hỗ trợ hóa đơn điều chỉnh thông tin: sai tên, địa chỉ (không sai mã số thuế, số tiền, thuế suất, hàng hóa) thì gửi Thông báo hóa đơn điện tử có sai sót (Mẫu số 04/SS-HĐĐT); sai khác thì lập hóa đơn thay thế', 400);
  const adjust = input.adjust;
  const p = await withTenant(db, tctx(ctx), async (trx) => {
    const o = await lockActive(trx, originalId, 'adjust');
    // Đã xử lý bằng thay thế thì các lần sau cũng thay thế (TT 91/2026 Điều 10 khoản 6 điểm a); điều chỉnh tiếp thì trỏ hóa đơn gốc.
    if (o.relation !== 'original') throw new AppError('EINVOICE_ADJUST_NOT_ALLOWED', o.relation === 'replacement'
      ? `${o.name} là hóa đơn thay thế: sai tiếp thì lập hóa đơn thay thế (TT 91/2026/TT-BTC Điều 10 khoản 6 điểm a)` : `${o.name} là hóa đơn điều chỉnh: lập điều chỉnh tiếp cho hóa đơn gốc`, 409);
    const v = await trx.selectFrom('voucher').select(['voucher_type', 'party_id']).where('id', '=', input.voucherId).executeTakeFirst();
    if (!v) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ', 404);
    if (!(ADJUST_TYPES[adjust] as readonly string[]).includes(v.voucher_type)) throw new AppError('EINVOICE_ADJUST_KIND', adjust === 'decrease'
      ? 'Điều chỉnh giảm lập bằng chứng từ giảm giá hàng bán hoặc trả lại hàng bán trỏ hóa đơn gốc' : 'Điều chỉnh tăng lập bằng hóa đơn bán hàng trỏ hóa đơn gốc', 400);
    if (v.party_id !== o.party_id) throw new AppError('EINVOICE_PARTY_MISMATCH', 'Chứng từ điều chỉnh phải cùng khách hàng với hóa đơn gốc', 409);
    const linked = await trx.selectFrom('voucher_invoice as i').innerJoin('voucher_invoice as g', 'g.id', 'i.adjusts_invoice_id').select('i.id')
      .where('i.voucher_id', '=', input.voucherId).where('g.voucher_id', '=', o.voucher_id).executeTakeFirst();
    if (!linked) throw new AppError('EINVOICE_ADJUST_MISMATCH', `Chứng từ điều chỉnh phải chọn hóa đơn gốc ${o.serial} số ${o.invoice_no} ở phần hóa đơn (hóa đơn được điều chỉnh)`, 409);
    const rel: Relation = { relation: 'adjustment', originalId, adjustKind: adjust, reason: input.reason, agreementNo: input.agreementNo, agreementDate: input.agreementDate };
    return prepare(trx, ctx, input.voucherId, input.issueDate, factory, rel);
  });
  const dto = await finalizeIssue(db, ctx, p.id, await send(db, ctx, p, factory, false));
  return p.warnings.length ? { ...dto, warnings: [...p.warnings, ...(dto.warnings ?? [])] } : dto;
}

export async function issueReplacement(db: Db, ctx: EInvoiceCtx, originalId: number, input: z.infer<typeof replaceInput>, factory: ProviderFactory = providerFor): Promise<EInvoiceDto> {
  const p = await withTenant(db, tctx(ctx), async (trx) => {
    const o = await lockActive(trx, originalId, 'replace');
    if (o.adjusted || o.relation === 'adjustment') throw new AppError('EINVOICE_ALREADY_ADJUSTED', `${o.name} đã xử lý bằng hóa đơn điều chỉnh: các lần sau tiếp tục lập hóa đơn điều chỉnh (TT 91/2026/TT-BTC Điều 10 khoản 6 điểm a)`, 409);
    const v = await trx.selectFrom('voucher').select(['voucher_type', 'posting_date']).where('id', '=', input.voucherId).executeTakeFirst();
    if (!v) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ', 404);
    if (v.voucher_type !== 'HDB' && v.voucher_type !== 'BH') throw new AppError('EINVOICE_REPLACE_KIND', 'Hóa đơn thay thế lập bằng hóa đơn bán hàng (ghi đúng toàn bộ nội dung mới)', 400);
    await assertReversible(trx, ctx, o.voucher_id, v.posting_date);
    const rel: Relation = { relation: 'replacement', originalId, reason: input.reason, agreementNo: input.agreementNo, agreementDate: input.agreementDate };
    return prepare(trx, ctx, input.voucherId, input.issueDate, factory, rel);
  });
  const dto = await finalizeIssue(db, ctx, p.id, await send(db, ctx, p, factory, false));
  return p.warnings.length ? { ...dto, warnings: [...p.warnings, ...(dto.warnings ?? [])] } : dto;
}

// Hủy: TT 91/2026/TT-BTC Điều 10 khoản 1 chỉ cho hóa đơn đã cấp mã (hoặc không mã đã gửi dữ liệu cho cơ quan thuế) xử lý bằng 04/SS-HĐĐT, điều chỉnh hoặc thay thế,
// không có hủy. Nên chỉ hủy hóa đơn ký hiệu C chưa được cấp mã, hoặc ký hiệu K (phần mềm không biết dữ liệu đã chuyển cơ quan thuế chưa; nhà cung cấp tự chặn).
export async function cancelEInvoice(db: Db, ctx: EInvoiceCtx, id: number, input: z.infer<typeof cancelInput>, factory: ProviderFactory = providerFor): Promise<EInvoiceDto> {
  const { ref, provider } = await withTenant(db, tctx(ctx), async (trx) => {
    const o = await lockActive(trx, id, 'cancel');
    if (o.relation !== 'original' || o.adjusted) throw new AppError('EINVOICE_CANCEL_NOT_ALLOWED', `${o.name}: chỉ hủy hóa đơn gốc chưa bị điều chỉnh`, 409);
    if (o.serial.startsWith('C') && o.cqt_status === 'accepted')
      throw new AppError('EINVOICE_CANCEL_NOT_ALLOWED', `${o.name} đã được cơ quan thuế cấp mã: không hủy được, lập hóa đơn điều chỉnh hoặc thay thế (TT 91/2026/TT-BTC Điều 10 khoản 1)`, 409);
    const r = await loadIssued(trx, id);
    if (!factory(r.provider).cancel) throw new AppError('PROVIDER_UNSUPPORTED', 'Nhà cung cấp hóa đơn điện tử chưa hỗ trợ hủy hóa đơn qua phần mềm', 409);
    await assertReversible(trx, ctx, o.voucher_id, input.date);
    return r;
  });
  try {
    await withProviderCtx(db, { tenantId: ctx.tenantId, userId: ctx.userId ?? null, providerId: provider.id, einvoiceId: id }, (c) => factory(provider).cancel!(c, ref, input.reason, input.date));
  } catch (e) {
    if (e instanceof ProviderError) throw new AppError(e.code, `Nhà cung cấp từ chối hủy hóa đơn: ${e.message}`, e.retriable ? 502 : 409);
    throw e;
  }
  await withTenant(db, tctx(ctx), (trx) => trx.updateTable('einvoice').set({ status: 'cancelled', needs_reversal: true }).where('id', '=', id).where('status', '=', 'issued').execute());
  const warnings = await tryReverse(db, ctx, id, input.date);
  const dto = await withTenant(db, tctx(ctx), (trx) => loadDto(trx, id));
  return warnings.length ? { ...dto, warnings } : dto;
}

// Trạng thái thanh toán: cờ hiển thị trên hóa đơn ở nhà cung cấp, không ảnh hưởng hiệu lực pháp lý. Nhà cung cấp không hỗ trợ thì chỉ lưu ở phần mềm.
export async function setPaid(db: Db, ctx: EInvoiceCtx, id: number, paid: boolean, factory: ProviderFactory = providerFor): Promise<EInvoiceDto> {
  const { ref, provider } = await withTenant(db, tctx(ctx), async (trx) => {
    const r = await loadIssued(trx, id);
    if (r.e.status !== 'issued') throw new AppError('EINVOICE_NOT_ACTIVE', 'Chỉ cập nhật trạng thái thanh toán của hóa đơn đang hiệu lực', 409);
    return r;
  });
  const p = factory(provider);
  if (p.setPaid) await withProviderCtx(db, { tenantId: ctx.tenantId, userId: ctx.userId ?? null, providerId: provider.id, einvoiceId: id }, (c) => p.setPaid!(c, ref, paid));
  return withTenant(db, tctx(ctx), async (trx) => {
    await trx.updateTable('einvoice').set({ paid }).where('id', '=', id).execute();
    return loadDto(trx, id);
  });
}

// Voucher của hóa đơn (để kiểm quyền kho trước khi đảo).
export const voucherOf = async (trx: Trx, id: number) => (await trx.selectFrom('einvoice').select('voucher_id').where('id', '=', id).executeTakeFirst())?.voucher_id;
export { reverseMarked } from './issue.js';
