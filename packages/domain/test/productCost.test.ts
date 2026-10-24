import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  allocateOverhead, assertCostBalance, costCoefficient, costOrder, costProject, costRatio, costSimple, sum, wipDirectMaterial, wipEquivalentUnits,
  type CostBreakdown, type ProductCostError, type ProductCostResult,
} from '../src/index.js';

// Ví dụ tính tay kiểu giáo trình: mọi số kỳ vọng nhập tay theo chú thích, không sinh từ mã.
const B = (material: string, labor: string, overhead: string): CostBreakdown => ({ material, labor, overhead });
const errCode = (f: () => unknown) => { try { f(); } catch (e) { return (e as ProductCostError).code; } return 'NO_ERROR'; };

describe('(a) giản đơn, dở dang theo NVL trực tiếp', () => {
  // Dở dang đầu (chỉ NVL) 10.000.000; phát sinh NVL 90.000.000, NC 20.000.000, SXC 15.000.000; hoàn thành 800, dở dang 200.
  // Dck NVL = (10.000.000 + 90.000.000) / (800 + 200) × 200 = 20.000.000; NC, SXC không tính cho dở dang.
  // Z = 10.000.000 + 125.000.000 − 20.000.000 = 115.000.000 (NVL 80.000.000, NC 20.000.000, SXC 15.000.000); z = 115.000.000 / 800 = 143.750.
  const opening = B('10000000', '0', '0'); const incurred = B('90000000', '20000000', '15000000');
  it('wipDirectMaterial', () => expect(wipDirectMaterial({ opening, incurred, completedQty: '800', wipQty: '200' })).toEqual(B('20000000', '0', '0')));
  it('costSimple', () => {
    const r = costSimple({ key: 'SP1', opening, incurred, completedQty: '800', wipQty: '200', wip: { method: 'direct_material' } });
    expect(r.closing).toEqual(B('20000000', '0', '0'));
    expect(r.cost).toEqual(B('80000000', '20000000', '15000000'));
    expect(r.total).toBe('115000000');
    expect(r.products).toEqual([{ key: 'SP1', qty: '800', cost: B('80000000', '20000000', '15000000'), total: '115000000',
      unitCost: B('100000.0000', '25000.0000', '18750.0000'), unitTotal: '143750.0000' }]);
  });
});

describe('(b) dở dang theo sản lượng hoàn thành tương đương, 50% chế biến', () => {
  // Dđk NVL 6.000.000, NC 1.250.000, SXC 900.000; phát sinh NVL 54.000.000, NC 18.000.000, SXC 9.000.000. Hoàn thành 500, dở dang 100 mức 50%
  // (NVL bỏ từ đầu: 100%). Quy đổi: NVL 100 × 100% = 100; NC, SXC 100 × 50% = 50.
  // Dck NVL = 60.000.000 / (500 + 100) × 100 = 10.000.000; NC = 19.250.000 / (500 + 50) × 50 = 1.750.000; SXC = 9.900.000 / 550 × 50 = 900.000.
  // Z: NVL 50.000.000, NC 17.500.000, SXC 9.000.000 = 76.500.000; z = 100.000 + 35.000 + 18.000 = 153.000.
  const opening = B('6000000', '1250000', '900000'); const incurred = B('54000000', '18000000', '9000000');
  const completion = { labor: '50', overhead: '50' };
  it('wipEquivalentUnits', () => expect(wipEquivalentUnits({ opening, incurred, completedQty: '500', wipQty: '100', completion })).toEqual(B('10000000', '1750000', '900000')));
  it('costSimple', () => {
    const r = costSimple({ opening, incurred, completedQty: '500', wipQty: '100', wip: { method: 'equivalent_units', completion } });
    expect(r.cost).toEqual(B('50000000', '17500000', '9000000'));
    expect(r.total).toBe('76500000');
    expect(r.products[0]!.unitTotal).toBe('153000.0000');
  });
  it('làm tròn: Dck đồng nửa lên, giá thành đơn vị 4 chữ số thập phân', () => {
    // NC 19.000.000 / 550 × 50 = 1.727.272,72… → 1.727.273; Z NC = 17.272.727; z NC = 17.272.727 / 500 = 34.545,454.
    const r = costSimple({ opening: B('0', '1000000', '0'), incurred: B('0', '18000000', '0'), completedQty: '500', wipQty: '100', wip: { method: 'equivalent_units', completion } });
    expect(r.closing.labor).toBe('1727273');
    expect(r.cost.labor).toBe('17272727');
    expect(r.products[0]!.unitCost.labor).toBe('34545.4540');
  });
  it('mức hoàn thành NVL khác 100% khi khai báo', () => {
    // NVL 60% → quy đổi 60; Dck NVL = 60.000.000 / 560 × 60 = 6.428.571,43 → 6.428.571.
    expect(wipEquivalentUnits({ opening, incurred, completedQty: '500', wipQty: '100', completion: { material: '60', ...completion } }).material).toBe('6428571');
  });
});

