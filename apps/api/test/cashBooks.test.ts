import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); }, 60_000);
afterAll(async () => { await ctx.close(); });

const L = (accountCode: string, debit = '0', credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
const voucher = (voucherType: string, date: string, lines: object[], more: object = {}) => ({ voucherType, postingDate: date, documentDate: date, description: `Thử ${voucherType}`, lines, ...more });

// Mỗi nhóm kiểm thử một công ty riêng (cài đặt tồn quỹ âm và số dư không lẫn giữa các nhóm).
async function tenant() {
  const { cookie } = await setupLedgerTenant(ctx, `SQ${Date.now()}${n++}`);
  const cat = async (name: string, payload: object) => {
    const r = await ctx.app.inject({ method: 'POST', url: `/api/catalogs/${name}`, headers: { cookie }, payload });
    if (r.statusCode !== 201) throw new Error(`${name}: ${r.body}`);
  };
  await cat('bank', { code: 'VCB', name: 'Vietcombank' });
  await cat('bank_account', { bank_code: 'VCB', account_no: '0011001', gl_account_code: '1121' });
  await cat('bank_account', { bank_code: 'VCB', account_no: '0011002', gl_account_code: '1121' }); // cùng tài khoản sổ cái 1121
  const create = (body: object) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: body });
  const post = async (body: object) => { const r = await create({ ...body, autoPost: true }); expect(r.statusCode, r.body).toBe(201); return r.json(); };
  const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });
  const setCashNegative = async (v: string) => expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { cash_negative: v } })).statusCode).toBe(200);
  return { cookie, create, post, get, setCashNegative };
}

