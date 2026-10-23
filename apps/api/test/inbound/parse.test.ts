import { afterAll, describe, expect, it } from 'vitest';
import { parseInvoiceXml } from '../../src/modules/inbound/parseXml.js';
import { dropKey, makeKey } from '../signing/keys.js';
import { fixture, signInvoice } from './helpers.js';

const key = makeKey('Nguoi ban'); afterAll(() => dropKey(key));
const code = (f: () => unknown) => { try { f(); return null; } catch (e) { return [(e as { code?: string }).code, (e as { status?: number }).status]; } };
const codes = (p: { warnings: { code: string }[] }) => p.warnings.map((w) => w.code);

describe('parseInvoiceXml', () => {
  it.each([
    ['vn-einvoice-vat.xml', { serial: 'C26TAA', invoiceNo: '00000123', issueDate: '2026-01-15', taxCode: '0100000001', before: '1300000', tax: '130000', total: '1430000', lines: 2, cqt: '00A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5' }],
    ['vn-einvoice-cashreg.xml', { serial: 'C26MAA', invoiceNo: '00000456', issueDate: '2026-02-02', taxCode: '0400000003', before: '540000', tax: '43200', total: '583200', lines: 1, cqt: '00F1E2D3C4B5A69788796A5B4C3D2E1F' }],
  ])('%s: ký hiệu, số, ngày, MST người bán, tổng = Σ dòng + thuế', (f, e) => {
    const p = parseInvoiceXml(fixture(f));
    expect([p.serial, p.invoiceNo, p.issueDate, p.seller.taxCode, p.totals.beforeTax, p.totals.tax, p.totals.total, p.lines.length, p.cqtCode, p.currency])
      .toEqual([e.serial, e.invoiceNo, e.issueDate, e.taxCode, e.before, e.tax, e.total, e.lines, e.cqt, 'VND']);
    expect(p.lines.reduce((s, l) => s + Number(l.amount), 0)).toBe(Number(e.before));
    expect(codes(p)).toContain('UNSIGNED');
    expect(p.signatures).toEqual({ seller: null, cqt: null });
  });

  it('mẫu GTGT: dòng hàng, nhóm thuế suy ra, người mua; mẫu máy tính tiền: người mua rỗng → null', () => {
    const p = parseInvoiceXml(fixture('vn-einvoice-vat.xml'));
    expect(p.lines[0]).toMatchObject({ lineNo: 1, kind: 'goods', code: 'SP001', quantity: '20', unitPrice: '50000', amount: '1000000', taxRate: '10' });
    expect(p.taxGroups).toEqual([{ taxRate: '10', base: '1300000', tax: '130000' }]);
    expect(p.buyer.taxCode).toBe('0300000002');
    const c = parseInvoiceXml(fixture('vn-einvoice-cashreg.xml'));
    expect(c.buyer).toEqual({ name: null, taxCode: null, address: null });
    expect(c.lines[0]).toMatchObject({ code: null, taxRate: '8' });
  });

  it('DOCTYPE/ENTITY (mọi kiểu chữ) → 400 XML_UNSAFE; quá 2 MB → 400 XML_TOO_LARGE', () => {
    expect(code(() => parseInvoiceXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><HDon/>'))).toEqual(['XML_UNSAFE', 400]);
    expect(code(() => parseInvoiceXml('<!doctype x><HDon/>'))).toEqual(['XML_UNSAFE', 400]);
    expect(code(() => parseInvoiceXml('<HDon><!entity a "b"></HDon>'))).toEqual(['XML_UNSAFE', 400]);
    expect(code(() => parseInvoiceXml(`<HDon>${' '.repeat(2 * 1024 * 1024 + 1)}</HDon>`))).toEqual(['XML_TOO_LARGE', 400]);
  });

  it('thuế suất KCT, KKKNT, 8%, KHAC chuẩn hóa; số "1000000.50" giữ chuỗi; dạng lạ → NUMBER_FORMAT', () => {
    let x = fixture('vn-einvoice-vat.xml');
    x = x.replace('<TSuat>10%</TSuat>', '<TSuat>KCT</TSuat>').replace('<TSuat>10%</TSuat>', '<TSuat>KHAC:5.26%</TSuat>').replace('<ThTien>1000000</ThTien>', '<ThTien>1000000.50</ThTien>');
    const p = parseInvoiceXml(x);
    expect(p.lines.map((l) => l.taxRate)).toEqual(['KCT', 'KHAC']);
    expect(p.lines[0]!.amount).toBe('1000000.50');
    expect(codes(p)).not.toContain('NUMBER_FORMAT');
    expect(parseInvoiceXml(x.replace('<TSuat>KCT</TSuat>', '<TSuat>KKKNT</TSuat>')).lines[0]!.taxRate).toBe('KKKNT');
    const q = parseInvoiceXml(x.replace('<SLuong>20</SLuong>', '<SLuong>1,5</SLuong>'));
    expect(q.lines[0]!.quantity).toBe('1,5');
    expect(codes(q)).toContain('NUMBER_FORMAT');
  });

  it('thiếu số hóa đơn hoặc không phải hóa đơn hoặc XML hỏng → 400 XML_INVALID', () => {
    expect(code(() => parseInvoiceXml(fixture('vn-einvoice-vat.xml').replace('<SHDon>00000123</SHDon>', '')))).toEqual(['XML_INVALID', 400]);
    expect(code(() => parseInvoiceXml('<a><b/></a>'))).toEqual(['XML_INVALID', 400]);
    expect(code(() => parseInvoiceXml('<HDon><DLHDon'))).toEqual(['XML_INVALID', 400]);
  });

  it('bọc TDiep/DLieu/HDon', () => {
    const inner = fixture('vn-einvoice-vat.xml').replace(/<\?xml[^>]*\?>/, '');
    expect(parseInvoiceXml(`<TDiep><TTChung><PBan>2.1.1</PBan></TTChung><DLieu>${inner}</DLieu></TDiep>`).invoiceNo).toBe('00000123');
  });

  it('chữ ký người bán hợp lệ → valid (chưa kiểm CA); sửa ThTien → invalid + SELLER_SIGNATURE_INVALID', () => {
    const signed = signInvoice(fixture('vn-einvoice-vat.xml'), key);
    const p = parseInvoiceXml(signed);
    expect(p.signatures.seller).toMatchObject({ valid: true, caChain: 'unchecked', signingTime: '2026-01-15T09:00:00' });
    expect(p.signatures.seller!.subject).toContain('CN=Nguoi ban');
    expect(codes(p)).not.toContain('UNSIGNED');
    const bad = parseInvoiceXml(signed.replace('<ThTien>300000</ThTien>', '<ThTien>300001</ThTien>'));
    expect(bad.signatures.seller!.valid).toBe(false);
    expect(codes(bad)).toContain('SELLER_SIGNATURE_INVALID');
  });

  it('MST trong chứng thư khác MST người bán → SIGNER_TAXCODE_MISMATCH; khớp thì không', () => {
    expect(parseInvoiceXml(signInvoice(fixture('vn-einvoice-vat.xml'), key)).signatures.seller!.taxCodeInCert).toBeNull();
    const k2 = makeKey('x', 30, 'MST:0100000001'); const k3 = makeKey('y', 30, 'MST:0999999999');
    try {
      const ok = parseInvoiceXml(signInvoice(fixture('vn-einvoice-vat.xml'), k2));
      expect(ok.signatures.seller!.taxCodeInCert).toBe('0100000001');
      expect(codes(ok)).not.toContain('SIGNER_TAXCODE_MISMATCH');
      expect(codes(parseInvoiceXml(signInvoice(fixture('vn-einvoice-vat.xml'), k3)))).toContain('SIGNER_TAXCODE_MISMATCH');
    } finally { dropKey(k2); dropKey(k3); }
  });

  it('chữ ký CQT phải phủ cả DLHDon lẫn MCCQT', () => {
    const noCode = fixture('vn-einvoice-vat.xml').replace(/<MCCQT[\s\S]*?<\/MCCQT>/, '');
    expect(parseInvoiceXml(signInvoice(noCode, key, 'CQT')).signatures.cqt?.valid).toBe(true);
    const p = parseInvoiceXml(signInvoice(fixture('vn-einvoice-vat.xml'), key, 'CQT'));
    expect(p.signatures.seller).toBeNull();
    expect(p.signatures.cqt?.valid).toBe(false);
    expect(codes(p)).toContain('CQT_SIGNATURE_INVALID');
  });

  it('chống đánh tráo chữ ký: hai HDon, DLHDon thứ hai (cạnh hoặc trong DLieu) → 400 XML_AMBIGUOUS', () => {
    const signed = signInvoice(fixture('vn-einvoice-vat.xml'), key);
    const inner = signed.replace(/<\?xml[^>]*\?>/, '');
    expect(code(() => parseInvoiceXml(`<TDiep><DLieu>${inner}${inner}</DLieu></TDiep>`))).toEqual(['XML_AMBIGUOUS', 400]);
    const forged = /<DLHDon[\s\S]*<\/DLHDon>/.exec(signed)![0].replace('0100000001', '0999999999').replace('<SHDon>00000123', '<SHDon>99999999').replace('Id="data"', 'Id="evil"');
    expect(code(() => parseInvoiceXml(signed.replace('</DLHDon>', `</DLHDon>${forged}`)))).toEqual(['XML_AMBIGUOUS', 400]);
    expect(code(() => parseInvoiceXml(signed.replace('<DSCKS>', `<DLieu>${forged}</DLieu><DSCKS>`)))).toEqual(['XML_AMBIGUOUS', 400]);
  });
});
