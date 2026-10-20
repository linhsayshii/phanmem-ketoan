import { CompiledQuery, sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';

export interface CheckResult { ruleCode: string; ruleName: string; severity: string; message: string; fixHint: string | null; voucherId: string | null; voucherNo: string | null; ref: string | null; detail: string | null }

// Hợp đồng SQL của quy tắc: SELECT trả (voucher_id uuid NULL, ref text, detail text), tham số $1 date (từ ngày), $2 date (đến ngày).
// Câu SQL do hệ thống cung cấp (app_user không ghi được cột sql) nhưng vẫn chạy phòng thủ nhiều lớp:
// - giao dịch chỉ đọc + statement_timeout, mỗi quy tắc trong một SAVEPOINT nên lỗi của một quy tắc không làm hỏng quy tắc khác;
// - CompiledQuery.raw với tham số thật dùng giao thức mở rộng: PostgreSQL chỉ nhận đúng một câu lệnh, ngày không bao giờ nội suy vào chuỗi SQL;
// - tiền tố WITH _p ép $1/$2 luôn có kiểu date, nên quy tắc chỉ dùng một trong hai tham số vẫn chạy (không có nó PostgreSQL báo 42P18).
const wrap = (rule: string) => `WITH _p AS (SELECT $1::date AS d1, $2::date AS d2) SELECT q.voucher_id, q.ref, q.detail FROM (${rule}) q(voucher_id, ref, detail) LIMIT 1000`;

export async function runDataChecks(trx: Transaction<Database>, f: { from: string; to: string; codes?: string[] | undefined }): Promise<{ results: CheckResult[]; ran: number }> {
  await sql`SET LOCAL transaction_read_only = on`.execute(trx);
  await sql`SET LOCAL statement_timeout = '15s'`.execute(trx);
  let q = trx.selectFrom('data_check_rule').selectAll().where('is_enabled', '=', true);
  if (f.codes?.length) q = q.where('code', 'in', f.codes);
  const rules = await q.orderBy('code').execute();
  const results: CheckResult[] = [];
  for (const r of rules) {
    const base = { ruleCode: r.code, ruleName: r.name, severity: r.severity, message: r.message, fixHint: r.fix_hint };
    try {
      await sql`SAVEPOINT rule`.execute(trx);
      const rows = (await trx.executeQuery<{ voucher_id: string | null; ref: string | null; detail: string | null }>(CompiledQuery.raw(wrap(r.sql), [f.from, f.to]))).rows;
      const ids = rows.map((x) => x.voucher_id).filter((x): x is string => !!x);
      const nos = ids.length ? new Map((await trx.selectFrom('voucher').select(['id', 'voucher_no']).where('id', 'in', ids).execute()).map((v) => [v.id, v.voucher_no])) : new Map<string, string | null>();
      await sql`RELEASE SAVEPOINT rule`.execute(trx);
      for (const x of rows) results.push({ ...base, voucherId: x.voucher_id, voucherNo: x.voucher_id ? nos.get(x.voucher_id) ?? null : null, ref: x.ref, detail: x.detail });
    } catch (e) {
      await sql`ROLLBACK TO SAVEPOINT rule`.execute(trx);
      await sql`RELEASE SAVEPOINT rule`.execute(trx);
      results.push({ ...base, severity: 'error', message: `Quy tắc lỗi: ${(e as Error).message}`, voucherId: null, voucherNo: null, ref: null, detail: null });
    }
  }
  return { results, ran: rules.length };
}
