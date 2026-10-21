import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { arbDate2026, arbFxOps, arbUsdRate, onlyPartyAccounts, openItemsByParty, postVoucher, runs, setupLedgerTenant, sumFromLines, timeoutFor, type RevalOp } from './helpers.js';

let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

type Cur = 'VND' | 'USD';
// doc: chứng từ một dòng công nợ (131 Nợ = hóa đơn bán, 131 Có = thu, 331 Có = hóa đơn mua, 331 Nợ = chi trả); plan: chứng từ ngược chiều với một khoản đang mở, kèm kế hoạch đối trừ.
// USD tính bằng xu (units đô + cents xu), VND bằng units nghìn đồng.
type Op = { kind: 'doc'; acc: '131' | '331'; side: 'D' | 'C'; party: string; cur: Cur; units: number; cents: number; rate: string; date: string }
  | { kind: 'plan'; pick: number; frac: number; extra: boolean; rate: string; date: string; autoPost: boolean }
  | { kind: 'post'; pick: number } | { kind: 'unpost'; pick: number } | { kind: 'reverse'; pick: number; date: string }
  | { kind: 'settle'; pick: number; frac: number; date: string | undefined }
  | { kind: 'unsettle'; pick: number } | { kind: 'auto'; acc: '131' | '331'; party: string | undefined; date: string }
  | RevalOp;
const arbArapOp: fc.Arbitrary<Op> = fc.oneof(
  // khóa (tài khoản, đối tượng, tiền tệ) hẹp và lệch (131 và KH001 nhiều hơn) để thường có cặp Nợ/Có cùng khóa cho đối trừ thủ công và tự động
  { weight: 10, arbitrary: fc.record({ kind: fc.constant('doc' as const), acc: fc.constantFrom('131' as const, '131' as const, '331' as const), side: fc.constantFrom('D' as const, 'C' as const), party: fc.constantFrom('KH001', 'KH001', 'KH002'),
    cur: fc.constantFrom('VND' as const, 'VND' as const, 'USD' as const), units: fc.integer({ min: 1, max: 20 }), cents: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 99 })), rate: arbUsdRate, date: arbDate2026 }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('plan' as const), pick: fc.nat(), frac: fc.integer({ min: 1, max: 4 }), extra: fc.boolean(), rate: arbUsdRate, date: arbDate2026, autoPost: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('post' as const), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('unpost' as const), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('reverse' as const), pick: fc.nat(), date: arbDate2026 }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('settle' as const), pick: fc.nat(), frac: fc.integer({ min: 1, max: 4 }), date: fc.option(arbDate2026, { nil: undefined }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('unsettle' as const), pick: fc.nat() }) },
  // đối trừ tự động chỉ ghép khoản có ngày chứng từ đến ngày chạy: nghiêng về cuối năm để thường có cặp để ghép
  { weight: 6, arbitrary: fc.record({ kind: fc.constant('auto' as const), acc: fc.constantFrom('131' as const, '131' as const, '331' as const), party: fc.option(fc.constantFrom('KH001', 'KH002'), { nil: undefined }),
    date: fc.oneof(arbDate2026, fc.constantFrom('2026-10-28', '2026-12-28')) }) },
  { weight: 3, arbitrary: arbFxOps });

// Kịch bản cố định chạy trước các chuỗi ngẫu nhiên (fc `examples`) để chắc chắn mọi loại thao tác từng thành công, kể cả loại hiếm khi sinh ngẫu nhiên: cần cặp khoản cùng đối tượng/tiền tệ ngược chiều (đối trừ), nhóm đối trừ (hủy), khoản USD còn dư (đánh giá lại), khoản đã đánh giá lại (đối trừ), nháp có kế hoạch (ghi sổ).
const doc = (acc: '131' | '331', side: 'D' | 'C', cur: Cur, units: number, rate: string, date: string, cents = 0): Op => ({ kind: 'doc', acc, side, party: 'KH001', cur, units, cents, rate, date });
const SCENARIO: Op[] = [
  doc('131', 'D', 'VND', 10, '25000', '2026-01-05'), doc('131', 'C', 'VND', 6, '25000', '2026-01-10'), // hóa đơn 10.000, thu 6.000
  doc('131', 'D', 'USD', 10, '25000', '2026-01-12', 50), doc('131', 'C', 'USD', 4, '25500', '2026-01-15'), // hóa đơn 10,50 USD, thu 4 USD
  { kind: 'settle', pick: 0, frac: 4, date: undefined }, // thu 6.000 đối trừ hóa đơn 10.000
  { kind: 'auto', acc: '131', party: 'KH001', date: '2026-02-28' }, // 4 USD đối trừ hóa đơn USD, có chênh lệch tỷ giá
  { kind: 'unsettle', pick: 0 }, // hủy đối trừ thủ công
  { kind: 'reval', date: '2026-03-31', rate: '25600.5' }, // 6,50 USD còn lại
  { kind: 'unpost', pick: 0 }, { kind: 'post', pick: 0 }, { kind: 'reverse', pick: 0, date: '2026-04-01' }, // bỏ ghi sổ, ghi sổ lại, đảo hóa đơn 10.000
  doc('131', 'C', 'USD', 6, '25500', '2026-04-10', 50), { kind: 'settle', pick: 0, frac: 4, date: undefined }, // thu 6,50 USD đối trừ khoản đã đánh giá lại
  { kind: 'plan', pick: 0, frac: 2, extra: false, rate: '25000', date: '2026-04-20', autoPost: false }, { kind: 'post', pick: 0 }, // nháp có kế hoạch đối trừ nửa khoản thu 6.000, rồi ghi sổ
  { kind: 'plan', pick: 0, frac: 4, extra: false, rate: '25000', date: '2026-04-25', autoPost: true }]; // ghi sổ ngay, đối trừ nốt phần còn lại

