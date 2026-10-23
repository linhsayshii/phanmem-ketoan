import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { periodInterest } from '@kt/domain';
import { createTestApp, type TestApp } from '../helpers.js';
import { arbAssetChain, arbDate2026, runs, setupLedgerTenant, timeoutFor, type AssetOp } from './helpers.js';

let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

type Regime = 'TT133' | 'TT99';
type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const KINDS = ['depreciation', 'tool', 'prepaid'] as const;
const SLOTS = [{ code: 'F0', kind: 'fixed' }, { code: 'F1', kind: 'fixed' }, { code: 'T0', kind: 'tool' }, { code: 'P0', kind: 'prepaid' }] as const;
const KIND_OF_SLOT = [0, 0, 1, 2];
const assetAccount = (regime: Regime, slot: number) => slot === 0 ? (regime === 'TT99' ? '211' : '2111') : slot === 1 ? (regime === 'TT99' ? '212' : '2112') : '242';
const FIXED_ACCOUNTS = { TT133: ['2111', '2112', '2113'], TT99: ['211', '212', '213'] } as const;
const ACCUM_ACCOUNTS = ['2141', '2142', '2143'];
const periodEnd = (p: number) => `2026-${String(p).padStart(2, '0')}-${new Date(Date.UTC(2026, p, 0)).getUTCDate()}`;
const periodStart = (p: number) => `2026-${String(p).padStart(2, '0')}-01`;
// Lỗi nghiệp vụ (4xx) là từ chối hợp lệ; 5xx là lỗi hệ thống nên làm hỏng ngay.
const accepted = (r: Res) => { if (r.statusCode >= 500) throw new Error(`${r.statusCode} ${r.body}`); return r.statusCode < 300; };

