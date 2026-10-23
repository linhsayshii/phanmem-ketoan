import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, formatVnDate, formatVnNumber } from '@kt/domain';
import { AppError } from '../../../plugins/errors.js';
import type { CountDto } from '../../assets/assetCount.js';
import type { allocationSheet, assetCard, assetRegister, assetsByLocation, depreciationSheet, movementReport, toolRegister } from '../../assets/reports.js';
import { cell, DOTS, sign } from '../../cash/cashCount.js';
import { regimeOf } from '../ledgers.js';
import { companyInfo } from './bookSet.js';
import { voucherFormFor } from './forms.js';
import { head } from './stockForms.js';
import { esc, printShell, type CompanyInfo } from './voucherHtml.js';
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
      txt('decVoucherNo', 'Ghi giảm - Số hiệu chứng từ'), date('decDate', 'Ghi giảm - Ngày, tháng'), txt('decReason', 'Lý do'), num('decQty', 'Số lượng', 4), num('decAmount', 'Số tiền'), ...(regime === 'TT133' ? [txt('note', 'Ghi chú')] : [])] satisfies ReportColumn[] };
  if (!r.groups.length) return [{ ...base, sheetName: 'Nơi sử dụng', intro: ['Tên đơn vị (phòng, ban hoặc người sử dụng): (không có)'], rows: [] }];
  return r.groups.map((g) => ({ ...base, sheetName: `Nơi sử dụng ${g.departmentCode}`.trim().slice(0, 31), intro: [`Tên đơn vị (phòng, ban hoặc người sử dụng): ${g.departmentName}`], rows: g.rows, footer: { name: 'Cộng', incAmount: g.totalIncrease, decAmount: g.totalDecrease } }));
}

