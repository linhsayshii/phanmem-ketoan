import { createHmac } from 'node:crypto';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';

export interface BankTenant { cookie: string; tenantId: string; accountId: number; accountNo: string }

// Công ty có sổ cái và một tài khoản ngân hàng.
export async function setupBankTenant(ctx: TestApp, code: string, accountNo = '1017588888'): Promise<BankTenant> {
  const { cookie, tenantId } = await setupLedgerTenant(ctx, code);
  const post = async (name: string, payload: object) => {
    const r = await ctx.app.inject({ method: 'POST', url: `/api/catalogs/${name}`, headers: { cookie }, payload });
    if (r.statusCode !== 201) throw new Error(`${name}: ${r.body}`);
    return r.json();
  };
  await post('bank', { code: 'VCB', name: 'Vietcombank' });
  const acc = await post('bank_account', { bank_code: 'VCB', account_no: accountNo, gl_account_code: '1121' });
  return { cookie, tenantId, accountId: Number(acc.id), accountNo };
}

export const sepayBody = (o: Record<string, unknown> = {}) => JSON.stringify({ id: 92704, gateway: 'Vietcombank', transactionDate: '2024-07-02 11:08:33', accountNumber: '1017588888', subAccount: '', code: 'SEVN63DC8E5C',
  content: 'SEVN63DC8E5C chuyen tien', transferType: 'in', description: 'NGUYEN VAN A chuyen tien', transferAmount: 5000000, accumulated: 105000000, referenceCode: 'FT24012345678', ...o });

export function sepaySign(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  return { 'content-type': 'application/json', 'x-sepay-timestamp': String(ts), 'x-sepay-signature': `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}` };
}

const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
export function cassoSign(secret: string, body: string, t = Date.now()) {
  const sig = createHmac('sha512', secret).update(`${t}.${JSON.stringify(sortKeys(JSON.parse(body)))}`).digest('hex');
  return { 'content-type': 'application/json', 'x-casso-signature': `t=${t},v1=${sig}` };
}

export const cassoBody = (data: Record<string, unknown> = {}) => JSON.stringify({ error: 0, data: { id: 555, reference: 'REF1', description: 'thanh toan', amount: 599000, runningBalance: 25000000,
  transactionDateTime: '2025-02-12 15:36:21', accountNumber: '1017588888', counterAccountName: 'NGUYEN VAN A', counterAccountNumber: '8888888888', ...data } });

export { createTestApp };
