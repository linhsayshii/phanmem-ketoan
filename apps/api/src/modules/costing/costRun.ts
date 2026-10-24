import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import {
  allocateOverhead, costCoefficient, costOrder, costProject, costRatio, costSimple, COST_ELEMENTS, D, Decimal, formatVnDate, ProductCostError,
  type CostBreakdown, type CostElement, type ProductCostResult, type WipMethod,
} from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import * as S from '../ledger/vouchers.service.js';
import { collectCosts, type CollectLine } from './collect.js';

// Chạy giá thành theo kỳ tháng (GĐ6 Task 11a; Quy ước 8, D1–D4). Đầu vào: chi phí tập hợp theo đối tượng (collect.ts), 627 chưa gắn đối tượng
// phân bổ theo tiêu thức rồi cộng vào phát sinh SXC của từng đối tượng, dở dang đầu = dở dang cuối của lần chạy kỳ gần nhất trước đó.
// Tính bằng động cơ thuần productCost.ts theo phương pháp của đối tượng. TT99/TT200: chứng từ hệ thống GT (ghi sổ ngay, ngày cuối tháng)
// kết chuyển 621/622/627 → 154 theo đối tượng, KHÔNG ghi 155 (thành phẩm vào kho là lớp giá nhập GĐ3, Task 11b, đọc cost_run_output).
// TT133 tập hợp thẳng 154 (D2): không có GT. Chạy lại = đảo GT cũ + sinh GT mới; đầu vào và GT khớp thì giữ nguyên (unchanged).
type Trx = Transaction<Database>;
export type Ctx = { tenantId: string; userId: string; canBackdate: boolean };

const qty = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/, 'Số lượng không hợp lệ');
const pct = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Tỷ lệ phần trăm không hợp lệ');
const dec4 = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Số không hợp lệ');
export const OVERHEAD_BASES = ['direct_labor', 'direct_material', 'machine_hours', 'revenue', 'manual'] as const;
const METHODS = ['simple', 'coefficient', 'ratio', 'project', 'order'] as const;
type Method = (typeof METHODS)[number];
export const costRunParams = z.object({
  // Tiêu thức phân bổ 627 chưa gắn đối tượng: nhân công/NVL trực tiếp đọc từ chi phí tập hợp; giờ máy, doanh thu, nhập tay do người dùng nhập (basis).
  overheadBasis: z.enum(OVERHEAD_BASES).default('direct_labor'),
  objects: z.array(z.object({
    objectCode: z.string().min(1),
    method: z.enum(METHODS).optional(),
    wip: z.enum(['none', 'direct_material', 'equivalent_units']).default('none'),
    completion: z.object({ material: pct.optional(), labor: pct, overhead: pct }).strict().optional(),
    completed: z.boolean().optional(), // vụ việc/hợp đồng/đơn hàng
    basis: dec4.optional(),
    // Sản phẩm đầu ra; qty bỏ trống = số nhập kho thành phẩm (PNK "Nhập thành phẩm") trong tháng.
    outputs: z.array(z.object({ itemCode: z.string().min(1).optional(), qty: qty.optional(), wipQty: qty.optional(), coefficient: dec4.optional(),
      standardUnitCost: z.object({ material: dec4, labor: dec4, overhead: dec4 }).strict().optional() }).strict()).max(200).default([]),
  }).strict()).max(5000).default([]),
}).strict();
export type CostRunParams = z.infer<typeof costRunParams>;
export const costRunInput = z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12), params: costRunParams.default({}) }).strict();

export interface OutputDto { lineNo: number; itemCode: string | null; itemName: string | null; qty: string; wipQty: string; coefficient: string | null; standardUnitCost: CostBreakdown | null; cost: CostBreakdown; total: string; unitCost: string }
export interface RunObjectDto {
  objectId: number; code: string; name: string; kind: string; method: Method; wipMethod: WipMethod['method']; completion: { material: string; labor: string; overhead: string } | null; completed: boolean | null;
  overheadBasis: string; allocatedOverhead: string; opening: CostBreakdown; incurred: CostBreakdown; closing: CostBreakdown; cost: CostBreakdown; total: string;
  completedQty: string; wipQty: string; unitCost: string | null; outputs: OutputDto[];
}
type Blocker = { objectCode: string | null; accountCode: string; costItemCode: string | null; costItemName: string | null; amount: string };
type GtLine = { accountCode: string; debit: string; credit: string; costObjectCode?: string | undefined; projectCode?: string | undefined; contractCode?: string | undefined; costItemCode?: string | null; itemCode?: string | undefined; description: string };

