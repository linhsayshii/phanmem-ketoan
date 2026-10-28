import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phieu-thu.spec.ts (tài khoản e2e quản trị công ty E2E).
async function login(page: Page, username: string) {
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill(username); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}
async function setup(request: APIRequestContext, approver: string) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  const u = await request.post('/api/users', { data: { username: approver, fullName: 'Kế toán trưởng E2E', password: 'Matkhau1!', roleCode: 'ketoan_truong', sensitiveFlags: [] } });
  expect(u.ok(), await u.text()).toBeTruthy();
}

test('Phê duyệt: cấu hình quy trình, lập và gửi đề nghị tạm ứng, Kế toán trưởng duyệt trên màn hình hẹp, sinh Phiếu chi nháp', async ({ page, browser, request }) => {
  const tag = String(Date.now()).slice(-6);
  const approver = `ktt_e2e_${tag}`;
  const amount = String(50_000_000 + Number(tag)); // hạn mức riêng của lần chạy: quy trình này là quy trình được chọn
  await setup(request, approver);
  await login(page, 'e2e');

  await page.goto('/phe-duyet/quy-trinh');
  await expect(page.getByRole('heading', { name: 'Quy trình phê duyệt' })).toBeVisible();
  await page.keyboard.press('Insert');
  const flow = page.getByRole('dialog', { name: 'Thêm quy trình phê duyệt' });
  await flow.getByLabel('Tạm ứng').check();
  await flow.getByLabel('Tên quy trình').fill(`Tạm ứng e2e ${tag}`);
  await flow.getByLabel('Áp dụng từ số tiền (VND)').fill(amount);
  await flow.getByLabel('Bước 1').fill('Vai trò: Kế toán trưởng'); await page.keyboard.press('Enter');
  await flow.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByRole('row', { name: new RegExp(`Tạm ứng e2e ${tag}`) })).toContainText('Kế toán trưởng');

  await page.goto('/phe-duyet');
  await expect(page.getByRole('heading', { name: 'Đề nghị thanh toán, tạm ứng' })).toBeVisible();
  await page.getByRole('button', { name: 'Lập đề nghị (Insert)' }).click();
  const form = page.getByRole('dialog', { name: 'Lập đề nghị' });
  await form.getByLabel('Đề nghị tạm ứng').check();
  await form.getByLabel('Người nhận tiền').fill(`Nguyễn Văn E2E ${tag}`);
  await form.getByLabel('Lý do').fill('Tạm ứng công tác phí');
  await form.getByLabel('Số tiền').fill(amount);
  await form.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();
  await expect(page.getByText('Đã gửi duyệt')).toBeVisible();
  await page.getByRole('tab', { name: 'Đề nghị của tôi' }).click();
  const mine = page.getByRole('row', { name: new RegExp(`Nguyễn Văn E2E ${tag}`) });
  await expect(mine).toContainText('Chờ duyệt');

  // Người duyệt dùng điện thoại: danh sách thẻ, ngăn kéo toàn màn hình.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'vi-VN' });
  const p2 = await phone.newPage();
  await login(p2, approver);
  await expect(p2.getByRole('link', { name: /Chờ duyệt: [1-9]/ })).toBeVisible();
  await p2.goto('/phe-duyet');
  await expect(p2.getByRole('tab', { name: /Chờ tôi duyệt/ })).toHaveAttribute('aria-selected', 'true');
  await p2.getByLabel(new RegExp(`Nguyễn Văn E2E ${tag}`)).click();
  const drawer = p2.getByRole('dialog');
  await expect(drawer).toContainText('Tạm ứng công tác phí');
  await drawer.getByRole('button', { name: 'Duyệt' }).click();
  await expect(p2.getByText('Đã duyệt', { exact: true }).first()).toBeVisible();
  await expect(p2.getByLabel(new RegExp(`Nguyễn Văn E2E ${tag}`))).toHaveCount(0);
  await phone.close();

  await page.reload();
  await page.getByRole('tab', { name: 'Đề nghị của tôi' }).click();
  await expect(mine).toContainText('Đã duyệt');
  await mine.click();
  await expect(page.getByRole('dialog').getByRole('link', { name: /^PC/ })).toBeVisible();
});
