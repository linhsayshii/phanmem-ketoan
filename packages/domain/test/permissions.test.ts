import { describe, expect, it } from 'vitest';
import { flagsForAccounts, PERMISSION_CODES, PERMISSIONS, sensitiveDenial, SENSITIVE_BY_SUBLEDGER, SENSITIVE_FLAGS_ALL } from '../src/index.js';

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

describe('quyền GĐ4', () => {
  it('có đủ mã tài sản, khế ước vay, quy trình cuối kỳ; không trùng', () => {
    const group = (c: string) => PERMISSIONS.find((p) => p.code === c)?.group;
    for (const c of ['asset.view', 'asset.create', 'asset.update', 'asset.delete', 'asset.run', 'loan.view', 'loan.create', 'loan.update', 'loan.delete', 'loan.run', 'period_close.view']) expect(PERMISSION_CODES, c).toContain(c);
    expect([group('asset.run'), group('loan.run'), group('period_close.view')]).toEqual(['Tài sản', 'Khế ước vay', 'Cuối kỳ']);
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length);
  });
});

describe('quyền GĐ5', () => {
  it('có đủ mã hóa đơn điện tử, hóa đơn đầu vào, ngân hàng, khóa API, thuế TNDN, ký số; không trùng', () => {
    const group = (c: string) => PERMISSIONS.find((p) => p.code === c)?.group;
    for (const c of ['einvoice.view', 'einvoice.issue', 'einvoice.config', 'inbound_invoice.view', 'inbound_invoice.delete', 'bank_feed.view', 'bank_feed.match', 'api_key.manage', 'cit.view', 'cit.delete', 'signing.use']) expect(PERMISSION_CODES, c).toContain(c);
    expect([group('einvoice.issue'), group('inbound_invoice.view'), group('bank_feed.match'), group('api_key.manage'), group('cit.view'), group('signing.use')])
      .toEqual(['Hóa đơn điện tử', 'Hóa đơn điện tử', 'Ngân hàng', 'Hệ thống', 'Thuế', 'Hệ thống']);
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length);
  });
});

describe('quyền GĐ6 và cờ view_salary', () => {
  const GD6 = ['payroll.view', 'payroll.create', 'payroll.update', 'payroll.delete', 'payroll.post', 'payroll.param', 'payroll.pay', 'payroll.export',
    'attendance.view', 'attendance.create', 'attendance.update', 'attendance.delete', 'costing_obj.view', 'costing_obj.create', 'costing_obj.update', 'costing_obj.delete',
    'cost_run.view', 'cost_run.run', 'contract_track.view', 'contract_track.run'];
  it('có đủ mã mới, không trùng', () => {
    for (const c of GD6) expect(PERMISSION_CODES, c).toContain(c);
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length);
  });
  it('view_salary theo cờ salary do API tính từ ánh xạ tài khoản lương của chế độ; mã trùng tên không tự bị che', () => {
    const none = { sensitive: new Set<string>() };
    for (const code of ['334', '3341', '3382', '3383', '3384', '3386']) expect(sensitiveDenial(none, { subledger_kind: null, code, salary: true }), code).toBe('Không có quyền xem lương');
    // không có cờ salary (tài khoản 3386 của TT133 là ký quỹ, 3335 là thuế TNCN) thì không cần view_salary
    for (const code of ['3381', '3386', '3387', '3335', '1111', '334']) expect(sensitiveDenial(none, { subledger_kind: null, code }), code).toBeNull();
    expect(sensitiveDenial({ sensitive: new Set(['view_salary']) }, { subledger_kind: null, code: '334', salary: true })).toBeNull();
    expect(flagsForAccounts([{ subledger_kind: null, code: '3383', salary: true }, { subledger_kind: 'payable', code: '331' }])).toEqual(['view_salary', 'view_payable']);
  });
  it('SENSITIVE_FLAGS_ALL gồm cả view_salary (sổ tổng hợp lộ dòng 334)', () => {
    expect([...SENSITIVE_FLAGS_ALL].sort()).toEqual(['view_cost', 'view_payable', 'view_receivable', 'view_salary']);
  });
});
