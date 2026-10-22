import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeCosting, D, isFixed, sum, type CostMethod, type CostMove, type CostOpening } from '../src/index.js';

const zero: CostOpening = { qty: '0', value: '0' };
const mIn = (id: string, seq: number, date: string, qty: string, value: string | null, lot?: string): CostMove => ({ id, seq, date, direction: 'in', qty, value, ...(lot ? { lot } : {}) });
const mOut = (id: string, seq: number, date: string, qty: string, lot?: string, fixedUnitCost?: string): CostMove =>
  ({ id, seq, date, direction: 'out', qty, value: null, ...(lot ? { lot } : {}), ...(fixedUnitCost ? { fixedUnitCost } : {}) });

// Hàng X, kho W, tồn đầu 0: 02/01 nhập 100 giá 10; 10/01 xuất 60; 15/01 nhập 50 giá 12; 20/01 xuất 70.
const moves: CostMove[] = [
  mIn('n1', 1, '2026-01-02', '100', '1000'),
  mOut('x1', 2, '2026-01-10', '60'),
  mIn('n2', 3, '2026-01-15', '50', '600'),
  mOut('x2', 4, '2026-01-20', '70'),
];
const amounts = (r: ReturnType<typeof computeCosting>) => r.assignments.map((a) => a.amount);

