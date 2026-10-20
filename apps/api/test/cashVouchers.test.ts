import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

let ctx: TestApp; let cookie: string; let tenantId: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await setupLedgerTenant(ctx, `CV${Date.now()}`));
  const cat = async (name: string, payload: object) => {
    const r = await ctx.app.inject({ method: 'POST', url: `/api/catalogs/${name}`, headers: { cookie }, payload });
    if (r.statusCode !== 201) throw new Error(`${name}: ${r.body}`);
  };
  await cat('bank', { code: 'VCB', name: 'Vietcombank' });
  await cat('bank_account', { bank_code: 'VCB', account_no: '0011001', gl_account_code: '1121' }); // 1121: VND
  await cat('bank_account', { bank_code: 'VCB', account_no: '0011002', gl_account_code: '1121' }); // cùng tài khoản sổ cái 1121, khác số tài khoản
  await cat('bank_account', { bank_code: 'VCB', account_no: '0022001', gl_account_code: '1122' });
  await cat('party_bank_account', { party_code: 'NCC001', bank_name: 'Techcombank', account_no: '19001' });
  await cat('party_bank_account', { party_code: 'KH001', bank_name: 'ACB', account_no: '27001' });
}, 60_000);
afterAll(async () => { await ctx.close(); });

const L = (accountCode: string, debit = '0', credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
const voucher = (voucherType: string, date: string, lines: object[], more: object = {}) => ({ voucherType, postingDate: date, documentDate: date, description: `Thử ${voucherType}`, lines, ...more });
const create = (body: object) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: body });
const code = (r: { json(): { error: { code: string } } }) => r.json().error.code;

describe('phiếu thu, phiếu chi', () => {
  it('Phiếu thu tiền khách hàng: cần dòng Nợ tiền mặt, đối tượng trên 131', async () => {
    const ok = await create(voucher('PT', '2026-01-05', [L('1111', '5000000'), L('131', '0', '5000000', { partyCode: 'KH001' })],
      { purpose: 'thu_khach_hang', personName: 'Nguyễn Văn A', personAddress: '12 Lê Lợi', attachmentsCount: 2, partyCode: 'KH001' }));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ voucherType: 'PT', personName: 'Nguyễn Văn A', personAddress: '12 Lê Lợi', attachmentsCount: 2, purpose: 'thu_khach_hang', partyCode: 'KH001', periodStatus: 'open', hashed: false });
    const bad = await create(voucher('PT', '2026-01-05', [L('6422', '1'), L('1111', '0', '1')]));
    expect(bad.statusCode).toBe(400); expect(code(bad)).toBe('VOUCHER_CASH_LINE_REQUIRED');
  });

  it('Phiếu chi cần dòng Có tiền mặt; chiều ngược lại (Nợ 1111 trên phiếu chi) bị từ chối', async () => {
    expect((await create(voucher('PC', '2026-01-06', [L('6422', '10'), L('1111', '0', '10')]))).statusCode).toBe(201);
    expect(code(await create(voucher('PC', '2026-01-06', [L('1111', '10'), L('5113', '0', '10')])))).toBe('VOUCHER_CASH_LINE_REQUIRED');
  });

  it('mục đích phải thuộc loại; mục đích bắt buộc đối tượng thì dòng đối ứng phải có đối tượng', async () => {
    const wrong = await create(voucher('PT', '2026-01-07', [L('1111', '10'), L('5113', '0', '10')], { purpose: 'chi_tra_ncc' }));
    expect(wrong.statusCode).toBe(400); expect(code(wrong)).toBe('VOUCHER_PURPOSE_INVALID');
    expect(code(await create(voucher('PKT', '2026-01-07', [L('1111', '10'), L('5113', '0', '10')], { purpose: 'thu_khac' })))).toBe('VOUCHER_PURPOSE_INVALID'); // PKT không có mục đích
    const noParty = await create(voucher('PT', '2026-01-07', [L('1111', '10'), L('131', '0', '10')], { purpose: 'thu_khach_hang' }));
    expect(noParty.statusCode).toBe(400); expect(code(noParty)).toBe('LINE_PARTY_REQUIRED');
    // chỉ dòng trên tài khoản đối ứng của mục đích (131) bắt buộc đối tượng; dòng khác (thuế GTGT, doanh thu) thì không
    expect((await create(voucher('PT', '2026-01-07', [L('1111', '11'), L('131', '0', '10', { partyCode: 'KH001' }), L('33311', '0', '1')], { purpose: 'thu_khach_hang' }))).statusCode).toBe(201);
    expect((await create(voucher('PT', '2026-01-07', [L('1111', '10'), L('5113', '0', '10')], { purpose: 'thu_khac' }))).statusCode).toBe(201);
  });

  it('sửa nháp đổi được trường tiêu đề; nhân bản giữ trường tiêu đề và tài khoản ngân hàng', async () => {
    const v = (await create(voucher('BC', '2026-01-08', [L('1121', '7'), L('131', '0', '7', { partyCode: 'KH001' })], { bankAccountNo: '0011001', personName: 'Công ty B' }))).json();
    const put = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${v.id}`, headers: { cookie }, payload: { ...voucher('BC', '2026-01-08', [L('1121', '7'), L('131', '0', '7', { partyCode: 'KH001' })], { bankAccountNo: '0011002', personName: 'Công ty C', dueDate: '2026-02-01' }), version: v.version } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ bankAccountNo: '0011002', personName: 'Công ty C', dueDate: '2026-02-01' });
    expect(put.json().lines[0].bankAccountNo).toBe('0011002');
    const dup = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/duplicate`, headers: { cookie }, payload: { postingDate: '2026-01-20' } });
    expect(dup.statusCode, dup.body).toBe(201);
    expect(dup.json()).toMatchObject({ voucherType: 'BC', bankAccountNo: '0011002', personName: 'Công ty C', dueDate: '2026-02-01', state: 'draft' });
    expect(dup.json().lines[0].bankAccountNo).toBe('0011002');
  });

  it('số chứng từ gốc kèm theo là số nguyên 0..999; người nộp tối đa 200 ký tự', async () => {
    const lines = [L('1111', '3'), L('5113', '0', '3')];
    for (const extra of [{ attachmentsCount: 1000 }, { attachmentsCount: -1 }, { attachmentsCount: 1.5 }, { personName: 'x'.repeat(201) }])
      expect(code(await create(voucher('PT', '2026-01-09', lines, extra)))).toBe('VALIDATION');
    expect((await create(voucher('PT', '2026-01-09', lines, { attachmentsCount: 999, personName: 'x'.repeat(200) }))).statusCode).toBe(201);
  });
});

