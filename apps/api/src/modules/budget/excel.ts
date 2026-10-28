import ExcelJS from 'exceljs';
import { readSheet, zodIssueVi, type ImportError } from '../master/excelSheet.js';
import type { ColumnDef } from '../master/catalogs.js';
import { lineInput, MONTHS, type LineDto, type LineIn } from './service.js';

// Mẫu: dòng 1 nhãn, dòng 2 khóa kỹ thuật (ẩn), dòng 3 ví dụ (luôn bị bỏ qua), dữ liệu từ dòng 4 (cùng khuôn các mẫu nhập khác).
export const SHEET = 'Du_lieu'; const KEY_ROW = 2; const FIRST_DATA_ROW = 4; const MAX_ROWS = 2000;
export const COLUMNS: ColumnDef[] = [
  { key: 'accountPrefix', label: 'Tài khoản / nhóm tài khoản', type: 'text', required: true },
  { key: 'costItemCode', label: 'Mã khoản mục phí', type: 'text' }, { key: 'departmentCode', label: 'Mã bộ phận', type: 'text' }, { key: 'projectCode', label: 'Mã dự án', type: 'text' },
  ...MONTHS.map((m, i): ColumnDef => ({ key: m, label: `Tháng ${i + 1}`, type: 'number' })),
  { key: 'note', label: 'Ghi chú', type: 'text' },
];

export async function buildBudgetXlsx(lines: LineDto[], opts: { title: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET);
  ws.addRow(COLUMNS.map((c) => c.label + (c.required ? ' (*)' : '')));
  ws.addRow(COLUMNS.map((c) => c.key)); ws.getRow(KEY_ROW).hidden = true;
  ws.addRow(COLUMNS.map((c) => (c.key === 'accountPrefix' ? '642' : c.type === 'number' ? 0 : '')));
  for (const l of lines) {
    const cell = (k: string): string | number => {
      if (k === 'accountPrefix') return l.accountPrefix;
      if (k === 'costItemCode') return l.costItemCode ?? '';
      if (k === 'departmentCode') return l.departmentCode ?? '';
      if (k === 'projectCode') return l.projectCode ?? '';
      if (k === 'note') return l.note ?? '';
      return Number(l.months[MONTHS.indexOf(k as (typeof MONTHS)[number])]); // shortcut: số trên 2^53 mất chính xác trong ô Excel, ngân sách tháng hiếm khi tới mức đó
    };
    ws.addRow(COLUMNS.map((c) => cell(c.key)));
  }
  ws.getRow(1).font = { bold: true }; ws.columns.forEach((col) => { col.width = 16; });
  COLUMNS.forEach((c, i) => { if (c.type === 'number') ws.getColumn(i + 1).numFmt = '#,##0'; else ws.getColumn(i + 1).numFmt = '@'; });
  const hd = wb.addWorksheet('Huong_dan');
  hd.addRow([opts.title]); hd.addRow(['Dòng 3 là ví dụ và luôn bị bỏ qua. Nhập dữ liệu từ dòng 4. Số tiền là đồng nguyên, không âm.']);
  hd.addRow(['Cột tài khoản nhận mã tài khoản hoặc tiền tố (642 gồm 6421, 6422...). Khoản mục phí, bộ phận, dự án để trống nghĩa là mọi giá trị.']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Đọc tệp Excel thành các dòng ngân sách; lỗi theo dòng/cột, không dừng ở lỗi đầu tiên.
export async function parseBudgetXlsx(buf: Buffer): Promise<{ lines: LineIn[]; errors: ImportError[] }> {
  const sheet = await readSheet(buf, { sheet: SHEET, keyRow: KEY_ROW, firstDataRow: FIRST_DATA_ROW, maxRows: MAX_ROWS, columns: COLUMNS, strictKeys: true });
  const errors: ImportError[] = [...sheet.errors]; const bad = new Set(errors.map((e) => e.row)); const lines: LineIn[] = [];
  for (const { row, values } of sheet.rows) {
    if (bad.has(row)) continue;
    const p = lineInput.safeParse({ accountPrefix: String(values['accountPrefix'] ?? ''), costItemCode: values['costItemCode'] ?? null, departmentCode: values['departmentCode'] ?? null, projectCode: values['projectCode'] ?? null,
      months: MONTHS.map((m) => String(values[m] ?? '0')), note: values['note'] ?? null });
    if (p.success) lines.push(p.data);
    else for (const i of p.error.issues) { const key = i.path[0] === 'months' ? MONTHS[Number(i.path[1])]! : String(i.path[0]); errors.push({ row, column: key, message: zodIssueVi(i, COLUMNS.find((c) => c.key === key)?.label ?? key) }); }
  }
  return { lines, errors };
}
