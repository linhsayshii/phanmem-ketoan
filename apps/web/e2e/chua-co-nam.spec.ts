import { expect, test } from '@playwright/test';

// Công ty chưa có năm tài chính (công ty riêng, không bao giờ tạo năm trong spec này nên chạy lại được):
//   pnpm -F @kt/api cli create-admin --username e2enoyear --password Matkhau1! --tenant-code E2ENOYEAR --tenant-name "Công ty E2E chưa có năm"

test('Công ty chưa có năm tài chính: các màn cần chọn năm giải thích vì sao trống và chỉ vào Kỳ kế toán', async ({ page, request }) => {
  expect((await request.post('/api/auth/login', { data: { username: 'e2enoyear', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  expect(await (await request.get('/api/fiscal-years')).json(), 'công ty e2enoyear không được có năm tài chính').toHaveLength(0);
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2enoyear'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);

  for (const [path, heading] of [['/phan-tich', 'Phân tích tài chính'], ['/so-cai/ton-kho-dau-ky', 'Tồn kho đầu kỳ'], ['/gia-thanh/tinh-gia-thanh', 'Tính giá thành']] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.getByTestId('no-fiscal-year')).toContainText('Công ty chưa có năm tài chính');
  }

  await page.goto('/so-cai/so-du-dau-ky');
  await expect(page.getByRole('heading', { level: 1, name: 'Số dư đầu kỳ' })).toBeVisible();
  await expect(page.getByTestId('no-fiscal-year')).toContainText('Vào Kỳ kế toán');
  await expect(page.getByRole('button', { name: 'Lưu' })).toBeDisabled();
  await page.getByTestId('no-fiscal-year').getByRole('button', { name: 'Thêm năm tài chính' }).click();

  await expect(page).toHaveURL(/\/so-cai\/ky-ke-toan/);
  await expect(page.getByRole('heading', { level: 1, name: 'Kỳ kế toán' })).toBeVisible();
  await expect(page.getByTestId('no-fiscal-year')).toContainText('Công ty chưa có năm tài chính');
  await page.getByTestId('no-fiscal-year').getByRole('button', { name: 'Thêm năm tài chính' }).click();
  await expect(page.getByRole('dialog', { name: 'Thêm năm tài chính' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Thêm năm tài chính' })).toBeHidden();
});