describe('giấy báo Nợ, giấy báo Có, chuyển tiền nội bộ', () => {
  it('Giấy báo Nợ: dòng 1121 nhận tài khoản ngân hàng của tiêu đề; tài khoản sổ cái lệch thì từ chối', async () => {
    const ok = await create(voucher('BN', '2026-02-02', [L('331', '90', '0', { partyCode: 'NCC001' }), L('1121', '0', '90')], { bankAccountNo: '0011001', purpose: 'chi_tra_ncc', partyCode: 'NCC001' }));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ bankAccountNo: '0011001' });
    expect(ok.json().lines.map((l: { bankAccountNo: string | null }) => l.bankAccountNo ?? null)).toEqual([null, '0011001']); // dòng 331 không phải tài khoản ngân hàng
    const bad = await create(voucher('BN', '2026-02-02', [L('331', '90', '0', { partyCode: 'NCC001' }), L('1121', '0', '90')], { bankAccountNo: '0022001' })); // 0022001 thuộc 1122
    expect(bad.statusCode).toBe(400); expect(code(bad)).toBe('BANK_ACCOUNT_GL_MISMATCH');
  });

  it('tài khoản ngân hàng không có: 404; thiếu tài khoản ngân hàng ở tiêu đề giấy báo: VOUCHER_FIELD_REQUIRED nêu nhãn', async () => {
    const lines = [L('331', '5', '0', { partyCode: 'NCC001' }), L('1121', '0', '5')];
    const nf = await create(voucher('BN', '2026-02-03', lines, { bankAccountNo: 'KHONGCO' }));
    expect(nf.statusCode).toBe(404); expect(code(nf)).toBe('BANK_ACCOUNT_NOT_FOUND');
    const lineNf = await create(voucher('BN', '2026-02-03', [lines[0]!, L('1121', '0', '5', { bankAccountNo: 'KHONGCO' })], { bankAccountNo: '0011001' }));
    expect(lineNf.statusCode).toBe(404); expect(code(lineNf)).toBe('BANK_ACCOUNT_NOT_FOUND');
    const req = await create(voucher('BN', '2026-02-03', lines));
    expect(req.statusCode).toBe(400); expect(code(req)).toBe('VOUCHER_FIELD_REQUIRED'); expect(req.json().error.message).toContain('Tài khoản ngân hàng');
  });

  it('Giấy báo Có/Nợ cần dòng tiền gửi đúng chiều; dòng ghi bankAccountNo riêng thắng tiêu đề, sai tài khoản sổ cái thì từ chối', async () => {
    expect(code(await create(voucher('BC', '2026-02-04', [L('1111', '4'), L('131', '0', '4', { partyCode: 'KH001' })], { bankAccountNo: '0011001' })))).toBe('VOUCHER_CASH_LINE_REQUIRED'); // Nợ tiền mặt, không có Nợ 112x
    const own = await create(voucher('BC', '2026-02-04', [L('1121', '4', '0', { bankAccountNo: '0011002' }), L('131', '0', '4', { partyCode: 'KH001' })], { bankAccountNo: '0011001' }));
    expect(own.statusCode, own.body).toBe(201); expect(own.json().lines[0].bankAccountNo).toBe('0011002');
    const bad = await create(voucher('BC', '2026-02-04', [L('1121', '4', '0', { bankAccountNo: '0022001' }), L('131', '0', '4', { partyCode: 'KH001' })], { bankAccountNo: '0011001' }));
    expect(code(bad)).toBe('BANK_ACCOUNT_GL_MISMATCH');
  });

  it('Chuyển tiền nội bộ: dòng Có nhận tài khoản chuyển đi, dòng Nợ nhận tài khoản nhận (cùng tài khoản sổ cái 1121)', async () => {
    const r = await create(voucher('CT', '2026-02-05', [L('1121', '100'), L('1121', '0', '100')], { bankAccountNo: '0011001', counterBankAccountNo: '0011002' }));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ bankAccountNo: '0011001', counterBankAccountNo: '0011002' });
    expect(r.json().lines.map((l: { bankAccountNo: string }) => l.bankAccountNo)).toEqual(['0011002', '0011001']);
  });

  it('Chuyển tiền nội bộ: có dòng Nợ ngân hàng thì bắt buộc tài khoản nhận; tài khoản chuyển đi và nhận phải khác nhau', async () => {
    const lines = [L('1121', '100'), L('1121', '0', '100')];
    const noCounter = await create(voucher('CT', '2026-02-05', lines, { bankAccountNo: '0011001' }));
    expect(noCounter.statusCode).toBe(400); expect(code(noCounter)).toBe('VOUCHER_FIELD_REQUIRED'); expect(noCounter.json().error.message).toContain('Tài khoản ngân hàng nhận');
    const same = await create(voucher('CT', '2026-02-05', lines, { bankAccountNo: '0011001', counterBankAccountNo: '0011001' }));
    expect(same.statusCode).toBe(400); expect(code(same)).toBe('BANK_TRANSFER_SAME_ACCOUNT');
    // rút tiền gửi về quỹ (Nợ 1111, Có 1121) không có dòng Nợ ngân hàng nên không cần tài khoản nhận
    expect((await create(voucher('CT', '2026-02-05', [L('1111', '100'), L('1121', '0', '100')], { bankAccountNo: '0011001' }))).statusCode).toBe(201);
    // đối xứng: có dòng Có ngân hàng thì bắt buộc tài khoản chuyển đi
    const noFrom = await create(voucher('CT', '2026-02-05', [L('1111', '100'), L('1121', '0', '100')]));
    expect(noFrom.statusCode).toBe(400); expect(code(noFrom)).toBe('VOUCHER_FIELD_REQUIRED'); expect(noFrom.json().error.message).toBe('Chuyển tiền nội bộ: thiếu Tài khoản ngân hàng');
  });

  it('tài khoản ngân hàng của đối tượng phải thuộc đối tượng của chứng từ: 404 PARTY_BANK_ACCOUNT_NOT_FOUND', async () => {
    const lines = [L('331', '8', '0', { partyCode: 'NCC001' }), L('1121', '0', '8')];
    const base = { bankAccountNo: '0011001', purpose: 'chi_tra_ncc' };
    const ok = await create(voucher('BN', '2026-02-06', lines, { ...base, partyCode: 'NCC001', partyBankAccountNo: '19001' }));
    expect(ok.statusCode, ok.body).toBe(201); expect(ok.json().partyBankAccountNo).toBe('19001');
    const other = await create(voucher('BN', '2026-02-06', lines, { ...base, partyCode: 'NCC001', partyBankAccountNo: '27001' })); // 27001 là của KH001
    expect(other.statusCode).toBe(404); expect(code(other)).toBe('PARTY_BANK_ACCOUNT_NOT_FOUND');
    const noParty = await create(voucher('BN', '2026-02-06', lines, { ...base, partyBankAccountNo: '19001' }));
    expect(noParty.statusCode).toBe(404); expect(code(noParty)).toBe('PARTY_BANK_ACCOUNT_NOT_FOUND');
  });
});