describe('(c) hệ số: ba sản phẩm hệ số 1,0 / 1,2 / 1,5, sản lượng 100 / 200 / 50', () => {
  // Quy đổi sản phẩm chuẩn: 100 × 1,0 + 200 × 1,2 + 50 × 1,5 = 100 + 240 + 75 = 415. Dở dang theo NVL: 85 sản phẩm A (hệ số 1,0) → 85 chuẩn.
  // Dđk NVL 2.500.000; phát sinh NVL 30.000.000, NC 8.300.000, SXC 6.225.000.
  // Dck NVL = 32.500.000 / (415 + 85) × 85 = 5.525.000. Z nhóm: NVL 26.975.000, NC 8.300.000, SXC 6.225.000 = 41.500.000.
  // Giá thành sản phẩm chuẩn: NVL 65.000, NC 20.000, SXC 15.000 = 100.000.
  // A: 100 chuẩn → 6.500.000 + 2.000.000 + 1.500.000 = 10.000.000, z 100.000; B: 240 chuẩn → 15.600.000 + 4.800.000 + 3.600.000 = 24.000.000, z 120.000;
  // C: 75 chuẩn → 4.875.000 + 1.500.000 + 1.125.000 = 7.500.000, z 150.000.
  it('khớp tính tay', () => {
    const r = costCoefficient({
      opening: B('2500000', '0', '0'), incurred: B('30000000', '8300000', '6225000'), wip: { method: 'direct_material' },
      outputs: [{ key: 'A', qty: '100', coefficient: '1.0', wipQty: '85' }, { key: 'B', qty: '200', coefficient: '1.2' }, { key: 'C', qty: '50', coefficient: '1.5' }],
    });
    expect(r.closing).toEqual(B('5525000', '0', '0'));
    expect(r.total).toBe('41500000');
    expect(r.standardQty).toBe('415');
    expect(r.standardUnitCost).toEqual(B('65000.0000', '20000.0000', '15000.0000'));
    expect(r.products.map((p) => [p.key, p.cost, p.total, p.unitTotal])).toEqual([
      ['A', B('6500000', '2000000', '1500000'), '10000000', '100000.0000'],
      ['B', B('15600000', '4800000', '3600000'), '24000000', '120000.0000'],
      ['C', B('4875000', '1500000', '1125000'), '7500000', '150000.0000'],
    ]);
  });
  it('phần dư làm tròn theo phần lẻ lớn nhất (hòa: sản phẩm đứng trước)', () => {
    // 100 đồng NC, ba sản phẩm cùng 1 chuẩn: 33,33 mỗi phần → 34 / 33 / 33.
    const r = costCoefficient({ opening: B('0', '0', '0'), incurred: B('0', '100', '0'), wip: { method: 'none' },
      outputs: [{ key: 'X', qty: '1', coefficient: '1' }, { key: 'Y', qty: '1', coefficient: '1' }, { key: 'Z', qty: '1', coefficient: '1' }] });
    expect(r.products.map((p) => p.cost.labor)).toEqual(['34', '33', '33']);
  });
  it('hệ số phải dương', () => expect(errCode(() => costCoefficient({ opening: B('0', '0', '0'), incurred: B('1', '0', '0'), wip: { method: 'none' },
    outputs: [{ key: 'X', qty: '1', coefficient: '0' }] }))).toBe('PRODUCT_COST_INVALID'));
});