async function world(regime: Regime, proration: 'day' | 'month') {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `A8${Date.now()}${n++}`, regime);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const must = async (r: Promise<Res>, code = 200) => { const x = await r; if (x.statusCode !== code) throw new Error(`${x.statusCode} ${x.body}`); return x.json(); };
  await must(call('PUT', '/api/settings', { fa_proration: proration }));
  const ids: (number | undefined)[] = [undefined, undefined, undefined, undefined];
  const bought: { slot: number; voucherId: string }[] = [];
  const done = new Map<string, number>();
  const hit = (k: string) => done.set(k, (done.get(k) ?? 0) + 1);
  const rows = async <T>(q: ReturnType<typeof sql<T>>) => (await q.execute(ctx.t.admin)).rows;
  const status = async (slot: number) => (await rows(sql<{ status: string }>`SELECT status FROM asset WHERE tenant_id = ${tenantId}::uuid AND id = ${ids[slot]!}`))[0]!.status;
  const eventCount = async (slot: number) => Number((await rows(sql<{ c: string }>`SELECT count(*)::text AS c FROM asset_event WHERE tenant_id = ${tenantId}::uuid AND asset_id = ${ids[slot]!}`))[0]!.c);
  const valuesAt = async (slot: number, date: string) => (await rows(sql<{ cost: string; accumulated: string }>`SELECT cost::text, accumulated::text FROM fn_asset_values_at(${tenantId}::uuid, ${date}::date) WHERE asset_id = ${ids[slot]!}`))[0]!;
  const canon = async () => JSON.stringify(await rows(sql`SELECT id, fn_voucher_canonical(id) AS c FROM voucher WHERE tenant_id = ${tenantId}::uuid ORDER BY id`));
  const runPeriod = (k: number, period: number) => call('POST', '/api/asset-runs', { kind: KINDS[k], fiscalYear: 2026, periodNo: period });
  const kindsPresent = () => KINDS.map((_, k) => k).filter((k) => ids.some((id, s) => id !== undefined && KIND_OF_SLOT[s] === k));

  // Chạy tuần tự kỳ 1..upTo của một loại; không kỳ nào được vướng khoảng trống vì chạy theo thứ tự.
  const settleKind = async (k: number, upTo = 12) => {
    const out: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let p = 1; p <= upTo; p++) { const r = await runPeriod(k, p); expect(r.statusCode, `${KINDS[k]} kỳ ${p}: ${r.body}`).toBe(200); out.push(r.json()); }
    return out;
  };
  const activeRunsUnique = async () => {
    const dup = await rows(sql`SELECT kind, period_no FROM period_run WHERE tenant_id = ${tenantId}::uuid AND status = 'active' GROUP BY kind, fiscal_year, period_no HAVING count(*) > 1`);
    expect(dup, 'mỗi (loại, kỳ) đúng một lần chạy hiệu lực').toEqual([]);
  };

  // (a) Σ nbv TSCĐ = dư 211x − dư 214x; Σ nbv CCDC/trả trước = Σ dòng 242 có asset_id, tính từ dòng sổ cái độc lập với fn_asset_values_at.
  const checkLedger = async (date: string) => {
    const fixedCodes = [...FIXED_ACCOUNTS[regime], ...ACCUM_ACCOUNTS];
    const lines = sql`FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.tenant_id = l.tenant_id JOIN account ac ON ac.id = l.account_id AND ac.tenant_id = l.tenant_id
      WHERE l.tenant_id = ${tenantId}::uuid AND l.posting_date <= ${date}::date AND v.state IN ('posted','reversed')`;
    const nbv = (kindIs: 'fixed' | 'other') => rows(sql<{ s: string }>`SELECT coalesce(sum(x.cost - x.accumulated), 0)::text AS s FROM fn_asset_values_at(${tenantId}::uuid, ${date}::date) x
      JOIN asset a ON a.id = x.asset_id AND a.tenant_id = ${tenantId}::uuid WHERE ${kindIs === 'fixed' ? sql`a.kind = 'fixed'` : sql`a.kind <> 'fixed'`}`).then((r) => r[0]!.s);
    const fixedLedger = (await rows(sql<{ s: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS s ${lines} AND ac.code IN (${sql.join(fixedCodes)})`))[0]!.s;
    const otherLedger = (await rows(sql<{ s: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS s ${lines} AND ac.code = '242' AND l.asset_id IS NOT NULL`))[0]!.s;
    expect(await nbv('fixed'), `nbv TSCĐ ${date}`).toBe(fixedLedger);
    expect(await nbv('other'), `nbv CCDC/trả trước ${date}`).toBe(otherLedger);
  };
  // (c) không tài sản nào có acc > cost hoặc nbv < 0; tài sản đã giảm có cost = acc = 0 từ ngày giảm.
  const checkBounds = async (date: string) => {
    for (const r of await rows(sql<{ code: string; cost: string; accumulated: string; status: string; decrease_date: string | null }>`SELECT a.code, x.cost::text, x.accumulated::text, a.status, a.decrease_date::text
      FROM fn_asset_values_at(${tenantId}::uuid, ${date}::date) x JOIN asset a ON a.id = x.asset_id AND a.tenant_id = ${tenantId}::uuid`)) {
      const cost = BigInt(r.cost); const acc = BigInt(r.accumulated);
      expect(acc <= cost && cost - acc >= 0n && cost >= 0n, `${r.code} ${date}: cost ${r.cost} acc ${r.accumulated}`).toBe(true);
      if (r.status === 'decreased' && r.decrease_date && r.decrease_date <= date) expect([r.cost, r.accumulated], `${r.code} đã giảm ${r.decrease_date}, tại ${date}`).toEqual(['0', '0']);
    }
  };

  const apply = async (op: AssetOp) => {
    const id = 'slot' in op ? ids[op.slot] : undefined;
    const s = 'slot' in op ? SLOTS[op.slot]! : undefined;
    // Biến động cần các kỳ trước đã chạy (quy ước 6): chạy lần lượt kỳ 1..tháng-1 của mọi loại đang có.
    if ('slot' in op && op.kind !== 'buy' && id !== undefined) for (const k of kindsPresent()) await settleKind(k, Number(op.date.slice(5, 7)) - 1);
    const pay = (extra: object) => ({ partyCode: 'NCC001', counterAccountCode: '331', ...extra });
    switch (op.kind) {
      case 'buy': {
        if (ids[op.slot] === undefined) {
          const fixed = s!.kind === 'fixed';
          const r = await call('POST', '/api/assets', { code: s!.code, name: s!.code, kind: s!.kind, assetAccountCode: assetAccount(regime, op.slot), ...(fixed ? { depreciationAccountCode: op.slot === 0 ? '2141' : '2142' } : {}),
            depreciationStartDate: op.date, lifeUnits: op.life, ...(s!.kind === 'tool' ? { quantity: '10' } : {}) });
          if (!accepted(r)) return;
          ids[op.slot] = r.json().id;
          await must(call('PUT', `/api/assets/${ids[op.slot]}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', ratio: '60' }, { expenseAccountCode: '6421', ratio: '40' }] }));
        }
        if (await status(op.slot) === 'decreased') return;
        const r = await call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: op.date, documentDate: op.date, description: 'mua tài sản', autoPost: true, lines: [
          { accountCode: assetAccount(regime, op.slot), debit: op.amount, credit: '0', assetCode: s!.code }, { accountCode: '331', debit: '0', credit: op.amount, partyCode: 'NCC001' }] });
        if (accepted(r)) { bought.push({ slot: op.slot, voucherId: r.json().id }); hit('buy'); }
        return;
      }
      case 'increase': {
        if (id === undefined || await status(op.slot) === 'decreased') return;
        const r = s!.kind === 'fixed' ? await call('POST', `/api/assets/${id}/increase`, pay({ date: op.date, reason: 'other', amount: op.amount }))
          : await call('POST', `/api/assets/${id}/adjust-value`, pay({ date: op.date, delta: op.amount }));
        if (accepted(r)) hit('increase');
        return;
      }
      case 'run': { if (accepted(await runPeriod(op.k, op.period))) hit('run'); return; }
      case 'rerun': {
        if (!kindsPresent().includes(op.k)) return;
        await settleKind(op.k, op.period);
        const first = await runPeriod(op.k, op.period); expect(first.statusCode, first.body).toBe(200);
        const before = await canon();
        const second = await runPeriod(op.k, op.period); expect(second.statusCode, second.body).toBe(200);
        expect(second.json().unchanged, `chạy lại ${KINDS[op.k]} kỳ ${op.period} lần hai phải không đổi`).toBe(true);
        expect(await canon(), 'sổ cái không đổi sau chạy lại không đổi').toBe(before);
        await activeRunsUnique(); hit('rerun');
        return;
      }
      case 'decrease': {
        if (id === undefined || await status(op.slot) === 'decreased') return;
        const r = s!.kind === 'fixed' ? await call('POST', `/api/assets/${id}/decrease`, { date: op.date, reason: 'liquidation', counterAccountCode: '811' })
          : await call('POST', `/api/assets/${id}/decrease-tool`, { date: op.date, counterAccountCode: '811', ...(op.partial ? { quantity: '3' } : {}) });
        if (accepted(r)) hit('decrease');
        return;
      }
      case 'cancel': {
        const evs = await rows(sql<{ id: string }>`SELECT id FROM asset_event WHERE tenant_id = ${tenantId}::uuid AND state = 'active' ORDER BY created_at DESC, id`);
        if (!evs.length) return;
        if (accepted(await call('POST', `/api/asset-events/${evs[op.pick % evs.length]!.id}/cancel`))) hit('cancel');
        return;
      }
      case 'revalue': {
        if (id === undefined || await status(op.slot) === 'decreased') return;
        const v = await valuesAt(op.slot, op.date);
        const newCost = BigInt(v.cost) + BigInt(op.add); const newAcc = (BigInt(v.accumulated) * BigInt(op.keepPct)) / 100n;
        if (accepted(await call('POST', `/api/assets/${id}/revalue`, { date: op.date, newCost: newCost.toString(), newAccumulated: newAcc.toString(), counterAccountCode: '811' }))) hit('revalue');
        return;
      }
      case 'suspend': { if (id !== undefined && accepted(await call('POST', `/api/assets/${id}/suspend`, { date: op.date, reason: 'tạm dừng' }))) hit('suspend'); return; }
      case 'resume': { if (id !== undefined && accepted(await call('POST', `/api/assets/${id}/resume`, { date: op.date }))) hit('resume'); return; }
      case 'life': { if (id !== undefined && accepted(await call('POST', `/api/assets/${id}/life`, { date: op.date, remainingUnits: String(op.remaining) }))) hit('life'); return; }
      case 'unpost': {
        const cands: typeof bought = [];
        for (const b of bought) if (await eventCount(b.slot) === 0) cands.push(b);
        if (!cands.length) return;
        const b = cands[op.pick % cands.length]!;
        if (accepted(await call('POST', `/api/vouchers/${b.voucherId}/unpost`))) { bought.splice(bought.indexOf(b), 1); hit('unpost'); }
        return;
      }
    }
  };

  // Cuối chuỗi: chạy đủ mọi kỳ theo thứ tự; lượt hai không đổi; kiểm (a), (b), (c) tại mọi cuối kỳ và ngày ngẫu nhiên.
  const finish = async (probes: string[]) => {
    for (const k of kindsPresent()) await settleKind(k);
    for (const k of kindsPresent()) for (const r of await settleKind(k)) expect(r.unchanged, `${KINDS[k]}: lượt chạy lại thứ hai phải không đổi`).toBe(true);
    await activeRunsUnique();
    for (const d of [...Array.from({ length: 12 }, (_, i) => periodEnd(i + 1)), ...probes]) { await checkLedger(d); await checkBounds(d); }
  };
  return { apply, finish, done, checkLedger, settleKind, kindsPresent, call, tenantId, rows, ids };
}

const arbRegime = fc.constantFrom('TT133' as const, 'TT99' as const);
const arbProration = fc.constantFrom('day' as const, 'month' as const);
// Chuỗi mẫu cố định: mỗi thao tác thành công ít nhất một lần, để bộ đếm `done` không phụ thuộc may rủi của bộ sinh.
const buy = (slot: number, date: string, amount: string, life: number): AssetOp => ({ kind: 'buy', slot, date, amount, life, probe: '2026-06-15' });
const FIXED_EXAMPLE: AssetOp[] = [
  buy(0, '2026-01-01', '120000000', 12), buy(2, '2026-01-01', '30000000', 6), buy(3, '2026-01-01', '24000000', 12),
  { kind: 'run', k: 0, period: 1, probe: '2026-01-31' }, { kind: 'run', k: 1, period: 1, probe: '2026-01-31' }, { kind: 'run', k: 2, period: 1, probe: '2026-01-31' },
  { kind: 'rerun', k: 0, period: 1, probe: '2026-01-31' },
  buy(0, '2026-01-15', '6000000', 12),
  { kind: 'rerun', k: 0, period: 2, probe: '2026-02-28' },
  { kind: 'increase', slot: 0, date: '2026-03-10', amount: '10000000', probe: '2026-03-31' },
  { kind: 'increase', slot: 2, date: '2026-03-10', amount: '1000000', probe: '2026-03-31' },
  { kind: 'revalue', slot: 0, date: '2026-04-30', add: 1000000, keepPct: 90, probe: '2026-04-30' },
  { kind: 'suspend', slot: 0, date: '2026-05-10', probe: '2026-05-31' }, { kind: 'resume', slot: 0, date: '2026-06-10', probe: '2026-06-30' },
  { kind: 'life', slot: 0, date: '2026-07-01', remaining: 8, probe: '2026-07-31' },
  { kind: 'decrease', slot: 2, date: '2026-04-10', partial: true, probe: '2026-04-30' },
  { kind: 'cancel', pick: 0, probe: '2026-04-30' },
  { kind: 'decrease', slot: 3, date: '2026-08-20', partial: false, probe: '2026-08-31' },
  { kind: 'decrease', slot: 0, date: '2026-09-16', partial: false, probe: '2026-09-30' },
  buy(1, '2026-02-10', '50000000', 24), { kind: 'unpost', pick: 0, probe: '2026-02-28' }];

describe('Bất biến 8: sổ tài sản và lãi vay', () => {
  it('(a)(b)(c) chuỗi thao tác ngẫu nhiên: nbv khớp sổ cái, chạy lại không đổi, không âm / không vượt', async () => {
    const total = new Map<string, number>();
    await fc.assert(fc.asyncProperty(arbRegime, arbProration, arbAssetChain, fc.array(arbDate2026, { minLength: 3, maxLength: 3 }), async (regime, proration, chain, probes) => {
      const w = await world(regime, proration);
      for (const op of chain) { await w.apply(op); await w.checkLedger(op.probe); }
      await w.finish(probes);
      for (const [k, c] of w.done) total.set(k, (total.get(k) ?? 0) + c);
    }), { numRuns: runs(8), examples: [['TT133', 'day', FIXED_EXAMPLE, ['2026-02-14', '2026-08-03', '2026-11-30']], ['TT99', 'month', FIXED_EXAMPLE, ['2026-01-01', '2026-05-17', '2026-12-31']]] });
    for (const k of ['buy', 'increase', 'run', 'rerun', 'decrease', 'cancel', 'revalue', 'suspend', 'resume', 'life', 'unpost']) expect(total.get(k) ?? 0, `thao tác ${k} chưa từng thành công`).toBeGreaterThan(0);
  }, timeoutFor(1_800_000));

  it('(d) tài sản không biến động chạy đủ đời: tổng khấu hao / phân bổ = nguyên giá, đúng từng đồng', async () => {
    const arbCard = fc.record({ startMonth: fc.integer({ min: 1, max: 8 }), day: fc.integer({ min: 1, max: 28 }), off: fc.nat(), amount: fc.integer({ min: 100_000, max: 500_000_000 }) });
    await fc.assert(fc.asyncProperty(arbRegime, arbProration, fc.uniqueArray(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 4 }), fc.array(arbCard, { minLength: 4, maxLength: 4 }), async (regime, proration, slots, cards) => {
      const w = await world(regime, proration);
      let sum = 0n;
      for (const slot of slots) {
        const c = cards[slot]!; const life = 2 + (c.off % (10 - c.startMonth)); // tháng bắt đầu + đời ≤ 11
        await w.apply({ kind: 'buy', slot, date: `2026-${String(c.startMonth).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`, amount: String(c.amount), life, probe: '2026-12-31' });
        expect(w.ids[slot], `tạo thẻ ${slot}`).toBeDefined(); sum += BigInt(c.amount);
      }
      for (const k of w.kindsPresent()) await w.settleKind(k);
      const exp = await w.rows(sql<{ s: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS s FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.tenant_id = l.tenant_id
        WHERE l.tenant_id = ${w.tenantId}::uuid AND v.source_doc_type = 'asset_run' AND v.state IN ('posted','reversed') AND l.asset_id IS NULL`);
      expect(exp[0]!.s, 'tổng chi phí khấu hao + phân bổ = tổng nguyên giá').toBe(sum.toString());
      for (const r of await w.rows(sql<{ code: string; cost: string; accumulated: string; kind: string }>`SELECT a.code, x.cost::text, x.accumulated::text, a.kind FROM fn_asset_values_at(${w.tenantId}::uuid, '2026-12-31'::date) x JOIN asset a ON a.id = x.asset_id AND a.tenant_id = ${w.tenantId}::uuid`)) {
        // TSCĐ: hao mòn = nguyên giá; CCDC/trả trước: số dư 242 về 0.
        if (r.kind === 'fixed') expect(r.accumulated, `${r.code} hao mòn cuối năm`).toBe(r.cost); else expect(r.cost, `${r.code} còn lại cuối năm`).toBe('0');
      }
    }), { numRuns: runs(10), examples: [['TT133', 'day', [0, 1, 2, 3], [{ startMonth: 1, day: 15, off: 3, amount: 100_000 }, { startMonth: 8, day: 28, off: 1, amount: 499_999_999 }, { startMonth: 3, day: 1, off: 7, amount: 1_000_003 }, { startMonth: 2, day: 31 - 3, off: 0, amount: 7 * 100_000 }]]] });
  }, timeoutFor(900_000));

  // it.fails: lỗi thật của engine vay (quyết định 506): repay không kiểm số dư tại ngày trả nên trả trước ngày giải ngân được nhận, LV kỳ sau trả 400. Bỏ .fails khi sửa lỗi.
  it.fails('(e) lãi vay: Σ LV mỗi kỳ = periodInterest tính độc lập từ dòng sổ cái', async () => {
    type LoanOp = { kind: 'disburse' | 'repay'; date: string; amount: number } | { kind: 'run'; period: number };
    const arbLoanOp: fc.Arbitrary<LoanOp> = fc.oneof(
      { weight: 4, arbitrary: fc.record({ kind: fc.constant('disburse' as const), date: arbDate2026, amount: fc.integer({ min: 1_000_000, max: 500_000_000 }) }) },
      { weight: 2, arbitrary: fc.record({ kind: fc.constant('repay' as const), date: arbDate2026, amount: fc.integer({ min: 1_000_000, max: 300_000_000 }) }) },
      { weight: 3, arbitrary: fc.record({ kind: fc.constant('run' as const), period: fc.integer({ min: 1, max: 12 }) }) });
    const arbRate2 = fc.record({ date: arbDate2026.filter((d) => d > '2026-01-01'), rate: fc.constantFrom('7.5', '11', '10.25') });
    let runsDone = 0;
    await fc.assert(fc.asyncProperty(arbRegime, fc.constantFrom(360 as const, 365 as const), arbRate2, fc.array(arbLoanOp, { minLength: 2, maxLength: 10 }), async (regime, dayBasis, rate2, ops) => {
      const { cookie, tenantId } = await setupLedgerTenant(ctx, `A8L${Date.now()}${n++}`, regime);
      const call = (method: 'GET' | 'POST', url: string, payload: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, payload });
      const must = async (r: Promise<Res>, code = 201) => { const x = await r; if (x.statusCode !== code) throw new Error(`${x.statusCode} ${x.body}`); return x.json(); };
      await must(call('POST', '/api/catalogs/bank', { code: 'VCB', name: 'Vietcombank' }));
      await must(call('POST', '/api/catalogs/bank_account', { bank_code: 'VCB', account_no: '0011001', gl_account_code: regime === 'TT99' ? '112' : '1121' }));
      const rates = [{ validFrom: '2026-01-01', annualRate: '9' }, { validFrom: rate2.date, annualRate: rate2.rate }];
      const loan = await must(call('POST', '/api/loans', { code: 'VAYA', name: 'Vay A', partyCode: 'NCC001', value: '2000000000', signedDate: '2026-01-01', dayBasis, rates,
        installments: [{ dueDate: '2026-12-31', principal: '2000000000' }] }));
      for (const op of ops) {
        const r = op.kind === 'run' ? await call('POST', '/api/loan-runs', { fiscalYear: 2026, periodNo: op.period })
          : await call('POST', `/api/loans/${loan.id}/${op.kind === 'disburse' ? 'disburse' : 'repay'}`, op.kind === 'disburse' ? { date: op.date, amount: String(op.amount), bankAccountNo: '0011001' } : { date: op.date, principal: String(op.amount), bankAccountNo: '0011001' });
        accepted(r);
      }
      for (let p = 1; p <= 12; p++) { const r = await call('POST', '/api/loan-runs', { fiscalYear: 2026, periodNo: p }); expect(r.statusCode, `LV kỳ ${p}: ${r.body}`).toBe(200); runsDone++; }
      const movement = (await sql<{ d: string; delta: string }>`SELECT l.posting_date::text AS d, sum(l.credit - l.debit)::text AS delta FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.tenant_id = l.tenant_id
        JOIN account a ON a.id = l.account_id AND a.tenant_id = l.tenant_id JOIN contract c ON c.id = l.contract_id AND c.tenant_id = l.tenant_id
        WHERE l.tenant_id = ${tenantId}::uuid AND a.code = '3411' AND c.code = 'VAYA' AND v.state IN ('posted','reversed') GROUP BY l.posting_date ORDER BY 1`.execute(ctx.t.admin)).rows;
      let bal = 0n; const balances = movement.map((m) => { bal += BigInt(m.delta); return { date: m.d, balance: bal.toString() }; });
      for (let p = 1; p <= 12; p++) {
        const expected = periodInterest({ from: periodStart(p), to: periodEnd(p), balances, rates, dayBasis, decimals: 0 });
        const got = (await sql<{ s: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS s FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.tenant_id = l.tenant_id JOIN account a ON a.id = l.account_id AND a.tenant_id = l.tenant_id
          WHERE l.tenant_id = ${tenantId}::uuid AND a.code = '635' AND v.source_doc_type = 'loan_interest' AND v.state IN ('posted','reversed') AND l.posting_date BETWEEN ${periodStart(p)}::date AND ${periodEnd(p)}::date`.execute(ctx.t.admin)).rows[0]!.s;
        expect(got, `lãi kỳ ${p}`).toBe(expected);
      }
    }), { numRuns: runs(10), examples: [['TT133', 360, { date: '2026-01-02', rate: '7.5' }, [{ kind: 'disburse', date: '2026-02-01', amount: 1_000_000 }, { kind: 'repay', date: '2026-01-01', amount: 1_000_000 }, { kind: 'run', period: 1 }, { kind: 'run', period: 1 }]],
      ['TT99', 365, { date: '2026-02-16', rate: '10.25' }, [{ kind: 'disburse', date: '2026-01-11', amount: 400_000_000 }, { kind: 'run', period: 1 }, { kind: 'disburse', date: '2026-01-25', amount: 100_000_000 }, { kind: 'repay', date: '2026-03-05', amount: 200_000_000 }]]] });
    expect(runsDone).toBeGreaterThan(0);
  }, timeoutFor(900_000));
});
