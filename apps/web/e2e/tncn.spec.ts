import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"
// Tham số lương là dữ liệu minh họa (nguồn ghi rõ), không phải văn bản pháp lý. Spec xóa mọi tham số lương và tờ khai TNCN nháp của công ty E2E trước khi chạy.
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}
const ok = async (p: Promise<APIResponse>) => { const r = await p; expect(r.ok(), await r.text()).toBeTruthy(); return r; };

const SRC = 'Dữ liệu minh họa của kiểm thử e2e, không phải văn bản pháp lý';
const now = new Date(); const year = now.getFullYear(), month = now.getMonth() + 1, quarter = Math.ceil(month / 3);
const sfx = String(Date.now()).slice(-8);
const names = [`Nguyễn Văn T ${sfx}`, `Đỗ Thị N ${sfx}`];

test.beforeAll(async ({ playwright }, testInfo) => {
  const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL! });
  await ok(request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } }));
  if (!((await (await request.get('/api/fiscal-years')).json()) as unknown[]).length)
    await ok(request.post('/api/fiscal-years', { data: { fiscalYear: year, dateFrom: `${year}-01-01`, months: 12, regime: 'TT133' } }));
  for (const p of (await (await request.get('/api/payroll/params')).json()) as { id: number }[]) await ok(request.delete(`/api/payroll/params/${p.id}`));
  const put = (code: string, value: unknown) => ok(request.put('/api/payroll/params', { data: { code, validFrom: '2000-01-01', validTo: null, value, source: SRC } }));
  await put('pit_deduction', { self: '4000000', dependent: '1600000' });
  await put('si_rates', { employee: { si: 8, hi: 1.5, ui: 1 }, employer: { si: 17.5, hi: 3, ui: 1, occupational: 0.5 } });
  await put('si_ceiling', { si_base_max: '36000000' });
  await put('pit_brackets', [{ upTo: '5000000', rate: 5 }, { upTo: null, rate: 10 }]);
  await put('pit_brackets_annual', [{ upTo: '60000000', rate: 5 }, { upTo: null, rate: 10 }]);
  await ok(request.put('/api/settings', { data: { payroll_standard_hours_per_day: '8', payroll_standard_days_per_month: '26', payroll_expense_account: '6421' } }));
  for (const r of (await (await request.get(`/api/tncn/returns?year=${year}`)).json()) as { id: number; status: string }[]) if (r.status === 'draft') await ok(request.delete(`/api/tncn/returns/${r.id}`));
  const ids: number[] = [];
  for (const [i, name] of names.entries()) {
    const id = Number((await (await ok(request.post('/api/catalogs/employee', { data: { code: `TN${sfx}${i}`, name, tax_code: `81${sfx}${i}` } }))).json()).id);
    await ok(request.put(`/api/payroll/profiles/${id}`, { data: { taxResidency: 'resident', contractType: 'long', startDate: '2020-01-01', region: 'I', pitAuthorized: i === 0,
      siParticipates: true, hiParticipates: true, uiParticipates: true, occupationalParticipates: false } }));
    await ok(request.post(`/api/payroll/profiles/${id}/salary-history`, { data: { validFrom: '2020-01-01', monthlySalary: '15000000' } }));
    ids.push(id);
  }
  const cells = ids.flatMap((employeeId) => Array.from({ length: 26 }, (_, i) => ({ employeeId, date: `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`, entries: [{ kind: 'work_day', qty: '1' }] })));
  await ok(request.put(`/api/attendance?year=${year}&month=${month}`, { data: { cells } }));
  const run = (await (await ok(request.post('/api/payroll/runs', { data: { year, month, employeeIds: ids, name: `Lương TNCN ${sfx}` } }))).json()) as { id: number };
  await ok(request.post(`/api/payroll/runs/${run.id}/calculate`));
  await ok(request.post(`/api/payroll/runs/${run.id}/post`));
  await request.dispose();
});

test.use({ viewport: { width: 1600, height: 1400 } }); // công ty E2E có nhiều nhân viên của spec khác: lưới đủ cao để không ảo hóa dòng của spec này

test('thuế TNCN: bảng kê quý, lập và chốt 05/KK-TNCN, quyết toán năm loại người không ủy quyền', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/luong/thue-tncn');
  await page.getByRole('combobox', { name: 'Loại kỳ' }).click({ force: true }); await page.locator('.ant-select-item-option', { hasText: 'Khấu trừ theo quý' }).click(); await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Quý' }).click({ force: true }); await page.locator('.ant-select-item-option', { hasText: `Quý ${quarter}` }).last().click();
  await expect(page.getByText('Chưa xuất được tờ khai theo mẫu TT 89/2026: xuất bảng kê Excel')).toBeVisible();
  await expect(page.getByText(names[0]!)).toBeVisible(); await expect(page.getByText(names[1]!)).toBeVisible();

  await page.getByRole('button', { name: 'Lập tờ khai 05/KK-TNCN' }).click();
  const row = page.getByTestId('tncn-returns').locator('tr', { hasText: `Quý ${quarter}/${year}` }).filter({ hasText: 'Nháp' });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Chốt' }).click();
  await page.locator('.ant-popconfirm').getByRole('button', { name: 'Chốt' }).click();
  await expect(page.getByText('Đã chốt tờ khai')).toBeVisible();
  await expect(page.getByTestId('tncn-returns').locator('tr', { hasText: `Quý ${quarter}/${year}` }).filter({ hasText: 'Nháp' })).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Loại kỳ' }).click({ force: true }); await page.locator('.ant-select-item-option', { hasText: 'Quyết toán năm' }).click();
  await expect(page.getByText('Không ủy quyền quyết toán (có thu nhập nơi khác): cá nhân tự quyết toán').first()).toBeVisible();
  await expect(page.getByTestId('tncn-summary')).toContainText('người quyết toán thay');
});
