import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, loanLongTermPart } from '@kt/domain';

type Trx = Transaction<Database>;
export interface LoanStat {
  id: number; code: string; currency: string; validTo: string | null; principalAccount: string; interestPayableAccount: string;
  outstandingVnd: string; outstandingCur: string; repaidCur: string; drawnCur: string; interestPayable: string; hasOpening: boolean;
}

// Dư nợ gốc, số đã trả, số đã rút (hạn mức) và lãi phải trả của khế ước vay theo sổ cái đến hết `asOf`. Số theo loại tiền khế ước lấy từ amount_currency (có dấu: + Nợ, − Có; dòng VND = Nợ − Có).
// Hạn mức tính trên chứng từ còn hiệu lực: bỏ chứng từ đã đảo và chứng từ đảo.
export async function loanStats(trx: Trx, asOf: string, id?: number): Promise<LoanStat[]> {
  const r = await sql<LoanStat>`
    SELECT c.id::int AS id, c.code, c.currency_code AS currency, c.valid_to::text AS "validTo", lt.principal_account_code AS "principalAccount", lt.interest_payable_account_code AS "interestPayableAccount",
      coalesce(sum(x.credit - x.debit) FILTER (WHERE x.code = lt.principal_account_code), 0)::text AS "outstandingVnd",
      coalesce(-sum(x.ac) FILTER (WHERE x.code = lt.principal_account_code), 0)::text AS "outstandingCur",
      coalesce(sum(x.ac) FILTER (WHERE x.code = lt.principal_account_code AND x.ac > 0 AND x.live), 0)::text AS "repaidCur",
      coalesce(-sum(x.ac) FILTER (WHERE x.code = lt.principal_account_code AND x.ac < 0 AND x.live), 0)::text AS "drawnCur",
      coalesce(sum(x.credit - x.debit) FILTER (WHERE x.code = lt.interest_payable_account_code), 0)::text AS "interestPayable",
      coalesce(bool_or(x.opening) FILTER (WHERE x.code = lt.principal_account_code), false) AS "hasOpening"
    FROM contract c JOIN loan_term lt ON lt.tenant_id = c.tenant_id AND lt.contract_id = c.id
    LEFT JOIN (SELECT l.tenant_id, l.contract_id, a.code, l.debit, l.credit, l.amount_currency AS ac, l.posting_date, (v.state = 'posted' AND v.reversal_of_id IS NULL) AS live, (v.source_doc_type = 'opening_balance') AS opening
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.state IN ('posted','reversed') JOIN account a ON a.id = l.account_id WHERE l.contract_id IS NOT NULL AND l.posting_date <= ${asOf}::date) x
      ON x.tenant_id = c.tenant_id AND x.contract_id = c.id AND x.posting_date <= ${asOf}::date
    WHERE c.kind = 'loan' AND (${id ?? null}::bigint IS NULL OR c.id = ${id ?? null}::bigint)
    GROUP BY c.id, lt.principal_account_code, lt.interest_payable_account_code ORDER BY c.code`.execute(trx);
  return r.rows;
}

// B01 (phần dài hạn của dư Có TK gốc vay): mỗi khế ước vay còn dư nợ tại `asOf` tách theo lịch trả gốc (loanLongTermPart), cộng theo tài khoản gốc; số âm vì dư Có.
// Khế ước ngoại tệ: tỷ lệ dài hạn của nguyên tệ áp vào dư nợ quy đổi VND trên sổ.
export async function loanLongRows(trx: Trx, asOf: string, regime: string): Promise<{ code: string; name: string; kind: string | null; partyCode: null; net: string }[]> {
  const stats = (await loanStats(trx, asOf)).filter((s) => D(s.outstandingCur).gt(0) && D(s.outstandingVnd).gt(0));
  if (!stats.length) return [];
  const inst = (await sql<{ contractId: number; dueDate: string; principal: string }>`SELECT contract_id::int AS "contractId", due_date::text AS "dueDate", principal::text AS principal FROM loan_installment WHERE contract_id = ANY(${stats.map((s) => s.id)}::bigint[])`.execute(trx)).rows;
  const byAccount = new Map<string, ReturnType<typeof D>>();
  for (const s of stats) {
    const sched = inst.filter((i) => i.contractId === s.id);
    // Khế ước mang sang bằng số dư đầu kỳ: các kỳ ghi trong lịch mà dư đầu kỳ không còn là đã trả trước ngày bắt đầu dùng phần mềm.
    const gap = sched.reduce((t, i) => t.plus(i.principal), D(0)).minus(s.drawnCur);
    const pre = s.hasOpening && gap.gt(0) ? gap : D(0);
    const longCur = D(loanLongTermPart(s.outstandingCur, D(s.repaidCur).plus(pre).toString(), sched, asOf, s.validTo));
    const longVnd = s.currency === 'VND' ? longCur : D(s.outstandingVnd).times(longCur).div(s.outstandingCur).toDecimalPlaces(0);
    byAccount.set(s.principalAccount, (byAccount.get(s.principalAccount) ?? D(0)).plus(longVnd));
  }
  const codes = [...byAccount.keys()];
  const accounts = (await sql<{ code: string; name: string; kind: string | null }>`SELECT code, name, subledger_kind AS kind FROM account WHERE regime = ${regime} AND code = ANY(${codes}::text[])`.execute(trx)).rows;
  return accounts.flatMap((a) => { const v = byAccount.get(a.code)!; return v.isZero() ? [] : [{ ...a, partyCode: null, net: v.neg().toString() }]; });
}
