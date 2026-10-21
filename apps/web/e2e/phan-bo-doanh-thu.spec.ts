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

test('Phân bổ doanh thu nhận trước: thêm lịch 2 kỳ, chạy kỳ 11, thấy chứng từ PB; lịch đã chạy không xóa được', async ({ page, request }) => {
  await signIn(page, request);
  // Cách ly: mỗi lần một lịch riêng (diễn giải có dấu thời gian), bắt đầu kỳ 11/2026. Chạy kỳ 11 chỉ sinh chứng từ cho lịch chưa có chứng từ,
  // lịch của các lần chạy trước (đã có chứng từ, không đổi) chỉ được đếm là "không đổi", nên không phình dữ liệu dùng chung.
  const stamp = Date.now(); const desc = `Phân bổ E2E ${stamp}`;
  await page.goto('/so-cai/phan-bo');
  await expect(page.getByRole('heading', { name: 'Phân bổ doanh thu nhận trước' })).toBeVisible();

  await page.getByRole('button', { name: 'Thêm lịch' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Tổng số tiền').fill('1200001');
  await dlg.getByLabel('Số kỳ').fill('2');
  await expect(dlg.locator('.ant-form-item', { hasText: 'Năm bắt đầu' })).toContainText('Năm 2026'); // mặc định là năm tài chính hiện tại
  await dlg.locator('.ant-form-item', { hasText: 'Kỳ bắt đầu' }).locator('.ant-select').click();
  await page.locator('.ant-select-item-option', { hasText: 'Kỳ 11' }).click();
  await dlg.getByLabel('Diễn giải').fill(desc);
  await expect(dlg.getByText('Mỗi kỳ 600.000, kỳ cuối 600.001.')).toBeVisible();
  await dlg.getByLabel('Diễn giải').press('Enter'); // Enter trong ô nhập lưu hộp thoại
  const row = page.locator('.ant-table-row', { hasText: desc });
  await expect(row).toContainText('1.200.001'); await expect(row).toContainText('11/2026');

  // Chạy kỳ 11: lịch mới sinh chứng từ PB
  await page.getByRole('combobox', { name: 'Kỳ kế toán' }).click();
  await page.locator('.ant-select-item-option', { hasText: 'Kỳ 11 (' }).click();
  await page.getByRole('button', { name: 'Chạy phân bổ kỳ' }).click();
  await expect(page.getByText(/Đã phân bổ kỳ 11\/2026/)).toBeVisible();
  await expect(page.locator('.ant-alert-success a[href^="/chung-tu/PB/"]').first()).toBeVisible();

  // Mở dòng chi tiết: kỳ 1 đã có chứng từ, kỳ 2 chưa; lịch đã bắt đầu thì nút Xóa bị khóa
  await row.locator('.ant-table-row-expand-icon').click();
  const lines = page.locator('.ant-table-expanded-row');
  await expect(lines.locator('a[href^="/chung-tu/PB/"]')).toHaveCount(1);
  await expect(lines).toContainText('Chưa phân bổ');
  await expect(row.getByRole('button', { name: 'Xóa' })).toBeDisabled();

  // Chạy lại cùng kỳ: không đổi, không sinh thêm chứng từ
  await page.getByRole('button', { name: 'Chạy phân bổ kỳ' }).click();
  await expect(page.getByText(/Không có khoản phân bổ mới ở kỳ 11\/2026/)).toBeVisible();
});

test('Phân bổ doanh thu nhận trước: mở từ hóa đơn thì điền sẵn tài khoản, số tiền, diễn giải', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/so-cai/phan-bo?from=3387&to=5113&total=500000&description=T%E1%BB%AB%20h%C3%B3a%20%C4%91%C6%A1n');
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel('Tổng số tiền')).toHaveValue('500.000');
  await expect(dlg.getByLabel('Diễn giải')).toHaveValue('Từ hóa đơn');
});