describe('động cơ giá vốn: tình huống chuẩn', () => {
  it('bình quân cuối kỳ: đơn giá 10,6667; xuất 640 và 747; tồn 20 giá trị 213', () => {
    const r = computeCosting('avg_period', zero, moves, '2026-01-31');
    expect(amounts(r)).toEqual(['640', '747']);
    expect(r.assignments.map((a) => a.unitCost)).toEqual(['10.6667', '10.6667']);
    expect([r.endQty, r.endValue]).toEqual(['20', '213']);
    expect(r.errors).toEqual([]);
    // lớp còn lại: 20 cái thuộc lần nhập gần nhất
    expect(r.layers).toEqual([
      { moveId: 'n1', remainingQty: '0', remainingValue: '0' },
      { moveId: 'n2', remainingQty: '20', remainingValue: '213' },
    ]);
  });
  it('bình quân tức thời: xuất 600 và 778; tồn 20 giá trị 222', () => {
    const r = computeCosting('avg_moving', zero, moves, '2026-01-31');
    expect(amounts(r)).toEqual(['600', '778']);
    expect(r.assignments.map((a) => a.unitCost)).toEqual(['10.0000', '11.1111']);
    expect([r.endQty, r.endValue]).toEqual(['20', '222']);
  });
  it('FIFO: xuất 600 và 760; tồn 20 giá trị 240 (lớp 12)', () => {
    const r = computeCosting('fifo', zero, moves, '2026-01-31');
    expect(amounts(r)).toEqual(['600', '760']);
    expect(r.assignments.map((a) => a.unitCost)).toEqual(['10.0000', '10.8571']);
    expect([r.endQty, r.endValue]).toEqual(['20', '240']);
    expect(r.layers).toEqual([
      { moveId: 'n1', remainingQty: '0', remainingValue: '0' },
      { moveId: 'n2', remainingQty: '20', remainingValue: '240' },
    ]);
  });
  it('đích danh (lô A 100@10, lô B 50@12; xuất 60 lô A, 70 = 30 lô A + 40 lô B): xuất 600 và 780; tồn 220', () => {
    const r = computeCosting('specific', zero, [
      mIn('n1', 1, '2026-01-02', '100', '1000', 'A'),
      mOut('x1', 2, '2026-01-10', '60', 'A'),
      mIn('n2', 3, '2026-01-15', '50', '600', 'B'),
      mOut('x2a', 4, '2026-01-20', '30', 'A'),
      mOut('x2b', 5, '2026-01-20', '40', 'B'),
    ], '2026-01-31');
    expect(amounts(r)).toEqual(['600', '300', '480']);
    expect(r.assignments.map((a) => a.lot)).toEqual(['A', 'A', 'B']);
    expect(D(r.assignments[1]!.amount).plus(r.assignments[2]!.amount).toFixed(0)).toBe('780');
    expect([r.endQty, r.endValue]).toEqual(['20', '220']);
    expect(r.errors).toEqual([]);
  });
  it('đích danh thiếu lô → COSTING_LOT_MISSING', () => {
    const r = computeCosting('specific', zero, [mIn('n1', 1, '2026-01-02', '100', '1000', 'A'), mOut('x1', 2, '2026-01-10', '60')], '2026-01-31');
    expect(r.errors.map((e) => [e.moveId, e.code])).toEqual([['x1', 'COSTING_LOT_MISSING']]);
  });
  it('xuất vượt tồn → COSTING_NEGATIVE_STOCK, gán theo giá bình quân gần nhất', () => {
    const neg = [mIn('n1', 1, '2026-01-02', '10', '100'), mOut('x1', 2, '2026-01-10', '15')];
    for (const m of ['avg_period', 'avg_moving', 'fifo'] as CostMethod[]) {
      const r = computeCosting(m, zero, neg, '2026-01-31');
      expect(r.errors.map((e) => [e.moveId, e.code]), m).toEqual([['x1', 'COSTING_NEGATIVE_STOCK']]);
      expect(amounts(r), m).toEqual(['150']);
      expect([r.endQty, r.endValue], m).toEqual(['-5', '-50']);
    }
    const s = computeCosting('specific', zero, [mIn('n1', 1, '2026-01-02', '10', '100', 'A'), mOut('x1', 2, '2026-01-10', '1', 'B')], '2026-01-31');
    expect(s.errors.map((e) => e.code)).toEqual(['COSTING_NEGATIVE_STOCK']);
  });
  it('tồn âm rồi nhập bù về 0: giá trị tồn cuối bằng 0 (lần xuất cuối nhận phần lệch)', () => {
    const ms = [mIn('n1', 1, '2026-01-02', '10', '100'), mOut('x1', 2, '2026-01-10', '15'), mIn('n2', 3, '2026-01-15', '5', '60')];
    for (const m of ['avg_period', 'avg_moving', 'fifo'] as CostMethod[]) {
      const r = computeCosting(m, zero, ms, '2026-01-31');
      expect([r.endQty, r.endValue], m).toEqual(['0', '0']);
      expect(sum(amounts(r)).toFixed(0), m).toBe('160');
    }
  });
  it('xuất cố định giá dùng đúng giá đó', () => {
    for (const m of ['avg_period', 'avg_moving', 'fifo'] as CostMethod[]) {
      const r = computeCosting(m, zero, [moves[0]!, mOut('x1', 2, '2026-01-10', '60', undefined, '9.5'), moves[2]!, moves[3]!], '2026-01-31');
      expect(r.assignments[0], m).toMatchObject({ unitCost: '9.5000', amount: '570' });
      expect(D(sum(amounts(r))).plus(r.endValue).toFixed(0), m).toBe('1600');
    }
  });
  it('xuất giữ đúng số tiền (fixedAmount): không làm tròn qua đơn giá, không nhận phần lẻ', () => {
    for (const m of ['avg_period', 'avg_moving', 'fifo'] as CostMethod[]) {
      const x1: CostMove = { id: 'x1', seq: 2, date: '2026-01-10', direction: 'out', qty: '60', value: null, fixedAmount: '601' };
      const r = computeCosting(m, zero, [moves[0]!, x1, moves[2]!, moves[3]!], '2026-01-31');
      expect(r.assignments[0], m).toMatchObject({ unitCost: '10.0167', amount: '601' });
      expect(D(sum(amounts(r))).plus(r.endValue).toFixed(0), m).toBe('1600');
    }
    const all = computeCosting('fifo', zero, [mIn('n1', 1, '2026-01-02', '3', '100'), { id: 'x1', seq: 2, date: '2026-01-10', direction: 'out', qty: '3', value: null, fixedAmount: '90' }], '2026-01-31');
    expect([all.assignments[0]!.amount, all.endQty, all.endValue]).toEqual(['90', '0', '10']); // mọi xuất cố định: phần lẻ ở lại kho
  });
  it('tồn đầu theo lô là lớp FIFO trước mọi phát sinh trong kỳ; bình quân gộp tồn đầu', () => {
    const opening: CostOpening = { qty: '30', value: '330', lots: [{ lot: 'L1', qty: '10', value: '100' }, { lot: 'L2', qty: '20', value: '230' }] };
    const ms = [mIn('n1', 1, '2026-01-02', '10', '150'), mOut('x1', 2, '2026-01-10', '15')];
    const f = computeCosting('fifo', opening, ms, '2026-01-31');
    expect(amounts(f)).toEqual(['158']); // 100 + 5 × 11,5 = 157,5
    expect(f.layers).toEqual([
      { moveId: 'opening:L1', remainingQty: '0', remainingValue: '0' },
      { moveId: 'opening:L2', remainingQty: '15', remainingValue: '172' },
      { moveId: 'n1', remainingQty: '10', remainingValue: '150' },
    ]);
    expect(amounts(computeCosting('avg_moving', opening, ms, '2026-01-31'))).toEqual(['180']); // 15 × 480/40
    const sp = computeCosting('specific', opening, [mOut('x1', 1, '2026-01-10', '5', 'L2')], '2026-01-31');
    expect(amounts(sp)).toEqual(['58']); // 5 × 11,5
  });
  it('đích danh tồn âm lô B, còn lô A: không chuyển giá trị lô A sang lô B', () => {
    const r = computeCosting('specific', zero, [
      mIn('n1', 1, '2026-01-02', '5', '60', 'A'), mIn('n2', 2, '2026-01-03', '1', '10', 'C'),
      mOut('x1', 3, '2026-01-10', '1', 'C'), mOut('x2', 4, '2026-01-11', '5', 'B'),
    ], '2026-01-31');
    expect(r.errors.map((e) => [e.moveId, e.code])).toEqual([['x2', 'COSTING_NEGATIVE_STOCK']]);
    expect(amounts(r)).toEqual(['10', '50']); // lô B chưa từng nhập: giá nhập gần nhất 10
    expect(r.layers).toEqual([
      { moveId: 'n1', remainingQty: '5', remainingValue: '60' },
      { moveId: 'n2', remainingQty: '0', remainingValue: '0' },
      { moveId: 'x2', remainingQty: '-5', remainingValue: '-50' },
    ]);
    expect([r.endQty, r.endValue]).toEqual(['0', '10']);
    // lô B nhập bù về 0 với giá khác: phần lệch về lần xuất lô B, lô A giữ nguyên
    const r2 = computeCosting('specific', zero, [
      mIn('n1', 1, '2026-01-02', '5', '60', 'A'), mIn('n2', 2, '2026-01-03', '1', '10', 'C'),
      mOut('x1', 3, '2026-01-10', '1', 'C'), mOut('x2', 4, '2026-01-11', '5', 'B'), mIn('n3', 5, '2026-01-12', '5', '70', 'B'),
    ], '2026-01-31');
    expect(amounts(r2)).toEqual(['10', '70']);
    expect([r2.endQty, r2.endValue]).toEqual(['5', '60']);
  });
  it('bình quân: tồn đầu âm hoặc chỉ còn đồng lẻ không sinh hai lớp "opening"', () => {
    const a = computeCosting('avg_moving', { qty: '-5', value: '-50' }, [mIn('n1', 1, '2026-01-02', '3', '30')], '2026-01-31');
    expect(a.layers).toEqual([{ moveId: 'opening', remainingQty: '-2', remainingValue: '-20' }, { moveId: 'n1', remainingQty: '0', remainingValue: '0' }]);
    const p = computeCosting('avg_period', { qty: '0', value: '5' }, [], '2026-01-31');
    expect(p.layers).toEqual([{ moveId: 'opening', remainingQty: '0', remainingValue: '5' }]);
  });
  it('tồn đầu theo lô có lớp thiếu (số lượng âm) chuyển từ kỳ trước; lô lặp lại bị từ chối', () => {
    const f = computeCosting('fifo', { qty: '-5', value: '-50', lots: [{ lot: 'x9', qty: '-5', value: '-50' }] }, [mIn('n1', 1, '2026-01-02', '8', '96')], '2026-01-31');
    expect(f.layers).toEqual([{ moveId: 'n1', remainingQty: '3', remainingValue: '46' }]); // bù 5 (60), lệch 10 ở lại lớp n1
    expect(f.errors).toEqual([]);
    const sp = computeCosting('specific', { qty: '5', value: '70', lots: [{ lot: 'A', qty: '10', value: '100' }, { lot: 'B', qty: '-5', value: '-30' }] },
      [mIn('n1', 1, '2026-01-02', '5', '60', 'B')], '2026-01-31');
    expect([sp.endQty, sp.endValue]).toEqual(['10', '130']);
    expect(sp.layers).toEqual([
      { moveId: 'opening:A', remainingQty: '10', remainingValue: '100' },
      { moveId: 'n1', remainingQty: '0', remainingValue: '30' },
    ]);
    expect(() => computeCosting('fifo', { qty: '5', value: '50', lots: [{ lot: 'A', qty: '10', value: '100' }, { lot: 'B', qty: '-5', value: '-50' }] }, [], '2026-01-31')).toThrow();
    expect(() => computeCosting('fifo', { qty: '2', value: '20', lots: [{ lot: 'A', qty: '1', value: '10' }, { lot: 'A', qty: '1', value: '10' }] }, [], '2026-01-31')).toThrow();
  });
  it('nhập chưa có giá (chuyển kho chưa điền) hoặc phát sinh sau cuối kỳ: lỗi lập trình', () => {
    expect(() => computeCosting('fifo', zero, [mIn('n1', 1, '2026-01-02', '1', null)], '2026-01-31')).toThrow();
    expect(() => computeCosting('fifo', zero, [mIn('n1', 1, '2026-02-02', '1', '1')], '2026-01-31')).toThrow();
  });
});

