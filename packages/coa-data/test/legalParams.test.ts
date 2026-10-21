import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataPath, loadLegalParams } from '../src/index.js';

const status = JSON.parse(readFileSync(dataPath('tax', 'status.json'), 'utf8')) as Record<string, boolean | string>;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

describe('legal-params.json', () => {
  const rows = loadLegalParams();
  it('mỗi dòng có mã, nguồn, khoảng hiệu lực hợp lệ; các khoảng của cùng mã không chồng nhau', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.code).toMatch(/^[a-z0-9_]+$/);
      expect(r.source.trim(), `${r.code} thiếu nguồn`).not.toBe('');
      expect(r.validFrom).toMatch(DATE);
      if (r.validTo !== null) { expect(r.validTo).toMatch(DATE); expect(r.validTo >= r.validFrom, `${r.code} ${r.validFrom}`).toBe(true); }
    }
    for (const code of new Set(rows.map((r) => r.code))) {
      const xs = rows.filter((r) => r.code === code).sort((a, b) => a.validFrom.localeCompare(b.validFrom));
      xs.slice(1).forEach((r, i) => expect(xs[i]!.validTo !== null && xs[i]!.validTo! < r.validFrom, `${code}: ${xs[i]!.validFrom} chồng ${r.validFrom}`).toBe(true));
    }
  });
  it('cổng dữ liệu pháp lý theo dòng: legalParam_<mã>@<validFrom>; false khi và chỉ khi nguồn ghi "chưa đối chiếu"; không có khóa thừa', () => {
    const keys = rows.map((r) => `legalParam_${r.code}@${r.validFrom}`);
    rows.forEach((r, i) => {
      const gate = status[keys[i]!];
      expect(typeof gate, `status.json thiếu ${keys[i]}`).toBe('boolean');
      expect(gate, `${keys[i]}: cổng phải là false khi và chỉ khi nguồn ghi "chưa đối chiếu"`).toBe(!r.source.includes('chưa đối chiếu'));
    });
    expect(Object.keys(status).filter((k) => k.startsWith('legalParam_') && k !== 'legalParam_note').sort()).toEqual([...keys].sort());
  });
  it('giá trị theo đặc tả mục 10: giảm thuế suất 10% → 8% đến hết 2026, ngưỡng thanh toán không dùng tiền mặt 5 triệu, mẫu tờ khai TT80 → TT89 từ 01/7/2026', () => {
    expect(rows.find((r) => r.code === 'vat_reduced_rate')).toMatchObject({ value: { from: 10, to: 8 }, validFrom: '2025-07-01', validTo: '2026-12-31' });
    expect(rows.find((r) => r.code === 'vat_noncash_threshold')).toMatchObject({ value: '5000000', validFrom: '2025-07-01', validTo: null });
    expect(rows.filter((r) => r.code === 'vat_return_template').map((r) => [r.value, r.validFrom, r.validTo])).toEqual([['TT80', '2022-01-01', '2026-06-30'], ['TT89', '2026-07-01', null]]);
  });
});
