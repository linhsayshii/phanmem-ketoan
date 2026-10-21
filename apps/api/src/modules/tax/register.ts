import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, formatVnDate, voucherTypeDef } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';
import { regimeOf } from '../reporting/ledgers.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import type { ReportDoc } from '../reporting/print/html.js';

// Bảng kê hóa đơn mua vào/bán ra (nội bộ, không phải mẫu bắt buộc: TT 80/2021 và TT 89/2026 không còn phụ lục bảng kê) và đối chiếu thuế hóa đơn với sổ cái.
type Trx = Transaction<Database>;
export type Direction = 'purchase' | 'sale';
export type PeriodKind = 'month' | 'quarter';
export interface PeriodQ { year: number; period: number; periodKind: PeriodKind }

interface Spec { year: number; lo: number; hi: number; from: string; to: string; vat: PeriodKind; label: string }
const pad = (n: number) => String(n).padStart(2, '0');

// Kỳ chọn → khoảng kỳ kê khai theo đơn vị đã lưu (cài đặt vat_period: tháng hoặc quý) và khoảng ngày dương lịch. Kê khai theo quý không tách được theo tháng.
async function specOf(trx: Trx, tenantId: string, q: PeriodQ): Promise<Spec> {
  const { vat_period: vat } = await getSettings(trx, tenantId);
  const max = q.periodKind === 'month' ? 12 : 4;
  if (q.period < 1 || q.period > max) throw new AppError('VALIDATION', q.periodKind === 'month' ? 'Tháng phải từ 1 đến 12' : 'Quý phải từ 1 đến 4', 400);
  if (q.periodKind === 'month' && vat === 'quarter') throw new AppError('VALIDATION', 'Công ty kê khai GTGT theo quý: chọn kỳ theo quý, không tách được theo tháng', 400);
  const m1 = q.periodKind === 'month' ? q.period : 3 * q.period - 2; const m2 = q.periodKind === 'month' ? q.period : 3 * q.period;
  const [lo, hi] = vat === 'month' ? [m1, m2] : [q.period, q.period];
  return { year: q.year, lo, hi, vat, from: `${q.year}-${pad(m1)}-01`, to: new Date(Date.UTC(q.year, m2, 0)).toISOString().slice(0, 10),
    label: q.periodKind === 'month' ? `Tháng ${q.period} năm ${q.year}` : `Quý ${q.period} năm ${q.year}` };
}

export interface InvoiceLine {
  stt: number; invoiceId: number; groupCode: string; groupName: string; formNo: string | null; serial: string | null; invoiceNo: string; invoiceDate: string; partyCode: string | null; partyName: string | null; partyTaxCode: string | null;
  baseAmount: string; taxRate: string | null; taxAmount: string; taxCode: string | null; isImport: boolean; voucherId: string; voucherNo: string | null; voucherType: string; kind: 'original' | 'reversal';
  direction: Direction; taxKind: string | null; depth: number;
}