describe('(d) tỷ lệ: giá thành định mức × tỷ lệ', () => {
  // Định mức đơn vị X: NVL 50.000, NC 20.000, SXC 10.000; Y: NVL 80.000, NC 30.000, SXC 15.000. Hoàn thành X 100, Y 50, không dở dang.
  // Tổng định mức: NVL 5.000.000 + 4.000.000 = 9.000.000; NC 2.000.000 + 1.500.000 = 3.500.000; SXC 1.000.000 + 750.000 = 1.750.000.
  // Thực tế: NVL 9.900.000 (tỷ lệ 110%), NC 3.150.000 (90%), SXC 1.750.000 (100%).
  // X: NVL 5.000.000 × 1,1 = 5.500.000; NC 2.000.000 × 0,9 = 1.800.000; SXC 1.000.000 → 8.300.000, z 83.000.
  // Y: NVL 4.400.000; NC 1.350.000; SXC 750.000 → 6.500.000, z 130.000.
  it('khớp tính tay', () => {
    const r = costRatio({
      opening: B('0', '0', '0'), incurred: B('9900000', '3150000', '1750000'), wip: { method: 'none' },
      outputs: [{ key: 'X', qty: '100', standardUnitCost: B('50000', '20000', '10000') }, { key: 'Y', qty: '50', standardUnitCost: B('80000', '30000', '15000') }],
    });
    expect(r.ratio).toEqual(B('1.100000', '0.900000', '1.000000'));
    expect(r.products.map((p) => [p.key, p.cost, p.total, p.unitTotal])).toEqual([
      ['X', B('5500000', '1800000', '1000000'), '8300000', '83000.0000'],
      ['Y', B('4400000', '1350000', '750000'), '6500000', '130000.0000'],
    ]);
    expect(r.total).toBe('14800000');
  });
  it('có chi phí thực tế mà định mức khoản mục bằng 0 → PRODUCT_COST_STANDARD_MISSING', () => {
    expect(errCode(() => costRatio({ opening: B('0', '0', '0'), incurred: B('0', '0', '500'), wip: { method: 'none' },
      outputs: [{ key: 'X', qty: '10', standardUnitCost: B('1000', '100', '0') }] }))).toBe('PRODUCT_COST_STANDARD_MISSING');
  });
});

describe('(e) vụ việc/công trình và đơn hàng: dồn toàn bộ', () => {
  // Công trình: Dđk 120.000.000 (NVL 80, NC 30, SXC 10 triệu), phát sinh NVL 200.000.000, NC 90.000.000, SXC 40.000.000.
  // Hoàn thành: Z = 120.000.000 + 330.000.000 = 450.000.000, Dck 0. Chưa hoàn thành: Z 0, Dck 450.000.000.
  const opening = B('80000000', '30000000', '10000000'); const incurred = B('200000000', '90000000', '40000000');
  it('hoàn thành', () => {
    const r = costProject({ key: 'CT01', opening, incurred, completed: true });
    expect(r.total).toBe('450000000'); expect(r.closing).toEqual(B('0', '0', '0'));
    expect(r.cost).toEqual(B('280000000', '120000000', '50000000'));
  });
  it('chưa hoàn thành', () => {
    const r = costProject({ opening, incurred, completed: false });
    expect(r.total).toBe('0'); expect(r.closing).toEqual(B('280000000', '120000000', '50000000'));
  });
  it('đơn hàng 30 sản phẩm hoàn thành: z = 450.000.000 / 30 = 15.000.000', () => {
    const r = costOrder({ key: 'DH01', opening, incurred, completed: true, qty: '30' });
    expect(r.products[0]!.unitTotal).toBe('15000000.0000');
    expect(errCode(() => costOrder({ opening, incurred, completed: true, qty: '0' }))).toBe('PRODUCT_COST_INVALID');
  });
});

