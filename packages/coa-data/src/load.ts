import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoaCsv, type CoaTemplateRow, type Regime } from '@kt/domain';

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
