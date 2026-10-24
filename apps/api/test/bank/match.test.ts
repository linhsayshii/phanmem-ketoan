import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import ExcelJS from 'exceljs';
import { createTestApp, setupBankTenant, type BankTenant } from './helpers.js';
import type { TestApp } from '../helpers.js';

let ctx: TestApp; let a: BankTenant;
beforeAll(async () => { ctx = await createTestApp(); a = await setupBankTenant(ctx, `BMT${Date.now()}`); });
afterAll(async () => { await ctx.close(); });

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, cookie = a.cookie) => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const L = (accountCode: string, debit: string, credit = '0', extra: object = {}) => ({ accountCode, debit, credit, ...extra });
const voucher = async (body: object, post = true) => {
  const r = await call('POST', '/api/vouchers', { documentDate: '2026-03-01', ...body, autoPost: post });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; voucherNo: string; state: string };
};
// Hóa đơn bán: Nợ 131 / Có 5113, số chứng từ của khoản công nợ đặt thành số hóa đơn.
async function receivable(party: string, amount: string, docNo: string, date = '2026-03-01') {
  const v = await voucher({ voucherType: 'PKT', postingDate: date, documentDate: date, partyCode: party, lines: [L('131', amount, '0', { partyCode: party }), L('5113', '0', amount)] });
  const id = Number((await sql<{ id: string }>`SELECT id FROM open_item WHERE voucher_id = ${v.id}::uuid`.execute(ctx.t.admin)).rows[0]!.id);
  await sql`UPDATE open_item SET doc_no = ${docNo} WHERE id = ${id}`.execute(ctx.t.admin);
  return id;
}
const residual = async (id: number) => (await sql<{ r: string }>`SELECT (o.amount - coalesce((SELECT sum(amount) FROM settlement WHERE debit_item_id = o.id), 0) + coalesce((SELECT sum(amount) FROM settlement WHERE credit_item_id = o.id), 0))::text AS r FROM open_item o WHERE o.id = ${id}`.execute(ctx.t.admin)).rows[0]!.r;
const txn = async (o: { valueDate: string; amountIn?: string; amountOut?: string; description?: string }) => {
  const r = await call('POST', '/api/bank-transactions', { bankAccountId: a.accountId, ...o });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: number };
};
const getTxn = async (id: number) => (await sql<{ status: string; voucher_id: string | null }>`SELECT status, voucher_id FROM bank_transaction WHERE id = ${id}`.execute(ctx.t.admin)).rows[0]!;
const bc = (amount: string, date: string, partyCode = 'KH002') => voucher({ voucherType: 'BC', postingDate: date, documentDate: date, bankAccountNo: a.accountNo, partyCode, lines: [L('1121', amount, '0', { bankAccountNo: a.accountNo }), L('131', '0', amount, { partyCode })] });

