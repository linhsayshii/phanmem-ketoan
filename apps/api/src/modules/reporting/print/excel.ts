import ExcelJS from 'exceljs';
import { D, formatVnDate } from '@kt/domain';
import type { ReportDoc } from './html.js';

// Tiền đi qua API dạng chuỗi thập phân: chỉ thành ô số khi khứ hồi qua Number() không đổi (số nguyên an toàn của JS);
// còn lại (trên 2^53, có phần lẻ) ghi chuỗi để Excel không làm tròn tiền lặng lẽ.
export function moneyCell(v: unknown): number | string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = D(String(v)).toFixed(); const n = Number(s);
  return Number.isSafeInteger(n) && String(n) === s ? n : s;
}

export async function renderReportXlsx(docs: ReportDoc[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const used = new Set<string>();
  for (const d of docs) {
    // Tên sheet tối đa 31 ký tự, không chứa \ / * ? : [ ], không trùng (không phân biệt hoa thường).
    let name = (d.sheetName ?? d.formNo).replace(/[\\/*?:[\]]/g, '-').slice(0, 28); let k = 1; while (used.has(name.toLowerCase())) name = `${name.slice(0, 25)}(${++k})`; used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name);
    const val = (c: ReportDoc['columns'][number], v: unknown) => c.type === 'number' ? (c.scale && v !== null && v !== undefined && v !== '' ? Number(v) : moneyCell(v)) : c.type === 'date' && v ? formatVnDate(String(v)) : (v ?? '');
    ws.addRow([d.company.name]); if (d.formNo) ws.addRow([`Mẫu số ${d.formNo} – ${d.issuedBy}`]); ws.addRow([d.title.toUpperCase()]).font = { bold: true, size: 14 }; ws.addRow([d.subtitle]); ws.addRow([]);
    const header = ws.addRow(d.columns.map((c) => c.label)); header.font = { bold: true };
    for (const r of d.rows) { const row = ws.addRow(d.columns.map((c) => val(c, r[c.key]))); if (r['isBold']) row.font = { bold: true }; }
    if (d.footer) ws.addRow(d.columns.map((c) => val(c, d.footer![c.key]))).font = { bold: true };
    d.columns.forEach((c, i) => {
      // Rộng theo ô dài nhất của cột (tiêu đề, dòng, dòng cộng), tối đa 60; số tính thêm dấu phân cách hàng nghìn.
      const shown = (v: unknown) => { const t = String(v ?? ''); return typeof v === 'number' ? t.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : t; };
      const longest = Math.max(c.label.length, ...[...d.rows, ...(d.footer ? [d.footer] : [])].map((r) => shown(val(c, r[c.key])).length));
      const col = ws.getColumn(i + 1); col.width = Math.min(60, Math.max(10, longest + 2));
      if (c.type === 'number') { col.numFmt = c.scale ? `#,##0.${'0'.repeat(c.scale)};[Red]-#,##0.${'0'.repeat(c.scale)}` : '#,##0;[Red]-#,##0'; col.alignment = { horizontal: 'right' }; }
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
