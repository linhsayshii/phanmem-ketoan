import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, formatVnDate, formatVnNumber, ZERO, type Decimal } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { accountsUnder, assertSensitive, dayBefore, regimeOf } from '../reporting/ledgers.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import { periodSubtitle, type ReportDoc } from '../reporting/print/html.js';

type Trx = Transaction<Database>;
type Auth = { sensitive: Set<string> };
type Kind = 'receivable' | 'payable';
const POSTED = sql`v.state IN ('posted','reversed')`;
const vnd = (d: Decimal) => d.toFixed(0);
const foreign = (d: Decimal) => d.toFixed(4);
const isForeign = (currency: string | undefined): currency is string => !!currency && currency !== 'VND';
// Số dư ròng (Nợ dương, Có âm) tách thành hai cột Dư Nợ / Dư Có như sổ giấy.
const sides = (net: Decimal) => ({ debit: net.gt(0) ? vnd(net) : '0', credit: net.lt(0) ? vnd(net.neg()) : '0' });

// ---- Phạm vi: tài khoản công nợ và đối tượng ----
interface Scope { regime: string; prefix: string; accountName: string; kind: Kind }
// Cờ nhạy cảm kiểm trên chính tài khoản và mọi tài khoản con TRƯỚC khi đọc số liệu (403 nêu cờ thiếu); chỉ nhận tài khoản công nợ phải thu/phải trả.
async function scopeOf(trx: Trx, auth: Auth, q: { accountCode: string; from: string; to: string }): Promise<Scope> {
  const regime = await regimeOf(trx, q);
  const under = await accountsUnder(trx, regime, q.accountCode);
  for (const a of under) assertSensitive(auth, a);
  const acc = under.find((a) => a.code === q.accountCode)!;
  if (acc.subledger_kind !== 'receivable' && acc.subledger_kind !== 'payable') throw new AppError('NOT_ARAP_ACCOUNT', `Tài khoản ${q.accountCode} không phải tài khoản công nợ phải thu, phải trả`, 400);
  return { regime, prefix: q.accountCode, accountName: acc.name, kind: acc.subledger_kind };
}
async function findParty(trx: Trx, code: string) {
  const p = await trx.selectFrom('party').select(['id', 'code', 'name', 'address', 'tax_code']).where('code', '=', code).executeTakeFirst();
  if (!p) throw new AppError('PARTY_NOT_FOUND', `Không có đối tượng ${code}`, 404);
  return p;
}
type Party = Awaited<ReturnType<typeof findParty>>;
// Tài liệu in công nợ là mẫu nội bộ, không có văn bản gốc để chép số mẫu: không bao giờ in dòng "Mẫu số".
const internalCompany = async (trx: Trx, tenantId: string, regime: string) => ({ ...(await companyInfo(trx, tenantId, regime, 'cong-no')), formNo: '', issuedBy: '' });
const num = (key: string, label: string, scale?: number) => ({ key, label, type: 'number' as const, ...(scale === undefined ? {} : { scale }) });
const bold = { isBold: true };

// ---- Sổ chi tiết công nợ theo đối tượng ----
export interface DetailRow {
  date: string; documentDate: string; voucherId: string; voucherType: string; voucherNo: string | null; description: string | null; counterAccounts: string;
  debit: string; credit: string; balance: string; debitCurrency: string | null; creditCurrency: string | null; balanceCurrency: string | null;
}
// Số dư (balance, opening, closing) có dấu: Nợ dương, Có âm. Cột nguyên tệ chỉ có khi chọn loại tiền khác VND.
export interface Detail {
  kind: Kind; accountCode: string; accountName: string; partyCode: string; partyName: string; partyAddress: string | null; partyTaxCode: string | null; currency: string | null; from: string; to: string;
  opening: string; openingCurrency: string | null; rows: DetailRow[]; totalDebit: string; totalCredit: string; totalDebitCurrency: string | null; totalCreditCurrency: string | null; closing: string; closingCurrency: string | null;
}
export interface DetailQuery { accountCode: string; partyCode: string; from: string; to: string; currency?: string | undefined }
interface LineRow { voucherId: string; voucherType: string; voucherNo: string | null; postingDate: string; documentDate: string; vDesc: string | null; lDesc: string | null; debit: string; credit: string; cur: string; counters: string[] }