describe('đối chiếu giao dịch ngân hàng', () => {
  it('giao dịch vào 11.000.000 "TT HD 0000123 CTY A": gợi ý khoản phải thu hóa đơn 123 điểm cao nhất', async () => {
    const i123 = await receivable('KH001', '11000000', '123');
    await receivable('KH002', '9000000', '777');
    const t = await txn({ valueDate: '2026-03-05', amountIn: '11000000', description: 'TT HD 0000123 CTY A' });
    const r = await call('POST', `/api/bank-transactions/${t.id}/suggestions`);
    expect(r.statusCode, r.body).toBe(200);
    const { suggestions, hiddenBySensitivity } = r.json();
    expect(hiddenBySensitivity).toBe(false);
    expect(suggestions[0]).toMatchObject({ kind: 'open_item', openItemId: i123, partyCode: 'KH001', invoiceNo: '123', residual: '11000000', score: 80 });
    expect(suggestions.every((s: { score: number }, k: number) => k === 0 || s.score <= suggestions[k - 1].score)).toBe(true);
  });

  it('BC đã ghi sổ cùng TK, cùng tiền, cách 1 ngày → gợi ý voucher; match → matched; match chứng từ khác tiền → 409', async () => {
    const good = await bc('3330000', '2026-03-11'); const other = await bc('3330001', '2026-03-11');
    const t = await txn({ valueDate: '2026-03-12', amountIn: '3330000', description: 'khong co so' });
    const s = (await call('POST', `/api/bank-transactions/${t.id}/suggestions`)).json().suggestions;
    expect(s[0]).toMatchObject({ kind: 'voucher', voucherId: good.id, voucherNo: good.voucherNo, amount: '3330000', score: 60 });
    expect(s.some((x: { voucherId?: string }) => x.voucherId === other.id)).toBe(false);
    const bad = await call('POST', `/api/bank-transactions/${t.id}/match`, { voucherId: other.id });
    expect(bad.statusCode, bad.body).toBe(409);
    const ok = await call('POST', `/api/bank-transactions/${t.id}/match`, { voucherId: good.id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'matched', voucherId: good.id });
    const t2 = await txn({ valueDate: '2026-03-12', amountIn: '3330000' }); // chứng từ đã gắn giao dịch khác
    expect((await call('POST', `/api/bank-transactions/${t2.id}/match`, { voucherId: good.id })).statusCode).toBe(409);
    const un = await call('POST', `/api/bank-transactions/${t.id}/unmatch`);
    expect(un.json()).toMatchObject({ status: 'new', voucherId: null });
    expect((await call('GET', `/api/vouchers/${good.id}`)).json().state).toBe('posted'); // unmatch không đụng chứng từ
  });

  it('create-voucher post=true settle hóa đơn 123: BC ghi sổ, open_item còn 0, giao dịch matched', async () => {
    const item = await receivable('KH001', '2500000', 'HD-0456', '2026-04-01');
    const t = await txn({ valueDate: '2026-04-10', amountIn: '2500000', description: 'KH001 thanh toan HD 456' });
    const r = await call('POST', `/api/bank-transactions/${t.id}/create-voucher`, { post: true, settle: [{ openItemId: item, amount: '2500000' }] });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().voucher).toMatchObject({ voucherType: 'BC', state: 'posted', purpose: 'thu_khach_hang', partyCode: 'KH001' });
    expect(await residual(item)).toBe('0');
    expect(await getTxn(t.id)).toMatchObject({ status: 'matched', voucher_id: r.json().voucher.id });
    expect((await call('POST', `/api/bank-transactions/${t.id}/create-voucher`, { post: true })).statusCode).toBe(409); // đã gắn
  });

  it('người thiếu view_receivable: không có gợi ý open_item, hiddenBySensitivity true', async () => {
    await receivable('KH001', '4200000', '888', '2026-05-01');
    const username = `bm_${Date.now()}`;
    expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: [] })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    const cookie = `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
    const t = await txn({ valueDate: '2026-05-05', amountIn: '4200000', description: 'HD 888' });
    const r = await call('POST', `/api/bank-transactions/${t.id}/suggestions`, undefined, cookie);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ suggestions: [], hiddenBySensitivity: true });
    expect((await call('POST', `/api/bank-transactions/${t.id}/suggestions`)).json().suggestions[0]).toMatchObject({ kind: 'open_item', invoiceNo: '888' });
  });

  it('bỏ ghi sổ rồi xóa BC đã gắn → giao dịch về new', async () => {
    const t = await txn({ valueDate: '2026-06-05', amountIn: '1200000', description: 'thu khac' });
    const r = await call('POST', `/api/bank-transactions/${t.id}/create-voucher`, { post: true, purposeCode: 'thu_khac' });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().voucher.id as string;
    expect(await getTxn(t.id)).toMatchObject({ status: 'matched', voucher_id: id });
    expect((await call('POST', `/api/vouchers/${id}/unpost`)).statusCode).toBe(200);
    expect(await getTxn(t.id)).toMatchObject({ status: 'new', voucher_id: id });
    expect((await call('POST', `/api/vouchers/${id}/post`)).statusCode).toBe(200);
    expect((await getTxn(t.id)).status).toBe('matched');
    await call('POST', `/api/vouchers/${id}/unpost`);
    expect((await call('POST', `/api/vouchers/${id}/discard`)).statusCode).toBe(200); // hủy: gỡ liên kết
    expect(await getTxn(t.id)).toMatchObject({ status: 'new', voucher_id: null });
    // nháp: gắn nhưng chưa matched; xóa nháp → voucher_id null
    const t2 = await txn({ valueDate: '2026-06-06', amountOut: '800000', description: 'chi khac' });
    const d = await call('POST', `/api/bank-transactions/${t2.id}/create-voucher`, { post: false, purposeCode: 'chi_khac' });
    expect(d.statusCode, d.body).toBe(201);
    expect(await getTxn(t2.id)).toMatchObject({ status: 'new', voucher_id: d.json().voucher.id });
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/vouchers/${d.json().voucher.id}`, headers: { cookie: a.cookie } })).statusCode).toBe(204);
    expect(await getTxn(t2.id)).toMatchObject({ status: 'new', voucher_id: null });
  });

  const limited = async (flags: string[]) => {
    const username = `bl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    expect((await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: flags })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
  };
  const suggested = async (id: number, text: string, amount: string) => {
    const t = await txn({ valueDate: '2026-09-05', amountIn: amount, description: text });
    return ((await call('POST', `/api/bank-transactions/${t.id}/suggestions`)).json().suggestions as { openItemId?: number }[]).map((s) => s.openItemId).includes(id);
  };

  it('so tham chiếu theo từ nguyên: số nằm trong số tiền, ngày hay số khác không khớp; số 0 đầu bỏ qua', async () => {
    const i2345 = await receivable('KH001', '1111111', '2345', '2026-09-01');
    const i2026 = await receivable('KH001', '1111112', '2026', '2026-09-01');
    const i1231 = await receivable('KH001', '1111113', '1231', '2026-09-01');
    const i99 = await receivable('KH001', '1111114', '99', '2026-09-01');
    expect(await suggested(i2345, 'CK 12.345.000', '5000001')).toBe(false);
    expect(await suggested(i2026, 'CK ngay 24/10/2026', '5000002')).toBe(false);
    expect(await suggested(i1231, 'HD 123 1 CAI', '5000003')).toBe(false);
    expect(await suggested(i99, 'TT HD 0000099', '5000004')).toBe(true);
    expect(await suggested(i2345, 'TT hoa don 2345 cam on', '5000005')).toBe(true);
  });

  it('chứng từ đảo không đối chiếu được; đảo chứng từ đã gắn thì gỡ liên kết', async () => {
    const t = await txn({ valueDate: '2026-09-10', amountIn: '640000', description: 'thu' });
    const r = await call('POST', `/api/bank-transactions/${t.id}/create-voucher`, { post: true, purposeCode: 'thu_khac' });
    const id = r.json().voucher.id as string;
    const rev = await call('POST', `/api/vouchers/${id}/reverse`, { postingDate: '2026-09-11' });
    expect(rev.statusCode, rev.body).toBeLessThan(300);
    expect(await getTxn(t.id)).toMatchObject({ status: 'new', voucher_id: null });
    const t2 = await txn({ valueDate: '2026-09-11', amountOut: '640000', description: 'chi' });
    const m = await call('POST', `/api/bank-transactions/${t2.id}/match`, { voucherId: rev.json().id });
    expect(m.statusCode).toBe(409);
    expect(m.json().error.code).toBe('BANK_MATCH_REVERSAL');
  });

  it('sửa số tiền nháp rồi ghi sổ: không còn khớp, giao dịch về new và bỏ liên kết', async () => {
    const t = await txn({ valueDate: '2026-09-12', amountIn: '700000', description: 'thu x' });
    const r = await call('POST', `/api/bank-transactions/${t.id}/create-voucher`, { post: false, purposeCode: 'thu_khac' });
    expect(r.statusCode, r.body).toBe(201);
    const dto = r.json().voucher;
    expect(await getTxn(t.id)).toMatchObject({ status: 'new', voucher_id: dto.id });
    // giao dịch đã gắn nháp: không bỏ qua được
    expect((await call('POST', `/api/bank-transactions/${t.id}/ignore`)).statusCode).toBe(409);
    const amt = (v: string) => (v === '0' ? '0' : '650000');
    const put = await call('PUT', `/api/vouchers/${dto.id}`, { voucherType: 'BC', postingDate: dto.postingDate, documentDate: dto.documentDate, description: dto.description, bankAccountNo: dto.bankAccountNo, purpose: dto.purpose, version: dto.version,
      lines: dto.lines.map((l: { accountCode: string; debit: string; credit: string; bankAccountNo?: string | null }) => ({ accountCode: l.accountCode, debit: amt(l.debit), credit: amt(l.credit), ...(l.bankAccountNo ? { bankAccountNo: l.bankAccountNo } : {}) })) });
    expect(put.statusCode, put.body).toBe(200);
    expect((await call('POST', `/api/vouchers/${dto.id}/post`)).statusCode).toBe(200);
    expect(await getTxn(t.id)).toMatchObject({ status: 'new', voucher_id: null });
  });

  it('thiếu cờ nhạy cảm: settle bị chặn 403 (không phải lỗi BANK_SETTLE_*); giao dịch ra không gợi ý khoản phải trả', async () => {
    const item = await receivable('KH001', '1500000', 'HD-9001', '2026-09-01');
    const cookie = await limited([]);
    const t = await txn({ valueDate: '2026-09-15', amountIn: '1500000', description: 'x' });
    const r = await call('POST', `/api/bank-transactions/${t.id}/create-voucher`, { post: false, settle: [{ openItemId: item, amount: '1500000' }] }, cookie);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error.code).not.toMatch(/^BANK_SETTLE/);
    const o = await txn({ valueDate: '2026-09-15', amountOut: '1500000', description: 'HD 1' });
    expect((await call('POST', `/api/bank-transactions/${o.id}/suggestions`, undefined, cookie)).json()).toEqual({ suggestions: [], hiddenBySensitivity: true });
  });

  it('đối chiếu sổ phụ: liệt kê giao dịch chưa đối chiếu và dòng 1121 không có giao dịch', async () => {
    const from = '2026-08-01'; const to = '2026-08-31';
    await voucher({ voucherType: 'BC', postingDate: '2026-07-20', documentDate: '2026-07-20', bankAccountNo: a.accountNo, partyCode: 'KH002', lines: [L('1121', '1000000', '0', { bankAccountNo: a.accountNo }), L('131', '0', '1000000', { partyCode: 'KH002' })] });
    const ledgerOnly = await bc('200000', '2026-08-03');
    const withTxn = await bc('300000', '2026-08-04');
    const matched = await txn({ valueDate: '2026-08-04', amountIn: '300000' });
    expect((await call('POST', `/api/bank-transactions/${matched.id}/match`, { voucherId: withTxn.id })).statusCode).toBe(200);
    const open = await txn({ valueDate: '2026-08-10', amountIn: '555000', description: 'chua doi chieu' });
    await sql`UPDATE bank_transaction SET balance_after = 1855000 WHERE id = ${open.id}`.execute(ctx.t.admin);
    const r = await call('GET', `/api/bank-reconciliation?bankAccountId=${a.accountId}&from=${from}&to=${to}`);
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    expect(Number(j.ledgerOpening)).toBeGreaterThanOrEqual(1000000); // gồm cả số phát sinh của các kiểm thử trước trong cùng công ty
    expect(Number(j.ledgerClosing) - Number(j.ledgerOpening)).toBe(500000);
    expect(Number(j.difference)).toBe(1855000 - Number(j.ledgerClosing));
    expect(j.statementBalance).toBe('1855000');
    expect(j.unmatchedTransactions.map((x: { id: number }) => x.id)).toEqual([open.id]);
    expect(j.unmatchedLedgerLines.map((x: { voucherId: string }) => x.voucherId)).toEqual([ledgerOnly.id]);
    const x = await call('GET', `/api/bank-reconciliation?bankAccountId=${a.accountId}&from=${from}&to=${to}&format=xlsx`);
    expect(x.statusCode).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    const cell = wb.getWorksheet('Giao dịch chưa đối chiếu')!.getCell(2, 2); // số tiền vào của giao dịch chưa đối chiếu: ô số có định dạng tiền
    expect(cell.value).toBe(555000); expect(cell.numFmt).toContain('#,##0');
  });
});
