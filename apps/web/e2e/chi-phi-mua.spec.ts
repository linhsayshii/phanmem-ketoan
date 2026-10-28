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
const dayOf = (stamp: number) => { const day = String(2 + (Math.floor(stamp / 1000) % 27)).padStart(2, '0'); return { iso: `2026-12-${day}`, vn: `${day}/12/2026` }; };
const cellIn = (page: Page, row: number, col: string) => page.locator(`.ant-tabs-tabpane-active .ag-center-cols-container .ag-row[row-index="${row}"] [col-id="${col}"]`);

test('Chi phí mua hàng: chọn phiếu nhập, nhập chi phí bằng bàn phím, xem phân bổ, ghi sổ F9', async ({ page, request }) => {
  await signIn(page, request);
  const { iso, vn } = dayOf(Date.now());
  // Phiếu nhập kho mua hàng 10 cái x 50.000 đã ghi sổ (lập qua API: luồng nhập phiếu kho đã có phieu-kho.spec.ts)
  const pnk = await request.post('/api/stock-vouchers', { data: { voucherType: 'PNK', stockKind: 'purchase', postingDate: iso, documentDate: iso, warehouseCode: 'KHO-E2E', partyCode: 'NCC-E2E', description: 'Nhập hàng E2E chi phí mua',
    items: [{ itemCode: 'HANG-MH', uomCode: 'CAI', quantity: '10', unitPrice: '50000' }] } });
  expect(pnk.ok()).toBeTruthy();
  const receipt = await pnk.json() as { id: string };
  const postedPnk = await (await request.post(`/api/vouchers/${receipt.id}/post`, { data: {} })).json() as { voucherNo: string };
  expect(postedPnk.voucherNo).toBeTruthy();

  await page.goto('/chung-tu/CPM');
  await expect(page.getByRole('heading', { name: 'Chi phí mua hàng' })).toBeVisible();
  await page.keyboard.press('Insert');
  await expect(page.getByText('Chi phí mua hàng (mới)')).toBeVisible();
  for (const label of ['Ngày hạch toán', 'Ngày chứng từ']) { await page.getByLabel(label).fill(vn); await page.keyboard.press('Enter'); }
  await page.getByRole('combobox', { name: 'Đối tượng' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type('NCC-E2E');
  await page.locator('.ant-select-item-option', { hasText: 'NCC-E2E' }).click();

  const row = page.getByTestId('receipts').locator('tr', { hasText: postedPnk.voucherNo });
  await expect(row).toContainText('500.000');
  await row.locator('input[type="checkbox"]').check();
  await expect(page.getByRole('tab', { name: /Phiếu nhập \(1\)/ })).toBeVisible();

  await page.getByRole('tab', { name: 'Chi phí' }).click();
  const fill = async (col: string, text: string) => { await cellIn(page, 0, col).dblclick(); await page.keyboard.type(text); await page.keyboard.press('Tab'); };
  await fill('accountCode', '331'); await fill('description', 'Vận chuyển hàng về kho'); await fill('amount', '120000'); await fill('vatAmount', '12000');
  await expect(page.getByText('Cộng thanh toán: 132.000')).toBeVisible();

  await page.getByRole('tab', { name: 'Phân bổ' }).click();
  const alloc = page.getByTestId('allocations');
  await expect(alloc).toContainText('HANG-MH'); await expect(alloc).toContainText('120.000'); await expect(alloc).toContainText('620.000');
  await expect(page.getByText('Đã phân bổ: 120.000 / 120.000')).toBeVisible();

  await page.keyboard.press('F9');
  await expect(page.locator('.ant-message').getByText('Đã ghi sổ')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/CPM\d+/);
  await expect(page.locator('.kt-page-header')).toContainText('Đã ghi sổ');
  await page.getByRole('tab', { name: 'Hạch toán' }).click();
  const ledger = page.getByTestId('ledger-lines');
  await expect(ledger).toContainText('156'); await expect(ledger).toContainText('1331'); await expect(ledger).toContainText('132.000');
});

test('Mua hàng nhập khẩu: cột thuế nhập khẩu, TTĐB, GTGT hàng nhập và bút toán xem trước', async ({ page, request }) => {
  await signIn(page, request);
  const stamp = Date.now(); const { vn } = dayOf(stamp);
  await page.goto('/chung-tu/MH/moi');
  await expect(page.getByText('Mua hàng hóa (mới)')).toBeVisible();
  for (const label of ['Ngày hạch toán', 'Ngày chứng từ']) { await page.getByLabel(label).fill(vn); await page.keyboard.press('Enter'); }
  await page.getByRole('combobox', { name: 'Đối tượng' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type('NCC-E2E');
  await page.locator('.ant-select-item-option', { hasText: 'NCC-E2E' }).click();
  await page.getByRole('checkbox', { name: 'Hàng nhập khẩu' }).check();

  const fill = async (col: string, text: string) => { await cellIn(page, 0, col).dblclick(); await page.keyboard.type(text); await page.keyboard.press('Tab'); };
  await fill('itemCode', 'HANG-MH'); await fill('uomCode', 'CAI'); await fill('warehouseCode', 'KHO-E2E');
  await fill('quantity', '10'); await fill('unitPrice', '100000');
  await fill('importTax', '50000'); await fill('specialConsumptionTax', '20000'); await fill('vatImport', '107000'); await fill('vatImportCode', 'V10');

  await page.getByRole('tab', { name: 'Hóa đơn' }).click();
  await page.getByLabel('Số hóa đơn', { exact: true }).fill(`TK${String(stamp).slice(-8)}`);
  await page.getByLabel('Ngày hóa đơn').fill(vn); await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Hạch toán' }).click();
  const preview = page.getByTestId('ledger-preview');
  for (const acct of ['3333', '3332', '33312', '1331']) await expect(preview).toContainText(acct);
  await expect(preview).toContainText('Tổng Nợ: 1.177.000');

  await page.keyboard.press('F9');
  await expect(page.locator('.ant-message').getByText('Đã ghi sổ')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/MH\d+/);
  await expect(page.getByRole('checkbox', { name: 'Hàng nhập khẩu' })).toBeChecked();
});
