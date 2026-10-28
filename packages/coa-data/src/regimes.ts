import { readFileSync } from 'node:fs';
import { dataPath } from './load.js';

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
