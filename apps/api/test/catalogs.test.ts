import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '@kt/db';
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

  const post = (name: string, payload: Record<string, unknown>, headers = { cookie }) => ctx.app.inject({ method: 'POST', url: `/api/catalogs/${name}`, headers, payload });
  const auditOf = async (entity: string, entityId: string) => (await sql<{ action: string; entity_id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>`
    SELECT action, entity_id, before, after FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = ${entity} AND entity_id = ${entityId} ORDER BY id`.execute(ctx.t.admin)).rows;

  it(':id sai dạng bị 404, không phải 500', async () => {
    const put = await ctx.app.inject({ method: 'PUT', url: '/api/catalogs/party/abc', headers: { cookie }, payload: { name: 'x' } });
    expect(put.statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/catalogs/department/abc', headers: { cookie } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'DELETE', url: '/api/catalogs/uom/99999999999999999999', headers: { cookie } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/catalogs/currency/usd', headers: { cookie } })).statusCode).toBe(404);
  });

  it('số tiền, tỷ giá, thuế suất, ngày không hợp lệ bị 400 VALIDATION', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['exchange_rate', { currency_code: 'USD', rate_date: '2026-02-01', rate_type: 'buy', rate: '0' }],
      ['exchange_rate', { currency_code: 'USD', rate_date: '2026-02-30', rate_type: 'buy', rate: '25000' }],
      ['tax_code', { code: 'XX', name: 'X', kind: 'vat', rate: '1000' }],
      ['tax_code', { code: 'XX', name: 'X', kind: 'vat', rate: '100.01' }],
      ['invoice_group', { scope: 'sale', code: 'XX', name: 'X', rate: '101' }],
      ['party', { code: 'XX', name: 'X', credit_limit: '100.5' }],
      ['party', { code: 'XX', name: 'X', payment_term_days: 3651 }],
      ['project', { code: 'XX', name: 'X', budget: '-5' }],
      ['project', { code: 'XX', name: 'X', date_from: '2026-13-01' }],
      ['currency', { code: 'usd', name: 'Đô la' }],
      ['exchange_rate', { currency_code: 'usd', rate_date: '2026-02-01', rate_type: 'buy', rate: '25000' }],
      ['bank_account', { account_no: '9990002', bank_code: 'VCB', currency_code: 'usd', gl_account_code: '1121' }],
    ];
    for (const [name, payload] of cases) {
      const r = await post(name, payload);
      expect(r.statusCode, `${name} ${JSON.stringify(payload)} -> ${r.body}`).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION');
    }
  });

  it('lỗi dữ liệu của PostgreSQL (tràn số) được trả 400 VALIDATION, không phải 500', async () => {
    const r = await post('party', { code: 'KH_OVF', name: 'Tràn số', credit_limit: '9'.repeat(25) });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION');
  });

  it('khóa lạ trong thân yêu cầu bị 400; PUT thân rỗng chỉ kiểm tra dòng tồn tại', async () => {
    const r = await post('department', { code: 'D_LA', name: 'Lạ', groupCode: 'x' });
    expect(r.statusCode).toBe(400); expect(r.json().error.code).toBe('VALIDATION');
    const dept = (await ctx.app.inject({ method: 'GET', url: '/api/catalogs/department?q=KD', headers: { cookie } })).json().rows[0] as { id: string };
    const strictPut = await ctx.app.inject({ method: 'PUT', url: `/api/catalogs/department/${dept.id}`, headers: { cookie }, payload: { unknown_key: 1 } });
    expect(strictPut.statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/catalogs/department/${dept.id}`, headers: { cookie }, payload: {} })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/catalogs/department/999999999', headers: { cookie }, payload: {} })).statusCode).toBe(404);
  });

  it('currency_code không có trong danh mục loại tiền bị 404 LOOKUP_NOT_FOUND', async () => {
    const r = await post('bank_account', { account_no: '9990001', bank_code: 'VCB', currency_code: 'ZZZ', gl_account_code: '1121' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toMatchObject({ code: 'LOOKUP_NOT_FOUND', message: expect.stringContaining('currency_code') });
    const rate = await post('exchange_rate', { currency_code: 'ZZZ', rate_date: '2026-02-01', rate_type: 'buy', rate: '1' });
    expect(rate.statusCode).toBe(404); expect(rate.json().error.code).toBe('LOOKUP_NOT_FOUND');
  });

  it('xóa dòng không được tham chiếu: 204, GET sau đó 404, audit có insert (after) và delete (before)', async () => {
    const c = await post('uom', { code: 'TMP', name: 'Tạm' });
    const id = String(c.json().id);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/catalogs/uom/${id}`, headers: { cookie } })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/catalogs/uom/${id}`, headers: { cookie } })).statusCode).toBe(404);
    const ev = await auditOf('uom', id);
    expect(ev.map((e) => e.action)).toEqual(['insert', 'delete']);
    expect(ev[0]!.before).toBeNull(); expect(ev[0]!.after).toMatchObject({ code: 'TMP', name: 'Tạm' });
    expect(ev[1]!.before).toMatchObject({ code: 'TMP', name: 'Tạm' }); expect(ev[1]!.after).toBeNull();
  });

  it('currency CRUD theo mã; audit lấy entity_id là mã', async () => {
    const c = await post('currency', { code: 'EUR', name: 'Euro', symbol: '€', minor_unit: 2 });
    expect(c.statusCode, c.body).toBe(201); expect(c.json().id).toBe('EUR');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/catalogs/currency/EUR', headers: { cookie } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/catalogs/currency/EUR', headers: { cookie }, payload: { name: 'Euro (sửa)' } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/catalogs/currency/EUR', headers: { cookie } })).json().name).toBe('Euro (sửa)');
    expect((await ctx.app.inject({ method: 'DELETE', url: '/api/catalogs/currency/EUR', headers: { cookie } })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/catalogs/currency/EUR', headers: { cookie } })).statusCode).toBe(404);
    expect((await auditOf('currency', 'EUR')).map((e) => e.action)).toEqual(['insert', 'update', 'delete']);
  });

  it('công ty khác không đọc/sửa/xóa được danh mục của công ty này và không tra cứu được mã của nó', async () => {
    const b = await bootstrapTenant(ctx, { code: `DN${Date.now()}` });
    const dept = (await ctx.app.inject({ method: 'GET', url: '/api/catalogs/department?q=KD', headers: { cookie } })).json().rows[0] as { id: string; name: string };
    const url = `/api/catalogs/department/${dept.id}`;
    expect((await ctx.app.inject({ method: 'GET', url, headers: { cookie: b.cookie } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'PUT', url, headers: { cookie: b.cookie }, payload: { name: 'Chiếm' } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'PUT', url, headers: { cookie: b.cookie }, payload: {} })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'DELETE', url, headers: { cookie: b.cookie } })).statusCode).toBe(404);
    const still = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
    expect(still.statusCode).toBe(200); expect(still.json().name).toBe(dept.name);
    const lookup = await post('party', { code: 'KH_B', name: 'Của B', group_code: 'KH_LE' }, { cookie: b.cookie });
    expect(lookup.statusCode).toBe(404); expect(lookup.json().error.code).toBe('LOOKUP_NOT_FOUND');
  });

  it('app_user không gọi được seed_tenant_defaults dù RLS cho phép ghi: thiếu quyền EXECUTE (42501)', async () => {
    // Trong ngữ cảnh đúng công ty các INSERT bên trong sẽ qua RLS, nên chỉ việc thu quyền EXECUTE mới làm lệnh gọi bị từ chối.
    await expect(withTenant(ctx.t.db, { tenantId }, (trx) => sql`SELECT seed_tenant_defaults(${tenantId}::uuid)`.execute(trx)))
      .rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/permission denied for function seed_tenant_defaults/) });
  });
});
