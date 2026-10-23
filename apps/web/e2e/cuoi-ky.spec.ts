import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Quy trình cuối kỳ: chạy bước, F9 chạy bước kế tiếp, bỏ qua bước tùy chọn', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/so-cai/cuoi-ky');
  await expect(page.getByRole('heading', { name: 'Quy trình cuối kỳ' })).toBeVisible();
  const rows = page.getByTestId('close-steps');
  await expect(rows.locator('tbody tr')).toHaveCount(10);

  // Chạy riêng bước đầu: dòng chuyển sang "Đã chạy"
  const tool = rows.locator('tr', { hasText: 'Phân bổ công cụ dụng cụ' });
  await tool.getByRole('button', { name: /^Chạy/ }).click();
  await expect(tool).toContainText('Đã chạy');

  // Đánh giá lại ngoại tệ là bước tùy chọn: bỏ qua được
  const fx = rows.locator('tr', { hasText: 'Đánh giá lại ngoại tệ' });
  if (await fx.getByRole('button', { name: 'Bỏ qua' }).count()) {
    await fx.getByRole('button', { name: 'Bỏ qua' }).click();
    await page.locator('.ant-popover').getByRole('button', { name: 'Bỏ qua' }).click();
    await expect(fx).toContainText('Đã bỏ qua');
  }

  // F9 chạy bước kế tiếp (nếu còn)
  const nextBtn = page.getByRole('button', { name: /Chạy bước tiếp theo/ });
  if (await nextBtn.isEnabled().catch(() => false)) {
    await page.keyboard.press('F9');
    await expect(page.getByText('Đã chạy bước').first()).toBeVisible();
  }
});
