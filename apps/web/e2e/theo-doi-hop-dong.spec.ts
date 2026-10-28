import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"
// GĐ6 Task 13b: phụ lục hợp đồng nhập bằng bàn phím, thẻ Theo dõi (thực hiện, còn phải thu, quá hạn), báo cáo hợp đồng và lãi lỗ hợp đồng/vụ việc.
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}
const must = async (r: Promise<{ ok(): boolean; text(): Promise<string>; json(): Promise<any> }>) => { const x = await r; expect(x.ok(), await x.text()).toBeTruthy(); return x.json(); }; // eslint-disable-line @typescript-eslint/no-explicit-any

test('Theo dõi hợp đồng: phụ lục, % thực hiện, còn phải thu và quá hạn; báo cáo lãi lỗ hợp đồng, vụ việc', async ({ page, request }) => {
  await signIn(page, request);
  const stamp = Date.now(); const party = `KHTD${stamp}`; const code = `TD${stamp}`; const project = `VV${stamp}`;
  await must(request.post('/api/catalogs/party', { data: { code: party, name: `Khách theo dõi ${stamp}`, is_customer: true } }));
  await must(request.post('/api/catalogs/project', { data: { code: project, name: `Công trình ${stamp}`, budget: '20000000' } }));
  const c = await must(request.post('/api/contracts', { data: { code, name: `Hợp đồng theo dõi ${stamp}`, kind: 'sale', partyCode: party, value: '100000000', status: 'active', accountCode: '5113', taxCode: 'V10' } }));
  const ms = (await must(request.put(`/api/contracts/${c.id}/milestones`, { data: { milestones: [{ seq: 1, description: 'Tạm ứng', dueDate: '2026-01-15', amount: '40000000' },
    { seq: 2, description: 'Quyết toán', dueDate: '2026-12-31', amount: '60000000' }] } }))).milestones;
  const inv = await must(request.post(`/api/contracts/${c.id}/milestones/${ms[0].id}/invoice`, { data: { postingDate: '2026-01-10', invoiceGroupCode: '10', invoiceNo: String(stamp).slice(-8) } }));
  await must(request.post(`/api/vouchers/${inv.invoice.id}/post`, { data: {} }));
  await must(request.post('/api/vouchers', { data: { voucherType: 'PT', postingDate: '2026-02-01', documentDate: '2026-02-01', partyCode: party, personName: 'A', description: 'Thu tạm ứng', autoPost: true,
    lines: [{ accountCode: '1111', debit: '10000000' }, { accountCode: '131', credit: '10000000', partyCode: party, contractCode: code }] } }));
  await must(request.post('/api/vouchers', { data: { voucherType: 'PKT', postingDate: '2026-02-05', documentDate: '2026-02-05', description: 'Giá vốn hợp đồng', autoPost: true,
    lines: [{ accountCode: '632', debit: '15000000', contractCode: code, projectCode: project }, { accountCode: '1111', credit: '15000000' }] } }));

  // Phụ lục nhập bằng bàn phím trong ngăn kéo hợp đồng, Ctrl+S lưu.
  await page.goto('/hop-dong');
  await page.getByTestId('contracts-table').locator('tr', { hasText: code }).click();
  const dr = page.getByRole('dialog').first();
  await dr.getByRole('tab', { name: 'Phụ lục' }).click();
  const cell = (row: number, col: string) => dr.locator(`.ag-center-cols-container .ag-row[row-index="${row}"] [col-id="${col}"]`).last();
  await cell(0, 'amendmentNo').click(); await page.keyboard.type('PL01'); await page.keyboard.press('Enter');
  await page.keyboard.type('01/03/2026'); await page.keyboard.press('Enter');
  await page.keyboard.type('Bổ sung hạng mục'); await page.keyboard.press('Enter');
  await page.keyboard.type('20000000'); await page.keyboard.press('Enter');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Đã lưu hợp đồng')).toBeVisible();
  await expect(dr.getByTestId('amendment-summary')).toContainText('Giá trị sau phụ lục: 120.000.000');

  // Thẻ Theo dõi tại 30/06/2026: đã xuất 40 triệu / 120 triệu, còn phải thu 34 triệu quá hạn (đợt 1 hạn 15/01).
  await dr.getByRole('tab', { name: 'Theo dõi' }).click();
  const at = dr.getByLabel('Theo dõi tại ngày');
  await at.click(); await at.fill('30/06/2026'); await at.press('Enter');
  const track = dr.getByTestId('contract-track');
  await expect(dr.getByTestId('track-pct')).toHaveText('33,33%');
  await expect(track).toContainText('Còn phải thu: 34.000.000');
  await expect(dr.getByTestId('track-overdue')).toHaveText('34.000.000');
  await expect(track.locator('tr', { hasText: 'Quyết toán' })).toContainText('Chưa đến hạn');

  // Báo cáo hợp đồng, vụ việc: theo dõi chỉ hợp đồng quá hạn; lãi lỗ theo hợp đồng và vụ việc; xuất Excel.
  await page.goto('/hop-dong/bao-cao');
  await expect(page.getByRole('heading', { name: 'Báo cáo hợp đồng, vụ việc' })).toBeVisible();
  const asOf = page.getByLabel('Tại ngày'); await asOf.click(); await asOf.fill('30/06/2026'); await asOf.press('Enter');
  await page.getByRole('checkbox', { name: 'Chỉ hợp đồng quá hạn' }).check();
  const grid = page.locator('.ag-root');
  await expect(grid.locator('.ag-row', { hasText: code }).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Lãi lỗ theo hợp đồng' }).click();
  const range = page.locator('.ant-picker-range');
  await range.locator('input').first().click(); await range.locator('input').first().fill('01/01/2026'); await range.locator('input').nth(1).fill('30/06/2026'); await range.locator('input').nth(1).press('Enter');
  const row = grid.locator('.ag-row', { hasText: code }).first();
  await expect(row).toContainText('40.000.000'); await expect(row).toContainText('25.000.000'); // doanh thu, lãi (40 − 15)
  await page.getByRole('tab', { name: 'Lãi lỗ theo vụ việc' }).click();
  await expect(grid.locator('.ag-row', { hasText: project }).first()).toContainText('15.000.000');
  const x = await request.get(`/api/projects/pnl?from=2026-01-01&to=2026-06-30&format=xlsx`);
  expect(x.status()).toBe(200); expect(x.headers()['content-type']).toContain('spreadsheetml');
});
