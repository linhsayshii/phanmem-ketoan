import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { costRunParams, isStale, prepareCostRun, runCostRun, type Ctx } from './costRun.js';

// Bước "Tính giá thành" của quy trình cuối kỳ (GĐ6 Task 11c, D5). Kỳ giá thành = tháng dương lịch chứa ngày cuối kỳ kế toán.
// Chạy bước = chạy giá thành với tham số đã lưu của kỳ ({} nếu chưa có lần chạy); chưa có lần chạy và không có chi phí nào để tính → bỏ qua (skipped).
type Trx = Transaction<Database>;
type Span = { from: string; to: string };
const monthOf = (span: Span) => ({ year: Number(span.to.slice(0, 4)), month: Number(span.to.slice(5, 7)) });

/** Bước đã chạy nhưng kỳ chưa có lần chạy giá thành, hoặc lần chạy "Cần chạy lại" (chi phí, nhập kho, dở dang đầu đổi hoặc GT bị gỡ). */
export async function costRunStale(trx: Trx, span: Span): Promise<{ stale: boolean; reason: string | null }> {
  const { year, month } = monthOf(span);
  const run = await trx.selectFrom('cost_run').select(['year', 'month', 'status', 'params', 'input_hash']).where('year', '=', year).where('month', '=', month).executeTakeFirst();
  if (!run) return { stale: true, reason: 'Kỳ chưa có lần chạy giá thành' };
  const stale = await isStale(trx, { year, month, status: run.status, params: costRunParams.parse(run.params), inputHash: run.input_hash });
  return { stale, reason: stale ? 'Chi phí, nhập kho thành phẩm hoặc kỳ trước đã thay đổi sau lần chạy giá thành' : null };
}

export async function runCostStep(trx: Trx, ctx: Ctx, span: Span, canViewCost: boolean) {
  const { year, month } = monthOf(span);
  const cur = await trx.selectFrom('cost_run').select('params').where('year', '=', year).where('month', '=', month).executeTakeFirst();
  const params = costRunParams.parse(cur?.params ?? {});
  if (!cur) { // tiêu chí an toàn: chỉ bỏ qua khi không có chi phí sản xuất nào (gắn đối tượng hay chưa) và không có dở dang đầu; cờ costing_enabled không được xét để khỏi che chi phí
    const p = await prepareCostRun(trx, year, month, params);
    if (!p.objects.length && !p.unassigned.lines.length) return { skipped: true, unchanged: true, voucherIds: [] as string[], reversedVoucherIds: [] as string[], status: null, objectCount: 0 };
  }
  try {
    const r = await runCostRun(trx, ctx, year, month, params);
    return { skipped: false, unchanged: r.unchanged && !r.receiptAdjustments.length, voucherIds: r.voucherId ? [r.voucherId] : [], reversedVoucherIds: r.reversedVoucherIds, status: r.status, objectCount: r.objects.length };
  } catch (e) { // chi tiết khoản chặn có số tiền: chỉ người có view_cost được thấy
    if (!canViewCost && e instanceof AppError && e.details) throw new AppError(e.code, e.message, e.status);
    throw e;
  }
}
