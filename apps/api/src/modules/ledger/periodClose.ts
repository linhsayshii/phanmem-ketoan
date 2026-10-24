import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';
import { assetRunStale, periodSpan } from '../assets/periodRun.js';
import { loanInterestStale } from '../loans/interest.js';
import { payrollRunStale } from '../payroll/periodStep.js';

// Quy trình cuối kỳ: thứ tự cố định; trạng thái từng bước suy ra từ nhật ký period_close_log (mỗi lần chạy thành công một dòng).
type Trx = Transaction<Database>;
// Lương đứng đầu (chi phí lương vào giá thành), rồi CCDC, trả trước, khấu hao, lãi vay; giá vốn sau cùng nhóm này để nhận chi phí đó, rồi giá thành sản phẩm (D5).
// unavailable: đã đăng ký (nhật ký, thứ tự) nhưng chưa có bộ chạy: luôn hiện "bỏ qua", chạy báo 409 (giá thành: Task 11).
export const CLOSE_STEPS = [
  { key: 'payroll', name: 'Tính lương và hạch toán', permission: 'payroll.post', optional: true },
  { key: 'tool', name: 'Phân bổ công cụ dụng cụ', permission: 'asset.run' },
  { key: 'prepaid', name: 'Phân bổ chi phí trả trước', permission: 'asset.run' },
  { key: 'depreciation', name: 'Khấu hao TSCĐ', permission: 'asset.run' },
  { key: 'loan_interest', name: 'Lãi vay', permission: 'loan.run' },
  { key: 'costing', name: 'Tính giá vốn', permission: 'costing.run' },
  { key: 'product_cost', name: 'Giá thành sản phẩm', permission: 'cost_run.run', unavailable: true },
  { key: 'amortization', name: 'Phân bổ doanh thu nhận trước', permission: 'amortization.run' },
  { key: 'fx_outflow', name: 'Tỷ giá xuất quỹ', permission: 'fx.run' },
  { key: 'fx_revaluation', name: 'Đánh giá lại ngoại tệ', permission: 'fx.run', optional: true },
  { key: 'vat_offset', name: 'Khấu trừ thuế GTGT', permission: 'tax.offset' },
  { key: 'closing', name: 'Kết chuyển', permission: 'closing.run' },
] as const;
export type CloseStepKey = (typeof CLOSE_STEPS)[number]['key'];
export type StepStatus = 'done' | 'rerun' | 'pending' | 'skipped_empty';

/** Kỳ tháng (1–12) chứa ngày; các bước cuối kỳ chỉ tính theo kỳ này. */
export const periodOfDate = async (trx: Trx, date: string) => {
  const p = await trx.selectFrom('fiscal_period').select(['fiscal_year', 'period_no', 'date_from', 'date_to']).where('period_no', '>=', 1).where('period_no', '<=', 12)
    .where('date_from', '<=', date).where('date_to', '>=', date).executeTakeFirst();
  return p && { fiscalYear: p.fiscal_year, periodNo: p.period_no, from: p.date_from, to: p.date_to };
};

export const runSummary = (o: { voucherIds?: string[]; voucherId?: string | null; reversedVoucherIds?: string[]; unchanged?: boolean }) =>
  ({ voucherIds: o.voucherIds ?? (o.voucherId ? [o.voucherId] : []), reversedVoucherIds: o.reversedVoucherIds ?? [], unchanged: !!o.unchanged });

/** Ghi nhật ký một lần chạy bước (mọi route chạy bước gọi sau khi chạy xong, trong cùng giao dịch). */
export async function logCloseStep(trx: Trx, ctx: { tenantId: string; userId: string }, a: { fiscalYear: number; periodNo: number; step: CloseStepKey; ok: boolean; summary: Record<string, unknown> }) {
  await sql`INSERT INTO period_close_log(tenant_id, fiscal_year, period_no, step, ran_at, user_id, ok, summary)
    VALUES (${ctx.tenantId}::uuid, ${a.fiscalYear}, ${a.periodNo}, ${a.step}, clock_timestamp(), ${ctx.userId}::uuid, ${a.ok}, ${JSON.stringify(a.summary)}::jsonb)`.execute(trx);
}

const UNAVAILABLE_REASON = 'Chưa hỗ trợ trong phiên bản này';
type Log = { step: string; ran_at: string; ok: boolean; summary: { skipped?: boolean; unchanged?: boolean; errors?: number; voucherIds?: string[] }; user: string | null };

