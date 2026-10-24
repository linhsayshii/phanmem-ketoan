import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { CASH_PURPOSES, D } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { dateIso } from '../master/catalogs.js';
import { createVoucher, type VoucherDto } from '../ledger/vouchers.service.js';
import { postWithCashCheck } from '../cash/books.js';
import { accountsUnder, assertSensitive, regimeOf } from '../reporting/ledgers.js';

type Trx = Transaction<Database>;
type Auth = { sensitive: Set<string> };
type Ctx = { tenantId: string; userId: string; auth: { permissions: Set<string>; sensitive: Set<string> } };

export type Suggestion =
  | { kind: 'voucher'; voucherId: string; voucherNo: string | null; date: string; amount: string; score: number; reasons: string[] }
  | { kind: 'open_item'; openItemId: number; partyCode: string; partyName: string; invoiceNo: string | null; dueDate: string | null; residual: string; score: number; reasons: string[] };

const MAX_SUGGESTIONS = 10;
const DAY_WINDOW = 3;

interface Txn {
  id: number; bank_account_id: number; value_date: string; amount_in: string; amount_out: string; description: string | null; reference: string | null;
  counter_name: string | null; payment_code: string | null; status: string; voucher_id: string | null; account_no: string; gl: string; currency: string;
}
async function loadTxn(trx: Trx, id: number, lock = false): Promise<Txn> {
  const r = await sql<Txn>`SELECT t.id, t.bank_account_id, t.value_date::text, t.amount_in::text, t.amount_out::text, t.description, t.reference, t.counter_name, t.payment_code, t.status, t.voucher_id,
      b.account_no, b.gl_account_code AS gl, b.currency_code AS currency
    FROM bank_transaction t JOIN bank_account b ON b.tenant_id = t.tenant_id AND b.id = t.bank_account_id WHERE t.id = ${id} ${lock ? sql`FOR UPDATE OF t` : sql``}`.execute(trx);
  if (!r.rows[0]) throw new AppError('BANK_TXN_NOT_FOUND', 'Không tìm thấy giao dịch ngân hàng', 404);
  return r.rows[0];
}
const isIn = (t: Txn) => D(t.amount_in).gt(0);
const txnAmount = (t: Txn) => (isIn(t) ? t.amount_in : t.amount_out);

// Số tiền của chứng từ trên tài khoản ngân hàng: dòng Nợ (vào) hoặc dòng Có (ra); tài khoản ngoại tệ theo nguyên tệ.
function sideAmount(inbound: boolean, currency: string) {
  const col = currency === 'VND' ? (inbound ? sql`l.debit` : sql`l.credit`) : sql`abs(l.amount_currency)`;
  return sql`coalesce(sum(${col}) FILTER (WHERE ${inbound ? sql`l.debit > 0` : sql`l.credit > 0`}), 0)`;
}

// --- Chuẩn hóa văn bản để so khớp ---
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toUpperCase();
const alnum = (s: string) => plain(s).replace(/[^A-Z0-9]/g, '');
// Bỏ ngày (24/10/2026, 2026-10-24) và số tiền có dấu phân cách nghìn (12.345.000) trước khi tách từ: các số đó không phải số hóa đơn.
const stripNoise = (s: string) => s.replace(/\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{1,3}(?:[.,]\d{3})+\b/g, ' ');
const tokens = (s: string) => plain(stripNoise(s)).split(/[^A-Z0-9]+/).filter(Boolean);
const noZeros = (s: string) => s.replace(/^([A-Z]*)0+(?=[0-9A-Z])/, '$1');
const MAX_RUN = 4;

// Số hóa đơn / số chứng từ / mã đối tượng có trong diễn giải: so nguyên từ (bỏ số 0 đầu); khóa có chữ cái so thêm với các từ liền nhau ghép lại ("HD-0456" khớp "HD 0456").
function containsKey(textTokens: string[], key: string | null): boolean {
  if (!key) return false;
  const kt = tokens(key).map(noZeros);
  if (!kt.length) return false;
  const k = kt.join('');
  const norm = textTokens.map(noZeros);
  if (norm.includes(k)) return true;
  if (!/[A-Z]/.test(k)) return false;
  for (let i = 0; i < norm.length; i++) for (let n = 2, run = norm[i]!; n <= MAX_RUN && i + n <= norm.length; n++) { run += norm[i + n - 1]!; if (run === k) return true; }
  return false;
}

