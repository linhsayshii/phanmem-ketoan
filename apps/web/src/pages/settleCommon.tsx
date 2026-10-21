import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Select, Space, message } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ColDef, ValueParserParams } from 'ag-grid-community';
import { D, VND_AMOUNT_RE, formatVnDate, formatVnNumber, parseVnNumber, type Decimal } from '@kt/domain';
import { KeyboardGrid } from '@kt/ui';
import { api } from '../api/client.js';

// Khoản công nợ như API /api/open-items trả về: số có dấu, Nợ dương, Có âm.
export interface OpenItem {
  id: number; voucherId: string; voucherNo: string | null; voucherType: string; accountCode: string; partyCode: string | null; docNo: string | null; docDate: string; dueDate: string | null;
  currency: string; amount: string; amountCurrency: string; residual: string; residualCurrency: string;
}
// Một dòng trên lưới chọn. remain: số còn dư tuyệt đối theo loại tiền của khoản (VND hoặc nguyên tệ); pick: số đang chọn đối trừ, '0' là chưa chọn.
// pick mặc định '0' (không để trống) vì AG Grid không gọi bộ phân tích giá trị khi ô và chữ nhập đều trống, nên Enter ở ô trống sẽ không lấy được đủ số còn dư.
export interface PickRow { id: number; docNo: string; docDate: string; dueDate: string | null; fx: boolean; remain: string; remainVnd: string; pick: string }
export interface SettleEntry { openItemId: number; amount?: string; amountCurrency?: string }

const FX_AMOUNT_RE = /^\d{1,16}(\.\d{1,4})?$/;

// Chia khoản còn dư theo bên: Nợ khi dư dương, Có khi dư âm. Khoản ngoại tệ bỏ khoản con của đánh giá lại (còn dư VND nhưng hết nguyên tệ: đi theo khoản gốc).
export function buildRows(items: OpenItem[], currency: string, preset: SettleEntry[] = []): { debit: PickRow[]; credit: PickRow[] } {
  const fx = currency !== 'VND'; const out = { debit: [] as PickRow[], credit: [] as PickRow[] };
  const picked = new Map(preset.map((p) => [p.openItemId, (fx ? p.amountCurrency : p.amount) ?? '0']));
  for (const i of items) {
    if (i.currency !== currency) continue;
    const signed = D(fx ? i.residualCurrency : i.residual);
    if (signed.isZero()) continue;
    out[signed.gt(0) ? 'debit' : 'credit'].push({ id: i.id, docNo: i.docNo ?? i.voucherNo ?? String(i.id), docDate: i.docDate, dueDate: i.dueDate, fx,
      remain: signed.abs().toFixed(), remainVnd: D(i.residual).abs().toFixed(0), pick: picked.get(i.id) ?? '0' });
  }
  for (const side of [out.debit, out.credit]) side.sort((a, b) => a.docDate.localeCompare(b.docDate) || a.id - b.id);
  return out;
}

// Ô Số đối trừ: để trống hoặc nhập 0 vào ô chưa chọn (Enter) thì lấy đủ số còn dư; nhập 0 vào ô đã chọn thì bỏ chọn; chữ sai thì giữ số cũ.
// Số vượt số còn dư vẫn được giữ (không âm thầm cắt) để màn hình báo và khóa nút Đối trừ.
export function parseChosen(p: Pick<ValueParserParams<PickRow>, 'newValue' | 'oldValue' | 'data'>): string {
  const row = p.data as PickRow; const text = String(p.newValue ?? '').trim(); const old = String(p.oldValue ?? '0');
  if (text === '' || (text === '0' && old === '0')) return row.remain;
  const parsed = parseVnNumber(text);
  if (parsed === null) return old;
  if (D(parsed).isZero()) return '0';
  if (!(row.fx ? FX_AMOUNT_RE : VND_AMOUNT_RE).test(parsed)) return old;
  return parsed;
}

