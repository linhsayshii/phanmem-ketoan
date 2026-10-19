import { describe, expect, it } from 'vitest';
import { defaultNormalBalance, parseCoaCsv, rootTypeOf, validateCoaTemplate } from '../src/coaTemplate.js';

const csv = `code,name,name_en,parent_code,is_group,normal_balance,track_currency,subledger_kind
111,Tiền mặt,Cash,,1,N,0,
1111,Tiền mặt Việt Nam,,111,0,N,0,cash
1112,Tiền mặt ngoại tệ,,111,0,N,1,cash
131,Phải thu của khách hàng,,,0,L,0,receivable
511,Doanh thu bán hàng và cung cấp dịch vụ,,,0,C,0,
`;

describe('coaTemplate', () => {
  it('phân tích CSV sang dòng mẫu', () => {
    const rows = parseCoaCsv(csv, 'TT99', 'test');
    expect(rows).toHaveLength(5);
    expect(rows[1]).toEqual({ regime: 'TT99', code: '1111', name: 'Tiền mặt Việt Nam', nameEn: null, parentCode: '111', isGroup: false,
      rootType: 'asset', normalBalance: 'debit', trackCurrency: false, subledgerKind: 'cash', source: 'test' });
    expect(rows[3]!.normalBalance).toBe('both');
    expect(rows[4]!.rootType).toBe('income');
  });
  it('rootTypeOf và defaultNormalBalance theo chữ số đầu', () => {
    expect(rootTypeOf('1561')).toBe('asset'); expect(rootTypeOf('331')).toBe('liability'); expect(rootTypeOf('4211')).toBe('equity');
    expect(rootTypeOf('711')).toBe('income'); expect(rootTypeOf('642')).toBe('expense'); expect(rootTypeOf('911')).toBe('income'); expect(rootTypeOf('002')).toBe('off_balance');
    expect(defaultNormalBalance('111')).toBe('debit'); expect(defaultNormalBalance('331')).toBe('credit'); expect(defaultNormalBalance('6421')).toBe('debit'); expect(defaultNormalBalance('515')).toBe('credit');
  });
  it('validate phát hiện cha thiếu, mã con không bắt đầu bằng mã cha, nhóm không có con, trùng mã', () => {
    const rows = parseCoaCsv(`code,name,name_en,parent_code,is_group,normal_balance,track_currency,subledger_kind
111,Tiền mặt,,,1,N,0,
1121,TGNH VND,,112,0,N,0,bank
1311,Phải thu,,111,0,N,0,
1311,Phải thu trùng,,111,0,N,0,
`, 'TT99', 'test');
    const errs = validateCoaTemplate(rows);
    expect(errs).toEqual(expect.arrayContaining([
      expect.stringContaining('1121: không có tài khoản cha 112'),
      expect.stringContaining('1311: mã không bắt đầu bằng mã cha 111'),
      expect.stringContaining('1311: trùng mã'),
    ]));
    const errs2 = validateCoaTemplate(parseCoaCsv(csv.replace('1111,Tiền mặt Việt Nam,,111,0,N,0,cash\n1112,Tiền mặt ngoại tệ,,111,0,N,1,cash\n', ''), 'TT99', 'test'));
    expect(errs2).toEqual([expect.stringContaining('111: là tài khoản tổng hợp nhưng không có tài khoản con')]);
  });
});
