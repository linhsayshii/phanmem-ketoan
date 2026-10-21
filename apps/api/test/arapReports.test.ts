import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { toVnd } from '@kt/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { setupLedgerTenant } from './invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

const L = (accountCode: string, debit = '0', credit = '0', more: object = {}) => ({ accountCode, debit, credit, ...more });
const K = (accountCode: string, partyCode: string, debit = '0', credit = '0', more: object = {}) => L(accountCode, debit, credit, { partyCode, ...more });
type Res = Awaited<ReturnType<TestApp['app']['inject']>>;
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const textOfPdf = (buf: Buffer) => spawnSync('pdftotext', ['-layout', '-', '-'], { input: buf }).stdout.toString('utf8').replace(/\s+/g, ' ');
const hasPdftotext = spawnSync('pdftotext', ['-v']).error === undefined;
const flat = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// Mỗi bộ kiểm thử một công ty riêng (năm 2026, TT133), đối tượng KH001 "Khách 1", KH002 "Khách 2", NCC001 "NCC 1".
async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `CN${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST', url: string, payload?: object, c = cookie): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
  const get = async (url: string, c = cookie) => { const r = await call('GET', url, undefined, c); return { status: r.statusCode, json: (r.headers['content-type'] as string).startsWith('application/json') ? r.json() as Json : null, r }; };
  const pkt = async (date: string, lines: object[], extra: object = {}) => {
    const r = await call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: `CT ${date}`, autoPost: true, ...extra, lines });
    expect(r.statusCode, r.body).toBe(201); return r.json() as { id: string };
  };
  const itemOf = async (voucherId: string) => (await sql<{ id: number }>`SELECT id::int AS id FROM open_item WHERE voucher_id = ${voucherId}::uuid ORDER BY line_no LIMIT 1`.execute(ctx.t.admin)).rows[0]!.id;
  const settle = (debitItem: number, creditItem: number, amount: string, date: string) =>
    sql`INSERT INTO settlement(tenant_id, debit_item_id, credit_item_id, amount, amount_currency, settle_date, kind, group_id) VALUES (${tenantId}::uuid, ${debitItem}, ${creditItem}, ${amount}::numeric, ${amount}::numeric, ${date}::date, 'manual', gen_random_uuid())`.execute(ctx.t.admin);
  const userWith = async (flags: string[]) => {
    const username = `ar_${flags.length}_${Date.now()}_${n++}`;
    const made = await call('POST', '/api/users', { username, fullName: 'X', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: flags }); expect(made.statusCode, made.body).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
    return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
  };
  // Số dư ròng (Nợ − Có) của tài khoản tại cuối ngày, cộng thẳng từ dòng chứng từ đã ghi sổ: nguồn đối chiếu độc lập với báo cáo.
  const ledgerNet = async (code: string, asOf: string) => (await sql<{ n: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted', 'reversed') AND a.code = ${code} AND l.posting_date <= ${asOf}::date`.execute(ctx.t.admin)).rows[0]!.n;
  return { cookie, tenantId, call, get, pkt, itemOf, settle, userWith, ledgerNet };
}

// Bảy khoản công nợ: KH001 năm khoản hạn khác nhau (tính đến 31/03/2026 quá hạn 0, 11, 49, 90, 91 ngày), KH002 một khoản quá hạn 211 ngày ghi sổ ngày 20/02;
// thu 700 đối trừ một phần khoản 2.000 của KH001, thu 500 của KH002 chưa đối trừ (trả trước), NCC001 trả trước 300.
async function seed(t: Awaited<ReturnType<typeof tenant>>) {
  const inv = (date: string, party: string, amount: string, due: string) => t.pkt(date, [K('131', party, amount, '0', { dueDate: due }), L('5113', '0', amount)]);
  const v1 = await inv('2026-01-05', 'KH001', '1000', '2026-04-15');
  const v2 = await inv('2026-01-05', 'KH001', '2000', '2026-03-20');
  const v3 = await inv('2026-01-05', 'KH001', '4000', '2026-02-10');
  const v4 = await inv('2026-01-05', 'KH001', '16000', '2025-12-31');
  const v5 = await inv('2026-01-05', 'KH001', '8000', '2025-12-30');
  const v6 = await inv('2026-02-20', 'KH002', '32000', '2025-09-01');
  const r1 = await t.pkt('2026-03-05', [L('1111', '700'), K('131', 'KH001', '0', '700')]);
  await t.settle(await t.itemOf(v2.id), await t.itemOf(r1.id), '700', '2026-03-05');
  await t.pkt('2026-03-01', [L('1111', '500'), K('131', 'KH002', '0', '500')]);
  await t.pkt('2026-03-10', [L('1111', '300'), K('131', 'NCC001', '0', '300')]);
  return { v1, v2, v3, v4, v5, v6, r1 };
}

