import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crc16ccitt } from '@kt/domain';
import { createTestApp, setupBankTenant, type BankTenant } from './helpers.js';
import type { TestApp } from '../helpers.js';

let ctx: TestApp; let a: BankTenant; let b: BankTenant;
beforeAll(async () => { ctx = await createTestApp(); a = await setupBankTenant(ctx, `BQR${Date.now()}`); b = await setupBankTenant(ctx, `BQS${Date.now()}`); });
afterAll(async () => { await ctx.close(); });

const call = (t: BankTenant, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => ctx.app.inject({ method, url, headers: { cookie: t.cookie }, ...(payload ? { payload } : {}) });
const L = (accountCode: string, debit: string, credit = '0', extra: object = {}) => ({ accountCode, debit, credit, ...extra });
const setBin = async (t: BankTenant) => {
  const list = (await call(t, 'GET', '/api/catalogs/bank?q=VCB')).json() as { rows: { id: string | number; code: string }[] };
  const r = await call(t, 'PUT', `/api/catalogs/bank/${list.rows.find((x) => x.code === 'VCB')!.id}`, { napas_bin: '970436' });
  expect(r.statusCode, r.body).toBe(200);
};
async function pkt(t: BankTenant, party: string, amount: string) {
  await call(t, 'POST', '/api/catalogs/party', { code: party, name: `Khách ${party}`, is_customer: true });
  const r = await call(t, 'POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-03-01', documentDate: '2026-03-01', partyCode: party, autoPost: true, lines: [L('131', amount, '0', { partyCode: party }), L('5113', '0', amount)] });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string };
}

describe('VietQR', () => {
  it('BIN NAPAS của ngân hàng chỉ nhận 6 chữ số', async () => {
    const list = (await call(a, 'GET', '/api/catalogs/bank?q=VCB')).json() as { rows: { id: string | number }[] };
    const bad = await call(a, 'PUT', `/api/catalogs/bank/${list.rows[0]!.id}`, { napas_bin: '12345' });
    expect(bad.statusCode).toBe(400);
  });

  it('mã QR chỉ lập cho hóa đơn bán đã ghi sổ (HDB, BH)', async () => {
    await setBin(a);
    const v = await pkt(a, 'KHQR1', '1000000');
    const r = await call(a, 'GET', `/api/vouchers/${v.id}/vietqr`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('QR_VOUCHER_STATE');
  });

  it('không có tài khoản ngân hàng nào khai BIN thì báo rõ', async () => {
    const r = await call(b, 'GET', `/api/vouchers/${(await pkt(b, 'KHQR2', '500000')).id}/vietqr`);
    expect(r.statusCode).toBe(409);
  });

  it('biên bản đối chiếu công nợ còn nợ in mã QR theo số còn phải thu; hết nợ hoặc chưa có BIN thì không có QR', async () => {
    await pkt(a, 'KHQR3', '2500000');
    const q = '/api/reports/arap/statement?accountCode=131&partyCode=KHQR3&from=2026-03-01&to=2026-03-31&format=html';
    const html = (await call(a, 'GET', q)).body;
    expect(html).toContain('VietQR');
    expect(html).toContain('<svg');
    expect(html).toContain('2.500.000');
    await pkt(b, 'KHQR3', '2500000');
    expect((await call(b, 'GET', q)).body).not.toContain('VietQR'); // công ty b chưa khai BIN
  });

  it('crc16ccitt dùng chung với trình duyệt: "123456789" → 29B1', () => { expect(crc16ccitt('123456789')).toBe('29B1'); });
});
