import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoaCsv, splitCsvLine, type CoaTemplateRow, type Regime, type Side, type Source } from '@kt/domain';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const COA_REGIMES: Regime[] = ['TT133', 'TT200', 'TT99'];
const SOURCE: Record<string, string> = {
  TT133: 'Phụ lục 1 TT 133/2016/TT-BTC ngày 26/8/2016, Công báo số 1103 + 1104 ngày 12/10/2016, https://congbao.chinhphu.vn/van-ban/thong-tu-so-133-2016-tt-btc-21048/15522.htm',
  TT200: 'SUNSOFT OrgDMTK_200 (chưa đối chiếu Phụ lục 1 TT 200/2014/TT-BTC)',
  TT99: 'Phụ lục II TT 99/2025/TT-BTC ngày 27/10/2025, Công báo số 1565 + 1566 ngày 16/11/2025, https://congbao.chinhphu.vn/van-ban/thong-tu-so-99-2025-tt-btc-46529.htm',
};
export function dataPath(...p: string[]): string { return path.join(dataDir, ...p); }
export function loadCoaTemplate(regime: Regime): CoaTemplateRow[] {
  return parseCoaCsv(readFileSync(dataPath('coa', `${regime.toLowerCase()}.csv`), 'utf8'), regime, SOURCE[regime] ?? regime);
}
export function tt99Status(): { complete: boolean; source: string } {
  const p = dataPath('coa', 'tt99.status.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { complete: boolean; source: string }) : { complete: false, source: '' };
}

export interface ClosingStepTemplate { stepOrder: number; name: string; mode: 'transfer' | 'allocate'; fromAccounts: string[]; toAccount: string | null; keepBalance?: string; byDimension?: 'project' | null; ratioSource?: { ratios: { account: string; percent: string }[] } | null; runAt: 'period_end' | 'next_year_start' }
// Sơ đồ kết chuyển mặc định theo chế độ (TT133 không có 521 và 641; TT99 giảm trừ doanh thu kết chuyển thẳng vào 511).
export function loadDefaultClosingSteps(regime: Regime): ClosingStepTemplate[] { return JSON.parse(readFileSync(dataPath('closing-steps', `${regime.toLowerCase()}.json`), 'utf8')) as ClosingStepTemplate[]; }

export interface ReportTemplateRow { regime: Regime; reportCode: string; lineCode: string; label: string; parentLineCode: string | null; source: Source; side: Side; formula: string | null; sortOrder: number; isBold: boolean; negate: boolean; noteRef: string | null }
export type ReportStatus = Record<'tt99' | 'tt133', Record<string, boolean | string>>;
export const REPORT_REGIMES: Regime[] = ['TT99', 'TT133'];
export const REPORT_CODES = ['B01', 'B02', 'B03'] as const;
const REPORT_HEADER = 'line_code,label,parent_line_code,source,side,formula,is_bold,negate,note_ref';
const SOURCES: string[] = ['balance', 'movement', 'pair', 'lines']; const SIDES: string[] = ['debit', 'credit', 'net_debit', 'net_credit'];
export function reportStatus(): ReportStatus { return JSON.parse(readFileSync(dataPath('reports', 'status.json'), 'utf8')) as ReportStatus; }
export function isReportComplete(regime: Regime, code: string): boolean { return reportStatus()[regime.toLowerCase() as 'tt99' | 'tt133']?.[code] === true; }
// onlyComplete: chỉ các bộ đã đối chiếu văn bản gốc (status.json = true); bộ chờ văn bản có dòng ví dụ định dạng, không được thành mẫu của công ty.
export function loadReportTemplates(opts: { onlyComplete?: boolean } = {}): ReportTemplateRow[] {
  const out: ReportTemplateRow[] = [];
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
      out.push({ regime, reportCode: code, lineCode: c[0]!, label: c[1]!, parentLineCode: c[2] || null, source: c[3] as Source, side: c[4] as Side, formula: c[5] || null, sortOrder: i + 1, isBold: c[6] === '1', negate: c[7] === '1', noteRef: c[8] || null });
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
export function loadLegalParams(): LegalParam[] { return JSON.parse(readFileSync(dataPath('tax', 'legal-params.json'), 'utf8')) as LegalParam[]; }

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
export function loadCitTemplate(version: 'TT89'): CitTemplate {
  if (!isCitTemplateComplete(version)) throw new Error('Chưa có mẫu tờ khai 03/TNDN theo TT 89/2026/TT-BTC đối chiếu văn bản gốc (status.json 03TNDN_TT89)');
  return JSON.parse(readFileSync(dataPath('tax', '03tndn-tt89.json'), 'utf8')) as CitTemplate;
}
// Ánh xạ sổ cái cho thuế TNDN theo chế độ (data/tax/cit-ledger.json): chỉ tiêu B02 lợi nhuận/doanh thu, tài khoản chi phí thuế, thuế phải nộp, tiền. Chế độ không có trong tệp thì undefined.
export interface CitLedgerMap { profitLine: string; revenueLines: string[]; expenseAccount: string; payableAccount: string; cashAccounts: string[] }
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
