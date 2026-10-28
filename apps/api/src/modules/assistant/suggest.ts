import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, sensitiveDenial } from '@kt/domain';
import { isSalaryCode } from '../payroll/accounts.js';
import { rankSuggestions, type HistVoucher, type Suggestion } from './rank.js';

type Trx = Transaction<Database>;
type Auth = { sensitive: Set<string> };

export const suggestInput = z.object({
  voucherType: z.string().min(1).max(10).optional(),
  partyCode: z.string().min(1).max(30).optional(),
  description: z.string().max(500).optional(),
  itemCodes: z.array(z.string().min(1).max(30)).max(50).optional(),
  amount: z.string().regex(/^\d{1,16}$/, 'Số tiền VND phải là số nguyên tối đa 16 chữ số').optional(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().min(1).max(10).default(5),
}).refine((b) => !!(b.voucherType || b.partyCode || b.description?.trim() || b.itemCodes?.length), { message: 'Cần ít nhất loại chứng từ, đối tượng, diễn giải hoặc mặt hàng để gợi ý' });
export type SuggestInput = z.infer<typeof suggestInput>;

// Lịch sử lấy tối đa 3.000 chứng từ ghi sổ gần nhất trong 36 tháng; chỉ chứng từ lập tay (không có source_doc: không học từ kết chuyển, khấu hao, giá vốn, lương tự sinh).
export const HISTORY_CAP = 3000;
export const HISTORY_MONTHS = 36;
const SKIP_TYPES = ['DK', 'KC'];

const todayIso = () => new Date().toISOString().slice(0, 10);

export interface SuggestResult { asOf: string; considered: number; suggestions: (Omit<Suggestion, 'lines'> & { lines: { side: 'debit' | 'credit'; accountCode: string; accountName: string }[] })[] }

// RLS của giao dịch (công ty, phạm vi chi nhánh của phiên) lọc chứng từ trước khi vào đây; cờ nhạy cảm áp tiếp: chứng từ có dòng ở tài khoản bị che bị loại khỏi việc học,
// nên gợi ý không lộ cặp tài khoản công nợ, giá vốn, lương cho người không có cờ.
export async function suggestEntry(trx: Trx, auth: Auth, input: SuggestInput): Promise<SuggestResult> {
  const asOf = input.asOf ?? todayIso();
  const from = new Date(Date.UTC(+asOf.slice(0, 4), +asOf.slice(5, 7) - 1 - HISTORY_MONTHS, 1)).toISOString().slice(0, 10);
  const party = input.partyCode ? await trx.selectFrom('party').select('id').where('code', '=', input.partyCode).executeTakeFirst() : undefined;
  const items = input.itemCodes?.length ? await trx.selectFrom('item').select('id').where('code', 'in', input.itemCodes).execute() : [];
  const itemIds = items.map((i) => i.id);

  const conds = [] as ReturnType<typeof sql<boolean>>[];
  if (input.voucherType) conds.push(sql<boolean>`v.voucher_type = ${input.voucherType}`);
  if (party) conds.push(sql<boolean>`(v.party_id = ${party.id}::uuid OR EXISTS (SELECT 1 FROM voucher_line pl WHERE pl.voucher_id = v.id AND pl.posting_date = v.posting_date AND pl.party_id = ${party.id}::uuid))`);
  if (itemIds.length) conds.push(sql<boolean>`EXISTS (SELECT 1 FROM voucher_line il WHERE il.voucher_id = v.id AND il.posting_date = v.posting_date AND il.item_id = ANY(${itemIds}::bigint[]))`);
  // Chỉ có diễn giải: không có khóa tra, xét các chứng từ gần nhất rồi để bộ xếp hạng lọc theo từ khóa.
  const where = conds.length ? sql`(${sql.join(conds, sql` OR `)})` : sql`true`;
  const vs = (await sql<{ id: string; voucher_type: string; posting_date: string; description: string | null; party_code: string | null }>`
    SELECT v.id, v.voucher_type, v.posting_date::text AS posting_date, v.description, p.code AS party_code
    FROM voucher v LEFT JOIN party p ON p.id = v.party_id
    WHERE v.state = 'posted' AND NOT v.is_closing AND v.source_doc_type IS NULL AND v.voucher_type <> ALL(${SKIP_TYPES}::text[])
      AND v.posting_date BETWEEN ${from}::date AND ${asOf}::date AND ${where}
    ORDER BY v.posting_date DESC, v.id LIMIT ${HISTORY_CAP}`.execute(trx)).rows;
  if (vs.length === 0) return { asOf, considered: 0, suggestions: [] };

  const ids = vs.map((v) => v.id); const minDate = vs.reduce((m, v) => (v.posting_date < m ? v.posting_date : m), asOf);
  const lines = (await sql<{ voucher_id: string; account_code: string; regime: string; subledger_kind: string | null; debit: string; credit: string; party_code: string | null; item_code: string | null }>`
    SELECT l.voucher_id, a.code AS account_code, a.regime, a.subledger_kind, l.debit::text AS debit, l.credit::text AS credit, p.code AS party_code, i.code AS item_code
    FROM voucher_line l JOIN account a ON a.id = l.account_id LEFT JOIN party p ON p.id = l.party_id LEFT JOIN item i ON i.id = l.item_id
    WHERE l.voucher_id = ANY(${ids}::uuid[]) AND l.posting_date >= ${minDate}::date`.execute(trx)).rows;

  // Tài khoản hiện dùng được ở kỳ của ngày xét (chế độ kế toán của kỳ chứa asOf; không có kỳ thì chế độ mới nhất của công ty): chữ ký có tài khoản không còn trong hệ thống bị bỏ.
  const reg = (await sql<{ regime: string }>`SELECT regime FROM fiscal_period WHERE period_no BETWEEN 1 AND 15 AND date_from <= ${asOf}::date AND date_to >= ${asOf}::date LIMIT 1`.execute(trx)).rows[0]?.regime
    ?? (await sql<{ regime: string }>`SELECT regime FROM fiscal_period ORDER BY date_from DESC LIMIT 1`.execute(trx)).rows[0]?.regime;
  const accounts = reg ? new Map((await trx.selectFrom('account').select(['code', 'name']).where('regime', '=', reg).where('is_group', '=', false).where('is_active', '=', true).execute()).map((a) => [a.code, a.name])) : null;

  const byVoucher = new Map<string, typeof lines>();
  for (const l of lines) (byVoucher.get(l.voucher_id) ?? byVoucher.set(l.voucher_id, []).get(l.voucher_id)!).push(l);
  const hidden = (l: (typeof lines)[number]) => sensitiveDenial(auth, { subledger_kind: l.subledger_kind, code: l.account_code, salary: isSalaryCode(l.regime, l.account_code) }) !== null;

  const history: HistVoucher[] = [];
  for (const v of vs) {
    const ls = byVoucher.get(v.id) ?? [];
    if (ls.length === 0 || ls.some(hidden)) continue; // thiếu cờ: không học từ chứng từ này
    if (accounts && ls.some((l) => !accounts.has(l.account_code))) continue;
    const total = ls.reduce((a, l) => a.plus(l.debit), D(0));
    history.push({
      id: v.id, voucherType: v.voucher_type, postingDate: v.posting_date, description: v.description, total: total.toFixed(0),
      partyCodes: [...new Set([...(v.party_code ? [v.party_code] : []), ...ls.flatMap((l) => (l.party_code ? [l.party_code] : []))])],
      itemCodes: [...new Set(ls.flatMap((l) => (l.item_code ? [l.item_code] : [])))],
      lines: ls.flatMap((l) => [...(D(l.debit).gt(0) ? [{ side: 'debit' as const, accountCode: l.account_code }] : []), ...(D(l.credit).gt(0) ? [{ side: 'credit' as const, accountCode: l.account_code }] : [])]),
    });
  }
  const ranked = rankSuggestions(history, { voucherType: input.voucherType, partyCode: input.partyCode, description: input.description, itemCodes: input.itemCodes, amount: input.amount, asOf }, input.limit);
  return {
    asOf, considered: history.length,
    suggestions: ranked.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l, accountName: accounts?.get(l.accountCode) ?? '' })) })),
  };
}
