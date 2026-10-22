import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phieu-thu.spec.ts (tài khoản e2e).
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  // đã có từ lần chạy trước thì máy chủ từ chối trùng mã, bỏ qua
  await request.post('/api/catalogs/uom', { data: { code: 'CAI', name: 'Cái' } });
  await request.post('/api/catalogs/party', { data: { code: 'NCC-E2E', name: 'Nhà cung cấp E2E', is_vendor: true } });
  await request.post('/api/catalogs/item', { data: { code: 'HANG-MH', name: 'Hàng mua E2E', base_uom_code: 'CAI', kind: 'goods' } });
  await request.post('/api/catalogs/warehouse', { data: { code: 'KHO-E2E', name: 'Kho E2E', inventory_account_code: '156', costing_method: 'avg_moving' } });
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Mua hàng hóa nhập kho cùng hóa đơn: lập bằng bàn phím, ghi sổ, tồn kho tăng', async ({ page, request }) => {
  await signIn(page, request);
  const stamp = Date.now(); const invoiceNo = String(stamp).slice(-8);
  const day = String(2 + (Math.floor(stamp / 1000) % 27)).padStart(2, '0'); const iso = `2026-11-${day}`; const vn = `${day}/11/2026`;
  const onHand = async () => Number((await (await request.get(`/api/inventory/on-hand?itemCode=HANG-MH&warehouseCode=KHO-E2E&date=2026-12-31`)).json()).quantity);
  const before = await onHand();

  await page.goto('/chung-tu/MH');
  await expect(page.getByRole('heading', { name: 'Mua hàng hóa' })).toBeVisible();
  await page.keyboard.press('Insert');
  await expect(page.getByText('Mua hàng hóa (mới)')).toBeVisible();
  for (const label of ['Ngày hạch toán', 'Ngày chứng từ']) { await page.getByLabel(label).fill(vn); await page.keyboard.press('Enter'); }
  await page.getByRole('combobox', { name: 'Đối tượng' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type('NCC-E2E');
  await page.locator('.ant-select-item-option', { hasText: 'NCC-E2E' }).click();
  await expect(page.getByRole('combobox', { name: 'Cách nhận hàng' })).toBeVisible();

  const cell = (col: string) => page.locator(`.ag-center-cols-container .ag-row[row-index="0"] [col-id="${col}"]`);
  const fill = async (col: string, text: string) => { await cell(col).dblclick(); await page.keyboard.type(text); await page.keyboard.press('Tab'); };
  await fill('itemCode', 'HANG-MH'); await fill('uomCode', 'CAI'); await fill('warehouseCode', 'KHO-E2E');
  await fill('quantity', '10'); await fill('unitPrice', '25000'); await fill('taxCodes', 'V10');
  await expect(cell('amount')).toContainText('250.000');
  await expect(cell('taxAmount')).toContainText('25.000');

  await page.getByRole('tab', { name: 'Hóa đơn' }).click();
  await page.getByLabel('Số hóa đơn', { exact: true }).fill(invoiceNo);
  await page.getByLabel('Ngày hóa đơn').fill(vn); await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Hạch toán' }).click();
  await expect(page.getByTestId('ledger-preview')).toContainText('1331');

  await page.keyboard.press('F9');
  await expect(page.locator('.ant-message').getByText('Đã ghi sổ')).toBeVisible();
  await expect(page.locator('.ant-card-head-title')).toContainText(/MH\d+/);
  expect(await onHand()).toBe(before + 10);
  expect(iso).toMatch(/^2026-11-/);
});
