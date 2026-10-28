import { expect, test } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

test('Tổng quan: hàng số liệu, biểu đồ theo tháng, việc cần làm, lập nhanh chứng từ', async ({ page, request }) => {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  let years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) {
    expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
    years = [{ fiscalYear: 2026 }];
  }
  const date = `${years[0].fiscalYear}-01-20`;
  expect((await request.post('/api/vouchers', { data: { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Thu tổng quan E2E', autoPost: true,
    lines: [{ accountCode: '1111', debit: '10000000' }, { accountCode: '5113', credit: '10000000' }] } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tổng quan' })).toBeVisible();
  await expect(page.getByText('Tiền cuối tháng')).toBeVisible();
  await expect(page.getByTestId('chart-dashboard').locator('svg')).toBeVisible();
  await expect(page.getByText('Việc cần làm')).toBeVisible();
  await page.getByRole('button', { name: 'Lập chứng từ' }).click();
  await page.getByRole('menuitem', { name: 'Phiếu thu' }).click();
  await expect(page).toHaveURL(/\/chung-tu\/PT\/moi/);
});
