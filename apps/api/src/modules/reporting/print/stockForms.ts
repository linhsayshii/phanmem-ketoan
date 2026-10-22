import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D } from '@kt/domain';
import type { Banners, Card, ExpiryRow, Ledger, RegisterRow, SummaryRow } from '../../inventory/reports.js';
import { bookFormFor } from './forms.js';
import { companyInfo } from './bookSet.js';
import { periodSubtitle, type ReportColumn, type ReportDoc } from './html.js';

type Trx = Transaction<Database>;
// Chữ ký in trên mẫu S06-DNN, S08-DNN của TT 133 (văn bản gốc). TT 99 không nêu chữ ký cho S10-DN, S12-DN: dùng chữ ký mặc định như các sổ khác.
const SIGNERS_TT133 = [{ title: 'Người lập biểu' }, { title: 'Kế toán trưởng' }, { title: 'Người đại diện theo pháp luật', note: '(Ký, họ tên, đóng dấu)' }];
// Số lẻ của cột số lượng: đủ để in đúng số lượng lớn nhất trong sổ (tối đa 4), số nguyên in không có phần thập phân.
const qtyScale = (...vals: string[]) => Math.min(4, Math.max(0, ...vals.map((v) => D(v).decimalPlaces())));
const num = (key: string, label: string, scale = 0, width?: string): ReportColumn => ({ key, label, type: 'number', scale, ...(width ? { width } : {}) });
const note = (b: Banners) => b.messages;

// formKey null hoặc chế độ chưa có văn bản gốc: không in "Mẫu số".
async function head(trx: Trx, tenantId: string, regime: string, formKey: string | null) {
  const c = await companyInfo(trx, tenantId, regime, null); const f = formKey ? bookFormFor(regime, formKey) : null;
  return { company: { ...c, formNo: f?.formNo ?? '', issuedBy: f?.issuedBy ?? '' }, formNo: f?.formNo ?? '', issuedBy: f?.issuedBy ?? '', ...(f && regime === 'TT133' ? { signers: SIGNERS_TT133 } : {}) };
}

export async function summaryDoc(trx: Trx, tenantId: string, regime: string, p: { from: string; to: string }, r: { rows: SummaryRow[]; totals: Record<string, string>; banners: Banners }, lot: boolean): Promise<ReportDoc> {
  const qs = qtyScale(...r.rows.flatMap((x) => [x.openingQty, x.inQty, x.outQty, x.closingQty]));
  const h = await head(trx, tenantId, regime, null);
  return { ...h, title: 'Bảng tổng hợp Nhập - Xuất - Tồn kho', subtitle: periodSubtitle(p.from, p.to), sheetName: 'NXT', landscape: true, intro: note(r.banners),
    columns: [{ key: 'itemCode', label: 'Mã hàng' }, { key: 'itemName', label: 'Tên hàng' }, { key: 'uomCode', label: 'ĐVT' }, { key: 'warehouseCode', label: 'Kho' }, ...(lot ? [{ key: 'lotNo', label: 'Lô' }] : []),
      num('openingQty', 'Đầu kỳ SL', qs), num('openingValue', 'Đầu kỳ GT'), num('inQty', 'Nhập SL', qs), num('inValue', 'Nhập GT'), num('outQty', 'Xuất SL', qs), num('outValue', 'Xuất GT'), num('closingQty', 'Cuối kỳ SL', qs), num('closingValue', 'Cuối kỳ GT')],
    rows: r.rows as unknown as Record<string, unknown>[], footer: { itemName: 'Cộng', ...r.totals } };
}

export async function cardDocs(trx: Trx, tenantId: string, regime: string, p: { from: string; to: string }, cards: Card[]): Promise<ReportDoc[]> {
  const h = await head(trx, tenantId, regime, 'stock-card');
  return cards.map((c) => { const qs = qtyScale(c.openingQty, ...c.lines.flatMap((l) => [l.inQty, l.outQty, l.balanceQty]));
    return { ...h, title: 'Thẻ kho (Sổ kho)', subtitle: periodSubtitle(p.from, p.to), sheetName: `Thẻ kho ${c.warehouseCode}`.slice(0, 31),
      intro: [`Tên, nhãn hiệu, quy cách vật tư, dụng cụ, sản phẩm, hàng hóa: ${c.itemName} (${c.itemCode})`, `Đơn vị tính: ${c.uomCode}    Kho: ${c.warehouseName} (${c.warehouseCode})`],
      columns: [{ key: 'stt', label: 'STT', width: '6%' }, { key: 'postingDate', label: 'Ngày, tháng', type: 'date' }, { key: 'inVoucherNo', label: 'Số hiệu chứng từ - Nhập' }, { key: 'outVoucherNo', label: 'Số hiệu chứng từ - Xuất' }, { key: 'description', label: 'Diễn giải' }, num('inQty', 'Nhập', qs), num('outQty', 'Xuất', qs), num('balanceQty', 'Tồn', qs)],
      rows: [{ description: 'Số dư đầu kỳ', balanceQty: c.openingQty, isBold: true }, ...c.lines.map((l, i) => ({ stt: i + 1, ...l })), { description: 'Cộng phát sinh trong kỳ', inQty: c.totalInQty, outQty: c.totalOutQty, balanceQty: c.closingQty, isBold: true }] } as ReportDoc; });
}

