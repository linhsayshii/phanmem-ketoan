import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phieu-thu.spec.ts (tài khoản e2e). Hàng riêng mỗi lần chạy; chứng từ lập tháng 08/2026.
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await request.post('/api/catalogs/uom', { data: { code: 'CAI', name: 'Cái' } });
  await request.post('/api/catalogs/party', { data: { code: 'KH-E2E', name: 'Khách hàng E2E', is_customer: true } });
  await request.post('/api/catalogs/party', { data: { code: 'NCC-E2E', name: 'Nhà cung cấp E2E', is_vendor: true } });
  await request.post('/api/catalogs/warehouse', { data: { code: 'KHO-E2E', name: 'Kho E2E', inventory_account_code: '156', costing_method: 'avg_moving' } });
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('báo cáo bán hàng: doanh thu thuần, giá vốn và lãi gộp theo mặt hàng', async ({ page, request }) => {
  await signIn(page, request);
  const item = `HBH${Date.now().toString().slice(-8)}`;
  expect((await request.post('/api/catalogs/item', { data: { code: item, name: 'Hàng báo cáo bán E2E', base_uom_code: 'CAI', kind: 'goods', revenue_account_code: '5111' } })).ok()).toBeTruthy();
  const nhap = await request.post('/api/stock-vouchers', { data: { voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-08-03', warehouseCode: 'KHO-E2E', partyCode: 'NCC-E2E', items: [{ itemCode: item, uomCode: 'CAI', quantity: '10', unitPrice: '10000' }] } });
  expect(nhap.ok(), await nhap.text()).toBeTruthy();
  expect((await request.post(`/api/vouchers/${(await nhap.json()).id}/post`, { data: {} })).ok()).toBeTruthy();
  const bh = await request.post('/api/invoices', { data: { voucherType: 'BH', postingDate: '2026-08-10', documentDate: '2026-08-10', partyCode: 'KH-E2E', autoPost: true,
    items: [{ itemCode: item, uomCode: 'CAI', warehouseCode: 'KHO-E2E', quantity: '4', unitPrice: '40000', amountCurrency: '160000', taxCodes: ['V10'] }],
    invoice: { serial: 'C26TBB', invoiceNo: String(Date.now()).slice(-8), invoiceDate: '2026-08-10', invoiceGroupCode: '10' } } });
  expect(bh.ok(), await bh.text()).toBeTruthy();

  const prefs = page.waitForResponse((r) => r.url().includes('/api/prefs/') && r.url().includes('sales-reports'));
  await page.goto('/ban-hang/bao-cao'); await prefs;
  await expect(page.getByRole('heading', { name: 'Báo cáo bán hàng' })).toBeVisible();
  const range = page.locator('.ant-picker-range input');
  await range.nth(0).fill('01/08/2026'); await page.keyboard.press('Enter');
  await range.nth(1).fill('31/08/2026'); await page.keyboard.press('Enter');
  await page.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: 'Nhóm theo' }) }).click(); await page.locator('.ant-select-item-option', { hasText: 'Theo mặt hàng' }).click();
  await page.getByRole('combobox', { name: 'Mã hàng' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type(item);
  await page.locator('.ant-select-item-option', { hasText: item }).first().click();

  const row = page.locator('.ag-center-cols-container .ag-row', { hasText: item });
  await expect(row).toBeVisible();
  await expect(row).toContainText('160.000'); await expect(row).toContainText('40.000'); await expect(row).toContainText('120.000');
  await expect(page.getByText(/chưa tính giá vốn/)).toBeVisible();

  await page.goto('/mua-hang/bao-cao');
  await expect(page.getByRole('heading', { name: 'Báo cáo mua hàng' })).toBeVisible();
});
