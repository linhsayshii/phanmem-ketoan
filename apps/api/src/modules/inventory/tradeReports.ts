import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { READ_SNAPSHOT, type Database } from '@kt/db';
import { D, ZERO } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { regimeOf } from '../reporting/ledgers.js';
import { assertPrint, isoDate, ordered, orderedMsg, respondReport } from '../reporting/routes.js';
import { MAX_PRINT_ROWS, periodSubtitle, type ReportColumn, type ReportDoc } from '../reporting/print/html.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import { banners, mvCte, resolveScope, type Banners, type ScopeInput } from './reports.js';

type Trx = Transaction<Database>;
// Báo cáo bán hàng, mua hàng lấy số từ dòng hàng (`voucher_item_line`, VND cơ sở) của chứng từ ghi sổ hoặc đã đảo: chứng từ gốc tính ở kỳ của nó, chứng từ đảo tính số âm (theo dòng của chứng từ gốc) ở kỳ đảo,
// nên mỗi kỳ khớp sổ cái và báo cáo kỳ cũ không đổi khi đảo ở kỳ sau. Giảm giá bán, mua (GGB, GGM) là khoản giảm trừ cùng cột với hàng trả lại. Không phụ thuộc TK giảm trừ doanh thu từng chế độ.
// Giá vốn bán = giá gán hiện hành của phát sinh kho của dòng (cùng công thức báo cáo kho `mvCte`), chưa tính giá vốn thì giá tạm tính (cờ `provisional`); hàng bán bị trả lại trừ giá vốn nhập lại.

export type SalesBy = 'party' | 'item' | 'salesperson' | 'item_group' | 'month';
export type PurchasesBy = 'party' | 'item' | 'month';
export interface TradeRow { key: string; name: string; [k: string]: string | boolean }
export interface TradeResult { groupBy: string; rows: TradeRow[]; totals: Record<string, string>; costHidden: boolean; truncated: boolean; banners: Banners }

const GROUP = {
  party: { key: sql`coalesce(p.code, '')`, name: sql`coalesce(p.name, '(Không có đối tượng)')`, join: sql`LEFT JOIN party p ON p.id = ln.party_id` },
  item: { key: sql`coalesce(i.code, '')`, name: sql`coalesce(i.code || ' - ' || i.name, '(Không có mã hàng)')`, join: sql`LEFT JOIN item i ON i.id = ln.item_id` },
  item_group: { key: sql`coalesce(g.code, '')`, name: sql`coalesce(g.name, '(Không có nhóm hàng)')`, join: sql`LEFT JOIN item i ON i.id = ln.item_id LEFT JOIN item_group g ON g.id = i.group_id` },
  salesperson: { key: sql`coalesce(e.code, '')`, name: sql`coalesce(e.name, '(Không có nhân viên)')`, join: sql`LEFT JOIN employee e ON e.id = ln.employee_id` },
  month: { key: sql`to_char(ln.posting_date, 'YYYY-MM')`, name: sql`to_char(ln.posting_date, 'MM/YYYY')`, join: sql`` },
} as const;
const sum = (rows: Record<string, unknown>[], keys: string[]) => Object.fromEntries(keys.map((k) => [k, rows.reduce((a, r) => a.plus(String(r[k])), ZERO).toString()]));
const finish = (groupBy: string, rows: TradeRow[], limit: number | undefined, sumKeys: string[], costHidden: boolean, b: Banners): TradeResult => {
  const truncated = limit !== undefined && rows.length > limit; const shown = truncated ? rows.slice(0, limit) : rows;
  return { groupBy, rows: shown, totals: sum(shown, sumKeys), costHidden, truncated, banners: b };
};
const none: Banners = { provisional: false, stale: [], messages: [] };
// Dòng hàng luôn lấy từ chứng từ gốc (không phụ thuộc bản sao của reverse_voucher, GGB/GGM đảo không có bản sao): gốc dấu + ở kỳ của nó, chứng từ đảo của nó dấu - ở kỳ đảo.
// Mỗi kỳ khớp sổ cái, kỳ đã in không đổi khi đảo ở kỳ sau. shortcut: một cấp đảo, đảo của đảo chưa tính; nếu cần thì đi hết chuỗi như tax/register.ts effectiveRows.
const EFF = sql`(eff.id = v.id OR eff.reversal_of_id = v.id)`;
const SG = sql`(CASE WHEN eff.id = v.id THEN 1 ELSE -1 END)`;
const emp = sql`(SELECT x.employee_id FROM voucher_line x WHERE x.tenant_id = v.tenant_id AND x.voucher_id = v.id AND x.employee_id IS NOT NULL ORDER BY x.line_no LIMIT 1) AS employee_id`;
const qtyTxt = (c: string) => `coalesce(sum(${c}), 0)::text`;

