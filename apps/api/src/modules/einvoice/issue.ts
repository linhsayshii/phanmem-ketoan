import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { withTenant, type Database, type TenantCtx } from '@kt/db';
import { formatVnDate, todayVn } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { syncOrdersOfVoucher } from '../orders/link.js';
import { buildEInvoiceDoc } from './doc.js';
import { makeProviderCtx, providerFor, ProviderError, RETRY_GUARD_SEC, withProviderCtx, type EInvoiceDoc, type EInvoiceProvider, type IssueResult, type OriginalRef, type ProviderRow } from './providers/index.js';

// Phát hành hóa đơn điện tử hai pha (quy ước 3): pha 1 giao dịch đặt `sending` + lưu payload; pha 2 gọi nhà cung cấp ngoài giao dịch (withProviderCtx);
// pha 3 giao dịch ghi kết quả. Lỗi mạng giữ `sending`; thử lại/worker tra theo transaction_uuid trước khi gửi lại cùng uuid, cùng payload.
type Trx = Transaction<Database>;
type Db = Kysely<Database>;
// canBackdate: người dùng có quyền ghi lùi ngày (voucher.backdate_locked) — đảo chứng từ vào kỳ khóa mềm.
export interface EInvoiceCtx { tenantId: string; userId?: string | null; ip?: string; canBackdate?: boolean }
export type ProviderFactory = (row: ProviderRow) => EInvoiceProvider;
export type Outcome = { kind: 'ok'; result: IssueResult } | { kind: 'failed'; code: string; message: string } | { kind: 'pending'; message: string };

export const SALE_TYPES = ['HDB', 'BH', 'GGB', 'TLB'];
export const tctx = (c: EInvoiceCtx): TenantCtx => ({ tenantId: c.tenantId, ...(c.userId ? { userId: c.userId } : {}), ...(c.ip ? { ip: c.ip } : {}) });
export const notFound = () => new AppError('EINVOICE_NOT_FOUND', 'Không tìm thấy hóa đơn điện tử', 404);

// Danh sách, chi tiết: số liệu hiển thị (khách, tổng tiền) lấy từ payload đã gửi, đúng như trên hóa đơn.
export const einvoiceQuery = (trx: Trx) => trx.selectFrom('einvoice as e').innerJoin('einvoice_series as s', 's.id', 'e.series_id').innerJoin('voucher as v', 'v.id', 'e.voucher_id')
  .select(['e.id', 'e.voucher_id', 'v.voucher_no', 'v.voucher_type', 'v.posting_date', 'e.series_id', 's.form_no', 's.serial', 'e.relation', 'e.original_id', 'e.status', 'e.transaction_uuid',
    'e.invoice_no', 'e.issue_date', 'e.issued_at', 'e.cqt_code', 'e.cqt_status', 'e.error_code', 'e.error_message', 'e.attempts', 'e.last_attempt_at', 'e.discarded_at', 'e.created_at', 'e.adjusted', 'e.needs_reversal', 'e.paid',
    sql<string | null>`e.payload->'buyer'->>'name'`.as('buyer_name'), sql<string | null>`e.payload->'totals'->>'total'`.as('total'), sql<string | null>`e.payload->>'currency'`.as('currency')]);
type Row = Awaited<ReturnType<ReturnType<typeof einvoiceQuery>['executeTakeFirstOrThrow']>>;
export const einvoiceDto = (r: Row) => ({
  id: r.id, voucherId: r.voucher_id, voucherNo: r.voucher_no, voucherType: r.voucher_type, postingDate: r.posting_date, seriesId: r.series_id, formNo: r.form_no, serial: r.serial,
  relation: r.relation, originalId: r.original_id, status: r.status, transactionUuid: r.transaction_uuid, invoiceNo: r.invoice_no, issueDate: r.issue_date, issuedAt: r.issued_at,
  cqtCode: r.cqt_code, cqtStatus: r.cqt_status, errorCode: r.error_code, errorMessage: r.error_message, attempts: r.attempts, lastAttemptAt: r.last_attempt_at, discardedAt: r.discarded_at,
  adjusted: r.adjusted, needsReversal: r.needs_reversal, paid: r.paid,
  buyerName: r.buyer_name, total: r.total, currency: r.currency, createdAt: r.created_at,
});
export type EInvoiceDto = ReturnType<typeof einvoiceDto> & { warnings?: { code: string; message: string }[] };
export const loadDto = async (trx: Trx, id: number) => einvoiceDto(await einvoiceQuery(trx).where('e.id', '=', id).executeTakeFirstOrThrow());

