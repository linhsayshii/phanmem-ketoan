import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { D, formatVnNumber, vndInWords } from '@kt/domain';
import { loadBookSet } from '@kt/coa-data';
import { AppError } from '../../plugins/errors.js';
import { assertPrint } from '../reporting/routes.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import { esc, printShell, type CompanyInfo } from '../reporting/print/voucherHtml.js';
import { renderPdf } from '../reporting/print/pdf.js';
import { CASH_IN, CASH_OUT, stockCosting, type Mv } from './books.js';
import type { Trx } from './service.js';

// Chứng từ kế toán của TT 58/2026 (Điều 9 khoản 2): Phiếu thu 01-TT, Phiếu chi 02-TT, Phiếu nhập kho 01-VT, Phiếu xuất kho 02-VT. In từ bút ghi sổ đơn
// (thu, chi tiền mặt ở book_entry; nhập, xuất kho ở book_stock_move), không lưu thêm chứng từ. Bố cục, nhãn và thứ tự chữ ký chép từ mẫu trong văn bản gốc.
export const VOUCHER_FORMS = ['01-TT', '02-TT', '01-VT', '02-VT'] as const;
export type VoucherForm = (typeof VOUCHER_FORMS)[number];

const DOTS = '……………………………………';
const val = (s: string | null | undefined) => (s ? `<b>${esc(s)}</b>` : DOTS);
const dateWords = (iso: string) => { const [y, m, d] = iso.split('-'); return `Ngày ${d} tháng ${m} năm ${y}`; };
const qty = (s: string) => formatVnNumber(s, D(s).decimalPlaces());
const sign = (label: string, hint = '(Ký, ghi rõ họ tên)', name?: string | null) => `<div><b>${label}</b><i>${hint}</i><div class="gap"></div>${esc(name ?? '')}</div>`;
export interface VoucherText { person?: string | undefined; address?: string | undefined; reason?: string | undefined; attachments?: string | undefined; basis?: string | undefined; warehouse?: string | undefined; location?: string | undefined; department?: string | undefined }
const top = (c: CompanyInfo, form: VoucherForm, extraLeft: string) => `<div class="head"><div>ĐƠN VỊ: <b>${esc(c.name)}</b><br>${extraLeft}</div><div style="text-align:right"><b>Mẫu số ${form}</b><br>${esc(c.issuedBy)}</div></div>`;

export interface CashPrint { date: string; docNo: string | null; description: string; amount: string }
// 01-TT, 02-TT: số tiền ghi bằng số và bằng chữ; dòng "Đã nhận đủ số tiền" để trống cho người nhận ký xác nhận.
export function renderCashVoucher(form: '01-TT' | '02-TT', c: CompanyInfo, e: CashPrint, t: VoucherText): string {
  const inbound = form === '01-TT';
  const title = inbound ? 'PHIẾU THU' : 'PHIẾU CHI';
  const [who, reason] = inbound ? ['Họ và tên người nộp tiền', 'Lý do nộp'] : ['Họ và tên người nhận tiền', 'Lý do chi'];
  const cols = inbound
    ? [sign('GIÁM ĐỐC', '(Ký, ghi rõ họ tên, đóng dấu)', c.legalRep), sign('KẾ TOÁN TRƯỞNG', '(Ký, ghi rõ họ tên)', c.chiefAccountant), sign('NGƯỜI NỘP TIỀN'), sign('THỦ QUỸ', '(Ký, họ tên)')]
    : [sign('GIÁM ĐỐC', '(Ký, ghi rõ họ tên, đóng dấu)', c.legalRep), sign('KẾ TOÁN TRƯỞNG', '(Ký, ghi rõ họ tên)', c.chiefAccountant), sign('THỦ QUỸ', '(Ký, họ tên)'), sign('NGƯỜI NHẬN TIỀN')];
  const body = `<div class="cv">
    ${top(c, form, `Địa chỉ: ${esc(c.address ?? '')}`)}
    <div class="cv-top"><div class="cv-mid"><h1>${title}</h1><div class="sub">${dateWords(e.date)}</div></div><div class="cv-ref">Số: ${val(e.docNo)}</div></div>
    <p>${who}: ${val(t.person)}</p>
    <p>Địa chỉ: ${val(t.address)}</p>
    <p>${reason}: ${val(t.reason ?? e.description)}</p>
    <p>Số tiền: <b>${formatVnNumber(e.amount)} đồng</b> (Viết bằng chữ): <b>${esc(vndInWords(e.amount))}</b></p>
    <p>Kèm theo: ${val(t.attachments)} Chứng từ gốc: ${DOTS}</p>
    <div style="text-align:right">Ngày … tháng … năm …</div>
    <div class="sign">${cols.join('')}</div>
    <p>Đã nhận đủ số tiền (viết bằng chữ): ${DOTS}${DOTS}</p>
  </div>`;
  return printShell(`${title} ${e.docNo ?? ''}`, body);
}

