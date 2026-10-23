import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import { withTenant, type Database } from '@kt/db';
import { formatVnDate, todayVn } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { reverseWithCashCheck } from '../cash/books.js';
import { dateIso } from '../master/catalogs.js';
import { finalizeIssue, loadDto, loadIssued, notFound, prepare, REVERSAL_PENDING, send, tctx, type EInvoiceCtx, type EInvoiceDto, type ProviderFactory, type Relation } from './issue.js';
import { makeProviderCtx, providerFor, ProviderError, withProviderCtx } from './providers/index.js';

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
  // Phát hành xong và gốc đã chuyển `replaced`: đảo ngay (route này đã kiểm quyền ghi sổ). Đảo lỗi thì cảnh báo thay cho "chờ đảo".
  const pending = dto.warnings?.some((w) => w.code === REVERSAL_PENDING);
  const rest = (dto.warnings ?? []).filter((w) => w.code !== REVERSAL_PENDING);
  const warnings = [...p.warnings, ...rest, ...(pending ? await tryReverse(db, ctx, originalId) : [])];
  const out = { ...dto };
  delete out.warnings;
  return warnings.length ? { ...out, warnings } : out;
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
  const u = await withTenant(db, tctx(ctx), (trx) => trx.updateTable('einvoice').set({ status: 'cancelled', needs_reversal: true }).where('id', '=', id).where('status', '=', 'issued').executeTakeFirst());
  if (!u.numUpdatedRows) {
    // Hóa đơn đã chuyển trạng thái khác (vd. hóa đơn thay thế chốt trước) trong lúc nhà cung cấp hủy: hủy mồ côi, ghi nhật ký ở giao dịch riêng rồi báo.
    const msg = `Nhà cung cấp đã hủy hóa đơn ${ref.serial} số ${ref.invoiceNo} nhưng hóa đơn điện tử trong phần mềm đã đổi trạng thái trong lúc hủy: kiểm tra hóa đơn ở nhà cung cấp và xử lý tay`;
    await withTenant(db, tctx(ctx), (trx) => makeProviderCtx(trx, { tenantId: ctx.tenantId, providerId: provider.id, einvoiceId: id, userId: ctx.userId ?? null })
      .log({ action: 'orphan_cancelled', request: { reason: input.reason, date: input.date }, response: null, httpStatus: null, ok: false, error: msg, ms: 0 }));
    throw new AppError('EINVOICE_ORPHAN_CANCELLED', msg, 409);
  }
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

// Kỳ chứa ngày ghi được: mở, hoặc khóa mềm khi người dùng có quyền ghi lùi ngày. Kỳ khóa cứng không ghi được.
async function writable(trx: Trx, ctx: EInvoiceCtx, date: string): Promise<boolean> {
  const p = await trx.selectFrom('fiscal_period').select('status').where('date_from', '<=', date).where('date_to', '>=', date).where('period_no', '>', 0).executeTakeFirst();
  return !!p && (p.status === 'open' || (p.status === 'soft_locked' && !!ctx.canBackdate));
}

// Ngày đảo chứng từ của hóa đơn bị thay thế/hủy: ngày gốc nếu kỳ gốc ghi được (đảo triệt tiêu ngay ở kỳ kê khai gốc), không thì ngày dự phòng
// (ngày chứng từ thay thế, ngày hủy). Cả hai kỳ đều khóa: 409.
async function reversalDate(trx: Trx, ctx: EInvoiceCtx, voucherId: string, fallback: string): Promise<string> {
  const v = await trx.selectFrom('voucher').select(['voucher_no', 'posting_date', 'state']).where('id', '=', voucherId).executeTakeFirstOrThrow();
  if (v.state !== 'posted') throw new AppError('VOUCHER_NOT_POSTED', `Chứng từ ${v.voucher_no ?? ''} của hóa đơn không còn ở trạng thái đã ghi sổ: không đảo được`, 409);
  if (await writable(trx, ctx, v.posting_date)) return v.posting_date;
  if (fallback >= v.posting_date && await writable(trx, ctx, fallback)) return fallback;
  throw new AppError('EINVOICE_REVERSAL_LOCKED', `Không đảo được chứng từ ${v.voucher_no ?? ''}: kỳ chứa ngày ${formatVnDate(v.posting_date)} và kỳ chứa ngày ${formatVnDate(fallback)} đã khóa sổ `
    + '(kỳ khóa mềm cần quyền ghi lùi ngày); mở kỳ rồi làm lại', 409);
}