export async function suggestMatches(trx: Trx, auth: Auth, txnId: number): Promise<{ suggestions: Suggestion[]; hiddenBySensitivity: boolean }> {
  const t = await loadTxn(trx, txnId);
  const inbound = isIn(t); const amount = txnAmount(t);
  const text = [t.description, t.reference, t.counter_name, t.payment_code].filter(Boolean).join(' ');
  const tAlnum = alnum(text); const tTokens = tokens(text); const tPlain = plain(text);
  const out: Suggestion[] = [];

  // Chứng từ BC (vào) / BN (ra) đã ghi sổ trên đúng tài khoản ngân hàng, đúng số tiền, chưa gắn giao dịch nào, trong ±3 ngày.
  const vs = await sql<{ id: string; voucher_no: string | null; posting_date: string; amount: string; gap: number }>`
    SELECT v.id, v.voucher_no, v.posting_date::text, amt.amount::text AS amount, abs(v.posting_date - ${t.value_date}::date)::int AS gap
    FROM voucher v CROSS JOIN LATERAL (SELECT ${sideAmount(inbound, t.currency)} AS amount FROM voucher_line l WHERE l.voucher_id = v.id AND l.bank_account_id = ${t.bank_account_id}
        AND l.posting_date = v.posting_date) amt
    WHERE v.state = 'posted' AND v.voucher_type = ${inbound ? 'BC' : 'BN'} AND v.posting_date BETWEEN ${t.value_date}::date - ${DAY_WINDOW}::int AND ${t.value_date}::date + ${DAY_WINDOW}::int
      AND amt.amount = ${amount}::numeric AND NOT EXISTS (SELECT 1 FROM bank_transaction x WHERE x.tenant_id = v.tenant_id AND x.voucher_id = v.id)
    ORDER BY gap, v.voucher_no LIMIT 50`.execute(trx);
  for (const v of vs.rows) {
    const same = v.gap === 0;
    out.push({ kind: 'voucher', voucherId: v.id, voucherNo: v.voucher_no, date: v.posting_date, amount: v.amount, score: Math.min(100, 60 + (same ? 10 : 0)),
      reasons: ['Cùng tài khoản ngân hàng, cùng số tiền, chưa gắn giao dịch', same ? 'Cùng ngày' : `Lệch ${v.gap} ngày`] });
  }

  // Khoản công nợ còn dư: 131 cho tiền vào (khoản Nợ), 331 cho tiền ra (khoản Có); thiếu cờ nhạy cảm thì bỏ và báo.
  const accountCode = inbound ? '131' : '331';
  const flag = inbound ? 'view_receivable' : 'view_payable';
  let hidden = false;
  if (!auth.sensitive.has(flag)) hidden = true;
  else {
    const regime = await regimeOf(trx, { from: t.value_date, to: t.value_date });
    const accounts = await accountsUnder(trx, regime, accountCode);
    for (const a of accounts) assertSensitive(auth, a);
    const vnd = t.currency === 'VND';
    const resid = vnd
      ? sql`o.amount - coalesce(d.a, 0) + coalesce(c.a, 0)`
      : sql`o.amount_currency - coalesce(d.ac, 0) + coalesce(c.ac, 0)`;
    const items = await sql<{ id: number; party_code: string; party_name: string; tax_code: string | null; doc_no: string | null; voucher_no: string | null; due_date: string | null; residual: string }>`
      SELECT * FROM (SELECT o.id, p.code AS party_code, p.name AS party_name, p.tax_code, o.doc_no, v.voucher_no, o.due_date::text,
          (${inbound ? resid : sql`-(${resid})`})::text AS residual, o.doc_date
        FROM open_item o JOIN account a ON a.id = o.account_id JOIN party p ON p.id = o.party_id JOIN voucher v ON v.id = o.voucher_id
          LEFT JOIN LATERAL (SELECT sum(s.amount) AS a, sum(s.amount_currency) AS ac FROM settlement s WHERE s.tenant_id = o.tenant_id AND s.debit_item_id = o.id) d ON true
          LEFT JOIN LATERAL (SELECT sum(s.amount) AS a, sum(s.amount_currency) AS ac FROM settlement s WHERE s.tenant_id = o.tenant_id AND s.credit_item_id = o.id) c ON true
        WHERE a.regime = ${regime} AND a.code = ANY(${accounts.map((a) => a.code)}::text[]) AND o.currency_code = ${t.currency}) x
      WHERE x.residual::numeric > 0 ORDER BY x.doc_date DESC, x.id DESC LIMIT 3000`.execute(trx);
    for (const o of items.rows) {
      let score = 0; const reasons: string[] = [];
      if (D(o.residual).eq(amount)) { score += 40; reasons.push('Số dư khoản bằng số tiền giao dịch'); }
      if ([o.doc_no, o.voucher_no, o.party_code].some((k) => containsKey(tTokens, k))) { score += 40; reasons.push('Số hóa đơn, số chứng từ hoặc mã đối tượng có trong diễn giải'); }
      const name = plain(o.party_name).replace(/\s+/g, ' ').trim();
      if ((o.tax_code && alnum(o.tax_code).length >= 8 && tAlnum.includes(alnum(o.tax_code))) || (name.length >= 4 && tPlain.replace(/\s+/g, ' ').includes(name))) { score += 20; reasons.push('Mã số thuế hoặc tên đối tượng có trong diễn giải'); }
      if (score > 0) out.push({ kind: 'open_item', openItemId: o.id, partyCode: o.party_code, partyName: o.party_name, invoiceNo: o.doc_no ?? o.voucher_no, dueDate: o.due_date, residual: o.residual, score: Math.min(100, score), reasons });
    }
  }
  out.sort((x, y) => y.score - x.score);
  return { suggestions: out.slice(0, MAX_SUGGESTIONS), hiddenBySensitivity: hidden };
}

