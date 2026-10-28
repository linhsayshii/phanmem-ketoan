import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, type Decimal } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import * as S from '../ledger/vouchers.service.js';
import { dateIso } from '../master/catalogs.js';
import { payrollAccountMaps } from './accounts.js';
import { payrollSourceId } from './post.js';
import { getRun, lockRun } from './runs.js';

// Chi lương, nộp bảo hiểm, nộp thuế TNCN từ bảng lương đã hạch toán (Task 6b): sinh phiếu chi (PC) hoặc giấy báo Nợ (BN) NHÁP, số tiền lấy từ chứng từ LU hiện hành:
// chi lương = dư Có phải trả NLĐ theo nhân viên (một dòng mỗi nhân viên, bỏ số ≤ 0); nộp BH = Có BHXH, BHYT, BHTN; nộp TNCN = Có thuế TNCN.
// Chứng từ là chứng từ thường (source_doc_type 'payroll_payment' không thuộc danh sách chặn): người dùng sửa, ghi sổ, hủy qua màn hình chứng từ.
type Trx = Transaction<Database>;
export type PayKind = 'pay' | 'insurance' | 'pit';
export const payVoucherInput = z.object({ kind: z.enum(['bank', 'cash']), bankAccountId: z.number().int().positive().optional(), date: dateIso });
const LABEL: Record<PayKind, string> = { pay: 'Chi lương', insurance: 'Nộp bảo hiểm', pit: 'Nộp thuế TNCN' };

// Chế độ kế toán của ngày và ánh xạ tài khoản lương của chế độ đó.
async function mapAt(trx: Trx, date: string) {
  const { regime } = await S.periodOf(trx, date, 'PC');
  const maps = payrollAccountMaps(regime);
  if (maps.length !== 1) throw new AppError('ACCOUNT_MISSING', `Chế độ kế toán ${regime} chưa có ánh xạ tài khoản lương (coa-data/payroll/accounts.json)`, 400);
  return { regime, m: maps[0]! };
}

// Tài khoản tiền: tài khoản kế toán của tài khoản ngân hàng (BN) hoặc tài khoản tiền mặt VND lá đầu tiên của hệ tài khoản (PC: TT99 111, TT133/TT200 1111).
async function moneyAccount(trx: Trx, regime: string, b: z.infer<typeof payVoucherInput>) {
  if (b.kind === 'bank') {
    if (!b.bankAccountId) throw new AppError('VALIDATION', 'Chọn tài khoản ngân hàng chi tiền', 400);
    const ba = await trx.selectFrom('bank_account').select(['account_no', 'gl_account_code', 'currency_code', 'is_active']).where('id', '=', b.bankAccountId).executeTakeFirst();
    if (!ba || !ba.is_active) throw new AppError('BANK_ACCOUNT_NOT_FOUND', 'Không có tài khoản ngân hàng đang dùng này', 404);
    if (ba.currency_code !== 'VND') throw new AppError('VALIDATION', `Tài khoản ngân hàng ${ba.account_no} không phải tài khoản VND`, 400);
    return { voucherType: 'BN', accountCode: ba.gl_account_code, bankAccountNo: ba.account_no };
  }
  const a = await trx.selectFrom('account').select('code').where('regime', '=', regime).where('subledger_kind', '=', 'cash').where('is_group', '=', false).orderBy('code').executeTakeFirst();
  if (!a) throw new AppError('ACCOUNT_MISSING', `Hệ thống tài khoản ${regime} không có tài khoản tiền mặt chi tiết`, 400);
  return { voucherType: 'PC', accountCode: a.code, bankAccountNo: undefined };
}

// Số liệu từ LU: dư Có theo nhân viên trên TK phải trả NLĐ (dòng tạm ứng 141 cũng mang nhân viên, #971) và dư Có theo tài khoản BH/TNCN của chế độ của LU.
async function luAmounts(trx: Trx, luId: string) {
  const lines = await trx.selectFrom('voucher_line as l').innerJoin('account as a', 'a.id', 'l.account_id').leftJoin('employee as e', 'e.id', 'l.employee_id')
    .select(['a.code', 'e.code as employee_code', 'e.name as employee_name', 'l.debit', 'l.credit']).where('l.voucher_id', '=', luId).execute();
  const { regime } = await trx.selectFrom('voucher as v').innerJoin('fiscal_period as p', 'p.fiscal_year', 'v.fiscal_year').select('p.regime').where('v.id', '=', luId).limit(1).executeTakeFirstOrThrow();
  const m = payrollAccountMaps(regime)[0]!;
  const byEmp = new Map<string, { name: string; amount: Decimal }>(); const byAcc = new Map<string, Decimal>();
  for (const l of lines) {
    const net = D(l.credit).minus(l.debit);
    byAcc.set(l.code, (byAcc.get(l.code) ?? D(0)).plus(net));
    if (l.employee_code && l.code === m.payable) { const c = byEmp.get(l.employee_code); if (c) c.amount = c.amount.plus(net); else byEmp.set(l.employee_code, { name: l.employee_name ?? '', amount: net }); }
  }
  const acc = (code: string) => byAcc.get(code) ?? D(0);
  return { byEmp, si: acc(m.si), hi: acc(m.hi), ui: acc(m.ui), pit: acc(m.pit) };
}