export interface StockLinePrint { name: string; code: string; unit: string; quantity: string; unitPrice: string; amount: string }
export interface StockPrint { date: string; docNo: string | null; description: string; lines: StockLinePrint[] }
// 01-VT, 02-VT: chỉ có một số lượng nên in ở cột "Thực nhập"/"Thực xuất"; cột "Theo chứng từ"/"Yêu cầu" để trống cho người lập điền.
export function renderStockVoucher(form: '01-VT' | '02-VT', c: CompanyInfo, s: StockPrint, t: VoucherText, warehouses: string): string {
  const inbound = form === '01-VT';
  const title = inbound ? 'PHIẾU NHẬP KHO' : 'PHIẾU XUẤT KHO';
  const total = s.lines.reduce((a, l) => a.plus(l.amount), D(0)).toFixed(0);
  const rows = s.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.name)}</td><td>${esc(l.code)}</td><td>${esc(l.unit)}</td><td class="num"></td><td class="num">${qty(l.quantity)}</td><td class="num">${formatVnNumber(l.unitPrice, D(l.unitPrice).decimalPlaces())}</td><td class="num">${formatVnNumber(l.amount)}</td></tr>`).join('');
  const th = (x: string, extra = '') => `<th${extra}>${x}</th>`;
  const kho = t.warehouse ?? warehouses;
  const heads = inbound
    ? `<p>- Họ và tên người giao: ${val(t.person)}</p>
    <p>- ${t.basis ? `Theo <b>${esc(t.basis)}</b>` : 'Theo ............ số ........... ngày ..... tháng ..... năm ..... của ......................'}</p>
    <p>Nhập tại kho: ${val(kho)} địa điểm ${val(t.location)}</p>`
    : `<p>- Họ và tên người nhận hàng: ${val(t.person)} Địa chỉ (bộ phận): ${val(t.address)}</p>
    <p>- Lý do xuất kho: ${val(t.reason ?? s.description)}</p>
    <p>- Xuất tại kho (ngăn lô): ${val(kho)} Địa điểm ${val(t.location)}</p>`;
  const cols = inbound
    ? [sign('NGƯỜI GIAO HÀNG'), sign('THỦ KHO'), sign('KẾ TOÁN TRƯỞNG', '(Hoặc bộ phận có nhu cầu nhập)<br>(Ký, ghi rõ họ tên)', c.chiefAccountant)]
    : [sign('NGƯỜI NHẬN HÀNG'), sign('THỦ KHO'), sign('KẾ TOÁN TRƯỞNG', '(Hoặc bộ phận có nhu cầu nhập)<br>(Ký, ghi rõ họ tên)', c.chiefAccountant), sign('GIÁM ĐỐC', '(Ký, ghi rõ họ tên)', c.legalRep)];
  const body = `<div class="cv">
    ${top(c, form, `Bộ phận: ${val(t.department)}`)}
    <div class="cv-top"><div class="cv-mid"><h1>${title}</h1><div class="sub">${dateWords(s.date)}</div></div><div class="cv-ref">Số: ${val(s.docNo)}</div></div>
    ${heads}
    <table class="grid"><thead>
      <tr>${th('STT', ' rowspan="2"')}${th('Tên, nhãn hiệu, quy cách, phẩm chất vật liệu, dụng cụ, sản phẩm, hàng hoá', ' rowspan="2"')}${th('Mã số', ' rowspan="2"')}${th('Đơn vị tính', ' rowspan="2"')}${th('Số lượng', ' colspan="2"')}${th('Đơn giá', ' rowspan="2"')}${th('Thành tiền', ' rowspan="2"')}</tr>
      <tr>${th(inbound ? 'Theo chứng từ' : 'Yêu cầu')}${th(inbound ? 'Thực nhập' : 'Thực xuất')}</tr>
      <tr><th>A</th><th>B</th><th>C</th><th>D</th><th>1</th><th>2</th><th>3</th><th>4</th></tr></thead>
    <tbody>${rows}<tr><td colspan="4"><b>Cộng</b></td><td class="num">x</td><td class="num">x</td><td class="num">x</td><td class="num"><b>${formatVnNumber(total)}</b></td></tr></tbody></table>
    <p>- Tổng số tiền (viết bằng chữ): <b>${esc(vndInWords(total))}</b></p>
    <p>- Số chứng từ gốc kèm theo: ${val(t.attachments)}</p>
    <div style="text-align:right">Ngày … tháng … năm …</div>
    <div class="sign">${cols.join('')}</div>
  </div>`;
  return printShell(`${title} ${s.docNo ?? ''}`, body);
}

async function cashData(trx: Trx, form: '01-TT' | '02-TT', entryId: number): Promise<CashPrint> {
  const e = await trx.selectFrom('book_entry').selectAll().where('id', '=', entryId).executeTakeFirst();
  if (!e) throw new AppError('BOOK_ENTRY_NOT_FOUND', 'Không có bút ghi sổ', 404);
  const kinds = form === '01-TT' ? CASH_IN : CASH_OUT;
  if (e.money_account !== 'TM' || !kinds.has(e.kind)) throw new AppError('VOUCHER_NOT_CASH', `${form === '01-TT' ? 'Phiếu thu' : 'Phiếu chi'} chỉ lập cho bút ghi ${form === '01-TT' ? 'thu' : 'chi'} tiền mặt (ô tiền ghi TM)`, 400);
  return { date: e.entry_date, docNo: e.doc_no, description: e.description, amount: e.amount };
}

async function stockData(trx: Trx, form: '01-VT' | '02-VT', docNo: string): Promise<{ data: StockPrint; warehouses: string }> {
  const dir = form === '01-VT' ? 'in' : 'out';
  const moves = await trx.selectFrom('book_stock_move as m').innerJoin('book_stock_item as i', (j) => j.onRef('i.id', '=', 'm.item_id').onRef('i.tenant_id', '=', 'm.tenant_id'))
    .select(['m.id', 'm.item_id', 'm.move_date', 'm.doc_no', 'm.description', 'm.quantity', 'm.unit_price', 'i.code', 'i.name', 'i.unit', 'i.warehouse'])
    .where('m.doc_no', '=', docNo).where('m.direction', '=', dir).orderBy('m.move_date').orderBy('m.id').execute();
  if (!moves.length) throw new AppError('VOUCHER_NOT_FOUND', `Không có dòng ${dir === 'in' ? 'nhập' : 'xuất'} kho nào mang số chứng từ ${docNo}`, 404);
  const last = moves[moves.length - 1]!.move_date;
  const amounts = new Map<number, string>(); const prices = new Map<number, string>();
  if (dir === 'in') for (const m of moves) { amounts.set(m.id, D(m.quantity).times(m.unit_price!).toDecimalPlaces(0).toFixed()); prices.set(m.id, m.unit_price!); }
  else {
    // Giá, thành tiền xuất: cùng công thức bình quân tháng của sổ S2c-DNSN (stockCosting)
    for (const itemId of new Set(moves.map((m) => m.item_id))) {
      const all: Mv[] = (await trx.selectFrom('book_stock_move').selectAll().where('item_id', '=', itemId).where('move_date', '<=', last).orderBy('move_date').orderBy('id').execute())
        .map((m) => ({ id: m.id, itemId: m.item_id, date: m.move_date, docNo: m.doc_no, desc: m.description, dir: m.direction, qty: D(m.quantity), price: m.unit_price === null ? null : D(m.unit_price) }));
      const { priceOf, outAmt } = stockCosting(all);
      for (const m of moves.filter((x) => x.item_id === itemId)) { amounts.set(m.id, outAmt.get(m.id)!.toFixed()); prices.set(m.id, (priceOf.get(m.move_date.slice(0, 7)) ?? D(0)).toDecimalPlaces(4).toFixed()); }
    }
  }
  const first = moves[0]!;
  return { data: { date: first.move_date, docNo: first.doc_no, description: first.description, lines: moves.map((m) => ({ name: m.name, code: m.code, unit: m.unit, quantity: m.quantity, unitPrice: prices.get(m.id)!, amount: amounts.get(m.id)! })) },
    warehouses: [...new Set(moves.map((m) => m.warehouse).filter((x): x is string => !!x))].join(', ') };
}

const text = (n: number) => z.string().trim().min(1).max(n).optional();
export function registerVoucherRoutes(app: Parameters<FastifyPluginAsyncZod>[0]): void {
  // In chứng từ TT58 từ bút ghi sổ đơn; mẫu nào được in do packages/coa-data/data/books/tt58.json (`vouchers`) quyết định.
  app.get('/api/hkd/vouchers/:form', {
    preHandler: app.requirePermission('sohkd.view'),
    schema: {
      params: z.object({ form: z.enum(VOUCHER_FORMS) }),
      querystring: z.object({ entryId: z.coerce.number().int().positive().optional(), docNo: text(50), format: z.enum(['html', 'pdf']).default('html'),
        person: text(200), address: text(300), reason: text(500), attachments: text(100), basis: text(300), warehouse: text(200), location: text(200), department: text(200) }),
    },
  }, async (req, reply) => {
    assertPrint(req.auth!);
    const form = req.params.form; const q = req.query;
    if (!loadBookSet('TT58').vouchers?.some((v) => v.code === form && v.built)) throw new AppError('VOUCHER_NOT_BUILT', `Chưa dựng mẫu ${form}`, 501);
    const isCash = form === '01-TT' || form === '02-TT';
    if (isCash && q.entryId === undefined) throw new AppError('VALIDATION', 'Phiếu thu, phiếu chi cần entryId của bút ghi sổ', 400);
    if (!isCash && q.docNo === undefined) throw new AppError('VALIDATION', 'Phiếu nhập, xuất kho cần docNo (số chứng từ của các dòng nhập, xuất)', 400);
    const html = await app.withTenant(req, async (trx) => {
      const base = await companyInfo(trx, req.auth!.tenantId!, 'TT58', null); const c = { ...base, formNo: form, issuedBy: loadBookSet('TT58').issuedBy };
      if (form === '01-TT' || form === '02-TT') return renderCashVoucher(form, c, await cashData(trx, form, q.entryId!), q);
      const s = await stockData(trx, form, q.docNo!);
      return renderStockVoucher(form, c, s.data, q, s.warehouses);
    }, READ_SNAPSHOT);
    if (q.format === 'html') return reply.type('text/html; charset=utf-8').send(html);
    return reply.type('application/pdf').header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(form)}.pdf`).send(await renderPdf(html));
  });
}
