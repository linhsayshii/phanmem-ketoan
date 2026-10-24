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

test('chấm công: gõ X, N, giờ, làm thêm, Ctrl+S lưu, ô sai mã bị chặn', async ({ page, request }) => {
  const sfx = String(Date.now()).slice(-8);
  await login(request, 'e2e');
  const dep = await request.post('/api/catalogs/department', { data: { code: `BP${sfx}`, name: `Bộ phận chấm công ${sfx}` } });
  expect(dep.ok(), await dep.text()).toBeTruthy();
  const depId = Number((await dep.json()).id);
  const emp = await request.post('/api/catalogs/employee', { data: { code: `NV${sfx}`, name: `Phạm Văn Công ${sfx}`, department_code: `BP${sfx}` } });
  expect(emp.ok(), await emp.text()).toBeTruthy();
  const empId = Number((await emp.json()).id);
  expect((await request.put('/api/settings', { data: { payroll_standard_hours_per_day: '8' } })).ok()).toBeTruthy();
  const now = new Date(); const year = now.getFullYear(), month = now.getMonth() + 1;
  // Bộ lọc nhớ của màn hình: đúng tháng này và bộ phận vừa tạo (lưới chỉ có một nhân viên)
  expect((await request.put('/api/prefs/' + encodeURIComponent('filter:attendance'), { data: { value: { year, month, departmentCode: `BP${sfx}`, departmentId: depId } } })).ok()).toBeTruthy();

  await signIn(page, request);
  await page.goto('/luong/cham-cong');
  await expect(page.getByRole('heading', { name: 'Bảng chấm công' })).toBeVisible();
  const grid = page.getByTestId('attendance-grid');
  await expect(grid.getByText(`NV${sfx}`)).toBeVisible();
  const cellOf = (day: number) => grid.locator(`.ag-center-cols-container [row-index="0"] [col-id="d${day}"]`);

  // Ngày 2: X; ngày 3: 4 giờ; ngày 4: X + làm thêm 2 giờ ngày thường; ngày 5: N. Enter chuyển sang ô kế bên phải.
  await cellOf(2).click();
  await page.keyboard.type('x'); await page.keyboard.press('Enter');
  await page.keyboard.type('4'); await page.keyboard.press('Enter');
  await page.keyboard.type('x t2'); await page.keyboard.press('Enter');
  await page.keyboard.type('n'); await page.keyboard.press('Enter');
  // Ngày 6 gõ mã sai: ô tô đỏ, Ctrl+S báo lỗi và không lưu gì
  await page.keyboard.type('z'); await page.keyboard.press('Enter');
  await page.keyboard.press('Control+s');
  await expect(page.getByText(/ô chưa hợp lệ/)).toBeVisible();
  expect((await (await request.get(`/api/attendance?year=${year}&month=${month}&departmentId=${depId}`)).json()).entries).toHaveLength(0);

  // Sửa ô sai thành P (nghỉ phép) rồi lưu bằng Ctrl+S ngay khi đang sửa ô
  await cellOf(6).click();
  await page.keyboard.press('Control+a'); await page.keyboard.type('p');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Đã lưu chấm công 5 ô')).toBeVisible();

  const summary = await (await request.get(`/api/attendance/summary?year=${year}&month=${month}`)).json();
  const row = summary.employees.find((e: { employeeId: number }) => e.employeeId === empId);
  expect(row).toMatchObject({ workDays: '3', paidLeave: '1', otWeekdayHours: '2', otRestHours: '0', otHolidayHours: '0' });

  // Tải lại: ô hiện đúng mã đã lưu và tổng công 3
  await page.reload();
  await expect(cellOf(2)).toHaveText('X'); await expect(cellOf(3)).toHaveText('4'); await expect(cellOf(4)).toHaveText('X T2'); await expect(cellOf(5)).toHaveText('N'); await expect(cellOf(6)).toHaveText('P');
  await expect(grid.locator('.ag-pinned-right-cols-container [row-index="0"] [col-id="total"]')).toHaveText('3');
});
