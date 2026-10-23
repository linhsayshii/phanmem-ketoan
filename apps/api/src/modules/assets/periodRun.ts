import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, allocateByRatio, type PeriodSpan, type Proration } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';
import * as S from '../ledger/vouchers.service.js';
import { lockTenant } from './assets.js';
import { assetValues, scheduleFor } from './schedule.js';

// Chạy khấu hao TSCĐ (KH) và phân bổ CCDC/chi phí trả trước (PB) theo kỳ: một lần chạy hiệu lực mỗi (loại, kỳ), một chứng từ ngày cuối kỳ.
// Chạy lại: chứng từ khớp thì giữ (chỉ cập nhật checked_at), lệch thì đảo cũ ngày cuối kỳ rồi sinh lần chạy và chứng từ mới (chứng từ hệ thống không bỏ ghi sổ được).
type Trx = Transaction<Database>;
export type RunKind = 'depreciation' | 'tool' | 'prepaid';
type Ctx = { tenantId: string; userId: string; canBackdate: boolean };
const ASSET_KIND: Record<RunKind, string> = { depreciation: 'fixed', tool: 'tool', prepaid: 'prepaid' };
const LABEL: Record<RunKind, string> = { depreciation: 'khấu hao tài sản cố định', tool: 'phân bổ công cụ dụng cụ', prepaid: 'phân bổ chi phí trả trước' };

type VLine = { accountCode: string; debit: string; credit: string; assetCode?: string; departmentCode?: string | null; projectCode?: string | null; costItemCode?: string | null; description: string };
const lineKey = (l: { accountCode: string; debit: string; credit: string; assetCode?: string | null | undefined; departmentCode?: string | null | undefined; projectCode?: string | null | undefined; costItemCode?: string | null | undefined }) =>
  [l.accountCode, D(l.debit).toFixed(0), D(l.credit).toFixed(0), l.assetCode ?? '', l.departmentCode ?? '', l.projectCode ?? '', l.costItemCode ?? ''].join('|');