describe('(f) phân bổ chi phí sản xuất chung 627 theo nhân công trực tiếp', () => {
  // 627 = 12.000.000; NC trực tiếp A 30.000.000, B 50.000.000, C 20.000.000 (tổng 100.000.000).
  // A = 12.000.000 × 30% = 3.600.000; B = 6.000.000; C = 2.400.000.
  it('khớp tính tay', () => expect(allocateOverhead('12000000', [{ key: 'A', basis: '30000000' }, { key: 'B', basis: '50000000' }, { key: 'C', basis: '20000000' }]))
    .toEqual([{ key: 'A', amount: '3600000' }, { key: 'B', amount: '6000000' }, { key: 'C', amount: '2400000' }]));
  it('phần dư: 10.000.000 chia ba phần bằng nhau → 3.333.334 / 3.333.333 / 3.333.333', () => expect(allocateOverhead('10000000', ['1', '1', '1'].map((b, i) => ({ key: String(i), basis: b }))).map((x) => x.amount))
    .toEqual(['3333334', '3333333', '3333333']));
  it('tiêu thức tổng 0: chi phí 0 → toàn 0; có chi phí → OVERHEAD_BASIS_ZERO; tiêu thức âm → PRODUCT_COST_INVALID', () => {
    expect(allocateOverhead('0', [{ key: 'A', basis: '0' }])).toEqual([{ key: 'A', amount: '0' }]);
    expect(errCode(() => allocateOverhead('5', [{ key: 'A', basis: '0' }]))).toBe('OVERHEAD_BASIS_ZERO');
    expect(errCode(() => allocateOverhead('5', [{ key: 'A', basis: '-1' }, { key: 'B', basis: '2' }]))).toBe('PRODUCT_COST_INVALID');
    expect(errCode(() => allocateOverhead('5.5', [{ key: 'A', basis: '1' }]))).toBe('PRODUCT_COST_INVALID');
  });
});

describe('biên', () => {
  const opening = B('1000', '200', '300'); const incurred = B('9000', '800', '700');
  it('sản lượng hoàn thành 0: toàn bộ chi phí nằm lại dở dang, giá thành 0', () => {
    for (const wip of [{ method: 'direct_material' as const }, { method: 'equivalent_units' as const, completion: { labor: '50', overhead: '50' } }, { method: 'none' as const }]) {
      const r = costSimple({ opening, incurred, completedQty: '0', wipQty: '10', wip });
      expect(r.closing).toEqual(B('10000', '1000', '1000')); expect(r.total).toBe('0'); expect(r.products[0]!.unitTotal).toBe('0.0000');
    }
  });
  it('dở dang 100% hoàn thành: chia theo số lượng thực', () => {
    // 10.000 / (40 + 10) × 10 = 2.000; NC 1.000 / 50 × 10 = 200; SXC 200.
    expect(wipEquivalentUnits({ opening, incurred, completedQty: '40', wipQty: '10', completion: { labor: '100', overhead: '100' } })).toEqual(B('2000', '200', '200'));
  });
  it('không dở dang: giá thành = đầu + phát sinh', () => expect(costSimple({ opening, incurred, completedQty: '5', wipQty: '0', wip: { method: 'direct_material' } }).total).toBe('12000'));
  it('đầu vào sai: tiền lẻ, số lượng âm, mức hoàn thành ngoài 0–100', () => {
    expect(errCode(() => costSimple({ opening: B('1.5', '0', '0'), incurred, completedQty: '1', wip: { method: 'none' } }))).toBe('PRODUCT_COST_INVALID');
    expect(errCode(() => costSimple({ opening, incurred, completedQty: '-1', wip: { method: 'none' } }))).toBe('PRODUCT_COST_INVALID');
    expect(errCode(() => wipEquivalentUnits({ opening, incurred, completedQty: '1', wipQty: '1', completion: { labor: '101', overhead: '0' } }))).toBe('PRODUCT_COST_INVALID');
  });
  it('assertCostBalance ném PRODUCT_COST_UNBALANCED khi lệch', () => {
    const r = costSimple({ opening, incurred, completedQty: '5', wip: { method: 'none' } });
    expect(errCode(() => assertCostBalance({ ...r, closing: B('1', '0', '0') }))).toBe('PRODUCT_COST_UNBALANCED');
    expect(errCode(() => assertCostBalance({ ...r, products: [] }))).toBe('PRODUCT_COST_UNBALANCED');
  });
});

