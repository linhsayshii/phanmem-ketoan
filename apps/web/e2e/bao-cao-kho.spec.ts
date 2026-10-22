import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phieu-thu.spec.ts (tài khoản e2e). Kho, hàng riêng của spec này; phiếu lập ngày 05/07/2026 và 12/07/2026 (mỗi lần chạy cộng thêm số lượng, nên kiểm tra theo mã hàng mới mỗi lần).
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await request.post('/api/catalogs/uom', { data: { code: 'CAI', name: 'Cái' } });
  await request.post('/api/catalogs/party', { data: { code: 'NCC-E2E', name: 'Nhà cung cấp E2E', is_vendor: true } });
  await request.post('/api/catalogs/warehouse', { data: { code: 'KBC-E2E', name: 'Kho báo cáo E2E', inventory_account_code: '156', costing_method: 'fifo' } });
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}
async function stock(request: APIRequestContext, item: string, voucherType: 'PNK' | 'PXK', postingDate: string, quantity: string, unitPrice?: string) {
  const r = await request.post('/api/stock-vouchers', { data: { voucherType, stockKind: voucherType === 'PNK' ? 'purchase' : 'sale', postingDate, warehouseCode: 'KBC-E2E',
    ...(voucherType === 'PNK' && { partyCode: 'NCC-E2E' }), description: 'E2E báo cáo kho', items: [{ itemCode: item, uomCode: 'CAI', quantity, ...(unitPrice && { unitPrice }) }] } });
  expect(r.ok(), await r.text()).toBeTruthy();
  expect((await request.post(`/api/vouchers/${(await r.json()).id}/post`, { data: {} })).ok()).toBeTruthy();
}

test('báo cáo kho: nhập xuất tồn, thẻ kho, đối chiếu', async ({ page, request }) => {
  await signIn(page, request);
  const item = `HBC${Date.now().toString().slice(-8)}`;
  expect((await request.post('/api/catalogs/item', { data: { code: item, name: 'Hàng báo cáo E2E', base_uom_code: 'CAI', kind: 'goods' } })).ok()).toBeTruthy();
  await stock(request, item, 'PNK', '2026-07-05', '100', '10');
  await stock(request, item, 'PXK', '2026-07-12', '40');
  expect((await request.post('/api/inventory/costing-runs', { data: { periodFrom: '2026-07-01', periodTo: '2026-07-31', warehouseCode: 'KBC-E2E' } })).ok()).toBeTruthy();

  // Bộ lọc nhớ nạp từ máy chủ sau khi trang mở và ghi đè ô vừa nhập: chờ bản nạp xong rồi mới nhập.
  const prefs = page.waitForResponse((r) => r.url().includes('/api/prefs/') && r.url().includes('stock-reports'));
  await page.goto('/kho/bao-cao'); await prefs;
  await expect(page.getByRole('heading', { name: 'Báo cáo kho' })).toBeVisible();
  const range = page.locator('.ant-picker-range input');
  await range.nth(0).fill('01/07/2026'); await page.keyboard.press('Enter');
  await range.nth(1).fill('31/07/2026'); await page.keyboard.press('Enter');
  const pick = async (label: string, code: string) => {
    await page.getByRole('combobox', { name: label }).focus(); await page.keyboard.press('F4'); await page.keyboard.type(code);
    await page.locator('.ant-select-item-option', { hasText: code }).first().click();
  };
  await pick('Mã hàng', item);

  const row = page.locator('.ag-center-cols-container .ag-row', { hasText: item });
  await expect(row).toBeVisible();
  await expect(row).toContainText('100'); await expect(row).toContainText('1.000'); await expect(row).toContainText('400');

  await page.getByRole('tab', { name: 'Thẻ kho' }).click();
  await expect(page.locator('.ag-center-cols-container .ag-row', { hasText: 'Cộng phát sinh trong kỳ' })).toContainText('60');

  await page.getByRole('tab', { name: 'Đối chiếu kế toán - kho' }).click();
  // CSDL e2e dùng chung với các spec khác nên toàn công ty có thể còn chênh lệch; kiểm tra có kết luận và hàng của spec này đã tính giá vốn không bị lệch.
  await expect(page.getByText(/^(Không có chênh lệch giữa thẻ kho|Có \d+ dòng chênh lệch)/)).toBeVisible();
  await expect(page.locator('.ag-center-cols-container .ag-row', { hasText: item })).toHaveCount(0);
});
