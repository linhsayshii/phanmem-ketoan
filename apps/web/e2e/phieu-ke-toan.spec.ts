import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

// Đăng nhập bằng API (để có năm tài chính) rồi bằng giao diện (để trang có phiên)
async function signIn(page: Page, request: APIRequestContext) {
  const login = await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } });
  expect(login.ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();

  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/); // chờ đăng nhập xong rồi mới điều hướng, nếu không yêu cầu đăng nhập bị hủy giữa chừng
}

test('nhập phiếu kế toán hoàn toàn bằng bàn phím rồi ghi sổ', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/chung-tu/phieu-ke-toan');
  await expect(page.getByRole('heading', { name: 'Phiếu kế toán' })).toBeVisible(); // phím tắt Insert chỉ có tác dụng sau khi trang đã dựng xong
  await page.keyboard.press('Insert');
  await expect(page.getByText('Phiếu kế toán (mới)')).toBeVisible();
  await page.getByLabel('Ngày hạch toán').fill('15/01/2026'); await page.keyboard.press('Enter');
  await page.getByLabel('Diễn giải').fill('Chi văn phòng phẩm tháng 1');

  const firstCell = page.locator('.ag-center-cols-container .ag-row[row-index="0"] [col-id="accountCode"]');
  await firstCell.click(); await page.keyboard.type('6422'); await page.keyboard.press('Enter');
  await page.keyboard.type('Giấy A4'); await page.keyboard.press('Enter');
  await page.keyboard.type('1500000'); await page.keyboard.press('Enter'); // Nợ
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); // Có, đối tượng, bộ phận, vụ việc, khoản mục -> sang dòng 2
  await page.keyboard.type('1111'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); // TK, diễn giải, Nợ
  await page.keyboard.type('1500000'); await page.keyboard.press('Enter'); // Có
  await expect(page.getByText('Tổng Nợ: 1.500.000')).toBeVisible();
  await expect(page.getByText('Tổng Có: 1.500.000')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu')).toBeVisible(); // thông báo nổi; nhãn trạng thái "Đã ghi sổ" cũng nằm trên trang nên không tìm theo chữ trần
  await expect(page).toHaveURL(/phieu-ke-toan\/[0-9a-f-]{36}$/);
  await expect(page.locator('.ant-card-head-title')).toContainText('(chưa cấp số)'); // chờ trang chứng từ đã lưu dựng xong rồi mới bấm F9
  await page.keyboard.press('F9');
  await expect(page.locator('.ant-message').getByText('Đã ghi sổ')).toBeVisible();
  await expect(page.locator('.ant-card-head-title')).toContainText(/PKT\d+/);
});

test('Ctrl+S khi con trỏ còn trong ô đang gõ vẫn lưu số vừa gõ; Enter ở danh sách mở chứng từ', async ({ page, request }) => {
  await signIn(page, request);
  const marker = `PW-${Date.now()}`;
  // bộ lọc danh sách (lưu theo người dùng) trỏ tới đúng chứng từ này
  expect((await request.put('/api/prefs/filter%3Avouchers%3APKT', { data: { value: { from: '2026-01-01', to: '2026-12-31', state: '', q: marker } } })).ok()).toBeTruthy();
  await page.goto('/chung-tu/phieu-ke-toan/moi');
  await page.getByLabel('Ngày hạch toán').fill('16/01/2026'); await page.keyboard.press('Enter');
  await page.getByLabel('Diễn giải').fill(marker);

  await page.locator('.ag-center-cols-container .ag-row[row-index="0"] [col-id="accountCode"]').click();
  await page.keyboard.type('6422'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); // TK -> diễn giải -> Nợ
  await page.keyboard.type('2000'); await page.keyboard.press('Enter'); // Nợ -> Có
  for (let i = 0; i < 5; i++) await page.keyboard.press('Enter'); // Có, đối tượng, bộ phận, vụ việc, khoản mục -> dòng 2
  await page.keyboard.type('1111'); for (let i = 0; i < 3; i++) await page.keyboard.press('Enter'); // TK, diễn giải, Nợ -> Có
  await page.keyboard.type('2000'); // không Enter: ô còn đang sửa khi bấm Ctrl+S
  await page.keyboard.press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu')).toBeVisible();
  await expect(page).toHaveURL(/phieu-ke-toan\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').at(-1)!;
  const saved = await (await request.get(`/api/vouchers/${id}`)).json();
  expect(saved.lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit])).toEqual([['6422', '2000', '0'], ['1111', '0', '2000']]);

  await page.goto('/chung-tu/phieu-ke-toan');
  const row = page.locator('.ag-row', { hasText: marker });
  await expect(row).toBeVisible();
  await row.locator('[col-id="description"]').click();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`phieu-ke-toan/${id}$`));
});
