import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phieu-thu.spec.ts (tài khoản e2e có quyền api_key.manage).
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Khóa API: tạo khóa, chỉ thấy khóa đầy đủ một lần, gọi API ngoài, thu hồi', async ({ page, request }) => {
  await signIn(page, request);
  const name = `POS e2e ${String(Date.now()).slice(-8)}`;
  await page.goto('/he-thong/khoa-api');
  await expect(page.getByRole('heading', { name: 'Khóa API' })).toBeVisible();
  await page.getByRole('button', { name: 'Tạo khóa API' }).click();
  const add = page.getByRole('dialog', { name: 'Tạo khóa API' });
  await add.getByLabel('Tên khóa').fill(name);
  await add.getByRole('button', { name: 'Tạo khóa' }).click();

  const shown = page.getByRole('dialog', { name: 'Khóa API mới' });
  const key = await shown.getByLabel('Khóa API').inputValue();
  expect(key).toMatch(/^kt_[0-9a-f]{12}_[0-9a-f]{64}$/);
  await shown.getByRole('button', { name: 'Đã lưu, đóng' }).click();

  // Danh sách chỉ còn tiền tố, không còn khóa đầy đủ.
  const row = page.getByRole('row', { name: new RegExp(name) });
  await expect(row).toContainText(`kt_${key.split('_')[1]}`);
  await expect(row).toContainText('Hoạt động');
  await expect(page.getByText(key)).toHaveCount(0);

  // Khóa dùng được ở API ngoài (Bearer, không cookie phiên).
  const ok = await request.get('/api/ext/v1/items', { headers: { authorization: `Bearer ${key}`, cookie: '' } });
  expect(ok.status()).toBe(200);

  await row.getByRole('button', { name: `Thu hồi ${name}` }).click();
  await page.getByRole('button', { name: 'Thu hồi', exact: true }).last().click();
  await expect(row).toContainText('Đã thu hồi');

  const denied = await request.get('/api/ext/v1/items', { headers: { authorization: `Bearer ${key}`, cookie: '' } });
  expect(denied.status()).toBe(401);
});
