import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { COA_REGIMES, loadPayrollAccounts } from '@kt/coa-data';
import { allocateByRatio, D, Decimal, formatVnDate, sum } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import * as S from '../ledger/vouchers.service.js';
import { pnlGroups, sums } from './pnl.js';

// GĐ6 Task 13c (QĐ #860–#889). Hai loại chạy theo kỳ tháng, mỗi công ty × loại × kỳ một lần chạy; chạy lại = đảo chứng từ cũ + sinh mới, đầu vào và chứng từ khớp thì unchanged:
// - alloc: phân bổ chi phí bán hàng/quản lý chưa gắn vụ việc (lãi lỗ vụ việc: unassigned.selling + .admin, nhóm TK theo chế độ pnlGroups, TT133 6421/6422) cho các vụ việc
//   theo doanh thu thuần, chi phí trực tiếp hoặc tiêu thức nhập tay. PB (source_doc_type 'project_alloc'): Nợ TK chi phí có vụ việc / Có cùng TK không chiều — tổng công ty không đổi,
//   phần chưa phân bổ giảm đúng số phân bổ. Từng TK: các vụ việc nhận phần làm tròn xuống, vụ việc cuối (theo mã) nhận phần dư.
// - cogs: kết chuyển giá vốn vụ việc/hợp đồng hoàn thành (QĐ #807): toàn bộ số dư Nợ 154 (TK `wip` theo chế độ) của vụ việc/hợp đồng tại cuối kỳ → GT Nợ 632 / Có 154 giữ chiều.
type Trx = Transaction<Database>;
export type Ctx = { tenantId: string; userId: string; canBackdate: boolean };
export const ALLOC_KINDS = ['alloc', 'cogs'] as const;
export type AllocKind = (typeof ALLOC_KINDS)[number];

const weight = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Tiêu thức không hợp lệ');
export const allocParams = z.object({
  basis: z.enum(['revenue', 'direct_cost', 'manual']).default('revenue'),
  includeProduction: z.boolean().default(false), // tiêu thức chi phí trực tiếp có cộng chi phí sản xuất (621–627, TT133 154) gắn vụ việc
  manual: z.array(z.object({ projectCode: z.string().min(1), weight }).strict()).max(5000).default([]),
}).strict();
export const cogsParams = z.object({
  projectCodes: z.array(z.string().min(1)).max(5000).default([]),
  contractCodes: z.array(z.string().min(1)).max(5000).default([]),
}).strict();
const ym = { year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) };
export const allocInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('alloc'), ...ym, params: allocParams.default({}) }).strict(),
  z.object({ kind: z.literal('cogs'), ...ym, params: cogsParams.default({}) }).strict(),
]);
export type AllocInput = z.infer<typeof allocInput>;

