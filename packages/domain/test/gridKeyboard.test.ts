import { describe, expect, it } from 'vitest';
import { gridKeyAction, isImeComposing, isLookupKey, nextCellOnEnter, nextCellOnTab } from '../src/gridKeyboard.js';

const g = { rowCount: 2, editableCols: [0, 2, 3] };
describe('gridKeyboard', () => {
  it('Enter đi sang cột sửa được kế tiếp, cuối dòng xuống dòng sau, cuối lưới thêm dòng', () => {
    expect(nextCellOnEnter({ row: 0, col: 0 }, g)).toEqual({ row: 0, col: 2, addRow: false });
    expect(nextCellOnEnter({ row: 0, col: 3 }, g)).toEqual({ row: 1, col: 0, addRow: false });
    expect(nextCellOnEnter({ row: 1, col: 3 }, g)).toEqual({ row: 2, col: 0, addRow: true });
    expect(nextCellOnEnter({ row: 0, col: 1 }, g)).toEqual({ row: 0, col: 2, addRow: false });
  });
  it('nextCellOnTab giống Enter nhưng không thêm dòng ở cuối', () => {
    expect(nextCellOnTab({ row: 1, col: 3 }, g)).toEqual({ row: 1, col: 3, addRow: false });
  });
  it('F4 là phím tra cứu', () => { expect(isLookupKey({ key: 'F4' })).toBe(true); expect(isLookupKey({ key: 'F2' })).toBe(false); });
});

describe('gridKeyAction', () => {
  const shape = { rowCount: 2, editableCols: [0, 2, 3], readOnly: false };
  const key = (k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => ({ key: k, ctrlKey: false, shiftKey: false, ...mods });
  it('Enter/Tab di chuyển theo nextCellOnEnter', () => {
    expect(gridKeyAction(key('Enter'), { row: 0, col: 0 }, shape)).toEqual({ type: 'move', pos: { row: 0, col: 2 }, addRow: false });
    expect(gridKeyAction(key('Enter'), { row: 1, col: 3 }, shape)).toEqual({ type: 'move', pos: { row: 2, col: 0 }, addRow: true });
    expect(gridKeyAction(key('Tab'), { row: 0, col: 3 }, shape)).toEqual({ type: 'move', pos: { row: 1, col: 0 }, addRow: false });
  });
  it('Tab ở ô cuối của dòng cuối thêm dòng mới; khóa dòng thì nhả cho trình duyệt', () => {
    const ctx = { rowCount: 2, editableCols: [0, 2, 3], readOnly: false, lockRows: false };
    expect(gridKeyAction(key('Tab'), { row: 1, col: 3 }, ctx)).toEqual({ type: 'move', addRow: true, pos: { row: 2, col: 0 } });
    expect(gridKeyAction(key('Tab'), { row: 1, col: 3 }, { ...ctx, lockRows: true })).toEqual({ type: 'none' });
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

describe('gridKeyAction: bộ gõ (IME) và khóa số dòng', () => {
  const shape = { rowCount: 2, editableCols: [0, 2, 3], readOnly: false };
  const key = (k: string, more: { ctrlKey?: boolean; shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) => ({ key: k, ctrlKey: false, shiftKey: false, ...more });
  it('đang soạn chữ (isComposing hoặc keyCode 229): không phím nào được lưới xử lý', () => {
    expect(isImeComposing({ isComposing: true })).toBe(true);
    expect(isImeComposing({ keyCode: 229 })).toBe(true); // Safari: compositionend tới trước, keydown Enter chỉ còn keyCode 229
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeComposing({})).toBe(false);
    for (const more of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const k of ['Enter', 'Tab', 'F4']) expect(gridKeyAction(key(k, more), { row: 0, col: 0 }, shape)).toEqual({ type: 'none' });
      expect(gridKeyAction(key('Delete', { ctrlKey: true, ...more }), { row: 0, col: 0 }, shape)).toEqual({ type: 'none' });
    }
    expect(gridKeyAction(key('Enter', { isComposing: false, keyCode: 13 }), { row: 0, col: 0 }, shape)).toEqual({ type: 'move', pos: { row: 0, col: 2 }, addRow: false });
  });
  it('lockRows: không thêm, chèn, xóa dòng; vẫn đi giữa các ô và tra cứu', () => {
    const locked = { ...shape, lockRows: true };
    expect(gridKeyAction(key('Enter'), { row: 1, col: 3 }, locked)).toEqual({ type: 'none' }); // cuối lưới: bình thường sẽ thêm dòng
    expect(gridKeyAction(key('Insert', { ctrlKey: true }), { row: 0, col: 2 }, locked)).toEqual({ type: 'none' });
    expect(gridKeyAction(key('Delete', { ctrlKey: true }), { row: 0, col: 2 }, locked)).toEqual({ type: 'none' });
    expect(gridKeyAction(key('Enter'), { row: 0, col: 3 }, locked)).toEqual({ type: 'move', pos: { row: 1, col: 0 }, addRow: false });
    expect(gridKeyAction(key('Tab'), { row: 1, col: 3 }, locked)).toEqual({ type: 'none' });
    expect(gridKeyAction(key('F4'), { row: 0, col: 2 }, locked)).toEqual({ type: 'lookup' });
  });
});
