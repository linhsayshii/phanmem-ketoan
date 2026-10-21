import { CompiledQuery, sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';

export interface CheckResult { ruleCode: string; ruleName: string; severity: string; message: string; fixHint: string | null; voucherId: string | null; voucherNo: string | null; ref: string | null; detail: string | null }

// Số dòng tối đa mỗi quy tắc trả về; lấy MAX_ROWS + 1 dòng để biết có bị cắt hay không.
export const MAX_ROWS = 1000;

// Hợp đồng SQL của quy tắc: SELECT trả (voucher_id uuid NULL, ref text, detail text), tham số $1 date (từ ngày), $2 date (đến ngày).
// Câu SQL do hệ thống cung cấp (app_user không ghi được cột sql) nhưng vẫn chạy phòng thủ nhiều lớp:
// - giao dịch chỉ đọc + statement_timeout, mỗi quy tắc trong một SAVEPOINT nên lỗi của một quy tắc không làm hỏng quy tắc khác;
// - CompiledQuery.raw với tham số thật dùng giao thức mở rộng: PostgreSQL chỉ nhận đúng một câu lệnh, ngày không bao giờ nội suy vào chuỗi SQL;
// - tiền tố WITH _p ép $1/$2 luôn có kiểu date, nên quy tắc chỉ dùng một trong hai tham số vẫn chạy (không có nó PostgreSQL báo 42P18);
// - sau mỗi quy tắc kiểm tra lại công ty của phiên (quy tắc gọi set_config app.current_tenant sẽ chuyển RLS sang công ty khác) và đặt lại statement_timeout;
// - mỗi công ty chỉ một lần soát tại một thời điểm (khóa tư vấn theo giao dịch).
const wrap = (rule: string) => `WITH _p AS (SELECT $1::date AS d1, $2::date AS d2) SELECT q.voucher_id, q.ref, q.detail FROM (${rule}) q(voucher_id, ref, detail) LIMIT ${MAX_ROWS + 1}`;

export interface SkippedRule { code: string; reason: string }

// Cờ nhạy cảm -> tên hiển thị trong lý do bỏ qua; view_receivable và view_payable cùng là "công nợ".
const FLAG_LABEL: Record<string, string> = { view_receivable: 'công nợ', view_payable: 'công nợ', view_cost: 'giá vốn', view_salary: 'lương' };
const skipReason = (missing: string[]) => `Bỏ qua do thiếu quyền xem ${[...new Set(missing.map((m) => FLAG_LABEL[m] ?? m))].join(', ')}`;

// sensitive: cờ nhạy cảm của người chạy. Quy tắc khai báo flags thì người chạy phải có đủ mọi cờ đó, nếu không quy tắc bị bỏ qua (không chạy SQL) và báo trong skipped.
export async function runDataChecks(trx: Transaction<Database>, f: { from: string; to: string; codes?: string[] | undefined }, sensitive: ReadonlySet<string>): Promise<{ results: CheckResult[]; ran: number; truncated: string[]; skipped: SkippedRule[] }> {
  await sql`SET LOCAL transaction_read_only = on`.execute(trx);
  const timeout = () => sql`SET LOCAL statement_timeout = '15s'`.execute(trx);
  await timeout();
  const start = (await sql<{ tenant: string; ok: boolean }>`SELECT app_tenant()::text AS tenant, pg_try_advisory_xact_lock(hashtextextended('data_check:' || app_tenant()::text, 0)) AS ok`.execute(trx)).rows[0]!;
  if (!start.ok) throw new AppError('DATA_CHECK_RUNNING', 'Công ty này đang có một lần soát lỗi khác, hãy thử lại sau', 409);
  let q = trx.selectFrom('data_check_rule').selectAll().where('is_enabled', '=', true);
  if (f.codes?.length) q = q.where('code', 'in', f.codes);
  const all = await q.orderBy('code').execute();
  const skipped: SkippedRule[] = [];
  const rules = all.filter((r) => {
    const missing = r.flags.filter((x) => !sensitive.has(x));
    if (missing.length) skipped.push({ code: r.code, reason: skipReason(missing) });
    return !missing.length;
  });
  const results: CheckResult[] = [];
  const truncated: string[] = [];
  for (const r of rules) {
    const base = { ruleCode: r.code, ruleName: r.name, severity: r.severity, message: r.message, fixHint: r.fix_hint };
    try {
      await sql`SAVEPOINT rule`.execute(trx);
      const fetched = (await trx.executeQuery<{ voucher_id: string | null; ref: string | null; detail: string | null }>(CompiledQuery.raw(wrap(r.sql), [f.from, f.to]))).rows;
      // Kiểm tra ngay sau câu của quy tắc, trước mọi truy vấn khác: sau set_config công ty khác, RLS đã đọc dữ liệu của công ty đó.
      if ((await sql<{ tenant: string }>`SELECT app_tenant()::text AS tenant`.execute(trx)).rows[0]!.tenant !== start.tenant)
        throw new AppError('RULE_TENANT_CHANGED', `Quy tắc ${r.code} đổi công ty của phiên làm việc; hủy cả lần soát`, 409);
      const rows = fetched.slice(0, MAX_ROWS);
      const ids = rows.map((x) => x.voucher_id).filter((x): x is string => !!x);
      const nos = ids.length ? new Map((await trx.selectFrom('voucher').select(['id', 'voucher_no']).where('id', 'in', ids).execute()).map((v) => [v.id, v.voucher_no])) : new Map<string, string | null>();
      await sql`RELEASE SAVEPOINT rule`.execute(trx);
      if (fetched.length > MAX_ROWS) truncated.push(r.code);
      for (const x of rows) results.push({ ...base, voucherId: x.voucher_id, voucherNo: x.voucher_id ? nos.get(x.voucher_id) ?? null : null, ref: x.ref, detail: x.detail });
    } catch (e) {
      if (e instanceof AppError) throw e; // RULE_TENANT_CHANGED: bỏ cả giao dịch, không biến thành "Quy tắc lỗi"
      await sql`ROLLBACK TO SAVEPOINT rule`.execute(trx);
      await sql`RELEASE SAVEPOINT rule`.execute(trx);
      results.push({ ...base, severity: 'error', message: `Quy tắc lỗi: ${(e as Error).message}`, voucherId: null, voucherNo: null, ref: null, detail: null });
    }
    await timeout(); // quy tắc có thể đã đặt statement_timeout = 0 bằng set_config
  }
  return { results, ran: rules.length, truncated, skipped };
}
