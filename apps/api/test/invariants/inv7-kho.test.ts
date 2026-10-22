import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from '../helpers.js';
import { arbStockOps, runs, STOCK_METHODS, timeoutFor, type StockOp, type StockMethod } from './helpers.js';

let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

// Từ chối nghiệp vụ hợp lệ của chuỗi thao tác: chỉ mã tồn kho (âm, đã bị tiêu thụ...) khi cấm xuất âm; mã khác làm hỏng thuộc tính.
const ACCEPT = /^(STOCK_[A-Z_]+|OPEN_ITEM_[A-Z_]+)$/;
// Số thao tác thành công theo loại (qua mọi lần chạy): chuỗi ngẫu nhiên phải thật sự lắp ráp, chuyển kho, đảo, ghi lùi, tạo GV.
const done = new Map<string, number>();
const bump = (k: string) => done.set(k, (done.get(k) ?? 0) + 1);

// Một công ty mỗi lần chạy: năm 2026 TT133, hai kho K1, K2 cùng phương pháp giá vốn, hàng H1, H2 (TK 156), bộ S (TK 155).
async function tenant(method: StockMethod, allowNeg: boolean) {
  const { cookie, tenantId } = await bootstrapTenant(ctx, { code: `I7${Date.now()}${n++}` });
  const call = (m: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => ctx.app.inject({ method: m, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const must = async (m: 'POST' | 'PUT', url: string, payload: object, code = 201) => { const r = await call(m, url, payload); expect(r.statusCode, `${url}: ${r.body}`).toBe(code); return r; };
  await must('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  await must('POST', '/api/catalogs/party', { code: 'NCC1', name: 'Nhà cung cấp một', is_vendor: true });
  for (const k of ['K1', 'K2']) await must('POST', '/api/catalogs/warehouse', { code: k, name: `Kho ${k}`, costing_method: method });
  for (const [code, acc] of [['H1', '156'], ['H2', '156'], ['S', '155']] as const)
    await must('POST', '/api/catalogs/item', { code, name: `Hàng ${code}`, base_uom_code: 'CAI', kind: 'goods', tracking: 'none', inventory_account_code: acc });
  if (allowNeg) await must('PUT', '/api/settings', { stock_negative: 'allow' }, 200);
  return { tenantId, call, must };
}
type T = Awaited<ReturnType<typeof tenant>>;

// Sổ kho và sổ cái theo (hàng, kho): lớp giá, phát sinh, dòng sổ cái TK kho có kho. Trả các nhóm lệch bất biến (a), (b); (a) cũng kiểm gộp theo (TK kho, kho).
// Sau chạy giá vốn đến `to` chỉ cặp (hàng, kho) có phát sinh và không còn phát sinh sau `to` mới được tính hết; cặp khác giữ lớp giá chưa trừ, nên (a), (b) kiểm trên cặp đủ điều kiện.
async function stockDrift(t: T, to = '2026-12-31') {
  const rows = (await sql<{ item: string; wh: string; acc: string; lq: string; lv: string; mq: string; gl: string }>`SELECT i.code AS item, w.code AS wh, a.code AS acc,
      (SELECT coalesce(sum(c.remaining_qty), 0) FROM stock_cost_layer c WHERE c.tenant_id = i.tenant_id AND c.item_id = i.id AND c.warehouse_id = w.id)::text AS lq,
      (SELECT coalesce(sum(c.remaining_value), 0) FROM stock_cost_layer c WHERE c.tenant_id = i.tenant_id AND c.item_id = i.id AND c.warehouse_id = w.id)::text AS lv,
      (SELECT coalesce(sum(CASE m.direction WHEN 'in' THEN m.quantity ELSE -m.quantity END), 0) FROM stock_move m WHERE m.tenant_id = i.tenant_id AND m.item_id = i.id AND m.warehouse_id = w.id)::text AS mq,
      (SELECT coalesce(sum(l.debit - l.credit), 0) FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account la ON la.id = l.account_id
        WHERE l.tenant_id = i.tenant_id AND l.item_id = i.id AND l.warehouse_id = w.id AND la.code IN ('152', '153', '155', '156', '157') AND v.state IN ('posted','reversed'))::text AS gl
    FROM item i CROSS JOIN warehouse w JOIN account a ON a.id = i.inventory_account_id WHERE i.tenant_id = ${t.tenantId}::uuid AND w.tenant_id = i.tenant_id ORDER BY 1, 2`.execute(ctx.t.admin)).rows;
  const touched = new Set((await sql<{ k: string }>`SELECT DISTINCT i.code || '|' || w.code AS k FROM stock_move m JOIN item i ON i.id = m.item_id JOIN warehouse w ON w.id = m.warehouse_id
    WHERE m.tenant_id = ${t.tenantId}::uuid
      AND NOT EXISTS (SELECT 1 FROM stock_move x WHERE x.tenant_id = m.tenant_id AND x.item_id = m.item_id AND x.warehouse_id = m.warehouse_id AND x.posting_date > ${to}::date)`.execute(ctx.t.admin)).rows.map((r) => r.k));
  const bad: unknown[] = [];
  const byAcc = new Map<string, { lv: bigint; gl: bigint }>();
  for (const r of rows.filter((x) => touched.has(`${x.item}|${x.wh}`))) {
    if (BigInt(r.lv) !== BigInt(r.gl)) bad.push({ a: 'giá trị lớp ≠ sổ cái', ...r });
    if (Number(r.lq) !== Number(r.mq)) bad.push({ b: 'tồn lớp ≠ nhập − xuất', ...r });
    const k = `${r.acc}|${r.wh}`; const g = byAcc.get(k) ?? { lv: 0n, gl: 0n }; byAcc.set(k, { lv: g.lv + BigInt(r.lv), gl: g.gl + BigInt(r.gl) });
  }
  for (const [k, g] of byAcc) if (g.lv !== g.gl) bad.push({ a: 'theo (TK kho, kho)', k, ...g });
  return { bad, rows };
}
// (c) băm chuẩn của mọi chứng từ không phải GV.
const canon = async (t: T) => (await sql<{ id: string; c: string }>`SELECT id, fn_voucher_canonical(id) AS c FROM voucher WHERE tenant_id = ${t.tenantId}::uuid AND voucher_type <> 'GV' ORDER BY id`.execute(ctx.t.admin)).rows;

type Posted = { id: string; kind: 'in' | 'out' | 'ck' | 'lr'; date: string; reversed: boolean };
const stockBody = (op: Exclude<StockOp, { kind: 'run' | 'reverse' | 'lr' }>, method: StockMethod) => {
  const lot = method === 'specific' ? { lotNo: op.lot } : {};
  switch (op.kind) {
    case 'in': return { voucherType: 'PNK', stockKind: 'purchase', postingDate: op.date, warehouseCode: op.wh, partyCode: 'NCC1', items: [{ itemCode: op.item, uomCode: 'CAI', quantity: String(op.qty), unitPrice: op.price, ...lot }] };
    case 'out': return { voucherType: 'PXK', stockKind: 'sale', postingDate: op.date, warehouseCode: op.wh, items: [{ itemCode: op.item, uomCode: 'CAI', quantity: String(op.qty), ...lot }] };
    case 'ck': return { voucherType: 'CK', stockKind: 'transfer', postingDate: op.date, warehouseCode: op.wh, destWarehouseCode: op.wh === 'K1' ? 'K2' : 'K1', items: [{ itemCode: op.item, uomCode: 'CAI', quantity: String(op.qty), ...lot }] };
  }
};

// Chạy giá vốn [01/01, to]: băm sổ cái không đổi, sổ kho khớp sổ cái, chạy lại lần hai không đổi (d). Lần chạy trả kết quả để đếm GV.
async function runChecked(t: T, to: string) {
  const before = await canon(t);
  const r = await t.call('POST', '/api/inventory/costing-runs', { periodFrom: '2026-01-01', periodTo: to });
  expect(r.statusCode, `runCosting ${to}: ${r.body}`).toBe(200);
  const first = r.json() as { voucherIds: string[]; unchanged: boolean };
  if (first.voucherIds.length) bump('gv');
  expect((await stockDrift(t, to)).bad, `sau runCosting đến ${to}`).toEqual([]);
  const again = await t.call('POST', '/api/inventory/costing-runs', { periodFrom: '2026-01-01', periodTo: to });
  expect(again.statusCode, again.body).toBe(200);
  expect(again.json().unchanged, `chạy lần hai đến ${to} phải không đổi`).toBe(true);
  expect(await canon(t), 'sổ cái chứng từ gốc không đổi sau chạy giá vốn').toEqual(before);
  expect((await stockDrift(t, to)).bad, `sau chạy lần hai đến ${to}`).toEqual([]);
}

async function apply(t: T, method: StockMethod, posted: Posted[], op: StockOp) {
  if (op.kind === 'run') return runChecked(t, op.to);
  if (op.kind === 'reverse') {
    const open = posted.filter((p) => !p.reversed); if (!open.length) return;
    const p = open[op.pick % open.length]!;
    const r = await t.call('POST', `/api/vouchers/${p.id}/reverse`, { postingDate: p.date });
    if (r.statusCode === 201) { p.reversed = true; bump('reverse'); return; }
    expect(r.json().error?.code, `đảo: ${r.body}`).toMatch(ACCEPT); return;
  }
  const lot = method === 'specific' ? op.lot : undefined;
  let created;
  if (op.kind === 'lr') {
    const lines = (items: { item: string; qty: number }[]) => items.map((x) => ({ itemCode: x.item, quantity: String(x.qty), ...(lot && { lotNo: lot }) }));
    const parts = lines([{ item: 'H1', qty: op.a }, { item: 'H2', qty: op.b }]); const whole = lines([{ item: 'S', qty: op.s }]);
    created = await t.call('POST', '/api/assembly-vouchers', { mode: op.mode, postingDate: op.date, warehouseCode: 'K1', outputs: whole, components: parts, ...(op.mode === 'assembly' && { extraCost: String(op.extra) }) });
  } else created = await t.call('POST', '/api/stock-vouchers', { description: 'inv7', ...stockBody(op, method) });
  if (created.statusCode !== 201) { expect(created.json().error?.code, `lập ${op.kind}: ${created.body}`).toMatch(ACCEPT); return; }
  const p = await t.call('POST', `/api/vouchers/${created.json().id}/post`, {});
  if (p.statusCode !== 200) { expect(p.json().error?.code, `ghi sổ ${op.kind}: ${p.body}`).toMatch(ACCEPT); return; }
  posted.push({ id: p.json().id, kind: op.kind, date: op.date, reversed: false }); bump(op.kind);
  if (op.kind === 'in' && op.back) bump('back');
}

describe('Bất biến 7: sổ kho và giá vốn', () => {
  it('chuỗi nhập/xuất/chuyển/lắp ráp/đảo/ghi lùi/chạy giá vốn: lớp giá = sổ cái = phát sinh; không sửa sổ cái; chạy lại không đổi; đảo hết về 0', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(...STOCK_METHODS), fc.boolean(), fc.array(arbStockOps, { minLength: 6, maxLength: 16 }), async (method, allowNeg, ops) => {
      const t = await tenant(method, allowNeg); const posted: Posted[] = [];
      for (const op of ops) await apply(t, method, posted, op);
      await runChecked(t, '2026-12-31');
      // (e) đảo mọi chứng từ nhập, xuất, chuyển, lắp ráp (cho phép tồn âm ở bước này; thứ tự: xuất, lắp ráp, chuyển, nhập) rồi tính lại: tồn và giá trị về 0.
      await t.must('PUT', '/api/settings', { stock_negative: 'allow' }, 200);
      for (const kind of ['out', 'lr', 'ck', 'in'] as const)
        for (const p of posted.filter((x) => x.kind === kind && !x.reversed).reverse()) {
          const r = await t.call('POST', `/api/vouchers/${p.id}/reverse`, { postingDate: p.date });
          expect(r.statusCode, `đảo cuối ${kind}: ${r.body}`).toBe(201); p.reversed = true;
        }
      await runChecked(t, '2026-12-31');
      const z = (await stockDrift(t)).rows.filter((r) => Number(r.lq) !== 0 || BigInt(r.lv) !== 0n || Number(r.mq) !== 0 || BigInt(r.gl) !== 0n);
      expect(z, 'sau đảo hết tồn và giá trị về 0').toEqual([]);
    }), { numRuns: runs(10), examples: STOCK_METHODS.map((m) => [m, false, SCENARIO] as [StockMethod, boolean, StockOp[]]) });
    for (const k of ['in', 'out', 'ck', 'lr', 'reverse', 'back', 'gv']) expect(done.get(k) ?? 0, `thao tác ${k} phải từng thành công`).toBeGreaterThan(0);
  }, timeoutFor(900_000));
});

// Kịch bản cố định: nhập hai kho, xuất, chuyển, lắp ráp, chạy tháng 1, nhập ghi lùi (đổi giá), chạy lại, đảo một phiếu xuất.
const I = (wh: 'K1' | 'K2', item: 'H1' | 'H2', qty: number, price: string, date: string, back = false): StockOp => ({ kind: 'in', wh, item, qty, price, date, lot: 'L1', back });
const SCENARIO: StockOp[] = [
  I('K1', 'H1', 20, '10', '2026-01-02'), I('K1', 'H2', 10, '7', '2026-01-02'), I('K2', 'H1', 5, '12', '2026-01-03'),
  { kind: 'out', wh: 'K1', item: 'H1', qty: 6, date: '2026-01-10', lot: 'L1' },
  { kind: 'ck', wh: 'K1', item: 'H1', qty: 4, date: '2026-01-12', lot: 'L1' },
  { kind: 'lr', mode: 'assembly', a: 3, b: 2, s: 1, extra: 5, date: '2026-01-15', lot: 'L1' },
  { kind: 'run', to: '2026-01-31' },
  I('K1', 'H1', 8, '15', '2026-01-05', true), { kind: 'run', to: '2026-03-31' },
  { kind: 'out', wh: 'K2', item: 'H1', qty: 3, date: '2026-02-10', lot: 'L1' },
  { kind: 'lr', mode: 'disassembly', a: 1, b: 1, s: 1, extra: 2, date: '2026-02-20', lot: 'L1' },
  { kind: 'reverse', pick: 3 }, { kind: 'run', to: '2026-06-30' }];
