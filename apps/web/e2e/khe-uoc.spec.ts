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

test('Khế ước vay: tạo khế ước, sinh lịch đều, giải ngân, xem sổ theo dõi', async ({ page, request }) => {
  await signIn(page, request);
  const stamp = Date.now(); const code = `KU${stamp}`; const accountNo = `98${String(stamp).slice(-9)}`;
  await request.post('/api/catalogs/bank', { data: { code: 'VCB', name: 'Vietcombank' } });
  const created = await request.post('/api/catalogs/bank_account', { data: { bank_code: 'VCB', account_no: accountNo, account_name: `E2E ${stamp}`, gl_account_code: '1121' } });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto('/khe-uoc');
  await expect(page.getByRole('heading', { name: 'Khế ước vay' })).toBeVisible();
  await page.getByRole('button', { name: /Thêm/ }).click();
  const dr = page.getByRole('dialog').first();
  await dr.getByLabel('Số khế ước').fill(code); await dr.getByLabel('Tên', { exact: true }).fill(`Vay ngắn hạn ${stamp}`);
  await dr.getByLabel('Hạn mức').fill('1000000000');

  // Lịch trả gốc: sinh đều 4 kỳ x 3 tháng, tổng 1 tỷ
  await dr.getByRole('tab', { name: 'Lịch trả gốc' }).click();
  await dr.getByRole('button', { name: 'Sinh lịch đều' }).click();
  const gen = page.getByRole('dialog', { name: 'Sinh lịch trả gốc đều' });
  await gen.getByLabel('Số kỳ').fill('4'); await gen.getByLabel('Chu kỳ tháng').fill('3'); await gen.getByLabel('Tổng gốc').fill('1000000000');
  await gen.getByRole('button', { name: 'Sinh lịch' }).click();
  await expect(dr.getByTestId('schedule-total')).toContainText('1.000.000.000');

  await dr.getByRole('tab', { name: 'Điều khoản' }).click();
  await dr.getByLabel('Số khế ước').press('Control+s');
  await expect(page.getByText('Đã lưu khế ước')).toBeVisible();

  // Giải ngân 500.000.000
  await dr.getByRole('tab', { name: 'Chứng từ' }).click();
  await dr.getByRole('button', { name: 'Giải ngân', exact: true }).click();
  const ev = page.getByRole('dialog', { name: /Giải ngân khế ước/ });
  await ev.getByLabel('Số tiền giải ngân').fill('500000000');
  await ev.getByLabel('Tài khoản ngân hàng (F4)').fill(accountNo); await page.locator('.ant-select-item-option', { hasText: accountNo }).first().click();
  await ev.getByRole('button', { name: 'Giải ngân', exact: true }).click();
  await expect(ev.getByTestId('loan-action-result')).toContainText('Đã lập');
  await ev.getByRole('button', { name: 'Đóng' }).click();
  await expect(dr.getByTestId('loan-outstanding')).toContainText('500.000.000');

  // Sổ theo dõi khế ước vay
  await page.locator('.ant-drawer-close').click(); await expect(page.locator('.ant-drawer-content')).toBeHidden();
  await page.getByRole('tab', { name: 'Sổ theo dõi khế ước vay' }).click();
  await expect(page.getByTestId('loan-report').locator('tr', { hasText: code })).toContainText('500.000.000');
});
