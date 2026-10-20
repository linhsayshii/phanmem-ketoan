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

const fmt = (v: bigint) => v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

test('Kiểm kê quỹ: nhập mệnh giá, tổng tự tính, lưu, xử lý chênh lệch ra chứng từ nháp, in bảng kiểm kê', async ({ page, request }) => {
  await signIn(page, request);
  // Dữ liệu E2E dùng chung giữa các lần chạy: mỗi lần chọn một ngày tháng 12 riêng; tồn quỹ cuối ngày đọc từ máy chủ nên không phụ thuộc lần chạy trước.
  const day = String(1 + (Math.floor(Date.now() / 1000) % 28)).padStart(2, '0'); const iso = `2026-12-${day}`; const vn = `${day}/12/2026`;
  const book = BigInt(((await (await request.get(`/api/cash/balance?accountCode=1111&asOf=${iso}&currency=VND`)).json()) as { balance: string }).balance);
  // 2 tờ 500.000 + 3 tờ 200.000 + 3 tờ 1.000 = 1.603.000 (đổi sang 4 tờ 1.000 nếu tình cờ khớp sổ để luôn có chênh lệch)
  const sheets1k = book === 1_603_000n ? 4 : 3;
  const counted = 1_000_000n + 600_000n + BigInt(sheets1k) * 1000n; const diff = counted - book;

  await page.goto('/quy/kiem-ke');
  await expect(page.getByRole('heading', { name: 'Kiểm kê quỹ' })).toBeVisible();
  await page.getByLabel('Ngày kiểm kê').fill(vn); await page.keyboard.press('Enter');
  await page.getByLabel('Tài khoản quỹ').focus(); await page.keyboard.press('F4');
  await page.locator('.ant-select-item-option', { hasText: /^1111 -/ }).click();
  await expect(page.getByTestId('cc-book')).toHaveText(fmt(book));

  // Lưới mệnh giá có sẵn 9 mệnh giá VND; nhập số lượng ở cột "Số lượng (tờ)" của dòng 500.000, 200.000, 1.000
  const qty = (rowIndex: number) => page.locator(`.ag-center-cols-container .ag-row[row-index="${rowIndex}"] [col-id="qty"]`);
  for (const [row, n] of [[0, 2], [1, 3], [8, sheets1k]] as const) {
    await qty(row).click(); await page.keyboard.press('Control+a'); await page.keyboard.type(String(n)); await page.keyboard.press('Tab');
  }
  await expect(page.getByTestId('cc-counted')).toHaveText(fmt(counted));
  await expect(page.locator('.ag-center-cols-container .ag-row[row-index="0"] [col-id="amount"]')).toHaveText('1.000.000');
  await expect(page.getByTestId('cc-diff')).toHaveText(fmt(diff));
  await expect(page.getByText(diff > 0n ? 'Thừa' : 'Thiếu', { exact: true })).toBeVisible();

  await page.getByLabel('Thành viên kiểm kê').fill('Nguyễn Văn A, Thủ quỹ\nTrần Thị B, Kế toán trưởng');
  await page.getByLabel('Ghi chú').fill(`Kiểm kê E2E ${Date.now()}`);
  await page.keyboard.press('Control+s');
  const saved = page.locator('.ant-message').getByText(/Đã lưu kiểm kê quỹ số \d+/);
  await expect(saved).toBeVisible();
  const id = /số (\d+)/.exec((await saved.textContent())!)![1];
  await expect(page.getByRole('button', { name: 'Kiểm kê mới' })).toBeVisible();

  // Xử lý chênh lệch: lập chứng từ nháp (thừa: Phiếu thu, thiếu: Phiếu chi)
  await page.getByRole('button', { name: 'Xử lý chênh lệch' }).click();
  await page.getByRole('button', { name: 'Lập chứng từ' }).click();
  const kind = diff > 0n ? 'Phiếu thu' : 'Phiếu chi';
  await expect(page.getByText('Đã xử lý bằng')).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(kind) })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Xử lý chênh lệch' })).toHaveCount(0); // chỉ xử lý một lần
  const count = await (await request.get(`/api/cash-counts/${id}`)).json() as { voucherId: string; voucherState: string; difference: string };
  expect(count.voucherState).toBe('draft'); expect(BigInt(count.difference)).toBe(diff);

  // Bảng kiểm kê quỹ in theo mẫu 08a - TT (công ty thử dùng chế độ TT133)
  const printed = await request.get(`/api/cash-counts/${id}/print?format=html`);
  expect(printed.ok()).toBeTruthy();
  const html = await printed.text();
  for (const t of ['Mẫu số 08a - TT', 'BẢNG KIỂM KÊ QUỸ', 'Nguyễn Văn A', fmt(counted)]) expect(html).toContain(t);

  // Danh sách các lần kiểm kê có dòng vừa lập
  await expect(page.locator('.ant-table-row', { hasText: vn }).first()).toBeVisible();
});
