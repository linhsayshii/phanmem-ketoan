import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy (công ty riêng, không dùng chung công ty E2E vì spec này tạo năm tài chính TT152):
//   pnpm -F @kt/api cli create-admin --username e2ehkd --password Matkhau1! --tenant-code E2EHKD --tenant-name "Hộ kinh doanh E2E"
// Spec chạy lại được: nhóm ngành nghề và năm tài chính đã có thì bỏ qua bước tạo.

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2ehkd', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2ehkd'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Chế độ kế toán: TT 152 và TT 58 dùng được (ghi sổ theo nhóm thuế), nêu giới hạn và nguồn văn bản gốc', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/he-thong/che-do-ke-toan');
  await expect(page.getByRole('heading', { name: 'Chế độ kế toán' })).toBeVisible();
  await expect(page.getByRole('row', { name: /TT152/ }).getByText('Dùng được, còn giới hạn')).toBeVisible();
  await expect(page.getByRole('row', { name: /TT58/ }).getByText('Dùng được, còn giới hạn')).toBeVisible();
  await expect(page.getByRole('row', { name: /TT133/ }).getByText('Dùng được')).toBeVisible();
  await page.getByRole('row', { name: /TT152/ }).locator('.ant-table-row-expand-icon').click();
  await expect(page.getByText('Đã nhập từ văn bản gốc')).toBeVisible();
  await expect(page.getByText('Giới hạn hiện tại')).toBeVisible();
  await expect(page.getByText(/Chưa có tờ khai 01\/TKN-CNKD/)).toBeVisible();
  await expect(page.getByText('Chưa có văn bản gốc, chưa dùng cho kế toán thật')).toHaveCount(0);
  await page.getByRole('row', { name: /TT58/ }).locator('.ant-table-row-expand-icon').click();
  await expect(page.getByText(/B01-DNSN lập từ các sổ ghi đơn/)).toBeVisible();
});

test('Sổ hộ kinh doanh: tạo nhóm ngành nghề, ghi doanh thu, xem S2a-HKD với thuế GTGT làm tròn đúng', async ({ page, request }) => {
  await signIn(page, request);
  // Năm tài chính TT152 của công ty E2EHKD (bỏ qua nếu đã có)
  const years = await (await request.get('/api/fiscal-years')).json() as { fiscalYear: number }[];
  if (!years.some((y) => y.fiscalYear === 2026)) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT152' } })).ok()).toBeTruthy();
  const stamp = String(Date.now()).slice(-6);
  await page.goto('/so-hkd');
  await expect(page.getByRole('heading', { name: 'Sổ hộ kinh doanh, doanh nghiệp siêu nhỏ' })).toBeVisible();

  await page.getByRole('tab', { name: 'Nhóm ngành nghề' }).click();
  const nhom = page.getByRole('tabpanel', { name: 'Nhóm ngành nghề' });
  await nhom.getByLabel('Mã', { exact: true }).fill(`N${stamp}`); await nhom.getByLabel('Tên nhóm').fill(`Bán lẻ ${stamp}`);
  await nhom.getByLabel('Tỷ lệ thuế GTGT (%)').fill('1'); await nhom.getByLabel('Tỷ lệ thuế TNCN, TNDN (%)').fill('0.5');
  await nhom.getByRole('button', { name: 'Thêm nhóm' }).click();
  await expect(page.getByRole('row', { name: new RegExp(`Bán lẻ ${stamp}`) })).toBeVisible();

  await page.getByRole('tab', { name: 'Cài đặt năm' }).click();
  await page.getByRole('tabpanel', { name: 'Cài đặt năm' }).locator('.ant-select-selector').click();
  await page.locator('.ant-select-item-option').filter({ hasText: 'Điều 5: Thuế GTGT và thuế TNCN' }).click();
  await page.getByRole('button', { name: 'Lưu cài đặt' }).click();
  await expect(page.getByText('Đã lưu')).toBeVisible();

  await page.getByRole('tab', { name: 'Ghi sổ' }).click();
  await page.getByRole('combobox', { name: /Nhóm ngành nghề/ }).click(); await page.locator('.ant-select-item-option').filter({ hasText: `Bán lẻ ${stamp}` }).click();
  const ghi = page.getByRole('tabpanel', { name: 'Ghi sổ' });
  await ghi.getByLabel('Diễn giải').fill(`Bán hàng ${stamp}`); await ghi.getByLabel('Số tiền').fill('3.333.333');
  await ghi.getByLabel('Diễn giải').press('Enter');
  await expect(page.getByText('Đã ghi sổ', { exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(`Bán hàng ${stamp}`) })).toBeVisible();

  await page.getByRole('tab', { name: 'Sổ và báo cáo' }).click();
  await page.getByRole('tabpanel', { name: 'Sổ và báo cáo' }).locator('.ant-select-selector').first().click(); await page.locator('.ant-select-item-option').filter({ hasText: 'S2a-HKD' }).click();
  await page.getByRole('button', { name: 'Cả năm 2026' }).click();
  await page.getByRole('button', { name: 'Xem sổ' }).click();
  await expect(page.getByRole('heading', { name: 'SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ' })).toBeVisible();
  // 3.333.333 x 1% = 33.333,33 -> 33.333 (làm tròn nửa lên); nhóm của lần chạy này có đúng một dòng doanh thu
  await expect(page.getByRole('row', { name: /Tổng cộng \(\d+\)\s*3\.333\.333/ }).first()).toBeVisible();
  await expect(page.getByRole('row', { name: /Thuế GTGT\s*33\.333$/ }).first()).toBeVisible();
  await expect(page.getByRole('row', { name: /Tổng số thuế GTGT phải nộp/ })).toBeVisible();
  await expect(page.getByText(/Mẫu số S2a-HKD/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'In PDF' })).toBeEnabled();
});
