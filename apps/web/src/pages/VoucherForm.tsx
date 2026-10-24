import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Card, Col, DatePicker, Dropdown, Form, Input, InputNumber, Modal, Row, Select, Space, Spin, Tabs, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import type { ColDef } from 'ag-grid-community';
import dayjs, { type Dayjs } from 'dayjs';
import { canTransition, CASH_PURPOSES, D, decideEdit, formatVnDate, formatVnNumber, HEADER_FIELD_LABELS, isBalanced, parseVnDate, parseVnNumber, sum, todayVn, VND_AMOUNT_RE, voucherTypeDef,
  type CashPurpose, type HeaderField, type VoucherState, type VoucherTypeDef } from '@kt/domain';
import { KeyboardGrid, LookupSelect, VnNumberInput, useUnsavedChanges } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { assetPick, contractPick, costObjectPick, isAssetAccount, isContractAccount, isCostAccount, accountFetcherFor, bankAccountFetcher, cashFlowFetcherFor, regimeFor, type FiscalYearRef } from '../lookups.js';
import { STATE_LABEL, typeLabel } from './VoucherList.js';
import { SettleDialog, type SettleEntry, type SettleTarget } from './settleCommon.js';
import { Attachments, iso, quickAdd, reportError, text } from './voucherCommon.js';
import InvoiceEditor from './InvoiceForm.js';
import StockVoucher from './StockVoucher.js';
import AssemblyVoucher from './AssemblyVoucher.js';
import LandedCost from './LandedCost.js';
import { DECLARING_TYPES, DeclaredInvoices, clearPartySnapshot, declaredBody, declRowsOf, emptyDeclRow, type DeclRow } from './DeclaredInvoices.js';

// Các trường *Name chỉ để hiển thị; còn lại (employeeCode, dueDate, extraDims...) được giữ nguyên khi lưu lại để không mất dữ liệu chứng từ lập từ nơi khác.
// amountCurrency (nguyên tệ, có dấu), fxRate, bankAccountNo (tài khoản ngân hàng ghi đè của dòng) và settle (kế hoạch đối trừ công nợ) chỉ gửi khi có ý nghĩa, xem `linesBody`.
export interface Line { lineNo?: number; accountCode: string; accountName?: string; partyName?: string | null; description: string | null; debit: string; credit: string;
  amountCurrency?: string | undefined; fxRate?: string | undefined; bankAccountNo?: string | null | undefined; settle?: SettleEntry[] | undefined; settleSig?: string | undefined; partyCode: string | null; departmentCode: string | null; projectCode: string | null; costItemCode: string | null;
  dueDate?: string | null | undefined; cashFlowCode?: string | null | undefined; assetCode?: string | null | undefined; contractCode?: string | null | undefined; costObjectCode?: string | null | undefined }
interface Voucher { id: string; voucherType: string; voucherNo: string | null; postingDate: string; documentDate: string; state: string; description: string | null; partyCode: string | null;
  personName?: string | null; personAddress?: string | null; attachmentsCount?: number | null; bankAccountNo?: string | null; counterBankAccountNo?: string | null; partyBankAccountNo?: string | null;
  dueDate?: string | null; purpose?: string | null; invoices?: Parameters<typeof declRowsOf>[0]; periodStatus: 'open' | 'soft_locked' | 'hard_locked'; hashed: boolean;
  currencyCode: string; fxRate: string | null; version: number; totalDebit: string; lines: Line[]; warnings?: { code: string; message: string }[] }
interface FormValues { postingDate: Dayjs; documentDate: Dayjs; description?: string | null; partyCode?: string | null; personName?: string | null; personAddress?: string | null; attachmentsCount?: number | null;
  bankAccountNo?: string | null; counterBankAccountNo?: string | null; partyBankAccountNo?: string | null; dueDate?: Dayjs | null; purpose?: string | null; currencyCode?: string; fxRate?: string | null }

// Tên mẫu in trong menu In của loại chứng từ có nhiều mẫu (printForms của loại; mẫu đầu là mẫu mặc định).
const PRINT_FORM_LABELS: Record<string, string> = { '01-TT': 'Phiếu thu', '02-TT': 'Phiếu chi', 'giay-bao': 'Giấy báo ngân hàng', unc: 'Ủy nhiệm chi' };

export const emptyLine = (): Line => ({ accountCode: '', description: null, debit: '0', credit: '0', partyCode: null, departmentCode: null, projectCode: null, costItemCode: null });
export const totals = (lines: Line[]) => ({ debit: sum(lines.map((l) => l.debit || '0')).toString(), credit: sum(lines.map((l) => l.credit || '0')).toString() });
export const cleanLines = (lines: Line[]) => lines.filter((l) => l.accountCode.trim() !== '')
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  .map(({ accountName, partyName, lineNo, settleSig, ...rest }) => ({ ...rest, debit: rest.debit || '0', credit: rest.credit || '0' }));

// Phiếu thu/chi, giấy báo: nhập số tiền ở dòng quỹ/ngân hàng (dòng 1) thì dòng đối ứng đầu tiên (dòng 2) lấy cùng số tiền ở bên ngược lại,
// khi ô đó còn 0 hoặc đang bằng số tiền cũ của dòng 1 (đã sửa tay khác đi thì không đè). `last` là số tiền dòng 1 lần trước:
// lưới ghi thẳng vào đối tượng dòng nên không so được với bản cũ của mảng.
export function mirrorCashAmount(rows: Line[], side: 'debit' | 'credit', last: string): { rows: Line[]; last: string } {
  const cur = rows[0]?.[side] || '0';
  if (cur === last || !rows[1]) return { rows, last: rows[1] ? last : cur };
  const other = side === 'debit' ? 'credit' : 'debit';
  const counter = rows[1][other] || '0';
  return { rows: counter === '0' || counter === last ? [rows[0]!, { ...rows[1], [other]: cur }, ...rows.slice(2)] : rows, last: cur };
}

// Chứng từ đã ghi sổ chỉ sửa được diễn giải, các chiều phân tích, hạn và mã luồng tiền của dòng (không đổi số tiền, tài khoản, số dòng).
const META_COLS = ['description', 'departmentCode', 'projectCode', 'costItemCode', 'costObjectCode', 'dueDate', 'cashFlowCode'];
const LOOKUP_CATALOG: Record<string, string> = { accountCode: 'account', partyCode: 'party', departmentCode: 'department', projectCode: 'project', costItemCode: 'cost_item', bankAccountNo: 'bank_account', cashFlowCode: 'cash_flow', assetCode: 'asset', contractCode: 'contract', costObjectCode: 'cost_object' };