export const providerRow = async (trx: Trx, id: number) => trx.selectFrom('einvoice_provider').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
// Ký hiệu C (có mã của cơ quan thuế): nhà cung cấp chưa trả mã thì đang chờ cơ quan thuế cấp mã.
const cqtOf = (serial: string, r: Pick<IssueResult, 'cqtCode' | 'cqtStatus'>) => (r.cqtStatus === 'none' && !r.cqtCode && serial.startsWith('C') ? 'waiting' : r.cqtStatus);

// Hóa đơn điều chỉnh/thay thế (Task 6): lý do, văn bản thỏa thuận đi vào payload gửi nhà cung cấp.
export interface Relation { relation: 'adjustment' | 'replacement'; originalId: number; adjustKind?: 'increase' | 'decrease'; reason: string; agreementNo?: string | undefined; agreementDate?: string | undefined }
export interface Prepared { id: number; doc: EInvoiceDoc; provider: ProviderRow & { id: number }; warnings: { code: string; message: string }[] }

// Pha 1. Khóa tư vấn theo chứng từ + khóa dòng chứng từ (FOR UPDATE) rồi mới kiểm `posted`: trigger khóa chứng từ đọc einvoice không khóa,
// nên bỏ ghi sổ song song phải chờ giao dịch này (đã thấy `sending`) hoặc thắng trước (ở đây thấy không còn `posted`).
export async function prepare(trx: Trx, ctx: EInvoiceCtx, voucherId: string, issueDateIn: string | undefined, factory: ProviderFactory, rel?: Relation): Promise<Prepared> {
  await sql`SELECT pg_advisory_xact_lock(hashtext('einvoice'), hashtext(${voucherId}))`.execute(trx);
  const v = await trx.selectFrom('voucher').select(['id', 'voucher_type', 'state', 'posting_date']).where('id', '=', voucherId).forUpdate().executeTakeFirst();
  if (!v) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ', 404);
  if (!SALE_TYPES.includes(v.voucher_type)) throw new AppError('EINVOICE_VOUCHER_TYPE', 'Chỉ phát hành hóa đơn điện tử cho chứng từ bán hàng (hóa đơn bán, bán hàng, giảm giá, trả lại hàng bán)', 400);
  if (v.state !== 'posted') throw new AppError('VOUCHER_NOT_POSTED', 'Chứng từ chưa ghi sổ: ghi sổ chứng từ trước khi phát hành hóa đơn điện tử', 409);
  const live = await trx.selectFrom('einvoice').select(['id', 'status', 'invoice_no']).where('voucher_id', '=', voucherId).where('status', '<>', 'failed').executeTakeFirst();
  if (live && live.status !== 'draft') throw new AppError('EINVOICE_EXISTS', live.status === 'sending' ? 'Hóa đơn điện tử của chứng từ đang được gửi: dùng "Thử lại" hoặc chờ đối soát' : `Chứng từ đã có hóa đơn điện tử${live.invoice_no ? ` số ${live.invoice_no}` : ''}`, 409);
  const vi = await trx.selectFrom('voucher_invoice').select(['einvoice_series_id', 'adjusts_invoice_id']).where('voucher_id', '=', voucherId).where('einvoice_pending', '=', true).where('einvoice_series_id', 'is not', null).executeTakeFirst();
  if (!vi) throw new AppError('EINVOICE_NOT_PENDING', 'Chứng từ không chọn ký hiệu hóa đơn điện tử (hoặc đã có số hóa đơn)', 409);
  if (!rel && vi.adjusts_invoice_id !== null) throw new AppError('EINVOICE_ADJUSTMENT_REQUIRED', 'Chứng từ điều chỉnh hóa đơn đã lập (giảm giá, trả lại, điều chỉnh tăng): phát hành bằng "Lập hóa đơn điều chỉnh" từ hóa đơn gốc', 409);
  const series = await trx.selectFrom('einvoice_series').select(['id', 'provider_id', 'year', 'serial', 'is_active']).where('id', '=', vi.einvoice_series_id!).executeTakeFirstOrThrow();
  if (!series.is_active) throw new AppError('SERIES_INACTIVE', `Ký hiệu hóa đơn ${series.serial} đã ngừng sử dụng: bật lại ký hiệu trong cấu hình hóa đơn điện tử hoặc lập lại chứng từ với ký hiệu khác`, 400);
  const provider = await providerRow(trx, series.provider_id);
  factory(provider); // nhà cung cấp chưa hỗ trợ: báo ngay, trước khi đặt `sending`

  const issueDate = issueDateIn ?? todayVn();
  if (Number(issueDate.slice(0, 4)) !== series.year) throw new AppError('SERIES_YEAR_MISMATCH', `Ký hiệu hóa đơn thuộc năm ${series.year}, không phát hành được hóa đơn ngày ${issueDate}`, 400);
  const warnings = issueDate.slice(0, 7) === v.posting_date.slice(0, 7) ? []
    : [{ code: 'ISSUE_DATE_DIFFERS_PERIOD', message: `Ngày hóa đơn ${issueDate} khác tháng hạch toán của chứng từ (${v.posting_date}): kiểm tra kỳ kê khai thuế GTGT` }];

  // Dùng lại hàng nháp, hoặc hàng lỗi chưa bỏ (uuid mới: lần gửi trước bị từ chối, không phải cùng giao dịch); không có thì thêm mới.
  const failed = live ? undefined : await trx.selectFrom('einvoice').select('id').where('voucher_id', '=', voucherId).where('status', '=', 'failed').where('discarded_at', 'is', null).orderBy('id', 'desc').executeTakeFirst();
  const reuse = live?.id ?? failed?.id;
  const set = { status: 'sending', relation: rel?.relation ?? 'original', original_id: rel?.originalId ?? null, adjust_kind: rel?.adjustKind ?? null, issue_date: issueDate, series_id: series.id, provider_id: provider.id, error_code: null, error_message: null, last_attempt_at: sql<string>`now()` };
  const id = reuse
    ? (await trx.updateTable('einvoice').set({ ...set, ...(failed && { transaction_uuid: sql<string>`gen_random_uuid()` }) }).where('id', '=', reuse).returning('id').executeTakeFirstOrThrow()).id
    : (await trx.insertInto('einvoice').values({ tenant_id: ctx.tenantId, voucher_id: voucherId, ...set, transaction_uuid: sql<string>`gen_random_uuid()`, created_by: ctx.userId ?? null }).returning('id').executeTakeFirstOrThrow()).id;
  const doc = await buildEInvoiceDoc(trx, id); // lỗi dữ liệu (thiếu mã thuế…) rollback cả hàng vừa đặt `sending`
  if (rel && doc.relation.kind !== 'original')
    doc.relation = { ...doc.relation, reason: rel.reason, ...(rel.agreementNo && { agreementNo: rel.agreementNo }), ...(rel.agreementDate && { agreementDate: rel.agreementDate }) };
  await trx.updateTable('einvoice').set({ payload: JSON.stringify(doc) }).where('id', '=', id).execute();
  return { id, doc, provider, warnings };
}