type Line = { accountCode: string; debit: string; credit: string; projectCode?: string | undefined; contractCode?: string | undefined; costObjectCode?: string | undefined; itemCode?: string | undefined; warehouseCode?: string | undefined; description: string };
const mmyyyy = (y: number, m: number) => `${String(m).padStart(2, '0')}/${y}`;
const monthRange = (y: number, m: number) => ({ from: `${y}-${String(m).padStart(2, '0')}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) });
const lineKey = (l: Omit<Line, 'description'>) => [l.accountCode, D(l.debit).toFixed(0), D(l.credit).toFixed(0), l.projectCode ?? '', l.contractCode ?? '', l.costObjectCode ?? '', l.itemCode ?? '', l.warehouseCode ?? ''].join('|');
const sameLines = (a: Omit<Line, 'description'>[], b: Omit<Line, 'description'>[]) => a.map(lineKey).sort().join(';') === b.map(lineKey).sort().join(';');
// source_doc_id là uuid xác định từ (công ty, loại, kỳ) như cost_run; chứng từ đảo mang cùng nguồn.
const sourceId = (tenantId: string, kind: AllocKind, y: number, m: number) => createHash('md5').update(`${tenantId}:project_alloc:${kind}:${y}-${m}`).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

async function periodOf(trx: Trx, date: string) {
  const p = await trx.selectFrom('fiscal_period').select(['regime', 'fiscal_year', 'period_no', 'status']).where('period_no', '>=', 1).where('period_no', '<=', 15)
    .where('date_from', '<=', date).where('date_to', '>=', date).orderBy('period_no').executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Ngày ${formatVnDate(date)} (cuối kỳ) không thuộc kỳ kế toán nào đã mở`, 404);
  return p;
}
function assertWritable(p: Awaited<ReturnType<typeof periodOf>>, ctx: Ctx) {
  if (p.status === 'hard_locked') throw new AppError('PERIOD_HARD_LOCKED', `Kỳ ${p.period_no}/${p.fiscal_year} đã khóa cứng: không chạy lại phân bổ, kết chuyển vụ việc`, 409);
  if (p.status === 'soft_locked' && !ctx.canBackdate) throw new AppError('PERIOD_SOFT_LOCKED', `Kỳ ${p.period_no}/${p.fiscal_year} đã khóa sổ, cần quyền ghi lùi ngày để chạy phân bổ, kết chuyển vụ việc`, 409);
}
const leafAccount = async (trx: Trx, regime: string, code: string) => {
  const a = await trx.selectFrom('account').select(['code', 'is_group']).where('regime', '=', regime).where('code', '=', code).executeTakeFirst();
  if (!a || a.is_group) throw new AppError('ACCOUNT_MISSING', `Hệ tài khoản ${regime} không có tài khoản chi tiết ${code}`, 400);
};

export interface AllocRow { projectCode: string; projectName: string; basis: string; ratio: string; amounts: Record<string, string>; total: string }
export interface CogsRow { dim: 'project' | 'contract'; code: string; name: string; amount: string }
interface Prepared { kind: AllocKind; year: number; month: number; date: string; period: Awaited<ReturnType<typeof periodOf>>; regime: string; lines: Line[]; inputHash: string; warnings: string[];
  accounts: { code: string; name: string; pool: string }[]; result: AllocRow[] | CogsRow[] }

