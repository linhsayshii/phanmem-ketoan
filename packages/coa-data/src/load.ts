import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoaCsv, splitCsvLine, type CoaTemplateRow, type PayrollAccountMap, type Regime, type Side, type Source } from '@kt/domain';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const COA_REGIMES: Regime[] = ['TT133', 'TT200', 'TT99'];
const SOURCE: Record<string, string> = {
  TT133: 'Phụ lục 1 TT 133/2016/TT-BTC ngày 26/8/2016, Công báo số 1103 + 1104 ngày 12/10/2016, https://congbao.chinhphu.vn/van-ban/thong-tu-so-133-2016-tt-btc-21048/15522.htm',
  TT200: 'Phụ lục 1 TT 200/2014/TT-BTC ngày 22/12/2014, Công báo số 289 + 290 ngày 28/02/2015, https://congbao.chinhphu.vn/van-ban/thong-tu-so-200-2014-tt-btc-6697.htm',
  TT99: 'Phụ lục II TT 99/2025/TT-BTC ngày 27/10/2025, Công báo số 1565 + 1566 ngày 16/11/2025, https://congbao.chinhphu.vn/van-ban/thong-tu-so-99-2025-tt-btc-46529.htm',
};
export function dataPath(...p: string[]): string { return path.join(dataDir, ...p); }
// Tên tiếng Anh tham khảo (data/i18n): chỉ điền khi CSV chưa có name_en; không có trong tệp thì để trống.
const readI18n = (f: string) => JSON.parse(readFileSync(dataPath('i18n', f), 'utf8')) as Record<string, string>;
export function loadCoaTemplate(regime: Regime): CoaTemplateRow[] {
  const en = readI18n('account-names-en.json');
  return parseCoaCsv(readFileSync(dataPath('coa', `${regime.toLowerCase()}.csv`), 'utf8'), regime, SOURCE[regime] ?? regime)
    .map((r) => ({ ...r, nameEn: r.nameEn ?? en[`${regime}:${r.code}`] ?? en[r.code] ?? null }));
}
export function tt99Status(): { complete: boolean; source: string } {
  const p = dataPath('coa', 'tt99.status.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { complete: boolean; source: string }) : { complete: false, source: '' };
}

export interface ClosingStepTemplate { stepOrder: number; name: string; mode: 'transfer' | 'allocate'; fromAccounts: string[]; toAccount: string | null; keepBalance?: string; byDimension?: 'project' | null; ratioSource?: { ratios: { account: string; percent: string }[] } | null; runAt: 'period_end' | 'next_year_start' }
// Sơ đồ kết chuyển mặc định theo chế độ (TT133 không có 521 và 641; TT99 giảm trừ doanh thu kết chuyển thẳng vào 511).
export function loadDefaultClosingSteps(regime: Regime): ClosingStepTemplate[] { return JSON.parse(readFileSync(dataPath('closing-steps', `${regime.toLowerCase()}.json`), 'utf8')) as ClosingStepTemplate[]; }

export interface ReportTemplateRow { regime: Regime; reportCode: string; lineCode: string; label: string; parentLineCode: string | null; source: Source; side: Side; formula: string | null; sortOrder: number; isBold: boolean; negate: boolean; noteRef: string | null; labelEn: string | null }
export type ReportStatus = Record<'tt99' | 'tt133' | 'tt200', Record<string, boolean | string>>;
export const REPORT_REGIMES: Regime[] = ['TT99', 'TT133', 'TT200'];
export const REPORT_CODES = ['B01', 'B02', 'B03'] as const;
const REPORT_HEADER = 'line_code,label,parent_line_code,source,side,formula,is_bold,negate,note_ref';
const SOURCES: string[] = ['balance', 'movement', 'pair', 'lines']; const SIDES: string[] = ['debit', 'credit', 'net_debit', 'net_credit'];
export function reportStatus(): ReportStatus { return JSON.parse(readFileSync(dataPath('reports', 'status.json'), 'utf8')) as ReportStatus; }
export function isReportComplete(regime: Regime, code: string): boolean { return reportStatus()[regime.toLowerCase() as 'tt99' | 'tt133' | 'tt200']?.[code] === true; }
// Chỉ tiêu để 0 cố định và cách lấy số gần đúng của B01/B02/B03 (data/reports/approximations.json); chế độ hoặc báo cáo không có mục thì rỗng.
export interface ReportApprox { fixedZero: string[]; approx: string[] }
export function reportApproximations(regime: string, code: string): ReportApprox {
  const all = JSON.parse(readFileSync(dataPath('reports', 'approximations.json'), 'utf8')) as Record<string, Record<string, ReportApprox> | string>;
  const byRegime = all[regime];
  const r = typeof byRegime === 'object' && Object.hasOwn(byRegime, code) ? byRegime[code] : undefined;
  return r ?? { fixedZero: [], approx: [] };
}
// onlyComplete: chỉ các bộ đã đối chiếu văn bản gốc (status.json = true); bộ chờ văn bản có dòng ví dụ định dạng, không được thành mẫu của công ty.
export function loadReportTemplates(opts: { onlyComplete?: boolean } = {}): ReportTemplateRow[] {
  const out: ReportTemplateRow[] = []; const en = readI18n('report-labels-en.json');
  // Bỏ số thứ tự đầu dòng (I., 1., -) rồi tra từ điển; giữ lại phần số thứ tự ở bản tiếng Anh.
  const labelEn = (label: string) => { const m = /^((?:[IVX]+\.|\d+\.|-)\s+)?(.*)$/s.exec(label)!; const t = en[m[2]!]; return t === undefined ? null : (m[1] ?? '') + t; };
  for (const regime of REPORT_REGIMES) for (const code of REPORT_CODES) {
    const p = dataPath('reports', regime.toLowerCase(), `${code}.csv`); if (!existsSync(p)) continue;
    if (opts.onlyComplete && !isReportComplete(regime, code)) continue;
    const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    if (splitCsvLine(lines[0] ?? '').join(',') !== REPORT_HEADER) throw new Error(`${regime}/${code}.csv: tiêu đề CSV phải là: ${REPORT_HEADER}`);
    lines.slice(1).forEach((l, i) => {
      const c = splitCsvLine(l); const at = `${regime}/${code}.csv dòng ${i + 2}`;
      if (c.length !== 9) throw new Error(`${at}: cần 9 cột`);
      if (!SOURCES.includes(c[3]!)) throw new Error(`${at}: source không hợp lệ "${c[3]}"`);
      if (!SIDES.includes(c[4]!)) throw new Error(`${at}: side không hợp lệ "${c[4]}"`);
      if (!['0', '1'].includes(c[6]!) || !['0', '1'].includes(c[7]!)) throw new Error(`${at}: is_bold và negate phải là 0 hoặc 1`);
      out.push({ regime, reportCode: code, lineCode: c[0]!, label: c[1]!, parentLineCode: c[2] || null, source: c[3] as Source, side: c[4] as Side, formula: c[5] || null, sortOrder: i + 1, isBold: c[6] === '1', negate: c[7] === '1', noteRef: c[8] || null, labelEn: labelEn(c[1]!) });
    });
  }
  return out;
}

// Tài khoản lãi/lỗ chênh lệch tỷ giá theo chế độ (data/tax/fx-rules.json, mỗi chế độ kèm nguồn văn bản); chế độ chưa có trong tệp thì undefined
// Nguồn của bảng fx_rule (syncReferenceData khi migrate); lúc chạy API (fxRulesFor, 409 FX_RULES_MISSING) và SQL đối trừ đều đọc bảng. Sửa tệp thì chạy pnpm db:migrate.
// Đánh giá lại: revalAccount là tài khoản đối ứng của chứng từ DG (413; null thì ghi thẳng gainAccount/lossAccount như TT99), transferToPnl thì chứng từ DG thứ hai
// kết chuyển số ròng của revalAccount sang gainAccount/lossAccount; assetRate/liabilityRate là loại tỷ giá đánh giá lại tài sản (tiền, phải thu)/nợ phải trả.
export type FxRateType = 'transfer_avg' | 'buy' | 'sell';
export interface FxRules { gainAccount: string; lossAccount: string; revalAccount: string | null; transferToPnl: boolean; assetRate: FxRateType; liabilityRate: FxRateType; source: string }
export function loadFxRules(regime: Regime): FxRules | undefined {
  return (JSON.parse(readFileSync(dataPath('tax', 'fx-rules.json'), 'utf8')) as Partial<Record<Regime, FxRules>>)[regime];
}

// Tham số pháp lý theo ngày hiệu lực (data/tax/legal-params.json, mỗi dòng kèm nguồn văn bản); syncReferenceData nạp vào legal_param, API đọc bằng legalParam().
// Cổng dữ liệu pháp lý theo dòng: status.json legalParam_<code>@<validFrom> = false khi dòng còn phần chưa đối chiếu văn bản gốc (nhãn, sync vẫn nạp mọi dòng).
export interface LegalParam { code: string; value: unknown; validFrom: string; validTo: string | null; source: string }
// Tham số lương, TNCN, BHXH nằm ở tệp riêng legal-params-payroll.json (cùng khuôn); loadLegalParams gộp cả hai.
export function loadLegalParams(): LegalParam[] {
  return (['legal-params.json', 'legal-params-payroll.json'] as const).flatMap((f) => JSON.parse(readFileSync(dataPath('tax', f), 'utf8')) as LegalParam[]);
}

// Chỉ tiêu tờ khai 01/GTGT theo phiên bản mẫu (data/tax/01gtgt-tt89.json, 01gtgt-tt80.json), nhập từ văn bản gốc; cổng status.json 01GTGT_TT89, 01GTGT_TT80.
// Chưa có tệp của phiên bản nào thì loadVatTemplate ném lỗi (API trả 409 VAT_TEMPLATE_UNAVAILABLE).
export type VatLineKind = 'flag' | 'carry' | 'invoice' | 'formula' | 'manual';
export interface VatTemplateLine {
  code: string; label: string; section: string; kind: VatLineKind;
  invoice?: { direction: 'purchase' | 'sale'; groups: string[]; field: 'base' | 'tax'; importOnly?: boolean };
  formula?: string; clamp?: 'positivePart' | 'negativePart'; overridable?: boolean; note?: string;
}
export interface VatTemplate { form: '01/GTGT'; version: 'TT89' | 'TT80'; validFrom: string; validTo: string | null; source: string; lines: VatTemplateLine[] }
const VAT_FILE = { TT89: '01gtgt-tt89.json', TT80: '01gtgt-tt80.json' } as const;
export function isVatTemplateComplete(version: 'TT89' | 'TT80'): boolean {
  const p = dataPath('tax', 'status.json');
  return existsSync(p) && (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>)[`01GTGT_${version}`] === true && existsSync(dataPath('tax', VAT_FILE[version]));
}
// Thuế suất 8% (NĐ 174/2025) chưa có căn cứ chỉ tiêu: false thì nhóm 08 gộp tạm vào [32]/[33], tờ khai phải cảnh báo.
export function isVatRate8Verified(): boolean {
  const p = dataPath('tax', 'status.json');
  return existsSync(p) && (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>)['01GTGT_TT89_rate8'] === true;
}
export function loadVatTemplate(version: 'TT89' | 'TT80'): VatTemplate {
  if (!isVatTemplateComplete(version)) throw new Error(`Chưa có mẫu tờ khai 01/GTGT ${version === 'TT80' ? 'theo TT 80/2021/TT-BTC' : 'theo TT 89/2026/TT-BTC'} đối chiếu văn bản gốc (status.json 01GTGT_${version})`);
  return JSON.parse(readFileSync(dataPath('tax', VAT_FILE[version]), 'utf8')) as VatTemplate;
}

// Tờ khai quyết toán thuế TNDN 03/TNDN theo TT 89/2026 (data/tax/03tndn-tt89.json), nhập từ ảnh trang mẫu; cổng status.json 03TNDN_TT89 (false: API 409 CIT_TEMPLATE_UNAVAILABLE).
// kind: section (dòng tiêu đề, không có số), ledger (lấy từ sổ cái: A1, G2), input (nhập tay), formula, rate (thuế suất %), text (chữ: [04]). printed = false: công thức gợi ý của phần mềm, mẫu không in.
export type CitLineKind = 'section' | 'ledger' | 'input' | 'formula' | 'rate' | 'text';
export interface CitTemplateLine { code: string; label: string; section: string; stt: string; kind: CitLineKind; formula?: string; printed?: boolean; clamp?: 'positivePart'; overridable: boolean; note?: string; group?: string }
export interface CitTemplate { form: '03/TNDN'; version: 'TT89'; source: string; lines: CitTemplateLine[]; notes: string[] }
const taxStatus = (): Record<string, unknown> => { const p = dataPath('tax', 'status.json'); return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>) : {}; };
export function isCitTemplateComplete(version: 'TT89'): boolean { return taxStatus()[`03TNDN_${version}`] === true && existsSync(dataPath('tax', '03tndn-tt89.json')); }
// Mẫu 05/KK-TNCN, 05/QTT-TNCN và phụ lục (TT 89/2026 Phụ lục I): data/tax/05kk-tncn-tt89.json, 05qtt-tncn-tt89.json; cổng status.json 05KK_TNCN_TT89, 05QTT_TNCN_TT89 (mẫu đã đối chiếu ảnh trang),
// TNCN_XML_HTKK (định dạng XML HTKK, false: API xuất XML và ký số vẫn 409 TNCN_TEMPLATE_UNAVAILABLE).
export function isTncnTemplateComplete(form: '05KK' | '05QTT'): boolean { return taxStatus()[`${form}_TNCN_TT89`] === true && existsSync(dataPath('tax', form === '05KK' ? '05kk-tncn-tt89.json' : '05qtt-tncn-tt89.json')); }
export function isTncnXmlAvailable(): boolean { return taxStatus().TNCN_XML_HTKK === true; }
// kind: amount (số tiền), count (số người), formula (công thức in trên mẫu), period/flag/text (phần đầu tờ khai). clamp: mẫu in điều kiện >0 hoặc <0 cho kết quả của công thức.
export type TncnLineKind = 'amount' | 'count' | 'formula';
export interface TncnTemplateLine { code: string; label: string; section: string; stt: string; unit: string; kind: TncnLineKind; formula?: string; clamp?: 'positivePart' | 'negativePart'; overridable: boolean; printedAnomaly?: boolean; note?: string }
export interface TncnHeaderField { code: string; label: string; kind: string; note?: string }
export interface TncnAppendixColumn { code: string; label: string; type?: 'amount' | 'count' | 'flag' | 'date' }
export interface TncnAppendixTable { name: string; header?: { code: string; label: string }[]; columns: TncnAppendixColumn[]; totals?: { code: string; column: string }[] }
export interface TncnAppendix { code: string; title: string; note: string; tables: TncnAppendixTable[] }
export interface TncnTemplate { form: '05/KK-TNCN' | '05/QTT-TNCN'; version: 'TT89'; validFrom: string; source: string; periodKinds: ('quarter' | 'year')[]; header: TncnHeaderField[]; lines: TncnTemplateLine[]; appendices: TncnAppendix[]; notes: string[] }
export function loadTncnTemplate(form: '05KK' | '05QTT'): TncnTemplate {
  if (!isTncnTemplateComplete(form)) throw new Error(`Chưa có mẫu tờ khai ${form === '05KK' ? '05/KK-TNCN' : '05/QTT-TNCN'} theo TT 89/2026/TT-BTC đối chiếu văn bản gốc (status.json ${form}_TNCN_TT89)`);
  return JSON.parse(readFileSync(dataPath('tax', form === '05KK' ? '05kk-tncn-tt89.json' : '05qtt-tncn-tt89.json'), 'utf8')) as TncnTemplate;
}
export function loadCitTemplate(version: 'TT89'): CitTemplate {
  if (!isCitTemplateComplete(version)) throw new Error('Chưa có mẫu tờ khai 03/TNDN theo TT 89/2026/TT-BTC đối chiếu văn bản gốc (status.json 03TNDN_TT89)');
  return JSON.parse(readFileSync(dataPath('tax', '03tndn-tt89.json'), 'utf8')) as CitTemplate;
}
// Mẫu 01/TKN-CNKD (Thông báo doanh thu/Tờ khai thuế năm của hộ kinh doanh, TT 89/2026 Phụ lục I, thay 01/CNKD): data/tax/01tkn-cnkd-tt89.json, cổng status.json 01TKN_CNKD_TT89. Mới là định nghĩa mẫu, chưa có logic lập tờ khai.
export interface HkdReturnLine { code: string; label: string; section: string; kind: 'row' | 'total' | 'input' | 'formula' | 'column'; stt?: string; formula?: string; printedAnomaly?: boolean; note?: string }
export interface HkdReturnTemplate { form: '01/TKN-CNKD'; title: string; version: 'TT89'; validFrom: string; validTo: string | null; source: string; printedAnomalies: string[]; applicability: string[]; header: { code: string; label: string; kind: string }[]; sectionA: { title: string; unit: string; columns: { no: string; key: string; label: string }[] }; lines: HkdReturnLine[]; notes: string[] }
export function isHkdReturnTemplateComplete(): boolean { return taxStatus()['01TKN_CNKD_TT89'] === true && existsSync(dataPath('tax', '01tkn-cnkd-tt89.json')); }
export function loadHkdReturnTemplate(): HkdReturnTemplate {
  if (!isHkdReturnTemplateComplete()) throw new Error('Chưa có mẫu 01/TKN-CNKD theo TT 89/2026/TT-BTC đối chiếu văn bản gốc (status.json 01TKN_CNKD_TT89)');
  return JSON.parse(readFileSync(dataPath('tax', '01tkn-cnkd-tt89.json'), 'utf8')) as HkdReturnTemplate;
}
// Ánh xạ sổ cái cho thuế TNDN theo chế độ (data/tax/cit-ledger.json): chỉ tiêu B02 lợi nhuận/doanh thu, tài khoản chi phí thuế, thuế phải nộp, tiền. Chế độ không có trong tệp thì undefined.
export interface CitLedgerMap { profitLine: string; expenseLine: string; revenueLines: string[]; expenseAccount: string; payableAccount: string; cashAccounts: string[] }
export function loadCitLedger(regime: Regime): CitLedgerMap | undefined {
  return (JSON.parse(readFileSync(dataPath('tax', 'cit-ledger.json'), 'utf8')) as Partial<Record<Regime, CitLedgerMap>>)[regime];
}

