import { D, Decimal, ZERO } from './money.js';

// Động cơ giá vốn thuần cho một cặp (hàng, kho) trong một kỳ: số lượng theo ĐVT cơ sở, tiền đồng nguyên, decimal.js.
export type CostMethod = 'avg_period' | 'avg_moving' | 'fifo' | 'specific';
export interface CostMove { id: string; seq: number; date: string; direction: 'in' | 'out'; qty: string; lot?: string;
  /** chiều in: giá trị đã biết (mua, nhập thành phẩm...) hoặc null khi lấy theo giá gán của chiều out (chuyển kho) */ value: string | null;
  /** chiều out đã gán giá cố định (cố định giá vốn) */ fixedUnitCost?: string;
  /** chiều out giữ đúng số tiền này (đồng nguyên): phát sinh kỳ trước đã ghi sổ, xuất đảo phiếu nhập */ fixedAmount?: string;
  /** chiều in (đảo phiếu xuất cùng cặp, cùng kỳ): giá trị = giá gán của chiều out này, đứng trước theo seq; bình quân cuối kỳ loại cả hai khỏi giá bình quân */ valueFrom?: string }
export interface CostOpening { qty: string; value: string; lots?: { lot: string; qty: string; value: string }[] }
export interface CostResult { assignments: { moveId: string; unitCost: string; amount: string; lot?: string }[];
  layers: { moveId: string; remainingQty: string; remainingValue: string }[];   // lớp nhập còn lại sau tính
  endQty: string; endValue: string; errors: { moveId: string; code: 'COSTING_NEGATIVE_STOCK' | 'COSTING_LOT_MISSING'; detail: string }[] }

type CostError = CostResult['errors'][number];
interface Layer { moveId: string; key: string; qty: Decimal; value: Decimal }
interface Out { move: CostMove; qty: Decimal; amount: Decimal; avg?: Decimal }

export const isFixed = (m: CostMove) => m.fixedUnitCost !== undefined || m.fixedAmount !== undefined;
const round = (d: Decimal): Decimal => d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
const vndStr = (d: Decimal): string => (d.isZero() ? '0' : d.toFixed(0));
const qtyStr = (d: Decimal): string => (d.isZero() ? '0' : d.toString());
const ucStr = (d: Decimal): string => { const r = d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP); return (r.isZero() ? ZERO : r).toFixed(4); };
const vndOf = (v: string, what: string): Decimal => { const d = D(v); if (!d.isInteger()) throw new Error(`${what}: giá trị phải là đồng nguyên (${v})`); return d; };
// Phần giá trị của `take` lấy từ (qty, value); lấy hết thì lấy đúng hết giá trị để không còn đồng lẻ.
const portionOf = (value: Decimal, qty: Decimal, take: Decimal): Decimal => (take.eq(qty) ? value : round(take.times(value).div(qty)));
const negDetail = (m: CostMove, avail: Decimal) => `Xuất ${m.qty}${m.lot ? ` lô ${m.lot}` : ''} vượt tồn ${qtyStr(avail)} (ngày ${m.date})`;

