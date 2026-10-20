import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

// Đăng nhập bằng API (để có năm tài chính) rồi bằng giao diện (để trang có phiên)
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('in Nhật ký chung ra PDF từ màn hình sổ sách', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/bao-cao/so-sach');
  await expect(page.getByRole('heading', { name: 'Sổ sách kế toán' })).toBeVisible();
  // Chromium chạy ngầm không có trình xem PDF: tab mở bằng window.open nhận PDF như một lần tải về (sự kiện nằm ở trang mở nó, tab mới có địa chỉ trống và không bao giờ có sự kiện load).
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'In PDF' }).first().click()]);
  const url = download.url();
  expect(url).toContain('format=pdf');
  const res = await request.get(url);
  expect(res.headers()['content-type']).toBe('application/pdf');
});

test('in cả bộ sổ năm ra Excel từ hộp thoại và tải về', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/bao-cao/so-sach');
  await page.getByRole('button', { name: /In cả bộ sổ năm/ }).click();
  const dialog = page.getByRole('dialog', { name: 'In cả bộ sổ năm' });
  await expect(dialog.getByText(/^Năm \d{4}/)).toBeVisible(); // năm tài chính đã tải xong
  await dialog.getByText('Excel', { exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'In', exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/^bo-so-\d{4}\.xlsx$/);
});
