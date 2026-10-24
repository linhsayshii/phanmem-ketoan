import { allocateByRatio } from './depreciation.js';
import { D, Decimal, ZERO, sum } from './money.js';

// Động cơ giá thành thuần (GĐ6 Task 10a, Quy ước 8). Khoản mục: NVL trực tiếp (621), nhân công trực tiếp (622), sản xuất chung (627);
// TT133 tập hợp thẳng 154 theo cùng ba khoản mục (D2). Tiền là chuỗi đồng nguyên; dở dang cuối làm tròn đồng nửa lên từng khoản mục,
// giá thành = đầu + phát sinh − cuối (không làm tròn lần hai); chia cho nhiều sản phẩm theo phần lẻ lớn nhất (allocateByRatio):
// Σ sản phẩm đúng tổng, không phần nào âm khi tổng không âm. Giá thành đơn vị 4 chữ số thập phân (numeric(20,4) như giá vốn GĐ3).

export type CostElement = 'material' | 'labor' | 'overhead';
export const COST_ELEMENTS: readonly CostElement[] = ['material', 'labor', 'overhead'];
export type CostBreakdown = Record<CostElement, string>;

/** Mức hoàn thành của dở dang theo khoản mục, phần trăm 0–100; NVL mặc định 100 (bỏ vào từ đầu quy trình). */
export interface WipCompletion { material?: string; labor: string; overhead: string }
/** Đánh giá dở dang cuối: không đánh giá, theo NVL trực tiếp, theo sản lượng hoàn thành tương đương (bình quân). */
export type WipMethod = { method: 'none' } | { method: 'direct_material' } | { method: 'equivalent_units'; completion: WipCompletion };

export interface CostPeriod { opening: CostBreakdown; incurred: CostBreakdown }
export interface WipInput extends CostPeriod { completedQty: string; wipQty: string }
export interface ProductCostLine { key: string; qty: string; cost: CostBreakdown; total: string; unitCost: CostBreakdown; unitTotal: string }
export interface ProductCostResult {
  opening: CostBreakdown; incurred: CostBreakdown; closing: CostBreakdown;
  cost: CostBreakdown; total: string; products: ProductCostLine[];
  standardQty?: string; standardUnitCost?: CostBreakdown; // hệ số: sản lượng và giá thành sản phẩm chuẩn
  ratio?: CostBreakdown; // tỷ lệ: giá thành thực tế ÷ giá thành định mức theo khoản mục
}

export type ProductCostErrorCode = 'PRODUCT_COST_INVALID' | 'PRODUCT_COST_UNBALANCED' | 'PRODUCT_COST_STANDARD_MISSING' | 'OVERHEAD_BASIS_ZERO';
export class ProductCostError extends Error {
  constructor(public code: ProductCostErrorCode, message: string) { super(message); this.name = 'ProductCostError'; }
}

const NAMES: Record<CostElement, string> = { material: 'Nguyên vật liệu trực tiếp', labor: 'Nhân công trực tiếp', overhead: 'Sản xuất chung' };
type Dec = Record<CostElement, Decimal>;
const invalid = (msg: string): never => { throw new ProductCostError('PRODUCT_COST_INVALID', msg); };
const num = (v: string, what: string): Decimal => { try { return D(v); } catch { return invalid(`${what}: số không hợp lệ (${v})`); } };
const vndIn = (v: string, what: string): Decimal => { const d = num(v, what); if (!d.isInteger()) invalid(`${what}: phải là đồng nguyên (${v})`); return d; };
const nonNeg = (v: string, what: string): Decimal => { const d = num(v, what); if (d.isNegative()) invalid(`${what} không được âm (${v})`); return d; };
const pct = (v: string, what: string): Decimal => { const d = nonNeg(v, what); if (d.gt(100)) invalid(`${what} không được quá 100% (${v})`); return d.div(100); };
const fixed = (d: Decimal, dp: number): string => { const r = d.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP); return (r.isZero() ? ZERO : r).toFixed(dp); };
const map = <T>(f: (e: CostElement) => T): Record<CostElement, T> => ({ material: f('material'), labor: f('labor'), overhead: f('overhead') });
const str = (x: Dec): CostBreakdown => map((e) => fixed(x[e], 0));
const per = (x: Dec, q: Decimal, dp: number): CostBreakdown => map((e) => (q.isZero() ? fixed(ZERO, dp) : fixed(x[e].div(q), dp)));

interface Output { key: string; qty: Decimal; wipQty: Decimal; weight: Dec }

function shareOf(wip: WipMethod): Dec {
  if (wip.method === 'none') return map(() => ZERO);
  if (wip.method === 'direct_material') return { material: D(1), labor: ZERO, overhead: ZERO };
  const c = wip.completion;
  return map((e) => pct(c[e] ?? '100', `Mức hoàn thành ${NAMES[e]}`));
}

