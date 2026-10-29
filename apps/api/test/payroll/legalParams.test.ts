import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '@kt/db';
import { loadLegalParams } from '@kt/coa-data';
import { pitProgressive, resolvePayrollParams, siContributions, type RawPayrollParams, type SiRates } from '@kt/domain';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';
import { PARAM_SCHEMAS, payrollParam, type PayrollParamCode } from '../../src/modules/payroll/params.js';

// Tham số lương, TNCN, BHXH thật (legal-params-payroll.json, nhập từ văn bản gốc 2026-10-29). DB kiểm thử của API không giữ các dòng này (setupTestDb, KT_TEST_ILLUSTRATIVE_PAYROLL)
// vì các kiểm thử lương dùng dữ liệu minh họa; bài này nạp lại từ tệp vào legal_param, kiểm lược đồ, tra theo ngày và tính tay.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const CODES = ['pit_brackets', 'pit_brackets_annual', 'pit_deduction', 'pit_flat_rate_no_contract', 'pit_non_resident_rate', 'min_wage_region', 'si_rates', 'si_ceiling', 'si_floor'] as const;
let ctx: TestApp; let tenantId: string;
const rows = loadLegalParams().filter((r) => (CODES as readonly string[]).includes(r.code));
const at = async <T>(code: string, d: string) => withTenant(ctx.t.db, { tenantId }, (trx) => payrollParam<T>(trx, code, d));

async function raw(date: string): Promise<RawPayrollParams> {
  const o: Record<string, unknown> = {};
  for (const c of CODES) { const v = await at(c, date).catch(() => null); if (v) o[c] = v.value; } // pit_non_resident_rate chỉ có từ 01/7/2026
  return o as RawPayrollParams;
}

beforeAll(async () => {
  ctx = await createTestApp(); ({ tenantId } = await bootstrapTenant(ctx, { code: `LP${Date.now()}` }));
  await sql`DELETE FROM legal_param WHERE code IN (${sql.join([...CODES])})`.execute(ctx.t.admin);
  for (const r of rows) await sql`INSERT INTO legal_param(code, value, valid_from, valid_to, source) VALUES (${r.code}, ${JSON.stringify(r.value)}::jsonb, ${r.validFrom}, ${r.validTo}, ${r.source})`.execute(ctx.t.admin);
}, 60_000);
afterAll(async () => { await sql`DELETE FROM legal_param WHERE code IN (${sql.join([...CODES])})`.execute(ctx.t.admin); await ctx.close(); });

describe('tham số lương thật: lược đồ và tra theo ngày', () => {
  it('mọi dòng đúng lược đồ zod của API (cùng lược đồ màn Tham số lương)', () => {
    expect(rows).toHaveLength(11);
    for (const r of rows) { const p = PARAM_SCHEMAS[r.code as PayrollParamCode].safeParse(r.value); expect(p.success, `${r.code}@${r.validFrom}: ${JSON.stringify(p.error?.issues)}`).toBe(true); }
  });
  it('tra theo ngày: biểu thuế và giảm trừ từ 01/01/2026; trần, sàn đổi ngày 01/7/2026; không cư trú từ 01/7/2026; trước 2026 thiếu → 409', async () => {
    expect((await at<{ self: string; dependent: string }>('pit_deduction', '2026-01-01')).value).toEqual({ self: '15500000', dependent: '6200000' });
    expect((await at<{ si_base_max: string }>('si_ceiling', '2026-06-30')).value.si_base_max).toBe('46800000');
    expect((await at<{ si_base_max: string }>('si_ceiling', '2026-07-01')).value.si_base_max).toBe('50600000');
    expect((await at<{ si_base_min: string }>('si_floor', '2026-06-30')).value.si_base_min).toBe('2340000');
    expect((await at<{ si_base_min: string }>('si_floor', '2026-12-31')).value.si_base_min).toBe('2530000');
    expect((await at('pit_non_resident_rate', '2026-07-01')).source).toBe('legal_param');
    for (const [code, d] of [['pit_brackets', '2025-12-31'], ['pit_non_resident_rate', '2026-06-30'], ['si_rates', '2025-12-31']] as const) {
      await expect(at(code, d), `${code}@${d}`).rejects.toMatchObject({ code: 'PAYROLL_PARAM_MISSING', status: 409 });
    }
    for (const c of ['ot_multipliers', 'ot_tax_exempt_extra', 'pit_income_timing']) await expect(at(c, '2026-03-15'), c).rejects.toMatchObject({ code: 'PAYROLL_PARAM_MISSING' });
  });
});