// Từ chối nghiệp vụ hợp lệ theo từng loại thao tác: chỉ mã mà thao tác đó có thể gặp khi chuỗi chỉ gửi yêu cầu đúng dạng, không khóa kỳ, không chạm chứng từ hệ thống.
// Mã nằm ngoài danh sách của thao tác (kể cả mã hợp lệ của thao tác khác) làm hỏng thuộc tính: có thể che một lỗi thật.
const NEVER = /(?!)/;
const ACCEPT: Record<Op['kind'], RegExp> = {
  doc: NEVER, // chứng từ không kế hoạch đối trừ, kỳ luôn mở
  plan: NEVER, // ngày đã kẹp theo khoản và khoản con, phần đối trừ không quá dư hiện tại
  post: /^SETTLEMENT_(EXCEEDS_RESIDUAL|DATE_BEFORE_POSTING)$/, // nháp ghi sổ sau: khoản được chọn đã bị đối trừ bớt hoặc đã có khoản con đánh giá lại muộn hơn ngày chứng từ
  unpost: /^(OPEN_ITEM_(SETTLED|PLANNED|REVALUED)|STATE_INVALID)$/, // chứng từ đã đối trừ, được nháp chọn, đã đánh giá lại; chứng từ đảo không bỏ ghi sổ được
  reverse: /^OPEN_ITEM_(SETTLED|PLANNED)$/,
  settle: NEVER, // cặp chọn từ dư hiện tại, số tiền không quá dư, ngày đã kẹp theo khoản con
  unsettle: /^SETTLEMENT_REVERSAL_LOCKED$/, // nhóm do đảo chứng từ sinh ra
  auto: NEVER,
  reval: /^FX_REVALUATION_SETTLED(_AFTER)?$/, // khoản con đã đối trừ; khoản gốc đã đối trừ sau ngày đánh giá lại. Luôn có tỷ giá danh mục từ 2026-01-01 nên không FX_RATE_MISSING
};
const DONE_KINDS = ['doc', 'plan', 'planDraft', 'post', 'unpost', 'reverse', 'settle', 'settleReval', 'unsettle', 'auto', 'reval'] as const;
// số thao tác thành công theo loại: tách ví dụ cố định khỏi chuỗi ngẫu nhiên để chuỗi ngẫu nhiên không dựa vào kịch bản cố định
const done = { example: new Map<string, number>(), random: new Map<string, number>() };

