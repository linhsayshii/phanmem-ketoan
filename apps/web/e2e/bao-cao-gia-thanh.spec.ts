import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"
// Kỳ tháng 8/2026: các spec khác không ghi chi phí sản xuất vào tháng này (tháng 9 của chay-gia-thanh, tháng hiện tại của doi-tuong-gia-thanh).

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

test('báo cáo giá thành: thẻ tính giá thành, sổ chi tiết 154, tổng hợp theo khoản mục, so sánh định mức, in và Excel', async ({ page, request }) => {
  await signIn(page, request);
  const sfx = Date.now().toString(36).toUpperCase().slice(-6);
  const tp = `TPB-${sfx}`; const obj = `BG-${sfx}`; const km = `KMB-${sfx}`;
  await request.post('/api/catalogs/uom', { data: { code: 'CAI', name: 'Cái' } }); // trùng mã từ lần chạy trước thì bỏ qua
  expect((await request.post('/api/catalogs/item', { data: { code: tp, name: 'Tủ gỗ báo cáo', base_uom_code: 'CAI', kind: 'finished' } })).ok()).toBeTruthy();
  expect((await request.post('/api/catalogs/cost_item', { data: { code: km, name: 'NVL tủ gỗ báo cáo', cost_element: 'material' } })).ok()).toBeTruthy();
  expect((await request.post('/api/costing/objects', { data: { code: obj, name: `Tủ gỗ ${sfx}`, kind: 'product', itemCode: tp, method: 'simple' } })).ok()).toBeTruthy();
  const regime = ((await (await request.get('/api/fiscal-years')).json()) as { regime: string; dateFrom: string; dateTo: string }[]).find((y) => y.dateFrom <= '2026-08-10' && '2026-08-10' <= y.dateTo)!.regime;
  const [costAcc, cash] = regime === 'TT133' ? ['154', '1111'] : ['621', '111'];
  expect((await request.post('/api/vouchers', { data: { voucherType: 'PKT', postingDate: '2026-08-10', documentDate: '2026-08-10', description: `NVL tủ gỗ ${sfx}`, autoPost: true,
    lines: [{ accountCode: costAcc, debit: '1000000', costObjectCode: obj, costItemCode: km }, { accountCode: cash, credit: '1000000' }] } })).ok()).toBeTruthy();
  // 10 sản phẩm: 8 hoàn thành, 2 dở dang theo NVL: 1.000.000 ÷ 10 × 2 = 200.000 → giá thành 800.000, 100.000/cái.
  const run = await request.post('/api/costing/runs', { data: { year: 2026, month: 8, params: { objects: [{ objectCode: obj, wip: 'direct_material', outputs: [{ qty: '8', wipQty: '2' }] }] } } });
  expect(run.ok(), await run.text()).toBeTruthy();

  await page.goto('/gia-thanh/bao-cao');
  await expect(page.getByRole('heading', { name: 'Báo cáo giá thành' })).toBeVisible();
  await choose(page, 'Năm tài chính', 'Năm 2026');
  await choose(page, 'Kỳ', 'Tháng 8');
  await page.getByRole('combobox', { name: 'Đối tượng tập hợp chi phí' }).fill(obj);
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: obj }).first().click();

  // Thẻ tính giá thành: dở dang cuối 200.000, tổng giá thành 800.000, giá thành đơn vị 100.000.
  const grid = page.locator('.ag-center-cols-container');
  await expect(grid).toContainText(`${obj} — Tủ gỗ ${sfx}`);
  const total = grid.locator('.ag-row', { hasText: /^Cộng/ });
  await expect(total).toContainText('1.000.000'); await expect(total).toContainText('200.000'); await expect(total).toContainText('800.000'); await expect(total).toContainText('100.000,0000');
  await expect(page.getByTestId('recon')).toBeVisible();

  // Sổ chi tiết TK 154: dư cuối kỳ của đối tượng; một đối tượng nên chưa đối chiếu sổ cái.
  await page.getByRole('tab', { name: 'Sổ chi tiết TK 154' }).click();
  await expect(grid).toContainText(`Đối tượng: ${obj}`);
  await expect(grid.locator('.ag-row', { hasText: 'Cộng số phát sinh' })).toContainText('1.000.000');
  await expect(grid).toContainText('Số dư cuối kỳ');

  // Bỏ chọn đối tượng: đối chiếu với sổ cái TK 154 khớp
  const pick = page.locator('.ant-select', { has: page.getByRole('combobox', { name: 'Đối tượng tập hợp chi phí' }) });
  await pick.hover(); await pick.locator('.ant-select-clear').click();
  await expect(page.getByTestId('recon')).toContainText('khớp sổ cái');

  // Tổng hợp chi phí theo khoản mục: nguyên vật liệu trực tiếp 1.000.000 của đối tượng.
  await page.getByRole('tab', { name: 'Tổng hợp chi phí theo khoản mục' }).click();
  const sumRow = grid.locator('.ag-row', { hasText: `${obj} — ` });
  await expect(sumRow).toContainText('1.000.000');
  await expect(grid).toContainText(`NVL tủ gỗ báo cáo`);

  // So sánh định mức: TT133 không có TK 621 nên có giải thích; TT99 hiện bảng.
  await page.getByRole('tab', { name: 'So sánh định mức NVL' }).click();
  if (regime === 'TT133') await expect(page.getByText('TT133 không có TK 621')).toBeVisible(); else await expect(page.getByTestId('recon')).toBeVisible();

  // In (HTML) và Excel
  await page.getByRole('tab', { name: 'Thẻ tính giá thành' }).click();
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'In', exact: true }).click()]);
  await popup.waitForLoadState();
  await expect(popup.locator('h1')).toContainText('THẺ TÍNH GIÁ THÀNH');
  await expect(popup.locator('table.grid')).toContainText('800.000');
  const xlsx = await request.get('/api/costing/reports/card?year=2026&month=8&format=xlsx');
  expect(xlsx.status()).toBe(200);
  expect(xlsx.headers()['content-type']).toContain('spreadsheetml');
});
