import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataPath, isCitTemplateComplete, loadCitLedger, loadCitTemplate, loadLegalParams, loadTaxXmlFormat } from '../src/index.js';

const status = JSON.parse(readFileSync(dataPath('tax', 'status.json'), 'utf8')) as Record<string, boolean | string>;
// Mã chỉ tiêu in trên mẫu 03/TNDN, TT 89/2026 trang 270-272 (đối chiếu ảnh); ghi tay, không suy ra từ dữ liệu.
const CODES = ['04', '05', 'A', 'A1', 'B', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B12a', 'B13', 'B14', 'B15',
  'C', 'C1', 'C2', 'C3', 'C3a', 'C3b', 'C4', 'C5', 'C6', 'C7', 'C7a', 'C8', 'C8a', 'C9', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17',
  'D', 'D1', 'D2', 'D2a', 'D2b', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'E', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'G', 'G1', 'G2', 'G3', 'G4', 'G5', 'H', 'H1', 'H2', 'H3', 'I', 'I1', 'I2'];
const refs = (f: string) => [...f.matchAll(/[A-I]\d*[a-z]?/g)].map((m) => m[0]);

describe('mẫu tờ khai 03/TNDN theo TT 89/2026', () => {
  const t = loadCitTemplate('TT89');
  it('cổng 03TNDN_TT89 bật, đủ chỉ tiêu theo thứ tự in, mỗi mã một lần, có nhãn', () => {
    expect(status['03TNDN_TT89']).toBe(true); expect(isCitTemplateComplete('TT89')).toBe(true);
    expect(t.lines.map((l) => l.code)).toEqual(CODES);
    for (const l of t.lines) expect(l.label, l.code).not.toBe('');
  });
  it('công thức in trên mẫu đúng nguyên văn; công thức gợi ý của phần mềm đánh dấu printed=false và cho sửa', () => {
    const printed = Object.fromEntries(t.lines.filter((l) => l.formula && l.printed !== false).map((l) => [l.code, l.formula]));
    expect(printed).toEqual({
      B1: 'B2+B3+B4+B5+B6+B7', B8: 'B9+B10+B11+B12', B13: 'A1+B1-B8', C1: 'B14', C3: 'C3a+C3b', C4: 'C1-C2-C3', C6: 'C4-C5', C9: 'C7*C7a/100+C8*C8a/100', C10: 'C11+C12+C13',
      C17: 'C9-C10-C14-C15-C16', D1: 'B15', D2: 'D2a+D2b', D3: 'D1-D2', D5: 'D3-D4', D8: 'D6-D7', E: 'E1+E2+E5', E2: 'E3+E4', G: 'G1+G2+G3+G4+G5',
      H1: 'E1+E5-G2', H2: 'E3-G4', H3: 'E4-G5', I: 'E-G', I1: 'E1+E5-G1-G2', I2: 'E2-G3-G4-G5',
    });
    const soft = t.lines.filter((l) => l.printed === false);
    expect(soft.map((l) => [l.code, l.formula])).toEqual([['B14', 'B13-B15'], ['C7', 'C6-C8'], ['E1', 'C17'], ['E3', 'D8']]);
    for (const l of soft) { expect(l.overridable, l.code).toBe(true); expect(l.note, l.code).toMatch(/Mẫu (không ghi|ghi C6)/); }
    // Công thức in nằm trong nhãn (trừ I1, I2 in ở cột mã chỉ tiêu, ghi ở note): mọi chỉ tiêu của công thức máy có trong phần công thức của nhãn.
    for (const l of t.lines.filter((x) => x.printed !== false && x.formula)) {
      const shown = ['I1', 'I2'].includes(l.code) ? l.note! : l.label.slice(l.label.lastIndexOf(`(${l.code}`));
      expect(shown, l.code).toContain(l.code);
      for (const r of refs(l.formula!)) expect(refs(shown), `${l.code}: ${r}`).toContain(r);
    }
  });
  it('công thức chỉ tham chiếu chỉ tiêu có số (không phải dòng tiêu đề), không chu trình', () => {
    const byCode = new Map(t.lines.map((l) => [l.code, l]));
    for (const l of t.lines) {
      if (l.kind === 'formula') expect(l.formula, l.code).toBeTruthy(); else expect(l.formula, l.code).toBeUndefined();
      for (const r of refs(l.formula ?? '')) { expect(byCode.has(r), `${l.code} → ${r}`).toBe(true); expect(byCode.get(r)!.kind, `${l.code} → ${r}`).not.toBe('section'); }
    }
    const state = new Map<string, 1 | 2>();
    const visit = (c: string): void => { if (state.get(c) === 2) return; expect(state.get(c), `chu trình ${c}`).toBeUndefined(); state.set(c, 1); refs(byCode.get(c)!.formula ?? '').forEach(visit); state.set(c, 2); };
    CODES.forEach(visit);
    expect(t.lines.filter((l) => l.kind === 'section').map((l) => l.code)).toEqual(['A', 'B', 'C', 'D', 'H']);
    expect(t.lines.filter((l) => l.kind === 'ledger').map((l) => l.code)).toEqual(['A1', 'G2']);
    expect(t.lines.filter((l) => l.kind === 'rate').map((l) => l.code)).toEqual(['05', 'C7a', 'C8a']);
    for (const l of t.lines) if (l.kind === 'input' || l.kind === 'ledger' || l.kind === 'rate' || l.kind === 'text') expect(l.overridable, l.code).toBe(true);
  });
  it('định dạng XML htkk-03tndn: chưa kiểm chứng, đủ thẻ cho mọi chỉ tiêu có số', () => {
    const f = loadTaxXmlFormat('htkk-03tndn');
    expect([f.verified, f.formCode, f.templateVersions]).toEqual([false, '03/TNDN', ['TT89', 'TT80']]);
    expect(Object.keys(f.tags).sort()).toEqual(t.lines.filter((l) => l.kind !== 'section').map((l) => l.code).sort());
  });
  it('ánh xạ sổ cái theo chế độ: TT99 82111 (8211 là tài khoản tổng hợp), TT133 821; lợi nhuận B02 dòng 50', () => {
    expect(loadCitLedger('TT99')).toMatchObject({ profitLine: '50', expenseLine: '51', revenueLines: ['10', '22', '31'], expenseAccount: '82111', payableAccount: '3334' });
    expect(loadCitLedger('TT133')).toMatchObject({ profitLine: '50', expenseLine: '51', revenueLines: ['10', '21', '31'], expenseAccount: '821', payableAccount: '3334' });
    expect(loadCitLedger('TT200')).toBeUndefined();
  });
  it('tham số thuế TNDN theo văn bản gốc (Luật 67/2025 Điều 10, NĐ 141/2026 Điều 2, NQ 43/2026 Điều 1 khoản 2, NĐ 252/2026 Điều 24 khoản 3)', () => {
    const p = (c: string) => loadLegalParams().filter((r) => r.code === c);
    expect(p('cit_rate')).toMatchObject([{ value: { standard: 20, tiers: [{ maxRevenue: '3000000000', rate: 15 }, { maxRevenue: '50000000000', rate: 17 }] }, validFrom: '2025-01-01', validTo: null }]);
    expect(p('cit_exempt_revenue')).toMatchObject([{ value: '1000000000', validFrom: '2026-01-01', validTo: null }]);
    expect(p('cit_reduction')).toMatchObject([{ value: { rate: 30, maxRevenue: '10000000000', revenueOf: 'current_year' }, validFrom: '2026-01-01', validTo: '2027-12-31' }]);
    expect(p('cit_prepay_min_ratio')).toMatchObject([{ value: 80, validFrom: '2026-07-01', validTo: null }]);
    expect(p('cit_return_template')).toMatchObject([{ value: 'TT80', validFrom: '2021-12-31', validTo: '2026-06-30' }, { value: 'TT89', validFrom: '2026-07-01', validTo: null }]);
    for (const c of ['cit_rate', 'cit_exempt_revenue', 'cit_reduction', 'cit_prepay_min_ratio']) expect(p(c)[0]!.source, c).toMatch(/dòng \d+/);
    expect(status.CIT_RATES).toBe(true);
  });
});

