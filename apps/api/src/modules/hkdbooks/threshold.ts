import { D, formatVnNumber } from '@kt/domain';
import { legalParam } from '../core/legal.js';
import { loadEntries, type Trx } from './service.js';

// Đối chiếu doanh thu năm trên sổ với các ngưỡng của NĐ 68/2026/NĐ-CP (đã sửa bởi NĐ 141/2026/NĐ-CP): tham số hkd_* trong legal_param (packages/coa-data/data/tax/legal-params.json), không viết cứng.
export interface RevenueCheck {
  fiscalYear: number; from: string; to: string; revenue: string;
  thresholds: { exempt: string | null; einvoice: string | null; pitMethod: string | null; vatMonthly: string | null };
  messages: string[];
}
export async function revenueCheck(trx: Trx, year: number): Promise<RevenueCheck> {
  const p = await trx.selectFrom('fiscal_period').select(({ fn }) => [fn.min('date_from').as('f'), fn.max('date_to').as('t')]).where('fiscal_year', '=', year).where('period_no', '>', 0).executeTakeFirst();
  const from = p?.f ?? `${year}-01-01`; const to = p?.t ?? `${year}-12-31`;
  const revenue = (await loadEntries(trx, from, to)).filter((e) => e.kind === 'revenue').reduce((a, e) => a.plus(e.amount), D(0));
  const get = (code: string) => legalParam<string>(trx, code, to);
  const [exempt, einvoice, pitMethod, vatMonthly] = await Promise.all([get('hkd_exempt_revenue'), get('hkd_einvoice_revenue'), get('hkd_pit_method_threshold'), get('hkd_vat_monthly_revenue')]);
  const messages: string[] = []; const v = (s: string) => `${formatVnNumber(s)} đồng`;
  if (!exempt) messages.push(`Chưa có tham số ngưỡng doanh thu từ văn bản gốc cho năm ${year}: phần mềm không đối chiếu ngưỡng.`);
  else {
    if (revenue.lte(exempt)) messages.push(`Doanh thu năm ${year} trên sổ ${v(revenue.toString())}, từ ${v(exempt)} trở xuống: không chịu thuế GTGT, không phải nộp thuế TNCN; chỉ thông báo doanh thu (mẫu 01/TKN-CNKD), chậm nhất ngày 31/01 năm sau (NĐ 68/2026 Điều 3, 4, 8 khoản 1, đã sửa bởi NĐ 141/2026).`);
    else {
      messages.push(`Doanh thu năm ${year} trên sổ ${v(revenue.toString())}, vượt ${v(exempt)}: chịu thuế GTGT và TNCN, khai thuế từ quý phát sinh doanh thu vượt mức (NĐ 68/2026 Điều 3 khoản 2, Điều 4 khoản 2, Điều 8 khoản 1, đã sửa bởi NĐ 141/2026).`);
      if (einvoice && revenue.gt(einvoice)) messages.push(`Doanh thu năm trên ${v(einvoice)}: phải áp dụng hóa đơn điện tử có mã của cơ quan thuế hoặc hóa đơn từ máy tính tiền kết nối dữ liệu (NĐ 68/2026 Điều 8 khoản 5, đã sửa bởi NĐ 141/2026).`);
      if (pitMethod && revenue.gt(pitMethod)) messages.push(`Doanh thu năm trên ${v(pitMethod)}: thuế TNCN tính theo thu nhập tính thuế nhân thuế suất, ổn định 02 năm liên tục (NĐ 68/2026 Điều 4 khoản 5).`);
      else if (pitMethod) messages.push(`Doanh thu năm không quá ${v(pitMethod)}: thuế TNCN tính theo thuế suất nhân doanh thu tính thuế, hoặc chọn phương pháp thu nhập tính thuế (NĐ 68/2026 Điều 4 khoản 5).`);
      if (vatMonthly && revenue.gt(vatMonthly)) messages.push(`Doanh thu năm trên ${v(vatMonthly)}: khai thuế GTGT theo tháng; không quá mức này khai theo quý (NĐ 68/2026 Điều 10 khoản 1).`);
    }
    messages.push('Doanh thu tính theo các bút doanh thu đã ghi sổ; chưa gồm doanh thu do tổ chức khấu trừ, khai thay, nộp thay (nền tảng thương mại điện tử) nếu chưa ghi vào sổ, và chưa loại doanh thu cho thuê bất động sản.');
  }
  return { fiscalYear: year, from, to, revenue: revenue.toString(), thresholds: { exempt, einvoice, pitMethod, vatMonthly }, messages };
}
