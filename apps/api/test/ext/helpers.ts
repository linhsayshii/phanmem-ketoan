import { expect } from 'vitest';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

export { createTestApp };
export type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ExtTenant { cookie: string; tenantId: string; userId: string; call: (method: 'POST' | 'PUT' | 'GET', url: string, payload?: object, c?: string) => Promise<Res> }

// Công ty có sổ cái, ĐVT CAI, hai mặt hàng hàng hóa và một dịch vụ, kho K1 có tồn 100 x 10 mỗi mặt hàng, tài khoản ngân hàng 1121.
export async function setupExtTenant(ctx: TestApp, code: string): Promise<ExtTenant> {
  const b = await setupLedgerTenant(ctx, code);
  const call: ExtTenant['call'] = (method, url, payload, c = b.cookie) => ctx.app.inject({ method, url, headers: { cookie: c }, ...(payload && { payload }) }) as unknown as Promise<Res>;
  const cat = async (name: string, payload: object) => { const r = await call('POST', `/api/catalogs/${name}`, payload); expect(r.statusCode, r.body).toBe(201); return r.json(); };
  await call('POST', '/api/catalogs/uom', { code: 'CAI', name: 'Cái' }); // setupLedgerTenant có thể đã tạo sẵn
  await cat('item', { code: 'SP1', name: 'Sản phẩm 1', base_uom_code: 'CAI', kind: 'goods', revenue_account_code: '5111', default_tax_code: 'V10' });
  await cat('item', { code: 'SP2', name: 'Sản phẩm 2', base_uom_code: 'CAI', kind: 'goods', revenue_account_code: '5111', default_tax_code: 'V10' });
  await cat('item', { code: 'DV1', name: 'Dịch vụ 1', base_uom_code: 'CAI', kind: 'service', revenue_account_code: '5113', default_tax_code: 'V10' });
  await cat('warehouse', { code: 'K1', name: 'Kho chính', inventory_account_code: '156', costing_method: 'avg_moving' });
  await cat('bank', { code: 'VCB', name: 'Vietcombank' });
  await cat('bank_account', { bank_code: 'VCB', account_no: '1017588888', gl_account_code: '1121' });
  for (const item of ['SP1', 'SP2']) {
    const r = await call('POST', '/api/stock-vouchers', { voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-03-01', warehouseCode: 'K1', partyCode: 'NCC001', items: [{ itemCode: item, uomCode: 'CAI', quantity: '100', unitPrice: '10' }] });
    expect(r.statusCode, r.body).toBe(201);
    expect((await call('POST', `/api/vouchers/${r.json().id}/post`, {})).statusCode).toBe(200);
  }
  return { cookie: b.cookie, tenantId: b.tenantId, userId: b.userId, call };
}

export const createKey = async (t: ExtTenant, over: object = {}) => {
  const r = await t.call('POST', '/api/api-keys', { name: 'POS quầy 1', scopes: ['items.read', 'stock.read', 'sales.write', 'inbound_invoice.write'], defaultWarehouseCode: 'K1', postSales: true, ...over });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; key: string; prefix: string };
};
export const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
