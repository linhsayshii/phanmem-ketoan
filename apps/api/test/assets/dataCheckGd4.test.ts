import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { loanLongTermPart, D } from '@kt/domain';
import { withTenant } from '@kt/db';
import { createTestApp, type TestApp } from '../helpers.js';
import { setupLedgerTenant } from '../invariants/helpers.js';
import { assetRunStale } from '../../src/modules/assets/periodRun.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
let ctx: TestApp; let n = 0;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

type Res = { statusCode: number; body: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Hit = { ruleCode: string; message: string; voucherId: string | null; ref: string | null; detail: string | null };
const nợ = (account: string, debit: string, more: object = {}) => ({ accountCode: account, debit, credit: '0', ...more });
const có = (account: string, credit: string, more: object = {}) => ({ accountCode: account, debit: '0', credit, ...more });

// Năm 2026 (12 kỳ tháng), đối tượng NCC001; TT133 cho tài sản (2111/2141, 242), TT99 cho khế ước vay (3411).
async function tenant(regime: 'TT133' | 'TT99' = 'TT133') {
  const { cookie, tenantId, userId } = await setupLedgerTenant(ctx, `SG${Date.now()}${n++}`, regime);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object): Promise<Res> => ctx.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const ok = async (r: Promise<Res>, code = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(code); return x.json(); };
  const admin = <T>(q: ReturnType<typeof sql<T>>) => q.execute(ctx.t.admin);
  const pkt = (date: string, lines: object[]) => ok(call('POST', '/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'ghi sổ', autoPost: true, lines }), 201);
  const run = async (code: string, range = { from: '2026-01-01', to: '2026-12-31' }): Promise<Hit[]> => {
    const r = await ok(call('POST', '/api/data-check/run', { ...range, codes: [code] }));
    expect(r.skipped).toEqual([]);
    return (r.results as Hit[]).filter((x) => x.ruleCode === code);
  };
  const db = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(ctx.t.db, { tenantId, userId }, fn);
  const allocate = async (id: number) => ok(call('PUT', `/api/assets/${id}/allocations`, { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', ratio: '100' }] }));
  // Thẻ TSCĐ 2111/2141 bắt đầu khấu hao 01/01/2026; nguyên giá ghi bằng PKT ngày 01/01 (cost rỗng: chưa ghi).
  const fixed = async (code: string, cost: string | null, lifeUnits = 60) => {
    const a = await ok(call('POST', '/api/assets', { code, name: code, kind: 'fixed', assetAccountCode: '2111', depreciationAccountCode: '2141', depreciationStartDate: '2026-01-01', lifeUnits }), 201);
    await allocate(a.id);
    if (cost) await pkt('2026-01-01', [nợ('2111', cost, { assetCode: code }), có('331', cost, { partyCode: 'NCC001' })]);
    return a.id as number;
  };
  return { cookie, tenantId, call, ok, admin, pkt, run, db, fixed, allocate };
}

describe('soát lỗi GĐ4: tài sản', () => {
  it('TS_THIEU_TAI_SAN: dòng 2141 không tài sản (ghi khi tài khoản chưa theo dõi tài sản) bị báo; dòng có tài sản thì không', async () => {
    const t = await tenant(); await t.fixed('TS01', '60000000');
    expect(await t.run('TS_THIEU_TAI_SAN')).toEqual([]);
    await t.admin(sql`UPDATE account SET subledger_kind = NULL WHERE tenant_id = ${t.tenantId}::uuid AND code = '2141'`); // mô phỏng dữ liệu trước 0069
    const v = await t.pkt('2026-02-10', [nợ('6422', '1000000'), có('2141', '1000000')]);
    await t.admin(sql`UPDATE account SET subledger_kind = 'fixed_asset' WHERE tenant_id = ${t.tenantId}::uuid AND code = '2141'`);
    const hits = await t.run('TS_THIEU_TAI_SAN');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ voucherId: v.id, detail: 'TK 2141 dòng 2' });
    expect(await t.run('TS_THIEU_TAI_SAN', { from: '2026-03-01', to: '2026-03-31' })).toEqual([]);
  });

  it('TS_HAO_MON_VUOT: hao mòn lớn hơn nguyên giá bị báo (kể cả CCDC có giá trị 242 âm); đủ giá trị thì không', async () => {
    const t = await tenant();
    await t.fixed('TS01', '12000000'); await t.fixed('TS02', '12000000');
    await t.pkt('2026-03-31', [nợ('6422', '15000000'), có('2141', '15000000', { assetCode: 'TS01' })]);
    await t.pkt('2026-03-31', [nợ('6422', '3000000'), có('2141', '3000000', { assetCode: 'TS02' })]);
    const tool = await t.ok(t.call('POST', '/api/assets', { code: 'CC01', name: 'CC01', kind: 'tool', assetAccountCode: '242', depreciationStartDate: '2026-01-01', lifeUnits: 3 }), 201);
    await t.pkt('2026-01-05', [nợ('242', '3000000', { assetCode: 'CC01' }), có('331', '3000000', { partyCode: 'NCC001' })]);
    await t.pkt('2026-02-05', [nợ('6422', '4000000'), có('242', '4000000', { assetCode: 'CC01' })]);
    expect(tool.id).toBeGreaterThan(0);
    const hits = await t.run('TS_HAO_MON_VUOT', { from: '2026-01-01', to: '2026-03-31' });
    expect(hits.map((x) => x.ref)).toEqual(['CC01', 'TS01']);
    expect(hits[1]!.detail).toBe('Nguyên giá 12000000, hao mòn 15000000');
    expect((await t.run('TS_HAO_MON_VUOT', { from: '2026-01-01', to: '2026-01-31' }))).toEqual([]); // trước khi vượt
  });

  it('TS_DA_GIAM_CON_GIA_TRI: tài sản đã ghi giảm còn nguyên giá trên sổ bị báo từ ngày giảm; tài sản đã trống giá trị hoặc chưa đến ngày giảm thì không', async () => {
    const t = await tenant();
    await t.fixed('TS01', '12000000'); await t.fixed('TS02', null); await t.fixed('TS03', '6000000');
    await t.admin(sql`UPDATE asset SET status = 'decreased', decrease_date = '2026-06-30' WHERE tenant_id = ${t.tenantId}::uuid AND code IN ('TS01', 'TS02', 'TS03')`);
    await t.pkt('2026-06-30', [nợ('331', '6000000', { partyCode: 'NCC001' }), có('2111', '6000000', { assetCode: 'TS03' })]); // TS03 đã xóa nguyên giá
    const hits = await t.run('TS_DA_GIAM_CON_GIA_TRI', { from: '2026-01-01', to: '2026-12-31' });
    expect(hits.map((x) => x.ref)).toEqual(['TS01']);
    expect(hits[0]!.detail).toBe('Ghi giảm 30/06/2026, còn nguyên giá 12000000, hao mòn 0');
    expect(await t.run('TS_DA_GIAM_CON_GIA_TRI', { from: '2026-01-01', to: '2026-05-31' })).toEqual([]);
  });

  it('TS_KHAU_HAO_CAN_CHAY_LAI khớp assetRunStale: cùng tập (loại, kỳ) lần chạy cũ; sạch trước khi ghi lùi', async () => {
    const t = await tenant(); await t.fixed('TS01', '120000000');
    const cc = await t.ok(t.call('POST', '/api/assets', { code: 'CC01', name: 'CC01', kind: 'tool', assetAccountCode: '242', depreciationStartDate: '2026-01-01', lifeUnits: 6 }), 201);
    await t.allocate(cc.id);
    await t.pkt('2026-01-01', [nợ('242', '6000000', { assetCode: 'CC01' }), có('331', '6000000', { partyCode: 'NCC001' })]);
    const label = { depreciation: 'Khấu hao', tool: 'Phân bổ CCDC', prepaid: 'Phân bổ chi phí trả trước' } as const;
    for (const kind of ['depreciation', 'tool'] as const) for (const p of [1, 2]) await t.ok(t.call('POST', '/api/asset-runs', { kind, fiscalYear: 2026, periodNo: p }));
    const compare = async () => {
      const want: string[] = [];
      for (const kind of ['depreciation', 'tool', 'prepaid'] as const) for (let p = 1; p <= 4; p++)
        if ((await t.db((trx) => assetRunStale(trx, kind, 2026, p))).stale) want.push(`${label[kind]} kỳ ${p}/2026`);
      expect((await t.run('TS_KHAU_HAO_CAN_CHAY_LAI')).map((x) => x.ref).sort()).toEqual(want.sort());
      return want;
    };
    expect(await compare()).toEqual([]);
    await t.pkt('2026-01-20', [nợ('2111', '60000000', { assetCode: 'TS01' }), có('331', '60000000', { partyCode: 'NCC001' })]); // ghi lùi nguyên giá TSCĐ
    expect((await compare()).sort()).toEqual(['Khấu hao kỳ 1/2026', 'Khấu hao kỳ 2/2026']);
    await t.pkt('2026-02-05', [nợ('242', '1000000', { assetCode: 'CC01' }), có('331', '1000000', { partyCode: 'NCC001' })]); // ghi lùi CCDC vào kỳ 2
    expect((await compare()).sort()).toEqual(['Khấu hao kỳ 1/2026', 'Khấu hao kỳ 2/2026', 'Phân bổ CCDC kỳ 2/2026']);
    await t.ok(t.call('POST', '/api/asset-runs', { kind: 'depreciation', fiscalYear: 2026, periodNo: 1 })); // chạy lại kỳ 1: kỳ 2 cũ vì kỳ trước chạy sau nó
    const want = await compare();
    expect(want).toContain('Khấu hao kỳ 2/2026'); expect(want).not.toContain('Khấu hao kỳ 1/2026');
    expect(await t.run('TS_KHAU_HAO_CAN_CHAY_LAI', { from: '2026-01-01', to: '2026-01-31' })).toEqual([]);
  });
});

describe('soát lỗi GĐ4: khế ước vay', () => {
  const inst = [{ dueDate: '2026-03-31', principal: '250000000' }, { dueDate: '2026-06-30', principal: '250000000' }, { dueDate: '2026-12-31', principal: '500000000' }];
  async function loanTenant() {
    const t = await tenant('TT99');
    for (const [name, payload] of [['bank', { code: 'VCB', name: 'Vietcombank' }], ['bank_account', { bank_code: 'VCB', account_no: '0011001', gl_account_code: '112' }]] as const)
      await t.ok(t.call('POST', `/api/catalogs/${name}`, payload), 201);
    const c = await t.ok(t.call('POST', '/api/loans', { code: 'VAY01', name: 'Vay 01', partyCode: 'NCC001', value: '2000000000', signedDate: '2026-01-01', validTo: '2026-12-31',
      rates: [{ validFrom: '2026-01-01', annualRate: '9.5' }], installments: inst }), 201);
    await t.ok(t.call('POST', `/api/loans/${c.id}/disburse`, { date: '2026-01-15', amount: '1000000000', bankAccountNo: '0011001' }), 201);
    const logClosing = (periodNo: number, okFlag: boolean) => t.admin(sql`INSERT INTO period_close_log(tenant_id, fiscal_year, period_no, step, ran_at, ok, summary)
      VALUES (${t.tenantId}::uuid, 2026, ${periodNo}, 'closing', clock_timestamp(), ${okFlag}, '{}'::jsonb)`);
    return { ...t, id: c.id as number, logClosing };
  }

  it('KU_CHUA_TINH_LAI: kỳ đã đóng bước kết chuyển mà chưa tính lãi vay bị báo; kỳ chưa đóng, đã tính lãi, hoặc bước kết chuyển chưa thành công thì không', async () => {
    const t = await loanTenant();
    const q = { from: '2026-01-01', to: '2026-03-31' };
    expect(await t.run('KU_CHUA_TINH_LAI', q)).toEqual([]); // chưa kết chuyển
    await t.logClosing(1, false);
    expect(await t.run('KU_CHUA_TINH_LAI', q)).toEqual([]); // kết chuyển lỗi
    await t.logClosing(1, true);
    const hits = await t.run('KU_CHUA_TINH_LAI', q);
    expect(hits.map((x) => [x.ref, x.detail])).toEqual([['VAY01', 'Kỳ 1/2026, dư nợ gốc 1000000000']]);
    expect(await t.run('KU_CHUA_TINH_LAI', { from: '2026-02-01', to: '2026-03-31' })).toEqual([]); // kỳ 1 ngoài khoảng
    await t.ok(t.call('POST', '/api/loan-runs', { fiscalYear: 2026, periodNo: 1 }));
    expect(await t.run('KU_CHUA_TINH_LAI', q)).toEqual([]);
  });

  it('KU_CHUA_TINH_LAI: chứng từ kết chuyển KC đã ghi sổ cũng tính là kỳ đã kết chuyển; khế ước đã tất toán dư nợ thì không báo', async () => {
    const t = await loanTenant();
    await t.pkt('2026-01-10', [nợ('111', '900'), có('511', '900')]);
    await t.ok(t.call('POST', '/api/closing/run-all', { postingDate: '2026-01-31' }));
    await t.admin(sql`DELETE FROM period_close_log WHERE tenant_id = ${t.tenantId}::uuid AND step = 'closing'`); // chỉ còn chứng từ KC
    expect((await t.run('KU_CHUA_TINH_LAI', { from: '2026-01-01', to: '2026-01-31' })).map((x) => x.ref)).toEqual(['VAY01']);
    await t.ok(t.call('POST', `/api/loans/${t.id}/repay`, { date: '2026-01-30', principal: '1000000000', bankAccountNo: '0011001' }), 201);
    expect(await t.run('KU_CHUA_TINH_LAI', { from: '2026-01-01', to: '2026-01-31' })).toEqual([]);
  });

  it('KU_QUA_HAN: kỳ trả gốc quá hạn còn phần chưa trả bị báo theo phân bổ của loanLongTermPart; trả đủ kỳ sớm nhất thì hết báo kỳ đó', async () => {
    const t = await loanTenant();
    const q = (to: string) => ({ from: '2026-01-01', to });
    expect(await t.run('KU_QUA_HAN', q('2026-03-31'))).toEqual([]); // đúng ngày đến hạn chưa quá hạn
    let hits = await t.run('KU_QUA_HAN', q('2026-04-30'));
    expect(hits.map((x) => [x.ref, x.detail])).toEqual([['VAY01', 'Kỳ trả 31/03/2026 còn 250000000']]);
    await t.ok(t.call('POST', `/api/loans/${t.id}/repay`, { date: '2026-04-10', principal: '100000000', bankAccountNo: '0011001' }), 201);
    hits = await t.run('KU_QUA_HAN', q('2026-07-31'));
    expect(hits.map((x) => x.detail)).toEqual(['Kỳ trả 31/03/2026 còn 150000000', 'Kỳ trả 30/06/2026 còn 250000000']);
    // Khớp loanLongTermPart: tổng quá hạn tại 31/07/2026 = dư nợ − phần dài hạn khi mốc ngắn hạn (báo cáo + 12 tháng) rơi đúng 31/07/2026.
    const total = hits.reduce((s, h) => s.plus(h.detail!.replace(/\D+/g, ' ').trim().split(' ').pop()!), D(0));
    const outstanding = '900000000';
    expect(D(outstanding).minus(loanLongTermPart(outstanding, '100000000', inst, '2025-07-31', '2026-12-31')).toString()).toBe(total.toString());
    await t.ok(t.call('POST', `/api/loans/${t.id}/repay`, { date: '2026-07-10', principal: '400000000', bankAccountNo: '0011001' }), 201);
    expect(await t.run('KU_QUA_HAN', q('2026-07-31'))).toEqual([]);
  });
});
