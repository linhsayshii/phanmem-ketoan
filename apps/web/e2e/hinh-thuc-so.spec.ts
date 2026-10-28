import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

// Đăng nhập bằng API (có năm tài chính, chứng từ mới chưa vào Chứng từ ghi sổ) rồi bằng giao diện.
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  let years = await (await request.get('/api/fiscal-years')).json() as { fiscalYear: number; dateFrom: string }[];
  if (!years.length) { expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy(); years = await (await request.get('/api/fiscal-years')).json(); }
  const y = years.at(-1)!;
  const date = `${y.dateFrom.slice(0, 7)}-15`;
  const v = await request.post('/api/vouchers', { data: { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'Thu tiền hình thức sổ', autoPost: true, lines: [{ accountCode: '1111', debit: '1000' }, { accountCode: '5113', credit: '1000' }] } });
  expect(v.ok(), await v.text()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
  return y.fiscalYear;
}

test('chọn hình thức sổ, xem Nhật ký – Sổ Cái, lập Chứng từ ghi sổ và xem sổ đăng ký', async ({ page, request }) => {
  const year = await signIn(page, request);
  expect((await request.put(`/api/fiscal-years/${year}/book-form`, { data: { bookForm: 'NKSC' } })).ok()).toBeTruthy();
  await page.goto('/bao-cao/hinh-thuc-so');
  await expect(page.getByRole('heading', { name: 'Hình thức sổ kế toán' })).toBeVisible();
  await expect(page.getByText('Cộng phát sinh theo tài khoản')).toBeVisible();
  await expect(page.getByRole('button', { name: 'In PDF' })).toBeVisible();

  await page.getByText('Chứng từ ghi sổ', { exact: true }).first().click(); // đổi hình thức sang CTGS
  await expect(page.getByText('Đã đổi hình thức sổ')).toBeVisible();
  await page.getByRole('button', { name: 'Lập Chứng từ ghi sổ' }).click();
  const dialog = page.getByRole('dialog', { name: 'Lập Chứng từ ghi sổ' });
  const note = `CTGS e2e ${Date.now()}`;
  await dialog.getByLabel('Diễn giải').fill(note);
  await dialog.getByRole('button', { name: 'Lập', exact: true }).click();
  await expect(page.getByText(/Đã lập Chứng từ ghi sổ số \d+/)).toBeVisible();
  await expect(page.getByRole('cell', { name: note })).toBeVisible();

  await page.getByRole('tab', { name: 'Sổ đăng ký Chứng từ ghi sổ' }).click();
  await expect(page.getByText('Tổng số tiền')).toBeVisible();
  await page.getByRole('tab', { name: 'Sổ Cái' }).click();
  await expect(page.getByText('Chọn tài khoản để xem Sổ Cái')).toBeVisible();

  await page.getByText('Nhật ký – Chứng từ', { exact: true }).click();
  await expect(page.getByText('Chọn tài khoản ghi Có để xem bảng kê')).toBeVisible();
  expect((await request.put(`/api/fiscal-years/${year}/book-form`, { data: { bookForm: 'NKC' } })).ok()).toBeTruthy();
});
