import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phieu-thu.spec.ts (tài khoản e2e).
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await request.post('/api/catalogs/uom', { data: { code: 'CAI', name: 'Cái' } }); // trùng mã từ lần chạy trước thì bỏ qua
  await request.post('/api/catalogs/party', { data: { code: 'KH-E2E', name: 'Khách hàng E2E', is_customer: true } });
  await request.post('/api/catalogs/item', { data: { code: 'HANG-BH', name: 'Hàng bán E2E', base_uom_code: 'CAI', kind: 'goods', revenue_account_code: '5111' } });
  await request.post('/api/catalogs/warehouse', { data: { code: 'KHO-E2E', name: 'Kho E2E', inventory_account_code: '156', costing_method: 'avg_moving' } });
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Báo giá: lập bằng bàn phím, chuyển một phần thành Bán hàng nháp', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/don-hang/bao-gia');
  await expect(page.getByRole('heading', { name: 'Báo giá' })).toBeVisible();
  await page.keyboard.press('Insert');
  await page.getByRole('combobox', { name: 'Đối tượng' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type('KH-E2E');
  await page.locator('.ant-select-item-option', { hasText: 'KH-E2E' }).click();
  const cell = (col: string) => page.locator('.ag-center-cols-container .ag-row[row-index="0"] [col-id="' + col + '"]');
  const fill = async (col: string, text: string) => { await cell(col).dblclick(); await page.keyboard.type(text); await page.keyboard.press('Tab'); };
  await fill('itemCode', 'HANG-BH'); await fill('uomCode', 'CAI'); await fill('warehouseCode', 'KHO-E2E'); await fill('quantity', '100'); await fill('unitPrice', '40000');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu đơn')).toBeVisible();
  const row = page.getByRole('row', { name: /BG-\d{4}-\d{4}/ }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Lập BH nháp' }).click();
  await page.getByLabel('Số lượng dòng 1').fill('40');
  await page.getByRole('button', { name: 'Lập chứng từ' }).click();
  await expect(page).toHaveURL(/\/chung-tu\/BH\/[0-9a-f-]{36}/);
  await page.goto('/don-hang/bao-gia');
  await expect(page.getByRole('row', { name: /BG-\d{4}-\d{4}/ }).first().getByText('Chuyển một phần')).toBeVisible();
});
