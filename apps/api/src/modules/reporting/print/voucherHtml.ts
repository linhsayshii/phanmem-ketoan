import { formatVnDate, formatVnNumber, sum } from '@kt/domain';
import type { VoucherDto } from '../../ledger/vouchers.service.js';

export interface CompanyInfo { name: string; address: string | null; taxCode: string | null; legalRep: string | null; chiefAccountant: string | null; formNo: string; issuedBy: string }
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const PRINT_CSS = `
  @page { size: A4; margin: 12mm; }
  body { font-family: "Times New Roman", "Liberation Serif", serif; font-size: 12pt; color: #000; }
  .head { display: flex; justify-content: space-between; font-size: 10pt; }
  .head b { display: block; }
  h1 { text-align: center; font-size: 16pt; margin: 12px 0 2px; text-transform: uppercase; }
  .sub { text-align: center; margin-bottom: 10px; }
  table.grid { width: 100%; border-collapse: collapse; }
  table.grid th, table.grid td { border: 1px solid #000; padding: 3px 5px; }
  table.grid th { text-align: center; font-weight: bold; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .sign { display: flex; justify-content: space-around; margin-top: 24px; text-align: center; font-size: 11pt; }
  .sign i { display: block; font-size: 10pt; }
  .sign .gap { height: 64px; }
  .pb { page-break-after: always; }
  .cv { line-height: 1.8; }
  .cv p { margin: 4px 0; }
  .cv .head { font-size: 11pt; line-height: 1.4; }
  .cv .head b { display: inline; }
  .cv .head > div:last-child { max-width: 48%; }
  .cv-top { display: flex; align-items: flex-start; }
  .cv-mid { flex: 1; }
  .cv-ref { width: 32%; font-size: 11pt; line-height: 1.5; margin-top: 12px; }
  .cv .sign { margin-bottom: 14px; }
  .cv .note { font-size: 10pt; }
`;

export function printShell(title: string, body: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
}

export function renderVoucherHtml(v: VoucherDto, c: CompanyInfo): string {
  const totalCredit = sum(v.lines.map((l) => l.credit)); // phiếu nháp có thể lệch: không lấy tổng Có theo tổng Nợ
  const rows = v.lines.map((l) => `<tr><td>${l.lineNo}</td><td>${esc(l.description ?? v.description)}</td><td>${esc(l.accountCode)}</td><td>${esc(l.partyCode ?? '')}</td>
      <td class="num">${formatVnNumber(l.debit)}</td><td class="num">${formatVnNumber(l.credit)}</td></tr>`).join('');
  const body = `
    <div class="head"><div><b>${esc(c.name)}</b>${esc(c.address ?? '')}<br>MST: ${esc(c.taxCode ?? '')}</div><div style="text-align:right"><b>Mẫu số ${esc(c.formNo)}</b>${esc(c.issuedBy)}</div></div>
    <h1>PHIẾU KẾ TOÁN</h1>
    <div class="sub">Ngày ${formatVnDate(v.postingDate)} &nbsp;&nbsp; Số: ${esc(v.voucherNo ?? '(chưa cấp số)')}</div>
    <p>Diễn giải: ${esc(v.description ?? '')}${v.partyName ? ` &nbsp;–&nbsp; Đối tượng: ${esc(v.partyName)}` : ''}</p>
    <table class="grid"><thead><tr><th>STT</th><th>Diễn giải</th><th>Tài khoản</th><th>Đối tượng</th><th class="num">Số tiền Nợ</th><th class="num">Số tiền Có</th></tr></thead>
    <tbody>${rows}<tr><td colspan="4"><b>Cộng</b></td><td class="num"><b>${formatVnNumber(v.totalDebit)}</b></td><td class="num"><b>${formatVnNumber(totalCredit)}</b></td></tr></tbody></table>
    <p>Kèm theo: ……… chứng từ gốc.</p>
    <div class="sign"><div><b>Người lập</b><i>(Ký, họ tên)</i><div class="gap"></div></div><div><b>Kế toán trưởng</b><i>(Ký, họ tên)</i><div class="gap"></div>${esc(c.chiefAccountant ?? '')}</div><div><b>Giám đốc</b><i>(Ký, họ tên, đóng dấu)</i><div class="gap"></div>${esc(c.legalRep ?? '')}</div></div>`;
  return printShell(`Phiếu kế toán ${v.voucherNo ?? ''}`, body);
}
