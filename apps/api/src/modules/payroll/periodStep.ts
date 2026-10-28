import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { monthRange } from './attendance.js';
import { getRun } from './runs.js';
import { postRun, repostRun, type Ctx } from './post.js';

// Bước "Tính lương và hạch toán" của quy trình cuối kỳ (D5): bảng lương có ngày cuối kỳ lương nằm trong kỳ kế toán (không tính bảng đã hủy).
// Không tự tính lương: bảng chưa tính hoặc cần tính lại chỉ được báo (needCalculation); bảng đã tính thì hạch toán; bảng đã hạch toán thì chạy lại (khớp → unchanged).
type Trx = Transaction<Database>;
type Span = { from: string; to: string };

export async function periodRuns(trx: Trx, span: Span) {
  const rs = await trx.selectFrom('payroll_run').select(['id', 'year', 'month', 'status', 'name']).where('status', '<>', 'cancelled').orderBy('id').execute();
  return rs.filter((r) => { const to = monthRange(r.year, r.month).to; return to >= span.from && to <= span.to; });
}

/** Bước đã chạy nhưng bảng lương kỳ đã đổi: còn bảng chưa hạch toán, hoặc bảng đã hạch toán cần chạy lại. detail=false: câu chữ trung tính (không số bảng). */
export async function payrollRunStale(trx: Trx, tenantId: string, span: Span, detail: boolean): Promise<{ stale: boolean; reason: string | null }> {
  const rs = await periodRuns(trx, span);
  const open = rs.filter((r) => r.status !== 'posted').length;
  let rerun = 0;
  for (const r of rs.filter((x) => x.status === 'posted')) if ((await getRun(trx, tenantId, r.id)).stale) rerun++;
  if (!open && !rerun) return { stale: false, reason: null };
  return { stale: true, reason: detail ? `${open} bảng lương chưa hạch toán, ${rerun} bảng đã hạch toán cần chạy lại` : 'Bảng lương trong kỳ đã thay đổi sau lần chạy' };
}

export async function runPayrollStep(trx: Trx, ctx: Ctx, span: Span) {
  const rs = await periodRuns(trx, span);
  if (!rs.length) return { skipped: true, posted: [] as number[], reposted: [] as number[], needCalculation: [] as { runId: number; name: string }[], voucherIds: [] as string[], reversedVoucherIds: [] as string[], unchanged: true };
  const posted: number[] = [], reposted: number[] = [], needCalculation: { runId: number; name: string }[] = [], voucherIds: string[] = [], reversedVoucherIds: string[] = [];
  let unchanged = true;
  for (const r of rs) {
    if (r.status === 'draft') { needCalculation.push({ runId: r.id, name: r.name }); continue; }
    if (r.status === 'calculated' && (await getRun(trx, ctx.tenantId, r.id)).stale) { needCalculation.push({ runId: r.id, name: r.name }); continue; }
    const out = r.status === 'posted' ? await repostRun(trx, ctx, r.id) : await postRun(trx, ctx, r.id);
    (r.status === 'posted' ? reposted : posted).push(r.id);
    if (out.voucherId) voucherIds.push(out.voucherId);
    reversedVoucherIds.push(...out.reversedVoucherIds);
    if (!out.unchanged) unchanged = false;
  }
  return { skipped: false, posted, reposted, needCalculation, voucherIds, reversedVoucherIds, unchanged };
}