describe('số dư tại ngày và sổ quỹ tiền mặt', () => {
  it('sổ quỹ: số dư đầu kỳ, thu, chi, tồn sau từng dòng, tồn cuối kỳ bằng số dư 1111 tại ngày', async () => {
    const t = await tenant();
    await t.post(voucher('PKT', '2026-01-02', [L('1111', '10000000'), L('4111', '0', '10000000')])); // trước kỳ in: thành số dư đầu kỳ
    const pt1 = await t.post(voucher('PT', '2026-01-10', [L('1111', '5500000'), L('5113', '0', '5000000'), L('33311', '0', '500000')]));
    const pc = await t.post(voucher('PC', '2026-01-12', [L('6422', '2000000'), L('1111', '0', '2000000')]));
    const pt2 = await t.post(voucher('PT', '2026-01-12', [L('1111', '1000000'), L('5113', '0', '1000000')])); // cùng ngày với phiếu chi, lập sau: phiếu thu vẫn xếp trước
    await t.post(voucher('PC', '2026-02-03', [L('6422', '1000000'), L('1111', '0', '1000000')])); // sau kỳ in

    const r = await t.get('/api/reports/cash-book?accountCode=1111&from=2026-01-10&to=2026-01-31');
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ accountCode: '1111', opening: '10000000', totalIn: '6500000', totalOut: '2000000', closing: '14500000' });
    expect(b.rows).toHaveLength(3);
    expect(b.rows[0]).toMatchObject({ date: '2026-01-10', voucherId: pt1.id, voucherNo: pt1.voucherNo, receiptNo: pt1.voucherNo, paymentNo: null, counterAccounts: '33311, 5113', in: '5500000', out: '0', balance: '15500000', inCurrency: null, balanceCurrency: null });
    expect(b.rows[1]).toMatchObject({ voucherId: pt2.id, receiptNo: pt2.voucherNo, in: '1000000', balance: '16500000' });
    expect(b.rows[2]).toMatchObject({ voucherId: pc.id, receiptNo: null, paymentNo: pc.voucherNo, counterAccounts: '6422', in: '0', out: '2000000', balance: '14500000' });
    expect(b.rows[2].documentDate).toBe('2026-01-12');

    const bal = async (q: string) => (await t.get(`/api/cash/balance?${q}`)).json();
    expect(await bal('accountCode=1111&asOf=2026-01-31')).toEqual({ debit: '14500000', credit: '0', balance: b.closing, balanceCurrency: '0' });
    expect(await bal('accountCode=1111&asOf=2026-02-03')).toMatchObject({ balance: '13500000' });
    expect(await bal('accountCode=1111&asOf=2026-01-01')).toMatchObject({ debit: '0', credit: '0', balance: '0' });
    expect(await bal('accountCode=1111&asOf=2026-01-31&currency=VND')).toMatchObject({ balance: '14500000', balanceCurrency: '14500000' });
    // đầu kỳ của sổ bằng số dư tại ngày liền trước kỳ
    expect((await bal('accountCode=1111&asOf=2026-01-09')).balance).toBe(b.opening);
    // tài khoản không có -> 404; ngày sai -> 400
    expect((await t.get('/api/cash/balance?accountCode=9999&asOf=2026-01-31')).statusCode).toBe(404);
    expect((await t.get('/api/cash/balance?accountCode=1111&asOf=2026-13-31')).statusCode).toBe(400);
    expect((await t.get('/api/reports/cash-book?accountCode=1111&from=2026-02-01&to=2026-01-01')).statusCode).toBe(400);
  }, 60_000);

  it('sổ quỹ xuất Excel, HTML (không dùng mẫu số TT200 vì không có văn bản gốc) và PDF; tiêu đề đúng mẫu số của chế độ', async () => {
    const t = await tenant();
    await t.post(voucher('PT', '2026-01-10', [L('1111', '100'), L('5113', '0', '100')]));
    const html = await t.get('/api/reports/cash-book?accountCode=1111&from=2026-01-01&to=2026-01-31&format=html');
    expect(html.statusCode, html.body).toBe(200);
    expect(html.body).toContain('SỔ QUỸ TIỀN MẶT'); expect(html.body).toContain('Mẫu số S04a-DNN');
    const xlsx = await t.get('/api/reports/cash-book?accountCode=1111&from=2026-01-01&to=2026-01-31&format=xlsx');
    expect(xlsx.statusCode).toBe(200); expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const pdf = await t.get('/api/reports/cash-book?accountCode=1111&from=2026-01-01&to=2026-01-31&format=pdf');
    expect(pdf.statusCode).toBe(200); expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  }, 60_000);

  it('sổ quỹ ngoại tệ 1112 USD có cột nguyên tệ: thu, chi, tồn', async () => {
    const t = await tenant();
    await t.post(voucher('PT', '2026-01-10', [L('1112', '30492700', '0', { amountCurrency: '1200.50' }), L('131', '0', '30492700', { amountCurrency: '-1200.50', partyCode: 'KH001' })], { currencyCode: 'USD', fxRate: '25400', partyCode: 'KH001' }));
    await t.post(voucher('PC', '2026-01-15', [L('6422', '5100000', '0', { amountCurrency: '200' }), L('1112', '0', '5100000', { amountCurrency: '-200' })], { currencyCode: 'USD', fxRate: '25500' }));
    const b = (await t.get('/api/reports/cash-book?accountCode=1112&currency=USD&from=2026-01-01&to=2026-01-31')).json();
    expect(b).toMatchObject({ currency: 'USD', opening: '0', openingCurrency: '0.0000', totalIn: '30492700', totalOut: '5100000', closing: '25392700', closingCurrency: '1000.5000' });
    expect(b.rows[0]).toMatchObject({ in: '30492700', inCurrency: '1200.5000', outCurrency: '0.0000', balance: '30492700', balanceCurrency: '1200.5000' });
    expect(b.rows[1]).toMatchObject({ out: '5100000', outCurrency: '200.0000', inCurrency: '0.0000', balance: '25392700', balanceCurrency: '1000.5000' });
    expect(await t.get('/api/cash/balance?accountCode=1112&currency=USD&asOf=2026-01-31').then((r) => r.json())).toMatchObject({ balance: '25392700', balanceCurrency: '1000.5000' });
    // đầu kỳ ngoại tệ lấy từ số dư tại ngày liền trước
    expect((await t.get('/api/reports/cash-book?accountCode=1112&currency=USD&from=2026-01-12&to=2026-01-31')).json()).toMatchObject({ opening: '30492700', openingCurrency: '1200.5000', closingCurrency: '1000.5000' });
  }, 60_000);
});

