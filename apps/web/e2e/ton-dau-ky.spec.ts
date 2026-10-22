import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

type Saved = { warehouseCode: string; itemCode: string; quantity: string; value: string | null; lotNo: string; expiryDate: string | null };

test('Tồn kho đầu kỳ: nhập kho, hàng, số lượng, giá trị bằng bàn phím rồi lưu; số dư 156 lệch tồn thì Kiểm tra báo lỗi', async ({ page, request }) => {
  await signIn(page, request);
  // Danh mục dùng chung giữa các lần chạy: đã có thì bỏ qua lỗi trùng
  await request.post('/api/catalogs/uom', { data: { code: 'CAI', name: 'Cái' } });
  await request.post('/api/catalogs/item', { data: { code: 'TDK1', name: 'Hàng tồn đầu kỳ E2E', base_uom_code: 'CAI', kind: 'goods' } });
  await request.post('/api/catalogs/warehouse', { data: { code: 'KTDK', name: 'Kho tồn đầu kỳ E2E', inventory_account_code: '156', costing_method: 'avg_period' } });
  const originalStock = await (await request.get('/api/opening-stock/2026')).json() as Saved[];
  const originalBalance = await (await request.get('/api/opening-balance/2026')).json() as Record<string, unknown>[];
  expect((await request.put('/api/opening-stock/2026', { data: { rows: [] } })).ok()).toBeTruthy();
  try {
    await page.goto('/so-cai/ton-kho-dau-ky');
    await expect(page.locator('.ant-card-head-title', { hasText: 'Tồn kho đầu kỳ' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lưu' })).toBeEnabled();
    await expect(page.locator('.ag-center-cols-container .ag-row')).toHaveCount(1);
    const cell = (row: number, col: string) => page.locator(`.ag-center-cols-container .ag-row[row-index="${row}"] [col-id="${col}"]`);
    const editingCol = () => page.evaluate(() => document.activeElement?.closest('.ag-cell')?.getAttribute('col-id') ?? null);
    const type = async (text: string) => { await page.keyboard.press('Control+a'); await page.keyboard.type(text); };

    await cell(0, 'warehouseCode').click(); await type('KTDK'); await page.keyboard.press('Enter');
    await expect.poll(editingCol).toBe('itemCode'); await type('TDK1'); await page.keyboard.press('Enter');
    await expect.poll(editingCol).toBe('quantity'); await type('100'); await page.keyboard.press('Enter');
    await expect.poll(editingCol).toBe('value'); await type('1000000'); await page.keyboard.press('Enter');
    await expect.poll(editingCol).toBe('lotNo'); await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Lưu' }).click();
    await expect(page.locator('.ant-message').getByText('Đã lưu tồn kho đầu kỳ')).toBeVisible();
    const saved = await (await request.get('/api/opening-stock/2026')).json() as Saved[];
    expect(saved.map((r) => [r.warehouseCode, r.itemCode, r.quantity, r.value, r.lotNo])).toEqual([['KTDK', 'TDK1', '100.0000', '1000000', '']]);
    await expect(page.getByRole('gridcell', { name: 'Kho tồn đầu kỳ E2E' })).toHaveCount(1); // tên kho do máy chủ trả sau khi lưu

    // Số dư 156 lớn hơn tồn kho: Kiểm tra ở màn hình Số dư đầu kỳ báo lệch
    expect((await request.put('/api/opening-balance/2026', { data: { rows: [
      { accountCode: '156', partyCode: null, currencyCode: 'VND', debit: '1600000', credit: '0', debitCurrency: '0', creditCurrency: '0' },
      { accountCode: '4111', partyCode: null, currencyCode: 'VND', debit: '0', credit: '1600000', debitCurrency: '0', creditCurrency: '0' }] } })).ok()).toBeTruthy();
    await page.goto('/so-cai/so-du-dau-ky');
    await expect(page.getByRole('button', { name: 'Kiểm tra' })).toBeEnabled();
    await page.getByRole('button', { name: 'Kiểm tra' }).click();
    await expect(page.getByText('lệch', { exact: false }).first()).toBeVisible();
  } finally {
    const toBody = (r: Saved) => ({ warehouseCode: r.warehouseCode, itemCode: r.itemCode, quantity: r.quantity, value: r.value ?? '0', lotNo: r.lotNo, expiryDate: r.expiryDate });
    await request.put('/api/opening-stock/2026', { data: { rows: originalStock.map(toBody) } });
    await request.put('/api/opening-balance/2026', { data: { rows: originalBalance.map((r) => ({ accountCode: r.accountCode, partyCode: r.partyCode, bankAccountNo: r.bankAccountNo, docNo: r.docNo, docDate: r.docDate, dueDate: r.dueDate, currencyCode: r.currencyCode, debit: r.debit, credit: r.credit, debitCurrency: r.debitCurrency, creditCurrency: r.creditCurrency })) } });
  }
});
