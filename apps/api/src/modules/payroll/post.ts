import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { allocateByRatio, D, formatVnDate, type CostRole, type Decimal } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';
import * as S from '../ledger/vouchers.service.js';
import { payrollAccountMaps } from './accounts.js';
import { monthRange } from './attendance.js';
import { computeLines, getRun, lockRun, refreshRunHash } from './runs.js';

// Hạch toán bảng lương (Quy ước 6, D1, D2, D7b, D8): một chứng từ hệ thống LU mỗi bảng lương, ngày cuối kỳ lương, ghi sổ ngay.
// Nợ chi phí lương (TK theo bộ phận) / Có phải trả NLĐ (gross, theo nhân viên); Nợ chi phí BH, KPCĐ DN / Có BHXH, BHYT, BHTN, KPCĐ;
// Nợ phải trả NLĐ (theo nhân viên) / Có BH phần NLĐ, thuế TNCN, khấu trừ khác. Chỉ dòng phải trả NLĐ mang nhân viên; dòng khác gom theo (TK, bộ phận, vụ việc, khoản mục, đối tượng).
// Chạy lại và hủy hạch toán luôn bằng đảo (như khấu hao GĐ4, assets/periodRun.ts); chứng từ khớp thì giữ (unchanged).
type Trx = Transaction<Database>;
export type Ctx = { tenantId: string; userId: string; canBackdate: boolean };
type Run = Awaited<ReturnType<typeof getRun>>;
type VLine = { accountCode: string; debit: string; credit: string; departmentCode?: string | null; projectCode?: string | null; costItemCode?: string | null; costObjectCode?: string | null; employeeCode?: string | null; description: string };
const lineKey = (l: Omit<VLine, 'description'>) =>
  [l.accountCode, D(l.debit).toFixed(0), D(l.credit).toFixed(0), l.departmentCode ?? '', l.projectCode ?? '', l.costItemCode ?? '', l.costObjectCode ?? '', l.employeeCode ?? ''].join('|');
const mmyyyy = (y: number, m: number) => `${String(m).padStart(2, '0')}/${y}`;

