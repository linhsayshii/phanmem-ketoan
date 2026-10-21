import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { arbDate2026, arbFxOps, arbUsdRate, onlyPartyAccounts, openItemsByParty, PARTIES, runs, setupLedgerTenant, sumFromLines, timeoutFor, type RevalOp } from './helpers.js';

let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

type Cur = 'VND' | 'USD';
// doc: chứng từ một dòng công nợ (131 Nợ = hóa đơn bán, 131 Có = thu, 331 Có = hóa đơn mua, 331 Nợ = chi trả); plan: chứng từ ngược chiều với một khoản đang mở, kèm kế hoạch đối trừ.
type Op = { kind: 'doc'; acc: '131' | '331'; side: 'D' | 'C'; party: string; cur: Cur; units: number; rate: string; date: string }
  | { kind: 'plan'; pick: number; frac: number; extra: boolean; rate: string; date: string; autoPost: boolean }
  | { kind: 'post'; pick: number } | { kind: 'unpost'; pick: number } | { kind: 'reverse'; pick: number; date: string }
  | { kind: 'settle'; pick: number; frac: number; date: string | undefined }
  | { kind: 'unsettle'; pick: number } | { kind: 'auto'; acc: '131' | '331'; party: string | undefined; date: string }
  | RevalOp;
const arbArapOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 8, arbitrary: fc.record({ kind: fc.constant('doc' as const), acc: fc.constantFrom('131' as const, '331' as const), side: fc.constantFrom('D' as const, 'C' as const), party: fc.constantFrom(...PARTIES.slice(0, 2)),
    cur: fc.constantFrom('VND' as const, 'VND' as const, 'USD' as const), units: fc.integer({ min: 1, max: 20 }), rate: arbUsdRate, date: arbDate2026 }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('plan' as const), pick: fc.nat(), frac: fc.integer({ min: 1, max: 4 }), extra: fc.boolean(), rate: arbUsdRate, date: arbDate2026, autoPost: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('post' as const), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('unpost' as const), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('reverse' as const), pick: fc.nat(), date: arbDate2026 }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('settle' as const), pick: fc.nat(), frac: fc.integer({ min: 1, max: 4 }), date: fc.option(arbDate2026, { nil: undefined }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('unsettle' as const), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('auto' as const), acc: fc.constantFrom('131' as const, '331' as const), party: fc.option(fc.constantFrom(...PARTIES), { nil: undefined }), date: arbDate2026 }) },
  { weight: 3, arbitrary: arbFxOps });

// Kịch bản cố định chạy trước các chuỗi ngẫu nhiên (fc `examples`) để chắc chắn mọi loại thao tác từng thành công, kể cả loại hiếm khi sinh ngẫu nhiên: cần cặp khoản cùng đối tượng/tiền tệ ngược chiều (đối trừ), nhóm đối trừ (hủy), khoản USD còn dư (đánh giá lại).
const doc = (acc: '131' | '331', side: 'D' | 'C', cur: Cur, units: number, rate: string, date: string): Op => ({ kind: 'doc', acc, side, party: 'KH001', cur, units, rate, date });
const SCENARIO: Op[] = [
  doc('131', 'D', 'VND', 10, '25000', '2026-01-05'), doc('131', 'C', 'VND', 6, '25000', '2026-01-10'), // hóa đơn 10.000, thu 6.000
  doc('131', 'D', 'USD', 10, '25000', '2026-01-12'), doc('131', 'C', 'USD', 4, '25500', '2026-01-15'), // hóa đơn 10 USD, thu 4 USD
  { kind: 'settle', pick: 0, frac: 4, date: undefined }, // thu 6.000 đối trừ hóa đơn 10.000
  { kind: 'auto', acc: '131', party: 'KH001', date: '2026-02-28' }, // 4 USD đối trừ hóa đơn USD, có chênh lệch tỷ giá
  { kind: 'unsettle', pick: 0 }, // hủy đối trừ thủ công
  { kind: 'reval', date: '2026-03-31', rate: '25600' }, // 6 USD còn lại
  { kind: 'unpost', pick: 0 }, { kind: 'post', pick: 0 }, { kind: 'reverse', pick: 0, date: '2026-04-01' }, // bỏ ghi sổ, ghi sổ lại, đảo hóa đơn 10.000
  { kind: 'plan', pick: 0, frac: 2, extra: false, rate: '25000', date: '2026-04-05', autoPost: true }];

// Từ chối nghiệp vụ hợp lệ: chặn theo trạng thái chứng từ/khoản, đối trừ, đánh giá lại. SETTLEMENT_UNBALANCED và SETTLEMENT_KIND_INVALID là kiểm tra nội bộ của hàm SQL, không phải quy tắc nghiệp vụ: xuất hiện là lỗi.
const BUSINESS_CODE = /^(OPEN_ITEM_(PLANNED|REVALUED|SETTLED)|SETTLEMENT_(?!UNBALANCED$|KIND_INVALID$)[A-Z_]+|FX_REVALUATION_SETTLED(_AFTER)?|FX_RATE_MISSING|PERIOD_[A-Z_]+|UNPOST_PERIOD_NOT_OPEN|STATE_INVALID|VOUCHER_SYSTEM_GENERATED|VOUCHER_HASHED|REVERSE_DATE_BEFORE_ORIGINAL)$/;
const DONE_KINDS = ['doc', 'plan', 'post', 'unpost', 'reverse', 'settle', 'unsettle', 'auto', 'reval'] as const;
const done = new Map<string, number>(); // số thao tác thành công theo loại, qua mọi lần chạy: chuỗi ngẫu nhiên phải thực sự đối trừ, đảo, đánh giá lại

