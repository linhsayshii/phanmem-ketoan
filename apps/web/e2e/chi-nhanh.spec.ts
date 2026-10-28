import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phieu-thu.spec.ts (tài khoản e2e quản trị công ty E2E).
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

const pick = async (page: Page, label: string, code: string) => {
  await page.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: label, exact: true }) }).click();
  await page.locator('.ant-select-item-option', { hasText: `${code} – ` }).click();
};

test('Chi nhánh: thêm chi nhánh, chọn chi nhánh làm việc, lọc sổ theo chi nhánh, BCTC tổng hợp', async ({ page, request }) => {
  await signIn(page, request);
  const code = `CN${String(Date.now()).slice(-6)}`;
  await page.goto('/chi-nhanh');
  await expect(page.getByRole('heading', { name: 'Chi nhánh' })).toBeVisible();
  await page.keyboard.press('Insert');
  const dlg = page.getByRole('dialog', { name: 'Thêm chi nhánh' });
  await dlg.getByLabel('Mã chi nhánh').fill(code);
  await dlg.getByLabel('Tên chi nhánh').fill(`Chi nhánh ${code}`);
  await dlg.getByLabel('MST đơn vị trực thuộc').fill('0101234567-001');
  await dlg.getByLabel('Tên chi nhánh').press('Control+s');
  await expect(page.getByRole('row', { name: new RegExp(code) })).toContainText('0101234567-001');

  // Chi nhánh làm việc: chứng từ mới thuộc chi nhánh này.
  await page.getByRole('tab', { name: 'Chi nhánh làm việc' }).click();
  await pick(page, 'Chi nhánh làm việc', code);
  await expect(page.getByText('Đã đổi chi nhánh làm việc')).toBeVisible();
  const desc = `Doanh thu ${code}`; const today = new Date().toISOString().slice(0, 10); // Sổ sách mặc định xem tháng hiện tại
  const v = await request.post('/api/vouchers', { data: { voucherType: 'PKT', postingDate: today, documentDate: today, description: desc, autoPost: true,
    lines: [{ accountCode: '1111', debit: '1234000' }, { accountCode: '5113', credit: '1234000' }] } });
  expect(v.ok(), await v.text()).toBeTruthy();
  const id = (await v.json()).id as string;
  expect((await (await request.get(`/api/vouchers/${id}/branch`)).json()).branch).not.toBe('HO');
  expect((await request.put('/api/me/branch', { data: { branch: 'HO' } })).ok()).toBeTruthy();

  // Sổ sách lọc theo chi nhánh: Nhật ký chung chỉ có chứng từ của chi nhánh.
  await page.goto('/bao-cao/so-sach');
  await pick(page, 'Chi nhánh', code);
  await expect(page.getByText(desc).first()).toBeVisible();
  await expect(page.getByText(/Tổng phát sinh/)).toContainText('1.234.000');

  // BCTC tổng hợp: cột chi nhánh, cột tổng hợp.
  await page.goto('/chi-nhanh');
  await page.getByRole('tab', { name: 'BCTC tổng hợp' }).click();
  await expect(page.getByRole('columnheader', { name: code })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Loại trừ nội bộ' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Tổng hợp' })).toBeVisible();
});
