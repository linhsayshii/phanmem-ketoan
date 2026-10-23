import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, DatePicker, Form, Input, Modal, Row, Select, Space, Spin, Table, Tabs, Tag, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ColDef } from 'ag-grid-community';
import dayjs, { type Dayjs } from 'dayjs';
import { canTransition, D, decideEdit, formatVnDate, formatVnNumber, parseVnNumber, sum, todayVn, VND_AMOUNT_RE, voucherTypeDef, type VoucherState, type VoucherTypeDef } from '@kt/domain';
import { KeyboardGrid, LookupSelect, VnNumberInput, useUnsavedChanges, type LookupRow } from '@kt/ui';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth.js';
import { assetPick, isAssetAccount, accountFetcherFor } from '../lookups.js';
import { STATE_LABEL, typeLabel } from './VoucherList.js';
import { Attachments, PickDialog, groupFetcher, iso, quickAdd, reportError, taxFetcher, text, useInvoiceGroups, useTaxDefs } from './voucherCommon.js';
import { codesOf, defaultGroup, deriveRow, emptyInvRow, importLedger, isBlankRow, NO_PREVIEW, NUM_RE, previewInvoice, snapOf, type InvRow, type RowSnap } from './invoiceCalc.js';

// Hóa đơn mua/bán dịch vụ và giảm giá, trả lại (HDM, HDB, GGM, GGB): lập ở màn hình riêng, gọi /api/invoices.
// Thuế và bút toán xem trước tính ngay trên màn hình bằng chính hàm của @kt/domain mà máy chủ dùng khi lưu (xem invoiceCalc.ts).
interface ItemDto { lineNo: number; description: string | null; quantity: string | null; unitPrice: string | null; amountCurrency: string; discountRate: string | null; discountAmountCurrency: string;
  taxCodes: string[]; accountCode: string; assetCode?: string | null; departmentCode: string | null; projectCode: string | null; costItemCode: string | null;
  id?: number; itemCode?: string | null; uomCode?: string | null; warehouseCode?: string | null; lotNo?: string | null; expiryDate?: string | null; receiptVoucherId?: string | null; linkLineId?: number | null;
  importMode?: boolean; importTax?: string | null; specialConsumptionTax?: string | null; vatImport?: string | null; vatImportCode?: string | null; vatImportBase?: string | null }
interface InvoiceRef { id: number; formNo: string | null; serial: string | null; invoiceNo: string; invoiceDate: string; partyName: string | null; partyTaxCode: string | null; partyAddress: string | null;
  invoiceGroupCode: string | null; headerGroupCode?: string | null; taxCode: string | null; taxAmount: string; adjustsInvoiceId: number | null }
interface InvoiceDoc { id: string; voucherType: string; voucherNo: string | null; state: string; postingDate: string; documentDate: string; description: string | null; partyCode: string | null; partyName: string | null;
  dueDate: string | null; currencyCode: string; fxRate: string | null; version: number; periodStatus: 'open' | 'soft_locked' | 'hard_locked'; hashed: boolean; receiptState?: StockMode | null; invoices: InvoiceRef[]; items: ItemDto[]; lines?: { employeeCode?: string | null }[]; warnings?: { code: string; message: string }[] }
interface FormValues { employeeCode?: string | null; postingDate: Dayjs; documentDate: Dayjs; partyCode?: string | null; currencyCode?: string; fxRate?: string | null; dueDate?: Dayjs | null; description?: string | null;
  formNo?: string | null; serial?: string | null; invoiceNo?: string; invoiceDate: Dayjs; invoiceGroupCode?: string }
// Đối tượng đã chọn: tên, mã số thuế, địa chỉ lấy từ danh mục (máy chủ cũng chụp ba trường này lúc lưu). defaultAccount: undefined là chưa biết (chứng từ vừa tải), null là đối tượng không đặt tài khoản công nợ.
type StockMode = 'through_stock' | 'goods_first' | 'invoice_first';
const STOCK_MODE_LABEL: Record<StockMode, string> = { through_stock: 'Nhập kho cùng hóa đơn', goods_first: 'Hàng về trước, hóa đơn về sau', invoice_first: 'Hóa đơn về trước, hàng về sau' };
interface PartyInfo { code: string; name: string; taxCode: string; address: string; defaultAccount: string | null | undefined }
type PartyRow = LookupRow & { tax_code?: string | null; address?: string | null; default_account_code?: string | null };
interface ListRow { id: string; voucherType: string; voucherNo: string | null; postingDate: string; partyName: string | null }

const BLANK_SNAP: RowSnap = snapOf(emptyInvRow());
const LOOKUP_CATALOG: Record<string, string> = { accountCode: 'account', taxCodes: 'tax_code', departmentCode: 'department', projectCode: 'project', costItemCode: 'cost_item', itemCode: 'item', uomCode: 'uom', warehouseCode: 'warehouse', vatImportCode: 'tax_code', assetCode: 'asset' };

// Dòng công nợ đối ứng như máy chủ: tài khoản mặc định của đối tượng nếu thuộc nhóm 131 (bán) / 331 (mua), không thì 131 / 331.
const counterOf = (scope: 'sale' | 'purchase', p: PartyInfo | null): string => { const prefix = scope === 'sale' ? '131' : '331'; return p?.defaultAccount?.startsWith(prefix) ? p.defaultAccount : prefix; };
const plain = (s: string | null | undefined): string => (s == null ? '' : D(s).toFixed()); // "10.0000" -> "10"
const rowOf = (it: ItemDto): InvRow => ({ description: it.description ?? '', accountCode: it.accountCode, quantity: plain(it.quantity), unitPrice: plain(it.unitPrice), amount: plain(it.amountCurrency),
  discountRate: plain(it.discountRate), discount: D(it.discountAmountCurrency).isZero() ? '' : plain(it.discountAmountCurrency), taxCodes: it.taxCodes.join(','), taxAmount: '',
  assetCode: it.assetCode ?? '', departmentCode: it.departmentCode ?? '', projectCode: it.projectCode ?? '', costItemCode: it.costItemCode ?? '',
  itemCode: it.itemCode ?? '', uomCode: it.itemCode ? it.uomCode ?? '' : '', warehouseCode: it.warehouseCode ?? '', lotNo: it.lotNo ?? '', expiryDate: it.expiryDate ?? '', sourceLineId: it.linkLineId ? String(it.linkLineId) : '',
  importTax: plain(it.importTax), specialConsumptionTax: plain(it.specialConsumptionTax), vatImport: plain(it.vatImport), vatImportCode: it.vatImportCode ?? '', vatImportBase: plain(it.vatImportBase) });
