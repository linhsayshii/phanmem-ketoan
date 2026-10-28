import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { evalAmount, checkFormula, FormulaError, type FormulaVars } from '../../src/modules/assistant/formula.js';
import { dueOccurrences, daysInMonth, type ScheduleSpec } from '../../src/modules/assistant/schedule.js';
import { rankSuggestions, tokens, signatureOf, type HistVoucher } from '../../src/modules/assistant/rank.js';

const V: FormulaVars = { THANG: 3, QUY: 1, NAM: 2026, SO_NGAY: 31 };

describe('công thức số tiền', () => {
  it.each([
    ['5000000', '5000000'], ['1000000 * 12 / 12', '1000000'], ['10000000 / 3', '3333333'], ['20000000 / 3', '6666667'], // làm tròn nửa lên về đồng
    ['ROUND(100 / 8)', '13'], ['ROUND(2.5)', '3'], ['ROUND(1.2345, 2) * 100', '123'], ['MAX(10, THANG * 5)', '15'], ['MIN(10, THANG * 5)', '10'],
    ['300000 * SO_NGAY', '9300000'], ['(1 + 2) * (3 + 4)', '21'], ['-5 + 10', '5'], ['0.1 + 0.2', '0'], ['0.1 * 3 * 10', '3'], ['thang + quy', '4'],
  ])('%s = %s', (expr, out) => expect(evalAmount(expr, V)).toBe(out));
  it('decimal.js: 0,1 + 0,2 chính xác, không sai số nhị phân', () => expect(evalAmount('(0.1 + 0.2) * 10', V)).toBe('3'));
  it.each([
    ['1 +', 'thiếu vế'], ['(1 + 2', 'Thiếu dấu'], ['1 / 0', 'Chia cho 0'], ['5 - 10', 'âm'], ['FOO(1)', 'Hàm không có'], ['BAR + 1', 'Biến không có'],
    ['1; process.exit()', 'Ký tự'], ['constructor', 'Biến không có'], ['__proto__', 'Biến không có'], ['9999999999999999 + 1', '16 chữ số'], ['1e5', 'sai cú pháp'], ['ROUND(1, 9)', 'số lẻ'], ['1 2', 'sai cú pháp'],
    ['('.repeat(40) + '1' + ')'.repeat(40), 'lồng quá sâu'], ['1'.padEnd(201, '+1'), 'dài quá'], ['12345678901234567', 'Số'],
  ])('từ chối %s', (expr, msg) => { expect(() => evalAmount(expr, V)).toThrow(FormulaError); expect(() => evalAmount(expr, V)).toThrow(new RegExp(msg, 'i')); });
  it('checkFormula chấp nhận công thức đúng, từ chối sai', () => { expect(() => checkFormula('1000 * THANG')).not.toThrow(); expect(() => checkFormula('1000 *')).toThrow(FormulaError); });
  it('thuộc tính: tổng số nguyên + số nguyên bằng cộng chuỗi thập phân', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 4_999_999_999_999_999n }), fc.bigInt({ min: 0n, max: 4_999_999_999_999_999n }), (a, b) => evalAmount(`${a} + ${b}`, V) === (a + b).toString()));
  });
});

