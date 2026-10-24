import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"
// Dữ liệu trong spec chỉ để minh họa, không phải tham số pháp lý.

async function login(request: APIRequestContext, username: string) {
  const r = await request.post('/api/auth/login', { data: { username, password: 'Matkhau1!' } });
  expect(r.ok()).toBeTruthy();
}
async function signIn(page: Page, request: APIRequestContext, username = 'e2e') {
  await login(request, username);
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill(username); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('hồ sơ lương: lưu bằng Ctrl+S, người phụ thuộc, lịch sử lương, phân bổ chi phí', async ({ page, request }) => {
  const sfx = String(Date.now()).slice(-8);
  await login(request, 'e2e');
  const emp = await request.post('/api/catalogs/employee', { data: { code: `NV${sfx}`, name: `Lê Văn Hồ Sơ ${sfx}` } });
  expect(emp.ok(), await emp.text()).toBeTruthy();
  const empId = Number((await emp.json()).id);
  expect((await request.post('/api/catalogs/project', { data: { code: `VV${sfx}`, name: `Vụ việc ${sfx}` } })).ok()).toBeTruthy();

  await signIn(page, request);
  await page.goto('/luong/ho-so');
  await expect(page.getByRole('heading', { name: 'Hồ sơ lương' })).toBeVisible();
  await page.getByLabel('Tìm nhân viên').fill(`NV${sfx}`); await page.keyboard.press('Enter');
  await page.getByTestId('employee-list').getByText(`NV${sfx}`).click();
  await expect(page.getByText('Chưa có hồ sơ lương').first()).toBeVisible();

  // Tab 1: nhập số tài khoản, mã BHXH, tick tham gia BHXH rồi Ctrl+S
  await page.getByLabel('Số tài khoản nhận lương').fill('0011001234567');
  await page.getByLabel('Mã số BHXH').fill('0123456789');
  await page.getByLabel('Tham gia BHXH').check();
  await page.getByLabel('Mã số BHXH').press('Control+s');
  await expect(page.getByText('Đã lưu hồ sơ lương')).toBeVisible();
  const saved = await (await request.get(`/api/payroll/profiles/${empId}`)).json();
  expect(saved.profile).toMatchObject({ bankAccountNo: '0011001234567', siNo: '0123456789', siParticipates: true, hiParticipates: false });

  // Phụ cấp
  await page.getByRole('button', { name: 'Thêm phụ cấp' }).click();
  await page.getByLabel('Mã phụ cấp').fill('an_trua'); await page.getByLabel('Tên phụ cấp').fill('Phụ cấp ăn trưa');
  await page.getByLabel('Số tiền phụ cấp').fill('730000');
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByTestId('allowances').getByText('Phụ cấp ăn trưa')).toBeVisible();

  // Người phụ thuộc: thêm một người, rồi thêm trùng khoảng thời gian thì báo lỗi trong hộp thoại
  await page.getByRole('tab', { name: 'Người phụ thuộc' }).click();
  const addDependent = async (name: string) => {
    await page.getByRole('button', { name: 'Thêm người phụ thuộc' }).click();
    await page.getByLabel('Họ tên').fill(name); await page.getByLabel('MST').fill('8000000001');
    await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  };
  await addDependent('Lê Thị Con');
  await expect(page.getByTestId('dependents').getByText('Lê Thị Con')).toBeVisible();
  await addDependent('Lê Thị Con');
  await expect(page.locator('.ant-modal .ant-alert-error')).toBeVisible();
  await page.getByRole('button', { name: 'Bỏ qua' }).click();
  await expect(page.getByTestId('dependents').locator('tbody tr.ant-table-row')).toHaveCount(1);

  // Lịch sử lương
  await page.getByRole('tab', { name: 'Lịch sử lương' }).click();
  await expect(page.getByTestId('current-salary')).toHaveText('Chưa có');
  await page.getByRole('button', { name: 'Thêm mức lương' }).click();
  await page.getByLabel('Lương cơ bản').fill('15000000');
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByTestId('current-salary')).toHaveText('15.000.000');

  // Phân bổ chi phí: một dòng 100% rồi Ctrl+S
  await page.getByRole('tab', { name: 'Phân bổ chi phí' }).click();
  await page.getByRole('button', { name: 'Thêm dòng' }).click();
  await page.getByRole('combobox', { name: 'Vụ việc' }).focus(); await page.keyboard.press('F4');
  await page.keyboard.type(`VV${sfx}`);
  await page.locator('.ant-select-item-option', { hasText: new RegExp(`VV${sfx}`) }).click();
  await page.getByLabel('Tỷ lệ').fill('100');
  await expect(page.getByTestId('split-total')).toContainText('100');
  await page.getByLabel('Tỷ lệ').press('Control+s');
  await expect(page.getByText('Đã lưu phân bổ chi phí')).toBeVisible();

  const after = await (await request.get(`/api/payroll/profiles/${empId}`)).json();
  expect(after.allowances).toHaveLength(1); expect(after.dependents).toHaveLength(1);
  expect(after.currentSalary).toBe('15000000'); expect(after.costSplit).toHaveLength(1);
});

test('người dùng không có cờ xem lương: không thấy mục Hồ sơ lương, trang báo không có quyền, API trả 403', async ({ request, browser, baseURL }) => {
  await login(request, 'e2e');
  const username = `nl${String(Date.now()).slice(-8)}`;
  const made = await request.post('/api/users', { data: { username, fullName: 'Không xem lương', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: [] } });
  expect(made.ok(), await made.text()).toBeTruthy();

  const ctx = await browser.newContext({ baseURL: baseURL!, locale: 'vi-VN' });
  const p2 = await ctx.newPage();
  await signIn(p2, ctx.request, username);
  await expect(p2.getByRole('link', { name: 'Hồ sơ lương' })).toHaveCount(0);
  await p2.goto('/luong/ho-so');
  await expect(p2.getByText('Không có quyền xem lương').first()).toBeVisible();
  expect((await ctx.request.get('/api/payroll/profiles')).status()).toBe(403);
  await ctx.close();
});
