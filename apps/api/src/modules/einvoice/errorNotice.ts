import { z } from 'zod';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { withTenant, type Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { dateIso } from '../master/catalogs.js';
import { providerRow, tctx, type EInvoiceCtx, type ProviderFactory } from './issue.js';
import { providerFor, ProviderError, withProviderCtx, type ErrorNoticeDoc } from './providers/index.js';

// Thông báo hóa đơn điện tử đã lập sai, Mẫu số 04/SS-HĐĐT (TT 91/2026/TT-BTC Điều 10 khoản 1 điểm a, khoản 3, Phụ lục III).
// self = người bán tự thông báo (cột 8 "Thông báo"); tax_notice = cơ quan thuế thông báo theo 01/TB-RSĐT (cột 8 "Giải trình").
type Trx = Transaction<Database>;
type Db = Kysely<Database>;

const text = (max: number) => z.string().trim().max(max);
const lineInput = z.object({
  einvoiceId: z.number().int().positive().optional(),
  formNo: text(10).optional(), serial: text(10).optional(), invoiceNo: text(20).optional(), issueDate: dateIso.optional(), cqtCode: text(50).nullable().optional(),
  invoiceType: text(100).optional(), action: z.enum(['notice', 'explain']), reason: text(500).min(1),
});
export const noticeInput = z.object({
  noticeKind: z.enum(['self', 'tax_notice']), taxNoticeNo: text(100).optional(), taxNoticeDate: dateIso.optional(), noticeDate: dateIso, place: text(100).default(''),
  providerId: z.number().int().positive().optional(), lines: z.array(lineInput).min(1).max(200),
});
type NoticeInput = z.infer<typeof noticeInput>;

const bad = (m: string) => new AppError('VALIDATION', m, 400);
const notFound = () => new AppError('ERROR_NOTICE_NOT_FOUND', 'Không tìm thấy thông báo hóa đơn điện tử đã lập sai', 404);
const notDraft = () => new AppError('ERROR_NOTICE_NOT_DRAFT', 'Thông báo đã gửi, không sửa, xóa hoặc gửi lại được', 409);

// Loại hóa đơn điện tử (cột 7) theo ký tự đầu của ký hiệu mẫu hóa đơn (TT 91/2026 Phụ lục I, điểm 1; ký hiệu mẫu 1-9).
const FORM_TYPES: Record<string, string> = {
  '1': 'Hóa đơn giá trị gia tăng', '2': 'Hóa đơn bán hàng', '3': 'Hóa đơn bán tài sản công', '4': 'Hóa đơn bán hàng dự trữ quốc gia',
  '5': 'Tem điện tử, vé điện tử, thẻ điện tử, phiếu thu điện tử và chứng từ điện tử khác có nội dung của hóa đơn điện tử',
  '6': 'Chứng từ điện tử được sử dụng và quản lý như hóa đơn', '7': 'Hóa đơn thương mại điện tử',
  '8': 'Hóa đơn điện tử giá trị gia tăng tích hợp biên lai thu thuế, phí, lệ phí', '9': 'Hóa đơn điện tử bán hàng tích hợp biên lai thu thuế, phí, lệ phí',
};
export const invoiceTypeOf = (formNo: string) => FORM_TYPES[formNo.charAt(0)] ?? '';

export interface NoticeLineDto { lineNo: number; einvoiceId: number | null; cqtCode: string | null; formNo: string; serial: string; invoiceNo: string; issueDate: string; invoiceType: string; action: 'notice' | 'explain'; reason: string }
export interface NoticeDto { id: number; noticeKind: string; taxNoticeNo: string | null; taxNoticeDate: string | null; noticeDate: string; place: string; providerId: number | null; status: string; providerRef: string | null; sentAt: string | null; createdAt: string; lines: NoticeLineDto[] }

type NoticeRow = Selectable<Database['einvoice_error_notice']>;
const lineDto = (l: Selectable<Database['einvoice_error_notice_line']>): NoticeLineDto => ({ lineNo: l.line_no, einvoiceId: l.einvoice_id, cqtCode: l.cqt_code, formNo: l.form_no, serial: l.serial, invoiceNo: l.invoice_no, issueDate: l.issue_date,
  invoiceType: l.invoice_type, action: l.action as 'notice' | 'explain', reason: l.reason });
const dto = (n: NoticeRow, lines: Selectable<Database['einvoice_error_notice_line']>[]): NoticeDto => ({ id: n.id, noticeKind: n.notice_kind, taxNoticeNo: n.tax_notice_no, taxNoticeDate: n.tax_notice_date, noticeDate: n.notice_date,
  place: n.place, providerId: n.provider_id, status: n.status, providerRef: n.provider_ref, sentAt: n.sent_at, createdAt: n.created_at as string, lines: lines.map(lineDto) });

export async function loadNotice(trx: Trx, id: number): Promise<NoticeDto> {
  const n = await trx.selectFrom('einvoice_error_notice').selectAll().where('id', '=', id).executeTakeFirst();
  if (!n) throw notFound();
  return dto(n, await trx.selectFrom('einvoice_error_notice_line').selectAll().where('notice_id', '=', id).orderBy('line_no').execute());
}
export async function listNotices(trx: Trx): Promise<NoticeDto[]> {
  const ns = await trx.selectFrom('einvoice_error_notice').selectAll().orderBy('id', 'desc').limit(500).execute();
  const ls = ns.length ? await trx.selectFrom('einvoice_error_notice_line').selectAll().where('notice_id', 'in', ns.map((n) => n.id)).orderBy('line_no').execute() : [];
  return ns.map((n) => dto(n, ls.filter((l) => l.notice_id === n.id)));
}

// Dòng gắn hóa đơn trong phần mềm lấy ký hiệu/số/ngày/mã CQT từ hóa đơn (phải đã có số); dòng nhập tay (hóa đơn lập ngoài phần mềm) phải đủ ký hiệu mẫu, ký hiệu, số, ngày.
async function resolveLines(trx: Trx, b: NoticeInput) {
  if (b.noticeKind === 'tax_notice' && (!b.taxNoticeNo || !b.taxNoticeDate)) throw bad('Thông báo của cơ quan thuế phải ghi số và ngày của thông báo (Mẫu số 01/TB-RSĐT)');
  const want = b.noticeKind === 'self' ? 'notice' : 'explain';
  const seen = new Set<number>(); const providers = new Set<number>();
  const rows = [];
  for (const [i, l] of b.lines.entries()) {
    const where = `Dòng ${i + 1}`;
    if (l.action !== want) throw bad(`${where}: ${b.noticeKind === 'self' ? 'người bán tự thông báo thì cột "Thông báo/Giải trình" là "Thông báo"' : 'cơ quan thuế thông báo thì người nộp thuế "Giải trình"'}`);
    if (l.einvoiceId !== undefined) {
      if (seen.has(l.einvoiceId)) throw bad(`${where}: hóa đơn đã có ở dòng trước`);
      seen.add(l.einvoiceId);
      const e = await trx.selectFrom('einvoice as e').innerJoin('einvoice_series as s', 's.id', 'e.series_id').select(['e.id', 'e.invoice_no', 'e.issue_date', 'e.cqt_code', 'e.provider_id', 's.form_no', 's.serial']).where('e.id', '=', l.einvoiceId).executeTakeFirst();
      if (!e) throw new AppError('EINVOICE_NOT_FOUND', `${where}: không tìm thấy hóa đơn điện tử`, 404);
      if (!e.invoice_no || !e.issue_date) throw new AppError('EINVOICE_NOT_ISSUED', `${where}: hóa đơn điện tử chưa phát hành, chưa có số`, 409);
      providers.add(e.provider_id);
      rows.push({ line_no: i + 1, einvoice_id: e.id, cqt_code: e.cqt_code, form_no: e.form_no, serial: e.serial, invoice_no: e.invoice_no, issue_date: e.issue_date, invoice_type: l.invoiceType || invoiceTypeOf(e.form_no), action: l.action, reason: l.reason });
    } else {
      if (!l.formNo || !l.serial || !l.invoiceNo || !l.issueDate) throw bad(`${where}: hóa đơn ngoài phần mềm phải nhập đủ ký hiệu mẫu, ký hiệu, số hóa đơn và ngày lập`);
      rows.push({ line_no: i + 1, einvoice_id: null, cqt_code: l.cqtCode || null, form_no: l.formNo, serial: l.serial, invoice_no: l.invoiceNo, issue_date: l.issueDate, invoice_type: l.invoiceType || invoiceTypeOf(l.formNo), action: l.action, reason: l.reason });
    }
  }
  const providerId = b.providerId ?? (providers.size === 1 ? [...providers][0]! : null);
  return { rows, providerId };
}

async function write(trx: Trx, tenantId: string, userId: string | null, id: number | null, b: NoticeInput): Promise<NoticeDto> {
  const { rows, providerId } = await resolveLines(trx, b);
  const head = { notice_kind: b.noticeKind, tax_notice_no: b.noticeKind === 'tax_notice' ? b.taxNoticeNo! : null, tax_notice_date: b.noticeKind === 'tax_notice' ? b.taxNoticeDate! : null, notice_date: b.noticeDate, place: b.place, provider_id: providerId };
  let nid = id;
  if (nid === null) nid = (await trx.insertInto('einvoice_error_notice').values({ tenant_id: tenantId, created_by: userId, ...head }).returning('id').executeTakeFirstOrThrow()).id;
  else {
    const cur = await trx.selectFrom('einvoice_error_notice').select('status').where('id', '=', nid).forUpdate().executeTakeFirst();
    if (!cur) throw notFound();
    if (cur.status !== 'draft') throw notDraft();
    await trx.updateTable('einvoice_error_notice').set(head).where('id', '=', nid).execute();
    await trx.deleteFrom('einvoice_error_notice_line').where('notice_id', '=', nid).execute();
  }
  await trx.insertInto('einvoice_error_notice_line').values(rows.map((r) => ({ tenant_id: tenantId, notice_id: nid!, ...r }))).execute();
  return loadNotice(trx, nid);
}
export const createNotice = (trx: Trx, tenantId: string, userId: string | null, b: NoticeInput) => write(trx, tenantId, userId, null, b);
export const updateNotice = (trx: Trx, tenantId: string, userId: string | null, id: number, b: NoticeInput) => write(trx, tenantId, userId, id, b);

export async function deleteNotice(trx: Trx, id: number): Promise<void> {
  const cur = await trx.selectFrom('einvoice_error_notice').select('status').where('id', '=', id).forUpdate().executeTakeFirst();
  if (!cur) throw notFound();
  if (cur.status !== 'draft') throw notDraft();
  await trx.deleteFrom('einvoice_error_notice').where('id', '=', id).execute();
}

// Đánh dấu đã gửi (bản nháp → sent) trong giao dịch ngắn; 409 nếu đã gửi hoặc bị đổi trong lúc gọi nhà cung cấp.
const markSent = async (trx: Trx, id: number, ref: string | null): Promise<NoticeDto> => {
  const u = await trx.updateTable('einvoice_error_notice').set({ status: 'sent', provider_ref: ref, sent_at: sql<string>`now()` }).where('id', '=', id).where('status', '=', 'draft').executeTakeFirst();
  if (!u.numUpdatedRows) throw notDraft();
  return loadNotice(trx, id);
};
export const markNoticeSent = (db: Db, ctx: EInvoiceCtx, id: number, ref: string | null) => withTenant(db, tctx(ctx), (trx) => markSent(trx, id, ref));

// Gửi qua nhà cung cấp. Nhà cung cấp không hỗ trợ (SInvoice): 409 PROVIDER_UNSUPPORTED, in rồi gửi qua cổng thuế/nhà cung cấp và dùng mark-sent.
export async function sendNotice(db: Db, ctx: EInvoiceCtx, id: number, factory: ProviderFactory = providerFor): Promise<NoticeDto> {
  const { provider, doc } = await withTenant(db, tctx(ctx), async (trx) => {
    const n = await loadNotice(trx, id);
    if (n.status !== 'draft') throw notDraft();
    if (n.providerId === null) throw new AppError('ERROR_NOTICE_NO_PROVIDER', 'Thông báo chưa gắn nhà cung cấp hóa đơn điện tử: chọn nhà cung cấp hoặc đánh dấu đã gửi thủ công', 409);
    const provider = await providerRow(trx, n.providerId);
    const refs = n.lines.length ? await trx.selectFrom('einvoice').select(['id', 'provider_ref']).where('id', 'in', n.lines.map((l) => l.einvoiceId).filter((x): x is number => x !== null).concat(0)).execute() : [];
    const doc: ErrorNoticeDoc = { noticeDate: n.noticeDate, lines: n.lines.map((l) => ({ cqtCode: l.cqtCode, invoiceType: l.invoiceType, action: l.action, reason: l.reason,
      original: { formNo: l.formNo, serial: l.serial, invoiceNo: l.invoiceNo, issueDate: l.issueDate, providerRef: (refs.find((r) => r.id === l.einvoiceId)?.provider_ref ?? {}) as Record<string, unknown> } })) };
    return { provider, doc };
  });
  const p = factory(provider);
  if (!p.sendErrorNotice) throw new AppError('PROVIDER_UNSUPPORTED', 'Nhà cung cấp hóa đơn điện tử này chưa hỗ trợ gửi thông báo hóa đơn đã lập sai: in thông báo, gửi qua cổng của nhà cung cấp hoặc cơ quan thuế rồi chọn "Đánh dấu đã gửi"', 409);
  let ref: string;
  try {
    ref = (await withProviderCtx(db, { tenantId: ctx.tenantId, userId: ctx.userId ?? null, providerId: provider.id, einvoiceId: null }, (c) => p.sendErrorNotice!(c, doc))).ref;
  } catch (e) {
    if (e instanceof ProviderError) throw new AppError(e.code, `Nhà cung cấp từ chối thông báo: ${e.message}`, e.retriable ? 502 : 409);
    throw e;
  }
  return markNoticeSent(db, ctx, id, ref);
}
