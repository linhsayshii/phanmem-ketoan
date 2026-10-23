import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { formatVnDate } from '@kt/domain';
import type { allocationSheet, assetCard, assetRegister, assetsByLocation, depreciationSheet, movementReport, toolRegister } from '../../assets/reports.js';
import { head } from './stockForms.js';
import { periodSubtitle, type ReportColumn, type ReportDoc } from './html.js';

// Bố cục cột theo mẫu trong văn bản gốc (TT 99/2025 S21-DN, S22-DN, S23-DN, 06-TSCĐ; TT 133/2016 S09-DNN, S10-DNN, S11-DNN, 06-TSCĐ). Tiêu đề nhóm cột của mẫu ghép vào nhãn cột (bảng một tầng).
// Báo cáo tăng giảm, sổ CCDC/CPTT và bảng phân bổ CCDC/CPTT là mẫu quản trị (không phải toàn bộ 07-VT): không in "Mẫu số".
type Trx = Transaction<Database>;
type Row = Record<string, unknown>;
const num = (key: string, label: string, scale = 0): ReportColumn => ({ key, label, type: 'number', scale });
const txt = (key: string, label: string, width?: string): ReportColumn => ({ key, label, ...(width ? { width } : {}) });
const date = (key: string, label: string): ReportColumn => ({ key, label, type: 'date' });
const vn = (iso: string) => formatVnDate(iso);

export async function bookDocs(trx: Trx, tenantId: string, regime: string, r: Awaited<ReturnType<typeof assetRegister>>): Promise<ReportDoc[]> {
  const h = await head(trx, tenantId, regime, 'asset-book');
  const base = { ...h, title: 'Sổ tài sản cố định', subtitle: periodSubtitle(r.from, r.to), landscape: true,
    columns: [txt('stt', 'STT', '5%'), txt('incVoucherNo', 'Ghi tăng - Số hiệu chứng từ'), date('incDate', 'Ghi tăng - Ngày, tháng'), txt('name', 'Tên, đặc điểm, ký hiệu TSCĐ'), txt('country', 'Nước sản xuất'), date('useDate', 'Tháng, năm đưa vào sử dụng'), txt('cardNo', 'Số hiệu TSCĐ'),
      num('cost', 'Nguyên giá TSCĐ'), num('ratePct', 'Khấu hao - Tỷ lệ (%)', 2), num('annualDepreciation', 'Khấu hao - Mức khấu hao'), num('accumulatedAtDecrease', 'Khấu hao đã tính đến khi ghi giảm TSCĐ'),
      txt('decVoucherNo', 'Ghi giảm - Số hiệu chứng từ'), date('decDate', 'Ghi giảm - Ngày, tháng, năm'), txt('decReason', 'Lý do ghi giảm TSCĐ')] satisfies ReportColumn[] };
  if (!r.groups.length) return [{ ...base, sheetName: 'Sổ TSCĐ', intro: ['Loại tài sản: (không có)'], rows: [] }];
  return r.groups.map((g) => ({ ...base, sheetName: `Sổ TSCĐ ${g.categoryCode}`.slice(0, 31), intro: [`Loại tài sản: ${g.categoryName}`], rows: g.rows, footer: { name: 'Cộng', cost: g.totalCost, annualDepreciation: g.totalAnnual } }));
}

