import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  let years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) {
    expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
    years = [{ fiscalYear: 2026 }];
  }
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
  return years[0].fiscalYear as number;
}

test('Ngân sách: nhập bằng lưới bàn phím, lưu, so với thực tế, cấu hình cảnh báo', async ({ page, request }) => {
  const year = await signIn(page, request);
  // Thực tế: chi 400 vào 6422 tháng 1 của năm tài chính đầu tiên.
  const date = `${year}-01-15`;
  expect((await request.post('/api/vouchers', { data: { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Chi ngân sách E2E', autoPost: true,
    lines: [{ accountCode: '6422', debit: '400' }, { accountCode: '1111', credit: '400' }] } })).ok()).toBeTruthy();
  const name = `NS E2E ${Date.now().toString(36)}`;
  await page.goto('/ngan-sach');
  await expect(page.getByRole('heading', { name: 'Ngân sách', exact: true })).toBeVisible();
  await page.keyboard.press('Insert');
  await page.getByLabel('Tên ngân sách', { exact: true }).fill(name);
  const row = '.ag-center-cols-container .ag-row[row-index="0"]';
  await page.locator(`${row} [col-id="accountPrefix"]`).dblclick(); await page.keyboard.type('642'); await page.keyboard.press('Enter');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Enter'); // bỏ qua khoản mục, bộ phận, dự án
  await page.keyboard.type('1000'); await page.keyboard.press('Enter');
  await page.keyboard.type('500'); await page.keyboard.press('Enter');
  await expect(page.locator(`${row} [col-id="m01"]`)).toHaveText('1.000');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu ngân sách')).toBeVisible();
  await page.getByRole('button', { name: 'Đóng' }).click();
  await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();

  // Duyệt qua API rồi xem thực hiện so với ngân sách.
  const list = await (await request.get(`/api/budgets?year=${year}`)).json() as { id: number; name: string }[];
  const id = list.find((b) => b.name === name)!.id;
  expect((await (await request.get(`/api/budgets/${id}`)).json()).lines[0]).toMatchObject({ accountPrefix: '642', total: '1500' });
  expect((await request.post(`/api/budgets/${id}/approve`)).ok()).toBeTruthy();
  const rep = await (await request.get(`/api/budgets/${id}/report?month=1`)).json();
  expect(rep.lines[0].ytd).toMatchObject({ budget: '1000', pct: expect.any(String) });
  await page.reload();
  await page.getByRole('tab', { name: 'Thực hiện so với ngân sách' }).click();
  await expect(page.getByText('Đến tháng 12')).toBeVisible();
  await expect(page.getByRole('cell', { name: '642', exact: true }).first()).toBeVisible();

  await page.getByRole('tab', { name: 'Cảnh báo vượt ngân sách' }).click();
  await page.getByLabel('Bật cảnh báo vượt ngân sách').click();
  await page.getByRole('button', { name: 'Lưu cấu hình' }).click();
  await expect(page.locator('.ant-message').getByText('Đã lưu cấu hình cảnh báo')).toBeVisible();
  expect(await (await request.get('/api/budget-settings')).json()).toMatchObject({ enabled: true, warnPct: 90, blockPct: null });
  expect((await request.put('/api/budget-settings', { data: { enabled: false, warnPct: 90, blockPct: null } })).ok()).toBeTruthy(); // trả về mặc định
});