// Hóa đơn hiệu lực của chứng từ đã ghi sổ hoặc đã đảo. Chứng từ đảo không có dòng voucher_invoice: đọc hóa đơn gốc qua reversal_of_id, đổi dấu (đảo của đảo đổi dấu lại).
// Hóa đơn gốc ở kỳ kê khai của nó (declare_year/declare_period); dòng của chứng từ đảo thuộc kỳ của ngày ghi sổ chứng từ đảo. Giảm giá, trả lại (GGB, GGM) ghi số âm.
async function effectiveRows(trx: Trx, vat: PeriodKind, where: ReturnType<typeof sql>): Promise<InvoiceLine[]> {
  const unit = (d: ReturnType<typeof sql>) => (vat === 'month' ? sql`extract(month from ${d})::int` : sql`ceil(extract(month from ${d}) / 3.0)::int`);
  const r = await sql<Record<string, string | number | boolean | null>>`
    WITH RECURSIVE eff(voucher_id, src_id, depth) AS (
      SELECT v.id, v.id, 0 FROM voucher v WHERE v.state IN ('posted', 'reversed') AND EXISTS (SELECT 1 FROM voucher_invoice i WHERE i.voucher_id = v.id)
      UNION ALL
      SELECT r.id, e.src_id, e.depth + 1 FROM voucher r JOIN eff e ON r.reversal_of_id = e.voucher_id WHERE r.state IN ('posted', 'reversed'))
    SELECT * FROM (
      SELECT i.id AS "invoiceId", e.depth, i.direction, coalesce(g.code, '') AS "groupCode", coalesce(g.name, '') AS "groupName", i.form_no AS "formNo", i.serial, i.invoice_no AS "invoiceNo", i.invoice_date::text AS "invoiceDate",
             p.code AS "partyCode", i.party_name AS "partyName", i.party_tax_code AS "partyTaxCode", i.base_amount::text AS "baseAmount", t.rate::text AS "taxRate", i.tax_amount::text AS "taxAmount", t.code AS "taxCode", t.kind AS "taxKind",
             i.is_import AS "isImport", ev.id AS "voucherId", ev.voucher_no AS "voucherNo", ev.voucher_type AS "voucherType", sv.voucher_type AS "srcType",
             CASE WHEN e.depth = 0 THEN coalesce(i.declare_year, extract(year from i.invoice_date)::int) ELSE extract(year from ev.posting_date)::int END AS eff_year,
             CASE WHEN e.depth = 0 THEN coalesce(i.declare_period, ${unit(sql`i.invoice_date`)}) ELSE ${unit(sql`ev.posting_date`)} END AS eff_period
      FROM eff e JOIN voucher ev ON ev.id = e.voucher_id JOIN voucher sv ON sv.id = e.src_id JOIN voucher_invoice i ON i.voucher_id = e.src_id
        LEFT JOIN party p ON p.id = i.party_id LEFT JOIN invoice_group g ON g.id = i.invoice_group_id LEFT JOIN tax_code t ON t.id = i.tax_code_id) x
    WHERE ${where}
    ORDER BY x."groupCode", x."invoiceDate", x."invoiceNo", x."invoiceId", x.depth`.execute(trx);
  return r.rows.map((x) => {
    const sign = (Number(x.depth) % 2 === 0 ? 1 : -1) * (voucherTypeDef(String(x.srcType))?.refund ? -1 : 1);
    const money = (v: unknown) => D(String(v)).times(sign).toFixed(0);
    return { stt: 0, invoiceId: Number(x.invoiceId), groupCode: String(x.groupCode), groupName: String(x.groupName), formNo: x.formNo as string | null, serial: x.serial as string | null, invoiceNo: String(x.invoiceNo), invoiceDate: String(x.invoiceDate),
      partyCode: x.partyCode as string | null, partyName: x.partyName as string | null, partyTaxCode: x.partyTaxCode as string | null, baseAmount: money(x.baseAmount), taxRate: x.taxRate === null ? null : D(String(x.taxRate)).toString(), taxAmount: money(x.taxAmount),
      taxCode: x.taxCode as string | null, isImport: Boolean(x.isImport), voucherId: String(x.voucherId), voucherNo: x.voucherNo as string | null, voucherType: String(x.voucherType), kind: Number(x.depth) === 0 ? 'original' : 'reversal',
      direction: x.direction as Direction, taxKind: x.taxKind as string | null, depth: Number(x.depth) };
  });
}

const inPeriod = (s: Spec) => sql`x.eff_year = ${s.year} AND x.eff_period BETWEEN ${s.lo} AND ${s.hi}`;
const sum = (rows: { baseAmount: string; taxAmount: string }[], k: 'baseAmount' | 'taxAmount') => rows.reduce((t, r) => t.plus(r[k]), D(0)).toFixed(0);

// Hóa đơn và đảo của nó cùng nằm trong kỳ thì triệt tiêu: bỏ từng cặp (dòng gốc, dòng đảo) của cùng một dòng hóa đơn.
function dropCancelled(rows: InvoiceLine[]): InvoiceLine[] {
  const byId = new Map<number, InvoiceLine[]>();
  for (const r of rows) byId.set(r.invoiceId, [...(byId.get(r.invoiceId) ?? []), r]);
  const drop = new Set<InvoiceLine>();
  for (const list of byId.values()) {
    const even = list.filter((r) => r.depth % 2 === 0); const odd = list.filter((r) => r.depth % 2 === 1);
    for (let k = 0; k < Math.min(even.length, odd.length); k++) { drop.add(even[k]!); drop.add(odd[k]!); }
  }
  return rows.filter((r) => !drop.has(r));
}

export interface RegisterGroup { code: string; name: string; rows: InvoiceLine[]; baseTotal: string; taxTotal: string }
export interface Register {
  direction: Direction; year: number; period: number; periodKind: PeriodKind; label: string; from: string; to: string; groups: RegisterGroup[]; totals: { baseAmount: string; taxAmount: string };
  // Thuế nhập khẩu, tiêu thụ đặc biệt (mã thuế kind import/excise) không thuộc tờ khai GTGT và không tách được theo nhóm kê khai: liệt kê riêng, không cộng vào nhóm hay tổng.
  otherTaxes: { rows: InvoiceLine[]; baseTotal: string; taxTotal: string };
}