// Mã chỉ tiêu in trên mẫu 03/TNDN, TT 80/2021 Phụ lục II, Công báo 969+970 trang 60-63 (đối chiếu ảnh); ghi tay, không suy ra từ dữ liệu.
const CODES_80 = ['04', '05', 'A', 'A1', 'B', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13', 'B14', 'B15',
  'C', 'C1', 'C2', 'C3', 'C3a', 'C3b', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8a', 'C9', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17',
  'D', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'E', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'G', 'G1', 'G2', 'G3', 'G4', 'G5', 'H', 'H1', 'H2', 'H3', 'I', 'I1', 'I2'];

describe('mẫu tờ khai 03/TNDN theo TT 80/2021', () => {
  const t = loadCitTemplate('TT80');
  it('cổng 03TNDN_TT80 bật, đủ chỉ tiêu theo thứ tự in, mỗi mã một lần, có nhãn; không có B12a, C7a, D2a, D2b của TT 89/2026', () => {
    expect(status['03TNDN_TT80']).toBe(true); expect(isCitTemplateComplete('TT80')).toBe(true);
    expect(t.version).toBe('TT80'); expect(t.lines.map((l) => l.code)).toEqual(CODES_80);
    for (const l of t.lines) expect(l.label, l.code).not.toBe('');
    expect(t.source).toContain('TT 80/2021'); expect(t.source).toContain('Công báo số 969 + 970'); expect(t.source).toMatch(/trang 60-64/);
  });
  it('công thức in trên mẫu đúng nguyên văn (C9 = C7 x 20% + C8 x C8a); công thức gợi ý của phần mềm đánh dấu printed=false', () => {
    const printed = Object.fromEntries(t.lines.filter((l) => l.formula && l.printed !== false).map((l) => [l.code, l.formula]));
    expect(printed).toEqual({
      B1: 'B2+B3+B4+B5+B6+B7', B8: 'B9+B10+B11+B12', B13: 'A1+B1-B8', C1: 'B14', C3: 'C3a+C3b', C4: 'C1-C2-C3', C6: 'C4-C5', C9: 'C7*20/100+C8*C8a/100', C10: 'C11+C12+C13',
      C17: 'C9-C10-C14-C15-C16', D1: 'B15', D3: 'D1-D2', D5: 'D3-D4', D8: 'D6-D7', E: 'E1+E2+E5', E2: 'E3+E4', G: 'G1+G2+G3+G4+G5',
      H1: 'E1+E5-G2', H2: 'E3-G4', H3: 'E4-G5', I: 'E-G', I1: 'E1+E5-G1-G2', I2: 'E2-G3-G4-G5',
    });
    expect(t.lines.filter((l) => l.printed === false).map((l) => [l.code, l.formula])).toEqual([['B14', 'B13-B15'], ['C7', 'C6-C8'], ['E1', 'C17'], ['E3', 'D8']]);
    const byCode = new Map(t.lines.map((l) => [l.code, l]));
    for (const l of t.lines) {
      if (l.kind === 'formula') expect(l.formula, l.code).toBeTruthy(); else expect(l.formula, l.code).toBeUndefined();
      for (const r of refs(l.formula ?? '')) { expect(byCode.has(r), `${l.code} → ${r}`).toBe(true); expect(byCode.get(r)!.kind, `${l.code} → ${r}`).not.toBe('section'); }
    }
    expect(t.lines.filter((l) => l.kind === 'section').map((l) => l.code)).toEqual(['A', 'B', 'C', 'D', 'H']);
    expect(t.lines.filter((l) => l.kind === 'ledger').map((l) => l.code)).toEqual(['A1', 'G2']);
    expect(t.lines.filter((l) => l.kind === 'rate').map((l) => l.code)).toEqual(['05', 'C8a']);
  });
  it('mã của TT80 là tập con mã của TT89 (XML dùng chung bộ thẻ); gồm cả D2 một dòng', () => {
    const codes89 = new Set(loadCitTemplate('TT89').lines.map((l) => l.code));
    for (const l of t.lines) expect(codes89.has(l.code), l.code).toBe(true);
    const f = loadTaxXmlFormat('htkk-03tndn');
    for (const l of t.lines.filter((x) => x.kind !== 'section')) expect(f.tags[l.code], l.code).toBeTruthy();
  });
  it('tham số mẫu theo kỳ: TT80 từ 2021-12-31 đến 2026-06-30, TT89 từ 2026-07-01', () => {
    const rows = loadLegalParams().filter((r) => r.code === 'cit_return_template');
    expect(rows.map((r) => [r.value, r.validFrom, r.validTo])).toEqual([['TT80', '2021-12-31', '2026-06-30'], ['TT89', '2026-07-01', null]]);
  });
});
