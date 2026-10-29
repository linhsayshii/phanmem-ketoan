import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataPath, isTncnTemplateComplete, isTncnXmlAvailable, loadTncnTemplate } from '../src/index.js';

const status = JSON.parse(readFileSync(dataPath('tax', 'status.json'), 'utf8')) as Record<string, boolean | string>;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i).padStart(2, '0'));
// Mã chỉ tiêu in trên mẫu, TT 89/2026 trang 307-309 (05/KK-TNCN) và 312-314 (05/QTT-TNCN), đối chiếu ảnh 300 dpi; ghi tay, không suy ra từ dữ liệu.
const KK_CODES = range(15, 45);
const QTT_CODES = range(15, 45);
const refs = (f: string) => [...f.matchAll(/\d+/g)].map((m) => m[0]);

describe('mẫu 05/KK-TNCN theo TT 89/2026', () => {
  const t = loadTncnTemplate('05KK');
  it('cổng bật, đủ chỉ tiêu [15]-[45] theo thứ tự in, mỗi mã một lần, có nhãn, STT và đơn vị', () => {
    expect(status['05KK_TNCN_TT89']).toBe(true); expect(isTncnTemplateComplete('05KK')).toBe(true);
    expect(t.lines.map((l) => l.code)).toEqual(KK_CODES);
    for (const l of t.lines) { expect(l.label, l.code).not.toBe(''); expect(l.stt, l.code).not.toBe(''); expect(['Người', 'VNĐ']).toContain(l.unit); }
    expect(t.header.map((h) => h.code)).toEqual(range(1, 14));
    expect(t.periodKinds).toEqual(['quarter']);
  });
  it('công thức in trên mẫu đúng nguyên văn; chỉ tiêu [36] mẫu không in công thức', () => {
    const f = Object.fromEntries(t.lines.filter((l) => l.formula).map((l) => [l.code, l.formula]));
    expect(f).toEqual({ '17': '18+19', '20': '21+22', '24': '25+26+27+28', '29': '30+31', '32': '33+34', '42': '43+44' });
    expect(t.lines.find((l) => l.code === '36')).toMatchObject({ kind: 'amount', overridable: true });
    for (const l of t.lines.filter((x) => x.formula)) {
      expect(l.kind, l.code).toBe('formula'); expect(l.overridable, l.code).toBe(false);
      expect(l.label, l.code).toContain(`[${l.code}]=` + l.formula!.split('+').map((c) => `[${c}]`).join('+'));
    }
    expect(t.lines.filter((l) => l.unit === 'Người').map((l) => l.code)).toEqual(['15', '16', '17', '18', '19']);
  });
  it('công thức chỉ tham chiếu chỉ tiêu có thật, không chu trình', () => {
    const by = new Map(t.lines.map((l) => [l.code, l]));
    const state = new Map<string, 1 | 2>();
    const visit = (c: string): void => { if (state.get(c) === 2) return; expect(state.get(c), `chu trình ${c}`).toBeUndefined(); state.set(c, 1); for (const r of refs(by.get(c)!.formula ?? '')) { expect(by.has(r), `${c} → ${r}`).toBe(true); visit(r); } state.set(c, 2); };
    KK_CODES.forEach(visit);
  });
  it('phụ lục 05-1/PBT-KK-TNCN: cột [06]-[14], tổng [15]-[19] đứng dưới cột [10]-[14]; bảng trúng thưởng [20]-[24], tổng [25], [26]', () => {
    expect(t.appendices.map((a) => a.code)).toEqual(['05-1/PBT-KK-TNCN']);
    const [a, b] = t.appendices[0]!.tables;
    expect(a!.columns.map((c) => c.code)).toEqual(['06', '07', '08', '08a', '08b', '09', '10', '11', '12', '13', '14']);
    expect(a!.totals).toEqual([{ code: '15', column: '10' }, { code: '16', column: '11' }, { code: '17', column: '12' }, { code: '18', column: '13' }, { code: '19', column: '14' }]);
    expect(b!.columns.map((c) => c.code)).toEqual(['20', '21', '21a', '21b', '22', '23', '24']);
    expect(b!.totals).toEqual([{ code: '25', column: '23' }, { code: '26', column: '24' }]);
  });
});

