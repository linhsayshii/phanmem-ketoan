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

test('Hóa đơn bán dịch vụ: nhập bằng bàn phím, thuế tự tính, bút toán xem trước, ghi sổ, công nợ phải thu', async ({ page, request }) => {
  await signIn(page, request);
  // Dữ liệu E2E dùng chung giữa các lần chạy: mỗi lần một khách hàng, một số hóa đơn và một ngày tháng 12 riêng để số liệu không lẫn.
  const stamp = Date.now(); const day = String(2 + (Math.floor(stamp / 1000) % 27)).padStart(2, '0'); const iso = `2026-12-${day}`; const vn = `${day}/12/2026`;
  const code = `KHHD${stamp}`; const name = `Khách hóa đơn ${stamp}`; const invoiceNo = String(stamp).slice(-8); const desc = `Bán dịch vụ tư vấn ${stamp}`;
  const made = await request.post('/api/catalogs/party', { data: { code, name, is_customer: true, tax_code: '0100109106', address: '12 Phố Huế, Hà Nội' } });
  expect(made.ok(), await made.text()).toBeTruthy();

  await page.goto('/chung-tu/HDB');
  await expect(page.getByRole('heading', { name: 'Hóa đơn bán dịch vụ' })).toBeVisible(); // phím tắt Insert chỉ có tác dụng sau khi trang đã dựng xong
  await page.keyboard.press('Insert');
  await expect(page.getByText('Hóa đơn bán dịch vụ (mới)')).toBeVisible();
  for (const label of ['Ngày hạch toán', 'Ngày chứng từ']) { await page.getByLabel(label).fill(vn); await page.keyboard.press('Enter'); }
  await page.getByLabel('Diễn giải', { exact: true }).fill(desc);
  await page.getByRole('combobox', { name: 'Đối tượng' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type(code); // lọc theo mã: các lần chạy trước để lại nhiều khách
  await page.locator('.ant-select-item-option', { hasText: code }).click();

  // Dòng hàng bằng bàn phím: Enter sang ô kế; số lượng x đơn giá ra thành tiền ngay trong khi con trỏ sang ô khác; mã thuế chọn bằng F4
  const cell = (col: string) => page.locator(`.ag-center-cols-container .ag-row[row-index="0"] [col-id="${col}"]`);
  await cell('description').click(); await page.keyboard.type('Phí tư vấn tháng 12'); await page.keyboard.press('Enter');
  await page.keyboard.type('5113'); await page.keyboard.press('Enter');
  await page.keyboard.type('2'); await page.keyboard.press('Enter');
  await page.keyboard.type('500000'); await page.keyboard.press('Enter');
  await expect(cell('amount').getByRole('textbox')).toHaveValue('1.000.000'); // con trỏ đã sang ô Thành tiền (đang sửa), ô hiện số lượng x đơn giá
  for (let i = 0; i < 3; i++) await page.keyboard.press('Enter'); // qua Thành tiền, % chiết khấu, tiền chiết khấu tới Mã thuế
  await page.keyboard.press('F4'); await expect(page.getByRole('dialog').getByRole('combobox')).toBeFocused(); await page.keyboard.type('V10'); // F4 trong lưới mở hộp chọn: chờ con trỏ vào ô tìm rồi mới gõ
  await page.locator('.ant-select-item-option', { hasText: /^V10/ }).click();
  await expect(page.locator('.ag-center-cols-container .ag-row')).toHaveCount(1); // chọn từ hộp thay đối tượng dòng: dòng cũ mờ dần trước khi bị gỡ
  await expect(cell('taxCodes')).toContainText('V10');
  await expect(cell('taxAmount')).toContainText('100.000');
  await expect(page.getByText(/Tiền thuế:/)).toContainText('100.000');

  // Tab Thuế: thuế ghi trên hóa đơn lệch 1.000 đồng thì báo lỗi ngay (động cơ thuế của máy chủ), khớp lại thì hết lỗi
  await page.getByRole('tab', { name: 'Thuế' }).click();
  await page.getByLabel('Thuế ghi trên hóa đơn V10').fill('101000');
  await expect(page.getByRole('alert')).toContainText('TAX_DECLARED_MISMATCH');
  await page.getByLabel('Thuế ghi trên hóa đơn V10').fill('100000');
  await expect(page.getByRole('alert')).toHaveCount(0);

  // Tab Hóa đơn: mã số thuế, tên, địa chỉ lấy từ đối tượng; nhóm kê khai tự chọn theo thuế suất
  await page.getByRole('tab', { name: 'Hóa đơn' }).click();
  await expect(page.getByLabel('Mã số thuế')).toHaveValue('0100109106');
  await expect(page.getByLabel('Tên đơn vị')).toHaveValue(name);
  await expect(page.getByLabel('Địa chỉ', { exact: true })).toHaveValue('12 Phố Huế, Hà Nội');
  await page.getByLabel('Mẫu số', { exact: true }).fill('1'); await page.getByLabel('Ký hiệu', { exact: true }).fill('C26TAA');
  await page.getByLabel('Số hóa đơn', { exact: true }).fill(invoiceNo);
  await page.getByLabel('Ngày hóa đơn', { exact: true }).fill(vn); await page.keyboard.press('Enter');

  // Tab Hạch toán: Nợ 131 / Có 5113 / Có 33311
  await page.getByRole('tab', { name: 'Hạch toán' }).click();
  const ledger = page.getByTestId('ledger-preview');
  await expect(ledger.locator('tbody tr.ant-table-row', { hasText: '131' })).toContainText('1.100.000');
  await expect(ledger.locator('tbody tr.ant-table-row', { hasText: '5113' })).toContainText('1.000.000');
  await expect(ledger.locator('tbody tr.ant-table-row', { hasText: '33311' })).toContainText('100.000');

  await page.keyboard.press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu')).toBeVisible();
  await expect(page).toHaveURL(/HDB\/[0-9a-f-]{36}$/);
  // chờ chứng từ tải xong rồi mới bấm F9: trang vừa dựng lại, lưới còn dòng khởi tạo tới khi GET trả về
  await page.getByRole('tab', { name: 'Hàng tiền' }).click();
  await expect(page.locator('.ag-center-cols-container [col-id="accountCode"]', { hasText: '5113' })).toBeVisible();
  await page.keyboard.press('F9');
  await expect(page.locator('.ant-message').getByText('Đã ghi sổ')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/HDB\d+/);
  await expect(page.getByRole('button', { name: 'Đảo' })).toBeVisible();
  const id = /HDB\/([0-9a-f-]{36})$/.exec(page.url())![1];
  const saved = await (await request.get(`/api/invoices/${id}`)).json() as { voucherNo: string; state: string; invoices: { invoiceGroupCode: string; taxAmount: string; baseAmount: string; partyTaxCode: string }[] };
  expect(saved.state).toBe('posted');
  expect(saved.invoices).toMatchObject([{ invoiceGroupCode: '10', baseAmount: '1000000', taxAmount: '100000', partyTaxCode: '0100109106' }]);

  // Báo cáo công nợ: sổ chi tiết 131 của khách có khoản phải thu 1.100.000 (tiền hàng + thuế)
  const prefs = page.waitForResponse((r) => r.url().includes('/api/prefs/') && r.url().includes('arap-reports'));
  await page.goto('/cong-no/bao-cao'); await prefs;
  await expect(page.getByRole('heading', { name: 'Báo cáo công nợ' })).toBeVisible();
  await typeRange(page, vn, vn);
  await page.getByRole('combobox', { name: 'Đối tượng (F4)' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type(code);
  await page.locator('.ant-select-item-option', { hasText: code }).click();
  const row = page.locator('.ag-center-cols-container .ag-row', { hasText: saved.voucherNo });
  await expect(row).toBeVisible(); await expect(row).toContainText('1.100.000');
  await expect(page.getByText(/Dư cuối kỳ/)).toContainText('1.100.000');
  const detail = await (await request.get(`/api/reports/arap/detail?accountCode=131&partyCode=${code}&from=${iso}&to=${iso}`)).json() as { closing: string };
  expect(detail.closing).toBe('1100000');
});
