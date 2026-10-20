export interface CellPos { row: number; col: number }
export interface GridShape { rowCount: number; editableCols: number[] }
export interface Move extends CellPos { addRow: boolean }

export function nextCellOnEnter(pos: CellPos, g: GridShape): Move {
  const cols = [...g.editableCols].sort((a, b) => a - b);
  const next = cols.find((c) => c > pos.col);
  if (next !== undefined) return { row: pos.row, col: next, addRow: false };
  const first = cols[0] ?? 0;
  if (pos.row + 1 < g.rowCount) return { row: pos.row + 1, col: first, addRow: false };
  return { row: pos.row + 1, col: first, addRow: true };
}
// Ô kế tiếp nhưng không thêm dòng ở cuối lưới. gridKeyAction không còn gọi hàm này (Tab giống Enter, kể cả thêm dòng).
export function nextCellOnTab(pos: CellPos, g: GridShape): Move {
  const m = nextCellOnEnter(pos, g);
  return m.addRow ? { ...pos, addRow: false } : m;
}
export const isLookupKey = (e: { key: string }): boolean => e.key === 'F4';
// Đang soạn chữ bằng bộ gõ (Telex/VNI): Enter chốt chữ vừa soạn, không phải lệnh cho lưới. Safari gửi compositionend trước keydown nên chỉ còn keyCode 229.
export const isImeComposing = (e: { isComposing?: boolean; keyCode?: number }): boolean => !!e.isComposing || e.keyCode === 229;

export type GridKeyAction =
  | { type: 'none' }
  | { type: 'move'; pos: CellPos; addRow: boolean }
  | { type: 'lookup' }
  | { type: 'deleteRow' }
  | { type: 'insertRow' };

// Quyết định phím nào lưới tự xử lý. `none` = để AG Grid làm mặc định (kể cả Shift+Enter/Shift+Tab đi ngược, lưới chỉ đọc, ô không xác định, đang soạn chữ bằng bộ gõ).
// lockRows: số dòng cố định (chứng từ đã ghi sổ): Enter ở ô cuối không thêm dòng, Ctrl+Insert/Ctrl+Delete không làm gì; vẫn đi giữa các ô và tra cứu.
export function gridKeyAction(e: { key: string; ctrlKey: boolean; shiftKey: boolean; isComposing?: boolean; keyCode?: number }, pos: CellPos, g: GridShape & { readOnly: boolean; lockRows?: boolean }): GridKeyAction {
  const none: GridKeyAction = { type: 'none' };
  if (g.readOnly || pos.col < 0 || isImeComposing(e)) return none;
  if (isLookupKey(e)) return { type: 'lookup' };
  if (e.ctrlKey && e.key === 'Delete') return g.lockRows ? none : { type: 'deleteRow' };
  if (e.ctrlKey && e.key === 'Insert') return g.lockRows ? none : { type: 'insertRow' };
  if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
    // Tab giống Enter (kể cả thêm dòng ở ô cuối); khóa dòng thì nhả cho trình duyệt chuyển tiêu điểm ra khỏi lưới
    const m = nextCellOnEnter(pos, g);
    if (m.addRow && g.lockRows) return none;
    return { type: 'move', pos: { row: m.row, col: m.col }, addRow: m.addRow };
  }
  return none;
}