// Pha 2: gọi nhà cung cấp ngoài mọi giao dịch nghiệp vụ. Thử lại tra theo uuid trước: đã có thì nhận số, không gửi lại.
export async function send(db: Db, ctx: EInvoiceCtx, p: Omit<Prepared, 'warnings'>, factory: ProviderFactory, lookupFirst: boolean): Promise<Outcome> {
  const provider = factory(p.provider);
  try {
    const result = await withProviderCtx(db, { tenantId: ctx.tenantId, userId: ctx.userId ?? null, providerId: p.provider.id, einvoiceId: p.id }, async (c) =>
      (lookupFirst ? await provider.findByTransaction(c, p.doc) : null) ?? provider.create(c, p.doc));
    return { kind: 'ok', result };
  } catch (e) {
    if (e instanceof ProviderError && !e.retriable) return { kind: 'failed', code: e.code, message: e.message };
    // Lỗi mạng, lỗi tạm của nhà cung cấp, lỗi không rõ: không biết hóa đơn đã được tạo chưa nên giữ `sending` để tra lại theo uuid.
    return { kind: 'pending', message: e instanceof Error ? e.message : String(e) };
  }
}

// Pha 3. Khóa dòng và chỉ ghi khi còn `sending`: hai lần kết thúc song song (người dùng thử lại + worker) thì một bên thắng, bên kia không làm gì.
// Hóa đơn điều chỉnh: gốc `adjusted`. Hóa đơn thay thế: gốc `replaced` + `needs_reversal` cùng giao dịch với kết quả phát hành; đảo chứng từ gốc chạy sau,
// ở giao dịch riêng (reverseMarked): đảo lỗi chỉ để lại cờ, không mất kết quả phát hành.
export async function finalizeIssue(db: Db, ctx: EInvoiceCtx, einvoiceId: number, outcome: Outcome): Promise<EInvoiceDto> {
  const r = await withTenant(db, tctx(ctx), async (trx): Promise<{ dto: EInvoiceDto; reverse?: number } | { orphan: { providerId: number; status: string } }> => {
    const e = await trx.selectFrom('einvoice').select(['id', 'status', 'voucher_id', 'series_id', 'provider_id', 'invoice_no', 'relation', 'original_id']).where('id', '=', einvoiceId).forUpdate().executeTakeFirst();
    if (!e) throw notFound();
    if (e.status !== 'sending') {
      // Bên kia đã ghi đúng số này: không làm gì. Nhà cung cấp cấp số cho hàng đã chốt khác (lỗi, đã bỏ…): hóa đơn mồ côi, phải báo.
      if (outcome.kind !== 'ok' || (e.status === 'issued' && e.invoice_no === outcome.result.invoiceNo)) return { dto: await loadDto(trx, e.id) };
      return { orphan: { providerId: e.provider_id, status: e.status } };
    }
    const attempt = { attempts: sql<number>`attempts + 1`, last_attempt_at: sql<string>`now()` };
    if (outcome.kind === 'ok') {
      const r = outcome.result;
      const s = await trx.selectFrom('einvoice_series').select(['form_no', 'serial']).where('id', '=', e.series_id).executeTakeFirstOrThrow();
      await sql`SELECT fn_einvoice_set_number(${e.voucher_id}::uuid, ${s.form_no}, ${s.serial}, ${r.invoiceNo}, ${r.issueDate}::date)`.execute(trx);
      await trx.updateTable('einvoice').set({ ...attempt, status: 'issued', invoice_no: r.invoiceNo, issue_date: r.issueDate, issued_at: sql<string>`now()`, cqt_code: r.cqtCode,
        cqt_status: cqtOf(s.serial, r), provider_ref: JSON.stringify(r.providerRef), error_code: null, error_message: null }).where('id', '=', e.id).execute();
      if (e.relation === 'adjustment') await trx.updateTable('einvoice').set({ adjusted: true }).where('id', '=', e.original_id!).execute();
      if (e.relation === 'replacement') {
        const u = await trx.updateTable('einvoice').set({ status: 'replaced', needs_reversal: true }).where('id', '=', e.original_id!).where('status', '=', 'issued').executeTakeFirst();
        if (u.numUpdatedRows) return { dto: await loadDto(trx, e.id), reverse: e.original_id! };
      }
    } else if (outcome.kind === 'failed') {
      await trx.updateTable('einvoice').set({ ...attempt, status: 'failed', error_code: outcome.code, error_message: outcome.message }).where('id', '=', e.id).execute();
    } else {
      await trx.updateTable('einvoice').set({ ...attempt, error_code: 'PENDING', error_message: outcome.message }).where('id', '=', e.id).execute();
    }
    return { dto: await loadDto(trx, e.id) };
  });
  if ('dto' in r) {
    if (r.reverse === undefined) return r.dto;
    const warnings = await tryReverse(db, ctx, r.reverse);
    return warnings.length ? { ...r.dto, warnings } : r.dto;
  }
  // Nhật ký ở giao dịch riêng (lỗi ném ra không cuốn theo), rồi báo cho người gọi: cần hủy hóa đơn ở nhà cung cấp hoặc xử lý tay.
  const res = (outcome as Extract<Outcome, { kind: 'ok' }>).result;
  const msg = `Nhà cung cấp đã cấp hóa đơn số ${res.invoiceNo} ngày ${res.issueDate} nhưng hóa đơn điện tử trong phần mềm đã ở trạng thái ${r.orphan.status}: kiểm tra và hủy hóa đơn này ở nhà cung cấp`;
  await withTenant(db, tctx(ctx), (trx) => makeProviderCtx(trx, { tenantId: ctx.tenantId, providerId: r.orphan.providerId, einvoiceId, userId: ctx.userId ?? null })
    .log({ action: 'orphan_issued', request: null, response: res, httpStatus: null, ok: false, error: msg, ms: 0 }));
  throw new AppError('EINVOICE_ORPHAN_ISSUED', msg, 409);
}