const ZERO_ROW = { notDue: '0', b0: '0', b1: '0', b2: '0', b3: '0', b4: '0', credit: '0', total: '0' };
const agingRow = (r: Json) => Object.fromEntries(['notDue', 'b0', 'b1', 'b2', 'b3', 'b4', 'credit', 'total'].map((k) => [k, r[k]]));

describe('báo cáo công nợ phải thu', () => {
  let t: Awaited<ReturnType<typeof tenant>>;
  beforeAll(async () => {
    t = await tenant(); await seed(t);
    await sql`UPDATE tenant SET address = '12 Nguyễn Huệ, Quận 1', tax_code = '0101234567', legal_rep = 'Nguyễn Văn A' WHERE id = ${t.tenantId}::uuid`.execute(ctx.t.admin);
  });

  it('tuổi nợ: ba khoản hạn khác nhau rơi đúng nhóm, tổng bằng Σ dư của các khoản còn mở', async () => {
    const { status, json } = await t.get('/api/reports/arap/aging?accountCode=131&asOf=2026-03-31');
    expect(status).toBe(200);
    expect(json.columns.map((c: Json) => c.label)).toEqual(['Chưa đến hạn', '1–30', '31–60', '61–90', '91–180', '>180', 'Trả trước / dư Có', 'Tổng']);
    const byParty = Object.fromEntries(json.rows.map((r: Json) => [r.partyCode, agingRow(r)]));
    expect(byParty).toEqual({
      KH001: { ...ZERO_ROW, notDue: '1000', b0: '1300', b1: '4000', b2: '16000', b3: '8000', total: '30300' }, // 16.000 quá hạn đúng 90 ngày vào 61–90, 8.000 quá hạn 91 ngày vào 91–180
      KH002: { ...ZERO_ROW, b4: '32000', credit: '-500', total: '31500' },
      NCC001: { ...ZERO_ROW, credit: '-300', total: '-300' },
    });
    expect(agingRow(json.totals)).toEqual({ notDue: '1000', b0: '1300', b1: '4000', b2: '16000', b3: '8000', b4: '32000', credit: '-800', total: '61500' });
    // Tổng = Σ dư của open_item (fn_open_items_at) = số dư sổ cái TK 131.
    const sum = (await sql<{ n: string }>`SELECT sum(x.residual)::text AS n FROM fn_open_items_at(${t.tenantId}::uuid, '2026-03-31'::date) x JOIN account a ON a.id = x.account_id WHERE a.code = '131'`.execute(ctx.t.admin)).rows[0]!.n;
    expect([json.totals.total, sum, await t.ledgerNet('131', '2026-03-31')]).toEqual(['61500', '61500', '61500']);
  });

  it('tuổi nợ theo ngày chứng từ khác theo hạn thanh toán; có đối tượng thì liệt kê từng khoản', async () => {
    const due = (await t.get('/api/reports/arap/aging?accountCode=131&asOf=2026-03-31&by=due')).json;
    const doc = (await t.get('/api/reports/arap/aging?accountCode=131&asOf=2026-03-31&by=doc')).json;
    const byParty = Object.fromEntries(doc.rows.map((r: Json) => [r.partyCode, agingRow(r)]));
    // Ngày chứng từ 05/01 cách 85 ngày (61–90), 20/02 cách 39 ngày (31–60); không có khoản nào "chưa đến hạn" vì mọi chứng từ đã ghi trước ngày xem.
    expect(byParty).toEqual({ KH001: { ...ZERO_ROW, b2: '30300', total: '30300' }, KH002: { ...ZERO_ROW, b1: '32000', credit: '-500', total: '31500' }, NCC001: { ...ZERO_ROW, credit: '-300', total: '-300' } });
    expect(doc.rows).not.toEqual(due.rows);
    expect(doc.totals.total).toBe(due.totals.total);

    const one = (await t.get('/api/reports/arap/aging?accountCode=131&partyCode=KH001&asOf=2026-03-31')).json;
    expect(one.rows.map((r: Json) => r.partyCode)).toEqual(['KH001']);
    expect(one.items.map((i: Json) => [i.dueDate, i.residual, i.daysOverdue, i.bucket])).toEqual([
      ['2025-12-30', '8000', 91, 'b3'], ['2025-12-31', '16000', 90, 'b2'], ['2026-02-10', '4000', 49, 'b1'], ['2026-03-20', '1300', 11, 'b0'], ['2026-04-15', '1000', -15, 'notDue']]);
  });

  it('tuổi nợ: nhóm tùy chỉnh theo buckets và từ chối nhóm không tăng dần', async () => {
    const { status, json } = await t.get('/api/reports/arap/aging?accountCode=131&partyCode=KH001&asOf=2026-03-31&buckets=15,45');
    expect(status).toBe(200);
    expect(json.columns.map((c: Json) => c.label).slice(0, 5)).toEqual(['Chưa đến hạn', '1–15', '16–45', '>45', 'Trả trước / dư Có']);
    expect(agingRow(json.totals)).toMatchObject({ notDue: '1000', b0: '1300', b1: '0', b2: '28000', total: '30300' });
    for (const bad of ['90,30', '0,30', '30,30', 'a,b']) expect((await t.get(`/api/reports/arap/aging?accountCode=131&asOf=2026-03-31&buckets=${bad}`)).status).toBe(400);
  });

  it('tổng hợp: dư cuối từng đối tượng cộng lại bằng số dư TK 131 tại ngày cuối, dư Nợ và dư Có tách hai bên', async () => {
    const { status, json } = await t.get('/api/reports/arap/summary?accountCode=131&from=2026-03-01&to=2026-03-31');
    expect(status).toBe(200);
    const byParty = Object.fromEntries(json.rows.map((r: Json) => [r.partyCode, [r.openingDebit, r.openingCredit, r.periodDebit, r.periodCredit, r.closingDebit, r.closingCredit]]));
    expect(byParty).toEqual({
      KH001: ['31000', '0', '0', '700', '30300', '0'], KH002: ['32000', '0', '0', '500', '31500', '0'], NCC001: ['0', '0', '0', '300', '0', '300'] });
    expect(json.totals).toMatchObject({ openingDebit: '63000', openingCredit: '0', periodDebit: '0', periodCredit: '1500', closingDebit: '61800', closingCredit: '300' });
    const net = await t.ledgerNet('131', '2026-03-31');
    expect([json.accountNet, json.closingNet, json.matches, net]).toEqual(['61500', '61500', true, '61500']);
    // Kỳ đầu năm: dư đầu bằng 0, phát sinh Nợ bằng tổng hóa đơn.
    const jan = (await t.get('/api/reports/arap/summary?accountCode=131&from=2026-01-01&to=2026-01-31')).json;
    expect(jan.rows.map((r: Json) => [r.partyCode, r.openingDebit, r.periodDebit, r.closingDebit])).toEqual([['KH001', '0', '31000', '31000']]);
  });

  it('sổ chi tiết: dư đầu, từng chứng từ với TK đối ứng, số dư lũy kế, dư cuối', async () => {
    const { status, json } = await t.get('/api/reports/arap/detail?accountCode=131&partyCode=KH001&from=2026-01-01&to=2026-03-31');
    expect(status).toBe(200);
    expect([json.opening, json.totalDebit, json.totalCredit, json.closing, json.partyName]).toEqual(['0', '31000', '700', '30300', 'Khách 1']);
    expect(json.rows.map((r: Json) => [r.date, r.counterAccounts, r.debit, r.credit, r.balance])).toEqual([
      ['2026-01-05', '5113', '1000', '0', '1000'], ['2026-01-05', '5113', '2000', '0', '3000'], ['2026-01-05', '5113', '4000', '0', '7000'],
      ['2026-01-05', '5113', '16000', '0', '23000'], ['2026-01-05', '5113', '8000', '0', '31000'], ['2026-03-05', '1111', '0', '700', '30300']]);
    const feb = (await t.get('/api/reports/arap/detail?accountCode=131&partyCode=KH001&from=2026-02-01&to=2026-03-31')).json;
    expect([feb.opening, feb.rows.length, feb.closing]).toEqual(['31000', 1, '30300']);
  });

  it('thiếu đối tượng, sai tài khoản hay đối tượng không có: lỗi 400/404', async () => {
    const codes = async (url: string) => { const r = await t.get(url); return [r.status, r.json?.error?.code]; };
    expect(await codes('/api/reports/arap/detail?accountCode=131&from=2026-01-01&to=2026-03-31')).toEqual([400, 'VALIDATION']);
    expect(await codes('/api/reports/arap/detail?accountCode=5113&partyCode=KH001&from=2026-01-01&to=2026-03-31')).toEqual([400, 'NOT_ARAP_ACCOUNT']);
    expect(await codes('/api/reports/arap/detail?accountCode=131&partyCode=KHX&from=2026-01-01&to=2026-03-31')).toEqual([404, 'PARTY_NOT_FOUND']);
    expect(await codes('/api/reports/arap/summary?accountCode=131&from=2026-03-31&to=2026-01-01')).toEqual([400, 'VALIDATION']);
    expect(await codes('/api/reports/arap/summary?accountCode=999&from=2026-01-01&to=2026-03-31')).toEqual([404, 'ACCOUNT_NOT_FOUND']);
  });

  it('biên bản đối chiếu công nợ: PDF có tên hai bên và số dư cuối, không có dòng "Mẫu số"', async () => {
    const q = 'accountCode=131&partyCode=KH001&from=2026-01-01&to=2026-03-31';
    const html = await t.call('GET', `/api/reports/arap/statement?${q}&format=html`);
    expect(html.statusCode, html.body).toBe(200);
    const text = flat(html.body);
    for (const s of ['BIÊN BẢN ĐỐI CHIẾU CÔNG NỢ', 'Công ty CN', 'Khách 1', '12 Nguyễn Huệ, Quận 1', '0101234567', '30.300', 'Bên A', 'Bên B']) expect(text, s).toContain(s);
    expect(text).not.toContain('Mẫu số');
    const pdf = await t.call('GET', `/api/reports/arap/statement?${q}`);
    expect([pdf.statusCode, pdf.headers['content-type']]).toEqual([200, 'application/pdf']);
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    if (hasPdftotext) { const pt = textOfPdf(pdf.rawPayload); for (const s of ['Công ty CN', 'Khách 1', '30.300']) expect(pt, s).toContain(s); }
    const xlsx = await t.call('GET', `/api/reports/arap/statement?${q}&format=xlsx`);
    expect([xlsx.statusCode, xlsx.headers['content-type']]).toEqual([200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
  });

  it('thư nhắc nợ: chỉ liệt kê khoản quá hạn và tổng; không có khoản quá hạn thì 404', async () => {
    const html = await t.call('GET', '/api/reports/arap/reminder?accountCode=131&partyCode=KH001&asOf=2026-03-31&format=html');
    expect(html.statusCode, html.body).toBe(200);
    const text = flat(html.body);
    for (const s of ['THƯ NHẮC NỢ', 'Khách 1', '1.300', '4.000', '16.000', '8.000', '29.300']) expect(text, s).toContain(s);
    expect(text).not.toContain('Mẫu số');
    expect(text).not.toContain('1.000 '); // khoản 1.000 chưa đến hạn
    const pdf = await t.call('GET', '/api/reports/arap/reminder?accountCode=131&partyCode=KH001&asOf=2026-03-31');
    expect([pdf.statusCode, pdf.rawPayload.subarray(0, 4).toString()]).toEqual([200, '%PDF']);
    const none = await t.get('/api/reports/arap/reminder?accountCode=131&partyCode=NCC001&asOf=2026-03-31&format=html');
    expect([none.status, none.json.error.code]).toEqual([404, 'NO_OVERDUE_ITEMS']);
    expect((await t.get('/api/reports/arap/reminder?accountCode=331&partyCode=NCC001&asOf=2026-03-31&format=html')).json.error.code).toBe('NOT_RECEIVABLE_ACCOUNT');
  });

  it('bản in và Excel của sổ, tổng hợp, tuổi nợ', async () => {
    for (const [url, ct] of [['detail?accountCode=131&partyCode=KH001&from=2026-01-01&to=2026-03-31', 'application/pdf'], ['summary?accountCode=131&from=2026-01-01&to=2026-03-31', 'application/pdf'], ['aging?accountCode=131&asOf=2026-03-31', 'application/pdf']] as const) {
      const r = await t.call('GET', `/api/reports/arap/${url}&format=pdf`); expect([url, r.statusCode, r.headers['content-type']]).toEqual([url, 200, ct]);
      const x = await t.call('GET', `/api/reports/arap/${url}&format=xlsx`); expect([url, x.statusCode]).toEqual([url, 200]);
    }
    const html = flat((await t.call('GET', '/api/reports/arap/aging?accountCode=131&asOf=2026-03-31&format=html')).body);
    for (const s of ['TUỔI NỢ', 'Khách 1', '30.300', '61.500']) expect(html, s).toContain(s);
  });
});

describe('cờ nhạy cảm theo tài khoản công nợ', () => {
  it('người có view_payable nhưng không view_receivable: 403 ở TK 131, 200 ở TK 331 (cả bản in); chiều ngược lại cũng vậy', async () => {
    const t = await tenant(); await seed(t);
    await t.pkt('2026-02-01', [L('6422', '900'), K('331', 'NCC001', '0', '900', { dueDate: '2026-03-01' })]);
    const payable = await t.userWith(['view_payable']); const receivable = await t.userWith(['view_receivable']); const none = await t.userWith([]);
    const q = (acc: string, kind: string) => kind === 'detail' ? `detail?accountCode=${acc}&partyCode=${acc === '131' ? 'KH001' : 'NCC001'}&from=2026-01-01&to=2026-03-31`
      : kind === 'summary' ? `summary?accountCode=${acc}&from=2026-01-01&to=2026-03-31` : kind === 'aging' ? `aging?accountCode=${acc}&asOf=2026-03-31`
        : `${kind}?accountCode=${acc}&partyCode=${acc === '131' ? 'KH001' : 'NCC001'}&from=2026-01-01&to=2026-03-31&asOf=2026-03-31`;
    for (const kind of ['detail', 'summary', 'aging']) {
      const denied = await t.get(`/api/reports/arap/${q('131', kind)}`, payable);
      expect([kind, denied.status, denied.json.error.code, denied.json.error.message]).toEqual([kind, 403, 'FORBIDDEN', 'Không có quyền xem công nợ phải thu']);
      expect([kind, (await t.get(`/api/reports/arap/${q('331', kind)}`, payable)).status]).toEqual([kind, 200]);
      const back = await t.get(`/api/reports/arap/${q('331', kind)}`, receivable);
      expect([kind, back.status, back.json.error.message]).toEqual([kind, 403, 'Không có quyền xem công nợ phải trả']);
      expect([kind, (await t.get(`/api/reports/arap/${q('131', kind)}`, receivable)).status]).toEqual([kind, 200]);
      expect([kind, (await t.get(`/api/reports/arap/${q('131', kind)}`, none)).status]).toEqual([kind, 403]);
    }
    for (const kind of ['statement', 'reminder']) {
      expect([kind, (await t.call('GET', `/api/reports/arap/${q('131', kind)}&format=html`, undefined, payable)).statusCode]).toEqual([kind, 403]);
      expect([kind, (await t.call('GET', `/api/reports/arap/${q('131', kind)}&format=pdf`, undefined, payable)).statusCode]).toEqual([kind, 403]);
    }
    expect((await t.call('GET', `/api/reports/arap/${q('331', 'statement')}&format=html`, undefined, payable)).statusCode).toBe(200);
    // Công nợ phải trả: dư Có hiển thị dương ở tuổi nợ, dư Nợ (trả trước) ở cột dư bên ngược; sổ chi tiết có số dư âm (Có).
    const ag = (await t.get('/api/reports/arap/aging?accountCode=331&asOf=2026-03-31', payable)).json;
    expect(ag.columns.at(-2).label).toBe('Trả trước / dư Nợ');
    expect(agingRow(ag.rows[0])).toEqual({ ...ZERO_ROW, b0: '900', total: '900' }); // hạn 01/03, quá hạn 30 ngày
    const d = (await t.get('/api/reports/arap/detail?accountCode=331&partyCode=NCC001&from=2026-01-01&to=2026-03-31', payable)).json;
    expect([d.closing, d.rows.map((r: Json) => r.balance)]).toEqual(['-900', ['-900']]);
  });
});

describe('công nợ ngoại tệ và chênh lệch đánh giá lại', () => {
  it('sổ chi tiết theo nguyên tệ; tuổi nợ gộp cả khoản con đánh giá lại vào khoản gốc', async () => {
    const t = await tenant();
    expect((await t.call('POST', '/api/catalogs/exchange_rate', { currency_code: 'USD', rate_date: '2026-01-31', rate_type: 'transfer_avg', rate: '25600' })).statusCode).toBe(201);
    const v = toVnd('100', '25500');
    await t.pkt('2026-01-10', [K('131', 'KH001', v, '0', { amountCurrency: '100', dueDate: '2026-02-10' }), L('5113', '0', v, { amountCurrency: '-100' })], { currencyCode: 'USD', fxRate: '25500' });
    const rev = await t.call('POST', '/api/fx/revaluation', { date: '2026-01-31' }); expect(rev.statusCode, rev.body).toBe(200);
    expect(rev.json().voucherIds.length).toBeGreaterThan(0);
    const det = (await t.get('/api/reports/arap/detail?accountCode=131&partyCode=KH001&from=2026-01-01&to=2026-02-28&currency=USD')).json;
    expect(det.rows[0]).toMatchObject({ date: '2026-01-10', debit: '2550000', debitCurrency: '100.0000', creditCurrency: '0.0000', balance: '2550000', balanceCurrency: '100.0000' });
    expect([det.currency, det.closingCurrency]).toEqual(['USD', '100.0000']);
    // 100 USD x (25.600 - 25.500) = 10.000 chênh lệch; tuổi nợ tại 28/02 gồm khoản gốc 2.550.000 và khoản con 10.000, theo hạn của khoản gốc (10/02: quá 18 ngày).
    const ag = (await t.get('/api/reports/arap/aging?accountCode=131&partyCode=KH001&asOf=2026-02-28')).json;
    expect(agingRow(ag.rows[0])).toEqual({ ...ZERO_ROW, b0: '2560000', total: '2560000' });
    expect(ag.items.map((i: Json) => [i.dueDate, i.residual, i.daysOverdue])).toEqual([['2026-02-10', '2560000', 18]]);
    expect([ag.totals.total, await t.ledgerNet('131', '2026-02-28')]).toEqual(['2560000', '2560000']);
    const sm = (await t.get('/api/reports/arap/summary?accountCode=131&from=2026-01-01&to=2026-02-28')).json;
    expect([sm.rows[0].closingDebit, sm.matches]).toEqual(['2560000', true]);
  });
});