const spec = (o: Partial<ScheduleSpec> = {}): ScheduleSpec => ({ frequency: 'monthly', dayOfMonth: 31, startDate: '2026-01-01', endDate: null, catchUp: true, createdAt: '2026-01-05T00:00:00Z', ...o });
describe('lịch bút toán định kỳ', () => {
  it('hằng tháng, ngày 31 cắt về cuối tháng (năm nhuận)', () => {
    expect(dueOccurrences(spec(), '2026-04-30').map((o) => o.date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(dueOccurrences(spec({ startDate: '2028-02-01' }), '2028-03-01').map((o) => o.date)).toEqual(['2028-02-29']);
    expect(daysInMonth(2024, 2)).toBe(29);
  });
  it('quý: cách 3 tháng từ tháng bắt đầu; năm: cùng tháng mỗi năm', () => {
    expect(dueOccurrences(spec({ frequency: 'quarterly', startDate: '2026-02-01', dayOfMonth: 15 }), '2026-12-31').map((o) => o.periodKey)).toEqual(['2026-02', '2026-05', '2026-08', '2026-11']);
    expect(dueOccurrences(spec({ frequency: 'yearly', startDate: '2025-03-01', dayOfMonth: 10 }), '2027-12-31').map((o) => o.date)).toEqual(['2025-03-10', '2026-03-10', '2027-03-10']);
  });
  it('chưa đến hạn thì không có; hết hạn (end_date) dừng', () => {
    expect(dueOccurrences(spec({ dayOfMonth: 20 }), '2026-01-19')).toEqual([]);
    expect(dueOccurrences(spec({ dayOfMonth: 20, endDate: '2026-02-28' }), '2026-12-31').map((o) => o.periodKey)).toEqual(['2026-01', '2026-02']);
  });
  it('không bù: bỏ kỳ trước tháng lập mẫu; có bù: sinh từ start_date', () => {
    const base = { startDate: '2026-01-01', createdAt: '2026-03-12T00:00:00Z', dayOfMonth: 5 };
    expect(dueOccurrences(spec({ ...base, catchUp: false }), '2026-04-30').map((o) => o.periodKey)).toEqual(['2026-03', '2026-04']);
    expect(dueOccurrences(spec({ ...base, catchUp: true }), '2026-04-30').map((o) => o.periodKey)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
  });
  it('giới hạn 120 kỳ mỗi lần quét', () => { expect(dueOccurrences(spec({ startDate: '2000-01-01' }), '2099-12-31')).toHaveLength(120); });
});

describe('xếp hạng gợi ý (số tính tay)', () => {
  const L = (...p: ['debit' | 'credit', string][]) => p.map(([side, accountCode]) => ({ side, accountCode }));
  const A = L(['debit', '6422'], ['credit', '1111']);
  const hist: HistVoucher[] = [
    { id: 'h1', voucherType: 'PC', postingDate: '2026-09-28', partyCodes: ['NCC001'], description: 'Thuê văn phòng tháng 9', itemCodes: [], total: '10000000', lines: A },
    { id: 'h2', voucherType: 'PC', postingDate: '2026-08-28', partyCodes: ['NCC001'], description: 'Thuê văn phòng tháng 8', itemCodes: [], total: '10000000', lines: A },
    { id: 'h3', voucherType: 'PC', postingDate: '2024-01-10', partyCodes: ['NCC001'], description: 'Thuê văn phòng', itemCodes: [], total: '9500000', lines: A },
    { id: 'h4', voucherType: 'PC', postingDate: '2026-10-01', partyCodes: ['NCC002'], description: 'Mua văn phòng phẩm', itemCodes: [], total: '200000', lines: L(['debit', '152'], ['credit', '1111']) },
    { id: 'h5', voucherType: 'HDM', postingDate: '2026-10-02', partyCodes: ['NCC001'], description: 'Giao hàng', itemCodes: [], total: '5', lines: L(['debit', '156'], ['credit', '331']) },
    { id: 'h6', voucherType: 'PT', postingDate: '2026-10-03', partyCodes: ['KH001'], description: 'Thu tiền hàng', itemCodes: [], total: '7', lines: L(['debit', '1111'], ['credit', '131']) },
    { id: 'h7', voucherType: 'PC', postingDate: '2026-10-04', partyCodes: [], description: 'Chỉ một bên', itemCodes: [], total: '9', lines: L(['debit', '6422']) }, // thiếu bên Có: bỏ
  ];
  const q = { voucherType: 'PC', partyCode: 'NCC001', description: 'Thanh toán tiền thuê văn phòng tháng 10', amount: '10000000', asOf: '2026-10-28' };
  it('tách từ bỏ dấu, bỏ số và từ dừng', () => expect(tokens('Thanh toán tiền thuê Văn phòng tháng 10 của Đức')).toEqual(['duc', 'phong', 'thanh', 'thue', 'tien', 'toan', 'van']));
  it('chữ ký không phụ thuộc thứ tự dòng', () => expect(signatureOf(L(['credit', '1111'], ['debit', '6422']))).toBe(signatureOf(A)));
  it('điểm: A = 6 + 6 + 3 = 15; HDM cùng đối tượng = 3; mua VPP = 2; thu tiền = 0,5', () => {
    const r = rankSuggestions(hist, q);
    expect(r.map((s) => [s.signature, s.score])).toEqual([['C:1111|N:6422', 15], ['C:331|N:156', 3], ['C:1111|N:152', 2], ['C:131|N:1111', 0.5]]);
    expect(r[0]).toMatchObject({ support: 3, samePartyCount: 3, sameTypeCount: 3, amountCount: 3, lastUsed: '2026-09-28', confidence: 0.73, sampleVoucherIds: ['h1', 'h2', 'h3'] });
    expect(r[0]!.reasons[0]).toBe('Đã dùng 3 lần cho cùng đối tượng NCC001');
    expect(r[0]!.reasons.at(-1)).toBe('Chiếm 73% các bút toán tương tự');
    expect(r[0]!.keywords).toEqual(['phong', 'thue', 'van']);
  });
  it('giới hạn số gợi ý; chỉ có loại chứng từ thì xếp theo tần suất', () => {
    expect(rankSuggestions(hist, q, 2)).toHaveLength(2);
    const t = rankSuggestions(hist, { voucherType: 'PC', asOf: '2026-10-28' });
    expect(t.map((s) => [s.signature, s.score])).toEqual([['C:1111|N:6422', 2.5], ['C:1111|N:152', 1]]); // 1 + 1 + 0,5 (h3 cũ)
  });
  it('mặt hàng cùng mã cộng 2; không có đặc trưng nào khớp thì không có gợi ý', () => {
    const h: HistVoucher[] = [{ ...hist[0]!, id: 'x', itemCodes: ['VT01'] }];
    expect(rankSuggestions(h, { itemCodes: ['VT01'], asOf: '2026-10-28' })[0]!.score).toBe(2);
    expect(rankSuggestions(h, { partyCode: 'KHAC', asOf: '2026-10-28' })).toEqual([]);
  });
  it('xác định: cùng đầu vào cho cùng kết quả, không phụ thuộc thứ tự lịch sử', () => {
    expect(rankSuggestions([...hist].reverse(), q)).toEqual(rankSuggestions(hist, q).map((s) => ({ ...s, sampleVoucherIds: s.sampleVoucherIds })));
  });
  it('số tiền gần bằng dùng số nguyên: 9.000.000 so 10.000.000 đúng biên 90%, 8.999.999 thì không', () => {
    const base = { ...hist[0]!, description: null, partyCodes: [], voucherType: 'ZZ' };
    expect(rankSuggestions([{ ...base, total: '9000000' }], { amount: '10000000', asOf: '2026-10-28' })[0]!.score).toBe(0.5);
    expect(rankSuggestions([{ ...base, total: '8999999' }], { amount: '10000000', asOf: '2026-10-28' })).toEqual([]);
  });
});
