import { createHmac } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phieu-thu.spec.ts (tài khoản e2e). Mỗi lần chạy một tài khoản ngân hàng, khách hàng, số hóa đơn riêng.
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

// Như sepayBody / sepaySign trong apps/api/test/bank/helpers.ts: SePay ký HMAC-SHA256 trên `${timestamp}.${thân}`.
const sepayBody = (o: Record<string, unknown>) => JSON.stringify({ gateway: 'Vietcombank', transactionDate: '2026-08-12 10:00:00', subAccount: '', code: null, transferType: 'in', accumulated: 50000000, referenceCode: 'FT26E2E', ...o });
function sepaySign(secret: string, body: string) {
  const ts = Math.floor(Date.now() / 1000);
  return { 'content-type': 'application/json', 'x-sepay-timestamp': String(ts), 'x-sepay-signature': `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}` };
}

test('Ngân hàng: kết nối SePay, nhận giao dịch qua webhook, lập Giấy báo Có đối trừ hóa đơn, mã QR thanh toán', async ({ page, request }) => {
  await signIn(page, request);
  const stamp = String(Date.now()).slice(-9);
  const accountNo = `9${stamp}`; const party = `KHNH${stamp}`; const invoiceNo = stamp.slice(-8);
  await request.post('/api/catalogs/bank', { data: { code: 'VCBQR', name: 'Vietcombank QR', napas_bin: '970436' } });
  const bank = (await (await request.get('/api/catalogs/bank?q=VCBQR')).json() as { rows: { id: string | number; code: string; napas_bin: string | null }[] }).rows.find((r) => r.code === 'VCBQR')!;
  if (bank.napas_bin !== '970436') expect((await request.put(`/api/catalogs/bank/${bank.id}`, { data: { napas_bin: '970436' } })).ok()).toBeTruthy(); // ngân hàng có từ lần chạy trước
  expect((await request.post('/api/catalogs/bank_account', { data: { bank_code: 'VCBQR', account_no: accountNo, account_name: `E2E NH ${stamp}`, gl_account_code: '1121' } })).ok()).toBeTruthy();
  expect((await request.post('/api/catalogs/party', { data: { code: party, name: `Khách hàng ngân hàng ${stamp}`, is_customer: true } })).ok()).toBeTruthy();
  const hd = await request.post('/api/invoices', { data: { voucherType: 'HDB', postingDate: '2026-08-10', documentDate: '2026-08-10', partyCode: party, autoPost: true,
    items: [{ description: 'Dịch vụ E2E', accountCode: '5113', amountCurrency: '1000000', taxCodes: ['V10'] }],
    invoice: { serial: 'C26TNH', invoiceNo, invoiceDate: '2026-08-10', invoiceGroupCode: '10' } } });
  expect(hd.ok(), await hd.text()).toBeTruthy();
  const invoiceId = (await hd.json()).id as string;

  // Kết nối SePay HMAC trên giao diện; địa chỉ webhook và khóa hiện một lần.
  await page.goto('/ngan-hang/ket-noi');
  await expect(page.getByRole('heading', { name: 'Kết nối ngân hàng' })).toBeVisible();
  await page.getByRole('button', { name: 'Thêm kết nối' }).click();
  const add = page.getByRole('dialog', { name: 'Thêm kết nối ngân hàng' });
  await add.getByLabel('Tài khoản ngân hàng').click(); await page.keyboard.type(accountNo);
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: accountNo }).click();
  await add.getByRole('button', { name: 'Tạo kết nối' }).click();
  const keys = page.getByRole('dialog', { name: 'Địa chỉ webhook và khóa' });
  const hookUrl = await keys.getByLabel('Địa chỉ webhook').inputValue();
  const secret = await keys.getByLabel('Khóa bí mật').inputValue();
  expect(hookUrl).toContain('/api/hooks/bank/'); expect(secret.length).toBeGreaterThan(10);
  await keys.getByRole('button', { name: 'Đã lưu, đóng' }).click();
  await expect(page.getByRole('row', { name: new RegExp(accountNo) })).toContainText('SePay');

  // SePay gọi webhook với chữ ký đúng: giao dịch vào hộp thư.
  const body = sepayBody({ id: Number(stamp), accountNumber: accountNo, transferAmount: 1100000, content: `Thanh toan HD ${invoiceNo}`, description: `KHACH CHUYEN KHOAN HD ${invoiceNo}` });
  const hook = await request.post(new URL(hookUrl).pathname, { headers: sepaySign(secret, body), data: body });
  expect(hook.ok(), await hook.text()).toBeTruthy();

  await page.goto('/ngan-hang/giao-dich');
  await expect(page.getByRole('heading', { name: 'Giao dịch ngân hàng' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Tài khoản ngân hàng' }).click({ force: true }); await page.keyboard.type(accountNo);
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: accountNo }).click();
  await page.getByRole('combobox', { name: 'Trạng thái' }).click({ force: true });
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: 'Mới' }).click();
  const row = page.getByRole('row', { name: new RegExp(invoiceNo) });
  await expect(row).toContainText('1.100.000'); await expect(row).toContainText('Mới');
  await row.click();

  // Lập Giấy báo Có: chọn đối tượng, tick khoản công nợ, Ctrl+S ghi sổ.
  await page.getByRole('button', { name: 'Lập Giấy báo Có' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Lập Giấy báo Có' });
  await dlg.getByRole('combobox', { name: 'Đối tượng' }).click(); await page.keyboard.type(party);
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: party }).click();
  await dlg.locator('tbody tr', { hasText: '1.100.000' }).getByRole('checkbox').check();
  await expect(dlg).toContainText('Đối trừ 1.100.000');
  await dlg.getByLabel('Diễn giải').focus(); await page.keyboard.press('Control+s');
  await expect(page.getByText('Đã lập và ghi sổ Giấy báo Có')).toBeVisible();
  await expect(dlg).toBeHidden();

  await page.getByRole('combobox', { name: 'Trạng thái' }).click({ force: true });
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: 'Đã đối chiếu' }).click();
  await expect(page.getByRole('row', { name: new RegExp(invoiceNo) })).toContainText('Đã đối chiếu');

  // Hóa đơn bán đã ghi sổ: mã QR thanh toán (nay đã thu đủ nên không còn khoản phải thu, báo lỗi rõ ràng).
  await page.goto(`/chung-tu/HDB/${invoiceId}`);
  await page.getByRole('button', { name: 'Mã QR thanh toán' }).click();
  await expect(page.getByText('Hóa đơn không còn khoản phải thu')).toBeVisible();

  // Hóa đơn thứ hai chưa thu tiền: hiện mã QR với số tiền còn phải thu.
  const hd2 = await request.post('/api/invoices', { data: { voucherType: 'HDB', postingDate: '2026-08-11', documentDate: '2026-08-11', partyCode: party, autoPost: true,
    items: [{ description: 'Dịch vụ E2E 2', accountCode: '5113', amountCurrency: '500000', taxCodes: ['V10'] }],
    invoice: { serial: 'C26TNH', invoiceNo: `${invoiceNo.slice(1)}9`, invoiceDate: '2026-08-11', invoiceGroupCode: '10' } } });
  expect(hd2.ok(), await hd2.text()).toBeTruthy();
  await page.goto(`/chung-tu/HDB/${(await hd2.json()).id}`);
  await page.getByRole('button', { name: 'Mã QR thanh toán' }).click();
  const qr = page.getByTestId('vietqr');
  await expect(qr.getByLabel('Mã QR thanh toán')).toBeVisible();
  await expect(qr).toContainText('550.000'); await expect(qr).toContainText('STK:');
});
