// Dữ liệu mẫu công ty ABC: danh mục (packages/db, seedAbcTx) và một năm nghiệp vụ 2026 dựng bằng chính dịch vụ của API (số dư đầu kỳ theo hóa đơn, hóa đơn và thuế,
// thu chi có kế hoạch đối trừ, chênh lệch tỷ giá, tỷ giá xuất quỹ, đánh giá lại, phân bổ doanh thu nhận trước, khấu trừ thuế, tờ khai 01/GTGT quý 3, quý 4 đã chốt).
// Seed nằm ở apps/api vì packages/db không import được dịch vụ của API; dựng lại bút toán bằng SQL sẽ chép logic nghiệp vụ. Dùng: pnpm db:seed:abc
// Số kỳ vọng tính tay của năm này: packages/db/src/seed/expected-gd2-abc.json (kiểm ở test/sample-abc.test.ts).
// Phần kho (GĐ3): hàng HANG-A..D ở bốn kho theo bốn phương pháp giá vốn, tính tay ở expected-gd3-abc.json (kiểm ở test/inventory/sample-abc-kho.test.ts).
// Phần tài sản (GĐ4): 4 TSCĐ (2 đầu kỳ, 1 mua bằng HĐ, 1 XDCB; đánh giá lại tháng 6, thanh lý tháng 9), 2 CCDC (1 xuất kho, 1 mua dùng ngay, ghi giảm một phần), 1 chi phí trả trước,
// 1 khế ước vay VND đổi lãi suất giữa năm; các bước tài sản và lãi vay chạy mỗi cuối tháng theo thứ tự Quy trình cuối kỳ. Tính tay ở expected-gd4-abc.json (kiểm ở test/assets/sample-abc-tai-san.test.ts).
import '../src/env.js';
import pg from 'pg';
import { sql, type Transaction } from 'kysely';
import { createDb, type Database } from '@kt/db';
import { SENSITIVE_FLAGS } from '@kt/domain';
import { seedAbcTx } from '@kt/db/seed/demo-abc';
import { allocationInput, assetInput, categoryInput, saveAsset, saveCategory, setAllocations } from '../src/modules/assets/assets.js';
import { decreaseAsset, decreaseInput, decreaseTool, increaseAsset, increaseInput, revalueAsset, revalueInput, toolDecreaseInput } from '../src/modules/assets/events.js';
import { openingAssetRow, replaceOpeningAssets } from '../src/modules/assets/openingAssets.js';
import { runAssetPeriod } from '../src/modules/assets/periodRun.js';
import { disburse, disburseInput, loanInput, repay, repayInput, saveLoan } from '../src/modules/loans/loans.js';
import { runLoanInterest } from '../src/modules/loans/interest.js';
import { logCloseStep, runSummary } from '../src/modules/ledger/periodClose.js';
import { postWithCashCheck } from '../src/modules/cash/books.js';
import { adjustInput, runOutflowAdjust } from '../src/modules/cash/fx.js';
import { revaluationInput, runRevaluation } from '../src/modules/cash/revaluation.js';
import { autoInput, autoSettle, settle, settleInput } from '../src/modules/arap/settlement.js';
import { createInvoice, invoiceInput } from '../src/modules/invoices/service.js';
import { costingInput, runCosting } from '../src/modules/inventory/costingRun.js';
import { createLandedCost, landedCostInput } from '../src/modules/inventory/landedCost.js';
import { replaceOpeningStock, stockRow } from '../src/modules/inventory/openingStock.js';
import { createStockVoucher, stockVoucherInput } from '../src/modules/inventory/stockVouchers.js';
import { adjustStocktake, createStocktake, updateStocktake } from '../src/modules/inventory/stocktake.js';
import { createSchedule, runAmortization, runInput, scheduleInput } from '../src/modules/invoices/amortization.js';
import { openingRow, postOpening, replaceOpening } from '../src/modules/ledger/openingBalance.js';
import { createVoucher, voucherInput } from '../src/modules/ledger/vouchers.service.js';
import { offsetInput, runVatOffset } from '../src/modules/tax/vatOffset.js';
import { createReturn, finalizeReturn, returnInput } from '../src/modules/tax/vatReturn.js';

const FY = 2026;
const M = (n: number) => String(Math.round(n * 1_000_000)); // triệu đồng -> đồng (chỉ dùng số có tối đa 6 chữ số lẻ)
const pad = (n: number) => String(n).padStart(2, '0');
const day = (m: number, d: number) => `${FY}-${pad(m)}-${pad(d)}`;
const lastDay = (m: number) => new Date(Date.UTC(FY, m, 0)).toISOString().slice(0, 10);
const VCB = '0011001234567'; const VCB_USD = '0011001234568'; const BIDV = '2201000123456';

