import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { voucherListRowsByIds, type VoucherListRow } from '../ledger/vouchers.service.js';

type Trx = Transaction<Database>;
export interface DuplicatePair { a: VoucherListRow; b: VoucherListRow; reasons: string[] }
// truncated: còn cặp ngoài trần; hiddenBySensitive: người gọi thiếu ít nhất một cờ nhạy cảm nên chứng từ có tài khoản tương ứng không được xét.
export interface DuplicateResult { pairs: DuplicatePair[]; truncated: boolean; hiddenBySensitive: boolean }
// shortcut: trần số cặp trả về một lần (kèm cờ truncated), người dùng thu hẹp khoảng ngày hoặc xử lý bớt rồi tìm lại; nâng cấp khi cần phân trang.
export const MAX_PAIRS = 500;

// Tìm cặp chứng từ nghi trùng: giữ cặp nếu ít nhất một chứng từ nằm trong khoảng ngày ghi sổ (quét rộng thêm max(days_window) mỗi phía để bắt cặp vắt biên). Một câu SQL tập hợp: tổng Nợ mỗi chứng từ tính một lần, ghép cặp theo quy tắc
// (cùng công ty, cùng tổng tiền băm bằng hash join, trong cửa sổ ngày, đúng cặp loại). Không vòng lặp JS trên N^2.
// - Chỉ chứng từ nháp và đã ghi sổ, bỏ chứng từ đảo và kết chuyển; đã đảo/đã hủy không còn là ứng viên.
// - Tập tài khoản đối ứng có bên: 'D:331' khác 'C:331' (hóa đơn ghi Có 331 rồi phiếu chi Nợ 331 là thanh toán, không phải trùng). Dùng các tài khoản công nợ của chứng từ; không có công nợ thì
//   dùng tập tài khoản không phải tiền.
// - Hóa đơn: nếu cả hai có bảng kê hóa đơn thì phải chung ít nhất một hóa đơn (khóa fn_invoice_key); chung hóa đơn xếp trước.
// - Cờ nhạy cảm (khớp sensitiveDenial/flagsOf ở packages/domain/src/permissions.ts, sửa một nơi phải sửa cả hai): chứng từ có dòng trên tài khoản mà người gọi không được xem (công nợ, giá vốn) bị loại ngay trong truy vấn, nên số tiền và đối tượng không lộ qua màn này.
export async function findDuplicates(trx: Trx, tenantId: string, auth: { sensitive: Set<string> }, f: { from: string; to: string }, max = MAX_PAIRS): Promise<DuplicateResult> {
  const hideAr = !auth.sensitive.has('view_receivable'); const hideAp = !auth.sensitive.has('view_payable'); const hideCost = !auth.sensitive.has('view_cost');
  const w = (await trx.selectFrom('voucher_dup_rule').select(sql<number>`coalesce(max(days_window), 0)::int`.as('w')).where('tenant_id', '=', tenantId).where('is_active', '=', true).executeTakeFirst())?.w ?? 0;
  const { rows } = await sql<{ a_id: string; b_id: string; gap: number; same_party: boolean; same_counter: boolean; same_invoice: boolean }>`
    WITH rules AS (SELECT * FROM voucher_dup_rule WHERE tenant_id = ${tenantId}::uuid AND is_active),
    cand AS (
      SELECT v.id, v.voucher_type, v.posting_date, v.party_id FROM voucher v
      WHERE v.tenant_id = ${tenantId}::uuid AND v.posting_date BETWEEN ${f.from}::date - ${w}::int AND ${f.to}::date + ${w}::int AND v.state IN ('draft', 'posted')
        AND v.reversal_of_id IS NULL AND NOT v.is_closing AND v.voucher_type IN (SELECT type_a FROM rules UNION SELECT type_b FROM rules)),
    agg AS (
      SELECT l.voucher_id, sum(l.debit) AS total,
        coalesce(array_agg(DISTINCT (CASE WHEN l.debit > 0 THEN 'D:' ELSE 'C:' END) || a.code ORDER BY (CASE WHEN l.debit > 0 THEN 'D:' ELSE 'C:' END) || a.code) FILTER (WHERE a.subledger_kind IN ('receivable', 'payable')), '{}') AS arap,
        coalesce(array_agg(DISTINCT (CASE WHEN l.debit > 0 THEN 'D:' ELSE 'C:' END) || a.code ORDER BY (CASE WHEN l.debit > 0 THEN 'D:' ELSE 'C:' END) || a.code) FILTER (WHERE a.subledger_kind IS NULL OR a.subledger_kind NOT IN ('cash', 'bank', 'receivable', 'payable')), '{}') AS other,
        bool_or((${hideAr} AND a.subledger_kind = 'receivable') OR (${hideAp} AND a.subledger_kind = 'payable') OR (${hideCost} AND a.code LIKE '632%')) AS hidden
      FROM voucher_line l JOIN cand c ON c.id = l.voucher_id AND c.posting_date = l.posting_date JOIN account a ON a.id = l.account_id
      WHERE l.tenant_id = ${tenantId}::uuid AND l.posting_date BETWEEN ${f.from}::date - ${w}::int AND ${f.to}::date + ${w}::int
      GROUP BY l.voucher_id HAVING sum(l.debit) > 0),
    side AS (SELECT voucher_id, total, hidden, CASE WHEN cardinality(arap) > 0 THEN arap ELSE other END AS ckey, cardinality(arap) > 0 OR cardinality(other) > 0 AS has_ckey FROM agg),
    inv AS (
      SELECT vi.voucher_id, array_agg(DISTINCT vi.direction || ':' || fn_invoice_key(vi.party_tax_code) || ':' || fn_invoice_key(vi.serial) || ':' || fn_invoice_key(vi.invoice_no)
        || CASE WHEN fn_invoice_key(vi.party_tax_code) = '' THEN ':' || coalesce(vi.party_id::text, '') ELSE '' END) AS keys
      FROM voucher_invoice vi JOIN cand c ON c.id = vi.voucher_id WHERE vi.tenant_id = ${tenantId}::uuid GROUP BY vi.voucher_id),
    pairs AS (
      SELECT DISTINCT ON (least(a.id, b.id), greatest(a.id, b.id)) a.id AS a_id, b.id AS b_id, abs(a.posting_date - b.posting_date) AS gap,
        a.party_id IS NOT NULL AND a.party_id = b.party_id AS same_party,
        sa.has_ckey AND sa.ckey = sb.ckey AS same_counter, coalesce(ia.keys && ib.keys, false) AS same_invoice, a.posting_date AS a_date
      FROM rules r
      JOIN cand a ON a.voucher_type = r.type_a
      JOIN cand b ON b.voucher_type = r.type_b AND b.id <> a.id AND b.posting_date BETWEEN a.posting_date - r.days_window AND a.posting_date + r.days_window
      JOIN side sa ON sa.voucher_id = a.id
      JOIN side sb ON sb.voucher_id = b.id AND sb.total = sa.total
      LEFT JOIN inv ia ON ia.voucher_id = a.id LEFT JOIN inv ib ON ib.voucher_id = b.id
      WHERE (r.type_a <> r.type_b OR a.id < b.id) AND NOT sa.hidden AND NOT sb.hidden
        AND (a.posting_date BETWEEN ${f.from}::date AND ${f.to}::date OR b.posting_date BETWEEN ${f.from}::date AND ${f.to}::date)
        AND (NOT r.match_party OR a.party_id IS NOT DISTINCT FROM b.party_id)
        AND (NOT r.match_counter_account OR sa.ckey = sb.ckey)
        AND (ia.keys IS NULL OR ib.keys IS NULL OR ia.keys && ib.keys)
        AND NOT EXISTS (SELECT 1 FROM voucher_dup_ignore g WHERE g.tenant_id = ${tenantId}::uuid AND g.voucher_a = least(a.id, b.id) AND g.voucher_b = greatest(a.id, b.id))
      ORDER BY least(a.id, b.id), greatest(a.id, b.id))
    SELECT a_id, b_id, gap, same_party, same_counter, same_invoice FROM pairs
    ORDER BY same_invoice DESC, a_date DESC, a_id, b_id LIMIT ${max + 1}`.execute(trx);
  const kept = rows.slice(0, max);
  const byId = await voucherListRowsByIds(trx, kept.flatMap((r) => [r.a_id, r.b_id]));
  const pairs = kept.map((r) => ({ a: byId.get(r.a_id)!, b: byId.get(r.b_id)!, reasons: [
    'Cùng số tiền',
    r.gap === 0 ? 'Cùng ngày ghi sổ' : `Cách nhau ${r.gap} ngày`,
    ...(r.same_party ? ['Cùng đối tượng'] : []),
    ...(r.same_counter ? ['Cùng tài khoản đối ứng'] : []),
    ...(r.same_invoice ? ['Cùng hóa đơn'] : []),
  ] }));
  return { pairs, truncated: rows.length > max, hiddenBySensitive: hideAr || hideAp || hideCost };
}

// Ghi cặp "không trùng": voucher_a < voucher_b (chuẩn hóa ở đây, CHECK ở DB). Cả hai chứng từ phải thuộc công ty (RLS) — nếu không là 404.
export async function ignorePair(trx: Trx, tenantId: string, userId: string, a: string, b: string): Promise<void> {
  if (a === b) throw new AppError('DEDUPE_SAME_VOUCHER', 'Hai chứng từ phải khác nhau', 400);
  const found = await trx.selectFrom('voucher').select('id').where('id', 'in', [a, b]).execute();
  if (found.length !== 2) throw new AppError('VOUCHER_NOT_FOUND', 'Không tìm thấy chứng từ', 404);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  await trx.insertInto('voucher_dup_ignore').values({ tenant_id: tenantId, voucher_a: lo, voucher_b: hi, created_by: userId }).onConflict((oc) => oc.doNothing()).execute();
}