// Phân bổ chi phí chung: phần chưa gắn vụ việc theo TK (bỏ mọi PB phân bổ vụ việc kể cả bản đảo: phân bổ nhiều lần/đảo ngoài luồng không cộng dồn), tiêu thức từng vụ việc (số phát sinh của chính nó).
async function prepareAlloc(trx: Trx, year: number, month: number, params: z.infer<typeof allocParams>): Promise<Prepared> {
  const { from, to } = monthRange(year, month); const period = await periodOf(trx, to); const regime = period.regime;
  const g = pnlGroups(regime); const prefixes = [...g.selling, ...g.admin];
  const accounts = prefixes.length ? (await sql<{ code: string; name: string; pool: string }>`
    SELECT a.code, a.name, sum(l.debit - l.credit)::text AS pool
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.state IN ('posted', 'reversed') AND NOT v.is_closing AND v.source_doc_type IS DISTINCT FROM 'opening_balance'
      AND NOT (v.source_doc_type IS NOT DISTINCT FROM 'project_alloc' AND v.voucher_type = 'PB')
      AND l.project_id IS NULL AND l.posting_date BETWEEN ${from}::date AND ${to}::date AND a.regime = ${regime}
      AND (${sql.join(prefixes.map((p) => sql`starts_with(a.code, ${p})`), sql` OR `)})
    GROUP BY a.code, a.name HAVING sum(l.debit - l.credit) <> 0 ORDER BY a.code`.execute(trx)).rows : [];
  const warnings = accounts.filter((a) => D(a.pool).lt(0)).map((a) => `TK ${a.code} chưa gắn vụ việc dư Có ${a.pool.slice(1)} trong kỳ: không phân bổ`);
  const pools = accounts.filter((a) => D(a.pool).gt(0));
  const projects = await trx.selectFrom('project').select(['id', 'code', 'name']).orderBy('code').execute();
  const byCode = new Map(projects.map((p) => [p.code, p]));
  let bases: { code: string; name: string; basis: Decimal }[];
  if (params.basis === 'manual') {
    bases = params.manual.map((m) => { const p = byCode.get(m.projectCode); if (!p) throw new AppError('LOOKUP_NOT_FOUND', `Không có vụ việc ${m.projectCode}`, 404); return { code: p.code, name: p.name, basis: D(m.weight) }; });
    if (new Set(bases.map((b) => b.code)).size !== bases.length) throw new AppError('VALIDATION', 'Vụ việc nhập trùng trong tiêu thức nhập tay', 400);
  } else {
    const s = await sums(trx, 'project', regime, from, to, true);
    bases = projects.map((p) => { const x = s.get(p.id);
      const b = !x ? D(0) : params.basis === 'revenue' ? x.revenue.minus(x.deduction) : x.cogs.plus(x.selling).plus(x.admin).plus(params.includeProduction ? x.production : 0);
      return { code: p.code, name: p.name, basis: b }; });
  }
  bases = bases.filter((b) => b.basis.gt(0)).sort((a, b) => a.code.localeCompare(b.code));
  const total = sum(bases.map((b) => b.basis));
  if (pools.length && total.isZero())
    throw new AppError('PROJECT_ALLOC_BASIS_ZERO', `Không vụ việc nào có ${params.basis === 'revenue' ? 'doanh thu thuần' : params.basis === 'direct_cost' ? 'chi phí trực tiếp' : 'tiêu thức'} dương trong kỳ ${mmyyyy(year, month)}: không phân bổ được`, 409);
  const rows: AllocRow[] = bases.map((b) => ({ projectCode: b.code, projectName: b.name, basis: b.basis.toFixed(), ratio: b.basis.div(total).times(100).toFixed(4), amounts: {}, total: '0' }));
  const lines: Line[] = []; const desc = `Phân bổ chi phí chung kỳ ${mmyyyy(year, month)}`;
  for (const a of pools) {
    const pool = D(a.pool);
    // Phần dư làm tròn chia theo phần lẻ lớn nhất (như lương, TSCĐ, giá thành), không dồn hết vào vụ việc cuối; tổng đúng quỹ.
    const parts = allocateByRatio(pool.toFixed(0), bases.map((b) => b.basis.toString()));
    rows.forEach((r, i) => {
      const amt = D(parts[i]!);
      if (amt.isZero()) return;
      r.amounts[a.code] = amt.toFixed(0); r.total = D(r.total).plus(amt).toFixed(0);
      lines.push({ accountCode: a.code, debit: amt.toFixed(0), credit: '0', projectCode: r.projectCode, description: `${desc} cho vụ việc ${r.projectCode}` });
    });
    lines.push({ accountCode: a.code, debit: '0', credit: pool.toFixed(0), description: `${desc} (TK ${a.code})` });
  }
  const inputHash = hash({ kind: 'alloc', regime, params, accounts, bases: rows.map((r) => [r.projectCode, r.basis]), lines: lines.map(lineKey) });
  return { kind: 'alloc', year, month, date: to, period, regime, lines, inputHash, warnings, accounts, result: rows };
}

