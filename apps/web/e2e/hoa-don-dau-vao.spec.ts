import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"
const FIXTURE = new URL('../../api/test/fixtures/xml/vn-einvoice-vat.xml', import.meta.url);

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Hóa đơn đầu vào: tải XML, xem dòng, lập hóa đơn mua nháp bằng Ctrl+S', async ({ page, request }) => {
  await signIn(page, request);
  // Mỗi lần chạy một số hóa đơn riêng để không trùng lần chạy trước (trùng tệp hoặc trùng khóa người bán, ký hiệu, số).
  const no = String(Date.now()).slice(-8);
  // Tên hàng cũng đổi theo lần chạy: ánh xạ hàng đã nhớ (người bán + tên hàng) sẽ điền sẵn tài khoản và làm nút Lập chứng từ không còn bị khóa.
  const xml = readFileSync(FIXTURE, 'utf8').replace(/<SHDon>\d+<\/SHDon>/, `<SHDon>${no}</SHDon>`)
    .replace('<THHDVu>Giấy in A4 70gsm</THHDVu>', `<THHDVu>Giấy in A4 70gsm ${no}</THHDVu>`)
    .replace('<THHDVu>Dịch vụ giao hàng</THHDVu>', `<THHDVu>Dịch vụ giao hàng ${no}</THHDVu>`);

  await page.goto('/hoa-don-dau-vao');
  await expect(page.getByRole('heading', { name: 'Hóa đơn đầu vào' })).toBeVisible();
  await page.locator('.inbound-drop input[type=file]').setInputFiles({ name: 'hoa-don.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await expect(page.getByRole('row', { name: /hoa-don\.xml/ })).toContainText('Mới');

  const row = page.getByRole('row', { name: new RegExp(no) });
  await expect(row).toContainText('Không có'); // tệp mẫu không có chữ ký người bán
  await row.getByRole('button', { name: 'Chi tiết' }).click();
  const drawer = page.locator('.ant-drawer');
  await expect(drawer).toContainText(`Giấy in A4 70gsm ${no}`);
  await expect(drawer).toContainText('1.430.000');
  await drawer.getByRole('button', { name: 'Lập chứng từ' }).click();

  const dlg = page.getByRole('dialog', { name: /Lập chứng từ mua hàng/ });
  await expect(dlg.getByRole('button', { name: /Lập chứng từ/ })).toBeDisabled(); // chưa chọn tài khoản cho các dòng
  // Dòng 1: F4 chọn từ danh mục; dòng 2: gõ thẳng mã vào ô của lưới.
  await dlg.locator('.ag-row[row-index="0"] .ag-cell[col-id="accountCode"]').click(); await page.keyboard.press('F4');
  await expect(page.getByRole('dialog', { name: 'Chọn từ danh mục' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Chọn từ danh mục' }).getByRole('combobox')).toBeFocused(); await page.keyboard.type('6422');
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: '6422' }).click();
  await expect(dlg.getByRole('button', { name: /Lập chứng từ/ })).toBeDisabled(); // dòng 2 vẫn thiếu tài khoản
  await dlg.locator('.ag-row[row-index="1"] .ag-cell[col-id="accountCode"]').click(); await page.keyboard.type('6422'); await page.keyboard.press('Tab');
  await dlg.getByLabel('Diễn giải').focus(); await page.keyboard.press('Control+s');

  await expect(page).toHaveURL(/\/chung-tu\/HDM\/[0-9a-f-]{36}/);
  const id = page.url().split('/').pop()!;
  const saved = await (await request.get(`/api/invoices/${id}`)).json() as { state: string; voucherType: string; totalDebit: string; invoices: { invoiceNo: string; baseAmount: string; taxAmount: string }[] };
  expect(saved).toMatchObject({ state: 'draft', voucherType: 'HDM', totalDebit: '1430000' });
  expect(saved.invoices).toMatchObject([{ invoiceNo: no, baseAmount: '1300000', taxAmount: '130000' }]);
});
