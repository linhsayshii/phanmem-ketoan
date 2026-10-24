import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, formatVnDate, formatVnNumber, ZERO, type Decimal } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';
import * as S from '../ledger/vouchers.service.js';
import { isSalaryCode, salaryAccountIds } from '../payroll/accounts.js';
import { accountsUnder, dayBefore, regimeOf } from '../reporting/ledgers.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import { bookFormFor } from '../reporting/print/forms.js';
import { periodSubtitle, type ReportDoc } from '../reporting/print/html.js';

type Trx = Transaction<Database>;
export const UNASSIGNED_LABEL = 'Chưa gán tài khoản ngân hàng';
const POSTED = sql`v.state IN ('posted','reversed')`;

// ---- Phạm vi sổ: các tài khoản theo tiền tố, hoặc đúng một tài khoản ngân hàng, hoặc các dòng chưa gán tài khoản ngân hàng ----
interface BankRef { id: number; accountNo: string; glAccountCode: string; currencyCode: string; accountName: string | null; branch: string | null; bankName: string }
async function findBank(trx: Trx, accountNo: string): Promise<BankRef> {
  const r = await trx.selectFrom('bank_account as a').innerJoin('bank as b', 'b.id', 'a.bank_id')
    .select(['a.id', 'a.account_no', 'a.gl_account_code', 'a.currency_code', 'a.account_name', 'a.branch', 'b.name as bank_name']).where('a.account_no', '=', accountNo).executeTakeFirst();
  if (!r) throw new AppError('BANK_ACCOUNT_NOT_FOUND', `Không có tài khoản ngân hàng ${accountNo}`, 404);
  return { id: r.id, accountNo: r.account_no, glAccountCode: r.gl_account_code, currencyCode: r.currency_code, accountName: r.account_name, branch: r.branch, bankName: r.bank_name };
}
interface Scope { regime: string; prefix: string; bankId?: number | 'none' | undefined; currency?: string | undefined }
// Điều kiện trên dòng chứng từ `l` (bí danh account `a`). Mọi nhánh lọc theo chế độ của năm đang xem: đổi chế độ thì số dư năm mới vào bằng DK trên hệ tài khoản mới,
// dòng của tài khoản ngân hàng ở hệ cũ không được cộng thêm lần nữa.
const lineScope = (s: Scope) => s.bankId === undefined ? sql`a.regime = ${s.regime} AND starts_with(a.code, ${s.prefix})`
  : s.bankId === 'none' ? sql`a.regime = ${s.regime} AND starts_with(a.code, ${s.prefix}) AND l.bank_account_id IS NULL` : sql`a.regime = ${s.regime} AND l.bank_account_id = ${s.bankId}`;
const currencyOf = (s: Scope) => (s.currency ? sql`AND l.currency_code = ${s.currency}` : sql``);

