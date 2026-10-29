import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

interface Dist { id: string; tax_code_code: string; document_type: string; account_code: string | null; report_tag: string | null }

test('Phân bổ thuế: tìm phân bổ TNCN khấu trừ tại nguồn 3335, sửa nhãn báo cáo rồi lưu', async ({ page, request }) => {
  await signIn(page, request);
  const list = async () => (await (await request.get('/api/catalogs/tax_distribution?q=3335')).json()).rows as Dist[];
  const row = (await list()).find((d) => d.tax_code_code === 'TNCN_KT' && d.document_type === 'invoice')!;
  expect(row, 'công ty E2E thiếu phân bổ mặc định TNCN_KT → 3335').toBeTruthy();
  const tag = `pit_withheld_${Date.now()}`;
  // bộ lọc nhớ còn q=3335 từ lần chạy trước thì Enter không gửi lại yêu cầu tìm: đưa về mặc định trước khi mở trang
  expect((await request.put(`/api/prefs/${encodeURIComponent('filter:catalog:tax_distribution')}`, { data: { value: { q: '', active: 'true' } } })).ok()).toBeTruthy();
  try {
    await page.goto('/danh-muc/tax_distribution');
    await expect(page.getByRole('heading', { name: 'Phân bổ thuế' })).toBeVisible();
    // chờ kết quả tìm về: đọc row-index khi lưới còn danh sách chưa lọc thì nút Sửa ở vùng ghim không còn đúng dòng
    const searched = page.waitForResponse((r) => r.url().includes('/api/catalogs/tax_distribution') && r.url().includes('q=3335'));
    await page.getByPlaceholder('Tìm mã, tên…').fill('3335'); await page.keyboard.press('Enter'); await searched;
    const gridRow = page.locator('.ag-center-cols-container .ag-row', { hasText: 'Hóa đơn' }).filter({ hasText: 'TNCN_KT' });
    await expect(gridRow).toHaveCount(1);
    await expect(gridRow).toContainText('-100,0000');
    // cột thao tác ghim phải: nút Sửa nằm ở vùng ghim, cùng row-index
    await page.locator(`.ag-pinned-right-cols-container .ag-row[row-index="${await gridRow.getAttribute('row-index')}"]`).getByRole('button', { name: 'Sửa' }).click();
    await expect(page.getByText('Sửa phân bổ thuế')).toBeVisible();
    await page.getByLabel('Nhãn báo cáo').fill(tag);
    await page.locator('.ant-modal-footer .ant-btn-primary').click();
    await expect(page.locator('.ant-message').getByText('Đã lưu')).toBeVisible();
    expect((await list()).find((d) => d.id === row.id)).toMatchObject({ account_code: '3335', report_tag: tag });
  } finally {
    // trả nhãn về như trước để lần chạy sau và các spec khác thấy dữ liệu mặc định
    expect((await request.put(`/api/catalogs/tax_distribution/${row.id}`, { data: { report_tag: row.report_tag } })).ok()).toBeTruthy();
  }
});
