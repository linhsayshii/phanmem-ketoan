import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Danh mục đối tượng: thêm, ngưng dùng, lọc', async ({ page, request }) => {
  await signIn(page, request);
  // bộ lọc nhớ phía máy chủ còn "Ngưng dùng" từ lần chạy trước: đặt lại về mặc định
  expect((await request.put('/api/prefs/filter:catalog:party', { data: { value: { q: '', active: 'true' } } })).ok()).toBeTruthy();
  const code = `DM${Date.now().toString(36).toUpperCase()}`; // mã duy nhất mỗi lần chạy
  await page.goto('/danh-muc/party');
  await expect(page.getByRole('heading', { name: 'Đối tượng' })).toBeVisible();
  await page.keyboard.press('Insert');
  await page.getByLabel('Mã', { exact: true }).fill(code);
  await page.getByLabel('Tên đối tượng').fill('Đối tượng thử Danh mục');
  await page.getByRole('button', { name: 'Đồng ý' }).click();
  await expect(page.getByText('Đã lưu')).toBeVisible();

  await page.getByPlaceholder('Tìm mã, tên…').fill(code); await page.keyboard.press('Enter');
  const row = page.locator('.ag-row', { hasText: code });
  await expect(row).toBeVisible();
  await expect(page.locator('.ag-center-cols-container .ag-row')).toHaveCount(1); // chờ lưới lọc xong: tìm theo mã nên còn đúng một dòng
  await page.getByRole('button', { name: 'Ngưng dùng' }).click();
  await expect(page.getByText('Đã ngưng dùng')).toBeVisible();
  await expect(row).toHaveCount(0); // bộ lọc mặc định "Đang dùng" ẩn dòng vừa ngưng

  await page.getByRole('combobox', { name: 'Trạng thái' }).click({ force: true }); await page.locator('.ant-select-item-option', { hasText: 'Ngưng dùng' }).click();
  await expect(page.locator('.ag-row', { hasText: code })).toBeVisible();
});
