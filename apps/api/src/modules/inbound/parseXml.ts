import { DOMParser } from '@xmldom/xmldom';
import { D } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { normTaxCode, verifyInvoiceSignature, type SigCheck } from './verify.js';

// Đọc XML hóa đơn điện tử theo QĐ 1233 (docs/dev/tich-hop/xml-hoa-don.md). Gốc TDiep/DLieu/HDon hoặc HDon; bỏ qua tiền tố namespace.
// Giới hạn 2 MB: dung lượng tối đa một thông điệp theo QĐ 1233 (xml-hoa-don.md mục 3, dòng 408 của văn bản).
export const MAX_INVOICE_XML_BYTES = 2 * 1024 * 1024;
const NUM_RE = /^-?\d{1,21}(\.\d{1,6})?$/;

export interface ParsedLine { lineNo: number; kind: 'goods' | 'promotion' | 'discount' | 'note'; code: string | null; name: string; uom: string | null; quantity: string | null; unitPrice: string | null; discountAmount: string | null; amount: string; taxRate: string | null }
export interface InvoiceWarning { code: string; message: string; [k: string]: unknown }
export interface ParsedInvoice {
  formNo: string; serial: string; invoiceNo: string; issueDate: string; currency: string; fxRate: string | null; paymentMethod: string | null; cqtCode: string | null;
  seller: { name: string; taxCode: string | null; address: string | null }; buyer: { name: string | null; taxCode: string | null; address: string | null };
  lines: ParsedLine[]; taxGroups: { taxRate: string; base: string; tax: string }[]; totals: { beforeTax: string; tax: string; discount: string | null; total: string };
  signatures: { seller: SigCheck | null; cqt: SigCheck | null }; extra: { key: string; kind: string | null; value: string }[]; warnings: InvoiceWarning[];
}

type El = Element;
const kids = (el: El | null | undefined, name: string): El[] => (el ? Array.from(el.childNodes).filter((n): n is El => n.nodeType === 1 && (n as El).localName === name) : []);
const bad = (m: string) => new AppError('XML_INVALID', m, 400);
const ambiguous = (m: string) => new AppError('XML_AMBIGUOUS', `${m}: nghi ngờ đánh tráo nội dung hóa đơn, từ chối`, 400);
// Phần tử con duy nhất; hai phần tử cùng tên → XML_AMBIGUOUS (chống signature wrapping).
function only(el: El | null | undefined, name: string): El | null {
  const k = kids(el, name);
  if (k.length > 1) throw ambiguous(`Có ${k.length} phần tử ${name} cùng cấp`);
  return k[0] ?? null;
}
const elements = (el: El, name: string, out: El[] = []): El[] => {
  for (const c of Array.from(el.childNodes)) if (c.nodeType === 1) { if ((c as El).localName === name) out.push(c as El); elements(c as El, name, out); }
  return out;
};
const text = (el: El | null | undefined, ...path: string[]): string | null => {
  let cur: El | null | undefined = el;
  for (const p of path) cur = kids(cur, p)[0];
  const t = cur?.textContent?.trim();
  return t ? t : null;
};

function normRate(raw: string | null, warnings: InvoiceWarning[]): string | null {
  if (raw === null) return null;
  const r = raw.trim().toUpperCase();
  const pct = /^(\d{1,3}(?:\.\d{1,4})?)%$/.exec(r);
  if (pct) return String(Number(pct[1]));
  if (r.startsWith('KHAC')) return 'KHAC';
  if (['KCT', 'KKKNT', 'CTTC', 'KTPVDC', 'KTGTT'].includes(r)) return r;
  warnings.push({ code: 'TAX_RATE_UNKNOWN', message: `Thuế suất lạ "${raw}": giữ nguyên, cần xem lại` });
  return r;
}

