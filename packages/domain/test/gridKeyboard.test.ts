import { describe, expect, it } from 'vitest';
import { isLookupKey, nextCellOnEnter, nextCellOnTab } from '../src/gridKeyboard.js';

const g = { rowCount: 2, editableCols: [0, 2, 3] };
describe('gridKeyboard', () => {
  it('Enter đi sang cột sửa được kế tiếp, cuối dòng xuống dòng sau, cuối lưới thêm dòng', () => {
    expect(nextCellOnEnter({ row: 0, col: 0 }, g)).toEqual({ row: 0, col: 2, addRow: false });
    expect(nextCellOnEnter({ row: 0, col: 3 }, g)).toEqual({ row: 1, col: 0, addRow: false });
    expect(nextCellOnEnter({ row: 1, col: 3 }, g)).toEqual({ row: 2, col: 0, addRow: true });
    expect(nextCellOnEnter({ row: 0, col: 1 }, g)).toEqual({ row: 0, col: 2, addRow: false });
  });
  it('Tab giống Enter nhưng không thêm dòng ở cuối', () => {
    expect(nextCellOnTab({ row: 1, col: 3 }, g)).toEqual({ row: 1, col: 3, addRow: false });
  });
  it('F4 là phím tra cứu', () => { expect(isLookupKey({ key: 'F4' })).toBe(true); expect(isLookupKey({ key: 'F2' })).toBe(false); });
});
