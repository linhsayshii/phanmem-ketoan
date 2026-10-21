import { useCallback, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GetRowIdParams, type GridApi } from 'ag-grid-community';
import { gridKeyAction, isImeComposing, nextCellOnEnter, type GridKeyAction } from '@kt/domain';

ModuleRegistry.registerModules([AllCommunityModule]);

export interface KeyboardGridProps<T> {
  rows: T[]; columns: ColDef<T>[]; onRowsChange: (rows: T[]) => void; addRowTemplate: () => T;
  onLookup?: (colId: string, rowIndex: number) => void; height?: number | string; readOnly?: boolean;
  lockRows?: boolean; // số dòng cố định: không thêm/chèn/xóa dòng bằng phím (vd. chứng từ đã ghi sổ), vẫn sửa được ô
}

export function KeyboardGrid<T extends object>({ rows, columns, onRowsChange, addRowTemplate, onLookup, height = 320, readOnly, lockRows }: KeyboardGridProps<T>) {
  const apiRef = useRef<GridApi<T> | null>(null);
  // Mã dòng theo danh tính đối tượng: có getRowId thì AG Grid cập nhật dòng tại chỗ thay vì dựng lại toàn bộ khi `rows` đổi, nên ô đang sửa (vừa chuyển sang bằng Enter) không bị hủy.
  // AG Grid ghi giá trị thẳng vào đối tượng dòng, nên onCellValueChanged giữ nguyên đối tượng (mã không đổi), chỉ thay mảng.
  const rowIds = useRef(new WeakMap<object, string>()); const rowSeq = useRef(0);
  const getRowId = useCallback((p: GetRowIdParams<T>) => { let id = rowIds.current.get(p.data); if (id === undefined) { id = String(++rowSeq.current); rowIds.current.set(p.data, id); } return id; }, []);
  // rowsRef: bản mới nhất, kể cả thay đổi chủ chưa kịp render lại (cellValueChanged tới trễ, sau khi Enter đã thêm dòng); emit cập nhật nó ngay.
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const emit = (next: T[]) => { rowsRef.current = next; onRowsChange(next); };
  const colDefs = useMemo(() => columns.map((c) => ({ ...c, editable: readOnly ? false : c.editable ?? true })), [columns, readOnly]);
  const editableIdx = useMemo(() => colDefs.map((c, i) => (c.editable ? i : -1)).filter((i) => i >= 0), [colDefs]);
  const colId = (i: number) => (colDefs[i]?.colId ?? colDefs[i]?.field) as string | undefined;
  // Chuyển ô sang (row, col) và vào chế độ sửa. Dòng mới thêm chỉ có sau khi chủ cập nhật `rows` và lưới áp dụng, nên chờ tới khi dòng xuất hiện.
  // Cột có `editable` là hàm theo dòng: ô không sửa được ở dòng đích thì bỏ qua, sang ô sửa được kế tiếp như Enter (gridKeyAction chỉ biết cột, không biết dòng).
  const goTo = (api: GridApi<T>, row: number, col: number, tries = 10, hops = 0): void => {
    if (row >= api.getDisplayedRowCount() && tries > 0) { setTimeout(() => goTo(api, row, col, tries - 1, hops), 20); return; }
    const id = colId(col); const node = api.getDisplayedRowAtIndex(row); const column = id === undefined ? null : api.getColumn(id);
    if (node && column && !column.isCellEditable(node) && hops < 2 * editableIdx.length) { // chặn vòng lặp khi dòng không có ô nào sửa được
      const m = nextCellOnEnter({ row, col }, { rowCount: api.getDisplayedRowCount(), editableCols: editableIdx });
      if (m.addRow) { if (lockRows) return; emit([...rowsRef.current, addRowTemplate()]); }
      goTo(api, m.row, m.col, 10, hops + 1); return;
    }
    if (id !== undefined) { api.setFocusedCell(row, id); api.startEditingCell({ rowIndex: row, colKey: id }); }
  };
  // Mọi quyết định phím nằm ở gridKeyAction (hàm thuần trong @kt/domain); ở đây chỉ áp dụng kết quả.
  const decide = useCallback((ev: KeyboardEvent, rowIndex: number | null, id: string, api: GridApi<T>) =>
    gridKeyAction(ev, { row: rowIndex ?? 0, col: colDefs.findIndex((c) => (c.colId ?? c.field) === id) },
      { rowCount: api.getDisplayedRowCount(), editableCols: editableIdx, readOnly: !!readOnly, lockRows: !!lockRows }), [colDefs, editableIdx, readOnly, lockRows]);
  // Phím do lưới tự xử lý được áp dụng NGAY trong suppressKeyboardEvent (đồng bộ). Sự kiện cellKeyDown của AG Grid luôn tới trễ một nhịp (setTimeout), nên xử lý ở đó thì
  // phím gõ liền sau Enter (gõ nhanh, kịch bản tự động) rơi vào ô cũ. Hàm áp dụng đọc qua ref để defaultColDef không đổi mỗi lần `rows` đổi.
  const apply = (action: GridKeyAction, colIdOfCell: string, row: number, api: GridApi<T>) => {
    switch (action.type) {
      case 'lookup': onLookup?.(colIdOfCell, row); return;
      case 'deleteRow': emit(rowsRef.current.filter((_, i) => i !== row)); return;
      case 'insertRow': { const copy = [...rowsRef.current]; copy.splice(row, 0, addRowTemplate()); emit(copy); return; }
      case 'move': {
        api.stopEditing();
        if (action.addRow) emit([...rowsRef.current, addRowTemplate()]);
        if (action.pos.col >= 0) goTo(api, action.pos.row, action.pos.col);
      }
    }
  };
  const applyRef = useRef(apply); applyRef.current = apply;
  // Chỉ chặn xử lý mặc định của AG Grid (và của trình duyệt, vd. Tab rời lưới) với phím mà lưới tự xử lý (không phải `none`);
  // Shift+Tab/Shift+Enter, lưới chỉ đọc... vẫn mặc định. preventDefault phải gọi ở đây (đồng bộ).
  // sortable=false vì dòng được nhận diện theo chỉ số hiển thị.
  const defaultColDef = useMemo<ColDef<T>>(() => ({ resizable: true, sortable: false,
    suppressKeyboardEvent: (p) => {
      const ev = p.event as KeyboardEvent;
      if (isImeComposing(ev)) return true; // đang soạn chữ (Telex/VNI): Enter chốt chữ, lưới không chạy lệnh nào; không preventDefault để ô sửa và trình duyệt tự xử lý
      const row = p.node.rowIndex ?? 0; const id = p.column.getColId();
      const action = decide(ev, p.node.rowIndex, id, p.api);
      if (action.type === 'none') return false;
      ev.preventDefault();
      if (ev.type === 'keydown') applyRef.current(action, id, row, p.api); // suppress cũng được gọi cho keyup
      return true;
    } }), [decide]);

  return (
    <div style={{ height }}>
      <AgGridReact<T> theme={themeQuartz} rowData={rows} getRowId={getRowId} columnDefs={colDefs} singleClickEdit stopEditingWhenCellsLoseFocus suppressClickEdit={false}
        onGridReady={(e) => { apiRef.current = e.api; }}
        onCellValueChanged={(e) => { const copy = [...rowsRef.current]; copy[e.rowIndex ?? 0] = e.data as T; emit(copy); }}
        defaultColDef={defaultColDef} />
    </div>
  );
}