// Phần nghiệp vụ, chạy trong giao dịch của seedAbcTx (công ty và người dùng đã đặt). Vai trò app_user để hàng rào RLS lọc theo công ty như khi API chạy.
async function seedYear(c: pg.Client, tenantId: string, userId: string): Promise<void> {
  const role = new URL(process.env.DATABASE_URL!).username;
  await c.query(`SET LOCAL ROLE ${c.escapeIdentifier(role)}`);
  // Kysely trên chính kết nối đang mở giao dịch (không mở giao dịch mới): dịch vụ của API nhận nó như giao dịch của withTenant.
  const conn = { query: (...a: unknown[]) => (c.query as (...x: unknown[]) => unknown)(...a), release: () => {} };
  const trx = createDb({ connect: async () => conn, end: async () => {} } as unknown as pg.Pool) as unknown as Transaction<Database>;
  const auth = { permissions: new Set(['settlement.create', 'stock_voucher.create', 'stock_voucher.post', 'stock_voucher.view']), sensitive: new Set<string>(SENSITIVE_FLAGS) };
  const ctx = { tenantId, userId, auth, canBackdate: false, sensitive: auth.sensitive };

  // ---- Danh mục bổ sung, cài đặt, tỷ giá ----
  await c.query(`INSERT INTO tenant_setting(tenant_id, key, value) VALUES ($1, 'vat_period', '"quarter"') ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`, [tenantId]);
  // Thuế suất khấu trừ TNCN: giá trị minh họa của dữ liệu mẫu (người dùng tự nhập theo văn bản hiện hành), không phải dữ liệu pháp lý.
  await c.query(`UPDATE tax_code SET rate = 10 WHERE tenant_id = $1 AND code = 'TNCN_KT'`, [tenantId]);
  await c.query(`INSERT INTO party(tenant_id, code, name, is_customer, address, payment_term_days, default_account_code) VALUES ($1, 'KHNN01', 'Global Tech Solutions Pte. Ltd.', true, '1 Raffles Place, Singapore', 60, '131')`, [tenantId]);
  await c.query(`INSERT INTO party(tenant_id, code, name, is_vendor, address, default_account_code) VALUES ($1, 'CN001', 'Ông Phạm Văn Hùng (cá nhân)', true, 'Số 8 Kim Mã, Ba Đình, Hà Nội', '331')`, [tenantId]);
  // Khách hàng nước ngoài trả bằng USD: bật theo dõi ngoại tệ trên 131 (mẫu TT133 không bật) để nhập được số dư đầu kỳ nguyên tệ.
  await c.query(`UPDATE account SET track_currency = true WHERE tenant_id = $1 AND code = '131'`, [tenantId]);
  await c.query(`UPDATE party SET is_vendor = true WHERE tenant_id = $1 AND code = 'KH002'`, [tenantId]); // vừa là khách hàng vừa là nhà cung cấp: bù trừ công nợ
  // Kho (GĐ3): hàng, kho, đối tượng. TK 155/156/157, 5111 có sẵn trong mẫu TT133.
  const acc = (code: string) => `(SELECT id FROM account WHERE tenant_id = $1 AND code = '${code}')`;
  await c.query(`INSERT INTO uom(tenant_id, code, name) VALUES ($1, 'THUNG', 'Thùng')`, [tenantId]);
  const uomId = (code: string) => `(SELECT id FROM uom WHERE tenant_id = $1 AND code = '${code}')`;
  for (const [code, name, kind, tracking, invAcc] of [['HANG-A', 'Hàng A (đa ĐVT: thùng = 12 cái)', 'goods', 'none', null], ['HANG-B', 'Hàng B (theo lô, hạn dùng)', 'goods', 'lot_expiry', null],
    ['HANG-C', 'Hàng C (đích danh theo lô)', 'goods', 'lot', null], ['HANG-D', 'Hàng D (thành phẩm)', 'finished', 'none', '155']] as const)
    await c.query(`INSERT INTO item(tenant_id, code, name, kind, base_uom_id, tracking, inventory_account_id, revenue_account_id) VALUES ($1, $2, $3, $4, ${uomId('CAI')}, $5, ${invAcc ? acc(invAcc) : 'NULL'}, ${acc('5111')})`, [tenantId, code, name, kind, tracking]);
  await c.query(`INSERT INTO item(tenant_id, code, name, kind, base_uom_id, tracking, revenue_account_id) VALUES ($1, 'CCDC-01', 'Bàn làm việc CCDC-01 (công cụ dụng cụ)', 'tool', ${uomId('CAI')}, 'none', ${acc('5111')})`, [tenantId]);
  await c.query(`INSERT INTO item_uom(tenant_id, item_id, uom_id, factor, is_purchase, is_sale) VALUES ($1, (SELECT id FROM item WHERE tenant_id = $1 AND code = 'HANG-A'), ${uomId('THUNG')}, 12, true, true)`, [tenantId]);
  for (const [code, name, method, invAcc, kind] of [['KHO1', 'Kho 1 (bình quân cuối kỳ)', 'avg_period', '156', 'normal'], ['KHO2', 'Kho 2 (FIFO, TK kho theo hàng)', 'fifo', null, 'normal'], ['KHO3', 'Kho 3 (bình quân tức thời)', 'avg_moving', '156', 'normal'],
    ['KHO4', 'Kho 4 (đích danh)', 'specific', '156', 'normal'], ['KHOGB', 'Kho hàng gửi bán', 'avg_moving', '157', 'consignment_out'],
    ['KHO5', 'Kho 5 (công cụ dụng cụ, bình quân tức thời)', 'avg_moving', '153', 'normal']] as const)
    await c.query(`INSERT INTO warehouse(tenant_id, code, name, costing_method, inventory_account_id, kind) VALUES ($1, $2, $3, $4, ${invAcc ? acc(invAcc) : 'NULL'}, $5)`, [tenantId, code, name, method, kind]);
  for (const [code, name, cust] of [['NCC011', 'Công ty TNHH Thương mại Hàng hóa Sáu', false], ['NCCNN02', 'Asia Trading Co., Ltd (nhập khẩu)', false], ['VC001', 'Công ty Cổ phần Vận tải Một', false], ['KH021', 'Công ty TNHH Bán lẻ Sáu', true],
    // GĐ4: bên bán TSCĐ, bên bán CCDC, ngân hàng cho vay (công nợ không thanh toán trong năm, kiểm ở expected-gd4-abc.json congNoThem)
    ['NCC012', 'Công ty TNHH Thiết bị Công nghiệp Mười Hai', false], ['NCC013', 'Công ty TNHH Dụng cụ Văn phòng Mười Ba', false], ['NHVAY', 'Ngân hàng cho vay (khế ước vay mẫu)', false]] as const)
    await c.query(`INSERT INTO party(tenant_id, code, name, is_customer, is_vendor, default_account_code) VALUES ($1, $2, $3, $4, $5, $6)`, [tenantId, code, name, cust, !cust, cust ? '131' : '331']);
  const vcb = (await c.query(`SELECT id FROM bank WHERE tenant_id = $1 AND code = 'VCB'`, [tenantId])).rows[0].id;
  const bidv = (await c.query(`INSERT INTO bank(tenant_id, code, name, short_name) VALUES ($1, 'BIDV', 'Ngân hàng TMCP Đầu tư và Phát triển Việt Nam', 'BIDV') RETURNING id`, [tenantId])).rows[0].id;
  await c.query(`INSERT INTO bank_account(tenant_id, bank_id, account_no, account_name, branch, currency_code, gl_account_code) VALUES ($1,$2,$3,'CONG TY TNHH THUONG MAI ABC','Sở giao dịch','USD','1122'),
    ($1,$4,$5,'CONG TY TNHH THUONG MAI ABC','Chi nhánh Hoàn Kiếm','VND','1121')`, [tenantId, vcb, VCB_USD, bidv, BIDV]);
  for (const [d, r] of [['2026-02-10', 25600], ['2026-03-12', 25650], ['2026-08-05', 25800], ['2026-10-20', 25900], ['2026-11-16', 26100], ['2026-12-31', 26200]])
    await c.query(`INSERT INTO exchange_rate(tenant_id, currency_code, rate_date, rate_type, rate) VALUES ($1, 'USD', $2, 'transfer_avg', $3)`, [tenantId, d, r]);

  // ---- Loại tài sản (GĐ4): TSCĐ hữu hình, công cụ dụng cụ, chi phí trả trước ----
  for (const b of [{ code: 'MMTB', name: 'Máy móc, thiết bị', kind: 'fixed', assetAccountCode: '2111', depreciationAccountCode: '2141', defaultLifeUnits: 60 },
    { code: 'CCDC', name: 'Công cụ, dụng cụ', kind: 'tool', assetAccountCode: '242', defaultLifeUnits: 12 }, { code: 'CPTT', name: 'Chi phí trả trước', kind: 'prepaid', assetAccountCode: '242', defaultLifeUnits: 12 }])
    await saveCategory(trx, tenantId, null, categoryInput.parse(b));

  // ---- Số dư đầu kỳ theo hóa đơn (màn hình Số dư đầu kỳ: nhập rồi ghi sổ) ----
  await replaceOpening(trx, tenantId, FY, [
    { accountCode: '1111', debit: M(100) },
    { accountCode: '1121', bankAccountNo: VCB, debit: M(800) },
    { accountCode: '1122', bankAccountNo: VCB_USD, currencyCode: 'USD', debit: M(250), debitCurrency: '10000' },
    { accountCode: '131', partyCode: 'KH001', debit: M(110), docNo: '0000101', docDate: '2025-12-10', dueDate: '2026-01-09' },
    { accountCode: '131', partyCode: 'KH002', debit: M(55), docNo: '0000102', docDate: '2025-12-20', dueDate: '2026-01-19' },
    { accountCode: '131', partyCode: 'KHNN01', currencyCode: 'USD', debit: M(200), debitCurrency: '8000', docNo: 'INV-2025-12', docDate: '2025-12-15', dueDate: '2026-02-13' },
    { accountCode: '331', partyCode: 'NCC001', credit: M(66), docNo: '0000501', docDate: '2025-12-05', dueDate: '2025-12-20' },
    { accountCode: '331', partyCode: 'NCC002', credit: M(33), docNo: '0000777', docDate: '2025-12-28', dueDate: '2026-01-12' },
    { accountCode: '156', debit: '5500000' }, { accountCode: '155', debit: '3000000' }, // tồn kho đầu năm (khớp bảng tồn bên dưới), nguồn vốn cộng vào 4111
    { accountCode: '2111', debit: M(270) }, { accountCode: '2141', credit: M(29) }, // hai TSCĐ đầu kỳ (thẻ ở replaceOpeningAssets): nguồn vốn 4111 tăng 270 − 29 = 241 triệu
    { accountCode: '4111', credit: '1249500000' },
    { accountCode: '4211', credit: M(416) },
  ].map((r) => openingRow.parse(r)));
  await replaceOpeningStock(trx, tenantId, FY, [
    { warehouseCode: 'KHO1', itemCode: 'HANG-A', quantity: '20', value: '2000000' },
    { warehouseCode: 'KHO3', itemCode: 'HANG-B', quantity: '10', value: '1000000', lotNo: 'B-LOT0', expiryDate: '2027-06-30' },
    { warehouseCode: 'KHO4', itemCode: 'HANG-C', quantity: '5', value: '2500000', lotNo: 'C-L1' },
    { warehouseCode: 'KHO2', itemCode: 'HANG-D', quantity: '10', value: '3000000' },
  ].map((r) => stockRow.parse(r)));
  await replaceOpeningAssets(trx, tenantId, FY, [
    { code: 'TS-001', name: 'Máy chủ Dell PowerEdge (đã dùng 24 tháng)', categoryCode: 'MMTB', openingCost: M(120), openingAccumulated: M(29), openingRemainingUnits: '36' },
    { code: 'TS-002', name: 'Máy in khổ lớn HP DesignJet (mới mua cuối 2025)', categoryCode: 'MMTB', openingCost: M(150), openingAccumulated: '0', openingRemainingUnits: '36' },
  ].map((r) => openingAssetRow.parse(r)));
  const dk = await postOpening(trx, ctx, FY);
  // Thẻ mới: phân bổ chi phí 100% một bộ phận từ kỳ 1 (thẻ không có phân bổ thì kỳ chạy báo ASSET_ALLOCATION_MISSING).
  const allocate = async (id: number, expenseAccountCode: string, departmentCode: string) =>
    setAllocations(trx, tenantId, id, allocationInput.parse({ validFromYear: FY, validFromPeriod: 1, lines: [{ expenseAccountCode, departmentCode, ratio: '100' }] }));
  const idOf = async (code: string) => Number((await sql<{ id: string }>`SELECT id::text FROM asset WHERE code = ${code}`.execute(trx)).rows[0]!.id);
  await allocate(await idOf('TS-001'), '6422', 'HC');
  await allocate(await idOf('TS-002'), '6421', 'KD');
  const newCard = async (b: object, expenseAccountCode: string, departmentCode: string) => { const a = await saveAsset(trx, tenantId, null, assetInput.parse(b)); await allocate(a.id, expenseAccountCode, departmentCode); return a.id; };

  // ---- Công cụ ghi chứng từ qua dịch vụ ----
  const post = (id: string) => postWithCashCheck(trx, tenantId, id);
  const voucher = async (b: Record<string, unknown>) => (await post((await createVoucher(trx, ctx, voucherInput.parse(b))).id)).id;
  let saleNo = 0;
  const invoice = async (b: Record<string, unknown> & { invoice: Record<string, unknown> }) => {
    const sale = b['voucherType'] === 'HDB' || b['voucherType'] === 'GGB';
    const head = { formNo: '1', ...(sale && { serial: 'C26TAB', invoiceNo: String(++saleNo).padStart(7, '0') }), invoiceDate: b['documentDate'], ...b.invoice };
    const v = await createInvoice(trx, ctx, invoiceInput.parse({ ...b, invoice: head }));
    await post(v.id);
    return v.id;
  };
  // Khoản công nợ gốc của chứng từ (dòng công nợ đầu tiên) và dòng kê khai đầu tiên của hóa đơn.
  const item = async (voucherId: string, lineNo?: number) => (await sql<{ id: number }>`SELECT id FROM open_item WHERE voucher_id = ${voucherId}::uuid AND parent_id IS NULL
    ${lineNo ? sql`AND line_no = ${lineNo}` : sql``} ORDER BY line_no LIMIT 1`.execute(trx)).rows[0]!.id;
  const invoiceRow = async (voucherId: string) => (await sql<{ id: number }>`SELECT id FROM voucher_invoice WHERE voucher_id = ${voucherId}::uuid ORDER BY id LIMIT 1`.execute(trx)).rows[0]!.id;
  const L = (accountCode: string, debit: string, credit: string, o: Record<string, unknown> = {}) => ({ accountCode, debit, credit, ...o });
  const sale = (party: string, date: string, desc: string, items: { account?: string; amount: string; tax: string }[], o: Record<string, unknown> = {}) =>
    invoice({ voucherType: 'HDB', postingDate: date, documentDate: date, partyCode: party, description: desc, invoice: { invoiceGroupCode: o['group'] ?? groupOf(items[0]!.tax) },
      items: items.map((i) => ({ description: desc, accountCode: i.account ?? '5113', amountCurrency: i.amount, taxCodes: [i.tax] })), ...(o['usd'] ? { currencyCode: 'USD', fxRate: o['usd'] } : {}) });
  const purchase = (party: string, date: string, desc: string, serial: string, no: string, account: string, amount: string, taxCodes: string[], group = '01') =>
    invoice({ voucherType: 'HDM', postingDate: date, documentDate: date, partyCode: party, description: desc, invoice: { serial, invoiceNo: no, invoiceGroupCode: group },
      items: [{ description: desc, accountCode: account, amountCurrency: amount, taxCodes }] });
  const groupOf = (tax: string) => ({ V0: '00', V5: '05', V8: '08', V10: '10', KCT: 'KCT' })[tax]!;
  const receipt = (type: 'PT' | 'BC', party: string, date: string, amount: string, settleWith: number | null, desc: string, bank = VCB) =>
    voucher({ voucherType: type, postingDate: date, documentDate: date, partyCode: party, description: desc, purpose: 'thu_khach_hang', ...(type === 'BC' && { bankAccountNo: bank }),
      lines: [L(type === 'PT' ? '1111' : '1121', amount, '0'), L('131', '0', amount, { partyCode: party, ...(settleWith && { settle: [{ openItemId: settleWith, amount }] }) })] });
  const payment = (type: 'PC' | 'BN', party: string, date: string, amount: string, settleWith: number, desc: string, bank = VCB) =>
    voucher({ voucherType: type, postingDate: date, documentDate: date, partyCode: party, description: desc, purpose: 'chi_tra_ncc', ...(type === 'BN' && { bankAccountNo: bank }),
      lines: [L('331', amount, '0', { partyCode: party, settle: [{ openItemId: settleWith, amount }] }), L(type === 'PC' ? '1111' : '1121', '0', amount)] });
  const taxPayment = (date: string, account: string, amount: string, desc: string) =>
    voucher({ voucherType: 'BN', postingDate: date, documentDate: date, description: desc, purpose: 'nop_thue', bankAccountNo: VCB, lines: [L(account, amount, '0'), L('1121', '0', amount)] });
  const usdOut = (date: string, usd: string, rate: string, vnd: string, desc: string) =>
    voucher({ voucherType: 'BN', postingDate: date, documentDate: date, description: desc, currencyCode: 'USD', fxRate: rate, bankAccountNo: VCB_USD,
      lines: [L('6422', vnd, '0', { amountCurrency: usd }), L('1122', '0', vnd, { amountCurrency: `-${usd}` })] });
  const usdIn = (date: string, usd: string, rate: string, vnd: string, settleWith: number | null, desc: string) =>
    voucher({ voucherType: 'BC', postingDate: date, documentDate: date, partyCode: 'KHNN01', description: desc, purpose: 'thu_khach_hang', currencyCode: 'USD', fxRate: rate, bankAccountNo: VCB_USD,
      lines: [L('1122', vnd, '0', { amountCurrency: usd }), L('131', '0', vnd, { partyCode: 'KHNN01', amountCurrency: `-${usd}`, ...(settleWith && { settle: [{ openItemId: settleWith, amountCurrency: usd }] }) })] });

  // ---- Nghiệp vụ theo ngày: sắp theo ngày (ổn định theo thứ tự thêm), việc cuối tháng chạy sau mọi chứng từ của tháng ----
  const events: { key: string; run: () => Promise<unknown> }[] = [];
  const at = (date: string, run: () => Promise<unknown>) => events.push({ key: date, run });
  const ref: Record<string, string> = {};
  const dkKH001 = await item(dk.id, dk.lines.find((l) => l.partyCode === 'KH001')!.lineNo);
  const dkLine = (party: string) => item(dk.id, dk.lines.find((l) => l.partyCode === party)!.lineNo);

  for (let m = 1; m <= 12; m++) {
    // Dịch vụ tư vấn hằng tháng cho KH001 (10%), thuê văn phòng của NCC001 (10%), thu và trả trong tháng (tiền thuê tháng 6 trả ngày 03/7, tháng 10 thu 99 triệu sau giảm giá).
    at(day(m, 5), async () => { ref[`HDB-KH001-${m}`] = await sale('KH001', day(m, 5), `Dịch vụ tư vấn quản trị tháng ${m}/${FY}`, [{ amount: M(100), tax: 'V10' }]); });
    at(day(m, 10), async () => { ref[`HDM-NCC001-${m}`] = await purchase('NCC001', day(m, 10), `Thuê văn phòng tháng ${m}/${FY}`, 'C26TNA', String(1000 + m), '6422', M(20), ['V10']); });
    if (m !== 12) at(day(m, 25), async () => receipt('BC', 'KH001', day(m, 25), m === 10 ? M(99) : M(110), await item(ref[`HDB-KH001-${m}`]!), `Thu tiền dịch vụ tư vấn tháng ${m}`));
    const payDate = m === 6 ? day(7, 3) : day(m, 25);
    at(payDate, async () => payment('BN', 'NCC001', payDate, M(22), await item(ref[`HDM-NCC001-${m}`]!), `Trả tiền thuê văn phòng tháng ${m}`));
  }
  // Tháng 12: thu không kèm kế hoạch, đối trừ tự động cuối năm.
  at(day(12, 25), () => receipt('BC', 'KH001', day(12, 25), M(110), null, 'Thu tiền dịch vụ tư vấn tháng 12'));

  // Quý 1
  at(day(1, 8), () => receipt('BC', 'KH001', day(1, 8), M(110), dkKH001, 'Thu nợ hóa đơn 0000101 năm 2025'));
  at(day(1, 15), async () => payment('BN', 'NCC001', day(1, 15), M(66), await dkLine('NCC001'), 'Trả nợ hóa đơn 0000501 năm 2025'));
  at(day(1, 20), async () => receipt('PT', 'KH002', day(1, 20), M(55), await dkLine('KH002'), 'Thu nợ hóa đơn 0000102 năm 2025'));
  at(day(2, 5), async () => payment('PC', 'NCC002', day(2, 5), M(33), await dkLine('NCC002'), 'Trả nợ hóa đơn 0000777 năm 2025'));
  at(day(2, 10), async () => usdIn(day(2, 10), '5000', '25600', M(128), await dkLine('KHNN01'), 'Thu một phần hóa đơn INV-2025-12 (5.000 USD)'));
  at(day(2, 18), async () => { ref['HDB-KH002-V5'] = await sale('KH002', day(2, 18), 'Dịch vụ thiết kế tài liệu đào tạo', [{ amount: M(40), tax: 'V5' }]); });
  at(day(3, 3), () => voucher({ voucherType: 'PC', postingDate: day(3, 3), documentDate: day(3, 3), description: 'Tạm ứng công tác phí cho ông Lê Văn Cường', personName: 'Lê Văn Cường', purpose: 'chi_tam_ung',
    lines: [L('141', M(10), '0'), L('1111', '0', M(10))] }));
  at(day(3, 12), () => usdOut(day(3, 12), '2000', '25650', M(51.3), 'Thanh toán phí bản quyền phần mềm năm 2026 (2.000 USD)'));
  at(day(3, 20), () => voucher({ voucherType: 'QTU', postingDate: day(3, 20), documentDate: day(3, 20), description: 'Quyết toán tạm ứng công tác phí ông Lê Văn Cường', personName: 'Lê Văn Cường',
    lines: [L('6422', M(8), '0'), L('141', '0', M(8))] }));
  at(day(3, 21), () => voucher({ voucherType: 'PT', postingDate: day(3, 21), documentDate: day(3, 21), description: 'Thu hoàn ứng ông Lê Văn Cường', personName: 'Lê Văn Cường', purpose: 'thu_hoan_ung',
    lines: [L('1111', M(2), '0'), L('141', '0', M(2))] }));
  // Quý 2
  at(day(4, 10), async () => { ref['HDM-CN001'] = await purchase('CN001', day(4, 10), 'Dịch vụ dịch thuật hồ sơ thầu (cá nhân, khấu trừ thuế TNCN)', '', 'BK-0410', '6422', M(15), ['TNCN_KT'], '05'); });
  at(day(4, 15), async () => payment('PC', 'CN001', day(4, 15), M(13.5), await item(ref['HDM-CN001']!), 'Trả tiền dịch thuật ông Phạm Văn Hùng (đã khấu trừ thuế TNCN)'));
  // 26 triệu của GĐ2 trừ 8.490.000 VAT đầu vào mới (TSCĐ, CCDC) được khấu trừ ở quý 1.
  at(day(4, 20), () => taxPayment(day(4, 20), '33311', '17510000', 'Nộp thuế GTGT quý 1/2026'));
  at(day(5, 12), async () => { ref['HDB-KH002-V8a'] = await sale('KH002', day(5, 12), 'Dịch vụ tổ chức hội nghị khách hàng', [{ amount: M(50), tax: 'V8' }]); });
  at(day(5, 20), () => taxPayment(day(5, 20), '3335', M(1.5), 'Nộp thuế TNCN khấu trừ tháng 4/2026'));
  at(day(6, 10), async () => receipt('PT', 'KH002', day(6, 10), M(42), await item(ref['HDB-KH002-V5']!), 'Thu tiền dịch vụ thiết kế tài liệu đào tạo'));
  at(day(6, 25), async () => {
    const id = ref['HDB-KH003'] = await sale('KH003', day(6, 25), 'Dịch vụ bảo trì hệ thống 6 tháng (07-12/2026), thu trước', [{ account: '3387', amount: M(60), tax: 'V10' }]);
    await createSchedule(trx, tenantId, userId, scheduleInput.parse({ sourceVoucherId: id, fromAccountCode: '3387', toAccountCode: '5113', total: M(60), periods: 6, startYear: FY, startPeriod: 7,
      description: 'Phân bổ doanh thu bảo trì hệ thống KH003' }));
  });
  at(day(6, 28), async () => receipt('BC', 'KH003', day(6, 28), M(66), await item(ref['HDB-KH003']!), 'Thu trước tiền bảo trì hệ thống 6 tháng'));
  // Quý 3
  at(day(7, 10), async () => receipt('BC', 'KH002', day(7, 10), M(54), await item(ref['HDB-KH002-V8a']!), 'Thu tiền dịch vụ tổ chức hội nghị'));
  at(day(7, 15), async () => { ref['HDB-KH004'] = await sale('KH004', day(7, 15), 'Dịch vụ đào tạo nghề kế toán (không chịu thuế GTGT)', [{ amount: M(30), tax: 'KCT' }]); });
  at(day(7, 20), () => taxPayment(day(7, 20), '33311', M(34), 'Nộp thuế GTGT quý 2/2026'));
  at(day(7, 22), async () => { ref['HDM-NCC003'] = await purchase('NCC003', day(7, 22), 'Dịch vụ in tài liệu đào tạo', 'C26TIN', '0000315', '6422', M(10), ['V5']); });
  at(day(7, 28), async () => payment('BN', 'NCC003', day(7, 28), M(10.5), await item(ref['HDM-NCC003']!), 'Trả tiền in tài liệu đào tạo'));
  at(day(8, 5), async () => { ref['HDB-KHNN01'] = await sale('KHNN01', day(8, 5), 'Software consulting service (export, VAT 0%)', [{ amount: '4000', tax: 'V0' }], { usd: '25800' }); });
  at(day(8, 12), async () => { ref['HDB-KH005'] = await sale('KH005', day(8, 12), 'Dịch vụ biên soạn tài liệu kỹ thuật', [{ amount: M(20), tax: 'V5' }]); });
  at(day(8, 15), async () => receipt('BC', 'KH004', day(8, 15), M(30), await item(ref['HDB-KH004']!), 'Thu tiền dịch vụ đào tạo'));
  at(day(8, 20), async () => { ref['HDM-NCC002'] = await purchase('NCC002', day(8, 20), 'Dịch vụ triển khai hệ thống quản trị', 'C26TDV', '0002468', '6422', M(400), ['V10']); });
  at(day(9, 5), async () => { ref['HDM-NCC004'] = await purchase('NCC004', day(9, 5), 'Dịch vụ quảng cáo trực tuyến', 'C26TQC', '0000908', '6421', M(25), ['V8']); });
  at(day(9, 10), async () => { ref['HDB-KH002-V8b'] = await sale('KH002', day(9, 10), 'Dịch vụ tổ chức sự kiện ra mắt sản phẩm', [{ amount: M(20), tax: 'V8' }]); });
  at(day(9, 20), async () => payment('BN', 'NCC004', day(9, 20), M(27), await item(ref['HDM-NCC004']!), 'Trả tiền quảng cáo trực tuyến'));
  at(day(9, 28), async () => payment('BN', 'NCC002', day(9, 28), M(240), await item(ref['HDM-NCC002']!), 'Trả một phần tiền triển khai hệ thống'));
  // Quý 4
  at(day(10, 5), () => voucher({ voucherType: 'CT', postingDate: day(10, 5), documentDate: day(10, 5), description: 'Chuyển tiền từ Vietcombank sang BIDV', bankAccountNo: VCB, counterBankAccountNo: BIDV,
    lines: [L('1121', M(300), '0'), L('1121', '0', M(300))] }));
  at(day(10, 15), async () => payment('BN', 'NCC002', day(10, 15), M(200), await item(ref['HDM-NCC002']!), 'Trả nốt tiền triển khai hệ thống', BIDV));
  at(day(10, 20), async () => {
    const orig = ref['HDB-KH001-10']!;
    const ggb = await invoice({ voucherType: 'GGB', postingDate: day(10, 20), documentDate: day(10, 20), partyCode: 'KH001', description: 'Giảm giá dịch vụ tư vấn tháng 10 do chậm tiến độ',
      invoice: { invoiceGroupCode: '10', adjustsInvoiceId: await invoiceRow(orig) }, items: [{ description: 'Giảm giá dịch vụ tư vấn tháng 10', accountCode: '5113', amountCurrency: M(10), taxCodes: ['V10'] }] });
    await settle(trx, auth, settleInput.parse({ debitItemId: await item(orig), creditItemId: await item(ggb), amount: M(11), date: day(10, 20) }));
  });
  at(day(10, 20), async () => {
    const bc = await usdIn(day(10, 20), '3000', '25900', M(77.7), null, 'Thu nốt hóa đơn INV-2025-12 (3.000 USD)');
    await settle(trx, auth, settleInput.parse({ debitItemId: await dkLine('KHNN01'), creditItemId: await item(bc), amountCurrency: '3000', date: day(10, 20) }));
  });
  at(day(11, 10), async () => { ref['HDM-KH002'] = await purchase('KH002', day(11, 10), 'Dịch vụ truyền thông sự kiện', 'C26TKH', '0000077', '6421', M(10), ['V10']); });
  at(day(11, 15), async () => voucher({ voucherType: 'BT', postingDate: day(11, 15), documentDate: day(11, 15), partyCode: 'KH002', description: 'Bù trừ công nợ phải thu, phải trả Công ty Cổ phần Khách hàng 2',
    lines: [L('331', M(11), '0', { partyCode: 'KH002', settle: [{ openItemId: await item(ref['HDM-KH002']!), amount: M(11) }] }),
      L('131', '0', M(11), { partyCode: 'KH002', settle: [{ openItemId: await item(ref['HDB-KH002-V8b']!), amount: M(11) }] })] }));
  at(day(11, 16), () => usdOut(day(11, 16), '1000', '26100', M(26.1), 'Thanh toán phí máy chủ đám mây (1.000 USD)'));
  at(day(12, 8), async () => { ref['HDM-NCC005'] = await purchase('NCC005', day(12, 8), 'Dịch vụ bảo dưỡng thiết bị văn phòng', 'C26TBD', '0001212', '6422', M(30), ['V10']); });
  at(day(12, 10), async () => receipt('PT', 'KH002', day(12, 10), M(10.6), await item(ref['HDB-KH002-V8b']!), 'Thu nốt tiền dịch vụ tổ chức sự kiện'));

  // ---- Kho (GĐ3): chứng từ hàng hóa qua dịch vụ kho; hóa đơn bán dùng quyển C26TBH, mua dùng C26TMH (không đổi số hóa đơn bán GĐ2) ----
  const stockCtx = { tenantId, userId, auth };
  let bhNo = 0; let mhNo = 0;
  const gl = (itemCode: string, warehouseCode: string, quantity: string, unitPrice: string, amountCurrency: string, o: Record<string, unknown> = {}) =>
    ({ itemCode, uomCode: 'CAI', warehouseCode, quantity, unitPrice, amountCurrency, taxCodes: ['V10'], ...o });
  const goodsSale = async (type: 'BH' | 'TLB', party: string, date: string, desc: string, items: object[], o: Record<string, unknown> = {}) => {
    const v = await createInvoice(trx, ctx, invoiceInput.parse({ voucherType: type, postingDate: date, documentDate: date, partyCode: party, description: desc, items,
      invoice: { formNo: '1', serial: 'C26TBH', invoiceNo: String(++bhNo).padStart(7, '0'), invoiceDate: date, invoiceGroupCode: '10', ...o } }));
    await post(v.id); return v.id;
  };
  const goodsBuy = async (party: string, date: string, desc: string, items: object[], o: Record<string, unknown> = {}) => {
    const { stockMode = 'through_stock', receiptVoucherIds, ...inv } = o;
    const v = await createInvoice(trx, ctx, invoiceInput.parse({ voucherType: 'MH', stockMode, postingDate: date, documentDate: date, partyCode: party, description: desc, items, ...(receiptVoucherIds ? { receiptVoucherIds } : {}),
      invoice: { formNo: '1', serial: 'C26TMH', invoiceNo: String(++mhNo).padStart(7, '0'), invoiceDate: date, invoiceGroupCode: '01', ...inv } }));
    await post(v.id); return v.id;
  };
  const stockDoc = async (b: Record<string, unknown>) => { const v = await createStockVoucher(trx, stockCtx, stockVoucherInput.parse(b)); await post(v.id); return v.id; };
  const lineOf = async (voucherId: string) => Number((await sql<{ id: string }>`SELECT id::text FROM voucher_item_line WHERE voucher_id = ${voucherId}::uuid ORDER BY id LIMIT 1`.execute(trx)).rows[0]!.id);
  const costing = (from: string, to: string) => runCosting(trx, { tenantId, userId, canBackdate: false }, costingInput.parse({ periodFrom: from, periodTo: to }));

  // Tháng 1-3 (quý 1 có toàn bộ thuế GTGT của kho): mua, hàng về trước, nhập khẩu và chi phí mua, bán, trả lại, chuyển kho gửi bán; tháng 4 ghi lùi một phiếu nhập tháng 3; tháng 6 kiểm kê.
  at(day(1, 5), async () => { ref['MH-A'] = await goodsBuy('NCC011', day(1, 5), 'Mua HANG-A 2 thùng nhập KHO1', [gl('HANG-A', 'KHO1', '2', '1260000', '2520000', { uomCode: 'THUNG' })]); });
  at(day(1, 8), async () => { ref['PNK-D'] = await stockDoc({ voucherType: 'PNK', stockKind: 'purchase', postingDate: day(1, 8), warehouseCode: 'KHO2', partyCode: 'NCC011', description: 'Nhập HANG-D, hóa đơn về sau',
    items: [{ itemCode: 'HANG-D', uomCode: 'CAI', quantity: '10', unitPrice: '320000' }] }); });
  at(day(1, 10), async () => { await goodsBuy('NCC011', day(1, 10), 'Mua HANG-B lô B-LOT1 nhập KHO3', [gl('HANG-B', 'KHO3', '20', '131000', '2620000', { lotNo: 'B-LOT1', expiryDate: '2027-12-31' })]); });
  at(day(1, 12), async () => { await goodsBuy('NCC011', day(1, 12), 'Mua HANG-C lô C-L2 nhập KHO4', [gl('HANG-C', 'KHO4', '3', '523333.3333', '1570000', { lotNo: 'C-L2' })]); });
  at(day(1, 15), async () => { ref['BH-A'] = await goodsSale('BH', 'KH021', day(1, 15), 'Bán HANG-A', [gl('HANG-A', 'KHO1', '30', '150000', '4500000')]); });
  at(day(1, 20), async () => { await goodsBuy('NCC011', day(1, 20), 'Hóa đơn HANG-D về sau phiếu nhập 08/01', [gl('HANG-D', 'KHO2', '10', '333333.3', '3333333')],
    { stockMode: 'goods_first', receiptVoucherIds: [ref['PNK-D']!] }); });
  at(day(1, 25), async () => { await goodsSale('BH', 'KH021', day(1, 25), 'Bán HANG-B lô B-LOT0', [gl('HANG-B', 'KHO3', '8', '200000', '1600000', { lotNo: 'B-LOT0' })]); });
  at(day(2, 5), async () => { await goodsSale('BH', 'KH021', day(2, 5), 'Bán HANG-D', [gl('HANG-D', 'KHO2', '12', '450000', '5400000')]); });
  at(day(2, 10), async () => { // khách trả lại 5 cái HANG-A (giá vốn trả lại = giá vốn của lần xuất gốc, tỷ lệ)
    await goodsSale('TLB', 'KH021', day(2, 10), 'Khách trả lại 5 cái HANG-A', [gl('HANG-A', 'KHO1', '5', '150000', '750000', { sourceLineId: await lineOf(ref['BH-A']!) })], { adjustsInvoiceId: await invoiceRow(ref['BH-A']!) });
  });
  at(day(2, 10), async () => { // nhập khẩu một lô: thuế nhập khẩu vào giá, thuế GTGT hàng nhập được khấu trừ
    ref['MH-B-NK'] = await goodsBuy('NCCNN02', day(2, 10), 'Nhập khẩu HANG-B lô B-LOT2 nhập KHO3', [gl('HANG-B', 'KHO3', '10', '100000', '1000000',
      { taxCodes: [], lotNo: 'B-LOT2', expiryDate: '2028-02-28', importMode: true, importTax: '100000', vatImport: '110000', vatImportCode: 'V10' })], { serial: '', invoiceNo: `TK-${FY}-001` });
  });
  at(day(2, 12), async () => { // chi phí vận chuyển phân bổ theo giá trị vào lô nhập khẩu
    const lc = await createLandedCost(trx, stockCtx, landedCostInput.parse({ postingDate: day(2, 12), partyCode: 'VC001', basis: 'value', receiptVoucherIds: [ref['MH-B-NK']!], description: 'Cước vận chuyển lô nhập khẩu HANG-B',
      costLines: [{ accountCode: '331', amount: '200000', vatAmount: '20000', partyCode: 'VC001' }],
      invoices: [{ serial: 'C26TVC', invoiceNo: '0000412', invoiceDate: day(2, 12), invoiceGroupCode: '01', taxCode: 'V10', baseAmount: '200000', taxAmount: '20000' }] }));
    await post(lc.id);
  });
  at(day(2, 15), async () => { await goodsSale('BH', 'KH021', day(2, 15), 'Bán HANG-C lô C-L1', [gl('HANG-C', 'KHO4', '4', '700000', '2800000', { lotNo: 'C-L1' })]); });
  at(day(2, 20), async () => { await goodsSale('BH', 'KH021', day(2, 20), 'Bán HANG-B lô B-LOT1', [gl('HANG-B', 'KHO3', '12', '200000', '2400000', { lotNo: 'B-LOT1' })]); });
  at(day(3, 5), async () => { await goodsSale('BH', 'KH021', day(3, 5), 'Bán HANG-D', [gl('HANG-D', 'KHO2', '3', '450000', '1350000')]); });
  at(day(3, 10), async () => { await goodsSale('BH', 'KH021', day(3, 10), 'Bán HANG-C lô C-L2', [gl('HANG-C', 'KHO4', '2', '700000', '1400000', { lotNo: 'C-L2' })]); });
  at(day(3, 15), () => stockDoc({ voucherType: 'CK', stockKind: 'transfer', postingDate: day(3, 15), warehouseCode: 'KHO1', destWarehouseCode: 'KHOGB', description: 'Chuyển 4 cái HANG-A sang kho hàng gửi bán',
    items: [{ itemCode: 'HANG-A', uomCode: 'CAI', quantity: '4' }] }));
  at(day(3, 20), async () => { await goodsSale('BH', 'KH021', day(3, 20), 'Bán HANG-A từ KHO1', [gl('HANG-A', 'KHO1', '10', '150000', '1500000')]); });
  at(day(3, 25), async () => { await goodsSale('BH', 'KH021', day(3, 25), 'Bán HANG-A từ kho hàng gửi bán', [gl('HANG-A', 'KHOGB', '2', '150000', '300000')]); });
  // Nộp phần thuế còn lại của quý 1 do hàng hóa (đầu ra trừ đầu vào), thuế nhập khẩu và thuế GTGT hàng nhập khẩu.
  at(day(4, 21), async () => {
    await taxPayment(day(4, 21), '33311', '915667', 'Nộp thuế GTGT quý 1/2026 (phần hàng hóa)');
    await taxPayment(day(4, 21), '3333', '100000', 'Nộp thuế nhập khẩu lô HANG-B');
    await taxPayment(day(4, 21), '33312', '110000', 'Nộp thuế GTGT hàng nhập khẩu lô HANG-B');
  });
  // Ghi lùi phiếu nhập tháng 3 sau khi đã chạy giá vốn tháng 3: chạy lại, giá vốn GV tháng 3 được đảo và lập lại.
  at(day(4, 3), async () => {
    await stockDoc({ voucherType: 'PNK', stockKind: 'purchase', postingDate: day(3, 10), warehouseCode: 'KHO1', partyCode: 'NCC011', description: 'Nhập bổ sung HANG-A ghi lùi ngày 10/03 (chưa có hóa đơn)',
      items: [{ itemCode: 'HANG-A', uomCode: 'CAI', quantity: '6', unitPrice: '110000' }] });
    await costing(day(3, 1), lastDay(3));
  });
  at(day(6, 30), async () => { // kiểm kê KHO1: sổ 11, đếm 10, thiếu 1 trong định mức vào giá vốn
    const k = await createStocktake(trx, { tenantId, userId }, { docDate: day(6, 30), warehouseCode: 'KHO1', note: 'Kiểm kê giữa năm' });
    await updateStocktake(trx, { tenantId }, k.id, { lines: [{ itemCode: 'HANG-A', countedQty: '10', reason: 'cogs' }] });
    await adjustStocktake(trx, { tenantId, userId, auth: { sensitive: auth.sensitive } }, k.id);
  });

  // ---- Tài sản cố định, công cụ dụng cụ, chi phí trả trước, khế ước vay (GĐ4): thẻ lập đúng ngày phát sinh, biến động trước bước cuối tháng của tháng đó ----
  const hdmAsset = (party: string, date: string, desc: string, no: string, account: string, amount: string, assetCode: string) =>
    invoice({ voucherType: 'HDM', postingDate: date, documentDate: date, partyCode: party, description: desc, invoice: { serial: 'C26TTS', invoiceNo: no, invoiceGroupCode: '01' },
      items: [{ description: desc, accountCode: account, amountCurrency: amount, taxCodes: ['V10'], assetCode }] });
  let loanId = 0;
  at(day(1, 12), async () => { await goodsBuy('NCC013', day(1, 12), 'Mua 4 bàn làm việc CCDC-01 nhập KHO5', [gl('CCDC-01', 'KHO5', '4', '1625000', '6500000')]); });
  at(day(2, 3), async () => { // CC-001: xuất cả 4 cái từ kho cho phòng kinh doanh, phân bổ 6 kỳ từ tháng 2
    await newCard({ code: 'CC-001', name: 'Bàn làm việc phòng kinh doanh (xuất kho)', kind: 'tool', categoryCode: 'CCDC', useDate: day(2, 3), depreciationStartDate: day(2, 3), lifeUnits: 6, quantity: '4', uom: 'Cái' }, '6421', 'KD');
    await stockDoc({ voucherType: 'PXK', stockKind: 'use', postingDate: day(2, 3), warehouseCode: 'KHO5', description: 'Xuất 4 bàn làm việc cho phòng kinh doanh',
      items: [{ itemCode: 'CCDC-01', uomCode: 'CAI', quantity: '4', debitAccountCode: '242', assetCode: 'CC-001' }] });
  });
  at(day(2, 17), async () => { // TS-003: mua bằng hóa đơn, thuế GTGT 10%, tính khấu hao theo ngày từ 17/02 (60 tháng)
    await newCard({ code: 'TS-003', name: 'Máy cắt CNC (mua tháng 2)', kind: 'fixed', categoryCode: 'MMTB', useDate: day(2, 17), depreciationStartDate: day(2, 17), lifeUnits: 60 }, '6422', 'HC');
    await hdmAsset('NCC012', day(2, 17), 'Mua máy cắt CNC', '0000051', '2111', M(66), 'TS-003');
  });
  at(day(3, 1), async () => { // khế ước vay 400 triệu, lãi 9%/năm rồi 10,5%/năm từ 16/07, trả gốc 4 kỳ (kỳ 4 sang năm sau)
    const l = await saveLoan(trx, tenantId, null, loanInput.parse({ code: 'KU-2026-01', name: 'Vay bổ sung vốn lưu động Vietcombank', partyCode: 'NHVAY', value: M(400), signedDate: day(3, 1), validTo: '2027-03-31', status: 'active',
      dayBasis: 365, rates: [{ validFrom: day(3, 1), annualRate: '9' }, { validFrom: day(7, 16), annualRate: '10.5' }],
      installments: [day(6, 30), day(9, 30), day(12, 31), '2027-03-31'].map((dueDate) => ({ dueDate, principal: M(100) })) }));
    loanId = l.id;
    await disburse(trx, ctx, loanId, disburseInput.parse({ date: day(3, 1), amount: M(400), bankAccountNo: VCB }));
  });
  at(day(3, 8), async () => { // CC-002: mua dùng ngay, 7 cái, phân bổ 12 kỳ từ tháng 3
    await newCard({ code: 'CC-002', name: 'Ghế công thái học (mua dùng ngay)', kind: 'tool', categoryCode: 'CCDC', useDate: day(3, 8), depreciationStartDate: day(3, 8), lifeUnits: 12, quantity: '7', uom: 'Cái' }, '6422', 'HC');
    await hdmAsset('NCC013', day(3, 8), 'Mua 7 ghế công thái học', '0000052', '242', M(12.4), 'CC-002');
  });
  at(day(4, 10), () => voucher({ voucherType: 'BN', postingDate: day(4, 10), documentDate: day(4, 10), description: 'Chi xây dựng cơ bản dở dang lắp đặt hệ thống máy', bankAccountNo: VCB,
    lines: [L('2412', M(90), '0'), L('1121', '0', M(90))] }));
  at(day(4, 20), async () => { // TS-004: nghiệm thu, ghi tăng từ XDCB; khấu hao từ 01/05 (84 tháng)
    const id = await newCard({ code: 'TS-004', name: 'Hệ thống máy lắp đặt (XDCB)', kind: 'fixed', categoryCode: 'MMTB', useDate: day(4, 20), depreciationStartDate: day(5, 1), lifeUnits: 84 }, '6422', 'HC');
    await increaseAsset(trx, ctx, id, increaseInput.parse({ date: day(4, 20), reason: 'construction', counterAccountCode: '2412', amount: M(90) }));
  });
  at(day(5, 2), async () => { // CPTT-01: tiền thuê kho 12 tháng trả trước, phân bổ từ tháng 5
    await newCard({ code: 'CPTT-01', name: 'Tiền thuê kho 12 tháng (05/2026-04/2027)', kind: 'prepaid', categoryCode: 'CPTT', useDate: day(5, 2), depreciationStartDate: day(5, 1), lifeUnits: 12 }, '6422', 'HC');
    await voucher({ voucherType: 'BN', postingDate: day(5, 2), documentDate: day(5, 2), description: 'Trả trước tiền thuê kho 12 tháng', bankAccountNo: VCB, lines: [L('242', M(25), '0', { assetCode: 'CPTT-01' }), L('1121', '0', M(25))] });
  });
  at(day(6, 15), async () => { // đánh giá lại TS-001 (TT133 không có TK 412: chênh lệch vào 4118)
    await revalueAsset(trx, ctx, await idOf('TS-001'), revalueInput.parse({ date: day(6, 15), newCost: M(150), newAccumulated: M(48), remainingUnits: '31', counterAccountCode: '4118' }));
  });
  for (const [date, principal] of [[day(6, 30), M(100)], [day(9, 30), M(100)], [day(12, 31), M(100)]] as const)
    at(date, async () => { await repay(trx, ctx, loanId, repayInput.parse({ date, principal, bankAccountNo: VCB })); }); // chỉ trả gốc; lãi dồn vào 335 đến hết năm
  at(day(7, 20), async () => { await decreaseTool(trx, ctx, await idOf('CC-002'), toolDecreaseInput.parse({ date: day(7, 20), quantity: '1', counterAccountCode: '811', reason: 'Hỏng 1 ghế, không sửa được' })); });
  at(day(9, 15), async () => { await decreaseAsset(trx, ctx, await idOf('TS-002'), decreaseInput.parse({ date: day(9, 15), reason: 'liquidation', counterAccountCode: '811' })); });

  // Cuối tháng: phân bổ doanh thu nhận trước, tính lại tỷ giá xuất quỹ, (tháng 12) đối trừ tự động và đánh giá lại, cuối quý khấu trừ thuế và (quý 3, 4) lập, chốt tờ khai.
  for (let m = 1; m <= 12; m++) {
    events.push({ key: `${lastDay(m)}~`, run: async () => {
      // Quy trình cuối kỳ theo thứ tự cố định (CLOSE_STEPS): CCDC, chi phí trả trước, khấu hao, lãi vay rồi các bước còn lại; mỗi lần chạy ghi nhật ký như route.
      for (const kind of ['tool', 'prepaid', 'depreciation'] as const)
        await logCloseStep(trx, ctx, { fiscalYear: FY, periodNo: m, step: kind, ok: true, summary: runSummary(await runAssetPeriod(trx, ctx, { kind, fiscalYear: FY, periodNo: m })) });
      await logCloseStep(trx, ctx, { fiscalYear: FY, periodNo: m, step: 'loan_interest', ok: true, summary: runSummary(await runLoanInterest(trx, ctx, { fiscalYear: FY, periodNo: m })) });
      await costing(day(m, 1), lastDay(m)); // giá vốn kho từng tháng (GV chỉ lập khi giá tính khác giá ghi tạm)
      if (m >= 7) await runAmortization(trx, ctx, runInput.parse({ fiscalYear: FY, periodNo: m }));
      if (m === 12) await autoSettle(trx, auth, autoInput.parse({ accountCode: '131', partyCode: 'KH001', date: lastDay(m) }));
      await runOutflowAdjust(trx, ctx, adjustInput.parse({ fiscalYear: FY, periodNo: m }));
      if (m === 12) await runRevaluation(trx, ctx, revaluationInput.parse({ date: lastDay(m) }));
      if (m % 3 === 0) await runVatOffset(trx, ctx, offsetInput.parse({ date: lastDay(m) }));
      if (m === 9 || m === 12) { // quý 1, 2 thuộc mẫu TT 80/2021 chưa có (01GTGT_TT80 = false): không lập
        const r = await createReturn(trx, ctx, returnInput.parse({ year: FY, periodKind: 'quarter', period: m / 3 }));
        await finalizeReturn(trx, ctx, r.id);
      }
    } });
  }
  events.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // Array.sort ổn định: cùng ngày giữ thứ tự thêm
  for (const e of events) await e.run();

  await c.query('RESET ROLE');
  await c.query('SELECT recompute_balances($1)', [tenantId]);
}

type Hooks = { code?: string; afterTenant?: () => Promise<void>; afterYear?: () => Promise<void> };
const options = (c: pg.Client, { afterYear, ...o }: Hooks) => ({ ...o, extend: async (tenantId: string, userId: string) => { await seedYear(c, tenantId, userId); await afterYear?.(); } });
// `afterYear` chỉ để kiểm thử: giả lập lỗi sau khi đã ghi cả năm nghiệp vụ.
export const seedAbcFullTx = (c: pg.Client, o: Hooks = {}) => seedAbcTx(c, options(c, o));
export async function seedAbcFull(adminUrl: string) {
  const c = new pg.Client({ connectionString: adminUrl }); await c.connect();
  try { return await seedAbcFullTx(c); } finally { await c.end(); }
}

if (process.argv[1] && process.argv[1].endsWith('seed-abc.ts')) {
  const r = await seedAbcFull(process.env.DATABASE_ADMIN_URL!);
  console.log(r.extended ? `Đã tạo dữ liệu mẫu ABC năm ${FY} (${r.tenantId}); đăng nhập admin / Matkhau1!` : `Công ty ABC đã có chứng từ (${r.tenantId}): không tạo thêm`);
  process.exit(0);
}
