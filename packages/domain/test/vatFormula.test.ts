import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FormulaError } from '../src/reportFormula.js';
import { evalVatReturn, vatInvoiceKey as k, type VatFormTemplate } from '../src/vatFormula.js';

// Mẫu 01/GTGT TT89 thật (dữ liệu của @kt/coa-data; đọc tệp để @kt/domain không phụ thuộc vòng vào @kt/coa-data).
const TT89 = JSON.parse(readFileSync(new URL('../../coa-data/data/tax/01gtgt-tt89.json', import.meta.url), 'utf8')) as VatFormTemplate;
const empty = { invoice: {}, carry: '0', manual: {}, overrides: {} };

describe('evalVatReturn', () => {
  it('số liệu ví dụ: mua 100tr/10tr nhóm 01, bán 10% 300tr/30tr, KCT 50tr', () => {
    const v = evalVatReturn(TT89, { ...empty, invoice: { [k('purchase', '01', 'base')]: '100000000', [k('purchase', '01', 'tax')]: '10000000', [k('sale', '10', 'base')]: '300000000', [k('sale', '10', 'tax')]: '30000000', [k('sale', 'KCT', 'base')]: '50000000' } });
    expect(v).toMatchObject({ '21': '', '22': '0', '23': '100000000', '24': '10000000', '23a': '0', '24a': '0', '25': '10000000', '26': '50000000', '32': '300000000', '33': '30000000', '27': '300000000', '28': '30000000',
      '34': '350000000', '35': '30000000', '36': '20000000', '40a': '20000000', '40': '20000000', '41': '0', '43': '0' });
    expect(Object.keys(v).sort()).toEqual(TT89.lines.map((l) => l.code).sort()); // đủ chỉ tiêu của mẫu
  });

  it('tính theo thứ tự phụ thuộc, không theo thứ tự dòng trong mẫu', () => {
    const t: VatFormTemplate = { lines: [{ code: 'A', kind: 'formula', formula: '[B]+[C]' }, { code: 'B', kind: 'formula', formula: '[C]-[M]' }, { code: 'C', kind: 'carry' }, { code: 'M', kind: 'manual' }] };
    expect(evalVatReturn(t, { ...empty, carry: '10', manual: { M: '3' } })).toEqual({ A: '17', B: '7', C: '10', M: '3' });
  });

  it('clamp: biểu thức -5 thì [41]=5, [40a]=0; biểu thức 7 thì [40a]=7, [41]=0; [43]=[41]-[42]', () => {
    const neg = evalVatReturn(TT89, { ...empty, carry: '5' });
    expect([neg['36'], neg['40a'], neg['40'], neg['41'], neg['43']]).toEqual(['0', '0', '0', '5', '5']);
    const pos = evalVatReturn(TT89, { ...empty, manual: { '37': '7' } });
    expect([pos['40a'], pos['41'], pos['43']]).toEqual(['7', '0', '0']);
    const refund = evalVatReturn(TT89, { ...empty, carry: '50', manual: { '42': '20' } });
    expect([refund['41'], refund['42'], refund['43']]).toEqual(['50', '20', '30']);
  });

  it('[21] = X khi không có hóa đơn nào (kể cả có số chuyển kỳ), rỗng khi có', () => {
    expect(evalVatReturn(TT89, { ...empty, carry: '5' })['21']).toBe('X');
    expect(evalVatReturn(TT89, { ...empty, invoice: { [k('purchase', '01', 'base')]: '0', [k('purchase', '01', 'tax')]: '0' } })['21']).toBe('X');
    expect(evalVatReturn(TT89, { ...empty, invoice: { [k('sale', 'KCT', 'base')]: '1' } })['21']).toBe('');
  });

  it('hàng nhập khẩu vào [23a]/[24a] và cả [23]/[24]', () => {
    const v = evalVatReturn(TT89, { ...empty, invoice: { [k('purchase', '01', 'base')]: '300', [k('purchase', '01', 'tax')]: '30', [k('purchase', '01', 'base', true)]: '100', [k('purchase', '01', 'tax', true)]: '10' } });
    expect([v['23'], v['24'], v['23a'], v['24a']]).toEqual(['300', '30', '100', '10']);
  });

  it('[25]: thuế nhóm 01 + thuế nhóm 03 × [27]/[34], làm tròn; doanh thu 0 thì khấu trừ cả nhóm 03', () => {
    const inv = { [k('purchase', '01', 'tax')]: '10', [k('purchase', '03', 'tax')]: '6', [k('purchase', '02', 'tax')]: '100', [k('sale', '10', 'base')]: '300', [k('sale', 'KCT', 'base')]: '100' };
    const v = evalVatReturn(TT89, { ...empty, invoice: inv });
    expect([v['24'], v['25'], v['36']]).toEqual(['116', '15', '-15']); // 6 × 300/400 = 4,5 → 5
    expect(evalVatReturn(TT89, { ...empty, invoice: { [k('purchase', '03', 'tax')]: '6' } })['25']).toBe('6');
  });

  it('ghi đè chỉ tiêu được phép thay số tính và các chỉ tiêu phụ thuộc dùng số ghi đè', () => {
    const v = evalVatReturn(TT89, { ...empty, invoice: { [k('purchase', '01', 'tax')]: '10', [k('sale', '10', 'tax')]: '30' }, overrides: { '25': '4' } });
    expect([v['25'], v['36'], v['40a']]).toEqual(['4', '26', '26']);
    expect(() => evalVatReturn(TT89, { ...empty, overrides: { '36': '1' } })).toThrow(FormulaError);
  });

  it('chu trình, chỉ tiêu không có và tham chiếu tài khoản bị từ chối', () => {
    expect(() => evalVatReturn({ lines: [{ code: 'A', kind: 'formula', formula: '[B]' }, { code: 'B', kind: 'formula', formula: '[A]+[C]' }, { code: 'C', kind: 'carry' }] }, empty)).toThrow(/Vòng lặp/);
    expect(() => evalVatReturn({ lines: [{ code: 'A', kind: 'formula', formula: '[Z]' }] }, empty)).toThrow(/\[Z\] không có/);
    expect(() => evalVatReturn({ lines: [{ code: 'A', kind: 'formula', formula: '[A]' }] }, empty)).toThrow(FormulaError);
    expect(() => evalVatReturn({ lines: [{ code: 'A', kind: 'formula', formula: '511(5111) + [B]' }, { code: 'B', kind: 'carry' }] }, empty)).toThrow(/chỉ được tham chiếu chỉ tiêu/);
    expect(() => evalVatReturn({ lines: [{ code: 'A', kind: 'formula', formula: 'N511/C131' }] }, empty)).toThrow(/chỉ được tham chiếu chỉ tiêu/);
    expect(() => evalVatReturn({ lines: [{ code: 'A', kind: 'formula', formula: '[B] + 1.5' }, { code: 'B', kind: 'carry' }] }, empty)).toThrow(/số nguyên/);
    // hạng tử đánh giá lại ngoại tệ của báo cáo tài chính không dùng được trong tờ khai
    for (const f of ['REVAL_GAIN', '[B] + REVAL_LOSS', '515!REVAL']) expect(() => evalVatReturn({ lines: [{ code: 'A', kind: 'formula', formula: f }, { code: 'B', kind: 'carry' }] }, empty), f).toThrow(/chỉ được tham chiếu chỉ tiêu/);
    // hằng nguyên (parser đọc như tiền tố tài khoản) và 0 được nhận
    expect(evalVatReturn({ lines: [{ code: 'A', kind: 'formula', formula: '[B] + 100 - 0' }, { code: 'B', kind: 'carry' }] }, { ...empty, carry: '5' })).toEqual({ A: '105', B: '5' });
    expect(() => evalVatReturn({ lines: [{ code: 'A', kind: 'carry' }] }, { ...empty, carry: '1.5' })).toThrow(FormulaError);
  });
});