// Số lượng 4 chữ số lẻ, tiền đồng nguyên; tồn đầu có thể chia lô.
const qtyArb = fc.bigInt({ min: 1n, max: 10n ** 8n }).map((x) => D(x.toString()).div(10_000).toString());
const moveArb = fc.record({
  dir: fc.constantFrom('in', 'out', 'out'),
  qty: qtyArb,
  value: fc.bigInt({ min: 0n, max: 10n ** 10n }).map(String),
  lot: fc.constantFrom('A', 'B', 'C'),
  fixed: fc.option(fc.bigInt({ min: 0n, max: 10n ** 6n }).map((x) => D(x.toString()).div(100).toString()), { freq: 5 }),
  fixedAmount: fc.option(fc.bigInt({ min: 0n, max: 10n ** 8n }).map(String), { freq: 5 }),
  rev: fc.option(fc.nat(), { freq: 4 }), // chiều in là đảo một chiều out đứng trước (valueFrom)
});
const scenarioArb = fc.record({
  method: fc.constantFrom<CostMethod>('avg_period', 'avg_moving', 'fifo', 'specific'),
  lots: fc.uniqueArray(fc.record({ lot: fc.constantFrom('A', 'B', 'C'), qty: qtyArb, value: fc.bigInt({ min: 0n, max: 10n ** 10n }).map(String) }), { maxLength: 3, selector: (l) => l.lot }),
  negOpen: fc.option(fc.record({ qty: qtyArb, value: fc.bigInt({ min: 0n, max: 10n ** 10n }).map(String) }), { freq: 4 }), // tồn đầu âm (gộp), khi không chia lô
  moves: fc.array(moveArb, { maxLength: 25 }),
  seqs: fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), { minLength: 25, maxLength: 25 }),
  close: fc.boolean(), // thêm phát sinh cuối đưa tồn về đúng 0 (xuất hết hoặc nhập bù tồn âm)
  closeLot: fc.constantFrom('A', 'B', 'C'),
  closeValue: fc.bigInt({ min: 0n, max: 10n ** 10n }).map(String),
});
interface Scenario { method: CostMethod; lots: { lot: string; qty: string; value: string }[]; moves: { dir: string; qty: string; value: string; lot: string; fixed: string | null; fixedAmount: string | null; rev: number | null }[]; seqs: number[]; negOpen: { qty: string; value: string } | null; close: boolean; closeLot: string; closeValue: string }
function build(s: Scenario) {
  const opening: CostOpening = s.negOpen && !s.lots.length ? { qty: D(s.negOpen.qty).neg().toString(), value: D(s.negOpen.value).neg().toFixed(0) }
    : { qty: sum(s.lots.map((l) => l.qty)).toString(), value: sum(s.lots.map((l) => l.value)).toFixed(0), ...(s.lots.length ? { lots: s.lots } : {}) };
  const ms: CostMove[] = s.moves.map((m, i) => m.dir === 'in'
    ? mIn(`m${i}`, s.seqs[i]!, '2026-01-15', m.qty, m.value, m.lot)
    : { ...mOut(`m${i}`, s.seqs[i]!, '2026-01-15', m.qty, m.lot, m.fixed ?? undefined), ...(m.fixedAmount !== null && { fixedAmount: m.fixedAmount }) });
  // đảo phiếu xuất: chiều in lấy đúng lượng, lô của một chiều out đứng trước, giá trị theo giá gán của nó
  const used = new Set<string>();
  s.moves.forEach((m, i) => {
    const cands = ms.filter((o) => o.direction === 'out' && o.seq < s.seqs[i]! && !used.has(o.id));
    if (m.dir !== 'in' || m.rev === null || !cands.length) return;
    const o = cands[m.rev % cands.length]!; used.add(o.id);
    ms[i] = { ...ms[i]!, qty: o.qty, value: null, valueFrom: o.id, ...(o.lot !== undefined && { lot: o.lot }) };
  });
  if (s.close) {
    const signed = (m: CostMove) => (m.direction === 'in' ? D(m.qty) : D(m.qty).neg());
    const end = D(opening.qty).plus(sum(ms.map(signed)));
    if (end.gt(0)) ms.push(mOut('close', 20_000, '2026-01-31', end.toString(), s.closeLot));
    else if (end.lt(0)) ms.push(mIn('close', 20_000, '2026-01-31', end.neg().toString(), s.closeValue, s.closeLot));
  }
  return { opening, ms };
}