function available(p: CostPeriod): Dec {
  return map((e) => vndIn(p.opening[e], `Dở dang đầu kỳ ${NAMES[e]}`).plus(vndIn(p.incurred[e], `Chi phí phát sinh ${NAMES[e]}`)));
}

// Dở dang cuối từng khoản mục = chi phí × quy đổi dở dang ÷ (quy đổi hoàn thành + quy đổi dở dang), quy đổi = số lượng × trọng số (× mức hoàn thành
// với dở dang). Không có sản phẩm hoàn thành thì toàn bộ chi phí nằm lại dở dang (không có gì để nhận giá thành).
function closingOf(avail: Dec, outputs: Output[], wip: WipMethod): Dec {
  const share = shareOf(wip);
  if (sum(outputs.map((o) => o.qty)).isZero()) return avail;
  return map((e) => {
    const done = outputs.reduce((t, o) => t.plus(o.qty.times(o.weight[e])), ZERO);
    const inWip = outputs.reduce((t, o) => t.plus(o.wipQty.times(share[e]).times(o.weight[e])), ZERO);
    return inWip.isZero() ? ZERO : avail[e].times(inWip).div(done.plus(inWip)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  });
}

function compute(p: CostPeriod, outputs: Output[], wip: WipMethod): ProductCostResult {
  if (outputs.length === 0) invalid('Chưa có sản phẩm hoàn thành nào để tính giá thành');
  const avail = available(p);
  const closing = closingOf(avail, outputs, wip);
  const cost = map((e) => avail[e].minus(closing[e]));
  const parts = map((e) => {
    const weights = outputs.map((o) => o.qty.times(o.weight[e]));
    if (sum(weights).isZero()) {
      if (!cost[e].isZero()) throw new ProductCostError('PRODUCT_COST_STANDARD_MISSING', `Khoản mục ${NAMES[e]} có chi phí ${fixed(cost[e], 0)} nhưng không có tiêu thức để chia cho sản phẩm (định mức bằng 0)`);
      return outputs.map(() => ZERO);
    }
    return allocateByRatio(fixed(cost[e], 0), weights.map((w) => w.toString())).map((x) => D(x));
  });
  const products = outputs.map((o, i): ProductCostLine => {
    const c = map((e) => parts[e][i]!);
    const total = sum(COST_ELEMENTS.map((e) => c[e]));
    return { key: o.key, qty: o.qty.isZero() ? '0' : o.qty.toString(), cost: str(c), total: fixed(total, 0), unitCost: per(c, o.qty, 4), unitTotal: o.qty.isZero() ? fixed(ZERO, 4) : fixed(total.div(o.qty), 4) };
  });
  return { opening: { ...p.opening }, incurred: { ...p.incurred }, closing: str(closing), cost: str(cost), total: fixed(sum(COST_ELEMENTS.map((e) => cost[e])), 0), products };
}

/** Kiểm cân bằng: đầu + phát sinh = giá thành + cuối từng khoản mục; Σ sản phẩm = giá thành; tổng = Σ khoản mục. Lệch → PRODUCT_COST_UNBALANCED. */
export function assertCostBalance(r: ProductCostResult): void {
  const fail = (what: string): never => { throw new ProductCostError('PRODUCT_COST_UNBALANCED', `Giá thành không cân: ${what}`); };
  for (const e of COST_ELEMENTS) {
    if (!sum([r.opening[e], r.incurred[e]]).eq(sum([r.cost[e], r.closing[e]]))) fail(`${NAMES[e]}: đầu kỳ + phát sinh ≠ giá thành + cuối kỳ`);
    if (!sum(r.products.map((x) => x.cost[e])).eq(D(r.cost[e]))) fail(`${NAMES[e]}: tổng các sản phẩm ≠ giá thành`);
  }
  if (!sum(COST_ELEMENTS.map((e) => r.cost[e])).eq(D(r.total))) fail('tổng giá thành ≠ tổng các khoản mục');
  for (const x of r.products) if (!sum(COST_ELEMENTS.map((e) => x.cost[e])).eq(D(x.total))) fail(`sản phẩm ${x.key}: tổng ≠ tổng các khoản mục`);
}

const done = (r: ProductCostResult): ProductCostResult => { assertCostBalance(r); return r; };
const one = (completedQty: string, wipQty = '0', key = ''): Output =>
  ({ key, qty: nonNeg(completedQty, 'Sản lượng hoàn thành'), wipQty: nonNeg(wipQty, 'Số lượng dở dang'), weight: map(() => D(1)) });

/** Dở dang cuối theo chi phí NVL trực tiếp: (đầu + phát sinh NVL) ÷ (hoàn thành + dở dang) × dở dang; NC, SXC tính hết cho thành phẩm. */
export function wipDirectMaterial(i: WipInput): CostBreakdown {
  return str(closingOf(available(i), [one(i.completedQty, i.wipQty)], { method: 'direct_material' }));
}

/** Dở dang cuối theo sản lượng hoàn thành tương đương (bình quân): từng khoản mục quy đổi dở dang × mức hoàn thành. */
export function wipEquivalentUnits(i: WipInput & { completion: WipCompletion }): CostBreakdown {
  return str(closingOf(available(i), [one(i.completedQty, i.wipQty)], { method: 'equivalent_units', completion: i.completion }));
}

/**
 * Phân bổ chi phí chung (627) cho các đối tượng theo tiêu thức (nhân công trực tiếp, NVL trực tiếp, giờ máy, doanh thu, nhập tay: giá trị tiêu thức
 * do bên gọi đọc). Phần lẻ lớn nhất, hòa thì đối tượng đứng trước; Σ = tổng; tiêu thức tổng 0 mà có chi phí → OVERHEAD_BASIS_ZERO.
 */
export function allocateOverhead(total: string, basis: { key: string; basis: string }[]): { key: string; amount: string }[] {
  const t = vndIn(total, 'Chi phí sản xuất chung');
  const ws = basis.map((b) => nonNeg(b.basis, `Tiêu thức phân bổ của ${b.key}`));
  if (sum(ws).isZero()) {
    if (!t.isZero()) throw new ProductCostError('OVERHEAD_BASIS_ZERO', 'Tổng tiêu thức phân bổ bằng 0 nên không phân bổ được chi phí sản xuất chung');
    return basis.map((b) => ({ key: b.key, amount: '0' }));
  }
  const parts = allocateByRatio(fixed(t, 0), ws.map((w) => w.toString()));
  return basis.map((b, k) => ({ key: b.key, amount: parts[k]! }));
}

/** Giản đơn (trực tiếp): một đối tượng, một sản phẩm. */
export function costSimple(i: CostPeriod & { key?: string; completedQty: string; wipQty?: string; wip: WipMethod }): ProductCostResult {
  return done(compute(i, [one(i.completedQty, i.wipQty, i.key)], i.wip));
}

/** Hệ số: quy đổi sản lượng (cả dở dang) ra sản phẩm chuẩn theo hệ số, giá thành sản phẩm = giá thành nhóm theo phần quy đổi. */
export function costCoefficient(i: CostPeriod & { wip: WipMethod; outputs: { key: string; qty: string; wipQty?: string; coefficient: string }[] }): ProductCostResult {
  const outs = i.outputs.map((o): Output => {
    const h = nonNeg(o.coefficient, `Hệ số của ${o.key}`); if (h.isZero()) invalid(`Hệ số của ${o.key} phải lớn hơn 0`);
    return { ...one(o.qty, o.wipQty, o.key), weight: map(() => h) };
  });
  const r = compute(i, outs, i.wip);
  const sq = outs.reduce((t, o) => t.plus(o.qty.times(o.weight.material)), ZERO);
  return done({ ...r, standardQty: sq.isZero() ? '0' : sq.toString(), standardUnitCost: per(map((e) => D(r.cost[e])), sq, 4) });
}

/** Tỷ lệ: giá thành sản phẩm = giá thành định mức (kế hoạch) đơn vị × sản lượng × tỷ lệ thực tế/định mức của từng khoản mục. */
export function costRatio(i: CostPeriod & { wip: WipMethod; outputs: { key: string; qty: string; wipQty?: string; standardUnitCost: CostBreakdown }[] }): ProductCostResult {
  const outs = i.outputs.map((o): Output => ({ ...one(o.qty, o.wipQty, o.key), weight: map((e) => nonNeg(o.standardUnitCost[e], `Giá thành định mức ${NAMES[e]} của ${o.key}`)) }));
  const r = compute(i, outs, i.wip);
  const ratio = map((e) => {
    const plan = outs.reduce((t, o) => t.plus(o.qty.times(o.weight[e])), ZERO);
    return plan.isZero() ? fixed(ZERO, 6) : fixed(D(r.cost[e]).div(plan), 6);
  });
  return done({ ...r, ratio });
}

/** Đơn hàng: dồn toàn bộ chi phí; hoàn thành → giá thành = đầu + phát sinh, giá thành đơn vị theo số lượng; chưa hoàn thành → toàn bộ là dở dang. */
export function costOrder(i: CostPeriod & { key?: string; completed: boolean; qty: string }): ProductCostResult {
  if (i.completed && !nonNeg(i.qty, 'Số lượng đơn hàng').gt(0)) invalid('Đơn hàng đã hoàn thành phải có số lượng lớn hơn 0');
  return done(compute(i, [one(i.completed ? i.qty : '0', '0', i.key)], { method: 'none' }));
}

/** Vụ việc/công trình: như đơn hàng với một đơn vị (giá thành đơn vị = tổng giá thành). */
export function costProject(i: CostPeriod & { key?: string; completed: boolean }): ProductCostResult {
  return costOrder({ ...i, qty: '1' });
}
