import type { Readable } from 'node:stream';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import JSZip from 'jszip';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';
import { MAX_INVOICE_XML_BYTES, parseInvoiceXml, stripBom } from './parseXml.js';
import { sha256Of, storeInbound } from './store.js';
import { cleanText, taxCheckWarnings, taxCodeLookupFor, validateLookup, type TaxLookupResult } from './taxCodeLookup.js';

// Giới hạn một lượt tải: số tệp, số phần multipart, dung lượng thô mỗi tệp (zip ≤ 20 MB, XML ≤ 2 MB), tổng dung lượng giải nén cả lượt.
// Mỗi tệp xử lý xong mới đọc tệp kế tiếp nên bộ nhớ chỉ giữ một tệp (hoặc một zip đã giải nén) tại một thời điểm.
export const MAX_UPLOAD_FILES = 50;
export const ZIP_MAX_ENTRIES = 200;
export const ZIP_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const REQUEST_MAX_BYTES = 50 * 1024 * 1024;

interface RowResult { file: string; status: 'new' | 'duplicate' | 'error' | 'skipped'; id?: number; existing?: number; error?: { code: string; message: string } }
const baseName = (n: string) => n.split(/[\\/]/).filter(Boolean).pop() ?? n; // tên mục chỉ để hiển thị, không bao giờ dùng làm đường dẫn
const errRow = (file: string, code: string, message: string): RowResult => ({ file, status: 'error', error: { code, message } });

// Đọc hết luồng nhưng chỉ giữ tối đa `cap` byte; vượt thì trả null (vẫn xả hết luồng để multipart chạy tiếp, luồng đã bị busboy cắt ở 20 MB).
async function readCapped(stream: Readable, cap: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []; let size = 0; let over = false;
  try { for await (const c of stream) { size += (c as Buffer).length; if (size > cap) { over = true; chunks.length = 0; } else if (!over) chunks.push(c as Buffer); } } catch { over = true; }
  return over || (stream as Readable & { truncated?: boolean }).truncated ? null : Buffer.concat(chunks);
}

interface ZipEntry { file: string; data: Buffer | null; skip?: { code: string; message: string } }
async function readZip(buf: Buffer, maxTotal: number): Promise<{ entries: ZipEntry[]; inflated: number }> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(buf); } catch { throw new AppError('ZIP_INVALID', 'Tệp zip hỏng hoặc không đọc được', 400); }
  const all = Object.values(zip.files);
  if (all.length > ZIP_MAX_ENTRIES) throw new AppError('ZIP_TOO_LARGE', `Tệp zip có hơn ${ZIP_MAX_ENTRIES} mục`, 400);
  let total = 0; const entries: ZipEntry[] = [];
  for (const e of all) {
    if (e.dir) continue;
    if (!/\.xml$/i.test(e.name)) {
      entries.push({ file: baseName(e.name), data: null, skip: /\.zip$/i.test(e.name) ? { code: 'SKIPPED_NESTED_ZIP', message: 'Zip lồng trong zip không được mở' } : { code: 'SKIPPED_NOT_XML', message: 'Không phải tệp .xml: bỏ qua' } });
      continue;
    }
    const chunks: Buffer[] = []; let size = 0; let over = false; let totalOver = false;
    await new Promise<void>((resolve, reject) => {
      const s = e.nodeStream('nodebuffer') as Readable;
      s.on('data', (c: Buffer) => {
        size += c.length; total += c.length;
        if (total > maxTotal) { totalOver = true; s.destroy(); } else if (size > MAX_INVOICE_XML_BYTES) { over = true; s.destroy(); } else chunks.push(c);
      });
      s.on('end', resolve); s.on('close', resolve); s.on('error', (err) => (over || totalOver ? resolve() : reject(err)));
    }).catch(() => { throw new AppError('ZIP_INVALID', `Không giải nén được mục "${baseName(e.name)}"`, 400); });
    if (totalOver) throw new AppError('ZIP_TOO_LARGE', `Tổng dung lượng giải nén vượt giới hạn (${Math.floor(maxTotal / 1024 / 1024)} MB)`, 400);
    entries.push({ file: baseName(e.name), data: over ? null : Buffer.concat(chunks) });
  }
  return { entries, inflated: total };
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const asJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