export async function issueEInvoice(db: Db, ctx: EInvoiceCtx, voucherId: string, opts: { issueDate?: string | undefined }, factory: ProviderFactory = providerFor): Promise<EInvoiceDto> {
  const p = await withTenant(db, tctx(ctx), (trx) => prepare(trx, ctx, voucherId, opts.issueDate, factory));
  const dto = await finalizeIssue(db, ctx, p.id, await send(db, ctx, p, factory, false));
  return p.warnings.length ? { ...dto, warnings: p.warnings } : dto;
}

// Thử lại hàng `sending` với đúng payload đã lưu (không dựng lại từ chứng từ): cùng uuid, cùng nội dung.
export async function retryEInvoice(db: Db, ctx: EInvoiceCtx, id: number, factory: ProviderFactory = providerFor): Promise<EInvoiceDto> {
  const p = await withTenant(db, tctx(ctx), async (trx) => {
    const e = await trx.selectFrom('einvoice').select(['id', 'status', 'payload', 'provider_id',
      sql<boolean>`coalesce(last_attempt_at > now() - make_interval(secs => ${RETRY_GUARD_SEC}::int), false)`.as('recent')]).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!e) throw notFound();
    if (e.status !== 'sending' || !e.payload) throw new AppError('EINVOICE_NOT_SENDING', 'Chỉ thử lại hóa đơn điện tử đang gửi (chưa nhận được kết quả)', 409);
    if (e.recent) throw new AppError('EINVOICE_BUSY', `Hóa đơn điện tử đang được gửi tới nhà cung cấp: thử lại sau ${RETRY_GUARD_SEC} giây kể từ lần gửi trước`, 409);
    await trx.updateTable('einvoice').set({ last_attempt_at: sql<string>`now()` }).where('id', '=', id).execute(); // worker không nhặt lại lần thử đang chạy
    return { id: e.id, doc: e.payload as EInvoiceDoc, provider: await providerRow(trx, e.provider_id) };
  });
  return finalizeIssue(db, ctx, p.id, await send(db, ctx, p, factory, true));
}

