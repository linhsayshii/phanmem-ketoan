import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataPath } from '../src/index.js';

const status = JSON.parse(readFileSync(dataPath('tax', 'status.json'), 'utf8')) as Record<string, boolean | string>;
const legal = JSON.parse(readFileSync(dataPath('tax', 'legal-params.json'), 'utf8')) as { code: string }[];

describe('cổng dữ liệu pháp lý lương và thuế TNCN (GĐ6)', () => {
  it('chưa có văn bản gốc nên mọi cổng là false, kèm ghi chú nêu văn bản cần', () => {
    for (const k of ['payrollParams_pit', 'payrollParams_si', 'payrollParams_minWage', '05KK_TNCN_TT89', '05QTT_TNCN_TT89']) expect(status[k], k).toBe(false);
    const note = String(status['payrollParams_note']) + String(status['TNCN_note']);
    for (const t of ['109/2025/QH15', 'Luật Bảo hiểm xã hội 2024', 'lương tối thiểu vùng', 'TT 89/2026', '05/KK-TNCN', '05/QTT-TNCN']) expect(note, t).toContain(t);
  });
  it('legal-params.json không chứa tham số lương/TNCN/BHXH nào (người dùng nhập ở payroll_param)', () => {
    const banned = /^(pit_|si_|min_wage|ot_|payroll)/;
    expect(legal.filter((r) => banned.test(r.code)).map((r) => r.code)).toEqual([]);
  });
});
