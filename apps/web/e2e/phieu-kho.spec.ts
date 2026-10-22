import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phieu-thu.spec.ts (tài khoản e2e).
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  // đã có từ lần chạy trước thì máy chủ từ chối trùng mã, bỏ qua
  await request.post('/api/catalogs/uom', { data: { code: 'CAI', name: 'Cái' } });
  await request.post('/api/catalogs/party', { data: { code: 'NCC-E2E', name: 'Nhà cung cấp E2E', is_vendor: true } });
  await request.post('/api/catalogs/item', { data: { code: 'HANG-E2E', name: 'Hàng E2E', base_uom_code: 'CAI', kind: 'goods' } });
  await request.post('/api/catalogs/warehouse', { data: { code: 'KHO-E2E', name: 'Kho E2E', inventory_account_code: '156', costing_method: 'avg_moving' } });
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('lập Phiếu nhập kho bằng bàn phím, ghi sổ F9, thấy tồn và bút toán', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/chung-tu/PNK');
  await expect(page.getByRole('heading', { name: 'Phiếu nhập kho' })).toBeVisible();
  await page.keyboard.press('Insert');
  await expect(page.getByText(/Phiếu nhập kho - .*\(mới\)/)).toBeVisible();
  await page.getByLabel('Ngày hạch toán').fill('15/01/2026'); await page.keyboard.press('Enter');
  await page.getByLabel('Kho (F4)').focus(); await page.keyboard.press('F4');
  await page.keyboard.type('KHO-E2E');
  await page.locator('.ant-select-item-option', { hasText: /KHO-E2E/ }).click();
  await page.getByLabel('Đối tượng').focus(); await page.keyboard.press('F4');
  await page.keyboard.type('NCC-E2E');
  await page.locator('.ant-select-item-option', { hasText: /NCC-E2E/ }).click();

  // lưới: mã hàng, ĐVT, số lượng, đơn giá
  await page.locator('.ag-center-cols-container .ag-row[row-index="0"] [col-id="itemCode"]').dblclick();
  await page.keyboard.type('HANG-E2E'); await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.type('10'); await page.keyboard.press('Tab');
  await page.keyboard.type('25000'); await page.keyboard.press('Enter');
  await expect(page.getByText('Cộng: 250.000')).toBeVisible();

  await page.keyboard.press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu')).toBeVisible();
  await expect(page).toHaveURL(/PNK\/[0-9a-f-]{36}$/);
  await expect(page.locator('.ag-center-cols-container [col-id="itemCode"]', { hasText: 'HANG-E2E' }).first()).toBeVisible();
  await page.keyboard.press('F9');
  await expect(page.locator('.ant-message').getByText('Đã ghi sổ')).toBeVisible();
  await expect(page.locator('.ant-card-head-title')).toContainText(/PNK\d+/);
  await expect(page.getByTestId('ledger-lines')).toContainText('156');
  await expect(page.getByTestId('on-hand')).toContainText('HANG-E2E');
});

test('phiếu nhập kho đã lưu có nút In, bản in 01-VT hiện tiêu đề và hàng', async ({ page, request }) => {
  await signIn(page, request);
  const r = await request.post('/api/stock-vouchers', { data: { voucherType: 'PNK', stockKind: 'purchase', postingDate: '2026-01-16', warehouseCode: 'KHO-E2E', partyCode: 'NCC-E2E', items: [{ itemCode: 'HANG-E2E', uomCode: 'CAI', quantity: '4', unitPrice: '1000' }] } });
  expect(r.ok()).toBeTruthy();
  const id = (await r.json()).id as string;
  await page.goto(`/chung-tu/PNK/${id}`);
  const inBtn = page.getByRole('link', { name: 'In', exact: true });
  await expect(inBtn).toHaveAttribute('href', `/api/vouchers/${id}/print?format=pdf`);
  const html = await (await request.get(`/api/vouchers/${id}/print`)).text();
  expect(html).toContain('PHIẾU NHẬP KHO'); expect(html).toContain('HANG-E2E'); expect(html).toContain('Bốn nghìn đồng');
});
