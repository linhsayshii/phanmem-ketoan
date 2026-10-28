import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { typeDate, typeRange } from './helpers/dates.js';

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

test('Báo cáo công nợ: sổ chi tiết, tổng hợp, tuổi nợ, đối chiếu; in biên bản và thư nhắc nợ', async ({ page, request }) => {
  await signIn(page, request);
  // Dữ liệu E2E dùng chung giữa các lần chạy: mỗi lần một khách hàng riêng (mã theo thời điểm) và một ngày tháng 12 để số liệu không lẫn.
  const stamp = Date.now(); const day = String(2 + (Math.floor(stamp / 1000) % 27)).padStart(2, '0'); const iso = `2026-12-${day}`; const vn = `${day}/12/2026`;
  const code = `KHCN${stamp}`;
  const made = await request.post('/api/catalogs/party', { data: { code, name: `Khách công nợ ${stamp}`, is_customer: true } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const inv = await post(request, 'PKT', iso, `Bán chịu ${stamp}`, [{ accountCode: '131', partyCode: code, debit: '5000000', credit: '0', dueDate: '2026-12-01' }, { accountCode: '5113', debit: '0', credit: '5000000' }]);
  const rcpt = await post(request, 'PT', iso, `Thu nợ ${stamp}`, [{ accountCode: '1111', debit: '2000000', credit: '0' }, { accountCode: '131', partyCode: code, debit: '0', credit: '2000000' }]);

  // Bộ lọc nhớ của lần chạy trước giữ ngày khác: đặt sẵn ngày của lần này (gõ vào RangePicker đôi khi không phát onChange khi chạy nhanh).
  expect((await request.put('/api/prefs/filter:arap-reports', { data: { value: { from: iso, to: iso, asOf: iso, accountCode: '131', partyCode: '' } } })).ok()).toBeTruthy();
  // Bộ lọc nhớ nạp từ máy chủ sau khi trang mở và ghi đè ô vừa nhập: chờ bản nạp xong rồi mới nhập.
  const prefs = page.waitForResponse((r) => r.url().includes('/api/prefs/') && r.url().includes('arap-reports'));
  await page.goto('/cong-no/bao-cao'); await prefs;
  await expect(page.getByRole('heading', { name: 'Báo cáo công nợ' })).toBeVisible();
  await typeRange(page, vn, vn);

  // Sổ chi tiết: chọn khách bằng F4 rồi gõ mã để lọc danh sách (bộ lọc nhớ có thể đã giữ khách của lần chạy trước, chọn mới sẽ thay)
  await page.getByRole('combobox', { name: 'Đối tượng (F4)' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type(code);
  await page.locator('.ant-select-item-option', { hasText: code }).click();
  const hd = page.locator('.ag-center-cols-container .ag-row', { hasText: `Bán chịu ${stamp}` });
  const thu = page.locator('.ag-center-cols-container .ag-row', { hasText: `Thu nợ ${stamp}` });
  await expect(hd).toBeVisible(); await expect(thu).toBeVisible();
  await expect(hd).toContainText(inv.voucherNo); await expect(hd).toContainText('5.000.000');
  await expect(thu).toContainText(rcpt.voucherNo); await expect(thu).toContainText('2.000.000');
  await expect(page.getByText(/Dư cuối kỳ/)).toContainText('3.000.000');
  const detail = await (await request.get(`/api/reports/arap/detail?accountCode=131&partyCode=${code}&from=${iso}&to=${iso}`)).json() as { closing: string };
  expect(detail.closing).toBe('3000000');

  // Tổng hợp: có dòng của khách, Σ dư cuối khớp số dư tài khoản 131
  await page.getByRole('tab', { name: 'Tổng hợp' }).click();
  const row = page.locator('.ag-center-cols-container .ag-row', { hasText: code });
  await expect(row).toBeVisible(); await expect(row).toContainText('3.000.000');
  await expect(page.getByText(/Khớp số dư tài khoản 131/)).toBeVisible();

  // Tuổi nợ tính đến cuối ngày lập: hóa đơn hạn 01/12 quá 1 đến 30 ngày còn 5.000.000; phiếu thu chưa đối trừ là khoản dư Có 2.000.000; chọn khách để xem từng khoản
  await page.getByRole('tab', { name: 'Tuổi nợ' }).click();
  await typeDate(page, page.getByLabel('Tính đến ngày'), vn);
  await page.getByRole('combobox', { name: 'Đối tượng (không bắt buộc)' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type(code);
  await page.locator('.ant-select-item-option', { hasText: code }).click();
  await expect(page.getByText(`Các khoản còn nợ của đối tượng ${code}`)).toBeVisible();
  const aged = page.locator('.ag-center-cols-container .ag-row', { hasText: inv.voucherNo });
  await expect(aged).toContainText('5.000.000'); await expect(aged).toContainText('01/12/2026');
  await expect(page.locator('.ag-center-cols-container .ag-row', { hasText: rcpt.voucherNo })).toContainText('2.000.000');
  const aging = await (await request.get(`/api/reports/arap/aging?accountCode=131&partyCode=${code}&asOf=${iso}`)).json() as { totals: { b0: string; credit: string; total: string } };
  expect([aging.totals.b0, aging.totals.credit, aging.totals.total]).toEqual(['5000000', '-2000000', '3000000']);

  // Đối chiếu: kết luận ai còn nợ ai; In biên bản mở PDF ở tab mới, Thư nhắc nợ mở PDF thư
  await page.getByRole('tab', { name: 'Đối chiếu' }).click();
  await expect(page.getByText(/Đối tượng còn nợ công ty 3\.000\.000 đồng/)).toBeVisible();
  const [statement] = await Promise.all([page.context().waitForEvent('request', (r) => r.url().includes('/api/reports/arap/statement?')), page.getByRole('button', { name: 'In biên bản' }).click()]);
  expect(statement.url()).toContain(`partyCode=${code}`); expect(statement.url()).toContain('accountCode=131');
  const pdf = await request.get(`/api/reports/arap/statement?accountCode=131&partyCode=${code}&from=${iso}&to=${iso}`);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  const [reminder] = await Promise.all([page.context().waitForEvent('request', (r) => r.url().includes('/api/reports/arap/reminder?')), page.getByRole('button', { name: 'Thư nhắc nợ' }).click()]);
  expect(reminder.url()).toContain(`partyCode=${code}`);
  for (const p of page.context().pages()) if (p !== page) await p.close();

  // Menu "Công nợ" dẫn tới màn này
  await page.goto('/');
  await page.getByRole('menuitem', { name: 'Công nợ' }).click();
  await page.getByRole('menuitem', { name: 'Báo cáo công nợ' }).click();
  await expect(page).toHaveURL(/\/cong-no\/bao-cao$/);
});
