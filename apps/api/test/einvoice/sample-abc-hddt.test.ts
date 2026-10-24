import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { seedAbcFull } from '../../scripts/seed-abc.js';
import { createTestApp, type TestApp } from '../helpers.js';

// Kỳ vọng tính tay ở expected-gd5-abc.json (số liệu báo cáo năm không đổi do sample-abc.test.ts và sample-abc-tai-san.test.ts kiểm).
const hd = JSON.parse(readFileSync(new URL('../../../../packages/db/src/seed/expected-gd5-abc.json', import.meta.url), 'utf8'));

let ctx: TestApp; let tenantId: string;
beforeAll(async () => { ctx = await createTestApp(); ({ tenantId } = await seedAbcFull(process.env.DATABASE_ADMIN_URL!)); }, 300_000);
afterAll(async () => { await ctx.close(); });
const q = <T>(s: ReturnType<typeof sql<T>>) => s.execute(ctx.t.admin).then((r) => r.rows);

describe('Dữ liệu mẫu ABC GĐ5: hóa đơn điện tử, hóa đơn đầu vào, ngân hàng', () => {
  it('hóa đơn điện tử 1C26TAA đánh số liên tục từ 1; một hóa đơn bị thay thế, chứng từ gốc đã đảo', async () => {
    const rows = await q<{ no: string; st: string; vs: string }>(sql`SELECT e.invoice_no AS no, e.status AS st, v.state AS vs FROM einvoice e JOIN voucher v ON v.id = e.voucher_id
      WHERE e.tenant_id = ${tenantId}::uuid ORDER BY e.invoice_no`);
    expect(rows.map((r) => r.no)).toEqual(hd.hoaDonDienTu.soHoaDon);
    const count: Record<string, number> = {};
    for (const r of rows) count[r.st] = (count[r.st] ?? 0) + 1;
    expect(count).toEqual(hd.hoaDonDienTu.trangThai);
    expect(rows.filter((r) => r.st === 'issued').every((r) => r.vs === 'posted')).toBe(true);
    expect(rows.find((r) => r.st === 'replaced')!.vs).toBe('reversed');
  });

  it('hóa đơn đầu vào: 3 bản ghi, 1 chứng từ mua nháp', async () => {
    const [n] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM inbound_invoice WHERE tenant_id = ${tenantId}::uuid`);
    expect(n!.n).toBe(hd.hoaDonDauVao.tong);
    const [d] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND state = 'draft'`);
    expect(d!.n).toBe(hd.hoaDonDauVao.chungTuNhap);
  });

  it('ngân hàng SePay: 5 giao dịch, 3 đối chiếu với chứng từ đã ghi sổ cùng số tiền', async () => {
    const rows = await q<{ st: string; vs: string | null; same: boolean | null }>(sql`SELECT t.status AS st, v.state AS vs,
        (SELECT sum(l.debit + l.credit) = t.amount_in + t.amount_out FROM voucher_line l WHERE l.voucher_id = v.id AND l.bank_account_id = t.bank_account_id) AS same
      FROM bank_transaction t LEFT JOIN voucher v ON v.id = t.voucher_id WHERE t.tenant_id = ${tenantId}::uuid`);
    expect(rows).toHaveLength(hd.nganHang.giaoDich);
    const matched = rows.filter((r) => r.st === 'matched');
    expect(matched).toHaveLength(hd.nganHang.daDoiChieu);
    expect(matched.every((r) => r.vs === 'posted' && r.same === true)).toBe(true);
    expect(rows.filter((r) => r.st === 'new')).toHaveLength(hd.nganHang.moi);
  });
});
