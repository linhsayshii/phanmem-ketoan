import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, type TestDb } from '@kt/db/testing';
import { legalParam } from '../src/modules/core/legal.js';

let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });

describe('tham số pháp lý theo ngày hiệu lực', () => {
  it('legalParam chọn dòng có khoảng hiệu lực chứa ngày; ngoài mọi khoảng hoặc mã lạ thì null', async () => {
    expect(await legalParam<string>(t.db, 'vat_return_template', '2026-06-30')).toBe('TT80');
    expect(await legalParam<string>(t.db, 'vat_return_template', '2026-07-01')).toBe('TT89');
    expect(await legalParam<string>(t.db, 'vat_return_template', '2021-12-31')).toBeNull();
    expect(await legalParam<{ from: number; to: number }>(t.db, 'vat_reduced_rate', '2025-07-01')).toEqual({ from: 10, to: 8 });
    expect(await legalParam(t.db, 'vat_reduced_rate', '2027-01-01')).toBeNull();
    expect(await legalParam<string>(t.db, 'vat_noncash_threshold', '2026-10-21')).toBe('5000000');
    expect(await legalParam(t.db, 'khong_co', '2026-10-21')).toBeNull();
  });
});
