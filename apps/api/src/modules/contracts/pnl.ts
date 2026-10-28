import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { COA_REGIMES, loadPayrollAccounts } from '@kt/coa-data';
import { D, type Decimal, type PnlGroup } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import { periodSubtitle, type ReportColumn, type ReportDoc } from '../reporting/print/html.js';
import { regimeOf } from '../reporting/ledgers.js';
import { tt133WipOut } from '../costing/collect.js';

// Lãi lỗ theo hợp đồng (contract_id, trừ khế ước vay) hoặc vụ việc (project_id, cộng dồn cây cha – con) trong khoảng ngày (GĐ6 Task 13b, QĐ #820–#839).
// Nhóm tài khoản theo chế độ là dữ liệu (coa-data/payroll/accounts.json khóa pnl, D2): doanh thu 511, giảm trừ 521 (TT133 ghi thẳng Nợ 511), giá vốn 632,
// chi phí sản xuất 621/622/623/627 (TT133: 154), bán hàng 641 (TT133: 6421), quản lý doanh nghiệp 642 (TT133: 6422).
// Lãi lỗ = doanh thu thuần − giá vốn − chi phí bán hàng − chi phí quản lý gắn chiều. Chi phí sản xuất gắn chiều chỉ để xem (đi vào giá vốn qua 154 → 155/632,
// trừ thêm sẽ tính trùng). Dòng không gắn chiều gom vào "unassigned": phần 641/642 của nó là chi phí chung chưa phân bổ (phân bổ PB là Task 13c).
// Bỏ chứng từ kết chuyển (is_closing: KC sang 911, 621→154) và số dư đầu kỳ; chi phí sản xuất bỏ chứng từ giá thành (cost_run) và, ở TT133, dòng 154 giá thành ra/điều chỉnh
// theo từng dòng như tập hợp chi phí (tt133WipOut, costing/collect.ts, QĐ #990). Chứng từ đã đảo và chứng từ đảo đều tính (triệt tiêu nhau).
type Trx = Transaction<Database>;
const GROUPS: PnlGroup[] = ['revenue', 'deduction', 'cogs', 'production', 'selling', 'admin'];
export interface PnlAmounts { revenue: string; deduction: string; netRevenue: string; cogs: string; grossProfit: string; selling: string; admin: string; profit: string; production: string }
export interface PnlRow extends PnlAmounts { id: number; code: string; name: string; level: number; parentCode: string | null; hasChildren: boolean; kind?: string; partyName?: string | null;
  currencyCode?: string; value?: string | null; valuePct?: string | null; budget?: string | null; costTotal?: string; budgetPct?: string | null }
export interface PnlReport { by: 'contract' | 'project'; from: string; to: string; regime: string; rows: PnlRow[]; unassigned: PnlAmounts; totals: PnlAmounts }

export type Sums = Record<PnlGroup, Decimal>;
const zero = (): Sums => Object.fromEntries(GROUPS.map((g) => [g, D(0)])) as Sums;
const add = (a: Sums, b: Sums): Sums => Object.fromEntries(GROUPS.map((g) => [g, a[g].plus(b[g])])) as Sums;
function amounts(s: Sums): PnlAmounts {
  const net = s.revenue.minus(s.deduction); const gross = net.minus(s.cogs);
  const t = (x: Decimal) => x.toFixed(0);
  return { revenue: t(s.revenue), deduction: t(s.deduction), netRevenue: t(net), cogs: t(s.cogs), grossProfit: t(gross), selling: t(s.selling), admin: t(s.admin), profit: t(gross.minus(s.selling).minus(s.admin)), production: t(s.production) };
}
const pct = (x: string, base: string | null | undefined) => (base && D(base).gt(0) ? D(x).div(base).times(100).toFixed(2) : null);
const nonZero = (s: Sums) => GROUPS.some((g) => !s[g].isZero());

export function pnlGroups(regime: string): Record<PnlGroup, string[]> {
  const g = COA_REGIMES.includes(regime as never) ? loadPayrollAccounts(regime as never)?.pnl : undefined;
  if (!g) throw new AppError('ACCOUNT_MISSING', `Chế độ kế toán ${regime} chưa có nhóm tài khoản lãi lỗ (coa-data/payroll/accounts.json)`, 400);
  return g;
}

