import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { seedAbcFull } from '../../scripts/seed-abc.js';
import { createTestApp, type TestApp } from '../helpers.js';
import { assertBalanceSheet } from '../invariants/helpers.js';

// Kỳ vọng tính tay (trường calc ghi phép tính), không sinh từ mã đang kiểm.
const read = (f: string) => JSON.parse(readFileSync(new URL(`../../../../packages/db/src/seed/${f}`, import.meta.url), 'utf8'));
const gd2 = read('expected-gd2-abc.json'); const gd3 = read('expected-gd3-abc.json'); const gd4 = read('expected-gd4-abc.json');

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
const q = <T>(s: ReturnType<typeof sql<T>>) => s.execute(ctx.t.admin).then((r) => r.rows);
type PerMonth = Record<string, Record<string, string>>; // mã thẻ/khế ước -> tháng -> số tiền

describe('Bộ dữ liệu mẫu ABC có tài sản, công cụ dụng cụ, khế ước vay (GĐ4): số tính tay', () => {
  it('số dư cuối năm = GĐ2 + GĐ3 + chênh lệch GĐ4 (tổng chênh lệch GĐ4 bằng 0)', async () => {
    expect(Object.values(gd4.chenhLechSoDuCuoiNam as Record<string, string>).reduce((s, v) => s + BigInt(v), 0n)).toBe(0n);
    const by: Record<string, bigint> = {};
    for (const x of (await get('/api/balances?asOf=2026-12-31')).rows as { accountCode: string; debit: string; credit: string }[]) by[x.accountCode] = (by[x.accountCode] ?? 0n) + BigInt(x.debit) - BigInt(x.credit);
    for (const [code, d] of Object.entries(gd4.chenhLechSoDuCuoiNam as Record<string, string>))
      expect((by[code] ?? 0n).toString(), code).toBe((BigInt(gd2.soDuCuoiNam[code] ?? '0') + BigInt(gd3.chenhLechSoDuCuoiNam[code] ?? '0') + BigInt(d)).toString());
  });

  it('khấu hao TSCĐ, phân bổ CCDC và chi phí trả trước từng tháng của từng thẻ', async () => {
    const rows = await q<{ code: string; m: number; amt: string }>(sql`SELECT s.code, extract(month FROM v.posting_date)::int AS m, sum(l.credit - l.debit)::text AS amt
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.tenant_id = l.tenant_id JOIN asset s ON s.id = l.asset_id AND s.tenant_id = l.tenant_id JOIN account ac ON ac.id = l.account_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.source_doc_type = 'asset_run' AND v.state IN ('posted', 'reversed')
        AND ac.code = CASE WHEN s.kind = 'fixed' THEN s.depreciation_account_code ELSE s.asset_account_code END
      GROUP BY 1, 2 HAVING sum(l.credit - l.debit) <> 0 ORDER BY 1, 2`);
    const got: PerMonth = {};
    for (const r of rows) (got[r.code] ??= {})[String(r.m)] = r.amt;
    const want: PerMonth = {};
    for (const grp of ['khauHao', 'phanBoCongCu', 'phanBoChiPhiTraTruoc']) for (const [code, v] of Object.entries(gd4[grp] as Record<string, { theoKy: Record<string, string> }>)) want[code] = v.theoKy;
    expect(got).toEqual(want);
  });

  it('lãi vay từng tháng của khế ước (kể cả tháng đổi lãi suất 07/2026), tổng bằng 635 và 335', async () => {
    const rows = await q<{ code: string; m: number; amt: string }>(sql`SELECT c.code, extract(month FROM v.posting_date)::int AS m, sum(l.credit - l.debit)::text AS amt
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.tenant_id = l.tenant_id JOIN contract c ON c.id = l.contract_id AND c.tenant_id = l.tenant_id JOIN account ac ON ac.id = l.account_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.source_doc_type = 'loan_interest' AND v.state IN ('posted', 'reversed') AND ac.code = '335' GROUP BY 1, 2 HAVING sum(l.credit - l.debit) <> 0 ORDER BY 1, 2`);
    const got: PerMonth = {};
    for (const r of rows) (got[r.code] ??= {})[String(r.m)] = r.amt;
    expect(got).toEqual(Object.fromEntries(Object.entries(gd4.laiVay as Record<string, { theoKy: Record<string, string> }>).map(([k, v]) => [k, v.theoKy])));
  });

  it('chứng từ biến động TS: ghi tăng XDCB, đánh giá lại, ghi giảm CCDC, thanh lý khớp từng tài khoản', async () => {
    const rows = await q<{ date: string; code: string; net: string }>(sql`SELECT v.posting_date::text AS date, a.code, sum(l.debit - l.credit)::text AS net
      FROM voucher v JOIN voucher_line l ON l.voucher_id = v.id AND l.posting_date = v.posting_date JOIN account a ON a.id = l.account_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.voucher_type = 'TS' AND v.state = 'posted' GROUP BY 1, 2 HAVING sum(l.debit - l.credit) <> 0 ORDER BY 1, 2`);
    const got: Record<string, Record<string, string>> = {};
    for (const r of rows) (got[r.date] ??= {})[r.code] = r.net;
    const want: Record<string, Record<string, string>> = {};
    for (const grp of ['ghiTangXdcb', 'danhGiaLai', 'ghiGiamCongCu', 'thanhLy'])
      for (const e of Object.values(gd4[grp] as Record<string, { ngay: string; dong: [string, string, string, string][] }>)) {
        const by = (want[e.ngay] ??= {});
        for (const [acc, , dr, cr] of e.dong) by[acc] = ((BigInt(by[acc] ?? '0')) + BigInt(dr) - BigInt(cr)).toString();
        for (const k of Object.keys(by)) if (by[k] === '0') delete by[k];
      }
    expect(got).toEqual(want);
  });

  it('B01 TT133: nguyên giá TSCĐ (dòng 151) và hao mòn lũy kế (dòng 152) khớp sổ và số tính tay', async () => {
    const rl = await ctx.app.inject({ method: 'POST', url: '/api/report-defs/B01/reload', headers: { cookie }, payload: { regime: 'TT133' } });
    expect(rl.statusCode, rl.body).toBe(200);
    const r = (await get('/api/reports/financial/B01?from=2026-01-01&to=2026-12-31')).rows as { lineCode: string; current: string }[];
    const line = (c: string) => r.find((x) => x.lineCode === c)!.current;
    expect(line('151')).toBe(gd4.b01['151']);
    expect(line('152').replace('-', '')).toBe(gd4.b01['152']); // chỉ tiêu hao mòn trình bày số âm
    expect(r.find((x) => x.lineCode === '141')!.current).toBe(gd3.bangCanDoiKho.B01_141); // 153 về 0, hàng tồn kho GĐ3 không đổi
  });

  it('quy trình cuối kỳ tháng 1-12: các bước tài sản, lãi vay đều xong (hoặc bỏ qua vì không có phát sinh), không bước nào phải chạy lại; bảng cân đối cân cuối tháng', async () => {
    for (let m = 1; m <= 12; m++) {
      const st = (await get(`/api/period-close/2026/${m}`)).steps as { key: string; status: string }[];
      for (const k of ['tool', 'prepaid', 'depreciation', 'loan_interest']) expect(['done', 'skipped_empty'], `${m}/${k}`).toContain(st.find((s) => s.key === k)!.status);
      await assertBalanceSheet(ctx, cookie, new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10));
    }
  });

  it('số chứng từ GĐ4 theo loại', async () => {
    const by = Object.fromEntries((await q<{ t: string; n: number }>(sql`SELECT voucher_type AS t, count(*)::int AS n FROM voucher WHERE tenant_id = ${tenantId}::uuid AND voucher_type = ANY(${Object.keys(gd4.soChungTuThem.counts)}::text[]) GROUP BY 1`)).map((x) => [x.t, x.n]));
    for (const [t, n] of Object.entries(gd4.soChungTuThem.counts as Record<string, number>))
      expect(by[t], t).toBe((gd2.soChungTu.counts[t] ?? 0) + (gd3.soChungTuThem.counts[t] ?? 0) + n);
  });
});
