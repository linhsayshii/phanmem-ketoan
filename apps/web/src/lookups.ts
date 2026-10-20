import type { LookupRow } from '@kt/ui';
import { api } from './api/client.js';

export interface FiscalYearRef { regime: string; dateFrom: string; dateTo: string }
interface AccountRow { id: number; code: string; name: string; isGroup: boolean; isActive: boolean }

// Chế độ kế toán của năm tài chính chứa ngày `date` (một công ty có thể giữ nhiều chế độ, mã tài khoản trùng giữa các hệ).
// Ngày ngoài mọi năm (hoặc chưa nhập): lấy năm cuối; chưa có năm nào: TT99.
export function regimeFor(years: FiscalYearRef[], date?: string): string {
  const hit = date ? years.find((y) => y.dateFrom <= date && date <= y.dateTo) : undefined;
  return (hit ?? years.at(-1))?.regime ?? 'TT99';
}

// Danh sách tài khoản theo chế độ, nhớ 30 giây để mỗi lần gõ tìm không gọi lại máy chủ nhưng tài khoản mới thêm sớm hiện ra.
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; rows: Promise<AccountRow[]> }>();
function accountsOf(regime: string): Promise<AccountRow[]> {
  const hit = cache.get(regime);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const rows = api<AccountRow[]>(`/api/accounts?regime=${regime}`);
  cache.set(regime, { at: Date.now(), rows });
  rows.catch(() => cache.delete(regime));
  return rows;
}

// Bộ tìm tài khoản cho LookupSelect, theo chế độ của năm tài chính chứa ngày hạch toán. Tạo một lần cho mỗi ngày (useMemo): LookupSelect nạp lại khi `fetcher` đổi.
// Chỉ tài khoản chi tiết đang dùng (nhập chứng từ); `includeGroups` thêm tài khoản tổng hợp (xem sổ Cái của cả nhóm).
export function accountFetcherFor(postingDate?: string, includeGroups = false): (catalog: string, q: string) => Promise<LookupRow[]> {
  let regime: Promise<string> | undefined;
  return async (_catalog, q) => {
    regime ??= api<FiscalYearRef[]>('/api/fiscal-years').then((ys) => regimeFor(ys, postingDate)).catch((e: unknown) => { regime = undefined; throw e; });
    const k = q.trim().toLowerCase();
    return (await accountsOf(await regime)).filter((a) => a.isActive && (includeGroups || !a.isGroup)).map((a) => ({ id: a.id, code: a.code, name: a.name }))
      .filter((r) => !k || r.code.startsWith(k) || r.name.toLowerCase().includes(k)).slice(0, 50);
  };
}