export async function cardDoc(trx: Trx, tenantId: string, regime: string, c: Awaited<ReturnType<typeof assetCard>>): Promise<ReportDoc> {
  const h = await head(trx, tenantId, regime, 'asset-card'); const a = c.asset;
  const n = Math.max(c.costLines.length, c.wear.length);
  const rows: Row[] = Array.from({ length: n }, (_, i) => ({ ...(c.costLines[i] ?? {}), ...(c.wear[i] ?? {}) }));
  const intro = [`Số: ${a.cardNo ?? a.code}    Mã tài sản: ${a.code}`, `Tên, ký mã hiệu, quy cách (cấp hạng) TSCĐ: ${[a.name, a.spec].filter(Boolean).join(', ')}`,
    `Nước sản xuất (xây dựng): ${a.country ?? ''}    Năm sản xuất: ${a.yearMade ?? ''}`, `Bộ phận quản lý, sử dụng: ${a.departmentName ?? ''}    Ngày đưa vào sử dụng: ${a.useDate ? vn(a.useDate) : ''}`,
    'Công suất (diện tích thiết kế): ', 'Căn cứ lập thẻ (biên bản giao nhận TSCĐ số ... ngày ...): ',
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

// ---- Biên bản TSCĐ: 01 - TSCĐ (giao nhận, từ ghi tăng), 02 - TSCĐ (thanh lý, từ ghi giảm lý do thanh lý), 04 - TSCĐ (đánh giá lại), 05 - TSCĐ (kiểm kê). ----
// Bố cục chép từ văn bản gốc (TT 99/2025 dòng 2347-2600 của tt99-full.txt; TT 133/2016 dòng 10416-10610 của tt133-full.txt); số tiền lấy từ dữ liệu biến động đã ghi cùng chứng từ TS, không tính lại.
// Cột cuối "E" của 01 - TSCĐ không có tiêu đề trong văn bản gốc nên không in. Chế độ không có văn bản gốc (TT200) không in dòng "Mẫu số".
export const EVENT_FORMS = { '01-TSCD': { key: '01-TSCĐ', kind: 'increase' }, '02-TSCD': { key: '02-TSCĐ', kind: 'decrease' }, '04-TSCD': { key: '04-TSCĐ', kind: 'revaluation' } } as const;
export type EventFormName = keyof typeof EVENT_FORMS;
const dmy = (iso: string) => { const [y, m, d] = iso.split('-'); return { y: y!, m: m!, d: d! }; };
const money = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '' : formatVnNumber(String(v), 0));
const qty = (v: string | null) => (v === null ? '' : formatVnNumber(v, D(v).decimalPlaces()));
const th = (s: string, o = '') => `<th ${o}>${s}</th>`;
const unitLine = (c: CompanyInfo, dept: string | null) => `<div class="head"><div>Đơn vị: <b>${esc(c.name)}</b><br>Bộ phận: ${dept ? `<b>${esc(dept)}</b>` : '………………'}</div>`
  + `${c.formNo ? `<div style="text-align:right"><b>Mẫu số ${esc(c.formNo)}</b><br>${esc(c.issuedBy)}</div>` : ''}</div>`;
const infoOf = async (trx: Trx, tenantId: string, regime: string, key: string | null): Promise<CompanyInfo> => {
  const f = key ? voucherFormFor(regime, key) : null;
  return { ...(await companyInfo(trx, tenantId, regime, null)), formNo: f?.formNo ?? '', issuedBy: f?.issuedBy ?? '' };
};

export async function eventFormHtml(trx: Trx, tenantId: string, eventId: string, form: EventFormName | undefined): Promise<{ html: string; name: string }> {
  const e = await trx.selectFrom('asset_event as e').innerJoin('asset as a', 'a.id', 'e.asset_id').leftJoin('department as d', 'd.id', 'a.department_id').leftJoin('voucher as v', 'v.id', 'e.voucher_id')
    .select(['e.kind', 'e.event_date', 'e.data', 'e.state', 'a.code', 'a.name', 'a.spec', 'a.card_no', 'a.country', 'a.year_made', 'a.use_date', 'a.kind as asset_kind', 'd.name as dept', 'v.voucher_no'])
    .where('e.id', '=', eventId).executeTakeFirst();
  if (!e) throw new AppError('ASSET_EVENT_NOT_FOUND', 'Không tìm thấy biến động tài sản', 404);
  const f = form ?? (Object.keys(EVENT_FORMS) as EventFormName[]).find((k) => EVENT_FORMS[k].kind === e.kind);
  if (!f || EVENT_FORMS[f].kind !== e.kind) throw new AppError('VALIDATION', 'Biến động này không có biên bản TSCĐ tương ứng (giao nhận: ghi tăng; thanh lý: ghi giảm; đánh giá lại)', 400);
  if (e.asset_kind !== 'fixed') throw new AppError('VALIDATION', 'Biên bản này chỉ in cho tài sản cố định', 400);
  if (e.state === 'cancelled') throw new AppError('ASSET_EVENT_CANCELLED', 'Biến động đã hủy, không in biên bản', 409);
  const dt = e.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (f === '02-TSCD' && dt.reason !== 'liquidation') throw new AppError('VALIDATION', 'Biên bản thanh lý chỉ in cho ghi giảm với lý do thanh lý', 400);
  const regime = await regimeOf(trx, { from: e.event_date, to: e.event_date });
  const c = await infoOf(trx, tenantId, regime, EVENT_FORMS[f].key);
  const t99 = regime === 'TT99';
  const title = { '01-TSCD': 'BIÊN BẢN GIAO NHẬN TSCĐ', '02-TSCD': 'BIÊN BẢN THANH LÝ TSCĐ', '04-TSCD': 'BIÊN BẢN ĐÁNH GIÁ LẠI TSCĐ' }[f];
  const spec = [e.name, e.spec].filter(Boolean).join(', ');
  const t = dmy(e.event_date);
  const no = `<p style="text-align:right">Số: ${e.voucher_no ? `<b>${esc(e.voucher_no)}</b>` : DOTS}<br>Nợ: ${DOTS}<br>Có: ${DOTS}</p>`;
  const basis = (what: string) => `<p>Căn cứ Quyết định số: ………… ngày ….. tháng ….. năm ….. của ${DOTS} về việc ${what}</p>`;
  const people = (roles: string[]) => roles.map((r) => `<p>- Ông/Bà: ${DOTS} &nbsp; Chức vụ: ………… &nbsp; Đại diện: ………… &nbsp; ${r}</p>`).join('');
  let body: string;
  if (f === '01-TSCD') {
    const amount = D(dt.amount ?? '0').toFixed(0);
    body = `${basis('bàn giao TSCĐ ………')}<p>Ban giao nhận TSCĐ gồm:</p>${people(['Đại diện bên giao', 'Đại diện bên nhận', 'Đại diện ………'])}
      <p>Địa điểm giao nhận TSCĐ: ${DOTS}</p><p>Xác nhận việc giao nhận TSCĐ như sau:</p>
      <table class="grid"><thead><tr>${th('STT', 'rowspan="2"')}${th('Tên, ký hiệu, quy cách (cấp hạng) TSCĐ', 'rowspan="2"')}${th(t99 ? 'Số hiệu/Mã TSCĐ' : 'Số hiệu TSCĐ', 'rowspan="2"')}${th('Nước sản xuất (XD)', 'rowspan="2"')}${th('Năm sản xuất', 'rowspan="2"')}${th('Năm đưa vào sử dụng', 'rowspan="2"')}${th('Công suất (diện tích thiết kế)', 'rowspan="2"')}${th('Tính nguyên giá tài sản cố định', 'colspan="5"')}${th('Tài liệu kỹ thuật kèm theo', 'rowspan="2"')}</tr>
        <tr>${th(t99 ? 'Giá mua' : 'Giá mua (ZSX)')}${th('Chi phí vận chuyển')}${th('Chi phí chạy thử')}${th('...')}${th('Nguyên giá TSCĐ')}</tr></thead>
        <tbody><tr>${cell(1)}${cell(esc(spec))}${cell(esc(e.card_no ?? e.code))}${cell(esc(e.country ?? ''))}${cell(e.year_made ?? '')}${cell(e.use_date ? dmy(e.use_date).y : '')}${cell('')}${cell('')}${cell('')}${cell('')}${cell('')}${cell(money(amount), 'num')}${cell('')}</tr>
        <tr><td colspan="11"><b>Cộng</b></td>${cell(money(amount), 'num')}${cell('')}</tr></tbody></table>
      <h3 style="text-align:center">DỤNG CỤ, PHỤ TÙNG KÈM THEO</h3>
      <table class="grid"><thead><tr>${th('Số thứ tự')}${th('Tên, quy cách dụng cụ, phụ tùng')}${th('Đơn vị tính')}${th('Số lượng')}${th('Giá trị')}</tr></thead><tbody><tr>${cell('&nbsp;')}${cell('')}${cell('')}${cell('')}${cell('')}</tr></tbody></table>
      ${sign(['Giám đốc bên nhận', 'Kế toán trưởng bên nhận', 'Người nhận', 'Người giao'])}`;
  } else if (f === '02-TSCD') {
    const cost = D(dt.cost ?? '0'); const acc = D(dt.accumulated ?? '0');
    body = `${basis('thanh lý tài sản cố định.')}<p><b>I. Ban thanh lý TSCĐ gồm:</b></p>${people(['Trưởng ban', 'Ủy viên', 'Ủy viên'])}
      <p><b>II. Tiến hành thanh lý TSCĐ:</b></p>
      <p>- Tên, ký mã hiệu, quy cách (cấp hạng) TSCĐ: <b>${esc(spec)}</b></p><p>- ${t99 ? 'Số hiệu TSCĐ/Mã TSCĐ' : 'Số hiệu TSCĐ'}: <b>${esc(e.code)}</b></p>
      ${t99 ? '' : `<p>- Nước sản xuất (xây dựng): ${e.country ? `<b>${esc(e.country)}</b>` : DOTS}</p>`}
      <p>- Năm sản xuất: ${e.year_made ? `<b>${e.year_made}</b>` : DOTS}</p><p>- Năm đưa vào sử dụng: ${e.use_date ? `<b>${dmy(e.use_date).y}</b>` : DOTS} &nbsp; Số thẻ TSCĐ: <b>${esc(e.card_no ?? e.code)}</b></p>
      <p>- Nguyên giá TSCĐ: <b>${money(cost.toFixed(0))}</b></p><p>- Giá trị hao mòn đã trích đến thời điểm thanh lý: <b>${money(acc.toFixed(0))}</b></p><p>- Giá trị còn lại của TSCĐ: <b>${money(cost.minus(acc).toFixed(0))}</b></p>
      <p><b>III. Kết luận của Ban thanh lý TSCĐ:</b></p><p>${DOTS}${DOTS}</p>
      <p style="text-align:right">Ngày ……… tháng ……… năm …..<br><b>Trưởng Ban thanh lý</b><br><i>(Ký, họ tên)</i></p>
      <p><b>IV. Kết quả thanh lý TSCĐ:</b></p><p>- Chi phí thanh lý TSCĐ: ${DOTS} (viết bằng chữ) ${DOTS}</p><p>- Giá trị thu hồi: ${DOTS} (viết bằng chữ) ${DOTS}</p>
      <p>- Đã ghi giảm sổ TSCĐ ngày <b>${t.d}</b> tháng <b>${t.m}</b> năm <b>${t.y}</b></p>
      <p style="text-align:right">Ngày ……… tháng ……… năm ……</p>${sign(['Giám đốc', 'Kế toán trưởng'])}`;
  } else {
    const b = dt.before ?? {}; const a = dt.after ?? {};
    const bn = D(b.cost ?? 0).minus(b.accumulated ?? 0); const an = D(a.cost ?? 0).minus(a.accumulated ?? 0);
    const dC = D(a.cost ?? 0).minus(b.cost ?? 0); const dA = D(a.accumulated ?? 0).minus(b.accumulated ?? 0); const dN = an.minus(bn);
    const three = ['Nguyên giá', 'Hao mòn', 'Giá trị còn lại'].map((x) => th(x)).join('');
    const ids = `${cell(1)}${cell(esc(spec))}${cell(esc(e.code))}${cell(esc(e.card_no ?? e.code))}`;
    const vals = `${cell(money(b.cost), 'num')}${cell(money(b.accumulated), 'num')}${cell(money(bn.toFixed(0)), 'num')}${cell(money(a.cost), 'num')}${cell(money(a.accumulated), 'num')}${cell(money(an.toFixed(0)), 'num')}`;
    // TT133: ghi chú dưới mẫu cho tách cột "Giá trị còn lại theo đánh giá lại" thành 3 cột; chênh lệch in Tăng, Giảm theo giá trị còn lại.
    const diff = t99 ? `${cell(money(dC.toFixed(0)), 'num')}${cell(money(dA.toFixed(0)), 'num')}${cell(money(dN.toFixed(0)), 'num')}` : `${cell(dN.gt(0) ? money(dN.toFixed(0)) : '', 'num')}${cell(dN.lt(0) ? money(dN.abs().toFixed(0)) : '', 'num')}`;
    const headRows = `<tr>${th('STT', 'rowspan="2"')}${th('Tên, ký mã hiệu, quy cách (cấp hạng) TSCĐ', 'rowspan="2"')}${th('Số hiệu TSCĐ', 'rowspan="2"')}${th('Số thẻ TSCĐ', 'rowspan="2"')}${th('Giá trị đang ghi sổ', 'colspan="3"')}${th('Giá trị còn lại theo đánh giá lại', 'colspan="3"')}${th('Chênh lệch', t99 ? 'colspan="3"' : 'colspan="2"')}</tr>
      <tr>${three}${three}${t99 ? three : th('Tăng') + th('Giảm')}</tr>`;
    body = `${basis('đánh giá lại TSCĐ')}${people(['Chủ tịch Hội đồng', 'Ủy viên', 'Ủy viên'])}<p>Đã thực hiện đánh giá lại giá trị các TSCĐ sau đây:</p>
      <table class="grid"><thead>${headRows}</thead><tbody><tr>${ids}${vals}${diff}</tr><tr><td colspan="4"><b>Cộng</b></td>${vals}${diff}</tr></tbody></table>
      <p>Kết luận: ${DOTS}${DOTS}</p><p style="text-align:right">Ngày ... tháng ... năm ...</p>${sign(['Ủy viên/người lập', 'Kế toán trưởng', 'Chủ tịch Hội đồng'])}`;
  }
  const html = `<div class="cv">${unitLine(c, e.dept)}<h1>${title}</h1><div class="sub">Ngày <b>${t.d}</b> tháng <b>${t.m}</b> năm <b>${t.y}</b></div>${no}${body}</div>`;
  return { name: `${f.toLowerCase()}-${e.code}-${e.event_date}`, html: printShell(`${title} ${e.code}`, html) };
}

// Biên bản kiểm kê TSCĐ (05 - TSCĐ). Công cụ dụng cụ không có mẫu trong văn bản gốc: cùng bố cục, không in "Mẫu số". TT99 là biên bản tổng hợp, có số và cột Đơn vị tính; TT133 không có hai điểm này.
export async function assetCountHtml(trx: Trx, tenantId: string, k: CountDto): Promise<{ html: string; name: string }> {
  const regime = await regimeOf(trx, { from: k.countDate, to: k.countDate }); const t99 = regime === 'TT99'; const fixed = k.kind === 'fixed';
  const c = await infoOf(trx, tenantId, regime, fixed ? '05-TSCĐ' : null);
  const title = fixed ? (t99 ? 'BIÊN BẢN TỔNG HỢP KIỂM KÊ TÀI SẢN CỐ ĐỊNH' : 'BIÊN BẢN KIỂM KÊ TÀI SẢN CỐ ĐỊNH') : 'BIÊN BẢN KIỂM KÊ CÔNG CỤ, DỤNG CỤ';
  const sum = (key: 'bookCost' | 'bookNbv' | 'actualCost' | 'actualNbv' | 'diffCost' | 'diffNbv') => k.lines.reduce((s, l) => s.plus(l[key] ?? 0), D(0)).toFixed(0);
  const body = k.lines.map((l, i) => `<tr>${cell(i + 1)}${cell(esc(l.name))}${cell(esc(l.code))}${t99 ? cell(esc(l.uom ?? '')) : ''}${cell(esc(l.departmentCode ?? ''))}`
    + `${cell(qty(l.bookQuantity), 'num')}${cell(money(l.bookCost), 'num')}${cell(money(l.bookNbv), 'num')}${cell(qty(l.actualQuantity), 'num')}${cell(money(l.actualCost), 'num')}${cell(money(l.actualNbv), 'num')}`
    + `${cell(qty(l.diffQuantity), 'num')}${cell(money(l.diffCost), 'num')}${cell(money(l.diffNbv), 'num')}${cell(esc([l.condition, l.note].filter(Boolean).join('; ')))}</tr>`).join('');
  const lead = t99 ? 5 : 4; const t = dmy(k.countDate);
  const members = k.members.length ? k.members.map((m, i) => `<p>- Ông/Bà: <b>${esc(m.name)}</b> &nbsp; Chức vụ: ${m.position ? `<b>${esc(m.position)}</b>` : '………'} &nbsp; ${esc(m.role ?? (i === 0 ? 'Trưởng ban' : 'Ủy viên'))}</p>`).join('')
    : ['Trưởng ban', 'Ủy viên', 'Ủy viên'].map((r) => `<p>- Ông/Bà: ${DOTS} &nbsp; Chức vụ: ………… &nbsp; ${r}</p>`).join('');
  const three = `${th('Số lượng')}${th('Nguyên giá')}${th('Giá trị còn lại')}`;
  const html = `<div class="cv">${unitLine(c, k.departmentName)}<h1>${title}</h1>${t99 && fixed ? `<p style="text-align:right">Số: <b>${k.id}</b></p>` : ''}
    <p>Thời điểm kiểm kê: ….. giờ ngày <b>${t.d}</b> tháng <b>${t.m}</b> năm <b>${t.y}</b></p><p>Ban kiểm kê gồm:</p>${members}<p>Đã kiểm kê ${fixed ? 'TSCĐ' : 'công cụ, dụng cụ'}, kết quả như sau:</p>
    <table class="grid"><thead><tr>${th('Số TT', 'rowspan="2"')}${th(fixed ? 'Tên TSCĐ' : 'Tên công cụ, dụng cụ', 'rowspan="2"')}${th('Mã số', 'rowspan="2"')}${t99 ? th('Đơn vị tính', 'rowspan="2"') : ''}${th('Nơi sử dụng', 'rowspan="2"')}${th('Theo sổ kế toán', 'colspan="3"')}${th('Theo kiểm kê', 'colspan="3"')}${th('Chênh lệch', 'colspan="3"')}${th('Ghi chú', 'rowspan="2"')}</tr>
    <tr>${three}${three}${three}</tr></thead>
    <tbody>${body}<tr><td colspan="${lead}"><b>Cộng</b></td>${cell('')}${cell(money(sum('bookCost')), 'num')}${cell(money(sum('bookNbv')), 'num')}${cell('')}${cell(money(sum('actualCost')), 'num')}${cell(money(sum('actualNbv')), 'num')}${cell('')}${cell(money(sum('diffCost')), 'num')}${cell(money(sum('diffNbv')), 'num')}${cell('')}</tr></tbody></table>
    <p>- Ý kiến giải quyết số chênh lệch: ${k.note ? esc(k.note) : DOTS}</p><p style="text-align:right">Ngày …… tháng …… năm …..</p>${sign(['Giám đốc', 'Kế toán trưởng', 'Trưởng Ban kiểm kê'])}</div>`;
  return { name: `kiem-ke-${fixed ? 'tscd' : 'ccdc'}-${k.countDate}`, html: printShell(`${title} ${formatVnDate(k.countDate)}`, html) };
}