export async function salesReport(trx: Trx, q: { from: string; to: string; groupBy: SalesBy; withCost: boolean; limit?: number | undefined } & ScopeInput): Promise<TradeResult> {
  const s = await resolveScope(trx, q); const g = GROUP[q.groupBy];
  const cost = q.withCost;
  const r = await sql<TradeRow & { provisional: boolean }>`WITH ${cost ? mvCte(s, q.to) : sql`nomv AS (SELECT 1)`},
    ln AS (
      SELECT eff.posting_date, v.party_id, l.item_id, ${emp},
        CASE WHEN v.voucher_type = 'BH' THEN ${SG} * coalesce(l.base_quantity, l.quantity * l.uom_factor, 0) ELSE 0 END AS sold_qty,
        CASE WHEN v.voucher_type = 'TLB' THEN ${SG} * coalesce(l.base_quantity, l.quantity * l.uom_factor, 0) ELSE 0 END AS ret_qty,
        CASE WHEN v.voucher_type = 'BH' THEN ${SG} * l.amount ELSE 0 END AS gross, CASE WHEN v.voucher_type = 'BH' THEN ${SG} * l.discount_amount ELSE 0 END AS disc,
        CASE WHEN v.voucher_type IN ('TLB', 'GGB') THEN ${SG} * (l.amount - l.discount_amount) ELSE 0 END AS ret, 0 AS cogs, false AS prov
      FROM voucher_item_line l JOIN voucher v ON v.id = l.voucher_id JOIN voucher eff ON ${EFF}
        ${s.itemId !== undefined || s.groupIds ? sql`JOIN item si ON si.id = l.item_id` : sql``}
      WHERE v.reversal_of_id IS NULL AND v.voucher_type IN ('BH', 'TLB', 'GGB') AND eff.state IN ('posted', 'reversed') AND eff.posting_date BETWEEN ${q.from}::date AND ${q.to}::date
        ${s.itemId !== undefined ? sql`AND l.item_id = ${s.itemId}` : sql``} ${s.groupIds ? sql`AND si.group_id = ANY(${s.groupIds}::bigint[])` : sql``}
      ${cost ? sql`UNION ALL
      SELECT m.posting_date, v.party_id, m.item_id, ${emp}, 0, 0, 0, 0, 0, CASE WHEN m.direction = 'out' THEN m.val ELSE -m.val END, m.provisional
      FROM mv m JOIN voucher_item_line l ON l.id = m.item_line_id JOIN voucher v ON v.id = l.voucher_id
      WHERE v.voucher_type IN ('BH', 'TLB') AND m.posting_date BETWEEN ${q.from}::date AND ${q.to}::date` : sql``})
    SELECT ${g.key} AS key, ${g.name} AS name, ${sql.raw(qtyTxt('ln.sold_qty'))} AS "soldQty", ${sql.raw(qtyTxt('ln.ret_qty'))} AS "returnQty",
      ${sql.raw(qtyTxt('ln.gross'))} AS "grossSales", ${sql.raw(qtyTxt('ln.disc'))} AS discount, ${sql.raw(qtyTxt('ln.ret'))} AS returns,
      coalesce(sum(ln.gross - ln.disc - ln.ret), 0)::text AS "netRevenue", coalesce(sum(ln.cogs), 0)::text AS cogs,
      coalesce(sum(ln.gross - ln.disc - ln.ret - ln.cogs), 0)::text AS "grossProfit", coalesce(bool_or(ln.prov), false) AS provisional
    FROM ln ${g.join} GROUP BY 1, 2 ORDER BY 1, 2 ${q.limit === undefined ? sql`` : sql`LIMIT ${q.limit + 1}`}`.execute(trx);
  const rows = r.rows.map(({ provisional, ...x }) => ({ ...x, soldQty: D(x['soldQty'] as string).toString(), returnQty: D(x['returnQty'] as string).toString(), ...(cost ? { provisional } : {}) })) as TradeRow[];
  if (!cost) for (const x of rows) { delete x['cogs']; delete x['grossProfit']; }
  const prov = cost && rows.some((x) => x['provisional']);
  return finish(q.groupBy, rows, q.limit, ['soldQty', 'returnQty', 'grossSales', 'discount', 'returns', 'netRevenue', ...(cost ? ['cogs', 'grossProfit'] : [])], !cost, cost ? await banners(trx, s, q.to, prov) : none);
}