function assertAttachable(t: Txn) {
  if (t.status === 'ignored') throw new AppError('BANK_TXN_STATE', 'Giao dịch đã bỏ qua, hoàn bỏ qua trước khi đối chiếu', 409);
  if (t.status !== 'new' || t.voucher_id) throw new AppError('BANK_TXN_STATE', 'Giao dịch đã được đối chiếu', 409);
}

// Gắn giao dịch với chứng từ đã ghi sổ: đúng tài khoản ngân hàng, đúng chiều và số tiền, chứng từ chưa gắn giao dịch nào.
export async function matchToVoucher(trx: Trx, ctx: { userId: string }, txnId: number, voucherId: string): Promise<void> {
  const t = await loadTxn(trx, txnId, true);
  assertAttachable(t);
  // Khóa dòng chứng từ (FOR SHARE) để bỏ ghi sổ / đảo chạy đồng thời phải chờ giao dịch này xong, không để lại liên kết với chứng từ không còn ghi sổ.
  const v = await trx.selectFrom('voucher').select(['id', 'state', 'reversal_of_id']).where('id', '=', voucherId).forShare().executeTakeFirst();
  if (!v) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ', 404);
  if (v.reversal_of_id) throw new AppError('BANK_MATCH_REVERSAL', 'Không đối chiếu với chứng từ đảo', 409);
  if (v.state !== 'posted') throw new AppError('BANK_MATCH_VOUCHER', 'Chỉ đối chiếu với chứng từ đã ghi sổ', 409);
  if (await trx.selectFrom('bank_transaction').select('id').where('voucher_id', '=', voucherId).executeTakeFirst()) throw new AppError('BANK_MATCH_VOUCHER', 'Chứng từ đã được gắn với một giao dịch khác', 409);
  const inbound = isIn(t);
  const r = await sql<{ amount: string; other: string }>`SELECT ${sideAmount(inbound, t.currency)}::text AS amount, ${sideAmount(!inbound, t.currency)}::text AS other
    FROM voucher_line l WHERE l.voucher_id = ${voucherId}::uuid AND l.bank_account_id = ${t.bank_account_id}`.execute(trx);
  const row = r.rows[0]!;
  if (D(row.amount).isZero() && D(row.other).isZero()) throw new AppError('BANK_MATCH_ACCOUNT', 'Chứng từ không có dòng trên tài khoản ngân hàng của giao dịch', 409);
  if (D(row.amount).isZero()) throw new AppError('BANK_MATCH_DIRECTION', `Chứng từ ghi ${inbound ? 'chi' : 'thu'} trên tài khoản ngân hàng, giao dịch là tiền ${inbound ? 'vào' : 'ra'}`, 409);
  if (!D(row.amount).eq(txnAmount(t))) throw new AppError('BANK_MATCH_AMOUNT', 'Số tiền chứng từ khác số tiền giao dịch', 409);
  try {
    await trx.updateTable('bank_transaction').set({ voucher_id: voucherId, status: 'matched', matched_by: ctx.userId, matched_at: sql`now()` }).where('id', '=', txnId).execute();
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new AppError('BANK_MATCH_VOUCHER', 'Chứng từ đã được gắn với một giao dịch khác', 409); // hai yêu cầu đồng thời cùng gắn một chứng từ
    throw e;
  }
}

