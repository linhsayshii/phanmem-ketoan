import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VoucherDto } from '../src/modules/ledger/vouchers.service.js';
import { renderPdf } from '../src/modules/reporting/print/pdf.js';
import { renderVoucherHtml } from '../src/modules/reporting/print/voucherHtml.js';
import { renderCashVoucherHtml } from '../src/modules/reporting/print/cashVoucherHtml.js';
import { voucherFormFor } from '../src/modules/reporting/print/forms.js';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

let ctx: TestApp; let cookie: string; let id: string;
beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie } = await bootstrapTenant(ctx, { code: `PT${Date.now()}` }));
  await ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } });
  id = (await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: '2026-01-05', documentDate: '2026-01-05', description: 'Chi văn phòng phẩm', autoPost: true, lines: [{ accountCode: '6422', debit: '1500000' }, { accountCode: '1111', credit: '1500000' }] } })).json().id;
}, 30_000);
afterAll(async () => { await ctx.close(); });

describe('in phiếu kế toán', () => {
  it('HTML có tên công ty, số chứng từ, số tiền định dạng Việt Nam, chữ ký', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${id}/print?format=html`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('PHIẾU KẾ TOÁN'); expect(r.body).toContain('PKT00001'); expect(r.body).toContain('1.500.000'); expect(r.body).toContain('Kế toán trưởng'); expect(r.body).toContain('6422');
  }, 30_000);
  it('PDF bắt đầu bằng %PDF, tên tệp mã hóa theo RFC 5987', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${id}/print?format=pdf`, headers: { cookie } });
    expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toBe('application/pdf'); expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(r.headers['content-disposition']).toBe(`inline; filename*=UTF-8''${encodeURIComponent('PKT00001.pdf')}`);
  }, 60_000);
});