async function buildDetail(trx: Trx, tenantId: string, s: Scope, party: Party, q: DetailQuery): Promise<Detail> {
  const fx = isForeign(q.currency);
  // Dư đầu: số dư kỳ + dòng đến hết ngày trước `from` (cùng nguồn Bảng cân đối số phát sinh), theo đối tượng và loại tiền nếu có.
  const o = (await sql<{ net: string; cur: string }>`SELECT coalesce(sum(b.debit - b.credit), 0)::text AS net, coalesce(sum(b.debit_cur - b.credit_cur), 0)::text AS cur
    FROM fn_balances_at(${tenantId}::uuid, ${dayBefore(q.from)}::date) b JOIN account a ON a.id = b.account_id
    WHERE a.regime = ${s.regime} AND starts_with(a.code, ${s.prefix}) AND b.party_id = ${party.id}::uuid ${q.currency ? sql`AND b.currency_code = ${q.currency}` : sql``}`.execute(trx)).rows[0]!;
  const lines = (await sql<LineRow>`
    SELECT v.id AS "voucherId", v.voucher_type AS "voucherType", v.voucher_no AS "voucherNo", v.posting_date AS "postingDate", v.document_date AS "documentDate", v.description AS "vDesc", l.description AS "lDesc",
           l.debit::text AS debit, l.credit::text AS credit, l.amount_currency::text AS cur,
           coalesce((SELECT array_agg(DISTINCT c.code ORDER BY c.code) FROM voucher_pair q JOIN account c ON c.id = CASE WHEN q.debit_line_id = l.id THEN q.credit_account_id ELSE q.debit_account_id END
                     WHERE q.voucher_id = l.voucher_id AND q.posting_date = l.posting_date AND (q.debit_line_id = l.id OR q.credit_line_id = l.id)), '{}') AS counters
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE ${POSTED} AND v.posting_date BETWEEN ${q.from}::date AND ${q.to}::date AND l.posting_date BETWEEN ${q.from}::date AND ${q.to}::date
      AND a.regime = ${s.regime} AND starts_with(a.code, ${s.prefix}) AND l.party_id = ${party.id}::uuid ${q.currency ? sql`AND l.currency_code = ${q.currency}` : sql``}
    ORDER BY l.posting_date, v.voucher_type, v.seq_no, v.id, l.line_no`.execute(trx)).rows;

  // Một dòng sổ cho mỗi chứng từ: Nợ, Có là tổng các dòng của đối tượng trong chứng từ đó.
  interface Agg { meta: LineRow; debit: Decimal; credit: Decimal; dCur: Decimal; cCur: Decimal; counters: Set<string> }
  const byVoucher = new Map<string, Agg>();
  for (const l of lines) {
    let a = byVoucher.get(l.voucherId);
    if (!a) byVoucher.set(l.voucherId, a = { meta: l, debit: ZERO, credit: ZERO, dCur: ZERO, cCur: ZERO, counters: new Set() });
    a.debit = a.debit.plus(l.debit); a.credit = a.credit.plus(l.credit);
    if (D(l.debit).gt(0)) a.dCur = a.dCur.plus(l.cur);
    if (D(l.credit).gt(0)) a.cCur = a.cCur.minus(l.cur);
    for (const c of l.counters) a.counters.add(c);
  }
  let run = D(o.net); let runCur = D(o.cur); let totalD = ZERO; let totalC = ZERO; let totalDCur = ZERO; let totalCCur = ZERO;
  const rows: DetailRow[] = [...byVoucher.values()].map((a) => {
    run = run.plus(a.debit).minus(a.credit); runCur = runCur.plus(a.dCur).minus(a.cCur);
    totalD = totalD.plus(a.debit); totalC = totalC.plus(a.credit); totalDCur = totalDCur.plus(a.dCur); totalCCur = totalCCur.plus(a.cCur);
    const m = a.meta;
    return { date: m.postingDate, documentDate: m.documentDate, voucherId: m.voucherId, voucherType: m.voucherType, voucherNo: m.voucherNo, description: m.vDesc ?? m.lDesc, counterAccounts: [...a.counters].join(', '),
      debit: vnd(a.debit), credit: vnd(a.credit), balance: vnd(run), debitCurrency: fx ? foreign(a.dCur) : null, creditCurrency: fx ? foreign(a.cCur) : null, balanceCurrency: fx ? foreign(runCur) : null };
  });
  return { kind: s.kind, accountCode: s.prefix, accountName: s.accountName, partyCode: party.code, partyName: party.name, partyAddress: party.address, partyTaxCode: party.tax_code, currency: q.currency ?? null, from: q.from, to: q.to,
    opening: vnd(D(o.net)), openingCurrency: fx ? foreign(D(o.cur)) : null, rows, totalDebit: vnd(totalD), totalCredit: vnd(totalC),
    totalDebitCurrency: fx ? foreign(totalDCur) : null, totalCreditCurrency: fx ? foreign(totalCCur) : null, closing: vnd(run), closingCurrency: fx ? foreign(runCur) : null };
}
export async function arapDetail(trx: Trx, auth: Auth, tenantId: string, q: DetailQuery): Promise<Detail> {
  const s = await scopeOf(trx, auth, q);
  return buildDetail(trx, tenantId, s, await findParty(trx, q.partyCode), q);
}