export async function invoiceRegister(trx: Trx, tenantId: string, direction: Direction, q: PeriodQ): Promise<Register> {
  const s = await specOf(trx, tenantId, q);
  const all = dropCancelled(await effectiveRows(trx, s.vat, sql`x.direction = ${direction} AND ${inPeriod(s)}`));
  const isVat = (r: InvoiceLine) => r.taxKind === null || r.taxKind === 'vat';
  const groups: RegisterGroup[] = [];
  for (const r of all.filter(isVat)) {
    let g = groups.find((x) => x.code === r.groupCode);
    if (!g) groups.push(g = { code: r.groupCode, name: r.groupName, rows: [], baseTotal: '0', taxTotal: '0' });
    r.stt = g.rows.length + 1; g.rows.push(r);
  }
  for (const g of groups) { g.baseTotal = sum(g.rows, 'baseAmount'); g.taxTotal = sum(g.rows, 'taxAmount'); }
  const other = all.filter((r) => !isVat(r)); other.forEach((r, k) => { r.stt = k + 1; });
  return { direction, year: q.year, period: q.period, periodKind: q.periodKind, label: s.label, from: s.from, to: s.to, groups,
    totals: { baseAmount: sum(groups.flatMap((g) => g.rows), 'baseAmount'), taxAmount: sum(groups.flatMap((g) => g.rows), 'taxAmount') },
    otherTaxes: { rows: other, baseTotal: sum(other, 'baseAmount'), taxTotal: sum(other, 'taxAmount') } };
}

// Tài liệu in: nhóm kê khai là dòng đậm có cộng; tiêu đề bảng kê nội bộ, không ghi "Mẫu số".
export async function registerDoc(trx: Trx, tenantId: string, r: Register): Promise<ReportDoc> {
  const side = r.direction === 'purchase' ? 'mua vào' : 'bán ra';
  const line = (x: InvoiceLine) => ({ stt: x.stt, serial: [x.formNo, x.serial].filter(Boolean).join(' '), invoiceNo: x.invoiceNo, invoiceDate: x.invoiceDate, partyName: x.partyName ?? '', partyTaxCode: x.partyTaxCode ?? '',
    baseAmount: x.baseAmount, taxRate: x.taxRate === null ? '' : `${x.taxRate}%`, taxAmount: x.taxAmount, voucherNo: x.kind === 'reversal' ? `${x.voucherNo ?? ''} (đảo)` : x.voucherNo ?? '' });
  const rows: Record<string, unknown>[] = [];
  for (const g of r.groups) rows.push({ partyName: `Nhóm ${g.code} – ${g.name}`, isBold: true }, ...g.rows.map(line), { partyName: `Cộng nhóm ${g.code}`, baseAmount: g.baseTotal, taxAmount: g.taxTotal, isBold: true });
  if (r.otherTaxes.rows.length) rows.push({ partyName: 'Thuế nhập khẩu, tiêu thụ đặc biệt (không kê khai GTGT, không cộng vào tổng)', isBold: true }, ...r.otherTaxes.rows.map(line),
    { partyName: 'Cộng', baseAmount: r.otherTaxes.baseTotal, taxAmount: r.otherTaxes.taxTotal, isBold: true });
  const num = (key: string, label: string) => ({ key, label, type: 'number' as const, width: '11%' });
  return { title: `Bảng kê hóa đơn, chứng từ hàng hóa, dịch vụ ${side}`, formNo: '', issuedBy: '', company: await companyInfo(trx, tenantId, await regimeOf(trx, r), null),
    subtitle: `Kỳ kê khai: ${r.label} (${formatVnDate(r.from)} – ${formatVnDate(r.to)})`, sheetName: `Bảng kê ${side}`, landscape: true,
    columns: [{ key: 'stt', label: 'STT', width: '4%' }, { key: 'serial', label: 'Ký hiệu', width: '8%' }, { key: 'invoiceNo', label: 'Số hóa đơn', width: '8%' }, { key: 'invoiceDate', label: 'Ngày', type: 'date', width: '8%' },
      { key: 'partyName', label: 'Tên người bán/mua' }, { key: 'partyTaxCode', label: 'Mã số thuế', width: '9%' }, num('baseAmount', 'Giá trị chưa thuế'), { key: 'taxRate', label: 'Thuế suất', width: '6%', align: 'right' },
      num('taxAmount', 'Thuế GTGT'), { key: 'voucherNo', label: 'Số chứng từ', width: '9%' }],
    rows, footer: { partyName: 'Tổng cộng', baseAmount: r.totals.baseAmount, taxAmount: r.totals.taxAmount } };
}

