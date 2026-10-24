import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import { specOf } from './register.js';
import { getReturn } from './vatReturn.js';
import { XML_FORMATS } from './xml/index.js';

export interface RenderedReturnXml { xml: string; file: string; verified: boolean }

// XML tờ khai đã chốt theo định dạng (route xuất XML và phiên ký số dùng chung). Gọi trong giao dịch đọc.
export async function renderReturnXml(trx: Transaction<Database>, tenantId: string, id: number, formatId = 'htkk-01gtgt'): Promise<RenderedReturnXml> {
  const fmt = XML_FORMATS[formatId];
  if (!fmt || !Object.hasOwn(XML_FORMATS, formatId)) throw new AppError('XML_FORMAT_INVALID', `Định dạng XML "${formatId}" không có; dùng ${Object.keys(XML_FORMATS).join(', ')}`, 400);
  const ret = await getReturn(trx, id); const company = await companyInfo(trx, tenantId, '', null);
  if (fmt.formCode !== ret.formCode) throw new AppError('XML_FORMAT_INVALID', `Định dạng "${formatId}" dành cho tờ khai ${fmt.formCode}`, 400);
  if (ret.status !== 'final') throw new AppError('TAX_RETURN_NOT_FINAL', 'Chỉ xuất XML tờ khai đã chốt', 409);
  if (!company.taxCode) throw new AppError('COMPANY_TAX_CODE_MISSING', 'Công ty chưa có mã số thuế: nhập ở Cài đặt công ty trước khi xuất XML', 409);
  const xml = fmt.render(ret, { name: company.name, taxCode: company.taxCode, address: company.address, legalRep: company.legalRep }, specOf({ year: ret.year, period: ret.period, periodKind: ret.periodKind }));
  const file = `${fmt.formCode.replace('/', '')}_${company.taxCode}_${ret.periodKind === 'month' ? 'T' : 'Q'}${ret.period}-${ret.year}${ret.revision ? `-BS${ret.revision}` : ''}.xml`;
  return { xml, file, verified: fmt.verified };
}
