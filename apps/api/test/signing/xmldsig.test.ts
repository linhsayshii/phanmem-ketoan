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
      const v = verifyEnveloped(signed);
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
      expect(verifyEnveloped(bad).valid).toBe(false);
    }
    const s = sign(small);
    expect(verifyEnveloped(s.replace('2026-10-24T09:30:00', '2026-10-25T09:30:00'))).toMatchObject({ valid: false });
    expect(verifyEnveloped(s.replace(/(<ds:SignatureValue>.)./, '$1A')).valid).toBe(false);
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
});