describe('tính tay theo tham số thật', () => {
  const FLAGS = { si: true, hi: true, ui: true, occupational: true };
  const calc = async (date: string, gross: string, dependents: number, region: 'I' | 'II' | 'III' | 'IV' = 'I') => {
    const p = resolvePayrollParams(await raw(date), region);
    const si = siContributions(gross, { rates: p.siRates as SiRates, ceiling: p.siCeiling!, ...(p.siFloor !== undefined && { floor: p.siFloor }), ...(p.uiCeiling !== undefined && { uiCeiling: p.uiCeiling }) }, FLAGS);
    const empSi = Object.values(si.employee).reduce((a, v) => a + Number(v), 0);
    const taxable = Number(gross) - empSi - Number(p.pitDeduction!.self) - dependents * Number(p.pitDeduction!.dependent);
    return { si, empSi, taxable, tax: Number(pitProgressive(String(Math.max(taxable, 0)), p.pitBrackets!).tax) };
  };
  it('lương 30 triệu, 1 người phụ thuộc, 03/2026: BH người lao động 3.150.000 (10,5%), thu nhập tính thuế 5.150.000, thuế 257.500', async () => {
    const r = await calc('2026-03-15', '30000000', 1);
    expect(r.si.employee).toEqual({ si: '2400000', hi: '450000', ui: '300000' });
    expect(r.si.employer).toEqual({ si: '5100000', hi: '900000', ui: '300000', occupational: '150000' }); // 17%, 3%, 1%, 0,5%
    expect([r.empSi, r.taxable, r.tax]).toEqual([3150000, 5150000, 257500]);
  });
  it('lương 50 triệu, 2 người phụ thuộc, 03/2026: BHXH và BHYT kẹp trần 46.800.000, BHTN tính trên 50.000.000 (trần 20 × 5.310.000 vùng I); thuế 1.215.400', async () => {
    const r = await calc('2026-03-15', '50000000', 2);
    expect(r.si.base).toBe('46800000'); expect(r.si.uiBase).toBe('50000000');
    expect(r.si.employee).toEqual({ si: '3744000', hi: '702000', ui: '500000' });
    expect([r.empSi, r.taxable, r.tax]).toEqual([4946000, 17154000, 1215400]); // 500.000 + 7.154.000 × 10%
  });
  it('lương 60 triệu, không người phụ thuộc, 07/2026: trần BHXH, BHYT 50.600.000; BHTN 600.000', async () => {
    const r = await calc('2026-07-15', '60000000', 0);
    expect(r.si.base).toBe('50600000');
    expect(r.si.employee).toEqual({ si: '4048000', hi: '759000', ui: '600000' });
    expect(r.taxable).toBe(60000000 - 5407000 - 15500000); // 39.093.000
    expect(r.tax).toBe(500000 + 2000000 + 1818600); // 5% × 10tr + 10% × 20tr + 20% × 9.093.000
  });
  it('vùng IV: BHTN kẹp 20 × 3.700.000 = 74.000.000; lương dưới sàn bị nâng lên sàn 2.340.000', async () => {
    const hi = await calc('2026-03-15', '90000000', 0, 'IV');
    expect(hi.si.uiBase).toBe('74000000'); expect(hi.si.employee.ui).toBe('740000'); expect(hi.si.base).toBe('46800000');
    const lo = await calc('2026-03-15', '1000000', 0);
    expect(lo.si.base).toBe('2340000'); expect(lo.si.employee.si).toBe('187200');
  });
  it('biểu thuế tháng: thu nhập tính thuế 100 triệu → 20.500.000; 120 triệu → 27.500.000; biểu năm 1,2 tỷ → 246.000.000 (= 12 × 20,5 triệu)', async () => {
    const p = resolvePayrollParams(await raw('2026-03-15'), 'I');
    expect(pitProgressive('100000000', p.pitBrackets!).tax).toBe('20500000');
    expect(pitProgressive('120000000', p.pitBrackets!).tax).toBe('27500000');
    expect(pitProgressive('1200000000', p.pitBracketsAnnual!).tax).toBe('246000000');
    expect(pitProgressive('10000000', p.pitBrackets!).tax).toBe('500000');
  });
});