export async function locationDocs(trx: Trx, tenantId: string, regime: string, r: Awaited<ReturnType<typeof assetsByLocation>>): Promise<ReportDoc[]> {
  const h = await head(trx, tenantId, regime, 'asset-location');
  const base = { ...h, title: 'Sổ theo dõi TSCĐ và công cụ, dụng cụ tại nơi sử dụng', subtitle: periodSubtitle(r.from, r.to), landscape: true,
    columns: [txt('incVoucherNo', 'Ghi tăng - Số hiệu chứng từ'), date('incDate', 'Ghi tăng - Ngày, tháng'), txt('name', 'Tên, nhãn hiệu, quy cách TSCĐ và công cụ, dụng cụ'), txt('uom', 'Đơn vị tính'), num('incQty', 'Số lượng', 4), num('unitPrice', 'Đơn giá'), num('incAmount', 'Số tiền'),
      txt('decVoucherNo', 'Ghi giảm - Số hiệu chứng từ'), date('decDate', 'Ghi giảm - Ngày, tháng'), txt('decReason', 'Lý do'), num('decQty', 'Số lượng', 4), num('decAmount', 'Số tiền')] satisfies ReportColumn[] };
  if (!r.groups.length) return [{ ...base, sheetName: 'Nơi sử dụng', intro: ['Tên đơn vị (phòng, ban hoặc người sử dụng): (không có)'], rows: [] }];
  return r.groups.map((g) => ({ ...base, sheetName: `Nơi sử dụng ${g.departmentCode}`.trim().slice(0, 31), intro: [`Tên đơn vị (phòng, ban hoặc người sử dụng): ${g.departmentName}`], rows: g.rows, footer: { name: 'Cộng', incAmount: g.totalIncrease, decAmount: g.totalDecrease } }));
}

export async function cardDoc(trx: Trx, tenantId: string, regime: string, c: Awaited<ReturnType<typeof assetCard>>): Promise<ReportDoc> {
  const h = await head(trx, tenantId, regime, 'asset-card'); const a = c.asset;
  const n = Math.max(c.costLines.length, c.wear.length);
  const rows: Row[] = Array.from({ length: n }, (_, i) => ({ ...(c.costLines[i] ?? {}), ...(c.wear[i] ?? {}) }));
  const intro = [`Số: ${a.cardNo ?? a.code}    Mã tài sản: ${a.code}`, `Tên, ký mã hiệu, quy cách (cấp hạng) TSCĐ: ${[a.name, a.spec].filter(Boolean).join(', ')}`,
    `Nước sản xuất (xây dựng): ${a.country ?? ''}    Năm sản xuất: ${a.yearMade ?? ''}`, `Bộ phận quản lý, sử dụng: ${a.departmentName ?? ''}    Ngày đưa vào sử dụng: ${a.useDate ? vn(a.useDate) : ''}`,
    c.suspended ? `Đình chỉ sử dụng TSCĐ ngày ${vn(c.suspended.date)}. Lý do đình chỉ: ${c.suspended.reason}` : 'Đình chỉ sử dụng TSCĐ: không'];
  return { ...h, title: 'Thẻ tài sản cố định', subtitle: `Tính đến ngày ${vn(c.to)}`, sheetName: `Thẻ ${a.code}`.slice(0, 31), intro,
    outro: ['Dụng cụ phụ tùng kèm theo: (không có)', c.decrease ? `Ghi giảm TSCĐ chứng từ số ${c.decrease.voucherNo ?? ''} ngày ${vn(c.decrease.date)}. Lý do giảm: ${c.decrease.reason}` : 'Ghi giảm TSCĐ: chưa có'],
    columns: [txt('voucherNo', 'Số hiệu chứng từ'), date('date', 'Ngày, tháng, năm'), txt('description', 'Diễn giải'), num('amount', 'Nguyên giá'), { key: 'year', label: 'Năm', align: 'center' }, num('value', 'Giá trị hao mòn'), num('accumulated', 'Cộng dồn')], rows };
}

export async function depreciationDoc(trx: Trx, tenantId: string, regime: string, s: Awaited<ReturnType<typeof depreciationSheet>>): Promise<ReportDoc> {
  const h = await head(trx, tenantId, regime, '06-TSCĐ');
  const accCols = s.accounts.map((a) => num(`a_${a}`, a === '(chưa phân bổ)' ? 'Chưa phân bổ' : `TK ${a}`));
  const rows: Row[] = s.rows.map((r) => ({ label: r.label, cost: r.cost, depreciation: r.depreciation, isBold: true, ...Object.fromEntries(Object.entries(r.byAccount).map(([a, v]) => [`a_${a}`, v])) }));
  const byDept = s.rows[3]!.byDepartment; // nơi sử dụng: kỳ này, theo bộ phận
  for (const d of s.departments) rows.push({ label: `    - Bộ phận ${d.code} – ${d.name}`, depreciation: byDept[d.code] ?? '0' });
  return { ...h, title: 'Bảng tính và phân bổ khấu hao TSCĐ', subtitle: `Tháng ${s.periodNo} năm ${s.fiscalYear}`, sheetName: '06-TSCĐ', landscape: true, signatures: ['Người lập bảng', 'Kế toán trưởng'],
    columns: [txt('label', 'Chỉ tiêu'), num('cost', 'Nguyên giá TSCĐ'), num('depreciation', 'Số khấu hao'), ...accCols], rows };
}

