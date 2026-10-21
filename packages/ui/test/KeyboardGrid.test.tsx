import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ColDef } from 'ag-grid-community';
import { KeyboardGrid } from '../src/KeyboardGrid.js';

interface R { code: string; bank: string; amount: string }
// Cột "bank" chỉ sửa được ở dòng tài khoản 1121 (như màn hình Số dư đầu kỳ)
const columns: ColDef<R>[] = [
  { field: 'code', headerName: 'Tài khoản' },
  { field: 'bank', headerName: 'TK ngân hàng', editable: (p) => p.data?.code === '1121' },
  { field: 'amount', headerName: 'Số tiền' },
];
const blank = (): R => ({ code: '', bank: '', amount: '' });

function Harness({ initial, cols = columns }: { initial: R[]; cols?: ColDef<R>[] }) {
  const [rows, setRows] = useState(initial);
  return <KeyboardGrid<R> rows={rows} columns={cols} onRowsChange={setRows} addRowTemplate={blank} height={300} />;
}

// ô đang có trình soạn: [row-index, col-id] của ô chứa input đang có tiêu điểm
const editing = () => {
  const cell = document.activeElement?.closest('.ag-cell');
  return cell ? [cell.closest('.ag-row')?.getAttribute('row-index'), cell.getAttribute('col-id')] : null;
};

describe('KeyboardGrid: cột sửa được theo dòng', () => {
  it('Enter bỏ qua ô không sửa được của dòng, dừng ở ô sửa được', async () => {
    const { container } = render(<Harness initial={[{ code: '131', bank: '', amount: '' }, { code: '1121', bank: '', amount: '' }]} />);
    const cell = (row: number, col: string) => container.querySelector(`.ag-row[row-index="${row}"] [col-id="${col}"]`) as HTMLElement;
    await waitFor(() => expect(cell(1, 'amount')).toBeTruthy());
    await userEvent.click(cell(0, 'code'));
    await waitFor(() => expect(editing()).toEqual(['0', 'code']));
    await userEvent.keyboard('{Enter}'); // dòng 131: bank không sửa được, sang amount
    await waitFor(() => expect(editing()).toEqual(['0', 'amount']));
    await userEvent.keyboard('{Enter}'); // hết dòng, sang dòng 1121 ô đầu
    await waitFor(() => expect(editing()).toEqual(['1', 'code']));
    await userEvent.keyboard('{Tab}'); // dòng 1121: bank sửa được, dừng ở đó
    await waitFor(() => expect(editing()).toEqual(['1', 'bank']));
  });

  it('ô cuối của dòng cuối không sửa được: Enter thêm dòng mới như thường', async () => {
    const lastBank = [columns[0]!, columns[2]!, columns[1]!]; // bank là cột cuối
    const { container } = render(<Harness initial={[{ code: '131', bank: '', amount: '' }]} cols={lastBank} />);
    const cell = (row: number, col: string) => container.querySelector(`.ag-row[row-index="${row}"] [col-id="${col}"]`) as HTMLElement;
    await waitFor(() => expect(cell(0, 'bank')).toBeTruthy());
    await userEvent.click(cell(0, 'amount'));
    await waitFor(() => expect(editing()).toEqual(['0', 'amount']));
    await userEvent.keyboard('{Enter}'); // bank không sửa được, hết dòng cuối: thêm dòng, sang ô đầu dòng mới
    await waitFor(() => expect(editing()).toEqual(['1', 'code']));
  });
});
