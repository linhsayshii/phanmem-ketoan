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

test('Ký số: thêm hồ sơ giả lập, ký tờ khai GTGT đã chốt và tải XML có chữ ký', async ({ page, request }) => {
  await signIn(page, request);
  expect((await request.put('/api/settings', { data: { vat_period: 'month' } })).ok()).toBeTruthy();
  expect((await request.put('/api/company', { data: { taxCode: '0100109106' } })).ok()).toBeTruthy();

  await page.goto('/thue/ky-so');
  await expect(page.getByRole('heading', { name: 'Cài đặt ký số' })).toBeVisible();
  const profiles = (await (await request.get('/api/signing/profiles')).json()) as unknown[];
  if (!profiles.length) { // hồ sơ giả lập trùng chứng thư nên chỉ thêm một lần cho mỗi người dùng
    await page.getByRole('button', { name: /Thêm hồ sơ/ }).click();
    const dlg = page.getByRole('dialog');
    await dlg.locator('.ant-select', { has: page.getByRole('combobox', { name: 'Hình thức ký' }) }).click(); await page.locator('.ant-select-item-option', { hasText: 'Giả lập' }).click();
    await dlg.getByLabel('Tên hồ sơ').fill('Khóa thử E2E');
    await dlg.getByRole('button', { name: /Lưu/ }).click();
  }
  await expect(page.locator('.ant-table-row').first()).toBeVisible();
  await expect(page.getByText('Mặc định', { exact: true }).first()).toBeVisible();

  const prefs = page.waitForResponse((r) => r.url().includes('/api/prefs/') && r.url().includes('vat-return'));
  await page.goto('/thue/to-khai-gtgt'); await prefs;
  await expect(page.getByRole('heading', { name: 'Tờ khai thuế GTGT' })).toBeVisible();
  await page.getByLabel('Năm').fill('2026'); await page.keyboard.press('Tab');
  await page.locator('.ant-select', { has: page.getByRole('combobox', { name: 'Kỳ' }) }).click(); await page.locator('.ant-select-item-option', { hasText: /^Tháng 9$/ }).click();
  const calc = page.getByRole('button', { name: 'Tính tờ khai' }); const supp = page.getByRole('button', { name: 'Lập bổ sung' }); const recalc = page.getByRole('button', { name: /Tính lại/ });
  const sign = page.getByRole('button', { name: 'Ký và tải XML' });
  await expect(calc.or(supp).or(recalc).or(sign).first()).toBeVisible();
  if (!(await sign.isVisible())) { if (await calc.isVisible()) await calc.click(); else await supp.click(); }
  await expect(sign).toBeVisible();
  if (await sign.isDisabled()) { // bản nháp: chốt trước khi ký
    await page.getByRole('button', { name: 'Chốt', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Chốt', exact: true }).click();
    // Có hóa đơn 8% chưa có chỉ tiêu trong mẫu: cổng pháp lý đòi xác nhận rõ trước khi chốt.
    const ack = page.getByRole('button', { name: 'Xác nhận và chốt' });
    if (await ack.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ack.click();
    await expect(sign).toBeEnabled();
  }
  const download = page.waitForEvent('download');
  await sign.click();
  // XML 01/GTGT chưa kiểm chứng với HTKK: ký cần xác nhận rõ ràng.
  const still = page.getByRole('button', { name: 'Vẫn ký' });
  if (await still.waitFor({ timeout: 5000 }).then(() => true, () => false)) await still.click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^01GTGT_0100109106_T9-2026(-BS\d+)?_signed\.xml$/);
  const xml = await readFile((await file.path())!, 'utf8');
  expect(xml).toContain('<ds:Signature'); expect(xml).toContain('<ds:X509Certificate>'); expect(xml).toContain('xades:SigningTime');
});
