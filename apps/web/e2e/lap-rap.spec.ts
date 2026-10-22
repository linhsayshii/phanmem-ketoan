import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phieu-thu.spec.ts (tài khoản e2e).
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await request.post('/api/catalogs/uom', { data: { code: 'CAI', name: 'Cái' } });
  await request.post('/api/catalogs/party', { data: { code: 'NCC-E2E', name: 'Nhà cung cấp E2E', is_vendor: true } });
  await request.post('/api/catalogs/warehouse', { data: { code: 'KHO-E2E', name: 'Kho E2E', inventory_account_code: '156', costing_method: 'avg_moving' } });
  for (const code of ['LK-E2E', 'TP-E2E']) await request.post('/api/catalogs/item', { data: { code, name: `Hàng ${code}`, base_uom_code: 'CAI', kind: 'goods' } });
  // nhập sẵn linh kiện để có tồn xuất lắp ráp
  const pnk = await request.post('/api/stock-vouchers', { data: { voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-01-05', warehouseCode: 'KHO-E2E', partyCode: 'NCC-E2E', description: 'Nhập linh kiện',
    items: [{ itemCode: 'LK-E2E', uomCode: 'CAI', quantity: '20', unitPrice: '10' }] } });
  expect(pnk.ok()).toBeTruthy();
  expect((await request.post(`/api/vouchers/${(await pnk.json()).id}/post`, { data: {} })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('lập Phiếu lắp ráp bằng bàn phím, ghi sổ F9, thấy bút toán nhập thành phẩm', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/chung-tu/LR');
  await expect(page.getByRole('heading', { name: 'Phiếu lắp ráp, tháo dỡ' })).toBeVisible();
  await page.keyboard.press('Insert');
  await expect(page.getByText(/Lắp ráp.*\(mới\)/)).toBeVisible();
  await page.getByLabel('Ngày hạch toán').fill('15/01/2026'); await page.keyboard.press('Enter');
  await page.getByLabel('Kho (F4)').focus(); await page.keyboard.press('F4');
  await page.keyboard.type('KHO-E2E');
  await page.locator('.ant-select-item-option', { hasText: /KHO-E2E/ }).click();

  const cell = (grid: number, col: string) => page.locator('.ag-center-cols-container .ag-row[row-index="0"]').nth(grid).locator(`[col-id="${col}"]`);
  await cell(0, 'itemCode').dblclick(); await page.keyboard.type('TP-E2E'); await page.keyboard.press('Tab');
  await page.keyboard.type('CAI'); await page.keyboard.press('Tab');
  await page.keyboard.type('1'); await page.keyboard.press('Enter');
  // Linh kiện chọn bằng F4 (hộp chọn danh mục), ĐVT để trống: máy chủ lấy ĐVT cơ sở
  await cell(1, 'itemCode').click(); await page.keyboard.press('F4');
  await expect(page.getByRole('dialog').getByRole('combobox')).toBeFocused(); await page.keyboard.type('LK-E2E');
  await page.locator('.ant-select-item-option', { hasText: /LK-E2E/ }).click();
  await expect(cell(1, 'itemCode')).toHaveText('LK-E2E');
  await cell(1, 'quantity').dblclick(); await page.keyboard.type('2'); await page.keyboard.press('Enter');

  await page.keyboard.press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu')).toBeVisible();
  await expect(page).toHaveURL(/LR\/[0-9a-f-]{36}$/);
  await page.keyboard.press('F9');
  await expect(page.locator('.ant-message').getByText('Đã ghi sổ')).toBeVisible();
  await expect(page.locator('.ant-card-head-title')).toContainText(/LR\d+/);
  await expect(page.getByTestId('ledger-lines')).toContainText('TP-E2E');
});
