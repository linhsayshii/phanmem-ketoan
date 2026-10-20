import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

// Đăng nhập bằng API (để có năm tài chính và đối tượng) rồi bằng giao diện (để trang có phiên)
async function signIn(page: Page, request: APIRequestContext) {
  const login = await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } });
  expect(login.ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await request.post('/api/catalogs/party', { data: { code: 'KH-E2E', name: 'Khách hàng E2E' } }); // đã có từ lần chạy trước thì máy chủ từ chối trùng mã, bỏ qua

  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('lập Phiếu thu bằng bàn phím, ghi sổ F9', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/chung-tu/PT');
  await expect(page.getByRole('heading', { name: 'Phiếu thu' })).toBeVisible(); // phím tắt Insert chỉ có tác dụng sau khi trang đã dựng xong
  await page.keyboard.press('Insert');
  await expect(page.getByText('Phiếu thu (mới)')).toBeVisible();
  await page.getByLabel('Ngày hạch toán').fill('15/01/2026'); await page.keyboard.press('Enter');
  await page.getByLabel('Người nộp tiền').fill('Nguyễn Văn A');
  await page.getByLabel('Lý do nộp').fill('Thu tiền hàng tháng 1');

  // Mục đích: mũi tên xuống mở danh sách, Enter chọn mục đầu (Thu tiền khách hàng) và điền sẵn TK 131 vào dòng 2
  await page.getByLabel('Mục đích').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.locator('.ag-center-cols-container [col-id="accountCode"]', { hasText: '131' })).toBeVisible(); // hasText: lưới có thể giữ tạm dòng trống cũ cạnh dòng mới nên không chọn theo row-index
  // Đối tượng: F4 mở danh sách, chọn khách hàng
  await page.getByLabel('Đối tượng').focus(); await page.keyboard.press('F4');
  await page.locator('.ant-select-item-option', { hasText: /KH-E2E/ }).click(); // role=option của antd là bản ẩn dành cho trình đọc màn hình

  // dòng 1 là TK 1111 điền sẵn: nhập số tiền ở Nợ, dòng 131 tự lấy cùng số tiền ở Có
  await page.locator('.ag-center-cols-container .ag-row[row-index="0"] [col-id="debit"]').click();
  await page.keyboard.type('5000000'); await page.keyboard.press('Enter');
  await expect(page.getByText('Tổng Nợ: 5.000.000')).toBeVisible();
  await expect(page.getByText('Tổng Có: 5.000.000')).toBeVisible();

  await page.keyboard.press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu')).toBeVisible();
  await expect(page).toHaveURL(/PT\/[0-9a-f-]{36}$/);
  // chờ chứng từ tải xong rồi mới bấm F9: trang vừa dựng lại, lưới còn dòng khởi tạo tới khi GET trả về
  await expect(page.locator('.ag-center-cols-container [col-id="accountCode"]', { hasText: '131' })).toBeVisible();
  await page.keyboard.press('F9');
  await expect(page.locator('.ant-message').getByText('Đã ghi sổ')).toBeVisible();
  await expect(page.locator('.ant-card-head-title')).toContainText(/PT\d+/);
  await expect(page.getByRole('button', { name: 'Đảo' })).toBeVisible();
});
