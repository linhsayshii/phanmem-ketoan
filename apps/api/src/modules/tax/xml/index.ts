import type { TaxReturnDto } from '../vatReturn.js';
import { makeHtkk01Gtgt } from './htkk01gtgt.js';

// Xuất tờ khai ra XML qua adapter định dạng: mỗi định dạng (HTKK 01/GTGT, sau này 03/TNDN...) một đối tượng; mã đặc thù của định dạng nằm ở tệp dữ liệu của @kt/coa-data.
export interface CompanyInfo { name: string; taxCode: string; address: string | null; legalRep: string | null }
export interface TaxReturnXmlFormat { id: string; formCode: string; templateVersions: string[]; verified: boolean; render(ret: TaxReturnDto, company: CompanyInfo): string }

// Thoát ký tự đặc biệt của XML 1.0 và bỏ ký tự điều khiển không được phép (tên công ty do người dùng nhập).
// eslint-disable-next-line no-control-regex
export const escapeXml = (s: string): string => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

export const XML_FORMATS: Record<string, TaxReturnXmlFormat> = { 'htkk-01gtgt': makeHtkk01Gtgt(escapeXml) };