describe('sổ tiền gửi ngân hàng', () => {
  it('hai tài khoản ngân hàng cùng 1121: mỗi sổ chỉ thấy dòng của mình; dòng chưa gán gom riêng; tổng khớp số dư 1121', async () => {
    const t = await tenant();
    await t.post(voucher('PKT', '2026-01-03', [L('1121', '700000'), L('4111', '0', '700000')])); // chưa gán tài khoản ngân hàng
    const bc1 = await t.post(voucher('BC', '2026-01-05', [L('1121', '3000000'), L('131', '0', '3000000', { partyCode: 'KH001' })], { bankAccountNo: '0011001' }));
    await t.post(voucher('BC', '2026-01-06', [L('1121', '2000000'), L('131', '0', '2000000', { partyCode: 'KH001' })], { bankAccountNo: '0011002' }));
    const bn = await t.post(voucher('BN', '2026-01-07', [L('331', '500000', '0', { partyCode: 'NCC001' }), L('1121', '0', '500000')], { bankAccountNo: '0011001', purpose: 'chi_tra_ncc', partyCode: 'NCC001' }));
    const book = async (q: string) => { const r = await t.get(`/api/reports/bank-book?from=2026-01-01&to=2026-01-31&${q}`); expect(r.statusCode, r.body).toBe(200); return r.json(); };

    const b1 = await book('bankAccountNo=0011001');
    expect(b1).toMatchObject({ bankAccountNo: '0011001', accountCode: '1121', opening: '0', totalIn: '3000000', totalOut: '500000', closing: '2500000' });
    expect(b1.rows).toHaveLength(2);
    expect(b1.rows[0]).toMatchObject({ voucherId: bc1.id, receiptNo: bc1.voucherNo, paymentNo: null, counterAccounts: '131', in: '3000000', balance: '3000000' });
    expect(b1.rows[1]).toMatchObject({ voucherId: bn.id, receiptNo: null, paymentNo: bn.voucherNo, counterAccounts: '331', out: '500000', balance: '2500000' });
    const b2 = await book('bankAccountNo=0011002');
    expect(b2.rows).toHaveLength(1); expect(b2).toMatchObject({ closing: '2000000' });
    const none = await book('accountCode=1121');
    expect(none.bankAccountLabel).toBe('Chưa gán tài khoản ngân hàng'); expect(none.rows).toHaveLength(1); expect(none).toMatchObject({ closing: '700000' });

    const all = (await t.get('/api/cash/balance?accountCode=1121&asOf=2026-01-31')).json();
    expect(all.balance).toBe('5200000');
    expect((await t.get('/api/cash/balance?accountCode=1121&bankAccountNo=0011001&asOf=2026-01-31')).json()).toMatchObject({ debit: '2500000', credit: '0', balance: '2500000' });
    expect((await t.get('/api/cash/balance?accountCode=1121&bankAccountNo=0011001&asOf=2026-01-06')).json().balance).toBe('3000000');
    // đầu kỳ bằng số dư tại ngày liền trước (kể cả sổ chỉ một tài khoản ngân hàng)
    const later = (await t.get('/api/reports/bank-book?bankAccountNo=0011001&from=2026-01-06&to=2026-01-31')).json();
    expect(later).toMatchObject({ opening: '3000000', closing: '2500000' });
    expect(Number(b1.closing) + Number(b2.closing) + Number(none.closing)).toBe(Number(all.balance));

    expect((await t.get('/api/reports/bank-book?bankAccountNo=KHONGCO&from=2026-01-01&to=2026-01-31')).statusCode).toBe(404);
    expect((await t.get('/api/reports/bank-book?from=2026-01-01&to=2026-01-31')).statusCode).toBe(400); // cần số tài khoản ngân hàng hoặc tài khoản
    const html = await t.get('/api/reports/bank-book?bankAccountNo=0011001&from=2026-01-01&to=2026-01-31&format=html');
    expect(html.body).toContain('SỔ TIỀN GỬI NGÂN HÀNG'); expect(html.body).toContain('Mẫu số S05-DNN'); expect(html.body).toContain('0011001'); expect(html.body).toContain('Vietcombank');
  }, 60_000);

  it('số dư đầu 1121 theo hai tài khoản ngân hàng: ghi sổ DK mang bank_account_id; sổ tiền gửi từng tài khoản mở đầu đúng', async () => {
    const t = await tenant();
    const opening = (rows: object[]) => ctx.app.inject({ method: 'PUT', url: '/api/opening-balance/2026', headers: { cookie: t.cookie }, payload: { rows } });
    const O = (accountCode: string, debit: string, credit: string, bankAccountNo: string | null) =>
      ({ accountCode, partyCode: null, currencyCode: 'VND', debit, credit, debitCurrency: '0', creditCurrency: '0', bankAccountNo });
    expect((await opening([O('1121', '3000000', '0', '0011001'), O('1121', '2000000', '0', '0011002'), O('4111', '0', '5000000', null)])).statusCode).toBe(200);
    const dk = await ctx.app.inject({ method: 'POST', url: '/api/opening-balance/2026/post', headers: { cookie: t.cookie } });
    expect(dk.statusCode, dk.body).toBe(200);
    await t.post(voucher('BC', '2026-01-05', [L('1121', '1000000'), L('131', '0', '1000000', { partyCode: 'KH001' })], { bankAccountNo: '0011001' }));
    const book = async (no: string) => { const r = await t.get(`/api/reports/bank-book?from=2026-01-01&to=2026-01-31&bankAccountNo=${no}`); expect(r.statusCode, r.body).toBe(200); return r.json(); };
    expect(await book('0011001')).toMatchObject({ opening: '3000000', totalIn: '1000000', closing: '4000000' });
    expect(await book('0011002')).toMatchObject({ opening: '2000000', totalIn: '0', closing: '2000000' });
    // không còn dòng chưa gán: sổ chưa gán tài khoản ngân hàng trống, tổng các sổ khớp số dư 1121
    expect((await t.get('/api/reports/bank-book?from=2026-01-01&to=2026-01-31&accountCode=1121')).json()).toMatchObject({ opening: '0', closing: '0' });
    expect((await t.get('/api/cash/balance?accountCode=1121&asOf=2026-01-31')).json().balance).toBe('6000000');
  }, 60_000);
});