// Hàng của bản in sổ chi tiết và biên bản đối chiếu: dư đầu, từng chứng từ, cộng phát sinh, dư cuối (Dư Nợ / Dư Có tách cột).
const detailColumns = [{ key: 'date', label: 'Ngày ghi sổ', type: 'date' as const, width: '10%' }, { key: 'voucherNo', label: 'Số chứng từ', width: '12%' }, { key: 'description', label: 'Diễn giải' },
  { key: 'counterAccounts', label: 'TK đối ứng', width: '9%' }, num('debit', 'Phát sinh Nợ'), num('credit', 'Phát sinh Có'), num('balanceDebit', 'Dư Nợ'), num('balanceCredit', 'Dư Có')];
function detailRows(d: Detail): Record<string, unknown>[] {
  const bal = (net: string) => { const x = sides(D(net)); return { balanceDebit: x.debit, balanceCredit: x.credit }; };
  return [{ description: 'Số dư đầu kỳ', ...bal(d.opening), ...bold },
    ...d.rows.map((r) => ({ ...r, ...bal(r.balance) })),
    { description: 'Cộng số phát sinh trong kỳ', debit: d.totalDebit, credit: d.totalCredit, ...bold },
    { description: 'Số dư cuối kỳ', ...bal(d.closing), ...bold }];
}
export async function detailDoc(trx: Trx, auth: Auth, tenantId: string, q: DetailQuery): Promise<ReportDoc> {
  const s = await scopeOf(trx, auth, q); const d = await buildDetail(trx, tenantId, s, await findParty(trx, q.partyCode), q);
  const fx = isForeign(q.currency);
  const columns = fx ? [...detailColumns.slice(0, 6), num('debitCurrency', `Nợ (${q.currency})`, 2), num('creditCurrency', `Có (${q.currency})`, 2), num('balanceCurrency', `Dư (${q.currency})`, 2), ...detailColumns.slice(6)] : detailColumns;
  const rows = detailRows(d);
  if (fx) { rows[0] = { ...rows[0], balanceCurrency: d.openingCurrency }; rows[rows.length - 2] = { ...rows.at(-2), debitCurrency: d.totalDebitCurrency, creditCurrency: d.totalCreditCurrency }; rows[rows.length - 1] = { ...rows.at(-1), balanceCurrency: d.closingCurrency }; }
  return { title: `Sổ chi tiết công nợ – TK ${d.accountCode} – ${d.partyName} (${d.partyCode})`, company: await internalCompany(trx, tenantId, s.regime), formNo: '', issuedBy: '', subtitle: periodSubtitle(d.from, d.to),
    sheetName: `Công nợ ${d.partyCode}`, landscape: true, columns, rows };
}