describe('loại chứng từ do hệ thống sinh và hóa đơn', () => {
  it('không lập tay CL/DG/XQ/KTT (VOUCHER_TYPE_SYSTEM); HDB/HDM/GGB/GGM phải qua /api/invoices (VOUCHER_TYPE_USE_INVOICE)', async () => {
    const lines = [L('6422', '1'), L('1111', '0', '1')];
    for (const t of ['CL', 'DG', 'XQ', 'KTT']) {
      const r = await create(voucher(t, '2026-03-02', lines)); expect([t, r.statusCode, code(r)]).toEqual([t, 409, 'VOUCHER_TYPE_SYSTEM']);
    }
    for (const t of ['HDB', 'HDM', 'GGB', 'GGM']) {
      const r = await create(voucher(t, '2026-03-02', lines, { partyCode: 'KH001' })); expect([t, r.statusCode, code(r)]).toEqual([t, 409, 'VOUCHER_TYPE_USE_INVOICE']);
    }
    const draft = (await create(voucher('PKT', '2026-03-02', lines))).json();
    const put = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${draft.id}`, headers: { cookie }, payload: { ...voucher('HDB', '2026-03-02', lines, { partyCode: 'KH001' }), version: draft.version } });
    expect([put.statusCode, code(put)]).toEqual([409, 'VOUCHER_TYPE_USE_INVOICE']);
  });

  it('mã loại trùng khóa của Object.prototype: 404 VOUCHER_TYPE_NOT_FOUND (POST và PUT), không 500', async () => {
    const lines = [L('6422', '1'), L('1111', '0', '1')];
    for (const t of ['constructor', 'toString', '__proto__']) {
      const r = await create(voucher(t, '2026-03-02', lines)); expect([t, r.statusCode, code(r)]).toEqual([t, 404, 'VOUCHER_TYPE_NOT_FOUND']);
    }
    const draft = (await create(voucher('PKT', '2026-03-02', lines))).json();
    const put = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${draft.id}`, headers: { cookie }, payload: { ...voucher('constructor', '2026-03-02', lines), version: draft.version } });
    expect([put.statusCode, code(put)]).toEqual([404, 'VOUCHER_TYPE_NOT_FOUND']);
  });

  it('PUT nháp đổi loại cũng chịu quy tắc theo loại và không làm hỏng nháp khi bị từ chối', async () => {
    const lines = [L('6422', '1'), L('1111', '0', '1')];
    const draft = (await create(voucher('PKT', '2026-03-04', lines))).json();
    const put = (type: string, more: object = {}) => ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${draft.id}`, headers: { cookie }, payload: { ...voucher(type, '2026-03-04', lines, more), version: draft.version } });
    const toPt = await put('PT'); // không có dòng Nợ tiền mặt
    expect([toPt.statusCode, code(toPt)]).toEqual([400, 'VOUCHER_CASH_LINE_REQUIRED']);
    const toBn = await put('BN', { description: 'x' }); // thiếu bankAccountNo
    expect([toBn.statusCode, code(toBn)]).toEqual([400, 'VOUCHER_FIELD_REQUIRED']);
    const toCl = await put('CL');
    expect([toCl.statusCode, code(toCl)]).toEqual([409, 'VOUCHER_TYPE_SYSTEM']);
    const cur = (await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${draft.id}`, headers: { cookie } })).json();
    expect(cur).toMatchObject({ voucherType: 'PKT', version: draft.version });
    expect(cur.lines).toHaveLength(2);
  });

  it('chứng từ sinh từ đối trừ, đánh giá lại, xuất quỹ, khấu trừ GTGT, phân bổ: không sửa, hủy, xóa tay (VOUCHER_SYSTEM_GENERATED)', async () => {
    for (const src of ['settlement_fx', 'fx_revaluation', 'fx_outflow', 'vat_offset', 'amortization']) {
      const v = (await create(voucher('PKT', '2026-03-03', [L('6422', '2'), L('1111', '0', '2')]))).json();
      await sql`UPDATE voucher SET source_doc_type = ${src} WHERE id = ${v.id}::uuid`.execute(ctx.t.admin);
      const cur = (await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${v.id}`, headers: { cookie } })).json();
      const put = await ctx.app.inject({ method: 'PUT', url: `/api/vouchers/${v.id}`, headers: { cookie }, payload: { ...voucher('PKT', '2026-03-03', [L('6422', '3'), L('1111', '0', '3')]), version: cur.version } });
      const del = await ctx.app.inject({ method: 'DELETE', url: `/api/vouchers/${v.id}`, headers: { cookie } });
      const discard = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${v.id}/discard`, headers: { cookie } });
      expect([src, ...[put, del, discard].map((r) => [r.statusCode, code(r)])]).toEqual([src, [409, 'VOUCHER_SYSTEM_GENERATED'], [409, 'VOUCHER_SYSTEM_GENERATED'], [409, 'VOUCHER_SYSTEM_GENERATED']]);
    }
  });
});

