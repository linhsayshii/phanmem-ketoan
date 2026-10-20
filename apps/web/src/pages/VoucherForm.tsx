import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Card, Col, DatePicker, Dropdown, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Spin, Tag, Upload, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import type { ColDef } from 'ag-grid-community';
import dayjs, { type Dayjs } from 'dayjs';
import { canTransition, CASH_PURPOSES, D, decideEdit, formatVnDate, formatVnNumber, HEADER_FIELD_LABELS, isBalanced, parseVnNumber, sum, todayVn, VND_AMOUNT_RE, voucherTypeDef,
  type CashPurpose, type HeaderField, type VoucherState, type VoucherTypeDef } from '@kt/domain';
import { KeyboardGrid, LookupSelect, VnNumberInput, useUnsavedChanges } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { accountFetcherFor, bankAccountFetcher, regimeFor, type FiscalYearRef } from '../lookups.js';
import { STATE_LABEL, typeLabel } from './VoucherList.js';

// Các trường *Name chỉ để hiển thị; còn lại (employeeCode, dueDate, extraDims...) được giữ nguyên khi lưu lại để không mất dữ liệu chứng từ lập từ nơi khác.
// amountCurrency (nguyên tệ, có dấu), fxRate và bankAccountNo (tài khoản ngân hàng ghi đè của dòng) chỉ gửi khi có ý nghĩa, xem `linesBody`.
export interface Line { lineNo?: number; accountCode: string; accountName?: string; partyName?: string | null; description: string | null; debit: string; credit: string;
  amountCurrency?: string | undefined; fxRate?: string | undefined; bankAccountNo?: string | null | undefined; partyCode: string | null; departmentCode: string | null; projectCode: string | null; costItemCode: string | null }
interface Voucher { id: string; voucherType: string; voucherNo: string | null; postingDate: string; documentDate: string; state: string; description: string | null; partyCode: string | null;
  personName?: string | null; personAddress?: string | null; attachmentsCount?: number | null; bankAccountNo?: string | null; counterBankAccountNo?: string | null; partyBankAccountNo?: string | null;
  dueDate?: string | null; purpose?: string | null; periodStatus: 'open' | 'soft_locked' | 'hard_locked'; hashed: boolean;
  currencyCode: string; fxRate: string | null; version: number; totalDebit: string; lines: Line[]; warnings?: { code: string; message: string }[] }
interface FormValues { postingDate: Dayjs; documentDate: Dayjs; description?: string | null; partyCode?: string | null; personName?: string | null; personAddress?: string | null; attachmentsCount?: number | null;
  bankAccountNo?: string | null; counterBankAccountNo?: string | null; partyBankAccountNo?: string | null; dueDate?: Dayjs | null; purpose?: string | null; currencyCode?: string; fxRate?: string | null }

// Tên mẫu in trong menu In của loại chứng từ có nhiều mẫu (printForms của loại; mẫu đầu là mẫu mặc định).
const PRINT_FORM_LABELS: Record<string, string> = { '01-TT': 'Phiếu thu', '02-TT': 'Phiếu chi', 'giay-bao': 'Giấy báo ngân hàng', unc: 'Ủy nhiệm chi' };

export const emptyLine = (): Line => ({ accountCode: '', description: null, debit: '0', credit: '0', partyCode: null, departmentCode: null, projectCode: null, costItemCode: null });
export const totals = (lines: Line[]) => ({ debit: sum(lines.map((l) => l.debit || '0')).toString(), credit: sum(lines.map((l) => l.credit || '0')).toString() });
export const cleanLines = (lines: Line[]) => lines.filter((l) => l.accountCode.trim() !== '')
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  .map(({ accountName, partyName, lineNo, ...rest }) => ({ ...rest, debit: rest.debit || '0', credit: rest.credit || '0' }));

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

// Chứng từ đã ghi sổ chỉ sửa được diễn giải và các chiều phân tích của dòng (không đổi số tiền, tài khoản, số dòng).
const META_COLS = ['description', 'departmentCode', 'projectCode', 'costItemCode'];
const LOOKUP_CATALOG: Record<string, string> = { accountCode: 'account', partyCode: 'party', departmentCode: 'department', projectCode: 'project', costItemCode: 'cost_item', bankAccountNo: 'bank_account' };
const quickAdd = [{ key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }];
const iso = (d: Dayjs) => d.format('YYYY-MM-DD');
const text = (s?: string | null) => s?.trim() || null;
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

