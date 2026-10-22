import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeCosting, D, sum, type CostMethod, type CostMove, type CostOpening } from '../src/index.js';

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
});
const scenarioArb = fc.record({
  method: fc.constantFrom<CostMethod>('avg_period', 'avg_moving', 'fifo', 'specific'),
  lots: fc.array(fc.record({ lot: fc.constantFrom('A', 'B', 'C'), qty: qtyArb, value: fc.bigInt({ min: 0n, max: 10n ** 10n }).map(String) }), { maxLength: 3 }),
  moves: fc.array(moveArb, { maxLength: 25 }),
  seqs: fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), { minLength: 25, maxLength: 25 }),
  close: fc.boolean(), // thêm phát sinh cuối đưa tồn về đúng 0 (xuất hết hoặc nhập bù tồn âm)
  closeLot: fc.constantFrom('A', 'B', 'C'),
  closeValue: fc.bigInt({ min: 0n, max: 10n ** 10n }).map(String),
});
interface Scenario { method: CostMethod; lots: { lot: string; qty: string; value: string }[]; moves: { dir: string; qty: string; value: string; lot: string; fixed: string | null }[]; seqs: number[]; close: boolean; closeLot: string; closeValue: string }
function build(s: Scenario) {
  const opening: CostOpening = { qty: sum(s.lots.map((l) => l.qty)).toString(), value: sum(s.lots.map((l) => l.value)).toFixed(0), ...(s.lots.length ? { lots: s.lots } : {}) };
  const ms: CostMove[] = s.moves.map((m, i) => m.dir === 'in'
    ? mIn(`m${i}`, s.seqs[i]!, '2026-01-15', m.qty, m.value, m.lot)
    : mOut(`m${i}`, s.seqs[i]!, '2026-01-15', m.qty, m.lot, m.fixed ?? undefined));
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
      expect(sum(r.assignments.map((a) => a.amount)).plus(r.endValue).toFixed(0)).toBe(D(opening.value).plus(sum(ins.map((m) => m.value!))).toFixed(0));
      expect(D(r.endQty).eq(D(opening.qty).plus(sum(ins.map((m) => m.qty))).minus(sum(outs.map((m) => m.qty))))).toBe(true);
      expect(sum(r.layers.map((l) => l.remainingValue)).toFixed(0)).toBe(D(r.endValue).toFixed(0));
      expect(D(sum(r.layers.map((l) => l.remainingQty))).eq(r.endQty)).toBe(true);
      if (D(r.endQty).isZero() && outs.some((m) => !m.fixedUnitCost)) expect(r.endValue).toBe('0');
      // không tồn âm, không giá cố định: mọi lớp còn lại không âm và đúng dấu
      if (!r.errors.length && !outs.some((m) => m.fixedUnitCost)) for (const l of r.layers) expect(D(l.remainingQty).gte(0) && (s.method === 'avg_period' || D(l.remainingValue).gte(0))).toBe(true);
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