const ZERO3: CostBreakdown = { material: '0', labor: '0', overhead: '0' };
const NAME: Record<CostElement, string> = { material: 'chi phí NVL trực tiếp', labor: 'chi phí nhân công trực tiếp', overhead: 'chi phí sản xuất chung' };
const mmyyyy = (y: number, m: number) => `${String(m).padStart(2, '0')}/${y}`;
const num = (x: string | number | null) => (x === null ? null : D(x).toFixed()); // số lượng, tỷ lệ: bỏ số 0 thừa (cùng dạng xem trước và đã lưu)
const lineKey = (l: Omit<GtLine, 'description'>) => [l.accountCode, D(l.debit).toFixed(0), D(l.credit).toFixed(0), l.costObjectCode ?? '', l.projectCode ?? '', l.contractCode ?? '', l.costItemCode ?? '', l.itemCode ?? ''].join('|');
const sameLines = (a: Omit<GtLine, 'description'>[], b: Omit<GtLine, 'description'>[]) => a.map(lineKey).sort().join(';') === b.map(lineKey).sort().join(';');
// source_doc_id là uuid: xác định từ (công ty, kỳ) như bảng lương (payroll/post.ts).
const sourceId = (tenantId: string, y: number, m: number) => createHash('md5').update(`${tenantId}:cost_run:${y}-${m}`).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const engine = <T>(f: () => T): T => {
  try { return f(); } catch (e) { if (e instanceof ProductCostError) throw new AppError(e.code, e.message, e.code === 'PRODUCT_COST_INVALID' ? 400 : 409); throw e; }
};

function compute(method: Method, p: { opening: CostBreakdown; incurred: CostBreakdown }, wip: WipMethod, outs: { qty: string; wipQty: string; coefficient: string | null; standard: CostBreakdown | null }[], completed: boolean): ProductCostResult {
  return engine(() => {
    switch (method) {
      case 'simple': return costSimple({ ...p, key: '0', completedQty: outs[0]!.qty, wipQty: outs[0]!.wipQty, wip });
      case 'coefficient': return costCoefficient({ ...p, wip, outputs: outs.map((o, i) => ({ key: String(i), qty: o.qty, wipQty: o.wipQty, coefficient: o.coefficient ?? '0' })) });
      case 'ratio': return costRatio({ ...p, wip, outputs: outs.map((o, i) => ({ key: String(i), qty: o.qty, wipQty: o.wipQty, standardUnitCost: o.standard ?? ZERO3 })) });
      case 'project': return costProject({ ...p, key: '0', completed });
      case 'order': return costOrder({ ...p, key: '0', completed, qty: outs[0]?.qty ?? '0' });
    }
  });
}

// Phát sinh nhập thành phẩm của tháng nhận giá thành (D4, QĐ #773): PNK "Nhập thành phẩm", không chuyển kho, chưa bị đảo, theo thứ tự ghi sổ
// (dòng cuối nhận phần dư); cộng phát sinh đã có lớp giá của lần chạy runId (để chạy lại trả lại phần cũ). cur = giá trị nhập hiện tại, mine = phần của lần chạy.
async function finishedReceipts(trx: Trx, from: string, to: string, runId: number | null) {
  return (await sql<{ id: number; item_id: number; item_code: string; warehouse_id: number; lot_no: string | null; posting_date: string; qty: string; voucher_no: string | null; line_no: number; cur: string; mine: string }>`
    SELECT m.id, m.item_id, i.code AS item_code, m.warehouse_id, m.lot_no, m.posting_date::text AS posting_date, m.quantity::text AS qty, v.voucher_no, l.line_no,
      (SELECT coalesce(sum(c.value), 0) FROM stock_cost_layer c WHERE c.tenant_id = m.tenant_id AND c.move_id = m.id AND c.kind IN ('receipt', 'adjustment'))::text AS cur,
      (SELECT coalesce(sum(c.value), 0) FROM stock_cost_layer c WHERE c.tenant_id = m.tenant_id AND c.move_id = m.id AND c.cost_run_id = ${runId}::bigint)::text AS mine
    FROM stock_move m JOIN voucher v ON v.id = m.voucher_id JOIN voucher_item_line l ON l.tenant_id = m.tenant_id AND l.id = m.item_line_id JOIN item i ON i.id = m.item_id
    WHERE m.direction = 'in' AND m.transfer_id IS NULL AND m.reversal_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM stock_move r WHERE r.tenant_id = m.tenant_id AND r.reversal_of = m.id)
      AND ((v.voucher_type = 'PNK' AND v.stock_kind = 'finished' AND m.posting_date BETWEEN ${from}::date AND ${to}::date)
        OR EXISTS (SELECT 1 FROM stock_cost_layer c WHERE c.tenant_id = m.tenant_id AND c.move_id = m.id AND c.cost_run_id = ${runId}::bigint))
    ORDER BY m.posting_date, v.day_order, v.seq_no, l.line_no, m.id`.execute(trx)).rows;
}

