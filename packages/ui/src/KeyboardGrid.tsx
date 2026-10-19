import { useCallback, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type CellKeyDownEvent, type ColDef, type GridApi } from 'ag-grid-community';
import { gridKeyAction } from '@kt/domain';

ModuleRegistry.registerModules([AllCommunityModule]);

export interface KeyboardGridProps<T> {
  rows: T[]; columns: ColDef<T>[]; onRowsChange: (rows: T[]) => void; addRowTemplate: () => T;
  onLookup?: (colId: string, rowIndex: number) => void; height?: number | string; readOnly?: boolean;
}

export function KeyboardGrid<T extends object>({ rows, columns, onRowsChange, addRowTemplate, onLookup, height = 320, readOnly }: KeyboardGridProps<T>) {
  const apiRef = useRef<GridApi<T> | null>(null);
  const colDefs = useMemo(() => columns.map((c) => ({ ...c, editable: readOnly ? false : c.editable ?? true })), [columns, readOnly]);
  const editableIdx = useMemo(() => colDefs.map((c, i) => (c.editable ? i : -1)).filter((i) => i >= 0), [colDefs]);
  const colId = (i: number) => (colDefs[i]?.colId ?? colDefs[i]?.field) as string | undefined;
  // Mọi quyết định phím nằm ở gridKeyAction (hàm thuần trong @kt/domain); ở đây chỉ áp dụng kết quả.
  const decide = useCallback((ev: KeyboardEvent, rowIndex: number | null, id: string, api: GridApi<T>) =>
    gridKeyAction(ev, { row: rowIndex ?? 0, col: colDefs.findIndex((c) => (c.colId ?? c.field) === id) },
      { rowCount: api.getDisplayedRowCount(), editableCols: editableIdx, readOnly: !!readOnly }), [colDefs, editableIdx, readOnly]);
  // Chỉ chặn xử lý mặc định của AG Grid (và của trình duyệt, vd. Tab rời lưới) với phím mà lưới tự xử lý (không phải `none`);
  // Shift+Tab/Shift+Enter, lưới chỉ đọc... vẫn mặc định. preventDefault phải gọi ở đây (đồng bộ): cellKeyDown của AG Grid tới trễ, sau khi phím đã xử lý xong.
  // sortable=false vì dòng được nhận diện theo chỉ số hiển thị.
  const defaultColDef = useMemo<ColDef<T>>(() => ({ resizable: true, sortable: false,
    suppressKeyboardEvent: (p) => {
      const ev = p.event as KeyboardEvent;
      if (decide(ev, p.node.rowIndex, p.column.getColId(), p.api).type === 'none') return false;
      ev.preventDefault(); return true;
    } }), [decide]);

  const onCellKeyDown = useCallback((e: CellKeyDownEvent<T>) => {
    const ev = e.event as KeyboardEvent | undefined; const api = e.api; if (!ev) return;
    const action = decide(ev, e.rowIndex, e.column.getColId(), api);
    if (action.type === 'none') return;
    const row = e.rowIndex ?? 0;
    switch (action.type) {
      case 'lookup': onLookup?.(e.column.getColId(), row); return;
      case 'deleteRow': onRowsChange(rows.filter((_, i) => i !== row)); return;
      case 'insertRow': { const copy = [...rows]; copy.splice(row, 0, addRowTemplate()); onRowsChange(copy); return; }
      case 'move': {
        api.stopEditing();
        if (action.addRow) onRowsChange([...rows, addRowTemplate()]);
        const target = action.pos.col >= 0 ? colId(action.pos.col) : undefined;
        if (target === undefined) return;
        setTimeout(() => { api.setFocusedCell(action.pos.row, target); api.startEditingCell({ rowIndex: action.pos.row, colKey: target }); }, 0);
      }
    }
  }, [decide, colDefs, rows, onRowsChange, addRowTemplate, onLookup]);

  return (
    <div style={{ height }}>
      <AgGridReact<T> theme={themeQuartz} rowData={rows} columnDefs={colDefs} singleClickEdit stopEditingWhenCellsLoseFocus suppressClickEdit={false}
        onGridReady={(e) => { apiRef.current = e.api; }} onCellKeyDown={onCellKeyDown}
        onCellValueChanged={(e) => { const copy = [...rows]; copy[e.rowIndex ?? 0] = { ...(e.data as T) }; onRowsChange(copy); }}
        defaultColDef={defaultColDef} />
    </div>
  );
}
