import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { costRunParams, isStale } from '../costing/costRun.js';
import { getRun } from '../payroll/runs.js';
import { pnlGroups, sums } from '../contracts/pnl.js';
import { regimeOf } from '../reporting/ledgers.js';

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
  // Tháng có vụ việc đang hoạt động mà 641/642 (TT133 6421/6422, nhóm theo chế độ) chưa gắn vụ việc còn dư Nợ: cùng phép tính "chưa phân bổ" của lãi lỗ vụ việc (PB đã gồm, nên phân bổ đủ thì về 0).
  async VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO(trx, f) {
    const out: TsRow[] = [];
    // shortcut: tối đa 36 tháng mỗi lần soát (mỗi tháng một truy vấn tổng hợp); khoảng dài hơn chỉ soát 36 tháng đầu.
    const y0 = Number(f.from.slice(0, 4)); const m0 = Number(f.from.slice(5, 7)) - 1;
    for (let i = 0; i < 36; i++) {
      const y = y0 + Math.floor((m0 + i) / 12); const m = ((m0 + i) % 12) + 1;
      const from = `${y}-${String(m).padStart(2, '0')}-01`;
      if (from > f.to) break;
      const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const active = await trx.selectFrom('project').select('code').where('is_active', '=', true)
        .where((e) => e.or([e('date_from', 'is', null), e('date_from', '<=', to)])).where((e) => e.or([e('date_to', 'is', null), e('date_to', '>=', from)])).orderBy('code').execute();
      if (!active.length) continue;
      const regime = await regimeOf(trx, { from, to });
      const un = (await sums(trx, 'project', regime, from, to)).get(null);
      const g = pnlGroups(regime);
      const rows = un ? [['selling', 'bán hàng', un.selling], ['admin', 'quản lý doanh nghiệp', un.admin]] as const : [];
      for (const [k, label, amt] of rows) if (amt.gt(0)) out.push({ voucher_id: null, ref: g[k].join(', '), detail: `Kỳ ${mm(y, m)}: chi phí ${label} chưa phân bổ vào vụ việc ${amt.toFixed(0)} (${active.length} vụ việc đang hoạt động)` });
    }
    return out;
  },
};