// Bỏ hóa đơn phát hành lỗi: xóa mềm (giữ hàng làm lịch sử). Lần phát hành sau thêm hàng mới, uuid mới.
export async function discardFailed(db: Db, ctx: EInvoiceCtx, id: number): Promise<EInvoiceDto> {
  return withTenant(db, tctx(ctx), async (trx) => {
    const e = await trx.selectFrom('einvoice').select(['id', 'status', 'discarded_at']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!e) throw notFound();
    if (e.status !== 'failed' || e.discarded_at) throw new AppError('EINVOICE_NOT_FAILED', 'Chỉ bỏ được hóa đơn điện tử phát hành lỗi', 409);
    await trx.updateTable('einvoice').set({ discarded_at: sql<string>`now()` }).where('id', '=', id).execute();
    return loadDto(trx, id);
  });
}

type Issued = Pick<Selectable<Database['einvoice']>, 'id' | 'status' | 'provider_id' | 'invoice_no' | 'issue_date' | 'provider_ref' | 'xml'> & { form_no: string; serial: string };
export async function loadIssued(trx: Trx, id: number): Promise<{ e: Issued; ref: OriginalRef; provider: ProviderRow & { id: number } }> {
  const e = await trx.selectFrom('einvoice as e').innerJoin('einvoice_series as s', 's.id', 'e.series_id')
    .select(['e.id', 'e.provider_id', 'e.invoice_no', 'e.issue_date', 'e.provider_ref', 'e.status', 'e.xml', 's.form_no', 's.serial']).where('e.id', '=', id).executeTakeFirst();
  if (!e) throw notFound();
  if (!e.invoice_no || !e.issue_date) throw new AppError('EINVOICE_NOT_ISSUED', 'Hóa đơn điện tử chưa phát hành', 409);
  return { e, ref: { formNo: e.form_no, serial: e.serial, invoiceNo: e.invoice_no, issueDate: e.issue_date, providerRef: e.provider_ref }, provider: await providerRow(trx, e.provider_id) };
}

