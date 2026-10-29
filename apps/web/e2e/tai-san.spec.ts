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

test('Tài sản cố định: tạo loại, tạo thẻ, ghi tăng xây dựng cơ bản, xem lịch khấu hao', async ({ page, request }) => {
  await signIn(page, request);
  const stamp = Date.now(); const cat = `LT${stamp}`; const code = `TS${stamp}`;

  // Loại tài sản
  await page.goto('/tai-san/loai');
  await page.getByRole('button', { name: 'Thêm loại' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Mã', { exact: true }).fill(cat); await dlg.getByLabel('Tên', { exact: true }).fill(`Máy móc ${stamp}`);
  await dlg.getByLabel('TK tài sản (F4)').fill('2111'); await page.locator('.ant-select-item-option', { hasText: /^2111/ }).first().click(); await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
  await dlg.getByLabel('TK hao mòn (F4)').fill('2141'); await page.locator('.ant-select-item-option', { hasText: /^2141/ }).first().click(); await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.locator('.ant-table-row', { hasText: cat })).toBeVisible();

  // Thẻ TSCĐ
  await page.goto('/tai-san/tscd');
  await expect(page.getByRole('heading', { name: 'Tài sản cố định' })).toBeVisible();
  await page.getByRole('button', { name: /Thêm/ }).click();
  const dr = page.getByRole('dialog').first();
  await dr.getByLabel('Mã', { exact: true }).fill(code); await dr.getByLabel('Tên', { exact: true }).fill(`Máy tiện ${stamp}`);
  await dr.getByLabel('Loại (F4)').fill(cat); await page.locator('.ant-select-item-option', { hasText: cat }).first().click(); await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
  await dr.getByLabel('Ngày bắt đầu khấu hao').fill('01/02/2026'); await page.keyboard.press('Enter');
  await dr.getByLabel('Số kỳ sử dụng').fill('12');
  // Gợi ý khung TT 45/2013 Phụ lục 1: 12 tháng thấp hơn tối thiểu 6 năm của nhóm D.1; chỉ cảnh báo, vẫn lưu được thẻ.
  await dr.getByTestId('frame-hint').locator('.ant-select').click(); await page.keyboard.type('D.1'); await page.locator('.ant-select-item-option', { hasText: /^D\.1 / }).first().click();
  await expect(dr.getByTestId('frame-warning')).toContainText('thấp hơn mức tối thiểu 6 năm');
  await dr.getByLabel('Ghi chú').press('Control+s');
  await expect(page.getByText('Đã lưu thẻ')).toBeVisible();

  // Phân bổ chi phí (tổng phải 100%)
  await dr.getByRole('tab', { name: 'Phân bổ chi phí' }).click();
  await dr.getByRole('gridcell').first().dblclick(); await page.keyboard.type('6422'); await page.keyboard.press('Enter');
  await dr.locator('[col-id="ratio"][role="gridcell"]').first().dblclick(); await page.keyboard.type('100'); await page.keyboard.press('Enter');
  await expect(dr.getByTestId('alloc-total')).toContainText('100%');
  await dr.getByRole('button', { name: 'Lưu phân bổ' }).click();
  await expect(page.getByText('Đã lưu phân bổ chi phí')).toBeVisible();

  // Ghi tăng xây dựng cơ bản 120.000.000 từ TK 2412
  await dr.getByRole('tab', { name: 'Biến động và chứng từ' }).click();
  await dr.getByRole('button', { name: 'Ghi tăng', exact: true }).click();
  const ev = page.getByRole('dialog', { name: /Ghi tăng/ });
  await ev.locator('.ant-form-item', { hasText: 'Lý do ghi tăng' }).locator('.ant-select').click(); await page.locator('.ant-select-item-option', { hasText: 'Hoàn thành xây dựng cơ bản' }).click(); await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
  await ev.getByLabel('TK đối ứng (Có, F4)').fill('2412'); await page.locator('.ant-select-item-option', { hasText: /^2412/ }).first().click();
  await ev.getByLabel('Giá trị ghi tăng').fill('120000000');
  await ev.getByRole('button', { name: /Lưu/ }).click();
  await expect(ev.getByTestId('event-result')).toContainText('Đã ghi nhận ghi tăng');
  await ev.getByRole('button', { name: 'Đóng' }).click();
  await expect(dr.getByTestId('events-table')).toContainText('Ghi tăng');

  // Lịch khấu hao: 12 kỳ x 10.000.000
  await dr.getByRole('tab', { name: 'Lịch khấu hao' }).click();
  await expect(dr.getByTestId('schedule-table')).toContainText('10.000.000');
  await expect(dr.getByTestId('schedule-table')).toContainText('120.000.000');

  // Danh sách hiện nguyên giá
  await page.keyboard.press('Escape');
  await expect(page.locator('.ant-table-row', { hasText: code })).toContainText('120.000.000');
});
