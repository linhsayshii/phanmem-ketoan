import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, formatVnNumber, vndInWords, ZERO } from '@kt/domain';
import type { VoucherDto } from '../../ledger/vouchers.service.js';
import { esc, printShell, type CompanyInfo } from './voucherHtml.js';

export interface StockPrintLine { itemCode: string; itemName: string; uomCode: string; quantity: string; unitPrice: string; amount: string; warehouse: string | null; destWarehouse: string | null }

// Dòng hàng của chứng từ (phiếu kho, hóa đơn mua/bán hàng hóa). Thành tiền = tiền hàng trừ chiết khấu; phiếu lắp ráp, tháo dỡ (LR) lọc theo chiều: 02-VT lấy dòng xuất, 01-VT lấy dòng nhập.
export async function stockPrintLines(trx: Transaction<Database>, voucherId: string, form: string, voucherType: string): Promise<StockPrintLine[]> {
  let q = trx.selectFrom('voucher_item_line as l').innerJoin('item as i', 'i.id', 'l.item_id').leftJoin('uom as u', 'u.id', 'l.uom_id')
    .leftJoin('warehouse as w', 'w.id', 'l.warehouse_id').leftJoin('warehouse as dw', 'dw.id', 'l.dest_warehouse_id')
    .select(['i.code as item_code', 'i.name as item_name', 'u.code as uom_code', 'l.quantity', 'l.unit_price', 'l.amount', 'l.discount_amount', 'w.name as wh', 'dw.name as dwh'])
    .where('l.voucher_id', '=', voucherId).where('l.item_id', 'is not', null);
  if (voucherType === 'LR') q = q.where('l.direction', '=', form === '01-VT' ? 'in' : 'out');
  return (await q.orderBy('l.line_no').execute()).map((r) => ({ itemCode: r.item_code, itemName: r.item_name, uomCode: r.uom_code ?? '', quantity: r.quantity ?? '0', unitPrice: r.unit_price ?? '0',
    amount: D(r.amount).minus(r.discount_amount).toFixed(0), warehouse: r.wh, destWarehouse: r.dwh }));
}

const DOTS = '……………………………………';
const val = (s: string | null | undefined) => (s ? `<b>${esc(s)}</b>` : DOTS);
const dateWords = (iso: string) => { const [y, m, d] = iso.split('-'); return `Ngày ${d} tháng ${m} năm ${y}`; };
const accounts = (v: VoucherDto, side: 'debit' | 'credit') => [...new Set(v.lines.filter((l) => D(l[side]).gt(0)).map((l) => l.accountCode))].join(', ');
const qty = (s: string) => formatVnNumber(s, D(s).decimalPlaces());
const sign = (label: string, hint = '(Ký, họ tên)', name?: string | null) => `<div><b>${label}</b><i>${hint}</i><div class="gap"></div>${esc(name ?? '')}</div>`;