// Phát sinh theo (chiều, nhóm) trong khoảng ngày, chiều null = không gắn. excludeAlloc: bỏ chứng từ phân bổ chi phí chung PB (Task 13c) để lấy chi phí trực tiếp làm tiêu thức.
export async function sums(trx: Trx, by: 'contract' | 'project', regime: string, from: string, to: string, excludeAlloc = false): Promise<Map<number | null, Sums>> {
  const g = pnlGroups(regime);
  const cases = GROUPS.flatMap((k) => g[k].map((p) => sql`WHEN starts_with(a.code, ${p}) THEN ${k}`));
  const dim = by === 'project' ? sql`l.project_id` : sql`CASE WHEN ct.kind <> 'loan' THEN l.contract_id END`;
  const rows = (await sql<{ dim: number | null; grp: PnlGroup; d: string; c: string }>`
    SELECT ${dim}::int AS dim, x.grp, sum(l.debit)::text AS d, sum(l.credit)::text AS c
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    LEFT JOIN contract ct ON ct.tenant_id = l.tenant_id AND ct.id = l.contract_id
    CROSS JOIN LATERAL (SELECT CASE ${sql.join(cases, sql` `)} END AS grp) x
    WHERE v.state IN ('posted', 'reversed') AND NOT v.is_closing AND v.source_doc_type IS DISTINCT FROM 'opening_balance'
      AND l.posting_date BETWEEN ${from}::date AND ${to}::date AND a.regime = ${regime} AND x.grp IS NOT NULL
      ${excludeAlloc ? sql`AND NOT (v.source_doc_type IS NOT DISTINCT FROM 'project_alloc' AND v.voucher_type = 'PB')` : sql``}
      AND NOT (x.grp = 'production' AND (v.source_doc_type IS NOT DISTINCT FROM 'cost_run' OR (${regime === 'TT133'}::boolean AND ${tt133WipOut})))
    GROUP BY 1, 2`.execute(trx)).rows;
  const out = new Map<number | null, Sums>();
  for (const r of rows) {
    let s = out.get(r.dim); if (!s) out.set(r.dim, s = zero());
    // Chiều tự nhiên: doanh thu dư Có, các nhóm còn lại dư Nợ.
    s[r.grp] = s[r.grp].plus(r.grp === 'revenue' ? D(r.c).minus(r.d) : D(r.d).minus(r.c));
  }
  return out;
}

export async function contractPnl(trx: Trx, q: { from: string; to: string; contractId?: number | undefined }): Promise<PnlReport> {
  const regime = await regimeOf(trx, q);
  const s = await sums(trx, 'contract', regime, q.from, q.to);
  const cs = (await sql<{ id: number; code: string; name: string; kind: string; partyName: string | null; currencyCode: string; value: string }>`
    SELECT c.id::int, c.code, c.name, c.kind, p.name AS "partyName", c.currency_code AS "currencyCode",
      (c.value + coalesce((SELECT sum(a.value_change) FROM contract_amendment a WHERE a.contract_id = c.id AND a.signed_date <= ${q.to}::date), 0))::text AS value
    FROM contract c LEFT JOIN party p ON p.tenant_id = c.tenant_id AND p.id = c.party_id
    WHERE c.kind <> 'loan' ${q.contractId !== undefined ? sql`AND c.id = ${q.contractId}::bigint` : sql``} ORDER BY c.code`.execute(trx)).rows;
  if (q.contractId !== undefined && !cs.length) throw new AppError('CONTRACT_NOT_FOUND', 'Không tìm thấy hợp đồng', 404);
  const rows: PnlRow[] = cs.filter((c) => q.contractId !== undefined || (s.has(c.id) && nonZero(s.get(c.id)!))).map((c) => {
    const a = amounts(s.get(c.id) ?? zero());
    // Giá trị hợp đồng so với doanh thu (VND) chỉ khi hợp đồng bằng VND; hợp đồng ngoại tệ xem % thực hiện ở theo dõi hợp đồng.
    const value = c.currencyCode === 'VND' ? c.value : null;
    return { id: c.id, code: c.code, name: c.name, level: 1, parentCode: null, hasChildren: false, kind: c.kind, partyName: c.partyName, currencyCode: c.currencyCode, ...a,
      value, valuePct: c.kind === 'sale' ? pct(a.netRevenue, value) : null };
  });
  return finish('contract', q, regime, rows, s.get(null) ?? zero(), q.contractId === undefined ? [...s].filter(([k]) => k !== null).map(([, v]) => v) : [s.get(q.contractId) ?? zero()]);
}

