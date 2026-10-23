import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { NetworkError } from '../../../lib/http.js';
import { ProviderError, type EInvoiceProvider, type IssueResult, type OriginalRef, type ProviderCtx } from './types.js';

type Mode = 'ok' | 'reject' | 'timeout_before' | 'timeout_after_create';
interface FakeOptions { mode?: Mode; withCode?: boolean }

const cqtCodeOf = (uuid: string) => createHash('sha256').update(uuid).digest('hex').slice(0, 34).toUpperCase();
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

interface Row { transaction_uuid: string; serial: string; invoice_no: string; issue_date: string; cqt_code: string | null; cancelled: boolean }
const resultOf = (r: Row): IssueResult => ({ invoiceNo: r.invoice_no, issueDate: r.issue_date, cqtCode: r.cqt_code, cqtStatus: r.cqt_code ? 'accepted' : 'none', providerRef: { fake: true, transactionUuid: r.transaction_uuid, serial: r.serial } });

// Nhà cung cấp giả lập: kho trong DB nên số đã cấp sống qua khởi động lại API. `options.mode` điều khiển lỗi để kiểm thử; `options.withCode` cấp mã CQT 34 ký tự hex.
export function fakeProvider(optionsRaw: unknown): EInvoiceProvider {
  const opt = (optionsRaw && typeof optionsRaw === 'object' ? optionsRaw : {}) as FakeOptions;
  const mode: Mode = opt.mode ?? 'ok';
  const byUuid = async (ctx: ProviderCtx, uuid: string) => (await ctx.db.selectFrom('einvoice_fake_store').selectAll().where('transaction_uuid', '=', uuid).executeTakeFirst()) as Row | undefined;
  const bySerialNo = async (ctx: ProviderCtx, ref: OriginalRef) => {
    const r = (await ctx.db.selectFrom('einvoice_fake_store').selectAll().where('serial', '=', ref.serial).where('invoice_no', '=', ref.invoiceNo).executeTakeFirst()) as Row | undefined;
    if (!r) throw new ProviderError('FAKE_NOT_FOUND', `Không tìm thấy hóa đơn ${ref.serial}/${ref.invoiceNo} ở nhà cung cấp giả lập`, false);
    return r;
  };
  return {
    code: 'fake',
    async ping() { /* luôn thông */ },
    async create(ctx, doc) {
      const t0 = Date.now();
      const done = (ok: boolean, response: unknown, error?: string) => ctx.log({ action: 'create', request: { transactionUuid: doc.transactionUuid, serial: doc.serial }, response, httpStatus: ok ? 200 : null, ok, ...(error && { error }), ms: Date.now() - t0 });
      if (mode === 'reject') { await done(false, null, 'FAKE_REJECT'); throw new ProviderError('FAKE_REJECT', 'Nhà cung cấp giả lập từ chối hóa đơn', false); }
      if (mode === 'timeout_before') { await done(false, null, 'timeout'); throw new NetworkError('timeout', 'Hết thời gian chờ nhà cung cấp giả lập'); }
      // Cấp số tăng dần theo ký hiệu; khóa tư vấn tránh hai lần cấp song song cùng số. Kiểm trùng uuid SAU khi có khóa
      // (giao dịch đồng thời cùng uuid chờ ở đây rồi thấy bản đã commit, không đụng UNIQUE).
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'einvoice_fake:' + doc.serial}))`.execute(ctx.db);
      const existing = await byUuid(ctx, doc.transactionUuid);
      if (existing) { await done(true, { duplicate: true }); return resultOf(existing); }
      const next = (await sql<{ n: string }>`SELECT (coalesce(max(invoice_no::int), 0) + 1)::text AS n FROM einvoice_fake_store WHERE serial = ${doc.serial}`.execute(ctx.db)).rows[0]!.n;
      const row = await ctx.db.insertInto('einvoice_fake_store').values({ tenant_id: sql<string>`current_setting('app.current_tenant')::uuid`, transaction_uuid: doc.transactionUuid, serial: doc.serial,
        invoice_no: next.padStart(7, '0'), issue_date: doc.issueDate, cqt_code: opt.withCode ? cqtCodeOf(doc.transactionUuid) : null }).returningAll().executeTakeFirstOrThrow() as unknown as Row;
      await done(true, { invoiceNo: row.invoice_no });
      if (mode === 'timeout_after_create') throw new NetworkError('timeout', 'Hết thời gian chờ nhà cung cấp giả lập (đã cấp số)');
      return resultOf(row);
    },
    async findByTransaction(ctx, doc) { const r = await byUuid(ctx, doc.transactionUuid); return r ? resultOf(r) : null; },
    async getFile(ctx, ref, kind) {
      const r = await bySerialNo(ctx, ref);
      if (kind === 'pdf') return Buffer.from(`<html><body><h1>Hóa đơn giả lập ${esc(r.serial)}/${esc(r.invoice_no)}</h1><p>Ngày ${esc(r.issue_date)}</p></body></html>`, 'utf8');
      return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<HDon><DLHDon><TTChung><KHMSHDon>${esc(ref.formNo)}</KHMSHDon><KHHDon>${esc(r.serial)}</KHHDon><SHDon>${Number(r.invoice_no)}</SHDon><NLap>${esc(r.issue_date)}</NLap></TTChung></DLHDon>${r.cqt_code ? `<MCCQT Id="MCCQT">${r.cqt_code}</MCCQT>` : ''}</HDon>`, 'utf8');
    },
    async refreshStatus(ctx, ref) { const r = await bySerialNo(ctx, ref); return { cqtCode: r.cqt_code, cqtStatus: r.cqt_code ? 'accepted' : 'none' }; },
    async cancel(ctx, ref) { await bySerialNo(ctx, ref); await ctx.db.updateTable('einvoice_fake_store').set({ cancelled: true }).where('serial', '=', ref.serial).where('invoice_no', '=', ref.invoiceNo).execute(); },
    async setPaid() { /* giả lập không lưu trạng thái thanh toán */ },
  };
}