export function computeCosting(method: CostMethod, opening: CostOpening, moves: CostMove[], periodEnd: string): CostResult {
  const sorted = [...moves].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const m of sorted) {
    if (m.date > periodEnd) throw new Error(`Phát sinh ${m.id} ngày ${m.date} sau ngày cuối kỳ ${periodEnd}`);
    if (!D(m.qty).gt(0)) throw new Error(`Phát sinh ${m.id}: số lượng phải dương`);
    if (m.direction === 'in') {
      if (m.valueFrom !== undefined) continue;
      if (m.value === null) throw new Error(`Phát sinh nhập ${m.id} chưa có giá trị: điền giá gán của chiều xuất tương ứng trước khi tính`);
      vndOf(m.value, `Phát sinh nhập ${m.id}`);
    }
    if (m.fixedUnitCost !== undefined) D(m.fixedUnitCost);
    if (m.fixedAmount !== undefined) vndOf(m.fixedAmount, `Phát sinh xuất ${m.id}`);
  }
  const openQ = D(opening.qty); const openV = vndOf(opening.value, 'Tồn đầu');
  // Lớp tồn đầu: theo lô (FIFO/đích danh: lớp trước mọi phát sinh kỳ) hoặc một lớp gộp.
  const openLayers: Layer[] = [];
  if (opening.lots?.length) {
    let q = ZERO; let v = ZERO;
    for (const l of opening.lots) {
      const lq = D(l.qty); const lv = vndOf(l.value, `Tồn đầu lô ${l.lot}`);
      if (openLayers.some((o) => o.moveId === `opening:${l.lot}`)) throw new Error(`Tồn đầu: lô ${l.lot} lặp lại`);
      openLayers.push({ moveId: `opening:${l.lot}`, key: method === 'specific' ? l.lot : '', qty: lq, value: lv });
      q = q.plus(lq); v = v.plus(lv);
    }
    if (!q.eq(openQ) || !v.eq(openV)) throw new Error('Tồn đầu theo lô không khớp tổng số lượng, giá trị tồn đầu');
    // Lô tồn âm (lớp thiếu chuyển từ kỳ trước) phải là lớp duy nhất của nhóm: FIFO một nhóm, đích danh mỗi lô một nhóm.
    for (const l of openLayers) if (l.qty.lt(0) && openLayers.some((o) => o !== l && o.key === l.key)) throw new Error(`Tồn đầu lô ${l.moveId.slice(8)}: lớp thiếu không đi cùng lớp khác cùng nhóm`);
  } else if (!openQ.isZero() || !openV.isZero()) openLayers.push({ moveId: 'opening', key: '', qty: openQ, value: openV });

  const errors: CostError[] = [];
  const outs: Out[] = [];
  const fixedAmount = (m: CostMove, q: Decimal) => (m.fixedAmount !== undefined ? D(m.fixedAmount) : round(q.times(D(m.fixedUnitCost!))));
  // Chiều out được chiều in đảo lấy giá: giữ giá, không nhận phần lẻ cuối kỳ.
  const pinned = new Set(sorted.flatMap((m) => (m.direction === 'in' && m.valueFrom !== undefined ? [m.valueFrom] : [])));
  const inCache = new Map<string, Decimal>();
  const inValue = (m: CostMove): Decimal => {
    if (m.valueFrom === undefined) return D(m.value!);
    const hit = inCache.get(m.id); if (hit) return hit;
    const o = outs.find((x) => x.move.id === m.valueFrom);
    if (!o) throw new Error(`Phát sinh nhập ${m.id}: chiều xuất ${m.valueFrom} không đứng trước trong kỳ`);
    // trả một phần: theo tỷ lệ số lượng; lần trả cuối (cộng dồn đủ số lượng xuất) nhận phần còn lại để tổng các lần trả bằng đúng giá trị xuất
    const sibs = sorted.filter((x) => x.direction === 'in' && x.valueFrom === m.valueFrom); const at = sibs.indexOf(m);
    const before = sibs.slice(0, at); const prevQ = before.reduce((t, x) => t.plus(x.qty), D(0));
    const v = prevQ.plus(m.qty).eq(o.qty) ? o.amount.minus(before.reduce((t, x) => t.plus(inValue(x)), D(0))) : portionOf(o.amount, o.qty, D(m.qty));
    inCache.set(m.id, v); return v;
  };
  let layers: Layer[];

  if (method === 'avg_period' || method === 'avg_moving') {
    let lastIn: Decimal | null = null; // giá nhập gần nhất: giá dự phòng khi tồn không dương
    let deficitId = 'opening';
    let Q = openQ; let V = openV;
    if (method === 'avg_period') {
      for (const m of sorted) if (m.direction === 'in' && m.valueFrom === undefined) { const q = D(m.qty); const v = D(m.value!); Q = Q.plus(q); V = V.plus(v); lastIn = v.div(q); }
      const avg = Q.gt(0) ? V.div(Q) : lastIn ?? (openQ.isZero() ? ZERO : openV.div(openQ));
      let running = openQ;
      for (const m of sorted) {
        const q = D(m.qty);
        if (m.direction === 'in') { running = running.plus(q); continue; }
        if (running.minus(q).lt(0)) { errors.push({ moveId: m.id, code: 'COSTING_NEGATIVE_STOCK', detail: negDetail(m, running) }); deficitId = m.id; }
        running = running.minus(q);
        const amount = isFixed(m) ? fixedAmount(m, q) : round(q.times(avg));
        outs.push({ move: m, qty: q, amount, avg }); Q = Q.minus(q); V = V.minus(amount);
      }
      // xuất và chiều đảo của nó triệt tiêu: chiều đảo trả lại đúng giá đã xuất, không vào giá bình quân
      for (const m of sorted) if (m.direction === 'in' && m.valueFrom !== undefined) { Q = Q.plus(m.qty); V = V.plus(inValue(m)); }
    } else {
      let lastAvg: Decimal | null = openQ.gt(0) ? openV.div(openQ) : null;
      for (const m of sorted) {
        const q = D(m.qty);
        if (m.direction === 'in') {
          const v = inValue(m); Q = Q.plus(q); V = V.plus(v); lastIn = v.div(q);
          lastAvg = Q.gt(0) ? V.div(Q) : lastIn;
          continue;
        }
        const avg = Q.gt(0) ? V.div(Q) : lastAvg ?? ZERO;
        let amount: Decimal;
        if (q.lt(Q)) amount = round(q.times(avg));
        else if (q.eq(Q)) amount = V;
        else {
          errors.push({ moveId: m.id, code: 'COSTING_NEGATIVE_STOCK', detail: negDetail(m, Q) }); deficitId = m.id;
          amount = Q.gt(0) ? V.plus(round(q.minus(Q).times(avg))) : round(q.times(avg));
        }
        if (isFixed(m)) amount = fixedAmount(m, q);
        outs.push({ move: m, qty: q, amount, avg }); Q = Q.minus(q); V = V.minus(amount);
      }
    }
    V = absorbResidual(outs, Q, V, pinned);
    // Lớp còn lại cho bình quân: lượng tồn cuối thuộc các lần nhập gần nhất, giá trị chia theo lượng, lớp cuối nhận phần lẻ.
    const ins: Layer[] = [...openLayers, ...sorted.filter((m) => m.direction === 'in').map((m) => ({ moveId: m.id, key: '', qty: D(m.qty), value: ZERO }))];
    layers = ins.map((l) => ({ ...l, qty: ZERO, value: ZERO }));
    if (Q.gt(0)) {
      let rest = Q;
      for (let i = ins.length - 1; i >= 0 && rest.gt(0); i--) { const r = Decimal.min(Decimal.max(ins[i]!.qty, ZERO), rest); layers[i]!.qty = r; rest = rest.minus(r); }
      let restQ = Q; let restV = V;
      for (const l of layers) if (l.qty.gt(0)) { l.value = portionOf(restV, restQ, l.qty); restQ = restQ.minus(l.qty); restV = restV.minus(l.value); }
    } else if (!Q.isZero() || !V.isZero()) {
      const d = layers.find((l) => l.moveId === deficitId); // lớp tồn đầu 'opening' đã có: ghi vào đó, không lặp mã
      if (d) { d.qty = Q; d.value = V; } else layers.push({ moveId: deficitId, key: '', qty: Q, value: V });
    }
  } else {
    // FIFO: một nhóm lớp theo seq; đích danh: nhóm theo lô. Tồn âm của nhóm là lớp thiếu (số lượng âm) mang mã phát sinh xuất gây âm; lần nhập sau của nhóm bù lớp thiếu trước.
    layers = [];
    const deficits = new Map<string, Layer>(); const deficitList: Layer[] = [];
    const lastIn = new Map<string, Decimal>(); let globalLastIn: Decimal | null = null;
    const addIn = (l: Layer) => {
      if (l.qty.gt(0)) { const u = l.value.div(l.qty); lastIn.set(l.key, u); globalLastIn = u; }
      const d = deficits.get(l.key);
      if (d) {
        const m = Decimal.min(l.qty, d.qty.neg()); const p = portionOf(l.value, l.qty, m);
        l.qty = l.qty.minus(m); l.value = l.value.minus(p); d.qty = d.qty.plus(m); d.value = d.value.plus(p);
        if (d.qty.isZero()) { l.value = l.value.plus(d.value); d.value = ZERO; deficits.delete(l.key); }
      }
      layers.push(l);
    };
    for (const l of openLayers) {
      if (l.qty.lt(0)) { deficits.set(l.key, l); deficitList.push(l); } else addIn(l);
    }
    for (const m of sorted) {
      const q = D(m.qty);
      let key: string | undefined = method === 'fifo' ? '' : m.lot;
      if (method === 'specific' && m.lot === undefined) {
        errors.push({ moveId: m.id, code: 'COSTING_LOT_MISSING', detail: `${m.direction === 'in' ? 'Nhập' : 'Xuất'} ${m.qty} ngày ${m.date} chưa chọn lô (giá đích danh)` });
        if (m.direction === 'in') key = '';
      }
      if (m.direction === 'in') { addIn({ moveId: m.id, key: key!, qty: q, value: inValue(m) }); continue; }
      // Xuất thiếu lô: lấy theo thứ tự nhập trên mọi lô để vẫn bảo toàn giá trị.
      const cands = layers.filter((l) => key === undefined || l.key === key);
      const availQ = cands.reduce((s, l) => s.plus(l.qty), ZERO); const availV = cands.reduce((s, l) => s.plus(l.value), ZERO);
      const ref = availQ.gt(0) ? availV.div(availQ) : (lastIn.get(key ?? '') ?? globalLastIn ?? (openQ.gt(0) ? openV.div(openQ) : ZERO));
      let need = q; let taken = ZERO; let touched: Layer | undefined;
      for (const l of cands) {
        if (need.isZero()) break;
        if (l.qty.isZero()) { taken = taken.plus(l.value); l.value = ZERO; continue; } // lớp chỉ còn đồng lẻ
        const t = Decimal.min(need, l.qty); const v = portionOf(l.value, l.qty, t);
        l.qty = l.qty.minus(t); l.value = l.value.minus(v); need = need.minus(t); taken = taken.plus(v); touched = l;
      }
      if (cands.every((l) => l.qty.isZero())) for (const l of cands) { taken = taken.plus(l.value); l.value = ZERO; } // nhóm về 0: lấy hết phần lẻ
      let deficit: Layer | undefined;
      if (need.gt(0)) {
        errors.push({ moveId: m.id, code: 'COSTING_NEGATIVE_STOCK', detail: negDetail(m, availQ) });
        const dk = key ?? '';
        deficit = deficits.get(dk);
        if (!deficit) { deficit = { moveId: m.id, key: dk, qty: ZERO, value: ZERO }; deficits.set(dk, deficit); deficitList.push(deficit); }
        const sv = round(need.times(ref));
        deficit.qty = deficit.qty.minus(need); deficit.value = deficit.value.minus(sv); taken = taken.plus(sv);
      }
      let amount = taken;
      if (isFixed(m)) {
        amount = fixedAmount(m, q);
        const target = deficit ?? touched!; // chênh giữa giá lớp và giá cố định ở lại trong kho
        target.value = target.value.plus(taken.minus(amount));
      }
      outs.push({ move: m, qty: q, amount });
    }
    layers.push(...deficitList);
    // Dồn theo từng nhóm (FIFO một nhóm, đích danh từng lô): nhóm về 0 thì lần xuất cuối của nhóm nhận phần lẻ; không chuyển giá trị giữa các lô.
    for (const k of new Set(layers.map((l) => l.key))) {
      const g = layers.filter((l) => l.key === k);
      if (!g.every((l) => l.qty.isZero())) continue;
      const gv = g.reduce((s, l) => s.plus(l.value), ZERO);
      const gOuts = method === 'fifo' ? outs : outs.filter((o) => (o.move.lot ?? '') === k);
      if (!absorbResidual(gOuts, ZERO, gv, pinned).eq(gv)) for (const l of g) l.value = ZERO;
    }
    layers = layers.filter((l) => !deficitList.includes(l) || !l.qty.isZero() || !l.value.isZero());
  }

  const endQ = layers.reduce((s, l) => s.plus(l.qty), ZERO); const endV = layers.reduce((s, l) => s.plus(l.value), ZERO);
  return {
    assignments: outs.map((o) => ({
      moveId: o.move.id,
      unitCost: ucStr(o.move.fixedUnitCost !== undefined && o.move.fixedAmount === undefined ? D(o.move.fixedUnitCost) : isFixed(o.move) ? o.amount.div(o.qty) : o.avg ?? o.amount.div(o.qty)),
      amount: vndStr(o.amount),
      ...(o.move.lot !== undefined ? { lot: o.move.lot } : {}),
    })),
    layers: layers.map((l) => ({ moveId: l.moveId, remainingQty: qtyStr(l.qty), remainingValue: vndStr(l.value) })),
    endQty: qtyStr(endQ), endValue: vndStr(endV), errors,
  };
}

// Tồn cuối 0 mà còn giá trị (làm tròn, tồn âm rồi nhập bù, giá cố định): lần xuất không cố định giá cuối cùng nhận phần còn lại. Trả giá trị tồn cuối sau khi dồn.
function absorbResidual(outs: Out[], endQ: Decimal, endV: Decimal, pinned: Set<string>): Decimal {
  if (!endQ.isZero() || endV.isZero()) return endV;
  const last = [...outs].reverse().find((o) => !isFixed(o.move) && !pinned.has(o.move.id));
  if (!last) return endV;
  last.amount = last.amount.plus(endV);
  return ZERO;
}