export async function purchasesReport(trx: Trx, q: { from: string; to: string; groupBy: PurchasesBy; withCost: boolean; limit?: number | undefined } & ScopeInput): Promise<TradeResult> {
  const s = await resolveScope(trx, q); const g = GROUP[q.groupBy]; const cost = q.withCost;
  const flt = sql`${s.itemId !== undefined ? sql`AND l.item_id = ${s.itemId}` : sql``} ${s.groupIds ? sql`AND l.item_id IN (SELECT id FROM item WHERE group_id = ANY(${s.groupIds}::bigint[]))` : sql``}`;
  // Chi phí mua (CPM) phân bổ cho dòng nhập được tính theo ngày ghi sổ của CPM, đối tượng và hàng của dòng nhập; là giá vốn nên chỉ hiện khi có view_cost.
  const r = await sql<TradeRow>`WITH ln AS (
      SELECT eff.posting_date, v.party_id, l.item_id,
        CASE WHEN v.voucher_type = 'MH' THEN ${SG} * coalesce(l.base_quantity, l.quantity * l.uom_factor, 0) ELSE 0 END AS qty, CASE WHEN v.voucher_type = 'TLM' THEN ${SG} * coalesce(l.base_quantity, l.quantity * l.uom_factor, 0) ELSE 0 END AS ret_qty,
        CASE WHEN v.voucher_type = 'MH' THEN ${SG} * l.amount ELSE 0 END AS gross, CASE WHEN v.voucher_type = 'MH' THEN ${SG} * l.discount_amount ELSE 0 END AS disc,
        CASE WHEN v.voucher_type IN ('TLM', 'GGM') THEN ${SG} * (l.amount - l.discount_amount) ELSE 0 END AS ret,
        CASE WHEN v.voucher_type = 'MH' THEN ${SG} * l.tax_amount ELSE -${SG} * l.tax_amount END AS tax,
        CASE WHEN v.voucher_type = 'MH' THEN ${SG} * coalesce(l.import_tax, 0) ELSE 0 END AS imp, CASE WHEN v.voucher_type = 'MH' THEN ${SG} * coalesce(l.excise_tax, 0) ELSE 0 END AS exc,
        CASE WHEN v.voucher_type = 'MH' THEN ${SG} * coalesce(l.import_vat, 0) ELSE 0 END AS impvat, 0 AS landed
      FROM voucher_item_line l JOIN voucher v ON v.id = l.voucher_id JOIN voucher eff ON ${EFF}
      WHERE v.reversal_of_id IS NULL AND v.voucher_type IN ('MH', 'TLM', 'GGM') AND eff.state IN ('posted', 'reversed') AND eff.posting_date BETWEEN ${q.from}::date AND ${q.to}::date ${flt}
      ${cost ? sql`UNION ALL
      SELECT eff.posting_date, rv.party_id, l.item_id, 0, 0, 0, 0, 0, 0, 0, 0, 0, ${SG} * a.amount
      FROM landed_cost_alloc a JOIN voucher v ON v.id = a.voucher_id JOIN voucher eff ON ${EFF} JOIN voucher_item_line l ON l.tenant_id = a.tenant_id AND l.id = a.receipt_line_id JOIN voucher rv ON rv.id = l.voucher_id
      WHERE eff.state IN ('posted', 'reversed') AND eff.posting_date BETWEEN ${q.from}::date AND ${q.to}::date ${flt}` : sql``})
    SELECT ${g.key} AS key, ${g.name} AS name, ${sql.raw(qtyTxt('ln.qty'))} AS qty, ${sql.raw(qtyTxt('ln.ret_qty'))} AS "returnQty",
      ${sql.raw(qtyTxt('ln.gross'))} AS "purchaseValue", ${sql.raw(qtyTxt('ln.disc'))} AS discount, ${sql.raw(qtyTxt('ln.ret'))} AS returns,
      coalesce(sum(ln.gross - ln.disc - ln.ret), 0)::text AS "netPurchase", ${sql.raw(qtyTxt('ln.tax'))} AS "vat", ${sql.raw(qtyTxt('ln.imp'))} AS "importTax",
      ${sql.raw(qtyTxt('ln.exc'))} AS "exciseTax", ${sql.raw(qtyTxt('ln.impvat'))} AS "importVat", ${sql.raw(qtyTxt('ln.landed'))} AS "landedCost"
    FROM ln ${g.join} GROUP BY 1, 2 ORDER BY 1, 2 ${q.limit === undefined ? sql`` : sql`LIMIT ${q.limit + 1}`}`.execute(trx);
  const rows = r.rows.map((x) => ({ ...x, qty: D(x['qty'] as string).toString(), returnQty: D(x['returnQty'] as string).toString() })) as TradeRow[];
  if (!cost) for (const x of rows) delete x['landedCost'];
  return finish(q.groupBy, rows, q.limit, ['qty', 'returnQty', 'purchaseValue', 'discount', 'returns', 'netPurchase', 'vat', 'importTax', 'exciseTax', 'importVat', ...(cost ? ['landedCost'] : [])], !cost, none);
}