// Lỗi hiển thị cho người dùng: lỗi máy chủ kèm mã; lỗi form.validateFields() là đối tượng { errorFields } nên lấy chữ lỗi của trường đầu tiên (không để "[object Object]").
const errorText = (e: unknown): string => e instanceof ApiError ? `${e.message} (${e.code})`
  : (e as { errorFields?: { errors: string[] }[] } | null)?.errorFields?.[0]?.errors[0] ?? (e instanceof Error ? e.message : String(e));

// Trường tiêu đề đi vào thân yêu cầu; trường nào loại chứng từ không có thì không gửi.
const HEADER_BODY: Partial<Record<HeaderField, (f: FormValues) => object>> = {
  personName: (f) => ({ personName: text(f.personName) }), personAddress: (f) => ({ personAddress: text(f.personAddress) }), attachmentsCount: (f) => ({ attachmentsCount: f.attachmentsCount ?? null }),
  bankAccount: (f) => ({ bankAccountNo: f.bankAccountNo ?? null }), counterBankAccount: (f) => ({ counterBankAccountNo: f.counterBankAccountNo ?? null }),
  partyBankAccount: (f) => ({ partyBankAccountNo: text(f.partyBankAccountNo) }), dueDate: (f) => ({ dueDate: f.dueDate ? iso(f.dueDate) : null }), purpose: (f) => ({ purpose: f.purpose ?? null }),
};
// Dòng gửi lên: ngoại tệ mới có nguyên tệ; tỷ giá dòng trùng tỷ giá tiêu đề thì để máy chủ lấy theo tiêu đề; tài khoản ngân hàng dòng để trống thì máy chủ lấy theo tiêu đề.
const linesBody = (rows: Line[], f: FormValues) => cleanLines(rows).map(({ amountCurrency, fxRate, bankAccountNo, ...l }) => ({ ...l,
  ...((f.currencyCode ?? 'VND') !== 'VND' && amountCurrency ? { amountCurrency } : {}),
  ...(fxRate && !(f.fxRate && D(fxRate).eq(f.fxRate)) ? { fxRate } : {}), ...(bankAccountNo ? { bankAccountNo } : {}) }));

const initialLines = (def: VoucherTypeDef): Line[] => (def.moneyKind === 'cash' ? [{ ...emptyLine(), accountCode: '1111' }, emptyLine()] : [emptyLine(), emptyLine()]);
const counterAccountsOf = (p: CashPurpose, regime: string): string[] => p.counterAccounts[regime as keyof CashPurpose['counterAccounts']] ?? p.counterAccounts.TT99;

