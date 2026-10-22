import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phieu-thu.spec.ts (tài khoản e2e). Kho, hàng riêng của spec này; mỗi lần chạy thêm phiếu tháng 3/2026.
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  // đã có từ lần chạy trước thì máy chủ từ chối trùng mã, bỏ qua
  await request.post('/api/catalogs/uom', { data: { code: 'CAI', name: 'Cái' } });
  await request.post('/api/catalogs/party', { data: { code: 'NCC-E2E', name: 'Nhà cung cấp E2E', is_vendor: true } });
  await request.post('/api/catalogs/item', { data: { code: 'HGV-E2E', name: 'Hàng giá vốn E2E', base_uom_code: 'CAI', kind: 'goods' } });
  await request.post('/api/catalogs/warehouse', { data: { code: 'KGV-E2E', name: 'Kho giá vốn E2E', inventory_account_code: '156', costing_method: 'fifo' } });
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}
async function stock(request: APIRequestContext, voucherType: 'PNK' | 'PXK', postingDate: string, quantity: string, unitPrice?: string) {
  const r = await request.post('/api/stock-vouchers', { data: { voucherType, stockKind: voucherType === 'PNK' ? 'purchase' : 'sale', postingDate, warehouseCode: 'KGV-E2E',
    ...(voucherType === 'PNK' && { partyCode: 'NCC-E2E' }), description: 'E2E giá vốn', items: [{ itemCode: 'HGV-E2E', uomCode: 'CAI', quantity, ...(unitPrice && { unitPrice }) }] } });
  expect(r.ok(), await r.text()).toBeTruthy();
  expect((await request.post(`/api/vouchers/${(await r.json()).id}/post`, { data: {} })).ok()).toBeTruthy();
}

test('tính giá vốn tháng 3 cho một kho bằng F9: sinh chứng từ GV, bảng gán giá, chạy lại không đổi', async ({ page, request }) => {
  await signIn(page, request);
  await stock(request, 'PNK', '2026-03-02', '100', '10');
  await stock(request, 'PXK', '2026-03-10', '60');
  await stock(request, 'PNK', '2026-03-15', '50', '12');
  await stock(request, 'PXK', '2026-03-20', '70');

  await page.goto('/kho/gia-von');
  await expect(page.getByRole('heading', { name: 'Tính giá vốn' })).toBeVisible();
  await page.locator('.ant-select[aria-label="Từ kỳ"]').click();
  await page.locator('.ant-select-item-option', { hasText: /^Kỳ 3 / }).first().click();
  await expect(page.locator('.ant-select[aria-label="Đến kỳ"]')).toContainText('Kỳ 3');
  await page.getByRole('combobox', { name: 'Kho', exact: true }).focus(); await page.keyboard.press('F4');
  await page.keyboard.type('KGV-E2E');
  await page.locator('.ant-select-item-option', { hasText: /KGV-E2E/ }).click();

  await page.locator('body').click({ position: { x: 5, y: 5 } }); // phím tắt trang chỉ chạy khi tiêu điểm không ở ô nhập
  await page.keyboard.press('F9');
  await expect(page.getByText(/^Đã tính giá vốn \d+ cặp hàng – kho/)).toBeVisible();
  await expect(page.getByText(/Chứng từ giá vốn: GV/)).toBeVisible();
  await expect(page.locator('.ant-table-row', { hasText: 'HGV-E2E' }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Tính giá vốn (F9)' }).click();
  await expect(page.getByText(/^Giá vốn không đổi/)).toBeVisible();
  await expect(page.locator('.ant-tag', { hasText: 'Không đổi' }).first()).toBeVisible();
  await expect(page.locator('.ant-table-row', { hasText: 'HGV-E2E' }).first()).toBeVisible(); // không đổi: vẫn hiện gán giá hiện hành
});