// ---- Bản in ----
const LABEL: Record<string, string> = { party: 'Đối tượng', item: 'Mặt hàng', salesperson: 'Nhân viên bán hàng', item_group: 'Nhóm hàng', month: 'Tháng' };
const num = (key: string, label: string, scale = 0): ReportColumn => ({ key, label, type: 'number', scale });
async function doc(trx: Trx, tenantId: string, regime: string, title: string, p: { from: string; to: string; groupBy: string }, r: TradeResult, cols: ReportColumn[]): Promise<ReportDoc> {
  const c = await companyInfo(trx, tenantId, regime, null);
  return { title, formNo: '', issuedBy: '', company: { ...c, formNo: '', issuedBy: '' }, subtitle: `${periodSubtitle(p.from, p.to)}, theo ${LABEL[p.groupBy]!.toLowerCase()}`, sheetName: title.slice(0, 31), landscape: true,
    intro: r.banners.messages, columns: [{ key: 'name', label: LABEL[p.groupBy]! }, ...cols], rows: r.rows, footer: { name: 'Cộng', ...r.totals } };
}
export const salesDoc = (trx: Trx, t: string, regime: string, p: { from: string; to: string; groupBy: string }, r: TradeResult) => doc(trx, t, regime, 'Báo cáo bán hàng', p, r,
  [num('soldQty', 'SL bán', 4), num('returnQty', 'SL trả lại', 4), num('grossSales', 'Doanh số'), num('discount', 'Chiết khấu'), num('returns', 'Giảm giá, trả lại'), num('netRevenue', 'Doanh thu thuần'), ...(r.costHidden ? [] : [num('cogs', 'Giá vốn'), num('grossProfit', 'Lãi gộp')])]);
