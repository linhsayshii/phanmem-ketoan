import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  await request.post('/api/catalogs/uom', { data: { code: 'CAI', name: 'Cái' } }); // trùng mã từ lần chạy trước thì bỏ qua
  await request.post('/api/catalogs/item', { data: { code: 'HANG-BG', name: 'Hàng bảng giá E2E', base_uom_code: 'CAI' } });
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Bảng giá: thêm bảng giá bán và dòng giá bậc số lượng', async ({ page, request }) => {
  await signIn(page, request);
  const code = `BG${Date.now().toString(36).toUpperCase()}`;
  await page.goto('/kho/bang-gia');
  await expect(page.getByRole('heading', { name: 'Bảng giá' })).toBeVisible();
  await page.keyboard.press('Insert');
  await page.getByLabel('Mã bảng giá').fill(code);
  await page.getByLabel('Tên bảng giá').fill('Bảng giá bán thử');
  const row = '.ag-center-cols-container .ag-row[row-index="0"]';
  await page.locator(`${row} [col-id="itemCode"]`).dblclick(); await page.keyboard.type('HANG-BG'); await page.keyboard.press('Enter');
  await page.keyboard.type('CAI'); await page.keyboard.press('Enter');
  await page.keyboard.type('10'); await page.keyboard.press('Enter');
  await page.keyboard.type('90000'); await page.keyboard.press('Enter');
  await expect(page.locator(`${row} [col-id="price"]`)).toHaveText('90.000');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu bảng giá')).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(code) })).toBeVisible();

  const hit = await request.get('/api/price-lists/resolve?kind=sale&itemCode=HANG-BG&uomCode=CAI&date=2099-01-01&qty=10');
  expect(await hit.json()).toMatchObject({ price: '90000.0000' });
  expect(await (await request.get('/api/price-lists/resolve?kind=sale&itemCode=HANG-BG&uomCode=CAI&date=2099-01-01&qty=9')).json()).toMatchObject({ price: null });
});