// Định dạng xuất XML tờ khai cho phần mềm của cơ quan thuế (data/tax/<id>.json): mọi mã đặc thù (tên thẻ, mã tờ khai, phiên bản) nằm ở đây, không nằm trong mã.
// verified = false: chưa đối chiếu với tệp kết xuất thật của HTKK (chưa có XSD công khai); người dùng được cảnh báo khi tải.
export interface TaxXmlFormatData {
  id: string; verified: boolean; note: string; formCode: string; templateVersions: string[]; root: string; encoding: string;
  headerTag: string; bodyTag: string; header: [string, string][]; returnKind: { first: string; supplement: string }; tags: Record<string, string>;
}
export function loadTaxXmlFormat(id: string): TaxXmlFormatData { return JSON.parse(readFileSync(dataPath('tax', `${id}.json`), 'utf8')) as TaxXmlFormatData; }

// Danh sách BIN ngân hàng công khai của VietQR (tải 2026-10-23), không phải văn bản NAPAS chính thức; xem data/banks/napas-bins.status.json.
export interface NapasBin { bin: string; code: string; shortName: string; name: string }
export function loadNapasBins(): NapasBin[] { return JSON.parse(readFileSync(dataPath('banks', 'napas-bins.json'), 'utf8')) as NapasBin[]; }

// Tài khoản lương, bảo hiểm, thuế TNCN theo chế độ (data/payroll/accounts.json, đối chiếu data/coa/*.csv); chế độ chưa có trong tệp thì undefined.
export function loadPayrollAccounts(regime: Regime): PayrollAccountMap | undefined {
  return (JSON.parse(readFileSync(dataPath('payroll', 'accounts.json'), 'utf8')) as Partial<Record<string, PayrollAccountMap>>)[regime.toLowerCase()];
}