export const purchasesDoc = (trx: Trx, t: string, regime: string, p: { from: string; to: string; groupBy: string }, r: TradeResult) => doc(trx, t, regime, 'Báo cáo mua hàng', p, r,
  [num('qty', 'SL mua', 4), num('returnQty', 'SL trả lại', 4), num('purchaseValue', 'Giá trị mua'), num('discount', 'Chiết khấu'), num('returns', 'Trả lại, giảm giá'), num('netPurchase', 'Giá trị thuần'), num('vat', 'Thuế GTGT'),
    num('importTax', 'Thuế nhập khẩu'), num('exciseTax', 'Thuế TTĐB'), num('importVat', 'GTGT hàng nhập khẩu'), ...(r.costHidden ? [] : [num('landedCost', 'Chi phí mua')])]);

// ---- Đường dẫn ----
const fmt = z.enum(['json', 'html', 'pdf', 'xlsx']).default('json');
const base = { from: isoDate, to: isoDate, format: fmt, item: z.string().min(1).optional(), group: z.string().min(1).optional() };
const routes: FastifyPluginAsyncZod = async (app) => {
  const view = app.requirePermission('report.view');
  const run = async (req: FastifyRequest, reply: FastifyReply, name: string, q: { from: string; to: string; groupBy: string; format: 'json' | 'html' | 'pdf' | 'xlsx' },
    fetch: (trx: Trx, limit: number | undefined, withCost: boolean) => Promise<TradeResult>, mk: (trx: Trx, t: string, regime: string, r: TradeResult) => Promise<ReportDoc>) => {
    if (q.format !== 'json') assertPrint(req.auth!);
    const withCost = req.auth!.sensitive.has('view_cost'); const limit = q.format === 'xlsx' ? undefined : MAX_PRINT_ROWS;
    const out = await app.withTenant(req, async (trx) => {
      const r = await fetch(trx, limit, withCost);
      if (r.truncated && q.format !== 'json') throw new AppError('PRINT_TOO_LARGE', 'Báo cáo quá lớn để in một lần; hãy xuất Excel hoặc thu hẹp bộ lọc', 413);
      return { r, d: q.format === 'json' ? null : await mk(trx, req.auth!.tenantId!, await regimeOf(trx, q), r) };
    }, READ_SNAPSHOT);
    return q.format === 'json' ? out.r : respondReport(reply, [out.d!], q.format, `${name}-${q.from}-${q.to}`);
  };
  app.get('/api/reports/sales', { preHandler: view, schema: { querystring: z.object({ ...base, groupBy: z.enum(['party', 'item', 'salesperson', 'item_group', 'month']).default('party') }).refine(ordered, orderedMsg) } }, async (req, reply) => {
    const q = req.query;
    return run(req, reply, 'ban-hang', q, (trx, limit, withCost) => salesReport(trx, { ...q, limit, withCost }), (trx, t, regime, r) => salesDoc(trx, t, regime, q, r));
  });
  app.get('/api/reports/purchases', { preHandler: view, schema: { querystring: z.object({ ...base, groupBy: z.enum(['party', 'item', 'month']).default('party') }).refine(ordered, orderedMsg) } }, async (req, reply) => {
    const q = req.query;
    return run(req, reply, 'mua-hang', q, (trx, limit, withCost) => purchasesReport(trx, { ...q, limit, withCost }), (trx, t, regime, r) => purchasesDoc(trx, t, regime, q, r));
  });
};
export default routes;
