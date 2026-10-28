import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, TEST_PASSWORD, bootstrapTenant, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
let ctx: TestApp; let owner: string; let n = 0;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, c = owner) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) });
const pkt = (date: string, description: string, partyCode: string | null, lines: object[]) =>
  call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description, ...(partyCode && { partyCode }), autoPost: true, lines });
async function userWith(roleCode: string, sensitiveFlags: string[]) {
  const username = `as_${roleCode}_${n++}_${Date.now()}`;
  expect((await call('POST', '/api/users', { username, fullName: 'X', password: TEST_PASSWORD, roleCode, sensitiveFlags })).statusCode).toBe(201);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
}
const suggest = (body: object, c = owner) => call('POST', '/api/assistant/suggest-entry', { asOf: '2026-10-28', ...body }, c);

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie: owner } = await setupLedgerTenant(ctx, `GY${Date.now()}`, 'TT133'));
  // Lịch sử: 3 lần thuê văn phòng (NCC001) Nợ 6422 / Có 1111, 1 lần mua văn phòng phẩm Nợ 242 / Có 1111, công nợ phải thu KH001, giá vốn.
  for (const [i, m] of ['03', '04', '05'].entries()) expect((await pkt(`2026-${m}-10`, `Thuê văn phòng tháng ${i + 3}`, 'NCC001', [{ accountCode: '6422', debit: '10000000' }, { accountCode: '1111', credit: '10000000' }])).statusCode).toBe(201);
  expect((await pkt('2026-06-10', 'Mua văn phòng phẩm', 'NCC001', [{ accountCode: '242', debit: '500000' }, { accountCode: '1111', credit: '500000' }])).statusCode).toBe(201);
  expect((await pkt('2026-06-11', 'Bán hàng chịu', 'KH001', [{ accountCode: '131', debit: '2000000', partyCode: 'KH001' }, { accountCode: '5113', credit: '2000000' }])).statusCode).toBe(201);
  expect((await pkt('2026-06-12', 'Giá vốn tháng 6', 'KH001', [{ accountCode: '632', debit: '900000' }, { accountCode: '1111', credit: '900000' }])).statusCode).toBe(201);
  // Chứng từ nháp và chứng từ đã đảo không được học.
  expect((await call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-07-01', documentDate: '2026-07-01', description: 'Thuê văn phòng nháp', partyCode: 'NCC001', lines: [{ accountCode: '5113', debit: '1' }, { accountCode: '1111', credit: '1' }] })).statusCode).toBe(201);
}, 180_000);
afterAll(async () => { await ctx.close(); });

