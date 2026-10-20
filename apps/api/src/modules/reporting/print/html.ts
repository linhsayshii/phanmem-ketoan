import { formatVnDate, formatVnNumber } from '@kt/domain';
import { AppError } from '../../../plugins/errors.js';
import { esc, printShell, type CompanyInfo } from './voucherHtml.js';

export interface ReportColumn { key: string; label: string; align?: 'left' | 'right' | 'center'; width?: string; type?: 'text' | 'number' | 'date'; scale?: number }
export interface ReportDoc { title: string; formNo: string; issuedBy: string; company: CompanyInfo; subtitle: string; columns: ReportColumn[]; rows: Record<string, unknown>[]; footer?: Record<string, unknown>; signatures?: string[]; landscape?: boolean; sheetName?: string }

// Số âm trong ngoặc như màn hình báo cáo; chuỗi rỗng khi không có giá trị.
const money = (v: unknown, scale = 0) => { const s = formatVnNumber(v as string | null, scale); return s.startsWith('-') ? `(${s.slice(1)})` : s; };
const isZero = (v: unknown) => /^-?0+(\.0+)?$/.test(String(v));
// Số 0 để trống như sổ giấy, trừ dòng đậm (số dư, cộng, tổng hợp) và dòng cộng cuối bảng (`keepZero`).
const cell = (c: ReportColumn, v: unknown, keepZero: boolean) => esc(c.type === 'number' ? (!keepZero && isZero(v) ? '' : money(v, c.scale)) : c.type === 'date' && v ? formatVnDate(String(v)) : v);

// Chromium dựng được PDF khoảng 50.000 dòng trong 15 giây, từ 75.000 dòng trở lên thì lỗi: chặn từ 40.000 dòng (Excel không bị giới hạn).
export const MAX_PRINT_ROWS = 40_000;
export function assertPrintable(docs: ReportDoc[]): void {
  if (docs.reduce((n, d) => n + d.rows.length, 0) > MAX_PRINT_ROWS) throw new AppError('PRINT_TOO_LARGE', 'Sổ quá lớn để in PDF một lần; hãy xuất Excel hoặc in theo từng sổ/khoảng ngày', 413);
}

export function renderReportBody(d: ReportDoc): string {
  const head = d.columns.map((c) => `<th style="width:${c.width ?? 'auto'}">${esc(c.label)}</th>`).join('');
  const body = d.rows.map((r) => `<tr${r['isBold'] ? ' style="font-weight:bold"' : ''}>${d.columns.map((c) => `<td class="${c.align ?? (c.type === 'number' ? 'num' : '')}">${cell(c, r[c.key], !!r['isBold'])}</td>`).join('')}</tr>`).join('');
  const foot = d.footer ? `<tr style="font-weight:bold">${d.columns.map((c) => `<td class="${c.type === 'number' ? 'num' : ''}">${cell(c, d.footer![c.key], true)}</td>`).join('')}</tr>` : '';
  const signs = (d.signatures ?? ['Người ghi sổ', 'Kế toán trưởng', 'Người đại diện theo pháp luật']).map((s, i) => `<div><b>${esc(s)}</b><i>(Ký, họ tên${i === 2 ? ', đóng dấu' : ''})</i><div class="gap"></div>${i === 1 ? esc(d.company.chiefAccountant ?? '') : i === 2 ? esc(d.company.legalRep ?? '') : ''}</div>`).join('');
  return `<div class="head"><div><b>${esc(d.company.name)}</b>${esc(d.company.address ?? '')}<br>MST: ${esc(d.company.taxCode ?? '')}</div><div style="text-align:right">${d.formNo ? `<b>Mẫu số ${esc(d.formNo)}</b>${esc(d.issuedBy)}` : ''}</div></div>
    <h1>${esc(d.title.toUpperCase())}</h1><div class="sub">${esc(d.subtitle)}</div>
    <table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}${foot}</tbody></table>
    <p style="text-align:right;margin-top:16px"><i>Ngày … tháng … năm …</i></p><div class="sign">${signs}</div>`;
}
// Khổ giấy theo từng sổ (trang có tên): bảng nhiều cột in ngang, sổ khác trong cùng bộ vẫn in dọc. CSS @page của PRINT_CSS làm tùy chọn landscape của Playwright không có tác dụng.
const LANDSCAPE_CSS = '<style>@page land { size: A4 landscape; margin: 12mm } section.land { page: land }</style>';
export const renderReportsHtml = (docs: ReportDoc[]) => printShell(docs[0]?.title ?? 'Sổ kế toán', LANDSCAPE_CSS + docs.map((d, i) => `<section class="${[i < docs.length - 1 ? 'pb' : '', d.landscape ? 'land' : ''].join(' ').trim()}">${renderReportBody(d)}</section>`).join(''));
export const renderReportHtml = (d: ReportDoc) => renderReportsHtml([d]);
export const periodSubtitle = (from: string, to: string) => `Từ ngày ${formatVnDate(from)} đến ngày ${formatVnDate(to)}`;
