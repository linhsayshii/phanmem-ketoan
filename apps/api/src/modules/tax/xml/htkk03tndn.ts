import { loadCitTemplate, loadTaxXmlFormat, type CitTemplateVersion } from '@kt/coa-data';
import { AppError } from '../../../plugins/errors.js';
import type { CompanyInfo, TaxReturnXmlFormat, XmlReturn, XmlSpan } from './index.js';

// Tệp XML 03/TNDN theo định dạng trong data/tax/htkk-03tndn.json (verified = false: tên thẻ chưa kiểm chứng với HTKK). Thẻ chỉ tiêu theo thứ tự mẫu tờ khai,
// bỏ dòng tiêu đề (A, B, C, D, H); chỉ tiêu có số của mẫu thiếu thẻ thì lỗi 500 để không xuất tờ khai khuyết.
export function makeHtkk03Tndn(esc: (s: string) => string): TaxReturnXmlFormat {
  const f = loadTaxXmlFormat('htkk-03tndn');
  return {
    id: f.id, formCode: f.formCode, templateVersions: f.templateVersions, verified: f.verified,
    render(ret: XmlReturn, company: CompanyInfo, s: XmlSpan): string {
      if (!f.templateVersions.includes(ret.templateVersion)) throw new AppError('XML_TEMPLATE_UNSUPPORTED', `Định dạng ${f.id} không hỗ trợ mẫu tờ khai ${ret.templateVersion}`, 409);
      const t = (() => { try { return loadCitTemplate(ret.templateVersion as CitTemplateVersion); } catch (e) { throw new AppError('CIT_TEMPLATE_UNAVAILABLE', (e as Error).message, 409); } })();
      const vars: Record<string, string> = { templateVersion: ret.templateVersion, periodLabel: s.label, from: s.from, to: s.to, returnKind: ret.revision === 0 ? f.returnKind.first : f.returnKind.supplement,
        revision: String(ret.revision), taxCode: company.taxCode, companyName: company.name, address: company.address ?? '', legalRep: company.legalRep ?? '' };
      const fill = (v: string) => v.replace(/\{(\w+)\}/g, (_, k: string) => { if (!(k in vars)) throw new Error(`Định dạng ${f.id}: biến {${k}} không có`); return vars[k]!; });
      const el = (tag: string, v: string) => `<${tag}>${esc(v)}</${tag}>`;
      const head = f.header.map(([tag, v]) => `      ${el(tag, fill(v))}`).join('\n');
      const body = t.lines.filter((l) => l.kind !== 'section').map((l) => {
        const tag = f.tags[l.code]; if (!tag) throw new Error(`Định dạng ${f.id}: chỉ tiêu [${l.code}] chưa có thẻ`);
        return `      ${el(tag, ret.values[l.code] ?? '')}`;
      }).join('\n');
      return `<?xml version="1.0" encoding="${f.encoding}"?>\n<${f.root}>\n  <!-- ${f.verified ? '' : 'CHUA KIEM CHUNG VOI HTKK: '}${esc(f.formCode)} -->\n  <${f.headerTag}>\n${head}\n  </${f.headerTag}>\n  <${f.bodyTag}>\n${body}\n  </${f.bodyTag}>\n</${f.root}>\n`;
    },
  };
}
