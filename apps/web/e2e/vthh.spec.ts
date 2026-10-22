import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  for (const c of [{ code: 'CAI', name: 'Cái' }, { code: 'THUNG', name: 'Thùng' }]) await request.post('/api/catalogs/uom', { data: c }); // trùng mã từ lần chạy trước thì bỏ qua
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Vật tư hàng hóa: thêm hàng, thêm ĐVT quy đổi THUNG = 24', async ({ page, request }) => {
  await signIn(page, request);
  const code = `VT${Date.now().toString(36).toUpperCase()}`;
  await page.goto('/kho/vat-tu');
  await expect(page.getByRole('heading', { name: 'Vật tư hàng hóa' })).toBeVisible();
  await page.keyboard.press('Insert');
  await page.getByLabel('Mã', { exact: true }).fill(code);
  await page.getByLabel('Tên vật tư hàng hóa').fill('Nước suối thử');
  await page.getByLabel('ĐVT cơ sở').focus(); await page.keyboard.press('F4'); await page.keyboard.type('CAI');
  await page.locator('.ant-select-item-option', { hasText: /CAI/ }).click();
  await page.getByRole('button', { name: 'Đồng ý' }).click();
  await expect(page.getByText('Đã lưu')).toBeVisible();

  await page.getByPlaceholder('Tìm mã, tên, mã vạch…').fill(code); await page.keyboard.press('Enter');
  await expect(page.locator('.ag-row', { hasText: code })).toBeVisible();
  await page.getByRole('button', { name: 'Sửa' }).click(); // tìm theo mã nên còn đúng một dòng
  await page.getByRole('tab', { name: 'ĐVT quy đổi' }).click();
  await expect(page.getByRole('cell', { name: /CAI/ })).toBeVisible(); // dòng ĐVT cơ sở tự có
  await page.getByRole('combobox', { name: 'Chọn ĐVT' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type('THUNG');
  await page.locator('.ant-select-item-option', { hasText: /THUNG/ }).click();
  await page.getByLabel('Hệ số quy đổi').fill('24');
  await page.getByRole('button', { name: 'Thêm ĐVT' }).click();
  await expect(page.getByRole('cell', { name: /THUNG/ })).toBeVisible();
});
