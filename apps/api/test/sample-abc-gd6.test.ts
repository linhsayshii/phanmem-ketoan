import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { seedAbcFull } from '../scripts/seed-abc.js';
import { createTestApp, type TestApp } from './helpers.js';
import { assertBalanceSheet, byAccount, sumFromLines } from './invariants/helpers.js';

// Kỳ vọng tính tay ở expected-gd6-abc.json (trường calc ghi phép tính; lương tháng 10 theo docs/dev/bang-luong-mau-20.md), không sinh từ mã đang kiểm.
const g6 = JSON.parse(readFileSync(new URL('./expected-gd6-abc.json', import.meta.url), 'utf8'));
const MONTHS = ['10', '11', '12'] as const;
const eom = (m: string) => `2026-${m}-${new Date(Date.UTC(2026, Number(m), 0)).getUTCDate()}`;

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => {
  ctx = await createTestApp();
  ({ tenantId } = await seedAbcFull(process.env.DATABASE_ADMIN_URL!));
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'Matkhau1!' } });
  cookie = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
  await ctx.app.inject({ method: 'POST', url: '/api/auth/select-tenant', headers: { cookie }, payload: { tenantId } });
}, 300_000);
afterAll(async () => { await ctx.close(); });

const q = <T>(s: ReturnType<typeof sql<T>>) => s.execute(ctx.t.admin).then((r) => r.rows);

