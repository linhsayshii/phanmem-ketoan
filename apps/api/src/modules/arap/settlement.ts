import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { dateIso } from '../ledger/vouchers.service.js';
import { accountsUnder, assertSensitive, regimeOf } from '../reporting/ledgers.js';

type Trx = Transaction<Database>;
type Auth = { sensitive: Set<string> };

// Quy tắc đối trừ ở SQL (settle_open_items, auto_settle, unsettle; seed và kiểm thử dùng chung); ở đây chỉ dịch mã sang id, kiểm cờ nhạy cảm và gọi hàm.
const positive = (s: string) => /[1-9]/.test(s); // đã qua regex số không âm: lớn hơn 0 khi có chữ số khác 0 (không gọi D(): refine vẫn chạy khi regex sai)
export const settleInput = z.object({
  debitItemId: z.number().int().positive(), creditItemId: z.number().int().positive(),
  amount: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG).refine(positive, 'Số tiền đối trừ phải lớn hơn 0').optional(),
  amountCurrency: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/).refine(positive, 'Số nguyên tệ đối trừ phải lớn hơn 0').optional(), date: dateIso.optional(),
});
export const autoInput = z.object({ accountCode: z.string().min(1), partyCode: z.string().min(1).optional(), date: dateIso });
export const listQuery = z.object({ accountCode: z.string().min(1), partyCode: z.string().min(1).optional(), from: dateIso.optional(), to: dateIso.optional() });

async function partyId(trx: Trx, code: string | undefined): Promise<string | null> {
  if (!code) return null;
  const p = await trx.selectFrom('party').select('id').where('code', '=', code).executeTakeFirst();
  if (!p) throw new AppError('PARTY_NOT_FOUND', `Không có đối tượng ${code}`, 404);
  return p.id;
}

// Đối trừ thủ công một khoản Nợ với một khoản Có (khoản VND theo số tiền, khoản ngoại tệ theo số nguyên tệ); không có ngày thì lấy ngày của khoản sau.
export async function settle(trx: Trx, auth: Auth, input: z.infer<typeof settleInput>) {
  const items = await trx.selectFrom('open_item as o').innerJoin('account as a', 'a.id', 'o.account_id').select(['o.id', 'o.currency_code', 'a.code', 'a.subledger_kind'])
    .where('o.id', 'in', [input.debitItemId, input.creditItemId]).execute();
  for (const id of [input.debitItemId, input.creditItemId]) if (!items.some((i) => i.id === id)) throw new AppError('OPEN_ITEM_NOT_FOUND', `Không có khoản công nợ ${id}`, 404);
  for (const i of items) assertSensitive(auth, i);
  const vnd = items.find((i) => i.id === input.debitItemId)!.currency_code === 'VND';
  if (vnd ? !input.amount : !input.amountCurrency) throw new AppError('VALIDATION', vnd ? 'Đối trừ khoản VND phải có số tiền' : 'Đối trừ khoản ngoại tệ phải có số nguyên tệ', 400);
  const groupId = randomUUID();
  const r = await sql<{ ids: (string | number)[] }>`SELECT settle_open_items(${input.debitItemId}, ${input.creditItemId}, ${input.amountCurrency ?? null}::numeric, ${input.amount ?? null}::numeric,
    ${input.date ?? null}::date, 'manual', ${groupId}::uuid) AS ids`.execute(trx);
  const fx = await trx.selectFrom('settlement').select('fx_voucher_id').where('group_id', '=', groupId).where('fx_voucher_id', 'is not', null).executeTakeFirst();
  return { groupId, settlementIds: r.rows[0]!.ids.map(Number), fxVoucherId: fx?.fx_voucher_id ?? null };
}