describe('POST /api/assistant/suggest-entry', () => {
  it('xếp hạng theo đối tượng, loại chứng từ, từ khóa: điểm 3×(3+1+1,5) và 5; độ tin cậy 0,77', async () => {
    const r = await suggest({ voucherType: 'PKT', partyCode: 'NCC001', description: 'Thuê văn phòng tháng 10' });
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json() as Json;
    // Còn hai chữ ký chỉ khớp loại chứng từ (điểm 1 mỗi cái): giá vốn (12/6, mới hơn) đứng trước phải thu (11/6).
    expect(j.suggestions.map((s: Json) => [s.signature, s.score])).toEqual([['C:1111|N:6422', 16.5], ['C:1111|N:242', 5], ['C:1111|N:632', 1], ['C:5113|N:131', 1]]);
    expect(j.suggestions[0]).toMatchObject({ support: 3, samePartyCount: 3, lastUsed: '2026-05-10', confidence: 0.7 }); // 16,5 / 23,5
    expect(j.suggestions[0].reasons[0]).toBe('Đã dùng 3 lần cho cùng đối tượng NCC001');
    expect(j.suggestions[0].lines).toEqual([{ side: 'debit', accountCode: '6422', accountName: expect.any(String) }, { side: 'credit', accountCode: '1111', accountName: expect.any(String) }]) // đúng thứ tự dòng của chứng từ gốc;
    expect(j.considered).toBe(6); // 6 chứng từ PKT đã ghi sổ; bản nháp không học
  });
  it('số tiền gần bằng (±10%) cộng thêm 0,5 mỗi chứng từ', async () => {
    const r = await suggest({ voucherType: 'PKT', partyCode: 'NCC001', amount: '9500000' });
    expect((r.json() as Json).suggestions[0]).toMatchObject({ signature: 'C:1111|N:6422', score: 3 * (3 + 1 + 0.5), amountCount: 3 });
  });
  it('chứng từ nháp không được học: chỉ diễn giải "nháp" thì không có gợi ý nào ghi nhận 5113', async () => {
    const r = await suggest({ description: 'Thuê văn phòng nháp' }); // khớp 3 từ khóa với các chứng từ thuê, không có chữ ký 5113/1111 nào từ bản nháp
    expect((r.json() as Json).suggestions.map((s: Json) => s.signature)).not.toContain('C:1111|N:5113');
  });
  it('công ty khác không thấy lịch sử của công ty này (RLS)', async () => {
    const other = await bootstrapTenant(ctx, { code: `GZ${Date.now()}` });
    const r = await suggest({ partyCode: 'NCC001', voucherType: 'PKT' }, other.cookie);
    expect(r.statusCode).toBe(200); expect((r.json() as Json).suggestions).toEqual([]);
  });
  it('cờ nhạy cảm: thiếu view_receivable không thấy cặp 131/5113; thiếu view_cost không thấy 632; đủ cờ thì thấy', async () => {
    const none = await userWith('ketoan_vien', []); const all = await userWith('ketoan_vien', ['view_receivable', 'view_cost']);
    const codes = async (c: string) => ((await suggest({ voucherType: 'PKT', partyCode: 'KH001' }, c)).json() as Json).suggestions.map((s: Json) => s.signature) as string[];
    expect(await codes(none)).toEqual(['C:1111|N:6422', 'C:1111|N:242']); // chỉ còn khớp loại chứng từ; 131 và 632 bị che dù đúng đối tượng KH001
    expect((await codes(all)).slice(0, 2).sort()).toEqual(['C:1111|N:632', 'C:5113|N:131']); // đối tượng KH001 + loại: 4 điểm mỗi cái, đứng đầu
    expect(await codes(await userWith('ketoan_vien', ['view_cost']))).toEqual(['C:1111|N:632', 'C:1111|N:6422', 'C:1111|N:242']);
    // Người thiếu cờ vẫn thấy gợi ý không nhạy cảm của cùng loại chứng từ, và số chứng từ xét (considered) không tính chứng từ bị che.
    const j = (await suggest({ voucherType: 'PKT' }, none)).json() as Json;
    expect(j.suggestions.map((s: Json) => s.signature)).toEqual(['C:1111|N:6422', 'C:1111|N:242']);
    expect(j.considered).toBe(4);
  });
  it('quyền: cần assistant.use và voucher.view; thân thiếu đặc trưng hoặc số tiền lẻ bị 400', async () => {
    const viewer = await userWith('xem', []);
    expect((await suggest({ partyCode: 'NCC001' }, viewer)).statusCode).toBe(403);
    expect((await suggest({})).statusCode).toBe(400);
    expect((await suggest({ partyCode: 'NCC001', amount: '10.5' })).statusCode).toBe(400);
    expect((await call('POST', '/api/assistant/suggest-entry', { partyCode: 'NCC001' }, '')).statusCode).toBe(401);
  });
  it('xác định: hai lần gọi cho cùng kết quả', async () => {
    const a = (await suggest({ voucherType: 'PKT', description: 'văn phòng' })).json(); const b = (await suggest({ voucherType: 'PKT', description: 'văn phòng' })).json();
    expect(a).toEqual(b);
  });
});
