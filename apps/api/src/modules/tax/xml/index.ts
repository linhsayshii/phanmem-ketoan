import { makeHtkk01Gtgt } from './htkk01gtgt.js';
import { makeHtkk03Tndn } from './htkk03tndn.js';

// Xuất tờ khai ra XML qua adapter định dạng: mỗi định dạng (HTKK 01/GTGT, sau này 03/TNDN...) một đối tượng; mã đặc thù của định dạng nằm ở tệp dữ liệu của @kt/coa-data.
export interface CompanyInfo { name: string; taxCode: string; address: string | null; legalRep: string | null }
// Tờ khai cần xuất (01/GTGT, 03/TNDN) và khoảng ngày của kỳ tính thuế (người gọi tính theo loại kỳ).
export interface XmlReturn { formCode: string; templateVersion: string; year: number; period: number; revision: number; values: Record<string, string> }
export interface XmlSpan { from: string; to: string; label: string }
export interface TaxReturnXmlFormat { id: string; formCode: string; templateVersions: string[]; verified: boolean; render(ret: XmlReturn, company: CompanyInfo, span: XmlSpan): string }

// Thoát ký tự đặc biệt của XML 1.0 và bỏ ký tự điều khiển, U+FFFE/U+FFFF và nửa cặp thay thế (surrogate) lẻ không được phép (tên công ty do người dùng nhập).
// eslint-disable-next-line no-control-regex
export const escapeXml = (s: string): string => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

export const XML_FORMATS: Record<string, TaxReturnXmlFormat> = { 'htkk-01gtgt': makeHtkk01Gtgt(escapeXml), 'htkk-03tndn': makeHtkk03Tndn(escapeXml) };