export async function unmatch(trx: Trx, txnId: number): Promise<void> {
  const r = await trx.updateTable('bank_transaction').set({ voucher_id: null, status: 'new', matched_by: null, matched_at: null }).where('id', '=', txnId).where('voucher_id', 'is not', null).returning('id').executeTakeFirst();
  if (r) return;
  if (!(await trx.selectFrom('bank_transaction').select('id').where('id', '=', txnId).executeTakeFirst())) throw new AppError('BANK_TXN_NOT_FOUND', 'Không tìm thấy giao dịch ngân hàng', 404);
  throw new AppError('BANK_TXN_STATE', 'Giao dịch chưa gắn chứng từ', 409);
}

export const createFromTxnInput = z.object({
  postingDate: dateIso.optional(), partyCode: z.string().trim().min(1).max(50).optional(), purposeCode: z.string().trim().min(1).max(50).optional(),
  counterAccountCode: z.string().trim().min(1).max(20).optional(), description: z.string().trim().max(1000).optional(),
  settle: z.array(z.object({ openItemId: z.number().int().positive(), amount: z.string().regex(/^\d{1,16}$/, 'Số tiền đối trừ không hợp lệ') })).min(1).max(500).optional(),
  post: z.boolean(),
});
export type CreateFromTxnInput = z.infer<typeof createFromTxnInput>;