interface Item { id: number; acc: string; party: string; cur: string; vnd: bigint; qty: bigint; dt: string }
interface Doc { id: string; date: string; state: 'posted' | 'draft' | 'reversed' }
const L = (accountCode: string, debit: bigint, credit: bigint, more: object = {}) => ({ accountCode, debit: debit.toString(), credit: credit.toString(), ...more });
const sideOf = (i: Item): 'D' | 'C' => ((i.cur === 'VND' ? i.vnd : i.qty) > 0n ? 'D' : 'C');
const absOf = (i: Item) => { const v = i.cur === 'VND' ? i.vnd : i.qty; return v < 0n ? -v : v; };
const at = <T>(xs: T[], k: number): T | undefined => (xs.length ? xs[k % xs.length] : undefined);

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
      // Thành công đúng mã trạng thái thì true; từ chối nghiệp vụ hợp lệ (400/409 có mã trong BUSINESS_CODE) thì false; còn lại (5xx, 4xx lạ) làm hỏng thuộc tính.
      const ok = (op: Op, r: { statusCode: number; body: string; json: () => { error?: { code?: string } } }, status: number): boolean => {
        if (r.statusCode === status) return true;
        expect([400, 409].includes(r.statusCode) && BUSINESS_CODE.test(r.json().error?.code ?? ''), `${op.kind}: ${r.statusCode} ${r.body}`).toBe(true);
        return false;
      };
      const tally = (kind: string) => done.set(kind, (done.get(kind) ?? 0) + 1);
      const openItems = async (): Promise<Item[]> => (await sql<{ id: number; acc: string; party: string; cur: string; vnd: string; qty: string; dt: string }>`
        SELECT x.item_id::int AS id, a.code AS acc, p.code AS party, x.currency_code AS cur, x.residual::text AS vnd, x.residual_currency::text AS qty, o.line_posting_date::text AS dt
        FROM fn_open_items_at(${tenantId}::uuid, '2026-12-31') x JOIN open_item o ON o.id = x.item_id AND o.tenant_id = ${tenantId}::uuid
          JOIN account a ON a.id = x.account_id JOIN party p ON p.id = x.party_id
        WHERE o.parent_id IS NULL AND (x.residual <> 0 OR x.residual_currency <> 0) ORDER BY x.item_id`.execute(ctx.t.admin)).rows
        .map((r) => ({ ...r, vnd: BigInt(r.vnd), qty: BigInt(r.qty.split('.')[0]!) })).filter((i) => (i.cur === 'VND' ? i.vnd : i.qty) !== 0n);

      // Chứng từ một dòng công nợ + dòng đối ứng: 131 Nợ/Có 5113, thu Nợ tiền/Có 131, 331 Có/Nợ 6422, chi trả Nợ 331/Có tiền. VND = số lượng × tỷ giá chính xác (LINE_FX_MISMATCH).
      const docBody = (d: { acc: string; side: 'D' | 'C'; party: string; cur: Cur; amount: bigint; rate: string; date: string; settle?: object[]; autoPost: boolean }) => {
        const usd = d.cur === 'USD'; const vnd = usd ? d.amount * BigInt(d.rate) : d.amount; const q = (s: 1n | -1n) => (usd ? { amountCurrency: (d.amount * s).toString() } : {});
        const cash = usd ? '1122' : '1111'; const counter = d.acc === '131' ? (d.side === 'D' ? '5113' : cash) : d.side === 'C' ? '6422' : cash;
        const party = d.side === 'D' ? L(d.acc, vnd, 0n, { partyCode: d.party, ...q(1n), ...(d.settle && { settle: d.settle }) }) : L(d.acc, 0n, vnd, { partyCode: d.party, ...q(-1n), ...(d.settle && { settle: d.settle }) });
        const other = d.side === 'D' ? L(counter, 0n, vnd, q(-1n)) : L(counter, vnd, 0n, q(1n));
        const voucherType = usd ? 'PKT' : d.acc === '131' && d.side === 'C' ? 'PT' : d.acc === '331' && d.side === 'D' ? 'PC' : 'PKT';
        return { voucherType, postingDate: d.date, documentDate: d.date, description: 'inv5', autoPost: d.autoPost, partyCode: d.party, ...(usd && { currencyCode: 'USD', fxRate: d.rate }),
          lines: d.side === 'D' ? [party, other] : [other, party] };
      };
      const create = async (op: Op, body: ReturnType<typeof docBody>) => {
        const r = await call('POST', '/api/vouchers', body);
        if (!ok(op, r, 201)) return false;
        docs.push({ id: r.json().id, date: body.postingDate, state: body.autoPost ? 'posted' : 'draft' }); return true;
      };
      const ofState = (s: Doc['state']) => docs.filter((d) => d.state === s);

      for (const op of ops) {
        if (op.kind === 'doc') {
          if (await create(op, docBody({ ...op, amount: BigInt(op.units) * (op.cur === 'VND' ? 1000n : 1n), autoPost: true }))) tally('doc');
        } else if (op.kind === 'plan') {
          const item = at(await openItems(), op.pick); if (!item) continue;
          const usd = item.cur === 'USD'; const base = absOf(item); const part = base * BigInt(op.frac) / 4n || 1n; // phần đối trừ; extra: chứng từ lớn hơn phần đối trừ (phần dư thành khoản mở)
          const date = op.date > item.dt ? op.date : item.dt;
          const settle = [{ openItemId: item.id, ...(usd ? { amountCurrency: part.toString() } : { amount: part.toString() }) }];
          const amount = part + (op.extra ? (usd ? 1n : 1000n) : 0n);
          if (await create(op, docBody({ acc: item.acc as '131' | '331', side: sideOf(item) === 'D' ? 'C' : 'D', party: item.party, cur: item.cur as Cur, amount, rate: op.rate, date, settle, autoPost: op.autoPost }))) tally(op.autoPost ? 'plan' : 'planDraft');
        } else if (op.kind === 'post') {
          const d = at(ofState('draft'), op.pick); if (!d) continue;
          if (ok(op, await call('POST', `/api/vouchers/${d.id}/post`), 200)) { d.state = 'posted'; tally('post'); }
        } else if (op.kind === 'unpost') {
          const d = at(ofState('posted'), op.pick); if (!d) continue;
          if (ok(op, await call('POST', `/api/vouchers/${d.id}/unpost`), 200)) { d.state = 'draft'; tally('unpost'); }
        } else if (op.kind === 'reverse') {
          const d = at(ofState('posted'), op.pick); if (!d) continue;
          const date = op.date > d.date ? op.date : d.date;
          const r = await call('POST', `/api/vouchers/${d.id}/reverse`, { postingDate: date });
          if (ok(op, r, 201)) { d.state = 'reversed'; docs.push({ id: r.json().id, date, state: 'posted' }); tally('reverse'); }
        } else if (op.kind === 'settle') {
          const items = await openItems();
          const pairs = items.flatMap((d) => (sideOf(d) === 'D' ? items.filter((c) => sideOf(c) === 'C' && c.acc === d.acc && c.party === d.party && c.cur === d.cur).map((c) => [d, c] as const) : []));
          const pair = at(pairs, op.pick); if (!pair) continue;
          const [d, c] = pair; const m = absOf(d) < absOf(c) ? absOf(d) : absOf(c); const part = (m * BigInt(op.frac) / 4n || 1n).toString();
          const date = op.date && [op.date, d.dt, c.dt].sort().at(-1);
          const r = await call('POST', '/api/settlements', { debitItemId: d.id, creditItemId: c.id, [d.cur === 'VND' ? 'amount' : 'amountCurrency']: part, ...(date && { date }) });
          if (ok(op, r, 201)) tally('settle');
        } else if (op.kind === 'unsettle') {
          const groups = (await sql<{ g: string }>`SELECT group_id::text AS g FROM settlement WHERE tenant_id = ${tenantId}::uuid GROUP BY group_id ORDER BY min(id)`.execute(ctx.t.admin)).rows;
          const g = at(groups, op.pick); if (!g) continue;
          if (ok(op, await call('DELETE', `/api/settlements/groups/${g.g}`), 204)) tally('unsettle');
        } else if (op.kind === 'auto') {
          const r = await call('POST', '/api/settlements/auto', { accountCode: op.acc, date: op.date, ...(op.party && { partyCode: op.party }) });
          if (ok(op, r, 200) && r.json().groups > 0) tally('auto');
        } else {
          const r = await call('POST', '/api/fx/revaluation', { date: op.date, ...(op.rate && { rates: { USD: op.rate } }) });
          if (ok(op, r, 200) && r.json().voucherIds.length > 0) tally('reval');
        }
      }
      // Σ dư khoản công nợ (cả khoản con đánh giá lại) = số dư sổ cái 131, 331 của đối tượng, tại mọi ngày; không sai lệch dù sau đối trừ, hủy, đảo, đánh giá lại.
      for (const d of [...dates, '2026-12-31']) expect(await openItemsByParty(ctx, tenantId, d), d).toEqual(onlyPartyAccounts(await sumFromLines(ctx, tenantId, d)));
    }), { numRuns: runs(15), examples: [[SCENARIO, ['2026-01-31', '2026-03-31']]] });
    // kiểm tra trên không rỗng: các thao tác thực sự thành công, không chỉ bị từ chối
    for (const k of DONE_KINDS) expect(done.get(k) ?? 0, `thao tác ${k} chưa lần nào thành công`).toBeGreaterThan(0);
  }, timeoutFor(600_000));
});