// ---- Tổng hợp công nợ theo đối tượng ----
export interface SummaryRow { partyCode: string; partyName: string; openingDebit: string; openingCredit: string; periodDebit: string; periodCredit: string; closingDebit: string; closingCredit: string }
// Dư đầu/cuối của từng đối tượng là số dư ròng (gộp tài khoản con và loại tiền) tách sang bên Nợ hoặc bên Có; tổng từng bên cộng thẳng các đối tượng (không bù trừ như Bảng cân đối số phát sinh).
// accountNet là số dư ròng (Nợ - Có) của cả tài khoản tại `to` đọc độc lập từ số dư kỳ; matches cho biết Σ dư cuối các đối tượng có khớp nó không.
export interface Summary { kind: Kind; accountCode: string; accountName: string; from: string; to: string; rows: SummaryRow[]; totals: Omit<SummaryRow, 'partyCode' | 'partyName'>; closingNet: string; accountNet: string; matches: boolean }
export async function arapSummary(trx: Trx, auth: Auth, tenantId: string, q: { accountCode: string; from: string; to: string }): Promise<Summary> {
  const s = await scopeOf(trx, auth, q);
  const r = await sql<{ code: string | null; name: string | null; open: string; pd: string; pc: string }>`
    SELECT p.code, p.name, u.open::text AS open, u.pd::text AS pd, u.pc::text AS pc FROM (
      SELECT x.party_id, sum(x.open) AS open, sum(x.pd) AS pd, sum(x.pc) AS pc FROM (
        SELECT b.party_id, sum(b.debit - b.credit) AS open, 0::numeric AS pd, 0::numeric AS pc FROM fn_balances_at(${tenantId}::uuid, ${dayBefore(q.from)}::date) b JOIN account a ON a.id = b.account_id
          WHERE a.regime = ${s.regime} AND starts_with(a.code, ${s.prefix}) GROUP BY b.party_id
        UNION ALL
        SELECT l.party_id, 0::numeric, sum(l.debit), sum(l.credit) FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
          WHERE ${POSTED} AND v.posting_date BETWEEN ${q.from}::date AND ${q.to}::date AND l.posting_date BETWEEN ${q.from}::date AND ${q.to}::date AND a.regime = ${s.regime} AND starts_with(a.code, ${s.prefix}) GROUP BY l.party_id) x
      GROUP BY x.party_id) u LEFT JOIN party p ON p.id = u.party_id
    ORDER BY p.code NULLS LAST`.execute(trx);
  const rows: SummaryRow[] = []; const t = { od: ZERO, oc: ZERO, pd: ZERO, pc: ZERO, cd: ZERO, cc: ZERO };
  for (const x of r.rows) {
    const open = D(x.open); const pd = D(x.pd); const pc = D(x.pc); const close = open.plus(pd).minus(pc);
    if (open.isZero() && pd.isZero() && pc.isZero() && close.isZero()) continue;
    const o = sides(open); const c = sides(close);
    rows.push({ partyCode: x.code ?? '', partyName: x.name ?? 'Chưa gán đối tượng', openingDebit: o.debit, openingCredit: o.credit, periodDebit: vnd(pd), periodCredit: vnd(pc), closingDebit: c.debit, closingCredit: c.credit });
    t.od = t.od.plus(o.debit); t.oc = t.oc.plus(o.credit); t.pd = t.pd.plus(pd); t.pc = t.pc.plus(pc); t.cd = t.cd.plus(c.debit); t.cc = t.cc.plus(c.credit);
  }
  const acct = (await sql<{ net: string }>`SELECT coalesce(sum(b.debit - b.credit), 0)::text AS net FROM fn_balances_at(${tenantId}::uuid, ${q.to}::date) b JOIN account a ON a.id = b.account_id
    WHERE a.regime = ${s.regime} AND starts_with(a.code, ${s.prefix})`.execute(trx)).rows[0]!.net;
  const closingNet = t.cd.minus(t.cc);
  return { kind: s.kind, accountCode: s.prefix, accountName: s.accountName, from: q.from, to: q.to, rows,
    totals: { openingDebit: vnd(t.od), openingCredit: vnd(t.oc), periodDebit: vnd(t.pd), periodCredit: vnd(t.pc), closingDebit: vnd(t.cd), closingCredit: vnd(t.cc) },
    closingNet: vnd(closingNet), accountNet: vnd(D(acct)), matches: closingNet.eq(acct) };
}
export async function summaryDoc(trx: Trx, auth: Auth, tenantId: string, q: { accountCode: string; from: string; to: string }): Promise<ReportDoc> {
  const m = await arapSummary(trx, auth, tenantId, q); const regime = await regimeOf(trx, q);
  return { title: `Tổng hợp công nợ – TK ${m.accountCode} – ${m.accountName}`, company: await internalCompany(trx, tenantId, regime), formNo: '', issuedBy: '', subtitle: periodSubtitle(m.from, m.to), sheetName: `Tổng hợp ${m.accountCode}`, landscape: true,
    columns: [{ key: 'partyCode', label: 'Mã đối tượng', width: '10%' }, { key: 'partyName', label: 'Tên đối tượng' }, num('openingDebit', 'Dư đầu kỳ Nợ'), num('openingCredit', 'Dư đầu kỳ Có'),
      num('periodDebit', 'Phát sinh Nợ'), num('periodCredit', 'Phát sinh Có'), num('closingDebit', 'Dư cuối kỳ Nợ'), num('closingCredit', 'Dư cuối kỳ Có')],
    rows: m.rows as unknown as Record<string, unknown>[], footer: { partyName: 'Tổng cộng', ...m.totals } };
}

