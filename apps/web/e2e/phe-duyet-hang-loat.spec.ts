import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phe-duyet.spec.ts (tài khoản e2e quản trị công ty E2E).
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

test('Phê duyệt: duyệt hàng loạt các đề nghị đã chọn; lập và thu hồi ủy quyền duyệt', async ({ browser, request }) => {
  const tag = String(Date.now()).slice(-6);
  const approver = `ktt_hl_${tag}`;
  const min = String(70_000_000 + Number(tag)); // hạn mức riêng của lần chạy để quy trình này được chọn
  await setup(request, approver);
  const roles = await (await request.get('/api/roles')).json() as { id: string; code: string }[];
  const flow = await request.post('/api/approval-flows', { data: { kind: 'advance', name: `Tạm ứng hàng loạt ${tag}`, minAmount: min, steps: [{ roleId: roles.find((r) => r.code === 'ketoan_truong')!.id }] } });
  expect(flow.ok(), await flow.text()).toBeTruthy();
  const payees = [1, 2, 3].map((i) => `Người nhận HL${i} ${tag}`);
  for (const payee of payees) {
    const r = await request.post('/api/approvals', { data: { kind: 'advance', requestDate: '2026-03-10', payeeName: payee, reason: 'Tạm ứng hàng loạt', currencyCode: 'VND', amountCurrency: min, payMethod: 'cash' } });
    expect(r.ok(), await r.text()).toBeTruthy();
    expect((await request.post(`/api/approvals/${(await r.json()).id}/submit`, { data: {} })).ok()).toBeTruthy();
  }

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'vi-VN' });
  const p = await ctx.newPage();
  await login(p, approver);
  await p.goto('/phe-duyet');
  await expect(p.getByRole('tab', { name: /Chờ tôi duyệt/ })).toHaveAttribute('aria-selected', 'true');
  const rowOf = (name: string) => p.getByRole('row', { name: new RegExp(name) });
  await expect(rowOf(payees[0]!)).toBeVisible();
  const btn = p.getByRole('button', { name: /Duyệt các đề nghị đã chọn/ });
  await expect(btn).toBeDisabled();
  await rowOf(payees[0]!).getByRole('checkbox').check();
  await rowOf(payees[1]!).getByRole('checkbox').check();
  await expect(p.getByRole('button', { name: 'Duyệt 2 đề nghị đã chọn' })).toBeEnabled();
  await p.getByRole('button', { name: 'Duyệt 2 đề nghị đã chọn' }).click();
  await p.getByRole('tooltip').getByRole('button', { name: 'Duyệt', exact: true }).click();
  const result = p.getByRole('dialog', { name: 'Kết quả duyệt hàng loạt' });
  await expect(result).toContainText('Đã duyệt 2 đề nghị');
  await result.getByRole('button', { name: 'Đóng' }).click();
  await expect(rowOf(payees[0]!)).toHaveCount(0); // đã duyệt: rời hộp duyệt
  await expect(rowOf(payees[1]!)).toHaveCount(0);
  await expect(rowOf(payees[2]!)).toBeVisible(); // đề nghị không chọn vẫn chờ duyệt

  // Ủy quyền duyệt: lập cho quản trị E2E trong 3 ngày, thấy "Đang hiệu lực", thu hồi.
  await p.getByRole('link', { name: 'Ủy quyền duyệt' }).first().click();
  await expect(p.getByRole('heading', { name: 'Ủy quyền duyệt' })).toBeVisible();
  await pickDelegate(p, 'e2e');
  const day = (n: number) => { const d = new Date(Date.now() + 7 * 3600_000 + n * 86400_000); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; };
  await p.getByLabel('Lý do ủy quyền').fill('Đi công tác E2E'); // trước ô ngày: Enter ở ô ngày gửi biểu mẫu
  const range = p.locator('.ant-picker-range input');
  await range.nth(0).click(); await range.nth(0).fill(day(0)); await p.keyboard.press('Enter');
  await range.nth(1).fill(day(3)); await p.keyboard.press('Enter'); // Enter ở ô ngày cuối gửi luôn biểu mẫu
  await expect(p.locator('.ant-message').getByText('Đã lập ủy quyền')).toBeVisible();
  const row = p.getByRole('row', { name: /Đi công tác E2E/ });
  await expect(row).toContainText('Đang hiệu lực');
  await row.getByRole('button', { name: /Thu hồi ủy quyền cho/ }).click();
  await p.getByRole('tooltip').getByRole('button', { name: 'Thu hồi', exact: true }).click();
  await expect(row).toContainText('Đã thu hồi');
  await ctx.close();
});

async function pickDelegate(page: Page, username: string) {
  await page.getByRole('combobox', { name: 'Người được ủy quyền' }).click();
  await page.locator('.ant-select-item-option', { hasText: `(${username})` }).click();
}