const money = (v: string): string => (D(v).isZero() ? '' : formatVnNumber(v, D(v).decimalPlaces()));

// Ô số của lưới: nhập theo định dạng Việt Nam (1.000.000,5), để trống là chưa nhập, chữ sai hoặc quá giới hạn thì giữ giá trị cũ.
const numCol = (field: keyof InvRow, headerName: string, ok: (n: string) => boolean, extra: Partial<ColDef<InvRow>> = {}): ColDef<InvRow> => ({ field, headerName, width: 120, cellClass: 'ag-right-aligned-cell', cellEditorParams: { useFormatter: true },
  valueFormatter: (p) => { const s = p.value as string | undefined; return s ? formatVnNumber(s, D(s).decimalPlaces()) : ''; },
  valueParser: (p) => { const t = String(p.newValue ?? '').trim(); if (t === '') return ''; const n = parseVnNumber(t); return n !== null && ok(n) ? n : p.oldValue; }, ...extra });
const RATE_RE = /^\d{1,3}(\.\d{1,4})?$/;

export default function InvoiceEditor({ def, id }: { def: VoucherTypeDef; id: string }) {
  const isNew = id === 'moi';
  const navigate = useNavigate(); const qc = useQueryClient(); const { can } = useAuth();
  const [form] = Form.useForm<FormValues>();
  const [rows, setRows] = useState<InvRow[]>(() => [emptyInvRow()]);
  const rowsRef = useRef(rows); // bản mới nhất, đọc đồng bộ khi lưu
  const snaps = useRef(new WeakMap<InvRow, RowSnap>()); // lưới ghi thẳng vào đối tượng dòng nên giá trị dẫn xuất so với bản chụp ở lần trước, không so được với bản cũ của mảng
  const [declared, setDeclared] = useState<Record<string, string>>({});
  const [party, setParty] = useState<PartyInfo | null>(null);
  const [stockMode, setStockMode] = useState<StockMode>('through_stock'); const [receiptIds, setReceiptIds] = useState<string[]>([]); // MH: cách nhận hàng; hàng về trước thì các phiếu nhập kho đã nhận
  const [exportMode, setExportMode] = useState(false); // BH, TLB: hàng xuất khẩu, thuế GTGT 0%
  const [importMode, setImportMode] = useState(false); // MH: hàng nhập khẩu, dòng hàng có thuế NK, TTĐB, GTGT hàng nhập theo tờ khai
  const [adjusts, setAdjusts] = useState<number | null>(null); // giảm giá, trả lại: id dòng hóa đơn gốc (voucher_invoice)
  const [origVoucher, setOrigVoucher] = useState<string | null>(null); const [origInvoices, setOrigInvoices] = useState<InvoiceRef[]>([]);
  const [lookup, setLookup] = useState<{ col: string; row: number } | null>(null);
  const [reverse, setReverse] = useState<{ date: Dayjs; description: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [idempotencyKey] = useState(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`); // bấm lưu hai lần liền khi tạo mới không sinh hai chứng từ
  const live = useRef({ declared, adjusts, party }); live.current = { declared, adjusts, party }; // đọc sau khi chờ ô đang sửa chốt giá trị

  const v = useQuery({ queryKey: ['invoice', id], queryFn: () => api<InvoiceDoc>(`/api/invoices/${id}`), enabled: !isNew });
  const defsQ = useTaxDefs(); const groupsQ = useInvoiceGroups();
  const realType = v.data?.voucherType;
  const eff = (realType ? voucherTypeDef(realType) : undefined) ?? def;
  const mismatch = !!realType && realType !== def.code && !!voucherTypeDef(realType);
  useEffect(() => { if (mismatch) void navigate({ to: '/chung-tu/$type/$id', params: { type: realType!, id }, replace: true }); }, [mismatch, realType, id, navigate]);
  const scope = eff.invoiceDirection ?? 'sale'; const refund = !!eff.refund;
  const isMH = eff.code === 'MH'; const isSaleGoods = eff.code === 'BH' || eff.code === 'TLB'; const goodsDoc = isMH || eff.code === 'TLM' || isSaleGoods; // chứng từ có dòng hàng nhập, xuất kho
  const state = (v.data?.state ?? 'draft') as VoucherState;
  const editable = state === 'draft';
  const posted = state === 'posted';
  const decision = posted ? decideEdit({ periodStatus: v.data?.periodStatus ?? 'open', hashed: v.data?.hashed ?? false, change: 'amount', canEditPosted: can('voucher.edit_posted'), canBackdateLocked: can('voucher.backdate_locked') }) : null;
  const confirmIfDirty = useUnsavedChanges(dirty && editable);

  const currency = Form.useWatch('currencyCode', form) ?? 'VND'; const fxRate = Form.useWatch('fxRate', form) ?? null;
  const postingDate = Form.useWatch('postingDate', form); const postingIso = postingDate?.isValid() ? iso(postingDate) : undefined;
  const isVnd = currency === 'VND';
  const cur = useQuery({ queryKey: ['currency', currency], enabled: !isVnd, queryFn: async () => (await api<{ rows: { code: string; minor_unit: number }[] }>(`/api/catalogs/currency?q=${encodeURIComponent(currency)}&size=20`)).rows });
  const minorUnit = isVnd ? undefined : cur.data?.find((c) => c.code === currency)?.minor_unit;
  const dp = isVnd ? 0 : minorUnit ?? 2;

  const setAll = useCallback((next: InvRow[]) => { rowsRef.current = next; setRows(next); }, []);
  // Mọi thay đổi dòng do người dùng thực hiện đi qua đây: dẫn xuất thành tiền, chiết khấu tại chỗ rồi báo mảng mới.
  const changeRows = useCallback((next: InvRow[]) => {
    // deriveRow chạy cả ở đây (dán, thêm dòng) lẫn ở valueSetter của cột (sửa ô); hai nơi dùng chung snaps nên tính lại một lần là đủ
    for (const r of next) { deriveRow(r, snaps.current.get(r) ?? BLANK_SNAP, dp); snaps.current.set(r, snapOf(r)); }
    setAll(next); setDirty(true);
  }, [dp, setAll]);

  // Tải chứng từ có sẵn vào form và lưới.
  useEffect(() => {
    const d = v.data; if (!d) return;
    const inv = d.invoices[0]; const headerGroup = inv?.headerGroupCode ?? inv?.invoiceGroupCode; // nhóm đầu hóa đơn đã lưu; hóa đơn cũ không có thì nhóm dòng đầu
    form.setFieldsValue({ postingDate: dayjs(d.postingDate), documentDate: dayjs(d.documentDate), partyCode: d.partyCode, currencyCode: d.currencyCode, fxRate: d.fxRate, dueDate: d.dueDate ? dayjs(d.dueDate) : null, description: d.description,
      formNo: inv?.formNo ?? '', serial: inv?.serial ?? '', invoiceNo: inv?.invoiceNo ?? '', invoiceDate: dayjs(inv?.invoiceDate ?? d.documentDate), ...(headerGroup ? { invoiceGroupCode: headerGroup } : {}), employeeCode: d.lines?.find((l) => l.employeeCode)?.employeeCode ?? null });
    const loaded = d.items.map(rowOf); for (const r of loaded) snaps.current.set(r, snapOf(r));
    setAll(d.state === 'draft' ? [...loaded, emptyInvRow()] : loaded);
    setParty(d.partyCode ? { code: d.partyCode, name: inv?.partyName ?? d.partyName ?? '', taxCode: inv?.partyTaxCode ?? '', address: inv?.partyAddress ?? '', defaultAccount: undefined } : null);
    setStockMode(d.receiptState ?? 'through_stock'); setReceiptIds([...new Set(d.items.flatMap((i) => (i.receiptVoucherId ? [i.receiptVoucherId] : [])))]);
    setImportMode(d.items.some((i) => i.importMode));
    setAdjusts(inv?.adjustsInvoiceId ?? null); setOrigVoucher(null); setOrigInvoices([]);
    setDeclared({}); seeded.current = false; setDirty(false);
  }, [v.data, form, setAll]);
  // Tài khoản công nợ mặc định của đối tượng chứng từ vừa tải (chưa biết): tra danh mục một lần để bút toán xem trước dùng đúng 131/331 của đối tượng.
  const needAccount = party !== null && party.defaultAccount === undefined;
  const partyAcct = useQuery({ queryKey: ['party-account', party?.code], enabled: needAccount, queryFn: async () => (await api<{ rows: PartyRow[] }>(`/api/catalogs/party?q=${encodeURIComponent(party!.code)}&size=20`)).rows });
  useEffect(() => {
    const hit = partyAcct.data?.find((r) => r.code === party?.code);
    if (hit && party && party.defaultAccount === undefined) setParty({ ...party, defaultAccount: hit.default_account_code ?? null });
  }, [partyAcct.data, party]);

  const stockAcct = isMH && stockMode === 'invoice_first' ? '151' : '156';
  // Xem trước thuế và bút toán; chưa có danh mục thuế hoặc ngoại tệ chưa có tỷ giá thì chưa tính.
  const preview = useMemo(() => {
    if (!defsQ.data || (!isVnd && !fxRate)) return { ...NO_PREVIEW, lineTax: rows.map(() => '') };
    return previewInvoice({ scope, documentType: refund ? 'refund' : 'invoice', defs: defsQ.data, rows, currency, fxRate: isVnd ? null : fxRate, minorUnit, partyCode: party?.code ?? '', counterAccountCode: counterOf(scope, party), declared,
      ...(goodsDoc ? { stockAccount: stockAcct } : {}) });
  }, [defsQ.data, rows, scope, refund, currency, isVnd, fxRate, minorUnit, party, declared, goodsDoc, stockAcct]);
  const ledgerRows = useMemo(() => (isMH && importMode && preview.ledger.length ? [...preview.ledger, ...importLedger(rows, stockAcct)] : preview.ledger), [isMH, importMode, preview.ledger, rows, stockAcct]);
  // Tiền thuế của dòng là cột tự tính: ghi tại chỗ (đổi đối tượng dòng thì lưới hủy ô đang sửa); cột chỉ vẽ lại khi mảng đổi nên báo mảng mới khi có giá trị đổi.
  useEffect(() => {
    let changed = false;
    rows.forEach((r, i) => { const t = preview.lineTax[i] ?? ''; if (r.taxAmount !== t) { r.taxAmount = t; changed = true; } });
    if (changed) setAll([...rows]);
  }, [preview, rows, setAll]);
  // Chứng từ đã lưu không trả lại số thuế ghi trên hóa đơn: nếu tổng thuế đã lưu theo mã khác số tính lại thì đó là số người lập đã nhập, điền lại để lưu tiếp không làm mất.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !v.data || !preview.byCode.length) return;
    seeded.current = true;
    const stored: Record<string, string> = {};
    for (const i of v.data.invoices) if (i.taxCode) stored[i.taxCode] = sum([stored[i.taxCode] ?? '0', i.taxAmount]).toFixed();
    const seed = Object.fromEntries(preview.byCode.flatMap((c) => (stored[c.code] !== undefined && stored[c.code] !== c.computed ? [[c.code, stored[c.code]!]] : [])));
    if (Object.keys(seed).length) setDeclared(seed);
  }, [v.data, preview.byCode]);

  // Nhóm kê khai mặc định theo mã thuế GTGT đầu tiên; chỉ điền khi ô còn trống hoặc còn là số do lần điền trước đặt (người dùng đã chọn thì giữ).
  const autoGroup = useRef<string>();
  useEffect(() => {
    if (!editable || !defsQ.data || !groupsQ.data) return;
    const g = defaultGroup(scope, rows.flatMap((r) => [...codesOf(r), ...(r.vatImportCode.trim() ? [r.vatImportCode.trim()] : [])]), defsQ.data, groupsQ.data); // hàng nhập khẩu: theo mã GTGT hàng nhập
    const curGroup = form.getFieldValue('invoiceGroupCode') as string | undefined;
    if (g && (!curGroup || curGroup === autoGroup.current)) { autoGroup.current = g; form.setFieldsValue({ invoiceGroupCode: g }); }
  }, [rows, defsQ.data, groupsQ.data, scope, editable, form]);

  const accountFetcher = useMemo(() => accountFetcherFor(postingIso), [postingIso]);
  const taxes = useMemo(() => taxFetcher(defsQ.data ?? [], scope), [defsQ.data, scope]);
  const vatTaxes = useMemo(() => taxFetcher(defsQ.data ?? [], 'purchase', true), [defsQ.data]);
  const groupsOf = useMemo(() => groupFetcher(groupsQ.data ?? [], scope), [groupsQ.data, scope]);

  const invalidate = (voucherId = id) => Promise.all([qc.invalidateQueries({ queryKey: ['invoice', voucherId] }), qc.invalidateQueries({ queryKey: ['voucher', voucherId] }), qc.invalidateQueries({ queryKey: ['vouchers'] })]);
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
  const itemsBody = () => rowsRef.current.flatMap((r, k) => {
    if (isBlankRow(r)) return [];
    const goodsLine = goodsDoc && !!r.itemCode.trim();
    if (goodsLine && !r.uomCode.trim()) throw new Error(`Dòng ${k + 1}: chọn đơn vị tính`);
    if (goodsLine && !r.quantity) throw new Error(`Dòng ${k + 1}: nhập số lượng`);
    const imp = isMH && importMode && goodsLine;
    if (imp && D(r.vatImport || '0').gt(0) && !r.vatImportCode.trim()) throw new Error(`Dòng ${k + 1}: chọn mã thuế GTGT hàng nhập`);
    if (goodsLine && ((isMH && stockMode === 'through_stock') || (!isMH && r.sourceLineId.trim())) && !r.warehouseCode.trim()) throw new Error(`Dòng ${k + 1}: chọn kho`);
    if (!goodsLine && !r.accountCode.trim()) throw new Error(`Dòng ${k + 1}: chọn tài khoản`);
    if (!r.amount) throw new Error(`Dòng ${k + 1}: nhập thành tiền`);
    return [{ description: text(r.description), ...(goodsLine ? {} : { accountCode: r.accountCode.trim() }), amountCurrency: r.amount, discountCurrency: r.discount || '0', taxCodes: codesOf(r),
      departmentCode: text(r.departmentCode), projectCode: text(r.projectCode), costItemCode: text(r.costItemCode), ...(!goodsLine && text(r.assetCode) ? { assetCode: text(r.assetCode) } : {}),
      ...(r.quantity ? { quantity: r.quantity } : {}), ...(r.unitPrice ? { unitPrice: r.unitPrice } : {}), ...(r.discountRate ? { discountRate: r.discountRate } : {}),
      ...(goodsLine ? { itemCode: r.itemCode.trim(), uomCode: r.uomCode.trim(), ...(r.warehouseCode.trim() ? { warehouseCode: r.warehouseCode.trim() } : {}), ...(r.lotNo.trim() ? { lotNo: r.lotNo.trim() } : {}),
        ...(r.expiryDate.trim() ? { expiryDate: r.expiryDate.trim() } : {}), ...(r.sourceLineId.trim() ? { sourceLineId: Number(r.sourceLineId) } : {}) } : {}),
      ...(imp ? { importMode: true, ...(r.importTax ? { importTax: r.importTax } : {}), ...(r.specialConsumptionTax ? { specialConsumptionTax: r.specialConsumptionTax } : {}), ...(r.vatImport ? { vatImport: r.vatImport } : {}),
        ...(r.vatImportCode.trim() ? { vatImportCode: r.vatImportCode.trim() } : {}), ...(r.vatImportBase ? { vatImportBase: r.vatImportBase } : {}) } : {}) }];
  });
  const body = (f: FormValues) => {
    const items = itemsBody();
    if (!items.length) throw new Error('Nhập ít nhất một dòng hàng tiền');
    if (isMH && stockMode === 'goods_first' && !receiptIds.length) throw new Error('Chọn phiếu nhập kho của hàng đã về');
    if (eff.code === 'TLB' && rowsRef.current.some((r) => !isBlankRow(r) && !r.sourceLineId.trim())) throw new Error('Hàng bán bị trả lại: nhập mã dòng bán gốc ở mọi dòng');
    if (refund && live.current.adjusts == null) throw new Error('Chọn hóa đơn gốc ở tab Hóa đơn');
    const present = new Set(rowsRef.current.flatMap(codesOf));
    const declaredTax = Object.fromEntries(Object.entries(live.current.declared).filter(([c, s]) => s !== '' && present.has(c)));
    for (const [c, s] of Object.entries(declaredTax)) if (!VND_AMOUNT_RE.test(s)) throw new Error(`Thuế ghi trên hóa đơn ${c}: nhập số tiền nguyên đồng`);
    return { voucherType: eff.code, postingDate: iso(f.postingDate), documentDate: iso(f.documentDate), partyCode: f.partyCode ?? '', currencyCode: f.currencyCode ?? 'VND',
      ...(isSaleGoods && exportMode ? { exportMode: true } : {}), ...(isMH ? { stockMode, ...(stockMode === 'goods_first' ? { receiptVoucherIds: receiptIds } : {}) } : {}),
      ...((f.currencyCode ?? 'VND') !== 'VND' && f.fxRate ? { fxRate: f.fxRate } : {}), ...(f.dueDate ? { dueDate: iso(f.dueDate) } : {}), description: text(f.description), items,
      invoice: { ...(live.current.party ? { partyTaxCode: live.current.party.taxCode.trim(), partyName: live.current.party.name.trim(), partyAddress: live.current.party.address.trim() } : {}), formNo: text(f.formNo), serial: text(f.serial), invoiceNo: (f.invoiceNo ?? '').trim(), invoiceDate: iso(f.invoiceDate), invoiceGroupCode: f.invoiceGroupCode ?? '', ...(f.employeeCode ? { employeeCode: f.employeeCode } : {}),
        ...(refund ? { adjustsInvoiceId: live.current.adjusts } : {}), ...(Object.keys(declaredTax).length ? { declaredTax } : {}) } };
  };
  // Lưu bản đang nhập; ghi sổ (F9) lưu trước rồi mới ghi để không ghi sổ bản cũ trên máy chủ.
  const persist = async (postAfter: boolean): Promise<InvoiceDoc> => {
    await flushEditing();
    const payload = body(await form.validateFields());
    if (isNew) return api<InvoiceDoc>('/api/invoices', { method: 'POST', json: { ...payload, idempotencyKey, ...(postAfter ? { autoPost: true } : {}) } });
    const saved = await api<InvoiceDoc>(`/api/invoices/${id}`, { method: 'PUT', json: { ...payload, version: v.data!.version } });
    if (!postAfter) return saved;
    // đã lưu mà ghi sổ lỗi (kỳ khóa...): tải lại để version khớp với bản vừa lưu, lần Ctrl+S sau không bị VERSION_CONFLICT
    return api<InvoiceDoc>(`/api/vouchers/${id}/post`, { method: 'POST', json: {} }).catch((e: unknown) => { void invalidate(); throw e; });
  };
  const toVoucher = (r: { id: string; voucherType?: string }) => void navigate({ to: '/chung-tu/$type/$id', params: { type: r.voucherType ?? eff.code, id: r.id } });
  const save = useMutation({ mutationFn: (postAfter: boolean) => persist(postAfter), onError: onErr,
    onSuccess: async (r, postAfter) => {
      void message.success(postAfter ? 'Đã ghi sổ' : 'Đã lưu');
      for (const w of r.warnings ?? []) void message.warning({ content: w.message, duration: 10 });
      setDirty(false);
      if (isNew) toVoucher(r);
      await invalidate(r.id);
    } });
  const action = useMutation({ mutationFn: (p: { act: string; body?: object }) => api<InvoiceDoc>(`/api/vouchers/${id}/${p.act}`, { method: 'POST', json: p.body ?? {} }), onError: onErr,
    onSuccess: async (r, p) => { void message.success({ unpost: 'Đã bỏ ghi sổ', reverse: `Đã tạo chứng từ đảo ${r.voucherNo}`, discard: 'Đã hủy' }[p.act] ?? 'Xong');
      if (p.act === 'reverse') { setReverse(null); toVoucher(r); } else await invalidate(); } });

  const ready = isNew || !!v.data;
  const mayEdit = editable && (isNew ? can('voucher.create') : can('voucher.update'));
  const canSave = ready && mayEdit;
  const mayPost = (isNew || canTransition(state, 'post')) && can('voucher.post');
  const canPost = ready && mayPost;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isSave = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's'; const isPost = e.key === 'F9';
      if (!isSave && !isPost) return;
      e.preventDefault(); // chặn hộp "Lưu trang" của trình duyệt
      if ((e.target as Element | null)?.closest?.('.ant-modal-root')) return; // hộp thoại mở: phím tắt không lưu chứng từ phía sau nó
      if (isSave && canSave && !save.isPending) save.mutate(false);
      if (isPost && canPost && canSave && !save.isPending) save.mutate(true);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [save, canSave, canPost]);
  const mayUnpost = canTransition(state, 'unpost') && decision === 'unpost_edit_post' && can('voucher.unpost');
  const mayReverse = canTransition(state, 'reverse') && decision !== 'adjust_in_open_period' && can('voucher.post');

  const showAsset = rows.some((r) => isAssetAccount(r.accountCode) || !!r.assetCode);
  const columns = useMemo<ColDef<InvRow>[]>(() => {
    const amountOk = isVnd ? (n: string) => VND_AMOUNT_RE.test(n) : (n: string) => NUM_RE.test(n);
    // Dẫn xuất ngay lúc ghi giá trị ô: Enter mở luôn ô kế (vd. Thành tiền) nên ô đó phải thấy số mới, không đợi cellValueChanged tới trễ.
    const live = (c: ColDef<InvRow>): ColDef<InvRow> => c.editable === false || !c.valueParser ? c : { ...c, valueSetter: (p) => {
      const f = c.field as keyof InvRow; if (p.data[f] === p.newValue) return false;
      p.data[f] = p.newValue as string; deriveRow(p.data, snaps.current.get(p.data) ?? BLANK_SNAP, dp); snaps.current.set(p.data, snapOf(p.data)); return true; } };
    const goodsCols: ColDef<InvRow>[] = !goodsDoc ? [] : [{ field: 'itemCode', headerName: 'Mã hàng (F4)', width: 120 }, { field: 'uomCode', headerName: 'ĐVT (F4)', width: 90 },
      ...(!isMH || stockMode === 'through_stock' ? [{ field: 'warehouseCode', headerName: 'Kho (F4)', width: 100 }, { field: 'lotNo', headerName: 'Số lô', width: 100 }, { field: 'expiryDate', headerName: 'Hạn dùng (YYYY-MM-DD)', width: 150 }] satisfies ColDef<InvRow>[] : []),
      ...(!isMH && eff.code !== 'BH' ? [{ field: 'sourceLineId', headerName: isSaleGoods ? 'Mã dòng bán gốc' : 'Mã dòng nhập gốc', width: 130, headerTooltip: isSaleGoods ? 'Hàng bán bị trả lại: mã dòng hóa đơn bán gốc (bắt buộc, xem ở chi tiết hóa đơn bán)' : 'Trả lại hàng: mã dòng phiếu nhập gốc (xem ở chi tiết phiếu nhập); để trống nếu chỉ giảm giá' }] satisfies ColDef<InvRow>[] : [])];
    return ([
      { field: 'description', headerName: 'Diễn giải', flex: 1, minWidth: 160 },
      ...goodsCols,
      { field: 'accountCode', headerName: goodsDoc ? 'TK (để trống: theo hàng)' : scope === 'sale' ? 'TK doanh thu (F4)' : 'TK chi phí (F4)', width: 140 },
      numCol('quantity', 'Số lượng', (n) => NUM_RE.test(n), { width: 100 }), numCol('unitPrice', 'Đơn giá', (n) => NUM_RE.test(n)),
      numCol('amount', 'Thành tiền', amountOk, { width: 130 }), numCol('discountRate', '% chiết khấu', (n) => RATE_RE.test(n) && D(n).lte(100), { width: 110 }), numCol('discount', 'Tiền chiết khấu', amountOk),
      { field: 'taxCodes', headerName: 'Mã thuế (F4)', width: 120, headerTooltip: isMH && importMode ? 'Hàng nhập khẩu không ghi mã thuế GTGT trên dòng: nhập ở cột thuế GTGT hàng nhập' : 'Nhiều mã cách nhau bằng dấu phẩy' },
      numCol('taxAmount', 'Tiền thuế', () => false, { editable: false, headerTooltip: 'Tự tính theo mã thuế, không nhập' }),
      ...(isMH && importMode ? [numCol('importTax', 'Thuế NK (đồng)', (n) => VND_AMOUNT_RE.test(n), { width: 130, headerTooltip: 'Thuế nhập khẩu theo tờ khai hải quan' }),
        numCol('specialConsumptionTax', 'Thuế TTĐB (đồng)', (n) => VND_AMOUNT_RE.test(n), { width: 140, headerTooltip: 'Thuế tiêu thụ đặc biệt hàng nhập khẩu theo tờ khai' }),
        numCol('vatImport', 'Thuế GTGT hàng NK (đồng)', (n) => VND_AMOUNT_RE.test(n), { width: 170, headerTooltip: 'Thuế GTGT hàng nhập khẩu theo tờ khai (Nợ 1331 / Có 33312)' }),
        { field: 'vatImportCode', headerName: 'Mã thuế GTGT NK (F4)', width: 160 },
        numCol('vatImportBase', 'Giá tính thuế GTGT NK (đồng)', (n) => VND_AMOUNT_RE.test(n), { width: 190, headerTooltip: 'Theo tờ khai hải quan; để trống: tiền hàng quy đổi + thuế NK + thuế TTĐB' })] satisfies ColDef<InvRow>[] : []),
      // Hóa đơn không có cột Khế ước: API hóa đơn không nhận khế ước ở dòng; khế ước vay (341x, 335) nhập ở phiếu kế toán, giấy báo.
      ...(!goodsDoc && showAsset ? [{ field: 'assetCode', headerName: 'Tài sản (F4)', width: 130, editable: (p) => isAssetAccount(p.data?.accountCode ?? '') } satisfies ColDef<InvRow>] : []),
      { field: 'departmentCode', headerName: 'Bộ phận', width: 100 }, { field: 'projectCode', headerName: 'Vụ việc', width: 100 }, { field: 'costItemCode', headerName: 'Khoản mục', width: 110 },
    ] satisfies ColDef<InvRow>[]).map(live);
  }, [scope, isVnd, dp, goodsDoc, isMH, isSaleGoods, stockMode, importMode, showAsset]);
  const onLookup = useCallback((col: string, row: number) => { if (col in LOOKUP_CATALOG && editable && (col !== 'assetCode' || isAssetAccount(rowsRef.current[row]?.accountCode ?? ''))) setLookup({ col, row }); }, [editable]);
  const pick = (code: string) => { // đổi đối tượng dòng (không ghi tại chỗ): ô đang sửa phía sau hộp thoại bị hủy, không ghi đè giá trị vừa chọn
    if (!lookup) return;
    const old = rowsRef.current[lookup.row]; if (!old) return;
    const nr = { ...old, [lookup.col]: code }; snaps.current.set(nr, snaps.current.get(old) ?? BLANK_SNAP);
    changeRows(rowsRef.current.map((r, i) => (i === lookup.row ? nr : r)));
  };

  const onPartyChange = (code: string | null, row: LookupRow | null) => {
    const p = row as PartyRow | null;
    setParty(code && p ? { code, name: p.name, taxCode: p.tax_code ?? '', address: p.address ?? '', defaultAccount: p.default_account_code ?? null } : null);
    setAdjusts(null); setOrigVoucher(null); setOrigInvoices([]);
  };
  // Hóa đơn gốc của giảm giá, trả lại: chỉ hóa đơn đã ghi sổ của cùng đối tượng, cùng chiều (GGB -> HDB, GGM -> HDM).
  const origType = eff.code === 'GGB' ? 'HDB' : eff.code === 'TLB' ? 'BH' : eff.code === 'TLM' ? 'MH' : 'HDM';
  const origList = useQuery({ queryKey: ['orig-invoices', origType, party?.code], enabled: refund && editable && !!party?.code,
    queryFn: async () => (await api<{ rows: ListRow[] }>(`/api/vouchers?type=${origType}&state=posted&partyCode=${encodeURIComponent(party!.code)}&size=200`)).rows });
  const pickOrig = async (vid: string) => {
    try {
      const d = await api<InvoiceDoc>(`/api/invoices/${vid}`);
      setOrigVoucher(vid); setOrigInvoices(d.invoices); setAdjusts(d.invoices.length === 1 ? d.invoices[0]!.id : null); setDirty(true);
    } catch (e) { onErr(e); }
  };

  const valid = rows.filter((r) => r.accountCode.trim() && NUM_RE.test(r.amount));
  const goods = sum(valid.map((r) => D(r.amount).minus(r.discount || '0').toFixed())).toFixed();
  const taxTotal = sum(preview.lineTax.filter(Boolean)).toFixed();
  const ledgerDebit = sum(ledgerRows.map((l) => l.debit)).toFixed(); const ledgerCredit = sum(ledgerRows.map((l) => l.credit)).toFixed();
  const fmt = (s: string) => formatVnNumber(s, D(s).decimalPlaces());

  // Dòng hạch toán vào 3387: gợi ý lập lịch phân bổ doanh thu nhận trước (mở tab mới, giữ nguyên hóa đơn đang nhập).
  // Nhiều tài khoản con 3387x: lấy tài khoản có số tiền lớn nhất, tổng số tiền chỉ của tài khoản đó.
  const byDeferred = new Map<string, string>();
  if (isVnd) for (const r of valid) { const c = r.accountCode.trim(); if (c.startsWith('3387')) byDeferred.set(c, sum([byDeferred.get(c) ?? '0', D(r.amount).minus(r.discount || '0').toFixed()]).toFixed()); }
  const [deferredCode, deferred] = [...byDeferred.entries()].sort((x, y) => D(y[1]).cmp(x[1]))[0] ?? ['3387', '0'];
  const amortLink = D(deferred).gt(0) && /^\d{1,16}$/.test(deferred)
    ? `/so-cai/phan-bo?${new URLSearchParams({ from: deferredCode, to: '5113', total: deferred, description: `Phân bổ doanh thu nhận trước ${v.data?.voucherNo ?? ''}`.trim(), ...(isNew ? {} : { voucher: id }) }).toString()}` : null;
  const receiptList = useQuery({ queryKey: ['receipts', party?.code], enabled: isMH && stockMode === 'goods_first' && editable && !!party?.code,
    queryFn: async () => (await api<{ rows: ListRow[] }>(`/api/vouchers?type=PNK&state=posted&partyCode=${encodeURIComponent(party!.code)}&size=200`)).rows });
  const goodsTab = (<>
    {isSaleGoods && <Space style={{ marginBottom: 8 }}><Checkbox disabled={!editable} checked={exportMode} onChange={(e) => { setExportMode(e.target.checked); setDirty(true); }}>Hàng xuất khẩu (thuế GTGT 0%)</Checkbox></Space>}
    {isMH && <Space style={{ marginBottom: 8 }} wrap>
      <Select aria-label="Cách nhận hàng" style={{ width: 280 }} disabled={!editable} value={stockMode} onChange={(m) => { setStockMode(m); setDirty(true); }} options={(Object.keys(STOCK_MODE_LABEL) as StockMode[]).map((m) => ({ value: m, label: STOCK_MODE_LABEL[m] }))} />
      <Checkbox disabled={!editable} checked={importMode} onChange={(e) => { setImportMode(e.target.checked); setDirty(true); }}>Hàng nhập khẩu</Checkbox>
      {stockMode === 'goods_first' && <Select aria-label="Phiếu nhập kho đã nhận" mode="multiple" style={{ minWidth: 360 }} disabled={!editable || !party} placeholder={party ? 'Chọn phiếu nhập kho của hàng đã về' : 'Chọn đối tượng trước'}
        loading={receiptList.isFetching} value={receiptIds} onChange={(ids) => { setReceiptIds(ids); setDirty(true); }} optionFilterProp="label"
        options={(receiptList.data ?? []).map((r) => ({ value: r.id, label: `${r.voucherNo ?? '(nháp)'} - ${formatVnDate(r.postingDate)}` }))} notFoundContent="Không có phiếu nhập kho đã ghi sổ của đối tượng này" />}
    </Space>}
    <KeyboardGrid<InvRow> rows={rows} columns={columns} readOnly={!editable} onRowsChange={changeRows} addRowTemplate={emptyInvRow} onLookup={onLookup} height={300} />
    {amortLink && <div style={{ marginTop: 8 }}>Có dòng hạch toán vào TK 3387: <a href={amortLink} target="_blank" rel="noopener noreferrer">Tạo lịch phân bổ</a></div>}
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 8 }}>
      <span>Tiền hàng (sau chiết khấu): <b>{fmt(goods)}</b></span><span>Tiền thuế: <b>{fmt(taxTotal)}</b></span><b>Cộng: {fmt(sum([goods, taxTotal]).toFixed())}{isVnd ? '' : ` ${currency}`}</b>
    </div>
  </>);
  const taxTab = (
    <Table size="small" rowKey="code" pagination={false} dataSource={preview.byCode} locale={{ emptyText: 'Chưa có dòng nào dùng mã thuế' }} columns={[
      { title: 'Mã thuế', dataIndex: 'code', width: 140, render: (_: unknown, r) => <span>{r.code} <span style={{ color: 'rgba(0,0,0,.45)' }}>{r.name}</span></span> },
      { title: 'Số dòng', dataIndex: 'lines', width: 90, align: 'right' },
      { title: 'Thuế tính (đồng)', dataIndex: 'computed', width: 150, align: 'right', render: (s: string) => formatVnNumber(s) },
      { title: 'Thuế ghi trên hóa đơn (đồng)', width: 230, render: (_: unknown, r) => <VnNumberInput aria-label={`Thuế ghi trên hóa đơn ${r.code}`} disabled={!editable} value={declared[r.code] ?? null}
        onChange={(s) => { setDeclared((d) => ({ ...d, [r.code]: s ?? '' })); setDirty(true); }} /> },
      { title: 'Chênh lệch / dung sai', width: 200, render: (_: unknown, r) => (r.declared === '' ? <span style={{ color: 'rgba(0,0,0,.45)' }}>Chưa nhập</span>
        : <Space size={4}><span>{formatVnNumber(r.diff)} / ±{r.allowed}</span><Tag color={r.ok ? 'green' : 'red'} style={{ marginRight: 0 }}>{r.ok ? 'Trong dung sai' : 'Quá dung sai'}</Tag></Space>) },
    ]} />
  );
  const mst = (
    <Row gutter={12}>
      <Col span={4}><Form.Item label="Mẫu số" name="formNo"><Input maxLength={20} /></Form.Item></Col>
      <Col span={4}><Form.Item label="Ký hiệu" name="serial"><Input maxLength={20} /></Form.Item></Col>
      <Col span={5}><Form.Item label="Số hóa đơn" name="invoiceNo" rules={[{ required: true, whitespace: true, message: 'Nhập số hóa đơn' }]}><Input maxLength={30} /></Form.Item></Col>
      <Col span={5}><Form.Item label="Ngày hóa đơn" name="invoiceDate" rules={[{ required: true, message: 'Nhập ngày hóa đơn' }]}><DatePicker format="DD/MM/YYYY" /></Form.Item></Col>
      <Col span={6}><Form.Item label="Nhóm kê khai (F4)" name="invoiceGroupCode" rules={[{ required: true, message: 'Chọn nhóm kê khai' }]}><LookupSelect catalog="invoice_group" fetcher={groupsOf} /></Form.Item></Col>
      <Col span={6}><Form.Item label="Nhân viên bán hàng (F4)" name="employeeCode"><LookupSelect catalog="employee" allowClear /></Form.Item></Col>
      <Col span={6}><Form.Item label="Mã số thuế" htmlFor="party-tax-code"><Input id="party-tax-code" disabled={!editable || !party} value={party?.taxCode ?? ''} onChange={(e) => { if (party) { setParty({ ...party, taxCode: e.target.value }); setDirty(true); } }} /></Form.Item></Col>
      <Col span={8}><Form.Item label="Tên đơn vị" htmlFor="party-name"><Input id="party-name" disabled={!editable || !party} value={party?.name ?? ''} onChange={(e) => { if (party) { setParty({ ...party, name: e.target.value }); setDirty(true); } }} /></Form.Item></Col>
      <Col span={10}><Form.Item label="Địa chỉ" htmlFor="party-address"><Input id="party-address" disabled={!editable || !party} value={party?.address ?? ''} onChange={(e) => { if (party) { setParty({ ...party, address: e.target.value }); setDirty(true); } }} /></Form.Item></Col>
      {refund && <>
        <Col span={10}><Form.Item label="Hóa đơn gốc" required validateStatus={adjusts == null && dirty ? 'warning' : ''} help={adjusts == null && dirty ? 'Chọn hóa đơn đã ghi sổ của cùng đối tượng' : undefined}>
          <Select showSearch optionFilterProp="label" placeholder={party ? 'Chọn chứng từ gốc' : 'Chọn đối tượng trước'} disabled={!editable || !party} value={origVoucher} loading={origList.isFetching} onChange={(vid) => void pickOrig(vid)}
            options={(origList.data ?? []).map((r) => ({ value: r.id, label: `${r.voucherNo ?? '(nháp)'} - ${formatVnDate(r.postingDate)}` }))} notFoundContent="Không có hóa đơn đã ghi sổ của đối tượng này" /></Form.Item></Col>
        <Col span={8}><Form.Item label="Dòng hóa đơn gốc">
          {origInvoices.length > 1
            ? <Select placeholder="Chọn dòng" disabled={!editable} value={adjusts} onChange={(a) => { setAdjusts(a); setDirty(true); }}
              options={origInvoices.map((i) => ({ value: i.id, label: `${i.invoiceNo} - ${i.taxCode ?? ''}` }))} />
            : <Input readOnly value={adjusts == null ? '' : origInvoices[0] ? `${origInvoices[0].invoiceNo}` : `Hóa đơn gốc #${adjusts}`} />}</Form.Item></Col>
      </>}
    </Row>
  );
  const ledgerTab = (
    <div data-testid="ledger-preview">
      <Table size="small" pagination={false} rowKey="key" locale={{ emptyText: 'Nhập dòng hàng tiền (có tài khoản và thành tiền) để xem bút toán' }} dataSource={ledgerRows.map((l, i) => ({ ...l, key: i }))} columns={[
        { title: 'Tài khoản', dataIndex: 'accountCode', width: 110 }, { title: 'Diễn giải', dataIndex: 'description', render: (s: string | null) => s ?? '' },
        { title: 'Nợ', dataIndex: 'debit', align: 'right', width: 150, render: money }, { title: 'Có', dataIndex: 'credit', align: 'right', width: 150, render: money },
        { title: 'Đối tượng', dataIndex: 'partyCode', width: 130, render: (s: string | null) => s ?? '' },
        ...(isVnd ? [] : [{ title: `Nguyên tệ (${currency})`, dataIndex: 'amountCurrency', align: 'right' as const, width: 150, render: (s: string) => money(s) }]),
      ]} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 8 }}>
        <b>Tổng Nợ: {formatVnNumber(ledgerDebit)}</b><b>Tổng Có: {formatVnNumber(ledgerCredit)}</b>
      </div>
      <div style={{ color: 'rgba(0,0,0,.45)', marginTop: 4 }}>Bút toán xem trước, tính trên màn hình; máy chủ tính lại khi lưu và ghi sổ.</div>
    </div>
  );

  if (mismatch) return <Spin />; // đang chuyển sang đường dẫn đúng loại của chứng từ
  return (
    <Card title={<Space><span>{typeLabel(eff)} {v.data?.voucherNo ?? (isNew ? '(mới)' : '(chưa cấp số)')}</span><Tag>{STATE_LABEL[state]}</Tag></Space>}
      extra={<Space>
        {mayEdit && <Button onClick={() => save.mutate(false)} type="primary" loading={save.isPending} disabled={!ready}>Lưu (Ctrl+S)</Button>}
        {mayEdit && mayPost && <Button onClick={() => save.mutate(true)} disabled={!ready || save.isPending}>Ghi sổ (F9)</Button>}
        {!isNew && mayUnpost && <Button onClick={() => confirmIfDirty(() => action.mutate({ act: 'unpost' }))}>Bỏ ghi sổ</Button>}
        {!isNew && mayReverse && v.data && <Button onClick={() => confirmIfDirty(() => { const p = v.data!.postingDate; const today = todayVn(); setReverse({ date: dayjs(today >= p ? today : p), description: `Đảo chứng từ ${v.data!.voucherNo} ngày ${formatVnDate(p)}` }); })}>Đảo</Button>}
        {!isNew && editable && canTransition(state, 'discard') && can('voucher.delete') && <Button danger onClick={() => Modal.confirm({ title: 'Hủy chứng từ?', content: 'Số chứng từ (nếu có) được giữ lại.', onOk: () => action.mutate({ act: 'discard' }) })}>Hủy</Button>}
        {!isNew && can('voucher.print') && <Button href={`/api/vouchers/${id}/print?format=pdf`} target="_blank">In</Button>}
      </Space>}>
      {v.error && <Alert type="error" showIcon message={(v.error as Error).message} style={{ marginBottom: 12 }} />}
      {preview.error && <Alert type="error" showIcon message={`${preview.error.message} (${preview.error.code})`} style={{ marginBottom: 12 }} />}
      <Form form={form} layout="vertical" disabled={!editable} onValuesChange={() => setDirty(true)}
        initialValues={{ postingDate: dayjs(todayVn()), documentDate: dayjs(todayVn()), invoiceDate: dayjs(todayVn()), currencyCode: 'VND' }}>
        <Row gutter={12}>
          <Col span={4}><Form.Item label="Ngày hạch toán" name="postingDate" rules={[{ required: true, message: 'Nhập ngày hạch toán' }]}><DatePicker format="DD/MM/YYYY" /></Form.Item></Col>
          <Col span={4}><Form.Item label="Ngày chứng từ" name="documentDate" rules={[{ required: true, message: 'Nhập ngày chứng từ' }]}><DatePicker format="DD/MM/YYYY" /></Form.Item></Col>
          <Col span={8}><Form.Item label="Đối tượng" name="partyCode" rules={[{ required: true, message: 'Chọn đối tượng' }]}><LookupSelect catalog="party" quickAddFields={quickAdd} onChange={onPartyChange} /></Form.Item></Col>
          <Col span={4}><Form.Item label="Loại tiền" name="currencyCode"><LookupSelect catalog="currency" /></Form.Item></Col>
          {!isVnd && <Col span={4}><Form.Item label="Tỷ giá" name="fxRate" rules={[{ required: true, message: 'Nhập tỷ giá' }]}><VnNumberInput scale={10} /></Form.Item></Col>}
          <Col span={4}><Form.Item label="Hạn thanh toán" name="dueDate"><DatePicker format="DD/MM/YYYY" /></Form.Item></Col>
          <Col span={24}><Form.Item label="Diễn giải" name="description"><Input /></Form.Item></Col>
        </Row>
        <Tabs size="small" items={[
          { key: 'goods', label: 'Hàng tiền', forceRender: true, children: goodsTab }, { key: 'tax', label: 'Thuế', forceRender: true, children: taxTab },
          { key: 'invoice', label: 'Hóa đơn', forceRender: true, children: mst }, { key: 'ledger', label: 'Hạch toán', forceRender: true, children: ledgerTab },
        ]} />
      </Form>
      {!isNew && <Attachments voucherId={id} canEdit={can('voucher.update')} />}
      <PickDialog open={!!lookup} catalog={lookup ? LOOKUP_CATALOG[lookup.col]! : 'account'} withQuickAdd={!!lookup && ['departmentCode', 'projectCode', 'costItemCode'].includes(lookup.col)}
        {...(lookup?.col === 'accountCode' ? { fetcher: accountFetcher } : lookup?.col === 'taxCodes' ? { fetcher: taxes } : lookup?.col === 'vatImportCode' ? { fetcher: vatTaxes } : lookup?.col === 'assetCode' ? { fetcher: assetPick } : {})} onPick={pick} onClose={() => setLookup(null)} />
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