// Kết chuyển giá vốn vụ việc/hợp đồng hoàn thành: số dư 154 lũy kế đến cuối kỳ theo (TK, vụ việc, hợp đồng, đối tượng, hàng, kho), bỏ chứng từ của chính lần chạy này (và bản đảo của nó).
async function prepareCogs(trx: Trx, tenantId: string, year: number, month: number, params: z.infer<typeof cogsParams>): Promise<Prepared> {
  const { to } = monthRange(year, month); const period = await periodOf(trx, to); const regime = period.regime;
  if (!params.projectCodes.length && !params.contractCodes.length) throw new AppError('VALIDATION', 'Chọn ít nhất một vụ việc hoặc hợp đồng đã hoàn thành để kết chuyển giá vốn', 400);
  const map = COA_REGIMES.includes(regime as never) ? loadPayrollAccounts(regime as never) : undefined;
  if (!map?.wip) throw new AppError('ACCOUNT_MISSING', `Chế độ ${regime} chưa có tài khoản chi phí dở dang (coa-data/payroll/accounts.json khóa wip)`, 400);
  const cogsAcc = pnlGroups(regime).cogs[0]!; await leafAccount(trx, regime, cogsAcc);
  const projects = params.projectCodes.length ? await trx.selectFrom('project').select(['id', 'code', 'name']).where('code', 'in', params.projectCodes).execute() : [];
  const contracts = params.contractCodes.length ? await trx.selectFrom('contract').select(['id', 'code', 'name']).where('kind', '<>', 'loan').where('code', 'in', params.contractCodes).execute() : [];
  for (const c of params.projectCodes) if (!projects.some((p) => p.code === c)) throw new AppError('LOOKUP_NOT_FOUND', `Không có vụ việc ${c}`, 404);
  for (const c of params.contractCodes) if (!contracts.some((p) => p.code === c)) throw new AppError('LOOKUP_NOT_FOUND', `Không có hợp đồng ${c}`, 404);
  const pids = projects.map((p) => p.id); const cids = contracts.map((c) => c.id);
  const groups = (await sql<{ accountCode: string; projectId: number | null; projectCode: string | null; contractId: number | null; contractCode: string | null; costObjectCode: string | null; itemCode: string | null; warehouseCode: string | null; net: string }>`
    SELECT a.code AS "accountCode", l.project_id::int AS "projectId", p.code AS "projectCode", l.contract_id::int AS "contractId", c.code AS "contractCode", o.code AS "costObjectCode", i.code AS "itemCode", w.code AS "warehouseCode",
      sum(l.debit - l.credit)::text AS net
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    LEFT JOIN project p ON p.id = l.project_id LEFT JOIN contract c ON c.id = l.contract_id LEFT JOIN cost_object o ON o.id = l.cost_object_id
    LEFT JOIN item i ON i.id = l.item_id LEFT JOIN warehouse w ON w.id = l.warehouse_id
    WHERE v.state IN ('posted', 'reversed') AND l.posting_date <= ${to}::date AND a.regime = ${regime} AND starts_with(a.code, ${map.wip})
      AND v.source_doc_id IS DISTINCT FROM ${sourceId(tenantId, 'cogs', year, month)}::uuid
      AND (l.project_id = ANY(${pids}::bigint[]) OR l.contract_id = ANY(${cids}::bigint[]))
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8 HAVING sum(l.debit - l.credit) <> 0 ORDER BY 1, 3, 5, 6, 7, 8`.execute(trx)).rows;
  const warnings = groups.filter((x) => D(x.net).lt(0)).map((x) => `TK ${x.accountCode} ${x.projectCode ?? x.contractCode ?? ''} dư Có ${x.net.slice(1)}: không kết chuyển`);
  const desc = `Kết chuyển giá vốn vụ việc, hợp đồng hoàn thành kỳ ${mmyyyy(year, month)}`;
  const lines: Line[] = [];
  const result: CogsRow[] = [...projects.map((p) => ({ dim: 'project' as const, code: p.code, name: p.name, amount: '0' })), ...contracts.map((c) => ({ dim: 'contract' as const, code: c.code, name: c.name, amount: '0' }))];
  for (const x of groups.filter((y) => D(y.net).gt(0))) {
    const dims = { projectCode: x.projectCode ?? undefined, contractCode: x.contractCode ?? undefined, costObjectCode: x.costObjectCode ?? undefined };
    lines.push({ accountCode: cogsAcc, debit: x.net, credit: '0', ...dims, description: desc },
      { accountCode: x.accountCode, debit: '0', credit: x.net, ...dims, itemCode: x.itemCode ?? undefined, warehouseCode: x.warehouseCode ?? undefined, description: desc });
    // Dòng thuộc cả vụ việc lẫn hợp đồng được chọn: tính cho vụ việc (một lần).
    const r = result.find((y) => (x.projectId !== null && pids.includes(x.projectId) ? y.dim === 'project' && y.code === x.projectCode : y.dim === 'contract' && y.code === x.contractCode))!;
    r.amount = D(r.amount).plus(x.net).toFixed(0);
  }
  const inputHash = hash({ kind: 'cogs', regime, params, lines: lines.map(lineKey) });
  return { kind: 'cogs', year, month, date: to, period, regime, lines, inputHash, warnings, accounts: [], result };
}

