import fc from 'fast-check';
import { expect } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, type TestApp } from '../helpers.js';

export interface Line { accountCode: string; debit?: string; credit?: string; partyCode?: string }

// Số lần chạy mỗi thuộc tính fast-check: mặc định theo từng kiểm thử, đặt FC_RUNS để chạy nhiều hơn (soak thủ công); thời gian chờ nới theo.
// FC_RUNS phải là số nguyên dương: 0, âm, chữ hay số lẻ làm fast-check chạy 0 lần (kiểm thử xanh mà không kiểm gì) hoặc không dừng, nên báo lỗi ngay khi nạp tệp.
const FC_RUNS = ((raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`FC_RUNS phải là số nguyên dương (nhận được "${raw}"); bỏ biến này để dùng số lần mặc định`);
  return n;
})(process.env.FC_RUNS);
export const runs = (dflt: number): number => FC_RUNS ?? dflt;
export const timeoutFor = (dfltMs: number): number => (FC_RUNS !== undefined ? 30 * 60_000 : dfltMs);

// Tài khoản chi tiết tồn tại ở cả TT133 và TT99. 131 và 331 là tài khoản công nợ: dòng của chúng bắt buộc có đối tượng (chiều đối tượng của số dư).
export const PARTY_ACCOUNTS = ['131', '331'];
export const ACCOUNTS = ['1111', '1121', '5113', '6421', '6422', '242', '33311', '4111', ...PARTY_ACCOUNTS];
export const PARTIES = ['KH001', 'KH002', 'NCC001'];

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

