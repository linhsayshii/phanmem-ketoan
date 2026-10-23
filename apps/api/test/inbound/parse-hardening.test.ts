import { afterAll, describe, expect, it } from 'vitest';
import { parseInvoiceXml } from '../../src/modules/inbound/parseXml.js';
import { dropKey, makeKey } from '../signing/keys.js';
import { fixture, signInvoice } from './helpers.js';

const key = makeKey('Nguoi ban'); afterAll(() => dropKey(key));
const BOM = String.fromCharCode(0xfeff);
const VAT = () => fixture('vn-einvoice-vat.xml');
const code = (f: () => unknown) => { try { f(); return null; } catch (e) { return [(e as { code?: string }).code, (e as { status?: number }).status]; } };
const codes = (p: { warnings: { code: string }[] }) => p.warnings.map((w) => w.code);

describe('parseInvoiceXml: chống đầu vào độc', () => {
  it('lồng sâu 6000 tầng → 400 XML_INVALID, không RangeError', () => {
    expect(code(() => parseInvoiceXml(`<HDon>${'<x>'.repeat(6000)}${'</x>'.repeat(6000)}</HDon>`))).toEqual(['XML_INVALID', 400]);
    expect(code(() => parseInvoiceXml(VAT().replace('</NDHDon>', `${'<x>'.repeat(100)}${'</x>'.repeat(100)}</NDHDon>`)))).toEqual(['XML_INVALID', 400]);
  });

  it('ký tự điều khiển (thô hoặc qua tham chiếu số) → XML_INVALID', () => {
    expect(code(() => parseInvoiceXml(VAT().replace('Giấy in A4', 'Giấy\u0001in')))).toEqual(['XML_INVALID', 400]);
    expect(code(() => parseInvoiceXml(VAT().replace('Giấy in A4', 'Giấy&#1;in')))).toEqual(['XML_INVALID', 400]);
    expect(code(() => parseInvoiceXml(VAT().replace('Giấy in A4', 'Giấy&#0;in')))).toEqual(['XML_INVALID', 400]);
    expect(code(() => parseInvoiceXml(VAT().replace('Giấy in A4', 'Giấy&#x8;in')))).toEqual(['XML_INVALID', 400]);
  });

  it('số quá 16 chữ số nguyên hoặc quá 4 số lẻ → null + NUMBER_FORMAT + blocked; không lưu thành 0', () => {
    const big = parseInvoiceXml(VAT().replace('<ThTien>1000000</ThTien>', '<ThTien>12345678901234567</ThTien>'));
    expect(big.lines[0]!.amount).toBeNull(); expect(codes(big)).toContain('NUMBER_FORMAT'); expect(big.blocked).toBe(true);
    const dec = parseInvoiceXml(VAT().replace('<TgTTTBSo>1430000</TgTTTBSo>', '<TgTTTBSo>1430000.12345</TgTTTBSo>'));
    expect(dec.totals.total).toBeNull(); expect(dec.blocked).toBe(true);
    const ok = parseInvoiceXml(VAT().replace('<TgTTTBSo>1430000</TgTTTBSo>', '<TgTTTBSo>1430000.1234</TgTTTBSo>'));
    expect(ok.totals.total).toBe('1430000.1234'); expect(ok.blocked).toBe(false);
    expect(parseInvoiceXml(VAT()).blocked).toBe(false);
  });

  it('tổng suy ra vượt cột thì null + blocked', () => {
    const x = VAT().replace('<ThTien>1000000</ThTien>', '<ThTien>9999999999999999</ThTien>').replace('<ThTien>300000</ThTien>', '<ThTien>9999999999999999</ThTien>')
      .replace(/<TgTCThue>.*<\/TgTCThue>\s*<TgTThue>.*<\/TgTThue>\s*<TgTTTBSo>.*<\/TgTTTBSo>/, '');
    const p = parseInvoiceXml(x);
    expect(p.totals.beforeTax).toBeNull(); expect(p.blocked).toBe(true);
  });

  it('STT vượt int hoặc lạ → đánh số lại tuần tự và cảnh báo', () => {
    const p = parseInvoiceXml(VAT().replace('<STT>1</STT>', '<STT>99999999999</STT>'));
    expect(p.lines.map((l) => l.lineNo)).toEqual([1, 2]); expect(codes(p)).toContain('LINE_NO_RENUMBERED');
  });

  it('BOM UTF-8 ở đầu: nhận cả không ký lẫn đã ký', () => {
    expect(parseInvoiceXml(`${BOM}${VAT()}`).invoiceNo).toBe('00000123');
    const p = parseInvoiceXml(`${BOM}${signInvoice(VAT(), key)}`);
    expect(p.signatures.seller?.valid).toBe(true);
  });

  it('MCCQT không được ký → CQT_CODE_UNSIGNED; chứng thư không có MST → SIGNER_TAXCODE_UNKNOWN', () => {
    const u = parseInvoiceXml(VAT()); expect(u.cqtCode).toBeTruthy(); expect(codes(u)).toContain('CQT_CODE_UNSIGNED');
    const s = parseInvoiceXml(signInvoice(VAT(), key)); expect(codes(s)).toContain('CQT_CODE_UNSIGNED'); expect(codes(s)).toContain('SIGNER_TAXCODE_UNKNOWN');
  });

  it('hóa đơn VND có phần lẻ (500.000 đọc thành 500) → VND_FRACTION', () => {
    expect(codes(parseInvoiceXml(VAT().replace('<ThTien>300000</ThTien>', '<ThTien>500.000</ThTien>')))).toContain('VND_FRACTION');
    expect(codes(parseInvoiceXml(VAT()))).not.toContain('VND_FRACTION');
  });
});
