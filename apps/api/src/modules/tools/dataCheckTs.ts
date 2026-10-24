import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { costRunParams, isStale } from '../costing/costRun.js';
import { getRun } from '../payroll/runs.js';

// Quy tắc soát lỗi cần phép tính bằng mã (chữ ký đầu vào) chứ không viết được bằng SQL: dòng data_check_rule (migration 0109) có SQL rỗng, khớp theo mã quy tắc.
// Cùng hợp đồng đầu ra với quy tắc SQL: (voucher_id, ref, detail); chạy trong giao dịch chỉ đọc và SAVEPOINT của runDataChecks.
type Trx = Transaction<Database>;
export type TsRow = { voucher_id: string | null; ref: string | null; detail: string | null };
export type TsRule = (trx: Trx, f: { from: string; to: string }, tenantId: string) => Promise<TsRow[]>;

const mm = (y: number, m: number) => `${String(m).padStart(2, '0')}/${y}`;
// Tháng [y, m] giao với [from, to] (yyyy-mm-dd so sánh chuỗi).
const overlaps = (y: number, m: number, f: { from: string; to: string }) => {
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  return start <= f.to && `${y}-${String(m).padStart(2, '0')}-31` >= f.from;
};

export const TS_RULES: Record<string, TsRule> = {
  // Bảng lương đã tính hoặc đã hạch toán, có dòng "Cần tính lại" (getRun.stale).
  async LUONG_CAN_TINH_LAI(trx, f, tenantId) {
    const rs = await trx.selectFrom('payroll_run').select(['id', 'year', 'month', 'name', 'voucher_id']).where('status', 'in', ['calculated', 'posted']).orderBy('year').orderBy('month').orderBy('id').execute();
    const out: TsRow[] = [];
    for (const r of rs.filter((x) => overlaps(x.year, x.month, f))) {
      const n = (await getRun(trx, tenantId, r.id)).lines.filter((l) => l.stale).length;
      if (n) out.push({ voucher_id: r.voucher_id, ref: r.name, detail: `Kỳ ${mm(r.year, r.month)}: ${n} nhân viên có hồ sơ, chấm công hoặc tham số đã đổi sau lần tính` });
    }
    return out;
  },
  // Lần chạy giá thành có GT bị gỡ hoặc chữ ký đầu vào đã đổi (isStale).
  async GIA_THANH_CAN_CHAY_LAI(trx, f) {
    const rs = await trx.selectFrom('cost_run').select(['year', 'month', 'status', 'params', 'input_hash', 'voucher_id']).orderBy('year').orderBy('month').execute();
    const out: TsRow[] = [];
    for (const r of rs.filter((x) => overlaps(x.year, x.month, f)))
      if (await isStale(trx, { year: r.year, month: r.month, status: r.status, params: costRunParams.parse(r.params), inputHash: r.input_hash }))
        out.push({ voucher_id: r.voucher_id, ref: `Giá thành kỳ ${mm(r.year, r.month)}`, detail: r.status === 'unlinked' ? 'Chứng từ giá thành đã bị gỡ' : 'Chi phí, nhập kho thành phẩm hoặc dở dang kỳ trước đã đổi sau lần chạy' });
    return out;
  },
};
