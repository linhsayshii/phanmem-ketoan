import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await request.post('/api/catalogs/party', { data: { code: 'NCC-E2E', name: 'Nhà cung cấp E2E', is_vendor: true } });
  await request.post('/api/catalogs/item', { data: { code: 'HANG-KK', name: 'Hàng kiểm kê E2E', base_uom_code: 'CAI', kind: 'goods', revenue_account_code: '5111' } });
  await request.post('/api/catalogs/warehouse', { data: { code: 'KHO-KK', name: 'Kho kiểm kê E2E', inventory_account_code: '156', costing_method: 'avg_moving' } });
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Kiểm kê kho: lập biên bản, nhập số đếm, lưu, điều chỉnh ra phiếu xuất kho đã ghi sổ, in biên bản', async ({ page, request }) => {
  await signIn(page, request);
  const day = String(1 + (Math.floor(Date.now() / 1000) % 28)).padStart(2, '0'); const iso = `2026-12-${day}`; const vn = `${day}/12/2026`;
  const nhap = await request.post('/api/stock-vouchers', { data: { voucherType: 'PNK', stockKind: 'purchase', postingDate: iso, warehouseCode: 'KHO-KK', partyCode: 'NCC-E2E', items: [{ itemCode: 'HANG-KK', uomCode: 'CAI', quantity: '10', unitPrice: '10000' }] } });
  expect(nhap.ok(), await nhap.text()).toBeTruthy();
  expect((await request.post(`/api/vouchers/${(await nhap.json()).id}/post`, { data: {} })).ok()).toBeTruthy();

  await page.goto('/kho/kiem-ke');
  await expect(page.getByRole('heading', { name: 'Kiểm kê kho' })).toBeVisible();
  await page.getByLabel('Ngày kiểm kê').fill(vn); await page.keyboard.press('Enter');
  await page.getByLabel('Kho', { exact: true }).focus(); await page.keyboard.press('F4');
  await page.locator('.ant-select-item-option', { hasText: /KHO-KK/ }).click();
  await page.getByRole('button', { name: 'Lập biên bản kiểm kê' }).click();
  await expect(page.getByText(/Đã lập biên bản kiểm kê số \d+/)).toBeVisible();

  const cell = (col: string) => page.locator(`.ag-center-cols-container .ag-row[row-index="0"] [col-id="${col}"]`);
  await expect(cell('itemCode')).toHaveText('HANG-KK');
  await cell('countedQty').click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('0'); await page.keyboard.press('Tab');
  await expect(page.getByTestId('st-shortage')).toHaveText('1');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu số đếm')).toBeVisible();

  await page.getByRole('button', { name: 'Điều chỉnh chênh lệch' }).click();
  await page.getByRole('button', { name: 'Điều chỉnh', exact: true }).click();
  await expect(page.getByText('Đã điều chỉnh bằng')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Điều chỉnh chênh lệch' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'In biên bản' })).toBeVisible();
  await page.getByRole('button', { name: 'Mở lại', exact: true }).click();
  await page.getByRole('button', { name: 'Mở lại', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Điều chỉnh chênh lệch' })).toBeVisible();
});