// Số dư ròng (Nợ − Có) đến hết `asOf` theo (tài khoản, đối tượng, loại tiền), khóa `mã TK|mã đối tượng|tiền tệ`, cộng thẳng từ dòng chứng từ đã ghi sổ
// (không qua bảng số dư kỳ): nguồn đối chiếu độc lập. Dòng không có đối tượng có mã đối tượng rỗng.
export async function sumFromLines(ctx: TestApp, tenantId: string, asOf: string): Promise<Record<string, string>> {
  const r = await sql<{ code: string; party: string | null; cur: string; net: string }>`SELECT a.code, p.code AS party, l.currency_code AS cur, sum(l.debit - l.credit)::text AS net
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id LEFT JOIN party p ON p.id = l.party_id
    WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND l.posting_date <= ${asOf}::date GROUP BY a.code, p.code, l.currency_code HAVING sum(l.debit - l.credit) <> 0`.execute(ctx.t.admin);
  return Object.fromEntries(r.rows.map((x) => [`${x.code}|${x.party ?? ''}|${x.cur}`, x.net]));
}
// Cùng khóa và cùng số dư ròng, đọc qua API số dư tách theo đối tượng (đường nhanh khi đã tính lại, đường chậm khi còn bẩn).
export async function snapshot(ctx: TestApp, cookie: string, asOf: string): Promise<Record<string, string>> {
  const r = await ctx.app.inject({ method: 'GET', url: `/api/balances?asOf=${asOf}&byParty=true`, headers: { cookie } });
  expect(r.statusCode, r.body).toBe(200);
  return Object.fromEntries((r.json().rows as { accountCode: string; partyCode: string | null; currencyCode: string; debit: string; credit: string }[])
    .map((x) => [`${x.accountCode}|${x.partyCode ?? ''}|${x.currencyCode}`, (BigInt(x.debit) - BigInt(x.credit)).toString()]));
}
// Số dư ròng từng tài khoản (gộp đối tượng) đọc qua API số dư theo tài khoản, và cùng phép gộp từ bảng khóa ở trên.
export async function snapshotByAccount(ctx: TestApp, cookie: string, asOf: string): Promise<Record<string, string>> {
  const r = await ctx.app.inject({ method: 'GET', url: `/api/balances?asOf=${asOf}`, headers: { cookie } });
  expect(r.statusCode, r.body).toBe(200);
  return Object.fromEntries((r.json().rows as { accountCode: string; debit: string; credit: string }[]).map((x) => [x.accountCode, (BigInt(x.debit) - BigInt(x.credit)).toString()]));
}
export function byAccount(keyed: Record<string, string>): Record<string, string> {
  const m = new Map<string, bigint>();
  for (const [k, v] of Object.entries(keyed)) { const code = k.split('|')[0]!; m.set(code, (m.get(code) ?? 0n) + BigInt(v)); }
  return Object.fromEntries([...m].filter(([, v]) => v !== 0n).map(([k, v]) => [k, v.toString()]));
}
// Bất biến 5: Σ dư VND các khoản công nợ (kể cả khoản con của đánh giá lại) theo `mã TK|mã đối tượng` tại cuối ngày asOf, bỏ khóa có tổng 0.
export async function openItemsByParty(ctx: TestApp, tenantId: string, asOf: string): Promise<Record<string, string>> {
  const r = await sql<{ k: string; n: string }>`SELECT a.code || '|' || p.code AS k, sum(x.residual)::text AS n FROM fn_open_items_at(${tenantId}::uuid, ${asOf}::date) x
    JOIN account a ON a.id = x.account_id JOIN party p ON p.id = x.party_id GROUP BY 1 HAVING sum(x.residual) <> 0`.execute(ctx.t.admin);
  return Object.fromEntries(r.rows.map((x) => [x.k, x.n]));
}
// Từ kết quả sumFromLines (khóa `TK|đối tượng|tiền tệ`): giữ tài khoản công nợ (reconcile, PARTY_ACCOUNTS: các tài khoản duy nhất của bộ sinh có đối tượng), cộng gộp các loại tiền về `TK|đối tượng`, bỏ tổng 0.
export function onlyPartyAccounts(keyed: Record<string, string>): Record<string, string> {
  const m = new Map<string, bigint>();
  for (const [k, v] of Object.entries(keyed)) {
    const [code, party] = k.split('|') as [string, string];
    if (PARTY_ACCOUNTS.includes(code)) m.set(`${code}|${party}`, (m.get(`${code}|${party}`) ?? 0n) + BigInt(v));
  }
  return Object.fromEntries([...m].filter(([, v]) => v !== 0n).map(([k, v]) => [k, v.toString()]));
}
// Tỷ giá USD: một vài mức cố định để có cặp cùng tỷ giá, kèm hai mức lẻ tối đa 2 chữ số thập phân để chạy đường làm tròn (VND = làm tròn nguyên tệ × tỷ giá,
// trong dung sai 1 đồng của LINE_FX_MISMATCH).
export const arbUsdRate = fc.constantFrom('24000', '24500', '25000', '25500', '26000', '24750.5', '25123.25');
// Thao tác ngoại tệ: đánh giá lại ở cuối một tháng ngẫu nhiên của 2026, với tỷ giá nhập tay hoặc theo tỷ giá chuyển khoản trung bình đã khai báo.
export type RevalOp = { kind: 'reval'; date: string; rate: string | undefined };
export const arbFxOps: fc.Arbitrary<RevalOp> = fc.record({ kind: fc.constant('reval' as const), date: fc.integer({ min: 1, max: 12 }).map((m) => `2026-${String(m).padStart(2, '0')}-${new Date(Date.UTC(2026, m, 0)).getUTCDate()}`),
  rate: fc.option(arbUsdRate, { nil: undefined }) });
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
// Số tiền rất lớn: kiểm tra phép cộng chính xác của numeric(20,0), không bị làm tròn như số thực. Một dòng VND tối đa 10^16 − 1 đồng vì cột amount_currency
// (numeric(20,4)) cũng mang giá trị Nợ − Có của dòng VND; mỗi dòng Nợ ≤ (10^16 − 1) / 4 để tổng tối đa 4 dòng Nợ, dồn vào một dòng Có, vẫn nằm trong giới hạn đó.
export const MAX_LINE_VND = 10n ** 16n - 1n;
export const arbWideAmount = fc.bigInt({ min: 1n, max: MAX_LINE_VND / 4n }).map(String);
export const arbDate2026 = fc.record({ m: fc.integer({ min: 1, max: 12 }), d: fc.integer({ min: 1, max: 28 }) }).map(({ m, d }) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
// n dòng Nợ, m dòng Có, tổng Nợ = tổng Có (phần dư của phép chia đều dồn vào dòng Có đầu tiên); dòng 131/331 mang một đối tượng ngẫu nhiên.
const balancedLines = (amount: fc.Arbitrary<string>): fc.Arbitrary<Line[]> => fc.record({
  debits: fc.array(fc.record({ acc: fc.constantFrom(...ACCOUNTS), party: fc.constantFrom(...PARTIES), amt: amount }), { minLength: 1, maxLength: 4 }),
  credits: fc.array(fc.record({ acc: fc.constantFrom(...ACCOUNTS), party: fc.constantFrom(...PARTIES) }), { minLength: 1, maxLength: 4 }),
}).map(({ debits, credits }) => {
  const total = debits.reduce((s, d) => s + BigInt(d.amt), 0n); const each = total / BigInt(credits.length); const rest = total - each * BigInt(credits.length);
  const party = (acc: string, p: string) => (PARTY_ACCOUNTS.includes(acc) ? { partyCode: p } : {});
  return [...debits.map((d): Line => ({ accountCode: d.acc, debit: d.amt, ...party(d.acc, d.party) })),
    ...credits.map((c, i): Line => ({ accountCode: c.acc, credit: (each + (i === 0 ? rest : 0n)).toString(), ...party(c.acc, c.party) })).filter((c) => c.credit !== '0')];
});
// Chứng từ lệch đúng một đồng ở một dòng bất kỳ.
const unbalancedOf = (balanced: fc.Arbitrary<Line[]>): fc.Arbitrary<Line[]> => fc.tuple(balanced, fc.nat()).map(([lines, k]) => {
  const i = k % lines.length;
  return lines.map((x, j): Line => j !== i ? x : x.debit !== undefined ? { ...x, debit: (BigInt(x.debit) + 1n).toString() } : { ...x, credit: (BigInt(x.credit!) + 1n).toString() });
});
export const arbBalancedLines = balancedLines(arbAmount);
export const arbWideBalancedLines = balancedLines(arbWideAmount);
export const arbUnbalancedLines = unbalancedOf(arbBalancedLines);
export const arbWideUnbalancedLines = unbalancedOf(arbWideBalancedLines);
