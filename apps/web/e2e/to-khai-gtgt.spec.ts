import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Tờ khai GTGT tháng 8/2026: tính, nhập [37], chốt, xuất XML, cảnh báo chưa kiểm chứng hiện trước khi tải', async ({ page, request }) => {
  await signIn(page, request);
  // Dữ liệu E2E dùng chung giữa các lần chạy: kỳ tháng 8/2026 đã chốt ở lần trước thì lần này lập bổ sung.
  expect((await request.put('/api/settings', { data: { vat_period: 'month' } })).ok()).toBeTruthy();
  expect((await request.put('/api/company', { data: { taxCode: '0100109106' } })).ok()).toBeTruthy();

  const prefs = page.waitForResponse((r) => r.url().includes('/api/prefs/') && r.url().includes('vat-return'));
  await page.goto('/thue/to-khai-gtgt'); await prefs;
  await expect(page.getByRole('heading', { name: 'Tờ khai thuế GTGT' })).toBeVisible();
  await page.getByLabel('Năm').fill('2026'); await page.keyboard.press('Tab');
  await page.locator('.ant-select', { has: page.getByRole('combobox', { name: 'Kỳ' }) }).click(); await page.locator('.ant-select-item-option', { hasText: /^Tháng 8$/ }).click();

  const calc = page.getByRole('button', { name: 'Tính tờ khai' }); const supp = page.getByRole('button', { name: 'Lập bổ sung' });
  const recalc = page.getByRole('button', { name: /Tính lại/ });
  await expect(calc.or(supp).or(recalc)).toBeVisible();
  // Lần chạy trước hỏng giữa chừng có thể để lại bản nháp của kỳ: dùng luôn bản nháp đó.
  if (await calc.isVisible()) await calc.click(); else if (await supp.isVisible()) await supp.click();

  // [37] nhập tay sửa được; [36] tính từ công thức nên chỉ đọc
  const c37 = page.getByRole('textbox', { name: 'Chỉ tiêu 37' });
  await expect(c37).toBeEditable();
  await expect(page.getByRole('textbox', { name: 'Chỉ tiêu 36' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Xuất XML' })).toBeDisabled();
  await c37.fill('1500000'); await page.keyboard.press('Tab');
  await page.getByRole('button', { name: /Tính lại/ }).click();
  await expect(page.getByRole('textbox', { name: 'Chỉ tiêu 37' })).toHaveValue('1.500.000');

  await page.getByRole('button', { name: 'Chốt', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Chốt', exact: true }).click();
  await expect(page.getByText('Đã chốt', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Chỉ tiêu 37' })).toHaveCount(0); // đã chốt: khóa ô

  await expect(page.getByText('XML chưa kiểm chứng với HTKK').first()).toBeVisible(); // cảnh báo hiện trước khi tải
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất XML' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^01GTGT_0100109106_T8-2026(-BS\d+)?\.xml$/);
  const xml = await readFile((await file.path())!, 'utf8');
  expect(xml).toContain('0100109106'); expect(xml).toContain('1500000');
});