// Số dư ròng (Nợ - Có) cuối ngày `asOf` và số dư nguyên tệ. Không lọc tài khoản ngân hàng: dùng fn_balances_at (số dư kỳ + dòng trong kỳ, cùng nguồn với Bảng cân đối số phát sinh);
// có lọc: cộng thẳng các dòng đã ghi sổ (số dư kỳ không mang chiều tài khoản ngân hàng).
async function netAt(trx: Trx, s: Scope, asOf: string): Promise<{ net: Decimal; cur: Decimal }> {
  if (s.bankId === undefined) {
    const r = await sql<{ net: string; cur: string }>`SELECT coalesce(sum(b.debit - b.credit), 0)::text AS net, coalesce(sum(b.debit_cur - b.credit_cur), 0)::text AS cur
      FROM fn_balances_at(app_tenant(), ${asOf}::date) b JOIN account a ON a.id = b.account_id
      WHERE a.regime = ${s.regime} AND starts_with(a.code, ${s.prefix}) ${s.currency ? sql`AND b.currency_code = ${s.currency}` : sql``}`.execute(trx);
    return { net: D(r.rows[0]!.net), cur: D(r.rows[0]!.cur) };
  }
  const r = await sql<{ net: string; cur: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS net, coalesce(sum(l.amount_currency), 0)::text AS cur
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE ${POSTED} AND l.posting_date <= ${asOf}::date AND ${lineScope(s)} ${currencyOf(s)}`.execute(trx);
  return { net: D(r.rows[0]!.net), cur: D(r.rows[0]!.cur) };
}

const isForeign = (currency: string | undefined): currency is string => !!currency && currency !== 'VND';
const vnd = (d: Decimal) => d.toFixed(0);
const foreign = (d: Decimal) => d.toFixed(4);

export interface CashBalance { debit: string; credit: string; balance: string; balanceCurrency: string }
// Số dư tại ngày: debit/credit là số dư Nợ/Có (một bên bằng 0), balance = Nợ - Có (âm là quỹ âm). balanceCurrency là số dư nguyên tệ của `currency`
// (VND: bằng balance); không chỉ định loại tiền thì '0' vì cộng nhiều loại tiền không có nghĩa. Kiểm kê quỹ (Task 9) gọi hàm này trực tiếp trong giao dịch của nó.
export async function cashBalanceAt(trx: Trx, p: { accountCode: string; bankAccountNo?: string | undefined; currency?: string | undefined; asOf: string }): Promise<CashBalance> {
  const regime = await regimeOf(trx, { from: p.asOf, to: p.asOf });
  await accountsUnder(trx, regime, p.accountCode);
  let bankId: number | undefined;
  if (p.bankAccountNo) {
    const b = await findBank(trx, p.bankAccountNo);
    if (!b.glAccountCode.startsWith(p.accountCode)) throw new AppError('BANK_ACCOUNT_GL_MISMATCH', `Tài khoản ngân hàng ${b.accountNo} thuộc TK ${b.glAccountCode}, không thuộc TK ${p.accountCode}`, 400);
    bankId = b.id;
  }
  const { net, cur } = await netAt(trx, { regime, prefix: p.accountCode, bankId, currency: p.currency }, p.asOf);
  return { debit: net.gt(0) ? vnd(net) : '0', credit: net.lt(0) ? vnd(net.neg()) : '0', balance: vnd(net), balanceCurrency: !p.currency ? '0' : isForeign(p.currency) ? foreign(cur) : vnd(cur) };
}

// ---- Sổ quỹ tiền mặt và Sổ tiền gửi ngân hàng ----
export interface BookRow {
  date: string; documentDate: string; voucherId: string; voucherType: string; voucherNo: string | null; receiptNo: string | null; paymentNo: string | null; description: string | null; counterAccounts: string;
  in: string; out: string; balance: string; inCurrency: string | null; outCurrency: string | null; balanceCurrency: string | null;
}
export interface Book {
  kind: 'cash' | 'bank'; accountCode: string; accountName: string; bankAccountNo: string | null; bankAccountLabel: string | null; bankName: string | null; branch: string | null; currency: string | null; from: string; to: string;
  opening: string; openingCurrency: string | null; rows: BookRow[]; totalIn: string; totalOut: string; totalInCurrency: string | null; totalOutCurrency: string | null; closing: string; closingCurrency: string | null;
}
interface LineRow { voucherId: string; voucherType: string; voucherNo: string | null; postingDate: string; documentDate: string; vDesc: string | null; lDesc: string | null; debit: string; credit: string; cur: string; counters: string[]; isReversal: boolean }

export async function cashBook(trx: Trx, p: { kind: 'cash' | 'bank'; accountCode?: string | undefined; bankAccountNo?: string | undefined; currency?: string | undefined; from: string; to: string;
  hideSalary?: boolean | undefined }): Promise<Book> {
  const regime = await regimeOf(trx, p);
  const bank = p.kind === 'bank' && p.bankAccountNo ? await findBank(trx, p.bankAccountNo) : undefined;
  const accountCode = bank ? bank.glAccountCode : p.accountCode;
  if (!accountCode) throw new AppError('VALIDATION', 'Cần tài khoản hoặc số tài khoản ngân hàng', 400);
  if (bank && p.accountCode && !bank.glAccountCode.startsWith(p.accountCode)) throw new AppError('BANK_ACCOUNT_GL_MISMATCH', `Tài khoản ngân hàng ${bank.accountNo} thuộc TK ${bank.glAccountCode}, không thuộc TK ${p.accountCode}`, 400);
  const under = await accountsUnder(trx, regime, accountCode);
  if (p.kind === 'bank' && !under.some((a) => a.subledger_kind === 'bank')) throw new AppError('NOT_BANK_ACCOUNT', `Tài khoản ${accountCode} không phải tài khoản tiền gửi ngân hàng`, 400);
  const acc = under.find((a) => a.code === accountCode);
  // Sổ của tài khoản ngân hàng ngoại tệ mặc định theo loại tiền của tài khoản đó.
  const currency = p.currency ?? (bank && isForeign(bank.currencyCode) ? bank.currencyCode : undefined);
  const scope: Scope = { regime, prefix: accountCode, bankId: p.kind === 'bank' ? (bank ? bank.id : 'none') : undefined, currency };
  const fx = isForeign(currency);

  const opening = await netAt(trx, scope, dayBefore(p.from));
  const lines = (await sql<LineRow>`
    SELECT v.id AS "voucherId", v.voucher_type AS "voucherType", v.voucher_no AS "voucherNo", v.posting_date AS "postingDate", v.document_date AS "documentDate", v.description AS "vDesc", l.description AS "lDesc", (v.reversal_of_id IS NOT NULL) AS "isReversal",
           l.debit::text AS debit, l.credit::text AS credit, l.amount_currency::text AS cur,
           coalesce((SELECT array_agg(DISTINCT c.code ORDER BY c.code) FROM voucher_pair q JOIN account c ON c.id = CASE WHEN q.debit_line_id = l.id THEN q.credit_account_id ELSE q.debit_account_id END
                     WHERE q.voucher_id = l.voucher_id AND q.posting_date = l.posting_date AND (q.debit_line_id = l.id OR q.credit_line_id = l.id)), '{}') AS counters
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE ${POSTED} AND v.posting_date BETWEEN ${p.from}::date AND ${p.to}::date AND l.posting_date BETWEEN ${p.from}::date AND ${p.to}::date AND ${lineScope(scope)} ${currencyOf(scope)}
    ORDER BY l.posting_date, v.voucher_type, v.seq_no, v.id, l.line_no`.execute(trx)).rows;

  // Một dòng sổ cho mỗi chứng từ: Thu = tổng Nợ, Chi = tổng Có của các dòng thuộc sổ.
  interface Agg { meta: LineRow; in: Decimal; out: Decimal; inCur: Decimal; outCur: Decimal; counters: Set<string>; desc: string | null }
  const byVoucher = new Map<string, Agg>();
  for (const l of lines) {
    let a = byVoucher.get(l.voucherId);
    if (!a) byVoucher.set(l.voucherId, a = { meta: l, in: ZERO, out: ZERO, inCur: ZERO, outCur: ZERO, counters: new Set(), desc: l.vDesc ?? l.lDesc });
    a.in = a.in.plus(l.debit); a.out = a.out.plus(l.credit);
    if (D(l.debit).gt(0)) a.inCur = a.inCur.plus(l.cur);
    if (D(l.credit).gt(0)) a.outCur = a.outCur.minus(l.cur);
    for (const c of l.counters) a.counters.add(c);
  }
  // Trong cùng một ngày chứng từ thu (Thu > Chi) xếp trước chứng từ chi (sổ giấy của thủ quỹ không để tồn quỹ âm vì thứ tự lập phiếu); sắp xếp ổn định nên còn lại theo loại, số.
  const ordered = [...byVoucher.values()].sort((x, y) => x.meta.postingDate.localeCompare(y.meta.postingDate) || Number(y.in.gt(y.out)) - Number(x.in.gt(x.out)));

  // Thiếu view_salary: chứng từ chi lương, nộp bảo hiểm, nộp TNCN (có dòng trên tài khoản lương) mất tên tài khoản đối ứng lương và diễn giải (có thể ghi tên nhân viên);
  // số thu/chi giữ nguyên vì là dòng tiền của quỹ và cần cho số dư lũy kế, chi tiết từng nhân viên chỉ có ở chứng từ và sổ chi tiết 334 (đã che theo cờ).
  const hidden = new Set<string>();
  if (p.hideSalary && ordered.length) {
    const ids = await salaryAccountIds(trx);
    if (ids.length) for (const r of await trx.selectFrom('voucher_line').select('voucher_id').distinct().where('voucher_id', 'in', ordered.map((a) => a.meta.voucherId)).where('account_id', 'in', ids)
      .where('posting_date', '>=', p.from).where('posting_date', '<=', p.to).execute()) hidden.add(r.voucher_id);
  }
  const SALARY_HIDDEN = 'Đã ẩn do thiếu quyền xem lương';
  let run = opening.net; let runCur = opening.cur; let totalIn = ZERO; let totalOut = ZERO; let totalInCur = ZERO; let totalOutCur = ZERO;
  const rows: BookRow[] = ordered.map((a) => {
    run = run.plus(a.in).minus(a.out); runCur = runCur.plus(a.inCur).minus(a.outCur);
    totalIn = totalIn.plus(a.in); totalOut = totalOut.plus(a.out); totalInCur = totalInCur.plus(a.inCur); totalOutCur = totalOutCur.plus(a.outCur);
    const m = a.meta; const t = m.voucherType;
    // Phiếu thu/chi thường vào đúng cột của loại; chứng từ đảo (giữ nguyên loại của chứng từ gốc), chứng từ vừa thu vừa chi và loại khác (phiếu kế toán, giấy báo) vào cột theo chiều Nợ/Có.
    const byType = (t === 'PT' || t === 'PC') && !m.isReversal && !(a.in.gt(0) && a.out.gt(0));
    const receipt = byType ? t === 'PT' : a.in.gt(0); const payment = byType ? t === 'PC' : a.out.gt(0);
    return { date: m.postingDate, documentDate: m.documentDate, voucherId: m.voucherId, voucherType: t, voucherNo: m.voucherNo, receiptNo: receipt ? m.voucherNo : null, paymentNo: payment ? m.voucherNo : null,
      description: hidden.has(m.voucherId) ? SALARY_HIDDEN : a.desc,
      counterAccounts: hidden.has(m.voucherId) ? [...new Set([...a.counters].map((c) => (isSalaryCode(regime, c) ? SALARY_HIDDEN : c)))].join(', ') : [...a.counters].join(', '), in: vnd(a.in), out: vnd(a.out), balance: vnd(run),
      inCurrency: fx ? foreign(a.inCur) : null, outCurrency: fx ? foreign(a.outCur) : null, balanceCurrency: fx ? foreign(runCur) : null };
  });
  return { kind: p.kind, accountCode, accountName: acc?.name ?? '', bankAccountNo: bank?.accountNo ?? null, bankName: bank?.bankName ?? null, branch: bank?.branch ?? null,
    bankAccountLabel: p.kind === 'bank' ? (bank ? `${bank.accountNo} – ${bank.bankName}` : UNASSIGNED_LABEL) : null, currency: currency ?? null, from: p.from, to: p.to,
    opening: vnd(opening.net), openingCurrency: fx ? foreign(opening.cur) : null, rows, totalIn: vnd(totalIn), totalOut: vnd(totalOut),
    totalInCurrency: fx ? foreign(totalInCur) : null, totalOutCurrency: fx ? foreign(totalOutCur) : null, closing: vnd(run), closingCurrency: fx ? foreign(runCur) : null };
}

// Bản in theo mẫu S04a-DNN / S07-DN (sổ quỹ) và S05-DNN / S08-DN (sổ tiền gửi); chế độ chưa có văn bản gốc thì in không có dòng "Mẫu số".
export async function bookDoc(trx: Trx, tenantId: string, regime: string, b: Book): Promise<ReportDoc> {
  const key = b.kind === 'cash' ? 'so-quy' : 'so-tien-gui';
  const f = bookFormFor(regime, key);
  const company = { ...(await companyInfo(trx, tenantId, regime, key)), formNo: f?.formNo ?? '', issuedBy: f?.issuedBy ?? '' };
  const fx = isForeign(b.currency ?? undefined);
  const num = (key: string, label: string, scale?: number) => ({ key, label, type: 'number' as const, ...(scale === undefined ? {} : { scale }) });
  const columns = [{ key: 'date', label: 'Ngày ghi sổ', type: 'date' as const, width: '9%' }, { key: 'documentDate', label: 'Ngày chứng từ', type: 'date' as const, width: '9%' },
    { key: 'receiptNo', label: 'Số hiệu chứng từ Thu', width: '9%' }, { key: 'paymentNo', label: 'Số hiệu chứng từ Chi', width: '9%' }, { key: 'description', label: 'Diễn giải' },
    ...(b.kind === 'bank' ? [{ key: 'counterAccounts', label: 'TK đối ứng', width: '8%' }] : []),
    num('in', b.kind === 'cash' ? 'Thu' : 'Thu (gửi vào)'), num('out', b.kind === 'cash' ? 'Chi' : 'Chi (rút ra)'), num('balance', b.kind === 'cash' ? 'Tồn' : 'Còn lại'),
    ...(fx ? [num('inCurrency', `Thu (${b.currency})`, 2), num('outCurrency', `Chi (${b.currency})`, 2), num('balanceCurrency', `Tồn (${b.currency})`, 2)] : [])];
  const place = b.kind === 'cash' ? `Loại quỹ: ${b.accountName} (TK ${b.accountCode})`
    : b.bankAccountNo ? `Nơi mở tài khoản giao dịch: ${b.bankName}${b.branch ? `, ${b.branch}` : ''} – Số hiệu tài khoản tại nơi gửi: ${b.bankAccountNo} (TK ${b.accountCode})` : `TK ${b.accountCode} – ${UNASSIGNED_LABEL}`;
  const bold = { isBold: true };
  return { title: b.kind === 'cash' ? 'Sổ quỹ tiền mặt' : 'Sổ tiền gửi ngân hàng', company, formNo: company.formNo, issuedBy: company.issuedBy, subtitle: `${place} – ${periodSubtitle(b.from, b.to)}`,
    sheetName: b.kind === 'cash' ? `Sổ quỹ ${b.accountCode}` : `Sổ tiền gửi ${b.bankAccountNo ?? b.accountCode}`, landscape: fx || b.kind === 'bank', columns,
    rows: [{ description: 'Số dư đầu kỳ', balance: b.opening, balanceCurrency: b.openingCurrency, ...bold }, ...b.rows as unknown as Record<string, unknown>[],
      { description: 'Cộng số phát sinh trong kỳ', in: b.totalIn, out: b.totalOut, inCurrency: b.totalInCurrency, outCurrency: b.totalOutCurrency, ...bold },
      { description: 'Số dư cuối kỳ', balance: b.closing, balanceCurrency: b.closingCurrency, ...bold }],
    signatures: ['Người lập biểu', 'Kế toán trưởng', 'Người đại diện theo pháp luật'] };
}

// ---- Tồn quỹ âm khi ghi sổ, bỏ ghi sổ và đảo ----
export interface CashWarning { code: 'CASH_NEGATIVE'; message: string }
type CashAction = 'post' | 'unpost' | 'reverse';
const VERB: Record<CashAction, string> = { post: 'Ghi sổ', unpost: 'Bỏ ghi sổ', reverse: 'Đảo chứng từ' };

// Khóa tư vấn theo (công ty, tài khoản quỹ/ngân hàng), lấy theo thứ tự tài khoản để hai phiếu cùng ghi sổ không khóa chéo nhau; giữ đến hết giao dịch.
// Phải lấy TRƯỚC khi ghi sổ và kiểm tra: hai phiếu chi đồng thời, mỗi phiếu vừa quỹ nhưng cộng lại không, sẽ lần lượt (phiếu sau thấy phiếu trước đã ghi) thay vì cùng thấy tồn quỹ cũ.
// Hiện post_voucher đã tuần tự hóa mọi lần ghi sổ của một công ty (mark_balance_stale cập nhật một hàng balance_stale duy nhất), nên khóa này chưa đổi kết quả; giữ để phép kiểm tra không dựa vào chi tiết đó.
// Phép kiểm tra cũng cần giao dịch READ COMMITTED: mỗi câu lệnh sau khi ghi sổ phải thấy dòng vừa ghi và phiếu đã commit của giao dịch khác.
async function lockCashAccounts(trx: Trx, voucherId: string): Promise<void> {
  const ids = await sql<{ id: number }>`SELECT DISTINCT l.account_id AS id FROM voucher_line l JOIN account a ON a.id = l.account_id WHERE l.voucher_id = ${voucherId}::uuid AND a.subledger_kind IN ('cash', 'bank') ORDER BY 1`.execute(trx);
  for (const r of ids.rows) await sql`SELECT pg_advisory_xact_lock(hashtextextended(app_tenant()::text || ':cash:' || ${String(r.id)}, 0))`.execute(trx);
}

interface Net { net: string; cur: string }
interface Tail extends Net { id: number; currency: string; day: string }
interface Base extends Net { id: number; currency: string }
const amountIn = (currency: string, x: Net) => D(currency === 'VND' ? x.net : x.cur);

// Ngày đầu tiên số dư cuối ngày < 0 trong [date, hết dữ liệu] của từng nhóm (id|loại tiền): số dư cuối ngày `date` (base), rồi cộng dồn phát sinh các ngày sau (tail, đã sắp theo ngày).
// Một chứng từ làm giảm quỹ tại ngày d làm giảm số dư cuối ngày của mọi ngày từ d trở đi, nên chứng từ ghi lùi ngày phải xét cả các ngày sau nó.
function firstNegative(keys: string[], base: Base[], tail: Tail[], date: string): Map<string, { day: string; bal: Decimal }> {
  const run = new Map(keys.map((k) => [k, ZERO])); const found = new Map<string, { day: string; bal: Decimal }>();
  for (const b of base) { const k = `${b.id}|${b.currency}`; if (run.has(k)) run.set(k, amountIn(b.currency, b)); }
  for (const [k, bal] of run) if (bal.lt(0)) found.set(k, { day: date, bal });
  for (const t of tail) {
    const k = `${t.id}|${t.currency}`; if (!run.has(k) || found.has(k)) continue;
    const bal = run.get(k)!.plus(amountIn(t.currency, t)); run.set(k, bal);
    if (bal.lt(0)) found.set(k, { day: t.day, bal });
  }
  return found;
}

// Sau khi ghi sổ / bỏ ghi sổ / đảo (trong cùng giao dịch, thấy cả dòng của chính chứng từ): quỹ hoặc tài khoản ngân hàng mà chứng từ làm GIẢM và có ngày nào từ ngày hạch toán trở đi số dư cuối ngày âm.
// Ghi sổ và chứng từ đảo (đã ghi sổ trong reverse_voucher) giảm quỹ khi dòng của chúng làm giảm; bỏ ghi sổ lấy dòng ra khỏi sổ nên giảm quỹ khi dòng đó là thu vào.
// Chứng từ chỉ thu thêm vào quỹ đang âm từ trước không bị chặn. Tiền VND xét theo VND, ngoại tệ xét theo nguyên tệ.
async function cashNegativeWarnings(trx: Trx, voucherId: string, action: CashAction): Promise<CashWarning[]> {
  const v = await trx.selectFrom('voucher').select('posting_date').where('id', '=', voucherId).executeTakeFirstOrThrow();
  const date = v.posting_date;
  const mine = (await sql<{ accountId: number; code: string; kind: string; currency: string; bankAccountId: number | null; net: string; cur: string }>`
    SELECT l.account_id AS "accountId", a.code, a.subledger_kind AS kind, l.currency_code AS currency, l.bank_account_id AS "bankAccountId", sum(l.debit - l.credit)::text AS net, sum(l.amount_currency)::text AS cur
    FROM voucher_line l JOIN account a ON a.id = l.account_id WHERE l.voucher_id = ${voucherId}::uuid AND a.subledger_kind IN ('cash', 'bank')
    GROUP BY l.account_id, a.code, a.subledger_kind, l.currency_code, l.bank_account_id`.execute(trx)).rows;
  if (!mine.length) return [];
  const sign = action === 'unpost' ? -1 : 1;
  const decrease = (currency: string, net: Decimal, cur: Decimal) => (currency === 'VND' ? net : cur).times(sign).lt(0);
  // Cộng theo (tài khoản, loại tiền) và (tài khoản ngân hàng, loại tiền).
  const accs = new Map<string, { accountId: number; code: string; kind: string; currency: string; net: Decimal; cur: Decimal }>();
  const banks = new Map<string, { id: number; accountId: number; currency: string; net: Decimal; cur: Decimal }>();
  for (const m of mine) {
    const ka = `${m.accountId}|${m.currency}`; const a = accs.get(ka) ?? { accountId: m.accountId, code: m.code, kind: m.kind, currency: m.currency, net: ZERO, cur: ZERO };
    accs.set(ka, { ...a, net: a.net.plus(m.net), cur: a.cur.plus(m.cur) });
    if (m.bankAccountId !== null) { const kb = `${m.bankAccountId}|${m.currency}`; const b = banks.get(kb) ?? { id: m.bankAccountId, accountId: m.accountId, currency: m.currency, net: ZERO, cur: ZERO }; banks.set(kb, { ...b, net: b.net.plus(m.net), cur: b.cur.plus(m.cur) }); }
  }
  const out: CashWarning[] = []; const when = formatVnDate(date);
  const show = (currency: string, bal: Decimal) => currency === 'VND' ? `${formatVnNumber(bal.abs().toString())} đ` : `${formatVnNumber(bal.abs().toString(), 2)} ${currency}`;
  const warn = (label: string, currency: string, f: { day: string; bal: Decimal }) => out.push({ code: 'CASH_NEGATIVE',
    message: `${VERB[action]} làm ${label} âm ${show(currency, f.bal)} tại ngày ${formatVnDate(f.day)}${f.day === date ? '' : ` (chứng từ hạch toán ngày ${when})`}` });

  const dropping = [...accs.values()].filter((a) => decrease(a.currency, a.net, a.cur));
  if (dropping.length) {
    const ids = dropping.map((a) => a.accountId);
    const base = (await sql<Base>`SELECT b.account_id AS id, b.currency_code AS currency, sum(b.debit - b.credit)::text AS net, sum(b.debit_cur - b.credit_cur)::text AS cur
      FROM fn_balances_at(app_tenant(), ${date}::date) b WHERE b.account_id = ANY(${ids}::bigint[]) GROUP BY b.account_id, b.currency_code`.execute(trx)).rows;
    const tail = (await sql<Tail>`SELECT l.account_id AS id, l.currency_code AS currency, l.posting_date::text AS day, sum(l.debit - l.credit)::text AS net, sum(l.amount_currency)::text AS cur
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id WHERE ${POSTED} AND l.account_id = ANY(${ids}::bigint[]) AND l.posting_date > ${date}::date
      GROUP BY l.account_id, l.currency_code, l.posting_date ORDER BY l.posting_date`.execute(trx)).rows;
    const found = firstNegative(dropping.map((a) => `${a.accountId}|${a.currency}`), base, tail, date);
    for (const a of dropping) { const f = found.get(`${a.accountId}|${a.currency}`); if (f) warn(`${a.kind === 'cash' ? 'tồn quỹ tiền mặt' : 'số dư tiền gửi'} TK ${a.code}`, a.currency, f); }
  }
  const bankDrop = [...banks.values()].filter((b) => decrease(b.currency, b.net, b.cur));
  if (bankDrop.length) {
    const ids = bankDrop.map((b) => b.id); const accountIds = [...new Set(bankDrop.map((b) => b.accountId))];
    // Chỉ mục voucher_line theo (tài khoản, ngày): lọc thêm theo tài khoản sổ cái để dùng chỉ mục, rồi theo tài khoản ngân hàng.
    const scope = sql`${POSTED} AND l.account_id = ANY(${accountIds}::bigint[]) AND l.bank_account_id = ANY(${ids}::bigint[])`;
    const base = (await sql<Base>`SELECT l.bank_account_id AS id, l.currency_code AS currency, sum(l.debit - l.credit)::text AS net, sum(l.amount_currency)::text AS cur
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id WHERE ${scope} AND l.posting_date <= ${date}::date GROUP BY l.bank_account_id, l.currency_code`.execute(trx)).rows;
    const tail = (await sql<Tail>`SELECT l.bank_account_id AS id, l.currency_code AS currency, l.posting_date::text AS day, sum(l.debit - l.credit)::text AS net, sum(l.amount_currency)::text AS cur
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id WHERE ${scope} AND l.posting_date > ${date}::date
      GROUP BY l.bank_account_id, l.currency_code, l.posting_date ORDER BY l.posting_date`.execute(trx)).rows;
    const found = firstNegative(bankDrop.map((b) => `${b.id}|${b.currency}`), base, tail, date);
    const labels = new Map((await trx.selectFrom('bank_account').select(['id', 'account_no', 'gl_account_code']).where('id', 'in', ids).execute()).map((r) => [r.id, r]));
    for (const b of bankDrop) { const f = found.get(`${b.id}|${b.currency}`); const r = labels.get(b.id); if (f) warn(`số dư tiền gửi tài khoản ngân hàng ${r?.account_no ?? b.id} (TK ${r?.gl_account_code ?? ''})`, b.currency, f); }
  }
  return out;
}

// warn: trả chứng từ kèm `warnings`; block: ném 409 CASH_NEGATIVE, cả giao dịch hoàn tác (ghi sổ/bỏ ghi sổ/đảo không xảy ra).
function applyMode<T extends object>(mode: string, dto: T, warnings: CashWarning[]): T & { warnings?: CashWarning[] } {
  if (!warnings.length) return dto;
  if (mode === 'block') throw new AppError('CASH_NEGATIVE', warnings.map((w) => w.message).join('; '), 409);
  return { ...dto, warnings };
}

// Ghi sổ có kiểm tra tồn quỹ âm theo cài đặt `cash_negative`.
export async function postWithCashCheck(trx: Trx, tenantId: string, id: string): Promise<S.VoucherDto & { warnings?: CashWarning[] }> {
  const mode = (await getSettings(trx, tenantId)).cash_negative;
  await lockCashAccounts(trx, id);
  const dto = await S.postVoucher(trx, id);
  return applyMode(mode, dto, await cashNegativeWarnings(trx, id, 'post'));
}
// Bỏ ghi sổ chứng từ thu tiền làm các ngày sau có thể bị âm quỹ: cùng phép kiểm tra, dòng chứng từ bị lấy khỏi sổ.
export async function unpostWithCashCheck(trx: Trx, tenantId: string, id: string): Promise<S.VoucherDto & { warnings?: CashWarning[] }> {
  const mode = (await getSettings(trx, tenantId)).cash_negative;
  await lockCashAccounts(trx, id);
  const dto = await S.unpostVoucher(trx, id);
  return applyMode(mode, dto, await cashNegativeWarnings(trx, id, 'unpost'));
}
// Đảo chứng từ: chứng từ đảo được ghi sổ ngay trong reverse_voucher nên kiểm tra sau đó, trong cùng giao dịch.
export async function reverseWithCashCheck(trx: Trx, tenantId: string, id: string, input: { postingDate: string; description?: string | undefined }): Promise<S.VoucherDto & { warnings?: CashWarning[] }> {
  const mode = (await getSettings(trx, tenantId)).cash_negative;
  await lockCashAccounts(trx, id);
  const dto = await S.reverseVoucher(trx, id, input);
  return applyMode(mode, dto, await cashNegativeWarnings(trx, dto.id, 'reverse'));
}
