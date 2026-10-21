import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { syncReferenceData } from '../src/reference.js';
import { withDb } from '../src/temp-db.js';
import { seedAbc } from '../src/seed/demo-abc.js';
import { seedXyz } from '../src/seed/dich-vu-xyz.js';

// Backfill của 0028: DB tạm migrate tới migration ngay trước 0028, nạp dữ liệu mẫu (chứng từ GĐ1, có đảo và đảo lại bản đảo), rồi áp 0028.
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const OPEN_ITEM_MIGRATION = '0028_cong_no.sql';
const adminUrl = process.env.DATABASE_ADMIN_URL!;
const name = `ketoan_t_${randomBytes(4).toString('hex')}`;
const url = withDb(adminUrl, name);
let c: pg.Client; let dir: string;
const q = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) => (await c.query<T>(text, values)).rows;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  dir = mkdtempSync(path.join(tmpdir(), 'kt-mig-0027-'));
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f < OPEN_ITEM_MIGRATION)) copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  await migrate(url, dir);
  await syncReferenceData(url);
  const xyz = await seedXyz(url); await seedAbc(url);
  c = new pg.Client({ connectionString: url }); await c.connect();
  // Đảo phiếu thu tháng 3 của XYZ (131 Có) rồi đảo lại bản đảo; đảo phiếu trả tiền thuê tháng 4 (331 Nợ). Hàm đảo là bản trước 0028.
  const admin2 = (await q<{ id: string }>(`SELECT id FROM app_user WHERE username = 'admin'`))[0]!.id;
  const idOf = async (desc: string) => (await q<{ id: string }>(`SELECT id FROM voucher WHERE tenant_id = $1 AND description = $2`, [xyz.tenantId, desc]))[0]!.id;
  await c.query('BEGIN');
  await c.query(`SELECT set_config('app.current_tenant', $1, true), set_config('app.current_user', $2, true)`, [xyz.tenantId, admin2]);
  const r1 = (await q<{ id: string }>(`SELECT reverse_voucher($1, '2026-03-21', NULL) AS id`, [await idOf('Thu tiền khách hàng tháng 3')]))[0]!.id;
  await c.query(`SELECT reverse_voucher($1, '2026-03-22', NULL)`, [r1]);
  await c.query(`SELECT reverse_voucher($1, '2026-04-26', NULL)`, [await idOf('Trả tiền thuê văn phòng tháng 4')]);
  await c.query('COMMIT');
  copyFileSync(path.join(MIGRATIONS, OPEN_ITEM_MIGRATION), path.join(dir, OPEN_ITEM_MIGRATION)); // chỉ 0028: kiểm thử dữ liệu ngay sau backfill, không phụ thuộc migration sau
  expect(await migrate(url, dir)).toEqual([OPEN_ITEM_MIGRATION]);
}, 180_000);
afterAll(async () => {
  await c?.end();
  rmSync(dir, { recursive: true, force: true });
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end();
});

describe('0028: công nợ theo chứng từ trên dữ liệu có sẵn', () => {
  it('backfill: DB có chứng từ GĐ1 (seed XYZ) sau migration có open_item khớp số dư', async () => {
    // dư còn lại theo (công ty, tài khoản, đối tượng) bằng số dư sổ cái theo đối tượng, ở cuối từng tháng
    for (const asOf of ['2026-01-31', '2026-03-21', '2026-03-31', '2026-04-30', '2026-12-31']) {
      const ledger = await q(`SELECT l.tenant_id::text, l.account_id::int, l.party_id::text, sum(l.debit - l.credit)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
        WHERE v.state IN ('posted', 'reversed') AND a.reconcile AND l.party_id IS NOT NULL AND l.posting_date <= $1 GROUP BY 1, 2, 3 HAVING sum(l.debit - l.credit) <> 0 ORDER BY 1, 2, 3`, [asOf]);
      const items = await q(`SELECT x.tenant_id::text, x.account_id::int, x.party_id::text, sum(x.residual)::text AS n
        FROM tenant t CROSS JOIN LATERAL (SELECT t.id AS tenant_id, o.* FROM fn_open_items_at(t.id, $1) o) x GROUP BY 1, 2, 3 HAVING sum(x.residual) <> 0 ORDER BY 1, 2, 3`, [asOf]);
      expect([asOf, items]).toEqual([asOf, ledger]);
    }
    const xyz = (await q<{ id: string }>(`SELECT id FROM tenant WHERE code = 'XYZ'`))[0]!.id;
    const n = await q<{ items: number; lines: number }>(`SELECT (SELECT count(*)::int FROM open_item WHERE tenant_id = $1) AS items,
      (SELECT count(*)::int FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id WHERE v.tenant_id = $1 AND v.state IN ('posted', 'reversed') AND a.reconcile) AS lines`, [xyz]);
    expect(n[0]!.items).toBe(n[0]!.lines); // XYZ: mọi dòng 131/331 đều có đối tượng nên mỗi dòng một khoản
    expect(n[0]!.items).toBe(48 + 3); // 12 tháng × (bán, thu, mua, trả) + 3 chứng từ đảo
  });

  it('backfill đối trừ cặp gốc/đảo kiểu reversal ngày đảo; đảo lại bản đảo thì khoản của chứng từ mới còn mở; không ghi nhật ký kiểm toán', async () => {
    const rows = await q<{ amount: string; settle_date: string; kind: string; created_by: string | null }>(`SELECT amount::text, settle_date::text, kind, created_by::text FROM settlement ORDER BY settle_date`);
    expect(rows.map((r) => [r.amount, r.settle_date, r.kind, r.created_by !== null])).toEqual([['110000000', '2026-03-21', 'reversal', true], ['22000000', '2026-04-26', 'reversal', true]]);
    const reinstated = await q<{ residual: string }>(`SELECT x.residual::text FROM open_item o JOIN voucher v ON v.id = o.voucher_id JOIN voucher r ON r.id = v.reversal_of_id AND r.reversal_of_id IS NOT NULL
      CROSS JOIN LATERAL (SELECT residual FROM fn_open_items_at(o.tenant_id, '2026-12-31') WHERE item_id = o.id) x`);
    expect(reinstated).toEqual([{ residual: '-110000000' }]); // bản đảo của bản đảo = lần thu thật, còn mở chờ đối trừ
    expect(await q(`SELECT count(*)::int AS n FROM audit_event WHERE entity = 'settlement'`)).toEqual([{ n: 0 }]);
    expect(await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'settlement'::regclass AND tgname = 'trg_audit' AND tgenabled = 'O'`)).toEqual([{ tgname: 'trg_audit' }]);
  });

  it('mọi tài khoản phải thu/phải trả của mọi công ty có reconcile; dòng công nợ thiếu đối tượng được đếm', async () => {
    expect(await q(`SELECT count(*)::int AS n FROM account WHERE subledger_kind IN ('receivable', 'payable') AND NOT reconcile`)).toEqual([{ n: 0 }]);
    expect(await q(`SELECT count(*)::int AS n FROM account WHERE reconcile AND coalesce(subledger_kind, '') NOT IN ('receivable', 'payable')`)).toEqual([{ n: 0 }]);
    expect(await q(`SELECT count(*)::int AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id WHERE v.state IN ('posted', 'reversed') AND a.reconcile AND l.party_id IS NULL`)).toEqual([{ n: 0 }]);
  });
});
