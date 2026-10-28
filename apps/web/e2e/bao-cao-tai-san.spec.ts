import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { typeRange } from './helpers/dates.js';

// Yêu cầu trước khi chạy: như tai-san.spec.ts (tài khoản e2e). Thẻ TSCĐ riêng của spec, mã mới mỗi lần chạy; nguyên giá ghi bằng phiếu kế toán ngày 01/01/2026.
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await request.post('/api/catalogs/party', { data: { code: 'NCC-E2E', name: 'Nhà cung cấp E2E', is_vendor: true } });
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('báo cáo tài sản: sổ TSCĐ, thẻ TSCĐ, tăng giảm', async ({ page, request }) => {
  await signIn(page, request);
  const code = `TSBC${Date.now().toString().slice(-9)}`;
  const a = await request.post('/api/assets', { data: { code, name: `Máy báo cáo ${code}`, kind: 'fixed', assetAccountCode: '2111', depreciationAccountCode: '2141', lifeUnits: 60, depreciationStartDate: '2026-01-01' } });
  expect(a.ok(), await a.text()).toBeTruthy();
  // Phân bổ chi phí từ kỳ 1: thẻ có nguyên giá mà thiếu phân bổ làm chạy khấu hao kỳ 1 (quy trình cuối kỳ) của CSDL e2e dùng chung báo ASSET_ALLOCATION_MISSING.
  expect((await request.put(`/api/assets/${(await a.json()).id}/allocations`, { data: { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', ratio: '100' }] } })).ok()).toBeTruthy();
  const v = await request.post('/api/vouchers', { data: { voucherType: 'PKT', postingDate: '2026-01-01', documentDate: '2026-01-01', description: 'E2E báo cáo tài sản', autoPost: true,
    lines: [{ accountCode: '2111', debit: '120000000', credit: '0', assetCode: code }, { accountCode: '331', debit: '0', credit: '120000000', partyCode: 'NCC-E2E' }] } });
  expect(v.ok(), await v.text()).toBeTruthy();

  // Bộ lọc nhớ nạp từ máy chủ sau khi trang mở và ghi đè ô vừa nhập: chờ bản nạp xong rồi mới nhập.
  const prefs = page.waitForResponse((r) => r.url().includes('/api/prefs/') && r.url().includes('asset-reports'));
  await page.goto('/tai-san/bao-cao'); await prefs;
  await expect(page.getByRole('heading', { name: 'Báo cáo tài sản' })).toBeVisible();
  await typeRange(page, '01/01/2026', '31/12/2026');

  const row = page.locator('.ag-center-cols-container .ag-row', { hasText: `Máy báo cáo ${code}` });
  // CSDL e2e dùng chung nên sổ có nhiều thẻ của spec khác: lưới ảo hóa dòng, cuộn dần đến khi thấy thẻ của spec này.
  await expect(async () => {
    await page.locator('.ag-body-viewport').first().evaluate((e) => { e.scrollTop += 200; });
    await expect(row).toBeVisible({ timeout: 300 });
  }).toPass({ timeout: 30_000 });
  await expect(row).toContainText('120.000.000');

  await page.getByRole('tab', { name: 'Tăng giảm tài sản' }).click();
  await expect(page.locator('.ag-center-cols-container .ag-row', { hasText: 'Cộng' }).first()).toBeVisible();

  await page.getByRole('tab', { name: 'Thẻ TSCĐ' }).click();
  await page.getByRole('combobox', { name: 'Tài sản' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type(code);
  await page.locator('.ant-select-item-option', { hasText: code }).first().click();
  await expect(page.locator('.ag-center-cols-container .ag-row', { hasText: '120.000.000' }).first()).toBeVisible();
});
