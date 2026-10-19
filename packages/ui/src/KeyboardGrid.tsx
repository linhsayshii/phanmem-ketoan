import { useCallback, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type CellKeyDownEvent, type ColDef, type GridApi } from 'ag-grid-community';
import { isLookupKey, nextCellOnEnter, nextCellOnTab } from '@kt/domain';

ModuleRegistry.registerModules([AllCommunityModule]);

export interface KeyboardGridProps<T> {
  rows: T[]; columns: ColDef<T>[]; onRowsChange: (rows: T[]) => void; addRowTemplate: () => T;
  onLookup?: (colId: string, rowIndex: number) => void; height?: number | string; readOnly?: boolean;
}

export function KeyboardGrid<T extends object>({ rows, columns, onRowsChange, addRowTemplate, onLookup, height = 320, readOnly }: KeyboardGridProps<T>) {
  const apiRef = useRef<GridApi<T> | null>(null);
  const colDefs = useMemo(() => columns.map((c) => ({ ...c, editable: readOnly ? false : c.editable ?? true })), [columns, readOnly]);
  const editableIdx = useMemo(() => colDefs.map((c, i) => (c.editable ? i : -1)).filter((i) => i >= 0), [colDefs]);
  const colId = (i: number) => (colDefs[i]!.colId ?? colDefs[i]!.field) as string;

  const onCellKeyDown = useCallback((e: CellKeyDownEvent<T>) => {
    const ev = e.event as KeyboardEvent | undefined; const api = e.api; if (!ev) return;
    const pos = { row: e.rowIndex ?? 0, col: colDefs.findIndex((c) => (c.colId ?? c.field) === e.column.getColId()) };
    const shape = { rowCount: api.getDisplayedRowCount(), editableCols: editableIdx };
    if (isLookupKey(ev)) { ev.preventDefault(); onLookup?.(e.column.getColId(), pos.row); return; }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault(); api.stopEditing();
      const m = ev.key === 'Enter' ? nextCellOnEnter(pos, shape) : nextCellOnTab(pos, shape);
      if (m.addRow && !readOnly) onRowsChange([...rows, addRowTemplate()]);
      setTimeout(() => { api.setFocusedCell(m.row, colId(m.col)); api.startEditingCell({ rowIndex: m.row, colKey: colId(m.col) }); }, 0);
      return;
    }
    if (ev.ctrlKey && ev.key === 'Delete' && !readOnly) { ev.preventDefault(); onRowsChange(rows.filter((_, i) => i !== pos.row)); }
    if (ev.ctrlKey && ev.key === 'Insert' && !readOnly) { ev.preventDefault(); const copy = [...rows]; copy.splice(pos.row, 0, addRowTemplate()); onRowsChange(copy); }
  }, [colDefs, editableIdx, rows, onRowsChange, addRowTemplate, onLookup, readOnly]);

  return (
    <div style={{ height }}>
      <AgGridReact<T> theme={themeQuartz} rowData={rows} columnDefs={colDefs} singleClickEdit stopEditingWhenCellsLoseFocus suppressClickEdit={false}
        onGridReady={(e) => { apiRef.current = e.api; }} onCellKeyDown={onCellKeyDown}
        onCellValueChanged={(e) => { const copy = [...rows]; copy[e.rowIndex ?? 0] = { ...(e.data as T) }; onRowsChange(copy); }}
        defaultColDef={{ resizable: true, suppressKeyboardEvent: (p) => ['Enter', 'Tab', 'F4'].includes((p.event as KeyboardEvent).key) }} />
    </div>
  );
}
