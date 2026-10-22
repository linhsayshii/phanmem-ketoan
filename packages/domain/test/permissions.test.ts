import { describe, expect, it } from 'vitest';
import { flagsForAccounts, PERMISSION_CODES, PERMISSIONS, sensitiveDenial, SENSITIVE_BY_SUBLEDGER } from '../src/index.js';

const GD2_CODES = [
  'settlement.view', 'settlement.create', 'settlement.delete', 'fx.run',
  'cash_count.view', 'cash_count.create', 'cash_count.update', 'cash_count.delete',
  'tax.view', 'tax_return.view', 'tax_return.create', 'tax_return.update', 'tax_return.delete', 'tax_return.finalize', 'tax.offset',
  'voucher.import', 'dedupe.run',
  'amortization.view', 'amortization.create', 'amortization.update', 'amortization.delete', 'amortization.run',
];

describe('quyền GĐ2', () => {
  it('có đủ mã mới, không trùng mã, đối trừ công nợ không có quyền sửa', () => {
    for (const c of GD2_CODES) expect(PERMISSION_CODES, c).toContain(c);
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length);
    expect(PERMISSION_CODES).not.toContain('settlement.update');
  });
  it('nhóm hiển thị theo phân hệ', () => {
    const group = (c: string) => PERMISSIONS.find((p) => p.code === c)!.group;
    expect([group('settlement.view'), group('fx.run'), group('cash_count.view'), group('tax_return.finalize'), group('tax.offset'), group('voucher.import'), group('dedupe.run'), group('amortization.run')])
      .toEqual(['Công nợ', 'Công nợ', 'Quỹ', 'Thuế', 'Thuế', 'Chứng từ', 'Tiện ích', 'Cuối kỳ']);
  });
});

describe('quyền GĐ3', () => {
  it('có đủ mã mới, nhóm Kho / Bán hàng', () => {
    const group = (c: string) => PERMISSIONS.find((p) => p.code === c)?.group;
    for (const c of ['item.view', 'warehouse.create', 'price_list.update', 'stock_voucher.post', 'stock_voucher.delete', 'costing.run', 'costing.view', 'order.view', 'order.delete', 'stocktake.create']) expect(PERMISSION_CODES, c).toContain(c);
    expect([group('item.view'), group('stock_voucher.post'), group('costing.run'), group('order.view'), group('stocktake.view')]).toEqual(['Kho', 'Kho', 'Kho', 'Bán hàng', 'Kho']);
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length);
  });
});

describe('cờ dữ liệu nhạy cảm dùng chung', () => {
  const recv = { subledger_kind: 'receivable', code: '131' }, pay = { subledger_kind: 'payable', code: '331' }, cost = { subledger_kind: null, code: '6321' }, cash = { subledger_kind: null, code: '1111' }, inv = { subledger_kind: 'inventory', code: '156' };
  it('SENSITIVE_BY_SUBLEDGER ánh xạ loại sổ chi tiết sang cờ', () => {
    expect(SENSITIVE_BY_SUBLEDGER).toEqual({ receivable: 'view_receivable', payable: 'view_payable', inventory: 'view_cost' });
  });
  it('sensitiveDenial: thiếu cờ thì có lý do, đủ cờ hoặc tài khoản thường thì null', () => {
    const none = { sensitive: new Set<string>() };
    expect(sensitiveDenial(none, recv)).toBe('Không có quyền xem công nợ phải thu');
    expect(sensitiveDenial(none, pay)).toBe('Không có quyền xem công nợ phải trả');
    expect(sensitiveDenial(none, cost)).toBe('Không có quyền xem giá vốn');
    expect(sensitiveDenial(none, inv)).toBe('Không có quyền xem giá vốn');
    expect(sensitiveDenial(none, cash)).toBeNull();
    expect(sensitiveDenial({ sensitive: new Set(['view_receivable']) }, recv)).toBeNull();
    expect(sensitiveDenial({ sensitive: new Set(['view_receivable']) }, pay)).not.toBeNull();
  });
  it('flagsForAccounts: cờ cần để xem các tài khoản, không trùng, tài khoản thường không cần cờ', () => {
    expect(flagsForAccounts([cash])).toEqual([]);
    expect(flagsForAccounts([recv, cash, recv])).toEqual(['view_receivable']);
    expect([...flagsForAccounts([cost, pay, recv])].sort()).toEqual(['view_cost', 'view_payable', 'view_receivable']);
  });
});