describe('động cơ giá vốn: bất biến', () => {
  it('mọi phương pháp: tổng giá vốn xuất + giá trị tồn cuối = giá trị đầu + tổng giá trị nhập (không mất đồng nào)', () => {
    fc.assert(fc.property(scenarioArb, (s) => {
      const { opening, ms } = build(s);
      const r = computeCosting(s.method, opening, ms, '2026-01-31');
      const ins = ms.filter((m) => m.direction === 'in'); const outs = ms.filter((m) => m.direction === 'out');
      expect(r.assignments.length).toBe(outs.length);
      for (const a of r.assignments) expect(a.amount).toMatch(/^-?\d+$/);
      const amountOf = new Map(r.assignments.map((a) => [a.moveId, a.amount]));
      const pinned = new Set(ins.flatMap((m) => (m.valueFrom ? [m.valueFrom] : [])));
      expect(sum(r.assignments.map((a) => a.amount)).plus(r.endValue).toFixed(0)).toBe(D(opening.value).plus(sum(ins.map((m) => (m.valueFrom ? amountOf.get(m.valueFrom)! : m.value!)))).toFixed(0));
      expect(D(r.endQty).eq(D(opening.qty).plus(sum(ins.map((m) => m.qty))).minus(sum(outs.map((m) => m.qty))))).toBe(true);
      expect(sum(r.layers.map((l) => l.remainingValue)).toFixed(0)).toBe(D(r.endValue).toFixed(0));
      expect(D(sum(r.layers.map((l) => l.remainingQty))).eq(r.endQty)).toBe(true);
      const allZero = r.layers.every((l) => D(l.remainingQty).isZero());
      if (s.method !== 'specific' && D(r.endQty).isZero()) expect(allZero).toBe(true);
      // tồn về 0 ở mọi nhóm (đích danh: mọi lô) ⇒ không còn giá trị; đích danh âm lô này dương lô kia thì giữ giá trị từng lô
      if (allZero && outs.some((m) => !isFixed(m) && !pinned.has(m.id))) expect(r.endValue).toBe('0');
      expect(new Set(r.layers.map((l) => l.moveId)).size).toBe(r.layers.length);
      // không tồn âm, không giá cố định: mọi lớp còn lại không âm và đúng dấu
      if (!r.errors.length && D(opening.qty).gte(0) && !outs.some(isFixed) && !pinned.size) for (const l of r.layers) expect(D(l.remainingQty).gte(0) && (s.method === 'avg_period' || D(l.remainingValue).gte(0))).toBe(true);
    }), { numRuns: 400 });
  });
  it('kết quả không phụ thuộc thứ tự mảng đầu vào (chỉ phụ thuộc seq)', () => {
    fc.assert(fc.property(scenarioArb, fc.integer(), (s, seed) => {
      const { opening, ms } = build(s);
      const shuffled = [...ms];
      let x = seed >>> 0;
      for (let i = shuffled.length - 1; i > 0; i--) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; const j = x % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
      expect(computeCosting(s.method, opening, shuffled, '2026-01-31')).toEqual(computeCosting(s.method, opening, ms, '2026-01-31'));
    }), { numRuns: 200 });
  });
});

