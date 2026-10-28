import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';
import { findDuplicates } from '../src/modules/tools/dedupe.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let ctx: TestApp; let cookie: string; let tenantId: string; let userId: string; let truong: string; let vien: string;
type Row = { id: string; voucherType: string; voucherNo: string | null; postingDate: string; state: string; partyName: string | null; totalDebit: string };
type Pair = { a: Row; b: Row; reasons: string[] };
type Result = { pairs: Pair[]; truncated: boolean; hiddenBySensitive: boolean };
const call = (method: 'GET' | 'POST', url: string, payload?: object, c = cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
const dups = async (qs = 'from=2026-01-01&to=2026-12-31', c = cookie) => { const r = await call('GET', `/api/tools/duplicates?${qs}`, undefined, c); expect(r.statusCode, r.body).toBe(200); return (r.json() as Result).pairs; };
const raw = async (qs = 'from=2026-01-01&to=2026-12-31', c = cookie) => (await call('GET', `/api/tools/duplicates?${qs}`, undefined, c)).json() as Result;
// Tiền nhỏ để không lệch số liệu; mỗi cặp một số tiền riêng nên các cặp không lẫn nhau.
const mk = async (voucherType: 'PC' | 'BN', date: string, amount: string, o: { party?: string | null; debit?: string; autoPost?: boolean; bank?: string } = {}) => {
  const party = o.party === undefined ? 'NCC1' : o.party;
  const cash = voucherType === 'PC' ? '1111' : '1121';
  const r = await call('POST', '/api/vouchers', { voucherType, postingDate: date, documentDate: date, description: `${voucherType} ${amount}`, ...(party ? { partyCode: party } : {}),
    ...(voucherType === 'BN' ? { bankAccountNo: '0011001' } : {}), autoPost: o.autoPost ?? true,
    lines: [{ accountCode: o.debit ?? '331', debit: amount, credit: '0', ...(party && (o.debit ?? '331') === '331' ? { partyCode: party } : {}) }, { accountCode: cash, debit: '0', credit: amount }] });
  expect(r.statusCode, r.body).toBe(201); return r.json().id as string;
};
const pairOf = (ps: Pair[], total: string) => ps.find((p) => p.a.totalDebit === total);
const ids = (p: Pair) => [p.a.id, p.b.id].sort();
// Bảng kê hóa đơn chỉ ghi được khi chứng từ còn nháp (trigger), nên chèn bằng kết nối owner lúc nháp rồi mới ghi sổ. Cùng hóa đơn trên hai chứng từ mà API từ chối nhập (kiểm trùng) vẫn có thể có sẵn trong dữ liệu cũ.
const withInvoice = async (type: 'PC' | 'BN', date: string, amount: string, no: string, serial = 'c26 taa') => {
  const id = await mk(type, date, amount, { autoPost: false });
  await ctx.t.admin.insertInto('voucher_invoice').values({ tenant_id: tenantId, voucher_id: id, direction: 'purchase', serial, invoice_no: no, invoice_date: '2026-01-01', party_tax_code: '0312345678', base_amount: '1', tax_amount: '0' }).execute();
  expect((await call('POST', `/api/vouchers/${id}/post`)).statusCode).toBe(200);
  return id;
};

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId, userId } = await bootstrapTenant(ctx, { code: `KT${Date.now()}` }));
  await call('POST', '/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' });
  for (const [code, name] of [['NCC1', 'Nhà cung cấp 1'], ['NCC2', 'Nhà cung cấp 2']]) await call('POST', '/api/catalogs/party', { code, name, is_vendor: true });
  await call('POST', '/api/catalogs/bank', { code: 'VCB', name: 'Vietcombank' });
  await call('POST', '/api/catalogs/bank_account', { bank_code: 'VCB', account_no: '0011001', gl_account_code: '1121' });
  const user = async (roleCode: string) => {
    const username = `dd_${roleCode}_${Date.now()}`;
    expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags: [] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
  };
  truong = await user('ketoan_truong'); vien = await user('ketoan_vien');
});
afterAll(async () => { await ctx.close(); });