describe('bất biến (fast-check)', () => {
  const money = fc.bigInt({ min: 0n, max: 10n ** 13n }).map(String);
  const signedMoney = fc.bigInt({ min: -(10n ** 12n), max: 10n ** 13n }).map(String);
  const qty = fc.oneof(fc.constant('0'), fc.integer({ min: 0, max: 100000 }).map(String), fc.integer({ min: 1, max: 10 ** 6 }).map((n) => (n / 100).toFixed(2)));
  const pct = fc.oneof(fc.constantFrom('0', '50', '100'), fc.integer({ min: 0, max: 10000 }).map((n) => (n / 100).toFixed(2)));
  const bd = (m: fc.Arbitrary<string>) => fc.record({ material: m, labor: m, overhead: m });
  const wipArb = fc.oneof(fc.constant({ method: 'none' as const }), fc.constant({ method: 'direct_material' as const }),
    fc.record({ material: pct, labor: pct, overhead: pct }).map((completion) => ({ method: 'equivalent_units' as const, completion })));
  const ELEMENTS = ['material', 'labor', 'overhead'] as const;
  const balanced = (r: ProductCostResult) => {
    for (const e of ELEMENTS) {
      expect(sum([r.opening[e], r.incurred[e]]).eq(sum([r.cost[e], r.closing[e]]))).toBe(true);
      expect(sum(r.products.map((p) => p.cost[e])).eq(r.cost[e])).toBe(true);
    }
    expect(sum(r.products.map((p) => p.total)).eq(r.total)).toBe(true);
  };
  const nonNegative = (r: ProductCostResult) => {
    for (const e of ELEMENTS) { expect(sum([r.closing[e]]).gte(0)).toBe(true); expect(sum([r.cost[e]]).gte(0)).toBe(true); for (const p of r.products) expect(sum([p.cost[e]]).gte(0)).toBe(true); }
  };

  it('giản đơn: cân bằng đầu + phát sinh = giá thành + cuối (kể cả phát sinh âm); không âm khi đầu vào không âm', () => {
    fc.assert(fc.property(bd(money), bd(signedMoney), qty, qty, wipArb, fc.boolean(), (opening, inc, completedQty, wipQty, wip, neg) => {
      const r = costSimple({ opening, incurred: neg ? inc : { material: inc.material.replace('-', ''), labor: inc.labor.replace('-', ''), overhead: inc.overhead.replace('-', '') }, completedQty, wipQty, wip });
      balanced(r);
      if (!neg) nonNegative(r);
    }), { numRuns: 300 });
  });

  it('hệ số và tỷ lệ: cân bằng, Σ sản phẩm = tổng, không âm', () => {
    const outArb = fc.array(fc.record({ qty, wipQty: qty, coefficient: fc.integer({ min: 1, max: 5000 }).map((n) => (n / 1000).toString()),
      std: bd(fc.integer({ min: 1, max: 10 ** 7 }).map(String)) }), { minLength: 1, maxLength: 6 });
    fc.assert(fc.property(bd(money), bd(money), outArb, wipArb, (opening, incurred, outs, wip) => {
      const c = costCoefficient({ opening, incurred, wip, outputs: outs.map((o, i) => ({ key: `P${i}`, qty: o.qty, wipQty: o.wipQty, coefficient: o.coefficient })) });
      balanced(c); nonNegative(c);
      const r = costRatio({ opening, incurred, wip, outputs: outs.map((o, i) => ({ key: `P${i}`, qty: o.qty, wipQty: o.wipQty, standardUnitCost: o.std })) });
      balanced(r); nonNegative(r);
    }), { numRuns: 300 });
  });

  it('vụ việc/đơn hàng: cân bằng', () => {
    fc.assert(fc.property(bd(money), bd(signedMoney), fc.boolean(), (opening, incurred, completed) => {
      balanced(costProject({ opening, incurred, completed }));
      balanced(costOrder({ opening, incurred, completed, qty: '7' }));
    }));
  });

  it('phân bổ 627: Σ = tổng chi phí chung, không âm, lệch tỷ lệ chính xác dưới 1 đồng', () => {
    fc.assert(fc.property(money, fc.array(fc.bigInt({ min: 0n, max: 10n ** 12n }), { minLength: 1, maxLength: 10 }), (total, bases) => {
      const lines = bases.map((b, i) => ({ key: String(i), basis: b.toString() }));
      const wt = sum(lines.map((l) => l.basis));
      if (wt.isZero()) { if (total !== '0') expect(errCode(() => allocateOverhead(total, lines))).toBe('OVERHEAD_BASIS_ZERO'); return; }
      const r = allocateOverhead(total, lines);
      expect(sum(r.map((x) => x.amount)).eq(sum([total]))).toBe(true);
      r.forEach((x, i) => {
        expect(sum([x.amount]).gte(0)).toBe(true);
        expect(sum([x.amount]).minus(sum([total]).times(lines[i]!.basis).div(wt)).abs().lt(1)).toBe(true);
      });
    }));
  });
});