export interface Reconcile {
  purchaseTaxInvoices: string; debit1331: string; saleTaxInvoices: string; credit33311: string;
  differences: { voucherId: string; voucherNo: string | null; voucherType: string; direction: Direction; invoiceTax: string; ledgerTax: string }[];
}

// Tài khoản thuế GTGT = mọi tài khoản của dòng phân bổ thuế (line_type 'tax') của mã thuế GTGT, theo chiều mua/bán: mã chia 50/50 hai tài khoản được cộng đủ cả hai.
async function taxAccounts(trx: Trx): Promise<Record<Direction, string[]>> {
  const r = await sql<{ scope: Direction; code: string }>`SELECT DISTINCT d.scope, d.account_code AS code FROM tax_distribution d JOIN tax_code c ON c.id = d.tax_code_id
    WHERE d.line_type = 'tax' AND c.kind = 'vat' AND d.account_code IS NOT NULL`.execute(trx);
  return { purchase: r.rows.filter((x) => x.scope === 'purchase').map((x) => x.code), sale: r.rows.filter((x) => x.scope === 'sale').map((x) => x.code) };
}

// Phát sinh thuế của sổ cái theo chứng từ (Nợ − Có tài khoản thuế mua, Có − Nợ tài khoản thuế bán). Bỏ chứng từ khấu trừ thuế cuối kỳ (vat_offset): chuyển 33311 sang 1331, không có hóa đơn.
async function ledgerTax(trx: Trx, acc: Record<Direction, string[]>, where: ReturnType<typeof sql>) {
  const r = await sql<{ voucher_id: string; purchase: string; sale: string }>`
    SELECT l.voucher_id, coalesce(sum(CASE WHEN a.code = ANY(${acc.purchase}::text[]) THEN l.debit - l.credit ELSE 0 END), 0)::text AS purchase,
           coalesce(sum(CASE WHEN a.code = ANY(${acc.sale}::text[]) THEN l.credit - l.debit ELSE 0 END), 0)::text AS sale
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.state IN ('posted', 'reversed') AND v.source_doc_type IS DISTINCT FROM 'vat_offset' AND a.code = ANY(${[...acc.purchase, ...acc.sale]}::text[]) AND ${where}
    GROUP BY l.voucher_id`.execute(trx);
  return new Map(r.rows.map((x) => [x.voucher_id, x]));
}

export async function reconcileTax(trx: Trx, tenantId: string, q: PeriodQ): Promise<Reconcile> {
  const s = await specOf(trx, tenantId, q); const acc = await taxAccounts(trx);
  const isVat = (r: InvoiceLine) => r.taxKind === null || r.taxKind === 'vat';
  const inRows = (await effectiveRows(trx, s.vat, inPeriod(s))).filter(isVat);
  const inLedger = await ledgerTax(trx, acc, sql`l.posting_date BETWEEN ${s.from}::date AND ${s.to}::date`);
  const ids = [...new Set([...inRows.map((r) => r.voucherId), ...inLedger.keys()])];
  const full = ids.length ? (await effectiveRows(trx, s.vat, sql`x."voucherId" = ANY(${ids}::uuid[])`)).filter(isVat) : [];
  const ledger = ids.length ? await ledgerTax(trx, acc, sql`l.voucher_id = ANY(${ids}::uuid[])`) : new Map();
  const meta = ids.length ? (await sql<{ id: string; voucher_no: string | null; voucher_type: string }>`SELECT id, voucher_no, voucher_type FROM voucher WHERE id = ANY(${ids}::uuid[]) ORDER BY posting_date, seq_no, created_at`.execute(trx)).rows : [];
  const differences: Reconcile['differences'] = [];
  for (const m of meta) for (const direction of ['purchase', 'sale'] as const) {
    const invoiceTax = sum(full.filter((r) => r.voucherId === m.id && r.direction === direction), 'taxAmount');
    const ledgerSide = D(ledger.get(m.id)?.[direction] ?? 0).toFixed(0);
    if (invoiceTax !== ledgerSide) differences.push({ voucherId: m.id, voucherNo: m.voucher_no, voucherType: m.voucher_type, direction, invoiceTax, ledgerTax: ledgerSide });
  }
  const total = (k: Direction) => [...inLedger.values()].reduce((t, x) => t.plus(x[k]), D(0)).toFixed(0);
  return { purchaseTaxInvoices: sum(inRows.filter((r) => r.direction === 'purchase'), 'taxAmount'), debit1331: total('purchase'), saleTaxInvoices: sum(inRows.filter((r) => r.direction === 'sale'), 'taxAmount'), credit33311: total('sale'), differences };
}