const prepare = (trx: Trx, tenantId: string, i: AllocInput) => (i.kind === 'alloc' ? prepareAlloc(trx, i.year, i.month, i.params) : prepareCogs(trx, tenantId, i.year, i.month, i.params));

async function linesOf(trx: Trx, voucherId: string): Promise<Omit<Line, 'description'>[]> {
  const rs = await trx.selectFrom('voucher_line as l').innerJoin('account as a', 'a.id', 'l.account_id').leftJoin('project as p', 'p.id', 'l.project_id').leftJoin('contract as c', 'c.id', 'l.contract_id')
    .leftJoin('cost_object as o', 'o.id', 'l.cost_object_id').leftJoin('item as i', 'i.id', 'l.item_id').leftJoin('warehouse as w', 'w.id', 'l.warehouse_id')
    .select(['a.code as accountCode', 'l.debit', 'l.credit', 'p.code as projectCode', 'c.code as contractCode', 'o.code as costObjectCode', 'i.code as itemCode', 'w.code as warehouseCode'])
    .where('l.voucher_id', '=', voucherId).execute();
  return rs.map((r) => ({ accountCode: r.accountCode, debit: r.debit, credit: r.credit, projectCode: r.projectCode ?? undefined, contractCode: r.contractCode ?? undefined,
    costObjectCode: r.costObjectCode ?? undefined, itemCode: r.itemCode ?? undefined, warehouseCode: r.warehouseCode ?? undefined }));
}

export async function previewProjectAlloc(trx: Trx, tenantId: string, i: AllocInput) {
  const p = await prepare(trx, tenantId, i);
  return { kind: p.kind, year: p.year, month: p.month, date: p.date, regime: p.regime, accounts: p.accounts, result: p.result, lines: p.lines, warnings: p.warnings, inputHash: p.inputHash };
}

export async function getProjectAlloc(trx: Trx, kind: AllocKind, year: number, month: number) {
  const r = await trx.selectFrom('project_alloc_run as r').leftJoin('voucher as v', 'v.id', 'r.voucher_id').leftJoin('app_user as u', 'u.id', 'r.run_by')
    .select(['r.id', 'r.kind', 'r.year', 'r.month', 'r.status', 'r.regime', 'r.params', 'r.input_hash', 'r.result', 'r.voucher_id', 'v.voucher_no', 'r.warnings', 'r.run_at', 'u.username as run_by'])
    .where('r.kind', '=', kind).where('r.year', '=', year).where('r.month', '=', month).executeTakeFirst();
  if (!r) throw new AppError('PROJECT_ALLOC_NOT_FOUND', `Chưa chạy ${kind === 'alloc' ? 'phân bổ chi phí chung' : 'kết chuyển giá vốn vụ việc'} kỳ ${mmyyyy(year, month)}`, 404);
  return { id: r.id, kind: r.kind as AllocKind, year: r.year, month: r.month, status: r.status, regime: r.regime, params: r.params, inputHash: r.input_hash, result: r.result,
    voucherId: r.voucher_id, voucherNo: r.voucher_no, warnings: r.warnings as string[], runAt: r.run_at, runBy: r.run_by };
}

