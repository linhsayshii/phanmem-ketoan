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

test('Quy trình cuối kỳ: chạy bước, bỏ qua bước tùy chọn, F9 chạy tới hết', async ({ page, request }) => {
  test.setTimeout(180000); // bước kết chuyển trên cơ sở dữ liệu e2e lâu năm có thể chạy lâu
  await signIn(page, request);
  // Không phụ thuộc trạng thái DB: kỳ 1 của năm đầu không có kỳ trước nên không vướng PERIOD_RUN_GAP; chạy lại là luồng chính.
  const years = await (await request.get('/api/fiscal-years')).json() as { fiscalYear: number }[];
  const year = years[0]!.fiscalYear, period = 1;
  // CSDL e2e dùng chung: thẻ của spec khác còn thiếu phân bổ chi phí làm bước khấu hao, phân bổ (chạy lại mỗi khi giá vốn đổi) báo ASSET_ALLOCATION_MISSING → bổ sung từ kỳ 1.
  for (const c of await (await request.get('/api/assets')).json() as { id: number; allocationFrom: unknown }[])
    if (!c.allocationFrom) expect((await request.put(`/api/assets/${c.id}/allocations`, { data: { validFromYear: year, validFromPeriod: 1, lines: [{ expenseAccountCode: '6422', ratio: '100' }] } })).ok()).toBeTruthy();
  type St = { nextStep: string | null; steps: { key: string; name: string; status: string }[] };
  const status = async () => await (await request.get(`/api/period-close/${year}/${period}`)).json() as St;
  await page.goto('/so-cai/cuoi-ky');
  await expect(page.getByRole('heading', { name: 'Quy trình cuối kỳ' })).toBeVisible();
  await page.locator('.ant-select', { has: page.getByRole('combobox', { name: 'Chọn kỳ' }) }).click();
  await page.getByTitle(`Tháng ${period}`, { exact: true }).click();
  const rows = page.getByTestId('close-steps');
  await expect(rows.locator('tbody tr')).toHaveCount(12);

  // Chạy riêng bước đầu: dòng thành "Đã chạy" (lần đầu "Chạy", các lần sau "Chạy lại")
  const tool = rows.locator('tr', { hasText: 'Phân bổ công cụ dụng cụ' });
  await tool.getByRole('button', { name: /^Chạy/ }).click();
  await expect(tool).toContainText('Đã chạy');

  // Đánh giá lại ngoại tệ là bước tùy chọn: chỉ bỏ qua khi lúc này còn "chưa chạy"
  const fx = rows.locator('tr', { hasText: 'Đánh giá lại ngoại tệ' });
  if ((await status()).steps.find((x) => x.key === 'fx_revaluation')!.status === 'pending') {
    await fx.getByRole('button', { name: 'Bỏ qua' }).click();
    await page.locator('.ant-popover').getByRole('button', { name: 'Bỏ qua' }).click();
    await expect(fx).toContainText('Đã bỏ qua');
  }

  // Bước lương: CSDL e2e dùng chung có thể còn bảng lương nháp ở kỳ này (spec bảng lương) làm bước chưa xong; chưa chạy thì bỏ qua như bước tùy chọn.
  if ((await status()).steps.find((x) => x.key === 'payroll')!.status === 'pending') {
    const payroll = rows.locator('tr', { hasText: 'Tính lương và hạch toán' });
    await payroll.getByRole('button', { name: 'Bỏ qua' }).click();
    await page.locator('.ant-popover').getByRole('button', { name: 'Bỏ qua' }).click();
    await expect(payroll).toContainText('Đã bỏ qua');
  }
  await expect(rows.locator('tr', { hasText: 'Giá thành sản phẩm' })).toContainText('Chưa hỗ trợ');

  // F9 chạy bước kế tiếp cho tới hết
  for (let i = 0; i < 12; i++) {
    const before = await status();
    if (!before.nextStep) break;
    // Chờ màn hình làm mới xong (nút F9 nêu đúng bước kế tiếp) rồi mới bấm: bấm sớm thì chạy lại bước vừa xong.
    await expect(page.getByRole('button', { name: `Chạy bước tiếp theo (F9): ${before.steps.find((x) => x.key === before.nextStep)!.name}` })).toBeEnabled();
    await page.keyboard.press('F9');
    await expect.poll(async () => { const s = await status(); return s.nextStep !== before.nextStep || s.steps.find((x) => x.key === before.nextStep)!.status; }, { timeout: 60000 }).not.toBe(before.steps.find((x) => x.key === before.nextStep)!.status);
  }
  expect((await status()).nextStep).toBeNull();
  for (const r of await rows.locator('tbody tr').all()) await expect(r).toContainText(/Đã chạy|Đã bỏ qua|Chưa hỗ trợ/);
});
