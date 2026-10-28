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

test('sửa tên tiếng Anh của tài khoản rồi in Bảng cân đối số phát sinh song ngữ', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/he-thong/ten-tieng-anh');
  await expect(page.getByRole('heading', { name: 'Tên tiếng Anh' })).toBeVisible();
  await expect(page.getByText('Bản dịch tham khảo, không phải bản dịch chính thức').first()).toBeVisible();
  const box = page.getByLabel('Tên tiếng Anh 1111');
  await expect(box).toBeVisible();
  const en = `Cash in VND ${Date.now()}`; await box.fill(en);
  await page.getByRole('button', { name: /^Lưu \(1\)/ }).click();
  await expect(page.getByText('Đã lưu 1 dòng')).toBeVisible();
  const list = await (await request.get('/api/translations/accounts?regime=TT133')).json() as { code: string; nameEn: string | null; status: string | null }[];
  expect(list.find((a) => a.code === '1111')).toMatchObject({ nameEn: en, status: 'draft' });

  // bản in song ngữ: chọn ngôn ngữ ở màn hình Sổ sách rồi In PDF (tab mở ra nhận như một lần tải)
  await page.goto('/bao-cao/so-sach');
  await page.getByRole('tab', { name: /Bảng cân đối/ }).click();
  await page.locator('div[aria-label="Ngôn ngữ bản in"]').click();
  await page.getByTitle('Song ngữ Việt – Anh').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'In PDF' }).first().click()]);
  expect(download.url()).toContain('lang=vi-en');
  const html = await request.get(download.url().replace('format=pdf', 'format=html'));
  const body = await html.text();
  expect(body).toContain('Tên tài khoản / Account name'); expect(body).toContain('Reference translation only');
});

test('Báo cáo tài chính chọn ngôn ngữ in và tên chỉ tiêu tiếng Anh', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/bao-cao/bao-cao-tai-chinh');
  await expect(page.getByRole('heading', { name: 'Báo cáo tài chính' })).toBeVisible();
  await page.locator('div[aria-label="Ngôn ngữ bản in"]').click();
  await page.getByTitle('English').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'In PDF' }).click()]);
  expect(download.url()).toContain('lang=en');
  await page.goto('/he-thong/ten-tieng-anh');
  await page.getByRole('tab', { name: 'Chỉ tiêu báo cáo' }).click();
  await expect(page.getByLabel('Tên tiếng Anh 200')).toHaveValue(/TOTAL ASSETS/);
});
