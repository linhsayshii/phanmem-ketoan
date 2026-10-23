/* eslint-disable @typescript-eslint/no-explicit-any -- JSON tự do của máy chủ giả lập */
import Fastify from 'fastify';
import JSZip from 'jszip';

// Máy chủ giả lập SInvoice theo docs/dev/tich-hop/sinvoice.md (mục 1-5). Ghi lại mọi yêu cầu để kiểm thử so khớp JSON.
export interface Invoice { transactionUuid: string; invoiceNo: string; reservationCode: string; issueDate: number; templateCode: string; paid: boolean; cancelled: boolean; body: Record<string, any> }
export interface Seen { path: string; auth: string | undefined; cookie: string | undefined; body: any; query: Record<string, string> }

export async function startSInvoiceMock(opts: { username?: string; password?: string; serial?: string } = {}) {
  const username = opts.username ?? '0100109106'; const password = opts.password ?? 'p@ss-secret'; const serial = opts.serial ?? 'K24TUT';
  const app = Fastify();
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, b, done) => done(null, Object.fromEntries(new URLSearchParams(b as string))));
  const s = {
    logins: 0, valid: new Set<string>(), seen: [] as Seen[], invoices: new Map<string, Invoice>(), seq: 0,
    hangCreateMs: 0, // > 0: lưu hóa đơn rồi treo lời gọi create (mô phỏng timeout sau khi đã tạo)
    failNext: null as null | { status: number; body: unknown }, // trả lỗi cho lời gọi nghiệp vụ kế tiếp
    duplicateAsError: true, // create trùng uuid trả lỗi nghiệp vụ thay vì trả lại hóa đơn cũ
    pdfEmptyOnce: false,
  };
  app.post('/auth/login', async (req, reply) => {
    const b = req.body as { username?: string; password?: string };
    if (b?.username !== username || b?.password !== password) return reply.status(401).send({ code: 401, error: 'Unauthorized', data: 'Sai tài khoản hoặc mật khẩu' });
    s.logins++; const token = `tok-${s.logins}`; s.valid.add(token);
    return { access_token: token, token_type: 'bearer', refresh_token: 'rt-secret', expires_in: 300, scope: 'x', iat: 1, invoice_cluster: 'c', type: 't', jti: 'j' };
  });
  const P = '/services/einvoiceapplication/api/InvoiceAPI';
  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/auth/')) return;
    const auth = req.headers.authorization; const token = auth?.replace(/^Bearer /, '');
    s.seen.push({ path: req.url.split('?')[0]!, auth, cookie: req.headers.cookie, body: req.body, query: req.query as Record<string, string> });
    if (!token || !s.valid.has(token)) return reply.status(401).send({ code: 401, error: 'Unauthorized', data: 'Token hết hạn' });
    if (s.failNext) { const f = s.failNext; s.failNext = null; return reply.status(f.status).send(f.body); }
  });
  const param = (req: { query: unknown; body: unknown }, k: string) => ((req.query as Record<string, string>)[k] ?? (req.body as Record<string, string> | null)?.[k]);
  app.post(`${P}/InvoiceWS/createInvoice/:tax`, async (req) => {
    const body = req.body as { generalInvoiceInfo: { transactionUuid: string; templateCode: string; invoiceIssuedDate: number } };
    const tax = (req.params as { tax: string }).tax; const uuid = body.generalInvoiceInfo.transactionUuid;
    const old = s.invoices.get(uuid);
    if (old) {
      if (s.duplicateAsError) return { errorCode: 'DUPLICATE_TRANSACTION_UUID', description: 'transactionUuid đã tồn tại', result: null };
      return { errorCode: null, description: null, result: { supplierTaxCode: tax, invoiceNo: old.invoiceNo, reservationCode: old.reservationCode, transactionID: uuid } };
    }
    s.seq++;
    const inv: Invoice = { transactionUuid: uuid, invoiceNo: `${serial}${String(s.seq).padStart(2, '0')}`, reservationCode: `RC${s.seq}`, issueDate: body.generalInvoiceInfo.invoiceIssuedDate,
      templateCode: body.generalInvoiceInfo.templateCode, paid: false, cancelled: false, body: body as Record<string, any> };
    s.invoices.set(uuid, inv);
    if (s.hangCreateMs) await new Promise((r) => setTimeout(r, s.hangCreateMs));
    return { errorCode: null, description: null, result: { supplierTaxCode: tax, invoiceNo: inv.invoiceNo, transactionID: uuid, reservationCode: inv.reservationCode, codeOfTax: null } };
  });
  app.post(`${P}/InvoiceWS/searchInvoiceByTransactionUuid`, async (req) => {
    const inv = s.invoices.get(param(req, 'transactionUuid') ?? '');
    if (!inv) return { transactionUuid: param(req, 'transactionUuid'), errorCode: null, description: null };
    return { transactionUuid: inv.transactionUuid, errorCode: null, description: null,
      result: [{ supplierTaxCode: param(req, 'supplierTaxCode'), invoiceNo: inv.invoiceNo, reservationCode: inv.reservationCode, issueDate: inv.issueDate, templateCode: inv.templateCode,
        status: inv.paid ? 'Đã thanh toán' : 'Chưa thanh toán', exchangeStatus: 'INVOICE_HAS_CODE_APPROVED' }] };
  });
  app.post(`${P}/InvoiceUtilsWS/getInvoiceRepresentationFile`, async (req) => {
    const b = req.body as { fileType: 'PDF' | 'ZIP'; invoiceNo: string };
    if (b.fileType === 'PDF') {
      if (s.pdfEmptyOnce) { s.pdfEmptyOnce = false; return { errorCode: null, description: null, fileToBytes: '', fileName: 'x.pdf', paymentStatus: false }; }
      return { errorCode: null, description: null, fileToBytes: Buffer.from('%PDF-1.4 mock').toString('base64'), fileName: `${b.invoiceNo}.pdf`, paymentStatus: false };
    }
    // ZIP lồng ZIP (mục 4.3): gói ngoài chứa gói trong chứa XML.
    const inner = new JSZip(); inner.file('inv.xml', '<HDon>mock</HDon>');
    const outer = new JSZip(); outer.file('inner.zip', await inner.generateAsync({ type: 'nodebuffer' }));
    return { errorCode: null, description: null, fileToBytes: (await outer.generateAsync({ type: 'nodebuffer' })).toString('base64'), fileName: `${b.invoiceNo}.zip`, paymentStatus: false };
  });
  const byNo = (no: string | undefined) => [...s.invoices.values()].find((i) => i.invoiceNo === no);
  const notFound = { errorCode: 'NOT_FOUND_DATA', description: 'NOT_FOUND_DATA' };
  app.post(`${P}/InvoiceWS/updatePaymentStatus`, async (req) => { const i = byNo(param(req, 'invoiceNo')); if (!i) return notFound; i.paid = true; return { errorCode: null, description: null }; });
  app.post(`${P}/InvoiceWS/cancelPaymentStatus`, async (req) => { const i = byNo(param(req, 'invoiceNo')); if (!i) return notFound; i.paid = false; return { errorCode: null, description: null }; });
  app.post(`${P}/InvoiceWS/cancelTransactionInvoice`, async (req) => { const i = byNo(param(req, 'invoiceNo')); if (!i) return notFound; i.cancelled = true; return { errorCode: null, description: null }; });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { s, baseUrl, username, password, close: () => app.close(), calls: (suffix: string) => s.seen.filter((x) => x.path.endsWith(suffix)) };
}
