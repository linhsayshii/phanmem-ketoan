import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { actualMatrix, matchFrom, matchWhere, signedAmount } from './actuals.js';

type Trx = Transaction<Database>;

export const settingInput = z.object({
  enabled: z.boolean(), warnPct: z.number().int().min(1).max(1000), blockPct: z.number().int().min(1).max(1000).nullable(),
}).refine((s) => s.blockPct === null || s.blockPct >= s.warnPct, { message: 'Mức chặn phải lớn hơn hoặc bằng mức cảnh báo' });
export type BudgetSetting = z.infer<typeof settingInput>;
export const DEFAULT_SETTING: BudgetSetting = { enabled: false, warnPct: 90, blockPct: null };

export async function getSetting(trx: Trx): Promise<BudgetSetting> {
  const r = await trx.selectFrom('budget_setting').select(['enabled', 'warn_pct', 'block_pct']).executeTakeFirst();
  return r ? { enabled: r.enabled, warnPct: r.warn_pct, blockPct: r.block_pct } : DEFAULT_SETTING;
}
export async function putSetting(trx: Trx, tenantId: string, s: BudgetSetting): Promise<BudgetSetting> {
  await sql`INSERT INTO budget_setting (tenant_id, enabled, warn_pct, block_pct) VALUES (${tenantId}::uuid, ${s.enabled}, ${s.warnPct}, ${s.blockPct})
    ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, warn_pct = EXCLUDED.warn_pct, block_pct = EXCLUDED.block_pct`.execute(trx);
  return s;
}

export interface BudgetWarning { code: 'BUDGET_WARNING'; message: string; accountPrefix: string; lineNo: number; pct: string | null }

// Kiểm tra sau khi ghi sổ một chứng từ do người dùng lập (gọi từ postWithCashCheck, cùng giao dịch): với mỗi dòng ngân sách chi phí mà chứng từ làm tăng thực tế,
// so thực tế lũy kế đến tháng của chứng từ với ngân sách lũy kế đến tháng đó. Từ mức chặn: ném 409 BUDGET_EXCEEDED (giao dịch ghi sổ bị hủy); từ mức cảnh báo: trả cảnh báo.
// Không nêu số tiền trong thông báo (người ghi sổ có thể không có cờ xem giá vốn, công nợ). Chứng từ hệ thống (giá vốn, khấu hao, kết chuyển...) không bị kiểm tra.
export async function budgetCheck(trx: Trx, voucherId: string): Promise<BudgetWarning[]> {
  const s = await getSetting(trx);
  if (!s.enabled) return [];
  const v = await trx.selectFrom('voucher').select(['fiscal_year', 'period_no', 'state', 'is_closing', 'source_doc_type']).where('id', '=', voucherId).executeTakeFirst();
  if (!v || v.state !== 'posted' || v.is_closing || v.source_doc_type !== null || v.period_no < 1 || v.period_no > 12) return [];
  const b = await trx.selectFrom('budget').select('id').where('fiscal_year', '=', v.fiscal_year).where('status', '=', 'approved').executeTakeFirst();
  if (!b) return [];
  const own = await sql<{ id: string; line_no: number; account_prefix: string }>`SELECT bl.id::text, bl.line_no, bl.account_prefix ${matchFrom(v.fiscal_year)}
    WHERE bl.budget_id = ${b.id} AND l.voucher_id = ${voucherId}::uuid AND left(bl.account_prefix, 1) IN ('1', '2', '6', '8') AND ${matchWhere}
    GROUP BY bl.id HAVING sum(${signedAmount}) > 0 ORDER BY bl.line_no`.execute(trx);
  if (!own.rows.length) return [];
  const actual = await actualMatrix(trx, b.id, v.fiscal_year);
  const budgets = await trx.selectFrom('budget_line').select(['id', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10', 'm11', 'm12']).where('budget_id', '=', b.id).execute();
  const out: BudgetWarning[] = []; const blocked: BudgetWarning[] = [];
  for (const o of own.rows) {
    const bl = budgets.find((x) => x.id === Number(o.id))!;
    const planned = ([bl.m01, bl.m02, bl.m03, bl.m04, bl.m05, bl.m06, bl.m07, bl.m08, bl.m09, bl.m10, bl.m11, bl.m12] as string[]).slice(0, v.period_no).reduce((a, x) => a.plus(x), D(0));
    const spent = (actual.get(Number(o.id)) ?? []).slice(0, v.period_no).reduce((a, x) => a.plus(x), D(0));
    const pct = planned.isZero() ? null : spent.div(planned).times(100);
    const over = (limit: number) => (pct === null ? spent.gt(0) : pct.gte(limit));
    const level = s.blockPct !== null && over(s.blockPct) ? 'block' : over(s.warnPct) ? 'warn' : null;
    if (!level) continue;
    const shown = pct === null ? null : pct.toDecimalPlaces(1).toString();
    const w: BudgetWarning = { code: 'BUDGET_WARNING', accountPrefix: o.account_prefix, lineNo: o.line_no, pct: shown,
      message: `Ngân sách tài khoản ${o.account_prefix} (dòng ${o.line_no}) lũy kế đến tháng ${v.period_no}: ${shown === null ? 'chưa có ngân sách nhưng đã phát sinh' : `đã thực hiện ${shown}%`}` };
    (level === 'block' ? blocked : out).push(w);
  }
  if (blocked.length) throw new AppError('BUDGET_EXCEEDED', `Vượt ngân sách, không ghi sổ được. ${blocked.map((w) => w.message).join('; ')}`, 409, blocked.map((w) => ({ accountPrefix: w.accountPrefix, lineNo: w.lineNo, pct: w.pct })));
  return out;
}
