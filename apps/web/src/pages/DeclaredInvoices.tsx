import { useCallback, useMemo, useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { formatVnDate, formatVnNumber, parseVnDate, parseVnNumber, TAX_CODE_RE, VND_AMOUNT_RE } from '@kt/domain';
import { KeyboardGrid } from '@kt/ui';
import { PickDialog, groupFetcher, taxFetcher, useInvoiceGroups, useTaxDefs } from './voucherCommon.js';

// Hóa đơn đầu vào kê khai nhập tay trên Phiếu chi, Giấy báo Nợ, Phiếu kế toán, Chi phí mua hàng (CPM, màn hình LandedCost.tsx) (chứng từ không tự dựng bảng kê như hóa đơn dịch vụ). Luôn là hóa đơn mua vào.
// Máy chủ cũng giữ danh sách loại này (DECLARING_TYPES trong apps/api/src/modules/invoices/declaration.ts).
export const DECLARING_TYPES: readonly string[] = ['PC', 'BN', 'PKT', 'CPM'];

// Mọi ô là chuỗi; ngày lưu dạng YYYY-MM-DD, tiền là số nguyên đồng.
export interface DeclRow { formNo: string; serial: string; invoiceNo: string; invoiceDate: string; invoiceGroupCode: string; taxCode: string; baseAmount: string; taxAmount: string; partyCode: string; partyTaxCode: string; partyName: string; partyAddress: string; note: string }
export const emptyDeclRow = (): DeclRow => ({ formNo: '', serial: '', invoiceNo: '', invoiceDate: '', invoiceGroupCode: '', taxCode: '', baseAmount: '', taxAmount: '', partyCode: '', partyTaxCode: '', partyName: '', partyAddress: '', note: '' });
const KEYS = Object.keys(emptyDeclRow()) as (keyof DeclRow)[];
const isBlank = (r: DeclRow) => KEYS.every((k) => (r[k] ?? '').trim() === '');

// Dòng kê khai đã lưu trên chứng từ (VoucherDto.invoices) về dòng lưới.
export const declRowsOf = (invoices: { formNo: string | null; serial: string | null; invoiceNo: string; invoiceDate: string; invoiceGroupCode: string | null; taxCode: string | null; baseAmount: string; taxAmount: string; partyCode: string | null; partyTaxCode?: string | null; partyName?: string | null; partyAddress?: string | null; note: string | null }[]): DeclRow[] =>
  invoices.map((i) => ({ formNo: i.formNo ?? '', serial: i.serial ?? '', invoiceNo: i.invoiceNo, invoiceDate: i.invoiceDate, invoiceGroupCode: i.invoiceGroupCode ?? '', taxCode: i.taxCode ?? '', baseAmount: i.baseAmount, taxAmount: i.taxAmount, partyCode: i.partyCode ?? '', partyTaxCode: i.partyTaxCode ?? '', partyName: i.partyName ?? '', partyAddress: i.partyAddress ?? '', note: i.note ?? '' }));

// Đổi đối tượng của dòng thì bỏ tên, mã số thuế, địa chỉ đã chụp của đối tượng cũ (để máy chủ lấy theo đối tượng mới).
export const clearPartySnapshot = (r: DeclRow): DeclRow => ({ ...r, partyTaxCode: '', partyName: '', partyAddress: '' });

// Thân yêu cầu `invoices` của POST/PUT /api/vouchers: bỏ dòng trống, dòng thiếu thông tin bắt buộc thì báo lỗi nêu số dòng (số thứ tự trên lưới). Thuế để trống là 0.
export function declaredBody(rows: DeclRow[]) {
  return rows.flatMap((r, k) => {
    if (isBlank(r)) return [];
    const at = (msg: string) => new Error(`Hóa đơn dòng ${k + 1}: ${msg}`);
    if (!r.invoiceNo.trim()) throw at('nhập số hóa đơn');
    if (!r.invoiceDate.trim()) throw at('nhập ngày hóa đơn');
    if (!r.invoiceGroupCode.trim()) throw at('chọn nhóm kê khai');
    if (!r.taxCode.trim()) throw at('chọn mã thuế');
    if (!r.baseAmount.trim()) throw at('nhập tiền hàng');
    if (r.partyTaxCode.trim() && !TAX_CODE_RE.test(r.partyTaxCode.trim())) throw at('mã số thuế gồm 10 số hoặc 10 số-3 số');
    return [{ formNo: r.formNo.trim(), serial: r.serial.trim(), invoiceNo: r.invoiceNo.trim(), invoiceDate: r.invoiceDate, invoiceGroupCode: r.invoiceGroupCode.trim(), taxCode: r.taxCode.trim(),
      baseAmount: r.baseAmount, taxAmount: r.taxAmount || '0', ...(r.partyCode.trim() ? { partyCode: r.partyCode.trim() } : {}),
      ...(r.partyTaxCode.trim() ? { partyTaxCode: r.partyTaxCode.trim() } : {}), ...(r.partyName.trim() ? { partyName: r.partyName.trim() } : {}), ...(r.partyAddress.trim() ? { partyAddress: r.partyAddress.trim() } : {}), ...(r.note.trim() ? { note: r.note.trim() } : {}) }];
  });
}

// Tiền VND nguyên đồng: để trống là chưa nhập, chữ sai thì giữ giá trị cũ.
const moneyCol = (field: 'baseAmount' | 'taxAmount', headerName: string): ColDef<DeclRow> => ({ field, headerName, width: 140, cellClass: 'ag-right-aligned-cell', cellEditorParams: { useFormatter: true },
  valueFormatter: (p) => formatVnNumber((p.value as string) || null), valueParser: (p) => { const t = String(p.newValue ?? '').trim(); if (t === '') return ''; const n = parseVnNumber(t); return n !== null && VND_AMOUNT_RE.test(n) ? n : p.oldValue; } });

const OVERRIDE_TIP = 'Để trống là lấy theo danh mục đối tượng';
const LOOKUP = new Set(['invoiceGroupCode', 'taxCode', 'partyCode']);

export function DeclaredInvoices({ rows, onRowsChange, editable }: { rows: DeclRow[]; onRowsChange: (rows: DeclRow[]) => void; editable: boolean }) {
  const defs = useTaxDefs(); const groups = useInvoiceGroups();
  const [lookup, setLookup] = useState<{ col: string; row: number } | null>(null);
  const taxes = useMemo(() => taxFetcher(defs.data ?? [], 'purchase', true), [defs.data]);
  const groupsOf = useMemo(() => groupFetcher(groups.data ?? [], 'purchase'), [groups.data]);
  const columns = useMemo<ColDef<DeclRow>[]>(() => ([
    { field: 'formNo', headerName: 'Mẫu số', width: 110 }, { field: 'serial', headerName: 'Ký hiệu', width: 110 }, { field: 'invoiceNo', headerName: 'Số hóa đơn', width: 120 },
    { field: 'invoiceDate', headerName: 'Ngày hóa đơn', width: 130, valueFormatter: (p) => (p.value ? formatVnDate(p.value as string) : ''),
      valueGetter: (p) => p.data?.invoiceDate ?? '', valueSetter: (p) => { const t = String(p.newValue ?? '').trim(); if (t === '') { p.data.invoiceDate = ''; return true; } const d = parseVnDate(t) ?? (/^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null); if (d === null) return false; p.data.invoiceDate = d; return true; },
      cellEditorParams: { useFormatter: true } },
    { field: 'invoiceGroupCode', headerName: 'Nhóm kê khai (F4)', width: 150 }, { field: 'taxCode', headerName: 'Mã thuế (F4)', width: 120 },
    moneyCol('baseAmount', 'Tiền hàng'), moneyCol('taxAmount', 'Tiền thuế'),
    { field: 'partyCode', headerName: 'Người bán (F4)', width: 130, headerTooltip: 'Để trống là lấy đối tượng của chứng từ' }, { field: 'partyTaxCode', headerName: 'MST người bán', width: 130, headerTooltip: OVERRIDE_TIP }, { field: 'partyName', headerName: 'Tên người bán', width: 180, headerTooltip: OVERRIDE_TIP },
    { field: 'partyAddress', headerName: 'Địa chỉ', width: 180, headerTooltip: OVERRIDE_TIP }, { field: 'note', headerName: 'Ghi chú', flex: 1, minWidth: 120 },
  ] satisfies ColDef<DeclRow>[]).map((c) => ({ ...c, editable })), [editable]);
  // Sửa mã đối tượng của dòng (gõ trực tiếp): bỏ bản chụp cũ. Chỉ so khi số dòng không đổi (thêm/xóa dòng làm lệch chỉ số).
  const change = (next: DeclRow[]) => onRowsChange(next.length === rows.length ? next.map((r, i) => (r.partyCode !== rows[i]!.partyCode ? clearPartySnapshot(r) : r)) : next);
  const onLookup = useCallback((col: string, row: number) => { if (editable && LOOKUP.has(col)) setLookup({ col, row }); }, [editable]);
  const catalog = lookup?.col === 'partyCode' ? 'party' : lookup?.col === 'taxCode' ? 'tax_code' : 'invoice_group';
  return (<>
    <KeyboardGrid<DeclRow> rows={rows} columns={columns} readOnly={!editable} onRowsChange={change} addRowTemplate={emptyDeclRow} onLookup={onLookup} height={300} />
    <PickDialog open={!!lookup} catalog={catalog} {...(lookup?.col === 'taxCode' ? { fetcher: taxes } : lookup?.col === 'invoiceGroupCode' ? { fetcher: groupsOf } : {})}
      onPick={(code) => { if (lookup) { const copy = [...rows]; copy[lookup.row] = { ...copy[lookup.row]!, [lookup.col]: code }; if (lookup.col === 'partyCode') copy[lookup.row] = clearPartySnapshot(copy[lookup.row]!); onRowsChange(copy); } }} onClose={() => setLookup(null)} />
  </>);
}
