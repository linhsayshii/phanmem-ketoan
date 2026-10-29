import { describe, expect, it } from 'vitest';
import { FORMS, bookFormFor, formNoFor, voucherFormFor } from '../src/modules/reporting/print/forms.js';

// GĐ7 gói 2 (C1, TB1-TB3): số mẫu chỉ giữ khi đã đối chiếu văn bản gốc; hai sổ/báo cáo khác nhau không được cùng số mẫu trong một chế độ.
describe('số mẫu sổ và báo cáo', () => {
  it('không có hai khóa khác nhau trùng số mẫu trong cùng một chế độ', () => {
    for (const regime of ['TT99', 'TT133', 'TT200']) {
      const seen = new Map<string, string>();
      for (const [key, byRegime] of Object.entries(FORMS)) {
        const no = byRegime[regime]; if (!no) continue;
        expect(seen.get(no), `${regime}: ${key} trùng số mẫu ${no} với ${seen.get(no)}`).toBeUndefined();
        seen.set(no, key);
      }
    }
  });
  it('Bảng cân đối số phát sinh, Nhật ký chung, Sổ Cái, sổ chi tiết, Chứng từ ghi sổ chưa đối chiếu: để trống số mẫu', () => {
    for (const regime of ['TT99', 'TT133', 'TT200']) for (const key of ['S06', 'S03a', 'S03b', 'S38', 'S02a', 'S02b', 'S02c1']) {
      expect(formNoFor(regime, key), `${regime} ${key}`).toEqual({ formNo: '', issuedBy: '' });
      expect(bookFormFor(regime, key)).toBeNull();
    }
    expect(bookFormFor('TT133', 'stock-ledger')?.formNo).toBe('S06-DNN'); // đã đối chiếu: sổ chi tiết vật liệu
  });
  it('TT200 chỉ in số mẫu và "Ban hành theo" cho báo cáo tài chính B01-DN, B02-DN, B03-DN (Phụ lục 2); sổ và chứng từ chưa có bản gốc nên để trống', () => {
    const issued = 'Ban hành theo Thông tư số 200/2014/TT-BTC ngày 22/12/2014 của Bộ Tài chính';
    expect(formNoFor('TT200', 'B01')).toEqual({ formNo: 'B01-DN', issuedBy: issued });
    expect(formNoFor('TT200', 'B02')).toEqual({ formNo: 'B02-DN', issuedBy: issued });
    expect(formNoFor('TT200', 'B03')).toEqual({ formNo: 'B03-DN', issuedBy: issued });
    for (const key of Object.keys(FORMS).filter((k) => !['B01', 'B02', 'B03'].includes(k))) {
      expect(formNoFor('TT200', key), key).toEqual({ formNo: '', issuedBy: '' });
      expect(bookFormFor('TT200', key), key).toBeNull(); expect(voucherFormFor('TT200', key), key).toBeNull();
    }
    expect(formNoFor('TT133', 'B01')).toMatchObject({ formNo: 'B01a-DNN' });
  });
});
