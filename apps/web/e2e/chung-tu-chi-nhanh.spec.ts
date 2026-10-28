import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như phieu-thu.spec.ts (tài khoản e2e quản trị công ty E2E, năm tài chính 2026 sẽ được tạo nếu chưa có).
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}
const addBranch = async (request: APIRequestContext, code: string) => {
  const r = await request.post('/api/branches', { data: { code, name: `Chi nhánh ${code}` } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).id as number;
};
const pickBranch = async (page: Page, label: string, text: string | RegExp) => {
  await page.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: label, exact: true }) }).click();
  await page.locator('.ant-select-item-option', { hasText: text }).click();
};
// Phiếu kế toán: Nợ 6422 / Có 1111 bằng bàn phím như phieu-ke-toan.spec.ts
async function fillVoucher(page: Page, date: string, desc: string, amount: string) {
  await page.getByLabel('Ngày hạch toán').fill(date); await page.keyboard.press('Enter');
  await page.getByLabel('Diễn giải').fill(desc);
  await page.locator('.ag-center-cols-container .ag-row[row-index="0"] [col-id="accountCode"]').click();
  await page.keyboard.type('6422'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await page.keyboard.type(amount); await page.keyboard.press('Enter');
  for (let i = 0; i < 7; i++) await page.keyboard.press('Enter');
  await page.keyboard.type('1111'); for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
  await page.keyboard.type(amount); await page.keyboard.press('Enter');
}

test('Chi nhánh trên chứng từ: chọn chi nhánh khi lập phiếu, cột Chi nhánh và bộ lọc trên danh sách, đổi chi nhánh của phiếu nháp', async ({ page, request }) => {
  await signIn(page, request);
  const tag = String(Date.now()).slice(-6);
  const code = `CT${tag}`; const marker = `PW-CN-${tag}`;
  const branchId = await addBranch(request, code);
  expect((await request.put('/api/me/branch', { data: { branch: 'HO' } })).ok()).toBeTruthy();
  expect((await request.put('/api/prefs/filter%3Avouchers%3APKT', { data: { value: { from: '2026-01-01', to: '2026-12-31', state: '', q: marker, branch: '' } } })).ok()).toBeTruthy();

  // Lập phiếu mới: ô Chi nhánh mặc định là chi nhánh làm việc (trụ sở chính); chọn chi nhánh mới rồi lưu, ghi sổ.
  await page.goto('/chung-tu/PKT');
  await expect(page.getByRole('heading', { name: 'Phiếu kế toán' })).toBeVisible();
  await page.keyboard.press('Insert');
  await expect(page.getByText('Phiếu kế toán (mới)')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Chi nhánh của chứng từ' })).toBeVisible();
  await pickBranch(page, 'Chi nhánh của chứng từ', new RegExp(code));
  await fillVoucher(page, '17/01/2026', marker, '4321');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu')).toBeVisible();
  await expect(page).toHaveURL(/PKT\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').at(-1)!;
  expect((await (await request.get(`/api/vouchers/${id}/branch`)).json()).branch).toBe(branchId); // gắn đúng chi nhánh đã chọn
  await expect(page.locator('.ag-center-cols-container [col-id="accountCode"]', { hasText: '6422' })).toBeVisible();

  // Phiếu nháp: đổi chi nhánh về trụ sở chính rồi lưu; đổi lại sang chi nhánh mới rồi ghi sổ luôn (F9 lưu trước, gắn chi nhánh, rồi ghi sổ).
  await pickBranch(page, 'Chi nhánh của chứng từ', 'Trụ sở chính');
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await (await request.get(`/api/vouchers/${id}/branch`)).json()).branch).toBe('HO');
  await expect(page.locator('.ant-message').getByText('Đã lưu').last()).toBeVisible();
  await pickBranch(page, 'Chi nhánh của chứng từ', new RegExp(code));
  await page.keyboard.press('F9');
  await expect(page.locator('.ant-message').getByText('Đã ghi sổ')).toBeVisible();
  await expect(page.getByTestId('voucher-branch')).toContainText(code); // đã ghi sổ: chỉ xem chi nhánh

  // Danh sách: cột Chi nhánh và bộ lọc.
  await page.goto('/chung-tu/PKT');
  const row = page.locator('.ag-center-cols-container .ag-row', { hasText: marker });
  await expect(row.locator('[col-id="branchCode"]')).toHaveText(code);
  await pickBranch(page, 'Chi nhánh', 'Trụ sở chính');
  await expect(page.locator('.ag-center-cols-container .ag-row', { hasText: marker })).toHaveCount(0);
  await pickBranch(page, 'Chi nhánh', new RegExp(code));
  await expect(page.locator('.ag-center-cols-container .ag-row', { hasText: marker })).toHaveCount(1);
});

test('Đánh số theo chi nhánh: bật ở Kỳ kế toán, mỗi chi nhánh một dãy số có mã chi nhánh; tắt lại', async ({ page, request }) => {
  await signIn(page, request);
  const tag = String(Date.now()).slice(-6);
  const a = `NA${tag}`; const b = `NB${tag}`;
  const brA = await addBranch(request, a); const brB = await addBranch(request, b);
  const post = async (branch: number | 'HO') => {
    const v = await request.post('/api/vouchers', { data: { voucherType: 'PKT', postingDate: '2026-01-18', documentDate: '2026-01-18', description: `PW-SO-${tag}`, autoPost: false,
      lines: [{ accountCode: '6422', debit: '1000' }, { accountCode: '1111', credit: '1000' }] } });
    const vid = (await v.json()).id as string;
    expect((await request.put(`/api/vouchers/${vid}/branch`, { data: { branch } })).ok()).toBeTruthy();
    const p = await request.post(`/api/vouchers/${vid}/post`, { data: {} });
    expect(p.ok(), await p.text()).toBeTruthy();
    return (await p.json()).voucherNo as string;
  };
  try {
    await page.goto('/so-cai/ky-ke-toan');
    await page.getByRole('tab', { name: 'Loại chứng từ và đánh số' }).click();
    const sw = page.getByRole('switch', { name: 'Đánh số theo chi nhánh' });
    await expect(sw).toBeVisible();
    await sw.click();
    await page.getByLabel('Mã trụ sở chính').fill(`TS${tag}`);
    await page.getByRole('button', { name: 'Lưu cách đánh số' }).click();
    await expect(page.locator('.ant-message').getByText('Đã lưu cách đánh số theo chi nhánh')).toBeVisible();

    const n1 = await post(brA); const n2 = await post(brA); const n3 = await post(brB); const n4 = await post('HO');
    expect(n1).toMatch(new RegExp(`^${a}-PKT`)); expect(n3).toMatch(new RegExp(`^${b}-PKT`)); expect(n4).toMatch(new RegExp(`^TS${tag}-PKT`));
    const seq = (n: string) => Number(n.match(/(\d+)$/)![1]);
    expect(seq(n2)).toBe(seq(n1) + 1); // dãy riêng của chi nhánh A
    expect(seq(n1)).toBe(1); expect(seq(n3)).toBe(1); // chi nhánh mới bắt đầu từ 1 (trụ sở chính nối tiếp bộ đếm cũ của công ty)
    expect(brA).not.toBe(brB);
  } finally {
    expect((await request.put('/api/voucher-numbering/settings', { data: { perBranch: false, hqCode: 'TSC' } })).ok()).toBeTruthy();
  }
});