export default function VoucherPage() {
  const { type, id } = useParams({ strict: false }) as { type: string; id: string };
  const def = voucherTypeDef(type);
  if (!def) return <Alert type="error" showIcon message={`Không có loại chứng từ "${type}"`} />;
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
  const viewOnly = !eff.manual || !!eff.hasItems; // chứng từ hệ thống tự sinh và hóa đơn (lập ở màn hình riêng): chỉ xem và in
  const posted = state === 'posted';
  const decision = posted ? decideEdit({ periodStatus: v.data?.periodStatus ?? 'open', hashed: v.data?.hashed ?? false, change: 'amount', canEditPosted: can('voucher.edit_posted'), canBackdateLocked: can('voucher.backdate_locked') }) : null;
  const editable = state === 'draft' && !viewOnly;
  const metaOnly = posted && !viewOnly && decideEdit({ periodStatus: v.data?.periodStatus ?? 'open', hashed: v.data?.hashed ?? false, change: 'meta', canEditPosted: true, canBackdateLocked: true }) !== 'forbidden';
  const locked = !editable && !metaOnly;

  // Chưa lưu: so các dòng với bản lúc tải/lưu, cộng cờ đã sửa tiêu đề; dùng cho hộp xác nhận trước khi bỏ phần đang nhập.
  const baseline = useRef(JSON.stringify(cleanLines(lines)));
  const [formDirty, setFormDirty] = useState(false); const [rowsDirty, setRowsDirty] = useState(false);
  const confirmIfDirty = useUnsavedChanges((formDirty || rowsDirty) && (editable || metaOnly));
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
    const rows = v.data.lines.map((l) => (derived(l.bankAccountNo) ? { ...l, bankAccountNo: null } : l));
    form.setFieldsValue({ ...v.data, postingDate: dayjs(v.data.postingDate), documentDate: dayjs(v.data.documentDate), dueDate: v.data.dueDate ? dayjs(v.data.dueDate) : null, fxRate: v.data.fxRate });
    const all = v.data.state === 'draft' ? [...rows, emptyLine()] : rows;
    baseline.current = JSON.stringify(cleanLines(all)); lastCash.current = (cashSide && all[0]?.[cashSide]) || '0'; lastParty.current = v.data.partyCode;
    setAllLines(all); setFormDirty(false); setRowsDirty(false);
  }, [v.data, form, setAllLines, cashSide]);
  const postingDate = Form.useWatch('postingDate', form);
  const postingIso = postingDate?.isValid() ? iso(postingDate) : undefined;
  const currency = Form.useWatch('currencyCode', form) ?? 'VND';
  const bankAccountNo = Form.useWatch('bankAccountNo', form);
  // Tồn quỹ (tiền mặt) hoặc số dư tiền gửi (đã chọn tài khoản ngân hàng) cuối ngày hạch toán; chưa đủ dữ kiện hoặc không xem được thì không hiện.
  const cashAccount = eff.moneyKind === 'cash' ? lines.find((l) => l.accountCode.startsWith('111'))?.accountCode : eff.moneyKind === 'bank' && bankAccountNo ? '112' : undefined;
  const cashBalance = useQuery({ queryKey: ['cash-balance', cashAccount, bankAccountNo, currency, postingIso], enabled: !!cashAccount && !!postingIso && can('voucher.view'), retry: false,
    queryFn: () => api<{ balance: string; balanceCurrency: string }>(`/api/cash/balance?${new URLSearchParams({ accountCode: cashAccount!, asOf: postingIso!, ...(eff.moneyKind === 'bank' && bankAccountNo ? { bankAccountNo } : {}), ...(currency !== 'VND' ? { currency } : {}) })}`) });
  const regime = regimeFor(years.data ?? [], postingIso);
  const accountFetcher = useMemo(() => accountFetcherFor(postingIso), [postingIso]);
  const t = totals(lines); const balanced = isBalanced(cleanLines(lines).map((l) => ({ debit: l.debit, credit: l.credit })));

  const invalidate = (voucherId = id) => Promise.all([qc.invalidateQueries({ queryKey: ['voucher', voucherId] }), qc.invalidateQueries({ queryKey: ['vouchers'] }), qc.invalidateQueries({ queryKey: ['cash-balance'] })]);
  const conflict = useRef<{ destroy(): void } | null>(null);
  const onErr = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') { // người khác đã sửa: không tự tải lại (mất chữ đang nhập), để người dùng chọn
      conflict.current?.destroy();
      conflict.current = Modal.confirm({ title: 'Chứng từ đã được người khác sửa', content: `${e.message}. Tải lại sẽ bỏ phần bạn đang nhập.`, okText: 'Tải lại', cancelText: 'Giữ bản đang nhập', onOk: () => invalidate() });
      return;
    }
    void message.error(errorText(e));
  };
  // Ô đang gõ dở chưa vào state: rời ô để lưới chốt giá trị trước khi lấy dòng (Ctrl+S/F9 khi con trỏ còn trong ô).
  const flushEditing = async () => { (document.activeElement as HTMLElement | null)?.blur(); await new Promise((r) => setTimeout(r, 0)); };
  const body = (f: FormValues) => ({
    voucherType: eff.code, postingDate: iso(f.postingDate), documentDate: iso(f.documentDate), description: f.description ?? null, partyCode: f.partyCode ?? null,
    currencyCode: f.currencyCode ?? 'VND', ...((f.currencyCode ?? 'VND') !== 'VND' && f.fxRate ? { fxRate: f.fxRate } : {}),
    ...Object.assign({}, ...eff.header.map((h) => HEADER_BODY[h]?.(f))), lines: linesBody(linesRef.current, f) });
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
    const meta = linesRef.current.filter((l) => l.lineNo !== undefined).map((l) => ({ lineNo: l.lineNo!, description: l.description, departmentCode: l.departmentCode, projectCode: l.projectCode, costItemCode: l.costItemCode }));
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
      setFormDirty(false); setRowsDirty(false); // đã lưu: chuyển trang không hỏi bỏ thay đổi
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

  const columns = useMemo<ColDef<Line>[]>(() => ([
    { field: 'accountCode', headerName: 'TK (F4)', width: 110 }, { field: 'description', headerName: 'Diễn giải', flex: 1 },
    numCol('debit', 'Nợ'), numCol('credit', 'Có'),
    ...(currency !== 'VND' ? [foreignCol] : []),
    { field: 'partyCode', headerName: 'Đối tượng (F4)', width: 130 }, { field: 'departmentCode', headerName: 'Bộ phận', width: 100 },
    { field: 'projectCode', headerName: 'Vụ việc', width: 100 }, { field: 'costItemCode', headerName: 'Khoản mục', width: 110 },
    ...(eff.moneyKind === 'bank' ? [{ field: 'bankAccountNo', headerName: 'TK ngân hàng (F4)', width: 150, headerTooltip: 'Để trống là lấy theo tài khoản ngân hàng ở tiêu đề' } satisfies ColDef<Line>] : []),
  ] satisfies ColDef<Line>[]).map((c) => ({ ...c, editable: editable || (metaOnly && META_COLS.includes(c.field as string)) })), [editable, metaOnly, currency, eff.moneyKind]);
  // Chứng từ đã ghi sổ: không thêm/xóa dòng (lineNo của máy chủ phải khớp).
  const onRowsChange = useCallback((rows: Line[]) => { if (editable || rows.length === linesRef.current.length) changeRows(rows); }, [editable, changeRows]);
  const onLookup = useCallback((col: string, row: number) => { if (col in LOOKUP_CATALOG && (editable || (metaOnly && META_COLS.includes(col)))) setLookup({ col, row }); }, [editable, metaOnly]);

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

  if (mismatch) return <Spin />; // đang chuyển sang đường dẫn đúng loại của chứng từ
  return (
    <Card title={<Space><span>{typeLabel(eff)} {v.data?.voucherNo ?? (isNew ? '(mới)' : '(chưa cấp số)')}</span><Tag>{STATE_LABEL[state]}</Tag></Space>}
      extra={<Space>
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
      <KeyboardGrid<Line> rows={lines} columns={columns} readOnly={locked} lockRows={metaOnly} onRowsChange={onRowsChange} addRowTemplate={emptyLine} onLookup={onLookup} height={360} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 8 }}>
        <b>Tổng Nợ: {formatVnNumber(t.debit)}</b><b>Tổng Có: {formatVnNumber(t.credit)}</b>
        {!balanced && <Tag color="red">Chênh lệch {formatVnNumber(sum([t.debit, `-${t.credit}`]).toString())}</Tag>}
      </div>
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
          {...(lookup.col === 'accountCode' ? { fetcher: accountFetcher } : lookup.col === 'bankAccountNo' ? { fetcher: bankAccountFetcher } : { quickAddFields: quickAdd })}
          onChange={(code) => { if (code !== null) { const copy = [...linesRef.current]; copy[lookup.row] = { ...copy[lookup.row]!, [lookup.col]: code }; changeRows(copy); } setLookup(null); }} /></div>}
      </Modal>
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

