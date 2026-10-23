import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (r: Res) => [r.statusCode, r.json().error?.code];

// Công ty riêng, một nhà cung cấp giả lập, ký hiệu C26TAA (năm 2026) và C25TAA (năm 2025).
async function tenant() {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, `EI${Date.now()}${n++}`);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  const admin = ctx.t.admin;
  const providerId = (await sql<{ id: number }>`INSERT INTO einvoice_provider (tenant_id, code, name) VALUES (${tenantId}::uuid, 'fake', 'Giả lập') RETURNING id::int`.execute(admin)).rows[0]!.id;
  const series = async (serial: string, isActive = true) => (await sql<{ id: number }>`INSERT INTO einvoice_series (tenant_id, provider_id, form_no, serial, year, is_active)
    VALUES (${tenantId}::uuid, ${providerId}, '1', ${serial}, 2000 + substr(${serial}, 2, 2)::int, ${isActive}) RETURNING id::int`.execute(admin)).rows[0]!.id;
  const seriesId = await series('C26TAA');
  const invoice = (voucherType: string, inv: object = {}, more: object = {}) => ({ voucherType, postingDate: '2026-03-10', documentDate: '2026-03-10', partyCode: voucherType === 'HDM' ? 'NCC001' : 'KH001', autoPost: true,
    items: [{ description: 'Dịch vụ', accountCode: voucherType === 'HDM' ? '6422' : '5113', amountCurrency: '10000000', taxCodes: ['V10'] }],
    invoice: { invoiceDate: '2026-03-10', invoiceGroupCode: voucherType === 'HDM' ? '01' : '10', ...inv }, ...more });
  const pending = async (more: object = {}) => { const r = await call('POST', '/api/invoices', invoice('HDB', { einvoiceSeriesId: seriesId }, more)); expect(r.statusCode, r.body).toBe(201); return r.json() as { id: string; state: string }; };
  const einvoice = async (voucherId: string, status: string) => (await sql<{ id: number }>`INSERT INTO einvoice (tenant_id, voucher_id, series_id, provider_id, status, transaction_uuid)
    VALUES (${tenantId}::uuid, ${voucherId}::uuid, ${seriesId}, ${providerId}, ${status}, gen_random_uuid()) RETURNING id::int`.execute(admin)).rows[0]!.id;
  const rows = async (voucherId: string) => (await sql<{ invoice_no: string | null; einvoice_pending: boolean; serial: string; form_no: string }>`SELECT invoice_no, einvoice_pending, serial, form_no FROM voucher_invoice WHERE voucher_id = ${voucherId}::uuid`.execute(admin)).rows;
  return { cookie, tenantId, call, admin, providerId, seriesId, series, invoice, pending, einvoice, rows };
}