describe('in phiếu kế toán: nội dung', () => {
  it('diễn giải có thẻ script được thoát ký tự trong HTML in', async () => {
    const c = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: '2026-01-06', documentDate: '2026-01-06', description: '<script>alert(1)</script>', lines: [{ accountCode: '6422', debit: '10' }, { accountCode: '1111', credit: '10' }] } });
    expect(c.statusCode, c.body).toBe(201);
    const r = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${c.json().id}/print?format=html`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('&lt;script&gt;'); expect(r.body).not.toContain('<script>alert');
  }, 30_000);

  it('phiếu nháp lệch: Cộng Nợ và Cộng Có tính riêng (Có không lấy theo Nợ)', () => {
    const line = (lineNo: number, accountCode: string, debit: string, credit: string) => ({ lineNo, accountCode, accountName: 'x', debit, credit, partyCode: null, partyName: null, description: null });
    const v = { id: 'x', voucherType: 'PKT', voucherNo: null, postingDate: '2026-01-05', state: 'draft', description: 'Nháp lệch', partyName: null, totalDebit: '1500000',
      lines: [line(1, '6422', '1500000', '0'), line(2, '1111', '0', '1000000')] } as unknown as VoucherDto;
    const html = renderVoucherHtml(v, { name: 'Cty', address: null, taxCode: null, legalRep: null, chiefAccountant: null, formNo: 'PKT', issuedBy: '' });
    expect(html).toMatch(/<b>Cộng<\/b><\/td><td class="num"><b>1\.500\.000<\/b><\/td><td class="num"><b>1\.000\.000<\/b><\/td>/);
  });
});

// Tiêu đề tài liệu nằm trong từ điển Info của PDF, dạng UTF-16BE (chuỗi hex) hoặc chuỗi thường.
const hasTitle = (pdf: Buffer, title: string) => {
  const s = pdf.toString('latin1');
  const hex = Buffer.from(title, 'utf16le').swap16().toString('hex').toUpperCase();
  return s.toUpperCase().includes(`<FEFF${hex}>`) || s.includes(`(${title})`);
};

describe('renderPdf: cách ly', () => {
  it('không chạy script và không gọi ra ngoài; vẫn tạo được PDF', async () => {
    let hits = 0;
    const srv = createServer((_q, res) => { hits++; res.end(); });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    const port = (srv.address() as AddressInfo).port;
    try {
      const html = `<!doctype html><html><head><title>AN_TOAN</title><link rel="stylesheet" href="http://127.0.0.1:${port}/a.css"></head>
        <body><p>noi dung</p><img src="http://127.0.0.1:${port}/x.png"><img src="http://127.0.0.1:9/x">
        <script>document.title = 'DA_CHAY_SCRIPT'; fetch('http://127.0.0.1:${port}/js');</script></body></html>`;
      const pdf = await renderPdf(html);
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      expect(hasTitle(pdf, 'AN_TOAN')).toBe(true); // đối chứng: kiểm tra tiêu đề thật sự đọc được
      expect(hasTitle(pdf, 'DA_CHAY_SCRIPT')).toBe(false);
      expect(hits).toBe(0);
    } finally { await new Promise((ok) => srv.close(ok)); }
  }, 60_000);
});

describe('in phiếu thu, phiếu chi, giấy báo, ủy nhiệm chi', () => {
  let c133: string; let c99: string;
  const L = (accountCode: string, debit = '0', credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
  const mk = async (cookie: string, voucherType: string, lines: object[], more: object = {}) => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType, postingDate: '2026-03-15', documentDate: '2026-03-15', description: 'Thu tiền hàng tháng 3', autoPost: true, lines, ...more } });
    expect(r.statusCode, r.body).toBe(201); return r.json().id as string;
  };
  const print = (cookie: string, id: string, q = '') => ctx.app.inject({ method: 'GET', url: `/api/vouchers/${id}/print?format=html${q}`, headers: { cookie } });
  const order = (html: string, names: string[]) => names.map((n) => html.indexOf(`<b>${n}</b>`));
  let pt: string; let pc: string; let bn: string; let bc: string; let pt99: string;
  beforeAll(async () => {
    c133 = (await setupLedgerTenant(ctx, `IN${Date.now()}`)).cookie;
    c99 = (await setupLedgerTenant(ctx, `IM${Date.now()}`, 'TT99')).cookie;
    await ctx.app.inject({ method: 'PUT', url: '/api/company', headers: { cookie: c133 }, payload: { name: 'Công ty TNHH In Mẫu', address: '1 Tràng Tiền', legalRep: 'Lê Văn C', chiefAccountant: 'Phạm Thị D' } });
    for (const [name, payload] of [['bank', { code: 'VCB', name: 'Vietcombank' }], ['bank_account', { bank_code: 'VCB', account_no: '0011001', gl_account_code: '1121' }],
      ['party_bank_account', { party_code: 'NCC001', bank_name: 'Techcombank', account_no: '19001', account_name: 'Công ty NCC Một' }]] as const) {
      const r = await ctx.app.inject({ method: 'POST', url: `/api/catalogs/${name}`, headers: { cookie: c133 }, payload }); expect(r.statusCode, r.body).toBe(201);
    }
    pt = await mk(c133, 'PT', [L('1111', '5000000'), L('131', '0', '5000000', { partyCode: 'KH001' })], { purpose: 'thu_khach_hang', partyCode: 'KH001', personName: 'Nguyễn Văn A', personAddress: '12 Lê Lợi', attachmentsCount: 2 });
    pc = await mk(c133, 'PC', [L('6422', '1500000'), L('1111', '0', '1500000')], { description: 'Chi văn phòng phẩm', personName: 'Trần Thị B' });
    bn = await mk(c133, 'BN', [L('331', '90000000', '0', { partyCode: 'NCC001' }), L('1121', '0', '90000000')], { description: 'Trả tiền hàng theo hợp đồng 01', bankAccountNo: '0011001', purpose: 'chi_tra_ncc', partyCode: 'NCC001', partyBankAccountNo: '19001' });
    bc = await mk(c133, 'BC', [L('1121', '7000'), L('131', '0', '7000', { partyCode: 'KH001' })], { bankAccountNo: '0011001', partyCode: 'KH001' });
    pt99 = await mk(c99, 'PT', [L('111', '120'), L('131', '0', '120', { partyCode: 'KH001' })], { purpose: 'thu_khach_hang', partyCode: 'KH001' });
  }, 60_000);

  it('Phiếu thu TT133: Mẫu số 01 - TT, số tiền bằng chữ, người nộp, tài khoản Nợ/Có, thứ tự chữ ký theo mẫu', async () => {
    const r = await print(c133, pt); expect(r.statusCode, r.body).toBe(200);
    for (const t of ['Mẫu số 01 - TT', '(Ban hành theo Thông tư số 133/2016/TT-BTC ngày 26/8/2016 của Bộ Tài chính)', 'Đơn vị: <b>Công ty TNHH In Mẫu</b>', 'Địa chỉ: 1 Tràng Tiền', 'PHIẾU THU',
      'Ngày 15 tháng 03 năm 2026', 'Họ và tên người nộp tiền: <b>Nguyễn Văn A</b>', 'Địa chỉ: <b>12 Lê Lợi</b>', 'Lý do nộp: <b>Thu tiền hàng tháng 3</b>', 'Nợ: 1111', 'Có: 131',
      '5.000.000 đồng', 'Năm triệu đồng', 'Kèm theo: <b>2</b> Chứng từ gốc', 'Đã nhận đủ số tiền (viết bằng chữ)', '+ Tỷ giá ngoại tệ:', '+ Số tiền quy đổi:', '(Liên gửi ra ngoài phải đóng dấu)', 'Quyển số:', 'Lê Văn C', 'Phạm Thị D']) expect(r.body, t).toContain(t);
    expect(r.body).not.toContain('PKT');
    const at = order(r.body, ['Giám đốc', 'Kế toán trưởng', 'Người nộp tiền', 'Người lập phiếu', 'Thủ quỹ']);
    expect(at.every((x) => x > 0)).toBe(true); expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(r.body).toContain('(Ký, họ tên, đóng dấu)');
    expect((await print(c133, pt, '&form=default')).body).toBe(r.body); // default = mẫu đầu của loại
    expect((await print(c133, pt, '&form=01-TT')).body).toBe(r.body);
  }, 30_000);

  it('Phiếu chi TT133: Mẫu số 02 - TT, người nhận tiền, Lý do chi, thứ tự chữ ký khác phiếu thu', async () => {
    const r = await print(c133, pc); expect(r.statusCode, r.body).toBe(200);
    for (const t of ['Mẫu số 02 - TT', 'PHIẾU CHI', 'Họ và tên người nhận tiền: <b>Trần Thị B</b>', 'Lý do chi: <b>Chi văn phòng phẩm</b>', 'Nợ: 6422', 'Có: 1111', 'Một triệu năm trăm nghìn đồng', 'Kèm theo: ']) expect(r.body, t).toContain(t);
    const at = order(r.body, ['Giám đốc', 'Kế toán trưởng', 'Thủ quỹ', 'Người lập phiếu', 'Người nhận tiền']);
    expect(at.every((x) => x > 0)).toBe(true); expect([...at].sort((a, b) => a - b)).toEqual(at);
  }, 30_000);

  it('Phiếu thu TT99: chú thích ban hành và dòng tỷ giá (vàng bạc, đá quý) theo mẫu của TT 99/2025', async () => {
    const r = await print(c99, pt99); expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('Mẫu số 01 - TT'); expect(r.body).toContain('(Kèm theo Thông tư số 99/2025/TT-BTC ngày 27 tháng 10 năm 2025 của Bộ trưởng Bộ Tài chính)');
    expect(r.body).toContain('+ Tỷ giá ngoại tệ (vàng bạc, đá quý):'); expect(r.body).toContain('Một trăm hai mươi đồng'); expect(r.body).not.toContain('133/2016');
  }, 30_000);

  it('chế độ không có văn bản gốc đối chiếu (TT200, TT58): không in dòng "Mẫu số"', () => {
    expect(voucherFormFor('TT133', '01-TT')).toEqual({ formNo: '01 - TT', issuedBy: expect.stringContaining('133/2016/TT-BTC') });
    for (const regime of ['TT200', 'TT58']) expect(voucherFormFor(regime, '01-TT')).toBeNull();
    expect(voucherFormFor('TT133', 'giay-bao')).toBeNull(); expect(voucherFormFor('TT133', 'unc')).toBeNull();
    const v = { voucherType: 'PT', voucherNo: 'PT00001', postingDate: '2026-03-15', description: 'x', totalDebit: '10', currencyCode: 'VND', fxRate: null, personName: null, personAddress: null, partyName: null, attachmentsCount: null,
      lines: [{ lineNo: 1, accountCode: '1111', debit: '10', credit: '0' }, { lineNo: 2, accountCode: '131', debit: '0', credit: '10' }] } as unknown as VoucherDto;
    const html = renderCashVoucherHtml(v, { name: 'Cty', address: null, taxCode: null, legalRep: null, chiefAccountant: null, formNo: '', issuedBy: '' }, { form: '01-TT', regime: 'TT200' });
    expect(html).toContain('PHIẾU THU'); expect(html).not.toContain('Mẫu số'); expect(html).toContain('Mười đồng');
  });

  it('Giấy báo Nợ: mẫu nội bộ không ghi "Mẫu số", có tài khoản ngân hàng, ngân hàng, số tiền bằng chữ', async () => {
    const r = await print(c133, bn); expect(r.statusCode, r.body).toBe(200);
    for (const t of ['GIẤY BÁO NỢ', '0011001', 'Vietcombank', 'Chín mươi triệu đồng', '90.000.000', 'Trả tiền hàng theo hợp đồng 01']) expect(r.body, t).toContain(t);
    expect(r.body).not.toContain('Mẫu số');
    const c = await print(c133, bc); expect(c.body).toContain('GIẤY BÁO CÓ'); expect(c.body).toContain('Bảy nghìn đồng'); expect(c.body).not.toContain('Mẫu số');
    expect((await print(c133, bn, '&form=giay-bao')).body).toBe(r.body);
  }, 30_000);

  it('Ủy nhiệm chi từ Giấy báo Nợ: bên trả, bên thụ hưởng theo tài khoản của đối tượng, số tiền bằng số và chữ', async () => {
    const r = await print(c133, bn, '&form=unc'); expect(r.statusCode, r.body).toBe(200);
    for (const t of ['ỦY NHIỆM CHI', 'Đơn vị trả tiền: <b>Công ty TNHH In Mẫu</b>', '0011001', 'Vietcombank', 'Đơn vị thụ hưởng: <b>Công ty NCC Một</b>', '19001', 'Techcombank',
      '90.000.000', 'Chín mươi triệu đồng', 'Trả tiền hàng theo hợp đồng 01']) expect(r.body, t).toContain(t);
    expect(r.body).not.toContain('Mẫu số');
    const pdf = await ctx.app.inject({ method: 'GET', url: `/api/vouchers/${bn}/print?format=pdf&form=unc`, headers: { cookie: c133 } });
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF'); expect(pdf.headers['content-disposition']).toContain(encodeURIComponent('-unc.pdf'));
  }, 60_000);

  it('Phiếu thu ngoại tệ: Số tiền là nguyên tệ kèm mã tiền và đọc bằng chữ theo tên tiền; Số tiền quy đổi là VND kèm chữ', async () => {
    const usd = await mk(c133, 'PT', [L('1112', '30492700', '0', { amountCurrency: '1200.50' }), L('131', '0', '30492700', { amountCurrency: '-1200.50', partyCode: 'KH001' })],
      { currencyCode: 'USD', fxRate: '25400', partyCode: 'KH001', personName: 'John Smith' });
    const r = await print(c133, usd); expect(r.statusCode, r.body).toBe(200);
    for (const t of ['Số tiền: <b>1.200,50 USD</b>', '(Viết bằng chữ): <b>Một nghìn hai trăm đô la Mỹ phẩy năm mươi</b>', '+ Tỷ giá ngoại tệ: <b>25.400 (USD)</b>',
      '+ Số tiền quy đổi: <b>30.492.700 đồng</b> (<b>Ba mươi triệu bốn trăm chín mươi hai nghìn bảy trăm đồng</b>)']) expect(r.body, t).toContain(t);
    expect(r.body).not.toContain('Số tiền: <b>30.492.700');
  }, 30_000);

  it('Giấy báo và Ủy nhiệm chi ngoại tệ: số tiền nguyên tệ, chữ theo tên tiền, dòng quy đổi VND', () => {
    const line = (lineNo: number, accountCode: string, debit: string, credit: string, amountCurrency: string) => ({ lineNo, accountCode, debit, credit, amountCurrency });
    const v = { voucherType: 'BN', voucherNo: 'BN00001', postingDate: '2026-03-15', description: 'x', totalDebit: '38100', currencyCode: 'USD', fxRate: '25400', personName: null, personAddress: null, partyName: 'NCC', attachmentsCount: null,
      lines: [line(1, '331', '38100', '0', '1.5000'), line(2, '1122', '0', '38100', '-1.5000')] } as unknown as VoucherDto;
    const co = { name: 'Cty', address: null, taxCode: null, legalRep: null, chiefAccountant: null, formNo: '', issuedBy: '' };
    for (const form of ['giay-bao', 'unc']) {
      const html = renderCashVoucherHtml(v, co, { form, regime: 'TT133', kinds: { '1122': 'bank' }, currencyName: 'Đô la Mỹ' });
      for (const t of ['<b>1,50 USD</b>', 'Một đô la Mỹ phẩy năm mươi', '<b>38.100 đồng</b> (<b>Ba mươi tám nghìn một trăm đồng</b>)', '25.400 (USD)']) expect(html, `${form}: ${t}`).toContain(t);
    }
  });

  it('Số tiền lấy theo dòng quỹ/ngân hàng ở bên tiền của loại chứng từ, không cộng mọi dòng Nợ', async () => {
    const vk = { partyCode: 'KH001' };
    const a = await print(c133, await mk(c133, 'PT', [L('1111', '1000000'), L('131', '0', '900000', vk), L('33311', '0', '100000')], vk)); // một dòng quỹ: bằng tổng Nợ
    expect(a.body).toContain('Số tiền: <b>1.000.000 đồng</b>'); expect(a.body).toContain('Một triệu đồng');
    const b = await print(c133, await mk(c133, 'PT', [L('1111', '950000'), L('635', '50000'), L('131', '0', '1000000', vk)], vk)); // Nợ 635 chiết khấu: tổng Nợ 1.000.000 nhưng tiền thu 950.000
    expect(b.body).toContain('Số tiền: <b>950.000 đồng</b>'); expect(b.body).toContain('Chín trăm năm mươi nghìn đồng'); expect(b.body).not.toContain('1.000.000');
    const c = await print(c133, await mk(c133, 'PC', [L('6422', '1000000'), L('1111', '0', '900000'), L('3388', '0', '100000')])); // Phiếu chi: dòng Có quỹ
    expect(c.body).toContain('Số tiền: <b>900.000 đồng</b>'); expect(c.body).toContain('Chín trăm nghìn đồng'); expect(c.body).not.toContain('1.000.000');
    const u = await print(c133, await mk(c133, 'BN', [L('331', '90000000', '0', { partyCode: 'NCC001' }), L('1121', '0', '89000000'), L('3388', '0', '1000000')], { bankAccountNo: '0011001', partyCode: 'NCC001', partyBankAccountNo: '19001' }), '&form=unc');
    expect(u.body).toContain('Số tiền bằng số: <b>89.000.000 đồng</b>'); expect(u.body).toContain('Tám mươi chín triệu đồng'); expect(u.body).not.toContain('90.000.000');
  }, 60_000);

  it.each(['01-TT', '02-TT', 'giay-bao', 'unc'].flatMap((f) => [[f, false], [f, true]] as const))('mẫu %s (ngoại tệ: %s) thoát HTML mọi trường người dùng nhập', (form, fx) => {
    const evil = '<script>alert(1)</script>';
    const line = (lineNo: number, debit: string, credit: string, amountCurrency: string) => ({ lineNo, accountCode: evil, debit, credit, amountCurrency });
    const v = { voucherType: form === '01-TT' ? 'PT' : form === '02-TT' ? 'PC' : 'BN', voucherNo: evil, postingDate: '2026-03-15', description: evil, totalDebit: '10', currencyCode: fx ? 'USD' : 'VND', fxRate: fx ? '25400' : null,
      personName: evil, personAddress: evil, partyName: evil, partyBankAccountNo: evil, attachmentsCount: null, lines: [line(1, '10', '0', '1.5'), line(2, '0', '10', '-1.5')] } as unknown as VoucherDto;
    const bank = { accountNo: evil, accountName: evil, bankName: evil, branch: evil };
    const html = renderCashVoucherHtml(v, { name: evil, address: evil, taxCode: evil, legalRep: evil, chiefAccountant: evil, formNo: evil, issuedBy: evil }, { form, regime: 'TT133', own: bank, party: bank, kinds: { [evil]: 'bank' }, currencyName: evil });
    expect(html).not.toContain('<script>alert'); expect(html).toContain('&lt;script&gt;');
  });

  it('mẫu in không thuộc loại chứng từ: 400 PRINT_FORM_INVALID (Ủy nhiệm chi cho Phiếu thu, mẫu lạ, Phiếu kế toán)', async () => {
    const cases: [string, string, string][] = [[c133, pt, 'unc'], [c133, pt, 'giay-bao'], [c133, pc, '01-TT'], [c133, bn, '02-TT'], [c133, bn, 'khong-co'], [cookie, id, '01-TT'], [cookie, id, 'unc']];
    for (const [ck, vid, form] of cases) {
      const r = await print(ck, vid, `&form=${form}`);
      expect(r.statusCode, `${form}: ${r.body}`).toBe(400); expect(r.json().error.code).toBe('PRINT_FORM_INVALID');
    }
  }, 30_000);
});