// Lập BC (tiền vào) hoặc BN (tiền ra) từ giao dịch bằng dịch vụ chứng từ hiện có, gắn giao dịch; settle thành kế hoạch đối trừ áp khi ghi sổ.
export async function createVoucherFromTxn(trx: Trx, ctx: Ctx, txnId: number, input: CreateFromTxnInput): Promise<VoucherDto> {
  const t = await loadTxn(trx, txnId, true);
  assertAttachable(t);
  if (t.currency !== 'VND') throw new AppError('BANK_FOREIGN_CURRENCY', 'Chưa lập chứng từ tự động cho tài khoản ngoại tệ; lập tay rồi đối chiếu', 400);
  const inbound = isIn(t); const type = inbound ? 'BC' : 'BN';
  const amountD = D(txnAmount(t));
  if (!amountD.isInt()) throw new AppError('BANK_TXN_AMOUNT', 'Số tiền giao dịch có phần lẻ, không lập được chứng từ VND', 400);
  const amount = amountD.toFixed(0);
  const date = input.postingDate ?? t.value_date;
  const regime = await regimeOf(trx, { from: date, to: date });
  const settle = input.settle ?? [];
  let partyCode = input.partyCode;
  const purposeCode =input.purposeCode ?? (settle.length ? (inbound ? 'thu_khach_hang' : 'chi_tra_ncc') : undefined);
  const purpose = purposeCode ? CASH_PURPOSES.find((p) => p.code === purposeCode && (p.types as string[]).includes(type)) : undefined;
  if (purposeCode && !purpose) throw new AppError('VOUCHER_PURPOSE_INVALID', `Mục đích "${purposeCode}" không dùng cho ${inbound ? 'Giấy báo Có' : 'Giấy báo Nợ'}`, 400);
  const bankLine = { accountCode: t.gl, debit: inbound ? amount : '0', credit: inbound ? '0' : amount, bankAccountNo: t.account_no };
  const side = (v: string) => (inbound ? { debit: '0', credit: v } : { debit: v, credit: '0' });
  const lines: Record<string, unknown>[] = [bankLine];
  const total = settle.reduce((s, x) => s.plus(x.amount), D(0));

  if (settle.length) {
    if (total.gt(amount)) throw new AppError('BANK_SETTLE_EXCEEDS', 'Tổng số tiền đối trừ vượt số tiền giao dịch', 400);
    if (!ctx.auth.permissions.has('settlement.create')) throw new AppError('FORBIDDEN', 'Thiếu quyền settlement.create', 403);
    const items = await sql<{ id: number; code: string; subledger_kind: string | null; party_code: string; sign: number }>`SELECT o.id, a.code, a.subledger_kind, p.code AS party_code, sign(o.amount)::int AS sign
      FROM open_item o JOIN account a ON a.id = o.account_id JOIN party p ON p.id = o.party_id WHERE o.id = ANY(${settle.map((s) => s.openItemId)}::bigint[])`.execute(trx);
    for (const i of items.rows) assertSensitive(ctx.auth, i);
    const byId = new Map(items.rows.map((i) => [i.id, i]));
    for (const s of settle) if (!byId.has(s.openItemId)) throw new AppError('OPEN_ITEM_NOT_FOUND', `Không có khoản công nợ ${s.openItemId}`, 404);
    const parties = new Set(items.rows.map((i) => i.party_code));
    if (parties.size > 1 || (partyCode && !parties.has(partyCode))) throw new AppError('BANK_SETTLE_PARTY', 'Các khoản đối trừ phải cùng một đối tượng', 400);
    partyCode = [...parties][0]!;
    for (const i of items.rows) if (!i.code.startsWith(inbound ? '131' : '331') || i.sign !== (inbound ? 1 : -1))
      throw new AppError('BANK_SETTLE_ITEM', `Tiền ${inbound ? 'vào' : 'ra'} chỉ đối trừ khoản ${inbound ? 'phải thu (Nợ 131)' : 'phải trả (Có 331)'}`, 400);
    const byAcc = new Map<string, { sum: ReturnType<typeof D>; plan: { openItemId: number; amount: string }[] }>();
    for (const s of settle) {
      const g = byAcc.get(byId.get(s.openItemId)!.code) ?? { sum: D(0), plan: [] };
      g.sum = g.sum.plus(s.amount); g.plan.push(s); byAcc.set(byId.get(s.openItemId)!.code, g);
    }
    for (const [code, g] of byAcc) lines.push({ accountCode: code, ...side(g.sum.toFixed(0)), partyCode, settle: g.plan });
    const rest = D(amount).minus(total);
    if (rest.gt(0)) lines.push({ accountCode: [...byAcc.keys()][0], ...side(rest.toFixed(0)), partyCode }); // phần dư là khách trả trước / trả trước cho NCC
  } else {
    let counter = input.counterAccountCode;
    if (!counter && purpose) counter = purpose.counterAccounts[regime as keyof typeof purpose.counterAccounts]?.[0];
    if (!counter) throw new AppError('VALIDATION', 'Cần chọn mục đích, tài khoản đối ứng hoặc khoản công nợ để đối trừ', 400);
    if (purpose?.partyRequired && !partyCode) throw new AppError('LINE_PARTY_REQUIRED', `Mục đích "${purpose.label}" cần chọn đối tượng`, 400);
    lines.push({ accountCode: counter, ...side(amount), ...(partyCode ? { partyCode } : {}) });
  }

  const description = input.description ?? t.description ?? undefined;
  const v = await createVoucher(trx, ctx, { voucherType: type, postingDate: date, documentDate: date, description: description ?? null, partyCode: partyCode ?? null, currencyCode: 'VND',
    bankAccountNo: t.account_no, purpose: purposeCode ?? null, personName: t.counter_name?.slice(0, 200) ?? null,
    lines: lines.map((l) => ({ debit: '0', credit: '0', ...l, description: description ?? null })) as Parameters<typeof createVoucher>[2]['lines'] });
  // Gắn trước khi ghi sổ: trigger đổi giao dịch sang "đã đối chiếu" khi chứng từ ghi sổ.
  await trx.updateTable('bank_transaction').set({ voucher_id: v.id, matched_by: ctx.userId }).where('id', '=', txnId).execute();
  return input.post ? await postWithCashCheck(trx, ctx.tenantId, v.id) : v;
}