describe('mẫu 05/QTT-TNCN theo TT 89/2026', () => {
  const t = loadTncnTemplate('05QTT');
  it('cổng bật, đủ chỉ tiêu [15]-[45] theo thứ tự in, phần I [15]-[36], phần II [37]-[45]', () => {
    expect(status['05QTT_TNCN_TT89']).toBe(true); expect(isTncnTemplateComplete('05QTT')).toBe(true);
    expect(t.lines.map((l) => l.code)).toEqual(QTT_CODES);
    expect(t.lines.filter((l) => l.section === 'I').map((l) => l.code)).toEqual(range(15, 36));
    expect(t.lines.filter((l) => l.section === 'II').map((l) => l.code)).toEqual(range(37, 45));
    for (const l of t.lines) { expect(l.label, l.code).not.toBe(''); expect(l.stt, l.code).not.toBe(''); expect(['Người', 'VNĐ']).toContain(l.unit); }
    expect(t.header.map((h) => h.code)).toEqual(range(1, 14));
    expect(t.periodKinds).toEqual(['year']);
  });
  it('công thức in trên mẫu đúng nguyên văn, [44] lấy phần dương, [45] phần âm; STT 8 của [30] in như mẫu', () => {
    const f = Object.fromEntries(t.lines.filter((l) => l.formula).map((l) => [l.code, l.formula]));
    expect(f).toEqual({ '17': '18+19', '22': '23+24', '26': '27+28+29', '30': '31+32', '33': '34+35', '44': '40-38-41-42-43', '45': '40-38-41-42-43' });
    expect(t.lines.find((l) => l.code === '44')).toMatchObject({ clamp: 'positivePart', kind: 'formula' });
    expect(t.lines.find((l) => l.code === '45')).toMatchObject({ clamp: 'negativePart', kind: 'formula' });
    expect(t.lines.find((l) => l.code === '30')).toMatchObject({ stt: '8', printedAnomaly: true });
    expect(t.lines.find((l) => l.code === '31')!.stt).toBe('8.1');
    expect(t.lines.filter((l) => l.unit === 'Người').map((l) => l.code)).toEqual(['15', '16', '17', '18', '19', '20', '21', '37']);
  });
  it('công thức chỉ tham chiếu chỉ tiêu có thật, không chu trình', () => {
    const by = new Map(t.lines.map((l) => [l.code, l]));
    const state = new Map<string, 1 | 2>();
    const visit = (c: string): void => { if (state.get(c) === 2) return; expect(state.get(c), `chu trình ${c}`).toBeUndefined(); state.set(c, 1); for (const r of refs(by.get(c)!.formula ?? '')) { expect(by.has(r), `${c} → ${r}`).toBe(true); visit(r); } state.set(c, 2); };
    QTT_CODES.forEach(visit);
  });
  it('phụ lục 05-1, 05-2, 05-3/BK-QTT-TNCN: mã cột và tổng đúng mẫu', () => {
    expect(t.appendices.map((a) => a.code)).toEqual(['05-1/BK-QTT-TNCN', '05-2/BK-QTT-TNCN', '05-3/BK-QTT-TNCN']);
    const [a1, a2, a3] = t.appendices;
    expect(a1!.tables.map((x) => x.columns.map((c) => c.code))).toEqual([range(6, 25), range(40, 50), range(51, 61)]);
    expect(a1!.tables[0]!.totals).toEqual(range(12, 25).map((c, i) => ({ code: String(26 + i), column: c })));
    expect(a2!.tables[0]!.columns.map((c) => c.code)).toEqual(range(6, 21));
    expect(a2!.tables[0]!.totals).toEqual(range(11, 21).map((c, i) => ({ code: String(22 + i), column: c })));
    expect(a3!.tables[0]!.columns.map((c) => c.code)).toEqual(range(6, 16));
  });
});

describe('cổng định dạng XML HTKK của tờ khai TNCN', () => {
  it('TNCN_XML_HTKK còn false: chưa có tệp kết xuất mẫu từ HTKK, không suy đoán tên thẻ', () => {
    expect(status.TNCN_XML_HTKK).toBe(false); expect(isTncnXmlAvailable()).toBe(false);
  });
});
