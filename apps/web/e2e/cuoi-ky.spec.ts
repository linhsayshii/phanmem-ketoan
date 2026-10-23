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

test('Quy trình cuối kỳ: chạy bước, bỏ qua bước tùy chọn, F9 chạy bước kế tiếp', async ({ page, request }) => {
  await signIn(page, request);
  // Chọn kỳ chưa có nhật ký (mỗi lần chạy dùng một kỳ của năm cuối); hết kỳ trống thì bỏ qua có ghi chú, không chạy rỗng.
  const years = await (await request.get('/api/fiscal-years')).json() as { fiscalYear: number }[];
  const year = years.at(-1)!.fiscalYear;
  let period = 0;
  for (let p = 1; p <= 12 && !period; p++) {
    const st = await (await request.get(`/api/period-close/${year}/${p}`)).json() as { steps: { key: string; status: string }[] };
    if (st.steps.every((x) => x.status === 'pending')) period = p;
  }
  test.skip(!period, 'Mọi kỳ của năm cuối đã có nhật ký: cần cơ sở dữ liệu e2e mới');
  await page.goto('/so-cai/cuoi-ky');
  await expect(page.getByRole('heading', { name: 'Quy trình cuối kỳ' })).toBeVisible();
  await page.locator('.ant-select', { has: page.getByRole('combobox', { name: 'Chọn kỳ' }) }).click();
  await page.getByTitle(`Tháng ${period}`, { exact: true }).click();
  const rows = page.getByTestId('close-steps');
  await expect(rows.locator('tbody tr')).toHaveCount(10);
  const tool = rows.locator('tr', { hasText: 'Phân bổ công cụ dụng cụ' });
  await expect(tool).toContainText('Chưa chạy');
  await expect(page.getByRole('button', { name: /Chạy bước tiếp theo.*Phân bổ công cụ dụng cụ/ })).toBeVisible();

  // Chạy riêng bước đầu: dòng chuyển sang "Đã chạy"
  await tool.getByRole('button', { name: 'Chạy', exact: true }).click();
  await expect(tool).toContainText('Đã chạy');

  // Đánh giá lại ngoại tệ là bước tùy chọn, chưa chạy: bỏ qua được
  const fx = rows.locator('tr', { hasText: 'Đánh giá lại ngoại tệ' });
  await fx.getByRole('button', { name: 'Bỏ qua' }).click();
  await page.locator('.ant-popover').getByRole('button', { name: 'Bỏ qua' }).click();
  await expect(fx).toContainText('Đã bỏ qua');

  // F9 chạy bước kế tiếp: Chi phí trả trước
  const prepaid = rows.locator('tr', { hasText: 'Phân bổ chi phí trả trước' });
  await expect(prepaid).toContainText('Chưa chạy');
  await page.keyboard.press('F9');
  await expect(prepaid).toContainText('Đã chạy');
});
