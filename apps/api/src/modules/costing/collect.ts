import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, sum, type CostElement } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { regimeOf } from '../reporting/ledgers.js';

type Trx = Transaction<Database>;
// Tập hợp chi phí sản xuất theo đối tượng (GĐ6 Task 10b, Quy ước 8, D2) — đầu vào cho chạy giá thành (Task 11).
// TT99/TT200: phát sinh (Nợ − Có) của 621/622/627 → NVL/nhân công/SXC theo tài khoản. TT133 (không có 621/622/627): ghi thẳng 154,
// yếu tố theo khoản mục của dòng (cost_item.cost_element); dòng Có 154 của chứng từ nhập thành phẩm/xuất bán (có Nợ 155/157/632) là giá thành ra, không phải phát sinh.
// Đối tượng của dòng: cost_object_id, nếu trống thì đối tượng loại vụ việc của project_id, rồi loại hợp đồng của contract_id (0103: mỗi vụ việc/hợp đồng một đối tượng).
// Đối tượng sản phẩm, đơn hàng chỉ qua cost_object_id (D3). Không gắn được → "chưa gắn đối tượng" (627 là chi phí chung để phân bổ theo tiêu thức).
// Bỏ chứng từ kết chuyển (is_closing) và chứng từ giá thành (source_doc_type 'cost_run'): chúng chuyển chi phí, không phát sinh.
export type Element = CostElement | 'unclassified';
export interface CollectLine { accountCode: string; costItemCode: string | null; costItemName: string | null; element: CostElement | null; amount: string }
export interface CollectGroup { total: Record<Element, string>; amount: string; lines: CollectLine[] }
export interface CollectObject extends CollectGroup { id: number; code: string; name: string; kind: string; method: string | null; unit: string | null }
export interface CollectResult { year: number; month: number; from: string; to: string; regime: string; accounts: string[]; objects: CollectObject[]; unassigned: CollectGroup }

const ELEMENTS: Element[] = ['material', 'labor', 'overhead', 'unclassified'];
const group = (lines: CollectLine[]): CollectGroup => ({
  total: Object.fromEntries(ELEMENTS.map((e) => [e, sum(lines.filter((l) => (l.element ?? 'unclassified') === e).map((l) => l.amount)).toFixed(0)])) as Record<Element, string>,
  amount: sum(lines.map((l) => l.amount)).toFixed(0), lines,
});

export async function collectCosts(trx: Trx, q: { year: number; month: number; objectId?: number | undefined }): Promise<CollectResult> {
  const mm = String(q.month).padStart(2, '0');
  const from = `${q.year}-${mm}-01`; const to = `${q.year}-${mm}-${String(new Date(Date.UTC(q.year, q.month, 0)).getUTCDate()).padStart(2, '0')}`;
  const regime = await regimeOf(trx, { from, to });
  const tt133 = regime === 'TT133';
  const accounts = tt133 ? ['154'] : ['621', '622', '627'];
  const objects = await trx.selectFrom('cost_object').select(['id', 'code', 'name', 'kind', 'method', 'unit', 'is_active']).orderBy('code').execute();
  if (q.objectId !== undefined && !objects.some((o) => o.id === q.objectId)) throw new AppError('NOT_FOUND', 'Không tìm thấy đối tượng tập hợp chi phí', 404);
  const rows = (await sql<CollectLine & { objectId: number | null }>`
    SELECT o.id AS "objectId", a.code AS "accountCode", ci.code AS "costItemCode", ci.name AS "costItemName",
      CASE WHEN a.code LIKE '621%' THEN 'material' WHEN a.code LIKE '622%' THEN 'labor' WHEN a.code LIKE '627%' THEN 'overhead' ELSE ci.cost_element END AS element,
      sum(l.debit - l.credit)::text AS amount
    FROM voucher_line l
    JOIN voucher v ON v.id = l.voucher_id
    JOIN account a ON a.id = l.account_id
    LEFT JOIN cost_item ci ON ci.id = l.cost_item_id
    LEFT JOIN cost_object o ON o.id = COALESCE(l.cost_object_id,
      (SELECT x.id FROM cost_object x WHERE x.kind = 'project' AND x.project_id = l.project_id),
      (SELECT x.id FROM cost_object x WHERE x.kind = 'contract' AND x.contract_id = l.contract_id))
    WHERE v.state IN ('posted','reversed') AND NOT v.is_closing AND v.source_doc_type IS DISTINCT FROM 'cost_run'
      AND l.posting_date BETWEEN ${from}::date AND ${to}::date AND a.regime = ${regime}
      AND (${sql.join(accounts.map((c) => sql`starts_with(a.code, ${c})`), sql` OR `)})
      AND NOT (${tt133}::boolean AND l.credit > 0 AND EXISTS (SELECT 1 FROM voucher_line y JOIN account ya ON ya.id = y.account_id
        WHERE y.voucher_id = l.voucher_id AND y.debit > 0 AND (ya.code LIKE '155%' OR ya.code LIKE '157%' OR ya.code LIKE '632%')))
    GROUP BY 1, 2, 3, 4, 5
    HAVING sum(l.debit - l.credit) <> 0
    ORDER BY 2, 3 NULLS FIRST`.execute(trx)).rows.map((r) => ({ ...r, amount: D(r.amount).toFixed(0) }));
  const strip = ({ objectId: _o, ...l }: (typeof rows)[number]): CollectLine => l;
  const out = objects.filter((o) => (q.objectId === undefined ? o.is_active || rows.some((r) => r.objectId === o.id) : o.id === q.objectId))
    .map(({ is_active: _a, ...o }) => ({ ...o, ...group(rows.filter((r) => r.objectId === o.id).map(strip)) }));
  return { year: q.year, month: q.month, from, to, regime, accounts, objects: out, unassigned: group(rows.filter((r) => r.objectId === null).map(strip)) };
}
