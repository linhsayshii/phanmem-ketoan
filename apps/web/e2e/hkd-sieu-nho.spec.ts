import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Chế độ kế toán: TT 152 và TT 58 hiện cảnh báo chờ văn bản gốc và danh sách văn bản cần cung cấp', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/he-thong/che-do-ke-toan');
  await expect(page.getByRole('heading', { name: 'Chế độ kế toán' })).toBeVisible();
  const row = page.getByRole('row', { name: /TT152/ });
  await expect(row.getByText('Chưa dùng cho kế toán thật')).toBeVisible();
  await expect(page.getByRole('row', { name: /TT133/ }).getByText('Dùng được')).toBeVisible();
  await row.locator('.ant-table-row-expand-icon').click();
  await expect(page.getByText('Chưa có văn bản gốc, chưa dùng cho kế toán thật')).toBeVisible();
  await expect(page.getByText('Văn bản cần cung cấp')).toBeVisible();
  await expect(page.getByText(/Mẫu tờ khai 01\/CNKD/)).toBeVisible();
  await expect(page.getByText('S2c-HKD: Sổ chi tiết doanh thu, chi phí')).toBeVisible();
});