export async function allocationDoc(trx: Trx, tenantId: string, regime: string, s: Awaited<ReturnType<typeof allocationSheet>>): Promise<ReportDoc> {
  const h = await head(trx, tenantId, regime, null);
  return { ...h, title: 'Bảng phân bổ công cụ, dụng cụ và chi phí trả trước', subtitle: `Tháng ${s.periodNo} năm ${s.fiscalYear}`, sheetName: 'Phân bổ CCDC', signatures: ['Người lập biểu', 'Kế toán trưởng'],
    columns: [txt('label', 'Đối tượng sử dụng (Ghi Nợ các TK)'), num('tool', 'Có TK 242 - Công cụ, dụng cụ'), num('prepaid', 'Có TK 242 - Chi phí trả trước'), num('total', 'Cộng')],
    rows: s.rows, footer: { label: 'Cộng', ...s.totals } };
}

export async function movementDoc(trx: Trx, tenantId: string, regime: string, r: Awaited<ReturnType<typeof movementReport>>): Promise<ReportDoc> {
  const h = await head(trx, tenantId, regime, null); const what = r.kind === 'fixed' ? 'tài sản cố định' : r.kind === 'tool' ? 'công cụ, dụng cụ' : 'chi phí trả trước';
  return { ...h, title: `Báo cáo tăng giảm ${what}`, subtitle: periodSubtitle(r.from, r.to), sheetName: 'Tăng giảm', landscape: true,
    columns: [txt('categoryName', 'Loại tài sản'), num('openingCost', 'Nguyên giá - Đầu kỳ'), num('increaseCost', 'Nguyên giá - Tăng'), num('decreaseCost', 'Nguyên giá - Giảm'), num('closingCost', 'Nguyên giá - Cuối kỳ'),
      num('openingAccumulated', 'Hao mòn - Đầu kỳ'), num('increaseAccumulated', 'Hao mòn - Tăng'), num('decreaseAccumulated', 'Hao mòn - Giảm'), num('closingAccumulated', 'Hao mòn - Cuối kỳ'), num('openingNet', 'Còn lại - Đầu kỳ'), num('closingNet', 'Còn lại - Cuối kỳ')],
    rows: r.rows, footer: { categoryName: 'Cộng', ...r.totals } };
}

export async function toolRegisterDoc(trx: Trx, tenantId: string, regime: string, r: Awaited<ReturnType<typeof toolRegister>>): Promise<ReportDoc> {
  const h = await head(trx, tenantId, regime, null);
  return { ...h, title: r.kind === 'tool' ? 'Sổ theo dõi công cụ, dụng cụ' : 'Sổ theo dõi chi phí trả trước', subtitle: periodSubtitle(r.from, r.to), sheetName: r.kind === 'tool' ? 'Sổ CCDC' : 'Sổ CPTT', landscape: true,
    columns: [txt('assetCode', 'Mã'), txt('name', 'Tên'), txt('departmentCode', 'Bộ phận'), date('startDate', 'Ngày ghi tăng'), txt('voucherNo', 'Số chứng từ'), num('lifeUnits', 'Số kỳ phân bổ'), num('initial', 'Giá trị ban đầu'), num('allocatedPeriod', 'Phân bổ trong kỳ'),
      num('allocatedTotal', 'Đã phân bổ lũy kế'), num('decreased', 'Ghi giảm'), num('remaining', 'Còn lại cuối kỳ'), num('remainingUnits', 'Số kỳ còn lại', 4)],
    rows: r.rows, footer: { name: 'Cộng', ...r.totals } };
}
