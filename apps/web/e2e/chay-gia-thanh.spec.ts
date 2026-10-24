import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"
// Kỳ tháng 9/2026: các spec khác không ghi chi phí sản xuất vào tháng này.

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}
const choose = async (page: Page, combo: string, option: string) => {
  await page.getByRole('combobox', { name: combo }).click({ force: true });
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: option }).first().click();
};

test('tính giá thành kỳ: chọn kỳ, khai dở dang theo NVL, xem trước, chạy (F9), kết quả lưu', async ({ page, request }) => {
  await signIn(page, request);
  const sfx = Date.now().toString(36).toUpperCase().slice(-6);
  const tp = `TPG-${sfx}`; const obj = `GT-${sfx}`; const km = `KMV-${sfx}`;
  await request.post('/api/catalogs/uom', { data: { code: 'CAI', name: 'Cái' } }); // trùng mã từ lần chạy trước thì bỏ qua
  expect((await request.post('/api/catalogs/item', { data: { code: tp, name: 'Tủ gỗ E2E', base_uom_code: 'CAI', kind: 'finished' } })).ok()).toBeTruthy();
  expect((await request.post('/api/catalogs/cost_item', { data: { code: km, name: 'NVL tủ gỗ', cost_element: 'material' } })).ok()).toBeTruthy();
  expect((await request.post('/api/costing/objects', { data: { code: obj, name: `Tủ gỗ ${sfx}`, kind: 'product', itemCode: tp, method: 'simple' } })).ok()).toBeTruthy();
  // Chi phí NVL 1.000.000 cho đối tượng: TT133 ghi thẳng 154 theo khoản mục, TT99 ghi 621.
  const regime = ((await (await request.get('/api/fiscal-years')).json()) as { regime: string; dateFrom: string; dateTo: string }[]).find((y) => y.dateFrom <= '2026-09-10' && '2026-09-10' <= y.dateTo)!.regime;
  const [costAcc, cash] = regime === 'TT133' ? ['154', '1111'] : ['621', '111'];
  expect((await request.post('/api/vouchers', { data: { voucherType: 'PKT', postingDate: '2026-09-10', documentDate: '2026-09-10', description: `NVL tủ gỗ ${sfx}`, autoPost: true,
    lines: [{ accountCode: costAcc, debit: '1000000', costObjectCode: obj, costItemCode: km }, { accountCode: cash, credit: '1000000' }] } })).ok()).toBeTruthy();

  await page.goto('/gia-thanh/tinh-gia-thanh');
  await expect(page.getByRole('heading', { name: 'Tính giá thành' })).toBeVisible();
  await choose(page, 'Kỳ', 'Tháng 9');
  const row = page.getByTestId('cost-run-objects').locator('tr', { hasText: obj });
  await expect(row).toBeVisible();
  // 10 sản phẩm: 8 hoàn thành, 2 dở dang; dở dang theo NVL = 1.000.000 ÷ 10 × 2 = 200.000; giá thành 800.000, 100.000/cái.
  await choose(page, `Đánh giá dở dang ${obj}`, 'Theo NVL trực tiếp');
  await page.getByLabel(`SL hoàn thành ${obj}`).fill('8'); await page.keyboard.press('Tab');
  await page.getByLabel(`SL dở dang ${obj}`).fill('2'); await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Xem trước' }).click();
  await expect(row).toContainText('800.000');
  await expect(row).toContainText('200.000');
  await page.keyboard.press('F9');
  await expect(page.getByText('Đã tính giá thành kỳ').or(page.getByText('Giá thành không đổi'))).toBeVisible();
  await expect(page.getByTestId('cost-runs').locator('tr', { hasText: 'Tháng 9' })).toContainText('Đã tính');

  const saved = await (await request.get('/api/costing/runs/2026/9')).json();
  expect(saved.objects.find((o: { code: string }) => o.code === obj)).toMatchObject({ wipMethod: 'direct_material', total: '800000', unitCost: '100000.0000', closing: { material: '200000' } });
  expect(saved.stale).toBe(false);
});