// Ô Nợ/Có: để trống (Backspace + Enter, Delete) là 0; chỉ nhận số nguyên không âm (tiền VND), chữ/số âm/số lẻ bị từ chối: giữ giá trị cũ.
export function parseAmount(newValue: unknown, oldValue: unknown): string {
  const t = String(newValue ?? '').trim();
  if (t === '') return '0';
  const n = parseVnNumber(t);
  return n !== null && VND_AMOUNT_RE.test(n) ? n : (oldValue as string | undefined) ?? '0';
}
const numCol = (field: 'debit' | 'credit', headerName: string): ColDef<Line> => ({ field, headerName, width: 150, cellClass: 'ag-right-aligned-cell',
  valueFormatter: (p) => formatVnNumber((p.value as string) || '0'), valueParser: (p) => parseAmount(p.newValue, p.oldValue) });
// Nguyên tệ có dấu (Nợ dương, Có âm), tối đa 4 số lẻ; để trống là chưa nhập, chữ sai thì giữ giá trị cũ.
const foreignCol: ColDef<Line> = { field: 'amountCurrency', headerName: 'Nguyên tệ (Nợ +, Có −)', width: 160, cellClass: 'ag-right-aligned-cell', cellEditorParams: { useFormatter: true },
  valueFormatter: (p) => { const s = p.value as string | undefined; return s ? formatVnNumber(s, D(s).decimalPlaces()) : ''; },
  valueParser: (p) => { const t = String(p.newValue ?? '').trim(); if (t === '') return undefined; const n = parseVnNumber(t); return n !== null && /^-?\d{1,16}(\.\d{1,4})?$/.test(n) ? n : p.oldValue; } };

// Hạn của dòng (công nợ: hạn thanh toán; vay, tiền gửi có kỳ hạn: ngày đáo hạn; B01 tách ngắn hạn, dài hạn): nhập dd/mm/yyyy, để trống là không có, chữ sai giữ giá trị cũ.
const dueCol: ColDef<Line> = { field: 'dueDate', headerName: 'Hạn thanh toán/đáo hạn', width: 130, cellEditorParams: { useFormatter: true },
  headerTooltip: 'Công nợ: hạn thanh toán; vay, tiền gửi có kỳ hạn: ngày đáo hạn. Báo cáo tình hình tài chính xếp phần có hạn trên 12 tháng vào dài hạn',
  valueFormatter: (p) => (p.value ? formatVnDate(p.value as string) : ''),
  valueParser: (p) => { const t = String(p.newValue ?? '').trim(); return t === '' ? null : parseVnDate(t) ?? p.oldValue; } };

// Trường tiêu đề đi vào thân yêu cầu; trường nào loại chứng từ không có thì không gửi.
const HEADER_BODY: Partial<Record<HeaderField, (f: FormValues) => object>> = {
  personName: (f) => ({ personName: text(f.personName) }), personAddress: (f) => ({ personAddress: text(f.personAddress) }), attachmentsCount: (f) => ({ attachmentsCount: f.attachmentsCount ?? null }),
  bankAccount: (f) => ({ bankAccountNo: f.bankAccountNo ?? null }), counterBankAccount: (f) => ({ counterBankAccountNo: f.counterBankAccountNo ?? null }),
  partyBankAccount: (f) => ({ partyBankAccountNo: text(f.partyBankAccountNo) }), dueDate: (f) => ({ dueDate: f.dueDate ? iso(f.dueDate) : null }), purpose: (f) => ({ purpose: f.purpose ?? null }),
};
// Dòng gửi lên: ngoại tệ mới có nguyên tệ; tỷ giá dòng trùng tỷ giá tiêu đề thì để máy chủ lấy theo tiêu đề; tài khoản ngân hàng dòng để trống thì máy chủ lấy theo tiêu đề.
const linesBody = (rows: Line[], f: FormValues) => cleanLines(rows).map(({ amountCurrency, fxRate, bankAccountNo, settle, assetCode, contractCode, ...l }) => ({ ...l, ...(assetCode?.trim() ? { assetCode: assetCode.trim() } : {}), ...(contractCode?.trim() ? { contractCode: contractCode.trim() } : {}), ...(settle?.length ? { settle } : {}),
  ...((f.currencyCode ?? 'VND') !== 'VND' && amountCurrency ? { amountCurrency } : {}),
  ...(fxRate && !(f.fxRate && D(fxRate).eq(f.fxRate)) ? { fxRate } : {}), ...(bankAccountNo ? { bankAccountNo } : {}) }));

// Loại chứng từ chọn được khoản công nợ để đối trừ khi ghi sổ (kế hoạch đối trừ ở dòng).
const SETTLE_TYPES = ['PT', 'PC', 'BC', 'BN', 'BT'];
// Chữ ký các trường làm kế hoạch đối trừ hết hiệu lực khi đổi: tài khoản, đối tượng hiệu lực (dòng, không có thì tiêu đề), hai bên số tiền, nguyên tệ và loại tiền.
// Chỉ để so sánh trong trang, không gửi lên máy chủ (cleanLines bỏ đi).
export const settleSig = (l: Line, headerParty: string | null | undefined, currency: string) => JSON.stringify([l.accountCode, l.partyCode || headerParty || '', l.debit || '0', l.credit || '0', l.amountCurrency ?? '', currency]);
// Dòng công nợ (131/331) có thể gắn đối trừ; bên khoản cần liệt kê ngược với bên dòng: dòng Có 131 thu tiền hóa đơn (khoản Nợ), dòng Nợ 331 trả tiền hóa đơn mua (khoản Có).
// Dòng chưa nhập số tiền thì theo bản chất tài khoản: 131 là khoản Nợ, 331 là khoản Có.
export function settleTargets(rows: Line[], headerParty: string | null | undefined): SettleTarget[] {
  return rows.flatMap((l, index) => {
    const asset = l.accountCode.startsWith('131'); const liability = l.accountCode.startsWith('331');
    if (!asset && !liability) return [];
    const side = D(l.credit || '0').gt(0) ? 'debit' : D(l.debit || '0').gt(0) ? 'credit' : asset ? 'debit' : 'credit';
    const amount = side === 'debit' ? l.credit : l.debit;
    return [{ index, accountCode: l.accountCode, partyCode: l.partyCode || headerParty || '', side, amount: amount && amount !== '0' ? amount : null, settle: l.settle ?? [] } satisfies SettleTarget];
  });
}

