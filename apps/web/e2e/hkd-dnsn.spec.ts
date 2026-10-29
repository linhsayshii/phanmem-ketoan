import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { typeDate } from './helpers/dates.js';

// Yêu cầu trước khi chạy (công ty riêng vì spec này tạo năm tài chính TT58, không dùng chung với E2EHKD của TT152):
//   pnpm -F @kt/api cli create-admin --username e2edn --password Matkhau1! --tenant-code E2EDN --tenant-name "Doanh nghiệp siêu nhỏ E2E"
// Spec chạy lại được: năm tài chính và cài đặt đã có thì bỏ qua; mỗi lần chạy dùng đối tượng, loại tài sản mang dấu thời gian riêng.

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2edn', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2edn'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

// Ô chọn của antd: bấm vùng hiển thị (ô combobox thật bị ẩn) trong form item mang nhãn.
async function pick(page: Page, label: string, option: string) {
  await page.locator('.ant-form-item').filter({ has: page.locator('label', { hasText: label }) }).locator('.ant-select-selector').click();
  await page.locator('.ant-select-item-option').filter({ hasText: option }).click();
}

test('Sổ siêu nhỏ TT58: ghi công nợ, TSCĐ, vốn chủ sở hữu; xem S4a, S4b, S4d, B01-DNSN; in phiếu thu', async ({ page, request }) => {
  await signIn(page, request);
  const years = await (await request.get('/api/fiscal-years')).json() as { fiscalYear: number }[];
  if (!years.some((y) => y.fiscalYear === 2026)) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-07-01', months: 12, regime: 'TT58' } })).ok()).toBeTruthy();
  expect((await request.put('/api/hkd/settings/2026', { data: { taxMethod: 'vat_deduct_cit_profit', incomeTaxRate: '20' } })).ok()).toBeTruthy();
  const stamp = String(Date.now()).slice(-6);
  await page.goto('/so-hkd');
  await expect(page.getByRole('heading', { name: 'Sổ hộ kinh doanh, doanh nghiệp siêu nhỏ' })).toBeVisible();

  // Công nợ: phải thu 5.000.000, đã thu 2.000.000 -> còn phải thu 3.000.000
  await page.getByRole('tab', { name: 'Công nợ' }).click();
  const no = page.getByRole('tabpanel', { name: 'Công nợ' });
  await typeDate(page, no.getByLabel('Ngày', { exact: true }), '15/09/2026');
  await no.getByLabel('Đối tượng').fill(`Cty ${stamp}`); await no.getByLabel('Diễn giải').fill(`Bán chịu ${stamp}`); await no.getByLabel('Số tiền').fill('5.000.000');
  await no.getByLabel('Số tiền').press('Enter');
  await expect(page.getByText('Đã ghi công nợ')).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(`Cty ${stamp}.*Bán chịu ${stamp}.*5\\.000\\.000`) })).toBeVisible();
  await pick(page, 'Loại bút', 'Đã thu, đã trả');
  await no.getByLabel('Diễn giải').fill(`Thu nợ ${stamp}`); await no.getByLabel('Số tiền').fill('2.000.000');
  await no.getByLabel('Số tiền').press('Enter');
  await expect(page.getByRole('row', { name: new RegExp(`Thu nợ ${stamp}`) })).toBeVisible();

  // Tài sản cố định: ghi tăng rồi ghi giảm
  await page.getByRole('tab', { name: 'Tài sản cố định' }).click();
  const ts = page.getByRole('tabpanel', { name: 'Tài sản cố định' });
  await ts.getByLabel('Loại tài sản').fill(`Máy ${stamp}`); await ts.getByLabel('Tên, đặc điểm, ký hiệu TSCĐ').fill(`Máy cắt ${stamp}`);
  await typeDate(page, ts.getByLabel('Ngày ghi tăng'), '15/09/2026');
  await ts.getByLabel('Nguyên giá').fill('12.000.000'); await ts.getByLabel('Tỷ lệ khấu hao năm (%)').fill('10');
  await ts.getByRole('button', { name: 'Ghi tăng TSCĐ' }).click();
  await expect(page.getByText('Đã ghi tăng TSCĐ')).toBeVisible();
  const asset = page.getByRole('row', { name: new RegExp(`Máy cắt ${stamp}`) });
  await expect(asset).toContainText('12.000.000');
  await asset.getByRole('button', { name: 'Ghi giảm' }).click();
  const dlg = page.getByRole('dialog', { name: /Ghi giảm TSCĐ/ });
  await typeDate(page, dlg.getByLabel('Ngày ghi giảm'), '20/09/2026');
  await dlg.getByLabel('Lý do giảm TSCĐ').fill('Thanh lý'); await dlg.getByRole('button', { name: 'Ghi giảm' }).click();
  await expect(page.getByText('Đã ghi giảm TSCĐ')).toBeVisible();
  await expect(asset).toContainText('Thanh lý');
  await expect(dlg).toBeHidden();

  // Vốn chủ sở hữu
  await page.getByRole('tab', { name: 'Vốn chủ sở hữu' }).click();
  const vcsh = page.getByRole('tabpanel', { name: 'Vốn chủ sở hữu' });
  await typeDate(page, vcsh.getByLabel('Ngày', { exact: true }), '01/10/2026');
  await vcsh.getByLabel('Diễn giải').fill(`Góp vốn ${stamp}`); await vcsh.getByLabel('Số tiền').fill('7.000.000'); await vcsh.getByLabel('Số tiền').press('Enter');
  await expect(page.getByText('Đã ghi vốn chủ sở hữu')).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(`Góp vốn ${stamp}.*7\\.000\\.000`) })).toBeVisible();

  // Xem S4a của đối tượng, S4b, S4d, B01-DNSN
  await page.getByRole('tab', { name: 'Sổ và báo cáo' }).click();
  const so = page.getByRole('tabpanel', { name: 'Sổ và báo cáo' });
  const chon = async (ma: string) => { await so.locator('.ant-select-selector').first().click(); await page.locator('.ant-select-item-option').filter({ hasText: ma }).click(); };
  await chon('S4a-DNSN');
  await page.getByRole('button', { name: 'Cả năm 2026' }).click();
  await so.locator('.ant-select').filter({ hasText: 'Mọi đối tượng' }).locator('.ant-select-selector').click(); await page.locator('.ant-select-item-option').filter({ hasText: `Cty ${stamp}` }).click();
  await page.getByRole('button', { name: 'Xem sổ' }).click();
  await expect(page.getByRole('heading', { name: 'SỔ CHI TIẾT THANH TOÁN CÔNG NỢ' })).toBeVisible();
  await expect(page.getByText(`Đối tượng: Cty ${stamp}`)).toBeVisible();
  await expect(page.getByRole('row', { name: /Cộng số phát sinh trong kỳ\s+5\.000\.000\s+2\.000\.000/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Số dư cuối kỳ\s+3\.000\.000/ })).toBeVisible();

  await chon('S4b-DNSN'); await page.getByRole('button', { name: 'Xem sổ' }).click();
  await expect(page.getByRole('heading', { name: 'SỔ TÀI SẢN CỐ ĐỊNH' }).first()).toBeVisible();
  await expect(page.getByText(`Loại tài sản: Máy ${stamp}`)).toBeVisible();

  await chon('S4d-DNSN'); await page.getByRole('button', { name: 'Xem sổ' }).click();
  await expect(page.getByRole('heading', { name: 'SỔ THEO DÕI VỐN CHỦ SỞ HỮU' })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(`Góp vốn ${stamp}\\s+7\\.000\\.000`) })).toBeVisible();

  await chon('B01-DNSN'); await page.getByRole('button', { name: 'Xem sổ' }).click();
  await expect(page.getByRole('heading', { name: 'BÁO CÁO TÌNH HÌNH TÀI CHÍNH' })).toBeVisible();
  await expect(page.getByText(/Mẫu số B01 – DNSN/)).toBeVisible();
  await expect(page.getByRole('row', { name: /TỔNG CỘNG TÀI SẢN\s+200/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /TỔNG CỘNG NGUỒN VỐN\s+500/ })).toBeVisible();

  // In phiếu thu từ bút ghi thu tiền mặt
  const today = new Date().toISOString().slice(0, 10);
  expect((await request.post('/api/hkd/entries', { data: { entryDate: today, docNo: `PT${stamp}`, description: `Thu tiền ${stamp}`, kind: 'cash_in', amount: '1500000', moneyAccount: 'TM' } })).ok()).toBeTruthy();
  await page.getByRole('tab', { name: 'Ghi sổ' }).click();
  await page.getByRole('row', { name: new RegExp(`Thu tiền ${stamp}`) }).getByRole('button', { name: 'In phiếu' }).click();
  const pt = page.getByRole('dialog', { name: /Phiếu thu \(mẫu 01-TT\)/ });
  await pt.getByLabel('Họ và tên người nộp tiền').fill(`Nguyễn Văn ${stamp}`);
  const [popup] = await Promise.all([page.waitForEvent('popup'), pt.getByRole('button', { name: 'Xem phiếu' }).click()]);
  await expect(popup.getByRole('heading', { name: 'PHIẾU THU' })).toBeVisible();
  await expect(popup.getByText(`Nguyễn Văn ${stamp}`)).toBeVisible();
  await expect(popup.getByText('Mẫu số 01-TT')).toBeVisible();
  await expect(popup.getByText('1.500.000 đồng')).toBeVisible();
});
