import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như tai-san.spec.ts (tài khoản e2e). Bộ phận và thẻ TSCĐ riêng của spec, mã mới mỗi lần chạy; biên bản lọc theo bộ phận nên không phụ thuộc thẻ của spec khác.
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await request.post('/api/catalogs/party', { data: { code: 'NCC-E2E', name: 'Nhà cung cấp E2E', is_vendor: true } });
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('kiểm kê tài sản: điền số sổ sách, nhập số kiểm kê, lưu, hoàn thành, in biên bản', async ({ page, request }) => {
  await signIn(page, request);
  const sfx = Date.now().toString().slice(-9);
  const code = `TSKK${sfx}`; const dept = `BPKK${sfx}`;
  const d = await request.post('/api/catalogs/department', { data: { code: dept, name: `Bộ phận kiểm kê ${sfx}` } });
  expect(d.ok(), await d.text()).toBeTruthy();
  const a = await request.post('/api/assets', { data: { code, name: `Máy kiểm kê ${code}`, kind: 'fixed', assetAccountCode: '2111', depreciationAccountCode: '2141', departmentCode: dept, lifeUnits: 60, depreciationStartDate: '2026-01-01' } });
  expect(a.ok(), await a.text()).toBeTruthy();
  const v = await request.post('/api/vouchers', { data: { voucherType: 'PKT', postingDate: '2026-01-01', documentDate: '2026-01-01', description: 'E2E kiểm kê tài sản', autoPost: true,
    lines: [{ accountCode: '2111', debit: '120000000', credit: '0', assetCode: code }, { accountCode: '331', debit: '0', credit: '120000000', partyCode: 'NCC-E2E' }] } });
  expect(v.ok(), await v.text()).toBeTruthy();
  const c = await request.post('/api/asset-counts', { data: { kind: 'fixed', countDate: '2026-01-31', departmentCode: dept } });
  expect(c.ok(), await c.text()).toBeTruthy();
  const count = await c.json();

  await page.goto('/tai-san/kiem-ke');
  await expect(page.getByRole('heading', { name: 'Kiểm kê tài sản' })).toBeVisible();
  await page.locator('.ant-table-row', { hasText: 'Nháp' }).filter({ has: page.getByText('31/01/2026') }).first().click();
  await expect(page.getByText(`Biên bản số ${count.id}`)).toBeVisible();
  await page.getByRole('button', { name: 'Điền số sổ sách' }).click();
  const row = page.locator('.ag-center-cols-container .ag-row', { hasText: code });
  await expect(row).toContainText('120.000.000');

  // Nhập số kiểm kê 0: thiếu một tài sản, gợi ý Ghi giảm.
  await row.locator('[col-id="actualQuantity"]').dblclick();
  await page.keyboard.press('Control+A'); await page.keyboard.type('0'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('ac-missing')).toHaveText('1');
  await page.keyboard.press('Control+S');
  await expect(page.getByText('Đã lưu số kiểm kê')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ghi giảm' })).toBeVisible();

  await page.getByRole('button', { name: 'Hoàn thành', exact: true }).click();
  await page.getByRole('button', { name: 'Hoàn thành', exact: true }).last().click();
  await expect(page.getByText('Đã hoàn thành biên bản kiểm kê')).toBeVisible();

  const html = await request.get(`/api/print/asset-count/${count.id}`);
  expect(html.ok(), await html.text()).toBeTruthy();
  const body = await html.text();
  expect(body).toContain('BIÊN BẢN KIỂM KÊ TÀI SẢN CỐ ĐỊNH');
  expect(body).toContain(code);
});