// Ghép lần lượt từ trên xuống: mỗi cặp lấy số nhỏ hơn của phần còn lại bên Nợ và bên Có. Gọi khi tổng Nợ chọn bằng tổng Có chọn.
export function pairOff(debit: PickRow[], credit: PickRow[]): { debitItemId: number; creditItemId: number; amount: string }[] {
  const left = (rows: PickRow[]) => rows.filter((r) => D(r.pick).gt(0)).map((r) => ({ id: r.id, left: D(r.pick) }));
  const ds = left(debit); const cs = left(credit); const pairs: { debitItemId: number; creditItemId: number; amount: string }[] = [];
  let i = 0; let j = 0;
  while (i < ds.length && j < cs.length) {
    const d = ds[i]!; const c = cs[j]!; const take = d.left.lt(c.left) ? d.left : c.left;
    pairs.push({ debitItemId: d.id, creditItemId: c.id, amount: take.toFixed() });
    d.left = d.left.minus(take); c.left = c.left.minus(take);
    if (d.left.isZero()) i++;
    if (c.left.isZero()) j++;
  }
  return pairs;
}

export const sumPicks = (rows: PickRow[]) => rows.reduce((a, r) => a.plus(r.pick), D(0));
export const overResidual = (rows: PickRow[]) => rows.filter((r) => D(r.pick).gt(r.remain));
export const formatAmount = (v: Decimal | string, fx: boolean) => { const d = D(v); return fx ? formatVnNumber(d.toFixed(), d.decimalPlaces()) : formatVnNumber(d.toFixed(0)); };
export const entryOf = (r: PickRow): SettleEntry => (r.fx ? { openItemId: r.id, amountCurrency: r.pick } : { openItemId: r.id, amount: r.pick });

// Số chứng từ của các chứng từ sinh ra (CL, XQ, DG): lỗi đọc thì hiện mã nội bộ để vẫn mở được liên kết.
export const fetchVoucherNos = (ids: string[]) => Promise.all(ids.map((id) => api<{ voucherNo: string | null }>(`/api/vouchers/${id}`).then((v) => v.voucherNo ?? id).catch(() => id)));

const readonlyCols = (cols: ColDef<PickRow>[]) => cols.map((c) => ({ ...c, editable: false }));
const dateCol = (headerName: string, field: 'docDate' | 'dueDate'): ColDef<PickRow> => ({ field, headerName, width: 125, valueFormatter: (p) => (p.value ? formatVnDate(p.value as string) : '') });

// Lưới chọn khoản đối trừ: nhập số ở cột cuối, Enter ở ô trống lấy đủ số còn dư.
export function PickGrid({ rows, fx, onChange, height }: { rows: PickRow[]; fx: boolean; onChange: (rows: PickRow[]) => void; height: number | string }) {
  const columns = useMemo<ColDef<PickRow>[]>(() => [
    ...readonlyCols([dateCol('Ngày chứng từ', 'docDate'), { field: 'docNo', headerName: 'Số chứng từ', width: 140 }, dateCol('Hạn thanh toán', 'dueDate')]),
    ...(fx ? readonlyCols([{ field: 'remain', headerName: 'Nguyên tệ còn lại', width: 140, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => formatAmount(p.value as string, true) }]) : []),
    ...readonlyCols([{ field: 'remainVnd', headerName: 'Dư VND', width: 130, cellClass: 'ag-right-aligned-cell', valueFormatter: (p) => formatAmount(p.value as string, false) }]),
    { field: 'pick', headerName: 'Số đối trừ', width: 140, editable: true, cellClass: 'ag-right-aligned-cell', valueParser: parseChosen,
      valueFormatter: (p) => (p.value && !D(p.value as string).isZero() ? formatAmount(p.value as string, fx) : '') },
  ], [fx]);
  return <KeyboardGrid<PickRow> rows={rows} columns={columns} onRowsChange={onChange} addRowTemplate={() => ({} as PickRow)} lockRows height={height} />;
}

