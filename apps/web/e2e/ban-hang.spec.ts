import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phieu-thu.spec.ts (tài khoản e2e).
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  // đã có từ lần chạy trước thì máy chủ từ chối trùng mã, bỏ qua
  await request.post('/api/catalogs/uom', { data: { code: 'CAI', name: 'Cái' } });
  await request.post('/api/catalogs/party', { data: { code: 'KH-E2E', name: 'Khách hàng E2E', is_customer: true } });
  await request.post('/api/catalogs/party', { data: { code: 'NCC-E2E', name: 'Nhà cung cấp E2E', is_vendor: true } });
  await request.post('/api/catalogs/item', { data: { code: 'HANG-BH', name: 'Hàng bán E2E', base_uom_code: 'CAI', kind: 'goods', revenue_account_code: '5111' } });
  await request.post('/api/catalogs/warehouse', { data: { code: 'KHO-E2E', name: 'Kho E2E', inventory_account_code: '156', costing_method: 'avg_moving' } });
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Bán hàng hóa kiêm phiếu xuất: lập bằng bàn phím, ghi sổ, tồn kho giảm, có bút toán giá vốn', async ({ page, request }) => {
  await signIn(page, request);
  const stamp = Date.now(); const invoiceNo = String(stamp).slice(-8);
  const day = String(2 + (Math.floor(stamp / 1000) % 27)).padStart(2, '0'); const vn = `${day}/11/2026`; const iso = `2026-11-${day}`;
  const nhap = await request.post('/api/stock-vouchers', { data: { voucherType: 'PNK', stockKind: 'purchase', postingDate: iso, warehouseCode: 'KHO-E2E', partyCode: 'NCC-E2E', items: [{ itemCode: 'HANG-BH', uomCode: 'CAI', quantity: '20', unitPrice: '10000' }] } });
  expect(nhap.ok(), await nhap.text()).toBeTruthy();
  expect((await request.post(`/api/vouchers/${(await nhap.json()).id}/post`, { data: {} })).ok()).toBeTruthy();
  const onHand = async () => Number((await (await request.get(`/api/inventory/on-hand?itemCode=HANG-BH&warehouseCode=KHO-E2E&date=2026-12-31`)).json()).quantity);
  const before = await onHand();

  await page.goto('/chung-tu/BH');
  await expect(page.getByRole('heading', { name: 'Bán hàng hóa' })).toBeVisible();
  await page.keyboard.press('Insert');
  await expect(page.getByText('Bán hàng hóa kiêm phiếu xuất (mới)')).toBeVisible();
  for (const label of ['Ngày hạch toán', 'Ngày chứng từ']) { await page.getByLabel(label).fill(vn); await page.keyboard.press('Enter'); }
  await page.getByRole('combobox', { name: 'Đối tượng' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type('KH-E2E');
  await page.locator('.ant-select-item-option', { hasText: 'KH-E2E' }).click();

  const cell = (col: string) => page.locator(`.ag-center-cols-container .ag-row[row-index="0"] [col-id="${col}"]`);
  const fill = async (col: string, text: string) => { await cell(col).dblclick(); await page.keyboard.type(text); await page.keyboard.press('Tab'); };
  await fill('itemCode', 'HANG-BH'); await fill('uomCode', 'CAI'); await fill('warehouseCode', 'KHO-E2E');
  await fill('quantity', '5'); await fill('unitPrice', '40000'); await fill('taxCodes', 'V10');
  await expect(cell('amount')).toContainText('200.000');
  await expect(cell('taxAmount')).toContainText('20.000');

  await page.getByRole('tab', { name: 'Hóa đơn' }).click();
  await page.getByLabel('Số hóa đơn', { exact: true }).fill(invoiceNo);
  await page.getByLabel('Ngày hóa đơn').fill(vn); await page.keyboard.press('Enter');

  await page.keyboard.press('F9');
  await expect(page.locator('.ant-message').getByText('Đã ghi sổ')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/BH\d+/);
  expect(await onHand()).toBe(before - 5);
});
