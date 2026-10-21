import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeclaredInvoices, declaredBody, declRowsOf, emptyDeclRow, type DeclRow } from '../src/pages/DeclaredInvoices.js';

vi.mock('../src/pages/voucherCommon.js', () => ({
  PickDialog: () => null, groupFetcher: () => undefined, taxFetcher: () => undefined,
  useInvoiceGroups: () => ({ data: [] }), useTaxDefs: () => ({ data: [] }),
}));
// Lưới giả: nút "đổi" trả về dòng đầu với giá trị mới của một ô.
vi.mock('@kt/ui', () => ({
  KeyboardGrid: ({ rows, onRowsChange }: { rows: DeclRow[]; onRowsChange: (r: DeclRow[]) => void }) => (
    <div>
      <button onClick={() => onRowsChange([{ ...rows[0]!, partyCode: 'NCC002' }, ...rows.slice(1)])}>đổi mã đối tượng</button>
      <button onClick={() => onRowsChange([{ ...rows[0]!, note: 'x' }, ...rows.slice(1)])}>đổi ghi chú</button>
    </div>),
}));

const dto = { formNo: null, serial: 'PC26T', invoiceNo: '0000001', invoiceDate: '2026-03-05', invoiceGroupCode: '03', taxCode: 'V10', baseAmount: '10000000', taxAmount: '1000000',
  partyCode: 'NCC001', partyTaxCode: '0109999999', partyName: 'Bên ghi đè', partyAddress: 'Hà Nội', note: null };

describe('Hóa đơn kê khai trên PC/BN/PKT: ghi đè người bán', () => {
  it('đọc về rồi gửi lại giữ MST, tên, địa chỉ đã lưu', () => {
    expect(declaredBody(declRowsOf([dto]))[0]).toMatchObject({ partyCode: 'NCC001', partyTaxCode: '0109999999', partyName: 'Bên ghi đè', partyAddress: 'Hà Nội' });
  });
  it('ô trống thì không gửi; MST sai định dạng báo lỗi nêu số dòng', () => {
    const ok = declaredBody(declRowsOf([{ ...dto, partyTaxCode: ' ', partyName: null, partyAddress: null }]))[0]!;
    expect(ok).not.toHaveProperty('partyTaxCode'); expect(ok).not.toHaveProperty('partyName'); expect(ok).not.toHaveProperty('partyAddress');
    expect(() => declaredBody([emptyDeclRow(), ...declRowsOf([{ ...dto, partyTaxCode: '123' }])])).toThrow(/Hóa đơn dòng 2: mã số thuế/);
  });
  it('đổi mã đối tượng của dòng thì bỏ bản chụp cũ; sửa ô khác thì giữ', async () => {
    const onRowsChange = vi.fn();
    render(<DeclaredInvoices rows={declRowsOf([dto])} onRowsChange={onRowsChange} editable />);
    await userEvent.click(screen.getByText('đổi ghi chú'));
    expect(onRowsChange.mock.calls[0]![0][0]).toMatchObject({ partyCode: 'NCC001', partyTaxCode: '0109999999', partyName: 'Bên ghi đè' });
    await userEvent.click(screen.getByText('đổi mã đối tượng'));
    expect(onRowsChange.mock.calls[1]![0][0]).toMatchObject({ partyCode: 'NCC002', partyTaxCode: '', partyName: '', partyAddress: '' });
  });
});