describe('danh sách và trạng thái kỳ', () => {
  it('danh sách lọc nhiều loại: type=PT,PC', async () => {
    const lines = [L('1111', '6'), L('5113', '0', '6')];
    await create(voucher('PT', '2026-04-02', lines)); await create(voucher('PC', '2026-04-02', [L('6422', '6'), L('1111', '0', '6')])); await create(voucher('PKT', '2026-04-02', lines));
    const both = (await ctx.app.inject({ method: 'GET', url: '/api/vouchers?type=PT,PC&from=2026-04-02&to=2026-04-02', headers: { cookie } })).json();
    expect(both.total).toBe(2); expect(both.rows.map((r: { voucherType: string }) => r.voucherType).sort()).toEqual(['PC', 'PT']);
    const spaced = (await ctx.app.inject({ method: 'GET', url: '/api/vouchers?type=PT,%20PC&from=2026-04-02&to=2026-04-02', headers: { cookie } })).json();
    expect(spaced.total).toBe(2); // khoảng trắng quanh mã được bỏ
    const one = (await ctx.app.inject({ method: 'GET', url: '/api/vouchers?type=PKT&from=2026-04-02&to=2026-04-02', headers: { cookie } })).json();
    expect(one.total).toBe(1);
  });

  it('DTO có periodStatus theo kỳ và hashed', async () => {
    const v = (await create(voucher('PT', '2026-09-02', [L('1111', '2'), L('5113', '0', '2')], { autoPost: true }))).json();
    expect(v).toMatchObject({ periodStatus: 'open', hashed: false });
    await sql`UPDATE fiscal_period SET status = 'soft_locked' WHERE tenant_id = ${tenantId}::uuid AND fiscal_year = 2026 AND period_no = 9`.execute(ctx.t.admin);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${v.id}`, headers: { cookie } })).json().periodStatus).toBe('soft_locked');
    await sql`UPDATE fiscal_period SET status = 'open' WHERE tenant_id = ${tenantId}::uuid AND fiscal_year = 2026 AND period_no = 9`.execute(ctx.t.admin);
  });
});

describe('đảo chứng từ giữ thông tin tiêu đề', () => {
  it('chứng từ đảo của Giấy báo Nợ giữ người nhận, địa chỉ, chứng từ gốc kèm theo, tài khoản ngân hàng, hạn thanh toán, mục đích', async () => {
    const lines = [L('331', '90', '0', { partyCode: 'NCC001' }), L('1121', '0', '90')];
    const src = await create(voucher('BN', '2026-05-04', lines, { bankAccountNo: '0011001', partyCode: 'NCC001', partyBankAccountNo: '19001', personName: 'Trần Thị B', personAddress: '5 Hai Bà Trưng', attachmentsCount: 3, dueDate: '2026-06-01', purpose: 'chi_tra_ncc', autoPost: true }));
    expect(src.statusCode, src.body).toBe(201);
    const rev = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${src.json().id}/reverse`, headers: { cookie }, payload: { postingDate: '2026-05-05' } });
    expect(rev.statusCode, rev.body).toBe(201);
    const got = (await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${rev.json().id}`, headers: { cookie } })).json();
    expect(got).toMatchObject({ voucherType: 'BN', reversalOfId: src.json().id, personName: 'Trần Thị B', personAddress: '5 Hai Bà Trưng', attachmentsCount: 3,
      bankAccountNo: '0011001', partyBankAccountNo: '19001', dueDate: '2026-06-01', purpose: 'chi_tra_ncc' });
  });

  it('chứng từ đảo của Chuyển tiền nội bộ giữ tài khoản ngân hàng đối ứng', async () => {
    const src = await create(voucher('CT', '2026-05-06', [L('1121', '100'), L('1121', '0', '100')], { bankAccountNo: '0011001', counterBankAccountNo: '0011002', autoPost: true }));
    expect(src.statusCode, src.body).toBe(201);
    const rev = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${src.json().id}/reverse`, headers: { cookie }, payload: { postingDate: '2026-05-07' } });
    expect(rev.statusCode, rev.body).toBe(201);
    expect(rev.json()).toMatchObject({ bankAccountNo: '0011001', counterBankAccountNo: '0011002' });
  });
});