// ---- Tuổi nợ ----
// Khoản gốc cộng các khoản con đánh giá lại (open_item.parent_id, chỉ có VND) theo hạn và ngày chứng từ của khoản gốc; chỉ khoản còn dư khác 0.
// Dư tính tại cuối ngày asOf bằng cùng công thức fn_open_items_at, lọc tài khoản và đối tượng trước khi cộng đối trừ.
interface Item { itemId: number; partyCode: string; partyName: string; docNo: string | null; docDate: string; dueDate: string | null; residual: string; daysDue: number | null; daysDoc: number }
async function loadItems(trx: Trx, tenantId: string, s: Scope, asOf: string, partyId: string | undefined, by: 'due' | 'doc'): Promise<Item[]> {
  const r = await sql<Item>`
    SELECT r.id AS "itemId", p.code AS "partyCode", p.name AS "partyName", r.doc_no AS "docNo", r.doc_date AS "docDate", r.due_date AS "dueDate", sum(x.residual)::text AS residual,
           (${asOf}::date - r.due_date) AS "daysDue", (${asOf}::date - r.doc_date) AS "daysDoc"
    FROM (SELECT coalesce(o.parent_id, o.id) AS root_id, o.amount - coalesce(d.a, 0) + coalesce(c.a, 0) AS residual
      FROM open_item o JOIN account a ON a.id = o.account_id
        LEFT JOIN LATERAL (SELECT sum(s.amount) AS a FROM settlement s WHERE s.tenant_id = o.tenant_id AND s.debit_item_id = o.id AND s.settle_date <= ${asOf}::date) d ON true
        LEFT JOIN LATERAL (SELECT sum(s.amount) AS a FROM settlement s WHERE s.tenant_id = o.tenant_id AND s.credit_item_id = o.id AND s.settle_date <= ${asOf}::date) c ON true
      WHERE o.tenant_id = ${tenantId}::uuid AND o.line_posting_date <= ${asOf}::date AND a.regime = ${s.regime} AND starts_with(a.code, ${s.prefix})
        ${partyId ? sql`AND o.party_id = ${partyId}::uuid` : sql``}) x
      JOIN open_item r ON r.tenant_id = ${tenantId}::uuid AND r.id = x.root_id JOIN party p ON p.id = r.party_id
    GROUP BY r.id, p.code, p.name, r.doc_no, r.doc_date, r.due_date HAVING sum(x.residual) <> 0
    ORDER BY p.code, ${by === 'due' ? sql`r.due_date NULLS LAST,` : sql``} r.doc_date, r.id`.execute(trx);
  return r.rows;
}