interface Item { id: number; acc: string; party: string; cur: string; vnd: bigint; qty: bigint; dt: string; cdt: string | undefined }
interface Doc { id: string; date: string; state: 'posted' | 'draft' | 'reversed' }
const L = (accountCode: string, debit: bigint, credit: bigint, more: object = {}) => ({ accountCode, debit: debit.toString(), credit: credit.toString(), ...more });
// Nguyên tệ tính bằng xu (bigint), tỷ giá tối đa 2 chữ số thập phân: tiền không đi qua `number`.
const absB = (v: bigint) => (v < 0n ? -v : v);
const fmtCents = (c: bigint) => `${c < 0n ? '-' : ''}${absB(c) / 100n}.${String(absB(c) % 100n).padStart(2, '0')}`;
const rate100 = (r: string) => { const [i, f = ''] = r.split('.'); return BigInt(i! + f.padEnd(2, '0')); };
const vndOf = (cents: bigint, rate: string) => (cents * rate100(rate) + 5000n) / 10000n; // làm tròn nửa lên như round() của PostgreSQL
// numeric(20,4) dạng chuỗi -> xu; dư dưới 1 xu là bất ngờ (mọi số lượng của kiểm thử là bội của 1 xu): báo lỗi thay vì cắt im lặng.
const cents4 = (s: string): bigint => {
  const [i, f = ''] = s.replace('-', '').split('.'); const frac = f.padEnd(4, '0');
  if (frac.slice(2) !== '00') throw new Error(`nguyên tệ lẻ dưới 1 xu: ${s}`);
  const v = BigInt(i!) * 100n + BigInt(frac.slice(0, 2)); return s.startsWith('-') ? -v : v;
};
const sideOf = (i: Item): 'D' | 'C' => ((i.cur === 'VND' ? i.vnd : i.qty) > 0n ? 'D' : 'C');
const absOf = (i: Item) => absB(i.cur === 'VND' ? i.vnd : i.qty);
const at = <T>(xs: T[], k: number): T | undefined => (xs.length ? xs[k % xs.length] : undefined);
const latest = (...ds: (string | undefined)[]) => ds.filter(Boolean).sort().at(-1); // ngày ISO so sánh theo chuỗi
const dayBefore = (d: string) => new Date(Date.parse(d) - 86_400_000).toISOString().slice(0, 10);

async function newTenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `I5${Date.now()}${n++}`);
  const r = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/exchange_rate', headers: { cookie }, payload: { currency_code: 'USD', rate_date: '2026-01-01', rate_type: 'transfer_avg', rate: '25000' } });
  expect(r.statusCode, r.body).toBe(201);
  return { cookie, tenantId };
}

