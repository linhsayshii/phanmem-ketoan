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
export function nextCellOnTab(pos: CellPos, g: GridShape): Move {
  const m = nextCellOnEnter(pos, g);
  return m.addRow ? { ...pos, addRow: false } : m;
}
export const isLookupKey = (e: { key: string }): boolean => e.key === 'F4';