async function periodOf(trx: Trx, date: string) {
  const p = await trx.selectFrom('fiscal_period').select(['regime', 'fiscal_year', 'period_no', 'status']).where('period_no', '>=', 1).where('period_no', '<=', 15)
    .where('date_from', '<=', date).where('date_to', '>=', date).orderBy('period_no').executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Ngày ${formatVnDate(date)} (cuối kỳ giá thành) không thuộc kỳ kế toán nào đã mở`, 404);
  return p;
}
function assertWritable(p: Awaited<ReturnType<typeof periodOf>>, ctx: Ctx) {
  if (p.status === 'hard_locked') throw new AppError('PERIOD_HARD_LOCKED', `Kỳ ${p.period_no}/${p.fiscal_year} đã khóa cứng: không chạy lại giá thành`, 409);
  if (p.status === 'soft_locked' && !ctx.canBackdate) throw new AppError('PERIOD_SOFT_LOCKED', `Kỳ ${p.period_no}/${p.fiscal_year} đã khóa sổ, cần quyền ghi lùi ngày để chạy giá thành`, 409);
}

/** Tính giá thành kỳ không ghi gì: kết quả theo đối tượng, dòng GT, chữ ký đầu vào, khoản chặn chạy (chưa phân loại yếu tố, chi phí trực tiếp chưa gắn đối tượng). */
export async function prepareCostRun(trx: Trx, year: number, month: number, params: CostRunParams) {
  const col = await collectCosts(trx, { year, month });
  const period = await periodOf(trx, col.to);
  const objs = await trx.selectFrom('cost_object as o').leftJoin('item as i', 'i.id', 'o.item_id').leftJoin('project as p', 'p.id', 'o.project_id').leftJoin('contract as c', 'c.id', 'o.contract_id')
    .select(['o.id', 'o.code', 'o.name', 'o.kind', 'o.method', 'o.item_id', 'i.code as item_code', 'i.name as item_name', 'p.code as project_code', 'c.code as contract_code']).orderBy('o.code').execute();
  const costOf = new Map(col.objects.map((o) => [o.id, o]));
  // Dở dang đầu = dở dang cuối của lần chạy kỳ gần nhất trước kỳ này (kỳ trước chạy lại làm chữ ký kỳ này đổi → "Cần chạy lại").
  const prev = await trx.selectFrom('cost_run').select(['id', 'year', 'month']).where((eb) => eb.or([eb('year', '<', year), eb.and([eb('year', '=', year), eb('month', '<', month)])]))
    .orderBy('year', 'desc').orderBy('month', 'desc').limit(1).executeTakeFirst();
  const openOf = new Map((prev ? await trx.selectFrom('cost_run_object').select(['cost_object_id', 'closing_material', 'closing_labor', 'closing_overhead']).where('run_id', '=', prev.id).execute() : [])
    .map((r) => [r.cost_object_id, { material: D(r.closing_material).toFixed(0), labor: D(r.closing_labor).toFixed(0), overhead: D(r.closing_overhead).toFixed(0) }]));
  const cfgOf = new Map<string, CostRunParams['objects'][number]>();
  for (const c of params.objects) {
    if (cfgOf.has(c.objectCode)) throw new AppError('VALIDATION', `Đối tượng ${c.objectCode} khai hai lần`, 400);
    if (!objs.some((o) => o.code === c.objectCode)) throw new AppError('LOOKUP_NOT_FOUND', `Không có đối tượng tập hợp chi phí mã "${c.objectCode}"`, 404);
    cfgOf.set(c.objectCode, c);
  }
  const nonZero = (b: Record<string, string> | undefined) => !!b && Object.values(b).some((v) => !D(v).isZero());
  const inRun = objs.filter((o) => cfgOf.has(o.code) || nonZero(costOf.get(o.id)?.total) || nonZero(openOf.get(o.id)));

  // Chặn chạy: yếu tố chưa phân loại (TT133: khoản mục chưa khai yếu tố) và NVL/nhân công trực tiếp chưa gắn đối tượng (chỉ 627 mới phân bổ).
  const unclassified: Blocker[] = []; const unassigned: Blocker[] = [];
  const pick = (code: string | null, lines: CollectLine[], into: Blocker[], f: (l: CollectLine) => boolean) => {
    for (const l of lines) if (f(l)) into.push({ objectCode: code, accountCode: l.accountCode, costItemCode: l.costItemCode, costItemName: l.costItemName, amount: l.amount });
  };
  for (const o of inRun) pick(o.code, costOf.get(o.id)?.lines ?? [], unclassified, (l) => l.element === null);
  pick(null, col.unassigned.lines, unclassified, (l) => l.element === null);
  pick(null, col.unassigned.lines, unassigned, (l) => l.element === 'material' || l.element === 'labor');

  // Sản phẩm đầu ra: mã vật tư khai ở tham số; sản lượng mặc định = số nhập kho thành phẩm trong tháng.
  const codes = [...new Set(params.objects.flatMap((c) => c.outputs.flatMap((x) => (x.itemCode ? [x.itemCode] : []))))];
  const items = new Map((codes.length ? await trx.selectFrom('item').select(['id', 'code', 'name']).where('code', 'in', codes).execute() : []).map((i) => [i.code, i]));
  for (const c of codes) if (!items.has(c)) throw new AppError('LOOKUP_NOT_FOUND', `Không có vật tư hàng hóa mã "${c}"`, 404);
  const receipts = await finishedReceipts(trx, col.from, col.to, null);
  const stock = new Map<number, string>();
  for (const r of receipts) stock.set(Number(r.item_id), D(stock.get(Number(r.item_id)) ?? 0).plus(r.qty).toFixed());

  // Phân bổ 627 chưa gắn đối tượng cho các đối tượng của lần chạy theo tiêu thức (phần lẻ lớn nhất, Σ = tổng).
  const own = (o: (typeof objs)[number]): CostBreakdown => {
    const t = costOf.get(o.id)?.total; return t ? { material: t.material, labor: t.labor, overhead: t.overhead } : { ...ZERO3 };
  };
  const basisOf = (o: (typeof objs)[number]) => (params.overheadBasis === 'direct_labor' ? own(o).labor : params.overheadBasis === 'direct_material' ? own(o).material : (cfgOf.get(o.code)?.basis ?? '0'));
  const shared = col.unassigned.total.overhead;
  const alloc = new Map(D(shared).isZero() ? [] : engine(() => allocateOverhead(shared, inRun.map((o) => ({ key: o.code, basis: basisOf(o) })))).map((a) => [a.key, a.amount]));

  const warnings: string[] = [];
  const objects: (RunObjectDto & { lines: CollectLine[]; dims: Pick<GtLine, 'costObjectCode' | 'projectCode' | 'contractCode'>; itemCode: string | null })[] = [];
  for (const o of inRun) {
    const cfg = cfgOf.get(o.code);
    const method: Method = cfg?.method ?? (o.method as Method | null) ?? (o.kind === 'product' ? 'simple' : o.kind === 'order' ? 'order' : 'project');
    const allocated = alloc.get(o.code) ?? '0';
    const base = own(o);
    const incurred = { ...base, overhead: D(base.overhead).plus(allocated).toFixed(0) };
    const opening = openOf.get(o.id) ?? { ...ZERO3 };
    const lumpSum = method === 'project' || method === 'order';
    const wipMethod = lumpSum ? 'none' : (cfg?.wip ?? 'none');
    if (wipMethod === 'equivalent_units' && !cfg?.completion) throw new AppError('VALIDATION', `Đối tượng ${o.code}: dở dang theo sản lượng tương đương cần mức hoàn thành nhân công và sản xuất chung`, 400);
    const completion = wipMethod === 'equivalent_units' ? { material: num(cfg!.completion!.material ?? '100')!, labor: num(cfg!.completion!.labor)!, overhead: num(cfg!.completion!.overhead)! } : null;
    const wip: WipMethod = completion ? { method: 'equivalent_units', completion } : { method: wipMethod as 'none' | 'direct_material' };
    const completed = lumpSum ? (cfg?.completed ?? false) : null;
    // Đầu ra: khai ở tham số; trống thì sản phẩm của đối tượng loại sản phẩm (giản đơn) hoặc một dòng không mã hàng (vụ việc/đơn hàng).
    const declared = cfg?.outputs.length ? cfg.outputs : [o.item_code ? { itemCode: o.item_code } : {}];
    if ((method === 'simple' || method === 'project' || method === 'order') && declared.length > 1) throw new AppError('VALIDATION', `Đối tượng ${o.code}: phương pháp ${method === 'simple' ? 'giản đơn' : 'vụ việc/đơn hàng'} chỉ có một đầu ra`, 400);
    const outs = declared.map((x) => {
      // mã sản phẩm của đối tượng lấy từ đối tượng; mã khác ở tham số đã kiểm có trong danh mục
      const code = x.itemCode ?? (declared.length === 1 ? o.item_code : null);
      const it = !code ? null : code === o.item_code ? { id: o.item_id!, code, name: o.item_name! } : items.get(code)!;
      if ((method === 'coefficient' || method === 'ratio' || method === 'simple') && !it) throw new AppError('VALIDATION', `Đối tượng ${o.code}: khai sản phẩm đầu ra (mã vật tư)`, 400);
      if (method === 'coefficient' && !x.coefficient) throw new AppError('VALIDATION', `Đối tượng ${o.code}: sản phẩm ${it!.code} chưa có hệ số`, 400);
      if (method === 'ratio' && !x.standardUnitCost) throw new AppError('VALIDATION', `Đối tượng ${o.code}: sản phẩm ${it!.code} chưa có giá thành định mức đơn vị`, 400);
      const received = it ? stock.get(it.id) : undefined;
      const q = method === 'project' ? (completed ? '1' : '0') : x.qty ?? received ?? '0';
      if (it && received !== undefined && x.qty !== undefined && !D(x.qty).eq(received)) warnings.push(`Đối tượng ${o.code}: sản lượng hoàn thành ${it.code} khai ${num(x.qty)} khác số nhập kho thành phẩm trong kỳ ${received}`);
      return { it, qty: num(q)!, wipQty: num(x.wipQty ?? '0')!, coefficient: x.coefficient ? num(x.coefficient) : null, standard: x.standardUnitCost ?? null, received };
    });
    const r = compute(method, { opening, incurred }, wip, outs, completed ?? false);
    const outputs: OutputDto[] = r.products.map((p) => {
      const x = outs[Number(p.key)]!;
      if (x.it && !D(p.total).isZero() && !x.received) warnings.push(`Đối tượng ${o.code}: sản phẩm ${x.it.code} có giá thành ${p.total} nhưng chưa có phiếu nhập kho thành phẩm trong kỳ`);
      return { lineNo: Number(p.key) + 1, itemCode: x.it?.code ?? null, itemName: x.it?.name ?? null, qty: x.qty, wipQty: x.wipQty, coefficient: x.coefficient,
        standardUnitCost: x.standard ? { material: D(x.standard.material).toFixed(4), labor: D(x.standard.labor).toFixed(4), overhead: D(x.standard.overhead).toFixed(4) } : null,
        cost: p.cost, total: p.total, unitCost: p.unitTotal };
    });
    objects.push({
      objectId: o.id, code: o.code, name: o.name, kind: o.kind, method, wipMethod: wip.method, completion, completed,
      overheadBasis: num(basisOf(o))!, allocatedOverhead: D(allocated).toFixed(0), opening: r.opening, incurred: r.incurred, closing: r.closing, cost: r.cost, total: r.total,
      completedQty: outputs.reduce((s, x) => s.plus(x.qty), D(0)).toFixed(), wipQty: outputs.reduce((s, x) => s.plus(x.wipQty), D(0)).toFixed(),
      unitCost: outputs.length === 1 ? outputs[0]!.unitCost : null, outputs,
      lines: costOf.get(o.id)?.lines.filter((l) => l.element !== null) ?? [],
      dims: { costObjectCode: o.code, ...(o.project_code && { projectCode: o.project_code }), ...(o.contract_code && { contractCode: o.contract_code }) },
      itemCode: outputs.length === 1 ? outputs[0]!.itemCode : null, // một sản phẩm đầu ra: dòng 154 mang mã sản phẩm (D3); nhóm hệ số/tỷ lệ chỉ theo đối tượng
    });
  }

  // GT (TT99/TT200): Có 621/622/627 đúng tài khoản, khoản mục của từng dòng tập hợp, mang đối tượng; Có 627 chưa gắn đối tượng (đã phân bổ);
  // Nợ 154 theo đối tượng và khoản mục giá thành (đối tượng sản phẩm mang mã sản phẩm để 11b khớp 154 với PNK theo vật tư). Số âm đổi bên.
  const gtLines: GtLine[] = [];
  const add = (l: Omit<GtLine, 'debit' | 'credit'>, debitAmount: string) => {
    const a = D(debitAmount); if (a.isZero()) return;
    gtLines.push({ ...l, debit: a.gt(0) ? a.toFixed(0) : '0', credit: a.lt(0) ? a.neg().toFixed(0) : '0' });
  };
  const elem = (l: CollectLine) => NAME[l.element ?? 'overhead'];
  if (period.regime !== 'TT133') {
    for (const o of objects) {
      for (const l of o.lines) add({ accountCode: l.accountCode, ...o.dims, costItemCode: l.costItemCode, description: `Kết chuyển ${elem(l)} — ${o.code}` }, D(l.amount).neg().toFixed(0));
      for (const e of COST_ELEMENTS) add({ accountCode: '154', ...o.dims, ...(o.itemCode && { itemCode: o.itemCode }), description: `Chi phí sản xuất kinh doanh dở dang (${NAME[e]}) — ${o.code}` }, o.incurred[e]);
    }
    for (const l of col.unassigned.lines) if (l.element === 'overhead') add({ accountCode: l.accountCode, costItemCode: l.costItemCode, description: 'Kết chuyển chi phí sản xuất chung phân bổ' }, D(l.amount).neg().toFixed(0));
  }
  const result = objects.map(({ lines: _l, dims: _d, itemCode: _i, ...r }) => r);
  // Dòng nhập thành phẩm của sản phẩm đầu ra vào chữ ký: thêm/đảo PNK (kể cả khi sản lượng khai tay) → "Cần chạy lại" để chia lại giá thành (11b).
  const outCodes = new Set(objects.flatMap((o) => o.outputs.flatMap((x) => (x.itemCode ? [x.itemCode] : []))));
  const recv = receipts.filter((r) => outCodes.has(r.item_code)).map((r) => [String(r.id), D(r.qty).toFixed()]);
  const inputHash = createHash('sha256').update(JSON.stringify({ regime: period.regime, params, objects: objects.map((o) => [o.code, o.lines, o.outputs.map((x) => [x.itemCode, x.qty])]), unassigned: col.unassigned.lines, result, recv })).digest('hex');
  return { year, month, from: col.from, date: col.to, period, regime: period.regime, objects: result, unassigned: col.unassigned, sharedOverhead: shared, gtLines, inputHash, warnings, blockers: { unclassified, unassigned } };
}

export const previewCostRun = prepareCostRun; // xem trước: cùng tính toán, không ghi

const voucherNoOf = async (trx: Trx, id: string | null) => (id ? (await trx.selectFrom('voucher').select('voucher_no').where('id', '=', id).executeTakeFirst())?.voucher_no ?? null : null);
async function gtLinesOf(trx: Trx, voucherId: string) {
  return trx.selectFrom('voucher_line as l').innerJoin('account as a', 'a.id', 'l.account_id').leftJoin('cost_object as o', 'o.id', 'l.cost_object_id').leftJoin('project as p', 'p.id', 'l.project_id')
    .leftJoin('contract as c', 'c.id', 'l.contract_id').leftJoin('cost_item as ci', 'ci.id', 'l.cost_item_id').leftJoin('item as i', 'i.id', 'l.item_id')
    .select(['a.code as accountCode', 'l.debit', 'l.credit', 'o.code as costObjectCode', 'p.code as projectCode', 'c.code as contractCode', 'ci.code as costItemCode', 'i.code as itemCode'])
    .where('l.voucher_id', '=', voucherId).execute()
    .then((rs) => rs.map((r) => ({ ...r, costObjectCode: r.costObjectCode ?? undefined, projectCode: r.projectCode ?? undefined, contractCode: r.contractCode ?? undefined, itemCode: r.itemCode ?? undefined })));
}

/**
 * Chạy (hoặc chạy lại) giá thành kỳ: chặn khi còn chi phí chưa phân loại/chưa gắn đối tượng (409), lưu kết quả, sinh GT.
 * Đầu vào và GT khớp lần chạy hiện hành → unchanged (không ghi gì, kể cả ở kỳ khóa); lệch → đảo GT cũ (nếu nội dung GT đổi) và sinh GT mới.
 */
export async function runCostRun(trx: Trx, ctx: Ctx, year: number, month: number, params: CostRunParams) {
  await sql`SELECT pg_advisory_xact_lock(hashtext('cost_run'), hashtext(${ctx.tenantId}::text))`.execute(trx);
  const p = await prepareCostRun(trx, year, month, params);
  if (p.blockers.unclassified.length) throw new AppError('COST_RUN_UNCLASSIFIED', `Còn ${p.blockers.unclassified.length} khoản chi phí sản xuất chưa phân loại yếu tố giá thành (khoản mục chưa khai "Yếu tố giá thành"): khai yếu tố cho khoản mục rồi chạy lại`, 409, { lines: p.blockers.unclassified });
  if (p.blockers.unassigned.length) throw new AppError('COST_RUN_UNASSIGNED', `Còn ${p.blockers.unassigned.length} khoản chi phí NVL/nhân công trực tiếp chưa gắn đối tượng tập hợp chi phí: gắn đối tượng (hoặc vụ việc) cho dòng chứng từ rồi chạy lại`, 409, { lines: p.blockers.unassigned });
  const cur = await trx.selectFrom('cost_run').select(['id', 'status', 'input_hash', 'voucher_id']).where('year', '=', year).where('month', '=', month).forUpdate().executeTakeFirst();
  const curLines = cur?.voucher_id ? await gtLinesOf(trx, cur.voucher_id) : [];
  const keepVoucher = cur?.status !== 'unlinked' && sameLines(curLines, p.gtLines);
  if (cur && keepVoucher && cur.input_hash === p.inputHash) {
    const receiptAdjustments = await applyFinishedCost(trx, ctx, cur.id, p); // thường rỗng; lần chạy trước 11b thì bổ sung lớp giá
    return { ...(await getCostRun(trx, year, month)), stale: false, unchanged: true, reversedVoucherIds: [] as string[], receiptAdjustments };
  }

  assertWritable(p.period, ctx);
  let voucherId = cur?.voucher_id ?? null; const reversedVoucherIds: string[] = [];
  if (!keepVoucher) {
    if (voucherId) { await S.reverseVoucher(trx, voucherId, { postingDate: p.date, description: `Đảo chứng từ giá thành kỳ ${mmyyyy(year, month)} (chạy lại)` }); reversedVoucherIds.push(voucherId); voucherId = null; }
    if (p.gtLines.length) {
      const v = await S.createSystemVoucher(trx, ctx, { voucherType: 'GT', postingDate: p.date, documentDate: p.date, description: `Kết chuyển chi phí sản xuất tính giá thành kỳ ${mmyyyy(year, month)}`,
        currencyCode: 'VND', lines: p.gtLines }, { type: 'cost_run', id: sourceId(ctx.tenantId, year, month) });
      await S.postVoucher(trx, v.id);
      voucherId = v.id;
    }
  }
  const row = { status: voucherId ? 'posted' : 'calculated', regime: p.regime, params: JSON.stringify(params), input_hash: p.inputHash, voucher_id: voucherId, warnings: JSON.stringify(p.warnings), run_by: ctx.userId, run_at: new Date() };
  let runId: number;
  if (cur) {
    await trx.updateTable('cost_run').set(row).where('id', '=', cur.id).execute();
    await trx.deleteFrom('cost_run_object').where('run_id', '=', cur.id).execute();
    runId = cur.id;
  } else runId = (await trx.insertInto('cost_run').values({ tenant_id: ctx.tenantId, year, month, ...row }).returning('id').executeTakeFirstOrThrow()).id;
  for (const o of p.objects) {
    const ro = await trx.insertInto('cost_run_object').values({
      tenant_id: ctx.tenantId, run_id: runId, cost_object_id: o.objectId, method: o.method, wip_method: o.wipMethod,
      completion_material: o.completion?.material ?? null, completion_labor: o.completion?.labor ?? null, completion_overhead: o.completion?.overhead ?? null, completed: o.completed,
      overhead_basis: o.overheadBasis, allocated_overhead: o.allocatedOverhead,
      opening_material: o.opening.material, opening_labor: o.opening.labor, opening_overhead: o.opening.overhead,
      incurred_material: o.incurred.material, incurred_labor: o.incurred.labor, incurred_overhead: o.incurred.overhead,
      closing_material: o.closing.material, closing_labor: o.closing.labor, closing_overhead: o.closing.overhead,
      cost_material: o.cost.material, cost_labor: o.cost.labor, cost_overhead: o.cost.overhead, total_cost: o.total,
      completed_qty: o.completedQty, wip_qty: o.wipQty, unit_cost: o.unitCost,
    }).returning('id').executeTakeFirstOrThrow();
    const itemIds = new Map((o.outputs.some((x) => x.itemCode) ? await trx.selectFrom('item').select(['id', 'code']).where('code', 'in', o.outputs.flatMap((x) => (x.itemCode ? [x.itemCode] : []))).execute() : []).map((i) => [i.code, i.id]));
    if (o.outputs.length) await trx.insertInto('cost_run_output').values(o.outputs.map((x) => ({
      tenant_id: ctx.tenantId, run_id: runId, run_object_id: ro.id, line_no: x.lineNo, item_id: x.itemCode ? itemIds.get(x.itemCode)! : null, qty: x.qty, wip_qty: x.wipQty, coefficient: x.coefficient,
      standard_material: x.standardUnitCost?.material ?? null, standard_labor: x.standardUnitCost?.labor ?? null, standard_overhead: x.standardUnitCost?.overhead ?? null,
      cost_material: x.cost.material, cost_labor: x.cost.labor, cost_overhead: x.cost.overhead, total: x.total, unit_cost: x.unitCost,
    }))).execute();
  }
  const receiptAdjustments = await applyFinishedCost(trx, ctx, runId, p);
  return { ...(await getCostRun(trx, year, month)), stale: false, unchanged: false, reversedVoucherIds, receiptAdjustments };
}

/**
 * Giá thành vào kho (D4, QĐ #773): tổng giá thành của từng vật tư đầu ra (cost_run_output) chia cho các dòng nhập thành phẩm của tháng theo số lượng,
 * dòng cuối nhận phần dư. Mỗi dòng nhận lớp 'adjustment' = phần được chia − giá trị nhập hiện tại (gồm lớp cũ), gắn cost_run_id; dòng từng nhận lớp
 * của lần chạy mà nay vật tư không còn là đầu ra thì trả lại phần đó. Không sửa/xóa lớp cũ. Giá vốn (runCosting) ghi Nợ 155 / Có 154 phần chênh;
 * đánh dấu giá vốn chưa cập nhật từ ngày phiếu nhập như sửa giá nhập thành phẩm GĐ3.
 */
async function applyFinishedCost(trx: Trx, ctx: Ctx, runId: number, p: { from: string; date: string; period: Awaited<ReturnType<typeof periodOf>> }) {
  await sql`SELECT pg_advisory_xact_lock(hashtext('costing'), hashtext(${ctx.tenantId}::text))`.execute(trx); // cùng khóa với runCosting, adjustReceiptPrice
  const totals = new Map((await trx.selectFrom('cost_run_output').select(['item_id', sql<string>`sum(total)::text`.as('total')]).where('run_id', '=', runId)
    .where('item_id', 'is not', null).groupBy('item_id').execute()).map((r) => [Number(r.item_id), D(r.total)]));
  const rows = await finishedReceipts(trx, p.from, p.date, runId);
  const target = new Map<number, Decimal>();
  for (const [item, total] of totals) {
    const rs = rows.filter((r) => Number(r.item_id) === item && r.posting_date >= p.from && r.posting_date <= p.date);
    const q = rs.reduce((s, r) => s.plus(r.qty), D(0)); let left = total;
    rs.forEach((r, i) => { const v = i === rs.length - 1 ? left : total.times(r.qty).div(q).toDecimalPlaces(0, Decimal.ROUND_HALF_UP); left = left.minus(v); target.set(r.id, v); });
  }
  const changes = rows.map((r) => ({ r, after: target.get(r.id) ?? D(r.cur).minus(r.mine) })).filter((x) => !x.after.eq(x.r.cur));
  if (!changes.length) return [];
  assertWritable(p.period, ctx);
  await trx.insertInto('stock_cost_layer').values(changes.map(({ r, after }) => ({ tenant_id: ctx.tenantId, move_id: r.id, item_id: r.item_id, warehouse_id: r.warehouse_id, lot_no: r.lot_no,
    kind: 'adjustment', posting_date: r.posting_date, qty: '0', unit_cost: '0', value: after.minus(r.cur).toFixed(0), remaining_qty: '0', remaining_value: '0', cost_run_id: runId }))).execute();
  await sql`INSERT INTO stock_cost_state(tenant_id, item_id, warehouse_id, stale_from)
    SELECT ${ctx.tenantId}::uuid, i, w, min(d) FROM unnest(${changes.map((c) => c.r.item_id)}::bigint[], ${changes.map((c) => c.r.warehouse_id)}::bigint[], ${changes.map((c) => c.r.posting_date)}::date[]) t(i, w, d) GROUP BY i, w
    ON CONFLICT (tenant_id, item_id, warehouse_id) DO UPDATE SET stale_from = least(stock_cost_state.stale_from, excluded.stale_from)`.execute(trx);
  const out = changes.map(({ r, after }) => ({ voucherNo: r.voucher_no, lineNo: r.line_no, itemCode: r.item_code, qty: D(r.qty).toFixed(), before: D(r.cur).toFixed(0), after: after.toFixed(0) }));
  await sql`INSERT INTO audit_event(tenant_id, user_id, action, entity, entity_id, before, after)
    VALUES (${ctx.tenantId}::uuid, ${ctx.userId}::uuid, 'receipt_price_adjust', 'cost_run', ${String(runId)}, ${JSON.stringify(out.map((x) => ({ voucherNo: x.voucherNo, lineNo: x.lineNo, value: x.before })))}::jsonb,
      ${JSON.stringify(out.map((x) => ({ voucherNo: x.voucherNo, lineNo: x.lineNo, value: x.after })))}::jsonb)`.execute(trx);
  return out;
}

const bd = (r: Record<string, unknown>, p: string): CostBreakdown => ({ material: D(r[`${p}_material`] as string).toFixed(0), labor: D(r[`${p}_labor`] as string).toFixed(0), overhead: D(r[`${p}_overhead`] as string).toFixed(0) });

/** Lần chạy đã lưu của kỳ (chưa tính "Cần chạy lại"); không có → 404. */
export async function getCostRun(trx: Trx, year: number, month: number) {
  const r = await trx.selectFrom('cost_run as r').leftJoin('app_user as u', 'u.id', 'r.run_by')
    .select(['r.id', 'r.year', 'r.month', 'r.status', 'r.regime', 'r.params', 'r.input_hash', 'r.voucher_id', 'r.warnings', 'r.run_at', 'u.username as run_by'])
    .where('r.year', '=', year).where('r.month', '=', month).executeTakeFirst();
  if (!r) throw new AppError('COST_RUN_NOT_FOUND', `Kỳ ${mmyyyy(year, month)} chưa chạy giá thành`, 404);
  const rows = await trx.selectFrom('cost_run_object as x').innerJoin('cost_object as o', 'o.id', 'x.cost_object_id').selectAll('x').select(['o.code', 'o.name', 'o.kind'])
    .where('x.run_id', '=', r.id).orderBy('o.code').execute();
  const outs = await trx.selectFrom('cost_run_output as y').leftJoin('item as i', 'i.id', 'y.item_id').selectAll('y').select(['i.code as item_code', 'i.name as item_name'])
    .where('y.run_id', '=', r.id).orderBy('y.run_object_id').orderBy('y.line_no').execute();
  const objects: RunObjectDto[] = rows.map((x) => ({
    objectId: x.cost_object_id, code: x.code, name: x.name, kind: x.kind, method: x.method as Method, wipMethod: x.wip_method as WipMethod['method'],
    completion: x.completion_labor === null ? null : { material: num(x.completion_material)!, labor: num(x.completion_labor)!, overhead: num(x.completion_overhead)! }, completed: x.completed,
    overheadBasis: num(x.overhead_basis)!, allocatedOverhead: D(x.allocated_overhead).toFixed(0),
    opening: bd(x, 'opening'), incurred: bd(x, 'incurred'), closing: bd(x, 'closing'), cost: bd(x, 'cost'), total: D(x.total_cost).toFixed(0),
    completedQty: num(x.completed_qty)!, wipQty: num(x.wip_qty)!, unitCost: x.unit_cost,
    outputs: outs.filter((y) => y.run_object_id === x.id).map((y) => ({
      lineNo: y.line_no, itemCode: y.item_code, itemName: y.item_name, qty: num(y.qty)!, wipQty: num(y.wip_qty)!, coefficient: num(y.coefficient),
      standardUnitCost: y.standard_material === null ? null : { material: y.standard_material, labor: y.standard_labor!, overhead: y.standard_overhead! },
      cost: bd(y, 'cost'), total: D(y.total).toFixed(0), unitCost: y.unit_cost,
    })),
  }));
  return { id: r.id, year: r.year, month: r.month, status: r.status, regime: r.regime, params: r.params as CostRunParams, inputHash: r.input_hash, voucherId: r.voucher_id,
    voucherNo: await voucherNoOf(trx, r.voucher_id), warnings: r.warnings as string[], runAt: r.run_at, runBy: r.run_by, objects };
}

/** "Cần chạy lại": GT đã bị gỡ, hoặc chữ ký đầu vào hiện tại (chi phí, dở dang đầu từ kỳ trước, sản lượng nhập kho) khác lúc chạy, hoặc không tính lại được nữa. */
export async function isStale(trx: Trx, run: { year: number; month: number; status: string; params: CostRunParams; inputHash: string }) {
  if (run.status === 'unlinked') return true;
  try {
    const p = await prepareCostRun(trx, run.year, run.month, costRunParams.parse(run.params));
    return p.inputHash !== run.inputHash || p.blockers.unclassified.length + p.blockers.unassigned.length > 0;
  } catch (e) { if (e instanceof AppError) return true; throw e; }
}

export async function listCostRuns(trx: Trx, year: number) {
  const runs = await trx.selectFrom('cost_run').select('month').where('year', '=', year).orderBy('month').execute();
  const out = [];
  for (const { month } of runs) {
    const r = await getCostRun(trx, year, month);
    const sumOf = (k: 'opening' | 'incurred' | 'closing' | 'cost') => r.objects.reduce((s, o) => s.plus(o[k].material).plus(o[k].labor).plus(o[k].overhead), D(0)).toFixed(0);
    out.push({ year, month, status: r.status, stale: await isStale(trx, r), voucherId: r.voucherId, voucherNo: r.voucherNo, runAt: r.runAt, runBy: r.runBy, objectCount: r.objects.length,
      opening: sumOf('opening'), incurred: sumOf('incurred'), closing: sumOf('closing'), cost: sumOf('cost') });
  }
  return out;
}
