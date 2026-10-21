import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

// Đăng nhập bằng API (để có năm tài chính) rồi bằng giao diện (để trang có phiên)
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Công cụ tỷ giá: chạy tỷ giá xuất quỹ ghi nhật ký; đánh giá lại phải xem trước mới chạy được', async ({ page, request }) => {
  await signIn(page, request);
  // Dữ liệu E2E dùng chung với các spec khác. Cách ly: mỗi lần một khách hàng riêng, ngoại tệ USD (không spec nào khác dùng), và MỘT ngày cố định 31/12/2026:
  // các spec khác chỉ ghi và đọc ngày 1-28 tháng 12 (VND), nên chứng từ DG của lần chạy này không đụng dữ liệu của chúng; chạy lại cùng ngày thì chứng từ DG cũ bị đảo và thay bằng bản mới,
  // nên số chứng từ dùng chung không phình ra theo số lần chạy. Spec này chạy thứ tự nào cũng được.
  const stamp = Date.now(); const iso = '2026-12-31'; const vn = '31/12/2026';
  const code = `KHTG${stamp}`; const rate = '25500';
  expect((await request.post('/api/catalogs/party', { data: { code, name: `Khách tỷ giá ${stamp}`, is_customer: true } })).ok()).toBeTruthy();
  const rateRow = await request.post('/api/catalogs/exchange_rate', { data: { currency_code: 'USD', rate_date: iso, rate_type: 'transfer_avg', rate } });
  expect([201, 409], await rateRow.text()).toContain(rateRow.status()); // 409: tỷ giá ngày này đã có từ lần chạy trước
  // Hóa đơn bán chịu 100 USD, tỷ giá ghi sổ 25.000: cuối ngày tỷ giá cao hơn nên có chênh lệch đánh giá lại.
  const invoice = await request.post('/api/vouchers', { data: { voucherType: 'PKT', postingDate: iso, documentDate: iso, description: `Bán chịu USD ${stamp}`, currencyCode: 'USD', fxRate: '25000', autoPost: true,
    lines: [{ accountCode: '131', partyCode: code, debit: '2500000', credit: '0', amountCurrency: '100' }, { accountCode: '5113', debit: '0', credit: '2500000', amountCurrency: '-100' }] } });
  expect(invoice.ok(), await invoice.text()).toBeTruthy();

  await page.goto('/cong-no/ty-gia');
  await expect(page.getByRole('heading', { name: 'Công cụ tỷ giá' })).toBeVisible();

  // Tỷ giá xuất quỹ: chọn kỳ 12, chạy; không có tiền ngoại tệ xuất thì báo không chênh lệch, vẫn ghi nhật ký
  await page.getByRole('combobox', { name: 'Kỳ kế toán' }).click();
  await page.locator('.ant-select-item-option', { hasText: 'Kỳ 12 (' }).click();
  await page.getByRole('button', { name: 'Chạy điều chỉnh tỷ giá xuất quỹ' }).click();
  await expect(page.getByText(/Đã điều chỉnh tỷ giá xuất quỹ kỳ 12\/2026|Không có chênh lệch cần điều chỉnh ở kỳ 12\/2026/)).toBeVisible();
  await expect(page.locator('.ant-table-row', { hasText: '31/12/2026' }).first()).toContainText('12/2026');
  const outflowRuns = await (await request.get('/api/fx/runs?kind=outflow&limit=1')).json() as { periodNo: number; runDate: string }[];
  expect(outflowRuns[0]).toMatchObject({ periodNo: 12, runDate: '2026-12-31' });

  // Đánh giá lại: tỷ giá lấy sẵn từ danh mục theo ngày, nút Chạy khóa tới khi xem trước
  await page.getByRole('tab', { name: 'Đánh giá lại ngoại tệ' }).click();
  await page.getByLabel('Ngày đánh giá lại').fill(vn); await page.keyboard.press('Enter');
  await expect(page.getByLabel('Tỷ giá USD')).toHaveValue(new RegExp(`^${rate.slice(0, 2)}\\.${rate.slice(2)}`));
  await expect(page.locator('.ant-table-row', { hasText: 'USD - ' })).toContainText(vn);
  const run = page.getByRole('button', { name: 'Chạy đánh giá lại' });
  await expect(run).toBeDisabled();
  await page.getByRole('button', { name: 'Xem trước' }).click();
  const line = page.locator('.ag-center-cols-container .ag-row', { hasText: code });
  await expect(line).toContainText('USD'); await expect(line).toContainText('2.500.000');
  await expect(page.getByText(/Tổng chênh lệch:/)).toBeVisible();
  // Chưa ghi sổ: xem trước không sinh chứng từ
  expect((await (await request.get(`/api/open-items?accountCode=131&partyCode=${code}&asOf=2026-12-31&onlyOpen=true`)).json()).length).toBe(1);

  // Sửa tỷ giá thì bản xem trước cũ hết hiệu lực, phải xem trước lại
  await page.getByLabel('Tỷ giá USD').fill(`${Number(rate) + 100}`); await page.keyboard.press('Tab');
  await expect(run).toBeDisabled();
  await page.getByRole('button', { name: 'Xem trước' }).click();
  await expect(line).toBeVisible();
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByText('Đã đánh giá lại ngoại tệ')).toBeVisible();
  await expect(run).toBeDisabled(); // chạy xong lại phải xem trước
  await expect(page.locator('.ant-table-row', { hasText: vn }).first()).toContainText('12/2026');
  const revalRuns = await (await request.get('/api/fx/runs?kind=revaluation&limit=1')).json() as { runDate: string; voucherIds: string[] }[];
  expect(revalRuns[0]!.runDate).toBe(iso); expect(revalRuns[0]!.voucherIds.length).toBeGreaterThan(0);
});
