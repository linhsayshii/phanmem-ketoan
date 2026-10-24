import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql, type RawBuilder } from 'kysely';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Hit = { ruleCode: string; message: string; voucherId: string | null; voucherNo: string | null; ref: string | null; detail: string | null };
type Reply = { results: Hit[]; ran: number; skipped: { code: string; reason: string }[] };

// Mỗi kiểm thử một công ty riêng: năm 2026 theo TT133, đối tượng KH001, KH002, NCC001 (NCC001 có mã số thuế; KH001, KH002 chưa có).
async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `DG${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  const admin = <T>(q: RawBuilder<T>) => q.execute(ctx.t.admin);
  await admin(sql`UPDATE party SET tax_code = '0312345678' WHERE tenant_id = ${tenantId}::uuid AND code = 'NCC001'`);
  const invoice = (voucherType: 'HDB' | 'HDM', date: string, no: string, more: object = {}, inv: object = {}, tax = 'V10') => {
    const sale = voucherType === 'HDB';
    return { voucherType, postingDate: date, documentDate: date, partyCode: sale ? 'KH001' : 'NCC001', autoPost: true,
      items: [{ description: 'Dịch vụ', accountCode: sale ? '5113' : '6422', amountCurrency: '10000000', taxCodes: [tax] }],
      invoice: { serial: 'C26TAA', invoiceNo: no, invoiceDate: date, invoiceGroupCode: sale ? '10' : '01', ...inv }, ...more };
  };
  const create = async (body: object) => { const r = await call('POST', '/api/invoices', body); expect(r.statusCode, r.body).toBe(201); return r.json() as { id: string; voucherNo: string | null }; };
  const run = async (codes: string[], range = { from: '2026-01-01', to: '2026-12-31' }, c = cookie): Promise<Reply> => {
    const r = await call('POST', '/api/data-check/run', { ...range, codes }, c); expect(r.statusCode, r.body).toBe(200); return r.json();
  };
  const refs = async (code: string, range?: { from: string; to: string }) => (await run([code], range)).results.map((x) => x.ref).sort();
  const itemId = async (voucherId: string, accountCode: string) => (await sql<{ id: number }>`SELECT o.id::int AS id FROM open_item o JOIN account a ON a.id = o.account_id
    WHERE o.voucher_id = ${voucherId}::uuid AND a.code = ${accountCode} ORDER BY o.line_no LIMIT 1`.execute(ctx.t.admin)).rows[0]!.id;
  return { cookie, tenantId, call, admin, invoice, create, run, refs, itemId };
}

describe('soát lỗi GĐ2: hóa đơn', () => {
  it('HD_THIEU_MST: hóa đơn mua thiếu MST và hóa đơn bán cho đối tượng đã có MST mà hóa đơn để trống bị báo; hóa đơn đủ MST thì không', async () => {
    const t = await tenant();
    const noMst = await t.create(t.invoice('HDM', '2026-03-10', '0000001', { partyCode: 'KH002' }));
    await t.create(t.invoice('HDM', '2026-03-11', '0000002')); // NCC001 có MST
    const sale = await t.create(t.invoice('HDB', '2026-03-12', '0000003')); // KH001 chưa có MST lúc lập hóa đơn
    await t.create(t.invoice('HDB', '2026-03-13', '0000004', { partyCode: 'KH002' })); // đối tượng không MST, hóa đơn trống MST: hợp lệ (bán lẻ)
    await t.admin(sql`UPDATE party SET tax_code = '0101234567' WHERE tenant_id = ${t.tenantId}::uuid AND code = 'KH001'`);
    const r = await t.run(['HD_THIEU_MST']);
    expect(r.results.map((x) => x.voucherNo).sort()).toEqual([noMst.voucherNo, sale.voucherNo].sort());
    expect(r.results.every((x) => !/Quy tắc lỗi/.test(x.message))).toBe(true);
  });

  it('HD_TRUNG: cùng MST, ký hiệu, số trên hai chứng từ báo một lần; khác ký hiệu hoặc chứng từ hủy thì không', async () => {
    const t = await tenant();
    const draft = (no: string, inv: object = {}) => t.create(t.invoice('HDM', '2026-03-10', no, { autoPost: false }, inv));
    const a = await draft('0000010'); const b = await draft('0000011'); const c = await draft('0000012', { serial: 'C26TBB' }); const d = await draft('0000013');
    // Kiểm trùng lúc nhập chặn nhập trùng: ép trùng bằng owner trên các chứng từ còn nháp.
    await t.admin(sql`UPDATE voucher_invoice SET invoice_no = '0000010', serial = ' c26taa ' WHERE voucher_id IN (${b.id}::uuid, ${d.id}::uuid)`);
    await t.admin(sql`UPDATE voucher_invoice SET invoice_no = '0000010' WHERE voucher_id = ${c.id}::uuid`); // khác ký hiệu
    expect((await t.call('POST', `/api/vouchers/${d.id}/discard`)).statusCode).toBe(200); // d đã hủy: không tính
    const r = await t.run(['HD_TRUNG']);
    expect(r.results).toHaveLength(1);
    const ids = [a.id, b.id].sort();
    expect(r.results[0]!.voucherId).toBe(ids[1]);
    expect(r.results[0]!.detail).toMatch(/trùng với chứng từ/);
  });
});

describe('soát lỗi GĐ2: hóa đơn (cùng chứng từ)', () => {
  it('HD_TRUNG: cùng hóa đơn kê hai lần cùng mã thuế trong một chứng từ bị báo; hai mã thuế khác nhau của một hóa đơn thì không', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDM', '2026-03-10', '0000015', { autoPost: false,
      items: [{ description: 'a', accountCode: '6422', amountCurrency: '1000000', taxCodes: ['V10'] }, { description: 'b', accountCode: '6422', amountCurrency: '1000000', taxCodes: ['V8'] }] }));
    expect((await t.run(['HD_TRUNG'])).results).toEqual([]);
    await t.admin(sql`INSERT INTO voucher_invoice(tenant_id, voucher_id, direction, serial, invoice_no, invoice_date, party_id, party_tax_code, invoice_group_id, tax_code_id, base_amount, tax_amount)
      SELECT tenant_id, voucher_id, direction, serial, invoice_no, invoice_date, party_id, party_tax_code, invoice_group_id, tax_code_id, base_amount, tax_amount FROM voucher_invoice
      WHERE voucher_id = ${v.id}::uuid ORDER BY id LIMIT 1`);
    const r = await t.run(['HD_TRUNG']);
    expect(r.results.map((x) => x.voucherId)).toEqual([v.id]);
    expect(r.results[0]!.detail).toMatch(/hai lần trong cùng chứng từ/);
  });
});

describe('soát lỗi GĐ2: thuế', () => {
  it('THUE_8_HET_HIEU_LUC: hóa đơn V8 ngày ngoài hiệu lực vat_reduced_rate bị báo, trong hiệu lực thì không', async () => {
    const t = await tenant();
    const out = await t.create(t.invoice('HDM', '2026-03-10', '0000020', {}, { invoiceDate: '2025-06-15' }, 'V8'));
    await t.create(t.invoice('HDM', '2026-03-11', '0000021', {}, {}, 'V8'));
    await t.create(t.invoice('HDM', '2026-03-12', '0000022')); // V10
    const r = await t.run(['THUE_8_HET_HIEU_LUC']);
    expect(r.results.map((x) => x.voucherNo)).toEqual([out.voucherNo]);
    await t.admin(sql`UPDATE tax_code SET kind = 'excise' WHERE tenant_id = ${t.tenantId}::uuid AND code = 'V8'`); // mã thuế suất 8 không phải GTGT thì không thuộc quy tắc
    expect((await t.run(['THUE_8_HET_HIEU_LUC'])).results).toEqual([]);
  });

  it('THUE_LECH khớp /api/tax/reconcile: cùng tập chứng từ lệch (PKT chỉ có 1331, PT có Có 33311, chứng từ đảo qua kỳ sau, nộp thuế 33311)', async () => {
    const t = await tenant();
    const v = await t.create(t.invoice('HDM', '2026-03-10', '0000030'));
    await t.create(t.invoice('HDB', '2026-03-11', '0000031'));
    await t.call('POST', `/api/vouchers/${v.id}/reverse`, { postingDate: '2026-04-15' });
    const pkt = await t.call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-03-15', documentDate: '2026-03-15', autoPost: true,
      lines: [{ accountCode: '1331', debit: '2000000', credit: '0' }, { accountCode: '1111', debit: '0', credit: '2000000' }] });
    const pt = await t.call('POST', '/api/vouchers', { voucherType: 'PT', postingDate: '2026-03-20', documentDate: '2026-03-20', partyCode: 'KH001', autoPost: true,
      lines: [{ accountCode: '1111', debit: '1100000' }, { accountCode: '5113', credit: '1000000' }, { accountCode: '33311', credit: '100000' }] });
    const pay = await t.call('POST', '/api/vouchers', { voucherType: 'PC', postingDate: '2026-03-22', documentDate: '2026-03-22', partyCode: 'NCC001', autoPost: true,
      lines: [{ accountCode: '33311', debit: '700000' }, { accountCode: '1111', credit: '700000' }] });
    for (const x of [pkt, pt, pay]) expect(x.statusCode, x.body).toBe(201);
    const months: [number, string, string][] = [[3, '2026-03-01', '2026-03-31'], [4, '2026-04-01', '2026-04-30']];
    for (const [period, from, to] of months) {
      const rec = await t.call('GET', `/api/tax/reconcile?year=2026&period=${period}&periodKind=month`);
      const want = (rec.json().differences as { voucherId: string }[]).map((d) => d.voucherId).sort();
      const got = (await t.run(['THUE_LECH'], { from, to })).results.map((x) => x.voucherId).sort();
      expect(got, `kỳ ${period}`).toEqual(want);
    }
    expect((await t.call('GET', '/api/tax/reconcile?year=2026&period=3&periodKind=month')).json().differences).toHaveLength(2);
    expect(new Set((await t.run(['THUE_LECH'], { from: '2026-03-01', to: '2026-03-31' })).results.map((x) => x.voucherId))).toEqual(new Set([pkt.json().id, pt.json().id]));
  });
});

describe('soát lỗi GĐ2: tiền gửi, tiền mặt, công nợ', () => {
  it('TK_NH_THIEU: dòng TK ngân hàng thiếu tài khoản ngân hàng bị báo, có tài khoản ngân hàng thì không', async () => {
    const t = await tenant();
    expect((await t.call('POST', '/api/catalogs/bank', { code: 'VCB', name: 'Vietcombank' })).statusCode).toBe(201);
    expect((await t.call('POST', '/api/catalogs/bank_account', { bank_code: 'VCB', account_no: '0011001', gl_account_code: '1121', currency_code: 'VND' })).statusCode).toBe(201);
    const bad = await t.call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: '2026-03-10', documentDate: '2026-03-10', autoPost: true,
      lines: [{ accountCode: '1121', debit: '100' }, { accountCode: '4111', credit: '100' }] });
    const ok = await t.call('POST', '/api/vouchers', { voucherType: 'BC', postingDate: '2026-03-11', documentDate: '2026-03-11', autoPost: true, bankAccountNo: '0011001',
      lines: [{ accountCode: '1121', debit: '100' }, { accountCode: '4111', credit: '100' }] });
    expect(ok.statusCode, ok.body).toBe(201);
    const r = await t.run(['TK_NH_THIEU']);
    expect(r.results.map((x) => x.voucherId)).toEqual([bad.json().id]);
  });

  it('TIEN_MAT_VUOT_NGUONG: hóa đơn mua từ 5 triệu trả bằng phiếu chi tiền mặt bị báo; trả bằng ngân hàng hoặc dưới ngưỡng thì không', async () => {
    const t = await tenant();
    const settle = async (inv: { id: string }, type: 'PC' | 'PKT', amount: string) => {
      const cash = await t.call('POST', '/api/vouchers', { voucherType: type, postingDate: '2026-03-20', documentDate: '2026-03-20', partyCode: 'NCC001', autoPost: true,
        lines: [{ accountCode: '331', debit: amount, partyCode: 'NCC001' }, { accountCode: type === 'PC' ? '1111' : '1121', credit: amount }] });
      expect(cash.statusCode, cash.body).toBe(201);
      const s = await t.call('POST', '/api/settlements', { debitItemId: await t.itemId(cash.json().id, '331'), creditItemId: await t.itemId(inv.id, '331'), amount });
      expect(s.statusCode, s.body).toBe(201);
    };
    const cashBig = await t.create(t.invoice('HDM', '2026-03-10', '0000040'));
    const bankBig = await t.create(t.invoice('HDM', '2026-03-10', '0000041'));
    const cashSmall = await t.create(t.invoice('HDM', '2026-03-10', '0000042', { items: [{ description: 'x', accountCode: '6422', amountCurrency: '1000000', taxCodes: ['V10'] }] }));
    await settle(cashBig, 'PC', '11000000'); await settle(bankBig, 'PKT', '11000000'); await settle(cashSmall, 'PC', '1100000');
    const r = await t.run(['TIEN_MAT_VUOT_NGUONG']);
    expect(r.results.map((x) => x.voucherId)).toEqual([cashBig.id]);
  });

  it('TIEN_MAT_VUOT_NGUONG: hóa đơn mua kê thẳng trên phiếu chi (Có 1111) từ ngưỡng bị báo; kê trên giấy báo nợ (Có 1121) thì không', async () => {
    const t = await tenant();
    expect((await t.call('POST', '/api/catalogs/bank', { code: 'VCB', name: 'Vietcombank' })).statusCode).toBe(201);
    expect((await t.call('POST', '/api/catalogs/bank_account', { bank_code: 'VCB', account_no: '0011001', gl_account_code: '1121', currency_code: 'VND' })).statusCode).toBe(201);
    const decl = (no: string) => ({ serial: 'PC26T', invoiceNo: no, invoiceDate: '2026-03-05', partyCode: 'NCC001', invoiceGroupCode: '03', taxCode: 'V10', baseAmount: '10000000', taxAmount: '1000000' });
    const lines = (cash: string) => [{ accountCode: '6422', debit: '10000000', credit: '0' }, { accountCode: '1331', debit: '1000000', credit: '0' }, { accountCode: cash, debit: '0', credit: '11000000' }];
    const pc = await t.call('POST', '/api/vouchers', { voucherType: 'PC', postingDate: '2026-03-12', documentDate: '2026-03-12', partyCode: 'NCC001', autoPost: true, lines: lines('1111'), invoices: [decl('0000043')] });
    const bn = await t.call('POST', '/api/vouchers', { voucherType: 'BN', postingDate: '2026-03-13', documentDate: '2026-03-13', partyCode: 'NCC001', autoPost: true, bankAccountNo: '0011001', lines: lines('1121'), invoices: [decl('0000044')] });
    expect(pc.statusCode, pc.body).toBe(201); expect(bn.statusCode, bn.body).toBe(201);
    expect((await t.run(['TIEN_MAT_VUOT_NGUONG'])).results.map((x) => x.voucherId)).toEqual([pc.json().id]);
  });

  it('CN_QUA_HAN: khoản quá hạn trên 90 ngày tại ngày kết thúc bị báo; chưa đủ 90 ngày hoặc đã thu hết thì không', async () => {
    const t = await tenant();
    const old = await t.create(t.invoice('HDB', '2026-01-10', '0000050', { dueDate: '2026-01-15' }));
    await t.create(t.invoice('HDB', '2026-01-10', '0000051', { dueDate: '2026-12-01' }));
    const paid = await t.create(t.invoice('HDB', '2026-01-10', '0000052', { dueDate: '2026-01-15' }));
    const pt = await t.call('POST', '/api/vouchers', { voucherType: 'PT', postingDate: '2026-02-01', documentDate: '2026-02-01', partyCode: 'KH001', autoPost: true,
      lines: [{ accountCode: '1111', debit: '11000000' }, { accountCode: '131', credit: '11000000', partyCode: 'KH001' }] });
    expect((await t.call('POST', '/api/settlements', { debitItemId: await t.itemId(paid.id, '131'), creditItemId: await t.itemId(pt.json().id, '131'), amount: '11000000' })).statusCode).toBe(201);
    const r = await t.run(['CN_QUA_HAN'], { from: '2026-01-01', to: '2026-12-31' });
    expect(r.results.map((x) => x.voucherId)).toEqual([old.id]);
    expect(r.results[0]!.detail).toMatch(/Quá hạn 350 ngày/);
    expect((await t.run(['CN_QUA_HAN'], { from: '2026-01-01', to: '2026-03-31' })).results).toEqual([]); // 15/01 -> 31/03 = 75 ngày
  });

  it('CN_LECH_SO_CAI: dư các khoản lệch số dư sổ cái bị báo, khớp thì không', async () => {
    const t = await tenant();
    await t.create(t.invoice('HDB', '2026-03-10', '0000060'));
    expect((await t.run(['CN_LECH_SO_CAI'])).results).toEqual([]);
    await t.admin(sql`UPDATE open_item SET amount = amount + 1000 WHERE tenant_id = ${t.tenantId}::uuid AND voucher_id IS NOT NULL AND account_id = (SELECT id FROM account WHERE tenant_id = ${t.tenantId}::uuid AND code = '131' LIMIT 1)`);
    const r = await t.run(['CN_LECH_SO_CAI']);
    expect(r.results.map((x) => x.ref)).toEqual(['131 / KH001']);
    expect(r.results[0]!.detail).toBe('Sổ cái 11000000 / Σ dư các khoản 11001000');
  });
});

describe('soát lỗi GĐ2: cờ nhạy cảm trên quy tắc', () => {
  const login = async (t: Awaited<ReturnType<typeof tenant>>, sensitiveFlags: string[]) => {
    const username = `dg_${sensitiveFlags.length}_${Date.now()}_${n++}`;
    expect((await t.call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags })).statusCode).toBe(201);
    const l = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return `sid=${l.cookies.find((x) => x.name === 'sid')!.value}`;
  };

  it('thiếu view_receivable hoặc view_payable: bỏ qua CN_LECH_SO_CAI và CN_QUA_HAN, không chạy SQL và có lý do; đủ cả hai thì chạy', async () => {
    const t = await tenant();
    await t.create(t.invoice('HDB', '2026-01-10', '0000070', { dueDate: '2026-01-15' }));
    const owner = await t.run([]);
    expect(owner.skipped).toEqual([]);
    expect(owner.results.map((x) => x.ruleCode)).toContain('CN_QUA_HAN');
    const reason = 'Bỏ qua do thiếu quyền xem công nợ';
    const why = 'Bỏ qua do thiếu quyền xem giá vốn';
    const cost = ['SO_DU_SAI_LOAI', 'KHO_LECH_SO_CAI', 'KHO_TON_0_CON_GIA_TRI', 'KHO_XUAT_CHUA_GIA_VON',
      'GIA_THANH_CAN_CHAY_LAI', 'GIA_THANH_154_CON_DU', 'GIA_THANH_THIEU_DINH_MUC', 'GIA_THANH_621_622_627_CON_DU', 'GIA_THANH_DAU_RA_KHONG_MA_HANG'].map((code) => ({ code, reason: why })); // SO_DU_SAI_LOAI in số dư nên có thể lộ giá vốn; ba quy tắc kho (GĐ3) in giá trị tồn
    // Sáu quy tắc lương (GĐ6) cần view_salary mà các ca dưới không cấp, trừ ca cuối.
    const salary = ['LUONG_THIEU_MST', 'LUONG_THIEU_TK_NH', 'LUONG_NV_NGHI_VAN_TINH', 'LUONG_CAN_TINH_LAI', 'LUONG_LECH_SO_CAI', 'LUONG_BH_VUOT_TRAN'].map((code) => ({ code, reason: 'Bỏ qua do thiếu quyền xem lương' }));
    const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code);
    for (const flags of [[], ['view_receivable'], ['view_receivable', 'view_cost']]) {
      const r = await t.run([], { from: '2026-01-01', to: '2026-12-31' }, await login(t, flags));
      expect(r.skipped, flags.join()).toEqual([{ code: 'CN_LECH_SO_CAI', reason }, { code: 'CN_QUA_HAN', reason }, { code: 'KU_CHUA_TINH_LAI', reason }, { code: 'KU_QUA_HAN', reason }, ...(flags.includes('view_cost') ? [] : cost), ...salary].sort(byCode));
      expect(r.ran).toBe(owner.ran - r.skipped.length);
      expect(r.results.filter((x) => r.skipped.some((k) => k.code === x.ruleCode))).toEqual([]);
    }
    const noCost = await t.run([], { from: '2026-01-01', to: '2026-12-31' }, await login(t, ['view_receivable', 'view_payable']));
    expect(noCost.skipped).toEqual([...cost, ...salary].sort(byCode));
    const all = await t.run([], { from: '2026-01-01', to: '2026-12-31' }, await login(t, ['view_receivable', 'view_payable', 'view_cost', 'view_salary']));
    expect(all.skipped).toEqual([]); expect(all.ran).toBe(owner.ran);
  });

  it('quy tắc bị bỏ qua không chạy SQL: câu SQL lỗi của quy tắc cần cờ chỉ hiện "Quy tắc lỗi" với người đủ cờ', async () => {
    const t = await tenant();
    await t.admin(sql`UPDATE data_check_rule SET sql = 'SELECT 1/0, 1, 1' WHERE tenant_id = ${t.tenantId}::uuid AND code = 'CN_QUA_HAN'`);
    const owner = await t.run(['CN_QUA_HAN']);
    expect(owner.results).toHaveLength(1); expect(owner.results[0]!.message).toMatch(/Quy tắc lỗi/);
    const none = await t.run(['CN_QUA_HAN'], { from: '2026-01-01', to: '2026-12-31' }, await login(t, []));
    expect(none.results).toEqual([]); expect(none.ran).toBe(0); expect(none.skipped.map((x) => x.code)).toEqual(['CN_QUA_HAN']);
  });
});
