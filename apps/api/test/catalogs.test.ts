import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => { ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `DM${Date.now()}` })); });
afterAll(async () => { await ctx.close(); });

const SAMPLES: Record<string, Record<string, unknown>> = {
  party_group: { code: 'KH_LE', name: 'Khách lẻ' },
  party: { code: 'KH001', name: 'Công ty Cổ phần Alpha', is_customer: true, tax_code: '0101234567', address: 'Hà Nội', payment_term_days: 30, credit_limit: '500000000', group_code: 'KH_LE' },
  department: { code: 'KD', name: 'Phòng kinh doanh' },
  employee: { code: 'NV01', name: 'Nguyễn Văn A', department_code: 'KD' },
  bank: { code: 'VCB', name: 'Ngân hàng TMCP Ngoại thương Việt Nam', short_name: 'Vietcombank' },
  bank_account: { account_no: '0011001234567', account_name: 'CONG TY ABC', bank_code: 'VCB', currency_code: 'VND', gl_account_code: '1121' },
  cost_item: { code: 'CP_VP', name: 'Chi phí văn phòng phẩm', default_account_code: '6422' },
  project: { code: 'DA01', name: 'Dự án 01', party_code: 'KH001' },
  uom: { code: 'KG', name: 'Kilogram' },
  exchange_rate: { currency_code: 'USD', rate_date: '2026-01-15', rate_type: 'transfer_avg', rate: '25400.5' },
};

describe('danh mục khung', () => {
  it('GET /api/catalogs liệt kê định nghĩa có cột và nhãn tiếng Việt', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/catalogs', headers: { cookie } });
    const names = (r.json() as { name: string; label: string; columns: unknown[] }[]).map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(['party', 'department', 'employee', 'currency', 'exchange_rate', 'bank', 'bank_account', 'payment_method', 'tax_code', 'invoice_group', 'cost_item', 'project', 'uom', 'party_group']));
    expect((r.json() as { name: string; label: string }[]).find((d) => d.name === 'party')!.label).toBe('Đối tượng');
  });

  it('công ty mới có sẵn loại tiền, hình thức thanh toán, loại thuế, nhóm hóa đơn, đơn vị tính', async () => {
    const tax = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/tax_code', headers: { cookie } });
    expect((tax.json().rows as { code: string }[]).map((x) => x.code)).toEqual(expect.arrayContaining(['V0', 'V5', 'V8', 'V10', 'KCT', 'NK', 'TTDB']));
    const cur = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/currency', headers: { cookie } });
    expect((cur.json().rows as { code: string }[]).map((x) => x.code)).toEqual(expect.arrayContaining(['VND', 'USD']));
  });

  for (const [name, sample] of Object.entries(SAMPLES)) {
    it(`CRUD ${name}`, async () => {
      const c = await ctx.app.inject({ method: 'POST', url: `/api/catalogs/${name}`, headers: { cookie }, payload: sample });
      expect(c.statusCode, c.body).toBe(201);
      const id = c.json().id as string;
      const one = await ctx.app.inject({ method: 'GET', url: `/api/catalogs/${name}/${id}`, headers: { cookie } });
      expect(one.statusCode).toBe(200);
      if ('name' in sample) {
        const u = await ctx.app.inject({ method: 'PUT', url: `/api/catalogs/${name}/${id}`, headers: { cookie }, payload: { name: `${sample.name} (sửa)` } });
        expect(u.statusCode).toBe(200);
        const list = await ctx.app.inject({ method: 'GET', url: `/api/catalogs/${name}?q=${encodeURIComponent('(sửa)')}`, headers: { cookie } });
        expect(list.json().total).toBe(1);
      }
    });
  }

  it('xóa đối tượng đang được dự án tham chiếu bị 409; trùng mã bị 409; tham chiếu sai mã báo cột', async () => {
    const parties = await ctx.app.inject({ method: 'GET', url: '/api/catalogs/party?q=KH001', headers: { cookie } });
    const id = parties.json().rows[0].id;
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/catalogs/party/${id}`, headers: { cookie } });
    expect(del.statusCode).toBe(409); expect(del.json().error.code).toBe('REFERENCED');
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/department', headers: { cookie }, payload: { code: 'KD', name: 'Trùng' } });
    expect(dup.statusCode).toBe(409);
    const badFk = await ctx.app.inject({ method: 'POST', url: '/api/catalogs/employee', headers: { cookie }, payload: { code: 'NV02', name: 'B', department_code: 'KHONG_CO' } });
    expect(badFk.json().error).toMatchObject({ code: 'LOOKUP_NOT_FOUND', message: expect.stringContaining('department_code') });
  });

  it('mọi thay đổi danh mục ghi audit_event có giá trị trước/sau', async () => {
    const ev = await sql<{ action: string; before: { name?: string } | null; after: { name?: string } | null }>`
      SELECT action, before, after FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = 'department' ORDER BY id`.execute(ctx.t.admin);
    expect(ev.rows.map((e) => e.action)).toEqual(expect.arrayContaining(['insert', 'update']));
    const upd = ev.rows.find((e) => e.action === 'update')!;
    expect(upd.before!.name).toBe('Phòng kinh doanh'); expect(upd.after!.name).toBe('Phòng kinh doanh (sửa)');
  });

  it('phân trang theo size/page, total là tổng số dòng', async () => {
    const pages = await Promise.all([1, 2, 3].map((page) => ctx.app.inject({ method: 'GET', url: `/api/catalogs/tax_code?size=3&page=${page}`, headers: { cookie } })));
    const rows = pages.map((r) => r.json() as { rows: { code: string }[]; total: number });
    expect(rows.map((r) => r.rows.length)).toEqual([3, 3, 2]);
    expect(rows.every((r) => r.total === 8)).toBe(true);
    expect(new Set(rows.flatMap((r) => r.rows.map((x) => x.code))).size).toBe(8);
  });

  it('người chỉ xem đọc được danh mục nhưng thêm/sửa/xóa bị 403', async () => {
    const admin = await bootstrapTenant(ctx, { code: `DX${Date.now()}` });
    const username = `xem_dm_${Date.now()}`;
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin.cookie }, payload: { username, fullName: 'Xem', password: TEST_PASSWORD, roleCode: 'xem' } });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
    const headers = { cookie: `sid=${login.cookies.find((c) => c.name === 'sid')!.value}` };
    const uom = (await ctx.app.inject({ method: 'GET', url: '/api/catalogs/uom?q=CAI', headers })).json().rows[0] as { id: string };
    expect((await ctx.app.inject({ method: 'GET', url: '/api/catalogs/uom', headers })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/catalogs/uom', headers, payload: { code: 'X', name: 'X' } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/catalogs/uom/${uom.id}`, headers, payload: { name: 'Sửa' } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/catalogs/uom/${uom.id}`, headers })).statusCode).toBe(403);
  });
});
