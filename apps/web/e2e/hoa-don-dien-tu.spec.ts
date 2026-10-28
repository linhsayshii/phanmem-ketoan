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

test('Hóa đơn điện tử: cấu hình nhà cung cấp giả lập và ký hiệu, lập HDB, phát hành, tra mã CQT, lập điều chỉnh từ GGB', async ({ page, request }) => {
  await signIn(page, request);
  // Dữ liệu E2E dùng chung giữa các lần chạy: nhà cung cấp và ký hiệu 1C26TAA chỉ tạo nếu chưa có (ký hiệu đã dùng thì không xóa được).
  let providers = await (await request.get('/api/einvoice/providers')).json() as { id: number; code: string }[];
  if (!providers.some((p) => p.code === 'fake')) {
    const made = await request.post('/api/einvoice/providers', { data: { code: 'fake', name: 'Giả lập E2E', baseUrl: '', username: '', sellerTaxCode: '0100109106', options: {}, isActive: true } });
    expect(made.ok(), await made.text()).toBeTruthy(); providers = await (await request.get('/api/einvoice/providers')).json();
  }
  const provider = providers.find((p) => p.code === 'fake')!;
  let series = await (await request.get('/api/einvoice/series')).json() as { id: number; formNo: string; serial: string }[];
  if (!series.some((s) => s.formNo === '1' && s.serial === 'C26TAA')) {
    const made = await request.post('/api/einvoice/series', { data: { providerId: provider.id, formNo: '1', serial: 'C26TAA', kind: 'standard', isActive: true } });
    expect(made.ok(), await made.text()).toBeTruthy(); series = await (await request.get('/api/einvoice/series')).json();
  }
  const seriesId = series.find((s) => s.formNo === '1' && s.serial === 'C26TAA')!.id;

  // Màn hình cấu hình: thấy nhà cung cấp và ký hiệu, kiểm tra kết nối
  await page.goto('/hoa-don-dien-tu/cau-hinh');
  await expect(page.getByRole('heading', { name: 'Cấu hình hóa đơn điện tử' })).toBeVisible();
  await expect(page.locator('tbody tr.ant-table-row', { hasText: 'C26TAA' })).toBeVisible();
  await page.locator('tbody tr.ant-table-row', { hasText: 'Giả lập' }).first().getByRole('button', { name: 'Kiểm tra kết nối' }).click();
  await expect(page.locator('tbody tr.ant-table-row', { hasText: 'Giả lập' }).first().locator('.ant-tag').filter({ hasNotText: /Đang dùng|Ngừng|Đã đặt|Chưa đặt/ })).toBeVisible();

  const stamp = Date.now(); const code = `KHDT${stamp}`; const name = `Khách điện tử ${stamp}`;
  expect((await request.post('/api/catalogs/party', { data: { code, name, is_customer: true, tax_code: '0100109106', address: '12 Phố Huế, Hà Nội' } })).ok()).toBeTruthy();

  await page.goto('/chung-tu/HDB');
  await expect(page.getByRole('heading', { name: 'Hóa đơn bán dịch vụ' })).toBeVisible();
  await page.keyboard.press('Insert');
  await expect(page.getByText('Hóa đơn bán dịch vụ (mới)')).toBeVisible();
  await page.getByLabel('Diễn giải', { exact: true }).fill(`Bán dịch vụ ${stamp}`);
  await page.getByRole('combobox', { name: 'Đối tượng' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type(code);
  await page.locator('.ant-select-item-option', { hasText: code }).click();
  const cell = (col: string) => page.locator(`.ag-center-cols-container .ag-row[row-index="0"] [col-id="${col}"]`);
  await cell('description').click(); await page.keyboard.type('Phí tư vấn'); await page.keyboard.press('Enter');
  await page.keyboard.type('5113'); await page.keyboard.press('Enter');
  await page.keyboard.type('2'); await page.keyboard.press('Enter');
  await page.keyboard.type('500000'); await page.keyboard.press('Enter');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
  await page.keyboard.press('F4'); await expect(page.getByRole('dialog').getByRole('combobox')).toBeFocused(); await page.keyboard.type('V10');
  await page.locator('.ant-select-item-option', { hasText: /^V10/ }).click();
  await expect(page.locator('.ag-center-cols-container .ag-row')).toHaveCount(1);
  await expect(cell('taxAmount')).toContainText('100.000');

  // Tab Hóa đơn: chọn ký hiệu HĐĐT thì số hóa đơn để trống, "Chưa phát hành"
  await page.getByRole('tab', { name: 'Hóa đơn' }).click();
  await page.getByRole('combobox', { name: 'Ký hiệu HĐĐT' }).click();
  await page.locator('.ant-select-item-option', { hasText: '1C26TAA' }).click();
  await expect(page.getByPlaceholder('Chưa phát hành')).toBeDisabled();
  await page.keyboard.press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu')).toBeVisible();
  await expect(page).toHaveURL(/HDB\/[0-9a-f-]{36}$/);
  await page.getByRole('tab', { name: 'Hàng tiền' }).click();
  await expect(page.locator('.ag-center-cols-container [col-id="accountCode"]', { hasText: '5113' })).toBeVisible();
  await page.keyboard.press('F9');
  await expect(page.locator('.ant-message').getByText('Đã ghi sổ')).toBeVisible();
  const id = /HDB\/([0-9a-f-]{36})$/.exec(page.url())![1];

  // Phát hành bằng nút; "Bỏ ghi sổ" còn trước khi phát hành, mất sau đó
  await expect(page.getByRole('button', { name: 'Bỏ ghi sổ' })).toBeVisible();
  await page.getByRole('button', { name: /Phát hành HĐĐT/ }).click();
  await expect(page.locator('.kt-page-header')).toContainText('Đã phát hành');
  await expect(page.locator('.kt-page-header')).toContainText(/1C26TAA \d{7}/);
  await expect(page.getByRole('button', { name: 'Bỏ ghi sổ' })).toHaveCount(0);
  const einv = (await (await request.get(`/api/vouchers/${id}/einvoice`)).json() as { einvoice: { id: number; invoiceNo: string } }).einvoice;
  const no = einv.invoiceNo;

  // Danh sách: tìm theo khách hàng, thấy dòng; tra mã CQT (ký hiệu C cấp mã ở lần tra đầu)
  await page.goto('/hoa-don-dien-tu');
  await expect(page.getByRole('heading', { name: 'Hóa đơn điện tử', exact: true })).toBeVisible();
  await page.getByLabel('Tìm số hóa đơn hoặc khách hàng').fill(name); await page.keyboard.press('Enter');
  const rowOf = (text: string | RegExp) => page.locator('tbody tr.ant-table-row', { hasText: text });
  await expect(rowOf(no)).toContainText('Đã phát hành');
  await rowOf(no).getByRole('button', { name: 'Chi tiết' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Tra mã CQT' }).click();
  await expect(page.locator('.ant-message').getByText('Đã tra cứu mã của cơ quan thuế')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Tra mã CQT' })).toHaveCount(0);

  // GGB cùng ký hiệu, trỏ tới hóa đơn gốc; điều chỉnh giảm từ màn hình hóa đơn điện tử
  const orig = await (await request.get(`/api/invoices/${id}`)).json() as { postingDate: string; invoices: { id: number }[] };
  const gg = await request.post('/api/invoices', { data: { voucherType: 'GGB', postingDate: orig.postingDate, documentDate: orig.postingDate, partyCode: code, autoPost: true,
    items: [{ description: 'Giảm giá', accountCode: '5113', amountCurrency: '100000', taxCodes: ['V10'] }],
    invoice: { einvoiceSeriesId: seriesId, invoiceDate: orig.postingDate, invoiceGroupCode: '10', adjustsInvoiceId: orig.invoices[0]!.id } } });
  expect(gg.ok(), await gg.text()).toBeTruthy();
  await page.getByRole('dialog').getByRole('button', { name: 'Lập điều chỉnh' }).click();
  const dlg = page.locator('.ant-modal').filter({ hasText: 'Lập hóa đơn điều chỉnh' });
  await dlg.getByRole('combobox', { name: 'Chứng từ' }).click();
  await page.locator('.ant-select-item-option', { hasText: 'GGB' }).first().click();
  await dlg.getByLabel('Lý do').fill('Giảm giá theo thỏa thuận');
  await dlg.getByRole('button', { name: 'Thực hiện' }).click();
  await expect(page.locator('.ant-message').getByText(/Đã lập hóa đơn \d{7}/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rowOf('Hóa đơn điều chỉnh')).toBeVisible();
  await expect(rowOf('Hóa đơn gốc')).toBeVisible();
  await expect(rowOf(name)).toHaveCount(2);

  // Thông báo 04/SS-HĐĐT: từ chi tiết hóa đơn gốc, F4 chọn hóa đơn, lưu nháp, gửi
  await page.locator('.ant-drawer .ant-drawer-close').click();
  await rowOf('Hóa đơn gốc').getByRole('button', { name: 'Chi tiết' }).click();
  await expect(page.getByRole('dialog').getByText('Hóa đơn liên quan')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Lập 04/SS' }).click();
  await expect(page.getByRole('heading', { name: /04\/SS-HĐĐT/ })).toBeVisible();
  const nd = page.locator('.ant-modal').filter({ has: page.locator('.ag-root') });
  await expect(nd).toBeVisible();
  await expect(nd.locator('.ag-row')).toHaveCount(2);
  await expect(nd).toContainText(no);
  await nd.locator('.ag-row [col-id="reason"]').first().dblclick();
  await page.keyboard.type('Sai địa chỉ người mua'); await page.keyboard.press('Enter');
  await nd.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.locator('.ant-message').getByText('Đã lưu thông báo')).toBeVisible();
  await expect(nd.getByRole('button', { name: 'Gửi', exact: true })).toBeVisible();
  await nd.getByRole('button', { name: 'Gửi', exact: true }).click();
  await expect(page.locator('.ant-message').getByText('Đã gửi thông báo')).toBeVisible();
  await expect(page.locator('tbody tr.ant-table-row').filter({ hasText: no }).filter({ hasText: 'Đã gửi' })).toBeVisible();
});
