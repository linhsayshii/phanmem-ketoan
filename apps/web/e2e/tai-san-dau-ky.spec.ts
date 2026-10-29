import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Cần người dùng e2e: pnpm -F @kt/api cli create-admin --username e2e --password 'Matkhau1!' --tenant-code E2E --tenant-name "Công ty E2E"

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

type Saved = { code: string; name: string; categoryCode: string | null; openingCost: string; openingAccumulated: string; openingRemainingUnits: string | null; useDate: string | null; depreciationStartDate: string | null };

test('Số dư đầu kỳ tài sản: nhập thẻ bằng bàn phím rồi lưu', async ({ page, request }) => {
  await signIn(page, request);
  await request.post('/api/asset-categories', { data: { code: 'DKE2E', name: 'Loại đầu kỳ E2E', kind: 'fixed', assetAccountCode: '2111', depreciationAccountCode: '2141', defaultLifeUnits: 60 } });
  const originalCards = await (await request.get('/api/opening-assets/2026')).json() as Saved[];
  expect((await request.put('/api/opening-assets/2026', { data: { rows: [] } })).ok()).toBeTruthy();
  try {
    await page.goto('/so-cai/tai-san-dau-ky');
    await expect(page.getByRole('heading', { level: 1, name: 'Số dư đầu kỳ tài sản' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lưu' })).toBeEnabled();
    const cell = (row: number, col: string) => page.locator(`.ag-center-cols-container .ag-row[row-index="${row}"] [col-id="${col}"]`).first();
    const type = async (text: string) => { await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(text); };
    const edit = async (col: string, text: string) => { await cell(0, col).dblclick(); await type(text); await page.keyboard.press('Enter'); };

    await edit('code', 'DKE01'); await edit('name', 'Máy đầu kỳ'); await edit('categoryCode', 'DKE2E');
    await edit('openingCost', '60000000'); await edit('openingAccumulated', '40000000'); await edit('openingRemainingUnits', '20');
    await page.getByRole('button', { name: 'Lưu' }).click();
    await expect(page.locator('.ant-message').getByText('Đã lưu thẻ tài sản đầu kỳ')).toBeVisible();
    const saved = await (await request.get('/api/opening-assets/2026')).json() as Saved[];
    expect(saved.map((r) => [r.code, r.categoryCode, r.openingCost, r.openingAccumulated, r.openingRemainingUnits])).toEqual([['DKE01', 'DKE2E', '60000000', '40000000', '20']]);
  } finally {
    await request.put('/api/opening-assets/2026', { data: { rows: originalCards.map((r) => ({ code: r.code, name: r.name, categoryCode: r.categoryCode, useDate: r.useDate, depreciationStartDate: r.depreciationStartDate, openingCost: r.openingCost, openingAccumulated: r.openingAccumulated, openingRemainingUnits: r.openingRemainingUnits })) } });
  }
});
