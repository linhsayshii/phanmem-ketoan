import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phieu-thu.spec.ts (tài khoản e2e là quản trị công ty).
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Công ty: bật rồi tắt công tắc tra cứu MST người bán, lưu và tải lại vẫn giữ', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/he-thong/cong-ty');
  await page.getByRole('tab', { name: 'Tùy chọn hệ thống' }).click();
  const sw = page.getByRole('switch', { name: 'Tra cứu MST người bán khi nhận hóa đơn đầu vào' });
  await expect(sw).not.toBeChecked();
  await sw.click();
  await page.getByRole('button', { name: 'Lưu' }).last().click();
  await expect(page.getByText('Đã lưu').last()).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Tùy chọn hệ thống' }).click();
  await expect(sw).toBeChecked();
  await sw.click(); // trả về mặc định tắt
  await page.getByRole('button', { name: 'Lưu' }).last().click();
  await expect(page.getByText('Đã lưu').last()).toBeVisible();
});
