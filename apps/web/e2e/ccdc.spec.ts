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

test('Công cụ dụng cụ: ghi tăng rồi ghi giảm một phần số lượng', async ({ page, request }) => {
  await signIn(page, request);
  const stamp = Date.now(); const code = `CC${stamp}`;
  // Thẻ CCDC 10 cái, phân bổ 6422 (tạo bằng API để kiểm thử tập trung vào ghi tăng, ghi giảm)
  const card = await request.post('/api/assets', { data: { code, name: `Dụng cụ ${stamp}`, kind: 'tool', assetAccountCode: '242', depreciationStartDate: '2026-02-01', lifeUnits: 12, quantity: '10' } });
  expect(card.ok()).toBeTruthy();
  const id = (await card.json()).id as number;
  expect((await request.put(`/api/assets/${id}/allocations`, { data: { validFromYear: 2026, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', ratio: '100' }] } })).ok()).toBeTruthy();

  await page.goto('/tai-san/ccdc');
  await expect(page.getByRole('heading', { name: 'Công cụ dụng cụ' })).toBeVisible();
  await page.locator('.ant-table-row', { hasText: code }).click();
  const dr = page.getByRole('dialog').first();
  await dr.getByRole('tab', { name: 'Biến động và chứng từ' }).click();

  await dr.getByRole('button', { name: 'Ghi tăng', exact: true }).click();
  let ev = page.getByRole('dialog', { name: /Ghi tăng/ });
  await ev.locator('.ant-form-item', { hasText: 'Lý do ghi tăng' }).locator('.ant-select').click(); await page.locator('.ant-select-item-option', { hasText: 'Khác' }).click();
  await ev.getByLabel('TK đối ứng (Có, F4)').fill('1111'); await page.locator('.ant-select-item-option', { hasText: /^1111/ }).first().click();
  await ev.getByLabel('Giá trị ghi tăng').fill('12000000');
  await ev.getByRole('button', { name: /Lưu/ }).click();
  await expect(ev.getByTestId('event-result')).toBeVisible();
  await ev.getByRole('button', { name: 'Đóng' }).click();

  // Ghi giảm 4 trên 10 cái
  await dr.getByRole('button', { name: 'Ghi giảm', exact: true }).click();
  ev = page.getByRole('dialog', { name: /Ghi giảm/ });
  await ev.getByLabel('TK đối ứng (F4)').fill('811'); await page.locator('.ant-select-item-option', { hasText: /^811/ }).first().click();
  await ev.getByLabel('Số lượng ghi giảm').fill('4');
  await ev.getByRole('button', { name: /Lưu/ }).click();
  await expect(ev.getByTestId('event-result')).toContainText('Đã ghi nhận ghi giảm'); await expect(ev.getByTestId('event-result')).toContainText('Giá trị ghi giảm: 4.800.000');
  await ev.getByRole('button', { name: 'Đóng' }).click();
  await expect(dr.getByTestId('events-table')).toContainText('Ghi giảm');

  // Ghi giảm quá số lượng còn lại: lỗi API hiện nguyên văn
  await dr.getByRole('button', { name: 'Ghi giảm', exact: true }).click();
  ev = page.getByRole('dialog', { name: /Ghi giảm/ });
  await ev.getByLabel('TK đối ứng (F4)').fill('811'); await page.locator('.ant-select-item-option', { hasText: /^811/ }).first().click();
  await ev.getByLabel('Số lượng ghi giảm').fill('7');
  await ev.getByRole('button', { name: /Lưu/ }).click();
  await expect(ev.locator('.ant-alert-error')).toContainText('lớn hơn số lượng còn lại');
});