// Tra trạng thái cấp mã của cơ quan thuế.
export async function refreshEInvoice(db: Db, ctx: EInvoiceCtx, id: number, factory: ProviderFactory = providerFor): Promise<EInvoiceDto> {
  const { e, ref, provider } = await withTenant(db, tctx(ctx), (trx) => loadIssued(trx, id));
  const r = await withProviderCtx(db, { tenantId: ctx.tenantId, userId: ctx.userId ?? null, providerId: provider.id, einvoiceId: id }, (c) => factory(provider).refreshStatus(c, ref));
  return withTenant(db, tctx(ctx), async (trx) => {
    await trx.updateTable('einvoice').set({ cqt_code: sql<string | null>`coalesce(${r.cqtCode}, cqt_code)`, cqt_status: cqtOf(e.serial, r), last_attempt_at: sql<string>`now()` })
      .where('id', '=', id).where('status', '=', 'issued').execute();
    return loadDto(trx, id);
  });
}

// Tệp hóa đơn từ nhà cung cấp. XML (bản pháp lý có chữ ký, mã CQT) lưu vào einvoice.xml lần đầu lấy được, lần sau đọc từ DB.
export async function einvoiceFile(db: Db, ctx: EInvoiceCtx, id: number, kind: 'pdf' | 'xml', factory: ProviderFactory = providerFor): Promise<{ body: Buffer; contentType: string; fileName: string }> {
  const { e, ref, provider } = await withTenant(db, tctx(ctx), (trx) => loadIssued(trx, id));
  const name = `${ref.serial}_${e.invoice_no}`;
  if (kind === 'xml' && e.xml) return { body: Buffer.from(e.xml, 'utf8'), contentType: 'application/xml; charset=utf-8', fileName: `${name}.xml` };
  const body = await withProviderCtx(db, { tenantId: ctx.tenantId, userId: ctx.userId ?? null, providerId: provider.id, einvoiceId: id }, (c) => factory(provider).getFile(c, ref, kind));
  if (kind === 'xml') {
    await withTenant(db, tctx(ctx), (trx) => trx.updateTable('einvoice').set({ xml: body.toString('utf8') }).where('id', '=', id).where('xml', 'is', null).execute());
    return { body, contentType: 'application/xml; charset=utf-8', fileName: `${name}.xml` };
  }
  // Nhà cung cấp giả lập trả HTML thay PDF.
  const isPdf = body.subarray(0, 4).toString('latin1') === '%PDF';
  return { body, contentType: isPdf ? 'application/pdf' : 'text/html; charset=utf-8', fileName: `${name}.${isPdf ? 'pdf' : 'html'}` };
}

// Kỳ chứa ngày ghi được: mở, hoặc khóa mềm khi người dùng có quyền ghi lùi ngày. Kỳ khóa cứng không ghi được.
async function writable(trx: Trx, ctx: EInvoiceCtx, date: string): Promise<boolean> {
  const p = await trx.selectFrom('fiscal_period').select('status').where('date_from', '<=', date).where('date_to', '>=', date).where('period_no', '>', 0).executeTakeFirst();
  return !!p && (p.status === 'open' || (p.status === 'soft_locked' && !!ctx.canBackdate));
}

