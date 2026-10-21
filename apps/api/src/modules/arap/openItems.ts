import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { accountsUnder, assertSensitive, regimeOf } from '../reporting/ledgers.js';

type Trx = Transaction<Database>;
// Số tiền có dấu: Nợ dương, Có âm; residual là dư còn lại tại cuối ngày asOf.
export interface OpenItemDto {
  id: number; voucherId: string; voucherNo: string | null; voucherType: string; accountCode: string; partyCode: string; docNo: string | null; docDate: string; dueDate: string | null;
  currency: string; amount: string; amountCurrency: string; residual: string; residualCurrency: string;
}
export interface OpenItemQuery { accountCode: string; partyCode?: string | undefined; asOf: string; onlyOpen: boolean }

// Khoản công nợ của tài khoản (cả tài khoản con) đã ghi sổ đến cuối ngày asOf, theo đối tượng nếu có; onlyOpen bỏ khoản đã đối trừ hết.
// Cờ nhạy cảm kiểm trên mọi tài khoản được đọc (403 nêu cờ thiếu).
export async function listOpenItems(trx: Trx, auth: { sensitive: Set<string> }, tenantId: string, q: OpenItemQuery): Promise<OpenItemDto[]> {
  const regime = await regimeOf(trx, { from: q.asOf, to: q.asOf });
  const accounts = await accountsUnder(trx, regime, q.accountCode);
  for (const a of accounts) assertSensitive(auth, a);
  const party = q.partyCode ? await trx.selectFrom('party').select('id').where('code', '=', q.partyCode).executeTakeFirst() : undefined;
  if (q.partyCode && !party) throw new AppError('PARTY_NOT_FOUND', `Không có đối tượng ${q.partyCode}`, 404);
  const r = await sql<OpenItemDto>`SELECT x.item_id AS id, o.voucher_id AS "voucherId", v.voucher_no AS "voucherNo", v.voucher_type AS "voucherType", a.code AS "accountCode", p.code AS "partyCode",
      o.doc_no AS "docNo", o.doc_date AS "docDate", o.due_date AS "dueDate", o.currency_code AS currency, o.amount::text AS amount, o.amount_currency::text AS "amountCurrency",
      x.residual::text AS residual, x.residual_currency::text AS "residualCurrency"
    FROM fn_open_items_at(${tenantId}::uuid, ${q.asOf}::date) x JOIN open_item o ON o.id = x.item_id JOIN voucher v ON v.id = o.voucher_id
      JOIN account a ON a.id = o.account_id JOIN party p ON p.id = o.party_id
    WHERE a.regime = ${regime} AND a.code = ANY(${accounts.map((a) => a.code)}::text[])
      ${party ? sql`AND o.party_id = ${party.id}::uuid` : sql``} ${q.onlyOpen ? sql`AND (x.residual <> 0 OR x.residual_currency <> 0)` : sql``}
    ORDER BY o.doc_date, o.id`.execute(trx);
  return r.rows;
}
