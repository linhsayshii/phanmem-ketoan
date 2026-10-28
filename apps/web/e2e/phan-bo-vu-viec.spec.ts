import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"
// GĐ6 Task 13c: phân bổ chi phí quản lý chưa gắn vụ việc (tiêu thức nhập tay, F9), kết chuyển giá vốn vụ việc hoàn thành 154 → 632, báo cáo số dư theo vụ việc.
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}
const must = async (r: Promise<{ ok(): boolean; text(): Promise<string>; json(): Promise<any> }>) => { const x = await r; expect(x.ok(), await x.text()).toBeTruthy(); return x.json(); }; // eslint-disable-line @typescript-eslint/no-explicit-any
const choose = async (page: Page, combo: string, option: string) => {
  await page.getByRole('combobox', { name: combo }).click({ force: true });
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: option }).first().click();
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0); // chờ dropdown đóng hẳn: bấm ô kế tiếp khi còn hiệu ứng đóng thì ô đó không mở
};
const pick = async (page: Page, combo: string, code: string) => {
  await page.getByRole('combobox', { name: combo }).focus(); await page.keyboard.press('F4');
  await page.keyboard.type(code);
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: code }).first().click();
};

test('Phân bổ chi phí vào vụ việc: nhập tay, chạy (F9), kết chuyển giá vốn vụ việc hoàn thành, số dư theo vụ việc', async ({ page, request }) => {
  await signIn(page, request);
  const sfx = Date.now().toString(36).toUpperCase().slice(-6); const vv = `PB-${sfx}`;
  const day = (d: number) => `2026-10-${String(d).padStart(2, '0')}`;
  const regime = ((await (await request.get('/api/fiscal-years')).json()) as { regime: string; dateFrom: string; dateTo: string }[]).find((y) => y.dateFrom <= day(1) && day(1) <= y.dateTo)!.regime;
  const [cash, revenue, admin] = regime === 'TT133' ? ['1111', '5113', '6422'] : ['111', '511', '6421'];
  await must(request.post('/api/catalogs/project', { data: { code: vv, name: `Công trình ${sfx}` } }));
  const pkt = (date: string, description: string, lines: object[]) => must(request.post('/api/vouchers', { data: { voucherType: 'PKT', postingDate: date, documentDate: date, description, autoPost: true, lines } }));
  await pkt(day(10), `Doanh thu ${sfx}`, [{ accountCode: cash, debit: '10000000' }, { accountCode: revenue, credit: '10000000', projectCode: vv }]);
  await pkt(day(11), `Chi phí chung ${sfx}`, [{ accountCode: admin, debit: '1000000' }, { accountCode: cash, credit: '1000000' }]);
  await pkt(day(12), `Chi phí công trình ${sfx}`, [{ accountCode: '154', debit: '2000000', projectCode: vv }, { accountCode: cash, credit: '2000000' }]);

  // Phân bổ: tiêu thức nhập tay chỉ một vụ việc → nhận toàn bộ chi phí chung chưa phân bổ của tháng.
  await page.goto('/hop-dong/phan-bo');
  await expect(page.getByRole('heading', { name: 'Phân bổ chi phí vào vụ việc' })).toBeVisible();
  await choose(page, 'Kỳ', 'Tháng 10');
  await expect(page.getByTestId('alloc-pool')).toContainText(`TK ${admin}`);
  await page.getByText('Nhập tay', { exact: true }).click();
  for (const b of await page.getByRole('button', { name: 'Bỏ' }).all()) await b.click(); // tiêu thức tay của lần chạy trước (cùng công ty E2E, cùng kỳ)
  await page.getByRole('button', { name: 'Thêm vụ việc' }).click();
  await pick(page, 'Vụ việc 1', vv);
  await page.getByRole('button', { name: 'Xem trước' }).click();
  const row = page.getByTestId('alloc-result').locator('tr', { hasText: vv });
  await expect(row).toContainText('100');
  await page.keyboard.press('F9');
  await expect(page.getByText(/Đã ghi sổ chứng từ|Số liệu không đổi/)).toBeVisible();
  await expect(page.getByText('Đã hạch toán')).toBeVisible();
  const pnl = await must(request.get(`/api/projects/pnl?from=${day(1)}&to=${day(31)}`));
  expect(pnl.unassigned.admin).toBe('0');

  // Kết chuyển giá vốn vụ việc hoàn thành: 154 của vụ việc → 632.
  await page.getByRole('tab', { name: 'Kết chuyển giá vốn vụ việc' }).click();
  await pick(page, 'Thêm vụ việc hoàn thành', vv);
  await expect(page.getByText(vv, { exact: true })).toBeVisible();
  await page.keyboard.press('F9');
  await expect(page.getByTestId('cogs-result').locator('tr', { hasText: vv })).toContainText('2.000.000');
  await expect(page.getByText('Đã hạch toán')).toBeVisible();

  // Báo cáo số dư theo vụ việc: 154 của vụ việc phát sinh Nợ = Có 2.000.000, không còn dở dang.
  await page.goto('/hop-dong/bao-cao');
  await page.getByRole('tab', { name: 'Số dư theo vụ việc, hợp đồng' }).click();
  const range = page.locator('.ant-picker-range'); // bộ lọc nhớ theo người dùng: đặt lại khoảng ngày
  await range.locator('input').first().click(); await range.locator('input').first().fill('01/10/2026'); await range.locator('input').nth(1).fill('31/10/2026'); await range.locator('input').nth(1).press('Enter');
  const acc = page.getByLabel('Tài khoản'); await acc.fill('154'); await acc.press('Enter');
  const grid = page.locator('.ag-root');
  await expect(grid.locator('.ag-row', { hasText: vv }).first()).toContainText('2.000.000');
  await expect(page.getByTestId('wip-summary')).not.toContainText(vv);
  const bal = await must(request.get(`/api/projects/balances?from=${day(1)}&to=${day(31)}&accountCode=154`));
  expect(bal.rows.find((r: { dimCode: string }) => r.dimCode === vv)).toMatchObject({ debit: '2000000', credit: '2000000', closing: { debit: '0', credit: '0' } });
});