function Attachments({ voucherId, canEdit }: { voucherId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const key = ['attachments', voucherId];
  const list = useQuery({ queryKey: key, queryFn: () => api<{ id: string; fileName: string; bytes: number }[]>(`/api/vouchers/${voucherId}/attachments`) });
  const remove = (attId: string) => api(`/api/attachments/${attId}`, { method: 'DELETE' }).then(() => qc.invalidateQueries({ queryKey: key })).catch((e: unknown) => void message.error((e as Error).message));
  return (
    <div style={{ marginTop: 16 }}>
      <Space wrap>
        <b>Đính kèm:</b>
        {(list.data ?? []).map((a) => <span key={a.id}><a href={`/api/attachments/${a.id}`} target="_blank" rel="noopener">{a.fileName}</a> ({Math.ceil(a.bytes / 1024)} KB)
          {canEdit && <Popconfirm title="Xóa tệp đính kèm?" okText="Xóa" cancelText="Không" onConfirm={() => remove(a.id)}><Button type="link" size="small" danger aria-label={`Xóa ${a.fileName}`}>✕</Button></Popconfirm>}</span>)}
        {canEdit && <Upload showUploadList={false} customRequest={async ({ file, onSuccess, onError }) => {
          const fd = new FormData(); fd.append('file', file as File);
          const r = await fetch(`/api/vouchers/${voucherId}/attachments`, { method: 'POST', body: fd, credentials: 'include' });
          if (r.ok) { onSuccess?.(await r.json()); void qc.invalidateQueries({ queryKey: key }); }
          else { const e = (await r.json().catch(() => null)) as { error?: { message?: string } } | null; const msg = e?.error?.message ?? `Lỗi tải lên (${r.status})`; void message.error(msg); onError?.(new Error(msg)); } }}><Button size="small">Thêm tệp</Button></Upload>}
      </Space>
    </div>
  );
}