export async function projectPnl(trx: Trx, q: { from: string; to: string; projectId?: number | undefined }): Promise<PnlReport> {
  const regime = await regimeOf(trx, q);
  const s = await sums(trx, 'project', regime, q.from, q.to);
  const ps = (await sql<{ id: number; code: string; name: string; parentId: number | null; budget: string | null }>`
    SELECT id::int, code, name, parent_id::int AS "parentId", budget::text FROM project ORDER BY code`.execute(trx)).rows;
  const byId = new Map(ps.map((p) => [p.id, p]));
  if (q.projectId !== undefined && !byId.has(q.projectId)) throw new AppError('NOT_FOUND', 'Không tìm thấy vụ việc', 404);
  const kids = new Map<number | null, typeof ps>();
  for (const p of ps) { const k = p.parentId !== null && byId.has(p.parentId) ? p.parentId : null; kids.set(k, [...(kids.get(k) ?? []), p]); }
  // Cộng dồn: số của vụ việc cha = phát sinh gắn chính nó + mọi vụ việc con (đệ quy).
  const total = new Map<number, Sums>();
  const roll = (id: number, seen: Set<number>): Sums => {
    if (seen.has(id)) return zero(); seen.add(id); // dữ liệu vòng cha – con (không có ràng buộc ở CSDL): không cộng hai lần
    const t = (kids.get(id) ?? []).reduce((acc, k) => add(acc, roll(k.id, seen)), s.get(id) ?? zero());
    total.set(id, t); return t;
  };
  for (const p of kids.get(null) ?? []) roll(p.id, new Set());
  const rows: PnlRow[] = [];
  const walk = (p: (typeof ps)[number], level: number) => {
    const t = total.get(p.id) ?? zero();
    if (!nonZero(t) && !(level === 1 && q.projectId !== undefined)) return; // vụ việc không phát sinh thì ẩn, trừ vụ việc đang lọc
    const a = amounts(t); const costTotal = D(a.cogs).plus(a.selling).plus(a.admin).toFixed(0);
    rows.push({ id: p.id, code: p.code, name: p.name, level, parentCode: p.parentId !== null ? byId.get(p.parentId)?.code ?? null : null, hasChildren: (kids.get(p.id) ?? []).length > 0, ...a,
      budget: p.budget, costTotal, budgetPct: pct(costTotal, p.budget) });
    for (const k of kids.get(p.id) ?? []) walk(k, level + 1);
  };
  if (q.projectId !== undefined) walk(byId.get(q.projectId)!, 1); else for (const p of kids.get(null) ?? []) walk(p, 1);
  return finish('project', q, regime, rows, s.get(null) ?? zero(), q.projectId === undefined ? (kids.get(null) ?? []).map((p) => total.get(p.id) ?? zero()) : [total.get(q.projectId) ?? zero()]);
}

// Tổng = các dòng cấp 1 + không gắn chiều (khi xem cả công ty: khớp phát sinh sổ cái của các nhóm tài khoản); lọc một hợp đồng/vụ việc thì tổng là của nó.
function finish(by: 'contract' | 'project', q: { from: string; to: string; contractId?: number | undefined; projectId?: number | undefined }, regime: string, rows: PnlRow[], un: Sums, tops: Sums[]): PnlReport {
  const filtered = q.contractId !== undefined || q.projectId !== undefined;
  const top = tops.reduce(add, zero());
  return { by, from: q.from, to: q.to, regime, rows, unassigned: amounts(un), totals: amounts(filtered ? top : add(top, un)) };
}

const num = (key: string, label: string, scale = 0): ReportColumn => ({ key, label, type: 'number', scale });
export async function pnlDoc(trx: Trx, tenantId: string, r: PnlReport): Promise<ReportDoc> {
  const company = await companyInfo(trx, tenantId, r.regime, null);
  const project = r.by === 'project';
  const unLabel = project ? 'Chưa gắn vụ việc (chi phí chung chưa phân bổ)' : 'Chưa gắn hợp đồng (chi phí chung chưa phân bổ)';
  return { company, formNo: '', issuedBy: '', title: project ? 'Lãi lỗ theo vụ việc, công trình' : 'Lãi lỗ theo hợp đồng', subtitle: periodSubtitle(r.from, r.to),
    sheetName: project ? 'Lãi lỗ vụ việc' : 'Lãi lỗ hợp đồng', landscape: true,
    columns: [{ key: 'code', label: project ? 'Mã vụ việc' : 'Số hợp đồng' }, { key: 'name', label: 'Tên' }, num('revenue', 'Doanh thu'), num('deduction', 'Giảm trừ'), num('netRevenue', 'Doanh thu thuần'),
      num('cogs', 'Giá vốn'), num('grossProfit', 'Lãi gộp'), num('selling', 'Chi phí bán hàng'), num('admin', 'Chi phí quản lý'), num('profit', 'Lãi (lỗ)'), num('production', 'Chi phí sản xuất phát sinh'),
      ...(project ? [num('budget', 'Ngân sách'), num('budgetPct', '% ngân sách', 2)] : [num('value', 'Giá trị hợp đồng'), num('valuePct', '% giá trị', 2)])],
    rows: [...r.rows.map((x) => ({ ...x, name: `${'  '.repeat(x.level - 1)}${x.name}`, isBold: x.hasChildren })), { code: '', name: unLabel, ...r.unassigned }],
    footer: { code: 'Cộng', ...r.totals } };
}