// Ngày đảo chứng từ của hóa đơn bị thay thế/hủy: ngày gốc nếu kỳ gốc ghi được (đảo triệt tiêu ngay ở kỳ kê khai gốc), không thì ngày dự phòng
// (ngày chứng từ thay thế, ngày hủy). Cả hai kỳ đều khóa: 409.
export async function reversalDate(trx: Trx, ctx: EInvoiceCtx, voucherId: string, fallback: string): Promise<string> {
  const v = await trx.selectFrom('voucher').select(['voucher_no', 'posting_date', 'state']).where('id', '=', voucherId).executeTakeFirstOrThrow();
  if (v.state !== 'posted') throw new AppError('VOUCHER_NOT_POSTED', `Chứng từ ${v.voucher_no ?? ''} của hóa đơn không còn ở trạng thái đã ghi sổ: không đảo được`, 409);
  if (await writable(trx, ctx, v.posting_date)) return v.posting_date;
  if (fallback >= v.posting_date && await writable(trx, ctx, fallback)) return fallback;
  throw new AppError('EINVOICE_REVERSAL_LOCKED', `Không đảo được chứng từ ${v.voucher_no ?? ''}: kỳ chứa ngày ${formatVnDate(v.posting_date)} và kỳ chứa ngày ${formatVnDate(fallback)} đã khóa sổ `
    + '(kỳ khóa mềm cần quyền ghi lùi ngày); mở kỳ rồi làm lại', 409);
}

// Pha 1 của thay thế/hủy: chứng từ hóa đơn gốc phải đảo được (đã ghi sổ, chưa đối trừ công nợ, kỳ ghi được) trước khi gửi nhà cung cấp.
export async function assertReversible(trx: Trx, ctx: EInvoiceCtx, voucherId: string, fallback: string): Promise<void> {
  await reversalDate(trx, ctx, voucherId, fallback);
  const settled = await sql<{ x: number }>`SELECT 1 AS x FROM open_item o JOIN settlement s ON s.tenant_id = o.tenant_id AND (s.debit_item_id = o.id OR s.credit_item_id = o.id)
    WHERE o.voucher_id = ${voucherId}::uuid AND s.kind <> 'reversal' LIMIT 1`.execute(trx);
  if (settled.rows.length) throw new AppError('OPEN_ITEM_SETTLED', 'Chứng từ của hóa đơn gốc đã đối trừ công nợ (đã thu tiền): hủy đối trừ trước rồi mới thay thế hoặc hủy hóa đơn', 409);
}

// Đảo chứng từ của hóa đơn có needs_reversal (bị thay thế hoặc hủy), giao dịch riêng. Bỏ khóa EINVOICE_ISSUED chỉ trong giao dịch này (set_config cục bộ).
// Ngày dự phòng: hóa đơn bị thay thế lấy ngày chứng từ thay thế; hóa đơn bị hủy lấy ngày hủy (thử lại sau: hôm nay).
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
        .where('r.original_id', '=', id).where('r.relation', '=', 'replacement').where('r.status', '=', 'issued').orderBy('r.id', 'desc').executeTakeFirstOrThrow();
      fallback = by.posting_date;
      description = `Đảo do hóa đơn ${e.serial} số ${e.invoice_no} bị thay thế bởi hóa đơn số ${by.invoice_no}`;
    }
    const postingDate = await reversalDate(trx, ctx, e.voucher_id, fallback);
    await sql`SELECT set_config('app.einvoice_reversal', 'on', true)`.execute(trx);
    if (ctx.canBackdate) await sql`SELECT set_config('app.override_soft_lock', 'on', true)`.execute(trx);
    // như ledger reverseVoucher (không nhập vouchers.service: worker đối soát nhập module này mà không có kiểu plugin Fastify)
    await sql`SELECT reverse_voucher(${e.voucher_id}::uuid, ${postingDate}::date, ${description})`.execute(trx);
    await syncOrdersOfVoucher(trx, e.voucher_id);
    await sql`SELECT set_config('app.einvoice_reversal', 'off', true)`.execute(trx);
    await trx.updateTable('einvoice').set({ needs_reversal: false }).where('id', '=', id).execute();
    return loadDto(trx, id);
  });
}

// Pha 3 sau khi kết quả đã commit: đảo lỗi thành cảnh báo, cờ needs_reversal giữ lại để "Đảo chứng từ gốc" làm lại.
export async function tryReverse(db: Db, ctx: EInvoiceCtx, id: number, cancelDate?: string): Promise<{ code: string; message: string }[]> {
  try { await reverseMarked(db, ctx, id, cancelDate); return []; } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return [{ code: 'EINVOICE_REVERSAL_FAILED', message: `Hóa đơn điện tử đã xử lý xong nhưng chưa đảo được chứng từ của hóa đơn gốc (${msg}). Khắc phục rồi dùng "Đảo chứng từ gốc"` }];
  }
}