const initialLines = (def: VoucherTypeDef): Line[] => (def.moneyKind === 'cash' ? [{ ...emptyLine(), accountCode: '1111' }, emptyLine()] : [emptyLine(), emptyLine()]);
const counterAccountsOf = (p: CashPurpose, regime: string): string[] => p.counterAccounts[regime as keyof CashPurpose['counterAccounts']] ?? p.counterAccounts.TT99;

export default function VoucherPage() {
  const { type, id } = useParams({ strict: false }) as { type: string; id: string };
  const def = voucherTypeDef(type);
  if (!def) return <Alert type="error" showIcon message={`Không có loại chứng từ "${type}"`} />;
  if (def.code === 'LR') return <AssemblyVoucher key={`${def.code}/${id}`} def={def} id={id} />; // lắp ráp, tháo dỡ: gọi /api/assembly-vouchers
  if (def.stockDirection) return <StockVoucher key={`${def.code}/${id}`} def={def} id={id} />; // phiếu nhập, xuất, chuyển kho: màn hình kho, gọi /api/stock-vouchers
  if (def.code === 'CPM') return <LandedCost key={`${def.code}/${id}`} def={def} id={id} />; // chi phí mua hàng: chọn phiếu nhập, phân bổ, gọi /api/landed-costs
  if (def.hasItems) return <InvoiceEditor key={`${def.code}/${id}`} def={def} id={id} />; // hóa đơn mua/bán, giảm giá: màn hình riêng có thuế và bút toán xem trước
  return <VoucherEditor key={`${def.code}/${id}`} def={def} id={id} />; // đổi chứng từ (kể cả moi -> id sau khi lưu) thì dựng lại toàn bộ trạng thái nhập
}

