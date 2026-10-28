import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: như in-so.spec.ts (tài khoản e2e quản trị công ty E2E).
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('In cả bộ sổ năm theo hình thức sổ: hộp thoại nêu hình thức của năm, nhãn Nhật ký và Sổ Cái đổi theo, tải về được Excel', async ({ page, request }) => {
  await signIn(page, request);
  const years = await (await request.get('/api/fiscal-years')).json() as { fiscalYear: number }[];
  const year = years.at(-1)!.fiscalYear;
  try {
    for (const [form, journal, note] of [['CTGS', 'Sổ đăng ký Chứng từ ghi sổ và từng Chứng từ ghi sổ', 'hình thức Chứng từ ghi sổ'], ['NKSC', 'Sổ Nhật ký – Sổ Cái', 'hình thức Nhật ký – Sổ Cái'], ['NKCT', 'Nhật ký – Chứng từ', 'hình thức Nhật ký – Chứng từ']] as const) {
      expect((await request.put(`/api/fiscal-years/${year}/book-form`, { data: { bookForm: form } })).ok()).toBeTruthy();
      await page.goto('/bao-cao/so-sach');
      await page.getByRole('button', { name: /In cả bộ sổ năm/ }).click();
      const dialog = page.getByRole('dialog', { name: 'In cả bộ sổ năm' });
      await expect(dialog.getByTestId('book-form-note')).toContainText(note);
      await expect(dialog.getByRole('checkbox', { name: new RegExp(journal) })).toBeVisible();
      if (form === 'NKSC') { // Nhật ký – Sổ Cái thay cả Sổ Cái: tải được bộ sổ
        await dialog.getByText('Excel', { exact: true }).click();
        const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'In', exact: true }).click()]);
        expect(download.suggestedFilename()).toMatch(/^bo-so-\d{4}\.xlsx$/);
      } else await dialog.getByRole('button', { name: 'Đóng' }).click();
    }
    expect((await request.put(`/api/fiscal-years/${year}/book-form`, { data: { bookForm: 'NKC' } })).ok()).toBeTruthy();
    await page.goto('/bao-cao/so-sach');
    await page.getByRole('button', { name: /In cả bộ sổ năm/ }).click();
    const dialog = page.getByRole('dialog', { name: 'In cả bộ sổ năm' });
    await expect(dialog.getByRole('checkbox', { name: 'Sổ Nhật ký chung' })).toBeVisible();
    await expect(dialog.getByTestId('book-form-note')).toHaveCount(0);
  } finally {
    await request.put(`/api/fiscal-years/${year}/book-form`, { data: { bookForm: 'NKC' } });
  }
});
