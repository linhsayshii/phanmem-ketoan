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
// Chỉ tài khoản chi tiết đang dùng (nhập chứng từ); `includeGroups` thêm tài khoản tổng hợp (xem sổ Cái của cả nhóm);
// `includeInactive` thêm tài khoản đã ngưng dùng (bộ lọc báo cáo: tài khoản cũ vẫn còn phát sinh).
export function accountFetcherFor(postingDate?: string, includeGroups = false, includeInactive = false): (q: string) => Promise<LookupRow[]> { // đọc từ bộ nhớ đệm nên không cần tín hiệu hủy
  let regime: Promise<string> | undefined;
  return async (q) => {
    regime ??= api<FiscalYearRef[]>('/api/fiscal-years').then((ys) => regimeFor(ys, postingDate)).catch((e: unknown) => { regime = undefined; throw e; });
    const k = q.trim().toLowerCase();
    return (await accountsOf(await regime)).filter((a) => (includeInactive || a.isActive) && (includeGroups || !a.isGroup)).map((a) => ({ id: a.id, code: a.code, name: a.name, ...(a.isActive ? {} : { inactive: true }) }))
      .filter((r) => !k || r.code.startsWith(k) || r.name.toLowerCase().includes(k)).slice(0, 50);
  };
}

// Tài khoản ngân hàng của công ty: danh mục không có cột mã/tên chung nên số tài khoản làm mã, tên tài khoản (hoặc mã ngân hàng) làm tên.
// Giá trị lưu vào chứng từ là số tài khoản (bank_account.account_no).
interface BankAccountRow { id: string; account_no: string; account_name: string | null; bank_code: string; is_active?: boolean }
export async function bankAccountFetcher(q: string, signal: AbortSignal): Promise<LookupRow[]> {
  const r = await fetch(`/api/catalogs/bank_account?q=${encodeURIComponent(q)}&size=50`, { credentials: 'include', signal });
  if (!r.ok) return []; // phiên hết hạn / thiếu quyền: danh sách rỗng
  return ((await r.json()) as { rows: BankAccountRow[] }).rows.map((b) => ({ id: b.id, code: b.account_no, name: b.account_name || b.bank_code, ...(b.is_active === false ? { inactive: true } : {}) }));
}

// Mã luồng tiền (mã chỉ tiêu B03) theo chế độ của kỳ chứa ngày hạch toán; chưa có ngày hoặc thiếu quyền thì rỗng. Tạo một lần cho mỗi ngày (useMemo).
export function cashFlowFetcherFor(postingDate?: string): (q: string, signal: AbortSignal) => Promise<LookupRow[]> {
  return async (q, signal) => {
    if (!postingDate) return [];
    const r = await fetch(`/api/cash-flow-codes?date=${postingDate}`, { credentials: 'include', signal });
    if (!r.ok) return [];
    const k = q.trim().toLowerCase();
    return ((await r.json()) as { code: string; name: string }[]).filter((c) => !k || c.code.startsWith(k) || c.name.toLowerCase().includes(k)).map((c) => ({ id: c.code, code: c.code, name: c.name }));
  };
}

// Cột "Tài sản" của dòng chứng từ chỉ có ý nghĩa với TK tài sản (211-213, hao mòn 214x, 217) và 242.
// shortcut: nhận diện theo đầu số tài khoản, không đọc subledger_kind; đổi khi có tài khoản tài sản đặt ngoài các đầu số này.
export const ASSET_ACCOUNT_RE = /^(21[1-4]|217|242)/;
// Thẻ tài sản (TSCĐ, CCDC, chi phí trả trước) cho F4: /api/lookups/assets, lọc theo loại thẻ nếu có.
export const assetFetcher = (kind?: 'fixed' | 'tool' | 'prepaid') => async (q: string, signal: AbortSignal): Promise<LookupRow[]> => {
  const r = await fetch(`/api/lookups/assets?q=${encodeURIComponent(q)}&size=50${kind ? `&kind=${kind}` : ''}`, { credentials: 'include', signal });
  return r.ok ? ((await r.json()) as LookupRow[]).map(({ id, code, name }) => ({ id, code, name })) : [];
};
// Loại tài sản của phân hệ tài sản cho F4.
export const assetCategoryFetcher = (kind: 'fixed' | 'tool' | 'prepaid') => async (q: string, signal: AbortSignal): Promise<LookupRow[]> => {
  const r = await fetch(`/api/asset-categories?kind=${kind}`, { credentials: 'include', signal });
  const k = q.trim().toLowerCase();
  return r.ok ? ((await r.json()) as (LookupRow & { isActive: boolean })[]).filter((c) => c.isActive && (!k || c.code.toLowerCase().startsWith(k) || c.name.toLowerCase().includes(k))).map(({ id, code, name }) => ({ id, code, name })) : [];
};
