import { httpJson } from '../../lib/http.js';

export interface TaxLookupResult { found: boolean; name: string | null; address: string | null; status: string | null; source: string; checkedAt: string }
export interface TaxCodeLookup { lookup(taxCode: string): Promise<TaxLookupResult> }

// Tra MST gửi mã số thuế người bán ra dịch vụ bên thứ ba: chỉ khi người dùng bật cài đặt tax_code_lookup = 'vietqr' (mặc định 'off').
// Phản hồi thật (2026-10-23, docs/dev/tich-hop/ngan-hang.md mục 6): {"code":"00","data":{"id","name","address","status":"NNT đang hoạt động"}}; status là chuỗi tự do, không so khớp cứng.
export class VietQrBusinessLookup implements TaxCodeLookup {
  constructor(private baseUrl = 'https://api.vietqr.io', private timeoutMs = 8000) {}
  async lookup(taxCode: string): Promise<TaxLookupResult> {
    const checkedAt = new Date().toISOString();
    const miss: TaxLookupResult = { found: false, name: null, address: null, status: null, source: 'vietqr', checkedAt };
    if (!/^\d{10}(-?\d{3})?$/.test(taxCode)) return miss; // không gửi chuỗi lạ ra ngoài
    const r = await httpJson<{ code?: string; data?: { name?: string | null; address?: string | null; status?: string | null } | null }>(`${this.baseUrl}/v2/business/${taxCode}`, { method: 'GET', timeoutMs: this.timeoutMs });
    if (r.status >= 500 || r.status === 429) throw new Error(`Dịch vụ tra MST trả HTTP ${r.status}`);
    const d = r.body?.data;
    if (r.status !== 200 || r.body?.code !== '00' || !d) return miss;
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    return { found: true, name: str(d.name), address: str(d.address), status: str(d.status), source: 'vietqr', checkedAt };
  }
}

// Bản giả cho kiểm thử: bảng MST → kết quả; fail = mọi lần tra đều lỗi.
export class FakeLookup implements TaxCodeLookup {
  constructor(private table: Record<string, { name: string; address?: string; status?: string }>, private fail = false) {}
  async lookup(taxCode: string): Promise<TaxLookupResult> {
    if (this.fail) throw new Error('Dịch vụ tra MST không phản hồi');
    const e = this.table[taxCode];
    return { found: !!e, name: e?.name ?? null, address: e?.address ?? null, status: e?.status ?? null, source: 'fake', checkedAt: new Date().toISOString() };
  }
}

// Kiểm kiểu phản hồi của dịch vụ ngoài (có thể là bản thay thế/lỗi): sai kiểu thì coi là tra lỗi.
// eslint-disable-next-line no-control-regex -- bỏ NUL, ký tự điều khiển và surrogate lẻ mà jsonb không nhận
const UNSAFE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const cleanText = (s: string): string => s.replace(UNSAFE_RE, '');
export function validateLookup(r: unknown): TaxLookupResult {
  const o = r as Partial<Record<keyof TaxLookupResult, unknown>> | null;
  const s = (v: unknown) => v === null || typeof v === 'string';
  if (!o || typeof o.found !== 'boolean' || !s(o.name) || !s(o.address) || !s(o.status) || typeof o.source !== 'string' || typeof o.checkedAt !== 'string') throw new Error('Phản hồi tra MST không đúng dạng');
  const c = (v: unknown) => (typeof v === 'string' ? cleanText(v) : null);
  return { found: o.found, name: c(o.name), address: c(o.address), status: c(o.status), source: cleanText(o.source), checkedAt: cleanText(o.checkedAt) };
}

let override: TaxCodeLookup | null = null;
export const setTaxCodeLookupForTest = (l: TaxCodeLookup | null) => { override = l; };
export const taxCodeLookupFor = (setting: 'off' | 'vietqr'): TaxCodeLookup | null => (setting === 'off' ? null : override ?? new VietQrBusinessLookup());

const squash = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toUpperCase().replace(/[^A-Z0-9]/g, '');
export interface InvoiceWarningLike { code: string; message: string; [k: string]: unknown }
// Cảnh báo từ kết quả tra: không thấy MST, tên khác tên trên hóa đơn, lỗi tra.
export function taxCheckWarnings(sellerName: string, check: TaxLookupResult | { error: string }): InvoiceWarningLike[] {
  if ('error' in check) return [{ code: 'TAXCODE_LOOKUP_FAILED', message: `Không tra được MST người bán: ${check.error}` }];
  if (!check.found) return [{ code: 'TAXCODE_NOT_FOUND', message: 'Không tìm thấy MST người bán trên dịch vụ tra cứu' }];
  const out: InvoiceWarningLike[] = [];
  if (check.name && squash(check.name) !== squash(sellerName)) out.push({ code: 'TAXCODE_NAME_MISMATCH', message: `Tên theo MST "${check.name}" khác tên trên hóa đơn "${sellerName}"` });
  return out;
}