/** canViewSalary = false (thiếu cờ view_salary): bước lương chỉ trả trạng thái chung, không chứng từ, không số liệu hay lỗi chi tiết. */
export async function closeStatus(trx: Trx, tenantId: string, fiscalYear: number, periodNo: number, canViewSalary: boolean) {
  const { span } = await periodSpan(trx, fiscalYear, periodNo);
  const logs = (await sql<Log>`SELECT l.step, l.ran_at::text AS ran_at, l.ok, l.summary, u.full_name AS "user" FROM period_close_log l LEFT JOIN app_user u ON u.id = l.user_id
    WHERE l.fiscal_year = ${fiscalYear} AND l.period_no = ${periodNo} ORDER BY l.ran_at, l.id`.execute(trx)).rows;
  // lần bỏ qua hoặc chạy lại không đổi gì không làm các bước sau phải chạy lại; lần chạy lỗi (ok = false) không tính là xong
  const last = new Map<string, Log>(); const lastReal = new Map<string, Log>(); const failed = new Map<string, Log>();
  for (const l of logs) {
    // lần chạy lỗi có thể đã ghi một phần (giá vốn): tính như lần chạy thật để các bước sau chạy lại, trừ khi không đổi gì
    if (!l.ok) { failed.set(l.step, l); if (!l.summary.unchanged) lastReal.set(l.step, l); continue; }
    failed.delete(l.step); last.set(l.step, l);
    if (!l.summary.skipped && !l.summary.unchanged) lastReal.set(l.step, l);
  }
  const ids = [...new Set([...last.values()].flatMap((l) => l.summary.voucherIds ?? []))];
  const nos = new Map((ids.length ? await trx.selectFrom('voucher').select(['id', 'voucher_no', 'voucher_type']).where('id', 'in', ids).execute() : []).map((v) => [v.id, v]));
  const staleCosting = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM stock_cost_state WHERE stale_from <= ${span.to}::date`.execute(trx)).rows[0]!.n !== '0';

  const steps = [];
  for (const [i, def] of CLOSE_STEPS.entries()) {
    const l = last.get(def.key);
    let status: StepStatus = 'pending'; let reason: string | null = null;
    if ('unavailable' in def) { steps.push({ key: def.key, name: def.name, failed: false, permission: def.permission, optional: false, unavailable: true, masked: false, status: 'skipped_empty', lastRunAt: null, reason: UNAVAILABLE_REASON, lastUser: null, vouchers: [] }); continue; }
    const masked = def.key === 'payroll' && !canViewSalary;
    const f = failed.get(def.key);
    if (f) reason = `Lần chạy gần nhất lỗi (${f.summary.errors ?? 0} mục), chưa tính là xong`;
    if (l) {
      status = l.summary.skipped ? 'skipped_empty' : 'done';
      const later = CLOSE_STEPS.slice(0, i).find((s) => Date.parse(lastReal.get(s.key)?.ran_at ?? '1970-01-01') > Date.parse(l.ran_at));
      if (!l.summary.skipped) {
        if (later) { status = 'rerun'; reason = `Bước "${later.name}" chạy sau lần chạy này`; }
        else if (def.key === 'tool' || def.key === 'prepaid' || def.key === 'depreciation') {
          const r = await assetRunStale(trx, def.key, fiscalYear, periodNo); if (r.stale) { status = 'rerun'; reason = r.reason; }
        } else if (def.key === 'loan_interest' && await loanInterestStale(trx, fiscalYear, periodNo)) { status = 'rerun'; reason = 'Lãi vay tính lại hiện nay khác lần chạy'; }
        else if (def.key === 'payroll') { const r = await payrollRunStale(trx, tenantId, span, !masked); if (r.stale) { status = 'rerun'; reason = r.reason; } }
        else if (def.key === 'costing' && staleCosting) { status = 'rerun'; reason = 'Kho còn phát sinh chưa cập nhật giá vốn trong kỳ'; }
      }
    }
    if (f) { status = l ? 'rerun' : 'pending'; reason = masked ? 'Lần chạy gần nhất chưa hoàn tất' : def.key === 'payroll' ? `Còn ${f.summary.errors ?? 0} bảng lương chưa tính hoặc cần tính lại, chưa tính là xong` : `Lần chạy gần nhất lỗi (${f.summary.errors ?? 0} mục), chưa tính là xong`; }
    steps.push({ key: def.key, name: def.name, failed: !!f, permission: def.permission, optional: 'optional' in def, unavailable: false, masked, status, lastRunAt: l ? new Date(l.ran_at).toISOString() : null, reason, lastUser: l?.user ?? null,
      vouchers: masked ? [] : (l?.summary.voucherIds ?? []).map((id) => ({ id, voucherNo: nos.get(id)?.voucher_no ?? null, voucherType: nos.get(id)?.voucher_type ?? null })) });
  }
  return { steps, nextStep: steps.find((s) => s.status !== 'done' && s.status !== 'skipped_empty')?.key ?? null };
}

export const stepDef = (key: string) => {
  const d = CLOSE_STEPS.find((s) => s.key === key);
  if (!d) throw new AppError('VALIDATION', `Bước "${key}" không có trong quy trình cuối kỳ`, 400);
  return d;
};
