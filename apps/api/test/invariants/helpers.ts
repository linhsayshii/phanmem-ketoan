import fc from 'fast-check';
import { expect } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, type TestApp } from '../helpers.js';

export interface Line { accountCode: string; debit?: string; credit?: string }

// Tài khoản chi tiết tồn tại ở cả TT133 và TT99, không theo dõi đối tượng.
export const ACCOUNTS = ['1111', '1121', '5113', '6421', '6422', '242', '33311', '4111'];

export async function setupLedgerTenant(ctx: TestApp, code: string, regime: 'TT133' | 'TT99' = 'TT133') {
  const b = await bootstrapTenant(ctx, { code });
  const fy = await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie: b.cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime } });
  if (fy.statusCode !== 201) throw new Error(`tạo năm tài chính thất bại: ${fy.body}`);
  for (const [c, n] of [['KH001', 'Khách 1'], ['KH002', 'Khách 2'], ['NCC001', 'NCC 1']]) {
    const p = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie: b.cookie }, payload: { code: c, name: n, is_customer: true, is_vendor: true } });
    if (p.statusCode !== 201) throw new Error(`tạo đối tượng ${c} thất bại: ${p.body}`);
  }
  return b;
}

export const postVoucher = (ctx: TestApp, cookie: string, date: string, lines: object[], extra: object = {}) =>
  ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'inv', autoPost: true, lines, ...extra } });

// Số dư ròng (Nợ − Có) từng tài khoản đến hết `asOf`, cộng thẳng từ dòng chứng từ đã ghi sổ (không qua bảng số dư kỳ): nguồn đối chiếu độc lập.
export async function sumFromLines(ctx: TestApp, tenantId: string, asOf: string): Promise<Record<string, string>> {
  const r = await sql<{ code: string; net: string }>`SELECT a.code, sum(l.debit - l.credit)::text AS net FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND l.posting_date <= ${asOf}::date GROUP BY a.code HAVING sum(l.debit - l.credit) <> 0`.execute(ctx.t.admin);
  return Object.fromEntries(r.rows.map((x) => [x.code, x.net]));
}
// Số dư ròng từng tài khoản đến hết `asOf` theo API số dư (đường nhanh khi đã tính lại, đường chậm khi còn bẩn).
export async function snapshot(ctx: TestApp, cookie: string, asOf: string): Promise<Record<string, string>> {
  const r = await ctx.app.inject({ method: 'GET', url: `/api/balances?asOf=${asOf}`, headers: { cookie } });
  return Object.fromEntries((r.json().rows as { accountCode: string; debit: string; credit: string }[]).map((x) => [x.accountCode, (BigInt(x.debit) - BigInt(x.credit)).toString()]));
}
export const recompute = (ctx: TestApp, cookie: string) => ctx.app.inject({ method: 'POST', url: '/api/balances/recompute', headers: { cookie } });

// Bất biến 4: tại ngày `to`, Tài sản (loại 1–2) = Nợ phải trả (3) + Vốn chủ sở hữu (4) + Lãi lỗ chưa kết chuyển (−(5..9)), tính từ Bảng cân đối số phát sinh cấp 1.
export async function assertBalanceSheet(ctx: TestApp, cookie: string, to: string): Promise<{ assets: bigint; liab: bigint; equity: bigint; pnl: bigint }> {
  const r = await ctx.app.inject({ method: 'GET', url: `/api/reports/ledgers/trial-balance?from=2026-01-01&to=${to}&splitParty=false&level=1`, headers: { cookie } });
  expect(r.statusCode, r.body).toBe(200);
  const rows = r.json().rows as { accountCode: string; closing: { debit: string; credit: string } }[];
  const cls = (p: string) => rows.filter((x) => x.accountCode.startsWith(p)).reduce((s, x) => s + BigInt(x.closing.debit) - BigInt(x.closing.credit), 0n);
  const assets = cls('1') + cls('2'); const liab = -cls('3'); const equity = -cls('4'); const pnl = -(cls('5') + cls('6') + cls('7') + cls('8') + cls('9'));
  expect(assets, to).toBe(liab + equity + pnl);
  return { assets, liab, equity, pnl };
}

export const arbAmount = fc.bigInt({ min: 1n, max: 1_000_000_000n }).map(String);
export const arbDate2026 = fc.record({ m: fc.integer({ min: 1, max: 12 }), d: fc.integer({ min: 1, max: 28 }) }).map(({ m, d }) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
// n dòng Nợ, m dòng Có, tổng Nợ = tổng Có (phần dư của phép chia đều dồn vào dòng Có đầu tiên).
export const arbBalancedLines: fc.Arbitrary<Line[]> = fc.record({
  debits: fc.array(fc.record({ acc: fc.constantFrom(...ACCOUNTS), amt: arbAmount }), { minLength: 1, maxLength: 4 }),
  credits: fc.array(fc.constantFrom(...ACCOUNTS), { minLength: 1, maxLength: 4 }),
}).map(({ debits, credits }) => {
  const total = debits.reduce((s, d) => s + BigInt(d.amt), 0n); const each = total / BigInt(credits.length); const rest = total - each * BigInt(credits.length);
  return [...debits.map((d): Line => ({ accountCode: d.acc, debit: d.amt })),
    ...credits.map((c, i): Line => ({ accountCode: c, credit: (each + (i === 0 ? rest : 0n)).toString() })).filter((c) => c.credit !== '0')];
});
// Chứng từ lệch đúng một đồng ở một dòng bất kỳ.
export const arbUnbalancedLines: fc.Arbitrary<Line[]> = fc.tuple(arbBalancedLines, fc.nat()).map(([lines, k]) => {
  const i = k % lines.length;
  return lines.map((x, j): Line => j !== i ? x : x.debit !== undefined ? { ...x, debit: (BigInt(x.debit) + 1n).toString() } : { ...x, credit: (BigInt(x.credit!) + 1n).toString() });
});
