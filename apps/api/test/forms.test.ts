import { describe, expect, it } from 'vitest';
import { FORMS, bookFormFor, formNoFor } from '../src/modules/reporting/print/forms.js';

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
  it('TT200 không in số mẫu hay "Ban hành theo" cho sổ và báo cáo', () => {
    for (const key of Object.keys(FORMS)) expect(formNoFor('TT200', key).issuedBy, key).toBe('');
    expect(formNoFor('TT200', 'B01')).toEqual({ formNo: '', issuedBy: '' });
    expect(formNoFor('TT133', 'B01')).toMatchObject({ formNo: 'B01a-DNN' });
  });
});