describe('Bộ dữ liệu mẫu ABC GĐ6: lương, giá thành, hợp đồng, phân bổ vụ việc (số tính tay)', () => {
  it('bảng lương tháng 10, 11, 12: tổng gross, bảo hiểm, TNCN, thực lĩnh khớp tính tay; cả ba đã hạch toán', async () => {
    const rows = await q<{ month: number; status: string; gross: string; ee: string; er: string; pit: string; net: string; n: number }>(sql`SELECT r.month, r.status, sum(l.gross)::text AS gross, sum(l.si_emp)::text AS ee, sum(l.si_er)::text AS er,
      sum(l.pit)::text AS pit, sum(l.net)::text AS net, count(*)::int AS n FROM payroll_run r JOIN payroll_line l ON l.run_id = r.id WHERE r.tenant_id = ${tenantId}::uuid AND r.year = 2026 GROUP BY 1, 2 ORDER BY 1`);
    expect(rows.map((r) => r.month)).toEqual([10, 11, 12]);
    for (const r of rows) {
      const w = g6.luong[String(r.month)];
      expect({ status: r.status, gross: r.gross, ee: r.ee, er: r.er, pit: r.pit, net: r.net }, `tháng ${r.month}`).toEqual({ status: 'posted', gross: w.gross, ee: w.baoHiemNguoiLaoDong, er: w.baoHiemDoanhNghiep, pit: w.pit, net: w.net });
    }
    expect(rows.map((r) => r.n)).toEqual([20, 19, 19]); // NV11 nghỉ việc từ 09/10
  });

  it('chứng từ LU từng tháng: chi phí sản xuất, bán hàng, quản lý và Có 334, 3383, 3384, 3385, 3335, 3388', async () => {
    const rows = await q<{ m: string; code: string; dr: string; cr: string }>(sql`SELECT to_char(v.posting_date, 'MM') AS m, a.code, sum(l.debit)::text AS dr, sum(l.credit)::text AS cr
      FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id AND l.posting_date = v.posting_date JOIN account a ON a.id = l.account_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.voucher_type = 'LU' AND v.state = 'posted' GROUP BY 1, 2`);
    for (const m of MONTHS) {
      const w = g6.luong[m]; const at = (code: string) => rows.find((r) => r.m === m && r.code === code);
      expect(at('154')!.dr, `${m}/154`).toBe(w.chiPhiSanXuat);
      expect(at('6421')!.dr, `${m}/6421`).toBe(w.chiPhiBanHang);
      expect(at('6422')!.dr, `${m}/6422`).toBe(w.chiPhiQuanLy);
      expect(at('334')!.cr, `${m}/334 Có`).toBe(w.gross);
      expect(at('3383')!.cr).toBe(w.si); expect(at('3384')!.cr).toBe(w.hi); expect(at('3385')!.cr).toBe(w.ui); expect(at('3335')!.cr).toBe(w.pit);
      expect(at('3388')?.cr ?? '0', `${m}/3388`).toBe(w.khauTruKhac);
    }
  });

  it('số dư 334, 3383, 3384, 3385, 3335, 3388 cuối từng tháng (tháng 10 đã chi ngày 05/11)', async () => {
    for (const m of MONTHS) {
      const b = byAccount(await sumFromLines(ctx, tenantId, eom(m)));
      for (const code of ['334', '3383', '3384', '3385', '3335', '3388']) expect(b[code], `${code} cuối tháng ${m}`).toBe(g6.soDuCuoiThang[code][eom(m)]);
    }
  });

  it('giá thành SP-E: tổng giá thành, sản lượng, đơn giá từng tháng; 154 cuối mỗi tháng về 0, 155 tăng đúng tổng giá thành', async () => {
    const runs = await q<{ month: number; total: string; qty: string; unit: string }>(sql`SELECT r.month, o.total_cost::text AS total, o.completed_qty::text AS qty, o.unit_cost::text AS unit
      FROM cost_run r JOIN cost_run_object o ON o.run_id = r.id WHERE r.tenant_id = ${tenantId}::uuid AND r.year = 2026 ORDER BY 1`);
    expect(runs.map((r) => [r.month, r.total, Number(r.qty), Number(r.unit)])).toEqual(MONTHS.map((m) => { const w = g6.giaThanh[m]; return [Number(m), w.tongGiaThanh, Number(w.soLuong), Number(w.donGia)]; }));
    for (const m of MONTHS) expect(byAccount(await sumFromLines(ctx, tenantId, eom(m)))['154'], `154 cuối tháng ${m}`).toBeUndefined();
    const gv = await q<{ m: string; dr155: string }>(sql`SELECT to_char(v.posting_date, 'MM') AS m, sum(l.debit - l.credit)::text AS dr155 FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id AND l.posting_date = v.posting_date
      JOIN account a ON a.id = l.account_id WHERE v.tenant_id = ${tenantId}::uuid AND v.voucher_type = 'GV' AND v.state = 'posted' AND v.posting_date >= '2026-10-01' AND a.code = '155' GROUP BY 1 ORDER BY 1`);
    expect(gv.map((r) => [r.m, r.dr155])).toEqual(MONTHS.map((m) => [m, g6.giaThanh[m].chenhLech]));
  });

  it('hợp đồng HD-DT-01: ba đợt 40/40/20, chỉ đợt 1 lập hóa đơn; doanh thu 5113 theo hợp đồng và công nợ KH006 về 0', async () => {
    const ms = await q<{ seq: number; amount: string; invoiced: boolean }>(sql`SELECT m.seq, m.amount::text, m.voucher_id IS NOT NULL AS invoiced FROM contract_milestone m JOIN contract c ON c.id = m.contract_id
      WHERE c.tenant_id = ${tenantId}::uuid AND c.code = ${g6.hopDong.ma} ORDER BY m.seq`);
    expect(ms.map((m) => Number(m.amount))).toEqual(g6.hopDong.dot.map(Number));
    expect(ms.filter((m) => m.invoiced).map((m) => m.seq)).toEqual([g6.hopDong.dotDaLapHoaDon]);
    const [rev] = await q<{ n: string }>(sql`SELECT coalesce(sum(l.credit - l.debit), 0)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id JOIN contract c ON c.id = l.contract_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted', 'reversed') AND a.code = '5113' AND c.code = ${g6.hopDong.ma}`);
    expect(rev!.n).toBe(g6.hopDong.doanhThu5113);
    const [ar] = await q<{ n: string }>(sql`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id JOIN party p ON p.id = l.party_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted', 'reversed') AND a.code = '131' AND p.code = 'KH006'`);
    expect(ar!.n).toBe('0');
  });

  it('phân bổ chi phí chung vào DA01, DA02 tháng 10 theo chi phí trực tiếp; tổng 6421, 6422 của công ty không đổi', async () => {
    const w = g6.phanBoVuViec;
    const pb = await q<{ code: string; proj: string | null; dr: string; cr: string }>(sql`SELECT a.code, p.code AS proj, sum(l.debit)::text AS dr, sum(l.credit)::text AS cr FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id AND l.posting_date = v.posting_date
      JOIN account a ON a.id = l.account_id LEFT JOIN project p ON p.id = l.project_id WHERE v.tenant_id = ${tenantId}::uuid AND v.voucher_type = 'PB' AND v.source_doc_type = 'project_alloc' AND v.state = 'posted'
      AND v.posting_date = ${w.ngay}::date AND a.code IN ('6421', '6422') GROUP BY 1, 2`);
    const of = (code: string, proj: string | null) => pb.find((r) => r.code === code && r.proj === proj);
    for (const code of ['6421', '6422']) {
      expect(of(code, 'DA01')!.dr, `${code} DA01`).toBe(w.chia[code].DA01);
      expect(of(code, 'DA02')!.dr, `${code} DA02`).toBe(w.chia[code].DA02);
      expect(of(code, null)!.cr, `${code} quỹ chưa gắn`).toBe(w[`quy${code}`]);
    }
    // Quỹ 6422 gồm lương quản lý chưa gắn vụ việc cộng phần 6422 sẵn có của tháng 10 ngoài LU và PB phân bổ vụ việc.
    const [pool] = await q<{ n: string }>(sql`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id AND l.posting_date = v.posting_date JOIN account a ON a.id = l.account_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted', 'reversed') AND a.code = '6422' AND l.project_id IS NULL AND l.posting_date BETWEEN '2026-10-01' AND '2026-10-31'
      AND v.voucher_type <> 'LU' AND v.source_doc_type IS DISTINCT FROM 'project_alloc'`);
    expect(pool!.n).toBe(w.quy6422Khac);
    const [direct] = await q<{ n: string }>(sql`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id AND l.posting_date = v.posting_date JOIN account a ON a.id = l.account_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.voucher_type = 'LU' AND a.code = '6422' AND l.project_id IS NOT NULL`);
    expect(BigInt(direct!.n)).toBe(3n * (BigInt(w.chiPhiTrucTiep.DA01) + BigInt(w.chiPhiTrucTiep.DA02))); // lương NV03, NV04 gắn vụ việc cả ba tháng 10, 11, 12
    // Chứng từ phân bổ chỉ chuyển giữa chưa gắn và vụ việc: từng tài khoản 6421, 6422 cân về 0 nên tổng của công ty không đổi.
    const net = await q<{ code: string; n: string }>(sql`SELECT a.code, sum(l.debit - l.credit)::text AS n FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id JOIN account a ON a.id = l.account_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.source_doc_type = 'project_alloc' AND v.state = 'posted' GROUP BY 1 ORDER BY 1`);
    expect(net.map((r) => [r.code, r.n])).toEqual([['6421', '0'], ['6422', '0']]);
  });

  it('sổ cái: Σ Nợ = Σ Có toàn năm; cân đối kế toán mỗi cuối tháng 10, 11, 12', async () => {
    const [t] = await q<{ dr: string; cr: string }>(sql`SELECT sum(l.debit)::text AS dr, sum(l.credit)::text AS cr FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted', 'reversed')`);
    expect(t!.dr).toBe(t!.cr);
    for (const m of MONTHS) await assertBalanceSheet(ctx, cookie, eom(m));
  });
});