export const DEFAULT_BUCKETS = [30, 60, 90, 180];
// Mốc tuổi nợ: số nguyên dương tăng dần, tối đa 8 mốc ("30,60,90,180").
export const bucketsParam = z.string().regex(/^\d{1,4}(,\d{1,4})*$/, 'Mốc tuổi nợ phải là các số nguyên dương cách nhau bởi dấu phẩy').transform((s) => s.split(',').map(Number))
  .refine((a) => a.length <= 8 && a.every((x, i) => x > 0 && (i === 0 || x > a[i - 1]!)), 'Mốc tuổi nợ phải là các số nguyên dương tăng dần, tối đa 8 mốc');
export interface AgingQuery { accountCode: string; partyCode?: string | undefined; asOf: string; by: 'due' | 'doc'; buckets: number[] }
export interface AgingItem { itemId: number; docNo: string | null; docDate: string; dueDate: string | null; residual: string; daysOverdue: number | null; bucket: string }
// Số liệu theo chiều tự nhiên của tài khoản: phải thu = dư Nợ (dương), phải trả = dư Có (đổi dấu thành dương); phần dư ngược chiều (trả trước, thu thừa) vào cột `credit` mang dấu âm,
// nên Σ các cột = total = Σ dư của khoản (phải thu) hoặc -Σ dư (phải trả). Mỗi hàng có khóa notDue, b0..bN (N = số mốc), credit, total.
export interface Aging {
  kind: Kind; accountCode: string; accountName: string; asOf: string; by: 'due' | 'doc'; buckets: number[]; columns: { key: string; label: string }[];
  rows: ({ partyCode: string; partyName: string } & Record<string, string>)[]; totals: Record<string, string>; items?: AgingItem[];
}
export async function arapAging(trx: Trx, auth: Auth, tenantId: string, q: AgingQuery): Promise<Aging> {
  const s = await scopeOf(trx, auth, { accountCode: q.accountCode, from: q.asOf, to: q.asOf });
  const party = q.partyCode ? await findParty(trx, q.partyCode) : undefined;
  const items = await loadItems(trx, tenantId, s, q.asOf, party?.id, q.by);
  const e = q.buckets; const last = `b${e.length}`;
  const labels = [...e.map((x, i) => `${i === 0 ? 1 : e[i - 1]! + 1}–${x}`), `>${e.at(-1)}`];
  const columns = [{ key: 'notDue', label: q.by === 'due' ? 'Chưa đến hạn' : 'Chưa quá ngày chứng từ' }, ...labels.map((label, i) => ({ key: `b${i}`, label })),
    { key: 'credit', label: s.kind === 'receivable' ? 'Trả trước / dư Có' : 'Trả trước / dư Nợ' }, { key: 'total', label: 'Tổng' }];
  const sign = s.kind === 'payable' ? -1 : 1;
  const bucketOf = (natural: Decimal, days: number | null) => {
    if (natural.lt(0)) return 'credit';
    if (days === null || days <= 0) return 'notDue';
    const i = e.findIndex((x) => days <= x);
    return i < 0 ? last : `b${i}`;
  };
  const blank = () => Object.fromEntries(columns.map((c) => [c.key, ZERO])) as Record<string, Decimal>;
  const byParty = new Map<string, { name: string; v: Record<string, Decimal> }>(); const total = blank(); const out: AgingItem[] = [];
  for (const it of items) {
    const natural = D(it.residual).times(sign); const days = q.by === 'due' ? it.daysDue : it.daysDoc; const key = bucketOf(natural, days);
    let row = byParty.get(it.partyCode); if (!row) byParty.set(it.partyCode, row = { name: it.partyName, v: blank() });
    for (const v of [row.v, total]) { v[key] = v[key]!.plus(natural); v['total'] = v['total']!.plus(natural); }
    out.push({ itemId: it.itemId, docNo: it.docNo, docDate: it.docDate, dueDate: it.dueDate, residual: vnd(natural), daysOverdue: days, bucket: key });
  }
  const text = (v: Record<string, Decimal>) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, vnd(x)]));
  return { kind: s.kind, accountCode: s.prefix, accountName: s.accountName, asOf: q.asOf, by: q.by, buckets: e, columns,
    rows: [...byParty].map(([partyCode, r]) => ({ partyCode, partyName: r.name, ...text(r.v) })), totals: text(total), ...(party ? { items: out } : {}) };
}
export async function agingDoc(trx: Trx, auth: Auth, tenantId: string, q: AgingQuery): Promise<ReportDoc> {
  const a = await arapAging(trx, auth, tenantId, q); const regime = await regimeOf(trx, { from: q.asOf, to: q.asOf });
  return { title: `Tuổi nợ ${a.kind === 'receivable' ? 'phải thu' : 'phải trả'} – TK ${a.accountCode}`, company: await internalCompany(trx, tenantId, regime), formNo: '', issuedBy: '',
    subtitle: `Tại ngày ${formatVnDate(a.asOf)} – tính theo ${a.by === 'due' ? 'hạn thanh toán' : 'ngày chứng từ'}`, sheetName: `Tuổi nợ ${a.accountCode}`, landscape: true,
    columns: [{ key: 'partyCode', label: 'Mã đối tượng', width: '9%' }, { key: 'partyName', label: 'Tên đối tượng' }, ...a.columns.map((c) => num(c.key, c.label))],
    rows: a.rows, footer: { partyName: 'Tổng cộng', ...a.totals } };
}

