import { describe, expect, it } from 'vitest';
import { gridKeyAction, isLookupKey, nextCellOnEnter, nextCellOnTab } from '../src/gridKeyboard.js';

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

describe('gridKeyAction', () => {
  const shape = { rowCount: 2, editableCols: [0, 2, 3], readOnly: false };
  const key = (k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => ({ key: k, ctrlKey: false, shiftKey: false, ...mods });
  it('Enter/Tab di chuyển theo nextCellOnEnter/nextCellOnTab', () => {
    expect(gridKeyAction(key('Enter'), { row: 0, col: 0 }, shape)).toEqual({ type: 'move', pos: { row: 0, col: 2 }, addRow: false });
    expect(gridKeyAction(key('Enter'), { row: 1, col: 3 }, shape)).toEqual({ type: 'move', pos: { row: 2, col: 0 }, addRow: true });
    expect(gridKeyAction(key('Tab'), { row: 0, col: 3 }, shape)).toEqual({ type: 'move', pos: { row: 1, col: 0 }, addRow: false });
    expect(gridKeyAction(key('Tab'), { row: 1, col: 3 }, shape)).toEqual({ type: 'move', pos: { row: 1, col: 3 }, addRow: false });
  });
  it('Shift+Enter và Shift+Tab để AG Grid xử lý (đi ngược)', () => {
    expect(gridKeyAction(key('Enter', { shiftKey: true }), { row: 0, col: 0 }, shape)).toEqual({ type: 'none' });
    expect(gridKeyAction(key('Tab', { shiftKey: true }), { row: 0, col: 2 }, shape)).toEqual({ type: 'none' });
  });
  it('F4 tra cứu; Ctrl+Delete xóa dòng; Ctrl+Insert chèn dòng', () => {
    expect(gridKeyAction(key('F4'), { row: 0, col: 2 }, shape)).toEqual({ type: 'lookup' });
    expect(gridKeyAction(key('Delete', { ctrlKey: true }), { row: 0, col: 2 }, shape)).toEqual({ type: 'deleteRow' });
    expect(gridKeyAction(key('Insert', { ctrlKey: true }), { row: 0, col: 2 }, shape)).toEqual({ type: 'insertRow' });
    expect(gridKeyAction(key('Delete'), { row: 0, col: 2 }, shape)).toEqual({ type: 'none' });
    expect(gridKeyAction(key('Insert'), { row: 0, col: 2 }, shape)).toEqual({ type: 'none' });
    expect(gridKeyAction(key('a'), { row: 0, col: 2 }, shape)).toEqual({ type: 'none' });
  });
  it('lưới chỉ đọc không làm gì với mọi phím', () => {
    const ro = { ...shape, readOnly: true };
    for (const k of [key('Enter'), key('Tab'), key('F4'), key('Delete', { ctrlKey: true }), key('Insert', { ctrlKey: true })]) {
      expect(gridKeyAction(k, { row: 0, col: 0 }, ro)).toEqual({ type: 'none' });
    }
  });
  it('cột không xác định (col = -1) không làm gì với mọi phím', () => {
    for (const k of [key('Enter'), key('Tab'), key('F4'), key('Delete', { ctrlKey: true }), key('Insert', { ctrlKey: true })]) {
      expect(gridKeyAction(k, { row: 0, col: -1 }, shape)).toEqual({ type: 'none' });
    }
  });
});