describe('cảnh báo tồn quỹ âm khi ghi sổ', () => {
  it('mặc định warn: ghi sổ thành công kèm cảnh báo CASH_NEGATIVE; đủ quỹ thì không có cảnh báo', async () => {
    const t = await tenant();
    expect((await t.get('/api/settings')).json().cash_negative).toBe('warn');
    const ok = await t.create(voucher('PT', '2026-01-05', [L('1111', '1000000'), L('5113', '0', '1000000')])); // thu đủ quỹ, nháp
    expect(ok.statusCode).toBe(201);
    const posted = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${ok.json().id}/post`, headers: { cookie: t.cookie } });
    expect(posted.statusCode, posted.body).toBe(200); expect(posted.json().state).toBe('posted'); expect(posted.json().warnings).toBeUndefined();

    const over = await t.create({ ...voucher('PC', '2026-01-06', [L('6422', '1500000'), L('1111', '0', '1500000')]), autoPost: true });
    expect(over.statusCode, over.body).toBe(201);
    expect(over.json().state).toBe('posted');
    expect(over.json().warnings).toEqual([{ code: 'CASH_NEGATIVE', message: expect.stringContaining('1111') }]);
    expect(over.json().warnings[0].message).toContain('500.000');
    // nháp rồi ghi sổ bằng /post cũng trả cảnh báo
    const d = (await t.create(voucher('PC', '2026-01-07', [L('6422', '1'), L('1111', '0', '1')]))).json();
    const p = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${d.id}/post`, headers: { cookie: t.cookie } });
    expect(p.json().warnings[0].code).toBe('CASH_NEGATIVE');
  }, 60_000);

  it('block: chi quá tồn quỹ bị 409 CASH_NEGATIVE, chứng từ vẫn là nháp; chi vừa đủ thì được', async () => {
    const t = await tenant(); await t.setCashNegative('block');
    await t.post(voucher('PT', '2026-01-05', [L('1111', '1000000'), L('5113', '0', '1000000')]));
    const draft = (await t.create(voucher('PC', '2026-01-06', [L('6422', '1000001'), L('1111', '0', '1000001')]))).json();
    const bad = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${draft.id}/post`, headers: { cookie: t.cookie } });
    expect(bad.statusCode, bad.body).toBe(409); expect(bad.json().error.code).toBe('CASH_NEGATIVE');
    expect((await t.get(`/api/vouchers/${draft.id}`)).json()).toMatchObject({ state: 'draft' });
    expect((await t.get('/api/cash/balance?accountCode=1111&asOf=2026-01-31')).json().balance).toBe('1000000'); // sổ không đổi
    // autoPost trong cùng giao dịch tạo: cả giao dịch hoàn tác, không sinh chứng từ
    const before = (await t.get('/api/vouchers?type=PC')).json().total;
    const auto = await t.create({ ...voucher('PC', '2026-01-06', [L('6422', '2000000'), L('1111', '0', '2000000')]), autoPost: true });
    expect(auto.statusCode).toBe(409); expect(auto.json().error.code).toBe('CASH_NEGATIVE');
    expect((await t.get('/api/vouchers?type=PC')).json().total).toBe(before);
    // vừa đủ quỹ thì ghi sổ được; phiếu chi sau đó vượt thì chặn
    const exact = await t.create({ ...voucher('PC', '2026-01-06', [L('6422', '1000000'), L('1111', '0', '1000000')]), autoPost: true });
    expect(exact.statusCode, exact.body).toBe(201);
    const one = await t.create({ ...voucher('PC', '2026-01-08', [L('6422', '1'), L('1111', '0', '1')]), autoPost: true });
    expect(one.statusCode).toBe(409);
    // chi ngày sớm hơn thu: kiểm tra theo ngày hạch toán (ngày 4 chưa có tiền)
    const early = await t.create({ ...voucher('PC', '2026-01-04', [L('6422', '1'), L('1111', '0', '1')]), autoPost: true });
    expect(early.statusCode).toBe(409);
  }, 60_000);

  it('block cũng áp dụng cho tiền gửi ngân hàng theo từng tài khoản ngân hàng, không bù số dư giữa hai tài khoản cùng 1121', async () => {
    const t = await tenant(); await t.setCashNegative('block');
    await t.post(voucher('BC', '2026-01-05', [L('1121', '1000'), L('131', '0', '1000', { partyCode: 'KH001' })], { bankAccountNo: '0011001' }));
    const bn = (bank: string) => t.create({ ...voucher('BN', '2026-01-06', [L('331', '500', '0', { partyCode: 'NCC001' }), L('1121', '0', '500')], { bankAccountNo: bank, purpose: 'chi_tra_ncc', partyCode: 'NCC001' }), autoPost: true });
    const bad = await bn('0011002'); // 0011002 chưa có tiền dù 1121 tổng còn 1.000
    expect(bad.statusCode, bad.body).toBe(409); expect(bad.json().error.code).toBe('CASH_NEGATIVE'); expect(bad.json().error.message).toContain('0011002');
    expect((await bn('0011001')).statusCode).toBe(201);
  }, 60_000);

  it('hai chứng từ chi quỹ đồng thời (phiếu chi và phiếu kế toán, hai bộ đếm số khác nhau), mỗi cái vừa quỹ nhưng cộng lại không: ở chế độ block luôn đúng một cái ghi sổ được', async () => {
    const t = await tenant(); await t.setCashNegative('block');
    await t.post(voucher('PT', '2026-01-05', [L('1111', '1000000'), L('5113', '0', '1000000')]));
    // PC và PKT dùng hai bộ đếm số khác nhau; việc tuần tự hóa còn lại là do post_voucher (hàng balance_stale), nên thử lặp để bắt lỗi nếu sau này mất.
    for (let i = 0; i < 4; i++) {
      const ids = await Promise.all(['PC', 'PKT'].map(async (type) => (await t.create(voucher(type, '2026-01-06', [L('6422', '600000'), L('1111', '0', '600000')]))).json().id as string));
      const res = await Promise.all(ids.map((id) => ctx.app.inject({ method: 'POST', url: `/api/vouchers/${id}/post`, headers: { cookie: t.cookie } })));
      expect(res.map((r) => r.statusCode).sort(), res.map((r) => r.body).join(' | ')).toEqual([200, 409]);
      // dọn: đảo phiếu đã ghi sổ bằng cách bỏ ghi sổ để vòng sau lại còn 1.000.000
      const okId = ids[res.findIndex((r) => r.statusCode === 200)]!;
      expect((await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${okId}/unpost`, headers: { cookie: t.cookie } })).statusCode).toBe(200);
    }
  }, 120_000);

  it('chứng từ ghi lùi ngày: ngày của chính nó còn dương nhưng làm ngày sau âm thì vẫn bị cảnh báo/chặn, nêu ngày âm đầu tiên', async () => {
    for (const mode of ['warn', 'block'] as const) {
      const t = await tenant(); await t.setCashNegative(mode);
      await t.post(voucher('PT', '2026-01-05', [L('1111', '1000000'), L('5113', '0', '1000000')]));
      await t.post(voucher('PC', '2026-01-10', [L('6422', '900000'), L('1111', '0', '900000')])); // cuối ngày 10 còn 100.000
      const back = await t.create({ ...voucher('PC', '2026-01-06', [L('6422', '500000'), L('1111', '0', '500000')]), autoPost: true }); // ngày 6 còn 500.000, nhưng ngày 10 âm 400.000
      if (mode === 'warn') {
        expect(back.statusCode, back.body).toBe(201);
        expect(back.json().warnings).toEqual([{ code: 'CASH_NEGATIVE', message: expect.stringContaining('âm 400.000 đ tại ngày 10/01/2026') }]);
        expect(back.json().warnings[0].message).toContain('hạch toán ngày 06/01/2026');
      } else {
        expect(back.statusCode, back.body).toBe(409); expect(back.json().error.code).toBe('CASH_NEGATIVE'); expect(back.json().error.message).toContain('10/01/2026');
        const drafts = (await t.get('/api/vouchers?type=PC')).json();
        expect(drafts.total).toBe(1); // phiếu chi ghi lùi bị hoàn tác hẳn (autoPost trong cùng giao dịch)
        // cùng phiếu ở dạng nháp: /post bị chặn và phiếu vẫn là nháp
        const d = (await t.create(voucher('PC', '2026-01-06', [L('6422', '500000'), L('1111', '0', '500000')]))).json();
        const bad = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${d.id}/post`, headers: { cookie: t.cookie } });
        expect(bad.statusCode, bad.body).toBe(409);
        expect((await t.get(`/api/vouchers/${d.id}`)).json().state).toBe('draft');
        // bớt xuống 100.000 thì ngày 10 về đúng 0: không phải âm
        const zero = await t.create({ ...voucher('PC', '2026-01-06', [L('6422', '100000'), L('1111', '0', '100000')]), autoPost: true });
        expect(zero.statusCode, zero.body).toBe(201);
      }
    }
  }, 60_000);

  it('tiền gửi: chứng từ ghi lùi ngày xét theo từng tài khoản ngân hàng, nêu ngày âm đầu tiên', async () => {
    const t = await tenant(); await t.setCashNegative('block');
    await t.post(voucher('BC', '2026-01-05', [L('1121', '1000'), L('131', '0', '1000', { partyCode: 'KH001' })], { bankAccountNo: '0011001' }));
    await t.post(voucher('BN', '2026-01-10', [L('331', '900', '0', { partyCode: 'NCC001' }), L('1121', '0', '900')], { bankAccountNo: '0011001', purpose: 'chi_tra_ncc', partyCode: 'NCC001' }));
    const bn = (amount: string) => t.create({ ...voucher('BN', '2026-01-06', [L('331', amount, '0', { partyCode: 'NCC001' }), L('1121', '0', amount)], { bankAccountNo: '0011001', purpose: 'chi_tra_ncc', partyCode: 'NCC001' }), autoPost: true });
    const bad = await bn('500');
    expect(bad.statusCode, bad.body).toBe(409); expect(bad.json().error.message).toContain('0011001'); expect(bad.json().error.message).toContain('10/01/2026');
    expect((await bn('100')).statusCode).toBe(201); // ngày 10 về đúng 0
  }, 60_000);

  it('bỏ ghi sổ phiếu thu mà các phiếu chi sau đó dựa vào: block chặn 409 (phiếu thu vẫn đã ghi sổ), warn bỏ ghi sổ kèm cảnh báo', async () => {
    for (const mode of ['block', 'warn'] as const) {
      const t = await tenant(); await t.setCashNegative(mode);
      const pt = await t.post(voucher('PT', '2026-01-05', [L('1111', '1000000'), L('5113', '0', '1000000')]));
      await t.post(voucher('PC', '2026-01-06', [L('6422', '600000'), L('1111', '0', '600000')]));
      const un = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${pt.id}/unpost`, headers: { cookie: t.cookie } });
      if (mode === 'block') {
        expect(un.statusCode, un.body).toBe(409); expect(un.json().error.code).toBe('CASH_NEGATIVE'); expect(un.json().error.message).toContain('Bỏ ghi sổ');
        expect((await t.get(`/api/vouchers/${pt.id}`)).json().state).toBe('posted');
      } else {
        expect(un.statusCode, un.body).toBe(200); expect(un.json().state).toBe('draft');
        expect(un.json().warnings).toEqual([{ code: 'CASH_NEGATIVE', message: expect.stringContaining('âm 600.000 đ tại ngày 06/01/2026') }]);
      }
    }
  }, 60_000);

  it('đảo phiếu thu làm quỹ âm: block chặn 409 và phiếu thu gốc vẫn là posted, không sinh chứng từ đảo; warn đảo kèm cảnh báo', async () => {
    for (const mode of ['block', 'warn'] as const) {
      const t = await tenant(); await t.setCashNegative(mode);
      const pt = await t.post(voucher('PT', '2026-01-05', [L('1111', '1000000'), L('5113', '0', '1000000')]));
      await t.post(voucher('PC', '2026-01-06', [L('6422', '600000'), L('1111', '0', '600000')]));
      const rev = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${pt.id}/reverse`, headers: { cookie: t.cookie }, payload: { postingDate: '2026-01-07' } });
      if (mode === 'block') {
        expect(rev.statusCode, rev.body).toBe(409); expect(rev.json().error.code).toBe('CASH_NEGATIVE'); expect(rev.json().error.message).toContain('Đảo chứng từ');
        expect((await t.get(`/api/vouchers/${pt.id}`)).json().state).toBe('posted');
        expect((await t.get('/api/vouchers?type=PT')).json().total).toBe(1);
      } else {
        expect(rev.statusCode, rev.body).toBe(201); expect(rev.json().state).toBe('posted');
        expect(rev.json().warnings).toEqual([{ code: 'CASH_NEGATIVE', message: expect.stringContaining('âm 600.000 đ tại ngày 07/01/2026') }]);
      }
    }
  }, 60_000);

  it('bỏ ghi sổ phiếu chi hay đảo phiếu chi (tiền vào quỹ) không bao giờ bị chặn', async () => {
    const t = await tenant(); await t.setCashNegative('block');
    await t.post(voucher('PT', '2026-01-05', [L('1111', '1000000'), L('5113', '0', '1000000')]));
    const pc = await t.post(voucher('PC', '2026-01-06', [L('6422', '600000'), L('1111', '0', '600000')]));
    const rev = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${pc.id}/reverse`, headers: { cookie: t.cookie }, payload: { postingDate: '2026-01-07' } });
    expect(rev.statusCode, rev.body).toBe(201); expect(rev.json().warnings).toBeUndefined();
  }, 60_000);

  it('cài đặt cash_negative chỉ nhận warn hoặc block', async () => {
    const t = await tenant();
    const put = (v: unknown) => ctx.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie: t.cookie }, payload: { cash_negative: v } });
    expect((await put('ignore')).statusCode).toBe(400);
    expect((await put('block')).statusCode).toBe(200);
    expect((await t.get('/api/settings')).json().cash_negative).toBe('block');
  });
});