// ---- Biên bản đối chiếu công nợ ----
export async function statementDoc(trx: Trx, auth: Auth, tenantId: string, q: { accountCode: string; partyCode: string; from: string; to: string }): Promise<ReportDoc> {
  const s = await scopeOf(trx, auth, q); const d = await buildDetail(trx, tenantId, s, await findParty(trx, q.partyCode), q);
  const c = await internalCompany(trx, tenantId, s.regime); const dots = '……………';
  const net = D(d.closing);
  // Sổ ghi theo góc nhìn của Bên A (công ty): dư Nợ là Bên B nợ Bên A, dư Có là Bên A nợ Bên B.
  const verdict = net.gt(0) ? `Bên B còn nợ Bên A số tiền ${formatVnNumber(vnd(net))} đồng.` : net.lt(0) ? `Bên A còn nợ Bên B số tiền ${formatVnNumber(vnd(net.neg()))} đồng.` : 'Hai bên không còn công nợ.';
  return { title: 'Biên bản đối chiếu công nợ', company: c, formNo: '', issuedBy: '', subtitle: periodSubtitle(d.from, d.to), sheetName: `Đối chiếu ${d.partyCode}`, landscape: false,
    intro: [`Bên A: ${c.name}. Địa chỉ: ${c.address || dots}. Mã số thuế: ${c.taxCode || dots}. Đại diện: ${c.legalRep || dots}.`,
      `Bên B: ${d.partyName} (${d.partyCode}). Địa chỉ: ${d.partyAddress || dots}. Mã số thuế: ${d.partyTaxCode || dots}.`,
      `Hai bên cùng đối chiếu số liệu công nợ tài khoản ${d.accountCode} – ${d.accountName} như sau:`],
    columns: detailColumns, rows: detailRows(d),
    outro: [`Số dư tại ngày ${formatVnDate(d.to)}: ${verdict}`, `Đề nghị Bên B xác nhận số liệu trên: đồng ý / không đồng ý, số chênh lệch ${dots}, nguyên nhân ${dots}, và gửi lại cho Bên A.`],
    signers: [{ title: 'Đại diện Bên A', note: '(Ký, họ tên, đóng dấu)', name: c.legalRep ?? '' }, { title: 'Đại diện Bên B', note: '(Ký, họ tên, đóng dấu)' }] };
}

