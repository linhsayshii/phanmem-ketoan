import { readFileSync } from 'node:fs';
import { dataPath, isReportComplete, tt99Status } from './load.js';

// Chế độ kế toán ghi sổ theo nhóm thuế, không có hệ thống tài khoản (TT 58/2026 siêu nhỏ, TT 152/2025 hộ kinh doanh): cổng dữ liệu pháp lý ở data/regimes/status.json, định nghĩa sổ ở data/books/*.json.
// gates.* = true chỉ khi phần đó nhập từ văn bản gốc và đối chiếu từng chữ; applicable.* = false khi thông tư không có phần đó (không áp dụng, không tính là thiếu).
export type BookRegime = 'TT58' | 'TT152';
export const BOOK_REGIMES: BookRegime[] = ['TT58', 'TT152'];
export interface RegimeStatus {
  label: string; issuedOn: string; effectiveFrom: string; replaces: string; primaryTextObtained: boolean;
  applicable: { coa: boolean; reports: boolean };
  gates: { coa: boolean; books: boolean; reports: boolean }; note: string; limits: string[];
  booksSecondary: { code: string; name: string | null }[]; reportsSecondary: { code: string; name: string }[];
  sources: { url: string; fetched: string; kind: string; used: string }[]; missing: string[];
}
export function regimeStatus(): Record<BookRegime, RegimeStatus> { return JSON.parse(readFileSync(dataPath('regimes', 'status.json'), 'utf8')) as Record<BookRegime, RegimeStatus>; }
// Dùng được cho kế toán thật = hệ thống tài khoản (nếu thông tư có) và các sổ bắt buộc đã nhập; báo cáo tài chính xét riêng (reportsReady) vì có thể thiếu một phần mà vẫn ghi sổ được (xem `limits`).
export const isRegimeReady = (r: BookRegime): boolean => { const s = regimeStatus()[r]; return (!s.applicable.coa || s.gates.coa) && s.gates.books; };
export const regimeReportsReady = (r: BookRegime): boolean => { const s = regimeStatus()[r]; return !s.applicable.reports || s.gates.reports; };

export interface BookColumnDef { key: string; label: string; ref: string; type?: 'number' | 'date'; scale?: number }
export interface BookDef { code: string; name: string; article: string; built: boolean; verified: boolean; reason?: string; columns: BookColumnDef[]; formulas?: Record<string, string> }
export interface BookMethodDef { code: string; article: string; label: string; books: string[] }
export interface ReportLineDef { lineNo: string; label: string; source?: string; formula?: string }
export interface BookSetDef {
  regime: BookRegime; source: string; issuedBy: string; methods: BookMethodDef[]; extraBooks: string[]; books: BookDef[];
  reports: { code: string; name: string; article: string; built: boolean; verified: boolean; reason?: string; lines: ReportLineDef[] }[]; notApplicable: string[];
}
export function loadBookSet(regime: BookRegime): BookSetDef { return JSON.parse(readFileSync(dataPath('books', `${regime.toLowerCase()}.json`), 'utf8')) as BookSetDef; }
export const bookRegimeOf = (code: string): BookRegime | null => (code.endsWith('-HKD') ? 'TT152' : code.endsWith('-DNSN') || code === 'S1-DNSN' ? 'TT58' : null);

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
    const notReady = Object.entries(s.gates).filter(([g, ok]) => !ok && (g === 'books' || s.applicable[g as 'coa' | 'reports'])).map(([g]) => g);
    return { ready: isRegimeReady(regime), notReady, effective: dateFrom >= s.effectiveFrom, effectiveFrom: s.effectiveFrom, effectiveTo: null, label: s.label };
  }
  if (!isFullRegime(regime)) return { ready: false, notReady: ['unknown'], effective: false, effectiveFrom: null, effectiveTo: null, label: regime };
  const r = accountingRegimeRules()[regime];
  const notReady = regime === 'TT99'
    ? [...(tt99Status().complete ? [] : ['coa']), ...(['B01', 'B02', 'B03'].every((c) => isReportComplete('TT99', c)) ? [] : ['reports'])]
    : Object.entries(r.gates ?? {}).filter(([, ok]) => !ok).map(([g]) => g);
  return { ready: notReady.length === 0, notReady, effective: (r.effectiveFrom === null || dateFrom >= r.effectiveFrom) && (r.effectiveTo === null || dateFrom <= r.effectiveTo),
    effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, label: r.label };
}
