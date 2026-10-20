import '../env.js';
import pg from 'pg';
import argon2 from 'argon2';
import { isReportComplete } from '@kt/coa-data';
import type { Regime } from '@kt/domain';
import { ensureTenant, ensureUser, generateAccountsSql, insertDefaultClosingSteps, insertFiscalYear, setTenantContext } from './common.js';

const FY = 2026;
const M = (n: number) => String(n * 1_000_000);
// Mã tài khoản theo thứ tự ưu tiên; hệ không có mã đầu thì lấy mã sau (TT133 không có 6427 và 8211: thuê văn phòng ghi 6422, thuế TNDN ghi 821).
// Kiểm thử đối chiếu dùng lại bảng này để quy khóa của expected-bctc-xyz.json về đúng tài khoản của hệ.
export const XYZ_ACCOUNT_CANDIDATES: Record<string, string[]> = {
  '5113': ['5113', '511'], '33311': ['33311', '3331'], '8211': ['8211', '821'], '6421': ['6421', '642'], '6422': ['6422', '642'], '6427': ['6427', '6422', '642'], '4111': ['4111', '411'],
};

type Line = [code: string, debit: string, credit: string, party: string | null];

// Toàn bộ dữ liệu của công ty mới, chạy trong giao dịch đang mở của seedXyzTx.
async function seedXyzData(c: pg.Client, tenantId: string, admin: string, regime: Regime): Promise<void> {
  await c.query(`UPDATE tenant SET address = '45 Trần Duy Hưng, Cầu Giấy, Hà Nội', legal_rep = 'Lê Minh Quân', chief_accountant = 'Phạm Thu Hà' WHERE id = $1`, [tenantId]);
  await insertFiscalYear(c, tenantId, { fiscalYear: FY, dateFrom: `${FY}-01-01`, months: 12, regime });
  await generateAccountsSql(c, tenantId, regime);
  await insertDefaultClosingSteps(c, tenantId);
  const acc = new Map<string, number>((await c.query('SELECT code, id FROM account WHERE tenant_id = $1 AND NOT is_group', [tenantId])).rows.map((r) => [r.code, r.id]));
  const pick = (cands: string[]) => { const f = cands.find((x) => acc.has(x)); if (!f) throw new Error(`Hệ ${regime} không có tài khoản nào trong ${cands.join(', ')}`); return f; };
  const A = (k: string) => pick(XYZ_ACCOUNT_CANDIDATES[k] ?? [k]);
  const kh = (await c.query(`INSERT INTO party(tenant_id, code, name, is_customer, tax_code) VALUES ($1,'KH001','Công ty Cổ phần Khách hàng Lớn',true,'0101111111') RETURNING id`, [tenantId])).rows[0].id;
  const ncc = (await c.query(`INSERT INTO party(tenant_id, code, name, is_vendor, tax_code) VALUES ($1,'NCC001','Công ty TNHH Cho thuê Văn phòng',true,'0102222222') RETURNING id`, [tenantId])).rows[0].id;

  // Chứng từ thật như do API tạo: nháp rồi post_voucher (cấp số, dựng cặp đối ứng, đánh dấu số dư bẩn). DK mang source_doc_type/id như màn hình Số dư đầu kỳ tạo ra.
  const voucher = async (type: 'PKT' | 'DK', date: string, desc: string, lines: Line[]) => {
    const opening = type === 'DK';
    const v = (await c.query(`INSERT INTO voucher(tenant_id, voucher_type, posting_date, document_date, description, created_by, source_doc_type, source_doc_id)
      VALUES ($1,$2,$3,$3,$4,$5,${opening ? "'opening_balance', md5($6::text)::uuid" : 'NULL, NULL'}) RETURNING id`,
      opening ? [tenantId, type, date, desc, admin, `${tenantId}:opening:${FY}`] : [tenantId, type, date, desc, admin])).rows[0].id; // cùng khóa với postOpening của API
    let n = 0;
    for (const [code, d, cr, party] of lines)
      await c.query(`INSERT INTO voucher_line(tenant_id, voucher_id, line_no, account_id, posting_date, debit, credit, party_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [tenantId, v, ++n, acc.get(code), date, d, cr, party]);
    await c.query('SELECT post_voucher($1)', [v]);
  };

  // Số dư đầu kỳ 01/01/2026: bảng nhập (màn hình Số dư đầu kỳ) và chứng từ DK đã ghi sổ.
  const tm = A('1111'), tg = A('1121'), von = A('4111');
  const opening: Line[] = [[tm, M(200), '0', null], [tg, M(800), '0', null], [von, '0', M(1000), null]];
  for (const [code, d, cr] of opening) await c.query(`INSERT INTO opening_balance(tenant_id, fiscal_year, account_id, debit, credit) VALUES ($1,$2,$3,$4,$5)`, [tenantId, FY, acc.get(code), d, cr]);
  const p0 = (await c.query(`SELECT date_from FROM fiscal_period WHERE tenant_id = $1 AND fiscal_year = $2 AND period_no = 0`, [tenantId, FY])).rows[0].date_from;
  await voucher('DK', p0, `Số dư đầu kỳ năm ${FY}`, opening);

  const pthu = A('131'), ptra = A('331'), vatIn = A('1331'), vatOut = A('33311'), luong = A('334'), dt = A('5113'), cpl = A('6421'), cpvpp = A('6422'), cpthue = A('6427');
  for (let m = 1; m <= 12; m++) {
    const d = (day: number) => `${FY}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    await voucher('PKT', d(5), `Doanh thu dịch vụ tư vấn tháng ${m}`, [[pthu, M(110), '0', kh], [dt, '0', M(100), null], [vatOut, '0', M(10), null]]);
    await voucher('PKT', d(10), `Thuê văn phòng tháng ${m}`, [[cpthue, M(20), '0', null], [vatIn, M(2), '0', null], [ptra, '0', M(22), ncc]]);
    await voucher('PKT', d(15), `Văn phòng phẩm tháng ${m}`, [[cpvpp, M(5), '0', null], [vatIn, '500000', '0', null], [tm, '0', '5500000', null]]);
    await voucher('PKT', d(20), `Thu tiền khách hàng tháng ${m}`, [[tg, M(110), '0', null], [pthu, '0', M(110), kh]]);
    await voucher('PKT', d(25), `Trả tiền thuê văn phòng tháng ${m}`, [[ptra, M(22), '0', ncc], [tg, '0', M(22), null]]);
    await voucher('PKT', d(28), `Tính lương tháng ${m}`, [[cpl, M(50), '0', null], [luong, '0', M(50), null]]);
    await voucher('PKT', d(28), `Chi lương tháng ${m}`, [[luong, M(50), '0', null], [tg, '0', M(50), null]]);
  }
  const end = `${FY}-12-31`;
  await voucher('PKT', end, `Khấu trừ thuế GTGT năm ${FY}`, [[vatOut, M(30), '0', null], [vatIn, '0', M(30), null]]);
  await voucher('PKT', end, `Thuế TNDN năm ${FY} (20%)`, [[A('8211'), M(60), '0', null], [A('3334'), '0', M(60), null]]);

  // Kết chuyển cuối năm: chạy mọi bước period_end theo thứ tự, giống POST /api/closing/run-all.
  for (const s of (await c.query(`SELECT id FROM closing_step WHERE tenant_id = $1 AND run_at = 'period_end' AND is_active ORDER BY step_order`, [tenantId])).rows)
    await c.query('SELECT run_closing_step($1,$2,$3)', [tenantId, s.id, end]);
  await c.query('SELECT recompute_balances($1)', [tenantId]);
}

// Một giao dịch duy nhất cho người dùng, công ty và dữ liệu: lỗi ở bất kỳ bước nào thì không còn gì lại (công ty dở dang sẽ làm lần chạy sau tưởng đã có).
// `code` và `afterTenant` chỉ để kiểm thử (tạo công ty mã khác, giả lập lỗi sau khi tạo công ty).
export async function seedXyzTx(c: pg.Client, o: { code?: string; afterTenant?: () => Promise<void> } = {}): Promise<{ tenantId: string; created: boolean }> {
  const hash = await argon2.hash('Matkhau1!', { type: argon2.argon2id });
  await c.query('BEGIN');
  try {
    const admin = await ensureUser(c, 'admin', hash, 'Quản trị hệ thống');
    await c.query(`SELECT set_config('app.current_user', $1, true)`, [admin]); // để nhật ký kiểm toán của create_tenant cũng mang người dùng
    const t = await ensureTenant(c, { code: o.code ?? 'XYZ', name: 'Công ty TNHH Dịch vụ Tư vấn XYZ', taxCode: '0109876543', ownerUserId: admin });
    if (t.created) {
      await o.afterTenant?.();
      const regime: Regime = isReportComplete('TT99', 'B01') ? 'TT99' : 'TT133';
      if (regime === 'TT133') console.warn('CẢNH BÁO: mẫu báo cáo TT99 (B01) chưa đối chiếu văn bản gốc, công ty mẫu dùng TT133');
      await setTenantContext(c, t.id, admin);
      await seedXyzData(c, t.id, admin, regime);
    }
    await c.query('COMMIT');
    return { tenantId: t.id, created: t.created };
  } catch (e) { await c.query('ROLLBACK'); throw e; }
}

export async function seedXyz(adminUrl: string): Promise<{ tenantId: string; created: boolean }> {
  const c = new pg.Client({ connectionString: adminUrl }); await c.connect();
  try { return await seedXyzTx(c); } finally { await c.end(); }
}

if (process.argv[1] && process.argv[1].endsWith('dich-vu-xyz.ts')) {
  const r = await seedXyz(process.env.DATABASE_ADMIN_URL!);
  console.log(r.created ? `Đã tạo công ty mẫu XYZ (${r.tenantId}); đăng nhập admin / Matkhau1!` : `Công ty XYZ đã có (${r.tenantId})`);
}
