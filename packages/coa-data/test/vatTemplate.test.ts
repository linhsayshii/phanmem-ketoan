import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataPath, isVatRate8Verified, isVatTemplateComplete, loadVatTemplate } from '../src/index.js';

const status = JSON.parse(readFileSync(dataPath('tax', 'status.json'), 'utf8')) as Record<string, boolean | string>;
// Chỉ tiêu [21]-[43] in trên mẫu 01/GTGT, TT 89/2026 trang 241-242 (đối chiếu ảnh); ghi tay, không suy ra từ dữ liệu.
const CODES = ['21', '22', '23', '23a', '24', '24a', '25', '26', '27', '28', '29', '30', '31', '32', '32a', '32b', '33', '34', '34a', '35', '36', '37', '38', '39a', '40a', '40b', '40', '41', '42', '43'];

describe('mẫu tờ khai 01/GTGT theo TT 89/2026', () => {
  const t = loadVatTemplate('TT89');
  it('đủ chỉ tiêu [21]-[43], mỗi mã đúng một lần, có nhãn và mục', () => {
    expect(t.lines.map((l) => l.code).sort()).toEqual([...CODES].sort());
    for (const l of t.lines) { expect(l.label, l.code).not.toBe(''); expect(l.section, l.code).not.toBe(''); }
  });
  it('công thức chỉ tham chiếu chỉ tiêu có thật và không có chu trình', () => {
    const byCode = new Map(t.lines.map((l) => [l.code, l]));
    const refs = (l: { formula?: string }): string[] => [...(l.formula ?? '').matchAll(/\[(\w+)\]/g)].map((m) => m[1]!);
    for (const l of t.lines) {
      if (l.kind === 'formula') expect(l.formula, l.code).toBeTruthy(); else expect(l.formula, l.code).toBeUndefined();
      for (const r of refs(l)) expect(byCode.has(r), `[${l.code}] tham chiếu [${r}] không có`).toBe(true);
    }
    const state = new Map<string, 1 | 2>();
    const visit = (c: string): void => {
      if (state.get(c) === 2) return;
      expect(state.get(c), `chu trình tại [${c}]`).toBeUndefined();
      state.set(c, 1); refs(byCode.get(c)!).forEach(visit); state.set(c, 2);
    };
    CODES.forEach(visit);
  });
  it('công thức đúng như in trên mẫu', () => {
    const f = Object.fromEntries(t.lines.filter((l) => l.formula).map((l) => [l.code, l.formula]));
    expect(f).toEqual({
      '27': '[29]+[30]+[32]+[32a]-[32b]', '28': '[31]+[33]', '34': '[26]+[27]+[34a]', '35': '[28]', '36': '[35]-[25]',
      '40a': '[36]-[22]+[37]-[38]-[39a]', '40': '[40a]-[40b]', '41': '[36]-[22]+[37]-[38]-[39a]', '43': '[41]-[42]',
    });
    expect(t.lines.find((l) => l.code === '40a')!.clamp).toBe('positivePart');
    expect(t.lines.find((l) => l.code === '41')!.clamp).toBe('negativePart');
  });
  it('ánh xạ nhóm kê khai và loại chỉ tiêu theo thiết kế', () => {
    const l = (c: string) => t.lines.find((x) => x.code === c)!;
    expect(l('23').invoice).toEqual({ direction: 'purchase', groups: ['01', '02', '03', '04'], field: 'base' });
    expect(l('24').invoice).toEqual({ direction: 'purchase', groups: ['01', '02', '03', '04'], field: 'tax' });
    expect(l('23a').invoice).toMatchObject({ importOnly: true, field: 'base' }); expect(l('24a').invoice).toMatchObject({ importOnly: true, field: 'tax' });
    expect(l('25')).toMatchObject({ kind: 'invoice', overridable: true, invoice: { direction: 'purchase', groups: ['01', '03'], field: 'tax' } });
    expect(l('26').invoice).toEqual({ direction: 'sale', groups: ['KCT'], field: 'base' });
    expect(l('29').invoice?.groups).toEqual(['00']); expect(l('30').invoice?.groups).toEqual(['05']); expect(l('31').invoice).toMatchObject({ groups: ['05'], field: 'tax' });
    expect(l('32').invoice?.groups).toEqual(['10', '08']); expect(l('33').invoice).toMatchObject({ groups: ['10', '08'], field: 'tax' });
    expect(l('32a').invoice?.groups).toEqual(['KKK']); expect(l('32b').invoice?.groups).toEqual(['KTGT']); expect(l('34a').invoice?.groups).toEqual(['NPV']);
    expect(l('21').kind).toBe('flag'); expect(l('22').kind).toBe('carry');
    for (const c of ['37', '38', '39a', '40b', '42']) expect(l(c).kind, c).toBe('manual');
  });
  it('nguồn nhắc TT 89/2026 và trang; hiệu lực từ 01/7/2026', () => {
    expect(t).toMatchObject({ form: '01/GTGT', version: 'TT89', validFrom: '2026-07-01', validTo: null });
    expect(t.source).toContain('TT 89/2026'); expect(t.source).toMatch(/trang 241/);
  });
  it('cổng status.json: TT89 đã đối chiếu; 8% chưa có văn bản gốc nên false kèm ghi chú trên dòng [32]', () => {
    expect(status['01GTGT_TT89']).toBe(true); expect(isVatTemplateComplete('TT89')).toBe(true);
    expect(status['01GTGT_TT89_rate8']).toBe(false); expect(isVatRate8Verified()).toBe(false);
    expect(t.lines.find((x) => x.code === '32')!.note).toMatch(/8%/);
  });
  it('TT80 chưa có văn bản gốc: loadVatTemplate ném lỗi rõ, không hoàn chỉnh', () => {
    expect(status['01GTGT_TT80']).toBe(false); expect(isVatTemplateComplete('TT80')).toBe(false);
    expect(() => loadVatTemplate('TT80')).toThrow(/TT 80\/2021/);
  });
});