const AUTO_SETTLE_CAP = 10000; // LIMIT trong auto_settle (0029)
// Đối trừ tự động trên tài khoản (cả tài khoản con theo dõi công nợ), một đối tượng hoặc mọi đối tượng, đến ngày `date`.
export async function autoSettle(trx: Trx, auth: Auth, input: z.infer<typeof autoInput>) {
  const regime = await regimeOf(trx, { from: input.date, to: input.date });
  const accounts = await accountsUnder(trx, regime, input.accountCode);
  for (const a of accounts) assertSensitive(auth, a);
  const party = await partyId(trx, input.partyCode);
  const ids = await trx.selectFrom('account').select('id').where('regime', '=', regime).where('code', 'in', accounts.map((a) => a.code)).where('reconcile', '=', true).where('is_group', '=', false).orderBy('code').execute();
  let groups = 0; let more = false;
  for (const a of ids) {
    const n = (await sql<{ n: number }>`SELECT auto_settle(${a.id}, ${party}::uuid, ${input.date}::date) AS n`.execute(trx)).rows[0]!.n;
    groups += n; more ||= n >= AUTO_SETTLE_CAP;
  }
  return { groups, more }; // more: một tài khoản chạm giới hạn mỗi lần, còn cặp chưa đối trừ, chạy lại để tiếp
}

// Hủy một lần đối trừ (nhóm); cờ nhạy cảm theo tài khoản của các khoản trong nhóm.
export async function unsettle(trx: Trx, auth: Auth, groupId: string) {
  const accounts = await trx.selectFrom('settlement as s').innerJoin('open_item as o', 'o.id', 's.debit_item_id').innerJoin('account as a', 'a.id', 'o.account_id')
    .select(['a.code', 'a.subledger_kind']).distinct().where('s.group_id', '=', groupId).execute();
  for (const a of accounts) assertSensitive(auth, a);
  await sql`SELECT unsettle(${groupId}::uuid)`.execute(trx);
}

export interface SettlementDto {
  id: number; groupId: string; kind: string; settleDate: string; accountCode: string; partyCode: string; currency: string;
  debitItemId: number; debitDocNo: string | null; creditItemId: number; creditDocNo: string | null; amount: string; amountCurrency: string;
  fxVoucherId: string | null; fxVoucherNo: string | null; createdAt: string;
}
// Các dòng đối trừ trên tài khoản (cả tài khoản con), theo đối tượng và khoảng ngày đối trừ nếu có.
export async function listSettlements(trx: Trx, auth: Auth, tenantId: string, q: z.infer<typeof listQuery> & { today: string }): Promise<SettlementDto[]> {
  const regime = await regimeOf(trx, { from: q.from ?? q.to ?? q.today, to: q.to ?? q.from ?? q.today });
  const accounts = await accountsUnder(trx, regime, q.accountCode);
  for (const a of accounts) assertSensitive(auth, a);
  const party = await partyId(trx, q.partyCode);
  const r = await sql<SettlementDto>`SELECT s.id, s.group_id AS "groupId", s.kind, s.settle_date AS "settleDate", a.code AS "accountCode", p.code AS "partyCode", d.currency_code AS currency,
      s.debit_item_id AS "debitItemId", d.doc_no AS "debitDocNo", s.credit_item_id AS "creditItemId", c.doc_no AS "creditDocNo", s.amount, s.amount_currency AS "amountCurrency",
      s.fx_voucher_id AS "fxVoucherId", fv.voucher_no AS "fxVoucherNo", s.created_at AS "createdAt"
    FROM settlement s JOIN open_item d ON d.id = s.debit_item_id JOIN open_item c ON c.id = s.credit_item_id JOIN account a ON a.id = d.account_id JOIN party p ON p.id = d.party_id
      LEFT JOIN voucher fv ON fv.id = s.fx_voucher_id
    WHERE s.tenant_id = ${tenantId}::uuid AND a.regime = ${regime} AND a.code = ANY(${accounts.map((a) => a.code)}::text[])
      ${party ? sql`AND d.party_id = ${party}::uuid` : sql``} ${q.from ? sql`AND s.settle_date >= ${q.from}::date` : sql``} ${q.to ? sql`AND s.settle_date <= ${q.to}::date` : sql``}
    ORDER BY s.settle_date, s.id`.execute(trx);
  return r.rows;
}
