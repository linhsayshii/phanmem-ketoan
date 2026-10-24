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

test('Thuế TNDN: tạm tính quý 1/2026, lập chứng từ chi phí thuế nháp; tờ khai 03/TNDN năm 2026 nhập điều chỉnh tăng, chốt', async ({ page, request }) => {
  await signIn(page, request);
  expect((await request.put('/api/company', { data: { taxCode: '0100109106' } })).ok()).toBeTruthy();
  // Doanh thu quý 1 để lợi nhuận lũy kế dương (dữ liệu E2E dùng chung giữa các lần chạy: số cộng dồn, không ảnh hưởng luồng).
  const v = await request.post('/api/vouchers', { data: { voucherType: 'PKT', postingDate: '2026-03-15', documentDate: '2026-03-15', description: 'Doanh thu E2E thuế TNDN', autoPost: true,
    lines: [{ accountCode: '1111', debit: '500000000', credit: '0' }, { accountCode: '5113', debit: '0', credit: '500000000' }] } });
  expect(v.ok(), await v.text()).toBeTruthy();

  // Tạm tính quý
  const prefs = page.waitForResponse((r) => r.url().includes('/api/prefs/') && r.url().includes('cit-estimate'));
  await page.goto('/thue/tam-tinh-tndn'); await prefs;
  await expect(page.getByRole('heading', { name: 'Tạm tính thuế TNDN quý' })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Năm' }).fill('2026'); await page.keyboard.press('Tab');
  await page.locator('.ant-select', { has: page.getByRole('combobox', { name: 'Quý' }) }).click(); await page.locator('.ant-select-item-option', { hasText: /^Quý 1$/ }).click();
  await expect(page.getByTestId('cit-profit')).not.toHaveText('');
  // Công ty E2E chưa có doanh thu năm trước theo sổ: nhập thuế suất rồi F9 để tính
  await page.getByRole('textbox', { name: 'Thuế suất' }).fill('20'); await page.keyboard.press('F9');
  await expect(page.getByTestId('cit-rate')).toHaveText('20');
  await expect(page.getByTestId('cit-payable')).not.toHaveText('');
  await expect(page.getByTestId('cit-payable')).not.toHaveText('0');
  await expect(page.getByTestId('cit-accrue')).not.toHaveText(/^0?$/); // chứng từ ghi chi phí thuế cần ghi thêm, không phải số phải nộp
  await page.getByRole('button', { name: 'Lập chứng từ chi phí thuế TNDN' }).click();
  const done = page.getByText('Đã lập phiếu kế toán nháp');
  await expect(done).toBeVisible();
  await expect(done.getByRole('link')).toHaveAttribute('href', /\/chung-tu\/PKT\//);

  // Tờ khai quyết toán 03/TNDN năm 2026
  const prefs2 = page.waitForResponse((r) => r.url().includes('/api/prefs/') && r.url().includes('cit-return'));
  await page.goto('/thue/quyet-toan-tndn'); await prefs2;
  await expect(page.getByRole('heading', { name: 'Quyết toán thuế TNDN (03/TNDN)' })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Năm' }).fill('2026'); await page.keyboard.press('Tab');
  const calc = page.getByRole('button', { name: 'Tính tờ khai' }); const supp = page.getByRole('button', { name: 'Lập bổ sung' });
  const recalc = page.getByRole('button', { name: /Tính lại/ });
  await expect(calc.or(supp).or(recalc)).toBeVisible();
  // Năm 2026 đã chốt ở lần chạy trước thì lập bổ sung; lần trước hỏng giữa chừng để lại nháp thì dùng luôn.
  if (await calc.isVisible()) await calc.click(); else if (await supp.isVisible()) await supp.click();

  const b4 = page.getByRole('textbox', { name: 'Chỉ tiêu B4', exact: true });
  await expect(b4).toBeEditable();
  await expect(page.getByRole('textbox', { name: 'Chỉ tiêu B1', exact: true })).toHaveCount(0); // B1 là công thức của mẫu: chỉ đọc
  await expect(page.getByRole('button', { name: 'Xuất XML' })).toBeDisabled();
  await b4.fill('10000000'); await page.keyboard.press('Enter'); // Enter sang ô nhập kế tiếp
  await page.getByRole('textbox', { name: 'Chỉ tiêu C7a', exact: true }).fill('20');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('textbox', { name: 'Chỉ tiêu B4', exact: true })).toHaveValue('10.000.000');
  await expect(page.getByRole('row').filter({ has: page.getByText('[B1]', { exact: true }) })).toContainText('10.000.000');

  await page.getByRole('button', { name: 'Chốt', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Chốt', exact: true }).click();
  await expect(page.getByText('Đã chốt', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Chỉ tiêu B4', exact: true })).toHaveCount(0);
  await expect(page.getByText('XML chưa kiểm chứng với HTKK').first()).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất XML' }).click();
  expect((await download).suggestedFilename()).toMatch(/^03TNDN_0100109106_N2026(-BS\d+)?\.xml$/);
});