// Pha 1 của thay thế/hủy: chứng từ hóa đơn gốc phải đảo được (đã ghi sổ, chưa đối trừ công nợ, kỳ ghi được) trước khi gửi nhà cung cấp.
async function assertReversible(trx: Trx, ctx: EInvoiceCtx, voucherId: string, fallback: string): Promise<void> {
  await reversalDate(trx, ctx, voucherId, fallback);
  const settled = await sql<{ x: number }>`SELECT 1 AS x FROM open_item o JOIN settlement s ON s.tenant_id = o.tenant_id AND (s.debit_item_id = o.id OR s.credit_item_id = o.id)
    WHERE o.voucher_id = ${voucherId}::uuid AND s.kind <> 'reversal' LIMIT 1`.execute(trx);
  if (settled.rows.length) throw new AppError('OPEN_ITEM_SETTLED', 'Chứng từ của hóa đơn gốc đã đối trừ công nợ (đã thu tiền): hủy đối trừ trước rồi mới thay thế hoặc hủy hóa đơn', 409);
}

// Đảo chứng từ của hóa đơn có needs_reversal (bị thay thế hoặc hủy), giao dịch riêng, qua reverseWithCashCheck như route đảo chứng từ (kiểm tồn quỹ âm theo cài đặt).
// Bỏ khóa EINVOICE_ISSUED chỉ trong giao dịch này (set_config cục bộ). Ngày dự phòng: hóa đơn bị thay thế lấy ngày chứng từ của hóa đơn thay thế (kể cả hóa đơn
// thay thế đã bị thay tiếp); hóa đơn bị hủy lấy ngày hủy (thử lại sau: hôm nay). Chỉ gọi từ route có quyền ghi sổ.
export async function reverseMarked(db: Db, ctx: EInvoiceCtx, id: number, cancelDate?: string): Promise<EInvoiceDto> {
  return withTenant(db, tctx(ctx), async (trx) => {
    const e = await trx.selectFrom('einvoice as e').innerJoin('einvoice_series as s', 's.id', 'e.series_id').select(['e.id', 'e.status', 'e.needs_reversal', 'e.voucher_id', 'e.invoice_no', 's.serial'])
      .where('e.id', '=', id).forUpdate('e').executeTakeFirst();
    if (!e) throw notFound();
    if (!e.needs_reversal) throw new AppError('EINVOICE_NO_REVERSAL_NEEDED', 'Chứng từ của hóa đơn không cần đảo (đã đảo hoặc hóa đơn chưa bị thay thế, hủy)', 409);
    let fallback = cancelDate ?? todayVn();
    let description = `Đảo do hủy hóa đơn ${e.serial} số ${e.invoice_no}`;
    if (e.status === 'replaced') {
      const by = await trx.selectFrom('einvoice as r').innerJoin('voucher as v', 'v.id', 'r.voucher_id').select(['r.invoice_no', 'v.posting_date'])
        .where('r.original_id', '=', id).where('r.relation', '=', 'replacement').where('r.status', 'in', ['issued', 'replaced']).orderBy('r.id', 'desc').executeTakeFirst();
      if (by) fallback = by.posting_date;
      description = `Đảo do hóa đơn ${e.serial} số ${e.invoice_no} bị thay thế${by ? ` bởi hóa đơn số ${by.invoice_no}` : ''}`;
    }
    const postingDate = await reversalDate(trx, ctx, e.voucher_id, fallback);
    await sql`SELECT set_config('app.einvoice_reversal', 'on', true)`.execute(trx);
    if (ctx.canBackdate) await sql`SELECT set_config('app.override_soft_lock', 'on', true)`.execute(trx);
    await reverseWithCashCheck(trx, ctx.tenantId, e.voucher_id, { postingDate, description });
    await sql`SELECT set_config('app.einvoice_reversal', 'off', true)`.execute(trx);
    await trx.updateTable('einvoice').set({ needs_reversal: false }).where('id', '=', id).execute();
    return loadDto(trx, id);
  });
}

// Đảo ngay sau khi kết quả đã commit: lỗi thành cảnh báo, cờ needs_reversal giữ lại để "Đảo chứng từ gốc" làm lại.
async function tryReverse(db: Db, ctx: EInvoiceCtx, id: number, cancelDate?: string): Promise<{ code: string; message: string }[]> {
  try { await reverseMarked(db, ctx, id, cancelDate); return []; } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return [{ code: 'EINVOICE_REVERSAL_FAILED', message: `Hóa đơn điện tử đã xử lý xong nhưng chưa đảo được chứng từ của hóa đơn gốc (${msg}). Khắc phục rồi dùng "Đảo chứng từ gốc"` }];
  }
}
