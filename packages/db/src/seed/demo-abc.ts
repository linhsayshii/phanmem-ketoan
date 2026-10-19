import '../env.js';
import pg from 'pg';
import argon2 from 'argon2';
import { tt99Status } from '@kt/coa-data';
import type { Regime } from '@kt/domain';
import { ensureTenant, ensureUser, generateAccountsSql, insertFiscalYear, setTenantContext } from './common.js';

// Toàn bộ dữ liệu của công ty mới, chạy trong giao dịch đang mở của seedAbcTx.
async function seedAbcData(c: pg.Client, tenantId: string, regime: Regime): Promise<void> {
  await c.query(`UPDATE tenant SET address = '12 Lý Thường Kiệt, Hoàn Kiếm, Hà Nội', legal_rep = 'Nguyễn Văn An', chief_accountant = 'Trần Thị Bình' WHERE id = $1`, [tenantId]);
  await insertFiscalYear(c, tenantId, { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime });
  await generateAccountsSql(c, tenantId, regime);
  for (const [code, name] of [['BGD', 'Ban giám đốc'], ['KD', 'Phòng kinh doanh'], ['KT', 'Phòng kế toán'], ['HC', 'Phòng hành chính']])
    await c.query('INSERT INTO department(tenant_id, code, name) VALUES ($1,$2,$3)', [tenantId, code, name]);
  // TT133 chỉ có 6421 (bán hàng) và 6422 (quản lý doanh nghiệp); TT200/TT99 dùng 6417 và 6421-6428.
  for (const [code, name, tt133, other] of [['CP_LUONG', 'Chi phí lương', '6422', '6421'], ['CP_VP', 'Văn phòng phẩm', '6422', '6422'], ['CP_THUE_VP', 'Thuê văn phòng', '6422', '6427'],
    ['CP_DIEN', 'Điện nước', '6422', '6427'], ['CP_KHAC', 'Chi phí khác', '6422', '6428'], ['CP_QC', 'Quảng cáo', '6421', '6417']])
    await c.query('INSERT INTO cost_item(tenant_id, code, name, default_account_code) VALUES ($1,$2,$3,$4)', [tenantId, code, name, regime === 'TT133' ? tt133 : other]);
  const bad = await c.query(`SELECT code FROM cost_item ci WHERE tenant_id = $1 AND default_account_code IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM account a WHERE a.tenant_id = ci.tenant_id AND a.code = ci.default_account_code)`, [tenantId]);
  if (bad.rows.length) throw new Error(`Khoản mục chi phí trỏ tới tài khoản không có trong hệ thống ${regime}: ${bad.rows.map((r) => r.code).join(', ')}`);
  const g = await c.query(`INSERT INTO party_group(tenant_id, code, name) VALUES ($1,'KH_DN','Khách hàng doanh nghiệp'),($1,'NCC','Nhà cung cấp') RETURNING id, code`, [tenantId]);
  const gid = (code: string) => g.rows.find((r) => r.code === code).id;
  for (let i = 1; i <= 20; i++)
    await c.query(`INSERT INTO party(tenant_id, code, name, is_customer, group_id, tax_code, address, payment_term_days, default_account_code) VALUES ($1,$2,$3,true,$4,$5,$6,30,'131')`,
      [tenantId, `KH${String(i).padStart(3, '0')}`, `Công ty Cổ phần Khách hàng ${i}`, gid('KH_DN'), `01012345${String(i).padStart(2, '0')}`, `Số ${i} đường Láng, Hà Nội`]);
  for (let i = 1; i <= 10; i++)
    await c.query(`INSERT INTO party(tenant_id, code, name, is_vendor, group_id, tax_code, address, payment_term_days, default_account_code) VALUES ($1,$2,$3,true,$4,$5,$6,15,'331')`,
      [tenantId, `NCC${String(i).padStart(3, '0')}`, `Công ty TNHH Nhà cung cấp ${i}`, gid('NCC'), `03098765${String(i).padStart(2, '0')}`, `Số ${i} Nguyễn Trãi, Hà Nội`]);
  await c.query(`INSERT INTO project(tenant_id, code, name, party_id) SELECT $1, 'DA01', 'Dự án triển khai phần mềm A', id FROM party WHERE tenant_id = $1 AND code = 'KH001'`, [tenantId]);
  await c.query(`INSERT INTO project(tenant_id, code, name, party_id) SELECT $1, 'DA02', 'Dự án tư vấn B', id FROM party WHERE tenant_id = $1 AND code = 'KH002'`, [tenantId]);
  await c.query(`INSERT INTO exchange_rate(tenant_id, currency_code, rate_date, rate_type, rate) VALUES ($1,'USD','2026-01-02','transfer_avg',25350),($1,'USD','2026-01-15','transfer_avg',25400),($1,'USD','2026-02-02','transfer_avg',25450)`, [tenantId]);
  const b = await c.query(`INSERT INTO bank(tenant_id, code, name, short_name) VALUES ($1,'VCB','Ngân hàng TMCP Ngoại thương Việt Nam','Vietcombank') RETURNING id`, [tenantId]);
  await c.query(`INSERT INTO bank_account(tenant_id, bank_id, account_no, account_name, branch, currency_code, gl_account_code) VALUES ($1,$2,'0011001234567','CONG TY TNHH THUONG MAI ABC','Sở giao dịch','VND','1121')`, [tenantId, b.rows[0].id]);
}

// Một giao dịch duy nhất cho người dùng, công ty và dữ liệu: lỗi ở bất kỳ bước nào thì không còn gì lại.
// `code` và `afterTenant` chỉ để kiểm thử (tạo công ty mã khác, giả lập lỗi sau khi tạo công ty).
export async function seedAbcTx(c: pg.Client, o: { code?: string; afterTenant?: () => Promise<void> } = {}): Promise<{ tenantId: string; created: boolean }> {
  const hash = await argon2.hash('Matkhau1!', { type: argon2.argon2id });
  await c.query('BEGIN');
  try {
    const admin = await ensureUser(c, 'admin', hash, 'Quản trị hệ thống');
    await c.query(`SELECT set_config('app.current_user', $1, true)`, [admin]); // để nhật ký kiểm toán của create_tenant cũng mang người dùng
    const t = await ensureTenant(c, { code: o.code ?? 'ABC', name: 'Công ty TNHH Thương mại ABC', taxCode: '0101234567', ownerUserId: admin });
    if (t.created) {
      await o.afterTenant?.();
      const regime: Regime = tt99Status().complete ? 'TT99' : 'TT133';
      if (regime === 'TT133') console.warn('CẢNH BÁO: tt99.csv chưa hoàn tất, công ty mẫu dùng TT133');
      await setTenantContext(c, t.id, admin);
      await seedAbcData(c, t.id, regime);
    }
    await c.query('COMMIT');
    return { tenantId: t.id, created: t.created };
  } catch (e) { await c.query('ROLLBACK'); throw e; }
}

export async function seedAbc(adminUrl: string): Promise<{ tenantId: string; created: boolean }> {
  const c = new pg.Client({ connectionString: adminUrl }); await c.connect();
  try { return await seedAbcTx(c); } finally { await c.end(); }
}

if (process.argv[1] && process.argv[1].endsWith('demo-abc.ts')) {
  const r = await seedAbc(process.env.DATABASE_ADMIN_URL!);
  console.log(r.created ? `Đã tạo công ty mẫu ABC (${r.tenantId}); đăng nhập admin / Matkhau1!` : `Công ty ABC đã có (${r.tenantId})`);
}
