import { describe, expect, it } from 'vitest';
import { crc16ccitt, vietQrPayload } from '../src/vietqr.js';

// Nguồn: README vietnam-qr-pay (MIT), xem docs/dev/tich-hop/ngan-hang.md mục 3.
const vectors: [Parameters<typeof vietQrPayload>[0], string][] = [
  [{ bin: '970416', accountNo: '257678859' }, '00020101021138530010A0000007270123000697041601092576788590208QRIBFTTA53037045802VN6304AE9F'],
  [{ bin: '970416', accountNo: '257678859', amount: '10000', content: 'Chuyen tien' }, '00020101021238530010A0000007270123000697041601092576788590208QRIBFTTA53037045405100005802VN62150811Chuyen tien630453E6'],
  [{ bin: '970416', accountNo: '257678859', amount: '999999', content: 'Cam on nhe' }, '00020101021238530010A0000007270123000697041601092576788590208QRIBFTTA530370454069999995802VN62140810Cam on nhe6304E786'],
  [{ bin: '970416', accountNo: '257678859', amount: '1000', content: 'Chuyen tien' }, '00020101021238530010A0000007270123000697041601092576788590208QRIBFTTA5303704540410005802VN62150811Chuyen tien6304BBB8'],
];
const momo = '00020101021138620010A00000072701320006970454011899MM24011M348750800208QRIBFTTA53037045802VN6304';

describe('vietqr', () => {
  it.each(vectors)('vietQrPayload khớp mẫu %#', (input, expected) => { expect(vietQrPayload(input)).toBe(expected); });
  it('TK chữ-số (mẫu 5) đúng tiền tố, CRC 4 hex hoa', () => {
    expect(vietQrPayload({ bin: '970454', accountNo: '99MM24011M34875080' })).toBe(`${momo}${crc16ccitt(momo)}`);
    // Mẫu 5 đầy đủ (có tag 62 riêng của MoMo, builder không sinh) vẫn phải khớp CRC.
    const full = '00020101021138620010A00000072701320006970454011899MM24011M348750800208QRIBFTTA53037045802VN62190515MOMOW2W3487508080030466304';
    expect(crc16ccitt(full)).toBe('EBC8');
  });
  it('crc16ccitt("123456789") = "29B1"', () => { expect(crc16ccitt('123456789')).toBe('29B1'); });
  it('nội dung có dấu "Thanh toán HĐ 12" → "Thanh toan HD 12"; quá 25 ký tự cắt', () => {
    expect(vietQrPayload({ bin: '970416', accountNo: '1', amount: '1', content: 'Thanh toán HĐ 12' })).toContain('0816Thanh toan HD 12');
    expect(vietQrPayload({ bin: '970416', accountNo: '1', amount: '1', content: 'A'.repeat(40) })).toContain(`0825${'A'.repeat(25)}`);
  });
  it('đầu vào sai bị từ chối', () => {
    expect(() => vietQrPayload({ bin: '1234', accountNo: '1' })).toThrow();
    expect(() => vietQrPayload({ bin: '970416', accountNo: '1', amount: '1.5' })).toThrow();
    expect(() => vietQrPayload({ bin: '970416', accountNo: '1', amount: '1'.repeat(14) })).toThrow(); // tag 54 tối đa 13 ký tự
    expect(vietQrPayload({ bin: '970416', accountNo: '1', amount: '9'.repeat(13) })).toContain('5413' + '9'.repeat(13));
  });
});