// ---- Thư nhắc nợ (phải thu) ----
export async function reminderDoc(trx: Trx, auth: Auth, tenantId: string, q: { accountCode: string; partyCode: string; asOf: string }): Promise<ReportDoc> {
  const s = await scopeOf(trx, auth, { accountCode: q.accountCode, from: q.asOf, to: q.asOf });
  if (s.kind !== 'receivable') throw new AppError('NOT_RECEIVABLE_ACCOUNT', 'Thư nhắc nợ chỉ lập cho công nợ phải thu', 400);
  const party = await findParty(trx, q.partyCode);
  const items = (await loadItems(trx, tenantId, s, q.asOf, party.id, 'due')).filter((i) => i.daysDue !== null && i.daysDue > 0 && D(i.residual).gt(0));
  if (!items.length) throw new AppError('NO_OVERDUE_ITEMS', `Đối tượng ${party.code} không có khoản nợ quá hạn tại ngày ${formatVnDate(q.asOf)}`, 404);
  const total = items.reduce((t, i) => t.plus(i.residual), ZERO); const c = await internalCompany(trx, tenantId, s.regime);
  const [y, m, d] = q.asOf.split('-');
  return { title: 'Thư nhắc nợ', company: c, formNo: '', issuedBy: '', subtitle: `Tại ngày ${formatVnDate(q.asOf)}`, sheetName: `Nhắc nợ ${party.code}`,
    intro: [`Kính gửi: ${party.name}${party.address ? ` – ${party.address}` : ''}`,
      `${c.name} xin thông báo: theo sổ sách kế toán của chúng tôi, tại ngày ${formatVnDate(q.asOf)}, Quý khách còn các khoản nợ đã quá hạn thanh toán sau:`],
    columns: [{ key: 'docNo', label: 'Số chứng từ' }, { key: 'docDate', label: 'Ngày chứng từ', type: 'date' }, { key: 'dueDate', label: 'Hạn thanh toán', type: 'date' }, num('daysOverdue', 'Số ngày quá hạn'), num('residual', 'Số tiền còn nợ')],
    rows: items.map((i) => ({ docNo: i.docNo, docDate: i.docDate, dueDate: i.dueDate, daysOverdue: String(i.daysDue), residual: vnd(D(i.residual)) })), footer: { docNo: 'Cộng', residual: vnd(total) },
    outro: [`Tổng số tiền quá hạn: ${formatVnNumber(vnd(total))} đồng.`, 'Đề nghị Quý khách sắp xếp thanh toán trong thời gian sớm nhất. Nếu đã thanh toán, xin Quý khách bỏ qua thư này và gửi lại chứng từ thanh toán để chúng tôi đối chiếu.', 'Trân trọng cảm ơn.'],
    dateLine: `Ngày ${d} tháng ${m} năm ${y}`,
    signers: [{ title: 'Kế toán trưởng', name: c.chiefAccountant ?? '' }, { title: 'Người đại diện theo pháp luật', note: '(Ký, họ tên, đóng dấu)', name: c.legalRep ?? '' }] };
}