describe('khử trùng chứng từ', () => {
  it('PC và BN cùng NCC, cùng số tiền, cách 2 ngày: một cặp có lý do; cách 5 ngày thì không', async () => {
    const pc = await mk('PC', '2026-03-10', '1000'); const bn = await mk('BN', '2026-03-12', '1000');
    await mk('PC', '2026-04-10', '2000'); await mk('BN', '2026-04-15', '2000');
    const ps = await dups();
    const p = pairOf(ps, '1000')!;
    expect(ids(p)).toEqual([pc, bn].sort());
    expect([p.a.voucherType, p.b.voucherType]).toEqual(['PC', 'BN']);
    expect(p.reasons).toEqual(['Cùng số tiền', 'Cách nhau 2 ngày', 'Cùng đối tượng', 'Cùng tài khoản đối ứng']);
    expect(pairOf(ps, '2000')).toBeUndefined();
  });

  it('khác đối tượng, khác tài khoản đối ứng, hóa đơn khác nhau: không phải cặp trùng', async () => {
    await mk('PC', '2026-05-10', '3100'); await mk('BN', '2026-05-10', '3100', { party: 'NCC2' }); // khác đối tượng
    await mk('PC', '2026-05-11', '3200'); await mk('BN', '2026-05-11', '3200', { debit: '6422' }); // 331 so với 6422
    await withInvoice('PC', '2026-05-12', '3300', '0000001'); await withInvoice('BN', '2026-05-12', '3300', '0000002'); // cả hai có hóa đơn nhưng khác số
    const ps = await dups();
    for (const t of ['3100', '3200', '3300']) expect(pairOf(ps, t), t).toBeUndefined();
  });

  it('cặp chung một hóa đơn xếp trước dù ngày cũ hơn, có lý do "Cùng hóa đơn"; so khóa không phân biệt hoa thường và khoảng trắng', async () => {
    await withInvoice('PC', '2026-06-01', '4000', '0000099'); await withInvoice('BN', '2026-06-01', '4000', '0000099', 'C26TAA'); // 'c26 taa' và 'C26TAA' cùng khóa
    await mk('PC', '2026-09-01', '4100'); await mk('BN', '2026-09-01', '4100'); // mới hơn nhưng không chung hóa đơn
    const ps = await dups();
    expect(ps[0]!.a.totalDebit).toBe('4000');
    expect(ps[0]!.reasons).toContain('Cùng hóa đơn');
    expect(ps.findIndex((p) => p.a.totalDebit === '4100')).toBeGreaterThan(0);
    expect(pairOf(ps, '4100')!.reasons).not.toContain('Cùng hóa đơn');
  });

  it('bỏ qua một cặp: không hiện nữa (kể cả gọi ngược thứ tự), ghi nhật ký; id lạ 404, trùng id 400', async () => {
    const a = await mk('PC', '2026-07-01', '5000'); const b = await mk('BN', '2026-07-02', '5000');
    expect(pairOf(await dups(), '5000')).toBeDefined();
    const bad = await call('POST', '/api/tools/duplicates/ignore', { a, b: a });
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'DEDUPE_SAME_VOUCHER']);
    expect((await call('POST', '/api/tools/duplicates/ignore', { a, b: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    const [x, y] = a < b ? [b, a] : [a, b]; // thứ tự bất kỳ đều được chuẩn hóa
    expect((await call('POST', '/api/tools/duplicates/ignore', { a: x, b: y })).statusCode).toBe(200);
    expect((await call('POST', '/api/tools/duplicates/ignore', { a: y, b: x })).statusCode).toBe(200); // lặp lại không lỗi
    expect(pairOf(await dups(), '5000')).toBeUndefined();
    const row = (await sql<{ voucher_a: string; voucher_b: string; created_by: string }>`SELECT voucher_a::text, voucher_b::text, created_by::text FROM voucher_dup_ignore WHERE tenant_id = ${tenantId}::uuid`.execute(ctx.t.admin)).rows;
    expect(row).toEqual([{ voucher_a: [a, b].sort()[0], voucher_b: [a, b].sort()[1], created_by: userId }]);
    const audit = await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND entity = 'voucher_dup_ignore' AND action = 'insert'`.execute(ctx.t.admin);
    expect(audit.rows[0]!.n).toBe(1);
  });

  it('chứng từ đã đảo hoặc đã hủy không hiện; nháp hiện và biến mất khi hủy nháp', async () => {
    const a = await mk('PC', '2026-08-01', '6000'); await mk('BN', '2026-08-01', '6000');
    expect(pairOf(await dups(), '6000')).toBeDefined();
    const rev = await call('POST', `/api/vouchers/${a}/reverse`, { postingDate: '2026-08-02' });
    expect(rev.statusCode, rev.body).toBe(201);
    expect(pairOf(await dups(), '6000')).toBeUndefined(); // bản gốc đã đảo; chứng từ đảo cũng không phải ứng viên

    const d1 = await mk('PC', '2026-08-10', '6100', { autoPost: false }); await mk('BN', '2026-08-10', '6100', { autoPost: false });
    expect(pairOf(await dups(), '6100')!.a.state).toBe('draft');
    expect((await call('POST', `/api/vouchers/${d1}/discard`)).statusCode).toBe(200);
    expect(pairOf(await dups(), '6100')).toBeUndefined();
  });

  it('cặp vắt qua biên khoảng ngày vẫn được thấy khi một chứng từ nằm trong khoảng; cả hai ngoài thì không; from > to là 400', async () => {
    expect(pairOf(await dups('from=2026-03-01&to=2026-03-31'), '1000')).toBeDefined();
    expect(pairOf(await dups('from=2026-03-11&to=2026-03-31'), '1000')).toBeDefined(); // PC ngày 10 ngoài khoảng, BN ngày 12 trong khoảng
    expect(pairOf(await dups('from=2026-03-01&to=2026-03-11'), '1000')).toBeDefined(); // ngược lại: PC trong, BN ngoài
    expect(pairOf(await dups('from=2026-03-13&to=2026-03-31'), '1000')).toBeUndefined(); // cả hai ngoài khoảng
    expect((await call('GET', '/api/tools/duplicates?from=2026-04-01&to=2026-03-01')).statusCode).toBe(400);
  });

  it('cửa sổ ngày và các cờ match_* lấy từ quy tắc cấu hình', async () => {
    const rules = (await call('GET', '/api/catalogs/voucher_dup_rule?size=100')).json().rows as { id: number; type_a: string; type_b: string; days_window: number; match_party: boolean; match_counter_account: boolean; is_active: boolean }[];
    expect(rules.map((r) => `${r.type_a}/${r.type_b}`).sort()).toEqual(['HDM/BN', 'HDM/PC', 'PC/BN', 'PKT/PC', 'PKT/PT', 'PT/BC']);
    expect(rules.find((r) => r.type_a === 'PC')).toMatchObject({ days_window: 3, match_party: true, match_counter_account: true, is_active: true });
    const pcbn = rules.find((r) => r.type_a === 'PC' && r.type_b === 'BN')!;
    await mk('PC', '2026-10-01', '7000'); await mk('BN', '2026-10-08', '7000'); // cách 7 ngày
    expect(pairOf(await dups(), '7000')).toBeUndefined();
    expect((await call('PUT' as never, `/api/catalogs/voucher_dup_rule/${pcbn.id}`, { days_window: 7 })).statusCode).toBe(200);
    expect(pairOf(await dups(), '7000')!.reasons).toContain('Cách nhau 7 ngày');
    expect((await call('PUT' as never, `/api/catalogs/voucher_dup_rule/${pcbn.id}`, { days_window: 32 })).statusCode).toBe(400);
    // Tắt quy tắc thì cặp đó không còn được tìm
    expect((await call('PUT' as never, `/api/catalogs/voucher_dup_rule/${pcbn.id}`, { is_active: false })).statusCode).toBe(200);
    expect(pairOf(await dups(), '7000')).toBeUndefined();
    expect((await call('PUT' as never, `/api/catalogs/voucher_dup_rule/${pcbn.id}`, { is_active: true, days_window: 3 })).statusCode).toBe(200);
  });

  it('màn Danh mục gửi days_window dạng chuỗi (ô số VnNumberInput): lưu được; chữ hoặc ngoài 0..31 là 400', async () => {
    const rules = (await call('GET', '/api/catalogs/voucher_dup_rule?size=100')).json().rows as { id: number; type_a: string; type_b: string; days_window: number }[];
    const r = rules.find((x) => x.type_a === 'PKT' && x.type_b === 'PT')!;
    const put = (days_window: unknown) => call('PUT' as never, `/api/catalogs/voucher_dup_rule/${r.id}`, { days_window });
    expect((await put('7')).statusCode).toBe(200);
    expect((await ctx.t.admin.selectFrom('voucher_dup_rule').select('days_window').where('id', '=', r.id).executeTakeFirstOrThrow()).days_window).toBe(7);
    expect((await put('abc')).statusCode).toBe(400); expect((await put('32')).statusCode).toBe(400); expect((await put('2.5')).statusCode).toBe(400);
    expect((await put(String(r.days_window))).statusCode).toBe(200);
  });

  it('cả hai không có đối tượng: vẫn ghép (cùng không đối tượng) nhưng không nêu lý do "Cùng đối tượng"', async () => {
    await mk('PC', '2026-11-01', '8000', { party: null, debit: '6422' }); await mk('BN', '2026-11-01', '8000', { party: null, debit: '6422' });
    const p = pairOf(await dups(), '8000')!;
    expect(p.reasons).toEqual(['Cùng số tiền', 'Cùng ngày ghi sổ', 'Cùng tài khoản đối ứng']); // không đối tượng: không nêu lý do "cùng đối tượng"
  });

  it('quyền: thiếu dedupe.run là 403; thiếu cờ view_payable thì không thấy cặp có công nợ phải trả (chặn ở API)', async () => {
    expect((await call('GET', '/api/tools/duplicates?from=2026-01-01&to=2026-12-31', undefined, vien)).statusCode).toBe(403);
    expect((await call('POST', '/api/tools/duplicates/ignore', { a: '00000000-0000-4000-8000-000000000000', b: '00000000-0000-4000-8000-000000000001' }, vien)).statusCode).toBe(403);
    const r = await raw(undefined, truong); const mine = r.pairs; // kế toán trưởng có dedupe.run nhưng không cờ nhạy cảm
    expect(r.hiddenBySensitive).toBe(true); expect((await raw()).hiddenBySensitive).toBe(false); // admin có đủ cờ: không ẩn gì; màn hình dựa vào cờ này để báo
    expect(pairOf(mine, '1000')).toBeUndefined();
    expect(pairOf(mine, '8000')).toBeDefined(); // cặp 6422 không công nợ vẫn thấy
    expect(JSON.stringify(mine)).not.toMatch(/Nhà cung cấp/);
  });

  it('thiếu view_salary: cặp trên 3385 (BHTN của TT133) bị ẩn, cặp trên 3386 (ký quỹ của TT133, không thuộc nhóm lương) vẫn thấy', async () => {
    for (const code of ['3385', '3386']) { await mk('PC', '2026-08-01', code === '3385' ? '14001' : '14002', { party: null, debit: code }); await mk('BN', '2026-08-01', code === '3385' ? '14001' : '14002', { party: null, debit: code }); }
    const mine = (await raw(undefined, truong)).pairs;
    expect(pairOf(mine, '14001')).toBeUndefined(); expect(pairOf(mine, '14002')).toBeDefined();
    expect(pairOf(await dups(), '14001')).toBeDefined(); // admin có đủ cờ
  });

  it('cùng khóa có bên: ghi nhận công nợ rồi thanh toán không phải trùng; hai bút toán thanh toán giống nhau thì là trùng', async () => {
    const pkt = async (date: string, amount: string, lines: { accountCode: string; debit: string; credit: string }[]) => {
      const r = await call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: `PKT ${amount}`, partyCode: 'NCC2', autoPost: true,
        lines: lines.map((l) => ({ ...l, ...(l.accountCode === '331' ? { partyCode: 'NCC2' } : {}) })) });
      expect(r.statusCode, r.body).toBe(201);
    };
    const pay = async (date: string, amount: string) => { const r = await call('POST', '/api/vouchers', { voucherType: 'PC', postingDate: date, documentDate: date, description: `PC ${amount}`, partyCode: 'NCC2', autoPost: true,
      lines: [{ accountCode: '331', partyCode: 'NCC2', debit: amount, credit: '0' }, { accountCode: '1111', debit: '0', credit: amount }] }); expect(r.statusCode, r.body).toBe(201); };
    // Trích trước Nợ 6422 / Có 331 rồi PC trả Nợ 331 / Có 1111: bình thường, không phải trùng
    await pkt('2026-06-01', '11000', [{ accountCode: '6422', debit: '11000', credit: '0' }, { accountCode: '331', debit: '0', credit: '11000' }]); await pay('2026-06-02', '11000');
    expect(pairOf(await dups(), '11000')).toBeUndefined();
    // Phiếu kế toán ghi thanh toán Nợ 331 / Có 1111 trùng với PC cùng số tiền: là trùng
    await pkt('2026-06-01', '12000', [{ accountCode: '331', debit: '12000', credit: '0' }, { accountCode: '1111', debit: '0', credit: '12000' }]); await pay('2026-06-02', '12000');
    const p = pairOf(await dups(), '12000')!;
    expect(p.reasons).toContain('Cùng tài khoản đối ứng');
  });

  it('trần số cặp: lấy thêm một dòng để biết bị cắt; không bị cắt thì truncated = false', async () => {
    for (const amount of ['13001', '13002', '13003']) { await mk('PC', '2026-07-01', amount); await mk('BN', '2026-07-01', amount); }
    const run = (max: number) => ctx.t.admin.transaction().execute((trx) => findDuplicates(trx, tenantId, { sensitive: new Set(['view_receivable', 'view_payable', 'view_cost', 'view_salary']) }, { from: '2026-01-01', to: '2026-12-31' }, max));
    const all = await run(1000);
    expect(all.truncated).toBe(false); expect(all.pairs.length).toBeGreaterThanOrEqual(3);
    const cut = await run(2);
    expect(cut.truncated).toBe(true); expect(cut.pairs).toHaveLength(2);
    expect((await run(all.pairs.length)).truncated).toBe(false);
    expect((await raw()).truncated).toBe(false);
  });

  it('xóa chứng từ nháp kéo theo dòng bỏ qua (khóa ngoại tổng hợp, ON DELETE CASCADE)', async () => {
    const a = await mk('PC', '2026-12-01', '9000', { autoPost: false }); const b = await mk('BN', '2026-12-01', '9000', { autoPost: false });
    expect((await call('POST', '/api/tools/duplicates/ignore', { a, b })).statusCode).toBe(200);
    const count = async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher_dup_ignore WHERE tenant_id = ${tenantId}::uuid AND ${a}::uuid IN (voucher_a, voucher_b)`.execute(ctx.t.admin)).rows[0]!.n;
    expect(await count()).toBe(1);
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/vouchers/${a}`, headers: { cookie } });
    expect(del.statusCode, del.body).toBe(204);
    expect(await count()).toBe(0);
  });
});
