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
    const val = (c: ReportDoc['columns'][number], v: unknown) => c.type === 'number' ? moneyCell(v) : c.type === 'date' && v ? formatVnDate(String(v)) : (v ?? '');
    ws.addRow([d.company.name]); ws.addRow([`Mẫu số ${d.formNo} – ${d.issuedBy}`]); ws.addRow([d.title.toUpperCase()]).font = { bold: true, size: 14 }; ws.addRow([d.subtitle]); ws.addRow([]);
    const header = ws.addRow(d.columns.map((c) => c.label)); header.font = { bold: true };
    for (const r of d.rows) { const row = ws.addRow(d.columns.map((c) => val(c, r[c.key]))); if (r['isBold']) row.font = { bold: true }; }
    if (d.footer) ws.addRow(d.columns.map((c) => val(c, d.footer![c.key]))).font = { bold: true };
    d.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1); col.width = c.type === 'number' ? 18 : c.key === 'description' || c.key === 'label' ? 48 : 16;
      if (c.type === 'number') { col.numFmt = '#,##0;[Red]-#,##0'; col.alignment = { horizontal: 'right' }; }
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