function VoucherEditor({ def, id }: { def: VoucherTypeDef; id: string }) {
  const isNew = id === 'moi';
  const navigate = useNavigate(); const qc = useQueryClient(); const { can } = useAuth();
  const [form] = Form.useForm<FormValues>();
  const [lines, setLines] = useState<Line[]>(() => initialLines(def));
  const linesRef = useRef(lines); // bản mới nhất, đọc đồng bộ khi lưu (state có thể chưa kịp render sau khi ô vừa chốt giá trị)
  const [lookup, setLookup] = useState<{ col: string; row: number } | null>(null);
  const [reverse, setReverse] = useState<{ date: Dayjs; description: string } | null>(null);
  const [settleOpen, setSettleOpen] = useState(false);
  const lookupBox = useRef<HTMLDivElement>(null); // hộp thoại chọn danh mục: đưa con trỏ vào ô tìm ngay khi mở (antd Modal tự giữ tiêu điểm ở khung)
  const [idempotencyKey] = useState(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`); // (randomUUID cần HTTPS) bấm lưu hai lần liền khi tạo mới không sinh hai chứng từ
  const v = useQuery({ queryKey: ['voucher', id], queryFn: () => api<Voucher>(`/api/vouchers/${id}`), enabled: !isNew });
  const years = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api<FiscalYearRef[]>('/api/fiscal-years') });
  // Loại thật của chứng từ là loại trong dữ liệu, không phải đoạn đường dẫn (liên kết từ sổ cái, soát lỗi chỉ biết mã chứng từ).
  const realType = v.data?.voucherType;
  const eff = (realType ? voucherTypeDef(realType) : undefined) ?? def;
  const mismatch = !!realType && realType !== def.code && !!voucherTypeDef(realType);
  useEffect(() => { if (mismatch) void navigate({ to: '/chung-tu/$type/$id', params: { type: realType!, id }, replace: true }); }, [mismatch, realType, id, navigate]);

  const state = (v.data?.state ?? 'draft') as VoucherState;
  const viewOnly = !eff.manual; // chứng từ hệ thống tự sinh: chỉ xem và in
  const posted = state === 'posted';
  const decision = posted ? decideEdit({ periodStatus: v.data?.periodStatus ?? 'open', hashed: v.data?.hashed ?? false, change: 'amount', canEditPosted: can('voucher.edit_posted'), canBackdateLocked: can('voucher.backdate_locked') }) : null;
  const editable = state === 'draft' && !viewOnly;
  const metaOnly = posted && !viewOnly && decideEdit({ periodStatus: v.data?.periodStatus ?? 'open', hashed: v.data?.hashed ?? false, change: 'meta', canEditPosted: true, canBackdateLocked: true }) !== 'forbidden';
  const locked = !editable && !metaOnly;

  // Chưa lưu: so các dòng với bản lúc tải/lưu, cộng cờ đã sửa tiêu đề; dùng cho hộp xác nhận trước khi bỏ phần đang nhập.
  const baseline = useRef(JSON.stringify(cleanLines(lines)));
  const [formDirty, setFormDirty] = useState(false); const [rowsDirty, setRowsDirty] = useState(false);
  // Hóa đơn kê khai nhập tay (PC/BN/PKT): lưới riêng, cùng cách theo dõi chưa lưu.
  const declaring = DECLARING_TYPES.includes(eff.code);
  const [declRows, setDeclRows] = useState<DeclRow[]>(() => [emptyDeclRow()]);
  const declRef = useRef(declRows); const declBaseline = useRef(JSON.stringify(declRows)); const [declDirty, setDeclDirty] = useState(false);
  const changeDecl = useCallback((rows: DeclRow[]) => { declRef.current = rows; setDeclRows(rows); setDeclDirty(JSON.stringify(rows) !== declBaseline.current); }, []);
  const confirmIfDirty = useUnsavedChanges((formDirty || rowsDirty || declDirty) && (editable || metaOnly));
  const lastCash = useRef('0'); const autoAccount = useRef<string>(); const lastParty = useRef<string | null>(null);
  const cashSide = eff.cashSide && eff.moneyKind ? (eff.cashSide === 'in' ? 'debit' : 'credit') : undefined;

  const setAllLines = useCallback((rows: Line[]) => { linesRef.current = rows; setLines(rows); }, []);
  // Mọi thay đổi dòng do người dùng thực hiện đi qua đây (lưới, hộp tra danh mục, điền sẵn theo mục đích).
  const changeRows = useCallback((rows: Line[]) => {
    let next = rows;
    if (cashSide) { const m = mirrorCashAmount(rows, cashSide, lastCash.current); next = m.rows; lastCash.current = m.last; }
    setAllLines(next); setRowsDirty(JSON.stringify(cleanLines(next)) !== baseline.current);
  }, [cashSide, setAllLines]);
  useEffect(() => {
    if (!v.data) return;
    // Tài khoản ngân hàng dòng trùng tiêu đề là do máy chủ suy ra: bỏ đi để đổi tài khoản ở tiêu đề thì các dòng đổi theo.
    const derived = (b?: string | null) => !!b && (b === v.data.bankAccountNo || b === v.data.counterBankAccountNo);
    const rows = v.data.lines.map((l) => ({ ...l, ...(derived(l.bankAccountNo) && { bankAccountNo: null }), ...(!!l.settle?.length && { settleSig: settleSig(l, v.data.partyCode, v.data.currencyCode) }) }));
    form.setFieldsValue({ ...v.data, postingDate: dayjs(v.data.postingDate), documentDate: dayjs(v.data.documentDate), dueDate: v.data.dueDate ? dayjs(v.data.dueDate) : null, fxRate: v.data.fxRate });
    const all = v.data.state === 'draft' ? [...rows, emptyLine()] : rows;
    baseline.current = JSON.stringify(cleanLines(all)); lastCash.current = (cashSide && all[0]?.[cashSide]) || '0'; lastParty.current = v.data.partyCode;
    setAllLines(all); setFormDirty(false); setRowsDirty(false);
    const decl = declRowsOf(v.data.invoices ?? []); const declAll = v.data.state === 'draft' ? [...decl, emptyDeclRow()] : decl;
    declRef.current = declAll; declBaseline.current = JSON.stringify(declAll); setDeclRows(declAll); setDeclDirty(false);
  }, [v.data, form, setAllLines, cashSide]);
  const postingDate = Form.useWatch('postingDate', form);
  const postingIso = postingDate?.isValid() ? iso(postingDate) : undefined;
  const currency = Form.useWatch('currencyCode', form) ?? 'VND';
  const bankAccountNo = Form.useWatch('bankAccountNo', form);
  const headerParty = Form.useWatch('partyCode', form);
  // Kế hoạch đối trừ chỉ đúng với dòng như lúc chọn: đổi tài khoản, đối tượng, số tiền, nguyên tệ hoặc loại tiền thì bỏ kế hoạch của dòng đó và báo người dùng chọn lại.
  // Đọc tiêu đề trực tiếp từ form (đồng bộ ngay sau setFieldsValue) để lần tải chứng từ không bị coi là đổi.
  useEffect(() => {
    const party = form.getFieldValue('partyCode') as string | null | undefined; const cur = (form.getFieldValue('currencyCode') as string | undefined) ?? 'VND';
    const stale = linesRef.current.flatMap((l, i) => (l.settle?.length && l.settleSig !== undefined && l.settleSig !== settleSig(l, party, cur) ? [i] : []));
    if (stale.length === 0) return;
    const next = linesRef.current.map((l, i) => (stale.includes(i) ? { ...l, settle: undefined, settleSig: undefined } : l));
    setAllLines(next); setRowsDirty(JSON.stringify(cleanLines(next)) !== baseline.current);
    void message.warning(`Đã bỏ kế hoạch đối trừ của dòng ${stale.map((i) => i + 1).join(', ')} vì dòng đã đổi (tài khoản, đối tượng, số tiền hoặc loại tiền); chọn lại chứng từ công nợ`);
  }, [lines, currency, headerParty, form, setAllLines]);
  // Tồn quỹ (tiền mặt) hoặc số dư tiền gửi (đã chọn tài khoản ngân hàng) cuối ngày hạch toán; chưa đủ dữ kiện hoặc không xem được thì không hiện.
  const cashAccount = eff.moneyKind === 'cash' ? lines.find((l) => l.accountCode.startsWith('111'))?.accountCode : eff.moneyKind === 'bank' && bankAccountNo ? '112' : undefined;
  const cashBalance = useQuery({ queryKey: ['cash-balance', cashAccount, bankAccountNo, currency, postingIso], enabled: !!cashAccount && !!postingIso && can('voucher.view'), retry: false,
    queryFn: () => api<{ balance: string; balanceCurrency: string }>(`/api/cash/balance?${new URLSearchParams({ accountCode: cashAccount!, asOf: postingIso!, ...(eff.moneyKind === 'bank' && bankAccountNo ? { bankAccountNo } : {}), ...(currency !== 'VND' ? { currency } : {}) })}`) });
  // Tỷ giá xuất quỹ bình quân di động (cài đặt fx_outflow_method) của phiếu chi, giấy báo Nợ, chuyển tiền nội bộ ngoại tệ: điền sẵn vào tỷ giá tiêu đề khi ô trống
  // hoặc còn là số do lần điền trước đặt (người dùng đã sửa thì giữ).
  const outAccount = eff.cashSide === 'out' ? cashAccount : eff.code === 'CT' && bankAccountNo ? '112' : undefined;
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<{ fx_outflow_method?: string }>('/api/settings'), enabled: editable && !!outAccount && currency !== 'VND' });
  const outflowRate = useQuery({ queryKey: ['fx-outflow-rate', outAccount, bankAccountNo, currency, postingIso], retry: false,
    enabled: editable && !!outAccount && currency !== 'VND' && !!postingIso && can('voucher.view') && settings.data?.fx_outflow_method === 'moving_average',
    queryFn: () => api<{ rate: string | null }>(`/api/fx/outflow-rate?${new URLSearchParams({ accountCode: outAccount!, ...(outAccount === '112' && bankAccountNo ? { bankAccountNo } : {}), currency, date: postingIso! })}`) });
  const autoRate = useRef<string>();
  useEffect(() => {
    const rate = outflowRate.data?.rate; const cur = form.getFieldValue('fxRate') as string | null | undefined;
    if (rate && (!cur || cur === autoRate.current)) { autoRate.current = rate; form.setFieldsValue({ fxRate: rate }); }
  }, [outflowRate.data, form]);
  const regime = regimeFor(years.data ?? [], postingIso);
  const settleList = settleTargets(lines, headerParty); const settleCount = settleList.reduce((n, t) => n + t.settle.length, 0);
  const maySettle = editable && SETTLE_TYPES.includes(eff.code) && can('settlement.view') && can('settlement.create');
  const accountFetcher = useMemo(() => accountFetcherFor(postingIso), [postingIso]);
  const cashFlowFetcher = useMemo(() => cashFlowFetcherFor(postingIso), [postingIso]);
  const t = totals(lines); const balanced = isBalanced(cleanLines(lines).map((l) => ({ debit: l.debit, credit: l.credit })));

  const invalidate = (voucherId = id) => Promise.all([qc.invalidateQueries({ queryKey: ['voucher', voucherId] }), qc.invalidateQueries({ queryKey: ['vouchers'] }), qc.invalidateQueries({ queryKey: ['cash-balance'] })]);
  const conflict = useRef<{ destroy(): void } | null>(null);
  const onErr = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') { // người khác đã sửa: không tự tải lại (mất chữ đang nhập), để người dùng chọn
      conflict.current?.destroy();
      conflict.current = Modal.confirm({ title: 'Chứng từ đã được người khác sửa', content: `${e.message}. Tải lại sẽ bỏ phần bạn đang nhập.`, okText: 'Tải lại', cancelText: 'Giữ bản đang nhập', onOk: () => invalidate() });
      return;
    }
    reportError(e, navigate);
  };
  // Ô đang gõ dở chưa vào state: rời ô để lưới chốt giá trị trước khi lấy dòng (Ctrl+S/F9 khi con trỏ còn trong ô).
  const flushEditing = async () => { (document.activeElement as HTMLElement | null)?.blur(); await new Promise((r) => setTimeout(r, 0)); };
  const body = (f: FormValues) => ({
    voucherType: eff.code, postingDate: iso(f.postingDate), documentDate: iso(f.documentDate), description: f.description ?? null, partyCode: f.partyCode ?? null,
    currencyCode: f.currencyCode ?? 'VND', ...((f.currencyCode ?? 'VND') !== 'VND' && f.fxRate ? { fxRate: f.fxRate } : {}),
    ...Object.assign({}, ...eff.header.map((h) => HEADER_BODY[h]?.(f))), lines: linesBody(linesRef.current, f), ...(declaring ? { invoices: declaredBody(declRef.current) } : {}) });
  // Lưu bản đang nhập; ghi sổ (F9) lưu trước rồi mới ghi để không ghi sổ bản cũ trên máy chủ.
  const persist = async (postAfter: boolean): Promise<Voucher> => {
    await flushEditing();
    const f = await form.validateFields();
    if (postAfter) { // kiểm tra trên dòng vừa chốt (không phải state có thể chưa kịp render), trước mọi lời gọi máy chủ
      const rows = cleanLines(linesRef.current);
      if (!isBalanced(rows)) throw new Error(`Chứng từ chưa cân: tổng Nợ ${formatVnNumber(sum(rows.map((l) => l.debit)).toString())} khác tổng Có ${formatVnNumber(sum(rows.map((l) => l.credit)).toString())}`);
    }
    if (isNew) return api<Voucher>('/api/vouchers', { method: 'POST', json: { ...body(f), idempotencyKey, ...(postAfter ? { autoPost: true } : {}) } });
    // sửa chứng từ đã ghi sổ: định vị dòng theo lineNo của máy chủ, không theo vị trí trên lưới
    const meta = linesRef.current.filter((l) => l.lineNo !== undefined).map((l) => ({ lineNo: l.lineNo!, description: l.description, departmentCode: l.departmentCode, projectCode: l.projectCode, costItemCode: l.costItemCode, costObjectCode: l.costObjectCode ?? null,
      dueDate: l.dueDate ?? null, cashFlowCode: l.cashFlowCode || null }));
    const saved = await api<Voucher>(`/api/vouchers/${id}`, { method: 'PUT', json: editable ? { ...body(f), version: v.data!.version } : { version: v.data!.version, description: f.description ?? null, lines: meta } });
    if (!postAfter) return saved;
    // đã lưu mà ghi sổ lỗi (chứng từ lệch, kỳ khóa...): tải lại để version khớp với bản vừa lưu, lần Ctrl+S sau không bị VERSION_CONFLICT
    return api<Voucher>(`/api/vouchers/${id}/post`, { method: 'POST', json: {} }).catch((e: unknown) => { invalidate(); throw e; });
  };
  const toVoucher = (r: Voucher) => void navigate({ to: '/chung-tu/$type/$id', params: { type: r.voucherType ?? eff.code, id: r.id } });
  const save = useMutation({ mutationFn: (postAfter: boolean) => persist(postAfter), onError: onErr,
    // trả Promise: isPending giữ tới khi tải lại xong, để Ctrl+S liền sau không gửi version cũ
    onSuccess: async (r, postAfter) => {
      void message.success(postAfter ? 'Đã ghi sổ' : 'Đã lưu');
      for (const w of r.warnings ?? []) void message.warning({ content: w.message, duration: 10 }); // ví dụ CASH_NEGATIVE: ghi sổ được nhưng tồn quỹ âm
      setFormDirty(false); setRowsDirty(false); setDeclDirty(false); // đã lưu: chuyển trang không hỏi bỏ thay đổi
      if (isNew) toVoucher({ ...r, voucherType: r.voucherType ?? eff.code });
      await invalidate(r.id); // luôn tải lại: một lần tải đang chạy từ trước khi ghi sổ không được ghi đè trạng thái mới
    } });
  const action = useMutation({ mutationFn: (p: { act: string; body?: object }) => api<Voucher>(`/api/vouchers/${id}/${p.act}`, { method: 'POST', json: p.body ?? {} }), onError: onErr,
    onSuccess: async (r, p) => { void message.success({ unpost: 'Đã bỏ ghi sổ', reverse: `Đã tạo chứng từ đảo ${r.voucherNo}`, discard: 'Đã hủy', duplicate: 'Đã nhân bản' }[p.act] ?? 'Xong');
      for (const w of r.warnings ?? []) void message.warning({ content: w.message, duration: 10 }); // bỏ ghi sổ hoặc đảo làm tồn quỹ âm ở chế độ warn
      if (p.act === 'reverse') setReverse(null);
      if (p.act === 'reverse' || p.act === 'duplicate') toVoucher({ ...r, voucherType: r.voucherType ?? eff.code }); else await invalidate(); } });

  // Chứng từ có sẵn phải tải xong (cần version, trạng thái, dòng) mới được lưu/ghi sổ; nút hiện sẵn nhưng khóa, phím tắt bị bỏ qua.
  const ready = isNew || !!v.data;
  const mayEdit = !viewOnly && !locked && (isNew ? can('voucher.create') : can('voucher.update'));
  const canSave = ready && mayEdit;
  const mayPost = !viewOnly && (isNew || canTransition(state, 'post')) && can('voucher.post');
  const canPost = ready && mayPost;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isSave = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's'; const isPost = e.key === 'F9';
      if (!isSave && !isPost) return;
      e.preventDefault(); // chặn hộp "Lưu trang" của trình duyệt cả khi đang mở hộp thoại
      if ((e.target as Element | null)?.closest?.('.ant-modal-root')) return; // hộp thoại (Đảo, tra danh mục, xác nhận) mở: phím tắt không lưu chứng từ phía sau nó
      if (isSave && canSave && !save.isPending) save.mutate(false);
      if (isPost && canPost && canSave && !save.isPending) save.mutate(true);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [save, canSave, canPost]);
  // Nút theo trạng thái, quyền và kỳ (decideEdit): kỳ mở cần quyền sửa sau ghi sổ mới Bỏ ghi sổ; kỳ khóa mềm chỉ Đảo; kỳ khóa cứng hoặc đã vào chuỗi băm chỉ Nhân bản sang kỳ mở.
  const mayUnpost = !viewOnly && canTransition(state, 'unpost') && decision === 'unpost_edit_post' && can('voucher.unpost');
  const mayReverse = !viewOnly && canTransition(state, 'reverse') && decision !== 'adjust_in_open_period' && can('voucher.post');
  const mayDuplicate = !viewOnly && can('voucher.create');

  // Cột Tài sản hiện khi có dòng ở TK tài sản hoặc 242 (hoặc đã có mã tài sản).
  const showAsset = lines.some((l) => isAssetAccount(l.accountCode) || !!l.assetCode);
  const showContract = lines.some((l) => isContractAccount(l.accountCode) || !!l.contractCode);
  const costingOn = useQuery({ queryKey: ['settings'], queryFn: () => api<{ costing_enabled?: boolean }>('/api/settings') }).data?.costing_enabled === true;
  const showCostObject = costingOn || lines.some((l) => isCostAccount(l.accountCode) || !!l.costObjectCode);
  const columns = useMemo<ColDef<Line>[]>(() => ([
    { field: 'accountCode', headerName: 'TK (F4)', width: 110 }, { field: 'description', headerName: 'Diễn giải', flex: 1 },
    numCol('debit', 'Nợ'), numCol('credit', 'Có'),
    ...(currency !== 'VND' ? [foreignCol] : []),
    { field: 'partyCode', headerName: 'Đối tượng (F4)', width: 130 }, { field: 'departmentCode', headerName: 'Bộ phận', width: 100 },
    { field: 'projectCode', headerName: 'Vụ việc', width: 100 }, { field: 'costItemCode', headerName: 'Khoản mục', width: 110 },
    ...(showCostObject ? [{ field: 'costObjectCode', headerName: 'Đối tượng THCP (F4)', width: 150, headerTooltip: 'Đối tượng tập hợp chi phí (giá thành): dòng TK 621, 622, 627, 154' } satisfies ColDef<Line>] : []),
    ...(eff.moneyKind === 'bank' ? [{ field: 'bankAccountNo', headerName: 'TK ngân hàng (F4)', width: 150, headerTooltip: 'Để trống là lấy theo tài khoản ngân hàng ở tiêu đề' } satisfies ColDef<Line>] : []),
    ...(showAsset ? [{ field: 'assetCode', headerName: 'Tài sản (F4)', width: 130, headerTooltip: 'Chỉ ở dòng TK tài sản cố định, hao mòn, 242', editable: (p) => isAssetAccount(p.data?.accountCode ?? '') } satisfies ColDef<Line>] : []),
    ...(showContract ? [{ field: 'contractCode', headerName: 'Khế ước (F4)', width: 130, headerTooltip: 'Chỉ ở dòng TK vay 341x, lãi vay phải trả 335', editable: (p) => isContractAccount(p.data?.accountCode ?? '') } satisfies ColDef<Line>] : []),
    dueCol, { field: 'cashFlowCode', headerName: 'Mã luồng tiền (F4)', width: 140, headerTooltip: 'Chỉ ở dòng tiền mặt, tiền gửi: mã chỉ tiêu của Báo cáo lưu chuyển tiền tệ; để trống thì xếp theo tài khoản đối ứng' },
  ] satisfies ColDef<Line>[]).map((c) => (c.field === 'assetCode' || c.field === 'contractCode' ? (editable ? c : { ...c, editable: false }) : { ...c, editable: editable || (metaOnly && META_COLS.includes(c.field as string)) })), [editable, metaOnly, currency, eff.moneyKind, showAsset, showContract, showCostObject]);
  // Chứng từ đã ghi sổ: không thêm/xóa dòng (lineNo của máy chủ phải khớp).
  const onRowsChange = useCallback((rows: Line[]) => { if (editable || rows.length === linesRef.current.length) changeRows(rows); }, [editable, changeRows]);
  const onLookup = useCallback((col: string, row: number) => { if (col in LOOKUP_CATALOG && (col !== 'assetCode' || isAssetAccount(linesRef.current[row]?.accountCode ?? '')) && (col !== 'contractCode' || isContractAccount(linesRef.current[row]?.accountCode ?? '')) && (editable || (metaOnly && META_COLS.includes(col)))) setLookup({ col, row }); }, [editable, metaOnly]);

  // Chọn mục đích: điền tài khoản đối ứng mặc định của chế độ vào dòng 2 (nếu còn trống hoặc là do lần chọn mục đích trước điền), kèm đối tượng của tiêu đề khi mục đích bắt buộc đối tượng.
  const applyPurpose = (code: string | null | undefined, party: string | null | undefined) => {
    const p = CASH_PURPOSES.find((x) => x.code === code);
    const acct = p && counterAccountsOf(p, regime)[0];
    if (!p || !acct) return;
    const rows = [...linesRef.current]; while (rows.length < 2) rows.push(emptyLine());
    const cur = rows[1]!;
    if (cur.accountCode === '' || cur.accountCode === autoAccount.current) rows[1] = { ...cur, accountCode: acct, ...(p.partyRequired && party ? { partyCode: party } : {}) };
    autoAccount.current = acct; changeRows(rows);
  };
  // Đổi đối tượng ở tiêu đề: các dòng đối ứng của mục đích bắt buộc đối tượng lấy đối tượng mới nếu đang trống hoặc đang là đối tượng tiêu đề cũ.
  const applyParty = (party: string | null) => {
    const p = CASH_PURPOSES.find((x) => x.code === form.getFieldValue('purpose'));
    const prev = lastParty.current; lastParty.current = party;
    // Dòng hóa đơn kê khai không chọn người bán lấy đối tượng tiêu đề: bỏ bản chụp tên/MST/địa chỉ của đối tượng cũ.
    if (declRef.current.some((r) => !r.partyCode.trim())) changeDecl(declRef.current.map((r) => (r.partyCode.trim() ? r : clearPartySnapshot(r))));
    if (!p?.partyRequired) return;
    const counters = counterAccountsOf(p, regime);
    changeRows(linesRef.current.map((l, i) => (i > 0 && counters.includes(l.accountCode) && (l.partyCode == null || l.partyCode === prev) ? { ...l, partyCode: party } : l)));
  };
  const onValuesChange = (changed: Partial<FormValues>, all: FormValues) => {
    setFormDirty(true);
    if ('purpose' in changed) applyPurpose(changed.purpose, all.partyCode);
    if ('partyCode' in changed) applyParty(changed.partyCode ?? null);
  };

  const sideIn = eff.cashSide === 'in'; const sideOut = eff.cashSide === 'out';
  const labels: Partial<Record<HeaderField, string>> = { personName: sideIn ? 'Người nộp tiền' : sideOut ? 'Người nhận tiền' : eff.code === 'QTU' ? 'Người tạm ứng' : HEADER_FIELD_LABELS.personName };
  const labelOf = (h: HeaderField) => labels[h] ?? HEADER_FIELD_LABELS[h];
  const purposes = CASH_PURPOSES.filter((p) => (p.types as string[]).includes(eff.code));
  const headerField = (h: HeaderField): ReactNode => {
    const rules = eff.required.includes(h) ? [{ required: true, message: `Nhập ${labelOf(h).toLowerCase()}` }] : undefined;
    const item = (span: number, name: keyof FormValues, control: ReactNode) => <Col span={span}><Form.Item label={labelOf(h)} name={name} {...(rules ? { rules } : {})}>{control}</Form.Item></Col>;
    switch (h) {
      case 'party': return item(8, 'partyCode', <LookupSelect catalog="party" disabled={!editable} quickAddFields={quickAdd} />);
      case 'personName': return item(6, 'personName', <Input disabled={!editable} maxLength={200} />);
      case 'personAddress': return item(10, 'personAddress', <Input disabled={!editable} maxLength={200} />);
      case 'attachmentsCount': return item(6, 'attachmentsCount', <InputNumber min={0} max={999} precision={0} style={{ width: '100%' }} disabled={!editable} />);
      case 'bankAccount': return item(8, 'bankAccountNo', <LookupSelect catalog="bank_account" fetcher={bankAccountFetcher} disabled={!editable} />);
      case 'counterBankAccount': return item(8, 'counterBankAccountNo', <LookupSelect catalog="bank_account" fetcher={bankAccountFetcher} disabled={!editable} />);
      case 'partyBankAccount': return item(8, 'partyBankAccountNo', <Input disabled={!editable} maxLength={50} />);
      case 'dueDate': return item(6, 'dueDate', <DatePicker format="DD/MM/YYYY" disabled={!editable} />);
      case 'purpose': return item(8, 'purpose', <Select allowClear disabled={!editable} placeholder="Chọn mục đích" options={purposes.map((p) => ({ value: p.code, label: p.label }))} />);
      case 'currency': return (<>
        {item(4, 'currencyCode', <LookupSelect catalog="currency" disabled={!editable} />)}
        {currency !== 'VND' && <Col span={6}><Form.Item label="Tỷ giá" name="fxRate" rules={[{ required: true, message: 'Nhập tỷ giá' }]}><VnNumberInput scale={10} disabled={!editable} /></Form.Item></Col>}
      </>);
    }
  };

  const ledgerGrid = (<>
    <KeyboardGrid<Line> rows={lines} columns={columns} readOnly={locked} lockRows={metaOnly} onRowsChange={onRowsChange} addRowTemplate={emptyLine} onLookup={onLookup} height={360} />
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 8 }}>
      <b>Tổng Nợ: {formatVnNumber(t.debit)}</b><b>Tổng Có: {formatVnNumber(t.credit)}</b>
      {!balanced && <Tag color="red">Chênh lệch {formatVnNumber(sum([t.debit, `-${t.credit}`]).toString())}</Tag>}
    </div>
  </>);

  if (mismatch) return <Spin />; // đang chuyển sang đường dẫn đúng loại của chứng từ
  return (
    <Card title={<Space><span>{typeLabel(eff)} {v.data?.voucherNo ?? (isNew ? '(mới)' : '(chưa cấp số)')}</span><Tag>{STATE_LABEL[state]}</Tag></Space>}
      extra={<Space>
        {maySettle && <Button onClick={() => setSettleOpen(true)} disabled={settleList.length === 0} title={settleList.length === 0 ? 'Nhập dòng tài khoản 131 hoặc 331 để chọn chứng từ công nợ' : undefined}>Chọn chứng từ công nợ{settleCount > 0 && <Tag style={{ marginLeft: 8, marginRight: 0 }}>{settleCount}</Tag>}</Button>}
        {mayEdit && <Button onClick={() => save.mutate(false)} type="primary" loading={save.isPending} disabled={!ready}>Lưu (Ctrl+S)</Button>}
        {mayEdit && mayPost && <Button onClick={() => save.mutate(true)} disabled={!ready || !balanced || save.isPending}>Ghi sổ (F9)</Button>}
        {!isNew && mayUnpost && <Button onClick={() => confirmIfDirty(() => action.mutate({ act: 'unpost' }))}>Bỏ ghi sổ</Button>}
        {!isNew && mayReverse && v.data && <Button onClick={() => confirmIfDirty(() => { const p = v.data!.postingDate; const today = todayVn(); setReverse({ date: dayjs(today >= p ? today : p), description: `Đảo chứng từ ${v.data!.voucherNo} ngày ${formatVnDate(p)}` }); })}>Đảo</Button>}
        {!isNew && !viewOnly && canTransition(state, 'discard') && can('voucher.delete') && <Button danger onClick={() => Modal.confirm({ title: 'Hủy chứng từ?', content: 'Số chứng từ (nếu có) được giữ lại.', onOk: () => action.mutate({ act: 'discard' }) })}>Hủy</Button>}
        {!isNew && mayDuplicate && <Button onClick={() => confirmIfDirty(() => action.mutate({ act: 'duplicate', body: { postingDate: todayVn() } }))}>{decision === 'adjust_in_open_period' ? 'Nhân bản sang kỳ mở' : 'Nhân bản'}</Button>}
        {!isNew && can('voucher.print') && (eff.printForms.length > 1
          ? <Dropdown trigger={['click']} menu={{ items: eff.printForms.map((f) => ({ key: f, label: <a href={`/api/vouchers/${id}/print?format=pdf&form=${f}`} target="_blank" rel="noreferrer">{PRINT_FORM_LABELS[f] ?? f}</a> })) }}><Button>In ▾</Button></Dropdown>
          : <Button href={`/api/vouchers/${id}/print?format=pdf`} target="_blank">In</Button>)}
      </Space>}>
      {v.error && <Alert type="error" showIcon message={(v.error as Error).message} style={{ marginBottom: 12 }} />}
      <Form form={form} layout="vertical" initialValues={{ postingDate: dayjs(todayVn()), documentDate: dayjs(todayVn()), currencyCode: 'VND' }} onValuesChange={onValuesChange}>
        <Row gutter={12}>
          <Col span={4}><Form.Item label="Ngày hạch toán" name="postingDate" rules={[{ required: true, message: 'Nhập ngày hạch toán' }]}><DatePicker format="DD/MM/YYYY" disabled={!editable} /></Form.Item></Col>
          <Col span={4}><Form.Item label="Ngày chứng từ" name="documentDate" rules={[{ required: true, message: 'Nhập ngày chứng từ' }]}><DatePicker format="DD/MM/YYYY" disabled={!editable} /></Form.Item></Col>
          {!eff.header.includes('party') && <Col span={16} />}
          {eff.header.map((h) => <Fragment key={h}>{headerField(h)}</Fragment>)}
          <Col span={24}><Form.Item label={sideIn ? 'Lý do nộp' : sideOut ? 'Lý do chi' : 'Diễn giải'} name="description"><Input disabled={locked} /></Form.Item></Col>
        </Row>
      </Form>
      {declaring ? (
        <Tabs size="small" items={[{ key: 'ledger', label: 'Hạch toán', children: ledgerGrid },
          { key: 'invoices', label: <span>Hóa đơn{declRows.some((r) => r.invoiceNo.trim()) && <Tag style={{ marginLeft: 6, marginRight: 0 }}>{declRows.filter((r) => r.invoiceNo.trim()).length}</Tag>}</span>,
            children: <DeclaredInvoices rows={declRows} onRowsChange={changeDecl} editable={editable} /> }]} />
      ) : ledgerGrid}
      {cashBalance.data?.balance !== undefined && postingIso && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <Tag color={D(cashBalance.data.balance).lt(0) ? 'red' : 'default'}>
            {eff.moneyKind === 'cash' ? 'Tồn quỹ' : 'Số dư tiền gửi'} cuối ngày {formatVnDate(postingIso)}{posted ? '' : ' (chưa kể phiếu này)'}: {formatVnNumber(cashBalance.data.balance)}
            {currency !== 'VND' && <> ({formatVnNumber(cashBalance.data.balanceCurrency, D(cashBalance.data.balanceCurrency).decimalPlaces())} {currency})</>}
          </Tag>
        </div>)}
      {!isNew && <Attachments voucherId={id} canEdit={can('voucher.update')} />}
      <Modal open={!!lookup} onCancel={() => setLookup(null)} footer={null} title="Chọn từ danh mục" destroyOnHidden afterOpenChange={(o) => { if (o) lookupBox.current?.querySelector('input')?.focus(); }}>
        {lookup && <div ref={lookupBox}><LookupSelect catalog={LOOKUP_CATALOG[lookup.col]!} style={{ width: '100%' }}
          {...(lookup.col === 'accountCode' ? { fetcher: accountFetcher } : lookup.col === 'bankAccountNo' ? { fetcher: bankAccountFetcher } : lookup.col === 'cashFlowCode' ? { fetcher: cashFlowFetcher } : lookup.col === 'assetCode' ? { fetcher: assetPick } : lookup.col === 'contractCode' ? { fetcher: contractPick } : lookup.col === 'costObjectCode' ? { fetcher: costObjectPick } : { quickAddFields: quickAdd })}
          onChange={(code) => { if (code !== null) { const copy = [...linesRef.current]; copy[lookup.row] = { ...copy[lookup.row]!, [lookup.col]: code }; changeRows(copy); } setLookup(null); }} /></div>}
      </Modal>
      {maySettle && <SettleDialog open={settleOpen} targets={settleList} currency={currency} asOf={postingIso} onClose={() => setSettleOpen(false)}
        onApply={(index, settle) => changeRows(linesRef.current.map((l, i) => (i === index ? { ...l, settle, settleSig: settle.length ? settleSig(l, form.getFieldValue('partyCode') as string | null | undefined, currency) : undefined } : l)))} />}
      <Modal open={!!reverse} title="Lập chứng từ đảo" okText="Lập chứng từ đảo" cancelText="Không" destroyOnHidden onCancel={() => setReverse(null)}
        okButtonProps={{ loading: action.isPending, disabled: !reverse?.date }}
        onOk={() => { if (reverse) action.mutate({ act: 'reverse', body: { postingDate: iso(reverse.date), ...(reverse.description.trim() ? { description: reverse.description.trim() } : {}) } }); }}>
        {reverse && <Space direction="vertical" style={{ width: '100%' }}>
          <label htmlFor="reverse-date">Ngày hạch toán chứng từ đảo</label>
          <DatePicker id="reverse-date" format="DD/MM/YYYY" allowClear={false} value={reverse.date} disabledDate={(d) => !!v.data && d.isBefore(dayjs(v.data.postingDate), 'day')}
            onChange={(d) => d && setReverse({ ...reverse, date: d })} />
          <label htmlFor="reverse-desc">Diễn giải chứng từ đảo</label>
          <Input id="reverse-desc" value={reverse.description} maxLength={500} onChange={(e) => setReverse({ ...reverse, description: e.target.value })} />
          <span style={{ color: 'rgba(0,0,0,.45)' }}>Chứng từ đảo ghi sổ ngay; chứng từ gốc chuyển sang trạng thái Đã đảo.</span>
        </Space>}
      </Modal>
    </Card>
  );
}