// Dòng chứng từ thu/chi có thể gắn đối trừ: bên khoản cần liệt kê (debit = khoản Nợ như hóa đơn bán hàng, credit = khoản Có như hóa đơn mua hàng).
export interface SettleTarget { index: number; accountCode: string; partyCode: string; side: 'debit' | 'credit'; amount: string | null; settle: SettleEntry[] }

// Hộp thoại "Chọn chứng từ công nợ" trên phiếu thu/chi, giấy báo: liệt kê khoản còn dư của đối tượng và tài khoản dòng đang chọn, ghi kế hoạch đối trừ vào dòng.
export function SettleDialog({ open, targets, currency, asOf, onApply, onClose }: { open: boolean; targets: SettleTarget[]; currency: string; asOf?: string | undefined; onApply: (index: number, settle: SettleEntry[]) => void; onClose: () => void }) {
  const [index, setIndex] = useState<number | null>(null);
  const target = targets.find((t) => t.index === index) ?? targets[0];
  const [rows, setRows] = useState<PickRow[]>([]);
  const items = useQuery({ queryKey: ['open-items', target?.accountCode, target?.partyCode, asOf], retry: false, enabled: open && !!target?.partyCode,
    queryFn: () => api<OpenItem[]>(`/api/open-items?${new URLSearchParams({ accountCode: target!.accountCode, partyCode: target!.partyCode, onlyOpen: 'true', ...(asOf ? { asOf } : {}) })}`) });
  const fx = currency !== 'VND';
  useEffect(() => { if (open && target && items.data) setRows(buildRows(items.data, currency, target.settle)[target.side]); }, [open, items.data, currency, target?.index, target?.side]);
  const total = sumPicks(rows); const over = overResidual(rows);
  const line = target?.amount && !fx ? D(target.amount) : null;
  const apply = () => {
    if (!target) return;
    if (over.length > 0) { void message.warning(`Số đối trừ của ${over.map((r) => r.docNo).join(', ')} vượt số còn dư`); return; }
    onApply(target.index, rows.filter((r) => D(r.pick).gt(0)).map(entryOf)); onClose();
  };
  // Ctrl+S áp dụng như bấm nút. Nghe ở pha bắt (capture) để phím không lọt tới Ctrl+S lưu chứng từ phía sau; ô lưới đang gõ dở được chốt (blur) trước khi đọc số.
  const run = useRef(apply); run.current = apply;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
      e.preventDefault(); e.stopPropagation(); (document.activeElement as HTMLElement | null)?.blur?.(); setTimeout(() => { run.current(); }, 0);
    };
    window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  return (
    <Modal title="Chọn chứng từ công nợ" open={open} onCancel={onClose} width={760} okText="Áp dụng (Ctrl+S)" cancelText="Đóng" okButtonProps={{ disabled: over.length > 0 || !target }} destroyOnHidden
      onOk={apply}>
      <Space direction="vertical" style={{ width: '100%' }}>
        {targets.length > 1 && <Select<number> aria-label="Dòng chứng từ" style={{ width: 360 }} value={target?.index ?? null} onChange={setIndex}
          options={targets.map((t) => ({ value: t.index, label: `Dòng ${t.index + 1}: TK ${t.accountCode}${t.partyCode ? ` - ${t.partyCode}` : ''}` }))} />}
        {!target?.partyCode ? <Alert type="info" showIcon message="Chọn đối tượng (F4) của chứng từ để xem các khoản còn dư" />
          : items.error ? <Alert type="error" showIcon message={(items.error as Error).message} />
          : <>
            <PickGrid rows={rows} fx={fx} onChange={setRows} height={280} />
            <span>Tổng chọn đối trừ: <b>{formatAmount(total, fx)}</b>{line ? <> · Số tiền trên dòng: <b>{formatAmount(line, false)}</b></> : null}</span>
            {over.length > 0 && <Alert type="error" showIcon message={`Số đối trừ của ${over.map((r) => r.docNo).join(', ')} vượt số còn dư`} />}
          </>}
      </Space>
    </Modal>
  );
}
