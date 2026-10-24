import { describe, expect, it } from 'vitest';
import { CASH_PURPOSES, SYSTEM_VOUCHER_TYPES, VOUCHER_TYPES, voucherTypeDef } from '../src/index.js';

const GD2_TYPES = ['PT', 'PC', 'BC', 'BN', 'CT', 'QTU', 'BT', 'HDB', 'HDM', 'GGB', 'GGM', 'CL', 'DG', 'XQ', 'KTT'];

describe('VOUCHER_TYPES', () => {
  it('voucherTypeDef: mã có trong danh sách trả cấu hình; khóa của Object.prototype và mã lạ trả undefined', () => {
    expect(voucherTypeDef('PT')).toBe(VOUCHER_TYPES['PT']);
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'ZZ']) expect(voucherTypeDef(k), k).toBeUndefined();
  });

  it('đủ 15 loại GĐ2 và 4 loại có sẵn; khóa trùng mã', () => {
    expect(Object.keys(VOUCHER_TYPES).sort()).toEqual([...GD2_TYPES, 'PKT', 'DK', 'KC', 'PB', 'PNK', 'PXK', 'CK', 'GV', 'MH', 'TLM', 'CPM', 'BH', 'TLB', 'LR', 'TS', 'KH', 'LV', 'LU', 'GT'].sort());
    for (const [k, d] of Object.entries(VOUCHER_TYPES)) expect(d.code).toBe(k);
  });

  it('phần hành khớp bảng loại chứng từ; loại hệ thống không lập tay, còn lại lập tay', () => {
    expect(SYSTEM_VOUCHER_TYPES).toEqual(['DK', 'KC', 'CL', 'DG', 'XQ', 'KTT', 'GV', 'TS', 'KH', 'LV', 'LU', 'GT']);
    expect(Object.fromEntries(Object.values(VOUCHER_TYPES).map((d) => [d.code, d.module]))).toEqual({
      PKT: 'general', DK: 'general', KC: 'general', PB: 'general', PT: 'cash', PC: 'cash', BC: 'bank', BN: 'bank', CT: 'bank', QTU: 'general', BT: 'arap',
      HDB: 'arap', HDM: 'arap', GGB: 'arap', GGM: 'arap', CL: 'arap', DG: 'general', XQ: 'general', KTT: 'general', PNK: 'inventory', PXK: 'inventory', CK: 'inventory', GV: 'inventory', MH: 'arap', TLM: 'arap', CPM: 'arap', BH: 'arap', TLB: 'arap', LR: 'inventory', TS: 'assets', KH: 'assets', LV: 'general', LU: 'payroll', GT: 'inventory' });
    for (const d of Object.values(VOUCHER_TYPES)) expect(d.manual, d.code).toBe(!SYSTEM_VOUCHER_TYPES.includes(d.code));
  });

  it('thu/chi: chiều quỹ và loại tiền; trường bắt buộc nằm trong tiêu đề', () => {
    expect(['PT', 'PC', 'BC', 'BN'].map((c) => [VOUCHER_TYPES[c]!.cashSide, VOUCHER_TYPES[c]!.moneyKind])).toEqual([['in', 'cash'], ['out', 'cash'], ['in', 'bank'], ['out', 'bank']]);
    for (const d of Object.values(VOUCHER_TYPES)) for (const f of d.required) expect(d.header, `${d.code}.${f}`).toContain(f);
  });

  it('hóa đơn: có vật tư/dòng hàng, chiều mua bán, giảm giá trả lại; mẫu in PT/PC/BC/BN', () => {
    expect(['HDB', 'HDM', 'GGB', 'GGM'].map((c) => { const d = VOUCHER_TYPES[c]!; return [d.hasItems, d.invoiceDirection, d.refund ?? false]; }))
      .toEqual([[true, 'sale', false], [true, 'purchase', false], [true, 'sale', true], [true, 'purchase', true]]);
    expect(Object.values(VOUCHER_TYPES).filter((d) => d.hasItems && !d.stockDirection).map((d) => d.code)).toEqual(['HDB', 'HDM', 'GGB', 'GGM', 'MH', 'TLM', 'BH', 'TLB']);
    expect(Object.values(VOUCHER_TYPES).filter((d) => d.stockDirection).map((d) => [d.code, d.stockDirection])).toEqual([['PNK', 'in'], ['PXK', 'out'], ['CK', 'transfer'], ['LR', 'assembly']]);
    expect(['PT', 'PC', 'BC', 'BN'].map((c) => VOUCHER_TYPES[c]!.printForms)).toEqual([['01-TT'], ['02-TT'], ['giay-bao'], ['giay-bao', 'unc']]);
  });
});

describe('CASH_PURPOSES', () => {
  it('mã duy nhất, loại hợp lệ, mỗi chế độ có tài khoản đối ứng', () => {
    expect(new Set(CASH_PURPOSES.map((p) => p.code)).size).toBe(CASH_PURPOSES.length);
    for (const p of CASH_PURPOSES) {
      expect(p.types.length, p.code).toBeGreaterThan(0);
      for (const r of ['TT133', 'TT99', 'TT200'] as const) expect(p.counterAccounts[r].length, `${p.code}/${r}`).toBeGreaterThan(0);
    }
  });

  it('thu dùng PT/BC, chi dùng PC/BN; mục đích thu khách hàng và chi nhà cung cấp bắt buộc đối tượng', () => {
    for (const p of CASH_PURPOSES) {
      const income = p.types.every((x) => x === 'PT' || x === 'BC'); const expense = p.types.every((x) => x === 'PC' || x === 'BN');
      expect(income || expense, p.code).toBe(true);
    }
    const by = Object.fromEntries(CASH_PURPOSES.map((p) => [p.code, p]));
    expect(by.thu_khach_hang).toMatchObject({ types: ['PT', 'BC'], partyRequired: true, counterAccounts: { TT133: ['131'], TT99: ['131'], TT200: ['131'] } });
    expect(by.chi_tra_ncc).toMatchObject({ types: ['PC', 'BN'], partyRequired: true, counterAccounts: { TT133: ['331'] } });
    expect(by.nop_thue!.counterAccounts.TT133).toEqual(expect.arrayContaining(['33311', '3334', '3335']));
  });
});