/** Lập chứng từ chi nháp cho bảng lương đã hạch toán; đã có chứng từ còn hiệu lực cùng loại → 409 PAYROLL_VOUCHER_EXISTS. */
export async function createPayVoucher(trx: Trx, ctx: { tenantId: string; userId: string }, runId: number, kind: PayKind, b: z.infer<typeof payVoucherInput>) {
  const r = await lockRun(trx, runId);
  if (r.status !== 'posted') throw new AppError('PAYROLL_RUN_NOT_POSTED', 'Bảng lương chưa hạch toán: hạch toán trước khi lập chứng từ chi', 409);
  const cur = await trx.selectFrom('payroll_run_voucher as x').innerJoin('voucher as v', 'v.id', 'x.voucher_id').select(['v.id', 'v.voucher_no', 'v.state'])
    .where('x.run_id', '=', runId).where('x.kind', '=', kind).executeTakeFirst();
  if (cur) throw new AppError('PAYROLL_VOUCHER_EXISTS', `Bảng lương đã có chứng từ ${LABEL[kind].toLowerCase()}${cur.voucher_no ? ` ${cur.voucher_no}` : ''}: hủy chứng từ đó trước khi lập lại`, 409, { voucherId: cur.id, voucherNo: cur.voucher_no, state: cur.state });
  const run = await getRun(trx, ctx.tenantId, runId);
  if (run.stale) throw new AppError('PAYROLL_RUN_STALE', 'Bảng lương cần chạy lại hạch toán (hồ sơ, chấm công hoặc tham số đã đổi): chạy lại trước khi lập chứng từ chi', 409);
  const lu = run.voucherId!;
  const { regime, m } = await mapAt(trx, b.date);
  const money = await moneyAccount(trx, regime, b);
  const a = await luAmounts(trx, lu);
  const desc = `${LABEL[kind]} ${run.name}`;
  const debit: S.LineInput[] = [];
  if (kind === 'pay') {
    for (const [code, e] of [...a.byEmp].sort(([x], [y]) => x.localeCompare(y)))
      if (e.amount.gt(0)) debit.push({ accountCode: m.payable, debit: e.amount.toFixed(0), credit: '0', employeeCode: code, description: `${desc}: ${e.name}` });
  } else {
    const parts: [string, Decimal, string][] = kind === 'insurance'
      ? [[m.si, a.si, 'Nộp bảo hiểm xã hội'], [m.hi, a.hi, 'Nộp bảo hiểm y tế'], [m.ui, a.ui, 'Nộp bảo hiểm thất nghiệp']]
      : [[m.pit, a.pit, 'Nộp thuế TNCN đã khấu trừ']];
    for (const [accountCode, amt, d] of parts) if (amt.gt(0)) debit.push({ accountCode, debit: amt.toFixed(0), credit: '0', description: `${d} ${run.name}` });
  }
  if (!debit.length) throw new AppError('PAYROLL_NOTHING_TO_PAY', `Bảng lương không có số tiền nào để ${LABEL[kind].toLowerCase()}`, 409);
  const total = debit.reduce((s, l) => s.plus(l.debit), D(0)).toFixed(0);
  const v = await S.createSystemVoucher(trx, ctx, {
    voucherType: money.voucherType, postingDate: b.date, documentDate: b.date, description: desc, currencyCode: 'VND',
    ...(money.bankAccountNo && { bankAccountNo: money.bankAccountNo }), ...(kind !== 'pay' && { purpose: kind === 'insurance' ? 'nop_bao_hiem' : 'nop_thue' }),
    lines: [...debit, { accountCode: money.accountCode, debit: '0', credit: total, description: desc }],
  }, { type: 'payroll_payment', id: payrollSourceId(ctx.tenantId, runId) });
  await trx.insertInto('payroll_run_voucher').values({ tenant_id: ctx.tenantId, run_id: runId, kind, voucher_id: v.id, lu_voucher_id: lu }).execute();
  return { runId, kind, voucherId: v.id, voucherType: v.voucherType, voucherNo: v.voucherNo, state: v.state, postingDate: v.postingDate, amount: total, lineCount: v.lines.length };
}

/** Chứng từ chi đang liên kết với bảng lương; stale = lập từ LU khác LU hiện hành (đã chạy lại hoặc hủy hạch toán). */
export async function listPayVouchers(trx: Trx, runId: number) {
  const run = await trx.selectFrom('payroll_run').select('voucher_id').where('id', '=', runId).executeTakeFirst();
  if (!run) throw new AppError('PAYROLL_RUN_NOT_FOUND', 'Không tìm thấy bảng lương', 404);
  const rows = await trx.selectFrom('payroll_run_voucher as x').innerJoin('voucher as v', 'v.id', 'x.voucher_id')
    .select(['x.kind', 'x.voucher_id', 'x.lu_voucher_id', 'x.created_at', 'v.voucher_type', 'v.voucher_no', 'v.state', 'v.posting_date',
      sql<string>`(SELECT coalesce(sum(l.debit), 0)::text FROM voucher_line l WHERE l.voucher_id = v.id AND l.posting_date = v.posting_date)`.as('amount')])
    .where('x.run_id', '=', runId).orderBy('x.id').execute();
  return rows.map((x) => ({ kind: x.kind, voucherId: x.voucher_id, voucherType: x.voucher_type, voucherNo: x.voucher_no, state: x.state, postingDate: x.posting_date, amount: x.amount,
    createdAt: x.created_at, stale: x.lu_voucher_id === null || x.lu_voucher_id !== run.voucher_id }));
}