// "Cần chạy lại": đầu vào đổi (chi phí, doanh thu, số dư 154, tham số) hoặc chứng từ bị gỡ ngoài luồng.
export async function isAllocStale(trx: Trx, tenantId: string, run: Awaited<ReturnType<typeof getProjectAlloc>>) {
  if (run.status === 'unlinked') return true;
  // Tham số đọc lại từ jsonb (khóa đã bị sắp lại) qua schema để chữ ký đầu vào cùng thứ tự khóa như lúc chạy.
  try { return (await prepare(trx, tenantId, allocInput.parse({ kind: run.kind, year: run.year, month: run.month, params: run.params }))).inputHash !== run.inputHash; } catch { return true; }
}

/** Chạy (hoặc chạy lại) phân bổ/kết chuyển kỳ. Khớp lần chạy hiện hành → unchanged (không ghi gì, kể cả kỳ khóa); lệch → đảo chứng từ cũ (nếu nội dung đổi), sinh chứng từ mới ghi sổ ngay. */
export async function runProjectAlloc(trx: Trx, ctx: Ctx, i: AllocInput) {
  await sql`SELECT pg_advisory_xact_lock(hashtext('project_alloc'), hashtext(${ctx.tenantId}::text))`.execute(trx);
  const p = await prepare(trx, ctx.tenantId, i);
  const cur = await trx.selectFrom('project_alloc_run').select(['id', 'status', 'input_hash', 'voucher_id']).where('kind', '=', i.kind).where('year', '=', i.year).where('month', '=', i.month).forUpdate().executeTakeFirst();
  const keepVoucher = cur?.status !== 'unlinked' && sameLines(cur?.voucher_id ? await linesOf(trx, cur.voucher_id) : [], p.lines);
  if (cur && keepVoucher && cur.input_hash === p.inputHash) return { ...(await getProjectAlloc(trx, i.kind, i.year, i.month)), stale: false, unchanged: true, reversedVoucherIds: [] as string[] };
  assertWritable(p.period, ctx);
  let voucherId = cur?.voucher_id ?? null; const reversedVoucherIds: string[] = [];
  const what = i.kind === 'alloc' ? 'phân bổ chi phí chung vào vụ việc' : 'kết chuyển giá vốn vụ việc';
  if (!keepVoucher) {
    if (voucherId) { await S.reverseVoucher(trx, voucherId, { postingDate: p.date, description: `Đảo chứng từ ${what} kỳ ${mmyyyy(i.year, i.month)} (chạy lại)` }); reversedVoucherIds.push(voucherId); voucherId = null; }
    if (p.lines.length) {
      const v = await S.createSystemVoucher(trx, ctx, { voucherType: i.kind === 'alloc' ? 'PB' : 'GT', postingDate: p.date, documentDate: p.date,
        description: i.kind === 'alloc' ? `Phân bổ chi phí bán hàng, quản lý doanh nghiệp vào vụ việc kỳ ${mmyyyy(i.year, i.month)}` : `Kết chuyển giá vốn vụ việc, hợp đồng hoàn thành kỳ ${mmyyyy(i.year, i.month)}`,
        currencyCode: 'VND', lines: p.lines }, { type: 'project_alloc', id: sourceId(ctx.tenantId, i.kind, i.year, i.month) });
      await S.postVoucher(trx, v.id);
      voucherId = v.id;
    }
  }
  const row = { status: voucherId ? 'posted' : 'calculated', regime: p.regime, params: JSON.stringify(i.params), input_hash: p.inputHash, result: JSON.stringify(p.result), voucher_id: voucherId,
    warnings: JSON.stringify(p.warnings), run_by: ctx.userId, run_at: new Date() };
  if (cur) await trx.updateTable('project_alloc_run').set(row).where('id', '=', cur.id).execute();
  else await trx.insertInto('project_alloc_run').values({ tenant_id: ctx.tenantId, kind: i.kind, year: i.year, month: i.month, ...row }).execute();
  return { ...(await getProjectAlloc(trx, i.kind, i.year, i.month)), stale: false, unchanged: false, reversedVoucherIds };
}
