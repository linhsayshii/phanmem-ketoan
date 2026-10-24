import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { createTestApp, setupBankTenant, type BankTenant } from './helpers.js';
import type { TestApp } from '../helpers.js';

let ctx: TestApp; let a: BankTenant;
beforeAll(async () => { ctx = await createTestApp(); a = await setupBankTenant(ctx, `BSI${Date.now()}`); });
afterAll(async () => { await ctx.close(); });

const fmt = { name: 'Mẫu VCB', bankCode: 'VCB', headerRow: 1, dateCol: 'A', dateFormat: 'dd/MM/yyyy', descriptionCol: 'C', amountInCol: 'D', amountOutCol: 'E', referenceCol: 'B', balanceCol: 'F' };
async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('S');
  ws.addRow(['Ngày', 'Số CT', 'Diễn giải', 'Ghi có', 'Ghi nợ', 'Số dư']);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
function multipart(fields: Record<string, string>, file: { name: string; data: Buffer }) {
  const boundary = '----kt' + Date.now();
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { cookie: a.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
const imp = (formatId: number, file: { name: string; data: Buffer }) => ctx.app.inject({ method: 'POST', url: '/api/bank-transactions/import', ...multipart({ bankAccountId: String(a.accountId), formatId: String(formatId) }, file) });

describe('nhập sao kê', () => {
  it('xlsx 5 dòng theo mẫu cột; nhập lại → inserted 0 skipped 5; dòng ngày sai → errors', async () => {
    const f = await ctx.app.inject({ method: 'POST', url: '/api/bank-statement-formats', headers: { cookie: a.cookie }, payload: fmt });
    expect(f.statusCode, f.body).toBe(201);
    const rows = [
      ['05/01/2026', 'CT1', 'Thu tiền hàng', 1000000, null, 11000000],
      ['06/01/2026', 'CT2', 'Trả NCC', null, 400000, 10600000],
      ['06/01/2026', 'CT3', 'Trùng nội dung', 50000, null, null],
      ['06/01/2026', 'CT3', 'Trùng nội dung', 50000, null, null],
      ['07/01/2026', 'CT4', 'Phí', null, '1,500', null],
    ];
    const file = { name: 's.xlsx', data: await xlsx(rows) };
    const r1 = await imp(f.json().id, file);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toEqual({ inserted: 5, skipped: 0, errors: [] });
    const r2 = await imp(f.json().id, file);
    expect(r2.json()).toEqual({ inserted: 0, skipped: 5, errors: [] });
    const db = (await sql<{ amount_in: string; amount_out: string; value_date: string; external_id: string }>`SELECT amount_in::text, amount_out::text, value_date::text, external_id FROM bank_transaction WHERE tenant_id = ${a.tenantId}::uuid AND source = 'import' ORDER BY id`.execute(ctx.t.admin)).rows;
    expect(db).toHaveLength(5);
    expect(db[0]).toMatchObject({ amount_in: '1000000.0000', value_date: '2026-01-05' });
    expect(db[4]).toMatchObject({ amount_out: '1500.0000' });
    expect(db[0]!.external_id).toMatch(/^imp:[0-9a-f]{64}$/);
    const bad = await imp(f.json().id, { name: 'b.xlsx', data: await xlsx([['31/02/2026', 'X', 'Ngày sai', 5, null, null], ['08/01/2026', 'Y', 'Hợp lệ', 7, null, null], ['08/01/2026', 'Z', 'Không tiền', null, null, null]]) });
    expect(bad.json().inserted).toBe(1);
    expect(bad.json().errors.map((e: { row: number }) => e.row)).toEqual([2, 4]);
  });

  it('CSV có dấu phẩy trong ô, một cột số tiền có dấu; mẫu khai sai bị từ chối', async () => {
    const f = (await ctx.app.inject({ method: 'POST', url: '/api/bank-statement-formats', headers: { cookie: a.cookie }, payload: { name: 'CSV có dấu', dateCol: 'A', dateFormat: 'yyyy-MM-dd', descriptionCol: 'B', signedAmountCol: 'C', headerRow: 1 } })).json();
    const csv = 'Ngày,Nội dung,Số tiền\n2026-02-01,"Thu, tiền",2000000\n2026-02-02,Chi,-300000\n';
    const r = await imp(f.id, { name: 's.csv', data: Buffer.from(csv, 'utf8') });
    expect(r.json()).toEqual({ inserted: 2, skipped: 0, errors: [] });
    const out = (await sql<{ amount_out: string }>`SELECT amount_out::text FROM bank_transaction WHERE tenant_id = ${a.tenantId}::uuid AND description = 'Chi'`.execute(ctx.t.admin)).rows[0]!;
    expect(out.amount_out).toBe('300000.0000');
    const invalid = await ctx.app.inject({ method: 'POST', url: '/api/bank-statement-formats', headers: { cookie: a.cookie }, payload: { name: 'Sai', dateCol: 'a1', dateFormat: 'dd/MM/yyyy', descriptionCol: 'B', signedAmountCol: 'C' } });
    expect(invalid.statusCode).toBe(400);
    const noAmount = await ctx.app.inject({ method: 'POST', url: '/api/bank-statement-formats', headers: { cookie: a.cookie }, payload: { name: 'Thiếu tiền', dateCol: 'A', dateFormat: 'dd/MM/yyyy', descriptionCol: 'B' } });
    expect(noAmount.statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/bank-statement-formats', headers: { cookie: a.cookie } })).json().length).toBeGreaterThanOrEqual(1);
  });
});