describe('chứng từ bán chờ số hóa đơn điện tử', () => {
  it('HDB có einvoiceSeriesId, không invoiceNo: ghi sổ được; invoice_no NULL, einvoice_pending true, serial C26TAA', async () => {
    const t = await tenant();
    const v = await t.pending();
    expect(v.state).toBe('posted');
    expect(await t.rows(v.id)).toEqual([{ invoice_no: null, einvoice_pending: true, serial: 'C26TAA', form_no: '1' }]);
  });

  it('HDM không invoiceNo → 400; HDM có einvoiceSeriesId → 400; có cả invoiceNo và ký hiệu → 400', async () => {
    const t = await tenant();
    expect(err(await t.call('POST', '/api/invoices', t.invoice('HDM')))).toEqual([400, 'VALIDATION']);
    expect(err(await t.call('POST', '/api/invoices', t.invoice('HDM', { einvoiceSeriesId: t.seriesId })))).toEqual([400, 'VALIDATION']);
    expect(err(await t.call('POST', '/api/invoices', t.invoice('HDB', { einvoiceSeriesId: t.seriesId, invoiceNo: '1' })))).toEqual([400, 'VALIDATION']);
  });

  it('ký hiệu ngừng dùng → 409 SERIES_INACTIVE; năm ký hiệu khác năm hạch toán → 400 SERIES_YEAR_MISMATCH', async () => {
    const t = await tenant();
    const off = await t.series('C26TBB', false); const old = await t.series('C25TAA');
    expect(err(await t.call('POST', '/api/invoices', t.invoice('HDB', { einvoiceSeriesId: off })))).toEqual([409, 'SERIES_INACTIVE']);
    expect(err(await t.call('POST', '/api/invoices', t.invoice('HDB', { einvoiceSeriesId: old })))).toEqual([400, 'SERIES_YEAR_MISMATCH']);
  });

  it('fn_einvoice_set_number điền số cho chứng từ đã ghi sổ; lần hai → EINVOICE_NUMBER_SET; UPDATE thẳng base_amount vẫn VOUCHER_CHILD_IMMUTABLE', async () => {
    const t = await tenant();
    const v = await t.pending();
    await expect(sql`UPDATE voucher_invoice SET base_amount = 1 WHERE voucher_id = ${v.id}::uuid`.execute(t.admin)).rejects.toThrow(/VOUCHER_CHILD_IMMUTABLE/);
    await expect(sql`UPDATE voucher_invoice SET invoice_no = '9' WHERE voucher_id = ${v.id}::uuid`.execute(t.admin)).rejects.toThrow(/VOUCHER_CHILD_IMMUTABLE/);
    const set = () => sql`SELECT fn_einvoice_set_number(${v.id}::uuid, '1', 'C26TAA', '0000007', '2026-03-11')`.execute(t.admin);
    await set();
    expect(await t.rows(v.id)).toEqual([{ invoice_no: '0000007', einvoice_pending: false, serial: 'C26TAA', form_no: '1' }]);
    await expect(set()).rejects.toThrow(/EINVOICE_NUMBER_SET/);
    // cờ chỉ có hiệu lực trong hàm: sau khi gọi, sửa cột khác vẫn bị chặn
    await expect(sql`UPDATE voucher_invoice SET base_amount = 1 WHERE voucher_id = ${v.id}::uuid`.execute(t.admin)).rejects.toThrow(/VOUCHER_CHILD_IMMUTABLE/);
  });

  it('hóa đơn có số nhập tay: hàm không ghi đè (0 dòng chờ số)', async () => {
    const t = await tenant();
    const r = await t.call('POST', '/api/invoices', t.invoice('HDB', { invoiceNo: '0000001', serial: 'C26TAA' }));
    expect(r.statusCode, r.body).toBe(201);
    await expect(sql`SELECT fn_einvoice_set_number(${r.json().id}::uuid, '1', 'C26TAA', '5', '2026-03-11')`.execute(t.admin)).rejects.toThrow(/EINVOICE_NUMBER_SET/);
  });

  it('CHECK: invoice_no NULL chỉ khi chờ số và là hóa đơn bán', async () => {
    const t = await tenant();
    const v = await t.pending();
    await expect(sql`UPDATE voucher_invoice SET invoice_no = NULL, einvoice_pending = false WHERE voucher_id = ${v.id}::uuid`.execute(t.admin)).rejects.toThrow();
  });
});

