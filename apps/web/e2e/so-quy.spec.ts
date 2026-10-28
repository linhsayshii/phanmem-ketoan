import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { typeRange } from './helpers/dates.js';

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

const post = async (request: APIRequestContext, voucherType: string, postingDate: string, description: string, lines: object[]) => {
  const r = await request.post('/api/vouchers', { data: { voucherType, postingDate, documentDate: postingDate, description, lines, autoPost: true } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json() as Promise<{ id: string; voucherNo: string }>;
};

test('Sổ quỹ tiền mặt: xem một ngày, mở chứng từ, xuất Excel; phiếu thu hiện tồn quỹ', async ({ page, request }) => {
  await signIn(page, request);
  // Dữ liệu E2E dùng chung giữa các lần chạy: mỗi lần chọn một ngày tháng 12 và nhãn riêng để không lẫn với lần trước.
  const stamp = Date.now(); const day = String(1 + (Math.floor(stamp / 1000) % 28)).padStart(2, '0'); const iso = `2026-12-${day}`; const vn = `${day}/12/2026`;
  const pt = await post(request, 'PT', iso, `Thu sổ quỹ ${stamp}`, [{ accountCode: '1111', debit: '1000000', credit: '0' }, { accountCode: '5113', debit: '0', credit: '1000000' }]);
  const pc = await post(request, 'PC', iso, `Chi sổ quỹ ${stamp}`, [{ accountCode: '6422', debit: '400000', credit: '0' }, { accountCode: '1111', debit: '0', credit: '400000' }]);

  // Bộ lọc nhớ nạp từ máy chủ sau khi trang mở và ghi đè ô vừa nhập (lần chạy trước đã lưu ngày của nó): chờ bản nạp xong rồi mới nhập.
  const prefs = page.waitForResponse((r) => r.url().includes('/api/prefs/') && r.url().includes('cash-books'));
  await page.goto('/bao-cao/so-quy'); await prefs;
  await expect(page.getByRole('heading', { name: 'Sổ quỹ và tiền gửi' })).toBeVisible();
  // Khoảng ngày chỉ gồm ngày vừa lập: hai ô của bộ chọn khoảng ngày nhận chữ rồi Enter
  await typeRange(page, vn, vn);

  const thu = page.locator('.ag-center-cols-container .ag-row', { hasText: `Thu sổ quỹ ${stamp}` });
  const chi = page.locator('.ag-center-cols-container .ag-row', { hasText: `Chi sổ quỹ ${stamp}` });
  await expect(thu).toBeVisible(); await expect(chi).toBeVisible();
  await expect(thu).toContainText(pt.voucherNo); await expect(thu).toContainText('1.000.000');
  await expect(chi).toContainText(pc.voucherNo); await expect(chi).toContainText('400.000');

  // Tồn cuối kỳ trên màn hình khớp số máy chủ trả về cho cùng khoảng ngày
  const book = await (await request.get(`/api/reports/cash-book?accountCode=111&from=${iso}&to=${iso}`)).json() as { opening: string; closing: string; totalIn: string; totalOut: string };
  const fmt = (v: string) => v.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  await expect(page.getByText(/Tồn cuối kỳ/)).toContainText(fmt(book.closing));
  expect(BigInt(book.closing)).toBe(BigInt(book.opening) + BigInt(book.totalIn) - BigInt(book.totalOut));

  // Nhấn đúp dòng mở chứng từ ở tab mới
  const [popup] = await Promise.all([page.waitForEvent('popup'), thu.locator('[col-id="description"]').dblclick()]);
  await expect(popup).toHaveURL(new RegExp(`/chung-tu/PT/${pt.id}$`));
  await popup.close();

  // Xuất Excel cùng bộ lọc
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Xuất Excel' }).click()]);
  expect(download.url()).toContain('/api/reports/cash-book');
  expect(download.suggestedFilename()).toMatch(/^so-quy-111-.*\.xlsx$/);

  // Tab Sổ tiền gửi: chưa chọn tài khoản ngân hàng thì nhắc chọn
  await page.getByRole('tab', { name: 'Sổ tiền gửi' }).click();
  await expect(page.getByText('Chọn tài khoản ngân hàng để xem sổ')).toBeVisible();

  // Phiếu thu mới hiện tồn quỹ cuối ngày hạch toán
  await page.goto('/chung-tu/PT/moi');
  await expect(page.getByText(/Tồn quỹ cuối ngày/)).toBeVisible();
});
