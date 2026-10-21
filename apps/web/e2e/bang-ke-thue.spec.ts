import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

// Đăng nhập bằng API (để có năm tài chính) rồi bằng giao diện (để trang có phiên)
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Bảng kê hóa đơn: hóa đơn mua vào có trong bảng kê tháng 12, cộng nhóm, đối chiếu thuế với sổ cái', async ({ page, request }) => {
  await signIn(page, request);
  // Dữ liệu E2E dùng chung giữa các lần chạy: mỗi lần một nhà cung cấp và một số hóa đơn riêng, ngày tháng 12.
  const stamp = Date.now(); const day = String(2 + (Math.floor(stamp / 1000) % 27)).padStart(2, '0'); const iso = `2026-12-${day}`;
  const code = `NCCBK${stamp}`; const name = `Nhà cung cấp bảng kê ${stamp}`; const invoiceNo = String(stamp).slice(-8);
  const made = await request.post('/api/catalogs/party', { data: { code, name, is_vendor: true, tax_code: '0312345678' } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const inv = await request.post('/api/invoices', { data: { voucherType: 'HDM', postingDate: iso, documentDate: iso, partyCode: code, autoPost: true,
    items: [{ description: 'Dịch vụ mua vào', accountCode: '6422', amountCurrency: '10000000', taxCodes: ['V10'] }],
    invoice: { serial: 'C26TAA', invoiceNo, invoiceDate: iso, invoiceGroupCode: '01' } } });
  expect(inv.ok(), await inv.text()).toBeTruthy();

  // Bộ lọc nhớ nạp từ máy chủ sau khi trang mở và ghi đè ô vừa chọn: chờ bản nạp xong rồi mới chọn kỳ.
  const prefs = page.waitForResponse((r) => r.url().includes('/api/prefs/') && r.url().includes('tax-register'));
  await page.goto('/thue/bang-ke-hoa-don'); await prefs;
  await expect(page.getByRole('heading', { name: 'Bảng kê hóa đơn' })).toBeVisible();
  await page.getByLabel('Năm').fill('2026'); await page.keyboard.press('Tab');
  await page.locator('.ant-select', { has: page.getByRole('combobox', { name: 'Kỳ' }) }).click(); await page.locator('.ant-select-item-option', { hasText: /^(Tháng 12|Quý 4)$/ }).click();

  const row = page.locator('.ag-center-cols-container .ag-row', { hasText: invoiceNo });
  await expect(row).toBeVisible();
  await expect(row).toContainText(name); await expect(row).toContainText('0312345678'); await expect(row).toContainText('10.000.000'); await expect(row).toContainText('1.000.000'); await expect(row).toContainText('10%');
  await expect(page.locator('.ag-center-cols-container .ag-row', { hasText: 'Cộng nhóm 01' })).toBeVisible();
  await expect(page.locator('.ag-center-cols-container .ag-row', { hasText: 'Tổng cộng' })).toBeVisible();

  // Bán ra không có hóa đơn mua vào này
  await page.getByRole('tab', { name: 'Bán ra' }).click();
  await expect(page.locator('.ag-center-cols-container .ag-row', { hasText: invoiceNo })).toHaveCount(0);

  // Đối chiếu: hóa đơn HDM tự sinh bút toán thuế nên không thể là chứng từ lệch
  await page.getByRole('tab', { name: 'Đối chiếu' }).click();
  await expect(page.getByText(/Phát sinh Nợ TK 1331/)).toBeVisible();
  await expect(page.locator('.ag-center-cols-container .ag-row', { hasText: invoiceNo })).toHaveCount(0);

  // Menu "Thuế" dẫn tới màn này
  await page.goto('/');
  await page.getByRole('menuitem', { name: 'Thuế' }).click();
  await page.getByRole('menuitem', { name: 'Bảng kê hóa đơn' }).click();
  await expect(page).toHaveURL(/\/thue\/bang-ke-hoa-don$/);
});