export async function ledgerDocs(trx: Trx, tenantId: string, regime: string, p: { from: string; to: string }, ledgers: Ledger[], banners: Banners): Promise<ReportDoc[]> {
  const h = await head(trx, tenantId, regime, 'stock-ledger');
  return ledgers.map((l) => { const qs = qtyScale(l.openingQty, ...l.lines.flatMap((x) => [x.inQty, x.outQty, x.balanceQty]));
    return { ...h, title: regime === 'TT133' ? 'Sổ chi tiết vật liệu, dụng cụ (sản phẩm, hàng hóa)' : 'Sổ chi tiết vật liệu, dụng cụ, sản phẩm, hàng hóa', subtitle: periodSubtitle(p.from, p.to), sheetName: `Sổ ${l.warehouseCode} ${l.itemCode}`.slice(0, 31), landscape: true,
      intro: [`Tài khoản: ${l.accountCode ?? ''}    Tên kho: ${l.warehouseName} (${l.warehouseCode})`, `Tên, quy cách vật tư, dụng cụ, sản phẩm, hàng hóa: ${l.itemName} (${l.itemCode})    Đơn vị tính: ${l.uomCode}`, ...note(banners)],
      columns: [{ key: 'voucherNo', label: 'Số hiệu chứng từ' }, { key: 'postingDate', label: 'Ngày, tháng', type: 'date' }, { key: 'description', label: 'Diễn giải' }, { key: 'counterAccountCode', label: 'TK đối ứng' }, num('unitPrice', 'Đơn giá', 4),
        num('inQty', 'Nhập SL', qs), num('inValue', 'Nhập thành tiền'), num('outQty', 'Xuất SL', qs), num('outValue', 'Xuất thành tiền'), num('balanceQty', 'Tồn SL', qs), num('balanceValue', 'Tồn thành tiền')],
      rows: [{ description: 'Số dư đầu kỳ', balanceQty: l.openingQty, balanceValue: l.openingValue, isBold: true }, ...l.lines,
        { description: 'Cộng phát sinh trong kỳ', inQty: l.totalInQty, inValue: l.totalInValue, outQty: l.totalOutQty, outValue: l.totalOutValue, isBold: true },
        { description: 'Số dư cuối kỳ', balanceQty: l.closingQty, balanceValue: l.closingValue, isBold: true }] } as ReportDoc; });
}

export async function registerDoc(trx: Trx, tenantId: string, regime: string, p: { from: string; to: string; direction: 'in' | 'out' }, r: { rows: RegisterRow[]; totalValue: string; banners: Banners }): Promise<ReportDoc> {
  const qs = qtyScale(...r.rows.map((x) => x.quantity)); const h = await head(trx, tenantId, regime, null);
  return { ...h, title: p.direction === 'in' ? 'Bảng kê nhập kho' : 'Bảng kê xuất kho', subtitle: periodSubtitle(p.from, p.to), sheetName: p.direction === 'in' ? 'Kê nhập' : 'Kê xuất', landscape: true, intro: note(r.banners),
    columns: [{ key: 'postingDate', label: 'Ngày', type: 'date' }, { key: 'voucherNo', label: 'Số chứng từ' }, { key: 'partyName', label: 'Đối tượng' }, { key: 'itemCode', label: 'Mã hàng' }, { key: 'itemName', label: 'Tên hàng' }, { key: 'uomCode', label: 'ĐVT' }, { key: 'warehouseCode', label: 'Kho' }, { key: 'lotNo', label: 'Lô' }, num('quantity', 'Số lượng', qs), num('unitPrice', 'Đơn giá', 4), num('value', 'Thành tiền')],
    rows: r.rows as unknown as Record<string, unknown>[], footer: { itemName: 'Cộng', value: r.totalValue } };
}

export async function expiryDoc(trx: Trx, tenantId: string, regime: string, p: { asOf: string; days: number }, rows: ExpiryRow[]): Promise<ReportDoc> {
  const qs = qtyScale(...rows.map((x) => x.quantity)); const h = await head(trx, tenantId, regime, null);
  return { ...h, title: 'Hàng tồn sắp hết hạn dùng theo lô', subtitle: `Tại ngày ${p.asOf.split('-').reverse().join('/')}, hạn dùng trong ${p.days} ngày tới (số ngày âm: đã quá hạn)`, sheetName: 'Hạn dùng',
    columns: [{ key: 'itemCode', label: 'Mã hàng' }, { key: 'itemName', label: 'Tên hàng' }, { key: 'uomCode', label: 'ĐVT' }, { key: 'warehouseCode', label: 'Kho' }, { key: 'lotNo', label: 'Lô' }, { key: 'expiryDate', label: 'Hạn dùng', type: 'date' }, num('quantity', 'Tồn', qs), num('daysLeft', 'Số ngày còn lại')],
    rows: rows as unknown as Record<string, unknown>[] };
}

export async function reconcileDoc(trx: Trx, tenantId: string, regime: string, r: { asOf: string; differences: Record<string, unknown>[]; byAccountWarehouse: Record<string, unknown>[]; ok: boolean; notes: { message: string }[]; banners: Banners }): Promise<ReportDoc> {
  const h = await head(trx, tenantId, regime, null);
  return { ...h, title: 'Đối chiếu kế toán - thủ kho', subtitle: `Tại ngày ${r.asOf.split('-').reverse().join('/')}`, sheetName: 'Đối chiếu',
    intro: [r.ok ? 'Không có chênh lệch giữa sổ kho, sổ chi tiết giá vốn và sổ cái.' : `Có ${r.differences.length} dòng chênh lệch.`, ...note(r.banners)], outro: r.notes.map((n) => n.message).slice(0, 5),
    columns: [{ key: 'warehouseCode', label: 'Kho' }, { key: 'itemCode', label: 'Mã hàng' }, { key: 'accountCodes', label: 'TK kho' }, num('cardQty', 'SL thẻ kho', 4), num('layerQty', 'SL sổ chi tiết', 4), num('qtyDiff', 'Chênh SL', 4), num('layerValue', 'GT sổ chi tiết'), num('ledgerValue', 'GT sổ cái'), num('valueDiff', 'Chênh GT')],
    rows: r.differences, landscape: true };
}