describe('cột số phiếu thu/chi theo chiều tiền', () => {
  it('chứng từ đảo của phiếu thu nằm ở cột phiếu chi (tiền ra); phiếu vừa thu vừa chi có cả hai số; phiếu thu thường vẫn ở cột thu', async () => {
    const t = await tenant();
    const pt = await t.post(voucher('PT', '2026-01-05', [L('1111', '1000000'), L('5113', '0', '1000000')]));
    const rev = await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${pt.id}/reverse`, headers: { cookie: t.cookie }, payload: { postingDate: '2026-01-08' } });
    expect(rev.statusCode, rev.body).toBe(201);
    const mixed = await t.post(voucher('PT', '2026-01-09', [L('1111', '500'), L('5113', '0', '300'), L('1111', '0', '200')]));
    const b = (await t.get('/api/reports/cash-book?accountCode=1111&from=2026-01-01&to=2026-01-31')).json();
    expect(b.rows).toHaveLength(3);
    expect(b.rows[0]).toMatchObject({ voucherId: pt.id, receiptNo: pt.voucherNo, paymentNo: null, in: '1000000' });
    expect(b.rows[1]).toMatchObject({ voucherId: rev.json().id, receiptNo: null, paymentNo: rev.json().voucherNo, in: '0', out: '1000000' });
    expect(b.rows[2]).toMatchObject({ voucherId: mixed.id, receiptNo: mixed.voucherNo, paymentNo: mixed.voucherNo, in: '500', out: '200' });
  }, 60_000);

  it('cùng ngày, chứng từ thu ròng xếp trước chứng từ chi ròng (không so chéo Nợ với Có của hai chứng từ)', async () => {
    const t = await tenant();
    const pkt = await t.post(voucher('PKT', '2026-01-05', [L('1111', '50'), L('1111', '0', '200'), L('6422', '150')])); // thu 50, chi 200; loại PKT xếp trước PT theo mã loại
    const pt = await t.post(voucher('PT', '2026-01-05', [L('1111', '100'), L('5113', '0', '100')]));
    const b = (await t.get('/api/reports/cash-book?accountCode=1111&from=2026-01-01&to=2026-01-31')).json();
    expect(b.rows.map((r: { voucherId: string }) => r.voucherId)).toEqual([pt.id, pkt.id]);
  }, 60_000);

  it('sổ tiền gửi: chỉ nhận tài khoản ngân hàng, tài khoản tiền mặt bị 400 NOT_BANK_ACCOUNT', async () => {
    const t = await tenant();
    const r = await t.get('/api/reports/bank-book?accountCode=1111&from=2026-01-01&to=2026-01-31');
    expect(r.statusCode, r.body).toBe(400); expect(r.json().error.code).toBe('NOT_BANK_ACCOUNT');
    expect((await t.get('/api/reports/bank-book?accountCode=112&from=2026-01-01&to=2026-01-31')).statusCode).toBe(200); // tài khoản cấp 2 gồm 1121, 1122
    expect((await t.get('/api/reports/bank-book?accountCode=1121&from=2026-01-01&to=2026-01-31')).statusCode).toBe(200);
  }, 60_000);
});

describe('phân quyền sổ quỹ', () => {
  const asUser = async (t: Awaited<ReturnType<typeof tenant>>, permissions: string[]) => {
    const roles = (await ctx.app.inject({ method: 'GET', url: '/api/roles', headers: { cookie: t.cookie } })).json() as { id: string; code: string }[];
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/roles/${roles.find((x) => x.code === 'xem')!.id}/permissions`, headers: { cookie: t.cookie }, payload: { permissions } })).statusCode).toBe(200);
    const username = `xq_${Date.now()}_${n++}`;
    expect((await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie: t.cookie }, payload: { username, fullName: 'Chỉ xem', password: 'Matkhau1!', roleCode: 'xem' } })).statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
  };
  const q = '&from=2026-01-01&to=2026-01-31';
  const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });

  it('chỉ voucher.view: xem số dư tại ngày được, sổ quỹ báo cáo 403', async () => {
    const t = await tenant(); const c = await asUser(t, ['voucher.view']);
    expect((await get('/api/cash/balance?accountCode=1111&asOf=2026-01-31', c)).statusCode).toBe(200);
    expect((await get(`/api/reports/cash-book?accountCode=1111${q}`, c)).statusCode).toBe(403);
    expect((await get(`/api/reports/bank-book?bankAccountNo=0011001${q}`, c)).statusCode).toBe(403);
  }, 60_000);

  it('chỉ report.view: sổ quỹ JSON được, số dư tại ngày 403, xuất Excel/PDF/HTML cần thêm report.print', async () => {
    const t = await tenant(); const c = await asUser(t, ['report.view']);
    expect((await get(`/api/reports/cash-book?accountCode=1111${q}`, c)).statusCode).toBe(200);
    expect((await get('/api/cash/balance?accountCode=1111&asOf=2026-01-31', c)).statusCode).toBe(403);
    for (const f of ['xlsx', 'html', 'pdf']) expect((await get(`/api/reports/cash-book?accountCode=1111${q}&format=${f}`, c)).statusCode, f).toBe(403);
  }, 60_000);
});
