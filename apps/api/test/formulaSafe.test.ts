import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { formulaSafe } from '../src/lib/formulaSafe.js';
import { renderReportXlsx } from '../src/modules/reporting/print/excel.js';
import { renderCsv } from '../src/modules/payroll/reports.js';
import type { ReportDoc } from '../src/modules/reporting/print/html.js';

// GĐ6 Task 14a: chống chèn công thức vào CSV/Excel xuất ra.
const doc = (): ReportDoc => ({
  title: '=Bảng lương', sheetName: 'Lương', subtitle: '@kỳ', formNo: '', issuedBy: '', company: { name: '+Công ty' } as ReportDoc['company'], intro: ['-ghi chú'],
  columns: [{ key: 'name', label: '=nhãn', type: 'text' }, { key: 'amount', label: 'Tiền', type: 'number' }, { key: 'date', label: 'Ngày', type: 'date' }],
  rows: [{ name: '=HYPERLINK("http://x","y")', amount: '-1500000', date: '2026-03-31' }, { name: '\tTab', amount: '2000000', date: null }, { name: 'Bình thường', amount: '0', date: null }],
});

describe('formulaSafe', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])('thêm dấu nháy đơn cho %j', (s) => expect(formulaSafe(s)).toBe(`'${s}`));
  it.each(['', 'Nguyễn Văn An', '1500000', "'đã có", 'a=b'])('giữ nguyên %j', (s) => expect(formulaSafe(s)).toBe(s));
  it('giữ nguyên giá trị không phải chuỗi (ô số, rỗng)', () => { expect(formulaSafe(-5)).toBe(-5); expect(formulaSafe(null)).toBeNull(); expect(formulaSafe(undefined)).toBeUndefined(); });

  it('CSV báo cáo lương: ô chữ có nháy, ô tiền âm kiểu số giữ nguyên', () => {
    const lines = renderCsv(doc()).toString('utf8').replace(/^\uFEFF/, '').trimEnd().split('\r\n');
    expect(lines[0]).toBe("'=nhãn,Tiền,Ngày");
    expect(lines[1]).toBe('"\'=HYPERLINK(""http://x"",""y"")",-1500000,31/03/2026');
    expect(lines[2]!.startsWith("'\tTab,2000000")).toBe(true);
    expect(lines[3]).toBe('Bình thường,0,');
  });

  it('Excel: ô chữ có nháy, ô tiền là số thật', async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await renderReportXlsx([doc()])) as never);
    const ws = wb.worksheets[0]!;
    const cells: unknown[] = []; ws.eachRow((r) => cells.push(...(r.values as unknown[]).slice(1)));
    expect(cells).toContain("'+Công ty"); expect(cells).toContain("'=BẢNG LƯƠNG"); expect(cells).toContain("'@kỳ"); expect(cells).toContain("'-ghi chú"); expect(cells).toContain("'=nhãn");
    expect(cells).toContain('\'=HYPERLINK("http://x","y")'); expect(cells).toContain("'\tTab");
    expect(cells).toContain(-1500000); expect(cells).toContain(2000000); // tiền không bị đụng
    expect(cells.some((c) => typeof c === 'object' && c !== null && 'formula' in c)).toBe(false);
  });
});
