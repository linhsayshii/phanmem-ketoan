import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"
const xml = readFileSync(new URL('../../api/test/fixtures/xml/vn-einvoice-vat.xml', import.meta.url));

async function signIn(page: Page, request: APIRequestContext) {
  const login = await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } });
  expect(login.ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}
const pkt = (request: APIRequestContext, date: string, description: string, debit: string) => request.post('/api/vouchers', { data: {
  voucherType: 'PKT', postingDate: date, documentDate: date, description, autoPost: true, lines: [{ accountCode: debit, debit: '1000000' }, { accountCode: '1111', credit: '1000000' }] } });

test('bút toán định kỳ: lập mẫu, xem trước, lập chứng từ nháp, chạy lại không sinh trùng', async ({ page, request }) => {
  await signIn(page, request);
  const code = `TL${Date.now().toString(36).toUpperCase()}`;
  await page.goto('/tro-ly');
  await expect(page.getByRole('heading', { name: 'Trợ lý' })).toBeVisible();
  await page.getByRole('button', { name: 'Thêm mẫu' }).click();
  await page.getByLabel('Mã mẫu').fill(code); await page.getByLabel('Tên mẫu').fill('Phân bổ chi phí thuê kho');
  const rows = page.locator('.ant-drawer .ant-table-tbody tr.ant-table-row');
  for (const [i, acc] of ['6422', '1111'].entries()) {
    await rows.nth(i).locator('.ant-select').first().click();
    await page.keyboard.type(acc);
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: acc }).first().click();
  }
  await page.getByLabel('Nợ dòng 1').fill('MAX(1000000, 300000 * SO_NGAY)'); await page.getByLabel('Có dòng 2').fill('MAX(1000000, 300000 * SO_NGAY)');
  await page.getByLabel('Ngày trong tháng').fill('15');
  const start = page.locator('.ant-drawer').getByLabel('Bắt đầu từ'); await start.fill('01/01/2026'); await page.keyboard.press('Enter');
  await page.locator('.ant-drawer').getByLabel('Lập bù các kỳ trước').click();
  await page.getByRole('button', { name: 'Lưu mẫu' }).click();
  await expect(page.locator('.ant-message').getByText('Đã lưu mẫu bút toán định kỳ')).toBeVisible();
  await expect(page.getByRole('button', { name: code })).toBeVisible();

  // Công thức sai bị từ chối ngay khi lưu, không để mẫu lỗi chạy ban đêm.
  await page.getByRole('button', { name: code }).click();
  await page.getByLabel('Nợ dòng 1').fill('1000 *');
  await page.getByRole('button', { name: 'Lưu mẫu' }).click();
  await expect(page.locator('.ant-message').getByText(/Công thức không hợp lệ/)).toBeVisible();
  await page.locator('.ant-drawer-close').click();

  await page.getByRole('button', { name: 'Chạy ngay' }).click();
  const dialog = page.getByRole('dialog', { name: 'Chạy bút toán định kỳ' });
  await dialog.getByLabel('Đến ngày').fill('31/01/2026'); await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: 'Xem trước' }).click();
  await expect(dialog.getByTestId('run-summary')).toContainText('Xem trước');
  await expect(dialog.getByRole('row', { name: new RegExp(`${code}.*2026-01.*Sẽ lập`) })).toBeVisible();
  await dialog.getByRole('button', { name: 'Lập chứng từ nháp' }).click();
  await expect(dialog.getByTestId('run-summary')).toContainText(/Đã lập [1-9]/);
  await expect(dialog.getByRole("row", { name: new RegExp(`${code}.*Đã lập nháp.*Mở chứng từ`) })).toBeVisible();
  await dialog.getByRole('button', { name: 'Lập chứng từ nháp' }).click(); // chạy lại: không sinh trùng
  await expect(dialog.getByTestId('run-summary')).toContainText('Đã lập 0');
  await dialog.getByRole('button', { name: 'Đóng' }).first().click();
  await expect(page.getByRole('row', { name: new RegExp(`${code}.*Đã lập nháp`) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(`${code}.*1 / 0 / 0`) })).toBeVisible();
});

test('nhận diện hóa đơn: XML đọc cục bộ có độ tin cậy; tệp nén bị chặn', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/tro-ly'); await page.getByRole('tab', { name: 'Nhận diện hóa đơn' }).click();
  const input = page.locator('input[type=file]');
  await input.setInputFiles({ name: 'hd.xml', mimeType: 'application/xml', buffer: xml });
  const result = page.getByTestId('recognize-result');
  await expect(result).toContainText('Kết quả nhận diện (xml, cục bộ)');
  await expect(result).toContainText('C26TAA'); await expect(result).toContainText('0100000001');
  await expect(result).toContainText('Cần soát lại trước khi dùng'); // mẫu thử không có chữ ký số
  await expect(page.getByRole('row', { name: /hd\.xml.*xml.*Không.*Thành công/ }).first()).toBeVisible();
  await input.setInputFiles({ name: 'bom.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\x03\x04xxxx') });
  await expect(page.getByTestId('recognize-error')).toContainText('Không nhận tệp nén');
  await expect(page.getByRole('row', { name: /bom\.zip.*RECOGNIZE_ZIP/ }).first()).toBeVisible();
});

test('gợi ý định khoản: ở trang Trợ lý và bằng Ctrl+G trên phiếu kế toán', async ({ page, request }) => {
  await signIn(page, request);
  const word = `kho${Date.now().toString(36)}`;
  for (const d of ['2026-02-10', '2026-03-10']) expect((await pkt(request, d, `Thuê ${word} tháng`, '6422')).ok()).toBeTruthy();
  await page.goto('/tro-ly'); await page.getByRole('tab', { name: 'Gợi ý định khoản' }).click();
  await page.getByLabel('Diễn giải').fill(`thuê ${word}`);
  await page.getByRole('button', { name: 'Gợi ý', exact: true }).click();
  const item = page.getByTestId('suggest-item').first();
  await expect(item).toContainText('Nợ 6422'); await expect(item).toContainText('Có 1111'); await expect(item).toContainText(/\d+ lần có diễn giải gần giống/);

  await page.goto('/chung-tu/PKT');
  await expect(page.getByRole('heading', { name: 'Phiếu kế toán' })).toBeVisible();
  await page.keyboard.press('Insert');
  await expect(page.getByText('Phiếu kế toán (mới)')).toBeVisible();
  await page.getByLabel('Diễn giải').fill(`Thuê ${word} tháng 4`);
  await page.keyboard.press('Control+g');
  const modal = page.getByRole('dialog', { name: 'Gợi ý định khoản' });
  await expect(modal.getByTestId('suggest-item').first()).toContainText('Nợ 6422');
  await modal.getByRole('button', { name: 'Dùng gợi ý này' }).first().click();
  await expect(modal).toBeHidden();
  await expect(page.locator('.ag-center-cols-container [col-id="accountCode"]', { hasText: '6422' })).toBeVisible(); // hasText: lưới có thể giữ tạm dòng trống cũ
  await expect(page.locator('.ag-center-cols-container [col-id="accountCode"]', { hasText: '1111' })).toBeVisible();
  await expect(page.getByText('Tổng Nợ: 0')).toBeVisible(); // chỉ điền tài khoản, số tiền do người dùng nhập
});
