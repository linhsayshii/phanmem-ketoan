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

const post = async (request: APIRequestContext, voucherType: string, postingDate: string, description: string, lines: object[]) => {
  const r = await request.post('/api/vouchers', { data: { voucherType, postingDate, documentDate: postingDate, description, lines, autoPost: true } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json() as Promise<{ id: string; voucherNo: string }>;
};

test('Đối trừ chứng từ: chọn khoản bằng bàn phím, Ctrl+S, hủy đối trừ, đối trừ tự động; chọn công nợ trên phiếu thu', async ({ page, request }) => {
  await signIn(page, request);
  // Dữ liệu E2E dùng chung giữa các lần chạy: mỗi lần một khách hàng riêng và một ngày tháng 12 để số liệu không lẫn.
  const stamp = Date.now(); const day = String(2 + (Math.floor(stamp / 1000) % 27)).padStart(2, '0'); const iso = `2026-12-${day}`; const vn = `${day}/12/2026`;
  const code = `KHDT${stamp}`;
  const made = await request.post('/api/catalogs/party', { data: { code, name: `Khách đối trừ ${stamp}`, is_customer: true } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const inv = await post(request, 'PKT', iso, `Bán chịu ${stamp}`, [{ accountCode: '131', partyCode: code, debit: '5000000', credit: '0' }, { accountCode: '5113', debit: '0', credit: '5000000' }]);
  const rcpt = await post(request, 'PT', iso, `Thu nợ ${stamp}`, [{ accountCode: '1111', debit: '2000000', credit: '0' }, { accountCode: '131', partyCode: code, debit: '0', credit: '2000000' }]);
  const residuals = async () => {
    const items = await (await request.get(`/api/open-items?accountCode=131&partyCode=${code}&asOf=${iso}&onlyOpen=true`)).json() as { docNo: string | null; voucherNo: string | null; residual: string }[];
    return Object.fromEntries(items.map((i) => [i.docNo ?? i.voucherNo, i.residual]));
  };
  expect(await residuals()).toEqual({ [inv.voucherNo]: '5000000', [rcpt.voucherNo]: '-2000000' });

  // Bộ lọc nhớ nạp từ máy chủ sau khi trang mở và ghi đè ô vừa nhập: chờ bản nạp xong rồi mới nhập.
  const prefs = page.waitForResponse((r) => r.url().includes('/api/prefs/') && r.url().includes('settlement'));
  await page.goto('/cong-no/doi-tru'); await prefs;
  await expect(page.getByRole('heading', { name: 'Đối trừ chứng từ' })).toBeVisible();
  await page.getByText('Phải thu (131)').click();
  await page.getByRole('combobox', { name: 'Đối tượng (F4)' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type(code);
  await page.locator('.ant-select-item-option', { hasText: code }).click();
  // Khoản lập sau hôm nay chỉ hiện khi chọn ngày đối trừ từ ngày lập trở đi
  await page.getByLabel('Ngày đối trừ').fill(vn); await page.keyboard.press('Enter');

  const debitGrid = page.getByRole('region', { name: 'Phát sinh Nợ còn dư' }); const creditGrid = page.getByRole('region', { name: 'Phát sinh Có còn dư' });
  const invRow = debitGrid.locator('.ag-center-cols-container .ag-row', { hasText: inv.voucherNo });
  const rcptRow = creditGrid.locator('.ag-center-cols-container .ag-row', { hasText: rcpt.voucherNo });
  await expect(invRow).toContainText('5.000.000'); await expect(rcptRow).toContainText('2.000.000');
  await expect(page.getByRole('button', { name: 'Đối trừ (Ctrl+S)' })).toBeDisabled();

  // Có: Enter ở ô trống lấy đủ số còn dư. Nợ: gõ 2.000.000 trên hóa đơn 5.000.000 (đối trừ một phần). Lệch thì khóa nút và hiện chênh lệch.
  await rcptRow.locator('[col-id="pick"]').click(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await expect(page.getByText(/Tổng Có chọn/)).toContainText('2.000.000');
  await expect(page.getByText(/Chênh lệch:/)).toContainText('2.000.000');
  await expect(page.getByRole('button', { name: 'Đối trừ (Ctrl+S)' })).toBeDisabled();
  await invRow.locator('[col-id="pick"]').click(); await page.keyboard.type('2000000'); await page.keyboard.press('Enter');
  await expect(page.getByText(/Tổng Nợ chọn/)).toContainText('2.000.000');
  await expect(page.getByRole('button', { name: 'Đối trừ (Ctrl+S)' })).toBeEnabled();

  await page.keyboard.press('Control+s');
  await expect(page.getByText('Đã đối trừ 1 cặp')).toBeVisible();
  expect(await residuals()).toEqual({ [inv.voucherNo]: '3000000' });

  // Đã đối trừ: thấy nhóm vừa tạo, hủy có hộp xác nhận, công nợ trở lại như cũ
  await page.getByRole('tab', { name: 'Đã đối trừ' }).click();
  const group = page.locator('.ant-table-row', { hasText: inv.voucherNo });
  await expect(group).toContainText('2.000.000'); await expect(group).toContainText('Thủ công');
  await group.getByRole('button', { name: 'Hủy đối trừ' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận hủy' }).click();
  await expect(page.locator('.ant-message').getByText('Đã hủy đối trừ')).toBeVisible();
  await expect.poll(residuals).toEqual({ [inv.voucherNo]: '5000000', [rcpt.voucherNo]: '-2000000' });

  // Đối trừ tự động: ghép theo ngày chứng từ đến ngày đối trừ đã chọn
  await page.getByRole('button', { name: 'Đối trừ tự động' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Thực hiện' }).click();
  await expect(page.locator('.ant-message').getByText(/Đã đối trừ tự động 1 nhóm/)).toBeVisible();
  await expect.poll(residuals).toEqual({ [inv.voucherNo]: '3000000' });
  await expect(page.locator('.ant-table-row', { hasText: inv.voucherNo }).first()).toContainText('Tự động');

  // Phiếu thu mới: chọn chứng từ công nợ của khách ở dòng 131, ghi kế hoạch đối trừ vào dòng rồi lưu; ghi sổ phiếu thì đối trừ khoản còn lại của hóa đơn.
  await page.goto('/chung-tu/PT/moi');
  await expect(page.getByText('Phiếu thu (mới)')).toBeVisible();
  await page.getByLabel('Ngày hạch toán').fill(vn); await page.keyboard.press('Enter');
  await page.getByLabel('Mục đích').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); // Thu tiền khách hàng: điền TK 131 vào dòng 2
  await expect(page.locator('.ag-center-cols-container [col-id="accountCode"]', { hasText: '131' })).toBeVisible();
  await page.getByLabel('Đối tượng').focus(); await page.keyboard.press('F4'); await page.keyboard.type(code);
  await page.locator('.ant-select-item-option', { hasText: code }).click();
  await page.locator('.ag-center-cols-container .ag-row[row-index="0"] [col-id="debit"]').click();
  await page.keyboard.type('3000000'); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /Chọn chứng từ công nợ/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Chọn chứng từ công nợ' });
  const pick = dialog.locator('.ag-center-cols-container .ag-row', { hasText: inv.voucherNo });
  await expect(pick).toContainText('3.000.000');
  await expect(dialog.getByText(rcpt.voucherNo)).toHaveCount(0); // chỉ khoản Nợ của đối tượng, TK 131: phiếu thu cũ (khoản Có) không có trong danh sách
  await pick.locator('[col-id="pick"]').click(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await expect(dialog.getByText(/Tổng chọn đối trừ/)).toContainText('3.000.000');
  await expect(dialog.getByRole('button', { name: /^Áp dụng/ })).toBeEnabled();
  await page.keyboard.press('Control+s'); // Ctrl+S trong hộp thoại = Áp dụng, không lưu chứng từ phía sau
  await expect(dialog).toBeHidden(); // phím tắt Ctrl+S bị bỏ qua khi tiêu điểm còn trong hộp thoại đang đóng
  await expect(page.locator('.ant-message').getByText('Đã lưu')).toHaveCount(0);
  await page.keyboard.press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu')).toBeVisible();
  await expect(page).toHaveURL(/PT\/[0-9a-f-]{36}$/);
  await expect(page.locator('.ag-center-cols-container [col-id="accountCode"]', { hasText: '131' })).toBeVisible();
  await page.keyboard.press('F9');
  await expect(page.locator('.ant-message').getByText('Đã ghi sổ')).toBeVisible();
  await expect.poll(residuals).toEqual({});
});