export function parseInvoiceXml(xml: string): ParsedInvoice {
  if (Buffer.byteLength(xml, 'utf8') > MAX_INVOICE_XML_BYTES) throw new AppError('XML_TOO_LARGE', 'Tệp XML vượt 2 MB (giới hạn thông điệp theo QĐ 1233)', 400);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new AppError('XML_UNSAFE', 'XML chứa DOCTYPE hoặc ENTITY: bị từ chối vì lý do an toàn', 400);
  let doc: Document;
  try {
    doc = new DOMParser({ onError: (level, msg) => { if (level !== 'warning') throw new Error(msg); } }).parseFromString(xml, 'text/xml') as unknown as Document;
  } catch (e) { throw bad(`XML không đúng cú pháp: ${e instanceof Error ? e.message : String(e)}`); }
  const root = doc.documentElement as El | null;
  if (!root) throw bad('XML rỗng');

  // Cấu trúc: đúng một HDon (gốc, hoặc TDiep/DLieu/HDon) và đúng một DLHDon trong cả tài liệu.
  const hdons = [...(root.localName === 'HDon' ? [root] : []), ...elements(root, 'HDon')];
  if (hdons.length > 1) throw ambiguous(`Có ${hdons.length} phần tử HDon`);
  const hdon = hdons[0];
  if (!hdon) throw bad('Không phải hóa đơn điện tử: không có phần tử HDon');
  let hdonPath: string[] = [];
  if (hdon !== root) {
    const dlieu = hdon.parentNode as El;
    if (root.localName !== 'TDiep' || dlieu.localName !== 'DLieu' || dlieu.parentNode !== root) throw bad('HDon phải ở gốc hoặc trong TDiep/DLieu');
    hdonPath = ['DLieu', 'HDon'];
  }
  const dlhdons = elements(root, 'DLHDon');
  if (dlhdons.length > 1) throw ambiguous(`Có ${dlhdons.length} phần tử DLHDon`);
  const ownDl = dlhdons[0];
  if (!ownDl) throw bad('Thiếu DLHDon (dữ liệu hóa đơn)');
  const dlParent = ownDl.parentNode as El;
  if (dlParent !== hdon && !(dlParent.localName === 'DLieu' && dlParent.parentNode === hdon)) throw bad('DLHDon phải nằm trực tiếp dưới HDon');
  only(hdon, 'DLieu');

  const warnings: InvoiceWarning[] = [];
  const dscks = only(hdon, 'DSCKS');
  const sellerSigEl = only(only(dscks, 'NBan'), 'Signature');
  const cqtSigEl = only(only(dscks, 'CQT'), 'Signature');
  const ownMccqt = only(hdon, 'MCCQT');

  // Chữ ký hợp lệ: dữ liệu CHỈ đọc từ nút được chữ ký phủ, không đọc từ bản còn lại trong tài liệu.
  let dl: El = ownDl; let mccqtEl: El | null = ownMccqt;
  let seller: SigCheck | null = null; let cqt: SigCheck | null = null;
  if (sellerSigEl) {
    const r = verifyInvoiceSignature(xml, hdonPath, 'NBan', !!ownMccqt);
    seller = r.check;
    if (r.check.valid) dl = r.covered.find((c) => c.localName === 'DLHDon')!;
  }
  if (cqtSigEl) {
    const r = verifyInvoiceSignature(xml, hdonPath, 'CQT', !!ownMccqt);
    cqt = r.check;
    if (r.check.valid) { mccqtEl = r.covered.find((c) => c.localName === 'MCCQT') ?? mccqtEl; if (!sellerSigEl || !seller?.valid) dl = r.covered.find((c) => c.localName === 'DLHDon')!; }
  }
  if (!seller) warnings.push({ code: 'UNSIGNED', message: 'Hóa đơn không có chữ ký số của người bán: chưa kiểm được tính toàn vẹn' });
  else if (!seller.valid) warnings.push({ code: 'SELLER_SIGNATURE_INVALID', message: `Chữ ký người bán không hợp lệ: ${seller.reason ?? ''}` });
  if (cqt && !cqt.valid) warnings.push({ code: 'CQT_SIGNATURE_INVALID', message: `Chữ ký cơ quan thuế không hợp lệ: ${cqt.reason ?? ''}` });

  const num = (raw: string | null, field: string): string | null => {
    if (raw !== null && !NUM_RE.test(raw)) warnings.push({ code: 'NUMBER_FORMAT', message: `Số "${raw}" ở ${field} không đúng dạng (chấm thập phân, tối đa 6 số lẻ): giữ nguyên chuỗi gốc` });
    return raw;
  };
  const ok = (s: string | null): s is string => s !== null && NUM_RE.test(s);

  const tt = only(dl, 'TTChung');
  const formNo = text(tt, 'KHMSHDon'); const serial = text(tt, 'KHHDon'); const invoiceNo = text(tt, 'SHDon'); const issueDate = text(tt, 'NLap');
  if (!formNo) throw bad('Thiếu KHMSHDon (ký hiệu mẫu số hóa đơn)');
  if (!serial) throw bad('Thiếu KHHDon (ký hiệu hóa đơn)');
  if (!invoiceNo) throw bad('Thiếu SHDon (số hóa đơn)');
  const dt = issueDate && /^\d{4}-\d{2}-\d{2}$/.test(issueDate) ? new Date(`${issueDate}T00:00:00Z`) : null;
  if (!issueDate || !dt || Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== issueDate) throw bad('NLap (ngày lập) thiếu hoặc không đúng dạng YYYY-MM-DD');
  const dvtte = kids(tt, 'DVTTe')[0];
  let currency = text(dvtte, 'Ma') ?? (dvtte?.textContent?.trim() || null); // 2.0.x: DVTTe/Ma; 2.1.x: DVTTe là chuỗi
  if (!currency) { currency = 'VND'; warnings.push({ code: 'CURRENCY_ASSUMED', message: 'Hóa đơn không ghi đơn vị tiền tệ: coi là VND' }); }
  const nb = only(only(dl, 'NDHDon'), 'NBan'); const nm = only(only(dl, 'NDHDon'), 'NMua');
  const sellerName = text(nb, 'Ten');
  if (!sellerName) throw bad('Thiếu NBan/Ten (tên người bán)');

  const lines: ParsedLine[] = kids(only(only(dl, 'NDHDon'), 'DSHHDVu'), 'HHDVu').map((h, i) => {
    const chat = text(h, 'TChat');
    const kind = chat === '2' ? 'promotion' : chat === '3' ? 'discount' : chat === '4' ? 'note' : 'goods';
    const n = Number(text(h, 'STT'));
    return {
      lineNo: Number.isInteger(n) && n > 0 ? n : i + 1, kind, code: text(h, 'MHHDVu'), name: text(h, 'THHDVu') ?? '', uom: text(h, 'DVTinh'),
      quantity: num(text(h, 'SLuong'), `dòng ${i + 1} SLuong`), unitPrice: num(text(h, 'DGia'), `dòng ${i + 1} DGia`), discountAmount: num(text(h, 'STCKhau'), `dòng ${i + 1} STCKhau`),
      amount: num(text(h, 'ThTien'), `dòng ${i + 1} ThTien`) ?? '0', taxRate: normRate(text(h, 'TSuat'), warnings),
    };
  });
  // STT trùng làm hỏng khóa (hóa đơn, số dòng): đánh số lại theo thứ tự.
  if (new Set(lines.map((l) => l.lineNo)).size !== lines.length) lines.forEach((l, i) => { l.lineNo = i + 1; });

  const tg = only(only(dl, 'NDHDon'), 'TToan');
  let taxGroups = kids(only(tg, 'THTTLTSuat'), 'LTSuat').map((g, i) => ({
    taxRate: normRate(text(g, 'TSuat'), warnings) ?? '', base: num(text(g, 'ThTien'), `LTSuat ${i + 1} ThTien`) ?? '0', tax: num(text(g, 'TThue'), `LTSuat ${i + 1} TThue`) ?? '0' }));
  const sumOf = (xs: (string | null)[]) => xs.filter(ok).reduce((s, x) => s.plus(D(x)), D(0));
  if (taxGroups.length === 0 && lines.length > 0) {
    // Mẫu thiếu THTTLTSuat (và hóa đơn bán hàng không có thuế): suy ra theo dòng, thuế = thành tiền × thuế suất khi thuế suất là số.
    const by = new Map<string, { base: ReturnType<typeof D>; tax: ReturnType<typeof D> }>();
    for (const l of lines.filter((x) => x.kind !== 'note' && ok(x.amount))) {
      const rate = l.taxRate ?? ''; const g = by.get(rate) ?? { base: D(0), tax: D(0) };
      const amt = l.kind === 'discount' ? D(l.amount).neg() : D(l.amount);
      g.base = g.base.plus(amt); g.tax = g.tax.plus(/^\d+(\.\d+)?$/.test(rate) ? amt.times(rate).div(100).toDecimalPlaces(0) : 0);
      by.set(rate, g);
    }
    taxGroups = [...by].filter(([r]) => r !== '').map(([taxRate, g]) => ({ taxRate, base: g.base.toFixed(), tax: g.tax.toFixed() }));
    warnings.push({ code: 'TAXGROUPS_DERIVED', message: 'Hóa đơn không có THTTLTSuat: nhóm thuế suy ra từ các dòng hàng' });
  }
  let beforeTax = num(text(tg, 'TgTCThue'), 'TgTCThue'); let tax = num(text(tg, 'TgTThue'), 'TgTThue'); let total = num(text(tg, 'TgTTTBSo'), 'TgTTTBSo');
  const derived: string[] = [];
  if (beforeTax === null) { beforeTax = lines.filter((l) => l.kind !== 'note').reduce((s, l) => (ok(l.amount) ? (l.kind === 'discount' ? s.minus(D(l.amount)) : s.plus(D(l.amount))) : s), D(0)).toFixed(); derived.push('TgTCThue'); }
  if (tax === null) { tax = sumOf(taxGroups.map((g) => g.tax)).toFixed(); derived.push('TgTThue'); }
  if (total === null) { total = ok(beforeTax) && ok(tax) ? D(beforeTax).plus(D(tax)).toFixed() : '0'; derived.push('TgTTTBSo'); }
  if (derived.length) warnings.push({ code: 'TOTALS_DERIVED', message: `Hóa đơn thiếu ${derived.join(', ')}: tính từ các dòng hàng` });
  else if (ok(beforeTax) && ok(tax) && ok(total) && !D(beforeTax).plus(D(tax)).eq(D(total))) warnings.push({ code: 'TOTAL_MISMATCH', message: `Tổng chưa thuế ${beforeTax} + thuế ${tax} khác tổng thanh toán ${total} (có thể do phí, giảm trừ hoặc chiết khấu)` });

  const fxRate = num(text(tt, 'TGia'), 'TGia');
  const extra = kids(only(dl, 'TTKhac'), 'TTin').map((t) => ({ key: text(t, 'TTruong') ?? '', kind: text(t, 'KDLieu'), value: text(t, 'DLieu') ?? '' }));
  const mccqt = mccqtEl?.textContent?.trim() || null;
  if (seller?.valid && seller.taxCodeInCert && normTaxCode(seller.taxCodeInCert) !== normTaxCode(text(nb, 'MST')))
    warnings.push({ code: 'SIGNER_TAXCODE_MISMATCH', message: `MST trong chứng thư số (${seller.taxCodeInCert}) khác MST người bán (${text(nb, 'MST') ?? 'trống'})` });

  return {
    formNo, serial, invoiceNo, issueDate, currency, fxRate, paymentMethod: text(tt, 'HTTToan'), cqtCode: mccqt,
    seller: { name: sellerName, taxCode: text(nb, 'MST'), address: text(nb, 'DChi') }, buyer: { name: text(nm, 'Ten'), taxCode: text(nm, 'MST'), address: text(nm, 'DChi') },
    lines, taxGroups, totals: { beforeTax, tax, discount: num(text(tg, 'TTCKTMai'), 'TTCKTMai'), total }, signatures: { seller, cqt }, extra, warnings,
  };
}
