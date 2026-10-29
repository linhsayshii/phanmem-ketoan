import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { SignedXml } from 'xml-crypto';
import { prepareEnveloped, verifyEnveloped } from '../../src/modules/signing/xmldsig.js';
import { dropKey, makeKey, signDigest } from './keys.js';

const key = makeKey('Nguyen Van A');
const other = makeKey('Ben khac');
afterAll(() => { dropKey(key); dropKey(other); });
const fixture = readFileSync(new URL('../fixtures/xml/vn-einvoice-vat.xml', import.meta.url), 'utf8');
const small = '<?xml version="1.0" encoding="UTF-8"?>\n<ToKhai xmlns="urn:kt:test"><TTChung><Ky>01/2026</Ky></TTChung><Tien>1000</Tien></ToKhai>';
const sign = (xml: string, refUri?: string) => {
  const p = prepareEnveloped(xml, key.certDer, { signingTime: '2026-10-24T09:30:00', ...(refUri !== undefined && { refUri }) });
  return p.finish(signDigest(key.keyPem, p.digestB64));
};

describe('xmldsig', () => {
  it('prepareEnveloped + ký bằng khóa thử + finish → verifyEnveloped valid, SigningTime đúng, chứng thư đúng', () => {
    for (const [xml, ref] of [[small, undefined], [fixture, '#data']] as const) {
      const signed = sign(xml, ref);
      const v = verifyEnveloped(signed, ref ? { targets: ['DLHDon'] } : {});
      expect(v.reason).toBeUndefined();
      expect(v).toMatchObject({ valid: true, signingTime: '2026-10-24T09:30:00' });
      expect(v.certDer!.equals(key.certDer)).toBe(true);
      expect(v.signedPaths).toEqual([ref ? '/HDon/DLHDon' : '/ToKhai']);
      expect(v.subject).toContain('CN=Nguyen Van A');
      expect(signed).toContain('X509SubjectName');
    }
    expect(sign(small)).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
  });
  it('sửa một ký tự nội dung (hoặc SigningTime, hoặc chữ ký) sau ký → invalid', () => {
    for (const [xml, ref] of [[small, undefined], [fixture, '#data']] as const) {
      const signed = sign(xml, ref);
      const bad = signed.replace(xml === small ? '<Tien>1000' : '<SHDon>00000123', xml === small ? '<Tien>1001' : '<SHDon>00000124');
      expect(bad).not.toBe(signed);
      expect(verifyEnveloped(bad, { targets: ['DLHDon'] }).valid).toBe(false);
    }
    const s = sign(small);
    expect(verifyEnveloped(s.replace('2026-10-24T09:30:00', '2026-10-25T09:30:00'))).toMatchObject({ valid: false });
    // Ký tự thay phải khác ký tự cũ (khóa sinh ngẫu nhiên mỗi lần chạy: ký tự thứ hai có thể đã là 'A').
    const tampered = s.replace(/(<ds:SignatureValue>.)(.)/, (_m, a: string, c: string) => a + (c === 'A' ? 'B' : 'A'));
    expect(tampered).not.toBe(s);
    expect(verifyEnveloped(tampered).valid).toBe(false);
  });
  it('chữ ký của khóa khác, hoặc hoặc Reference không tồn tại → invalid', () => {
    const p = prepareEnveloped(small, key.certDer, { signingTime: '2026-10-24T09:30:00' });
    expect(verifyEnveloped(p.finish(signDigest(other.keyPem, p.digestB64))).reason).toMatch(/không khớp chứng thư/);
    expect(() => prepareEnveloped(small, key.certDer, { refUri: '#khong-co', signingTime: 'x' })).toThrow(/Không tìm thấy/);
    expect(verifyEnveloped('<a/>').valid).toBe(false);
    expect(verifyEnveloped('<!DOCTYPE a [<!ENTITY x "y">]><a/>').valid).toBe(false);
  });
  it('tương thích xml-crypto: bản ký của ta được SignedXml.checkSignature chấp nhận; DSig thuần do xml-crypto ký được ta chấp nhận (SigningTime null)', () => {
    const uniq = fixture.replace('<MCCQT Id="data">', '<MCCQT>'); // xml-crypto từ chối Id trùng (mẫu thật trùng Id="data")
    const ours = sign(uniq, '#data');
    const sx = new SignedXml({ publicCert: key.certPem });
    const sigNode = ours.slice(ours.indexOf('<ds:Signature'), ours.indexOf('</ds:Signature>') + '</ds:Signature>'.length);
    sx.loadSignature(sigNode);
    // xml-crypto kiểm theo URI #data; Reference tới SignedProperties nằm trong chính chữ ký nên cần cùng tài liệu.
    expect(sx.checkSignature(ours)).toBe(true);

    const gen = new SignedXml({ privateKey: key.keyPem, publicCert: key.certPem, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315' });
    gen.addReference({ xpath: "//*[@Id='data']", transforms: ['http://www.w3.org/TR/2001/REC-xml-c14n-20010315'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
    gen.computeSignature(uniq, { location: { reference: '/HDon', action: 'append' } });
    const v = verifyEnveloped(gen.getSignedXml());
    expect(v).toMatchObject({ valid: true, signingTime: null });
  });

  describe('chống đánh tráo chữ ký (signature wrapping) và giới hạn đầu vào', () => {
    const signed = sign(fixture, '#data'); // mẫu thật: cả DLHDon và MCCQT mang Id="data"
    const forged = fixture.slice(fixture.indexOf('<DLHDon'), fixture.indexOf('</DLHDon>') + '</DLHDon>'.length).replace('00000123', '99999999');
    it('mẫu thật Id="data" ở DLHDon và MCCQT: có targets [DLHDon] thì hợp lệ và chỉ phủ DLHDon; không targets thì Id trùng → invalid', () => {
      const v = verifyEnveloped(signed, { targets: ['DLHDon'] });
      expect(v.reason).toBeUndefined();
      expect(v.covered.map((e) => e.localName)).toEqual(['DLHDon']);
      expect(verifyEnveloped(signed)).toMatchObject({ valid: false, reason: expect.stringMatching(/Id trùng/) });
    });
    it('thêm DLHDon giả (Id="data") làm anh em, trước hay sau bản thật → invalid', () => {
      for (const bad of [signed.replace('<DLHDon Id="data">', `${forged}<DLHDon Id="data">`), signed.replace('</DLHDon>', `</DLHDon>${forged}`)]) {
        expect(bad).toContain('99999999');
        expect(verifyEnveloped(bad, { targets: ['DLHDon'] })).toMatchObject({ valid: false, reason: expect.stringMatching(/Id trùng/) });
        expect(verifyEnveloped(bad).valid).toBe(false);
      }
    });
    it('Id của phần tử ngoài targets không bị tính là trùng; phần tử trong targets bị đổi Id thì Reference không còn trỏ tới đâu → invalid', () => {
      expect(verifyEnveloped(signed.replace('<MCCQT Id="data">', '<MCCQT Id="khac">'), { targets: ['DLHDon'] }).valid).toBe(true);
      expect(verifyEnveloped(signed.replace('<DLHDon Id="data">', '<DLHDon Id="khac">'), { targets: ['DLHDon'] }).valid).toBe(false);
    });
    it('Reference trỏ phần tử không thuộc targets → invalid', () => {
      expect(verifyEnveloped(signed, { targets: ['MCCQT'] }).valid).toBe(false);
    });
    it('đầu vào quá lớn (> 5 MB) → invalid, không phân tích', () => {
      const big = `<a>${'x'.repeat(5 * 1024 * 1024 + 1)}</a>`;
      expect(verifyEnveloped(big)).toMatchObject({ valid: false, reason: expect.stringMatching(/quá lớn/) });
    });
    it('nhiều X509Certificate: chọn chứng thư có khóa kiểm được chữ ký, báo đúng chứng thư đó', () => {
      const s = sign(small);
      const extra = `<ds:X509Certificate>${other.certDer.toString('base64')}</ds:X509Certificate>`;
      for (const bad of [s.replace('<ds:X509Certificate>', `${extra}<ds:X509Certificate>`), s.replace('</ds:X509Data>', `${extra}</ds:X509Data>`)]) {
        const v = verifyEnveloped(bad);
        expect(v.reason).toBeUndefined();
        expect(v.certDer!.equals(key.certDer)).toBe(true);
        expect(v.subject).toContain('CN=Nguyen Van A');
      }
    });
  });
});
