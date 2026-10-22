import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { withTenant } from '../src/client.js';
import { createTestTenant, setupTestDb, type TestDb } from '../src/testing.js';
import { insertFiscalYear, generateAccountsSql } from '../src/seed/common.js';
import type { Database } from '../src/types.js';

let t: TestDb; let tenantA: string; let tenantB: string; let userA: string; let uomA: number; let whA: number; let whA2: number; let a1111: number; let a5113: number;
const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
const runA = <T>(fn: (trx: Transaction<Database>) => Promise<T>) => withTenant(t.db, { tenantId: tenantA, userId: userA }, fn);
let seq = 0;

async function setup(code: string) {
  const id = await createTestTenant(t.admin, { code, name: code });
  await admin.query(`SELECT set_config('app.current_tenant', $1, false)`, [id]);
  await insertFiscalYear(admin, id, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  await generateAccountsSql(admin, id, 'TT133');
  return id;
}
const accOf = async (tenant: string, c: string) => (await sql<{ id: number }>`SELECT id FROM account WHERE tenant_id = ${tenant}::uuid AND regime = 'TT133' AND code = ${c}`.execute(t.admin)).rows[0]!.id;
const newItem = () => runA((trx) => trx.insertInto('item').values({ tenant_id: tenantA, code: `SP${++seq}`, name: 'SP', base_uom_id: uomA }).returning('id').executeTakeFirstOrThrow()).then((r) => r.id);
const newWh = (code: string) => runA((trx) => trx.insertInto('warehouse').values({ tenant_id: tenantA, code: `${code}${Date.now()}${++seq}`, name: code }).returning('id').executeTakeFirstOrThrow()).then((r) => r.id);

type L = { item: number; wh: number; dir?: 'in' | 'out'; qty: string; amount?: string; dest?: number; factor?: string; discount?: string; unitCost?: string };
// Chứng từ nháp (2 dòng cân) kèm các dòng hàng; trả về id chứng từ.
async function draft(date: string, lines: L[]) {
  return runA(async (trx) => {
    const v = await trx.insertInto('voucher').values({ tenant_id: tenantA, voucher_type: 'PKT', posting_date: date, document_date: date, state: 'draft', description: 't', currency_code: 'VND', created_by: userA }).returning('id').executeTakeFirstOrThrow();
    const base = { tenant_id: tenantA, voucher_id: v.id, posting_date: date, currency_code: 'VND' };
    await trx.insertInto('voucher_line').values({ ...base, line_no: 1, account_id: a1111, debit: '100', credit: '0', amount_currency: '100' }).execute();
    await trx.insertInto('voucher_line').values({ ...base, line_no: 2, account_id: a5113, debit: '0', credit: '100', amount_currency: '-100' }).execute();
    let no = 0;
    for (const l of lines) {
      await trx.insertInto('voucher_item_line').values({
        tenant_id: tenantA, voucher_id: v.id, line_no: ++no, item_id: l.item, warehouse_id: l.wh, dest_warehouse_id: l.dest ?? null, direction: l.dir ?? null,
        quantity: l.qty, uom_factor: l.factor ?? '1', amount_currency: l.amount ?? '0', amount: l.amount ?? '0', discount_amount: l.discount ?? '0', unit_cost: l.unitCost ?? null, account_id: a1111,
      }).execute();
    }
    return v.id;
  });
}
const post = (id: string) => runA((trx) => sql`SELECT post_voucher(${id}::uuid)`.execute(trx));
const unpost = (id: string) => runA((trx) => sql`SELECT unpost_voucher(${id}::uuid)`.execute(trx));
const receive = async (item: number, wh: number, date: string, qty: string, amount: string) => { const id = await draft(date, [{ item, wh, dir: 'in', qty, amount }]); await post(id); return id; };
const moves = (item: number) => runA((trx) => trx.selectFrom('stock_move').selectAll().where('item_id', '=', item).orderBy('id').execute());
const setNegative = (val: string | null) => runA(async (trx) => { await (val === null
  ? sql`DELETE FROM tenant_setting WHERE key = 'stock_negative'`.execute(trx)
  : sql`INSERT INTO tenant_setting(tenant_id, key, value) VALUES (${tenantA}::uuid, 'stock_negative', to_jsonb(${val}::text)) ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`.execute(trx)); });

beforeAll(async () => {
  t = await setupTestDb(); await admin.connect();
  tenantA = await setup(`SA${Date.now()}`); tenantB = await setup(`SB${Date.now()}`);
  userA = (await sql<{ user_id: string }>`SELECT user_id FROM tenant_user WHERE tenant_id = ${tenantA}::uuid`.execute(t.admin)).rows[0]!.user_id;
  uomA = (await sql<{ id: number }>`SELECT id FROM uom WHERE tenant_id = ${tenantA}::uuid AND code = 'CAI'`.execute(t.admin)).rows[0]!.id;
  [a1111, a5113] = [await accOf(tenantA, '1111'), await accOf(tenantA, '5113')];
  whA = await newWh('K1'); whA2 = await newWh('K2');
});
afterAll(async () => { await admin.end(); await t.close(); });

describe('sổ kho', () => {
  it('ghi sổ phiếu nhập sinh stock_move in và lớp giá; unpost xóa chúng', async () => {
    const it1 = await newItem();
    const v = await receive(it1, whA, '2026-03-01', '100', '1000');
    const m = await moves(it1);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ direction: 'in', quantity: '100.0000', warehouse_id: whA, voucher_id: v });
    const layers = () => runA((trx) => trx.selectFrom('stock_cost_layer').selectAll().where('item_id', '=', it1).execute());
    expect(await layers()).toMatchObject([{ kind: 'receipt', qty: '100.0000', unit_cost: '10.0000', value: '1000', remaining_qty: '100.0000', remaining_value: '1000' }]);
    await unpost(v);
    expect(await moves(it1)).toHaveLength(0);
    expect(await layers()).toHaveLength(0);
  });

  it('quy đổi ĐVT: base_quantity thiếu thì lấy quantity × uom_factor', async () => {
    const it1 = await newItem();
    const id = await draft('2026-03-01', [{ item: it1, wh: whA, dir: 'in', qty: '12', factor: '24', amount: '2880' }]);
    await post(id);
    expect((await moves(it1))[0]!.quantity).toBe('288.0000');
  });

  it('ghi sổ phiếu xuất quá tồn → STOCK_NEGATIVE; stock_negative=allow cho qua', async () => {
    const it1 = await newItem();
    await receive(it1, whA, '2026-03-01', '100', '1000');
    const out = await draft('2026-03-05', [{ item: it1, wh: whA, dir: 'out', qty: '130' }]);
    await expect(post(out)).rejects.toThrow(/STOCK_NEGATIVE: hàng SP\d+ kho K1\d+ ngày 05\/03\/2026 thiếu 30/);
    await setNegative('allow');
    try { await post(out); } finally { await setNegative(null); }
    expect(await moves(it1)).toHaveLength(2);
  });

  it('ghi lùi phiếu xuất làm tồn ngày giữa âm bị từ chối nêu ngày thiếu', async () => {
    const it1 = await newItem();
    await receive(it1, whA, '2026-03-01', '100', '1000');
    await post(await draft('2026-03-10', [{ item: it1, wh: whA, dir: 'out', qty: '80' }]));
    const back = await draft('2026-03-05', [{ item: it1, wh: whA, dir: 'out', qty: '30' }]);
    await expect(post(back)).rejects.toThrow(/ngày 10\/03\/2026 thiếu 10/);
  });

  it('unpost phiếu nhập đã bị xuất → STOCK_CONSUMED', async () => {
    const it1 = await newItem();
    const inV = await receive(it1, whA, '2026-03-01', '100', '1000');
    await post(await draft('2026-03-02', [{ item: it1, wh: whA, dir: 'out', qty: '60' }]));
    await expect(unpost(inV)).rejects.toThrow(/STOCK_CONSUMED: phiếu nhập đã được xuất ở chứng từ .*02\/03\/2026/);
    expect(await moves(it1)).toHaveLength(2);
  });

  it('đảo phiếu nhập: move out đảo trỏ reversal_of; đảo phiếu xuất: move in đảo, giá trị theo dòng gốc', async () => {
    const it1 = await newItem();
    const inV = await receive(it1, whA, '2026-03-01', '100', '1000');
    const outV = await draft('2026-03-02', [{ item: it1, wh: whA, dir: 'out', qty: '40', amount: '400' }]);
    await post(outV);
    await expect(runA((trx) => sql`SELECT reverse_voucher(${inV}::uuid, '2026-03-03'::date, NULL)`.execute(trx))).rejects.toThrow(/STOCK_NEGATIVE/);
    await runA((trx) => sql`SELECT reverse_voucher(${outV}::uuid, '2026-03-03'::date, NULL)`.execute(trx));
    const m = await moves(it1);
    expect(m.map((x) => x.direction)).toEqual(['in', 'out', 'in']);
    expect(m[2]!.reversal_of).toBe(m[1]!.id);
    const lay = await runA((trx) => trx.selectFrom('stock_cost_layer').select(['move_id', 'value']).where('move_id', '=', m[2]!.id).execute());
    expect(lay).toEqual([{ move_id: m[2]!.id, value: '400' }]);
    await runA((trx) => sql`SELECT reverse_voucher(${inV}::uuid, '2026-03-04'::date, NULL)`.execute(trx));
  });

  it('chuyển kho: hai move cùng transfer_id, in lấy giá tạm tính kho đi; đảo đổi kho', async () => {
    const it1 = await newItem();
    await receive(it1, whA, '2026-03-01', '100', '1000');
    const ck = await draft('2026-03-02', [{ item: it1, wh: whA, dest: whA2, qty: '30' }]);
    await post(ck);
    const m = (await moves(it1)).slice(1);
    expect(m.map((x) => [x.direction, x.warehouse_id])).toEqual([['out', whA], ['in', whA2]]);
    expect(m[0]!.transfer_id).toBeTruthy(); expect(m[0]!.transfer_id).toBe(m[1]!.transfer_id);
    const lay = await runA((trx) => trx.selectFrom('stock_cost_layer').select(['value', 'unit_cost']).where('warehouse_id', '=', whA2).where('item_id', '=', it1).execute());
    expect(lay).toEqual([{ value: '300', unit_cost: '10.0000' }]);
    await runA((trx) => sql`SELECT reverse_voucher(${ck}::uuid, '2026-03-03'::date, NULL)`.execute(trx));
    expect((await moves(it1)).slice(3).map((x) => [x.direction, x.warehouse_id])).toEqual([['out', whA2], ['in', whA]]);
  });

  it('hàng dịch vụ không sinh move', async () => {
    const it1 = await newItem();
    await runA((trx) => trx.updateTable('item').set({ kind: 'service' }).where('id', '=', it1).execute());
    await post(await draft('2026-03-01', [{ item: it1, wh: whA, dir: 'in', qty: '5', amount: '50' }]));
    expect(await moves(it1)).toHaveLength(0);
  });

  it('UPDATE/DELETE stock_move trực tiếp bị chặn; app_user không thấy move công ty khác', async () => {
    const it1 = await newItem();
    await receive(it1, whA, '2026-03-01', '10', '100');
    await expect(runA((trx) => trx.updateTable('stock_move').set({ quantity: '1' }).where('item_id', '=', it1).execute())).rejects.toThrow(/STOCK_MOVE_IMMUTABLE/);
    await expect(runA((trx) => trx.deleteFrom('stock_move').where('item_id', '=', it1).execute())).rejects.toThrow(/STOCK_MOVE_IMMUTABLE/);
    const seen = await withTenant(t.db, { tenantId: tenantB, userId: userA }, (trx) => trx.selectFrom('stock_move').select('id').execute());
    expect(seen).toEqual([]);
  });

  it('fn_stock_estimate_cost: tồn 100 giá trị 1.000 rồi nhập 50 giá trị 600 → 10,6667', async () => {
    const it1 = await newItem();
    await receive(it1, whA, '2026-03-01', '100', '1000');
    await receive(it1, whA, '2026-03-05', '50', '600');
    const est = (d: string) => runA((trx) => sql<{ c: string }>`SELECT fn_stock_estimate_cost(${it1}::bigint, ${whA}::bigint, ${d}::date)::text AS c`.execute(trx)).then((r) => r.rows[0]!.c);
    expect(await est('2026-03-10')).toBe('10.6667');
    expect(await est('2026-03-02')).toBe('10.0000');
    expect(await est('2026-02-01')).toBe('0');
  });

  it('hai phiên ghi sổ xuất cùng hàng đồng thời không làm tồn âm', async () => {
    const it1 = await newItem();
    await receive(it1, whA, '2026-03-01', '100', '1000');
    const [o1, o2] = [await draft('2026-03-02', [{ item: it1, wh: whA, dir: 'out', qty: '60' }]), await draft('2026-03-02', [{ item: it1, wh: whA, dir: 'out', qty: '60' }])];
    const r = await Promise.allSettled([post(o1), post(o2)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(String((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/STOCK_NEGATIVE/);
  });

  it('ITEM_UOM_LOCKED: hàng đã có move không sửa hệ số, không xóa ĐVT quy đổi', async () => {
    const it1 = await newItem();
    const thung = (await runA((trx) => trx.insertInto('uom').values({ tenant_id: tenantA, code: `TH${++seq}`, name: 'Thùng' }).returning('id').executeTakeFirstOrThrow())).id;
    const row = await runA((trx) => trx.insertInto('item_uom').values({ tenant_id: tenantA, item_id: it1, uom_id: thung, factor: '24' }).returning('id').executeTakeFirstOrThrow());
    await runA((trx) => trx.updateTable('item_uom').set({ factor: '12' }).where('id', '=', row.id).execute()); // chưa phát sinh: sửa được
    await receive(it1, whA, '2026-03-01', '10', '100');
    await expect(runA((trx) => trx.updateTable('item_uom').set({ factor: '6' }).where('id', '=', row.id).execute())).rejects.toThrow(/ITEM_UOM_LOCKED/);
    await expect(runA((trx) => trx.deleteFrom('item_uom').where('id', '=', row.id).execute())).rejects.toThrow(/ITEM_UOM_LOCKED/);
    await runA((trx) => trx.updateTable('item_uom').set({ is_sale: true }).where('id', '=', row.id).execute()); // cờ khác vẫn sửa được
  });
});

describe('sổ kho: sửa vòng 1', () => {
  it('unpost phiếu nhập đã bị xuất: warn thành công kèm cảnh báo, allow thành công, forbid nêu chứng từ xuất', async () => {
    for (const mode of ['warn', 'allow'] as const) {
      const it1 = await newItem();
      const inV = await receive(it1, whA, '2026-03-01', '100', '1000');
      await post(await draft('2026-03-02', [{ item: it1, wh: whA, dir: 'out', qty: '60' }]));
      await setNegative(mode);
      try { await unpost(inV); } finally { await setNegative(null); }
      expect(await moves(it1)).toHaveLength(1);
    }
    const it2 = await newItem();
    const inV = await receive(it2, whA, '2026-03-01', '100', '1000');
    await post(await draft('2026-03-02', [{ item: it2, wh: whA, dir: 'out', qty: '60' }]));
    await setNegative('rác'); // giá trị lạ coi như forbid
    try { await expect(unpost(inV)).rejects.toThrow(/STOCK_CONSUMED/); } finally { await setNegative(null); }
  });

  it('đảo phiếu xuất ghi theo giá tạm tính: lớp giá nhập đảo bằng giá vốn đã xuất, không phải số tiền dòng', async () => {
    const it1 = await newItem();
    await receive(it1, whA, '2026-03-01', '100', '1000');
    const outV = await draft('2026-03-02', [{ item: it1, wh: whA, dir: 'out', qty: '40', amount: '9999' }]); // amount kiểu doanh thu
    await post(outV);
    await runA((trx) => sql`SELECT reverse_voucher(${outV}::uuid, '2026-03-03'::date, NULL)`.execute(trx));
    const last = (await moves(it1)).at(-1)!;
    const lay = await runA((trx) => trx.selectFrom('stock_cost_layer').select('value').where('move_id', '=', last.id).execute());
    expect(lay).toEqual([{ value: '400' }]);
    // có đơn giá trên dòng thì dùng đơn giá
    const out2 = await draft('2026-03-04', [{ item: it1, wh: whA, dir: 'out', qty: '10', amount: '5000', unitCost: '12' }]);
    await post(out2);
    await runA((trx) => sql`SELECT reverse_voucher(${out2}::uuid, '2026-03-05'::date, NULL)`.execute(trx));
    const last2 = (await moves(it1)).at(-1)!;
    expect((await runA((trx) => trx.selectFrom('stock_cost_layer').select('value').where('move_id', '=', last2.id).execute()))).toEqual([{ value: '120' }]);
  });

  it('đảo phiếu xuất đã có giá gán hiện hành: lấy tổng giá gán', async () => {
    const it1 = await newItem();
    await receive(it1, whA, '2026-03-01', '100', '1000');
    const outV = await draft('2026-03-02', [{ item: it1, wh: whA, dir: 'out', qty: '40' }]);
    await post(outV);
    const mv = (await moves(it1)).at(-1)!;
    await admin.query(`INSERT INTO costing_run(id, tenant_id, period_from, period_to, method, status) VALUES ('00000000-0000-0000-0000-0000000000a1', $1, '2026-03-01', '2026-03-31', 'avg_period', 'done') ON CONFLICT DO NOTHING`, [tenantA]);
    await admin.query(`INSERT INTO stock_cost_assignment(tenant_id, run_id, move_id, unit_cost, amount) VALUES ($1, '00000000-0000-0000-0000-0000000000a1', $2, 11, 440)`, [tenantA, mv.id]);
    await runA((trx) => sql`SELECT reverse_voucher(${outV}::uuid, '2026-03-03'::date, NULL)`.execute(trx));
    const last = (await moves(it1)).at(-1)!;
    expect(await runA((trx) => trx.selectFrom('stock_cost_layer').select('value').where('move_id', '=', last.id).execute())).toEqual([{ value: '440' }]);
  });

  it('giá trị lớp nhập trừ chiết khấu dòng', async () => {
    const it1 = await newItem();
    await post(await draft('2026-03-01', [{ item: it1, wh: whA, dir: 'in', qty: '10', amount: '1000', discount: '100' }]));
    expect(await runA((trx) => trx.selectFrom('stock_cost_layer').select('value').where('item_id', '=', it1).execute())).toEqual([{ value: '900' }]);
  });

  it('không chèn trực tiếp stock_move; chuyển kho cùng kho bị từ chối; unpost phiếu chuyển kho xóa cả hai move', async () => {
    const it1 = await newItem();
    await receive(it1, whA, '2026-03-01', '100', '1000');
    const same = await draft('2026-03-02', [{ item: it1, wh: whA, dest: whA, qty: '5' }]);
    await expect(post(same)).rejects.toThrow(/STOCK_TRANSFER_SAME_WAREHOUSE/);
    const ck = await draft('2026-03-02', [{ item: it1, wh: whA, dest: whA2, qty: '30' }]);
    const line = await runA((trx) => trx.selectFrom('voucher_item_line').select('id').where('voucher_id', '=', ck).executeTakeFirstOrThrow());
    await expect(runA((trx) => trx.insertInto('stock_move').values({ tenant_id: tenantA, voucher_id: ck, item_line_id: line.id, item_id: it1, warehouse_id: whA, posting_date: '2026-03-02', direction: 'in', quantity: '1' }).execute())).rejects.toThrow(/STOCK_MOVE_IMMUTABLE/);
    await post(ck);
    expect(await moves(it1)).toHaveLength(3);
    await unpost(ck);
    expect(await moves(it1)).toHaveLength(1);
    await post(ck);
    await post(await draft('2026-03-03', [{ item: it1, wh: whA2, dir: 'out', qty: '20' }]));
    await expect(unpost(ck)).rejects.toThrow(/STOCK_CONSUMED/);
  });
});