// Phiếu nhập kho 01-VT, phiếu xuất kho 02-VT: bố cục, cột và chữ ký chép từ mẫu trong TT 133/2016 (Phụ lục 3) và TT 99/2025 (hai thông tư giống nhau, khác chú thích ban hành).
// showCost = false (người xem không có view_cost): bỏ cột Đơn giá, Thành tiền và dòng tổng số tiền bằng chữ.
export function renderStockVoucherHtml(v: VoucherDto, c: CompanyInfo, lines: StockPrintLine[], o: { form: '01-VT' | '02-VT'; showCost: boolean }): string {
  const inbound = o.form === '01-VT';
  const title = inbound ? 'PHIẾU NHẬP KHO' : 'PHIẾU XUẤT KHO';
  const whs = (pick: (l: StockPrintLine) => string | null) => [...new Set(lines.map(pick).filter((x): x is string => !!x))].join(', ');
  const wh = whs((l) => l.warehouse); const dwh = whs((l) => l.destWarehouse);
  const total = lines.reduce((t, l) => t.plus(l.amount), ZERO).toFixed(0);
  const cost = o.showCost;
  const th = (s: string, extra = '') => `<th${extra}>${s}</th>`;
  const rows = lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.itemName)}</td><td>${esc(l.itemCode)}</td><td>${esc(l.uomCode)}</td><td class="num">${qty(l.quantity)}</td><td class="num">${qty(l.quantity)}</td>`
    + `${cost ? `<td class="num">${formatVnNumber(l.unitPrice, D(l.unitPrice).decimalPlaces())}</td><td class="num">${formatVnNumber(l.amount)}</td>` : ''}</tr>`).join('');
  const who = inbound ? 'Họ và tên người giao' : 'Họ và tên người nhận hàng';
  const body = `<div class="cv">
    <div class="head"><div>Đơn vị: <b>${esc(c.name)}</b><br>Địa chỉ: ${esc(c.address ?? '')}<br>Bộ phận: ${DOTS}</div>`
    + `${c.formNo ? `<div style="text-align:right"><b>Mẫu số ${esc(c.formNo)}</b><br>${esc(c.issuedBy)}</div>` : ''}</div>
    <div class="cv-top"><div class="cv-mid"><h1>${title}</h1><div class="sub">${dateWords(v.postingDate)}</div></div>
      <div class="cv-ref">Số: ${val(v.voucherNo)}<br>Nợ: ${esc(accounts(v, 'debit'))}<br>Có: ${esc(accounts(v, 'credit'))}</div></div>
    <p>- ${who}: ${val(v.personName ?? v.partyName)}${inbound ? '' : ` Địa chỉ (bộ phận): ${val(v.personAddress)}`}</p>
    ${inbound ? `<p>- Theo ............ số ........... ngày ..... tháng ..... năm ..... của ${DOTS}</p>\n    <p>Nhập tại kho: ${val(wh)} địa điểm ${DOTS}</p>`
      : `<p>- Lý do xuất kho: ${val(v.description)}${dwh ? ` (chuyển sang kho: <b>${esc(dwh)}</b>)` : ''}</p>\n    <p>- Xuất tại kho (ngăn lô): ${val(wh)} Địa điểm ${DOTS}</p>`}
    <table class="grid"><thead>
      <tr>${th('STT', ' rowspan="2"')}${th('Tên, nhãn hiệu, quy cách, phẩm chất vật tư, dụng cụ, sản phẩm, hàng hóa', ' rowspan="2"')}${th('Mã số', ' rowspan="2"')}${th('Đơn vị tính', ' rowspan="2"')}${th('Số lượng', ' colspan="2"')}${cost ? `${th('Đơn giá', ' rowspan="2"')}${th('Thành tiền', ' rowspan="2"')}` : ''}</tr>
      <tr>${th(inbound ? 'Theo chứng từ' : 'Yêu cầu')}${th(inbound ? 'Thực nhập' : 'Thực xuất')}</tr>
      <tr><th>A</th><th>B</th><th>C</th><th>D</th><th>1</th><th>2</th>${cost ? '<th>3</th><th>4</th>' : ''}</tr></thead>
    <tbody>${rows}<tr><td colspan="4"><b>Cộng</b></td><td class="num">x</td><td class="num">x</td>${cost ? `<td class="num">x</td><td class="num"><b>${formatVnNumber(total)}</b></td>` : ''}</tr></tbody></table>
    ${cost ? `<p>- Tổng số tiền (viết bằng chữ): <b>${esc(vndInWords(total))}</b></p>` : ''}
    <p>- Số chứng từ gốc kèm theo: ${v.attachmentsCount === null || v.attachmentsCount === undefined ? DOTS : `<b>${v.attachmentsCount}</b>`}</p>
    <div style="text-align:right">Ngày... tháng... năm...</div>
    <div class="sign">${sign('Người lập phiếu')}${sign(inbound ? 'Người giao hàng' : 'Người nhận hàng')}${sign('Thủ kho')}${sign('Kế toán trưởng', '(Hoặc bộ phận có nhu cầu nhập)<br>(Ký, họ tên)', c.chiefAccountant)}${inbound ? '' : sign('Giám đốc', '(Ký, họ tên)', c.legalRep)}</div>
  </div>`;
  return printShell(`${title} ${v.voucherNo ?? ''}`, body);
}