describe('khóa chứng từ đã phát hành hóa đơn điện tử', () => {
  it.each(['sending', 'issued'])('einvoice %s: bỏ ghi sổ, đảo, xóa qua /api/vouchers → 409 EINVOICE_ISSUED; sửa diễn giải vẫn được', async (status) => {
    const t = await tenant();
    const v = await t.pending();
    await t.einvoice(v.id, status);
    expect(err(await t.call('POST', `/api/vouchers/${v.id}/unpost`))).toEqual([409, 'EINVOICE_ISSUED']);
    expect(err(await t.call('POST', `/api/vouchers/${v.id}/reverse`, { postingDate: '2026-03-15' }))).toEqual([409, 'EINVOICE_ISSUED']);
    expect((await t.call('DELETE', `/api/vouchers/${v.id}`)).statusCode).toBe(409);
    await expect(sql`DELETE FROM voucher WHERE id = ${v.id}::uuid`.execute(t.admin)).rejects.toThrow(/EINVOICE_ISSUED/);
    const cur = (await t.call('GET', `/api/vouchers/${v.id}`)).json();
    const meta = await t.call('PUT', `/api/vouchers/${v.id}`, { description: 'Sửa diễn giải', version: cur.version });
    expect(meta.statusCode, meta.body).toBe(200);
    expect((await t.call('GET', `/api/vouchers/${v.id}`)).json().state).toBe('posted');
  });

  it('einvoice failed không khóa chứng từ; hai einvoice không failed cùng chứng từ → vi phạm duy nhất', async () => {
    const t = await tenant();
    const v = await t.pending();
    await t.einvoice(v.id, 'failed');
    await t.einvoice(v.id, 'failed');
    await t.einvoice(v.id, 'issued');
    await expect(t.einvoice(v.id, 'sending')).rejects.toThrow(/einvoice_voucher_live/);
    const w = await t.pending({ idempotencyKey: 'k2' });
    await t.einvoice(w.id, 'failed');
    expect((await t.call('POST', `/api/vouchers/${w.id}/unpost`)).statusCode).toBe(200);
  });

  it('app.einvoice_reversal = on cho phép đảo/bỏ ghi sổ (luồng thay thế, hủy hóa đơn)', async () => {
    const t = await tenant();
    const v = await t.pending();
    await t.einvoice(v.id, 'issued');
    await expect(sql`SELECT unpost_voucher(${v.id}::uuid)`.execute(t.admin)).rejects.toThrow(/EINVOICE_ISSUED/);
    await t.admin.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.einvoice_reversal', 'on', true)`.execute(trx);
      await sql`SELECT unpost_voucher(${v.id}::uuid)`.execute(trx);
    });
    expect((await sql<{ state: string }>`SELECT state FROM voucher WHERE id = ${v.id}::uuid`.execute(t.admin)).rows[0]!.state).toBe('draft');
  });
});

describe('nhật ký einvoice_log', () => {
  it('chỉ thêm: UPDATE, DELETE đều bị chặn', async () => {
    const t = await tenant();
    const id = (await sql<{ id: number }>`INSERT INTO einvoice_log (tenant_id, provider_id, action, ok) VALUES (${t.tenantId}::uuid, ${t.providerId}, 'create', true) RETURNING id::int`.execute(t.admin)).rows[0]!.id;
    await expect(sql`UPDATE einvoice_log SET ok = false WHERE id = ${id}`.execute(t.admin)).rejects.toThrow(/EINVOICE_LOG_IMMUTABLE/);
    await expect(sql`DELETE FROM einvoice_log WHERE id = ${id}`.execute(t.admin)).rejects.toThrow(/EINVOICE_LOG_IMMUTABLE/);
  });
});

describe('ký hiệu đã dùng (seriesInUse)', () => {
  it('đổi serial hoặc xóa ký hiệu có einvoice → 409 SERIES_IN_USE', async () => {
    const t = await tenant();
    const v = await t.pending();
    await t.einvoice(v.id, 'draft');
    const put = await t.call('PUT', `/api/einvoice/series/${t.seriesId}`, { providerId: t.providerId, formNo: '1', serial: 'C26TCC', kind: 'standard' });
    expect(err(put)).toEqual([409, 'SERIES_IN_USE']);
    expect(err(await t.call('DELETE', `/api/einvoice/series/${t.seriesId}`))).toEqual([409, 'SERIES_IN_USE']);
  });
});

describe('bảng kê bán ra', () => {
  it('hóa đơn chờ số hiện "Chưa phát hành", vẫn cộng vào tờ khai theo kỳ chứng từ; có số rồi thì hiện số', async () => {
    const t = await tenant();
    const v = await t.pending();
    const get = async () => { const r = await t.call('GET', '/api/tax/invoices?direction=sale&year=2026&period=3&periodKind=month'); expect(r.statusCode, r.body).toBe(200); return r.json(); };
    const reg = await get();
    const line = reg.groups.flatMap((g: { rows: object[] }) => g.rows)[0];
    expect(line).toMatchObject({ invoiceNo: 'Chưa phát hành', serial: 'C26TAA', baseAmount: '10000000', taxAmount: '1000000' });
    expect(reg.totals).toMatchObject({ baseAmount: '10000000', taxAmount: '1000000' });
    await sql`SELECT fn_einvoice_set_number(${v.id}::uuid, '1', 'C26TAA', '0000009', '2026-03-10')`.execute(t.admin);
    expect((await get()).groups[0].rows[0].invoiceNo).toBe('0000009');
  });
});