// Kỳ kế toán chứa ngày cuối kỳ lương (chế độ kế toán, trạng thái khóa).
async function periodOfRun(trx: Trx, run: { year: number; month: number }) {
  const { to } = monthRange(run.year, run.month);
  const p = await trx.selectFrom('fiscal_period').select(['regime', 'fiscal_year', 'period_no', 'status']).where('period_no', '>=', 1).where('period_no', '<=', 15)
    .where('date_from', '<=', to).where('date_to', '>=', to).orderBy('period_no').executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Ngày ${formatVnDate(to)} (cuối kỳ lương) không thuộc kỳ kế toán nào đã mở`, 404);
  return { ...p, date: to };
}
function assertWritable(p: Awaited<ReturnType<typeof periodOfRun>>, ctx: Ctx) {
  if (p.status === 'hard_locked') throw new AppError('PERIOD_HARD_LOCKED', `Kỳ ${p.period_no}/${p.fiscal_year} đã khóa cứng: không hạch toán, chạy lại hay hủy hạch toán lương`, 409);
  if (p.status === 'soft_locked' && !ctx.canBackdate) throw new AppError('PERIOD_SOFT_LOCKED', `Kỳ ${p.period_no}/${p.fiscal_year} đã khóa sổ, cần quyền ghi lùi ngày để hạch toán lương`, 409);
}

// Dòng LU từ giá trị cột của bảng lương. Thiếu cấu hình tài khoản chi phí, tài khoản không có hoặc không phải tài khoản lá → 400 ACCOUNT_MISSING.
async function buildLines(trx: Trx, tenantId: string, run: Run, regime: string): Promise<VLine[]> {
  const maps = payrollAccountMaps(regime);
  const m = maps.length === 1 ? maps[0]! : undefined;
  if (!m?.cost || !m.withholding) throw new AppError('ACCOUNT_MISSING', `Chế độ kế toán ${regime} chưa có ánh xạ tài khoản lương (coa-data/payroll/accounts.json)`, 400);
  const ids = run.lines.map((l) => l.employeeId);
  const [emps, splits, cfg, settings] = await Promise.all([
    trx.selectFrom('employee as e').leftJoin('department as d', 'd.id', 'e.department_id').leftJoin('employee_payroll as p', 'p.employee_id', 'e.id').leftJoin('project as pr', 'pr.id', 'p.default_project_id')
      .select(['e.id', 'e.department_id', 'd.code as department_code', 'd.name as department_name', 'pr.code as project_code']).where('e.id', 'in', ids.length ? ids : [-1]).execute(),
    trx.selectFrom('employee_cost_split as s').innerJoin('project as p', 'p.id', 's.project_id').select(['s.employee_id', 'p.code', 's.pct']).where('s.employee_id', 'in', ids.length ? ids : [-1]).orderBy('p.code').execute(),
    trx.selectFrom('department_cost_account as c').leftJoin('cost_item as ci', 'ci.id', 'c.cost_item_id').leftJoin('cost_object as co', 'co.id', 'c.cost_object_id')
      .select(['c.department_id', 'c.kind', 'c.role', 'c.account_code', 'ci.code as cost_item_code', 'co.code as cost_object_code']).execute(),
    getSettings(trx, tenantId),
  ]);
  const cfgOf = new Map(cfg.map((c) => [`${c.department_id}:${c.kind}`, c]));
  const empOf = new Map(emps.map((e) => [e.id, e]));
  const missing = new Set<string>();
  // Tài khoản chi phí: cấu hình bộ phận (BH thiếu thì theo lương) → tài khoản mặc định công ty → thiếu.
  const costOf = (e: (typeof emps)[number], kind: 'payroll' | 'insurance') => {
    const c = e.department_id === null ? undefined : (cfgOf.get(`${e.department_id}:${kind}`) ?? cfgOf.get(`${e.department_id}:payroll`));
    const account = c ? (c.account_code ?? m.cost![c.role as CostRole]) : settings.payroll_expense_account;
    if (!account) missing.add(e.department_code ? `${e.department_code} ${e.department_name}` : '(không có bộ phận)');
    return { accountCode: account ?? '', departmentCode: e.department_code, costItemCode: c?.cost_item_code ?? null, costObjectCode: c?.cost_object_code ?? null };
  };

  // Gom theo mọi chiều + diễn giải (số có dấu: Nợ dương), tách Nợ/Có ở cuối; dòng phải trả có diễn giải riêng cho lương và khấu trừ nên không bù trừ nhau.
  const acc = new Map<string, { line: VLine; amount: Decimal }>();
  const add = (amount: Decimal | string, l: Omit<VLine, 'debit' | 'credit'>) => {
    const a = D(amount); if (a.isZero()) return;
    const k = `${lineKey({ ...l, debit: '0', credit: '0' })}|${l.description}`;
    const cur = acc.get(k); if (cur) cur.amount = cur.amount.plus(a); else acc.set(k, { line: { ...l, debit: '0', credit: '0' }, amount: a });
  };
  const tot = { si: D(0), hi: D(0), ui: D(0), union: D(0), pit: D(0), other: D(0) };
  for (const l of run.lines) {
    const v = (c: string) => D(l.values[c] ?? 0);
    const e = empOf.get(l.employeeId)!;
    const own = splits.filter((s) => s.employee_id === l.employeeId);
    const projects = own.length ? own.map((s) => ({ code: s.code, pct: s.pct })) : [{ code: e.project_code, pct: '100' }];
    const er = { si: v('si_er_si').plus(v('si_er_occ')), hi: v('si_er_hi'), ui: v('si_er_ui'), union: v('union_er') };
    const ee = { si: v('si_emp_si'), hi: v('si_emp_hi'), ui: v('si_emp_ui') };
    // Chi phí tách theo vụ việc theo tỷ lệ phân bổ của nhân viên (phần dư làm tròn theo phần lẻ lớn nhất, như phân bổ chi phí tài sản).
    const split = (amount: Decimal, base: ReturnType<typeof costOf>, description: string) => {
      if (amount.isZero()) return;
      allocateByRatio(amount.toFixed(0), projects.map((p) => p.pct)).forEach((a, i) => add(a, { ...base, projectCode: projects[i]!.code, description }));
    };
    split(v('gross'), costOf(e, 'payroll'), `Chi phí tiền lương ${run.name}`);
    split(er.si.plus(er.hi).plus(er.ui).plus(er.union), costOf(e, 'insurance'), `Chi phí bảo hiểm, kinh phí công đoàn ${run.name}`);
    add(v('gross').neg(), { accountCode: m.payable, employeeCode: l.employeeCode, description: `Tiền lương phải trả ${run.name}` });
    add(ee.si.plus(ee.hi).plus(ee.ui).plus(v('pit')).plus(v('other_withholding')), { accountCode: m.payable, employeeCode: l.employeeCode, description: `Khấu trừ bảo hiểm, thuế TNCN và khấu trừ khác ${run.name}` });
    tot.si = tot.si.plus(er.si).plus(ee.si); tot.hi = tot.hi.plus(er.hi).plus(ee.hi); tot.ui = tot.ui.plus(er.ui).plus(ee.ui); tot.union = tot.union.plus(er.union);
    tot.pit = tot.pit.plus(v('pit')); tot.other = tot.other.plus(v('other_withholding'));
  }
  if (missing.size) throw new AppError('ACCOUNT_MISSING', `Chưa có tài khoản chi phí lương cho bộ phận: ${[...missing].join(', ')}. Khai ở Tài khoản chi phí lương theo bộ phận hoặc tài khoản mặc định của công ty`, 400, { departments: [...missing] });
  const sfx = `kỳ ${mmyyyy(run.year, run.month)}`;
  add(tot.si.neg(), { accountCode: m.si, description: `Bảo hiểm xã hội ${sfx}` });
  add(tot.hi.neg(), { accountCode: m.hi, description: `Bảo hiểm y tế ${sfx}` });
  add(tot.ui.neg(), { accountCode: m.ui, description: `Bảo hiểm thất nghiệp ${sfx}` });
  add(tot.union.neg(), { accountCode: m.union, description: `Kinh phí công đoàn ${sfx}` });
  add(tot.pit.neg(), { accountCode: m.pit, description: `Thuế TNCN khấu trừ ${sfx}` });
  add(tot.other.neg(), { accountCode: m.withholding, description: `Khấu trừ khác vào lương ${sfx}` });
  const lines = [...acc.values()].filter((x) => !x.amount.isZero())
    .map(({ line, amount }) => ({ ...line, debit: amount.gt(0) ? amount.toFixed(0) : '0', credit: amount.lt(0) ? amount.neg().toFixed(0) : '0' }));

  // Tài khoản phải có trong hệ tài khoản của chế độ và là tài khoản lá.
  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const found = new Map((await trx.selectFrom('account').select(['code', 'is_group']).where('regime', '=', regime).where('code', 'in', codes.length ? codes : ['']).execute()).map((a) => [a.code, a.is_group]));
  const bad = codes.filter((c) => found.get(c) !== false);
  if (bad.length) throw new AppError('ACCOUNT_MISSING', `Tài khoản ${bad.join(', ')} không có trong hệ thống tài khoản ${regime} hoặc là tài khoản tổng hợp: sửa tài khoản chi phí lương theo bộ phận hoặc hệ thống tài khoản`, 400, { accounts: bad });
  return lines;
}

const summary = (lines: VLine[]) => {
  const by = new Map<string, { accountCode: string; debit: string; credit: string }>();
  for (const l of lines) { const a = by.get(l.accountCode) ?? { accountCode: l.accountCode, debit: '0', credit: '0' }; by.set(l.accountCode, { accountCode: a.accountCode, debit: D(a.debit).plus(l.debit).toFixed(0), credit: D(a.credit).plus(l.credit).toFixed(0) }); }
  return { totalDebit: lines.reduce((s, l) => s.plus(l.debit), D(0)).toFixed(0), totalCredit: lines.reduce((s, l) => s.plus(l.credit), D(0)).toFixed(0), lineCount: lines.length, accounts: [...by.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode)) };
};
// source_doc_id là uuid còn mã bảng lương là số: uuid xác định từ (công ty, bảng lương), cùng cách kiểm kê quỹ (cash/cashCount.ts) làm: md5(...)::uuid.
export const payrollSourceId = (tenantId: string, runId: number) => createHash('md5').update(`${tenantId}:payroll_run:${runId}`).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const voucherNoOf = async (trx: Trx, id: string | null) => (id ? (await trx.selectFrom('voucher').select('voucher_no').where('id', '=', id).executeTakeFirst())?.voucher_no ?? null : null);

const PAY_LABEL: Record<string, string> = { pay: 'chi lương', insurance: 'nộp bảo hiểm', pit: 'nộp thuế TNCN' };
// Chứng từ chi lương/nộp BH/nộp TNCN đang liên kết với bảng lương (trigger đã gỡ liên kết khi chứng từ về nháp, hủy, đảo). Đã ghi sổ thì đảo/hủy LU làm 334 lệch hoặc chi lương hai lần: chặn (409);
// còn nháp thì cho qua nhưng báo lại để người dùng hủy nháp cũ (ghi sổ nháp đó sau khi LU đã đảo sẽ chi từ hạch toán không còn).
async function payVouchersOf(trx: Trx, runId: number) {
  return (await trx.selectFrom('payroll_run_voucher as x').innerJoin('voucher as v', 'v.id', 'x.voucher_id').select(['x.kind', 'v.id as voucherId', 'v.voucher_no as voucherNo', 'v.state'])
    .where('x.run_id', '=', runId).orderBy('x.id').execute());
}
async function assertNoPostedPayment(trx: Trx, runId: number, what: string) {
  const posted = (await payVouchersOf(trx, runId)).filter((x) => x.state === 'posted');
  if (posted.length)
    throw new AppError('PAYROLL_PAYMENT_POSTED', `Bảng lương còn chứng từ ${posted.map((x) => `${PAY_LABEL[x.kind] ?? x.kind}${x.voucherNo ? ` ${x.voucherNo}` : ''}`).join(', ')} đã ghi sổ: bỏ ghi sổ hoặc đảo chứng từ đó trước khi ${what}`, 409, { vouchers: posted });
}
const draftPayments = async (trx: Trx, runId: number) => (await payVouchersOf(trx, runId)).filter((x) => x.state === 'draft').map((x) => ({ kind: x.kind, voucherId: x.voucherId, voucherNo: x.voucherNo }));

async function createLu(trx: Trx, ctx: Ctx, run: Run, date: string, lines: VLine[]) {
  if (!lines.length) throw new AppError('PAYROLL_RUN_NOTHING_TO_POST', 'Bảng lương không có số tiền nào để hạch toán', 409);
  const v = await S.createSystemVoucher(trx, ctx, { voucherType: 'LU', postingDate: date, documentDate: date, description: `Hạch toán ${run.name}`, currencyCode: 'VND', lines }, { type: 'payroll_run', id: payrollSourceId(ctx.tenantId, run.id) });
  await S.postVoucher(trx, v.id);
  await trx.updateTable('payroll_run').set({ voucher_id: v.id, status: 'posted', updated_at: sql`now()` }).where('id', '=', run.id).execute();
  return v.id;
}

/** Hạch toán bảng lương đã tính, không "Cần tính lại": sinh và ghi sổ chứng từ LU. */
export async function postRun(trx: Trx, ctx: Ctx, runId: number) {
  const r = await lockRun(trx, runId);
  if (r.status === 'posted') throw new AppError('PAYROLL_RUN_POSTED', 'Bảng lương đã hạch toán: dùng Chạy lại hạch toán hoặc Hủy hạch toán', 409);
  if (r.status === 'cancelled') throw new AppError('PAYROLL_RUN_CANCELLED', 'Bảng lương đã hủy', 409);
  if (r.status !== 'calculated') throw new AppError('PAYROLL_RUN_NOT_CALCULATED', 'Bảng lương chưa tính: tính lương trước khi hạch toán', 409);
  const run = await getRun(trx, ctx.tenantId, runId);
  if (run.stale) throw new AppError('PAYROLL_RUN_STALE', 'Bảng lương cần tính lại (hồ sơ, chấm công hoặc tham số đã đổi sau lần tính): tính lại trước khi hạch toán', 409);
  const p = await periodOfRun(trx, run);
  assertWritable(p, ctx);
  const lines = await buildLines(trx, ctx.tenantId, run, p.regime);
  const voucherId = await createLu(trx, ctx, run, p.date, lines);
  return { runId, status: 'posted', voucherId, voucherNo: await voucherNoOf(trx, voucherId), reversedVoucherIds: [] as string[], unchanged: false, ...summary(lines) };
}

/**
 * Chạy lại hạch toán bảng lương đã hạch toán: tính lại bảng (kể cả khi đã hạch toán), dựng lại LU và so với LU hiện hành.
 * Khớp → giữ chứng từ (unchanged, kể cả ở kỳ khóa); lệch → đảo LU cũ ngày cuối kỳ lương, sinh LU mới.
 */
export async function repostRun(trx: Trx, ctx: Ctx, runId: number) {
  const r = await lockRun(trx, runId);
  if (r.status !== 'posted') throw new AppError('PAYROLL_RUN_NOT_POSTED', 'Bảng lương chưa hạch toán: dùng Hạch toán', 409);
  const cur = (await trx.selectFrom('payroll_run').select('voucher_id').where('id', '=', runId).executeTakeFirstOrThrow()).voucher_id;
  const warnings = await computeLines(trx, ctx.tenantId, r, await trx.selectFrom('payroll_line').select(['id', 'employee_id']).where('run_id', '=', runId).execute());
  await trx.updateTable('payroll_run').set({ calculated_at: new Date(), warnings: JSON.stringify(warnings) }).where('id', '=', runId).execute();
  await refreshRunHash(trx, runId);
  const run = await getRun(trx, ctx.tenantId, runId);
  const p = await periodOfRun(trx, run);
  const lines = await buildLines(trx, ctx.tenantId, run, p.regime);
  if (cur) {
    const old = await trx.selectFrom('voucher_line as l').innerJoin('account as a', 'a.id', 'l.account_id').leftJoin('department as d', 'd.id', 'l.department_id').leftJoin('project as pr', 'pr.id', 'l.project_id')
      .leftJoin('cost_item as c', 'c.id', 'l.cost_item_id').leftJoin('cost_object as o', 'o.id', 'l.cost_object_id').leftJoin('employee as e', 'e.id', 'l.employee_id')
      .select(['a.code as accountCode', 'l.debit', 'l.credit', 'd.code as departmentCode', 'pr.code as projectCode', 'c.code as costItemCode', 'o.code as costObjectCode', 'e.code as employeeCode'])
      .where('l.voucher_id', '=', cur).where('l.posting_date', '=', p.date).execute();
    if (old.map(lineKey).sort().join(';') === lines.map(lineKey).sort().join(';'))
      return { runId, status: 'posted', voucherId: cur, voucherNo: await voucherNoOf(trx, cur), reversedVoucherIds: [] as string[], unchanged: true, ...summary(lines) };
  }
  assertWritable(p, ctx);
  await assertNoPostedPayment(trx, runId, 'chạy lại hạch toán');
  const drafts = await draftPayments(trx, runId);
  if (cur) await S.reverseVoucher(trx, cur, { postingDate: p.date, description: `Đảo hạch toán ${run.name} (chạy lại)` }); // trigger gỡ liên kết, bảng về "đã tính"
  const voucherId = await createLu(trx, ctx, run, p.date, lines);
  return { runId, status: 'posted', voucherId, voucherNo: await voucherNoOf(trx, voucherId), reversedVoucherIds: cur ? [cur] : [], unchanged: false, draftPayments: drafts, ...summary(lines) };
}

/** Hủy hạch toán: đảo LU (D8, không bỏ ghi sổ) ngày cuối kỳ lương; bảng lương về "đã tính" (trigger gỡ liên kết), mở lại chấm công và tính lại. */
export async function unpostRun(trx: Trx, ctx: Ctx, runId: number) {
  const r = await lockRun(trx, runId);
  if (r.status !== 'posted') throw new AppError('PAYROLL_RUN_NOT_POSTED', 'Bảng lương chưa hạch toán', 409);
  const cur = (await trx.selectFrom('payroll_run').select('voucher_id').where('id', '=', runId).executeTakeFirstOrThrow()).voucher_id;
  const p = await periodOfRun(trx, r);
  assertWritable(p, ctx);
  await assertNoPostedPayment(trx, runId, 'hủy hạch toán');
  const drafts = await draftPayments(trx, runId);
  if (cur) await S.reverseVoucher(trx, cur, { postingDate: p.date, description: `Đảo hạch toán ${r.name} (hủy hạch toán)` });
  await trx.updateTable('payroll_run').set({ voucher_id: null, status: 'calculated', updated_at: sql`now()` }).where('id', '=', runId).execute();
  return { runId, status: 'calculated', voucherId: null, voucherNo: null, reversedVoucherIds: cur ? [cur] : [], unchanged: false, draftPayments: drafts };
}