const routes: FastifyPluginAsyncZod = async (app) => {
  const view = app.requirePermission('inbound_invoice.view');
  const create = app.requirePermission('inbound_invoice.create');
  const update = app.requirePermission('inbound_invoice.update');

  app.post('/api/inbound-invoices', { preHandler: create }, async (req) => {
    const tenantId = req.auth!.tenantId!; const userId = req.auth!.userId;
    const results: RowResult[] = []; let used = 0; let seen = 0;
    const mode = await app.withTenant(req, async (trx) => (await getSettings(trx, tenantId)).tax_code_lookup, READ_SNAPSHOT);
    const lookup = taxCodeLookupFor(mode); const cache = new Map<string, Promise<TaxLookupResult | { error: string }>>();
    const check = (mst: string) => {
      if (!cache.has(mst)) cache.set(mst, Promise.resolve().then(() => lookup!.lookup(mst)).then(validateLookup).catch((e: unknown) => ({ error: cleanText(e instanceof Error ? e.message : String(e)) })));
      return cache.get(mst)!;
    };
    // Mọi lỗi của một tệp chỉ thành dòng lỗi của tệp đó; lỗi lạ được ghi nhật ký, không trả chi tiết ra ngoài.
    const run = async (file: string, data: Buffer | null) => {
      try {
        if (data === null) { results.push(errRow(file, 'XML_TOO_LARGE', 'Tệp XML vượt 2 MB (giới hạn thông điệp theo QĐ 1233)')); return; }
        const xml = stripBom(data.toString('utf8'));
        // Tải lại đúng tệp đã có: trả bản cũ, không tra MST ra dịch vụ ngoài.
        const same = await app.withTenant(req, (trx) => trx.selectFrom('inbound_invoice').select('id').where('xml_sha256', '=', sha256Of(xml)).executeTakeFirst(), READ_SNAPSHOT);
        if (same) { results.push({ file, status: 'duplicate', id: same.id, existing: same.id }); return; }
        const parsed = parseInvoiceXml(xml);
        const taxCheck = lookup && parsed.seller.taxCode ? await check(parsed.seller.taxCode) : null; // gọi dịch vụ ngoài ngoài giao dịch
        const r = await app.withTenant(req, (trx) => storeInbound(trx, { tenantId }, xml, 'upload', { receivedBy: userId, parsed, taxCheck }));
        results.push({ file, status: r.status, id: r.id, ...(r.existing !== undefined && { existing: r.existing }) });
      } catch (e) {
        if (e instanceof AppError) results.push(errRow(file, e.code, e.message));
        else { req.log.error({ err: e, file }, 'inbound: lỗi xử lý một tệp'); results.push(errRow(file, 'INTERNAL_ERROR', 'Không xử lý được tệp này')); }
      }
    };
    try {
      for await (const part of req.parts({ throwFileSizeLimit: false, limits: { files: MAX_UPLOAD_FILES, parts: MAX_UPLOAD_FILES + 10, fileSize: ZIP_MAX_TOTAL_BYTES, fieldSize: 1024 } } as Parameters<typeof req.parts>[0])) {
        if (part.type !== 'file') continue;
        seen++;
        const name = baseName(part.filename);
        const isZip = /\.zip$/i.test(name);
        const raw = await readCapped(part.file, isZip ? ZIP_MAX_TOTAL_BYTES : MAX_INVOICE_XML_BYTES);
        if (!isZip && !/\.xml$/i.test(name)) { results.push({ file: name, status: 'skipped', error: { code: 'SKIPPED_NOT_XML', message: 'Chỉ nhận tệp .xml hoặc .zip chứa .xml' } }); continue; }
        if (raw === null) { results.push(errRow(name, isZip ? 'FILE_TOO_LARGE' : 'XML_TOO_LARGE', isZip ? 'Tệp zip vượt 20 MB' : 'Tệp XML vượt 2 MB (giới hạn thông điệp theo QĐ 1233)')); continue; }
        if (!isZip) {
          used += raw.length;
          if (used > REQUEST_MAX_BYTES) { results.push(errRow(name, 'REQUEST_TOO_LARGE', 'Tổng dung lượng một lượt tải vượt 50 MB')); continue; }
          await run(name, raw);
          continue;
        }
        let z: Awaited<ReturnType<typeof readZip>>;
        try { z = await readZip(raw, Math.min(ZIP_MAX_TOTAL_BYTES, REQUEST_MAX_BYTES - used)); } catch (e) {
          if (e instanceof AppError) { results.push(errRow(name, e.code, e.message)); continue; }
          req.log.error({ err: e, file: name }, 'inbound: lỗi đọc zip'); results.push(errRow(name, 'INTERNAL_ERROR', 'Không xử lý được tệp này')); continue;
        }
        used += z.inflated;
        for (const en of z.entries) {
          if (en.skip) results.push({ file: `${name}/${en.file}`, status: 'skipped', error: en.skip }); else await run(`${name}/${en.file}`, en.data);
        }
      }
    } catch (e) {
      const c = (e as { code?: string }).code;
      if (c === 'FST_FILES_LIMIT' || c === 'FST_PARTS_LIMIT') results.push(errRow('(các tệp còn lại)', 'TOO_MANY_FILES', `Mỗi lượt tải tối đa ${MAX_UPLOAD_FILES} tệp: phần còn lại chưa được nhận`));
      else throw e;
    }
    if (seen === 0 && results.length === 0) throw new AppError('NO_FILE', 'Thiếu tệp', 400);
    return { results };
  });

  app.get('/api/inbound-invoices', { preHandler: view, schema: { querystring: z.object({
    status: z.enum(['new', 'voucher_created', 'ignored', 'duplicate']).optional(), from: z.string().date().optional(), to: z.string().date().optional(), q: z.string().trim().max(100).optional(),
  }) } }, async (req) => app.withTenant(req, async (trx) => {
    let q = trx.selectFrom('inbound_invoice').select(['id', 'status', 'source', 'received_at', 'form_no', 'serial', 'invoice_no', 'issue_date', 'seller_tax_code', 'seller_name', 'currency', 'total', 'buyer_matches', 'blocked', 'duplicate_of', 'voucher_id', 'seller_sig', 'warnings']);
    if (req.query.status) q = q.where('status', '=', req.query.status);
    if (req.query.from) q = q.where('issue_date', '>=', req.query.from);
    if (req.query.to) q = q.where('issue_date', '<=', req.query.to);
    if (req.query.q) { const like = `%${req.query.q.replace(/[\\%_]/g, '\\$&')}%`; q = q.where((eb) => eb.or([eb('seller_name', 'ilike', like), eb('seller_tax_code', 'ilike', like), eb('invoice_no', 'ilike', like)])); }
    const rows = await q.orderBy('issue_date', 'desc').orderBy('id', 'desc').limit(500).execute();
    return rows.map((r) => ({
      id: r.id, status: r.status, source: r.source, receivedAt: r.received_at, formNo: r.form_no, serial: r.serial, invoiceNo: r.invoice_no, issueDate: r.issue_date,
      sellerTaxCode: r.seller_tax_code, sellerName: r.seller_name, currency: r.currency, total: r.total, buyerMatches: r.buyer_matches, blocked: r.blocked, duplicateOf: r.duplicate_of, voucherId: r.voucher_id,
      signature: r.seller_sig === null ? 'none' : (asJson(r.seller_sig) as { valid: boolean }).valid ? 'valid' : 'invalid', warningCount: (asJson(r.warnings) as unknown[]).length,
    }));
  }, READ_SNAPSHOT));

  app.get('/api/inbound-invoices/:id', { preHandler: view, schema: { params: idParam } }, async (req) => app.withTenant(req, async (trx) => {
    const r = await trx.selectFrom('inbound_invoice').selectAll().where('id', '=', req.params.id).executeTakeFirst().then((x) => x ?? notFound());
    const lines = await trx.selectFrom('inbound_invoice_line').selectAll().where('invoice_id', '=', r.id).orderBy('line_no').execute();
    return {
      id: r.id, status: r.status, source: r.source, receivedAt: r.received_at, receivedBy: r.received_by, formNo: r.form_no, serial: r.serial, invoiceNo: r.invoice_no, issueDate: r.issue_date,
      sellerTaxCode: r.seller_tax_code, sellerName: r.seller_name, sellerAddress: r.seller_address, buyerTaxCode: r.buyer_tax_code, buyerName: r.buyer_name, currency: r.currency, fxRate: r.fx_rate,
      totalBeforeTax: r.total_before_tax, totalTax: r.total_tax, total: r.total, cqtCode: r.cqt_code, sellerSig: r.seller_sig, cqtSig: r.cqt_sig, buyerMatches: r.buyer_matches, blocked: r.blocked,
      taxCodeCheck: r.tax_code_check, warnings: r.warnings, duplicateOf: r.duplicate_of, voucherId: r.voucher_id, partyId: r.party_id,
      lines: lines.map((l) => ({ lineNo: l.line_no, kind: l.kind, code: l.code, name: l.name, uom: l.uom, quantity: l.quantity, unitPrice: l.unit_price, discountAmount: l.discount_amount, amount: l.amount, taxRate: l.tax_rate })),
    };
  }, READ_SNAPSHOT));

  app.get('/api/inbound-invoices/:id/xml', { preHandler: view, schema: { params: idParam } }, async (req, reply) => {
    const r = await app.withTenant(req, (trx) => trx.selectFrom('inbound_invoice').select(['xml', 'seller_tax_code', 'serial', 'invoice_no']).where('id', '=', req.params.id).executeTakeFirst());
    if (!r) notFound();
    const fileName = `${r!.seller_tax_code ?? 'hoadon'}_${r!.serial}_${r!.invoice_no}.xml`;
    return reply.type('application/xml; charset=utf-8').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`).send(r!.xml);
  });

  app.post('/api/inbound-invoices/:id/ignore', { preHandler: update, schema: { params: idParam } }, async (req) => app.withTenant(req, async (trx) => {
    const r = await trx.updateTable('inbound_invoice').set({ status: 'ignored' }).where('id', '=', req.params.id).where('status', 'in', ['new', 'duplicate']).returning('id').executeTakeFirst();
    if (!r) {
      if (!(await trx.selectFrom('inbound_invoice').select('id').where('id', '=', req.params.id).executeTakeFirst())) notFound();
      throw new AppError('INBOUND_STATUS', 'Hóa đơn đã nhập thành chứng từ hoặc đã bỏ qua', 409);
    }
    return { ok: true };
  }));

  app.post('/api/inbound-invoices/:id/check-tax-code', { preHandler: update, schema: { params: idParam } }, async (req) => {
    const tenantId = req.auth!.tenantId!;
    const { mode, inv } = await app.withTenant(req, async (trx) => ({
      mode: (await getSettings(trx, tenantId)).tax_code_lookup,
      inv: await trx.selectFrom('inbound_invoice').select(['id', 'seller_tax_code', 'seller_name']).where('id', '=', req.params.id).executeTakeFirst(),
    }), READ_SNAPSHOT);
    if (!inv) notFound();
    const lookup = taxCodeLookupFor(mode);
    if (!lookup) throw new AppError('TAXCODE_LOOKUP_OFF', 'Tra cứu mã số thuế đang tắt: bật ở Cài đặt (gửi MST người bán tới dịch vụ bên thứ ba)', 409);
    if (!inv!.seller_tax_code) throw new AppError('NO_TAX_CODE', 'Hóa đơn không có MST người bán', 422);
    let res: TaxLookupResult;
    try { res = validateLookup(await lookup.lookup(inv!.seller_tax_code)); } catch (e) { throw new AppError('TAXCODE_LOOKUP_FAILED', `Không tra được MST: ${e instanceof Error ? e.message : String(e)}`, 502); }
    await app.withTenant(req, async (trx) => {
      // Thay các cảnh báo TAXCODE_* cũ bằng kết quả mới.
      const cur = await trx.selectFrom('inbound_invoice').select('warnings').where('id', '=', inv!.id).executeTakeFirstOrThrow();
      const kept = (asJson(cur.warnings) as { code: string }[]).filter((w) => !w.code.startsWith('TAXCODE_'));
      await trx.updateTable('inbound_invoice').set({ tax_code_check: JSON.stringify(res), warnings: JSON.stringify([...kept, ...taxCheckWarnings(inv!.seller_name, res)]) }).where('id', '=', inv!.id).execute();
    });
    return res;
  });
};

function notFound(): never { throw new AppError('NOT_FOUND', 'Không tìm thấy hóa đơn đầu vào', 404); }
export default routes;