async function periodSpan(trx: Trx, fy: number, pn: number) {
  const p = await trx.selectFrom('fiscal_period').select(['date_from', 'date_to', 'status']).where('fiscal_year', '=', fy).where('period_no', '=', pn).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Không có kỳ ${pn}/${fy}`, 404);
  return { span: { fiscalYear: fy, periodNo: pn, from: p.date_from, to: p.date_to } as PeriodSpan, status: p.status };
}
// Mọi lần chạy (mọi trạng thái) của loại ở kỳ P: chứng từ của chúng (kể cả bản đảo) bị bỏ khi tính hao mòn "trừ lần chạy kỳ P".
const runIdsOf = async (trx: Trx, kind: RunKind, fy: number, pn: number) =>
  (await trx.selectFrom('period_run').select('id').where('kind', '=', kind).where('fiscal_year', '=', fy).where('period_no', '=', pn).execute()).map((r) => r.id);

// Tài sản của lần chạy kỳ P: đúng loại, đang dùng (hoặc ghi giảm sau P.to), còn tính khấu hao, ngày bắt đầu ≤ P.to. Ghi giảm trong P: không có trong lần chạy (quy ước 7).
const selectAssets = (trx: Trx, kind: RunKind, span: PeriodSpan) => (span.periodNo < 1 || span.periodNo > 12 ? Promise.resolve([]) // kỳ điều chỉnh không tiêu thụ đơn vị
  : trx.selectFrom('asset').select(['id', 'code', 'asset_account_code', 'depreciation_account_code']).where('kind', '=', ASSET_KIND[kind]).where('is_depreciable', '=', true)
    .where('depreciation_start_date', '<=', span.to).where(sql<boolean>`coalesce(decrease_date > ${span.to}::date, status = 'active')`).orderBy('code').execute());

// Dấu vân tay sổ cái của lần chạy: nguyên giá, hao mòn (trừ lần chạy kỳ P) từng tài sản; khác thì lần chạy cũ (assetRunStale).
const fingerprint = (xs: { assetId: number; cost: string; accumulated: string }[]) => xs.map((x) => `${x.assetId}:${D(x.cost).toFixed(0)}:${D(x.accumulated).toFixed(0)}`).sort().join(';');

async function computeAmounts(trx: Trx, kind: RunKind, span: PeriodSpan, proration: Proration) {
  const assets = await selectAssets(trx, kind, span);
  const runIdsOfPeriod = await runIdsOf(trx, kind, span.fiscalYear, span.periodNo);
  const out = [];
  for (const a of assets) {
    const r = await scheduleFor(trx, a.id, span, { proration, runIdsOfPeriod });
    out.push({ ...a, scheduleId: r.schedule.id, amount: r.line?.amount ?? '0', cost: r.values.cost, accumulated: r.values.accumulated });
  }
  return out;
}
type Amount = Awaited<ReturnType<typeof computeAmounts>>[number];

// Mỗi tài sản: Nợ TK chi phí theo phân bổ hiện hành tại P (bộ phận, vụ việc, khoản mục; chia phần dư lớn nhất) / Có TK hao mòn (TSCĐ) hoặc 242 (CCDC/CPTT) mang mã tài sản.
async function buildLines(trx: Trx, kind: RunKind, span: PeriodSpan, items: Amount[]): Promise<VLine[]> {
  if (!items.length) return [];
  const al = await trx.selectFrom('asset_allocation as x').leftJoin('department as d', 'd.id', 'x.department_id').leftJoin('project as p', 'p.id', 'x.project_id').leftJoin('cost_item as c', 'c.id', 'x.cost_item_id')
    .select(['x.asset_id', 'x.valid_from_year', 'x.valid_from_period', 'x.expense_account_code', 'x.ratio', 'd.code as department_code', 'p.code as project_code', 'c.code as cost_item_code'])
    .where('x.asset_id', 'in', items.map((i) => i.id)).where(sql<boolean>`(x.valid_from_year, x.valid_from_period) <= (${span.fiscalYear}, ${span.periodNo})`).orderBy('x.id').execute();
  const lines: VLine[] = [];
  for (const a of items) {
    const mine = al.filter((x) => x.asset_id === a.id);
    const from = Math.max(...mine.map((x) => x.valid_from_year * 100 + x.valid_from_period));
    const cur = mine.filter((x) => x.valid_from_year * 100 + x.valid_from_period === from);
    if (!cur.length) throw new AppError('ASSET_ALLOCATION_MISSING', `Tài sản ${a.code} chưa có phân bổ chi phí áp dụng cho kỳ ${span.periodNo}/${span.fiscalYear}`, 409);
    const description = `${kind === 'depreciation' ? 'Khấu hao' : 'Phân bổ'} ${a.code} kỳ ${span.periodNo}/${span.fiscalYear}`;
    allocateByRatio(a.amount, cur.map((x) => x.ratio)).forEach((part, i) => {
      const x = cur[i]!;
      if (!D(part).isZero()) lines.push({ accountCode: x.expense_account_code, debit: part, credit: '0', departmentCode: x.department_code, projectCode: x.project_code, costItemCode: x.cost_item_code, description });
    });
    lines.push({ accountCode: kind === 'depreciation' ? a.depreciation_account_code! : a.asset_account_code, debit: '0', credit: a.amount, assetCode: a.code, description });
  }
  return lines;
}

// Quy ước 6: kỳ liền trước (kỳ 1..12) có số khác 0 mà chưa có lần chạy hiệu lực → 409. Tính thử trong điểm lưu rồi bỏ (không để lại phiên bản lịch).
async function assertNoGap(trx: Trx, kind: RunKind, span: PeriodSpan, proration: Proration) {
  const prev = await trx.selectFrom('fiscal_period').select(['fiscal_year', 'period_no']).where('period_no', '>=', 1).where('period_no', '<=', 12)
    .where(sql<boolean>`(fiscal_year, period_no) < (${span.fiscalYear}, ${span.periodNo})`).orderBy('fiscal_year', 'desc').orderBy('period_no', 'desc').limit(1).executeTakeFirst();
  if (!prev) return;
  if (await trx.selectFrom('period_run').select('id').where('kind', '=', kind).where('fiscal_year', '=', prev.fiscal_year).where('period_no', '=', prev.period_no).where('status', '=', 'active').executeTakeFirst()) return;
  await sql`SAVEPOINT asset_run_gap`.execute(trx);
  let hit: string | undefined;
  try {
    const { span: ps } = await periodSpan(trx, prev.fiscal_year, prev.period_no);
    hit = (await computeAmounts(trx, kind, ps, proration)).find((x) => !D(x.amount).isZero())?.code;
  } finally {
    await sql`ROLLBACK TO SAVEPOINT asset_run_gap`.execute(trx);
    await sql`RELEASE SAVEPOINT asset_run_gap`.execute(trx);
  }
  if (hit) throw new AppError('PERIOD_RUN_GAP', `Kỳ ${prev.period_no}/${prev.fiscal_year} chưa chạy ${LABEL[kind]} mà có số phát sinh (tài sản ${hit}): chạy kỳ đó trước`, 409);
}

// Khóa kỳ chỉ kiểm khi lần chạy phải ghi (đảo, tạo lần chạy/chứng từ mới): lần chạy khớp ở kỳ khóa vẫn qua, để chạy lại dây chuyền (refreshRuns) không vấp kỳ khóa không đổi.
async function runOne(trx: Trx, ctx: Ctx, input: { kind: RunKind; fiscalYear: number; periodNo: number }, checkGap: boolean) {
  await lockTenant(trx, ctx.tenantId);
  const { kind, fiscalYear: fy, periodNo: pn } = input;
  const { span, status } = await periodSpan(trx, fy, pn);
  const assertWritable = () => {
    if (status === 'hard_locked') throw new AppError('PERIOD_HARD_LOCKED', `Kỳ ${pn}/${fy} đã khóa cứng: không chạy ${LABEL[kind]}`, 409);
    if (status === 'soft_locked' && !ctx.canBackdate) throw new AppError('PERIOD_SOFT_LOCKED', `Kỳ ${pn}/${fy} đã khóa sổ, cần quyền ghi lùi ngày để chạy ${LABEL[kind]}`, 409);
  };
  const proration = (await getSettings(trx, ctx.tenantId)).fa_proration;
  if (checkGap) await assertNoGap(trx, kind, span, proration);

  const items = await computeAmounts(trx, kind, span, proration);
  const lines = await buildLines(trx, kind, span, items.filter((i) => !D(i.amount).isZero()));
  const result = items.filter((i) => !D(i.amount).isZero()).map((i) => ({ assetCode: i.code, amount: i.amount }));
  const resultJson = JSON.stringify({ lines: result, basis: items.map((i) => ({ assetId: i.id, cost: i.cost, accumulated: i.accumulated })) });
  const stamp = (runId: string) => items.length
    ? trx.updateTable('asset_schedule_line').set({ run_id: runId }).where('fiscal_year', '=', fy).where('period_no', '=', pn).where('schedule_id', 'in', items.map((i) => i.scheduleId)).execute() : Promise.resolve();

  const active = await trx.selectFrom('period_run as r').leftJoin('voucher as v', 'v.id', 'r.voucher_id').select(['r.id', 'r.voucher_id', 'v.state'])
    .where('r.kind', '=', kind).where('r.fiscal_year', '=', fy).where('r.period_no', '=', pn).where('r.status', '=', 'active').executeTakeFirst();
  if (active) {
    let same = !active.voucher_id && !lines.length;
    if (active.voucher_id && active.state === 'posted') {
      const cur = await trx.selectFrom('voucher_line as l').innerJoin('account as a', 'a.id', 'l.account_id').leftJoin('asset as s', 's.id', 'l.asset_id').leftJoin('department as d', 'd.id', 'l.department_id')
        .leftJoin('project as p', 'p.id', 'l.project_id').leftJoin('cost_item as c', 'c.id', 'l.cost_item_id')
        .select(['a.code as accountCode', 'l.debit', 'l.credit', 's.code as assetCode', 'd.code as departmentCode', 'p.code as projectCode', 'c.code as costItemCode'])
        .where('l.voucher_id', '=', active.voucher_id).where('l.posting_date', '=', span.to).execute();
      same = cur.map(lineKey).sort().join(';') === lines.map(lineKey).sort().join(';');
    }
    if (same) {
      await trx.updateTable('period_run').set({ checked_at: sql`now()`, result: resultJson }).where('id', '=', active.id).execute();
      await stamp(active.id);
      return { runId: active.id, voucherId: active.voucher_id, reversedVoucherIds: [] as string[], unchanged: true, lines: result };
    }
  }
  assertWritable();
  const reversed: string[] = [];
  if (active) {
    if (active.voucher_id && active.state === 'posted') { await S.reverseVoucher(trx, active.voucher_id, { postingDate: span.to }); reversed.push(active.voucher_id); }
    await trx.updateTable('period_run').set({ status: 'superseded' }).where('id', '=', active.id).execute();
  }
  const run = await trx.insertInto('period_run').values({ tenant_id: ctx.tenantId, kind, fiscal_year: fy, period_no: pn, created_by: ctx.userId, result: resultJson })
    .returning('id').executeTakeFirstOrThrow();
  let voucherId: string | null = null;
  if (lines.length) {
    const description = `${LABEL[kind][0]!.toUpperCase()}${LABEL[kind].slice(1)} kỳ ${pn}/${fy}`;
    const v = await S.createSystemVoucher(trx, ctx, { voucherType: kind === 'depreciation' ? 'KH' : 'PB', postingDate: span.to, documentDate: span.to, description, currencyCode: 'VND', lines }, { type: 'asset_run', id: run.id });
    await S.postVoucher(trx, v.id);
    voucherId = v.id;
    await trx.updateTable('period_run').set({ voucher_id: v.id }).where('id', '=', run.id).execute();
  }
  await stamp(run.id);
  return { runId: run.id, voucherId, reversedVoucherIds: reversed, unchanged: false, lines: result };
}

export const runAssetPeriod = (trx: Trx, ctx: Ctx, input: { kind: RunKind; fiscalYear: number; periodNo: number }) => runOne(trx, ctx, input, true);

/** Chạy lại theo thứ tự mọi lần chạy hiệu lực của loại từ kỳ đã cho (nghiệp vụ tài sản ghi lùi, quy ước 7). Không kiểm khoảng trống: chỉ làm mới các lần chạy đã có. */
export async function refreshRuns(trx: Trx, ctx: Ctx, kind: RunKind, fromYear: number, fromPeriod: number): Promise<{ fiscalYear: number; periodNo: number; unchanged: boolean }[]> {
  await lockTenant(trx, ctx.tenantId);
  const runs = await trx.selectFrom('period_run').select(['fiscal_year', 'period_no']).where('kind', '=', kind).where('status', '=', 'active')
    .where(sql<boolean>`(fiscal_year, period_no) >= (${fromYear}, ${fromPeriod})`).orderBy('fiscal_year').orderBy('period_no').execute();
  const out = [];
  for (const r of runs) out.push({ fiscalYear: r.fiscal_year, periodNo: r.period_no, unchanged: (await runOne(trx, ctx, { kind, fiscalYear: r.fiscal_year, periodNo: r.period_no }, false)).unchanged });
  return out;
}

/**
 * Lần chạy hiệu lực của kỳ có cần chạy lại: dấu vân tay sổ cái hiện tại (nguyên giá, hao mòn tại P.to trừ các lần chạy kỳ P, từng tài sản thuộc lần chạy)
 * khác dấu vân tay đã lưu lúc chạy/kiểm cuối — bắt cả ghi sổ, bỏ ghi sổ, hủy, đảo, ghi sổ xen giữa lúc chạy, tài sản vào/ra lần chạy —
 * hoặc lần chạy hiệu lực của một kỳ trước được tạo sau lần chạy/kiểm cuối của kỳ này. Chưa chạy: không cũ.
 */
export async function assetRunStale(trx: Trx, kind: RunKind, fiscalYear: number, periodNo: number): Promise<{ stale: boolean; reason: string | null }> {
  const run = await trx.selectFrom('period_run').select(['id', 'tenant_id', 'result']).where('kind', '=', kind).where('fiscal_year', '=', fiscalYear).where('period_no', '=', periodNo).where('status', '=', 'active').executeTakeFirst();
  if (!run) return { stale: false, reason: null };
  const { span } = await periodSpan(trx, fiscalYear, periodNo);
  const assets = await selectAssets(trx, kind, span);
  const vals = await assetValues(trx, run.tenant_id, span.to, await runIdsOf(trx, kind, fiscalYear, periodNo), assets.map((a) => a.id));
  const now = fingerprint(assets.map((a) => ({ assetId: a.id, ...vals.get(a.id)! })));
  const stored = (run.result as { basis?: { assetId: number; cost: string; accumulated: string }[] }).basis ?? [];
  if (now !== fingerprint(stored)) return { stale: true, reason: `Số liệu tài sản đến cuối kỳ ${periodNo}/${fiscalYear} đã thay đổi sau lần chạy` };
  const q = (await sql<{ fiscal_year: number; period_no: number }>`SELECT q.fiscal_year, q.period_no FROM period_run r
    JOIN period_run q ON q.tenant_id = r.tenant_id AND q.kind = r.kind AND q.status = 'active' AND (q.fiscal_year, q.period_no) < (r.fiscal_year, r.period_no) AND q.created_at > coalesce(r.checked_at, r.created_at)
    WHERE r.id = ${run.id}::uuid ORDER BY q.fiscal_year, q.period_no LIMIT 1`.execute(trx)).rows[0];
  if (q) return { stale: true, reason: `Kỳ ${q.period_no}/${q.fiscal_year} được chạy lại sau lần chạy kỳ này` };
  return { stale: false, reason: null };
}

export async function listRuns(trx: Trx, kind?: RunKind, year?: number) {
  return (await trx.selectFrom('period_run as r').leftJoin('voucher as v', 'v.id', 'r.voucher_id')
    .select(['r.id', 'r.kind', 'r.fiscal_year', 'r.period_no', 'r.status', 'r.voucher_id', 'v.voucher_no', 'r.result', 'r.created_at', 'r.checked_at'])
    .$if(!!kind, (q) => q.where('r.kind', '=', kind!)).$if(year !== undefined, (q) => q.where('r.fiscal_year', '=', year!))
    .orderBy('r.fiscal_year').orderBy('r.period_no').orderBy('r.created_at').execute())
    .map((r) => ({ id: r.id, kind: r.kind, fiscalYear: r.fiscal_year, periodNo: r.period_no, status: r.status, voucherId: r.voucher_id, voucherNo: r.voucher_no, result: r.result, createdAt: r.created_at, checkedAt: r.checked_at }));
}