describe('Bất biến 5: công nợ theo chứng từ khớp sổ cái theo đối tượng', () => {
  it('chuỗi ngẫu nhiên ghi sổ/đảo/bỏ ghi sổ/đối trừ/hủy đối trừ/đối trừ tự động/đánh giá lại: Σ dư open_item = số dư 131, 331 theo đối tượng tại mọi ngày', async () => {
    await fc.assert(fc.asyncProperty(fc.array(arbArapOp, { minLength: 5, maxLength: 25 }), fc.array(arbDate2026, { minLength: 3, maxLength: 6 }), async (ops, dates) => {
      const { cookie, tenantId } = await newTenant(); // mỗi lần chạy một công ty riêng
      const docs: Doc[] = [];
      const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
      // Thành công đúng mã trạng thái thì true; từ chối nghiệp vụ hợp lệ (400/409 có mã trong ACCEPT của đúng loại thao tác) thì false; còn lại (5xx, 4xx lạ) làm hỏng thuộc tính.
      const ok = (op: Op, r: { statusCode: number; body: string; json: () => { error?: { code?: string } } }, status: number): boolean => {
        if (r.statusCode === status) return true;
        expect([400, 409].includes(r.statusCode) && ACCEPT[op.kind].test(r.json().error?.code ?? ''), `${op.kind}: ${r.statusCode} ${r.body}`).toBe(true);
        return false;
      };
      const bucket = ops === SCENARIO ? done.example : done.random;
      const tally = (kind: string) => bucket.set(kind, (bucket.get(kind) ?? 0) + 1);
      const openItems = async (): Promise<Item[]> => (await sql<{ id: number; acc: string; party: string; cur: string; vnd: string; qty: string; dt: string; cdt: string | null }>`
        SELECT x.item_id::int AS id, a.code AS acc, p.code AS party, x.currency_code AS cur, x.residual::text AS vnd, x.residual_currency::text AS qty, o.line_posting_date::text AS dt,
          (SELECT max(c.line_posting_date)::text FROM open_item c WHERE c.tenant_id = o.tenant_id AND c.parent_id = o.id) AS cdt
        FROM fn_open_items_at(${tenantId}::uuid, '2026-12-31') x JOIN open_item o ON o.id = x.item_id AND o.tenant_id = ${tenantId}::uuid
          JOIN account a ON a.id = x.account_id JOIN party p ON p.id = x.party_id
        WHERE o.parent_id IS NULL AND (x.residual <> 0 OR x.residual_currency <> 0) ORDER BY x.item_id`.execute(ctx.t.admin)).rows
        .map((r) => ({ ...r, vnd: BigInt(r.vnd), qty: cents4(r.qty), cdt: r.cdt ?? undefined })).filter((i) => (i.cur === 'VND' ? i.vnd : i.qty) !== 0n);
      // Ngày ghi sổ muộn nhất của mọi khoản con (điều chỉnh đánh giá lại) của công ty: đối trừ tự động không được sớm hơn (guard so với ngày của khoản con; giới hạn T13-M10).
      const lastChild = async () => (await sql<{ d: string | null }>`SELECT max(line_posting_date)::text AS d FROM open_item WHERE tenant_id = ${tenantId}::uuid AND parent_id IS NOT NULL`.execute(ctx.t.admin)).rows[0]!.d ?? undefined;

      // Chứng từ một dòng công nợ + dòng đối ứng: 131 Nợ/Có 5113, thu Nợ tiền/Có 131, 331 Có/Nợ 6422, chi trả Nợ 331/Có tiền. `amount`: VND là đồng, USD là xu; VND dòng USD = làm tròn(nguyên tệ × tỷ giá).
      const docParts = (d: { acc: string; side: 'D' | 'C'; party: string; cur: Cur; amount: bigint; rate: string; date: string; settle?: object[]; autoPost: boolean }) => {
        const usd = d.cur === 'USD'; const vnd = usd ? vndOf(d.amount, d.rate) : d.amount; const q = (s: 1n | -1n) => (usd ? { amountCurrency: fmtCents(d.amount * s) } : {});
        const cash = usd ? '1122' : '1111'; const counter = d.acc === '131' ? (d.side === 'D' ? '5113' : cash) : d.side === 'C' ? '6422' : cash;
        const party = d.side === 'D' ? L(d.acc, vnd, 0n, { partyCode: d.party, ...q(1n), ...(d.settle && { settle: d.settle }) }) : L(d.acc, 0n, vnd, { partyCode: d.party, ...q(-1n), ...(d.settle && { settle: d.settle }) });
        const other = d.side === 'D' ? L(counter, 0n, vnd, q(-1n)) : L(counter, vnd, 0n, q(1n));
        const voucherType = usd ? 'PKT' : d.acc === '131' && d.side === 'C' ? 'PT' : d.acc === '331' && d.side === 'D' ? 'PC' : 'PKT';
        return { date: d.date, lines: d.side === 'D' ? [party, other] : [other, party],
          extra: { voucherType, description: 'inv5', autoPost: d.autoPost, partyCode: d.party, ...(usd && { currencyCode: 'USD', fxRate: d.rate }) } };
      };
      const create = async (op: Op, p: ReturnType<typeof docParts>) => {
        const r = await postVoucher(ctx, cookie, p.date, p.lines, p.extra);
        if (!ok(op, r, 201)) return false;
        docs.push({ id: r.json().id, date: p.date, state: p.extra.autoPost ? 'posted' : 'draft' }); return true;
      };
      const ofState = (s: Doc['state']) => docs.filter((d) => d.state === s);

      for (const op of ops) {
        if (op.kind === 'doc') {
          const amount = op.cur === 'VND' ? BigInt(op.units) * 1000n : BigInt(op.units) * 100n + BigInt(op.cents);
          if (await create(op, docParts({ ...op, amount, autoPost: true }))) tally('doc');
        } else if (op.kind === 'plan') {
          const item = at(await openItems(), op.pick); if (!item) continue;
          const usd = item.cur === 'USD'; const base = absOf(item); const part = base * BigInt(op.frac) / 4n || 1n; // phần đối trừ; extra: chứng từ lớn hơn phần đối trừ (phần dư thành khoản mở)
          const date = latest(op.date, item.dt, item.cdt)!;
          const settle = [{ openItemId: item.id, ...(usd ? { amountCurrency: fmtCents(part) } : { amount: part.toString() }) }];
          const amount = part + (op.extra ? (usd ? 100n : 1000n) : 0n);
          if (await create(op, docParts({ acc: item.acc, side: sideOf(item) === 'D' ? 'C' : 'D', party: item.party, cur: item.cur as Cur, amount, rate: op.rate, date, settle, autoPost: op.autoPost }))) {
            tally(op.autoPost ? 'plan' : 'planDraft'); if (op.autoPost && item.cdt) tally('settleReval');
          }
        } else if (op.kind === 'post') {
          const d = at(ofState('draft'), op.pick); if (!d) continue;
          if (ok(op, await call('POST', `/api/vouchers/${d.id}/post`), 200)) { d.state = 'posted'; tally('post'); }
        } else if (op.kind === 'unpost') {
          const d = at(ofState('posted'), op.pick); if (!d) continue;
          if (ok(op, await call('POST', `/api/vouchers/${d.id}/unpost`), 200)) { d.state = 'draft'; tally('unpost'); }
        } else if (op.kind === 'reverse') {
          const d = at(ofState('posted'), op.pick); if (!d) continue;
          const date = latest(op.date, d.date)!;
          const r = await call('POST', `/api/vouchers/${d.id}/reverse`, { postingDate: date });
          if (ok(op, r, 201)) { d.state = 'reversed'; docs.push({ id: r.json().id, date, state: 'posted' }); tally('reverse'); }
        } else if (op.kind === 'settle') {
          const items = await openItems();
          const pairs = items.flatMap((d) => (sideOf(d) === 'D' ? items.filter((c) => sideOf(c) === 'C' && c.acc === d.acc && c.party === d.party && c.cur === d.cur).map((c) => [d, c] as const) : []));
          const pair = at(pairs, op.pick); if (!pair) continue;
          const [d, c] = pair; const m = absOf(d) < absOf(c) ? absOf(d) : absOf(c); const part = m * BigInt(op.frac) / 4n || 1n;
          const lo = latest(op.date, d.dt, c.dt, d.cdt, c.cdt)!; const date = op.date || d.cdt || c.cdt ? lo : undefined; // khoản đã đánh giá lại: luôn gửi ngày không sớm hơn khoản con
          const r = await call('POST', '/api/settlements', { debitItemId: d.id, creditItemId: c.id, ...(d.cur === 'VND' ? { amount: part.toString() } : { amountCurrency: fmtCents(part) }), ...(date && { date }) });
          if (ok(op, r, 201)) { tally('settle'); if (d.cdt || c.cdt) tally('settleReval'); }
        } else if (op.kind === 'unsettle') {
          const groups = (await sql<{ g: string }>`SELECT group_id::text AS g FROM settlement WHERE tenant_id = ${tenantId}::uuid GROUP BY group_id ORDER BY min(id)`.execute(ctx.t.admin)).rows;
          const g = at(groups, op.pick); if (!g) continue;
          if (ok(op, await call('DELETE', `/api/settlements/groups/${g.g}`), 204)) tally('unsettle');
        } else if (op.kind === 'auto') {
          const r = await call('POST', '/api/settlements/auto', { accountCode: op.acc, date: latest(op.date, await lastChild())!, ...(op.party && { partyCode: op.party }) });
          if (ok(op, r, 200) && r.json().groups > 0) tally('auto');
        } else {
          const r = await call('POST', '/api/fx/revaluation', { date: op.date, ...(op.rate && { rates: { USD: op.rate } }) });
          if (ok(op, r, 200) && r.json().voucherIds.length > 0) tally('reval');
        }
      }
      // Σ dư khoản công nợ (cả khoản con đánh giá lại) = số dư sổ cái 131, 331 của đối tượng, tại mọi ngày; không sai lệch dù sau đối trừ, hủy, đảo, đánh giá lại.
      // Thêm mọi ngày đánh giá lại của chuỗi và ngày liền trước: ranh giới ngày khoản con bắt đầu có hiệu lực (ngày ngẫu nhiên 1..28 không bao giờ trùng cuối tháng).
      const revalDates = ops.filter((o): o is RevalOp => o.kind === 'reval').flatMap((o) => [o.date, dayBefore(o.date)]);
      for (const d of new Set([...dates, '2026-12-31', ...revalDates])) expect(await openItemsByParty(ctx, tenantId, d), d).toEqual(onlyPartyAccounts(await sumFromLines(ctx, tenantId, d)));
    }), { numRuns: runs(15), examples: [[SCENARIO, ['2026-01-31', '2026-03-31']]] });
    if (process.env.INV_STATS) console.log('INV_STATS', JSON.stringify({ example: [...done.example], random: [...done.random] }));
    // kiểm tra không rỗng: kịch bản cố định phải đi qua mọi loại thao tác. Chuỗi ngẫu nhiên tự đạt các loại thao tác phổ biến từ 100 lần chạy trở lên, loại hiếm (đối trừ tự động, hủy đối trừ) từ 300 lần:
    // ít lần chạy hơn thì không khẳng định để khỏi chập chờn. Đối trừ khoản đã đánh giá lại (settleReval) chỉ do kịch bản bảo đảm (khoảng 2 lần mỗi 100 chuỗi).
    for (const k of DONE_KINDS) expect(done.example.get(k) ?? 0, `kịch bản cố định: thao tác ${k} chưa lần nào thành công`).toBeGreaterThan(0);
    const rare = ['auto', 'unsettle', 'settleReval'];
    const random = DONE_KINDS.filter((k) => (rare.includes(k) ? k !== 'settleReval' && runs(15) >= 300 : runs(15) >= 100));
    for (const k of random) expect(done.random.get(k) ?? 0, `chuỗi ngẫu nhiên: thao tác ${k} chưa lần nào thành công`).toBeGreaterThan(0);
  }, timeoutFor(600_000));
});