describe('động cơ giá vốn: đảo phiếu xuất trong kỳ (valueFrom)', () => {
  // nhập 100@10.000, nhập 100@1.000.000, xuất 100, đảo phiếu xuất: xuất và chiều đảo triệt tiêu, không vòng lặp giá
  const ms = (): CostMove[] => [mIn('n1', 1, '2026-01-02', '100', '1000000'), mIn('n2', 2, '2026-01-03', '100', '100000000'),
    mOut('x1', 3, '2026-01-05', '100'), { ...mIn('r1', 4, '2026-01-10', '100', null), valueFrom: 'x1' }];
  it('bình quân cuối kỳ: giá bình quân không gồm cặp xuất – đảo; chiều đảo trả đúng giá xuất', () => {
    const r = computeCosting('avg_period', { qty: '0', value: '0' }, ms(), '2026-01-31');
    expect(r.assignments).toEqual([{ moveId: 'x1', unitCost: '505000.0000', amount: '50500000' }]);
    expect([r.endQty, r.endValue]).toEqual(['200', '101000000']);
  });
  it.each(['avg_moving', 'fifo'] as const)('%s: chiều đảo lấy giá gán của chiều xuất đứng trước', (method) => {
    const r = computeCosting(method, { qty: '0', value: '0' }, ms(), '2026-01-31');
    const x = r.assignments[0]!.amount;
    expect(D(x).plus(r.endValue).toFixed(0)).toBe(D(101000000).plus(x).toFixed(0));
  });
  it('chiều xuất không đứng trước: lỗi lập trình', () => {
    expect(() => computeCosting('fifo', { qty: '0', value: '0' }, [{ ...mIn('r1', 1, '2026-01-02', '1', null), valueFrom: 'x9' }], '2026-01-31')).toThrow(/không đứng trước/);
  });
});
