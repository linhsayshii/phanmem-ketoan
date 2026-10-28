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
const pickF4 = async (page: Page, combo: string, code: string | RegExp, typed = String(code)) => {
  await page.getByRole('combobox', { name: combo }).focus(); await page.keyboard.press('F4'); await page.keyboard.type(typed);
  await page.locator('.ant-select-item-option', { hasText: code }).first().click();
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0); // chờ dropdown đóng: antd trả tiêu điểm về ô vừa chọn sau hiệu ứng đóng
};

test('Hợp đồng bán: nhập hợp đồng và đợt thanh toán bằng bàn phím, lập hóa đơn từ đợt, theo dõi đã lập hóa đơn', async ({ page, request }) => {
  await signIn(page, request);
  const stamp = Date.now(); const party = `KHHDG${stamp}`; const code = `HDG${stamp}`; const invoiceNo = String(stamp).slice(-8);
  const made = await request.post('/api/catalogs/party', { data: { code: party, name: `Khách hợp đồng ${stamp}`, is_customer: true } });
  expect(made.ok(), await made.text()).toBeTruthy();

  await page.goto('/hop-dong');
  await expect(page.getByRole('heading', { name: 'Hợp đồng' })).toBeVisible();
  await page.keyboard.press('Insert');
  const dr = page.getByRole('dialog').first();
  await dr.getByLabel('Số hợp đồng').fill(code); await dr.getByLabel('Tên hợp đồng').fill(`Tư vấn năm 2026 ${stamp}`);
  await pickF4(page, 'Đối tác', party);
  await dr.getByLabel('Giá trị hợp đồng').fill('100000000');
  await pickF4(page, 'TK mặc định', /^5113/, '5113');
  await pickF4(page, 'Thuế GTGT mặc định', /^V10/, 'V10');

  // Đợt thanh toán: 30% tạm ứng (số tiền tính khi lưu), 70% nghiệm thu nhập số tiền
  await dr.getByRole('tab', { name: 'Đợt thanh toán' }).click();
  const cell = (row: number, col: string) => dr.locator(`.ag-center-cols-container .ag-row[row-index="${row}"] [col-id="${col}"]`);
  await cell(0, 'description').click(); await page.keyboard.type('Tạm ứng'); await page.keyboard.press('Enter');
  await page.keyboard.type('31/03/2026'); await page.keyboard.press('Enter');
  await page.keyboard.type('30'); await page.keyboard.press('Enter');
  for (let i = 0; i < 2; i++) await page.keyboard.press('Enter'); // qua Số tiền, Thuế: Enter ở ô sửa được cuối dòng thêm dòng mới
  await cell(1, 'description').click(); await page.keyboard.type('Nghiệm thu'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  await page.keyboard.type('70000000'); await page.keyboard.press('Enter');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Đã lưu hợp đồng')).toBeVisible();
  const table = dr.getByTestId('milestone-table');
  await expect(table.locator('tr', { hasText: 'Tạm ứng' })).toContainText('30.000.000');
  await expect(table.locator('tr', { hasText: 'Nghiệm thu' })).toContainText('70.000.000');
  await expect(dr.getByTestId('contract-summary')).toContainText('Đã lập hóa đơn: 0');

  // Lập hóa đơn từ đợt 1
  await table.locator('tr', { hasText: 'Tạm ứng' }).getByRole('button', { name: 'Lập hóa đơn từ đợt' }).click();
  const dlg = page.getByRole('dialog', { name: /Lập hóa đơn từ đợt 1/ });
  await pickF4(page, 'Nhóm kê khai', /^10/, '10');
  await dlg.getByLabel('Số hóa đơn').fill(invoiceNo);
  await dlg.getByRole('button', { name: 'Lập hóa đơn', exact: true }).click();
  await expect(dlg.getByTestId('milestone-invoice-result')).toContainText('Đã lập hóa đơn bán dịch vụ nháp');
  await dlg.getByRole('button', { name: 'Đóng' }).click();
  await expect(table.locator('tr', { hasText: 'Tạm ứng' })).toContainText('Đã lập hóa đơn');
  await expect(table.locator('tr', { hasText: 'Nghiệm thu' })).toContainText('Chưa lập hóa đơn');
  await expect(dr.getByTestId('contract-summary')).toContainText('Đã lập hóa đơn: 30.000.000');

  // Hóa đơn nháp mang hợp đồng, tiền hàng 30.000.000, thuế 10%
  await table.locator('tr', { hasText: 'Tạm ứng' }).getByRole('link').click();
  await expect(page.locator('.ant-form-item', { hasText: 'Hợp đồng (F4)' })).toContainText(code);
  await expect(page.getByText(/Tiền thuế:/)).toContainText('3.000.000');

  // Danh sách hợp đồng: cột đã/chưa lập hóa đơn
  await page.goto('/hop-dong');
  const row = page.getByTestId('contracts-table').locator('tr', { hasText: code });
  await expect(row).toContainText('30.000.000'); await expect(row).toContainText('70.000.000'); await expect(row).toContainText('1/2');
});
