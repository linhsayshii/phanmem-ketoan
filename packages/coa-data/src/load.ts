import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoaCsv, splitCsvLine, type CoaTemplateRow, type Regime, type Side, type Source } from '@kt/domain';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const COA_REGIMES: Regime[] = ['TT133', 'TT200', 'TT99'];
const SOURCE: Record<string, string> = {
  TT133: 'SUNSOFT OrgDMTK (chưa đối chiếu Phụ lục 1 TT 133/2016/TT-BTC)',
  TT200: 'SUNSOFT OrgDMTK_200 (chưa đối chiếu Phụ lục 1 TT 200/2014/TT-BTC)',
  TT99: 'Phụ lục II TT 99/2025/TT-BTC (chờ nhập)',
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
export function loadDefaultClosingSteps(): ClosingStepTemplate[] { return JSON.parse(readFileSync(dataPath('closing-steps', 'default.json'), 'utf8')) as ClosingStepTemplate[]; }

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
