import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { D } from '@kt/domain';
import { seedAbcFull } from '../../scripts/seed-abc.js';
import { createTestApp, type TestApp } from '../helpers.js';
import { assertBalanceSheet } from '../invariants/helpers.js';

// Kỳ vọng tính tay (trường calc ghi phép tính), không sinh từ mã đang kiểm.
const gd2 = JSON.parse(readFileSync(new URL('../../../../packages/db/src/seed/expected-gd2-abc.json', import.meta.url), 'utf8'));
const gd3 = JSON.parse(readFileSync(new URL('../../../../packages/db/src/seed/expected-gd3-abc.json', import.meta.url), 'utf8'));

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => {
  ctx = await createTestApp();
  ({ tenantId } = await seedAbcFull(process.env.DATABASE_ADMIN_URL!));
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'Matkhau1!' } });
  cookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
  await ctx.app.inject({ method: 'POST', url: '/api/auth/select-tenant', headers: { cookie }, payload: { tenantId } });
}, 300_000);
afterAll(async () => { await ctx.close(); });

const get = async (url: string) => { const r = await ctx.app.inject({ method: 'GET', url, headers: { cookie } }); expect(r.statusCode, r.body).toBe(200); return r.json(); };

describe('Bộ dữ liệu mẫu ABC có kho (GĐ3): bốn phương pháp giá vốn, số tính tay', () => {
  it('số dư cuối năm các tài khoản kho = số dư GĐ2 + chênh lệch tính tay', async () => {
    const by: Record<string, bigint> = {};
    for (const x of (await get('/api/balances?asOf=2026-12-31')).rows as { accountCode: string; debit: string; credit: string }[]) by[x.accountCode] = (by[x.accountCode] ?? 0n) + BigInt(x.debit) - BigInt(x.credit);
    for (const [code, d] of Object.entries(gd3.chenhLechSoDuCuoiNam as Record<string, string>))
      expect((by[code] ?? 0n).toString(), code).toBe((BigInt(gd2.soDuCuoiNam[code] ?? '0') + BigInt(d)).toString());
  });

  it('nhập xuất tồn cả năm từng cặp hàng, kho (bình quân cuối kỳ, bình quân tức thời, FIFO, đích danh)', async () => {
    const rows = (await get('/api/reports/stock-summary?from=2026-01-01&to=2026-12-31')).rows as Record<string, string>[];
    const keys = ['openingQty', 'openingValue', 'inQty', 'inValue', 'outQty', 'outValue', 'closingQty', 'closingValue'] as const;
    for (const n of gd3.nxt as Record<string, string>[]) {
      const mine = rows.filter((r) => r['itemCode'] === n['item'] && r['warehouseCode'] === n['warehouse']);
      const sum = (k: string) => mine.reduce((s, r) => s.plus(r[k]!), D(0));
      expect(Object.fromEntries(keys.map((k) => [k, sum(k).toString()])), `${n['item']}/${n['warehouse']}`).toEqual(Object.fromEntries(keys.map((k) => [k, n[k]])));
    }
  });

  it('B01 Hàng tồn kho (dòng 141) = 155 + 156 + 157 và bằng số tính tay', async () => {
    const rl = await ctx.app.inject({ method: 'POST', url: '/api/report-defs/B01/reload', headers: { cookie }, payload: { regime: 'TT133' } });
    expect(rl.statusCode, rl.body).toBe(200);
    const r = (await get('/api/reports/financial/B01?from=2026-01-01&to=2026-12-31')).rows as { lineCode: string; current: string }[];
    expect(r.find((x) => x.lineCode === '141')!.current).toBe(gd3.bangCanDoiKho.B01_141);
  });

  it('thuế GTGT quý 1: KTT 31/03 theo tính tay; 1331 và 33311 cuối năm về 0 như GĐ2', async () => {
    const rows = (await sql<{ code: string; debit: string; credit: string }>`SELECT a.code, l.debit::text, l.credit::text FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id AND l.posting_date = v.posting_date
      JOIN account a ON a.id = l.account_id WHERE v.tenant_id = ${tenantId}::uuid AND v.voucher_type = 'KTT' AND v.posting_date = ${gd3.ktt31Thang3.date}::date AND v.state = 'posted'`.execute(ctx.t.admin)).rows;
    expect(rows.map((r) => [r.code, '', r.debit, r.credit]).sort()).toEqual([...gd3.ktt31Thang3.lines].sort());
  });

  it('Σ giá trị lớp giá còn lại của từng kho = số dư TK kho trên sổ cái; chứng từ GV: đúng một bản bị đảo sau khi chạy lại tháng 3', async () => {
    const drift = (await sql<{ wh: string; layers: string; ledger: string }>`SELECT w.code AS wh,
        (SELECT coalesce(sum(c.remaining_value), 0) FROM stock_cost_layer c WHERE c.warehouse_id = w.id)::text AS layers,
        (SELECT coalesce(sum(l.debit - l.credit), 0) FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
          WHERE l.warehouse_id = w.id AND a.code IN ('155', '156', '157') AND v.state IN ('posted', 'reversed'))::text AS ledger
      FROM warehouse w WHERE w.tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows.filter((r) => r.layers !== r.ledger);
    expect(drift).toEqual([]);
    const gv = (await sql<{ s: string; n: number }>`SELECT state AS s, count(*)::int AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = 'GV' GROUP BY 1 ORDER BY 1`.execute(ctx.t.admin)).rows;
    expect(Object.fromEntries(gv.map((x) => [x.s, x.n]))).toEqual({ posted: gd3.soChungTuThem.gv.total - gd3.soChungTuThem.gv.reversed, reversed: gd3.soChungTuThem.gv.reversed });
  });

  it('số chứng từ kho theo loại; bất biến cân đối cuối quý 1 và cuối năm', async () => {
    const byType = Object.fromEntries((await sql<{ t: string; n: number }>`SELECT voucher_type AS t, count(*)::int AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = ANY(${Object.keys(gd3.soChungTuThem.counts)}::text[]) GROUP BY 1`.execute(ctx.t.admin)).rows.map((x) => [x.t, x.n]));
    for (const [t, n] of Object.entries(gd3.soChungTuThem.counts as Record<string, number>)) expect(byType[t], t).toBe((gd2.soChungTu.counts[t] ?? 0) + n);
    for (const d of ['2026-01-31', '2026-02-28', '2026-03-31', '2026-06-30', '2026-12-31']) await assertBalanceSheet(ctx, cookie, d);
  });
});
