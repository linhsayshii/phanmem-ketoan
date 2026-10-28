import { readFileSync } from 'node:fs';
import { dataPath, isReportComplete, tt99Status } from './load.js';

// Chế độ kế toán ghi sổ theo nhóm thuế, chưa có hệ thống tài khoản (TT 58/2026 siêu nhỏ, TT 152/2025 hộ kinh doanh): cổng dữ liệu pháp lý ở data/regimes/status.json.
// gates.* = true chỉ khi phần đó nhập từ văn bản gốc và đối chiếu được; hiện cả hai chế độ chưa có văn bản gốc nên đều false (không bịa).
export type BookRegime = 'TT58' | 'TT152';
export interface RegimeStatus {
  label: string; issuedOn: string; effectiveFrom: string; replaces: string; primaryTextObtained: boolean;
  gates: { coa: boolean; books: boolean; reports: boolean }; note: string;
  booksSecondary: { code: string; name: string | null }[]; reportsSecondary: { code: string; name: string }[];
  sources: { url: string; fetched: string; kind: string; used: string }[]; missing: string[];
}
export function regimeStatus(): Record<BookRegime, RegimeStatus> { return JSON.parse(readFileSync(dataPath('regimes', 'status.json'), 'utf8')) as Record<BookRegime, RegimeStatus>; }
export const isRegimeReady = (r: BookRegime): boolean => Object.values(regimeStatus()[r].gates).every(Boolean);

// ---- Chế độ kế toán doanh nghiệp (TT99, TT133, TT200): hiệu lực theo ngày và cổng dữ liệu, data/regimes/accounting.json ----
export type FullRegime = 'TT99' | 'TT133' | 'TT200';
export interface FullRegimeRule { label: string; effectiveFrom: string | null; effectiveTo: string | null; effectiveVerified: boolean; gates: { coa: boolean; reports: boolean } | null; missing: string[]; source: string }
export function accountingRegimeRules(): Record<FullRegime, FullRegimeRule> { return JSON.parse(readFileSync(dataPath('regimes', 'accounting.json'), 'utf8')) as Record<FullRegime, FullRegimeRule>; }
const isBookRegime = (r: string): r is BookRegime => r === 'TT58' || r === 'TT152';
const isFullRegime = (r: string): r is FullRegime => r === 'TT99' || r === 'TT133' || r === 'TT200';

export interface RegimeCheck { ready: boolean; notReady: string[]; effective: boolean; effectiveFrom: string | null; effectiveTo: string | null; label: string }
// Kiểm chế độ cho năm tài chính bắt đầu ngày `dateFrom` (YYYY-MM-DD). TT99: hai cổng lấy từ tt99.status.json và reports/status.json; TT58, TT152: cổng ở regimes/status.json.
export function checkRegimeForYear(regime: string, dateFrom: string): RegimeCheck {
  if (isBookRegime(regime)) {
    const s = regimeStatus()[regime];
    const notReady = Object.entries(s.gates).filter(([, ok]) => !ok).map(([g]) => g);
    return { ready: notReady.length === 0, notReady, effective: dateFrom >= s.effectiveFrom, effectiveFrom: s.effectiveFrom, effectiveTo: null, label: s.label };
  }
  if (!isFullRegime(regime)) return { ready: false, notReady: ['unknown'], effective: false, effectiveFrom: null, effectiveTo: null, label: regime };
  const r = accountingRegimeRules()[regime];
  const notReady = regime === 'TT99'
    ? [...(tt99Status().complete ? [] : ['coa']), ...(['B01', 'B02', 'B03'].every((c) => isReportComplete('TT99', c)) ? [] : ['reports'])]
    : Object.entries(r.gates ?? {}).filter(([, ok]) => !ok).map(([g]) => g);
  return { ready: notReady.length === 0, notReady, effective: (r.effectiveFrom === null || dateFrom >= r.effectiveFrom) && (r.effectiveTo === null || dateFrom <= r.effectiveTo),
    effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, label: r.label };
}
